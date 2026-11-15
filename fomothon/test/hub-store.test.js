// 技能中樞：設定（config.js 的 loadHub）、唯讀資料層（src/hub/store.js）與組合邏輯（src/hub/index.js）的測試。
// 以 hub-fixtures.js 在暫存資料夾建立的小型資料庫驗證，不啟動伺服器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {loadConfig} from '../src/config.js';
import {TODAY, baseEnv} from './helpers.js';
import {
  ALL_ADVISORS, COMPETITIONS, EN, PAGE_SIZE, STAMP, TAKEN, U, ZH, addSimilarPairs, advisorRow, buildFixture, createHubMaker, descriptionOf, enroll,
  evidenceOf, hubEnv, idsOf, insertRows, isAppError, skillRows, writeDb, writeTranscripts,
} from './hub-fixtures.js';

const {makeHub, closeHubs} = createHubMaker();
let tmp;
let fixtureEnv;
let hub; // 預設設定（姓名遮蔽）的技能中樞

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
  fixtureEnv = buildFixture(path.join(tmp, 'main'));
  writeTranscripts(fixtureEnv.FOMO_HUB_ROOT);
  hub = makeHub(fixtureEnv);
});

after(() => {
  closeHubs();
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});

// ===========================================================================
// config.js：loadHub
// ===========================================================================
test('技能中樞設定：資料庫位置預設由 FOMO_HUB_ROOT 推得，各項可由環境變數覆寫', () => {
  const root = path.join(os.tmpdir(), 'hub-root-example');

  const defaults = loadConfig({...baseEnv, FOMO_HUB_ROOT: root}).hub;
  const custom = loadConfig({...baseEnv, FOMO_HUB_ROOT: root, FOMO_HUB_ESCO_DB: 'esco.sqlite', FOMO_HUB_COURSE_DB: 'courses.sqlite', FOMO_HUB_DB: 'hub.sqlite',
    FOMO_HUB_PYTHON: 'python-for-test', FOMO_HUB_JOBS: ' On ', FOMO_HUB_SHOW_NAMES: 'TRUE', FOMO_HUB_CRAWL_LIMIT: '3'}).hub;
  const noRoot = loadConfig(baseEnv);

  assert.deepEqual(defaults, {
    root, escoDb: path.join(root, 'data', 'shared', 'esco_skills.sqlite'), courseDb: path.join(root, 'course-agent', 'data', 'processed', 'course_index.sqlite'),
    hubDb: path.join(root, 'data', 'shared', 'skill_hub.sqlite'), python: 'python3', jobs: false, showNames: false, crawlLimit: 6,
    personasFile: path.join(root, 'data', 'shared', 'campus_enrollments.json'),
  });
  assert.deepEqual(custom, {root, escoDb: 'esco.sqlite', courseDb: 'courses.sqlite', hubDb: 'hub.sqlite', python: 'python-for-test', jobs: true, showNames: true, crawlLimit: 3,
    personasFile: path.join(root, 'data', 'shared', 'campus_enrollments.json')});
  assert.equal(loadConfig({...baseEnv, FOMO_HUB_PERSONAS: 'personas.json'}).hub.personasFile, 'personas.json');
  // 會花錢、會對外連線的功能必須明確開啟：沒設定或打錯的值一律視為關閉
  assert.deepEqual(['0', 'disable', 'enabled', ''].map(value => loadConfig({...baseEnv, FOMO_HUB_JOBS: value}).hub.jobs), [false, false, false, false]);
  for (const bad of ['0', '51', '2.5', 'abc']) {
    assert.throws(() => loadConfig({...baseEnv, FOMO_HUB_CRAWL_LIMIT: bad}), /FOMO_HUB_CRAWL_LIMIT|數值格式/, `FOMO_HUB_CRAWL_LIMIT=${bad} 應被拒絕`);
  }
  assert.equal(noRoot.hub.root, path.resolve(noRoot.root, '..'), '未設定時假設三個 Agent 與本專案在同一個上層資料夾');
  assert.equal(loadConfig({...baseEnv, FOMO_HUB_SHOW_NAMES: 'maybe'}).hub.showNames, false, '只有明確開啟才顯示全名');
  assert.throws(() => loadConfig({...baseEnv, FOMO_HUB_CRAWL_LIMIT: 'many'}), /環境變數數值格式錯誤/);
});

// ===========================================================================
// store.js／index.js：以 fixture 資料庫驗證
// ===========================================================================
test('資料庫檔案不存在時：overview 的 ready 都是 false，各清單回空陣列且不丟例外', () => {
  const empty = makeHub(hubEnv(path.join(tmp, 'missing')));

  const overview = empty.overview();
  const student = empty.studentSkills(TAKEN);

  assert.deepEqual(overview.ready, {esco: false, courses: false, hub: false});
  assert.ok(Object.values(overview.counts).every(n => n === 0), JSON.stringify(overview.counts));
  assert.deepEqual(overview.bridge, {competitionSkills: 0, taughtByCourses: 0, coveredByAdvisors: 0});
  assert.deepEqual(overview.topSkills, {competition: [], advisor: [], course: []});
  assert.deepEqual(empty.competitions(), []);
  assert.deepEqual(empty.advisors({}), {total: 0, page: 1, pageSize: PAGE_SIZE, items: [], colleges: []});
  assert.deepEqual(empty.courses({}), {total: 0, page: 1, pageSize: PAGE_SIZE, items: []});
  assert.deepEqual(empty.searchCourses('資料'), []);
  assert.deepEqual(empty.demoTranscripts(), []);
  assert.ok(student.courses.every(c => c.status === 'unavailable' && c.analysis === null && c.skillCount === 0));
  assert.deepEqual([student.skills, student.pending, student.unresolved], [[], 0, TAKEN.length]);
  assert.throws(() => empty.competition('test-abc123'), isAppError(404, 'NOT_FOUND'));
  assert.throws(() => empty.match('test-abc123', TAKEN), isAppError(404, 'NOT_FOUND'));
});

