"""Pluggable embeddings: provider vectors drive retrieval, fallback, and re-embedding."""

from __future__ import annotations

import json

import httpx2
import pytest

from jarvis.db.session import db_session
from jarvis.memory import embeddings
from jarvis.memory import service as memory
from tests.conftest import AuthedClient

# A toy "semantic" space: words that mean the same thing share a dimension, so a paraphrase
# with no overlapping words still lands near the original. Stands in for a real model.
CONCEPTS = {
    "metric": 0,
    "units": 0,
    "measurement": 0,
    "system": 0,
    "kilometres": 0,
    "coffee": 1,
    "espresso": 1,
    "drink": 1,
    "morning": 1,
    "python": 2,
    "code": 2,
    "programming": 2,
}


def concept_vector(text: str) -> list[float]:
    v = [0.0] * 8
    for w in embeddings.tokens(text):
        v[CONCEPTS.get(w.strip("?.!,"), 7)] += 1.0
    return v


def make_provider(fail: bool = False) -> embeddings.OpenAICompatEmbedder:
    def handler(req: httpx2.Request) -> httpx2.Response:
        if fail:
            return httpx2.Response(503, json={"error": "down"})
        body = json.loads(req.content)
        data = [
            {"object": "embedding", "index": i, "embedding": concept_vector(t)} for i, t in enumerate(body["input"])
        ]
        return httpx2.Response(
            200,
            json={
                "object": "list",
                "data": data,
                "model": body["model"],
                "usage": {"prompt_tokens": 1, "total_tokens": 1},
            },
        )

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    emb = embeddings.OpenAICompatEmbedder("http://emb.local/v1", "toy-embed", None, http_client=client)
    emb._client = emb._client.with_options(max_retries=0)  # noqa: SLF001
    return emb


@pytest.fixture
def semantic_provider():  # noqa: ANN201
    embeddings.set_embedder(make_provider())
    yield
    embeddings.set_embedder(None)


async def test_semantic_retrieval_finds_paraphrase(owner: AuthedClient, semantic_provider: None) -> None:
    await owner.post("/api/memories", json={"content": "I prefer metric units"})
    await owner.post("/api/memories", json={"content": "Espresso every morning"})
    async with db_session() as db:
        hits = await memory.search(db, owner.user_id, "which measurement system?", for_model=True)
        coffee = await memory.search(db, owner.user_id, "what do I drink", for_model=True)
    assert hits and hits[0].memory.content == "I prefer metric units"
    assert hits[0].memory.embedder == "oa:toy-embed"
    assert coffee and coffee[0].memory.content.startswith("Espresso")


async def test_provider_failure_falls_back_to_local(owner: AuthedClient) -> None:
    embeddings.set_embedder(make_provider(fail=True))
    try:
        r = await owner.post("/api/memories", json={"content": "Fallback works offline"})
        assert r.status_code == 200
        async with db_session() as db:
            hits = await memory.search(db, owner.user_id, "fallback offline", for_model=True)
        assert hits and hits[0].memory.embedder == "hashing-v1"
    finally:
        embeddings.set_embedder(None)


async def test_reembed_migrates_and_keyword_bridge(owner: AuthedClient) -> None:
    await owner.post("/api/memories", json={"content": "I prefer metric units"})  # stored with hashing-v1
    embeddings.set_embedder(make_provider())
    try:
        # Before re-embedding the vector space differs, but keyword matching keeps it reachable.
        async with db_session() as db:
            assert await memory.search(db, owner.user_id, "metric", for_model=True)
        status = (await owner.get("/api/memories/embeddings/status")).json()
        assert status["active"] == "oa:toy-embed" and status["stale"] == 1
        assert (await owner.post("/api/memories/embeddings/reembed")).json()["reembedded"] == 1
        assert (await owner.get("/api/memories/embeddings/status")).json()["stale"] == 0
        async with db_session() as db:
            hits = await memory.search(db, owner.user_id, "measurement system", for_model=True)
        assert hits and hits[0].memory.content == "I prefer metric units"
    finally:
        embeddings.set_embedder(None)
