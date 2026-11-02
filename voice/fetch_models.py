"""Download the models into voice/models (git-ignored).

  python fetch_models.py               Silero VAD (~2 MB), NB-Whisper small, CTranslate2 (~1 GB on disk, int8 in
                                       RAM), whisper-tiny for language ID (~75 MB) and Phonon-2 int8 for English
                                       (~690 MB)
  python fetch_models.py --bark        also Bark 3.0 Plus int8 (~685 MB), the English engine to A/B against Phonon-2
  python fetch_models.py --tts         also speech back: Gradium's Phonon 31M for English (~65 MB, into the Hugging
                                       Face cache, where its ptts runtime looks), Piper's Norwegian voice
                                       no_NO-talesyntese-medium (~63 MB), and fastText's lid.176.ftz (~1 MB)
  python fetch_models.py --kokoro      also Kokoro int8 (~90 MB) + its voices (~27 MB), the other English voice

Sources: Silero's v5.1.2 tag, NbAiLab/nb-whisper-small's ct2/ folder, Systran/faster-whisper-tiny,
Avifenesh/Phonon-2-ONNX (an ONNX export of FermionResearch/Phonon-2), velddev/Underdog-Bark-3.0-Plus-sherpa-onnx
(of ConwayResearch/Underdog-Bark-3.0-Plus), gradium/phonon-31m-en and gradium/phonon-voices (pinned by ptts),
the kokoro-onnx model-files-v1.0 release, rhasspy/piper-voices, and fastText's published lid.176.ftz.
Phonon-2 and Bark are CC BY 4.0, Phonon 31M Apache 2.0; each folder keeps its NOTICE/LICENSE.
"""

from __future__ import annotations

import argparse
import shutil
import time
import urllib.request
from pathlib import Path

MODELS = Path(__file__).resolve().parent / "models"
SILERO = "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx"
KOKORO = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FASTTEXT_LID = "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz"
PIPER_NO = "no/no_NO/talesyntese/medium/no_NO-talesyntese-medium"


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"have {dest.name}")
        return
    print(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(5):  # connections get reset now and then; start the file again
        try:
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, length=1 << 20)
            break
        except OSError as err:
            if attempt == 4:
                raise
            print(f"  retrying ({err})")
            time.sleep(3)
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


def fetch_hf(repo: str, folder: str, files: list[str]) -> None:
    """Only the listed files of a Hugging Face repo, retried: the big int8 encoders are the only weights used."""
    import time

    from huggingface_hub import snapshot_download

    target = MODELS / folder
    for attempt in range(5):
        try:
            snapshot_download(repo, allow_patterns=files, local_dir=target)
            print(f"  → {target}")
            return
        except Exception as err:  # Hugging Face resets connections now and then; downloads resume
            if attempt == 4:
                raise
            print(f"  retrying {repo} ({err})")
            time.sleep(3)


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
    ap.add_argument("--bark", action="store_true", help="also fetch Bark 3.0 Plus, to A/B against Phonon-2 (stt.en: bark-plus)")
    ap.add_argument("--tts", action="store_true", help="also fetch speech back's voices (only needed with tts.enabled)")
    ap.add_argument("--kokoro", action="store_true", help="also fetch Kokoro (tts.en.engine: kokoro)")
    args = ap.parse_args()
    MODELS.mkdir(exist_ok=True)
    fetch(SILERO, MODELS / "silero_vad.onnx")
    fetch_nb_whisper()
    fetch_hf("Systran/faster-whisper-tiny", "whisper-tiny", ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"])
    fetch_hf(
        "Avifenesh/Phonon-2-ONNX",
        "phonon-2",
        ["config.json", "vocab.txt", "NOTICE", "encoder-model.int8.onnx", "decoder_joint-model.int8.onnx"],
    )
    if args.bark:
        fetch_hf(
            "velddev/Underdog-Bark-3.0-Plus-sherpa-onnx",
            "bark-3.0-plus",
            ["tokens.txt", "LICENSE", "NOTICE", "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx"],
        )
    if args.kokoro:
        fetch(KOKORO + "kokoro-v1.0.int8.onnx", MODELS / "kokoro-v1.0.int8.onnx")
        fetch(KOKORO + "voices-v1.0.bin", MODELS / "voices-v1.0.bin")
    if args.tts:
        import ptts

        ptts.TTS(lang="en", quant="q8")  # downloads Phonon 31M (and its voice catalog) at ptts's pinned revision
        print("  → Phonon 31M (Hugging Face cache)")
        fetch_hf("rhasspy/piper-voices", "piper", [f"{PIPER_NO}.onnx", f"{PIPER_NO}.onnx.json", f"{PIPER_NO.rsplit('/', 1)[0]}/MODEL_CARD"])
        fetch(FASTTEXT_LID, MODELS / "lid.176.ftz")


if __name__ == "__main__":
    main()
