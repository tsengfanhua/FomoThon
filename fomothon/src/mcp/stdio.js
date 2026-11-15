// MCP stdio 傳輸：Claude Desktop、Claude Code、MCP Inspector 等用戶端以子程序方式啟動本程式。
// 規範：stdout 只能輸出 MCP 訊息（一行一則 JSON-RPC）；所有日誌一律寫到 stderr。
// 身分：一個程序綁定一個帳號（FOMO_MCP_USER，預設示意學生 S01）；工具只能讀取這個帳號看得到的資料。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../app.js';
import {loadConfig} from '../config.js';
import {getUser} from '../db.js';
import {RPC, errorResponse} from './protocol.js';
import {createFomothonMcp} from './server.js';

const MAX_LINE_CHARS = 1_000_000;

const log = (level, message) => process.stderr.write(`[fomothon-mcp] ${level}: ${message}\n`);

/** stdio 模式沒有內建的示意課綱站可連，除非另外指定課綱站網址，否則直接讀資料庫。 */
function withLocalSyllabus(config) {
  if (config.syllabus.mode !== 'http' || config.syllabus.baseUrl) return config;
  return Object.freeze({...config, syllabus: Object.freeze({...config.syllabus, mode: 'local'})});
}

/**
 * 依「\n」切出一行一則的訊息（與官方 SDK 相同）。不用 readline：它把 U+2028／U+2029 也當成換行，
 * 而 JSON.stringify 不會跳脫這兩個字元，含這兩個字的合法訊息會被切斷。
 * @param {AsyncIterable<Buffer|string>} input
 * @returns {AsyncGenerator<{line?: string, tooLong?: boolean}>}
 */
export async function* jsonLines(input, maxChars = MAX_LINE_CHARS) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let discarding = false; // 超長訊息：丟棄到下一個換行為止
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, {stream: true});
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (discarding) discarding = false;
      else yield {line};
    }
    if (buffer.length > maxChars) {
      buffer = '';
      if (!discarding) yield {tooLong: true};
      discarding = true;
    }
  }
  if (buffer.trim() && !discarding) yield {line: buffer};
}

/**
 * 啟動 stdio 伺服器，直到輸入結束。
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, env?: object, dotenv?: boolean}} [opts]
 */
export async function runStdio({input = process.stdin, output = process.stdout, env = process.env, dotenv = true} = {}) {
  const config = withLocalSyllabus(loadConfig(env, {dotenv}));
  const app = await createApp(config);
  const user = getUser(app.db, config.mcp.user);
  if (!user) {
    app.close();
    throw new Error(`FOMO_MCP_USER 指定的帳號不存在：${config.mcp.user}`);
  }
  const session = createFomothonMcp(app, {log}).connect({user, transport: 'stdio'});
  log('info', `已啟動，連線身分 ${user.id}（${user.role}）`);

  const write = message => output.write(`${JSON.stringify(message)}\n`);
  try {
    for await (const {line, tooLong} of jsonLines(input)) {
      if (tooLong) {
        write(errorResponse(null, RPC.INVALID_REQUEST, '訊息過大'));
        continue;
      }
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        write(errorResponse(null, RPC.PARSE_ERROR, 'JSON 解析失敗'));
        continue;
      }
      const response = await session.handle(message);
      if (response) write(response);
    }
  } finally {
    app.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runStdio();
  } catch (err) {
    log('error', err.message);
    process.exit(1);
  }
}
