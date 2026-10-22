export const PROJECT_TASK_WORKFLOW_SQL = `
CREATE TABLE IF NOT EXISTS project_task_homes (
  project_id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS project_task_items (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, document_path TEXT NOT NULL,
  current_revision TEXT NOT NULL, approved_revision TEXT,
  phase TEXT NOT NULL DEFAULT 'draft', archived INTEGER NOT NULL DEFAULT 0,
  exported_sequence INTEGER NOT NULL DEFAULT 0, export_error TEXT,
  PRIMARY KEY(project_id, task_id)
);
CREATE TABLE IF NOT EXISTS project_task_attempts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
  revision TEXT NOT NULL, native_task_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_project_task_attempts_task ON project_task_attempts(project_id,task_id,created_at);
CREATE TABLE IF NOT EXISTS project_task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, revision TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_project_task_events_task ON project_task_events(project_id,task_id,sequence);
CREATE TRIGGER IF NOT EXISTS trg_project_task_document_discovered AFTER INSERT ON project_task_items
BEGIN
  INSERT OR IGNORE INTO project_task_events(event_key,project_id,task_id,revision,kind,detail)
  VALUES ('document:' || NEW.project_id || ':' || NEW.task_id || ':' || NEW.current_revision || ':' || NEW.document_path,
    NEW.project_id,NEW.task_id,NEW.current_revision,'document.indexed',NEW.document_path);
END;
CREATE TRIGGER IF NOT EXISTS trg_project_task_document_changed AFTER UPDATE OF current_revision,document_path ON project_task_items
WHEN OLD.current_revision<>NEW.current_revision OR OLD.document_path<>NEW.document_path
BEGIN
  INSERT OR IGNORE INTO project_task_events(event_key,project_id,task_id,revision,kind,detail)
  VALUES ('document:' || NEW.project_id || ':' || NEW.task_id || ':' || NEW.current_revision || ':' || NEW.document_path,
    NEW.project_id,NEW.task_id,NEW.current_revision,'document.changed',NEW.document_path);
END;
CREATE TRIGGER IF NOT EXISTS trg_project_task_native_status AFTER UPDATE OF status ON tasks
WHEN OLD.status <> NEW.status
BEGIN
  INSERT OR IGNORE INTO project_task_events(event_key,project_id,task_id,revision,kind,detail)
  SELECT 'native-task:' || NEW.id || ':' || NEW.status, project_id,task_id,revision,
    'attempt.' || NEW.status, 'Runtime task status: ' || NEW.status
  FROM project_task_attempts WHERE native_task_id = NEW.id;
  UPDATE project_task_items SET phase = 'review'
  WHERE NEW.status = 'completed' AND EXISTS (
    SELECT 1 FROM project_task_attempts a WHERE a.native_task_id = NEW.id
    AND a.project_id = project_task_items.project_id AND a.task_id = project_task_items.task_id
  ) AND phase = 'active';
END;
CREATE TRIGGER IF NOT EXISTS trg_project_task_worker_state AFTER UPDATE OF state ON worker_dispatches
WHEN OLD.state <> NEW.state
BEGIN
  INSERT OR IGNORE INTO project_task_events(event_key,project_id,task_id,revision,kind,detail)
  SELECT 'native-worker:' || NEW.dispatch_id || ':' || NEW.state, a.project_id,a.task_id,a.revision,
    'worker.' || NEW.state, 'Runtime worker state: ' || NEW.state
  FROM project_task_attempts a JOIN dispatch_contexts d ON d.task_id = a.native_task_id
  WHERE d.id = NEW.dispatch_id;
END;
`
