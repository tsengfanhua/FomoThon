"""從 ESCO CSV 明確初始化共用資料庫。"""

import argparse
import csv
import sqlite3
from contextlib import closing
from pathlib import Path


def initialize_esco(csv_path: Path, db_path: Path) -> dict:
    skills = {}
    with Path(csv_path).open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not {"conceptUri", "preferredLabel", "description"} <= set(reader.fieldnames or []):
            raise ValueError("ESCO CSV 缺少必要欄位")
        rows = 0
        for row in reader:
            rows += 1
            uri, label, description = (row[key] for key in ("conceptUri", "preferredLabel", "description"))
            if not uri or not label or description is None:
                raise ValueError("ESCO 資料缺少必要欄位")
            value = (uri, label, description)
            if uri in skills and skills[uri] != value:
                raise ValueError(f"ESCO URI 內容衝突：{uri}")
            skills[uri] = value
    if not skills:
        raise ValueError("ESCO CSV 沒有資料")
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(db_path)) as conn:
        with conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS esco_skills (
                concept_uri TEXT NOT NULL PRIMARY KEY,
                preferred_label TEXT NOT NULL, description TEXT NOT NULL)""")
            conn.executemany("""INSERT INTO esco_skills VALUES (?, ?, ?)
                ON CONFLICT(concept_uri) DO UPDATE SET preferred_label=excluded.preferred_label,
                description=excluded.description""", skills.values())
    return {"source_rows": rows, "unique_skills": len(skills)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--db", required=True, type=Path)
    args = parser.parse_args()
    print(initialize_esco(args.csv, args.db))


if __name__ == "__main__":
    main()
