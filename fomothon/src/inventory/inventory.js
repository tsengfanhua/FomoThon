// 能力盤點模組（獨立於三個媒合 Agent）：
// 修課紀錄 → 爬課綱 → 萃取 1～5 個技能 → 產生證據 → 依統一規則彙整成 Skill Profile。
// 三個媒合 Agent 只讀取這裡產生的 Profile，不各自解讀成績。
import {transaction} from '../db.js';
import {assessSyllabus} from '../dq/syllabus.js';
import {AppError, nowIso, randomToken} from '../util.js';
import {extractSkills, extractWithLlm, inferFromName, mergeExtractions, practiceShare} from './extractor.js';

const AGENT = 'inventory';
const SELF_EVIDENCE_TYPES = ['certificate', 'portfolio', 'competition'];
/**
 * 修課證據的狀態：修課紀錄未經驗證 → 自述；有課綱、課綱品質合格且由規則比對確認 → 已驗證；
 * 課綱查無（課名推估）、課綱品質不合格（結構不完整或含可疑內容），或只有 LLM 語意判斷 → 推估（等級有上限）。
 */
const courseStatus = (enrollmentVerified, detail) => {
  if (!enrollmentVerified) return 'self_reported';
  // 沒有課綱品質評估的舊證據（舊版資料庫）也不能算已驗證；啟動時的資料遷移會重新盤點補上評估
  const trusted = detail.mode === 'syllabus' && detail.extractor !== 'llm' && detail.quality?.ok === true;
  return trusted ? 'verified' : 'inferred';
};

const CEFR_NOTE = '英文採 CEFR，需以檢定成績認定；修課紀錄保留為證據但不推估等級';

