// 技能中樞：把四個部分串起來的地方。
//   競賽 Agent（爬蟲＋簡章分析）→ 比賽需要的技能與條件
//   教師 Agent（教師 profile 分析）→ 教師具備的技能
//   課程 Agent（課綱分析）→ 課程教授的技能、學生修課對應的技能
//   本平台 → 以共用的 ESCO 技能比對，找出缺口、可補缺口的課程與可指導的教師
// 這裡只組合各 Agent 已產出的結果；分數全部由固定規則計算，不呼叫模型。
import fs from 'node:fs';
import path from 'node:path';
import {AppError, safeJsonParse} from '../util.js';
import {createJobRunner} from './jobs.js';
import {compareSkills, rankAdvisors, recommendCourses, summarize} from './match.js';
import {createHubStore} from './store.js';

const PAGE_SIZE = 24;
const DEMO_TRANSCRIPTS = /^student_demo_\d{3}\.json$/;
const RELATION_NOTE = Object.freeze({broader: '具備它的上位技能', narrower: '具備它的下位技能', related: '具備 ESCO 標示的相關技能', similar: '具備語意相近的技能'});

const includesText = (text, q) => String(text ?? '').toLowerCase().includes(q);
/** 技能可以用中文顯示名稱或 ESCO 英文名稱搜尋。 */
const skillMatches = (skill, q) => includesText(skill.label, q) || includesText(skill.en, q);

/**
 * @param {{config:{hub:object}, clock:{todayStr:()=>string}, spawnImpl?:Function}} deps
 */
