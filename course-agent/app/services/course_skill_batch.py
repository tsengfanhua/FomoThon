"""課程 → ESCO 技能的批次分析，供跨 Agent 的技能中樞使用。

輸入沿用 Course Agent 既有的介面：課綱段落來自 ``_syllabus_sections``。儲存與 ``save_course_skill``
做同樣的檢查（ESCO URI 必須存在於共用目錄），但把「清掉舊關聯、寫入新關聯、記錄狀態」放在同一個交易，
中途失敗不會留下只寫一半的結果。對應流程改用 shared/esco/mapper，
與比賽、教師使用同一套檢核（短代號＋名稱核對、逐字證據），讓三邊的技能可以直接比對。

另外記錄每門課的分析狀態：沒有 course_skills 的課，可能是「分析過、確定沒有可對應的技能」，
也可能是「還沒分析」，網站需要分得出來。

結果表示「課綱中有教授這項技能的文字證據」，不是學生的熟練度。
"""

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from app.database import get_indexed_course
from app.services.skill_extraction import _plain_text, _syllabus_sections
from shared.esco.mapper import MappingPrompt, map_sections_to_esco
from shared.llm import JsonClient

COURSE_PROMPT = MappingPrompt(
    source_name="大學課程的課綱",
    term_rule="搜尋詞要對應課程實際教授的能力，不猜測學生程度；",
    select_rule="只根據課程描述、學習目標或每週活動，選擇課程確實教授或練習的技能；不要只憑課名推測。",
    max_terms=6, max_candidates=30, max_matches=12,
)
FINISHED = ("mapped", "unmapped")
# 課綱缺少描述、目標或每週內容：沒有足夠的文字可以分析，記下來就不必每次重試
INCOMPLETE = "incomplete"
STATUS_SCHEMA = """CREATE TABLE IF NOT EXISTS course_analysis (
    course_id TEXT PRIMARY KEY REFERENCES courses(course_id),
    status TEXT NOT NULL, error_reason TEXT, model TEXT, analyzed_at TEXT NOT NULL)"""


def ensure_status_table(course_db: Path) -> None:
    with closing(sqlite3.connect(course_db, timeout=30)) as conn, conn:
        conn.execute(STATUS_SCHEMA)


def _is_complete(row: sqlite3.Row) -> bool:
    """與 course_resolver 相同的完整性條件：描述、目標、每週內容都要有文字。"""
    weeks = json.loads(row["weekly_schedule"])
    return (bool(_plain_text(row["description"]))
            and any(_plain_text(value) for value in json.loads(row["targets"]))
            and any(_plain_text(week.get("tpd_reading")) or _plain_text(week.get("tpd_learn")) for week in weeks))


def select_courses(course_db: Path, *, year: int | None = None, semester: int | None = None,
                   keys: list[tuple[int, int, str]] | None = None, one_per_name: bool = True,
                   include_finished: bool = False, limit: int | None = None) -> list[dict]:
    """挑出待分析的課程；每筆帶有 complete，表示課綱是否完整到可以分析。

    keys 指定時只看這些（學年、學期、選課代碼），課綱不完整的也會回傳（complete=False），
    讓呼叫端記下狀態；否則依學年學期篩選，只回傳課綱完整的課。
    one_per_name 為 True 時，同學期同名的多個開課班只取選課代碼最小、課綱完整的那一班作代表。
    limit 為 None 表示不限；0 表示一筆都不取。
    """
    with closing(sqlite3.connect(f"{Path(course_db).resolve().as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("""SELECT c.*, a.status AS analysis_status FROM courses c
            LEFT JOIN course_analysis a ON a.course_id = c.course_id
            ORDER BY c.year, c.semester, c.selection_code, c.course_id""").fetchall()
    wanted = set(keys) if keys is not None else None
    selected, seen_names = [], set()
    for row in rows:
        key = (row["year"], row["semester"], row["selection_code"])
        if wanted is not None:
            if key not in wanted:
                continue
        elif (year is not None and row["year"] != year) or (semester is not None and row["semester"] != semester):
            continue
        complete = _is_complete(row)
        if not complete and wanted is None:
            continue
        name_key = (row["year"], row["semester"], row["course_name"].strip())
        if wanted is None and one_per_name:
            if name_key in seen_names:
                continue
            seen_names.add(name_key)
        if row["analysis_status"] in (*FINISHED, INCOMPLETE) and not include_finished:
            continue
        selected.append({"course_id": row["course_id"], "year": row["year"], "semester": row["semester"],
                         "course_code": row["selection_code"], "course_name": row["course_name"].strip(),
                         "complete": complete})
    return selected if limit is None else selected[:max(0, limit)]


def analyze_course(course_db: Path, repository, course_id: str, client: JsonClient) -> dict:
    """只做讀取與模型呼叫，不寫資料庫（可在工作執行緒中執行）。"""
    course = get_indexed_course(course_db, course_id)
    if course is None:
        return {"status": "not_found", "skills": [], "error_reason": "course_not_found"}
    header = {"course_name": course["course_name"].strip()}
    return map_sections_to_esco(_syllabus_sections(course), header, repository, client, COURSE_PROMPT)


def save_course_result(course_db: Path, esco_db: Path, course_id: str, result: dict, model: str | None) -> None:
    """以單一交易保存一門課的分析結果。

    有確定結果（mapped／unmapped）時整組取代舊的技能關聯；沒有確定結果（模型失敗、輸出待審）
    而先前有時，保留先前的結果與狀態，不讓一次失敗蓋掉既有資料。
    """
    status = result["status"]
    course_uri = f"{Path(course_db).resolve().as_uri()}?mode=rw"
    with closing(sqlite3.connect(course_uri, uri=True, timeout=30)) as conn:
        conn.execute("ATTACH DATABASE ? AS shared_esco", (f"{Path(esco_db).resolve().as_uri()}?mode=ro",))
        with conn:
            conn.execute("BEGIN")
            previous = conn.execute("SELECT status FROM course_analysis WHERE course_id=?", (course_id,)).fetchone()
            if status not in FINISHED and previous and previous[0] in FINISHED:
                return
            if status in FINISHED:
                conn.execute("DELETE FROM course_skills WHERE course_id=?", (course_id,))
                for skill in result["skills"]:
                    if not conn.execute("SELECT 1 FROM shared_esco.esco_skills WHERE concept_uri=?",
                                        (skill["conceptUri"],)).fetchone():
                        raise ValueError("ESCO URI 不存在")
                    conn.execute("""INSERT INTO course_skills VALUES (?, ?, ?, ?)
                                 ON CONFLICT(course_id, concept_uri) DO NOTHING""",
                                 (course_id, skill["conceptUri"], skill["source_section"], skill["evidence"]))
            conn.execute("INSERT OR REPLACE INTO course_analysis VALUES (?, ?, ?, ?, ?)",
                         (course_id, status, result.get("error_reason"), model,
                          datetime.now(timezone.utc).isoformat(timespec="seconds")))
