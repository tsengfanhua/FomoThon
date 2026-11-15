import copy
import json
from pathlib import Path

import pytest

from app.schemas.skills import StudentSkillProfile
from app.services.skill_profile import build_skill_profile


def course(course_id, skills=(), *, semester="114-2", status="completed", knowledge=None, topics=None):
    return {"course_id": course_id, "course_name": "合成課程 " + course_id, "semester": semester,
            "status": status, "skills": [
                {"raw_skill_name": name, "normalized_skill_name": name, "skill_id": None,
                 "rationale": "合成理由", "evidence": quote, "evidence_basis": "course_scope",
                 "evidence_level": "contextual_quote", "review_status": "pending"}
                for name, quote in skills], "knowledge": knowledge or [], "topics": topics or [],
            "attempts": 1, "error_reason": None}


def test_same_skill_aliases_preserve_all_courses_and_schema():
    result = build_skill_profile([
        course("c1", [("Python 程式設計", "合成 Python 描述")]),
        course("c2", [("Python programming", "另一筆合成課程描述")]),
        course("c3", [("SQL", "SQL 相關描述")]),
        course("c4", [("結構化查詢語言", "查詢語言描述")]),
    ])
    assert result.status == "completed"
    assert StudentSkillProfile.model_validate(result.profile.model_dump()) == result.profile
    skills = {s.skill_name: s for s in result.profile.skills}
    assert set(skills) == {"Python", "SQL"}
    assert skills["Python"].skill_id == "python" and skills["SQL"].skill_id == "sql"
    assert all(m.mapping_status == "mapped" for m in result.skill_mappings)
    assert {e.course_id for e in skills["Python"].evidence} == {"c1", "c2"}
    assert {e.course_id for e in skills["SQL"].evidence} == {"c3", "c4"}
    assert all(e.review_status == "pending" and e.relevance is None for e in skills["SQL"].evidence)
    assert all(s.score is None and not s.confirmed and s.score_type == "not_evaluated" for s in skills.values())
    assert len(skills["SQL"].missing_dimensions) == 5
    assert all(d.semester == "114-2" for d in result.evidence_details)


def test_similar_names_are_not_fuzzy_merged():
    result = build_skill_profile([course("c1", [("資料分析", "一"), ("資料視覺化", "二"),
                                                 ("Python", "三"), ("Python 資料分析", "四")])])
    assert len(result.profile.skills) == 4
    mapping = {m.skill_name: m for m in result.skill_mappings}
    assert mapping["資料分析"].skill_id == "data_analysis" and mapping["資料分析"].mapping_status == "mapped"
    assert mapping["python 資料分析"].mapping_status == "unmapped"
    assert mapping["python 資料分析"].skill_id.startswith("candidate_v1_")


def test_duplicate_courses_and_evidence_do_not_increase_support():
    record = course("c1", [("SQL", "相同引文"), ("結構化查詢語言", "相同引文")])
    result = build_skill_profile([record, copy.deepcopy(record)])
    assert result.status == "completed"
    assert len(result.profile.skills) == len(result.profile.skills[0].evidence) == len(result.evidence_details) == 1
    assert sorted(result.evidence_details[0].raw_skill_names) == ["SQL", "結構化查詢語言"]


def test_same_course_different_semesters_preserved():
    result = build_skill_profile([course("c1", [("SQL", "相同引文")], semester="113-2"),
                                  course("c1", [("SQL", "相同引文")], semester="114-2")])
    assert result.status == "completed"
    assert len(result.profile.skills[0].evidence) == 2
    assert {item.semester for item in result.evidence_details} == {"113-2", "114-2"}


def test_conflicting_duplicate_courses_require_confirmation():
    result = build_skill_profile([course("c1", [("SQL", "一")]), course("c1", [("SQL", "二")]),
                                  course("c2", [("Python", "三")])])
    assert result.status == "needs_confirmation"
    assert result.issues == ["conflicting_course_results"]
    assert {d.course_id for d in result.evidence_details} == {"c2"}
    assert any(c.course_id == "c1" and c.status == "conflicting_results" for c in result.courses)
    assert result.profile.analysis_status == "partial"


