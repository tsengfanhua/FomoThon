"""No local catalogue or fallback: existence requires a shared repository lookup."""

from collections.abc import Mapping
from enum import Enum
import re
from typing import Protocol


class EscoRepository(Protocol):
    def get(self, concept_uri: str) -> object | None:
        """Return a record containing concept_uri, or None if absent; raise on outage."""
        ...


class ValidationResult(str, Enum):
    VALID = "VALID"
    INVALID_FORMAT = "INVALID_FORMAT"
    NOT_FOUND = "NOT_FOUND"
    UNAVAILABLE = "UNAVAILABLE"


class SkillValidationError(ValueError):
    def __init__(self, result: ValidationResult):
        self.result = result
        super().__init__(result.value)


class SkillUriValidator:
    _pattern = re.compile(
        r"http://data\.europa\.eu/esco/skill/"
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    )

    def __init__(self, repository: EscoRepository | None = None):
        self.repository = repository

    @classmethod
    def has_valid_format(cls, concept_uri: str) -> bool:
        """Syntax only; does not assert that the skill exists."""
        return isinstance(concept_uri, str) and cls._pattern.fullmatch(concept_uri) is not None

    def validate(self, concept_uri: str) -> ValidationResult:
        if not self.has_valid_format(concept_uri):
            return ValidationResult.INVALID_FORMAT
        if self.repository is None:
            return ValidationResult.UNAVAILABLE
        try:
            record = self.repository.get(concept_uri)
            if record is None:
                return ValidationResult.NOT_FOUND
            if isinstance(record, Mapping) or hasattr(record, "keys"):
                returned_uri = record["concept_uri"]
            else:
                returned_uri = record.concept_uri
            if returned_uri != concept_uri:
                return ValidationResult.NOT_FOUND
        except Exception:
            return ValidationResult.UNAVAILABLE
        return ValidationResult.VALID

    def require_valid(self, concept_uri: str) -> None:
        result = self.validate(concept_uri)
        if result != ValidationResult.VALID:
            raise SkillValidationError(result)
