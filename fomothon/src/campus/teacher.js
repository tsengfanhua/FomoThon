// 教師 Agent（真實資料）：需求技能 × 教師 Agent 分析出的教師 ESCO 技能 → 專長相符的教師、契合原因、待確認條件。
// 介面與 agents/teacher.js 相同。與合成資料版的差別：
//   - 這些教師不是平台帳號：只列出供學生自行聯絡，系統不會、也不能代為送出邀請（invitable: false）。
//   - 沒有開課、指導紀錄與名額資料：只依「專長涵蓋」與「是否出自專長條列」計分，不補假資料。
import {injectFault} from '../agents/tools.js';
import {matchSkill} from '../hub/match.js';
import {sum} from '../util.js';

const AGENT = 'teacher';
// 100 分 = 專長涵蓋 70 + 專長條列佐證 30
const WEIGHTS = Object.freeze({coverage: 70, declared: 30});
const RELATED_SHARE = 0.5;
/** 專長涵蓋拿滿分需要涵蓋幾項：至少兩項、需求多時是三分之一，但不超過需求數。 */
const fullHits = targets => Math.min(targets, Math.max(2, Math.ceil(targets / 3)));
const MAX_CARDS = 4;

/**
 * @param {{store:object, skills:object, rules:object, tools:object}} deps
 */
export function createCampusTeacher({store, skills, rules, tools}) {
  tools.register({
    name: 'campus.teachers.search', agent: AGENT, permission: 'read',
    summarize: r => `${r.length} 位教師有技能資料`,
    handler: async (_args, ctx) => {
      injectFault(ctx.faults?.teachers, ctx.attempt, '教師資料庫');
      return store.listAdvisors().filter(a => a.skills.length);
    },
  });

  function toCard(advisor, targetIds, relations) {
    const own = new Map(advisor.skills.map(s => [s.uri, s]));
    const hits = targetIds.map(id => ({id, ...matchSkill(id, own, relations)}));
    const exact = hits.filter(h => h.level === 'exact');
    const near = hits.filter(h => h.level === 'related');
    const matched = [...exact, ...near];
    if (!matched.length) return null;
    const hitSum = exact.length + RELATED_SHARE * near.length;
    // 證據出自教師自己列的專長（skill[n]），比只出現在論文或計畫標題更能代表專長
    const declared = matched.filter(h => own.get(h.via).sourceSection.startsWith('skill[')).length;
    const parts = {
      coverage: WEIGHTS.coverage * Math.min(1, hitSum / fullHits(targetIds.length)),
      declared: WEIGHTS.declared * (declared / matched.length),
    };
    const total = Math.round(sum(Object.values(parts)));
    const reasons = [];
    if (exact.length) reasons.push(`專長相符：${exact.map(h => skills.name(h.id)).join('、')}`);
    if (near.length) reasons.push(`專長相近：${near.map(h => `${skills.name(h.id)}（具備 ${own.get(h.via).label}）`).join('、')}`);
    // 多項技能可能出自同一句原文，依據只列一次
    reasons.push(...[...new Set(matched.map(h => own.get(h.via).evidence))].slice(0, 3).map(text => `依據：「${text}」`));
    const uncovered = hits.filter(h => h.level === 'none').map(h => skills.name(h.id));
    const toConfirm = ['不是平台帳號：請自行聯絡，系統不會代為邀請', '專長來自公開資料的文字證據，不代表老師同意指導'];
    if (uncovered.length) toConfirm.push(`專長未涵蓋：${uncovered.slice(0, 5).join('、')}`);
    return {
      id: advisor.id, name: advisor.name, dept: advisor.department ?? advisor.college ?? '', expertise: advisor.expertise.slice(0, 6), total,
      parts: Object.fromEntries(Object.entries(parts).map(([k, val]) => [k, Math.round(val * 10) / 10])), weights: WEIGHTS,
      reasons, toConfirm, quota: null, valid: total >= rules.matching.validScore, invitable: false, real: true, hitSum,
    };
  }

  /**
   * @param {object} ctx
   * @param {{targetIds:string[]}} params targetIds：需求技能的 ESCO URI
   */
  async function match(ctx, {targetIds}) {
    const res = await tools.call(ctx, 'campus.teachers.search', {}, {retries: 1});
    if (!res.ok) {
      const message = `教師技能資料無法查詢（${res.error.code}），不輸出未經查證的推薦`;
      ctx.trace.emit('stop', message, {agent: AGENT});
      return {status: 'failed', candidates: [], excluded: null, stop: {reason: 'tool_failure', message}, real: true};
    }
    const relations = store.relations();
    const cards = res.result.map(a => toCard(a, targetIds, relations)).filter(Boolean)
      .sort((a, b) => b.total - a.total || b.hitSum - a.hitSum || a.id.localeCompare(b.id)).slice(0, MAX_CARDS)
      .map(({hitSum, ...card}) => card);
    const validCount = cards.filter(c => c.valid).length;
    ctx.trace.emit('gate', `教師媒合（真實資料）：${res.result.length} 位教師有技能資料，其中 ${validCount} 位達有效門檻 ${rules.matching.validScore} 分`,
      {agent: AGENT, data: {searched: res.result.length, valid: validCount}});
    return {
      status: validCount ? 'matched' : 'insufficient', candidates: cards, validCount, excluded: null,
      targetNames: targetIds.map(skills.name), stop: null, real: true,
    };
  }

  return Object.freeze({match});
}
