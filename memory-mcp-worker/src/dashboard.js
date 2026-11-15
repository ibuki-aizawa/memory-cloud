/**
 * Web の確認画面（ダッシュボード）。人がブラウザで、タスク・AI どうしのメッセージ・記憶の書き手・エージェントを見るための
 * 読み取り専用のページです。OSS 版は 1 人で使う前提で、管理者トークン（MEMORY_TOKEN）でログインします。
 *
 *   GET  /dashboard                  概要（スコープごとの件数）。未ログインならログイン画面
 *   POST /dashboard/login            管理者トークンを確かめて、セッションの Cookie を発行する
 *   POST /dashboard/logout           ログアウト（all=1 なら、すべてのブラウザのログインを消す）
 *   GET  /dashboard/tasks?scope=     タスクの一覧（状態ごと）。status= で 1 つの状態をページングして見る
 *   GET  /dashboard/tasks/<id>?scope= タスクの詳細（経過と関係するメッセージ）
 *   GET  /dashboard/messages?scope=  メッセージのやり取り（新しい順、ページング）
 *   GET  /dashboard/memory?scope=    記憶の書き込み（誰がいつ書いたか、新しい順、ページング）
 *   GET  /dashboard/agents           エージェントと呼び名
 *
 * セキュリティ（タスク #4・#5 での Codex の意見を反映）
 *   - HTTPS だけ（localhost を除く）。HTTP で来たら HTTPS に転送する
 *   - セッションはサーバー側（D1 の dashboard_sessions）に記録し、Cookie にはランダムな ID だけを入れる（D1 にはそのハッシュ）。
 *     ログアウトで消すので、コピーされた Cookie も使えなくなる。Cookie は HttpOnly / Secure / SameSite=Strict、有効期限 8 時間
 *   - ログインの試行は IP ごとに 10 分で 10 回まで。1 回の UPDATE で数えるので、同時に送られても上限を超えない
 *   - POST は同じオリジンからだけ受け付ける。画面は CSP で外部の読み込み・スクリプトを禁止し、表示する値はすべてエスケープする
 *   - 読み取り専用。トークンやそのハッシュは表示しない
 */

const COOKIE = 'mc_dash';
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 600;
const LOGIN_MAX_ATTEMPTS = 10;
const PAGE_SIZE = 50;
const BOARD_COLUMN_LIMIT = 30;  // タスクの一覧で、状態ごとに表示する件数
const DETAIL_LIMIT = 200;       // タスクの詳細で表示する経過・メッセージの件数（新しいもの）
const SCOPE_RE = /^(global|p:[a-z0-9][a-z0-9-]{0,62})$/;
const ACTIVE = ['open', 'in_progress', 'review'];
const STATUS_LABEL = { open: '未着手', in_progress: '作業中', review: 'レビュー', done: '完了', cancelled: '取りやめ' };

export function isDashboardPath(pathname) {
  return pathname === '/dashboard' || pathname.startsWith('/dashboard/');
}

export async function handleDashboard(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/dashboard';
  if (!env.MEMORY_TOKEN) return html(503, '確認画面は使えません', '<p>MEMORY_TOKEN が設定されていません。</p>');
  if (url.protocol !== 'https:' && !isLocalhost(url.hostname)) {
    // トークンを暗号化なしで送らせない
    if (request.method !== 'GET') return html(403, 'HTTPS で開いてください', '');
    url.protocol = 'https:';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }

  if (request.method === 'POST') {
    if (!sameOrigin(request, url)) return html(403, '受け付けられません', '<p>別のサイトからの送信は受け付けません。</p>');
    if (path === '/dashboard/login') return login(request, env);
    if (path === '/dashboard/logout') return logout(request, env);
    return html(404, '見つかりません', '');
  }
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });

  if (!(await validSession(request, env.DB))) {
    return path === '/dashboard'
      ? loginPage()
      : new Response(null, { status: 302, headers: { Location: '/dashboard', 'Cache-Control': 'no-store' } });
  }

  const ctx = { db: env.DB, tz: env.DASHBOARD_TIMEZONE || 'Asia/Tokyo', url };
  ctx.nick = await profileMap(ctx.db);
  try {
    if (path === '/dashboard') return await overview(ctx);
    if (path === '/dashboard/agents') return await agentsPage(ctx);
    const scope = url.searchParams.get('scope') || 'global';
    if (!SCOPE_RE.test(scope)) return html(400, 'スコープが正しくありません', '<p>scope は global か p:&lt;プロジェクト略称&gt; です。</p>');
    ctx.scope = scope;
    if (path === '/dashboard/tasks') return await tasksPage(ctx);
    const m = path.match(/^\/dashboard\/tasks\/(\d+)$/);
    if (m) return await taskPage(ctx, Number(m[1]));
    if (path === '/dashboard/messages') return await messagesPage(ctx);
    if (path === '/dashboard/memory') return await memoryPage(ctx);
  } catch (err) {
    console.error(err);
    return html(500, 'エラー', '<p>表示できませんでした。データベースの変更（npm run db:migrate）が済んでいるか確かめてください。</p>');
  }
  return html(404, '見つかりません', '');
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

