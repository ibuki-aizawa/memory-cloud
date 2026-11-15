/**
 * OAuth の認可エンドポイント（/authorize）と GitHub サインイン。
 *
 * 流れ（MCP のセキュリティ要件どおり、同意 → GitHub の順）
 *   1. GET  /authorize               … 接続を求めているクライアントを表示して同意を求める
 *   2. POST /authorize               … 「許可」なら GitHub のサインインへリダイレクト
 *   3. GET  /oauth/github/callback   … GitHub のユーザーが許可リストにあれば、クライアントへトークン発行の準備をして戻す
 *
 * 必要な設定（未設定なら OAuth は無効になり、固定トークン認証だけで動きます）
 *   OAUTH_KV                 … KV（トークンやクライアント情報。値はライブラリがハッシュ化・暗号化して保存）
 *   GITHUB_CLIENT_ID         … GitHub OAuth App の Client ID
 *   GITHUB_CLIENT_SECRET     … GitHub OAuth App の Client secret（wrangler secret）
 *   ALLOWED_GITHUB_USERS     … サインインを許可する GitHub ユーザー名（カンマ区切り）
 */

import { AuthorizationError, CimdFetchError, authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';

export const GITHUB_CALLBACK_PATH = '/oauth/github/callback';

export function oauthConfigured(env) {
  return Boolean(env.OAUTH_KV && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

/** 許可リスト。空なら誰も許可しない（設定漏れで全員に開かないように） */
export function isAllowedUser(env, login) {
  if (!login) return false;
  const allowed = String(env.ALLOWED_GITHUB_USERS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(String(login).toLowerCase());
}

/** OAuthProvider の defaultHandler。/authorize と GitHub のコールバックを処理します。 */
export async function handleAuthRoutes(request, env, origin) {
  const { pathname } = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (pathname === '/authorize' && request.method === 'GET') return await showConsent(request, env, oauth);
    if (pathname === '/authorize' && request.method === 'POST') return await submitConsent(request, env, oauth, origin);
    if (pathname === GITHUB_CALLBACK_PATH && request.method === 'GET') return await githubCallback(request, env, oauth, origin);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) {
      // クライアントとリダイレクト先の検証が済んでいるので、エラーをクライアントへ返してよい
      return Response.redirect(authorizationErrorRedirect(error, error.code, error.description), 302);
    }
    if (error instanceof AuthorizationError) {
      return page(400, 'リクエストを処理できませんでした', `<p>${escape(error.description)}</p><p>接続元のアプリから、もう一度やり直してください。</p>`);
    }
    if (error instanceof CimdFetchError) {
      return page(400, 'アプリを確認できませんでした', '<p>接続元のアプリの情報を取得できませんでした。しばらくしてから、もう一度やり直してください。</p>');
    }
    throw error;
  }
  return new Response('not found\n', { status: 404 });
}

// ---------------------------------------------------------------------------
// 1. 同意画面
// ---------------------------------------------------------------------------

async function showConsent(request, env, oauth) {
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // 先に呼ぶ（失敗しても KV に何も残らない）
  const consent = await oauth.beginConsent(authRequest);

  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `発行元: <strong>${escape(details.clientDomain)}</strong>`
    : 'このアプリは自己登録したもので、名前は確認されていません。';
  const loopback = details.redirectIsLoopback
    ? '<p class="warn">この PC 上のアプリにアクセス権を渡します。自分で接続を始めたばかりの場合だけ続けてください。</p>'
    : '';

  const body = `
<p><strong>${name}</strong> が memory-mcp の記憶（共通・すべてのプロジェクト）の読み書きを求めています。</p>
<p>${origin}<br>アクセス権の送り先: <strong>${escape(details.redirectHost)}</strong></p>
${loopback}
<p>「許可」を押すと GitHub のサインインに進みます。許可リストにある GitHub アカウントだけが接続できます。</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <button name="decision" value="approve">許可</button>
  <button name="decision" value="deny" class="secondary">拒否</button>
</form>`;
  // 「許可」「拒否」のあとのリダイレクト（GitHub → このサーバー → 接続元のアプリ）を CSP の form-action で止めないよう、
  // 送り先を許可しておく。ブラウザは form-action をフォーム送信後のリダイレクトの連鎖すべてに当てはめる
  const formAction = [new URL(githubBase(env)).origin, cspSource(authRequest.redirectUri)].filter(Boolean);
  return page(200, `${name} に接続を許可しますか？`, body, consent.headers, formAction);
}

// ---------------------------------------------------------------------------
// 2. 同意の送信 → GitHub へ
// ---------------------------------------------------------------------------

async function submitConsent(request, env, oauth, origin) {
  const form = await request.formData();
  const handle = String(form.get('handle') || '');

  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle);
  const verifier = randomString();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier }, // コールバックで戻ってくる。GitHub には送られない
    headers: approved.headers,
  });

  const url = new URL('/login/oauth/authorize', githubBase(env));
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${origin}${GITHUB_CALLBACK_PATH}`);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', ''); // 公開プロフィール（ユーザー名）だけで足りる
  url.searchParams.set('code_challenge', await s256(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'false');
  headers.set('Location', url.toString());
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// 3. GitHub からのコールバック
// ---------------------------------------------------------------------------

async function githubCallback(request, env, oauth, origin) {
  const params = new URL(request.url).searchParams;
  const { request: original, data, headers } = await oauth.finishUpstream(request);

  if (params.get('error') || !params.get('code')) {
    // GitHub 側で拒否された・失敗した
    headers.set('Location', authorizationErrorRedirect({ ...original, issuer: origin }, 'access_denied'));
    return new Response(null, { status: 302, headers });
  }

  const user = await fetchGithubUser(env, params.get('code'), data.verifier, origin);
  if (!user) {
    return page(502, 'GitHub でのサインインに失敗しました', '<p>接続元のアプリから、もう一度やり直してください。</p>', headers);
  }
  if (!isAllowedUser(env, user.login)) {
    console.warn(`OAuth: 許可リストにない GitHub ユーザー: ${user.login}`);
    return page(
      403,
      'このアカウントは許可されていません',
      `<p>GitHub アカウント <strong>${escape(user.login)}</strong> は、この memory-mcp に接続できません。</p>
