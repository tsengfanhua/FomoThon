// 助理流程的資料來源「hybrid」：競賽與教師改查真實資料（技能中樞），能力盤點與隊友仍是合成資料。
// 以暫存資料夾裡的小型資料庫當作技能中樞，不碰真實資料、不對外連線。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {relevanceOf, termsOf} from '../src/campus/competition.js';
import {hubEnv, insertRows, writeDb} from './hub-fixtures.js';
import {TODAY, makeApp} from './helpers.js';

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
const STAMP = '2026-11-01T00:00:00+00:00';
const NEAR = 'http://data.europa.eu/esco/skill/00000000-0000-0000-0000-00000000aaaa'; // 與學生某項技能相近、平台沒有對應的技能
const ALIEN = 'http://data.europa.eu/esco/skill/00000000-0000-0000-0000-00000000bbbb'; // 與平台技能毫無關聯的技能
const NEAR2 = 'http://data.europa.eu/esco/skill/00000000-0000-0000-0000-00000000cccc'; // 和 NEAR 一樣只與同一項平台技能相近
const STUDENT = {id: 'S01', role: 'student', name: '小安'};
const TERMINAL = new Set(['completed', 'stopped', 'blocked', 'cancelled', 'clarify']);

let tmp;
let env;
let app;
let F; // fixture 用到的技能：have（學生有）、other（學生也有，用來掛相近技能）、lack（學生沒有、平台有對應）

/** 啟動任務並推進到結束；能力檔案照單全收，邀請全部可邀請對象。 */
async function drive(target, goal, source) {
  const o = target.orchestrator;
  let snap = await o.createRun(STUDENT, goal, {source});
  for (let i = 0; i < 40 && !TERMINAL.has(snap.status); i += 1) {
    if (snap.status !== 'awaiting_user') snap = await o.step(STUDENT, snap.id);
    else if (snap.pending.type === 'confirm_profile') snap = o.confirm(STUDENT, snap.id, {type: 'confirm_profile'});
    else snap = o.confirm(STUDENT, snap.id, {type: 'confirm_invites', selected: snap.summary.invitable.map(x => ({kind: x.kind, id: x.id}))});
  }
  return o.getRun(STUDENT, snap.id);
}

