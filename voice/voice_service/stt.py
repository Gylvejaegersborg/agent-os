"""The transcribers and the router together: one object the mic, the HTTP route and replay.py all use.

Loads NB-Whisper always, and language ID plus the English engine named by stt.en ("phonon-2", "bark-plus",
or none). If the English engine can't load (models missing), everything goes to NB-Whisper and /health says why.
NB-Whisper and the English engine unload after resources.idle_unload_min without use (lazy.py); language ID
stays loaded.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Optional

import numpy as np

from .config import model_path
from .engines import EnglishStt, NbWhisper, Transcript, WhisperLangId
from .lazy import Lazy
from .router import Route, Router


@dataclass
class Detection:
    language: str
    prob: float
    took_ms: int


class SpeechToText:
    def __init__(self, cfg: dict[str, Any], log=print) -> None:
        s, r, li = cfg["stt"], cfg["resources"], cfg["lang_id"]
        idle_s = 60 * (r.get("idle_unload_min") or 0)
        t0 = time.perf_counter()
        self.no: Lazy[NbWhisper] = Lazy(
            NbWhisper.name,
            lambda: NbWhisper(model_path(s["no"]), threads=r["threads"], beam=s["no_beam"], min_chars=s["min_chars"], min_window_s=s["min_window_s"]),
            idle_s,
            log,
        )
        self.no.load()
        log(f"[voice] NB-Whisper loaded in {time.perf_counter() - t0:.1f}s")
        self.en: Optional[Lazy[EnglishStt]] = None
        self.langid: Optional[WhisperLangId] = None
        self.en_error: Optional[str] = None
        name = s.get("en")
        if name:
            try:
                spec = s["en_engines"][name]
                t0 = time.perf_counter()
                self.langid = WhisperLangId(model_path(li["model"]), threads=r["vad_threads"], max_s=li["max_s"])
                en = Lazy(name, lambda: EnglishStt(name, spec["runtime"], model_path(spec["path"]), threads=r["threads"], min_chars=s["min_chars"]), idle_s, log)
                en.load()
                self.en = en
                log(f"[voice] language ID + {name} loaded in {time.perf_counter() - t0:.1f}s")
            except Exception as err:  # Norwegian keeps working without them
                self.en, self.langid = None, None
                self.en_error = str(err) if not isinstance(err, KeyError) else f"stt.en is {name!r}, not one of stt.en_engines"
                log(f"[voice] English routing off: {self.en_error}")
        self.router = Router(
            en_threshold=li["en_threshold"],
            sticky_conf=li["sticky_conf"],
            sticky_window_s=li["sticky_window_s"],
            has_en=self.en is not None,
            mode=cfg.get("mode", "auto"),
        )

    @property
    def lazy_models(self) -> list[Lazy]:
        return [m for m in (self.no, self.en) if m is not None]

    def prefetch(self) -> None:
        """Speech started: reload whatever idle unload dropped, while the speaker talks."""
        for m in self.lazy_models:
            m.prefetch()

    def detect(self, audio: np.ndarray) -> Optional[Detection]:
        if self.langid is None:
            return None
        lang, prob, took = self.langid.detect(audio)
        return Detection(lang, prob, took)

    def route(self, audio: np.ndarray, detection: Optional[Detection] = None, now: Optional[float] = None) -> tuple[Route, Optional[Detection]]:
        """The engine for this audio: forced/sticky without language ID, else from `detection` (early, from the
        mic) or a detection run now."""
        r = self.router.before_detection(time.time() if now is None else now)
        if r is not None:
            return r, None
        detection = detection or self.detect(audio)
        return self.router.decide(detection.language, detection.prob), detection

    def transcribe(self, audio: np.ndarray, route: Route) -> Transcript:
        engine = self.en if route.engine == "en" and self.en is not None else self.no
        return engine.run(lambda m: m.transcribe(audio))

    def transcribe_file(self, audio: np.ndarray, language: Optional[str]) -> tuple[Transcript, Route]:
        """For POST /v1/audio/transcriptions: an explicit language wins; else the mode; else language ID.
        A file never starts or uses a sticky window (it isn't part of the conversation at the mic)."""
        if language in ("no", "nb", "nn"):
            route = Route(engine="no", reason="forced")
        elif language == "en":
            if self.en is None:
                raise LookupError(f"no English engine loaded ({self.en_error or 'stt.en is off'})")
            route = Route(engine="en", reason="forced")
        elif self.router.mode != "auto":
            route = Route(engine=self.router.mode if self.en is not None else "no", reason="forced")
        elif self.langid is None:
            route = Route(engine="no", reason="no-english-engine")
        else:
            d = self.detect(audio)
            route = self.router.decide(d.language, d.prob)
        return self.transcribe(audio, route), route
