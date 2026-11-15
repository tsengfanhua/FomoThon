// 登入、Session 與角色權限（RBAC）。
// 原型使用示意帳號登入；對外部署時設定 FOMO_ACCESS_CODE，登入必須輸入存取碼（評審專用）。
import crypto from 'node:crypto';
import {audit, getUser} from './db.js';
import {AppError, nowIso, randomToken} from './util.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createAuth({db, config}) {
  function login(userId, accessCode) {
    if (config.accessCode && !sameSecret(accessCode ?? '', config.accessCode)) {
      audit(db, null, 'login_failed', userId ?? null);
      throw new AppError('UNAUTHORIZED', '存取碼不正確', 401);
    }
    const user = getUser(db, userId);
    if (!user) throw new AppError('UNAUTHORIZED', '帳號不存在', 401);
    const id = randomToken(32);
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, user.id, nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString());
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    audit(db, user.id, 'login');
    return {sessionId: id, user: publicUser(user)};
  }

  function logout(sessionId) {
    if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  /** @returns {object|null} 目前登入的使用者；Session 不存在或過期回傳 null */
  function userFor(sessionId) {
    if (!sessionId) return null;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE id = ?').get(sessionId);
    if (!row || row.expires_at < nowIso()) return null;
    return getUser(db, row.user_id);
  }

  const publicUser = user => ({id: user.id, role: user.role, name: user.name, dept: user.dept, year: user.year ?? null});

  /** 登入頁的示意帳號清單（僅代稱與角色）。 */
  function personas() {
    return db.prepare('SELECT id, role, name, dept, attrs FROM users ORDER BY role, id').all()
      .map(u => ({id: u.id, role: u.role, name: u.name, dept: u.dept, hint: JSON.parse(u.attrs).bio ?? null}));
  }

  return Object.freeze({login, logout, userFor, publicUser, personas, accessCodeRequired: Boolean(config.accessCode)});
}

/** 角色檢查：不符即 403。 */
export function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new AppError('FORBIDDEN', '你的角色沒有這項權限', 403);
}
