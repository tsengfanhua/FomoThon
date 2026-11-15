// 多模型評比：先把系統「實際會送出的請求」（含檢核函式）錄下來，再對每個模型重播，用同一套檢核計分。
// 四項任務：任務辨識（有標準答案）、課綱技能萃取（對照共識標準答案）、協調器的下一步選擇（是否合法）、
// 建議說明（是否通過事實檢核；人名已代號化）。另附規則式的基準。
// 用法：
//   node eval/models.js --dry-run                              只錄製請求並列出數量，不呼叫任何模型
//   node eval/models.js --endpoints claude-haiku,claude-sonnet  逐一評比 config/models.json 的端點
//   node eval/models.js --profiles claude-tiered,claude         評比整組路由（含模型鏈升級）
// 會呼叫真實模型並產生費用；金鑰從 .env 讀取。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseIntent, parseIntentByRule} from '../src/agents/intent.js';
import {createApp} from '../src/app.js';
import {ROOT, loadConfig} from '../src/config.js';
import {listPersonNames} from '../src/db.js';
import {extractSkills, extractWithLlm, mergeExtractions, verifyLlmItems} from '../src/inventory/extractor.js';
import {createFakeLlm} from '../src/llm/index.js';
import {createRouter, resolveEndpoint} from '../src/llm/router.js';
import {checkGoal} from '../src/safety/guard.js';
import {createTrace} from '../src/trace.js';
import {buildGold, loadAnnotations, scoreExtraction} from './extraction.js';

const TODAY = '2026-11-21';
const TERMINAL = new Set(['completed', 'stopped', 'blocked', 'cancelled', 'clarify']);
const CONCURRENCY = 4;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const quiet = () => ({trace: createTrace(null, null), recordLlm: () => {}, faults: {}});

/** 錄音用的假模型：記下請求後回報失敗，系統因此走規則路徑（與離線模式相同的流程）。 */
function recorder() {
  const captured = [];
  const llm = createFakeLlm(request => {
    captured.push(request);
    return {stop: 'LLM_DISABLED'};
  }, {location: 'local'});
  return {llm, captured};
}

async function freshApp(llm) {
  return createApp(loadConfig({FOMO_DB_PATH: ':memory:', FOMO_SYLLABUS_MODE: 'local', FOMO_TODAY: TODAY, FOMO_LLM_PROVIDER: 'none'}), {llm});
}

async function drive(app, userId, goal, faults) {
  const user = {id: userId, role: 'student', name: userId};
  const o = app.orchestrator;
  let snap = await o.createRun(user, goal, {faults});
  for (let i = 0; i < 40 && !TERMINAL.has(snap.status); i += 1) {
    if (snap.status === 'awaiting_user') {
      if (snap.pending.type !== 'confirm_profile') return snap;
      snap = o.confirm(user, snap.id, {type: 'confirm_profile'});
    } else {
      snap = await o.step(user, snap.id);
    }
  }
  return snap;
}

/** 任務辨識：輸入防護先擋下的句子不會送到模型，所以不列入。 */
async function captureIntents(app, rec, spec) {
  const deps = {llm: rec.llm, skills: app.skills, competitions: app.competition.list(), personNames: listPersonNames(app.db)};
  const items = [];
  let ruleHits = 0;
  for (const [text, expected] of spec.intents) {
    const guard = checkGoal(text);
    if (!guard.ok) continue;
    if (parseIntentByRule(guard.goal, deps).type === expected) ruleHits += 1;
    const before = rec.captured.length;
    await parseIntent(guard.goal, deps, quiet());
    items.push({task: 'intent', id: `intent:${items.length + 1}`, request: rec.captured[before], expected});
  }
  return {items, ruleAccuracy: items.length ? round(ruleHits / items.length) : null};
}

/** 與正式流程相同：經課綱爬蟲取得（已清理、含品質旗標）的課綱，而不是資料庫原文。 */
export async function fetchCourses(app) {
  const codes = app.db.prepare('SELECT code FROM courses ORDER BY code').all().map(r => r.code);
  const courses = [];
  for (const code of codes) {
    const fetched = await app.tools.call(quiet(), 'syllabus.fetch', {code});
    if (!fetched.ok) throw new Error(`無法取得 ${code} 的課綱（${fetched.error.code}）`);
    courses.push(fetched.result);
  }
  return courses;
}

async function captureExtractions(app, rec) {
  const courses = await fetchCourses(app);
  const gold = buildGold(loadAnnotations(), courses.map(c => c.code));
  const items = [];
  const rulePred = {};
  for (const course of courses) {
    const before = rec.captured.length;
    await extractWithLlm(course, app.skills, rec.llm, app.config.rules);
    const rule = extractSkills(course, app.skills, app.config.rules);
    rulePred[course.code] = rule.map(i => i.skillId);
    items.push({task: 'extract', id: `extract:${course.code}`, request: rec.captured[before], course, rule});
  }
  return {items, gold, rule: scoreExtraction(rulePred, gold).micro};
}

