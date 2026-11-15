"""相近技能逐對判斷的測試：向量只找候選，是否相近由模型判定。不呼叫外部服務。"""

import json
import sqlite3
from contextlib import closing
from math import sqrt

import pytest

from shared.esco.init_db import initialize_esco
from shared.esco.pair_judge import judge_batch, judge_pairs, pair_key
from shared.esco.relations import SCHEMA as RELATION_SCHEMA
from shared.esco.similarity import update_similarity
from shared.hub import db as hub_db

BASE = "http://data.europa.eu/esco/skill/"
ML, UML, DL, ETH, PY = (BASE + name for name in ("ml", "use-ml", "deep-learning", "data-ethics", "python"))
LABELS = {ML: "machine learning", UML: "utilise machine learning", DL: "deep learning",
          ETH: "data ethics", PY: "Python (computer programming)"}


def unit(cosine: float) -> list[float]:
    """與 [1, 0] 的餘弦相似度剛好是 cosine 的單位向量。"""
    return [cosine, sqrt(1 - cosine * cosine)]


class FakeEmbedder:
    model = "fake-embed"

    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors

    def embed(self, texts):
        return [self.vectors[text.split(":")[0]] for text in texts]


class FakeJudge:
    """依兩項技能的名稱回傳預先設定的關係；沒有設定的那一組不回傳。"""

    def __init__(self, relations: dict[frozenset, str], model: str = "fake-judge"):
        self.relations = relations
        self.model = model
        self.calls = 0

    def generate(self, system_prompt, user_prompt):
        self.calls += 1
        items = []
        for pair in json.loads(user_prompt):
            relation = self.relations.get(frozenset({pair["a"]["label"], pair["b"]["label"]}))
            if relation:
                items.append({"id": pair["id"], "relation": relation, "reason": "測試"})
        return json.dumps({"items": items}, ensure_ascii=False)


class BrokenJudge:
    model = "broken-judge"

    def generate(self, system_prompt, user_prompt):
        raise RuntimeError("boom")


@pytest.fixture
def esco_db(tmp_path):
    csv_path = tmp_path / "skills.csv"
    rows = "".join(f"{uri},{label},Description of {label}.\n" for uri, label in LABELS.items())
    csv_path.write_text("conceptUri,preferredLabel,description\n" + rows, encoding="utf-8")
    db_path = tmp_path / "esco.sqlite"
    initialize_esco(csv_path, db_path)
    return db_path


@pytest.fixture
def hub_path(tmp_path):
    """比賽需要 machine learning；校內教師有另外三項技能。"""
    path = tmp_path / "hub.sqlite"
    hub_db.initialize(path)
    skill = lambda uri: {"conceptUri": uri, "source_section": "s", "evidence": "e"}  # noqa: E731
    hub_db.save_competition(path, {"competition_id": "C1", "name": "測試賽", "source_site": "t",
                                   "source_url": "https://example.org", "status": "mapped",
                                   "fetched_at": hub_db.now_iso()}, [skill(ML)])
    hub_db.save_advisor(path, {"teacher_id": "T1", "name": "測試", "status": "mapped"},
                        [skill(UML), skill(DL), skill(ETH)])
    return path


# 與 machine learning 的相似度：utilise machine learning 低於原本的門檻 0.68，deep learning 高於門檻
EMBEDDER = FakeEmbedder({"machine learning": unit(1.0), "utilise machine learning": unit(0.62),
                         "deep learning": unit(0.90), "data ethics": unit(0.65)})


def similar_rows(esco_db) -> list[tuple[str, str]]:
    with closing(sqlite3.connect(esco_db)) as conn:
        return sorted(conn.execute("SELECT concept_uri, related_uri FROM esco_skill_similar"))


def batch_of(*pairs: tuple[str, str]) -> list[dict]:
    return [{"pair": pair_key(a, b), "a": {"label": LABELS[a], "description": "d"},
             "b": {"label": LABELS[b], "description": "d"}} for a, b in pairs]


def test_judge_batch_drops_items_with_unknown_id_or_invalid_relation():
    # Arrange：模型回了一筆正確、一筆關係不在選項內、一筆代號不存在
    class Client:
        def generate(self, system_prompt, user_prompt):
            return json.dumps({"items": [
                {"id": "p01", "relation": "same", "reason": "同一件事"},
                {"id": "p02", "relation": "maybe", "reason": "不確定"},
                {"id": "p99", "relation": "same", "reason": "代號不存在"}]})

    # Act
    judged = judge_batch(batch_of((ML, UML), (ML, ETH)), Client())

    # Assert
    assert judged == {pair_key(ML, UML): {"relation": "same", "reason": "同一件事"}}


