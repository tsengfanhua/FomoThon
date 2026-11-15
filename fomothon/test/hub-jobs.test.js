// 技能中樞：以子程序執行 Python Agent（src/hub/jobs.js）的測試。注入假的 spawn，不會真的啟動 Python。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {createJobRunner} from '../src/hub/jobs.js';
import {TODAY} from './helpers.js';
import {TAKEN, buildFixture, createHubMaker, exit, fakeSpawn, isAppError, makeRunner} from './hub-fixtures.js';

const {makeHub, closeHubs} = createHubMaker();
let tmp;
let fixtureEnv; // 「經 createHub」的測試用它指定根目錄與資料庫位置

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  fixtureEnv = buildFixture(path.join(tmp, 'main'));
});

after(() => {
  closeHubs(); // 連同還在執行的假工作一起收尾
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});

test('jobs：結束碼 0 且標準輸出最後一行是 JSON → done，摘要就是那一行', () => {
  const {jobs, calls} = makeRunner();

  const started = jobs.start('crawl', {owner: 'S01', args: ['--limit', '2']});
  calls[0].child.stdout.emit('data', Buffer.from('開始爬取\n略過 1 筆\n'));
  exit(calls[0].child, 0, '{"entity":"competition","saved":2,"skipped":1}\n');
  const done = jobs.get(started.id, 'S01', false);

  assert.match(started.id, /^J-[A-Za-z0-9_-]{6,12}$/);
  assert.deepEqual({...started, id: '', startedAt: ''}, {id: '', kind: 'crawl', label: '競賽 Agent：爬取並分析比賽', status: 'running', startedAt: '', finishedAt: null, ms: null, summary: null, error: null});
  assert.equal(done.status, 'done');
  assert.deepEqual(done.summary, {entity: 'competition', saved: 2, skipped: 1});
  assert.equal(done.error, null);
  assert.ok(!Number.isNaN(Date.parse(done.finishedAt)));
  assert.ok(Number.isInteger(done.ms) && done.ms >= 0);
  assert.deepEqual(Object.keys(done).sort(), ['error', 'finishedAt', 'id', 'kind', 'label', 'ms', 'startedAt', 'status', 'summary'], '不回傳 owner 與原始輸出');
});

test('jobs：結束碼不是 0 → failed，即使有印出摘要', () => {
  const {jobs, calls} = makeRunner();

  const withSummary = jobs.start('crawl', {owner: 'S01'});
  exit(calls[0].child, 1, '{"entity":"competition","saved":0}\n');
  const silent = jobs.start('crawl', {owner: 'S01'});
  exit(calls[1].child, 137);

  const first = jobs.get(withSummary.id, 'S01', false);
  const second = jobs.get(silent.id, 'S01', false);
  assert.deepEqual([first.status, first.error, first.summary], ['failed', '分析程式異常結束，詳情請看伺服器日誌', {entity: 'competition', saved: 0}]);
  assert.deepEqual([second.status, second.error, second.summary], ['failed', '分析程式異常結束，詳情請看伺服器日誌', null]);
});

test('jobs：摘要含 error 欄位 → failed，並帶出錯誤代碼', () => {
  const {jobs, calls} = makeRunner();

  const started = jobs.start('courses', {owner: 'S01'});
  exit(calls[0].child, 0, '{"entity":"course","error":"invalid_enrollments","detail":"格式錯誤"}\n');
  const failed = jobs.get(started.id, 'S01', false);

  assert.deepEqual([failed.kind, failed.label, failed.status, failed.error], ['courses', '課程 Agent：分析課程技能', 'failed', '分析失敗（invalid_enrollments）']);
  assert.equal(failed.summary.error, 'invalid_enrollments');
});

