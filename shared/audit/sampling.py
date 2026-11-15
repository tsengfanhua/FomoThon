"""複核樣本：從三邊的技能對應與相近配對的候選中抽樣。只讀資料庫，不呼叫外部服務。

資料最小化：複核表不放教師姓名與系所；三個來源的文字裡出現的任何一位教師姓名都換掉
（課綱常寫「某某老師授課」）。複核者只需要看「原文」與「技能」就能判定，不需要知道是哪一位教師。
只認得教師資料表裡的中文全名；兼任教師與論文作者的英文寫法（Wang, H.-M.）遮不到。
"""

import json
import random
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass, fields
from pathlib import Path

from shared.esco.pair_judge import pair_key, saved_judgments
from shared.esco.similarity import (
    METHOD_JUDGE, adopted_pairs, candidate_pairs, last_run, similar_pairs, stored_vectors)

SOURCES = ("course", "advisor", "competition")
PREFIX = {"course": "CRS", "advisor": "ADV", "competition": "CMP"}
SELF, OTHER = "（本人）", "（教師）"
MIN_NAME_CHARS = 2
CONTEXT_CHARS = 300


@dataclass(frozen=True)
class LinkItem:
    """一筆「對象 × 技能」的對應，連同它的原文證據。"""

    sample_id: str
    source: str
    entity_id: str
    subject: str
    concept_uri: str
    skill_en: str
    skill_zh: str
    skill_description: str
    section: str
    evidence: str
    context: str


@dataclass(frozen=True)
class PairItem:
    """一組相近配對的候選；by_threshold、by_judge 是兩種做法各自是否採用（不寫進複核表）。"""

    sample_id: str
    a_uri: str
    b_uri: str
    a: dict
    b: dict
    similarity: float
    by_threshold: bool
    by_judge: bool | None
    relation: str | None


def _rows(path: Path | None, sql: str) -> list[tuple]:
    if not path or not Path(path).exists():
        return []
    with closing(sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True)) as conn:
        try:
            return conn.execute(sql).fetchall()
        except sqlite3.OperationalError as error:
            if "no such table" not in str(error):
                raise
            return []  # 資料表還沒建立


def skill_info(esco_db: Path) -> dict[str, dict]:
    """uri → {en, zh, description}；沒有中文名稱的技能 zh 為空字串。"""
    zh = dict(_rows(esco_db, "SELECT concept_uri, label_zh FROM esco_labels_zh"))
    return {uri: {"en": label, "zh": zh.get(uri, ""), "description": description}
            for uri, label, description in _rows(esco_db, "SELECT concept_uri, preferred_label, description FROM esco_skills")}


def name_pattern(hub_db: Path | None) -> re.Pattern | None:
    """比對任何一位教師姓名的樣式（長的姓名優先）；沒有教師資料時回傳 None。"""
    names = {(name or "").strip() for (name,) in _rows(hub_db, "SELECT name FROM advisors")}
    usable = sorted((name for name in names if len(name) >= MIN_NAME_CHARS), key=lambda name: (-len(name), name))
    return re.compile("|".join(re.escape(name) for name in usable)) if usable else None


def _mask(text: str | None, pattern: re.Pattern | None, own: str | None = None) -> str:
    """壓平空白，把本人姓名換成「（本人）」、其他教師姓名換成「（教師）」。"""
    cleaned = " ".join((text or "").split())
    if own and len(own.strip()) >= MIN_NAME_CHARS:
        cleaned = cleaned.replace(own.strip(), SELF)
    return pattern.sub(OTHER, cleaned) if pattern else cleaned


def _expertise(raw: str | None) -> str:
    try:
        items = json.loads(raw or "[]")
    except ValueError:
        return ""
    return "、".join(str(item) for item in items) if isinstance(items, list) else ""


def _course_rows(course_db: Path | None, pattern: re.Pattern | None) -> list[dict]:
    rows = _rows(course_db, """
        SELECT s.course_id, c.course_name, c.description, s.concept_uri, s.source_section, s.evidence
        FROM course_skills s JOIN courses c ON c.course_id = s.course_id""")
    return [{"entity_id": course_id, "subject": _mask(f"課程：{name}", pattern), "concept_uri": uri, "section": section,
             "evidence": _mask(evidence, pattern), "context": _mask(description, pattern)[:CONTEXT_CHARS]}
            for course_id, name, description, uri, section, evidence in rows]


def _advisor_rows(hub_db: Path | None, pattern: re.Pattern | None) -> list[dict]:
    rows = _rows(hub_db, """
        SELECT e.entity_id, a.name, a.expertise_json, e.concept_uri, e.source_section, e.evidence
        FROM entity_skills e JOIN advisors a ON a.teacher_id = e.entity_id WHERE e.entity_type = 'advisor'""")
    return [{"entity_id": teacher_id, "subject": "教師", "concept_uri": uri, "section": section,
             "evidence": _mask(evidence, pattern, name),
             "context": _mask(_expertise(expertise), pattern, name)[:CONTEXT_CHARS]}
            for teacher_id, name, expertise, uri, section, evidence in rows]


