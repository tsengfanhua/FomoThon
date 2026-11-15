// 技能中樞：/api/hub/* 路由（src/hub/routes.js）的整合測試。
// 真實啟動伺服器（隨機埠，FOMO_HUB_JOBS=0），環境變數指到暫存資料夾裡的 fixture 資料庫。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {loadConfig} from '../src/config.js';
import {start} from '../src/http/server.js';
import {createHub} from '../src/hub/index.js';
import {createClock} from '../src/util.js';
import {TODAY, baseEnv} from './helpers.js';
import {ADVISORS, PAGE_SIZE, TAKEN, TRANSCRIPT, buildFixture, client, exit, fakeSpawn, login, query, writeTranscripts} from './hub-fixtures.js';

let tmp;
let fixtureEnv;
let ctx; // FOMO_HUB_JOBS=0 的伺服器
let s01;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  fixtureEnv = buildFixture(path.join(tmp, 'main'));
  writeTranscripts(fixtureEnv.FOMO_HUB_ROOT);
  ctx = await start(loadConfig({...baseEnv, ...fixtureEnv, FOMO_HUB_JOBS: '0', PORT: '0'}));
  s01 = await login(ctx.url, 'S01');
});

after(async () => {
  await ctx?.stop();
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});

test('routes：未登入時 /api/hub 的端點一律回 401', async () => {
  const anonymous = client(ctx.url);
  const reads = ['/api/hub/overview', '/api/hub/competitions', '/api/hub/competitions/test-abc123', '/api/hub/advisors', '/api/hub/courses',
    `/api/hub/courses/search?${query({q: '資料'})}`, '/api/hub/demo-transcripts', '/api/hub/jobs/J-abcdef'];
  const writes = ['/api/hub/student/skills', '/api/hub/student/analyze', '/api/hub/match', '/api/hub/competitions/crawl'];

  for (const urlPath of reads) {
    const res = await anonymous('GET', urlPath);
    assert.equal(res.status, 401, urlPath);
    assert.deepEqual([res.json.success, res.json.data, res.json.error.code], [false, null, 'UNAUTHORIZED'], urlPath);
  }
  for (const urlPath of writes) assert.equal((await anonymous('POST', urlPath, {enrollments: TAKEN})).status, 401, urlPath);
});

test('routes：登入後可讀取總覽、比賽、教師、課程與示範成績單', async () => {
  const overview = await s01('GET', '/api/hub/overview');
  const competitions = await s01('GET', '/api/hub/competitions');
  const competition = await s01('GET', '/api/hub/competitions/test-abc123');
  const advisors = await s01('GET', '/api/hub/advisors');
  const courses = await s01('GET', '/api/hub/courses');
  const search = await s01('GET', `/api/hub/courses/search?${query({q: '資料'})}`);
  const transcripts = await s01('GET', '/api/hub/demo-transcripts');

  for (const res of [overview, competitions, competition, advisors, courses, search, transcripts]) {
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.success, res.json.error], [true, null]);
    assert.ok(!res.text.includes(tmp), '回應不得含伺服器端的檔案路徑');
  }
  assert.deepEqual(overview.json.data.ready, {esco: true, courses: true, hub: true});
  assert.deepEqual([overview.json.data.jobsEnabled, overview.json.data.namesMasked, overview.json.data.today], [false, true, TODAY]);
  assert.deepEqual(overview.json.data.bridge, {competitionSkills: 6, taughtByCourses: 4, coveredByAdvisors: 5});
  assert.deepEqual(competitions.json.data.map(c => c.id), ['test-old456', 'test-today99', 'test-abc123', 'test-nodate7']);
  assert.deepEqual([competition.json.data.name, competition.json.data.skills.length, competition.json.data.skills[0].label], ['測試黑客松', 4, 'Python 程式設計']);
  assert.deepEqual([advisors.json.data.total, advisors.json.data.items.length, advisors.json.data.pageSize], [30, 24, PAGE_SIZE]);
  assert.deepEqual([courses.json.data.total, courses.json.data.items[0].courseId], [7, 'C-114-2-CS201']);
  assert.deepEqual(search.json.data.map(c => c.courseId), ['C-114-2-CS201', 'C-113-2-CS201']);
  assert.deepEqual(transcripts.json.data[0], {id: 'student_demo_001', label: '示範學生 1', enrollments: TAKEN});
  assert.ok(!transcripts.text.includes('grade'), '示範成績單不得帶出成績');
});

