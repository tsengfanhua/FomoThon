// 極簡輸入驗證：系統邊界（HTTP 輸入、LLM 輸出、外部文件）一律先驗證再使用。
import {AppError} from './util.js';

const fail = (path, msg) => {
  throw new AppError('INVALID_INPUT', `${path || '輸入'}：${msg}`, 400);
};

export const v = {
  string: ({min = 0, max = 500, pattern = null, optional = false, trim = true} = {}) => (value, path) => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (typeof value !== 'string') return fail(path, '必須是文字');
    // 移除控制字元，避免污染紀錄或終端機
    const text = (trim ? value.trim() : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (text.length < min) return fail(path, `至少 ${min} 個字`);
    if (text.length > max) return fail(path, `最多 ${max} 個字`);
    if (pattern && !pattern.test(text)) return fail(path, '格式不正確');
    return text;
  },
  int: ({min = -Infinity, max = Infinity, optional = false} = {}) => (value, path) => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (!Number.isInteger(value)) return fail(path, '必須是整數');
    if (value < min || value > max) return fail(path, `必須介於 ${min}–${max}`);
    return value;
  },
  bool: ({optional = false} = {}) => (value, path) => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (typeof value !== 'boolean') return fail(path, '必須是布林值');
    return value;
  },
  oneOf: (choices, {optional = false} = {}) => (value, path) => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (!choices.includes(value)) return fail(path, `必須是 ${choices.join(' / ')} 其中之一`);
    return value;
  },
  array: (item, {min = 0, max = 50, optional = false} = {}) => (value, path) => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (!Array.isArray(value)) return fail(path, '必須是陣列');
    if (value.length < min || value.length > max) return fail(path, `數量必須介於 ${min}–${max}`);
    return value.map((entry, i) => item(entry, `${path}[${i}]`));
  },
  object: (shape, {optional = false} = {}) => (value, path = '') => {
    if (value === undefined || value === null) return optional ? undefined : fail(path, '必填');
    if (typeof value !== 'object' || Array.isArray(value)) return fail(path, '必須是物件');
    const out = {};
    for (const [key, check] of Object.entries(shape)) {
      const parsed = check(value[key], path ? `${path}.${key}` : key);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out; // 未列在 shape 的欄位一律丟棄
  },
};

/** 不丟例外的版本：用於驗證 LLM 輸出，失敗時回傳 {ok:false} 讓呼叫端退回規則。 */
export function tryValidate(check, value) {
  try {
    return {ok: true, value: check(value, '')};
  } catch (err) {
    return {ok: false, error: err.message};
  }
}
