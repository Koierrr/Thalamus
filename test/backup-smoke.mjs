// backup-smoke：每日备份触发 + 保留7份清理
import { Life } from '../src/life.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-bak-'));
// 放进一个伪数据目录结构（备份写到 dir/../wechat-companion-backups）
const life = new Life({ dir, config: () => ({ life: { enabled: true, wake: '08:00' } }), logger: () => {} });
// 造一些要备份的文件
fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ name: '测试' }));
fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ entries: [{ id: 'x', text: '记忆' }], todos: [] }));

// 推演到早上8:30（触发早安的同一 tick 顺带备份）
await life.tick({ soul: { async proactive() { return { chunks: ['早'], delaysMs: [0] }; } }, sendToOwner: async () => {}, now: new Date('2026-09-15T08:30:00') });

const bdir = path.join(dir, '..', 'wechat-companion-backups', '2026-09-15');
if (!fs.existsSync(path.join(bdir, 'persona.json'))) throw new Error('备份未生成');
if (JSON.parse(fs.readFileSync(path.join(bdir, 'persona.json'), 'utf8')).name !== '测试') throw new Error('备份内容异常');
if (!fs.existsSync(path.join(bdir, 'history'))) throw new Error('history未备份');

// 同日重复 tick 不重复备份
await life.tick({ soul: { async proactive() { return { chunks: ['x'], delaysMs: [0] }; } }, sendToOwner: async () => {}, now: new Date('2026-09-15T09:00:00') });
const count = fs.readdirSync(path.join(dir, '..', 'wechat-companion-backups')).filter((d) => d === '2026-09-15').length;
if (count !== 1) throw new Error('同日重复备份');

// 造8天旧备份 → 新一天触发清理
const parent = path.join(dir, '..', 'wechat-companion-backups');
for (let i = 1; i <= 8; i++) {
  const d = '2026-09-0' + i;
  fs.mkdirSync(path.join(parent, d), { recursive: true });
  fs.writeFileSync(path.join(parent, d, 'persona.json'), '{}');
}
await life.tick({ soul: { async proactive() { return { chunks: ['x'], delaysMs: [0] }; } }, sendToOwner: async () => {}, now: new Date('2026-09-16T08:30:00') });
const remaining = fs.readdirSync(parent).sort();
console.log('备份目录:', remaining.join(', '));
if (remaining.length > 7) throw new Error('清理失败，仍剩' + remaining.length + '份');
if (!remaining.includes('2026-09-16')) throw new Error('新备份缺失');

console.log('BACKUP-SMOKE ALL GREEN ✅');