test('routes：教師清單的查詢參數（q、college、page），姓名維持遮蔽', async () => {
  const byCollege = await s01('GET', `/api/hub/advisors?${query({college: '資訊學院'})}`);
  const bySkill = await s01('GET', `/api/hub/advisors?${query({q: '機器學習'})}`);
  const byName = await s01('GET', `/api/hub/advisors?${query({q: '王大明'})}`);
  const second = await s01('GET', `/api/hub/advisors?${query({page: 2})}`);
  const courseHits = await s01('GET', `/api/hub/courses?${query({q: 'presentation', page: 1})}`);

  assert.deepEqual(byCollege.json.data.items.map(a => [a.id, a.name]), [['T001', '王Ｏ明'], ['T003', '陳Ｏ']]);
  assert.deepEqual(bySkill.json.data.items.map(a => a.id), ['T001']);
  assert.equal(byName.json.data.total, 0, '遮蔽時不能用姓名搜尋到人');
  assert.deepEqual([second.json.data.page, second.json.data.items.length], [2, 6]);
  for (const res of [byCollege, bySkill, second]) {
    for (const [, fullName] of ADVISORS) assert.ok(!res.text.includes(fullName), fullName);
  }
  assert.deepEqual(courseHits.json.data.items.map(c => c.courseId), ['C-114-2-CS201', 'C-113-1-GE101']);
});

test('routes：課程搜尋至少要 2 個字', async () => {
  assert.deepEqual((await s01('GET', `/api/hub/courses/search?${query({q: '資'})}`)).json.data, []);
  assert.deepEqual((await s01('GET', '/api/hub/courses/search')).json.data, []);
  assert.deepEqual((await s01('GET', `/api/hub/courses/search?${query({q: '  統計  '})}`)).json.data.map(c => c.name), ['統計學']);
});

test('routes：POST student/skills 與 match 回傳能力分析與參賽配對', async () => {
  const skills = await s01('POST', '/api/hub/student/skills', {enrollments: TRANSCRIPT});
  const match = await s01('POST', '/api/hub/match', {competitionId: 'test-abc123', enrollments: TRANSCRIPT});

  assert.equal(skills.status, 200);
  assert.deepEqual(skills.json.data.courses.map(c => c.status), ['matched', 'matched', 'matched', 'matched', 'not_found']);
  assert.deepEqual([skills.json.data.skills.length, skills.json.data.pending, skills.json.data.unresolved], [3, 1, 1]);
  assert.equal(match.status, 200);
  assert.deepEqual(match.json.data.coverage, {exact: 1, related: 1, none: 2, percent: 38});
  assert.deepEqual(match.json.data.required.map(r => r.level), ['related', 'none', 'exact', 'none']);
  assert.deepEqual(match.json.data.courses.map(c => c.courseId), ['C-114-1-CS401', 'C-113-1-GE101', 'C-114-1-CS402']);
  assert.deepEqual(match.json.data.advisors.map(a => [a.id, a.name, a.score]), [['T001', '王Ｏ明', 85], ['T002', '李Ｏ華', 15], ['T003', '陳Ｏ', 14]]);
  assert.equal(match.json.data.trace.length, 5);
  for (const res of [skills, match]) assert.ok(!res.text.includes('"grade"'), '多送的成績欄位會被丟棄，不會出現在回應');
});

