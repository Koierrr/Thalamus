// life-smoke：她的一天（2026-09-13 重写 —— 日常分享从"配额排班"换成"事件驱动"之后的回归）
// 覆盖：清晨安静 / 早安去重 / 睡着一条都不发 / 只有真实发生过的事会被分享 / 冷却 / 等急了 / 晚安 / 下午不补发
import { Life } from '../src/life.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'life-' + tag + '-'));
const mkLife = (dir, extra = {}) => new Life({
  dir,
  config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 4, nudgeMinutes: 20, nudgeMaxPerDay: 1, ...extra } }),
  logger: () => {},
});
const fakeSoul = { async proactive(kind, extra) { return { chunks: ['[' + kind + ']' + (extra && extra.flowItem ? ' ' + extra.flowItem.text : '')], delaysMs: [0] }; } };
const at = (d, h, m) => new Date(d + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00');

// ── ① 清晨安静 ──
{
  const dir = mk('a'); const sent = []; const life = mkLife(dir);
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 7, 0) });
  ok(sent.length === 0, '早上 7:00 什么都不发（早安窗口还没到）');
}

// ── ② 早安必发 + 同天不重发 ──
{
  const dir = mk('b'); const sent = []; const life = mkLife(dir);
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 8, 30) });
  ok(sent.some((t) => t.includes('[morning]')), '08:30 早安必发');
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 9, 0) });
  ok(sent.filter((t) => t.includes('[morning]')).length === 1, '同一天重复 tick 不会重复说早安');
}

// ── ③ 她睡着时：一条主动消息都不发（2026-09-13 起不再依赖"她发过晚安"）──
{
  const dir = mk('c'); const sent = []; const life = mkLife(dir);
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 5, 0) });
  ok(sent.length === 0, '凌晨 5:00（她 23:00 睡、08:00 起）→ 一条都不发');
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
  ok(st.bedPhase === 'asleep', '而且她被正确地标成"睡着"（bedPhase=asleep）');
  ok(/她已经睡了/.test(String((st.skipped || {}).all || '')), '后台能看见原因：' + String((st.skipped || {}).all).slice(0, 30));
}

// ── ④ 事件驱动：只有"她今天真实做过的事"才会被分享（且内容就是那件事）──
{
  const dir = mk('d'); const sent = [];
  const life = mkLife(dir);
  const imp = life._impulse({ traits: { initiative: 60, attachment: 50 }, battery: 70, mood: 65 });
  // 找一个"今天一定会说第 N 件事"的日子（roll 是按 日期+序号 定死的，所以这个测试是确定性的）
  let day = null; let hit = -1;
  for (const d of ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']) {
    for (let i = 0; i < 50; i++) {
      if (life._unitFor('say' + i, at(d, 11, 0)) <= imp) { day = d; hit = i; break; }
    }
    if (day) break;
  }
  ok(!!day, '找得到"她今天想说的事"（冲动 ' + imp.toFixed(2) + '，第 ' + hit + ' 件）');
  if (day) {
    const flow = [];
    for (let i = 0; i < 50; i++) flow.push({ time: '11:00', text: '第' + i + '件事' });
    await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at(day, 11, 10), overrides: { flow, traits: { initiative: 60, attachment: 50 }, battery: 70, mood: 65 } });
    const poke = sent.filter((t) => t.includes('[poke]'));
    ok(poke.length === 1, '到点就发了一条分享（不是靠配额凑数）');
    ok(poke.length && poke[0].includes('第' + hit + '件事'), '而且说的正是她那件事：「' + (poke[0] || '').slice(0, 24) + '」');
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
    ok(!!st.lastPokeAt && st.usedFlow && st.usedFlow[hit] > 0, '发过的事被记账（不会重复说同一件）');
  }
}

// ── ⑤ 冷却：刚发过一条，另一件就算在窗口里也不发 ──
{
  const dir = mk('e'); const sent = [];
  const life = mkLife(dir);
  const flow = [{ time: '11:00', text: '第一件' }, { time: '11:00', text: '第二件' }];
  const s0 = { date: '2026-09-15', lastPokeAt: at('2026-09-15', 11, 5).getTime(), pokes: 1, usedFlow: { 0: Date.now() } };
  fs.writeFileSync(path.join(dir, 'life-state.json'), JSON.stringify(s0));
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 11, 10), overrides: { flow, traits: { initiative: 90, attachment: 90 }, battery: 90, mood: 90 } });
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'life-state.json'), 'utf8'));
  const cooled = /冷却/.test(String((st.skipped || {}).poke || ''));
  ok(sent.filter((t) => t.includes('[poke]')).length === 0 && cooled, '刚发过 → 这次不发，并写明"冷却"原因');
}

// ── ⑥ 等急了（nudge）+ 每日上限 ──
{
  const dir = mk('f'); const sent = [];
  const life = mkLife(dir);
  fs.writeFileSync(path.join(dir, 'life-state.json'), JSON.stringify({ date: '2026-09-15', morning: true, night: true, pokes: 0, nudges: 0, pendingSince: Date.now() - 21 * 60000, bedPhase: 'awake' }));
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 14, 0), overrides: { flow: [] } });
  ok(sent.some((t) => t.includes('[nudge]')), '你一直没回 → 她催一句');
  fs.writeFileSync(path.join(dir, 'life-state.json'), JSON.stringify({ date: '2026-09-15', morning: true, night: true, pokes: 0, nudges: 1, pendingSince: Date.now() - 90 * 60000, bedPhase: 'awake' }));
  const before = sent.length;
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 15, 0), overrides: { flow: [] } });
  ok(sent.length === before, '当天催过 1 次（上限）→ 不再催');
}

// ── ⑦ 晚安 + ⑧ 下午启动不补发 ──
{
  const dir = mk('g'); const sent = []; const life = mkLife(dir);
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 22, 45), overrides: { flow: [] } });
  ok(sent.some((t) => t.includes('[night]')), '睡前窗口内会发晚安');
}
{
  const dir = mk('h'); const sent = []; const life = mkLife(dir);
  await life.tick({ soul: fakeSoul, sendToOwner: async (t) => sent.push(t), now: at('2026-09-15', 15, 0), overrides: { flow: [] } });
  ok(!sent.some((t) => t.includes('[night]')), '下午 15:00 启动：不补发晚安');
  ok(!sent.some((t) => t.includes('[morning]')), '下午 15:00 启动：不补发早安');
}

console.log(fail === 0 ? '\nLIFE-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nLIFE-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
