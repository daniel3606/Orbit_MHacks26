"""Create (or reuse) the worker's SpacetimeDB service identity and allowlist it.

    uv run python -m scripts.bootstrap_service_identity            # create + print grant command
    uv run python -m scripts.bootstrap_service_identity --grant    # also grant via local CLI

The token is written to backend/.secrets/service_token (gitignored, 0600).
Granting calls the admin-only `grant_service_identity` reducer with the local
`spacetime` CLI identity, which is the module admin because it published the
module. For non-local servers the command is printed, never run.
"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

from app.config.settings import get_settings
from app.state.gateway import SpacetimeGateway


def _write_secret(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(value)


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--grant", action="store_true", help="grant via local spacetime CLI")
    parser.add_argument("--rotate", action="store_true", help="create a new identity even if one exists")
    parser.add_argument("--label", default=None)
    args = parser.parse_args()

    settings = get_settings()
    base = str(settings.spacetime_http_url).rstrip("/")
    token_path = settings.spacetime_service_token_file
    if token_path is None:
        print("SPACETIME_SERVICE_TOKEN_FILE is not set", file=sys.stderr)
        return 2
    identity_path = token_path.with_name("service_identity.json")

    if identity_path.is_file() and token_path.is_file() and not args.rotate:
        identity = json.loads(identity_path.read_text())["identity"]
        print(f"Reusing service identity {identity}")
    else:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"{base}/v1/identity")
            response.raise_for_status()
            body = response.json()
        identity = body["identity"]
        _write_secret(token_path, body["token"])
        identity_path.write_text(json.dumps({"identity": identity, "server": base}) + "\n")
        print(f"Created service identity {identity}; token saved to {token_path}")

    label = args.label or settings.worker_id
    db = settings.spacetime_database
    command = ["spacetime", "call", "--no-config", db, "--server", base,
               "grant_service_identity", f'"0x{identity}"', f'"{label}"']
    is_local = settings.spacetime_http_url.host in ("127.0.0.1", "localhost")

    if args.grant:
        if not is_local:
            print("Refusing to auto-grant on a non-local server. Run as the module admin:")
            print("  " + " ".join(command))
            return 1
        if shutil.which("spacetime") is None:
            print("spacetime CLI not on PATH", file=sys.stderr)
            return 1
        subprocess.run(command, check=True, capture_output=True, text=True)
        print(f"Granted {identity[:12]}… as '{label}' on {db}")
    else:
        print("Grant it as the module admin with:\n  " + " ".join(command))

    async with SpacetimeGateway(base, db, settings.resolved_service_token()) as gateway:
        grant = await gateway.service_grant()
    print("Allowlisted: " + ("yes" if grant else "no"))
    return 0 if grant or not args.grant else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
