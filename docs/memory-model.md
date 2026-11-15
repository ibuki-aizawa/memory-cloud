# 記憶のしくみ

memory-cloud の記憶が、どんな形で保存され、AI がどう使うかの説明です。

## 保存の形

記憶は、AI が読み書きしやすい「メモの集まり」として保存されます。
[MCP 公式の記憶サーバー（server-memory）](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) と同じ形式・同じツール名なので、そのまま置き換えて使えます。

| 用語 | 意味 | 例 |
|---|---|---|
| エンティティ | 記憶の見出し。種別と名前を持つ | `Decision:myapp/use-sqlite`（種別は Decision） |
| observation | エンティティに付けるメモ。1 件 1 文 | `[2026-11-15 owner] 手軽さを優先して SQLite を採用` |
| リレーション | エンティティどうしのつながり | `Component:myapp/auth` → `part_of` → `Project:myapp` |

## スコープ

記憶はスコープで分かれていて、URL で指定します。

| スコープ | URL | 入れるもの | AI ツールでの登録名 |
|---|---|---|---|
| 共通 | `/mcp/global` | どのプロジェクトでも通用すること（自分の好み、使っている技術、教訓） | `memory-global` |
| プロジェクト | `/mcp/p/<略称>` | そのプロジェクトの決定、構成、教訓 | `memory-project` |

`<略称>` は、プロジェクトごとに決める英小文字・数字・ハイフンの短い名前です（例: `myapp`）。
スコープが違えば、同じ名前のエンティティでも別のものとして扱われます。

## 記憶プロトコル（AI に渡すルール）

AI には「いつ・何を・どう書くか」のルールを渡します。導入スクリプトが各 AI ツールに設定します。

- 共通のルール: [`client/templates/user-memory-rules.md`](../client/templates/user-memory-rules.md)
- プロジェクトのルール: [`memory-kit/AGENTS.md`](../memory-kit/AGENTS.md)

主な決まりごと:
- 名前は `種別:スコープ/名前`（例: `Decision:myapp/use-sqlite`）
- 種別は Project, Component, Decision, Convention, Lesson, Agent, Tech, Person のどれか
- observation は `[YYYY-MM-DD 書き手] 1文`。書き手は `whoami` で確認した名前（サーバーも書き手を自動で記録する）
- 保存前に検索して重複を避け、既存のエンティティへの追記を優先する
- 作業ログは保存しない。今後も使う事実・決定・教訓だけを保存する
- 決定を覆すときは消さずに、新しい Decision を作って `supersedes` でつなぐ

ルールは自由に書き換えて構いません。

## ツール

| ツール | 用途 |
|---|---|
| `search_nodes` | キーワードで検索する。上位 10 件と、各 observation の抜粋（3 件まで）を返す |
| `open_nodes` | 名前を指定して、observation の全文と、つながっているリレーションを読む。`withAuthors: true` で書き手と日時も返す |
| `create_entities` | エンティティを作る（既にある名前はスキップ） |
| `add_observations` | 既存のエンティティに observation を追加する（同じ内容は重複しない） |
| `create_relations` | リレーションを作る |
| `delete_entities` / `delete_observations` / `delete_relations` | 削除する |
| `whoami` | 自分（接続しているエージェント）の名前を確認する（[エージェントの識別](agents.md)） |
| `set_profile` | 自分の呼び名を登録する（[エージェントの識別](agents.md#呼び名ニックネーム)） |
| `task_*` / `send_message` / `read_inbox` | 複数の AI での分担（[協調](coordination.md)） |

server-memory との違い:
- 記憶を全部読み込む `read_graph` はありません（記憶が増えると AI の利用量が膨らむため）
- `search_nodes` は全件ではなく上位 10 件の抜粋だけを返します
- `open_nodes` は、指定したエンティティにつながるリレーションも返します

1 回の呼び出しで扱えるのは 20 件までです。

## server-memory から移行する

MCP 公式の記憶サーバー（server-memory）をローカルで使っていた場合は、その jsonl ファイルを取り込めます。
先に README の手順 2（PC の AI ツールをつなぐ）を済ませてから、リポジトリの直下で実行します（PowerShell / bash / zsh 共通）。

```sh
pwsh ./client/import-jsonl.ps1 -Path <jsonl ファイル> -Scope global      # 共通の記憶へ
pwsh ./client/import-jsonl.ps1 -Path <jsonl ファイル> -Scope myapp       # プロジェクト myapp の記憶へ
```

何度実行しても重複しません。取り込んだあと、ローカルの server-memory の登録は削除して構いません。
