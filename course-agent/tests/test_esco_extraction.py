"""使用 Mock LLM 驗證課綱對 ESCO 的檢索、證據與保存。"""
import json
import re
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.esco.repository import EscoRepository
from app.database import INDEX_SCHEMA
from app.services.skill_extraction import _syllabus_sections, extract_esco_skills


class MockLLM:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def generate(self, system_prompt, user_prompt):
        self.calls.append(json.loads(user_prompt))
        return json.dumps(next(self.responses), ensure_ascii=False)


@pytest.fixture
def databases(tmp_path):
    course_db, esco_db = tmp_path / "courses.sqlite", tmp_path / "esco.sqlite"
    with sqlite3.connect(course_db) as conn:
        for statement in INDEX_SCHEMA:
            conn.execute(statement)
        conn.execute("INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     ("c1", 113, 1, "0001", "程式設計", "學習程式設計", '["熟悉 Swift 語法"]',
                      '[{"tpd_reading":"<div>主題</div>","tpd_learn":"<p>練習 Swift&nbsp;程式設計</p>"}]'))
    with sqlite3.connect(esco_db) as conn:
        conn.execute("CREATE TABLE esco_skills (concept_uri TEXT PRIMARY KEY, preferred_label TEXT, description TEXT)")
        conn.executemany("INSERT INTO esco_skills VALUES (?, ?, ?)", [
            ("uri:swift", "Swift programming", "programming language"),
            ("uri:management", "management", "manage a business")])
    return course_db, EscoRepository(esco_db)


def output(uri="uri:swift", evidence="練習 Swift 程式設計", section="weeklyScds[0].tpd_learn"):
    return {"matches": [{"conceptUri": uri, "source_section": section, "evidence": evidence}], "unmapped": []}


def run(databases, answer, terms=None):
    course_db, repo = databases
    llm = MockLLM({"terms": terms or ["swift"]}, answer)
    return extract_esco_skills(course_db, repo, "c1", llm), llm


def test_valid_match_and_repeat_preserves_first_evidence(databases):
    result, llm = run(databases, output())
    assert result["status"] == "mapped"
    assert result["skills"][0]["preferredLabel"] == "Swift programming"
    assert llm.calls[0]["sections"]["weeklyScds[0].tpd_learn"] == "練習 Swift 程式設計"
    assert all("<" not in value for value in llm.calls[0]["sections"].values())
    second, _ = run(databases, output(evidence="熟悉 Swift 語法", section="targets[0].describe_ch"))
    assert second["status"] == "mapped"
    with sqlite3.connect(databases[0]) as conn:
        assert conn.execute("SELECT concept_uri,evidence FROM course_skills").fetchall() == [("uri:swift", "練習 Swift 程式設計")]


@pytest.mark.parametrize(("answer", "reason"), [
    (output("uri:unknown"), "uri_not_in_candidates"),
    (output("uri:management"), "uri_not_in_candidates"),
    (output(evidence="不存在"), "evidence_not_in_source"),
    (output(evidence="程式設計", section="course_name"), "evidence_not_in_source"),
])
def test_invalid_results_are_rejected_without_writes(databases, answer, reason):
    result, _ = run(databases, answer)
    assert (result["status"], result["error_reason"]) == ("needs_review", reason)
    with sqlite3.connect(databases[0]) as conn:
        assert conn.execute("SELECT count(*) FROM course_skills").fetchone()[0] == 0


def test_uri_disappears_from_repository_is_rejected(databases, monkeypatch):
    monkeypatch.setattr(databases[1], "get", lambda uri: None)
    result, _ = run(databases, output())
    assert result["error_reason"] == "uri_not_in_repository"


def test_no_match_and_no_candidates(databases):
    result, _ = run(databases, {"matches": [], "unmapped": ["證據不足"]})
    assert result["status"] == "unmapped" and result["unmapped"] == ["證據不足"]
    result, llm = run(databases, {}, terms=["nonexistent"])
    assert result["status"] == "unmapped" and len(llm.calls) == 1


def test_invalid_terms_are_rejected(databases):
    result, llm = run(databases, {}, terms=["中文"])
    assert result["error_reason"] == "invalid_search_terms" and len(llm.calls) == 1


