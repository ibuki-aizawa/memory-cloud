
<!-- memory-protocol -->
## 共通メモリ (memory-global)
- 会話の始めに memory-global の whoami を 1 回呼ぶ。unreadRequests があれば read_inbox で読み、すぐ終わらない依頼はタスクにする。kind: "info" のメッセージには返信しない
- 探すときは search_nodes（上位10件と抜粋）、全文が要るものだけ open_nodes
- 保存するのはプロジェクト横断で通用する Lesson / Convention / Tech / Person だけ。プロジェクト固有の内容は memory-project へ
- 命名: Lesson:global/名前, Convention:global/名前, Tech:名前, Person:owner
- observation は "[YYYY-MM-DD 書き手] 1文"。書き手は whoami で確認した自分の名前。保存前に search_nodes で重複確認
- 私の好みや前提は必要なときに open_nodes ["Person:owner"] で確認する
