// night-smoke.mjs — 夜间三态：晚安 ≠ 关机（第三次改版 批1-C3）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/night-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Life } from '../src/life.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mkLife = (cfg) => new Life({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'night-')),
  config: () => ({ life: { wake: '08:00', sleep: '23:00', morningOn: true, nightOn: true, pokesPerDay: 0, pokeWindow: ['10:00', '22:00'], nudgeMinutes: 20, nudgeMaxPerDay: 0, ...cfg } }),
  logger: () => {},
});
const soul = { proactive: async () => ({ chunks: ['晚安'], delaysMs: [0] }) };

// ① 出了晚安 → 进入"准备睡"
{
  const life = mkLife({});
  const sent = [];
  const at = (h, m) => new Date('2026-09-13T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00');
  await life.tick({ soul, sendToOwner: async (t) => sent.push(t), now: at(22, 45) });
  ok(sent.some((x) => x.includes('晚安')), '睡前窗内会发晚安');
  ok(life.nightPhase(at(22, 46)) === 'preparing', '发完晚安 → 状态是「准备睡」（不是立刻睡着）');
  const st = JSON.parse(fs.readFileSync(path.join(life.dir, 'life-state.json'), 'utf8'));
  const mins = Math.round((st.bedDue - st.bedAt) / 60000);
  ok(mins >= 15 && mins <= 45, '不失眠时：晚安后还会醒着 ' + mins + ' 分钟（15~45）');
  ok(life.nightPhase(at(23, 40)) === 'asleep', '过了那段 → 真的睡着');
}

// ② 失眠 → 醒着更久（甚至反过来找人）
{
  const life = mkLife({ insomnia: true });
  const at = (h, m) => new Date('2026-09-14T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00');
  const sent = [];
  await life.tick({ soul, sendToOwner: async (t) => sent.push(t), now: at(22, 45) });
  const st = JSON.parse(fs.readFileSync(path.join(life.dir, 'life-state.json'), 'utf8'));
  const mins = Math.round((st.bedDue - st.bedAt) / 60000);
  ok(st.bedInsomnia === true && mins >= 60, '今晚失眠 → 晚安后还会醒着 ' + mins + ' 分钟（60~120），不会秒睡');
}

// ③ 她睡着时你来消息 → 第二天早上她主动提一句
{
  const life = mkLife({});
  ok(life.consumeMorningCatchup() === false, '没发生就不该有"断片"提示');
  life.markSleptThrough();
  ok(life.consumeMorningCatchup() === true, '她睡着时你来过消息 → 第二天早上会提一句');
  ok(life.consumeMorningCatchup() === false, '这个提示只给一次（不会每条都道歉）');
}

console.log(fail === 0 ? '\nNIGHT ALL GREEN ✅  ' + pass + ' 项' : '\nNIGHT 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
