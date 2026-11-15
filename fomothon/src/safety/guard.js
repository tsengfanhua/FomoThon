// 安全防護：輸入防護（提示注入、越權請求）、輸出檢核（推薦名單再驗證）、生成文字的事實檢核。

const MAX_GOAL_LENGTH = 300;

const INJECTION_PATTERNS = [
  /忽略.{0,6}(之前|以上|先前|前面|所有|上述).{0,12}(指令|指示|規則|設定|提示)/i,
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)/i,
  /(system\s*prompt|系統提示詞?|開發者模式|developer\s*mode|jailbreak|越獄)/i,
  /(你現在是|從現在起你是|假裝你是|扮演).{0,10}(管理員|管理者|系統|老師|教務)/,
  /(顯示|印出|洩漏|告訴我).{0,10}(提示詞|prompt|內部規則|api\s*key|金鑰|密碼)/i,
];

const UNAUTHORIZED_PATTERNS = [
  /(改|修改|竄改|調高|提高|變更).{0,8}(成績|分數|學分|名額)/,
  /(成績|分數|學分|名額).{0,8}(改成|改為|改到|調高|提高|變更|竄改)/,
  /(刪除|清空|移除).{0,10}(資料庫|所有|全部|紀錄|帳號)/,
  /drop\s+table|delete\s+from|;\s*--/i,
  /(其他|別人|他人|同學|某位|誰).{0,12}(成績|分數|個資|電話|地址|學號|身分證)/,
  /(列出|匯出|顯示|給我|查).{0,10}(所有|全部|全校|每個).{0,8}(學生|成績|名單|個資)/,
  /(不用|不必|跳過|略過|免).{0,8}(確認|同意|授權|審核)/,
];

/**
 * 檢查使用者輸入的目標。
 * @returns {{ok:true, goal:string} | {ok:false, category:string, message:string}}
 */
export function checkGoal(raw) {
  const goal = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!goal) return {ok: false, category: 'empty', message: '請輸入你想完成的事，例如「我想找 Java 相關競賽」。'};
  if (goal.length > MAX_GOAL_LENGTH) return {ok: false, category: 'too_long', message: `目標請控制在 ${MAX_GOAL_LENGTH} 字以內。`};
  if (INJECTION_PATTERNS.some(re => re.test(goal))) {
    return {ok: false, category: 'prompt_injection', message: '這段文字包含試圖改變系統規則的內容，已拒絕執行。請直接描述你的參賽需求。'};
  }
  if (UNAUTHORIZED_PATTERNS.some(re => re.test(goal))) {
    return {ok: false, category: 'unauthorized', message: '這項要求超出參賽助理的權限（不提供他人成績與個資、不變更資料、不略過人工確認），已拒絕執行。'};
  }
  return {ok: true, goal};
}

/**
 * 輸出檢核：推薦名單在呈現給使用者前，再對資料庫驗證一次硬條件。
 * 任何不存在、已不符合條件、重複或指向本人的項目都會被移除並記錄。
 * @returns {{kept:Array, removed:Array<{id:string, reason:string}>}}
 */
export function checkRecommendations(db, studentId, items) {
  const seen = new Set();
  const kept = [];
  const removed = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    const row = db.prepare('SELECT id, role, attrs FROM users WHERE id = ?').get(item.id);
    const attrs = row ? JSON.parse(row.attrs) : null;
    let reason = null;
    if (!row) reason = '對象不存在';
    else if (item.id === studentId) reason = '不可推薦本人';
    else if (seen.has(key)) reason = '重複推薦';
    else if (item.kind === 'teammate' && (row.role !== 'student' || !attrs.openToMatch)) reason = '對方未開放媒合';
    else if (item.kind === 'advisor' && (row.role !== 'teacher' || !attrs.openToAdvise || attrs.used >= attrs.quota)) reason = '教師未開放指導或名額已滿';
    if (reason) removed.push({id: item.id, reason});
    else {
      seen.add(key);
      kept.push(item);
    }
  }
  return {kept, removed};
}

// 生成文字中不該出現的內容：連結、聯絡方式、金流、保證
const GENERATED_DENY = /(https?:|www\.|@|匯款|轉帳|付款|繳費|報名費|帳號|密碼|保證|一定(會|能|可以)?(得獎|入選|錄取))/i;
const MARKUP = /<[a-z/!]|javascript:/i;
const CN_DIGITS = {零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9};
const CN_QUANTITY = /[零一二兩三四五六七八九十百]+(?=\s*(分|成|位|名|隊|天|項|份|個|次|倍|％|%))/g;

