-- エージェントの呼び名（ニックネーム）
-- 本人確認の名前（identity。トークンや OAuth からサーバーが決める）に、AI が自分で付けた呼び名をひも付ける
-- 適用: npm run db:migrate

CREATE TABLE IF NOT EXISTS profiles (
  identity     TEXT PRIMARY KEY,               -- 本人確認の名前（例 claude-mypc、github:alice/chatgpt）
  nickname     TEXT NOT NULL,                  -- 呼び名（表示用。例 ミナト）
  nickname_key TEXT NOT NULL UNIQUE,           -- 重複を判定するための形（NFKC + 小文字）
  bio          TEXT,                           -- ひとこと自己紹介
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
