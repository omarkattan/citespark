// Exact source/target receipts prevent this small upgrade from accidentally
// marking unrelated future schema changes as applied. Keep schema.sql complete
// for fresh installs. Existing installations must not replay old ALTERs and
// backfills just to replace a reporting view.
export const schemaUpgrades=[{
  name:'project reporting lookup',
  from:'d3dfd5816186781a33d9eb519d110653aa7b026446a36f5f10de9af1cfede990',
  to:'941ece3b118d1518c0495a0daace6f2482d26d17cdd6a38b17093ab337d736a4',
  steps:[{
    name:'published measurement index',
    sql:`CREATE INDEX IF NOT EXISTS measurement_published_lookup
 ON measurement_batches(project_id,cycle_date,completed_at DESC,id DESC)
 WHERE status='completed' AND purpose='monitoring'`
  },{
    name:'measurement membership index',
    sql:'CREATE INDEX IF NOT EXISTS measurement_members_run ON measurement_members(run_id,measurement_id)'
  },{
    name:'project reporting view',
    sql:`CREATE OR REPLACE VIEW reporting_runs AS
 SELECT r.* FROM published_measurements b
 JOIN runs r ON r.measurement_id=b.id AND r.project_id=b.project_id
 UNION ALL
 SELECT r.* FROM published_measurements b
 JOIN measurement_members m ON m.measurement_id=b.id
 JOIN runs r ON r.id=m.run_id AND r.project_id=b.project_id
 WHERE r.measurement_id IS DISTINCT FROM b.id`
  }]
}];

schemaUpgrades.push({"name": "Quick Start onboarding", "from": "941ece3b118d1518c0495a0daace6f2482d26d17cdd6a38b17093ab337d736a4", "to": "56769653484799cf4363bbf5ba00651a51e3366f116782dc7c4a627ce920b431", "steps": [{"name": "Quick Start account and report state", "sql": "\n-- Quick Start is opt-in for existing accounts and the default for new signups.\nALTER TABLE orgs ADD COLUMN IF NOT EXISTS quick_start_enabled BOOLEAN NOT NULL DEFAULT false;\nALTER TABLE projects ADD COLUMN IF NOT EXISTS quick_start BOOLEAN NOT NULL DEFAULT false;\nCREATE TABLE IF NOT EXISTS quick_start_reports (\n org_id INTEGER PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,\n project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,\n started_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n completed_at TIMESTAMPTZ\n);\n"}]});

schemaUpgrades.push({"name": "Quick Start editing and completion preferences", "from": "56769653484799cf4363bbf5ba00651a51e3366f116782dc7c4a627ce920b431", "to": "3e987d73188926bcd473a053716ad10f8bc5a73c84aa3c2e3ced598581a73909", "steps": [{"name": "Quick Start preferences", "sql": "ALTER TABLE projects ADD COLUMN IF NOT EXISTS quick_start_options JSONB NOT NULL DEFAULT '{}';\nCREATE TABLE IF NOT EXISTS quick_start_preferences (\n project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,\n user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,\n email_when_done BOOLEAN NOT NULL DEFAULT false,\n notified_at TIMESTAMPTZ,\n PRIMARY KEY(project_id,user_id)\n);\nCREATE TABLE IF NOT EXISTS quick_start_ai_requests (\n user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,\n created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);\nCREATE INDEX IF NOT EXISTS quick_start_ai_requests_user ON quick_start_ai_requests(user_id,created_at);\n"}]});

schemaUpgrades.push({"name": "Free opportunity preview for new accounts", "from": "3e987d73188926bcd473a053716ad10f8bc5a73c84aa3c2e3ced598581a73909", "to": "d9085cf644fac80194cdcbc8df62baf425f4554c492b97ed11a9ef6938994586", "steps": [{"name": "Preserve existing entitlements and set new signup default", "sql": "\n-- Existing accounts keep their promised detailed Quick Start actions.\nALTER TABLE orgs ADD COLUMN IF NOT EXISTS quick_start_action_preview BOOLEAN NOT NULL DEFAULT false;\nALTER TABLE orgs ALTER COLUMN quick_start_action_preview SET DEFAULT true;\n"}]});


