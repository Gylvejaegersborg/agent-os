"""Idle unload (phase 5): a model that is loaded at start, dropped after `idle_s` without use, and loaded again
when needed. The mic calls prefetch() when speech starts, so after an idle spell the reload runs while you
talk instead of after you stop.

NB-Whisper, the English engine and Kokoro are lazy; the VAD and language ID are small and always loaded
(they're what notices you speaking). Each model gives its memory back when dropped (measured, see README).
"""

from __future__ import annotations

import gc
import threading
import time
from typing import Any, Callable, Generic, Optional, TypeVar

T = TypeVar("T")


class Lazy(Generic[T]):
    def __init__(self, name: str, factory: Callable[[], T], idle_s: float = 0, log: Callable[[str], None] = print, streams: bool = False) -> None:
        self.name = name
        self.streams = streams  # the model has stream(): speech back plays it as it's made
        self._factory = factory
        self.idle_s = idle_s  # 0 = never unload
        self._log = log
        self._obj: Optional[T] = None
        self._lock = threading.Lock()
        self._busy = 0
        self.last_used = time.time()
        self.loads = 0

    @property
    def loaded(self) -> bool:
        return self._obj is not None

    @property
    def last_ms(self) -> Optional[int]:
        obj = self._obj
        return getattr(obj, "last_ms", None) if obj is not None else None

    def _get(self) -> T:
        with self._lock:
            if self._obj is None:
                started = time.perf_counter()
                self._obj = self._factory()
                self.loads += 1
                if self.loads > 1:
                    self._log(f"[voice] {self.name} reloaded in {time.perf_counter() - started:.1f}s")
            self.last_used = time.time()
            return self._obj

    def run(self, fn: Callable[[T], Any]) -> Any:
        """Use the model (loading it if it was unloaded); it can't be unloaded while in use."""
        obj = self._get()
        with self._lock:
            self._busy += 1
        try:
            return fn(obj)
        finally:
            with self._lock:
                self._busy -= 1
                self.last_used = time.time()

    def load(self) -> None:
        self._get()

    def prefetch(self) -> None:
        """Start loading in the background if it isn't loaded (no-op otherwise)."""
        if self._obj is None and not self._lock.locked():
            threading.Thread(target=self._get, name=f"voice-load-{self.name}", daemon=True).start()

    def unload_if_idle(self, now: Optional[float] = None) -> bool:
        if not self.idle_s:
            return False
        now = time.time() if now is None else now
        with self._lock:
            if self._obj is None or self._busy or now - self.last_used < self.idle_s:
                return False
            self._obj = None
        gc.collect()
        self._log(f"[voice] {self.name} unloaded after {self.idle_s / 60:g} min idle")
        return True


def start_idle_watch(models: list[Lazy], every_s: float = 30.0) -> threading.Event:
    """One background thread checks every model now and then. Set the returned event to stop it."""
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(every_s):
            for m in models:
                m.unload_if_idle()

    threading.Thread(target=loop, name="voice-idle", daemon=True).start()
    return stop
