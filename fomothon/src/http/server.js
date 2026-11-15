// HTTP 伺服器（Node 內建 http，無外部相依）：靜態前端、JSON API、示意課綱站。
// 所有 API 回應使用同一種格式：{success, data, error}。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../app.js';
import {loadConfig} from '../config.js';
import {campusPage} from '../inventory/campus.js';
import {createMcpHttpHandler} from '../mcp/http.js';
import {createFomothonMcp} from '../mcp/server.js';
import {createTokenStore} from '../mcp/tokens.js';
import {AppError} from '../util.js';
import {registerRoutes} from './routes.js';

const MAX_BODY_BYTES = 64 * 1024;
const COOKIE = 'fomo_session';
const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/assistant.js': ['assistant.js', 'text/javascript; charset=utf-8'],
  '/pages.js': ['pages.js', 'text/javascript; charset=utf-8'],
  '/hub.js': ['hub.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/mascot.png': ['mascot.png', 'image/png'],
});
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
});

/** 簡易速率限制（固定視窗）：每個金鑰每分鐘的請求數上限。 */
function createRateLimiter() {
  const windows = new Map();
  return function allow(key, limit) {
    const minute = Math.floor(Date.now() / 60_000);
    const slot = windows.get(key);
    if (!slot || slot.minute !== minute) {
      windows.set(key, {minute, count: 1});
      if (windows.size > 5000) for (const [k, val] of windows) if (val.minute !== minute) windows.delete(k);
      return true;
    }
    slot.count += 1;
    return slot.count <= limit;
  };
}

function compilePattern(pattern) {
  const source = pattern.replace(/:[a-zA-Z]+/g, m => `(?<${m.slice(1)}>[^/]+)`);
  return new RegExp(`^${source}$`);
}

async function readJsonBody(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError('UNSUPPORTED', '請以 application/json 傳送', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError('TOO_LARGE', '請求內容過大', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new AppError('INVALID_JSON', 'JSON 格式錯誤', 400);
  }
}

/** 解碼失敗（不合法的百分比編碼）回傳 null，不丟例外。 */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const pairs = header.split(';').map(part => part.trim().split('=')).filter(([k, val]) => k && val)
    .map(([k, val]) => [k, safeDecode(val)]).filter(([, val]) => val !== null);
  return Object.fromEntries(pairs);
}

/** 來源檢查：Origin 無法解析（例如 null）一律視為跨來源。 */
function sameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * 建立 HTTP 伺服器（尚未 listen）。
 * @param {Awaited<ReturnType<typeof createApp>>} app
 */
