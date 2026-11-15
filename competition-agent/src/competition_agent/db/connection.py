"""Connections always enforce local foreign keys; initialization is non-destructive."""

from pathlib import Path
import sqlite3


def connect(path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        connection.close()
        raise RuntimeError("SQLite foreign key enforcement unavailable")
    return connection


def initialize(connection: sqlite3.Connection) -> None:
    if connection.in_transaction:
        raise RuntimeError("Initialize outside an active transaction")
    if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise RuntimeError("Foreign keys must be enabled")
    version = connection.execute("PRAGMA user_version").fetchone()[0]
    if version not in (0, 1, 2, 3):
        raise RuntimeError(f"Unsupported database version: {version}")
    if version == 3:
        return
    schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8") if version == 0 else ""
    if version < 2:
        schema += Path(__file__).with_name("migration_v2.sql").read_text(encoding="utf-8")
    schema += Path(__file__).with_name("migration_v3.sql").read_text(encoding="utf-8")
    try:
        connection.executescript("BEGIN IMMEDIATE;\n" + schema + "\nPRAGMA user_version = 3;\nCOMMIT;")
    except Exception:
        connection.rollback()
        raise
