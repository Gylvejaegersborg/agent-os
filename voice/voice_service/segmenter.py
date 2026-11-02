"""Turns a stream of VAD-scored frames into utterances. Pure Python, no models, so it is tested on its own.

- A frame at or above `threshold` starts speech; the pre-roll (frames just before onset) is kept, so the
  first syllable isn't cut.
- Speech ends after `min_silence_ms` of frames below `threshold - 0.15` (hysteresis, as Silero's own
  helper does, so a dip in the middle of a word doesn't count as silence).
- Of the trailing silence, only `speech_pad_ms` is kept on the utterance.
- An utterance with less than `min_speech_ms` of speech (a click, a cough) is dropped.
- Speculation (phase 4): after `speculative_ms` of silence, "pause" hands over the utterance so far (cut
  exactly as it would be if the silence lasted), so it can be transcribed while the silence window runs.
  Speech coming back is "resume": that pause's result is stale. 0 turns it off.
- While speech goes on, speech_ms / start_frame / so_far() let the mic start language ID early (phase 2).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Sequence


@dataclass
class Utterance:
    frames: list[Sequence[float]]
    speech_ms: int
    start_frame: int
    end_frame: int


@dataclass
class Segmenter:
    frame_ms: float
    threshold: float = 0.5
    min_silence_ms: int = 600
    speech_pad_ms: int = 150
    preroll_ms: int = 300
    min_speech_ms: int = 250
    speculative_ms: int = 0
    _preroll: deque = field(init=False)
    _frames: list = field(init=False, default_factory=list)
    _in_speech: bool = field(init=False, default=False)
    _silence_frames: int = field(init=False, default=0)
    _speech_frames: int = field(init=False, default=0)
    _index: int = field(init=False, default=0)
    _start: int = field(init=False, default=0)
    _paused: bool = field(init=False, default=False)

    def __post_init__(self) -> None:
        self._preroll = deque(maxlen=max(0, round(self.preroll_ms / self.frame_ms)))

    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def speech_ms(self) -> int:
        """Speech so far in the current utterance (0 outside one)."""
        return round(self._speech_frames * self.frame_ms) if self._in_speech else 0

    @property
    def start_frame(self) -> int:
        """The current utterance's first frame: the same start_frame its pause and speech_end will carry."""
        return self._start

    def so_far(self) -> list:
        """The current utterance's frames up to now, pre-roll included (for early language ID)."""
        return list(self._frames)

    def push(self, frame: Sequence[float], prob: float) -> tuple[Optional[str], Optional[Utterance]]:
        """Feed one frame and its speech probability. Returns (event, utterance): event is "speech_start" when
        speech begins, "speech_end" when an utterance closes (utterance set, or None if it was too short),
        "pause" with the utterance so far once silence reaches speculative_ms, "resume" when speech returns
        after a pause. A pause's utterance has the same start_frame/end_frame as the speech_end that follows
        it when no speech came in between, which is how a speculative result is matched."""
        i = self._index
        self._index += 1
        if not self._in_speech:
            if prob >= self.threshold:
                self._in_speech = True
                self._frames = list(self._preroll) + [frame]
                self._start = i - len(self._preroll)
                self._preroll.clear()
                self._silence_frames = 0
                self._speech_frames = 1
                return "speech_start", None
            self._preroll.append(frame)
            return None, None

        self._frames.append(frame)
        if prob < self.threshold - 0.15:
            self._silence_frames += 1
        else:
            self._silence_frames = 0
            self._speech_frames += 1
            if self._paused:
                self._paused = False
                return "resume", None
        silence_ms = self._silence_frames * self.frame_ms
        if silence_ms < self.min_silence_ms:
            if self.speculative_ms and not self._paused and silence_ms >= self.speculative_ms:
                self._paused = True
                utt = self._cut()
                return "pause", (utt if utt.speech_ms >= self.min_speech_ms else None)
            return None, None

        utt = self._cut()
        self._in_speech = False
        self._paused = False
        self._frames = []
        self._silence_frames = 0
        self._speech_frames = 0
        return "speech_end", (utt if utt.speech_ms >= self.min_speech_ms else None)

    def _cut(self) -> Utterance:
        """The utterance so far, keeping only speech_pad_ms of the trailing silence."""
        keep_silence = round(self.speech_pad_ms / self.frame_ms)
        drop = max(0, self._silence_frames - keep_silence)
        frames = self._frames[: len(self._frames) - drop] if drop else list(self._frames)
        speech_ms = round(self._speech_frames * self.frame_ms)
        return Utterance(frames=frames, speech_ms=speech_ms, start_frame=self._start, end_frame=self._start + len(frames) - 1)
