// 助理流程的資料來源「campus」：能力盤點、競賽、隊友、教師四個角色都用真實資料。
// 以暫存資料夾裡的小型資料庫當作技能中樞與課程資料庫，不碰真實資料、不對外連線。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {loadConfig} from '../src/config.js';
import {start} from '../src/http/server.js';
import {client, hubEnv, insertRows, login, writeDb} from './hub-fixtures.js';
import {baseEnv, makeApp} from './helpers.js';

const ESCO_SCHEMA = `
  CREATE TABLE esco_skills (concept_uri TEXT NOT NULL PRIMARY KEY, preferred_label TEXT NOT NULL, description TEXT NOT NULL);
  CREATE TABLE esco_skill_relations (concept_uri TEXT NOT NULL, related_uri TEXT NOT NULL, relation TEXT NOT NULL, PRIMARY KEY (concept_uri, related_uri));
  CREATE TABLE esco_labels_zh (concept_uri TEXT PRIMARY KEY, label_zh TEXT NOT NULL, model TEXT);`;
const HUB_SCHEMA = `
  CREATE TABLE competitions (competition_id TEXT PRIMARY KEY, name TEXT NOT NULL, organizer TEXT, category TEXT, summary TEXT, source_site TEXT NOT NULL,
    source_url TEXT NOT NULL, start_date TEXT, deadline TEXT, eligibility_json TEXT NOT NULL, conditions_json TEXT NOT NULL, status TEXT NOT NULL,
    error_reason TEXT, fetched_at TEXT NOT NULL, analyzed_at TEXT NOT NULL, model TEXT);
  CREATE TABLE advisors (teacher_id TEXT PRIMARY KEY, name TEXT NOT NULL, college TEXT, department TEXT, expertise_json TEXT NOT NULL, status TEXT NOT NULL,
    error_reason TEXT, analyzed_at TEXT NOT NULL, model TEXT);
  CREATE TABLE entity_skills (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, concept_uri TEXT NOT NULL, source_section TEXT NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id, concept_uri));`;
const COURSE_SCHEMA = `
  CREATE TABLE courses (course_id TEXT PRIMARY KEY, year INTEGER NOT NULL, semester INTEGER NOT NULL, selection_code TEXT NOT NULL, course_name TEXT NOT NULL,
    description TEXT, targets TEXT NOT NULL, weekly_schedule TEXT NOT NULL);
  CREATE TABLE course_skills (course_id TEXT NOT NULL, concept_uri TEXT NOT NULL, source_section TEXT NOT NULL, evidence TEXT NOT NULL,
    PRIMARY KEY (course_id, concept_uri, source_section, evidence));
  CREATE TABLE course_analysis (course_id TEXT PRIMARY KEY, status TEXT NOT NULL, error_reason TEXT, model TEXT, analyzed_at TEXT NOT NULL);`;
const STAMP = '2026-11-01T00:00:00+00:00';
const uri = tail => `http://data.europa.eu/esco/skill/00000000-0000-0000-0000-${tail.padStart(12, '0')}`;
// 技能：學生修課會教 A、B；比賽另外需要 C（同學 S02 有）、D（同學 S03 只有它的下位技能 D2）、E（沒有人有）
const A = uri('a'), B = uri('b'), C = uri('c'), D = uri('d'), D2 = uri('d2'), E = uri('e');
const MANY = [1, 2, 3, 4, 5, 6, 7].map(n => uri(`f${n}`)); // 沒有任何同學具備的七項技能
const NAMES = {[A]: '技能甲', [B]: '技能乙', [C]: '技能丙', [D]: '技能丁', [D2]: '技能丁之二', [E]: '技能戊', ...Object.fromEntries(MANY.map((key, i) => [key, `缺口技能${i + 1}`]))};
const TERMINAL = new Set(['completed', 'stopped', 'blocked', 'cancelled', 'clarify']);
const course = (code, name) => ({academic_year: 114, semester: 2, course_code: code, course_name: name});
const PERSONAS = {
  S01: [course('1001', '測試課甲'), course('1002', '測試課乙'), course('1009', '尚未分析的課'), course('9999', '課程庫沒有的課')],
  S02: [course('2001', '測試課丙')],
  S03: [course('3001', '測試課丁之二')],
  S05: [course('2001', '測試課丙')], // 種子資料中未開放媒合的同學：有技能也不該被推薦
};
const user = id => ({id, role: 'student', name: id});
/** 能力檔案的技能依顯示名稱排序（順序隨語系而異），比對前先依技能 ID 排好。 */
const bySkill = skills => [...skills].sort((x, y) => x.skillId.localeCompare(y.skillId));

