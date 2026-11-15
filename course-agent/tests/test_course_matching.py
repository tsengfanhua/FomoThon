import json
import sqlite3
from pathlib import Path

import pytest

from app.database import initialize_course_database
from app.services.course_matching import match_enrollments


@pytest.fixture
def database(tmp_path):
    seed = json.loads(Path("data/seed/courses.json").read_text(encoding="utf-8"))
    db = tmp_path / "courses.sqlite"
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    return db


def test_shared_seed_and_confirmed_enrollments(database):
    records = Path("tests/fixtures/confirmed_enrollments.json").read_text(encoding="utf-8")
    results = match_enrollments(database, records)
    assert [item["status"] for item in results] == ["matched", "matched"]
    assert results[0]["match_method"] == "course_id"
    assert results[0]["course"]["course_id"] == "course_001"
    assert set(results[0]["course"]) == {"course_id", "course_name", "semester", "credits", "syllabus_text"}


def test_name_semester_exact_match_and_failures(database):
    results = match_enrollments(database, [
        {"course_name": "Python程式設計", "semester": "114-2"},
        {"course_id": "unknown", "course_name": "Python程式設計", "semester": "114-2"},
        {"course_name": "Python", "semester": "114-2"},
        {"course_name": "Python程式設計"},
        {"course_id": "course_001", "semester": "113-2"},
        {"course_id": "course_001", "semester": "114-2", "grade": 101},
    ])
    assert [r["status"] for r in results] == ["matched", "not_found", "not_found", "insufficient_data", "semester_mismatch", "invalid_input"]
    assert results[0]["match_method"] == "course_name_semester"
    assert all(r["course"] is None for r in results[1:])


def test_duplicates_across_match_methods_mark_every_record(database):
    results = match_enrollments(database, [
        {"course_id": "course_001", "semester": "114-2"},
        {"course_name": "Python程式設計", "semester": "114-2"},
    ])
    assert [r["status"] for r in results] == ["duplicate", "duplicate"]
    assert all(r["course"] is None for r in results)


def test_ambiguous_name_does_not_choose(database):
    with sqlite3.connect(database) as conn:
        conn.execute("INSERT INTO courses SELECT 'other', course_name, semester, credits, syllabus_text, review_status, text_origin FROM courses WHERE course_id = 'course_001'")
    result = match_enrollments(database, [{"course_name": "Python程式設計", "semester": "114-2"}])[0]
    assert result["status"] == "ambiguous"
    assert result["course"] is None


def test_missing_database_is_not_created(tmp_path):
    db = tmp_path / "missing.sqlite"
    with pytest.raises(sqlite3.OperationalError):
        match_enrollments(db, [])
    assert not db.exists()
