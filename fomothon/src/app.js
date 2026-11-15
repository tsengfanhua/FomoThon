// 組裝整個系統：共用 Skill 資料庫、能力盤點模組、三個媒合 Agent 與協調器。
import {createBrain} from './agents/brain.js';
import {createCompetitionAgent} from './agents/competition.js';
import {createOrchestrator} from './agents/orchestrator.js';
import {createTeacherAgent} from './agents/teacher.js';
import {createTeammateAgent} from './agents/teammate.js';
import {createToolRunner} from './agents/tools.js';
import {createAuth} from './auth.js';
import {createCampusCompetition} from './campus/competition.js';
import {createCampusInventory} from './campus/inventory.js';
import {createCampusSkills} from './campus/skills.js';
import {createCampusTeacher} from './campus/teacher.js';
import {createCampusTeammate} from './campus/teammate.js';
import {isSeeded, listPersonNames, loadSeed, openDb, transaction, transactionAsync} from './db.js';
import {createSyllabusFetcher, httpSource, localSource} from './inventory/campus.js';
import {extractSkills} from './inventory/extractor.js';
import {createInventory} from './inventory/inventory.js';
import {createHub} from './hub/index.js';
import {createLlm} from './llm/index.js';
import {createLevels} from './skills/levels.js';
import {createSkillRepo} from './skills/repo.js';
import {assertDataQuality, readSeedBundle, runDataQuality} from './dq/index.js';
import {createTrace} from './trace.js';
import {createClock} from './util.js';

/** 首次啟動：解析全部課綱並為示意學生建立證據與 Profile（規則式、不呼叫 LLM）。 */
async function buildSeedData({db, skills, rules, inventory, students}) {
  transaction(db, () => {
    const ins = db.prepare('INSERT OR REPLACE INTO course_skills (course_code, skill_id, coverage) VALUES (?, ?, ?)');
    for (const row of db.prepare('SELECT code, name, syllabus FROM courses').all()) {
      for (const item of extractSkills({name: row.name, ...JSON.parse(row.syllabus)}, skills, rules)) ins.run(row.code, item.skillId, item.coverage);
    }
  });
  const ctx = {trace: createTrace(null, null), faults: {}, noLlm: true};
  for (const s of students) {
    await inventory.run(ctx, s.id);
    for (const ev of s.evidence) {
      inventory.addEvidence(s.id, {type: ev.type, title: ev.title, skillIds: ev.skills, exam: ev.exam}, {verified: ev.verified, verifiedBy: ev.verified ? 'seed' : null});
    }
    if (s.profileConfirmed) inventory.confirmProfile(s.id);
  }
}

/**
 * @param {object} config loadConfig() 的結果
 * @param {{llm?:object}} [overrides] 測試時可注入假的 LLM
 */
export async function createApp(config, overrides = {}) {
  const db = openDb(config.dbPath);
  const fresh = !isSeeded(db);
  // 首次啟動：載入種子資料與建立 Profile 包在同一個交易裡，確保不會留下只建到一半的資料庫。
  return fresh ? transactionAsync(db, () => assemble(db, config, overrides, true)) : assemble(db, config, overrides, false);
}

/**
 * 資料版本（存在 SQLite 的 user_version）。
 * 2：修課證據帶有課綱品質評估（detail.quality）。舊版資料庫啟動時會重新盤點一次，讓證據狀態依新規則重算。
 */
export const DATA_VERSION = 2;

async function migrateData(db, inventory) {
  const {user_version: version} = db.prepare('PRAGMA user_version').get();
  if (version >= DATA_VERSION) return;
  const ctx = {trace: createTrace(null, null), faults: {}, noLlm: true};
  const owners = db.prepare("SELECT DISTINCT owner_id FROM evidence WHERE type = 'course' ORDER BY owner_id").all().map(r => r.owner_id);
  for (const ownerId of owners) await inventory.run(ctx, ownerId);
  db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
}

/** 資料閘門：種子資料有 error 等級的品質問題（缺必填欄位、引用不存在的技能、別名誤判……）就拒絕建庫。 */
function seedDatabase(db, bundle, env) {
  assertDataQuality(runDataQuality(bundle, env));
  return loadSeed(db, bundle);
}

