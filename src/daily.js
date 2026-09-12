// daily.js — 每日随机系统："今天的她"
// 每天第一次被访问时，用"日期+人设指纹"做种子的确定性随机生成她的一天：
// 性格（六维）与行为参数（persona.behavior）自动定基调——秩序感高波动小、夜猫人设作息晚，
// 偶发熬通宵/出门办事等意外事件。同一天内结果一致（重启/重读不变），像真人一样每天都有点不同。

import fs from 'node:fs';
import path from 'node:path';
import { JOB_TYPES } from './job.js';
export { JOB_TYPES };

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hmAdd(hmStr, deltaMin) {
  const p = String(hmStr || '07:30').split(':');
  let m = Number(p[0]) * 60 + Number(p[1] || 0) + deltaMin;
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
const hm2min = (s) => { const p = String(s || '0:0').split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); };
const min2hm = (m) => { const x = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };

function dayKey(now) {
  const y = now.getFullYear(); const m = String(now.getMonth() + 1).padStart(2, '0'); const d = String(now.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/** 生成（或取回）"今天的她"。companionDir=数据目录，persona=当前人设。 */export function todayState(companionDir, persona, now = new Date()) {
  const file = path.join(companionDir, 'daily-state.json');
  const key = dayKey(now);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (prev && prev.date === key) return prev;

  const traits = persona.traits || {};
  const B = persona.behavior || {};
  const seed = hashStr(key + '|' + (persona.name || '') + '|' + String(persona.assessments ? persona.assessments.mbti || '' : ''));
  const rnd = mulberry32(seed);
  const isWeekend = [0, 6].includes(now.getDay());

  // 秩序感 → 波动幅度：秩序感高（J）波动小，低（P）天天乱
  const orderV = traits.orderliness == null ? 50 : traits.orderliness;
  const jitterScale = 1.4 - (orderV / 100) * 0.9;
  const jitter = Math.round((B.jitterMin == null ? 45 : B.jitterMin) * jitterScale);

  // 世界引擎接入：她昨晚睡着后，世界引擎已经为今天排好了剧本（作息/心情/痴迷）
  let world = null;
  let wsAny = null;
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(companionDir, 'world-state.json'), 'utf8'));
    wsAny = ws;
    if (ws && ws.forDate === key) world = ws;
  } catch {}

  const hmOk = (s) => /^\d{1,2}:\d{2}$/.test(String(s || ''));
  // 第三次改版：生活节奏以世界引擎推断的为准（覆盖后台设置）；它没推过就用后台的值
  const wr = (wsAny && wsAny.tone && wsAny.tone.rhythm) || null;
  const R = wr ? {
    baseWake: hmOk(wr.baseWake) ? wr.baseWake : (B.baseWake || '07:30'),
    baseSleep: hmOk(wr.baseSleep) ? wr.baseSleep : (B.baseSleep || '23:30'),
    weekendShiftMin: (wr.weekendShiftMin == null ? B.weekendShiftMin : wr.weekendShiftMin),
    nightOwlProb: (wr.nightOwlProb == null ? B.nightOwlProb : wr.nightOwlProb),
    allNighterProb: (wr.allNighterProb == null ? B.allNighterProb : wr.allNighterProb),
  } : B;
  const rhythmFrom = wr ? 'world' : 'config';
  const rhythmNote = [];
  if (wr) {
    if (hmOk(wr.baseWake) && wr.baseWake !== B.baseWake) rhythmNote.push('基准起床 ' + (B.baseWake || '—') + ' → ' + wr.baseWake);
    if (hmOk(wr.baseSleep) && wr.baseSleep !== B.baseSleep) rhythmNote.push('基准睡觉 ' + (B.baseSleep || '—') + ' → ' + wr.baseSleep);
  }

  let allNighter = false, nightOwl = false, worldAuthored = false;
  let wake = R.baseWake || '07:30';
  let sleep = R.baseSleep || '23:30';
  if (world && (hmOk(world.wake) || hmOk(world.sleep))) {
    // 世界引擎定的今天：作息照剧本走（剧情熬夜→赖床，都写进时间里了）
    worldAuthored = true;
    if (hmOk(world.wake)) wake = world.wake;
    if (hmOk(world.sleep)) sleep = world.sleep;
  } else {
    allNighter = rnd() < (R.allNighterProb == null ? 0.03 : R.allNighterProb);
    nightOwl = !allNighter && rnd() < (R.nightOwlProb == null ? 0.15 : R.nightOwlProb);
    // 周末赖床：设的是上限，实际每天在 30%~100% 之间随机
    const weekendShift = isWeekend ? Math.round((R.weekendShiftMin == null ? 60 : R.weekendShiftMin) * (0.3 + rnd() * 0.7)) : 0;
    if (allNighter) {
      sleep = hmAdd(sleep, 240 + Math.round(rnd() * 180));
      wake = hmAdd(wake, 300 + Math.round(rnd() * 120));
    } else {
      wake = hmAdd(wake, weekendShift + Math.round((rnd() * 2 - 1) * jitter));
      sleep = hmAdd(sleep, (nightOwl ? 60 + Math.round(rnd() * 120) : 0) + Math.round((rnd() * 2 - 1) * jitter));
    }
  }

  /* ── 职业形状 ──────────────────────────────────────────────────────────
     职业只决定"形状"（今天上不上班、几点起、几点睡、忙不忙），
     幅度/强度由性格与配置里的「职业影响强度」决定。世界引擎写了剧本时以剧本优先。 */
  // 职业参数优先级：世界引擎昨晚给它排的（最懂她的生活）→ 保存职业时推断的 → 没启用
  const wJob = (world && world.job && JOB_TYPES[world.job.type]) ? world.job : null;
  const cfgJob = persona.__job || null;
  const jSrc = wJob ? { ...cfgJob, ...wJob, source: 'world' } : cfgJob;
  const J = (jSrc && jSrc.enabled !== false && jSrc.toSchedule !== false) ? jSrc : null;
  const jt = J ? (JOB_TYPES[J.type] || JOB_TYPES.none) : JOB_TYPES.none;
  const workDays = String((J && J.workDays) || '1,2,3,4,5').split(',').map((x) => Number(String(x).trim())).filter((x) => !isNaN(x));
  const isWorkday = !!J && (J.type === 'night' ? rnd() < (jt.workProb || 0) : (workDays.includes(now.getDay()) && (!isWeekend || J.type === 'shift' || J.type === 'freelance') && rnd() < (jt.workProb == null ? 1 : jt.workProb)));
  const jobIntensity = J && typeof J.intensity === 'number' ? Math.max(0, Math.min(2, J.intensity)) : 1;
  if (J && isWorkday && !world) {
    if (jt.wakeEarly) wake = min2hm(hm2min(wake) + jt.wakeEarly * jobIntensity + (rnd() * 2 - 1) * Math.round(jitter / 2));
    if (jt.sleepLate) sleep = min2hm(hm2min(sleep) + jt.sleepLate * jobIntensity + (rnd() * 2 - 1) * Math.round(jitter / 2));
    if (J.type === 'night') { nightOwl = true; }
  }

  const prevMood = prev && typeof prev.mood === 'number' ? prev.mood : 60;
  const moodBase = world && typeof world.mood === 'number' ? world.mood : prevMood;
  const mood = Math.round(Math.min(95, Math.max(20, moodBase + (rnd() * 2 - 1) * (world ? 6 : 14))));
  const chatter = Math.round((0.7 + rnd() * 0.6) * 100) / 100;
  const speedState = Math.round((0.8 + rnd() * 0.5) * 100) / 100;
  const interests = persona.interests || [];
  const focus = (world && world.focus) || (interests.length ? interests[Math.floor(rnd() * interests.length)] : '');

  const busyBase = 0.08;
  const busyDay = rnd() < (busyBase + (J && isWorkday ? (jt.busy || 0) * 0.5 * jobIntensity : 0));
  const events = [];
  if (J && isWorkday) events.push('今天是' + (jt.tag || '工作日'));
  if (allNighter) events.push('熬了个通宵');
  else if (nightOwl) events.push('今晚有点兴奋');
  if (isWeekend) events.push('周末');
  if (busyDay) events.push('今天出门办事');
  if (mood >= 75) events.push('今天心情很好');
  if (mood <= 35) events.push('今天有点低落');

  // 六维每日弹性（有因果、围绕基准回弹）：事件和心情决定漂移方向，不是乱摇。
  // 只动"今天的六维"，人设基准与MBTI八维推导永不变——像情绪围绕性格波动。
  const nz = () => Math.round((rnd() * 2 - 1) * 3);
  const dr = { socialBattery: nz(), warmth: nz(), attachment: nz(), sharpness: nz(), initiative: nz(), orderliness: nz() };
  if (allNighter) { dr.socialBattery -= 8 + Math.round(rnd() * 6); dr.sharpness -= 3; }
  if (mood >= 75) dr.warmth += 4 + Math.round(rnd() * 4);
  if (mood <= 35) { dr.attachment += 3 + Math.round(rnd() * 3); dr.sharpness += 2; }
  if (isWeekend) dr.initiative += 3 + Math.round(rnd() * 3);
  if (busyDay) dr.socialBattery -= 5 + Math.round(rnd() * 5);
  // 工作日的消耗：社交电量按"职业影响强度"和性格放大（秩序感低的人更被工作打乱）
  if (J && isWorkday) {
    const jScale = jobIntensity * (0.7 + (100 - (traits.orderliness == null ? 50 : traits.orderliness)) / 200);
    dr.socialBattery -= Math.round((3 + rnd() * 3) * jScale);
    dr.initiative -= Math.round(2 * jScale);
  }
  for (const k of Object.keys(dr)) dr[k] = Math.max(-15, Math.min(15, dr[k]));

  // 今日电量由"漂移后的社交电量"决定（六维驱动行为）
  const baseB = traits.socialBattery == null ? 50 : traits.socialBattery;
  const battery = Math.round(Math.min(95, Math.max(10, baseB + dr.socialBattery + (rnd() * 2 - 1) * 10)));
  // 发起力驱动主动频率（六维驱动行为）：发起力高今天更爱找你
  const iniV = (traits.initiative == null ? 50 : traits.initiative) + dr.initiative;
  const activeToday = Math.max(0, Math.round((B.activePerDay == null ? 3 : B.activePerDay) * (0.5 + rnd() * 0.9) * (0.7 + (iniV / 100) * 0.6)));

  const state = {
    date: key, wake, sleep, allNighter, nightOwl, weekend: isWeekend, busyDay,
    mood, chatter, speedState, battery, activeToday, focus, events, worldAuthored, traitDrift: dr,
    rhythmFrom: rhythmFrom, rhythmNote: rhythmNote,
    job: J ? { type: J.type, label: jt.label, workday: !!isWorkday, intensity: jobIntensity, workStart: J.workStart || '', workEnd: J.workEnd || '', source: J.source || (cfgJob ? 'config' : '') } : null,
    generatedAt: Date.now(),
  };
  fs.mkdirSync(companionDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/* ── 当天事件驱动的六维弹性 ──────────────────────────────────────────────
 * 上面那层是"早上定调"（睡得好不好/周末/忙日）；这一层是"白天发生了就飘"：
 * 被凶了当天就话少、被哄了当天就暖，强度由她的性格决定（同一个事件，依恋高的人更疼）。
 * 累计进当天的 traitDrift（上限 ±15），第二天由 todayState 重新生成 → 自然回弹。
 * 这是"她是活的"的关键：不用等到每周结算才变化。
 */
const DAY_EVENT = {
  warm: { label: '被哄/被宠', d: { warmth: 2, attachment: 1, socialBattery: 1 } },
  rude: { label: '被凶/被怼', d: { socialBattery: -4, warmth: -3, sharpness: 2 }, mod: (T) => 0.7 + (T.attachment == null ? 50 : T.attachment) / 160 },
  conflict: { label: '吵架/冲突', d: { warmth: -4, sharpness: 3, socialBattery: -3 }, mod: (T) => 0.7 + (T.sharpness == null ? 50 : T.sharpness) / 160 },
  ignored: { label: '被冷落（她催你没人回）', d: { attachment: 3, warmth: -2, socialBattery: -2 }, mod: (T) => 0.7 + (T.attachment == null ? 50 : T.attachment) / 160 },
  work: { label: '被工作压垮', d: { socialBattery: -5, initiative: -2, warmth: -1 }, mod: (T) => 0.7 + (T.orderliness == null ? 50 : (100 - T.orderliness)) / 160 },
  rest: { label: '睡得好/缓过来了', d: { socialBattery: 5, warmth: 2, sharpness: -1 } },
  good: { label: '今天过得不错', d: { warmth: 2, initiative: 2, socialBattery: 2 } },
};

/** 事件中文名（后台展示用） */
export const DAY_EVENT_LABEL = Object.fromEntries(Object.entries(DAY_EVENT).map(([k, v]) => [k, v.label]));

/**
 * 把一次"当天发生的事"折算成今天六维的浮动，写回 daily-state.json。
 * @returns {{applied:object,label:string,traitDrift:object}|null}
 */
export function applyDayEvent(companionDir, kind, traits = {}, opts = {}) {
  const spec = DAY_EVENT[kind];
  if (!spec) return null;
  const file = path.join(companionDir, 'daily-state.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!st || !st.date) return null;
  const mult = (spec.mod ? spec.mod(traits) : 1) * (opts.intensity == null ? 1 : opts.intensity);
  const dr = { ...(st.traitDrift || {}) };
  const applied = {};
  for (const [k, v] of Object.entries(spec.d)) {
    const delta = Math.round(v * mult);
    if (!delta) continue;
    dr[k] = Math.max(-15, Math.min(15, Math.round((dr[k] || 0) + delta)));
    applied[k] = delta;
  }
  st.traitDrift = dr;
  const log = Array.isArray(st.driftReasons) ? st.driftReasons.slice(-19) : [];
  log.push({ at: Date.now(), kind, label: spec.label, deltas: applied, note: String(opts.note || '').slice(0, 60) });
  st.driftReasons = log;
  // 今日电量跟着社交电量走（六维驱动行为：她今天还剩多少力气说话）
  const baseB = traits.socialBattery == null ? 50 : traits.socialBattery;
  st.battery = Math.round(Math.min(95, Math.max(10, baseB + (dr.socialBattery || 0))));
  try { fs.writeFileSync(file, JSON.stringify(st, null, 2), 'utf8'); } catch { return null; }
  return {
    applied, label: spec.label, traitDrift: dr, battery: st.battery };
}
