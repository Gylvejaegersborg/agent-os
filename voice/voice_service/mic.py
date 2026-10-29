"""The always-open mic: 16 kHz mono, 32 ms frames → Silero VAD → Segmenter → one transcription at a time.

Events go to every subscriber as dicts: speech_start, speech_end, final (text + language, engine,
confidence, timings). The audio never goes anywhere but the transcriber; nothing is stored.
"""

from __future__ import annotations

import queue
import threading
import time
from typing import Any, Callable

import numpy as np

from .engines import NbWhisper
from .segmenter import Segmenter
from .vad import SileroVad

Listener = Callable[[dict[str, Any]], None]


class MicListener:
    def __init__(self, cfg: dict[str, Any], vad: SileroVad, stt: NbWhisper) -> None:
        a, v = cfg["audio"], cfg["vad"]
        self._rate = a["sample_rate"]
        self._frame = a["frame_samples"]
        self._device = a["input_device"]
        self._vad = vad
        self._stt = stt
        self._seg = Segmenter(
            frame_ms=1000 * self._frame / self._rate,
            threshold=v["threshold"],
            min_silence_ms=v["min_silence_ms"],
            speech_pad_ms=v["speech_pad_ms"],
            preroll_ms=v["preroll_ms"],
            min_speech_ms=v["min_speech_ms"],
        )
        self._frames: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=200)
        # Queue depth 1: one utterance waits while another is transcribed; an older waiting one is replaced.
        self._utterances: "queue.Queue[tuple[np.ndarray, float]]" = queue.Queue(maxsize=1)
        self._listeners: list[Listener] = []
        self._stop = threading.Event()
        self._stream = None
        self.muted = False
        self.device_name: str | None = None
        self.dropped_frames = 0

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def _emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception as err:  # one broken subscriber must not stop the mic
                print(f"[voice] listener failed: {err}")

    def start(self) -> None:
        import sounddevice as sd

        def on_audio(indata, frames, _time, status) -> None:
            if status:
                self.dropped_frames += 1
            try:
                self._frames.put_nowait(indata[:, 0].copy())
            except queue.Full:
                self.dropped_frames += 1

        self._stream = sd.InputStream(
            samplerate=self._rate, channels=1, dtype="float32", blocksize=self._frame, device=self._device, callback=on_audio
        )
        info = sd.query_devices(self._stream.device, "input")
        self.device_name = str(info["name"])
        self._stream.start()
        threading.Thread(target=self._vad_loop, name="voice-vad", daemon=True).start()
        threading.Thread(target=self._stt_loop, name="voice-stt", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()

    def _vad_loop(self) -> None:
        while not self._stop.is_set():
            try:
                frame = self._frames.get(timeout=0.5)
            except queue.Empty:
                continue
            if self.muted:
                continue
            event, utt = self._seg.push(frame, self._vad(frame))
            if event == "speech_start":
                self._emit({"type": "speech_start", "t": time.time()})
            elif event == "speech_end":
                ended = time.time()
                self._emit({"type": "speech_end", "t": ended, "kept": utt is not None})
                if utt is not None:
                    audio = np.concatenate(utt.frames).astype(np.float32)
                    # When the speaker actually stopped: before the silence window that closed the utterance.
                    stopped = ended - self._seg.min_silence_ms / 1000
                    try:
                        self._utterances.put_nowait((audio, stopped))
                    except queue.Full:
                        try:
                            self._utterances.get_nowait()  # replace the stale one
                        except queue.Empty:
                            pass
                        self._utterances.put_nowait((audio, stopped))
                self._vad.reset()

    def _stt_loop(self) -> None:
        while not self._stop.is_set():
            try:
                audio, stopped = self._utterances.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                t = self._stt.transcribe(audio)
            except Exception as err:
                self._emit({"type": "error", "error": str(err)})
                continue
            if not t.text:
                continue
            latency = round((time.time() - stopped) * 1000)
            event = {
                "type": "final",
                "text": t.text,
                "language": t.language,
                "engine": t.engine,
                "confidence": t.confidence,
                "audio_s": round(t.duration_s, 2),
                "transcribe_ms": t.took_ms,
                "end_of_speech_to_final_ms": latency,
            }
            print(f"[voice] final ({t.language}, {t.engine}, {latency} ms): {t.text}")
            self._emit(event)
