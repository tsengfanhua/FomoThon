// 競賽 Agent：競賽需求 × 學生 Skill Profile → 推薦競賽、優點、弱項、能力缺口。
// 資格與分數全部由固定規則計算；LLM 不參與計分。
import {mean, sum} from '../util.js';
import {ToolError, injectFault} from './tools.js';

const AGENT = 'competition';
// 適配度 100 分 = 主題與能力相符 30 + 能力缺口可補 20 + 難度與競爭強度 20 + 時程可行 15 + 學習與延伸價值 15
const WEIGHTS = Object.freeze({theme: 30, gapFill: 20, difficulty: 20, timing: 15, learn: 15});
const TEAMS_CEILING = 120;
const AWARD_RATE_CEILING = 0.3;

function parseCompetition(row) {
  return {id: row.id, name: row.name, type: row.type, deadline: row.deadline, ...JSON.parse(row.data)};
}

export function createCompetitionAgent({db, skills, levels, rules, clock, tools}) {
  const allCompetitions = () => db.prepare('SELECT * FROM competitions ORDER BY id').all().map(parseCompetition);

  tools.register({
    name: 'competition.search', agent: AGENT, permission: 'read',
    summarize: r => `${r.length} 項競賽`,
    handler: async ({skillIds = [], text = '', competitionId = null}) => {
      const list = allCompetitions();
      if (competitionId) return list.filter(c => c.id === competitionId);
      const upper = text.toUpperCase();
      const scored = list.map(c => {
        const skillHits = c.needs.filter(n => skillIds.includes(n.skill)).length;
        const keywordHits = c.keywords.filter(k => upper.includes(k.toUpperCase())).length + (upper.includes(c.type.toUpperCase()) ? 2 : 0);
        return {c, relevance: skillHits * 3 + keywordHits};
      });
      const matched = scored.filter(s => s.relevance > 0).sort((a, b) => b.relevance - a.relevance || a.c.id.localeCompare(b.c.id));
      // 沒有任何關鍵字或技能線索時，回傳全部，交由適配度排序
      return (matched.length ? matched : scored).map(s => ({...s.c, relevance: s.relevance}));
    },
  });

  tools.register({
    name: 'competition.history', agent: AGENT, permission: 'read',
    summarize: r => `近 ${r.teams.length} 屆平均 ${Math.round(mean(r.teams))} 隊`,
    handler: async ({competitionId}, ctx) => {
      injectFault(ctx.faults?.history, ctx.attempt, '歷屆資料庫');
      const comp = allCompetitions().find(c => c.id === competitionId);
      if (!comp) throw new ToolError('NOT_FOUND', '查無此競賽');
      return comp.history;
    },
  });

  tools.register({
    name: 'peers.coverage', agent: AGENT, permission: 'read',
    summarize: r => `${Object.values(r).filter(n => n > 0).length}/${Object.keys(r).length} 個缺口有可媒合人選`,
    handler: async ({skillIds, excludeId}) => {
      const openIds = new Set(db.prepare("SELECT id, attrs FROM users WHERE role = 'student'").all()
        .filter(u => JSON.parse(u.attrs).openToMatch && u.id !== excludeId).map(u => u.id));
      const out = {};
      for (const skillId of skillIds) {
        const holders = db.prepare('SELECT owner_id FROM profile_skills WHERE skill_id = ? AND kept = 1 AND score >= ?').all(skillId, rules.matching.validScore);
        out[skillId] = holders.filter(h => openIds.has(h.owner_id)).length;
      }
      return out;
    },
  });

  /** 資格檢查（硬條件）：科系限制、截止日。任一不符即不建議報名。 */
  function checkEligibility(comp, student) {
    const e = comp.eligibility;
    const daysLeft = clock.daysUntil(comp.deadline);
    const checks = [
      {key: 'student', label: '在學學生', ok: true},
      {key: 'dept', label: e.depts ? `科系限制：${e.depts.join('、')}` : '不限科系', ok: !e.depts || e.depts.includes(student.dept)},
      {key: 'deadline', label: daysLeft >= 0 ? `報名截止還有 ${daysLeft} 天` : `報名已於 ${comp.deadline} 截止`, ok: daysLeft >= 0},
    ];
    const notes = [`${e.teamMin}–${e.teamMax} 人一隊`, e.advisorRequired ? '需要指導老師' : '不強制指導老師'];
    return {eligible: checks.every(c => c.ok), checks, notes, daysLeft};
  }

  /** 逐項比對競賽需求與學生 Profile。只有「已驗證或課綱推估」的證據才算達標；僅自述者列為待驗證。 */
  function compareNeeds(comp, profileSkills) {
    const bySkill = new Map(profileSkills.filter(p => p.kept).map(p => [p.skill_id, p]));
    return comp.needs.map(need => {
      const have = bySkill.get(need.skill);
      const minScore = levels.minToScore(need.min);
      const base = {skillId: need.skill, name: skills.name(need.skill), weight: need.weight, minLabel: levels.minLabel(need.min)};
      if (!have) return {...base, status: 'missing', haveLabel: '無證據'};
      if (have.status === 'self_reported') return {...base, status: 'unverified', haveLabel: `${have.level}（自述，待驗證）`};
      if (have.score >= minScore) return {...base, status: 'met', haveLabel: have.level, inferred: have.status === 'inferred'};
      return {...base, status: 'weak', haveLabel: have.level};
    });
  }

  function scoreFit(comp, rows, eligibility, history, coverage) {
    const totalWeight = sum(rows.map(r => r.weight));
    const metWeight = sum(rows.filter(r => r.status === 'met').map(r => r.weight));
    const gaps = rows.filter(r => r.status !== 'met');
    const fillable = gaps.filter(g => (coverage?.[g.skillId] ?? 0) > 0);
    let difficulty = null;
    if (history) {
      const pressure = 0.5 * Math.min(1, mean(history.teams) / TEAMS_CEILING) + 0.5 * (1 - Math.min(1, history.awardRate / AWARD_RATE_CEILING));
      difficulty = WEIGHTS.difficulty * (1 - pressure);
    }
    const d = eligibility.daysLeft;
    const timing = d >= 30 ? 1 : d >= 14 ? 0.55 : d >= 0 ? 0.2 : 0;
    const stretch = rows.some(r => r.status === 'weak' || r.status === 'unverified');
    const parts = {
      theme: WEIGHTS.theme * (totalWeight ? metWeight / totalWeight : 0),
      gapFill: WEIGHTS.gapFill * (gaps.length ? fillable.length / gaps.length : 1),
      difficulty,
      timing: WEIGHTS.timing * timing,
      learn: WEIGHTS.learn * ((comp.extend.length ? 0.5 : 0) + (stretch ? 0.5 : 0.25)),
    };
    const rounded = Object.fromEntries(Object.entries(parts).map(([k, val]) => [k, val === null ? null : Math.round(val * 10) / 10]));
    return {total: Math.round(sum(Object.values(parts).map(val => val ?? 0))), parts: rounded, weights: WEIGHTS, partial: difficulty === null};
  }

  function describe(comp, rows, eligibility, history, fit) {
    const met = rows.filter(r => r.status === 'met');
    const strengths = met.map(r => `${r.name}：${r.haveLabel}，達到需求 ${r.minLabel}${r.inferred ? '（由相關證據推估）' : ''}`);
    const weaknesses = rows.filter(r => r.status === 'weak' || r.status === 'unverified')
      .map(r => (r.status === 'weak' ? `${r.name}：目前 ${r.haveLabel}，未達需求 ${r.minLabel}` : `${r.name}：${r.haveLabel}，需補上可驗證的證據`));
    const gaps = rows.filter(r => r.status !== 'met').map(r => ({skillId: r.skillId, name: r.name, kind: r.status}));
    const reasons = [];
    if (met.length) reasons.push(`${rows.length} 項需求技能中已具備 ${met.length} 項`);
    if (history) reasons.push(`近 ${history.teams.length} 屆平均 ${Math.round(mean(history.teams))} 隊參賽，得獎率約 ${Math.round(history.awardRate * 100)}%`);
    if (history?.note) reasons.push(history.note);
    if (eligibility.daysLeft >= 0) reasons.push(`距離報名截止還有 ${eligibility.daysLeft} 天`);
    if (comp.extend.length) reasons.push(`作品可延伸投稿：${comp.extend.join('、')}`);
    if (fit.partial) reasons.push('歷屆資料暫時無法取得，難度分項未計入');
    return {strengths, weaknesses, gaps, reasons};
  }

  /**
   * 分析單一競賽。歷屆資料查詢失敗時重試一次，仍失敗則略過難度分項並標示（不捏造數據）。
   */
  async function analyze(ctx, {student, competition}) {
    const profileSkills = db.prepare('SELECT * FROM profile_skills WHERE owner_id = ?').all(student.id);
    const eligibility = checkEligibility(competition, student);
    const rows = compareNeeds(competition, profileSkills);
    const gapIds = rows.filter(r => r.status !== 'met').map(r => r.skillId);

    const hist = await tools.call(ctx, 'competition.history', {competitionId: competition.id}, {retries: 1});
    if (!hist.ok) ctx.trace.emit('fallback', `「${competition.name}」歷屆資料無法取得，難度分項略過並標示`, {agent: AGENT});
    const cov = gapIds.length ? await tools.call(ctx, 'peers.coverage', {skillIds: gapIds, excludeId: student.id}) : {ok: true, result: {}};

    const history = hist.ok ? hist.result : null;
    const fit = scoreFit(competition, rows, eligibility, history, cov.ok ? cov.result : null);
    return {
      competition: {
        id: competition.id, name: competition.name, type: competition.type, deadline: competition.deadline,
        description: competition.description, extend: competition.extend, advisorRequired: competition.eligibility.advisorRequired,
        teamMin: competition.eligibility.teamMin, teamMax: competition.eligibility.teamMax,
      },
      eligibility, rows, fit,
      ...describe(competition, rows, eligibility, history, fit),
    };
  }

  /** 搜尋並分析多項競賽，依「資格符合優先、適配度高者優先」排序。 */
  async function recommend(ctx, {student, skillIds = [], text = '', limit = rules.matching.topCompetitions}) {
    const found = await tools.call(ctx, 'competition.search', {skillIds, text}, {retries: 1});
    if (!found.ok) return {error: found.error, analyses: [], considered: 0};
    const hasSignal = found.result.some(c => c.relevance > 0);
    const pool = found.result.slice(0, hasSignal ? limit + 1 : found.result.length);
    const analyses = [];
    for (const competition of pool) analyses.push(await analyze(ctx, {student, competition}));
    analyses.sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || b.fit.total - a.fit.total);
    return {analyses: analyses.slice(0, limit), considered: found.result.length, matchedBySignal: hasSignal};
  }

  const get = id => allCompetitions().find(c => c.id === id) ?? null;

  return Object.freeze({analyze, recommend, get, list: allCompetitions});
}