function competitionRow(id, name, {deadline = '2026-12-31', eligibility = {}, category = '資訊與程式'} = {}) {
  return [id, name, '測試主辦單位', category, `${name}的摘要`, '測試來源', `https://contest.example/${id}`, null, deadline,
    JSON.stringify({student_required: true, education_levels: null, team_min: 2, team_max: 4, requires_advisor: null, ...eligibility}),
    JSON.stringify([{text: '限在學學生', evidence: '本競賽限在學學生參加'}]), 'mapped', null, STAMP, STAMP, 'test-model'];
}
const skillRows = (type, id, uris, section = 'guideline[0]') => uris.map(uri => [type, id, uri, section, `${id} 的原文提到這項技能`]);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-test-'));
  env = hubEnv(path.join(tmp, 'hub'));
  app = await makeApp({}, env);

  // 依學生目前的能力檔案挑技能：平台技能要有人工對應的 ESCO 技能才能和真實資料比對
  const esco = id => app.skills.get(id).ext.esco?.uri ?? null;
  const owned = app.db.prepare("SELECT skill_id FROM profile_skills WHERE owner_id = 'S01' AND kept = 1 AND status != 'self_reported' ORDER BY score DESC").all()
    .map(r => r.skill_id).filter(esco);
  const lacking = app.skills.all().map(s => s.id).filter(id => esco(id) && !app.db.prepare("SELECT 1 FROM profile_skills WHERE owner_id = 'S01' AND skill_id = ?").get(id));
  assert.ok(owned.length >= 2 && lacking.length >= 1, '種子資料應足以組出測試情境');
  F = {have: owned[0], other: owned[1], lack: lacking[0], haveUri: esco(owned[0]), otherUri: esco(owned[1]), lackUri: esco(lacking[0])};

  writeDb(env.FOMO_HUB_ESCO_DB, db => {
    insertRows(db, 'esco_skills', [[F.haveUri, 'have skill', 'd'], [F.otherUri, 'other skill', 'd'], [F.lackUri, 'lacking skill', 'd'], [NEAR, 'near skill', 'd'], [ALIEN, 'alien skill', 'd'], [NEAR2, 'second near skill', 'd']]);
    insertRows(db, 'esco_skill_relations', [[NEAR, F.otherUri, 'broader'], [F.otherUri, NEAR, 'narrower'], [NEAR2, F.otherUri, 'related'], [F.otherUri, NEAR2, 'related']]);
    insertRows(db, 'esco_labels_zh', [[NEAR, '相近技能', 'test'], [ALIEN, '陌生技能', 'test'], [F.lackUri, '欠缺技能', 'test'], [NEAR2, '第二相近技能', 'test']]);
  }, ESCO_SCHEMA);
  writeDb(env.FOMO_HUB_DB, db => {
    insertRows(db, 'competitions', [
      competitionRow('test-hack01', '校園測試黑客松'),
      competitionRow('test-closed1', '已截止測試賽', {deadline: '2026-01-01'}),
      competitionRow('test-kids01', '兒童測試賽', {eligibility: {education_levels: ['國小']}}),
      competitionRow('test-design1', '視覺測試設計賽', {deadline: null, eligibility: {student_required: null}, category: '設計與藝術'}),
      competitionRow('test-twin01', '孿生技能盃', {category: '其他'}),
    ]);
    insertRows(db, 'entity_skills', [
      ...skillRows('competition', 'test-hack01', [F.haveUri, NEAR, F.lackUri, ALIEN]),
      ...skillRows('competition', 'test-closed1', [F.haveUri]),
      ...skillRows('competition', 'test-kids01', [F.haveUri]),
      ...skillRows('competition', 'test-design1', [ALIEN]),
      ...skillRows('competition', 'test-twin01', [NEAR, NEAR2]),
    ]);
    insertRows(db, 'advisors', [
      ['T501', '王大明', '資訊學院', '資訊工程學系', JSON.stringify(['欠缺技能', '陌生技能']), 'mapped', null, STAMP, 'test-model'],
      ['T502', '李小華', '商學院', '企業管理學系', JSON.stringify(['相近技能']), 'mapped', null, STAMP, 'test-model'],
      ['T503', '陳無關', '商學院', '會計學系', JSON.stringify([]), 'mapped', null, STAMP, 'test-model'],
    ]);
    insertRows(db, 'entity_skills', [
      ...skillRows('advisor', 'T501', [F.lackUri, ALIEN], 'skill[0]'),
      ...skillRows('advisor', 'T502', [F.otherUri], 'journal[0]'), // 只有相近、而且只出現在論文標題
    ]);
  }, HUB_SCHEMA);
});

after(() => {
  app?.close();
  if (tmp) fs.rmSync(tmp, {recursive: true, force: true});
});

test('資料來源：技能中樞有資料時才提供 hybrid；指定不可用的來源會被拒絕，沒指定就退回合成資料', async () => {
  const empty = await makeApp({}, {...hubEnv(path.join(tmp, 'missing')), FOMO_ASSISTANT_SOURCE: 'hybrid'});
  try {
    assert.deepEqual(app.orchestrator.availableSources(), ['demo', 'hybrid']);
    assert.equal(app.orchestrator.defaultSource(), 'demo', '預設仍是合成資料');
    assert.deepEqual(empty.orchestrator.availableSources(), ['demo']);
    assert.equal(empty.orchestrator.defaultSource(), 'demo', '設定成 hybrid 但資料不存在時退回 demo');
    await assert.rejects(() => empty.orchestrator.createRun(STUDENT, '我想參加 AI 黑客松', {source: 'hybrid'}), err => err.code === 'SOURCE_UNAVAILABLE' && err.status === 409);
    const fallback = await empty.orchestrator.createRun(STUDENT, '幫我盤點能力');
    assert.equal(fallback.source, 'demo');
  } finally {
    empty.close();
  }
});

