// 極簡 JSON Schema 驗證器（Draft 2020-12 的子集，零相依）。
// 同一套 Schema 用在三個地方：MCP 工具的參數與輸出、LLM 的結構化輸出、種子資料的資料品質檢核。
// 只支援下列關鍵字；遇到不支援的關鍵字或寫錯型別的關鍵字值，assertSupported() 會直接報錯，
// 避免「以為有驗證、其實被略過」。語意盡量與 AJV（官方 MCP SDK 使用的驗證器）一致。

const SUPPORTED = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'format',
]);
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$schema', '$id', 'deprecated', 'readOnly', 'writeOnly']);
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const COUNT_KEYWORDS = ['minItems', 'maxItems', 'minLength', 'maxLength'];
const DEFAULT_MAX_ERRORS = 10;

const isValidDate = text => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(text);
};
// 與 AJV 的 uri 一致：必須有 scheme，且不能含空白或反斜線
const isUri = text => {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\\]*$/.test(text)) return false;
  try {
    return Boolean(new URL(text).protocol);
  } catch {
    return false;
  }
};
const FORMATS = Object.freeze({date: isValidDate, uri: isUri});

const patternCache = new Map();
function regexOf(pattern) {
  if (!patternCache.has(pattern)) patternCache.set(pattern, new RegExp(pattern, 'u'));
  return patternCache.get(pattern);
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite'; // NaN 與 Infinity 不是合法的 JSON 數字
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

const matchesType = (value, type) => {
  const actual = typeOf(value);
  return type === 'number' ? actual === 'number' || actual === 'integer' : actual === type;
};

/** 物件鍵排序後序列化：相等的 JSON 值得到相同字串，用於線性時間的唯一性檢查。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

const deepEqual = (a, b) => a === b || canonical(a) === canonical(b);

const isPlainObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = v => Number.isInteger(v) && v >= 0;

function assertKeywordValues(schema, where) {
  const fail = message => { throw new Error(`${where}：${message}`); };
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.length || !types.every(t => TYPE_NAMES.has(t))) fail(`type 的值不正確：${JSON.stringify(schema.type)}`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) fail('enum 必須是非空陣列');
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) fail('properties 必須是物件');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every(k => typeof k === 'string'))) fail('required 必須是文字陣列');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean' && !isPlainObject(schema.additionalProperties)) fail('additionalProperties 必須是布林值或 Schema');
  if (schema.items !== undefined && !isPlainObject(schema.items)) fail('items 必須是 Schema 物件');
  for (const key of COUNT_KEYWORDS) if (schema[key] !== undefined && !isCount(schema[key])) fail(`${key} 必須是非負整數`);
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && !Number.isFinite(schema[key])) fail(`${key} 必須是數字`);
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') fail('uniqueItems 必須是布林值');
  if (schema.pattern !== undefined && typeof schema.pattern !== 'string') fail('pattern 必須是文字');
  if (schema.format !== undefined && !Object.hasOwn(FORMATS, schema.format)) fail(`不支援的 format「${schema.format}」`);
}

/**
 * 檢查 Schema 只使用本驗證器支援的關鍵字、關鍵字的值型別正確（啟動時呼叫一次）。
 * @param {object} schema
 * @param {string} [where]
 */
export function assertSupported(schema, where = '#') {
  if (!isPlainObject(schema)) throw new Error(`${where}：Schema 必須是物件`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`${where}：不支援的 JSON Schema 關鍵字「${key}」`);
  }
  assertKeywordValues(schema, where);
  if (schema.pattern) regexOf(schema.pattern); // 不合法的正規表示式在這裡就丟出
  for (const [key, child] of Object.entries(schema.properties ?? {})) assertSupported(child, `${where}/properties/${key}`);
  if (schema.items) assertSupported(schema.items, `${where}/items`);
  if (isPlainObject(schema.additionalProperties)) assertSupported(schema.additionalProperties, `${where}/additionalProperties`);
}

