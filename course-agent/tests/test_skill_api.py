import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.api.skills import get_client_factory, get_database_path
from app.database import initialize_course_database
from app.main import app
from app.schemas.skills import StudentSkillProfile


class MockLLM:
    def __init__(self, fail_second=False):
        self.prompts = []
        self.fail_second = fail_second

    def generate(self, system_prompt, user_prompt):
        self.prompts.append(user_prompt)
        data = json.loads(user_prompt)
        if self.fail_second and data["course_id"] == "c2":
            raise RuntimeError("secret-api-key")
        return json.dumps({"skills": [{"raw_skill_name": "SQL", "rationale": "練習 SQL",
                                       "evidence": "練習 SQL", "evidence_basis": "explicit_activity"}],
                           "knowledge": [], "topics": []}, ensure_ascii=False)


@pytest.fixture
def api(tmp_path):
    db = tmp_path / "courses.sqlite"
    seed = {"courses": [{"course_id": course_id, "course_name": name, "semester": "114-2", "credits": 3,
                         "syllabus_text": "課程練習 SQL 查詢", "review_status": "confirmed", "text_origin": "synthetic"}
                        for course_id, name in [("c1", "資料庫一"), ("c2", "資料庫二")]]}
    initialize_course_database(db, seed)
    llm = MockLLM()
    app.dependency_overrides[get_database_path] = lambda: db
    app.dependency_overrides[get_client_factory] = lambda: lambda: llm
    with TestClient(app) as client:
        yield client, llm
    app.dependency_overrides.clear()


def test_parse_pdf_xlsx_and_failures(api):
    client, _ = api
    from pathlib import Path
    for ext in ("pdf", "xlsx"):
        path = Path(f"data/demo/synthetic_transcripts/case_duplicate_enrollment.{ext}")
        response = client.post("/api/v1/skills/parse", files={"file": (path.name, path.read_bytes())})
        assert response.status_code == 200
        assert response.json()["status"] == "needs_confirmation"
        assert len(response.json()["enrollments"]) == 2
    assert client.post("/api/v1/skills/parse", files={"file": ("a.txt", b"x")}).status_code == 415
    assert client.post("/api/v1/skills/parse", files={"file": ("bad.pdf", b"bad")}).status_code == 422
    assert client.post("/api/v1/skills/parse", files={"file": ("bad.xlsx", b"bad")}).status_code == 422


def test_complete_flow_and_optional_scoring(api):
    client, llm = api
    payload = {"enrollments": [{"course_name": "資料庫一", "semester": "114-2", "grade": 85}]}
    response = client.post("/api/v1/skills/analyze", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "completed" and result["scoring"] is None
    profile = StudentSkillProfile.model_validate(result["profile"])
    assert profile.skills[0].confirmed is False and profile.skills[0].evidence[0].review_status == "pending"
    assert result["course_statuses"][0]["match_method"] == "course_name_semester"
    assert "85" not in llm.prompts[0]
    payload["scoring"] = {"enabled": True, "numeric_scale": "0_100"}
    scored = client.post("/api/v1/skills/analyze", json=payload).json()
    assert scored["scoring"]["skills"][0]["score"] == 70
    assert scored["profile"] == result["profile"]
    payload["scoring"] = {"enabled": True}
    assert client.post("/api/v1/skills/analyze", json=payload).json()["scoring"]["skills"][0]["score"] is None


def test_match_failures_and_partial_llm_failure(api):
    client, llm = api
    llm.fail_second = True
    data = {"enrollments": [{"course_id": "c1", "semester": "114-2"},
                            {"course_id": "c2", "semester": "114-2"},
                            {"course_id": "unknown", "semester": "114-2"}]}
    response = client.post("/api/v1/skills/analyze", json=data)
    assert response.status_code == 200
    result = response.json()
    assert result["status"] == "partial"
    assert [s["analysis_status"] for s in result["course_statuses"]] == ["completed", "failed", "not_analyzed"]
    assert result["course_statuses"][2]["match_status"] == "not_found"
    assert "secret-api-key" not in response.text
    assert len(llm.prompts) == 2


def test_validation_does_not_echo_sensitive_input(api):
    client, llm = api
    response = client.post("/api/v1/skills/analyze", json={"enrollments": [{"student_id": "private-secret", "grade": 200}]})
    assert response.status_code == 422 and "private-secret" not in response.text
    assert not llm.prompts


def test_database_unavailable(api, tmp_path):
    client, _ = api
    app.dependency_overrides[get_database_path] = lambda: tmp_path / "missing.sqlite"
    response = client.post("/api/v1/skills/analyze", json={"enrollments": []})
    assert response.status_code == 503
    assert str(tmp_path) not in response.text


def test_api_settings_load_dotenv_and_preserve_environment(tmp_path, monkeypatch):
    from app.api import skills

    settings = tmp_path / "test-settings"
    settings.write_text("SKILL_DB_PATH=from-file.sqlite\nSKILL_LLM_MODEL=file-model\n", encoding="utf-8")
    monkeypatch.setattr(skills, "ENV_PATH", settings)
    monkeypatch.setattr(skills, "OpenAIClient", lambda model: model)
    with patch.dict("os.environ", {}, clear=True):
        assert str(skills.get_database_path()) == "from-file.sqlite"
        assert skills.get_client_factory()() == "file-model"
    with patch.dict("os.environ", {"SKILL_DB_PATH": "env.sqlite", "SKILL_LLM_MODEL": "env-model"}, clear=True):
        assert str(skills.get_database_path()) == "env.sqlite"
        assert skills.get_client_factory()() == "env-model"
