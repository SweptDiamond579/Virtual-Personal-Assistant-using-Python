"""Provider adapters against recorded wire formats (no network, no credentials)."""

from __future__ import annotations

import json
from typing import Any

import httpx2
import pytest

from jarvis.providers.anthropic_provider import AnthropicProvider, to_anthropic_messages
from jarvis.providers.base import ProviderError, ProviderMessage, TextDelta, ToolSchema, TurnComplete, TurnRequest


def sse(events: list[dict[str, Any]]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


TOOL_TURN = [
    {
        "type": "message_start",
        "message": {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "claude-opus-5-5",
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 120, "output_tokens": 1, "cache_read_input_tokens": 100},
        },
    },
    {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
    {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-abc"}},
    {"type": "content_block_stop", "index": 0},
    {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Saving "}},
    {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "that note."}},
    {"type": "content_block_stop", "index": 1},
    {
        "type": "content_block_start",
        "index": 2,
        "content_block": {"type": "tool_use", "id": "toolu_1", "name": "notes_create", "input": {}},
    },
    {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"title": '}},
    {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '"Milk"}'}},
    {"type": "content_block_stop", "index": 2},
    {
        "type": "message_delta",
        "delta": {"stop_reason": "tool_use", "stop_sequence": None},
        "usage": {"output_tokens": 42},
    },
    {"type": "message_stop"},
]


def make_provider(handler: Any, *, fallback: bool = False) -> AnthropicProvider:
    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    return AnthropicProvider(
        "sk-ant-test",
        model="claude-opus-5-5",
        fast_model="claude-haiku-5-5",
        effort="medium",
        refusal_fallback=fallback,
        http_client=client,
    )


def request(**kw: Any) -> TurnRequest:
    return TurnRequest(
        system="sys",
        messages=[ProviderMessage("user", [{"type": "text", "text": "note milk"}])],
        tools=[
            ToolSchema("notes_create", "Create a note", {"type": "object", "properties": {"title": {"type": "string"}}})
        ],
        model=kw.get("model", "claude-opus-5-5"),
        max_tokens=1000,
    )


async def collect(provider: AnthropicProvider, req: TurnRequest) -> tuple[str, TurnComplete]:
    text, final = "", None
    async for ev in provider.stream_turn(req):
        if isinstance(ev, TextDelta):
            text += ev.text
        else:
            final = ev
    assert final is not None
    return text, final


async def test_anthropic_stream_with_tool_use_and_thinking() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen["body"] = json.loads(req.content)
        seen["headers"] = dict(req.headers)
        seen["url"] = str(req.url)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse(TOOL_TURN))

    text, turn = await collect(make_provider(handler), request())
    assert text == "Saving that note."
    assert turn.stop_reason == "tool_use"
    assert [c.name for c in turn.tool_calls] == ["notes_create"] and turn.tool_calls[0].input == {"title": "Milk"}
    assert turn.usage.input_tokens == 120 and turn.usage.output_tokens == 42 and turn.usage.cache_read_tokens == 100
    # The thinking block is preserved verbatim (with signature) for replay.
    assert turn.blocks[0]["type"] == "opaque" and turn.blocks[0]["block"]["signature"] == "sig-abc"
    body = seen["body"]
    assert seen["url"].startswith("https://api.anthropic.com/v1/messages")
    assert body["model"] == "claude-opus-5-5" and body["stream"] is True
    assert body["output_config"] == {"effort": "medium"}
    assert "thinking" not in body and "tool_choice" not in body and "temperature" not in body
    assert body["tools"][0]["eager_input_streaming"] is True
    assert body["cache_control"] == {"type": "ephemeral"}

    # Replay: the assistant turn converts back with thinking first, then text, then tool_use.
    replay = to_anthropic_messages([ProviderMessage("assistant", turn.blocks)])
    assert [b["type"] for b in replay[0]["content"]] == ["thinking", "text", "tool_use"]


async def test_anthropic_refusal_fallback_uses_beta() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen["body"] = json.loads(req.content)
        seen["beta"] = req.headers.get("anthropic-beta", "")
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse(TOOL_TURN))

    await collect(make_provider(handler, fallback=True), request())
    assert seen["body"]["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in seen["beta"]

    seen.clear()
    await collect(make_provider(handler, fallback=True), request(model="claude-haiku-5-5"))
    assert "fallbacks" not in seen["body"]  # Haiku has no server-side fallback


async def test_anthropic_refusal_never_runs_tools() -> None:
    events = [e for e in TOOL_TURN if e["type"] != "message_delta"] + []
    events.insert(
        -1,
        {
            "type": "message_delta",
            "delta": {"stop_reason": "refusal", "stop_sequence": None},
            "usage": {"output_tokens": 3},
        },
    )

    def handler(req: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse(events))

    _, turn = await collect(make_provider(handler), request())
    assert turn.tool_calls == [] and "refusal" in turn.notes


async def test_anthropic_max_tokens_with_tool_use_is_error() -> None:
    events = [e for e in TOOL_TURN if e["type"] != "message_delta"]
    events.insert(
        -1,
        {
            "type": "message_delta",
            "delta": {"stop_reason": "max_tokens", "stop_sequence": None},
            "usage": {"output_tokens": 1000},
        },
    )

    def handler(req: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=sse(events))

    with pytest.raises(ProviderError) as exc:
        await collect(make_provider(handler), request())
    assert exc.value.kind == "truncated"


@pytest.mark.parametrize(("status", "kind"), [(401, "auth"), (429, "rate_limit"), (400, "bad_request")])
async def test_anthropic_error_mapping(status: int, kind: str) -> None:
    def handler(req: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            status, json={"type": "error", "error": {"type": "x", "message": "nope"}}, headers={"retry-after": "0"}
        )

    provider = make_provider(handler)
    provider._client = provider._client.with_options(max_retries=0)  # type: ignore[attr-defined]
    with pytest.raises(ProviderError) as exc:
        await collect(provider, request())
    assert exc.value.kind == kind


def test_message_conversion_merges_and_skips() -> None:
    msgs = to_anthropic_messages(
        [
            ProviderMessage("user", [{"type": "text", "text": "ctx"}, {"type": "text", "text": "hi"}]),
            ProviderMessage(
                "assistant",
                [
                    {"type": "tool_call", "id": "t1", "name": "x", "input": {}},
                    {"type": "opaque", "provider": "openai", "block": {"x": 1}},
                ],
            ),
            ProviderMessage(
                "user", [{"type": "tool_result", "tool_call_id": "t1", "content": "ok", "is_error": False}]
            ),
            ProviderMessage("user", [{"type": "text", "text": "next"}]),
        ]
    )
    assert [m["role"] for m in msgs] == ["user", "assistant", "user"]
    assert [b["type"] for b in msgs[2]["content"]] == ["tool_result", "text"]
    assert msgs[1]["content"] == [{"type": "tool_use", "id": "t1", "name": "x", "input": {}}]


async def test_openai_compatible_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    from jarvis.providers.openai_compat import OpenAICompatProvider

    chunks = [
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "m",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hi "}, "finish_reason": None}],
        },
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "m",
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_1",
                                "type": "function",
                                "function": {"name": "calculate", "arguments": '{"expression"'},
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        },
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "m",
            "choices": [
                {
                    "index": 0,
                    "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ': "2+2"}'}}]},
                    "finish_reason": "tool_calls",
                }
            ],
        },
        {
            "id": "c",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "m",
            "choices": [],
            "usage": {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13},
        },
    ]
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
    seen: dict[str, Any] = {}

    def handler(req: httpx2.Request) -> httpx2.Response:
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    provider = OpenAICompatProvider("http://llm.local/v1", None, "m", http_client=client)
    text, final = "", None
    async for ev in provider.stream_turn(request(model="m")):
        if isinstance(ev, TextDelta):
            text += ev.text
        else:
            final = ev
    assert seen["url"] == "http://llm.local/v1/chat/completions"
    assert seen["body"]["tools"][0]["function"]["name"] == "notes_create"
    assert text == "Hi " and final is not None
    assert final.tool_calls[0].name == "calculate" and final.tool_calls[0].input == {"expression": "2+2"}
    assert final.usage.input_tokens == 9
