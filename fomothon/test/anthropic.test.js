// Anthropic 介面測試：以模擬伺服器驗證官方 SDK 的請求內容與回應解析。
// 需要已安裝 @anthropic-ai/sdk（選用相依）；未安裝時自動略過。
import assert from 'node:assert/strict';
import http from 'node:http';
import {test} from 'node:test';
import {loadConfig} from '../src/config.js';
import {createLlm} from '../src/llm/index.js';
import {baseEnv} from './helpers.js';

const sdkInstalled = await import('@anthropic-ai/sdk').then(() => true, () => false);

test('Anthropic 介面：結構化輸出請求、用量、拒答與錯誤處理', {skip: sdkInstalled ? false : '未安裝 @anthropic-ai/sdk'}, async () => {
  const seen = [];
  let mode = 'ok';
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({url: req.url, credential: req.headers['x-api-key'] ?? req.headers.authorization ?? '', beta: req.headers['anthropic-beta'], body: JSON.parse(Buffer.concat(chunks).toString('utf8'))});
    res.setHeader('content-type', 'application/json');
    if (mode === 'unauthorized') {
      res.statusCode = 401;
      return res.end(JSON.stringify({type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}}));
    }
    const base = {id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null, usage: {input_tokens: 500, output_tokens: 100}};
    if (mode === 'refusal') return res.end(JSON.stringify({...base, content: [], stop_reason: 'refusal'}));
    if (mode === 'max_tokens') return res.end(JSON.stringify({...base, content: [{type: 'text', text: '{"te'}], stop_reason: 'max_tokens'}));
    return res.end(JSON.stringify({...base, stop_reason: 'end_turn', content: [{type: 'thinking', thinking: '', signature: 'sig'}, {type: 'text', text: '{"text":"建議先完成能力盤點。"}'}]}));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const previous = {base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY};
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  try {
    const llm = await createLlm(loadConfig({...baseEnv, FOMO_LLM_PROVIDER: 'anthropic'}).llm);
    assert.equal(llm.model, 'claude-opus-5-5');
    const schema = {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false};
    const ok = await llm.completeJson({purpose: 'narrative', system: '系統提示', user: '使用者內容', schema});
    assert.equal(ok.ok, true);
    assert.equal(ok.data.text, '建議先完成能力盤點。');
    assert.deepEqual(ok.usage, {input: 500, output: 100});
    assert.equal(ok.costUsd, 0.004); // 500×4 + 100×20 美元／百萬 token

    const sent = seen[0];
    assert.match(sent.url, /^\/v1\/messages/);
    assert.ok(sent.credential.includes('test-key'), '金鑰由 SDK 自環境讀取並帶入請求');
    assert.match(sent.beta, /server-side-fallback-2026-07-01/);
    assert.equal(sent.body.model, 'claude-opus-5-5');
    assert.equal(sent.body.fallbacks, 'default');
    assert.equal(sent.body.system, '系統提示');
    assert.deepEqual(sent.body.output_config, {effort: 'low', format: {type: 'json_schema', schema}});
    assert.deepEqual(sent.body.messages, [{role: 'user', content: '使用者內容'}]);
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(banned in sent.body), `不應傳送 ${banned}`);

    for (const [m, error] of [['refusal', 'LLM_REFUSAL'], ['max_tokens', 'LLM_TRUNCATED'], ['unauthorized', 'LLM_AUTH']]) {
      mode = m;
      const res = await llm.completeJson({purpose: 'narrative', system: 's', user: 'u', schema});
      assert.equal(res.ok, false, m);
      assert.equal(res.error, error, m);
    }

    // Haiku 5.5 沒有伺服器端拒答備援：不可傳 fallbacks，也不送該 beta 標頭；Sonnet 5.5 則要帶
    mode = 'ok';
    const tiered = await createLlm(loadConfig({...baseEnv, FOMO_LLM_PROFILE: 'claude-tiered'}).llm);
    const before = seen.length;
    await tiered.completeJson({purpose: 'intent', system: 's', user: 'u', schema});
    await tiered.completeJson({purpose: 'narrative', system: 's', user: 'u', schema});
    const [haiku, sonnet] = seen.slice(before);
    assert.equal(haiku.body.model, 'claude-haiku-5-5');
    assert.ok(!('fallbacks' in haiku.body), 'Haiku 不可帶 fallbacks');
    assert.doesNotMatch(haiku.beta ?? '', /server-side-fallback/);
    assert.deepEqual(haiku.body.output_config, {effort: 'low', format: {type: 'json_schema', schema}});
    assert.equal(sonnet.body.model, 'claude-sonnet-5-5');
    assert.equal(sonnet.body.fallbacks, 'default');
    assert.match(sonnet.beta, /server-side-fallback-2026-07-01/);
  } finally {
    if (previous.base === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous.key;
    await new Promise(resolve => mock.close(resolve));
  }
});
