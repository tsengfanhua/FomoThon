"""從本機 seed 建立課程資料庫；不讀取原始 Excel。"""

import argparse
import json
from pathlib import Path

from app.database import initialize_course_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--allow-unreviewed-demo", action="store_true", help="僅供本機展示待審查資料")
    args = parser.parse_args()
    with args.seed.open(encoding="utf-8") as source:
        seed = json.load(source)
    initialize_course_database(args.db, seed, allow_unreviewed_demo=args.allow_unreviewed_demo)
    print("資料庫已初始化；待審查資料不得視為已確認或已獲公開授權。")


if __name__ == "__main__":
    main()