let tmp;
let env;
let app;

/** 啟動任務並推進到結束。decide 可以改寫人工確認的回覆；預設能力檔案照單全收、邀請全部可邀請對象。 */
async function drive(target, student, goal, {decide, ...options} = {}) {
  const o = target.orchestrator;
  let snap = await o.createRun(student, goal, {source: 'campus', ...options});
  for (let i = 0; i < 40 && !TERMINAL.has(snap.status); i += 1) {
    if (snap.status !== 'awaiting_user') snap = await o.step(student, snap.id);
    else {
      const answer = decide?.(snap) ?? (snap.pending.type === 'confirm_profile'
        ? {type: 'confirm_profile'} : {type: 'confirm_invites', selected: snap.summary.invitable.map(x => ({kind: x.kind, id: x.id}))});
      snap = o.confirm(student, snap.id, answer);
    }
  }
  return o.getRun(student, snap.id);
}

function buildFixture(dir) {
  const paths = {...hubEnv(dir), FOMO_HUB_PERSONAS: path.join(dir, 'personas.json')};
  writeDb(paths.FOMO_HUB_ESCO_DB, db => {
    insertRows(db, 'esco_skills', Object.keys(NAMES).map(key => [key, `skill ${key.slice(-2)}`, '說明']));
    insertRows(db, 'esco_skill_relations', [[D, D2, 'narrower'], [D2, D, 'broader']]);
    insertRows(db, 'esco_labels_zh', Object.entries(NAMES).map(([key, zh]) => [key, zh, 'test']));
  }, ESCO_SCHEMA);
  writeDb(paths.FOMO_HUB_COURSE_DB, db => {
    const rows = [['c-1001', '1001', '測試課甲'], ['c-1002', '1002', '測試課乙'], ['c-1009', '1009', '尚未分析的課'], ['c-2001', '2001', '測試課丙'], ['c-3001', '3001', '測試課丁之二']];
    insertRows(db, 'courses', rows.map(([id, code, name]) => [id, 114, 2, code, name, '描述', '["目標"]', '[{"tpd_learn":"活動"}]']));
    insertRows(db, 'course_skills', [['c-1001', A, 'targets[0]', '課甲的課綱教技能甲'], ['c-1002', B, 'targets[0]', '課乙的課綱教技能乙'],
      ['c-2001', C, 'targets[0]', '課丙的課綱教技能丙'], ['c-3001', D2, 'targets[0]', '課丁之二的課綱教技能丁之二']]);
    insertRows(db, 'course_analysis', ['c-1001', 'c-1002', 'c-2001', 'c-3001'].map(id => [id, 'mapped', null, 'test', STAMP]));
  }, COURSE_SCHEMA);
  writeDb(paths.FOMO_HUB_DB, db => {
    insertRows(db, 'competitions', [['test-hack01', '校園測試黑客松', '測試主辦單位', '資訊與程式', '測試用的比賽', '測試來源', 'https://contest.example/hack', null, '2026-12-31',
      JSON.stringify({student_required: true, education_levels: ['大學部'], team_min: 2, team_max: 4, requires_advisor: null}), '[]', 'mapped', null, STAMP, STAMP, 'test']]);
    insertRows(db, 'entity_skills', [A, B, C, D, E].map(skill => ['competition', 'test-hack01', skill, 'guideline[0]', '簡章提到這項技能']));
    // 需求技能很多的比賽：學生只有一項，其餘七項都是缺口
    insertRows(db, 'competitions', [['test-many01', '多缺口測試賽', '測試主辦單位', '其他', '需求技能很多的比賽', '測試來源', 'https://contest.example/many', null, '2026-12-31',
      JSON.stringify({student_required: true, education_levels: null, team_min: null, team_max: null, requires_advisor: null}), '[]', 'mapped', null, STAMP, STAMP, 'test']]);
    insertRows(db, 'entity_skills', [A, ...MANY].map(skill => ['competition', 'test-many01', skill, 'guideline[0]', '簡章提到這項技能']));
    insertRows(db, 'advisors', [['T501', '王大明', '資訊學院', '資訊工程學系', '["技能丙"]', 'mapped', null, STAMP, 'test']]);
    insertRows(db, 'entity_skills', [C, E].map(skill => ['advisor', 'T501', skill, 'skill[0]', '教師專長提到這項技能']));
  }, HUB_SCHEMA);
  fs.writeFileSync(paths.FOMO_HUB_PERSONAS, JSON.stringify({students: PERSONAS}));
  return paths;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-full-'));
  env = buildFixture(path.join(tmp, 'hub'));
  app = await makeApp({}, env);
});

