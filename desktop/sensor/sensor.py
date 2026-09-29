"""
agent-os desktop sensor (Windows).

Watches which app/window is in front and whether you're idle, and posts
finished spans to the agent-os gateway (POST /desktop/spans). That's all.

Never collected: keystrokes, typed text, clipboard, screenshots, audio.
The richest thing that leaves this script is a window title, after your
privacy rules (privacy.json) have run on it. And it only ever goes to the
gateway on 127.0.0.1 — your own machine.

Standard library only (ctypes + urllib), so there's nothing to install:

    python sensor.py                       # gateway on http://127.0.0.1:8787
    python sensor.py --gateway http://127.0.0.1:9000
    python sensor.py --dry-run             # print spans instead of posting

Run it at login with pythonw.exe (no console window), e.g. a shortcut in
shell:startup pointing at:  pythonw.exe C:\\path\\to\\sensor.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, Protocol

HERE = Path(__file__).resolve().parent

SAMPLE_EVERY_S = 1.0
FLUSH_EVERY_S = 15.0
# A span still open after this long is closed and a new one started, so a
# crash or power cut loses at most this much. The gateway merges them back.
SPLIT_AFTER_S = 60.0
IDLE_AFTER_S = 120.0
SPOOL_MAX_SPANS = 20_000


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


# ---- privacy ----------------------------------------------------------------

@dataclass
class Privacy:
    """Loaded from privacy.json next to this file (see privacy.example.json).

    skip_apps:     process names recorded only as "(private)" — time is still
                   counted, nothing about the window is.
    private_title_patterns: if a title matches any of these (regex, case-
                   insensitive), the window is treated like a skipped app.
    title_only_app_apps:   apps where only the app name is kept, never the
                   title (e.g. mail, chat).
    redact_patterns: regexes removed from every title that IS kept.
    """
    skip_apps: set[str] = field(default_factory=set)
    private_title_patterns: list[re.Pattern] = field(default_factory=list)
    title_only_app_apps: set[str] = field(default_factory=set)
    redact_patterns: list[re.Pattern] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "Privacy":
        if not path.exists():
            path = HERE / "privacy.example.json"
        raw = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        lower = lambda xs: {x.lower() for x in xs}  # noqa: E731
        rx = lambda xs: [re.compile(x, re.IGNORECASE) for x in xs]  # noqa: E731
        return cls(
            skip_apps=lower(raw.get("skip_apps", [])),
            private_title_patterns=rx(raw.get("private_title_patterns", [])),
            title_only_app_apps=lower(raw.get("title_only_app_apps", [])),
            redact_patterns=rx(raw.get("redact_patterns", [])),
        )

    def apply(self, app: str, title: str) -> tuple[str, str]:
        if app.lower() in self.skip_apps or any(p.search(title) for p in self.private_title_patterns):
            return "(private)", ""
        if app.lower() in self.title_only_app_apps:
            return app, ""
        for p in self.redact_patterns:
            title = p.sub("…", title)
        return app, re.sub(r"\s+", " ", title).strip()


# ---- platform ---------------------------------------------------------------

class Platform(Protocol):
    def foreground(self) -> Optional[tuple[str, str]]: ...
    def idle_seconds(self) -> float: ...


class WindowsPlatform:
    """Foreground window + idle time via user32/kernel32. No hooks, no
    input listening — GetLastInputInfo only says WHEN you last touched the
    keyboard or mouse, never WHAT."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self.ct = ctypes
        self.user32 = ctypes.windll.user32
        self.kernel32 = ctypes.windll.kernel32

        class LASTINPUTINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]

        self.LASTINPUTINFO = LASTINPUTINFO
        self.kernel32.GetTickCount.restype = wintypes.DWORD

    def foreground(self) -> Optional[tuple[str, str]]:
        ct = self.ct
        hwnd = self.user32.GetForegroundWindow()
        if not hwnd:
            return None
        length = self.user32.GetWindowTextLengthW(hwnd)
        buf = ct.create_unicode_buffer(length + 1)
        self.user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value

        pid = ct.c_ulong()
        self.user32.GetWindowThreadProcessId(hwnd, ct.byref(pid))
        app = "unknown"
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = self.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
        if h:
            try:
                size = ct.c_ulong(1024)
                path = ct.create_unicode_buffer(size.value)
                if self.kernel32.QueryFullProcessImageNameW(h, 0, path, ct.byref(size)):
                    app = os.path.basename(path.value)
            finally:
                self.kernel32.CloseHandle(h)
        if not title and app == "unknown":
            return None
        return app, title

    def idle_seconds(self) -> float:
        lii = self.LASTINPUTINFO()
        lii.cbSize = self.ct.sizeof(lii)
        if not self.user32.GetLastInputInfo(self.ct.byref(lii)):
            return 0.0
        return max(0.0, (self.kernel32.GetTickCount() - lii.dwTime) / 1000.0)


# ---- span tracking (pure; tested without Windows) ----------------------------

@dataclass
class OpenSpan:
    kind: str
    app: str
    title: str
    start: float


