"""The voice service: one process, models loaded once, OpenAI-compatible routes on 127.0.0.1 only.

Phase 1 routes:
  GET  /health                     loaded models, mic, RAM, last latencies
  POST /v1/audio/transcriptions    file upload → text (NB-Whisper, Norwegian)
  POST /v1/audio/speech            text → wav/pcm (Kokoro) — only when tts.enabled; off by default
  WS   /v1/listen                  live mic events: speech_start, speech_end, final
  POST /v1/control                 {"mute": true|false}
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from pydantic import BaseModel

from .config import load_config, model_path
from .engines import KokoroTts, NbWhisper, to_pcm16, to_wav


class State:
    cfg: dict[str, Any]
    stt: Optional[NbWhisper] = None
    tts: Optional[KokoroTts] = None
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
    t0 = time.perf_counter()
    state.stt = NbWhisper(model_path(cfg["stt"]["no"]), threads=r["threads"], beam=cfg["stt"]["no_beam"], min_chars=cfg["stt"]["min_chars"])
    print(f"[voice] NB-Whisper loaded in {time.perf_counter() - t0:.1f}s")
    t = cfg["tts"]
    if t["enabled"]:
        t0 = time.perf_counter()
        en = t["en"]
        state.tts = KokoroTts(model_path(en["model"]), model_path(en["voices"]), en["voice"], sample_rate=t["sample_rate"])
        print(f"[voice] Kokoro loaded in {time.perf_counter() - t0:.1f}s")
    else:
        print("[voice] speech back is off (tts.enabled: false) — no TTS model loaded")
    if cfg["mic"]["enabled"]:
        try:
            from .mic import MicListener
            from .vad import SileroVad

            vad = SileroVad(model_path(cfg["vad"]["model"]), threads=r["vad_threads"], sample_rate=cfg["audio"]["sample_rate"])
            state.mic = MicListener(cfg, vad, state.stt)
            state.mic.start()
            print(f"[voice] listening on: {state.mic.device_name}")
        except Exception as err:  # the HTTP routes still work without a mic
            state.mic = None
            state.mic_error = str(err)
            print(f"[voice] mic not started: {err}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not getattr(state, "cfg", None):
        load(load_config())
    yield
    if state.mic is not None:
        state.mic.stop()


app = FastAPI(title="agent-os voice", lifespan=lifespan)


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
            "stt.no": state.stt.name if state.stt else None,
            "tts.en": state.tts.name if state.tts else None,
            "vad": "silero-v5" if state.mic else None,
        },
        "speech_back": bool(state.tts),
        "mic": {
            "listening": state.mic is not None and not state.mic.muted,
            "device": state.mic.device_name if state.mic else None,
            "error": state.mic_error,
            "dropped_frames": state.mic.dropped_frames if state.mic else 0,
        },
        "ram_mb": rss,
        "last_ms": {"stt": state.stt.last_ms if state.stt else None, "tts": state.tts.last_ms if state.tts else None},
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile = File(...), model: str = Form("auto"), language: Optional[str] = Form(None)) -> dict[str, Any]:
    if state.stt is None:
        raise HTTPException(503, "speech-to-text is not loaded")
    if language not in (None, "", "no", "nb", "nn"):
        raise HTTPException(400, "phase 1 transcribes Norwegian only (English routing comes in phase 2)")
    import io

    data = io.BytesIO(await file.read())
    t = await asyncio.to_thread(state.stt.transcribe, data)
    return {"text": t.text, "language": t.language, "engine": t.engine, "confidence": t.confidence, "duration": t.duration_s, "took_ms": t.took_ms}


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
    audio = await asyncio.to_thread(state.tts.synthesize, req.input, req.voice, req.speed)
    rate = state.cfg["tts"]["sample_rate"]
    if req.response_format == "pcm":
        return Response(to_pcm16(audio), media_type="audio/pcm", headers={"x-sample-rate": str(rate)})
    return Response(to_wav(audio, rate), media_type="audio/wav")


class ControlRequest(BaseModel):
    mute: Optional[bool] = None


@app.post("/v1/control")
def control(req: ControlRequest) -> dict[str, Any]:
    if req.mute is not None:
        if state.mic is None:
            raise HTTPException(409, f"the mic isn't running ({state.mic_error or 'mic.enabled is false'})")
        state.mic.muted = req.mute
    return {"muted": bool(state.mic and state.mic.muted)}


@app.websocket("/v1/listen")
async def listen(ws: WebSocket) -> None:
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
