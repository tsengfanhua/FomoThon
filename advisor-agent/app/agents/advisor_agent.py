"""Deterministic, evidence-aware advisor matching agent (MVP)."""
from __future__ import annotations
import re
from app.schemas.advisors import (
    AdvisorProfile, AdvisorDimension, AdvisorRecommendation,
    AdvisorMatchRequest, AdvisorMatchResponse,
)

WEIGHTS = {
    "expertise_match": 0.50,
    "course_match": 0.25,
    "competition_experience": 0.25,
}


def _norm(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def _overlap(needles: list[str], haystack: list[str]) -> list[str]:
    """Exact/substring matching only; no unsupported semantic inference."""
    found: list[str] = []
    normalized_haystack = [(_norm(item), item) for item in haystack if item]
    for needle in needles:
        n = _norm(needle)
        if not n:
            continue
        if any(n == h or n in h or h in n for h, _ in normalized_haystack):
            if needle not in found:
                found.append(needle)
    return found


def _dimension(weight: float, score: float | None, matched: list[str], evidence: list[str], status: str):
    return AdvisorDimension(weight=weight, score=score, status=status,
                            matched_items=matched, evidence=evidence)


def recommend_advisors(request: AdvisorMatchRequest, profiles: list[AdvisorProfile]) -> AdvisorMatchResponse:
    competition = request.competition
    topic_terms = [competition.topic, *competition.required_skills]
    topic_terms = [x for x in topic_terms if x.strip()]
    results: list[AdvisorRecommendation] = []

    for profile in profiles:
        expertise_pool = [*(profile.expertise or []), *(profile.research_areas or [])]
        expertise_hits = _overlap(topic_terms, expertise_pool)
        course_hits = _overlap(competition.related_courses, profile.courses or [])
        experience_hits = _overlap(
            [competition.competition_name, competition.competition_type or ""],
            profile.advised_competitions or [],
        )
        dimensions = {
            "expertise_match": _dimension(WEIGHTS["expertise_match"], 100 * len(expertise_hits) / len(topic_terms) if topic_terms else None,
                expertise_hits, [f"教師專長／研究領域：{x}" for x in expertise_hits], "evaluated" if topic_terms and (profile.expertise is not None or profile.research_areas is not None) else "missing"),
            "course_match": _dimension(WEIGHTS["course_match"], 100 * len(course_hits) / len(competition.related_courses) if competition.related_courses else None,
                course_hits, [f"教師開授課程：{x}" for x in course_hits], "evaluated" if competition.related_courses and profile.courses is not None else "missing"),
            "competition_experience": _dimension(WEIGHTS["competition_experience"], 100 * min(len(experience_hits), 3) / 3 if experience_hits else 0,
                experience_hits, [f"指導經驗：{x}" for x in experience_hits], "evaluated" if profile.advised_competitions is not None else "missing"),
        }
        evaluated_weight = sum(d.weight for d in dimensions.values() if d.status == "evaluated")
        weighted = sum(d.weight * (d.score or 0) for d in dimensions.values() if d.status == "evaluated")
        score = round(weighted / evaluated_weight, 2) if evaluated_weight else None
        coverage = round(evaluated_weight * 100, 1)

        reasons: list[str] = []
        if expertise_hits:
            reasons.append("研究專長與競賽主題／需求技能有明確文字對應")
        if course_hits:
            reasons.append("教師開授課程與競賽相關課程需求相符")
        if experience_hits:
            reasons.append("教師資料記載相關競賽指導經驗")
        if not reasons:
            reasons.append("目前資料未找到明確匹配項目，建議補充教師研究與授課資料")

        warnings = []
        missing_names = [name for name, dim in dimensions.items() if dim.status != "evaluated"]
        if missing_names:
            warnings.append("以下評分維度資料不足，總分已按可評估權重重新正規化：" + ", ".join(missing_names))
        if profile.is_synthetic:
            warnings.append("此教師為虛構展示資料，不可視為真實師資推薦")
        evidence_ids = [f"ADV-{profile.teacher_id}-{i:02d}" for i, d in enumerate(dimensions.values(), 1) if d.evidence]
        results.append(AdvisorRecommendation(
            teacher_id=profile.teacher_id, teacher_name=profile.teacher_name,
            match_score=score, score_coverage=coverage, dimensions=dimensions,
            expertise=(profile.expertise or []) + (profile.research_areas or []),
            reasons=reasons, evidence_ids=evidence_ids,
            competition_evidence=profile.competition_evidence or [],
            data_warnings=warnings, is_synthetic=profile.is_synthetic,
        ))

    results.sort(key=lambda x: (x.match_score is not None, x.match_score or -1, x.score_coverage), reverse=True)
    notes = ["分數為依已提供資料計算的相對匹配指標，不代表教師能力、推薦成功率或指導承諾。",
             "評分權重：研究專長 50%、開授課程 25%、競賽指導經驗 25%。學生修課關聯與教師指導量能不納入評分。",
             "目前採精確／包含字串比對；不使用 LLM 推測未提供的研究專長。"]
    return AdvisorMatchResponse(competition_id=competition.competition_id,
        competition_name=competition.competition_name, advisors=results[:request.top_k], notes=notes)
