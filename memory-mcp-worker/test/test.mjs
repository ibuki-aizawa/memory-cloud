// ローカルテスト: node:sqlite で D1 を模擬して Worker の動作を確認します。
// 実行: npm test   （Node.js 22.5 以上）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/mcp.js';
import { clientSlug, userIdentity } from '../src/agents.js';
import { nicknameKey } from '../src/mcp.js';

// --- D1 互換の最小シム ------------------------------------------------------
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params); }
  async all() { return this._all(); }
  async run() { return this._run(); }
  async first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  _all() { return { results: this.db.prepare(this.sql).all(...this.params), meta: {} }; }
  _run() { const r = this.db.prepare(this.sql).run(...this.params); return { results: [], meta: { changes: Number(r.changes) } }; }
  _exec() { return /^\s*select/i.test(this.sql) ? this._all() : this._run(); }
}
class D1Shim {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    // 本番と同じく、schema.sql のあとにマイグレーションを順に適用する
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(new URL(f, dir), 'utf8'));
    }
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s._exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

const env = { DB: new D1Shim(), MEMORY_TOKEN: 'test-token' };
let nextId = 1;

async function post(path, body, token = 'test-token') {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch(new Request(`https://example.com${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function call(path, name, args) {
  const { body } = await post(path, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
  const r = body.result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
}

const P = '/mcp/p/myapp';
const G = '/mcp/global';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

await test('認証なし・誤ったトークンは 401', async () => {
  assert.equal((await post(P, {}, null)).status, 401);
  assert.equal((await post(P, {}, 'wrong-token')).status, 401);
});

await test('不明なパスは 404、GET は 405', async () => {
  assert.equal((await post('/mcp/p/Bad_Slug', {})).status, 404);
  const res = await worker.fetch(new Request(`https://example.com${P}`, { headers: { Authorization: 'Bearer test-token' } }), env);
  assert.equal(res.status, 405);
});

await test('initialize と tools/list', async () => {
  const init = await post(P, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.ok(init.body.result.instructions.includes('Project:myapp'));
  const note = await post(P, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const tools = await post(P, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = tools.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('search_nodes'));
  assert.ok(names.includes('guide'));
  assert.ok(!names.includes('read_graph'));
});

await test('create_entities（重複はスキップ）', async () => {
  const r1 = await call(P, 'create_entities', { entities: [
    { name: 'Project:myapp', entityType: 'Project', observations: ['[2026-11-15 owner] 概要: 記憶基盤の実験', '[2026-11-15 owner] 主要Component: auth'] },
    { name: 'Component:myapp/auth', entityType: 'Component', observations: ['[2026-11-15 owner] 認証は Bearer トークン方式'] },
    { name: 'Agent:reviewer', entityType: 'Agent' },
  ] });
  assert.deepEqual(r1.data.created, ['Project:myapp', 'Component:myapp/auth', 'Agent:reviewer']);
  const r2 = await call(P, 'create_entities', { entities: [{ name: 'Project:myapp', entityType: 'Project', observations: ['x'] }] });
  assert.deepEqual(r2.data.created, []);
  assert.deepEqual(r2.data.skipped_existing, ['Project:myapp']);
});

await test('create_relations（存在しない端点を報告）', async () => {
  const r = await call(P, 'create_relations', { relations: [
    { from: 'Component:myapp/auth', to: 'Project:myapp', relationType: 'part_of' },
    { from: 'Agent:reviewer', to: 'Project:myapp', relationType: 'responsible_for' },
    { from: 'Agent:reviewer', to: 'Project:nothing', relationType: 'responsible_for' },
  ] });
  assert.equal(r.data.created, 2);
  assert.deepEqual(r.data.missing_entities, ['Project:nothing']);
  const again = await call(P, 'create_relations', { relations: [{ from: 'Component:myapp/auth', to: 'Project:myapp', relationType: 'part_of' }] });
  assert.equal(again.data.created, 0);
});

await test('add_observations（重複は追加しない）', async () => {
  const r = await call(P, 'add_observations', { observations: [
    { entityName: 'Component:myapp/auth', contents: ['[2026-11-16 reviewer] トークンは定数時間比較する', '[2026-11-15 owner] 認証は Bearer トークン方式'] },
    { entityName: 'Nope', contents: ['x'] },
  ] });
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.missing_entities, ['Nope']);
});

await test('search_nodes（日本語の部分一致・複数語のスコア順）', async () => {
  const r = await call(P, 'search_nodes', { query: 'トークン 比較' });
  assert.equal(r.data.results[0].name, 'Component:myapp/auth');
  assert.ok(r.data.results[0].observations[0].includes('トークン'));
  const none = await call(P, 'search_nodes', { query: 'zzz-nothing' });
  assert.equal(none.data.results.length, 0);
  assert.ok(none.data.hint);
  const like = await call(P, 'search_nodes', { query: '%' });
  assert.equal(like.data.results.length, 0, 'LIKE のワイルドカードはエスケープされる');
});

await test('open_nodes（observation と接続リレーション）', async () => {
  const r = await call(P, 'open_nodes', { names: ['Project:myapp', 'Missing:x'] });
  assert.equal(r.data.entities.length, 1);
  assert.equal(r.data.entities[0].observations.length, 2);
  assert.equal(r.data.relations.length, 2);
  assert.deepEqual(r.data.not_found, ['Missing:x']);
});

await test('スコープの分離（global からは project が見えない）', async () => {
  const r = await call(G, 'search_nodes', { query: 'Project' });
  assert.equal(r.data.results.length, 0);
  const c = await call(G, 'create_entities', { entities: [{ name: 'Project:myapp', entityType: 'Project' }] });
  assert.deepEqual(c.data.created, ['Project:myapp'], '同じ名前でもスコープが違えば別エンティティ');
});

await test('delete_observations / delete_relations / delete_entities', async () => {
  const d1 = await call(P, 'delete_observations', { deletions: [{ entityName: 'Component:myapp/auth', observations: ['[2026-11-16 reviewer] トークンは定数時間比較する'] }] });
  assert.equal(d1.data.deleted, 1);
  const d2 = await call(P, 'delete_relations', { relations: [{ from: 'Agent:reviewer', to: 'Project:myapp', relationType: 'responsible_for' }] });
  assert.equal(d2.data.deleted, 1);
  const d3 = await call(P, 'delete_entities', { entityNames: ['Component:myapp/auth'] });
  assert.equal(d3.data.deleted, 1);
  const r = await call(P, 'open_nodes', { names: ['Project:myapp'] });
  assert.equal(r.data.relations.length, 0, '削除したエンティティのリレーションも消える');
  const g = await call(G, 'open_nodes', { names: ['Project:myapp'] });
  assert.equal(g.data.entities.length, 1, '別スコープには影響しない');
});

await test('入力エラーは isError で返す', async () => {
  const r = await call(P, 'create_entities', { entities: [] });
  assert.ok(r.isError);
  const many = await call(P, 'open_nodes', { names: Array.from({ length: 21 }, (_, i) => `n${i}`) });
  assert.ok(many.isError);
  const unknown = await call(P, 'read_graph', {});
  assert.ok(unknown.isError);
});

// --- エージェントの識別 ------------------------------------------------------

async function admin(method, path, body, token = 'test-token') {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`https://example.com${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
}
async function callAs(token, path, name, args) {
  const { status, body } = await post(path, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, token);
  assert.equal(status, 200);
  return JSON.parse(body.result.content[0].text);
}

let codexToken;

await test('管理者はエージェントのトークンを発行できる（トークンは mca_ で始まる）', async () => {
  const r = await admin('POST', '/admin/agents', { name: 'codex-mypc' });
  assert.equal(r.status, 201);
  assert.equal(r.body.name, 'codex-mypc');
  assert.match(r.body.token, /^mca_[0-9a-f]{64}$/);
  codexToken = r.body.token;
  const list = await admin('GET', '/admin/agents');
  assert.deepEqual(list.body.agents.map((a) => a.name), ['codex-mypc']);
  assert.ok(!JSON.stringify(list.body).includes(codexToken), '一覧にトークンは出ない');
});

await test('不正な名前・管理者以外の発行は拒否', async () => {
  assert.equal((await admin('POST', '/admin/agents', { name: 'Bad Name' })).status, 400);
  assert.equal((await admin('POST', '/admin/agents', { name: 'x' }, codexToken)).status, 401, 'エージェントのトークンでは管理できない');
  assert.equal((await admin('GET', '/admin/agents', null, null)).status, 401);
});

await test('whoami: 管理者は owner、エージェントは自分の名前', async () => {
  assert.equal((await callAs('test-token', G, 'whoami', {})).name, 'owner');
  const me = await callAs(codexToken, P, 'whoami', {});
  assert.equal(me.name, 'codex-mypc');
  assert.equal(me.kind, 'agent');
  assert.equal(me.scope, 'p:myapp');
});

await test('書き手をサーバーが記録する（withAuthors で読める。既定の形は変わらない）', async () => {
  await callAs(codexToken, P, 'create_entities', { entities: [{ name: 'Decision:myapp/use-d1', entityType: 'Decision', observations: ['[2026-11-16 codex] D1 を使う'] }] });
  await callAs('test-token', P, 'add_observations', { observations: [{ entityName: 'Decision:myapp/use-d1', contents: ['[2026-11-16 owner] 承認'] }] });
  await callAs(codexToken, P, 'create_relations', { relations: [{ from: 'Decision:myapp/use-d1', to: 'Project:myapp', relationType: 'applies_to' }] });

  const plain = await callAs(codexToken, P, 'open_nodes', { names: ['Decision:myapp/use-d1'] });
  assert.deepEqual(plain.entities[0].observations, ['[2026-11-16 codex] D1 を使う', '[2026-11-16 owner] 承認']);
  assert.equal(plain.entities[0].createdBy, undefined);

  const detailed = await callAs(codexToken, P, 'open_nodes', { names: ['Decision:myapp/use-d1'], withAuthors: true });
  const e = detailed.entities[0];
  assert.equal(e.createdBy, 'codex-mypc');
  assert.deepEqual(e.observations.map((o) => o.author), ['codex-mypc', 'owner']);
  assert.ok(e.observations[0].createdAt);
  const rel = env.DB.db.prepare("SELECT created_by FROM relations WHERE relation_type = 'applies_to'").get();
  assert.equal(rel.created_by, 'codex-mypc');
});

await test('発行し直すと古いトークンは使えなくなり、失効させると 401', async () => {
  const again = await admin('POST', '/admin/agents', { name: 'codex-mypc' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.token, codexToken);
  assert.equal((await post(P, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, codexToken)).status, 401, '古いトークン');
  assert.equal((await post(P, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, again.body.token)).status, 200);

  const del = await admin('DELETE', '/admin/agents/codex-mypc');
  assert.equal(del.status, 200);
  assert.equal((await post(P, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, again.body.token)).status, 401);
  assert.equal((await admin('DELETE', '/admin/agents/codex-mypc')).status, 404, '失効済み');
  const list = await admin('GET', '/admin/agents');
  assert.ok(list.body.agents[0].revokedAt);
});

await test('mca_ で始まる偽のトークンは 401', async () => {
  assert.equal((await post(P, {}, 'mca_' + '0'.repeat(64))).status, 401);
});

// --- 協調（タスクボードと受信箱） --------------------------------------------

let claudeTok;
let codexTok;
async function tool(token, name, args, path = P) {
  const { status, body } = await post(path, { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }, token);
  assert.equal(status, 200);
  const r = body.result;
  if (r.isError) return { error: r.content[0].text };
  try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
}

await test('タスクを作って一覧できる（説明文は一覧に出ない）', async () => {
  claudeTok = (await admin('POST', '/admin/agents', { name: 'claude-a' })).body.token;
  codexTok = (await admin('POST', '/admin/agents', { name: 'codex-b' })).body.token;
  const t = await tool(claudeTok, 'task_create', { title: 'ログイン画面を作る', description: '完了条件: テストが通る' });
  assert.equal(t.task.status, 'open');
  assert.equal(t.task.assignee, null);
  assert.equal(t.task.createdBy, 'claude-a');
  assert.equal(t.task.description, '完了条件: テストが通る');
  const list = await tool(codexTok, 'task_list', {});
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].description, undefined);
  assert.equal((await tool(codexTok, 'task_list', {}, G)).tasks.length, 0, 'タスクはスコープごと');
});

await test('task_claim は 1 人だけが成功する（同時に呼んでも）', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '同時に取り合うタスク' });
  const [a, b] = await Promise.all([
    tool(claudeTok, 'task_claim', { id: task.id }),
    tool(codexTok, 'task_claim', { id: task.id }),
  ]);
  assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  const loser = a.claimed ? b : a;
  assert.ok(loser.reason.includes('担当中'));
  const winner = a.claimed ? 'claude-a' : 'codex-b';
  const mine = await tool(a.claimed ? claudeTok : codexTok, 'task_list', { mine: true });
  assert.deepEqual(mine.tasks.map((t) => t.id), [task.id]);
  assert.equal(mine.tasks[0].assignee, winner);
  assert.equal(mine.tasks[0].status, 'in_progress');
});

await test('担当者以外は status を変えられない（note は書ける）。期限が切れたら引き受けられる', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: 'API を直す', claim: true });
  assert.equal(task.assignee, 'claude-a');
  assert.ok(task.leaseExpiresAt);
  const denied = await tool(codexTok, 'task_update', { id: task.id, status: 'done' });
  assert.ok(denied.error.includes('担当中'));
  const noted = await tool(codexTok, 'task_update', { id: task.id, note: 'テストが 1 件落ちていました' });
  assert.equal(noted.task.assignee, 'claude-a');
  assert.equal((await tool(codexTok, 'task_claim', { id: task.id })).claimed, false);

  // 期限切れにする
  env.DB.db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(task.id);
  const listed = await tool(codexTok, 'task_list', {});
  assert.equal(listed.tasks.find((t) => t.id === task.id).expired, true);
  const taken = await tool(codexTok, 'task_claim', { id: task.id });
  assert.equal(taken.claimed, true);
  assert.equal(taken.task.assignee, 'codex-b');
  assert.equal(taken.task.expired, false);
});

await test('task_update で完了・手放す。経過は task_get で読める', async () => {
  const { task } = await tool(codexTok, 'task_create', { title: 'README を直す', claim: true });
  const released = await tool(codexTok, 'task_update', { id: task.id, status: 'open', note: '手が回らないので戻します' });
  assert.equal(released.task.assignee, null);
  assert.equal(released.task.status, 'open');
  assert.equal((await tool(claudeTok, 'task_claim', { id: task.id })).claimed, true);
  const done = await tool(claudeTok, 'task_update', { id: task.id, status: 'done', note: '直しました' });
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.assignee, 'claude-a');
  assert.equal(done.task.leaseExpiresAt, undefined);
  assert.equal((await tool(codexTok, 'task_claim', { id: task.id })).claimed, false, '終わったタスクは引き受けられない');
  assert.ok(!(await tool(codexTok, 'task_list', {})).tasks.some((t) => t.id === task.id), '既定の一覧に done は出ない');
  assert.ok((await tool(codexTok, 'task_list', { status: 'done' })).tasks.some((t) => t.id === task.id));

  const detail = await tool(codexTok, 'task_get', { id: task.id });
  assert.deepEqual(detail.events.map((e) => `${e.actor}:${e.kind}`), [
    'codex-b:created', 'codex-b:claimed', 'codex-b:released', 'claude-a:claimed', 'claude-a:updated',
  ]);
  assert.equal(detail.events.at(-1).note, '直しました');
});

await test('task_handoff でレビューを頼むと相手の受信箱に届き、相手が引き受けられる', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '検索を速くする', claim: true });
  const h = await tool(claudeTok, 'task_handoff', { id: task.id, to: 'codex-b', note: 'ブランチ claude/search を見てください', status: 'review' });
  assert.equal(h.task.assignee, 'codex-b');
  assert.equal(h.task.status, 'review');

  const me = await tool(codexTok, 'whoami', {});
  assert.equal(me.unreadMessages, 1);
  assert.ok(me.myActiveTasks >= 1);
  const inbox = await tool(codexTok, 'read_inbox', {});
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].from, 'claude-a');
  assert.equal(inbox.messages[0].taskId, task.id);
  assert.ok(inbox.messages[0].body.includes('claude/search'));
  assert.equal((await tool(codexTok, 'read_inbox', {})).messages.length, 0, '読んだら既読');
  assert.equal((await tool(codexTok, 'read_inbox', { includeRead: true })).messages[0].read, true);

  const again = await tool(claudeTok, 'task_handoff', { id: task.id, to: 'claude-a', note: '戻して' });
  assert.ok(again.error.includes('担当中'), '渡したあとは元の担当者は操作できない');
  const claimed = await tool(codexTok, 'task_claim', { id: task.id });
  assert.equal(claimed.task.status, 'review', 'レビュー中のまま');
  const ok = await tool(codexTok, 'task_update', { id: task.id, status: 'done', note: 'LGTM' });
  assert.equal(ok.task.status, 'done');
});

await test('send_message: 登録されていない宛先は拒否、受信箱はスコープごと', async () => {
  const bad = await tool(claudeTok, 'send_message', { to: 'codx-b', body: 'hi' });
  assert.ok(bad.error.includes('登録されていません'));
  assert.ok(bad.error.includes('codex-b'), '登録済みの名前を示す');
  assert.equal((await tool(claudeTok, 'send_message', { to: 'codex-b', body: '全体の連絡' }, G)).sent, true);
  assert.equal((await tool(claudeTok, 'send_message', { to: 'owner', body: '確認お願いします' })).sent, true);
  assert.equal((await tool(codexTok, 'read_inbox', {})).messages.length, 0, 'myapp の受信箱には来ない');
  assert.equal((await tool(codexTok, 'read_inbox', {}, G)).messages[0].body, '全体の連絡');
  assert.equal((await tool('test-token', 'read_inbox', {})).messages[0].from, 'claude-a');
  assert.ok((await tool(claudeTok, 'send_message', { to: 'codex-b', body: 'x', taskId: 9999 })).error);
});

await test('引き受けずに status は変えられない（未担当・期限切れ・終わったタスク）', async () => {
  // 未担当: 作成者でもほかの人でも、先に引き受ける必要がある
  const { task: t1 } = await tool(claudeTok, 'task_create', { title: '未担当のタスク' });
  assert.ok((await tool(codexTok, 'task_update', { id: t1.id, status: 'done' })).error.includes('task_claim'));
  assert.ok((await tool(claudeTok, 'task_update', { id: t1.id, status: 'cancelled' })).error.includes('task_claim'));
  assert.ok((await tool(codexTok, 'task_handoff', { id: t1.id, to: 'codex-b', note: 'x' })).error.includes('task_claim'), '作成者以外は未担当のタスクを渡せない');

  // 期限切れ: 元の担当者以外は、引き受け直してから
  const { task: t2 } = await tool(claudeTok, 'task_create', { title: '期限切れのタスク', claim: true });
  env.DB.db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(t2.id);
  assert.ok((await tool(codexTok, 'task_update', { id: t2.id, status: 'done' })).error.includes('task_claim'));
  assert.ok((await tool(codexTok, 'task_handoff', { id: t2.id, to: 'codex-b', note: 'x' })).error.includes('task_claim'));

  // 終わったタスク: 作成者か最後の担当者が open に戻すことだけできる
  await tool(claudeTok, 'task_claim', { id: t2.id });
  assert.equal((await tool(claudeTok, 'task_update', { id: t2.id, status: 'done' })).task.status, 'done');
  assert.ok((await tool(claudeTok, 'task_update', { id: t2.id, status: 'in_progress' })).error.includes('open'));
  assert.ok((await tool(codexTok, 'task_update', { id: t2.id, status: 'open' })).error.includes('作成者'));
  const reopened = await tool(claudeTok, 'task_update', { id: t2.id, status: 'open', note: 'やり直し' });
  assert.equal(reopened.task.status, 'open');
  assert.equal(reopened.task.assignee, null);

  // 管理者トークンは例外
  assert.equal((await tool('test-token', 'task_update', { id: t1.id, status: 'cancelled' })).task.status, 'cancelled');
});

await test('担当でない人のメモでは期限が延びない', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '期限のテスト', claim: true });
  await tool(claudeTok, 'task_handoff', { id: task.id, to: 'codex-b', note: '渡します' });
  env.DB.db.prepare("UPDATE tasks SET lease_expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(task.id);
  const r = await tool(claudeTok, 'task_update', { id: task.id, note: '元の担当者の遅れたメモ' });
  assert.equal(r.task.leaseExpiresAt, '2000-01-01 00:00:00', '新しい担当者の期限はそのまま');
  assert.equal(r.task.assignee, 'codex-b');
  const own = await tool(codexTok, 'task_update', { id: task.id, note: '担当者のメモ' });
  assert.ok(own.task.leaseExpiresAt > '2000-01-01 00:00:00', '担当者なら延びる');
});

await test('set_profile: 呼び名を登録すると whoami に出る（未設定ならヒント）', async () => {
  const before = await tool(codexTok, 'whoami', {});
  assert.equal(before.nickname, undefined);
  assert.ok(before.profileHint);
  const r = await tool(codexTok, 'set_profile', { nickname: 'ミナト', bio: 'レビュー担当' });
  assert.deepEqual(r, { name: 'codex-b', nickname: 'ミナト', bio: 'レビュー担当' });
  const me = await tool(codexTok, 'whoami', {}, G);
  assert.equal(me.name, 'codex-b', '本人確認の名前は変わらない');
  assert.equal(me.nickname, 'ミナト', '呼び名はスコープをまたいで共通');
  assert.equal(me.profileHint, undefined);
  // 付け直し（自分の呼び名は大文字小文字を変えても使える）
  assert.equal((await tool(codexTok, 'set_profile', { nickname: 'Minato' })).nickname, 'Minato');
  assert.equal((await tool(codexTok, 'set_profile', { nickname: 'minato' })).nickname, 'minato');
  await tool(codexTok, 'set_profile', { nickname: 'ミナト', bio: 'レビュー担当' });
});

await test('set_profile: 重複・予約語・使えない文字は拒否', async () => {
  assert.ok((await tool(claudeTok, 'set_profile', { nickname: 'ミナト' })).error.includes('codex-b'), 'ほかの人の呼び名');
  assert.ok((await tool(claudeTok, 'set_profile', { nickname: 'ﾐﾅﾄ' })).error, '半角カナも同じ呼び名とみなす（NFKC）');
  assert.ok((await tool(claudeTok, 'set_profile', { nickname: 'CODEX-B' })).error, 'ほかのエージェントの本人確認の名前');
  for (const bad of ['owner', 'Admin', 'github-bot', 'a b', 'x/y', 'a:b', '-x', 'あ'.repeat(33)]) {
    assert.ok((await tool(claudeTok, 'set_profile', { nickname: bad })).error, bad);
  }
  assert.equal((await tool(claudeTok, 'set_profile', { nickname: 'claude-a' })).nickname, 'claude-a', '自分の本人確認の名前は使える');
  assert.equal((await tool(claudeTok, 'set_profile', { nickname: 'ソラ' })).nickname, 'ソラ');
});

await test('呼び名の重複判定は大文字小文字を Unicode でそろえる。呼び名と同じ名前のエージェントは発行できない', async () => {
  assert.equal(nicknameKey('ΟΔΥΣΣΕΥΣ'), nicknameKey('οδυσσευς'), 'σ と ς');
  assert.equal(nicknameKey('Straße'), nicknameKey('STRASSE'), 'ß と ss');
  assert.equal(nicknameKey('ﾐﾅﾄ'), nicknameKey('ミナト'));
  await tool(codexTok, 'set_profile', { nickname: 'ΟΔΥΣΣΕΥΣ' });
  assert.ok((await tool(claudeTok, 'set_profile', { nickname: 'οδυσσευς' })).error, '語末の ς でも同じ名前');
  await tool(codexTok, 'set_profile', { nickname: 'minato' });
  const r = await admin('POST', '/admin/agents', { name: 'minato' });
  assert.equal(r.status, 409, 'ほかの AI の呼び名と同じ名前は発行できない');
  assert.ok(r.body.error.includes('codex-b'));
  assert.equal((await admin('POST', '/admin/agents', { name: 'codex-b' })).status, 201, '自分の呼び名と同じ自分の名前は発行し直せる');
  codexTok = (await admin('POST', '/admin/agents', { name: 'codex-b' })).body.token;
  await tool(codexTok, 'set_profile', { nickname: 'ミナト', bio: 'レビュー担当' });
});

await test('呼び名を宛先に使え、受信箱・タスク・書き手の表示に呼び名が添えられる', async () => {
  const sent = await tool(claudeTok, 'send_message', { to: 'ミナト', body: '呼び名で送ります' });
  assert.equal(sent.to, 'codex-b', '本人確認の名前に読み替えて届ける');
  assert.equal(sent.toNickname, 'ミナト');
  const inbox = await tool(codexTok, 'read_inbox', {});
  const msg = inbox.messages.find((m) => m.body === '呼び名で送ります');
  assert.equal(msg.from, 'claude-a');
  assert.equal(msg.fromNickname, 'ソラ');

  const { task } = await tool(claudeTok, 'task_create', { title: '呼び名で引き継ぐ', claim: true });
  const h = await tool(claudeTok, 'task_handoff', { id: task.id, to: 'ミナト', note: 'お願いします' });
  assert.equal(h.notified, 'codex-b');
  assert.equal(h.notifiedNickname, 'ミナト');
  const detail = await tool(codexTok, 'task_get', { id: task.id });
  assert.equal(detail.task.assigneeNickname, 'ミナト');
  assert.equal(detail.task.createdByNickname, 'ソラ');
  assert.equal(detail.events[0].actorNickname, 'ソラ');
  const listed = (await tool(codexTok, 'task_list', { mine: true })).tasks.find((t) => t.id === task.id);
  assert.equal(listed.assigneeNickname, 'ミナト');

  await tool(claudeTok, 'create_entities', { entities: [{ name: 'Lesson:myapp/nickname', entityType: 'Lesson', observations: ['[2026-11-15 claude-a] 呼び名のテスト'] }] });
  const plain = await tool(claudeTok, 'open_nodes', { names: ['Lesson:myapp/nickname'] });
  assert.deepEqual(plain.entities[0].observations, ['[2026-11-15 claude-a] 呼び名のテスト'], '既定の形は変わらない');
  const withAuthors = await tool(claudeTok, 'open_nodes', { names: ['Lesson:myapp/nickname'], withAuthors: true });
  assert.equal(withAuthors.entities[0].createdByNickname, 'ソラ');
  assert.equal(withAuthors.entities[0].observations[0].author, 'claude-a', '記録は本人確認の名前のまま');
  assert.equal(withAuthors.entities[0].observations[0].authorNickname, 'ソラ');

  const unknown = await tool(claudeTok, 'send_message', { to: 'だれか', body: 'x' });
  assert.ok(unknown.error.includes('ミナト（codex-b）'), '登録済みの一覧に呼び名も出る');
});

await test('返信不要のメッセージ（kind: info）は unreadRequests に数えず、受信箱で info と分かる', async () => {
  await tool(codexTok, 'read_inbox', {}); // いったん空にする
  await tool(claudeTok, 'read_inbox', {});
  const info = await tool(claudeTok, 'send_message', { to: 'ミナト', body: 'ありがとうございました', kind: 'info' });
  assert.equal(info.kind, 'info');
  let me = await tool(codexTok, 'whoami', {});
  assert.equal(me.unreadMessages, 1);
  assert.equal(me.unreadRequests, 0, 'info は依頼に数えない（見張りが起こさない）');
  const req = await tool(claudeTok, 'send_message', { to: 'ミナト', body: '確認お願いします' });
  assert.equal(req.kind, 'request', '既定は request');
  me = await tool(codexTok, 'whoami', {});
  assert.equal(me.unreadRequests, 1);
  const inbox = await tool(codexTok, 'read_inbox', {});
  assert.equal(inbox.messages.find((m) => m.body === 'ありがとうございました').kind, 'info');
  assert.equal(inbox.messages.find((m) => m.body === '確認お願いします').kind, undefined, 'request は省く');
  assert.ok((await tool(claudeTok, 'send_message', { to: 'ミナト', body: 'x', kind: 'fyi' })).error);
});

// --- Web の確認画面 ---------------------------------------------------------

const dashEnv = env;
async function dash(method, path, { cookie, form, origin = 'https://example.com', ip = '198.51.100.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (method === 'POST' && origin) headers.Origin = origin;
  let body;
  if (form) { body = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const res = await worker.fetch(new Request(`https://example.com${path}`, { method, headers, body, redirect: 'manual' }), dashEnv);
  return { status: res.status, headers: res.headers, text: await res.text() };
}
let dashCookie;

await test('確認画面: 未ログインはログイン画面、トークンが違えば 401、正しければ Cookie が出る', async () => {
  const page = await dash('GET', '/dashboard');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('name="token"'));
  assert.ok(page.headers.get('content-security-policy').includes("default-src 'none'"));
  assert.equal((await dash('GET', '/dashboard/tasks?scope=p:myapp')).status, 302, 'ほかの画面はログインへ');

  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'wrong' } })).status, 401);
  const ok = await dash('POST', '/dashboard/login', { form: { token: 'test-token' } });
  assert.equal(ok.status, 303);
  const setCookie = ok.headers.get('set-cookie');
  for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/dashboard', 'Max-Age=28800']) assert.ok(setCookie.includes(attr), attr);
  assert.match(setCookie.split(';')[0], /^mc_dash=[A-Za-z0-9_-]{43}$/, 'Cookie にはランダムな ID だけ');
  assert.ok(!setCookie.includes('test-token'), 'Cookie にトークンは入らない');
  dashCookie = setCookie.split(';')[0];
});

