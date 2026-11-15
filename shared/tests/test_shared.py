"""共用模組測試：ESCO 對應器、ESCO 關聯、技能中樞資料庫。不呼叫外部服務。"""

import json
import sqlite3
from contextlib import closing

import pytest

from shared.esco.init_db import initialize_esco
from shared.esco.mapper import MappingPrompt, clean_sections, map_sections_to_esco
from shared.esco.relations import initialize_relations
from shared.esco.repository import EscoRepository
from shared.hub import db as hub_db

PROMPT = MappingPrompt(source_name="測試文件", term_rule="", select_rule="")
ML = "http://data.europa.eu/esco/skill/ml"
PY = "http://data.europa.eu/esco/skill/python"
DL = "http://data.europa.eu/esco/skill/deep-learning"


class FakeClient:
    """依序回傳預先準備的回應；回應是例外時就丟出。"""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def generate(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)


@pytest.fixture
def esco_db(tmp_path):
    csv_path = tmp_path / "skills.csv"
    csv_path.write_text(
        "conceptUri,preferredLabel,description\n"
        f"{ML},machine learning,The principles of machine learning.\n"
        f"{PY},Python (computer programming),Techniques of software development in Python.\n"
        f"{DL},deep learning,A subfield of machine learning using neural networks.\n"
        "http://data.europa.eu/esco/skill/x,apply statistical analysis techniques,Use machine learning models.\n",
        encoding="utf-8")
    db_path = tmp_path / "esco.sqlite"
    initialize_esco(csv_path, db_path)
    return db_path


def test_search_ranked_puts_label_hits_before_description_hits(esco_db):
    # Arrange
    repository = EscoRepository(esco_db)

    # Act
    labels = [row["preferred_label"] for row in repository.search_ranked("machine learning", limit=3)]

    # Assert：名稱完全相同的在最前，只在描述命中的排最後
    assert labels[0] == "machine learning"
    assert labels[-1] == "apply statistical analysis techniques"


def test_search_ranked_prefers_whole_words_over_substrings(esco_db):
    # Arrange：python 是 "Python (computer programming)" 中完整的詞；learn 只是 learning 的一部分
    repository = EscoRepository(esco_db)

    # Act
    whole = repository.search_ranked("python", limit=1)[0]["preferred_label"]
    partial = [row["preferred_label"] for row in repository.search_ranked("learn", limit=3)]

    # Assert
    assert whole == "Python (computer programming)"
    assert partial[:2] == ["deep learning", "machine learning"]


def test_mapper_keeps_only_matches_with_verbatim_evidence(esco_db):
    # Arrange
    sections = {"skill[0]": "機器學習與  深度學習", "journal[0]": "以 Python 實作推薦系統"}
    client = FakeClient(
        {"terms": ["machine learning", "Python", "不是英文"]},
        {"matches": [
            {"id": "c01", "label": "machine learning", "source_section": "skill[0]", "evidence": "機器學習與 深度學習"},
            {"id": "c02", "label": "Python (computer programming)", "source_section": "journal[0]",
             "evidence": "用 Python 寫推薦系統"},  # 改寫過，不是原文
            {"id": "c99", "label": "made up", "source_section": "skill[0]", "evidence": "機器學習"},  # 不在候選內
            {"id": "c03", "label": "deep learning", "source_section": "不存在的段落", "evidence": "深度學習"},
            {"id": "c02", "label": "deep learning", "source_section": "skill[0]", "evidence": "深度學習"},  # 代號與名稱對不上
        ], "unmapped": ["推薦系統沒有合適的候選"]})

    # Act
    result = map_sections_to_esco(sections, {"name": "測試"}, EscoRepository(esco_db), client, PROMPT)

    # Assert
    assert result["status"] == "mapped"
    assert [skill["conceptUri"] for skill in result["skills"]] == [ML]
    assert result["skills"][0]["preferredLabel"] == "machine learning"
    assert result["rejected"] == 4
    assert result["terms"] == ["machine learning", "python"]
    assert result["unmapped"] == ["推薦系統沒有合適的候選"]


def test_mapper_reports_unmapped_when_nothing_survives(esco_db):
    client = FakeClient({"terms": ["machine learning"]}, {"matches": [], "unmapped": []})

    result = map_sections_to_esco({"a": "內容"}, {}, EscoRepository(esco_db), client, PROMPT)

    assert result["status"] == "unmapped"
    assert result["skills"] == []