<p>サーバーの管理者に、ALLOWED_GITHUB_USERS への追加を依頼してください。</p>`,
      headers
    );
  }

  // 書き手を AI ツールごとに区別するため、接続元のアプリ名も覚えておく（アプリの自己申告。表示用のラベル）
  let clientName = null;
  try {
    clientName = (await oauth.describeConsent(original)).clientName || null;
  } catch {
    // 取得できなくても接続は続ける（書き手は github:<ユーザー名> になる）
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: `github-${user.id}`, // ライブラリの制約で ":" は使えない
    metadata: { login: user.login },
    scope: original.scope,
    props: { login: user.login, githubId: user.id, clientName }, // GitHub のトークンは保存しない
  });
  headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}

async function fetchGithubUser(env, code, verifier, origin) {
  const tokenRes = await fetch(new URL('/login/oauth/access_token', githubBase(env)), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}${GITHUB_CALLBACK_PATH}`,
      code_verifier: verifier,
    }),
  });
  const token = tokenRes.ok ? await tokenRes.json() : null;
  if (!token || !token.access_token) {
    console.error(`OAuth: GitHub のトークン交換に失敗: ${tokenRes.status} ${token && token.error}`);
    return null;
  }

  const userRes = await fetch(new URL('/user', githubApiBase(env)), {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'memory-mcp',
    },
  });
  if (!userRes.ok) {
    console.error(`OAuth: GitHub のユーザー取得に失敗: ${userRes.status}`);
    return null;
  }
  const user = await userRes.json();
  return user && user.login && user.id ? { login: user.login, id: user.id } : null;
}

// GitHub の URL（テストではモックに差し替える）
function githubBase(env) {
  return env.GITHUB_BASE_URL || 'https://github.com';
}
function githubApiBase(env) {
  return env.GITHUB_API_URL || 'https://api.github.com';
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function randomString() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

async function s256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** リダイレクト先 URI を CSP のソース表現にする（http(s) はオリジン、独自スキームはスキームだけ）。使えない値なら null */
function cspSource(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) ? u.protocol : null;
}

/** title と body は呼び出し側でエスケープ済みであること */
function page(status, title, body, headers = new Headers(), formAction = []) {
  const h = new Headers(headers);
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${["'self'", ...formAction].join(' ')}; frame-ancestors 'none'`);
  h.set('X-Frame-Options', 'DENY');
  const html = `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — memory-mcp</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.7; }
  h1 { font-size: 1.3rem; }
  .warn { padding: .6rem .8rem; border-left: 4px solid #d97706; background: color-mix(in srgb, #d97706 12%, transparent); }
  button { font: inherit; padding: .5rem 1.4rem; margin-right: .5rem; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: inherit; border-color: #888; }
</style>
<h1>${title}</h1>
${body}
</html>`;
  return new Response(html, { status, headers: h });
}
