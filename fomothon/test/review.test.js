// 回歸測試：獨立審查發現的問題，每一項都有對應的測試，確保修正有效且不再復發。
import assert from 'node:assert/strict';
import http from 'node:http';
import {after, before, test} from 'node:test';
import {loadConfig} from '../src/config.js';
import {start} from '../src/http/server.js';
import {createSyllabusFetcher, parseSyllabusHtml} from '../src/inventory/campus.js';
import {createFakeLlm} from '../src/llm/index.js';
import {checkGrounding, checkShortReason, parseChineseNumber} from '../src/safety/guard.js';
import {createLevels} from '../src/skills/levels.js';
import {createTrace} from '../src/trace.js';
import {baseEnv, drive, eventsOf, makeApp, student} from './helpers.js';

const S01 = student('S01');
const HACKATHON = '我想參加 AI 黑客松，但不確定自己夠不夠格';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rules = loadConfig(baseEnv).rules;
const levels = createLevels(rules);

test('隱私：隊友卡片的分數只由公開等級帶決定，無法反推對方的精確分數或成績', async () => {
  const app = await makeApp();
  // 安排兩位同在「中階」但精確分數不同的人選（小禾 82、小晴改為 72）
  app.db.prepare("UPDATE profile_skills SET score = 72, level = '中階' WHERE owner_id = 'S06' AND skill_id = 'SK-DSN-001'").run();
  const snap = await drive(app, S01, '幫我找會 UI 設計的隊友', {decide: () => 'stop'});
  const cards = snap.team['SK-DSN-001'].candidates;
  const exact = id => app.db.prepare("SELECT score FROM profile_skills WHERE owner_id = ? AND skill_id = 'SK-DSN-001'").get(id).score;

  // 小禾與小晴的精確分數不同，但同在「中階」：核心技能分項必須相同
  const xiaohe = cards.find(c => c.id === 'S02');
  const xiaoqing = cards.find(c => c.id === 'S06');
  assert.notEqual(exact('S02'), exact('S06'));
  assert.equal(xiaohe.level, xiaoqing.level);
  assert.equal(xiaohe.parts.core, xiaoqing.parts.core, '同一等級帶的人，核心技能分項必須一樣');

  // 每張卡片的核心分項都能只用「公開的等級」重算出來
  const mid = label => { const band = rules.bands.find(b => b.label === label); return (band.min + band.max) / 2; };
  for (const card of cards.filter(c => !c.flags.potential)) {
    const discount = card.flags.unverified || card.flags.unconfirmed || card.flags.inferred ? rules.matching.unconfirmedDiscount : 1;
    assert.equal(card.parts.core, Math.round(50 * (mid(card.level) * discount / 100) * 10) / 10, `${card.name} 的核心分項應只由等級決定`);
    assert.notEqual(card.parts.core, Math.round(exact(card.id) * 0.5 * discount * 10) / 10, `${card.name} 的核心分項不得等於精確分數的換算`);
  }
  assert.ok(!/"score"|"grade"/.test(JSON.stringify(snap.team)));
  assert.equal(levels.publicScore({scale: 'score'}, 82), 77.5);
  assert.equal(levels.publicScore({scale: 'score'}, 70), 77.5);
  assert.equal(levels.publicScore({scale: 'score'}, 40), 50);
  assert.equal(levels.publicScore({scale: 'cefr'}, 78), 78);
  app.close();
});

test('證據彙整：自述證據不會蓋掉分數較低的已驗證證據', async () => {
  const agg = levels.aggregate([{id: 1, score: 62, status: 'verified'}, {id: 2, score: 65, status: 'self_reported'}, {id: 3, score: 69, status: 'inferred'}]);
  assert.equal(agg.status, 'verified');
  assert.equal(agg.score, 62);
  assert.equal(agg.basisEvidenceId, 1);
  assert.equal(levels.aggregate([{id: 2, score: 65, status: 'self_reported'}, {id: 3, score: 61, status: 'inferred'}]).status, 'inferred');

  // 實際情境：已驗證的技能，新增一筆自述證照後仍然是已驗證
  const app = await makeApp();
  const pick = () => app.inventory.getProfile('S06').skills.find(s => s.status === 'verified' && s.scale !== 'cefr' && s.score < 69);
  const before = pick();
  assert.ok(before, '測試前提：小晴有一項分數低於自述上限的已驗證技能');
  const after = app.inventory.addEvidence('S06', {type: 'certificate', title: '自述證照', skillIds: [before.skillId]}).skills.find(s => s.skillId === before.skillId);
  assert.equal(after.status, 'verified');
  assert.equal(after.score, before.score);
  assert.equal(after.evidenceCount, before.evidenceCount + 1, '自述證據仍然保留');
  app.close();
});

