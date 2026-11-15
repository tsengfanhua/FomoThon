// 任務辨識與 Agent 協調器：判斷需求 → 規劃 → 逐步執行 → 依結果調整 → 人工確認。
// 每次 step() 只執行一個動作，狀態存進資料庫，因此任務可暫停（等待使用者）、續跑與重播。
import {audit, getUser, listPersonNames, transaction} from '../db.js';
import {checkGoal, checkRecommendations} from '../safety/guard.js';
import {createTrace, listEvents, runMetrics} from '../trace.js';
import {AppError, newRunId, nowIso, randomToken} from '../util.js';
import {INTENT_LABELS, parseIntent} from './intent.js';
import {MAX_STEPS, allowedActions, initialState, planView, runStatus} from './policy.js';
import {ToolError} from './tools.js';

const AGENT = 'orchestrator';
const FAULT_MODES = ['flaky', 'down', 'notfound'];
const MAX_REQUESTED_SKILLS = 5; // 找隊友一次最多處理幾項技能，其餘請分次查詢
// 一場比賽最多替幾個缺口找隊友。真實比賽的需求技能可能有十幾項，每個缺口都是一步，全部都找會超過步數上限
const MAX_GAP_SEARCHES = 5;
const OFF_TOPIC_NOTE = '沒有找到與目標直接相關的比賽，以下是依你的能力與截止日挑選的。';
const HELP_TEXT = '我可以協助：盤點能力、推薦競賽、找互補隊友、找指導老師。例如「我想參加 AI 黑客松，但不確定自己夠不夠格」或「我想找 Java 相關競賽」。';

/** 一句話描述一次模型呼叫（含模型鏈的升級過程），寫在執行紀錄裡。 */
function describeLlmCall(res) {
  const steps = (res.attempts ?? []).map(a => `${a.model}${a.ok ? ' 通過' : `（${a.error === 'VALIDATION_FAILED' ? '未通過檢核' : a.error}）`}`);
  const chain = steps.length > 1 ? `：${steps.join(' → ')}` : steps.length ? `（${res.attempts[0].model}）` : '';
  return `LLM（${res.purpose}）${res.ok ? '完成' : `失敗：${res.error}`}${chain}`;
}

/**
 * 每個任務的資料來源（建立任務時決定，之後不變）：
 *   demo   全部用平台的合成示意資料
 *   hybrid 競賽與教師改查真實資料（技能中樞）；能力盤點與隊友仍用合成資料
 *   campus 四個角色都用真實資料：能力盤點與隊友的技能改由真實課程的課綱推得（學生仍是平台上的示意帳號）
 * 來源是 campus 的角色，技能 ID 是 ESCO URI；是 demo 的角色，技能 ID 是平台自建的 SK-… 編號。
 */
const SOURCES = Object.freeze({
  demo: Object.freeze({inventory: 'demo', competition: 'demo', teammate: 'demo', teacher: 'demo'}),
  hybrid: Object.freeze({inventory: 'demo', competition: 'campus', teammate: 'demo', teacher: 'campus'}),
  campus: Object.freeze({inventory: 'campus', competition: 'campus', teammate: 'campus', teacher: 'campus'}),
});
const SOURCE_LABELS = Object.freeze({demo: '合成示意資料', hybrid: '真實比賽與教師（能力盤點與隊友為示意資料）', campus: '全部真實資料（真實課程、比賽與教師）'});
const NEEDS_ENROLLMENTS = new Set(['prepare_competition', 'find_competition', 'inventory']);

