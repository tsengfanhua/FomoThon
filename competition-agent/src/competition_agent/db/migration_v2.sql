CREATE TABLE source_classifications (
    source_id INTEGER PRIMARY KEY REFERENCES competition_sources(source_id) ON DELETE RESTRICT,
    category TEXT NOT NULL CHECK(category IN ('competition_call','competition_update','competition_result','non_competition','needs_review')),
    evidence_json TEXT NOT NULL CHECK(length(evidence_json)>2),
    method TEXT NOT NULL CHECK(method IN ('rule','manual')),
    rule_version TEXT,
    content_hash TEXT NOT NULL,
    observed_hash TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK(review_status IN ('pending','confirmed')),
    stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
    classified_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    review_note TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    decision_json TEXT,
    CHECK(method != 'rule' OR rule_version IS NOT NULL),
    CHECK(review_status != 'confirmed' OR
          (stale=0 AND content_hash=observed_hash AND reviewed_at IS NOT NULL
           AND reviewed_by IS NOT NULL AND review_note IS NOT NULL
           AND length(trim(reviewed_by))>0 AND length(trim(review_note))>0)),
    CHECK(stale=0 OR review_status='pending')
);
