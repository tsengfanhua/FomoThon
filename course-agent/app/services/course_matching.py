"""將已確認修課紀錄對應至 SQLite 課程。"""

import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from pydantic import ValidationError

from app.schemas.skills import Course, LegacyEnrollment


def match_enrollments(db_path: Path, enrollments: str | list[dict]) -> list[dict]:
    """依輸入順序回傳各筆匹配結果；重複紀錄均標記為 duplicate。"""
    if isinstance(enrollments, str):
        enrollments = json.loads(enrollments)
    if not isinstance(enrollments, list):
        raise ValueError("enrollments 必須是 JSON 陣列")

    results = []
    duplicate_keys = defaultdict(list)
    # mode=ro 避免路徑錯誤時意外建立空資料庫。
    with sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        for index, record in enumerate(enrollments):
            result = {"index": index, "status": None, "match_method": None, "course": None}
            results.append(result)
            if not isinstance(record, dict):
                result["status"] = "invalid_input"
                continue
            course_id = record.get("course_id")
            name = record.get("course_name")
            semester = record.get("semester")
            if any(value is not None and not isinstance(value, str) for value in (course_id, name, semester)):
                result["status"] = "invalid_input"
                continue
            course_id = course_id.strip() if course_id else None
            name = name.strip() if name else None
            semester = semester.strip() if semester else None
            if not semester or (not course_id and not name):
                result["status"] = "insufficient_data"
                continue
            try:
                LegacyEnrollment.model_validate({**record, "course_id": course_id or "__pending_match__"})
            except ValidationError:
                result["status"] = "invalid_input"
                continue

            if course_id:
                result["match_method"] = "course_id"
                rows = conn.execute("SELECT * FROM courses WHERE course_id = ?", (course_id,)).fetchall()
                duplicate_keys[(course_id, semester)].append(index)
            else:
                result["match_method"] = "course_name_semester"
                rows = conn.execute("SELECT * FROM courses WHERE course_name = ? AND semester = ?",
                                    (name, semester)).fetchall()
            if not rows:
                result["status"] = "not_found"
            elif len(rows) > 1:
                result["status"] = "ambiguous"
            elif rows[0]["semester"] != semester:
                result["status"] = "semester_mismatch"
            else:
                course = dict(rows[0])
                LegacyEnrollment.model_validate({**record, "course_id": course["course_id"]})
                result["course"] = Course.model_validate({key: course[key] for key in Course.model_fields}).model_dump()
                result["status"] = "matched"
                if not course_id:
                    duplicate_keys[(course["course_id"], semester)].append(index)

    for indices in duplicate_keys.values():
        if len(indices) > 1:
            for index in indices:
                results[index]["status"] = "duplicate"
                results[index]["course"] = None
    return results
