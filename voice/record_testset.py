"""Record the routing test set (phase 2): you read each prompt in testset_prompts.tsv into the mic.

  python record_testset.py            records whatever is missing, in order (resumes where you stopped)
  python record_testset.py en07 no03  re-records just those

For each prompt: Enter starts, Enter stops; then Enter keeps it, r redoes it, s skips it, q quits.
Clips go to voice/testset/<id>.wav (16 kHz mono, git-ignored) and stay on this machine: they're your voice,
recorded because you ran this, and used only by benchmark.py. Delete the folder whenever you like.

Say the Norwegian ones the way you'd say them (dialect included); the text is the reference the benchmark
compares against, so a dialect word counts as an error there, and that's worth seeing.
"""

from __future__ import annotations

import csv
import sys
import threading
import wave
from pathlib import Path

import numpy as np

from voice_service.config import load_config

HERE = Path(__file__).resolve().parent
PROMPTS = HERE / "testset_prompts.tsv"
OUT = HERE / "testset"
RATE = 16000


def load_prompts() -> list[dict[str, str]]:
    with PROMPTS.open(encoding="utf-8") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def record(device) -> np.ndarray:
    import sounddevice as sd

    chunks: list[np.ndarray] = []
    done = threading.Event()

    def on_audio(indata, _frames, _time, _status) -> None:
        if not done.is_set():
            chunks.append(indata[:, 0].copy())

    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", device=device, callback=on_audio):
        input("  ● recording… Enter to stop ")
        done.set()
    return np.concatenate(chunks) if chunks else np.zeros(0, np.float32)


def save(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())


def main() -> None:
    OUT.mkdir(exist_ok=True)
    prompts = load_prompts()
    only = set(sys.argv[1:])
    todo = [p for p in prompts if (p["id"] in only if only else not (OUT / f"{p['id']}.wav").exists())]
    have = sum(1 for p in prompts if (OUT / f"{p['id']}.wav").exists())
    print(f"{have} of {len(prompts)} recorded; {len(todo)} to go. Enter starts and stops; q quits.\n")
    device = load_config()["audio"]["input_device"]
    for n, p in enumerate(todo, 1):
        while True:
            lang = {"en": "English", "no": "Norwegian"}[p["expect"]] if not p["id"].startswith("mx") else "Norwegian with English words"
            print(f"[{n}/{len(todo)}] {p['id']}, {lang}. Say:\n\n    “{p['text']}”\n")
            if input("  Enter to start ").strip().lower() == "q":
                return
            audio = record(device)
            peak = float(np.abs(audio).max()) if audio.size else 0.0
            print(f"  {audio.size / RATE:.1f} s, peak {peak:.2f}{'  (very quiet — is the right mic selected?)' if peak < 0.05 else ''}")
            choice = input("  Enter keeps it · r redo · s skip · q quit ").strip().lower()
            if choice == "q":
                return
            if choice == "r":
                continue
            if choice != "s":
                save(OUT / f"{p['id']}.wav", audio)
            print()
            break
    print("Done. Run: python benchmark.py")


if __name__ == "__main__":
    main()