test('jobs：結束碼 0 但最後一行不是 JSON → failed', () => {
  const {jobs, calls} = makeRunner();

  const started = jobs.start('crawl', {owner: 'S01'});
  exit(calls[0].child, 0, '{"entity":"competition","saved":2}\n完成\n');
  const failed = jobs.get(started.id, 'S01', false);

  assert.deepEqual([failed.status, failed.summary, failed.error], ['failed', null, '分析程式異常結束，詳情請看伺服器日誌']);
});

test('jobs：同一種工作執行中再啟動 → 409 BUSY；不同種類可同時執行，結束後可再啟動', () => {
  const {jobs, calls} = makeRunner();
  jobs.start('crawl', {owner: 'S01'});

  assert.throws(() => jobs.start('crawl', {owner: 'S02'}), isAppError(409, 'BUSY'));
  assert.equal(calls.length, 1, '被拒絕時不應啟動子程序');
  const other = jobs.start('courses', {owner: 'S02'});
  assert.equal(other.status, 'running');

  exit(calls[0].child, 0, '{"saved":0}\n');
  const again = jobs.start('crawl', {owner: 'S02'});
  assert.equal(again.status, 'running');
  exit(calls[1].child, 0, '{"analyzed":0}\n');
  exit(calls[2].child, 0, '{"saved":0}\n');
});

test('jobs：enabled=false → 409 DISABLED，不啟動子程序', () => {
  const {jobs, calls} = makeRunner({enabled: false});

  assert.equal(jobs.enabled, false);
  assert.throws(() => jobs.start('crawl', {owner: 'S01'}), isAppError(409, 'DISABLED'));
  assert.equal(calls.length, 0);
});

test('jobs：不支援的工作種類 → 400 INVALID_INPUT', () => {
  const {jobs, calls} = makeRunner();

  assert.throws(() => jobs.start('advisors', {owner: 'S01'}), isAppError(400, 'INVALID_INPUT'));
  assert.throws(() => jobs.start('constructor', {owner: 'S01'}), isAppError(400, 'INVALID_INPUT'), '不可借用物件原型上的名稱');
  assert.equal(calls.length, 0);
});

test('jobs：別的使用者查不到別人的工作（404），管理者查得到', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  assert.equal(jobs.get(started.id, 'S01', false).id, started.id);
  assert.throws(() => jobs.get(started.id, 'S02', false), isAppError(404, 'NOT_FOUND'));
  assert.equal(jobs.get(started.id, 'A01', true).id, started.id);
  assert.throws(() => jobs.get('J-notexist', 'S01', false), isAppError(404, 'NOT_FOUND'));
  assert.throws(() => jobs.get('J-notexist', 'A01', true), isAppError(404, 'NOT_FOUND'));
  exit(calls[0].child, 0, '{"saved":0}\n');
});

test('jobs：以固定參數啟動子程序（不經 shell），工作目錄是對應 Agent 的資料夾', () => {
  const {jobs, calls} = makeRunner();

  jobs.start('crawl', {owner: 'S01', args: ['--limit', '2']});
  const [{command, args, options, stdin, child}] = calls;

  assert.equal(command, 'python-for-test');
  assert.deepEqual(args, ['-m', 'scripts.crawl_competitions', '--limit', '2']);
  assert.equal(options.cwd, path.join('hub-root', 'competition-agent'));
  assert.deepEqual([options.env.PYTHONUTF8, options.env.PYTHONIOENCODING], ['1', 'utf-8']);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(!options.shell, '不可經由 shell 執行');
  assert.equal(stdin, '', '沒有輸入時也要關閉標準輸入');
  exit(child, 0, '{"saved":0}\n');
});