test('routes：不合法的輸入回 400', async () => {
  const badInput = async (method, urlPath, body) => {
    const res = await s01(method, urlPath, body);
    assert.equal(res.status, 400, `${method} ${urlPath} ${JSON.stringify(body ?? null)}`);
    assert.deepEqual([res.json.success, res.json.error.code], [false, 'INVALID_INPUT']);
  };
  const [valid] = TAKEN;

  // 比賽編號格式
  await badInput('GET', '/api/hub/competitions/Test-ABC123');
  await badInput('GET', '/api/hub/competitions/abc123');
  await badInput('POST', '/api/hub/match', {competitionId: 'test-abc123;drop', enrollments: [valid]});
  await badInput('POST', '/api/hub/match', {enrollments: [valid]});
  // 修課清單
  await badInput('POST', '/api/hub/match', {competitionId: 'test-abc123', enrollments: []});
  await badInput('POST', '/api/hub/student/skills', {enrollments: []});
  await badInput('POST', '/api/hub/student/skills', {});
  await badInput('POST', '/api/hub/student/skills', {enrollments: 'CS101'});
  await badInput('POST', '/api/hub/student/skills', {enrollments: Array.from({length: 61}, () => valid)});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, course_code: 'CS-101'}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, course_code: "1' OR '1'='1"}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, course_code: 'ABCDEFGHIJK'}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, academic_year: 99}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, academic_year: '113'}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, semester: 5}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, course_name: ''}]});
  await badInput('POST', '/api/hub/student/skills', {enrollments: [{...valid, course_name: '課'.repeat(81)}]});
  await badInput('POST', '/api/hub/student/analyze', {enrollments: []});
  // 分頁與查詢字串
  for (const page of ['0', '-1', '1.5', 'abc', '10001']) {
    await badInput('GET', `/api/hub/advisors?${query({page})}`);
    await badInput('GET', `/api/hub/courses?${query({page})}`);
  }
  await badInput('GET', `/api/hub/advisors?${query({q: '字'.repeat(61)})}`);
  await badInput('GET', `/api/hub/advisors?${query({college: '院'.repeat(41)})}`);
  await badInput('GET', `/api/hub/courses/search?${query({q: '字'.repeat(41)})}`);
  // 爬蟲網址只接受 https
  await badInput('POST', '/api/hub/competitions/crawl', {url: 'http://contest.example/abc'});
  await badInput('POST', '/api/hub/competitions/crawl', {url: 'https://contest.example/a b'});
  // 工作編號格式
  await badInput('GET', '/api/hub/jobs/abc');
  await badInput('GET', '/api/hub/jobs/J-1');
});

test('routes：找不到的比賽與工作回 404', async () => {
  const [valid] = TAKEN;

  const detail = await s01('GET', '/api/hub/competitions/test-zzz999');
  const match = await s01('POST', '/api/hub/match', {competitionId: 'test-zzz999', enrollments: [valid]});
  const job = await s01('GET', '/api/hub/jobs/J-abcdef');

  for (const res of [detail, match, job]) {
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, 'NOT_FOUND');
  }
});

test('routes：FOMO_HUB_JOBS=0 時啟動爬蟲或課程分析回 409，且不留下稽核紀錄', async () => {
  const admin = await login(ctx.url, 'A01');

  const latest = await s01('POST', '/api/hub/competitions/crawl', {});
  const byUrl = await s01('POST', '/api/hub/competitions/crawl', {url: 'https://contest.example/abc'});
  const analyze = await s01('POST', '/api/hub/student/analyze', {enrollments: TAKEN});
  const audit = (await admin('GET', '/api/admin/audit')).json.data;

  for (const res of [latest, byUrl, analyze]) {
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'DISABLED');
  }
  assert.ok(!audit.some(a => a.action.startsWith('hub_')));
});

test('routes：讀取類端點開放給教師與管理者', async () => {
  const teacher = await login(ctx.url, 'T01');
  const admin = await login(ctx.url, 'A01');

  for (const call of [teacher, admin]) {
    assert.equal((await call('GET', '/api/hub/overview')).status, 200);
    assert.equal((await call('GET', '/api/hub/competitions/test-abc123')).status, 200);
    assert.equal((await call('POST', '/api/hub/match', {competitionId: 'test-abc123', enrollments: TAKEN})).status, 200);
  }
});

