import json
import sqlite3

from app.database import INDEX_SCHEMA
from app.services.course_resolver import resolve_course
from app.services.document_parser import parse_document
from app.services.enrollment_extractor import extract_enrollments
from app.services.esco_profile import analyze_esco_enrollments
from app.services.syllabus_client import SyllabusError, fetch_syllabus
from scripts.generate_synthetic_transcripts import generate
from shared.esco.repository import EscoRepository


def sample(name="甲", code="0001"):
    return {"year": 113, "semester": 2, "course_code": code, "course_name": name,
            "description": "介紹", "targets": ["熟悉 Swift 語法"],
            "weekly_schedule": [{"tpd_reading": "", "tpd_learn": "練習 Swift 程式設計"}],
            "identity": {"yms_year": 113, "yms_smester": 2, "scr_selcode": code, "sub_name": name,
                         "sub_id": "s1", "cls_id": "c1", "scr_dup": "001"},
            "source_url": "https://coursesearch01.fcu.edu.tw/CourseOutline.aspx?lang=cht&courseid=11320001",
            "fetched_at": "2026-11-12T00:00:00+00:00"}


def setup_db(tmp_path):
    db = tmp_path / "courses.sqlite"
    esco = tmp_path / "esco.sqlite"
    with sqlite3.connect(db) as c:
        for statement in INDEX_SCHEMA:
            c.execute(statement)
        c.execute("INSERT INTO courses VALUES (?,?,?,?,?,?,?,?)", ("old", 113, 2, "0001", "甲", None, "[]", "[]"))
        c.execute("INSERT INTO courses VALUES (?,?,?,?,?,?,?,?)", ("full", 113, 2, "0002", "乙", "介紹", '["熟悉 Swift 語法"]', '[{"tpd_learn":"練習 Swift 程式設計"}]'))
    with sqlite3.connect(esco) as c:
        c.execute("CREATE TABLE esco_skills (concept_uri TEXT PRIMARY KEY, preferred_label TEXT, description TEXT)")
        c.execute("INSERT INTO esco_skills VALUES ('uri:swift','Swift programming','programming')")
    return db, EscoRepository(esco)


def record(name="甲", code="0001", grade=60):
    return {"academic_year": 113, "semester": 2, "course_code": code, "course_name": name, "credits": 3, "grade": grade}


class MockLLM:
    def __init__(self):
        self.calls = []

    def generate(self, system_prompt, user_prompt):
        self.calls.append(json.loads(user_prompt))
        if "搜尋詞" in system_prompt:
            return json.dumps({"terms": ["swift"]})
        return json.dumps({"matches": [{"conceptUri": "uri:swift", "source_section": "weeklyScds[0].tpd_learn", "evidence": "練習 Swift 程式設計"}], "unmapped": []}, ensure_ascii=False)


def test_transcript_formats(tmp_path, demo_course_db):
    generate(tmp_path, demo_course_db)
    paths = [tmp_path / f"student_demo_001.{suffix}" for suffix in ("json", "xlsx", "pdf")]
    parsed = [extract_enrollments(parse_document(p.name, p.read_bytes())) for p in paths]
    assert all(result == parsed[0] for result in parsed)
    records, warnings, missing = parsed[0]
    assert not warnings and not missing
    assert all("course_id" not in record for record in records)
    assert records[0]["course_code"] == "0772" and records[0]["credits"] == 3
    assert [r["grade"] for r in records[:3]] == [86, 79, 91]
    rows = [["academic_year", "semester", "course_name", "grade"], [113, 2, "甲", None]]
    assert extract_enrollments(rows)[0][0]["grade"] is None


def test_website_import_cache_and_multicourse(tmp_path):
    db, repo = setup_db(tmp_path)
    calls = []
    def fetch(*args):
        calls.append(args)
        return sample()
    llm = MockLLM()
    result = analyze_esco_enrollments([record(), record("乙", "0002", 88), record("不存在", None)], db, repo, llm, fetch)
    assert [c["status"] for c in result["courses"]] == ["matched", "matched", "needs_confirmation"]
    assert len(calls) == 1
    assert len(result["skills"]) == 1 and len(result["skills"][0]["evidence"]) == 2
    assert result["courses"][0]["enrollment"]["grade"] == 60
    assert all("course_id" not in item["enrollment"] for item in result["courses"])
    assert all(item.get("course_id") for item in result["courses"][:2])
    assert "score" not in json.dumps(result, ensure_ascii=False)
    assert llm.calls[0]["course_code"] == "0001" and "selection_code" not in llm.calls[0]
    assert all("grade" not in json.dumps(call) and "credits" not in json.dumps(call) for call in llm.calls)
    again = resolve_course(db, record(), fetch)
    assert again["status"] == "matched" and again["source"] == "website_cache" and len(calls) == 1
    with sqlite3.connect(db) as c:
        assert c.execute("select count(*) from courses").fetchone()[0] == 3
        assert c.execute("select count(*) from website_course_sources").fetchone()[0] == 1
        assert c.execute("select count(*) from course_skills").fetchone()[0] == 2


def test_conflict_mismatch_and_failure(tmp_path):
    db, _ = setup_db(tmp_path)
    bad = sample(name="錯誤")
    assert resolve_course(db, record(), lambda *args: bad)["reason"] == "identity_mismatch"
    def fail(*args):
        raise SyllabusError("website_unavailable")
    assert resolve_course(db, record(), fail)["reason"] == "website_unavailable"
    with sqlite3.connect(db) as c:
        c.execute("INSERT INTO courses VALUES ('other',113,2,'0001','別門',NULL,'[]','[]')")
    assert resolve_course(db, record(), lambda *args: (_ for _ in ()).throw(AssertionError()))["reason"] == "conflicting_course_code"


