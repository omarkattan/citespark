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
