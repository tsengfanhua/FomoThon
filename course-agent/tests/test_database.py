import json
import sqlite3
from pathlib import Path

import pytest

from app.database import initialize_course_database, initialize_database
from app.schemas.skills import Skill


@pytest.fixture
def synthetic_seed():
    return {
        "courses": [{"course_id": "c1", "course_name": "虛構課程", "semester": "114-2", "credits": 3,
                     "syllabus_text": "虛構課程示例", "review_status": "confirmed", "text_origin": "synthetic"}],
        "skills": [{"skill_id": "s1", "skill_name": "虛構技能", "category": "example"}],
        "course_skills": [{"course_id": "c1", "skill_id": "s1", "relevance": None,
                           "source_section": "description", "evidence_reference": "虛構證據",
                           "review_status": "pending"}],
    }


def test_taxonomy_ids_are_unique_and_validate():
    skills = json.loads(Path("data/seed/skills.json").read_text(encoding="utf-8"))
    validated = [Skill.model_validate(skill) for skill in skills]
    assert len({skill.skill_id for skill in validated}) == len(validated) == 16


def test_initialization_is_repeatable_and_foreign_keys_hold(tmp_path, synthetic_seed):
    db = tmp_path / "test.sqlite"
    initialize_database(db, synthetic_seed)
    initialize_database(db, synthetic_seed)
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        assert [conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("courses", "skills", "course_skills")] == [1, 1, 1]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO course_skills VALUES (?, ?, ?, ?, ?, ?)",
                         ("unknown", "s1", None, "test", "description", "pending"))


def test_unreviewed_data_requires_explicit_demo_flag(tmp_path, synthetic_seed):
    synthetic_seed["courses"][0]["review_status"] = "pending"
    with pytest.raises(ValueError, match="尚未經人工確認"):
        initialize_database(tmp_path / "data.sqlite", synthetic_seed)
    initialize_database(tmp_path / "data.sqlite", synthetic_seed, allow_unreviewed_demo=True)


def test_duplicate_and_invalid_foreign_key_rejected(tmp_path, synthetic_seed):
    synthetic_seed["courses"].append(dict(synthetic_seed["courses"][0]))
    with pytest.raises(ValueError, match="重複"):
        initialize_database(tmp_path / "data.sqlite", synthetic_seed)
    synthetic_seed["courses"].pop()
    synthetic_seed["course_skills"][0]["skill_id"] = "missing"
    with pytest.raises(sqlite3.IntegrityError):
        initialize_database(tmp_path / "data.sqlite", synthetic_seed)


def test_taxonomy_alone_is_not_a_course_seed(tmp_path):
    taxonomy = json.loads(Path("data/seed/skills.json").read_text(encoding="utf-8"))
    with pytest.raises(ValueError, match="seed 必須包含"):
        initialize_database(tmp_path / "data.sqlite", taxonomy)


def test_local_demo_seed_matches_all_students(tmp_path):
    from scripts.generate_synthetic_transcripts import STUDENTS
    path = Path("data/processed/course_seed_draft.json")
    if not path.exists():
        pytest.skip("本機待審課程 seed 未提供")
    seed = json.loads(path.read_text(encoding="utf-8"))
    assert seed["skills"] == json.loads(Path("data/seed/skills.json").read_text(encoding="utf-8"))
    db = tmp_path / "demo.sqlite"
    initialize_database(db, seed, allow_unreviewed_demo=True)
    initialize_database(db, seed, allow_unreviewed_demo=True)
    with sqlite3.connect(db) as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0] == 16
        for records in STUDENTS.values():
            for course_id, _, _ in records:
                assert conn.execute("SELECT course_id FROM courses WHERE course_id = ?", (course_id,)).fetchone() == (course_id,)


def test_shared_seed_rebuilds_and_matches_synthetic_students(tmp_path):
    seed = json.loads(Path("data/seed/courses.json").read_text(encoding="utf-8"))
    students = json.loads(Path("tests/fixtures/synthetic_course_ids.json").read_text(encoding="utf-8"))
    assert len(students) == 5
    assert all(course["review_status"] == "pending" for course in seed["courses"])
    db_path = tmp_path / "shared.sqlite"
    initialize_course_database(db_path, seed, allow_unreviewed_demo=True)
    initialize_course_database(db_path, seed, allow_unreviewed_demo=True)
    with sqlite3.connect(db_path) as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT COUNT(*) FROM courses").fetchone()[0] == 16
        for course_ids in students.values():
            assert 5 <= len(course_ids) <= 8
            for course_id in course_ids:
                assert conn.execute("SELECT 1 FROM courses WHERE course_id = ?", (course_id.removeprefix("demo_"),)).fetchone()