/** 中文數字（到 999）轉成數值，例如「九十九」→ 99、「兩」→ 2、「十」→ 10。 */
export function parseChineseNumber(text) {
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (ch in CN_DIGITS) current = CN_DIGITS[ch];
    else if (ch === '十') { total += (current || 1) * 10; current = 0; }
    else if (ch === '百') { total += (current || 1) * 100; current = 0; }
  }
  return total + current;
}

/** 事實資料中可以被引用的數字：數值本身、字串裡的數字，以及清單的筆數。 */
function allowedNumbers(value, out = new Set()) {
  if (typeof value === 'number') out.add(value);
  else if (typeof value === 'string') for (const n of value.match(/\d+(?:\.\d+)?/g) ?? []) out.add(Number(n));
  else if (Array.isArray(value)) {
    out.add(value.length);
    for (const item of value) allowedNumbers(item, out);
  } else if (value && typeof value === 'object') for (const item of Object.values(value)) allowedNumbers(item, out);
  return out;
}

/**
 * 生成文字的事實檢核：LLM 寫的說明只能引用規則算出的事實。
 * (1) 每個數字（含全形與中文數量詞）都必須是事實中的數值或清單筆數，逐一比對、不做子字串比對；
 * (2) 不得提到事實以外的已知人名／競賽名；(3) 不得含連結、聯絡方式、金流或保證用語。
 * 限制：資料庫裡沒有的捏造人名無法偵測，所以生成文字只當作說明；能邀請誰一律以輸出檢核後的名單為準。
 */
export function checkGrounding(text, facts, knownNames) {
  if (typeof text !== 'string' || text.length < 10 || text.length > 600) return {ok: false, reason: '長度不符'};
  const normalized = text.normalize('NFKC'); // 全形數字與符號轉成半形再檢查
  if (MARKUP.test(normalized)) return {ok: false, reason: '包含標記語言'};
  const denied = normalized.match(GENERATED_DENY);
  if (denied) return {ok: false, reason: `包含不允許的內容：${denied[0]}`};
  const allowed = allowedNumbers(facts);
  const numbers = [
    ...(normalized.match(/\d+(?:\.\d+)?/g) ?? []).map(Number),
    ...(normalized.match(CN_QUANTITY) ?? []).map(parseChineseNumber),
  ];
  const badNumber = numbers.find(n => !allowed.has(n));
  if (badNumber !== undefined) return {ok: false, reason: `出現事實資料以外的數字：${badNumber}`};
  const factText = JSON.stringify(facts);
  const badName = knownNames.find(name => normalized.includes(name) && !factText.includes(name));
  if (badName) return {ok: false, reason: `提到事實資料以外的對象：${badName}`};
  return {ok: true};
}

/** LLM 回傳的簡短理由（會顯示在執行紀錄）：只接受不含標記、連結、數字與控制字元的短句。 */
export function checkShortReason(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.normalize('NFKC');
  return normalized.length >= 2 && normalized.length <= 120 && !MARKUP.test(normalized) && !GENERATED_DENY.test(normalized) && !/[\d\u0000-\u001F]/.test(normalized);
}

// 外部文件（課綱、競賽簡章、自填證據）中不該出現的內容。
// 只抓「對模型下指令」與「真的 HTML 標籤」，不抓主題詞：資安或 AI 課程本來就會寫到 System Prompt、Jailbreak、onclick 這些字。
const DOCUMENT_INJECTION = [
  /忽略.{0,6}(之前|以上|先前|前面|所有|上述).{0,12}(指令|指示|規則|設定|提示)/,
  /(ignore|disregard)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|messages?)/i,
  /(系統指令|system\s*instructions?)\s*[:：]/i,
  /<\|im_(start|end)\|>/i,
];
const DOCUMENT_MARKUP = [
  /<\s*\/?\s*(script|iframe|object|embed|svg|style|link|meta)\b/i,
  /<\s*[a-z][^>]*\son[a-z]+\b/i, // 標籤內的事件屬性，例如 <img src=x onerror=...>
  /(href|src)\s*=\s*["']?\s*javascript:/i,
];

/**
 * 外部文件內容檢查：用於資料品質檢核與課綱降級。不修改內容，只回報原因。
 * 應在解碼 HTML 實體之後、去除標籤之前呼叫，才看得到被跳脫的標籤。
 * @param {string} text
 * @returns {Array<'prompt_injection'|'markup'>}
 */
export function findSuspiciousContent(text) {
  const value = String(text ?? '');
  const reasons = [];
  if (DOCUMENT_INJECTION.some(re => re.test(value))) reasons.push('prompt_injection');
  if (DOCUMENT_MARKUP.some(re => re.test(value))) reasons.push('markup');
  return reasons;
}
