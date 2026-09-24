#!/usr/bin/env python3
"""Forgevi engine — the real OpenHands worker (openhands-sdk, pinned 1.44.1).

ONE agent (the SDK's default agent), ONE conversation, ONE workspace.
The SDK owns the loop, the tools (terminal, file editor, task tracker),
and the finish decision. This file adds NO agent behavior of its own —
it only:

  - builds the LLM from the job spec (any OpenAI-compatible gateway)
  - sends the task message
  - streams the conversation's events as JSON lines on stdout

THE IN-VM AGENT LAW (2026-09-21): when the run's sandbox is an E2B
microVM, the ENGINE executes this script INSIDE that microVM (streaming
stdout over the E2B commands API) with workspace=/workspace — the SDK's
LocalConversation/LocalWorkspace/tmux-terminal/file-editor then operate
on the sandbox's OWN filesystem. The agent and the studio surface (files,
terminal, uploads) share the very same machine. Local (engine-host) runs
spawn this script directly with a local workspace directory.

The engine shell (src/server.ts) spawns one worker process per run and
relays the JSON lines into the run journal. Stdout discipline: the real
stdout fd is captured FIRST, then sys.stdout is pointed at stderr BEFORE
the OpenHands import so the SDK's consoles can never pollute the event
stream.

Job spec (JSON file passed via --job):
  {
    "workspace": "/abs/path",          # the run's workspace root
    "prompt": "...",                   # the full task message
    "model": "openai/<model>",         # litellm model id
    "api_key": "...",
    "base_url": "https://...",         # optional (OpenAI-compatible gateway)
    "max_iterations": 500,             # 0 → SDK default (500)
    "system_addendum": "..."           # THE SYSTEM-PROMPT LAW: appended to
                                       # the SDK default agent's system prompt
  }

Event lines (one JSON object per line):
  {"type":"thinking","text":"..."}                # reasoning before an answer
  {"type":"message","text":"..."}                 # assistant message content
  {"type":"action","tool":"...","detail":"..."}   # tool call started
  {"type":"file","path":"...","content":"..."}   # a workspace file write (content capped, text files only)
  {"type":"error","error":"..."}                  # agent-side error (may recover)
  {"type":"finished","status":"complete|incomplete","summary":"...","issues":[...]}

Exit codes: 0 = conversation ran to its own end; 2 = bad job/config;
3 = the conversation crashed. A terminal "finished" event is ALWAYS
emitted when the process can still write.

Gateway compatibility (verified against 1.44.1): OpenHands threads the
conversation id as ``prompt_cache_key`` on every completion; NIM-class
gateways 400 the whole request on it. The patch below strips it for
non-OpenAI base URLs (idempotent), and ``drop_params=True`` handles the
rest.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import json
import os
import re
import signal
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

# ── stdout discipline: events own the real stdout ──────────────────────
_EMIT_FD = os.dup(1)  # the REAL stdout, captured before any redirect
_EMIT = os.fdopen(_EMIT_FD, "w", buffering=1)
sys.stdout = sys.stderr  # the SDK's consoles/logs land on stderr, always
os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")

_NIM_PATCH_MARKER = "_forgevi_gateway_patched"


def emit(obj: dict[str, Any]) -> None:
    try:
        _EMIT.write(json.dumps(obj) + "\n")
        _EMIT.flush()
    except Exception:  # noqa: BLE001 — the reader may be gone
        pass


# ── SDK import (heavy — kept lazy) ──────────────────────────────────────


def import_openhands() -> SimpleNamespace:
    try:
        from openhands.sdk import LLM, LocalConversation, LocalWorkspace
        from openhands.sdk.llm import Message  # noqa: F401 — surface check
        from openhands.sdk.workspace.models import CommandResult, FileOperationResult
        from openhands.tools.preset import get_default_agent
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"openhands-sdk/openhands-tools unavailable: {exc}") from exc
    return SimpleNamespace(
        LLM=LLM,
        LocalConversation=LocalConversation,
        LocalWorkspace=LocalWorkspace,
        Message=Message,
        get_default_agent=get_default_agent,
        CommandResult=CommandResult,
        FileOperationResult=FileOperationResult,
    )


def _is_gateway_base_url(base_url: str | None) -> bool:
    if not base_url:
        return False
    return "api.openai.com" not in base_url


def apply_gateway_compat_patch(oh: SimpleNamespace) -> None:
    """Strip ``prompt_cache_key`` for OpenAI-compatible gateways (NIM 400s)."""
    try:
        original = oh.LocalConversation.get_llm_call_context
        if getattr(original, _NIM_PATCH_MARKER, False):
            return

        def get_llm_call_context(self: Any) -> Any:
            ctx = original(self)
            try:
                base_url = getattr(getattr(self.agent, "llm", None), "base_url", None)
            except Exception:  # noqa: BLE001
                return ctx
            if _is_gateway_base_url(base_url):
                return dataclasses.replace(ctx, prompt_cache_key=None)
            return ctx

        get_llm_call_context._forgevi_gateway_patched = True  # type: ignore[attr-defined]
        oh.LocalConversation.get_llm_call_context = get_llm_call_context  # type: ignore[method-assign]
    except Exception:  # noqa: BLE001
        pass


# ── THE DEGENERATE-FINAL GUARD (user fix 2026-09-22, live-observed: a
# fully-successful build on nemotron-3.5-lightning ended with word-salad —
# "The key}` part? Perhaps I should be consider that's not I've been't
# possibly. Perhaps the system perhaps system't just system't always's…"
# — which would land in the user's chat bubble AND the Redis conversation
# cache, poisoning every later turn's context). Detection: abnormal
# contraction density (English has ~40 valid contractions; degenerate
# output mints fake ones like "been't", "system't", "always's"), extreme
# token repetition, or a long text with zero sentence-ending punctuation.

_VALID_CONTRACTIONS = {
    "don't", "can't", "won't", "isn't", "aren't", "wasn't", "weren't",
    "hasn't", "haven't", "hadn't", "doesn't", "didn't", "couldn't",
    "shouldn't", "wouldn't", "mustn't", "ain't", "that's", "it's",
    "there's", "here's", "what's", "who's", "he's", "she's", "i'm",
    "you're", "they're", "we're", "i've", "you've", "we've", "they've",
    "i'd", "you'd", "he'd", "she'd", "we'd", "they'd", "i'll", "you'll",
    "we'll", "they'll", "he'll", "she'll", "it'll", "that'll", "let's",
    "y'all", "o'clock", "ma'am", "cat's", "dog's",
}


def _is_degenerate_final(text: str) -> bool:
    """True when a final message is word-salad, not a usable summary."""
    words = re.findall(r"[A-Za-z']+", text)
    if len(words) < 24:
        return False  # too short to judge — treat as valid
    uniq_ratio = len({w.lower() for w in words}) / len(words)
    bad_contractions = sum(
        1 for w in words if "'" in w and w.lower() not in _VALID_CONTRACTIONS
    )
    has_sentence_end = re.search(r"[.!?](?:\s|$)", text) is not None
    return (
        uniq_ratio < 0.35
        or bad_contractions >= 4
        or (len(text) > 200 and not has_sentence_end)
    )


# ── event mapping ───────────────────────────────────────────────────────

_EDITOR_WRITE_COMMANDS = {"create", "str_replace", "insert"}

# File-content cap for `file` events — the studio's code stream (the
# fragments panel) shows real file bodies as they land, bounded so a
# single write can never bloat a journal frame.
_FILE_EVENT_CONTENT_CAP = 16_000


def _text_items(content: Any) -> list[str]:
    out: list[str] = []
    for item in content or []:
        text = getattr(item, "text", None)
        if text:
            out.append(str(text))
    return out


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:  # noqa: BLE001
            return {}
    return {}


def _read_file_event_content(workspace: str, path: str) -> str | None:
    """Best-effort file body for a `file` event (text only, capped).

    Binary files (or unreadable paths) yield None — the event still
    carries the path, only the code-stream preview skips the body.
    """
    try:
        candidate = Path(workspace) / str(path).lstrip("/")
        data = candidate.read_bytes()[:_FILE_EVENT_CONTENT_CAP + 1]
    except Exception:  # noqa: BLE001 — the path may be outside/absolute/gone
        return None
    if b"\x00" in data:
        return None  # binary — no body in the stream
    text = data.decode("utf-8", errors="replace")
    if len(text) > _FILE_EVENT_CONTENT_CAP:
        text = text[:_FILE_EVENT_CONTENT_CAP] + "\n… (truncated for the stream)"
    return text


def make_sink(state: dict[str, Any], workspace: str) -> Any:
    """One callback — maps OpenHands events onto the engine's event lines."""

    def sink(event: Any) -> None:
        kind = type(event).__name__

        if kind == "MessageEvent":
            if getattr(event, "source", None) != "agent":
                return
            reasoning = getattr(event, "reasoning_content", None) or ""
            if reasoning.strip():
                emit({"type": "thinking", "text": reasoning[:8000]})
            for block in getattr(event, "thinking_blocks", None) or []:
                thought = getattr(block, "thinking", None)
                if thought:
                    emit({"type": "thinking", "text": str(thought)[:8000]})
            for text in _text_items(getattr(getattr(event, "llm_message", None), "content", None)):
                if text.strip():
                    emit({"type": "message", "text": text})
                    state["last_message"] = text
            return

        if kind == "ActionEvent":
            tool_name = str(getattr(event, "tool_name", "?"))
            args = _parse_args(getattr(getattr(event, "tool_call", None), "arguments", None))
            detail = getattr(event, "summary", None)
            if not detail:
                primary = args.get("command") or args.get("path") or args.get("url") or ""
                detail = str(primary)[:160] if primary else tool_name
            state["actions"] += 1
            emit({"type": "action", "tool": tool_name, "detail": str(detail)[:200]})
            # the agent's own finish decision — its message IS the final answer
            if tool_name == "finish":
                message = args.get("message")
                if isinstance(message, str) and message.strip():
                    emit({"type": "message", "text": message})
                    state["last_message"] = message
                return
            # file writes surface for the Files tab + the code stream
            if "editor" in tool_name.lower() or "file" in tool_name.lower():
                path = args.get("path")
                command = args.get("command")
                if isinstance(path, str) and path and command in _EDITOR_WRITE_COMMANDS:
                    event: dict[str, Any] = {"type": "file", "path": str(path)}
                    body = _read_file_event_content(workspace, str(path))
                    if body is not None:
                        event["content"] = body
                    emit(event)
            return

        if kind == "ObservationEvent":
            # tool result landed — the action line already told the story.
            state["observations"] += 1
            return

        if kind == "AgentErrorEvent":
            error = str(getattr(event, "error", "") or "")[:500]
            if error:
                state["errors"].append(error)
                emit({"type": "error", "error": error})
            return

        if kind == "ConversationErrorEvent":
            detail = str(getattr(event, "detail", "") or getattr(event, "code", "") or "")[:500]
            if detail:
                state["errors"].append(detail)
                emit({"type": "error", "error": detail})
            return

        # Condensation / system / hook / other events: not part of the
        # stream vocabulary — ignored by design.

    return sink


