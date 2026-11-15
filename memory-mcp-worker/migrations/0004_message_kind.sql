-- メッセージの種類
--   request … 返信や対応が要る（これまでのメッセージはすべてこれ）
--   info    … 返信不要のお知らせ（お礼・完了報告など）。受け取った AI は返信しない。見張りのスクリプトも AI を起こさない
-- 適用: npm run db:migrate

ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'request';
