"""Score the recorded test set (record_testset.py): routing, word error rate and latency per clip, through the real
pipeline (VAD, push-to-talk hold, early language ID, routing, NB-Whisper or the English engine), clips played at
real-time pace as if held on Ctrl+Alt+B.

  python benchmark.py                   the configured English engine (stt.en)
  python benchmark.py --en bark-plus    A/B the English engine on the same clips
  python benchmark.py --only en         just the English clips (en / no / mx prefixes)

Prints a line per clip and a summary: routing accuracy per group (the spec's bar: ≥ 95%), word error rate
(lowercase, punctuation ignored; dialect words count as errors), release → text latency, peak RAM and CPU time.
Writes testset/results-<engine>.json. Nothing leaves the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import threading
import time
from pathlib import Path

import numpy as np
import psutil

from record_testset import OUT, load_prompts
from voice_service.config import load_config, model_path
from voice_service.mic import MicListener
from voice_service.stt import SpeechToText
from voice_service.vad import SileroVad

GROUPS = {"en": "English", "no": "Norwegian", "mx": "mixed"}


def words(text: str) -> list[str]:
    return re.sub(r"[^\w\s'-]", " ", text.lower()).replace("-", " ").split()


def wer(ref: str, hyp: str) -> float:
    """Word error rate: word-level edit distance / reference length."""
    r, h = words(ref), words(hyp)
    if not r:
        return 0.0 if not h else 1.0
    prev = list(range(len(h) + 1))
    for i, rw in enumerate(r, 1):
        cur = [i] + [0] * len(h)
        for j, hw in enumerate(h, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rw != hw))
        prev = cur
    return prev[-1] / len(r)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--en", default=None, help="stt.en for this run: phonon-2 or bark-plus")
    ap.add_argument("--only", default=None, choices=sorted(GROUPS), help="only this group of clips")
    args = ap.parse_args()

    from faster_whisper.audio import decode_audio

    cfg = load_config()
    if args.en:
        cfg["stt"]["en"] = args.en
    cfg["mic"]["trigger"] = "push_to_talk"
    cfg["resources"]["idle_unload_min"] = 0
    prompts = [p for p in load_prompts() if (OUT / f"{p['id']}.wav").exists() and (not args.only or p["id"].startswith(args.only))]
    if not prompts:
        raise SystemExit("no recordings in voice/testset — run: python record_testset.py")

    proc = psutil.Process(os.getpid())
    stt = SpeechToText(cfg)
    vad = SileroVad(model_path(cfg["vad"]["model"]))
    mic = MicListener(cfg, vad, stt)
    finals: list[dict] = []
    got = threading.Event()

    def on(event: dict) -> None:
        if event["type"] in ("final", "ptt_end") and not (event["type"] == "ptt_end" and event["kept"]):
            if event["type"] == "final":
                finals.append(event)
            got.set()

    mic.subscribe(on)
    mic.start(use_device=False)
    n = cfg["audio"]["frame_samples"]
    frame_s = n / cfg["audio"]["sample_rate"]
    cpu0 = proc.cpu_times()
    rows = []
    for p in prompts:
        speech = decode_audio(str(OUT / f"{p['id']}.wav"), sampling_rate=16000)
        audio = np.concatenate([np.zeros(4800, np.float32), speech, np.zeros(8000, np.float32)])
        release_at = 4800 + speech.size
        got.clear()
        before = len(finals)
        start = time.perf_counter()
        mic.ptt(True)
        released = False
        for i in range(0, audio.size - n + 1, n):
            if not released and i >= release_at:
                mic.ptt(False)
                released = True
            mic.feed(audio[i : i + n])
            delay = start + (i // n + 1) * frame_s - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
        if not released:
            mic.ptt(False)
        got.wait(timeout=30)
        e = finals[before] if len(finals) > before else None
        row = {
            "id": p["id"],
            "expect": p["expect"],
            "engine": e["language"] if e else None,
            "routed_ok": bool(e and e["language"] == p["expect"]),
            "detected": e["detected"] if e else None,
            "route": e["route"] if e else None,
            "wer": round(wer(p["text"], e["text"]), 3) if e else 1.0,
            "latency_ms": e["end_of_speech_to_final_ms"] if e else None,
            "audio_s": round(speech.size / 16000, 1),
            "ref": p["text"],
            "text": e["text"] if e else "",
        }
        rows.append(row)
        d = row["detected"]
        how = f"{d['language']} {d['prob']:.2f}" if d else row["route"] or "-"
        print(
            f"{row['id']}  {'ok ' if row['routed_ok'] else 'BAD'} → {row['engine'] or '—'} ({how})  "
            f"WER {row['wer']:.2f}  {row['latency_ms'] or '—'} ms  {row['audio_s']} s\n      {row['text']}"
        )
    mic.stop()
    cpu1 = proc.cpu_times()

    en_name = stt.en.name if stt.en else "none"
    print(f"\n── summary (English engine: {en_name}, {len(rows)} clips) ──")
    for g, label in GROUPS.items():
        rs = [r for r in rows if r["id"].startswith(g)]
        if not rs:
            continue
        ok = sum(r["routed_ok"] for r in rs)
        lat = [r["latency_ms"] for r in rs if r["latency_ms"] is not None]
        print(
            f"{label:9s} routed right {ok}/{len(rs)} ({100 * ok / len(rs):.0f}%)  "
            f"mean WER {statistics.mean(r['wer'] for r in rs):.2f}  "
            f"median release→text {statistics.median(lat) if lat else float('nan'):.0f} ms"
        )
    allok = sum(r["routed_ok"] for r in rows)
    peak = getattr(proc.memory_info(), "peak_wset", proc.memory_info().rss) / 2**20
    print(f"overall   routed right {allok}/{len(rows)} ({100 * allok / len(rows):.0f}%; the spec's bar is ≥ 95%)")
    print(f"peak RAM {peak:.0f} MB, CPU time {cpu1.user - cpu0.user + cpu1.system - cpu0.system:.1f} s")
    out = OUT / f"results-{en_name}.json"
    out.write_text(json.dumps({"english_engine": en_name, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"→ {out}")


if __name__ == "__main__":
    main()
