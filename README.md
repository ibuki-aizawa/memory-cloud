# memory-cloud — Cloudflare Workers + D1 で動く AI エージェントの共有メモリ

server-memory と同じツール（`create_entities` / `search_nodes` / `open_nodes` など）を、
Cloudflare 上のリモート MCP サーバー（Streamable HTTP）として動かします。
どの PC・どのエージェントからでも同じ記憶を使えます。

```
memory-mcp-worker/   Cloudflare にデプロイするサーバー本体
client/              PC ごとの接続設定・jsonl 移行スクリプト
memory-kit/          プロジェクトにコピーするテンプレート（AGENTS.md / 各クライアントの MCP 設定 / エージェント定義）
```

## 対応クライアント

MCP の Streamable HTTP に対応し、`Authorization` ヘッダーを設定できるクライアントなら使えます。
次のクライアントは `setup-client.ps1` と `memory-kit/` で設定できます。

| クライアント | ユーザー設定（memory-global） | プロジェクト設定（memory-project） | 記憶のルールを読むファイル |
|---|---|---|---|
| Claude Code | `~/.claude.json`（`claude mcp add`） | `.mcp.json` | `~/.claude/CLAUDE.md`、`CLAUDE.md`（→ `AGENTS.md`） |
| Codex CLI | `~/.codex/config.toml` | `.codex/config.toml` | `~/.codex/AGENTS.md`、`AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` | `~/.gemini/GEMINI.md`、`AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | User Rules（手動で貼り付け）、`AGENTS.md` |
| VS Code（Copilot） | `<ユーザーフォルダ>/mcp.json` | `.vscode/mcp.json` | `<ユーザーフォルダ>/prompts/memory-global.instructions.md`、`AGENTS.md` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | （なし。ユーザー設定に追加する） | `~/.codeium/windsurf/memories/global_rules.md`、`AGENTS.md` |

サーバーは接続時（`initialize`）にスコープごとの使い方を `instructions` として返すので、
ルールファイルを読まないクライアントでも最低限の使い方は伝わります。

対応していないもの:
- **stdio にしか対応していないクライアント**: [mcp-remote](https://www.npmjs.com/package/mcp-remote) を挟めば使えます（[後述](#ほかのクライアントでの設定)）
- **claude.ai / ChatGPT などの Web 版コネクタ**: OAuth 認証が必要なため、今のところ使えません

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

前提: Node.js 20 以上、PowerShell 7、上の表の AI クライアントのどれか。

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

# 設定するクライアントを指定する場合（省略時はインストール済みのものを自動で検出）
pwsh ./client/setup-client.ps1 -Url $url -Token $token -Clients claude, codex, cursor
```

環境変数 `MEMORY_URL` / `MEMORY_TOKEN` の保存、各クライアントへの `memory-global` の登録、共通ナレッジの初期データ投入、
各クライアントのユーザー共通ルール（`~/.claude/CLAUDE.md` など）への追記を行います。
**終わったらターミナルと各エディターを開き直してください**（環境変数を反映するため）。

- 何度実行しても問題ありません。書き換えた設定ファイルは `<ファイル名>.bak` に元の内容が残ります
- JSON の設定ファイルは書き直すため、ファイル内のコメントは消えます（`.bak` には残ります）
- Claude Code 以外の設定ファイルにはトークンを書かず、環境変数 `MEMORY_TOKEN` を参照させます
- Cursor のユーザー共通ルールはファイルに置けないため、`client/templates/user-memory-rules.md` の内容を
  Cursor Settings > Rules の User Rules に貼り付けてください

### 旧ローカル版（jsonl）からの移行（該当する場合のみ）

```powershell
pwsh ./client/import-jsonl.ps1 -Path "$HOME/.claude/memory/global.jsonl" -Scope global
pwsh ./client/import-jsonl.ps1 -Path <repo>/.claude/memory/project.jsonl -Scope <略称>
```

何度実行しても重複しません。移行後、旧ファイルと旧 `scripts/setup-memory.ps1` は削除して構いません。
`~/.claude/settings.json` に残っている read_graph の禁止設定は、そのままで問題ありません（このサーバーには read_graph がありません）。

---

## プロジェクトへの導入（プロジェクトごとに 1 回）

1. `memory-kit/` の中身をリポジトリにコピーする。必須なのは `AGENTS.md` と `scripts/`。
   あとは使うクライアントの分だけコピーします。

   | クライアント | コピーするもの |
   |---|---|
   | Claude Code | `CLAUDE.md`、`.mcp.json`、`.claude/agents/` |
   | Codex CLI | `.codex/` |
   | Gemini CLI | `.gemini/` |
   | Cursor | `.cursor/` |
   | VS Code | `.vscode/mcp.json` |

   既に `AGENTS.md` や `CLAUDE.md` がある場合は、`AGENTS.md` の「記憶プロトコル」の節を既存の `AGENTS.md` に貼り付け、
   `CLAUDE.md` の先頭に `@AGENTS.md` の 1 行を追加します。
