/**
 * 知識を探すための部品（search_nodes の並び順、関係をたどる related、タスクに添える relatedKnowledge）。
 *
 * 全文検索（FTS5）は使わず、LIKE で探して SQL で並べます。
 * バックアップに使う `wrangler d1 export` が仮想テーブルを含むデータベースを書き出せないためです（Issue #42）。
 * 記憶の量（数百〜数千件）なら LIKE で十分速く、量が増えたらバックアップの方法と一緒に考え直します。
 */

const RELATED_LIMIT = 10;     // related で返す件数
const RELATED_EDGES = 200;    // related で 1 段ごとにたどる関係の上限
const TASK_KNOWLEDGE = 3;     // タスクに添える知識の件数
const TASK_TERMS = 8;         // タスクから取り出す検索語の上限
const PREVIEW_CHARS = 120;

/**
 * 検索語に一致するエンティティを、よく一致した順に返す。
 * 並び順: 一致した語の数 → 名前の完全一致（「種別:」を除いた名前でもよい）→ 一致した場所の重み（名前 4、種別 2、observation 1）
 *        → つながり（関係の数）→ 更新日時
 * 返す行: { id, scope, name, entity_type, matched, weight, nameHits }
 */
export async function rankEntities(db, scopes, terms, limit) {
  if (!terms.length) return [];
  // ?1 = スコープ（JSON 配列）、?2 = 検索語全体、?3.. = 各語の LIKE パターン
  const params = [JSON.stringify(scopes), terms.join(' '), ...terms.map((t) => `%${escapeLike(t)}%`)];
  const cols = terms
    .map((_, i) => {
      const p = `?${i + 3}`;
      return `(e.name LIKE ${p} ESCAPE '\\') AS n${i},
         (e.entity_type LIKE ${p} ESCAPE '\\') AS t${i},
         EXISTS (SELECT 1 FROM observations AS o WHERE o.entity_id = e.id AND o.content LIKE ${p} ESCAPE '\\') AS o${i}`;
    })
    .join(',\n');
  const matched = terms.map((_, i) => `(n${i} OR t${i} OR o${i})`).join(' + ');
  const weight = terms.map((_, i) => `(n${i} * 4 + t${i} * 2 + o${i})`).join(' + ');
  const nameHits = terms.map((_, i) => `n${i}`).join(' + ');
  const { results } = await db
    .prepare(
      `SELECT id, scope, name, entity_type, matched, weight, nameHits FROM (
         SELECT id, scope, name, entity_type, updated_at, exact, degree,
           (${matched}) AS matched, (${weight}) AS weight, (${nameHits}) AS nameHits
         FROM (
           SELECT e.id, e.scope, e.name, e.entity_type, e.updated_at,
             (lower(e.name) = lower(?2) OR lower(substr(e.name, instr(e.name, ':') + 1)) = lower(?2)) AS exact,
             (SELECT COUNT(*) FROM relations AS r WHERE r.from_id = e.id OR r.to_id = e.id) AS degree,
             ${cols}
           FROM entities AS e WHERE e.scope IN (SELECT value FROM json_each(?1))
         )
       ) WHERE matched > 0
       ORDER BY matched DESC, exact DESC, weight DESC, degree DESC, updated_at DESC, id DESC
       LIMIT ${limit}`
    )
    .bind(...params)
    .all();
  return results;
}

/** 検索語の正規化（全角・半角をそろえる）と分割。最大 5 語 */
export function searchTerms(query) {
  return [...new Set(query.normalize('NFKC').split(/\s+/).filter(Boolean))].slice(0, 5);
}

/**
 * 指定したエンティティから関係をたどって、近いエンティティを返す（depth 段まで。指定したもの自身は除く）。
 * 並び順: 距離 → つながりの数 → 更新日時。各件に、たどり着いた関係（via）と observation の先頭 1 件（preview）を添える
 */