test('hybrid：指名真實比賽 → 以 ESCO 技能比對、缺口分成可找隊友與無法對應、教師只供自行聯絡', async () => {
  const run = await drive(app, '我想參加校園測試黑客松，但不確定自己夠不夠格', 'hybrid');
  const a = run.competition.analysis;

  assert.equal(run.status, 'completed');
  assert.deepEqual([run.source, run.intent.competitionId], ['hybrid', 'test-hack01']);
  assert.deepEqual([a.competition.real, a.competition.sourceSite, a.competition.conditions.length], [true, '測試來源', 1]);
  // 需求技能：有 → 達標；只有 ESCO 上位技能 → 弱項（相近）；平台有對應但學生沒有 → 缺口；完全陌生 → 缺口
  assert.deepEqual(a.rows.map(r => r.status), ['met', 'weak', 'missing', 'missing']);
  assert.match(a.rows[1].haveLabel, /^相近：/);
  const levelOf = id => app.db.prepare("SELECT level FROM profile_skills WHERE owner_id = 'S01' AND skill_id = ?").get(id).level;
  assert.equal(a.rows[0].haveLabel, levelOf(F.have), '多項平台技能對到同一項 ESCO 技能時，顯示分數最高那一項的等級');
  // 資格：簡章沒寫學歷 → 待確認（不擋）；截止日未到 → 符合
  assert.deepEqual(a.eligibility.checks.map(c => [c.key, c.ok, Boolean(c.unknown)]), [['student', true, false], ['level', true, true], ['deadline', true, false]]);
  assert.equal(a.eligibility.eligible, true);
  // 真實比賽沒有歷屆資料：難度分項不計入並標示
  assert.deepEqual([a.fit.parts.difficulty, a.fit.partial], [null, true]);
  assert.equal(a.fit.parts.theme, 11.3, '4 項中 1 項達標、1 項相近：30 ×（1 + 0.5）÷ 4');

  // 缺口：相近技能與欠缺技能可以換回平台技能去找隊友；陌生技能換不回來，標為 unsupported
  const gaps = Object.fromEntries(run.gaps.map(g => [g.skillId, g]));
  assert.equal(gaps[NEAR].peerSkillId, F.other, '沒有完全對應時，用有 ESCO 關聯的平台技能');
  assert.equal(gaps[F.lackUri].peerSkillId, F.lack);
  assert.deepEqual([gaps[ALIEN].status, gaps[ALIEN].peerSkillId], ['unsupported', null]);
  assert.deepEqual(Object.keys(run.team).sort(), [NEAR, F.lackUri].sort(), '只替換得回平台技能的缺口找隊友');
  assert.ok(run.summary.teamGaps.includes('陌生技能'), '無法找隊友的缺口列為尚未補齊');

  // 教師：真實資料、姓名遮蔽、不可邀請
  const advisors = run.advisor.result;
  assert.equal(advisors.real, true);
  assert.deepEqual(advisors.candidates.map(c => [c.id, c.name, c.valid, c.invitable]), [['T501', '王Ｏ明', true, false], ['T502', '李Ｏ華', false, false]]);
  assert.deepEqual(advisors.candidates[0].parts, {coverage: 70, declared: 30}, '涵蓋兩項、都出自專長條列');
  assert.deepEqual(advisors.candidates[1].parts, {coverage: 17.5, declared: 0}, '只有一項相近、且只出現在論文標題');
  assert.ok(!run.summary.invitable.some(i => i.kind === 'advisor'), '真實教師不進邀請名單');
  assert.match(run.summary.text, /1 位專長相符的教師可自行聯絡/);
  assert.ok(!JSON.stringify(run).includes('王大明'), '任務快照不含教師全名');

  // 邀請只會送給平台上的同學；真實教師沒有收到任何邀請
  const invitations = app.db.prepare('SELECT kind, to_id, competition_id FROM invitations WHERE run_id = ?').all(run.id);
  assert.ok(invitations.every(i => i.kind === 'teammate' && i.competition_id === 'test-hack01'));
  assert.equal(app.orchestrator.listInvitations(STUDENT).filter(i => i.runId === run.id).every(i => i.competition === '校園測試黑客松'), true, '邀請清單查得到真實比賽的名稱');
});

test('hybrid：沒指名比賽時只推薦大專生可參加的比賽；已截止的排在後面', async () => {
  const run = await drive(app, '我想找測試相關的競賽', 'hybrid');
  const names = run.competition.analyses.map(x => x.competition.name);

  assert.equal(run.intent.type, 'find_competition');
  assert.ok(!names.includes('兒童測試賽'), '限國小的比賽不在候選內');
  assert.equal(names[0], '校園測試黑客松', '資格符合且適配度最高的排第一');
  const closed = run.competition.analyses.find(x => x.competition.name === '已截止測試賽');
  if (closed) assert.equal(closed.eligibility.eligible, false);
  assert.ok(!run.competition.offTopic, '有比賽與目標相關時不標示');
});