schemaUpgrades.push({"name": "Durable measurement recovery and citation evidence", "from": "d9085cf644fac80194cdcbc8df62baf425f4554c492b97ed11a9ef6938994586", "to": "5c2db612cb4afed8c6e092ba5f55fe98ea9d8ef76eb1fc8a286d40ea3e1e83af", "steps": [{"name": "Add check ledger and preserve latest partial evidence", "sql": "-- Batch 47: durable check ledger, provider evidence and explicit partial collections.\nALTER TABLE measurement_batches DROP CONSTRAINT IF EXISTS measurement_batches_status_check;\nALTER TABLE measurement_batches ADD CONSTRAINT measurement_batches_status_check CHECK(status IN ('running','completed','failed','partial','interrupted'));\nALTER TABLE measurement_batches ADD COLUMN IF NOT EXISTS recovery_of BIGINT REFERENCES measurement_batches(id);\nALTER TABLE measurement_batches ADD COLUMN IF NOT EXISTS failure_detail TEXT;\nALTER TABLE measurement_batches ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;\nCREATE UNIQUE INDEX IF NOT EXISTS measurement_recovery_once ON measurement_batches(recovery_of) WHERE recovery_of IS NOT NULL;\nCREATE TABLE IF NOT EXISTS measurement_checks (\n measurement_id BIGINT NOT NULL REFERENCES measurement_batches(id) ON DELETE CASCADE,\n prompt_id INTEGER NOT NULL REFERENCES prompts(id),\n engine TEXT NOT NULL,\n run_index INTEGER NOT NULL,\n question_text TEXT NOT NULL,\n state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','collected','no_answer','failed','interrupted','cancelled','unsupported','incomplete')),\n selected_run_id INTEGER REFERENCES runs(id),\n error TEXT,\n updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n PRIMARY KEY(measurement_id,prompt_id,engine,run_index)\n);\nCREATE TABLE IF NOT EXISTS provider_attempts (\n id TEXT PRIMARY KEY,\n measurement_id BIGINT NOT NULL,\n prompt_id INTEGER NOT NULL,\n engine TEXT NOT NULL,\n run_index INTEGER NOT NULL,\n started_at TIMESTAMPTZ NOT NULL DEFAULT now(),\n completed_at TIMESTAMPTZ,\n request JSONB NOT NULL,\n response JSONB,\n provider_request_id TEXT,\n http_status INTEGER,\n error TEXT,\n cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,\n FOREIGN KEY(measurement_id,prompt_id,engine,run_index) REFERENCES measurement_checks(measurement_id,prompt_id,engine,run_index)\n);\nCREATE INDEX IF NOT EXISTS provider_attempt_slot ON provider_attempts(measurement_id,prompt_id,engine,run_index);\nALTER TABLE runs ADD COLUMN IF NOT EXISTS citation_evidence JSONB;\nALTER TABLE citations ADD COLUMN IF NOT EXISTS original_url TEXT;\nALTER TABLE citations ADD COLUMN IF NOT EXISTS title TEXT;\nALTER TABLE citations ADD COLUMN IF NOT EXISTS resolution_status TEXT;\nALTER TABLE citations ADD COLUMN IF NOT EXISTS metadata JSONB;\n-- Every ledger slot selects at most one answer. Old attempts remain in runs.\nCREATE OR REPLACE VIEW measurement_answers AS\n SELECT c.measurement_id,c.selected_run_id AS run_id FROM measurement_checks c WHERE c.selected_run_id IS NOT NULL\n UNION\n SELECT r.measurement_id,r.id AS run_id FROM runs r WHERE r.measurement_id IS NOT NULL\n AND NOT EXISTS(SELECT 1 FROM measurement_checks c WHERE c.measurement_id=r.measurement_id)\n UNION\n SELECT m.measurement_id,m.run_id FROM measurement_members m\n WHERE NOT EXISTS(SELECT 1 FROM measurement_checks c WHERE c.measurement_id=m.measurement_id);\n-- The current daily sample includes partial attempts, with status exposed to readers.\n-- Empty rejected re-asks must not hide a real measurement.\nCREATE OR REPLACE VIEW published_measurements AS\n SELECT DISTINCT ON (b.project_id,b.cycle_date) b.* FROM measurement_batches b\n WHERE b.purpose='monitoring' AND (b.status='completed' OR\n (b.status IN ('partial','failed','interrupted') AND EXISTS(SELECT 1 FROM measurement_answers a WHERE a.measurement_id=b.id)))\n ORDER BY b.project_id,b.cycle_date,b.started_at DESC,b.id DESC;\nCREATE OR REPLACE VIEW reporting_runs AS\n SELECT r.* FROM published_measurements b JOIN measurement_checks c ON c.measurement_id=b.id\n JOIN runs r ON r.id=c.selected_run_id AND r.project_id=b.project_id\n UNION ALL\n SELECT r.* FROM published_measurements b JOIN runs r ON r.measurement_id=b.id AND r.project_id=b.project_id\n WHERE NOT EXISTS(SELECT 1 FROM measurement_checks c WHERE c.measurement_id=b.id)\n UNION ALL\n SELECT r.* FROM published_measurements b JOIN measurement_members m ON m.measurement_id=b.id\n JOIN runs r ON r.id=m.run_id AND r.project_id=b.project_id\n WHERE r.measurement_id IS DISTINCT FROM b.id AND NOT EXISTS(SELECT 1 FROM measurement_checks c WHERE c.measurement_id=b.id);\n"}]});

schemaUpgrades.push({
  name: 'Usage-only access',
  from: '5c2db612cb4afed8c6e092ba5f55fe98ea9d8ef76eb1fc8a286d40ea3e1e83af',
  to: 'd9bf5831a308cca3061c89727cef3e05827d1313766734c8cecda44205d98f49',
  steps: [{name: 'Add the user billing flag', sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS unmetered_usage BOOLEAN NOT NULL DEFAULT false;'}]
});
