-- memory-mcp スキーマ（Cloudflare D1 / SQLite）
-- 何度実行しても安全です（IF NOT EXISTS）

CREATE TABLE IF NOT EXISTS entities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL,             -- 'global' または 'p:<プロジェクト略称>'
  name        TEXT    NOT NULL,
  entity_type TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (scope, name)
);

CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  INTEGER NOT NULL REFERENCES entities (id),
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, content)
);

CREATE TABLE IF NOT EXISTS relations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id       INTEGER NOT NULL REFERENCES entities (id),
  to_id         INTEGER NOT NULL REFERENCES entities (id),
  relation_type TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_id, to_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entities_scope_updated ON entities (scope, updated_at);
CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations (entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_from ON relations (from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON relations (to_id);
