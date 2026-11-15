// 統一等級規則：由 config/level-rules.json 決定，全部為純函式。
// 核心原則：同一 Skill 的多筆證據「不疊加」，保留全部證據，取單筆最高分；
// 自述與推估的證據有分數上限，並在狀態上與已驗證證據區分。
import {clamp} from '../util.js';

const TRUST_ORDER = ['verified', 'inferred', 'self_reported'];
const BELOW_BASIC_PUBLIC_SCORE = 50;
export const BELOW_BASIC = '未達初階';

/**
 * @param {object} rules level-rules.json 的內容
 */
export function createLevels(rules) {
  const cefrOrder = rules.cefr.order;

  /** 分數 → 等級帶（初階／中階／進階）；未達 60 回傳 null。 */
  function band(score) {
    if (score >= 100) return rules.bands.at(-1);
    return rules.bands.find(b => score >= b.min && score < b.max) ?? null;
  }

  const bandLabel = score => band(score)?.label ?? BELOW_BASIC;

  /** 英文檢定成績 → CEFR 等級；無法換算回傳 null。 */
  function cefrFromExam(exam) {
    if (!exam) return null;
    if (exam.kind === 'toeic' && Number.isFinite(exam.score)) {
      const hit = rules.cefr.toeic.find(([min]) => exam.score >= min);
      return hit ? hit[1] : null;
    }
    if (exam.kind === 'gept') return rules.cefr.gept[exam.level] ?? null;
    return null;
  }

  const cefrScore = label => rules.cefr.score[label] ?? 0;

  /** 門檻（分數或 CEFR 等級）→ 可比較的分數。 */
  const minToScore = min => (typeof min === 'string' ? cefrScore(min) : min);
  const minLabel = min => (typeof min === 'string' ? `CEFR ${min}` : `${bandLabel(min)}（${min}）`);

  /**
   * 修課證據分數 = 成績 × 關聯係數；關聯係數由課綱涵蓋度與實作比重決定。
   * 課綱查無、僅由課名推估時，關聯係數固定且分數有上限。
   */
  function courseEvidence({grade, coverage, practiceShare, inferred}) {
    const c = rules.course;
    if (grade < c.passScore) return {score: 0, relevance: 0};
    if (inferred) {
      return {score: Math.min(Math.round(grade * c.inferredRelevance), rules.inferredCap), relevance: c.inferredRelevance};
    }
    const relevance = clamp(c.relevanceFloor + c.coverageWeight * coverage + c.practiceWeight * practiceShare, 0, 1);
    return {score: Math.round(grade * relevance), relevance: Math.round(relevance * 1000) / 1000};
  }

  /** 證照／作品／競賽等非修課證據的固定分數。 */
  function fixedEvidence(type, verified) {
    const row = rules.evidenceScore[type];
    if (!row) throw new Error(`未定義的證據類型：${type}`);
    return verified ? row.verified : row.self_reported;
  }

  /** 套用狀態上限後的有效分數。 */
  function effectiveScore(ev) {
    if (ev.status === 'self_reported') return Math.min(ev.score, rules.selfReportedCap);
    if (ev.status === 'inferred') return Math.min(ev.score, rules.inferredCap);
    return ev.score;
  }

  /**
   * 彙整同一技能的所有證據（不疊加）：
   * 先看可信度（已驗證 > 推估 > 自述），只採計可信度最高的那一類，再從中取有效分數最高的一筆。
   * 這樣自述證據永遠不會蓋掉已驗證的證據，也不會把已達標的技能變成「待驗證」。
   * @param {Array<{id:number, score:number, status:string, level_label?:string}>} evidences
   */
  function aggregate(evidences) {
    const usable = evidences.filter(ev => ev.score > 0);
    if (!usable.length) return null;
    const tier = TRUST_ORDER.find(status => usable.some(ev => ev.status === status));
    const best = usable
      .filter(ev => ev.status === tier)
      .map(ev => ({ev, eff: effectiveScore(ev)}))
      .sort((a, b) => b.eff - a.eff || a.ev.id - b.ev.id)[0];
    return {score: best.eff, status: tier, basisEvidenceId: best.ev.id, basis: best.ev, evidenceCount: evidences.length};
  }

  /**
   * 他人可見的分數：只由公開的等級帶決定（取該帶的中間值；英文由 CEFR 等級決定）。
   * 媒合計分一律用這個值，不用精確分數，避免有人從媒合分數反推別人的技能分數與成績。
   */
  function publicScore(skill, score) {
    if (skill?.scale === 'cefr') return score;
    const b = band(score);
    return b ? (b.min + b.max) / 2 : BELOW_BASIC_PUBLIC_SCORE;
  }

  /** 由下位技能推估上位技能（僅在上位技能沒有直接證據時使用，並視為推估）。 */
  const rollupScore = childScore => Math.min(Math.round(childScore * rules.rollupFactor), rules.inferredCap);

  /** 等級顯示文字：英文用 CEFR，其餘用初階／中階／進階。 */
  function label(skill, score, cefrLabel = null) {
    if (skill?.scale === 'cefr') return cefrLabel ? `CEFR ${cefrLabel}` : '待檢定';
    return bandLabel(score);
  }

  return Object.freeze({
    band, bandLabel, cefrFromExam, cefrScore, cefrOrder, minToScore, minLabel,
    courseEvidence, fixedEvidence, effectiveScore, aggregate, publicScore, rollupScore, label,
  });
}
