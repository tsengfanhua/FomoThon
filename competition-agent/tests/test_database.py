"""Offline tests. Mock ESCO records exist only in this test module."""

import csv
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import Mock

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT
sys.path.insert(0, str(AGENT / "src"))

from competition_agent.db.connection import connect, initialize
from competition_agent.db.repository import CompetitionRepository
from competition_agent.skills.validation import SkillUriValidator, SkillValidationError, ValidationResult
from competition_agent.adapters.crawler_json import import_category_json, source_from_item

with (ROOT / "data/reference/skill_taxonomy.csv").open(encoding="utf-8-sig", newline="") as file:
    # Reuse real complete URIs, never invent identifiers, even in the mock catalogue.
    _rows = csv.DictReader(file)
    URI = next(_rows)["skill_key"]
    OTHER_URI = next(_rows)["skill_key"]


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "competition.sqlite3"
        self.db = connect(self.path)
        self.addCleanup(self.db.close)
        initialize(self.db)
        self.mock_esco = Mock()
        self.mock_esco.get.side_effect = lambda uri: {"concept_uri": URI} if uri == URI else None
        self.repo = CompetitionRepository(self.db, SkillUriValidator(self.mock_esco))

    def source(self, url="https://example.edu/post/1", **kwargs):
        return self.repo.add_source(source_url=url, title="公告", clean_content="正文", **kwargs)

    def test_competition_crud(self):
        cid = self.repo.create_competition("正式競賽", "主辦單位")
        self.assertEqual(self.repo.get_competition(cid)["competition_name"], "正式競賽")
        self.assertTrue(self.repo.update_competition(cid, competition_name="正式名稱", status="confirmed"))
        row = self.repo.get_competition(cid)
        self.assertEqual(row["status"], "confirmed")
        self.assertTrue(row["updated_at"].endswith("Z"))
        self.assertEqual(len(self.repo.list_competitions()), 1)
        self.assertTrue(self.repo.delete_competition(cid))
        self.assertIsNone(self.repo.get_competition(cid))
        self.assertFalse(self.repo.delete_competition(cid))

    def test_same_name_competitions_allowed(self):
        self.repo.create_competition("同名")
        self.repo.create_competition("同名")
        self.assertEqual(len(self.repo.list_competitions()), 2)

    def test_unclassified_source(self):
        sid, inserted = self.source()
        self.assertTrue(inserted)
        self.assertIsNone(self.repo.get_source(sid)["competition_id"])
        self.assertEqual(len(self.repo.list_sources()), 1)
        self.assertEqual(self.repo.list_competitions(), [])

    def test_duplicate_does_not_overwrite_or_link(self):
        sid, _ = self.source()
        cid = self.repo.create_competition("競賽")
        duplicate, inserted = self.repo.add_source(source_url="https://example.edu/post/1",
            title="不同標題", clean_content="不同正文", competition_id=cid)
        self.assertEqual(sid, duplicate)
        self.assertFalse(inserted)
        row = self.repo.get_source(sid)
        self.assertEqual(row["title"], "公告")
        self.assertIsNone(row["competition_id"])

    def test_multiple_sources_and_unlink_delete(self):
        cid = self.repo.create_competition("競賽")
        first, _ = self.source()
        self.assertTrue(self.repo.link_source(first, cid))
        self.source("https://example.edu/post/2", competition_id=cid)
        self.assertEqual(len(self.repo.list_sources(cid)), 2)
        self.assertTrue(self.repo.link_source(first, None))
        self.assertTrue(self.repo.delete_source(first))
        self.assertIsNone(self.repo.get_source(first))

    def test_skill_crud(self):
        cid = self.repo.create_competition("競賽")
        self.repo.add_skill(cid, URI, "core", "公告明確要求")
        self.assertEqual(self.repo.list_skills(cid)[0]["concept_uri"], URI)
        self.assertTrue(self.repo.update_skill(cid, URI, importance="supporting", evidence="新依據"))
        self.assertEqual(self.repo.list_skills(cid)[0]["importance"], "supporting")
        self.mock_esco.get.assert_called_with(URI)
        self.assertTrue(self.repo.delete_skill(cid, URI))
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_uri_format(self):
        for value in ("1", URI.rsplit("/", 1)[-1], URI + " ", URI.replace("http:", "https:"), None):
            with self.subTest(value=value):
                self.assertEqual(self.repo.validator.validate(value), ValidationResult.INVALID_FORMAT)
        self.mock_esco.get.assert_not_called()

    def test_not_found_cannot_write(self):
        cid = self.repo.create_competition("競賽")
        with self.assertRaises(SkillValidationError) as raised:
            self.repo.add_skill(cid, OTHER_URI, "core", "依據")
        self.assertEqual(raised.exception.result, ValidationResult.NOT_FOUND)
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_unavailable_cannot_write(self):
        cid = self.repo.create_competition("競賽")
        for validator in (SkillUriValidator(), SkillUriValidator(Mock(get=Mock(side_effect=OSError("offline"))))):
            with self.subTest(validator=validator):
                repository = CompetitionRepository(self.db, validator)
                with self.assertRaises(SkillValidationError) as raised:
                    repository.add_skill(cid, URI, "core", "依據")
                self.assertEqual(raised.exception.result, ValidationResult.UNAVAILABLE)
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_exact_uri_match_required(self):
        self.mock_esco.get.side_effect = None
        self.mock_esco.get.return_value = {"concept_uri": OTHER_URI}
        self.assertEqual(self.repo.validator.validate(URI), ValidationResult.NOT_FOUND)
        self.mock_esco.get.return_value = {}
        self.assertEqual(self.repo.validator.validate(URI), ValidationResult.UNAVAILABLE)

    def test_update_revalidates(self):
        cid = self.repo.create_competition("競賽")
        self.repo.add_skill(cid, URI, "core", "原依據")
        self.mock_esco.get.side_effect = OSError("offline")
        with self.assertRaises(SkillValidationError):
            self.repo.update_skill(cid, URI, importance="optional", evidence="新依據")
        self.assertEqual(self.repo.list_skills(cid)[0]["importance"], "core")

    def test_skill_constraints(self):
        cid = self.repo.create_competition("競賽")
        for importance, evidence in (("unknown", "依據"), ("core", " ")):
            with self.assertRaises(sqlite3.IntegrityError):
                self.repo.add_skill(cid, URI, importance, evidence)
        self.repo.add_skill(cid, URI, "optional", "依據")
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.add_skill(cid, URI, "core", "依據")

    def test_competition_constraints(self):
        for name, status in ((" ", "draft"), ("競賽", "unknown")):
            with self.assertRaises(sqlite3.IntegrityError):
                self.repo.create_competition(name, status=status)

    def test_foreign_keys_on_every_connection(self):
        another = connect(self.path)
        self.addCleanup(another.close)
        self.assertEqual(another.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.source(competition_id=999)
        sid, _ = self.source()
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.link_source(sid, 999)
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.add_skill(999, URI, "core", "依據")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_delete_referenced_competition_restricted(self):
        cid = self.repo.create_competition("競賽")
        sid, _ = self.source(competition_id=cid)
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.delete_competition(cid)
        self.repo.delete_source(sid)
        self.repo.add_skill(cid, URI, "core", "依據")
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.delete_competition(cid)

    def test_initialization_preserves_all_data(self):
        cid = self.repo.create_competition("競賽")
        self.source(competition_id=cid)
        self.repo.add_skill(cid, URI, "core", "依據")
        before = list(self.db.iterdump())
        initialize(self.db)
        initialize(self.db)
        self.assertEqual(before, list(self.db.iterdump()))
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 3)
        tables = {r[0] for r in self.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(tables, {"competitions", "competition_sources", "competition_skills", "source_classifications", "skill_extraction_runs", "skill_proposals"})
        reopened = connect(self.path)
        self.addCleanup(reopened.close)
        initialize(reopened)
        self.assertEqual(reopened.execute("SELECT count(*) FROM competition_sources").fetchone()[0], 1)

    def test_unknown_schema_version_rejected(self):
        self.db.execute("PRAGMA user_version=4")
        with self.assertRaises(RuntimeError):
            initialize(self.db)
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 4)

    def test_foreign_keys_disabled_rejected(self):
        self.db.execute("PRAGMA foreign_keys=OFF")
        with self.assertRaises(RuntimeError):
            CompetitionRepository(self.db)
        with self.assertRaises(RuntimeError):
            initialize(self.db)

    def test_real_category_json_import(self):
        path = ROOT / "data/test_output_category_4934.json"
        items = json.loads(path.read_text(encoding="utf-8"))["items"]
        report = import_category_json(path, self.repo)
        self.assertEqual((report.inserted, report.duplicates, report.rejected), (10, 0, []))
        rows = self.repo.list_sources()
        self.assertEqual(len(rows), 10)
        for row, item in zip(rows, items):
            for key in ("source_url", "source_school", "published_at", "title", "clean_content"):
                self.assertEqual(row[key], item[key])
            self.assertIsNone(row["competition_id"])
        again = import_category_json(path, self.repo)
        self.assertEqual((again.inserted, again.duplicates, again.rejected), (0, 10, []))
        self.assertEqual(self.repo.list_competitions(), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM competition_skills").fetchone()[0], 0)

    def test_adapter_preserves_original_date_and_text(self):
        item = dict(source_url="https://example.edu/1", source_school="學校", title=" 標題 ",
                    clean_content=" 正文\n", published_at="民國115年11月")
        self.assertEqual(source_from_item(item), item)
        item["published_at"] = None
        self.assertIsNone(source_from_item(item)["published_at"])

    def test_adapter_reports_bad_items(self):
        valid = dict(source_url="https://example.edu/1", source_school="學校", title="標題", clean_content="")
        payload = {"items": [dict(valid, error="fetch failed"), {}, None, valid]}
        path = Path(self.temp.name) / "bad.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        report = import_category_json(path, self.repo)
        self.assertEqual(report.inserted, 1)
        self.assertEqual([r["index"] for r in report.rejected], [0, 1, 2])

    def test_adapter_rejects_wrong_envelope(self):
        path = Path(self.temp.name) / "wrong.json"
        path.write_text('{"items": {}}', encoding="utf-8")
        with self.assertRaises(ValueError):
            import_category_json(path, self.repo)
        self.assertEqual(self.repo.list_sources(), [])


if __name__ == "__main__":
    unittest.main()
