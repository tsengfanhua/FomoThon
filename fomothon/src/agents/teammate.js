// 學生 Agent（技能互補）：依能力缺口找隊友，輸出推薦隊友、互補原因與團隊缺口。
// 三輪搜尋＋品質閘門：精準搜尋 → 補查作品集與課綱證據 → 相關技能的潛力探索。
// 硬條件：對方已開放媒合、有可投入時間、不是本人、不重複推薦。
import {sum} from '../util.js';
import {injectFault} from './tools.js';

const AGENT = 'teammate';
// 100 分 = 核心技能 50 + 可投入時間 20 + 作品／證照佐證 10 + 相關經驗 5 + 組隊意願 15
const WEIGHTS = Object.freeze({core: 50, time: 20, proof: 10, experience: 5, willingness: 15});
const FULL_TIME_HOURS = 5;
const PROOF_POINTS = [0, 4, 7, 10];
const MAX_CARDS = 5;
const ROUNDS = Object.freeze([
  {mode: 'precise', label: '精準搜尋：已確認且已驗證的技能'},
  {mode: 'evidence', label: '補查證據：作品集、自述與尚未確認的課綱證據'},
  {mode: 'potential', label: '潛力探索：相關技能'},
]);

export function createTeammateAgent({db, skills, levels, rules, tools, config}) {
  const M = config?.fixedWorkflow ? {...rules.matching, maxRounds: 1} : rules.matching; // 消融基準：只做第一輪

  function loadPeers(requesterId) {
    const users = db.prepare("SELECT * FROM users WHERE role = 'student' AND id != ?").all(requesterId)
      .map(u => ({id: u.id, name: u.name, dept: u.dept, ...JSON.parse(u.attrs)}));
    const states = new Map(db.prepare('SELECT owner_id, state FROM profiles').all().map(r => [r.owner_id, r.state]));
    return users.map(u => ({...u, profileState: states.get(u.id) ?? 'none'}));
  }

  const skillRow = (ownerId, skillId) => db.prepare('SELECT * FROM profile_skills WHERE owner_id = ? AND skill_id = ? AND kept = 1').get(ownerId, skillId);
  // 計分只用他人可見的等級帶，不用精確分數（見 levels.publicScore）
  const publicScore = row => levels.publicScore(skills.get(row.skill_id), row.score);
  const proofCount = (ownerId, skillId) => db.prepare(
    "SELECT COUNT(*) AS n FROM evidence WHERE owner_id = ? AND skill_id = ? AND type != 'course' AND status = 'verified'").get(ownerId, skillId).n;

  /** 依搜尋模式判斷某位同學是否符合，並回傳核心技能的依據。 */
  function basisFor(peer, skillId, mode) {
    const row = skillRow(peer.id, skillId);
    if (mode === 'precise') {
      if (row && peer.profileState === 'confirmed' && row.status === 'verified') {
        return {effective: publicScore(row), level: row.level, flags: {}, text: `已驗證：${row.level}`};
      }
      return null;
    }
    if (mode === 'evidence') {
      if (!row) return null;
      if (peer.profileState === 'confirmed' && row.status === 'verified') return null; // 第一輪已涵蓋
      const flags = {
        unverified: row.status === 'self_reported',
        unconfirmed: peer.profileState !== 'confirmed',
        inferred: row.status === 'inferred',
      };
      const why = flags.unverified ? '僅自述，待驗證' : flags.unconfirmed ? '課綱證據，對方尚未確認能力檔案' : '由相關證據推估';
      return {effective: publicScore(row) * M.unconfirmedDiscount, level: row.level, flags, text: `${row.level}（${why}）`};
    }
    // potential：沒有該技能，但相關技能有證據
    if (row) return null;
    const best = skills.related(skillId)
      .map(rel => ({rel, row: skillRow(peer.id, rel.id)}))
      .filter(x => x.row && x.row.status !== 'self_reported')
      .map(x => ({...x, value: publicScore(x.row) * x.rel.weight}))
      .sort((a, b) => b.value - a.value)[0];
    if (!best) return null;
    return {
      effective: best.value, level: null, flags: {potential: true},
      text: `相關技能「${skills.name(best.rel.id)}」${best.row.level}，以關聯度 ${best.rel.weight} 折算（待驗證）`,
    };
  }

  tools.register({
    name: 'peers.search', agent: AGENT, permission: 'read',
    summarize: r => `找到 ${r.records.length} 位（另有 ${r.excluded.notOpen} 位未開放媒合已排除）`,
    handler: async ({skillId, mode, requesterId}, ctx) => {
      injectFault(ctx.faults?.peers, ctx.attempt, '學生資料庫');
      const peers = loadPeers(requesterId);
      const matched = peers.map(peer => ({peer, basis: basisFor(peer, skillId, mode)})).filter(x => x.basis);
      const open = matched.filter(x => x.peer.openToMatch && x.peer.hoursPerWeek > 0);
      return {records: open, excluded: {notOpen: matched.length - open.length}};
    },
  });

  function toCard({peer, basis}, skillId, round, gapSkillIds) {
    const proofs = Math.min(proofCount(peer.id, skillId), PROOF_POINTS.length - 1);
    const parts = {
      core: WEIGHTS.core * Math.min(1, basis.effective / 100),
      time: WEIGHTS.time * Math.min(1, peer.hoursPerWeek / FULL_TIME_HOURS),
      proof: PROOF_POINTS[proofs],
      experience: peer.experience >= 1 ? WEIGHTS.experience : 0,
      willingness: peer.looking ? WEIGHTS.willingness : 8,
    };
    const total = Math.round(sum(Object.values(parts)));
    const covers = gapSkillIds.filter(id => id !== skillId)
      .filter(id => { const r = skillRow(peer.id, id); return r && r.status !== 'self_reported' && r.score >= M.validScore; });
    const reasons = [`${skills.name(skillId)}：${basis.text}`];
    if (proofs) reasons.push(`已驗證的作品／證照 ${proofs} 件`);
    if (covers.length) reasons.push(`同時可補：${covers.map(skills.name).join('、')}`);
    if (peer.experience >= 1) reasons.push(`有 ${peer.experience} 次競賽經驗`);
    reasons.push(`每週可投入 ${peer.hoursPerWeek} 小時${peer.looking ? '，正在找隊伍' : ''}`);
    return {
      id: peer.id, name: peer.name, dept: peer.dept, year: peer.year, bio: peer.bio,
      skillId, skillName: skills.name(skillId), level: basis.level, flags: basis.flags,
      total, parts: Object.fromEntries(Object.entries(parts).map(([k, val]) => [k, Math.round(val * 10) / 10])), weights: WEIGHTS,
      reasons, covers, round, valid: total >= M.validScore,
    };
  }

  /**
   * 為單一能力缺口找隊友。
   * @param {{student:object, skillId:string, excludeIds?:string[], gapSkillIds?:string[]}} params
   */
  async function match(ctx, {student, skillId, excludeIds = [], gapSkillIds = []}) {
    const seen = new Set([student.id, ...excludeIds]);
    const rounds = [];
    let candidates = [];
    let stop = null;

    for (const [index, round] of ROUNDS.slice(0, M.maxRounds).entries()) {
      const res = await tools.call(ctx, 'peers.search', {skillId, mode: round.mode, requesterId: student.id}, {retries: 1});
      if (!res.ok) {
        // 工具失敗：不輸出任何未經查證的推薦，保留已查得的真實結果並停止
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
      if (index + 1 < Math.min(ROUNDS.length, M.maxRounds)) {
        ctx.trace.emit('replan', `有效候選不足，改用「${ROUNDS[index + 1].label}」`, {agent: AGENT, data: {skillId, next: ROUNDS[index + 1].mode}});
      } else {
        stop = {reason: 'max_rounds', message: `已達探索上限 ${M.maxRounds} 輪，停止搜尋`};
        ctx.trace.emit('stop', `${skills.name(skillId)}：${stop.message}（有效候選 ${valid} 位）`, {agent: AGENT, data: {skillId}});
      }
    }

    const ranked = [...candidates].sort((a, b) => Number(b.valid) - Number(a.valid) || b.total - a.total).slice(0, MAX_CARDS);
    const validCount = ranked.filter(c => c.valid).length;
    return {
      skillId, skillName: skills.name(skillId), rounds, candidates: ranked, validCount, stop,
      status: stop?.reason === 'tool_failure' ? 'failed' : validCount > 0 ? 'matched' : 'insufficient',
    };
  }

  return Object.freeze({match});
}