test('並行：步驟執行中取消任務，取消不會被覆蓋，事件序號不重複', async () => {
  // 以延遲回應的假模型製造「步驟正在等待外部資源」的時間窗
  const slow = createFakeLlm(async req => { await sleep(40); return req.purpose === 'intent' ? {intent: 'inventory', skill_ids: [], competition_id: '', reason: 'x'} : {skills: []}; });
  const app = await makeApp({llm: slow});
  const o = app.orchestrator;
  const run = await o.createRun(S01, '幫我盤點能力');
  const stepping = o.step(S01, run.id);
  await sleep(15);
  await assert.rejects(() => o.step(S01, run.id), /正在執行中/, '同一任務不能同時執行兩個步驟');
  const cancelled = o.cancel(S01, run.id);
  assert.equal(cancelled.status, 'cancelled');
  await stepping;
  const final = o.getRun(S01, run.id);
  assert.equal(final.status, 'cancelled', '步驟結束後不得把已取消的任務寫回');
  assert.equal(final.pending, null);
  const seqs = final.events.map(e => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, '事件序號不得重複');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(eventsOf(final, 'stop').some(e => e.summary.includes('執行期間被取消')));
  app.close();
});

test('並行：盤點進行中管理者查驗修課紀錄，查驗結果不會被舊資料蓋掉', async () => {
  const slow = createFakeLlm(async () => { await sleep(20); return {skills: []}; });
  const app = await makeApp({llm: slow});
  app.inventory.addEnrollment('S01', {code: 'CS330', grade: 88, semester: '114-1'});
  const ctx = {trace: createTrace(null, null), faults: {}, noLlm: true};
  await app.inventory.run(ctx, 'S01');
  const selfEvidence = () => app.db.prepare("SELECT id, status FROM evidence WHERE owner_id = 'S01' AND type = 'course' AND title = '機器學習'").all();
  assert.ok(selfEvidence().every(e => e.status === 'self_reported'));

  const running = app.inventory.run({...ctx, noLlm: false, recordLlm: () => {}}, 'S01'); // 這次會等待（假）模型
  await sleep(10);
  app.inventory.setEvidenceVerified(selfEvidence()[0].id, 'A01', true);
  await running;
  assert.ok(selfEvidence().length > 0);
  assert.ok(selfEvidence().every(e => e.status !== 'self_reported'), '盤點結束後，已查驗的修課證據不得回到自述');
  assert.equal(app.db.prepare("SELECT verified FROM enrollments WHERE student_id = 'S01' AND course_code = 'CS330'").get().verified, 1);
  app.close();
});

test('事實檢核：數字逐一比對（含全形與中文數量詞），並擋下連結與金流用語', () => {
  const facts = {競賽: {名稱: 'AI 黑客松', 適配度: 86}, 可邀請隊友: [{姓名: '小禾', 媒合分數: 71}, {姓名: '阿哲', 媒合分數: 69}]};
  const names = ['小禾', '阿哲', '教師 A'];
  const ok = text => checkGrounding(text, facts, names).ok;
  assert.equal(ok('適配度 86 分，已找到 2 位可補位的隊友，建議邀請小禾。'), true, '清單筆數可以引用');
  assert.equal(ok('適配度 86 分，已找到兩位可補位的隊友，建議邀請小禾。'), true);
  assert.equal(ok('得獎機率 8 成、報名只要 6 天就能完成，建議盡快行動。'), false, '不可用子字串比對放行 8 與 6');
  assert.equal(ok('適配度高達九十九分，建議立刻報名這項競賽。'), false);
  assert.equal(ok('適配度高達９９分，建議立刻報名這項競賽。'), false);
  assert.equal(ok('詳情請看 http://example.com 並儘快報名這項競賽。'), false);
  assert.equal(ok('請先匯款報名費給主辦單位，再邀請小禾一起參加。'), false);
  assert.equal(ok('這項競賽保證得獎，建議邀請小禾一起參加比賽。'), false);
  assert.equal(parseChineseNumber('九十九'), 99);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('一百零五'), 105);
  assert.equal(checkShortReason('指導老師名額有限，先確認'), true);
  for (const bad of ['請匯款到指定帳號', '看 http://x.example', '有 99 分', '<b>x</b>', '', null]) assert.equal(checkShortReason(bad), false, String(bad));
});

