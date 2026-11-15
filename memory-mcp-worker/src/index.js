/**
 * memory-mcp — @modelcontextprotocol/server-memory 互換のリモート MCP サーバー
 * Cloudflare Workers + D1 で動作します。
 *
 * エンドポイント（スコープは URL で決まります）
 *   POST /mcp/global          … プロジェクト横断の共通ナレッジ
 *   POST /mcp/p/<slug>        … プロジェクトごとのナレッジ
 *
 * 認証: Authorization: Bearer <MEMORY_TOKEN>（wrangler secret で設定）
 *
 * server-memory との違い
 *   - read_graph はありません（全件読み込みによるトークン浪費を防ぐため）
 *   - search_nodes は上位 10 件・各 observation は最大 3 件のプレビューを返します
 *   - open_nodes は指定ノードに接続するリレーションも返します（近傍の把握用）
 */

const SERVER_INFO = { name: 'memory-mcp', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const MAX_ITEMS = 20;          // 1 回のツール呼び出しで扱う最大件数
const MAX_NAME_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2000;
const SEARCH_LIMIT = 10;
const SEARCH_PREVIEW = 3;
const NEIGHBOR_LIMIT = 50;

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

const entitySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'エンティティ名（例: Decision:myapp/use-sqlite）' },
    entityType: { type: 'string', description: 'エンティティの種別（例: Decision）' },
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

const TOOLS = [
  {
    name: 'create_entities',
    description: `新しいエンティティを作成します（最大 ${MAX_ITEMS} 件）。既に存在する名前はスキップされるので、既存エンティティには add_observations を使ってください。`,
    inputSchema: {
      type: 'object',
      properties: { entities: { type: 'array', items: entitySchema, maxItems: MAX_ITEMS } },
      required: ['entities'],
    },
  },
  {
    name: 'create_relations',
    description: `エンティティ間のリレーションを作成します（最大 ${MAX_ITEMS} 件）。両端のエンティティが存在している必要があります。`,
    inputSchema: {
      type: 'object',
      properties: { relations: { type: 'array', items: relationSchema, maxItems: MAX_ITEMS } },
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
    description: `名前・種別・observation を部分一致で検索します。空白区切りの複数語は、より多く一致したものが上位になります。上位 ${SEARCH_LIMIT} 件と observation のプレビュー（各 ${SEARCH_PREVIEW} 件）を返すので、全文は open_nodes で取得してください。`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '検索語（空白区切りで最大 5 語）' } },
      required: ['query'],
    },
  },
  {
    name: 'open_nodes',
    description: `名前を指定してエンティティを取得します（最大 ${MAX_ITEMS} 件）。全 observation と、接続するリレーションを返します。`,
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, maxItems: MAX_ITEMS } },
      required: ['names'],
    },
  },
];

// ---------------------------------------------------------------------------
// エントリーポイント
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response('memory-mcp is running\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const scope = parseScope(url.pathname);
    if (!scope) return jsonResponse({ error: 'not found' }, 404);

    if (!isAuthorized(request, env)) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

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

    const ctx = { db: env.DB, scope };

    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
      return responses.length ? jsonResponse(responses) : new Response(null, { status: 202 });
    }

    const response = await handleMessage(body, ctx);
    return response ? jsonResponse(response) : new Response(null, { status: 202 });
  },
};

function parseScope(pathname) {
  if (/^\/mcp\/global\/?$/.test(pathname)) return 'global';
  const m = pathname.match(/^\/mcp\/p\/([a-z0-9][a-z0-9-]{0,62})\/?$/);
  return m ? `p:${m[1]}` : null;
}

