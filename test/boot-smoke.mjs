// boot-smoke：用假 ctx 真实引导插件服务，并实测面板 HTTP API
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 部署副本里没有宿主平台包（@deepseek-ai/* 由 DSH 运行时提供，插件只带 4 个 vendored 依赖），
// 所以这个用例在部署副本里天然跑不了 —— 明确跳过并说明原因，别让人误以为"交付物有缺陷"。
try {
  createRequire(import.meta.url).resolve('@deepseek-ai/dsh-agent/package.json');
} catch {
  console.log('BOOT-SMOKE 跳过：当前目录没有宿主平台包（@deepseek-ai/*）——这是部署副本的正常状态，');
  console.log('            插件运行时由 DSH 宿主提供这些包；要跑这个用例请在源码工作区里跑。');
  process.exit(0);
}

// 隔离的家目录（不碰真实 ~/.dsh）
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-boot-'));
process.env.DSH_HOME = home;
// 预置 config.json：sidecar 指向死端口 + 关闭自动拉起 → 烟测完全隔离，不碰真实引擎
const companionDir = path.join(home, 'wechat-companion');
fs.mkdirSync(companionDir, { recursive: true });
fs.writeFileSync(path.join(companionDir, 'config.json'), JSON.stringify({ memory: { sidecarUrl: 'http://127.0.0.1:43990' }, system: { autoStartEngine: false } }, null, 2));

// 宽松代理：模拟 DSH 平台服务（settings/llm/tools 等按需存在）
function loose(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => String(name);
      if (k === 'length') return 0;
      if (k === Symbol.iterator) return function* () {};
      return loose(name + '.' + String(k));
    },
    apply() { return loose(name + '()'); },
  });
}

const captured = {};
const ctx = {
  get: (name) => loose(name),
  on: () => {},
  inject(deps, cb) {
    try {
      const sctx = Object.create(ctx);
      if (deps.includes('settings')) {
        const scopes = {};
        sctx.settings = {
          register(ns, schema, opts) {
            const base = (opts && opts.base) || {};
            scopes[ns] = scopes[ns] || { value: { ...base } };
            const sc = scopes[ns];
            return {
              get: () => sc.value,
              watch: (cb2) => { sc._watch = cb2; return () => {}; },
              update: async (patch) => { sc.value = { ...sc.value, ...patch }; if (sc._watch) await sc._watch(sc.value, sc.value); },
              replace: async (sec) => { sc.value = { ...base, ...sec }; },
            };
          },
          documentPath: undefined,
        };
      }
      cb(sctx);
    } catch (e) { console.log('[inject-fail]', deps.join(','), e.message); }
  },
  effect(fn, id) { try { const r = fn(); if (r && r.handler) captured[id || 'web'] = r.handler; } catch (e) { console.log('[effect-fail]', id, e.message); } },
  commands: { register: () => {} },
  logger: { info: (m) => console.log('  [svc]', m), warn: (m) => console.log('  [warn]', m), error: (m) => console.log('  [err]', m) },
  webServer: { register: (r) => r },
};

const { apply } = await import('../src/index.js');
apply(ctx, { enabled: false, dataDir: path.join(home, 'store'), memory: { sidecarUrl: 'http://127.0.0.1:43990' }, system: { autoStartEngine: false } });

const joinRoot = (...parts) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', ...parts);
const handler = captured['wechat-companion: http api route'];if (!handler) throw new Error('HTTP 路由未注册');

function req(method, url, body, headers) {
  const em = new EventEmitter();
  em.method = method; em.url = url;
  em.headers = headers || {};
  if (body !== undefined) {
    process.nextTick(() => { em.emit('data', JSON.stringify(body)); em.emit('end'); });
  } else {
    process.nextTick(() => em.emit('end'));
  }
  return em;
}
function call(method, url, body, headers) {
  return new Promise((resolve) => {
    const res = {
      code: 0, body: '', headers: {},
      writeHead(c, h) { this.code = c; if (h) this.headers = h; },
      end(b) {
        this.body = b || '';
        resolve({ code: this.code, body: this.body, headers: this.headers, json: (() => { try { return JSON.parse(this.body); } catch { return {}; } })() });
      },
    };
    handler(req(method, url, body, headers), res);
  });
}
const ok = (cond, label) => { if (!cond) throw new Error('断言失败: ' + label); console.log('✅', label); };

// 0) 静态检查：HTTP 处理函数里禁止直接用 path 模块
// 事故记录：处理函数里 `const path = url.pathname...` 遮蔽了 node:path，于是 path.join 抛
// "path.join is not a function"，又被 try/catch 悄悄吞掉 → 控制台永远伺服启动时烤进去的旧页面、
// 上传的定稿图读不出来。改用模块作用域的 joinPath/dirNameOf 后修复；这条断言防它复发。
const idxSrc = fs.readFileSync(joinRoot('src', 'index.js'), 'utf8');
const handlerStart = idxSrc.indexOf('const url = new URL(req.url');
const badPathUses = [];
if (handlerStart >= 0) {
  const body = idxSrc.slice(handlerStart);
  for (const m of body.matchAll(/\bpath\.(join|dirname|basename|resolve|extname)\(/g)) {
    const line = body.slice(0, m.index).split('\n').length;
    badPathUses.push('handler+' + line + ':' + m[0]);
  }
}
ok(badPathUses.length === 0, 'HTTP 处理函数内不直接使用 path 模块' + (badPathUses.length ? '（' + badPathUses.join(', ') + '）' : ''));

// 1) 面板配置读写
let r = await call('GET', '/wechat-companion/panel/config');
ok(r.code === 200 && r.json.ok, 'GET panel/config');
r = await call('POST', '/wechat-companion/panel/config', { chat: { baseURL: 'https://api.test.cn', apiKey: 'sk-x', model: 'test-chat' }, ownerPeerId: 'peer_abc', replyToAll: true, blocklist: ['bad_guy'], params: { temperature: 0.9 } });
ok(r.code === 200 && r.json.config.chat.model === 'test-chat', 'POST panel/config 保存');
r = await call('GET', '/wechat-companion/panel/config');
ok(r.json.config.ownerPeerId === 'peer_abc' && r.json.config.blocklist[0] === 'bad_guy', '配置持久化+热读');

// 2) 人设：读/改 + 存档制（无版本号）
r = await call('GET', '/wechat-companion/panel/persona');
ok(r.code === 200 && r.json.persona.name === '小暖', 'GET panel/persona（出厂人设）');
r = await call('POST', '/wechat-companion/panel/persona', { name: '测试酱' });
ok(r.json.persona.name === '测试酱' && r.json.persona.version === undefined, 'POST panel/persona 保存（无版本号）');

// 2b) 人设存档：存/切/改名/删
r = await call('POST', '/wechat-companion/panel/persona/archive', { name: '测试存档' });
ok(r.json.archive && r.json.archive.name === '测试存档', '人设存档');
const archId = r.json.archive.id;
r = await call('POST', '/wechat-companion/panel/persona', { name: '第二形态' });
ok(r.json.persona.name === '第二形态', '保存第二形态');
r = await call('POST', '/wechat-companion/panel/persona/switch', { id: archId });
ok(r.json.persona.name === '测试酱', '一键切换存档');
r = await call('GET', '/wechat-companion/panel/persona/archives');
ok(r.json.archives.some((a) => a.name.indexOf('切换前备份') === 0), '切换前自动备份');
r = await call('POST', '/wechat-companion/panel/persona/rename', { id: archId, name: '改名存档' });
ok(r.json.archive.name === '改名存档', '存档改名');
r = await call('POST', '/wechat-companion/panel/persona/archive-delete', { id: archId });
ok(r.json.ok === true, '存档删除');
// 2c) MBTI 变更 → 六维自动重算（走八维逻辑）
r = await call('POST', '/wechat-companion/panel/persona', { assessments: { mbti: 'ENTP' } });
ok(r.json.persona.traits && r.json.persona.traits.socialBattery > 80 && r.json.persona.traits.orderliness < 40, 'MBTI→六维自动重算（ENTP 高电量低秩序）');

// 3) 记忆：加/查/删（本地JSON兜底——sidecarUrl 指向死端口，引擎不可达）
r = await call('POST', '/wechat-companion/panel/memory', { op: 'add', text: '主人不吃香菜', importance: 5 });
ok(r.json.entries && r.json.entries.length === 1 && r.json.engine === 'local', '记忆添加（本地JSON兜底）');
r = await call('GET', '/wechat-companion/panel/memory');
ok(r.json.entries[0].text === '主人不吃香菜', '记忆读取');
r = await call('POST', '/wechat-companion/panel/memory', { op: 'bucket', id: r.json.entries[0].id, bucket: 'permanent' });
ok(r.json.entries[0].bucket === 'permanent' && r.json.entries[0].bucketLabel === '固化', '记忆固化（桶=permanent）');
r = await call('POST', '/wechat-companion/panel/memory', { op: 'delete', id: r.json.entries[0].id });
ok(r.json.entries.length === 0, '记忆删除（让她忘掉）');

// 4) 状态与启停全周期
r = await call('GET', '/wechat-companion/status');
ok(r.code === 200 && r.json.running === false, 'GET status');
r = await call('POST', '/wechat-companion/enable');
ok(r.json.ok, 'POST enable');
await new Promise((s) => setTimeout(s, 300));
r = await call('GET', '/wechat-companion/status');
ok(r.json.running === true, '服务进入运行态');
r = await call('POST', '/wechat-companion/disable');
await new Promise((s) => setTimeout(s, 300));
r = await call('GET', '/wechat-companion/status');
ok(r.json.running === false, 'POST disable 后停止');

// 5) soul-test：无可用模型时应给出明确错误（证明管线走通）
r = await call('POST', '/wechat-companion/panel/soul-test', { text: '在干嘛' });
ok(r.code === 500 && String(r.json.error).includes('对话模型'), 'soul-test 管线走通（无模型→明确报错）');

// 6) models 拉取：错误 baseURL 应明确报错
r = await call('POST', '/wechat-companion/panel/models', { baseURL: 'https://127.0.0.1:9', apiKey: '' });
ok(r.code === 500, 'panel/models 对不可达端点明确报错');

// 7) 她的房间网页
r = await call('GET', '/wechat-companion/room');
ok(r.code === 200 && String(r.body).includes('她的房间'), '她的房间网页可访问');
r = await call('GET', '/wechat-companion/');
ok(r.code === 200 && String(r.body).includes('她的房间'), '根路径同样服务房间');

// 8) soul-test record 模式（写入对话历史）
r = await call('POST', '/wechat-companion/panel/soul-test', { text: '你好呀', record: true });
ok(r.code === 500, 'record模式管线走通（无模型→报错）');

// 9) 形象工坊 + 相册 + 六个接口体检 + 她自己改称呼（新一批功能的路由层）
r = await call('GET', '/wechat-companion/panel/avatar');
ok(r.code === 200 && Array.isArray(r.json.refs) && r.json.refs.length === 0, 'GET panel/avatar（空档案 + 引导语：' + (r.json.hint ? '有' : '无') + '）');
const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
r = await call('POST', '/wechat-companion/panel/avatar/upload', { dataBase64: tinyPng, mime: 'image/png', angle: '正面' });
ok(r.code === 200 && r.json.ref && r.json.ref.url, '上传形象定稿图（返回可预览 url）');
const refId = r.json.ref.id;
r = await call('GET', '/wechat-companion/panel/avatar');
ok(r.json.refs.length === 1 && r.json.mainId === refId, '档案里出现这张图且成为主图');
r = await call('GET', '/wechat-companion/panel/avatar/file?id=' + refId);

ok(r.code === 200 && /^image\//.test(String(r.headers['content-type'] || '')), '头像文件接口能出图（' + r.headers['content-type'] + '）');
r = await call('POST', '/wechat-companion/panel/avatar/upload', { dataBase64: tinyPng, mime: 'application/pdf' });
ok(r.code === 400 && /只支持/.test(r.json.error), '上传非图片 → 明确拒绝');
r = await call('POST', '/wechat-companion/panel/avatar/setmain', { id: 'nope' });
ok(r.code === 400, '设置不存在的主图 → 明确报错');
r = await call('POST', '/wechat-companion/panel/album/generate', { scene: '测试', mode: 'i2i' });
ok(r.code === 400 && /生图接口没配好/.test(r.json.error), '生图未配置 → 指路（不静默失败）');
r = await call('POST', '/wechat-companion/panel/album/send', { id: 'nope' });
ok(r.code === 400 && /找不到这张照片/.test(r.json.error), '发送不存在的照片 → 明确报错');
r = await call('GET', '/wechat-companion/panel/album');
ok(r.code === 200 && Array.isArray(r.json.items), 'GET panel/album（相册列表）');
r = await call('POST', '/wechat-companion/panel/avatar/delete', { id: refId });
ok(r.code === 200 && r.json.refs === 0, '删除定稿图');
r = await call('POST', '/wechat-companion/panel/model-test', { role: 'chat', deep: false, form: { baseURL: 'https://127.0.0.1:9/v1', apiKey: 'k', model: 'm' } });
ok(r.code === 200 && r.json.ok === false && r.json.ms >= 0, '接口体检：不可达地址 → ok=false（带耗时与原因）');
r = await call('POST', '/wechat-companion/panel/model-test', { role: 'image', deep: true, form: {} });
ok(r.code === 200 && r.json.ok === false, '接口体检：生图未配置 → 明确提示去哪里配');
r = await call('POST', '/wechat-companion/panel/rename/lock', { locked: true });
ok(r.code === 200 && r.json.locked === true, '锁死「她自己改称呼」');
r = await call('POST', '/wechat-companion/panel/rename/now', {});
ok(r.code === 400 && /锁死/.test(r.json.error), '锁死后手动触发改名 → 明确拒绝');
r = await call('POST', '/wechat-companion/panel/rename/lock', { locked: false });
ok(r.code === 200 && r.json.locked === false, '解锁');
r = await call('POST', '/wechat-companion/panel/config', { job: { type: 'office', intensity: 1.5, workStart: '9:00', toNpc: false } });
ok(r.code === 200 && r.json.config.job.type === 'office' && r.json.config.job.intensity === 1.5 && r.json.config.job.workStart === '09:00', '职业机制配置可保存（含时间格式化）');
r = await call('POST', '/wechat-companion/panel/config', { job: { type: '乱填的', intensity: 99 } });
ok(r.code === 200 && r.json.config.job.type === 'office' && r.json.config.job.intensity === 1.5, '非法职业参数被挡掉（保留原值）');

// 10) 生日 → 年龄/星座（后台得到的推算结果）+ 职业自动判断
r = await call('POST', '/wechat-companion/panel/persona', { birthday: '1999-03-14' });
ok(r.code === 200 && r.json.persona.birthday === '1999-03-14', '保存生日');
r = await call('GET', '/wechat-companion/panel/persona');
ok(r.json.derived && r.json.derived.birthday.zodiac === '双鱼座' && typeof r.json.derived.age === 'number', '后台返回推算结果（' + r.json.derived.birthday.zodiac + ' · ' + r.json.derived.age + ' 岁）');
ok(r.json.persona.age === String(r.json.derived.age), '年龄自动写成生日算出来的值（不再手填）');
r = await call('POST', '/wechat-companion/panel/persona', { birthday: '03-14' });
r = await call('GET', '/wechat-companion/panel/persona');
ok(r.json.derived.birthday.zodiac === '双鱼座' && r.json.derived.birthday.age === null, '只填月日 → 星座有、年龄 null（提示要补年份）');
r = await call('POST', '/wechat-companion/panel/persona', { birthday: '乱写' });
r = await call('GET', '/wechat-companion/panel/persona');
ok(r.json.derived.birthday.valid === false && /1999-03-14/.test(r.json.derived.birthday.hint), '乱填生日 → 后端给出格式示例');
r = await call('POST', '/wechat-companion/panel/job/infer', { job: '在三甲医院当护士，三班倒' });
ok(r.code === 200 && r.json.ok && r.json.job && r.json.job.type, '职业自动判断走通（' + (r.json.job && r.json.job.label) + ' / 来源 ' + (r.json.job && r.json.job.source) + '）');
const jobOut = r.json.job || {};
ok(!!(r.json.config && r.json.config.type) && r.json.config.inferredFrom === '在三甲医院当护士，三班倒', '判断结果写进配置（后台可见）');
r = await call('POST', '/wechat-companion/panel/job/infer', {});
ok(r.code === 200 && r.json.ok && r.json.job.type === 'none', '职业为空 → 明确判成"无固定工作"（不编作息）');

// 11) 一键重置：勾选范围 + 先备份 + 不勾不删
r = await call('POST', '/wechat-companion/panel/memory', { op: 'add', text: '他不吃香菜', importance: 3 });
ok(r.json.ok === true, '重置前先塞一条记忆进去');
r = await call('POST', '/wechat-companion/panel/reset', { backup: true });
ok(r.json.ok === true && Object.keys(r.json.removed || {}).length === 0, '什么都没勾 → 什么都不删（安全默认）');
r = await call('POST', '/wechat-companion/panel/reset', { memory: true, backup: true });
ok(r.json.ok === true && /条/.test(String((r.json.removed || {}).memory)), '勾了记忆 → 报告删了几条（' + (r.json.removed || {}).memory + '）');
ok(!!r.json.backupDir && fs.existsSync(r.json.backupDir), '勾了"先备份" → 备份目录真的存在');
r = await call('GET', '/wechat-companion/panel/memory');
ok((r.json.entries || []).length === 0, '清理后记忆为 0 条');
r = await call('POST', '/wechat-companion/panel/reset', { history: true, relation: true, life: true, backup: false });
ok(r.json.ok === true && r.json.removed.history && r.json.removed.relation && r.json.removed.life, '聊天上下文/关系/生活都能单独清，并逐项报告');
ok(!r.json.backupDir, '不勾备份 → 不产生备份目录');
// 记忆文件形状必须正确：曾经写成裸数组 [] → 她一说话就 "mem.entries.filter is not a function"
const memFile = path.join(home, 'wechat-companion', 'memory.json');
const rawMem = JSON.parse(fs.readFileSync(memFile, 'utf8'));
ok(!Array.isArray(rawMem) && Array.isArray(rawMem.entries), '重置后 memory.json 是 {entries:[],todos:[]} 形状（不是裸数组）');
r = await call('POST', '/wechat-companion/panel/soul-test', { text: '在吗' });
ok(String(r.json.error || '').indexOf('filter') < 0, '重置后回话不再报 filter 错误（无模型时应是"对话模型"这类错误）');
// 容错：把文件故意写成裸数组/坏值，读取也不该崩
fs.writeFileSync(memFile, '[]', 'utf8');
r = await call('POST', '/wechat-companion/panel/memory', { op: 'add', text: '容错测试' });
ok(r.json.ok === true && (r.json.entries || []).length >= 1, '记忆文件是裸数组时也能正常写入（自动规整）');
fs.writeFileSync(memFile, '不是JSON', 'utf8');
r = await call('GET', '/wechat-companion/panel/memory');
ok(r.json.ok === true, '记忆文件是坏内容时读取也不崩');

// 12) 顺位链：后台界面保存的链必须真能存住（否则就是"显示已保存其实不生效"的黑盒）
r = await call('POST', '/wechat-companion/panel/config', { chain: { chat: [
  { baseURL: 'https://a.example/v1', apiKey: 'k1', model: 'M-1' },
  { baseURL: 'https://b.example/v1', apiKey: 'k2', model: 'M-2' },
  { baseURL: 'https://c.example/v1', apiKey: 'k3', model: 'M-3' },
] } });
ok(r.json.ok === true, '保存对话链');
r = await call('GET', '/wechat-companion/panel/config');
{
  const l = ((r.json.config || {}).chain || {}).chat || [];
  ok(l.length === 3 && l[0].model === 'M-1' && l[2].model === 'M-3', '对话链三条按顺位存住（' + l.map((x) => x.model).join('→') + '）');
  ok(l[0].apiKey === 'k1', '每槽的密钥也各自存住（不是共用一把）');
}
r = await call('POST', '/wechat-companion/panel/config', { chain: { world: [
  { baseURL: 'https://w1/v1', model: 'W-1' }, { baseURL: 'https://w2/v1', model: 'W-2' }, { baseURL: 'https://w3/v1', model: 'W-3' }, { baseURL: 'https://w4/v1', model: 'W-4' },
] } });
r = await call('GET', '/wechat-companion/panel/config');
ok((((r.json.config || {}).chain || {}).world || []).length === 3, '超过三槽会被截到三个（每个接口三个槽就够）');

// ── 远程访问口令（内网穿透的门锁，2026-09-14）──
{
  let r = await call('POST', '/wechat-companion/panel/config', { security: { accessKey: 'key-abc-123' } });
  ok(r.code === 200, '设口令：能保存');
  r = await call('GET', '/wechat-companion/panel/features');
  ok(r.code === 401, '设了口令后，不带口令的请求被拒（401）');
  r = await call('GET', '/wechat-companion/panel/features?key=key-abc-123');
  ok(r.code === 200, '带对口令（?key=）放行');
  r = await call('GET', '/wechat-companion/panel/features?key=wrong-key');
  ok(r.code === 401, '口令不对照样拒');
  r = await call('GET', '/wechat-companion/panel/features', undefined, { 'x-access-key': 'key-abc-123' });
  ok(r.code === 200, '用 X-Access-Key 头也认');
  r = await call('GET', '/wechat-companion/console');
  ok(r.code === 401 && /口令/.test(r.body), '直接打开后台页会被拦住，并告诉你怎么带口令');
  r = await call('GET', '/wechat-companion/panel/config?key=key-abc-123');
  ok(r.code === 200 && String((((r.json.config || {}).security) || {}).accessKey || '') === '', '后台接口不吐口令原文');
  ok(r.json.accessKeySet === true, '只告诉"设了没有"（后台据此显示状态）');
  r = await call('POST', '/wechat-companion/panel/config?key=key-abc-123', { security: { accessKey: '' } });
  ok(r.code === 200, '清口令：能保存');
  r = await call('GET', '/wechat-companion/panel/features');
  ok(r.code === 200, '清掉口令后一切照旧（本机使用完全不校验）');
}

console.log('\nBOOT-SMOKE ALL GREEN ✅  家目录: ' + home);


// 显式退出（2026-09-13 修）：本测试会拉起定时器 / 向量预热等后台任务，事件循环不会自己空掉
// → 进程跑完不退出，外部看起来就是"烟测卡死"。断言失败时上面的 throw 会让进程以非 0 退出，
// 只有全绿才会执行到这里，所以这里就是"成功退出"的唯一出口。
process.exit(0);