test('資料庫存在但還沒有資料表時，視為尚未建立', () => {
  const dir = path.join(tmp, 'blank');
  const env = hubEnv(dir);
  for (const file of [env.FOMO_HUB_ESCO_DB, env.FOMO_HUB_COURSE_DB, env.FOMO_HUB_DB]) writeDb(file, () => {});
  const blank = makeHub(env);

  assert.deepEqual(blank.overview().ready, {esco: false, courses: false, hub: false});
  assert.deepEqual(blank.competitions(), []);
  assert.equal(blank.advisors({}).total, 0);
  assert.equal(blank.courses({}).total, 0);
});

test('資料庫檔案在伺服器啟動之後才出現，也能接上', () => {
  const dir = path.join(tmp, 'late');
  const late = makeHub(hubEnv(dir));
  assert.deepEqual(late.overview().ready, {esco: false, courses: false, hub: false});
  assert.equal(late.advisors({}).total, 0);

  buildFixture(dir);

  assert.deepEqual(late.overview().ready, {esco: true, courses: true, hub: true});
  assert.equal(late.competitions().length, COMPETITIONS.length);
  assert.equal(late.advisors({}).total, ALL_ADVISORS.length);
  assert.equal(late.courses({}).total, 7);
  assert.equal(late.competition('test-abc123').skills[0].label, ZH.python);
});

test('overview：各項數量、比賽技能在課程與教師端的涵蓋（bridge）與最常見技能', () => {
  const overview = hub.overview();

  assert.deepEqual(overview.ready, {esco: true, courses: true, hub: true});
  assert.deepEqual(overview.counts, {
    escoSkills: 8, escoRelations: 3, // 關聯雙向各存一列，算一組
    similarPairs: 0, // 預設 fixture 沒有語意相近技能的資料表
    competitions: 4, competitionsOpen: 3, advisors: 30, advisorsMapped: 4,
    courses: 13, coursesAnalyzed: 7, coursesMapped: 7, // 已分析＝mapped 6＋unmapped 1；有技能的課 7 門
    competitionSkills: 6, advisorSkills: 7, courseSkills: 7,
  });
  // 比賽需要 6 種技能：課程教了 python、ml、data、pitch；教師多涵蓋 design；目錄外的技能兩邊都沒有
  assert.deepEqual(overview.bridge, {competitionSkills: 6, taughtByCourses: 4, coveredByAdvisors: 5});
  assert.deepEqual(overview.topSkills.competition.map(s => [s.uri, s.count]),
    [[U.pitch, 2], [U.python, 2], [U.data, 1], [U.design, 1], [U.ml, 1], [U.unknown, 1]]);
  assert.deepEqual(overview.topSkills.competition[0], {uri: U.pitch, label: ZH.pitch, en: EN.pitch, description: descriptionOf('pitch'), count: 2});
  assert.deepEqual(overview.topSkills.course.map(s => [s.uri, s.count]),
    [[U.ml, 2], [U.pitch, 2], [U.python, 2], [U.stats, 2], [U.data, 1], [U.dl, 1], [U.programming, 1]]);
  assert.equal(overview.topSkills.advisor.length, 7);
  assert.deepEqual([overview.jobsEnabled, overview.namesMasked, overview.today], [false, true, TODAY], '即時分析要明確開啟才啟用');
});

test('competitions：依截止日排序（沒有截止日排最後），open 依今天判斷', () => {
  const list = hub.competitions();

  assert.deepEqual(list.map(c => [c.id, c.deadline, c.open]), [
    ['test-old456', '2026-10-01', false],
    ['test-today99', TODAY, true], // 截止日當天仍可報名
    ['test-abc123', '2026-12-31', true],
    ['test-nodate7', null, true], // 沒有截止日視為開放
  ]);
  const contest = list[2];
  assert.deepEqual([contest.name, contest.organizer, contest.category, contest.sourceSite, contest.sourceUrl, contest.status],
    ['測試黑客松', '虛構主辦單位', '資訊', 'testsite', 'https://contest.example/test-abc123', 'mapped']);
  assert.deepEqual(contest.eligibility, {students: true, teamSize: '2-4'});
  assert.equal(contest.skillCount, 4);
  assert.deepEqual(contest.skills[0], {uri: U.python, label: ZH.python, en: EN.python}, '清單只帶技能名稱，不帶證據');
  assert.deepEqual(list[3].eligibility, {}, '資格欄位不是合法 JSON 時退回空物件');
  assert.equal(list[1].skillCount, 0);
});

