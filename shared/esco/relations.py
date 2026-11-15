"""把 ESCO 的技能關聯匯入共用資料庫，讓「相近技能」也能互相比對。

比賽、教師、課程各自對應到的 ESCO 技能不一定是同一個 URI（例如比賽要「machine learning」、
課程教的是它的下位技能）。只比對完全相同的 URI 會漏掉很多合理的對應，所以另外保存兩種官方關聯：

- broader／narrower：ESCO 技能階層中的上下位關係。
- related：ESCO 技能之間的 essential／optional 關聯。

關聯以雙向各存一列，查詢時只需要以 concept_uri 過濾。只保留兩端都在 esco_skills 內的關聯。

另外記下 ESCO 的語言技能清單（esco_language_skills）：各種語言的技能彼此文字很像，
但會英文不等於會法文，語意相近配對時要排除（見 similarity.py）。
"""

import argparse
import csv
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

SCHEMA = """CREATE TABLE IF NOT EXISTS esco_skill_relations (
    concept_uri TEXT NOT NULL, related_uri TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('broader', 'narrower', 'related')),
    PRIMARY KEY (concept_uri, related_uri))"""


def _read_pairs(path: Path, left: str, right: str) -> list[tuple[str, str]]:
    with Path(path).open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if not {left, right} <= set(reader.fieldnames or []):
            raise ValueError(f"ESCO 關聯檔缺少必要欄位：{path}")
        return [(row[left], row[right]) for row in reader if row[left] and row[right]]


LANGUAGE_SCHEMA = "CREATE TABLE IF NOT EXISTS esco_language_skills (concept_uri TEXT PRIMARY KEY)"


def _read_language_uris(path: Path | None) -> list[str]:
    if path is None or not Path(path).exists():
        return []
    with Path(path).open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        if "conceptUri" not in (reader.fieldnames or []):
            raise ValueError(f"ESCO 語言技能檔缺少 conceptUri 欄位：{path}")
        return [row["conceptUri"] for row in reader if row["conceptUri"]]


def initialize_relations(db_path: Path, broader_csv: Path, related_csv: Path,
                         language_csv: Path | None = None) -> dict:
    """重建關聯表與語言技能清單；重複執行結果相同。"""
    broader = _read_pairs(broader_csv, "conceptUri", "broaderUri")
    related = _read_pairs(related_csv, "originalSkillUri", "relatedSkillUri")
    languages = _read_language_uris(language_csv)
    with closing(sqlite3.connect(db_path, timeout=30)) as conn:
        known = {row[0] for row in conn.execute("SELECT concept_uri FROM esco_skills")}
        if not known:
            raise ValueError("共用 ESCO 資料庫沒有技能，請先執行 shared.esco.init_db")
        rows: dict[tuple[str, str], str] = {}
        for child, parent in broader:
            if child in known and parent in known and child != parent:
                rows[(child, parent)] = "broader"
                rows[(parent, child)] = "narrower"
        for left, right in related:
            if left in known and right in known and left != right:
                rows.setdefault((left, right), "related")
                rows.setdefault((right, left), "related")
        with conn:
            conn.execute(SCHEMA)
            conn.execute("DELETE FROM esco_skill_relations")
            conn.executemany("INSERT INTO esco_skill_relations VALUES (?, ?, ?)",
                             [(a, b, kind) for (a, b), kind in rows.items()])
            conn.execute(LANGUAGE_SCHEMA)
            conn.execute("DELETE FROM esco_language_skills")
            conn.executemany("INSERT OR IGNORE INTO esco_language_skills VALUES (?)",
                             [(uri,) for uri in languages if uri in known])
    return {"broader_source_rows": len(broader), "related_source_rows": len(related), "stored_rows": len(rows),
            "language_skills": len({uri for uri in languages if uri in known})}


def main() -> None:
    parser = argparse.ArgumentParser(description="匯入 ESCO 技能關聯（上下位與相關）")
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--dataset-dir", required=True, type=Path, help="ESCO 官方 CSV 資料夾")
    args = parser.parse_args()
    summary = initialize_relations(args.db, args.dataset_dir / "broaderRelationsSkillPillar_en.csv",
                                   args.dataset_dir / "skillSkillRelations_en.csv",
                                   args.dataset_dir / "languageSkillsCollection_en.csv")
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
