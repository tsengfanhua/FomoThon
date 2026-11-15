// 資料品質模組：執行全部檢核規則 → 各面向分數、總分與閘門 → JSON 報告與 Markdown 報告。
// 用途：(1) 啟動前的資料閘門（有 error 等級的問題就拒絕建庫）；(2) npm run dq 產生報告；(3) MCP 工具 check_data_quality。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, readSeed} from '../config.js';
import {assertSupported} from '../jsonschema.js';
import {CHECKS, DIMENSIONS, prepare} from './checks.js';

export const DQ_VERSION = '2026-11-12';
const SEVERITY_WEIGHT = Object.freeze({error: 3, warning: 1});
const MAX_SAMPLES = 5;
const round1 = v => Math.round(v * 10) / 10;

/** 讀取四份種子資料與資料契約。 */
export function readSeedBundle() {
  return {
    skills: readSeed('skills'),
    courses: readSeed('courses'),
    people: readSeed('people'),
    competitions: readSeed('competitions'),
  };
}

/** 讀取資料契約，並確認每份 Schema 只用到驗證器支援的關鍵字（不支援的關鍵字直接報錯，不會被默默略過）。 */
export function readContracts() {
  const contracts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'schemas', 'seed-entities.json'), 'utf8'));
  return assertContracts(contracts);
}

export function assertContracts(contracts) {
  for (const [kind, schema] of Object.entries(contracts)) if (kind !== '_meta') assertSupported(schema, `資料契約 ${kind}`);
  return contracts;
}

function insightsOf(ctx) {
  const skills = ctx.skills;
  const escoMatch = match => skills.filter(s => (match ? s.esco?.match === match : !s.esco)).length;
  const neededBy = new Map();
  for (const c of ctx.seed.competitions.competitions) for (const n of c.needs) neededBy.set(n.skill, [...(neededBy.get(n.skill) ?? []), c.id]);
  const coursesBySkill = new Map();
  for (const [code, items] of ctx.extracted) for (const item of items) coursesBySkill.set(item.skillId, [...(coursesBySkill.get(item.skillId) ?? []), code]);
  return {
    standardMapping: {
      skills: skills.length,
      esco: {exact: escoMatch('exact'), broader: escoMatch('broader'), narrower: escoMatch('narrower'), related: escoMatch('related'), none: escoMatch(null)},
      onetUnspsc: skills.filter(s => s.onetUnspsc).length,
      sfia: skills.filter(s => s.sfia).length,
      ucan: skills.filter(s => s.ucan).length,
    },
    // 供需對照：競賽需要的技能，在課綱庫裡有幾門課在教（可回饋給系所課程規劃）
    demandSupply: [...neededBy.entries()]
      .map(([skillId, comps]) => ({skillId, name: ctx.byId.get(skillId)?.zh ?? skillId, competitions: comps.length, courses: (coursesBySkill.get(skillId) ?? []).length}))
      .sort((a, b) => b.competitions - a.competitions || a.courses - b.courses || a.skillId.localeCompare(b.skillId)),
    offCatalogEnrollments: ctx.seed.people.students.flatMap(s => s.enrollments.filter(e => !e.code)).length,
  };
}

/**
 * 執行資料品質檢核。
 * @param {object} seed readSeedBundle() 的結果
 * @param {{today:string, rules:object, contracts?:object}} env
 */
export function runDataQuality(seed, {today, rules, contracts = readContracts()}) {
  const ctx = prepare(seed, {today, rules, contracts: assertContracts(contracts)});
  const checks = CHECKS.map(check => {
    const {checked, failures} = check.run(ctx);
    const passRate = checked ? (checked - Math.min(checked, failures.length)) / checked : 1;
    return {
      id: check.id, dimension: check.dimension, severity: check.severity, title: check.title, personal: Boolean(check.personal),
      checked, failed: failures.length, passRate: Math.round(passRate * 1000) / 1000, samples: failures.slice(0, MAX_SAMPLES),
    };
  });
  const dimensions = Object.entries(DIMENSIONS).map(([key, label]) => {
    const list = checks.filter(c => c.dimension === key);
    const weight = list.reduce((acc, c) => acc + SEVERITY_WEIGHT[c.severity], 0);
    const score = weight ? list.reduce((acc, c) => acc + c.passRate * SEVERITY_WEIGHT[c.severity], 0) / weight : 1;
    return {key, label, score: round1(score * 100), checks: list.length, failedChecks: list.filter(c => c.failed).length};
  });
  const blocking = checks.filter(c => c.severity === 'error' && c.failed);
  return {
    version: DQ_VERSION,
    today,
    sources: {
      skills: seed.skills.skills.length, relations: seed.skills.relations.length, courses: seed.courses.courses.length,
      students: seed.people.students.length, teachers: seed.people.teachers.length, competitions: seed.competitions.competitions.length,
    },
    overall: round1(dimensions.reduce((acc, d) => acc + d.score, 0) / dimensions.length),
    gate: blocking.length ? 'fail' : 'pass',
    blocking: blocking.map(c => c.id),
    dimensions,
    checks,
    insights: insightsOf(ctx),
  };
}

