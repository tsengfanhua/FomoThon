// 工具執行器：所有 Agent 對資料庫、課綱站等資源的存取都經過這裡。
// 負責：權限檢查、逾時與重試、故障注入（展示用）、以及把每次調用寫進執行紀錄。

export class ToolError extends Error {
  /**
   * @param {string} code 錯誤代碼，例如 TIMEOUT、NOT_FOUND、FORBIDDEN
   * @param {string} message
   * @param {{transient?: boolean}} [opts] transient=true 表示可重試
   */
  constructor(code, message, {transient = false} = {}) {
    super(message);
    this.code = code;
    this.transient = transient;
  }
}

const PERMISSIONS = ['read', 'write'];

export function createToolRunner() {
  const registry = new Map();

  /**
   * @param {{name:string, agent:string, permission:'read'|'write', handler:Function, summarize?:Function}} tool
   */
  function register(tool) {
    if (!PERMISSIONS.includes(tool.permission)) throw new Error(`工具 ${tool.name} 的權限設定錯誤`);
    if (registry.has(tool.name)) throw new Error(`工具重複註冊：${tool.name}`);
    registry.set(tool.name, Object.freeze({...tool}));
  }

  /**
   * 呼叫工具。不丟例外：失敗時回傳 {ok:false, error}，由 Agent 決定退回、重規劃或停止。
   * @param {object} ctx 執行脈絡：trace、faults、user、approval
   * @param {string} name
   * @param {object} args
   * @param {{retries?: number, logArgs?: object}} [opts]
   */
  async function call(ctx, name, args, {retries = 0, logArgs = args} = {}) {
    const tool = registry.get(name);
    if (!tool) throw new Error(`未註冊的工具：${name}`);
    const base = {agent: tool.agent, tool: name};

    // 寫入類工具必須帶有人工確認後核發的許可（HITL）
    if (tool.permission === 'write' && !ctx.approval) {
      ctx.trace.emit('tool_error', `${name} 被拒絕：寫入動作需要使用者確認`, {...base, data: {code: 'FORBIDDEN'}});
      return {ok: false, error: {code: 'FORBIDDEN', message: '寫入動作需要使用者確認'}};
    }

    const maxRetries = ctx.noRetry ? 0 : retries; // 消融基準：不重試
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const started = performance.now();
      ctx.trace.emit('tool_call', `${name}${attempt ? `（第 ${attempt + 1} 次嘗試）` : ''}`, {...base, data: {args: logArgs, attempt}});
      try {
        const result = await tool.handler(args, {...ctx, attempt});
        const ms = Math.round(performance.now() - started);
        const summary = tool.summarize ? tool.summarize(result) : '完成';
        ctx.trace.emit('tool_result', `${name} → ${summary}`, {...base, ms});
        return {ok: true, result, attempts: attempt + 1};
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        const code = err instanceof ToolError ? err.code : 'INTERNAL';
        const message = err instanceof ToolError ? err.message : '工具內部錯誤';
        ctx.trace.emit('tool_error', `${name} 失敗：${message}`, {...base, ms, data: {code, attempt}});
        const canRetry = err instanceof ToolError && err.transient && attempt < maxRetries;
        if (!canRetry) return {ok: false, error: {code, message}, attempts: attempt + 1};
        ctx.trace.emit('retry', `${name} 暫時性錯誤（${code}），重試第 ${attempt + 1} 次`, base);
      }
    }
    return {ok: false, error: {code: 'INTERNAL', message: '重試流程異常結束'}};
  }

  return Object.freeze({register, call, list: () => [...registry.values()].map(t => ({name: t.name, agent: t.agent, permission: t.permission}))});
}

/** 展示／評測用的故障注入：flaky＝第一次失敗後恢復；down＝持續失敗。 */
export function injectFault(mode, attempt, label) {
  if (mode === 'down' || (mode === 'flaky' && attempt === 0)) {
    throw new ToolError('TIMEOUT', `${label}連線逾時`, {transient: true});
  }
}