test('competitions：今天往後移，過了截止日的比賽就不再開放', () => {
  const onDeadline = makeHub(fixtureEnv, {today: '2026-12-31'});
  const dayAfter = makeHub(fixtureEnv, {today: '2027-01-01'});

  const openOf = target => Object.fromEntries(target.competitions().map(c => [c.id, c.open]));

  assert.deepEqual(openOf(onDeadline), {'test-old456': false, 'test-today99': false, 'test-abc123': true, 'test-nodate7': true});
  assert.deepEqual(openOf(dayAfter), {'test-old456': false, 'test-today99': false, 'test-abc123': false, 'test-nodate7': true});
  assert.equal(onDeadline.overview().counts.competitionsOpen, 2);
  assert.equal(dayAfter.overview().counts.competitionsOpen, 1);
  assert.equal(dayAfter.competition('test-abc123').open, false);
});

test('competition：回傳條件與技能證據；技能有中文名稱時 label 是中文、en 是英文', () => {
  const contest = hub.competition('test-abc123');
  const expired = hub.competition('test-old456');
  const undated = hub.competition('test-nodate7');

  assert.deepEqual([contest.id, contest.name, contest.deadline, contest.open, contest.model, contest.fetchedAt], ['test-abc123', '測試黑客松', '2026-12-31', true, 'test-model', STAMP]);
  assert.deepEqual(contest.conditions, ['需為在學學生', '每隊 2 至 4 人']);
  assert.deepEqual(contest.skills.map(s => s.uri), [U.python, U.ml, U.data, U.pitch]);
  assert.deepEqual(contest.skills[0], {
    uri: U.python, label: 'Python 程式設計', en: 'Python (computer programming)', description: descriptionOf('python'),
    evidence: evidenceOf('test-abc123', 'python'), sourceSection: 'brief',
  });
  // 沒有中文名稱 → 顯示英文；不在目錄 → 顯示 URI
  assert.deepEqual([expired.skills[0].label, expired.skills[0].en], [EN.design, EN.design]);
  assert.deepEqual([undated.skills[1].label, undated.skills[1].en, undated.skills[1].description], [U.unknown, U.unknown, '']);
  assert.deepEqual(undated.conditions, [], '條件欄位不是合法 JSON 時退回空陣列');
  assert.equal(expired.open, false);
});

test('competition：找不到比賽時丟出 404 的 AppError', () => {
  assert.throws(() => hub.competition('test-zzz999'), isAppError(404, 'NOT_FOUND'));
  assert.throws(() => hub.match('test-zzz999', TAKEN), isAppError(404, 'NOT_FOUND'));
});

test('advisors：教師姓名預設遮蔽，而且遮蔽時不能用姓名搜尋到人', () => {
  const everyone = [...hub.advisors({page: 1}).items, ...hub.advisors({page: 2}).items];
  const names = Object.fromEntries(everyone.map(a => [a.id, a.name]));
  const serialized = JSON.stringify(everyone);

  assert.deepEqual([names.T001, names.T002, names.T003, names.T004, names.T005], ['王Ｏ明', '李Ｏ華', '陳Ｏ', '歐ＯＯ遠', 'J.']);
  for (const [, fullName] of ALL_ADVISORS) assert.ok(!serialized.includes(fullName), `回傳內容不得含完整姓名（${fullName}）`);
  for (const q of ['王大明', '大明', '李小華', 'John', 'Smith', '王Ｏ明']) assert.equal(hub.advisors({q}).total, 0, q);
  assert.equal(hub.overview().namesMasked, true);
});

test('advisors：FOMO_HUB_SHOW_NAMES=1 才顯示全名，並可用姓名搜尋', () => {
  const named = makeHub({...fixtureEnv, FOMO_HUB_SHOW_NAMES: '1'});

  const everyone = [...named.advisors({page: 1}).items, ...named.advisors({page: 2}).items];
  const names = Object.fromEntries(everyone.map(a => [a.id, a.name]));

  assert.deepEqual([names.T001, names.T002, names.T003, names.T004, names.T005], ['王大明', '李小華', '陳美', '歐陽志遠', 'John Smith']);
  assert.deepEqual(idsOf(named.advisors({q: '王大明'})), ['T001']);
  assert.deepEqual(idsOf(named.advisors({q: 'john'})), ['T005'], '搜尋不分大小寫');
  assert.equal(named.overview().namesMasked, false);
  assert.equal(named.match('test-abc123', TAKEN).advisors[0].name, '王大明');
});

