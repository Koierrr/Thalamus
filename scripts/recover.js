// 紧急恢复：从 desktop profile 移除 dsh-wechat-companion 注册
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const pjPath = path.join(HOME, 'profiles', 'desktop', 'package.json');
const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
let changed = false;
if (pj.dependencies && pj.dependencies['dsh-wechat-companion']) { delete pj.dependencies['dsh-wechat-companion']; changed = true; }
if (pj.dsh && pj.dsh.profile && Array.isArray(pj.dsh.profile.bundles)) {
  const before = pj.dsh.profile.bundles.length;
  pj.dsh.profile.bundles = pj.dsh.profile.bundles.filter((b) => b !== 'dsh-wechat-companion');
  if (pj.dsh.profile.bundles.length !== before) changed = true;
}
if (changed) fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));
const dst = path.join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-wechat-companion');
try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
console.log(changed ? '已移除注册 + 文件。现在重新打开 DSH Desktop 即可。' : '本来就没有注册，无需恢复。');
