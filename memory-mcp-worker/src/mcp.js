/**
 * memory-mcp — @modelcontextprotocol/server-memory 互換のリモート MCP サーバー
 * Cloudflare Workers + D1 で動作します。
 *
 * エンドポイント（スコープは URL で決まります）
 *   POST /mcp/global          … プロジェクト横断の共通ナレッジ
 *   POST /mcp/p/<slug>        … プロジェクトごとのナレッジ
 *
 * 認証（index.js が振り分けます。誰からのリクエストかは書き手として記録します）
 *   - Authorization: Bearer <MEMORY_TOKEN>（管理者。wrangler secret で設定）
 *   - Authorization: Bearer mca_...（エージェントごとのトークン。agents.js、/admin/agents で発行）
 *   - OAuth 2.1 + GitHub サインイン（Web 版のクライアント向け。auth.js）
 *
 * server-memory との違い
 *   - read_graph はありません（全件読み込みによるトークン浪費を防ぐため）
 *   - search_nodes は上位 10 件・各 observation は最大 3 件のプレビューを返します
 *   - open_nodes は指定ノードに接続するリレーションも返します（近傍の把握用）
 */
import { adminIdentity, bearerToken, handleAdmin, resolveAgent } from './agents.js';
import { handleDashboard, isDashboardPath } from './dashboard.js';
import { ENTITY_TYPES, RELATION_TYPES, checkEntity, checkRelationType, knowledgeForTask, rankEntities, relatedEntities, searchTerms } from './knowledge.js';
import { GUIDE_PROMPT, GUIDE_PROMPT_NAME, GUIDE_RESOURCE, GUIDE_URI, GUIDE_VERSION, renderGuide, renderOnboardingPrompt } from './guide.js';

const SERVER_INFO = { name: 'memory-mcp', version: '1.6.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MAX_ITEMS = 20;          // 1 回のツール呼び出しで扱う最大件数
const MAX_NAME_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2000;
const SEARCH_LIMIT = 10;
const SEARCH_PREVIEW = 3;
const NEIGHBOR_LIMIT = 50;

const TASK_STATUSES = ['open', 'in_progress', 'review', 'done', 'cancelled'];
const ACTIVE_STATUSES = ['open', 'in_progress', 'review'];
const LEASE_MINUTES = 30;         // task_claim / task_update で延びる担当の期限
const HANDOFF_LEASE_HOURS = 24;   // task_handoff で渡された側の期限
const TASK_LIST_LIMIT = 50;
const INBOX_LIMIT = 20;
const MAX_AGENT_NAME = 100;
const MAX_NICKNAME = 32;
const MESSAGE_KINDS = ['request', 'info'];
const MAX_BIO = 200;

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

const entitySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'エンティティ名（例: Decision:myapp/use-sqlite）' },
    entityType: {
      type: 'string',
      enum: Object.keys(ENTITY_TYPES),
      description: `エンティティの種類。名前は「種類:」で始める。${Object.entries(ENTITY_TYPES).map(([k, v]) => `${k}: ${v.meaning}`).join(' / ')}`,
    },
    observations: { type: 'array', items: { type: 'string' }, description: '事実（1 件 1 文）' },
  },
  required: ['name', 'entityType'],
};

const relationSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: '起点のエンティティ名' },
    to: { type: 'string', description: '終点のエンティティ名' },
    relationType: { type: 'string', description: '関係の種類（能動態。例: part_of）' },
  },
  required: ['from', 'to', 'relationType'],
};

// create_relations では種類を決まったものに絞る（delete_relations は古い種類も消せるよう絞らない）
const newRelationSchema = {
  ...relationSchema,
  properties: {
    ...relationSchema.properties,
    relationType: {
      type: 'string',
      enum: Object.keys(RELATION_TYPES),
      description: `関係の種類。向きは「from が to に対して〜」。${Object.entries(RELATION_TYPES).map(([k, v]) => `${k}: ${v}`).join(' / ')}`,
    },
  },
};

