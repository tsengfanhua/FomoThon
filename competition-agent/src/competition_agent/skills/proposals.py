"""Offline proposal generation and atomic human acceptance, independent of other Agents."""
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json

from competition_agent.classification.rules import content_hash, SCHOOL
from .extraction import (SkillClaim, SkillExtractor, SEARCH_VERSION, SEARCH_TERMS,
                         validate_claim, controlled_terms, explicit_support)
from .validation import SkillUriValidator, SkillValidationError, ValidationResult


class ProposalConflict(ValueError):
    pass


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def fingerprint(value):
    return hashlib.sha256(encode(value).encode("utf-8")).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def require_text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be nonblank text")


class SkillService:
    def __init__(self, connection, esco):
        if connection.execute("PRAGMA user_version").fetchone()[0] != 3:
            raise ValueError("Schema v3 required")
        if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            raise ValueError("Foreign keys required")
        self.db = connection
        self.esco = esco

    @contextmanager
    def transaction(self):
        if self.db.in_transaction:
            raise RuntimeError("Skill services own their transactions")
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def source_snapshot(self, competition_id, source_id):
        source = self.db.execute("SELECT * FROM competition_sources WHERE source_id=?", (source_id,)).fetchone()
        competition = self.db.execute("SELECT * FROM competitions WHERE competition_id=?", (competition_id,)).fetchone()
        classification = self.db.execute("SELECT * FROM source_classifications WHERE source_id=?", (source_id,)).fetchone()
        if (source is None or competition is None or classification is None
                or source["competition_id"] != competition_id or source["source_school"] != SCHOOL
                or competition["status"] != "confirmed" or classification["review_status"] != "confirmed"
                or classification["stale"] or classification["category"] != "competition_call"):
            raise ProposalConflict("Requires a linked, human-confirmed HWU competition call")
        digest = content_hash(source)
        if digest != classification["content_hash"] or digest != classification["observed_hash"]:
            raise ProposalConflict("Source classification is out of date")
        return dict(source_id=source_id, competition_id=competition_id, source_url=source["source_url"],
                    source_school=source["source_school"], title=source["title"], clean_content=source["clean_content"],
                    content_hash=digest, classification_revision=classification["revision"])

    def catalogue_hash(self):
        try:
            result = self.esco.fingerprint()
            require_text(result, "catalogue fingerprint")
            return result
        except Exception as exc:
            raise SkillValidationError(ValidationResult.UNAVAILABLE) from exc

    def get(self, proposal_id):
        row = self.db.execute(
            "SELECT p.*,r.source_id,r.competition_id,r.source_snapshot_json,r.catalogue_hash,"
            "r.extractor_method,r.extractor_version FROM skill_proposals p "
            "JOIN skill_extraction_runs r USING(run_id) WHERE proposal_id=?", (proposal_id,)).fetchone()
        if row is None:
            raise ValueError("Proposal not found")
        return row

    def list_proposals(self, run_id):
        return self.db.execute("SELECT * FROM skill_proposals WHERE run_id=? ORDER BY proposal_id", (run_id,)).fetchall()


