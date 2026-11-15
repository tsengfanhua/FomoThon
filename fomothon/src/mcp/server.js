// Fomo鬆 MCP 伺服器：組合協定層、工具、資源與提示範本；每次工具呼叫都建立執行紀錄並寫入稽核。
import {audit} from '../db.js';
import {AppError} from '../util.js';
import {createMcpServer} from './protocol.js';
import {PROMPTS, createResources} from './resources.js';
import {createTools} from './tools.js';
import {createViews} from './views.js';

export const SERVER_INFO = Object.freeze({name: 'fomothon', title: 'Fomo鬆 參賽助理', version: '1.1.0'});

const INSTRUCTIONS = `Fomo鬆（FomoThon）校園參賽協作平台。工具分三類：
1. 共用 Skill 資料庫：search_skills、get_skill。技能一律以 SK-XXX-000 形式的 ID 溝通，並對應 ESCO／O*NET／SFIA／UCAN。
2. 能力盤點：get_my_profile（連線帳號本人的能力檔案）、extract_course_skills（課綱 → 技能，附原文出處與課綱品質）。
3. 媒合 Agent：list_competitions、recommend_competitions、analyze_competition（競賽）、find_teammates（隊友）、find_advisors（指導老師）。
不確定從哪裡開始時，先呼叫 plan_goal 辨識任務並取得建議步驟；check_data_quality 可查看資料品質。
原則：分數由版本化的固定規則計算並附依據；只提供等級帶與驗證狀態，不提供任何人的成績；本介面唯讀，送出邀請必須由學生本人在系統內確認。工具回報資料無法取得時，請照實轉告，不要自行補上推測。`;

/** 不落地的執行紀錄：收集這次工具呼叫內部的 Agent 決策與工具調用，放進結果的 _meta。 */
function collectingTrace() {
  const events = [];
  return {
    events,
    trace: {
      runId: null,
      emit(type, summary, extra = {}) {
        const event = {seq: events.length + 1, type, summary, agent: extra.agent ?? null, tool: extra.tool ?? null, ms: extra.ms ?? null};
        events.push(event);
        return event;
      },
    },
  };
}

function instrument(app, tool) {
  return async (args, ctx) => {
    const {events, trace} = collectingTrace();
    const agentCtx = {
      trace, faults: {}, noRetry: false, user: ctx.user,
      recordLlm: res => trace.emit('llm_call', `LLM（${res.purpose}）${res.ok ? '完成' : `失敗：${res.error}`}`, {agent: 'mcp', ms: res.ms}),
    };
    const started = performance.now();
    let ok = false;
    try {
      const data = await tool.handler(args, {...ctx, agentCtx});
      ok = true;
      return data;
    } finally {
      ctx.attachMeta('fomothon/trace', events);
      // 稽核只記工具名稱與結果，不記參數內容（參數可能含學生輸入的文字）
      audit(app.db, ctx.user.id, 'mcp_tool_call', tool.name, {ok, ms: Math.round(performance.now() - started), transport: ctx.transport ?? null});
    }
  };
}

/**
 * @param {object} app createApp() 的結果
 * @param {{log?: (level:string, message:string) => void}} [opts]
 */
export function createFomothonMcp(app, {log = () => {}} = {}) {
  const views = createViews(app);
  const tools = createTools(app, views).map(tool => ({...tool, handler: instrument(app, tool)}));
  const {resources, resourceTemplates} = createResources(app, views);
  return createMcpServer({
    info: SERVER_INFO, instructions: INSTRUCTIONS, tools, resources, resourceTemplates, prompts: PROMPTS,
    exposeError: err => (err instanceof AppError ? err.message : null),
    log,
  });
}
