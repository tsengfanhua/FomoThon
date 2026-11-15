// LLM 入口：整個系統只透過 completeJson() 使用模型，而且每個用途都有規則式的退回方案。
// 約定：completeJson 不丟例外，一律回傳 {ok, data?, error?, usage, ms, costUsd, model, attempts}。
// 呼叫端可以傳 validate(data) → {ok, reason}：輸出未通過檢核視同失敗，路由器會改用模型鏈中的下一個模型；
// 呼叫端拿到結果後仍要自行驗證（模型輸出一律視為不可信的外部輸入）。
import {DEFAULT_PRICES, wrap} from './providers.js';
import {buildRouter, createRouter, locationOf} from './router.js';

export {DEFAULT_PRICES, locationOf};

const disabled = Object.freeze({
  enabled: false, provider: 'none', model: null, models: [],
  describe: () => ({label: 'rule', routes: {}}),
  completeJson: async request => ({ok: false, error: 'LLM_DISABLED', purpose: request?.purpose, attempts: [], usage: {input: 0, output: 0}, ms: 0, costUsd: 0}),
});

/** 單一端點設定（FOMO_LLM_PROVIDER／FOMO_LLM_MODEL）轉成只有一條路由的路由器。 */
function singleEndpoint(cfg) {
  return {
    name: 'default', provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl ?? null, apiKey: cfg.apiKey ?? '',
    location: cfg.provider === 'anthropic' ? 'cloud' : locationOf(cfg.baseUrl, cfg.trustedLocalHosts ?? []),
    timeoutMs: cfg.timeoutMs ?? 20000,
    price: cfg.priceIn !== null && cfg.priceIn !== undefined && cfg.priceOut !== null && cfg.priceOut !== undefined ? {in: cfg.priceIn, out: cfg.priceOut} : null,
  };
}

/**
 * @param {object} cfg config.llm
 * @param {{factory?: Function}} [opts] 測試時可注入端點工廠
 */
export async function createLlm(cfg, {factory} = {}) {
  if (cfg.profile) {
    return createRouter({routes: cfg.routes, endpoints: cfg.endpoints, label: cfg.profile, provider: `profile:${cfg.profile}`, factory});
  }
  if (cfg.provider === 'none') return disabled;
  return createRouter({routes: {default: ['default']}, endpoints: {default: singleEndpoint(cfg)}, label: cfg.model, provider: cfg.provider, factory});
}

/**
 * 測試與評測用的假模型：以函式決定回應，可模擬失敗與惡意輸出。
 * 預設當作雲端端點（會套用個資遮蔽），與正式路徑相同。
 * @param {(request:object) => unknown} respond
 * @param {{model?: string, location?: 'cloud'|'local'}} [opts]
 */
export function createFakeLlm(respond, {model = 'fake', location = 'cloud'} = {}) {
  const client = wrap({provider: 'fake', model, location, price: null}, async request => {
    const out = await respond(request);
    if (out?.stop) return {text: '', usage: {input: 0, output: 0}, stop: out.stop};
    return {text: typeof out === 'string' ? out : JSON.stringify(out), usage: {input: 100, output: 20}, stop: null};
  });
  return buildRouter({routes: {default: ['fake']}, clients: new Map([['fake', {client, location}]]), label: model, provider: 'fake'});
}

/** 假模型鏈：測試路由器的升級邏輯（第一個模型失敗或未通過檢核時改用下一個）。 */
export function createFakeChain(responders) {
  const clients = new Map(responders.map(({name, respond, location = 'cloud', price = null}) => [name, {
    location,
    client: wrap({provider: 'fake', model: name, location, price}, async request => {
      const out = await respond(request);
      if (out?.stop) return {text: '', usage: {input: 0, output: 0}, stop: out.stop};
      return {text: typeof out === 'string' ? out : JSON.stringify(out), usage: {input: 100, output: 20}, stop: null};
    }),
  }]));
  return buildRouter({routes: {default: responders.map(r => r.name)}, clients, label: 'fake-chain', provider: 'fake'});
}
