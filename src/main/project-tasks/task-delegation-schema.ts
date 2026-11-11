export const PROJECT_TASK_DELEGATION_SQL = `
CREATE TABLE IF NOT EXISTS project_task_delegation_policy (
  project_id TEXT PRIMARY KEY REFERENCES project_task_homes(project_id),
  generation INTEGER NOT NULL, grant_json TEXT
);
CREATE TABLE IF NOT EXISTS project_task_delegation_proposals (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project_task_homes(project_id),
  issuer TEXT NOT NULL, connection_id TEXT NOT NULL, digest TEXT NOT NULL,
  grant_json TEXT, binding_json TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_task_delegation_mutations (
  project_id TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
  actor TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
  PRIMARY KEY(project_id,operation,request_id)
);
CREATE TABLE IF NOT EXISTS project_task_delegation_audit (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, operation TEXT NOT NULL,
  actor TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS project_task_delegated_plans (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  revision TEXT NOT NULL, generation INTEGER NOT NULL, grant_digest TEXT NOT NULL,
  actor TEXT NOT NULL, run_id TEXT,
  FOREIGN KEY(project_id,task_id) REFERENCES project_task_items(project_id,task_id)
);
CREATE TABLE IF NOT EXISTS project_task_admissions (
  attempt_id TEXT PRIMARY KEY REFERENCES project_task_attempts(id),
  source TEXT NOT NULL, receipt_id TEXT, binding_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation INTEGER
);
CREATE TABLE IF NOT EXISTS project_task_results (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES project_task_attempts(id),
  digest TEXT NOT NULL UNIQUE, evidence_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_task_review_assignments (
  id TEXT PRIMARY KEY, result_digest TEXT NOT NULL REFERENCES project_task_results(digest),
  reviewer_attempt_id TEXT NOT NULL REFERENCES project_task_attempts(id),
  actor_json TEXT NOT NULL, assigned_by TEXT NOT NULL, reviewer_dispatch_id TEXT,
  UNIQUE(result_digest,reviewer_attempt_id)
);
CREATE TABLE IF NOT EXISTS project_task_reviews (
  id TEXT PRIMARY KEY, result_digest TEXT NOT NULL REFERENCES project_task_results(digest),
  reviewer_attempt_id TEXT NOT NULL REFERENCES project_task_attempts(id),
  verdict TEXT NOT NULL, report TEXT NOT NULL, digest TEXT NOT NULL, actor_json TEXT NOT NULL,
  review_result_digest TEXT NOT NULL REFERENCES project_task_results(digest), reviewer_dispatch_id TEXT
);
CREATE TABLE IF NOT EXISTS project_task_acceptances (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision TEXT NOT NULL,
  result_digest TEXT NOT NULL REFERENCES project_task_results(digest),
  review_id TEXT NOT NULL REFERENCES project_task_reviews(id),
  receipt_id TEXT PRIMARY KEY, related_json TEXT NOT NULL
);
`

const immutableDelegationTables = [
  'project_task_delegation_audit',
  'project_task_delegation_mutations',
  'project_task_delegated_plans',
  'project_task_admissions',
  'project_task_attempt_placements',
  'project_task_results',
  'project_task_review_assignments',
  'project_task_reviews',
  'project_task_acceptances'
] as const
export const PROJECT_TASK_DELEGATION_IMMUTABILITY_SQL = immutableDelegationTables
  .map(
    (table) => `
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT,'Delegation evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT,'Delegation evidence is immutable'); END;
`
  )
  .join('\n')
