"""將單課程技能候選轉成可追溯的跨課程 Profile。"""

import hashlib
import json
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from app.schemas.skills import DimensionScore, DimensionScores, Skill, SkillEvidence, StudentSkill, StudentSkillProfile
from app.services.skill_extraction import ExtractionResult


def _key(name: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


SEED_DIR = Path(__file__).resolve().parents[2] / "data" / "seed"
SCORING_VERSION = "not_evaluated_v1"
DIMENSION_WEIGHTS = {"syllabus_relevance": 0.4, "course_grade": 0.2, "practice_project": 0.2,
                     "portfolio_certification": 0.1, "recency": 0.1}


class EvidenceDetails(BaseModel):
    skill_id: str
    course_id: str
    course_name: str
    semester: str
    evidence: str
    raw_skill_names: list[str]
    rationales: list[str]
    evidence_bases: list[str]
    evidence_levels: list[str]
    review_status: Literal["pending"] = "pending"


class CourseAnalysis(BaseModel):
    course_id: str | None
    semester: str | None
    status: str
    knowledge: list[dict] = Field(default_factory=list)
    topics: list[dict] = Field(default_factory=list)


class SkillMapping(BaseModel):
    skill_id: str
    skill_name: str
    mapping_status: Literal["mapped", "unmapped"]


class ProfileResult(BaseModel):
    status: Literal["completed", "partial", "needs_confirmation", "failed"]
    profile: StudentSkillProfile | None
    evidence_details: list[EvidenceDetails] = Field(default_factory=list)
    skill_mappings: list[SkillMapping] = Field(default_factory=list)
    courses: list[CourseAnalysis] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)


def _load_skill_mappings() -> dict[str, Skill]:
    skills = [Skill.model_validate(item) for item in json.loads((SEED_DIR / "skills.json").read_text(encoding="utf-8"))]
    aliases = json.loads((SEED_DIR / "skill_aliases.json").read_text(encoding="utf-8"))
    by_id = {skill.skill_id: skill for skill in skills}
    if len(by_id) != len(skills) or not isinstance(aliases, dict):
        raise ValueError("技能 ID 重複或別名表格式錯誤")
    if any(skill_id.startswith("candidate_v1_") for skill_id in by_id):
        raise ValueError("共用技能 ID 不可使用暫定 ID 前綴")
    if any(skill_id not in by_id or not isinstance(names, list) for skill_id, names in aliases.items()):
        raise ValueError("別名表包含未知技能 ID 或無效清單")
    mappings = {}
    for skill in skills:
        for name in (skill.skill_name, *aliases.get(skill.skill_id, [])):
            if not isinstance(name, str) or not _key(name):
                raise ValueError("技能別名必須是非空字串")
            key = _key(name)
            if key in mappings and mappings[key].skill_id != skill.skill_id:
                raise ValueError("技能名稱或別名對應多個 ID")
            mappings[key] = skill
    return mappings


def _name_and_id(name: str, mappings: dict[str, Skill]) -> tuple[str, str, str]:
    key = _key(name)
    if key in mappings:
        skill = mappings[key]
        return skill.skill_name, skill.skill_id, "mapped"
    return key, "candidate_v1_" + hashlib.sha256(key.encode("utf-8")).hexdigest(), "unmapped"


