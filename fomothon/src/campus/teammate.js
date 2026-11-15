// 學生 Agent（真實資料）：依能力缺口（ESCO 技能）找隊友。
// 同學仍是平台上的示意學生（可以收邀請、有組隊意願與可投入時間），但技能改由「真實課程的課綱」推得：
// 每位同學的修課清單 → 課程 Agent 分析出的 ESCO 技能。介面與 agents/teammate.js 相同。
// 與合成資料版的差別：沒有等級與驗證狀態，所以只有兩輪搜尋（有這項技能 → 有相近技能），作品／證照分項不計。
import {sum} from '../util.js';
import {injectFault} from '../agents/tools.js';

const AGENT = 'teammate';
// 100 分 = 核心技能 50 + 可投入時間 20 + 作品／證照佐證 10（真實資料暫缺）+ 相關經驗 5 + 組隊意願 15
const WEIGHTS = Object.freeze({core: 50, time: 20, proof: 10, experience: 5, willingness: 15});
const FULL_TIME_HOURS = 5;
const MAX_CARDS = 5;
const ROUNDS = Object.freeze([
  {mode: 'precise', label: '精準搜尋：修過的課有教這項技能'},
  {mode: 'potential', label: '潛力探索：修過的課有教相近的技能'},
]);

/**
 * @param {{db:object, hub:object, inventory:object, skills:object, rules:object, tools:object, config?:object}} deps
 */
