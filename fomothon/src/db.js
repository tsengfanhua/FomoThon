// SQLite（Node 內建 node:sqlite，無原生相依套件）。
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ROOT, readSeed} from './config.js';
import {nowIso} from './util.js';

const SCHEMA = fs.readFileSync(path.join(ROOT, 'src', 'schema.sql'), 'utf8');

/**
 * @param {string} dbPath 檔案路徑，或 ':memory:'
 * @returns {DatabaseSync}
 */
export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), {recursive: true});
  const db = new DatabaseSync(dbPath);
  // 網頁伺服器與 MCP stdio 伺服器可能同時開啟同一個資料庫檔：遇到鎖定時等待，而不是立刻失敗
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

// 交易可巢狀：已在交易中時，內層直接併入外層（由外層統一提交或回復）。
const depth = new WeakMap();

/** 以交易包住一段同步寫入；失敗時回復。 */
export function transaction(db, fn) {
  if (depth.get(db)) return fn();
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

/**
 * 非同步版本，只用於啟動時的種子資料建置（此時伺服器尚未接受請求）。
 * 整段建置是單一交易：中途失敗或程序被中斷，資料庫不會留下半成品。
 */
export async function transactionAsync(db, fn) {
  db.exec('BEGIN');
  depth.set(db, 1);
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export const isSeeded = db => db.prepare('SELECT COUNT(*) AS n FROM skills').get().n > 0;

/**
 * 載入種子資料（技能庫、課程、人物、競賽）。學生證據與 Profile 由能力盤點模組另行建立。
 * @param {object} [bundle] 已讀入（且通過資料品質閘門）的種子資料；省略時直接讀檔
 */
export function loadSeed(db, bundle = null) {
  const skillSeed = bundle?.skills ?? readSeed('skills');
  const courseSeed = bundle?.courses ?? readSeed('courses');
  const people = bundle?.people ?? readSeed('people');
  const compSeed = bundle?.competitions ?? readSeed('competitions');

  transaction(db, () => {
    const insSkill = db.prepare('INSERT INTO skills (id, zh, en, category, parent_id, scale, aliases, ext) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of skillSeed.skills) {
      const ext = {
        esco: s.esco ? {...s.esco, uri: skillSeed._meta.escoBase + s.esco.id} : null,
        onetUnspsc: s.onetUnspsc ?? null,
        sfia: s.sfia ?? null,
        ucan: s.ucan ?? null,
      };
      insSkill.run(s.id, s.zh, s.en, s.category, s.parent ?? null, s.scale ?? 'score', JSON.stringify(s.aliases), JSON.stringify(ext));
    }
    const insRel = db.prepare('INSERT INTO skill_relations (a, b, weight) VALUES (?, ?, ?)');
    for (const [a, b, w] of skillSeed.relations) insRel.run(a, b, w);

    const insUser = db.prepare('INSERT INTO users (id, role, name, dept, attrs) VALUES (?, ?, ?, ?, ?)');
    for (const s of people.students) {
      const {id, name, dept, enrollments, evidence, ...attrs} = s;
      insUser.run(id, 'student', name, dept, JSON.stringify(attrs));
    }
    for (const t of people.teachers) {
      const {id, name, dept, ...attrs} = t;
      insUser.run(id, 'teacher', name, dept, JSON.stringify(attrs));
    }
    for (const a of people.admins) insUser.run(a.id, 'admin', a.name, a.dept, '{}');

    const insCourse = db.prepare('INSERT INTO courses (code, name, dept, credits, teacher_id, syllabus) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of courseSeed.courses) {
      const syllabus = {objectives: c.objectives, weeks: c.weeks, assessments: c.assessments};
      insCourse.run(c.code, c.name, c.dept, c.credits, c.teacherId, JSON.stringify(syllabus));
    }

    const insEnroll = db.prepare('INSERT INTO enrollments (student_id, course_code, course_name, semester, grade, verified) VALUES (?, ?, ?, ?, ?, 1)');
    const courseName = new Map(courseSeed.courses.map(c => [c.code, c.name]));
    for (const s of people.students) {
      for (const e of s.enrollments) {
        insEnroll.run(s.id, e.code ?? null, e.code ? courseName.get(e.code) : e.name, e.semester ?? null, e.grade);
      }
    }

    const insComp = db.prepare('INSERT INTO competitions (id, name, type, deadline, data) VALUES (?, ?, ?, ?, ?)');
    for (const c of compSeed.competitions) {
      const {id, name, type, deadline, ...data} = c;
      insComp.run(id, name, type, deadline, JSON.stringify(data));
    }
  });
  return {students: people.students};
}

export function audit(db, userId, action, target = null, detail = null) {
  db.prepare('INSERT INTO audit (ts, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(nowIso(), userId ?? null, action, target, detail === null ? null : JSON.stringify(detail));
}

/** 系統中所有學生與教師的姓名（送往雲端模型前代號化用）。 */
export const listPersonNames = db => db.prepare("SELECT name FROM users WHERE role IN ('student', 'teacher')").all().map(r => r.name);

export function getUser(db, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? {id: row.id, role: row.role, name: row.name, dept: row.dept, ...JSON.parse(row.attrs)} : null;
}
