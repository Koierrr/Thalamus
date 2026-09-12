// rhythm-smoke.mjs — 世界引擎推断的作息必须覆盖后台设置（第三次改版 批1-B2）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/rhythm-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayState } from '../src/daily.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-'));
const BEHAVIOR = { baseWake: '09:00', baseSleep: '23:00', weekendShiftMin: 30, nightOwlProb: 0.0, allNighterProb: 0.0 };
const RHYTHM = { baseWake: '06:30', baseSleep: '22:30', weekendShiftMin: 120, nightOwlProb: 0.0, allNighterProb: 0.0 };

// ① 有世界节奏 → 以世界为准（且概率压到 0，避免随机干扰判断）
{
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'world-state.json'), JSON.stringify({ forDate: '2020-01-01', tone: { rhythm: RHYTHM } }), 'utf8');
  const out = await todayState(dir, { name: '苏镜语', behavior: BEHAVIOR, traits: {} });
  const w = Number(String(out.wake).split(':')[0]);
  const sl = Number(String(out.sleep).split(':')[0]);
  ok(out.rhythmFrom === 'world', '来源标成 world（她推的作息生效）');
  ok(w === 6, '起床跟着世界引擎走（' + out.wake + '，后台填的是 09:00）');
  ok(sl <= 23 && sl >= 21, '睡觉跟着世界引擎走（' + out.sleep + '，后台填的是 23:00／世界推断 22:30）');
  const note = (out.rhythmNote || []).join(' | ');
  ok(/09:00 → 06:30/.test(note), '留痕写清了它改了什么：' + note.slice(0, 60));
}

// ② 没有世界节奏 → 用后台的值，且标记来源为 config
{
  const dir = mk();
  const out = await todayState(dir, { name: '苏镜语', behavior: BEHAVIOR, traits: {} });
  const w = Number(String(out.wake).split(':')[0]);
  ok(out.rhythmFrom === 'config', '没跑过世界引擎 → 来源标成 config');
  const mins = Number(String(out.wake).split(':')[0]) * 60 + Number(String(out.wake).split(':')[1] || 0);
  ok(Math.abs(mins - 9 * 60) <= 90, '起床用后台填的 09:00（含抖动：' + out.wake + '）');
  ok((out.rhythmNote || []).length === 0, '没跑过就不编“它改了什么”');
}

// ③ 生活节奏是“习惯”：昨天那份世界产出也算数
{
  const dir = mk();
  const old = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, 'world-state.json'), JSON.stringify({ forDate: old, tone: { rhythm: RHYTHM } }), 'utf8');
  const out = await todayState(dir, { name: '苏镜语', behavior: BEHAVIOR, traits: {} });
  ok(out.rhythmFrom === 'world' && Number(String(out.wake).split(':')[0]) === 6, '几天前推的作息仍然生效（习惯不是当天才有的）');
}

console.log(fail === 0 ? '\nRHYTHM ALL GREEN ✅  ' + pass + ' 项' : '\nRHYTHM 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