/** 情境任務：跑一遍參賽準備等情境，錄下協調器的下一步選擇與最後的說明文字。 */
async function captureScenarios(spec) {
  const items = [];
  for (const tc of spec.cases.filter(c => c.category !== '安全')) {
    const scenario = recorder();
    const app = await freshApp(scenario.llm);
    try {
      await drive(app, tc.user, tc.goal, tc.faults ?? undefined);
    } finally {
      app.close();
    }
    scenario.captured.filter(r => r.purpose === 'next_action' || r.purpose === 'narrative')
      .forEach((request, i) => items.push({task: request.purpose, id: `${request.purpose}:${tc.id}:${i + 1}`, request}));
  }
  return items;
}

/**
 * 錄製四項任務的請求（含檢核函式），供每個模型重播。
 * @returns {Promise<{items:Array<object>, gold:object, ctx:object, rule:object}>}
 */
export async function captureRequests(spec) {
  const rec = recorder();
  const app = await freshApp(rec.llm);
  try {
    const intents = await captureIntents(app, rec, spec);
    const extraction = await captureExtractions(app, rec);
    const scenarios = await captureScenarios(spec);
    return {
      items: [...intents.items, ...extraction.items, ...scenarios],
      gold: extraction.gold,
      ctx: {skills: app.skills, rules: app.config.rules}, // Skill 資料庫已載入記憶體，關閉資料庫後仍可使用
      rule: {intentAccuracy: intents.ruleAccuracy, extraction: extraction.rule},
    };
  } finally {
    app.close();
  }
}

async function pool(list, worker) {
  const results = new Array(list.length);
  let next = 0;
  const run = async () => {
    for (let i = next++; i < list.length; i = next++) results[i] = await worker(list[i]);
  };
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, list.length)}, run));
  return results;
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** 對一個模型（或一組路由）重播全部請求並計分。 */
export async function benchmark(llm, captured) {
  const {items, gold, ctx} = captured;
  const responses = await pool(items, item => llm.completeJson(item.request));
  const byTask = task => items.map((item, i) => ({item, res: responses[i]})).filter(x => x.item.task === task);

  const intent = byTask('intent');
  const extract = byTask('extract');
  const llmPred = {};
  const merged = {};
  const both = {};
  let proposed = 0;
  let rejected = 0;
  for (const {item, res} of extract) {
    // 模型鏈中途被丟棄的輸出（含升級前的小模型）也要算進「提出」與「被丟棄」
    const itemsOf = output => (Array.isArray(output?.skills) ? output.skills.filter(x => x && typeof x === 'object') : []);
    const discarded = (res.rejectedOutputs ?? []).flatMap(itemsOf);
    const final = res.ok ? itemsOf(res.data) : [];
    const accepted = res.ok ? verifyLlmItems(final, item.course, ctx.skills, ctx.rules) : [];
    proposed += discarded.length + final.length;
    rejected += discarded.length + final.length - accepted.length;
    llmPred[item.course.code] = accepted.map(a => a.skillId);
    merged[item.course.code] = mergeExtractions(item.rule, accepted, ctx.rules).map(a => a.skillId);
    both[item.course.code] = item.rule.map(r => r.skillId).filter(id => llmPred[item.course.code].includes(id));
  }
  const rate = list => (list.length ? round(list.filter(x => x.res.ok).length / list.length) : null);
  const ms = responses.map(r => r.ms);
  return {
    model: llm.model,
    requests: items.length,
    intent: {n: intent.length, valid: rate(intent), accuracy: intent.length ? round(intent.filter(x => x.res.ok && x.res.data.intent === x.item.expected).length / intent.length) : null},
    extract: {
      n: extract.length, valid: rate(extract), proposed, rejected, hallucinationRate: proposed ? round(rejected / proposed) : 0,
      llm: scoreExtraction(llmPred, gold).micro, merged: scoreExtraction(merged, gold).micro, intersection: scoreExtraction(both, gold).micro,
    },
    nextAction: {n: byTask('next_action').length, valid: rate(byTask('next_action'))},
    narrative: {n: byTask('narrative').length, grounded: rate(byTask('narrative'))},
    escalations: responses.filter(r => r.escalated).length,
    errors: Object.fromEntries(Object.entries(Map.groupBy(responses.filter(r => !r.ok), r => r.error)).map(([k, v]) => [k, v.length])),
    latencyMs: {p50: percentile(ms, 50), p95: percentile(ms, 95)},
    tokens: {input: responses.reduce((a, r) => a + r.usage.input, 0), output: responses.reduce((a, r) => a + r.usage.output, 0)},
    costUsd: round(responses.reduce((a, r) => a + (r.costUsd ?? 0), 0), 4),
  };
}

