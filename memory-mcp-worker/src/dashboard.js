/**
 * Web の管理画面（ダッシュボード）。人がブラウザで、タスク・AI どうしのメッセージ・記憶・エージェントを見て、直すためのページです。
 * OSS 版は 1 人で使う前提で、管理者トークン（MEMORY_TOKEN）でログインします。
 *
 *   GET  /dashboard                  概要（スコープごとの件数）。未ログインならログイン画面
 *   POST /dashboard/login            管理者トークンを確かめて、セッションの Cookie を発行する
 *   POST /dashboard/logout           ログアウト（all=1 なら、すべてのブラウザのログインを消す）
 *   POST /dashboard/action           変更（op= で種類を指定。削除は確認の画面を挟む）。ACTIONS を参照
 *   GET  /dashboard/tasks?scope=     タスクの一覧（状態ごと）。status= で 1 つの状態をページングして見る
 *   GET  /dashboard/tasks/<id>?scope= タスクの詳細（経過と関係するメッセージ）。状態・担当を変えられる
 *   GET  /dashboard/messages?scope=  メッセージのやり取り（新しい順、ページング）。既読・未読の切り替え、削除
 *   GET  /dashboard/memory?scope=    記憶の書き込み（誰がいつ書いたか、新しい順、ページング）。author= で書き手を絞る
 *   GET  /dashboard/entities?scope=  エンティティの一覧（q= で名前・種別を絞る）
 *   GET  /dashboard/entity?scope=&name= エンティティの詳細。observation の追加・修正・削除、関係・エンティティの削除
 *   GET  /dashboard/agents           エージェントと呼び名、書いた記憶の数。呼び名・自己紹介を直せる
 *   GET  /dashboard/audit            この画面から行った変更の記録
 *
 * セキュリティ（タスク #4・#5 での Codex の意見を反映）
 *   - HTTPS だけ（localhost を除く）。HTTP で来たら HTTPS に転送する
 *   - セッションはサーバー側（D1 の dashboard_sessions）に記録し、Cookie にはランダムな ID だけを入れる（D1 にはそのハッシュ）。
 *     ログアウトで消すので、コピーされた Cookie も使えなくなる。Cookie は HttpOnly / Secure / SameSite=Strict、有効期限 8 時間
 *   - ログインの試行は IP（CF-Connecting-IP）ごとに 10 分で 10 回まで。1 回の UPDATE で数えるので、同時に送られても上限を超えない。
 *     CF-Connecting-IP がなければ（Cloudflare を経由しない構成）、localhost を除いてログインさせない
 *   - POST は同じオリジンからだけ受け付ける。画面は CSP で外部の読み込み・スクリプトを禁止し、表示する値はすべてエスケープする
 *   - 変更のフォームには、セッションから作る CSRF トークンを入れて確かめる（同じオリジンの確認・SameSite=Strict に重ねる守り）
 *   - 削除は確認の画面を挟む。変更はすべて dashboard_audit に記録する（書き換え前の値も残す）
 *   - トークンの発行・失効はこの画面ではできない（これまでどおり /admin/agents）。トークンやそのハッシュは表示しない
 */

