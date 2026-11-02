"""Speech back (phase 3): text → sentences → a language per sentence → Kokoro (en) or Piper (no) → one playback
queue on this machine's speakers. Only with tts.enabled (off by default).

- SentenceSplitter: emits a sentence as soon as it ends (. ! ? : or a newline, then whitespace), so a reply
  streamed from a model starts speaking at its first sentence. Fragments under 4 words wait and join the next
  sentence ("Ok." on its own sounds clipped and is a coin toss for language ID).
- SentenceLanguage: fastText lid.176 per sentence. Short (< 5 words) or unsure (< 0.6) sentences keep the
  previous sentence's language; a request can force one. Anything not English is spoken by Piper's Norwegian
  voice: fastText often calls Norwegian Danish or Swedish, and that's the closest voice there is anyway.
- Speaker: synthesizes sentence N+1 while N plays, both engines resampled to one rate, on ONE output stream
  that stays open, so there's no gap or click between sentences or engines. stop() (barge-in) cuts the sound
  within one 20 ms block and drops everything queued.
"""

from __future__ import annotations

import queue
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import numpy as np

from .engines import normalize

_END = re.compile(r"([.!?:…]+[\"')\]]*)(\s+)|(\n+)")


def _words(s: str) -> int:
    return len(s.split())


class SentenceSplitter:
    def __init__(self, min_words: int = 4) -> None:
        self.min_words = min_words
        self._buf = ""
        self._held = ""

    def feed(self, text: str) -> list[str]:
        """Add text (a whole reply or a streamed piece); returns the sentences that are complete now."""
        self._buf += text
        out: list[str] = []
        while True:
            m = _END.search(self._buf)
            if not m:
                break
            sentence = self._buf[: m.start() + len(m.group(1) or "")].strip()
            self._buf = self._buf[m.end() :]
            if sentence:
                out.extend(self._emit(sentence))
        return out

    def flush(self) -> list[str]:
        """The end of the text: whatever is left, held fragment included."""
        rest = (self._held + " " + self._buf).strip()
        self._held, self._buf = "", ""
        return [rest] if rest else []

    def _emit(self, sentence: str) -> list[str]:
        joined = (self._held + " " + sentence).strip()
        if _words(joined) < self.min_words:
            self._held = joined
            return []
        self._held = ""
        return [joined]


def split_sentences(text: str, min_words: int = 4) -> list[str]:
    s = SentenceSplitter(min_words)
    return s.feed(text) + s.flush()


def first_clause(sentence: str, min_words: int = 4) -> list[str]:
    """A long sentence split once at its first comma or semicolon (with at least min_words before it and 3 after).
    Used on a reply's first sentence only: Kokoro takes ~1.3 s for a 3.7 s sentence on this CPU, so starting with
    the first clause gets sound out ~3x sooner, and the comma is a natural pause anyway."""
    for m in re.finditer(r"[,;]\s+", sentence):
        head, tail = sentence[: m.start() + 1], sentence[m.end() :]
        if _words(head) >= min_words and _words(tail) >= 3:
            return [head, tail]
    return [sentence]


class SentenceLanguage:
    """Which voice speaks a sentence: 'en' or 'no'."""

    def __init__(self, detect: Optional[Callable[[str], tuple[str, float]]], min_words: int = 5, min_prob: float = 0.6, default: str = "no") -> None:
        self._detect = detect
        self.min_words = min_words
        self.min_prob = min_prob
        self.previous = default

    def __call__(self, sentence: str, forced: Optional[str] = None) -> str:
        if forced in ("en", "no"):
            self.previous = forced
            return forced
        if self._detect is not None and _words(sentence) >= self.min_words:
            lang, prob = self._detect(sentence)
            if prob >= self.min_prob:
                self.previous = "en" if lang == "en" else "no"
        return self.previous


SCANDINAVIAN = {"no", "nn", "nb", "da", "sv"}


def fasttext_detector(model_path) -> Callable[[str], tuple[str, float]]:
    """fastText lid.176, as 'en' or 'no' with a probability. Norwegian, Danish and Swedish count together: fastText
    spreads a Norwegian sentence over all three ("Jeg har lagt inn en påminnelse…" came back no/da/sv with none
    above 0.6, and so kept the English voice from the sentence before). Calls the C++ core directly: the Python
    wrapper's predict() breaks on NumPy 2 (np.array(copy=False))."""
    import fasttext

    model = fasttext.load_model(str(model_path))

    def detect(sentence: str) -> tuple[str, float]:
        top = model.f.predict(sentence.replace("\n", " "), 10, 0.0, "strict")
        probs = {label.replace("__label__", ""): float(p) for p, label in top}
        en = probs.get("en", 0.0)
        scand = sum(v for k, v in probs.items() if k in SCANDINAVIAN)
        return ("en", en) if en >= scand else ("no", scand)

    return detect


@dataclass
class Spoken:
    gen: int
    text: str
    language: str
    engine: str
    audio: np.ndarray
    synth_ms: int


