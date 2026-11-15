// 技能中樞：固定比對規則（src/hub/match.js，純函式）的單元測試。
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ADVISOR_WEIGHTS, RELATED_WEIGHT, compareSkills, coverageOf, maskName, matchSkill, rankAdvisors, recommendCourses, summarize} from '../src/hub/match.js';
import {skillMap} from './hub-fixtures.js';

/** 小寫是需求技能；大寫是它的上位技能；c2 是 ESCO 標示與 c 相關的技能。 */
const RELATIONS = new Map([
  ['c', new Map([['C', 'broader'], ['c2', 'related']])],
  ['C', new Map([['c', 'narrower']])],
  ['c2', new Map([['c', 'related']])],
  ['d', new Map([['D', 'broader']])],
  ['D', new Map([['d', 'narrower']])],
]);

test('matchSkill：擁有完全相同的技能時是 exact，而且優先於相近技能', () => {
  assert.deepEqual(matchSkill('c', new Set(['c']), RELATIONS), {level: 'exact', via: 'c', relation: null});
  assert.deepEqual(matchSkill('c', new Set(['C', 'c']), RELATIONS), {level: 'exact', via: 'c', relation: null});
  assert.deepEqual(matchSkill('zzz', new Map([['zzz', {}]]), RELATIONS), {level: 'exact', via: 'zzz', relation: null}, '擁有的技能可以是 Map');
});

test('matchSkill：只擁有上位、下位或相關技能時是 related，並帶出關聯方向', () => {
  assert.deepEqual(matchSkill('c', new Set(['C']), RELATIONS), {level: 'related', via: 'C', relation: 'broader'});
  assert.deepEqual(matchSkill('C', new Set(['c']), RELATIONS), {level: 'related', via: 'c', relation: 'narrower'});
  assert.deepEqual(matchSkill('c', new Set(['c2']), RELATIONS), {level: 'related', via: 'c2', relation: 'related'});
  assert.deepEqual(matchSkill('d', skillMap('D'), RELATIONS), {level: 'related', via: 'D', relation: 'broader'});
});

test('matchSkill：沒有相同也沒有關聯的技能時是 none', () => {
  const none = {level: 'none', via: null, relation: null};
  assert.deepEqual(matchSkill('c', new Set(['D', 'd']), RELATIONS), none);
  assert.deepEqual(matchSkill('c', new Set(), RELATIONS), none);
  assert.deepEqual(matchSkill('zzz', new Set(['c']), RELATIONS), none, '需求技能沒有任何關聯紀錄');
  assert.deepEqual(matchSkill('c', new Set(['C']), new Map()), none, '沒有關聯資料時只認完全相同');
});

test('compareSkills：逐項比對並維持輸入順序', () => {
  const result = compareSkills(['d', 'zzz', 'c'], new Set(['c', 'D']), RELATIONS);

  assert.deepEqual(result, [
    {uri: 'd', level: 'related', via: 'D', relation: 'broader'},
    {uri: 'zzz', level: 'none', via: null, relation: null},
    {uri: 'c', level: 'exact', via: 'c', relation: null},
  ]);
  assert.deepEqual(compareSkills([], new Set(['c']), RELATIONS), []);
});

test('coverageOf：沒有需求時回 null；相近技能折半計算', () => {
  assert.equal(RELATED_WEIGHT, 0.5);
  assert.equal(coverageOf([]), null);
  assert.equal(coverageOf([{level: 'exact'}]), 1);
  assert.equal(coverageOf([{level: 'related'}]), 0.5);
  assert.equal(coverageOf([{level: 'none'}]), 0);
  assert.equal(coverageOf([{level: 'exact'}, {level: 'related'}, {level: 'none'}, {level: 'none'}]), 0.375);
});

test('summarize：統計各等級的數量並換算成百分比', () => {
  const matches = compareSkills(['c', 'd', 'zzz', 'yyy'], new Set(['c', 'D']), RELATIONS);

  assert.deepEqual(summarize(matches), {exact: 1, related: 1, none: 2, percent: 38});
  assert.deepEqual(summarize([{level: 'exact'}, {level: 'exact'}]), {exact: 2, related: 0, none: 0, percent: 100});
  assert.deepEqual(summarize([]), {exact: 0, related: 0, none: 0, percent: null}, '沒有需求時無從評估');
});

