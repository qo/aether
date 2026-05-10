from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Generic, TypeVar

T = TypeVar("T")


class InMemoryEventBus(Generic[T]):
    def __init__(self, maxsize: int = 1024) -> None:
        self._subscribers: set[asyncio.Queue[T]] = set()
        self._maxsize = maxsize

    async def publish(self, item: T) -> None:
        dead: list[asyncio.Queue[T]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:
                dead.append(queue)
        for queue in dead:
            self._subscribers.discard(queue)

    async def subscribe(self) -> AsyncIterator[T]:
        queue: asyncio.Queue[T] = asyncio.Queue(maxsize=self._maxsize)
        self._subscribers.add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers.discard(queue)