import { ToolInputError, nicknameKey, saveProfile } from './mcp.js';

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
const HANDOFF_LEASE_HOURS = 24;  // 画面から担当を決めたときの期限（task_handoff と同じ）
const MAX_CONTENT = 2000;        // observation・メモの長さ（MCP のツールと同じ）
const MAX_NAME = 200;
const ENTITY_DETAIL_LIMIT = 500; // エンティティの詳細に出す observation・関係の数
const AUDIT_DETAIL_MAX = 4000;

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
    if (path === '/dashboard/action') return action(request, env);
    return html(404, '見つかりません', '');
  }
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });

  const session = await validSession(request, env.DB);
  if (!session) {
    return path === '/dashboard'
      ? loginPage()
      : new Response(null, { status: 302, headers: { Location: '/dashboard', 'Cache-Control': 'no-store' } });
  }

  const ctx = { db: env.DB, tz: env.DASHBOARD_TIMEZONE || 'Asia/Tokyo', url, csrf: await csrfToken(session), back: url.pathname + url.search };
  ctx.nick = await profileMap(ctx.db);
  try {
    if (path === '/dashboard') return await overview(ctx);
    if (path === '/dashboard/agents') return await agentsPage(ctx);
    if (path === '/dashboard/audit') return await auditPage(ctx);
    const scope = url.searchParams.get('scope') || 'global';
    if (!SCOPE_RE.test(scope)) return html(400, 'スコープが正しくありません', '<p>scope は global か p:&lt;プロジェクト略称&gt; です。</p>');
    ctx.scope = scope;
    if (path === '/dashboard/tasks') return await tasksPage(ctx);
    const m = path.match(/^\/dashboard\/tasks\/(\d+)$/);
    if (m) return await taskPage(ctx, Number(m[1]));
    if (path === '/dashboard/messages') return await messagesPage(ctx);
    if (path === '/dashboard/memory') return await memoryPage(ctx);
    if (path === '/dashboard/entities') return await entitiesPage(ctx);
    if (path === '/dashboard/entity') return await entityPage(ctx);
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
  // 試行は接続元の IP ごとに数える。Cloudflare は必ず CF-Connecting-IP を付けるので、ないのは想定外の構成。
  // 1 つの共有カウンターにすると、誰か 1 人の失敗で全員がログインできなくなるため、ローカルの開発以外では受け付けない
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || (isLocalhost(url.hostname) ? 'localhost' : null);
  if (!ip) {
    console.error('dashboard: CF-Connecting-IP がないリクエスト。Cloudflare を経由しない構成ではログインできません');
    return html(503, 'ログインできません', '<p>接続元を確認できませんでした。Cloudflare を経由して開いてください。</p>');
  }
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
    // 区切りが終わった試行の記録を片付ける（ほかの IP の分も）
    db.prepare(`DELETE FROM dashboard_login_attempts WHERE window_start <= datetime('now', '-${LOGIN_WINDOW_SECONDS} seconds')`),
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

/** 有効なセッションなら、その ID（Cookie の値）を返す。なければ null */
async function validSession(request, db) {
  const id = sessionId(request);
  if (!id) return null;
  const row = await db
    .prepare("SELECT 1 AS ok FROM dashboard_sessions WHERE id_hash = ?1 AND expires_at > datetime('now')")
    .bind(await sha256(id))
    .first();
  return row ? id : null;
}

/** 変更のフォームに入れる CSRF トークン。Cookie の ID から作るので、Cookie を読めない別のサイトには作れない */
async function csrfToken(sessionIdValue) {
  return sha256(`csrf:${sessionIdValue}`);
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
<p>memory-mcp の記憶・タスク・メッセージを見て直すには、管理者トークン（MEMORY_TOKEN）を入力してください。</p>
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

async function taskPage(ctx, id) {
  const { db, scope, nick, tz } = ctx;
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
<details class="edit"><summary>状態・担当を変える</summary>
${form(ctx, 'task_edit', { id: t.id }, `
  <label>状態 <select name="status">${Object.entries(STATUS_LABEL)
    .map(([k, v]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${esc(v)}</option>`)
    .join('')}</select></label>
  <label>担当 <input name="assignee" value="${esc(t.assignee || '')}" list="people" placeholder="空にすると未担当" maxlength="100"></label>
  ${await peopleList(db)}
  <label class="wide">メモ（経過に残ります） <textarea name="note" rows="2" maxlength="${MAX_CONTENT}"></textarea></label>
  <button type="submit">変更する</button>
  <p class="muted">担当を変えると、新しい担当に知らせのメッセージを送ります。作業中・レビューの担当の期限は ${HANDOFF_LEASE_HOURS} 時間後になります。</p>`)}
</details>
<h2>経過</h2>
${omitted(eventsDesc)}
<ol class="timeline">${events
    .map(
      (e) => `<li><span class="muted">${esc(time(e.created_at, tz))}</span> ${who(e.actor, nick)}
  <strong>${esc(kindLabel[e.kind] || e.kind)}</strong>${e.status ? ` → ${esc(STATUS_LABEL[e.status] || e.status)}` : ''}
  ${e.note ? `<div class="text">${multiline(e.note)}</div>` : ''}</li>`
    )
    .join('')}</ol>
${messages.length ? `<h2>関係するメッセージ</h2>${omitted(messagesDesc)}${messageList(messages, ctx)}` : ''}`;
  return html(200, `#${t.id} ${t.title}`, body);
}

async function messagesPage(ctx) {
  const { db, scope, url } = ctx;
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
${page.length ? messageList(page, ctx) : '<p class="muted">メッセージはありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `メッセージ — ${scopeLabel(scope)}`, body);
}

async function memoryPage({ db, scope, nick, tz, url }) {
  const before = pageCursor(url);
  const author = url.searchParams.get('author');
  const where = ['e.scope = ?1'];
  const params = [scope];
  if (author) {
    params.push(author.slice(0, 200));
    where.push(`o.author = ?${params.length}`);
  }
  if (before) {
    params.push(before);
    where.push(`o.id < ?${params.length}`);
  }
  const { results } = await db
    .prepare(
      `SELECT o.id, o.content, o.author, o.created_at, o.task_id, e.name, e.entity_type
       FROM observations AS o JOIN entities AS e ON e.id = o.entity_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.id DESC LIMIT ${PAGE_SIZE + 1}`
    )
    .bind(...params)
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const rows = page
    .map(
      (o) => `<tr>
  <td class="nowrap muted">${esc(time(o.created_at, tz))}</td>
  <td>${o.author ? `<a href="${esc(memoryHref(scope, o.author))}">${who(o.author, nick)}</a>` : '<span class="muted">不明</span>'}</td>
  <td><a href="${esc(entityHref(scope, o.name))}"><code>${esc(o.name)}</code></a></td>
  <td>${esc(o.content)}${o.task_id ? ` <a class="muted" href="/dashboard/tasks/${o.task_id}?scope=${encodeURIComponent(scope)}">#${o.task_id}</a>` : ''}</td>
</tr>`
    )
    .join('');
  const filter = author
    ? `<p>書き手 ${who(author, nick)} の記憶だけを表示しています。 <a href="/dashboard/memory?scope=${encodeURIComponent(scope)}">すべての書き手を見る</a></p>`
    : '<p class="muted">書き手の名前を押すと、その書き手の記憶だけに絞れます。エンティティ名を押すと、詳細と編集の画面を開きます。</p>';
  const body = `${scopeNav(scope, 'memory')}
${filter}
${page.length ? `<table><thead><tr><th>日時</th><th>書き手</th><th>エンティティ</th><th>observation</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">記憶はありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `記憶の書き込み — ${scopeLabel(scope)}`, body);
}

/** エンティティの一覧（新しく作った順）。q= で名前・種別を部分一致で絞る */
async function entitiesPage({ db, scope, tz, url }) {
  const before = pageCursor(url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const where = ['e.scope = ?1'];
  const params = [scope];
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(e.name LIKE ?${params.length} ESCAPE '\\' OR e.entity_type LIKE ?${params.length} ESCAPE '\\')`);
  }
  if (before) {
    params.push(before);
    where.push(`e.id < ?${params.length}`);
  }
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.entity_type, e.updated_at,
         (SELECT COUNT(*) FROM observations WHERE entity_id = e.id) AS observations
       FROM entities AS e WHERE ${where.join(' AND ')}
       ORDER BY e.id DESC LIMIT ${PAGE_SIZE + 1}`
    )
    .bind(...params)
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const rows = page
    .map(
      (e) => `<tr>
  <td><a href="${esc(entityHref(scope, e.name))}"><code>${esc(e.name)}</code></a></td>
  <td>${esc(e.entity_type)}</td>
  <td class="num">${e.observations}</td>
  <td class="nowrap muted">${esc(time(e.updated_at, tz))}</td>
</tr>`
    )
    .join('');
  const body = `${scopeNav(scope, 'entities')}
<form method="get" action="/dashboard/entities" class="search">
  <input type="hidden" name="scope" value="${esc(scope)}">
  <input type="search" name="q" value="${esc(q)}" placeholder="名前・種別で絞る" aria-label="名前・種別で絞る" maxlength="100">
  <button type="submit">絞る</button>
</form>
${page.length ? `<table><thead><tr><th>名前</th><th>種別</th><th class="num">observation</th><th>更新</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">エンティティはありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, `エンティティ — ${scopeLabel(scope)}`, body);
}

/** エンティティの詳細。observation の追加・修正・削除、関係の削除、エンティティの削除 */
async function entityPage(ctx) {
  const { db, scope, nick, tz, url } = ctx;
  const name = url.searchParams.get('name') || '';
  if (!name || name.length > MAX_NAME) return html(400, 'エンティティの名前が正しくありません', scopeNav(scope, 'entities'));
  const e = await db.prepare('SELECT * FROM entities WHERE scope = ?1 AND name = ?2').bind(scope, name).first();
  if (!e) return html(404, 'エンティティが見つかりません', scopeNav(scope, 'entities'));
  const { results: observations } = await db
    .prepare(`SELECT id, content, author, created_at, task_id FROM observations WHERE entity_id = ?1 ORDER BY id LIMIT ${ENTITY_DETAIL_LIMIT}`)
    .bind(e.id)
    .all();
  const { results: relations } = await db
    .prepare(
      `SELECT r.id, r.relation_type, r.created_by, f.name AS from_name, t.name AS to_name
       FROM relations AS r JOIN entities AS f ON f.id = r.from_id JOIN entities AS t ON t.id = r.to_id
       WHERE r.from_id = ?1 OR r.to_id = ?1 ORDER BY r.id LIMIT ${ENTITY_DETAIL_LIMIT}`
    )
    .bind(e.id)
    .all();

  const obsItems = observations
    .map(
      (o) => `<li>
  <div class="text">${multiline(o.content)}</div>
  <div class="meta">${o.author ? who(o.author, nick) : '<span class="muted">書き手不明</span>'} <span class="muted">· ${esc(time(o.created_at, tz))}</span>
    ${o.task_id ? `· <a href="/dashboard/tasks/${o.task_id}?scope=${encodeURIComponent(scope)}">タスク #${o.task_id}</a>` : ''}</div>
  <div class="actions">
    <details class="edit"><summary>直す</summary>
    ${form(ctx, 'obs_edit', { id: o.id }, `<textarea name="content" rows="3" maxlength="${MAX_CONTENT}" required>${esc(o.content)}</textarea>
      <button type="submit" class="small">保存</button>`)}
    </details>
    ${form(ctx, 'obs_delete', { id: o.id }, '<button type="submit" class="small danger">削除</button>')}
  </div>
</li>`
    )
    .join('');
  const relItems = relations
    .map(
      (r) => `<li><a href="${esc(entityHref(scope, r.from_name))}"><code>${esc(r.from_name)}</code></a>
  <strong>${esc(r.relation_type)}</strong>
  <a href="${esc(entityHref(scope, r.to_name))}"><code>${esc(r.to_name)}</code></a>
  ${r.created_by ? `<span class="muted">· ${who(r.created_by, nick)}</span>` : ''}
  ${form(ctx, 'relation_delete', { id: r.id }, '<button type="submit" class="small danger">削除</button>')}</li>`
    )
    .join('');

  const body = `${scopeNav(scope, 'entities')}
<dl class="facts">
  <dt>種別</dt><dd>${esc(e.entity_type)}</dd>
  <dt>作成</dt><dd>${e.created_by ? `${who(e.created_by, nick)} · ` : ''}${esc(time(e.created_at, tz))}</dd>
  <dt>更新</dt><dd>${esc(time(e.updated_at, tz))}</dd>
</dl>
<h2>observation <span class="muted">${observations.length}</span></h2>
${observations.length ? `<ol class="observations">${obsItems}</ol>` : '<p class="muted">observation はありません。</p>'}
${observations.length >= ENTITY_DETAIL_LIMIT ? `<p class="muted">最初の ${ENTITY_DETAIL_LIMIT} 件を表示しています。</p>` : ''}
<details class="edit"><summary>observation を足す</summary>
${form(ctx, 'obs_add', { entity: e.name }, `<textarea name="content" rows="3" maxlength="${MAX_CONTENT}" required placeholder="[YYYY-MM-DD owner] 1文"></textarea>
  <button type="submit" class="small">追加</button>`)}
</details>
<h2>関係 <span class="muted">${relations.length}</span></h2>
${relations.length ? `<ul class="relations">${relItems}</ul>` : '<p class="muted">関係はありません。</p>'}
<h2>エンティティの削除</h2>
<p class="muted">observation と、このエンティティに関係するものもすべて消えます。</p>
${form(ctx, 'entity_delete', { name: e.name }, '<button type="submit" class="danger">このエンティティを削除</button>')}`;
  return html(200, e.name, body);
}

async function agentsPage(ctx) {
  const { db, tz } = ctx;
  const { results: agents } = await db
    .prepare(
      `SELECT a.name, a.created_at, a.revoked_at, p.nickname, p.bio
       FROM agents AS a LEFT JOIN profiles AS p ON p.identity = a.name ORDER BY a.revoked_at IS NOT NULL, a.name`
    )
    .all();
  const { results: others } = await db
    .prepare('SELECT identity, nickname, bio, updated_at FROM profiles WHERE identity NOT IN (SELECT name FROM agents) ORDER BY identity')
    .all();
  // 書き手ごと・スコープごとの observation の数（「各エージェントの記憶」への入り口）
  const { results: written } = await db
    .prepare(
      `SELECT o.author, e.scope, COUNT(*) AS n FROM observations AS o JOIN entities AS e ON e.id = o.entity_id
       WHERE o.author IS NOT NULL GROUP BY o.author, e.scope ORDER BY e.scope = 'global' DESC, e.scope`
    )
    .all();
  const byAuthor = new Map();
  for (const w of written) {
    if (!byAuthor.has(w.author)) byAuthor.set(w.author, []);
    byAuthor.get(w.author).push(w);
  }
  const memoryLinks = (identity) => {
    const list = byAuthor.get(identity);
    return list
      ? list.map((w) => `<a href="${esc(memoryHref(w.scope, identity))}">${esc(w.scope)} ${w.n}</a>`).join('<br>')
      : '<span class="muted">なし</span>';
  };
  const profileForm = (identity, nickname, bio) => `<details class="edit"><summary>${nickname ? '直す' : '呼び名をつける'}</summary>
${form(ctx, 'profile_save', { identity }, `<label>呼び名 <input name="nickname" value="${esc(nickname || '')}" maxlength="32" required></label>
  <label class="wide">自己紹介 <input name="bio" value="${esc(bio || '')}" maxlength="200"></label>
  <button type="submit" class="small">保存</button>`)}
${nickname ? form(ctx, 'profile_delete', { identity }, '<button type="submit" class="small danger">呼び名を消す</button>') : ''}
</details>`;

  const agentRows = agents
    .map(
      (a) => `<tr${a.revoked_at ? ' class="muted"' : ''}>
  <td><code>${esc(a.name)}</code></td><td>${a.nickname ? esc(a.nickname) : '<span class="muted">—</span>'}</td>
  <td>${a.bio ? esc(a.bio) : ''}</td>
  <td class="nowrap">${memoryLinks(a.name)}</td>
  <td class="nowrap">${esc(time(a.created_at, tz))}</td>
  <td>${a.revoked_at ? `失効 ${esc(time(a.revoked_at, tz))}` : '有効'}</td>
  <td>${a.revoked_at ? '' : profileForm(a.name, a.nickname, a.bio)}</td>
</tr>`
    )
    .join('');
  const otherRows = others
    .map(
      (p) => `<tr><td><code>${esc(p.identity)}</code></td><td>${esc(p.nickname)}</td><td>${p.bio ? esc(p.bio) : ''}</td>
  <td class="nowrap">${memoryLinks(p.identity)}</td>
  <td class="nowrap">${esc(time(p.updated_at, tz))}</td><td>${profileForm(p.identity, p.nickname, p.bio)}</td></tr>`
    )
    .join('');
  // 呼び名のない書き手（OAuth の AI、owner など）も、書いた記憶へたどれるようにする
  const listed = new Set([...agents.map((a) => a.name), ...others.map((p) => p.identity)]);
  const rest = [...byAuthor.keys()].filter((a) => !listed.has(a)).sort();
  const restRows = rest
    .map(
      (identity) => `<tr><td><code>${esc(identity)}</code></td><td class="nowrap">${memoryLinks(identity)}</td>
  <td>${identity === 'owner' ? '' : profileForm(identity, null, null)}</td></tr>`
    )
    .join('');
  const body = `<h2>エージェントのトークン</h2>
${agents.length ? `<table><thead><tr><th>名前</th><th>呼び名</th><th>自己紹介</th><th>書いた記憶</th><th>発行</th><th>状態</th><th></th></tr></thead><tbody>${agentRows}</tbody></table>` : '<p class="muted">発行したエージェントはありません。</p>'}
<p class="muted">トークンの発行・失効は、この画面ではできません（/admin/agents を使います）。</p>
<h2>OAuth などで接続している AI の呼び名</h2>
${others.length ? `<table><thead><tr><th>名前</th><th>呼び名</th><th>自己紹介</th><th>書いた記憶</th><th>更新</th><th></th></tr></thead><tbody>${otherRows}</tbody></table>` : '<p class="muted">ありません。</p>'}
${rest.length ? `<h2>呼び名のない書き手</h2>
<table><thead><tr><th>名前</th><th>書いた記憶</th><th></th></tr></thead><tbody>${restRows}</tbody></table>` : ''}`;
  return html(200, 'エージェント', body);
}

/** この画面から行った変更の記録（新しい順、ページング） */
async function auditPage({ db, tz, url }) {
  const before = pageCursor(url);
  const { results } = await db
    .prepare(`SELECT * FROM dashboard_audit ${before ? 'WHERE id < ?1' : ''} ORDER BY id DESC LIMIT ${PAGE_SIZE + 1}`)
    .bind(...(before ? [before] : []))
    .all();
  const page = results.slice(0, PAGE_SIZE);
  const rows = page
    .map(
      (a) => `<tr>
  <td class="nowrap muted">${esc(time(a.created_at, tz))}</td>
  <td>${esc(ACTIONS[a.action] ? ACTIONS[a.action].label : a.action)}</td>
  <td>${a.scope ? esc(a.scope) : ''}</td>
  <td><code>${esc(a.target || '')}</code></td>
  <td>${multiline(a.detail || '')}</td>
</tr>`
    )
    .join('');
  const body = `${page.length ? `<table><thead><tr><th>日時</th><th>操作</th><th>スコープ</th><th>対象</th><th>中身</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">まだ変更はありません。</p>'}
${results.length > PAGE_SIZE ? nextLink(url, page.at(-1).id) : ''}`;
  return html(200, '変更の記録', body);
}

// ---------------------------------------------------------------------------
// 変更（POST /dashboard/action）
// ---------------------------------------------------------------------------

/** 画面に出して直せる入力の誤り */
class EditError extends Error {}

/**
 * 変更の種類。load で対象を確かめ（なければ EditError）、apply で書き込む文を作る。
 * confirm があるものは、確認の画面で「はい」を押したときだけ apply する。
 * apply は { stmts, target, detail, back } を返す。stmts は変更の記録と同じ batch で実行する（一緒に成功するか、一緒に失敗する）
 */
const ACTIONS = {
  obs_add: {
    label: 'observation の追加',
    async load(db, scope, f) {
      const e = await db.prepare('SELECT id, name FROM entities WHERE scope = ?1 AND name = ?2').bind(scope, text(f, 'entity', MAX_NAME)).first();
      if (!e) throw new EditError('エンティティが見つかりません');
      return { e, content: text(f, 'content', MAX_CONTENT) };
    },
    apply(db, scope, { e, content }) {
      return {
        stmts: [
          db.prepare("INSERT INTO observations (entity_id, content, author) VALUES (?1, ?2, 'owner')").bind(e.id, content),
          db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?1").bind(e.id),
        ],
        target: e.name,
        detail: content,
        back: entityHref(scope, e.name),
      };
    },
  },
  obs_edit: {
    label: 'observation の修正',
    async load(db, scope, f) {
      const o = await observationIn(db, scope, f);
      const content = text(f, 'content', MAX_CONTENT);
      if (content === o.content) throw new EditError('内容が変わっていません');
      return { o, content };
    },
    apply(db, scope, { o, content }) {
      return {
        stmts: [
          db.prepare('UPDATE observations SET content = ?1 WHERE id = ?2').bind(content, o.id),
          db.prepare("UPDATE entities SET updated_at = datetime('now') WHERE id = ?1").bind(o.entity_id),
        ],
        target: o.name,
        detail: `前: ${o.content}\n後: ${content}`,
        back: entityHref(scope, o.name),
      };
    },
  },
  obs_delete: {
    label: 'observation の削除',
    confirm: 'この observation を削除します。',
    async load(db, scope, f) {
      return { o: await observationIn(db, scope, f) };
    },
    summary: ({ o }) => `${o.name}: ${o.content}`,
    apply(db, scope, { o }) {
      return {
        stmts: [db.prepare('DELETE FROM observations WHERE id = ?1').bind(o.id)],
        target: o.name,
        detail: `${o.content}${o.author ? `（書き手 ${o.author}）` : ''}`,
        back: entityHref(scope, o.name),
      };
    },
  },
  relation_delete: {
    label: '関係の削除',
    confirm: 'この関係を削除します（両側のエンティティは残ります）。',
    async load(db, scope, f) {
      const r = await db
        .prepare(
          `SELECT r.id, r.relation_type, f.name AS from_name, t.name AS to_name
           FROM relations AS r JOIN entities AS f ON f.id = r.from_id JOIN entities AS t ON t.id = r.to_id
           WHERE r.id = ?1 AND f.scope = ?2`
        )
        .bind(num(f, 'id'), scope)
        .first();
      if (!r) throw new EditError('関係が見つかりません');
      return { r };
    },
    summary: ({ r }) => `${r.from_name} ${r.relation_type} ${r.to_name}`,
    apply(db, scope, { r }, f) {
      const back = backPath(f.get('back'));
      return {
        stmts: [db.prepare('DELETE FROM relations WHERE id = ?1').bind(r.id)],
        target: r.from_name,
        detail: `${r.from_name} ${r.relation_type} ${r.to_name}`,
        back,
      };
    },
  },
  entity_delete: {
    label: 'エンティティの削除',
    confirm: 'このエンティティを削除します。observation と関係もすべて消えます。',
    async load(db, scope, f) {
      const e = await db
        .prepare(
          `SELECT e.id, e.name, e.entity_type,
             (SELECT COUNT(*) FROM observations WHERE entity_id = e.id) AS observations,
             (SELECT COUNT(*) FROM relations WHERE from_id = e.id OR to_id = e.id) AS relations
           FROM entities AS e WHERE e.scope = ?1 AND e.name = ?2`
        )
        .bind(scope, text(f, 'name', MAX_NAME))
        .first();
      if (!e) throw new EditError('エンティティが見つかりません');
      const { results } = await db.prepare('SELECT content FROM observations WHERE entity_id = ?1 ORDER BY id').bind(e.id).all();
      return { e, contents: results.map((r) => r.content) };
    },
    summary: ({ e }) => `${e.name}（${e.entity_type}）: observation ${e.observations} 件、関係 ${e.relations} 件`,
    apply(db, scope, { e, contents }) {
      return {
        stmts: [
          db.prepare('DELETE FROM observations WHERE entity_id = ?1').bind(e.id),
          db.prepare('DELETE FROM relations WHERE from_id = ?1 OR to_id = ?1').bind(e.id),
          db.prepare('DELETE FROM entities WHERE id = ?1').bind(e.id),
        ],
        target: e.name,
        detail: `種別 ${e.entity_type}、関係 ${e.relations} 件\n${contents.join('\n')}`,
        back: `/dashboard/entities?scope=${encodeURIComponent(scope)}`,
      };
    },
  },
  task_edit: {
    label: 'タスクの変更',
    async load(db, scope, f) {
      const t = await db.prepare('SELECT id, title, status, assignee FROM tasks WHERE id = ?1 AND scope = ?2').bind(num(f, 'id'), scope).first();
      if (!t) throw new EditError('タスクが見つかりません');
      const status = String(f.get('status') || '');
      if (!STATUS_LABEL[status]) throw new EditError('状態が正しくありません');
      const raw = String(f.get('assignee') || '').trim();
      const assignee = raw ? await resolveIdentity(db, raw) : null;
      const note = optionalText(f, 'note', MAX_CONTENT);
      if (status === t.status && assignee === t.assignee && !note) throw new EditError('何も変わっていません');
      return { t, status, assignee, note };
    },
    apply(db, scope, { t, status, assignee, note }) {
      const leased = assignee && (status === 'in_progress' || status === 'review');
      const changed = [];
      if (status !== t.status) changed.push(`状態 ${STATUS_LABEL[t.status] || t.status} → ${STATUS_LABEL[status]}`);
      if (assignee !== t.assignee) changed.push(`担当 ${t.assignee || '未担当'} → ${assignee || '未担当'}`);
      const eventNote = [changed.length ? `管理画面から変更: ${changed.join('、')}` : null, note].filter(Boolean).join('\n');
      const stmts = [
        db
          .prepare(
            `UPDATE tasks SET status = ?1, assignee = ?2,
               lease_expires_at = ${leased ? `datetime('now', '+${HANDOFF_LEASE_HOURS} hours')` : 'NULL'},
               updated_at = datetime('now')
             WHERE id = ?3`
          )
          .bind(status, assignee, t.id),
        db
          .prepare("INSERT INTO task_events (task_id, actor, kind, status, note) VALUES (?1, 'owner', ?2, ?3, ?4)")
          .bind(t.id, assignee !== t.assignee ? 'handoff' : 'updated', status, eventNote || null),
      ];
      // 新しい担当に知らせる（owner 自身に割り当てたときは送らない）
      if (assignee && assignee !== t.assignee && assignee !== 'owner') {
        const body = `タスク #${t.id}「${t.title}」を管理画面から割り当てられました（状態: ${STATUS_LABEL[status]}）。${note ? `\n${note}` : ''}`;
        stmts.push(
          db
            .prepare("INSERT INTO messages (scope, to_agent, from_agent, body, task_id, kind) VALUES (?1, ?2, 'owner', ?3, ?4, 'request')")
            .bind(scope, assignee, body, t.id)
        );
      }
      return { stmts, target: `#${t.id}`, detail: eventNote, back: `/dashboard/tasks/${t.id}?scope=${encodeURIComponent(scope)}` };
    },
  },
  msg_read: {
    label: 'メッセージの既読・未読',
    async load(db, scope, f) {
      const m = await db.prepare('SELECT id, to_agent FROM messages WHERE id = ?1 AND scope = ?2').bind(num(f, 'id'), scope).first();
      if (!m) throw new EditError('メッセージが見つかりません');
      return { m, read: f.get('read') === '1' };
    },
    apply(db, scope, { m, read }, f) {
      return {
        stmts: [db.prepare(`UPDATE messages SET read_at = ${read ? "datetime('now')" : 'NULL'} WHERE id = ?1`).bind(m.id)],
        target: `メッセージ ${m.id}（宛先 ${m.to_agent}）`,
        detail: read ? '既読にした' : '未読に戻した',
        back: backPath(f.get('back')),
      };
    },
  },
  msg_delete: {
    label: 'メッセージの削除',
    confirm: 'このメッセージを削除します。',
    async load(db, scope, f) {
      const m = await db.prepare('SELECT * FROM messages WHERE id = ?1 AND scope = ?2').bind(num(f, 'id'), scope).first();
      if (!m) throw new EditError('メッセージが見つかりません');
      return { m };
    },
    summary: ({ m }) => `${m.from_agent || '不明'} → ${m.to_agent}: ${m.body}`,
    apply(db, scope, { m }, f) {
      return {
        stmts: [db.prepare('DELETE FROM messages WHERE id = ?1').bind(m.id)],
        target: `メッセージ ${m.id}`,
        detail: `${m.from_agent || '不明'} → ${m.to_agent}${m.task_id ? `（タスク #${m.task_id}）` : ''}\n${m.body}`,
        back: backPath(f.get('back')),
      };
    },
  },
  profile_save: {
    label: '呼び名・自己紹介の変更',
    noScope: true,
    async load(db, _scope, f) {
      const identity = await knownIdentity(db, text(f, 'identity', 100));
      const before = await db.prepare('SELECT nickname, bio FROM profiles WHERE identity = ?1').bind(identity).first();
      return { identity, before, nickname: String(f.get('nickname') || ''), bio: String(f.get('bio') || '') };
    },
    // 呼び名の検証と重複の確認は set_profile と同じ関数で行う（その中で保存まで済ませる）
    async run(db, { identity, before, nickname, bio }) {
      const out = await saveProfile(db, identity, nickname, bio);
      return {
        target: identity,
        detail: `前: ${before ? `${before.nickname}${before.bio ? ` / ${before.bio}` : ''}` : 'なし'}\n後: ${out.nickname}${out.bio ? ` / ${out.bio}` : ''}`,
        back: '/dashboard/agents',
      };
    },
  },
  profile_delete: {
    label: '呼び名の削除',
    noScope: true,
    confirm: 'この呼び名と自己紹介を消します（トークンや記憶はそのまま残ります）。',
    async load(db, _scope, f) {
      const identity = text(f, 'identity', 100);
      const p = await db.prepare('SELECT identity, nickname, bio FROM profiles WHERE identity = ?1').bind(identity).first();
      if (!p) throw new EditError('呼び名が見つかりません');
      return { p };
    },
    summary: ({ p }) => `${p.identity}: ${p.nickname}`,
    apply(db, _scope, { p }) {
      return {
        stmts: [db.prepare('DELETE FROM profiles WHERE identity = ?1').bind(p.identity)],
        target: p.identity,
        detail: `${p.nickname}${p.bio ? ` / ${p.bio}` : ''}`,
        back: '/dashboard/agents',
      };
    },
  },
};

async function action(request, env) {
  const db = env.DB;
  const session = await validSession(request, db);
  if (!session) return redirect('/dashboard');
  let f;
  try {
    f = await request.formData();
  } catch {
    return html(400, '送信の内容を読めませんでした', '');
  }
  const back = backPath(f.get('back'));
  if (!equalText(String(f.get('csrf') || ''), await csrfToken(session))) {
    return html(403, '受け付けられません', `<p>画面を開き直してから、もう一度やり直してください。</p>${backLink(back)}`);
  }
  const op = String(f.get('op') || '');
  const def = Object.hasOwn(ACTIONS, op) ? ACTIONS[op] : null;
  if (!def) return html(400, '操作が正しくありません', backLink(back));
  const scope = def.noScope ? null : String(f.get('scope') || 'global');
  if (scope && !SCOPE_RE.test(scope)) return html(400, 'スコープが正しくありません', backLink(back));

  try {
    const data = await def.load(db, scope, f);
    if (def.confirm && f.get('confirm') !== '1') return confirmPage(def, data, f, back);
    const ip = request.headers.get('CF-Connecting-IP');
    let result;
    if (def.run) {
      result = await def.run(db, data);
      await auditStmt(db, op, scope, result, ip).run();
    } else {
      result = def.apply(db, scope, data, f);
      await db.batch([...result.stmts, auditStmt(db, op, scope, result, ip)]);
    }
    return redirect(result.back || back);
  } catch (err) {
    let message = null;
    if (err instanceof EditError || err instanceof ToolInputError) message = err.message;
    else if (/UNIQUE/i.test(String(err && err.message))) message = '同じ内容のものがすでにあります';
    if (message) return html(400, '変更できませんでした', `<p class="warn">${esc(message)}</p>${backLink(back)}`);
    console.error(err);
    return html(500, 'エラー', `<p>変更できませんでした。データベースの変更（npm run db:migrate）が済んでいるか確かめてください。</p>${backLink(back)}`);
  }
}

function auditStmt(db, op, scope, { target, detail }, ip) {
  return db
    .prepare('INSERT INTO dashboard_audit (action, scope, target, detail, ip) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(op, scope, target || null, detail ? String(detail).slice(0, AUDIT_DETAIL_MAX) : null, ip || null);
}

/** 削除の前の確認。送られた値をそのまま hidden で持ち回し、confirm=1 を足して送り直す */
function confirmPage(def, data, f, back) {
  const hidden = [...f.entries()]
    .filter(([k]) => k !== 'confirm')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join('');
  const body = `<p class="warn">${esc(def.confirm)}</p>
${def.summary ? `<div class="text card">${multiline(def.summary(data))}</div>` : ''}
<form method="post" action="/dashboard/action" class="confirm">${hidden}<input type="hidden" name="confirm" value="1">
  <button type="submit" class="danger">削除する</button>
  <a href="${esc(back)}">やめる</a>
</form>
<p class="muted">削除した内容は「変更の記録」に残ります。</p>`;
  return html(200, `${def.label}の確認`, body);
}

/** 変更のフォーム。CSRF トークン・スコープ・戻り先を hidden で入れる */
function form(ctx, op, fields, inner) {
  const all = { op, csrf: ctx.csrf, back: ctx.back, ...(ctx.scope && !ACTIONS[op].noScope ? { scope: ctx.scope } : {}), ...fields };
  const hidden = Object.entries(all)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(String(v))}">`)
    .join('');
  return `<form method="post" action="/dashboard/action" class="inline">${hidden}${inner}</form>`;
}

/** 担当の入力欄の候補（エージェントと呼び名） */
async function peopleList(db) {
  const { results } = await db
    .prepare(
      `SELECT a.name AS identity, p.nickname FROM agents AS a LEFT JOIN profiles AS p ON p.identity = a.name WHERE a.revoked_at IS NULL
       UNION SELECT identity, nickname FROM profiles WHERE identity NOT IN (SELECT name FROM agents)
       ORDER BY 1`
    )
    .all();
  return `<datalist id="people"><option value="owner">${results
    .map((r) => `<option value="${esc(r.identity)}">${r.nickname ? esc(r.nickname) : ''}</option>`)
    .join('')}</datalist>`;
}

/** 担当に指定できる名前か。owner・有効なエージェント・github:<名前>・呼び名（本人確認の名前に読み替える） */
async function resolveIdentity(db, value) {
  if (value === 'owner' || /^github:[A-Za-z0-9-]+(\/[a-z0-9._-]+)?$/.test(value)) return value;
  if (value.length > 100) throw new EditError('担当の名前が長すぎます');
  const a = await db.prepare('SELECT name FROM agents WHERE name = ?1 AND revoked_at IS NULL').bind(value).first();
  if (a) return value;
  const p = await db.prepare('SELECT identity FROM profiles WHERE nickname_key = ?1').bind(nicknameKey(value.normalize('NFKC'))).first();
  if (p) return p.identity;
  throw new EditError(`${value} は登録されていません。エージェントの名前か呼び名を入れてください`);
}

/** 呼び名をつけられる相手か（有効なエージェントか、github:<名前>/<クライアント>） */
async function knownIdentity(db, value) {
  if (/^github:[A-Za-z0-9-]+(\/[a-z0-9._-]+)?$/.test(value)) return value;
  const a = await db.prepare('SELECT name FROM agents WHERE name = ?1 AND revoked_at IS NULL').bind(value).first();
  if (a) return value;
  throw new EditError(`${value} は有効なエージェントではありません`);
}

async function observationIn(db, scope, f) {
  const o = await db
    .prepare(
      `SELECT o.id, o.content, o.author, o.entity_id, e.name FROM observations AS o JOIN entities AS e ON e.id = o.entity_id
       WHERE o.id = ?1 AND e.scope = ?2`
    )
    .bind(num(f, 'id'), scope)
    .first();
  if (!o) throw new EditError('observation が見つかりません');
  return o;
}

function text(f, field, max) {
  const v = String(f.get(field) || '').trim();
  if (!v) throw new EditError(`${field} が空です`);
  if (v.length > max) throw new EditError(`${field} は ${max} 文字以内にしてください`);
  return v;
}

function optionalText(f, field, max) {
  const v = String(f.get(field) || '').trim();
  return v ? text(f, field, max) : null;
}

function num(f, field) {
  const v = String(f.get(field) || '');
  if (!/^\d{1,15}$/.test(v)) throw new EditError(`${field} が正しくありません`);
  return Number(v);
}

/** 戻り先。この画面の中のパスだけ（ほかのサイトへ飛ばさない） */
function backPath(value) {
  const v = typeof value === 'string' ? value : '';
  return v.length <= 1000 && /^\/dashboard(\/[A-Za-z0-9/_-]*)?(\?[^\s#\\]*)?$/.test(v) && !v.startsWith('//') ? v : '/dashboard';
}

function backLink(back) {
  return `<p><a href="${esc(back)}">戻る</a></p>`;
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

function entityHref(scope, name) {
  return `/dashboard/entity?scope=${encodeURIComponent(scope)}&name=${encodeURIComponent(name)}`;
}

function memoryHref(scope, author) {
  return `/dashboard/memory?scope=${encodeURIComponent(scope)}&author=${encodeURIComponent(author)}`;
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

function messageList(list, ctx) {
  const { nick, tz, scope } = ctx;
  return `<ol class="messages">${list
    .map(
      (m) => `<li${m.read_at ? '' : ' class="unread"'}>
  <div class="meta">${who(m.from_agent, nick)} → ${who(m.to_agent, nick)}
    <span class="muted">· ${esc(time(m.created_at, tz))}</span>
    ${m.read_at ? '<span class="muted">· 既読</span>' : '<span class="badge">未読</span>'}
    ${m.kind === 'info' ? '<span class="muted">· 返信不要</span>' : ''}
    ${m.task_id ? `<a href="/dashboard/tasks/${m.task_id}?scope=${encodeURIComponent(scope)}">#${m.task_id}</a>` : ''}</div>
  <div class="text">${multiline(m.body)}</div>
  <div class="actions">
    ${form(ctx, 'msg_read', { id: m.id, read: m.read_at ? '0' : '1' }, `<button type="submit" class="small">${m.read_at ? '未読に戻す' : '既読にする'}</button>`)}
    ${form(ctx, 'msg_delete', { id: m.id }, '<button type="submit" class="small danger">削除</button>')}
  </div>
</li>`
    )
    .join('')}</ol>`;
}

function scopeNav(scope, current) {
  const q = `?scope=${encodeURIComponent(scope)}`;
  const tab = (key, label) =>
    `<a href="/dashboard/${key}${q}"${key === current ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="tabs"><span class="scope">${esc(scopeLabel(scope))}</span>${tab('tasks', 'タスク')}${tab('messages', 'メッセージ')}${tab('memory', '記憶の書き込み')}${tab('entities', 'エンティティ')}</nav>`;
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
      ? `<nav><a href="/dashboard">概要</a><a href="/dashboard/agents">エージェント</a><a href="/dashboard/audit">変更の記録</a>
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
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #fff; --accent: #2563eb; --warn: #b45309; --warn-bg: #fef3c7; --unread: #eff6ff; --danger: #b91c1c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --card: #292524; --accent: #60a5fa; --warn: #fbbf24; --warn-bg: #451a03; --unread: #172554; --danger: #dc2626; }
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
button.small { padding: 2px 10px; font-size: .85rem; }
button.danger { border-color: var(--danger); background: var(--danger); }
form.inline { display: inline-flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin: 4px 0; }
form.inline label { display: flex; flex-direction: column; font-size: .85rem; gap: 2px; }
form.inline label.wide, form.inline textarea { flex: 1 1 100%; }
form.inline p { flex-basis: 100%; margin: 0; font-size: .85rem; }
input, select, textarea { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); max-width: 100%; }
textarea { width: 100%; }
details.edit { margin: 4px 0; }
details.edit summary { cursor: pointer; color: var(--accent); font-size: .9rem; }
.actions { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin-top: 4px; }
.observations, .relations { list-style: none; margin: 0; padding: 0; }
.observations li, .relations li { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; overflow-wrap: anywhere; }
.search, .confirm { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 16px; }
.search input { flex: 1 1 240px; }
`;
