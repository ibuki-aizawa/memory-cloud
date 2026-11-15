// ローカルテスト: node:sqlite で D1 を模擬して Worker の動作を確認します。
// 実行: npm test   （Node.js 22.5 以上）
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker from '../src/mcp.js';

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
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
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

await test('協調ツールの入力エラー', async () => {
  assert.ok((await tool(claudeTok, 'task_create', { title: ' ' })).error);
  assert.ok((await tool(claudeTok, 'task_claim', { id: 'abc' })).error);
  assert.ok((await tool(claudeTok, 'task_claim', { id: 9999 })).error);
  assert.ok((await tool(claudeTok, 'task_update', { id: 1 })).error, 'status も note もない');
  assert.ok((await tool(claudeTok, 'task_update', { id: 1, status: 'wip' })).error);
  assert.ok((await tool(claudeTok, 'task_list', { status: 'wip' })).error);
});

console.log(`\n${passed} 件のテストに成功しました`);