/** 比賽需要 a–e 五項技能，學生缺 c、d。 */
const REQUIRED = ['a', 'b', 'c', 'd', 'e'];
const GAPS = ['c', 'd'];
const CANDIDATES = [
  {id: 'T-G', skills: skillMap('e')},
  {id: 'T-F', skills: skillMap('zzz')}, // 沒有涵蓋任何需求
  {id: 'T-E', skills: skillMap('C')}, // 只有 c 的上位技能
  {id: 'T-D', skills: skillMap('c', 'd')},
  {id: 'T-C', skills: skillMap('a', 'b')},
  {id: 'T-B', skills: skillMap('a', 'c')},
  {id: 'T-A', skills: skillMap('a', 'b', 'c', 'd', 'e')},
];

test('rankAdvisors：有缺口時，分數＝0.6×需求涵蓋＋0.4×缺口涵蓋', () => {
  assert.deepEqual(ADVISOR_WEIGHTS, {required: 0.6, gap: 0.4});

  const ranked = rankAdvisors({required: REQUIRED, gaps: GAPS, advisors: CANDIDATES, relations: RELATIONS, limit: 10});
  const byId = Object.fromEntries(ranked.map(r => [r.id, r]));

  // T-B：需求 2/5＝40%、缺口 1/2＝50% → 0.6×40＋0.4×50＝44
  assert.deepEqual(byId['T-B'], {
    id: 'T-B', score: 44, requiredCoverage: 40, gapCoverage: 50, gapsCovered: ['c'],
    matches: [{uri: 'a', level: 'exact', via: 'a', relation: null}, {uri: 'c', level: 'exact', via: 'c', relation: null}],
  });
  // T-C：需求 40%、缺口 0% → 24；T-D：需求 40%、缺口 100% → 64
  assert.deepEqual([byId['T-C'].score, byId['T-C'].requiredCoverage, byId['T-C'].gapCoverage, byId['T-C'].gapsCovered], [24, 40, 0, []]);
  assert.deepEqual([byId['T-D'].score, byId['T-D'].requiredCoverage, byId['T-D'].gapCoverage, byId['T-D'].gapsCovered], [64, 40, 100, ['c', 'd']]);
  // T-E：相近技能折半 → 需求 0.5/5＝10%、缺口 0.5/2＝25% → 0.6×10＋0.4×25＝16
  assert.deepEqual(byId['T-E'], {
    id: 'T-E', score: 16, requiredCoverage: 10, gapCoverage: 25, gapsCovered: ['c'],
    matches: [{uri: 'c', level: 'related', via: 'C', relation: 'broader'}],
  });
  assert.deepEqual([byId['T-A'].score, byId['T-A'].requiredCoverage, byId['T-A'].gapCoverage], [100, 100, 100]);
});

test('rankAdvisors：沒有缺口時，分數只看需求涵蓋', () => {
  const ranked = rankAdvisors({required: REQUIRED, gaps: [], advisors: CANDIDATES, relations: RELATIONS, limit: 10});
  const byId = Object.fromEntries(ranked.map(r => [r.id, r]));

  assert.deepEqual([byId['T-B'].score, byId['T-B'].requiredCoverage, byId['T-B'].gapCoverage, byId['T-B'].gapsCovered], [40, 40, null, []]);
  assert.deepEqual(ranked.map(r => [r.id, r.score]), [['T-A', 100], ['T-B', 40], ['T-C', 40], ['T-D', 40], ['T-G', 20], ['T-E', 10]]);
});

test('rankAdvisors：依分數由高到低排序並套用 limit；沒涵蓋任何需求的教師不出現', () => {
  const input = {required: REQUIRED, gaps: GAPS, advisors: CANDIDATES, relations: RELATIONS};

  const all = rankAdvisors({...input, limit: 10});
  const top5 = rankAdvisors(input);
  const top2 = rankAdvisors({...input, limit: 2});

  assert.deepEqual(all.map(r => [r.id, r.score]), [['T-A', 100], ['T-D', 64], ['T-B', 44], ['T-C', 24], ['T-E', 16], ['T-G', 12]]);
  assert.ok(!all.some(r => r.id === 'T-F'));
  assert.deepEqual(top5.map(r => r.id), ['T-A', 'T-D', 'T-B', 'T-C', 'T-E'], '預設只取前 5 位');
  assert.deepEqual(top2.map(r => r.id), ['T-A', 'T-D']);
  assert.deepEqual(rankAdvisors({...input, required: [], gaps: []}), [], '比賽沒有技能需求時不推薦任何人');
});

