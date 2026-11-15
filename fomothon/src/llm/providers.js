// 模型供應商介面：把各家 API 包成同一種「不丟例外、只回 JSON」的端點用戶端。
// 每個端點回傳 {ok, data?, error?, usage, ms, costUsd, purpose}；資料是否可信由上層的檢核決定。
import {safeJsonParse} from '../util.js';

// 成本估算用的預設單價（美元／百萬 token）；資料時間 2026-11-03，可用端點設定或環境變數覆寫。
export const DEFAULT_PRICES = Object.freeze({
  'claude-opus-5-5': {in: 4, out: 20},
  'claude-sonnet-5-5': {in: 2, out: 10},
  'claude-haiku-5-5': {in: 0.1, out: 0.5},
});
// 支援伺服器端拒答備援（server-side fallbacks）的模型；Haiku 5.5 沒有這項功能，不可傳 fallbacks。
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1']);
const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_OUTPUT_TOKENS = 16000;

function costOf(price, usage) {
  if (!price) return 0;
  return Math.round(((usage.input * price.in + usage.output * price.out) / 1_000_000) * 1e6) / 1e6;
}

/**
 * 把一個「送出請求」函式包成端點用戶端：量測延遲、計算成本、解析 JSON、例外一律轉成錯誤碼。
 * @param {{provider:string, model:string, location:string, price:{in:number,out:number}|null}} meta
 * @param {(request:object) => Promise<{text:string, usage:{input:number,output:number}, stop:string|null}>} send
 */
export function wrap(meta, send) {
  return Object.freeze({
    enabled: true, provider: meta.provider, model: meta.model, location: meta.location,
    completeJson: async request => {
      const started = performance.now();
      const done = extra => ({usage: {input: 0, output: 0}, costUsd: 0, purpose: request.purpose, ...extra, ms: Math.round(performance.now() - started)});
      try {
        const {text, usage, stop} = await send(request);
        const costUsd = costOf(meta.price, usage);
        if (stop) return done({ok: false, error: stop, usage, costUsd});
        const data = safeJsonParse(text);
        if (data === null || typeof data !== 'object') return done({ok: false, error: 'INVALID_JSON', usage, costUsd});
        return done({ok: true, data, usage, costUsd});
      } catch (err) {
        return done({ok: false, error: err?.code ?? err?.name ?? 'LLM_ERROR'});
      }
    },
  });
}

const errorWithCode = code => Object.assign(new Error(code), {code});

/** Anthropic：使用官方 SDK（選用相依，啟用時才載入），以結構化輸出（JSON Schema）取得 JSON。 */
export async function anthropicSender(endpoint) {
  let Anthropic;
  try {
    ({default: Anthropic} = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('使用 anthropic 端點需要先在專案目錄執行 npm install 以安裝 @anthropic-ai/sdk');
  }
  // 金鑰由 SDK 自環境解析（ANTHROPIC_API_KEY 等），程式不經手。
  // 端點設定了 apiKeyEnv 時用那個金鑰；否則由 SDK 依預設順序解析（ANTHROPIC_API_KEY 等）
  const client = new Anthropic({timeout: endpoint.timeoutMs, maxRetries: 1, ...(endpoint.apiKey ? {apiKey: endpoint.apiKey} : {})});
  const serverFallback = SERVER_FALLBACK_MODELS.has(endpoint.model);
  return async ({system, user, schema}) => {
    const params = {
      model: endpoint.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      output_config: {effort: 'low', format: {type: 'json_schema', schema}},
      messages: [{role: 'user', content: user}],
    };
    let response;
    try {
      // 伺服器端備援：模型因安全政策拒答時，由 API 自動改以備援模型重跑同一請求（Haiku 5.5 不支援，直接送一般請求）
      response = serverFallback
        ? await client.beta.messages.create({...params, betas: [SERVER_FALLBACK_BETA], fallbacks: 'default'})
        : await client.messages.create(params);
    } catch (err) {
      throw errorWithCode(err instanceof Anthropic.AuthenticationError ? 'LLM_AUTH'
        : err instanceof Anthropic.RateLimitError ? 'LLM_RATE_LIMIT'
        : err instanceof Anthropic.BadRequestError ? 'LLM_BAD_REQUEST'
        : err instanceof Anthropic.APIConnectionError ? 'LLM_NETWORK'
        : err instanceof Anthropic.APIError ? `LLM_HTTP_${err.status}` : 'LLM_ERROR');
    }
    const usage = {input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0};
    if (response.stop_reason === 'refusal') return {text: '', usage, stop: 'LLM_REFUSAL'};
    if (response.stop_reason === 'max_tokens') return {text: '', usage, stop: 'LLM_TRUNCATED'};
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('');
    return {text, usage, stop: null};
  };
}

/** 任何相容 /chat/completions 的端點（OpenAI、Gemini 相容端點、Ollama、vLLM……），以 JSON 模式取得輸出。 */
export function openAiCompatibleSender(endpoint) {
  if (!endpoint.apiKey && endpoint.location !== 'local') {
    throw new Error('雲端的 openai-compatible 端點需要金鑰（FOMO_LLM_API_KEY 或端點設定的 apiKeyEnv）');
  }
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async ({system, user, schema}) => {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(endpoint.timeoutMs),
      headers: {'content-type': 'application/json', ...(endpoint.apiKey ? {authorization: `Bearer ${endpoint.apiKey}`} : {})},
      body: JSON.stringify({
        model: endpoint.model,
        response_format: {type: 'json_object'},
        messages: [
          {role: 'system', content: `${system}\n\n只輸出一個 JSON 物件，必須符合這個 JSON Schema：\n${JSON.stringify(schema)}`},
          {role: 'user', content: user},
        ],
      }),
    });
    if (!res.ok) throw errorWithCode(res.status === 401 ? 'LLM_AUTH' : res.status === 429 ? 'LLM_RATE_LIMIT' : `LLM_HTTP_${res.status}`);
    const body = await res.json();
    const choice = body.choices?.[0];
    const usage = {input: body.usage?.prompt_tokens ?? 0, output: body.usage?.completion_tokens ?? 0};
    if (choice?.finish_reason === 'length') return {text: '', usage, stop: 'LLM_TRUNCATED'};
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) return {text: '', usage, stop: 'LLM_REFUSAL'};
    return {text: choice?.message?.content ?? '', usage, stop: null};
  };
}

/**
 * 依端點設定建立用戶端。
 * @param {{provider:string, model:string, baseUrl?:string, apiKey?:string, location:string, timeoutMs:number, price?:object|null}} endpoint
 */
export async function createEndpointClient(endpoint) {
  const price = endpoint.price ?? DEFAULT_PRICES[endpoint.model] ?? null;
  const meta = {provider: endpoint.provider, model: endpoint.model, location: endpoint.location, price};
  if (endpoint.provider === 'anthropic') return wrap(meta, await anthropicSender(endpoint));
  if (endpoint.provider === 'openai-compatible') return wrap(meta, openAiCompatibleSender(endpoint));
  throw new Error(`不支援的模型供應商：${endpoint.provider}`);
}
