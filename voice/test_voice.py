"""Tests that need no models or mic: config merging, the utterance segmenter, routing and hotkey parsing.
Run: python test_voice.py   (stdlib only)"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voice_service.config import DEFAULTS, load_config  # noqa: E402
from voice_service.hotkey import parse as parse_hotkey  # noqa: E402
from voice_service.router import Router  # noqa: E402
from voice_service.segmenter import Segmenter  # noqa: E402

failed = False


def check(cond: bool, msg: str) -> None:
    global failed
    print(("ok: " if cond else "FAIL: ") + msg)
    failed |= not cond


FRAME_MS = 32.0


def run(probs: list[float], **kw):
    seg = Segmenter(frame_ms=FRAME_MS, **kw)
    events = []
    for i, p in enumerate(probs):
        ev, utt = seg.push([float(i)], p)  # the frame carries its own index, so we can see which were kept
        if ev:
            events.append((i, ev, utt))
    return events


def frames(utt) -> list[int]:
    return [int(f[0]) for f in utt.frames]


print("-- segmenter --")
# 20 frames quiet, 20 frames (640 ms) speech, 25 frames (800 ms) quiet
probs = [0.1] * 20 + [0.9] * 20 + [0.1] * 25
ev = run(probs)
check([e[1] for e in ev] == ["speech_start", "speech_end"], "one utterance: start, then end")
start, end = ev[0], ev[1]
check(start[0] == 20, "speech starts on the first loud frame")
utt = end[2]
check(utt is not None and frames(utt)[0] == 20 - round(300 / FRAME_MS), "the 300 ms pre-roll before onset is kept")
check(end[0] == 39 + round(600 / FRAME_MS), "the utterance closes after 600 ms of silence")
check(frames(utt)[-1] == 39 + round(150 / FRAME_MS), "only 150 ms of trailing silence is kept")

ev = run([0.1] * 5 + [0.9] * 4 + [0.1] * 30)
check(len(ev) == 2 and ev[1][2] is None, "128 ms of speech (under 250 ms) ends without an utterance")

# a dip to 0.4 (above threshold - 0.15) inside speech doesn't count as silence
ev = run([0.9] * 10 + [0.4] * 25 + [0.9] * 10 + [0.1] * 25)
check([e[1] for e in ev] == ["speech_start", "speech_end"], "a dip within the hysteresis band keeps one utterance")

# a 400 ms pause (under 600 ms) inside an utterance doesn't split it
ev = run([0.9] * 15 + [0.1] * 12 + [0.9] * 15 + [0.1] * 25)
check(sum(1 for e in ev if e[1] == "speech_end") == 1, "a 384 ms pause doesn't split the utterance")

# two utterances separated by a long pause
ev = run([0.9] * 15 + [0.1] * 30 + [0.9] * 15 + [0.1] * 30)
ends = [e for e in ev if e[1] == "speech_end"]
check(len(ends) == 2 and all(e[2] is not None for e in ends), "two utterances after a long pause")
check(frames(ends[1][2])[0] < 45 and frames(ends[1][2])[0] >= 45 - round(300 / FRAME_MS), "the second one has its own pre-roll")

ev = run([0.9] * 10)
check([e[1] for e in ev] == ["speech_start"], "speech still going at the end of input: no end event yet")

print("-- speculation --")
# 20 speech frames, then silence: pause at 250 ms (8 frames of 32 ms), end at 600 ms (19 frames)
ev = run([0.1] * 5 + [0.9] * 20 + [0.1] * 25, speculative_ms=250)
kinds = [e[1] for e in ev]
check(kinds == ["speech_start", "pause", "speech_end"], "silence gives a pause at 250 ms before the end at 600 ms")
pause, end = ev[1], ev[2]
check(pause[0] == 24 + 8 and end[0] == 24 + 19, "the pause comes at 256 ms of silence, the end at 608 ms")
check(pause[2] is not None and (pause[2].start_frame, pause[2].end_frame) == (end[2].start_frame, end[2].end_frame), "the pause's utterance is cut exactly like the end's, so its result can be used")
check(frames(pause[2]) == frames(end[2]), "…same frames")

ev = run([0.9] * 20 + [0.1] * 10 + [0.9] * 10 + [0.1] * 25, speculative_ms=250)
kinds = [e[1] for e in ev]
check(kinds == ["speech_start", "pause", "resume", "pause", "speech_end"], "speech after a pause gives resume, then a new pause")
first_pause, last_pause, end = ev[1][2], ev[3][2], ev[4][2]
check((first_pause.start_frame, first_pause.end_frame) != (end.start_frame, end.end_frame), "the first pause doesn't match the final utterance (it would miss the second part)")
check((last_pause.start_frame, last_pause.end_frame) == (end.start_frame, end.end_frame), "the last pause does")

ev = run([0.1] * 5 + [0.9] * 4 + [0.1] * 30, speculative_ms=250)
check([e[1] for e in ev] == ["speech_start", "pause", "speech_end"] and ev[1][2] is None and ev[2][2] is None, "too-short speech: the pause carries no utterance either")

ev = run([0.9] * 20 + [0.1] * 25)
check("pause" not in [e[1] for e in ev], "speculative_ms 0 (the default for the class): no pause events")

seg = Segmenter(frame_ms=FRAME_MS)
for i, p in enumerate([0.1] * 12 + [0.9] * 40):
    seg.push([float(i)], p)
check(seg.speech_ms == round(40 * FRAME_MS), "speech_ms counts the speech so far while it goes on")
check(seg.start_frame == 12 - round(300 / FRAME_MS) and [int(f[0]) for f in seg.so_far()][0] == seg.start_frame, "so_far() starts at start_frame, pre-roll included")
check(int(seg.so_far()[-1][0]) == 51, "…and runs to the latest frame")
for p in [0.1] * 25:
    seg.push([0.0], p)
check(seg.speech_ms == 0, "speech_ms is 0 once the utterance has closed")

print("-- routing --")
r = Router()
check(r.before_detection(0) is None, "auto with an English engine: language ID decides")
check(r.decide("en", 0.95).engine == "en", "English at 0.95 → English engine")
check(r.decide("en", 0.79).engine == "no", "English below 0.80 → NB-Whisper (unsure goes to NB)")
check(r.decide("no", 0.99).engine == "no" and r.decide("nn", 0.6).engine == "no", "Norwegian → NB-Whisper")
check(r.decide("da", 0.9).engine == "no" and r.decide("de", 0.5).engine == "no", "other languages → NB-Whisper")

r.remember(r.decide("en", 0.95), now=100.0)
s = r.before_detection(110.0)
check(s is not None and s.engine == "en" and s.reason == "sticky", "within 20 s of a sure detection: reuse it, no language ID")
r.remember(s, now=115.0)
check(r.before_detection(121.0) is None, "a sticky reuse doesn't extend the window: 20 s from the detection, then detect again")
r.remember(r.decide("en", 0.85), now=200.0)
check(r.before_detection(201.0) is None, "a detection under 0.90 doesn't stick")
r.remember(r.decide("no", 0.97), now=300.0)
check(r.before_detection(301.0).engine == "no", "Norwegian sticks too")

check(r.set_mode("en") == "en" and r.before_detection(0).reason == "forced" and r.before_detection(0).engine == "en", "mode en forces English")
check(r.before_detection(305.0).reason == "forced", "a forced mode wins over sticky")
check([r.next_mode(), r.next_mode(), r.next_mode()] == ["auto", "no", "en"], "the hotkey cycles en → auto → no → en")
check(r.set_mode("auto") and r.before_detection(301.0) is None, "changing mode clears the sticky language")
try:
    r.set_mode("de")
    check(False, "an unknown mode is refused")
except ValueError:
    check(True, "an unknown mode is refused")

r = Router(has_en=False)
check(r.before_detection(0).engine == "no" and r.before_detection(0).reason == "no-english-engine", "no English engine: everything to NB-Whisper")
r.set_mode("en")
check(r.before_detection(0).engine == "no", "…even with mode en")

print("-- hotkey --")
check(parse_hotkey("ctrl+alt+l") == (0x2 | 0x1, ord("L")), "ctrl+alt+l parses")
check(parse_hotkey("Ctrl + Shift + F9") == (0x2 | 0x4, 0x78), "case, spaces and F-keys")
for bad in ("l", "ctrl+alt+", "hyper+l", "ctrl+alt+space"):
    try:
        parse_hotkey(bad)
        check(False, f"{bad!r} is refused")
    except ValueError:
        check(True, f"{bad!r} is refused")

print("-- config --")
cfg = load_config(Path(tempfile.gettempdir()) / "does-not-exist.yaml")
check(cfg == DEFAULTS, "no file: the defaults")
check(cfg["tts"]["enabled"] is False, "speech back is off by default")
check(cfg["server"]["host"] == "127.0.0.1", "local only by default")
try:
    import yaml  # noqa: F401

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "voice.yaml"
        p.write_text("vad:\n  min_silence_ms: 500\ntts:\n  enabled: true\n", encoding="utf-8")
        c = load_config(p)
        check(c["vad"]["min_silence_ms"] == 500 and c["vad"]["threshold"] == 0.5, "a file overrides one key and keeps the rest")
        check(c["tts"]["enabled"] is True and c["tts"]["en"]["voice"] == DEFAULTS["tts"]["en"]["voice"], "nested overrides merge")
        check(DEFAULTS["vad"]["min_silence_ms"] == 600, "loading a file doesn't change the defaults")
except ImportError:
    print("skip: pyyaml not installed (file overrides)")

print("\nSOME TESTS FAILED" if failed else "\nall voice tests passed")
sys.exit(1 if failed else 0)
