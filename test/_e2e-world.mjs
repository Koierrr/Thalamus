// _e2e-world.mjs — 真实端到端验证（用真模型、真配置，但写进临时目录，不碰她的数据）
// 验证：①世界引擎能连通并返回严格 JSON ②新字段（statusLine/insomnia/proactive/proactiveAt/rhythm）
//       ③「她的过去」三层能生成并写回 ④日记 Markdown 真的落盘
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldEngine } from '../src/world-engine.js';

const realDir = path.join(os.homedir(), '.dsh', 'wechat-companion');
const cfg = JSON.parse(fs.readFileSync(path.join(realDir, 'config.json'), 'utf8'));
const persona = JSON.parse(fs.readFileSync(path.join(realDir, 'persona.json'), 'utf8'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-world-'));
const saved = [];
const stubSoul = {
  savePersona: (p) => saved.push(p),
  getRelations: () => ({}),
  getPersona: () => persona,
  addMemory: async () => {},
};

const t0 = Date.now();
const w = new WorldEngine({
  dir,
  router: { chat: async () => { throw new Error('不该走对话接口'); } },
  config: () => cfg,
  soul: stubSoul,
  logger: (m) => console.log('   [world] ' + m),
});

console.log('世界引擎槽位:', (cfg.chain && cfg.chain.world || []).map((c) => c.model).join(' → '));
console.log('人设:', persona.name, '| 职业', persona.job, '| 城市', persona.city, '| MBTI', (persona.assessments || {}).mbti);

let out = null;
try {
  out = await w.generate({
    persona, today: { sleep: '01:10', events: ['周末'] }, memories: [],
    now: new Date('2026-09-13T23:40:00'),
  });
} catch (e) {
  console.log('❌ 生成失败:', e.message);
  process.exit(1);
}

console.log('\n=== 结果（耗时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）===');
console.log('后端:', w.lastBackend || '（未知）');
console.log('日记:', String(out.diary || '').slice(0, 60) + '…', '（' + String(out.diary || '').length + ' 字）');
console.log('明天作息:', out.wake, '起 /', out.sleep, '睡');
const t = out.tone || {};
const chk = [
  ['statusLine', !!t.statusLine, t.statusLine],
  ['insomnia', typeof t.insomnia === 'boolean', t.insomnia],
  ['proactive', !!t.proactive, JSON.stringify(t.proactive)],
  ['proactiveAt', typeof t.proactiveAt === 'string', t.proactiveAt],
  ['rhythm', !!t.rhythm, JSON.stringify(t.rhythm)],
];
chk.forEach(([k, ok, v]) => console.log((ok ? '✅' : '❌') + ' 新字段 ' + k + ': ' + v));

const pastPatch = saved.filter((x) => x && x.profile && x.profile.past).pop();
console.log((pastPatch ? '✅' : '❌') + ' 她的过去被生成:');
if (pastPatch) {
  const p = pastPatch.profile.past;
  console.log('   表层:', String(p.surface || '').slice(0, 70));
  console.log('   中层:', String(p.middle || '').slice(0, 70));
  console.log('   深层:', String(p.deep || '').slice(0, 70));
}

const days = w.diaryDays();
console.log((days.length ? '✅' : '❌') + ' 日记留档: ' + days.join(','));
if (days.length) {
  const md = w.diaryOf(days[0]);
  const want = ['她的话（私人日记）', '那一天的她', '她的一天（生活流水）', '第二天她对你的分寸', '她眼中的你（画像）'];
  const miss = want.filter((x) => !md.includes(x));
  console.log((miss.length ? '❌ 缺: ' + miss.join('、') : '✅') + ' 存档内容完整（' + md.length + ' 字）');
  console.log('   【她的状态】那行在不在:', /她今天的状态/.test(md) ? '在 ✅' : '不在 ❌');
  console.log('   【今晚失眠】那行:', /今晚失眠/.test(md) ? '在 ✅' : '不在（这次不失眠，正常）');
  console.log('   【作息基准】那行:', /她的作息基准/.test(md) ? '在 ✅' : '不在 ❌');
}
process.exit(0);
