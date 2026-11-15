"""Explicitly configured, read-only ESCO development catalogue (no automatic fallback)."""
from pathlib import Path
import hashlib
import json
import sqlite3


class LocalEscoRepository:
    def __init__(self, path: str | Path):
        self.connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
        self.connection.row_factory = sqlite3.Row
        try:
            self.connection.execute("PRAGMA query_only=ON")
            self.connection.execute("SELECT concept_uri, preferred_label, description FROM esco_skills LIMIT 0")
        except Exception:
            self.connection.close()
            raise

    def get(self, concept_uri: str) -> dict | None:
        row = self.connection.execute(
            "SELECT concept_uri, preferred_label, description FROM esco_skills WHERE concept_uri=?",
            (concept_uri,),
        ).fetchone()
        return dict(row) if row is not None else None

    def search(self, query: str, limit: int = 20) -> list[dict]:
        """Literal substring search of English label/description; deterministic label-first order.

        SQLite LIKE is case-insensitive for ASCII English. This is not semantic search
        or Chinese translation. Percent/underscore are literals, not wildcards.
        """
        if not isinstance(query, str):
            raise ValueError("query must be text")
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("limit must be an integer from 1 to 100")
        if not query.strip():
            return []
        escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = "%" + escaped + "%"
        rows = self.connection.execute(
            "SELECT concept_uri, preferred_label, description FROM esco_skills "
            "WHERE preferred_label LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' "
            "ORDER BY CASE WHEN preferred_label LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, "
            "preferred_label COLLATE NOCASE, concept_uri LIMIT ?",
            (pattern, pattern, pattern, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def close(self):
        self.connection.close()

    def fingerprint(self) -> str:
        """Content fingerprint, independent of SQLite file layout. Read-only."""
        digest = hashlib.sha256()
        for row in self.connection.execute(
                "SELECT concept_uri,preferred_label,description FROM esco_skills ORDER BY concept_uri"):
            digest.update((json.dumps(tuple(row), ensure_ascii=False) + "\n").encode("utf-8"))
        return digest.hexdigest()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
