from __future__ import annotations

import re
from pathlib import Path

from .ingest import ingest_markdown
from .schemas import SearchResult


def search_knowledge_base(root: str | Path, query: str, *, limit: int = 8) -> list[SearchResult]:
    terms = [term.lower() for term in re.findall(r"[a-zA-Z0-9_/-]+", query)]
    if not terms:
        return []

    results: list[SearchResult] = []
    for doc in ingest_markdown(root):
        haystack = doc.text.lower()
        title_score = sum(3 for term in terms if term in doc.title.lower())
        body_score = sum(haystack.count(term) for term in terms)
        score = float(title_score + body_score)
        if score <= 0:
            continue
        results.append(
            SearchResult(
                path=doc.path,
                title=doc.title,
                score=score,
                excerpt=_excerpt(doc.text, terms),
                verification_labels=doc.verification_labels,
            )
        )
    return sorted(results, key=lambda result: result.score, reverse=True)[:limit]


def _excerpt(text: str, terms: list[str]) -> str:
    lower = text.lower()
    first = min((lower.find(term) for term in terms if term in lower), default=0)
    start = max(0, first - 90)
    end = min(len(text), first + 220)
    return " ".join(text[start:end].split())
