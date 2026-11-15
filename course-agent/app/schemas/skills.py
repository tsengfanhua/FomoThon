"""課程、技能及學生技能檔案的共用契約 v0.1 draft。"""

from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "0.1-draft"


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Skill(ContractModel):
    skill_id: str = Field(min_length=1)
    skill_name: str = Field(min_length=1)
    category: str = Field(min_length=1)


class Course(ContractModel):
    course_id: str = Field(min_length=1)
    course_name: str = Field(min_length=1)
    semester: str = Field(min_length=1)
    credits: float = Field(ge=0, allow_inf_nan=False)
    syllabus_text: str = Field(min_length=1)


class LegacyEnrollment(ContractModel):
    course_id: str | None = None
    academic_year: int | None = None
    course_name: str | None = None
    semester: str | int
    course_code: str | None = Field(default=None, validation_alias=AliasChoices("course_code", "selection_code"))
    credits: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    grade: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)

    @field_validator("grade", mode="before")
    @classmethod
    def reject_boolean_grade(cls, value):
        if isinstance(value, bool):
            raise ValueError("成績須為 0～100 的數值")
        return value

    @model_validator(mode="after")
    def validate_enrollment(self):
        if self.academic_year is not None:
            if not self.course_name or self.semester not in (1, 2, 3, 4, "1", "2", "3", "4"):
                raise ValueError("新版修課紀錄需要課名與學期")
        return self


class Enrollment(ContractModel):
    """新版成績單欄位；內部課程 ID 僅由解析後的匹配結果提供。"""

    academic_year: int
    semester: int
    course_code: str | None = Field(default=None, validation_alias=AliasChoices("course_code", "selection_code"))
    course_name: str = Field(min_length=1)
    credits: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    grade: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)

    @field_validator("grade", mode="before")
    @classmethod
    def reject_boolean_grade(cls, value):
        if isinstance(value, bool):
            raise ValueError("成績須為 0～100 的數值")
        return value

    @field_validator("semester")
    @classmethod
    def validate_semester(cls, value):
        if value not in (1, 2, 3, 4):
            raise ValueError("學期必須為 1 至 4")
        return value


class SkillEvidence(ContractModel):
    course_id: str = Field(min_length=1)
    skill_id: str = Field(min_length=1)
    source_type: str = Field(min_length=1)
    source_section: str = Field(min_length=1)
    relevance: Literal["strong", "medium"] | None = None
    evidence_reference: str = Field(min_length=1)
    review_status: Literal["pending", "confirmed", "rejected"] = "pending"

    @model_validator(mode="after")
    def validate_review(self):
        if self.review_status == "confirmed" and self.relevance is None:
            raise ValueError("已確認的技能關聯必須提供關聯程度")
        return self


class DimensionScore(ContractModel):
    weight: float = Field(ge=0, le=1, allow_inf_nan=False)
    score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    status: Literal["evaluated", "missing", "not_evaluated"]

    @model_validator(mode="after")
    def validate_status_score(self):
        if (self.status == "evaluated") != (self.score is not None):
            raise ValueError("僅 evaluated 可具有數值分數")
        return self


class DimensionScores(ContractModel):
    syllabus_relevance: DimensionScore
    course_grade: DimensionScore
    practice_project: DimensionScore
    portfolio_certification: DimensionScore
    recency: DimensionScore

    @model_validator(mode="after")
    def validate_weights(self):
        weights = {"syllabus_relevance": 0.4, "course_grade": 0.2,
                   "practice_project": 0.2, "portfolio_certification": 0.1, "recency": 0.1}
        if any(getattr(self, name).weight != weight for name, weight in weights.items()):
            raise ValueError("維度權重必須符合原始提案")
        return self


class StudentSkill(ContractModel):
    skill_id: str = Field(min_length=1)
    skill_name: str = Field(min_length=1)
    score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    score_type: str = Field(min_length=1)
    scoring_version: str = Field(min_length=1)
    evidence: list[SkillEvidence] = Field(default_factory=list)
    confirmed: bool = False
    dimension_scores: DimensionScores
    missing_dimensions: list[Literal["syllabus_relevance", "course_grade", "practice_project", "portfolio_certification", "recency"]] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_dimensions(self):
        missing = {name for name in type(self.dimension_scores).model_fields
                   if getattr(self.dimension_scores, name).status != "evaluated"}
        if len(self.missing_dimensions) != len(set(self.missing_dimensions)) or set(self.missing_dimensions) != missing:
            raise ValueError("missing_dimensions 必須列出所有未評估維度")
        if self.score is not None and missing:
            raise ValueError("五維資料不足時不得提供完整分數")
        if any(item.skill_id != self.skill_id for item in self.evidence):
            raise ValueError("證據技能必須與學生技能一致")
        return self


class StudentSkillProfile(ContractModel):
    student_id: str | None = Field(default=None, min_length=1)
    skills: list[StudentSkill] = Field(default_factory=list)
    scoring_version: str = Field(min_length=1)
    analysis_status: Literal["complete", "partial", "insufficient_data"]
