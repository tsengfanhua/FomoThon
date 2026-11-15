// 組態：全部由環境變數決定，皆有預設值（預設為離線規則模式，不對外傳送資料）。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveEndpoint, trustedHostsOf} from './llm/router.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LLM_PROVIDERS = ['none', 'anthropic', 'openai-compatible'];
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const OFF_VALUES = ['0', 'false', 'off', 'no'];
const ON_VALUES = ['1', 'true', 'on', 'yes'];

function loadDotEnv() {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function toNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`環境變數數值格式錯誤：${value}`);
  return n;
}

/** 模型路由設定：FOMO_LLM_PROFILE 指定 config/models.json 的一組路由；未指定時使用單一端點設定。 */
function loadProfile(env, timeoutMs) {
  const profile = (env.FOMO_LLM_PROFILE ?? '').trim();
  if (!profile) return {profile: null, routes: null, endpoints: null};
  const catalog = readJson('config/models.json');
  const chosen = Object.hasOwn(catalog.profiles, profile) ? catalog.profiles[profile] : null;
  if (!chosen) throw new Error(`FOMO_LLM_PROFILE 必須是 ${Object.keys(catalog.profiles).join(' / ')}，目前為「${profile}」`);
  const used = [...new Set(Object.values(chosen.routes).flat())];
  const endpoints = Object.fromEntries(used.map(name => {
    if (!Object.hasOwn(catalog.endpoints, name)) throw new Error(`模型路由 ${profile} 引用了不存在的端點：${name}`);
    return [name, resolveEndpoint(name, catalog.endpoints[name], env, timeoutMs)];
  }));
  return {profile, description: chosen.description, routes: Object.freeze({...chosen.routes}), endpoints: Object.freeze(endpoints)};
}

/**
 * 技能中樞：三個 Python Agent（競賽、教師、課程）產出的資料庫位置，以及即時分析要用的 Python。
 * 預設假設本專案與三個 Agent 放在同一個上層資料夾；資料庫不存在時相關頁面會顯示「尚未建立」。
 */
function loadHub(env) {
  const root = env.FOMO_HUB_ROOT || path.resolve(ROOT, '..');
  return Object.freeze({
    root,
    escoDb: env.FOMO_HUB_ESCO_DB || path.join(root, 'data', 'shared', 'esco_skills.sqlite'),
    courseDb: env.FOMO_HUB_COURSE_DB || path.join(root, 'course-agent', 'data', 'processed', 'course_index.sqlite'),
    hubDb: env.FOMO_HUB_DB || path.join(root, 'data', 'shared', 'skill_hub.sqlite'),
    python: env.FOMO_HUB_PYTHON || 'python3',
    // 是否允許從網頁觸發爬蟲與課程分析（會對外連線並呼叫模型，會產生費用）：必須明確設為 1 才開啟
    jobs: ON_VALUES.includes((env.FOMO_HUB_JOBS ?? '').trim().toLowerCase()),
    // 教師姓名預設遮蔽（例如「王Ｏ明」）；設為 1 才顯示完整姓名
    showNames: ON_VALUES.includes((env.FOMO_HUB_SHOW_NAMES ?? '').trim().toLowerCase()),
    crawlLimit: crawlLimitOf(env.FOMO_HUB_CRAWL_LIMIT),
    // 示意學生的真實課程修課清單（scripts/build_campus_personas.py 產生）；助理流程全部改用真實資料時需要
    personasFile: env.FOMO_HUB_PERSONAS || path.join(root, 'data', 'shared', 'campus_enrollments.json'),
  });
}

/**
 * 助理流程預設的資料來源。demo：全部用合成的示意資料（預設，測試與評測都用這個）；
 * hybrid：競賽與教師改查技能中樞的真實資料，能力盤點與隊友仍用合成資料；
 * campus：整個流程都用真實資料——能力盤點與隊友的技能也改由真實課程的課綱推得（學生仍是平台上的示意帳號）。
 * 指定的來源所需的資料尚未建立時，自動退回 demo。
 */
export const ASSISTANT_SOURCES = Object.freeze(['demo', 'hybrid', 'campus']);
function assistantSourceOf(value) {
  const source = (value ?? '').trim() || 'demo';
  if (!ASSISTANT_SOURCES.includes(source)) throw new Error(`FOMO_ASSISTANT_SOURCE 必須是 ${ASSISTANT_SOURCES.join(' / ')}，目前為「${source}」`);
  return source;
}

