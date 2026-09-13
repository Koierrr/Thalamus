// body-state.js —— 她的身体（批 E3 / A10）
//
// 两块：
//   ① 生理期引擎（纯代码，个体化）：每个"她"的周期长度、经期天数、锚点相位、
//      经期感受都由建档时的随机 salt + 人设指纹决定 —— 不同个体的相位必然散开，
//      不会所有人同一天来。锚点随机回溯，且此前她的身体从未在对话/记忆/剧本里出现过，
//      所以任意锚点都与历史自洽（这一点写进 createdNote，后台可见）。
//   ② 身体视图（唯一派生源）：把"生理期 + 世界引擎昨晚写的日常身体"合成一个对象，
//      下游（电量与六维折算、提示词身体行、发前自检）都只读它，不各自再算一套。
//
// 底线（写进提示词）：身体差只是身体差 —— 不改变她喜不喜欢你、不改【今天的分寸】，
// 心情值不被身体字段污染（两个源彻底分开，防"一来例假就冷若冰霜"的机械感）。
import fs from 'node:fs';
import path from 'node:path';
import { hashStr, mulberry32 } from './daily.js';

export const DISCLOSURE_TIERS = [30, 60, 80];      // 常量阈值，与【今天的分寸】同源同值

const PERIOD_NOTES = ['怕冷、想吃甜的、容易犯困', '肚子坠坠的、懒得动、想喝热的', '腰有点酸、脾气比平时急一点', '没什么力气、只想窝着'];
const PRE_NOTES = ['有点烦躁、看什么都想怼两句', '心里发闷、容易想多', '困但睡不踏实、一点就炸', '说不上哪不对，反正不太顺'];

