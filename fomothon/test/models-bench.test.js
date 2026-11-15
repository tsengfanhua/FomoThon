// 多模型評比工具測試：錄製的請求要完整，重播後的計分要用系統原本的檢核。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {benchmark, captureRequests, renderModelsMarkdown} from '../eval/models.js';
import {ROOT} from '../src/config.js';
import {createFakeLlm} from '../src/llm/index.js';

const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8'));

test('多模型評比：錄製實際請求後重播，以系統原本的檢核計分', async () => {
  const captured = await captureRequests(spec);
  const count = task => captured.items.filter(i => i.task === task).length;
  assert.equal(count('intent'), spec.intents.length);
  assert.equal(count('extract'), 24);
  assert.ok(count('narrative') >= 10 && count('next_action') >= 5);
  assert.ok(captured.items.every(i => typeof i.request.validate === 'function'), '每個請求都帶著檢核函式');
  assert.ok(captured.rule.intentAccuracy > 0.8 && captured.rule.extraction.f1 > 0.7);

  // 假模型：辨識一律回答 find_competition；萃取只對 CS101 給得出原文出處；下一步選第一個合法動作；說明不含數字與人名
  const fake = createFakeLlm(req => {
    if (req.purpose === 'intent') return {intent: 'find_competition', skill_ids: [], competition_id: '', reason: 'x'};
    if (req.purpose === 'syllabus_extract') return {skills: [{skill_id: 'SK-PRG-001', quote: 'Python 變數與資料型別'}]};
    if (req.purpose === 'next_action') return {action_id: req.schema.properties.action_id.enum[0], reason: '先處理這一步'};
    return {text: '請先看過推薦理由，邀請要由你確認後才會送出。'};
  });
  const r = await benchmark(fake, captured);
  const expectedAccuracy = Math.round((spec.intents.filter(([, label]) => label === 'find_competition').length / spec.intents.length) * 1000) / 1000;
  assert.equal(r.intent.accuracy, expectedAccuracy);
  assert.equal(r.extract.proposed, 24);
  assert.equal(r.extract.rejected, 23, '只有 CS101 的出處是原文，其餘都被丟棄');
  assert.equal(r.extract.llm.tp, 1);
  assert.equal(r.nextAction.valid, 1);
  assert.equal(r.narrative.grounded, 1);
  assert.ok(r.latencyMs.p95 >= r.latencyMs.p50);

  const md = renderModelsMarkdown({generatedAt: 'now', requests: captured.items.length, counts: {intent: 18, extract: 24, next_action: 12, narrative: 19}, rule: captured.rule, runs: [{...r, label: 'fake', location: '雲端', priced: false}]});
  assert.match(md, /\| 規則（離線基準） \|/);
  assert.match(md, /\| fake \| 雲端 \|/);
});
