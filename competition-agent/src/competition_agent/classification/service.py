"""Service-owned transactions: no enclosing caller transaction or implicit approval.

Legacy repositories remain low-level. All phase-two writes use this service.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json

from . import rules


class ReviewConflict(ValueError):
    """Reload source and classification before attempting a new human decision."""


def now():
    return datetime.now(timezone.utc).isoformat()


def required(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be nonblank text")


class ClassificationService:
    def __init__(self, connection):
        self.db = connection
        if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            raise ValueError("Foreign keys must be enabled")
        if connection.execute("PRAGMA user_version").fetchone()[0] not in (2, 3):
            raise ValueError("Schema v2 or v3 required")

    @contextmanager
    def transaction(self):
        if self.db.in_transaction:
            raise RuntimeError("Service requires its own transaction")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def source(self, source_id):
        row = self.db.execute("SELECT * FROM competition_sources WHERE source_id=?", (source_id,)).fetchone()
        if row is None:
            raise ValueError("Source not found")
        if row["source_school"] != rules.SCHOOL:
            raise ValueError("Only HWU sources are supported")
        return row

    def get(self, source_id):
        return self.db.execute("SELECT * FROM source_classifications WHERE source_id=?", (source_id,)).fetchone()

    def classify_source(self, source_id):
        with self.transaction():
            source = self.source(source_id)
            digest = rules.content_hash(source)
            previous = self.get(source_id)
            if previous is not None:
                if digest != previous["observed_hash"]:
                    # Preserve category, evidence, content_hash, method and human review details.
                    self.db.execute(
                        "UPDATE source_classifications SET observed_hash=?, stale=1, review_status='pending', "
                        "revision=revision+1 WHERE source_id=?", (digest, source_id))
                    return self.get(source_id)
                if previous["stale"] or previous["review_status"] == "confirmed" or previous["rule_version"] == rules.VERSION:
                    return previous
            result = rules.classify(source)
            evidence = json.dumps(result["evidence"], ensure_ascii=False)
            if previous is None:
                self.db.execute(
                    "INSERT INTO source_classifications (source_id,category,evidence_json,method,rule_version,"
                    "content_hash,observed_hash,review_status,classified_at) VALUES (?,?,?,'rule',?,?,?,'pending',?)",
                    (source_id, result["category"], evidence, rules.VERSION, digest, digest, now()))
            else:
                self.db.execute(
                    "UPDATE source_classifications SET category=?, evidence_json=?, rule_version=?, "
                    "classified_at=?, revision=revision+1 WHERE source_id=?",
                    (result["category"], evidence, rules.VERSION, now(), source_id))
            return self.get(source_id)

    def classify_hwu_sources(self):
        ids = [row[0] for row in self.db.execute(
            "SELECT source_id FROM competition_sources WHERE source_school=? ORDER BY source_id", (rules.SCHOOL,))]
        return [self.classify_source(source_id) for source_id in ids]

    def list_pending_reviews(self):
        self.classify_hwu_sources()  # Also detects stale confirmations before presenting the queue.
        return self.db.execute(
            "SELECT c.*,s.title,s.clean_content,s.source_url,s.competition_id FROM source_classifications c "
            "JOIN competition_sources s USING(source_id) WHERE c.review_status='pending' AND s.source_school=? "
            "ORDER BY c.source_id", (rules.SCHOOL,)).fetchall()

    def checked(self, source_id, revision):
        source, row = self.source(source_id), self.get(source_id)
        if row is None or row["revision"] != revision:
            raise ReviewConflict("Classification revision changed; reload before confirming")
        if rules.content_hash(source) != row["observed_hash"]:
            raise ReviewConflict("Source changed during review; refresh classification")
        return source, row

    def confirm_classification(self, source_id, *, expected_revision, category, reviewer, note):
        required(reviewer, "reviewer")
        required(note, "note")
        if category not in rules.CATEGORIES or category == "needs_review":
            raise ValueError("Resolve needs_review to a concrete category before confirming")
        self.classify_source(source_id)  # Staleness persists even when the operation below is rejected.
        with self.transaction():
            source, row = self.checked(source_id, expected_revision)
            if source["competition_id"] is not None and category == "non_competition":
                raise ReviewConflict("Existing link requires explicit low-level correction before non-competition confirmation")
            if (row["review_status"] == "confirmed" and row["category"] == category
                    and row["reviewed_by"] == reviewer and row["review_note"] == note):
                return row
            manual = row["stale"] or category != row["category"] or row["method"] == "manual"
            evidence = json.loads(row["evidence_json"])
            if manual:
                evidence.append({"rule_id": "manual", "reason": note, "reviewer": reviewer,
                                 "content_hash": row["observed_hash"]})
            self.db.execute(
                "UPDATE source_classifications SET category=?, evidence_json=?, method=?, content_hash=observed_hash, "
                "stale=0, review_status='confirmed', reviewed_at=?, reviewed_by=?, review_note=?, "
                "revision=revision+1, classified_at=? WHERE source_id=?",
                (category, json.dumps(evidence, ensure_ascii=False), "manual" if manual else "rule",
                 now(), reviewer, note, now() if manual else row["classified_at"], source_id))
            return self.get(source_id)

    def create_competition_from_review(self, source_id, *, expected_revision, competition_name,
                                       edition, name_evidence, reviewer, organizer=None):
        for value, label in ((competition_name, "competition_name"), (edition, "edition"),
                             (name_evidence, "name_evidence"), (reviewer, "reviewer")):
            required(value, label)
        decision = dict(action="create", competition_name=competition_name, edition=edition,
                        name_evidence=name_evidence, reviewer=reviewer, organizer=organizer)
        return self._associate(source_id, expected_revision, decision)

    def link_reviewed_source(self, source_id, *, expected_revision, competition_id, edition, note, reviewer):
        for value, label in ((edition, "edition"), (note, "note"), (reviewer, "reviewer")):
            required(value, label)
        decision = dict(action="link", competition_id=competition_id, edition=edition, note=note, reviewer=reviewer)
        return self._associate(source_id, expected_revision, decision)

    def _associate(self, source_id, revision, decision):
        self.classify_source(source_id)
        with self.transaction():
            source, row = self.checked(source_id, revision)
            if row["stale"] or row["review_status"] != "confirmed" or row["category"] not in {
                    "competition_call", "competition_update", "competition_result"}:
                raise ReviewConflict("A current human-confirmed competition classification is required")
            if decision["action"] == "create" and row["category"] != "competition_call":
                raise ValueError("Result/update announcements can only link an existing competition")
            encoded = json.dumps(decision, ensure_ascii=False, sort_keys=True)
            if source["competition_id"] is not None:
                if row["decision_json"] == encoded:
                    return source["competition_id"]
                raise ReviewConflict("Source is already linked; no automatic relinking")
            if decision["action"] == "create":
                cursor = self.db.execute(
                    "INSERT INTO competitions(competition_name,organizer,status) VALUES (?,?,'confirmed')",
                    (decision["competition_name"], decision["organizer"]))
                cid = cursor.lastrowid
            else:
                cid = decision["competition_id"]
                if self.db.execute("SELECT 1 FROM competitions WHERE competition_id=?", (cid,)).fetchone() is None:
                    raise ValueError("Competition not found")
            self.db.execute("UPDATE competition_sources SET competition_id=? WHERE source_id=?", (cid, source_id))
            self.db.execute("UPDATE source_classifications SET decision_json=?, revision=revision+1 WHERE source_id=?",
                            (encoded, source_id))
            return cid