const TOOLS = [
  {
    name: 'create_entities',
    description: `新しいエンティティを作成します（最大 ${MAX_ITEMS} 件）。既に存在する名前はスキップされるので、既存エンティティには add_observations を使ってください。`,
    inputSchema: {
      type: 'object',
      properties: { entities: { type: 'array', items: entitySchema, maxItems: MAX_ITEMS }, taskId: { type: 'integer', description: 'この知識を得たタスクの番号（任意。同じスコープのタスク）。あとで経緯をたどれる' } },
      required: ['entities'],
    },
  },
  {
    name: 'create_relations',
    description: `エンティティ間のリレーションを作成します（最大 ${MAX_ITEMS} 件）。両端のエンティティが存在している必要があります。relationType は決まった種類だけ使えます（part_of, applies_to, supersedes, uses, about, responsible_for, contradicts, derived_from）。`,
    inputSchema: {
      type: 'object',
      properties: { relations: { type: 'array', items: newRelationSchema, maxItems: MAX_ITEMS } },
      required: ['relations'],
    },
  },
  {
    name: 'add_observations',
    description: `既存エンティティに observation を追加します（最大 ${MAX_ITEMS} 件）。同じ内容は重複登録されません。`,
    inputSchema: {
      type: 'object',
      properties: {
        observations: {
          type: 'array',
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              entityName: { type: 'string' },
              contents: { type: 'array', items: { type: 'string' } },
            },
            required: ['entityName', 'contents'],
          },
        },
        taskId: { type: 'integer', description: 'この知識を得たタスクの番号（任意。同じスコープのタスク）。あとで経緯をたどれる' },
      },
      required: ['observations'],
    },
  },
  {
    name: 'delete_entities',
    description: 'エンティティと、その observation・リレーションを削除します。',
    inputSchema: {
      type: 'object',
      properties: { entityNames: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS } },
      required: ['entityNames'],
    },
  },
  {
    name: 'delete_observations',
    description: '指定した observation を削除します（内容の完全一致）。',
    inputSchema: {
      type: 'object',
      properties: {
        deletions: {
          type: 'array',
          maxItems: MAX_ITEMS,
          items: {
            type: 'object',
            properties: {
              entityName: { type: 'string' },
              observations: { type: 'array', items: { type: 'string' } },
            },
            required: ['entityName', 'observations'],
          },
        },
      },
      required: ['deletions'],
    },
  },
  {
    name: 'delete_relations',
    description: '指定したリレーションを削除します。',
    inputSchema: {
      type: 'object',
      properties: { relations: { type: 'array', items: relationSchema, maxItems: MAX_ITEMS } },
      required: ['relations'],
    },
  },
  {
    name: 'search_nodes',
    description: `名前・種別・observation を部分一致で検索します（全角・半角は区別しない）。空白区切りの複数語は、より多く一致したものが上位になり、同じなら名前で一致したもの・つながりの多いものが上位です。上位 ${SEARCH_LIMIT} 件と observation のプレビュー（各 ${SEARCH_PREVIEW} 件）を返すので、全文は open_nodes で取得してください。`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '検索語（空白区切りで最大 5 語）' } },
      required: ['query'],
    },
  },
  {
    name: 'open_nodes',
    description: `名前を指定してエンティティを取得します（最大 ${MAX_ITEMS} 件）。全 observation と、接続するリレーションを返します。誰がいつ書いたかが必要なときだけ withAuthors: true を、関係をたどって関連する知識を探したいときだけ related: true を指定してください。`,
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS },
        withAuthors: { type: 'boolean', description: 'true なら observation ごとの書き手（author）と日時（createdAt）、得たタスク（taskId）、エンティティの作成者（createdBy）も返す' },
        related: { type: 'boolean', description: 'true なら関係をたどった近いエンティティ（related。最大 10 件、たどった関係と observation の先頭 1 件つき）も返す' },
        depth: { type: 'integer', minimum: 1, maximum: 2, description: 'related でたどる段数（1 か 2。既定 2）' },
      },
      required: ['names'],
    },
  },
  {
    name: 'whoami',
    description: 'このサーバーが認識している自分（接続しているエージェント）の名前（name）と種類、呼び名（nickname）、未読メッセージ数、自分が担当中のタスク数を返します。observation の書き手には name を使ってください。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_profile',
    description: `自分の呼び名（ニックネーム）とひとこと自己紹介を登録します。ユーザーに「あなたの名前は○○」と言われたとき、または名前を考えるよう頼まれたときに使います。呼び名はほかのエージェントと重ならないものにしてください（${MAX_NICKNAME} 文字まで、空白なし）。呼び名は send_message / task_handoff の宛先にも使えます。本人確認の名前（whoami の name）は変わりません。`,
    inputSchema: {
      type: 'object',
      properties: {
        nickname: { type: 'string', description: '呼び名（例: ミナト、sora）' },
        bio: { type: 'string', description: `ひとこと自己紹介（${MAX_BIO} 文字まで。例: レビュー担当）` },
      },
      required: ['nickname'],
    },
  },

  // --- 協調（タスクボードと受信箱）。タスクとメッセージはスコープ（プロジェクト）ごと ---
  {
    name: 'guide',
    description: '記憶の書き方、協調ルール、参加者、現在の scope の状況を Markdown で返します。初めての参加時や whoami に guideHint があるときに読んでください。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'task_create',
    description: 'タスクを作ります。claim: true なら作ると同時に自分が引き受けます。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: `タスク名（${MAX_NAME_LENGTH} 文字以内）` },
        description: { type: 'string', description: '内容・完了条件など' },
        claim: { type: 'boolean', description: 'true なら自分が引き受ける' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_list',
    description: `タスクの一覧を返します（新しい順に最大 ${TASK_LIST_LIMIT} 件、説明文は含まない）。既定は終わっていないもの（open / in_progress / review）。`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', ...TASK_STATUSES, 'all'], description: '絞り込み。既定は active（終わっていないもの）' },
        mine: { type: 'boolean', description: 'true なら自分が担当しているものだけ' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'タスクの詳細と経過（引き受け・進捗メモ・引き継ぎの履歴）を返します。withKnowledge: true なら、関係のありそうな知識（relatedKnowledge、最大 3 件）も添えます。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, withKnowledge: { type: 'boolean', description: 'true なら関係のありそうな知識も返す' } },
      required: ['id'],
    },
  },
  {
    name: 'task_claim',
    description: `タスクを引き受けます。ほかのエージェントが担当中なら失敗します（同時に引き受けても成功するのは 1 人だけ）。担当には期限（${LEASE_MINUTES} 分）があり、task_update で延びます。期限が切れたタスクは別のエージェントが引き受けられます。引き受けると、関係のありそうな知識（relatedKnowledge、最大 3 件）があれば添えます。`,
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'task_update',
    description: `進捗を記録します。status を変えられるのは担当者だけで、未担当のタスクは先に task_claim で引き受けます（open にすると担当を外して手放す。done / cancelled は作成者か最後の担当者が open で再開できる）。note だけなら誰でも書けます。担当者が呼ぶと期限が ${LEASE_MINUTES} 分延びます。`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: TASK_STATUSES },
        note: { type: 'string', description: '進捗・結果のメモ（1〜数文）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_handoff',
    description: `タスクをほかのエージェントに渡し、相手の受信箱に知らせます。渡せるのは担当者（未担当のタスクなら作成者）。レビューを頼むときは status: "review"。渡した相手の担当期限は ${HANDOFF_LEASE_HOURS} 時間です。`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        to: { type: 'string', description: '渡す相手のエージェント名' },
        note: { type: 'string', description: '引き継ぐ内容（やったこと・残り・ブランチ名など）' },
        status: { type: 'string', enum: ['in_progress', 'review'], description: '既定は in_progress' },
      },
      required: ['id', 'to', 'note'],
    },
  },
  {
    name: 'send_message',
    description: 'ほかのエージェントの受信箱にメッセージを送ります。相手は read_inbox で読みます（すぐには届かず、相手が確認したときに読まれます）。お礼・完了報告など返信の要らないものは kind: "info" にしてください（相手は返信せず、見張りのスクリプトも相手を起こしません）。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '相手のエージェント名か呼び名' },
        body: { type: 'string' },
        taskId: { type: 'integer', description: '関係するタスクの id' },
        kind: { type: 'string', enum: MESSAGE_KINDS, description: 'request（返信・対応が要る。既定）か info（返信不要のお知らせ）' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'read_inbox',
    description: `自分宛てのメッセージを古い順に返し（最大 ${INBOX_LIMIT} 件）、既読にします。kind: "info" のメッセージには返信しないでください。既読は「読んだ」であって「対応した」ではないので、すぐ終わらない依頼は task_create でタスクにしてください。`,
    inputSchema: {
      type: 'object',
      properties: {
        includeRead: { type: 'boolean', description: 'true なら既読のものも新しい順に返す' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// エントリーポイント
//   認証方式（固定トークン / OAuth）を問わない MCP の処理です。OAuth との組み合わせは index.js が行います。
//   default export は固定トークン認証だけで動く Worker で、ローカルテスト（test/test.mjs）が使います。
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '') return rootResponse();

    // Web の確認画面（ログインは dashboard.js が管理者トークンで行う）
    if (isDashboardPath(url.pathname)) return handleDashboard(request, env);

    if (url.pathname.startsWith('/admin/')) {
      if (!isAuthorized(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
      return handleAdmin(request, env);
    }

    const scope = parseScope(url.pathname);
    if (!scope) return notFound();
    const identity = await resolveTokenIdentity(request, env);
    if (!identity) return jsonResponse({ error: 'unauthorized' }, 401);
    return handleMcp(request, env, scope, identity);
  },
};

/** 管理者トークンかエージェントのトークンなら identity を返す。どちらでもなければ null */
export async function resolveTokenIdentity(request, env) {
  if (isAuthorized(request, env)) return adminIdentity();
  return resolveAgent(env.DB, bearerToken(request));
}

export function rootResponse() {
  return new Response('memory-mcp is running\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export function notFound() {
  return jsonResponse({ error: 'not found' }, 404);
}

/**
 * 認証済みのリクエストを、指定したスコープの MCP（JSON-RPC）として処理します。
 * identity は { kind: 'admin' | 'agent' | 'user', name }。書き込みの書き手として記録します。
 */
export async function handleMcp(request, env, scope, identity) {
  if (request.method !== 'POST') {
    // SSE ストリームは提供しない（ステートレス運用）
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, 'Parse error'), 400);
  }

  const ctx = { db: env.DB, scope, identity, author: identity.name };

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return responses.length ? jsonResponse(responses) : new Response(null, { status: 202 });
  }

  const response = await handleMessage(body, ctx);
  return response ? jsonResponse(response) : new Response(null, { status: 202 });
}

export function parseScope(pathname) {
  if (/^\/mcp\/global\/?$/.test(pathname)) return 'global';
  const m = pathname.match(/^\/mcp\/p\/([a-z0-9][a-z0-9-]{0,62})\/?$/);
  return m ? `p:${m[1]}` : null;
}

/** 管理者トークン（MEMORY_TOKEN）での認証。Authorization ヘッダーが一致すれば true */
export function isAuthorized(request, env) {
  const expected = env.MEMORY_TOKEN;
  if (!expected) return false;
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = new TextEncoder().encode(m[1].trim());
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid Request');
  }
  // 通知（id なし）には応答しない
  if (msg.id === undefined || msg.id === null) return null;

  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      return rpcResult(msg.id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: scopeInstructions(ctx.scope),
      });
    }
    case 'ping':
      return rpcResult(msg.id, {});
    case 'tools/list':
      return rpcResult(msg.id, { tools: TOOLS });
    case 'tools/call':
      return rpcResult(msg.id, await callTool(params.name, params.arguments || {}, ctx));
    case 'resources/list':
      return rpcResult(msg.id, { resources: [GUIDE_RESOURCE] });
    case 'resources/read': {
      if (params.uri !== GUIDE_URI) return rpcError(msg.id, -32602, 'Unknown resource URI');
      return rpcResult(msg.id, { contents: [{ uri: GUIDE_URI, mimeType: GUIDE_RESOURCE.mimeType, text: await readGuide(ctx, { recordRead: false }) }] });
    }
    case 'prompts/list':
      return rpcResult(msg.id, { prompts: [GUIDE_PROMPT] });
    case 'prompts/get': {
      if (params.name !== GUIDE_PROMPT_NAME) return rpcError(msg.id, -32602, 'Unknown prompt');
      return rpcResult(msg.id, {
        description: GUIDE_PROMPT.description,
        messages: [{ role: 'user', content: { type: 'text', text: renderOnboardingPrompt(ctx.scope) } }],
      });
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function readGuide({ db, identity, scope }, { recordRead = true } = {}) {
  const [participants, counts] = await Promise.all([
    db.prepare(
      `SELECT a.name AS identity, p.nickname AS nickname
       FROM agents AS a LEFT JOIN profiles AS p ON p.identity = a.name
       WHERE a.revoked_at IS NULL
       UNION ALL
       SELECT p.identity, p.nickname FROM profiles AS p
       WHERE p.identity NOT IN (SELECT name FROM agents)
       ORDER BY identity`
    ).all(),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks WHERE scope = ?1 AND status IN ('open', 'in_progress', 'review')) AS activeTasks,
         (SELECT COUNT(*) FROM messages WHERE scope = ?1 AND to_agent = ?2 AND read_at IS NULL AND kind = 'request') AS unreadRequests`
    ).bind(scope, identity.name).first(),
  ]);
  const markdown = renderGuide({ scope, agents: participants.results, activeTasks: counts.activeTasks, unreadRequests: counts.unreadRequests });
  if (recordRead) {
    await db.prepare(
      `INSERT INTO guide_reads (identity, scope, version, read_at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT (identity, scope) DO UPDATE SET version = excluded.version, read_at = excluded.read_at`
    ).bind(identity.name, scope, GUIDE_VERSION).run();
  }
  return markdown;
}

/**
 * 接続したときに AI へ渡す説明（MCP の instructions）。
 * ルールファイル（CLAUDE.md / AGENTS.md）を読めない Web 版・モバイル版のチャットでも同じ動きになるよう、要点をここに書く。
 * どこまで従うかはクライアント次第なので、詳しいルールはこれまでどおりルールファイルに置く。
 */
function scopeInstructions(scope) {
  const common = [
    '記憶の使い方:',
    '- 会話の始めに whoami を 1 回呼ぶ。firstVisit または guideHint があれば guide を読み、unreadRequests があれば read_inbox、myActiveTasks があれば task_list { mine: true } を確認する',
    '- whoami に nickname があれば、それが自分の呼び名。ユーザーに名前を付けられたら set_profile で登録する（ほかのエージェントにも呼び名で宛てられる）',
    '- 必要になったら search_nodes で探す（上位 10 件と抜粋だけ返る）。全文が要るものだけ open_nodes で開く。read_graph はない',
    '- 保存するのは今後も使う事実・決定・教訓だけ。会話や作業のログは保存しない',
    '- 保存前に search_nodes で重複を確認し、既存のエンティティには add_observations で足す',
    '- 名前は 種別:スコープ/名前（例 Decision:myapp/use-sqlite）。observation は "[YYYY-MM-DD 書き手] 1文"。書き手は whoami の name',
    '- 決定を覆すときは削除せず、新しい Decision を作って supersedes で結ぶ',
    '協調（ほかの AI と分担するとき）:',
    '- 作業する前に task_claim で引き受ける。ほかの AI が担当中のタスクには手を出さない',
    '- 長い作業では task_update で note を残す。終わったら done にするか、task_handoff でレビューを頼む',
    '- お礼・完了報告など返信の要らないメッセージは send_message の kind: "info" で送る。kind: "info" のメッセージには返信しない（AI どうしの返信の往復を止めるため）',
    '- 既読は「読んだ」であって「対応した」ではない。すぐ終わらない依頼のメッセージは task_create でタスクにして、元のメッセージ id を説明に書く',
  ];
  if (scope === 'global') {
    return [
      'このスコープはプロジェクト横断の共通ナレッジ（Lesson / Convention / Tech / Person）。プロジェクト固有の内容は書かない。',
      'ユーザーの好みや前提が必要なときは open_nodes ["Person:owner"] を確認する。',
      ...common,
    ].join('\n');
  }
  const slug = scope.slice(2);
  return [
    `このスコープはプロジェクト ${slug} のナレッジとタスクボード。まず open_nodes ["Project:${slug}"] でハブを確認する。`,
    ...common,
  ].join('\n');
}

async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return toolError(`Unknown tool: ${name}`);
  try {
    const result = await handler(args, ctx);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  } catch (err) {
    if (err instanceof ToolInputError) return toolError(err.message);
    console.error(err);
    return toolError(`内部エラー: ${err && err.message ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// ツール実装
// ---------------------------------------------------------------------------

const HANDLERS = {
  async whoami(_args, { db, identity, scope }) {
    const hints = {
      admin: '管理者トークン（MEMORY_TOKEN）で接続しています。エージェントごとにトークンを分けると、書き手を区別できます。',
      agent: 'エージェント専用のトークンで接続しています。',
      user: 'OAuth でログインして接続しています。',
    };
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE scope = ?1 AND to_agent = ?2 AND read_at IS NULL) AS unread,
           (SELECT COUNT(*) FROM messages WHERE scope = ?1 AND to_agent = ?2 AND read_at IS NULL AND kind = 'request') AS requests,
           (SELECT COUNT(*) FROM tasks WHERE scope = ?1 AND assignee = ?2 AND status IN ('in_progress', 'review')) AS mine`
      )
      .bind(scope, identity.name)
      .first();
    const profile = await db.prepare('SELECT nickname, bio FROM profiles WHERE identity = ?1').bind(identity.name).first();
    const guideRead = await db.prepare('SELECT version FROM guide_reads WHERE identity = ?1 AND scope = ?2').bind(identity.name, scope).first();
    const out = { name: identity.name, kind: identity.kind, scope, guideVersion: GUIDE_VERSION };
    if (!guideRead) {
      out.firstVisit = true;
      out.guideHint = '初めての参加です。まず guide を読んでください';
    } else if (guideRead.version !== GUIDE_VERSION) {
      out.guideHint = 'ガイドが更新されました。guide を読み直してください';
    }
    if (profile) {
      out.nickname = profile.nickname;
      if (profile.bio) out.bio = profile.bio;
    }
    out.unreadMessages = counts.unread;
    out.unreadRequests = counts.requests; // 返信・対応が要る未読（info を除く）
    out.myActiveTasks = counts.mine;
    out.hint = hints[identity.kind];
    if (!profile) out.profileHint = '呼び名が未設定です。ユーザーに名前を付けてもらったら set_profile で登録してください';
    return out;
  },

  async set_profile(args, { db, identity }) {
    return saveProfile(db, identity.name, args.nickname, args.bio);
  },

  // --- 協調 -----------------------------------------------------------------

  async guide(_args, ctx) {
    return readGuide(ctx);
  },

  async task_create(args, { db, scope, author }) {
    const title = str(args.title, 'title', MAX_NAME_LENGTH);
    const description = optionalStr(args.description, 'description', MAX_CONTENT_LENGTH);
    const claim = args.claim === true;
    const row = await db
      .prepare(
        `INSERT INTO tasks (scope, title, description, status, assignee, lease_expires_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ${claim ? `datetime('now', '+${LEASE_MINUTES} minutes')` : 'NULL'}, ?6)
         RETURNING id`
      )
      .bind(scope, title, description, claim ? 'in_progress' : 'open', claim ? author : null, author)
      .first();
    await addEvent(db, row.id, author, 'created', claim ? 'in_progress' : 'open', null);
    if (claim) await addEvent(db, row.id, author, 'claimed', 'in_progress', null);
    return { task: await getTask(db, scope, row.id) };
  },

  async task_list(args, { db, scope, author }) {
    const status = args.status === undefined ? 'active' : args.status;
    let statuses;
    if (status === 'active') statuses = ACTIVE_STATUSES;
    else if (status === 'all') statuses = TASK_STATUSES;
    else if (TASK_STATUSES.includes(status)) statuses = [status];
    else throw new ToolInputError(`status は active / ${TASK_STATUSES.join(' / ')} / all のどれかにしてください`);
    const mine = args.mine === true;

    const { results } = await db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM tasks
         WHERE scope = ?1 AND status IN (SELECT value FROM json_each(?2))
           ${mine ? 'AND assignee = ?3' : ''}
         ORDER BY updated_at DESC, id DESC
         LIMIT ${TASK_LIST_LIMIT + 1}`
      )
      .bind(...(mine ? [scope, JSON.stringify(statuses), author] : [scope, JSON.stringify(statuses)]))
      .all();
    const tasks = results.slice(0, TASK_LIST_LIMIT).map((r) => taskView(r, false));
    const nick = await nicknames(db, tasks.map((t) => t.assignee));
    for (const t of tasks) addNickname(t, 'assignee', nick);
    const out = { tasks };
    if (results.length > TASK_LIST_LIMIT) out.more = true;
    return out;
  },

  async task_get(args, { db, scope }) {
    const id = taskId(args.id);
    const task = await getTask(db, scope, id, true);
    if (!task) throw new ToolInputError(`タスク ${id} はありません`);
    const { results } = await db
      .prepare('SELECT actor, kind, status, note, created_at AS createdAt FROM task_events WHERE task_id = ?1 ORDER BY id')
      .bind(id)
      .all();
    const nick = await nicknames(db, [task.assignee, task.createdBy, ...results.map((e) => e.actor)]);
    addNickname(task, 'assignee', nick);
    addNickname(task, 'createdBy', nick);
    for (const e of results) addNickname(e, 'actor', nick);
    const out = { task, events: results };
    if (args.withKnowledge === true) {
      const knowledge = await knowledgeForTask(db, scope, task);
      if (knowledge.length) out.relatedKnowledge = knowledge;
    }
    return out;
  },

  async task_claim(args, { db, scope, author }) {
    const id = taskId(args.id);
    // 条件付きの UPDATE 1 文で引き受ける。同時に呼ばれても成功するのは 1 人だけ
    const res = await db
      .prepare(
        `UPDATE tasks
         SET assignee = ?3,
             status = CASE WHEN status = 'review' THEN 'review' ELSE 'in_progress' END,
             lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes'),
             updated_at = datetime('now')
         WHERE id = ?1 AND scope = ?2
           AND status IN ('open', 'in_progress', 'review')
           AND (assignee IS NULL OR assignee = ?3 OR lease_expires_at IS NULL OR lease_expires_at <= datetime('now'))`
      )
      .bind(id, scope, author)
      .run();
    const task = await getTask(db, scope, id);
    if (!task) throw new ToolInputError(`タスク ${id} はありません`);
    if (!changes(res)) {
      if (!ACTIVE_STATUSES.includes(task.status)) {
        return { claimed: false, task, reason: `このタスクは ${task.status} です` };
      }
      return { claimed: false, task, reason: `${task.assignee} が担当中です（期限 ${task.leaseExpiresAt} UTC）。別のタスクを選ぶか、send_message で相談してください` };
    }
    await addEvent(db, id, author, 'claimed', task.status, null);
    // 作業を始めるときに、関係のありそうな知識を添える（なければ出さない）
    const knowledge = await knowledgeForTask(db, scope, task);
    return knowledge.length ? { claimed: true, task, relatedKnowledge: knowledge } : { claimed: true, task };
  },

  async task_update(args, { db, scope, author, identity }) {
    const id = taskId(args.id);
    const status = args.status === undefined ? null : args.status;
    if (status !== null && !TASK_STATUSES.includes(status)) {
      throw new ToolInputError(`status は ${TASK_STATUSES.join(' / ')} のどれかにしてください`);
    }
    const note = optionalStr(args.note, 'note', MAX_CONTENT_LENGTH);
    if (status === null && note === null) throw new ToolInputError('status か note を指定してください');

    const current = await getTask(db, scope, id);
    if (!current) throw new ToolInputError(`タスク ${id} はありません`);
    const active = ACTIVE_STATUSES.includes(current.status);
    const mine = current.assignee === author;
    const isAdmin = identity.kind === 'admin';
    const expected = [current.assignee, current.leaseExpiresAt ?? null];

    if (status === null) {
      // メモだけ（誰でも書ける）。担当者なら期限を延ばす。
      // 読んでから書くまでに担当が変わっていたら延ばさない（新しい担当者の期限を古い担当者が延ばさないように）
      const extend = mine && active;
      await db
        .prepare(
          `UPDATE tasks SET updated_at = datetime('now')
             ${extend ? `, lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes')` : ''}
           WHERE id = ?1 AND scope = ?2 ${extend ? 'AND assignee IS ?3 AND lease_expires_at IS ?4' : ''}`
        )
        .bind(...(extend ? [id, scope, ...expected] : [id, scope]))
        .run();
      await addEvent(db, id, author, 'updated', current.status, note);
      return { task: await getTask(db, scope, id) };
    }

    // status を変えられるのは:
    //   終わっていないタスク … 担当者だけ（未担当・ほかの担当者のタスクは、先に task_claim で引き受ける）
    //   done / cancelled   … 作成者か最後の担当者が open に戻す（再開）ことだけ
    //   管理者トークン      … 例外としてどれでも
    if (!isAdmin) {
      if (active && !mine) {
        throw new ToolInputError(
          current.assignee && !current.expired
            ? `${current.assignee} が担当中なので status は変えられません。note だけ書くか、send_message で相談してください`
            : 'status を変えるには、先に task_claim で引き受けてください'
        );
      }
      if (!active) {
        if (status !== 'open') throw new ToolInputError(`このタスクは ${current.status} です。やり直すときは status: "open" で再開してください`);
        if (current.createdBy !== author && !mine) throw new ToolInputError('再開できるのは、タスクの作成者か最後の担当者だけです');
      }
    }

    let assignee;
    let lease;
    if (status === 'open') {
      assignee = null; // 手放す・再開する
      lease = 'NULL';
    } else if (status === 'in_progress' || status === 'review') {
      assignee = mine || !current.assignee ? author : current.assignee; // 管理者がほかの担当者のタスクを変えるときは担当を変えない
      lease = `datetime('now', '+${LEASE_MINUTES} minutes')`;
    } else {
      assignee = current.assignee || author; // done / cancelled は誰が終えたかを残す
      lease = 'NULL';
    }

    // 読んでから書くまでに担当が変わっていたら失敗させる（楽観的排他）
    const res = await db
      .prepare(
        `UPDATE tasks SET status = ?3, assignee = ?4, lease_expires_at = ${lease}, updated_at = datetime('now')
         WHERE id = ?1 AND scope = ?2 AND assignee IS ?5 AND lease_expires_at IS ?6`
      )
      .bind(id, scope, status, assignee, ...expected)
      .run();
    if (!changes(res)) throw new ToolInputError('ほかのエージェントが同時に更新しました。task_get で確認してからやり直してください');
    await addEvent(db, id, author, status === 'open' ? 'released' : 'updated', status, note);
    return { task: await getTask(db, scope, id) };
  },

  async task_handoff(args, { db, scope, author, identity }) {
    const id = taskId(args.id);
    const to = await agentName(db, args.to, 'to');
    const note = str(args.note, 'note', MAX_CONTENT_LENGTH);
    const status = args.status === undefined ? 'in_progress' : args.status;
    if (!['in_progress', 'review'].includes(status)) throw new ToolInputError('status は in_progress か review にしてください');

    const current = await getTask(db, scope, id);
    if (!current) throw new ToolInputError(`タスク ${id} はありません`);
    if (!ACTIVE_STATUSES.includes(current.status)) throw new ToolInputError(`このタスクは ${current.status} です`);
    // 渡せるのは担当者、未担当なら作成者（作ってすぐ誰かに頼む流れ）。管理者トークンは例外
    const mine = current.assignee === author;
    const unassignedMine = !current.assignee && current.createdBy === author;
    if (!mine && !unassignedMine && identity.kind !== 'admin') {
      throw new ToolInputError(
        current.assignee && !current.expired
          ? `${current.assignee} が担当中なので渡せません`
          : '渡すには、先に task_claim で引き受けてください'
      );
    }

    const res = await db
      .prepare(
        `UPDATE tasks SET status = ?3, assignee = ?4,
           lease_expires_at = datetime('now', '+${HANDOFF_LEASE_HOURS} hours'), updated_at = datetime('now')
         WHERE id = ?1 AND scope = ?2 AND assignee IS ?5 AND lease_expires_at IS ?6`
      )
      .bind(id, scope, status, to, current.assignee, current.leaseExpiresAt ?? null)
      .run();
    if (!changes(res)) throw new ToolInputError('ほかのエージェントが同時に更新しました。task_get で確認してからやり直してください');

    await db.batch([
      eventStmt(db, id, author, 'handoff', status, `→ ${to}: ${note}`),
      db.prepare('INSERT INTO messages (scope, to_agent, from_agent, body, task_id) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(scope, to, author, `タスク #${id}「${current.title}」を${status === 'review' ? 'レビュー依頼として' : ''}引き継ぎました: ${note}`, id),
    ]);
    const out = { task: await getTask(db, scope, id), notified: to };
    addNickname(out, 'notified', await nicknames(db, [to]));
    return out;
  },

  async send_message(args, { db, scope, author }) {
    const to = await agentName(db, args.to, 'to');
    const body = str(args.body, 'body', MAX_CONTENT_LENGTH);
    const kind = args.kind === undefined || args.kind === null ? 'request' : args.kind;
    if (!MESSAGE_KINDS.includes(kind)) throw new ToolInputError('kind は request か info にしてください');
    let task = null;
    if (args.taskId !== undefined && args.taskId !== null) {
      task = taskId(args.taskId, 'taskId');
      if (!(await getTask(db, scope, task))) throw new ToolInputError(`タスク ${task} はありません`);
    }
    const row = await db
      .prepare('INSERT INTO messages (scope, to_agent, from_agent, body, task_id, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id')
      .bind(scope, to, author, body, task, kind)
      .first();
    const out = { sent: true, id: row.id, to, kind };
    addNickname(out, 'to', await nicknames(db, [to]));
    return out;
  },

  async read_inbox(args, { db, scope, author }) {
    const includeRead = args.includeRead === true;
    const { results } = await db
      .prepare(
        `SELECT id, from_agent AS "from", body, task_id AS taskId, kind, created_at AS createdAt, read_at AS readAt
         FROM messages
         WHERE scope = ?1 AND to_agent = ?2 ${includeRead ? '' : 'AND read_at IS NULL'}
         ORDER BY id ${includeRead ? 'DESC' : 'ASC'}
         LIMIT ${INBOX_LIMIT + 1}`
      )
      .bind(scope, author)
      .all();
    const messages = results.slice(0, INBOX_LIMIT);
    const unreadIds = messages.filter((m) => !m.readAt).map((m) => m.id);
    if (unreadIds.length) {
      await db
        .prepare(`UPDATE messages SET read_at = datetime('now') WHERE id IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(unreadIds))
        .run();
    }
    const nick = await nicknames(db, messages.map((m) => m.from));
    const out = {
      messages: messages.map((m) => {
        const item = { id: m.id, from: m.from, body: m.body, createdAt: m.createdAt };
        addNickname(item, 'from', nick);
        if (m.taskId !== null) item.taskId = m.taskId;
        if (m.kind === 'info') item.kind = 'info'; // 返信不要（request は既定なので省く）
        if (includeRead) item.read = !!m.readAt;
        return item;
      }),
    };
    if (results.length > INBOX_LIMIT) out.more = true;
    return out;
  },

  async create_entities(args, { db, scope, author }) {
    const source = await sourceTask(db, scope, args.taskId);
    const entities = list(args.entities, 'entities').map((e, i) => ({
      name: str(e && e.name, `entities[${i}].name`, MAX_NAME_LENGTH),
      entityType: str(e && e.entityType, `entities[${i}].entityType`, MAX_NAME_LENGTH),
      observations: optionalStrings(e && e.observations, `entities[${i}].observations`),
    }));

    const hints = [];
    entities.forEach((e, i) => {
      const { error, hint } = checkEntity(e.name, e.entityType, scope);
      if (error) throw new ToolInputError(`entities[${i}]: ${error}`);
      if (hint) hints.push(hint);
    });
    const names = unique(entities.map((e) => e.name));
    const existing = await existingNames(db, scope, names);
    const seen = new Set(existing);
    const fresh = [];
    for (const e of entities) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      fresh.push(e);
    }

    if (fresh.length) {
      const payload = JSON.stringify(fresh);
      await db.batch([
        db.prepare(
          `INSERT OR IGNORE INTO entities (scope, name, entity_type, created_by)
           SELECT ?1, json_extract(value, '$.name'), json_extract(value, '$.entityType'), ?3
           FROM json_each(?2)`
        ).bind(scope, payload, author),
        db.prepare(
          `INSERT OR IGNORE INTO observations (entity_id, content, author, task_id)
           SELECT e.id, o.value, ?3, ?4
           FROM json_each(?2) AS j
           JOIN entities AS e ON e.scope = ?1 AND e.name = json_extract(j.value, '$.name')
           JOIN json_each(j.value, '$.observations') AS o`
        ).bind(scope, payload, author, source),
      ]);
    }

    const result = { created: fresh.map((e) => e.name) };
    if (existing.length) {
      result.skipped_existing = existing;
      result.hint = '既存エンティティには add_observations を使ってください';
    }
    if (hints.length) result.placement = unique(hints); // 置き場所の目安と違うもの（作成はされている）
    return result;
  },

  async create_relations(args, { db, scope, author }) {
    const relations = list(args.relations, 'relations').map((r, i) => relation(r, `relations[${i}]`));
    relations.forEach((r, i) => {
      const { ok, suggestion } = checkRelationType(r.relationType);
      if (ok) return;
      throw new ToolInputError(
        `relations[${i}].relationType: ${r.relationType} は使えません。${suggestion ? `${suggestion} のことですか？ ` : ''}使える種類: ${Object.keys(RELATION_TYPES).join(', ')}`
      );
    });
    const missing = await missingNames(db, scope, unique(relations.flatMap((r) => [r.from, r.to])));
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO relations (from_id, to_id, relation_type, created_by)
         SELECT f.id, t.id, json_extract(j.value, '$.relationType'), ?3
         FROM json_each(?2) AS j
         JOIN entities AS f ON f.scope = ?1 AND f.name = json_extract(j.value, '$.from')
         JOIN entities AS t ON t.scope = ?1 AND t.name = json_extract(j.value, '$.to')`
      )
      .bind(scope, JSON.stringify(relations), author)
      .run();
    const result = { created: changes(res) };
    if (missing.length) result.missing_entities = missing;
    return result;
  },

  async add_observations(args, { db, scope, author }) {
    const source = await sourceTask(db, scope, args.taskId);
    const items = list(args.observations, 'observations').map((o, i) => ({
      entityName: str(o && o.entityName, `observations[${i}].entityName`, MAX_NAME_LENGTH),
      contents: strings(o && o.contents, `observations[${i}].contents`),
    }));
    const missing = await missingNames(db, scope, unique(items.map((o) => o.entityName)));
    const payload = JSON.stringify(items);
    const [inserted] = await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO observations (entity_id, content, author, task_id)
         SELECT e.id, c.value, ?3, ?4
         FROM json_each(?2) AS j
         JOIN entities AS e ON e.scope = ?1 AND e.name = json_extract(j.value, '$.entityName')
         JOIN json_each(j.value, '$.contents') AS c`
      ).bind(scope, payload, author, source),
      db.prepare(
        `UPDATE entities SET updated_at = datetime('now')
         WHERE scope = ?1 AND name IN (SELECT json_extract(value, '$.entityName') FROM json_each(?2))`
      ).bind(scope, payload),
    ]);
    const result = { added: changes(inserted) };
    if (missing.length) result.missing_entities = missing;
    return result;
  },

  async delete_entities(args, { db, scope }) {
    const names = list(args.entityNames, 'entityNames').map((n, i) => str(n, `entityNames[${i}]`, MAX_NAME_LENGTH));
    const payload = JSON.stringify(names);
    const target = `SELECT id FROM entities WHERE scope = ?1 AND name IN (SELECT value FROM json_each(?2))`;
    const results = await db.batch([
      db.prepare(`DELETE FROM observations WHERE entity_id IN (${target})`).bind(scope, payload),
      db.prepare(`DELETE FROM relations WHERE from_id IN (${target}) OR to_id IN (${target})`).bind(scope, payload),
      db.prepare(`DELETE FROM entities WHERE scope = ?1 AND name IN (SELECT value FROM json_each(?2))`).bind(scope, payload),
    ]);
    return { deleted: changes(results[2]) };
  },

  async delete_observations(args, { db, scope }) {
    const items = list(args.deletions, 'deletions').map((d, i) => ({
      entityName: str(d && d.entityName, `deletions[${i}].entityName`, MAX_NAME_LENGTH),
      observations: strings(d && d.observations, `deletions[${i}].observations`),
    }));
    const res = await db
      .prepare(
        `DELETE FROM observations WHERE id IN (
           SELECT o.id
           FROM json_each(?2) AS j
           JOIN entities AS e ON e.scope = ?1 AND e.name = json_extract(j.value, '$.entityName')
           JOIN json_each(j.value, '$.observations') AS d
           JOIN observations AS o ON o.entity_id = e.id AND o.content = d.value
         )`
      )
      .bind(scope, JSON.stringify(items))
      .run();
    return { deleted: changes(res) };
  },

  async delete_relations(args, { db, scope }) {
    const relations = list(args.relations, 'relations').map((r, i) => relation(r, `relations[${i}]`));
    const res = await db
      .prepare(
        `DELETE FROM relations WHERE id IN (
           SELECT r.id
           FROM json_each(?2) AS j
           JOIN entities AS f ON f.scope = ?1 AND f.name = json_extract(j.value, '$.from')
           JOIN entities AS t ON t.scope = ?1 AND t.name = json_extract(j.value, '$.to')
           JOIN relations AS r ON r.from_id = f.id AND r.to_id = t.id
                              AND r.relation_type = json_extract(j.value, '$.relationType')
         )`
      )
      .bind(scope, JSON.stringify(relations))
      .run();
    return { deleted: changes(res) };
  },

  async search_nodes(args, { db, scope }) {
    const query = str(args.query, 'query', 500);
    const terms = searchTerms(query);
    if (!terms.length) throw new ToolInputError('query が空です');
    const hits = await rankEntities(db, [scope], terms, SEARCH_LIMIT + 1);

    const truncated = hits.length > SEARCH_LIMIT;
    const top = hits.slice(0, SEARCH_LIMIT);
    const obsByEntity = await observationsFor(db, top.map((h) => h.id));
    const lowered = terms.map((t) => t.toLowerCase());

    const results = top.map((h) => {
      const all = (obsByEntity.get(h.id) || []).map((o) => o.content);
      const matching = all.filter((c) => lowered.some((t) => c.toLowerCase().includes(t)));
      const rest = all.filter((c) => !matching.includes(c));
      const item = {
        name: h.name,
        entityType: h.entity_type,
        observations: [...matching, ...rest].slice(0, SEARCH_PREVIEW),
      };
      if (all.length > SEARCH_PREVIEW) item.observationCount = all.length;
      return item;
    });

    const out = { results };
    if (truncated) out.more = true;
    if (!results.length) out.hint = '一致なし。語を減らすか、別の言い方で検索してください';
    return out;
  },

  async open_nodes(args, { db, scope }) {
    const names = unique(list(args.names, 'names').map((n, i) => str(n, `names[${i}]`, MAX_NAME_LENGTH)));
    const withAuthors = args.withAuthors === true;
    const related = args.related === true;
    const depth = args.depth === undefined ? 2 : args.depth;
    if (related && ![1, 2].includes(depth)) throw new ToolInputError('depth は 1 か 2 にしてください');
    const { results: rows } = await db
      .prepare(
        `SELECT id, name, entity_type, created_by FROM entities
         WHERE scope = ?1 AND name IN (SELECT value FROM json_each(?2))`
      )
      .bind(scope, JSON.stringify(names))
      .all();

    const ids = rows.map((r) => r.id);
    const obsByEntity = await observationsFor(db, ids);

    let relations = [];
    if (ids.length) {
      const { results } = await db
        .prepare(
          `SELECT f.name AS "from", t.name AS "to", r.relation_type AS relationType
           FROM relations AS r
           JOIN entities AS f ON f.id = r.from_id
           JOIN entities AS t ON t.id = r.to_id
           WHERE r.from_id IN (SELECT value FROM json_each(?1))
              OR r.to_id   IN (SELECT value FROM json_each(?1))
           ORDER BY r.id
           LIMIT ${NEIGHBOR_LIMIT}`
        )
        .bind(JSON.stringify(ids))
        .all();
      relations = results;
    }

    const found = new Set(rows.map((r) => r.name));
    const nick = withAuthors
      ? await nicknames(db, [...rows.map((r) => r.created_by), ...[...obsByEntity.values()].flat().map((o) => o.author)])
      : new Map();
    const out = {
      entities: rows.map((r) => {
        const obs = obsByEntity.get(r.id) || [];
        if (!withAuthors) {
          // 既定は server-memory と同じ形（文字列の配列）。AI の利用量を抑えるため
          return { name: r.name, entityType: r.entity_type, observations: obs.map((o) => o.content) };
        }
        const e = { name: r.name, entityType: r.entity_type, createdBy: r.created_by };
        addNickname(e, 'createdBy', nick);
        e.observations = obs.map(({ taskId: t, ...o }) => addNickname(t ? { ...o, taskId: t } : o, 'author', nick));
        return e;
      }),
      relations,
    };
    if (related && ids.length) out.related = await relatedEntities(db, ids, depth);
    const notFound = names.filter((n) => !found.has(n));
    if (notFound.length) out.not_found = notFound;
    return out;
  },
};

// ---------------------------------------------------------------------------
// DB ヘルパー
// ---------------------------------------------------------------------------

async function existingNames(db, scope, names) {
  if (!names.length) return [];
  const { results } = await db
    .prepare(`SELECT name FROM entities WHERE scope = ?1 AND name IN (SELECT value FROM json_each(?2))`)
    .bind(scope, JSON.stringify(names))
    .all();
  const set = new Set(results.map((r) => r.name));
  return names.filter((n) => set.has(n));
}

async function missingNames(db, scope, names) {
  const existing = new Set(await existingNames(db, scope, names));
  return names.filter((n) => !existing.has(n));
}

async function observationsFor(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { results } = await db
    .prepare(
      `SELECT entity_id, content, author, created_at, task_id FROM observations
       WHERE entity_id IN (SELECT value FROM json_each(?1))
       ORDER BY id`
    )
    .bind(JSON.stringify(ids))
    .all();
  for (const r of results) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, []);
    map.get(r.entity_id).push({ content: r.content, author: r.author, createdAt: r.created_at, taskId: r.task_id });
  }
  return map;
}

const TASK_COLUMNS = `id, title, description, status, assignee, lease_expires_at, created_by, created_at, updated_at,
  (lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')) AS expired`;

async function getTask(db, scope, id, withDescription = true) {
  const row = await db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?1 AND scope = ?2`)
    .bind(id, scope)
    .first();
  return row ? taskView(row, withDescription) : null;
}

function taskView(r, withDescription) {
  const t = { id: r.id, title: r.title, status: r.status, assignee: r.assignee };
  if (withDescription && r.description) t.description = r.description;
  if (r.lease_expires_at) t.leaseExpiresAt = r.lease_expires_at;
  t.expired = !!r.expired && ACTIVE_STATUSES.includes(r.status);
  t.createdBy = r.created_by;
  t.updatedAt = r.updated_at;
  return t;
}

function eventStmt(db, id, actor, kind, status, note) {
  return db
    .prepare('INSERT INTO task_events (task_id, actor, kind, status, note) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, actor, kind, status, note);
}

async function addEvent(db, id, actor, kind, status, note) {
  await eventStmt(db, id, actor, kind, status, note).run();
}

/** 宛先のエージェント名。発行済みのエージェント・owner・github:<名前> だけを受け付ける（打ち間違いで届かないのを防ぐ） */
async function agentName(db, value, field) {
  const name = str(value, field, MAX_AGENT_NAME);
  if (name === 'owner' || /^github:[A-Za-z0-9-]+(\/[a-z0-9._-]+)?$/.test(name)) return name;
  const row = await db.prepare('SELECT name FROM agents WHERE name = ?1 AND revoked_at IS NULL').bind(name).first();
  if (row) return name;
  // 呼び名なら、その本人確認の名前に読み替える
  const byNickname = await db.prepare('SELECT identity FROM profiles WHERE nickname_key = ?1').bind(nicknameKey(name)).first();
  if (byNickname) return byNickname.identity;
  const { results } = await db
    .prepare(
      `SELECT a.name AS name, p.nickname AS nickname FROM agents AS a LEFT JOIN profiles AS p ON p.identity = a.name
       WHERE a.revoked_at IS NULL
       UNION
       SELECT p.identity, p.nickname FROM profiles AS p WHERE p.identity NOT IN (SELECT name FROM agents)
       ORDER BY 1`
    )
    .all();
  const known = ['owner', ...results.map((r) => (r.nickname ? `${r.nickname}（${r.name}）` : r.name))];
  throw new ToolInputError(`${field}: エージェント ${name} は登録されていません。登録済み: ${known.join(', ')}`);
}

/**
 * 呼び名と自己紹介を保存する（set_profile と確認画面で共用）。identity は本人確認の名前
 */
export async function saveProfile(db, identityName, nicknameValue, bioValue) {
  const identity = { name: identityName };
  const nickname = nicknameOf(nicknameValue);
  const key = nicknameKey(nickname);
  const bio = optionalStr(bioValue, 'bio', MAX_BIO);

  // 予約された名前・ほかのエージェントの本人確認の名前・ほかの人の呼び名とは重ねない（宛先が決まらなくなるため）
  if (['owner', 'admin'].includes(key) || key.startsWith('github')) {
    throw new ToolInputError(`${nickname} は予約されているので使えません`);
  }
  const clash = await db
    .prepare(
      `SELECT name AS identity FROM agents WHERE lower(name) = ?1 AND name <> ?2
       UNION ALL
       SELECT identity FROM profiles WHERE nickname_key = ?1 AND identity <> ?2
       LIMIT 1`
    )
    .bind(key, identity.name)
    .first();
  if (clash) throw new ToolInputError(`呼び名 ${nickname} は ${clash.identity} が使っています。別の名前にしてください`);

  try {
    await db
      .prepare(
        `INSERT INTO profiles (identity, nickname, nickname_key, bio) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (identity) DO UPDATE SET nickname = excluded.nickname, nickname_key = excluded.nickname_key,
           bio = excluded.bio, updated_at = datetime('now')`
      )
      .bind(identity.name, nickname, key, bio)
      .run();
  } catch (err) {
    // 同時に同じ呼び名を登録しようとしたとき（UNIQUE 制約）
    if (/UNIQUE/i.test(String(err && err.message))) throw new ToolInputError(`呼び名 ${nickname} はほかのエージェントが使っています`);
    throw err;
  }
  const out = { name: identity.name, nickname };
  if (bio) out.bio = bio;
  return out;
}

/** 知識を得たタスクの番号（任意）。同じスコープにあるタスクだけ受け付ける */
async function sourceTask(db, scope, value) {
  if (value === undefined || value === null) return null;
  const id = taskId(value, 'taskId');
  const row = await db.prepare('SELECT id FROM tasks WHERE id = ?1 AND scope = ?2').bind(id, scope).first();
  if (!row) throw new ToolInputError(`taskId: このスコープにタスク ${id} はありません`);
  return id;
}

/** 本人確認の名前 → 呼び名 の Map */
async function nicknames(db, names) {
  const list = unique(names.filter(Boolean));
  const map = new Map();
  if (!list.length) return map;
  const { results } = await db
    .prepare('SELECT identity, nickname FROM profiles WHERE identity IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(list))
    .all();
  for (const r of results) map.set(r.identity, r.nickname);
  return map;
}

/** obj[field] に呼び名があれば obj[field + 'Nickname'] に添える（なければ何も足さない。利用量を抑えるため） */
function addNickname(obj, field, map) {
  const n = obj[field] && map.get(obj[field]);
  if (n) obj[`${field}Nickname`] = n;
  return obj;
}

/**
 * 呼び名の重複を判定する形。全角・半角（NFKC）と大文字・小文字を同一視する。
 * 大文字にしてから小文字にすることで、ς / σ / Σ や ß / ss のような一対一でない対応もそろえる（Unicode の case folding に近い形）
 */
export function nicknameKey(nickname) {
  return nickname.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

/** 呼び名の検証。文字・数字で始まり、文字・数字・_ . - ・ だけ（空白・: / は宛先と紛れるので使えない） */
function nicknameOf(value) {
  const v = str(value, 'nickname', MAX_NICKNAME * 2).normalize('NFKC');
  if ([...v].length > MAX_NICKNAME) throw new ToolInputError(`nickname は ${MAX_NICKNAME} 文字以内にしてください`);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}_.\-・]*$/u.test(v)) {
    throw new ToolInputError('nickname は文字か数字で始め、文字・数字・_ . - ・ だけを使ってください（空白・: / は使えません）');
  }
  return v;
}

function taskId(value, field = 'id') {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(n) || n <= 0) throw new ToolInputError(`${field} はタスクの番号（正の整数）で指定してください`);
  return n;
}

function changes(res) {
  return (res && res.meta && res.meta.changes) || 0;
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

/** 入力の誤り。メッセージはそのまま利用者に見せてよい */
export class ToolInputError extends Error {}

function list(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError(`${field} は 1 件以上の配列で指定してください`);
  if (value.length > MAX_ITEMS) throw new ToolInputError(`${field} は 1 回 ${MAX_ITEMS} 件までです。分けて呼び出してください`);
  return value;
}

function str(value, field, max) {
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${field} は空でない文字列で指定してください`);
  const v = value.trim();
  if (v.length > max) throw new ToolInputError(`${field} は ${max} 文字以内にしてください`);
  return v;
}

function optionalStr(value, field, max) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  return str(value, field, max);
}

function strings(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError(`${field} は 1 件以上の文字列配列で指定してください`);
  if (value.length > MAX_ITEMS) throw new ToolInputError(`${field} は ${MAX_ITEMS} 件までです`);
  return unique(value.map((v, i) => str(v, `${field}[${i}]`, MAX_CONTENT_LENGTH)));
}

function optionalStrings(value, field) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.length === 0) return [];
  return strings(value, field);
}

function relation(r, field) {
  return {
    from: str(r && r.from, `${field}.from`, MAX_NAME_LENGTH),
    to: str(r && r.to, `${field}.to`, MAX_NAME_LENGTH),
    relationType: str(r && r.relationType, `${field}.relationType`, MAX_NAME_LENGTH),
  };
}

function unique(values) {
  return [...new Set(values)];
}


// ---------------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