function dayKeyOf(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function dateFromKey(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function diffDays(aKey, bKey) {
  const a = dateFromKey(aKey); const b = dateFromKey(bKey);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function bodyStateFile(dir) { return path.join(dir, 'body-state.json'); }

/** 总开关：默认开（config.body.enabled !== false） */
export function bodyEnabled(dir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (cfg && cfg.body && cfg.body.enabled === false) return false;
  } catch { /* 没配置就是默认开 */ }
  return true;
}

/** 建档（幂等）：文件在就原样返回 */
export function ensureState(dir, personaFingerprint) {
  const f = bodyStateFile(dir);
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (cur && cur.version === 1 && cur.anchor) return cur;
  } catch { /* 需要建档 */ }
  const salt = Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const rng = mulberry32(hashStr(salt + '|' + String(personaFingerprint || '')) >>> 0);
  const cycleDays = 26 + Math.floor(rng() * 7);          // 26~32
  const periodLen = 3 + Math.floor(rng() * 3);           // 3~5
  const back = Math.floor(rng() * cycleDays);            // 锚点随机回溯 0~cycleDays 天
  const periodNote = PERIOD_NOTES[Math.floor(rng() * PERIOD_NOTES.length)];
  const preNote = PRE_NOTES[Math.floor(rng() * PRE_NOTES.length)];
  const anchorDate = new Date(Date.now() - back * 86400000);
  const st = {
    version: 1,
    salt,
    cycleDays,
    periodLen,
    anchor: dayKeyOf(anchorDate),
    periodNote,
    preNote,
    createdAt: Date.now(),
    createdNote: '建档：周期长度与锚点由建档时的随机 salt 决定、终生固定；锚点随机回溯到 ' + dayKeyOf(anchorDate)
      + '。此前她的身体从未在对话、记忆或世界剧本里出现过，所以任意锚点都与既有历史自洽。',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = f + '.tmp-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 写不进去就算了，下次再建 */ }
  return st;
}

/** 周期推演：纯函数，任何日期都能算（未来日期也可以） */
export function periodFor(state, dateKey) {
  if (!state || !state.cycleDays || !state.anchor) return null;
  const d = diffDays(state.anchor, dateKey);
  const cycleDays = Math.max(1, Number(state.cycleDays) || 28);
  const periodLen = Math.max(1, Number(state.periodLen) || 4);
  const cycleDay = ((d % cycleDays) + cycleDays) % cycleDays + 1;
  const phase = cycleDay <= periodLen ? 'menstrual' : (cycleDay > cycleDays - 4 ? 'premenstrual' : 'mid');
  const note = phase === 'menstrual' ? (state.periodNote || '') : (phase === 'premenstrual' ? (state.preNote || '') : '');
  return { cycleDay, phase, note };
}

/** 披露档位：由熟度一个数决定（与【今天的分寸】同源），只有一把尺子 */
export function disclosureTier(intimacy) {
  const n = Number(intimacy) || 0;
  if (n < DISCLOSURE_TIERS[0]) return 1;
  if (n < DISCLOSURE_TIERS[1]) return 2;
  if (n < DISCLOSURE_TIERS[2]) return 3;
  return 4;
}

/**
 * 身体视图（唯一派生源）。
 * 返回 { period, daily, lowEnergy, disclosureTier, note } 或 null（总开关关掉时）。
 */
export function bodyView({ dir, today, world, intimacy } = {}) {
  if (!bodyEnabled(dir)) return null;
  const st = ensureState(dir, (today && today.__fingerprint) || '');
  const dateKey = (today && today.date) || dayKeyOf(new Date());
  const p = periodFor(st, dateKey);
  const period = p ? { cycleDay: p.cycleDay, phase: p.phase, note: p.note } : null;
  const wb = (world && world.body && String(world.body.forDate || '') === String(dateKey)) ? world.body : null;
  const daily = wb ? { sleep: wb.sleep || '一般', ailment: wb.ailment || '没有', note: wb.note || '' } : null;
  const firstTwo = !!(period && period.phase === 'menstrual' && period.cycleDay <= 2);
  const badSleep = !!(daily && (daily.sleep === '没睡好' || daily.sleep === '熬了夜'));
  const ail = !!(daily && daily.ailment && daily.ailment !== '没有');
  const lowEnergy = firstTwo || badSleep || ail;
  const bits = [];
  if (period && period.phase === 'menstrual') bits.push('生理期第 ' + period.cycleDay + ' 天' + (period.note ? '（' + period.note + '）' : ''));
  else if (period && period.phase === 'premenstrual') bits.push('经前期' + (period.note ? '（' + period.note + '）' : ''));
  if (badSleep) bits.push('昨晚' + (daily.sleep === '熬了夜' ? '熬夜了' : '没睡好'));
  else if (daily && daily.sleep === '睡得不错') bits.push('昨晚睡得不错');
  if (ail) bits.push(daily.ailment);
  return {
    period,
    daily,
    lowEnergy,
    disclosureTier: disclosureTier(intimacy),
    note: bits.join('；'),
    source: wb ? 'world' : 'none',
  };
}

/**
 * 身体对"电量与六维"的折算（在 todayState 现有计算上追加）。
 * 全部走既有管道（电量→少主动、电量→慢打字），不新增任何机制。
 */
export function bodyEffects(body) {
  const out = { battery: 0, dr: {}, activeMul: 1 };
  if (!body) return out;
  const p = body.period;
  if (p && p.phase === 'menstrual') {
    if (p.cycleDay <= 2) {
      out.battery -= 12;
      out.dr.socialBattery = (out.dr.socialBattery || 0) - 6;
      out.dr.warmth = (out.dr.warmth || 0) - 2;
      out.dr.sharpness = (out.dr.sharpness || 0) + 2;
      out.activeMul *= 0.6;
    } else {
      out.battery -= 6;
      out.dr.socialBattery = (out.dr.socialBattery || 0) - 3;
    }
  } else if (p && p.phase === 'premenstrual') {
    out.battery -= 5;
    out.dr.attachment = (out.dr.attachment || 0) + 2;
    out.dr.socialBattery = (out.dr.socialBattery || 0) - 3;
  }
  const d = body.daily;
  if (d && (d.sleep === '没睡好' || d.sleep === '熬了夜')) {
    out.battery -= 8;
    out.dr.sharpness = (out.dr.sharpness || 0) - 2;   // 没睡好是钝，不是凶
  }
  if (d && d.ailment && d.ailment !== '没有') out.battery -= 5;
  return out;
}

const TIER_TEXT = {
  1: '- 熟度 <30：身体的事一个字都不提。他要是问，就说"没事"。',
  2: '- 熟度 30~59：最多说"今天不太舒服/想早点休息"，**不许说部位和原因**。',
  3: '- 熟度 60~79：可以说"这几天身体不太爽利/胃有点闹脾气"这一级，但不说破生理期。',
  4: '- 熟度 80 以上：可以半开玩笑地说"老朋友来了，想躺一天"这一级；他问起也可以承认。',
};

/**
 * 提示词里的身体行（soul 在【你今天的状态】之后追加）。
 * 没有任何身体情况时返回空字符串 —— 不加空话。
 */
export function bodyPromptLine(body, intimacy) {
  if (!body) return '';
  const hasSomething = !!(body.period && body.period.phase !== 'mid') || !!body.lowEnergy;
  if (!hasSomething) return '';
  const NL = String.fromCharCode(10);
  const parts = [];
  const p = body.period;
  if (p && p.phase === 'menstrual') parts.push('生理期第 ' + p.cycleDay + ' 天' + (p.note ? '（' + p.note + '）' : ''));
  else if (p && p.phase === 'premenstrual') parts.push('经前期' + (p.note ? '（' + p.note + '）' : ''));
  const d = body.daily;
  if (d && (d.sleep === '没睡好' || d.sleep === '熬了夜')) parts.push('昨晚' + (d.sleep === '熬了夜' ? '熬了夜' : '没睡好'));
  if (d && d.ailment && d.ailment !== '没有') parts.push(d.ailment + (d.note ? '（' + d.note + '）' : ''));
  if (!parts.length) return '';
  const tier = disclosureTier(intimacy);
  return '【你的身体（只能从这里来，绝不许新增别的症状、日期或数字）】' + NL
    + parts.join('；') + '。' + NL
    + '这是身体状态，**不是心情变坏**：你对他的态度仍然完全按【今天的分寸】来。' + NL
    + (body.lowEnergy ? '今天电量低：话更短、少主动、能懒着说就不精神地说。' + NL : '')
    + '【对身体能说到哪一层（按你们现在的熟度）】' + NL
    + TIER_TEXT[tier];
}