// 撰寫測試時發現、已修正的實作問題（回歸測試）：教師的專長與技能證據摘自教師的公開資料，可能含本人姓名；
// 姓名遮蔽時，教師清單與配對結果的 expertise、evidence 欄位也不能出現完整姓名。
test('advisors：姓名遮蔽時，專長與技能證據文字裡的教師姓名也不應外流', () => {
  const env = buildFixture(path.join(tmp, 'evidence'));
  writeDb(env.FOMO_HUB_DB, db => {
    db.prepare("UPDATE entity_skills SET evidence = ? WHERE entity_type = 'advisor' AND entity_id = 'T001' AND concept_uri = ?").run('王大明教授長期研究機器學習', U.ml);
    db.prepare("UPDATE advisors SET expertise_json = ? WHERE teacher_id = 'T001'").run(JSON.stringify(['王大明研究室：電腦視覺']));
  });
  const masked = makeHub(env);
  const named = makeHub({...env, FOMO_HUB_SHOW_NAMES: '1'});

  const listed = masked.advisors({q: '機器學習'});
  const matched = masked.match('test-abc123', TAKEN).advisors;

  assert.ok(!JSON.stringify(listed).includes('王大明'), '教師清單的 expertise 或 evidence 含完整姓名');
  assert.ok(!JSON.stringify(matched).includes('王大明'), '配對結果的 expertise 或 evidence 含完整姓名');
  assert.equal(listed.items[0].skills[0].evidence, '王Ｏ明教授長期研究機器學習');
  assert.deepEqual(listed.items[0].expertise, ['王Ｏ明研究室：電腦視覺']);
  assert.equal(masked.advisors({q: '王大明'}).total, 0, '也不能靠專長文字裡的姓名搜尋到人');
  assert.equal(named.advisors({q: '機器學習'}).items[0].skills[0].evidence, '王大明教授長期研究機器學習', '顯示全名時不更動原文');
});

test('advisors：college 篩選，並可用系所、專長、技能中文名或英文名搜尋', () => {
  const all = hub.advisors({});
  const teacher = hub.advisors({q: '機器學習'}).items[0];

  assert.deepEqual(all.colleges, ['商學院', '管理學院', '設計學院', '資訊學院'], '學院清單不含空值、不重複');
  assert.deepEqual(idsOf(hub.advisors({college: '資訊學院'})), ['T001', 'T003']);
  assert.deepEqual(idsOf(hub.advisors({college: '商學院'})), ['T002']);
  assert.equal(hub.advisors({college: '不存在的學院'}).total, 0);
  assert.deepEqual(hub.advisors({college: '資訊學院'}).colleges, all.colleges, '篩選後仍提供完整的學院清單');
  assert.deepEqual(idsOf(hub.advisors({q: '機器學習'})), ['T001'], '技能中文名');
  assert.deepEqual(idsOf(hub.advisors({q: 'Machine Learning'})), ['T001'], '技能英文名，不分大小寫');
  assert.deepEqual(idsOf(hub.advisors({q: 'deep learning'})), ['T003'], '沒有中文名稱的技能用英文名');
  assert.deepEqual(idsOf(hub.advisors({q: '電腦視覺'})), ['T001'], '專長');
  assert.deepEqual(idsOf(hub.advisors({q: '統計學系'})), ['T002'], '系所');
  assert.deepEqual(idsOf(hub.advisors({q: 'learning', college: '資訊學院'})), ['T001', 'T003']);
  assert.equal(hub.advisors({q: 'learning', college: '商學院'}).total, 0);
  assert.equal(hub.advisors({q: '   '}).total, ALL_ADVISORS.length, '空白關鍵字等於不篩選');
  assert.deepEqual(teacher, {
    id: 'T001', name: '王Ｏ明', college: '資訊學院', department: '資訊工程學系', expertise: ['電腦視覺', '自然語言處理'], status: 'mapped',
    skills: ['ml', 'python', 'pitch'].map(key => ({uri: U[key], label: ZH[key], en: EN[key], description: descriptionOf(key), evidence: evidenceOf('T001', key), sourceSection: 'expertise'})),
  });
  assert.deepEqual(hub.advisors({page: 1}).items.find(a => a.id === 'T005').expertise, [], '專長欄位不是合法 JSON 時退回空陣列');
});

test('advisors：每頁 24 筆的分頁', () => {
  const first = hub.advisors({page: 1});
  const second = hub.advisors({page: 2});
  const third = hub.advisors({page: 3});

  assert.deepEqual([first.total, first.page, first.pageSize, first.items.length], [30, 1, PAGE_SIZE, 24]);
  assert.deepEqual([second.total, second.page, second.items.length], [30, 2, 6]);
  assert.deepEqual([third.total, third.page, third.items], [30, 3, []]);
  assert.equal(new Set([...idsOf(first), ...idsOf(second)]).size, 30, '兩頁不重複、合起來是全部');
  assert.deepEqual(idsOf(hub.advisors({})), idsOf(first), '未指定頁碼時是第一頁');
});

test('courses：只列出已分析且有技能的課程，可用課名或技能名稱搜尋', () => {
  const all = hub.courses({});

  assert.deepEqual([all.total, all.page, all.pageSize], [7, 1, PAGE_SIZE]);
  assert.deepEqual(idsOf(all), ['C-114-2-CS201', 'C-114-1-CS401', 'C-114-1-CS402', 'C-113-2-CS201', 'C-113-2-CS202', 'C-113-1-CS101', 'C-113-1-GE101'], '新學期在前');
  assert.deepEqual(all.items[4], {
    courseId: 'C-113-2-CS202', year: 113, semester: 2, code: 'CS202', name: '統計學',
    skills: [{uri: U.stats, label: EN.stats, en: EN.stats, description: descriptionOf('stats'), evidence: evidenceOf('C-113-2-CS202', 'stats'), sourceSection: 'weekly_schedule'}],
  });
  assert.deepEqual(idsOf(hub.courses({q: '深度'})), ['C-114-1-CS402'], '課名');
  assert.deepEqual(idsOf(hub.courses({q: '機器學習'})), ['C-114-2-CS201', 'C-114-1-CS401'], '課名或技能中文名');
  assert.deepEqual(idsOf(hub.courses({q: 'Live Presentation'})), ['C-114-2-CS201', 'C-113-1-GE101'], '技能英文名，不分大小寫');
  assert.equal(hub.courses({q: '專題研討'}).total, 0, '尚未分析的課程不在清單中');
  assert.deepEqual(hub.courses({page: 2}).items, []);
});