function createCampus({hub, db, config, skills, tools, clock}) {
  const {store} = hub;
  const rules = config.rules;
  const campusSkills = createCampusSkills({store, sk: skills});
  const inventory = createCampusInventory({hub, tools, personasFile: config.hub.personasFile});
  let lastFailure = null; // 只在錯誤訊息改變時記錄，避免每個請求都寫一行

  /**
   * 這種資料來源需要的資料是否已建立：hybrid 要比賽與教師；campus 另外要課程技能。
   * 資料庫檔案存在但讀不了（損毀、寫到一半被中斷）時當成還沒建立：助理退回合成資料，網站其他部分不受影響。
   */
  function available(source = 'hybrid') {
    try {
      const ready = store.ready();
      lastFailure = null;
      return ready.esco && ready.hub && (source !== 'campus' || ready.courses);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (message !== lastFailure) process.stderr.write(`[campus] 真實資料無法讀取，助理改用合成示意資料：${message}\n`);
      lastFailure = message;
      return false;
    }
  }

  return Object.freeze({
    available,
    skills: campusSkills,
    inventory,
    competition: createCampusCompetition({store, skills: campusSkills, clock, tools, rules}),
    teammate: createCampusTeammate({db, hub, inventory, skills: campusSkills, rules, tools, config}),
    teacher: createCampusTeacher({store, skills: campusSkills, rules, tools}),
  });
}

async function assemble(db, config, overrides, fresh) {
  const clock = createClock(config.today);
  const dqEnv = {today: clock.todayStr(), rules: config.rules};
  const dataQuality = () => runDataQuality(overrides.seedBundle ?? readSeedBundle(), dqEnv);
  const seed = fresh ? seedDatabase(db, overrides.seedBundle ?? readSeedBundle(), dqEnv) : null;

  const skills = createSkillRepo(db);
  const levels = createLevels(config.rules);
  const tools = createToolRunner();
  const llm = overrides.llm ?? await createLlm(config.llm);

  // 課綱來源可切換：建置種子資料時直接讀本機，之後依設定改走 HTTP。
  const sourceRef = {current: localSource(db), baseUrl: config.syllabus.baseUrl};
  tools.register({
    name: 'syllabus.fetch', agent: 'inventory', permission: 'read',
    summarize: r => `取得「${r.name}」課綱（${r.weeks.length} 週、${r.assessments.length} 項評量）`,
    handler: createSyllabusFetcher({get: code => sourceRef.current.get(code)}),
  });

  const deps = {db, config, rules: config.rules, clock, skills, levels, tools, llm};
  const inventory = createInventory(deps);
  const competition = createCompetitionAgent(deps);
  const teammate = createTeammateAgent(deps);
  const teacher = createTeacherAgent(deps);
  const brain = createBrain({llm, personNames: () => listPersonNames(db)});
  const auth = createAuth({db, config});
  // 技能中樞：讀取競賽、教師、課程三個 Agent 以 ESCO 技能串接的分析結果
  const hub = overrides.hub ?? createHub({config, clock});
  // 真實資料模式的 Agent：與合成資料版介面相同，資料改讀技能中樞。技能中樞沒有資料時 available() 為 false，助理退回合成資料
  const campus = hub.store ? createCampus({hub, db, config, skills, tools, clock}) : null;
  const orchestrator = createOrchestrator({...deps, inventory, competition, teammate, teacher, brain, campus});

  if (fresh) {
    await buildSeedData({db, skills, rules: config.rules, inventory, students: seed.students});
    db.exec(`PRAGMA user_version = ${DATA_VERSION}`);
  } else {
    await migrateData(db, inventory); // 在切換到 HTTP 課綱來源之前執行（此時伺服器尚未啟動）
  }
  if (config.syllabus.mode === 'http') sourceRef.current = httpSource(() => sourceRef.baseUrl, config.syllabus.timeoutMs);

  return Object.freeze({
    db, config, clock, skills, levels, tools, llm, inventory, competition, teammate, teacher, orchestrator, auth, dataQuality, hub, campus,
    /** 伺服器啟動後才知道實際埠號時，用來指定示意課綱站的位置。 */
    setSyllabusBaseUrl: url => { if (!config.syllabus.baseUrl) sourceRef.baseUrl = url; },
    close: () => { hub.close(); db.close(); },
  });
}
