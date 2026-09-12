// soul.js 冒烟测试：假模型 + 临时目录，验证 回复/记忆抽取/检索/人设版本/关系数值
import { Soul } from '../src/soul.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-test-'));
let chatCalls = 0;
const router = {
  async chat(messages) {
    chatCalls++;
    const sys = messages[0].content || '';
    if (sys.includes('记忆抽取器')) {
      return { content: '[{"text":"主人下周三要考试","importance":4,"tags":["考试"],"todo":{"due":"2026-01-01","text":"祝主人考试顺利"}}]', backend: 'stub' };
    }
    return { content: '嗯嗯 在追剧呀 哈哈', backend: 'stub' };
  },
};
const soul = new Soul({ dir, router, logger: () => {} });

// 1) 回复
const out1 = await soul.reply({ peerKey: 'acct:peer1', isOwner: true, text: '在干嘛呢' });
console.log('回复拆条:', JSON.stringify(out1.chunks), '| 延迟数量:', out1.delaysMs.length);
if (!out1.chunks.length) throw new Error('回复为空');
if (out1.chunks.length !== out1.delaysMs.length) throw new Error('延迟数量不匹配');

// 2) 记录对话 → 记忆抽取
await soul.recordConversation({ peerKey: 'acct:peer1', isOwner: true, userText: '我下周三要考试，好紧张，记得祝我顺利呀', herTexts: out1.chunks });
const mem = soul.getMemories();
console.log('记忆条数:', mem.entries.length, '| 首条:', mem.entries[0] && mem.entries[0].text);
if (!mem.entries.some((e) => e.text.includes('考试'))) throw new Error('记忆未抽取到');

// 3) 检索：提到考试应命中
const hits = await soul._retrieveHybrid('考试的事想起来没', 'acct:peer1');
console.log('检索Top1:', hits[0] && hits[0].text);
if (!hits.length) throw new Error('检索失败');

// 4) 人设存档制（存档→改→切回）
const name0 = soul.getPersona().name;
soul.archivePersona('测试存档');
soul.savePersona({ name: '测试改名' });
const arch = soul.listArchives();
const rolled = soul.switchArchive(arch[0].id);
console.log('人设切回后名字:', rolled.name);
if (rolled.name !== name0) throw new Error('人设存档切回失败');

// 5) 关系数值
const rel = soul.getRelation('acct:peer1', true);
console.log('关系:', JSON.stringify({ affection: Math.round(rel.affection), mood: Math.round(rel.mood), chats: rel.chats }));
if (!rel.chats) throw new Error('关系未更新');

// 6) 隐私隔离：另一个联系人检索不到主人专属记忆
const hits2 = await soul._retrieveHybrid('考试', 'acct:peer2');
console.log('他人检索命中:', hits2.length, '（记忆 who=acct:peer1，应检索不到）');
if (hits2.some((h) => h.who === 'acct:peer1')) throw new Error('记忆隔离失败');

console.log('SMOKE OK ✅ chatCalls=' + chatCalls);