def test_website_http_flow_and_identity_validation():
    import pytest
    class Response:
        def __init__(self, status=200, text="", data=None, headers=None):
            self.status_code, self.text, self._data, self.headers = status, text, data, headers or {}
        def raise_for_status(self):
            if self.status_code >= 400:
                import requests
                raise requests.HTTPError()
        def json(self):
            return self._data
    payload = sample()
    info = payload["identity"]
    body = {"success": True, "info": info, "description": {"describe_ch": "<p>介紹</p>"},
            "targets": [{"describe_ch": "<b>目標</b>"}],
            "weeklyScds": [{"tpd_reading": "<div>閱讀</div>", "tpd_learn": "練習&nbsp;Swift"}]}
    class Session:
        def __init__(self, result):
            self.result, self.calls = result, []
        def request(self, method, url, **kwargs):
            self.calls.append((method, url))
            if len(self.calls) == 1:
                return Response(503)
            if len(self.calls) == 2:
                return Response(text='<meta http-equiv="refresh" content="0;url=https://coursesearch01.fcu.edu.tw/main.aspx?token=hidden">')
            if len(self.calls) == 3:
                return Response(302, headers={"Location": "https://ilearntools.fcu.edu.tw/W320104/W320104_SyllabusFullVer.aspx?token=hidden"})
            if len(self.calls) == 4:
                return Response()
            return Response(data=self.result)
    s = Session(body)
    result = fetch_syllabus(113, 2, "0001", "甲", session=s)
    assert len(s.calls) == 5 and result["description"] == "介紹"
    assert result["weekly_schedule"][0]["tpd_learn"] == "練習 Swift"
    assert "hidden" not in result["source_url"]
    body["info"] = {**info, "sub_name": "其他"}
    with pytest.raises(SyllabusError, match="identity_mismatch"):
        fetch_syllabus(113, 2, "0001", "甲", session=Session(body))


def test_grade_contract_and_validation_errors(tmp_path):
    import pytest
    from pydantic import ValidationError
    from app.schemas.skills import Enrollment
    base = {"academic_year": 113, "semester": 2, "course_code": "0001", "course_name": "甲", "credits": 3}
    with pytest.raises(ValidationError):
        Enrollment.model_validate({**base, "course_id": "internal"})
    for grade in (0, 60, 100, None):
        assert Enrollment.model_validate({**base, "grade": grade}).grade == grade
    for grade in (-1, 101, "A", "B", True, float("nan")):
        with pytest.raises(ValidationError):
            Enrollment.model_validate({**base, "grade": grade})
        if not isinstance(grade, bool):
            rows = [["academic_year", "semester", "course_code", "course_name", "grade"], [113, 2, "0001", "甲", grade]]
            records, warnings, _ = extract_enrollments(rows)
            assert warnings and records[0]["grade"] is not None
    legacy = Enrollment.model_validate({**{k: v for k, v in base.items() if k != "course_code"}, "selection_code": "0001"})
    assert legacy.model_dump()["course_code"] == "0001" and "selection_code" not in legacy.model_dump()
    db, repo = setup_db(tmp_path)
    invalid = analyze_esco_enrollments([record(grade="A"), record(grade=101)], db, repo, MockLLM(), lambda *args: (_ for _ in ()).throw(AssertionError()))
    assert [entry["status"] for entry in invalid["courses"]] == ["invalid_input", "invalid_input"]
    assert invalid["skills"] == []


def test_3715_conflict_never_calls_website(tmp_path):
    db, _ = setup_db(tmp_path)
    with sqlite3.connect(db) as c:
        for identifier, name in (("world", "世界科技文明史"), ("composite", "複合材料力學及結構設計")):
            c.execute("INSERT INTO courses VALUES (?,?,?,?,?,?,?,?)", (identifier, 113, 2, "3715", name, None, "[]", "[]"))
    for name in ("世界科技文明史", "複合材料力學及結構設計"):
        enrollment = {"academic_year": 113, "semester": 2, "course_code": "3715", "course_name": name}
        result = resolve_course(db, enrollment, lambda *args: (_ for _ in ()).throw(AssertionError()))
        assert (result["status"], result["reason"]) == ("needs_confirmation", "conflicting_course_code")


def test_website_fallback_trace(tmp_path):
    from app.services.trace import Trace
    db, repo = setup_db(tmp_path)
    trace = Trace()
    result = analyze_esco_enrollments([record()], db, repo, MockLLM(), lambda *args: sample(), trace=trace)
    assert result['courses'][0]['status'] == 'matched'
    events = [event for event in trace.events if event['step'] == 'website_fallback']
    assert len(events) == 1 and events[0]['status'] == 'success'
    assert 'course_name' not in json.dumps(trace.events)


def test_failure_trace_and_other_course_continues(tmp_path):
    from app.services.trace import Trace
    db, repo = setup_db(tmp_path)
    trace = Trace()
    def failed_fetch(*args):
        raise SyllabusError('website_unavailable')
    result = analyze_esco_enrollments([record(), record('乙', '0002')], db, repo, MockLLM(), failed_fetch, trace)
    assert result['courses'][0]['status'] == 'website_error'
    assert result['courses'][1]['skills_status'] == 'mapped'
    assert any(e['step'] == 'website_fallback' and e['error_code'] == 'website_unavailable' for e in trace.events)
    assert any(e['step'] == 'course_resolution' and e['error_code'] == 'website_unavailable' for e in trace.events)