test('jobs（經 createHub）：爬蟲帶網址時傳 --url、沒帶時用設定的筆數；兩者都帶今天日期與資料庫位置', () => {
  const fake = fakeSpawn();
  const jobHub = makeHub({...fixtureEnv, FOMO_HUB_JOBS: '1', FOMO_HUB_CRAWL_LIMIT: '3'}, {spawnImpl: fake.spawnImpl});
  // 資料庫位置來自伺服器設定：Agent 要寫進網站正在讀的那幾個檔案
  const databases = ['--hub-db', fixtureEnv.FOMO_HUB_DB, '--esco-db', fixtureEnv.FOMO_HUB_ESCO_DB, '--course-db', fixtureEnv.FOMO_HUB_COURSE_DB];
  const url = 'https://contest.example/new-contest?id=1&lang=zh';

  const byUrl = jobHub.startCrawl('S01', url);
  exit(fake.calls[0].child, 0, '{"entity":"competition","saved":1}\n');
  jobHub.startCrawl('S01');
  exit(fake.calls[1].child, 0, '{"entity":"competition","saved":3}\n');

  assert.equal(fake.calls[0].command, 'python-for-test');
  assert.deepEqual(fake.calls[0].args, ['-m', 'scripts.crawl_competitions', '--url', url, '--today', TODAY, ...databases]);
  assert.equal(fake.calls[0].options.cwd, path.join(fixtureEnv.FOMO_HUB_ROOT, 'competition-agent'));
  assert.deepEqual(fake.calls[1].args, ['-m', 'scripts.crawl_competitions', '--limit', '3', '--today', TODAY, ...databases]);
  // 子程序只拿到白名單內的環境變數：平台自己的存取碼與其他模型的金鑰不外流
  assert.deepEqual(Object.keys(fake.calls[0].options.env).filter(name => name.startsWith('FOMO_')), []);
  assert.equal(fake.calls[0].options.env.PYTHONUTF8, '1');
  assert.deepEqual(jobHub.job(byUrl.id, 'S01', false).summary, {entity: 'competition', saved: 1});
  assert.throws(() => jobHub.job(byUrl.id, 'S02', false), isAppError(404, 'NOT_FOUND'));
  assert.equal(jobHub.job(byUrl.id, 'A01', true).status, 'done');
  assert.equal(jobHub.overview().jobsEnabled, true);
});

test('jobs（經 createHub）：課程分析把修課清單以 JSON 寫進標準輸入', () => {
  const fake = fakeSpawn();
  const jobHub = makeHub({...fixtureEnv, FOMO_HUB_JOBS: '1'}, {spawnImpl: fake.spawnImpl});

  const started = jobHub.startCourseAnalysis('S01', TAKEN);
  const [{args, options, stdin, child}] = fake.calls;
  exit(child, 0, '{"entity":"course","analyzed":3}\n');

  assert.deepEqual(args, ['-m', 'scripts.analyze_course_skills', '--enrollments-stdin',
    '--esco-db', fixtureEnv.FOMO_HUB_ESCO_DB, '--course-db', fixtureEnv.FOMO_HUB_COURSE_DB]);
  assert.equal(options.cwd, path.join(fixtureEnv.FOMO_HUB_ROOT, 'course-agent'));
  assert.deepEqual(JSON.parse(stdin), TAKEN);
  assert.ok(!args.some(arg => arg.includes('程式設計入門')), '使用者輸入不放進命令列參數');
  assert.deepEqual([started.kind, jobHub.job(started.id, 'S01', false).status], ['courses', 'done']);
});

test('jobs（經 createHub）：FOMO_HUB_JOBS=0 時爬蟲與課程分析都回 409 DISABLED', () => {
  const fake = fakeSpawn();
  const offHub = makeHub({...fixtureEnv, FOMO_HUB_JOBS: '0'}, {spawnImpl: fake.spawnImpl});

  assert.throws(() => offHub.startCrawl('S01', 'https://contest.example/x'), isAppError(409, 'DISABLED'));
  assert.throws(() => offHub.startCourseAnalysis('S01', TAKEN), isAppError(409, 'DISABLED'));
  assert.equal(fake.calls.length, 0);
  assert.equal(offHub.overview().jobsEnabled, false);
});