test('searchCourses：以課名搜尋全部課程，萬用字元視為一般文字', () => {
  assert.deepEqual(hub.searchCourses('資料'), [
    {courseId: 'C-114-2-CS201', year: 114, semester: 2, code: 'CS201', name: '資料分析實務'},
    {courseId: 'C-113-2-CS201', year: 113, semester: 2, code: 'CS201', name: '資料分析實務'},
  ]);
  assert.deepEqual(hub.searchCourses('專題').map(c => c.courseId), ['C-114-1-CS301', 'C-114-1-PCT01'], '尚未分析的課程也找得到');
  assert.deepEqual(hub.searchCourses('統計').map(c => c.name), ['統計學'], '課名去掉前後空白');
  assert.deepEqual(hub.searchCourses('%').map(c => c.courseId), ['C-114-1-PCT01'], '% 不是萬用字元');
  assert.deepEqual(hub.searchCourses('_'), [], '_ 不是萬用字元');
  assert.deepEqual(hub.searchCourses('沒有這門課'), []);
});

test('demoTranscripts：只回傳課程識別欄位，不含成績', () => {
  const transcripts = hub.demoTranscripts();

  assert.deepEqual(transcripts.map(t => [t.id, t.label, t.enrollments.length]), [
    ['student_demo_001', '示範學生 1', TAKEN.length],
    ['student_demo_002', '示範學生 2', 2],
    ['student_demo_003', '示範學生 3', 0], // 檔案不是合法 JSON
    ['student_demo_004', '示範學生 4', 0], // 內容不是陣列
  ]);
  assert.deepEqual(transcripts[0].enrollments, TAKEN, '只有學年、學期、選課代碼、課名；非物件的項目略過');
  assert.ok(!JSON.stringify(transcripts).includes('grade'));
  assert.ok(!JSON.stringify(transcripts).includes('credits'));
});

test('studentSkills：修課查找的 matched／not_found／ambiguous 與分析狀態、pending 與 unresolved 計數', () => {
  const result = hub.studentSkills([
    ...TAKEN,
    enroll(114, 1, 'CS302', '體育'), // 分析過、沒有對應技能
    enroll(114, 1, 'CS303', '分析失敗的課'),
    enroll(114, 1, 'DUP01', '重複開課'), // 同代碼同課名有兩筆
    enroll(113, 1, 'CS101', '課名對不上'),
    enroll(112, 1, 'CS101', '程式設計入門'), // 學年不同
  ]);

  assert.deepEqual(result.courses.map(c => [c.courseCode, c.status, c.analysis, c.skillCount]), [
    ['CS101', 'matched', 'mapped', 1],
    ['CS201', 'matched', 'mapped', 2],
    ['CS202', 'matched', 'mapped', 1], // 沒有狀態紀錄但有技能 → 視為已分析
    ['CS301', 'matched', 'pending', 0],
    ['XX999', 'not_found', null, 0],
    ['CS302', 'matched', 'unmapped', 0],
    ['CS303', 'matched', 'failed', 0],
    ['DUP01', 'ambiguous', null, 0],
    ['CS101', 'not_found', null, 0],
    ['CS101', 'not_found', null, 0],
  ]);
  assert.deepEqual(result.courses[0], {academicYear: 113, semester: 1, courseCode: 'CS101', courseName: '程式設計入門', courseId: 'C-113-1-CS101', status: 'matched', analysis: 'mapped', skillCount: 1});
  assert.deepEqual(result.courses[2].courseId, 'C-113-2-CS202', '資料庫裡課名尾端的空白不影響查找');
  assert.deepEqual(result.courses[4], {academicYear: 114, semester: 1, courseCode: 'XX999', courseName: '不存在的課', status: 'not_found', analysis: null, skillCount: 0});
  assert.equal(result.pending, 2, '尚未分析與分析失敗都算待分析');
  assert.equal(result.unresolved, 4, '查不到與無法唯一確定的都算未解析');
});

test('studentSkills：同一技能彙整多門課的來源，來源多的排前面', () => {
  const result = hub.studentSkills(TAKEN);
  const byUri = Object.fromEntries(result.skills.map(s => [s.uri, s]));

  assert.deepEqual(result.skills.map(s => s.uri).sort(), [U.data, U.programming, U.stats]);
  assert.equal(result.skills[0].uri, U.stats);
  assert.deepEqual(byUri[U.stats], {
    uri: U.stats, label: EN.stats, en: EN.stats, description: descriptionOf('stats'),
    sources: [
      {courseName: '資料分析實務', courseCode: 'CS201', evidence: evidenceOf('C-113-2-CS201', 'stats'), sourceSection: 'weekly_schedule'},
      {courseName: '統計學', courseCode: 'CS202', evidence: evidenceOf('C-113-2-CS202', 'stats'), sourceSection: 'weekly_schedule'},
    ],
  });
  assert.deepEqual([byUri[U.data].label, byUri[U.data].en, byUri[U.data].sources.length], ['資料分析', 'perform data analysis', 1]);
  assert.deepEqual([result.pending, result.unresolved], [1, 1]);
  assert.deepEqual(hub.studentSkills([]), {courses: [], skills: [], pending: 0, unresolved: 0});
});