def _competition_rows(hub_db: Path | None, pattern: re.Pattern | None) -> list[dict]:
    rows = _rows(hub_db, """
        SELECT e.entity_id, c.name, c.category, c.summary, e.concept_uri, e.source_section, e.evidence
        FROM entity_skills e JOIN competitions c ON c.competition_id = e.entity_id
        WHERE e.entity_type = 'competition'""")
    return [{"entity_id": competition_id, "subject": _mask(f"比賽：{name}", pattern), "concept_uri": uri,
             "section": section, "evidence": _mask(evidence, pattern),
             "context": _mask("｜".join(part for part in (category, summary) if part), pattern)[:CONTEXT_CHARS]}
            for competition_id, name, category, summary, uri, section, evidence in rows]


def _order(row: dict) -> tuple:
    return row["entity_id"], row["concept_uri"], row["section"], row["evidence"]


def load_links(hub_db: Path | None, course_db: Path | None, esco_db: Path) -> dict[str, list[dict]]:
    """三個來源各自的全部對應（母體），排序固定，抽樣才能重現。"""
    pattern = name_pattern(hub_db)
    skills = skill_info(esco_db)
    by_source = zip(SOURCES, (_course_rows(course_db, pattern), _advisor_rows(hub_db, pattern),
                              _competition_rows(hub_db, pattern)))
    return {source: sorted(({**row, **skills[row["concept_uri"]]} for row in rows if row["concept_uri"] in skills),
                           key=_order)
            for source, rows in by_source}


def sample_links(population: dict[str, list[dict]], per_source: int, seed: int) -> list[LinkItem]:
    """每個來源各用自己的亂數（種子加來源名稱）不重複抽出 per_source 筆，不足時全取。

    各來源互不影響：某一邊的資料增減，不會讓另外兩邊抽到不同的樣本。
    """
    items = []
    for source in SOURCES:
        rows = population.get(source, [])
        chosen = random.Random(f"{seed}:{source}").sample(rows, min(per_source, len(rows)))
        items.extend(
            LinkItem(sample_id=f"{PREFIX[source]}-{index:03d}", source=source, entity_id=row["entity_id"],
                     subject=row["subject"], concept_uri=row["concept_uri"], skill_en=row["en"], skill_zh=row["zh"],
                     skill_description=row["description"], section=row["section"], evidence=row["evidence"],
                     context=row["context"])
            for index, row in enumerate(chosen, 1))
    return items


def names_found(items: list[LinkItem], pattern: re.Pattern | None) -> list[str]:
    """寫表前的最後一道檢查：還有哪些編號的文字含教師姓名（正常應該是空的）。"""
    if pattern is None:
        return []
    return [item.sample_id for item in items
            if any(pattern.search(str(getattr(item, field.name))) for field in fields(item) if field.name != "entity_id")]


def load_pairs(esco_db: Path, hub_db: Path | None, course_db: Path | None) -> list[dict]:
    """相近配對的全部候選（放寬門檻、不含官方關聯），標出兩種做法各自是否採用。

    by_threshold：只看門檻的原本規則是否採用。
    by_judge：最近一次以模型逐對判斷計算時，esco_skill_similar 實際有沒有這一組（含判斷不了而退回門檻的）；
    最近一次不是用模型判斷時為 None。以實際採用的結果為準，不直接讀判斷紀錄，才不會評到舊準則或別的模型。
    """
    anchors, vectors = stored_vectors(esco_db, hub_db, course_db)
    candidates = candidate_pairs(esco_db, anchors, vectors) if anchors else {}
    legacy = {pair_key(a, b) for a, b in similar_pairs(anchors, vectors)}
    run = last_run(esco_db)
    judged = bool(run) and run["method"] == METHOD_JUDGE
    adopted = adopted_pairs(esco_db) if judged else set()
    relations = saved_judgments(esco_db, run["judge_model"], run["rubric"]) if judged else {}
    skills = skill_info(esco_db)
    return [{"a_uri": a, "b_uri": b, "a": skills[a], "b": skills[b], "similarity": score,
             "by_threshold": (a, b) in legacy, "by_judge": ((a, b) in adopted) if judged else None,
             "relation": relations.get((a, b), {}).get("relation")}
            for (a, b), score in sorted(candidates.items()) if a in skills and b in skills]


def sample_pairs(pairs: list[dict], limit: int, seed: int) -> list[PairItem]:
    """limit 為 0 時全取；順序一律打亂，複核者看不出相似度高低。"""
    chosen = random.Random(f"{seed}:pairs").sample(pairs, min(limit, len(pairs)) if limit else len(pairs))
    return [PairItem(sample_id=f"PAIR-{index:03d}", **pair) for index, pair in enumerate(chosen, 1)]
