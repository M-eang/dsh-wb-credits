#!/usr/bin/env python3
"""Read-only credits snapshot API for dsh-wb-credits.

Why this exists: the plugin needs the hub's per-account credit numbers, but it
must not carry the *panel password* around — that credential can rotate API
keys and import accounts. This service exposes exactly one thing (the cached
snapshot the scheduler already wrote to accounts/*.json) behind one revocable
token, so a plugin install on someone else's machine holds a read-only secret
with a blast radius of zero.

Design notes:
  * stdlib only — it has to start on a bare Ubuntu host with system python3.
  * binds 127.0.0.1; the public path is Nginx /wb-credits/summary (TLS).
  * token comes from $WB_CREDITS_API_TOKEN or a 0600 file, and the service
    refuses to start without one (fail closed, never "open by default").
  * no upstream calls: reading the cached files is the whole job. The math
    (7-day window, buckets, per-account detail) stays in the plugin JS so panel
    mode, SSH mode and this API cannot drift apart.
"""

import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("WB_CREDITS_API_HOST", "127.0.0.1")
PORT = int(os.environ.get("WB_CREDITS_API_PORT", "8799"))
ACCOUNTS_DIR = os.environ.get("WB_ACCOUNTS_DIR", "/opt/wb-proxy/accounts")
TOKEN_FILE = os.environ.get("WB_CREDITS_API_TOKEN_FILE", "/opt/wb-credits-api/token")
ROUTE = "/summary"
SKIP = {"settings.json", "model.json", "active_realm.json"}
# The plugin already caches for 55s; this only absorbs bursts (two browsers).
CACHE_SECONDS = 5.0

_lock = threading.Lock()
_cache = {"at": 0.0, "body": None}


def load_token():
    token = (os.environ.get("WB_CREDITS_API_TOKEN") or "").strip()
    if token:
        return token
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return ""


def load_accounts():
    """Same shape as server/credits.py, so both dumpers agree."""
    out = []
    try:
        names = sorted(os.listdir(ACCOUNTS_DIR))
    except Exception:
        return out
    for name in names:
        if not name.endswith(".json") or name in SKIP or name.startswith("."):
            continue
        path = os.path.join(ACCOUNTS_DIR, name)
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


def snapshot():
    with _lock:
        now = time.time()
        if _cache["body"] is not None and now - _cache["at"] < CACHE_SECONDS:
            return _cache["body"]
        body = json.dumps(
            {"ok": True, "accounts": load_accounts(), "dump_at": time.strftime("%Y-%m-%d %H:%M:%S")},
            ensure_ascii=False,
            default=str,
        )
        _cache["at"] = now
        _cache["body"] = body
        return body


class Handler(BaseHTTPRequestHandler):
    server_version = "wb-credits-api/1"
    protocol_version = "HTTP/1.1"

    def _send(self, status, body, content_type="application/json; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] != ROUTE:
            self._send(404, '{"ok": false, "error": "not found"}')
            return
        expected = TOKEN
        given = (self.headers.get("X-WB-Token") or "").strip()
        # compare_digest keeps the comparison constant-time; an empty expected
        # token means the service misconfigured itself, so nothing opens up.
        if not expected or not given or not hmac.compare_digest(given, expected):
            self._send(401, '{"ok": false, "error": "token required"}')
            return
        try:
            self._send(200, snapshot())
        except Exception as exc:  # never leak a traceback to the caller
            self._send(500, json.dumps({"ok": False, "error": str(exc)[:200]}))

    def log_message(self, fmt, *args):
        # One line per request is enough; the default also logs the URL twice.
        print("[%s] %s" % (time.strftime("%H:%M:%S"), fmt % args), flush=True)


TOKEN = load_token()
if not TOKEN:
    raise SystemExit("wb-credits-api: no token configured (set WB_CREDITS_API_TOKEN or " + TOKEN_FILE + ")")

if __name__ == "__main__":
    print(
        "wb-credits-api listening on %s:%d, accounts=%s, token=%s…"
        % (HOST, PORT, ACCOUNTS_DIR, TOKEN[:4]),
        flush=True,
    )
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
