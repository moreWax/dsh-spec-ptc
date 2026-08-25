"""
dsh-spec engine shim for the upstream spec-ptc daemon.

Registers dsh harness tools as speculatable daemon tools; each speculative
execution calls back over loopback HTTP to the dsh-spec-ptc plugin, which
runs the real tool through the harness registry. The daemon's own
`serve(socket, engine)` public API hosts this engine — no upstream changes.

Security: the callback endpoint is 127.0.0.1-only with a per-instance bearer
token handed to this process via env (never config files, never logs).
Only tools the plugin lists as speculatable (pure, side-effect-free) are
registered — speculating a side effect would be a correctness bug, since the
generated code might never reach that call.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.request

from spec_ptc.daemon import serve


class DshSpecEngine:
    """Engine whose tools are dsh harness tools, executed via loopback callback."""

    def __init__(self, callback_url: str, token: str) -> None:
        self.callback_url = callback_url.rstrip("/")
        self.token = token

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.callback_url + path,
            data=json.dumps(payload).encode(),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.token}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=600) as res:
            return json.loads(res.read())

    def _get(self, path: str) -> dict:
        req = urllib.request.Request(
            self.callback_url + path,
            headers={"authorization": f"Bearer {self.token}"},
        )
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())

    def make_tools(self, reg, bus) -> None:
        inventory = self._get("/tools")
        for entry in inventory.get("tools", []):
            name = entry["name"]

            def make_fn(tool_name: str):
                def run(args, _spec=None):
                    # args arrives as the program wrote it; the daemon keys
                    # speculation by (tool, args), mirrored by resolve().
                    reply = self._post("/execute", {"tool": tool_name, "args": args})
                    if reply.get("isError"):
                        raise RuntimeError(reply.get("error", "tool failed"))
                    return reply.get("result")

                return run

            reg.register(
                name,
                make_fn(name),
                speculatable=True,
                pure=True,
                latency_hint_ms=entry.get("latencyHintMs", 1000),
            )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--socket", default="/tmp/spec-ptc.sock")
    ap.add_argument("--callback", required=True)
    args = ap.parse_args()
    token = os.environ.get("DSH_SPEC_CALLBACK_TOKEN", "")
    if not token:
        raise SystemExit("DSH_SPEC_CALLBACK_TOKEN is required")
    serve(args.socket, DshSpecEngine(args.callback, token)).serve_forever()


if __name__ == "__main__":
    main()