# ── the run ─────────────────────────────────────────────────────────────


async def run_job(job: dict[str, Any]) -> int:
    oh = import_openhands()
    apply_gateway_compat_patch(oh)

    workspace = str(job["workspace"])
    if not Path(workspace).is_dir():
        emit({
            "type": "finished",
            "status": "incomplete",
            "summary": f"workspace does not exist: {workspace}",
            "issues": ["bad workspace"],
        })
        return 2
    workspace_obj = oh.LocalWorkspace(working_dir=workspace)

    model = str(job.get("model") or "")
    api_key = str(job.get("api_key") or "")
    if not model or not api_key:
        emit({
            "type": "finished",
            "status": "incomplete",
            "summary": "the engine has no LLM configured (model/api key missing)",
            "issues": ["llm unconfigured"],
        })
        return 2

    base_url = job.get("base_url")
    llm = oh.LLM(
        model=model,
        api_key=api_key,
        **({"base_url": str(base_url)} if base_url else {}),
        drop_params=True,
        # Fast failure surfacing: the engine-level NVIDIA lane switch takes
        # over when the OpenRouter free tier is exhausted — a 10-retry
        # ladder just grinds for ~8 dead minutes first (live-observed).
        num_retries=4,
        retry_min_wait=4,
        retry_max_wait=20,
        timeout=600,  # a call may be slow; it may never hang forever
        max_output_tokens=int(job.get("max_output_tokens") or 16384),
    )

    # THE mandate: one agent — the SDK's own default agent. cli_mode=True —
    # terminal + file editor + task tracker, no browser dependency.
    agent = oh.get_default_agent(llm=llm, cli_mode=True)

    # ── THE SYSTEM-PROMPT LAW (user mandate 2026-09-24) ──────────────────
    # The platform's standing instructions ride the agent's SYSTEM PROMPT
    # as an APPENDIX to the SDK's built-in prompt — never a replacement
    # (the built-in tool docs stay) and never a hardcoded engine-side
    # dev-server start. Agent is a frozen pydantic model, so the combined
    # prompt installs via model_copy — verified against openhands-sdk
    # 1.44.1: static_system_message renders the default (registry-built)
    # prompt when system_prompt is None, and returns the override verbatim
    # once set; the conversation's SystemPromptEvent then carries the
    # combination. Best-effort: a rendering failure leaves the default
    # prompt (the task message still carries the platform laws).
    addendum = str(job.get("system_addendum") or "").strip()
    if addendum:
        try:
            base_prompt = agent.static_system_message
            agent = agent.model_copy(
                update={"system_prompt": base_prompt + "\n\n" + addendum}
            )
        except Exception:  # noqa: BLE001 — never kill the run for prompt assembly
            pass

    state: dict[str, Any] = {"actions": 0, "observations": 0, "errors": [], "last_message": ""}
    conversation = oh.LocalConversation(
        agent=agent,
        workspace=workspace_obj,
        callbacks=[make_sink(state, workspace)],
        max_iteration_per_run=int(job.get("max_iterations") or 500),
        visualizer=None,
        delete_on_close=True,
    )
    conversation.send_message(str(job.get("prompt") or ""))

    try:
        await conversation.arun()
    except asyncio.CancelledError:
        emit({
            "type": "finished",
            "status": "incomplete",
            "summary": "Aborted by the user. Work done so far is saved in the workspace.",
            "issues": [],
        })
        with contextlib.suppress(Exception):
            await asyncio.to_thread(conversation.close)
        return 0
    except Exception as exc:  # noqa: BLE001 — the conversation crashed
        emit({
            "type": "finished",
            "status": "incomplete",
            "summary": f"The OpenHands conversation failed: {exc}",
            "issues": [str(exc)[:500]],
        })
        with contextlib.suppress(Exception):
            await asyncio.to_thread(conversation.close)
        return 3

    with contextlib.suppress(Exception):
        await asyncio.to_thread(conversation.close)

    # ── THE DEGENERATE-FINAL GUARD: a word-salad final message is discarded
    # BEFORE anything consumes it — the nudge below then asks for a real
    # one, and a still-degenerate nudge falls back to the honest summary.
    if _is_degenerate_final(state["last_message"]):
        state["last_message"] = ""

    # ── THE FINAL-ANSWER NUDGE (user fix 2026-09-21): the conversation can
    # legitimately end without a single agent text block (iteration cap,
    # a model that answered only in tool calls) — the old path then
    # reported "finished without a final message". ONE bounded nudge
    # round asks the agent for its final summary; the nudge run carries a
    # tiny iteration cap so it cannot spiral into a second full build.
    if not state["last_message"].strip():
        try:
            nudge = (
                "You have reached the end of your work on this task. Reply NOW with your "
                "final summary for the user: what you built, what works, and anything that "
                "remains. Do not use any tools — reply with text only."
            )
            conversation.max_iteration_per_run = 4
            conversation.send_message(nudge)
            await conversation.arun()
            with contextlib.suppress(Exception):
                await asyncio.to_thread(conversation.close)
        except Exception as exc:  # noqa: BLE001 — the nudge is best-effort
            state["errors"].append(f"final-answer nudge failed: {str(exc)[:200]}")

    # ── THE DEGENERATE-FINAL GUARD, second look: the nudge's answer is
    # still word-salad → discard it and surface the flaw honestly (the
    # fallback summary below takes over; the cache never sees garbage).
    if _is_degenerate_final(state["last_message"]):
        state["errors"].append("the model's final message was degenerate (discarded)")
        state["last_message"] = ""

    status_obj = getattr(conversation, "execution_status", None)
    status_str = str(getattr(status_obj, "value", status_obj) or "").lower()
    summary = state["last_message"].strip()

    if status_str in ("error", "stuck"):
        final_status = "incomplete"
        issues = [e for e in state["errors"][:10]]
        if not summary:
            summary = f"The agent ended in state '{status_str}'."
        if status_str not in issues:
            issues.insert(0, f"conversation {status_str}")
    elif state["errors"] and not summary:
        final_status = "incomplete"
        issues = [e for e in state["errors"][:10]]
        summary = "The agent ended with errors and no final answer."
    else:
        # A finished run's transient tool errors were recovered by the
        # agent itself — they are not "remaining" issues.
        final_status = "complete" if summary else "incomplete"
        issues = [] if final_status == "complete" else [e for e in state["errors"][:10]]
        if not summary:
            summary = (
                "The agent finished without a final message even after a final-answer "
                "nudge. Work done so far is saved in the workspace — check the Files "
                "tab and the running preview."
            )

    emit({
        "type": "finished",
        "status": final_status,
        "summary": summary[:20000],
        "issues": issues,
    })
    return 0


