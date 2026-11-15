"""Skill API 的輸入契約。"""

from typing import Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator


class ConfirmedEnrollment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    course_id: str | None = None
    academic_year: int | None = None
    course_name: str | None = None
    semester: str | int | None = None
    course_code: str | None = Field(default=None, validation_alias=AliasChoices("course_code", "selection_code"))
    credits: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    grade: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)

    @field_validator("grade", mode="before")
    @classmethod
    def reject_boolean_grade(cls, value):
        if isinstance(value, bool):
            raise ValueError("成績須為 0～100 的數值")
        return value


class ScoringOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    numeric_scale: Literal["0_100"] | None = None


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enrollments: list[ConfirmedEnrollment]
    scoring: ScoringOptions = Field(default_factory=ScoringOptions)
