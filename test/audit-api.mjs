// audit-api.mjs — 前端调用 ↔ 后端路由 对账（禁黑盒工具之二）
// 作用：① 把 console.html 里所有 api('GET/POST','xxx') 的路径，拿去 index.js 找处理分支；
//      ② 检查每条 POST panel/config 载荷的**顶层分组**是否都在已知白名单里（防止被后端静默丢弃）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/audit-api.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'src', 'console.html'), 'utf8');
const idx = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

/* ① 前端用到的接口路径（去掉查询串） */
const paths = new Set();
for (const m of html.matchAll(/api\('(GET|POST)',\s*'([^']+)'/g)) paths.add(m[2].split('?')[0]);

const SQ = String.fromCharCode(39);
function handled(p) {
  if (idx.includes(p)) return true;
  const segs = p.split('/');
  for (let i = segs.length - 1; i >= 1; i--) {
    const pre = segs.slice(0, i).join('/');
    if (idx.includes('startsWith(' + SQ + pre)) return true;
  }
  return false;
}
const missing = [...paths].filter((p) => !handled(p)).sort();

/* ② POST panel/config 载荷的顶层分组（按括号深度解析，避免把嵌套键当分组） */
function topLevelKeys(body) {
  const keys = new Set();
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      const c = body[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
    }
    if (depth === 0) keys.add(m[1]);
  }
  return keys;
}
const groups = new Set();
for (const m of html.matchAll(/panel\/config',\s*\{/g)) {
  let i = m.index + m[0].length;
  let depth = 1;
  let body = '';
  let inStr = false;
  let quote = '';
  while (i < html.length && depth > 0) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') { body += c + html[i + 1]; i += 2; continue; }
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; }
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) break; }
    body += c; i++;
  }
  for (const k of topLevelKeys(body)) groups.add(k);
}

const KNOWN = new Set(['behavior', 'media', 'channel', 'system', 'life', 'memory', 'deform', 'world', 'workshop', 'params', 'job',
  'quietHours', 'replyToAll', 'ownerPeerId', 'blocklist', 'paused', 'dataDir', 'savedAt', 'security',
  'chat', 'image', 'tts', 'asr', 'vision', 'embed']);
// 也收集 saveCfgBtn 闭包里 return { <group>: ... } 构造的分组（载荷不在调用点）。
// 只扫 saveCfgBtn 自己的括号范围——否则别的接口的请求体（如 model-test 的 form:{baseURL:…}）
// 会被误当成配置分组。
for (const m of html.matchAll(/saveCfgBtn\(/g)) {
  let i = m.index + m[0].length; let depth = 1; let args = ''; let inStr = false; let quote = '';
  while (i < html.length && depth > 0) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') { args += c + html[i + 1]; i += 2; continue; }
      if (c === quote) inStr = false;
    } else if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; }
    else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) break; }
    args += c; i++;
  }
  for (const r of args.matchAll(/return\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) groups.add(r[1]);
}
const UI_HELPERS = new Set(['cells', 'el', 'body', 'cur', 'icon', 'id', 'title', 'desc']);
const unknown = [...groups].filter((g) => !KNOWN.has(g) && !UI_HELPERS.has(g)).sort();

console.log('前端接口路径 ' + paths.size + ' 个');
if (missing.length) {
  console.log('⚠️ 后端找不到处理的接口：');
  for (const p of missing) console.log('  - ' + p);
}
console.log('config 载荷顶层分组：' + [...groups].sort().join(', '));
if (unknown.length) console.log('⚠️ 未知分组（可能被后端静默丢弃）：' + unknown.join(', '));
if (!missing.length && !unknown.length) {
  console.log('✅ 前端每个接口都有后端分支，每个配置分组都是已知白名单');
  process.exit(0);
}
process.exit(1);