test('match：比賽需求逐項的 level、來源與 coverage', () => {
  const result = hub.match('test-abc123', TAKEN);
  const [python, ml, data, pitch] = result.required;

  assert.deepEqual(result.required.map(r => [r.uri, r.level]), [[U.python, 'related'], [U.ml, 'none'], [U.data, 'exact'], [U.pitch, 'none']]);
  assert.deepEqual(result.coverage, {exact: 1, related: 1, none: 2, percent: 38}, '(1 + 0.5) / 4 = 37.5% → 38');
  // python：學生修過的課教的是它的上位技能 programming
  assert.deepEqual(python, {
    uri: U.python, label: 'Python 程式設計', en: 'Python (computer programming)', description: descriptionOf('python'),
    evidence: evidenceOf('test-abc123', 'python'), sourceSection: 'brief',
    level: 'related', relationNote: '具備它的上位技能', via: {uri: U.programming, label: '電腦程式設計'},
    sources: [{courseName: '程式設計入門', courseCode: 'CS101', evidence: evidenceOf('C-113-1-CS101', 'programming'), sourceSection: 'weekly_schedule'}],
  });
  assert.deepEqual([data.level, data.relationNote, data.via, data.sources.map(s => s.courseCode)], ['exact', null, null, ['CS201']]);
  assert.deepEqual([ml.level, ml.relationNote, ml.via, ml.sources], ['none', null, null, []]);
  assert.deepEqual([pitch.label, pitch.en, pitch.level], ['簡報表達', 'give live presentation', 'none']);
  assert.deepEqual([result.competition.id, result.competition.name, result.competition.conditions.length], ['test-abc123', '測試黑客松', 2]);
  assert.deepEqual([result.student.courses.length, result.student.skillCount, result.student.pending, result.student.unresolved], [5, 3, 1, 1]);
  assert.equal(result.notes.length, 3);
});

test('match：以相關或下位技能涵蓋需求時，標示關聯方向並折半計入', () => {
  const result = hub.match('test-abc123', [enroll(113, 2, 'CS202', '統計學'), enroll(114, 1, 'CS402', '深度學習')]);
  const [python, ml, data] = result.required;

  assert.deepEqual([ml.level, ml.relationNote, ml.via], ['related', '具備它的下位技能', {uri: U.dl, label: EN.dl}]);
  assert.deepEqual([data.level, data.relationNote, data.via], ['related', '具備 ESCO 標示的相關技能', {uri: U.stats, label: EN.stats}]);
  assert.deepEqual(data.sources.map(s => s.courseCode), ['CS202']);
  assert.equal(python.level, 'none');
  assert.deepEqual(result.coverage, {exact: 0, related: 2, none: 2, percent: 25});
});

test('match：推薦課程排除已修過的課（同 course_id 或同課名），依可補的缺口排序', () => {
  const result = hub.match('test-abc123', TAKEN);
  const [first, , third] = result.courses;

  // 缺口＝python（只有相近）、ml、pitch
  assert.deepEqual(result.courses.map(c => c.courseId), ['C-114-1-CS401', 'C-113-1-GE101', 'C-114-1-CS402']);
  assert.ok(!result.courses.some(c => c.courseId === 'C-113-1-CS101'), '已修過的課（同 course_id）不推薦');
  assert.ok(!result.courses.some(c => c.courseId === 'C-114-2-CS201'), '與已修課程同名的課不推薦，即使它能補最多缺口');
  assert.deepEqual(first, {
    courseId: 'C-114-1-CS401', year: 114, semester: 1, code: 'CS401', name: '機器學習導論',
    covers: [
      {uri: U.python, label: ZH.python, en: EN.python, level: 'exact', evidence: evidenceOf('C-114-1-CS401', 'python'), taught: ZH.python},
      {uri: U.ml, label: ZH.ml, en: EN.ml, level: 'exact', evidence: evidenceOf('C-114-1-CS401', 'ml'), taught: ZH.ml},
    ],
  });
  assert.deepEqual(third.covers, [{uri: U.ml, label: ZH.ml, en: EN.ml, level: 'related', evidence: evidenceOf('C-114-1-CS402', 'dl'), taught: EN.dl}], '相近技能：列出課程實際教的技能');
});

