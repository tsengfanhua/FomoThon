"""Skill API 的輸入契約。"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ConfirmedEnrollment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    course_id: str | None = None
    course_name: str | None = None
    semester: str | None = None
    grade: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)


class ScoringOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    numeric_scale: Literal["0_100"] | None = None


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enrollments: list[ConfirmedEnrollment]
    scoring: ScoringOptions = Field(default_factory=ScoringOptions)
