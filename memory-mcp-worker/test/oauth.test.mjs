// OAuth の結合テスト: wrangler dev（ローカルの workerd・D1・KV）で Worker を起動し、
// GitHub を模擬するサーバーと組み合わせて、MCP クライアントと同じ手順で接続します。
// 実行: npm run test:oauth   （Cloudflare へは接続しません）
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const PORT = 8788;
const GH_PORT = 8789;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_REDIRECT = 'http://127.0.0.1:9999/callback';
const LEGACY_TOKEN = 'legacy-test-token';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const s256 = (v) => b64url(createHash('sha256').update(v).digest());

// --- GitHub の模擬 -----------------------------------------------------------
// code=good-* → alice（許可）、code=bad-* → mallory（許可していない）
const githubCodes = new Map(); // code -> { challenge }
const gh = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${GH_PORT}`);
  let body = '';
  for await (const c of req) body += c;
  if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
    const p = new URLSearchParams(body);
    const entry = githubCodes.get(p.get('code'));
    const ok = entry && p.get('client_secret') === 'gh-secret' && s256(p.get('code_verifier')) === entry.challenge;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ok ? { access_token: `gho_${p.get('code')}` } : { error: 'bad_verification_code' }));
  }
  if (req.method === 'GET' && url.pathname === '/user') {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = token.startsWith('gho_good') ? { login: 'Alice', id: 1 } : { login: 'mallory', id: 2 };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(user));
  }
  res.writeHead(404).end();
});
await new Promise((r) => gh.listen(GH_PORT, '127.0.0.1', r));

// --- Worker の起動 -----------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'memory-mcp-oauth-'));
const envFile = join(work, '.env');
writeFileSync(envFile, [
  `MEMORY_TOKEN=${LEGACY_TOKEN}`,
  'GITHUB_CLIENT_ID=gh-client',
  'GITHUB_CLIENT_SECRET=gh-secret',
  'ALLOWED_GITHUB_USERS=bob, alice',
  `GITHUB_BASE_URL=http://127.0.0.1:${GH_PORT}`,
  `GITHUB_API_URL=http://127.0.0.1:${GH_PORT}`,
].join('\n'));
const persist = join(work, 'state');
const shell = process.platform === 'win32';
execFileSync('npx', ['wrangler', 'd1', 'execute', 'memory-mcp', '--local', '--persist-to', persist, '--file=schema.sql'], { stdio: 'ignore', shell });
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'memory-mcp', '--local', '--persist-to', persist], { stdio: 'ignore', shell, env: { ...process.env, CI: '1' } });

const dev = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', persist,
  '--env-file', envFile, '--show-interactive-dev-session=false', '--log-level', 'warn'], { shell, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));
dev.stderr.on('data', (d) => (devLog += d));

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${ORIGIN}/`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev が起動しませんでした\n${devLog}`);
}

function cleanup() {
  gh.close();
  if (shell) { try { execFileSync('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else dev.kill();
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

// --- 補助 -------------------------------------------------------------------
class Jar {
  constructor() { this.cookies = new Map(); }
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      if (/max-age=0/i.test(c) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

const rpc = (method, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params: {} });
async function mcp(path, token, method = 'tools/list') {
  return fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: rpc(method),
  });
}

async function register() {
  const res = await fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test <script>', redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).client_id;
}

/** /authorize の同意画面を開く。返り値: { jar, handle, html, verifier, state } */
async function openConsent(clientId) {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(8));
  const url = new URL(`${ORIGIN}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: CLIENT_REDIRECT,
    code_challenge: s256(verifier), code_challenge_method: 'S256', state, resource: RESOURCE,
  })) url.searchParams.set(k, v);
  const jar = new Jar();
  const res = jar.take(await fetch(url, { redirect: 'manual' }));
  const html = await res.text();
  assert.equal(res.status, 200, html);
  const handle = html.match(/name="handle" value="([^"]+)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  return { jar, handle, html, verifier, state };
}

async function submit(jar, handle, decision) {
  return jar.take(await fetch(`${ORIGIN}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ handle, decision }),
  }));
}

