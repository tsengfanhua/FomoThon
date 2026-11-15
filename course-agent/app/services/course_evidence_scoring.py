"""以已確認修課資料及課程原文計算實驗性修課證據分數。"""

from collections import defaultdict
from dataclasses import dataclass, field
from math import isfinite

from app.services.skill_profile import ProfileResult


@dataclass(frozen=True)
class ScoringRules:
    version: str = "course_evidence_v0.2"
    relevance_weight: float = 0.6
    grade_weight: float = 0.4
    basis_scores: dict[str, float] = field(default_factory=lambda: {
        "explicit_activity": 60.0, "learning_objective": 40.0, "course_scope": 20.0,
    })


RULES = ScoringRules()


def _support_match(names: list[str], quote: str) -> str:
    """僅辨識逐字匹配，以及技能名稱內插入一次「的」。"""
    if any(word in quote for word in ("不", "未", "無", "非", "沒有")):
        return "needs_review"
    if any(name in quote for name in names):
        return "exact"
    if any(name[:i] + "的" + name[i:] in quote
           for name in names for i in range(1, len(name))):
        return "inserted_de"
    return "needs_review"


def _grade(value, numeric_scale, letter_grades):
    if value is None or value == "":
        return None, "missing"
    if isinstance(value, str) and value in letter_grades:
        value = letter_grades[value]
    elif numeric_scale != "0_100":
        return None, "scale_not_provided"
    if isinstance(value, bool):
        return None, "unparseable"
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None, "unparseable"
    if not isfinite(number) or not 0 <= number <= 100:
        return None, "unparseable"
    return number, "evaluated"


def score_course_evidence(profile_result: ProfileResult, courses: list[dict], enrollments: list[dict], *,
                          numeric_scale: str | None = None, letter_grades: dict | None = None) -> dict:
    """回傳獨立評分 sidecar；呼叫端須提供已確認修課紀錄與匹配課程原文。"""
    letter_grades = letter_grades or {}
    sources = defaultdict(set)
    grades = defaultdict(set)
    grade_inputs = defaultdict(list)
    for course in courses:
        if isinstance(course.get("course_id"), str) and isinstance(course.get("semester"), str) and isinstance(course.get("syllabus_text"), str):
            sources[(course["course_id"], course["semester"])].add(course["syllabus_text"])
    for enrollment in enrollments:
        if isinstance(enrollment.get("course_id"), str) and isinstance(enrollment.get("semester"), str):
            key = (enrollment["course_id"], enrollment["semester"])
            grades[key].add(_grade(enrollment.get("grade"), numeric_scale, letter_grades))
            if enrollment.get("grade") not in grade_inputs[key]:
                grade_inputs[key].append(enrollment.get("grade"))

    grouped = defaultdict(list)
    for detail in profile_result.evidence_details:
        grouped[(detail.skill_id, detail.course_id, detail.semester)].append(detail)
    skills = []
    for skill in profile_result.profile.skills if profile_result.profile else []:
        course_scores = []
        for (skill_id, course_id, semester), details in sorted(grouped.items()):
            if skill_id != skill.skill_id:
                continue
            key = (course_id, semester)
            source = next(iter(sources[key])) if len(sources[key]) == 1 else None
            evidence = []
            values = []
            for detail in details:
                quote_in_source = None if source is None else detail.evidence in source
                support_match = _support_match(detail.raw_skill_names, detail.evidence)
                verified = bool(quote_in_source and any(name in detail.evidence for name in detail.raw_skill_names))
                basis_values = [RULES.basis_scores[b] for b in detail.evidence_bases if b in RULES.basis_scores]
                relevance = min(basis_values) if quote_in_source and support_match != "needs_review" and basis_values else None
                if relevance is not None:
                    values.append(relevance)
                evidence.append({"quote": detail.evidence, "raw_skill_names": detail.raw_skill_names,
                                 "evidence_bases": detail.evidence_bases, "source_verified": verified,
                                 "quote_in_source": quote_in_source, "support_match": support_match,
                                 "relevance_score": relevance, "review_status": "pending"})
            relevance = max(values) if values else None
            grade_entries = grades[key]
            grade, grade_status = next(iter(grade_entries)) if len(grade_entries) == 1 else (None, "missing" if not grade_entries else "conflicting")
            score = round(RULES.relevance_weight * relevance + RULES.grade_weight * grade, 2) if relevance is not None and grade is not None else None
            course_scores.append({"course_id": course_id, "semester": semester, "course_name": details[0].course_name,
                "score": score, "dimension_scores": {"syllabus_relevance": relevance, "course_grade": grade},
                "grade_status": grade_status, "grade_inputs": sorted(grade_inputs[key], key=str), "evidence": evidence})
        complete = [item["score"] for item in course_scores if item["score"] is not None]
        skills.append({"skill_id": skill.skill_id, "skill_name": skill.skill_name,
                       "score": max(complete) if complete else None,
                       "coverage": "at_least_one_complete_course" if complete else "partial_or_missing",
                       "complete_course_count": len(complete), "course_count": len(course_scores),
                       "confirmed": False, "courses": course_scores})
    return {"score_type": "course_skill_evidence", "scoring_version": RULES.version,
            "weights": {"syllabus_relevance": RULES.relevance_weight, "course_grade": RULES.grade_weight},
            "grade_policy": {"numeric_scale": numeric_scale, "letter_grades": dict(sorted(letter_grades.items()))},
            "skills": skills}