test('hybrid：沒有比賽與目標相關時明說，不把依截止日挑的比賽說成相關', async () => {
  const run = await drive(app, '我想找 Kubernetes 相關競賽', 'hybrid');

  assert.equal(run.intent.type, 'find_competition');
  assert.equal(run.competition.offTopic, true);
  assert.ok(run.competition.analyses.length > 0, '仍列出可參加的比賽');
  assert.match(run.summary.text, /沒有找到與目標直接相關的比賽/);
});

test('hybrid：多個缺口只對得到同一項平台技能時，只搜尋一次，其餘標為無法對應', async () => {
  const run = await drive(app, '我想參加孿生技能盃', 'hybrid');
  const gaps = Object.fromEntries(run.gaps.map(g => [g.skillId, g]));

  assert.equal(run.intent.competitionId, 'test-twin01');
  assert.equal(gaps[NEAR].peerSkillId, F.other);
  assert.deepEqual([gaps[NEAR2].status, gaps[NEAR2].peerSkillId], ['unsupported', null], '同一項平台技能不重複拿來找隊友');
  assert.deepEqual(Object.keys(run.team), [NEAR]);
});

test('hybrid：只找隊友時全程用平台技能，結果與合成資料相同（不經 ESCO 來回換算）', async () => {
  for (const goal of ['幫我找會機器學習的隊友', '幫我找會 Vue 的隊友', '幫我找會深度學習的隊友']) {
    const [demoApp, hybridApp] = [await makeApp({}, env), await makeApp({}, env)];
    try {
      const demo = await drive(demoApp, goal, 'demo');
      const hybrid = await drive(hybridApp, goal, 'hybrid');
      const view = run => ({
        intent: [run.intent.type, run.intent.skillIds, run.intent.skillNames],
        gaps: run.gaps.map(g => [g.skillId, g.name, g.status]),
        team: Object.entries(run.team).map(([skillId, t]) => [skillId, t.candidates.map(c => [c.id, c.skillId, c.skillName, c.valid])]),
        invitable: run.summary.invitable.map(i => [i.id, i.skillId, i.skillName]),
      });

      assert.equal(hybrid.source, 'hybrid');
      assert.equal(hybrid.intent.type, 'find_teammate', goal);
      assert.ok(hybrid.intent.skillIds.length > 0 && hybrid.intent.skillIds.every(id => /^SK-/.test(id)), goal);
      assert.deepEqual(view(hybrid), view(demo), goal);
    } finally {
      demoApp.close();
      hybridApp.close();
    }
  }
});

test('平台技能 ↔ ESCO：多項平台技能對到同一項 ESCO 技能時，換回來取對應最精確的那一項', () => {
  const mapped = app.skills.all().filter(s => s.ext?.esco?.uri);
  const groups = Map.groupBy(mapped, s => s.ext.esco.uri);
  const shared = [...groups.values()].filter(group => group.length > 1);
  const rank = s => (s.ext.esco.match === 'exact' ? 0 : 1);

  assert.ok(shared.length > 0, '種子資料應有多對一的對應');
  for (const group of shared) {
    const [best] = [...group].sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
    assert.equal(app.campus.skills.toSk(best.ext.esco.uri), best.id, group.map(s => s.id).join('、'));
  }
  for (const s of mapped) assert.equal(app.campus.skills.toEsco(s.id), s.ext.esco.uri);
  assert.equal(app.campus.skills.toSkNear(NEAR), F.other);
  assert.equal(app.campus.skills.toSkNear(NEAR, new Set([F.other])), null, '已經用掉的平台技能不重複使用');
});

test('技能中樞的資料庫存在但讀不了時，助理退回合成資料，網站其他部分不受影響', async () => {
  const dir = path.join(tmp, 'broken');
  const paths = hubEnv(dir);
  fs.mkdirSync(dir, {recursive: true});
  for (const key of ['FOMO_HUB_ESCO_DB', 'FOMO_HUB_DB']) {
    fs.mkdirSync(path.dirname(paths[key]), {recursive: true});
    fs.writeFileSync(paths[key], '這不是 SQLite 資料庫');
  }
  const broken = await makeApp({}, {...paths, FOMO_ASSISTANT_SOURCE: 'campus'});
  try {
    assert.deepEqual(broken.orchestrator.availableSources(), ['demo']);
    assert.equal(broken.orchestrator.defaultSource(), 'demo');
    await assert.rejects(() => broken.orchestrator.createRun(STUDENT, '我想參加 AI 黑客松', {source: 'hybrid'}), err => err.code === 'SOURCE_UNAVAILABLE' && err.status === 409);
    const run = await drive(broken, '我想參加 AI 黑客松，但不確定自己夠不夠格', 'demo');
    assert.deepEqual([run.source, run.status], ['demo', 'completed']);
    assert.ok(broken.orchestrator.listInvitations(STUDENT).length > 0, '邀請清單照常讀得到');
  } finally {
    broken.close();
  }
});

