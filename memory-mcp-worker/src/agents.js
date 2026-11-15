/**
 * エージェントの識別。
 *
 * 誰がリクエストしたか（identity）を、次の 3 種類で表します。
 *   admin … MEMORY_TOKEN（管理者。エージェントの発行・失効もできる）。name は "owner"
 *   agent … エージェントごとのトークン（mca_ で始まる）。name は発行時に付けた名前
 *   user  … OAuth でログインした人。name は "github:<ユーザー名>/<アプリ名>"（例 github:alice/chatgpt）。
 *           アプリ名は接続元の自己申告で、わからなければ "github:<ユーザー名>"
 *
 * 管理用のエンドポイント（MEMORY_TOKEN でだけ使える）
 *   GET    /admin/agents          一覧
 *   POST   /admin/agents          {"name": "..."} で発行。同じ名前なら発行し直し（古いトークンは使えなくなる）
 *   DELETE /admin/agents/<name>   失効
 */

export const AGENT_TOKEN_PREFIX = 'mca_';
const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function adminIdentity() {
  return { kind: 'admin', name: 'owner' };
}

export function userIdentity(login, clientName) {
  const client = clientSlug(clientName);
  return { kind: 'user', name: client ? `github:${login}/${client}` : `github:${login}` };
}

/** アプリ名を書き手のラベル用に整える（例 "ChatGPT" → "chatgpt"、"Claude Desktop" → "claude-desktop"） */
export function clientSlug(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 32)
    .replace(/[-._]+$/, '');
}

/** Authorization ヘッダーの Bearer トークンを取り出す */
export function bearerToken(request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** エージェントのトークンなら identity を返す。違えば null */
export async function resolveAgent(db, token) {
  if (!token || !token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = await db
    .prepare('SELECT name FROM agents WHERE token_hash = ?1 AND revoked_at IS NULL')
    .bind(await sha256(token))
    .first();
  return row ? { kind: 'agent', name: row.name } : null;
}

/** /admin/agents の処理。呼び出し側で管理者の認証を済ませておくこと */
export async function handleAdmin(request, env) {
  const { pathname } = new URL(request.url);
  const db = env.DB;

  if (pathname === '/admin/agents' && request.method === 'GET') {
    const { results } = await db
      .prepare('SELECT name, created_at AS createdAt, revoked_at AS revokedAt FROM agents ORDER BY name')
      .all();
    return Response.json({ agents: results });
  }

  if (pathname === '/admin/agents' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'JSON で {"name": "..."} を送ってください' }, { status: 400 });
    }
    const name = body && typeof body.name === 'string' ? body.name.trim() : '';
    if (!AGENT_NAME.test(name)) {
      return Response.json({ error: 'name は英小文字・数字・. _ - の 63 文字以内で、先頭は英小文字か数字にしてください' }, { status: 400 });
    }
    const token = AGENT_TOKEN_PREFIX + randomHex(32);
    await db
      .prepare(
        `INSERT INTO agents (name, token_hash) VALUES (?1, ?2)
         ON CONFLICT (name) DO UPDATE SET token_hash = excluded.token_hash, created_at = datetime('now'), revoked_at = NULL`
      )
      .bind(name, await sha256(token))
      .run();
    // トークンはここでしか返さない（サーバーにはハッシュだけが残る）
    return Response.json({ name, token }, { status: 201 });
  }

  const m = pathname.match(/^\/admin\/agents\/([^/]+)$/);
  if (m && request.method === 'DELETE') {
    const name = decodeURIComponent(m[1]);
    const res = await db
      .prepare("UPDATE agents SET revoked_at = datetime('now') WHERE name = ?1 AND revoked_at IS NULL")
      .bind(name)
      .run();
    const revoked = (res.meta && res.meta.changes) || 0;
    return revoked ? Response.json({ name, revoked: true }) : Response.json({ error: 'not found' }, { status: 404 });
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
