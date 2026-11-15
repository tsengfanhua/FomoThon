// 資料品質檢核規則：六個面向（參考 ISO/IEC 25012 資料品質模型）。
// 每條規則都回報「檢查幾筆、幾筆不合格、不合格樣本」，由 src/dq/index.js 彙整成分數與閘門。
// 規則只讀資料、不修改資料；error 等級代表資料不能用（啟動閘門會擋下），warning 代表可用但要處理。
import {extractSkills} from '../inventory/extractor.js';
import {validate} from '../jsonschema.js';
import {findSuspiciousContent} from '../safety/guard.js';
import {aliasRegex, createMatcher} from '../skills/repo.js';
import {SYLLABUS_RULES} from './syllabus.js';

export const DIMENSIONS = Object.freeze({
  completeness: '完整性',
  validity: '有效性',
  uniqueness: '唯一性',
  consistency: '一致性',
  timeliness: '時效性',
  credibility: '可信度',
});

const SEMESTER_MAX_AGE_YEARS = 4;
const MAPPING_MAX_AGE_DAYS = 365;
const MAX_HIERARCHY_DEPTH = 3;
const ROC_YEAR_OFFSET = 1911;
const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const MS_PER_DAY = 86_400_000;

const result = (checked, failures) => ({checked, failures});
const termsOf = s => [...new Set([s.zh, s.en, ...(s.aliases ?? [])])];
const normalizeTerm = t => String(t).toLowerCase().replace(/\s+/g, '');

