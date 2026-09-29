"""
Tests for the desktop sensor's pure parts (privacy, span tracking, the
offline spool) plus, if a gateway URL is given, a live end-to-end post.

    python test_sensor.py
    python test_sensor.py http://127.0.0.1:8787   # also posts to a real gateway
"""

import json
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sensor  # noqa: E402
from sensor import Privacy, Sender, Tracker  # noqa: E402

failed = False


def check(cond: bool, msg: str) -> None:
    global failed
    print(("ok: " if cond else "FAIL: ") + msg)
    failed |= not cond


priv = Privacy.load(Path(__file__).resolve().parent / "privacy.example.json")

# ---- privacy
check(priv.apply("KeePassXC.exe", "Database.kdbx") == ("(private)", ""), "a skipped app is only '(private)'")
check(priv.apply("msedge.exe", "InPrivate - Microsoft Edge") == ("(private)", ""), "a private-browsing title hides the window")
check(priv.apply("OUTLOOK.EXE", "Re: lønn - gylve@example.com") == ("OUTLOOK.EXE", ""), "mail keeps the app, never the title")
app, title = priv.apply("chrome.exe", "Mail to ola.nordmann@example.no - 12345678901 - Chrome")
check("@" not in title and "12345678901" not in title, f"emails and 11-digit numbers are redacted from kept titles ({title!r})")
check(priv.apply("Code.exe", "desktop.ts - agent-os") == ("Code.exe", "desktop.ts - agent-os"), "ordinary titles pass through")

# ---- tracker
T0 = 1_800_000_000.0
t = Tracker(priv)
for i in range(10):
    t.sample(T0 + i, ("Code.exe", "a.ts"), 0)
t.sample(T0 + 10, ("Code.exe", "b.ts"), 0)
spans = t.take()
check(len(spans) == 1 and spans[0]["title"] == "a.ts", "a window change closes the previous span")
check(t.focus()["title"] == "b.ts", "focus reports the window in front")

t = Tracker(priv)
for i in range(125):
    t.sample(T0 + i, ("FL64.exe", "beat.flp"), 0)
spans = t.take()
check(len(spans) == 2 and all(s["kind"] == "active" for s in spans), f"a long span is split every {int(sensor.SPLIT_AFTER_S)}s (crash loses ≤1 min)")

t = Tracker(priv)
for i in range(30):
    t.sample(T0 + i, ("Code.exe", "a.ts"), 0)
# 150 s later the machine reports 150 s idle → idle started at T0+30.
t.sample(T0 + 180, ("Code.exe", "a.ts"), 150)
spans = t.take()
active = [x for x in spans if x["kind"] == "active"]
idle = [x for x in spans if x["kind"] == "idle"] + ([{"start": sensor.iso(t.open.start)}] if t.open and t.open.kind == "idle" else [])
check(active and active[-1]["end"] == sensor.iso(T0 + 30), "idle is back-dated: the active span ends when input stopped, not when idle was noticed")
check(idle and idle[0]["start"] == sensor.iso(T0 + 30), "the idle time starts at that same moment")
t.sample(T0 + 181, ("Code.exe", "a.ts"), 0)
spans = t.take()
check(spans and spans[-1]["kind"] == "idle", "coming back closes the idle span")

t = Tracker(priv)
t.sample(T0, ("Code.exe", "a.ts"), 0)
t.sample(T0 + 5, None, 0)
check(t.take()[-1]["kind"] == "active" and t.open.kind == "idle", "no foreground window (locked screen) counts as idle")

# ---- spool
with tempfile.TemporaryDirectory() as d:
    spool = Path(d) / "spool.jsonl"
    calls = []

    def down(url, body):
        raise urllib.error.URLError("refused")

    s = Sender("http://x", spool, post=down)
    check(not s.flush([{"id": "a"}, {"id": "b"}], None), "a failed flush reports failure")
    check(spool.exists() and len(spool.read_text().splitlines()) == 2, "…and keeps the spans in the spool")

    s = Sender("http://x", spool, post=lambda u, b: calls.append(b) or {"stored": len(b["spans"])})
    check(s.flush([{"id": "c"}], {"app": "x"}), "the next flush succeeds")
    check([x["id"] for x in calls[0]["spans"]] == ["a", "b", "c"], "spooled spans go first, in order")
    check(not spool.exists(), "the spool is cleared after a successful send")

# ---- live gateway (optional)
if len(sys.argv) > 1:
    gw = sys.argv[1].rstrip("/")
    t = Tracker(priv)
    base = __import__("time").time() - 600
    for i in range(0, 90):
        t.sample(base + i, ("FL64.exe", "Sinnsyk.flp - FL Studio"), 0)
    t.sample(base + 90, ("KeePassXC.exe", "secrets.kdbx"), 0)
    t.sample(base + 95, ("Code.exe", "desktop.ts - agent-os - Visual Studio Code"), 0)
    with tempfile.TemporaryDirectory() as d:
        ok = Sender(gw, Path(d) / "spool.jsonl").flush(t.take(), t.focus())
    check(ok, "posted to the live gateway")
    summary = json.loads(urllib.request.urlopen(gw + "/desktop/summary").read())
    print("\n" + summary["digest"] + "\n")
    apps = {a["app"] for a in summary["summary"]["byApp"]}
    check("FL64.exe" in apps and "(private)" in apps and "KeePassXC.exe" not in apps, "the gateway saw FL Studio and '(private)', never the password manager's name")
    now = json.loads(urllib.request.urlopen(gw + "/desktop/now").read())
    check(now["focus"]["app"] == "Code.exe", "the gateway knows what's in front right now")

print("\nAll sensor tests passed." if not failed else "\nSome sensor tests FAILED.")
sys.exit(1 if failed else 0)