@pytest.mark.parametrize(("responses", "status", "reason"), [
    ((RuntimeError("boom"),), "failed", "llm_api_error"),
    (("not json",), "needs_review", "invalid_search_terms"),
    (({"terms": ["machine learning"]}, RuntimeError("boom")), "failed", "llm_api_error"),
    (({"terms": ["machine learning"]}, "{broken"), "needs_review", "invalid_llm_output"),
    (({"terms": ["zzzz-no-such-skill"]},), "unmapped", "no_candidates"),
    (({"terms": []},), "unmapped", "no_search_terms"),
])
def test_mapper_never_raises_on_model_problems(esco_db, responses, status, reason):
    result = map_sections_to_esco({"a": "內容"}, {}, EscoRepository(esco_db), FakeClient(*responses), PROMPT)

    assert (result["status"], result["error_reason"]) == (status, reason)
    assert result["skills"] == []


def test_mapper_skips_model_when_source_is_empty(esco_db):
    client = FakeClient()

    result = map_sections_to_esco({"a": "  ", "b": None}, {}, EscoRepository(esco_db), client, PROMPT)

    assert result["status"] == "unmapped"
    assert client.calls == []


def test_clean_sections_returns_new_dict_and_truncates():
    source = {"a": "x" * 5000, "b": ""}

    cleaned = clean_sections(source)

    assert set(cleaned) == {"a"}
    assert len(cleaned["a"]) == 1200
    assert len(source["a"]) == 5000


def test_relations_are_stored_in_both_directions_and_filtered(esco_db, tmp_path):
    # Arrange
    broader = tmp_path / "broader.csv"
    broader.write_text(
        "conceptType,conceptUri,conceptLabel,broaderType,broaderUri,broaderLabel\n"
        f"x,{DL},deep learning,x,{ML},machine learning\n"
        f"x,{ML},machine learning,x,http://data.europa.eu/esco/skill/not-in-catalogue,group\n", encoding="utf-8")
    related = tmp_path / "related.csv"
    related.write_text(
        "originalSkillUri,originalSkillType,relationType,relatedSkillType,relatedSkillUri\n"
        f"{ML},knowledge,optional,knowledge,{PY}\n", encoding="utf-8")

    # Act
    summary = initialize_relations(esco_db, broader, related)
    again = initialize_relations(esco_db, broader, related)

    # Assert
    with closing(sqlite3.connect(esco_db)) as conn:
        rows = set(conn.execute("SELECT concept_uri, related_uri, relation FROM esco_skill_relations"))
    assert rows == {(DL, ML, "broader"), (ML, DL, "narrower"), (ML, PY, "related"), (PY, ML, "related")}
    assert summary["stored_rows"] == again["stored_rows"] == 4


def test_hub_db_replaces_skills_and_tracks_finished_ids(tmp_path):
    # Arrange
    db_path = tmp_path / "hub.sqlite"
    hub_db.initialize(db_path)
    skill = {"conceptUri": ML, "source_section": "skill[0]", "evidence": "機器學習"}
    advisor = {"teacher_id": "T1", "name": "王Ｏ明", "college": "資電學院", "department": "資訊系",
               "expertise": ["機器學習"], "status": "mapped", "model": "fake"}

    # Act
    hub_db.save_advisor(db_path, advisor, [skill, {**skill, "conceptUri": PY}])
    hub_db.save_advisor(db_path, advisor, [skill])
    hub_db.save_advisor(db_path, {**advisor, "teacher_id": "T2", "status": "failed"}, [])
    hub_db.save_competition(db_path, {
        "competition_id": "C1", "name": "測試賽", "source_site": "test", "source_url": "https://example.org/c1",
        "eligibility": {"student_required": True}, "conditions": [{"text": "需在學"}], "status": "mapped",
        "fetched_at": hub_db.now_iso()}, [skill])

    # Assert
    with closing(sqlite3.connect(db_path)) as conn:
        advisor_skills = conn.execute("SELECT concept_uri FROM entity_skills WHERE entity_type='advisor'").fetchall()
        eligibility = conn.execute("SELECT eligibility_json FROM competitions").fetchone()[0]
    assert advisor_skills == [(ML,)]
    assert json.loads(eligibility) == {"student_required": True}
    assert hub_db.finished_ids(db_path, "advisors", "teacher_id") == {"T1"}
    assert hub_db.finished_ids(db_path, "competitions", "competition_id") == {"C1"}
    assert hub_db.finished_ids(tmp_path / "missing.sqlite", "advisors", "teacher_id") == set()
    with pytest.raises(ValueError):
        hub_db.finished_ids(db_path, "entity_skills", "entity_id")


