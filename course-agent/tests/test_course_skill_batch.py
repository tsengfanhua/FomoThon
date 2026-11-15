"""課程 → ESCO 技能的批次分析：挑課規則、分析、保存與分析狀態。使用假模型，不呼叫外部服務。"""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from shared.esco.repository import EscoRepository  # noqa: E402
from app.database import INDEX_SCHEMA  # noqa: E402
from app.services.course_skill_batch import (  # noqa: E402
    INCOMPLETE, analyze_course, ensure_status_table, save_course_result, select_courses)
from scripts.analyze_course_skills import enrollment_keys  # noqa: E402

SQL = "http://data.europa.eu/esco/skill/sql"
WEEKS = '[{"tpd_reading":"SQL 查詢","tpd_learn":"練習撰寫 SQL 查詢"}]'


class FakeClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.prompts = []

    def generate(self, system_prompt, user_prompt):
        self.prompts.append(user_prompt)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return json.dumps(response, ensure_ascii=False)


@pytest.fixture
def databases(tmp_path):
    course_db, esco_db = tmp_path / "courses.sqlite", tmp_path / "esco.sqlite"
    rows = [
        ("c-db-a", 114, 2, "1193", "資料庫設計", "學習 SQL 設計技巧", '["熟悉資料庫操作"]', WEEKS),
        ("c-db-b", 114, 2, "1194", "資料庫設計", "學習 SQL 設計技巧", '["熟悉資料庫操作"]', WEEKS),   # 同名另一班
        ("c-empty", 114, 2, "2000", "班級活動", None, "[]", "[]"),                                   # 課綱不完整
        ("c-old", 114, 1, "0500", "程式設計", "學習程式設計", '["寫程式"]', '[{"tpd_learn":"練習"}]'),
    ]
    with sqlite3.connect(course_db) as conn:
        for statement in INDEX_SCHEMA:
            conn.execute(statement)
        conn.executemany("INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)
    with sqlite3.connect(esco_db) as conn:
        conn.execute("CREATE TABLE esco_skills (concept_uri TEXT PRIMARY KEY, preferred_label TEXT NOT NULL, description TEXT NOT NULL)")
        conn.execute("INSERT INTO esco_skills VALUES (?, ?, ?)", (SQL, "SQL", "Structured query language"))
    ensure_status_table(course_db)
    return course_db, esco_db


def mapped_response():
    return [{"terms": ["sql"]},
            {"matches": [{"id": "c01", "label": "SQL", "source_section": "weeklyScds[0].tpd_learn",
                          "evidence": "練習撰寫 SQL 查詢"}], "unmapped": []}]


def test_select_courses_takes_one_complete_section_per_name(databases):
    course_db, _ = databases

    selected = select_courses(course_db, year=114, semester=2)

    assert [c["course_id"] for c in selected] == ["c-db-a"]       # 同名只取代碼最小的一班；課綱不完整的略過
    assert selected[0]["course_code"] == "1193"
    assert [c["course_id"] for c in select_courses(course_db, year=114, semester=2, one_per_name=False)] == ["c-db-a", "c-db-b"]
    assert [c["course_id"] for c in select_courses(course_db)] == ["c-old", "c-db-a"]
    assert len(select_courses(course_db, limit=1)) == 1


def test_select_courses_by_enrollment_keys_keeps_the_exact_section(databases):
    course_db, _ = databases

    selected = select_courses(course_db, keys=[(114, 2, "1194"), (114, 2, "9999"), (114, 2, "2000")])

    # 查無此課的不回傳；課綱不完整的回傳但標示 complete=False，讓呼叫端記下狀態而不是送去分析
    assert [(c["course_id"], c["complete"]) for c in selected] == [("c-db-b", True), ("c-empty", False)]


def test_incomplete_syllabus_is_recorded_once_and_not_selected_again(databases):
    course_db, esco_db = databases

    save_course_result(course_db, esco_db, "c-empty", {"status": INCOMPLETE, "skills": [], "error_reason": "incomplete_syllabus"}, None)

    with sqlite3.connect(course_db) as conn:
        assert conn.execute("SELECT status, error_reason FROM course_analysis WHERE course_id='c-empty'").fetchone() == (
            "incomplete", "incomplete_syllabus")
    assert select_courses(course_db, keys=[(114, 2, "2000")]) == []


def test_limit_zero_selects_nothing(databases):
    course_db, _ = databases

    assert select_courses(course_db, limit=0) == []
    assert len(select_courses(course_db, limit=None)) == 2


def test_analyze_and_save_course_skills(databases):
    course_db, esco_db = databases
    client = FakeClient(*mapped_response())

    result = analyze_course(course_db, EscoRepository(esco_db), "c-db-a", client)
    save_course_result(course_db, esco_db, "c-db-a", result, "fake-model")

    assert result["status"] == "mapped"
    assert "資料庫設計" in client.prompts[0]
    with sqlite3.connect(course_db) as conn:
        links = conn.execute("SELECT course_id, concept_uri, source_section, evidence FROM course_skills").fetchall()
        status = conn.execute("SELECT status, model FROM course_analysis WHERE course_id='c-db-a'").fetchone()
    assert links == [("c-db-a", SQL, "weeklyScds[0].tpd_learn", "練習撰寫 SQL 查詢")]
    assert status == ("mapped", "fake-model")


def test_finished_courses_are_skipped_unless_forced(databases):
    course_db, esco_db = databases
    save_course_result(course_db, esco_db, "c-db-a", {"status": "unmapped", "skills": []}, "fake-model")

    assert select_courses(course_db, year=114, semester=2) == []
    assert [c["course_id"] for c in select_courses(course_db, year=114, semester=2, include_finished=True)] == ["c-db-a"]


def test_failed_analysis_keeps_existing_skills_and_is_retried(databases):
    course_db, esco_db = databases
    repository = EscoRepository(esco_db)
    save_course_result(course_db, esco_db, "c-db-a", analyze_course(course_db, repository, "c-db-a", FakeClient(*mapped_response())), "m1")

    failed = analyze_course(course_db, repository, "c-db-a", FakeClient(RuntimeError("boom")))
    save_course_result(course_db, esco_db, "c-db-a", failed, "m2")

    assert (failed["status"], failed["error_reason"]) == ("failed", "llm_api_error")
    with sqlite3.connect(course_db) as conn:
        # 先前有確定結果時，一次失敗不清掉技能，也不把狀態降級
        assert conn.execute("SELECT count(*) FROM course_skills").fetchone()[0] == 1
        assert conn.execute("SELECT status, model FROM course_analysis").fetchone() == ("mapped", "m1")


def test_first_failure_is_recorded_and_retried(databases):
    course_db, esco_db = databases

    failed = analyze_course(course_db, EscoRepository(esco_db), "c-db-a", FakeClient(RuntimeError("boom")))
    save_course_result(course_db, esco_db, "c-db-a", failed, "m1")

    with sqlite3.connect(course_db) as conn:
        assert conn.execute("SELECT status FROM course_analysis").fetchone()[0] == "failed"
    assert [c["course_id"] for c in select_courses(course_db, year=114, semester=2)] == ["c-db-a"]   # 下次會重跑


def test_save_is_atomic_when_a_skill_is_not_in_the_catalogue(databases):
    # Arrange：先有一筆確定結果
    course_db, esco_db = databases
    repository = EscoRepository(esco_db)
    save_course_result(course_db, esco_db, "c-db-a", analyze_course(course_db, repository, "c-db-a", FakeClient(*mapped_response())), "m1")
    bad = {"status": "mapped", "skills": [
        {"conceptUri": SQL, "source_section": "s", "evidence": "新的證據"},
        {"conceptUri": "http://data.europa.eu/esco/skill/not-in-catalogue", "source_section": "s", "evidence": "e"}]}

    # Act：第二項技能不在共用目錄，整筆儲存要回復
    with pytest.raises(ValueError):
        save_course_result(course_db, esco_db, "c-db-a", bad, "m2")

    # Assert：舊的關聯與狀態原封不動，沒有只寫一半
    with sqlite3.connect(course_db) as conn:
        assert conn.execute("SELECT evidence FROM course_skills").fetchall() == [("練習撰寫 SQL 查詢",)]
        assert conn.execute("SELECT status, model FROM course_analysis").fetchone() == ("mapped", "m1")


def test_reanalysis_replaces_previous_skills(databases):
    course_db, esco_db = databases
    repository = EscoRepository(esco_db)
    save_course_result(course_db, esco_db, "c-db-a", analyze_course(course_db, repository, "c-db-a", FakeClient(*mapped_response())), "m1")

    empty = analyze_course(course_db, repository, "c-db-a", FakeClient({"terms": ["sql"]}, {"matches": [], "unmapped": []}))
    save_course_result(course_db, esco_db, "c-db-a", empty, "m2")

    with sqlite3.connect(course_db) as conn:
        assert conn.execute("SELECT count(*) FROM course_skills").fetchone()[0] == 0
        assert conn.execute("SELECT status FROM course_analysis").fetchone()[0] == "unmapped"


def test_unknown_course_is_reported(databases):
    course_db, esco_db = databases

    result = analyze_course(course_db, EscoRepository(esco_db), "missing", FakeClient())

    assert (result["status"], result["error_reason"]) == ("not_found", "course_not_found")


def test_enrollment_keys_accepts_confirmed_records_and_legacy_code_field():
    raw = json.dumps([{"academic_year": 114, "semester": 2, "course_code": "0772", "course_name": "Python", "grade": 90},
                      {"academic_year": 114, "semester": 1, "selection_code": "0100", "course_name": "微積分"}])

    assert enrollment_keys(raw) == [(114, 2, "0772"), (114, 1, "0100")]


@pytest.mark.parametrize("raw", [
    "{}",
    json.dumps([{"academic_year": "114", "semester": 2, "course_code": "0772"}]),
    json.dumps([{"academic_year": 114, "semester": 2}]),
    json.dumps(["not an object"]),
    json.dumps([{"academic_year": 114, "semester": 2, "course_code": "0001"}] * 201),
])
def test_enrollment_keys_rejects_malformed_input(raw):
    with pytest.raises(ValueError):
        enrollment_keys(raw)


def test_import_course_index_accepts_a_subset_of_terms(tmp_path, databases):
    # Arrange：只有 114-2 一個學期的課綱
    from app.database import import_course_index

    _, esco_db = databases
    term_dir = tmp_path / "syllabi" / "114-2教學大綱"
    term_dir.mkdir(parents=True)
    (term_dir / "course.json").write_text(json.dumps({
        "info": {"yms_year": 114.0, "yms_smester": 2.0, "scr_selcode": "0001", "sub_name": "測試課程"},
        "description": {"describe_ch": "課程描述"}, "targets": [{"describe_ch": "目標"}],
        "weeklyScds": [{"tpd_reading": "主題", "tpd_learn": "活動"}]}, ensure_ascii=False), encoding="utf-8")
    index_db = tmp_path / "index.sqlite"

    # Act
    summary = import_course_index(index_db, tmp_path / "syllabi", esco_db, ("114-2",))

    # Assert：指定的學期可以單獨匯入；預設仍要求四學期齊全；學期格式不對直接拒絕
    assert summary == {"source_courses": {"114-2": 1}, "courses": 1}
    with pytest.raises(ValueError, match="找不到課綱"):
        import_course_index(tmp_path / "other.sqlite", tmp_path / "syllabi", esco_db)
    with pytest.raises(ValueError, match="terms"):
        import_course_index(tmp_path / "other.sqlite", tmp_path / "syllabi", esco_db, ("1142",))
