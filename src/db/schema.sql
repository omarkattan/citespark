-- CiteSpark: schema
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS orgs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  org_id        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,
  brand_name  TEXT NOT NULL,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  market      TEXT NOT NULL DEFAULT 'GB',
  language    TEXT NOT NULL DEFAULT 'en',
  runs_per_cycle INTEGER NOT NULL DEFAULT 3,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Owned brand and competitors share a table so mention detection is uniform.
CREATE TABLE IF NOT EXISTS entities (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  domain      TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('owned', 'competitor')),
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS prompts (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  cluster          TEXT NOT NULL DEFAULT 'general',
  intent           TEXT NOT NULL DEFAULT 'commercial',
  ai_search_volume INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT 'generated',
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, text)
);

CREATE TABLE IF NOT EXISTS runs (
  id            SERIAL PRIMARY KEY,
  prompt_id     INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine        TEXT NOT NULL,
  model         TEXT,
  cycle_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  run_index     INTEGER NOT NULL DEFAULT 0,
  response_text TEXT,
  ok            BOOLEAN NOT NULL DEFAULT true,
  error         TEXT,
  cost_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_project_cycle ON runs (project_id, cycle_date);
CREATE INDEX IF NOT EXISTS runs_prompt_cycle ON runs (prompt_id, cycle_date);

CREATE TABLE IF NOT EXISTS mentions (
  id         SERIAL PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  entity_id  INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mentioned  BOOLEAN NOT NULL,
  ordinal    INTEGER,
  sentiment  TEXT,
  snippet    TEXT,
  UNIQUE (run_id, entity_id)
);

CREATE TABLE IF NOT EXISTS citations (
  id       SERIAL PRIMARY KEY,
  run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  domain   TEXT NOT NULL,
  url      TEXT,
  position INTEGER
);
CREATE INDEX IF NOT EXISTS citations_run ON citations (run_id);

-- GA4 AI Assistant channel plus our own source-derived classification.
-- classification_method: 'native' (medium = ai-assistant) or 'derived' (source lookup).
CREATE TABLE IF NOT EXISTS ga4_daily (
  id                    SERIAL PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date                  DATE NOT NULL,
  platform              TEXT NOT NULL,
  classification_method TEXT NOT NULL DEFAULT 'derived',
  landing_page          TEXT,
  sessions              INTEGER NOT NULL DEFAULT 0,
  conversions           NUMERIC(12,2) NOT NULL DEFAULT 0,
  revenue               NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE (project_id, date, platform, classification_method, landing_page)
);

CREATE TABLE IF NOT EXISTS recommendations (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_url  TEXT,
  impact      NUMERIC(8,2) NOT NULL DEFAULT 0,
  effort      NUMERIC(8,2) NOT NULL DEFAULT 1,
  priority    NUMERIC(8,2) NOT NULL DEFAULT 0,
  evidence    JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS recs_project_status ON recommendations (project_id, status, priority DESC);

-- Added for in-app project setup. ALTER ... IF NOT EXISTS is idempotent,
-- so this applies cleanly to databases created before these columns existed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS category  TEXT NOT NULL DEFAULT 'business';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS qualifier TEXT NOT NULL DEFAULT 'small business';

-- The searches an engine actually ran to build its answer. Verified present in
-- ChatGPT llm_responses payloads. This is the bridge between GEO and classic SEO.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS fan_out_queries TEXT[] NOT NULL DEFAULT '{}';