test('routes：開放即時分析時可啟動工作、查詢進度並留下稽核紀錄；別人查不到、管理者查得到', async () => {
  const fake = fakeSpawn();
  const config = loadConfig({...baseEnv, ...fixtureEnv, FOMO_HUB_JOBS: '1', PORT: '0'});
  const live = await start(config, {hub: createHub({config, clock: createClock(TODAY), spawnImpl: fake.spawnImpl})});
  try {
    const owner = await login(live.url, 'S01');
    const other = await login(live.url, 'S02');
    const admin = await login(live.url, 'A01');
    const url = 'https://contest.example/new-contest';

    // 爬蟲：啟動 → 執行中 → 完成
    const started = await owner('POST', '/api/hub/competitions/crawl', {url});
    assert.equal(started.status, 200);
    assert.deepEqual([started.json.data.kind, started.json.data.status], ['crawl', 'running']);
    // 使用者貼的網址只佔一個參數；其餘（日期、資料庫位置）都來自伺服器設定
    assert.deepEqual(fake.calls[0].args.slice(0, 4), ['-m', 'scripts.crawl_competitions', '--url', url]);
    assert.deepEqual(fake.calls[0].args.slice(4), ['--today', TODAY, '--hub-db', fixtureEnv.FOMO_HUB_DB,
      '--esco-db', fixtureEnv.FOMO_HUB_ESCO_DB, '--course-db', fixtureEnv.FOMO_HUB_COURSE_DB]);
    const jobPath = `/api/hub/jobs/${started.json.data.id}`;
    const busy = await other('POST', '/api/hub/competitions/crawl', {});
    assert.deepEqual([busy.status, busy.json.error.code], [409, 'BUSY']);
    assert.equal((await other('GET', jobPath)).status, 404);
    assert.equal((await admin('GET', jobPath)).json.data.status, 'running');
    exit(fake.calls[0].child, 0, '{"entity":"competition","saved":1}\n');
    const done = (await owner('GET', jobPath)).json.data;
    assert.deepEqual([done.status, done.summary, done.error], ['done', {entity: 'competition', saved: 1}, null]);

    // 課程分析：只把驗證過的欄位交給子程序
    const analysis = await owner('POST', '/api/hub/student/analyze', {enrollments: TRANSCRIPT});
    assert.equal(analysis.status, 200);
    assert.deepEqual(fake.calls[1].args, ['-m', 'scripts.analyze_course_skills', '--enrollments-stdin',
      '--esco-db', fixtureEnv.FOMO_HUB_ESCO_DB, '--course-db', fixtureEnv.FOMO_HUB_COURSE_DB]);
    assert.deepEqual(JSON.parse(fake.calls[1].stdin), TAKEN, '成績不會傳給分析程式');
    exit(fake.calls[1].child, 1);
    const failed = (await owner('GET', `/api/hub/jobs/${analysis.json.data.id}`)).json.data;
    assert.deepEqual([failed.kind, failed.status], ['courses', 'failed']);

    const audit = (await admin('GET', '/api/admin/audit')).json.data;
    const crawlLog = audit.find(a => a.action === 'hub_crawl_started');
    const analysisLog = audit.find(a => a.action === 'hub_course_analysis_started');
    assert.deepEqual([crawlLog.userId, crawlLog.target, crawlLog.detail], ['S01', started.json.data.id, {mode: 'url', url}], '稽核紀錄查得到是誰貼了哪個網址');
    assert.deepEqual([analysisLog.userId, analysisLog.target, analysisLog.detail], ['S01', analysis.json.data.id, {courses: TRANSCRIPT.length}]);
    assert.equal(audit.filter(a => a.action === 'hub_crawl_started').length, 1, '被拒絕的請求不寫稽核紀錄');
  } finally {
    for (const call of fake.calls) call.child.emit('close', 1); // 斷言失敗時也要結束工作，避免留下逾時計時器
    await live.stop();
  }
});
