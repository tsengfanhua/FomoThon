// 重建資料庫：刪除現有資料庫檔案，下次啟動時會重新載入種子資料。
// 用法：npm run reset
import fs from 'node:fs';
import {loadConfig} from '../src/config.js';

const config = loadConfig(process.env, {dotenv: true});
if (config.dbPath === ':memory:') {
  process.stdout.write('目前設定為記憶體資料庫，無需重建。\n');
} else {
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(config.dbPath + suffix, {force: true});
  process.stdout.write('資料庫已刪除，下次啟動時會以種子資料重建。\n');
}