function crawlLimitOf(value) {
  const limit = toNumber(value, 6);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('FOMO_HUB_CRAWL_LIMIT 必須是 1–50 的整數');
  return limit;
}

export function loadConfig(env = process.env, {dotenv = false} = {}) {
  if (dotenv) loadDotEnv();
  const provider = (env.FOMO_LLM_PROVIDER || 'none').trim();
  if (!LLM_PROVIDERS.includes(provider)) {
    throw new Error(`FOMO_LLM_PROVIDER 必須是 ${LLM_PROVIDERS.join(' / ')}，目前為「${provider}」`);
  }
  if (env.FOMO_TODAY && !/^\d{4}-\d{2}-\d{2}$/.test(env.FOMO_TODAY)) {
    throw new Error('FOMO_TODAY 格式必須為 YYYY-MM-DD');
  }
  const port = toNumber(env.PORT, 8787);
  const host = env.HOST || '127.0.0.1';
  const model = env.FOMO_LLM_MODEL || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : '');
  if (provider === 'openai-compatible' && !model && !env.FOMO_LLM_PROFILE) {
    throw new Error('使用 openai-compatible 時必須設定 FOMO_LLM_MODEL');
  }
  const llmTimeoutMs = toNumber(env.FOMO_LLM_TIMEOUT_MS, 20000);
  return Object.freeze({
    root: ROOT,
    port,
    host,
    dbPath: env.FOMO_DB_PATH || path.join(ROOT, 'var', 'fomothon.db'),
    today: env.FOMO_TODAY || null,
    accessCode: env.FOMO_ACCESS_CODE || null,
    // 對外部署（HTTPS 反向代理之後）時使用：Cookie 加上 Secure、限定可接受的 Host 標頭
    cookieSecure: ON_VALUES.includes((env.FOMO_COOKIE_SECURE ?? '').trim().toLowerCase()),
    allowedHosts: Object.freeze((env.FOMO_ALLOWED_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)),
    demoFaults: !OFF_VALUES.includes((env.FOMO_DEMO_FAULTS ?? '1').trim().toLowerCase()),
    // 評測專用的消融開關：fixed＝固定工作流基準（單輪精準搜尋、不重試、不重新規劃）
    fixedWorkflow: env.FOMO_ABLATION === 'fixed',
    mcp: Object.freeze({
      // stdio 模式綁定的帳號（一個程序一個身分）
      user: (env.FOMO_MCP_USER || 'S01').trim(),
      // Streamable HTTP 端點 /mcp：預設關閉；開啟後必須帶個人存取權杖（scripts/mcp-token.js 核發）
      http: ON_VALUES.includes((env.FOMO_MCP_HTTP ?? '').trim().toLowerCase()),
    }),
    syllabus: Object.freeze({
      mode: env.FOMO_SYLLABUS_MODE === 'local' ? 'local' : 'http',
      baseUrl: env.FOMO_SYLLABUS_BASE_URL || null, // null → 伺服器啟動後指向自己的 /campus
      timeoutMs: toNumber(env.FOMO_SYLLABUS_TIMEOUT_MS, 4000),
    }),
    llm: Object.freeze({
      provider,
      model,
      baseUrl: env.FOMO_LLM_BASE_URL || 'https://api.openai.com/v1',
      apiKey: env.FOMO_LLM_API_KEY || (provider === 'openai-compatible' ? env.OPENAI_API_KEY : '') || '',
      timeoutMs: llmTimeoutMs,
      priceIn: toNumber(env.FOMO_LLM_PRICE_IN, null),
      priceOut: toNumber(env.FOMO_LLM_PRICE_OUT, null),
      trustedLocalHosts: Object.freeze(trustedHostsOf(env)),
      ...loadProfile(env, llmTimeoutMs),
    }),
    rules: Object.freeze(readJson('config/level-rules.json')),
    hub: loadHub(env),
    assistantSource: assistantSourceOf(env.FOMO_ASSISTANT_SOURCE),
  });
}

export function readSeed(name) {
  return readJson(path.join('data', 'seed', `${name}.json`));
}
