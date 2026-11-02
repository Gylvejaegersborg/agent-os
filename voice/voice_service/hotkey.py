"""The mode hotkey (phase 2): one global key combination, through Windows' RegisterHotKey.

RegisterHotKey, not a keyboard hook: Windows tells this process about that one combination and nothing else,
so the service never sees what you type, and a slow below-normal-priority process can't make the keyboard lag
the way a low-level hook can. Windows only; elsewhere it logs and does nothing.
"""

from __future__ import annotations

import sys
import threading
from typing import Callable, Optional

MODIFIERS = {"alt": 0x1, "ctrl": 0x2, "control": 0x2, "shift": 0x4, "win": 0x8}
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012


def parse(combo: str) -> tuple[int, int]:
    """"ctrl+alt+l" → (modifier flags, virtual-key code). Letters, digits and F1–F24."""
    parts = [p.strip().lower() for p in combo.split("+") if p.strip()]
    if not parts:
        raise ValueError("empty hotkey")
    *mods, key = parts
    flags = 0
    for m in mods:
        if m not in MODIFIERS:
            raise ValueError(f"unknown modifier {m!r} in {combo!r}")
        flags |= MODIFIERS[m]
    if len(key) == 1 and key.isalnum():
        vk = ord(key.upper())
    elif key.startswith("f") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        vk = 0x70 + int(key[1:]) - 1
    else:
        raise ValueError(f"unsupported key {key!r} in {combo!r} (letters, digits, F1–F24)")
    if not flags:
        raise ValueError(f"{combo!r} has no modifier: a bare key would be taken from every app")
    return flags, vk


class Hotkey:
    def __init__(self, combo: str, on_press: Callable[[], None]) -> None:
        self.combo = combo
        self._flags, self._vk = parse(combo)
        self._on_press = on_press
        self._thread_id: Optional[int] = None
        self.error: Optional[str] = None
        self._ready = threading.Event()

    def start(self) -> bool:
        if sys.platform != "win32":
            self.error = "hotkeys are Windows-only"
            return False
        threading.Thread(target=self._loop, name="voice-hotkey", daemon=True).start()
        self._ready.wait(timeout=2)
        return self.error is None

    def _loop(self) -> None:
        import ctypes
        from ctypes import wintypes

        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
        self._thread_id = kernel32.GetCurrentThreadId()
        # The registration belongs to this thread: its message loop is where WM_HOTKEY arrives.
        if not user32.RegisterHotKey(None, 1, self._flags | MOD_NOREPEAT, self._vk):
            self.error = f"{self.combo} is taken by another app (RegisterHotKey failed)"
            self._ready.set()
            return
        self._ready.set()
        msg = wintypes.MSG()
        try:
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == WM_HOTKEY:
                    try:
                        self._on_press()
                    except Exception as err:
                        print(f"[voice] hotkey action failed: {err}")
        finally:
            user32.UnregisterHotKey(None, 1)

    def stop(self) -> None:
        if self._thread_id is not None:
            import ctypes

            ctypes.windll.user32.PostThreadMessageW(self._thread_id, WM_QUIT, 0, 0)
