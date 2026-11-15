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

console.log(`\n${passed} 件のテストに成功しました`);
