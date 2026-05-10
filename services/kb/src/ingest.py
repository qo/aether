from __future__ import annotations

import re
from pathlib import Path

from .schemas import KnowledgeDocument

LABEL_RE = re.compile(r"\[(Confirmed in code|Confirmed in docs|Observed in hardware|Inference|Unknown / needs verification)\]")


def ingest_markdown(root: str | Path) -> list[KnowledgeDocument]:
    base = Path(root)
    docs: list[KnowledgeDocument] = []
    for path in sorted(base.rglob("*.md")):
        text = path.read_text(encoding="utf-8")
        title = _first_heading(text) or path.stem.replace("_", " ").title()
        purpose = _purpose(text)
        labels = sorted(set(LABEL_RE.findall(text)))
        docs.append(KnowledgeDocument(path=path, title=title, purpose=purpose, text=text, verification_labels=labels))
    return docs


def _first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def _purpose(text: str) -> str:
    for line in text.splitlines():
        if line.lower().startswith("purpose:"):
            return line
    return "Purpose: not declared."
