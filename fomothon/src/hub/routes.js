// 技能中樞的 API 路由（/api/hub/*）：全部需要登入；讀取類開放給所有角色，
// 會對外連線或呼叫模型的動作（爬蟲、課程分析）另外限制頻率並寫入稽核紀錄。
import {audit} from '../db.js';
import {AppError} from '../util.js';
import {v} from '../validate.js';

const COMPETITION_ID = /^[a-z]{2,12}-[a-z0-9]{6,40}$/;
const JOB_ID = /^J-[A-Za-z0-9_-]{6,12}$/;
const MAX_ENROLLMENTS = 60;

const enrollment = v.object({
  academic_year: v.int({min: 100, max: 200}),
  semester: v.int({min: 1, max: 4}),
  course_code: v.string({pattern: /^[0-9A-Za-z]{1,10}$/, max: 10}),
  course_name: v.string({min: 1, max: 80}),
});
const enrollmentsBody = v.object({enrollments: v.array(enrollment, {min: 1, max: MAX_ENROLLMENTS})});
const matchBody = v.object({
  competitionId: v.string({pattern: COMPETITION_ID, max: 60}),
  enrollments: v.array(enrollment, {min: 1, max: MAX_ENROLLMENTS}),
});
// 只接受 https 網址；是否為公開網域、是否允許抓取，由競賽 Agent 的爬蟲再檢查一次
const crawlBody = v.object({url: v.string({pattern: /^https:\/\/[^\s"'<>]{4,290}$/, max: 300, optional: true})});

const text = (query, name, max) => v.string({max, optional: true})(query.get(name) ?? undefined, name) ?? '';
function pageOf(query) {
  const page = Number(query.get('page') ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 10_000) throw new AppError('INVALID_INPUT', 'page：格式不正確');
  return page;
}

export function registerHubRoutes(app, route) {
  const {hub, db} = app;

  route('GET', '/api/hub/overview', async () => ({data: hub.overview()}));

  // ---- 競賽 Agent ----
  route('GET', '/api/hub/competitions', async () => ({data: hub.competitions()}));
  route('GET', '/api/hub/competitions/:id', async ({params}) => {
    if (!COMPETITION_ID.test(params.id)) throw new AppError('INVALID_INPUT', '比賽編號格式不正確');
    return {data: hub.competition(params.id)};
  });
  route('POST', '/api/hub/competitions/crawl', async ({user, body}) => {
    const {url} = crawlBody(body);
    const job = hub.startCrawl(user.id, url);
    // 貼上的網址會變成全站可見的比賽，所以稽核紀錄要查得到是誰貼了哪個網址
    audit(db, user.id, 'hub_crawl_started', job.id, {mode: url ? 'url' : 'latest', url: url ?? null});
    return {data: job};
  }, {limit: 6});

  // ---- 教師 Agent ----
  route('GET', '/api/hub/advisors', async ({query}) => ({
    data: hub.advisors({q: text(query, 'q', 60), college: text(query, 'college', 40), page: pageOf(query)}),
  }));

  // ---- 課程 Agent ----
  route('GET', '/api/hub/courses', async ({query}) => ({data: hub.courses({q: text(query, 'q', 60), page: pageOf(query)})}));
  route('GET', '/api/hub/courses/search', async ({query}) => {
    const q = text(query, 'q', 40);
    return {data: q.length >= 2 ? hub.searchCourses(q) : []};
  });

  // ---- 學生能力分析（修課 → 技能）與參賽配對 ----
  route('GET', '/api/hub/demo-transcripts', async () => ({data: hub.demoTranscripts()}));
  route('POST', '/api/hub/student/skills', async ({body}) => ({data: hub.studentSkills(enrollmentsBody(body).enrollments)}));
  route('POST', '/api/hub/student/analyze', async ({user, body}) => {
    const {enrollments} = enrollmentsBody(body);
    const job = hub.startCourseAnalysis(user.id, enrollments);
    audit(db, user.id, 'hub_course_analysis_started', job.id, {courses: enrollments.length});
    return {data: job};
  }, {limit: 6});
  route('POST', '/api/hub/match', async ({body}) => {
    const input = matchBody(body);
    return {data: hub.match(input.competitionId, input.enrollments)};
  }, {limit: 60});

  route('GET', '/api/hub/jobs/:id', async ({user, params}) => {
    if (!JOB_ID.test(params.id)) throw new AppError('INVALID_INPUT', '工作編號格式不正確');
    return {data: hub.job(params.id, user.id, user.role === 'admin')};
  });
}
