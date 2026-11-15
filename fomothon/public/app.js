// 前端外殼：登入、導覽、頁面切換與「Agent 執行紀錄」面板。
import {createAssistant} from './assistant.js';
import {createHubPages} from './hub.js';
import {createPages} from './pages.js';
import {$, api, guard, h, toast} from './ui.js';

// 技能串接：競賽、教師、課程三個 Agent 的真實資料分析結果（key 為 null 的項目是分隔標題）
const HUB_NAV = [[null, '技能串接'], ['hub', '串接總覽'], ['hubMatch', '參賽配對'], ['hubCompetitions', '比賽雷達'], ['hubAdvisors', '教師技能'], ['hubCourses', '課程技能']];
const NAV = {
  student: [['assistant', '助理'], ['profile', '能力檔案'], ['invitations', '邀請'], ...HUB_NAV, [null, '平台'], ['skills', '技能指標庫'], ['eval', '評測']],
  teacher: [['invitations', '邀請'], ['profile', '我的專長'], ...HUB_NAV, [null, '平台'], ['skills', '技能指標庫'], ['eval', '評測']],
  admin: [['adminEvidence', '證據驗證'], ['adminRuns', '任務紀錄'], ['adminAudit', '稽核紀錄'], ...HUB_NAV, [null, '平台'], ['skills', '技能指標庫'], ['eval', '評測']],
};
const ROLE_LABEL = {student: '學生', teacher: '教師', admin: '管理者'};
const EVENT_CLASS = {
  tool_call: 'tool', tool_result: 'tool', llm_call: 'tool', retry: 'warn', fallback: 'warn', gate: 'warn', replan: 'warn', output_check: 'warn',
  stop: 'err', error: 'err', tool_error: 'err', guard_block: 'err', user_confirm: 'user', user_cancel: 'user', await_user: 'user',
  invite_sent: 'user', invite_accepted: 'user', invite_declined: 'user',
};

const state = {
  meta: null, me: null, view: null, run: null, traceRunId: null, lastSeq: 0,
  skills: [], courses: [], profile: null, invitations: [], evalLatest: null, adminEvidence: [], adminAudit: [], adminRuns: [],
};

// ---------- 執行紀錄面板 ----------
function resetTrace() {
  state.lastSeq = 0;
  state.traceRunId = null;
  $('#logs').replaceChildren(h('div', {class: 'empty'}, '等待任務開始…'));
  $('#ev-count').textContent = '0 筆';
  $('#metrics').replaceChildren();
  $('#btn-export').disabled = true;
}

function renderMetrics(m) {
  const cell = (label, value) => h('div', null, h('b', null, value), label);
  $('#metrics').replaceChildren(
    cell('決策步數', m.steps), cell('工具調用', m.toolCalls), cell('重試／退回', `${m.retries}／${m.fallbacks}`), cell('人工確認', m.humanInterventions),
    cell('工具成功率', m.toolSuccessRate === null ? '—' : `${Math.round(m.toolSuccessRate * 100)}%`), cell('重新規劃', m.replans), cell('LLM 呼叫', m.llmCalls), cell('執行耗時', `${m.activeMs} ms`));
}

const eventNode = ev => h('div', {class: `ev ${EVENT_CLASS[ev.type] ?? 'ok'}`},
  h('span', {class: 'ts'}, ev.ts.slice(11, 19)), h('span', {class: 'k'}, ev.type), h('span', {class: 'd'}, ev.summary),
  ev.ms !== null && ev.ms !== undefined && h('span', {class: 'ms'}, `${ev.ms} ms`),
  ev.data && h('details', null, h('summary', null, '詳細資料'), h('pre', null, JSON.stringify(ev.data, null, 1))));

/** 技能串接頁的執行紀錄：各 Agent 的結果如何被串起來（不屬於協調器任務，所以不能匯出 Trace）。 */
function showHubTrace(events) {
  resetTrace();
  const ts = new Date().toISOString();
  $('#logs').replaceChildren(...events.map(ev => eventNode({...ev, ts})));
  $('#ev-count').textContent = `${events.length} 筆`;
}

function appendEvents({id, events, metrics}) {
  const box = $('#logs');
  if (state.traceRunId !== id) {
    box.replaceChildren();
    state.traceRunId = id;
    state.lastSeq = 0;
  }
  for (const ev of events.filter(e => e.seq > state.lastSeq)) {
    box.append(eventNode(ev));
    state.lastSeq = ev.seq;
  }
  box.scrollTop = box.scrollHeight;
  $('#ev-count').textContent = `${state.lastSeq} 筆`;
  $('#btn-export').disabled = false;
  if (metrics) renderMetrics(metrics);
}