test('jobs：無法啟動子程序（error 事件）→ failed，提示檢查 FOMO_HUB_PYTHON', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  calls[0].child.emit('error', new Error('spawn python-for-test ENOENT'));
  calls[0].child.emit('close', -2); // 之後的 close 不應改寫結果

  const failed = jobs.get(started.id, 'S01', false);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /FOMO_HUB_PYTHON/);
  assert.ok(!failed.error.includes('ENOENT'), '不把系統錯誤細節回傳給前端');
  assert.equal(jobs.start('crawl', {owner: 'S01'}).status, 'running', '失敗後可以重新啟動');
  exit(calls[1].child, 0, '{"saved":0}\n');
});

test('jobs：子程序提早結束使標準輸入寫入失敗時不丟例外，結果以結束事件為準', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('courses', {owner: 'S01', stdin: '[]'});

  assert.doesNotThrow(() => calls[0].child.stdin.emit('error', new Error('write EPIPE')));
  assert.equal(jobs.get(started.id, 'S01', false).status, 'running');
  exit(calls[0].child, 1);

  assert.equal(calls[0].stdin, '[]');
  assert.equal(jobs.get(started.id, 'S01', false).status, 'failed');
});

test('jobs：超過時間上限會中止子程序並標記為 failed', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  t.mock.timers.tick(8 * 60_000 - 1);
  assert.equal(jobs.get(started.id, 'S01', false).status, 'running');
  assert.equal(calls[0].child.killed, false);
  t.mock.timers.tick(1);
  exit(calls[0].child, 0, '{"saved":9}\n'); // 被中止後才收到的結束事件不應把結果改成成功

  const failed = jobs.get(started.id, 'S01', false);
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual([failed.status, failed.error, failed.summary], ['failed', '分析逾時，已中止', null]);
});

test('jobs：子程序的錯誤輸出只寫到伺服器日誌，不回傳給前端', t => {
  const logged = [];
  t.mock.method(process.stderr, 'write', chunk => { logged.push(String(chunk)); return true; });
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  calls[0].child.stderr.emit('data', Buffer.from('Traceback: secret-server-detail\n'));
  exit(calls[0].child, 1);
  const failed = jobs.get(started.id, 'S01', false);
  t.mock.restoreAll();

  assert.deepEqual(logged, ['[hub:crawl] Traceback: secret-server-detail\n']);
  assert.ok(!JSON.stringify(failed).includes('secret-server-detail'));
});

test('jobs：只保留最近 40 筆工作紀錄', () => {
  const {jobs, calls} = makeRunner();
  const ids = [];
  for (let i = 0; i < 41; i += 1) {
    ids.push(jobs.start('crawl', {owner: 'S01'}).id);
    exit(calls[i].child, 0, `{"saved":${i}}\n`);
  }

  assert.throws(() => jobs.get(ids[0], 'A01', true), isAppError(404, 'NOT_FOUND'), '最舊的一筆已被移除');
  assert.deepEqual(jobs.get(ids[1], 'S01', false).summary, {saved: 1});
  assert.deepEqual(jobs.get(ids[40], 'S01', false).summary, {saved: 40});
});

// ---- 以下三項是撰寫測試時發現、已修正的實作問題（回歸測試） ----

// 逐段把 Buffer 轉成字串時，一個中文字的位元組若被切在兩段之間，兩段各自解碼會變成亂碼（U+FFFD）。
// Python 端的摘要是 ensure_ascii=False，可能含中文，所以要以串流方式解碼。
test('jobs：標準輸出分段剛好切在中文字中間時，摘要裡的文字不應變成亂碼', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});
  const bytes = Buffer.from('{"entity":"competition","detail":"測試黑客松"}\n');
  const cut = bytes.indexOf(Buffer.from('測')) + 1; // 切在「測」的第一個位元組之後

  calls[0].child.stdout.emit('data', bytes.subarray(0, cut));
  exit(calls[0].child, 0, bytes.subarray(cut));

  assert.equal(jobs.get(started.id, 'S01', false).summary.detail, '測試黑客松');
});

