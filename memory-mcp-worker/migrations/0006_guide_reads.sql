-- 本人確認名・scope ごとに最後に読んだガイド版を記録する
-- 適用: npm run db:migrate
CREATE TABLE IF NOT EXISTS guide_reads (
  identity   TEXT NOT NULL,
  scope      TEXT NOT NULL,
  version    TEXT NOT NULL,
  read_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity, scope)
);