async function login(request, env) {
  const db = env.DB;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // 試行を先に数える（正しいトークンでも数える）。区切りの 10 分を過ぎていたら 1 からやり直す
  const counted = await db
    .prepare(
      `INSERT INTO dashboard_login_attempts (ip, attempts, window_start) VALUES (?1, 1, datetime('now'))
       ON CONFLICT (ip) DO UPDATE SET
         attempts = CASE WHEN window_start <= datetime('now', '-${LOGIN_WINDOW_SECONDS} seconds') THEN 1 ELSE attempts + 1 END,
         window_start = CASE WHEN window_start <= datetime('now', '-${LOGIN_WINDOW_SECONDS} seconds') THEN datetime('now') ELSE window_start END
       RETURNING attempts`
    )
    .bind(ip)
    .first();
  if (counted.attempts > LOGIN_MAX_ATTEMPTS) {
    return loginPage('ログインの試行が多すぎます。10 分ほど待ってからやり直してください。', 429);
  }

  let token = '';
  try {
    const form = await request.formData();
    token = String(form.get('token') || '').trim();
  } catch {
    // 空として扱う
  }
  if (!token || !equalText(token, env.MEMORY_TOKEN)) return loginPage('管理者トークンが違います。', 401);

  const id = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await db.batch([
    db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= datetime('now')"),
    db.prepare(`INSERT INTO dashboard_sessions (id_hash, expires_at) VALUES (?1, datetime('now', '+${SESSION_SECONDS} seconds'))`).bind(await sha256(id)),
    db.prepare('DELETE FROM dashboard_login_attempts WHERE ip = ?1').bind(ip),
  ]);
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/dashboard',
      'Set-Cookie': `${COOKIE}=${id}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
      'Cache-Control': 'no-store',
    },
  });
}

async function logout(request, env) {
  const db = env.DB;
  const id = sessionId(request);
  let all = false;
  try {
    all = (await request.formData()).get('all') === '1';
  } catch {
    // 通常のログアウト
  }
  // すべてのブラウザから消すのは、ログイン中のブラウザからだけ
  if (all && (await validSession(request, db))) await db.prepare('DELETE FROM dashboard_sessions').run();
  else if (id) await db.prepare('DELETE FROM dashboard_sessions WHERE id_hash = ?1').bind(await sha256(id)).run();
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/dashboard',
      'Set-Cookie': `${COOKIE}=; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      'Cache-Control': 'no-store',
    },
  });
}

