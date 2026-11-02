"""voice.yaml: defaults here, your overrides in voice/voice.yaml (git-ignored; copy voice.example.yaml)."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

VOICE_DIR = Path(__file__).resolve().parent.parent

DEFAULTS: dict[str, Any] = {
    "server": {"host": "127.0.0.1", "port": 8765},
    "audio": {"input_device": None, "sample_rate": 16000, "frame_samples": 512},
    "vad": {
        "model": "models/silero_vad.onnx",
        "threshold": 0.5,
        "min_silence_ms": 600,
        "speculative_ms": 250,  # start transcribing at this much silence; 0 = off
        "speech_pad_ms": 150,
        "preroll_ms": 300,
        "min_speech_ms": 250,
    },
    "stt": {
        "no": "models/nb-whisper-small/ct2",
        "no_beam": 1,
        "min_chars": 2,
        # Encode only as much of Whisper's 30 s window as the clip needs, at least this much (0 = full 30 s).
        "min_window_s": 10,
        # English goes here when language ID is sure (phase 2); null = everything to NB-Whisper.
        "en": "phonon-2",
        "en_engines": {
            "phonon-2": {"runtime": "onnx-asr", "path": "models/phonon-2"},
            "bark-plus": {"runtime": "sherpa-onnx", "path": "models/bark-3.0-plus"},
        },
    },
    "lang_id": {
        "model": "models/whisper-tiny",
        "en_threshold": 0.80,  # English at least this sure → the English engine; anything else → NB-Whisper
        "sticky_conf": 0.90,  # a detection this sure is reused for the next utterances…
        # …for this long after it. Off: live, it sent a Norwegian/English mix to the English-only engine and an
        # English command to NB-Whisper (which translated it), while language ID alone got every one right.
        # Language ID runs while you talk, so skipping it saves no time you'd notice.
        "sticky_window_s": 0,
        "after_ms": 1000,  # run language ID once this much speech is in, while you're still talking
        "max_s": 3.0,  # look at no more than this much of the start
    },
    "mode": "auto",  # auto | no | en; the hotkey and POST /v1/control change it while running
    "hotkey": "ctrl+alt+l",  # cycles auto → no → en; null = no hotkey
    "tts": {
        # Speech back is an option, off by default: with it off, no TTS model is loaded.
        "enabled": False,
        "en": {"engine": "kokoro", "model": "models/kokoro-v1.0.int8.onnx", "voices": "models/voices-v1.0.bin", "voice": "af_heart"},
        "sample_rate": 24000,
    },
    "resources": {"threads": 4, "vad_threads": 2, "priority": "below_normal"},
    "mic": {"enabled": True},
}


def _merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config(path: Path | None = None) -> dict[str, Any]:
    """Defaults, overlaid with voice.yaml when it exists. Relative model paths resolve against voice/."""
    path = path or VOICE_DIR / "voice.yaml"
    over: dict[str, Any] = {}
    if path.exists():
        import yaml  # only needed when there is a file to read

        over = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(over, dict):
            raise ValueError(f"{path}: expected a mapping at the top level")
    return _merge(DEFAULTS, over)


def model_path(rel: str) -> Path:
    p = Path(rel)
    return p if p.is_absolute() else VOICE_DIR / p
