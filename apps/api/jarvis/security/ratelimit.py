"""In-process sliding-window rate limiter.

JARVIS runs as a single API process per owner, so in-memory state is
sufficient. A multi-process deployment would swap this for Redis (see
docs/DECISIONS.md, D-009).
"""

from __future__ import annotations

import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def hit(self, key: str, *, limit: int, window_s: float) -> bool:
        """Record a hit. Returns False when the key is over its limit."""
        now = time.monotonic()
        q = self._hits[key]
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)

    def clear(self) -> None:
        self._hits.clear()


limiter = RateLimiter()