class Speaker:
    """One playback queue on the default output device (or tts.output_device), open for the service's life."""

    def __init__(
        self,
        engines: dict[str, Any],  # "en" / "no" → a Lazy wrapping KokoroTts / PiperTts (either may be missing)
        language: SentenceLanguage,
        sample_rate: int = 24000,
        device: Any = None,
        emit: Callable[[dict[str, Any]], None] = lambda e: None,
        play: bool = True,
    ) -> None:
        self._engines = engines
        self._language = language
        self._rate = sample_rate
        self._device = device
        self._emit = emit
        # (generation, text to speak, forced language, the whole sentence it's from — what language ID reads)
        self._text: "queue.Queue[tuple[int, str, Optional[str], str]]" = queue.Queue()
        self._audio: "queue.Queue[Spoken]" = queue.Queue()
        self._gen = 0
        self._lock = threading.Lock()
        self._current: Optional[Spoken] = None
        self._pos = 0
        self._speaking = False
        self._pending = 0  # sentences said but not yet played to the end (queued, being made, or playing)
        self._stream = None
        self._stop = threading.Event()
        self.timeline: list[tuple[str, float]] = []  # (event, time) for the gap measurement in tests
        threading.Thread(target=self._synth_loop, name="voice-tts", daemon=True).start()
        if play:
            import sounddevice as sd

            self._stream = sd.OutputStream(samplerate=sample_rate, channels=1, dtype="float32", blocksize=sample_rate // 50, device=device, callback=self._callback)
            self._stream.start()

    @property
    def speaking(self) -> bool:
        return self._speaking

    def engine_for(self, language: str) -> Optional[Any]:
        return self._engines.get(language) or self._engines.get("no" if language == "en" else "en")

    def say(self, sentences: list[str], language: Optional[str] = None) -> None:
        with self._lock:
            starting = not self._speaking and self._pending == 0
            for i, s in enumerate(sentences):
                parts = first_clause(s) if starting and i == 0 else [s]
                for part in parts:
                    self._pending += 1
                    self._text.put((self._gen, part, language, s))

    def stop(self, reason: str = "stop") -> bool:
        """Cut the sound now and drop everything queued. True if something was playing or waiting."""
        with self._lock:
            had = self._speaking or not self._text.empty() or not self._audio.empty()
            self._gen += 1
            self._pending = 0
            self._current, self._pos = None, 0
            for q in (self._text, self._audio):
                while True:
                    try:
                        q.get_nowait()
                    except queue.Empty:
                        break
            was_speaking, self._speaking = self._speaking, False
        if was_speaking:
            self._emit({"type": "speak_end", "reason": reason, "t": time.time()})
        return had

    def synthesize(self, sentence: str, language: str) -> tuple[np.ndarray, str]:
        """One sentence → (audio at the output rate, loudness-matched; engine name)."""
        lazy = self.engine_for(language)
        if lazy is None:
            raise LookupError("no speech engine loaded")
        audio = lazy.run(lambda e: e.synthesize(sentence))
        return normalize(audio), lazy.name

    def close(self) -> None:
        self._stop.set()
        self.stop()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()

    # Synthesis runs ahead of playback: sentence N+1 is made while N plays.
    def _synth_loop(self) -> None:
        while not self._stop.is_set():
            try:
                gen, sentence, forced, whole = self._text.get(timeout=0.5)
            except queue.Empty:
                continue
            if gen != self._gen:
                continue
            lang = self._language(whole, forced)
            started = time.perf_counter()
            try:
                audio, engine = self.synthesize(sentence, lang)
            except Exception as err:
                with self._lock:
                    if gen == self._gen:
                        self._pending -= 1
                self._emit({"type": "error", "error": f"speech back: {err}"})
                continue
            with self._lock:
                if gen == self._gen:
                    self._audio.put(Spoken(gen, sentence, lang, engine, audio, round((time.perf_counter() - started) * 1000)))

    def next_block(self, frames: int) -> np.ndarray:
        """The next `frames` samples to play (silence when there's nothing). The output callback calls this; tests
        call it directly to play "faster than real time"."""
        out = np.zeros(frames, np.float32)
        filled = 0
        events: list[dict[str, Any]] = []
        with self._lock:
            while filled < frames:
                if self._current is None:
                    try:
                        nxt = self._audio.get_nowait()
                    except queue.Empty:
                        break
                    if nxt.gen != self._gen:
                        continue
                    self._current, self._pos = nxt, 0
                    if not self._speaking:
                        self._speaking = True
                        events.append({"type": "speak_start", "t": time.time()})
                    events.append({"type": "sentence", "text": nxt.text, "language": nxt.language, "engine": nxt.engine, "synth_ms": nxt.synth_ms})
                    self.timeline.append(("start", time.perf_counter()))
                cur = self._current
                take = min(frames - filled, cur.audio.size - self._pos)
                out[filled : filled + take] = cur.audio[self._pos : self._pos + take]
                filled += take
                self._pos += take
                if self._pos >= cur.audio.size:
                    self._current = None
                    self._pending -= 1
                    self.timeline.append(("end", time.perf_counter()))
            if self._current is None and self._speaking and self._pending <= 0:
                self._speaking = False
                events.append({"type": "speak_end", "reason": "done", "t": time.time()})
        for e in events:
            self._emit(e)
        return out

    def _callback(self, outdata, frames, _time, _status) -> None:
        outdata[:, 0] = self.next_block(frames)