const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 1000) / 10}%`);

export function renderModelsMarkdown(result) {
  const rows = result.runs.map(r => `| ${r.label} | ${r.location} | ${pct(r.intent.accuracy)} | ${pct(r.extract.llm.f1)} | ${pct(r.extract.merged.f1)} | ${pct(r.extract.intersection.precision)} | ${pct(r.extract.hallucinationRate)} | ${pct(r.nextAction.valid)} | ${pct(r.narrative.grounded)} | ${r.latencyMs.p50}／${r.latencyMs.p95} ms | ${r.priced ? `US$${r.costUsd}` : '—'} |`);
  return [
    '# 多模型評比', '',
    `- 產生時間：${result.generatedAt}；請求共 ${result.requests} 個（任務辨識 ${result.counts.intent}、課綱萃取 ${result.counts.extract}、下一步選擇 ${result.counts.next_action}、建議說明 ${result.counts.narrative}）`,
    '- 方法：先以錄音模式跑一遍系統，錄下實際送出的請求與檢核函式；再把同一批請求送給每個模型，以系統原本的檢核計分。',
    '- 規則基準：任務辨識用規則式分類；萃取用別名比對；下一步與說明使用政策與範本（設計上一定合法、一定符合事實）。', '',
    '| 模型／路由 | 位置 | 任務辨識正確率 | 萃取 F1（LLM 單獨） | 萃取 F1（規則＋LLM） | 雙重確認的 Precision | 萃取幻覺率 | 下一步合法率 | 說明通過事實檢核 | 延遲 p50／p95 | 成本 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| 規則（離線基準） | 本機 | ${pct(result.rule.intentAccuracy)} | — | ${pct(result.rule.extraction.f1)} | ${pct(result.rule.extraction.precision)} | 0% | 100% | 100%（範本） | — | US$0 |`,
    ...rows, '',
    '- 萃取幻覺率＝模型提出、但技能不在指標庫內或出處不是課綱原文而被丟棄的比例。',
    '- 雙重確認的 Precision＝規則與 LLM 都選到的技能中，屬於標準答案的比例（評估「用 LLM 複核規則結果」的效果）。', '',
  ].join('\n');
}

function argList(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

async function targetsFrom(env) {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'models.json'), 'utf8'));
  const timeoutMs = Number(env.FOMO_LLM_TIMEOUT_MS) || 60000;
  const endpointOf = name => {
    if (!catalog.endpoints[name]) throw new Error(`config/models.json 沒有端點 ${name}`);
    return resolveEndpoint(name, catalog.endpoints[name], env, timeoutMs);
  };
  const targets = [];
  for (const name of argList('--endpoints')) {
    const ep = endpointOf(name);
    targets.push({label: `${name}（${ep.model}）`, location: ep.location === 'local' ? '地端' : '雲端', priced: Boolean(ep.price), build: () => createRouter({routes: {default: [name]}, endpoints: {[name]: ep}, label: ep.model, provider: name})});
  }
  for (const name of argList('--profiles')) {
    const profile = catalog.profiles[name];
    if (!profile) throw new Error(`config/models.json 沒有路由 ${name}`);
    const used = [...new Set(Object.values(profile.routes).flat())];
    const endpoints = Object.fromEntries(used.map(n => [n, endpointOf(n)]));
    const locations = new Set(Object.values(endpoints).map(e => e.location));
    targets.push({label: `路由 ${name}`, location: locations.size > 1 ? '混合' : locations.has('local') ? '地端' : '雲端', priced: Object.values(endpoints).every(e => e.price), build: () => createRouter({routes: profile.routes, endpoints, label: name, provider: `profile:${name}`})});
  }
  return targets;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8'));
  const captured = await captureRequests(spec);
  const counts = Object.fromEntries(['intent', 'extract', 'next_action', 'narrative'].map(t => [t, captured.items.filter(i => i.task === t).length]));
  process.stdout.write(`已錄製 ${captured.items.length} 個請求：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、')}\n`);
  const targets = process.argv.includes('--dry-run') ? [] : await targetsFrom(process.env);
  if (!targets.length) {
    process.stdout.write('沒有指定 --endpoints 或 --profiles（或使用了 --dry-run），不呼叫模型。\n');
  } else {
    const runs = [];
    for (const target of targets) {
      process.stdout.write(`評比 ${target.label} …\n`);
      const result = await benchmark(await target.build(), captured);
      runs.push({...result, label: target.label, location: target.location, priced: target.priced});
      process.stdout.write(`  任務辨識 ${pct(result.intent.accuracy)}｜萃取 F1 ${pct(result.extract.llm.f1)}（合併 ${pct(result.extract.merged.f1)}）｜說明通過 ${pct(result.narrative.grounded)}｜US$${result.costUsd}\n`);
    }
    const output = {generatedAt: new Date().toISOString(), requests: captured.items.length, counts, rule: captured.rule, runs};
    const dir = path.join(ROOT, 'eval', 'results');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'models.json'), `${JSON.stringify(output, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'MODELS.md'), renderModelsMarkdown(output));
    process.stdout.write('結果已寫入 eval/results/models.json 與 MODELS.md\n');
  }
}
