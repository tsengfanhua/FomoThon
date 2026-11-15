"""串接已確認修課、課程匹配、技能萃取及選用的評分。"""

from pathlib import Path
from typing import Callable

from app.services.course_matching import match_enrollments
from app.services.course_evidence_scoring import score_course_evidence
from app.services.skill_extraction import ExtractionResult, extract_course_skills
from app.services.skill_profile import build_skill_profile


def analyze_enrollments(enrollments: list[dict], db_path: Path, client_factory: Callable, *,
                        scoring_enabled: bool = False, numeric_scale: str | None = None) -> dict:
    matches = match_enrollments(db_path, enrollments)
    results = []
    courses = []
    matched_enrollments = []
    statuses = []
    client = None
    for match in matches:
        index = match["index"]
        if match["status"] != "matched":
            record = enrollments[index]
            results.append({"status": match["status"], "course_id": record.get("course_id"),
                            "semester": record.get("semester")})
            statuses.append({"index": index, "match_status": match["status"],
                             "match_method": match["match_method"], "course_id": record.get("course_id"),
                             "semester": record.get("semester"), "analysis_status": "not_analyzed", "error_reason": None})
            continue
        course = match["course"]
        courses.append(course)
        matched_enrollments.append({"course_id": course["course_id"], "semester": course["semester"],
                                    "grade": enrollments[index].get("grade")})
        try:
            if client is None:
                client = client_factory()
            extraction = extract_course_skills(course, client)
        except Exception:
            extraction = ExtractionResult(course_id=course["course_id"], course_name=course["course_name"],
                                          semester=course["semester"], status="failed", error_reason="analysis_unavailable")
        results.append(extraction)
        statuses.append({"index": index, "match_status": "matched", "match_method": match["match_method"],
                         "course_id": course["course_id"], "semester": course["semester"],
                         "analysis_status": extraction.status, "error_reason": extraction.error_reason})
    result = build_skill_profile(results)
    sidecar = score_course_evidence(result, courses, matched_enrollments, numeric_scale=numeric_scale) if scoring_enabled else None
    return {**result.model_dump(), "course_statuses": statuses, "scoring": sidecar}
