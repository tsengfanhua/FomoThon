// 其餘頁面：能力檔案、邀請、技能指標庫、評測、管理者（證據驗證／稽核／任務紀錄）。
import {api, card, chip, guard, h, levelChip, statusChip, toast} from './ui.js';

const EVIDENCE_TYPE = {course: '修課', certificate: '證照', portfolio: '作品集', competition: '競賽'};
const INVITE_STATUS = {sent: ['等待回覆', 'a'], accepted: ['已同意', 'g'], declined: ['已婉拒', 'r'], cancelled: ['已取消', '']};
const table = (heads, rows) => h('table', null, h('thead', null, h('tr', null, heads.map(t => h('th', null, t)))), h('tbody', null, rows));

/** @param {{state:object, render:Function, reload:Function}} ctx */
export function createPages(ctx) {
  const {state} = ctx;
  const form = {evType: 'portfolio', evTitle: '', evSkills: new Set(), examKind: 'toeic', examScore: '', examLevel: '中級', enCode: '', enName: '', enGrade: '', enSem: ''};

  // ---------- 能力檔案（學生） ----------
  const addEvidence = guard(async () => {
    const needsExam = form.evSkills.has('SK-LNG-001');
    const exam = needsExam ? (form.examKind === 'toeic' ? {kind: 'toeic', score: Number(form.examScore)} : {kind: 'gept', level: form.examLevel}) : undefined;
    await api('POST', '/api/profile/evidence', {type: form.evType, title: form.evTitle, skillIds: [...form.evSkills], exam});
    form.evTitle = '';
    form.evSkills = new Set();
    toast('已新增為「自述」證據，經管理者驗證後才會成為已驗證');
    await ctx.reload();
  });
  const addEnrollment = guard(async () => {
    const grade = form.enGrade.trim() === '' ? NaN : Number(form.enGrade);
    if (!Number.isInteger(grade) || grade < 0 || grade > 100) {
      toast('請填寫 0–100 的整數成績', true);
      return;
    }
    await api('POST', '/api/profile/enrollments', {code: form.enCode || undefined, name: form.enCode ? undefined : form.enName || undefined, grade, semester: form.enSem || undefined});
    form.enCode = ''; form.enName = ''; form.enGrade = '';
    toast('已新增修課紀錄；到「助理」輸入「幫我盤點能力」即可重新盤點');
    await ctx.reload();
  });

  const removeEnrollment = id => guard(async () => {
    await api('POST', `/api/profile/enrollments/${id}/delete`, {});
    toast('已刪除這筆自填的修課紀錄');
    await ctx.reload();
  })();

  function evidenceLine(e) {
    const d = e.detail ?? {};
    return h('div', {class: 'quote'},
      h('b', null, EVIDENCE_TYPE[e.type] ?? e.type), `｜${e.title} `, statusChip(e.status), e.level && [' ', levelChip(e.level)], e.isBasis && [' ', chip('採計依據', 'o')],
      d.mode === 'syllabus' && h('div', null, `課綱涵蓋度 ${Math.round(d.coverage * 100)}%・實作比重 ${Math.round(d.practiceShare * 100)}%・${d.semester ?? ''}`),
      d.note && h('div', null, d.note),
      (d.quotes ?? []).map(q => h('div', null, `${q.where}：${q.text}`)),
      e.sourceRef && h('div', null, '來源：', e.sourceRef));
  }

  function studentProfile(data) {
    const p = data.profile;
    const skillOptions = state.skills.map(s => h('label', {class: 'check'},
      h('input', {type: 'checkbox', checked: form.evSkills.has(s.id), onchange: e => {
        if (e.target.checked && form.evSkills.size >= 5) { e.target.checked = false; toast('每筆證據最多對應 5 個技能', true); return; }
        if (e.target.checked) form.evSkills.add(s.id); else form.evSkills.delete(s.id);
        ctx.render();
      }}), s.zh));
    return [
      h('h1', null, '我的能力檔案'),
      h('p', {class: 'lead'}, '每項技能都由證據支持。同一技能有多筆證據時保留全部、取最高一筆，不疊加分數；自述證據會標示「待驗證」且等級有上限。'),
      card(null,
        h('div', {class: 'ch'}, h('h2', null, 'Skill Profile'),
          h('div', {class: 'row'}, p.state === 'confirmed' ? chip('已確認生效', 'g') : chip('草稿・尚未確認', 'a'), p.stale && chip('修課紀錄有異動，請重新盤點', 'a'))),
        p.skills.length ? table(['技能', '等級', '分數（僅本人可見）', '狀態', '證據'], p.skills.map(s => h('tr', null,
          h('td', null, h('b', null, s.name), h('div', {class: 'mu small'}, s.category), !s.kept && chip('不納入媒合', 'r')),
          h('td', null, levelChip(s.level)), h('td', null, s.scale === 'cefr' ? '—' : s.score), h('td', null, statusChip(s.status)),
          h('td', null, s.note && h('div', {class: 'mu small'}, s.note), h('details', null, h('summary', null, `${s.evidence.length} 筆證據`), s.evidence.map(evidenceLine))))))
          : h('p', {class: 'mu'}, '尚未盤點。到「助理」輸入「幫我盤點能力」。'),
        p.pending.length > 0 && h('div', null, h('h3', null, '有證據但尚無法推估等級'), p.pending.map(x => h('div', null, h('b', null, x.name), x.evidence.map(evidenceLine))))),
      h('div', {class: 'grid2'},
        card(null, h('h2', null, '修課紀錄'),
          table(['課程', '學期', '成績', '來源'], data.enrollments.map(e => h('tr', null, h('td', null, e.name, e.code && h('span', {class: 'mu small'}, ` ${e.code}`)), h('td', null, e.semester ?? '—'), h('td', null, e.grade), h('td', null, e.verified ? chip('校務紀錄', 'g') : [chip('自填・待驗證', 'a'), ' ', h('button', {class: 'btn ghost sm', type: 'button', onclick: () => removeEnrollment(e.id)}, '刪除')])))),
          h('p', {class: 'mu small'}, '成績只用於推估等級，不會顯示給其他人，也不會寫入執行紀錄。'),
          h('h3', null, '新增修課紀錄'),
          h('div', {class: 'grid2'},
            h('div', null, h('label', {for: 'en-code'}, '課程（課綱庫）'), h('select', {id: 'en-code', onchange: e => { form.enCode = e.target.value; ctx.render(); }},
              h('option', {value: ''}, '不在清單內，自行填寫課名'), state.courses.map(c => h('option', {value: c.code, selected: form.enCode === c.code}, `${c.code} ${c.name}`)))),
            !form.enCode && h('div', null, h('label', {for: 'en-name'}, '課名'), h('input', {id: 'en-name', type: 'text', maxlength: 40, value: form.enName, oninput: e => { form.enName = e.target.value; }})),
            h('div', null, h('label', {for: 'en-grade'}, '成績（0–100）'), h('input', {id: 'en-grade', type: 'number', min: 0, max: 100, value: form.enGrade, oninput: e => { form.enGrade = e.target.value; }})),
            h('div', null, h('label', {for: 'en-sem'}, '學期（例如 114-1）'), h('input', {id: 'en-sem', type: 'text', maxlength: 5, value: form.enSem, oninput: e => { form.enSem = e.target.value; }}))),
          h('button', {class: 'btn sm', type: 'button', style: {marginTop: '10px'}, onclick: addEnrollment}, '新增')),
        card(null, h('h2', null, '新增證照／作品集／競賽'),
          h('p', {class: 'mu small'}, '自行填寫並對應 1～5 個指標庫內的技能。自填一律為「自述」，驗證後才算「已驗證」。'),
          h('div', {class: 'grid2'},
            h('div', null, h('label', {for: 'ev-type'}, '類型'), h('select', {id: 'ev-type', onchange: e => { form.evType = e.target.value; }},
              ['portfolio', 'certificate', 'competition'].map(t => h('option', {value: t, selected: form.evType === t}, EVIDENCE_TYPE[t])))),
            h('div', null, h('label', {for: 'ev-title'}, '名稱'), h('input', {id: 'ev-title', type: 'text', maxlength: 80, value: form.evTitle, oninput: e => { form.evTitle = e.target.value; }}))),
          form.evSkills.has('SK-LNG-001') && h('div', {class: 'grid2', style: {marginTop: '8px'}},
            h('div', null, h('label', {for: 'ex-kind'}, '英文檢定（換算 CEFR）'), h('select', {id: 'ex-kind', onchange: e => { form.examKind = e.target.value; ctx.render(); }},
              h('option', {value: 'toeic', selected: form.examKind === 'toeic'}, '多益'), h('option', {value: 'gept', selected: form.examKind === 'gept'}, '全民英檢'))),
            form.examKind === 'toeic'
              ? h('div', null, h('label', {for: 'ex-score'}, '多益聽讀總分'), h('input', {id: 'ex-score', type: 'number', min: 10, max: 990, value: form.examScore, oninput: e => { form.examScore = e.target.value; }}))
              : h('div', null, h('label', {for: 'ex-level'}, '級數'), h('select', {id: 'ex-level', onchange: e => { form.examLevel = e.target.value; }}, ['初級', '中級', '中高級', '高級', '優級'].map(l => h('option', {value: l, selected: form.examLevel === l}, l))))),
          h('details', {open: form.evSkills.size > 0}, h('summary', null, `對應技能（已選 ${form.evSkills.size}/5）`), h('div', {class: 'faults'}, skillOptions)),
          h('button', {class: 'btn sm', type: 'button', style: {marginTop: '10px'}, disabled: !form.evTitle.trim() || !form.evSkills.size, onclick: addEvidence}, '新增自述證據'))),
    ];
  }

  function teacherProfile(data) {
    return [
      h('h1', null, '我的專長'),
      h('p', {class: 'lead'}, '教師專長與學生技能、競賽需求引用同一套 Skill ID。'),
      card(null, h('dl', {class: 'kv'},
        h('dt', null, '專長技能'), h('dd', null, h('div', {class: 'chips'}, data.expertise.map(x => chip(x.name, 'o')))),
        h('dt', null, '研究方向'), h('dd', null, data.research.join('、')),
        h('dt', null, '開授課程'), h('dd', null, data.courses.map(c => c.name).join('、') || '—'),
        h('dt', null, '指導紀錄'), h('dd', null, data.advised.map(a => `${a.type} ${a.teams} 隊`).join('、') || '—'),
        h('dt', null, '學門代碼'), h('dd', null, `ISCED-F ${data.fieldCode}`),
        h('dt', null, '指導名額'), h('dd', null, `${data.quota.used}/${data.quota.total}`, ' ', data.openToAdvise ? chip('開放指導', 'g') : chip('未開放', 'r')))),
    ];
  }

  const profile = () => (state.profile?.role === 'student' ? studentProfile(state.profile) : state.profile?.role === 'teacher' ? teacherProfile(state.profile) : [h('p', {class: 'mu'}, '載入中…')]);

  // ---------- 邀請 ----------
  const respond = (id, accept) => guard(async () => {
    await api('POST', `/api/invitations/${id}/respond`, {accept});
    toast(accept ? '已同意邀請' : '已婉拒邀請');
    await ctx.reload();
  })();

  function invitations() {
    const rows = state.invitations.map(inv => h('tr', null,
      h('td', null, inv.direction === 'incoming' ? chip('收到', 'b') : chip('送出', 'o')),
      h('td', null, inv.kind === 'advisor' ? '指導邀請' : '組隊邀請'),
      h('td', null, inv.direction === 'incoming' ? `${inv.from.name}（${inv.from.dept}）` : `${inv.to.name}（${inv.to.dept}）`),
      h('td', null, inv.competition ?? '—', inv.skill && h('div', {class: 'mu small'}, `補位：${inv.skill}`)),
      h('td', null, chip(...INVITE_STATUS[inv.status])),
      h('td', null, inv.direction === 'incoming' && inv.status === 'sent' && h('div', {class: 'row'},
        h('button', {class: 'btn sm', type: 'button', onclick: () => respond(inv.id, true)}, '同意'),
        h('button', {class: 'btn ghost sm', type: 'button', onclick: () => respond(inv.id, false)}, '婉拒')))));
    return [
      h('h1', null, '邀請'),
      h('p', {class: 'lead'}, 'Agent 不會自行送出邀請；送出後也要對方同意，組隊或指導關係才成立。'),
      card(null, rows.length ? table(['方向', '類型', '對象', '競賽', '狀態', ''], rows) : h('p', {class: 'mu'}, '目前沒有邀請。')),
    ];
  }

  // ---------- 技能指標庫 ----------
  function skillsPage() {
    const byCategory = Map.groupBy(state.skills, s => s.category);
    const nameOf = id => state.skills.find(s => s.id === id)?.zh ?? id;
    return [
      h('h1', null, '共用 Skill 指標庫'),
      h('p', {class: 'lead'}, `學生、教師、競賽三方都引用同一套 Skill ID（共 ${state.skills.length} 項）。內部 ID 為主鍵，並對應 ESCO、O*NET、SFIA、UCAN 等外部標準。`),
      [...byCategory.entries()].map(([category, items]) => card(null, h('h2', null, category),
        table(['Skill ID', '名稱', '上位技能', 'ESCO', '其他對應', '量尺'], items.map(s => h('tr', null,
          h('td', null, h('code', null, s.id)), h('td', null, h('b', null, s.zh), h('div', {class: 'mu small'}, s.en)),
          h('td', null, s.parentId ? nameOf(s.parentId) : '—'),
          h('td', null, s.ext.esco ? [h('a', {href: s.ext.esco.uri, target: '_blank', rel: 'noopener noreferrer'}, s.ext.esco.label), ' ', chip({exact: '精確', broader: '上位', related: '相近'}[s.ext.esco.match] ?? s.ext.esco.match)] : '—'),
          h('td', {class: 'small'}, [s.ext.onetUnspsc && `O*NET UNSPSC ${s.ext.onetUnspsc}`, s.ext.sfia && `SFIA ${s.ext.sfia}`, s.ext.ucan && `UCAN ${s.ext.ucan}`].filter(Boolean).join('｜') || '—'),
          h('td', null, s.scale === 'cefr' ? 'CEFR A1–C2' : '初階／中階／進階')))))),
    ];
  }

  // ---------- 評測 ----------
  function evalPage() {
    const e = state.evalLatest;
    if (!e) return [h('h1', null, '評測結果'), card(null, h('p', {class: 'mu'}, '尚未產生評測結果。請在專案目錄執行 npm run eval。'))];
    const s = e.summary;
    const stat = (label, value) => h('div', {class: 'cand'}, h('div', {class: 'mu small'}, label), h('div', {class: 'score'}, value));
    return [
      h('h1', null, '評測結果'),
      h('p', {class: 'lead'}, `執行時間 ${e.generatedAt}｜決策模式 ${e.environment.brain}｜規則版本 ${e.environment.rulesVersion}｜測試案例 ${s.cases} 個`),
      h('div', {class: 'grid3'}, stat('任務成功率', `${Math.round(s.successRate * 100)}%`), stat('工具調用成功率', s.toolSuccessRate === null ? '—' : `${Math.round(s.toolSuccessRate * 1000) / 10}%`),
        stat('單步延遲 平均／最大', `${s.latency.stepAvgMs}／${s.latency.stepMaxMs} ms`), stat('違規推薦', s.violations), stat('重複推薦', s.duplicates), stat('LLM 成本', `US$ ${s.costUsd}`)),
      card(null, h('h2', null, '與基準方案比較'), table(['指標', '固定工作流（基準）', 'Fomo鬆 Agent'], e.baseline.rows.map(r => h('tr', null, h('td', null, r.metric), h('td', null, r.baseline), h('td', null, h('b', null, r.agent)))))),
      card(null, h('h2', null, '測試案例'), table(['編號', '類別', '案例', '結果', '說明'], e.cases.map(c => h('tr', null, h('td', null, c.id), h('td', null, c.category), h('td', null, c.title),
        h('td', null, c.passed ? chip('通過', 'g') : chip('未通過', 'r')), h('td', {class: 'small mu'}, c.failures.join('；') || c.note || ''))))),
    ];
  }

  // ---------- 管理者 ----------
  const verify = (id, verified) => guard(async () => {
    await api('POST', `/api/admin/evidence/${id}/verify`, {verified});
    toast('已驗證，該生的 Skill Profile 已依統一規則重新彙整');
    await ctx.reload();
  })();

  function adminEvidence() {
    return [
      h('h1', null, '證據驗證'),
      h('p', {class: 'lead'}, '學生自填的證照、作品集、競賽與修課紀錄，經承辦人查驗後才由「自述」轉為「已驗證」。每次驗證都會留下稽核紀錄。查驗修課紀錄時會顯示學生自填的成績，請對照校務資料後再通過。'),
      card(null, state.adminEvidence.length ? table(['學生', '類型', '名稱', '自填成績', '對應技能', ''], state.adminEvidence.map(g => h('tr', null,
        h('td', null, g.ownerName), h('td', null, EVIDENCE_TYPE[g.type]), h('td', null, g.title, g.semester && h('span', {class: 'mu small'}, ` ${g.semester}`)),
        h('td', null, g.claimedGrade === null ? '—' : g.claimedGrade), h('td', null, h('div', {class: 'chips'}, g.skills.map(n => chip(n)))),
        h('td', null, h('button', {class: 'btn sm', type: 'button', onclick: () => verify(g.evidenceId, true)}, '查驗通過')))))
        : h('p', {class: 'mu'}, '沒有待驗證的證據。')),
    ];
  }

  function adminAudit() {
    return [
      h('h1', null, '稽核紀錄'),
      card(null, table(['時間', '帳號', '動作', '對象', '細節'], state.adminAudit.map(a => h('tr', null,
        h('td', {class: 'small'}, a.ts.replace('T', ' ').slice(0, 19)), h('td', null, a.userId ?? '—'), h('td', null, a.action), h('td', {class: 'small'}, a.target ?? '—'), h('td', {class: 'small mu'}, a.detail ? JSON.stringify(a.detail) : ''))))),
    ];
  }

  function adminRuns() {
    return [
      h('h1', null, '任務紀錄'),
      h('p', {class: 'lead'}, '管理者可查核任一任務的操作紀錄（不含成績）。點選後紀錄會顯示在右側面板。'),
      card(null, table(['任務', '帳號', '目標', '狀態', ''], state.adminRuns.map(r => h('tr', null,
        h('td', null, h('code', null, r.id)), h('td', null, r.userId), h('td', null, r.goal), h('td', null, chip(r.status)),
        h('td', null, h('button', {class: 'btn ghost sm', type: 'button', onclick: () => ctx.showTrace(r.id)}, '查看紀錄')))))),
    ];
  }

  return {profile, invitations, skills: skillsPage, eval: evalPage, adminEvidence, adminAudit, adminRuns};
}
