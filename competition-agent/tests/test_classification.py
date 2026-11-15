"""Offline v2 classification, review persistence and migration tests."""
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT
sys.path.insert(0, str(AGENT / "src"))
from competition_agent.classification import rules
from competition_agent.classification.service import ClassificationService, ReviewConflict
from competition_agent.db.connection import connect, initialize
from competition_agent.db.repository import CompetitionRepository
from competition_agent.adapters.crawler_json import import_category_json


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(":memory:")
        self.addCleanup(self.db.close)
        initialize(self.db)
        self.repo = CompetitionRepository(self.db)
        self.service = ClassificationService(self.db)

    def source(self, title="創意競賽徵件", body="參賽資格：學生。報名截止日期為12月1日。", school=rules.SCHOOL):
        n = self.db.execute("SELECT count(*) FROM competition_sources").fetchone()[0]
        return self.repo.add_source(source_url=f"https://www.hwu.edu.tw/Post?PId={n}", title=title,
                                    clean_content=body, source_school=school)[0]

    def confirm(self, sid, category=None):
        row = self.service.classify_source(sid)
        return self.service.confirm_classification(sid, expected_revision=row["revision"],
            category=category or row["category"], reviewer="human", note="人工閱讀公告確認")

    def create(self, sid, revision=None, **kwargs):
        return self.service.create_competition_from_review(sid,
            expected_revision=revision or self.service.get(sid)["revision"],
            competition_name=kwargs.get("name", "創意競賽"), edition=kwargs.get("edition", "2026"),
            name_evidence="正文載明正式名稱", reviewer="human")

    def test_five_categories(self):
        cases = [
            ("創意競賽報名", "參賽資格為學生，報名期限12月1日", "competition_call"),
            ("創意競賽延期通知", "報名截止日期延長至12月5日", "competition_update"),
            ("創意競賽得獎名單", "評選結果如下", "competition_result"),
            ("科技講座", "講師王老師，活動時間週一，歡迎報名", "non_competition"),
            ("活動通知", "詳見附件", "needs_review"),
        ]
        for title, body, expected in cases:
            with self.subTest(expected=expected):
                row = self.service.classify_source(self.source(title, body))
                self.assertEqual(row["category"], expected)
                self.assertTrue(json.loads(row["evidence_json"]))

    def test_mixed_activity(self):
        row = self.service.classify_source(self.source("AI工作坊及黑客松競賽"))
        self.assertEqual(row["category"], "needs_review")

    def test_mixed_activity_in_body(self):
        row = self.service.classify_source(self.source("活動徵件", "舉辦「AI工作坊」及「創意競賽」，報名截止12月1日"))
        self.assertEqual(row["category"], "needs_review")

    def test_multiple_competitions(self):
        row = self.service.classify_source(self.source("「創意競賽」及「程式競賽」報名"))
        self.assertEqual(row["category"], "needs_review")
        with self.assertRaises(ReviewConflict):
            self.create(row["source_id"])

    def test_multiple_competitions_in_body(self):
        row = self.service.classify_source(self.source("徵件資訊", "「創意競賽」及「程式競賽」報名截止12月1日"))
        self.assertEqual(row["category"], "needs_review")

    def test_unconfirmed_update_after_rule_version_change(self):
        sid = self.source()
        old = self.service.classify_source(sid)
        with patch.object(rules, "VERSION", "new-version"):
            new = self.service.classify_source(sid)
        self.assertEqual(new["revision"], old["revision"] + 1)
        self.assertEqual(new["rule_version"], "new-version")

    def test_title_change_marks_pending_and_link_is_preserved(self):
        sid = self.source()
        old = self.confirm(sid)
        cid = self.create(sid)
        with self.db:
            self.db.execute("UPDATE competition_sources SET title='新公告標題' WHERE source_id=?", (sid,))
        pending = self.service.list_pending_reviews()
        self.assertEqual(pending[0]["stale"], 1)
        self.assertEqual(pending[0]["reviewed_at"], old["reviewed_at"])
        self.assertEqual(self.repo.get_source(sid)["competition_id"], cid)

    def test_classification_foreign_key_and_review_constraints(self):
        sid = self.source()
        self.service.classify_source(sid)
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.db.execute("UPDATE source_classifications SET source_id=999 WHERE source_id=?", (sid,))
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.db.execute("UPDATE source_classifications SET review_status='confirmed' WHERE source_id=?", (sid,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.delete_source(sid)

    def test_missing_target_link_preserves_state(self):
        sid = self.source()
        old = dict(self.confirm(sid))
        with self.assertRaises(ValueError):
            self.service.link_reviewed_source(sid, expected_revision=old["revision"], competition_id=999,
                edition="2026", reviewer="human", note="核對同屆")
        self.assertIsNone(self.repo.get_source(sid)["competition_id"])
        self.assertEqual(dict(self.service.get(sid)), old)

    def test_future_results_and_prizes_are_not_results(self):
        row = self.service.classify_source(self.source(body="參賽資格為學生，報名截止12月1日。預計選出入圍名單，將公告結果。金獎10萬元。"))
        self.assertEqual(row["category"], "competition_call")

    def test_result_title_dominates_old_registration(self):
        row = self.service.classify_source(self.source("競賽入選名單", "報名日期為上月。共錄取20隊。"))
        self.assertEqual(row["category"], "competition_result")

    def test_conflicting_result_update(self):
        row = self.service.classify_source(self.source("競賽評選結果及規則調整"))
        self.assertEqual(row["category"], "needs_review")

    def test_evidence_contains_original_quote(self):
        sid = self.source()
        row = self.service.classify_source(sid)
        evidence = json.loads(row["evidence_json"])
        self.assertTrue(any(e.get("field") == "title" and e.get("quote") == "創意競賽徵件" for e in evidence))

    def test_pending_cannot_create_or_link(self):
        sid = self.source()
        row = self.service.classify_source(sid)
        with self.assertRaises(ReviewConflict):
            self.create(sid)
        cid = self.repo.create_competition("既有競賽")
        with self.assertRaises(ReviewConflict):
            self.service.link_reviewed_source(sid, expected_revision=row["revision"], competition_id=cid,
                edition="2026", reviewer="human", note="同屆")

    def test_confirm_then_create(self):
        sid = self.source()
        self.confirm(sid)
        cid = self.create(sid)
        self.assertEqual(self.repo.get_source(sid)["competition_id"], cid)
        self.assertEqual(self.repo.get_competition(cid)["status"], "confirmed")
        self.assertEqual(json.loads(self.service.get(sid)["decision_json"])["edition"], "2026")

    def test_result_update_only_link_multiple_sources(self):
        cid = self.repo.create_competition("既有競賽")
        for title in ("競賽入選名單", "競賽延期通知"):
            sid = self.source(title, "競賽相關通知")
            row = self.confirm(sid)
            with self.assertRaises(ValueError):
                self.create(sid)
            self.service.link_reviewed_source(sid, expected_revision=row["revision"], competition_id=cid,
                edition="2026", reviewer="human", note="核對同屆")
        self.assertEqual(len(self.repo.list_sources(cid)), 2)
        self.assertEqual(len(self.repo.list_competitions()), 1)

    def test_non_competition_cannot_create(self):
        sid = self.source("講座通知", "講師介紹及活動時間")
        self.confirm(sid)
        with self.assertRaises(ReviewConflict):
            self.create(sid)

    def test_reclassification_preserves_manual_and_timestamp(self):
        sid = self.source("公告", "資訊不足")
        confirmed = dict(self.confirm(sid, "competition_call"))
        self.assertEqual(confirmed["method"], "manual")
        with patch.object(rules, "VERSION", "new-version"):
            self.service.classify_hwu_sources()
        self.assertEqual(dict(self.service.get(sid)), confirmed)

    def test_repeated_classification_is_exact_noop(self):
        sid = self.source()
        first = dict(self.service.classify_source(sid))
        self.assertEqual(dict(self.service.classify_source(sid)), first)
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_classifications").fetchone()[0], 1)

    def test_content_change_preserves_old_judgment_and_requires_review(self):
        sid = self.source()
        old = dict(self.confirm(sid))
        with self.db:
            self.db.execute("UPDATE competition_sources SET clean_content='新內容' WHERE source_id=?", (sid,))
        with self.assertRaises(ReviewConflict):
            self.create(sid, old["revision"])
        stale = dict(self.service.get(sid))
        self.assertEqual(stale["review_status"], "pending")
        self.assertEqual(stale["stale"], 1)
        self.assertEqual(stale["revision"], old["revision"] + 1)
        for key in ("category", "evidence_json", "reviewed_at", "content_hash", "review_note"):
            self.assertEqual(stale[key], old[key])
        self.assertEqual(dict(self.service.classify_source(sid)), stale)
        fresh = self.confirm(sid, "competition_call")
        self.assertEqual(fresh["stale"], 0)
        self.assertEqual(fresh["content_hash"], fresh["observed_hash"])

    def test_stale_revision_rejected(self):
        sid = self.source()
        old = self.service.classify_source(sid)
        self.confirm(sid)
        with self.assertRaises(ReviewConflict):
            self.service.confirm_classification(sid, expected_revision=old["revision"],
                category="non_competition", reviewer="other", note="過期操作")

    def test_same_confirmation_noop(self):
        sid = self.source()
        old = dict(self.confirm(sid))
        self.assertEqual(dict(self.confirm(sid)), old)

    def test_duplicate_create_and_no_relink(self):
        sid = self.source()
        self.confirm(sid)
        cid = self.create(sid)
        self.assertEqual(self.create(sid), cid)
        with self.assertRaises(ReviewConflict):
            self.create(sid, name="不同競賽")
        self.assertEqual(len(self.repo.list_competitions()), 1)

    def test_same_name_different_year_not_merged(self):
        for edition in ("2026", "2027"):
            sid = self.source()
            self.confirm(sid)
            self.create(sid, edition=edition)
        self.assertEqual(len(self.repo.list_competitions()), 2)

    def test_atomic_create_rolls_back(self):
        sid = self.source()
        self.confirm(sid)
        self.db.execute("CREATE TRIGGER fail_link BEFORE UPDATE OF competition_id ON competition_sources "
                        "BEGIN SELECT RAISE(ABORT, 'simulated failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.create(sid)
        self.assertEqual(self.repo.list_competitions(), [])
        self.assertIsNone(self.repo.get_source(sid)["competition_id"])
        self.assertIsNone(self.service.get(sid)["decision_json"])

    def test_other_school_rejected_and_batch_skips(self):
        sid = self.source(school="其他學校")
        with self.assertRaises(ValueError):
            self.service.classify_source(sid)
        self.assertEqual(self.service.classify_hwu_sources(), [])

    def test_real_ten_sources(self):
        path = ROOT / "data/test_output_category_4934.json"
        import_category_json(path, self.repo)
        expected = ["competition_result", "competition_call", "needs_review", "needs_review",
                    "competition_call", "needs_review", "competition_call", "competition_call",
                    "competition_update", "competition_call"]
        rows = self.service.classify_hwu_sources()
        self.assertEqual([r["category"] for r in rows], expected)
        self.assertEqual(len(self.service.list_pending_reviews()), 10)
        self.assertEqual(self.repo.list_competitions(), [])
        self.assertEqual(len(self.repo.list_sources()), 10)
        self.assertEqual(self.db.execute("SELECT count(*) FROM competition_skills").fetchone()[0], 0)
        self.assertEqual([dict(r) for r in rows], [dict(r) for r in self.service.classify_hwu_sources()])


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(":memory:")
        self.addCleanup(self.db.close)
        schema = (AGENT / "src/competition_agent/db/schema.sql").read_text(encoding="utf-8")
        self.db.executescript(schema + "\nPRAGMA user_version=1;")
        # An existing association is preserved, not revalidated or manufactured by migration.
        import csv
        with (ROOT / "data/reference/skill_taxonomy.csv").open(encoding="utf-8-sig") as file:
            uri = next(csv.DictReader(file))["skill_key"]
        with self.db:
            self.db.execute("INSERT INTO competitions(competition_name) VALUES ('原競賽')")
            self.db.execute("INSERT INTO competition_sources(competition_id,source_url,title,clean_content) VALUES (1,'https://example.edu/1','公告','正文')")
            self.db.execute("INSERT INTO competition_skills VALUES (1,?,'core','原依據')", (uri,))

    def test_v1_upgrade_preserves_rows(self):
        tables = ("competitions", "competition_sources", "competition_skills")
        before = {table: [tuple(r) for r in self.db.execute(f"SELECT * FROM {table}")] for table in tables}
        initialize(self.db)
        initialize(self.db)
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 3)
        for table in tables:
            self.assertEqual(before[table], [tuple(r) for r in self.db.execute(f"SELECT * FROM {table}")])
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_classifications").fetchone()[0], 0)

    def test_failed_migration_rolls_back(self):
        before = list(self.db.iterdump())
        original = Path.read_text
        def broken(path, *args, **kwargs):
            text = original(path, *args, **kwargs)
            return text + "\nINVALID SQL;" if path.name == "migration_v2.sql" else text
        with patch.object(Path, "read_text", broken):
            with self.assertRaises(sqlite3.OperationalError):
                initialize(self.db)
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
