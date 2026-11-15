"""教師 profile → ESCO 技能。

讀取系所公開的教師資料（專長、論文、研究計畫、產學、專利、專書），對應到共用 ESCO 技能目錄，
並保留每一項技能的原文出處。結果表示「教師資料中有這項專長的文字證據」，
不代表教師的能力評分，也不代表教師同意指導。

資料最小化：送給模型的只有專長條列與論文／計畫標題，不含姓名、學經歷與共同作者。
"""

import json
from pathlib import Path

from shared.esco.mapper import MappingPrompt, map_sections_to_esco
from shared.llm import JsonClient

# 各類資料最多取幾筆；專長條列最能代表教師自述的專業，全部保留
SECTION_LIMITS = (
    ("skill", None, 30),
    ("journal", "論文名稱", 15),
    ("conference", "論文名稱", 10),
    ("most", "name", 10),
    ("induAca", None, 6),
    ("patent", "desc", 5),
    ("book", "專業書籍", 4),
)
ITEM_CHARS = 200
# 計畫或專書標題偶爾會寫到教師本人的姓名；送給模型與保存證據之前先換掉
NAME_PLACEHOLDER = "（教師本人）"

ADVISOR_PROMPT = MappingPrompt(
    source_name="大學教師的專長條列與研究成果標題",
    term_rule="搜尋詞要涵蓋這位教師能指導學生的主要專業能力，優先依據專長條列（skill 開頭的段落）；",
    select_rule="選擇這位教師具備、可以指導學生的專業技能或知識。優先採用專長條列（skill 開頭的段落）作為證據；"
                "論文與計畫標題只用來佐證與專長條列或研究主軸一致的技能，不要只因為某一篇標題提到某個詞就選。",
    max_terms=8, max_candidates=40, max_matches=12,
)


def load_teacher(path: Path) -> dict:
    """讀取單一教師 JSON；缺少識別欄位視為無效資料。"""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict) or not data.get("teacherId") or not data.get("name"):
        raise ValueError(f"教師資料缺少 teacherId 或 name：{path}")
    return data


def _item_text(item, field: str | None) -> str:
    if isinstance(item, str):
        return item
    if isinstance(item, dict) and field:
        return str(item.get(field) or "")
    return ""


def build_sections(teacher: dict) -> dict[str, str]:
    """把教師資料攤平成「段落鍵名 → 原文」，鍵名可回溯到原始欄位與索引。"""
    sections: dict[str, str] = {}
    name = str(teacher.get("name") or "").strip()
    for key, field, limit in SECTION_LIMITS:
        for index, item in enumerate((teacher.get(key) or [])[:limit]):
            text = " ".join(_item_text(item, field).split())
            if name:
                text = text.replace(name, NAME_PLACEHOLDER)
            text = text[:ITEM_CHARS]
            if text:
                sections[f"{key}[{index}]"] = text
    return sections


def public_record(teacher: dict) -> dict:
    """寫入技能中樞的教師欄位：只留媒合需要的資訊。"""
    return {
        "teacher_id": teacher["teacherId"],
        "name": teacher["name"],
        "college": teacher.get("mainUnit") or None,
        "department": teacher.get("detailUnit") or None,
        "expertise": [" ".join(str(x).split()) for x in (teacher.get("skill") or []) if str(x).strip()],
    }


def analyze_teacher(teacher: dict, repository, client: JsonClient) -> dict:
    """回傳對應結果（含 status 與 skills）；沒有任何可用文字時不呼叫模型。"""
    header = {"department": teacher.get("detailUnit") or teacher.get("mainUnit") or ""}
    return map_sections_to_esco(build_sections(teacher), header, repository, client, ADVISOR_PROMPT)
