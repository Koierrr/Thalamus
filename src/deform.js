// deform.js — 四层变形状态机（荣格：压力→功能变形→平静恢复→整合演化）
// 底色（功能栈）永不变；压力值由事件累积、被哄/好睡眠衰减；
// 阈值分级：normal → grip(劣势爆发) → loop(主三循环) → shadow(影子黑化)；
// 平静逐层退出；grip 结束→整合度+（下次 grip 更温和更短=人的成熟）。
// 后台可调（机务→变形状态机）：总开关、灵敏度倍率、阈值（grip/loop/shadow）。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TH = { grip: 45, loop: 70, shadow: 88 };
const DELTA = { rude: 18, allNighter: 25, ignored: 15, conflict: 20, work: 20, warm: -12, goodSleep: -10 };

/** 事件说明（给后台展示用，避免黑盒） */
export const EVENT_LABEL = {
  rude: '被凶/被怼 +18',
  allNighter: '她熬通宵 +25',
  ignored: '被冷落（她催你没人回）+15',
  conflict: '冲突/争吵 +20',
  work: '被工作压垮（世界引擎报的工作负荷）+20×强度',
  warm: '被哄/被宠 −12',
  goodSleep: '睡得好 −10',
};

export class Deform {
  constructor(dir, log, config) {
    this.file = path.join(dir, 'deform-state.json');
    this.log = log || (() => {});
    this._cfgGet = typeof config === 'function' ? config : () => ({});
  }

  /** 后台设置：{enabled, sensitivity, grip, loop, shadow} */
  cfg() {
    const d = (this._cfgGet() || {}).deform || {};
    const clamp = (v, lo, hi, dft) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dft);
    return {
      enabled: d.enabled !== false,
      sensitivity: clamp(d.sensitivity, 0.2, 3, 1),
      grip: clamp(d.grip, 10, 95, DEFAULT_TH.grip),
      loop: clamp(d.loop, 20, 98, DEFAULT_TH.loop),
      shadow: clamp(d.shadow, 30, 100, DEFAULT_TH.shadow),
    };
  }

  _read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return { stress: 0, integration: 0, lastGripAt: 0, inDeform: false, justRecovered: false, lastDecayDate: '', lastAllNighterDate: '' }; } }
  _save(s) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(s, null, 2), 'utf8'); }

  /** 事件记一笔（rude/allNighter/ignored/conflict/warm/goodSleep） */
  note(event, scale = 1) {
    const c = this.cfg();
    if (!c.enabled) return this.info();
    const s = this._read();
    const base = DELTA[event] || 0;
    if (!base) return this.info();
    const k = Math.max(0, Math.min(3, Number(scale) || 1));
    const delta = base > 0 ? base * c.sensitivity * k : base * k; // 灵敏度只放大"加压"，不动"减压"
    s.stress = Math.round(Math.min(100, Math.max(0, s.stress + delta)));
    s.lastEvent = event;
    s.lastEventAt = Date.now();
    this._save(s);
    return this.info();
  }

  /** 每日自然衰减 + 当天通宵事件（由 daily 状态驱动，一天只记一次） */
  daily(today) {
    const c = this.cfg();
    const s = this._read();
    const key = today.date || '';
    if (s.lastDecayDate !== key) {
      if (c.enabled) {
        s.stress = Math.max(0, s.stress - 15);
        if (today.allNighter && s.lastAllNighterDate !== key) { s.stress = Math.min(100, s.stress + DELTA.allNighter * c.sensitivity); s.lastAllNighterDate = key; }
        else if (!today.allNighter) s.stress = Math.max(0, s.stress + DELTA.goodSleep);
      }
      s.lastDecayDate = key;
      this._save(s);
    }
    return this.info();
  }

  /** 当前状态（含迟滞：进入阈值高、退出需要压力明显回落） */
  info() {
    const c = this.cfg();
    const s = this._read();
    const gripTh = c.grip + (s.integration || 0) * 0.15;
    let state = 'normal';
    if (c.enabled) {
      if (s.stress >= c.shadow) state = 'shadow';
      else if (s.stress >= c.loop) state = 'loop';
      else if (s.stress >= gripTh) state = 'grip';
    }
    if (state !== 'normal') {
      if (!s.inDeform) { s.inDeform = true; s.lastGripAt = Date.now(); }
      if (s.lastState && s.lastState !== state && state !== 'grip') s.justRecovered = false;
      s.lastState = state;
    } else if (s.inDeform) {
      s.inDeform = false;
      s.justRecovered = true;
      s.integration = Math.min(80, (s.integration || 0) + 2); // 整合度：grip 过后更成熟
      s.stress = Math.max(0, s.stress - 20);
    }
    this._save(s);
    return {
      stress: Math.round(s.stress),
      integration: s.integration || 0,
      state,
      justRecovered: !!s.justRecovered,
      enabled: c.enabled,
      sensitivity: c.sensitivity,
      thresholds: { grip: Math.round(gripTh), loop: c.loop, shadow: c.shadow },
      lastGripAt: s.lastGripAt || 0,
      lastEvent: s.lastEvent || '',
      lastEventAt: s.lastEventAt || 0,
      inDeform: !!s.inDeform,
    };
  }

  /** 恢复提示被消费（一次性）；返回 true=这一轮她该道歉/自嘲 */
  consumeRecovery() {
    const s = this._read();
    if (!s.justRecovered) return false;
    s.justRecovered = false;
    this._save(s);
    return true;
  }
}
