CREATE TABLE IF NOT EXISTS competitions (
    competition_id INTEGER PRIMARY KEY,
    competition_name TEXT NOT NULL CHECK (length(trim(competition_name)) > 0),
    organizer TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'archived')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS competition_sources (
    source_id INTEGER PRIMARY KEY,
    competition_id INTEGER REFERENCES competitions(competition_id) ON DELETE RESTRICT,
    source_school TEXT,
    source_url TEXT NOT NULL UNIQUE CHECK (length(trim(source_url)) > 0),
    published_at TEXT,
    title TEXT NOT NULL,
    clean_content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_competition ON competition_sources(competition_id);

CREATE TABLE IF NOT EXISTS competition_skills (
    competition_id INTEGER NOT NULL REFERENCES competitions(competition_id) ON DELETE RESTRICT,
    concept_uri TEXT NOT NULL CHECK (length(trim(concept_uri)) > 0),
    importance TEXT NOT NULL CHECK (importance IN ('core', 'supporting', 'optional')),
    evidence TEXT NOT NULL CHECK (length(trim(evidence)) > 0),
    PRIMARY KEY (competition_id, concept_uri)
);
