"""Dump the gateway's cached account snapshot as one line of JSON.

Reads the account JSON files the hub writes under accounts/ (each one carries
the last `credits` snapshot the scheduler stored — no upstream call is made
here) and prints the fields dsh-wb-credits needs. All the maths (7-day expiry
window, per-account detail) lives in the plugin's JS so panel mode and SSH mode
share one implementation; this script stays a dumper.

Deliberately dependency-free: python3 stdlib only, so it runs on a bare Ubuntu
host.
"""

import glob
import json
import os
import sys

ACCOUNTS_DIR = os.environ.get("WB_ACCOUNTS_DIR", "/opt/wb-proxy/accounts")
SKIP = {"settings.json", "model.json", "active_realm.json"}


def load_accounts():
    out = []
    for path in sorted(glob.glob(os.path.join(ACCOUNTS_DIR, "*.json"))):
        name = os.path.basename(path)
        if name in SKIP or name.startswith("."):
            continue
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        credits = data.get("credits") or {}
        if not isinstance(credits, dict):
            credits = {}
        packages = []
        for pack in credits.get("packages") or []:
            if not isinstance(pack, dict):
                continue
            packages.append(
                {
                    "remain": pack.get("remain") or 0,
                    "expire_time": pack.get("expire_time") or "",
                    "cycle_end_time": pack.get("cycle_end_time") or "",
                }
            )
        out.append(
            {
                "uid": data.get("uid") or name[:-5],
                "nickname": data.get("nickname") or name[:8],
                "enabled": data.get("enabled", True),
                "remain": credits.get("remain") or 0,
                "used": credits.get("used") or 0,
                "size": credits.get("size") or 0,
                "packages": packages,
            }
        )
    return out


def main():
    accounts = load_accounts()
    sys.stdout.write(
        json.dumps({"ok": True, "accounts": accounts}, ensure_ascii=False, default=str)
    )


if __name__ == "__main__":
    main()
