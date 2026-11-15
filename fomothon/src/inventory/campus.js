// 示意課綱站＋課綱爬蟲。
// 示意課綱站模擬「校內課綱查詢頁」這個外部系統；爬蟲把它當成不可信來源：
// 只抽取固定欄位、去除標籤與控制字元、限制長度，不執行其中任何內容。
import {decodeHtml, escapeHtml, sha256} from '../util.js';
import {ToolError, injectFault} from '../agents/tools.js';
import {findSuspiciousContent} from '../safety/guard.js';

const COURSE_CODE = /^[A-Z]{2}\d{3}$/;
const MAX_FIELD_LENGTH = 400;
const MAX_RAW_FIELD = 4000; // 清理前先截斷，避免超長內容拖慢正則
const MAX_WEEKS = 30;
const MAX_ASSESSMENTS = 20;
const MAX_PAGE_BYTES = 200_000; // 課綱頁大小上限
const ATTRIBUTE_SCAN = 300; // 只在標籤開頭這麼多字元內找屬性

/** 示意課綱站：把課程資料輸出成 HTML 頁面。 */
export function renderSyllabusHtml(course) {
  const s = course.syllabus;
  const weeks = s.weeks.map((w, i) => `<tr data-week="${i + 1}"><td>${i + 1}</td><td>${escapeHtml(w)}</td></tr>`).join('\n');
  const assess = s.assessments
    .map(a => `<tr data-assess data-weight="${Number(a.weight)}" data-practice="${a.practice ? 1 : 0}"><td>${escapeHtml(a.name)}</td><td>${Number(a.weight)}%</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>課程大綱 ${escapeHtml(course.code)}</title></head>
<body>
<h1 data-field="name">${escapeHtml(course.name)}</h1>
<p data-field="code">${escapeHtml(course.code)}</p>
<section data-field="objectives"><h2>教學目標</h2><p>${escapeHtml(s.objectives)}</p></section>
<section data-field="weeks"><h2>每週進度</h2><table>
${weeks}
</table></section>
<section data-field="assessments"><h2>評量方式</h2><table>
${assess}
</table></section>
<footer>示意資料：本頁為原型展示用的合成課綱。</footer>
</body></html>`;
}

/** 供 HTTP 路由與本機來源共用：回傳 {status, body}。 */
export function campusPage(db, code) {
  if (!COURSE_CODE.test(code)) return {status: 404, body: 'Not Found'};
  const row = db.prepare('SELECT code, name, syllabus FROM courses WHERE code = ?').get(code);
  if (!row) return {status: 404, body: 'Not Found'};
  return {status: 200, body: renderSyllabusHtml({code: row.code, name: row.name, syllabus: JSON.parse(row.syllabus)})};
}

/** 外部文字的清理：先截斷 → 去標籤 → 解碼 → 再去一次標籤 → 去控制字元 → 限長。 */
export function sanitizeText(html) {
  const stripTags = text => text.replace(/<[^>]*>/g, ' ');
  return stripTags(decodeHtml(stripTags(String(html ?? '').slice(0, MAX_RAW_FIELD))))
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD_LENGTH);
}

/** 取出 html 中 marker 之後、open 與 close 之間的內容（以 indexOf 定位，耗時與長度成正比）。 */
function sliceAfter(html, marker, open, close) {
  const at = html.indexOf(marker);
  if (at < 0) return '';
  const start = html.indexOf(open, at);
  if (start < 0) return '';
  const end = html.indexOf(close, start + open.length);
  return end < 0 ? '' : html.slice(start + open.length, end);
}

/** 第 n 個 <td> 的內容（n 從 1 起算）。 */
function cellOf(row, n) {
  const cell = row.split('<td>')[n];
  return cell === undefined ? '' : cell.split('</td>')[0];
}

/**
 * 只抽取白名單欄位；頁面其餘內容（script、註解、隱藏文字）一律忽略。
 * 刻意不對整份文件跑含萬用字元的正則：先以固定字串切段，再逐段處理，惡意頁面也只會花線性時間。
 */