function isAuthorized(request, env) {
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
        capabilities: { tools: { listChanged: false } },
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
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

function scopeInstructions(scope) {
  return scope === 'global'
    ? 'プロジェクト横断の共通ナレッジ（Lesson / Convention / Tech / Person）。プロジェクト固有の内容は書かない。'
    : `プロジェクト ${scope.slice(2)} のナレッジ。まず open_nodes ["Project:${scope.slice(2)}"] でハブを確認する。`;
}

async function callTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return toolError(`Unknown tool: ${name}`);
  try {
    const result = await handler(args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
  async create_entities(args, { db, scope }) {
    const entities = list(args.entities, 'entities').map((e, i) => ({
      name: str(e && e.name, `entities[${i}].name`, MAX_NAME_LENGTH),
      entityType: str(e && e.entityType, `entities[${i}].entityType`, MAX_NAME_LENGTH),
      observations: optionalStrings(e && e.observations, `entities[${i}].observations`),
    }));

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
          `INSERT OR IGNORE INTO entities (scope, name, entity_type)
           SELECT ?1, json_extract(value, '$.name'), json_extract(value, '$.entityType')
           FROM json_each(?2)`
        ).bind(scope, payload),
        db.prepare(
          `INSERT OR IGNORE INTO observations (entity_id, content)
           SELECT e.id, o.value
           FROM json_each(?2) AS j
           JOIN entities AS e ON e.scope = ?1 AND e.name = json_extract(j.value, '$.name')
           JOIN json_each(j.value, '$.observations') AS o`
        ).bind(scope, payload),
      ]);
    }

    const result = { created: fresh.map((e) => e.name) };
    if (existing.length) {
      result.skipped_existing = existing;
      result.hint = '既存エンティティには add_observations を使ってください';
    }
    return result;
  },

  async create_relations(args, { db, scope }) {
    const relations = list(args.relations, 'relations').map((r, i) => relation(r, `relations[${i}]`));
    const missing = await missingNames(db, scope, unique(relations.flatMap((r) => [r.from, r.to])));
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO relations (from_id, to_id, relation_type)
         SELECT f.id, t.id, json_extract(j.value, '$.relationType')
         FROM json_each(?2) AS j
         JOIN entities AS f ON f.scope = ?1 AND f.name = json_extract(j.value, '$.from')
         JOIN entities AS t ON t.scope = ?1 AND t.name = json_extract(j.value, '$.to')`
      )
      .bind(scope, JSON.stringify(relations))
      .run();
    const result = { created: changes(res) };
    if (missing.length) result.missing_entities = missing;
    return result;
  },

  async add_observations(args, { db, scope }) {
    const items = list(args.observations, 'observations').map((o, i) => ({
      entityName: str(o && o.entityName, `observations[${i}].entityName`, MAX_NAME_LENGTH),
      contents: strings(o && o.contents, `observations[${i}].contents`),
    }));
    const missing = await missingNames(db, scope, unique(items.map((o) => o.entityName)));
    const payload = JSON.stringify(items);
    const [inserted] = await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO observations (entity_id, content)
         SELECT e.id, c.value
         FROM json_each(?2) AS j
         JOIN entities AS e ON e.scope = ?1 AND e.name = json_extract(j.value, '$.entityName')
         JOIN json_each(j.value, '$.contents') AS c`
      ).bind(scope, payload),
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
    const terms = unique(query.split(/\s+/).filter(Boolean)).slice(0, 5);
    if (!terms.length) throw new ToolInputError('query が空です');

    // ?1 = scope, ?2.. = 各語の LIKE パターン
    const params = [scope, ...terms.map((t) => `%${escapeLike(t)}%`)];
    const scoreExpr = terms
      .map((_, i) => {
        const p = `?${i + 2}`;
        return `(CASE WHEN e.name LIKE ${p} ESCAPE '\\'
                        OR e.entity_type LIKE ${p} ESCAPE '\\'
                        OR EXISTS (SELECT 1 FROM observations AS o
                                   WHERE o.entity_id = e.id AND o.content LIKE ${p} ESCAPE '\\')
                      THEN 1 ELSE 0 END)`;
      })
      .join(' + ');

    const { results: hits } = await db
      .prepare(
        `SELECT id, name, entity_type, score FROM (
           SELECT e.id, e.name, e.entity_type, e.updated_at, (${scoreExpr}) AS score
           FROM entities AS e WHERE e.scope = ?1
         ) WHERE score > 0
         ORDER BY score DESC, updated_at DESC
         LIMIT ${SEARCH_LIMIT + 1}`
      )
      .bind(...params)
      .all();

    const truncated = hits.length > SEARCH_LIMIT;
    const top = hits.slice(0, SEARCH_LIMIT);
    const obsByEntity = await observationsFor(db, top.map((h) => h.id));
    const lowered = terms.map((t) => t.toLowerCase());

    const results = top.map((h) => {
      const all = obsByEntity.get(h.id) || [];
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
    const { results: rows } = await db
      .prepare(
        `SELECT id, name, entity_type FROM entities
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
    const out = {
      entities: rows.map((r) => ({
        name: r.name,
        entityType: r.entity_type,
        observations: obsByEntity.get(r.id) || [],
      })),
      relations,
    };
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
      `SELECT entity_id, content FROM observations
       WHERE entity_id IN (SELECT value FROM json_each(?1))
       ORDER BY id`
    )
    .bind(JSON.stringify(ids))
    .all();
  for (const r of results) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, []);
    map.get(r.entity_id).push(r.content);
  }
  return map;
}

function changes(res) {
  return (res && res.meta && res.meta.changes) || 0;
}

// ---------------------------------------------------------------------------
// 入力検証
// ---------------------------------------------------------------------------

class ToolInputError extends Error {}

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

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
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
