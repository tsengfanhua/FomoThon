// 執行紀錄（Trace）：每一次決策、工具調用、閘門判斷與人工確認都留下事件，可重播與稽核。
// 規則：成績與由成績推得的分數不寫入紀錄。
import {nowIso, safeJsonParse} from './util.js';

const HUMAN_EVENTS = new Set(['user_confirm', 'user_cancel']);

/**
 * @param {import('node:sqlite').DatabaseSync|null} db 傳 null 時不落地（種子建置用）
 * @param {string|null} runId
 */
export function createTrace(db, runId) {
  // 序號在寫入當下由資料庫決定：同一任務同時有多個寫入者（例如步驟執行中使用者按下取消）也不會重複。
  const insert = db && runId
    ? db.prepare(`INSERT INTO events (run_id, seq, ts, type, agent, tool, summary, data, ms)
        VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id = ?), ?, ?, ?, ?, ?, ?, ?) RETURNING seq`)
    : null;
  let localSeq = 0; // 不落地時（種子建置）才使用

  /**
   * @param {string} type 事件類型，例如 tool_call、gate、replan、await_user
   * @param {string} summary 一句話說明（顯示在紀錄面板）
   * @param {{agent?:string, tool?:string, data?:object, ms?:number}} [extra]
   */
  function emit(type, summary, extra = {}) {
    const base = {ts: nowIso(), type, agent: extra.agent ?? null, tool: extra.tool ?? null, summary, data: extra.data ?? null, ms: extra.ms ?? null};
    if (!insert) {
      localSeq += 1;
      return {seq: localSeq, ...base};
    }
    const row = insert.get(runId, runId, base.ts, type, base.agent, base.tool, summary, base.data ? JSON.stringify(base.data) : null, base.ms);
    return {seq: row.seq, ...base};
  }

  return Object.freeze({emit, runId});
}

export function listEvents(db, runId, afterSeq = 0) {
  return db.prepare('SELECT seq, ts, type, agent, tool, summary, data, ms FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
    .all(runId, afterSeq)
    .map(row => ({...row, data: row.data ? safeJsonParse(row.data) : null}));
}

/** 由事件彙整單次執行的評測指標（附件二要求的揭露項目）。 */
export function runMetrics(events) {
  const count = type => events.filter(e => e.type === type).length;
  const toolCalls = count('tool_call');
  const toolErrors = count('tool_error');
  const llmEvents = events.filter(e => e.type === 'llm_call');
  const first = events[0];
  const last = events.at(-1);
  return {
    events: events.length,
    steps: count('decision'),
    toolCalls,
    toolErrors,
    toolSuccessRate: toolCalls ? Math.round(((toolCalls - toolErrors) / toolCalls) * 1000) / 1000 : null,
    retries: count('retry'),
    fallbacks: count('fallback'),
    replans: count('replan'),
    humanInterventions: events.filter(e => HUMAN_EVENTS.has(e.type)).length,
    guardBlocks: count('guard_block'),
    llmCalls: llmEvents.length,
    llmFailures: llmEvents.filter(e => e.data?.ok === false).length,
    tokensIn: llmEvents.reduce((acc, e) => acc + (e.data?.usage?.input ?? 0), 0),
    tokensOut: llmEvents.reduce((acc, e) => acc + (e.data?.usage?.output ?? 0), 0),
    costUsd: llmEvents.reduce((acc, e) => acc + (e.data?.costUsd ?? 0), 0),
    activeMs: events.reduce((acc, e) => acc + (e.type === 'step_done' ? (e.ms ?? 0) : 0), 0),
    wallMs: first && last ? new Date(last.ts) - new Date(first.ts) : 0,
  };
}
