"""SQLite 課程資料庫：建立資料表與匯入 seed。"""

import sqlite3
from pathlib import Path

from app.schemas.skills import Course, Skill, SkillEvidence


COURSE_SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    course_id TEXT NOT NULL PRIMARY KEY,
    course_name TEXT NOT NULL,
    semester TEXT NOT NULL,
    credits REAL NOT NULL CHECK (credits >= 0),
    syllabus_text TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed')),
    text_origin TEXT NOT NULL CHECK (text_origin IN ('original_excerpt', 'paraphrased', 'synthetic'))
);
"""

SCHEMA = COURSE_SCHEMA + """
CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT NOT NULL PRIMARY KEY,
    skill_name TEXT NOT NULL,
    category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS course_skills (
    course_id TEXT NOT NULL REFERENCES courses(course_id),
    skill_id TEXT NOT NULL REFERENCES skills(skill_id),
    relevance TEXT CHECK (relevance IN ('strong', 'medium') OR relevance IS NULL),
    evidence_reference TEXT NOT NULL,
    source_section TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected')),
    CHECK (review_status <> 'confirmed' OR relevance IS NOT NULL),
    PRIMARY KEY (course_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_course_skills_skill_id ON course_skills(skill_id);
"""


def initialize_course_database(db_path: Path, seed: dict, *, allow_unreviewed_demo: bool = False) -> None:
    """僅建立及匯入課程；不變更資料庫中既有的其他表格。"""
    if not isinstance(seed, dict) or not isinstance(seed.get("courses"), list):
        raise ValueError("seed 必須包含 courses 陣列")
    courses = seed["courses"]
    for course in courses:
        Course.model_validate({key: course[key] for key in Course.model_fields})
        if course["review_status"] not in {"pending", "confirmed"}:
            raise ValueError("課程審查狀態無效")
        if course["text_origin"] not in {"original_excerpt", "paraphrased", "synthetic"}:
            raise ValueError("課綱來源類型無效")
    if not allow_unreviewed_demo and any(course["review_status"] != "confirmed" for course in courses):
        raise ValueError("課程 seed 尚未經人工確認；僅本機展示可使用 allow_unreviewed_demo")
    if len({course["course_id"] for course in courses}) != len(courses):
        raise ValueError("seed 包含重複識別碼")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(COURSE_SCHEMA)
        with conn:
            conn.executemany("""INSERT INTO courses VALUES (:course_id,:course_name,:semester,:credits,:syllabus_text,:review_status,:text_origin)
                ON CONFLICT(course_id) DO UPDATE SET course_name=excluded.course_name, semester=excluded.semester,
                credits=excluded.credits, syllabus_text=excluded.syllabus_text, review_status=excluded.review_status, text_origin=excluded.text_origin""", courses)


def initialize_database(db_path: Path, seed: dict, *, allow_unreviewed_demo: bool = False) -> None:
    """驗證 seed 並以單一交易更新資料；不刪除既有資料。"""
    if not isinstance(seed, dict) or any(not isinstance(seed.get(key), list) for key in ("courses", "skills", "course_skills")):
        raise ValueError("seed 必須包含 courses、skills 與 course_skills 陣列")
    courses = seed["courses"]
    skills = seed["skills"]
    links = seed["course_skills"]
    for course in courses:
        Course.model_validate({k: course[k] for k in Course.model_fields})
        if course["review_status"] not in {"pending", "confirmed"}:
            raise ValueError("課程審查狀態無效")
        if course["text_origin"] not in {"original_excerpt", "paraphrased", "synthetic"}:
            raise ValueError("課綱來源類型無效")
    if not allow_unreviewed_demo and any(course["review_status"] != "confirmed" for course in courses):
        raise ValueError("課程 seed 尚未經人工確認；僅本機展示可使用 allow_unreviewed_demo")
    for skill in skills:
        Skill.model_validate(skill)
    for link in links:
        SkillEvidence.model_validate({**link, "source_type": "syllabus"})
        if link["review_status"] == "confirmed" and link["relevance"] is None:
            raise ValueError("已確認的技能關聯必須提供關聯程度")
    for items, keys in ((courses, ("course_id",)), (skills, ("skill_id",)), (links, ("course_id", "skill_id"))):
        identifiers = [tuple(item[key] for key in keys) for item in items]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("seed 包含重複識別碼")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA)
        with conn:
            conn.executemany("""INSERT INTO courses VALUES (:course_id,:course_name,:semester,:credits,:syllabus_text,:review_status,:text_origin)
                ON CONFLICT(course_id) DO UPDATE SET course_name=excluded.course_name, semester=excluded.semester,
                credits=excluded.credits, syllabus_text=excluded.syllabus_text, review_status=excluded.review_status, text_origin=excluded.text_origin""", courses)
            conn.executemany("""INSERT INTO skills VALUES (:skill_id,:skill_name,:category)
                ON CONFLICT(skill_id) DO UPDATE SET skill_name=excluded.skill_name, category=excluded.category""", skills)
            conn.executemany("""INSERT INTO course_skills VALUES (:course_id,:skill_id,:relevance,:evidence_reference,:source_section,:review_status)
                ON CONFLICT(course_id,skill_id) DO UPDATE SET relevance=excluded.relevance, evidence_reference=excluded.evidence_reference,
                source_section=excluded.source_section, review_status=excluded.review_status""", links)
