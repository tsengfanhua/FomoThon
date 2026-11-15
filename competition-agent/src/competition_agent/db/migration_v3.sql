CREATE TABLE skill_extraction_runs (
    run_id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES competition_sources(source_id) ON DELETE RESTRICT,
    competition_id INTEGER NOT NULL REFERENCES competitions(competition_id) ON DELETE RESTRICT,
    run_key TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt>0),
    source_snapshot_json TEXT NOT NULL,
    extractor_method TEXT NOT NULL CHECK(extractor_method IN ('mock','manual','openai')),
    extractor_version TEXT NOT NULL,
    search_version TEXT NOT NULL,
    catalogue_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('completed','failed')),
    proposal_count INTEGER NOT NULL CHECK(proposal_count>=0),
    error TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_key, attempt)
);
CREATE UNIQUE INDEX idx_completed_skill_run ON skill_extraction_runs(run_key) WHERE status='completed';
CREATE TABLE skill_proposals (
    proposal_id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES skill_extraction_runs(run_id) ON DELETE RESTRICT,
    proposal_key TEXT NOT NULL,
    skill_name TEXT NOT NULL CHECK(length(trim(skill_name))>0),
    evidence_level TEXT NOT NULL CHECK(evidence_level IN ('explicit','inferred','insufficient')),
    scope TEXT NOT NULL CHECK(scope IN ('competition_wide','group','unknown')),
    claim_json TEXT NOT NULL,
    search_terms_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    selected_concept_uri TEXT,
    importance TEXT CHECK(importance IN ('core','supporting','optional')),
    reviewer TEXT,
    review_note TEXT,
    reviewed_at TEXT,
    stale_reason TEXT,
    CHECK(status!='accepted' OR
          (selected_concept_uri IS NOT NULL AND importance IS NOT NULL AND reviewer IS NOT NULL
           AND length(trim(reviewer))>0 AND review_note IS NOT NULL AND length(trim(review_note))>0
           AND reviewed_at IS NOT NULL)),
    UNIQUE(run_id, proposal_key)
);
