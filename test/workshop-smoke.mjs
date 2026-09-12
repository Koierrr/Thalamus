// workshop-smoke：解析器 + 分析(JSON围栏清洗) + 应用合并 + 版本回滚
import { parseChatExport, PersonaWorkshop } from '../src/persona-workshop.js';
import { Soul } from '../src/soul.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ① 解析器：时间戳格式
const sample1 = [
  '2026-08-01 12:00:11 小暖',
  '今天好累啊',
  '不想上班',
  '2026-08-01 12:01:00 主人',
  '抱抱，晚上吃什么',
].join('\n');
const m1 = parseChatExport(sample1);
console.log('解析①:', m1.length, '条 |', m1.map((m) => m.speaker + ':' + m.text.slice(0, 6)).join(' / '));
if (m1.length !== 2 || m1[0].text !== '今天好累啊\n不想上班') throw new Error('时间戳格式解析失败');

// ② 解析器："她：" 前缀格式
const sample2 = '她：随便，想吃火锅 哈哈\n我：走起';
const m2 = parseChatExport(sample2);
if (m2.length !== 2 || m2[0].speaker !== '她' || !m2[0].text.includes('火锅')) throw new Error('前缀格式解析失败');
console.log('✅ 前缀格式解析 OK');

// ③ 分析：假模型返回带代码围栏的JSON
const draftJson = JSON.stringify({
  name: '火锅少女', personality: { extraversion: 70, warmth: 80, clinginess: 60, sass: 40, initiative: 65 },
  catchphrases: ['哈哈', '随便'], interests: ['火锅'], emojiRate: 0.5, sentenceStyle: 'short',
  personaText: '一个爱吃火锅的活泼女生。',
  styleExamples: [{ user: '晚上吃什么', her: '随便，想吃火锅 哈哈' }],
  momentsVoice: '短句+emoji+美食', memorySeeds: [{ text: '她爱吃火锅', importance: 4 }],
});
const workshop = new PersonaWorkshop({
  soul: null,
  router: { async chat() { return { content: '好的人设如下：\n```json\n' + draftJson + '\n```', backend: 'stub' }; } },
  logger: () => {},
});
const draft = await workshop.analyze({ chatText: sample1, description: '大学同学' });
if (draft.name !== '火锅少女' || draft.styleExamples.length !== 1 || draft.memorySeeds[0].text !== '她爱吃火锅') throw new Error('分析草稿字段异常');
console.log('✅ 分析草稿（围栏清洗+字段校验）OK');

// ④ 应用：真实 Soul（版本快照 + 记忆种子）
const soul = new Soul({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-')), router: { async chat() { return { content: '[]' }; } }, logger: () => {} });
const name0 = soul.getPersona().name;
soul.archivePersona('应用前快照'); // 存档制：手动先存一档，应用后可切回
const ws2 = new PersonaWorkshop({ soul, router: { async chat() { return { content: '[]' }; } }, logger: () => {} });
const r = await ws2.apply(draft);
if (r.persona.name !== '火锅少女' || r.persona.source !== 'imported') throw new Error('应用失败');
if (r.seeds !== 1 || !soul.getMemories().entries.some((e) => e.text.includes('火锅'))) throw new Error('记忆种子导入失败');
// 存档制：应用前自动快照在档案列表里；切回即回滚
const arch = soul.listArchives();
if (!arch.length) throw new Error('没有可切回的存档');
const rolled = soul.switchArchive(arch[0].id);
if (rolled.name === '火锅少女') throw new Error('回滚失败');
console.log('✅ 应用 + 存档回滚 OK（回滚后名字: ' + rolled.name + '，应用前: ' + name0 + '）');

// ⑤ 超长输入截断不崩
await workshop.analyze({ chatText: 'x'.repeat(60000) });
console.log('✅ 超长输入截断安全');

console.log('WORKSHOP-SMOKE ALL GREEN ✅');


// 显式退出（2026-09-13 修）：本测试会拉起定时器 / 向量预热等后台任务，事件循环不会自己空掉
// → 进程跑完不退出，外部看起来就是"烟测卡死"。断言失败时上面的 throw 会让进程以非 0 退出，
// 只有全绿才会执行到这里，所以这里就是"成功退出"的唯一出口。
process.exit(0);
