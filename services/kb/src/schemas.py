from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class KnowledgeDocument:
    path: Path
    title: str
    purpose: str
    text: str
    tags: list[str] = field(default_factory=list)
    verification_labels: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SearchResult:
    path: Path
    title: str
    score: float
    excerpt: str
    verification_labels: list[str]