await test('確認画面: 各画面が表示でき、値はエスケープされる', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '<script>alert(1)</script>', description: '説明 <b>x</b>', claim: true });
  await tool(claudeTok, 'send_message', { to: 'ミナト', body: '<img src=x onerror=alert(1)>', taskId: task.id });
  const pages = ['/dashboard', '/dashboard/agents', '/dashboard/tasks?scope=p:myapp', `/dashboard/tasks/${task.id}?scope=p:myapp`,
    '/dashboard/messages?scope=p:myapp', '/dashboard/memory?scope=p:myapp', '/dashboard/memory?scope=global'];
  for (const p of pages) {
    const r = await dash('GET', p, { cookie: dashCookie });
    assert.equal(r.status, 200, p);
    assert.ok(!/<script>|<img src=x/.test(r.text), `${p} にエスケープされない値がある`);
  }
  const detail = await dash('GET', `/dashboard/tasks/${task.id}?scope=p:myapp`, { cookie: dashCookie });
  assert.ok(detail.text.includes('&#60;script&#62;'));
  assert.ok(detail.text.includes('ミナト'), '関係するメッセージの宛先に呼び名');
  assert.ok(detail.text.includes('ソラ'), '担当に呼び名');
  const agents = await dash('GET', '/dashboard/agents', { cookie: dashCookie });
  assert.ok(agents.text.includes('codex-b') && agents.text.includes('ミナト'));
  assert.ok(!/mca_[0-9a-f]{8}/.test(agents.text), 'トークンは表示しない');
  assert.equal((await dash('GET', '/dashboard/tasks?scope=p:Bad', { cookie: dashCookie })).status, 400);
  assert.equal((await dash('GET', `/dashboard/tasks/${task.id}?scope=global`, { cookie: dashCookie })).status, 404, 'スコープが違えば見えない');
});