/** 閘門：有 error 等級的問題就丟出錯誤（啟動前呼叫，避免用壞資料建庫）。 */
export function assertDataQuality(report) {
  if (report.gate === 'pass') return report;
  const detail = report.checks.filter(c => report.blocking.includes(c.id)).map(c => `${c.id} ${c.title}：${c.samples.join('；')}`).join('\n');
  throw new Error(`種子資料未通過資料品質閘門，拒絕建立資料庫：\n${detail}`);
}

const pct = v => `${Math.round(v * 1000) / 10}%`;
/** Markdown 輸出時跳脫角括號與表格分隔符號（樣本可能含攻擊測試字串）。 */
const md = text => String(text).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');

/** 產生給評審與團隊閱讀的 Markdown 報告。 */
export function renderMarkdown(report) {
  const lines = [
    '# 資料品質報告', '',
    `- 規則版本：${report.version}；檢核日期：${report.today}`,
    `- 資料量：技能 ${report.sources.skills} 項（關聯 ${report.sources.relations} 條）、課程 ${report.sources.courses} 門、學生 ${report.sources.students} 位、教師 ${report.sources.teachers} 位、競賽 ${report.sources.competitions} 項`,
    `- **總分 ${report.overall} / 100；閘門 ${report.gate === 'pass' ? '通過' : `未通過（${report.blocking.join('、')}）`}**`,
    '- 計分方式：每條規則的通過率 = 合格筆數 ÷ 檢查筆數；面向分數 = 規則通過率的加權平均（error 權重 3、warning 權重 1）；總分 = 六個面向的平均。',
    '- 閘門：任何 error 等級的規則有不合格項目，系統就拒絕以這份資料建庫（啟動時自動執行）。', '',
    '## 各面向分數', '', '| 面向 | 分數 | 規則數 | 有問題的規則 |', '|---|---:|---:|---:|',
    ...report.dimensions.map(d => `| ${d.label} | ${d.score} | ${d.checks} | ${d.failedChecks} |`),
    '', '## 規則明細', '', '| 編號 | 面向 | 等級 | 規則 | 檢查筆數 | 不合格 | 通過率 |', '|---|---|---|---|---:|---:|---:|',
    ...report.checks.map(c => `| ${c.id} | ${report.dimensions.find(d => d.key === c.dimension).label} | ${c.severity} | ${c.title} | ${c.checked} | ${c.failed} | ${pct(c.passRate)} |`),
    '', '## 發現的問題', '',
  ];
  const failing = report.checks.filter(c => c.failed);
  if (!failing.length) lines.push('沒有發現問題。');
  for (const c of failing) {
    lines.push(`### ${c.id} ${c.title}（${c.severity}，${c.failed} 筆）`, '', ...c.samples.map(s => `- ${md(s)}`), ...(c.failed > c.samples.length ? [`- ……另有 ${c.failed - c.samples.length} 筆`] : []), '');
  }
  const m = report.insights.standardMapping;
  lines.push(
    '## 外部標準對應', '',
    `- ESCO：精確 ${m.esco.exact}、上位概念 ${m.esco.broader}、相近概念 ${m.esco.related}、未對應 ${m.esco.none}（共 ${m.skills} 項）`,
    `- O*NET UNSPSC ${m.onetUnspsc} 項、SFIA ${m.sfia} 項、UCAN 共通職能 ${m.ucan} 項`, '',
    '## 競賽需求與課程供給', '', '競賽需要的技能，在課綱庫中有幾門課在教。供給為 0 的技能，學生只能靠作品或證照補證據。', '',
    '| 技能 | 需要它的競賽數 | 教授它的課程數 |', '|---|---:|---:|',
    ...report.insights.demandSupply.map(r => `| ${r.name}（${r.skillId}） | ${r.competitions} | ${r.courses} |`), '',
  );
  return `${lines.join('\n')}\n`;
}
