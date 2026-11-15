-- マルチエージェントの協調（タスクボードと受信箱）
-- 適用: npm run db:migrate

-- タスク。担当（assignee）には期限（lease_expires_at）があり、期限が切れたら別のエージェントが引き受けられる
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scope            TEXT NOT NULL,                  -- 'global' または 'p:<プロジェクト略称>'
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | review | done | cancelled
  assignee         TEXT,                           -- 担当のエージェント名。NULL なら未担当
  lease_expires_at TEXT,                           -- 担当の期限（UTC, datetime 形式）
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_scope_status ON tasks (scope, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee, status);

-- タスクの経過（作成・引き受け・進捗メモ・引き継ぎなど）
CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id),
  actor      TEXT,
  kind       TEXT NOT NULL,                        -- created | claimed | updated | handoff | released
  status     TEXT,                                 -- この出来事のあとの状態
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, id);

-- エージェント間のメッセージ（受信箱）
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL,
  to_agent   TEXT NOT NULL,
  from_agent TEXT,
  body       TEXT NOT NULL,
  task_id    INTEGER REFERENCES tasks (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages (scope, to_agent, read_at, id);
