// 以子程序執行各 Python Agent 的分析程式（比賽爬蟲、課程技能分析），並追蹤執行狀態。
// 不經過 shell：參數是固定清單，使用者輸入只會放在單一參數或標準輸入，無法注入指令。
import {spawn} from 'node:child_process';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {AppError, nowIso, randomToken, safeJsonParse} from '../util.js';

const JOB_TIMEOUT_MS = 8 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const KEEP_JOBS = 40;

/** 可執行的工作種類：在哪個 Agent 的目錄、執行哪個模組。 */
const KINDS = Object.freeze({
  crawl: {agent: 'competition-agent', module: 'scripts.crawl_competitions', label: '競賽 Agent：爬取並分析比賽'},
  courses: {agent: 'course-agent', module: 'scripts.analyze_course_skills', label: '課程 Agent：分析課程技能'},
});

/** 傳給子程序的環境變數白名單：Python 與模型需要的才給，平台自己的密碼與金鑰（存取碼、其他模型的金鑰）不外流。 */
const CHILD_ENV = Object.freeze(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'SKILL_LLM_MODEL', 'COMPETITION_LLM_MODEL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE']);
const childEnv = () => ({
  ...Object.fromEntries(CHILD_ENV.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
  PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
});

/**
 * @param {{root:string, python:string, enabled:boolean, spawnImpl?:typeof spawn}} options
 */
export function createJobRunner({root, python, enabled, spawnImpl = spawn}) {
  const jobs = new Map();

  const publicJob = job => ({
    id: job.id, kind: job.kind, label: KINDS[job.kind].label, status: job.status, startedAt: job.startedAt,
    finishedAt: job.finishedAt, ms: job.ms, summary: job.summary, error: job.error,
  });

  function finish(job, patch) {
    if (job.status !== 'running') return;
    clearTimeout(job.timer);
    Object.assign(job, patch, {finishedAt: nowIso(), ms: Date.now() - job.startedMs});
  }

  /**
   * @param {'crawl'|'courses'} kind
   * @param {{args?:string[], stdin?:string, owner:string}} input
   */
  function start(kind, {args = [], stdin = null, owner}) {
    if (!enabled) throw new AppError('DISABLED', '這台伺服器沒有開放即時分析（FOMO_HUB_JOBS=0）', 409);
    if (!Object.hasOwn(KINDS, kind)) throw new AppError('INVALID_INPUT', '不支援的工作種類');
    if ([...jobs.values()].some(j => j.kind === kind && j.status === 'running')) {
      throw new AppError('BUSY', '同一種分析正在執行，請等它完成', 409);
    }
    const {agent, module} = KINDS[kind];
    const job = {id: `J-${randomToken(6)}`, kind, owner, status: 'running', startedAt: nowIso(), startedMs: Date.now(),
      finishedAt: null, ms: null, summary: null, error: null, stdout: '', timer: null};
    jobs.set(job.id, job);
    // 只保留最近的紀錄；淘汰時跳過還在執行的工作
    for (const [id, old] of jobs) {
      if (jobs.size <= KEEP_JOBS) break;
      if (old.status !== 'running') jobs.delete(id);
    }

    let child;
    try {
      child = spawnImpl(python, ['-m', module, ...args], {
        cwd: path.join(root, agent), env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      // 啟動當下就失敗（例如系統資源不足）：標成失敗，不然這種工作會一直被當成執行中
      process.stderr.write(`[hub:${kind}] 無法啟動子程序：${err?.message ?? err}\n`);
      finish(job, {status: 'failed', error: '無法啟動分析程式，詳情請看伺服器日誌'});
      return publicJob(job);
    }
    job.timer = setTimeout(() => { child.kill(); finish(job, {status: 'failed', error: '分析逾時，已中止'}); }, JOB_TIMEOUT_MS);
    job.timer.unref?.(); // 逾時計時器不該讓伺服器程序無法結束
    // 以串流方式解碼：一個中文字的位元組可能被切在兩段輸出之間，逐段各自轉字串會變成亂碼
    const decoder = new StringDecoder('utf8');
    // 摘要在輸出的最後一行，所以超過上限時保留的是結尾
    child.stdout.on('data', chunk => { job.stdout = (job.stdout + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).slice(-MAX_OUTPUT_BYTES); });
    job.child = child;
    // 子程序的日誌只寫到伺服器端，不回傳給瀏覽器（可能含路徑或服務端細節）
    child.stderr.on('data', chunk => process.stderr.write(`[hub:${kind}] ${chunk}`));
    child.on('error', () => finish(job, {status: 'failed', error: '無法啟動分析程式，請確認 FOMO_HUB_PYTHON 指向已安裝相依套件的 Python'}));
    child.on('close', code => {
      // 各 Agent 的程式在標準輸出的最後一行印出 JSON 摘要
      const summary = safeJsonParse((job.stdout + decoder.end()).trim().split('\n').at(-1) ?? '', null);
      // 只有字串型的 error 是「整個工作失敗」的原因代碼；其他欄位（例如個別項目的失敗筆數）不算
      const reason = typeof summary?.error === 'string' ? summary.error : null;
      if (code === 0 && summary && !reason) finish(job, {status: 'done', summary});
      else finish(job, {status: 'failed', summary, error: reason ? `分析失敗（${reason}）` : '分析程式異常結束，詳情請看伺服器日誌'});
    });
    child.stdin.on('error', () => {}); // 子程序提早結束時寫入會失敗；結果由 close 事件處理
    child.stdin.end(stdin ?? '');
    return publicJob(job);
  }

  function get(id, owner, isAdmin) {
    const job = jobs.get(id);
    if (!job || (!isAdmin && job.owner !== owner)) throw new AppError('NOT_FOUND', '找不到這個分析工作', 404);
    return publicJob(job);
  }

  /** 伺服器關閉時中止還在執行的分析，避免子程序與逾時計時器讓行程無法結束。 */
  function close() {
    for (const job of jobs.values()) {
      if (job.status !== 'running') continue;
      job.child?.kill();
      finish(job, {status: 'failed', error: '伺服器關閉，分析已中止'});
    }
  }

  return Object.freeze({start, get, close, enabled});
}
