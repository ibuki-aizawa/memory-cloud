# memory-cloud — Cloudflare Workers + D1 で動く Claude Code の共有メモリ

server-memory と同じツール（`create_entities` / `search_nodes` / `open_nodes` など）を、
Cloudflare 上のリモート MCP サーバーとして動かします。どの PC・どのエージェントからでも同じ記憶を使えます。

```
memory-mcp-worker/   Cloudflare にデプロイするサーバー本体
client/              PC ごとの接続設定・jsonl 移行スクリプト
memory-kit/          プロジェクトにコピーするテンプレート（CLAUDE.md / .mcp.json / エージェント定義）
```

## AWS との対応

| Cloudflare | AWS でいうと | 役割 |
|---|---|---|
| Workers | Lambda + 関数 URL | MCP サーバー本体（URL は `*.workers.dev`） |
| D1 | サーバーレスの SQLite（課金は行数単位） | 記憶の保存先 |
| wrangler | SAM CLI / CDK CLI | デプロイ・DB 操作の CLI |
| `wrangler secret` | Lambda の暗号化環境変数 / Secrets Manager | トークンの保管 |
| `wrangler.jsonc` | SAM テンプレート | 設定ファイル |

Free プランはクレジットカード不要で、上限に達するとリクエストが失敗するだけです。AWS のように想定外の請求が来ることはありません。

## スコープと URL

| URL | 用途 | Claude Code での名前 |
|---|---|---|
| `/mcp/global` | プロジェクト横断の共通ナレッジ | `memory-global`（user スコープ） |
| `/mcp/p/<略称>` | プロジェクトごとのナレッジ | `memory-project`（プロジェクトの `.mcp.json`） |

---

## 初回セットアップ（全体で 1 回）

前提: Node.js 20 以上、PowerShell 7、Claude Code。

### 1. Cloudflare のアカウントを作る

https://dash.cloudflare.com/sign-up でメールアドレスを登録し、確認メールのリンクを開きます。
ドメインの追加を勧められても不要です（スキップしてください）。

### 2. wrangler を入れてログインする

```powershell
cd memory-mcp-worker
npm install -D wrangler@latest
npx wrangler login        # ブラウザが開くので「Allow」
npx wrangler whoami       # アカウント名が出れば OK
```

### 3. データベースを作る

```powershell
npx wrangler d1 create memory-mcp
```

出力に表示される `database_id` を `wrangler.jsonc` の `REPLACE_WITH_YOUR_DATABASE_ID` に貼り付けます。
「設定ファイルに自動で追加するか」と聞かれたら **No** を選んでください（バインディング名を `DB` にするため）。

```powershell
npm run db:init           # テーブルを作成
npx wrangler d1 execute memory-mcp --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

`entities` / `observations` / `relations` が表示されれば OK です。

### 4. デプロイする

```powershell
npm test                  # （任意）ローカルテスト。Node.js 22.5 以上
npm run deploy
```

初回は `workers.dev` のサブドメイン名を決めるよう求められます。
最後に表示される `https://memory-mcp.<サブドメイン>.workers.dev` を控えてください。

### 5. トークンを設定する

```powershell
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$token | npx wrangler secret put MEMORY_TOKEN
$token                    # 表示された値をパスワードマネージャーなどに保管
```

パイプで渡せない場合は `npx wrangler secret put MEMORY_TOKEN` を実行し、表示されたプロンプトに貼り付けます。

### 6. 動作確認

```powershell
$url = 'https://memory-mcp.<サブドメイン>.workers.dev'
Invoke-RestMethod -Method Post -Uri "$url/mcp/global" `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' |
  ForEach-Object { $_.result.tools.name }
```

8 つのツール名が表示されれば成功です。

---

## PC ごとのセットアップ

```powershell
pwsh ./client/setup-client.ps1 -Url $url -Token $token
```

環境変数 `MEMORY_URL` / `MEMORY_TOKEN` の保存、`memory-global` の登録、共通ナレッジの初期データ投入、
`~/.claude/CLAUDE.md` への追記を行います。**終わったらターミナルを開き直してください。**

### 旧ローカル版（jsonl）からの移行（該当する場合のみ）

```powershell
pwsh ./client/import-jsonl.ps1 -Path "$HOME/.claude/memory/global.jsonl" -Scope global
pwsh ./client/import-jsonl.ps1 -Path <repo>/.claude/memory/project.jsonl -Scope <略称>
```

何度実行しても重複しません。移行後、旧ファイルと旧 `scripts/setup-memory.ps1` は削除して構いません。
`~/.claude/settings.json` に残っている read_graph の禁止設定は、そのままで問題ありません（このサーバーには read_graph がありません）。

---

## プロジェクトへの導入（プロジェクトごとに 1 回）

1. `memory-kit/` の中身（`CLAUDE.md`、`.mcp.json`、`.claude/agents/`、`scripts/`）をリポジトリにコピーする
   （既に CLAUDE.md がある場合は「記憶プロトコル」の節だけを貼り付ける）
2. 実行する

   ```powershell
   pwsh ./scripts/init-project.ps1 -Slug myapp
   ```

3. `CLAUDE.md`、`.mcp.json`、`.claude/` を git にコミットする

`.mcp.json` はトークンを環境変数で参照する（`${MEMORY_TOKEN}`）ので、コミットしても安全です。

### 新しい PC・新しい参加者

`setup-client.ps1` を実行済みなら、リポジトリを clone して Claude Code を起動するだけです。
初回だけ `.mcp.json` のサーバーを使うか確認されるので、許可してください。

---

## 運用

**中身の確認や手直し**（Claude のトークンを使いません）

```powershell
# プロジェクト myapp のエンティティ一覧
npx wrangler d1 execute memory-mcp --remote --command "SELECT name, entity_type, updated_at FROM entities WHERE scope='p:myapp' ORDER BY updated_at DESC"

# observation の書き換え
npx wrangler d1 execute memory-mcp --remote --command "UPDATE observations SET content='[2026-11-15 owner] 概要: ○○' WHERE content LIKE '%概要: (1文で目的を書く)%'"
```

スコープの値は、共通が `global`、プロジェクトが `p:<略称>` です。

**バックアップ**

```powershell
npm run db:export         # backup.sql に書き出し（git にはコミットしない）
```

**トークンの交換**: 手順 5 を再実行し、各 PC で `setup-client.ps1` を再実行します。

**ログの確認**: `npx wrangler tail` でリクエストをリアルタイムに表示できます。

## 困ったとき

| 症状 | 対処 |
|---|---|
| `/mcp` で memory-project が failed | ターミナルを開き直して環境変数を反映。`$env:MEMORY_URL` が表示されるか確認 |
| 401 Unauthorized | トークンの不一致。`wrangler secret put` した値と環境変数を見比べる |
| 404 | URL の誤り。略称は英小文字・数字・ハイフンのみ |
| D1 の上限エラー | 無料枠（1 日 読み取り 500 万行 / 書き込み 10 万行）の超過。UTC 0 時（日本時間 9 時）に回復 |

## セキュリティ

- `workers.dev` の URL は誰でもアクセスできます。守りはトークンだけなので、トークンは git にコミットしないでください。
- `memory-global` の登録情報（トークンを含む）は各 PC の `~/.claude.json` に保存されます。
