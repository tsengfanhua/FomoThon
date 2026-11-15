// 多模型路由測試：模型鏈升級（呼叫失敗、未通過檢核）、雲端前的個資遮蔽、人名代號化、設定載入。
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createBrain} from '../src/agents/brain.js';
import {createTrace} from '../src/trace.js';
import {loadConfig} from '../src/config.js';
import {createFakeChain, createFakeLlm, createLlm, locationOf} from '../src/llm/index.js';
import {interpolate, resolveEndpoint} from '../src/llm/router.js';
import {hasLeftoverCode, pseudonymize, redactPii} from '../src/safety/privacy.js';
import {drive, makeApp, student} from './helpers.js';

const ctx = () => ({trace: createTrace(null, null), recordLlm: () => {}});
const request = extra => ({purpose: 'intent', system: 's', user: 'u', schema: {type: 'object'}, ...extra});

test('模型鏈：第一個模型呼叫失敗就改用下一個，成本與 token 累計', async () => {
  const chain = createFakeChain([
    {name: 'small', respond: () => ({stop: 'LLM_RATE_LIMIT'})},
    {name: 'large', respond: () => ({answer: 42}), price: {in: 1, out: 1}},
  ]);
  const res = await chain.completeJson(request());
  assert.equal(res.ok, true);
  assert.equal(res.model, 'large');
  assert.equal(res.escalated, true);
  assert.deepEqual(res.attempts.map(a => [a.model, a.ok, a.error]), [['small', false, 'LLM_RATE_LIMIT'], ['large', true, null]]);
  assert.deepEqual(res.usage, {input: 100, output: 20});
  assert.equal(res.costUsd, 0.00012);
});

test('模型鏈：輸出未通過檢核也會升級；全部未通過則回報失敗', async () => {
  const chain = createFakeChain([
    {name: 'small', respond: () => ({intent: 'hack'})},
    {name: 'large', respond: () => ({intent: 'inventory'})},
  ]);
  const validate = data => (data.intent === 'inventory' ? {ok: true} : {ok: false, reason: '不在列舉值內'});
  const res = await chain.completeJson(request({validate}));
  assert.equal(res.model, 'large');
  assert.deepEqual(res.attempts[0], {...res.attempts[0], ok: false, error: 'VALIDATION_FAILED', reason: '不在列舉值內'});
  const none = await chain.completeJson(request({validate: () => ({ok: false, reason: 'x'})}));
  assert.equal(none.ok, false);
  assert.equal(none.error, 'VALIDATION_FAILED');
  const thrown = await chain.completeJson(request({validate: () => { throw new Error('bug'); }}));
  assert.equal(thrown.attempts[0].reason, 'VALIDATOR_ERROR', '檢核函式本身出錯不會讓系統當掉');
});

test('個資遮蔽：雲端端點只收到遮蔽後的文字，地端端點收到原文', async () => {
  const seen = {};
  const chain = createFakeChain([
    {name: 'cloud', location: 'cloud', respond: req => { seen.cloud = req.user; return {stop: 'LLM_NETWORK'}; }},
    {name: 'campus', location: 'local', respond: req => { seen.local = req.user; return {ok: 1}; }},
  ]);
  const raw = '我是 D1234567，信箱 amy@example.com，電話 0912-345-678，身分證 A123456789，想找 AI 競賽';
  const res = await chain.completeJson(request({user: raw}));
  assert.equal(seen.cloud, '我是 〔學號〕，信箱 〔Email〕，電話 〔電話〕，身分證 〔身分證字號〕，想找 AI 競賽');
  assert.equal(seen.local, raw);
  assert.deepEqual(res.attempts.map(a => a.redactions), [4, 0]);
});

test('redactPii：常見個資格式；一般數字與課程代碼不受影響', () => {
  const r = redactPii('市話 (02) 不算、02-2345-6789 算；+886 912 345 678；CS101 拿 92 分；TOEIC 650；2026-11-21');
  assert.equal(r.text, '市話 (02) 不算、〔電話〕 算；〔電話〕；CS101 拿 92 分；TOEIC 650；2026-11-21');
  assert.deepEqual(r.counts, {mobile: 1, landline: 1});
});

test('pseudonymize：人名換成代號、可還原；長名字優先避免部分取代', () => {
  const facts = {可邀請隊友: [{姓名: '小禾', 補位技能: 'UI'}, {姓名: '小禾子', 補位技能: 'Figma'}], 備註: '小禾子和小禾都可以'};
  const masked = pseudonymize(facts, ['小禾', '小禾子', '小']);
  assert.ok(!JSON.stringify(masked.value).includes('小禾'));
  assert.equal(masked.value.備註, '〔人員1〕和〔人員2〕都可以');
  assert.equal(masked.restore('建議先邀請〔人員2〕。'), '建議先邀請小禾。');
  assert.equal(hasLeftoverCode(masked.restore('〔人員9〕也不錯')), true);
});

