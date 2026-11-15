"""比賽條件與技能需求的萃取測試：模型輸出一律經原文檢核，對不上的欄位改回未知。"""
import json

import pytest

from competition_agent.hub.crawler import RawCompetition
from competition_agent.hub.requirements import analyze_competition, chunk_text, extract_conditions, is_out_of_scope

GUIDELINE = ("本競賽限全國大專校院在學學生參加，每隊 2 至 4 人，需有一位指導老師。"
             "報名至 2026 年 12 月 20 日截止。作品須以 Python 完成資料分析，並繳交 10 分鐘簡報。")
PYTHON = "http://data.europa.eu/esco/skill/python"


def raw(name="測試黑客松", text=GUIDELINE, deadline="2026-12-31"):
    return RawCompetition(competition_id="test-abc123", source_site="測試站", source_url="https://example.org/c",
                          name=name, organizer="測試基金會", start_date=None, deadline=deadline,
                          keywords=("程式",), text=text, fetched_at="2026-11-13T00:00:00+00:00")


class FakeClient:
    def __init__(self, *responses):
        self.responses = list(responses)

    def generate(self, system_prompt, user_prompt):
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)


class FakeRepository:
    def search_ranked(self, query, limit=15):
        return [{"concept_uri": PYTHON, "preferred_label": "Python (computer programming)", "description": "Python 程式設計"}]


def extraction(**overrides):
    base = {
        "summary": "以 Python 完成資料分析作品的學生競賽", "category": "資訊與程式",
        "student_required": {"value": True, "evidence": "限全國大專校院在學學生參加"},
        "education_levels": {"value": ["大學部", "碩士班", "幼兒園"], "evidence": "全國大專校院在學學生"},
        "team_size": {"min": 2, "max": 4, "evidence": "每隊 2 至 4 人"},
        "requires_advisor": {"value": True, "evidence": "需有一位指導老師"},
        "registration_deadline": {"value": "2026-12-20", "evidence": "報名至 2026 年 12 月 20 日截止"},
        "conditions": [{"text": "需繳交 10 分鐘簡報", "evidence": "並繳交 10 分鐘簡報"},
                       {"text": "需自備筆電", "evidence": "參賽者須自備筆記型電腦"}],
    }
    return {**base, **overrides}


def test_extract_conditions_keeps_fields_backed_by_verbatim_evidence():
    result = extract_conditions(raw(), FakeClient(extraction()))

    assert result["status"] == "mapped"
    assert result["eligibility"] == {"student_required": True, "education_levels": ["大學部", "碩士班"],
                                     "team_min": 2, "team_max": 4, "requires_advisor": True}
    assert result["deadline"] == "2026-12-20"
    # 第二項條件的引文不在簡章中，被丟棄
    assert [c["text"] for c in result["conditions"]] == ["需繳交 10 分鐘簡報"]
    assert result["rejected"] == 1


def test_fields_without_matching_evidence_become_unknown():
    made_up = extraction(
        student_required={"value": False, "evidence": "社會人士亦可參加"},
        team_size={"min": 1, "max": 6, "evidence": "每隊 1 至 6 人"},
        requires_advisor={"value": False, "evidence": None},
        registration_deadline={"value": "2027-01-01", "evidence": "一月一日截止"},
        category="不存在的類別")

    result = extract_conditions(raw(), FakeClient(made_up))

    assert result["eligibility"]["student_required"] is None
    assert (result["eligibility"]["team_min"], result["eligibility"]["team_max"]) == (None, None)
    assert result["eligibility"]["requires_advisor"] is None
    assert result["deadline"] is None
    assert result["category"] == "其他"


def test_trivial_evidence_cannot_back_a_field():
    # 只引一兩個字幾乎一定找得到，不能當成證據；數字也要真的出現在證據中
    weak = extraction(
        student_required={"value": True, "evidence": "參加"},
        team_size={"min": 1, "max": 99, "evidence": "每隊 2 至 4 人"},
        registration_deadline={"value": "2026-12-31", "evidence": "報名至 2026 年 12 月 20 日截止"},
        conditions=[{"text": "需自備筆電", "evidence": "作品"}])

    result = extract_conditions(raw(), FakeClient(weak))

    assert result["eligibility"]["student_required"] is None
    assert (result["eligibility"]["team_min"], result["eligibility"]["team_max"]) == (None, None)
    assert result["deadline"] is None
    assert result["conditions"] == [] and result["rejected"] == 1