class SkillProposalService(SkillService):
    def extract(self, competition_id, source_id, extractor: SkillExtractor):
        require_text(extractor.version, "extractor version")
        if extractor.method == "openai":
            from .openai_extractor import OpenAISkillExtractor
            if not isinstance(extractor, OpenAISkillExtractor):
                raise ValueError("OpenAI method requires the guarded adapter")
            if extractor.counter_version == "utf8-budget-v1":
                raise ValueError("UTF-8 budget estimation is restricted to standalone smoke tests")
            # Reject concurrent sessions before checking the existing proposal cache.
            with extractor.operation():
                return self._extract(competition_id, source_id, extractor)
        if extractor.method not in {"mock", "manual"}:
            raise ValueError("Unsupported extractor method")
        return self._extract(competition_id, source_id, extractor)

    def _extract(self, competition_id, source_id, extractor):
        with self.transaction():
            snapshot = self.source_snapshot(competition_id, source_id)
            catalogue = self.catalogue_hash()
            key = fingerprint([snapshot, extractor.method, extractor.version, SEARCH_VERSION, SEARCH_TERMS, catalogue])
            cached = self.db.execute(
                "SELECT * FROM skill_extraction_runs WHERE run_key=? AND status='completed'", (key,)).fetchone()
            if cached is not None:
                return cached
        # No SQLite write transaction is held during an extractor/network operation.
        failure = None
        prepared = {}
        try:
            claims = extractor.extract(json.loads(encode(snapshot)))
            if not isinstance(claims, list):
                raise ValueError("Extractor output must be a list")
            for claim in claims:
                validate_claim(claim, snapshot)
                terms = controlled_terms(claim)
                candidates = {}
                for term in terms:
                    try:
                        found = self.esco.search(term, limit=20)
                    except Exception as exc:
                        raise SkillValidationError(ValidationResult.UNAVAILABLE) from exc
                    for candidate in found:
                        uri = candidate["concept_uri"]
                        SkillUriValidator(self.esco).require_valid(uri)
                        record = dict(self.esco.get(uri))
                        candidates[uri] = {k: record[k] for k in ("concept_uri", "preferred_label", "description")}
                data = asdict(claim)
                proposal_key = fingerprint({k: v for k, v in data.items() if k != "reason"})
                prepared[proposal_key] = (claim, terms, sorted(candidates.values(), key=lambda r: r["concept_uri"]))
        except Exception as exc:
            failure = exc
            prepared = {}
        with self.transaction():
            # Another offline caller may have completed while this extractor ran.
            cached = self.db.execute(
                "SELECT * FROM skill_extraction_runs WHERE run_key=? AND status='completed'", (key,)).fetchone()
            attempt = self.db.execute("SELECT coalesce(max(attempt),0)+1 FROM skill_extraction_runs WHERE run_key=?", (key,)).fetchone()[0]
            try:
                if self.source_snapshot(competition_id, source_id) != snapshot or self.catalogue_hash() != catalogue:
                    raise ProposalConflict("Source/catalogue changed during extraction")
            except Exception as exc:
                failure = exc
                prepared = {}
            if cached is not None and failure is None:
                return cached
            cursor = self.db.execute(
                "INSERT INTO skill_extraction_runs (source_id,competition_id,run_key,attempt,source_snapshot_json,"
                "extractor_method,extractor_version,search_version,catalogue_hash,status,proposal_count,error,created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (source_id, competition_id, key, attempt, encode(snapshot), extractor.method, extractor.version,
                 SEARCH_VERSION, catalogue, "failed" if failure else "completed", len(prepared),
                 str(failure) if failure else None, now()))
            run_id = cursor.lastrowid
            for proposal_key, (claim, terms, candidates) in prepared.items():
                self.db.execute(
                    "INSERT INTO skill_proposals (run_id,proposal_key,skill_name,evidence_level,scope,claim_json,"
                    "search_terms_json,candidates_json) VALUES (?,?,?,?,?,?,?,?)",
                    (run_id, proposal_key, claim.skill_name, claim.evidence_level, claim.scope,
                     encode(asdict(claim)), encode(terms), encode(candidates)))
            result = self.db.execute("SELECT * FROM skill_extraction_runs WHERE run_id=?", (run_id,)).fetchone()
        if failure is not None:
            raise failure
        return result


