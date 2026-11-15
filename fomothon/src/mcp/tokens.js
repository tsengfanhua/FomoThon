// MCP 個人存取權杖（Streamable HTTP 用）：每人一把、有期限、可撤銷；資料庫只存雜湊，原文只在核發時顯示一次。
import {audit, getUser} from '../db.js';
import {AppError, nowIso, randomToken, sha256} from '../util.js';

const TOKEN_PREFIX = 'fmcp_';
const MS_PER_DAY = 86_400_000;
const MAX_DAYS = 90;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createTokenStore(db) {
  /**
   * 核發權杖。
   * @param {string} userId
   * @param {{days?: number, label?: string|null}} [opts]
   * @returns {{id:string, token:string, userId:string, expiresAt:string}}
   */
  function issue(userId, {days = 30, label = null} = {}) {
    const user = getUser(db, userId);
    if (!user) throw new AppError('NOT_FOUND', `帳號不存在：${userId}`, 404);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new AppError('INVALID_INPUT', `有效天數必須是 1～${MAX_DAYS} 的整數`);
    const id = `MT-${randomToken(6)}`;
    const token = `${TOKEN_PREFIX}${randomToken(32)}`;
    const expiresAt = new Date(Date.now() + days * MS_PER_DAY).toISOString();
    db.prepare('INSERT INTO mcp_tokens (id, user_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, user.id, sha256(token), label, nowIso(), expiresAt);
    audit(db, user.id, 'mcp_token_issued', id, {days});
    return {id, token, userId: user.id, expiresAt};
  }

  /** 驗證權杖；無效、過期或已撤銷都回傳 null。 */
  function verify(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
    const row = db.prepare('SELECT id, user_id, expires_at, revoked FROM mcp_tokens WHERE token_hash = ?').get(sha256(token));
    if (!row || row.revoked || row.expires_at < nowIso()) return null;
    db.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
    const user = getUser(db, row.user_id);
    return user ? {user, tokenId: row.id} : null;
  }

  function revoke(id) {
    const changed = db.prepare('UPDATE mcp_tokens SET revoked = 1 WHERE id = ? AND revoked = 0').run(id).changes;
    if (changed) audit(db, null, 'mcp_token_revoked', id);
    return changed > 0;
  }

  const list = () => db.prepare('SELECT id, user_id AS userId, label, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked FROM mcp_tokens ORDER BY created_at')
    .all().map(r => ({...r, revoked: Boolean(r.revoked)}));

  return Object.freeze({issue, verify, revoke, list});
}
