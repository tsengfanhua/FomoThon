// 技能中樞測試共用的 fixture 與輔助函式（不含任何測試）：以 node:sqlite 在暫存資料夾建立 ESCO、課程、
// 技能中樞三個小型資料庫，並提供假的 spawn 與帶 Cookie 的用戶端。人物、課程、比賽全部是虛構資料。
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadConfig} from '../src/config.js';
import {createHub} from '../src/hub/index.js';
import {createJobRunner} from '../src/hub/jobs.js';
import {AppError, createClock} from '../src/util.js';
import {TODAY, baseEnv} from './helpers.js';

// ===========================================================================
// Fixture：虛構的 ESCO 技能、課程、比賽與教師
// ===========================================================================
export const STAMP = '2026-11-01T00:00:00+00:00';
export const PAGE_SIZE = 24;

export const U = Object.freeze({
  python: 'urn:esco:python', programming: 'urn:esco:programming', ml: 'urn:esco:ml', dl: 'urn:esco:dl',
  data: 'urn:esco:data', stats: 'urn:esco:stats', pitch: 'urn:esco:pitch', design: 'urn:esco:design',
  unknown: 'urn:esco:not-in-catalog', // 比賽引用了 ESCO 目錄裡沒有的技能
});
export const EN = Object.freeze({
  python: 'Python (computer programming)', programming: 'computer programming', ml: 'machine learning', dl: 'deep learning',
  data: 'perform data analysis', stats: 'statistics', pitch: 'give live presentation', design: 'design user interface',
});
/** 只有部分技能有中文名稱；dl、stats、design 沒有，顯示時應退回英文。 */
export const ZH = Object.freeze({python: 'Python 程式設計', programming: '電腦程式設計', ml: '機器學習', data: '資料分析', pitch: '簡報表達'});
/** [A, B, A→B, B→A]：關聯雙向各存一列。 */
const RELATION_PAIRS = [
  ['python', 'programming', 'broader', 'narrower'], // programming 是 python 的上位技能
  ['ml', 'dl', 'narrower', 'broader'], // dl 是 ml 的下位技能
  ['data', 'stats', 'related', 'related'],
];
export const descriptionOf = key => `${EN[key]}（說明）`;
export const evidenceOf = (owner, key) => `${owner} 的文字提到 ${EN[key] ?? key}`;

/** [course_id, 學年, 學期, 選課代碼, 課名] */
const COURSES = [
  ['C-113-1-CS101', 113, 1, 'CS101', '程式設計入門'],
  ['C-113-2-CS201', 113, 2, 'CS201', '資料分析實務'],
  ['C-113-2-CS202', 113, 2, 'CS202', '統計學  '], // 課名尾端帶空白：查找與顯示都應去掉
  ['C-114-1-CS301', 114, 1, 'CS301', '專題研討'], // 尚未分析
  ['C-114-1-CS302', 114, 1, 'CS302', '體育'], // 分析過但沒有對應技能
  ['C-114-1-CS303', 114, 1, 'CS303', '分析失敗的課'],
  ['C-114-1-CS401', 114, 1, 'CS401', '機器學習導論'],
  ['C-114-1-CS402', 114, 1, 'CS402', '深度學習'],
  ['C-113-1-GE101', 113, 1, 'GE101', '簡報技巧'],
  ['C-114-2-CS201', 114, 2, 'CS201', '資料分析實務'], // 與已修課程同名、不同學期
  ['C-114-1-DUP01-A', 114, 1, 'DUP01', '重複開課'],
  ['C-114-1-DUP01-B', 114, 1, 'DUP01', '重複開課'],
  ['C-114-1-PCT01', 114, 1, 'PCT01', '100% 實作專題'],
];
const COURSE_SKILLS = [
  ['C-113-1-CS101', 'programming'],
  ['C-113-2-CS201', 'data'], ['C-113-2-CS201', 'stats'],
  ['C-113-2-CS202', 'stats'], // 沒有分析狀態紀錄，但有技能
  ['C-114-1-CS401', 'ml'], ['C-114-1-CS401', 'python'],
  ['C-114-1-CS402', 'dl'],
  ['C-113-1-GE101', 'pitch'],
  ['C-114-2-CS201', 'ml'], ['C-114-2-CS201', 'python'], ['C-114-2-CS201', 'pitch'],
];
const COURSE_ANALYSIS = [
  ['C-113-1-CS101', 'mapped'], ['C-113-2-CS201', 'mapped'], ['C-114-1-CS401', 'mapped'], ['C-114-1-CS402', 'mapped'],
  ['C-113-1-GE101', 'mapped'], ['C-114-2-CS201', 'mapped'], ['C-114-1-CS302', 'unmapped'], ['C-114-1-CS303', 'failed'],
];

