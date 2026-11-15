// MCP 工具：把共用 Skill 資料庫、能力盤點與三個媒合 Agent 開放給任何 MCP 用戶端（Claude Desktop、Claude Code、IDE……）。
// 全部是唯讀工具：送出邀請等寫入動作不開放給外部 AI，必須由學生本人在系統內確認（HITL）。
// 每個工具都經過與網頁版相同的 Agent、工具執行器與防護，執行紀錄放在結果的 _meta 中。
import {INTENT_LABELS, parseIntent} from '../agents/intent.js';
import {allowedActions, initialState, planView} from '../agents/policy.js';
import {assessSyllabus} from '../dq/syllabus.js';
import {practiceShare} from '../inventory/extractor.js';
import {checkGoal} from '../safety/guard.js';
import {listPersonNames} from '../db.js';
import {AppError} from '../util.js';
import * as S from './schemas.js';

const READ_ONLY = Object.freeze({readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false});
const MAX_SEARCH_RESULTS = 20;

function requireStudent(user) {
  if (user.role !== 'student') throw new AppError('FORBIDDEN', '這個工具只開放學生身分使用（MCP 連線綁定的帳號不是學生）');
}

/**
 * @param {object} app createApp() 的結果
 * @param {ReturnType<import('./views.js').createViews>} views
 * @returns {Array<object>} MCP 工具定義（handler 的第二個參數含 user 與 agentCtx）
 */
