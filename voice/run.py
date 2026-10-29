"""Start the voice service: python run.py [--config voice.yaml]. Binds 127.0.0.1 only."""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from voice_service.app import app, load
from voice_service.config import load_config


def main() -> None:
    ap = argparse.ArgumentParser(description="agent-os local voice service")
    ap.add_argument("--config", type=Path, default=None, help="default: voice/voice.yaml if it exists, else built-in defaults")
    args = ap.parse_args()
    cfg = load_config(args.config)
    host = cfg["server"]["host"]
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(f"server.host is {host!r}: the voice service only listens locally (it has the mic)")
    load(cfg)
    uvicorn.run(app, host=host, port=int(cfg["server"]["port"]), log_level="warning")


if __name__ == "__main__":
    main()
