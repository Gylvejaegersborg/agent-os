"""Download the phase 1 models into voice/models (git-ignored).

  python fetch_models.py          Silero VAD (~2 MB) + NB-Whisper small, CTranslate2 (~1 GB on disk, int8 in RAM)
  python fetch_models.py --tts    also Kokoro int8 (~90 MB) + its voices (~27 MB), for speech back

Sources are pinned: Silero's v5.1.2 tag, NbAiLab/nb-whisper-small's ct2/ folder on Hugging Face, and the
kokoro-onnx model-files-v1.0 release.
"""

from __future__ import annotations

import argparse
import shutil
import urllib.request
from pathlib import Path

MODELS = Path(__file__).resolve().parent / "models"
SILERO = "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx"
KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"have {dest.name}")
        return
    print(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)
    tmp.replace(dest)
    print(f"  → {dest} ({dest.stat().st_size / 2**20:.1f} MB)")


def fetch_nb_whisper() -> None:
    from huggingface_hub import hf_hub_download, snapshot_download

    target = MODELS / "nb-whisper-small"
    snapshot_download("NbAiLab/nb-whisper-small", allow_patterns=["ct2/*"], local_dir=target)
    ct2 = target / "ct2"
    # faster-whisper reads tokenizer.json from the model folder; take the repo's own if ct2/ lacks one.
    if not (ct2 / "tokenizer.json").exists():
        shutil.copy(hf_hub_download("NbAiLab/nb-whisper-small", "tokenizer.json"), ct2 / "tokenizer.json")
    print(f"  → {ct2}")


def use_windows_certificates() -> None:
    """Verify HTTPS with the operating system's certificate store (as curl and browsers do). A standalone
    Python's OpenSSL can fail to build the chain on Windows ("unable to get issuer certificate")."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except ImportError:
        pass


def main() -> None:
    use_windows_certificates()
    ap = argparse.ArgumentParser()
    ap.add_argument("--tts", action="store_true", help="also fetch Kokoro (only needed with tts.enabled)")
    args = ap.parse_args()
    MODELS.mkdir(exist_ok=True)
    fetch(SILERO, MODELS / "silero_vad.onnx")
    fetch_nb_whisper()
    if args.tts:
        fetch(KOKORO + "kokoro-v1.0.int8.onnx", MODELS / "kokoro-v1.0.int8.onnx")
        fetch(KOKORO + "voices-v1.0.bin", MODELS / "voices-v1.0.bin")


if __name__ == "__main__":
    main()