export function createInventory({db, skills, levels, rules, tools, llm}) {
  tools.register({
    name: 'skills.extract',
    agent: AGENT,
    permission: 'read',
    summarize: r => `${r.items.length} 個技能（${r.mode}）`,
    handler: async ({syllabus, courseName}, ctx) => {
      if (!syllabus) return {items: inferFromName(courseName, skills, rules), mode: 'name'};
      const ruleItems = extractSkills(syllabus, skills, rules);
      if (!llm.enabled || ctx.noLlm) return {items: ruleItems, mode: 'rule'};
      const llmItems = await extractWithLlm(syllabus, skills, llm, rules, res => ctx.recordLlm?.(res));
      return {items: mergeExtractions(ruleItems, llmItems, rules), mode: llmItems.length ? 'rule+llm' : 'rule'};
    },
  });

  const insertEvidence = db.prepare(`INSERT INTO evidence
    (owner_id, skill_id, type, title, source_ref, status, score, level_label, detail, group_key, created_at, verified_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function saveCourseSkills(code, items) {
    db.prepare('DELETE FROM course_skills WHERE course_code = ?').run(code);
    const ins = db.prepare('INSERT INTO course_skills (course_code, skill_id, coverage) VALUES (?, ?, ?)');
    for (const item of items) ins.run(code, item.skillId, item.coverage);
  }

  /** 單一修課紀錄 → 證據列。成績只在這裡使用，不會出現在回傳的摘要或執行紀錄中。 */
  async function assessEnrollment(ctx, en) {
    const label = en.course_name;
    if (en.grade < rules.course.passScore) {
      return {rows: [], summary: {code: en.course_code, name: label, mode: 'skipped', skills: [], note: '未取得學分，不列入證據'}};
    }
    let syllabus = null;
    let quality = null;
    if (en.course_code) {
      const fetched = await tools.call(ctx, 'syllabus.fetch', {code: en.course_code}, {retries: 2});
      if (fetched.ok) {
        syllabus = fetched.result;
        quality = assessSyllabus(syllabus);
        if (!quality.ok) {
          ctx.trace.emit('gate', `「${label}」課綱品質不合格（${quality.issues.map(i => i.message).join('、')}）→ 由這份課綱推得的技能降為「推估」`,
            {agent: AGENT, data: {course: en.course_code, issues: quality.issues.map(i => i.code)}});
        }
      } else {
        ctx.trace.emit('fallback', `「${label}」課綱取得失敗（${fetched.error.code}），改以課名推估並降級`, {agent: AGENT});
      }
    } else {
      ctx.trace.emit('fallback', `「${label}」不在課綱庫，改以課名推估並降級`, {agent: AGENT});
    }

    const extracted = await tools.call(ctx, 'skills.extract', syllabus ? {syllabus} : {courseName: label},
      {logArgs: {course: en.course_code ?? label, mode: syllabus ? 'syllabus' : 'name'}});
    const items = extracted.ok ? extracted.result.items : [];
    if (syllabus && extracted.ok) saveCourseSkills(en.course_code, items.filter(i => i.extractor !== 'llm'));

    const share = syllabus ? practiceShare(syllabus) : 0;
    const rows = items.map(item => {
      const isCefr = skills.get(item.skillId).scale === 'cefr';
      const scored = isCefr
        ? {score: 0, relevance: 0}
        : levels.courseEvidence({grade: en.grade, coverage: item.coverage, practiceShare: share, inferred: !syllabus});
      return {
        skillId: item.skillId, type: 'course', title: label, sourceRef: syllabus?.url ?? null, score: scored.score,
        detail: {
          enrollmentId: en.id, courseCode: en.course_code, semester: en.semester, mode: syllabus ? 'syllabus' : 'name',
          coverage: item.coverage, practiceShare: share, relevance: scored.relevance, extractor: item.extractor,
          quotes: item.quotes, hash: syllabus?.hash ?? null, quality: quality ? {ok: quality.ok, issues: quality.issues.map(i => i.code)} : null,
          ...(isCefr ? {note: CEFR_NOTE} : {}),
        },
      };
    });
    const summary = {
      code: en.course_code, name: label, mode: syllabus ? 'syllabus' : 'name', url: syllabus?.url ?? null, practiceShare: share,
      quality: quality ? {ok: quality.ok, issues: quality.issues.map(i => i.message)} : null,
      skills: items.map(i => ({skillId: i.skillId, name: skills.name(i.skillId), coverage: i.coverage, extractor: i.extractor, quotes: i.quotes})),
    };
    return {rows, summary};
  }

  function signatureOf(ownerId) {
    return db.prepare('SELECT skill_id, level, status FROM profile_skills WHERE owner_id = ? ORDER BY skill_id').all(ownerId)
      .map(r => `${r.skill_id}:${r.level}:${r.status}`).join('|');
  }

  /** 依統一規則把證據彙整成 Profile：同一技能取最高一筆、不疊加；上位技能可由下位技能推估。 */
  function rebuildProfile(ownerId) {
    const evidences = db.prepare('SELECT * FROM evidence WHERE owner_id = ?').all(ownerId);
    const grouped = Map.groupBy(evidences, ev => ev.skill_id);
    const computed = new Map();
    for (const [skillId, list] of grouped) {
      const agg = levels.aggregate(list);
      if (!agg) continue;
      computed.set(skillId, {
        skillId, score: agg.score, status: agg.status, basis: agg.basisEvidenceId, count: list.length, note: null,
        level: levels.label(skills.get(skillId), agg.score, agg.basis.level_label),
      });
    }
    // 階層推估：重複掃描直到沒有新增（階層最多三層）
    for (let pass = 0; pass < 3; pass += 1) {
      let added = false;
      for (const skill of skills.all()) {
        if (computed.has(skill.id)) continue;
        const kids = skills.children(skill.id).map(id => computed.get(id)).filter(k => k && k.status !== 'self_reported');
        if (!kids.length) continue;
        const best = kids.reduce((a, b) => (b.score > a.score ? b : a));
        const score = levels.rollupScore(best.score);
        computed.set(skill.id, {
          skillId: skill.id, score, status: 'inferred', basis: best.basis, count: 0,
          level: levels.label(skill, score), note: `由下位技能「${skills.name(best.skillId)}」推估`,
        });
        added = true;
      }
      if (!added) break;
    }

    const before = signatureOf(ownerId);
    const keptBefore = new Map(db.prepare('SELECT skill_id, kept FROM profile_skills WHERE owner_id = ?').all(ownerId).map(r => [r.skill_id, r.kept]));
    transaction(db, () => {
      db.prepare('DELETE FROM profile_skills WHERE owner_id = ?').run(ownerId);
      const ins = db.prepare(`INSERT INTO profile_skills (owner_id, skill_id, score, level, status, basis_evidence_id, evidence_count, kept, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of computed.values()) {
        ins.run(ownerId, p.skillId, p.score, p.level, p.status, p.basis, p.count, keptBefore.get(p.skillId) ?? 1, p.note);
      }
      const changed = signatureOf(ownerId) !== before;
      const existing = db.prepare('SELECT state FROM profiles WHERE owner_id = ?').get(ownerId);
      if (!existing) {
        db.prepare('INSERT INTO profiles (owner_id, state, updated_at) VALUES (?, ?, ?)').run(ownerId, 'draft', nowIso());
      } else if (changed) {
        db.prepare("UPDATE profiles SET state = 'draft', updated_at = ? WHERE owner_id = ?").run(nowIso(), ownerId);
      }
    });
    return getProfile(ownerId);
  }

  /** 能力盤點主流程（由協調器呼叫，也用於種子資料建置）。 */
  async function run(ctx, studentId) {
    const enrollments = db.prepare('SELECT * FROM enrollments WHERE student_id = ? ORDER BY id').all(studentId);
    const lastEnrollmentId = enrollments.reduce((max, en) => Math.max(max, en.id), 0);
    const outcomes = [];
    for (const en of enrollments) outcomes.push(await assessEnrollment(ctx, en));
    // 上面在等待課綱時，修課紀錄可能已被管理者查驗或被本人刪除；狀態以寫入當下的資料為準。
    transaction(db, () => {
      const verifiedNow = new Map(db.prepare('SELECT id, verified FROM enrollments WHERE student_id = ?').all(studentId).map(r => [r.id, r.verified]));
      db.prepare("DELETE FROM evidence WHERE owner_id = ? AND type = 'course'").run(studentId);
      for (const row of outcomes.flatMap(o => o.rows)) {
        if (!verifiedNow.has(row.detail.enrollmentId)) continue;
        const status = courseStatus(verifiedNow.get(row.detail.enrollmentId), row.detail);
        insertEvidence.run(studentId, row.skillId, row.type, row.title, row.sourceRef, status, row.score, null, JSON.stringify(row.detail), null, nowIso(), null);
      }
    });
    const profile = rebuildProfile(studentId);
    // 盤點期間若又新增了修課紀錄，維持「待重新盤點」
    const addedMeanwhile = Boolean(db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? AND id > ?').get(studentId, lastEnrollmentId));
    if (!addedMeanwhile) db.prepare('UPDATE profiles SET stale = 0 WHERE owner_id = ?').run(studentId);
    return {courses: outcomes.map(o => o.summary), profile: {...profile, stale: addedMeanwhile}};
  }

  /**
   * 讀取 Profile。本人檢視含分數與全部證據；他人檢視（媒合卡片）只有技能、等級與驗證狀態。
   */
  function getProfile(ownerId, view = 'owner') {
    const head = db.prepare('SELECT state, stale, confirmed_at FROM profiles WHERE owner_id = ?').get(ownerId);
    const rows = db.prepare('SELECT * FROM profile_skills WHERE owner_id = ? ORDER BY score DESC, skill_id').all(ownerId);
    if (view === 'public') {
      return {
        state: head?.state ?? 'none',
        skills: rows.filter(r => r.kept).map(r => ({skillId: r.skill_id, name: skills.name(r.skill_id), level: r.level, status: r.status})),
      };
    }
    const evidences = db.prepare('SELECT * FROM evidence WHERE owner_id = ? ORDER BY score DESC, id').all(ownerId);
    const evidenceBySkill = Map.groupBy(evidences, ev => ev.skill_id);
    const toView = ev => ({
      id: ev.id, type: ev.type, title: ev.title, status: ev.status, sourceRef: ev.source_ref, groupKey: ev.group_key,
      level: ev.level_label ? `CEFR ${ev.level_label}` : ev.score > 0 ? levels.bandLabel(levels.effectiveScore(ev)) : null,
      isBasis: false, detail: JSON.parse(ev.detail),
    });
    return {
      state: head?.state ?? 'none',
      stale: Boolean(head?.stale),
      confirmedAt: head?.confirmed_at ?? null,
      skills: rows.map(r => ({
        skillId: r.skill_id, name: skills.name(r.skill_id), category: skills.get(r.skill_id)?.category, scale: skills.get(r.skill_id)?.scale,
        score: r.score, level: r.level, status: r.status, kept: Boolean(r.kept), note: r.note, evidenceCount: r.evidence_count,
        evidence: (evidenceBySkill.get(r.skill_id) ?? []).map(ev => ({...toView(ev), isBasis: ev.id === r.basis_evidence_id})),
      })),
      // 有證據但不足以推估等級的技能（例如只有英文修課、尚無檢定成績）
      pending: [...evidenceBySkill.entries()]
        .filter(([skillId]) => !rows.some(r => r.skill_id === skillId))
        .map(([skillId, list]) => ({skillId, name: skills.name(skillId), evidence: list.map(toView)})),
    };
  }

  /** 學生確認 Profile（HITL）：可取消勾選不想納入媒合的技能；確認後才生效。 */
  function confirmProfile(ownerId, keptSkillIds = null) {
    transaction(db, () => {
      if (keptSkillIds) {
        const keep = new Set(keptSkillIds);
        const rows = db.prepare('SELECT skill_id FROM profile_skills WHERE owner_id = ?').all(ownerId);
        const upd = db.prepare('UPDATE profile_skills SET kept = ? WHERE owner_id = ? AND skill_id = ?');
        for (const r of rows) upd.run(keep.has(r.skill_id) ? 1 : 0, ownerId, r.skill_id);
      }
      db.prepare("UPDATE profiles SET state = 'confirmed', confirmed_at = ?, updated_at = ? WHERE owner_id = ?").run(nowIso(), nowIso(), ownerId);
    });
    return getProfile(ownerId);
  }

  /**
   * 新增證照／作品／競賽證據。學生自填一律為「自述」，經管理者驗證後才成為「已驗證」。
   * @param {{type:string, title:string, skillIds:string[], exam?:object}} input
   */
  function addEvidence(ownerId, input, {verified = false, verifiedBy = null} = {}) {
    if (!SELF_EVIDENCE_TYPES.includes(input.type)) throw new AppError('INVALID_INPUT', '證據類型不正確');
    const skillIds = [...new Set(input.skillIds)];
    if (skillIds.length < 1 || skillIds.length > 5) throw new AppError('INVALID_INPUT', '每筆證據需對應 1～5 個技能');
    for (const id of skillIds) if (!skills.has(id)) throw new AppError('INVALID_INPUT', `技能不在指標庫內：${id}`);
    const groupKey = randomToken(9);
    const status = verified ? 'verified' : 'self_reported';
    transaction(db, () => {
      for (const skillId of skillIds) {
        const cefr = skills.get(skillId).scale === 'cefr' ? levels.cefrFromExam(input.exam) : null;
        if (skills.get(skillId).scale === 'cefr' && !cefr) throw new AppError('INVALID_INPUT', '英文技能需提供可換算 CEFR 的檢定成績（多益分數或全民英檢級數）');
        const score = cefr ? levels.cefrScore(cefr) : levels.fixedEvidence(input.type, verified);
        const detail = {...(input.exam ? {exam: input.exam} : {})};
        insertEvidence.run(ownerId, skillId, input.type, input.title, null, status, score, cefr, JSON.stringify(detail), groupKey, nowIso(), verifiedBy);
      }
    });
    return rebuildProfile(ownerId);
  }

  /** 管理者驗證（或撤銷驗證）一筆證據；同一份自填資料對應的多個技能一併更新。 */
  function setEvidenceVerified(evidenceId, adminId, verified) {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId);
    if (!ev) throw new AppError('NOT_FOUND', '找不到這筆證據', 404);
    transaction(db, () => {
      if (ev.type === 'course') {
        const enrollmentId = JSON.parse(ev.detail).enrollmentId;
        db.prepare('UPDATE enrollments SET verified = ? WHERE id = ? AND student_id = ?').run(verified ? 1 : 0, enrollmentId, ev.owner_id);
        const siblings = db.prepare("SELECT id, detail FROM evidence WHERE owner_id = ? AND type = 'course'").all(ev.owner_id)
          .filter(row => JSON.parse(row.detail).enrollmentId === enrollmentId);
        const upd = db.prepare('UPDATE evidence SET status = ?, verified_by = ? WHERE id = ?');
        for (const row of siblings) {
          upd.run(courseStatus(verified, JSON.parse(row.detail)), verified ? adminId : null, row.id);
        }
      } else {
        const group = ev.group_key
          ? db.prepare('SELECT * FROM evidence WHERE owner_id = ? AND group_key = ?').all(ev.owner_id, ev.group_key)
          : [ev];
        const upd = db.prepare('UPDATE evidence SET status = ?, score = ?, verified_by = ? WHERE id = ?');
        for (const row of group) {
          const score = row.level_label ? levels.cefrScore(row.level_label) : levels.fixedEvidence(row.type, verified);
          upd.run(verified ? 'verified' : 'self_reported', score, verified ? adminId : null, row.id);
        }
      }
    });
    return {ownerId: ev.owner_id, profile: rebuildProfile(ev.owner_id)};
  }

  /** 學生自行新增修課紀錄：未經校務驗證前視為自述；下次盤點時才會爬課綱並產生證據。 */
  function addEnrollment(ownerId, {code = null, name = null, grade, semester = null}) {
    const course = code ? db.prepare('SELECT code, name FROM courses WHERE code = ?').get(code) : null;
    if (code && !course) throw new AppError('INVALID_INPUT', '課綱庫查無此課程代碼；可改填課名');
    const courseName = course?.name ?? name;
    if (!courseName) throw new AppError('INVALID_INPUT', '請提供課程代碼或課名');
    const dup = db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? AND course_name = ?').get(ownerId, courseName);
    if (dup) throw new AppError('DUPLICATE', '這門課已在修課紀錄中', 409);
    db.prepare('INSERT INTO enrollments (student_id, course_code, course_name, semester, grade, verified) VALUES (?, ?, ?, ?, ?, 0)')
      .run(ownerId, course?.code ?? null, courseName, semester, grade);
    const exists = db.prepare('SELECT 1 FROM profiles WHERE owner_id = ?').get(ownerId);
    if (exists) db.prepare('UPDATE profiles SET stale = 1 WHERE owner_id = ?').run(ownerId);
    else db.prepare("INSERT INTO profiles (owner_id, state, updated_at, stale) VALUES (?, 'draft', ?, 1)").run(ownerId, nowIso());
  }

  /** 刪除自己填寫、尚未驗證的修課紀錄（填錯時更正用）；已驗證的紀錄不能自行刪除。 */
  function removeEnrollment(ownerId, enrollmentId) {
    const row = db.prepare('SELECT id, verified FROM enrollments WHERE id = ? AND student_id = ?').get(enrollmentId, ownerId);
    if (!row) throw new AppError('NOT_FOUND', '找不到這筆修課紀錄', 404);
    if (row.verified) throw new AppError('FORBIDDEN', '已驗證的修課紀錄不能自行刪除', 403);
    transaction(db, () => {
      db.prepare('DELETE FROM enrollments WHERE id = ?').run(enrollmentId);
      const del = db.prepare('DELETE FROM evidence WHERE id = ?');
      for (const ev of db.prepare("SELECT id, detail FROM evidence WHERE owner_id = ? AND type = 'course'").all(ownerId)) {
        if (JSON.parse(ev.detail).enrollmentId === enrollmentId) del.run(ev.id);
      }
    });
    return rebuildProfile(ownerId);
  }

  /** 本人的修課紀錄清單（含成績，僅本人可讀）。 */
  const listEnrollments = ownerId => db.prepare('SELECT id, course_code AS code, course_name AS name, semester, grade, verified FROM enrollments WHERE student_id = ? ORDER BY id').all(ownerId)
    .map(r => ({...r, verified: Boolean(r.verified)}));

  return Object.freeze({run, rebuildProfile, getProfile, confirmProfile, addEvidence, setEvidenceVerified, addEnrollment, removeEnrollment, listEnrollments});
}
