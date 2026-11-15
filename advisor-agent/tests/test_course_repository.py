import json
from pathlib import Path

import pytest

from app.services.course_repository import CourseRepository
from scripts.generate_synthetic_transcripts import STUDENTS


def test_repository_uses_internal_course_id(tmp_path):
    path = tmp_path / "courses.json"
    path.write_text(json.dumps([{"course_id": "example", "syllabus_semester": "114-2"}]), encoding="utf-8")
    repository = CourseRepository(path)
    assert repository.get("example")["syllabus_semester"] == "114-2"
    assert repository.get("unknown") is None


def test_local_courses_match_synthetic_students_and_overlap():
    path = Path("data/processed/courses.json")
    if not path.exists():
        pytest.skip("本機受保護課程資料未提供")
    courses = json.loads(path.read_text(encoding="utf-8"))
    by_id = {course["course_id"]: course for course in courses}
    assert len(by_id) == 16
    for enrollments in STUDENTS.values():
        assert 5 <= len(enrollments) <= 8
        for course_id, course_name, _ in enrollments:
            assert course_name
            assert by_id[course_id]["syllabus_semester"] == "114-2"
    for enrollments in STUDENTS.values():
        skills = [skill["skill_id"] for course_id, _, _ in enrollments
                  for skill in by_id[course_id]["skills"]]
        assert len(skills) > len(set(skills))
