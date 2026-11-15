import pytest
from pydantic import ValidationError

from app.schemas.skills import SCHEMA_VERSION, DimensionScore, Enrollment, StudentSkill, StudentSkillProfile


def test_dimension_status_and_grade_validation():
    assert Enrollment(course_id="c1", semester="114-2", grade=None).grade is None
    with pytest.raises(ValidationError):
        Enrollment(course_id="c1", semester="114-2", grade=101)
    with pytest.raises(ValidationError):
        DimensionScore(weight=0.4, status="missing", score=0)
    with pytest.raises(ValidationError):
        DimensionScore(weight=0.4, status="evaluated", score=None)


def test_profile_does_not_require_student_id():
    profile = StudentSkillProfile(skills=[], scoring_version="draft", analysis_status="insufficient_data")
    assert SCHEMA_VERSION == "0.1-draft"
    assert profile.student_id is None


def test_partial_profile_never_claims_full_score():
    dimensions = {
        "syllabus_relevance": {"weight": 0.4, "status": "evaluated", "score": 100},
        "course_grade": {"weight": 0.2, "status": "missing", "score": None},
        "practice_project": {"weight": 0.2, "status": "not_evaluated", "score": None},
        "portfolio_certification": {"weight": 0.1, "status": "missing", "score": None},
        "recency": {"weight": 0.1, "status": "not_evaluated", "score": None},
    }
    data = {"skill_id": "python", "skill_name": "Python", "score_type": "five_dimension_estimate",
            "scoring_version": "draft", "dimension_scores": dimensions,
            "missing_dimensions": ["course_grade", "practice_project", "portfolio_certification", "recency"]}
    skill = StudentSkill.model_validate(data)
    profile = StudentSkillProfile(student_id="student_demo", skills=[skill], scoring_version="draft", analysis_status="partial")
    assert profile.skills[0].score is None
    assert not profile.skills[0].confirmed
    with pytest.raises(ValidationError):
        StudentSkill.model_validate({**data, "score": 85})
    with pytest.raises(ValidationError):
        StudentSkill.model_validate({**data, "missing_dimensions": []})
    dimensions["recency"]["weight"] = 0.2
    with pytest.raises(ValidationError):
        StudentSkill.model_validate(data)