export async function relatedEntities(db, startIds, depth) {
  const seen = new Map(startIds.map((id) => [id, { distance: 0 }]));
  let frontier = [...startIds];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const { results } = await db
      .prepare(
        `SELECT r.from_id, r.to_id, r.relation_type, f.name AS from_name, t.name AS to_name
         FROM relations AS r JOIN entities AS f ON f.id = r.from_id JOIN entities AS t ON t.id = r.to_id
         WHERE r.from_id IN (SELECT value FROM json_each(?1)) OR r.to_id IN (SELECT value FROM json_each(?1))
         ORDER BY r.id LIMIT ${RELATED_EDGES}`
      )
      .bind(JSON.stringify(frontier))
      .all();
    const next = [];
    const inFrontier = new Set(frontier);
    for (const r of results) {
      for (const [here, there] of [[r.from_id, r.to_id], [r.to_id, r.from_id]]) {
        if (!inFrontier.has(here) || seen.has(there)) continue;
        seen.set(there, { distance: d, via: `${r.from_name} ${r.relation_type} ${r.to_name}` });
        next.push(there);
      }
    }
    frontier = next;
  }
  const found = [...seen.entries()].filter(([, v]) => v.distance > 0);
  if (!found.length) return [];
  const { results: rows } = await db
    .prepare(
      `SELECT e.id, e.name, e.entity_type, e.updated_at,
         (SELECT COUNT(*) FROM relations AS r WHERE r.from_id = e.id OR r.to_id = e.id) AS degree,
         (SELECT content FROM observations AS o WHERE o.entity_id = e.id ORDER BY o.id LIMIT 1) AS first
       FROM entities AS e WHERE e.id IN (SELECT value FROM json_each(?1))`
    )
    .bind(JSON.stringify(found.map(([id]) => id)))
    .all();
  return rows
    .map((r) => ({ ...r, ...seen.get(r.id) }))
    .sort((a, b) => a.distance - b.distance || b.degree - a.degree || String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, RELATED_LIMIT)
    .map((r) => {
      const item = { name: r.name, entityType: r.entity_type, distance: r.distance, via: r.via };
      if (r.first) item.preview = clip(r.first);
      return item;
    });
}

// タスクの文によく出るが、知識の手がかりにならない語
const STOP_WORDS = new Set([
  '実装', '対応', '確認', '追加', '修正', '作成', '変更', '調査', '検討', '機能', '画面', '作業', '依頼', '設定', '改善', '整理', '反映', '関連', '知識', '記憶',
  'タスク', 'レビュー', 'テスト', 'ドキュメント',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'issue', 'task', 'todo', 'fix', 'add', 'update', 'https', 'http', 'com', 'github',
]);

/**
 * タスクのタイトルと説明から検索語を取り出す。日本語は分かち書きされないので、
 * 英数字のまとまり・カタカナのまとまり・漢字のまとまり（長いものは 2 文字ずつ）を語として使う。タイトルの語を優先する
 */
