"""Which transcriber gets an utterance (phase 2). Pure Python, no models, so it is tested on its own.

- Mode "no" or "en" (the hotkey or POST /v1/control) forces that engine and skips language ID.
- Mode "auto": English with probability ≥ en_threshold goes to the English engine; everything else (Norwegian,
  mixed, another language, unsure) goes to NB-Whisper, which copes with English words in Norwegian speech while
  the English engines are English-only.
- Sticky language: within sticky_window_s of a detection at ≥ sticky_conf, the next utterance reuses its engine
  without running language ID. The window counts from that detection, not from the reuse, so a wrong guess
  can't stick for a whole conversation: at most sticky_window_s, then language ID runs again. Off by default
  (lang_id.sticky_window_s: 0; config.py says why).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

MODES = ("auto", "no", "en")


@dataclass
class Route:
    engine: str  # "no" or "en"
    reason: str  # forced | sticky | detected | no-english-engine
    language: Optional[str] = None  # what language ID said, when it ran
    prob: Optional[float] = None


@dataclass
class Router:
    en_threshold: float = 0.80
    sticky_conf: float = 0.90
    sticky_window_s: float = 20.0
    has_en: bool = True
    mode: str = "auto"
    _last: Optional[tuple[str, float]] = field(init=False, default=None)  # (engine, time of the detection)

    def set_mode(self, mode: str) -> str:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}")
        self.mode = mode
        self._last = None
        return mode

    def next_mode(self) -> str:
        """Auto → NO → EN → Auto (the hotkey)."""
        return self.set_mode(MODES[(MODES.index(self.mode) + 1) % len(MODES)])

    def before_detection(self, now: float) -> Optional[Route]:
        """The route when no language ID is needed (forced, no English engine, or sticky); None means detect."""
        if self.mode != "auto":
            return Route(engine=self.mode if self.has_en or self.mode == "no" else "no", reason="forced")
        if not self.has_en:
            return Route(engine="no", reason="no-english-engine")
        if self._last is not None:
            engine, at = self._last
            if now - at < self.sticky_window_s:
                return Route(engine=engine, reason="sticky")
        return None

    def decide(self, language: str, prob: float) -> Route:
        engine = "en" if language == "en" and prob >= self.en_threshold else "no"
        return Route(engine=engine, reason="detected", language=language, prob=prob)

    def remember(self, route: Route, now: float) -> None:
        """Called once an utterance is final. Only a confident detection starts a sticky window."""
        if route.reason == "detected":
            self._last = (route.engine, now) if route.prob is not None and route.prob >= self.sticky_conf else None