function sessionId(request) {
  const cookie = (request.headers.get('Cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`));
  const id = cookie && cookie.slice(COOKIE.length + 1);
  return id && /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null;
}

async function validSession(request, db) {
  const id = sessionId(request);
  if (!id) return false;
  const row = await db
    .prepare("SELECT 1 AS ok FROM dashboard_sessions WHERE id_hash = ?1 AND expires_at > datetime('now')")
    .bind(await sha256(id))
    .first();
  return !!row;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function equalText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(x, y);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * 同じオリジンからの送信か。Origin を優先し、Origin がない・"null"（リファラーを送らない設定のときなど）なら
 * ブラウザが付ける Sec-Fetch-Site で判断する（どちらもページの JavaScript からは偽れない）
 */
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') return origin === url.origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

function loginPage(message = '', status = 200) {
  const body = `
${message ? `<p class="warn">${esc(message)}</p>` : ''}
<p>memory-mcp の記憶・タスク・メッセージを見るには、管理者トークン（MEMORY_TOKEN）を入力してください。</p>
<form method="post" action="/dashboard/login" class="login">
  <input type="password" name="token" autocomplete="current-password" required aria-label="管理者トークン" placeholder="管理者トークン">
  <button type="submit">ログイン</button>
</form>
<p class="muted">ログインは 8 時間で切れます。トークンはこのブラウザに保存されません。</p>`;
  return html(status, 'memory-mcp 確認画面', body, { nav: false });
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

async function overview({ db }) {
  const { results } = await db
    .prepare(
      `SELECT s.scope,
         (SELECT COUNT(*) FROM entities WHERE scope = s.scope) AS entities,
         (SELECT COUNT(*) FROM tasks WHERE scope = s.scope AND status IN ('open', 'in_progress', 'review')) AS active,
         (SELECT COUNT(*) FROM tasks WHERE scope = s.scope AND status IN ('in_progress', 'review')
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')) AS expired,
         (SELECT COUNT(*) FROM messages WHERE scope = s.scope AND read_at IS NULL AND kind = 'request') AS unread
       FROM (SELECT scope FROM entities UNION SELECT scope FROM tasks UNION SELECT scope FROM messages) AS s
       ORDER BY s.scope = 'global' DESC, s.scope`
    )
    .all();
  const rows = results
    .map((r) => {
      const q = `?scope=${encodeURIComponent(r.scope)}`;
      return `<tr>
  <td><strong>${esc(scopeLabel(r.scope))}</strong></td>
  <td class="num"><a href="/dashboard/memory${q}">${r.entities}</a></td>
  <td class="num"><a href="/dashboard/tasks${q}">${r.active}</a>${r.expired ? ` <span class="badge warn">期限切れ ${r.expired}</span>` : ''}</td>
  <td class="num"><a href="/dashboard/messages${q}">${r.unread}</a></td>
</tr>`;
    })
    .join('');
  const body = results.length
    ? `<table>
<thead><tr><th>スコープ</th><th class="num">記憶</th><th class="num">進行中のタスク</th><th class="num">未読の依頼</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : '<p class="muted">まだ記憶もタスクもありません。</p>';
  return html(200, '概要', body);
}

const TASK_COLS = `id, title, status, assignee, lease_expires_at, created_by, updated_at,
  (lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')) AS expired`;

function taskCard(t, scope, nick, tz) {
  return `<li class="card">
  <a href="/dashboard/tasks/${t.id}?scope=${encodeURIComponent(scope)}">#${t.id} ${esc(t.title)}</a>
  <div class="meta">${t.assignee ? `担当 ${who(t.assignee, nick)}` : '<span class="muted">未担当</span>'}
    ${t.expired && ACTIVE.includes(t.status) ? '<span class="badge warn">期限切れ</span>' : ''}
    <span class="muted">· ${esc(time(t.updated_at, tz))}</span></div>
</li>`;
}

async function tasksPage(ctx) {
  const { db, scope, nick, tz, url } = ctx;
  const status = url.searchParams.get('status');
  if (status) return taskStatusPage(ctx, status);

  const { results: counts } = await db
    .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE scope = ?1 GROUP BY status')
    .bind(scope)
    .all();
  const total = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const column = async (st, label, statuses) => {
    const { results } = await db
      .prepare(
        `SELECT ${TASK_COLS} FROM tasks WHERE scope = ?1 AND status IN (SELECT value FROM json_each(?2))
         ORDER BY updated_at DESC, id DESC LIMIT ${BOARD_COLUMN_LIMIT}`
      )
      .bind(scope, JSON.stringify(statuses))
      .all();
    const n = statuses.reduce((sum, x) => sum + (total[x] || 0), 0);
    const more = n > results.length
      ? `<p><a href="/dashboard/tasks?scope=${encodeURIComponent(scope)}&amp;status=${st}">すべて見る（${n} 件）</a></p>`
      : '';
    return `<section class="col">
  <h2>${label} <span class="muted">${n}</span></h2>
  <ul class="cards">${results.map((t) => taskCard(t, scope, nick, tz)).join('') || '<li class="muted">なし</li>'}</ul>
  ${more}
</section>`;
  };
  const columns = await Promise.all([
    ...ACTIVE.map((st) => column(st, STATUS_LABEL[st], [st])),
    column('closed', '完了・取りやめ', ['done', 'cancelled']),
  ]);
  const body = `${scopeNav(scope, 'tasks')}
<div class="board">
${columns.join('\n')}
</div>
<p class="muted">状態ごとに新しい ${BOARD_COLUMN_LIMIT} 件を表示しています。</p>`;
  return html(200, `タスク — ${scopeLabel(scope)}`, body);
}

/** 1 つの状態のタスクを、新しい順にページングして見る */
async function taskStatusPage({ db, scope, nick, tz, url }, status) {
  const statuses = status === 'closed' ? ['done', 'cancelled'] : [status];
  if (!statuses.every((x) => STATUS_LABEL[x])) return html(400, '状態が正しくありません', scopeNav(scope, 'tasks'));
  const before = pageCursor(url);
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLS} FROM tasks WHERE scope = ?1 AND status IN (SELECT value FROM json_each(?2)) ${before ? 'AND id < ?3' : ''}
       ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`
    )
    .bind(...(before ? [scope, JSON.stringify(statuses), before] : [scope, JSON.stringify(statuses)]))
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const label = status === 'closed' ? '完了・取りやめ' : STATUS_LABEL[status];
  const body = `${scopeNav(scope, 'tasks')}
<ul class="cards">${page.map((t) => taskCard(t, scope, nick, tz)).join('') || '<li class="muted">なし</li>'}</ul>
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `タスク（${label}） — ${scopeLabel(scope)}`, body);
}

async function taskPage({ db, scope, nick, tz }, id) {
  const t = await db
    .prepare(
      `SELECT *, (lease_expires_at IS NOT NULL AND lease_expires_at <= datetime('now')) AS expired
       FROM tasks WHERE id = ?1 AND scope = ?2`
    )
    .bind(id, scope)
    .first();
  if (!t) return html(404, 'タスクが見つかりません', scopeNav(scope, 'tasks'));
  // 新しいものから上限まで取り、古い順に並べ直す
  const { results: eventsDesc } = await db
    .prepare(`SELECT * FROM task_events WHERE task_id = ?1 ORDER BY id DESC LIMIT ${DETAIL_LIMIT + 1}`)
    .bind(id)
    .all();
  const { results: messagesDesc } = await db
    .prepare(`SELECT * FROM messages WHERE task_id = ?1 AND scope = ?2 ORDER BY id DESC LIMIT ${DETAIL_LIMIT + 1}`)
    .bind(id, scope)
    .all();
  const events = eventsDesc.slice(0, DETAIL_LIMIT).reverse();
  const messages = messagesDesc.slice(0, DETAIL_LIMIT).reverse();
  const omitted = (list) => (list.length > DETAIL_LIMIT ? `<p class="muted">古いものは省略しています（新しい ${DETAIL_LIMIT} 件を表示）。</p>` : '');
  const kindLabel = { created: '作成', claimed: '引き受け', updated: '更新', handoff: '引き継ぎ', released: '手放す' };

  const body = `${scopeNav(scope, 'tasks')}
<dl class="facts">
  <dt>状態</dt><dd>${esc(STATUS_LABEL[t.status] || t.status)}${t.expired && ACTIVE.includes(t.status) ? ' <span class="badge warn">期限切れ</span>' : ''}</dd>
  <dt>担当</dt><dd>${t.assignee ? who(t.assignee, nick) : '<span class="muted">未担当</span>'}</dd>
  <dt>期限</dt><dd>${t.lease_expires_at ? esc(time(t.lease_expires_at, tz)) : '<span class="muted">なし</span>'}</dd>
  <dt>作成</dt><dd>${who(t.created_by, nick)} · ${esc(time(t.created_at, tz))}</dd>
</dl>
${t.description ? `<div class="text">${multiline(t.description)}</div>` : ''}
<h2>経過</h2>
${omitted(eventsDesc)}
<ol class="timeline">${events
    .map(
      (e) => `<li><span class="muted">${esc(time(e.created_at, tz))}</span> ${who(e.actor, nick)}
  <strong>${esc(kindLabel[e.kind] || e.kind)}</strong>${e.status ? ` → ${esc(STATUS_LABEL[e.status] || e.status)}` : ''}
  ${e.note ? `<div class="text">${multiline(e.note)}</div>` : ''}</li>`
    )
    .join('')}</ol>
${messages.length ? `<h2>関係するメッセージ</h2>${omitted(messagesDesc)}${messageList(messages, nick, tz, scope)}` : ''}`;
  return html(200, `#${t.id} ${t.title}`, body);
}

async function messagesPage({ db, scope, nick, tz, url }) {
  const before = pageCursor(url);
  const { results } = await db
    .prepare(
      `SELECT * FROM messages WHERE scope = ?1 ${before ? 'AND id < ?2' : ''}
       ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`
    )
    .bind(...(before ? [scope, before] : [scope]))
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const body = `${scopeNav(scope, 'messages')}
${page.length ? messageList(page, nick, tz, scope) : '<p class="muted">メッセージはありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `メッセージ — ${scopeLabel(scope)}`, body);
}

async function memoryPage({ db, scope, nick, tz, url }) {
  const before = pageCursor(url);
  const { results } = await db
    .prepare(
      `SELECT o.id, o.content, o.author, o.created_at, e.name, e.entity_type
       FROM observations AS o JOIN entities AS e ON e.id = o.entity_id
       WHERE e.scope = ?1 ${before ? 'AND o.id < ?2' : ''}
       ORDER BY o.id DESC LIMIT ${PAGE_SIZE + 1}`
    )
    .bind(...(before ? [scope, before] : [scope]))
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const rows = page
    .map(
      (o) => `<tr>
  <td class="nowrap muted">${esc(time(o.created_at, tz))}</td>
  <td>${o.author ? who(o.author, nick) : '<span class="muted">不明</span>'}</td>
  <td><code>${esc(o.name)}</code></td>
  <td>${esc(o.content)}</td>
</tr>`
    )
    .join('');
  const body = `${scopeNav(scope, 'memory')}
${page.length ? `<table><thead><tr><th>日時</th><th>書き手</th><th>エンティティ</th><th>observation</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">記憶はありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `記憶の書き込み — ${scopeLabel(scope)}`, body);
}

async function agentsPage({ db, tz }) {
  const { results: agents } = await db
    .prepare(
      `SELECT a.name, a.created_at, a.revoked_at, p.nickname, p.bio
       FROM agents AS a LEFT JOIN profiles AS p ON p.identity = a.name ORDER BY a.revoked_at IS NOT NULL, a.name`
    )
    .all();
  const { results: others } = await db
    .prepare('SELECT identity, nickname, bio, updated_at FROM profiles WHERE identity NOT IN (SELECT name FROM agents) ORDER BY identity')
    .all();
  const agentRows = agents
    .map(
      (a) => `<tr${a.revoked_at ? ' class="muted"' : ''}>
  <td><code>${esc(a.name)}</code></td><td>${a.nickname ? esc(a.nickname) : '<span class="muted">—</span>'}</td>
  <td>${a.bio ? esc(a.bio) : ''}</td>
  <td class="nowrap">${esc(time(a.created_at, tz))}</td>
  <td>${a.revoked_at ? `失効 ${esc(time(a.revoked_at, tz))}` : '有効'}</td>
</tr>`
    )
    .join('');
  const otherRows = others
    .map(
      (p) => `<tr><td><code>${esc(p.identity)}</code></td><td>${esc(p.nickname)}</td><td>${p.bio ? esc(p.bio) : ''}</td>
  <td class="nowrap">${esc(time(p.updated_at, tz))}</td></tr>`
    )
    .join('');
  const body = `<h2>エージェントのトークン</h2>
${agents.length ? `<table><thead><tr><th>名前</th><th>呼び名</th><th>自己紹介</th><th>発行</th><th>状態</th></tr></thead><tbody>${agentRows}</tbody></table>` : '<p class="muted">発行したエージェントはありません。</p>'}
<h2>OAuth などで接続している AI の呼び名</h2>
${others.length ? `<table><thead><tr><th>名前</th><th>呼び名</th><th>自己紹介</th><th>更新</th></tr></thead><tbody>${otherRows}</tbody></table>` : '<p class="muted">ありません。</p>'}`;
  return html(200, 'エージェント', body);
}

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

async function profileMap(db) {
  const map = new Map();
  try {
    const { results } = await db.prepare('SELECT identity, nickname FROM profiles').all();
    for (const r of results) map.set(r.identity, r.nickname);
  } catch {
    // profiles がまだない（マイグレーション前）
  }
  return map;
}

function messageList(list, nick, tz, scope) {
  return `<ol class="messages">${list
    .map(
      (m) => `<li${m.read_at ? '' : ' class="unread"'}>
  <div class="meta">${who(m.from_agent, nick)} → ${who(m.to_agent, nick)}
    <span class="muted">· ${esc(time(m.created_at, tz))}</span>
    ${m.read_at ? '<span class="muted">· 既読</span>' : '<span class="badge">未読</span>'}
    ${m.kind === 'info' ? '<span class="muted">· 返信不要</span>' : ''}
    ${m.task_id ? `<a href="/dashboard/tasks/${m.task_id}?scope=${encodeURIComponent(scope)}">#${m.task_id}</a>` : ''}</div>
  <div class="text">${multiline(m.body)}</div>
</li>`
    )
    .join('')}</ol>`;
}

function scopeNav(scope, current) {
  const q = `?scope=${encodeURIComponent(scope)}`;
  const tab = (key, label) =>
    `<a href="/dashboard/${key}${q}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="tabs"><span class="scope">${esc(scopeLabel(scope))}</span>${tab('tasks', 'タスク')}${tab('messages', 'メッセージ')}${tab('memory', '記憶')}</nav>`;
}

function nextLink(url, lastId) {
  const next = new URL(url);
  next.searchParams.set('before', String(lastId));
  return `<p><a href="${esc(next.pathname + next.search)}">さらに古いものを見る</a></p>`;
}

function pageCursor(url) {
  const v = url.searchParams.get('before');
  return v && /^\d{1,15}$/.test(v) ? Number(v) : null;
}

function who(name, nick) {
  if (!name) return '<span class="muted">不明</span>';
  const n = nick.get(name);
  return n ? `<span class="who">${esc(n)}</span> <span class="muted">(${esc(name)})</span>` : `<span class="who">${esc(name)}</span>`;
}

function scopeLabel(scope) {
  return scope === 'global' ? '共通（global）' : `プロジェクト ${scope.slice(2)}`;
}

function time(value, tz) {
  if (!value) return '';
  const d = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  try {
    return d.toLocaleString('ja-JP', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return `${value} UTC`;
  }
}

function multiline(text) {
  return esc(text).replace(/\n/g, '<br>');
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** title はエスケープ前の文字列、body はエスケープ済みの HTML */
function html(status, title, body, { nav = true } = {}) {
  const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(title)} — memory-mcp</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <a class="brand" href="/dashboard">memory-mcp</a>
  ${
    nav
      ? `<nav><a href="/dashboard">概要</a><a href="/dashboard/agents">エージェント</a>
  <form method="post" action="/dashboard/logout"><button type="submit" class="link">ログアウト</button></form>
  <form method="post" action="/dashboard/logout"><input type="hidden" name="all" value="1"><button type="submit" class="link muted-link">すべてのブラウザからログアウト</button></form></nav>`
      : ''
  }
</header>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
  return new Response(page, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin', // no-referrer だとフォーム送信の Origin が null になり、ログインできない
    },
  });
}

const STYLE = `
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --accent: #2563eb; --warn: #b45309; --warn-bg: #fef3c7; --unread: #eff6ff; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --card: #292524; --accent: #60a5fa; --warn: #fbbf24; --warn-bg: #451a03; --unread: #172554; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header nav { display: flex; align-items: center; gap: 16px; }
header form { margin: 0; }
.brand { font-weight: 700; color: var(--fg); text-decoration: none; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 8px 0 16px; overflow-wrap: anywhere; }
h2 { font-size: 1.05rem; margin: 24px 0 8px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.warn { color: var(--warn); }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: .8rem; background: var(--unread); color: var(--accent); }
.badge.warn { background: var(--warn-bg); color: var(--warn); }
table { width: 100%; border-collapse: collapse; background: var(--card); display: block; overflow-x: auto; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; font-size: .9rem; white-space: nowrap; }
.num { text-align: right; }
.nowrap { white-space: nowrap; }
code { font-size: .85rem; overflow-wrap: anywhere; }
.tabs { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 16px; }
.tabs .scope { font-weight: 600; }
.tabs a[aria-current] { font-weight: 700; text-decoration: none; color: var(--fg); }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.col h2 { margin-top: 0; }
.cards, .messages, .timeline { list-style: none; margin: 0; padding: 0; }
.card, .messages li { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; overflow-wrap: anywhere; }
.messages li.unread { background: var(--unread); }
.timeline li { border-left: 2px solid var(--line); padding: 4px 0 8px 12px; }
.meta { font-size: .85rem; }
.text { margin-top: 4px; white-space: normal; overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; }
.login { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
.login input { flex: 1 1 260px; padding: 8px; font: inherit; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
button { font: inherit; padding: 8px 16px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.link { padding: 0; border: 0; background: none; color: var(--accent); text-decoration: underline; }
button.muted-link { color: var(--muted); font-size: .85rem; }
`;
