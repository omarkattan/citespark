-- Cited: schema
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

-- ---------------------------------------------------------------
-- Billing. One subscription row per org, created lazily on first read.
-- ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  org_id                 INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  plan                   TEXT NOT NULL DEFAULT 'free',
  status                 TEXT NOT NULL DEFAULT 'active',
  interval               TEXT NOT NULL DEFAULT 'month',
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subs_customer ON subscriptions (stripe_customer_id);

-- Usage is counted per calendar month so a plan's call budget is easy to
-- reason about and easy to explain on an invoice query.
CREATE TABLE IF NOT EXISTS usage_monthly (
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  month      DATE NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  spend_usd  NUMERIC(10,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month)
);

-- Stripe retries webhooks. Recording event IDs makes handling idempotent.
CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which AI surfaces this project is measured against. Chosen per project so a
-- local clinic can skip Claude and a B2B brand can include it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS engines TEXT[] NOT NULL DEFAULT '{chatgpt}';

-- Per-site scheduling. An agency rarely wants every client on the same
-- cadence, and a paused site should stop costing money without being deleted.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_cycle BOOLEAN NOT NULL DEFAULT true;

-- Public demo. Every run costs real money with no account behind it, so each
-- one is recorded for rate limiting, for a global daily spend cap, and so an
-- identical request inside the cache window is served for free.
CREATE TABLE IF NOT EXISTS demo_runs (
  id         SERIAL PRIMARY KEY,
  ip_hash    TEXT NOT NULL,
  domain     TEXT NOT NULL,
  question   TEXT NOT NULL,
  result     JSONB,
  cost_usd   NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_ip_time ON demo_runs (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_cache ON demo_runs (domain, question, created_at DESC);
CREATE INDEX IF NOT EXISTS demo_time ON demo_runs (created_at DESC);

-- Emails captured from the demo, before anyone creates an account.
CREATE TABLE IF NOT EXISTS demo_leads (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  domain     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email, domain)
);

-- Actions become tasks: someone owns them, they are due by a date, and the
-- notes are where the person doing the work records what they actually did.
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS assignee     TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS due_date     DATE;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS notes        TEXT;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ;
ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS recs_due ON recommendations (project_id, due_date) WHERE status IN ('open','doing');

-- GA4 is connected per project, so an agency can attach a different Google
-- account to each client. The refresh token is encrypted at rest.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_refresh_token TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_property_id   TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_property_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_account_email TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_connected_at  TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ga4_synced_at     TIMESTAMPTZ;

-- Cached analysis of why a particular page was cited for a particular
-- question. Expensive to produce, and rarely changes inside a month.
CREATE TABLE IF NOT EXISTS page_teardowns (
  id         SERIAL PRIMARY KEY,
  url        TEXT NOT NULL,
  question   TEXT NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teardown_lookup ON page_teardowns (url, question, created_at DESC);

-- Search Console property, chosen per project alongside the GA4 one. Both
-- ride on the same Google authorisation.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gsc_site_url TEXT;

-- What the customer actually granted. Without this we cannot tell a missing
-- scope from a disabled API, and the interface guesses wrong.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS google_scopes TEXT;

-- Snapshots behind the public visibility index. Refreshed on a schedule, so a
-- visitor never triggers an API call and the page costs nothing to promote.
CREATE TABLE IF NOT EXISTS index_snapshots (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL,
  market      TEXT NOT NULL DEFAULT 'AE',
  data        JSONB NOT NULL,
  cost_usd    NUMERIC(10,6) NOT NULL DEFAULT 0,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS index_latest ON index_snapshots (market, slug, captured_at DESC);

-- Feedback from inside the product. Context is captured automatically because
-- "it broke" without a page or a project is almost impossible to action.
CREATE TABLE IF NOT EXISTS feedback (
  id          SERIAL PRIMARY KEY,
  org_id      INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  user_email  TEXT,
  kind        TEXT NOT NULL DEFAULT 'other',
  message     TEXT NOT NULL,
  context     JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'new',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_new ON feedback (status, created_at DESC);

-- Where a demo came from, so the index page can be judged as a funnel.
ALTER TABLE demo_runs ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE demo_runs ADD COLUMN IF NOT EXISTS brand_name TEXT;