await test('確認画面: メッセージはページングできる', async () => {
  for (let i = 0; i < 55; i++) await tool(claudeTok, 'send_message', { to: 'codex-b', body: `ページ ${i}` }, G);
  const first = await dash('GET', '/dashboard/messages?scope=global', { cookie: dashCookie });
  const next = first.text.match(/href="([^"]*before=\d+[^"]*)"/);
  assert.ok(next, '次のページへのリンク');
  const second = await dash('GET', next[1].replace(/&#38;/g, '&'), { cookie: dashCookie });
  assert.equal(second.status, 200);
  assert.ok(second.text.includes('ページ 0'));
  assert.ok(!first.text.includes('ページ 0<'));
});

await test('確認画面: 偽の Cookie・別サイトからの POST・試行の繰り返しは拒否', async () => {
  assert.equal((await dash('GET', '/dashboard/agents', { cookie: 'mc_dash=' + 'A'.repeat(43) })).status, 302, '記録のない ID');
  assert.equal((await dash('GET', '/dashboard/agents', { cookie: 'mc_dash=v1.9999999999.forged' })).status, 302);
  assert.ok(!JSON.stringify(env.DB.db.prepare('SELECT * FROM dashboard_sessions').all()).includes(dashCookie.split('=')[1]), 'D1 には ID のハッシュだけ');
  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, origin: null })).status, 403, 'Origin がなければ拒否');

  // 同時に送っても 10 回を超えて試せない
  const burst = await Promise.all(Array.from({ length: 15 }, () => dash('POST', '/dashboard/login', { form: { token: 'bad' }, ip: '203.0.113.9' })));
  assert.equal(burst.filter((r) => r.status === 401).length, 10);
  assert.equal(burst.filter((r) => r.status === 429).length, 5);
  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, ip: '203.0.113.9' })).status, 429, '上限のあとは正しくても待たせる');
  env.DB.db.prepare("UPDATE dashboard_login_attempts SET window_start = datetime('now', '-11 minutes') WHERE ip = '203.0.113.9'").run();
  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, ip: '203.0.113.9' })).status, 303, '10 分たてば試せる');
  assert.equal((await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, ip: '198.51.100.2' })).status, 303, 'ほかの IP は影響しない');
});

