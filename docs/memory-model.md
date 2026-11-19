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

## エンティティの種類

エンティティは、次の 8 種類だけを作れます（`create_entities` はほかの種類を受け付けません）。
名前は `種類:スコープ/名前` で、必ず `種類:` で始めます。Tech と Person はスコープを付けず `種類:名前` にします。

| 種類 | 入れるもの | 置き場所の目安 | 例 |
|---|---|---|---|
| `Project` | プロジェクトの入り口（目的・構成・主要Component の一覧）。1 プロジェクトに 1 つ | プロジェクト | `Project:myapp` |
| `Component` | プロジェクトの部品（画面・API・スクリプトなど） | プロジェクト | `Component:myapp/auth` |
| `Decision` | 決めたことと理由。変えるときは新しい Decision から `supersedes` | プロジェクト | `Decision:myapp/use-sqlite` |
| `Convention` | 守る決まり・書き方 | どちらでも | `Convention:global/commit-message-ja` |
| `Lesson` | やってみてわかった教訓（失敗とその回避策など） | どちらでも | `Lesson:global/pwsh-native-args` |
| `Agent` | AI（エージェント）の役割や得意なこと | どちらでも | `Agent:codex-mypc` |
| `Tech` | 使っている技術・道具とその使い方のこつ | 共通 | `Tech:PowerShell7` |
| `Person` | 人の好みや前提（秘密・個人情報は書かない） | 共通 | `Person:owner` |

- Convention・Lesson・Agent は、複数のプロジェクトで通用するなら共通（global）、そのプロジェクトだけのことならプロジェクトに置きます
- 置き場所が目安と違っても作成はされます。結果の `placement` に、目安と違うことが書かれます
- 打ち間違い（`lesson`、`Technology` など）は、正しい種類の候補をエラーで返します
- 管理画面のエンティティ一覧で、種類ごとの数と、決まった種類にないもの（この決まりより前に作られたもの）がわかります

## リレーションの種類

リレーションは、次の 8 種類だけを作れます（`create_relations` はほかの種類を受け付けません）。向きは「from が to に対して〜」と読みます。

| 種類 | 意味 | 例 |
|---|---|---|
| `part_of` | from は to の一部 | `Component:myapp/auth` → `Project:myapp` |
| `applies_to` | from（決まり・教訓）が to に当てはまる | `Convention:global/pwsh-utf8` → `Component:myapp/scripts` |
| `supersedes` | from が to を置き換える。古い to は消さずに残す | `Decision:myapp/use-d1` → `Decision:myapp/use-sqlite` |
| `uses` | from が to を使う | `Project:myapp` → `Tech:D1` |
| `about` | from は to についての知識 | `Lesson:global/pwsh-native-args` → `Tech:PowerShell7` |
| `responsible_for` | from が to を担当する | `Agent:codex-mypc` → `Component:myapp/auth` |
| `contradicts` | from と to の内容が食い違う。どちらが正しいか確かめるまで両方残す | `Lesson:global/a` → `Lesson:global/b` |
| `derived_from` | from は to から導いた知識 | `Convention:global/backup-first` → `Lesson:global/d1-export` |

- 食い違う知識を見つけたら、古いほうを消さずに `contradicts` で結びます。確かめて置き換えると決めたら、新しい Decision から `supersedes` で結びます
- 足さなかった種類: `supports`（`about` と `derived_from` で足ります）、`applied_to`（`applies_to` と紛らわしいため）、`validated_by`（知識を確かめる流れ（Issue #21）を作るときに考えます）
- 打ち間違い（`applied_to`、`part-of` など）は、正しい種類の候補をエラーで返します。これまでに作った別の種類の関係は、そのまま残り、`delete_relations` で消せます

## スコープ

記憶はスコープで分かれていて、URL で指定します。

| スコープ | URL | 入れるもの | AI ツールでの登録名 |
|---|---|---|---|
| 共通 | `/mcp/global` | どのプロジェクトでも通用すること（自分の好み、使っている技術、教訓） | `memory-global` |
| プロジェクト | `/mcp/p/<略称>` | そのプロジェクトの決定、構成、教訓 | `memory-project` |

`<略称>` は、プロジェクトごとに決める英小文字・数字・ハイフンの短い名前です（例: `myapp`）。
スコープが違えば、同じ名前のエンティティでも別のものとして扱われます。

## 参加ガイド

MCP に接続した AI は `whoami` を呼び、`firstVisit` または `guideHint` が返ったら `guide` を読んでください。ガイドは `memory://guide` resource と `memory-onboarding` prompt からも取得できます。読んだ版は本人確認名と scope ごとに記録され、ガイドの版が上がると再読の案内が出ます。

## 記憶プロトコル（AI に渡すルール）

AI には「いつ・何を・どう書くか」のルールを渡します。導入スクリプトが各 AI ツールに設定します。