/** [編號, 名稱, 主辦, 類別, 截止日, eligibility_json, conditions_json, 需要的技能] */
export const COMPETITIONS = [
  ['test-abc123', '測試黑客松', '虛構主辦單位', '資訊', '2026-12-31', JSON.stringify({students: true, teamSize: '2-4'}),
    JSON.stringify(['需為在學學生', '每隊 2 至 4 人']), ['python', 'ml', 'data', 'pitch']],
  ['test-old456', '過期創意賽', null, null, '2026-10-01', '{}', '[]', ['design', 'pitch']],
  ['test-today99', '今天截止的比賽', null, '資訊', TODAY, '{}', '[]', []], // 還沒有分析出技能
  ['test-nodate7', '不限期徵件', null, '設計', null, '不是 JSON', '', ['python', 'unknown']], // 欄位不是合法 JSON 時應退回預設值
];

/** [編號, 姓名, 學院, 系所, 專長, 技能] */
export const ADVISORS = [
  ['T001', '王大明', '資訊學院', '資訊工程學系', ['電腦視覺', '自然語言處理'], ['ml', 'python', 'pitch']],
  ['T002', '李小華', '商學院', '統計學系', ['計量方法'], ['data', 'stats']],
  ['T003', '陳美', '資訊學院', '資訊管理學系', ['類神經網路'], ['dl']],
  ['T004', '歐陽志遠', '設計學院', '視覺設計學系', ['介面設計'], ['design']],
  ['T005', 'John Smith', null, null, null, []], // 沒有學院、專長欄位不是合法 JSON、沒有技能
];
/** 用來測分頁的 25 位教師（沒有技能）。 */
const FILLER_ADVISORS = Array.from({length: 25}, (_, i) => {
  const no = String(i + 1).padStart(2, '0');
  return [`T1${no}`, `測試教師${no}`, '管理學院', '企業管理學系', ['組織行為'], []];
});
export const ALL_ADVISORS = [...ADVISORS, ...FILLER_ADVISORS];

const SCHEMA = Object.freeze({
  esco: `
    CREATE TABLE esco_skills (concept_uri TEXT NOT NULL PRIMARY KEY, preferred_label TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE esco_skill_relations (concept_uri TEXT NOT NULL, related_uri TEXT NOT NULL, relation TEXT NOT NULL CHECK (relation IN ('broader','narrower','related')), PRIMARY KEY (concept_uri, related_uri));
    CREATE TABLE esco_labels_zh (concept_uri TEXT PRIMARY KEY, label_zh TEXT NOT NULL, model TEXT);`,
  courses: `
    CREATE TABLE courses (course_id TEXT PRIMARY KEY, year INTEGER NOT NULL, semester INTEGER NOT NULL, selection_code TEXT NOT NULL, course_name TEXT NOT NULL, description TEXT, targets TEXT NOT NULL, weekly_schedule TEXT NOT NULL);
    CREATE TABLE course_skills (course_id TEXT NOT NULL, concept_uri TEXT NOT NULL, source_section TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY (course_id, concept_uri, source_section, evidence));
    CREATE TABLE course_analysis (course_id TEXT PRIMARY KEY, status TEXT NOT NULL, error_reason TEXT, model TEXT, analyzed_at TEXT NOT NULL);`,
  hub: `
    CREATE TABLE competitions (competition_id TEXT PRIMARY KEY, name TEXT NOT NULL, organizer TEXT, category TEXT, summary TEXT, source_site TEXT NOT NULL, source_url TEXT NOT NULL, start_date TEXT, deadline TEXT, eligibility_json TEXT NOT NULL, conditions_json TEXT NOT NULL, status TEXT NOT NULL, error_reason TEXT, fetched_at TEXT NOT NULL, analyzed_at TEXT NOT NULL, model TEXT);
    CREATE TABLE advisors (teacher_id TEXT PRIMARY KEY, name TEXT NOT NULL, college TEXT, department TEXT, expertise_json TEXT NOT NULL, status TEXT NOT NULL, error_reason TEXT, analyzed_at TEXT NOT NULL, model TEXT);
    CREATE TABLE entity_skills (entity_type TEXT NOT NULL CHECK (entity_type IN ('competition','advisor')), entity_id TEXT NOT NULL, concept_uri TEXT NOT NULL, source_section TEXT NOT NULL, evidence TEXT NOT NULL, PRIMARY KEY (entity_type, entity_id, concept_uri));`,
});

