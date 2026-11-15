"""Local stdio MCP, read-only schema-v3 queries. No extraction or credentials."""
import argparse
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import sys

from mcp.server.fastmcp import FastMCP
from competition_agent.db.repository import CompetitionRepository
from competition_agent.classification.rules import content_hash
from competition_agent.skills.local_esco import LocalEscoRepository
from competition_agent.skills.proposals import SkillReviewService
from competition_agent.skills.extraction import SkillClaim, validate_claim, explicit_support
from competition_agent.skills.validation import SkillUriValidator


@contextmanager
def readers(competition_db, esco_db):
    db = sqlite3.connect(Path(competition_db).resolve().as_uri() + "?mode=ro", uri=True)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("PRAGMA foreign_keys=ON")
        if db.execute("PRAGMA user_version").fetchone()[0] != 3:
            raise ValueError("Schema v3 required; no automatic migration")
        with LocalEscoRepository(esco_db) as esco:
            db.execute("BEGIN")
            yield db, CompetitionRepository(db), esco
    finally:
        db.close()


def sources(db, repo, cid):
    result = []
    for row in repo.list_sources(cid):
        review = db.execute("SELECT * FROM source_classifications WHERE source_id=?", (row['source_id'],)).fetchone()
        current = bool(review and review['review_status'] == 'confirmed' and not review['stale']
                       and review['content_hash'] == review['observed_hash'] == content_hash(row))
        result.append({**dict(row), 'classification': dict(review) if review else None,
                       'source_status': 'confirmed_current' if current else 'needs_review'})
    return result


def create_server(competition_db, esco_db):
    # Fail before starting stdio when paths/schema are unavailable; never initialize.
    with readers(competition_db, esco_db):
        pass
    server = FastMCP("Competition Agent")

    @server.tool()
    def list_competitions(limit: int = 20) -> dict:
        """List confirmed competition records only. limit: 1..100."""
        if not 1 <= limit <= 100:
            return {'status': 'invalid_limit', 'competitions': []}
        with readers(competition_db, esco_db) as (db, repo, esco):
            rows = db.execute("SELECT * FROM competitions WHERE status='confirmed' ORDER BY competition_id LIMIT ?", (limit,))
            return {'status': 'ok', 'competitions': [dict(r) for r in rows]}

    @server.tool()
    def get_competition(competition_id: int) -> dict:
        """Return stored competition and source review state; no inferred groups."""
        with readers(competition_db, esco_db) as (db, repo, esco):
            row = repo.get_competition(competition_id)
            if row is None:
                return {'status': 'not_found', 'competition': None}
            return {'status': 'ok' if row['status'] == 'confirmed' else 'not_confirmed',
                    'competition': dict(row), 'groups': None, 'groups_status': 'not_recorded',
                    'sources': sources(db, repo, competition_id)}

    @server.tool()
    def get_competition_skills(competition_id: int) -> dict:
        """Formal associations only; valid=false means do not use as verified skills."""
        with readers(competition_db, esco_db) as (db, repo, esco):
            competition = repo.get_competition(competition_id)
            if competition is None:
                return {'status': 'not_found', 'skills': []}
            review = SkillReviewService(db, esco)
            skills = []
            for row in repo.list_skills(competition_id):
                record = esco.get(row['concept_uri'])
                item = {**dict(row), 'label': record['preferred_label'] if record else None,
                        'valid': False, 'status': 'needs_review'}
                try:
                    evidence = review._read_evidence(row['evidence'])
                    if not evidence['items'] or competition['status'] != 'confirmed':
                        raise ValueError()
                    review._check_existing_evidence(evidence, competition_id, row['concept_uri'], row['importance'])
                    SkillUriValidator(esco).require_valid(row['concept_uri'])
                    catalogue = esco.fingerprint()
                    for entry in evidence['items']:
                        proposal = review.get(entry['proposal_id'])
                        claim = SkillClaim(**json.loads(proposal['claim_json']))
                        validate_claim(claim, review.source_snapshot(competition_id, proposal['source_id']))
                        candidates = {c['concept_uri']: c for c in json.loads(proposal['candidates_json'])}
                        if (not explicit_support(claim) or claim.scope != 'competition_wide'
                                or candidates.get(row['concept_uri']) != record
                                or entry.get('catalogue_hash') != catalogue or proposal['catalogue_hash'] != catalogue):
                            raise ValueError()
                    item.update(evidence=evidence, valid=True, status='accepted_current')
                except (ValueError, KeyError, TypeError):
                    # Preserve legacy evidence without promoting it or mutating status.
                    item['status'] = 'stale_unverified_or_insufficient_evidence'
                skills.append(item)
            return {'status': 'ok' if competition['status'] == 'confirmed' else 'not_confirmed',
                    'skills': skills, 'sources': sources(db, repo, competition_id)}

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--competition-db', required=True)
    parser.add_argument('--esco-db', required=True)
    args = parser.parse_args()
    try:
        server = create_server(args.competition_db, args.esco_db)
    except (sqlite3.Error, ValueError, OSError):
        print('DATABASE_UNAVAILABLE_OR_INCOMPATIBLE', file=sys.stderr)
        return 1
    server.run(transport='stdio')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
