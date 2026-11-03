"""The voice service: one process, models loaded once, OpenAI-compatible routes on 127.0.0.1 only.

Routes:
  GET  /health                     loaded models, mode, mic, routing counts, RAM, last latencies
  POST /v1/audio/transcriptions    file upload → text; language "no"/"en", or auto (language ID picks the engine)
  POST /v1/audio/speech            text → wav/pcm, a voice per sentence (Phonon 31M en, Piper no) — tts.enabled only
  POST /v1/speak                   text → spoken on this machine's speakers, sentence by sentence — tts.enabled only
  POST /v1/speak/stop              stop speaking now and drop the rest
  WS   /v1/speak                   stream text in ({"type": "text", "text": …}, then "end" or "cancel"), spoken as
                                   each sentence completes; sentence/speak events come back
  WS   /v1/listen                  live events: ptt_start/ptt_end, speech_start/speech_end, final, mode,
                                   speak_start/sentence/speak_end, barge_in
  POST /v1/control                 {"mute": true|false, "mode": "auto"|"no"|"en"|"next", "ptt": true|false}
  POST /v1/claim                   {"id": <a final's id>} → {"claimed": true} for the first caller only

Every route but GET /health needs `Authorization: Bearer <the gateway token>` (auth.py).
Barge-in: pressing push-to-talk while it speaks stops the sound and drops the rest (tts.barge_in_open_mic also
lets plain speech do it with the open mic; off, because the mic hears the speakers).
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Callable, Optional

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .auth import has_token, load_token
from .config import load_config, model_path
from .engines import KokoroTts, PhononTts, PiperTts, to_pcm16, to_wav
from .hotkey import Hotkey
from .lazy import Lazy, start_idle_watch
from .router import MODES
from .speech import SentenceLanguage, SentenceSplitter, Speaker, fasttext_detector, split_sentences
from .stt import SpeechToText

SENTENCE_PAUSE_S = 0.12  # between sentences in a /v1/audio/speech file


class Bus:
    """Every event the service has (mic and speech) to every /v1/listen subscriber."""

    def __init__(self) -> None:
        self._listeners: list[Callable[[dict[str, Any]], None]] = []

    def subscribe(self, fn: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception as err:
                print(f"[voice] listener failed: {err}")


class State:
    cfg: dict[str, Any]
    stt: Optional[SpeechToText] = None
    hotkey: Optional[Hotkey] = None
    hotkey_error: Optional[str] = None
    ptt_key: Optional[Hotkey] = None
    ptt_error: Optional[str] = None
    token: Optional[str] = None
    tts: dict[str, Lazy] = {}  # "en" → Kokoro, "no" → Piper
    tts_errors: dict[str, str] = {}
    speaker: Optional[Speaker] = None
    idle_watch: Any = None
    mic: Any = None
    mic_error: Optional[str] = None
    started: float = 0.0
    bus: Bus = Bus()


state = State()


def set_priority(level: str) -> None:
    if level != "below_normal":
        return
    try:
        import psutil

        p = psutil.Process(os.getpid())
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS") else 10)
    except Exception as err:
        print(f"[voice] could not lower priority: {err}")


def load_speech_back(cfg: dict[str, Any], idle_s: float) -> None:
    t = cfg["tts"]
    rate = t["sample_rate"]
    en = t["en"]
    if en["engine"] == "kokoro":
        english = (KokoroTts.name, lambda: KokoroTts(model_path(en["kokoro_model"]), model_path(en["kokoro_voices"]), en.get("voice") or "af_heart", sample_rate=rate), False)
    elif en["engine"] == "phonon-31m":
        english = (PhononTts.name, lambda: PhononTts(en.get("voice"), quant=en.get("quant", "q8"), threads=cfg["resources"]["threads"], sample_rate=rate), True)
    else:
        raise ValueError(f"tts.en.engine is {en['engine']!r}: phonon-31m or kokoro")
    factories = {"en": english, "no": (PiperTts.name, lambda: PiperTts(model_path(t["no"]["model"]), sample_rate=rate), False)}
    state.tts, state.tts_errors = {}, {}
    for lang, (name, make, streams) in factories.items():
        t0 = time.perf_counter()
        lazy = Lazy(name, make, idle_s, streams=streams)
        try:
            lazy.load()
            state.tts[lang] = lazy
            print(f"[voice] {name} ({lang}) loaded in {time.perf_counter() - t0:.1f}s")
        except Exception as err:  # the other voice still speaks
            state.tts_errors[lang] = str(err)
            print(f"[voice] no {lang} voice: {err}")
    if not state.tts:
        return
    try:
        detect = fasttext_detector(model_path(t["lang_model"]))
    except Exception as err:
        detect = None
        print(f"[voice] no text language ID ({err}): every sentence keeps the request's or the last language")
    try:
        # The first-clause start only helps an engine that can't stream (Kokoro); Phonon starts in ~75 ms anyway.
        quick = not english[2]
        state.speaker = Speaker(
            state.tts, SentenceLanguage(detect), sample_rate=rate, device=t.get("output_device"), emit=state.bus.emit, play=t.get("playback", True), quick_start=quick
        )
    except Exception as err:  # no output device: files from /v1/audio/speech still work
        state.speaker = Speaker(state.tts, SentenceLanguage(detect), sample_rate=rate, emit=state.bus.emit, play=False, quick_start=not english[2])
        state.tts_errors["playback"] = str(err)
        print(f"[voice] no speakers ({err}); /v1/audio/speech still works")


def barge_in(event: dict[str, Any]) -> None:
    """Pressing push-to-talk (or, with tts.barge_in_open_mic, speech on the open mic) while speaking stops it."""
    sp = state.speaker
    if sp is None or not sp.speaking:
        return
    kind = event.get("type")
    if kind == "ptt_start" or (kind == "speech_start" and state.cfg["tts"].get("barge_in_open_mic")):
        sp.stop("barge_in")
        state.bus.emit({"type": "barge_in", "t": time.time()})


def load(cfg: dict[str, Any]) -> None:
    r = cfg["resources"]
    idle_s = 60 * (r.get("idle_unload_min") or 0)
    set_priority(r["priority"])
    state.cfg = cfg
    state.started = time.time()
    if cfg["auth"]["enabled"]:
        state.token, source = load_token(model_path(cfg["auth"]["token_file"]))
        print(f"[voice] auth on: requests need the token from {source}")
    else:
        print("[voice] auth OFF (auth.enabled: false): any program on this machine, any web page included, can read your dictation")
    state.stt = SpeechToText(cfg)
    if cfg["tts"]["enabled"]:
        load_speech_back(cfg, idle_s)
    else:
        print("[voice] speech back is off (tts.enabled: false) — no TTS model loaded")
    lazy = state.stt.lazy_models + list(state.tts.values())
    if idle_s:
        state.idle_watch = start_idle_watch(lazy)
        print(f"[voice] {', '.join(m.name for m in lazy)} unload after {r['idle_unload_min']} min idle; speech reloads them")
    if cfg["mic"]["enabled"]:
        try:
            from .mic import MicListener
            from .vad import SileroVad

            vad = SileroVad(model_path(cfg["vad"]["model"]), sample_rate=cfg["audio"]["sample_rate"])
            state.mic = MicListener(cfg, vad, state.stt)
            state.mic.subscribe(barge_in)  # first, so the sound stops before anyone else hears of the press
            state.mic.subscribe(state.bus.emit)
            state.mic.start()
            print(f"[voice] listening on: {state.mic.device_name}")
        except Exception as err:  # the HTTP routes still work without a mic
            state.mic = None
            state.mic_error = str(err)
            print(f"[voice] mic not started: {err}")
    if cfg.get("hotkey"):
        try:
            state.hotkey = Hotkey(cfg["hotkey"], lambda: set_mode("next"))
            if state.hotkey.start():
                print(f"[voice] {cfg['hotkey']} cycles the mode (auto → no → en); now {state.stt.router.mode}")
            else:
                state.hotkey_error, state.hotkey = state.hotkey.error, None
        except ValueError as err:
            state.hotkey_error = str(err)
        if state.hotkey_error:
            print(f"[voice] no mode hotkey: {state.hotkey_error}")
    m = cfg["mic"]
    if state.mic is not None and state.mic.trigger == "push_to_talk":
        try:
            state.ptt_key = Hotkey(m["ptt_key"], lambda: state.mic.ptt(True), lambda: state.mic.ptt(False))
            if state.ptt_key.start():
                print(f"[voice] push-to-talk: hold {m['ptt_key']} and speak")
            else:
                state.ptt_error, state.ptt_key = state.ptt_key.error, None
        except ValueError as err:
            state.ptt_error = str(err)
        if state.ptt_error:
            print(f"[voice] no push-to-talk key ({state.ptt_error}); POST /v1/control {{\"ptt\": true|false}} still works")


def set_mode(mode: str) -> str:
    if state.mic is not None:
        return state.mic.set_mode(mode)  # also tells /v1/listen subscribers
    m = state.stt.router.next_mode() if mode == "next" else state.stt.router.set_mode(mode)
    print(f"[voice] mode: {m}")
    return m


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not getattr(state, "cfg", None):
        load(load_config())
    yield
    if state.idle_watch is not None:
        state.idle_watch.set()
    for key in (state.hotkey, state.ptt_key):
        if key is not None:
            key.stop()
    if state.mic is not None:
        state.mic.stop()
    if state.speaker is not None:
        state.speaker.close()


app = FastAPI(title="agent-os voice", lifespan=lifespan)


@app.middleware("http")
async def require_token(request: Request, call_next):
    if state.token and request.url.path != "/health" and not has_token(request.headers.get("authorization"), state.token):
        return JSONResponse({"error": "missing or wrong token (Authorization: Bearer <agent-os/data/gateway-token>)"}, status_code=401)
    return await call_next(request)


@app.get("/health")
def health() -> dict[str, Any]:
    rss = None
    try:
        import psutil

        rss = round(psutil.Process(os.getpid()).memory_info().rss / 2**20)
    except Exception:
        pass
    lazy = (state.stt.lazy_models if state.stt else []) + list(state.tts.values())
    return {
        "ok": state.stt is not None,
        "uptime_s": round(time.time() - state.started),
        "models": {
            "stt.no": state.stt.no.name if state.stt else None,
            "stt.en": state.stt.en.name if state.stt and state.stt.en else None,
            "lang_id": state.stt.langid.name if state.stt and state.stt.langid else None,
            "tts.en": state.tts["en"].name if "en" in state.tts else None,
            "tts.no": state.tts["no"].name if "no" in state.tts else None,
            "vad": "silero-v5" if state.mic else None,
        },
        # Lazy models: loaded now, or dropped after resources.idle_unload_min idle (reloaded on speech).
        "loaded": {m.name: m.loaded for m in lazy},
        "english_routing": {"on": bool(state.stt and state.stt.en), "error": state.stt.en_error if state.stt else None},
        "mode": state.stt.router.mode if state.stt else None,
        "hotkey": {"combo": state.hotkey.combo if state.hotkey else None, "error": state.hotkey_error},
        "push_to_talk": {
            "on": bool(state.mic and state.mic.trigger == "push_to_talk"),
            "key": state.ptt_key.combo if state.ptt_key else None,
            "error": state.ptt_error,
            "held": bool(state.mic and state.mic.held),
        },
        "auth": bool(state.token),
        "speech_back": {
            "on": bool(state.tts),
            "voices": {lang: lz.name for lang, lz in state.tts.items()},
            "speaking": bool(state.speaker and state.speaker.speaking),
            "errors": state.tts_errors,
        },
        "mic": {
            "listening": state.mic is not None and not state.mic.muted,
            "device": state.mic.device_name if state.mic else None,
            "error": state.mic_error,
            "dropped_frames": state.mic.dropped_frames if state.mic else 0,
            "speculation": state.mic.stats if state.mic else None,
            "routes": state.mic.routes if state.mic else None,
            "partials": state.mic.partial_stats if state.mic else None,
        },
        "ram_mb": rss,
        "last_ms": {
            "stt.no": state.stt.no.last_ms if state.stt else None,
            "stt.en": state.stt.en.last_ms if state.stt and state.stt.en else None,
            "lang_id": state.stt.langid.last_ms if state.stt and state.stt.langid else None,
            **{f"tts.{lang}": lz.last_ms for lang, lz in state.tts.items()},
        },
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model: str = Form("auto"), language: Optional[str] = Form(None)) -> dict[str, Any]:
    if state.stt is None:
        raise HTTPException(503, "speech-to-text is not loaded")
    if language not in (None, "", "auto", "no", "nb", "nn", "en"):
        raise HTTPException(400, "language must be no, en or auto (Norwegian or English)")
    import io

    from faster_whisper.audio import decode_audio

    audio = await asyncio.to_thread(decode_audio, io.BytesIO(await file.read()), 16000)
    try:
        t, r = await asyncio.to_thread(state.stt.transcribe_file, audio, language or None if language != "auto" else None)
    except LookupError as err:
        raise HTTPException(409, str(err))
    return {
        "text": t.text,
        "language": t.language,
        "engine": t.engine,
        "route": r.reason,
        "detected": {"language": r.language, "prob": round(r.prob, 3)} if r.language else None,
        "confidence": t.confidence,
        "duration": t.duration_s,
        "took_ms": t.took_ms,
    }


def _need_speech_back() -> Speaker:
    if state.speaker is None:
        raise HTTPException(409, "speech back is off — set tts.enabled: true in voice/voice.yaml (python fetch_models.py --tts) and restart")
    return state.speaker


def _language(value: Optional[str]) -> Optional[str]:
    if value in (None, "", "auto"):
        return None
    if value in ("no", "nb", "nn"):
        return "no"
    if value == "en":
        return "en"
    raise HTTPException(400, "language must be no, en or auto")


class SpeechRequest(BaseModel):
    input: str
    model: str = "auto"
    voice: Optional[str] = None
    response_format: str = "wav"
    speed: float = 1.0
    language: Optional[str] = None  # no | en | auto (default: per sentence)


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest) -> Response:
    sp = _need_speech_back()
    if not req.input.strip():
        raise HTTPException(400, "input is empty")
    if req.response_format not in ("wav", "pcm"):
        raise HTTPException(400, "response_format must be wav or pcm")
    forced = _language(req.language)
    rate = state.cfg["tts"]["sample_rate"]

    def make() -> np.ndarray:
        decide = SentenceLanguage(sp._language._detect)  # its own memory: a file is judged on its own sentences
        parts: list[np.ndarray] = []
        for s in split_sentences(req.input):
            audio, _engine = sp.synthesize(s, decide(s, forced))
            parts += [audio, np.zeros(int(SENTENCE_PAUSE_S * rate), np.float32)]
        return np.concatenate(parts[:-1]) if parts else np.zeros(0, np.float32)

    audio = await asyncio.to_thread(make)
    if req.response_format == "pcm":
        return Response(to_pcm16(audio), media_type="audio/pcm", headers={"x-sample-rate": str(rate)})
    return Response(to_wav(audio, rate), media_type="audio/wav")


class SpeakRequest(BaseModel):
    input: str
    language: Optional[str] = None  # no | en | auto (default: per sentence)
    interrupt: bool = True  # stop whatever is being said first; false queues after it


@app.post("/v1/speak")
def speak(req: SpeakRequest) -> dict[str, Any]:
    sp = _need_speech_back()
    forced = _language(req.language)
    if req.interrupt:
        sp.stop("replaced")
    sentences = split_sentences(req.input)
    sp.say(sentences, forced)
    return {"sentences": len(sentences)}


@app.post("/v1/speak/stop")
def speak_stop() -> dict[str, Any]:
    sp = _need_speech_back()
    return {"stopped": sp.stop("stop")}


@app.websocket("/v1/speak")
async def speak_stream(ws: WebSocket) -> None:
    """For a reply streamed from a model: speaks each sentence as soon as it's complete."""
    if state.token and not has_token(ws.headers.get("authorization"), state.token):
        await ws.close(code=4401)
        return
    await ws.accept()
    sp = state.speaker
    if sp is None:
        await ws.send_json({"type": "error", "error": "speech back is off (tts.enabled: false)"})
        await ws.close()
        return
    loop = asyncio.get_running_loop()
    out: asyncio.Queue = asyncio.Queue(maxsize=100)
    unsubscribe = state.bus.subscribe(
        lambda e: e.get("type") in ("speak_start", "sentence", "speak_end", "barge_in") and loop.call_soon_threadsafe(lambda: out.full() or out.put_nowait(e))
    )
    splitter = SentenceSplitter()
    forced: Optional[str] = None

    async def pump() -> None:
        while True:
            await ws.send_json(await out.get())

    sender = asyncio.create_task(pump())
    try:
        sp.stop("replaced")
        while True:
            msg = await ws.receive_json()
            kind = msg.get("type")
            if "language" in msg:
                forced = _language(msg.get("language"))
            if kind == "text":
                sp.say(splitter.feed(str(msg.get("text", ""))), forced)
            elif kind == "end":
                sp.say(splitter.flush(), forced)
            elif kind == "cancel":
                splitter = SentenceSplitter()
                sp.stop("cancel")
    except (WebSocketDisconnect, RuntimeError, HTTPException):
        pass
    finally:
        sender.cancel()
        unsubscribe()


