// longing.js —— 「你很久不来」的想念曲线（批 E3 / A11）
//
// 以前的做法是机械累积：她每天催你一次 → 压力 +15、依恋 +3。结果是"你越不来她越黏你"，
// 两周不回反而更热络——这离真人很远。用户原话：「两周不来都不积怨，那离人类很远了」。
//
// 改成：
//   ① **先升后降**：想念在第 1~3 天达到峰值，之后往下走（她会慢慢习惯你不在）。
//   ② **强度由依恋定**：依恋高的人峰值高、峰值来得晚一点。
//   ③ **参考她最近过得怎样**：她自己电量低、忙得脚不沾地时，想念会淡一些。
//   ④ **回来那一刻才算总账**：不再每天记一笔，等你真回来了，一次性结算这段缺席——
//      压力机（deform）只吃**这一次**的量，量由曲线给，不由"催过几次"给。
//
// 这个文件是纯函数：不碰网络、不碰磁盘，能直接测。
import { hashStr } from './daily.js';

/** 峰值出现的时间窗（天）：依恋越高越靠后 */
export const PEAK_MIN_DAYS = 1;
export const PEAK_MAX_DAYS = 3;
/** 越过峰值后的衰减时间常数（天）：约 4 天减到三分之一 */
export const FADE_TAU_DAYS = 4;

/**
 * 想念曲线。
 * @returns {{value:number, phase:'none'|'rising'|'peak'|'fading', days:number, peakDay:number}}
 *          value 0~1（0=没在想，1=最想）
 */
export function longingCurve({ absenceMs, attachment = 50, battery = 60, workload = 0 } = {}) {
  const days = Math.max(0, Number(absenceMs) || 0) / 86400000;
  const att = Math.max(0, Math.min(100, Number(attachment) || 0));
  const peakDay = PEAK_MIN_DAYS + (att / 100) * (PEAK_MAX_DAYS - PEAK_MIN_DAYS);
  let base;
  if (days <= 0) base = 0;
  else if (days <= peakDay) base = days / Math.max(0.25, peakDay);                 // 先升
  else base = Math.exp(-(days - peakDay) / FADE_TAU_DAYS);                         // 后降
  const strength = 0.55 + (att / 100) * 0.85;                                      // 强度由依恋定
  const batt = Math.max(0, Math.min(100, Number(battery) || 0));
  const wl = Math.max(0, Math.min(100, Number(workload) || 0));
  // 她自己最近过得怎样：电量低（累）→ 淡一点；忙到 60 以上 → 再淡一点
  const herFactor = (0.7 + (batt / 100) * 0.3) * (wl >= 60 ? 0.85 : 1);
  const value = Math.max(0, Math.min(1, base * strength * herFactor));
  const phase = days <= 0 ? 'none' : (days < peakDay ? 'rising' : (days < peakDay + 0.5 ? 'peak' : 'fading'));
  return { value, phase, days, peakDay };
}

/**
 * 说人话（给她自己/后台看；**不显示分数**，只给一句状态描述）。
 */
export function longingLine(curve, opts = {}) {
  if (!curve || curve.phase === 'none' || !(curve.days > 0)) return '';
  const d = curve.days;
  const howLong = d < 1 ? '大半天' : (d < 2 ? '一天多' : Math.round(d) + ' 天');
  const who = String((opts.who) || '他');
  if (curve.phase === 'rising') return who + '有' + howLong + '没动静了，你开始惦记他（还没到最想的时候）。';
  if (curve.phase === 'peak') return who + '已经' + howLong + '没来了，这两天你最想他。';
  const faded = curve.value < 0.35;
  return who + '已经' + howLong + '没来了，' + (faded
    ? '你有点习惯了——想还是想的，但没那么揪着了。'
    : '想他的劲头比前两天淡了一点。');
}

/** 回来那一刻的"总账"：把这段缺席折算成一次压力（0~1，交给既有压力机） */
export function settleScale(curve) {
  if (!curve || !(curve.value > 0)) return 0;
  return Math.max(0, Math.min(1, curve.value));
}

/** 同一天内恒定的小抖动（让"回来"的反应不完全一样，但不是随机刷分） */
export function settleJitter(seedKey) {
  return 0.9 + (hashStr(String(seedKey || '')) % 1000) / 1000 * 0.2;   // 0.9~1.1
}