export function createHub({config, clock, spawnImpl}) {
  const settings = config.hub;
  const store = createHubStore(settings);
  const jobs = createJobRunner({root: settings.root, python: settings.python, enabled: settings.jobs, spawnImpl});
  const today = () => clock.todayStr();

  const paginate = (items, page) => ({total: items.length, page, pageSize: PAGE_SIZE, items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)});

  function overview() {
    return {...store.overview(today()), jobsEnabled: jobs.enabled, namesMasked: !settings.showNames, today: today()};
  }

  function competitions() {
    return store.listCompetitions(today());
  }

  function competition(id) {
    const item = store.getCompetition(id, today());
    if (!item) throw new AppError('NOT_FOUND', '找不到這個比賽', 404);
    return item;
  }

  function advisors({q = '', college = '', page = 1}) {
    const all = store.listAdvisors();
    const needle = q.trim().toLowerCase();
    const filtered = all.filter(a => (!college || a.college === college) && (!needle
      // 姓名遮蔽時不提供姓名搜尋，避免用搜尋結果反推出完整姓名
      || includesText(a.department, needle) || a.expertise.some(x => includesText(x, needle))
      || a.skills.some(s => skillMatches(s, needle)) || (settings.showNames && includesText(a.name, needle))));
    return {...paginate(filtered, page), colleges: [...new Set(all.map(a => a.college).filter(Boolean))].sort()};
  }

  function courses({q = '', page = 1}) {
    const needle = q.trim().toLowerCase();
    const filtered = store.listAnalyzedCourses().filter(c => !needle || includesText(c.name, needle) || c.skills.some(s => skillMatches(s, needle)));
    return paginate(filtered, page);
  }

  /** course-agent 附的合成成績單（課程是真實開課資料，學生與成績是合成的）；只回傳課程識別欄位，不含成績。 */
  function demoTranscripts() {
    const dir = path.join(settings.root, 'course-agent', 'data', 'demo', 'synthetic_transcripts');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(name => DEMO_TRANSCRIPTS.test(name)).sort().map((name, index) => {
      const records = safeJsonParse(fs.readFileSync(path.join(dir, name), 'utf8'), []);
      return {id: name.replace('.json', ''), label: `示範學生 ${index + 1}`,
        enrollments: (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object').map(r => ({
          academic_year: r.academic_year, semester: r.semester, course_code: r.course_code, course_name: r.course_name}))};
    });
  }

  /** 學生能力分析：修課 → 課程 → 課程技能，同一技能彙整所有來源課程。 */
  function studentSkills(enrollments) {
    // 同一門課重複出現（例如重修）只算一次，不讓同一句課綱在證據中重複
    const unique = [...new Map(enrollments.map(e => [`${e.academic_year}-${e.semester}-${e.course_code}-${e.course_name.trim()}`, e])).values()];
    const resolved = unique.map(e => store.resolveEnrollment(e));
    const skills = new Map();
    for (const course of resolved) {
      for (const skill of course.skills) {
        const entry = skills.get(skill.uri) ?? {uri: skill.uri, label: skill.label, en: skill.en, description: skill.description, sources: []};
        skills.set(skill.uri, {...entry, sources: [...entry.sources, {courseName: course.courseName, courseCode: course.courseCode, evidence: skill.evidence, sourceSection: skill.sourceSection}]});
      }
    }
    return {
      courses: resolved.map(({skills: own, ...rest}) => ({...rest, skillCount: own.length})),
      skills: [...skills.values()].sort((a, b) => b.sources.length - a.sources.length || a.label.localeCompare(b.label)),
      // 課綱不完整的課沒有東西可以分析，不算待分析
      pending: resolved.filter(c => c.status === 'matched' && !['mapped', 'unmapped', 'incomplete'].includes(c.analysis)).length,
      unresolved: resolved.filter(c => c.status !== 'matched').length,
    };
  }

  /** 參賽配對：比賽需求 × 學生技能 → 缺口 → 可補缺口的課程 → 可指導的教師。 */
  function match(competitionId, enrollments) {
    const started = Date.now();
    const trace = [];
    const step = (type, summary, data) => trace.push({type, summary, data: data ?? null, ms: Date.now() - started});

    const contest = competition(competitionId);
    const required = contest.skills.map(s => s.uri);
    step('tool_result', `競賽 Agent：「${contest.name}」需要 ${required.length} 項技能、${contest.conditions.length} 項條件`, {source: contest.sourceSite});

    const student = studentSkills(enrollments);
    const owned = new Map(student.skills.map(s => [s.uri, s]));
    step('tool_result', `課程 Agent：${student.courses.length} 門修課對應到 ${student.skills.length} 項技能`, {pending: student.pending, unresolved: student.unresolved});

    const relations = store.relations();
    const compared = compareSkills(required, owned, relations);
    const summary = summarize(compared);
    step('gate', `技能比對：具備 ${summary.exact}、相近 ${summary.related}、缺口 ${summary.none}`, {rule: '相同 ESCO 技能＝具備；上下位、相關或語意相近的技能＝相近（折半）'});

    const requiredView = contest.skills.map((skill, index) => {
      const m = compared[index];
      return {...skill, level: m.level, relationNote: m.relation ? RELATION_NOTE[m.relation] : null,
        via: m.level === 'related' ? {uri: m.via, label: store.skillView(m.via).label} : null,
        sources: m.via ? owned.get(m.via).sources : []};
    });
    const gaps = compared.filter(m => m.level !== 'exact').map(m => m.uri);

    const takenIds = new Set(student.courses.map(c => c.courseId).filter(Boolean));
    const takenNames = new Set(student.courses.map(c => c.courseName.trim()));
    const pool = store.listAnalyzedCourses().filter(c => !takenIds.has(c.courseId) && !takenNames.has(c.name));
    const byCourse = new Map(pool.map(c => [c.courseId, c]));
    // 學生已經「相近」的技能，只有教到完全相同技能的課才算補得上；再推一門也只是相近的課不會提高涵蓋率
    const partial = new Set(compared.filter(m => m.level === 'related').map(m => m.uri));
    const courseRanking = recommendCourses({gaps, partial, relations, courses: pool.map(c => ({id: c.courseId, skills: new Map(c.skills.map(s => [s.uri, s]))}))});
    const skillRef = m => {
      const view = store.skillView(m.uri);
      return {uri: m.uri, label: view.label, en: view.en, level: m.level};
    };
    const recommendedCourses = courseRanking.map(r => {
      const course = byCourse.get(r.id);
      const own = new Map(course.skills.map(s => [s.uri, s]));
      return {courseId: course.courseId, year: course.year, semester: course.semester, code: course.code, name: course.name,
        covers: r.covers.map(m => ({...skillRef(m), evidence: own.get(m.via).evidence, taught: own.get(m.via).label}))};
    });
    step('tool_result', `課程 Agent：${pool.length} 門已分析課程中，${recommendedCourses.length} 門可補上缺口`, {gaps: gaps.length});

    const advisorList = store.listAdvisors().filter(a => a.skills.length);
    const byAdvisor = new Map(advisorList.map(a => [a.id, a]));
    const advisorRanking = rankAdvisors({required, gaps, relations, advisors: advisorList.map(a => ({id: a.id, skills: new Map(a.skills.map(s => [s.uri, s]))}))});
    const recommendedAdvisors = advisorRanking.map(r => {
      const advisor = byAdvisor.get(r.id);
      const own = new Map(advisor.skills.map(s => [s.uri, s]));
      return {id: advisor.id, name: advisor.name, college: advisor.college, department: advisor.department, expertise: advisor.expertise.slice(0, 6),
        score: r.score, requiredCoverage: r.requiredCoverage, gapCoverage: r.gapCoverage, gapsCovered: r.gapsCovered.length,
        matches: r.matches.map(m => ({...skillRef(m), evidence: own.get(m.via).evidence, has: own.get(m.via).label}))};
    });
    step('tool_result', `教師 Agent：${advisorList.length} 位教師中，推薦 ${recommendedAdvisors.length} 位`, {rule: '比賽技能涵蓋 60%＋缺口涵蓋 40%'});

    return {
      competition: contest, student: {courses: student.courses, skillCount: student.skills.length, pending: student.pending, unresolved: student.unresolved},
      required: requiredView, coverage: summary, courses: recommendedCourses, advisors: recommendedAdvisors, trace,
      notes: [
        '技能來自課綱、教師公開資料與比賽簡章的文字證據，不是能力評分；修過課不等於熟練。',
        '參賽條件請以主辦單位公告為準；未知的條件不會被當成符合。',
        '教師推薦只代表專長相符，不代表教師同意指導；要不要聯絡由你決定。',
      ],
    };
  }

  // 資料庫位置與「今天」都由伺服器設定傳給子程序，Agent 才會寫進網站正在讀的那幾個檔案、用同一個日期判斷是否截止
  const escoArgs = ['--esco-db', settings.escoDb, '--course-db', settings.courseDb];

  function startCrawl(owner, url) {
    const target = url ? ['--url', url] : ['--limit', String(settings.crawlLimit)];
    return jobs.start('crawl', {owner, args: [...target, '--today', today(), '--hub-db', settings.hubDb, ...escoArgs]});
  }

  function startCourseAnalysis(owner, enrollments) {
    return jobs.start('courses', {owner, args: ['--enrollments-stdin', ...escoArgs], stdin: JSON.stringify(enrollments)});
  }

  return Object.freeze({
    store, // 唯讀資料層：真實資料模式的 Agent（src/campus）直接使用
    overview, competitions, competition, advisors, courses, demoTranscripts, studentSkills, match,
    searchCourses: q => store.searchCourses(q), startCrawl, startCourseAnalysis, job: jobs.get,
    close: () => { jobs.close(); store.close(); },
  });
}
