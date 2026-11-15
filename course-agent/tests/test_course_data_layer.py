"""不依賴舊版技能資料的課程資料層測試。"""
import json
import sqlite3
from pathlib import Path

import pytest

from app.database import initialize_course_database


def test_course_only_rebuild_from_shared_seed(tmp_path):
    seed = json.loads(Path("data/seed/courses.json").read_text(encoding="utf-8"))
    students = json.loads(Path("tests/fixtures/synthetic_course_ids.json").read_text(encoding="utf-8"))
    db = tmp_path / "courses.sqlite"
    with pytest.raises(ValueError, match="尚未經人工確認"):
        initialize_course_database(db, seed)
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    with sqlite3.connect(db) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == {"courses"}
        assert conn.execute("SELECT count(*) FROM courses").fetchone()[0] == 16
        for course_ids in students.values():
            for course_id in course_ids:
                assert course_id.startswith("demo_")
                assert conn.execute("SELECT 1 FROM courses WHERE course_id=?", (course_id.removeprefix("demo_"),)).fetchone()


def test_course_only_does_not_delete_existing_tables(tmp_path):
    db = tmp_path / "existing.sqlite"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE skills (value TEXT)")
        conn.execute("INSERT INTO skills VALUES ('retain')")
    initialize_course_database(db, {"courses": []})
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT value FROM skills").fetchone() == ("retain",)