- 共通のルール: [`client/templates/user-memory-rules.md`](../client/templates/user-memory-rules.md)
- プロジェクトのルール: [`memory-kit/AGENTS.md`](../memory-kit/AGENTS.md)

主な決まりごと:
- 名前は `種別:スコープ/名前`（例: `Decision:myapp/use-sqlite`）
- 種別は下の「エンティティの種類」の 8 種類のどれか
- observation は `[YYYY-MM-DD 書き手] 1文`。書き手は `whoami` で確認した名前（サーバーも書き手を自動で記録する）
- 保存前に検索して重複を避け、既存のエンティティへの追記を優先する
- 作業ログは保存しない。今後も使う事実・決定・教訓だけを保存する
- 決定を覆すときは消さずに、新しい Decision を作って `supersedes` でつなぐ

ルールは自由に書き換えて構いません。

## ツール

| ツール | 用途 |
|---|---|
| `search_nodes` | キーワードで検索する。上位 10 件と、各 observation の抜粋（3 件まで）を返す。一致した語の多いもの、名前で一致したもの、つながりの多いものが上位 |
| `open_nodes` | 名前を指定して、observation の全文と、つながっているリレーションを読む。`withAuthors: true` で書き手・日時・得たタスクも、`related: true` で関係をたどった近いエンティティ（2 段先まで、10 件）も返す |
| `create_entities` | エンティティを作る（既にある名前はスキップ） |
| `add_observations` | 既存のエンティティに observation を追加する（同じ内容は重複しない）。`taskId` を付けると、どのタスクで得た知識かを記録する |
| `create_relations` | リレーションを作る |
| `delete_entities` / `delete_observations` / `delete_relations` | 削除する |
| `whoami` | 自分（接続しているエージェント）の名前を確認する（[エージェントの識別](agents.md)） |
| `guide` | 参加ガイド、現在の参加者、scope のタスク数と自分の未読を確認する |
| `set_profile` | 自分の呼び名を登録する（[エージェントの識別](agents.md#呼び名ニックネーム)） |
| `task_*` / `send_message` / `read_inbox` | 複数の AI での分担（[協調](coordination.md)） |

server-memory との違い:
- 記憶を全部読み込む `read_graph` はありません（記憶が増えると AI の利用量が膨らむため）
- `search_nodes` は全件ではなく上位 10 件の抜粋だけを返します
- `open_nodes` は、指定したエンティティにつながるリレーションも返します
- 検索は部分一致（LIKE）です。全角・半角は区別しません。全文検索（FTS5）は、バックアップに使う `wrangler d1 export` が書き出せなくなるため使っていません

## 関連する知識を見つける

- **関係をたどる**: `open_nodes` に `related: true` を付けると、関係を 2 段先までたどったエンティティを返します。
  たとえば Lesson から `about` でつながる Tech と、同じ Tech についてのほかの Lesson が見つかります（`depth: 1` で 1 段だけ）
- **タスクを始めるとき**: `task_claim` で引き受けると、タスクのタイトルと説明に合う知識が `relatedKnowledge`（最大 3 件）として添えられます。
  タスクのスコープと共通（global）の両方から探します。`task_get` では `withKnowledge: true` のときだけ添えます
- **経緯をたどる**: タスクの作業で得た知識に `taskId` を付けておくと、`open_nodes`（`withAuthors: true`）や管理画面から、どのタスクで得たかがわかります

1 回の呼び出しで扱えるのは 20 件までです。

## server-memory から移行する

MCP 公式の記憶サーバー（server-memory）をローカルで使っていた場合は、その jsonl ファイルを取り込めます。
先に README の手順 2（PC の AI ツールをつなぐ）を済ませてから、リポジトリの直下で実行します（PowerShell / bash / zsh 共通）。

```sh
pwsh ./client/import-jsonl.ps1 -Path <jsonl ファイル> -Scope global      # 共通の記憶へ
pwsh ./client/import-jsonl.ps1 -Path <jsonl ファイル> -Scope myapp       # プロジェクト myapp の記憶へ
```

何度実行しても重複しません。取り込んだあと、ローカルの server-memory の登録は削除して構いません。

server-memory では種類や名前を自由に付けられるので、取り込むときに memory-cloud の決まり（上の「エンティティの種類」「リレーションの種類」）に合わせて変換します。

- 大文字・小文字や、よくある言い換え（`person` → `Person`、`technology` → `Tech`、`Uses` → `uses` など）はそろえます
- 名前が `種類:` で始まっていなければ付けます（例: `John_Smith` → `Person:John_Smith`）。リレーションの両端も付け替えます
- 対応先がわからない種類があると、何も書き込まずに止まり、その種類を表示します。対応を指定してやり直してください

```sh
pwsh ./client/import-jsonl.ps1 -Path <jsonl ファイル> -Scope global -DryRun \
  -TypeMap @{ note = 'Lesson' } -RelationMap @{ related_to = 'about' }   # -DryRun で変換の結果だけ確かめる
```