export function createServer(app) {
  const publicDir = path.join(app.config.root, 'public');
  const allow = createRateLimiter();
  const allowedHosts = new Set(); // 由 start() 在得知實際埠號後填入；空集合代表不檢查
  const secureFlag = app.config.cookieSecure ? '; Secure' : '';
  const routes = [];
  registerRoutes(app, (method, pattern, handler, opts = {}) => routes.push({method, re: compilePattern(pattern), handler, auth: opts.auth ?? true, roles: opts.roles ?? null, limit: opts.limit ?? 240}));

  const send = (res, status, headers, body) => {
    res.writeHead(status, {...SECURITY_HEADERS, ...headers});
    res.end(body);
  };
  const sendJson = (res, status, payload, headers = {}) => send(res, status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers}, JSON.stringify(payload));
  const hostAllowed = req => !allowedHosts.size || allowedHosts.has((req.headers.host ?? '').toLowerCase());

  // MCP Streamable HTTP 端點：預設關閉，FOMO_MCP_HTTP=1 才開啟
  const mcp = app.config.mcp.http
    ? createMcpHttpHandler({
      server: createFomothonMcp(app, {log: (level, message) => process.stderr.write(`[mcp] ${level}: ${message}\n`)}),
      tokens: createTokenStore(app.db), allow, hostAllowed, originAllowed: sameOrigin, send,
    })
    : null;

  async function handleApi(req, res, url) {
    const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!route) throw new AppError('NOT_FOUND', '找不到這個 API', 404);
    // CSRF：狀態變更請求必須同源（搭配 SameSite=Strict 的 Cookie）
    if (req.method !== 'GET' && req.headers.origin && !sameOrigin(req.headers.origin, req.headers.host)) {
      throw new AppError('FORBIDDEN', '跨來源請求已拒絕', 403);
    }
    // Host 白名單：擋掉以其他網域名稱指向本機服務的請求（DNS rebinding）
    if (!hostAllowed(req)) throw new AppError('FORBIDDEN', '不接受這個 Host 標頭', 403);
    const cookies = parseCookies(req.headers.cookie);
    const user = app.auth.userFor(cookies[COOKIE]);
    const limiterKey = `${user?.id ?? req.socket.remoteAddress}:${route.re.source}`;
    if (!allow(limiterKey, route.limit)) throw new AppError('RATE_LIMITED', '請求太頻繁，請稍後再試', 429);
    if (route.auth && !user) throw new AppError('UNAUTHORIZED', '請先登入', 401);
    if (route.roles && !route.roles.includes(user.role)) throw new AppError('FORBIDDEN', '你的角色沒有這項權限', 403);

    const body = req.method === 'GET' ? {} : await readJsonBody(req);
    const params = route.re.exec(url.pathname).groups ?? {};
    const result = await route.handler({user, body, params, query: url.searchParams, sessionId: cookies[COOKIE]});
    const headers = {};
    if (result?.setSession !== undefined) {
      headers['set-cookie'] = result.setSession
        ? `${COOKIE}=${encodeURIComponent(result.setSession)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureFlag}`
        : `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag}`;
    }
    sendJson(res, 200, {success: true, data: result?.data ?? null, error: null}, headers);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://local');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/mcp') {
        if (!mcp) throw new AppError('NOT_FOUND', 'MCP HTTP 端點未啟用（設定 FOMO_MCP_HTTP=1）', 404);
        return await mcp(req, res);
      }
      if (req.method !== 'GET') throw new AppError('METHOD_NOT_ALLOWED', '不支援的方法', 405);
      if (url.pathname === '/healthz') return sendJson(res, 200, {success: true, data: {status: 'ok'}, error: null});
      const campus = url.pathname.match(/^\/campus\/syllabus\/([^/]+)$/);
      if (campus) {
        const page = campusPage(app.db, safeDecode(campus[1]) ?? '');
        return send(res, page.status, {'content-type': page.status === 200 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'}, page.body);
      }
      const file = STATIC_FILES[url.pathname];
      if (!file) throw new AppError('NOT_FOUND', '找不到頁面', 404);
      return send(res, 200, {'content-type': file[1], 'cache-control': 'no-cache'}, fs.readFileSync(path.join(publicDir, file[0])));
    } catch (err) {
      if (err instanceof AppError) return sendJson(res, err.status, {success: false, data: null, error: {code: err.code, message: err.message}});
      process.stderr.write(`[http] ${req.method} ${req.url} 未預期錯誤：${err?.stack ?? err}\n`);
      return sendJson(res, 500, {success: false, data: null, error: {code: 'INTERNAL', message: '伺服器內部錯誤'}});
    }
  });
  return Object.assign(server, {allowHosts: hosts => { for (const h of hosts) allowedHosts.add(h.toLowerCase()); }});
}

/** 啟動伺服器並回傳 {server, app, url}。port 傳 0 可取得隨機埠（測試與評測用）。 */
export async function start(config, overrides = {}) {
  const app = await createApp(config, overrides);
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const port = server.address().port;
  const hostPart = config.host.includes(':') ? `[${config.host}]` : config.host; // IPv6 位址要加方括號
  const url = `http://${hostPart}:${port}`;
  server.allowHosts([`${hostPart}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...config.allowedHosts]);
  app.setSyllabusBaseUrl(`${url}/campus`);
  return {server, app, url, stop: () => new Promise(resolve => server.close(() => { app.close(); resolve(); }))};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig(process.env, {dotenv: true});
    const {url, app} = await start(config);
    process.stdout.write(`Fomo鬆 參賽助理已啟動：${url}\n模式：${app.llm.enabled ? `LLM（${app.llm.provider}／${app.llm.model}）＋規則備援` : '離線規則模式（不對外傳送資料）'}\n`);
  } catch (err) {
    process.stderr.write(`啟動失敗：${err.message}\n`);
    process.exit(1);
  }
}
