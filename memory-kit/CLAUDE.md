# {{PROJECT}}

<!-- プロジェクト固有の説明（目的・技術スタック・コマンドなど）をここに書く -->

## 記憶プロトコル
- 3層: 個別=agent-memory（サブエージェントの memory:）/ プロジェクト=memory-project / 共通=memory-global
- 開始時は memory-project の open_nodes ["Project:{{PROJECT}}"] のみ。他は必要時に search_nodes
- search_nodes は上位10件と observation の抜粋だけを返す。全文が要るものだけ open_nodes で開く
- 命名: 種別:スコープ/名前（例 Decision:{{PROJECT}}/use-sqlite）。スコープは {{PROJECT}} か global
- 種別は Project, Component, Decision, Convention, Lesson, Agent, Tech, Person のみ
- 関係は part_of, applies_to, supersedes, uses, about, responsible_for のみ
- observation は "[YYYY-MM-DD 書き手] 1文"
- 保存前に search_nodes で重複確認。新規作成より既存への add_observations を優先
- 保存するのは今後も再利用する事実・決定・教訓だけ。作業ログは保存しない
- 決定を覆すときは削除せず、新しい Decision を作り supersedes で結ぶ
- 新しい Component を作ったら Project:{{PROJECT}} の「主要Component」observation を更新する
- 複数プロジェクトで通用する Lesson / Convention は memory-global に書く
- global のエンティティは名前で参照するだけ（例: "Tech:PowerShell7 を使用（global参照）"）
