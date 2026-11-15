"""All mocks and synthetic content are test-only; all writes use temporary SQLite."""
from dataclasses import replace
import csv
import json
from pathlib import Path
import sys
import tempfile
import unittest
import sqlite3
from unittest.mock import patch

AGENT = Path(__file__).resolve().parents[1]
ROOT = AGENT
sys.path.insert(0, str(AGENT / "src"))
from competition_agent.db.connection import connect, initialize
from competition_agent.db.repository import CompetitionRepository
from competition_agent.classification.service import ClassificationService
from competition_agent.adapters.crawler_json import import_category_json
from competition_agent.skills.extraction import SkillClaim
from competition_agent.skills.proposals import SkillProposalService, SkillReviewService, ProposalConflict
from competition_agent.skills.import_esco import create_catalogue
from competition_agent.skills.local_esco import LocalEscoRepository
from competition_agent.skills.validation import SkillValidationError, ValidationResult

SYNTHETIC = "【合成測試，非真實公告】所有參賽者必須具備程式設計技能。報名截止12月1日。"
QUOTE = "所有參賽者必須具備程式設計技能。"


class FixedMockExtractor:
    method = "mock"
    version = "fixed-test-1"

    def __init__(self, claims):
        self.claims = claims
        self.calls = 0

    def extract(self, source):
        self.calls += 1
        return self.claims


def claim_for(body=SYNTHETIC, quote=QUOTE, **overrides):
    claim = SkillClaim("程式設計", quote, body.index(quote), body.index(quote)+len(quote),
                       "explicit", "competition_wide", "測試用明示技能要求")
    return replace(claim, **overrides)


class SkillProposalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        with (ROOT / "data/reference/skill_taxonomy.csv").open(encoding="utf-8-sig", newline="") as f:
            records = {r["preferredLabel"]: r for r in csv.DictReader(f)}
        self.uri = records["computer programming"]["skill_key"]
        self.other_uri = records["manage musical staff"]["skill_key"]
        self.esco_path = base / "esco.sqlite3"
        csv_path = base / "taxonomy.csv"
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["skill_key", "preferredLabel", "description"])
            writer.writeheader()
            writer.writerows([records["computer programming"], records["manage musical staff"]])
        create_catalogue(csv_path, self.esco_path, expected_count=2)
        self.esco = LocalEscoRepository(self.esco_path)
        self.addCleanup(self.esco.close)
        self.db = connect(base / "competition.sqlite3")
        self.addCleanup(self.db.close)
        initialize(self.db)
        self.repo = CompetitionRepository(self.db)
        self.classifier = ClassificationService(self.db)
        self.proposals = SkillProposalService(self.db, self.esco)
        self.reviews = SkillReviewService(self.db, self.esco)

    def confirmed_source(self, body=SYNTHETIC, cid=None):
        count = self.db.execute("SELECT count(*) FROM competition_sources").fetchone()[0]
        sid, _ = self.repo.add_source(source_url=f"https://example.test/synthetic/{count}",
            source_school="醒吾科技大學", title="【合成測試】程式設計競賽徵件", clean_content=body)
        row = self.classifier.classify_source(sid)
        reviewed = self.classifier.confirm_classification(sid, expected_revision=row["revision"],
            category="competition_call", reviewer="test-human", note="合成測試人工核准")
        if cid is None:
            cid = self.classifier.create_competition_from_review(sid, expected_revision=reviewed["revision"],
                competition_name="合成測試競賽", edition="測試屆", name_evidence="合成測試", reviewer="test-human")
        else:
            self.classifier.link_reviewed_source(sid, expected_revision=reviewed["revision"],
                competition_id=cid, edition="測試屆", note="合成同屆來源", reviewer="test-human")
        return cid, sid

    def propose(self, claims=None, body=SYNTHETIC, cid=None):
        cid, sid = self.confirmed_source(body, cid)
        run = self.proposals.extract(cid, sid, FixedMockExtractor([claim_for()] if claims is None else claims))
        return cid, sid, run, self.proposals.list_proposals(run["run_id"])

    def accept(self, proposal, **overrides):
        args = dict(expected_revision=proposal["revision"], selected_concept_uri=self.uri,
                    importance="core", reviewer="test-human", note="核對原文與 ESCO 定義")
        args.update(overrides)
        return self.reviews.accept_skill_proposal(proposal["proposal_id"], **args)

    def test_real_yushow_returns_zero_and_caches(self):
        import_category_json(ROOT / "data/test_output_category_4934.json", self.repo)
        self.classifier.classify_hwu_sources()
        sid = self.db.execute("SELECT source_id FROM competition_sources WHERE source_url=?",
                             ("https://www.hwu.edu.tw/Post?PId=108400",)).fetchone()[0]
        row = self.classifier.get(sid)
        row = self.classifier.confirm_classification(sid, expected_revision=row["revision"],
            category="competition_call", reviewer="test-human", note="真實公告僅含主題與類別")
        cid = self.classifier.create_competition_from_review(sid, expected_revision=row["revision"],
            competition_name="第24屆育秀盃創意獎", edition="第24屆", organizer="財團法人育秀教育基金會",
            name_evidence="公告標題", reviewer="test-human")
        mock = FixedMockExtractor([])
        run = self.proposals.extract(cid, sid, mock)
        self.assertEqual((run["status"], run["proposal_count"]), ("completed", 0))
        self.assertEqual(dict(run), dict(self.proposals.extract(cid, sid, mock)))
        self.assertEqual(mock.calls, 1)
        self.assertEqual(self.repo.list_skills(cid), [])
        self.assertEqual(len(self.repo.list_sources()), 9)

    def test_complete_synthetic_success(self):
        cid, sid, run, proposals = self.propose()
        self.assertEqual(run["extractor_method"], "mock")
        self.assertEqual(json.loads(proposals[0]["search_terms_json"]), ["computer programming"])
        self.assertEqual(json.loads(proposals[0]["candidates_json"])[0]["concept_uri"], self.uri)
        accepted = self.accept(proposals[0])
        self.assertEqual((accepted["status"], accepted["revision"]), ("accepted", 2))
        skill = self.repo.list_skills(cid)[0]
        self.assertEqual(skill["concept_uri"], self.uri)
        evidence = json.loads(skill["evidence"])
        self.assertEqual(evidence["schema_version"], 1)
        self.assertEqual(evidence["items"][0]["quote"], QUOTE)
        self.assertEqual(evidence["items"][0]["source_id"], sid)
        self.assertEqual(len(self.repo.list_competitions()), 1)

    def test_inferred_insufficient_group_unknown_rejected(self):
        cases = [replace(claim_for(), evidence_level=level) for level in ("inferred", "insufficient")]
        cases += [replace(claim_for(), scope="unknown")]
        for claim in cases:
            with self.subTest(claim=claim):
                cid, _, _, proposals = self.propose([claim])
                with self.assertRaises(ProposalConflict):
                    self.accept(proposals[0])
                self.assertEqual(self.repo.list_skills(cid), [])
        body = "【合成測試】程式組必須具備程式設計技能。"
        claim = claim_for(body, "程式組必須具備程式設計技能。", scope="group", group_name="程式組")
        cid, _, _, proposals = self.propose([claim], body=body)
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0])
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_ai_theme_is_not_python_or_programming(self):
        body = "【合成測試】主題為玩轉AI智創未來。"
        for name in ("Python", "程式設計"):
            claim = claim_for(body, "主題為玩轉AI智創未來。", skill_name=name)
            cid, _, _, proposals = self.propose([claim], body=body)
            self.assertEqual(json.loads(proposals[0]["candidates_json"]), [])
            with self.assertRaises(ProposalConflict):
                self.accept(proposals[0])
            self.assertEqual(self.repo.list_skills(cid), [])

    def test_negated_skill_rejected(self):
        body = "【合成測試】不要求程式設計技能。"
        claim = claim_for(body, "不要求程式設計技能。")
        _, _, _, proposals = self.propose([claim], body=body)
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0])

    def test_wrong_quote_or_offset_records_failure_without_proposals(self):
        cid, sid = self.confirmed_source()
        for claim in (replace(claim_for(), quote="不存在引句"), replace(claim_for(), start=0)):
            with self.assertRaises(ValueError):
                self.proposals.extract(cid, sid, FixedMockExtractor([claim]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM skill_proposals").fetchone()[0], 0)
        self.assertEqual([r[0] for r in self.db.execute("SELECT status FROM skill_extraction_runs")], ["failed", "failed"])

    def test_missing_evidence_rejected(self):
        cid, sid = self.confirmed_source()
        with self.assertRaises(ValueError):
            self.proposals.extract(cid, sid, FixedMockExtractor([replace(claim_for(), quote="")]))

    def test_pending_classification_blocks_extraction(self):
        cid, sid = self.confirmed_source()
        with self.db:
            self.db.execute("UPDATE source_classifications SET review_status='pending' WHERE source_id=?", (sid,))
        with self.assertRaises(ProposalConflict):
            self.proposals.extract(cid, sid, FixedMockExtractor([]))

    def test_wrong_competition_or_unconfirmed_competition(self):
        cid, sid = self.confirmed_source()
        other = self.repo.create_competition("其他競賽", status="confirmed")
        with self.assertRaises(ProposalConflict):
            self.proposals.extract(other, sid, FixedMockExtractor([]))
        self.repo.update_competition(cid, competition_name="合成", status="draft")
        with self.assertRaises(ProposalConflict):
            self.proposals.extract(cid, sid, FixedMockExtractor([]))

    def test_result_and_update_not_requirement_sources(self):
        cid, sid = self.confirmed_source()
        for category in ("competition_result", "competition_update"):
            with self.db:
                self.db.execute("UPDATE source_classifications SET category=? WHERE source_id=?", (category, sid))
            with self.assertRaises(ProposalConflict):
                self.proposals.extract(cid, sid, FixedMockExtractor([]))

    def test_source_content_change_marks_stale_preserves_proposal(self):
        cid, sid, _, proposals = self.propose()
        original = proposals[0]
        with self.db:
            self.db.execute("UPDATE competition_sources SET clean_content=clean_content || '更新' WHERE source_id=?", (sid,))
        with self.assertRaises(ProposalConflict):
            self.accept(original)
        stale = self.reviews.get(original["proposal_id"])
        self.assertEqual((stale["status"], stale["revision"]), ("stale", 2))
        self.assertEqual(stale["claim_json"], original["claim_json"])
        self.assertEqual(dict(stale), dict(self.reviews.refresh(stale["proposal_id"])))
        self.assertEqual(self.repo.list_skills(cid), [])

    def test_source_relink_and_classification_revision_expire(self):
        for change in ("link", "revision"):
            cid, sid, _, proposals = self.propose()
            if change == "link":
                self.repo.link_source(sid, None)
            else:
                with self.db:
                    self.db.execute("UPDATE source_classifications SET revision=revision+1 WHERE source_id=?", (sid,))
            with self.assertRaises(ProposalConflict):
                self.accept(proposals[0])
            self.assertEqual(self.repo.list_skills(cid), [])

    def test_stale_proposal_revision_rejected(self):
        _, _, _, proposals = self.propose()
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0], expected_revision=0)

    def test_uri_outside_candidates_and_invalid_rejected(self):
        _, _, _, proposals = self.propose()
        for uri in (self.other_uri, "invented-id"):
            with self.assertRaises(ProposalConflict):
                self.accept(proposals[0], selected_concept_uri=uri)

    def test_selected_uri_no_longer_exists(self):
        _, _, _, proposals = self.propose()
        with patch.object(self.esco, "get", return_value=None):
            with self.assertRaises(SkillValidationError) as raised:
                self.accept(proposals[0])
        self.assertEqual(raised.exception.result, ValidationResult.NOT_FOUND)

    def test_esco_unavailable_rejects_acceptance(self):
        _, _, _, proposals = self.propose()
        with patch.object(self.esco, "get", side_effect=OSError("offline")):
            with self.assertRaises(SkillValidationError) as raised:
                self.accept(proposals[0])
        self.assertEqual(raised.exception.result, ValidationResult.UNAVAILABLE)

    def test_definition_or_catalogue_change_rejected(self):
        _, _, _, proposals = self.propose()
        record = self.esco.get(self.uri)
        with patch.object(self.esco, "get", return_value=dict(record, description="changed")):
            with self.assertRaises(ProposalConflict):
                self.accept(proposals[0])
        with patch.object(self.esco, "fingerprint", return_value="new snapshot"):
            with self.assertRaises(ProposalConflict):
                self.accept(proposals[0])

    def test_repeated_extraction_and_duplicate_claims(self):
        cid, sid = self.confirmed_source()
        mock = FixedMockExtractor([claim_for(), claim_for()])
        run = self.proposals.extract(cid, sid, mock)
        self.assertEqual(run["proposal_count"], 1)
        self.assertEqual(dict(run), dict(self.proposals.extract(cid, sid, mock)))
        self.assertEqual(mock.calls, 1)

    def test_repeated_acceptance_idempotent_and_different_decision_rejected(self):
        cid, _, _, proposals = self.propose()
        accepted = self.accept(proposals[0])
        before = self.repo.list_skills(cid)[0]["evidence"]
        self.assertEqual(dict(accepted), dict(self.accept(accepted)))
        self.assertEqual(before, self.repo.list_skills(cid)[0]["evidence"])
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0])  # old revision
        with self.assertRaises(ProposalConflict):
            self.accept(accepted, note="different")

    def test_multi_source_evidence_merge(self):
        cid, sid, _, proposals = self.propose()
        self.accept(proposals[0])
        _, other_sid, _, other = self.propose(cid=cid)
        self.accept(other[0])
        skills = self.repo.list_skills(cid)
        self.assertEqual(len(skills), 1)
        items = json.loads(skills[0]["evidence"])["items"]
        self.assertEqual({e["source_id"] for e in items}, {sid, other_sid})

    def test_stale_existing_evidence_cannot_be_merged(self):
        cid, sid, _, proposals = self.propose()
        self.accept(proposals[0])
        _, _, _, other = self.propose(cid=cid)
        with self.db:
            self.db.execute("UPDATE competition_sources SET clean_content=clean_content || '變更' WHERE source_id=?", (sid,))
        before = self.repo.list_skills(cid)[0]["evidence"]
        with self.assertRaises(ProposalConflict):
            self.accept(other[0])
        self.assertEqual(self.repo.list_skills(cid)[0]["evidence"], before)
        self.assertEqual(self.reviews.get(other[0]["proposal_id"])["status"], "pending")

    def test_catalogue_fingerprint_stable_and_query_only(self):
        before = self.esco.fingerprint()
        self.esco.search("programming")
        self.esco.get(self.uri)
        self.assertEqual(self.esco.fingerprint(), before)
        with self.assertRaises(sqlite3.OperationalError):
            self.esco.connection.execute("DELETE FROM esco_skills")

    def test_repeated_candidates_deduplicated(self):
        record = self.esco.get(self.uri)
        with patch.object(self.esco, "search", return_value=[record, record]):
            _, _, _, proposals = self.propose()
        self.assertEqual(len(json.loads(proposals[0]["candidates_json"])), 1)

    def test_proposal_insert_failure_rolls_back_run(self):
        cid, sid = self.confirmed_source()
        self.db.execute("CREATE TRIGGER fail_proposal BEFORE INSERT ON skill_proposals "
                        "BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.proposals.extract(cid, sid, FixedMockExtractor([claim_for()]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM skill_extraction_runs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM skill_proposals").fetchone()[0], 0)

    def test_reviewer_note_and_importance_required(self):
        _, _, _, proposals = self.propose()
        for args in ({"reviewer": " "}, {"note": ""}, {"importance": "unknown"}):
            with self.subTest(args=args), self.assertRaises(ValueError):
                self.accept(proposals[0], **args)

    def test_uri_format_from_search_is_not_trusted(self):
        cid, sid = self.confirmed_source()
        with patch.object(self.esco, "search", return_value=[{"concept_uri": "invented-id"}]):
            with self.assertRaises(SkillValidationError) as raised:
                self.proposals.extract(cid, sid, FixedMockExtractor([claim_for()]))
        self.assertEqual(raised.exception.result, ValidationResult.INVALID_FORMAT)

    def test_foreign_keys_on_new_tables(self):
        _, _, _, proposals = self.propose()
        with self.assertRaises(sqlite3.IntegrityError), self.db:
            self.db.execute("UPDATE skill_proposals SET run_id=999 WHERE proposal_id=?", (proposals[0]["proposal_id"],))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_importance_conflict_preserves_both_records(self):
        cid, _, _, proposals = self.propose()
        self.accept(proposals[0])
        _, _, _, other = self.propose(cid=cid)
        before = dict(self.repo.list_skills(cid)[0])
        with self.assertRaises(ProposalConflict):
            self.accept(other[0], importance="optional")
        self.assertEqual(dict(self.repo.list_skills(cid)[0]), before)
        self.assertEqual(self.reviews.get(other[0]["proposal_id"])["status"], "pending")

    def test_legacy_evidence_not_overwritten(self):
        cid, _, _, proposals = self.propose()
        with self.db:
            self.db.execute("INSERT INTO competition_skills VALUES (?,?,'core','舊版文字依據')", (cid, self.uri))
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0])
        self.assertEqual(self.repo.list_skills(cid)[0]["evidence"], "舊版文字依據")

    def test_review_transaction_rolls_back_on_proposal_update_failure(self):
        cid, _, _, proposals = self.propose()
        self.db.execute("CREATE TRIGGER fail_accept BEFORE UPDATE ON skill_proposals "
                        "WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.accept(proposals[0])
        self.assertEqual(self.repo.list_skills(cid), [])
        self.assertEqual(self.reviews.get(proposals[0]["proposal_id"])["status"], "pending")

    def test_search_failure_records_failed_run_retry_can_complete(self):
        cid, sid = self.confirmed_source()
        mock = FixedMockExtractor([claim_for()])
        with patch.object(self.esco, "search", side_effect=OSError("offline")):
            with self.assertRaises(SkillValidationError):
                self.proposals.extract(cid, sid, mock)
        run = self.proposals.extract(cid, sid, mock)
        self.assertEqual((run["attempt"], run["status"]), (2, "completed"))
        self.assertEqual(mock.calls, 2)

    def test_unknown_search_term_retained_without_candidates(self):
        body = "【合成測試】所有參賽者必須具備未知技能。"
        claim = claim_for(body, "所有參賽者必須具備未知技能。", skill_name="未知技能")
        _, _, _, proposals = self.propose([claim], body=body)
        self.assertEqual(json.loads(proposals[0]["candidates_json"]), [])
        with self.assertRaises(ProposalConflict):
            self.accept(proposals[0])

    def test_no_online_extractor_path(self):
        cid, sid = self.confirmed_source()
        mock = FixedMockExtractor([])
        mock.method = "openai"
        with self.assertRaises(ValueError):
            self.proposals.extract(cid, sid, mock)
        self.assertEqual(mock.calls, 0)

    def test_reject_pending_proposal(self):
        _, _, _, proposals = self.propose()
        rejected = self.reviews.reject_skill_proposal(proposals[0]["proposal_id"], expected_revision=1,
                                                     reviewer="test-human", note="不符合需求")
        self.assertEqual(rejected["status"], "rejected")
        with self.assertRaises(ProposalConflict):
            self.accept(rejected)

    def test_extractor_failure_not_empty_success(self):
        cid, sid = self.confirmed_source()
        mock = FixedMockExtractor([])
        with patch.object(mock, "extract", side_effect=ValueError("malformed output")):
            with self.assertRaises(ValueError):
                self.proposals.extract(cid, sid, mock)
        row = self.db.execute("SELECT * FROM skill_extraction_runs").fetchone()
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["proposal_count"], 0)


