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
        "speculative_ms": 250,  # used from phase 4
        "speech_pad_ms": 150,
        "preroll_ms": 300,
        "min_speech_ms": 250,
    },
    "stt": {
        "no": "models/nb-whisper-small/ct2",
        "no_beam": 1,
        "min_chars": 2,
    },
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
