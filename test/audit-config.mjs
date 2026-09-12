// audit-config.mjs — 配置键"有没有人用"审计（禁黑盒工具）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/audit-config.mjs
// 作用：把 _sanitizeConfig 里"能被保存"的每个键，拿去全代码里找消费点；
//      只出现在白名单、别处没人读的键 = 设置静默失效（黑盒）。
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const idx = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
const start = idx.indexOf('_sanitizeConfig(b = {})');
const end = idx.indexOf('\n  }', idx.indexOf('return out;', start));
const block = idx.slice(start, end === -1 ? undefined : end);

// 白名单里出现的键（形如 X.key = 或 b.group.key）
const keys = new Set();
for (const m of block.matchAll(/[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);
for (const m of block.matchAll(/b\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) { keys.add(m[1]); keys.add(m[2]); }
for (const k of ['enabled', 'paused', 'replyToAll', 'ownerPeerId', 'blocklist', 'quietHours']) keys.add(k);

// 全量源码（排除白名单块自身）
const files = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
let src = '';
for (const f of files) {
  if (f === 'index.js') { src += idx.slice(0, start) + idx.slice(end === -1 ? idx.length : end); }
  else src += fs.readFileSync(path.join(root, 'src', f), 'utf8');
}
for (const f of fs.readdirSync(path.join(root, 'python'))) {
  if (f.endsWith('.py')) src += fs.readFileSync(path.join(root, 'python', f), 'utf8');
}

// 已知占位：生图未上线（后台卡片已注明"先放开关位"）；生图落地后移除本清单。
const KNOWN_PLACEHOLDER = new Set(['imageEnabled', 'reviewBeforeSend']);
const noUse = [];
for (const k of [...keys].sort()) {
  const re = new RegExp('[.\\[\'"`]' + k + '\\b|\\b' + k + ':', 'g');
  const n = (src.match(re) || []).length;
  if (n === 0 && !KNOWN_PLACEHOLDER.has(k)) noUse.push(k);
}
console.log('白名单键数:', keys.size);
if (noUse.length) {
  console.log('⚠️ 没有任何消费点的键（设置会静默失效）:');
  for (const k of noUse) console.log('  - ' + k);
  process.exit(1);
} else {
  console.log('✅ 每个可保存的键都有消费点');
}
