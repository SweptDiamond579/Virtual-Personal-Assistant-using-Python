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

Embeddings come from `jarvis.memory.embeddings`: local feature hashing by default
(lexical), or any OpenAI-compatible embeddings endpoint for semantic retrieval.
Vectors are only compared with vectors from the same embedder; keyword matches
over all memories are always included so nothing becomes unreachable while
`reembed_all` migrates stored vectors after a provider change.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import Memory
from jarvis.memory.embeddings import embed_text, embed_texts, get_embedder, tokens

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


async def find_conflicts(
    db: AsyncSession, user_id: str, content: str, kind: str, vec: list[float] | None = None, name: str | None = None
) -> list[str]:
    if vec is None or name is None:
        vec, name = await embed_text(content)
    rows = (
        (
            await db.execute(
                select(Memory).where(Memory.user_id == user_id, Memory.status == "active", Memory.kind == kind)
            )
        )
        .scalars()
        .all()
    )
    threshold = 0.6 if name == "hashing-v1" else 0.85  # neural embedders score paraphrases higher
    return [
        m.id
        for m in rows
        if m.embedding is not None and m.embedder == name and cosine(vec, list(m.embedding)) >= threshold
    ]


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
    vec, name = await embed_text(content)
    conflicts = await find_conflicts(db, user_id, content, kind, vec, name)
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
        embedding=vec,
        embedder=name,
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
    qv, qname = await embed_text(query)
    # pgvector pre-selects the nearest candidates from the same embedder…
    vector_rows = (
        (
            await db.execute(
                stmt.where(Memory.embedder == qname).order_by(Memory.embedding.cosine_distance(qv)).limit(64)
            )
        )
        .scalars()
        .all()
    )
    # …and keyword matches over all memories keep everything reachable (e.g. during re-embedding).
    words = [w for w in tokens(query) if len(w) > 2][:8]
    keyword_rows = []
    if words:
        keyword_rows = (
            (await db.execute(stmt.where(or_(*[Memory.content.ilike(f"%{w}%") for w in words])).limit(64)))
            .scalars()
            .all()
        )
    rows = list({m.id: m for m in [*vector_rows, *keyword_rows]}.values())
    scored = []
    for m in rows:
        same = m.embedding is not None and m.embedder == qname
        vec = cosine(qv, list(m.embedding)) if same else 0.0
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


async def reembed_all(db: AsyncSession, user_id: str | None = None, batch: int = 64) -> int:
    """Re-embed memories whose vectors came from a different embedder than the active one."""
    target = get_embedder().name
    stmt = select(Memory).where(or_(Memory.embedder != target, Memory.embedding.is_(None)))
    if user_id:
        stmt = stmt.where(Memory.user_id == user_id)
    rows = (await db.execute(stmt)).scalars().all()
    done = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i : i + batch]
        vectors, name = await embed_texts([m.content for m in chunk])
        if name != target:
            break  # provider unavailable: keep existing vectors rather than downgrade
        for m, v in zip(chunk, vectors, strict=True):
            m.embedding, m.embedder = v, name
        done += len(chunk)
        await db.flush()
    return done