def test_whole_result_rejected_if_one_match_is_invalid(databases):
    answer = output()
    answer["matches"].append(output("uri:unknown")["matches"][0])
    result, _ = run(databases, answer)
    assert result["error_reason"] == "uri_not_in_candidates"
    with sqlite3.connect(databases[0]) as conn:
        assert conn.execute("SELECT count(*) FROM course_skills").fetchone()[0] == 0


def test_search_and_prompt_are_bounded(databases, monkeypatch):
    queries = []

    def search(term, limit):
        queries.append((term, limit))
        return [{"concept_uri": f"{term}:{i}", "preferred_label": term,
                 "description": "description"} for i in range(limit)]

    monkeypatch.setattr(databases[1], "search", search)
    terms = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]
    result, llm = run(databases, {"matches": [], "unmapped": []}, terms=terms)
    assert result["status"] == "unmapped"
    assert len(queries) == 6 and all(limit == 20 for _, limit in queries)
    assert len(llm.calls[1]["candidates"]) == 30


def test_phrase_falls_back_to_distinct_keyword(databases):
    result, llm = run(databases, output(), terms=["swift programming"])
    assert result["status"] == "mapped"
    assert any(item["concept_uri"] == "uri:swift" for item in llm.calls[1]["candidates"])


def test_fallback_queries_are_bounded(databases, monkeypatch):
    queries = []

    def search(term, limit):
        queries.append(term)
        return []

    monkeypatch.setattr(databases[1], "search", search)
    terms = ["alpha design", "beta design", "gamma design", "delta design", "epsilon design", "zeta design"]
    result, _ = run(databases, {}, terms=terms)
    assert result["status"] == "unmapped"
    assert len(queries) == 12 and len(set(queries)) == 12


def test_llm_exception_is_not_disclosed(databases):
    class Broken:
        def generate(self, *args):
            raise RuntimeError("sensitive")

    result = extract_esco_skills(databases[0], databases[1], "c1", Broken())
    assert result["status"] == "failed" and result["error_reason"] == "llm_api_error"
    assert "sensitive" not in str(result)


def test_actual_courses_with_mock_llm(tmp_path):
    root = Path(__file__).resolve().parents[2]
    source = root / "course-agent/data/processed/course_index.sqlite"
    esco = root / "data/shared/esco_skills.sqlite"
    if not source.exists() or not esco.exists():
        pytest.skip("未提供本機課綱或共用 ESCO 資料庫")
    course_db = tmp_path / "real_courses.sqlite"
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as original, sqlite3.connect(course_db) as target:
        for statement in INDEX_SCHEMA:
            target.execute(statement)
        rows = original.execute("SELECT * FROM courses WHERE year=113 AND semester=1 AND selection_code IN ('0899','0008')").fetchall()
        target.executemany("INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    by_code = {row[3]: row for row in rows}
    if set(by_code) != {"0899", "0008"}:
        # 本機索引可能只匯入了部分學期（例如只有 114 學年），沒有這兩門 113-1 的驗收課程
        pytest.skip("本機課程索引未包含 113-1 的驗收課程")
    repo = EscoRepository(esco)
    swift = repo.search("swift", limit=10)[0]
    llm = MockLLM({"terms": ["Swift"]}, output(swift["concept_uri"], "使學生熟悉Swift語法並用以開發iOS APP", "targets[1].describe_ch"))
    ios = extract_esco_skills(course_db, repo, by_code["0899"][0], llm)
    assert ios["status"] == "mapped" and ios["skills"][0]["preferredLabel"] == "Swift (computer programming)"
    chinese_row = dict(zip(("course_id", "year", "semester", "selection_code", "course_name", "description", "targets", "weekly_schedule"), by_code["0008"]))
    chinese_row["targets"] = json.loads(chinese_row["targets"])
    chinese_row["weekly_schedule"] = json.loads(chinese_row["weekly_schedule"])
    assert not re.search(r"[A-Za-z]", " ".join(_syllabus_sections(chinese_row).values()))
    llm = MockLLM({"terms": ["gender equality"]}, {"matches": [], "unmapped": ["只有認識性別平等，未證明具體操作"]})
    chinese = extract_esco_skills(course_db, repo, by_code["0008"][0], llm)
    assert chinese["status"] == "unmapped"
    assert len(llm.calls[1]["candidates"]) > 0