/** 同意 → GitHub → コールバックまで進める。返り値はコールバックのレスポンス */
async function signIn(clientId, githubCode) {
  const c = await openConsent(clientId);
  const toGithub = await submit(c.jar, c.handle, 'approve');
  assert.equal(toGithub.status, 302);
  const gh = new URL(toGithub.headers.get('location'));
  assert.equal(gh.origin + gh.pathname, `http://127.0.0.1:${GH_PORT}/login/oauth/authorize`);
  assert.equal(gh.searchParams.get('client_id'), 'gh-client');
  assert.equal(gh.searchParams.get('redirect_uri'), `${ORIGIN}/oauth/github/callback`);
  assert.equal(gh.searchParams.get('code_challenge_method'), 'S256');
  githubCodes.set(githubCode, { challenge: gh.searchParams.get('code_challenge') });

  const cb = new URL(`${ORIGIN}/oauth/github/callback`);
  cb.searchParams.set('code', githubCode);
  cb.searchParams.set('state', gh.searchParams.get('state'));
  const res = c.jar.take(await fetch(cb, { redirect: 'manual', headers: { Cookie: c.jar.header() } }));
  return { res, ...c };
}

async function token(params) {
  const res = await fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: await res.json() };
}

// --- テスト -----------------------------------------------------------------
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

