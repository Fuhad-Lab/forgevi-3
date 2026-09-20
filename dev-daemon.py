#!/usr/bin/env python3
"""
Forgevi — persistent local dev engine launcher.

The sandbox bash tool reaps every descendant of the shell when a command
finishes. A classic double-fork daemon (reparented to PID 1) escapes that
reaper, so the engine keeps serving on :3010.

Local LLM lane: the mock OpenAI-compatible gateway (/home/z/f3test/
mock-llm.py on :4599) — start that first:
    python3 /home/z/f3test/mock-llm.py

Usage:
    python3 dev-daemon.py            # start (no-op if already listening)
    python3 dev-daemon.py --status   # check health
"""
import os
import socket
import sys

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
PORT = 3010
ENV = {
    **os.environ,
    # the local mock gateway lane (no external budget spent)
    "OPENROUTER_API_KEY": "mock-key",
    "OPENROUTER_BASE_URL": "http://127.0.0.1:4599/v1",
    "ENGINE_MODEL": "mock/mock-agent",
    "ENGINE_PORT": str(PORT),
    "ENGINE_RELAY_KEY": "e107cadbb0f8fb29bb0600fcc95f3ed45a378142723e290b",
    "FORGVI3_ALLOW_UNGRANTED_PROJECTS": "1",
}


def listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def main() -> None:
    if "--status" in sys.argv:
        os.system("curl -sS -m 5 http://127.0.0.1:3010/health")
        print()
        return
    if listening(PORT):
        print(f"engine already listening on :{PORT}")
        return

    log = open(os.path.join(ENGINE_DIR, "engine-dev.log"), "ab", buffering=0)
    devnull = os.open(os.devnull, os.O_RDONLY)

    # double-fork: child of init, own session — survives shell reaping
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)

    os.chdir(ENGINE_DIR)
    os.dup2(devnull, 0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    os.execvpe(
        "bun",
        ["bun", "--hot", "src/server.ts"],
        ENV,
    )


if __name__ == "__main__":
    main()
