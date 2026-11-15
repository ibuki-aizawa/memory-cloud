# 運用

記憶の中身の確認、バックアップ、トークンの交換、困ったときの対処です。
コマンドはどれも `memory-mcp-worker/` で実行します。PowerShell / bash / zsh のどれでも同じように使えます。

## 記憶の中身を確認・修正する

AI を通さずに、直接データベースを操作できます。

```sh
# プロジェクト myapp のエンティティ一覧
npx wrangler d1 execute memory-mcp --remote --command "SELECT name, entity_type, updated_at FROM entities WHERE scope='p:myapp' ORDER BY updated_at DESC"

# observation の書き換え
npx wrangler d1 execute memory-mcp --remote --command "UPDATE observations SET content='[2026-11-15 owner] 概要: ○○' WHERE content LIKE '%概要: (1文で目的を書く)%'"
```

データベース上のスコープの値は、共通が `global`、プロジェクトが `p:<略称>` です。
テーブルの定義は [`memory-mcp-worker/schema.sql`](../memory-mcp-worker/schema.sql) にあります。

## サーバーを新しい版にする

リポジトリを更新（`git pull`）したら、データベースの変更を適用してからデプロイします。

```sh
npm install
npm run db:export         # 念のためバックアップ
npm run db:migrate        # データベースの変更を適用（適用済みのものは飛ばす）
npm run deploy
```

新しい機能を AI ツールでも使うために、各 PC で README の手順 2 のスクリプトを再実行してください。

## エージェントのトークン

AI ツールごとのトークンの発行・一覧・失効は [agents.md](agents.md) を見てください。

## バックアップ

```sh
npm run db:export         # backup.sql に書き出し（.gitignore 済み。git にはコミットしない）
```

## トークンを交換する

README の「1. サーバーを用意する」の「トークンを設定する」をやり直し、各 PC で「2. PC の AI ツールをつなぐ」のスクリプトを再実行します。

## ログを見る

```sh
npx wrangler tail
```

サーバーへのリクエストやエラーをリアルタイムに表示します。

## テスト

```sh
npm test                  # 記憶の読み書きのテスト（Node.js 22.5 以上）
npm run test:oauth        # OAuth のテスト。ローカルでサーバーを起動するので 1 分ほどかかる（Cloudflare には接続しない）
```

## 困ったとき

| 症状 | 対処 |
|---|---|
| Claude Code の `/mcp` で memory-project が failed | ターミナルを開き直して環境変数を反映する。URL が表示されるか確認（PowerShell は `$env:MEMORY_URL`、bash / zsh は `echo $MEMORY_URL`） |
| Cursor / VS Code / Windsurf でつながらない | エディターを完全に終了してから起動し直す（起動中のエディターには新しい環境変数が反映されない） |
| Codex でプロジェクトの memory-project が出ない | プロジェクトを trusted にする。`.codex/config.toml` の URL が `{{MEMORY_URL}}` のままなら `init-project.ps1` を再実行 |
| 設定ファイルを壊してしまった | スクリプトが残した `<ファイル名>.bak` から戻す |
| デプロイで D1 や KV のエラー | `wrangler.jsonc` の `database_id` / `id` が自分の値になっているか確認（README の「1. サーバーを用意する」） |
| 401 Unauthorized | トークンの不一致か失効。管理者トークンなら `wrangler secret put` した値と見比べ、エージェントのトークンなら `agent-token.ps1 list` で有効か確認する |
| `no such column: created_by` などのエラー | データベースの変更が未適用。`npm run db:migrate` を実行する |
| 404 | URL の誤り。`/mcp/global` か `/mcp/p/<略称>` か確認する。略称は英小文字・数字・ハイフンのみ |
| D1 の上限エラー | 無料枠（1 日 読み取り 500 万行 / 書き込み 10 万行）の超過。UTC 0 時（日本時間 9 時）に回復 |

## セキュリティ

- `workers.dev` の URL は誰でもアクセスできます。守っているのは認証だけなので、トークンは git にコミットしないでください
- Claude Code の `memory-global` の登録情報（トークンを含む）は、各 PC の `~/.claude.json` に保存されます。
  ほかのツールの設定ファイルにはトークンは入らず、ユーザー環境変数 `MEMORY_TOKEN` を参照します
- 記憶の中身は AI がそのまま読みます。他人に書き込ませたり、信頼できない文章をそのまま記憶させたりしないでください
