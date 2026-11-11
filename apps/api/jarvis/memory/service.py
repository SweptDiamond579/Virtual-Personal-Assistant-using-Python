"""Long-term personal memory.

Pipeline
- Proposal: the agent (or a workflow) may only *propose* a memory. Proposals are
  inert until the user approves them in the Memory Centre. The user can create
  active memories directly.
- Safety: proposals that look like secrets (keys, passwords, card numbers) are
  rejected. `share_with_model=False` keeps a memory out of every model prompt.
- Contradictions: a new memory highly similar to an active one is flagged with
  `conflicts_with`; approving it with `supersede=True` archives the old ones.
- Retrieval: hybrid score = 0.65 * vector cosine + 0.35 * keyword overlap, over
  active, unexpired, model-shareable memories. Retrieval marks `last_used_at`.

Embeddings: the default `HashingEmbedder` is local and deterministic (feature
hashing of words, bigrams and character trigrams). It captures lexical overlap,
not deep semantics; an OpenAI-compatible embeddings endpoint can replace it via
JARVIS_EMBEDDINGS_* settings in a future iteration (docs/ROADMAP.md).
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import Memory

DIM = 384
_WORD = re.compile(r"[a-z0-9][a-z0-9'_-]*")
_STOP = set(
    "a an the and or but of to in on at for with is are was were be been it this that i me my you your "
    "we our they them he she his her its as by from not do does did so if then than about into".split()
)

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(ghp|gho|github_pat)_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"\b(?:\d[ -]?){13,19}\b"),
    re.compile(r"(?i)\b(password|passwd|pwd|api[_ -]?key|secret|token)\b\s*(is|=|:)\s*\S+"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def looks_sensitive(text: str) -> bool:
    return any(p.search(text) for p in SECRET_PATTERNS)


def tokens(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


class HashingEmbedder:
    name = "hashing-v1"

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * DIM
        words = tokens(text)
        feats: list[tuple[str, float]] = [(w, 1.0) for w in words]
        feats += [(f"{a}_{b}", 0.7) for a, b in zip(words, words[1:], strict=False)]
        for w in words:
            padded = f"#{w}#"
            feats += [(padded[i : i + 3], 0.25) for i in range(len(padded) - 2)]
        for feat, weight in feats:
            h = hashlib.blake2b(feat.encode(), digest_size=8).digest()
            idx = int.from_bytes(h[:4], "little") % DIM
            sign = 1.0 if h[4] & 1 else -1.0
            vec[idx] += sign * weight
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [v / norm for v in vec]


embedder = HashingEmbedder()


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=False))


def keyword_overlap(query: str, text: str) -> float:
    q = set(tokens(query))
    if not q:
        return 0.0
    t = set(tokens(text))
    return len(q & t) / len(q)


@dataclass
class ScoredMemory:
    memory: Memory
    score: float


class SensitiveContentError(ValueError):
    pass


async def find_conflicts(db: AsyncSession, user_id: str, content: str, kind: str) -> list[str]:
    vec = embedder.embed(content)
    rows = (
        (
            await db.execute(
                select(Memory).where(Memory.user_id == user_id, Memory.status == "active", Memory.kind == kind)
            )
        )
        .scalars()
        .all()
    )
    return [m.id for m in rows if m.embedding is not None and cosine(vec, list(m.embedding)) >= 0.6]


async def propose(
    db: AsyncSession,
    *,
    user_id: str,
    content: str,
    kind: str,
    source: str,
    provenance: dict,
    confidence: float = 0.7,
    active: bool = False,
    share_with_model: bool = True,
) -> Memory:
    content = content.strip()
    if not content:
        raise ValueError("memory content is empty")
    if len(content) > 2000:
        raise ValueError("memory content is too long (max 2000 characters)")
    if source != "user" and looks_sensitive(content):
        raise SensitiveContentError(
            "This looks like a credential or sensitive identifier; JARVIS will not store it as a memory."
        )
    conflicts = await find_conflicts(db, user_id, content, kind)
    mem = Memory(
        user_id=user_id,
        kind=kind,
        content=content,
        status="active" if active else "proposed",
        confidence=max(0.0, min(1.0, confidence)),
        source=source,
        provenance=provenance,
        share_with_model=share_with_model,
        conflicts_with=conflicts,
        embedding=embedder.embed(content),
        embedder=embedder.name,
    )
    db.add(mem)
    await db.flush()
    return mem


async def approve(db: AsyncSession, mem: Memory, *, supersede: bool) -> Memory:
    now = datetime.now(UTC)
    if supersede and mem.conflicts_with:
        olds = (await db.execute(select(Memory).where(Memory.id.in_(mem.conflicts_with)))).scalars().all()
        for old in olds:
            if old.user_id == mem.user_id:
                old.status = "archived"
                old.superseded_by = mem.id
                old.updated_at = now
    mem.status = "active"
    mem.updated_at = now
    await db.flush()
    return mem


async def search(
    db: AsyncSession,
    user_id: str,
    query: str,
    *,
    limit: int = 6,
    for_model: bool = False,
    min_score: float = 0.12,
    include_proposed: bool = False,
) -> list[ScoredMemory]:
    now = datetime.now(UTC)
    statuses = ["active", "proposed"] if include_proposed else ["active"]
    stmt = select(Memory).where(
        Memory.user_id == user_id,
        Memory.status.in_(statuses),
        or_(Memory.expires_at.is_(None), Memory.expires_at > now),
    )
    if for_model:
        stmt = stmt.where(Memory.share_with_model.is_(True))
    if not query.strip():
        rows = (await db.execute(stmt.order_by(Memory.updated_at.desc()).limit(limit))).scalars().all()
        return [ScoredMemory(m, 0.0) for m in rows]
    qv = embedder.embed(query)
    # pgvector pre-selects the nearest candidates; the hybrid score re-ranks them.
    stmt = stmt.where(Memory.embedder == embedder.name).order_by(Memory.embedding.cosine_distance(qv)).limit(64)
    rows = (await db.execute(stmt)).scalars().all()
    scored = []
    for m in rows:
        vec = cosine(qv, list(m.embedding)) if m.embedding is not None else 0.0
        score = 0.65 * max(vec, 0.0) + 0.35 * keyword_overlap(query, m.content)
        score *= 0.75 + 0.25 * m.confidence
        if score >= min_score:
            scored.append(ScoredMemory(m, score))
    scored.sort(key=lambda s: s.score, reverse=True)
    top = scored[:limit]
    if for_model:
        for s in top:
            s.memory.last_used_at = now
        await db.flush()
    return top