function duplicates(values) {
  const seen = new Set();
  const dup = new Set();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/** 把所有種子資料攤平成 {kind, id, value}，方便逐筆套用資料契約。 */
export function entitiesOf(seed) {
  return [
    ...seed.skills.skills.map(value => ({kind: 'skill', id: value.id, value})),
    ...seed.courses.courses.map(value => ({kind: 'course', id: value.code, value})),
    ...seed.people.students.map(value => ({kind: 'student', id: value.id, value})),
    ...seed.people.teachers.map(value => ({kind: 'teacher', id: value.id, value})),
    ...seed.people.admins.map(value => ({kind: 'admin', id: value.id, value})),
    ...seed.competitions.competitions.map(value => ({kind: 'competition', id: value.id, value})),
  ];
}

/** 預先計算多條規則共用的衍生資料（只算一次）。 */
export function prepare(seed, env) {
  const skills = seed.skills.skills;
  const skillIds = new Set(skills.map(s => s.id));
  const byId = new Map(skills.map(s => [s.id, s]));
  const matcher = {findInText: createMatcher(skills)};
  const extracted = new Map(seed.courses.courses.map(c => [c.code, extractSkills(c, matcher, env.rules)]));
  const taught = new Set([...extracted.values()].flatMap(items => items.map(i => i.skillId)));
  const schemaErrors = entitiesOf(seed).map(e => ({...e, errors: validate(env.contracts[e.kind], e.value, {maxErrors: 20}).errors}));
  return {seed, env, skills, skillIds, byId, extracted, taught, schemaErrors};
}

function schemaCheck(ctx, wantRequired) {
  const failures = ctx.schemaErrors
    .map(e => ({e, errs: e.errors.filter(err => (err.keyword === 'required') === wantRequired)}))
    .filter(x => x.errs.length)
    .map(({e, errs}) => `${e.kind} ${e.id ?? '(無 ID)'}：${errs.slice(0, 2).map(err => `${err.path} ${err.message}`).join('；')}`);
  return result(ctx.schemaErrors.length, failures);
}

/** 由下往上走訪上位技能；回傳 {depth, cycle, missing}。 */
function walkParents(byId, skill) {
  const seen = new Set([skill.id]);
  let depth = 1;
  let current = skill;
  while (current.parent) {
    if (!byId.has(current.parent)) return {depth, cycle: false, missing: current.parent};
    if (seen.has(current.parent)) return {depth, cycle: true, missing: null};
    seen.add(current.parent);
    current = byId.get(current.parent);
    depth += 1;
  }
  return {depth, cycle: false, missing: null};
}

/** 所有指向 Skill 資料庫的引用：關聯、競賽需求、教師專長、學生自填證據。 */
function skillReferences(seed) {
  return [
    ...seed.skills.relations.flatMap(([a, b]) => [{ref: a, from: '技能關聯'}, {ref: b, from: '技能關聯'}]),
    ...seed.competitions.competitions.flatMap(c => c.needs.map(n => ({ref: n.skill, from: `競賽 ${c.id}`}))),
    ...seed.people.teachers.flatMap(t => (t.expertise ?? []).map(ref => ({ref, from: `教師 ${t.id}`}))),
    ...seed.people.students.flatMap(s => (s.evidence ?? []).flatMap(ev => ev.skills.map(ref => ({ref, from: `學生 ${s.id} 證據`})))),
  ];
}

function crossMatches(ctx) {
  // 對每個技能 X，拿其他技能 Y 的名稱與別名當測試文字，看 X 的比對規則會不會誤中
  return ctx.skills.map(x => {
    const patterns = termsOf(x).map(aliasRegex);
    const related = new Set([x.parent, ...ctx.skills.filter(s => s.parent === x.id).map(s => s.id)].filter(Boolean));
    const victims = ctx.skills
      .filter(y => y.id !== x.id && !related.has(y.id))
      .filter(y => termsOf(y).some(term => patterns.some(re => re.test(term))))
      .map(y => y.id);
    return {skill: x, victims};
  });
}

const textsOf = seed => [
  ...seed.courses.courses.map(c => ({label: `課程 ${c.code}`, text: [c.name, c.objectives, ...c.weeks, ...c.assessments.map(a => a.name)].join('\n')})),
  ...seed.competitions.competitions.map(c => ({label: `競賽 ${c.id}`, text: [c.name, c.description, ...(c.keywords ?? [])].join('\n')})),
  ...seed.people.students.flatMap(s => [
    {label: `學生 ${s.id} 自我介紹`, text: s.bio ?? ''},
    ...(s.evidence ?? []).map(ev => ({label: `學生 ${s.id} 證據「${ev.title.slice(0, 20)}」`, text: ev.title})),
  ]),
];

const semesterAgeYears = (semester, today) => {
  const year = Number(semester.split('-')[0]) + ROC_YEAR_OFFSET;
  return Number(today.slice(0, 4)) - year;
};

/**
 * personal：不合格樣本可能提到個別學生或教師（例如學號、修課、自填證據），對外（MCP）輸出時只給數量、不給樣本。
 * @type {Array<{id:string, dimension:string, severity:'error'|'warning', title:string, personal?:boolean, run:(ctx:object)=>{checked:number, failures:string[]}}>}
 */
export const CHECKS = Object.freeze([
  // ---------- 完整性 ----------
  {id: 'C1', dimension: 'completeness', severity: 'error', title: '必填欄位齊全（依資料契約）', personal: true, run: ctx => schemaCheck(ctx, true)},
  {
    id: 'C2', dimension: 'completeness', severity: 'warning', title: `課綱至少 ${SYLLABUS_RULES.minWeeks} 週進度、教學目標完整`,
    run: ({seed}) => result(seed.courses.courses.length, seed.courses.courses
      .map(c => ({c, weeks: c.weeks.filter(w => String(w).trim()).length}))
      .filter(({c, weeks}) => weeks < SYLLABUS_RULES.minWeeks || [...(c.objectives ?? '')].length < SYLLABUS_RULES.minObjectiveChars)
      .map(({c, weeks}) => `${c.code}「${c.name}」：${weeks} 週`)),
  },
  {
    id: 'C3', dimension: 'completeness', severity: 'warning', title: '每門課都能萃取出至少一項技能（課綱→技能覆蓋）',
    run: ({seed, extracted}) => result(seed.courses.courses.length, seed.courses.courses
      .filter(c => !extracted.get(c.code).length).map(c => `${c.code}「${c.name}」沒有比對到任何技能`)),
  },
  {
    id: 'C4', dimension: 'completeness', severity: 'warning', title: '競賽需要的技能都有課程可以培養（需求→課程覆蓋）',
    run: ({seed, byId, taught}) => {
      const teachable = new Set([...taught, ...[...taught].map(id => byId.get(id)?.parent).filter(Boolean)]);
      const needed = [...new Set(seed.competitions.competitions.flatMap(c => c.needs.map(n => n.skill)))]
        .filter(id => byId.get(id)?.scale !== 'cefr'); // 英文以檢定成績認定，不靠修課
      return result(needed.length, needed.filter(id => !teachable.has(id)).map(id => `${id}「${byId.get(id)?.zh ?? '?'}」沒有任何課程教授`));
    },
  },
  // ---------- 有效性 ----------
  {id: 'V1', dimension: 'validity', severity: 'error', title: '欄位格式與值域符合資料契約', personal: true, run: ctx => schemaCheck(ctx, false)},
  {
    id: 'V2', dimension: 'validity', severity: 'error', title: '課程評量權重合計為 100%',
    run: ({seed}) => result(seed.courses.courses.length, seed.courses.courses
      .map(c => ({c, total: c.assessments.reduce((acc, a) => acc + a.weight, 0)}))
      .filter(x => x.total !== SYLLABUS_RULES.assessmentTotal).map(x => `${x.c.code} 合計 ${x.total}%`)),
  },
  {
    id: 'V3', dimension: 'validity', severity: 'error', title: '競賽門檻與技能量尺一致（英文用 CEFR、其他用分數）',
    run: ({seed, byId}) => {
      const needs = seed.competitions.competitions.flatMap(c => c.needs.map(n => ({c, n})));
      return result(needs.length, needs.filter(({n}) => {
        const cefr = byId.get(n.skill)?.scale === 'cefr';
        return cefr ? !CEFR_LEVELS.includes(n.min) : typeof n.min !== 'number';
      }).map(({c, n}) => `${c.id} 的 ${n.skill} 門檻「${n.min}」與量尺不符`));
    },
  },
  {
    id: 'V4', dimension: 'validity', severity: 'error', title: '技能關聯格式為 [技能, 技能, 0～1 的權重]',
    run: ({seed}) => result(seed.skills.relations.length, seed.skills.relations
      .filter(r => !(Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && typeof r[1] === 'string' && typeof r[2] === 'number' && r[2] > 0 && r[2] <= 1))
      .map(r => JSON.stringify(r))),
  },
  // ---------- 唯一性 ----------
  {
    id: 'U1', dimension: 'uniqueness', severity: 'error', title: '各類資料的 ID 不重複（人員 ID 跨角色也不重複）', personal: true,
    run: ({seed}) => {
      const groups = [
        seed.skills.skills.map(s => s.id), seed.courses.courses.map(c => c.code), seed.competitions.competitions.map(c => c.id),
        [...seed.people.students, ...seed.people.teachers, ...seed.people.admins].map(p => p.id),
      ];
      return result(groups.flat().length, groups.flatMap(duplicates).map(id => `重複的 ID：${id}`));
    },
  },
  {
    id: 'U2', dimension: 'uniqueness', severity: 'error', title: '技能名稱與別名不重複（避免一詞對應多個技能）',
    run: ({skills}) => {
      const owners = new Map();
      for (const s of skills) for (const t of termsOf(s)) owners.set(normalizeTerm(t), new Set([...(owners.get(normalizeTerm(t)) ?? []), s.id]));
      const clashes = [...owners.entries()].filter(([, ids]) => ids.size > 1);
      return result(owners.size, clashes.map(([term, ids]) => `「${term}」同時屬於 ${[...ids].join('、')}`));
    },
  },
  {
    id: 'U3', dimension: 'uniqueness', severity: 'warning', title: '技能關聯沒有重複或自我關聯',
    run: ({seed}) => {
      const keys = seed.skills.relations.map(([a, b]) => [a, b].sort().join('|'));
      const self = seed.skills.relations.filter(([a, b]) => a === b).map(([a]) => `${a} 關聯到自己`);
      return result(keys.length, [...self, ...duplicates(keys).map(k => `重複的關聯：${k.replace('|', ' ↔ ')}`)]);
    },
  },
  {
    id: 'U4', dimension: 'uniqueness', severity: 'warning', title: '同一位學生沒有重複的修課紀錄', personal: true,
    run: ({seed}) => {
      const students = seed.people.students;
      return result(students.length, students.flatMap(s => duplicates(s.enrollments.map(e => e.code ?? e.name)).map(k => `${s.id} 重複修課：${k}`)));
    },
  },
  // ---------- 一致性 ----------
  {
    id: 'R1', dimension: 'consistency', severity: 'error', title: `技能階層：上位技能存在、沒有循環、最多 ${MAX_HIERARCHY_DEPTH} 層`,
    run: ({skills, byId}) => result(skills.length, skills.map(s => ({s, w: walkParents(byId, s)}))
      .filter(({w}) => w.missing || w.cycle || w.depth > MAX_HIERARCHY_DEPTH)
      .map(({s, w}) => (w.missing ? `${s.id} 的上位技能 ${w.missing} 不存在` : w.cycle ? `${s.id} 的階層有循環` : `${s.id} 階層深度 ${w.depth}`))),
  },
  {
    id: 'R2', dimension: 'consistency', severity: 'error', title: '所有技能引用都存在於 Skill 資料庫',
    run: ({seed, skillIds}) => {
      const refs = skillReferences(seed);
      return result(refs.length, refs.filter(r => !skillIds.has(r.ref)).map(r => `${r.from} 引用了不存在的技能 ${r.ref}`));
    },
  },
  {
    id: 'R3', dimension: 'consistency', severity: 'error', title: '課程的授課教師存在於教師名單',
    run: ({seed}) => {
      const teacherIds = new Set(seed.people.teachers.map(t => t.id));
      return result(seed.courses.courses.length, seed.courses.courses.filter(c => !teacherIds.has(c.teacherId)).map(c => `${c.code} 的教師 ${c.teacherId} 不存在`));
    },
  },
  {
    id: 'R4', dimension: 'consistency', severity: 'error', title: '修課紀錄的課程代碼存在於課綱庫（課綱庫外課程必須填課名）', personal: true,
    run: ({seed}) => {
      const codes = new Set(seed.courses.courses.map(c => c.code));
      const rows = seed.people.students.flatMap(s => s.enrollments.map(e => ({s, e})));
      return result(rows.length, rows
        .filter(({e}) => (e.code ? !codes.has(e.code) : !String(e.name ?? '').trim()))
        .map(({s, e}) => (e.code ? `${s.id} 的 ${e.code} 不在課綱庫` : `${s.id} 有一筆課綱庫外的修課紀錄沒有課名`)));
    },
  },
  {
    id: 'R5', dimension: 'consistency', severity: 'error', title: '數量邏輯合理（已用名額 ≤ 名額、隊伍人數下限 ≤ 上限）', personal: true,
    run: ({seed}) => {
      const teachers = seed.people.teachers.filter(t => t.used > t.quota).map(t => `${t.id} 已用 ${t.used} 超過名額 ${t.quota}`);
      const comps = seed.competitions.competitions.filter(c => c.eligibility.teamMin > c.eligibility.teamMax).map(c => `${c.id} 隊伍人數下限大於上限`);
      return result(seed.people.teachers.length + seed.competitions.competitions.length, [...teachers, ...comps]);
    },
  },
  // ---------- 時效性 ----------
  {
    id: 'T1', dimension: 'timeliness', severity: 'warning', title: '競賽報名尚未截止（已截止者應封存）',
    run: ({seed, env}) => result(seed.competitions.competitions.length, seed.competitions.competitions
      .filter(c => c.deadline < env.today).map(c => `${c.id}「${c.name}」已於 ${c.deadline} 截止`)),
  },
  {
    id: 'T2', dimension: 'timeliness', severity: 'warning', title: `修課紀錄在 ${SEMESTER_MAX_AGE_YEARS} 學年內`, personal: true,
    run: ({seed, env}) => {
      const rows = seed.people.students.flatMap(s => s.enrollments.filter(e => e.semester).map(e => ({s, e})));
      return result(rows.length, rows.filter(({e}) => semesterAgeYears(e.semester, env.today) > SEMESTER_MAX_AGE_YEARS)
        .map(({s, e}) => `${s.id} 的 ${e.code ?? e.name}（${e.semester}）已超過 ${SEMESTER_MAX_AGE_YEARS} 學年`));
    },
  },
  {
    id: 'T3', dimension: 'timeliness', severity: 'warning', title: `外部標準對應在 ${MAPPING_MAX_AGE_DAYS} 天內查證過`,
    run: ({seed, env}) => {
      const at = seed.skills._meta?.mappingVerifiedAt;
      if (!at) return result(1, ['Skill 資料庫沒有記錄對應查證日期（_meta.mappingVerifiedAt）']);
      const days = Math.round((new Date(`${env.today}T00:00:00Z`) - new Date(`${at}T00:00:00Z`)) / MS_PER_DAY);
      return result(1, days > MAPPING_MAX_AGE_DAYS ? [`對應於 ${at} 查證，已過 ${days} 天`] : []);
    },
  },
  // ---------- 可信度 ----------
  {
    id: 'A1', dimension: 'credibility', severity: 'error', title: '別名比對不會誤中無上下位關係的其他技能（例如 Java ≠ JavaScript）',
    run: ctx => {
      const rows = crossMatches(ctx);
      return result(rows.length, rows.filter(r => r.victims.length).map(r => `${r.skill.id}「${r.skill.zh}」的比對規則會誤中 ${r.victims.join('、')}`));
    },
  },
  {
    id: 'A2', dimension: 'credibility', severity: 'warning', title: '外部文件不含提示注入或程式碼片段', personal: true,
    run: ({seed}) => {
      const docs = textsOf(seed);
      return result(docs.length, docs.map(d => ({d, reasons: findSuspiciousContent(d.text)})).filter(x => x.reasons.length)
        .map(({d, reasons}) => `${d.label}：${reasons.map(r => (r === 'markup' ? 'HTML／腳本片段' : '疑似提示注入')).join('、')}`));
    },
  },
  {
    id: 'A3', dimension: 'credibility', severity: 'warning', title: '技能至少對應一個外部標準（ESCO／O*NET／SFIA／UCAN）',
    run: ({skills}) => result(skills.length, skills.filter(s => !s.esco && !s.onetUnspsc && !s.sfia && !s.ucan).map(s => `${s.id}「${s.zh}」沒有外部標準對應`)),
  },
]);