after(() => {
  app?.close();
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});

test('資料來源：campus 另外需要課程技能資料；缺少時仍可用 hybrid', async () => {
  const noCourses = await makeApp({}, {...env, FOMO_HUB_COURSE_DB: path.join(tmp, 'missing.sqlite')});
  try {
    assert.deepEqual(app.orchestrator.availableSources(), ['demo', 'hybrid', 'campus']);
    assert.deepEqual(noCourses.orchestrator.availableSources(), ['demo', 'hybrid']);
    await assert.rejects(() => noCourses.orchestrator.createRun(user('S01'), '幫我盤點能力', {source: 'campus'}), err => err.code === 'SOURCE_UNAVAILABLE');
  } finally {
    noCourses.close();
  }
});

test('campus：完整流程——真實課程盤點 → 真實比賽 → 以課綱技能找隊友 → 真實教師 → 人工確認後送出邀請', async () => {
  const run = await drive(app, user('S01'), '我想參加校園測試黑客松，但不確定自己夠不夠格');

  assert.deepEqual([run.status, run.source, run.enrollmentOrigin], ['completed', 'campus', 'assigned']);
  // 能力盤點：只採計課程庫查得到、且已分析的課；查不到或沒分析的照實標示
  assert.deepEqual(run.inventory.courses.map(c => [c.code, c.mode, c.status, c.analysis, c.skills.length]),
    [['1001', 'esco', 'matched', 'mapped', 1], ['1002', 'esco', 'matched', 'mapped', 1], ['1009', 'esco', 'matched', 'pending', 0], ['9999', 'esco', 'not_found', null, 0]]);
  assert.deepEqual(run.inventory.courses[0].skills, [{name: '技能甲', quotes: [{where: 'targets[0]', text: '課甲的課綱教技能甲'}]}]);
  assert.deepEqual(bySkill(run.profile.skills).map(s => [s.skillId, s.name, s.level, s.status, s.kept]), [[A, '技能甲', null, 'syllabus', true], [B, '技能乙', null, 'syllabus', true]]);
  assert.equal(run.profile.state, 'confirmed');
  assert.ok(run.events.some(e => e.type === 'fallback' && /2 門課沒有可用的技能資料/.test(e.summary)));

  // 競賽分析：技能 ID 全是 ESCO；達標的依據是課綱證據
  const a = run.competition.analysis;
  assert.deepEqual(a.rows.map(r => [r.skillId, r.status]), [[A, 'met'], [B, 'met'], [C, 'missing'], [D, 'missing'], [E, 'missing']]);
  assert.equal(a.rows[0].haveLabel, '有課綱證據');
  assert.equal(a.fit.parts.theme, 12, '5 項中 2 項達標：30 × 2 ÷ 5');
  assert.equal(a.fit.parts.gapFill, 6.7, '3 個缺口中只有技能丙有開放媒合的同學修過：20 × 1 ÷ 3');

  // 找隊友：三個缺口都能搜尋（同學的技能也是 ESCO）；未開放媒合的同學不出現
  // 技能丁只有「相近」的同學：是否算補上，取決於那位同學的總分有沒有過有效門檻（時間、意願等示意屬性）
  const statusOfD = run.team[D].candidates[0].valid ? 'matched' : 'insufficient';
  assert.deepEqual(run.gaps.map(g => [g.skillId, g.status]), [[C, 'matched'], [D, statusOfD], [E, 'insufficient']]);
  const [byC] = run.team[C].candidates;
  assert.deepEqual([byC.id, byC.round, byC.valid, byC.level, byC.parts.core, byC.parts.proof], ['S02', 1, true, null, 50, 0]);
  assert.match(byC.reasons[0], /修過「測試課丙」，課綱：「課丙的課綱教技能丙」/);
  assert.ok(!JSON.stringify(run.team).includes('"S05"'), '未開放媒合的同學不推薦');
  // 沒有人有技能丁 → 擴大到相近技能：S03 修的課教它的下位技能，以關聯度折算
  const [byD] = run.team[D].candidates;
  assert.deepEqual([byD.id, byD.round, byD.flags.potential, byD.parts.core], ['S03', 2, true, 35]);
  assert.deepEqual(run.team[D].rounds.map(r => [r.mode, r.found]), [['precise', 0], ['potential', 1]]);
  assert.deepEqual(run.team[E].candidates, []);

  // 教師：真實資料，不進邀請名單；邀請只送給平台上的同學，對方登入後看得到
  assert.deepEqual(run.advisor.result.candidates.map(c => [c.id, c.name, c.invitable]), [['T501', '王Ｏ明', false]]);
  assert.ok(run.summary.invitable.every(i => i.kind === 'teammate'), '邀請名單只有平台上的同學');
  assert.deepEqual(run.summary.invitable.map(i => i.id).sort(), statusOfD === 'matched' ? ['S02', 'S03'] : ['S02']);
  const incoming = app.orchestrator.listInvitations(user('S02')).filter(i => i.direction === 'incoming');
  assert.deepEqual(incoming.map(i => [i.kind, i.status, i.competition, i.skill]), [['teammate', 'sent', '校園測試黑客松', '技能丙']], '受邀者看到的是技能名稱，不是 ESCO 網址');
  assert.ok(!/grade|成績/.test(JSON.stringify(run.inventory) + JSON.stringify(run.profile)), '盤點結果不含成績');
});

