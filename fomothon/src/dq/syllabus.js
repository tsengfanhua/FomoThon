// 單份課綱的品質評估（執行期使用）：盤點時每抓到一份課綱就評一次。
// 結構不完整或含可疑內容的課綱，推得的技能不能算「已驗證」，一律降為「推估」並寫進執行紀錄。
import {findSuspiciousContent} from '../safety/guard.js';

export const SYLLABUS_RULES = Object.freeze({minWeeks: 16, minObjectiveChars: 15, assessmentTotal: 100});

const ISSUE_PENALTY = 0.25;

/**
 * @param {{objectives?:string, weeks?:string[], assessments?:Array<{name:string, weight:number}>, suspicious?:string[]}} syllabus
 *   suspicious：課綱爬蟲在清理前（去除標籤之前）發現的可疑內容
 * @returns {{ok:boolean, score:number, issues:Array<{code:string, message:string}>}}
 */
export function assessSyllabus(syllabus) {
  const weeks = (syllabus.weeks ?? []).filter(w => String(w).trim()); // 清理後變成空白的週次不算
  const assessments = syllabus.assessments ?? [];
  const issues = [];
  if ([...(syllabus.objectives ?? '')].length < SYLLABUS_RULES.minObjectiveChars) {
    issues.push({code: 'objectives_short', message: '教學目標過短或缺漏'});
  }
  if (weeks.length < SYLLABUS_RULES.minWeeks) {
    issues.push({code: 'weeks_short', message: `每週進度只有 ${weeks.length} 週（標準至少 ${SYLLABUS_RULES.minWeeks} 週）`});
  }
  const total = assessments.reduce((acc, a) => acc + (Number(a.weight) || 0), 0);
  if (total !== SYLLABUS_RULES.assessmentTotal) {
    issues.push({code: 'assessment_total', message: `評量權重合計 ${total}%（應為 100%）`});
  }
  const text = [syllabus.objectives ?? '', ...weeks, ...assessments.map(a => a.name)].join('\n');
  if (syllabus.suspicious?.length || findSuspiciousContent(text).length) {
    issues.push({code: 'suspicious', message: '含疑似提示注入或程式碼片段'});
  }
  return {ok: issues.length === 0, score: Math.max(0, 1 - ISSUE_PENALTY * issues.length), issues};
}