class SkillReviewService(SkillService):
    def refresh(self, proposal_id):
        """Persist source staleness without erasing the original proposal/decision."""
        with self.transaction():
            row = self.get(proposal_id)
            try:
                current = self.source_snapshot(row["competition_id"], row["source_id"])
                if current != json.loads(row["source_snapshot_json"]):
                    raise ProposalConflict("Source snapshot/revision changed")
            except ProposalConflict as exc:
                if row["status"] != "stale":
                    self.db.execute("UPDATE skill_proposals SET status='stale',stale_reason=?,revision=revision+1 WHERE proposal_id=?",
                                    (str(exc), proposal_id))
            return self.get(proposal_id)

    def accept_skill_proposal(self, proposal_id, *, expected_revision, selected_concept_uri,
                              importance, reviewer, note):
        require_text(reviewer, "reviewer")
        require_text(note, "note")
        if importance not in {"core", "supporting", "optional"}:
            raise ValueError("Invalid importance")
        self.refresh(proposal_id)
        with self.transaction():
            row = self.get(proposal_id)
            if row["revision"] != expected_revision or row["status"] in {"stale", "rejected"}:
                raise ProposalConflict("Stale revision or non-reviewable proposal")
            snapshot = json.loads(row["source_snapshot_json"])
            if self.source_snapshot(row["competition_id"], row["source_id"]) != snapshot:
                raise ProposalConflict("Source changed during review")
            claim = SkillClaim(**json.loads(row["claim_json"]))
            validate_claim(claim, snapshot)
            if claim.scope != "competition_wide" or not explicit_support(claim):
                raise ProposalConflict("Explicit, supported competition-wide evidence required")
            candidates = {c["concept_uri"]: c for c in json.loads(row["candidates_json"])}
            if selected_concept_uri not in candidates:
                raise ProposalConflict("URI is outside the proposal candidate list")
            SkillUriValidator(self.esco).require_valid(selected_concept_uri)
            current = dict(self.esco.get(selected_concept_uri))
            if any(current[k] != candidates[selected_concept_uri][k] for k in candidates[selected_concept_uri]):
                raise ProposalConflict("ESCO definition changed; regenerate and review")
            if self.catalogue_hash() != row["catalogue_hash"]:
                raise ProposalConflict("ESCO snapshot changed; regenerate and review")
            if row["status"] == "accepted":
                if (row["selected_concept_uri"], row["importance"], row["reviewer"], row["review_note"]) != (
                        selected_concept_uri, importance, reviewer, note):
                    raise ProposalConflict("Already accepted with a different decision")
                stored = self.db.execute("SELECT * FROM competition_skills WHERE competition_id=? AND concept_uri=?",
                                         (row["competition_id"], selected_concept_uri)).fetchone()
                if stored is None or stored["importance"] != importance:
                    raise ProposalConflict("Accepted association was externally changed")
                evidence = self._read_evidence(stored["evidence"])
                self._check_existing_evidence(evidence, row["competition_id"], selected_concept_uri, importance)
                if not any(e.get("proposal_id") == proposal_id for e in evidence["items"]):
                    raise ProposalConflict("Accepted evidence was externally changed")
                return row
            reviewed_at = now()
            evidence_item = dict(proposal_id=proposal_id, source_id=row["source_id"], source_url=snapshot["source_url"],
                quote=claim.quote, field=claim.field, start=claim.start, end=claim.end,
                content_hash=snapshot["content_hash"], classification_revision=snapshot["classification_revision"],
                scope=claim.scope, concept_uri=selected_concept_uri, catalogue_hash=row["catalogue_hash"],
                review=dict(reviewer=reviewer, note=note, reviewed_at=reviewed_at, importance=importance))
            existing = self.db.execute("SELECT * FROM competition_skills WHERE competition_id=? AND concept_uri=?",
                                       (row["competition_id"], selected_concept_uri)).fetchone()
            evidence = {"schema_version": 1, "items": []}
            if existing is not None:
                if existing["importance"] != importance:
                    raise ProposalConflict("Importance conflict requires manual resolution")
                evidence = self._read_evidence(existing["evidence"])
                self._check_existing_evidence(evidence, row["competition_id"], selected_concept_uri, importance)
            if not any(item.get("proposal_id") == proposal_id for item in evidence["items"]):
                evidence["items"].append(evidence_item)
            if existing is None:
                self.db.execute("INSERT INTO competition_skills VALUES (?,?,?,?)",
                    (row["competition_id"], selected_concept_uri, importance, encode(evidence)))
            else:
                self.db.execute("UPDATE competition_skills SET evidence=? WHERE competition_id=? AND concept_uri=?",
                    (encode(evidence), row["competition_id"], selected_concept_uri))
            self.db.execute(
                "UPDATE skill_proposals SET status='accepted',selected_concept_uri=?,importance=?,reviewer=?,"
                "review_note=?,reviewed_at=?,revision=revision+1 WHERE proposal_id=?",
                (selected_concept_uri, importance, reviewer, note, reviewed_at, proposal_id))
            return self.get(proposal_id)

    def _check_existing_evidence(self, evidence, competition_id, uri, importance):
        """Do not silently carry forward stale evidence when merging another source."""
        for item in evidence["items"]:
            try:
                old = self.get(item["proposal_id"])
                snapshot = json.loads(old["source_snapshot_json"])
                claim = SkillClaim(**json.loads(old["claim_json"]))
                if (old["status"] != "accepted" or old["competition_id"] != competition_id
                        or old["selected_concept_uri"] != uri or old["importance"] != importance
                        or self.source_snapshot(competition_id, old["source_id"]) != snapshot
                        or item["source_id"] != old["source_id"] or item["source_url"] != snapshot["source_url"]
                        or item["content_hash"] != snapshot["content_hash"] or item["quote"] != claim.quote
                        or item["field"] != claim.field or item["start"] != claim.start or item["end"] != claim.end
                        or item["classification_revision"] != snapshot["classification_revision"]
                        or item["scope"] != claim.scope or item["concept_uri"] != uri
                        or item["review"] != dict(reviewer=old["reviewer"], note=old["review_note"],
                                                   reviewed_at=old["reviewed_at"], importance=importance)):
                    raise ProposalConflict("Existing evidence is stale or was externally changed")
            except (KeyError, TypeError, ValueError) as exc:
                raise ProposalConflict("Existing evidence requires manual reconciliation") from exc

    @staticmethod
    def _read_evidence(text):
        try:
            result = json.loads(text)
            if (not isinstance(result, dict) or result.get("schema_version") != 1
                    or not isinstance(result.get("items"), list)
                    or not all(isinstance(item, dict) and "proposal_id" in item for item in result["items"])):
                raise ValueError()
            return result
        except (ValueError, TypeError) as exc:
            raise ProposalConflict("Legacy/unknown evidence is preserved; explicit migration required") from exc

    def reject_skill_proposal(self, proposal_id, *, expected_revision, reviewer, note):
        require_text(reviewer, "reviewer")
        require_text(note, "note")
        with self.transaction():
            row = self.get(proposal_id)
            if row["revision"] != expected_revision or row["status"] != "pending":
                raise ProposalConflict("Only a current pending proposal may be rejected")
            self.db.execute("UPDATE skill_proposals SET status='rejected',reviewer=?,review_note=?,reviewed_at=?,revision=revision+1 WHERE proposal_id=?",
                            (reviewer, note, now(), proposal_id))
            return self.get(proposal_id)
