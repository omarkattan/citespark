-- Additive conversion migration. Run through npm run migrate. Safe to repeat.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS conversion_test BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS conversion_existing_customer BOOLEAN;
-- Snapshot once. Later migrations must not relabel newly acquired customers.
UPDATE orgs o SET conversion_existing_customer=EXISTS(
 SELECT 1 FROM subscriptions s WHERE s.org_id=o.id AND
 (s.plan<>'free' OR s.stripe_subscription_id IS NOT NULL))
 WHERE conversion_existing_customer IS NULL;
ALTER TABLE orgs ALTER COLUMN conversion_existing_customer SET DEFAULT false;
ALTER TABLE orgs ALTER COLUMN conversion_existing_customer SET NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consent_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_suppressed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_suppression_reason TEXT;
ALTER TABLE demo_journeys ADD COLUMN IF NOT EXISTS attribution JSONB NOT NULL DEFAULT '{}';
ALTER TABLE demo_journeys ADD COLUMN IF NOT EXISTS setup_context JSONB NOT NULL DEFAULT '{}';
ALTER TABLE demo_journeys ADD COLUMN IF NOT EXISTS demo_summary JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS demo_journeys_org ON demo_journeys(org_id);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_created BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS conversion_events (
 id BIGSERIAL PRIMARY KEY,
 org_id INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
 journey_id UUID REFERENCES demo_journeys(id) ON DELETE CASCADE,
 event_name TEXT NOT NULL,
 dedupe_key TEXT NOT NULL UNIQUE,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 detail JSONB NOT NULL DEFAULT '{}',
 CHECK(org_id IS NOT NULL OR journey_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS conversion_events_org ON conversion_events(org_id,occurred_at);
CREATE INDEX IF NOT EXISTS conversion_events_journey ON conversion_events(journey_id,occurred_at);
CREATE OR REPLACE FUNCTION record_conversion_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO conversion_events(org_id,event_name,dedupe_key,occurred_at)
 VALUES(NEW.org_id,'signup_completed','signup:'||NEW.org_id,NEW.created_at) ON CONFLICT DO NOTHING;
 IF NEW.email_verified_at IS NOT NULL THEN
  INSERT INTO conversion_events(org_id,event_name,dedupe_key,occurred_at)
  VALUES(NEW.org_id,'email_verified','verified:'||NEW.id,NEW.email_verified_at) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conversion_user ON users;
CREATE TRIGGER conversion_user AFTER INSERT OR UPDATE OF email_verified_at ON users
 FOR EACH ROW EXECUTE FUNCTION record_conversion_user();
CREATE OR REPLACE FUNCTION record_conversion_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO conversion_events(org_id,event_name,dedupe_key,occurred_at,detail)
 VALUES(NEW.org_id,'project_created','project:'||NEW.id,NEW.created_at,jsonb_build_object('projectId',NEW.id)) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS conversion_project ON projects;
CREATE TRIGGER conversion_project AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION record_conversion_project();
-- Only historical facts with a known timestamp are backfilled. Reports and payments are not inferred.
INSERT INTO conversion_events(org_id,event_name,dedupe_key,occurred_at)
 SELECT org_id,'signup_completed','signup:'||org_id,MIN(created_at) FROM users GROUP BY org_id
 ON CONFLICT(dedupe_key) DO NOTHING;
INSERT INTO conversion_events(org_id,event_name,dedupe_key,occurred_at,detail)
 SELECT org_id,'project_created','project:'||id,created_at,jsonb_build_object('projectId',id)
 FROM projects ON CONFLICT(dedupe_key) DO NOTHING;
INSERT INTO conversion_events(journey_id,event_name,dedupe_key,occurred_at)
 SELECT id,'demo_completed','demo:'||id,result_at FROM demo_journeys WHERE result_at IS NOT NULL
 ON CONFLICT(dedupe_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS conversion_payments (
 invoice_id TEXT PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 payment_intent_ids TEXT[] NOT NULL DEFAULT '{}',
 charge_id TEXT,
 currency TEXT NOT NULL,
 amount_paid BIGINT NOT NULL CHECK(amount_paid>0),
 billing_reason TEXT NOT NULL,
 paid_at TIMESTAMPTZ NOT NULL,
 livemode BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversion_payments_org ON conversion_payments(org_id,paid_at);
CREATE TABLE IF NOT EXISTS conversion_refunds (
 refund_id TEXT PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 payment_intent_id TEXT,
 charge_id TEXT,
 currency TEXT NOT NULL,
 amount BIGINT NOT NULL CHECK(amount>=0),
 status TEXT NOT NULL,
 livemode BOOLEAN NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL
);
-- Successful, failed and uncertain deliveries are reserved once. No blind retries after a timeout.
CREATE TABLE IF NOT EXISTS conversion_messages (
 id BIGSERIAL PRIMARY KEY,
 org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 rule TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'reserved',
 provider_id TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 sent_at TIMESTAMPTZ,
 UNIQUE(org_id,rule)
);
CREATE INDEX IF NOT EXISTS conversion_messages_user ON conversion_messages(user_id,created_at);
-- Keep suppression across account deletion/re-registration without keeping the address itself.
CREATE TABLE IF NOT EXISTS conversion_suppressions (
 email_hash TEXT PRIMARY KEY,
 reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
