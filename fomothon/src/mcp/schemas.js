// MCP 工具的參數與輸出 Schema（JSON Schema 子集，見 src/jsonschema.js）。
// 輸出 Schema 會在伺服器端先自我驗證，官方 SDK client 也會依此驗證 structuredContent。

export const str = (extra = {}) => ({type: 'string', ...extra});
export const int = (extra = {}) => ({type: 'integer', ...extra});
export const num = (extra = {}) => ({type: 'number', ...extra});
export const bool = () => ({type: 'boolean'});
export const arr = (items, extra = {}) => ({type: 'array', items, ...extra});
/** 物件 Schema；required 預設為全部欄位。輸出 Schema 不鎖 additionalProperties，保留之後擴充欄位的彈性。 */
export const obj = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required});
export const nullable = schema => ({...schema, type: [schema.type, 'null']});
/** 參數物件：不接受未宣告的欄位。 */
export const input = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});

export const SKILL_ID = str({pattern: '^SK-[A-Z]{2,3}-\\d{3}$', description: 'Skill 資料庫的技能 ID，例如 SK-WEB-004'});
export const COMPETITION_ID = str({pattern: '^C\\d{2}$', description: '競賽 ID，例如 C01（可用 list_competitions 查詢）'});
export const COURSE_CODE = str({pattern: '^[A-Z]{2}\\d{3}$', description: '課程代碼，例如 CS101'});

const STATUS = str({enum: ['verified', 'inferred', 'self_reported'], description: 'verified 已驗證／inferred 推估／self_reported 自述待驗證'});

export const skillRef = obj({skillId: str(), name: str()});

export const esco = nullable(obj({uri: str(), label: str(), match: str()}));

export const skillSummary = obj({
  skillId: str(), name: str(), nameEn: str(), category: str(), parentId: nullable(str()), esco,
});

export const skillDetail = obj({
  ...skillSummary.properties,
  scale: str({enum: ['score', 'cefr']}),
  parent: nullable(skillRef),
  children: arr(skillRef),
  related: arr(obj({skillId: str(), name: str(), weight: num(), via: str()})),
  mappings: obj({esco, onetUnspsc: nullable(str()), sfia: nullable(str()), ucan: nullable(str())}),
  levels: arr(obj({label: str(), min: nullable(num()), max: nullable(num())})),
  taughtBy: arr(obj({courseCode: str(), name: str(), coverage: num()})),
  requiredBy: arr(obj({competitionId: str(), name: str(), required: str(), weight: int()})),
});

export const profile = obj({
  student: obj({studentId: str(), name: str(), dept: nullable(str()), year: nullable(str())}),
  state: str({enum: ['none', 'draft', 'confirmed']}),
  stale: bool(),
  confirmedAt: nullable(str()),
  skills: arr(obj({
    skillId: str(), name: str(), level: str(), status: STATUS, kept: bool(), note: nullable(str()),
    evidence: arr(obj({type: str(), title: str(), status: STATUS, level: nullable(str()), isBasis: bool(), courseCode: nullable(str())})),
  })),
  pending: arr(obj({skillId: str(), name: str(), evidenceCount: int()})),
});

export const competitionItem = obj({
  competitionId: str(), name: str(), type: str(), deadline: str({format: 'date'}), daysLeft: int(), open: bool(), description: str(),
  depts: nullable(arr(str())), teamMin: int(), teamMax: int(), advisorRequired: bool(),
  needs: arr(obj({skillId: str(), name: str(), required: str(), weight: int()})),
});

export const analysis = obj({
  competitionId: str(), name: str(), type: str(), deadline: str(),
  eligible: bool(),
  eligibilityChecks: arr(obj({label: str(), ok: bool()})),
  notes: arr(str()),
  fit: obj({
    total: int({minimum: 0, maximum: 100}),
    partial: bool(),
    parts: obj({theme: num(), gapFill: num(), difficulty: nullable(num()), timing: num(), learn: num()}),
  }),
  needs: arr(obj({skillId: str(), name: str(), weight: int(), required: str(), current: str(), status: str({enum: ['met', 'weak', 'unverified', 'missing']})})),
  strengths: arr(str()),
  weaknesses: arr(str()),
  gaps: arr(obj({skillId: str(), name: str(), kind: str()})),
  reasons: arr(str()),
});

const stop = nullable(obj({reason: str(), message: str()}));

export const teammates = obj({
  skillId: str(), skillName: str(), status: str({enum: ['matched', 'insufficient', 'failed']}), validCount: int(),
  rounds: arr(obj({round: int(), mode: str(), label: str(), found: int(), duplicates: int(), validSoFar: int()})),
  stop,
  candidates: arr(obj({
    studentId: str(), name: str(), dept: nullable(str()), year: nullable(str()), bio: nullable(str()), level: nullable(str()),
    flags: arr(str()), matchScore: int(), valid: bool(), round: int(), reasons: arr(str()), covers: arr(skillRef),
  })),
});

export const advisors = obj({
  status: str({enum: ['matched', 'insufficient', 'failed']}), validCount: int(), targets: arr(str()), stop,
  candidates: arr(obj({
    teacherId: str(), name: str(), dept: nullable(str()), expertise: arr(str()), matchScore: int(), valid: bool(),
    reasons: arr(str()), toConfirm: arr(str()), quota: obj({used: int(), total: int()}),
  })),
});

export const dataQuality = obj({
  version: str(), today: str(), overall: num({minimum: 0, maximum: 100}), gate: str({enum: ['pass', 'fail']}), blocking: arr(str()),
  dimensions: arr(obj({key: str(), label: str(), score: num(), checks: int(), failedChecks: int()})),
  issues: arr(obj({id: str(), dimension: str(), severity: str({enum: ['error', 'warning']}), title: str(), failed: int(), checked: int(), samples: arr(str()), samplesHidden: bool()})),
  standardMapping: obj({skills: int(), esco: obj({exact: int(), broader: int(), narrower: int(), related: int(), none: int()}), onetUnspsc: int(), sfia: int(), ucan: int()}),
});
