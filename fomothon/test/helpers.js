// 測試共用：以記憶體資料庫建立完整系統，並提供「把任務跑到底」的小幫手。
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';

export const TODAY = '2026-11-21';
export const baseEnv = {FOMO_DB_PATH: ':memory:', FOMO_SYLLABUS_MODE: 'local', FOMO_TODAY: TODAY};

export async function makeApp(overrides = {}, env = {}) {
  return createApp(loadConfig({...baseEnv, ...env}), overrides);
}

export const student = id => ({id, role: 'student', name: id});

const TERMINAL = new Set(['completed', 'stopped', 'blocked', 'cancelled', 'clarify']);

/**
 * 啟動任務並自動推進；遇到人工確認時由 decide 決定怎麼回覆。
 * 預設：確認能力檔案（全部保留）、邀請全部可邀請對象。
 */
export async function drive(app, user, goal, {faults, decide} = {}) {
  const o = app.orchestrator;
  let snap = await o.createRun(user, goal, {faults});
  for (let i = 0; i < 40 && !TERMINAL.has(snap.status); i += 1) {
    if (snap.status === 'awaiting_user') {
      const answer = decide?.(snap) ?? (snap.pending.type === 'confirm_profile'
        ? {type: 'confirm_profile'}
        : {type: 'confirm_invites', selected: snap.summary.invitable.map(x => ({kind: x.kind, id: x.id}))});
      if (answer === 'stop') return snap;
      snap = o.confirm(user, snap.id, answer);
    } else {
      snap = await o.step(user, snap.id);
    }
  }
  return o.getRun(user, snap.id);
}

export const eventsOf = (snap, type) => snap.events.filter(e => e.type === type);
