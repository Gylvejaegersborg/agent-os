"""Measure end-of-speech → final latency without a mic: plays WAV files through the real pipeline (Silero VAD,
segmenter, speculation, language ID, routing, NB-Whisper or the English engine) at real-time pace, as if they
came from the sound card.

  python replay.py clip1.wav [clip2.wav …] [--no-speculation] [--window 0] [--en phonon-2|bark-plus|none]
                   [--mode auto|no|en] [--ptt]

--ptt holds push-to-talk for each clip and lets go 300 ms after its audio ends (latency then counts from the
release); without it, the open mic (mic.trigger: always) decides where each utterance ends.

Each clip is followed by 1.5 s of silence so its utterance closes. Prints each final with its latency, then
the median. The clips are read, never written anywhere.
"""

from __future__ import annotations

import argparse
import statistics
import threading
import time
from pathlib import Path

import numpy as np

from voice_service.config import load_config, model_path
from voice_service.mic import MicListener
from voice_service.stt import SpeechToText
from voice_service.vad import SileroVad


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--no-speculation", action="store_true")
    ap.add_argument("--window", type=float, default=None, help="stt.min_window_s for this run (0 = full 30 s)")
    ap.add_argument("--en", default=None, help="stt.en for this run: phonon-2, bark-plus or none")
    ap.add_argument("--mode", default=None, choices=("auto", "no", "en"))
    ap.add_argument("--ptt", action="store_true", help="push-to-talk: hold the key for each clip")
    args = ap.parse_args()

    from faster_whisper.audio import decode_audio

    cfg = load_config()
    if args.no_speculation:
        cfg["vad"]["speculative_ms"] = 0
    if args.window is not None:
        cfg["stt"]["min_window_s"] = args.window
    if args.en is not None:
        cfg["stt"]["en"] = None if args.en == "none" else args.en
    if args.mode:
        cfg["mode"] = args.mode
    cfg["mic"]["trigger"] = "push_to_talk" if args.ptt else "always"
    r = cfg["resources"]
    stt = SpeechToText(cfg)
    vad = SileroVad(model_path(cfg["vad"]["model"]))
    mic = MicListener(cfg, vad, stt)
    finals: list[dict] = []
    got = threading.Event()

    def on(event: dict) -> None:
        if event["type"] == "final":
            finals.append(event)
            got.set()

    mic.subscribe(on)
    mic.start(use_device=False)
    n = cfg["audio"]["frame_samples"]
    frame_s = n / cfg["audio"]["sample_rate"]
    print(f"speculation {'off' if not cfg['vad']['speculative_ms'] else str(cfg['vad']['speculative_ms']) + ' ms'}, window {cfg['stt']['min_window_s'] or 30} s")

    for clip in args.clips:
        speech = decode_audio(str(clip), sampling_rate=16000)
        audio = np.concatenate([np.zeros(8000, np.float32), speech, np.zeros(24000, np.float32)])
        release_at = 8000 + speech.size + 4800  # 300 ms after the clip's audio
        got.clear()
        before = len(finals)
        start = time.perf_counter()
        for i in range(0, audio.size - n + 1, n):
            if args.ptt and i <= 4800 < i + n:
                mic.ptt(True)  # the key goes down 200 ms before the speech
            if args.ptt and i <= release_at < i + n:
                mic.ptt(False)
            mic.feed(audio[i : i + n])
            # real-time pace, so the latency is what a speaker would see
            delay = start + (i // n + 1) * frame_s - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
        got.wait(timeout=10)
        for e in finals[before:]:
            d = e["detected"]
            how = e["route"] + (f" {d['language']} {d['prob']:.2f}" if d else "")
            print(f"{clip.name}: {e['engine']} ({how}), {e['end_of_speech_to_final_ms']} ms (transcribe {e['transcribe_ms']} ms{', speculative' if e['speculative'] else ''}): {e['text']}")
        if len(finals) == before:
            print(f"{clip.name}: no final (nothing heard?)")

    mic.stop()
    lat = [e["end_of_speech_to_final_ms"] for e in finals]
    if lat:
        print(f"\nmedian end of speech → final: {statistics.median(lat):.0f} ms over {len(lat)} utterance(s); stats {mic.stats}, routes {mic.routes}")


if __name__ == "__main__":
    main()
