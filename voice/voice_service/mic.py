"""The always-open mic: 16 kHz mono, 32 ms frames → Silero VAD → Segmenter → one transcription at a time.

Events go to every subscriber as dicts: speech_start, speech_end, final (text + language, engine,
confidence, timings). The audio never goes anywhere but the transcriber; nothing is stored.

Speculative transcription (phase 4): at `speculative_ms` of silence the utterance so far is queued for
transcription. If the silence lasts to `min_silence_ms`, that same utterance is final and its text is usually
ready already; if speech comes back, the result is thrown away. A job already running can't be stopped, so a
stale one finishes and is dropped; a stale one still waiting is removed. Utterances that are final are never
dropped from the queue.

Routing (phase 2): once `lang_id.after_ms` of speech is in, language ID runs on its own thread while you're
still talking, so its answer is usually there before the utterance ends. The transcription job then goes to
the engine the router picks (stt.py). A forced mode or a sticky language skips language ID altogether.

Push-to-talk (phase 6, mic.trigger: push_to_talk, the default): only what you say while the key (Ctrl+Alt+B)
is held is transcribed; between holds the VAD doesn't run and frames only fill the 300 ms pre-roll. Release
ends the utterance at once (no silence window). mic.trigger: always is the open mic of phases 1–4.

English partials (mic.partials): while push-to-talk is held and early language ID says English (or the mode is
en), the hold so far is re-transcribed with the English engine every `partial_ms` and sent as `partial` events,
so the HUD can show the words as they're spoken. One run at a time: a tick is skipped while the last one is
still going, and they stop growing after `partial_max_s` (each run re-reads the whole hold). None for Norwegian:
NB-Whisper is too slow to run twice a second. The final always replaces them.
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np

from .engines import Transcript
from .router import Route
from .segmenter import HoldRecorder, Segmenter, Utterance
from .stt import Detection, SpeechToText
from .vad import SileroVad

Listener = Callable[[dict[str, Any]], None]

PRESS, RELEASE = "ptt-press", "ptt-release"  # markers in the frame queue, so a release is handled after its last frame


@dataclass
class Job:
    key: tuple[int, int]
    audio: np.ndarray
    stopped: float  # when the speaker stopped (wall clock), for the latency figure
    speculative: bool
    final: bool = False
    stale: bool = False
    done: bool = False
    emitted: bool = False
    transcript: Optional[Transcript] = None
    route: Optional[Route] = None
    detection: Optional[Detection] = None
    early: bool = False  # the detection came from early language ID
    error: Optional[str] = None
    created: float = field(default_factory=time.time)


@dataclass
class LangJob:
    """Early language ID for one utterance (by its start frame)."""

    start: int
    audio: np.ndarray
    ready: threading.Event = field(default_factory=threading.Event)
    detection: Optional[Detection] = None


class MicListener:
    def __init__(self, cfg: dict[str, Any], vad: SileroVad, stt: SpeechToText) -> None:
        a, v = cfg["audio"], cfg["vad"]
        self._rate = a["sample_rate"]
        self._frame = a["frame_samples"]
        self._device = a["input_device"]
        self._vad = vad
        self._stt = stt
        self._seg = Segmenter(
            frame_ms=1000 * self._frame / self._rate,
            threshold=v["threshold"],
            min_silence_ms=v["min_silence_ms"],
            speech_pad_ms=v["speech_pad_ms"],
            preroll_ms=v["preroll_ms"],
            min_speech_ms=v["min_speech_ms"],
            speculative_ms=v["speculative_ms"] if v["speculative_ms"] < v["min_silence_ms"] else 0,
        )
        m = cfg["mic"]
        self.trigger = m.get("trigger", "always")
        if self.trigger not in ("always", "push_to_talk"):
            raise ValueError(f"mic.trigger is {self.trigger!r}: always or push_to_talk")
        self._hold = HoldRecorder(
            frame_ms=1000 * self._frame / self._rate,
            threshold=v["threshold"],
            speech_pad_ms=v["speech_pad_ms"],
            preroll_ms=v["preroll_ms"],
            min_speech_ms=v["min_speech_ms"],
        )
        self._hold_max_ms = 1000 * m.get("ptt_max_s", 120)
        self.held = False
        self._hold_id = 0  # bumped on every press, so a partial finishing after its release is dropped
        self._partials = bool(m.get("partials", True))
        self._partial_s = m.get("partial_ms", 500) / 1000
        self._partial_max = int(m.get("partial_max_s", 10) * self._rate)
        self._frames: "queue.Queue[Any]" = queue.Queue(maxsize=200)
        self._jobs: deque[Job] = deque()
        self._lang_after_ms = cfg["lang_id"]["after_ms"]
        self._lang: Optional[LangJob] = None  # the current utterance's early language ID
        self._lang_queue: "queue.Queue[LangJob]" = queue.Queue(maxsize=1)
        self._lock = threading.Lock()
        self._wake = threading.Condition(self._lock)
        self._spec: Optional[Job] = None
        self._listeners: list[Listener] = []
        self._stop = threading.Event()
        self._stream = None
        self.muted = False
        self.device_name: str | None = None
        self.dropped_frames = 0
        self.stats = {"finals": 0, "speculative_used": 0, "speculative_wasted": 0}
        self.routes = {"no": 0, "en": 0, "early_lang_id": 0, "late_lang_id": 0, "sticky": 0, "forced": 0}
        self.partial_stats = {"sent": 0, "runs": 0, "skipped_busy": 0}

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn) if fn in self._listeners else None

    def _emit(self, event: dict[str, Any]) -> None:
        for fn in list(self._listeners):
            try:
                fn(event)
            except Exception as err:  # one broken subscriber must not stop the mic
                print(f"[voice] listener failed: {err}")

    def feed(self, frame: np.ndarray) -> None:
        """One frame of audio: from the sound card, or from replay.py."""
        try:
            self._frames.put_nowait(frame)
        except queue.Full:
            self.dropped_frames += 1

    def ptt(self, down: bool) -> None:
        """The push-to-talk key went down or up (the hotkey thread, or POST /v1/control)."""
        if self.trigger != "push_to_talk" or down == self.held:
            return
        self.held = down
        try:
            self._frames.put(PRESS if down else RELEASE, timeout=1.0)
        except queue.Full:
            self.dropped_frames += 1

    def start(self, use_device: bool = True) -> None:
        if use_device:
            import sounddevice as sd

            def on_audio(indata, frames, _time, status) -> None:
                if status:
                    self.dropped_frames += 1
                self.feed(indata[:, 0].copy())

            self._stream = sd.InputStream(
                samplerate=self._rate, channels=1, dtype="float32", blocksize=self._frame, device=self._device, callback=on_audio
            )
            self.device_name = str(sd.query_devices(self._stream.device, "input")["name"])
            self._stream.start()
        threading.Thread(target=self._vad_loop, name="voice-vad", daemon=True).start()
        threading.Thread(target=self._stt_loop, name="voice-stt", daemon=True).start()
        threading.Thread(target=self._lang_loop, name="voice-langid", daemon=True).start()
        if self._partials and self.trigger == "push_to_talk" and self._stt.en is not None:
            threading.Thread(target=self._partial_loop, name="voice-partials", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        with self._wake:
            self._wake.notify_all()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()

    # ── VAD side ────────────────────────────────────────────────────────────

    def _vad_loop(self) -> None:
        silence_s = self._seg.min_silence_ms / 1000
        spec_s = self._seg.speculative_ms / 1000
        while not self._stop.is_set():
            try:
                frame = self._frames.get(timeout=0.5)
            except queue.Empty:
                continue
            if self.trigger == "push_to_talk":
                self._hold_step(frame)
                continue
            if self.muted:
                continue
            event, utt = self._seg.push(frame, self._vad(frame))
            now = time.time()
            self._maybe_detect_early(self._seg, now)
            if event == "speech_start":
                self._stt.prefetch()  # after an idle unload, reload while the speaker talks
                self._emit({"type": "speech_start", "t": now})
            elif event == "pause":
                if utt is not None:
                    self._submit(Job(key=_key(utt), audio=_audio(utt), stopped=now - spec_s, speculative=True))
            elif event == "resume":
                self._drop_speculation()
            elif event == "speech_end":
                self._emit({"type": "speech_end", "t": now, "kept": utt is not None})
                if utt is None:
                    self._drop_speculation()
                else:
                    self._finalize(utt, stopped=now - silence_s)
                self._vad.reset()

    def _hold_step(self, item: Any) -> None:
        hold = self._hold
        now = time.time()
        if isinstance(item, str):
            if item == PRESS and not self.muted:
                self._hold_id += 1
                self._vad.reset()
                hold.set_preroll_probs([self._vad(f) for f in hold.press()])
                self._stt.prefetch()  # after an idle unload, reload while the speaker talks
                self._emit({"type": "ptt_start", "t": now})
            elif item == RELEASE and hold.in_speech:
                self._release_hold(now)
            return
        if not hold.in_speech:
            hold.idle(item)
            return
        hold.push(item, self._vad(item))
        self._maybe_detect_early(hold, now)
        if hold.held_ms >= self._hold_max_ms:  # a key stuck down mustn't record forever
            self.held = False
            self._release_hold(now)

    def _release_hold(self, now: float) -> None:
        utt = self._hold.release()
        self._vad.reset()
        self._emit({"type": "ptt_end", "t": now, "kept": utt is not None})
        if utt is not None:
            self._submit(Job(key=_key(utt), audio=_audio(utt), stopped=now, speculative=False, final=True))

    # ── English partials ───────────────────────────────────────────────────

    def partials_on(self) -> bool:
        """Partials for the current hold: mode en, or early language ID sure it's English. Never for Norwegian."""
        r = self._stt.router
        if r.mode != "auto" or not r.has_en:
            return r.mode == "en" and r.has_en
        early = self._lang
        if early is None or early.start != self._hold.start_frame or not early.ready.is_set() or early.detection is None:
            return False
        return early.detection.language == "en" and early.detection.prob >= r.en_threshold

    def _partial_loop(self) -> None:
        last_text, last_hold, n = "", 0, 0
        min_samples = self._rate // 2
        while not self._stop.wait(self._partial_s):
            hold_id = self._hold_id
            if hold_id != last_hold:
                last_text, last_hold, n = "", hold_id, 0
            if not self._hold.in_speech or not self.partials_on():
                continue
            frames = self._hold.so_far()
            if not min_samples <= len(frames) * self._frame <= self._partial_max:
                continue  # too little yet, or past partial_max_s: each run re-reads the whole hold, so cost grows
            audio = np.concatenate([np.asarray(f, dtype=np.float32) for f in frames])
            started = time.perf_counter()
            try:
                t = self._stt.en.run(lambda m: m.transcribe(audio))
            except Exception as err:
                print(f"[voice] partial failed: {err}")
                continue
            self.partial_stats["runs"] += 1
            took = time.perf_counter() - started
            if took > self._partial_s:
                self.partial_stats["skipped_busy"] += int(took // self._partial_s)  # ticks that passed while it ran
            if hold_id != self._hold_id or not self._hold.in_speech or not t.text or t.text == last_text:
                continue  # released meanwhile (the final is coming), or nothing new
            last_text, n = t.text, n + 1
            self.partial_stats["sent"] += 1
            self._emit({"type": "partial", "text": t.text, "n": n, "language": "en", "audio_s": round(audio.size / self._rate, 2), "transcribe_ms": round(took * 1000)})

    # ── language ID side ───────────────────────────────────────────────────

    def _maybe_detect_early(self, seg: Any, now: float) -> None:
        """Once enough speech is in, hand the utterance so far to language ID (once per utterance)."""
        if not seg.in_speech or seg.speech_ms < self._lang_after_ms:
            return
        if self._lang is not None and self._lang.start == seg.start_frame:
            return
        if self._stt.router.before_detection(now) is not None:
            return  # forced, sticky, or no English engine: nothing to detect
        job = LangJob(start=seg.start_frame, audio=np.concatenate([np.asarray(f, dtype=np.float32) for f in seg.so_far()]))
        self._lang = job
        try:
            self._lang_queue.get_nowait()  # an older utterance's job still waiting: this one replaces it
        except queue.Empty:
            pass
        self._lang_queue.put_nowait(job)

    def _lang_loop(self) -> None:
        while not self._stop.is_set():
            try:
                job = self._lang_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                job.detection = self._stt.detect(job.audio)
            except Exception as err:
                print(f"[voice] language ID failed: {err}")
            job.ready.set()

    def _route(self, job: Job) -> tuple[Route, Optional[Detection]]:
        """The engine for a transcription job: the early language ID for its utterance when there is one (waiting
        for it if it's still running; it takes ~60 ms), else forced/sticky, else language ID now."""
        early = self._lang
        detection = None
        if early is not None and early.start == job.key[0] and early.ready.wait(timeout=2.0):
            detection = early.detection
            # ~1 s is often enough, but not always ("What's on my…" came back Malay 0.80): an unsure early guess is
            # checked again on the whole utterance, if there is clearly more of it now.
            if detection is not None and detection.prob < self._stt.router.sticky_conf and job.audio.size > early.audio.size + self._rate // 2:
                detection = None
        job.early = detection is not None
        return self._stt.route(job.audio, detection)

    def set_mode(self, mode: str) -> str:
        m = self._stt.router.set_mode(mode) if mode != "next" else self._stt.router.next_mode()
        print(f"[voice] mode: {m}")
        self._emit({"type": "mode", "mode": m})
        return m

    def _submit(self, job: Job) -> None:
        with self._wake:
            if job.speculative:
                self._mark_stale(self._spec)
                self._spec = job
            # Waiting stale speculative jobs make way; final ones always stay.
            self._jobs = deque(j for j in self._jobs if not j.stale)
            self._jobs.append(job)
            self._wake.notify()

    def _drop_speculation(self) -> None:
        with self._wake:
            self._mark_stale(self._spec)
            self._spec = None
            self._jobs = deque(j for j in self._jobs if not j.stale)

    def _mark_stale(self, job: Optional[Job]) -> None:
        if job is not None and not job.final and not job.stale:
            job.stale = True
            self.stats["speculative_wasted"] += 1

    def _finalize(self, utt: Utterance, stopped: float) -> None:
        with self._wake:
            spec, self._spec = self._spec, None
            if spec is not None and not spec.stale and spec.key == _key(utt):
                # The speculative job covered exactly this utterance: use it (now, or when it finishes).
                spec.final = True
                self.stats["speculative_used"] += 1
                if spec.done:
                    self._emit_result(spec)
                return
            self._mark_stale(spec)
        self._submit(Job(key=_key(utt), audio=_audio(utt), stopped=stopped, speculative=False, final=True))

    # ── transcription side ─────────────────────────────────────────────────

    def _stt_loop(self) -> None:
        while not self._stop.is_set():
            with self._wake:
                while not self._jobs and not self._stop.is_set():
                    self._wake.wait(timeout=0.5)
                if self._stop.is_set():
                    return
                job = self._jobs.popleft()
                if job.stale:
                    continue
            try:
                job.route, job.detection = self._route(job)
                t = self._stt.transcribe(job.audio, job.route)
                err = None
            except Exception as e:
                t, err = None, str(e)
            with self._wake:
                job.transcript, job.error, job.done = t, err, True
                if job.final and not job.stale:
                    self._emit_result(job)

    def _emit_result(self, job: Job) -> None:
        """Called with the lock held, once per job that is both final and done."""
        if job.emitted:
            return
        job.emitted = True
        if job.error:
            self._emit({"type": "error", "error": job.error})
            return
        t = job.transcript
        if t is None or not t.text:
            return
        self.stats["finals"] += 1
        r, d = job.route, job.detection
        self._stt.router.remember(r, time.time())
        self.routes[r.engine] += 1
        if r.reason == "detected":
            self.routes["early_lang_id" if job.early else "late_lang_id"] += 1
        elif r.reason in ("sticky", "forced"):
            self.routes[r.reason] += 1
        latency = round((time.time() - job.stopped) * 1000)
        how = f"{r.reason}{f' {r.language} {r.prob:.2f}' if r.language else ''}"
        print(f"[voice] final ({t.language}, {t.engine}, {how}, {latency} ms{', speculative' if job.speculative else ''}): {t.text}")
        self._emit(
            {
                "type": "final",
                # Every page that listens gets this; the one that claims the id (POST /v1/claim) acts on it.
                "id": uuid.uuid4().hex,
                "text": t.text,
                "language": t.language,
                "engine": t.engine,
                "route": r.reason,  # detected | sticky | forced | no-english-engine
                "detected": {"language": r.language, "prob": round(r.prob, 3), "lang_id_ms": d.took_ms if d else None} if r.language else None,
                "confidence": t.confidence,
                "audio_s": round(t.duration_s, 2),
                "transcribe_ms": t.took_ms,
                "end_of_speech_to_final_ms": latency,
                "speculative": job.speculative,
                "trigger": self.trigger,
            }
        )


def _key(utt: Utterance) -> tuple[int, int]:
    return (utt.start_frame, utt.end_frame)


def _audio(utt: Utterance) -> np.ndarray:
    return np.concatenate([np.asarray(f, dtype=np.float32) for f in utt.frames])