await test('確認画面: ブラウザが Origin: null を送っても、Sec-Fetch-Site が same-origin ならログインできる', async () => {
  const send = (headers) => worker.fetch(new Request('https://example.com/dashboard/login', {
    method: 'POST', headers: { 'CF-Connecting-IP': '198.51.100.7', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ token: 'test-token' }), redirect: 'manual',
  }), dashEnv);
  assert.equal((await send({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })).status, 303);
  assert.equal((await send({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send({ Origin: 'null' })).status, 403);
  assert.equal((await send({ 'Sec-Fetch-Site': 'same-origin' })).status, 303);
  const page = await dash('GET', '/dashboard');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin', 'no-referrer だと Origin が null になる');
});

await test('確認画面: CF-Connecting-IP がなければログインさせない（共有カウンターで全員が締め出されないように）。期限切れの試行は片付ける', async () => {
  const res = await worker.fetch(new Request('https://example.com/dashboard/login', {
    method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'test-token' }), redirect: 'manual',
  }), dashEnv);
  assert.equal(res.status, 503);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM dashboard_login_attempts WHERE ip = 'unknown'").get().n, 0);

  await dash('POST', '/dashboard/login', { form: { token: 'bad' }, ip: '192.0.2.50' });
  env.DB.db.prepare("UPDATE dashboard_login_attempts SET window_start = datetime('now', '-11 minutes') WHERE ip = '192.0.2.50'").run();
  await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, ip: '192.0.2.51' });
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM dashboard_login_attempts WHERE ip = '192.0.2.50'").get().n, 0, 'ほかの IP の期限切れも消える');
});

