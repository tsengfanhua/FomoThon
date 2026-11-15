// 技能串接頁面：競賽、教師、課程三個 Agent 的分析結果與學生修課，都以同一套 ESCO 技能串起來。
// 與其他頁面相同，所有動態內容都以 DOM 節點建立（不使用 innerHTML）；外部來的文字一律當成純文字顯示。
import {api, bar, card, chip, guard, h, sleep, toast} from './ui.js';

const LEVEL = {exact: ['具備', 'g'], related: ['相近', 'a'], none: ['缺口', 'r']};
const ANALYSIS = {mapped: ['已分析', 'g'], unmapped: ['無可對應技能', ''], incomplete: ['課綱不完整，無法分析', ''], pending: ['尚未分析', 'a'], failed: ['分析失敗', 'r'], needs_review: ['待複核', 'a'], not_found: ['尚未分析', 'a']};
/** 爬蟲沒有產生結果時，競賽 Agent 回報的原因代碼。 */
const CRAWL_REASON = {blocked_by_robots: '該網站的 robots.txt 不允許抓取', non_public_host: '只能分析公開網站', unsupported_url: '網址格式不支援', already_analyzed: '這個比賽已經分析過了',
  closed: '這個比賽已經截止', out_of_scope: '看起來是體育賽事或兒童比賽，不在分析範圍', empty_page: '頁面沒有可讀的文字（可能需要執行腳本才會顯示內容）',
  no_structured_data: '頁面沒有可解析的比賽資料', response_too_large: '頁面太大', compressed_response: '網站只提供壓縮內容，無法安全讀取', network_error: '連不上該網站', too_slow: '網站回應太慢'};
const UNFINISHED = new Set(['failed', 'needs_review']);
const isEnrollment = e => e && typeof e === 'object' && Number.isInteger(e.academic_year) && Number.isInteger(e.semester)
  && typeof e.course_code === 'string' && typeof e.course_name === 'string';
const COURSE_STATUS = {not_found: '課程庫查無此課', ambiguous: '同代碼有多筆，需人工確認', unavailable: '課程資料庫尚未建立'};
const JOB_POLL_MS = 2000;
const MAX_ENROLLMENTS = 60;
const MS_PER_DAY = 86_400_000;

const table = (heads, rows) => h('table', null, h('thead', null, h('tr', null, heads.map(t => h('th', null, t)))), h('tbody', null, rows));
const num = value => Number(value ?? 0).toLocaleString('zh-TW');
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const yesNo = (value, yes, no) => (value === true ? yes : value === false ? no : '簡章未載明');
const enrollmentKey = e => `${e.academic_year}-${e.semester}-${e.course_code}`;

/** 滑鼠移上去時顯示 ESCO 官方英文名稱與定義（中文名稱是翻譯，只供閱讀）。 */
const skillTitle = s => [s.en && s.en !== s.label ? `ESCO：${s.en}` : null, s.description].filter(Boolean).join('\n') || s.label;
/** 技能名稱，後面以小字附上 ESCO 英文名稱。 */
const skillName = s => [h('b', {title: skillTitle(s)}, s.label), s.en && s.en !== s.label && h('span', {class: 'mu small'}, ` ${s.en}`)];

function skillChips(skills, tone = 'b') {
  return h('div', {class: 'chips'}, skills.map(s => h('span', {class: `chip ${tone}`, title: skillTitle(s)}, s.label)));
}

function evidenceList(skills) {
  return h('details', null, h('summary', null, `${skills.length} 項技能的原文證據`),
    skills.map(s => h('div', {class: 'quote'}, skillName(s), `：「${s.evidence}」`)));
}

/**
 * @param {{state:object, render:Function, go:Function, showHubTrace:Function}} ctx
 */
