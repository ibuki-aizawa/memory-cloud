export const GUIDE_VERSION = '1.0.0';
export const GUIDE_URI = 'memory://guide';
export const GUIDE_PROMPT_NAME = 'memory-onboarding';

const RULES = `## 記憶に書く内容
- 将来も再利用する事実、決定、教訓だけを保存する。会話や作業のログは保存しない。
- 秘密情報、個人情報、アクセストークン、パスワード、秘密鍵を書かない。ユーザーが提示した情報でも、保存する必要と許可がなければ記録しない。
- プロジェクト横断で使える Lesson / Convention / Tech / Person は global に、プロジェクト固有の内容はこのプロジェクトの scope に保存する。

## 名前と observation
- 名前は「種別:スコープ/名前」。例: \`Decision:myapp/use-sqlite\`。
- 種別は Project, Component, Decision, Convention, Lesson, Agent, Tech, Person を使う。
- observation は \`[YYYY-MM-DD 書き手] 1文\`。書き手は \`whoami\` が返す本人確認の \`name\`（呼び名ではない）。
- 保存前に \`search_nodes\` で重複を確認する。既存エンティティには \`add_observations\` を使う。
- 決定を変えるときは古い記録を消さず、新しい Decision を作って \`supersedes\` で結ぶ。

## 協調
- 会話の開始時に \`whoami\` を確認する。
- \`unreadRequests\` があれば \`read_inbox\` で内容を確認する。\`kind: "info"\` のメッセージには返信しない。
- すぐ終わらない依頼や後で行う作業はタスクにする。タスクに取りかかる前に \`task_claim\` で担当を確認し、他者が担当中なら手を出さない。
- 進捗を \`task_update\` に残し、終わったら \`done\` にする。レビューが必要なら \`task_handoff\` で依頼する。
- 他の AI に頼むときは \`send_message\` または \`task_handoff\` を使う。受信箱は通知、タスクは後で追跡する仕事として扱う。
- \`search_nodes\` は上位10件と抜粋を返す。全文が必要なものだけ \`open_nodes\` で開く。`;

export function renderGuide({ scope, agents, activeTasks, unreadMessages }) {
  const participants = agents.length
    ? agents.map(({ identity, nickname }) => `- ${nickname ? `${nickname} (${identity})` : identity}`).join('\n')
    : '- まだ登録された参加者はいません。';
  const project = scope === 'global'
    ? 'このガイドは global scope 向けです。'
    : `この scope のプロジェクトハブは Project:${scope.slice(2)} です。まず open_nodes の names に "Project:${scope.slice(2)}" を指定して確認してください。`;
  return `# memory-cloud 参加ガイド\n\nガイド版: ${GUIDE_VERSION}\n\n${RULES}\n\n## いまの状況（${scope}）\n- 参加中の AI:\n${participants}\n- 未完了タスク（open / in_progress / review）: ${activeTasks}\n- 自分宛ての未読メッセージ: ${unreadMessages}\n- ${project}\n`;
}

export const GUIDE_RESOURCE = {
  uri: GUIDE_URI,
  name: 'memory-cloud guide',
  title: '参加ガイド',
  description: '記憶の保存方法と AI 間の協調ルール。現在の参加者と scope の状況を含みます。',
  mimeType: 'text/markdown',
};

export const GUIDE_PROMPT = {
  name: GUIDE_PROMPT_NAME,
  title: 'memory-cloud に参加する',
  description: 'ガイドを読んでから、この scope で安全に作業を始めるための定型指示。',
};

export function renderOnboardingPrompt(scope) {
  return `この memory-cloud の scope は ${scope} です。まず guide ツールまたは memory://guide resource を読み、内容に従ってください。続けて whoami を確認し、guideHint があれば guide を読み直してください。未読の依頼があれば inbox を確認し、すぐ終わらない依頼はタスクとして追跡してください。`;
}