await test('確認画面: HTTP は HTTPS に転送（localhost は除く）', async () => {
  const res = await worker.fetch(new Request('http://example.com/dashboard/tasks?scope=global', { redirect: 'manual' }), dashEnv);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://example.com/dashboard/tasks?scope=global');
  const post = await worker.fetch(new Request('http://example.com/dashboard/login', { method: 'POST', headers: { Origin: 'http://example.com' }, body: new URLSearchParams({ token: 'test-token' }) }), dashEnv);
  assert.equal(post.status, 403, 'HTTP ではトークンを受け付けない');
  assert.equal((await worker.fetch(new Request('http://localhost/dashboard'), dashEnv)).status, 200);
});

await test('確認画面: ログアウトするとコピーした Cookie も使えない。すべてのブラウザからのログアウト', async () => {
  const copy = dashCookie;
  const out = await dash('POST', '/dashboard/logout', { cookie: dashCookie });
  assert.equal(out.status, 303);
  assert.ok(out.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await dash('GET', '/dashboard/agents', { cookie: copy })).status, 302, 'コピーした Cookie も無効');

  const login = async () => (await dash('POST', '/dashboard/login', { form: { token: 'test-token' }, ip: '198.51.100.3' })).headers.get('set-cookie').split(';')[0];
  const a = await login();
  const b = await login();
  assert.equal((await dash('GET', '/dashboard/agents', { cookie: b })).status, 200);
  await dash('POST', '/dashboard/logout', { cookie: a, form: { all: '1' } });
  assert.equal((await dash('GET', '/dashboard/agents', { cookie: b })).status, 302, 'ほかのブラウザのログインも消える');
  dashCookie = await login();
});

await test('確認画面: タスクは状態ごとにページングして見られる', async () => {
  for (let i = 0; i < 35; i++) await tool(claudeTok, 'task_create', { title: `たくさんのタスク ${i}` }, G);
  const board = await dash('GET', '/dashboard/tasks?scope=global', { cookie: dashCookie });
  const link = board.text.includes('href="/dashboard/tasks?scope=global&amp;status=open"');
  assert.ok(link, 'すべて見るのリンク');
  const list = await dash('GET', '/dashboard/tasks?scope=global&status=open', { cookie: dashCookie });
  assert.equal(list.status, 200);
  assert.ok(list.text.includes('たくさんのタスク 34'));
  assert.ok(list.text.includes('たくさんのタスク 0'), '50 件以内なので最後まで見える');
  assert.equal((await dash('GET', '/dashboard/tasks?scope=global&status=wip', { cookie: dashCookie })).status, 400);
});

// 管理画面の変更。画面から CSRF トークンを読み取って送る
async function dashCsrf(path) {
  const page = await dash('GET', path, { cookie: dashCookie });
  const m = page.text.match(/name="csrf" value="([0-9a-f]{64})"/);
  assert.ok(m, `${path} に CSRF トークンがない`);
  return m[1];
}
async function dashAct(form, opts = {}) {
  return dash('POST', '/dashboard/action', { cookie: dashCookie, form, ...opts });
}
const audits = () => env.DB.db.prepare('SELECT action, target, detail FROM dashboard_audit ORDER BY id').all();

