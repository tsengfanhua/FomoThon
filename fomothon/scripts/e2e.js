// 端對端測試的啟動器：以全新的暫存資料庫啟動伺服器（隨機埠）→ 執行 Playwright 腳本 → 關閉伺服器。
// 用法：npm run e2e [-- 截圖輸出資料夾]
// 需求：python3、pip install playwright、playwright install chromium
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ROOT, loadConfig} from '../src/config.js';
import {start} from '../src/http/server.js';

const shotsDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomothon-e2e-'));
const ctx = await start(loadConfig({FOMO_DB_PATH: path.join(dbDir, 'e2e.db'), FOMO_TODAY: '2026-11-21', PORT: '0', HOST: '127.0.0.1', FOMO_LLM_PROVIDER: 'none'}));

const args = [path.join(ROOT, 'e2e', 'e2e_flow.py'), ctx.url, ...(shotsDir ? [shotsDir] : [])];
const child = spawn(process.env.PYTHON ?? 'python3', args, {stdio: 'inherit'});
const code = await new Promise(resolve => {
  child.on('error', err => {
    process.stderr.write(`無法執行 Python：${err.message}\n`);
    resolve(1);
  });
  child.on('exit', resolve);
});

await ctx.stop();
fs.rmSync(dbDir, {recursive: true, force: true});
process.exitCode = code ?? 1;