export function taskTerms(title, description) {
  const terms = [];
  for (const text of [title, description || '']) {
    const tokens = text.normalize('NFKC').match(/[A-Za-z][A-Za-z0-9_.+#-]{2,}|[\p{Script=Katakana}ー]{3,}|\p{Script=Han}{2,}/gu) || [];
    for (const token of tokens) {
      const t = token.replace(/[._-]+$/, '');
      const parts = /^\p{Script=Han}+$/u.test(t) && t.length > 4 ? t.match(/\p{Script=Han}{2}/gu) : [t];
      for (const p of parts) {
        if (STOP_WORDS.has(p.toLowerCase()) || terms.some((x) => x.toLowerCase() === p.toLowerCase())) continue;
        terms.push(p);
      }
    }
  }
  return terms.slice(0, TASK_TERMS);
}

/**
 * タスクに関係のありそうな知識（タスクのスコープと global から上位 3 件）。
 * 当て推量を減らすため、2 語以上が一致したものか、名前に語が含まれるものだけを返す
 */
export async function knowledgeForTask(db, scope, task) {
  const terms = taskTerms(task.title, task.description);
  if (!terms.length) return [];
  const scopes = scope === 'global' ? ['global'] : [scope, 'global'];
  const hits = (await rankEntities(db, scopes, terms, TASK_KNOWLEDGE * 4))
    .filter((h) => h.matched >= Math.min(2, terms.length) || h.nameHits > 0)
    .slice(0, TASK_KNOWLEDGE);
  if (!hits.length) return [];
  const { results } = await db
    .prepare('SELECT entity_id, content FROM observations WHERE entity_id IN (SELECT value FROM json_each(?1)) ORDER BY id')
    .bind(JSON.stringify(hits.map((h) => h.id)))
    .all();
  const lowered = terms.map((t) => t.toLowerCase());
  return hits.map((h) => {
    const contents = results.filter((r) => r.entity_id === h.id).map((r) => r.content);
    const best = contents.find((c) => lowered.some((t) => c.toLowerCase().includes(t))) || contents[0];
    const item = { name: h.name, entityType: h.entity_type };
    if (h.scope !== scope) item.scope = h.scope;
    if (best) item.preview = clip(best);
    return item;
  });
}

function clip(text) {
  const chars = [...text];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : text;
}

export function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 関係の種類（#19）。向きは「from が to に対して〜」。create_relations はここにある種類だけを受け付ける。
 * 足さなかった候補: supports（about と derived_from で足りる）、applied_to（applies_to と紛らわしい）、
 * validated_by（検証の流れ #21 を作るときに考える）
 */
export const RELATION_TYPES = {
  part_of: 'from は to の一部（Component → Project）',
  applies_to: 'from（決まり・教訓）が to に当てはまる（Convention → Component）',
  supersedes: 'from が to を置き換える。古い to は消さずに残す（Decision → Decision）',
  uses: 'from が to を使う（Project・Component・Person → Tech）',
  about: 'from は to についての知識（Lesson → Tech）',
  responsible_for: 'from が to を担当する（Agent・Person → Component）',
  contradicts: 'from と to の内容が食い違う。どちらが正しいか確かめるまで両方残す（Lesson → Lesson）',
  derived_from: 'from は to から導いた知識（Convention → Lesson、Lesson → Decision）',
};

// よくある書き間違い → 正しい種類
const RELATION_ALIASES = { applied_to: 'applies_to', apply_to: 'applies_to', partof: 'part_of', use: 'uses', contradict: 'contradicts', derives_from: 'derived_from', supercedes: 'supersedes' };

/** 関係の種類を確かめる。正しければその名前、違えば null と、言い換えの候補を返す */
export function checkRelationType(value) {
  if (Object.hasOwn(RELATION_TYPES, value)) return { ok: value };
  const key = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (Object.hasOwn(RELATION_TYPES, key)) return { ok: null, suggestion: key };
  return { ok: null, suggestion: Object.hasOwn(RELATION_ALIASES, key) ? RELATION_ALIASES[key] : null };
}

/**
 * エンティティの種類（#18）。where は置き場所の目安: global（共通）、project（プロジェクト）、any（どちらでも）。
 * 名前は「種類:スコープ/名前」（Tech と Person はスコープを付けない「種類:名前」）
 */
export const ENTITY_TYPES = {
  Project: { where: 'project', meaning: 'プロジェクトの入り口（目的・構成・主要Component の一覧）。1 プロジェクトに 1 つ', example: 'Project:myapp' },
  Component: { where: 'project', meaning: 'プロジェクトの部品（画面・API・スクリプトなど）', example: 'Component:myapp/auth' },
  Decision: { where: 'project', meaning: '決めたことと理由。変えるときは新しい Decision から supersedes', example: 'Decision:myapp/use-sqlite' },
  Convention: { where: 'any', meaning: '守る決まり・書き方', example: 'Convention:global/commit-message-ja' },
  Lesson: { where: 'any', meaning: 'やってみてわかった教訓（失敗とその回避策など）', example: 'Lesson:global/pwsh-native-args' },
  Agent: { where: 'any', meaning: 'AI（エージェント）の役割や得意なこと', example: 'Agent:codex-mypc' },
  Tech: { where: 'global', meaning: '使っている技術・道具とその使い方のこつ', example: 'Tech:PowerShell7' },
  Person: { where: 'global', meaning: '人の好みや前提（秘密・個人情報は書かない）', example: 'Person:owner' },
};

const ENTITY_ALIASES = { technology: 'Tech', tool: 'Tech', library: 'Tech', rule: 'Convention', guideline: 'Convention', learning: 'Lesson', insight: 'Lesson', user: 'Person', owner: 'Person', module: 'Component', feature: 'Component', decisionrecord: 'Decision', adr: 'Decision' };

/**
 * エンティティの種類と名前を確かめる。
 * 返り値: { error } 使えないとき / { hint } 使えるが置き場所が目安と違うとき / {} 問題なし
 */
export function checkEntity(name, entityType, scope) {
  if (!Object.hasOwn(ENTITY_TYPES, entityType)) {
    const key = entityType.toLowerCase().replace(/[\s_-]+/g, '');
    const fixed = Object.keys(ENTITY_TYPES).find((t) => t.toLowerCase() === key) || (Object.hasOwn(ENTITY_ALIASES, key) ? ENTITY_ALIASES[key] : null);
    return { error: `種類 ${entityType} は使えません。${fixed ? `${fixed} のことですか？ ` : ''}使える種類: ${Object.keys(ENTITY_TYPES).join(', ')}` };
  }
  if (!name.startsWith(`${entityType}:`) || name.length === entityType.length + 1) {
    return { error: `${name}: 名前は「${entityType}:」で始めてください（例: ${ENTITY_TYPES[entityType].example}）` };
  }
  const where = ENTITY_TYPES[entityType].where;
  if (where === 'global' && scope !== 'global') return { hint: `${name}: ${entityType} は共通（memory-global）に置くのが目安です` };
  if (where === 'project' && scope === 'global') return { hint: `${name}: ${entityType} はプロジェクト（memory-project）に置くのが目安です` };
  return {};
}

// ---------------------------------------------------------------------------
// 重複の候補（#28）。自動ではまとめず、管理画面で人が確かめてからまとめる・消す
// ---------------------------------------------------------------------------

const PAIRWISE_LIMIT = 500;    // 種類ごとに総当たりで比べるエンティティの上限（Worker の CPU 時間を守る）
const OBSERVATION_SCAN = 5000; // 同じ内容の observation を探すときに読む上限
const SIMILAR_JACCARD = 0.7;

/** 名前の比べる部分。「種類:」とスコープの部分（最後の / より前）を除き、表記ゆれ（全角・半角、大文字・小文字、区切り記号）をそろえる */
export function nameKey(name) {
  const body = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  const last = body.includes('/') ? body.slice(body.lastIndexOf('/') + 1) : body;
  return last.normalize('NFKC').toLowerCase().replace(/[\s_\-.・/]+/g, '');
}

/** observation の比べる部分。先頭の [日付 書き手] と、空白・句読点を除く */
export function contentKey(content) {
  return content
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s。、，．,.!?！？「」『』（）()"'`:：;；]+/g, '');
}

function bigrams(s) {
  const chars = [...s];
  const set = new Set();
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 2 つの名前が似ているか。似ていれば理由（same / contains / similar）、似ていなければ null */
function similarity(ka, kb, ga, gb) {
  if (ka === kb) return 'same';
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if ([...short].length >= 4 && long.includes(short)) return 'contains';
  if ([...short].length >= 4 && jaccard(ga, gb) >= SIMILAR_JACCARD) return 'similar';
  return null;
}

export const SIMILAR_LABEL = { same: '表記ゆれ', contains: '片方がもう片方を含む', similar: 'よく似ている' };

/** 同じ種類で、名前の似たエンティティの組（同じスコープの中）。[{ a, b, entityType, reason }] */
function similarPairs(entities) {
  const byType = new Map();
  for (const e of entities) {
    if (!byType.has(e.entity_type)) byType.set(e.entity_type, []);
    byType.get(e.entity_type).push({ ...e, key: nameKey(e.name) });
  }
  const pairs = [];
  for (const [type, list] of byType) {
    const items = list.slice(0, PAIRWISE_LIMIT).map((e) => ({ ...e, grams: bigrams(e.key) }));
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const reason = items[i].key && items[j].key ? similarity(items[i].key, items[j].key, items[i].grams, items[j].grams) : null;
        if (reason) pairs.push({ a: items[i].name, b: items[j].name, entityType: type, reason });
      }
    }
  }
  const order = { same: 0, contains: 1, similar: 2 };
  return pairs.sort((x, y) => order[x.reason] - order[y.reason] || x.a.localeCompare(y.a));
}

/**
 * スコープの中の重複の候補。
 * entities: 名前の似たエンティティの組、observations: 同じ内容（日付・書き手・句読点を除いて同じ）の observation のまとまり
 */
export async function duplicateCandidates(db, scope) {
  const { results: entities } = await db
    .prepare('SELECT id, name, entity_type FROM entities WHERE scope = ?1 ORDER BY id')
    .bind(scope)
    .all();
  const { results: obs } = await db
    .prepare(
      `SELECT o.id, o.content, o.author, o.created_at, e.name FROM observations AS o JOIN entities AS e ON e.id = o.entity_id
       WHERE e.scope = ?1 ORDER BY o.id LIMIT ${OBSERVATION_SCAN}`
    )
    .bind(scope)
    .all();
  const groups = new Map();
  for (const o of obs) {
    const key = contentKey(o.content);
    if ([...key].length < 6) continue; // 短すぎるもの（「x」など）は偶然そろいやすいので見ない
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return {
    entities: similarPairs(entities),
    observations: [...groups.values()].filter((g) => g.length > 1),
    scannedAll: obs.length < OBSERVATION_SCAN,
  };
}

/** 作ったばかりのエンティティに似た、既存のエンティティ（create_entities の知らせ用）。[{ name, similarTo: [...] }] */
export async function similarExisting(db, scope, created) {
  if (!created.length) return [];
  const { results } = await db
    .prepare(
      `SELECT name, entity_type FROM entities WHERE scope = ?1 AND entity_type IN (SELECT value FROM json_each(?2))
         AND name NOT IN (SELECT value FROM json_each(?3)) ORDER BY id DESC LIMIT ${PAIRWISE_LIMIT}`
    )
    .bind(scope, JSON.stringify([...new Set(created.map((c) => c.entityType))]), JSON.stringify(created.map((c) => c.name)))
    .all();
  const existing = results.map((r) => ({ ...r, key: nameKey(r.name), grams: bigrams(nameKey(r.name)) }));
  const out = [];
  for (const c of created) {
    const key = nameKey(c.name);
    const grams = bigrams(key);
    const hits = existing.filter((e) => e.entity_type === c.entityType && key && e.key && similarity(key, e.key, grams, e.grams)).map((e) => e.name);
    if (hits.length) out.push({ name: c.name, similarTo: hits.slice(0, 3) });
  }
  return out;
}
