// 前端共用工具。所有動態內容都以 DOM 節點與 textContent 建立，不使用 innerHTML，避免 XSS。

export const $ = sel => document.querySelector(sel);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 建立 DOM 節點。
 * @param {string} tag
 * @param {Record<string, any>|null} attrs class、on*（事件）、style（物件）或一般屬性
 * @param {...any} children 節點、字串、陣列；null／false 會被略過
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** 呼叫後端 API；統一處理 {success, data, error} 格式。 */
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('NETWORK', '無法連線到伺服器', 0);
  }
  const payload = await res.json().catch(() => null);
  if (!payload || !payload.success) throw new ApiError(payload?.error?.code ?? 'UNKNOWN', payload?.error?.message ?? '發生未知錯誤', res.status);
  return payload.data;
}

let toastTimer = null;
export function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
}

/** 包住非同步動作：失敗時以提示訊息顯示，不讓錯誤無聲消失。 */
export const guard = fn => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : '操作失敗，請再試一次', true);
    if (!(err instanceof ApiError)) throw err;
  }
};

export const chip = (text, tone = '') => h('span', {class: `chip ${tone}`}, text);
export const bar = (value, max) => h('div', {class: 'bar'}, h('i', {style: {width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`}}));

const STATUS_CHIP = {verified: ['已驗證', 'g'], self_reported: ['自述・待驗證', 'a'], inferred: ['推估', 'b'], syllabus: ['課綱證據', 'b']};
export const statusChip = status => chip(...(STATUS_CHIP[status] ?? [status, '']));

const LEVEL_TONE = {初階: '', 中階: 'o', 進階: 'g', 未達初階: 'r'};
export const levelChip = level => chip(level ?? '—', LEVEL_TONE[level] ?? 'b');

export const card = (attrs, ...children) => h('section', {...attrs, class: `card ${attrs?.class ?? ''}`}, ...children);
export const list = items => h('ul', null, items.map(text => h('li', null, text)));

/** 評分分項：名稱｜長條｜得分/配分 */
export function scoreParts(parts, weights, labels) {
  return h('div', {class: 'parts'}, Object.keys(weights).flatMap(key => [
    h('span', null, labels[key] ?? key),
    bar(parts[key] ?? 0, weights[key]),
    h('span', null, parts[key] === null ? '資料暫缺' : `${parts[key]} / ${weights[key]}`),
  ]));
}
