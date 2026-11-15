"""找出「語意相近」的 ESCO 技能，補上官方關聯沒有涵蓋的對應。

ESCO 有很多意思接近、卻沒有標示上下位或相關的技能（例如比賽要「computer programming」、
課程對到「Python (computer programming)」）。只靠官方關聯會把這些都算成缺口，所以另外以
文字向量的餘弦相似度，替「比賽需要的技能」找出校內已使用的相近技能，存進 esco_skill_similar。

範圍刻意縮小：只替比賽需求技能（錨點）找相近技能，不做全部技能的兩兩比較。
語言技能不參與：各種語言的技能文字非常像（understand spoken English ↔ Chinese 相似度 0.87），
但彼此不能互相取代。
配對時相近技能與官方關聯一樣折半計算，網站會標示它是「語意相近」而不是官方關聯。
向量存在 esco_embeddings，新增技能時只補算缺少的部分。任何錯誤都不往外丟，只回報筆數。

有提供判斷用的模型（judge）時，向量只負責找候選：門檻放寬到 CANDIDATE_THRESHOLD，
已有 ESCO 官方關聯的配對略過，其餘由模型逐對判定是否相近（見 pair_judge.py）。
沒有 judge 或模型判斷不了的配對，才退回只看門檻 THRESHOLD 的做法。
"""

import argparse
import logging
import sqlite3
from array import array
from contextlib import closing
from datetime import datetime, timezone
from math import sqrt
from pathlib import Path
from typing import Protocol

from shared.esco.pair_judge import ACCEPTED, RUBRIC_VERSION, Pair, build_judge, judge_pairs, pair_key
from shared.llm import JsonClient

