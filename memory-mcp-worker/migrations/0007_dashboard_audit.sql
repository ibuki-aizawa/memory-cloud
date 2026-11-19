-- 確認画面から行った変更の記録（誰が・いつ・何を）。OSS 版の確認画面は管理者だけが使うので、操作した人は owner
CREATE TABLE IF NOT EXISTS dashboard_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,                  -- 操作の種類（obs_edit、task_edit など）
  scope      TEXT,                           -- 対象のスコープ（エージェントの呼び名など、スコープのないものは NULL）
  target     TEXT,                           -- 対象（エンティティ名、タスク番号など）
  detail     TEXT,                           -- 変更の中身（書き換え前の値を含む。戻すときの手がかり）
  ip         TEXT,                           -- 操作したブラウザの接続元（CF-Connecting-IP）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
