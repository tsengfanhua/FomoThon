// 資料品質報告：執行 23 條規則，輸出 data/quality/latest.json 與 data/quality/REPORT.md。
// 閘門未通過時以結束碼 1 結束（可放進 CI，擋下有問題的資料更新）。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, loadConfig} from '../src/config.js';
import {readSeedBundle, renderMarkdown, runDataQuality} from '../src/dq/index.js';
import {createClock} from '../src/util.js';

const config = loadConfig(process.env, {dotenv: true});
const report = runDataQuality(readSeedBundle(), {today: createClock(config.today).todayStr(), rules: config.rules});
const outDir = path.join(ROOT, 'data', 'quality');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderMarkdown(report));

process.stdout.write(`資料品質總分 ${report.overall}／100；閘門${report.gate === 'pass' ? '通過' : `未通過（${report.blocking.join('、')}）`}\n`);
for (const d of report.dimensions) process.stdout.write(`  ${d.label} ${d.score}（${d.failedChecks}/${d.checks} 條規則有發現）\n`);
process.stdout.write(`報告：${path.relative(ROOT, path.join(outDir, 'REPORT.md'))}\n`);
process.exitCode = report.gate === 'pass' ? 0 : 1;
