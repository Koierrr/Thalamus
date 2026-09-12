// prompt-preview：渲染真实人设提示词，人工质检输出质量
import { Soul } from '../src/soul.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-'));
const soul = new Soul({ dir, router: { async chat() { return { content: '', backend: 'stub' }; } }, logger: () => {} });
// 模拟一个已填写的人设
soul.savePersona({
  name: '小柔', birthday: '3月14日 双鱼座', city: '杭州', job: '插画师', age: '23岁',
  personaText: '独立插画师，养了只橘猫叫团子。喜欢深夜画稿，周末逛菜市场，对奶茶没抵抗力。',
  relationship: { toOwner: '女朋友', callOwner: '笨蛋', ownerCallsMe: '' },
  quirks: { catchphrases: ['哈哈哈', '哼'], emojiRate: 0.5, maxLength: 'short' },
  interests: ['画画', '火锅', '猫'],
});
soul.addMemory({ who: 'acct:p1', text: '主人下周三要考试', importance: 4 });
const persona = soul.getPersona();
const rel = soul.getRelation('acct:p1', true);
const memories = soul._retrieve('考试', 'acct:p1');
const sys = soul._systemPrompt({ persona, rel, isOwner: true, memories, now: new Date(), mediaCount: 0 });
console.log('===== 真实系统提示词（质检用） =====');
console.log(sys);
console.log('===== 结束 =====');
