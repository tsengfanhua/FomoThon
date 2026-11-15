// 協調器的決策政策（純函式）：依目前狀態算出「此刻合法的下一步動作」。
// 不論由規則或 LLM 來選，都只能從這份清單裡挑；清單順序即規則式的優先順序。

export const MAX_STEPS = 16;
const NEEDS_INVENTORY = new Set(['prepare_competition', 'find_competition', 'inventory']);

/** 建立一次任務的初始狀態。 */
export function initialState({goal, studentId, intent, faults}) {
  return {
    goal, studentId, intent, faults: faults ?? {},
    inventory: {status: 'pending', courses: []},
    competition: {status: 'pending', targetId: intent.competitionId, analysis: null, analyses: [], tried: [], needsSwitch: false, replacedFrom: null},
    gaps: [],
    team: {},
    advisor: {needed: intent.type === 'find_teacher', status: 'pending', result: null},
    summary: null,
    pending: null,
    approval: null,
    stepCount: 0,
    outcome: null,
  };
}

const act = (action, label, why, args = {}) => ({id: args.skillId ? `${action}:${args.skillId}` : action, action, label, why, args});

/**
 * @returns {Array<{id:string, action:string, label:string, why:string, args:object}>}
 */
export function allowedActions(s) {
  if (s.outcome || s.pending) return [];
  const type = s.intent.type;

  if (NEEDS_INVENTORY.has(type) && s.inventory.status === 'pending') {
    return [act('run_inventory', '能力盤點', '後續分析需要以課綱證據為基礎的能力檔案')];
  }

  if (type === 'find_competition' && s.competition.status === 'pending') {
    return [act('recommend_competitions', '競賽推薦', '依能力檔案比對各競賽的需求技能')];
  }

  if (type === 'prepare_competition') {
    if (s.competition.status === 'pending') {
      return s.competition.targetId
        ? [act('analyze_competition', '競賽分析', '檢查指定競賽的資格、難度與能力缺口')]
        : [act('recommend_competitions', '競賽推薦', '目標未指定單一競賽，先找出最適合的一項')];
    }
    if (s.competition.needsSwitch) {
      return [act('switch_competition', '改推薦其他競賽', '原競賽資格不符，補位無法解決，必須換競賽')];
    }
  }

  // 補位媒合：每個未處理的缺口各是一個可選動作，另加教師媒合
  const options = s.gaps.filter(g => g.status === 'open')
    .map(g => act('match_teammates', `找隊友：${g.name}`, `能力缺口「${g.name}」需要互補的隊友`, {skillId: g.skillId}));
  if (s.advisor.needed && s.advisor.status === 'pending') {
    options.push(act('match_teacher', '找指導老師', type === 'find_teacher' ? '依需求比對教師專長' : '這項競賽需要指導老師'));
  }
  if (options.length) return options;

  if (!s.summary) return [act('summarize', '彙整建議', '所有分支已完成，彙整並檢核輸出')];
  if (s.approval && !s.approval.sent) return [act('send_invitations', '送出邀請', '使用者已確認邀請名單')];
  return [];
}

const STEP_TEMPLATES = {
  prepare_competition: ['intent', 'inventory', 'confirm_profile', 'competition', 'gap_gate', 'matching', 'summary', 'confirm_invites'],
  find_competition: ['intent', 'inventory', 'confirm_profile', 'competition', 'summary'],
  find_teammate: ['intent', 'matching', 'summary', 'confirm_invites'],
  find_teacher: ['intent', 'matching', 'summary', 'confirm_invites'],
  inventory: ['intent', 'inventory', 'confirm_profile', 'summary'],
  out_of_scope: ['intent'],
};

const STEP_LABELS = {
  intent: '任務辨識', inventory: '能力盤點', confirm_profile: '確認能力檔案', competition: '競賽分析',
  gap_gate: '缺口閘門', matching: '補位媒合', summary: '彙整與輸出檢核', confirm_invites: '人工確認邀請',
};

function stepDone(key, s) {
  switch (key) {
    case 'intent': return true;
    case 'inventory': return s.inventory.status !== 'pending';
    case 'confirm_profile': return s.inventory.status !== 'pending' && s.pending?.type !== 'confirm_profile';
    case 'competition': return s.competition.status !== 'pending' && !s.competition.needsSwitch;
    case 'gap_gate': return s.competition.status !== 'pending' && !s.competition.needsSwitch;
    case 'matching': return !s.gaps.some(g => g.status === 'open') && !(s.advisor.needed && s.advisor.status === 'pending')
      && (s.intent.type !== 'prepare_competition' || s.competition.status !== 'pending');
    case 'summary': return Boolean(s.summary);
    case 'confirm_invites': return Boolean(s.outcome) || Boolean(s.approval);
    default: return false;
  }
}

/** 給介面顯示的計畫步驟：done／active／pending。計畫會隨執行結果改變（例如換競賽後重新分析）。 */
export function planView(s) {
  const keys = STEP_TEMPLATES[s.intent.type] ?? STEP_TEMPLATES.out_of_scope;
  let activeAssigned = false;
  return keys.map(key => {
    const done = stepDone(key, s);
    let status = done ? 'done' : 'pending';
    if (!done && !activeAssigned && !s.outcome) {
      status = (key === 'confirm_profile' || key === 'confirm_invites') && s.pending ? 'waiting' : 'active';
      activeAssigned = true;
    }
    if (!done && s.outcome) status = 'skipped';
    return {key, label: STEP_LABELS[key], status};
  });
}

export function runStatus(s) {
  if (s.outcome) return s.outcome.status;
  if (s.pending) return 'awaiting_user';
  return 'running';
}
