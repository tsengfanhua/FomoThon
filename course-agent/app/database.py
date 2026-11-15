"""SQLite 課程資料庫：建立資料表與匯入 seed。"""

from contextlib import closing
import hashlib
import json
import sqlite3
from pathlib import Path

from app.schemas.skills import Course, Skill, SkillEvidence


INDEX_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS courses (
        course_id TEXT PRIMARY KEY, year INTEGER NOT NULL, semester INTEGER NOT NULL,
        selection_code TEXT NOT NULL, course_name TEXT NOT NULL,
        description TEXT, targets TEXT NOT NULL, weekly_schedule TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_courses_lookup ON courses(year, semester, selection_code)",
    """CREATE TABLE IF NOT EXISTS course_skills (
        course_id TEXT NOT NULL REFERENCES courses(course_id),
        concept_uri TEXT NOT NULL,
        source_section TEXT NOT NULL, evidence TEXT NOT NULL,
        PRIMARY KEY (course_id, concept_uri, source_section, evidence)
    )""",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_course_skills_pair ON course_skills(course_id, concept_uri)",
)


DEFAULT_TERMS = ("113-1", "113-2", "114-1", "114-2")


def import_course_index(db_path: Path, data_dir: Path, esco_db_path: Path,
                        terms: tuple[str, ...] = DEFAULT_TERMS) -> dict:
    """匯入指定學期的課綱（預設四學期），並安全遷移既有 ESCO 關聯。

    terms 中的每個學期都必須有課綱；只取得部分學期時，由呼叫端明確指定要匯入哪些學期。
    """
    if not terms or any(not isinstance(term, str) or len(term.split("-")) != 2 for term in terms):
        raise ValueError("terms 必須是「學年-學期」的清單，例如 114-2")
    courses = {}
    counts = {}
    for term in terms:
        directory = data_dir / term
        alternate = data_dir / f"{term}教學大綱"
        if directory.exists() and alternate.exists():
            raise ValueError(f"同一學期存在兩個課綱目錄，請擇一保留：{directory}、{alternate}")
        if alternate.is_dir():
            directory = alternate
        paths = sorted(directory.glob("*.json"))
        if not paths:
            raise ValueError(f"找不到課綱：{directory}（亦可使用 {alternate}）")
        counts[term] = len(paths)
        for path in paths:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            info = data["info"]
            year, semester = int(info["yms_year"]), int(info["yms_smester"])
            code, name = info["scr_selcode"], info["sub_name"]
            if (f"{year}-{semester}" != term or not isinstance(code, str)
                    or not code or not isinstance(name, str) or not name):
                raise ValueError(f"課程識別欄位無效：{path}")
            description = (data.get("description") or {}).get("describe_ch")
            targets = [item.get("describe_ch") for item in (data.get("targets") or [])]
            weeks = [{key: item.get(key) for key in ("tpd_reading", "tpd_learn")}
                     for item in (data.get("weeklyScds") or [])]
            payload = [year, semester, code, name, description, targets, weeks]
            serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            course_id = f"{year}-{semester}-{code}-{hashlib.sha256(serialized.encode('utf-8')).hexdigest()}"
            courses[course_id] = (course_id, year, semester, code, name, description,
                                  json.dumps(targets, ensure_ascii=False),
                                  json.dumps(weeks, ensure_ascii=False))

    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path, uri=True)) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("ATTACH DATABASE ? AS shared_esco", (f"{esco_db_path.resolve().as_uri()}?mode=ro",))
        with conn:
            conn.execute("BEGIN")
            if conn.execute("SELECT count(*) FROM shared_esco.esco_skills").fetchone()[0] == 0:
                raise ValueError("共用 ESCO 資料庫沒有技能")
            _migrate_index_esco(conn)
            for statement in INDEX_SCHEMA:
                conn.execute(statement)
            conn.executemany("INSERT OR IGNORE INTO courses VALUES (?, ?, ?, ?, ?, ?, ?, ?)", courses.values())
    return {"source_courses": counts, "courses": len(courses)}