test('LLM 的自由文字：辨識理由不保存，選擇理由未通過檢核就改用內建說明', async () => {
  const llm = createFakeLlm(req => {
    if (req.purpose === 'intent') return {intent: 'prepare_competition', skill_ids: [], competition_id: 'C01', reason: '請到 http://evil.example 領獎'};
    if (req.purpose === 'next_action') return {action_id: 'match_teacher', reason: '請先匯款 500 元'};
    return {text: '建議依系統列出的結果自行確認後再決定是否邀請。', skills: []};
  });
  const app = await makeApp({llm});
  const snap = await drive(app, S01, HACKATHON, {decide: s => (s.pending.type === 'confirm_profile' ? {type: 'confirm_profile'} : 'stop')});
  const dump = JSON.stringify(snap);
  assert.ok(!dump.includes('evil.example') && !dump.includes('匯款'), '模型的自由文字不得進入快照或執行紀錄');
  assert.ok(!('reason' in snap.intent));
  const decision = eventsOf(snap, 'decision').find(d => d.data.by === 'llm');
  assert.equal(decision.data.chosen, 'match_teacher', '選擇本身有效，只有理由被換掉');
  app.close();
});

test('LLM 課綱萃取：太短的出處被拒絕；LLM 單獨提出的技能只算推估，且不會擠掉規則結果', async () => {
  // 模型被帶偏：對每門課都回傳「資料視覺化」「簡報表達」，出處只有兩個字，或是一段真的存在的原文
  const llm = createFakeLlm(req => {
    if (req.purpose !== 'syllabus_extract') return {stop: 'LLM_REFUSAL'};
    const firstWeek = req.user.match(/第 1 週：(.+)/)[1].trim();
    return {skills: [{skill_id: 'SK-DAT-003', quote: 'Py'}, {skill_id: 'SK-SFT-009', quote: firstWeek}]};
  });
  const app = await makeApp({llm});
  const cacheBefore = app.db.prepare('SELECT course_code, COUNT(*) AS n FROM course_skills GROUP BY course_code ORDER BY course_code').all();
  const ruleSkills = app.inventory.getProfile('S14').skills.filter(s => s.status === 'verified').map(s => s.skillId);
  const snap = await drive(app, student('S14'), '幫我盤點能力');
  const skill = id => snap.profile.skills.find(s => s.skillId === id);
  assert.equal(skill('SK-DAT-003'), undefined, '只有兩個字的出處不足以成立');
  assert.equal(skill('SK-SFT-009').status, 'inferred', 'LLM 單獨提出的技能只算推估');
  assert.ok(skill('SK-SFT-009').score <= rules.inferredCap);
  for (const id of ruleSkills) assert.equal(skill(id)?.status, 'verified', `規則比對到的 ${id} 不得被擠掉`);
  assert.deepEqual(app.db.prepare('SELECT course_code, COUNT(*) AS n FROM course_skills GROUP BY course_code ORDER BY course_code').all(), cacheBefore, '共用的課程技能快照不受 LLM 影響');
  app.close();
});