await test('管理画面: エンティティを開いて observation を足す・直す・消す。変更は記録に残る', async () => {
  await tool(claudeTok, 'create_entities', { entities: [
    { name: 'Lesson:edit-me', entityType: 'Lesson', observations: ['[2026-11-19 claude-a] 最初の内容'] },
    { name: 'Tech:Other', entityType: 'Tech', observations: ['x'] },
  ] }, G);
  await tool(claudeTok, 'create_relations', { relations: [{ from: 'Lesson:edit-me', to: 'Tech:Other', relationType: 'about' }] }, G);
  const path = '/dashboard/entity?scope=global&name=Lesson%3Aedit-me';
  const page = await dash('GET', path, { cookie: dashCookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('最初の内容') && page.text.includes('Tech:Other'));
  const csrf = await dashCsrf(path);
  const obsId = () => env.DB.db.prepare("SELECT o.id FROM observations o JOIN entities e ON e.id = o.entity_id WHERE e.name = 'Lesson:edit-me' ORDER BY o.id").all().map((r) => r.id);

  const add = await dashAct({ op: 'obs_add', csrf, scope: 'global', entity: 'Lesson:edit-me', content: '[2026-11-19 owner] 足した内容', back: path });
  assert.equal(add.status, 303);
  assert.equal(add.headers.get('location'), path);
  const added = env.DB.db.prepare("SELECT author FROM observations WHERE content = '[2026-11-19 owner] 足した内容'").get();
  assert.equal(added.author, 'owner', '画面から足したものの書き手は owner');

  const [first] = obsId();
  assert.equal((await dashAct({ op: 'obs_edit', csrf, scope: 'global', id: String(first), content: '直した内容', back: path })).status, 303);
  assert.equal(env.DB.db.prepare('SELECT content FROM observations WHERE id = ?').get(first).content, '直した内容');
  const dup = await dashAct({ op: 'obs_edit', csrf, scope: 'global', id: String(first), content: '[2026-11-19 owner] 足した内容', back: path });
  assert.equal(dup.status, 400, '同じエンティティに同じ内容は作れない');

  // 削除は確認を挟む
  const ask = await dashAct({ op: 'obs_delete', csrf, scope: 'global', id: String(first), back: path });
  assert.equal(ask.status, 200);
  assert.ok(ask.text.includes('name="confirm" value="1"') && ask.text.includes('直した内容'));
  assert.equal(obsId().length, 2, '確認の前は消えない');
  assert.equal((await dashAct({ op: 'obs_delete', csrf, scope: 'global', id: String(first), back: path, confirm: '1' })).status, 303);
  assert.equal(obsId().length, 1);

  // スコープが違えば触れない
  const other = await dashAct({ op: 'obs_delete', csrf, scope: 'p:myapp', id: String(obsId()[0]), back: path, confirm: '1' });
  assert.equal(other.status, 400);
  assert.equal(obsId().length, 1);

  const log = audits().filter((a) => a.target === 'Lesson:edit-me');
  assert.deepEqual(log.map((a) => a.action), ['obs_add', 'obs_edit', 'obs_delete']);
  assert.ok(log[1].detail.includes('前: [2026-11-19 claude-a] 最初の内容'), '書き換え前の値が残る');
  assert.equal((await dash('GET', '/dashboard/audit', { cookie: dashCookie })).status, 200);

  // 関係とエンティティの削除
  const relId = env.DB.db.prepare("SELECT r.id FROM relations r JOIN entities f ON f.id = r.from_id WHERE f.name = 'Lesson:edit-me'").get().id;
  assert.equal((await dashAct({ op: 'relation_delete', csrf, scope: 'global', id: String(relId), back: path, confirm: '1' })).status, 303);
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM relations WHERE id = ?').get(relId).n, 0);
  const del = await dashAct({ op: 'entity_delete', csrf, scope: 'global', name: 'Lesson:edit-me', back: path, confirm: '1' });
  assert.equal(del.status, 303);
  assert.equal(del.headers.get('location'), '/dashboard/entities?scope=global');
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'Lesson:edit-me'").get().n, 0);
  assert.ok(audits().at(-1).detail.includes('足した内容'), '消したエンティティの observation も記録に残る');
  assert.equal((await dash('GET', path, { cookie: dashCookie })).status, 404);
});

await test('管理画面: CSRF トークン・同じオリジン・ログインがなければ変更できない', async () => {
  const csrf = await dashCsrf('/dashboard/agents');
  const before = audits().length;
  const form = { op: 'profile_save', csrf, identity: 'claude-a', nickname: 'ハル', back: '/dashboard/agents' };
  assert.equal((await dashAct({ ...form, csrf: '0'.repeat(64) })).status, 403, 'トークンが違う');
  assert.equal((await dashAct({ ...form, csrf: undefined })).status, 403, 'トークンがない');
  assert.equal((await dashAct(form, { origin: 'https://evil.example' })).status, 403, '別のオリジン');
  assert.equal((await dash('POST', '/dashboard/action', { form })).status, 303, '未ログインはログインへ');
  assert.equal((await dashAct({ ...form, op: 'constructor' })).status, 400, '知らない操作');
  assert.equal(audits().length, before, 'どれも変更されない');
  // 戻り先はこの画面の中だけ
  const evil = await dashAct({ ...form, back: 'https://evil.example/' });
  assert.equal(evil.headers.get('location'), '/dashboard/agents');
  const evil2 = await dashAct({ ...form, nickname: 'ハル2', back: '//evil.example/dashboard' });
  assert.equal(evil2.headers.get('location'), '/dashboard/agents');
});

await test('管理画面: 呼び名を直す・消す（set_profile と同じ検証）。書き手ごとの記憶へたどれる', async () => {
  const csrf = await dashCsrf('/dashboard/agents');
  assert.equal(env.DB.db.prepare("SELECT nickname FROM profiles WHERE identity = 'claude-a'").get().nickname, 'ハル2');
  const clash = await dashAct({ op: 'profile_save', csrf, identity: 'claude-a', nickname: 'ミナト', back: '/dashboard/agents' });
  assert.equal(clash.status, 400, 'ほかの人の呼び名は使えない');
  assert.ok(clash.text.includes('codex-b'));
  assert.equal((await dashAct({ op: 'profile_save', csrf, identity: 'claude-a', nickname: 'owner', back: '/' })).status, 400, '予約語');
  assert.equal((await dashAct({ op: 'profile_save', csrf, identity: 'nobody', nickname: 'ナナ', back: '/' })).status, 400, '知らない相手');
  assert.equal((await dashAct({ op: 'profile_delete', csrf, identity: 'claude-a', back: '/', confirm: '1' })).status, 303);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE identity = 'claude-a'").get().n, 0);

  const agents = await dash('GET', '/dashboard/agents', { cookie: dashCookie });
  assert.ok(agents.text.includes('/dashboard/memory?scope=global&#38;author=claude-a'), '書いた記憶へのリンク');
  const mine = await dash('GET', '/dashboard/memory?scope=global&author=codex-b', { cookie: dashCookie });
  assert.equal(mine.status, 200);
  assert.ok(!mine.text.includes('Tech:Other'), 'ほかの書き手の記憶は出ない');
  const list = await dash('GET', '/dashboard/entities?scope=global&q=Other', { cookie: dashCookie });
  assert.ok(list.text.includes('Tech:Other'));
  assert.ok(!list.text.includes('Project:'), '絞り込み');
});

await test('管理画面: タスクの状態・担当を変えると経過に残り、新しい担当に知らせる。メッセージは既読・削除できる', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '画面から割り当てる' }, G);
  const path = `/dashboard/tasks/${task.id}?scope=global`;
  const csrf = await dashCsrf(path);
  const r = await dashAct({ op: 'task_edit', csrf, scope: 'global', id: String(task.id), status: 'in_progress', assignee: 'ミナト', note: 'お願いします', back: path });
  assert.equal(r.status, 303);
  const t = (await tool(codexTok, 'task_get', { id: task.id }, G)).task;
  assert.equal(t.assignee, 'codex-b', '呼び名は本人確認の名前に読み替える');
  assert.equal(t.status, 'in_progress');
  assert.ok(t.leaseExpiresAt);
  const notice = env.DB.db.prepare('SELECT * FROM messages WHERE task_id = ? AND to_agent = ?').get(task.id, 'codex-b');
  assert.ok(notice && notice.from_agent === 'owner' && notice.kind === 'request' && notice.body.includes('お願いします'));
  const events = (await tool(codexTok, 'task_get', { id: task.id }, G)).events;
  assert.ok(events.some((e) => e.kind === 'handoff' && e.actor === 'owner'));

  assert.equal((await dashAct({ op: 'task_edit', csrf, scope: 'global', id: String(task.id), status: 'done', assignee: 'だれか', back: path })).status, 400, '知らない担当');
  assert.equal((await dashAct({ op: 'task_edit', csrf, scope: 'global', id: String(task.id), status: 'wip', assignee: '', back: path })).status, 400);
  assert.equal((await dashAct({ op: 'task_edit', csrf, scope: 'global', id: String(task.id), status: 'cancelled', assignee: '', back: path })).status, 303);
  const closed = (await tool(codexTok, 'task_get', { id: task.id }, G)).task;
  assert.equal(closed.status, 'cancelled');
  assert.equal(closed.assignee, null);

  const msgId = env.DB.db.prepare('SELECT id FROM messages WHERE task_id = ? AND from_agent = ?').get(task.id, 'owner').id;
  await dashAct({ op: 'msg_read', csrf, scope: 'global', id: String(msgId), read: '0', back: '/dashboard/messages?scope=global' });
  assert.equal(env.DB.db.prepare('SELECT read_at FROM messages WHERE id = ?').get(msgId).read_at, null, '未読に戻る');
  await dashAct({ op: 'msg_delete', csrf, scope: 'global', id: String(msgId), back: '/dashboard/messages?scope=global', confirm: '1' });
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(msgId).n, 0);
  const msgs = await dash('GET', '/dashboard/messages?scope=global', { cookie: dashCookie });
  assert.ok(msgs.text.includes('既読にする') || msgs.text.includes('未読に戻す'));
});

await test('協調ツールの入力エラー', async () => {
  assert.ok((await tool(claudeTok, 'task_create', { title: ' ' })).error);
  assert.ok((await tool(claudeTok, 'task_claim', { id: 'abc' })).error);
  assert.ok((await tool(claudeTok, 'task_claim', { id: 9999 })).error);
  assert.ok((await tool(claudeTok, 'task_update', { id: 1 })).error, 'status も note もない');
  assert.ok((await tool(claudeTok, 'task_update', { id: 1, status: 'wip' })).error);
  assert.ok((await tool(claudeTok, 'task_list', { status: 'wip' })).error);
});

await test('OAuth の書き手にはアプリ名が付く。宛先にも使える', async () => {
  assert.equal(clientSlug('ChatGPT'), 'chatgpt');
  assert.equal(clientSlug('Claude Desktop'), 'claude-desktop');
  assert.equal(clientSlug('<script>'), 'script');
  assert.equal(clientSlug(''), '');
  assert.equal(clientSlug('x'.repeat(50)).length, 32);
  assert.equal(userIdentity('alice', 'ChatGPT').name, 'github:alice/chatgpt');
  assert.equal(userIdentity('alice', null).name, 'github:alice', 'アプリ名がわからなければユーザー名だけ');
  assert.equal((await tool(claudeTok, 'send_message', { to: 'github:alice/chatgpt', body: 'hi' })).sent, true);
  assert.ok((await tool(claudeTok, 'send_message', { to: 'github:alice/Chat GPT', body: 'hi' })).error);
});

