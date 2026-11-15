// 共用 Skill 資料庫：標準化技能、別名比對、階層與相關技能。
// 學生、教師、競賽三方都只透過 Skill ID 互相比對。

const ASCII_WORD = /[A-Za-z0-9]/;

/**
 * 英數別名加上邊界，避免「Java」誤中「JavaScript」、「JS」誤中「JSON」。
 * 開頭也排除「英文字母＋.」之後的情況：「JS」不應誤中「Node.js」「Vue.js」這類產品名稱的字尾
 * （資料品質規則 A1 找到的問題；兩者的關係改由 Skill 資料庫的關聯表表達）。
 * 「1.Python」「單元一.SQL」這類編號清單仍比對得到。
 */
export function aliasRegex(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = ASCII_WORD.test(alias[0]) ? '(?<![A-Za-z0-9])(?<![A-Za-z]\\.)' : '';
  const tail = /[A-Za-z0-9+#.]/.test(alias.at(-1)) ? '(?![A-Za-z0-9+#])' : '';
  return new RegExp(head + escaped + tail, 'i');
}

/**
 * 依技能的中英文名稱與別名建立文字比對器（Skill 資料庫與資料品質檢核共用同一套規則）。
 * @param {Array<{id:string, zh:string, en:string, aliases:string[]}>} list
 * @returns {(text: string) => Array<{skillId:string, alias:string}>} 每個技能最多一筆
 */
export function createMatcher(list) {
  const matchers = list.map(s => ({
    id: s.id,
    patterns: [...new Set([s.zh, s.en, ...s.aliases])].map(alias => ({alias, re: aliasRegex(alias)})),
  }));
  return text => {
    if (!text) return [];
    const hits = [];
    for (const m of matchers) {
      const found = m.patterns.find(p => p.re.test(text));
      if (found) hits.push({skillId: m.id, alias: found.alias});
    }
    return hits;
  };
}

function parseRow(row) {
  return Object.freeze({
    id: row.id,
    zh: row.zh,
    en: row.en,
    category: row.category,
    parentId: row.parent_id,
    scale: row.scale,
    aliases: JSON.parse(row.aliases),
    ext: JSON.parse(row.ext),
  });
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSkillRepo(db) {
  const list = db.prepare('SELECT * FROM skills ORDER BY id').all().map(parseRow);
  const byId = new Map(list.map(s => [s.id, s]));
  const findInText = createMatcher(list);
  const relations = db.prepare('SELECT a, b, weight FROM skill_relations').all();

  const children = id => list.filter(s => s.parentId === id).map(s => s.id);

  /** 相關技能（潛力探索用）：明確關聯、同一上位技能的兄弟、上下位。 */
  function related(id) {
    const out = new Map();
    const add = (other, weight, via) => {
      if (other !== id && (!out.has(other) || out.get(other).weight < weight)) out.set(other, {id: other, weight, via});
    };
    for (const r of relations) {
      if (r.a === id) add(r.b, r.weight, 'relation');
      if (r.b === id) add(r.a, r.weight, 'relation');
    }
    const self = byId.get(id);
    if (self?.parentId) {
      add(self.parentId, 0.6, 'parent');
      for (const sib of children(self.parentId)) add(sib, 0.4, 'sibling');
    }
    for (const child of children(id)) add(child, 0.7, 'child');
    return [...out.values()].sort((x, y) => y.weight - x.weight);
  }

  return Object.freeze({
    all: () => list,
    get: id => byId.get(id) ?? null,
    has: id => byId.has(id),
    name: id => byId.get(id)?.zh ?? id,
    children,
    related,
    findInText,
  });
}