const exportTrace = guard(async () => {
  const data = await api('GET', `/api/agent/${state.traceRunId}/evidence`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const a = h('a', {href: url, download: `fomothon_trace_${data.runId}.json`});
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

const showTrace = guard(async runId => {
  const data = await api('GET', `/api/agent/${runId}/evidence`);
  resetTrace();
  appendEvents({id: data.runId, events: data.events, metrics: data.metrics});
});

// ---------- 頁面 ----------
const ctx = {state, render, appendEvents, resetTrace, showTrace, showHubTrace, go: view => go(view), reload: () => loadView(state.view),
  /** 從助理跳到「參賽配對」；有指定比賽時先選好。 */
  openHubMatch: id => { hubPages.select(id); go('hubMatch'); }};
const assistant = createAssistant(ctx);
const pages = createPages(ctx);
const hubPages = createHubPages(ctx);
const VIEWS = {assistant: assistant.view, ...pages, ...hubPages.views};

function render() {
  const pendingIncoming = state.invitations.filter(i => i.direction === 'incoming' && i.status === 'sent').length;
  $('#nav').replaceChildren(
    ...NAV[state.me.role].map(([key, label]) => (key === null ? h('div', {class: 'nav-sep'}, label)
      : h('button', {class: `nav${state.view === key ? ' on' : ''}`, type: 'button', 'aria-current': state.view === key ? 'page' : null, onclick: () => go(key)},
        label, key === 'invitations' && pendingIncoming > 0 && h('span', {class: 'n'}, pendingIncoming)))),
    h('div', {class: 'demo-tag'}, `示意資料・系統日期 ${state.meta.today}`, h('br'), `等級規則 ${state.meta.rulesVersion}`));
  $('#main').replaceChildren(...[VIEWS[state.view]()].flat(Infinity).filter(Boolean));
}

/** 進入頁面前載入該頁需要的資料（彼此獨立的請求平行送出）。 */
async function loadView(view) {
  const jobs = [api('GET', '/api/invitations').then(d => { state.invitations = d; })];
  if (view === 'profile') jobs.push(api('GET', '/api/profile').then(d => { state.profile = d; }), api('GET', '/api/courses').then(d => { state.courses = d; }));
  if (view === 'eval') jobs.push(api('GET', '/api/eval/latest').then(d => { state.evalLatest = d; }));
  if (view === 'adminEvidence') jobs.push(api('GET', '/api/admin/evidence').then(d => { state.adminEvidence = d; }));
  if (view === 'adminAudit') jobs.push(api('GET', '/api/admin/audit').then(d => { state.adminAudit = d; }));
  if (view === 'adminRuns') jobs.push(api('GET', '/api/agent/runs').then(d => { state.adminRuns = d; }));
  if (hubPages.owns(view)) jobs.push(hubPages.load(view));
  await Promise.all(jobs);
  render();
}

const go = guard(async view => {
  state.view = view;
  history.replaceState(null, '', `#${view}`);
  await loadView(view);
  $('#main').scrollTop = 0;
  $('#main').focus();
});

// ---------- 登入 ----------
async function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const personas = await api('GET', '/api/personas');
  let accessCode = '';
  $('#login-code').replaceChildren(...(state.meta.accessCodeRequired
    ? [h('label', {for: 'code'}, '存取碼（由主辦單位或團隊提供）'), h('input', {id: 'code', type: 'password', autocomplete: 'off', oninput: e => { accessCode = e.target.value; }})] : []));
  const login = guard(async id => {
    $('#login-err').textContent = '';
    try {
      state.me = await api('POST', '/api/login', {userId: id, accessCode: accessCode || undefined});
    } catch (err) {
      $('#login-err').textContent = err.message;
      return;
    }
    await enter(true);
  });
  const group = role => [h('h3', null, ROLE_LABEL[role]), h('div', {class: 'plist'}, personas.filter(p => p.role === role)
    .map(p => h('button', {class: 'pbtn', type: 'button', onclick: () => login(p.id)}, h('b', null, p.name), h('span', null, `${p.dept ?? ''}${p.hint ? `｜${p.hint}` : ''}`))))];
  $('#login-list').replaceChildren(...['student', 'teacher', 'admin'].flatMap(group));
}

/** @param {boolean} fromLogin 剛登入時一律進入該角色的首頁，不沿用網址上的頁面 */
async function enter(fromLogin = false) {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = `${state.me.name}（${ROLE_LABEL[state.me.role]}）`;
  const badge = $('#brain-badge');
  badge.textContent = state.meta.brain === 'llm' ? `LLM＋規則備援｜${state.meta.model}` : '離線規則模式';
  badge.className = `badge${state.meta.brain === 'llm' ? ' llm' : ''}`;
  state.run = null;
  resetTrace();
  state.skills = await api('GET', '/api/skills');
  const wanted = fromLogin ? '' : location.hash.slice(1);
  await go(NAV[state.me.role].some(([key]) => key === wanted) ? wanted : NAV[state.me.role][0][0]);
}

async function boot() {
  state.meta = await api('GET', '/api/meta');
  $('#btn-export').addEventListener('click', exportTrace);
  $('#btn-logout').addEventListener('click', guard(async () => {
    await api('POST', '/api/logout', {});
    state.me = null;
    await showLogin();
  }));
  state.me = await api('GET', '/api/me');
  if (state.me) await enter();
  else await showLogin();
}

boot().catch(() => toast('系統載入失敗，請重新整理頁面', true));
