-- エージェントの識別（エージェントごとのトークンと、書き手の記録）
-- 適用: npm run db:migrate（wrangler が適用済みのものを記録するので、何度実行しても 1 回だけ適用されます）

CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,               -- 例: claude-code-mypc, codex-mypc
  token_hash  TEXT NOT NULL UNIQUE,           -- トークンの SHA-256（トークン自体は保存しない）
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT                            -- 失効させた日時。NULL なら有効
);

-- 書き手（サーバーが認証結果から記録する。既存の行は NULL = 不明）
ALTER TABLE entities     ADD COLUMN created_by TEXT;
ALTER TABLE observations ADD COLUMN author     TEXT;
ALTER TABLE relations    ADD COLUMN created_by TEXT;