class V3MigrationTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(":memory:")
        self.addCleanup(self.db.close)
        directory = AGENT / "src/competition_agent/db"
        self.db.executescript((directory / "schema.sql").read_text(encoding="utf-8") +
                             (directory / "migration_v2.sql").read_text(encoding="utf-8") + "PRAGMA user_version=2;")
        repo = CompetitionRepository(self.db)
        cid = repo.create_competition("舊競賽", status="confirmed")
        sid, _ = repo.add_source(source_url="https://example.test/old", title="競賽報名", clean_content="參賽資格：學生；報名截止明日", source_school="醒吾科技大學", competition_id=cid)
        classifier = ClassificationService(self.db)
        row = classifier.classify_source(sid)
        classifier.confirm_classification(sid, expected_revision=row["revision"], category="competition_call",
                                          reviewer="test-human", note="既有確認")
        with (ROOT / "data/reference/skill_taxonomy.csv").open(encoding="utf-8-sig") as file:
            uri = next(csv.DictReader(file))["skill_key"]
        with self.db:
            self.db.execute("INSERT INTO competition_skills VALUES (?,?,'core','既有純文字證據')", (cid, uri))

    def test_v2_to_v3_preserves_all_four_tables(self):
        tables = ("competitions", "competition_sources", "competition_skills", "source_classifications")
        before = {t: [tuple(r) for r in self.db.execute(f"SELECT * FROM {t}")] for t in tables}
        initialize(self.db)
        initialize(self.db)
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 3)
        for table in tables:
            self.assertEqual(before[table], [tuple(r) for r in self.db.execute(f"SELECT * FROM {table}")])
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT count(*) FROM skill_proposals").fetchone()[0], 0)
        ClassificationService(self.db)

    def test_v3_failure_rolls_back_schema_data_and_version(self):
        before = list(self.db.iterdump())
        original = Path.read_text
        def broken(path, *args, **kwargs):
            text = original(path, *args, **kwargs)
            return text + "\nINVALID SQL;" if path.name == "migration_v3.sql" else text
        with patch.object(Path, "read_text", broken):
            with self.assertRaises(sqlite3.OperationalError):
                initialize(self.db)
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute("PRAGMA user_version").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()