// 工作先登記為 running 才呼叫 spawn；spawn 同步丟出例外（例如系統資源不足）時要把這筆工作標成失敗，
// 否則它沒有子程序也沒有逾時計時器，會永遠停在 running，之後同一種工作一律被 409 BUSY 擋下。
test('jobs：啟動子程序時同步丟出例外 → 這筆工作標成 failed，不會讓同一種工作永遠被 BUSY 擋住', t => {
  const logged = [];
  t.mock.method(process.stderr, 'write', chunk => { logged.push(String(chunk)); return true; });
  const fake = fakeSpawn();
  let failNext = true;
  const spawnImpl = (...args) => {
    if (!failNext) return fake.spawnImpl(...args);
    failNext = false;
    throw new Error('spawn ENOMEM');
  };
  const jobs = createJobRunner({root: 'hub-root', python: 'python-for-test', enabled: true, spawnImpl});

  const broken = jobs.start('crawl', {owner: 'S01'});
  const retry = jobs.start('crawl', {owner: 'S01'});
  exit(fake.calls[0].child, 0, '{"saved":0}\n');
  t.mock.restoreAll();

  assert.deepEqual([broken.status, broken.summary], ['failed', null]);
  assert.ok(!JSON.stringify(broken).includes('ENOMEM'), '系統錯誤細節不回傳給前端');
  assert.ok(logged.some(line => line.includes('ENOMEM')), '錯誤細節寫到伺服器日誌');
  assert.equal(jobs.get(broken.id, 'S01', false).status, 'failed');
  assert.equal(retry.status, 'running');
});

// 淘汰舊紀錄時若把還在執行的工作移掉，BUSY 檢查會失效、發起人也查不到自己的工作。
test('jobs：淘汰舊紀錄時跳過還在執行的工作', () => {
  const {jobs, calls} = makeRunner();
  const longRunning = jobs.start('courses', {owner: 'S01'});
  const finished = [];
  for (let i = 1; i <= 41; i += 1) {
    finished.push(jobs.start('crawl', {owner: 'S01'}).id);
    exit(calls[i].child, 0, '{"saved":0}\n');
  }

  assert.equal(jobs.get(longRunning.id, 'S01', false).status, 'running');
  assert.throws(() => jobs.start('courses', {owner: 'S02'}), isAppError(409, 'BUSY'));
  assert.throws(() => jobs.get(finished[0], 'S01', false), isAppError(404, 'NOT_FOUND'), '改為淘汰最舊的已結束工作');
  assert.equal(jobs.get(finished[40], 'S01', false).status, 'done');
  exit(calls[0].child, 0, '{"analyzed":0}\n');
  assert.equal(jobs.get(longRunning.id, 'S01', false).status, 'done');
});

// ---- 審查後補上的邊界情況 ----
test('jobs：輸出超過上限時保留結尾，最後一行的摘要仍讀得到', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  calls[0].child.stdout.emit('data', Buffer.from('x'.repeat(300 * 1024) + '\n'));
  exit(calls[0].child, 0, '{"saved":3}\n');

  assert.deepEqual(jobs.get(started.id, 'S01', false).summary, {saved: 3});
});

test('jobs：close 會中止執行中的子程序並把工作標成失敗', () => {
  const {jobs, calls} = makeRunner();
  const started = jobs.start('crawl', {owner: 'S01'});

  jobs.close();

  assert.equal(calls[0].child.killed, true);
  assert.equal(jobs.get(started.id, 'S01', false).status, 'failed');
  assert.equal(jobs.start('crawl', {owner: 'S01'}).status, 'running', '關閉後同一種工作不會被 BUSY 擋住');
  jobs.close(); // 收尾：不留下執行中的工作
});