export function createHubPages(ctx) {
  const {state} = ctx;
  const hub = {
    overview: null, competitions: [], detail: null, advisors: null, courses: null, demo: [], enrollments: null,
    student: null, match: null, job: null,
    f: {category: '', openOnly: true, collegeOnly: true, crawlUrl: '', advisorQ: '', advisorCollege: '', advisorPage: 1, courseQ: '', coursePage: 1,
      search: '', results: [], competitionId: ''},
  };

  // ---------- 修課清單（存在這台瀏覽器，不上傳成績） ----------
  const storeKey = () => `hub.enrollments.${state.me.id}`;
  function loadEnrollments() {
    if (hub.enrollments?.owner === state.me.id) return;
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(storeKey()) ?? '[]');
    } catch { /* 存檔毀損就從空白開始 */ }
    // 存檔可能被改壞：只留下欄位齊全的項目，不然伺服器會整批拒絕、畫面卡住
    hub.enrollments = {owner: state.me.id, list: Array.isArray(saved) ? saved.filter(isEnrollment).slice(0, MAX_ENROLLMENTS) : []};
    hub.student = null;
    hub.match = null;
  }
  function setEnrollments(list) {
    hub.enrollments = {owner: state.me.id, list: list.slice(0, MAX_ENROLLMENTS)};
    hub.student = null;
    hub.match = null;
    try {
      localStorage.setItem(storeKey(), JSON.stringify(hub.enrollments.list));
    } catch { /* 無法存檔時只影響重新整理後的還原 */ }
  }
  const enrollments = () => hub.enrollments?.list ?? [];

  // ---------- 資料載入 ----------
  const query = params => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null)).toString();
  const loadAdvisors = async () => { hub.advisors = await api('GET', `/api/hub/advisors?${query({q: hub.f.advisorQ, college: hub.f.advisorCollege, page: hub.f.advisorPage})}`); };
  const loadCourses = async () => { hub.courses = await api('GET', `/api/hub/courses?${query({q: hub.f.courseQ, page: hub.f.coursePage})}`); };
  const loadCompetitions = async () => { hub.competitions = await api('GET', '/api/hub/competitions'); };

  async function load(view) {
    const jobs = [api('GET', '/api/hub/overview').then(d => { hub.overview = d; })];
    if (view === 'hub' || view === 'hubMatch') jobs.push(api('GET', '/api/hub/demo-transcripts').then(d => { hub.demo = d; }));
    if (view === 'hubCompetitions' || view === 'hubMatch') jobs.push(loadCompetitions());
    if (view === 'hubAdvisors') jobs.push(loadAdvisors());
    if (view === 'hubCourses') jobs.push(loadCourses());
    if (view === 'hubMatch') loadEnrollments();
    await Promise.all(jobs);
  }

  /** 啟動 Python Agent 的分析工作並輪詢到結束；完成後重新載入資料。 */
  const runJob = guard(async (start, after) => {
    hub.job = await start();
    ctx.render();
    try {
      while (hub.job.status === 'running') {
        await sleep(JOB_POLL_MS);
        hub.job = await api('GET', `/api/hub/jobs/${hub.job.id}`);
        ctx.render();
      }
    } catch (err) {
      // 伺服器重啟或斷線時查不到工作：解除「執行中」的畫面，不然按鈕會一直停用
      hub.job = null;
      ctx.render();
      throw err;
    }
    const {status, summary, error, label, ms} = hub.job;
    ctx.showHubTrace([{type: status === 'done' ? 'tool_result' : 'tool_error', summary: `${label}：${status === 'done' ? '完成' : error}`, ms, data: summary}]);
    const why = (summary?.reasons ?? []).map(code => CRAWL_REASON[code] ?? (/^http_\d+$/.test(code) ? `網站回應 ${code.slice(5)}` : null)).filter(Boolean)[0];
    const nothing = summary?.incomplete ? '這些課的課綱不完整，沒有內容可以分析' : why ? `沒有新增比賽：${why}` : '沒有新的項目需要分析';
    toast(status !== 'done' ? error : summary?.total === 0 ? nothing : '分析完成，已更新資料', status !== 'done');
    await after();
    ctx.render();
  });

  function jobBanner() {
    if (hub.job?.status !== 'running') return null;
    return card({class: 'wait'}, h('b', null, `${hub.job.label}中…`),
      h('div', {class: 'mu small'}, '會對外抓取公開網頁並呼叫模型，通常需要 20 秒到 2 分鐘。可以留在這一頁等它完成。'));
  }

  function notReady(what) {
    return card({class: 'wait'}, h('b', null, `${what}的資料尚未建立`),
      h('div', {class: 'mu small'}, '請依專案根目錄 README 的「建立資料」步驟，先執行對應 Agent 的分析程式。'));
  }

  const pager = (data, onPage) => data.total > data.pageSize && h('div', {class: 'pager'},
    h('button', {class: 'btn ghost sm', type: 'button', disabled: data.page <= 1, onclick: () => onPage(data.page - 1)}, '上一頁'),
    h('span', {class: 'mu small'}, `第 ${data.page} 頁／共 ${Math.ceil(data.total / data.pageSize)} 頁（${num(data.total)} 筆）`),
    h('button', {class: 'btn ghost sm', type: 'button', disabled: data.page * data.pageSize >= data.total, onclick: () => onPage(data.page + 1)}, '下一頁'));

  // ---------- 總覽 ----------
  function overviewPage() {
    const o = hub.overview;
    if (!o) return [h('p', {class: 'mu'}, '載入中…')];
    const c = o.counts;
    const agent = (title, flow, value, unit, note, view, action) => h('div', {class: 'agent'},
      h('div', {class: 't'}, title), h('div', {class: 'mu small'}, flow),
      h('div', {class: 'n'}, num(value), h('small', null, ` ${unit}`)), h('div', {class: 'mu small'}, note),
      h('button', {class: 'btn ghost sm', type: 'button', onclick: () => ctx.go(view)}, action));
    const bridgeRow = (label, part) => [h('span', null, label), bar(part, o.bridge.competitionSkills || 1), h('span', null, `${part} 項（${percent(part, o.bridge.competitionSkills)}%）`)];
    const top = (title, items, unit) => card(null, h('h2', null, title),
      items.length ? table(['ESCO 技能', unit], items.map(s => h('tr', null, h('td', null, skillName(s)), h('td', null, s.count)))) : h('p', {class: 'mu'}, '尚無資料'));
    return [
      h('h1', null, '技能串接總覽'),
      h('p', {class: 'lead'}, '比賽需要什麼、老師會什麼、課程教什麼、學生修過什麼——四邊都對應到同一套 ESCO 技能，才能互相比對。每一項對應都保留原文證據。'),
      (!o.ready.esco || !o.ready.hub || !o.ready.courses) && notReady('部分 Agent'),
      h('div', {class: 'grid4'},
        agent('競賽 Agent', '爬取最新比賽 → 參賽條件＋技能需求', c.competitions, '筆比賽', `${c.competitionsOpen} 筆尚未截止・需求 ${c.competitionSkills} 項技能`, 'hubCompetitions', '看比賽'),
        agent('教師 Agent', '教師 profile → 專長技能', c.advisorsMapped, '位教師', `資料庫共 ${c.advisors} 位・涵蓋 ${num(c.advisorSkills)} 項技能`, 'hubAdvisors', '看教師'),
        agent('課程 Agent', '課綱 → 課程教授的技能', c.coursesMapped, '門課', `課綱庫 ${num(c.courses)} 門・已分析 ${num(c.coursesAnalyzed)} 門・${num(c.courseSkills)} 項技能`, 'hubCourses', '看課程'),
        agent('學生能力分析', '修課紀錄 → 對應到的技能 → 參賽缺口', hub.demo.length, '份示範成績單', '也可以自己搜尋課程加入修課清單', 'hubMatch', '開始配對')),
      card(null,
        h('div', {class: 'hubbar'}, h('b', null, '共用技能標準：ESCO'), `${num(c.escoSkills)} 項技能・${num(c.escoRelations)} 組上下位與相關關聯・另補 ${num(c.similarPairs)} 組語意相近配對`),
        h('h3', null, `比賽需要的 ${o.bridge.competitionSkills} 項技能，校內找得到對應嗎？`),
        h('div', {class: 'parts'}, bridgeRow('有課程在教', o.bridge.taughtByCourses), bridgeRow('有教師具備', o.bridge.coveredByAdvisors)),
        h('p', {class: 'mu small'}, '這裡只算「完全相同的 ESCO 技能」；配對時還會把 ESCO 的上下位、相關技能，以及語意相近的技能算作「相近」。')),
      h('div', {class: 'grid3'}, top('比賽最常需要', o.topSkills.competition, '比賽數'), top('最多教師具備', o.topSkills.advisor, '教師數'), top('最多課程教授', o.topSkills.course, '課程數')),
      h('p', {class: 'mu small'}, `${o.namesMasked ? '教師姓名已遮蔽。' : ''}技能對應由模型提出、經原文檢核後保存；結果是文字證據，不是能力評分。技能的中文名稱是模型翻譯、只供閱讀，比對以 ESCO 技能編號為準。`),
    ];
  }

  // ---------- 比賽 ----------
  const daysLeft = deadline => Math.round((new Date(`${deadline}T00:00:00`) - new Date(`${hub.overview.today}T00:00:00`)) / MS_PER_DAY);
  function deadlineChip(c) {
    if (!c.deadline) return chip('截止日未載明');
    const days = daysLeft(c.deadline);
    return days < 0 ? chip(`已截止 ${c.deadline}`, 'r') : chip(`${c.deadline} 截止・剩 ${days} 天`, days <= 14 ? 'a' : 'g');
  }

  const openDetail = guard(async id => {
    hub.detail = await api('GET', `/api/hub/competitions/${id}`);
    ctx.render();
    document.querySelector('#hub-detail')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  });

  const crawl = url => runJob(() => api('POST', '/api/hub/competitions/crawl', url ? {url} : {}), async () => {
    hub.f.crawlUrl = '';
    await Promise.all([loadCompetitions(), api('GET', '/api/hub/overview').then(d => { hub.overview = d; })]);
  });

  function conditionsBlock(c) {
    // 分析沒有完成時，空白不代表簡章沒寫，不能顯示成「簡章未載明」
    if (UNFINISHED.has(c.status)) return [h('p', {class: 'mu'}, chip('分析未完成', 'a'), ' 模型這次沒有產生可用的結果，條件尚未抽取；可以重新分析這個比賽。')];
    const e = c.eligibility ?? {};
    const team = e.team_min || e.team_max ? `${e.team_min ?? '?'}–${e.team_max ?? '?'} 人` : '簡章未載明';
    return [
      h('dl', {class: 'kv'},
        h('dt', null, '學生身分'), h('dd', null, yesNo(e.student_required, '限學生', '不限學生')),
        h('dt', null, '學歷'), h('dd', null, e.education_levels?.join('、') ?? '簡章未載明'),
        h('dt', null, '隊伍人數'), h('dd', null, team),
        h('dt', null, '指導老師'), h('dd', null, yesNo(e.requires_advisor, '必須有', '不需要'))),
      c.conditions.length > 0 && h('div', null, h('h3', null, '報名前要知道的條件'),
        c.conditions.map(x => h('div', {class: 'quote'}, h('b', null, x.text), h('div', null, `簡章原文：「${x.evidence}」`)))),
    ];
  }

  function detailCard(c) {
    const safeUrl = /^https:\/\//.test(c.sourceUrl) ? c.sourceUrl : null;
    return card({id: 'hub-detail', class: 'ok'},
      h('div', {class: 'ch'}, h('h2', null, c.name), h('div', {class: 'row'}, chip(c.category ?? '其他', 'o'), deadlineChip(c))),
      h('p', {class: 'mu'}, c.summary), h('p', {class: 'small mu'}, `主辦：${c.organizer ?? '未載明'}｜來源：${c.sourceSite}｜`, safeUrl ? h('a', {href: safeUrl, target: '_blank', rel: 'noopener noreferrer'}, '開啟原始頁面') : '—'),
      h('div', {class: 'grid2'},
        h('div', null, h('h3', null, '需要什麼條件'), conditionsBlock(c)),
        h('div', null, h('h3', null, `需要什麼技能（${c.skills.length} 項 ESCO 技能）`),
          c.skills.length ? c.skills.map(s => h('div', {class: 'quote'}, skillName(s), h('div', null, `簡章原文：「${s.evidence}」`)))
            : h('p', {class: 'mu'}, '簡章中找不到可對應的技能。'))),
      h('div', {class: 'row', style: {marginTop: '12px'}},
        h('button', {class: 'btn', type: 'button', disabled: !c.skills.length, onclick: () => { hub.f.competitionId = c.id; hub.match = null; ctx.go('hubMatch'); }}, '用這個比賽做參賽配對'),
        h('span', {class: 'mu small'}, `條件與技能由模型從簡章抽取，每一項都核對過原文；簡章沒寫的不會被當成符合。分析時間 ${String(c.analyzedAt).slice(0, 10)}`)));
  }

  function competitionsPage() {
    if (!hub.overview) return [h('p', {class: 'mu'}, '載入中…')];
    const categories = [...new Set(hub.competitions.map(c => c.category ?? '其他'))].sort();
    const shown = hub.competitions.filter(c => (!hub.f.openOnly || c.open) && (!hub.f.collegeOnly || c.collegeEligible)
      && (!hub.f.category || (c.category ?? '其他') === hub.f.category));
    const busy = hub.job?.status === 'running';
    return [
      h('h1', null, '比賽雷達'),
      h('p', {class: 'lead'}, '競賽 Agent 爬取公開的比賽資訊（遵守網站的 robots.txt、每秒最多一頁），再從簡章判斷「需要什麼條件」與「需要什麼技能」。'),
      !hub.overview.ready.hub && notReady('競賽 Agent'),
      card(null,
        h('div', {class: 'row'},
          h('button', {class: 'btn', type: 'button', disabled: busy || !hub.overview.jobsEnabled, onclick: () => crawl('')}, '爬取最新比賽'),
          h('input', {type: 'text', id: 'crawl-url', 'aria-label': '比賽頁網址', placeholder: '或貼上官方比賽頁網址（https://…）', maxlength: 290, value: hub.f.crawlUrl,
            style: {flex: '1', minWidth: '240px'}, oninput: e => { hub.f.crawlUrl = e.target.value; }}),
          h('button', {class: 'btn ghost', type: 'button', disabled: busy || !hub.overview.jobsEnabled, onclick: () => {
            const url = hub.f.crawlUrl.trim();
            if (!/^https:\/\/\S+$/.test(url)) { toast('請貼上 https:// 開頭的網址', true); return; }
            crawl(url);
          }}, '分析這個網址')),
        !hub.overview.jobsEnabled && h('p', {class: 'mu small'}, '這台伺服器沒有開放即時分析。')),
      jobBanner(),
      hub.detail && detailCard(hub.detail),
      card(null,
        h('div', {class: 'ch'}, h('h2', null, `${shown.length} 筆比賽`),
          h('div', {class: 'row'},
            h('label', {class: 'check'}, h('input', {type: 'checkbox', checked: hub.f.openOnly, onchange: e => { hub.f.openOnly = e.target.checked; ctx.render(); }}), '只看尚未截止'),
            h('label', {class: 'check'}, h('input', {type: 'checkbox', checked: hub.f.collegeOnly, onchange: e => { hub.f.collegeOnly = e.target.checked; ctx.render(); }}), '排除限中小學的比賽'),
            h('select', {'aria-label': '類別', style: {width: 'auto'}, onchange: e => { hub.f.category = e.target.value; ctx.render(); }},
              h('option', {value: ''}, '全部類別'), categories.map(x => h('option', {value: x, selected: hub.f.category === x}, x))))),
        shown.length ? h('div', {class: 'grid2'}, shown.map(c => h('div', {class: `cand${hub.detail?.id === c.id ? ' sel' : ''}`},
          h('div', {class: 'nm'}, c.name),
          h('div', {class: 'row', style: {margin: '4px 0'}}, chip(c.category ?? '其他', 'o'), deadlineChip(c), UNFINISHED.has(c.status) && chip('分析未完成', 'a')),
          h('div', {class: 'mu small'}, c.summary || '—'),
          c.skills.length ? skillChips(c.skills.slice(0, 6)) : h('div', {class: 'mu small'}, '沒有可對應的技能'),
          h('button', {class: 'btn ghost sm', type: 'button', style: {marginTop: '8px'}, onclick: () => openDetail(c.id)}, `條件與 ${c.skillCount} 項技能`))))
          : h('p', {class: 'mu'}, '沒有符合的比賽。按「爬取最新比賽」讓競賽 Agent 去抓。')),
    ];
  }

  // ---------- 教師 ----------
  const searchAdvisors = guard(async page => {
    hub.f.advisorPage = page;
    await loadAdvisors();
    ctx.render();
  });

  function advisorsPage() {
    const data = hub.advisors;
    if (!data || !hub.overview) return [h('p', {class: 'mu'}, '載入中…')];
    return [
      h('h1', null, '教師技能'),
      h('p', {class: 'lead'}, '教師 Agent 讀取系所公開的教師資料（專長、論文與計畫標題），對應到 ESCO 技能。送給模型的資料不含姓名與學經歷。'),
      !hub.overview.ready.hub && notReady('教師 Agent'),
      card(null, h('div', {class: 'row'},
        h('input', {type: 'text', 'aria-label': '搜尋', placeholder: `搜尋系所、專長或 ESCO 技能（例如 machine learning）${hub.overview.namesMasked ? '' : '、姓名'}`, maxlength: 60, value: hub.f.advisorQ,
          style: {flex: '1', minWidth: '220px'}, oninput: e => { hub.f.advisorQ = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') searchAdvisors(1); }}),
        h('select', {'aria-label': '學院', style: {width: 'auto'}, onchange: e => { hub.f.advisorCollege = e.target.value; searchAdvisors(1); }},
          h('option', {value: ''}, '全部學院'), data.colleges.map(x => h('option', {value: x, selected: hub.f.advisorCollege === x}, x))),
        h('button', {class: 'btn', type: 'button', onclick: () => searchAdvisors(1)}, '搜尋'))),
      data.items.length ? h('div', {class: 'grid2'}, data.items.map(a => h('div', {class: 'cand'},
        h('div', {class: 'nm'}, a.name, h('span', {class: 'mu small'}, `　${a.department ?? a.college ?? ''}`)),
        a.expertise.length > 0 && h('div', {class: 'mu small'}, `自述專長：${a.expertise.slice(0, 6).join('、')}`),
        a.skills.length ? [skillChips(a.skills), evidenceList(a.skills)] : h('div', {class: 'mu small'}, a.status === 'unmapped' ? '公開資料不足，沒有可對應的技能' : '尚未完成分析'))))
        : card(null, h('p', {class: 'mu'}, '沒有符合的教師。')),
      pager(data, searchAdvisors),
    ];
  }

  // ---------- 課程 ----------
  const searchCourseSkills = guard(async page => {
    hub.f.coursePage = page;
    await loadCourses();
    ctx.render();
  });

  function coursesPage() {
    const data = hub.courses;
    if (!data || !hub.overview) return [h('p', {class: 'mu'}, '載入中…')];
    return [
      h('h1', null, '課程技能'),
      h('p', {class: 'lead'}, '課程 Agent 讀取課綱的課程描述、學習目標與每週進度，對應到 ESCO 技能。這是「課綱寫了會教」的證據，不代表修過就熟練。'),
      !hub.overview.ready.courses && notReady('課程 Agent'),
      card(null, h('div', {class: 'row'},
        h('input', {type: 'text', 'aria-label': '搜尋', placeholder: '搜尋課名或 ESCO 技能（例如 資料庫、data analysis）', maxlength: 60, value: hub.f.courseQ,
          style: {flex: '1', minWidth: '220px'}, oninput: e => { hub.f.courseQ = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') searchCourseSkills(1); }}),
        h('button', {class: 'btn', type: 'button', onclick: () => searchCourseSkills(1)}, '搜尋'))),
      card(null, data.items.length ? table(['學期', '選課代碼', '課程', '對應到的 ESCO 技能'], data.items.map(c => h('tr', null,
        h('td', null, `${c.year}-${c.semester}`), h('td', null, h('code', null, c.code)), h('td', null, h('b', null, c.name)),
        h('td', null, skillChips(c.skills), evidenceList(c.skills))))) : h('p', {class: 'mu'}, '沒有符合的課程。')),
      pager(data, searchCourseSkills),
    ];
  }

  // ---------- 參賽配對 ----------
  const refreshStudent = guard(async () => {
    hub.student = enrollments().length ? await api('POST', '/api/hub/student/skills', {enrollments: enrollments()}) : null;
    ctx.render();
  });

  const searchToAdd = guard(async () => {
    const q = hub.f.search.trim();
    if (q.length < 2) { toast('請輸入至少 2 個字的課名', true); return; }
    hub.f.results = await api('GET', `/api/hub/courses/search?${query({q})}`);
    if (!hub.f.results.length) toast('課程庫裡找不到這個課名');
    ctx.render();
  });

  function addCourse(course) {
    const item = {academic_year: course.year, semester: course.semester, course_code: course.code, course_name: course.name};
    if (enrollments().some(e => enrollmentKey(e) === enrollmentKey(item))) { toast('這門課已經在清單裡'); return; }
    if (enrollments().length >= MAX_ENROLLMENTS) { toast(`最多 ${MAX_ENROLLMENTS} 門課`, true); return; }
    setEnrollments([...enrollments(), item]);
    refreshStudent();
  }

  const analyzePending = () => runJob(() => api('POST', '/api/hub/student/analyze', {enrollments: enrollments()}), async () => {
    hub.student = await api('POST', '/api/hub/student/skills', {enrollments: enrollments()});
  });

  const runMatch = guard(async () => {
    hub.match = await api('POST', '/api/hub/match', {competitionId: hub.f.competitionId, enrollments: enrollments()});
    ctx.showHubTrace(hub.match.trace);
    ctx.render();
    document.querySelector('#hub-result')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  });

  function enrollmentCard() {
    const byKey = new Map((hub.student?.courses ?? []).map(c => [`${c.academicYear}-${c.semester}-${c.courseCode}`, c]));
    const busy = hub.job?.status === 'running';
    return card(null,
      h('div', {class: 'ch'}, h('h2', null, '① 我的修課'),
        h('div', {class: 'row'}, hub.demo.map(d => h('button', {class: 'chip', type: 'button', onclick: () => { setEnrollments(d.enrollments); refreshStudent(); }}, d.label)),
          enrollments().length > 0 && h('button', {class: 'btn ghost sm', type: 'button', onclick: () => { setEnrollments([]); ctx.render(); }}, '清空'))),
      h('p', {class: 'mu small'}, '點選示範成績單（課程是真實開課資料，學生是合成的），或搜尋課名自己加入。只需要課程，不需要成績；清單只存在這台瀏覽器。'),
      h('div', {class: 'row'},
        h('input', {type: 'text', 'aria-label': '搜尋課名', placeholder: '搜尋課名加入，例如 機器學習', maxlength: 40, value: hub.f.search, style: {flex: '1', minWidth: '200px'},
          oninput: e => { hub.f.search = e.target.value; }, onkeydown: e => { if (e.key === 'Enter') searchToAdd(); }}),
        h('button', {class: 'btn ghost', type: 'button', onclick: searchToAdd}, '搜尋課程')),
      hub.f.results.length > 0 && h('div', {class: 'chips', style: {marginTop: '8px'}}, hub.f.results.map(c =>
        h('button', {class: 'chip', type: 'button', onclick: () => addCourse(c)}, `＋ ${c.year}-${c.semester} ${c.name}（${c.code}）`))),
      enrollments().length ? table(['學期', '課程', '課綱分析', '技能數', ''], enrollments().map(e => {
        const info = byKey.get(enrollmentKey(e));
        const matched = info?.status === 'matched';
        return h('tr', null, h('td', null, `${e.academic_year}-${e.semester}`), h('td', null, e.course_name, h('span', {class: 'mu small'}, ` ${e.course_code}`)),
          h('td', null, !info ? '—' : matched ? chip(...(ANALYSIS[info.analysis] ?? [info.analysis, ''])) : chip(COURSE_STATUS[info.status] ?? info.status, 'r')),
          h('td', null, matched ? info.skillCount : '—'),
          h('td', null, h('button', {class: 'btn ghost sm', type: 'button', onclick: () => { setEnrollments(enrollments().filter(x => x !== e)); refreshStudent(); }}, '移除')));
      })) : h('p', {class: 'mu'}, '清單是空的。'),
      hub.student?.pending > 0 && h('div', {class: 'row', style: {marginTop: '10px'}},
        h('button', {class: 'btn', type: 'button', disabled: busy || !hub.overview.jobsEnabled, onclick: analyzePending}, `請課程 Agent 分析尚未處理的 ${hub.student.pending} 門課`),
        h('span', {class: 'mu small'}, '會把這幾門課的課綱送給模型（不含成績）。')),
      hub.student?.skills.length > 0 && h('div', {style: {marginTop: '12px'}},
        h('h3', null, `修課對應到 ${hub.student.skills.length} 項 ESCO 技能`),
        skillChips(hub.student.skills.map(s => ({...s, label: s.sources.length > 1 ? `${s.label} ×${s.sources.length}` : s.label})), 'g'),
        h('details', null, h('summary', null, '每項技能來自哪門課、課綱哪一句'),
          hub.student.skills.map(s => h('div', {class: 'quote'}, skillName(s), s.sources.map(x => h('div', null, `${x.courseName}：「${x.evidence}」`)))))));
  }

  function matchResult(m) {
    const cov = m.coverage;
    return [
      card({id: 'hub-result', class: cov.none === 0 ? 'ok' : ''},
        h('div', {class: 'ch'}, h('h2', null, `③ 配對結果：${m.competition.name}`), h('div', {class: 'row'}, chip(m.competition.category ?? '其他', 'o'), deadlineChip(m.competition))),
        h('div', {class: 'cover'},
          h('div', null, h('div', {class: 'score'}, cov.percent === null ? '—' : `${cov.percent}%`), h('div', {class: 'mu small'}, '技能涵蓋率')),
          h('div', {class: 'row'}, chip(`具備 ${cov.exact}`, 'g'), chip(`相近 ${cov.related}`, 'a'), chip(`缺口 ${cov.none}`, 'r')),
          h('div', {class: 'mu small'}, '相同的 ESCO 技能算具備；上下位、相關或語意相近的技能算相近（折半計算）。')),
        table(['比賽需要的技能', '狀態', '依據'], m.required.map(r => h('tr', null,
          h('td', null, skillName(r), h('div', {class: 'mu small'}, `簡章：「${r.evidence}」`)),
          h('td', null, chip(...LEVEL[r.level])),
          h('td', {class: 'small'}, r.level === 'none' ? h('span', {class: 'mu'}, '修課中沒有對應的技能')
            : [r.via && h('div', null, `${r.relationNote}：${r.via.label}`), r.sources.map(s => h('div', {class: 'quote'}, `${s.courseName}：「${s.evidence}」`))])))),
        (m.student.pending > 0 || m.student.unresolved > 0) && h('p', {class: 'mu small'},
          `注意：${m.student.pending} 門課尚未分析、${m.student.unresolved} 門課在課程庫找不到，這些課的技能沒有算進來。`)),
      card(null, h('h2', null, '參賽條件（請自行確認）'),
        m.competition.conditions.length || Object.values(m.competition.eligibility ?? {}).some(x => x !== null) ? conditionsBlock(m.competition) : h('p', {class: 'mu'}, '簡章中沒有抽取到明確的條件。')),
      card(null, h('h2', null, `可以補上缺口的課程（${m.courses.length}）`),
        m.courses.length ? h('div', {class: 'grid2'}, m.courses.map(c => h('div', {class: 'cand'},
          h('div', {class: 'nm'}, c.name), h('div', {class: 'mu small'}, `${c.year}-${c.semester}｜選課代碼 ${c.code}`),
          h('div', {class: 'chips', style: {margin: '6px 0'}}, c.covers.map(x => chip(`補 ${x.label}${x.level === 'related' ? '（相近）' : ''}`, x.level === 'exact' ? 'g' : 'a'))),
          h('details', null, h('summary', null, '課綱依據'), c.covers.map(x => h('div', {class: 'quote'}, h('b', null, x.taught), `：「${x.evidence}」`))))))
          : h('p', {class: 'mu'}, cov.none + cov.related === 0 ? '沒有缺口，不需要補課。' : '已分析的課程裡沒有對應這些缺口的課。')),
      card(null, h('h2', null, `專長相符的教師（${m.advisors.length}）`),
        m.advisors.length ? h('div', {class: 'grid2'}, m.advisors.map(a => h('div', {class: 'cand'},
          h('div', {class: 'ch'}, h('div', null, h('div', {class: 'nm'}, a.name), h('div', {class: 'mu small'}, a.department ?? a.college ?? '')),
            h('div', {class: 'score'}, a.score, h('small', null, ' /100'))),
          h('div', {class: 'parts'}, h('span', null, '比賽技能涵蓋'), bar(a.requiredCoverage, 100), h('span', null, `${a.requiredCoverage}%`),
            a.gapCoverage !== null && [h('span', null, '你的缺口涵蓋'), bar(a.gapCoverage, 100), h('span', null, `${a.gapCoverage}%`)]),
          h('div', {class: 'chips', style: {margin: '6px 0'}}, a.matches.map(x => chip(`${x.label}${x.level === 'related' ? '（相近）' : ''}`, x.level === 'exact' ? 'g' : 'a'))),
          h('details', null, h('summary', null, '教師資料依據'), a.matches.map(x => h('div', {class: 'quote'}, h('b', null, x.has), `：「${x.evidence}」`))))))
          : h('p', {class: 'mu'}, '教師資料中沒有對應這些技能的專長。')),
      card(null, h('h3', null, '怎麼解讀'), h('ul', null, m.notes.map(n => h('li', null, n)))),
    ];
  }

  function matchPage() {
    if (!hub.overview) return [h('p', {class: 'mu'}, '載入中…')];
    // 下拉選單只列大專生可參加的比賽；從「比賽雷達」指定過來的那一筆例外
    const options = hub.competitions.filter(c => c.skillCount > 0 && (c.collegeEligible || c.id === hub.f.competitionId));
    if (!options.some(c => c.id === hub.f.competitionId)) hub.f.competitionId = options.find(c => c.open)?.id ?? options[0]?.id ?? '';
    const ready = enrollments().length > 0 && hub.f.competitionId;
    return [
      h('h1', null, '參賽配對'),
      h('p', {class: 'lead'}, '把四邊串起來：你修過的課對應到哪些技能 → 比賽需要哪些 → 差在哪 → 哪些課能補、哪些老師的專長相符。分數由固定規則計算，不是模型給的。'),
      jobBanner(),
      enrollmentCard(),
      card(null, h('h2', null, '② 選擇比賽'),
        options.length ? h('div', {class: 'row'},
          h('select', {'aria-label': '比賽', style: {flex: '1', minWidth: '260px'}, onchange: e => { hub.f.competitionId = e.target.value; hub.match = null; ctx.render(); }},
            options.map(c => h('option', {value: c.id, selected: hub.f.competitionId === c.id}, `${c.open ? '' : '（已截止）'}${c.name}｜${c.category ?? '其他'}｜${c.skillCount} 項技能`))),
          h('button', {class: 'btn', type: 'button', disabled: !ready, onclick: runMatch}, '開始配對'))
          : h('p', {class: 'mu'}, '還沒有比賽資料。請先到「比賽雷達」爬取。'),
        !enrollments().length && h('p', {class: 'mu small'}, '請先在上面加入修課。')),
      hub.match && matchResult(hub.match),
    ];
  }

  const views = {hub: overviewPage, hubCompetitions: competitionsPage, hubAdvisors: advisorsPage, hubCourses: coursesPage, hubMatch: matchPage};
  /** 進入參賽配對頁時，清單已有課程就先算出修課技能。 */
  async function afterLoad(view) {
    if (view === 'hubMatch' && enrollments().length && !hub.student) {
      hub.student = await api('POST', '/api/hub/student/skills', {enrollments: enrollments()});
    }
  }
  /** 由其他頁面指定要配對的比賽（例如助理頁的「用我的真實修課比對這場比賽」）。 */
  const select = id => { if (id) { hub.f.competitionId = id; hub.match = null; } };
  return {views, select, owns: view => Object.hasOwn(views, view), load: async view => { await load(view); await afterLoad(view); }};
}
