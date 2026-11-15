-- Web の確認画面のログイン
-- 適用: npm run db:migrate

-- セッション。Cookie にはランダムな ID を入れ、ここにはそのハッシュだけを保存する（ログアウトで消せば、コピーされた Cookie も無効になる）
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  id_hash    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- ログインの試行回数（IP ごと、10 分の区切り）。1 回の UPDATE で数えるので、同時に送られても上限を超えない
CREATE TABLE IF NOT EXISTS dashboard_login_attempts (
  ip           TEXT PRIMARY KEY,
  attempts     INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
