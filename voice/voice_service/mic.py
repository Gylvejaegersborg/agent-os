"""The always-open mic: 16 kHz mono, 32 ms frames → Silero VAD → Segmenter → one transcription at a time.

Events go to every subscriber as dicts: speech_start, speech_end, final (text + language, engine,
confidence, timings). The audio never goes anywhere but the transcriber; nothing is stored.

Speculative transcription (phase 4): at `speculative_ms` of silence the utterance so far is queued for
transcription. If the silence lasts to `min_silence_ms`, that same utterance is final and its text is usually
ready already; if speech comes back, the result is thrown away. A job already running can't be stopped, so a
stale one finishes and is dropped; a stale one still waiting is removed. Utterances that are final are never
dropped from the queue.
"""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np

from .engines import NbWhisper, Transcript
from .segmenter import Segmenter, Utterance
from .vad import SileroVad

Listener = Callable[[dict[str, Any]], None]


@dataclass
class Job:
    key: tuple[int, int]
    audio: np.ndarray
    stopped: float  # when the speaker stopped (wall clock), for the latency figure
    speculative: bool
    final: bool = False
    stale: bool = False
    done: bool = False
    emitted: bool = False
    transcript: Optional[Transcript] = None
    error: Optional[str] = None
    created: float = field(default_factory=time.time)


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
            speculative_ms=v["speculative_ms"] if v["speculative_ms"] < v["min_silence_ms"] else 0,
        )
        self._frames: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=200)
        self._jobs: deque[Job] = deque()
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._spec: Optional[Job] = None
        self._listeners: list[Listener] = []
        self._stop = threading.Event()
        self._stream = None
        self.muted = False
        self.device_name: str | None = None
        self.dropped_frames = 0
        self.stats = {"finals": 0, "speculative_used": 0, "speculative_wasted": 0}

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def _emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception as err:  # one broken subscriber must not stop the mic
                print(f"[voice] listener failed: {err}")

    def feed(self, frame: np.ndarray) -> None:
        """One frame of audio: from the sound card, or from replay.py."""
        try:
            self._frames.put_nowait(frame)
        except queue.Full:
            self.dropped_frames += 1

    def start(self, use_device: bool = True) -> None:
        if use_device:
            import sounddevice as sd

            def on_audio(indata, frames, _time, status) -> None:
                if status:
                    self.dropped_frames += 1
                self.feed(indata[:, 0].copy())

            self._stream = sd.InputStream(
                samplerate=self._rate, channels=1, dtype="float32", blocksize=self._frame, device=self._device, callback=on_audio
            )
            self.device_name = str(sd.query_devices(self._stream.device, "input")["name"])
            self._stream.start()
        threading.Thread(target=self._vad_loop, name="voice-vad", daemon=True).start()
        threading.Thread(target=self._stt_loop, name="voice-stt", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        with self._wake:
            self._wake.notify_all()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()

    # ── VAD side ────────────────────────────────────────────────────────────

    def _vad_loop(self) -> None:
        silence_s = self._seg.min_silence_ms / 1000
        spec_s = self._seg.speculative_ms / 1000
        while not self._stop.is_set():
            try:
                frame = self._frames.get(timeout=0.5)
            except queue.Empty:
                continue
            if self.muted:
                continue
            event, utt = self._seg.push(frame, self._vad(frame))
            now = time.time()
            if event == "speech_start":
                self._emit({"type": "speech_start", "t": now})
            elif event == "pause":
                if utt is not None:
                    self._submit(Job(key=_key(utt), audio=_audio(utt), stopped=now - spec_s, speculative=True))
            elif event == "resume":
                self._drop_speculation()
            elif event == "speech_end":
                self._emit({"type": "speech_end", "t": now, "kept": utt is not None})
                if utt is None:
                    self._drop_speculation()
                else:
                    self._finalize(utt, stopped=now - silence_s)
                self._vad.reset()

    def _submit(self, job: Job) -> None:
        with self._wake:
            if job.speculative:
                self._mark_stale(self._spec)
                self._spec = job
            # Waiting stale speculative jobs make way; final ones always stay.
            self._jobs = deque(j for j in self._jobs if not j.stale)
            self._jobs.append(job)
            self._wake.notify()

    def _drop_speculation(self) -> None:
        with self._wake:
            self._mark_stale(self._spec)
            self._spec = None
            self._jobs = deque(j for j in self._jobs if not j.stale)

    def _mark_stale(self, job: Optional[Job]) -> None:
        if job is not None and not job.final and not job.stale:
            job.stale = True
            self.stats["speculative_wasted"] += 1

    def _finalize(self, utt: Utterance, stopped: float) -> None:
        with self._wake:
            spec, self._spec = self._spec, None
            if spec is not None and not spec.stale and spec.key == _key(utt):
                # The speculative job covered exactly this utterance: use it (now, or when it finishes).
                spec.final = True
                self.stats["speculative_used"] += 1
                if spec.done:
                    self._emit_result(spec)
                return
            self._mark_stale(spec)
        self._submit(Job(key=_key(utt), audio=_audio(utt), stopped=stopped, speculative=False, final=True))

    # ── transcription side ─────────────────────────────────────────────────

    def _stt_loop(self) -> None:
        while not self._stop.is_set():
            with self._wake:
                while not self._jobs and not self._stop.is_set():
                    self._wake.wait(timeout=0.5)
                if self._stop.is_set():
                    return
                job = self._jobs.popleft()
                if job.stale:
                    continue
            try:
                t = self._stt.transcribe(job.audio)
                err = None
            except Exception as e:
                t, err = None, str(e)
            with self._wake:
                job.transcript, job.error, job.done = t, err, True
                if job.final and not job.stale:
                    self._emit_result(job)

    def _emit_result(self, job: Job) -> None:
        """Called with the lock held, once per job that is both final and done."""
        if job.emitted:
            return
        job.emitted = True
        if job.error:
            self._emit({"type": "error", "error": job.error})
            return
        t = job.transcript
        if t is None or not t.text:
            return
        self.stats["finals"] += 1
        latency = round((time.time() - job.stopped) * 1000)
        print(f"[voice] final ({t.language}, {t.engine}, {latency} ms{', speculative' if job.speculative else ''}): {t.text}")
        self._emit(
            {
                "type": "final",
                "text": t.text,
                "language": t.language,
                "engine": t.engine,
                "confidence": t.confidence,
                "audio_s": round(t.duration_s, 2),
                "transcribe_ms": t.took_ms,
                "end_of_speech_to_final_ms": latency,
                "speculative": job.speculative,
            }
        )


def _key(utt: Utterance) -> tuple[int, int]:
    return (utt.start_frame, utt.end_frame)


def _audio(utt: Utterance) -> np.ndarray:
    return np.concatenate([np.asarray(f, dtype=np.float32) for f in utt.frames])
