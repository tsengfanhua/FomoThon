// 跨 Agent 技能比對的固定規則（純函式，不讀資料庫、不呼叫模型）。
// 比賽、教師、課程、學生修課都已對應到同一組 ESCO 技能 URI，這裡只做集合比對與排序。

/** 「相近技能」的折算：ESCO 上下位、相關，或語意相近的技能算一半，不當成完全具備。 */
export const RELATED_WEIGHT = 0.5;
/** 教師排序：涵蓋比賽需求技能佔 60%、涵蓋學生缺口佔 40%（沒有缺口時只看前者）。 */
export const ADVISOR_WEIGHTS = Object.freeze({required: 0.6, gap: 0.4});

const LEVEL_WEIGHT = Object.freeze({exact: 1, related: RELATED_WEIGHT, none: 0});

/**
 * 判斷「擁有的技能」是否涵蓋某一項需求。
 * @param {string} uri 需求技能
 * @param {{has:(uri:string)=>boolean}} owned 擁有的技能（Set 或 Map）
 * @param {Map<string, Map<string, string>>} relations uri → (相關 uri → broader｜narrower｜related｜similar)
 */
export function matchSkill(uri, owned, relations) {
  if (owned.has(uri)) return {level: 'exact', via: uri, relation: null};
  for (const [other, relation] of relations.get(uri) ?? []) {
    if (owned.has(other)) return {level: 'related', via: other, relation};
  }
  return {level: 'none', via: null, relation: null};
}

/** 逐項比對需求技能，順序與輸入相同。 */
export function compareSkills(requiredUris, owned, relations) {
  return requiredUris.map(uri => ({uri, ...matchSkill(uri, owned, relations)}));
}

/** 涵蓋率（0–1）：完全具備算 1、相近算 RELATED_WEIGHT；沒有需求時回傳 null（無從評估）。 */
export function coverageOf(matches) {
  if (!matches.length) return null;
  return matches.reduce((acc, m) => acc + LEVEL_WEIGHT[m.level], 0) / matches.length;
}

export function summarize(matches) {
  const count = level => matches.filter(m => m.level === level).length;
  const ratio = coverageOf(matches);
  return {exact: count('exact'), related: count('related'), none: count('none'), percent: ratio === null ? null : Math.round(ratio * 100)};
}

/**
 * 教師排序。只回傳至少涵蓋一項需求技能的教師。
 * @param {{required:string[], gaps:string[], advisors:{id:string, skills:Map<string, object>}[], relations:Map, limit?:number}} input
 */
export function rankAdvisors({required, gaps, advisors, relations, limit = 5}) {
  const ranked = [];
  for (const advisor of advisors) {
    const matches = compareSkills(required, advisor.skills, relations).filter(m => m.level !== 'none');
    if (!matches.length) continue;
    const requiredCoverage = matches.reduce((acc, m) => acc + LEVEL_WEIGHT[m.level], 0) / required.length;
    const gapMatches = compareSkills(gaps, advisor.skills, relations);
    const gapCoverage = coverageOf(gapMatches);
    const score = gapCoverage === null
      ? requiredCoverage
      : ADVISOR_WEIGHTS.required * requiredCoverage + ADVISOR_WEIGHTS.gap * gapCoverage;
    ranked.push({
      id: advisor.id, score: Math.round(score * 100), requiredCoverage: Math.round(requiredCoverage * 100),
      gapCoverage: gapCoverage === null ? null : Math.round(gapCoverage * 100), matches,
      gapsCovered: gapMatches.filter(m => m.level !== 'none').map(m => m.uri),
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.matches.length - a.matches.length || a.id.localeCompare(b.id));
  return ranked.slice(0, limit);
}

/**
 * 找出能補上缺口的課程：涵蓋的缺口（完全相同算 1、相近算一半）越多越前面；同分時完全相同的技能較多者優先。
 * partial 是學生已經「相近」的缺口：這些只有完全相同的技能才算補得上。
 * @param {{gaps:string[], courses:{id:string, skills:Map<string, object>}[], relations:Map, partial?:Set<string>, limit?:number}} input
 */
export function recommendCourses({gaps, courses, relations, partial = new Set(), limit = 6}) {
  const exactCount = item => item.covers.filter(m => m.level === 'exact').length;
  const ranked = [];
  for (const course of courses) {
    const covers = compareSkills(gaps, course.skills, relations)
      .filter(m => m.level === 'exact' || (m.level === 'related' && !partial.has(m.uri)));
    if (!covers.length) continue;
    ranked.push({id: course.id, covers, weight: covers.reduce((acc, m) => acc + LEVEL_WEIGHT[m.level], 0)});
  }
  ranked.sort((a, b) => b.weight - a.weight || exactCount(b) - exactCount(a) || b.covers.length - a.covers.length || a.id.localeCompare(b.id));
  return ranked.slice(0, limit);
}

/** 教師姓名遮蔽：保留姓氏與最後一個字，例如「王Ｏ明」；非中文姓名只留首字母。 */
export function maskName(name) {
  const chars = [...String(name ?? '').trim()];
  if (!chars.length) return '';
  if (!/\p{Script=Han}/u.test(chars[0])) return `${chars[0].toUpperCase()}.`;
  if (chars.length <= 2) return `${chars[0]}Ｏ`;
  return `${chars[0]}${'Ｏ'.repeat(chars.length - 2)}${chars.at(-1)}`;
}
