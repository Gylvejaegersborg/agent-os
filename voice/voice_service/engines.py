"""Speech-to-text, language ID and speech back. One inference at a time per engine, as the spec asks; each
warms up once at load so the first real request isn't the slow one.

- NbWhisper: Norwegian (and mixed or unsure) speech, through faster-whisper.
- WhisperLangId: vanilla whisper-tiny's language guess (phase 2). Not NB-Whisper: its fine-tune pulls every
  guess towards Norwegian.
- EnglishStt: English only (phase 2), Phonon-2 through onnx-asr or Bark 3.0 Plus through sherpa-onnx. Both are
  fine-tunes of NVIDIA's Parakeet TDT 0.6B v3, so they share one slot and are A/B'd on the same clips.
- KokoroTts: English speech back. PiperTts: Norwegian speech back (phase 3); Kokoro has no Norwegian voice.
  Both resample to tts.sample_rate (24 kHz) and are loudness-matched (normalize), so a mixed reply can switch
  engines between sentences on one open output device."""

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


class WhisperLangId:
    """Language ID on the start of an utterance. Encodes a short window, as NbWhisper does: the language token
    comes from the first decoder step, which only needs the audio there is."""

    name = "whisper-tiny"

    def __init__(self, model_dir: Path, threads: int = 2, max_s: float = 3.0, window_s: float = 10.0) -> None:
        from faster_whisper import WhisperModel

        if not model_dir.exists():
            raise FileNotFoundError(f"{model_dir} not found — run: python fetch_models.py")
        self._model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=threads)
        self._max = int(max_s * 16000)
        self._frames = int(window_s * 100)
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.detect(np.zeros(16000, dtype=np.float32))  # warm-up
        self.last_ms = None

    def detect(self, audio: np.ndarray) -> tuple[str, float, int]:
        """(language code, probability, ms taken) for the first max_s seconds of audio."""
        import ctranslate2

        started = time.perf_counter()
        feats = self._model.feature_extractor(audio[: self._max])[:, : self._frames]
        if feats.shape[1] < self._frames:
            feats = np.pad(feats, ((0, 0), (0, self._frames - feats.shape[1])))
        with self._lock:
            enc = self._model.model.encode(ctranslate2.StorageView.from_array(np.ascontiguousarray(feats[None], dtype=np.float32)), to_cpu=False)
            token, prob = self._model.model.detect_language(enc)[0][0]
        took = round((time.perf_counter() - started) * 1000)
        self.last_ms = took
        return token.strip("<|>"), float(prob), took


class EnglishStt:
    """Phonon-2 (onnx-asr, `nemo-conformer-tdt` layout) or Bark 3.0 Plus (sherpa-onnx `nemo_transducer`).
    Both int8; both give punctuated, cased text. No confidence score: the transducer has none to give."""

    def __init__(self, name: str, runtime: str, model_dir: Path, threads: int = 4, min_chars: int = 2) -> None:
        if not model_dir.exists():
            raise FileNotFoundError(f"{model_dir} not found — run: python fetch_models.py{' --bark' if runtime == 'sherpa-onnx' else ''}")
        self.name = name
        self._runtime = runtime
        self._min_chars = min_chars
        if runtime == "onnx-asr":
            import onnx_asr
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.intra_op_num_threads = threads
            opts.inter_op_num_threads = 1
            # Without the arena: ~690 MB instead of ~860 MB resident, at the same speed (measured, phase 5).
            opts.enable_cpu_mem_arena = False
            self._model = onnx_asr.load_model("nemo-conformer-tdt", model_dir, quantization="int8", sess_options=opts)
        elif runtime == "sherpa-onnx":
            import sherpa_onnx

            self._model = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(model_dir / "encoder.int8.onnx"),
                decoder=str(model_dir / "decoder.int8.onnx"),
                joiner=str(model_dir / "joiner.int8.onnx"),
                tokens=str(model_dir / "tokens.txt"),
                num_threads=threads,
                model_type="nemo_transducer",
                decoding_method="greedy_search",
            )
        else:
            raise ValueError(f"unknown English runtime {runtime!r} (onnx-asr or sherpa-onnx)")
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.transcribe(np.zeros(16000, dtype=np.float32))  # warm-up
        self.last_ms = None

    def transcribe(self, audio: Union[np.ndarray, BinaryIO]) -> Transcript:
        if not isinstance(audio, np.ndarray):
            from faster_whisper.audio import decode_audio

            audio = decode_audio(audio, sampling_rate=16000)
        started = time.perf_counter()
        with self._lock:
            if self._runtime == "onnx-asr":
                text = self._model.recognize(audio, sample_rate=16000)
            else:
                stream = self._model.create_stream()
                stream.accept_waveform(16000, audio)
                self._model.decode_stream(stream)
                text = stream.result.text
        text = (text or "").strip()
        if len(text) < self._min_chars:
            text = ""
        took = round((time.perf_counter() - started) * 1000)
        self.last_ms = took
        return Transcript(text=text, language="en", engine=self.name, confidence=None, duration_s=round(audio.size / 16000, 2), took_ms=took)


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


class PiperTts:
    name = "piper"

    def __init__(self, model: Path, sample_rate: int = 24000) -> None:
        from piper import PiperVoice

        if not model.exists():
            raise FileNotFoundError(f"{model} not found — run: python fetch_models.py --tts")
        self._voice = PiperVoice.load(str(model))
        self._rate = sample_rate
        self._lock = threading.Lock()
        self.last_ms: int | None = None
        self.synthesize("Klar.")  # warm-up: the first call is ~10x slower
        self.last_ms = None

    def synthesize(self, text: str, voice: str | None = None, speed: float = 1.0) -> np.ndarray:
        from piper import SynthesisConfig

        started = time.perf_counter()
        with self._lock:
            chunks = list(self._voice.synthesize(text, syn_config=SynthesisConfig(length_scale=1.0 / max(speed, 0.25))))
        audio = np.concatenate([c.audio_float_array for c in chunks]) if chunks else np.zeros(0, np.float32)
        rate = chunks[0].sample_rate if chunks else self._rate
        if rate != self._rate:
            audio = resample(audio, rate, self._rate)
        self.last_ms = round((time.perf_counter() - started) * 1000)
        return audio.astype(np.float32)


def normalize(audio: np.ndarray, target_db: float = -20.0) -> np.ndarray:
    """Loudness match between engines: RMS of the voiced part to target_db dBFS (a stand-in for the spec's
    −20 LUFS; same idea without a K-weighting filter), peaks kept under 0.98."""
    if audio.size == 0:
        return audio
    voiced = audio[np.abs(audio) > 0.01]
    rms = float(np.sqrt(np.mean(np.square(voiced)))) if voiced.size else 0.0
    if rms < 1e-5:
        return audio
    out = audio * (10 ** (target_db / 20) / rms)
    peak = float(np.abs(out).max())
    return (out * (0.98 / peak) if peak > 0.98 else out).astype(np.float32)


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