try {
  await waitReady();

  await test('認証なしは 401 と resource_metadata のチャレンジ', async () => {
    for (const path of ['/mcp/global', '/mcp/p/demo']) {
      const res = await mcp(path, null);
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate'), new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource/mcp"`));
    }
  });

  await test('メタデータ（RFC 9728 / RFC 8414）', async () => {
    const pr = await (await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(pr.resource, RESOURCE);
    assert.deepEqual(pr.authorization_servers, [ORIGIN]);
    const as = await (await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, ORIGIN);
    assert.equal(as.authorization_endpoint, `${ORIGIN}/authorize`);
    assert.equal(as.token_endpoint, `${ORIGIN}/oauth/token`);
    assert.equal(as.registration_endpoint, `${ORIGIN}/oauth/register`);
    assert.ok(as.code_challenge_methods_supported.includes('S256'));
  });

  await test('固定トークンはこれまでどおり使える（誤ったトークンは 401）', async () => {
    const ok = await mcp('/mcp/global', LEGACY_TOKEN);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).result.tools.some((t) => t.name === 'search_nodes'));
    assert.equal((await mcp('/mcp/global', 'wrong')).status, 401);
    assert.equal((await mcp('/mcp/p/Bad_Slug', LEGACY_TOKEN)).status, 404);
  });

  const clientId = await register();
  let tokens;

  await test('同意画面: クライアント名をエスケープし、送り先を表示する', async () => {
    const { html } = await openConsent(clientId);
    assert.ok(html.includes('Test &#60;script&#62;'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('127.0.0.1'));
    assert.ok(html.includes('この PC 上のアプリ'), 'ループバックへの送信は警告する');
  });

  await test('拒否するとクライアントへ access_denied で戻る', async () => {
    const c = await openConsent(clientId);
    const res = await submit(c.jar, c.handle, 'deny');
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get('location'));
    assert.equal(back.origin + back.pathname, CLIENT_REDIRECT);
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('state'), c.state);
  });

  await test('許可リストにない GitHub ユーザーは 403（コードは発行しない）', async () => {
    const { res } = await signIn(clientId, 'bad-1');
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes('mallory'));
  });

  await test('PKCE の verifier が違うとトークンに交換できない', async () => {
    // 同じユーザー・クライアントで認可し直すと前の grant は失効するので、本番のトークン取得より先に行う
    const { res } = await signIn(clientId, 'good-2');
    const code = new URL(res.headers.get('location')).searchParams.get('code');
    const r = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_verifier: 'x'.repeat(43), resource: RESOURCE });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_grant');
  });

  await test('許可したユーザー（大文字小文字は区別しない）はコードを受け取り、トークンに交換できる', async () => {
    const { res, verifier, state } = await signIn(clientId, 'good-1');
    assert.equal(res.status, 302, await res.clone().text());
    const back = new URL(res.headers.get('location'));
    assert.equal(back.origin + back.pathname, CLIENT_REDIRECT);
    assert.equal(back.searchParams.get('state'), state);
    assert.equal(back.searchParams.get('iss'), ORIGIN);
    const code = back.searchParams.get('code');
    assert.ok(code);

    const ok = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CLIENT_REDIRECT, code_verifier: verifier, resource: RESOURCE });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.access_token && ok.body.refresh_token);
    tokens = ok.body;
  });

  await test('OAuth のトークンで global とプロジェクトの両方を使える', async () => {
    for (const path of ['/mcp/global', '/mcp/p/demo']) {
      const res = await mcp(path, tokens.access_token);
      assert.equal(res.status, 200, path);
      assert.ok((await res.json()).result.tools.length > 0);
    }
    const init = await (await mcp('/mcp/p/demo', tokens.access_token, 'initialize')).json();
    assert.ok(init.result.instructions.includes('Project:demo'));
    assert.equal((await mcp('/mcp/p/Bad_Slug', tokens.access_token)).status, 404);
  });

  await test('OAuth と固定トークンは同じデータを見る', async () => {
    const write = await fetch(`${ORIGIN}/mcp/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_entities', arguments: { entities: [{ name: 'Tech:oauth-test', entityType: 'Tech' }] } } }),
    });
    assert.equal(write.status, 200);
    const read = await fetch(`${ORIGIN}/mcp/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LEGACY_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_nodes', arguments: { names: ['Tech:oauth-test'] } } }),
    });
    const data = JSON.parse((await read.json()).result.content[0].text);
    assert.equal(data.entities.length, 1);
  });

  await test('OAuth のユーザーは github:<ユーザー名>/<アプリ名> として記録される', async () => {
    const res = await fetch(`${ORIGIN}/mcp/global`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    const me = JSON.parse((await res.json()).result.content[0].text);
    assert.equal(me.name, 'github:Alice/test-script', 'アプリ名 "Test <script>" を整えたもの');
    assert.equal(me.kind, 'user');
  });

  await test('エージェントのトークンは OAuth を通さずに使え、管理は管理者トークンだけ', async () => {
    const created = await fetch(`${ORIGIN}/admin/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LEGACY_TOKEN}` },
      body: JSON.stringify({ name: 'codex-test' }),
    });
    assert.equal(created.status, 201);
    const { token: agentToken } = await created.json();
    const res = await fetch(`${ORIGIN}/mcp/p/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse((await res.json()).result.content[0].text).name, 'codex-test');
    const denied = await fetch(`${ORIGIN}/admin/agents`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(denied.status, 401, 'OAuth のトークンでは管理できない');

    // 実際の D1（workerd）でもタスクの作成・引き受け・引き継ぎが動く
    const callTool = async (tok, name, args) => {
      const r = await fetch(`${ORIGIN}/mcp/p/demo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const result = (await r.json()).result;
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const { task } = await callTool(agentToken, 'task_create', { title: '実 D1 での確認' });
    const [a, b] = await Promise.all([
      callTool(agentToken, 'task_claim', { id: task.id }),
      callTool(tokens.access_token, 'task_claim', { id: task.id }),
    ]);
    assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1, '同時に引き受けても 1 人だけ');
    const holder = a.claimed ? agentToken : tokens.access_token;
    await callTool(holder, 'task_handoff', { id: task.id, to: 'codex-test', note: 'レビューお願いします', status: 'review' });
    const inbox = await callTool(agentToken, 'read_inbox', {});
    assert.equal(inbox.messages.at(-1).taskId, task.id);
  });

  await test('リフレッシュトークンで更新できる', async () => {
    const r = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await mcp('/mcp/global', r.body.access_token)).status, 200);
  });

  await test('同意画面を経ずに POST しても通らない（Cookie の紐付け）', async () => {
    const c = await openConsent(clientId);
    const res = await submit(new Jar(), c.handle, 'approve');
    assert.equal(res.status, 400);
  });

  console.log(`\n${passed} 件のテストに成功しました`);
} catch (err) {
  console.error(err);
  console.error('--- wrangler dev のログ ---\n' + devLog.slice(-4000));
  process.exitCode = 1;
} finally {
  cleanup();
}
