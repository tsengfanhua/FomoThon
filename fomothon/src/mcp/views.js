// MCP 對外輸出的資料形狀：只挑用戶端需要的欄位（資料最小化）。
// 原則：不輸出成績與精確技能分數；他人只看得到等級帶、驗證狀態與媒合理由；每個結論都附依據。

/**
 * @param {object} app createApp() 的結果
 */
export function createViews(app) {
  const {skills, config, db, clock, levels} = app;
  const ref = id => ({skillId: id, name: skills.name(id)});
  const escoOf = s => (s.ext.esco ? {uri: s.ext.esco.uri, label: s.ext.esco.label, match: s.ext.esco.match} : null);

  const skillSummary = s => ({skillId: s.id, name: s.zh, nameEn: s.en, category: s.category, parentId: s.parentId ?? null, esco: escoOf(s)});

  function levelScale(s) {
    if (s.scale === 'cefr') return config.rules.cefr.order.map(label => ({label, min: null, max: null}));
    return config.rules.bands.map(b => ({label: b.label, min: b.min, max: b.max}));
  }

  /** 技能詳細資料：外部標準對應、階層與關聯、哪些課在教、哪些競賽需要。 */
  function skillDetail(id) {
    const s = skills.get(id);
    if (!s) return null;
    const taughtBy = db.prepare(`SELECT cs.course_code AS code, c.name, cs.coverage FROM course_skills cs
      JOIN courses c ON c.code = cs.course_code WHERE cs.skill_id = ? ORDER BY cs.coverage DESC, cs.course_code`).all(id);
    const requiredBy = app.competition.list().flatMap(c => c.needs.filter(n => n.skill === id)
      .map(n => ({competitionId: c.id, name: c.name, required: levels.minLabel(n.min), weight: n.weight})));
    return {
      ...skillSummary(s),
      scale: s.scale,
      parent: s.parentId ? ref(s.parentId) : null,
      children: skills.children(id).map(ref),
      related: skills.related(id).map(r => ({...ref(r.id), weight: r.weight, via: r.via})),
      mappings: {esco: escoOf(s), onetUnspsc: s.ext.onetUnspsc ?? null, sfia: s.ext.sfia ?? null, ucan: s.ext.ucan ?? null},
      levels: levelScale(s),
      taughtBy: taughtBy.map(r => ({courseCode: r.code, name: r.name, coverage: r.coverage})),
      requiredBy,
    };
  }

  /** 本人的能力檔案：等級帶、驗證狀態與證據出處；不含成績與分數。 */
  function profileView(user) {
    const p = app.inventory.getProfile(user.id, 'owner');
    return {
      student: {studentId: user.id, name: user.name, dept: user.dept, year: user.year ?? null},
      state: p.state,
      stale: p.stale,
      confirmedAt: p.confirmedAt,
      skills: p.skills.map(s => ({
        skillId: s.skillId, name: s.name, level: s.level, status: s.status, kept: s.kept, note: s.note,
        evidence: s.evidence.map(ev => ({
          type: ev.type, title: ev.title, status: ev.status, level: ev.level, isBasis: ev.isBasis, courseCode: ev.detail?.courseCode ?? null,
        })),
      })),
      pending: p.pending.map(x => ({skillId: x.skillId, name: x.name, evidenceCount: x.evidence.length})),
    };
  }

  function competitionItem(c) {
    const daysLeft = clock.daysUntil(c.deadline);
    return {
      competitionId: c.id, name: c.name, type: c.type, deadline: c.deadline, daysLeft, open: daysLeft >= 0, description: c.description,
      depts: c.eligibility.depts, teamMin: c.eligibility.teamMin, teamMax: c.eligibility.teamMax, advisorRequired: c.eligibility.advisorRequired,
      needs: c.needs.map(n => ({...ref(n.skill), required: levels.minLabel(n.min), weight: n.weight})),
    };
  }

  /** 競賽分析：資格逐項、適配度分項、需求逐項比對（只用等級帶）、優點／弱項／缺口。 */
  function analysisView(a) {
    return {
      competitionId: a.competition.id, name: a.competition.name, type: a.competition.type, deadline: a.competition.deadline,
      eligible: a.eligibility.eligible,
      eligibilityChecks: a.eligibility.checks.map(c => ({label: c.label, ok: c.ok})),
      notes: a.eligibility.notes,
      fit: {total: a.fit.total, partial: a.fit.partial, parts: a.fit.parts},
      needs: a.rows.map(r => ({skillId: r.skillId, name: r.name, weight: r.weight, required: r.minLabel, current: r.haveLabel, status: r.status})),
      strengths: a.strengths,
      weaknesses: a.weaknesses,
      gaps: a.gaps.map(g => ({skillId: g.skillId, name: g.name, kind: g.kind})),
      reasons: a.reasons,
    };
  }

  const stopView = stop => (stop ? {reason: stop.reason, message: stop.message} : null);

  /** 隊友媒合：搜尋輪次（品質閘門）與候選人；候選人只有等級帶與理由，沒有分數明細。 */
  function teammateView(r) {
    return {
      skillId: r.skillId, skillName: r.skillName, status: r.status, validCount: r.validCount,
      rounds: r.rounds.map(x => ({round: x.n, mode: x.mode, label: x.label, found: x.found, duplicates: x.duplicates, validSoFar: x.validSoFar})),
      stop: stopView(r.stop),
      candidates: r.candidates.map(c => ({
        studentId: c.id, name: c.name, dept: c.dept, year: c.year ?? null, bio: c.bio ?? null, level: c.level ?? null,
        flags: Object.keys(c.flags ?? {}).filter(k => c.flags[k]), matchScore: c.total, valid: c.valid, round: c.round,
        reasons: c.reasons, covers: c.covers.map(ref),
      })),
    };
  }

  function advisorView(r) {
    return {
      status: r.status, validCount: r.validCount ?? 0, targets: r.targetNames ?? [], stop: stopView(r.stop),
      candidates: r.candidates.map(c => ({
        teacherId: c.id, name: c.name, dept: c.dept, expertise: c.expertise, matchScore: c.total, valid: c.valid,
        reasons: c.reasons, toConfirm: c.toConfirm, quota: {used: c.quota.used, total: c.quota.total},
      })),
    };
  }

  /** 資料品質報告：可能提到個別學生或教師的規則（personal），非管理者只看得到數量、看不到樣本。 */
  function dataQualityReport(report, user) {
    const showPersonal = user?.role === 'admin';
    return {...report, checks: report.checks.map(c => (c.personal && !showPersonal ? {...c, samples: [], samplesHidden: true} : {...c, samplesHidden: false}))};
  }

  function dataQualityView(raw, user) {
    const report = dataQualityReport(raw, user);
    return {
      version: report.version, today: report.today, overall: report.overall, gate: report.gate, blocking: report.blocking,
      dimensions: report.dimensions.map(d => ({key: d.key, label: d.label, score: d.score, checks: d.checks, failedChecks: d.failedChecks})),
      issues: report.checks.filter(c => c.failed).map(c => ({
        id: c.id, dimension: c.dimension, severity: c.severity, title: c.title, failed: c.failed, checked: c.checked,
        samples: c.samples, samplesHidden: c.samplesHidden,
      })),
      standardMapping: report.insights.standardMapping,
    };
  }

  return Object.freeze({ref, skillSummary, skillDetail, profileView, competitionItem, analysisView, teammateView, advisorView, dataQualityReport, dataQualityView});
}
