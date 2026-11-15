import json
import os
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.database import initialize_course_database
from app.services.llm_client import OpenAIClient
from app.services.skill_extraction import extract_course_skills


class MockLLM:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def generate(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def output(name, evidence, rationale="描述中提到此技能"):
    return json.dumps({"skills": [{"raw_skill_name": name, "rationale": rationale, "evidence": evidence,
                                  "evidence_basis": "course_scope"}],
                       "knowledge": [], "topics": []}, ensure_ascii=False)


@pytest.fixture
def courses(tmp_path):
    seed = json.loads(Path("data/seed/courses.json").read_text(encoding="utf-8"))
    db = tmp_path / "courses.sqlite"
    initialize_course_database(db, seed, allow_unreviewed_demo=True)
    with sqlite3.connect(db) as conn:
        conn.row_factory = sqlite3.Row
        return {row["course_id"]: dict(row) for row in conn.execute(
            "SELECT course_id, course_name, semester, syllabus_text FROM courses WHERE course_id IN ('course_001', 'course_002', 'course_009')")}


@pytest.mark.parametrize(("course_id", "name", "quote"), [
    ("course_001", "Python", "Python程式語言簡介"),
    ("course_002", "資料庫", "資料庫系統的基本原理和架構"),
    ("course_009", "演算法", "演算法設計之技巧"),
])
def test_extract_from_three_matched_sqlite_courses(courses, course_id, name, quote):
    client = MockLLM(output(name, quote))
    result = extract_course_skills(courses[course_id], client)
    assert result.status == "completed"
    assert result.course_id == course_id and result.semester == "114-2"
    assert result.skills[0].evidence == quote
    assert result.skills[0].normalized_skill_name == name
    assert result.skills[0].skill_id is None
    assert result.skills[0].evidence_level == "name_in_quote"
    assert result.skills[0].review_status == "pending"
    assert result.skills[0].evidence_basis == "course_scope"
    assert json.loads(client.calls[0][1])["syllabus_text"] == courses[course_id]["syllabus_text"]


def test_insufficient_description_and_empty_model_result(courses):
    client = MockLLM('{"skills": [], "knowledge": [], "topics": []}')
    result = extract_course_skills({**courses["course_001"], "syllabus_text": " "}, client)
    assert result.status == "insufficient_evidence" and result.attempts == 0
    assert client.calls == []
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "insufficient_evidence" and result.skills == []


def test_topics_and_knowledge_do_not_become_skills(courses):
    course = {**courses["course_001"], "syllabus_text": "課程介紹 Python 程式語言、集合物件與函式。"}
    response = {"skills": [],
                "knowledge": [{"name": "集合物件", "rationale": "介紹概念", "evidence": "集合物件"},
                              {"name": "函式", "rationale": "介紹概念", "evidence": "函式"}],
                "topics": [{"name": "Python 程式語言", "rationale": "課程主題", "evidence": "Python 程式語言"}]}
    result = extract_course_skills(course, MockLLM(json.dumps(response, ensure_ascii=False)))
    assert result.status == "insufficient_evidence" and result.skills == []
    assert [item.name for item in result.knowledge] == ["集合物件", "函式"]
    assert result.topics[0].name == "Python 程式語言"
    assert all(item.review_status == "pending" for item in [*result.knowledge, *result.topics])


def test_concept_evidence_must_match_source(courses):
    response = json.dumps({"skills": [], "knowledge": [{"name": "函式", "rationale": "介紹概念", "evidence": "虛構引文"}], "topics": []}, ensure_ascii=False)
    client = MockLLM(response, response)
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "needs_review" and result.error_reason == "evidence_not_in_source"
    assert result.knowledge == [] and result.attempts == 2


def test_missing_concept_arrays_rejected(courses):
    response = '{"skills": []}'
    result = extract_course_skills(courses["course_001"], MockLLM(response, response))
    assert result.status == "needs_review" and result.error_reason == "invalid_llm_output"


def test_skill_basis_is_retained_and_validated(courses):
    response = {"skills": [
        {"raw_skill_name": "Python 程式設計", "rationale": "有具體練習", "evidence": "練習使用 Python 讀取 CSV", "evidence_basis": "explicit_activity"},
        {"raw_skill_name": "資料處理", "rationale": "列於範圍", "evidence": "資料處理", "evidence_basis": "course_scope"},
    ], "knowledge": [], "topics": []}
    course = {**courses["course_001"], "syllabus_text": "練習使用 Python 讀取 CSV。課程範圍：資料處理。"}
    result = extract_course_skills(course, MockLLM(json.dumps(response, ensure_ascii=False)))
    assert [s.evidence_basis for s in result.skills] == ["explicit_activity", "course_scope"]
    response["skills"][0]["evidence_basis"] = "unknown"
    bad = json.dumps(response, ensure_ascii=False)
    result = extract_course_skills(course, MockLLM(bad, bad))
    assert result.status == "needs_review" and result.error_reason == "invalid_llm_output"


def test_learning_objective_preserved_and_legacy_value_rejected(courses):
    course = {**courses["course_002"], "syllabus_text": "熟悉資料庫管理系統操作。"}
    response = {"skills": [{"raw_skill_name": "資料庫管理系統操作", "rationale": "列為學習目標",
                            "evidence": "熟悉資料庫管理系統操作", "evidence_basis": "learning_objective"}],
                "knowledge": [], "topics": []}
    result = extract_course_skills(course, MockLLM(json.dumps(response, ensure_ascii=False)))
    assert result.skills[0].evidence_basis == "learning_objective"
    response["skills"][0]["evidence_basis"] = "explicit_practice"
    bad = json.dumps(response, ensure_ascii=False)
    result = extract_course_skills(course, MockLLM(bad, bad))
    assert result.status == "needs_review" and result.error_reason == "invalid_llm_output"


@pytest.mark.parametrize(("description", "skills"), [
    ("課程涵蓋 Python 函式、集合物件、資料處理和物件導向設計。", [
        ("Python 程式設計", "Python 函式、集合物件"), ("資料處理", "資料處理"), ("物件導向設計", "物件導向設計")]),
    ("課程涵蓋排版、字體、色彩以及專案管理。", [
        ("視覺設計", "排版、字體、色彩"), ("專案管理", "專案管理")]),
])
def test_skill_scope_examples_preserve_evidence(courses, description, skills):
    response = {"skills": [{"raw_skill_name": name, "rationale": "課程範圍", "evidence": quote,
                             "evidence_basis": "course_scope"} for name, quote in skills],
                "knowledge": [], "topics": []}
    client = MockLLM(json.dumps(response, ensure_ascii=False))
    result = extract_course_skills({**courses["course_001"], "syllabus_text": description}, client)
    assert result.status == "completed"
    assert [(s.raw_skill_name, s.evidence) for s in result.skills] == skills
    assert all(s.review_status == "pending" and s.evidence_basis == "course_scope" for s in result.skills)
    assert json.loads(client.calls[0][1])["syllabus_text"] == description


def test_invalid_json_retried_once_then_success(courses):
    client = MockLLM("not json", output("Python", "Python程式語言簡介"))
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "completed" and result.attempts == len(client.calls) == 2
    assert "invalid_llm_output" in client.calls[1][1]


@pytest.mark.parametrize(("response", "reason"), [
    ("not json", "invalid_llm_output"),
    (output("Python", "不存在的課程內容"), "evidence_not_in_source"),
    ('{"skills": [{"raw_skill_name": "Python"}]}', "invalid_llm_output"),
])
def test_invalid_output_stops_after_two_calls(courses, response, reason):
    client = MockLLM(response, response)
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "needs_review" and result.error_reason == reason
    assert result.skills == [] and result.attempts == len(client.calls) == 2


def test_wrong_evidence_can_recover_and_contextual_level(courses):
    client = MockLLM(output("Python", "不存在"), output("程式設計", "Python程式語言簡介"))
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "completed" and result.attempts == 2
    assert result.skills[0].evidence_level == "contextual_quote"


def test_api_failure_does_not_leak_error_or_retry(courses):
    client = MockLLM(RuntimeError("secret"))
    result = extract_course_skills(courses["course_001"], client)
    assert result.status == "failed" and result.error_reason == "llm_api_error"
    assert result.attempts == len(client.calls) == 1 and result.skills == []
    assert "secret" not in result.model_dump_json()


def test_openai_adapter_disables_sdk_retries(monkeypatch):
    captured = {}

    def make_client(**kwargs):
        captured.update(kwargs)
        def create(**request):
            captured["request"] = request
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"skills": []}'))])
        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    monkeypatch.setattr("app.services.llm_client.OpenAI", make_client)
    monkeypatch.setattr("app.services.llm_client.load_dotenv", lambda *args, **kwargs: None)
    client = OpenAIClient("example-model")
    assert client.generate("system", "user") == '{"skills": []}'
    assert captured["max_retries"] == 0
    assert captured["request"]["model"] == "example-model"


@pytest.mark.parametrize(("existing", "expected"), [(None, "file-test-key"), ("env-test-key", "env-test-key")])
def test_openai_client_loads_project_dotenv_without_overwriting(monkeypatch, tmp_path, existing, expected):
    env_path = tmp_path / ".env"
    env_path.write_text("OPENAI_API_KEY=file-test-key\n", encoding="utf-8")
    monkeypatch.setattr("app.services.llm_client.ENV_PATH", env_path)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    if existing is not None:
        monkeypatch.setenv("OPENAI_API_KEY", existing)
    captured = {}

    def make_client(**kwargs):
        captured["key"] = os.environ.get("OPENAI_API_KEY")
        return object()

    monkeypatch.setattr("app.services.llm_client.OpenAI", make_client)
    OpenAIClient("example-model")
    assert captured["key"] == expected
