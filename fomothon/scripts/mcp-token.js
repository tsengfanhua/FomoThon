// MCP 個人存取權杖管理（Streamable HTTP 端點用）。權杖原文只在核發時顯示一次，資料庫只存雜湊。
// 用法：
//   node scripts/mcp-token.js issue S01 [--days 30] [--label "Claude Desktop"]
//   node scripts/mcp-token.js list
//   node scripts/mcp-token.js revoke MT-xxxxxxxx
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {createTokenStore} from '../src/mcp/tokens.js';

const USAGE = '用法：node scripts/mcp-token.js issue <帳號ID> [--days 30] [--label 說明] | list | revoke <權杖ID>';

function option(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const out = text => process.stdout.write(`${text}\n`);

async function main(args) {
  const [command, target] = args;
  const app = await createApp(loadConfig(process.env, {dotenv: true}));
  try {
    const store = createTokenStore(app.db);
    if (command === 'issue' && target) {
      const days = option(args, '--days');
      const issued = store.issue(target, {days: days ? Number(days) : 30, label: option(args, '--label') ?? null});
      out(`已核發 ${issued.id}（帳號 ${issued.userId}，到期 ${issued.expiresAt}）`);
      out(`權杖（只顯示這一次，請妥善保存）：${issued.token}`);
      return 0;
    }
    if (command === 'list') {
      for (const t of store.list()) out(`${t.id}\t${t.userId}\t${t.revoked ? '已撤銷' : `到期 ${t.expiresAt}`}\t${t.label ?? ''}`);
      return 0;
    }
    if (command === 'revoke' && target) {
      out(store.revoke(target) ? `已撤銷 ${target}` : `找不到可撤銷的權杖：${target}`);
      return 0;
    }
    process.stderr.write(`${USAGE}\n`);
    return 2;
  } finally {
    app.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`失敗：${err.message}\n`);
  process.exitCode = 1;
}
