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
