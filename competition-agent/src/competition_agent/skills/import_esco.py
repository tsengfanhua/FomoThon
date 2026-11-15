"""Create a NEW development ESCO database; existing destinations always stop the import.

Repeated invocations cannot append duplicates or replace data. To rebuild, explicitly
select another absent destination. This CLI never deletes or overwrites a database.
"""
import argparse
import csv
from pathlib import Path
import sqlite3

from .validation import SkillUriValidator

SCHEMA = """CREATE TABLE esco_skills (
    concept_uri TEXT PRIMARY KEY,
    preferred_label TEXT NOT NULL,
    description TEXT NOT NULL
)"""


def read_taxonomy(path: str | Path) -> list[tuple[str, str, str]]:
    rows = []
    seen = set()
    with Path(path).open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source, strict=True)
        if reader.fieldnames != ["skill_key", "preferredLabel", "description"]:
            raise ValueError("Expected exact CSV columns: skill_key,preferredLabel,description")
        for number, row in enumerate(reader, start=2):
            if None in row or any(not isinstance(value, str) or not value.strip() for value in row.values()):
                raise ValueError(f"Blank/malformed fields in CSV record {number}")
            uri = row["skill_key"]
            if not SkillUriValidator.has_valid_format(uri):
                raise ValueError(f"Invalid ESCO URI in CSV record {number}")
            if uri in seen:
                raise ValueError(f"Duplicate ESCO URI in CSV record {number}")
            seen.add(uri)
            rows.append((uri, row["preferredLabel"], row["description"]))
    if not rows:
        raise ValueError("Empty taxonomy")
    return rows


def create_catalogue(csv_path: str | Path, database_path: str | Path, *, expected_count: int = 13939) -> int:
    target = Path(database_path)
    if target.exists():
        raise FileExistsError(f"Destination exists; stopped without modifying it: {target}")
    rows = read_taxonomy(csv_path)
    if len(rows) != expected_count:
        raise ValueError(f"Expected {expected_count} unique skills, found {len(rows)}")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive create also closes the exists()/open race. No existing file is truncated.
    with target.open("xb"):
        pass
    connection = sqlite3.connect(target)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(SCHEMA)
        connection.executemany("INSERT INTO esco_skills VALUES (?, ?, ?)", rows)
        stored = connection.execute("SELECT concept_uri,preferred_label,description FROM esco_skills ORDER BY concept_uri").fetchall()
        if stored != sorted(rows):
            raise RuntimeError("Imported content differs from source CSV")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity check failed")
        connection.commit()
    except Exception:
        connection.rollback()
        # Retain failed destination for inspection; never silently overwrite it on retry.
        raise
    finally:
        connection.close()
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("database_path", type=Path)
    args = parser.parse_args()
    try:
        count = create_catalogue(args.csv_path, args.database_path)
    except (OSError, ValueError, sqlite3.Error, RuntimeError) as exc:
        parser.exit(1, f"Import stopped: {exc}\n")
    print(f"Imported {count} unique skills into {args.database_path.resolve()}")


if __name__ == "__main__":
    main()
