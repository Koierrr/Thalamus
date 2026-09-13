// proactive-gate.js —— 主动性闸门（N2）
//
// 以前"她该不该主动找你"由五处各判一套：配置开关 · 世界引擎写的三种次数（早安/晚安/分享/催）·
// 冲动概率 · 分享的冷却 60±30 分钟 · 催单独一本额度。五处各判一套的后果是：
// 调了一个地方没反应、两个地方算重了、后台也说不清"为什么今天没主动"。
//
// 现在收成一个闸门，三道关按序判，只在这里判：
//   ① **该不该**（gate）：她在睡 / 已暂停 / 世界引擎说这个意图今天不做 / 不在她今天的时间窗
//   ② **够不够久**（cooldown）：距上一条主动至少隔 N 分钟（统一一个间隔，不再每类各一套）
//   ③ **还有没有额度**（budget）：**分享和催共用一本当天账**（早安/晚安属作息，不占这本账）
//
// 判定结果带一句中文原因，直接进后台（禁黑盒：没发也要能看见为什么没发）。
// 这个文件是纯函数：不碰磁盘、不碰网络，能直接测。

/** 默认：两条主动之间至少隔多久（分钟）。 */
export const DEFAULT_GAP_MIN = 45;

/** 一本当天账：今天主动了几次、各类各几次。调用方负责存盘（通常落在 life-state.json）。 */
export function newDay(key) {
  return { date: String(key || ''), used: 0, byKind: {} };
}

/** 跨天翻页：日期不对就重开一本 */
export function rollDay(day, key) {
  if (!day || day.date !== String(key || '')) return newDay(key);
  return { date: day.date, used: Number(day.used) || 0, byKind: { ...(day.byKind || {}) } };
}

/** 早安/晚安属于作息行为，不占"主动找你说闲话"那本账 */
export function countsAgainstBudget(kind) {
  return kind === 'poke' || kind === 'nudge';
}

/**
 * 闸门判定。参数都显式给，方便测，也方便后台把"为什么"讲清楚。
 *
 * @returns {{ok:boolean, why:string}}
 */
export function gate(opts = {}) {
  const kind = String(opts.kind || 'poke');
  // 明确给了 0 = 你说不冷却；没给或给的不是数字 = 用默认
  const rawGap = Number(opts.gapMin);
  const gapMin = Number.isFinite(rawGap) && rawGap >= 0 ? rawGap : DEFAULT_GAP_MIN;
  const day = rollDay(opts.day, opts.dayKey);
  const budget = Math.max(0, Number(opts.budget) || 0);
  const now = Number(opts.now) || Date.now();
  const lastAt = Number(opts.lastAt) || 0;

  // ① 该不该
  if (opts.paused === true) return { ok: false, why: '你把她暂停了' };
  if (opts.asleep === true) return { ok: false, why: '她已经睡了（睡着了就真的不打扰）' };
  if (opts.allowed === false) return { ok: false, why: '世界引擎说今天不做这件事（' + kind + '）' };
  if (opts.inWindow === false) return { ok: false, why: '现在不在她能主动的时间窗里' };

  // ② 够不够久（统一间隔，不再每类一套）
  if (gapMin > 0 && lastAt && now - lastAt < gapMin * 60000) {
    const left = Math.ceil((gapMin * 60000 - (now - lastAt)) / 60000);
    return { ok: false, why: '刚主动过，还在冷却里（再过约 ' + left + ' 分钟才合适）' };
  }

  // ③ 还有没有额度（分享与催共用一本账；作息类不占）
  if (countsAgainstBudget(kind) && day.used >= budget) {
    return { ok: false, why: '今天的主动额度用完了（' + day.used + '/' + budget + '）' };
  }
  return { ok: true, why: '' };
}

/** 记一笔（发出去之后调）。返回新的当天账 + 新的"上一条主动时间" */
export function record(day, kind, now) {
  const d = rollDay(day, (day && day.date) || '');   // day 可能是空的（第一次主动）
  d.byKind[kind] = (Number(d.byKind[kind]) || 0) + 1;
  if (countsAgainstBudget(kind)) d.used = (Number(d.used) || 0) + 1;
  return { day: d, lastAt: Number(now) || Date.now() };
}

/**
 * 后台展示用的一句话（禁黑盒：她为什么不主动，这里要说清楚）。
 */
export function gateLine(day, budget, lastAt, now) {
  const d = rollDay(day, (day && day.date) || '');
  const used = countsAgainstBudget('poke') ? d.used : 0;
  const parts = ['今天主动 ' + used + '/' + Math.max(0, Number(budget) || 0) + ' 次（分享与催共用这本账，早安晚安不算）'];
  if (lastAt) {
    const mins = Math.max(0, Math.round((now - lastAt) / 60000));
    // 90 分钟要说"1 小时 30 分钟"，不能四舍五入成"2 小时"（后台是给人看的，误差要说实话）
    const ago = mins < 60
      ? mins + ' 分钟'
      : Math.floor(mins / 60) + ' 小时' + (mins % 60 ? ' ' + (mins % 60) + ' 分钟' : '');
    parts.push('距上一条 ' + ago);
  } else {
    parts.push('今天还没主动过');
  }
  const by = Object.keys(d.byKind || {}).filter((k) => d.byKind[k]).map((k) => ({ morning: '早安', night: '晚安', poke: '分享', nudge: '催你' }[k] || k) + ' ' + d.byKind[k]);
  if (by.length) parts.push('明细：' + by.join(' · '));
  return parts.join(' · ');
}
