---
name: beat-analysis
description: Measure a beat's audio features (BPM, key, loudness, spectral stats) and turn them into an honest A&R read. Use when a new beat comes in or someone asks how a track sits against the catalog.
metadata:
  author: agent-os
  version: "1.0"
---

# Beat analysis

This is the intake step the old GitHub team ran on every new beat, moved into
Agent-OS. Nobody on the team can hear audio, so the read rests entirely on
measured numbers.

## 1. Measure

Only the `claude` agent has a shell. Ask it to run:

```
python3 skills/beat-analysis/scripts/extract-features.py <path to audio>
```

It prints JSON: `durationSec`, `bitrateKbps`, `sampleRate`, `lufs` (integrated),
`truePeakDb`, `loudnessRange`, `bpm`, `key` + `keyConfidence` (a Krumhansl-Schmuckler
estimate from mean chroma, so treat r < 0.6 as a guess), `spectralCentroidHz`,
`spectralRolloffHz`, `onsetsPerSec`, `rmsMean`, `rmsStd`.

It needs ffmpeg/ffprobe and `pip install numpy librosa`.

## 2. Read (Aether)

- Say "measured" or "estimated", never "I heard".
- Tempo and onset density → energy and genre fit; centroid/rolloff → bright vs dark;
  RMS spread and loudness range → dynamics. Mood tags come from these, labelled as
  inferred.
- Mastering facts: distance from the −10 LUFS target, clipping risk if true peak is
  above −1 dBTP, a loudness range under ~4 LU (squashed).
- Compare against the catalog (read BaseSpace: `basespace` section notes/projects, and
  the beat library) — which existing tracks it sits near, and what that means.
- Verdict: keep / maybe / pass, with the one reason that decided it.

## 3. Record

Write the read to BaseSpace with `basespace-add` (kind `note`, folder
`Team/Reports/Analysis`, title `<beat name> — analysis`). If ISΛRK needs to decide
something, add a todo.
