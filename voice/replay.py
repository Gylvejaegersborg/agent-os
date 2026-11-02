"""Measure end-of-speech → final latency without a mic: plays WAV files through the real pipeline (Silero VAD,
segmenter, speculation, NB-Whisper) at real-time pace, as if they came from the sound card.

  python replay.py clip1.wav [clip2.wav …] [--no-speculation] [--window 0]

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
from voice_service.engines import NbWhisper
from voice_service.mic import MicListener
from voice_service.vad import SileroVad


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+", type=Path)
    ap.add_argument("--no-speculation", action="store_true")
    ap.add_argument("--window", type=float, default=None, help="stt.min_window_s for this run (0 = full 30 s)")
    args = ap.parse_args()

    from faster_whisper.audio import decode_audio

    cfg = load_config()
    if args.no_speculation:
        cfg["vad"]["speculative_ms"] = 0
    if args.window is not None:
        cfg["stt"]["min_window_s"] = args.window
    r = cfg["resources"]
    stt = NbWhisper(model_path(cfg["stt"]["no"]), threads=r["threads"], beam=cfg["stt"]["no_beam"], min_chars=cfg["stt"]["min_chars"], min_window_s=cfg["stt"]["min_window_s"])
    vad = SileroVad(model_path(cfg["vad"]["model"]), threads=r["vad_threads"])
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
        audio = np.concatenate([np.zeros(8000, np.float32), decode_audio(str(clip), sampling_rate=16000), np.zeros(24000, np.float32)])
        got.clear()
        before = len(finals)
        start = time.perf_counter()
        for i in range(0, audio.size - n + 1, n):
            mic.feed(audio[i : i + n])
            # real-time pace, so the latency is what a speaker would see
            delay = start + (i // n + 1) * frame_s - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
        got.wait(timeout=10)
        for e in finals[before:]:
            print(f"{clip.name}: {e['end_of_speech_to_final_ms']} ms (transcribe {e['transcribe_ms']} ms{', speculative' if e['speculative'] else ''}): {e['text']}")
        if len(finals) == before:
            print(f"{clip.name}: no final (nothing heard?)")

    mic.stop()
    lat = [e["end_of_speech_to_final_ms"] for e in finals]
    if lat:
        print(f"\nmedian end of speech → final: {statistics.median(lat):.0f} ms over {len(lat)} utterance(s); stats {mic.stats}")


if __name__ == "__main__":
    main()
