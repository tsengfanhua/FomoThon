"""跨 Agent 的技能中樞資料庫（SQLite）。

比賽 Agent 與教師 Agent 把分析結果寫到這裡；網站唯讀。課程與 ESCO 目錄各有自己的資料庫
（course-agent 的 Course SQLite、shared/esco 的 ESCO SQLite），三者以 ESCO concept_uri 串接。

資料最小化：只保存媒合需要的欄位。教師只留姓名、單位與專長條列；比賽不保存主辦單位聯絡資訊。
"""

import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ENTITY_TYPES = ("competition", "advisor")

SCHEMA = (
    """CREATE TABLE IF NOT EXISTS competitions (
        competition_id TEXT PRIMARY KEY, name TEXT NOT NULL, organizer TEXT, category TEXT, summary TEXT,
        source_site TEXT NOT NULL, source_url TEXT NOT NULL, start_date TEXT, deadline TEXT,
        eligibility_json TEXT NOT NULL, conditions_json TEXT NOT NULL,
        status TEXT NOT NULL, error_reason TEXT, fetched_at TEXT NOT NULL, analyzed_at TEXT NOT NULL, model TEXT)""",
    """CREATE TABLE IF NOT EXISTS advisors (
        teacher_id TEXT PRIMARY KEY, name TEXT NOT NULL, college TEXT, department TEXT,
        expertise_json TEXT NOT NULL, status TEXT NOT NULL, error_reason TEXT,
        analyzed_at TEXT NOT NULL, model TEXT)""",
    """CREATE TABLE IF NOT EXISTS entity_skills (
        entity_type TEXT NOT NULL CHECK (entity_type IN ('competition', 'advisor')),
        entity_id TEXT NOT NULL, concept_uri TEXT NOT NULL,
        source_section TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY (entity_type, entity_id, concept_uri))""",
    "CREATE INDEX IF NOT EXISTS idx_entity_skills_uri ON entity_skills(concept_uri, entity_type)",
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def initialize(db_path: Path) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path, timeout=30)) as conn, conn:
        for statement in SCHEMA:
            conn.execute(statement)


def _replace_skills(conn: sqlite3.Connection, entity_type: str, entity_id: str, skills: list[dict]) -> None:
    if entity_type not in ENTITY_TYPES:
        raise ValueError(f"未知的實體類型：{entity_type}")
    conn.execute("DELETE FROM entity_skills WHERE entity_type=? AND entity_id=?", (entity_type, entity_id))
    conn.executemany("INSERT OR IGNORE INTO entity_skills VALUES (?, ?, ?, ?, ?)",
                     [(entity_type, entity_id, s["conceptUri"], s["source_section"], s["evidence"]) for s in skills])


FINISHED = ("mapped", "unmapped")


def _keeps_previous(conn: sqlite3.Connection, table: str, id_column: str, entity_id: str, status: str) -> bool:
    """這次沒有確定結果（模型失敗、輸出待審）而先前有：保留先前的結果，不讓一次失敗清掉既有資料。"""
    if status in FINISHED:
        return False
    row = conn.execute(f"SELECT status FROM {table} WHERE {id_column}=?", (entity_id,)).fetchone()
    return bool(row) and row[0] in FINISHED


def save_competition(db_path: Path, record: dict, skills: list[dict]) -> None:
    """以單一交易更新一筆比賽與它的技能需求（整組取代，不留舊的對應）。"""
    row = (record["competition_id"], record["name"], record.get("organizer"), record.get("category"),
           record.get("summary"), record["source_site"], record["source_url"], record.get("start_date"),
           record.get("deadline"), json.dumps(record.get("eligibility") or {}, ensure_ascii=False),
           json.dumps(record.get("conditions") or [], ensure_ascii=False), record["status"],
           record.get("error_reason"), record["fetched_at"], now_iso(), record.get("model"))
    with closing(sqlite3.connect(db_path, timeout=30)) as conn, conn:
        if _keeps_previous(conn, "competitions", "competition_id", record["competition_id"], record["status"]):
            return
        conn.execute("INSERT OR REPLACE INTO competitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
        _replace_skills(conn, "competition", record["competition_id"], skills)


def save_advisor(db_path: Path, record: dict, skills: list[dict]) -> None:
    row = (record["teacher_id"], record["name"], record.get("college"), record.get("department"),
           json.dumps(record.get("expertise") or [], ensure_ascii=False), record["status"],
           record.get("error_reason"), now_iso(), record.get("model"))
    with closing(sqlite3.connect(db_path, timeout=30)) as conn, conn:
        if _keeps_previous(conn, "advisors", "teacher_id", record["teacher_id"], record["status"]):
            return
        conn.execute("INSERT OR REPLACE INTO advisors VALUES (?,?,?,?,?,?,?,?,?)", row)
        _replace_skills(conn, "advisor", record["teacher_id"], skills)


def finished_ids(db_path: Path, table: str, id_column: str) -> set[str]:
    """已有確定結果（對應到技能或確定沒有）的 ID；失敗與待審的下次會重跑。"""
    if (table, id_column) not in {("competitions", "competition_id"), ("advisors", "teacher_id")}:
        raise ValueError("不支援的資料表")
    if not Path(db_path).exists():
        return set()
    with closing(sqlite3.connect(db_path, timeout=30)) as conn:
        rows = conn.execute(f"SELECT {id_column} FROM {table} WHERE status IN ('mapped', 'unmapped')")
        return {row[0] for row in rows}
