"""Deterministic scripted provider — a TEST DOUBLE, not an AI.

Only active when JARVIS_AI_PROVIDER=scripted is set explicitly. The UI labels it
"Scripted test provider" everywhere. It exists so the full orchestration path
(streaming, tool calls, permissions, approvals, persistence, UI states) can be
exercised end-to-end in CI and in environments without model credentials.

Rules (first match wins, case-insensitive) on the latest user text:
  "note: <title> | <body>"         -> notes_create
  "remind me in <n> minutes to <x>" -> reminder_create
  "what time"                       -> get_current_time
  "calculate <expr>"                -> calculate
  "write file <path>: <content>"   -> files_write   (requires approval)
  "read file <path>"               -> files_read
  "fetch <url>"                     -> web_fetch
  "launch <app_id>"                 -> desktop_launch_app
  "remember that <x>"               -> memory_propose
  "github <owner/repo>"             -> github_repo_overview
  "save finding <title> | <summary>" -> findings_save
After a tool result it replies with a factual summary of that result.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import AsyncIterator
from typing import Any

from jarvis.providers.base import (
    ProviderEvent,
    TextDelta,
    ToolCall,
    TurnComplete,
    TurnRequest,
    TurnUsage,
)

RULES: list[tuple[re.Pattern[str], str, Any]] = [
    (
        re.compile(r"note:\s*(?P<title>[^|]+)\|?(?P<body>.*)", re.I | re.S),
        "notes_create",
        lambda m: {"title": m["title"].strip(), "body": m["body"].strip()},
    ),
    (
        re.compile(r"remind me in (?P<n>\d+) minutes? to (?P<text>.+)", re.I),
        "reminder_create",
        lambda m: {"text": m["text"].strip(), "in_minutes": int(m["n"])},
    ),
    (re.compile(r"what time", re.I), "get_current_time", lambda m: {}),
    (re.compile(r"calculate (?P<expr>.+)", re.I), "calculate", lambda m: {"expression": m["expr"].strip()}),
    (
        re.compile(r"write file (?P<path>[^:]+):\s*(?P<content>.+)", re.I | re.S),
        "files_write",
        lambda m: {"path": m["path"].strip(), "content": m["content"].strip(), "overwrite": False},
    ),
    (re.compile(r"read file (?P<path>\S+)", re.I), "files_read", lambda m: {"path": m["path"].strip()}),
    (re.compile(r"fetch (?P<url>https?://\S+)", re.I), "web_fetch", lambda m: {"url": m["url"]}),
    (re.compile(r"launch (?P<app>[\w.-]+)", re.I), "desktop_launch_app", lambda m: {"app_id": m["app"]}),
    (
        re.compile(r"remember that (?P<x>.+)", re.I),
        "memory_propose",
        lambda m: {"content": m["x"].strip(), "kind": "preference"},
    ),
    (re.compile(r"github (?P<repo>[\w.-]+/[\w.-]+)", re.I), "github_repo_overview", lambda m: {"repo": m["repo"]}),
    (
        re.compile(r"save finding (?P<title>[^|]+)\|(?P<summary>.+)", re.I),
        "findings_save",
        lambda m: {"title": m["title"].strip(), "summary": m["summary"].strip(), "sources": []},
    ),
]


class ScriptedProvider:
    name = "scripted"

    def __init__(self, delay_s: float = 0.02) -> None:
        self._delay = delay_s

    def default_model(self, *, fast: bool = False) -> str:
        return "scripted-test-double"

    async def _stream_text(self, text: str) -> AsyncIterator[TextDelta]:
        for word in re.findall(r"\S+\s*", text):
            await asyncio.sleep(self._delay)
            yield TextDelta(word)

    async def stream_turn(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        last = req.messages[-1] if req.messages else None
        tool_names = {t.name for t in req.tools}
        usage = TurnUsage(input_tokens=sum(len(json.dumps(m.blocks)) // 4 for m in req.messages), output_tokens=0)

        results = [b for b in (last.blocks if last else []) if b.get("type") == "tool_result"]
        if results:
            parts = []
            for r in results:
                raw = str(r.get("content", ""))
                try:
                    payload = json.loads(raw[raw.index("{") : raw.rindex("}") + 1])
                    summary = payload.get("summary", raw)
                    verified = " (verified)" if payload.get("verified") else ""
                except ValueError:
                    summary, verified = raw[:300], ""
                if r.get("is_error"):
                    parts.append(f"The tool call failed: {summary}")
                else:
                    parts.append(f"Done{verified}: {summary}")
            text = " ".join(parts)
            async for d in self._stream_text(text):
                yield d
            usage.output_tokens = len(text) // 4
            yield TurnComplete([{"type": "text", "text": text}], [], "end_turn", usage, "scripted-test-double")
            return

        user_text = " ".join(b.get("text", "") for b in (last.blocks if last else []) if b.get("type") == "text")
        # Ignore the context preamble the orchestrator prepends.
        user_text = user_text.split("[/JARVIS CONTEXT]")[-1].strip()
        for pattern, tool, build in RULES:
            match = pattern.search(user_text)
            if match and tool in tool_names:
                args = build(match)
                preface = f"Using {tool}. "
                async for d in self._stream_text(preface):
                    yield d
                call = ToolCall(id=f"toolu_{uuid.uuid4().hex[:16]}", name=tool, input=args)
                yield TurnComplete(
                    [
                        {"type": "text", "text": preface},
                        {"type": "tool_call", "id": call.id, "name": tool, "input": args},
                    ],
                    [call],
                    "tool_use",
                    usage,
                    "scripted-test-double",
                )
                return
        text = (
            "Scripted test provider: no AI model is connected, so I can only run the scripted commands "
            f'listed in the documentation. You said: "{user_text[:200]}"'
        )
        async for d in self._stream_text(text):
            yield d
        usage.output_tokens = len(text) // 4
        yield TurnComplete([{"type": "text", "text": text}], [], "end_turn", usage, "scripted-test-double")
