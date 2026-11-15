// 能力盤點（真實資料）：學生的修課 → 課程 Agent 分析出的課程技能（ESCO）→ 能力檔案。
// 與合成資料版的差別：
//   - 不讀成績、不推估等級：技能只有「課綱有教的文字證據」，不分初階／中階／進階。
//   - 能力檔案跟著任務走（存在任務狀態裡），不寫入平台的資料表；確認與取消勾選只影響這次任務。
//   - 修課來源有兩種：使用者從「參賽配對」帶過來的清單，或系統替示意學生配好的真實課程清單。
import fs from 'node:fs';
import {safeJsonParse} from '../util.js';

const AGENT = 'inventory';
const FINISHED = new Set(['mapped', 'unmapped', 'incomplete']);

/**
 * @param {{hub:object, tools:object, personasFile:string}} deps hub：技能中樞（studentSkills）；personasFile：示意學生的修課清單
 */
export function createCampusInventory({hub, tools, personasFile}) {
  // 示意學生的修課清單：檔案沒變就沿用上次讀到的內容
  let cache = {stamp: null, students: {}};
  function assigned() {
    const stat = fs.statSync(personasFile, {throwIfNoEntry: false});
    const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
    if (cache.stamp !== stamp) {
      const students = stat ? safeJsonParse(fs.readFileSync(personasFile, 'utf8'), {})?.students : null;
      cache = {stamp, students: students && typeof students === 'object' ? students : {}};
    }
    return cache.students;
  }
  const isEnrollment = e => e && Number.isInteger(e.academic_year) && Number.isInteger(e.semester) && typeof e.course_code === 'string' && typeof e.course_name === 'string';
  /** 系統替這位學生配好的修課清單；沒有就回空陣列。 */
  const enrollmentsFor = studentId => (Array.isArray(assigned()[studentId]) ? assigned()[studentId].filter(isEnrollment) : []);

  tools.register({
    name: 'campus.courses.skills', agent: AGENT, permission: 'read',
    summarize: r => `${r.courses.length} 門修課對應到 ${r.skills.length} 項 ESCO 技能${r.pending ? `（${r.pending} 門尚未分析）` : ''}`,
    handler: async ({enrollments}) => hub.studentSkills(enrollments),
  });

  /** 逐門課的解析結果（給畫面的「逐門課」區塊）：每門課對應到哪些技能、課綱哪一句。 */
  function courseViews(result) {
    const byCourse = new Map();
    for (const skill of result.skills) {
      for (const src of skill.sources) {
        const key = `${src.courseCode}|${src.courseName}`;
        byCourse.set(key, [...(byCourse.get(key) ?? []), {name: skill.label, quotes: [{where: src.sourceSection, text: src.evidence}]}]);
      }
    }
    return result.courses.map(c => ({
      name: c.courseName, code: c.courseCode, mode: 'esco', status: c.status, analysis: c.analysis,
      skills: byCourse.get(`${c.courseCode}|${c.courseName}`) ?? [],
    }));
  }

  /** 把技能中樞的結果整理成與合成資料版相同形狀的能力檔案。campusState：任務狀態中的 campus 欄位。 */
  function toProfile(result, campusState) {
    const kept = campusState.kept ? new Set(campusState.kept) : null; // null：還沒確認，全部納入
    return {
      state: campusState.confirmed ? 'confirmed' : 'draft', stale: false, pending: [],
      skills: result.skills.map(s => ({
        skillId: s.uri, name: s.label, en: s.en, level: null, status: 'syllabus', kept: !kept || kept.has(s.uri), note: null,
        evidenceCount: s.sources.length,
        evidence: s.sources.map((src, index) => ({type: 'course', status: 'syllabus', isBasis: index === 0, title: `${src.courseName}：「${src.evidence}」`})),
      })),
    };
  }

  function getProfile(campusState) {
    return toProfile(hub.studentSkills(campusState.enrollments), campusState);
  }

  /** 執行盤點：查出每門課的技能並彙整。課程還沒分析或查不到時照實標示，不替它補技能。 */
  async function run(ctx, campusState) {
    const res = await tools.call(ctx, 'campus.courses.skills', {enrollments: campusState.enrollments}, {logArgs: {courses: campusState.enrollments.length}});
    if (!res.ok) return {ok: false, error: res.error};
    const notReady = res.result.courses.filter(c => c.status !== 'matched' || !FINISHED.has(c.analysis));
    if (notReady.length) {
      ctx.trace.emit('fallback', `${notReady.length} 門課沒有可用的技能資料（課程庫查不到或尚未分析），這些課不列入盤點`, {agent: AGENT, data: {courses: notReady.length}});
    }
    return {ok: true, courses: courseViews(res.result), profile: toProfile(res.result, campusState)};
  }

  return Object.freeze({enrollmentsFor, getProfile, run, version: () => { assigned(); return cache.stamp; }});
}