def test_translate_missing_saves_only_valid_labels_and_never_raises(esco_db):
    # Arrange
    from shared.esco.labels_zh import translate_missing

    uris = {ML, PY, DL, "http://data.europa.eu/esco/skill/not-in-catalogue"}
    client = FakeClient({"items": [{"id": "t01", "zh": " 機器  學習 "}, {"id": "t02", "zh": ""},
                                   {"id": "t99", "zh": "不存在的代號"}, {"id": "t03", "zh": "Python 程式設計"}]})

    # Act：空白的那一筆與不存在的代號被丟棄，其餘照常保存；模型出錯時不丟例外
    first = translate_missing(esco_db, client, uris, "fake")
    broken = translate_missing(esco_db, FakeClient(RuntimeError("boom")), uris, "fake")
    garbage = translate_missing(esco_db, FakeClient("not json"), uris, "fake")

    # Assert
    with closing(sqlite3.connect(esco_db)) as conn:
        rows = sorted(conn.execute("SELECT label_zh, model FROM esco_labels_zh").fetchall())
    assert first == {"pending": 3, "translated": 2}
    assert rows == [("Python 程式設計", "fake"), ("機器 學習", "fake")]
    assert broken == garbage == {"pending": 1, "translated": 0}


def test_used_uris_reads_both_databases_and_tolerates_missing_tables(esco_db, tmp_path):
    from shared.esco.labels_zh import used_uris

    hub_path, course_path = tmp_path / "hub.sqlite", tmp_path / "courses.sqlite"
    hub_db.initialize(hub_path)
    hub_db.save_advisor(hub_path, {"teacher_id": "T1", "name": "測試", "status": "mapped"},
                        [{"conceptUri": ML, "source_section": "skill[0]", "evidence": "機器學習"}])
    with closing(sqlite3.connect(course_path)) as conn, conn:
        conn.execute("CREATE TABLE unrelated (x TEXT)")

    assert used_uris(hub_path, course_path) == {ML}
    assert used_uris(None, tmp_path / "missing.sqlite") == set()


def test_mapper_puts_skills_already_in_use_first_and_flags_them(esco_db):
    # Arrange：deep learning 只在描述中提到 machine learning，原本排在後面
    client = FakeClient({"terms": ["machine learning"]}, {"matches": [], "unmapped": []})

    # Act
    map_sections_to_esco({"a": "深度學習"}, {}, EscoRepository(esco_db), client, PROMPT, frozenset({DL}))

    # Assert：已被其他邊使用的技能排到最前面並標示 in_use；其餘候選不標示
    candidates = json.loads(client.calls[1][1])["candidates"]
    assert candidates[0]["label"] == "deep learning" and candidates[0]["in_use"] is True
    assert all("in_use" not in item for item in candidates[1:])
    assert "in_use" in client.calls[1][0]


def test_mapper_without_alignment_keeps_relevance_order(esco_db):
    client = FakeClient({"terms": ["machine learning"]}, {"matches": [], "unmapped": []})

    map_sections_to_esco({"a": "深度學習"}, {}, EscoRepository(esco_db), client, PROMPT)

    candidates = json.loads(client.calls[1][1])["candidates"]
    assert candidates[0]["label"] == "machine learning"
    assert "in_use" not in client.calls[1][0]


class FakeEmbedder:
    """以預先指定的向量回應；記錄被要求嵌入的文字。"""
    model = "fake-embed"

    def __init__(self, vectors):
        self.vectors = vectors
        self.texts = []

    def embed(self, texts):
        self.texts.extend(texts)
        return [self.vectors[text.split(":")[0]] for text in texts]


def test_update_similarity_links_competition_skills_to_close_campus_skills(esco_db, tmp_path):
    # Arrange：比賽需要 machine learning；校內（教師）有 deep learning（很接近）與 Python（不接近）
    from shared.esco.similarity import update_similarity

    hub_path = tmp_path / "hub.sqlite"
    hub_db.initialize(hub_path)
    skill = lambda uri: {"conceptUri": uri, "source_section": "s", "evidence": "e"}  # noqa: E731
    hub_db.save_competition(hub_path, {"competition_id": "C1", "name": "測試賽", "source_site": "t",
                                       "source_url": "https://example.org", "status": "mapped",
                                       "fetched_at": hub_db.now_iso()}, [skill(ML)])
    hub_db.save_advisor(hub_path, {"teacher_id": "T1", "name": "測試", "status": "mapped"}, [skill(DL), skill(PY)])
    embedder = FakeEmbedder({"machine learning": [1.0, 0.0], "deep learning": [0.9, 0.3],
                             "Python (computer programming)": [0.1, 1.0]})

    # Act
    first = update_similarity(esco_db, hub_path, None, embedder)
    second = update_similarity(esco_db, hub_path, None, embedder)

    # Assert：只連到夠接近的技能，雙向各一列；第二次不重複嵌入
    with closing(sqlite3.connect(esco_db)) as conn:
        rows = sorted(conn.execute("SELECT concept_uri, related_uri FROM esco_skill_similar"))
    assert rows == sorted([(ML, DL), (DL, ML)])
    assert first == {"anchors": 1, "pool": 3, "embedded": 3, "similar_pairs": 1}
    assert second["embedded"] == 0 and len(embedder.texts) == 3


