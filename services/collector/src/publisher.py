from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass
class _Subscriber(Generic[T]):
    """One subscriber on an InMemoryEventBus.

    Holds the bounded asyncio.Queue plus a monotonic counter of items
    dropped because the subscriber couldn't keep up. The WS handler reads
    `lag` periodically and forwards it to the client so a slow tab knows
    it has missed frames.
    """

    queue: "asyncio.Queue[T]"
    lag: int = 0  # items dropped since the last reader read
    total_lag: int = 0  # items dropped over the lifetime of the subscriber


class InMemoryEventBus(Generic[T]):
    """Async fan-out bus with drop-oldest backpressure.

    Behaviour change vs. the prior version: when a subscriber's queue is
    full, the publisher does NOT discard the subscriber. Instead it drops
    the OLDEST queued item (so the subscriber still sees the most-recent
    state) and increments a per-subscriber `lag` counter. This is the
    right tradeoff for the WS handler — the UI cares about "what's
    happening now," not "every window in arrival order while paused."

    For raw frames the same rule applies, but the WS handler already
    rate-limits raw fan-out to ~30 Hz, so backpressure rarely fires there.
    """

    def __init__(self, maxsize: int = 64) -> None:
        # Default queue depth is 64 — tuned for ~3 s of derived windows
        # (one per ~50 ms, i.e. ~20 Hz). A truly stalled subscriber loses
        # the oldest items but is never disconnected.
        self._subscribers: set[_Subscriber[T]] = set()
        self._maxsize = maxsize

    async def publish(self, item: T) -> None:
        for sub in list(self._subscribers):
            try:
                sub.queue.put_nowait(item)
            except asyncio.QueueFull:
                # Drop the oldest queued item to make room for the new
                # one. This is cheap and keeps the subscriber aligned
                # with the live edge of the stream.
                try:
                    sub.queue.get_nowait()
                except asyncio.QueueEmpty:  # race window — fine
                    pass
                sub.lag += 1
                sub.total_lag += 1
                try:
                    sub.queue.put_nowait(item)
                except asyncio.QueueFull:
                    # Should not happen after a get_nowait, but be safe.
                    pass

    async def subscribe(self) -> AsyncIterator[T]:
        sub = _Subscriber[T](queue=asyncio.Queue(maxsize=self._maxsize))
        self._subscribers.add(sub)
        try:
            while True:
                yield await sub.queue.get()
        finally:
            self._subscribers.discard(sub)

    def subscribe_with_handle(self) -> tuple["AsyncIterator[T]", "_BusHandle[T]"]:
        """Return both the iterator and a handle to read drop counters.

        The WS handler uses this to surface lag to the client. The
        iterator behaves identically to ``subscribe()``.
        """
        sub = _Subscriber[T](queue=asyncio.Queue(maxsize=self._maxsize))
        self._subscribers.add(sub)

        async def iterator() -> AsyncIterator[T]:
            try:
                while True:
                    yield await sub.queue.get()
            finally:
                self._subscribers.discard(sub)

        return iterator(), _BusHandle(sub)


@dataclass
class _BusHandle(Generic[T]):
    """Read-only view of a subscriber's lag counters."""

    _sub: _Subscriber[T] = field(repr=False)

    def take_lag(self) -> int:
        """Return the number of dropped items since the last call, then reset."""
        n = self._sub.lag
        self._sub.lag = 0
        return n

    @property
    def total_lag(self) -> int:
        return self._sub.total_lag

    @property
    def queued(self) -> int:
        return self._sub.queue.qsize()