await test('initialize の instructions に記憶と協調のルールの要点が入る', async () => {
  const init = await post(G, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  const text = init.body.result.instructions;
  for (const w of ['whoami', 'read_inbox', 'search_nodes', 'task_claim', 'guide', 'Person:owner']) assert.ok(text.includes(w), w);
  assert.ok(init.body.result.capabilities.resources);
  assert.ok(init.body.result.capabilities.prompts);
});

await test('guide: 初回ヒント、ガイド内容、訪問記録、resource/prompt', async () => {
  const token = (await admin('POST', '/admin/agents', { name: 'guide-test' })).body.token;
  const who = await tool(token, 'whoami', {}, P);
  assert.equal(who.firstVisit, true);
  assert.match(who.guideHint, /初めて/);
  assert.match(who.guideVersion, /^\d+\.\d+\.\d+$/);
  const resourceList = await post(P, { jsonrpc: '2.0', id: nextId++, method: 'resources/list' }, token);
  assert.equal(resourceList.body.result.resources[0].uri, 'memory://guide');
  const resource = await post(P, { jsonrpc: '2.0', id: nextId++, method: 'resources/read', params: { uri: 'memory://guide' } }, token);
  assert.match(resource.body.result.contents[0].text, /ガイド版/);
  const afterResourceRead = await tool(token, 'whoami', {}, P);
  assert.equal(afterResourceRead.firstVisit, true, 'resource の先読みでは既読にしない');

  const guide = await tool(token, 'guide', {}, P);
  assert.ok(guide.includes(`ガイド版: ${who.guideVersion}`));
  assert.match(guide, /秘密情報/);
  assert.match(guide, /Project:myapp/);
  assert.match(guide, /guide-test/);
  const after = await tool(token, 'whoami', {}, P);
  assert.equal(after.firstVisit, undefined);
  assert.equal(after.guideHint, undefined);


  const prompts = await post(P, { jsonrpc: '2.0', id: nextId++, method: 'prompts/list' }, token);
  assert.equal(prompts.body.result.prompts[0].name, 'memory-onboarding');
  const prompt = await post(P, { jsonrpc: '2.0', id: nextId++, method: 'prompts/get', params: { name: 'memory-onboarding' } }, token);
  assert.match(prompt.body.result.messages[0].content.text, /まず guide/);

  env.DB.db.prepare("UPDATE guide_reads SET version = '0.0.0' WHERE identity = 'guide-test' AND scope = 'p:myapp'").run();
  const stale = await tool(token, 'whoami', {}, P);
  assert.equal(stale.firstVisit, undefined);
  assert.match(stale.guideHint, /更新/);
  await tool(token, 'guide', {}, P);
  assert.equal((await tool(token, 'whoami', {}, P)).guideHint, undefined);
});

// --- 知識ベース（#42〜#45） ---------------------------------------------------

const KB = '/mcp/p/kb';
await test('知識の準備（評価用の固定データ）', async () => {
  const r = await tool(claudeTok, 'create_entities', { entities: [
    { name: 'Tech:PowerShell7', entityType: 'Tech', observations: ['[2026-11-01 claude-a] Windows の自動化に使うシェル'] },
    { name: 'Tech:D1', entityType: 'Tech', observations: ['[2026-11-01 claude-a] Cloudflare の SQLite データベース'] },
    { name: 'Lesson:kb/ps-encoding', entityType: 'Lesson', observations: ['[2026-11-02 claude-a] PowerShell で UTF-8 の BOM が付き、bash の読み込みが壊れた'] },
    { name: 'Lesson:kb/ps-heredoc', entityType: 'Lesson', observations: ['[2026-11-03 claude-a] PowerShell の here-string は閉じる行を行頭に置く'] },
    { name: 'Lesson:kb/d1-export', entityType: 'Lesson', observations: ['[2026-11-04 claude-a] D1 の export は仮想テーブルを書き出せない。バックアップの前に確認する'] },
    { name: 'Lesson:kb/misc', entityType: 'Lesson', observations: ['[2026-11-05 claude-a] powershell という語を本文に含むだけの記録'] },
  ] }, KB);
  assert.equal(r.created.length, 6);
  const rel = await tool(claudeTok, 'create_relations', { relations: [
    { from: 'Lesson:kb/ps-encoding', to: 'Tech:PowerShell7', relationType: 'about' },
    { from: 'Lesson:kb/ps-heredoc', to: 'Tech:PowerShell7', relationType: 'about' },
    { from: 'Lesson:kb/d1-export', to: 'Tech:D1', relationType: 'about' },
  ] }, KB);
  assert.ok(!rel.error);
});

await test('a. 検索の並び順: 名前の一致・完全一致・つながりが上位、全角でも見つかる', async () => {
  const names = async (q) => (await tool(claudeTok, 'search_nodes', { query: q }, KB)).results.map((x) => x.name);
  assert.equal((await names('PowerShell7'))[0], 'Tech:PowerShell7', '「種別:」を除いた名前の完全一致が 1 位');
  const ps = await names('PowerShell');
  assert.equal(ps[0], 'Tech:PowerShell7', '名前で一致し、つながりが多いもの');
  assert.equal(ps.at(-1), 'Lesson:kb/misc', '本文だけの一致はつながりのあるものより下');
  assert.equal((await names('ＰｏｗｅｒＳｈｅｌｌ　ＢＯＭ'))[0], 'Lesson:kb/ps-encoding', '全角・全角空白でも 2 語とも一致したものが 1 位');
  assert.equal((await names('D1 バックアップ'))[0], 'Lesson:kb/d1-export', '2 語一致が 1 語一致より上');
  const none = await tool(claudeTok, 'search_nodes', { query: 'まったく関係ない語' }, KB);
  assert.deepEqual(none.results, []);
  assert.ok(none.hint);
});

await test('b. open_nodes の related: 関係をたどって関連する知識を返す。付けなければ今までどおり', async () => {
  const plain = await tool(claudeTok, 'open_nodes', { names: ['Lesson:kb/ps-encoding'] }, KB);
  assert.equal(plain.related, undefined, '既定では返さない');
  const r = await tool(claudeTok, 'open_nodes', { names: ['Lesson:kb/ps-encoding'], related: true }, KB);
  assert.deepEqual(r.related.map((x) => [x.name, x.distance]), [['Tech:PowerShell7', 1], ['Lesson:kb/ps-heredoc', 2]]);
  assert.equal(r.related[1].via, 'Lesson:kb/ps-heredoc about Tech:PowerShell7', 'どの関係でたどり着いたか');
  assert.ok(r.related[1].preview.includes('here-string'));
  const one = await tool(claudeTok, 'open_nodes', { names: ['Lesson:kb/ps-encoding'], related: true, depth: 1 }, KB);
  assert.deepEqual(one.related.map((x) => x.name), ['Tech:PowerShell7']);
  assert.ok((await tool(claudeTok, 'open_nodes', { names: ['Tech:D1'], related: true, depth: 3 }, KB)).error);
  const alone = await tool(claudeTok, 'open_nodes', { names: ['Lesson:kb/misc'], related: true }, KB);
  assert.deepEqual(alone.related, []);
});

await test('c. task_claim に関係のありそうな知識が添えられる。task_get は withKnowledge のときだけ', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: 'D1 のバックアップ手順を見直す', description: '仮想テーブルを足す前に確認する' }, KB);
  const claimed = await tool(codexTok, 'task_claim', { id: task.id }, KB);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.relatedKnowledge[0].name, 'Lesson:kb/d1-export');
  assert.ok(claimed.relatedKnowledge[0].preview.includes('export'));
  assert.ok(claimed.relatedKnowledge.length <= 3);
  assert.equal((await tool(codexTok, 'task_get', { id: task.id }, KB)).relatedKnowledge, undefined);
  assert.ok((await tool(codexTok, 'task_get', { id: task.id, withKnowledge: true }, KB)).relatedKnowledge.length);

  // global の知識も探す。関係のなさそうなタスクには添えない
  await tool(claudeTok, 'create_entities', { entities: [{ name: 'Convention:global/kb-wrangler', entityType: 'Convention', observations: ['Wrangler の設定がなければ cf CLI を使う'] }] }, G);
  const { task: t2 } = await tool(claudeTok, 'task_create', { title: 'Wrangler でデプロイする' }, KB);
  const c2 = await tool(claudeTok, 'task_claim', { id: t2.id }, KB);
  assert.equal(c2.relatedKnowledge[0].name, 'Convention:global/kb-wrangler');
  assert.equal(c2.relatedKnowledge[0].scope, 'global', 'ほかのスコープの知識にはスコープを添える');
  const { task: t3 } = await tool(claudeTok, 'task_create', { title: '昼ご飯を決める' }, KB);
  assert.equal((await tool(claudeTok, 'task_claim', { id: t3.id }, KB)).relatedKnowledge, undefined);
});