def test_judge_batch_returns_nothing_when_the_model_fails():
    assert judge_batch(batch_of((ML, UML)), BrokenJudge()) == {}


def test_judge_pairs_reuses_saved_judgments_of_the_same_model(esco_db):
    # Arrange
    candidates = {pair_key(ML, UML): 0.62}
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "same"})

    # Act
    first = judge_pairs(esco_db, candidates, judge, judge.model)
    second = judge_pairs(esco_db, candidates, judge, judge.model)
    other = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "unrelated"}, model="other-judge")
    third = judge_pairs(esco_db, candidates, other, other.model)

    # Assert：同一個模型判過的不再詢問；換模型才重新判斷
    assert first == second == {pair_key(ML, UML): {"relation": "same", "reason": "測試"}}
    assert judge.calls == 1
    assert third[pair_key(ML, UML)]["relation"] == "unrelated" and other.calls == 1


def test_judge_pairs_asks_again_after_the_rubric_changes(esco_db, monkeypatch):
    # Arrange：先以目前的準則判過一次
    candidates = {pair_key(ML, UML): 0.62}
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "same"})
    judge_pairs(esco_db, candidates, judge, judge.model)

    # Act：準則改版後再問一次
    monkeypatch.setattr("shared.esco.pair_judge.RUBRIC_VERSION", "next")
    judge_pairs(esco_db, candidates, judge, judge.model)

    # Assert：舊準則的判斷不沿用
    assert judge.calls == 2


def test_update_similarity_lets_the_judge_decide_instead_of_the_threshold(esco_db, hub_path):
    # Arrange：相似度偏低的是同一種能力；相似度偏高的反而是不同能力
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "same",
                       frozenset({LABELS[ML], LABELS[DL]}): "related_distinct",
                       frozenset({LABELS[ML], LABELS[ETH]}): "unrelated"})

    # Act
    summary = update_similarity(esco_db, hub_path, None, EMBEDDER, judge)

    # Assert
    assert similar_rows(esco_db) == sorted([(ML, UML), (UML, ML)])
    assert summary == {"anchors": 1, "pool": 4, "embedded": 4, "similar_pairs": 1,
                       "candidates": 3, "judged": 3, "rejected": 2, "unjudged": 0}


def test_update_similarity_accepts_general_and_specific_forms(esco_db, hub_path):
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[DL]}): "general_specific"})

    update_similarity(esco_db, hub_path, None, EMBEDDER, judge)

    # 沒有判斷結果的兩組：相似度都低於原本的門檻，不採用
    assert similar_rows(esco_db) == sorted([(ML, DL), (DL, ML)])


def test_update_similarity_skips_pairs_that_esco_already_relates(esco_db, hub_path):
    # Arrange：machine learning 與 deep learning 已有 ESCO 官方關聯
    with closing(sqlite3.connect(esco_db)) as conn, conn:
        conn.execute(RELATION_SCHEMA)
        conn.executemany("INSERT INTO esco_skill_relations VALUES (?, ?, ?)",
                         [(ML, DL, "narrower"), (DL, ML, "broader")])
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[DL]}): "same",
                       frozenset({LABELS[ML], LABELS[UML]}): "same"})

    # Act
    summary = update_similarity(esco_db, hub_path, None, EMBEDDER, judge)

    # Assert：官方關聯已經涵蓋的那一組不送去判斷、也不重複存
    assert similar_rows(esco_db) == sorted([(ML, UML), (UML, ML)])
    assert summary["candidates"] == 2


def test_update_similarity_falls_back_to_the_threshold_when_the_judge_fails(esco_db, hub_path):
    summary = update_similarity(esco_db, hub_path, None, EMBEDDER, BrokenJudge())

    # 判斷不了的候選：只保留達到原本門檻的那一組
    assert similar_rows(esco_db) == sorted([(ML, DL), (DL, ML)])
    assert summary["judged"] == 0 and summary["unjudged"] == 3 and summary["similar_pairs"] == 1


class ScriptedClient:
    """回傳固定的 items，用來測模型輸出的各種毛病。"""

    def __init__(self, items):
        self.items = items

    def generate(self, system_prompt, user_prompt):
        return json.dumps({"items": self.items}, ensure_ascii=False)


def test_judge_batch_keeps_a_verdict_whose_reason_is_too_long():
    # Arrange：理由遠超過要求的長度，但關係是合格的
    client = ScriptedClient([{"id": "p01", "relation": "same", "reason": "很長的理由" * 60}])

    # Act
    judged = judge_batch(batch_of((ML, UML)), client)

    # Assert：判斷保留，理由截短
    assert judged[pair_key(ML, UML)]["relation"] == "same"
    assert len(judged[pair_key(ML, UML)]["reason"]) == 120


