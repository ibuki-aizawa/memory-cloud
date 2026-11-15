# エージェントの識別

複数の AI（Claude Code、Codex など）が同じ記憶を使うとき、「どの AI が書いたか」を区別するしくみです。
マルチエージェントで協調させるための土台になります。

## しくみ

AI ツールごとに専用のトークン（`mca_` で始まる）を発行し、サーバーはトークンから書き手を判断します。

| 接続のしかた | サーバーが記録する書き手 |
|---|---|
| エージェントのトークン | 発行時の名前（例: `claude-mypc`、`codex-mypc`） |
| 管理者トークン（`MEMORY_TOKEN`） | `owner` |
| OAuth（GitHub でログイン） | `github:<ユーザー名>` |

- エンティティ・observation・リレーションを書き込むと、サーバーが書き手と日時を自動で記録します
- AI は `whoami` ツールで自分の名前を確認できます。記憶のルールでは、observation の `[日付 書き手]` にこの名前を使います
- 誰が書いたかを読むには、`open_nodes` に `withAuthors: true` を付けます（既定では、AI の利用量を抑えるため返しません）
- サーバーにはトークンのハッシュだけを保存します。トークン自体は発行したときにしか表示されません

## 発行のしかた

README の手順 2（`setup-client.ps1`）を実行すると、この PC の AI ツールごとに `<ツール>-<PC 名>` という名前で自動発行されます。
トークンは `MEMORY_TOKEN_CLAUDE`、`MEMORY_TOKEN_CODEX` のような環境変数に保存され、各ツールの設定はそれを参照します。
もう一度実行すると、トークンは発行し直されます（古いトークンは使えなくなります）。

すべてのツールで管理者トークンを使う、これまでの方式にしたい場合は `-SharedToken` を付けます。

## 手で管理する

別の PC、CI、手で設定するツールなどのトークンは `agent-token.ps1` で管理します（PowerShell / bash / zsh 共通）。
環境変数 `MEMORY_URL` と `MEMORY_TOKEN`（管理者トークン）が必要です。

```sh
pwsh ./client/agent-token.ps1 new codex-ci      # 発行（同じ名前なら発行し直し）。トークンは一度だけ表示される
pwsh ./client/agent-token.ps1 list              # 一覧
pwsh ./client/agent-token.ps1 revoke codex-ci   # 失効
```

エージェント名に使えるのは、英小文字・数字・`.` `_` `-` です（63 文字まで）。

スクリプトを使わない場合は、HTTP で直接操作できます。

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "$env:MEMORY_URL/admin/agents" `
  -Headers @{ Authorization = "Bearer $env:MEMORY_TOKEN" } -ContentType 'application/json' `
  -Body '{"name":"codex-ci"}'
```

bash / zsh:

```sh
curl -X POST "$MEMORY_URL/admin/agents" \
  -H "Authorization: Bearer $MEMORY_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"codex-ci"}'
```

| 操作 | リクエスト |
|---|---|
| 一覧 | `GET /admin/agents` |
| 発行 | `POST /admin/agents`（本文 `{"name": "..."}`） |
| 失効 | `DELETE /admin/agents/<名前>` |

`/admin/` は管理者トークンでしか使えません。

## 注意

- これは「誰が書いたか」を区別するためのしくみで、エージェントごとに読み書きできる範囲を制限するものではありません
  （どのエージェントも、共通とすべてのプロジェクトの記憶を読み書きできます）
- 管理者トークンは各 PC の環境変数 `MEMORY_TOKEN` にも保存されています（導入スクリプトが使うため）
- この機能を入れる前に書かれた記憶は、書き手が空（不明）になります