export function insertRows(db, table, rows) {
  for (const row of rows) db.prepare(`INSERT INTO ${table} VALUES (${row.map(() => '?').join(', ')})`).run(...row);
}

/** 開啟（必要時建立）資料庫，執行 fill 後關閉。 */
export function writeDb(file, fill, schema = '') {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    fill(db);
  } finally {
    db.close();
  }
}

export const advisorRow = ([id, name, college, department, expertise, skills]) =>
  [id, name, college, department, expertise ? JSON.stringify(expertise) : '壞掉的 JSON', skills.length ? 'mapped' : 'unmapped', null, STAMP, 'test-model'];
export const skillRows = (type, id, keys, section) => keys.map(key => [type, id, U[key], section, evidenceOf(id, key)]);

export const hubEnv = dir => ({
  FOMO_HUB_ROOT: dir,
  FOMO_HUB_ESCO_DB: path.join(dir, 'db', 'esco.sqlite'),
  FOMO_HUB_COURSE_DB: path.join(dir, 'db', 'courses.sqlite'),
  FOMO_HUB_DB: path.join(dir, 'db', 'hub.sqlite'),
  FOMO_HUB_PYTHON: 'python-for-test',
});

/** 在 dir 底下建立三個資料庫，回傳指向它們的環境變數。 */
export function buildFixture(dir) {
  const env = hubEnv(dir);
  writeDb(env.FOMO_HUB_ESCO_DB, db => {
    insertRows(db, 'esco_skills', Object.keys(EN).map(key => [U[key], EN[key], descriptionOf(key)]));
    insertRows(db, 'esco_skill_relations', RELATION_PAIRS.flatMap(([a, b, forward, backward]) => [[U[a], U[b], forward], [U[b], U[a], backward]]));
    insertRows(db, 'esco_labels_zh', Object.entries(ZH).map(([key, label]) => [U[key], label, 'test-model']));
  }, SCHEMA.esco);
  writeDb(env.FOMO_HUB_COURSE_DB, db => {
    insertRows(db, 'courses', COURSES.map(([id, year, semester, code, name]) => [id, year, semester, code, name, `${name.trim()}的課程概述`, '修課對象', '每週進度']));
    insertRows(db, 'course_skills', COURSE_SKILLS.map(([id, key]) => [id, U[key], 'weekly_schedule', evidenceOf(id, key)]));
    insertRows(db, 'course_analysis', COURSE_ANALYSIS.map(([id, status]) => [id, status, status === 'failed' ? 'llm_error' : null, 'test-model', STAMP]));
  }, SCHEMA.courses);
  writeDb(env.FOMO_HUB_DB, db => {
    insertRows(db, 'competitions', COMPETITIONS.map(([id, name, organizer, category, deadline, eligibility, conditions, skills]) =>
      [id, name, organizer, category, `${name}的簡介`, 'testsite', `https://contest.example/${id}`, null, deadline, eligibility, conditions, skills.length ? 'mapped' : 'unmapped', null, STAMP, STAMP, 'test-model']));
    insertRows(db, 'advisors', ALL_ADVISORS.map(advisorRow));
    insertRows(db, 'entity_skills', COMPETITIONS.flatMap(([id, , , , , , , skills]) => skillRows('competition', id, skills, 'brief')));
    insertRows(db, 'entity_skills', ALL_ADVISORS.flatMap(([id, , , , , skills]) => skillRows('advisor', id, skills, 'expertise')));
  }, SCHEMA.hub);
  return env;
}

