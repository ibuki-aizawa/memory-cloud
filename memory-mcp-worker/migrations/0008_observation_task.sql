-- observation を得たタスク（任意）。「どの作業で得た知識か」をあとからたどるため
ALTER TABLE observations ADD COLUMN task_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_observations_task ON observations (task_id);
