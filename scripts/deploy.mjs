// 部署：把 dsh-wechat-companion 同步到 desktop profile
// 用法：node scripts/deploy.mjs [--register]
//   默认：只复制文件（不激活，安全）
//   --register：复制并在 profile 注册（重启 DSH Desktop 后生效）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profile = path.join(HOME, 'profiles', 'desktop');
const dst = path.join(profile, 'node_modules', 'dsh-wechat-companion');
const src = path.resolve(import.meta.dirname, '..');

function copyDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
}

// 1) 同步代码（不带本地测试桩 node_modules，只带运行必需的三个 vendored 依赖）
// test 与 docs 也一起同步：部署副本要能自己跑回归与真渲染自查（以前不同步 test，
// 结果副本里的 test/ 是很久以前的旧货，连 run-all.mjs 都没有，复核时直接 MODULE_NOT_FOUND）。
for (const item of ['src', 'client', 'python', 'test', 'docs', 'scripts', 'package.json', 'cordis.patch.yml', 'README.md', 'NOTICE.md']) {
  const s = path.join(src, item);
  const d = path.join(dst, item);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.rmSync(d, { recursive: true, force: true });
  fs.cpSync(s, d, { recursive: true, dereference: true });
}
for (const v of ['qrcode', 'pngjs', 'dijkstrajs', 'silk-wasm']) {
  const s = path.join(src, 'node_modules', v);
  const d = path.join(dst, 'node_modules', v);
  if (fs.existsSync(s)) { fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(s, d, { recursive: true, dereference: true }); }
}
// 1.5) 用户手动启动脚本（记忆引擎/wxauto 桥）
for (const bat of ['启动记忆引擎.bat', '启动wxauto通道.bat']) {
  const s = path.join(src, bat);
  if (fs.existsSync(s)) fs.cpSync(s, path.join(dst, bat));
}
console.log('[deploy] 代码已同步 → ' + dst);

// 2) 注册（可选）
if (process.argv.includes('--register')) {
  const pjPath = path.join(profile, 'package.json');
  const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  pj.dependencies = pj.dependencies || {};
  pj.dependencies['dsh-wechat-companion'] = 'file:' + src.split(path.sep).join('/');
  pj.dsh = pj.dsh || {};
  pj.dsh.profile = pj.dsh.profile || {};
  const bundles = pj.dsh.profile.bundles = pj.dsh.profile.bundles || [];
  if (!bundles.includes('dsh-wechat-companion')) bundles.push('dsh-wechat-companion');
  fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));
  console.log('[deploy] 已注册进 desktop profile。重启 DSH Desktop 后生效。');
} else {
  console.log('[deploy] 仅同步未注册（--register 可激活）');
}