test('hybrid：指名的比賽已截止 → 重新規劃，改推薦其他真實比賽', async () => {
  const run = await drive(app, '我想參加已截止測試賽', 'hybrid');

  assert.equal(run.competition.replacedFrom.name, '已截止測試賽');
  assert.equal(run.competition.analysis.competition.name, '校園測試黑客松');
  assert.ok(run.events.some(e => e.type === 'replan'));
});

test('hybrid：找指導老師 → 目標提到的技能換成 ESCO，查真實教師', async () => {
  const run = await drive(app, `想找${app.skills.name(F.lack)}方向的指導老師`, 'hybrid');

  assert.deepEqual([run.intent.type, run.intent.skillIds], ['find_teacher', [F.lackUri]]);
  assert.deepEqual(run.intent.skillNames, ['欠缺技能'], '技能名稱用 ESCO 的中文顯示名稱');
  assert.deepEqual(run.advisor.result.candidates.map(c => c.id), ['T501']);
  assert.equal(run.status, 'completed');
  assert.equal(run.summary.invitable.length, 0);
});

test('demo：沒指定來源時用合成資料；有沒有技能中樞，結果都相同', async () => {
  const goal = '我想參加 AI 黑客松，但不確定自己夠不夠格';
  const [withHub, withoutHub] = [await makeApp({}, env), await makeApp({}, hubEnv(path.join(tmp, 'missing')))];
  try {
    const run = await drive(withHub, goal);
    const baseline = await drive(withoutHub, goal);
    const view = r => ({
      source: r.source, status: r.status, intent: [r.intent.type, r.intent.skillIds, r.intent.competitionId], plan: r.plan,
      analysis: r.competition.analysis, gaps: r.gaps, advisor: r.advisor, invitable: r.summary.invitable, text: r.summary.text,
      team: Object.entries(r.team).map(([skillId, t]) => [skillId, t.status, t.candidates.map(c => [c.id, c.total, c.valid])]),
    });

    assert.equal(run.source, 'demo');
    assert.ok(!run.competition.analysis.competition.real);
    assert.ok(run.competition.analysis.rows.every(r => /^SK-/.test(r.skillId)));
    assert.ok((run.advisor.result?.candidates ?? []).every(c => c.invitable !== false));
    assert.deepEqual(view(run), view(baseline));
  } finally {
    withHub.close();
    withoutHub.close();
  }
});

test('競賽搜尋的相關度：技能命中最重，名稱裡的詞比類別裡的詞重，常見字詞不算', () => {
  const comp = (name, type, needs = []) => ({name, type, description: '', needs: needs.map(skill => ({skill, name: skill, en: skill}))});

  assert.deepEqual(termsOf('我想參加 AI 黑客松，但不確定自己夠不夠格'), {words: ['AI'], bigrams: ['黑客', '客松']}, '空白與標點會斷開，常見字詞不列入');
  assert.equal(relevanceOf(comp('校園 AI 創新賽', '資訊'), {text: '我想參加 AI 黑客松'}), 6, '名稱裡的英數單字：2 × 3');
  assert.equal(relevanceOf(comp('繪畫比賽', '設計與藝術'), {text: '我想找設計相關的比賽'}), 1, '只在類別命中');
  assert.equal(relevanceOf(comp('海報設計賽', '設計與藝術'), {text: '我想找設計相關的比賽'}), 4, '名稱與類別都命中');
  assert.equal(relevanceOf(comp('PAINT 大賽', '其他'), {text: '我想參加 AI 比賽'}), 0, 'AI 不該誤中 PAINT');
  assert.equal(relevanceOf(comp('某賽', '其他', ['uri:a', 'uri:b']), {skillIds: ['uri:a']}), 3);
});
