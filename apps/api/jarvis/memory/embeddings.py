"""Pluggable text embedders for memory retrieval.

- `hashing-v1` (default): local, deterministic feature hashing — lexical, no network.
- `openai_compatible`: any `/v1/embeddings` endpoint (OpenAI, Voyage, Ollama `nomic-embed-text`,
  LM Studio, vLLM…). Configure JARVIS_EMBEDDINGS_PROVIDER=openai_compatible plus
  JARVIS_EMBEDDINGS_BASE_URL / _MODEL / _API_KEY.

Each memory stores the name of the embedder that produced its vector; retrieval only
compares vectors from the same embedder, and `reembed_all` migrates stored memories
after the provider changes.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol

from jarvis.config import get_settings
from jarvis.logging import get_logger

log = get_logger("embeddings")

HASH_DIM = 384
_WORD = re.compile(r"[a-z0-9][a-z0-9'_-]*")
_STOP = set(
    "a an the and or but of to in on at for with is are was were be been it this that i me my you your "
    "we our they them he she his her its as by from not do does did so if then than about into".split()
)


def tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


class Embedder(Protocol):
    name: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedder:
    name = "hashing-v1"

    def embed_one(self, text: str) -> list[float]:
        vec = [0.0] * HASH_DIM
        words = tokens(text)
        feats: list[tuple[str, float]] = [(w, 1.0) for w in words]
        feats += [(f"{a}_{b}", 0.7) for a, b in zip(words, words[1:], strict=False)]
        for w in words:
            padded = f"#{w}#"
            feats += [(padded[i : i + 3], 0.25) for i in range(len(padded) - 2)]
        for feat, weight in feats:
            h = hashlib.blake2b(feat.encode(), digest_size=8).digest()
            idx = int.from_bytes(h[:4], "little") % HASH_DIM
            vec[idx] += (1.0 if h[4] & 1 else -1.0) * weight
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self.embed_one(t) for t in texts]


class OpenAICompatEmbedder:
    def __init__(self, base_url: str, model: str, api_key: str | None, http_client: object | None = None) -> None:
        import openai

        self.model = model
        self.name = f"oa:{model}"[:40]
        self._client = openai.AsyncOpenAI(
            base_url=base_url, api_key=api_key or "not-needed", max_retries=2, timeout=30, http_client=http_client
        )

    async def embed(self, texts: list[str]) -> list[list[float]]:
        res = await self._client.embeddings.create(model=self.model, input=texts)
        vectors = [list(d.embedding) for d in sorted(res.data, key=lambda d: d.index)]
        out = []
        for v in vectors:  # normalise so cosine distance behaves uniformly across providers
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / n for x in v])
        return out


hashing = HashingEmbedder()
_configured: Embedder | None = None


def get_embedder() -> Embedder:
    global _configured
    if _configured is None:
        s = get_settings()
        if s.jarvis_embeddings_provider == "openai_compatible" and s.jarvis_embeddings_base_url:
            key = s.jarvis_embeddings_api_key.get_secret_value() if s.jarvis_embeddings_api_key else None
            _configured = OpenAICompatEmbedder(s.jarvis_embeddings_base_url, s.jarvis_embeddings_model, key)
        else:
            _configured = hashing
    return _configured


def set_embedder(embedder: Embedder | None) -> None:
    """Override the active embedder (tests, runtime reconfiguration)."""
    global _configured
    _configured = embedder


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], str]:
    """Embed with the configured provider; fall back to local hashing if it is unavailable."""
    emb = get_embedder()
    if emb is hashing:
        return await hashing.embed(texts), hashing.name
    try:
        return await emb.embed(texts), emb.name
    except Exception as exc:
        log.warning("embedding provider failed; using local hashing", error=type(exc).__name__)
        return await hashing.embed(texts), hashing.name


async def embed_text(text: str) -> tuple[list[float], str]:
    vectors, name = await embed_texts([text])
    return vectors[0], name
