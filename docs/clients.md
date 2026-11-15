# AI ツールごとの設定

README の手順 2・3 のスクリプトが、どのファイルに何を書くかと、手で設定する方法の説明です。

## スクリプトが書き込む場所

| AI ツール | 共通の記憶の設定先 | プロジェクトの記憶の設定先 | ルールを読むファイル |
|---|---|---|---|
| Claude Code | `~/.claude.json`（`claude mcp add` で登録） | `.mcp.json` | `~/.claude/CLAUDE.md`、`CLAUDE.md`（→ `AGENTS.md`） |
| Codex CLI | `~/.codex/config.toml` | `.codex/config.toml` | `~/.codex/AGENTS.md`、`AGENTS.md` |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` | `~/.gemini/GEMINI.md`、`AGENTS.md` |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` | User Rules（手動で貼り付け）、`AGENTS.md` |
| VS Code（Copilot） | `<ユーザーフォルダ>/mcp.json` | `.vscode/mcp.json` | `<ユーザーフォルダ>/prompts/memory-global.instructions.md`、`AGENTS.md` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | （なし。共通の設定に追加する） | `~/.codeium/windsurf/memories/global_rules.md`、`AGENTS.md` |

`setup-client.ps1` について:
- 何度実行しても問題ありません。書き換えた設定ファイルは `<ファイル名>.bak` に元の内容が残ります
- JSON の設定ファイルは書き直すため、ファイル内のコメントは消えます（`.bak` には残ります）
- AI ツールごとに専用のトークンを発行し、`MEMORY_TOKEN_CLAUDE`、`MEMORY_TOKEN_CODEX` のような環境変数に保存します（[エージェントの識別](agents.md)）
- Claude Code 以外の設定ファイルにはトークンを書かず、その環境変数を参照させます
- 環境変数は、Windows ではユーザー環境変数に、macOS / Linux では `~/.memory-cloud.env` に保存します。macOS / Linux では `~/.zshrc`（bash なら `~/.bashrc`）にこのファイルを読み込む 1 行を追加してください（README の手順 2）
- macOS で Cursor や VS Code を Dock から起動すると、シェルの環境変数を読まないことがあります。ターミナルから `cursor .` / `code .` で起動してください
- Cursor のユーザー共通ルールはファイルに置けないため、`client/templates/user-memory-rules.md` の内容を
  Cursor Settings > Rules の User Rules に貼り付けてください

## プロジェクトの設定ファイルについて

- 記憶のルールは `AGENTS.md` にまとめてあります。`AGENTS.md` は多くの AI ツールが読む共通のルールファイルで、
  Claude Code は `CLAUDE.md` の `@AGENTS.md` の行から読み込みます。
  ルールを変えるときは `AGENTS.md` だけを直し、Claude Code 専用の指示（サブエージェントなど）は `CLAUDE.md` に書きます
- 既に `AGENTS.md` や `CLAUDE.md` があるプロジェクトでは、`memory-kit/AGENTS.md` の「記憶プロトコル」の節を既存の `AGENTS.md` に貼り付け、
  `CLAUDE.md` の先頭に `@AGENTS.md` の 1 行を追加します
- 各設定ファイルはトークンを環境変数から読むので、コミットしても安全です
- `.codex/config.toml` だけは記憶サーバーの URL がそのまま書き込まれます（Codex は URL に環境変数を使えないため）。
  URL だけではアクセスできませんが、公開リポジトリで URL を伏せたい場合は `.codex/` をコミットせず、各自のユーザー設定に追加してください
- Codex CLI は、プロジェクトを trusted（信頼済み）にしたときだけ `.codex/config.toml` を読みます

## 手で設定する

スクリプトを使わない場合や、表にないツールの場合の例です。
MCP の「Streamable HTTP」方式に対応したツールなら使えます。

どれも URL は `<サーバーの URL>/mcp/global`（共通）か `<サーバーの URL>/mcp/p/<略称>`（プロジェクト）、
ヘッダーは `Authorization: Bearer <トークン>` です。
トークンは、そのツール用に発行したもの（`pwsh ./client/agent-token.ps1 new <名前>`）を使います。
例の `${MEMORY_URL}` / `${MEMORY_TOKEN_CODEX}` などは、環境変数を参照する書き方です。

**Codex CLI**（`~/.codex/config.toml`）

```toml
[mcp_servers.memory-global]
url = "https://memory-mcp.<サブドメイン>.workers.dev/mcp/global"
bearer_token_env_var = "MEMORY_TOKEN_CODEX"
```

**Gemini CLI**（`~/.gemini/settings.json`）

```json
{
  "mcpServers": {
    "memory-global": {
      "httpUrl": "${MEMORY_URL}/mcp/global",
      "headers": { "Authorization": "Bearer ${MEMORY_TOKEN_GEMINI}" }
    }
  }
}
```

**Cursor**（`~/.cursor/mcp.json`）／ **Windsurf**（`~/.codeium/windsurf/mcp_config.json`、`url` を `serverUrl` に、変数を `MEMORY_TOKEN_WINDSURF` にする）

```json
{
  "mcpServers": {
    "memory-global": {
      "url": "${env:MEMORY_URL}/mcp/global",
      "headers": { "Authorization": "Bearer ${env:MEMORY_TOKEN_CURSOR}" }
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
      "headers": { "Authorization": "Bearer ${env:MEMORY_TOKEN_VSCODE}" }
    }
  }
}
```

**ローカルのコマンドとしてしか MCP サーバーを登録できないツール**（Claude Desktop の設定ファイルなど）:
[mcp-remote](https://www.npmjs.com/package/mcp-remote) で中継します。

```json
{
  "mcpServers": {
    "memory-global": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://memory-mcp.<サブドメイン>.workers.dev/mcp/global",
               "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <トークン>" }
    }
  }
}
```

（`Authorization:` の後ろに空白を入れないのは、Windows で引数が分割されるのを避けるためです）

**ルールの設定**: ツールのユーザー共通ルールに `client/templates/user-memory-rules.md` の内容を、
プロジェクトのルールに `memory-kit/AGENTS.md` の内容を設定してください。
サーバーは接続時に各スコープの使い方を AI に伝えるので、ルールを設定しなくても最低限の使い方はわかります。
