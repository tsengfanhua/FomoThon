// MCP Streamable HTTP 傳輸（規範 2025-11-25 §Transports）：單一端點 /mcp。
// POST：用戶端送出一則 JSON-RPC 訊息。請求 → 200 application/json；通知與回應 → 202（無內容）。
// GET：本伺服器不提供伺服器推播串流，回 405（規範允許）。DELETE：結束連線階段。
// 安全：預設關閉（FOMO_MCP_HTTP=1 才開）；每個請求都驗證 Bearer 權杖；檢查 Origin 與 Host（防 DNS rebinding）；
// 速率限制；連線階段綁定權杖、閒置 30 分鐘過期；每把權杖最多 5 個連線階段，滿了只淘汰自己最久沒用的那個。
import {randomToken} from '../util.js';
import {RPC, SUPPORTED_VERSIONS, errorResponse} from './protocol.js';

const MAX_BODY_BYTES = 64 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_SESSIONS_PER_TOKEN = 5;
const RATE_LIMIT_PER_MINUTE = 120;
const SESSION_HEADER = 'mcp-session-id';
const VERSION_HEADER = 'mcp-protocol-version';
const ALLOW = 'POST, DELETE';

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const mediaType = header => String(header ?? '').split(';')[0].trim().toLowerCase();

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return {tooLarge: true};
    chunks.push(chunk);
  }
  return {text: Buffer.concat(chunks).toString('utf8')};
}

/**
 * 連線階段表：Map 的順序就是「最後使用時間」的順序（每次使用都先刪再加，等於 LRU）。
 * 每把權杖有自己的上限；全部滿了就拒絕新的連線，不會為了新連線去淘汰別人的連線。
 */
export function createSessionTable({maxSessions = MAX_SESSIONS, maxPerToken = MAX_SESSIONS_PER_TOKEN, ttlMs = SESSION_TTL_MS} = {}) {
  const sessions = new Map();
  const prune = now => {
    for (const [id, entry] of sessions) if (entry.expiresAt < now) sessions.delete(id);
  };
  return {
    /** 新增連線階段；回傳 ID，容量已滿時回傳 null。 */
    add(entry) {
      prune(Date.now());
      const own = [...sessions.entries()].filter(([, e]) => e.tokenId === entry.tokenId);
      if (own.length >= maxPerToken) sessions.delete(own[0][0]); // 只淘汰同一把權杖最久沒用的連線
      if (sessions.size >= maxSessions) return null;
      const id = randomToken(24);
      sessions.set(id, {...entry, expiresAt: Date.now() + ttlMs});
      return id;
    },
    /** 取得並續期；不存在、過期或不屬於這把權杖都回傳 null。 */
    touch(id, tokenId) {
      const entry = id ? sessions.get(id) : null;
      if (!entry || entry.tokenId !== tokenId) return null;
      sessions.delete(id);
      if (entry.expiresAt < Date.now()) return null;
      const renewed = {...entry, expiresAt: Date.now() + ttlMs};
      sessions.set(id, renewed);
      return renewed;
    },
    remove(id, tokenId) {
      const entry = id ? sessions.get(id) : null;
      if (!entry || entry.tokenId !== tokenId || entry.expiresAt < Date.now()) return false;
      return sessions.delete(id);
    },
    size: () => sessions.size,
  };
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./protocol.js').createMcpServer>} deps.server
 * @param {ReturnType<import('./tokens.js').createTokenStore>} deps.tokens
 * @param {(key:string, limit:number) => boolean} deps.allow 速率限制
 * @param {(req:import('node:http').IncomingMessage) => boolean} deps.hostAllowed
 * @param {(origin:string, host:string) => boolean} deps.originAllowed
 * @param {(res:object, status:number, headers:object, body:string) => void} deps.send 會加上安全標頭
 */
export function createMcpHttpHandler({server, tokens, allow, hostAllowed, originAllowed, send}) {
  const table = createSessionTable();

  const json = (res, status, payload, headers = {}) => send(res, status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers}, JSON.stringify(payload));
  const fail = (res, status, message, headers = {}) => json(res, status, errorResponse(null, RPC.INVALID_REQUEST, message), headers);

  function authenticate(req) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    return match ? tokens.verify(match[1]) : null;
  }

  async function initialize(res, auth, message) {
    const session = server.connect({user: auth.user, transport: 'http'});
    const response = await session.handle(message);
    if (!response?.result) return json(res, 400, response ?? errorResponse(null, RPC.INVALID_REQUEST, 'initialize 必須是請求'));
    const id = table.add({session, tokenId: auth.tokenId});
    if (!id) return fail(res, 503, '連線階段已達上限，請稍後再試', {'retry-after': '60'});
    return json(res, 200, response, {[SESSION_HEADER]: id});
  }

  async function handlePost(req, res, auth) {
    if (mediaType(req.headers['content-type']) !== 'application/json') return fail(res, 415, '請以 application/json 傳送');
    const accept = req.headers.accept ?? '';
    if (accept && !/(application\/json|\*\/\*)/.test(accept)) return fail(res, 406, '用戶端必須接受 application/json');
    const version = req.headers[VERSION_HEADER];
    if (version && !SUPPORTED_VERSIONS.includes(version)) return fail(res, 400, `不支援的協定版本：${version}`);

    const body = await readBody(req);
    if (body.tooLarge) return fail(res, 413, '請求內容過大');
    let message;
    try {
      message = JSON.parse(body.text);
    } catch {
      return json(res, 400, errorResponse(null, RPC.PARSE_ERROR, 'JSON 解析失敗'));
    }
    if (!isObject(message)) return fail(res, 400, '一次只能送出一則 JSON-RPC 訊息');
    if (message.method === 'initialize') return initialize(res, auth, message);

    if (!req.headers[SESSION_HEADER]) return fail(res, 400, '缺少 Mcp-Session-Id 標頭；請先送出 initialize');
    const entry = table.touch(req.headers[SESSION_HEADER], auth.tokenId);
    if (!entry) return fail(res, 404, '連線階段不存在或已過期，請重新 initialize');
    const negotiated = entry.session.session().protocolVersion;
    if (version && version !== negotiated) return fail(res, 400, `協定版本標頭（${version}）與初始化協商的版本（${negotiated}）不一致`);
    const response = await entry.session.handle(message);
    if (!response) return send(res, 202, {}, '');
    return json(res, 200, response);
  }

  /** 處理 /mcp 的請求。 */
  return async function handle(req, res) {
    if (!hostAllowed(req)) return fail(res, 403, '不接受這個 Host 標頭');
    if (req.headers.origin && !originAllowed(req.headers.origin, req.headers.host)) return fail(res, 403, '不接受這個來源（Origin）');
    const auth = authenticate(req);
    if (!auth) return fail(res, 401, '需要有效的 MCP 存取權杖（Authorization: Bearer …）', {'www-authenticate': 'Bearer realm="fomothon-mcp"'});
    if (!allow(`mcp:${auth.tokenId}`, RATE_LIMIT_PER_MINUTE)) return fail(res, 429, '請求太頻繁，請稍後再試', {'retry-after': '60'});

    if (req.method === 'POST') return handlePost(req, res, auth);
    if (req.method === 'DELETE') {
      if (!table.remove(req.headers[SESSION_HEADER], auth.tokenId)) return fail(res, 404, '連線階段不存在或已過期');
      return send(res, 204, {}, '');
    }
    return send(res, 405, {allow: ALLOW}, '');
  };
}
