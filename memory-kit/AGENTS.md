# {{PROJECT}}

<!-- プロジェクト固有の説明（目的・技術スタック・コマンドなど）をここに書く -->
<!-- このファイルは Codex / Cursor / VS Code (Copilot) / Gemini CLI などが読みます。Claude Code は CLAUDE.md 経由で読みます -->

## 記憶プロトコル
- 記憶は MCP サーバーの memory-project（このプロジェクト）と memory-global（プロジェクト横断）にある
- 3層: 個別=エージェント自身の記憶（Claude Code ならサブエージェントの memory:）/ プロジェクト=memory-project / 共通=memory-global
- 開始時は memory-project の open_nodes ["Project:{{PROJECT}}"] のみ。他は必要時に search_nodes
- search_nodes は上位10件と observation の抜粋だけを返す。全文が要るものだけ open_nodes で開く
- 命名: 種別:スコープ/名前（例 Decision:{{PROJECT}}/use-sqlite）。スコープは {{PROJECT}} か global
- 種別は Project, Component, Decision, Convention, Lesson, Agent, Tech, Person のみ
- 関係は part_of, applies_to, supersedes, uses, about, responsible_for のみ
- observation は "[YYYY-MM-DD 書き手] 1文"。書き手は whoami で確認した自分の名前（サーバーも書き手を自動で記録する）
- 誰がいつ書いたかを確かめたいときは open_nodes に withAuthors: true を付ける
- 保存前に search_nodes で重複確認。新規作成より既存への add_observations を優先
- 保存するのは今後も再利用する事実・決定・教訓だけ。作業ログは保存しない
- 決定を覆すときは削除せず、新しい Decision を作り supersedes で結ぶ
- 新しい Component を作ったら Project:{{PROJECT}} の「主要Component」observation を更新する
- 複数プロジェクトで通用する Lesson / Convention は memory-global に書く
- global のエンティティは名前で参照するだけ（例: "Tech:PowerShell7 を使用（global参照）"）

## 協調プロトコル（複数の AI で同じプロジェクトを進めるとき）
- タスクと受信箱は memory-project にある。作業の始めに whoami を呼び、unreadMessages があれば read_inbox、myActiveTasks があれば task_list { mine: true } を確認する
- 依頼された作業は task_list で既存のタスクを探し、なければ task_create { claim: true } で作る。作業する前に必ず task_claim で引き受ける
- ほかのエージェントが担当中のタスクには手を出さない。必要なら note を残すか send_message で相談する
- 作業は自分のブランチ（例 <自分の名前>/<タスク番号>）か git worktree で行い、ほかのエージェントと同じファイルを同時に書き換えない
- 長い作業では区切りごとに task_update で note を残す（担当の期限 30 分が延びる）
- 終わったら task_update { status: "done", note: 結果 }。レビューが要るなら task_handoff { to, status: "review", note: ブランチ名と見てほしい点 }
- 続けられないときは task_update { status: "open", note: 残っていること } で手放す
- 作業の合間とタスクを終えたときにも read_inbox を確認する
- タスクの経過や連絡は記憶（エンティティ）に書かない。残す価値のある決定・教訓だけを記憶に書く