export function createCampusTeammate({db, hub, inventory, skills, rules, tools, config}) {
  const M = config?.fixedWorkflow ? {...rules.matching, maxRounds: 1} : rules.matching;

  // 每位同學由修課推得的技能：同一次任務會查很多次，資料庫與修課清單沒變就沿用
  let skillCache = {stamp: null, byStudent: new Map()};
  function ownedSkills(studentId) {
    const stamp = `${hub.store.version()}|${inventory.version()}`;
    if (skillCache.stamp !== stamp) skillCache = {stamp, byStudent: new Map()};
    if (!skillCache.byStudent.has(studentId)) {
      const enrollments = inventory.enrollmentsFor(studentId);
      skillCache.byStudent.set(studentId, enrollments.length ? new Map(hub.studentSkills(enrollments).skills.map(s => [s.uri, s])) : null);
    }
    return skillCache.byStudent.get(studentId);
  }

  /** 其他學生與他們由修課推得的技能（uri → {label, sources}）。沒有修課資料的同學不列入。 */
  function loadPeers(requesterId) {
    return db.prepare("SELECT * FROM users WHERE role = 'student' AND id != ?").all(requesterId)
      .map(u => ({id: u.id, name: u.name, dept: u.dept, ...JSON.parse(u.attrs), owned: ownedSkills(u.id)}))
      .filter(peer => peer.owned);
  }

  /** 這位同學是否符合：precise＝有這項技能；potential＝沒有，但有 ESCO 關聯的技能（依關聯度折算）。 */
  function basisFor(peer, skillId, mode) {
    const exact = peer.owned.get(skillId);
    if (mode === 'precise') {
      if (!exact) return null;
      const src = exact.sources[0];
      return {effective: 100, flags: {}, text: `修過「${src.courseName}」，課綱：「${src.evidence}」`};
    }
    if (exact) return null;
    const best = skills.related(skillId).map(rel => ({rel, have: peer.owned.get(rel.id)})).filter(x => x.have).sort((a, b) => b.rel.weight - a.rel.weight)[0];
    if (!best) return null;
    return {effective: 100 * best.rel.weight, flags: {potential: true},
      text: `有相近技能「${best.have.label}」（修過「${best.have.sources[0].courseName}」），以關聯度 ${best.rel.weight} 折算`};
  }

  tools.register({
    name: 'campus.peers.search', agent: AGENT, permission: 'read',
    summarize: r => `找到 ${r.records.length} 位（另有 ${r.excluded.notOpen} 位未開放媒合已排除）`,
    handler: async ({skillId, mode, requesterId}, ctx) => {
      injectFault(ctx.faults?.peers, ctx.attempt, '學生資料庫');
      const matched = loadPeers(requesterId).map(peer => ({peer, basis: basisFor(peer, skillId, mode)})).filter(x => x.basis);
      const open = matched.filter(x => x.peer.openToMatch && x.peer.hoursPerWeek > 0);
      return {records: open, excluded: {notOpen: matched.length - open.length}};
    },
  });

  function toCard({peer, basis}, skillId, round, gapSkillIds) {
    const parts = {
      core: WEIGHTS.core * Math.min(1, basis.effective / 100),
      time: WEIGHTS.time * Math.min(1, peer.hoursPerWeek / FULL_TIME_HOURS),
      proof: 0, // 作品與證照還沒有對應到 ESCO 技能，不計分也不捏造
      experience: peer.experience >= 1 ? WEIGHTS.experience : 0,
      willingness: peer.looking ? WEIGHTS.willingness : 8,
    };
    const total = Math.round(sum(Object.values(parts)));
    const covers = gapSkillIds.filter(id => id !== skillId && peer.owned.has(id));
    const reasons = [`${skills.name(skillId)}：${basis.text}`];
    if (covers.length) reasons.push(`同時可補：${covers.map(skills.name).join('、')}`);
    if (peer.experience >= 1) reasons.push(`有 ${peer.experience} 次競賽經驗`);
    reasons.push(`每週可投入 ${peer.hoursPerWeek} 小時${peer.looking ? '，正在找隊伍' : ''}`);
    return {
      id: peer.id, name: peer.name, dept: peer.dept, year: peer.year, bio: peer.bio,
      skillId, skillName: skills.name(skillId), level: null, flags: basis.flags,
      total, parts: Object.fromEntries(Object.entries(parts).map(([k, val]) => [k, Math.round(val * 10) / 10])), weights: WEIGHTS,
      reasons, covers, round, valid: total >= M.validScore,
    };
  }

  /**
   * 為單一能力缺口找隊友：有效候選不足就擴大到相近技能，達標、輪數用完或工具失敗即停止。
   * @param {{student:object, skillId:string, excludeIds?:string[], gapSkillIds?:string[]}} params
   */
  async function match(ctx, {student, skillId, excludeIds = [], gapSkillIds = []}) {
    const seen = new Set([student.id, ...excludeIds]);
    const plan = ROUNDS.slice(0, M.maxRounds);
    const rounds = [];
    let candidates = [];
    let stop = null;

    for (const [index, round] of plan.entries()) {
      const res = await tools.call(ctx, 'campus.peers.search', {skillId, mode: round.mode, requesterId: student.id}, {retries: 1});
      if (!res.ok) {
        stop = {reason: 'tool_failure', message: `學生資料庫無法查詢（${res.error.code}），已停止搜尋；不輸出未經查證的推薦`};
        ctx.trace.emit('stop', stop.message, {agent: AGENT, data: {skillId, round: index + 1}});
        break;
      }
      const fresh = res.result.records.filter(r => !seen.has(r.peer.id));
      const duplicates = res.result.records.length - fresh.length;
      for (const r of fresh) seen.add(r.peer.id);
      candidates = [...candidates, ...fresh.map(r => toCard(r, skillId, index + 1, gapSkillIds))];
      const valid = candidates.filter(c => c.valid).length;
      const info = {n: index + 1, mode: round.mode, label: round.label, found: fresh.length, duplicates, excludedNotOpen: res.result.excluded.notOpen, validSoFar: valid};
      rounds.push(info);
      const passed = valid >= M.targetValid;
      ctx.trace.emit('gate', `品質閘門（${skills.name(skillId)}）第 ${index + 1} 輪：新增 ${fresh.length} 位、去除重複 ${duplicates} 位，有效候選 ${valid}/${M.targetValid} → ${passed ? '達標，停止搜尋' : '不足'}`,
        {agent: AGENT, data: {skillId, ...info, passed}});
      if (passed) {
        stop = {reason: 'quality_met', message: `有效候選達 ${M.targetValid} 位，停止搜尋`};
        break;
      }
      if (index + 1 < plan.length) {
        ctx.trace.emit('replan', `有效候選不足，改用「${plan[index + 1].label}」`, {agent: AGENT, data: {skillId, next: plan[index + 1].mode}});
      } else {
        stop = {reason: 'max_rounds', message: `已達探索上限 ${plan.length} 輪，停止搜尋`};
        ctx.trace.emit('stop', `${skills.name(skillId)}：${stop.message}（有效候選 ${valid} 位）`, {agent: AGENT, data: {skillId}});
      }
    }

    const ranked = [...candidates].sort((a, b) => Number(b.valid) - Number(a.valid) || b.total - a.total || a.id.localeCompare(b.id)).slice(0, MAX_CARDS);
    const validCount = ranked.filter(c => c.valid).length;
    return {
      skillId, skillName: skills.name(skillId), rounds, candidates: ranked, validCount, stop,
      status: stop?.reason === 'tool_failure' ? 'failed' : validCount > 0 ? 'matched' : 'insufficient',
    };
  }

  /** 各缺口有幾位開放媒合的同學修過教這項技能的課（競賽適配度的「缺口可補」分項用）。 */
  function coverage(uris, excludeId) {
    const open = loadPeers(excludeId).filter(peer => peer.openToMatch && peer.hoursPerWeek > 0);
    return Object.fromEntries(uris.map(uri => [uri, open.filter(peer => peer.owned.has(uri)).length]));
  }

  return Object.freeze({match, coverage});
}
