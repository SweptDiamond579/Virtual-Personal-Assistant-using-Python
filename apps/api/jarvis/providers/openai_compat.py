"""OpenAI-compatible Chat Completions provider for non-Anthropic models.

Covers Ollama, LM Studio, vLLM, OpenRouter, OpenAI and similar servers that
implement `/v1/chat/completions` with function calling.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import openai

from jarvis.providers.base import (
    ProviderError,
    ProviderEvent,
    ProviderMessage,
    TextDelta,
    ToolCall,
    TurnComplete,
    TurnRequest,
    TurnUsage,
)


def to_openai_messages(system: str, messages: list[ProviderMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": system}]
    for msg in messages:
        texts = [b["text"] for b in msg.blocks if b.get("type") == "text" and b.get("text")]
        if msg.role == "assistant":
            calls = [b for b in msg.blocks if b.get("type") == "tool_call"]
            entry: dict[str, Any] = {"role": "assistant", "content": "\n".join(texts) or None}
            if calls:
                entry["tool_calls"] = [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": c["name"], "arguments": json.dumps(c["input"])},
                    }
                    for c in calls
                ]
            out.append(entry)
            continue
        for b in msg.blocks:
            if b.get("type") == "tool_result":
                out.append({"role": "tool", "tool_call_id": b["tool_call_id"], "content": b.get("content", "")})
        if texts:
            out.append({"role": "user", "content": "\n".join(texts)})
    return out


class OpenAICompatProvider:
    name = "openai_compatible"

    def __init__(self, base_url: str, api_key: str | None, model: str, http_client: Any = None) -> None:
        self._client = openai.AsyncOpenAI(
            base_url=base_url, api_key=api_key or "not-needed", max_retries=2, http_client=http_client
        )
        self._model = model

    def default_model(self, *, fast: bool = False) -> str:
        return self._model

    async def stream_turn(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        kwargs: dict[str, Any] = {
            "model": req.model,
            "messages": to_openai_messages(req.system, req.messages),
            "max_tokens": min(req.max_tokens, 8192),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if req.tools:
            kwargs["tools"] = [
                {
                    "type": "function",
                    "function": {"name": t.name, "description": t.description, "parameters": t.input_schema},
                }
                for t in req.tools
            ]
        text_parts: list[str] = []
        partial: dict[int, dict[str, str]] = {}
        finish = "stop"
        usage = TurnUsage()
        try:
            stream = await self._client.chat.completions.create(**kwargs)
            async for chunk in stream:
                if chunk.usage:
                    usage = TurnUsage(
                        input_tokens=chunk.usage.prompt_tokens or 0, output_tokens=chunk.usage.completion_tokens or 0
                    )
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if delta and delta.content:
                    text_parts.append(delta.content)
                    yield TextDelta(delta.content)
                for tc in (delta.tool_calls or []) if delta else []:
                    slot = partial.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["args"] += tc.function.arguments
                if choice.finish_reason:
                    finish = choice.finish_reason
        except openai.AuthenticationError as exc:
            raise ProviderError("auth", "The model server rejected the API key.") from exc
        except openai.RateLimitError as exc:
            raise ProviderError("rate_limit", "Model server rate limit reached.", retryable=True) from exc
        except openai.BadRequestError as exc:
            raise ProviderError("bad_request", f"Model server rejected the request: {exc.message}") from exc
        except openai.APIConnectionError as exc:
            raise ProviderError("connection", "Could not reach the model server.", retryable=True) from exc
        except openai.APIStatusError as exc:
            raise ProviderError("unknown", f"Model server error {exc.status_code}", retryable=True) from exc

        blocks: list[dict[str, Any]] = []
        if text_parts:
            blocks.append({"type": "text", "text": "".join(text_parts)})
        calls: list[ToolCall] = []
        for idx in sorted(partial):
            slot = partial[idx]
            try:
                args = json.loads(slot["args"] or "{}")
                if not isinstance(args, dict):
                    raise ValueError("arguments must be an object")
            except ValueError:
                args = {"__invalid__": slot["args"]}
            call_id = slot["id"] or f"call_{idx}"
            blocks.append({"type": "tool_call", "id": call_id, "name": slot["name"], "input": args})
            calls.append(ToolCall(id=call_id, name=slot["name"], input=args))
        if finish == "length" and calls:
            raise ProviderError("truncated", "Tool call arguments were truncated; not executing.")
        yield TurnComplete(blocks=blocks, tool_calls=calls, stop_reason=finish, usage=usage, model=req.model)
