"""Anthropic Claude provider (official `anthropic` SDK, streaming, client tools).

Notes for current models (see docs/DECISIONS.md D-004):
- Claude Opus 5.5 / Haiku 5.5 always use adaptive thinking; we omit `thinking` and
  steer depth with `output_config.effort`.
- Forced tool_choice is not supported on these models; we use the default `auto`.
- Thinking blocks are returned with signatures and must be replayed unchanged on
  the next request of a tool loop; they are stored as opaque blocks.
- Tools set `eager_input_streaming`, so we validate every tool input ourselves
  (Pydantic in the orchestrator) and stop on `max_tokens`/`refusal` before running tools.
- Server-side refusal fallback (`fallbacks: "default"`) is enabled for models that
  support it unless ANTHROPIC_REFUSAL_FALLBACK=false.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import anthropic

from jarvis.providers.base import (
    Block,
    ProviderError,
    ProviderEvent,
    ProviderMessage,
    TextDelta,
    ToolCall,
    TurnComplete,
    TurnRequest,
    TurnUsage,
)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"}
MAX_JSON_RETRIES = 2


def to_anthropic_messages(messages: list[ProviderMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for msg in messages:
        content: list[dict[str, Any]] = []
        for b in msg.blocks:
            t = b.get("type")
            if t == "text" and b.get("text"):
                content.append({"type": "text", "text": b["text"]})
            elif t == "tool_call":
                content.append({"type": "tool_use", "id": b["id"], "name": b["name"], "input": b["input"]})
            elif t == "tool_result":
                content.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": b["tool_call_id"],
                        "content": b.get("content", ""),
                        "is_error": bool(b.get("is_error")),
                    }
                )
            elif t == "opaque" and b.get("provider") == "anthropic":
                content.append(b["block"])
        if not content:
            continue
        if out and out[-1]["role"] == msg.role:
            out[-1]["content"].extend(content)
        else:
            out.append({"role": msg.role, "content": content})
    return out


def from_anthropic_content(content: list[Any]) -> tuple[list[Block], list[ToolCall]]:
    blocks: list[Block] = []
    calls: list[ToolCall] = []
    for block in content:
        t = getattr(block, "type", None)
        if t == "text":
            blocks.append({"type": "text", "text": block.text})
        elif t == "tool_use":
            args = block.input if isinstance(block.input, dict) else {"__invalid__": block.input}
            blocks.append({"type": "tool_call", "id": block.id, "name": block.name, "input": args})
            calls.append(ToolCall(id=block.id, name=block.name, input=args))
        else:  # thinking, redacted_thinking, fallback, … — replay verbatim
            blocks.append(
                {"type": "opaque", "provider": "anthropic", "block": block.model_dump(mode="json", exclude_none=True)}
            )
    return blocks, calls


class AnthropicProvider:
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        *,
        model: str,
        fast_model: str,
        effort: str,
        refusal_fallback: bool,
        base_url: str | None = None,
        http_client: Any = None,
    ) -> None:
        # base_url is passed explicitly so an ambient ANTHROPIC_BASE_URL cannot redirect app traffic.
        self._client = anthropic.AsyncAnthropic(
            api_key=api_key,
            base_url=base_url or "https://api.anthropic.com",
            max_retries=2,
            timeout=600.0,
            http_client=http_client,
        )
        self._model = model
        self._fast_model = fast_model
        self._effort = effort
        self._fallback = refusal_fallback

    def default_model(self, *, fast: bool = False) -> str:
        return self._fast_model if fast else self._model

    def _params(self, req: TurnRequest) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": to_anthropic_messages(req.messages),
            "output_config": {"effort": req.effort or self._effort},
            # Automatic prompt caching of the stable prefix (tools -> system -> history).
            "cache_control": {"type": "ephemeral"},
        }
        if req.tools:
            params["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                    "eager_input_streaming": True,
                }
                for t in req.tools
            ]
        return params

    async def stream_turn(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]:
        params = self._params(req)
        use_fallback = self._fallback and req.model in FALLBACK_MODELS
        attempts = 0
        while True:
            emitted = False
            try:
                if use_fallback:
                    ctx = self._client.beta.messages.stream(**params, betas=[FALLBACK_BETA], fallbacks="default")
                else:
                    ctx = self._client.messages.stream(**params)
                async with ctx as stream:
                    async for event in stream:
                        if event.type == "text" and event.text:
                            emitted = True
                            yield TextDelta(event.text)
                    final = await stream.get_final_message()
                break
            except ValueError as exc:
                # Tool-input JSON the SDK could not parse at all (eager input streaming).
                attempts += 1
                if attempts > MAX_JSON_RETRIES or emitted:
                    raise ProviderError("invalid_tool_input", f"model produced unparseable tool input: {exc}") from exc
            except anthropic.AuthenticationError as exc:
                raise ProviderError("auth", "Anthropic rejected the API key (401).") from exc
            except anthropic.PermissionDeniedError as exc:
                raise ProviderError("permission", f"Anthropic denied the request: {exc.message}") from exc
            except anthropic.NotFoundError as exc:
                raise ProviderError("bad_request", f"Model or endpoint not found: {exc.message}") from exc
            except anthropic.RateLimitError as exc:
                raise ProviderError("rate_limit", "Anthropic rate limit reached.", retryable=True) from exc
            except anthropic.BadRequestError as exc:
                raise ProviderError("bad_request", f"Anthropic rejected the request: {exc.message}") from exc
            except anthropic.APITimeoutError as exc:
                raise ProviderError("timeout", "Anthropic request timed out.", retryable=True) from exc
            except anthropic.APIConnectionError as exc:
                raise ProviderError("connection", "Could not reach the Anthropic API.", retryable=True) from exc
            except anthropic.APIStatusError as exc:
                kind = "overloaded" if exc.status_code in (503, 529) else "unknown"
                raise ProviderError(
                    kind, f"Anthropic API error {exc.status_code}: {exc.message}", retryable=exc.status_code >= 500
                ) from exc

        blocks, calls = from_anthropic_content(list(final.content))
        usage = final.usage
        notes: list[str] = []
        stop = final.stop_reason or "end_turn"
        if stop == "refusal":
            calls = []  # never run tools from a refused turn
            notes.append("refusal")
        elif stop == "max_tokens" and calls:
            raise ProviderError("truncated", "The model's tool input was truncated by max_tokens; not executing it.")
        yield TurnComplete(
            blocks=blocks,
            tool_calls=calls,
            stop_reason=stop,
            usage=TurnUsage(
                input_tokens=usage.input_tokens or 0,
                output_tokens=usage.output_tokens or 0,
                cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
                cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
            ),
            model=final.model or req.model,
            notes=notes,
        )
