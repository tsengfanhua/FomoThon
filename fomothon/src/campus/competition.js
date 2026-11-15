// 競賽 Agent（真實資料）：競賽 Agent 爬到的比賽 × 學生的 ESCO 技能 → 推薦競賽、優點、弱項、能力缺口。
// 介面與 agents/competition.js 相同，回傳的分析結構也相同，協調器與畫面可以共用。
// 與合成資料版的差別：
//   - 需求技能沒有等級門檻：有相同的 ESCO 技能算達標，只有上下位／相關／語意相近的技能算「相近」（弱項）。
//   - 沒有歷屆資料：難度分項不計入並標示，不捏造數字。
//   - 參賽條件來自簡章抽取：未載明的條件標示為「待確認」，不當成符合，也不當成不符。
import {matchSkill} from '../hub/match.js';
import {sum} from '../util.js';

const AGENT = 'competition';
// 與合成資料版相同的配分，方便對照：主題與能力相符 30 + 缺口可補 20 + 難度 20（真實資料暫缺）+ 時程 15 + 學習價值 15
const WEIGHTS = Object.freeze({theme: 30, gapFill: 20, difficulty: 20, timing: 15, learn: 15});
const RELATED_SHARE = 0.5;
const UNKNOWN_TIMING = 0.55; // 截止日未載明：時程分項取中間值
const SEARCH_POOL = 12;
// 目標句子裡常見、但無助於分辨比賽的字詞
const STOP_BIGRAMS = new Set(['我想', '想參', '參加', '比賽', '競賽', '不確', '確定', '定自', '自己', '己夠', '夠不', '不夠', '夠格', '相關', '想找', '幫我',
  '但不', '推薦', '適合', '有沒', '沒有', '什麼', '可以', '報名', '想報', '找競', '找比', '能不', '不能', '賽事', '一個', '哪些']);