def test_update_similarity_never_raises(esco_db, tmp_path):
    from shared.esco.similarity import update_similarity

    class Broken:
        model = "broken"

        def embed(self, texts):
            raise RuntimeError("boom")

    hub_path = tmp_path / "hub.sqlite"
    hub_db.initialize(hub_path)
    hub_db.save_advisor(hub_path, {"teacher_id": "T1", "name": "測試", "status": "mapped"},
                        [{"conceptUri": ML, "source_section": "s", "evidence": "e"}])

    assert update_similarity(esco_db, hub_path, None, Broken())["similar_pairs"] == 0
    assert update_similarity(esco_db, tmp_path / "missing.sqlite", None, Broken()) == {
        "anchors": 0, "pool": 0, "embedded": 0, "similar_pairs": 0}


def test_similar_pairs_respects_threshold_and_top_k():
    from array import array

    from shared.esco.similarity import similar_pairs

    unit = lambda x, y: array("f", [x, y])  # noqa: E731
    anchors = {"a": unit(1.0, 0.0)}
    pool = {"a": unit(1.0, 0.0), "close1": unit(0.99, 0.14), "close2": unit(0.95, 0.31), "far": unit(0.0, 1.0)}

    pairs = similar_pairs(anchors, pool, threshold=0.9, top_k=1)

    assert set(pairs) == {("a", "close1"), ("close1", "a")}
    assert set(similar_pairs(anchors, pool, threshold=0.9, top_k=5)) == {
        ("a", "close1"), ("close1", "a"), ("a", "close2"), ("close2", "a")}


def test_failed_rerun_keeps_previous_finished_result(tmp_path):
    # Arrange：先有確定結果，之後以 --force 重跑但模型失敗
    db_path = tmp_path / "hub.sqlite"
    hub_db.initialize(db_path)
    skill = {"conceptUri": ML, "source_section": "skill[0]", "evidence": "機器學習"}
    advisor = {"teacher_id": "T1", "name": "測試", "status": "mapped", "model": "m1"}
    contest = {"competition_id": "C1", "name": "測試賽", "source_site": "t", "source_url": "https://example.org",
               "status": "mapped", "fetched_at": hub_db.now_iso()}
    hub_db.save_advisor(db_path, advisor, [skill])
    hub_db.save_competition(db_path, contest, [skill])

    # Act
    hub_db.save_advisor(db_path, {**advisor, "status": "failed", "error_reason": "llm_api_error"}, [])
    hub_db.save_competition(db_path, {**contest, "status": "needs_review"}, [])
    hub_db.save_advisor(db_path, {**advisor, "teacher_id": "T2", "status": "failed"}, [])

    # Assert：一次失敗不清掉既有的技能與狀態；原本沒有結果的照常記錄失敗
    with closing(sqlite3.connect(db_path)) as conn:
        statuses = dict(conn.execute("SELECT teacher_id, status FROM advisors"))
        contest_status = conn.execute("SELECT status FROM competitions").fetchone()[0]
        links = conn.execute("SELECT count(*) FROM entity_skills").fetchone()[0]
    assert statuses == {"T1": "mapped", "T2": "failed"}
    assert contest_status == "mapped" and links == 2


def test_run_batch_counts_exceptions_without_using_the_error_key():
    from shared.hub.batch import run_batch

    def analyze(item):
        if item == "bad":
            raise RuntimeError("boom")
        return {"status": "mapped"}

    saved = []
    summary = run_batch(["a", "bad", "b"], analyze, lambda item, result: saved.append(item), workers=2)

    assert summary == {"total": 3, "mapped": 2, "errors": 1}
    assert sorted(saved) == ["a", "b"] and "error" not in summary


def test_mapper_rejects_single_character_evidence(esco_db):
    client = FakeClient({"terms": ["machine learning"]},
                        {"matches": [{"id": "c01", "label": "machine learning", "source_section": "a", "evidence": "需"}]})

    result = map_sections_to_esco({"a": "參賽者需自備筆電"}, {}, EscoRepository(esco_db), client, PROMPT)

    assert (result["status"], result["rejected"]) == ("unmapped", 1)