def build_skill_profile(results: list[ExtractionResult | dict]) -> ProfileResult:
    """彙整同一位使用者的課程結果，不處理使用者身分或評分。"""
    mappings = _load_skill_mappings()
    groups = defaultdict(list)
    issues = set()
    other_courses = []
    requires_confirmation = False
    has_failures = False
    for item in results:
        data = item.model_dump() if isinstance(item, ExtractionResult) else item
        if not isinstance(data, dict):
            has_failures = True
            issues.add("invalid_result")
            continue
        status = data.get("status")
        if status in {"ambiguous", "duplicate", "insufficient_data", "semester_mismatch", "needs_review"}:
            requires_confirmation = True
            issues.add(str(status))
        elif status not in {"completed", "insufficient_evidence"}:
            has_failures = True
            issues.add("course_" + str(status) if isinstance(status, str) else "invalid_result")
        if status not in {"completed", "insufficient_evidence", "failed", "needs_review"}:
            other_courses.append(CourseAnalysis(course_id=data.get("course_id") if isinstance(data.get("course_id"), str) else None,
                                                semester=data.get("semester") if isinstance(data.get("semester"), str) else None,
                                                status=str(status)))
            continue
        try:
            result = ExtractionResult.model_validate(data)
        except ValidationError:
            has_failures = True
            issues.add("invalid_result")
            continue
        if not result.course_id.strip() or not result.course_name.strip() or not result.semester.strip():
            has_failures = True
            issues.add("invalid_result")
            continue
        if result.status == "completed" and not result.skills:
            requires_confirmation = True
            issues.add("completed_without_skills")
            continue
        if result.status != "completed" and result.skills:
            requires_confirmation = True
            issues.add("inconsistent_result")
            continue
        groups[(result.course_id, result.semester)].append(result)

    chosen = []
    for course_key, entries in sorted(groups.items()):
        unique = {json.dumps(entry.model_dump(), ensure_ascii=False, sort_keys=True): entry for entry in entries}
        if len(unique) != 1:
            requires_confirmation = True
            issues.add("conflicting_course_results")
            other_courses.append(CourseAnalysis(course_id=course_key[0], semester=course_key[1],
                                                status="conflicting_results"))
            continue
        chosen.append(next(iter(unique.values())))

    by_evidence = {}
    names = {}
    mapping_statuses = {}
    courses = other_courses
    for course in chosen:
        courses.append(CourseAnalysis(course_id=course.course_id, semester=course.semester, status=course.status,
                                     knowledge=[item.model_dump() for item in course.knowledge],
                                     topics=[item.model_dump() for item in course.topics]))
        if course.status == "insufficient_evidence":
            has_failures = True
            issues.add("insufficient_evidence")
        if course.status != "completed":
            continue
        for skill in course.skills:
            name, skill_id, mapping_status = _name_and_id(skill.raw_skill_name, mappings)
            names[skill_id] = name
            mapping_statuses[skill_id] = mapping_status
            key = (skill_id, course.course_id, course.semester, skill.evidence)
            if key not in by_evidence:
                by_evidence[key] = {"course_name": course.course_name, "raw_names": set(),
                                    "rationales": set(), "bases": set(), "levels": set()}
            by_evidence[key]["raw_names"].add(skill.raw_skill_name)
            by_evidence[key]["rationales"].add(skill.rationale)
            by_evidence[key]["bases"].add(skill.evidence_basis)
            by_evidence[key]["levels"].add(skill.evidence_level)

    details = []
    evidence_by_skill = defaultdict(list)
    for (skill_id, course_id, semester, quote), values in sorted(by_evidence.items()):
        details.append(EvidenceDetails(skill_id=skill_id, course_id=course_id, course_name=values["course_name"],
                                       semester=semester, evidence=quote, raw_skill_names=sorted(values["raw_names"]),
                                       rationales=sorted(values["rationales"]), evidence_bases=sorted(values["bases"]),
                                       evidence_levels=sorted(values["levels"])))
        evidence_by_skill[skill_id].append(SkillEvidence(course_id=course_id, skill_id=skill_id,
            source_type="course_description", source_section="description", relevance=None,
            evidence_reference=quote, review_status="pending"))

    if not results:
        has_failures = True
        issues.add("no_courses")
    if requires_confirmation:
        status = "needs_confirmation"
    elif not any(course.status in {"completed", "insufficient_evidence"} for course in chosen):
        status = "failed"
    elif has_failures:
        status = "partial"
    else:
        status = "completed"

    skills = []
    for skill_id in sorted(names):
        dimensions = DimensionScores(**{key: DimensionScore(weight=weight, score=None, status="not_evaluated")
                                         for key, weight in DIMENSION_WEIGHTS.items()})
        skills.append(StudentSkill(skill_id=skill_id, skill_name=names[skill_id], score=None,
            score_type="not_evaluated", scoring_version=SCORING_VERSION, evidence=evidence_by_skill[skill_id],
            confirmed=False, dimension_scores=dimensions, missing_dimensions=list(DIMENSION_WEIGHTS)))
    profile = None
    if any(course.status in {"completed", "insufficient_evidence"} for course in chosen):
        profile = StudentSkillProfile(skills=skills, scoring_version=SCORING_VERSION,
            analysis_status="complete" if status == "completed" else "partial" if skills else "insufficient_data")
    courses.sort(key=lambda course: (course.course_id or "", course.semester or "", course.status))
    skill_mappings = [SkillMapping(skill_id=skill_id, skill_name=names[skill_id], mapping_status=mapping_statuses[skill_id])
                      for skill_id in sorted(names)]
    return ProfileResult(status=status, profile=profile, evidence_details=details, skill_mappings=skill_mappings,
                         courses=courses, issues=sorted(issues))
