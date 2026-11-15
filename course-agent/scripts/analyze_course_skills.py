"""批次把課綱對應到 ESCO 技能（課程 → skill），結果寫入 Course SQLite 的 course_skills。

呼叫外部模型會產生費用；可重複執行，已有確定結果的課程會略過（--force 可重跑）。
在 course-agent 目錄執行：

    python -m scripts.analyze_course_skills --year 114 --semester 2 --limit 50
    python -m scripts.analyze_course_skills --enrollments-stdin < 已確認的修課.json

--enrollments-stdin 讀取已人工確認的修課紀錄（陣列，欄位同 MCP Tool 的 enrollments），
只分析其中尚未分析的課程；成績與學分不會送給模型。
"""

import argparse
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.course_skill_batch import (  # noqa: E402
    INCOMPLETE, analyze_course, ensure_status_table, save_course_result, select_courses)
from shared.esco.labels_zh import translate_missing, used_uris  # noqa: E402
from shared.esco.repository import EscoRepository  # noqa: E402
from shared.hub.batch import configure_logging, emit_summary, run_batch  # noqa: E402
from shared.llm import OpenAIJsonClient  # noqa: E402

logger = logging.getLogger(__name__)
MAX_ENROLLMENTS = 200


def enrollment_keys(raw: str) -> list[tuple[int, int, str]]:
    """把修課紀錄轉成（學年、學期、選課代碼）；格式不符直接報錯，不猜測。"""
    data = json.loads(raw)
    if not isinstance(data, list) or len(data) > MAX_ENROLLMENTS:
        raise ValueError(f"修課紀錄必須是陣列，最多 {MAX_ENROLLMENTS} 筆")
    keys = []
    for item in data:
        code = item.get("course_code", item.get("selection_code")) if isinstance(item, dict) else None
        year, semester = (item.get("academic_year"), item.get("semester")) if isinstance(item, dict) else (None, None)
        if not isinstance(year, int) or not isinstance(semester, int) or not isinstance(code, str) or not code:
            raise ValueError("每筆修課紀錄都需要 academic_year、semester 與 course_code")
        keys.append((year, semester, code))
    return keys


def main() -> None:
    parser = argparse.ArgumentParser(description="課程 → ESCO 技能（會呼叫外部模型）")
    parser.add_argument("--course-db", type=Path, default=Path("data/processed/course_index.sqlite"))
    parser.add_argument("--esco-db", type=Path, default=ROOT / "data/shared/esco_skills.sqlite")
    parser.add_argument("--model")
    parser.add_argument("--year", type=int)
    parser.add_argument("--semester", type=int)
    parser.add_argument("--enrollments-stdin", action="store_true", help="從標準輸入讀取已確認的修課紀錄")
    parser.add_argument("--all-sections", action="store_true", help="同名課程的每個開課班都分析（預設只取一班作代表）")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    configure_logging()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit 必須是正整數")

    keys = None
    if args.enrollments_stdin:
        try:
            keys = enrollment_keys(sys.stdin.read())
        except (ValueError, json.JSONDecodeError) as error:
            emit_summary({"entity": "course", "error": "invalid_enrollments", "detail": str(error)})
            raise SystemExit(2) from None
    ensure_status_table(args.course_db)
    courses = select_courses(args.course_db, year=args.year, semester=args.semester, keys=keys,
                             one_per_name=not args.all_sections, include_finished=args.force, limit=args.limit)
    # 課綱不完整的課沒有東西可以分析：記下狀態（不呼叫模型），網站才不會一直把它當成「尚未分析」
    incomplete = [course for course in courses if not course["complete"]]
    for course in incomplete:
        save_course_result(args.course_db, args.esco_db, course["course_id"],
                           {"status": INCOMPLETE, "skills": [], "error_reason": "incomplete_syllabus"}, None)
    courses = [course for course in courses if course["complete"]]
    if not courses:
        emit_summary({"entity": "course", "total": 0, "incomplete": len(incomplete)})
        return
    repository = EscoRepository(args.esco_db)
    client = OpenAIJsonClient(args.model)
    logger.info("待分析課程 %d 門（模型 %s）", len(courses), client.model)
    summary = run_batch(
        courses,
        lambda course: analyze_course(args.course_db, repository, course["course_id"], client),
        lambda course, result: save_course_result(args.course_db, args.esco_db, course["course_id"], result, client.model),
        workers=args.workers, label=lambda course: f"{course['course_code']} {course['course_name']}")
    labels = translate_missing(args.esco_db, client, used_uris(None, args.course_db), client.model)
    emit_summary({"entity": "course", "model": client.model, **summary, "incomplete": len(incomplete),
                  "labels_translated": labels["translated"]})


if __name__ == "__main__":
    main()
