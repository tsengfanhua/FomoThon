import json
import sqlite3

from app.services.course_resolver import resolve_local_course


def test_local_resolution_preserves_code_and_detects_ambiguity(tmp_path):
    db = tmp_path / "courses.sqlite"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE courses (course_id, year, semester, selection_code, course_name, description, targets, weekly_schedule)")
        row = ("a", 113, 2, "0037", "甲", "介紹", json.dumps(["目標"]), json.dumps([{"tpd_learn": "練習"}]))
        conn.execute("INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row)
        conn.execute("INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("b", 113, 2, "0037", "乙", None, "[]", "[]"))
    enrollment = {"academic_year": 113, "semester": 2, "course_code": "0037", "course_name": "甲"}
    assert resolve_local_course(db, enrollment)["status"] == "matched"
    assert resolve_local_course(db, {**enrollment, "course_name": "乙"})["status"] == "incomplete"
    assert resolve_local_course(db, {**enrollment, "course_code": "37"})["status"] == "not_found"
    assert resolve_local_course(db, {**enrollment, "course_code": None})["status"] == "matched"
    assert resolve_local_course(db, {**enrollment, "selection_code": "0099"})["reason"] == "conflicting_course_code_fields"
    legacy = {key: value for key, value in enrollment.items() if key != "course_code"}
    legacy["selection_code"] = "0037"
    assert resolve_local_course(db, legacy)["course"]["course_code"] == "0037"
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO courses SELECT 'c', year, semester, selection_code, course_name, description, targets, weekly_schedule FROM courses WHERE course_id='a'")
    assert resolve_local_course(db, enrollment)["status"] == "ambiguous"
