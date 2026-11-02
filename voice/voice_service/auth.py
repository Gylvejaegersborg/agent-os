"""The voice service's token (phase 6): the same one the Agent-OS gateway uses (src/gateway/auth.ts).

Binding 127.0.0.1 keeps other machines out, not other programs on this one: any web page open in a browser
here could open ws://127.0.0.1:8765/v1/listen and read everything you dictate (browsers don't apply CORS to
WebSockets). So every route but GET /health needs `Authorization: Bearer <token>`. BaseSpace's Vite proxy adds
it, as it does for the gateway; the browser never holds the token.

The token: AGENT_OS_GATEWAY_TOKEN, else agent-os/data/gateway-token (auth.token_file), else a new one written
there, in the gateway's format, so the gateway picks up the same one. auth.enabled: false turns it off, loudly.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import Optional

MIN_LENGTH = 16


def load_token(token_file: Path) -> tuple[str, str]:
    """(token, where it came from — never the token itself)."""
    env = (os.environ.get("AGENT_OS_GATEWAY_TOKEN") or "").strip()
    if env:
        if len(env) < MIN_LENGTH:
            raise ValueError(f"AGENT_OS_GATEWAY_TOKEN is too short (use at least {MIN_LENGTH} characters)")
        return env, "AGENT_OS_GATEWAY_TOKEN"
    if token_file.exists():
        saved = token_file.read_text(encoding="utf-8").strip()
        if len(saved) >= MIN_LENGTH:
            return saved, str(token_file)
    token = secrets.token_urlsafe(32)
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token + "\n", encoding="utf-8")
    try:
        token_file.chmod(0o600)
    except OSError:
        pass  # Windows: the file is in the user's own folder
    return token, f"{token_file} (new)"


def _digest(s: str) -> bytes:
    return hashlib.sha256(s.encode("utf-8")).digest()


def has_token(authorization: Optional[str], token: str) -> bool:
    """True when an Authorization header carries the token. Compared in constant time."""
    if not authorization:
        return False
    scheme, _, value = authorization.strip().partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(_digest(value.strip()), _digest(token))
