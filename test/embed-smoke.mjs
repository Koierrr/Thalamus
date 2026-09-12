// embed-smoke：用真实本地 Ollama(bge-m3) 验证语义记忆检索 + 降级路径
import { Soul } from '../src/soul.js';
import { MemoryEmbed } from '../src/memory-embed.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-test-'));
const embed = new MemoryEmbed({ dir, logger: () => {} });
const soul = new Soul({ dir, router: { async chat() { return { content: '好呀', backend: 'stub' }; } }, embed, logger: () => {} });

// 三条语义距离不同的记忆
soul.addMemory({ who: '', text: '主人不吃香菜，点菜的时候要注意', importance: 4 });
soul.addMemory({ who: '', text: '主人下周三要考试，记得祝他顺利', importance: 4 });
soul.addMemory({ who: '', text: '主人喜欢在深夜聊电影', importance: 3 });

// 补向量
const n = await embed.sweep(soul.getMemories().entries);
console.log('向量化条数:', n);

// ① 语义命中：问吃的 → 应命中"香菜"（关键词全是0分，纯语义）
const t1 = Date.now();
const hits1 = await soul._retrieveHybrid('晚上想吃点好的，有什么推荐吗', 'acct:p1');
console.log('检索①(吃):', hits1.map((e) => e.text.slice(0, 12)).join(' | '), ' 耗时' + (Date.now() - t1) + 'ms');
if (!hits1.slice(0, 2).some((e) => e.text.includes('香菜'))) throw new Error('语义检索未命中"吃"相关的香菜记忆');

// ② 语义命中：问考试
const hits2 = await soul._retrieveHybrid('对了，那件事准备得怎么样了', 'acct:p1');
console.log('检索②(考试):', hits2.map((e) => e.text.slice(0, 12)).join(' | '));
if (!hits2.slice(0, 2).some((e) => e.text.includes('考试'))) throw new Error('语义检索未命中考试记忆');

// ③ 隐私隔离在语义路径下依然成立（who=联系人 的记忆只属于该对话）
soul.addMemory({ who: 'acct:p1', text: '主人告诉过我的一个小秘密', importance: 5 });
await embed.sweep(soul.getMemories().entries.filter((e) => e.who === 'acct:p1'));
const hits3 = await soul._retrieveHybrid('那个小秘密是什么', 'acct:p2');
if (hits3.some((e) => e.text.includes('小秘密'))) throw new Error('语义路径隐私隔离失败');
const hits3b = await soul._retrieveHybrid('那个小秘密是什么', 'acct:p1');
if (!hits3b.some((e) => e.text.includes('小秘密'))) throw new Error('主人自己反而查不到私密记忆');
console.log('✅ 语义路径隐私隔离 OK（对别人守口如瓶，对主人记得）');

// ④ 降级：Ollama 挂了 → 纯关键词仍然工作
const embedDead = new MemoryEmbed({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'embed-dead-')), ollamaUrl: 'http://127.0.0.1:9', logger: () => {} });
const soulDead = new Soul({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'embed-dead-soul-')), router: { async chat() { return { content: 'x' }; } }, embed: embedDead, logger: () => {} });
soulDead.addMemory({ who: '', text: '主人下周三要考试', importance: 4 });
const hits4 = await soulDead._retrieveHybrid('考试的事', 'acct:p1');
console.log('降级检索:', hits4.map((e) => e.text.slice(0, 12)).join(' | '));
if (!hits4.length) throw new Error('降级路径失败');

console.log('\nEMBED-SMOKE ALL GREEN ✅');


// 显式退出（2026-09-13 修）：本测试会拉起定时器 / 向量预热等后台任务，事件循环不会自己空掉
// → 进程跑完不退出，外部看起来就是"烟测卡死"。断言失败时上面的 throw 会让进程以非 0 退出，
// 只有全绿才会执行到这里，所以这里就是"成功退出"的唯一出口。
process.exit(0);
