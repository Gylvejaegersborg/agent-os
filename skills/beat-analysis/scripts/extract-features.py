#!/usr/bin/env python3
"""Extract real audio features from a beat and print them as JSON.

Usage: extract-features.py <audio file>
Needs ffmpeg/ffprobe on PATH and: pip install numpy librosa

Measurements (this is the honest ground truth Aether interprets — Claude cannot
hear audio, so everything downstream rests on these numbers):
  - ffprobe: duration, bitrate, sample rate
  - ffmpeg ebur128: integrated LUFS, true peak dBTP, loudness range LU
  - librosa: tempo (BPM), key estimate (Krumhansl-Schmuckler over mean chroma),
    spectral centroid/rolloff, onset density, RMS mean/std
"""
import json
import re
import subprocess
import sys

import numpy as np
import librosa

if len(sys.argv) != 2:
    sys.exit("usage: extract-features.py <audio file>")
audio_path = sys.argv[1]
features = {}

# --- container facts ---------------------------------------------------------
probe = json.loads(subprocess.run(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", audio_path],
    capture_output=True, text=True, check=True,
).stdout)["format"]
features["durationSec"] = round(float(probe.get("duration", 0)), 2)
features["bitrateKbps"] = round(int(probe.get("bit_rate", 0)) / 1000)

# --- loudness (EBU R128) ------------------------------------------------------
r128 = subprocess.run(
    ["ffmpeg", "-nostats", "-i", audio_path, "-af", "ebur128", "-f", "null", "-"],
    capture_output=True, text=True,
).stderr
def r128_value(label):
    m = re.search(rf"{label}:\s*(-?[\d.]+)", r128.split("Summary:")[-1])
    return float(m.group(1)) if m else None
features["lufs"] = r128_value("I")
features["truePeakDb"] = r128_value("Peak")
features["loudnessRange"] = r128_value("LRA")

# --- musical features ---------------------------------------------------------
y, sr = librosa.load(audio_path, sr=22050, mono=True)
features["sampleRate"] = int(probe.get("sample_rate") or sr)

tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
features["bpm"] = round(float(np.atleast_1d(tempo)[0]), 1)

# Key estimate: correlate mean chroma against Krumhansl-Schmuckler profiles.
chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
best = (-2.0, "unknown")
for shift in range(12):
    rolled = np.roll(chroma, -shift)
    for profile, mode in ((MAJOR, "major"), (MINOR, "minor")):
        r = float(np.corrcoef(rolled, profile)[0, 1])
        if r > best[0]:
            best = (r, f"{NOTES[shift]} {mode}")
features["key"] = best[1]
features["keyConfidence"] = round(best[0], 2)

features["spectralCentroidHz"] = round(float(librosa.feature.spectral_centroid(y=y, sr=sr).mean()))
features["spectralRolloffHz"] = round(float(librosa.feature.spectral_rolloff(y=y, sr=sr).mean()))
features["onsetsPerSec"] = round(
    len(librosa.onset.onset_detect(y=y, sr=sr)) / max(features["durationSec"], 0.1), 2)
rms = librosa.feature.rms(y=y)
features["rmsMean"] = round(float(rms.mean()), 4)
features["rmsStd"] = round(float(rms.std()), 4)

print(json.dumps(features, indent=2))