test('說明文字：人名不送出；模型照抄代號可還原，自創代號則改用範本', async () => {
  const facts = {意圖: '找隊友', 可邀請隊友: [{姓名: '小禾', 補位技能: 'UI 介面設計', 媒合分數: 84}], 可邀請教師: [], 尚未補齊的缺口: [], 查詢失敗: []};
  const sent = [];
  const good = createBrain({llm: createFakeLlm(req => { sent.push(req.user); return {text: '建議先邀請〔人員1〕補位 UI 介面設計，邀請要由你確認後才會送出。'}; })});
  const out = await good.narrate(facts, '範本', ['小禾', '阿哲'], ctx());
  assert.equal(out.source, 'llm');
  assert.equal(out.text, '建議先邀請小禾補位 UI 介面設計，邀請要由你確認後才會送出。');
  assert.ok(!sent[0].includes('小禾'), '人名沒有送到模型');
  const rogue = createBrain({llm: createFakeLlm(() => ({text: '建議邀請〔人員3〕，邀請要由你確認後才會送出。'}))});
  assert.equal((await rogue.narrate(facts, '範本', ['小禾'], ctx())).source, 'template');
});

test('設定：FOMO_LLM_PROFILE 載入路由表，環境變數可覆寫模型名稱與位址', () => {
  const tiered = loadConfig({FOMO_LLM_PROFILE: 'claude-tiered'}).llm;
  assert.deepEqual(tiered.routes.intent, ['claude-haiku', 'claude-sonnet']);
  assert.equal(tiered.endpoints['claude-haiku'].model, 'claude-haiku-5-5');
  const hybrid = loadConfig({FOMO_LLM_PROFILE: 'hybrid', FOMO_LOCAL_MODEL: 'llama3.1:8b', FOMO_LOCAL_BASE_URL: 'http://10.0.0.5:8000/v1'}).llm;
  assert.equal(hybrid.endpoints.local.model, 'llama3.1:8b');
  assert.equal(hybrid.endpoints.local.baseUrl, 'http://10.0.0.5:8000/v1');
  assert.equal(hybrid.endpoints.local.location, 'local');
  assert.throws(() => loadConfig({FOMO_LLM_PROFILE: 'gpt-everything'}), /FOMO_LLM_PROFILE 必須是/);
  assert.equal(interpolate('${A:-x}/${B:-y}', {A: '1'}), '1/y');
  assert.throws(() => resolveEndpoint('bad', {provider: 'openai-compatible', model: 'm', price: {in: 'abc', out: '1'}}, {}, 1000), /單價格式錯誤/);
  assert.equal(resolveEndpoint('np', {provider: 'openai-compatible', model: 'm', price: {in: '', out: ''}}, {}, 1000).price, null);
  assert.equal(locationOf('http://192.168.1.20:11434/v1'), 'local');
  assert.equal(locationOf('https://api.openai.com/v1'), 'cloud');
});

test('路由器：以注入的端點工廠建立，describe() 列出每個用途的模型鏈', async () => {
  const cfg = loadConfig({FOMO_LLM_PROFILE: 'claude-tiered'}).llm;
  const factory = async endpoint => createFakeLlm(() => ({ok: true}), {model: endpoint.model});
  const router = await createLlm(cfg, {factory});
  assert.equal(router.provider, 'profile:claude-tiered');
  assert.deepEqual(router.describe().routes.syllabus_extract.map(r => r.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  assert.deepEqual([...router.models].sort(), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  await assert.rejects(() => createLlm({profile: 'x', routes: {default: ['ghost']}, endpoints: {}}, {factory}), /不存在的端點/);
});

test('端對端：小模型輸出不合格時，任務辨識升級到大模型，執行紀錄寫出升級過程', async () => {
  const chain = createFakeChain([
    {name: 'haiku-like', respond: req => (req.purpose === 'intent' ? {intent: 'not_an_intent', skill_ids: [], competition_id: '', reason: ''} : {stop: 'LLM_NETWORK'})},
    {name: 'sonnet-like', respond: req => (req.purpose === 'intent' ? {intent: 'find_competition', skill_ids: ['SK-PRG-002'], competition_id: '', reason: 'x'} : {stop: 'LLM_NETWORK'})},
  ]);
  const app = await makeApp({llm: chain});
  try {
    const snap = await drive(app, student('S14'), '有沒有適合我的 Java 活動');
    assert.equal(snap.intent.source, 'llm');
    assert.equal(snap.intent.type, 'find_competition');
    const call = snap.events.find(e => e.type === 'llm_call' && e.data.purpose === 'intent');
    assert.equal(call.data.escalated, true);
    assert.match(call.summary, /haiku-like（未通過檢核） → sonnet-like 通過/);
  } finally {
    app.close();
  }
});
