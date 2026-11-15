"""114-2 課程 Seed 可獨立匯入並對應合成修課紀錄。"""
import json
import sqlite3
from pathlib import Path

from app.database import initialize_course_database


def test_114_2_seed_rebuilds_without_original_excel(tmp_path):
    seed = json.loads(Path("data/seed/courses.json").read_text(encoding="utf-8"))
    students = json.loads(Path("tests/fixtures/synthetic_course_ids.json").read_text(encoding="utf-8"))
    courses = seed["courses"]
    assert len(courses) == len({course["course_id"] for course in courses}) == 16
    assert all(course["semester"] == "114-2" and course["text_origin"] == "original_excerpt"
               and course["review_status"] == "pending" for course in courses)
    db = tmp_path / "courses.sqlite"
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0] == 16
        for ids in students.values():
            for demo_id in ids:
                assert demo_id.startswith("demo_")
                assert conn.execute("SELECT 1 FROM courses WHERE course_id=?", (demo_id.removeprefix("demo_"),)).fetchone()