test('campus：取消勾選的技能不納入比對，只影響這次任務，不寫入平台的能力檔案', async () => {
  const before = app.inventory.getProfile('S01');
  const run = await drive(app, user('S01'), '我想參加校園測試黑客松', {
    decide: snap => (snap.pending.type === 'confirm_profile' ? {type: 'confirm_profile', keptSkillIds: [A, 'http://data.europa.eu/esco/skill/99999999-0000-0000-0000-000000000000']} : null),
  });

  assert.deepEqual(bySkill(run.profile.skills).map(s => [s.skillId, s.kept]), [[A, true], [B, false]], '不在檔案內的技能 ID 被忽略');
  assert.deepEqual(run.competition.analysis.rows.slice(0, 2).map(r => r.status), ['met', 'missing'], '技能乙被取消，變成缺口');
  assert.deepEqual(app.inventory.getProfile('S01'), before, '平台上的合成能力檔案沒有被改動');
});

test('campus：使用者帶來的修課清單優先於系統配給的清單', async () => {
  const run = await drive(app, user('S01'), '幫我盤點能力', {enrollments: [course('2001', '測試課丙')]});

  assert.deepEqual([run.intent.type, run.enrollmentOrigin, run.status], ['inventory', 'client', 'completed']);
  assert.deepEqual(run.profile.skills.map(s => s.skillId), [C]);
  assert.match(run.summary.text, /共 1 項技能/);
});

test('campus：沒有任何修課資料時請使用者先加入修課，不硬跑盤點', async () => {
  const run = await app.orchestrator.createRun(user('S04'), '我想參加校園測試黑客松', {source: 'campus'});

  assert.equal(run.status, 'clarify');
  assert.match(run.outcome.message, /還沒有你的修課資料/);
  assert.ok(!run.events.some(e => e.type === 'tool_call'));
});