logger = logging.getLogger(__name__)
EMBED_MODEL = "text-embedding-3-small"
# 縮短向量長度：相似度計算用純 Python（不另外相依 numpy），256 維足以分辨技能名稱的遠近
EMBED_DIMENSIONS = 256
# 門檻依實測決定（256 維、名稱＋描述）：0.68 以上多半是同一種能力的不同說法或它的具體形式
# （computer programming ↔ Python 0.84、machine learning ↔ deep learning 0.70）；
# 0.60–0.67 開始混入只是字面相近的技能（data ethics ↔ data analytics 0.65），所以不採用。
THRESHOLD = 0.68
TOP_K = 4
# 有模型逐對判斷時的候選範圍：放寬門檻讓文字不夠像、其實相同的技能進入候選
# （machine learning ↔ utilise machine learning 只有 0.61），是否採用交給模型決定。
CANDIDATE_THRESHOLD = 0.60
CANDIDATE_TOP_K = 6
EMBED_BATCH = 200
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS esco_embeddings (
        concept_uri TEXT PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS esco_skill_similar (
        concept_uri TEXT NOT NULL, related_uri TEXT NOT NULL, similarity REAL NOT NULL,
        PRIMARY KEY (concept_uri, related_uri))""",
    # 最近一次是用哪一種做法算出 esco_skill_similar 的（只有一列）；人工複核據此知道自己在評哪一種做法
    """CREATE TABLE IF NOT EXISTS esco_similar_run (
        id INTEGER PRIMARY KEY CHECK (id = 1), method TEXT NOT NULL, judge_model TEXT, rubric TEXT,
        computed_at TEXT NOT NULL)""",
)
METHOD_JUDGE, METHOD_THRESHOLD = "judge", "threshold"


class Embedder(Protocol):
    model: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class OpenAIEmbedder:
    """OpenAI 向量模型；金鑰只從環境變數 OPENAI_API_KEY 讀取。"""

    def __init__(self, model: str = EMBED_MODEL):
        from openai import OpenAI  # 延後匯入：測試不需要安裝 SDK

        self.model = model
        self._client = OpenAI(max_retries=3, timeout=60.0)
        logging.getLogger("httpx").setLevel(logging.WARNING)

    def embed(self, texts: list[str]) -> list[list[float]]:
        response = self._client.embeddings.create(model=self.model, input=texts, dimensions=EMBED_DIMENSIONS)
        return [item.embedding for item in sorted(response.data, key=lambda item: item.index)]


def _normalize(vector: list[float]) -> array:
    """轉成單位向量（float32），之後內積就是餘弦相似度。"""
    norm = sqrt(sum(x * x for x in vector)) or 1.0
    return array("f", (x / norm for x in vector))


def embed_missing(esco_db: Path, uris: set[str], embedder: Embedder) -> int:
    """替還沒有向量（或向量來自其他模型）的技能補算；回傳新增筆數。"""
    with closing(sqlite3.connect(esco_db, timeout=30)) as conn:
        with conn:
            for statement in SCHEMA:
                conn.execute(statement)
        done = {row[0] for row in conn.execute("SELECT concept_uri FROM esco_embeddings WHERE model=?", (embedder.model,))}
        rows = [row for row in conn.execute("SELECT concept_uri, preferred_label, description FROM esco_skills")
                if row[0] in uris and row[0] not in done]
    saved = 0
    for start in range(0, len(rows), EMBED_BATCH):
        batch = rows[start:start + EMBED_BATCH]
        vectors = embedder.embed([f"{label}: {description[:300]}" for _, label, description in batch])
        if len(vectors) != len(batch):
            raise ValueError("向量數量與輸入不符")
        with closing(sqlite3.connect(esco_db, timeout=30)) as conn, conn:
            conn.executemany("INSERT OR REPLACE INTO esco_embeddings VALUES (?, ?, ?)",
                             [(uri, embedder.model, _normalize(vector).tobytes())
                              for (uri, _, _), vector in zip(batch, vectors)])
        saved += len(batch)
    return saved


def _load_vectors(esco_db: Path, uris: set[str], model: str) -> dict[str, array]:
    vectors = {}
    with closing(sqlite3.connect(esco_db, timeout=30)) as conn:
        for uri, blob in conn.execute("SELECT concept_uri, vector FROM esco_embeddings WHERE model=?", (model,)):
            if uri in uris:
                vector = array("f")
                vector.frombytes(blob)
                vectors[uri] = vector
    return vectors


def similar_pairs(anchors: dict[str, array], pool: dict[str, array],
                  threshold: float = THRESHOLD, top_k: int = TOP_K) -> dict[tuple[str, str], float]:
    """每個錨點取相似度最高的 top_k 個（不含自己、需達門檻）；回傳雙向的配對。"""
    pairs: dict[tuple[str, str], float] = {}
    for anchor_uri, anchor in anchors.items():
        scored = []
        for uri, vector in pool.items():
            if uri == anchor_uri or len(vector) != len(anchor):
                continue
            score = sum(a * b for a, b in zip(anchor, vector))
            if score >= threshold:
                scored.append((score, uri))
        for score, uri in sorted(scored, reverse=True)[:top_k]:
            value = round(score, 4)
            pairs[(anchor_uri, uri)] = max(value, pairs.get((anchor_uri, uri), 0.0))
            pairs[(uri, anchor_uri)] = max(value, pairs.get((uri, anchor_uri), 0.0))
    return pairs


def _uris(db_path: Path | None, sql: str) -> set[str]:
    if not db_path or not Path(db_path).exists():
        return set()
    with closing(sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)) as conn:
        try:
            return {row[0] for row in conn.execute(sql)}
        except sqlite3.OperationalError:
            return set()  # 資料表還沒建立


def campus_uris(esco_db: Path, hub_db: Path | None, course_db: Path | None) -> tuple[set[str], set[str]]:
    """（比賽需求技能, 加上校內教師與課程已使用的技能）；語言技能不參與。"""
    languages = _uris(esco_db, "SELECT concept_uri FROM esco_language_skills")
    anchors = _uris(hub_db, "SELECT DISTINCT concept_uri FROM entity_skills WHERE entity_type='competition'") - languages
    pool = (anchors | _uris(hub_db, "SELECT DISTINCT concept_uri FROM entity_skills WHERE entity_type='advisor'")
            | _uris(course_db, "SELECT DISTINCT concept_uri FROM course_skills")) - languages
    return anchors, pool


def stored_vectors(esco_db: Path, hub_db: Path | None, course_db: Path | None,
                   model: str = EMBED_MODEL) -> tuple[dict[str, array], dict[str, array]]:
    """已經存好的向量：（比賽需求技能, 全部參與比較的技能）。只讀資料庫，不呼叫向量模型。"""
    anchors, pool = campus_uris(esco_db, hub_db, course_db)
    try:
        vectors = _load_vectors(esco_db, pool, model)
    except sqlite3.OperationalError as error:
        if "no such table" not in str(error):
            raise  # 資料庫鎖定、磁碟錯誤等不能當成「沒有資料」
        return {}, {}  # 還沒算過向量
    return {uri: vectors[uri] for uri in anchors if uri in vectors}, vectors


def last_run(esco_db: Path) -> dict | None:
    """最近一次計算相近配對用的做法：{method, judge_model, rubric, computed_at}；沒有紀錄時回傳 None。"""
    with closing(sqlite3.connect(esco_db, timeout=30)) as conn:
        try:
            row = conn.execute("SELECT method, judge_model, rubric, computed_at FROM esco_similar_run WHERE id=1").fetchone()
        except sqlite3.OperationalError as error:
            if "no such table" not in str(error):
                raise
            return None
    return dict(zip(("method", "judge_model", "rubric", "computed_at"), row)) if row else None


def adopted_pairs(esco_db: Path) -> set[Pair]:
    """esco_skill_similar 目前的內容（不分方向）：網站實際使用的相近配對。"""
    with closing(sqlite3.connect(esco_db, timeout=30)) as conn:
        try:
            return {pair_key(a, b) for a, b in conn.execute("SELECT concept_uri, related_uri FROM esco_skill_similar")}
        except sqlite3.OperationalError as error:
            if "no such table" not in str(error):
                raise
            return set()


def _official_pairs(esco_db: Path) -> set[Pair]:
    """已有 ESCO 官方關聯的配對（雙向各一列）；資料表還沒建立時視為沒有。"""
    with closing(sqlite3.connect(esco_db, timeout=30)) as conn:
        try:
            return set(conn.execute("SELECT concept_uri, related_uri FROM esco_skill_relations"))
        except sqlite3.OperationalError:
            return set()


def candidate_pairs(esco_db: Path, anchors: dict[str, array], pool: dict[str, array]) -> dict[Pair, float]:
    """放寬門檻後的候選配對（不分方向），不含 ESCO 官方關聯已經涵蓋的。"""
    official = _official_pairs(esco_db)
    scored = similar_pairs(anchors, pool, threshold=CANDIDATE_THRESHOLD, top_k=CANDIDATE_TOP_K)
    return {pair_key(a, b): score for (a, b), score in scored.items() if (a, b) not in official}


def _judged_pairs(esco_db: Path, anchors: dict[str, array], pool: dict[str, array],
                  judge: JsonClient) -> tuple[dict[Pair, float], dict]:
    """由模型逐對判定候選是否相近；回傳（雙向的採用配對, 統計）。

    模型判斷不了的候選退回原本的規則（相似度達 THRESHOLD 且在該技能的前 TOP_K 名內）。
    """
    candidates = candidate_pairs(esco_db, anchors, pool)
    judgments = judge_pairs(esco_db, candidates, judge, getattr(judge, "model", "unknown"))
    legacy = {pair_key(a, b) for a, b in similar_pairs(anchors, pool)}
    accepted = {pair: score for pair, score in candidates.items()
                if (judgments[pair]["relation"] in ACCEPTED if pair in judgments else pair in legacy)}
    rejected = sum(1 for verdict in judgments.values() if verdict["relation"] not in ACCEPTED)
    unjudged = len(candidates) - len(judgments)
    if unjudged:
        logger.warning("相近配對有 %d 組沒有模型判斷，這幾組改看相似度門檻", unjudged)
    pairs = {direction: score for (a, b), score in accepted.items() for direction in ((a, b), (b, a))}
    return pairs, {"candidates": len(candidates), "judged": len(judgments), "rejected": rejected, "unjudged": unjudged}


def update_similarity(esco_db: Path, hub_db: Path | None, course_db: Path | None, embedder: Embedder,
                      judge: JsonClient | None = None) -> dict:
    """重算「比賽需求技能 ↔ 校內已使用技能」的相近配對；失敗不影響其他流程。

    judge 是逐對判斷用的模型；不提供時只看向量相似度是否達到 THRESHOLD。
    """
    try:
        anchors, pool = campus_uris(esco_db, hub_db, course_db)
        embedded = embed_missing(esco_db, pool, embedder)
        vectors = _load_vectors(esco_db, pool, embedder.model)
        anchor_vectors = {uri: vectors[uri] for uri in anchors if uri in vectors}
        if judge is None:
            pairs, stats, run = similar_pairs(anchor_vectors, vectors), {}, (METHOD_THRESHOLD, None, None)
        else:
            pairs, stats = _judged_pairs(esco_db, anchor_vectors, vectors, judge)
            run = (METHOD_JUDGE, getattr(judge, "model", "unknown"), RUBRIC_VERSION)
        with closing(sqlite3.connect(esco_db, timeout=30)) as conn, conn:
            conn.execute("DELETE FROM esco_skill_similar")
            conn.executemany("INSERT INTO esco_skill_similar VALUES (?, ?, ?)",
                             [(a, b, score) for (a, b), score in pairs.items()])
            conn.execute("INSERT OR REPLACE INTO esco_similar_run VALUES (1, ?, ?, ?, ?)",
                         (*run, datetime.now(timezone.utc).isoformat(timespec="seconds")))
        return {"anchors": len(anchors), "pool": len(pool), "embedded": embedded,
                "similar_pairs": len(pairs) // 2, **stats}
    except Exception:
        logger.exception("語意相近技能的計算失敗（不影響分析結果）")
        return {"anchors": None, "pool": None, "embedded": 0, "similar_pairs": 0}


def main() -> None:
    from shared.hub.batch import configure_logging, emit_summary

    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="計算比賽需求技能與校內技能的語意相近配對（會呼叫外部向量模型與判斷用的模型）")
    parser.add_argument("--esco-db", type=Path, default=root / "data/shared/esco_skills.sqlite")
    parser.add_argument("--hub-db", type=Path, default=root / "data/shared/skill_hub.sqlite")
    parser.add_argument("--course-db", type=Path, default=root / "course-agent/data/processed/course_index.sqlite")
    parser.add_argument("--judge-model", help="逐對判斷用的模型（預設讀 PAIR_JUDGE_MODEL，再來是 gpt-4.1）")
    parser.add_argument("--no-judge", action="store_true", help="不做逐對判斷，只看向量相似度門檻")
    args = parser.parse_args()
    configure_logging()
    embedder = OpenAIEmbedder()
    judge = None if args.no_judge else build_judge(args.judge_model)
    emit_summary({"entity": "esco_skill_similar", "model": embedder.model, "judge_model": getattr(judge, "model", None),
                  **update_similarity(args.esco_db, args.hub_db, args.course_db, embedder, judge)})


if __name__ == "__main__":
    main()
