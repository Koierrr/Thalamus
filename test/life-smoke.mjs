// life-smoke：虚拟时间推演她的一天（早安/日常分享/等急了/晚安），去重与主人活跃清零
import { Life } from '../src/life.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-test-'));
const sent = []; // sendToOwner 收到的是消息文本
const life = new Life({
  dir,
  config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', pokesPerDay: 2, pokeWindow: ['10:00', '22:00'], nudgeMinutes: 20, nudgeMaxPerDay: 1 } }),
  logger: () => {},
});
const fakeSoul = { async proactive(kind) { return { chunks: ['[' + kind + '] 呀'], delaysMs: [0] }; } };
const sendToOwner = async (t) => { sent.push(t); };
const tick = (h, m) => life.tick({ soul: fakeSoul, sendToOwner, now: new Date('2026-09-15T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00') });
const kinds = () => sent.join(',');

// 1) 早上7:00：什么都不会发（早安目标最晚08:25）
await tick(7, 0);
if (sent.length !== 0) throw new Error('7点不该发消息: ' + kinds());
console.log('✅ 清晨安静');

// 2) 08:30：早安必发（目标 ≤08:25）
await tick(8, 30);
if (!sent.some((t) => t.includes('[morning]'))) throw new Error('早安未触发: ' + kinds());
console.log('✅ 早安触发');

// 3) 同一天重复 tick 不重发
await tick(9, 0);
if (sent.filter((t) => t.includes('[morning]')).length !== 1) throw new Error('早安重复发送');
console.log('✅ 早安去重（重启安全）');

// 4) 13:30：日常分享第1条（槽位≈13:00±20）
await tick(13, 30);
if (!sent.some((t) => t.includes('[poke]'))) throw new Error('日常分享未触发');
console.log('✅ 日常分享#1 → 并进入等待回应状态');

// 5) 等急了：把等待时间拨回21分钟前
{
  const stateFile = path.join(dir, 'life-state.json');
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  s.pendingSince = Date.now() - 21 * 60000;
  fs.writeFileSync(stateFile, JSON.stringify(s));
}
await tick(13, 55);
if (!sent.some((t) => t.includes('[nudge]'))) throw new Error('等急了未触发');
console.log('✅ 等急了→撒娇催一句');

// 6) 主人来消息 → 清掉等待态（不会再催）
life.noteOwnerActivity();
{
  const stateFile = path.join(dir, 'life-state.json');
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (s.pendingSince) throw new Error('主人活跃未清等待态');
}
console.log('✅ 主人活跃清零等待态');

// 7) 20:00：日常分享第2条（槽位≈19:00±20，必已到）
await tick(20, 0);
if (sent.filter((t) => t.includes('[poke]')).length !== 2) throw new Error('日常分享数量异常');
// 第2条 poke 又进入等待态；nudge 当日已达上限 → 不再催
{
  const stateFile = path.join(dir, 'life-state.json');
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  s.pendingSince = Date.now() - 60 * 60000;
  fs.writeFileSync(stateFile, JSON.stringify(s));
}
await tick(20, 5);
if (sent.filter((t) => t.includes('[nudge]')).length !== 1) throw new Error('nudge 每日上限失效');
console.log('✅ 日常分享#2 + nudge 每日上限');

// 8) 22:45：晚安（睡前 90 分钟内才发；睡后不再发——她已经睡了）
await tick(22, 45);
if (!sent.some((t) => t.includes('[night]'))) throw new Error('晚安未触发');
console.log('✅ 晚安触发（睡前窗口内）');

// 9) 换一天验证："睡后/白天不补发晚安"
{
  const day2 = new Date('2026-09-16T15:00:00');
  const sent2 = [];
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'life-test2-'));
  const life2 = new Life({ dir: dir2, config: () => ({ life: { enabled: true, wake: '08:00', sleep: '23:00', morningOn: true, nightOn: true, pokesPerDay: 0, pokeWindow: ['10:00', '22:00'], nudgeMinutes: 20, nudgeMaxPerDay: 1 } }), logger: () => {} });
  await life2.tick({ soul: fakeSoul, sendToOwner: async (t) => { sent2.push(t); }, now: day2 });
  if (sent2.some((t) => t.includes('[night]'))) throw new Error('下午不该补发晚安: ' + sent2.join(','));
  if (sent2.some((t) => t.includes('[morning]'))) throw new Error('下午不该补发早安: ' + sent2.join(','));
  console.log('✅ 下午 15:00 启动：既不补发早安也不补发晚安（睡后/错过窗口一律不发）');
}

console.log('\n一天共发 ' + sent.length + ' 条主动消息: ' + kinds());
console.log('LIFE-SMOKE ALL GREEN ✅');


// 显式退出（2026-09-13 修）：本测试会拉起定时器 / 向量预热等后台任务，事件循环不会自己空掉
// → 进程跑完不退出，外部看起来就是"烟测卡死"。断言失败时上面的 throw 会让进程以非 0 退出，
// 只有全绿才会执行到这里，所以这里就是"成功退出"的唯一出口。
process.exit(0);
