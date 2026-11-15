"""從本機 seed 建立課程資料庫；不讀取原始 Excel。"""

import argparse
import json
from pathlib import Path

from app.database import DEFAULT_TERMS, import_course_index, initialize_course_database


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--seed", type=Path)
    source.add_argument("--data-dir", type=Path, help="包含四學期課綱的資料夾")
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--esco-db", type=Path, default=Path(__file__).resolve().parents[2] / "data/shared/esco_skills.sqlite")
    parser.add_argument("--allow-unreviewed-demo", action="store_true", help="僅供本機展示待審查資料")
    parser.add_argument("--terms", help="只匯入這些學期（逗號分隔，例如 114-1,114-2）；省略時匯入四學期")
    args = parser.parse_args()
    if args.data_dir:
        terms = tuple(term.strip() for term in args.terms.split(",") if term.strip()) if args.terms else DEFAULT_TERMS
        print(json.dumps(import_course_index(args.db, args.data_dir, args.esco_db, terms), ensure_ascii=False))
        return
    with args.seed.open(encoding="utf-8") as source:
        seed = json.load(source)
    initialize_course_database(args.db, seed, allow_unreviewed_demo=args.allow_unreviewed_demo)
    print("資料庫已初始化；待審查資料不得視為已確認或已獲公開授權。")


if __name__ == "__main__":
    main()
