// 技能中樞的唯讀資料層：讀取三個 Python Agent 產出的 SQLite，全部以 ESCO 技能 URI 串接。
//   ESCO 資料庫    esco_skills、esco_skill_relations、esco_skill_similar、esco_labels_zh （shared/esco）
//   課程資料庫     courses、course_skills、course_analysis   （course-agent）
//   技能中樞資料庫 competitions、advisors、entity_skills      （competition-agent、advisor-agent）
// 網站不寫入這些資料庫；分析由各 Agent 的命令列程式完成（見 jobs.js）。
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {safeJsonParse} from '../util.js';
import {maskName} from './match.js';

const FINISHED = new Set(['mapped', 'unmapped']);
const COLLEGE_LEVELS = ['大學部', '碩士班', '博士班'];

/** 開啟唯讀連線；檔案不存在時回傳 null（代表該 Agent 的資料尚未建立）。 */
function openReadOnly(file) {
  if (!file || !fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, {readOnly: true});
  // 批次分析可能正在寫入同一個檔案：遇到鎖定時等待，而不是立刻失敗
  db.exec('PRAGMA busy_timeout = 4000;');
  return db;
}

/** 資料庫裡的 JSON 欄位由其他程式寫入：內容不是預期的型別時退回空值，不讓整頁壞掉。 */
const jsonArray = text => {
  const value = safeJsonParse(text, []);
  return Array.isArray(value) ? value : [];
};
const jsonObject = text => {
  const value = safeJsonParse(text, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};

const hasTable = (db, name) => Boolean(db?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * @param {{escoDb:string, courseDb:string, hubDb:string, showNames:boolean}} options
 */
export function createHubStore({escoDb, courseDb, hubDb, showNames = false}) {
  const handles = new Map();
  /**
   * 連線延後到第一次使用時才開；檔案之後才出現也能接上。
   * 資料庫被刪除重建（例如重跑建置腳本）時檔案的 inode 會變：關掉舊連線改開新檔，不然會一直讀到已刪除的舊檔。
   */
  const connect = (key, file) => {
    const stat = file ? fs.statSync(file, {throwIfNoEntry: false}) : undefined;
    const current = handles.get(key);
    if (current && (!stat || stat.ino !== current.ino)) {
      current.db.close();
      handles.delete(key);
    }
    if (!handles.has(key) && stat) handles.set(key, {db: openReadOnly(file), ino: stat.ino});
    return handles.get(key)?.db ?? null;
  };
  const esco = () => connect('esco', escoDb);
  const courses = () => connect('courses', courseDb);
  const hub = () => connect('hub', hubDb);

  // ---- ESCO 技能目錄：內容固定，載入一次後留在記憶體 ----
  let catalog = null;
  function loadCatalog() {
    if (catalog) return catalog;
    const db = esco();
    if (!db || !hasTable(db, 'esco_skills')) return {labels: new Map(), ready: false};
    const labels = new Map(db.prepare('SELECT concept_uri, preferred_label, description FROM esco_skills').all()
      .map(r => [r.concept_uri, {label: r.preferred_label, description: r.description}]));
    catalog = {labels, ready: true};
    return catalog;
  }

  const displayName = name => (showNames ? name : maskName(name));

  // 整份清單（教師、已分析課程）每次配對都會用到；資料庫檔案沒有變動時沿用上次的結果
  const cache = new Map();
  const stampOf = file => {
    const stat = fs.statSync(file, {throwIfNoEntry: false});
    return stat ? `${stat.mtimeMs}:${stat.size}` : 'missing';
  };
  function cached(key, file, compute) {
    // 清單裡含技能的顯示名稱，所以 ESCO 資料庫（中文名稱）有變動時也要重算
    const stamp = `${stampOf(file)}|${stampOf(escoDb)}`;
    const hit = cache.get(key);
    if (hit?.stamp === stamp) return hit.value;
    const value = compute();
    cache.set(key, {stamp, value});
    return value;
  }

  /**
   * 技能之間的關聯：uri → (相關 uri → broader｜narrower｜related｜similar)。
   * 前三種是 ESCO 官方關聯；similar 是以文字向量找出的語意相近技能，只在沒有官方關聯時才補上。
   * 爬到新比賽後相近配對會重算，所以跟著檔案變動重讀。
   */
  const relations = () => cached('relations', escoDb, () => {
    const map = new Map();
    const add = (from, to, relation) => {
      if (!map.has(from)) map.set(from, new Map());
      if (!map.get(from).has(to)) map.get(from).set(to, relation);
    };
    if (hasTable(esco(), 'esco_skill_relations')) {
      for (const r of esco().prepare('SELECT concept_uri, related_uri, relation FROM esco_skill_relations').all()) add(r.concept_uri, r.related_uri, r.relation);
    }
    if (hasTable(esco(), 'esco_skill_similar')) {
      for (const r of esco().prepare('SELECT concept_uri, related_uri FROM esco_skill_similar ORDER BY similarity DESC').all()) add(r.concept_uri, r.related_uri, 'similar');
    }
    return map;
  });

  /** 技能的繁體中文顯示名稱（模型翻譯，只供閱讀）；分析工作會陸續補上，所以跟著檔案變動重讀。 */
  const zhLabels = () => cached('zh', escoDb, () => (hasTable(esco(), 'esco_labels_zh')
    ? new Map(esco().prepare('SELECT concept_uri, label_zh FROM esco_labels_zh').all().map(r => [r.concept_uri, r.label_zh]))
    : new Map()));

  /** label 是顯示名稱（有中文就用中文），en 是 ESCO 官方英文名稱；比對一律用 uri。 */
  const skillView = (uri, extra = {}) => {
    const item = loadCatalog().labels.get(uri);
    const en = item?.label ?? uri;
    return {uri, label: zhLabels().get(uri) ?? en, en, description: item?.description ?? '', ...extra};
  };

  // ---- 比賽 ----
  function entitySkills(type, id) {
    return hub().prepare('SELECT concept_uri, source_section, evidence FROM entity_skills WHERE entity_type = ? AND entity_id = ? ORDER BY rowid').all(type, id)
      .map(r => skillView(r.concept_uri, {evidence: r.evidence, sourceSection: r.source_section}));
  }

  function competitionView(row, today) {
    const open = !row.deadline || row.deadline >= today;
    const eligibility = jsonObject(row.eligibility_json);
    const levels = eligibility.education_levels;
    return {
      // 簡章有寫學歷限制、而且不含大專以上，才判定大專生不能參加；沒寫的不排除
      collegeEligible: !Array.isArray(levels) || levels.some(level => COLLEGE_LEVELS.includes(level)),
      id: row.competition_id, name: row.name, organizer: row.organizer, category: row.category, summary: row.summary,
      sourceSite: row.source_site, sourceUrl: row.source_url, startDate: row.start_date, deadline: row.deadline, open,
      status: row.status, eligibility, analyzedAt: row.analyzed_at,
    };
  }

  function listCompetitions(today) {
    if (!hasTable(hub(), 'competitions')) return [];
    return hub().prepare('SELECT * FROM competitions ORDER BY (deadline IS NULL), deadline, name').all().map(row => {
      const skills = entitySkills('competition', row.competition_id);
      return {...competitionView(row, today), skillCount: skills.length, skills: skills.map(s => ({uri: s.uri, label: s.label, en: s.en}))};
    });
  }

  function getCompetition(id, today) {
    if (!hasTable(hub(), 'competitions')) return null;
    const row = hub().prepare('SELECT * FROM competitions WHERE competition_id = ?').get(id);
    if (!row) return null;
    return {...competitionView(row, today), conditions: jsonArray(row.conditions_json), fetchedAt: row.fetched_at,
      model: row.model, skills: entitySkills('competition', id)};
  }

  // ---- 教師 ----
  const listAdvisors = () => cached('advisors', hubDb, loadAdvisors);
  function loadAdvisors() {
    if (!hasTable(hub(), 'advisors')) return [];
    const byTeacher = Map.groupBy(
      hub().prepare("SELECT entity_id, concept_uri, source_section, evidence FROM entity_skills WHERE entity_type = 'advisor' ORDER BY rowid").all(),
      r => r.entity_id);
    return hub().prepare('SELECT * FROM advisors ORDER BY college, department, teacher_id').all().map(row => {
      // 專長與證據摘自教師的公開資料，可能含本人姓名；遮蔽姓名時連這些文字裡的姓名一起遮蔽
      const scrub = text => (showNames || !row.name ? text : String(text ?? '').replaceAll(row.name, maskName(row.name)));
      return {
        id: row.teacher_id, name: displayName(row.name), college: row.college, department: row.department,
        expertise: jsonArray(row.expertise_json).map(scrub), status: row.status,
        skills: (byTeacher.get(row.teacher_id) ?? []).map(r => skillView(r.concept_uri, {evidence: scrub(r.evidence), sourceSection: r.source_section})),
      };
    });
  }

  // ---- 課程 ----
  const courseReady = () => hasTable(courses(), 'courses') && hasTable(courses(), 'course_skills');
  const courseView = row => ({courseId: row.course_id, year: row.year, semester: row.semester, code: row.selection_code, name: row.course_name.trim()});

  function courseSkills(courseId) {
    return courses().prepare('SELECT concept_uri, source_section, evidence FROM course_skills WHERE course_id = ? ORDER BY rowid').all(courseId)
      .map(r => skillView(r.concept_uri, {evidence: r.evidence, sourceSection: r.source_section}));
  }

  /** 已分析且有技能的課程（給「課程技能」頁與補缺口推薦用）。 */
  const listAnalyzedCourses = () => cached('courses', courseDb, loadAnalyzedCourses);
  function loadAnalyzedCourses() {
    if (!courseReady()) return [];
    const byCourse = Map.groupBy(
      courses().prepare('SELECT course_id, concept_uri, source_section, evidence FROM course_skills ORDER BY rowid').all(), r => r.course_id);
    if (!byCourse.size) return [];
    return courses().prepare('SELECT course_id, year, semester, selection_code, course_name FROM courses ORDER BY year DESC, semester DESC, selection_code').all()
      .filter(row => byCourse.has(row.course_id))
      .map(row => ({...courseView(row), skills: byCourse.get(row.course_id).map(r => skillView(r.concept_uri, {evidence: r.evidence, sourceSection: r.source_section}))}));
  }

  function analysisStatus(courseId) {
    if (!hasTable(courses(), 'course_analysis')) return null;
    return courses().prepare('SELECT status FROM course_analysis WHERE course_id = ?').get(courseId)?.status ?? null;
  }

  /** 以學年、學期、選課代碼與課名保守查找課程；同代碼多筆或課名不符都不猜。 */
  function resolveEnrollment(enrollment) {
    const base = {academicYear: enrollment.academic_year, semester: enrollment.semester, courseCode: enrollment.course_code, courseName: enrollment.course_name};
    if (!courseReady()) return {...base, status: 'unavailable', analysis: null, skills: []};
    const rows = courses().prepare('SELECT course_id, year, semester, selection_code, course_name FROM courses WHERE year = ? AND semester = ? AND selection_code = ?')
      .all(enrollment.academic_year, enrollment.semester, enrollment.course_code)
      .filter(row => row.course_name.trim() === enrollment.course_name.trim());
    if (rows.length !== 1) return {...base, status: rows.length ? 'ambiguous' : 'not_found', analysis: null, skills: []};
    const status = analysisStatus(rows[0].course_id);
    const skills = courseSkills(rows[0].course_id);
    // 有技能關聯就視為已分析（可能來自 Course Agent 的 MCP 工具，沒有狀態紀錄）
    const analysis = FINISHED.has(status) ? status : skills.length ? 'mapped' : status ?? 'pending';
    return {...base, courseId: rows[0].course_id, status: 'matched', analysis, skills};
  }

  function searchCourses(query, limit = 20) {
    if (!courseReady()) return [];
    const pattern = `%${query.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
    return courses().prepare("SELECT course_id, year, semester, selection_code, course_name FROM courses WHERE course_name LIKE ? ESCAPE '\\' ORDER BY year DESC, semester DESC, selection_code LIMIT ?")
      .all(pattern, limit).map(courseView);
  }

  // ---- 總覽 ----
  const count = (db, sql) => (db ? db.prepare(sql).get().n : 0);
  function topSkills(db, sql, limit = 8) {
    return db.prepare(sql).all(limit).map(r => skillView(r.concept_uri, {count: r.n}));
  }

  function overview(today) {
    const {labels, ready} = loadCatalog();
    const hubReady = ['entity_skills', 'competitions', 'advisors'].every(name => hasTable(hub(), name));
    const coursesOk = courseReady();
    const analysisOk = hasTable(courses(), 'course_analysis');
    const competitionUris = hubReady ? new Set(hub().prepare("SELECT DISTINCT concept_uri FROM entity_skills WHERE entity_type = 'competition'").all().map(r => r.concept_uri)) : new Set();
    const advisorUris = hubReady ? new Set(hub().prepare("SELECT DISTINCT concept_uri FROM entity_skills WHERE entity_type = 'advisor'").all().map(r => r.concept_uri)) : new Set();
    const courseUris = coursesOk ? new Set(courses().prepare('SELECT DISTINCT concept_uri FROM course_skills').all().map(r => r.concept_uri)) : new Set();
    const covered = other => [...competitionUris].filter(uri => other.has(uri)).length;
    return {
      ready: {esco: ready, courses: coursesOk, hub: hubReady},
      counts: {
        // 關聯雙向各存一列，所以除以 2
        escoSkills: labels.size, escoRelations: hasTable(esco(), 'esco_skill_relations') ? count(esco(), 'SELECT count(*) AS n FROM esco_skill_relations') / 2 : 0,
        similarPairs: hasTable(esco(), 'esco_skill_similar') ? count(esco(), 'SELECT count(*) AS n FROM esco_skill_similar') / 2 : 0,
        competitions: hubReady ? count(hub(), 'SELECT count(*) AS n FROM competitions') : 0,
        competitionsOpen: hubReady ? hub().prepare('SELECT count(*) AS n FROM competitions WHERE deadline IS NULL OR deadline >= ?').get(today).n : 0,
        advisors: hubReady ? count(hub(), 'SELECT count(*) AS n FROM advisors') : 0,
        advisorsMapped: hubReady ? count(hub(), "SELECT count(*) AS n FROM advisors WHERE status = 'mapped'") : 0,
        courses: coursesOk ? count(courses(), 'SELECT count(*) AS n FROM courses') : 0,
        coursesAnalyzed: analysisOk ? count(courses(), "SELECT count(*) AS n FROM course_analysis WHERE status IN ('mapped', 'unmapped')") : 0,
        coursesMapped: coursesOk ? count(courses(), 'SELECT count(DISTINCT course_id) AS n FROM course_skills') : 0,
        competitionSkills: competitionUris.size, advisorSkills: advisorUris.size, courseSkills: courseUris.size,
      },
      // 串接的效果：比賽需要的技能，有多少在課程與教師那一側找得到同一個 ESCO 技能
      bridge: {competitionSkills: competitionUris.size, taughtByCourses: covered(courseUris), coveredByAdvisors: covered(advisorUris)},
      topSkills: {
        competition: hubReady ? topSkills(hub(), "SELECT concept_uri, count(*) AS n FROM entity_skills WHERE entity_type = 'competition' GROUP BY concept_uri ORDER BY n DESC, concept_uri LIMIT ?") : [],
        advisor: hubReady ? topSkills(hub(), "SELECT concept_uri, count(*) AS n FROM entity_skills WHERE entity_type = 'advisor' GROUP BY concept_uri ORDER BY n DESC, concept_uri LIMIT ?") : [],
        course: coursesOk ? topSkills(courses(), 'SELECT concept_uri, count(*) AS n FROM course_skills GROUP BY concept_uri ORDER BY n DESC, concept_uri LIMIT ?') : [],
      },
    };
  }

  /** 三個資料來源是否已建立（不計算統計數字，給需要頻繁判斷的呼叫端用）。 */
  const ready = () => ({esco: loadCatalog().ready, courses: courseReady(), hub: ['entity_skills', 'competitions', 'advisors'].every(name => hasTable(hub(), name))});

  return Object.freeze({
    ready, hasSkill: uri => loadCatalog().labels.has(uri),
    /** 三個資料庫目前的版本戳記；呼叫端可用來判斷自己的快取是否還有效。 */
    version: () => [escoDb, courseDb, hubDb].map(stampOf).join('|'),
    overview, listCompetitions, getCompetition, listAdvisors, listAnalyzedCourses, resolveEnrollment, searchCourses,
    relations, skillView,
    close: () => { for (const handle of handles.values()) handle.db?.close(); handles.clear(); },
  });
}
