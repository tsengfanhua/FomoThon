// 匿名檢查：掃描專案內所有文字檔，確認沒有出現不該出現的字串（校名、校徽名稱、指導教授姓名等）。
// 禁用字串不寫在程式裡，由執行時提供，這樣專案內不會留下那些字串：
//   ANON_TERMS="校名,校名簡稱,教授姓名" npm run check:anon      （建議：不落地）
// 也可寫在 .anonymity-denylist.local（一行一個；已列入 .gitignore）。注意：打包原始碼時務必排除這個檔案。
// 另外固定檢查是否夾帶本機絕對路徑。
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../src/config.js';

const DENYLIST_FILE = path.join(ROOT, '.anonymity-denylist.local');
const SKIP_DIRS = new Set(['node_modules', 'var', '.git']);
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.sql', '.py', '.txt', '.example', '']);
const PATH_PATTERNS = [/[A-Za-z]:\\Users\\/, /\/home\/[a-z0-9_-]+\//i, /\/mnt\/[a-z]\//, /OneDrive/i];

const fromEnv = (process.env.ANON_TERMS ?? '').split(',').map(term => term.trim()).filter(Boolean);
const fromFile = fs.existsSync(DENYLIST_FILE)
  ? fs.readFileSync(DENYLIST_FILE, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  : [];
const terms = [...new Set([...fromEnv, ...fromFile])];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name === path.basename(DENYLIST_FILE)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (TEXT_EXT.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

const findings = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  scanned += 1;
  const rel = path.relative(ROOT, file);
  const selfCheck = rel === path.join('scripts', 'check-anonymity.js');
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
    for (const term of terms) if (line.includes(term)) findings.push(`${rel}:${index + 1} 出現禁用字串「${term}」`);
    if (!selfCheck && PATH_PATTERNS.some(re => re.test(line))) findings.push(`${rel}:${index + 1} 疑似夾帶本機路徑`);
  });
}

process.stdout.write(`已掃描 ${scanned} 個檔案；禁用字串 ${terms.length} 個${terms.length ? '' : '（未提供 ANON_TERMS 或 .anonymity-denylist.local，只檢查本機路徑）'}。\n`);
if (findings.length) {
  process.stdout.write(`發現 ${findings.length} 處需要處理：\n${findings.map(f => ` - ${f}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('未發現問題。\n');
}
