// 模型路由器：每個用途有一條模型鏈（例如「先 Haiku，未通過檢核再升級 Sonnet」），依序嘗試。
// 升級條件有兩種：呼叫失敗（逾時、限流、拒答、JSON 壞掉），或輸出未通過呼叫端提供的檢核（validate）。
// 資料保護：送往雲端端點的內容一律先遮蔽個資；地端端點（校內主機）不離開校園，原文送出。
import {redactPii} from '../safety/privacy.js';
import {createEndpointClient} from './providers.js';

const ENV_REF = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;
const round6 = v => Math.round(v * 1e6) / 1e6;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|::1)$/;

/**
 * 端點位置以「網址」判定：本機、私有網段與明確信任的校內主機才算地端，其他一律是雲端（送出前遮蔽個資）。
 * @param {string|null} baseUrl
 * @param {string[]} [trustedHosts] FOMO_TRUSTED_LOCAL_HOSTS 列出的校內主機名稱
 */
export function locationOf(baseUrl, trustedHosts = []) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return LOCAL_HOST.test(host) || trustedHosts.includes(host) ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

export const trustedHostsOf = env => (env.FOMO_TRUSTED_LOCAL_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

/** 以環境變數替換設定值中的 ${NAME:-預設值}。 */
export function interpolate(value, env) {
  if (typeof value === 'string') return value.replace(ENV_REF, (_, name, fallback = '') => (env[name] ? env[name] : fallback));
  if (Array.isArray(value)) return value.map(v => interpolate(v, env));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env)]));
  return value;
}

function priceOf(name, raw) {
  if (!raw || raw.in === '' || raw.out === '') return null; // 沒有單價：只記錄 token 數，不估算成本
  const price = {in: Number(raw.in), out: Number(raw.out)};
  if (!Number.isFinite(price.in) || !Number.isFinite(price.out)) throw new Error(`端點 ${name} 的單價格式錯誤`);
  return price;
}

/**
 * 把路由表中的端點設定轉成執行時設定（套用環境變數、讀取金鑰）。
 * @returns {{name:string, provider:string, model:string, baseUrl:string|null, apiKey:string, location:'cloud'|'local', timeoutMs:number, price:object|null}}
 */
export function resolveEndpoint(name, raw, env, timeoutMs) {
  const e = interpolate(raw, env);
  if (!e.provider || !e.model) throw new Error(`端點 ${name} 缺少 provider 或 model`);
  // 設定檔宣告為地端、但網址其實在雲端時，以網址為準（資料離開校園就一定要遮蔽）
  const local = e.location === 'local' && Boolean(e.baseUrl) && locationOf(e.baseUrl, trustedHostsOf(env)) === 'local';
  return {
    name, provider: e.provider, model: e.model, baseUrl: e.baseUrl ?? null,
    apiKey: e.apiKeyEnv ? env[e.apiKeyEnv] ?? '' : '',
    location: local ? 'local' : 'cloud', timeoutMs, price: priceOf(name, e.price),
  };
}

function protect(request, location) {
  if (location === 'local') return {request, redactions: 0};
  const {text, redactions} = redactPii(request.user);
  return {request: {...request, user: text}, redactions};
}

function check(validate, data) {
  if (!validate) return {ok: true};
  try {
    const verdict = validate(data);
    return verdict?.ok ? {ok: true} : {ok: false, reason: verdict?.reason ?? 'INVALID'};
  } catch {
    return {ok: false, reason: 'VALIDATOR_ERROR'};
  }
}

function summarize(request, attempts, outcome) {
  const total = key => attempts.reduce((acc, a) => acc + (a[key] ?? 0), 0);
  return {
    ...outcome,
    purpose: request.purpose,
    attempts,
    escalated: attempts.length > 1,
    usage: {input: attempts.reduce((acc, a) => acc + a.usage.input, 0), output: attempts.reduce((acc, a) => acc + a.usage.output, 0)},
    ms: total('ms'),
    costUsd: round6(total('costUsd')),
  };
}

/**
 * 以已建立好的端點用戶端組成路由器（同步）。
 * @param {{routes:Record<string, string[]>, clients:Map<string, {client:object, location:string}>, label:string, provider:string}} opts
 */
export function buildRouter({routes, clients, label, provider}) {
  const chainFor = purpose => routes[purpose] ?? routes.default ?? [];

  /**
   * @param {{purpose:string, system:string, user:string, schema:object, validate?:(data:object)=>{ok:boolean, reason?:string}}} request
   */
  async function completeJson(request) {
    const attempts = [];
    const rejectedOutputs = []; // 「回應正常但未通過檢核」的輸出：只供評測統計，呼叫端不可採用
    for (const name of chainFor(request.purpose)) {
      const {client, location} = clients.get(name);
      const outgoing = protect(request, location);
      const res = await client.completeJson(outgoing.request);
      const verdict = res.ok ? check(request.validate, res.data) : {ok: false, reason: res.error};
      attempts.push({
        endpoint: name, model: client.model, location, ok: verdict.ok,
        error: verdict.ok ? null : res.ok ? 'VALIDATION_FAILED' : res.error,
        reason: res.ok && !verdict.ok ? verdict.reason : null,
        redactions: outgoing.redactions, ms: res.ms, usage: res.usage, costUsd: res.costUsd,
      });
      if (verdict.ok) return summarize(request, attempts, {ok: true, data: res.data, model: client.model, endpoint: name, rejectedOutputs});
      if (res.ok) rejectedOutputs.push(res.data);
    }
    const last = attempts.at(-1);
    return summarize(request, attempts, {ok: false, error: last?.error ?? 'NO_ROUTE', model: last?.model ?? null, endpoint: null, rejectedOutputs});
  }

  /** 路由表摘要（給介面與評測報告）。 */
  const describe = () => ({
    label,
    routes: Object.fromEntries(Object.entries(routes).map(([purpose, chain]) => [purpose, chain.map(name => ({
      endpoint: name, model: clients.get(name).client.model, location: clients.get(name).location,
    }))])),
  });

  const models = [...new Set([...clients.values()].map(c => c.client.model))];
  return Object.freeze({enabled: true, provider, model: label, models, describe, completeJson});
}

/**
 * 依路由與端點設定建立路由器：所有被引用的端點在啟動時就建立（缺套件或缺金鑰會立刻報錯）。
 * @param {{routes:Record<string, string[]>, endpoints:Record<string, object>, label:string, provider:string, factory?:Function}} opts
 */
export async function createRouter({routes, endpoints, label, provider, factory = createEndpointClient}) {
  const clients = new Map();
  for (const name of new Set(Object.values(routes).flat())) {
    if (!endpoints[name]) throw new Error(`模型路由引用了不存在的端點：${name}`);
    clients.set(name, {client: await factory(endpoints[name]), location: endpoints[name].location});
  }
  if (!clients.size) throw new Error('模型路由沒有任何端點');
  return buildRouter({routes, clients, label, provider});
}
