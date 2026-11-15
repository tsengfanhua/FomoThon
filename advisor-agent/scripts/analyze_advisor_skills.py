"""批次把教師資料對應到 ESCO 技能，寫入跨 Agent 的技能中樞資料庫。

呼叫外部模型會產生費用；可重複執行，已有結果的教師會略過（--force 可重跑）。
在 advisor-agent 目錄執行：python -m scripts.analyze_advisor_skills --limit 20
"""

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.advisor_skills import analyze_teacher, load_teacher, public_record  # noqa: E402
from shared.esco.labels_zh import translate_missing, used_uris  # noqa: E402
from shared.esco.repository import EscoRepository  # noqa: E402
from shared.hub import db as hub_db  # noqa: E402
from shared.hub.batch import configure_logging, emit_summary, run_batch  # noqa: E402
from shared.llm import OpenAIJsonClient  # noqa: E402

logger = logging.getLogger(__name__)


def select_teachers(data_dir: Path, units: list[str], ids: list[str], skip: set[str], limit: int | None) -> list[dict]:
    teachers = []
    for path in sorted(data_dir.glob("*.json")):
        try:
            teacher = load_teacher(path)
        except (ValueError, OSError):
            logger.warning("略過無法讀取的教師資料：%s", path.name)
            continue
        if ids and teacher["teacherId"] not in ids:
            continue
        if units and not any(unit in f"{teacher.get('mainUnit')} {teacher.get('detailUnit')}" for unit in units):
            continue
        if teacher["teacherId"] in skip:
            continue
        teachers.append(teacher)
    return teachers if limit is None else teachers[:max(0, limit)]


def main() -> None:
    parser = argparse.ArgumentParser(description="教師 profile → ESCO 技能（會呼叫外部模型）")
    parser.add_argument("--data-dir", type=Path, default=Path("data/全校教師資料"))
    parser.add_argument("--hub-db", type=Path, default=ROOT / "data/shared/skill_hub.sqlite")
    parser.add_argument("--esco-db", type=Path, default=ROOT / "data/shared/esco_skills.sqlite")
    parser.add_argument("--model")
    parser.add_argument("--units", default="", help="只處理這些學院或系所（逗號分隔，部分比對）")
    parser.add_argument("--ids", default="", help="只處理這些教師編號（逗號分隔）")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--force", action="store_true", help="已有結果的教師也重新分析")
    args = parser.parse_args()
    configure_logging()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit 必須是正整數")

    hub_db.initialize(args.hub_db)
    repository = EscoRepository(args.esco_db)
    client = OpenAIJsonClient(args.model)
    skip = set() if args.force else hub_db.finished_ids(args.hub_db, "advisors", "teacher_id")
    teachers = select_teachers(args.data_dir, [u for u in args.units.split(",") if u.strip()],
                               [i for i in args.ids.split(",") if i.strip()], skip, args.limit)
    logger.info("待分析教師 %d 位（模型 %s）", len(teachers), client.model)

    def save(teacher: dict, result: dict) -> None:
        record = {**public_record(teacher), "status": result["status"],
                  "error_reason": result.get("error_reason"), "model": client.model}
        hub_db.save_advisor(args.hub_db, record, result["skills"])

    summary = run_batch(teachers, lambda t: analyze_teacher(t, repository, client), save,
                        workers=args.workers, label=lambda t: t["teacherId"])
    labels = translate_missing(args.esco_db, client, used_uris(args.hub_db, None), client.model)
    emit_summary({"entity": "advisor", "model": client.model, **summary, "labels_translated": labels["translated"]})


if __name__ == "__main__":
    main()