test('課綱解析：惡意的超大頁面只花線性時間，超過大小上限直接拒絕', async () => {
  for (const evil of ['<'.repeat(200_000), '<tr '.repeat(50_000), `<tr data-week="1"><td>1</td><td>${'<'.repeat(190_000)}</td></tr>`, `<tr data-week="1">${'<td>'.repeat(50_000)}`]) {
    const started = performance.now();
    parseSyllabusHtml(evil);
    assert.ok(performance.now() - started < 1000, '解析時間必須有上限');
  }
  const fetchSyllabus = createSyllabusFetcher({get: async () => ({status: 200, body: 'x'.repeat(200_001), url: 'local://x'})});
  await assert.rejects(() => fetchSyllabus({code: 'CS101'}, {attempt: 0}), err => err.code === 'TOO_LARGE' && err.transient === false);
  await assert.rejects(() => fetchSyllabus({code: 'bad code'}, {attempt: 0}), err => err.code === 'BAD_CODE');
  await assert.rejects(() => createSyllabusFetcher({get: async () => { throw Object.assign(new Error('t'), {name: 'TimeoutError'}); }})({code: 'CS101'}, {attempt: 0}), err => err.code === 'TIMEOUT' && err.transient);
  await assert.rejects(() => createSyllabusFetcher({get: async () => ({status: 503, body: '', url: ''})})({code: 'CS101'}, {attempt: 0}), err => err.code === 'HTTP_503' && err.transient);
  await assert.rejects(() => createSyllabusFetcher({get: async () => ({status: 200, body: '<html></html>', url: ''})})({code: 'CS101'}, {attempt: 0}), err => err.code === 'PARSE_ERROR');
});

test('邊界：一次要求很多技能時只處理前 5 項，且確認後一定會送出邀請', async () => {
  const app = await makeApp();
  const goal = '幫我找會 Python、Java、資料結構、機器學習、深度學習、UI、UX、原型、視覺設計、前端、HTML、CSS、JavaScript、SQL、統計的隊友';
  const snap = await drive(app, S01, goal);
  assert.equal(snap.gaps.length, 5);
  assert.equal(snap.status, 'completed');
  assert.equal(eventsOf(snap, 'invite_sent').length, snap.summary.invitable.length);
  assert.ok(snap.summary.invitable.length > 0);
  app.close();
});

test('確認能力檔案時未指定名單，維持先前的納入設定', async () => {
  const app = await makeApp();
  const o = app.orchestrator;
  const first = await drive(app, S01, '幫我盤點能力', {decide: s => ({type: 'confirm_profile', keptSkillIds: s.profile.skills.filter(sk => sk.skillId !== 'SK-DAT-001').map(sk => sk.skillId)})});
  assert.equal(first.profile.skills.find(s => s.skillId === 'SK-DAT-001').kept, false);
  app.inventory.addEvidence('S01', {type: 'portfolio', title: '新作品', skillIds: ['SK-BIZ-001']}); // 檔案變動 → 需要重新確認
  app.inventory.addEnrollment('S01', {name: '自學課程', grade: 80});
  const second = await drive(app, S01, '幫我盤點能力', {decide: () => ({type: 'confirm_profile'})});
  assert.equal(second.status, 'completed');
  assert.equal(second.profile.skills.find(s => s.skillId === 'SK-DAT-001').kept, false, '先前取消納入的技能不應被重新納入');
  assert.ok(o.listRuns(S01).length >= 2);
  app.close();
});

test('設定值解析：關閉故障注入接受多種寫法', () => {
  for (const off of ['0', 'false', 'OFF', 'no', ' False ']) assert.equal(loadConfig({...baseEnv, FOMO_DEMO_FAULTS: off}).demoFaults, false, off);
  for (const on of ['1', 'true', 'yes', '']) assert.equal(loadConfig({...baseEnv, FOMO_DEMO_FAULTS: on}).demoFaults, true, on);
  assert.equal(loadConfig(baseEnv).demoFaults, true);
  assert.equal(loadConfig({...baseEnv, FOMO_COOKIE_SECURE: '1'}).cookieSecure, true);
  assert.deepEqual(loadConfig({...baseEnv, FOMO_ALLOWED_HOSTS: 'Demo.example , app.example:443'}).allowedHosts, ['demo.example', 'app.example:443']);
});

