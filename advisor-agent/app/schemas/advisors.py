"""Advisor Agent API contracts."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class CompetitionEvidence(StrictModel):
    title: str
    date: str | None = None
    source_url: str | None = None
    evidence_text: str | None = None
    evidence_type: str = "department_news_explicit_advising"


class AdvisorProfile(StrictModel):
    teacher_id: str = Field(min_length=1)
    teacher_name: str = Field(min_length=1)
    department: str | None = None
    expertise: list[str] | None = None
    research_areas: list[str] | None = None
    courses: list[str] | None = None
    advised_competitions: list[str] | None = None
    competition_evidence: list[CompetitionEvidence] = Field(default_factory=list)
    availability: Literal["available", "unavailable", "unknown"] = "unknown"
    profile_source: str | None = None
    is_synthetic: bool = False

    @field_validator("courses", mode="before")
    @classmethod
    def course_names(cls, value):
        """種子資料的開課紀錄有兩種寫法：課名字串，或含 course_id／course_name 的物件；統一成課名。"""
        if value is None:
            return None
        return [item.get("course_name") if isinstance(item, dict) else item for item in value]


class CompetitionContext(StrictModel):
    competition_id: str = Field(min_length=1)
    competition_name: str = Field(min_length=1)
    topic: str = ""
    required_skills: list[str] = Field(default_factory=list)
    related_courses: list[str] = Field(default_factory=list)
    competition_type: str | None = None


class StudentContext(StrictModel):
    student_id: str | None = None
    completed_courses: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)


class AdvisorMatchRequest(StrictModel):
    competition: CompetitionContext
    student: StudentContext = Field(default_factory=StudentContext)
    top_k: int = Field(default=5, ge=1, le=20)


class AdvisorDimension(StrictModel):
    weight: float
    score: float | None = None
    status: Literal["evaluated", "missing", "not_evaluated"]
    matched_items: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)


class AdvisorRecommendation(StrictModel):
    teacher_id: str
    teacher_name: str
    match_score: float | None
    score_coverage: float
    dimensions: dict[str, AdvisorDimension]
    expertise: list[str]
    reasons: list[str]
    evidence_ids: list[str]
    competition_evidence: list[CompetitionEvidence] = Field(default_factory=list)
    data_warnings: list[str] = Field(default_factory=list)
    is_synthetic: bool = False


class AdvisorMatchResponse(StrictModel):
    competition_id: str
    competition_name: str
    scoring_version: str = "advisor-v2"
    advisors: list[AdvisorRecommendation]
    notes: list[str] = Field(default_factory=list)
