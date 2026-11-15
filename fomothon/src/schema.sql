-- Fomo鬆 資料表。共用 Skill 資料庫（skills）是唯一的技能標準；
-- 學生、教師、競賽各自保存自己的資料，但都只引用 skills.id。

CREATE TABLE IF NOT EXISTS skills (
  id        TEXT PRIMARY KEY,           -- 內部 ID，例如 SK-WEB-004
  zh        TEXT NOT NULL,
  en        TEXT NOT NULL,
  category  TEXT NOT NULL,
  parent_id TEXT,                       -- 上位技能（階層）
  scale     TEXT NOT NULL DEFAULT 'score' CHECK (scale IN ('score', 'cefr')),
  aliases   TEXT NOT NULL,              -- JSON 陣列
  ext       TEXT NOT NULL               -- JSON：esco / onetUnspsc / sfia / ucan 外部對應
);

CREATE TABLE IF NOT EXISTS skill_relations (
  a      TEXT NOT NULL,
  b      TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS users (
  id    TEXT PRIMARY KEY,
  role  TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'admin')),
  name  TEXT NOT NULL,
  dept  TEXT,
  attrs TEXT NOT NULL DEFAULT '{}'      -- JSON：依角色不同的屬性
);

CREATE TABLE IF NOT EXISTS courses (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  dept       TEXT,
  credits    INTEGER,
  teacher_id TEXT,
  syllabus   TEXT NOT NULL              -- JSON：示意課綱站的內容來源
);

-- 課程 → 技能 的解析快取（課綱更新時批次重算）
CREATE TABLE IF NOT EXISTS course_skills (
  course_code TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  coverage    REAL NOT NULL,
  PRIMARY KEY (course_code, skill_id)
);

-- 修課紀錄：成績為個資，只用於推估，不進入執行紀錄與他人可見的輸出
CREATE TABLE IF NOT EXISTS enrollments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  TEXT NOT NULL,
  course_code TEXT,
  course_name TEXT NOT NULL,
  semester    TEXT,
  grade       INTEGER NOT NULL,
  verified    INTEGER NOT NULL DEFAULT 0
);

-- 證據：同一技能可有多筆，全部保留
CREATE TABLE IF NOT EXISTS evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('course', 'certificate', 'portfolio', 'competition')),
  title       TEXT NOT NULL,
  source_ref  TEXT,
  status      TEXT NOT NULL CHECK (status IN ('verified', 'self_reported', 'inferred')),
  score       REAL NOT NULL,
  level_label TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  group_key   TEXT,                     -- 同一份自填資料對應多個技能時共用
  created_at  TEXT NOT NULL,
  verified_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_owner ON evidence (owner_id, skill_id);

-- Skill Profile：由證據依統一規則彙整（取最高、不疊加）
CREATE TABLE IF NOT EXISTS profile_skills (
  owner_id          TEXT NOT NULL,
  skill_id          TEXT NOT NULL,
  score             REAL NOT NULL,
  level             TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('verified', 'self_reported', 'inferred')),
  basis_evidence_id INTEGER,
  evidence_count    INTEGER NOT NULL,
  kept              INTEGER NOT NULL DEFAULT 1,
  note              TEXT,
  PRIMARY KEY (owner_id, skill_id)
);

CREATE TABLE IF NOT EXISTS profiles (
  owner_id     TEXT PRIMARY KEY,
  state        TEXT NOT NULL CHECK (state IN ('draft', 'confirmed')),
  updated_at   TEXT NOT NULL,
  confirmed_at TEXT,
  stale        INTEGER NOT NULL DEFAULT 0   -- 修課紀錄有異動、尚未重新盤點
);

CREATE TABLE IF NOT EXISTS competitions (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL,
  deadline TEXT NOT NULL,
  data     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  goal       TEXT NOT NULL,
  status     TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  ts      TEXT NOT NULL,
  type    TEXT NOT NULL,
  agent   TEXT,
  tool    TEXT,
  summary TEXT NOT NULL,
  data    TEXT,
  ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events (run_id, seq);

CREATE TABLE IF NOT EXISTS invitations (
  id             TEXT PRIMARY KEY,
  run_id         TEXT,
  from_id        TEXT NOT NULL,
  to_id          TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('teammate', 'advisor')),
  competition_id TEXT,
  skill_id       TEXT,
  message        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'declined', 'cancelled')),
  created_at     TEXT NOT NULL,
  decided_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);

-- MCP 個人存取權杖：只存 SHA-256 雜湊；可設定期限與撤銷。權杖綁定帳號，工具只能讀該帳號看得到的資料。
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);
