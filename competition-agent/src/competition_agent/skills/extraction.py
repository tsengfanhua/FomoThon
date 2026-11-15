"""Extractor contract and controlled search vocabulary. No concrete/model extractor.

Fixed extractors belong only in tests. An extractor proposes claims, never ESCO IDs.
"""
from dataclasses import dataclass
from typing import Protocol
import re

SEARCH_VERSION = "controlled-terms-2"
# Deliberately small, reviewable vocabulary. Unknown terms require human maintenance.
SEARCH_TERMS = {
    "程式設計": ("computer programming",),
    "資料分析": ("analyse data", "data analysis"),
    "管理音樂工作人員": ("manage musical staff",),
}


@dataclass(frozen=True)
class SkillClaim:
    skill_name: str
    quote: str
    start: int
    end: int
    evidence_level: str
    scope: str
    reason: str
    field: str = "clean_content"
    group_name: str | None = None
    suggested_search_terms: tuple[str, ...] = ()


class SkillExtractor(Protocol):
    method: str
    version: str

    def extract(self, source: dict) -> list[SkillClaim]: ...


def validate_claim(claim: SkillClaim, source: dict) -> None:
    if not isinstance(claim, SkillClaim):
        raise ValueError("Extractor must return SkillClaim records")
    if claim.evidence_level not in {"explicit", "inferred", "insufficient"}:
        raise ValueError("Invalid evidence level")
    if claim.scope not in {"competition_wide", "group", "unknown"}:
        raise ValueError("Invalid scope")
    if any(not isinstance(v, str) or not v.strip() for v in (claim.skill_name, claim.quote, claim.reason)):
        raise ValueError("Skill, quote and reason are required")
    if claim.field not in {"title", "clean_content"}:
        raise ValueError("Unsupported evidence field")
    text = source[claim.field]
    if (type(claim.start) is not int or type(claim.end) is not int
            or not 0 <= claim.start < claim.end <= len(text) or text[claim.start:claim.end] != claim.quote):
        raise ValueError("Evidence quote/offset mismatch")
    if claim.scope == "group" and (not claim.group_name or claim.group_name not in claim.quote):
        raise ValueError("Group scope needs a group name in the original quote")
    if claim.scope != "group" and claim.group_name is not None:
        raise ValueError("Group name cannot be discarded into a competition-wide claim")
    if (not isinstance(claim.suggested_search_terms, (tuple, list))
            or len(claim.suggested_search_terms) > 3
            or any(not isinstance(t, str) or not t.strip() or len(t) > 100 for t in claim.suggested_search_terms)):
        raise ValueError("Invalid suggested search terms")


def controlled_terms(claim: SkillClaim) -> tuple[str, ...]:
    """No translation-induced requirements: require a literal skill phrase in evidence.

    This is only a conservative lexical gate. Human review must assess the complete
    context and whether the quote really supports a competition-wide requirement.
    """
    if claim.skill_name not in claim.quote:
        return ()
    allowed = SEARCH_TERMS.get(claim.skill_name, ())
    if claim.suggested_search_terms:
        suggested = {t.strip().casefold() for t in claim.suggested_search_terms}
        return tuple(term for term in allowed if term.casefold() in suggested)
    return allowed


def explicit_support(claim: SkillClaim) -> bool:
    return bool(
        claim.evidence_level == "explicit" and controlled_terms(claim)
        and re.search(r"必須|須|需要|要求|應具備|完成|使用", claim.quote)
        and not re.search(r"不要求|無須|不需|無需|不得|不限|不必", claim.quote)
    )