test('campus：學生資料庫斷線時該分支停止，不輸出未經查證的隊友推薦', async () => {
  const run = await drive(app, user('S01'), '我想參加校園測試黑客松', {faults: {peers: 'down'}});

  assert.ok(Object.values(run.team).every(t => t.status === 'failed' && t.candidates.length === 0));
  assert.equal(run.summary.invitable.length, 0);
  assert.match(run.summary.text, /查詢失敗/);
  assert.equal(run.advisor.result.candidates.length, 1, '其他分支照常');
});

test('campus：教師資料庫斷線時不輸出教師推薦，隊友分支照常', async () => {
  const run = await drive(app, user('S01'), '我想參加校園測試黑客松', {faults: {teachers: 'down'}});

  assert.deepEqual([run.advisor.status, run.advisor.result.candidates.length], ['failed', 0]);
  assert.match(run.summary.text, /查詢失敗/);
  assert.ok(Object.values(run.team).some(t => t.candidates.length > 0), '隊友分支照常');
});

test('campus：經 HTTP 啟動任務——修課清單與 ESCO 技能 ID 通過驗證，格式不對的被拒絕', async () => {
  const server = await start(loadConfig({...baseEnv, ...env, PORT: '0'}));
  try {
    assert.deepEqual((await client(server.url)('GET', '/api/meta')).json.data.assistant, {source: 'demo', sources: ['demo', 'hybrid', 'campus']});
    const call = await login(server.url, 'S01');
    const bad = await call('POST', '/api/agent/run', {goal: '幫我盤點能力', source: 'campus', enrollments: [{academic_year: 114, semester: 2, course_code: '2001; DROP', course_name: 'x'}]});
    const unknown = await call('POST', '/api/agent/run', {goal: '幫我盤點能力', source: 'nowhere'});
    assert.deepEqual([bad.status, unknown.status], [400, 400]);

    let snap = (await call('POST', '/api/agent/run', {goal: '幫我盤點能力', source: 'campus', enrollments: [course('1001', '測試課甲'), course('1002', '測試課乙')]})).json.data;
    while (snap.status === 'running') snap = (await call('POST', `/api/agent/${snap.id}/auto-step`, {})).json.data;
    assert.deepEqual([snap.status, snap.pending.type, snap.enrollmentOrigin], ['awaiting_user', 'confirm_profile', 'client']);

    const rejected = await call('POST', `/api/agent/${snap.id}/confirm`, {type: 'confirm_profile', keptSkillIds: ['javascript:alert(1)']});
    assert.equal(rejected.status, 400);
    // 修很多門課時技能可能有數百項：全部勾選送出也要通過驗證（不在檔案內的 ID 會被忽略）
    const manyIds = [A, ...Array.from({length: 600}, (_, i) => uri(String(100000 + i)))];
    snap = (await call('POST', `/api/agent/${snap.id}/confirm`, {type: 'confirm_profile', keptSkillIds: manyIds})).json.data;
    while (snap.status === 'running') snap = (await call('POST', `/api/agent/${snap.id}/auto-step`, {})).json.data;
    assert.equal(snap.status, 'completed');
    assert.deepEqual(bySkill(snap.profile.skills).map(s => [s.name, s.kept]), [['技能甲', true], ['技能乙', false]]);
  } finally {
    await server.stop();
  }
});

test('campus：缺口很多的比賽只替前幾項找隊友，其餘擱置，任務仍在步數上限內完成', async () => {
  const run = await drive(app, user('S01'), '我想參加多缺口測試賽');

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.gaps.map(g => g.status), ['insufficient', 'insufficient', 'insufficient', 'insufficient', 'insufficient', 'deferred', 'deferred']);
  assert.equal(Object.keys(run.team).length, 5);
  assert.equal(run.summary.teamGaps.length, 7, '擱置的缺口也列為尚未補齊');
  assert.ok(run.events.filter(e => e.type === 'decision').length <= 16);
  assert.ok(run.events.some(e => e.type === 'gate' && /先替前 5 項找隊友、其餘 2 項擱置/.test(e.summary)));
});
