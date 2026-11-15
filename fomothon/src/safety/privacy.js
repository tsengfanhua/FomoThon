// 送往雲端模型前的個資保護：
// (1) 遮蔽：Email、手機與市話、身分證字號與統一證號、學號一律換成標記（路由器對所有雲端端點自動執行）；
// (2) 代號化：人名換成〔人員1〕這類代號，模型回覆後在本機換回。
// 遮蔽是規則式的，只涵蓋常見格式；全形英數會先轉半形再比對。

const SEP = '[-\\s.]?';
const PII_RULES = Object.freeze([
  // 前面不能緊接著 Email 可用的字元：每段連續字元只會從開頭比對一次，耗時與長度成正比
  {kind: 'email', re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, mask: '〔Email〕'},
  // 身分證字號與新式統一證號（第二碼 1、2、8、9）；舊式居留證號（第二碼 A～D）
  {kind: 'national_id', re: /(?<![A-Za-z0-9])[A-Za-z][1289]\d{8}(?!\d)/g, mask: '〔身分證字號〕'},
  {kind: 'resident_id', re: /(?<![A-Za-z0-9])[A-Za-z][A-Da-d]\d{8}(?!\d)/g, mask: '〔居留證號〕'},
  {kind: 'mobile', re: new RegExp(`(?<!\\d)(?:\\+886${SEP}|0)9\\d{2}${SEP}\\d{3}${SEP}\\d{3}(?!\\d)`, 'g'), mask: '〔電話〕'},
  {kind: 'landline', re: new RegExp(`(?<!\\d)(?:\\(0[2-8]\\d?\\)\\s?|0[2-8]\\d?${SEP}|\\+886${SEP}\\(?[2-8]\\d?\\)?${SEP})\\d{3,4}${SEP}\\d{4}(?!\\d)`, 'g'), mask: '〔電話〕'},
  {kind: 'student_id', re: /(?<![A-Za-z0-9])[A-Za-z]\d{7,8}(?!\d)/g, mask: '〔學號〕'},
]);
const MIN_NAME_LENGTH = 2;

/** 全形英數與符號（U+FF01–U+FF5E）轉半形、全形空白轉半形。長度不變，比對到的位置可以直接對回原文。 */
const fold = text => text.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');

/**
 * 遮蔽文字中的個資。比對在轉半形後的文字上進行，替換在原文上進行（原文其他字元不變）。
 * @param {string} text
 * @returns {{text:string, redactions:number, counts:Record<string, number>}}
 */
export function redactPii(text) {
  const original = String(text ?? '');
  const folded = fold(original);
  const spans = [];
  for (const rule of PII_RULES) {
    for (const m of folded.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some(s => start < s.end && end > s.start)) spans.push({start, end, rule});
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const counts = {};
  let out = '';
  let at = 0;
  for (const s of spans) {
    out += original.slice(at, s.start) + s.rule.mask;
    at = s.end;
    counts[s.rule.kind] = (counts[s.rule.kind] ?? 0) + 1;
  }
  return {text: out + original.slice(at), redactions: spans.length, counts};
}

/**
 * 把資料中出現的人名換成代號，回傳換好的資料與還原函式。
 * @param {unknown} value 任意 JSON 資料
 * @param {string[]} names 要代號化的人名（少於 2 個字的不處理，避免把一般用字換掉；資料契約要求姓名至少 2 個字）
 * @returns {{value:unknown, restore:(text:string)=>string, codes:string[]}}
 */
export function pseudonymize(value, names) {
  const unique = [...new Set(names.filter(n => typeof n === 'string' && n.length >= MIN_NAME_LENGTH))].sort((a, b) => b.length - a.length);
  const codeOf = new Map(unique.map((name, i) => [name, `〔人員${i + 1}〕`]));
  const swap = text => unique.reduce((acc, name) => acc.split(name).join(codeOf.get(name)), text);
  const walk = v => {
    if (typeof v === 'string') return swap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const restore = text => [...codeOf.entries()].reduce((acc, [name, code]) => acc.split(code).join(name), String(text ?? ''));
  return {value: walk(value), restore, codes: [...codeOf.values()]};
}

/**
 * 還原後仍殘留代號（模型自創了代號，或把代號改寫成全形數字、方括號、加空白等變體）就不可採用。
 * @param {string} text
 */
export const hasLeftoverCode = text => /人員\s*\d+/.test(fold(String(text ?? '')).normalize('NFKC'));
