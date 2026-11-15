// 協調器的「大腦」：在政策允許的動作清單中選下一步，以及把規則算出的結果寫成給學生看的說明。
// 啟用 LLM 時由模型在受限清單內選擇並潤飾說明；任何失敗或檢核不過都退回規則與範本。
import {checkGrounding, checkShortReason} from '../safety/guard.js';
import {hasLeftoverCode, pseudonymize} from '../safety/privacy.js';
import {tryValidate, v} from '../validate.js';

const CHOOSE_SYSTEM = `你是校園參賽助理的協調器。根據學生目標與目前進度，從「可選動作」中選出最應該先做的一個。
只能回傳可選動作中的 id；reason 用一句繁體中文說明為什麼先做這一步。`;

const NARRATE_SYSTEM = `你是校園參賽助理。請根據「事實」用繁體中文寫 2～3 句給學生的建議。
規則：只能使用事實中的資訊；不可新增任何人名、競賽名、分數或數字；不可保證得獎；語氣務實、鼓勵但不誇大。
人名已用〔人員1〕這類代號表示：提到人選時照抄代號，不要猜測或改寫。
最後提醒：邀請要由學生自己確認後才會送出。`;

/** 事實中屬於個人的姓名（隊友與教師）；送出前以代號取代，回來後在本機換回。 */
const namesInFacts = facts => [...(facts.可邀請隊友 ?? []), ...(facts.可邀請教師 ?? [])].map(p => p.姓名).filter(Boolean);

/**
 * @param {{llm:object, personNames?: () => string[]}} deps personNames：系統中的人名，送出前代號化
 */
export function createBrain({llm, personNames = () => []}) {
  /**
   * @param {object} state
   * @param {Array} allowed 政策算出的合法動作（已依規則優先順序排列）
   * @returns {Promise<{choice:object, by:'policy'|'rule'|'llm', why:string}>}
   */
  async function choose(state, allowed, ctx) {
    if (allowed.length === 1) return {choice: allowed[0], by: 'policy', why: allowed[0].why};
    const byRule = {choice: allowed[0], by: 'rule', why: `依優先順序：${allowed[0].why}`};
    if (!llm.enabled) return byRule;

    const ids = allowed.map(a => a.id);
    const checkChoice = data => tryValidate(v.object({action_id: v.oneOf(ids), reason: v.string({max: 200})}), data);
    const res = await llm.completeJson({
      purpose: 'next_action',
      system: CHOOSE_SYSTEM,
      user: JSON.stringify({
        目標: pseudonymize(state.goal, personNames()).value,
        已完成步驟數: state.stepCount,
        能力缺口: state.gaps.map(g => ({技能: g.name, 狀態: g.status})),
        需要指導老師: state.advisor.needed,
        可選動作: allowed.map(a => ({id: a.id, 說明: a.label, 理由: a.why})),
      }),
      schema: {
        type: 'object',
        properties: {action_id: {type: 'string', enum: ids}, reason: {type: 'string'}},
        required: ['action_id', 'reason'],
        additionalProperties: false,
      },
      validate: data => {
        const r = checkChoice(data);
        return r.ok ? {ok: true} : {ok: false, reason: r.error};
      },
    });
    ctx.recordLlm(res);
    const parsed = res.ok ? checkChoice(res.data) : {ok: false, error: res.error};
    if (!parsed.ok) {
      ctx.trace.emit('fallback', `LLM 選擇下一步不可用（${parsed.error}），改依規則優先順序`, {agent: 'orchestrator'});
      return byRule;
    }
    const choice = allowed.find(a => a.id === parsed.value.action_id);
    // 模型給的理由是自由文字，未通過檢核就改用政策內建的說明
    return {choice, by: 'llm', why: checkShortReason(parsed.value.reason) ? parsed.value.reason : choice.why};
  }

  /**
   * 產生給學生的建議文字。LLM 版本必須通過事實檢核，否則使用範本。
   * @param {object} facts 規則算出的事實
   * @param {string} template 範本文字（一定可用）
   * @param {string[]} knownNames 資料庫中所有人名與競賽名（用於檢核）
   */
  async function narrate(facts, template, knownNames, ctx) {
    if (!llm.enabled) return {text: template, source: 'template'};
    // 個資保護：人名換成代號再送出；模型的回覆在本機換回人名後，才做事實檢核
    const masked = pseudonymize(facts, [...namesInFacts(facts), ...personNames()]);
    const verify = data => {
      if (typeof data?.text !== 'string') return {ok: false, reason: '缺少 text'};
      const restored = masked.restore(data.text);
      if (hasLeftoverCode(restored)) return {ok: false, reason: '出現不存在的人員代號'};
      return checkGrounding(restored, facts, knownNames);
    };
    const res = await llm.completeJson({
      purpose: 'narrative',
      system: NARRATE_SYSTEM,
      user: `<事實>\n${JSON.stringify(masked.value)}\n</事實>`,
      schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false},
      validate: verify,
    });
    ctx.recordLlm(res);
    const text = res.ok ? masked.restore(res.data.text) : null;
    const check = res.ok ? verify(res.data) : {ok: false, reason: res.error};
    ctx.trace.emit('output_check', check.ok ? '生成說明通過事實檢核' : `生成說明未通過檢核（${check.reason}），改用範本`, {agent: 'orchestrator', data: {ok: check.ok}});
    return check.ok ? {text, source: 'llm'} : {text: template, source: 'template'};
  }

  return Object.freeze({choose, narrate});
}
