// 共用小工具（純函式）。
import crypto from 'node:crypto';

const MS_PER_DAY = 86_400_000;

export const sum = list => list.reduce((acc, v) => acc + v, 0);
export const mean = list => (list.length ? sum(list) / list.length : 0);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round1 = v => Math.round(v * 10) / 10;
export const nowIso = () => new Date().toISOString();
export const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

export function decodeHtml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** 可固定「今天」的時鐘，讓截止日計算在評測與展示時可重現。 */
export function createClock(todayStr = null) {
  const today = () => (todayStr ? new Date(`${todayStr}T00:00:00`) : new Date(new Date().toDateString()));
  return Object.freeze({
    today,
    todayStr: () => {
      const d = today();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    daysUntil: dateStr => Math.round((new Date(`${dateStr}T00:00:00`) - today()) / MS_PER_DAY),
  });
}

/** 執行編號：R-月日-流水號（流水號取自亂數，避免可預測）。 */
export function newRunId(clock) {
  const [, mm, dd] = clock.todayStr().split('-');
  return `R-${mm}${dd}-${crypto.randomBytes(3).toString('hex')}`;
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