class Tracker:
    """Turns 1-second samples into closed spans. Pure logic — the clock and
    the samples are passed in, so it's testable anywhere."""

    def __init__(self, privacy: Privacy) -> None:
        self.privacy = privacy
        self.open: Optional[OpenSpan] = None
        self.closed: list[dict] = []

    def _close(self, now: float) -> None:
        s = self.open
        if s and now > s.start:
            self.closed.append({
                "id": uuid.uuid4().hex,
                "kind": s.kind,
                "app": s.app,
                "title": s.title,
                "start": iso(s.start),
                "end": iso(now),
            })
        self.open = None

    def sample(self, now: float, fg: Optional[tuple[str, str]], idle_s: float) -> None:
        if idle_s >= IDLE_AFTER_S or fg is None:
            if not (self.open and self.open.kind == "idle"):
                # Idle began idle_s ago, not now — back-date it so the active
                # span before it doesn't swallow the idle time. A locked
                # screen / no foreground window counts as idle from now.
                start = now if fg is None else now - idle_s
                if self.open:
                    start = max(start, self.open.start)
                    self._close(start)
                self.open = OpenSpan("idle", "", "", start)
        else:
            app, title = self.privacy.apply(*fg)
            s = self.open
            if not s or s.kind != "active" or s.app != app or s.title != title:
                self._close(now)
                self.open = OpenSpan("active", app, title, now)
        if self.open and now - self.open.start >= SPLIT_AFTER_S:
            o = self.open
            self._close(now)
            self.open = OpenSpan(o.kind, o.app, o.title, now)

    def focus(self) -> Optional[dict]:
        if self.open and self.open.kind == "active":
            return {"app": self.open.app, "title": self.open.title, "since": iso(self.open.start)}
        return None

    def take(self) -> list[dict]:
        out, self.closed = self.closed, []
        return out

    def stop(self, now: float) -> None:
        self._close(now)


# ---- sending, with an offline spool -----------------------------------------

class Sender:
    """Posts spans; anything that couldn't be sent waits in spool.jsonl and
    goes with the next successful flush (span ids make resends harmless)."""

    def __init__(self, gateway: str, spool: Path, post: Optional[Callable[[str, dict], dict]] = None) -> None:
        self.url = gateway.rstrip("/") + "/desktop/spans"
        self.spool = spool
        self.post = post or self._http_post

    @staticmethod
    def _http_post(url: str, body: dict) -> dict:
        req = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8"))

    def _read_spool(self) -> list[dict]:
        if not self.spool.exists():
            return []
        out = []
        for line in self.spool.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return out

    def _write_spool(self, spans: list[dict]) -> None:
        spans = spans[-SPOOL_MAX_SPANS:]
        if not spans:
            self.spool.unlink(missing_ok=True)
            return
        tmp = self.spool.with_suffix(".tmp")
        tmp.write_text("".join(json.dumps(s) + "\n" for s in spans), encoding="utf-8")
        tmp.replace(self.spool)

    def flush(self, fresh: list[dict], focus: Optional[dict]) -> bool:
        pending = self._read_spool() + fresh
        try:
            for i in range(0, max(len(pending), 1), 500):
                self.post(self.url, {"spans": pending[i:i + 500], "focus": focus})
        except (urllib.error.URLError, OSError, ValueError):
            self._write_spool(pending)
            return False
        self._write_spool([])
        return True


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="agent-os desktop sensor")
    ap.add_argument("--gateway", default=os.environ.get("AGENT_OS_GATEWAY_URL", "http://127.0.0.1:8787"))
    ap.add_argument("--privacy", default=str(HERE / "privacy.json"))
    ap.add_argument("--spool", default=str(HERE / "spool.jsonl"))
    ap.add_argument("--dry-run", action="store_true", help="print spans instead of posting")
    args = ap.parse_args(argv)

    if sys.platform != "win32":
        print("This sensor reads the Windows foreground window; run it on Windows.", file=sys.stderr)
        return 2

    platform = WindowsPlatform()
    tracker = Tracker(Privacy.load(Path(args.privacy)))
    sender = Sender(args.gateway, Path(args.spool))
    last_flush = time.time()
    was_down = False
    print(f"[sensor] watching → {sender.url}{' (dry run)' if args.dry_run else ''}")

    try:
        while True:
            now = time.time()
            tracker.sample(now, platform.foreground(), platform.idle_seconds())
            if now - last_flush >= FLUSH_EVERY_S:
                spans, focus = tracker.take(), tracker.focus()
                if args.dry_run:
                    for s in spans:
                        print(f"  {s['kind']:6} {s['start'][11:19]}–{s['end'][11:19]} {s['app']} {s['title']!r}")
                else:
                    ok = sender.flush(spans, focus)
                    if ok and was_down:
                        print("[sensor] gateway back — spool sent")
                    elif not ok and not was_down:
                        print("[sensor] gateway unreachable — spooling to disk")
                    was_down = not ok
                last_flush = now
            time.sleep(SAMPLE_EVERY_S)
    except KeyboardInterrupt:
        tracker.stop(time.time())
        if not args.dry_run:
            sender.flush(tracker.take(), None)
        print("[sensor] stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