def probe() -> int:
    """Capability probe for /health — no LLM call, no conversation."""
    try:
        oh = import_openhands()
        from importlib.metadata import version as pkg_version

        sdk_version = pkg_version("openhands-sdk")
        agent = oh.get_default_agent(llm=oh.LLM(model="probe/probe", api_key="probe"), cli_mode=True)
        tools = [t.name for t in getattr(agent, "tools", [])]
        emit({
            "ok": True,
            "sdk": sdk_version,
            "tools": tools,
        })
        return 0
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": str(exc)[:500]})
        return 3


def main() -> int:
    parser = argparse.ArgumentParser(description="Forgevi OpenHands worker")
    parser.add_argument("--job", help="path to the JSON job spec")
    parser.add_argument("--probe", action="store_true", help="capability probe")
    args = parser.parse_args()

    if args.probe:
        return probe()

    if not args.job:
        emit({"type": "finished", "status": "incomplete", "summary": "no --job given", "issues": ["bad argv"]})
        return 2

    job_path = Path(args.job)
    try:
        job = json.loads(job_path.read_text())
    except Exception as exc:  # noqa: BLE001
        emit({"type": "finished", "status": "incomplete", "summary": f"bad job file: {exc}", "issues": ["bad job"]})
        return 2
    # THE JOB-FILE CLEANUP LAW: the spec carries live credentials (the LLM
    # key) — it dies the moment it has been read.
    with contextlib.suppress(Exception):
        job_path.unlink()
        job_path.parent.rmdir()

    def on_term(signum: Any, frame: Any) -> None:
        emit({
            "type": "finished",
            "status": "incomplete",
            "summary": "Aborted by the user. Work done so far is saved in the workspace.",
            "issues": [],
        })
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    return asyncio.run(run_job(job))


if __name__ == "__main__":
    sys.exit(main())