function checkString(schema, value, push) {
  const length = [...value].length; // JSON Schema 以 Unicode 字元計算長度
  if (schema.minLength !== undefined && length < schema.minLength) push(`至少 ${schema.minLength} 個字`, 'minLength');
  if (schema.maxLength !== undefined && length > schema.maxLength) push(`最多 ${schema.maxLength} 個字`, 'maxLength');
  if (schema.pattern && !regexOf(schema.pattern).test(value)) push('格式不符', 'pattern');
  if (schema.format && !FORMATS[schema.format](value)) push(`不是合法的 ${schema.format}`, 'format');
}

function checkNumber(schema, value, push) {
  if (schema.minimum !== undefined && value < schema.minimum) push(`不可小於 ${schema.minimum}`, 'minimum');
  if (schema.maximum !== undefined && value > schema.maximum) push(`不可大於 ${schema.maximum}`, 'maximum');
}

function checkArray(schema, value, path, push, state) {
  if (schema.minItems !== undefined && value.length < schema.minItems) push(`至少 ${schema.minItems} 項`, 'minItems');
  // 超過項數上限就不再逐項檢查：避免以超長陣列拖慢伺服器（結果已確定不合格）
  if (schema.maxItems !== undefined && value.length > schema.maxItems) return push(`最多 ${schema.maxItems} 項`, 'maxItems');
  if (schema.uniqueItems && new Set(value.map(canonical)).size !== value.length) push('項目不可重複', 'uniqueItems');
  if (schema.items) {
    for (let i = 0; i < value.length && state.errors.length < state.max; i += 1) walk(schema.items, value[i], `${path}[${i}]`, state);
  }
  return undefined;
}

function checkObject(schema, value, path, push, state) {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) push(`缺少必填欄位「${key}」`, 'required');
  }
  for (const [key, child] of Object.entries(value)) {
    if (state.errors.length >= state.max) return;
    const childPath = path ? `${path}.${key}` : key;
    if (schema.properties && Object.hasOwn(schema.properties, key)) walk(schema.properties[key], child, childPath, state);
    else if (schema.additionalProperties === false) push(`不允許的欄位「${key}」`, 'additionalProperties');
    else if (isPlainObject(schema.additionalProperties)) walk(schema.additionalProperties, child, childPath, state);
  }
}

function walk(schema, value, path, state) {
  if (state.errors.length >= state.max) return;
  const push = (message, keyword) => {
    if (state.errors.length < state.max) state.errors.push({path: path || '(root)', message, keyword});
  };
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some(t => matchesType(value, t))) return push(`型別應為 ${types.join(' 或 ')}`, 'type');
  }
  if (typeOf(value) === 'non-finite') return push('不是合法的 JSON 數字', 'type');
  if (schema.const !== undefined && !deepEqual(value, schema.const)) push(`必須等於 ${JSON.stringify(schema.const)}`, 'const');
  if (schema.enum && !schema.enum.some(choice => deepEqual(choice, value))) push(`必須是 ${schema.enum.map(String).join(' / ')} 其中之一`, 'enum');
  const actual = typeOf(value);
  if (actual === 'string') checkString(schema, value, push);
  else if (actual === 'number' || actual === 'integer') checkNumber(schema, value, push);
  else if (actual === 'array') checkArray(schema, value, path, push, state);
  else if (actual === 'object') checkObject(schema, value, path, push, state);
  return undefined;
}

/**
 * 驗證資料是否符合 Schema。不丟例外。
 * @param {object} schema
 * @param {unknown} value
 * @param {{maxErrors?: number}} [opts]
 * @returns {{ok: boolean, errors: Array<{path: string, message: string, keyword: string}>}}
 */
export function validate(schema, value, {maxErrors = DEFAULT_MAX_ERRORS} = {}) {
  const state = {errors: [], max: maxErrors};
  walk(schema, value, '', state);
  return {ok: state.errors.length === 0, errors: state.errors};
}

/** 把錯誤清單轉成一行可讀的訊息（給使用者或 LLM 自我修正用）。 */
export const formatErrors = errors => errors.map(e => `${e.path}：${e.message}`).join('；');