/** 語意相近技能（shared/esco/similarity.py 產生）：較舊的 ESCO 資料庫沒有這張表，所以預設 fixture 不建。 */
const SIMILAR_SCHEMA = 'CREATE TABLE IF NOT EXISTS esco_skill_similar (concept_uri TEXT NOT NULL, related_uri TEXT NOT NULL, similarity REAL NOT NULL, PRIMARY KEY (concept_uri, related_uri));';
/** [A, B, 相似度]：與官方關聯一樣雙向各存一列。 */
const SIMILAR_PAIRS = [
  ['pitch', 'programming', 0.7], // 相似度較低，但先寫入
  ['pitch', 'stats', 0.9],
  ['python', 'programming', 0.84], // 這一對已有官方關聯（上位技能）
  ['ml', 'design', 0.69],
];
export function addSimilarPairs(env, pairs = SIMILAR_PAIRS) {
  writeDb(env.FOMO_HUB_ESCO_DB, db => insertRows(db, 'esco_skill_similar', pairs.flatMap(([a, b, score]) => [[U[a], U[b], score], [U[b], U[a], score]])), SIMILAR_SCHEMA);
}

export const enroll = (year, semester, code, name) => ({academic_year: year, semester, course_code: code, course_name: name});
/** 示範學生的修課：三門已分析、一門尚未分析、一門查不到。 */
export const TAKEN = Object.freeze([
  enroll(113, 1, 'CS101', '程式設計入門'), // → programming
  enroll(113, 2, 'CS201', '資料分析實務'), // → data、stats
  enroll(113, 2, 'CS202', '統計學'), // → stats
  enroll(114, 1, 'CS301', '專題研討'), // 尚未分析
  enroll(114, 1, 'XX999', '不存在的課'),
]);
export const TRANSCRIPT = TAKEN.map((item, index) => ({...item, credits: 3, grade: 80 + index}));

export function writeTranscripts(root) {
  const dir = path.join(root, 'course-agent', 'data', 'demo', 'synthetic_transcripts');
  fs.mkdirSync(dir, {recursive: true});
  const files = {
    'student_demo_001.json': JSON.stringify([...TRANSCRIPT, null, '不是物件']),
    'student_demo_002.json': JSON.stringify(TRANSCRIPT.slice(0, 2)),
    'student_demo_003.json': '{壞掉的 JSON',
    'student_demo_004.json': JSON.stringify({note: '不是陣列'}),
    'student_demo_5.json': JSON.stringify(TRANSCRIPT), // 檔名不符規則，不應列出
    'case_missing_grade.json': JSON.stringify(TRANSCRIPT), // 其他用途的示範檔，不應列出
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

// ---- 測試小幫手 ----
/** 每個測試檔各自呼叫一次：makeHub 以環境變數建立技能中樞，closeHubs 在測試結束時統一關閉。 */
export function createHubMaker() {
  const opened = [];
  function makeHub(env, {today = TODAY, spawnImpl} = {}) {
    const hub = createHub({config: loadConfig({...baseEnv, ...env}), clock: createClock(today), spawnImpl});
    opened.push(hub);
    return hub;
  }
  const closeHubs = () => { for (const item of opened.splice(0)) item.close(); };
  return {makeHub, closeHubs};
}

export const idsOf = result => result.items.map(item => item.id ?? item.courseId);
export const isAppError = (status, code) => err => err instanceof AppError && err.status === status && err.code === code;
export const skillMap = (...uris) => new Map(uris.map(uri => [uri, {uri}]));

/** 假的 spawn：記下呼叫參數，回傳可由測試控制輸出與結束時機的子程序。 */
export function fakeSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(), killed: false});
    const call = {command, args, options, child, stdin: null};
    child.stdin.end = data => { call.stdin = data; };
    child.kill = () => { child.killed = true; return true; };
    calls.push(call);
    return child;
  };
  return {calls, spawnImpl};
}

/** 讓假的子程序印出內容後以指定結束碼結束。 */
export function exit(child, code, stdout = '') {
  if (stdout.length) child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code);
}

export function makeRunner(options = {}) {
  const fake = fakeSpawn();
  const jobs = createJobRunner({root: 'hub-root', python: 'python-for-test', enabled: true, spawnImpl: fake.spawnImpl, ...options});
  return {...fake, jobs};
}

/** 帶 Cookie 的極簡用戶端（與 http.test.js 相同）。 */
export function client(base) {
  let cookie = '';
  return async function call(method, urlPath, body, headers = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: {...(body === undefined ? {} : {'content-type': 'application/json'}), ...(cookie ? {cookie} : {}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 回應 */ }
    return {status: res.status, json, text};
  };
}

export async function login(base, userId) {
  const call = client(base);
  const res = await call('POST', '/api/login', {userId});
  assert.equal(res.status, 200, `登入 ${userId} 失敗`);
  return call;
}

export const query = params => new URLSearchParams(params).toString();