// ---------- HTTP 層 ----------
let ctx;
before(async () => { ctx = await start(loadConfig({...baseEnv, PORT: '0', FOMO_COOKIE_SECURE: '1'})); });
after(async () => { await ctx.stop(); });

/** 以 node:http 送出請求，可自訂 Host、Cookie 等 fetch 不允許覆寫的標頭。 */
function rawRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const {hostname, port} = new URL(ctx.url);
    const req = http.request({hostname, port, method, path, headers: {...(body ? {'content-type': 'application/json'} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('HTTP：無法解析的 Origin、壞掉的 Cookie 與路徑編碼都不會造成 500', async () => {
  assert.equal((await rawRequest('POST', '/api/login', {origin: 'null'}, {userId: 'S01'})).status, 403);
  assert.equal((await rawRequest('POST', '/api/login', {origin: 'not a url'}, {userId: 'S01'})).status, 403);
  assert.equal((await rawRequest('GET', '/api/me', {cookie: 'fomo_session=%E0%A4%A'})).status, 200);
  assert.equal((await rawRequest('GET', '/api/profile', {cookie: 'fomo_session=%'})).status, 401);
  assert.equal((await rawRequest('GET', '/campus/syllabus/%')).status, 404);
});

test('HTTP：Host 白名單擋下以其他網域指向本機的請求；Cookie 可加上 Secure', async () => {
  assert.equal((await rawRequest('GET', '/api/meta', {host: 'evil.example'})).status, 403);
  assert.equal((await rawRequest('GET', '/api/meta', {host: `localhost:${new URL(ctx.url).port}`})).status, 200);
  const login = await rawRequest('POST', '/api/login', {}, {userId: 'S01'});
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800; Secure$/);
});

test('HTTP：管理者查驗自填修課時看得到自填成績；學生可刪除尚未驗證的自填紀錄', async () => {
  const session = async userId => {
    const res = await rawRequest('POST', '/api/login', {}, {userId});
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    return async (method, path, body) => {
      const out = await rawRequest(method, path, {cookie}, body);
      return {status: out.status, json: JSON.parse(out.text)};
    };
  };
  const s14 = await session('S14');
  const added = await s14('POST', '/api/profile/enrollments', {code: 'CS330', grade: 100, semester: '114-1'});
  assert.equal(added.status, 200);
  const record = added.json.data.enrollments.find(e => e.code === 'CS330');
  assert.equal(record.verified, false);

  // 跑一次盤點，讓自填修課產生（自述）證據
  let run = (await s14('POST', '/api/agent/run', {goal: '幫我盤點能力'})).json.data;
  while (run.status === 'running') run = (await s14('POST', `/api/agent/${run.id}/auto-step`, {})).json.data;
  const admin = await session('A01');
  const queue = (await admin('GET', '/api/admin/evidence')).json.data;
  const item = queue.find(g => g.ownerId === 'S14' && g.title === '機器學習');
  assert.equal(item.claimedGrade, 100, '承辦人必須看得到要查驗的那個成績');
  assert.equal(item.semester, '114-1');
  assert.ok(queue.filter(g => g.type !== 'course').every(g => g.claimedGrade === null));

  // 學生發現填錯：刪除後可以重新填寫
  const s02 = await session('S02');
  assert.equal((await s02('POST', `/api/profile/enrollments/${record.id}/delete`, {})).status, 404, '不能刪除別人的紀錄');
  const removed = await s14('POST', `/api/profile/enrollments/${record.id}/delete`, {});
  assert.equal(removed.status, 200);
  assert.ok(!removed.json.data.enrollments.some(e => e.code === 'CS330'));
  assert.ok(!removed.json.data.profile.skills.some(s => s.evidence.some(e => e.title === '機器學習')), '相關證據一併移除');
  assert.equal((await s14('POST', '/api/profile/enrollments', {code: 'CS330', grade: 85})).status, 200);
  const seeded = removed.json.data.enrollments.find(e => e.verified);
  assert.equal((await s14('POST', `/api/profile/enrollments/${seeded.id}/delete`, {})).status, 403, '已驗證的紀錄不能自行刪除');
  assert.equal((await s14('POST', '/api/profile/enrollments/abc/delete', {})).status, 400);
});
