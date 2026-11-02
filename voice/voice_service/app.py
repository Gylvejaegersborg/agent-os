"""The voice service: one process, models loaded once, OpenAI-compatible routes on 127.0.0.1 only.

Routes:
  GET  /health                     loaded models, mode, mic, routing counts, RAM, last latencies
  POST /v1/audio/transcriptions    file upload → text; language "no"/"en", or auto (language ID picks the engine)
  POST /v1/audio/speech            text → wav/pcm (Kokoro) — only when tts.enabled; off by default
  WS   /v1/listen                  live mic events: speech_start, speech_end, final, mode
  POST /v1/control                 {"mute": true|false, "mode": "auto"|"no"|"en"|"next", "ptt": true|false}

Every route but GET /health needs `Authorization: Bearer <the gateway token>` (auth.py).
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .config import load_config, model_path
from .engines import KokoroTts, to_pcm16, to_wav
from .auth import has_token, load_token
from .hotkey import Hotkey
from .lazy import Lazy, start_idle_watch
from .router import MODES
from .stt import SpeechToText


class State:
    cfg: dict[str, Any]
    stt: Optional[SpeechToText] = None
    hotkey: Optional[Hotkey] = None
    hotkey_error: Optional[str] = None
    ptt_key: Optional[Hotkey] = None
    ptt_error: Optional[str] = None
    token: Optional[str] = None
    tts: Optional[Lazy[KokoroTts]] = None
    idle_watch: Any = None
    mic: Any = None
    mic_error: Optional[str] = None
    started: float = 0.0


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


def load(cfg: dict[str, Any]) -> None:
    r = cfg["resources"]
    set_priority(r["priority"])
    state.cfg = cfg
    state.started = time.time()
    if cfg["auth"]["enabled"]:
        state.token, source = load_token(model_path(cfg["auth"]["token_file"]))
        print(f"[voice] auth on: requests need the token from {source}")
    else:
        print("[voice] auth OFF (auth.enabled: false): any program on this machine, any web page included, can read your dictation")
    state.stt = SpeechToText(cfg)
    t = cfg["tts"]
    if t["enabled"]:
        t0 = time.perf_counter()
        en = t["en"]
        state.tts = Lazy(
            KokoroTts.name,
            lambda: KokoroTts(model_path(en["model"]), model_path(en["voices"]), en["voice"], sample_rate=t["sample_rate"]),
            60 * (r.get("idle_unload_min") or 0),
        )
        state.tts.load()
        print(f"[voice] Kokoro loaded in {time.perf_counter() - t0:.1f}s")
    else:
        print("[voice] speech back is off (tts.enabled: false) — no TTS model loaded")
    lazy = state.stt.lazy_models + ([state.tts] if state.tts else [])
    if r.get("idle_unload_min"):
        state.idle_watch = start_idle_watch(lazy)
        print(f"[voice] {', '.join(m.name for m in lazy)} unload after {r['idle_unload_min']} min idle; speech reloads them")
    if cfg["mic"]["enabled"]:
        try:
            from .mic import MicListener
            from .vad import SileroVad

            vad = SileroVad(model_path(cfg["vad"]["model"]), sample_rate=cfg["audio"]["sample_rate"])
            state.mic = MicListener(cfg, vad, state.stt)
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
    return {
        "ok": state.stt is not None,
        "uptime_s": round(time.time() - state.started),
        "models": {
            "stt.no": state.stt.no.name if state.stt else None,
            "stt.en": state.stt.en.name if state.stt and state.stt.en else None,
            "lang_id": state.stt.langid.name if state.stt and state.stt.langid else None,
            "tts.en": state.tts.name if state.tts else None,
            "vad": "silero-v5" if state.mic else None,
        },
        # Lazy models: loaded now, or dropped after resources.idle_unload_min idle (reloaded on speech).
        "loaded": {m.name: m.loaded for m in (state.stt.lazy_models if state.stt else []) + ([state.tts] if state.tts else [])},
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
        "speech_back": bool(state.tts),
        "mic": {
            "listening": state.mic is not None and not state.mic.muted,
            "device": state.mic.device_name if state.mic else None,
            "error": state.mic_error,
            "dropped_frames": state.mic.dropped_frames if state.mic else 0,
            "speculation": state.mic.stats if state.mic else None,
            "routes": state.mic.routes if state.mic else None,
        },
        "ram_mb": rss,
        "last_ms": {
            "stt.no": state.stt.no.last_ms if state.stt else None,
            "stt.en": state.stt.en.last_ms if state.stt and state.stt.en else None,
            "lang_id": state.stt.langid.last_ms if state.stt and state.stt.langid else None,
            "tts": state.tts.last_ms if state.tts else None,
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


class SpeechRequest(BaseModel):
    input: str
    model: str = "auto"
    voice: Optional[str] = None
    response_format: str = "wav"
    speed: float = 1.0
    language: Optional[str] = None


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest) -> Response:
    if state.tts is None:
        raise HTTPException(409, "speech back is off — set tts.enabled: true in voice/voice.yaml and restart")
    if not req.input.strip():
        raise HTTPException(400, "input is empty")
    if req.language not in (None, "", "en"):
        raise HTTPException(400, "phase 1 speaks English only (Norwegian via Piper comes in phase 3)")
    if req.response_format not in ("wav", "pcm"):
        raise HTTPException(400, "response_format must be wav or pcm")
    audio = await asyncio.to_thread(state.tts.run, lambda k: k.synthesize(req.input, req.voice, req.speed))
    rate = state.cfg["tts"]["sample_rate"]
    if req.response_format == "pcm":
        return Response(to_pcm16(audio), media_type="audio/pcm", headers={"x-sample-rate": str(rate)})
    return Response(to_wav(audio, rate), media_type="audio/wav")


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
    if state.mic is None:
        await ws.send_json({"type": "error", "error": f"the mic isn't running ({state.mic_error or 'mic.enabled is false'})"})
        await ws.close()
        return
    loop = asyncio.get_running_loop()
    events: asyncio.Queue = asyncio.Queue(maxsize=100)

    def push(event: dict[str, Any]) -> None:
        loop.call_soon_threadsafe(lambda: events.full() or events.put_nowait(event))

    unsubscribe = state.mic.subscribe(push)
    try:
        while True:
            await ws.send_json(await events.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        unsubscribe()