await test('c. タスクの文から検索語を取り出す', async () => {
  const { taskTerms } = await import('../src/knowledge.js');
  assert.deepEqual(taskTerms('PowerShell の文字コードを直す'), ['PowerShell', '文字', 'コード']);
  assert.deepEqual(taskTerms('タスクを実装する', ''), [], '手がかりにならない語は使わない');
  assert.ok(taskTerms('ダッシュボードの改善').includes('ダッシュボード'));
});

await test('d. observation に得たタスクを記録できる（同じスコープのタスクだけ）', async () => {
  const { task } = await tool(claudeTok, 'task_create', { title: '経緯を残す' }, KB);
  const add = await tool(claudeTok, 'add_observations', { taskId: task.id, observations: [{ entityName: 'Tech:D1', contents: ['[2026-11-19 claude-a] タスクで得た知識'] }] }, KB);
  assert.equal(add.added, 1);
  await tool(claudeTok, 'create_entities', { taskId: task.id, entities: [{ name: 'Lesson:kb/from-task', entityType: 'Lesson', observations: ['作るときも付けられる'] }] }, KB);
  const open = await tool(claudeTok, 'open_nodes', { names: ['Tech:D1', 'Lesson:kb/from-task'], withAuthors: true }, KB);
  const d1 = open.entities.find((e) => e.name === 'Tech:D1').observations;
  assert.equal(d1.find((o) => o.content.includes('タスクで得た')).taskId, task.id);
  assert.equal(d1[0].taskId, undefined, '付けなかったものには出ない');
  assert.equal(open.entities.find((e) => e.name === 'Lesson:kb/from-task').observations[0].taskId, task.id);
  const plain = await tool(claudeTok, 'open_nodes', { names: ['Tech:D1'] }, KB);
  assert.ok(plain.entities[0].observations.every((o) => typeof o === 'string'), '既定の形は文字列の配列のまま');

  const { task: other } = await tool(claudeTok, 'task_create', { title: 'ほかのスコープ' }, G);
  assert.ok((await tool(claudeTok, 'add_observations', { taskId: other.id, observations: [{ entityName: 'Tech:D1', contents: ['x'] }] }, KB)).error);
  assert.ok((await tool(claudeTok, 'add_observations', { taskId: 99999, observations: [{ entityName: 'Tech:D1', contents: ['x'] }] }, KB)).error);
  const page = await dash('GET', '/dashboard/entity?scope=p%3Akb&name=Tech%3AD1', { cookie: dashCookie });
  assert.ok(page.text.includes(`/dashboard/tasks/${task.id}?scope=p%3Akb`), '管理画面にタスクへのリンク');
});

await test('#19 関係の種類: 決まった種類だけ作れる。打ち間違いには候補を示す。古い種類も消せる', async () => {
  const mk = (relationType) => tool(claudeTok, 'create_relations', { relations: [{ from: 'Lesson:kb/ps-heredoc', to: 'Lesson:kb/ps-encoding', relationType }] }, KB);
  assert.equal((await mk('contradicts')).created, 1);
  assert.equal((await mk('derived_from')).created, 1);
  const typo = await mk('applied_to');
  assert.ok(typo.error && typo.error.includes('applies_to のことですか'));
  assert.ok((await mk('Part-Of')).error.includes('part_of のことですか'));
  const unknown = await mk('supports');
  assert.ok(unknown.error.includes('使える種類') && !unknown.error.includes('ですか'));
  // 種類を絞る前に作られた関係（直接書き込む）も、delete_relations で消せる
  env.DB.db.prepare(`INSERT INTO relations (from_id, to_id, relation_type)
    SELECT f.id, t.id, 'old_kind' FROM entities f, entities t WHERE f.scope = 'p:kb' AND f.name = 'Tech:D1' AND t.scope = 'p:kb' AND t.name = 'Tech:PowerShell7'`).run();
  assert.equal((await tool(claudeTok, 'delete_relations', { relations: [{ from: 'Tech:D1', to: 'Tech:PowerShell7', relationType: 'old_kind' }] }, KB)).deleted, 1);
  const list = await post(KB, { jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, claudeTok);
  const schema = list.body.result.tools.find((t) => t.name === 'create_relations').inputSchema;
  assert.deepEqual(schema.properties.relations.items.properties.relationType.enum,
    ['part_of', 'applies_to', 'supersedes', 'uses', 'about', 'responsible_for', 'contradicts', 'derived_from']);
});

await test('#18 #22 エンティティの種類: 決まった種類だけ、名前は「種類:」で始める。置き場所の目安は placement で知らせる', async () => {
  const mk = (entities, path = KB) => tool(claudeTok, 'create_entities', { entities }, path);
  const typo = await mk([{ name: 'Lesson:kb/x', entityType: 'lesson' }]);
  assert.ok(typo.error.includes('Lesson のことですか'));
  assert.ok((await mk([{ name: 'Tech:Foo', entityType: 'Technology' }])).error.includes('Tech のことですか'));
  const unknown = await mk([{ name: 'Note:kb/x', entityType: 'Note' }]);
  assert.ok(unknown.error.includes('使える種類') && !unknown.error.includes('ですか'));
  assert.ok((await mk([{ name: 'kb/no-prefix', entityType: 'Lesson' }])).error.includes('「Lesson:」で始めて'));
  assert.ok((await mk([{ name: 'Tech:kb/x', entityType: 'Lesson' }])).error, '種類と名前の頭が食い違う');
  assert.ok((await mk([{ name: 'Lesson:', entityType: 'Lesson' }])).error, '名前の本体が空');
  // 1 件でも誤りがあれば、ほかも作らない
  assert.ok((await mk([{ name: 'Lesson:kb/ok-1', entityType: 'Lesson' }, { name: 'Bad:x', entityType: 'Bad' }])).error);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'Lesson:kb/ok-1'").get().n, 0);

  const placed = await mk([{ name: 'Person:someone', entityType: 'Person' }, { name: 'Lesson:kb/fine', entityType: 'Lesson' }]);
  assert.deepEqual(placed.created, ['Person:someone', 'Lesson:kb/fine'], '目安と違っても作成はされる');
  assert.equal(placed.placement.length, 1);
  assert.ok(placed.placement[0].includes('共通'));
  const g = await mk([{ name: 'Decision:kb/in-global', entityType: 'Decision' }], G);
  assert.ok(g.placement[0].includes('プロジェクト'));
  assert.equal((await mk([{ name: 'Lesson:kb/no-hint', entityType: 'Lesson' }])).placement, undefined, '目安どおりなら出さない');

  const list = await post(KB, { jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, claudeTok);
  const schema = list.body.result.tools.find((t) => t.name === 'create_entities').inputSchema;
  assert.deepEqual(schema.properties.entities.items.properties.entityType.enum,
    ['Project', 'Component', 'Decision', 'Convention', 'Lesson', 'Agent', 'Tech', 'Person']);

  // 決まりより前に作られた種類は管理画面で印が付く。種類で絞れる
  env.DB.db.prepare("INSERT INTO entities (scope, name, entity_type) VALUES ('p:kb', 'Memo:old', 'Memo')").run();
  const page = await dash('GET', '/dashboard/entities?scope=p%3Akb', { cookie: dashCookie });
  assert.ok(page.text.includes('決まった種類にない'));
  const tech = await dash('GET', '/dashboard/entities?scope=p%3Akb&type=Tech', { cookie: dashCookie });
  assert.ok(tech.text.includes('Tech:D1') && !tech.text.includes('Lesson:kb/fine'));
  // 古い種類のエンティティにも observation は足せ、消せる
  assert.equal((await tool(claudeTok, 'add_observations', { observations: [{ entityName: 'Memo:old', contents: ['x'] }] }, KB)).added, 1);
  assert.equal((await tool(claudeTok, 'delete_entities', { entityNames: ['Memo:old'] }, KB)).deleted, 1);
});

console.log(`\n${passed} 件のテストに成功しました`);