/** 把目標文字拆成比對用的詞：英數單字，加上中文的相鄰兩字。 */
export function termsOf(text) {
  const words = [...new Set((text.match(/[A-Za-z][A-Za-z0-9+#.]*/g) ?? []).filter(w => w.length >= 2).map(w => w.toUpperCase()))];
  const bigrams = new Set();
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const pair = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(pair)) bigrams.add(pair);
    }
  }
  return {words, bigrams: [...bigrams]};
}

const NAME_WEIGHT = 3; // 出現在比賽名稱裡的詞，比只出現在摘要、類別或技能名稱裡的更能代表主題

function textHits(haystack, {words, bigrams}) {
  const upper = haystack.toUpperCase();
  const wordHits = words.filter(w => new RegExp(`(?<![A-Z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9])`).test(upper)).length;
  return wordHits * 2 + bigrams.filter(pair => haystack.includes(pair)).length;
}

/** 比賽與目標的相關程度：提到的技能命中最重，其次是名稱裡的字詞，再來是摘要、類別與技能名稱裡的字詞。 */
export function relevanceOf(comp, {text = '', skillIds = []}) {
  const terms = termsOf(text);
  const rest = [comp.description, comp.type, ...comp.needs.flatMap(n => [n.name, n.en])].join(' ');
  const skillHits = comp.needs.filter(n => skillIds.includes(n.skill)).length;
  return skillHits * 3 + textHits(comp.name, terms) * NAME_WEIGHT + textHits(rest, terms);
}

/**
 * @param {{store:object, skills:object, clock:object, tools:object, rules:object}} deps
 */
export function createCampusCompetition({store, skills, clock, tools, rules}) {
  const today = () => clock.todayStr();

  function toInternal(c) {
    const e = c.eligibility ?? {};
    return {
      id: c.id, name: c.name, type: c.category ?? '其他', deadline: c.deadline, description: c.summary ?? '', organizer: c.organizer,
      sourceSite: c.sourceSite, sourceUrl: c.sourceUrl, conditions: c.conditions ?? [], collegeEligible: c.collegeEligible,
      eligibility: {studentRequired: e.student_required ?? null, levels: e.education_levels ?? null, teamMin: e.team_min ?? null, teamMax: e.team_max ?? null, advisorRequired: e.requires_advisor ?? null},
      needs: c.skills.map(s => ({skill: s.uri, name: s.label, en: s.en, evidence: s.evidence})),
    };
  }

  /** 只列有技能需求、大專生可參加的比賽（技能中樞裡也有限中小學或分析不出技能的比賽）。 */
  const usable = () => store.listCompetitions(today()).filter(c => c.skillCount > 0 && c.collegeEligible);
  const list = () => usable().map(c => ({id: c.id, name: c.name, type: c.category ?? '其他'}));
  function get(id) {
    const detail = store.getCompetition(id, today());
    return detail ? toInternal(detail) : null;
  }

  tools.register({
    name: 'campus.competition.search', agent: AGENT, permission: 'read',
    summarize: r => `${r.length} 項真實競賽`,
    handler: async ({skillIds = [], text = ''}) => {
      const scored = usable().map(c => get(c.id)).map(c => ({c, relevance: relevanceOf(c, {text, skillIds})}));
      const matched = scored.filter(s => s.relevance > 0).sort((a, b) => b.relevance - a.relevance || a.c.id.localeCompare(b.c.id));
      // 沒有任何線索時回傳全部，交由適配度排序
      return (matched.length ? matched : scored).map(s => ({...s.c, relevance: s.relevance}));
    },
  });

  /** 資格檢查：已截止或明確不收大專生才算不符；簡章沒寫的條件列為待確認。 */
  function checkEligibility(comp) {
    const e = comp.eligibility;
    const daysLeft = comp.deadline ? clock.daysUntil(comp.deadline) : null;
    const checks = [
      e.studentRequired === null ? {key: 'student', label: '學生身分：簡章未載明', ok: true, unknown: true}
        : {key: 'student', label: e.studentRequired ? '限在學學生' : '不限學生身分', ok: true},
      e.levels ? {key: 'level', label: `學歷：${e.levels.join('、')}`, ok: comp.collegeEligible}
        : {key: 'level', label: '學歷限制：簡章未載明', ok: true, unknown: true},
      daysLeft === null ? {key: 'deadline', label: '截止日：簡章未載明', ok: true, unknown: true}
        : {key: 'deadline', label: daysLeft >= 0 ? `截止還有 ${daysLeft} 天` : `已於 ${comp.deadline} 截止`, ok: daysLeft >= 0},
    ];
    const team = e.teamMin || e.teamMax ? `${e.teamMin ?? '?'}–${e.teamMax ?? '?'} 人一隊` : '隊伍人數：簡章未載明';
    const advisor = e.advisorRequired === true ? '需要指導老師' : e.advisorRequired === false ? '不強制指導老師' : '指導老師：簡章未載明';
    return {eligible: checks.every(c => c.ok), checks, notes: [team, advisor], daysLeft};
  }

  /** 逐項比對需求技能與學生的 ESCO 技能。owned：uri → {level, status, label}。 */
  function compareNeeds(comp, owned) {
    const relations = store.relations();
    return comp.needs.map(need => {
      const base = {skillId: need.skill, name: need.name, weight: 1, minLabel: '有證據', evidence: need.evidence};
      const m = matchSkill(need.skill, owned, relations);
      if (m.level === 'none') return {...base, status: 'missing', haveLabel: '無證據'};
      const have = owned.get(m.via);
      if (m.level === 'related') return {...base, status: 'weak', haveLabel: `相近：${have.label}`, via: m.via};
      if (have.status === 'self_reported') return {...base, status: 'unverified', haveLabel: `${have.level ?? '有'}（自述，待驗證）`};
      return {...base, status: 'met', haveLabel: have.level ?? '有課綱證據', inferred: have.status === 'inferred'};
    });
  }

  function scoreFit(rows, eligibility, coverage) {
    const metShare = rows.length ? (rows.filter(r => r.status === 'met').length + RELATED_SHARE * rows.filter(r => r.status === 'weak').length) / rows.length : 0;
    const gaps = rows.filter(r => r.status !== 'met');
    const fillable = gaps.filter(g => (coverage?.[g.skillId] ?? 0) > 0);
    const d = eligibility.daysLeft;
    const timing = d === null ? UNKNOWN_TIMING : d >= 30 ? 1 : d >= 14 ? 0.55 : d >= 0 ? 0.2 : 0;
    const stretch = rows.some(r => r.status === 'weak' || r.status === 'unverified');
    const parts = {
      theme: WEIGHTS.theme * metShare,
      gapFill: WEIGHTS.gapFill * (gaps.length ? fillable.length / gaps.length : 1),
      difficulty: null, // 真實比賽沒有歷屆參賽與得獎資料
      timing: WEIGHTS.timing * timing,
      learn: WEIGHTS.learn * (stretch ? 0.5 : 0.25),
    };
    const rounded = Object.fromEntries(Object.entries(parts).map(([k, val]) => [k, val === null ? null : Math.round(val * 10) / 10]));
    return {total: Math.round(sum(Object.values(parts).map(val => val ?? 0))), parts: rounded, weights: WEIGHTS, partial: true};
  }

  function describe(comp, rows, eligibility) {
    const met = rows.filter(r => r.status === 'met');
    const strengths = met.map(r => `${r.name}：${r.haveLabel}`);
    const weaknesses = rows.filter(r => r.status === 'weak' || r.status === 'unverified')
      .map(r => (r.status === 'weak' ? `${r.name}：只有相近的技能（${r.haveLabel.replace('相近：', '')}）` : `${r.name}：${r.haveLabel}，需補上可驗證的證據`));
    const gaps = rows.filter(r => r.status !== 'met').map(r => ({skillId: r.skillId, name: r.name, kind: r.status}));
    const reasons = [`資料來源：${comp.sourceSite}${comp.organizer ? `｜主辦：${comp.organizer}` : ''}`];
    if (met.length) reasons.push(`${rows.length} 項需求技能中已具備 ${met.length} 項`);
    if (eligibility.daysLeft !== null && eligibility.daysLeft >= 0) reasons.push(`距離截止還有 ${eligibility.daysLeft} 天`);
    reasons.push('真實比賽沒有歷屆資料，難度分項未計入', '參賽條件與技能需求由簡章抽取，報名前請以主辦單位公告為準');
    return {strengths, weaknesses, gaps, reasons};
  }

  /**
   * @param {object} ctx
   * @param {{student:object, competition:object, owned:Map, peerCoverage?:Function}} params
   *   owned：學生的 ESCO 技能；peerCoverage(ctx, uris)：各缺口有幾位可媒合的同學（uri → 人數）
   */
  async function analyze(ctx, {competition, owned, peerCoverage}) {
    const eligibility = checkEligibility(competition);
    const rows = compareNeeds(competition, owned);
    const gapIds = rows.filter(r => r.status !== 'met').map(r => r.skillId);
    const coverage = gapIds.length && peerCoverage ? await peerCoverage(ctx, gapIds) : {};
    const fit = scoreFit(rows, eligibility, coverage);
    return {
      competition: {
        id: competition.id, name: competition.name, type: competition.type, deadline: competition.deadline, description: competition.description,
        extend: [], advisorRequired: competition.eligibility.advisorRequired === true, teamMin: competition.eligibility.teamMin, teamMax: competition.eligibility.teamMax,
        real: true, sourceSite: competition.sourceSite, sourceUrl: competition.sourceUrl, conditions: competition.conditions,
      },
      eligibility, rows, fit,
      ...describe(competition, rows, eligibility),
    };
  }

  /** 搜尋並分析多項競賽，依「資格符合優先、適配度高者優先」排序。 */
  async function recommend(ctx, {skillIds = [], text = '', limit = rules.matching.topCompetitions, owned, peerCoverage}) {
    const found = await tools.call(ctx, 'campus.competition.search', {skillIds, text}, {retries: 1});
    if (!found.ok) return {error: found.error, analyses: [], considered: 0};
    const hasSignal = found.result.some(c => c.relevance > 0);
    const pool = found.result.slice(0, hasSignal ? limit + 1 : SEARCH_POOL);
    const relevance = new Map(pool.map(c => [c.id, c.relevance]));
    const analyses = [];
    for (const competition of pool) analyses.push(await analyze(ctx, {competition, owned, peerCoverage}));
    // 適配度相同時，與目標較相關的排前面
    analyses.sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || b.fit.total - a.fit.total
      || relevance.get(b.competition.id) - relevance.get(a.competition.id));
    // 目標有明確的主題（提到技能或英數名詞）卻沒有任何比賽命中：讓呼叫端明說，不把依截止日挑的比賽說成相關
    const offTopic = !hasSignal && (skillIds.length > 0 || termsOf(text).words.length > 0);
    return {analyses: analyses.slice(0, limit), considered: found.result.length, matchedBySignal: hasSignal, offTopic};
  }

  return Object.freeze({analyze, recommend, get, list});
}
