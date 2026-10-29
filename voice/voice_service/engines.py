"""Speech-to-text (NB-Whisper through faster-whisper) and speech back (Kokoro). One inference at a time per
engine, as the spec asks; both warm up once at load so the first real request isn't the slow one.
Phase 1 has only these two: language ID, Phonon-2 and Piper come in phases 2 and 3."""

from __future__ import annotations

import io
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Union

import numpy as np


@dataclass
class Transcript:
    text: str
    language: str
    engine: str
    confidence: float | None
    duration_s: float
    took_ms: int


class NbWhisper:
    name = "nb-whisper-small"

    def __init__(self, model_dir: Path, threads: int = 4, beam: int = 1, min_chars: int = 2) -> None:
        from faster_whisper import WhisperModel

        if not model_dir.exists():
            raise FileNotFoundError(f"{model_dir} not found — run: python fetch_models.py")
        self._model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=threads)
        self._beam = beam
        self._min_chars = min_chars
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.transcribe(np.zeros(16000, dtype=np.float32))  # warm-up
        self.last_ms = None

    def transcribe(self, audio: Union[np.ndarray, BinaryIO]) -> Transcript:
        started = time.perf_counter()
        with self._lock:
            segments, info = self._model.transcribe(
                audio,
                language="no",
                beam_size=self._beam,
                condition_on_previous_text=False,
                vad_filter=False,  # Silero already found the speech
            )
            parts = list(segments)
        text = " ".join(s.text.strip() for s in parts).strip()
        # Whisper invents words on noise: drop near-empty output.
        if len(text) < self._min_chars:
            text = ""
        # avg_logprob per segment → a rough 0–1 confidence, duration-weighted.
        conf = None
        if parts:
            total = sum(max(s.end - s.start, 1e-3) for s in parts)
            conf = float(sum(np.exp(s.avg_logprob) * max(s.end - s.start, 1e-3) for s in parts) / total)
        took = round((time.perf_counter() - started) * 1000)
        self.last_ms = took
        return Transcript(text=text, language="no", engine=self.name, confidence=conf, duration_s=float(info.duration), took_ms=took)


class KokoroTts:
    name = "kokoro"

    def __init__(self, model: Path, voices: Path, voice: str, sample_rate: int = 24000) -> None:
        from kokoro_onnx import Kokoro

        for p in (model, voices):
            if not p.exists():
                raise FileNotFoundError(f"{p} not found — run: python fetch_models.py --tts")
        self._kokoro = Kokoro(str(model), str(voices))
        self._voice = voice
        self._rate = sample_rate
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.synthesize("Ready.")  # warm-up
        self.last_ms = None

    def synthesize(self, text: str, voice: str | None = None, speed: float = 1.0) -> np.ndarray:
        started = time.perf_counter()
        with self._lock:
            samples, rate = self._kokoro.create(text, voice=voice or self._voice, speed=speed, lang="en-us")
        audio = np.asarray(samples, dtype=np.float32)
        if rate != self._rate:
            audio = resample(audio, rate, self._rate)
        self.last_ms = round((time.perf_counter() - started) * 1000)
        return audio


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    """Linear resampling; good enough for speech between 16/22/24 kHz until phase 3 picks a proper one."""
    if src == dst or audio.size == 0:
        return audio
    n = int(round(audio.size * dst / src))
    return np.interp(np.linspace(0, audio.size - 1, n), np.arange(audio.size), audio).astype(np.float32)


def to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def to_wav(audio: np.ndarray, sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(to_pcm16(audio))
    return buf.getvalue()