export function parseSyllabusHtml(html) {
  // 清理前先檢查：原始片段（真的標籤）與解碼後的文字（被跳脫的標籤、指令文字）都要看
  const flags = new Set();
  const clean = raw => {
    const head = String(raw ?? '').slice(0, MAX_RAW_FIELD);
    for (const reason of findSuspiciousContent(`${head}\n${decodeHtml(head)}`)) flags.add(reason);
    return sanitizeText(raw);
  };
  const rows = html.split('<tr').slice(1);
  const weeks = [];
  const assessments = [];
  for (const row of rows) {
    const head = row.slice(0, ATTRIBUTE_SCAN).split('>')[0];
    if (weeks.length < MAX_WEEKS && /data-week="\d+"/.test(head)) weeks.push(clean(cellOf(row, 2)));
    const weight = head.match(/data-weight="(\d{1,3})"/);
    const practice = head.match(/data-practice="([01])"/);
    if (assessments.length < MAX_ASSESSMENTS && head.includes('data-assess') && weight && practice) {
      assessments.push({name: clean(cellOf(row, 1)), weight: Number(weight[1]), practice: practice[1] === '1'});
    }
  }
  return {
    name: clean(sliceAfter(html, 'data-field="name"', '>', '</h1>')),
    objectives: clean(sliceAfter(html, 'data-field="objectives"', '<p>', '</p>')),
    weeks,
    assessments,
    suspicious: [...flags],
  };
}

/** 直接讀資料庫的來源（測試與種子建置用，不經網路）。 */
export function localSource(db) {
  return Object.freeze({
    kind: 'local',
    get: async code => ({...campusPage(db, code), url: `local://campus/syllabus/${code}`}),
  });
}

/** 讀取回應內容，超過上限就中止連線（不把整份超大回應讀進記憶體）。 */
async function readLimited(res, limit) {
  if (Number(res.headers.get('content-length')) > limit) throw new ToolError('TOO_LARGE', '課綱頁面超過大小上限');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new ToolError('TOO_LARGE', '課綱頁面超過大小上限');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 以 HTTP 抓取課綱頁。只會存取設定好的 baseUrl，課程代碼先經格式驗證，不跟隨轉址，回應有大小上限。 */
export function httpSource(getBaseUrl, timeoutMs) {
  return Object.freeze({
    kind: 'http',
    get: async code => {
      const url = `${getBaseUrl()}/syllabus/${encodeURIComponent(code)}`;
      const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: {accept: 'text/html'}});
      return {status: res.status, body: await readLimited(res, MAX_PAGE_BYTES), url};
    },
  });
}

/**
 * 課綱爬蟲（工具 syllabus.fetch 的實作）。
 * @returns {(args:{code:string}, ctx:object) => Promise<object>}
 */
export function createSyllabusFetcher(source) {
  return async function fetchSyllabus({code}, ctx) {
    if (!COURSE_CODE.test(code ?? '')) throw new ToolError('BAD_CODE', '課程代碼格式不正確');
    const fault = ctx.faults?.syllabus?.[code];
    if (fault === 'notfound') throw new ToolError('NOT_FOUND', '課綱站查無此課程');
    injectFault(fault, ctx.attempt, '課綱站');

    let res;
    try {
      res = await source.get(code);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new ToolError(timedOut ? 'TIMEOUT' : 'NETWORK', timedOut ? '課綱站連線逾時' : '課綱站無法連線', {transient: true});
    }
    if (res.body.length > MAX_PAGE_BYTES) throw new ToolError('TOO_LARGE', '課綱頁面超過大小上限');
    if (res.status === 404) throw new ToolError('NOT_FOUND', '課綱站查無此課程');
    if (res.status >= 500) throw new ToolError(`HTTP_${res.status}`, '課綱站暫時無法服務', {transient: true});
    if (res.status !== 200) throw new ToolError(`HTTP_${res.status}`, '課綱站回應異常');

    const parsed = parseSyllabusHtml(res.body);
    if (!parsed.objectives && !parsed.weeks.length) throw new ToolError('PARSE_ERROR', '課綱頁面格式無法解析');
    return {code, ...parsed, url: res.url, hash: sha256(res.body).slice(0, 12)};
  };
}