test('match：修課清單裡查不到的課，只要課名相同也會從推薦中排除；推薦最多 6 門', () => {
  const sameName = hub.match('test-abc123', [...TAKEN, enroll(112, 2, 'ZZ001', '簡報技巧')]);
  const fewTaken = hub.match('test-abc123', [enroll(113, 2, 'CS202', '統計學')]);

  assert.deepEqual(sameName.courses.map(c => c.courseId), ['C-114-1-CS401', 'C-114-1-CS402']);
  // 只修過統計學：其餘 6 門已分析課程都能補到缺口，補最多的排最前面
  assert.equal(fewTaken.courses.length, 6);
  assert.deepEqual(fewTaken.courses.slice(0, 2).map(c => [c.courseId, c.covers.length]), [['C-114-2-CS201', 3], ['C-114-1-CS401', 2]]);
  assert.ok(!fewTaken.courses.some(c => c.courseId === 'C-113-2-CS202'));
});

test('match：推薦教師的分數與排序，trace 有 5 筆', () => {
  const result = hub.match('test-abc123', TAKEN);
  const [first, , third] = result.advisors;

  // 需求 4 項；缺口＝python、ml、pitch。
  // T001 涵蓋 3/4 需求、3/3 缺口 → 0.6×75＋0.4×100＝85
  // T002 只涵蓋 data → 0.6×25＋0.4×0＝15
  // T003 只有 ml 的下位技能 → 需求 0.5/4、缺口 0.5/3 → 0.6×12.5＋0.4×16.7≈14
  // T004 的技能與比賽無關，不出現
  assert.deepEqual(result.advisors.map(a => [a.id, a.name, a.score, a.requiredCoverage, a.gapCoverage, a.gapsCovered]), [
    ['T001', '王Ｏ明', 85, 75, 100, 3],
    ['T002', '李Ｏ華', 15, 25, 0, 0],
    ['T003', '陳Ｏ', 14, 13, 17, 1],
  ]);
  assert.deepEqual([first.college, first.department, first.expertise], ['資訊學院', '資訊工程學系', ['電腦視覺', '自然語言處理']]);
  assert.deepEqual(first.matches, ['python', 'ml', 'pitch'].map(key => ({uri: U[key], label: ZH[key], en: EN[key], level: 'exact', evidence: evidenceOf('T001', key), has: ZH[key]})));
  assert.deepEqual(third.matches, [{uri: U.ml, label: ZH.ml, en: EN.ml, level: 'related', evidence: evidenceOf('T003', 'dl'), has: EN.dl}]);

  assert.equal(result.trace.length, 5);
  assert.deepEqual(result.trace.map(t => t.type), ['tool_result', 'tool_result', 'gate', 'tool_result', 'tool_result']);
  assert.ok(result.trace.every(t => typeof t.summary === 'string' && Number.isInteger(t.ms) && t.ms >= 0));
  assert.equal(result.trace[0].summary, '競賽 Agent：「測試黑客松」需要 4 項技能、2 項條件');
  assert.equal(result.trace[1].summary, '課程 Agent：5 門修課對應到 3 項技能');
  assert.equal(result.trace[2].summary, '技能比對：具備 1、相近 1、缺口 2');
  assert.equal(result.trace[3].summary, '課程 Agent：3 門已分析課程中，3 門可補上缺口');
  assert.equal(result.trace[4].summary, '教師 Agent：4 位教師中，推薦 3 位');
});

test('match：比賽還沒有分析出技能時，不推薦課程與教師，coverage 無從評估', () => {
  const result = hub.match('test-today99', TAKEN);

  assert.deepEqual(result.required, []);
  assert.deepEqual(result.coverage, {exact: 0, related: 0, none: 0, percent: null});
  assert.deepEqual([result.courses, result.advisors], [[], []]);
  assert.equal(result.trace.length, 5);
});

test('match：語意相近的技能（esco_skill_similar）也折半計入，但不蓋過官方關聯，相似度高的優先', () => {
  const env = buildFixture(path.join(tmp, 'similar'));
  addSimilarPairs(env);
  const similar = makeHub(env);

  const result = similar.match('test-abc123', TAKEN);
  const [python, ml, data, pitch] = result.required;

  assert.deepEqual([similar.overview().counts.escoRelations, similar.overview().counts.similarPairs], [3, 4]);
  // pitch：學生沒修過，但修過語意相近的 stats（0.9）與 programming（0.7）→ 以相似度高的 stats 為準
  assert.deepEqual([pitch.level, pitch.relationNote, pitch.via], ['related', '具備語意相近的技能', {uri: U.stats, label: EN.stats}]);
  assert.deepEqual(pitch.sources.map(s => s.courseCode), ['CS201', 'CS202']);
  // python ↔ programming 同時有官方關聯與相近配對 → 仍標示為官方的上位技能
  assert.deepEqual([python.level, python.relationNote, python.via.uri], ['related', '具備它的上位技能', U.programming]);
  assert.deepEqual([ml.level, data.level], ['none', 'exact']);
  assert.deepEqual(result.coverage, {exact: 1, related: 2, none: 1, percent: 50}, '(1 + 0.5 + 0.5) / 4');
  // 教師端同樣適用：T002 以 stats 相近涵蓋 pitch、T004 以 design 相近涵蓋 ml
  assert.deepEqual(result.advisors.map(a => [a.id, a.score, a.requiredCoverage, a.gapCoverage]), [['T001', 85, 75, 100], ['T002', 29, 38, 17], ['T003', 14, 13, 17], ['T004', 14, 13, 17]]);
  assert.deepEqual(result.advisors[3].matches, [{uri: U.ml, label: ZH.ml, en: EN.ml, level: 'related', evidence: evidenceOf('T004', 'design'), has: EN.design}]);
  // 沒有這張資料表的資料庫（預設 fixture）不受影響
  assert.equal(hub.match('test-abc123', TAKEN).required[3].level, 'none');
});