2. 実行する

   ```powershell
   pwsh ./scripts/init-project.ps1 -Slug myapp
   ```

3. コピーしたファイルを git にコミットする

記憶のルールは `AGENTS.md` にまとめてあり、Claude Code は `CLAUDE.md` の `@AGENTS.md` から読み込みます。
ルールを変えるときは `AGENTS.md` だけを直してください。Claude Code 専用の指示（サブエージェントなど）は `CLAUDE.md` に書きます。

各設定ファイルはトークンを環境変数（`MEMORY_TOKEN`）から読むので、コミットしても安全です。
ただし `.codex/config.toml` には Worker の URL がそのまま書き込まれます（Codex は URL に環境変数を使えないため）。
URL だけではアクセスできませんが、公開リポジトリで URL を伏せたい場合は `.codex/` をコミットせず、各自のユーザー設定に追加してください。

### 新しい PC・新しい参加者

`setup-client.ps1` を実行済みなら、リポジトリを clone してエージェントを起動するだけです。
初回はプロジェクトのサーバーを使うか確認されるクライアントがあるので、許可してください。
Codex CLI はプロジェクトを trusted にしたときだけ `.codex/config.toml` を読みます。

---

## ほかのクライアントでの設定

`setup-client.ps1` を使わずに手で設定する場合や、表にないクライアントの場合の例です。
どれも URL は `<MEMORY_URL>/mcp/global`（共通）か `<MEMORY_URL>/mcp/p/<略称>`（プロジェクト）、
ヘッダーは `Authorization: Bearer <MEMORY_TOKEN>` です。

**Codex CLI**（`~/.codex/config.toml`）

```toml
[mcp_servers.memory-global]
url = "https://memory-mcp.<サブドメイン>.workers.dev/mcp/global"
bearer_token_env_var = "MEMORY_TOKEN"
```

**Gemini CLI**（`~/.gemini/settings.json`）

```json
{
  "mcpServers": {
    "memory-global": {
      "httpUrl": "${MEMORY_URL}/mcp/global",
      "headers": { "Authorization": "Bearer ${MEMORY_TOKEN}" }
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json`）／ **Windsurf**（`~/.codeium/windsurf/mcp_config.json`、`url` を `serverUrl` にする）

```json
{
  "mcpServers": {
    "memory-global": {
      "url": "${env:MEMORY_URL}/mcp/global",
      "headers": { "Authorization": "Bearer ${env:MEMORY_TOKEN}" }
    }
  }
}
```

**VS Code**（コマンドパレット「MCP: Open User Configuration」で開く `mcp.json`）

```json
{
  "servers": {
    "memory-global": {
      "type": "http",
      "url": "${env:MEMORY_URL}/mcp/global",
      "headers": { "Authorization": "Bearer ${env:MEMORY_TOKEN}" }
    }
  }
}
```

**stdio にしか対応していないクライアント**（Claude Desktop など）: mcp-remote で中継します。

```json
{
  "mcpServers": {
    "memory-global": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://memory-mcp.<サブドメイン>.workers.dev/mcp/global",
               "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <MEMORY_TOKEN>" }
    }
  }
}
```

（`Authorization:` の後ろに空白を入れないのは、Windows で引数が分割されるのを避けるためです）

**ルールの設定**: 表にないクライアントは、そのクライアントのユーザー共通ルールに
`client/templates/user-memory-rules.md` の内容を、プロジェクトのルールに `AGENTS.md` の内容を設定してください。

---

## 運用

**中身の確認や手直し**（AI のトークンを使いません）

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
| Cursor / VS Code / Windsurf でつながらない | エディターを完全に終了してから起動し直す（起動中のエディターには新しい環境変数が反映されない） |
| Codex でプロジェクトの memory-project が出ない | プロジェクトを trusted にする。`.codex/config.toml` の URL が `{{MEMORY_URL}}` のままなら `init-project.ps1` を再実行 |
| 設定ファイルを壊してしまった | `setup-client.ps1` が残した `<ファイル名>.bak` から戻す |
| 401 Unauthorized | トークンの不一致。`wrangler secret put` した値と環境変数を見比べる |
| 404 | URL の誤り。略称は英小文字・数字・ハイフンのみ |
| D1 の上限エラー | 無料枠（1 日 読み取り 500 万行 / 書き込み 10 万行）の超過。UTC 0 時（日本時間 9 時）に回復 |

## セキュリティ

- `workers.dev` の URL は誰でもアクセスできます。守りはトークンだけなので、トークンは git にコミットしないでください。
- Claude Code の `memory-global` の登録情報（トークンを含む）は各 PC の `~/.claude.json` に保存されます。
  ほかのクライアントの設定ファイルにはトークンは入らず、ユーザー環境変数 `MEMORY_TOKEN` を参照します。
