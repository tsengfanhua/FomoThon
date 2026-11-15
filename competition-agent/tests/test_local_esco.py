"""Offline import/search tests using actual taxonomy URIs and temporary databases."""
import csv
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT
sys.path.insert(0, str(AGENT / "src"))
from competition_agent.skills.import_esco import create_catalogue, read_taxonomy
from competition_agent.skills.local_esco import LocalEscoRepository
from competition_agent.skills.validation import SkillUriValidator, ValidationResult


class LocalEscoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.csv_path = self.base / "sample.csv"
        self.db_path = self.base / "esco.sqlite3"
        with (ROOT / "data/reference/skill_taxonomy.csv").open(encoding="utf-8-sig", newline="") as file:
            self.records = list(csv.DictReader(file))[:2]
        self.write_csv(self.records)

    def write_csv(self, records):
        with self.csv_path.open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=["skill_key", "preferredLabel", "description"])
            writer.writeheader()
            writer.writerows(records)

    def build(self):
        return create_catalogue(self.csv_path, self.db_path, expected_count=2)

    def test_import_exact_content_and_readonly_get(self):
        original = self.csv_path.read_bytes()
        self.assertEqual(self.build(), 2)
        with LocalEscoRepository(self.db_path) as repo:
            row = repo.get(self.records[0]["skill_key"])
            self.assertEqual(row, dict(concept_uri=self.records[0]["skill_key"],
                preferred_label=self.records[0]["preferredLabel"], description=self.records[0]["description"]))
            self.assertIsNone(repo.get("not-an-uri"))
            with self.assertRaises(sqlite3.OperationalError):
                repo.connection.execute("DELETE FROM esco_skills")
        self.assertEqual(self.csv_path.read_bytes(), original)

    def test_repeat_stops_without_changes(self):
        self.build()
        before = self.db_path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(before, self.db_path.read_bytes())

    def test_existing_non_database_not_overwritten(self):
        self.db_path.write_bytes(b"existing user file")
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(self.db_path.read_bytes(), b"existing user file")

    def test_duplicate_uri_rejected_before_creation(self):
        self.write_csv([self.records[0], self.records[0]])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.build()
        self.assertFalse(self.db_path.exists())

    def test_blank_fields_rejected(self):
        for key in ("skill_key", "preferredLabel", "description"):
            with self.subTest(key=key):
                self.write_csv([dict(self.records[0], **{key: " "})])
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.db_path.exists())

    def test_bad_uri_rejected(self):
        self.write_csv([dict(self.records[0], skill_key="truncated-id")])
        with self.assertRaisesRegex(ValueError, "Invalid ESCO URI"):
            self.build()
        self.assertFalse(self.db_path.exists())

    def test_bad_header_and_count(self):
        with self.assertRaisesRegex(ValueError, "Expected 13939"):
            create_catalogue(self.csv_path, self.db_path)
        self.csv_path.write_text("skill_key,name,description\nx,y,z\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "columns"):
            self.build()
        self.assertFalse(self.db_path.exists())

    def test_search_case_description_limits_and_literals(self):
        self.build()
        with LocalEscoRepository(self.db_path) as repo:
            self.assertEqual(repo.search("MUSICAL STAFF")[0]["concept_uri"], self.records[0]["skill_key"])
            self.assertEqual(repo.search("vocal coaching")[0]["concept_uri"], self.records[0]["skill_key"])
            self.assertEqual(len(repo.search("e", limit=1)), 1)
            for query in ("", " ", "%", "_", "' OR 1=1 --"):
                self.assertEqual(repo.search(query), [])
            for limit in (0, -1, 101, True, "2"):
                with self.assertRaises(ValueError):
                    repo.search("music", limit)

    def test_missing_database_not_created(self):
        with self.assertRaises(sqlite3.OperationalError):
            LocalEscoRepository(self.db_path)
        self.assertFalse(self.db_path.exists())

    def test_real_repository_validator_integration(self):
        self.build()
        with LocalEscoRepository(self.db_path) as repo:
            validator = SkillUriValidator(repo)
            self.assertEqual(validator.validate(self.records[0]["skill_key"]), ValidationResult.VALID)
            self.assertEqual(validator.validate("invalid"), ValidationResult.INVALID_FORMAT)
            # A real URI absent from this deliberately small catalogue.
            uri = read_taxonomy(ROOT / "data/reference/skill_taxonomy.csv")[2][0]
            self.assertEqual(validator.validate(uri), ValidationResult.NOT_FOUND)
        self.assertEqual(validator.validate(self.records[0]["skill_key"]), ValidationResult.UNAVAILABLE)

    def test_transaction_failure_rolls_back(self):
        with patch("competition_agent.skills.import_esco.SCHEMA", "CREATE TABLE esco_skills (wrong_column TEXT)"):
            with self.assertRaises(sqlite3.OperationalError):
                self.build()
        with closing(sqlite3.connect(self.db_path)) as connection:
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall(), [])

    def test_full_taxonomy_import_and_content_integrity(self):
        source = ROOT / "data/reference/skill_taxonomy.csv"
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(create_catalogue(source, self.db_path), 13939)
        with LocalEscoRepository(self.db_path) as repo:
            rows = repo.connection.execute("SELECT concept_uri,preferred_label,description FROM esco_skills ORDER BY concept_uri").fetchall()
            self.assertEqual([tuple(row) for row in rows], sorted(read_taxonomy(source)))
            self.assertEqual(repo.connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
