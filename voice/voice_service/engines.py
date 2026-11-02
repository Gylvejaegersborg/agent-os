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


SHORT_WINDOW_MARGIN_S = 1.0


class NbWhisper:
    name = "nb-whisper-small"

    def __init__(self, model_dir: Path, threads: int = 4, beam: int = 1, min_chars: int = 2, min_window_s: float = 10.0) -> None:
        from faster_whisper import WhisperModel

        if not model_dir.exists():
            raise FileNotFoundError(f"{model_dir} not found — run: python fetch_models.py")
        self._model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=threads)
        self._beam = beam
        self._min_chars = min_chars
        # 0 turns the short window off (every clip padded to 30 s, as faster-whisper does).
        self._min_window_s = min_window_s
        tok = self._model.hf_tokenizer
        self._prompt = [tok.token_to_id(t) for t in ("<|startoftranscript|>", "<|no|>", "<|transcribe|>", "<|notimestamps|>")]
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.transcribe(np.zeros(16000, dtype=np.float32))  # warm-up
        self.last_ms = None

    def transcribe(self, audio: Union[np.ndarray, BinaryIO]) -> Transcript:
        if not isinstance(audio, np.ndarray):
            from faster_whisper.audio import decode_audio

            audio = decode_audio(audio, sampling_rate=16000)
        if self._min_window_s and audio.size / 16000 <= 30 - SHORT_WINDOW_MARGIN_S:
            return self._transcribe_short(audio)
        return self._transcribe_full(audio)

    def _transcribe_short(self, audio: np.ndarray) -> Transcript:
        """Encodes only as much of Whisper's 30 s window as the clip needs (at least min_window_s).
        The encoder is ~85% of the time and its cost grows with the window, so a 3 s clip in a 10 s
        window is ~4x faster than padded to 30 s, with the same text in our checks (whisper.cpp's
        audio_ctx does the same). Shorter than ~10 s started changing words, hence the floor."""
        import ctranslate2

        started = time.perf_counter()
        duration = audio.size / 16000
        window = min(30.0, max(self._min_window_s, duration + SHORT_WINDOW_MARGIN_S))
        frames = int(window * 100)  # 10 ms mel frames
        with self._lock:
            feats = self._model.feature_extractor(audio)[:, :frames]
            if feats.shape[1] < frames:
                feats = np.pad(feats, ((0, 0), (0, frames - feats.shape[1])))
            enc = self._model.model.encode(ctranslate2.StorageView.from_array(np.ascontiguousarray(feats[None], dtype=np.float32)), to_cpu=False)
            r = self._model.model.generate(enc, [self._prompt], beam_size=self._beam, max_length=224, return_scores=True)[0]
        text = self._model.hf_tokenizer.decode(r.sequences_ids[0]).strip()
        if len(text) < self._min_chars:
            text = ""
        conf = float(np.exp(r.scores[0])) if r.scores else None  # length-normalized log prob → 0–1
        took = round((time.perf_counter() - started) * 1000)
        self.last_ms = took
        return Transcript(text=text, language="no", engine=self.name, confidence=conf, duration_s=round(duration, 2), took_ms=took)

    def _transcribe_full(self, audio: np.ndarray) -> Transcript:
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
