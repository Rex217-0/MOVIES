#!/usr/bin/env python3
"""Print exactly what to paste into Render to connect the Kaggle worker.

Run this after deploying the app and after starting the notebook once. It
generates a fresh sync token, checks the live site, and tells you which values
are still missing. Nothing here is a secret until you paste it into Render, and
the token is never written to disk.

    python3 scripts/setup_kaggle_worker.py
    python3 scripts/setup_kaggle_worker.py --url https://your-app.onrender.com
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "https://movies-627p.onrender.com"


def probe(base: str) -> tuple[int, str]:
    """POST an obviously invalid URL and report what the sync route answers."""
    body = json.dumps({"kaggle_url": "http://not-https.example.com"}).encode()
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api/pilot/update-kaggle-url",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read().decode("utf-8", "replace")[:200]
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:200]
    except Exception as exc:  # network, DNS, cold start
        return 0, f"{type(exc).__name__}: {exc}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL, help="deployed app base URL")
    args = parser.parse_args()

    base = args.url.rstrip("/")
    print("=" * 68)
    print("KAGGLE WORKER SETUP")
    print("=" * 68)

    status, detail = probe(base)
    print(f"\nSync route: {base}")
    print(f"  HTTP {status}  {detail}")

    if status == 404:
        print("\n  -> NAKA-OFF ang sync. Kailangan ng PILOT_SYNC_TOKEN sa Render.")
    elif status == 400 and "https" in detail:
        print("\n  -> BUHAY ang sync at tama ang validation. Tapos na ang step 1.")
    elif status == 401:
        print("\n  -> BUHAY at naka-set na ang token. Tama ang setup.")
    elif status == 0:
        print("\n  -> Hindi maabot. Baka nag-spin down; subukan muli pagkalipas ng 1 min.")

    token = secrets.token_urlsafe(32)
    print("\n" + "-" * 68)
    print("I-paste sa Render -> Environment (5 minuto, isang beses lang):")
    print("-" * 68)
    print(f"\n  PILOT_SYNC_TOKEN = {token}")
    print("\n  (Bago ito. Ito ang kokopyahin mo sa Kaggle Secret.)\n")
    print("  FIREBASE_SERVICE_ACCOUNT = <buong service-account JSON sa isang linya>")
    print("\n  Optional lang ito: kung wala ito, gumagana pa rin ang app pero")
    print("  kailangang i-paste muli ang tunnel URL kada bagong Kaggle run.")

    print("\n" + "-" * 68)
    print("I-paste sa Kaggle -> Add-ons -> Secrets:")
    print("-" * 68)
    print("\n  PILOT_SYNC_TOKEN   = (kaparehong token sa itaas)")
    print("  LROS_SERVER_URL    = " + base)
    print("\n  Optional, para permanenteng URL (hindi ka na mag-paste kahit minsan):")
    print("  CF_TUNNEL_TOKEN    = <Cloudflare named tunnel token>")
    print("  CF_PUBLIC_URL      = https://direk.yourdomain.com")

    print("\n" + "=" * 68)
    print("Pagkatapos: i-restart ang notebook, tapos i-run muli ang script na ito.")
    print("Hihintayin ang HTTP 400 o 401 — iyon ang senyales na tama ang lahat.")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    sys.exit(main())