export function createOrchestrator({db, config, clock, skills, tools, llm, inventory, competition, teammate, teacher, brain, campus = null}) {
  const busy = new Set();

  // ---------- 資料來源 ----------
  const isCampus = (state, role) => (SOURCES[state.source] ?? SOURCES.demo)[role] === 'campus';
  /**
   * 這個任務的技能 ID 是不是 ESCO。競賽查真實資料時是；但只找隊友、而隊友是合成資料時全程用平台技能，
   * 不經 ESCO 來回換算（多項平台技能可能對到同一項 ESCO 技能，換回來會變成另一項技能）。
   */
  const usesEsco = state => isCampus(state, 'competition') && !(state.intent?.type === 'find_teammate' && !isCampus(state, 'teammate'));
  const skillsOf = state => (usesEsco(state) ? campus.skills : skills);
  /** 技能的顯示名稱：平台技能與 ESCO 技能都認得（邀請可能來自任何一種資料來源的任務）。 */
  const skillLabel = id => (skills.has(id) || !campus?.available('hybrid') ? skills.name(id) : campus.skills.name(id));
  const competitionOf = state => (isCampus(state, 'competition') ? campus.competition : competition);
  const availableSources = () => Object.keys(SOURCES).filter(key => key === 'demo' || campus?.available(key));
  /** 能力檔案：合成資料版存在平台資料表；真實資料版跟著任務走（state.campus）。 */
  const profileOf = (state, view = 'owner') => (isCampus(state, 'inventory') ? campus.inventory.getProfile(state.campus) : inventory.getProfile(state.studentId, view));
  const defaultSource = () => (availableSources().includes(config.assistantSource) ? config.assistantSource : 'demo');

  /** 使用者指定的來源不可用時明確拒絕；沒指定就用設定的預設值（不可用時退回合成資料）。 */
  function resolveSource(requested) {
    if (!requested) return defaultSource();
    if (!availableSources().includes(requested)) throw new AppError('SOURCE_UNAVAILABLE', '真實資料尚未建立，目前只能使用合成示意資料', 409);
    return requested;
  }

  /** 學生的技能換成 ESCO（競賽改查真實資料時用）：平台技能經人工對應的 ESCO 技能，沒有對應的略過。 */
  function ownedEscoSkills(state) {
    if (isCampus(state, 'inventory')) {
      return new Map(profileOf(state).skills.filter(s => s.kept).map(s => [s.skillId, {level: null, status: 'syllabus', label: s.name}]));
    }
    // 多項平台技能對到同一項 ESCO 技能時保留證據最強的那一項：有證據的優先於自述，再看分數（Map 以後寫的為準，所以由弱到強排）
    const rows = db.prepare("SELECT * FROM profile_skills WHERE owner_id = ? AND kept = 1 ORDER BY (status = 'self_reported') DESC, score ASC, skill_id DESC").all(state.studentId);
    return new Map(rows.map(r => [campus.skills.toEsco(r.skill_id), {level: r.level, status: r.status, label: skills.name(r.skill_id)}]).filter(([uri]) => uri));
  }

  /**
   * 競賽是真實資料、隊友是合成資料時，替每項 ESCO 技能找一項可以拿去搜尋同學的平台技能（uri → 平台技能 ID）。
   * 先配完全對應的；其餘用有 ESCO 關聯的平台技能，而且同一項平台技能只配給一項 ESCO 技能，避免重複搜尋同一批人。
   */
  function peerSkillsFor(uris) {
    const exact = uris.map(uri => [uri, campus.skills.toSk(uri)]).filter(([, id]) => id);
    return uris.filter(uri => !campus.skills.toSk(uri)).reduce((assigned, uri) => {
      const near = campus.skills.toSkNear(uri, new Set(assigned.values()));
      return near ? new Map([...assigned, [uri, near]]) : assigned;
    }, new Map(exact));
  }

  /** 各缺口有幾位可媒合的同學：同學資料是合成的，先把 ESCO 缺口換回平台技能再查；換不回來的算 0。 */
  const peerCoverageOf = state => async (ctx, uris) => {
    if (isCampus(state, 'teammate')) return campus.teammate.coverage(uris, state.studentId);
    const mapped = [...peerSkillsFor(uris)];
    if (!mapped.length) return {};
    const res = await tools.call(ctx, 'peers.coverage', {skillIds: mapped.map(([, id]) => id), excludeId: state.studentId});
    return res.ok ? Object.fromEntries(mapped.map(([uri, id]) => [uri, res.result[id] ?? 0])) : {};
  };
  const analysisArgs = state => (isCampus(state, 'competition') ? {owned: ownedEscoSkills(state), peerCoverage: peerCoverageOf(state)} : {});

  /**
   * 能力缺口。競賽是真實資料、隊友是合成資料時，缺口（ESCO）要換回平台技能才能在同學資料裡搜尋；
   * 換不回來的缺口標為 unsupported：不安排找隊友，彙整時列為尚未補齊。
   */
  function toGaps(state, found) {
    if (!usesEsco(state) || isCampus(state, 'teammate')) return found.map(({skillId, name, kind}) => ({skillId, name, kind, status: 'open'}));
    const peerSkills = peerSkillsFor(found.map(g => g.skillId));
    return found.map(({skillId, name, kind}) => {
      const peerSkillId = peerSkills.get(skillId) ?? null;
      return {skillId, name, kind, peerSkillId, status: peerSkillId ? 'open' : 'unsupported'};
    });
  }

  tools.register({
    name: 'invitation.send', agent: AGENT, permission: 'write',
    summarize: r => `邀請 ${r.id} 已建立（示意寄送，等待對方回覆）`,
    handler: async ({runId, fromId, toId, kind, competitionId, skillId}) => {
      const check = checkRecommendations(db, fromId, [{kind, id: toId}]);
      if (!check.kept.length) throw new ToolError('CONDITION_CHANGED', `無法邀請：${check.removed[0].reason}`);
      const dup = db.prepare("SELECT 1 FROM invitations WHERE from_id = ? AND to_id = ? AND kind = ? AND status IN ('sent', 'accepted') AND COALESCE(competition_id, '') = ?")
        .get(fromId, toId, kind, competitionId ?? '');
      if (dup) throw new ToolError('DUPLICATE', '已有尚未結束的相同邀請');
      const id = `INV-${randomToken(6)}`;
      db.prepare(`INSERT INTO invitations (id, run_id, from_id, to_id, kind, competition_id, skill_id, message, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`).run(id, runId, fromId, toId, kind, competitionId ?? null, skillId ?? null, null, nowIso());
      return {id};
    },
  });

  // ---------- 儲存 ----------
  function loadRun(runId) {
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!row) throw new AppError('NOT_FOUND', '找不到這個任務', 404);
    return {id: row.id, userId: row.user_id, goal: row.goal, status: row.status, createdAt: row.created_at, state: JSON.parse(row.state)};
  }

  function saveRun(runId, state) {
    db.prepare('UPDATE runs SET status = ?, state = ?, updated_at = ? WHERE id = ?').run(runStatus(state), JSON.stringify(state), nowIso(), runId);
  }

  function makeCtx(runId, state, extra = {}) {
    const trace = createTrace(db, runId);
    return {
      trace, faults: state.faults, runId, noRetry: config.fixedWorkflow, ...extra,
      recordLlm: res => trace.emit('llm_call', describeLlmCall(res),
        {agent: AGENT, ms: res.ms, data: {
          purpose: res.purpose, ok: res.ok, error: res.error ?? null, usage: res.usage, costUsd: res.costUsd, model: res.model ?? llm.model,
          escalated: Boolean(res.escalated),
          attempts: (res.attempts ?? []).map(a => ({model: a.model, location: a.location, ok: a.ok, error: a.error, reason: a.reason, redactions: a.redactions, ms: a.ms})),
        }}),
    };
  }

  const finish = (state, status, message) => ({...state, pending: null, outcome: {status, message}});

  function sanitizeFaults(input) {
    if (!config.demoFaults || !input || typeof input !== 'object') return {};
    const mode = val => (FAULT_MODES.includes(val) ? val : null);
    const syllabus = {};
    for (const [code, val] of Object.entries(input.syllabus ?? {}).slice(0, 10)) {
      if (/^[A-Z]{2}\d{3}$/.test(code) && mode(val)) syllabus[code] = val;
    }
    return {
      ...(Object.keys(syllabus).length ? {syllabus} : {}),
      ...(mode(input.history) ? {history: input.history} : {}),
      ...(mode(input.peers) ? {peers: input.peers} : {}),
      ...(mode(input.teachers) ? {teachers: input.teachers} : {}),
    };
  }

  // ---------- 建立任務 ----------
  /**
   * @param {{id:string, role:string}} user
   * @param {string} rawGoal
   * @param {{faults?:object}} [options]
   */
  async function createRun(user, rawGoal, options = {}) {
    if (user.role !== 'student') throw new AppError('FORBIDDEN', '只有學生可以啟動參賽助理', 403);
    const source = resolveSource(options.source);
    const runId = newRunId(clock);
    const guard = checkGoal(rawGoal);
    const goalText = guard.ok ? guard.goal : String(rawGoal ?? '').slice(0, 300);
    const faults = sanitizeFaults(options.faults);
    // 全部用真實資料時的修課來源：使用者帶來的清單優先，否則用系統替這位示意學生配好的真實課程
    const own = options.enrollments?.length ? options.enrollments : null;
    const campusState = SOURCES[source].inventory === 'campus'
      ? {enrollments: own ?? campus.inventory.enrollmentsFor(user.id), origin: own ? 'client' : 'assigned', kept: null, confirmed: false}
      : undefined;
    const withSource = state => ({...state, source, ...(campusState ? {campus: campusState} : {})});
    const base = withSource(initialState({goal: goalText, studentId: user.id, intent: {type: 'out_of_scope', skillIds: [], competitionId: null, source: 'rule'}, faults}));
    db.prepare('INSERT INTO runs (id, user_id, goal, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(runId, user.id, goalText, 'running', JSON.stringify(base), nowIso(), nowIso());
    const ctx = makeCtx(runId, base);
    ctx.trace.emit('goal_received', `收到目標，建立任務 ${runId}（資料來源：${SOURCE_LABELS[source]}）`, {agent: AGENT, data: {faults, source, brain: llm.enabled ? `llm:${llm.model}` : 'rule'}});

    if (!guard.ok) {
      ctx.trace.emit('guard_block', `輸入防護攔截（${guard.category}）：${guard.message}`, {agent: AGENT, data: {category: guard.category}});
      audit(db, user.id, 'guard_block', runId, {category: guard.category});
      saveRun(runId, finish(base, 'blocked', guard.message));
      return snapshot(runId);
    }

    // 任務辨識用的技能：能力盤點是合成資料時（demo、hybrid）用平台技能，使用者說的是哪一項就是哪一項；
    // 之後要查真實資料的任務才換成 ESCO（平台技能 → ESCO 是固定的對應，不會對錯）
    const parseSkills = isCampus(base, 'inventory') ? campus.skills : skills;
    const comps = competitionOf(base);
    const parsed = await parseIntent(guard.goal, {llm, skills: parseSkills, competitions: comps.list(), personNames: listPersonNames(db)}, ctx);
    const intent = parseSkills === skills && usesEsco({source, intent: parsed})
      ? {...parsed, skillIds: [...new Set(parsed.skillIds.map(campus.skills.toEsco).filter(Boolean))]}
      : parsed;
    let state = withSource(initialState({goal: guard.goal, studentId: user.id, intent, faults}));
    const sk = skillsOf(state);
    ctx.trace.emit('intent', `任務辨識：${INTENT_LABELS[intent.type]}${intent.skillIds.length ? `｜技能：${intent.skillIds.map(sk.name).join('、')}` : ''}${intent.competitionId ? `｜競賽：${comps.get(intent.competitionId).name}` : ''}`,
      {agent: AGENT, data: {type: intent.type, skillIds: intent.skillIds, competitionId: intent.competitionId, source: intent.source}});

    if (intent.type === 'out_of_scope') {
      state = finish(state, 'clarify', `我不確定你想做什麼。${HELP_TEXT}`);
    } else if (campusState && !campusState.enrollments.length && NEEDS_ENROLLMENTS.has(intent.type)) {
      state = finish(state, 'clarify', '還沒有你的修課資料。請先到「參賽配對」加入修課，再回來用「全部真實資料」；或改用其他資料來源。');
    } else if (intent.type === 'find_teammate') {
      if (!intent.skillIds.length) state = finish(state, 'clarify', '想找具備哪種技能的隊友？例如「幫我找會 UI 設計的隊友」。');
      else state = {...state, gaps: toGaps(state, intent.skillIds.slice(0, MAX_REQUESTED_SKILLS).map(id => ({skillId: id, name: sk.name(id), kind: 'requested'})))};
    }
    if (!state.outcome) {
      ctx.trace.emit('plan', `規劃步驟：${planView(state).map(p => p.label).join(' → ')}`, {agent: AGENT, data: {steps: planView(state).map(p => p.key)}});
    } else {
      ctx.trace.emit('stop', state.outcome.message, {agent: AGENT, data: {status: state.outcome.status}});
    }
    saveRun(runId, state);
    return snapshot(runId);
  }

  // ---------- 各動作的執行 ----------
  function applyGapGate(ctx, state, analysis) {
    if (!analysis.eligibility.eligible) {
      const failed = analysis.eligibility.checks.filter(c => !c.ok).map(c => c.label).join('、');
      ctx.trace.emit('gate', `資格閘門：「${analysis.competition.name}」不符合（${failed}）→ 補位無法解決，需改推薦其他競賽`, {agent: AGENT, data: {eligible: false, competitionId: analysis.competition.id}});
      if (config.fixedWorkflow) { // 消融基準：固定工作流沒有重新規劃，只能停止
        ctx.trace.emit('stop', '固定工作流：資格不符即停止，無法改推薦其他競賽', {agent: AGENT});
        return {...state, competition: {...state.competition, status: 'none', replacedFrom: {name: analysis.competition.name, reasons: failed.split('、')}}};
      }
      return {...state, competition: {...state.competition, needsSwitch: true}};
    }
    // 可搜尋的缺口超過上限時，後面的先擱置（deferred）：不安排找隊友，彙整時列為尚未補齊
    const found = toGaps(state, analysis.gaps);
    const searchNow = new Set(found.filter(g => g.status === 'open').slice(0, MAX_GAP_SEARCHES).map(g => g.skillId));
    const gaps = found.map(g => (g.status === 'open' && !searchNow.has(g.skillId) ? {...g, status: 'deferred'} : g));
    const searchable = gaps.filter(g => g.status === 'open');
    const deferred = gaps.filter(g => g.status === 'deferred').length;
    const unsupported = gaps.length - searchable.length - deferred;
    const hasAdvisor = Boolean(db.prepare("SELECT 1 FROM invitations WHERE from_id = ? AND kind = 'advisor' AND competition_id = ? AND status = 'accepted'").get(state.studentId, analysis.competition.id));
    // 教師改查真實資料時，一律列出專長相符的教師供學生自行聯絡（簡章多半沒寫是否需要指導老師）
    const advisorNeeded = isCampus(state, 'teacher') ? analysis.rows.length > 0 : analysis.competition.advisorRequired && !hasAdvisor;
    const advisorNote = !advisorNeeded ? '不需另找指導老師' : isCampus(state, 'teacher') ? '查詢專長相符的教師' : '需要指導老師';
    const next = [...searchable.map(g => `找隊友（${g.name}）`), ...(advisorNeeded ? ['找指導老師'] : [])];
    ctx.trace.emit('gate', `缺口閘門：資格符合；技能缺口 ${gaps.length} 項${gaps.length ? `（${gaps.map(g => g.name).join('、')}）` : ''}${unsupported ? `，其中 ${unsupported} 項在示意的同學資料裡沒有可單獨對應的技能、無法找隊友` : ''}${deferred ? `，缺口較多，先替前 ${MAX_GAP_SEARCHES} 項找隊友、其餘 ${deferred} 項擱置` : ''}；${advisorNote} → ${next.length ? next.join('、') : '缺口已補齊，直接彙整'}`,
      {agent: AGENT, data: {eligible: true, gaps: gaps.map(g => ({skillId: g.skillId, kind: g.kind, status: g.status})), advisorNeeded}});
    return {...state, gaps, advisor: {...state.advisor, needed: advisorNeeded}};
  }

  const executors = {
    async run_inventory(ctx, state) {
      if (isCampus(state, 'inventory')) {
        const result = await campus.inventory.run(ctx, state.campus);
        if (!result.ok) {
          ctx.trace.emit('stop', `課程技能資料無法查詢（${result.error.code}），不輸出未經查證的能力檔案`, {agent: 'inventory'});
          return finish(state, 'stopped', '課程技能資料暫時無法查詢，任務已中止。');
        }
        ctx.trace.emit('await_user', `能力檔案草稿完成（${result.profile.skills.length} 項技能，來自 ${result.courses.length} 門課的課綱），等待本人確認後才用於媒合`, {agent: AGENT, data: {type: 'confirm_profile'}});
        return {...state, inventory: {status: 'done', courses: result.courses}, pending: {type: 'confirm_profile', message: '這些技能來自課綱的文字證據，不是能力評分。取消勾選不想納入媒合的技能，確認後才會用來比對。'}};
      }
      const current = inventory.getProfile(state.studentId);
      if (current.state === 'confirmed' && !current.stale) {
        ctx.trace.emit('gate', '能力檔案已由本人確認且修課紀錄沒有異動，直接沿用', {agent: 'inventory', data: {reused: true, skills: current.skills.length}});
        return {...state, inventory: {status: 'reused', courses: []}};
      }
      const result = await inventory.run(ctx, state.studentId);
      const next = {...state, inventory: {status: 'done', courses: result.courses}};
      if (result.profile.state === 'confirmed') return next;
      ctx.trace.emit('await_user', `能力檔案草稿完成（${result.profile.skills.length} 項技能），等待本人確認後才生效`, {agent: AGENT, data: {type: 'confirm_profile'}});
      return {...next, pending: {type: 'confirm_profile', message: '請檢查推估結果，取消勾選不想納入媒合的技能，確認後能力檔案才會生效。'}};
    },

    async recommend_competitions(ctx, state) {
      const student = getUser(db, state.studentId);
      const res = await competitionOf(state).recommend(ctx, {student, skillIds: state.intent.skillIds, text: state.goal, ...analysisArgs(state)});
      if (res.error) {
        ctx.trace.emit('stop', `競賽資料無法查詢（${res.error.code}），不輸出未經查證的推薦`, {agent: 'competition'});
        return {...state, competition: {...state.competition, status: 'failed'}};
      }
      const offTopic = res.offTopic === true;
      if (offTopic) ctx.trace.emit('gate', '沒有比賽與目標提到的主題直接相關 → 改依能力適配度與截止日列出可參加的比賽，並在結果中說明', {agent: 'competition', data: {offTopic: true}});
      if (state.intent.type !== 'prepare_competition') {
        return {...state, competition: {...state.competition, status: 'done', analyses: res.analyses, ...(offTopic ? {offTopic} : {})}};
      }
      const target = res.analyses.find(a => a.eligibility.eligible);
      if (!target) {
        ctx.trace.emit('stop', '目前沒有資格符合的競賽可推薦', {agent: 'competition'});
        return {...state, competition: {...state.competition, status: 'none', analyses: res.analyses}};
      }
      ctx.trace.emit('gate', `目標未指定單一競賽 → 採用資格符合且適配度最高的「${target.competition.name}」（${target.fit.total} 分）`, {agent: AGENT, data: {competitionId: target.competition.id}});
      const next = {...state, competition: {...state.competition, status: 'done', targetId: target.competition.id, analysis: target, analyses: res.analyses, tried: [target.competition.id], ...(offTopic ? {offTopic} : {})}};
      return applyGapGate(ctx, next, target);
    },

    async analyze_competition(ctx, state) {
      const student = getUser(db, state.studentId);
      const comp = competitionOf(state).get(state.competition.targetId);
      const analysis = await competitionOf(state).analyze(ctx, {student, competition: comp, ...analysisArgs(state)});
      const next = {...state, competition: {...state.competition, status: 'done', analysis, tried: [comp.id]}};
      return applyGapGate(ctx, next, analysis);
    },

    async switch_competition(ctx, state) {
      const student = getUser(db, state.studentId);
      const original = state.competition.analysis;
      const res = await competitionOf(state).recommend(ctx, {student, skillIds: original.rows.map(r => r.skillId), text: state.goal, limit: 5, ...analysisArgs(state)});
      const alternative = (res.analyses ?? []).find(a => a.eligibility.eligible && !state.competition.tried.includes(a.competition.id));
      const replacedFrom = {name: original.competition.name, reasons: original.eligibility.checks.filter(c => !c.ok).map(c => c.label)};
      if (!alternative) {
        ctx.trace.emit('stop', `「${original.competition.name}」資格不符，且找不到資格符合的替代競賽`, {agent: AGENT});
        return {...state, competition: {...state.competition, status: 'none', needsSwitch: false, replacedFrom}};
      }
      ctx.trace.emit('replan', `重新規劃：「${original.competition.name}」資格不符 → 改推薦「${alternative.competition.name}」（適配度 ${alternative.fit.total} 分）`,
        {agent: AGENT, data: {from: original.competition.id, to: alternative.competition.id}});
      const next = {
        ...state,
        competition: {...state.competition, needsSwitch: false, targetId: alternative.competition.id, analysis: alternative, tried: [...state.competition.tried, alternative.competition.id], replacedFrom},
      };
      return applyGapGate(ctx, next, alternative);
    },

    async match_teammates(ctx, state, {skillId}) {
      const student = getUser(db, state.studentId);
      const excludeIds = Object.values(state.team).flatMap(t => t.candidates.filter(c => c.valid).map(c => c.id));
      // 缺口若是 ESCO 技能、同學資料是合成的，用換回來的平台技能去搜尋（peerSkillId）
      const peerId = id => state.gaps.find(g => g.skillId === id)?.peerSkillId ?? id;
      const result = await (isCampus(state, 'teammate') ? campus.teammate : teammate)
        .match(ctx, {student, skillId: peerId(skillId), excludeIds, gapSkillIds: state.gaps.map(g => peerId(g.skillId))});
      return {
        ...state,
        gaps: state.gaps.map(g => (g.skillId === skillId ? {...g, status: result.status} : g)),
        team: {...state.team, [skillId]: result},
      };
    },

    async match_teacher(ctx, state) {
      const student = getUser(db, state.studentId);
      const analysis = state.competition.analysis;
      const campusTeacher = isCampus(state, 'teacher');
      // 沒有指定技能時用自己最強的三項；教師是真實資料時要換成 ESCO 技能
      const ownTop = () => (isCampus(state, 'inventory')
        ? profileOf(state).skills.filter(sk => sk.kept).map(sk => sk.skillId)
        : inventory.getProfile(state.studentId, 'public').skills.map(sk => (campusTeacher ? campus.skills.toEsco(sk.skillId) : sk.skillId)).filter(Boolean)).slice(0, 3);
      const targetIds = analysis ? analysis.rows.map(r => r.skillId) : state.intent.skillIds.length ? state.intent.skillIds : ownTop();
      if (!targetIds.length) return finish(state, 'clarify', '想找哪個領域的指導老師？例如「想找機器學習方向的指導老師」，或先完成能力盤點。');
      const result = campusTeacher
        ? await campus.teacher.match(ctx, {targetIds})
        : await teacher.match(ctx, {student, targetIds, competition: analysis?.competition ?? null});
      return {...state, advisor: {needed: true, status: result.status === 'failed' ? 'failed' : 'done', result}};
    },

    async summarize(ctx, state) {
      const analysis = state.competition.analysis;
      const proposed = [
        ...Object.values(state.team).flatMap(t => t.candidates.filter(c => c.valid).map(c => ({kind: 'teammate', id: c.id, name: c.name, skillId: c.skillId, skillName: c.skillName, total: c.total}))),
        // 真實資料的教師不是平台帳號（invitable: false）：只列出供學生自行聯絡，不進邀請名單
        ...(state.advisor.result?.candidates ?? []).filter(c => c.valid && c.invitable !== false).map(c => ({kind: 'advisor', id: c.id, name: c.name, total: c.total})),
      ];
      const {kept, removed} = checkRecommendations(db, state.studentId, proposed);
      ctx.trace.emit('output_check', `輸出檢核：${proposed.length} 筆推薦，通過 ${kept.length} 筆、移除 ${removed.length} 筆`, {agent: AGENT, data: {proposed: proposed.length, kept: kept.length, removed}});

      const failures = [
        ...(state.competition.status === 'failed' ? ['競賽資料'] : []),
        ...Object.values(state.team).filter(t => t.status === 'failed').map(t => `隊友（${t.skillName}）`),
        ...(state.advisor.status === 'failed' ? ['指導老師'] : []),
      ];
      const teamGaps = state.gaps.filter(g => g.status !== 'matched').map(g => g.name);
      const facts = buildFacts(state, kept, teamGaps, failures);
      const template = buildTemplate(state, facts);
      const narrative = await brain.narrate(facts, template, knownNames(), ctx);
      const summary = {text: narrative.text, source: narrative.source, invitable: kept, teamGaps, failures, competitionId: analysis?.competition.id ?? null};
      const next = {...state, summary};

      const blocked = state.competition.status === 'failed' || (state.intent.type === 'prepare_competition' && state.competition.status === 'none');
      if (blocked) {
        ctx.trace.emit('stop', '核心步驟未完成，任務中止；未輸出任何未經查證的推薦', {agent: AGENT});
        return finish(next, 'stopped', narrative.text);
      }
      if (!kept.length) {
        ctx.trace.emit('done', '任務完成（沒有需要送出的邀請）', {agent: AGENT});
        return finish(next, 'completed', narrative.text);
      }
      ctx.trace.emit('await_user', `已彙整 ${kept.length} 位可邀請對象；Agent 不會自行送出邀請，等待使用者勾選並確認`, {agent: AGENT, data: {type: 'confirm_invites'}});
      return {...next, pending: {type: 'confirm_invites', message: '勾選想邀請的對象並確認；確認後邀請才會送出，對方同意後關係才成立。'}};
    },

    async send_invitations(ctx, state) {
      const writeCtx = {...ctx, approval: state.approval};
      const sent = [];
      const failed = [];
      for (const sel of state.approval.selected) {
        const res = await tools.call(writeCtx, 'invitation.send', {
          runId: ctx.runId, fromId: state.studentId, toId: sel.id, kind: sel.kind, competitionId: state.summary.competitionId, skillId: sel.skillId ?? null,
        });
        if (res.ok) {
          sent.push(res.result.id);
          ctx.trace.emit('invite_sent', `已送出${sel.kind === 'advisor' ? '指導' : '組隊'}邀請給 ${sel.name}（待對方回覆）`, {agent: AGENT, data: {invitationId: res.result.id, kind: sel.kind, toId: sel.id}});
          audit(db, state.studentId, 'invite_sent', res.result.id, {toId: sel.id, kind: sel.kind});
        } else {
          failed.push({name: sel.name, reason: res.error.message});
        }
      }
      const message = `已送出 ${sent.length} 份邀請，等待對方回覆。${failed.length ? `另有 ${failed.length} 份未送出：${failed.map(f => `${f.name}（${f.reason}）`).join('、')}。` : ''}`;
      ctx.trace.emit('done', `任務完成：${message}`, {agent: AGENT});
      return finish({...state, approval: {...state.approval, sent: true, invitationIds: sent}}, 'completed', message);
    },
  };

  function knownNames() {
    return [
      ...db.prepare("SELECT name FROM users WHERE role IN ('student', 'teacher')").all().map(r => r.name),
      ...competition.list().map(c => c.name),
      ...(campus?.available('hybrid') ? campus.competition.list().map(c => c.name) : []),
    ];
  }

  /** 真實資料的教師中達有效門檻的人數（不是平台帳號，只能自行聯絡）。 */
  const contactableAdvisors = state => (state.advisor.result?.candidates ?? []).filter(c => c.valid && c.invitable === false).length;

  function buildFacts(state, invitable, teamGaps, failures) {
    const a = state.competition.analysis;
    return {
      意圖: INTENT_LABELS[state.intent.type],
      競賽: a ? {名稱: a.competition.name, 資格符合: a.eligibility.eligible, 適配度: a.fit.total, 優點: a.strengths, 弱項: a.weaknesses, 能力缺口: a.gaps.map(g => g.name)} : null,
      原競賽不符: state.competition.replacedFrom,
      推薦競賽: state.intent.type === 'find_competition' ? state.competition.analyses.map(x => ({名稱: x.competition.name, 資格符合: x.eligibility.eligible, 適配度: x.fit.total, 能力缺口: x.gaps.map(g => g.name)})) : undefined,
      可邀請隊友: invitable.filter(i => i.kind === 'teammate').map(i => ({姓名: i.name, 補位技能: i.skillName, 媒合分數: i.total})),
      可邀請教師: invitable.filter(i => i.kind === 'advisor').map(i => ({姓名: i.name, 媒合分數: i.total})),
      可自行聯絡的教師人數: contactableAdvisors(state),
      尚未補齊的缺口: teamGaps,
      查詢失敗: failures,
    };
  }

  function buildTemplate(state, facts) {
    const type = state.intent.type;
    const lines = [];
    const a = state.competition.analysis;
    if (type === 'inventory') {
      const profile = profileOf(state, 'public');
      lines.push(`能力檔案已${profile.state === 'confirmed' ? '確認生效' : '建立'}，共 ${profile.skills.filter(sk => sk.kept !== false).length} 項技能，每項都附有證據與出處。`);
    }
    if (type === 'find_competition') {
      if (state.competition.status === 'failed') lines.push('競賽資料暫時無法查詢，這次不提供推薦，請稍後再試。');
      else if (!state.competition.analyses.length) lines.push('目前找不到符合條件的競賽。');
      else lines.push(...(state.competition.offTopic ? [OFF_TOPIC_NOTE] : []), `依你的能力檔案推薦 ${state.competition.analyses.length} 項競賽，最適合的是「${state.competition.analyses[0].competition.name}」（適配度 ${state.competition.analyses[0].fit.total} 分）。每項都列出優點、弱項與能力缺口。`);
    }
    if (type === 'prepare_competition') {
      if (state.competition.status === 'failed') lines.push('競賽資料暫時無法查詢，任務已中止；不提供未經查證的建議。');
      else if (state.competition.status === 'none') {
        const from = state.competition.replacedFrom;
        lines.push(from ? `「${from.name}」資格不符（${from.reasons.join('、')}），目前也找不到資格符合的替代競賽。` : '目前沒有資格符合的競賽可推薦。');
      } else if (a) {
        if (state.competition.offTopic) lines.push(OFF_TOPIC_NOTE);
        if (state.competition.replacedFrom) lines.push(`「${state.competition.replacedFrom.name}」資格不符（${state.competition.replacedFrom.reasons.join('、')}），已改推薦「${a.competition.name}」。`);
        lines.push(`「${a.competition.name}」資格符合，適配度 ${a.fit.total} 分。${a.gaps.length ? `能力缺口：${a.gaps.map(g => g.name).join('、')}。` : '需求技能都已具備。'}`);
      }
    }
    const mates = facts.可邀請隊友;
    const advisors = facts.可邀請教師;
    if (mates.length) lines.push(`找到 ${mates.length} 位可補位的隊友。`);
    if (advisors.length) lines.push(`找到 ${advisors.length} 位可邀請的指導老師。`);
    const contactable = facts.可自行聯絡的教師人數;
    if (contactable) lines.push(`另有 ${contactable} 位專長相符的教師可自行聯絡；他們不是平台帳號，系統不會代為邀請。`);
    if ((type === 'find_teammate' || type === 'find_teacher') && !mates.length && !advisors.length && !contactable && !facts.查詢失敗.length) lines.push('目前沒有達到有效門檻的人選。');
    if (facts.尚未補齊的缺口.length) lines.push(`尚未補齊的缺口：${facts.尚未補齊的缺口.join('、')}。`);
    if (facts.查詢失敗.length) lines.push(`${facts.查詢失敗.join('、')}的資料來源查詢失敗，該部分不提供推薦。`);
    if (mates.length || advisors.length) lines.push('邀請要由你勾選並確認後才會送出。');
    return lines.join('');
  }

  // ---------- 執行一步 ----------
  async function step(user, runId) {
    const run = loadRun(runId);
    assertOwner(user, run);
    if (runStatus(run.state) !== 'running') return snapshot(runId);
    if (busy.has(runId)) throw new AppError('BUSY', '這個任務正在執行中', 409);
    busy.add(runId);
    try {
      let state = run.state;
      const ctx = makeCtx(runId, state);
      const allowed = allowedActions(state);
      if (!allowed.length) {
        saveRun(runId, finish(state, 'completed', state.summary?.text ?? '任務完成'));
        return snapshot(runId);
      }
      const isApprovedSend = allowed[0].action === 'send_invitations'; // 使用者已確認的動作一定要執行
      if (state.stepCount >= MAX_STEPS && !isApprovedSend) {
        ctx.trace.emit('stop', `已達步數上限 ${MAX_STEPS}，任務中止`, {agent: AGENT, data: {reason: 'step_budget'}});
        saveRun(runId, finish(state, 'stopped', '已達步數上限，任務中止。'));
        return snapshot(runId);
      }
      const picked = await brain.choose(state, allowed, ctx);
      ctx.trace.emit('decision', `下一步：${picked.choice.label}（${picked.why}）`,
        {agent: AGENT, data: {chosen: picked.choice.id, by: picked.by, allowed: allowed.map(a => a.id)}});
      const started = performance.now();
      try {
        state = await executors[picked.choice.action](ctx, {...state, stepCount: state.stepCount + 1}, picked.choice.args);
      } catch (err) {
        process.stderr.write(`[orchestrator] ${runId} ${picked.choice.action} 失敗：${err?.stack ?? err}\n`);
        ctx.trace.emit('error', `步驟「${picked.choice.label}」發生未預期錯誤，任務中止；未輸出任何未經查證的結果`, {agent: AGENT});
        state = finish({...state, stepCount: state.stepCount + 1}, 'stopped', '系統發生未預期錯誤，任務已中止。請稍後再試。');
      }
      ctx.trace.emit('step_done', `${picked.choice.label} 完成`, {agent: AGENT, ms: Math.round(performance.now() - started), data: {action: picked.choice.id}});
      // 這一步等待外部資源期間，使用者可能已取消任務：以取消為準，不把狀態寫回去。
      if (loadRun(runId).state.outcome) {
        ctx.trace.emit('stop', `任務已在「${picked.choice.label}」執行期間被取消，這一步的結果不採用`, {agent: AGENT});
        return snapshot(runId);
      }
      saveRun(runId, state);
      return snapshot(runId);
    } finally {
      busy.delete(runId);
    }
  }

  // ---------- 人工確認（HITL） ----------
  function confirm(user, runId, input) {
    const run = loadRun(runId);
    assertOwner(user, run);
    const state = run.state;
    if (!state.pending || state.pending.type !== input.type) throw new AppError('INVALID_STATE', '目前沒有等待這項確認', 409);
    const ctx = makeCtx(runId, state);

    if (input.type === 'confirm_profile') {
      const profile = profileOf(state);
      const valid = new Set(profile.skills.map(sk => sk.skillId));
      // 沒有指定就維持目前的納入設定（不會把先前取消納入的技能重新納入）
      const kept = input.keptSkillIds ? input.keptSkillIds.filter(id => valid.has(id)) : profile.skills.filter(sk => sk.kept).map(sk => sk.skillId);
      // 真實資料版的能力檔案跟著任務走：確認結果記在任務狀態，不寫入平台的能力檔案資料表
      const confirmedCampus = isCampus(state, 'inventory') ? {campus: {...state.campus, kept, confirmed: true}} : {};
      if (!isCampus(state, 'inventory')) inventory.confirmProfile(state.studentId, kept);
      ctx.trace.emit('user_confirm', `使用者確認能力檔案：保留 ${kept.length}/${valid.size} 項技能，檔案生效`, {agent: AGENT, data: {type: 'confirm_profile', kept: kept.length, total: valid.size}});
      audit(db, user.id, 'profile_confirmed', runId, {kept: kept.length, total: valid.size});
      saveRun(runId, {...state, ...confirmedCampus, pending: null});
      return snapshot(runId);
    }

    // confirm_invites：只能邀請「經輸出檢核的推薦名單」內的對象
    const invitable = new Map(state.summary.invitable.map(i => [`${i.kind}:${i.id}`, i]));
    const selected = [...new Set((input.selected ?? []).map(sel => `${sel.kind}:${sel.id}`))].map(key => invitable.get(key)).filter(Boolean);
    if ((input.selected ?? []).length !== selected.length) throw new AppError('INVALID_INPUT', '選擇的對象不在推薦名單內');
    if (!selected.length) {
      ctx.trace.emit('user_confirm', '使用者決定不送出任何邀請', {agent: AGENT, data: {type: 'confirm_invites', selected: 0}});
      ctx.trace.emit('done', '任務完成（未送出邀請）', {agent: AGENT});
      saveRun(runId, finish(state, 'completed', `${state.summary.text} 你選擇這次不送出邀請。`));
      return snapshot(runId);
    }
    ctx.trace.emit('user_confirm', `使用者確認邀請 ${selected.length} 位：${selected.map(s => s.name).join('、')}`, {agent: AGENT, data: {type: 'confirm_invites', selected: selected.map(s => ({kind: s.kind, id: s.id}))}});
    saveRun(runId, {...state, pending: null, approval: {by: user.id, at: nowIso(), selected, sent: false}});
    return snapshot(runId);
  }

  function cancel(user, runId) {
    const run = loadRun(runId);
    assertOwner(user, run);
    if (run.state.outcome) return snapshot(runId);
    const ctx = makeCtx(runId, run.state);
    ctx.trace.emit('user_cancel', '使用者取消任務', {agent: AGENT});
    saveRun(runId, finish(run.state, 'cancelled', '任務已由使用者取消，沒有送出任何邀請。'));
    return snapshot(runId);
  }

  // ---------- 邀請回覆（對方同意後關係才成立） ----------
  function respondInvitation(user, invitationId, accept) {
    const inv = db.prepare('SELECT * FROM invitations WHERE id = ?').get(invitationId);
    if (!inv) throw new AppError('NOT_FOUND', '找不到這份邀請', 404);
    if (inv.to_id !== user.id) throw new AppError('FORBIDDEN', '只有受邀者可以回覆邀請', 403);
    if (inv.status !== 'sent') throw new AppError('INVALID_STATE', '這份邀請已處理過', 409);
    transaction(db, () => {
      if (accept && inv.kind === 'advisor') {
        const teacherUser = getUser(db, user.id);
        if (teacherUser.used >= teacherUser.quota) throw new AppError('QUOTA_FULL', '指導名額已滿，無法再接受', 409);
        const row = db.prepare('SELECT attrs FROM users WHERE id = ?').get(user.id);
        db.prepare('UPDATE users SET attrs = ? WHERE id = ?').run(JSON.stringify({...JSON.parse(row.attrs), used: teacherUser.used + 1}), user.id);
      }
      db.prepare('UPDATE invitations SET status = ?, decided_at = ? WHERE id = ?').run(accept ? 'accepted' : 'declined', nowIso(), invitationId);
    });
    audit(db, user.id, accept ? 'invite_accepted' : 'invite_declined', invitationId, {kind: inv.kind});
    if (inv.run_id) {
      createTrace(db, inv.run_id).emit(accept ? 'invite_accepted' : 'invite_declined',
        `${user.name} ${accept ? '同意' : '婉拒'}了${inv.kind === 'advisor' ? '指導' : '組隊'}邀請${accept && inv.kind === 'advisor' ? '，指導關係成立' : ''}`, {agent: AGENT, data: {invitationId}});
    }
    return listInvitations(user);
  }

  function listInvitations(user) {
    const rows = db.prepare('SELECT * FROM invitations WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC').all(user.id, user.id);
    const nameOf = id => db.prepare('SELECT name, dept FROM users WHERE id = ?').get(id);
    return rows.map(r => ({
      id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, runId: r.from_id === user.id ? r.run_id : null,
      direction: r.from_id === user.id ? 'outgoing' : 'incoming',
      from: {id: r.from_id, ...nameOf(r.from_id)}, to: {id: r.to_id, ...nameOf(r.to_id)},
      competition: r.competition_id ? (competition.get(r.competition_id) ?? (campus?.available('hybrid') ? campus.competition.get(r.competition_id) : null))?.name ?? null : null,
      skill: r.skill_id ? skillLabel(r.skill_id) : null,
    }));
  }

  // ---------- 讀取 ----------
  function assertOwner(user, run) {
    if (run.userId !== user.id) throw new AppError('FORBIDDEN', '只能存取自己的任務', 403);
  }

  /** 任務快照（僅本人可讀）。 */
  function snapshot(runId, afterSeq = 0) {
    const run = loadRun(runId);
    const s = run.state;
    const events = listEvents(db, runId);
    return {
      id: run.id, goal: run.goal, status: runStatus(s), createdAt: run.createdAt,
      source: s.source ?? 'demo', sourceLabel: SOURCE_LABELS[s.source ?? 'demo'],
      intent: {...s.intent, label: INTENT_LABELS[s.intent.type], skillNames: s.intent.skillIds.map(skillsOf(s).name)},
      plan: planView(s),
      inventory: s.inventory,
      profile: s.inventory.status !== 'pending' ? profileOf(s) : null,
      enrollmentOrigin: s.campus?.origin ?? null,
      competition: s.competition, gaps: s.gaps, team: s.team, advisor: s.advisor, summary: s.summary,
      pending: s.pending, outcome: s.outcome, faults: s.faults,
      nextActions: allowedActions(s).map(a => ({id: a.id, label: a.label})),
      events: events.filter(e => e.seq > afterSeq), metrics: runMetrics(events),
    };
  }

  function getRun(user, runId, afterSeq = 0) {
    const run = loadRun(runId);
    assertOwner(user, run);
    return snapshot(runId, afterSeq);
  }

  /** 完整操作紀錄（本人或管理者可讀；紀錄不含成績）。 */
  function getEvidence(user, runId) {
    const run = loadRun(runId);
    if (run.userId !== user.id && user.role !== 'admin') throw new AppError('FORBIDDEN', '無權讀取這份紀錄', 403);
    const events = listEvents(db, runId);
    return {
      runId: run.id, goal: run.goal, status: runStatus(run.state), createdAt: run.createdAt, exportedAt: nowIso(),
      note: '成績與個別技能分數不寫入紀錄；紀錄中的適配度與媒合分數只由等級帶、是否達標與公開條件計算', brain: llm.enabled ? `llm:${llm.model}` : 'rule', rulesVersion: config.rules.version,
      faults: run.state.faults, metrics: runMetrics(events), events,
    };
  }

  function listRuns(user) {
    const rows = user.role === 'admin'
      ? db.prepare('SELECT id, user_id, goal, status, created_at FROM runs ORDER BY created_at DESC LIMIT 50').all()
      : db.prepare('SELECT id, user_id, goal, status, created_at FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
    return rows.map(r => ({id: r.id, userId: r.user_id, goal: r.goal, status: r.status, createdAt: r.created_at}));
  }

  return Object.freeze({createRun, step, confirm, cancel, getRun, getEvidence, listRuns, listInvitations, respondInvitation, availableSources, defaultSource});
}