def test_knowledge_and_topics_never_become_skills():
    concept = {"name": "虛構概念", "rationale": "理由", "evidence": "概念", "review_status": "pending"}
    result = build_skill_profile([course("c1", [("SQL", "引文")], knowledge=[concept], topics=[concept])])
    assert len(result.profile.skills) == 1
    assert result.courses[0].knowledge[0]["name"] == "虛構概念"
    assert result.courses[0].topics[0]["name"] == "虛構概念"


def test_failed_and_matching_failures_are_not_skills():
    result = build_skill_profile([course("c1", [("SQL", "引文")]), course("c2", status="failed"),
                                  {"status": "not_found", "course_id": "c3", "semester": "114-2"}])
    assert result.status == "partial" and result.profile.analysis_status == "partial"
    assert len(result.profile.skills) == 1
    assert {item.course_id for item in result.courses} == {"c1", "c2", "c3"}
    assert {"course_failed", "course_not_found"} <= set(result.issues)


def test_ambiguity_requests_confirmation_even_with_other_valid_courses():
    result = build_skill_profile([course("c1", [("SQL", "引文")]), {"status": "ambiguous"}])
    assert result.status == "needs_confirmation" and "ambiguous" in result.issues


def test_empty_results_and_insufficient_evidence():
    assert build_skill_profile([]).status == "failed"
    empty = build_skill_profile([course("c1", status="insufficient_evidence")])
    assert empty.status == "partial" and empty.profile.skills == []
    assert empty.profile.analysis_status == "insufficient_data"
    assert build_skill_profile([course("c1", status="failed")]).profile is None
    assert build_skill_profile([course("c1", status="failed")]).status == "failed"


def test_unfinished_or_invalid_skill_not_accepted():
    invalid = course("c1", [("SQL", "引文")], status="failed")
    result = build_skill_profile([invalid])
    assert result.status == "needs_confirmation" and result.profile is None
    assert not result.evidence_details
    result = build_skill_profile([course("c2", [])])
    assert result.status == "needs_confirmation" and result.profile is None


def test_order_independence_and_stable_ids():
    records = [course("c1", [("Python", "一"), ("SQL", "二")]),
               course("c2", [("Python programming", "三")])]
    first = build_skill_profile(records).model_dump()
    assert build_skill_profile(list(reversed(records))).model_dump() == first
    assert build_skill_profile(records).model_dump() == first
    assert {s["skill_id"] for s in first["profile"]["skills"]} == {"python", "sql"}


def test_all_seed_names_use_shared_ids():
    seed = json.loads(Path("data/seed/skills.json").read_text(encoding="utf-8"))
    record = course("c1", [(skill["skill_name"], "引文") for skill in seed])
    result = build_skill_profile([record])
    assert {s.skill_id for s in result.profile.skills} == {s["skill_id"] for s in seed}
    assert all(m.mapping_status == "mapped" for m in result.skill_mappings)


def test_alias_collision_rejected(monkeypatch, tmp_path):
    (tmp_path / "skills.json").write_text(json.dumps([
        {"skill_id": "one", "skill_name": "One", "category": "test"},
        {"skill_id": "two", "skill_name": "Two", "category": "test"}]), encoding="utf-8")
    (tmp_path / "skill_aliases.json").write_text(json.dumps({"one": ["Two"]}), encoding="utf-8")
    monkeypatch.setattr("app.services.skill_profile.SEED_DIR", tmp_path)
    with pytest.raises(ValueError, match="對應多個 ID"):
        build_skill_profile([])


def test_unmapped_id_stable_and_never_assumed_known():
    first = build_skill_profile([course("c1", [("未知技能", "原文")])])
    second = build_skill_profile([course("c2", [("未知技能", "其他原文")])])
    assert first.skill_mappings[0].mapping_status == "unmapped"
    assert first.skill_mappings[0].skill_id == second.skill_mappings[0].skill_id
    assert first.skill_mappings[0].skill_id.startswith("candidate_v1_")


@pytest.mark.parametrize("status", ["ambiguous", "duplicate", "insufficient_data", "semester_mismatch", "needs_review"])
def test_confirmation_statuses(status):
    assert build_skill_profile([{"status": status}]).status == "needs_confirmation"