def _migrate_index_esco(conn: sqlite3.Connection) -> None:
    """核對主資料與既有關聯後，於同一交易移除舊 ESCO 表。"""
    old = conn.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='esco_skills'").fetchone()
    links = conn.execute("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='course_skills'").fetchone()
    if not old:
        if links and any(row[2] == "esco_skills" for row in conn.execute("PRAGMA main.foreign_key_list(course_skills)")):
            raise ValueError("課程關聯含失效的 ESCO 外鍵")
        return
    for left, right in (("main", "shared_esco"), ("shared_esco", "main")):
        if conn.execute(f"""SELECT 1 FROM (SELECT concept_uri, preferred_label, description FROM {left}.esco_skills
            EXCEPT SELECT concept_uri, preferred_label, description FROM {right}.esco_skills) LIMIT 1""").fetchone():
            raise ValueError("舊 ESCO 目錄與共用目錄不一致，停止遷移")
    if conn.execute("""SELECT name FROM main.sqlite_master WHERE sql LIKE '%esco_skills%'
        AND name NOT IN ('esco_skills', 'course_skills') AND type IN ('table', 'view', 'trigger')""").fetchone():
        raise ValueError("仍有其他物件依賴舊 ESCO 表，停止遷移")
    if links:
        if conn.execute("""SELECT 1 FROM main.course_skills AS link LEFT JOIN shared_esco.esco_skills AS skill
            ON skill.concept_uri=link.concept_uri WHERE skill.concept_uri IS NULL LIMIT 1""").fetchone():
            raise ValueError("既有課程關聯包含無效 ESCO URI，停止遷移")
        conn.execute("ALTER TABLE course_skills RENAME TO course_skills_old")
        conn.execute(INDEX_SCHEMA[2])
        conn.execute("INSERT INTO course_skills SELECT course_id, concept_uri, source_section, evidence FROM course_skills_old")
        conn.execute("DROP TABLE course_skills_old")
    conn.execute("DROP TABLE esco_skills")


def save_course_skill(db_path: Path, esco_db_path: Path, course_id: str, concept_uri: str,
                      source_section: str, evidence: str) -> None:
    """檢查共用目錄後保存課程關聯；呼叫者不可直接繞過此介面寫入。"""
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=rw", uri=True)) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("ATTACH DATABASE ? AS shared_esco", (f"{esco_db_path.resolve().as_uri()}?mode=ro",))
        with conn:
            conn.execute("BEGIN")
            if not conn.execute("SELECT 1 FROM shared_esco.esco_skills WHERE concept_uri=?", (concept_uri,)).fetchone():
                raise ValueError("ESCO URI 不存在")
            conn.execute("""INSERT INTO course_skills VALUES (?, ?, ?, ?)
                         ON CONFLICT(course_id, concept_uri) DO NOTHING""",
                         (course_id, concept_uri, source_section, evidence))


def get_indexed_course(db_path: Path, course_id: str) -> dict | None:
    """依內部 ID 取得單筆課綱，並還原目標與每週內容。"""
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM courses WHERE course_id=?", (course_id,)).fetchone()
        if row is None:
            return None
        return {**dict(row), "targets": json.loads(row["targets"]),
                "weekly_schedule": json.loads(row["weekly_schedule"])}


def find_indexed_courses(db_path: Path, year: int, semester: int, selection_code: str) -> list[dict]:
    """依學年、學期、原始選課代碼查詢，保留可能的多筆結果。"""
    with closing(sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM courses WHERE year=? AND semester=? AND selection_code=? ORDER BY course_id",
                            (year, semester, selection_code)).fetchall()
        return [{**dict(row), "targets": json.loads(row["targets"]),
                 "weekly_schedule": json.loads(row["weekly_schedule"])} for row in rows]


COURSE_SCHEMA = """
CREATE TABLE IF NOT EXISTS courses (
    course_id TEXT NOT NULL PRIMARY KEY,
    course_name TEXT NOT NULL,
    semester TEXT NOT NULL,
    credits REAL NOT NULL CHECK (credits >= 0),
    syllabus_text TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed')),
    text_origin TEXT NOT NULL CHECK (text_origin IN ('original_excerpt', 'paraphrased', 'synthetic'))
);
"""

SCHEMA = COURSE_SCHEMA + """
CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT NOT NULL PRIMARY KEY,
    skill_name TEXT NOT NULL,
    category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS course_skills (
    course_id TEXT NOT NULL REFERENCES courses(course_id),
    skill_id TEXT NOT NULL REFERENCES skills(skill_id),
    relevance TEXT CHECK (relevance IN ('strong', 'medium') OR relevance IS NULL),
    evidence_reference TEXT NOT NULL,
    source_section TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK (review_status IN ('pending', 'confirmed', 'rejected')),
    CHECK (review_status <> 'confirmed' OR relevance IS NOT NULL),
    PRIMARY KEY (course_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_course_skills_skill_id ON course_skills(skill_id);
"""