class ClaimRequest(BaseModel):
    id: str


_claims: dict[str, float] = {}
_claims_lock = threading.Lock()


@app.post("/v1/claim")
def claim(req: ClaimRequest) -> dict[str, Any]:
    """First caller for a final's id gets it. Several BaseSpace pages hear the same push-to-talk (browser tabs, the
    shell's launcher and dot windows); without this each sent it to the agent (5 copies, live). Kept 2 minutes."""
    now = time.time()
    with _claims_lock:
        for k in [k for k, t in _claims.items() if now - t > 120]:
            del _claims[k]
        if req.id in _claims:
            return {"claimed": False}
        _claims[req.id] = now
    return {"claimed": True}


class ControlRequest(BaseModel):
    mute: Optional[bool] = None
    mode: Optional[str] = None  # auto | no | en | next
    ptt: Optional[bool] = None  # push-to-talk down/up, for a button in place of the key


@app.post("/v1/control")
def control(req: ControlRequest) -> dict[str, Any]:
    if req.mute is not None:
        if state.mic is None:
            raise HTTPException(409, f"the mic isn't running ({state.mic_error or 'mic.enabled is false'})")
        state.mic.muted = req.mute
    if req.mode is not None:
        if req.mode not in (*MODES, "next"):
            raise HTTPException(400, f"mode must be one of {', '.join(MODES)} or next")
        set_mode(req.mode)
    if req.ptt is not None:
        if state.mic is None or state.mic.trigger != "push_to_talk":
            raise HTTPException(409, "push-to-talk is off (mic.trigger is not push_to_talk, or the mic isn't running)")
        state.mic.ptt(req.ptt)
    return {
        "muted": bool(state.mic and state.mic.muted),
        "mode": state.stt.router.mode if state.stt else None,
        "held": bool(state.mic and state.mic.held),
    }


@app.websocket("/v1/listen")
async def listen(ws: WebSocket) -> None:
    if state.token and not has_token(ws.headers.get("authorization"), state.token):
        await ws.close(code=4401)  # before accept: a page that can't send the token learns nothing
        return
    await ws.accept()
    if state.mic is None and state.speaker is None:
        await ws.send_json({"type": "error", "error": f"the mic isn't running ({state.mic_error or 'mic.enabled is false'})"})
        await ws.close()
        return
    loop = asyncio.get_running_loop()
    events: asyncio.Queue = asyncio.Queue(maxsize=100)

    def push(event: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(lambda: events.full() or events.put_nowait(event))

    unsubscribe = state.bus.subscribe(push)
    try:
        while True:
            await ws.send_json(await events.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        unsubscribe()
