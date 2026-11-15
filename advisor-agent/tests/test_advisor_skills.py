"""教師 profile → ESCO 技能：段落攤平、資料最小化與對應流程。不呼叫外部服務。"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.schemas.advisors import AdvisorProfile  # noqa: E402
from app.services.advisor_skills import analyze_teacher, build_sections, load_teacher, public_record  # noqa: E402

ML = "http://data.europa.eu/esco/skill/ml"
TEACHER = {
    "teacherId": "T99001", "name": "王大明", "mainUnit": "資訊學院", "detailUnit": "資訊工程學系",
    "skill": ["機器學習 Machine Learning", "  影像處理  "],
    "edu": ["某大學 博士"],
    "journal": [{"論文名稱": "以深度學習辨識課堂行為", "期刊名稱": "期刊甲", "作者群": "王大明、李小華"}, {"論文名稱": ""}],
    "conference": [{"論文名稱": "邊緣運算上的模型壓縮", "會議名稱": "研討會乙", "作者群": "王大明"}],
    "most": [{"name": "智慧校園資料分析平台", "schoolYear": "113"}],
    "induAca": ["工廠瑕疵檢測產學合作案 (2024-01 to 2024-12)"],
    "patent": [{"title": "發明", "desc": "影像式瑕疵檢測裝置"}],
    "book": [{"專業書籍": "機器學習實務", "出版單位": "出版社", "作者群": "王大明"}],
}


class FakeClient:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.prompts = []

    def generate(self, system_prompt, user_prompt):
        self.prompts.append(user_prompt)
        return json.dumps(self.responses.pop(0), ensure_ascii=False)


class FakeRepository:
    def search_ranked(self, query, limit=15):
        return [{"concept_uri": ML, "preferred_label": "machine learning", "description": "機器學習的原理"}]


def test_build_sections_flattens_profile_with_traceable_keys():
    sections = build_sections(TEACHER)

    assert sections["skill[0]"] == "機器學習 Machine Learning"
    assert sections["skill[1]"] == "影像處理"
    assert sections["journal[0]"] == "以深度學習辨識課堂行為"
    assert "journal[1]" not in sections            # 空白標題不建立段落
    assert sections["most[0]"] == "智慧校園資料分析平台"
    assert sections["induAca[0]"].startswith("工廠瑕疵檢測")
    assert sections["patent[0]"] == "影像式瑕疵檢測裝置"
    assert sections["book[0]"] == "機器學習實務"


def test_sections_exclude_names_and_career_history():
    text = json.dumps(build_sections(TEACHER), ensure_ascii=False)

    assert "王大明" not in text and "李小華" not in text
    assert "博士" not in text and "期刊甲" not in text


def test_own_name_inside_a_title_is_replaced_before_leaving_the_agent():
    titled = {**TEACHER, "most": [{"name": "王大明教授智慧製造研究室設備升級計畫"}]}

    sections = build_sections(titled)

    assert sections["most[0]"] == "（教師本人）教授智慧製造研究室設備升級計畫"
    assert "王大明" not in json.dumps(sections, ensure_ascii=False)


def test_build_sections_limits_items_and_length():
    crowded = {**TEACHER, "journal": [{"論文名稱": f"論文 {i} " + "長" * 400} for i in range(40)]}

    sections = build_sections(crowded)

    assert len([key for key in sections if key.startswith("journal[")]) == 15
    assert all(len(value) <= 200 for value in sections.values())


def test_public_record_keeps_only_matching_fields():
    record = public_record(TEACHER)

    assert record == {"teacher_id": "T99001", "name": "王大明", "college": "資訊學院",
                      "department": "資訊工程學系", "expertise": ["機器學習 Machine Learning", "影像處理"]}


def test_analyze_teacher_maps_skills_without_sending_the_name():
    client = FakeClient(
        {"terms": ["machine learning"]},
        {"matches": [{"id": "c01", "label": "machine learning", "source_section": "skill[0]",
                      "evidence": "機器學習 Machine Learning"}], "unmapped": []})

    result = analyze_teacher(TEACHER, FakeRepository(), client)

    assert result["status"] == "mapped"
    assert [s["conceptUri"] for s in result["skills"]] == [ML]
    assert all("王大明" not in prompt for prompt in client.prompts)
    assert "資訊工程學系" in client.prompts[0]


def test_teacher_without_any_text_is_unmapped_without_calling_the_model():
    client = FakeClient()

    result = analyze_teacher({"teacherId": "T99002", "name": "李小華", "skill": [], "journal": []}, FakeRepository(), client)

    assert (result["status"], result["error_reason"]) == ("unmapped", "empty_source")
    assert client.prompts == []


def test_load_teacher_requires_identity_fields(tmp_path):
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    good.write_text(json.dumps(TEACHER, ensure_ascii=False), encoding="utf-8")
    bad.write_text(json.dumps({"name": "沒有編號"}, ensure_ascii=False), encoding="utf-8")

    assert load_teacher(good)["teacherId"] == "T99001"
    with pytest.raises(ValueError):
        load_teacher(bad)


def test_advisor_profile_accepts_course_objects_and_strings():
    # 種子資料的 courses 有兩種寫法；物件形式過去會讓整個教師 API 回 503
    profile = AdvisorProfile.model_validate({
        "teacher_id": "X1", "teacher_name": "測試",
        "courses": [{"course_id": "C1", "course_name": "密碼學"}, "資料庫系統"]})

    assert profile.courses == ["密碼學", "資料庫系統"]
    assert AdvisorProfile.model_validate({"teacher_id": "X2", "teacher_name": "測試", "courses": None}).courses is None
