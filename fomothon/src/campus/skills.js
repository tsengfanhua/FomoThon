// 真實資料模式的技能介面：以 ESCO 技能 URI 當技能 ID。
// 介面與 skills/repo.js 相同（name、has、get、all、related、findInText），協調器不需要知道背後是哪一套技能。
// 另外提供平台自建技能（SK-…）與 ESCO 之間的對照：平台技能的 ext.esco 是人工挑選的對應。

/** ESCO 關聯換算成關聯度，與平台技能的 related() 用同一種量尺（0–1）。 */
const RELATION_WEIGHT = Object.freeze({narrower: 0.7, broader: 0.6, related: 0.5, similar: 0.5});
const NONE_TAKEN = Object.freeze(new Set());
/** 平台技能對應到 ESCO 的精確度：人工標為 exact 的排最前面。 */
const precisionRank = skill => (skill.ext.esco.match === 'exact' ? 0 : 1);

/**
 * @param {{store:object, sk:object}} deps store：技能中樞的唯讀資料層；sk：平台自建的技能資料庫
 */
export function createCampusSkills({store, sk}) {
  const mapped = sk.all().filter(s => s.ext?.esco?.uri);
  const escoBySk = new Map(mapped.map(s => [s.id, s.ext.esco.uri]));
  // 多項平台技能可能對到同一項 ESCO 技能（例如機器學習、深度學習、電腦視覺都對到 machine learning）。
  // 反向對照時取對應最精確的那一項，同樣精確就取編號最小的：結果固定，不受資料列順序影響。
  const byPrecision = [...mapped].sort((a, b) => precisionRank(a) - precisionRank(b) || a.id.localeCompare(b.id));
  const skByEsco = new Map(byPrecision.toReversed().map(s => [s.ext.esco.uri, s.id]));

  const name = uri => store.skillView(uri).label;
  const get = uri => (store.hasSkill(uri) ? {id: uri, zh: name(uri), en: store.skillView(uri).en, scale: 'band', category: 'ESCO'} : null);

  function related(uri) {
    return [...(store.relations().get(uri) ?? [])]
      .map(([id, relation]) => ({id, weight: RELATION_WEIGHT[relation] ?? 0.5, via: relation}))
      .sort((a, b) => b.weight - a.weight);
  }

  /** 目標文字提到的技能：沿用平台技能的別名比對（「Java」「機器學習」…），再換成對應的 ESCO 技能。 */
  function findInText(text) {
    const uris = [...new Set(sk.findInText(text).map(hit => escoBySk.get(hit.skillId)).filter(Boolean))];
    return uris.map(uri => ({skillId: uri, alias: name(uri)}));
  }

  return Object.freeze({
    name, get, related, findInText,
    has: uri => store.hasSkill(uri),
    // 給模型辨識任務用的清單：只列得到別名比對的那幾十項，不把一萬多項 ESCO 技能塞進提示
    all: () => [...skByEsco.keys()].map(uri => ({id: uri, zh: name(uri)})),
    toEsco: id => escoBySk.get(id) ?? null,
    toSk: uri => skByEsco.get(uri) ?? null,
    /**
     * 找不到完全對應的平台技能時，退而求其次：有 ESCO 關聯（上下位、相關、語意相近）的平台技能。
     * taken：已經分給其他技能的平台技能，不重複使用。
     */
    toSkNear: (uri, taken = NONE_TAKEN) => skByEsco.get(uri)
      ?? related(uri).map(rel => skByEsco.get(rel.id)).find(id => id && !taken.has(id)) ?? null,
  });
}
