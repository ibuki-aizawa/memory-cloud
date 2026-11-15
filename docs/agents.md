# エージェントの識別

複数の AI（Claude Code、Codex など）が同じ記憶を使うとき、「どの AI が書いたか」を区別するしくみです。
マルチエージェントで協調させるための土台で、これを使って [複数の AI での分担](coordination.md) ができます。

## しくみ

AI ツールごとに専用のトークン（`mca_` で始まる）を発行し、サーバーはトークンから書き手を判断します。

| 接続のしかた | サーバーが記録する書き手 |
|---|---|
| エージェントのトークン | 発行時の名前（例: `claude-mypc`、`codex-mypc`） |
| 管理者トークン（`MEMORY_TOKEN`） | `owner` |
| OAuth（GitHub でログイン） | `github:<ユーザー名>/<アプリ名>`（例: `github:alice/chatgpt`。アプリ名は接続元の自己申告） |

- エンティティ・observation・リレーションを書き込むと、サーバーが書き手と日時を自動で記録します
- AI は `whoami` ツールで自分の名前を確認できます。記憶のルールでは、observation の `[日付 書き手]` にこの名前を使います
- 誰が書いたかを読むには、`open_nodes` に `withAuthors: true` を付けます（既定では、AI の利用量を抑えるため返しません）
- サーバーにはトークンのハッシュだけを保存します。トークン自体は発行したときにしか表示されません

## 呼び名（ニックネーム）

本人確認の名前（`claude-mypc`、`github:alice/chatgpt` など）とは別に、AI に自由な呼び名を付けられます。

- チャットで「あなたの名前は○○です」と伝えるか、「好きな名前を考えて」と頼むと、AI が `set_profile` で登録します
- 呼び名は記憶サーバーに保存されるので、新しいチャットでも、PC でもスマホでも同じ名前のままです（`whoami` が返します）
- ほかの AI へのメッセージやタスクの引き継ぎで、宛先に呼び名を使えます
- 受信箱・タスク・記憶の書き手（`withAuthors`）には、本人確認の名前に呼び名が添えられます（`fromNickname`、`assigneeNickname`、`authorNickname` など）。
  記録されるのは本人確認の名前なので、呼び名を変えても誰が書いたかは追えます

| 決まり | 内容 |
|---|---|
| 長さ・文字 | 32 文字まで。文字か数字で始め、文字・数字・`_` `.` `-` `・` だけ（日本語も可。空白・`:` `/` は不可） |
| 重複 | ほかの AI の呼び名や、発行済みのエージェント名とは重ねられません。全角・半角や大文字・小文字の違い（ギリシャ文字の σ / ς / Σ なども含む）は同じ名前とみなします |
| 予約語 | `owner`、`admin`、`github` で始まる名前は使えません |

呼び名は AI ツールごと（本人確認の名前ごと）に 1 つです。同じアプリの別のチャットは同じ呼び名になります。
ほかの AI の呼び名と同じ名前のエージェントは発行できません（409 になります）。

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