def initialize_course_database(db_path: Path, seed: dict, *, allow_unreviewed_demo: bool = False) -> None:
    """僅建立及匯入課程；不變更資料庫中既有的其他表格。"""
    if not isinstance(seed, dict) or not isinstance(seed.get("courses"), list):
        raise ValueError("seed 必須包含 courses 陣列")
    courses = seed["courses"]
    for course in courses:
        Course.model_validate({key: course[key] for key in Course.model_fields})
        if course["review_status"] not in {"pending", "confirmed"}:
            raise ValueError("課程審查狀態無效")
        if course["text_origin"] not in {"original_excerpt", "paraphrased", "synthetic"}:
            raise ValueError("課綱來源類型無效")
    if not allow_unreviewed_demo and any(course["review_status"] != "confirmed" for course in courses):
        raise ValueError("課程 seed 尚未經人工確認；僅本機展示可使用 allow_unreviewed_demo")
    if len({course["course_id"] for course in courses}) != len(courses):
        raise ValueError("seed 包含重複識別碼")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.executescript(COURSE_SCHEMA)
        with conn:
            conn.executemany("""INSERT INTO courses VALUES (:course_id,:course_name,:semester,:credits,:syllabus_text,:review_status,:text_origin)
                ON CONFLICT(course_id) DO UPDATE SET course_name=excluded.course_name, semester=excluded.semester,
                credits=excluded.credits, syllabus_text=excluded.syllabus_text, review_status=excluded.review_status, text_origin=excluded.text_origin""", courses)


def initialize_database(db_path: Path, seed: dict, *, allow_unreviewed_demo: bool = False) -> None:
    """驗證 seed 並以單一交易更新資料；不刪除既有資料。"""
    if not isinstance(seed, dict) or any(not isinstance(seed.get(key), list) for key in ("courses", "skills", "course_skills")):
        raise ValueError("seed 必須包含 courses、skills 與 course_skills 陣列")
    courses = seed["courses"]
    skills = seed["skills"]
    links = seed["course_skills"]
    for course in courses:
        Course.model_validate({k: course[k] for k in Course.model_fields})
        if course["review_status"] not in {"pending", "confirmed"}:
            raise ValueError("課程審查狀態無效")
        if course["text_origin"] not in {"original_excerpt", "paraphrased", "synthetic"}:
            raise ValueError("課綱來源類型無效")
    if not allow_unreviewed_demo and any(course["review_status"] != "confirmed" for course in courses):
        raise ValueError("課程 seed 尚未經人工確認；僅本機展示可使用 allow_unreviewed_demo")
    for skill in skills:
        Skill.model_validate(skill)
    for link in links:
        SkillEvidence.model_validate({**link, "source_type": "syllabus"})
        if link["review_status"] == "confirmed" and link["relevance"] is None:
            raise ValueError("已確認的技能關聯必須提供關聯程度")
    for items, keys in ((courses, ("course_id",)), (skills, ("skill_id",)), (links, ("course_id", "skill_id"))):
        identifiers = [tuple(item[key] for key in keys) for item in items]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("seed 包含重複識別碼")
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.executescript(SCHEMA)
        with conn:
            conn.executemany("""INSERT INTO courses VALUES (:course_id,:course_name,:semester,:credits,:syllabus_text,:review_status,:text_origin)
                ON CONFLICT(course_id) DO UPDATE SET course_name=excluded.course_name, semester=excluded.semester,
                credits=excluded.credits, syllabus_text=excluded.syllabus_text, review_status=excluded.review_status, text_origin=excluded.text_origin""", courses)
            conn.executemany("""INSERT INTO skills VALUES (:skill_id,:skill_name,:category)
                ON CONFLICT(skill_id) DO UPDATE SET skill_name=excluded.skill_name, category=excluded.category""", skills)
            conn.executemany("""INSERT INTO course_skills VALUES (:course_id,:skill_id,:relevance,:evidence_reference,:source_section,:review_status)
                ON CONFLICT(course_id,skill_id) DO UPDATE SET relevance=excluded.relevance, evidence_reference=excluded.evidence_reference,
                source_section=excluded.source_section, review_status=excluded.review_status""", links)
