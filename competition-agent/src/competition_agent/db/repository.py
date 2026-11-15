"""Parameterized CRUD operations. Each mutation is its own transaction.

Use a dedicated connection, not an enclosing caller-managed transaction.
Raw SQL bypasses ESCO validation and is not a supported skill-write interface.
"""

import sqlite3
from competition_agent.skills.validation import SkillUriValidator


class CompetitionRepository:
    def __init__(self, connection: sqlite3.Connection, validator: SkillUriValidator | None = None):
        if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            raise RuntimeError("Foreign keys must be enabled")
        self.connection = connection
        self.validator = validator if validator is not None else SkillUriValidator()

    def create_competition(self, competition_name, organizer=None, status="draft") -> int:
        with self.connection:
            cursor = self.connection.execute(
                "INSERT INTO competitions (competition_name, organizer, status) VALUES (?, ?, ?)",
                (competition_name, organizer, status),
            )
        return cursor.lastrowid

    def get_competition(self, competition_id):
        return self.connection.execute("SELECT * FROM competitions WHERE competition_id = ?", (competition_id,)).fetchone()

    def list_competitions(self):
        return self.connection.execute("SELECT * FROM competitions ORDER BY competition_id").fetchall()

    def update_competition(self, competition_id, *, competition_name, organizer=None, status="draft") -> bool:
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE competitions SET competition_name=?, organizer=?, status=?, "
                "updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE competition_id=?",
                (competition_name, organizer, status, competition_id),
            )
        return cursor.rowcount == 1

    def delete_competition(self, competition_id) -> bool:
        with self.connection:
            cursor = self.connection.execute("DELETE FROM competitions WHERE competition_id=?", (competition_id,))
        return cursor.rowcount == 1

    def add_source(self, *, source_url, title, clean_content, source_school=None,
                   published_at=None, competition_id=None) -> tuple[int, bool]:
        """Return (source_id, inserted); duplicate URLs never overwrite or relink."""
        with self.connection:
            cursor = self.connection.execute(
                "INSERT INTO competition_sources "
                "(competition_id, source_school, source_url, published_at, title, clean_content) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_url) DO NOTHING",
                (competition_id, source_school, source_url, published_at, title, clean_content),
            )
            row = self.connection.execute("SELECT source_id FROM competition_sources WHERE source_url=?", (source_url,)).fetchone()
        return row[0], cursor.rowcount == 1

    def get_source(self, source_id):
        return self.connection.execute("SELECT * FROM competition_sources WHERE source_id=?", (source_id,)).fetchone()

    def list_sources(self, competition_id=None):
        """None lists unclassified announcements; an ID lists that competition's sources."""
        return self.connection.execute(
            "SELECT * FROM competition_sources WHERE competition_id IS ? ORDER BY source_id", (competition_id,)
        ).fetchall()

    def link_source(self, source_id, competition_id) -> bool:
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE competition_sources SET competition_id=? WHERE source_id=?", (competition_id, source_id)
            )
        return cursor.rowcount == 1

    def delete_source(self, source_id) -> bool:
        with self.connection:
            cursor = self.connection.execute("DELETE FROM competition_sources WHERE source_id=?", (source_id,))
        return cursor.rowcount == 1

    def add_skill(self, competition_id, concept_uri, importance, evidence) -> None:
        self.validator.require_valid(concept_uri)
        with self.connection:
            self.connection.execute(
                "INSERT INTO competition_skills VALUES (?, ?, ?, ?)",
                (competition_id, concept_uri, importance, evidence),
            )

    def list_skills(self, competition_id):
        return self.connection.execute(
            "SELECT * FROM competition_skills WHERE competition_id=? ORDER BY concept_uri", (competition_id,)
        ).fetchall()

    def update_skill(self, competition_id, concept_uri, *, importance, evidence) -> bool:
        self.validator.require_valid(concept_uri)
        with self.connection:
            cursor = self.connection.execute(
                "UPDATE competition_skills SET importance=?, evidence=? WHERE competition_id=? AND concept_uri=?",
                (importance, evidence, competition_id, concept_uri),
            )
        return cursor.rowcount == 1

    def delete_skill(self, competition_id, concept_uri) -> bool:
        with self.connection:
            cursor = self.connection.execute(
                "DELETE FROM competition_skills WHERE competition_id=? AND concept_uri=?", (competition_id, concept_uri)
            )
        return cursor.rowcount == 1
