// 課綱技能萃取的準確度評測（資料品質 × 模型評比）。
// 標準答案：兩位獨立標註者分別閱讀課綱標註「實際教授的技能」；兩人都標的算正例，只有一人標的列為模糊項（不計分）。
// 指標：標註者間一致性（Cohen's κ）、萃取器的 Precision／Recall／F1（微平均與巨平均），以及逐課的誤判清單。
// 用法：
//   node eval/extraction.js              規則萃取（離線、可重現）
//   node eval/extraction.js --llm        另外評測 LLM 萃取與「規則＋LLM」合併（依 .env 的模型設定，會呼叫真實模型）
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {extractSkills, extractWithLlm, mergeExtractions} from '../src/inventory/extractor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = path.join(HERE, 'gold');
const RESULTS = path.join(HERE, 'results');
const round3 = v => Math.round(v * 1000) / 1000;

export function loadAnnotations(dir = path.join(GOLD_DIR, 'annotations')) {
  return fs.readdirSync(dir).filter(f => /^annotator-.+\.json$/.test(f)).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

const labelSet = (annotation, code) => new Set((annotation.labels[code] ?? []).map(l => l.skill_id));

/** 共識標準答案：全體標註者都標的算正例；部分標註者標的列為模糊項。 */
export function buildGold(annotations, courseCodes) {
  return Object.fromEntries(courseCodes.map(code => {
    const sets = annotations.map(a => labelSet(a, code));
    const union = new Set(sets.flatMap(s => [...s]));
    const positive = [...union].filter(id => sets.every(s => s.has(id))).sort();
    const ambiguous = [...union].filter(id => !positive.includes(id)).sort();
    return [code, {skills: positive, ambiguous}];
  }));
}

/** 兩位標註者在「課程 × 技能」二元矩陣上的 Cohen's κ。 */
export function cohenKappa(a, b, courseCodes, skillIds) {
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  let neither = 0;
  for (const code of courseCodes) {
    const sa = labelSet(a, code);
    const sb = labelSet(b, code);
    for (const id of skillIds) {
      if (sa.has(id) && sb.has(id)) both += 1;
      else if (sa.has(id)) onlyA += 1;
      else if (sb.has(id)) onlyB += 1;
      else neither += 1;
    }
  }
  const n = both + onlyA + onlyB + neither;
  const observed = (both + neither) / n;
  const pa = (both + onlyA) / n;
  const pb = (both + onlyB) / n;
  const expected = pa * pb + (1 - pa) * (1 - pb);
  return {kappa: round3((observed - expected) / (1 - expected)), observedAgreement: round3(observed), both, onlyA, onlyB, neither, pairs: n};
}

const prf = (tp, fp, fn) => {
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {tp, fp, fn, precision: round3(precision), recall: round3(recall), f1: round3(f1)};
};

/**
 * 依標準答案評分（模糊項不計入正確或錯誤）。
 * @param {Record<string, string[]>} predicted 課程代碼 → 預測的技能 ID
 * @param {Record<string, {skills:string[], ambiguous:string[]}>} gold
 */
export function scoreExtraction(predicted, gold) {
  const perCourse = Object.entries(gold).map(([code, g]) => {
    const truth = new Set(g.skills);
    const skip = new Set(g.ambiguous);
    const guess = new Set((predicted[code] ?? []).filter(id => !skip.has(id)));
    const falsePositives = [...guess].filter(id => !truth.has(id));
    const falseNegatives = [...truth].filter(id => !guess.has(id));
    return {code, ...prf(guess.size - falsePositives.length, falsePositives.length, falseNegatives.length), falsePositives, falseNegatives};
  });
  const total = key => perCourse.reduce((acc, c) => acc + c[key], 0);
  const mean = key => round3(perCourse.reduce((acc, c) => acc + c[key], 0) / perCourse.length);
  return {micro: prf(total('tp'), total('fp'), total('fn')), macro: {precision: mean('precision'), recall: mean('recall'), f1: mean('f1')}, perCourse};
}

/** 與正式盤點相同：經課綱爬蟲取得已清理的課綱（而不是資料庫原文）。 */
async function coursesOf(app) {
  const trace = {emit: () => ({}), runId: null};
  const courses = [];
  for (const {code} of app.db.prepare('SELECT code FROM courses ORDER BY code').all()) {
    const fetched = await app.tools.call({trace, faults: {}}, 'syllabus.fetch', {code});
    if (!fetched.ok) throw new Error(`無法取得 ${code} 的課綱（${fetched.error.code}）`);
    courses.push(fetched.result);
  }
  return courses;
}

const ids = items => items.map(i => i.skillId);

async function evaluate({useLlm}) {
  if (useLlm) {
    // 先把 .env 載入 process.env，再複製出評測用的環境（反過來會讀不到 .env 的設定）
    try {
      process.loadEnvFile(path.join(HERE, '..', '.env'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const config = loadConfig({...process.env, FOMO_DB_PATH: ':memory:', FOMO_SYLLABUS_MODE: 'local'});
  const app = await createApp(config);
  try {
    const courses = await coursesOf(app);
    const annotations = loadAnnotations();
    const gold = buildGold(annotations, courses.map(c => c.code));
    const agreement = annotations.length === 2 ? cohenKappa(annotations[0], annotations[1], courses.map(c => c.code), app.skills.all().map(s => s.id)) : null;
    const rule = Object.fromEntries(courses.map(c => [c.code, ids(extractSkills(c, app.skills, config.rules))]));
    const methods = {rule: scoreExtraction(rule, gold)};
    let llmInfo = null;
    if (useLlm) {
      if (!app.llm.enabled) throw new Error('--llm 需要先在 .env 設定 FOMO_LLM_PROVIDER');
      const llmOnly = {};
      const merged = {};
      const calls = [];
      for (const c of courses) {
        const items = await extractWithLlm(c, app.skills, app.llm, config.rules, res => calls.push(res));
        llmOnly[c.code] = ids(items);
        merged[c.code] = ids(mergeExtractions(extractSkills(c, app.skills, config.rules), items, config.rules));
      }
      methods.llm = scoreExtraction(llmOnly, gold);
      methods.ruleLlm = scoreExtraction(merged, gold);
      llmInfo = {
        provider: app.llm.provider, model: app.llm.model, calls: calls.length, failures: calls.filter(r => !r.ok).length,
        costUsd: round3(calls.reduce((acc, r) => acc + (r.costUsd ?? 0), 0)), ms: calls.reduce((acc, r) => acc + (r.ms ?? 0), 0),
      };
    }
    return {
      generatedAt: new Date().toISOString(), courses: courses.length,
      gold: {
        method: '共識標註：全體標註者都標註的技能為正例；只有部分標註者標註的列為模糊項，不計入對錯',
        annotators: annotations.map(a => a.annotator), positives: Object.values(gold).reduce((acc, g) => acc + g.skills.length, 0),
        ambiguous: Object.values(gold).reduce((acc, g) => acc + g.ambiguous.length, 0), agreement,
        note: '目前兩位標註者皆為彼此獨立的 AI 標註（不同模型、不共享脈絡），屬預標註；正式評測前應由兩位教師複核並以同一程式重算。',
      },
      maxSkillsPerCourse: config.rules.course.maxSkillsPerCourse,
      methods, llm: llmInfo, goldLabels: gold,
    };
  } finally {
    app.close();
  }
}

const pct = v => `${Math.round(v * 1000) / 10}%`;

export function renderExtractionMarkdown(r, skillName = id => id) {
  const row = (label, m) => `| ${label} | ${pct(m.micro.precision)} | ${pct(m.micro.recall)} | ${pct(m.micro.f1)} | ${pct(m.macro.f1)} | ${m.micro.tp} | ${m.micro.fp} | ${m.micro.fn} |`;
  const a = r.gold.agreement;
  const lines = [
    '# 課綱技能萃取評測', '',
    `- 課程 ${r.courses} 門；標準答案正例 ${r.gold.positives} 項、模糊項 ${r.gold.ambiguous} 項（${r.gold.method}）`,
    a ? `- 標註者間一致性：Cohen's κ = ${a.kappa}（觀察一致率 ${pct(a.observedAgreement)}；兩人皆標 ${a.both}、只有 A ${a.onlyA}、只有 B ${a.onlyB}，共 ${a.pairs} 個課程 × 技能組合）` : '- 標註者間一致性：需要剛好兩位標註者才計算',
    `- ${r.gold.note}`,
    `- 萃取器每門課最多輸出 ${r.maxSkillsPerCourse} 項技能（標準答案有 6 項的課程，召回率上限因此低於 100%）`, '',
    '| 方法 | Precision | Recall | F1（微平均） | F1（巨平均） | TP | FP | FN |', '|---|---:|---:|---:|---:|---:|---:|---:|',
    row('規則萃取（別名比對＋覆蓋率門檻）', r.methods.rule),
    ...(r.methods.llm ? [row(`LLM 萃取（${r.llm.model}）`, r.methods.llm), row('規則＋LLM 合併（系統實際採用）', r.methods.ruleLlm)] : []),
    '', '## 規則萃取的誤判', '', '| 課程 | 多抓（FP） | 漏抓（FN） |', '|---|---|---|',
    ...r.methods.rule.perCourse.filter(c => c.fp || c.fn)
      .map(c => `| ${c.code} | ${c.falsePositives.map(skillName).join('、') || '—'} | ${c.falseNegatives.map(skillName).join('、') || '—'} |`),
    '',
  ];
  if (r.llm) lines.push(`LLM 呼叫 ${r.llm.calls} 次、失敗 ${r.llm.failures} 次、成本約 US$${r.llm.costUsd}、累計 ${Math.round(r.llm.ms / 1000)} 秒。`, '');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const useLlm = process.argv.includes('--llm');
  const result = await evaluate({useLlm});
  const skills = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'data', 'seed', 'skills.json'), 'utf8')).skills;
  const names = new Map(skills.map(s => [s.id, s.zh]));
  fs.mkdirSync(RESULTS, {recursive: true});
  fs.writeFileSync(path.join(RESULTS, useLlm ? 'extraction-llm.json' : 'extraction.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(RESULTS, useLlm ? 'EXTRACTION-LLM.md' : 'EXTRACTION.md'), renderExtractionMarkdown(result, id => names.get(id) ?? id));
  const m = result.methods.rule.micro;
  process.stdout.write(`規則萃取：P ${pct(m.precision)}／R ${pct(m.recall)}／F1 ${pct(m.f1)}；κ = ${result.gold.agreement?.kappa}\n`);
  if (result.methods.llm) process.stdout.write(`LLM：F1 ${pct(result.methods.llm.micro.f1)}；合併：F1 ${pct(result.methods.ruleLlm.micro.f1)}\n`);
}
