"""Tests that need no models, mic or speakers: config merging, the utterance segmenter, push-to-talk, routing,
idle unload, the token, hotkey parsing, and speech back's sentence splitting, per-sentence language and playback
queue (with fake voices). Run with the service's venv: python test_voice.py"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voice_service.auth import has_token, load_token  # noqa: E402
from voice_service.config import DEFAULTS, load_config  # noqa: E402
from voice_service.hotkey import parse as parse_hotkey  # noqa: E402
from voice_service.lazy import Lazy  # noqa: E402
from voice_service.router import Router  # noqa: E402
from voice_service.segmenter import HoldRecorder, Segmenter  # noqa: E402
from voice_service.speech import CALIBRATION, SentenceLanguage, SentenceSplitter, Speaker, first_clause, split_sentences  # noqa: E402

import numpy as np  # noqa: E402

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

print("-- idle unload --")
made = []
m = Lazy("fake", lambda: made.append(1) or {"n": len(made)}, idle_s=60, log=lambda _: None)
check(not m.loaded and made == [], "nothing loads until asked")
check(m.run(lambda o: o["n"]) == 1 and m.loaded, "first use loads it")
check(not m.unload_if_idle(now=m.last_used + 59), "kept while used within idle_s")
check(m.unload_if_idle(now=m.last_used + 61) and not m.loaded, "dropped after idle_s without use")
check(m.run(lambda o: o["n"]) == 2 and m.loads == 2, "the next use loads it again")
held = []
m.run(lambda o: held.append(m.unload_if_idle(now=m.last_used + 10_000)))
check(held == [False] and m.loaded, "never dropped while in use")
check(not Lazy("never", dict, idle_s=0).unload_if_idle(now=1e12), "idle_s 0: never unloaded")
m.unload_if_idle(now=m.last_used + 61)
m.prefetch()
for _ in range(100):
    if m.loaded:
        break
    time.sleep(0.01)
check(m.loaded and m.loads == 3, "prefetch() reloads in the background")

print("-- push-to-talk --")
h = HoldRecorder(frame_ms=FRAME_MS)
for i in range(20):
    h.idle([float(i)])
pre = h.press()
check([int(f[0]) for f in pre] == list(range(20 - round(300 / FRAME_MS), 20)), "press hands back the 300 ms pre-roll")
h.set_preroll_probs([0.1] * len(pre))
probs = [0.1] * 10 + [0.9] * 30 + [0.1] * 40  # key down: 320 ms quiet, ~1 s speech, 1.3 s quiet before release
for i, p in enumerate(probs):
    h.push([float(20 + i)], p)
check(h.in_speech and h.speech_ms == round(30 * FRAME_MS), "while held: speech_ms counts speech only")
check(h.start_frame == 20 - len(pre) and int(h.so_far()[0][0]) == h.start_frame, "so_far() starts at the hold's first frame")
u = h.release()
first_speech = 20 + 10
check(u is not None and int(u.frames[0][0]) == first_speech - round(300 / FRAME_MS), "release trims leading quiet to 300 ms before the speech")
check(int(u.frames[-1][0]) == first_speech + 29 + round(150 / FRAME_MS), "…and trailing quiet to 150 ms after it")
check(u.start_frame == 20 - len(pre), "the utterance keeps the hold's start_frame (early language ID matches it)")
check(not h.in_speech and h.release() is None, "released: nothing more until the next press")
h.press()
for p in [0.1] * 20 + [0.9] * 5:
    h.push([0.0], p)
check(h.release() is None, "a hold with 160 ms of speech (under 250 ms) gives no utterance")
h2 = HoldRecorder(frame_ms=FRAME_MS)
h2.press()
h2.set_preroll_probs([])
for _ in range(10):
    h2.push([0.0], 0.95)
check(h2.release() is not None, "speech from the first frame (nothing to trim before it)")

print("-- auth --")
check(has_token("Bearer s3cret-token-0123456789", "s3cret-token-0123456789"), "the right token passes")
check(has_token("bearer   s3cret-token-0123456789 ", "s3cret-token-0123456789"), "scheme case and spaces don't matter")
check(not has_token("Bearer wrong", "s3cret-token-0123456789") and not has_token(None, "x" * 20) and not has_token("s3cret-token-0123456789", "s3cret-token-0123456789"), "wrong, missing, or without 'Bearer': refused")
with tempfile.TemporaryDirectory() as d:
    f = Path(d) / "data" / "gateway-token"
    saved = os.environ.pop("AGENT_OS_GATEWAY_TOKEN", None)
    try:
        t1, src1 = load_token(f)
        t2, src2 = load_token(f)
        check(len(t1) >= 16 and f.read_text().strip() == t1 and src1.endswith("(new)"), "no token yet: one is made and saved where the gateway keeps it")
        check(t2 == t1 and not src2.endswith("(new)"), "the next start reads the same one")
        os.environ["AGENT_OS_GATEWAY_TOKEN"] = "from-the-environment-123"
        check(load_token(f)[0] == "from-the-environment-123", "AGENT_OS_GATEWAY_TOKEN wins over the file")
    finally:
        os.environ.pop("AGENT_OS_GATEWAY_TOKEN", None)
        if saved is not None:
            os.environ["AGENT_OS_GATEWAY_TOKEN"] = saved

print("-- speech back: sentences --")
check(split_sentences("Hello there, how are you? I'm fine. Thanks.") == ["Hello there, how are you?", "I'm fine. Thanks."], "split at sentence ends; a fragment under 4 words at the end joins the one before")
check(split_sentences("Ok. The masters are ready on Thursday.") == ["Ok. The masters are ready on Thursday."], "a short fragment waits and joins the next sentence")
check(split_sentences("Version 2.5 is out now, finally!") == ["Version 2.5 is out now, finally!"], "no split inside a number")
check(split_sentences("Første linje kommer her\nAndre linje kommer etterpå") == ["Første linje kommer her", "Andre linje kommer etterpå"], "a newline ends a sentence")
check(first_clause("The mastering engineer says, after a long talk, that Thursday works.") == ["The mastering engineer says,", "after a long talk, that Thursday works."], "a reply's first sentence starts with its first clause")
check(first_clause("Ok, that works for me.") == ["Ok, that works for me."] and first_clause("No comma in this one at all") == ["No comma in this one at all"], "…only when the clause is 4+ words and 3+ follow")
sp = SentenceSplitter()
got = sp.feed("Singelen kommer fø") + sp.feed("rst, to uker før albumet. Cove")
check(got == ["Singelen kommer først, to uker før albumet."], "streamed: a sentence comes out as soon as it ends")
check(sp.feed("ret må være ferdig") == [] and sp.flush() == ["Coveret må være ferdig"], "…and the rest at the end")

fake = {"The masters will be ready on Thursday.": ("en", 0.99), "Kan du sjekke at alt er klart?": ("no", 0.7), "Dette er kanskje dansk tekst her.": ("da", 0.9), "Something unsure but long enough.": ("en", 0.4)}
lang = SentenceLanguage(lambda s: fake.get(s, ("en", 0.99)))
check(lang("Kan du sjekke at alt er klart?") == "no", "Norwegian sentence → no")
check(lang("The masters will be ready on Thursday.") == "en", "English sentence → en")
check(lang("Ok, takk.") == "en", "under 5 words: keeps the previous sentence's language")
check(lang("Something unsure but long enough.") == "en", "unsure (< 0.6): keeps the previous language")
check(lang("Dette er kanskje dansk tekst her.") == "no", "Danish/Swedish/other → the Norwegian voice")
check(lang("The masters will be ready on Thursday.", forced="no") == "no", "a forced language wins")
check(SentenceLanguage(None)("Whatever this says, it is long.") == "no", "no language ID: the default (no)")

print("-- speech back: playback queue --")


class FakeVoice:
    def __init__(self, name, seconds, delay=0.0):
        self.name, self.seconds, self.delay, self.said = name, seconds, delay, []

    def run(self, fn):
        return fn(self)

    def synthesize(self, text):
        time.sleep(self.delay)
        self.said.append(text)
        return np.full(int(24000 * self.seconds), 0.3, np.float32)


events = []
en, no = FakeVoice("kokoro", 0.2), FakeVoice("piper", 0.3)
spk = Speaker({"en": en, "no": no}, SentenceLanguage(lambda s: ("en", 0.99) if "English" in s else ("no", 0.99)), emit=events.append, play=False)
spk.say(["This one is English, clearly.", "Denne er norsk, helt klart.", "And English once more here."])
time.sleep(0.3)  # synthesis runs ahead of playback
played = np.concatenate([spk.next_block(480) for _ in range(60)])  # 1.2 s, 20 ms blocks
voiced = np.flatnonzero(played)
check(en.said == ["This one is English, clearly.", "And English once more here."] and no.said == ["Denne er norsk, helt klart."], "each sentence goes to its language's voice")
check(voiced.size > 0 and voiced[-1] - voiced[0] + 1 == voiced.size, "no gap between sentences (or engines) once they're made ahead")
kinds = [e["type"] for e in events]
check(kinds[0] == "speak_start" and kinds.count("sentence") == 3 and kinds[-1] == "speak_end" and not spk.speaking, "speak_start, a sentence event each, speak_end when done")
check([e["engine"] for e in events if e["type"] == "sentence"] == ["kokoro", "piper", "kokoro"], "sentence events name the engine")

events.clear()
spk.say(["Denne setningen er lang nok til å stoppes."] * 3)
time.sleep(0.2)
spk.next_block(480)
check(spk.speaking, "speaking again")
check(spk.stop("barge_in") and not np.any(spk.next_block(480)), "stop(): the very next 20 ms block is silent")
time.sleep(0.2)
check(not np.any(np.concatenate([spk.next_block(480) for _ in range(20)])), "…and nothing queued plays after it")
check(events[-1]["type"] == "speak_end" and events[-1]["reason"] == "barge_in", "speak_end says why (barge_in)")

slow = FakeVoice("piper", 0.2, delay=0.05)
events.clear()
spk2 = Speaker({"no": slow}, SentenceLanguage(None), emit=events.append, play=False)
spk2.say(["En setning som tar tid å lage.", "Og en til som også tar tid."])
time.sleep(0.08)
for _ in range(30):
    spk2.next_block(480)
time.sleep(0.1)
for _ in range(30):
    spk2.next_block(480)
check([e["type"] for e in events].count("speak_end") == 1, "a sentence still being made doesn't end the speech early")
check(Speaker({"no": slow}, SentenceLanguage(None), play=False).engine_for("en") is slow, "no English voice: the Norwegian one speaks it")


class FakeStreamer(FakeVoice):
    """Like Phonon 31M: stream() yields 80 ms chunks, a little slower than instantly."""

    streams = True

    def __init__(self, name, chunks):
        super().__init__(name, 0.08)
        self.chunks, self.made, self.closed = chunks, 0, False

    def stream(self, text, keep_going=lambda: True):
        self.said.append(text)
        try:
            for _ in range(self.chunks):
                time.sleep(0.005)
                self.made += 1
                yield np.full(1920, 0.3, np.float32)
                if not keep_going():
                    break
        finally:
            self.closed = True


events.clear()
st = FakeStreamer("phonon-31m", chunks=10)
spk3 = Speaker({"en": st}, SentenceLanguage(None, default="en"), emit=events.append, play=False, quick_start=False)
spk3.say(["The masters will be ready on Thursday, after the label signs off."])
time.sleep(0.03)
first_block = spk3.next_block(480)
check(np.any(first_block), "a streamed sentence starts playing before it's all made")
time.sleep(0.15)
played = np.concatenate([first_block] + [spk3.next_block(480) for _ in range(60)])
voiced = np.flatnonzero(played)
check(voiced.size == 10 * 1920 and voiced[-1] - voiced[0] + 1 == voiced.size, "…all its chunks play back to back, nothing lost, no gap")
check([s for s in st.said if s != CALIBRATION] == ["The masters will be ready on Thursday, after the label signs off."], "quick_start off: a streaming engine gets the whole sentence (no first-clause split)")
check(CALIBRATION in st.said and st.said.count(CALIBRATION) == 1, "a streaming voice's loudness is measured once, on a calibration sentence")
kinds = [e["type"] for e in events]
check(kinds.count("sentence") == 1 and kinds.count("speak_end") == 1 and kinds[-1] == "speak_end", "one sentence event per sentence, however many chunks; speak_end after the last")

events.clear()
long = FakeStreamer("phonon-31m", chunks=500)
spk4 = Speaker({"en": long}, SentenceLanguage(None, default="en"), emit=events.append, play=False, quick_start=False)
spk4.say(["A very long sentence that will be cut off by pressing push-to-talk."])
time.sleep(0.05)
spk4.next_block(480)
spk4.stop("barge_in")
time.sleep(0.1)
check(long.closed and long.made < 500, f"barge-in stops a stream mid-sentence (made {long.made} of 500 chunks, then closed)")
check(not np.any(np.concatenate([spk4.next_block(480) for _ in range(10)])), "…and nothing of it plays after the stop")

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