test('rankAdvisors：同分時涵蓋項目較多者優先，再依編號排序', () => {
  const advisors = [{id: 'T-2', skills: skillMap('c')}, {id: 'T-3', skills: skillMap('C', 'D')}, {id: 'T-1', skills: skillMap('d')}];

  const ranked = rankAdvisors({required: ['c', 'd'], gaps: [], advisors, relations: RELATIONS});

  assert.deepEqual(ranked.map(r => [r.id, r.score, r.matches.length]), [['T-3', 50, 2], ['T-1', 50, 1], ['T-2', 50, 1]]);
});

test('recommendCourses：涵蓋越多缺口越前面，同分時完全相同優先於相近，並套用 limit', () => {
  const courses = [
    {id: 'K8', skills: skillMap('D')}, // 相近 1 項 → 0.5
    {id: 'K7', skills: skillMap('zzz')}, // 補不到任何缺口
    {id: 'K6', skills: skillMap('C')}, // 相近 1 項 → 0.5
    {id: 'K5', skills: skillMap('c')}, // 相同 1 項 → 1
    {id: 'K4', skills: skillMap('e')}, // 相同 1 項 → 1
    {id: 'K3', skills: skillMap('C', 'D')}, // 相近 2 項 → 1
    {id: 'K2', skills: skillMap('c', 'd')}, // 相同 2 項 → 2
    {id: 'K1', skills: skillMap('c', 'd', 'e')}, // 相同 3 項 → 3
  ];
  const input = {gaps: ['c', 'd', 'e'], courses, relations: RELATIONS};

  const all = recommendCourses({...input, limit: 10});
  const top6 = recommendCourses(input);
  const top3 = recommendCourses({...input, limit: 3});

  assert.deepEqual(all.map(r => [r.id, r.weight, r.covers.length]),
    [['K1', 3, 3], ['K2', 2, 2], ['K4', 1, 1], ['K5', 1, 1], ['K3', 1, 2], ['K6', 0.5, 1], ['K8', 0.5, 1]], '同樣 1 分：一項完全相同排在兩項相近之前');
  assert.deepEqual(all[4].covers, [{uri: 'c', level: 'related', via: 'C', relation: 'broader'}, {uri: 'd', level: 'related', via: 'D', relation: 'broader'}]);
  assert.deepEqual(top6.map(r => r.id), ['K1', 'K2', 'K4', 'K5', 'K3', 'K6'], '預設只取前 6 門');
  assert.deepEqual(top3.map(r => r.id), ['K1', 'K2', 'K4']);
  // 學生已經「相近」的缺口（partial）：只有教到完全相同技能的課才算補得上，只是相近的課不再推薦
  const partial = recommendCourses({...input, partial: new Set(['c', 'd']), limit: 10});
  assert.deepEqual(partial.map(r => [r.id, r.weight]), [['K1', 3], ['K2', 2], ['K4', 1], ['K5', 1]]);
  assert.deepEqual(recommendCourses({...input, gaps: []}), [], '沒有缺口就不推薦課程');
});

test('maskName：中文姓名保留姓氏與最後一個字，非中文姓名只留首字母', () => {
  assert.equal(maskName('王大明'), '王Ｏ明');
  assert.equal(maskName('李華'), '李Ｏ');
  assert.equal(maskName('歐陽志遠'), '歐ＯＯ遠');
  assert.equal(maskName('  王大明  '), '王Ｏ明', '前後空白不影響');
  assert.equal(maskName('John Smith'), 'J.');
  assert.equal(maskName('john smith'), 'J.');
  assert.equal(maskName(''), '');
  assert.equal(maskName('   '), '');
  assert.equal(maskName(null), '');
  assert.equal(maskName(undefined), '');
});