test('分析工作更新資料庫後，教師清單、技能中文名稱與技能關聯會跟著重讀', () => {
  const env = buildFixture(path.join(tmp, 'refresh'));
  const live = makeHub(env);
  assert.equal(live.advisors({}).total, 30);
  assert.equal(live.competition('test-old456').skills[0].label, EN.design);
  assert.equal(live.match('test-abc123', TAKEN).coverage.percent, 38);

  // 模擬教師 Agent、中文名稱翻譯與相近技能計算寫入新資料；把修改時間往後推，避免檔案系統時間解析度造成誤判
  const later = new Date(Date.now() + 5000);
  writeDb(env.FOMO_HUB_DB, db => {
    insertRows(db, 'advisors', [advisorRow(['T900', '林新進', '設計學院', '視覺設計學系', ['互動設計'], ['design']])]);
    insertRows(db, 'entity_skills', skillRows('advisor', 'T900', ['design'], 'expertise'));
  });
  writeDb(env.FOMO_HUB_ESCO_DB, db => insertRows(db, 'esco_labels_zh', [[U.design, '使用者介面設計', 'test-model']]));
  addSimilarPairs(env, [['pitch', 'stats', 0.9]]);
  for (const file of [env.FOMO_HUB_DB, env.FOMO_HUB_ESCO_DB]) fs.utimesSync(file, later, later);

  assert.equal(live.advisors({}).total, 31);
  assert.deepEqual(idsOf(live.advisors({q: '使用者介面設計'})), ['T004', 'T900']);
  assert.equal(live.competition('test-old456').skills[0].label, '使用者介面設計');
  assert.equal(live.competition('test-old456').skills[0].en, EN.design);
  assert.equal(live.overview().counts.similarPairs, 1);
  assert.equal(live.match('test-abc123', TAKEN).coverage.percent, 50, '新增的相近配對讓 pitch 從缺口變成相近');
});

// ---- 審查後補上的邊界情況 ----
test('store：JSON 欄位內容不是預期型別時退回空值，不讓教師清單或配對壞掉', () => {
  const env = buildFixture(path.join(tmp, 'odd-json'));
  writeDb(env.FOMO_HUB_DB, db => {
    db.prepare("UPDATE advisors SET expertise_json = 'null' WHERE teacher_id = 'T001'").run();
    db.prepare("UPDATE competitions SET conditions_json = 'null', eligibility_json = '[]' WHERE competition_id = 'test-abc123'").run();
  });
  const odd = makeHub(env);

  assert.deepEqual(odd.advisors({college: '資訊學院'}).items.find(a => a.id === 'T001').expertise, []);
  const contest = odd.competition('test-abc123');
  assert.deepEqual([contest.conditions, contest.eligibility, contest.collegeEligible], [[], {}, true]);
  assert.equal(odd.match('test-abc123', TAKEN).trace.length, 5);
});

test('index：重複的修課只算一次', () => {
  const once = hub.studentSkills(TAKEN);
  const twice = hub.studentSkills([...TAKEN, ...TAKEN]);

  assert.equal(twice.courses.length, once.courses.length);
  assert.deepEqual(twice.skills, once.skills);
});

test('store：資料庫被刪除重建後改讀新檔，不必重啟伺服器', () => {
  // Arrange：先讀一次，讓連線開在舊檔上
  const env = buildFixture(path.join(tmp, 'rebuilt'));
  const rebuilt = makeHub(env);
  const before = rebuilt.competitions().length;

  // Act：依建置腳本的做法刪掉資料庫重建（內容只剩一筆比賽）
  fs.rmSync(env.FOMO_HUB_DB);
  const fresh = buildFixture(path.join(tmp, 'rebuilt-source'));
  fs.copyFileSync(fresh.FOMO_HUB_DB, env.FOMO_HUB_DB);
  writeDb(env.FOMO_HUB_DB, db => db.prepare("DELETE FROM competitions WHERE competition_id <> 'test-abc123'").run());

  // Assert
  assert.equal(before, COMPETITIONS.length);
  assert.deepEqual(rebuilt.competitions().map(c => c.id), ['test-abc123']);
});

test('studentSkills：課綱不完整的課顯示 incomplete，不算待分析', () => {
  const env = buildFixture(path.join(tmp, 'incomplete'));
  writeDb(env.FOMO_HUB_COURSE_DB, db => db.prepare("INSERT OR REPLACE INTO course_analysis VALUES ('C-114-1-CS301', 'incomplete', 'incomplete_syllabus', NULL, ?)").run(STAMP));
  const result = makeHub(env).studentSkills(TAKEN);

  const course = result.courses.find(c => c.courseCode === 'CS301');
  assert.deepEqual([course.status, course.analysis, course.skillCount], ['matched', 'incomplete', 0]);
  assert.equal(result.pending, hub.studentSkills(TAKEN).pending - 1, '原本待分析的這門課不再計入');
});