export function createTools(app, views) {
  const {skills, competition, teammate, teacher, tools, llm, db} = app;
  // 啟用 LLM 時，萃取與任務辨識會呼叫外部模型
  const MAY_CALL_MODEL = Object.freeze({...READ_ONLY, openWorldHint: llm.enabled});

  const findCompetition = id => {
    const comp = competition.get(id);
    if (!comp) throw new AppError('NOT_FOUND', `找不到競賽 ${id}；請先用 list_competitions 查詢可用的 ID`);
    return comp;
  };
  const ensureSkill = id => {
    if (!skills.has(id)) throw new AppError('NOT_FOUND', `Skill 資料庫沒有 ${id}；請先用 search_skills 查詢`);
    return id;
  };

  return [
    {
      name: 'search_skills',
      title: '搜尋技能',
      description: '在共用 Skill 資料庫中依關鍵字（中文、英文或別名，例如「前端」「JS」「機器學習」）搜尋技能，回傳技能 ID 與 ESCO 對應。其他工具都以技能 ID 溝通。',
      inputSchema: S.input({query: S.str({minLength: 1, maxLength: 60, pattern: '\\S'}), limit: S.int({minimum: 1, maximum: MAX_SEARCH_RESULTS})}, ['query']),
      outputSchema: S.obj({query: S.str(), total: S.int(), skills: S.arr(S.skillSummary)}),
      annotations: READ_ONLY,
      handler: async ({query, limit = 10}) => {
        const q = query.trim().toLowerCase();
        const viaAlias = skills.findInText(query).map(h => h.skillId);
        const viaText = skills.all()
          .filter(s => [s.zh, s.en, s.category, ...s.aliases].some(t => t.toLowerCase().includes(q)))
          .map(s => s.id);
        const ids = [...new Set([...viaAlias, ...viaText])];
        return {query, total: ids.length, skills: ids.slice(0, limit).map(id => views.skillSummary(skills.get(id)))};
      },
    },
    {
      name: 'get_skill',
      title: '技能詳細資料',
      description: '查詢單一技能：上下位與相關技能（含關聯度）、ESCO／O*NET／SFIA／UCAN 對應、等級量尺、哪些課程在教（課綱覆蓋率）、哪些競賽需要。',
      inputSchema: S.input({skillId: S.SKILL_ID}, ['skillId']),
      outputSchema: S.skillDetail,
      annotations: READ_ONLY,
      handler: async ({skillId}) => views.skillDetail(ensureSkill(skillId)),
    },
    {
      name: 'get_my_profile',
      title: '我的能力檔案',
      description: '目前連線帳號（學生本人）的能力檔案：每項技能的等級帶、驗證狀態（已驗證／推估／自述）與證據出處。不含成績與精確分數。',
      inputSchema: S.input({}),
      outputSchema: S.profile,
      annotations: READ_ONLY,
      handler: async (_args, {user}) => {
        requireStudent(user);
        return views.profileView(user);
      },
    },
    {
      name: 'list_competitions',
      title: '競賽清單',
      description: '列出系統收錄的全部競賽：類型、截止日與剩餘天數、資格限制、需求技能與門檻等級。',
      inputSchema: S.input({}),
      outputSchema: S.obj({competitions: S.arr(S.competitionItem)}),
      annotations: READ_ONLY,
      handler: async () => ({competitions: competition.list().map(views.competitionItem)}),
    },
    {
      name: 'recommend_competitions',
      title: '推薦競賽',
      description: '競賽 Agent：依學生的能力檔案與興趣推薦競賽，逐項檢查資格、計算 100 分適配度（主題 30／缺口可補 20／難度 20／時程 15／延伸價值 15），並列出優點、弱項與能力缺口。',
      inputSchema: S.input({
        interest: S.str({maxLength: 200, description: '學生描述的興趣或目標，例如「想做 AI 相關的比賽」'}),
        skillIds: S.arr(S.SKILL_ID, {maxItems: 5, uniqueItems: true}),
        limit: S.int({minimum: 1, maximum: 5}),
      }),
      outputSchema: S.obj({considered: S.int(), matchedBySignal: S.bool(), competitions: S.arr(S.analysis)}),
      annotations: READ_ONLY,
      handler: async ({interest = '', skillIds = [], limit = 3}, {user, agentCtx}) => {
        requireStudent(user);
        skillIds.forEach(ensureSkill);
        const res = await competition.recommend(agentCtx, {student: user, skillIds, text: interest, limit});
        if (res.error) throw new AppError('UNAVAILABLE', `競賽資料暫時無法查詢（${res.error.code}），不提供未經查證的推薦`);
        return {considered: res.considered, matchedBySignal: Boolean(res.matchedBySignal), competitions: res.analyses.map(views.analysisView)};
      },
    },
    {
      name: 'analyze_competition',
      title: '分析單一競賽',
      description: '競賽 Agent：分析學生參加指定競賽的資格、適配度與每一項需求技能的達標狀態（met／weak／unverified／missing）。歷屆資料查不到時會標示 partial，不捏造數據。',
      inputSchema: S.input({competitionId: S.COMPETITION_ID}, ['competitionId']),
      outputSchema: S.analysis,
      annotations: READ_ONLY,
      handler: async ({competitionId}, {user, agentCtx}) => {
        requireStudent(user);
        return views.analysisView(await competition.analyze(agentCtx, {student: user, competition: findCompetition(competitionId)}));
      },
    },
    {
      name: 'find_teammates',
      title: '找互補隊友',
      description: '學生 Agent：為一項能力缺口找隊友。三輪搜尋（精準 → 補查證據 → 相關技能潛力）加品質閘門，有效候選達 3 位即停止；只推薦已開放媒合的同學，只顯示等級帶與理由。給 competitionId 時會一併標出候選人還能補哪些缺口。',
      inputSchema: S.input({skillId: S.SKILL_ID, competitionId: S.COMPETITION_ID}, ['skillId']),
      outputSchema: S.teammates,
      annotations: READ_ONLY,
      handler: async ({skillId, competitionId}, {user, agentCtx}) => {
        requireStudent(user);
        ensureSkill(skillId);
        const gapSkillIds = competitionId
          ? (await competition.analyze(agentCtx, {student: user, competition: findCompetition(competitionId)})).rows.filter(r => r.status !== 'met').map(r => r.skillId)
          : [skillId];
        return views.teammateView(await teammate.match(agentCtx, {student: user, skillId, gapSkillIds}));
      },
    },
    {
      name: 'find_advisors',
      title: '找指導老師',
      description: '教師 Agent：依技能或競賽需求媒合指導老師（專長 40／開課 20／指導經驗 20／師生關係 10／名額 10），列出理由與需要老師本人確認的事項。只列出開放指導且仍有名額的老師。',
      inputSchema: S.input({skillIds: S.arr(S.SKILL_ID, {minItems: 1, maxItems: 5, uniqueItems: true}), competitionId: S.COMPETITION_ID}),
      outputSchema: S.advisors,
      annotations: READ_ONLY,
      handler: async ({skillIds, competitionId}, {user, agentCtx}) => {
        requireStudent(user);
        if (!skillIds?.length && !competitionId) throw new AppError('INVALID_INPUT', '請提供 skillIds 或 competitionId 其中之一');
        (skillIds ?? []).forEach(ensureSkill);
        const comp = competitionId ? findCompetition(competitionId) : null;
        const targetIds = skillIds?.length ? skillIds : comp.needs.map(n => n.skill);
        return views.advisorView(await teacher.match(agentCtx, {student: user, targetIds, competition: comp}));
      },
    },
    {
      name: 'extract_course_skills',
      title: '課綱技能萃取',
      description: '能力盤點模組：抓取一門課的課綱，評估課綱品質，萃取 1～5 項技能並附上課綱原文出處與覆蓋率。課綱是不可信的外部文件：已去除標籤，含可疑內容時品質不合格。',
      inputSchema: S.input({courseCode: S.COURSE_CODE}, ['courseCode']),
      outputSchema: S.obj({
        courseCode: S.str(), name: S.str(), source: S.obj({url: S.nullable(S.str()), hash: S.nullable(S.str())}), mode: S.str(), practiceShare: S.num(),
        quality: S.obj({ok: S.bool(), score: S.num(), issues: S.arr(S.str())}),
        skills: S.arr(S.obj({skillId: S.str(), name: S.str(), coverage: S.num(), extractor: S.str(), quotes: S.arr(S.obj({where: S.str(), text: S.str()}))})),
      }),
      annotations: MAY_CALL_MODEL,
      handler: async ({courseCode}, {agentCtx}) => {
        const fetched = await tools.call(agentCtx, 'syllabus.fetch', {code: courseCode}, {retries: 1});
        if (!fetched.ok) throw new AppError('NOT_FOUND', `無法取得 ${courseCode} 的課綱（${fetched.error.code}）`);
        const syllabus = fetched.result;
        const extracted = await tools.call(agentCtx, 'skills.extract', {syllabus}, {logArgs: {course: courseCode, mode: 'syllabus'}});
        if (!extracted.ok) throw new AppError('UNAVAILABLE', '技能萃取失敗');
        const quality = assessSyllabus(syllabus);
        return {
          courseCode, name: syllabus.name, source: {url: syllabus.url ?? null, hash: syllabus.hash ?? null}, mode: extracted.result.mode,
          practiceShare: practiceShare(syllabus),
          quality: {ok: quality.ok, score: quality.score, issues: quality.issues.map(i => i.message)},
          skills: extracted.result.items.map(i => ({skillId: i.skillId, name: skills.name(i.skillId), coverage: i.coverage, extractor: i.extractor, quotes: i.quotes})),
        };
      },
    },
    {
      name: 'plan_goal',
      title: '任務辨識與規劃',
      description: '協調器：把學生的自然語言目標分類成任務（參賽準備／找競賽／找隊友／找老師／能力盤點），並列出會經過的步驟與第一步。含輸入防護：提示注入與越權要求會被拒絕。不會執行任何步驟。',
      inputSchema: S.input({goal: S.str({minLength: 1, maxLength: 300})}, ['goal']),
      outputSchema: S.obj({
        allowed: S.bool(),
        guard: S.nullable(S.obj({category: S.str(), message: S.str()})),
        intent: S.nullable(S.obj({
          type: S.str(), label: S.str(), source: S.str(), skills: S.arr(S.skillRef),
          competition: S.nullable(S.obj({competitionId: S.str(), name: S.str()})),
        })),
        plan: S.arr(S.obj({key: S.str(), label: S.str()})),
        nextActions: S.arr(S.obj({action: S.str(), label: S.str(), why: S.str()})),
      }),
      annotations: MAY_CALL_MODEL,
      handler: async ({goal}, {user, agentCtx}) => {
        const guard = checkGoal(goal);
        if (!guard.ok) return {allowed: false, guard: {category: guard.category, message: guard.message}, intent: null, plan: [], nextActions: []};
        const comps = competition.list();
        const intent = await parseIntent(guard.goal, {llm, skills, competitions: comps, personNames: listPersonNames(db)}, agentCtx);
        const state = initialState({goal: guard.goal, studentId: user.id, intent, faults: {}});
        const comp = intent.competitionId ? comps.find(c => c.id === intent.competitionId) : null;
        return {
          allowed: true, guard: null,
          intent: {
            type: intent.type, label: INTENT_LABELS[intent.type], source: intent.source, skills: intent.skillIds.map(views.ref),
            competition: comp ? {competitionId: comp.id, name: comp.name} : null,
          },
          plan: planView(state).map(({key, label}) => ({key, label})),
          nextActions: allowedActions(state).map(a => ({action: a.action, label: a.label, why: a.why})),
        };
      },
    },
    {
      name: 'check_data_quality',
      title: '資料品質檢核',
      description: '對 Skill 資料庫、課綱、人員與競賽資料執行 23 條資料品質規則（完整性、有效性、唯一性、一致性、時效性、可信度），回傳各面向分數、閘門結果與發現的問題。',
      inputSchema: S.input({}),
      outputSchema: S.dataQuality,
      annotations: READ_ONLY,
      handler: async (_args, {user}) => views.dataQualityView(app.dataQuality(), user),
    },
  ];
}
