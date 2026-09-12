// run-all.mjs — 全量回归总入口（2026-09-13 加）
// 为什么需要它：以前我是用一个 for 循环挨个跑 25 个烟测，只要**任何一个**测试跑完不退出
// （定时器/向量预热让事件循环不空），整个 for 就卡在那里，表现为"烟测卡死"、整轮白等。
// 现在：一个测试一个子进程 + 每个都带硬超时，卡住的会被杀掉并单独标记，其余照跑。
//
// 用法：~/.dsh/electron/electron.exe test/run-all.mjs [超时秒数]
//      （必须带 ELECTRON_RUN_AS_NODE=1，因为要当 node 用）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const TIMEOUT_MS = Math.max(10, Number(process.argv[2] || process.env.SMOKE_TIMEOUT || 120)) * 1000;

// 顺序：先核心（灵魂/通道/记忆），再世界与生活，再界面与审计
const FILES = [
  'boot-smoke', 'console-smoke', 'chain-smoke', 'tone-life-smoke', 'life-smoke',
  'night-smoke', 'rhythm-smoke', 'world-smoke', 'diary-smoke', 'deform-memory-smoke', 'deform-traits-smoke',
  'memory-voice-smoke', 'inbound-smoke', 'interest-smoke', 'day-event-smoke', 'rename-smoke',
  'model-test-smoke', 'job-smoke', 'job-infer-smoke', 'avatar-smoke', 'birthday-smoke',
  'moments-smoke', 'workshop-smoke', 'backup-smoke', 'embed-smoke', 'voice-smoke',
  'audit-config', 'audit-api', 'audit-features',
];

const results = [];
for (const name of FILES) {
  const file = path.join(root, 'test', name + '.mjs');
  if (!fs.existsSync(file)) { results.push({ name, state: 'MISSING' }); console.log('⏭  ' + name + '（文件不存在，跳过）'); continue; }
  const t0 = Date.now();
  const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let timedOut = false;
  const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, TIMEOUT_MS);
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  const code = await new Promise((res) => child.on('close', (c) => res(c)));
  clearTimeout(killer);
  const ms = Date.now() - t0;
  const tail = out.trim().split('\n').slice(-1)[0] || '';
  const state = timedOut ? 'TIMEOUT' : (code === 0 ? 'PASS' : 'FAIL');
  results.push({ name, state, code, ms, tail });
  console.log((state === 'PASS' ? '✅ ' : state === 'TIMEOUT' ? '⏱ ' : '❌ ') + name + '  ' + ms + 'ms  ' + tail.slice(0, 120));
  if (state !== 'PASS') {
    // 失败/卡死才把最后的输出全部亮出来，方便定位
    console.log(out.trim().split('\n').slice(-12).map((l) => '     | ' + l).join('\n'));
  }
}

const pass = results.filter((r) => r.state === 'PASS').length;
const bad = results.filter((r) => r.state !== 'PASS');
console.log('\n════════ 全量回归：' + pass + '/' + results.length + ' 通过 ════════');
if (bad.length) {
  console.log('未通过：' + bad.map((b) => b.name + '(' + b.state + ')').join('、'));
  process.exit(1);
}
console.log('全绿 ✅  单测超时上限：' + (TIMEOUT_MS / 1000) + ' 秒');
process.exit(0);