def test_judge_batch_skips_only_the_malformed_items():
    client = ScriptedClient(["不是物件", {"id": "p01", "relation": "same", "reason": "同一件事"}])

    assert set(judge_batch(batch_of((ML, UML), (ML, ETH)), client)) == {pair_key(ML, UML)}


def test_judge_batch_ignores_an_id_answered_twice():
    # 同一組回了兩次而且互相矛盾：不知道該信哪一筆，兩筆都不採用
    client = ScriptedClient([{"id": "p01", "relation": "same", "reason": "一"},
                             {"id": "p01", "relation": "unrelated", "reason": "二"},
                             {"id": "p02", "relation": "unrelated", "reason": "三"}])

    assert set(judge_batch(batch_of((ML, UML), (ML, ETH)), client)) == {pair_key(ML, ETH)}


def test_judge_pairs_keeps_each_models_judgments_apart(esco_db):
    # Arrange：兩個模型先後判過同一組
    candidates = {pair_key(ML, UML): 0.62}
    first = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "same"}, model="model-a")
    second = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "unrelated"}, model="model-b")
    judge_pairs(esco_db, candidates, first, first.model)
    judge_pairs(esco_db, candidates, second, second.model)

    # Act：換回第一個模型
    again = judge_pairs(esco_db, candidates, first, first.model)

    # Assert：它原本的判斷還在，不必重問
    assert again[pair_key(ML, UML)]["relation"] == "same" and first.calls == 1


def test_update_similarity_records_which_method_produced_the_pairs(esco_db, hub_path):
    from shared.esco.similarity import adopted_pairs, last_run

    assert last_run(esco_db) is None
    judge = FakeJudge({frozenset({LABELS[ML], LABELS[UML]}): "same"})

    update_similarity(esco_db, hub_path, None, EMBEDDER, judge)
    judged = last_run(esco_db)
    update_similarity(esco_db, hub_path, None, EMBEDDER)
    threshold = last_run(esco_db)

    assert (judged["method"], judged["judge_model"]) == ("judge", "fake-judge") and judged["rubric"]
    assert (threshold["method"], threshold["judge_model"], threshold["rubric"]) == ("threshold", None, None)
    assert adopted_pairs(esco_db) == {pair_key(ML, DL)}


def test_fallback_without_a_verdict_matches_the_threshold_only_method(tmp_path):
    # Arrange：比賽需求技能有 6 個相似度都過門檻的鄰居；原本的規則每項技能只取前 4 名
    uris = {BASE + f"n{index}": f"neighbour {index}" for index in range(6)}
    csv_path = tmp_path / "skills.csv"
    rows = "".join(f"{uri},{label},Description.\n" for uri, label in {ML: LABELS[ML], **uris}.items())
    csv_path.write_text("conceptUri,preferredLabel,description\n" + rows, encoding="utf-8")
    esco = tmp_path / "esco.sqlite"
    initialize_esco(csv_path, esco)
    hub = tmp_path / "hub.sqlite"
    hub_db.initialize(hub)
    skill = lambda uri: {"conceptUri": uri, "source_section": "s", "evidence": "e"}  # noqa: E731
    hub_db.save_competition(hub, {"competition_id": "C1", "name": "測試賽", "source_site": "t",
                                  "source_url": "https://example.org", "status": "mapped",
                                  "fetched_at": hub_db.now_iso()}, [skill(ML)])
    hub_db.save_advisor(hub, {"teacher_id": "T1", "name": "測試", "status": "mapped"}, [skill(uri) for uri in uris])
    embedder = FakeEmbedder({LABELS[ML]: unit(1.0), **{label: unit(0.90 - index / 100) for index, label in enumerate(uris.values())}})

    # Act
    update_similarity(esco, hub, None, embedder)
    without_judge = similar_rows(esco)
    update_similarity(esco, hub, None, embedder, BrokenJudge())

    # Assert：模型全部判斷不了時，結果與不用模型完全相同
    assert similar_rows(esco) == without_judge and len(without_judge) == 8


def test_update_similarity_keeps_existing_pairs_when_vectors_cannot_be_read(esco_db, hub_path, monkeypatch):
    # Arrange：先算出一組配對，之後讀向量時資料庫被鎖住
    update_similarity(esco_db, hub_path, None, EMBEDDER)
    before = similar_rows(esco_db)

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr("shared.esco.similarity._load_vectors", locked)

    # Act
    summary = update_similarity(esco_db, hub_path, None, EMBEDDER)

    # Assert：回報失敗，原有的配對不能被清掉
    assert summary["anchors"] is None and similar_rows(esco_db) == before and before
