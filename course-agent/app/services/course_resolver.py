"""以學期、選課代碼及課名保守查找課程索引。"""

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from app.services.skill_extraction import _plain_text


def _public_course(course):
    return {("course_code" if key == "selection_code" else key): value for key, value in course.items()}


def resolve_local_course(db_path: Path, enrollment: dict) -> dict:
    """回傳唯一完整課程或需要後續處理的明確狀態。"""
    year = enrollment.get("academic_year")
    semester = enrollment.get("semester")
    name = (enrollment.get("course_name") or "").strip()
    code = enrollment.get("course_code", enrollment.get("selection_code"))
    if "course_code" in enrollment and "selection_code" in enrollment and enrollment["course_code"] != enrollment["selection_code"]:
        return {"status": "needs_confirmation", "reason": "conflicting_course_code_fields", "candidates": []}
    if not year or not semester or not name or (code is not None and not isinstance(code, str)):
        return {"status": "needs_confirmation", "candidates": []}
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM courses WHERE year=? AND semester=?", (year, semester)).fetchall()
    candidates = [dict(row) for row in rows if row["course_name"].strip() == name
                  and (not code or row["selection_code"] == code)]
    for course in candidates:
        course["targets"] = json.loads(course["targets"])
        course["weekly_schedule"] = json.loads(course["weekly_schedule"])
    if len(candidates) > 1:
        return {"status": "ambiguous", "candidates": [_public_course(c) for c in candidates]}
    if not candidates:
        return {"status": "not_found", "candidates": []}
    course = candidates[0]
    complete = (bool(_plain_text(course["description"]))
                and any(_plain_text(value) for value in course["targets"])
                and any(_plain_text(week.get("tpd_reading")) or _plain_text(week.get("tpd_learn"))
                        for week in course["weekly_schedule"]))
    return {"status": "matched" if complete else "incomplete", "course": _public_course(course)}


def resolve_course(db_path: Path, enrollment: dict, fetcher=None) -> dict:
    """本地優先；僅在身分可確認時匯入網站備援。"""
    import hashlib
    from datetime import datetime
    from urllib.parse import urlparse, parse_qs
    import re
    from app.services.syllabus_client import fetch_syllabus, SyllabusError

    fetcher = fetcher or fetch_syllabus
    local = resolve_local_course(db_path, enrollment)
    if local["status"] == "matched":
        return local
    if local["status"] not in ("incomplete", "not_found", "ambiguous"):
        return local
    code = enrollment.get("course_code", enrollment.get("selection_code")) or (local.get("course") or {}).get("course_code")
    year, semester, name = enrollment.get("academic_year"), enrollment.get("semester"), (enrollment.get("course_name") or "").strip()
    if not code or not isinstance(code, str):
        return {"status": "needs_confirmation", "reason": "course_code_required"}
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        names = {row[0].strip() for row in conn.execute(
            "SELECT course_name FROM courses WHERE year=? AND semester=? AND selection_code=?", (year, semester, code))}
        if len(names) > 1 or (names and name not in names):
            return {"status": "needs_confirmation", "reason": "conflicting_course_code"}
        has_cache = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='website_course_sources'").fetchone()
        cached = None
        if has_cache:
            cached = conn.execute("SELECT course_id FROM website_course_sources WHERE year=? AND semester=? AND selection_code=? AND course_name=?", (year, semester, code, name)).fetchone()
    if cached:
        from app.database import get_indexed_course
        course = get_indexed_course(db_path, cached[0])
        if course:
            # 若同名有另一筆完整課綱，仍須人工決定。
            if local["status"] == "ambiguous":
                others = [c for c in local["candidates"] if c["course_id"] != cached[0]]
                for other in others:
                    if (other["description"] and other["targets"] and other["weekly_schedule"]):
                        return {"status": "ambiguous", "candidates": local["candidates"]}
            return {"status": "matched", "course": _public_course(course), "source": "website_cache"}
    if local["status"] == "ambiguous":
        return local
    try:
        data = fetcher(year, semester, code, name)
    except SyllabusError as exc:
        return {"status": "website_error", "reason": exc.reason}
    # 不信任備援實作直接提供的識別欄位。
    info = data.get("identity") or {}
    url = urlparse(data.get("source_url", ""))
    if (data.get("year") != int(year) or data.get("semester") != int(semester)
            or data.get("course_code") != code or data.get("course_name", "").strip() != name
            or str(info.get("yms_year")) not in (str(year), str(year) + ".0")
            or str(info.get("yms_smester")) not in (str(semester), str(semester) + ".0")
            or info.get("scr_selcode") != code or (info.get("sub_name") or "").strip() != name
            or not all(info.get(k) for k in ("sub_id", "cls_id", "scr_dup"))
            or url.scheme != "https" or not re.fullmatch(r"coursesearch\d*\.fcu\.edu\.tw", url.hostname or "")
            or url.path != "/CourseOutline.aspx" or parse_qs(url.query) != {"lang": ["cht"], "courseid": [f"{year}{semester}{code}"]}
            or not data.get("fetched_at")
            or not data.get("description") or not data.get("targets") or not data.get("weekly_schedule")):
        return {"status": "needs_confirmation", "reason": "identity_mismatch"}
    try:
        if datetime.fromisoformat(data["fetched_at"]).utcoffset() is None:
            raise ValueError
    except (ValueError, TypeError):
        return {"status": "needs_confirmation", "reason": "invalid_source_time"}
    payload = [int(year), int(semester), code, data["course_name"], data["description"], data["targets"], data["weekly_schedule"]]
    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    course_id = f"{year}-{semester}-{code}-{hashlib.sha256(serialized.encode('utf-8')).hexdigest()}"
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=rw", uri=True)) as conn:
        with conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS website_course_sources (
                year INTEGER NOT NULL, semester INTEGER NOT NULL, selection_code TEXT NOT NULL,
                course_name TEXT NOT NULL, course_id TEXT NOT NULL REFERENCES courses(course_id),
                source_url TEXT NOT NULL, fetched_at TEXT NOT NULL, identity_json TEXT NOT NULL,
                PRIMARY KEY(year,semester,selection_code,course_name))""")
            conn.execute("INSERT OR IGNORE INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (course_id, *payload[:5], json.dumps(payload[5], ensure_ascii=False), json.dumps(payload[6], ensure_ascii=False)))
            conn.execute("INSERT OR IGNORE INTO website_course_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                         (year, semester, code, name, course_id, data["source_url"], data["fetched_at"], json.dumps(info, ensure_ascii=False)))
            saved = conn.execute("SELECT course_id FROM website_course_sources WHERE year=? AND semester=? AND selection_code=? AND course_name=?", (year, semester, code, name)).fetchone()[0]
    from app.database import get_indexed_course
    return {"status": "matched", "course": _public_course(get_indexed_course(db_path, saved)), "source": "website"}