def test_one_malformed_field_does_not_void_the_others():
    odd = extraction(summary="長" * 300, team_size={"min": 0, "max": 4, "evidence": "每隊 2 至 4 人"},
                     requires_advisor={"value": 1, "evidence": "需有一位指導老師"},
                     education_levels="大學部",
                     conditions=[{"text": "條件" * 100, "evidence": "並繳交 10 分鐘簡報"}, "不是物件"])

    result = extract_conditions(raw(), FakeClient(odd))

    assert result["status"] == "mapped"
    assert len(result["summary"]) == 120
    assert result["eligibility"]["student_required"] is True          # 沒問題的欄位照常採用
    assert (result["eligibility"]["team_min"], result["eligibility"]["team_max"]) == (None, 4)
    assert result["eligibility"]["requires_advisor"] is None and result["eligibility"]["education_levels"] is None
    assert len(result["conditions"]) == 1 and len(result["conditions"][0]["text"]) == 120
    assert result["rejected"] == 1


def test_contradictory_team_size_and_bad_date_are_dropped():
    odd = extraction(team_size={"min": 4, "max": 2, "evidence": "每隊 2 至 4 人"},
                     registration_deadline={"value": "12/20", "evidence": "報名至 2026 年 12 月 20 日截止"})

    result = extract_conditions(raw(), FakeClient(odd))

    assert (result["eligibility"]["team_min"], result["eligibility"]["team_max"]) == (None, None)
    assert result["deadline"] is None


@pytest.mark.parametrize(("response", "status", "reason"), [
    (RuntimeError("boom"), "failed", "llm_api_error"),
    ("not json", "needs_review", "invalid_llm_output"),
])
def test_extract_conditions_never_raises_on_model_problems(response, status, reason):
    result = extract_conditions(raw(), FakeClient(response))

    assert (result["status"], result["error_reason"]) == (status, reason)
    assert result["conditions"] == [] and result["eligibility"] == {}


def test_empty_guideline_skips_the_model():
    result = extract_conditions(raw(text="  "), FakeClient())

    assert (result["status"], result["error_reason"]) == ("unmapped", "empty_source")


def test_analyze_competition_combines_conditions_and_skills():
    client = FakeClient(
        extraction(),
        {"terms": ["python"]},
        {"matches": [{"id": "c01", "label": "Python (computer programming)", "source_section": "guideline[0]",
                      "evidence": "作品須以 Python 完成資料分析"}], "unmapped": []})

    record, skills = analyze_competition(raw(), FakeRepository(), client)

    assert record["status"] == "mapped" and record["error_reason"] is None
    assert record["category"] == "資訊與程式"
    assert record["deadline"] == "2026-12-31"  # 頁面的結構化截止日優先於模型抽到的日期
    assert [s["conceptUri"] for s in skills] == [PYTHON]
    assert skills[0]["evidence"] == "作品須以 Python 完成資料分析"


def test_analyze_competition_uses_extracted_deadline_when_page_has_none():
    client = FakeClient(extraction(), {"terms": ["python"]}, {"matches": [], "unmapped": []})

    record, skills = analyze_competition(raw(deadline=None), FakeRepository(), client)

    assert record["deadline"] == "2026-12-20"
    assert record["status"] == "unmapped" and skills == []


def test_analyze_competition_reports_failure_of_either_step():
    client = FakeClient(RuntimeError("boom"), {"terms": ["python"]}, {"matches": [], "unmapped": []})

    record, _ = analyze_competition(raw(), FakeRepository(), client)

    assert (record["status"], record["error_reason"]) == ("failed", "llm_api_error")


@pytest.mark.parametrize(("name", "expected"), [
    ("2027 城市馬拉松", True),
    ("兒童繪畫比賽", True),
    ("全國大專暨國小組程式設計賽", False),   # 同時有大專組，保留
    ("校園 AI 創新應用競賽", False),
    ("Bobi Run 公益活動", True),
])
def test_is_out_of_scope_only_drops_obvious_cases(name, expected):
    assert is_out_of_scope(raw(name=name)) is expected


def test_chunk_text_splits_with_traceable_keys():
    chunks = chunk_text("字" * 2500)

    assert list(chunks) == ["guideline[0]", "guideline[1]", "guideline[2]"]
    assert [len(value) for value in chunks.values()] == [1000, 1000, 500]
    assert len(chunk_text("字" * 20000)) == 8
