import copy

import pytest

from app.services.course_evidence_scoring import score_course_evidence
from app.services.skill_profile import build_skill_profile
from test_skill_profile import course


def inputs(basis="explicit_activity", grade=85):
    record = course("c1", [("SQL", "練習 SQL")])
    record["skills"][0]["evidence_basis"] = basis
    return build_skill_profile([record]), [{"course_id": "c1", "semester": "114-2", "syllabus_text": "課程練習 SQL 查詢"}], [{"course_id": "c1", "semester": "114-2", "grade": grade}]


@pytest.mark.parametrize(("basis", "expected"), [("explicit_activity", 70), ("learning_objective", 58), ("course_scope", 46)])
def test_single_course_and_basis(basis, expected):
    profile, sources, grades = inputs(basis)
    score = score_course_evidence(profile, sources, grades, numeric_scale="0_100")
    assert score["skills"][0]["score"] == expected
    assert not score["skills"][0]["confirmed"]
    assert profile.profile.skills[0].evidence[0].review_status == "pending"


def test_multiple_courses_and_duplicates():
    record = course("c2", [("SQL", "SQL 資料庫")])
    profile, sources, grades = inputs()
    profile = build_skill_profile([course("c1", [("SQL", "練習 SQL")]), record, copy.deepcopy(record)])
    sources.append({"course_id": "c2", "semester": "114-2", "syllabus_text": "SQL 資料庫"})
    grades.append({"course_id": "c2", "semester": "114-2", "grade": 100})
    result = score_course_evidence(profile, sources + sources, grades + grades, numeric_scale="0_100")
    assert len(result["skills"][0]["courses"]) == 2
    assert result["skills"][0]["score"] == 52
    assert result == score_course_evidence(profile, sources, grades, numeric_scale="0_100")


@pytest.mark.parametrize("grade", [None, "unknown", 101])
def test_missing_or_invalid_grade(grade):
    profile, sources, grades = inputs(grade=grade)
    item = score_course_evidence(profile, sources, grades, numeric_scale="0_100")["skills"][0]
    assert item["score"] is None and item["coverage"] == "partial_or_missing"
    assert item["courses"][0]["dimension_scores"]["syllabus_relevance"] == 60


def test_scale_letter_and_missing_relevance():
    profile, sources, grades = inputs(grade="A")
    assert score_course_evidence(profile, sources, grades)["skills"][0]["score"] is None
    assert score_course_evidence(profile, sources, grades, letter_grades={"A": 90})["skills"][0]["score"] == 72
    sources[0]["syllabus_text"] = "不同原文"
    item = score_course_evidence(profile, sources, grades, letter_grades={"A": 90})["skills"][0]["courses"][0]
    assert item["score"] is None and item["dimension_scores"]["syllabus_relevance"] is None


def test_disabled_profile_unchanged_and_deterministic():
    profile, sources, grades = inputs()
    before = profile.model_dump()
    assert score_course_evidence(profile, sources, grades, numeric_scale="0_100") == score_course_evidence(profile, sources, grades, numeric_scale="0_100")
    assert profile.model_dump() == before
    assert profile.profile.skills[0].score is None


def test_no_cross_course_dimension_combination_and_conflicts():
    profile, sources, grades = inputs()
    record = course("c2", [("SQL", "SQL 操作")])
    profile = build_skill_profile([course("c1", [("SQL", "練習 SQL")]), record])
    grades = [{"course_id": "c2", "semester": "114-2", "grade": 90}]
    result = score_course_evidence(profile, sources, grades, numeric_scale="0_100")
    assert result["skills"][0]["score"] is None
    grades = [{"course_id": "c1", "semester": "114-2", "grade": 80},
              {"course_id": "c1", "semester": "114-2", "grade": 90}]
    result = score_course_evidence(profile, sources, grades, numeric_scale="0_100")
    assert result["skills"][0]["courses"][0]["grade_status"] == "conflicting"
    assert result["skills"][0]["score"] is None


@pytest.mark.parametrize(("name", "quote", "match", "score"), [
    ("資料庫管理系統操作", "熟悉資料庫管理系統的操作", "inserted_de", 55.6),
    ("結構化查詢語言設計", "學習結構化查詢語言的設計技巧", "inserted_de", 55.6),
    ("資料庫應用系統分析、設計與實作", "資料庫應用系統的分析、設計及實作的能力", "needs_review", None),
    ("SQL", "課堂練習 SQL 查詢", "exact", 55.6),
    ("資料庫操作", "學習網路設定", "needs_review", None),
    ("SQL", "本課程不教授 SQL", "needs_review", None),
    ("資料庫的操作", "資料庫操作", "needs_review", None),
])
def test_evidence_text_matching(name, quote, match, score):
    record = course("c1", [(name, quote)])
    record["skills"][0]["evidence_basis"] = "learning_objective"
    result = score_course_evidence(build_skill_profile([record]),
        [{"course_id": "c1", "semester": "114-2", "syllabus_text": "課程內容：" + quote}],
        [{"course_id": "c1", "semester": "114-2", "grade": 79}], numeric_scale="0_100")
    skill = result["skills"][0]
    evidence = skill["courses"][0]["evidence"][0]
    assert result["scoring_version"] == "course_evidence_v0.2"
    assert evidence["quote_in_source"] is True
    assert evidence["support_match"] == match
    assert evidence["review_status"] == "pending" and skill["confirmed"] is False
    assert skill["score"] == score


def test_unchanged_strict_quote_check_and_unknown_source():
    profile, sources, grades = inputs()
    sources[0]["syllabus_text"] = "課程練習的 SQL 查詢"
    evidence = score_course_evidence(profile, sources, grades, numeric_scale="0_100")["skills"][0]["courses"][0]["evidence"][0]
    assert evidence["quote_in_source"] is False and evidence["support_match"] == "exact"
    assert evidence["relevance_score"] is None
    evidence = score_course_evidence(profile, [], grades, numeric_scale="0_100")["skills"][0]["courses"][0]["evidence"][0]
    assert evidence["quote_in_source"] is None and evidence["relevance_score"] is None
