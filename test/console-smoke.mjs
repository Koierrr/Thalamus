// console-smoke.mjs — 控制台前端"跑得起来"回归（轻量 DOM 桩）
// 作用：把 src/console.html 里的脚本放进一个假浏览器跑一遍，逐个页签渲染，
//      抓运行时异常（undefined 函数、错误 DOM 用法、改名后的漏改引用）。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/console-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const html = fs.readFileSync(path.join(root, 'src/console.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---------- 轻量 DOM ----------
function matches(el, sel) {
  const m = sel.match(/^([a-zA-Z]*)((\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const attr of (m[2].match(/\[[^\]]+\]/g) || [])) {
    const body = attr.slice(1, -1);
    const [k, v] = body.split('=');
    if (k === 'type') { if (el.attrs.type !== v) return false; }
    else if (el.dataset[k] === undefined) return false;
  }
  return true;
}
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.style = {}; this.dataset = {}; this.attrs = {};
    this.className = ''; this._text = ''; this._html = ''; this._value = undefined;
    this.open = false; this.disabled = false; this.checked = false; this.rows = 0;
    this.href = ''; this.src = ''; this.placeholder = ''; this.title = ''; this.id = '';
  }
  appendChild(c) { this.children.push(c); return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  // 与真浏览器一致：设 innerHTML / textContent 都会清掉原有内容与文字
  set innerHTML(v) { this._html = String(v); this.children = []; this._text = ''; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); this._html = ''; this.children = []; }
  get textContent() { return this._text || this._html.replace(/<[^>]*>/g, ''); }
  get firstChild() { return this.children[0] || null; }
  get previousSibling() { return null; }
  get nextSibling() { return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of (n.children || [])) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { if (typeof this.onclick === 'function') this.onclick({}); }
  focus() {}
  addEventListener() {}
  get value() { return this._value !== undefined ? this._value : (this.attrs.value || ''); }
  set value(v) { this._value = v; }
  get classList() { const self = this; return { add: (c) => { self.className = (self.className + ' ' + c).trim(); }, remove: () => {}, toggle: () => {} }; }
}
const byId = {};
const document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  getElementById: (id) => (byId[id] = byId[id] || Object.assign(new El('div'), { id })),
  querySelectorAll: () => [],
  querySelector: () => null,
  body: new El('body'),
};
const store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const fetchLog = [];
let fetchStub = null;
const fetchImpl = async (url, opts) => {
  fetchLog.push(String(url));
  const body = fetchStub ? fetchStub(String(url), opts) : {};
  return { ok: true, status: 200, json: async () => body };
};
const alertLog = [];
const noop = () => {};

// ---------- 执行控制台脚本 ----------
const factory = new Function('window', 'document', 'fetch', 'alert', 'prompt', 'confirm', 'setInterval', 'clearInterval', 'navigator', 'localStorage', 'Blob', 'URL',
  script + '\n;return { go: go, TABS: TABS };');
let hooks;
try {
  hooks = factory(
    { localStorage, prompt: () => null, confirm: () => false, location: {} },
    document, fetchImpl, (m) => alertLog.push(String(m)), () => null, () => false,
    () => 0, noop, {}, localStorage,
    function Blob() {}, { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
  );
} catch (e) {
  console.log('❌ 控制台脚本初始化抛错: ' + e.message);
  process.exit(1);
}
console.log('✅ 控制台脚本可初始化（init 渲染无异常）');

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ---------- 静态检查①：不许用局部 var 覆盖控制台的全局小工具名 ----------
// 事故记录：tPersona 里写了 var bar=document.createElement('div')，函数级作用域把全局 bar() 帮助函数顶掉，
// 于是「她的状态·当前状态」里 bar(...) 变成"把 div 当函数调用"→异常被 .catch 吞掉→只显示"（加载失败）"，没人发现。
const HELPERS = ['bar', 'metric', 'tbl', 'card', 'row', 'mut', 'bx', 'esc', 'inp', 'btn', 'tagEl', 'metricsWrap', 'secBlock', 'itemBlock', 'tocFor', 'api', 'go', 'f'];
const shadowed = [];
for (const h of HELPERS) {
  const re = new RegExp('\\bvar\\s+' + h + '\\s*=', 'g');
  let m;
  while ((m = re.exec(script))) shadowed.push(h);
}
ok(shadowed.length === 0, '没有局部变量覆盖控制台全局工具名' + (shadowed.length ? '（覆盖了：' + [...new Set(shadowed)].join('、') + '）' : ''));

// 假数据：覆盖后端各接口的返回形状
fetchStub = (url) => {
  const u = url.replace(/^.*\/wechat-companion\//, '');
  if (u.startsWith('status')) return { running: true, accounts: [{ accountId: 'a1', name: '小号', enabled: true, hasToken: true }], knownPeers: ['p1'] };
  if (u.startsWith('panel/persona/archives')) return { archives: [{ id: 'x1', name: '存档A', savedAt: Date.now(), personaName: '小暖' }] };
  if (u.startsWith('panel/persona')) return { persona: { name: '小暖', birthday: '3-14', city: '杭州', job: '插画师', age: '24', personaText: 'bg', interests: ['拼图'], quirks: { catchphrases: ['好呀'], emojiRate: 0.4, typoRate: 0 }, behavior: {}, relationship: {}, traits: {}, assessments: { mbti: 'INFP' } } };
  if (u.startsWith('panel/config')) return { config: { world: { baseURL: 'https://w', model: 'm' }, deform: { enabled: true }, life: { pokeWindow: ['10:00', '22:00'] }, memory: {}, system: {}, channel: {}, media: {} } };
  if (u.startsWith('panel/today')) return { today: { wake: '08:00', sleep: '23:30', mood: 60, battery: 70, chatter: 1, focus: '拼图', events: [], traitDrift: { warmth: 3 } }, deform: { state: 'normal', stress: 10, integration: 4, thresholds: { grip: 45, loop: 70, shadow: 88 } }, world: { weather: '小雨，12~19°C', weatherSource: 'real', npcs: [{ name: '张姐', rel: '同事', note: '爱八卦' }], longterm: [{ text: '学吉他' }], thoughts: ['想他'], secrets: ['藏了糖'], flow: [{ time: '10:00', text: '晨跑' }] }, evolution: { warm: 3, rude: 1, chats: 40 } };
  if (u.startsWith('panel/activity')) return { inboundCount: 3, lastInboundAt: Date.now(), activity: [{ at: Date.now(), text: '来消息了' }] };
  if (u.startsWith('panel/memory')) return { engine: 'mem0', entries: [{ id: 'm1', text: '主人不吃香菜', ts: Date.now(), who: 'p1', source: 'manual' }, { id: 'm2', text: '我下周要去杭州', ts: Date.now(), who: 'self', source: 'self' }], relations: { 'p1': { chats: 42, lastSeen: Date.now() } } };
  if (u.startsWith('panel/mem-engine')) return { running: true, info: { ready: true } };
  if (u.startsWith('panel/wxauto/status')) return { mode: 'clawbot', enabled: false, bridge: { ready: false } };
  if (u.startsWith('panel/features')) return { groups: [{ name: '聊天', items: [{ id: 'chat', name: '文字聊天', status: 'done', detail: 'd' }] }] };
  if (u.startsWith('panel/avatar')) return { refs: [{ id: 'r1', file: 'r1.png', angle: '正面', bytes: 1024, addedAt: Date.now(), url: 'panel/avatar/file?id=r1' }], mainId: 'r1', appearance: { face: '圆脸' }, albumCount: 1, canGenerate: true, hint: '' };
  if (u.startsWith('panel/album')) return { items: [{ id: 'p1', file: 'p1.png', scene: '咖啡店', mode: 'i2i', createdAt: Date.now(), bytes: 2048, url: 'panel/album/file?id=p1' }] };
  if (u.startsWith('panel/moments')) return { drafts: [{ id: 'd1', text: '文案', createdAt: Date.now(), status: 'draft', images: [] }] };
  if (u.startsWith('panel/diary')) return { ok: true, days: ['2026-09-12', '2026-09-11'], markdown: '# 2026-09-12 她的日记\n\n## 📔 她的话（私人日记）\n\n周末还是没能完全躺平。\n', latest: { date: '2026-09-12', forDate: '2026-09-13', diary: '周末还是没能完全躺平。', generatedAt: Date.now() } };
  if (u.startsWith('panel/workshop/sessions')) return { sessions: [{ id: 's1', title: '新造人', updatedAt: Date.now() }] };
  if (u.startsWith('panel/workshop/session')) return { session: { id: 's1', messages: [], draft: { name: '小暖', assessments: { mbti: 'INFP' } } } };
  return {};
};

// ---------- 逐个页签渲染 ----------
for (const tab of hooks.TABS) {
  fetchLog.length = 0; alertLog.length = 0;
  try {
    hooks.go(tab.id);
    // 等异步渲染（fetch 是 async 的）跑完
    await new Promise((r) => setTimeout(r, 30));
    const main = byId['main'];
    const htmlLen = JSON.stringify(main.children.map((c) => c.tagName)).length;
    ok(true, '页签「' + tab.name + '」渲染无异常（节点 ' + main.children.length + ' 个）');
    ok(alertLog.length === 0, '页签「' + tab.name + '」无 alert 报错' + (alertLog.length ? '：' + alertLog[0] : ''));
  } catch (e) {
    ok(false, '页签「' + tab.name + '」渲染抛错: ' + e.message);
  }
}

// ---------- 分区结构断言（每个已铺开的页签） ----------
const EXPECT = { home: 4, persona: 7, world: 7, relation: 3, memory: 4, brain: 3, nwa: 5, ops: 4 };
for (const tabId of Object.keys(EXPECT)) {
  fetchLog.length = 0; alertLog.length = 0;
  hooks.go(tabId);
  await new Promise((r) => setTimeout(r, 60));
  const mainEl = byId['main'];
  const all = [];
  const walk = (n) => { for (const c of (n.children || [])) { all.push(c); walk(c); } };
  walk(mainEl);
  const secs = all.filter((e) => e.tagName === 'DETAILS' && e.className === 'sec');
  const items = all.filter((e) => e.tagName === 'DETAILS' && e.className === 'item');
  const tocLinks = all.filter((e) => e.tagName === 'A' && e.href && String(e.href).indexOf('#') === 0);
  const titles = secs.map((x) => { const sm = x.children[0]; const t = sm && sm.children && sm.children[0]; return (t && t.textContent) || ''; });
  ok(secs.length === EXPECT[tabId], tabId + ' 分区数 = ' + EXPECT[tabId] + '（实际 ' + secs.length + '）');
  const openCount = secs.filter((x) => x.open === true).length;
  ok(openCount >= secs.length - 1, tabId + ' 大分区默认展开（除个别默认收起：' + openCount + '/' + secs.length + '）');
  if (tabId !== 'home') ok(items.length >= 1, tabId + ' 小项已折叠化（共 ' + items.length + ' 个）');
  ok(tocLinks.length === secs.length, tabId + ' 左侧目录项数 = 分区数（' + tocLinks.length + '）');
  ok(alertLog.length === 0, tabId + ' 渲染无 alert 报错' + (alertLog.length ? '：' + alertLog[0] : ''));
  if (tabId === 'persona') ok(titles.join('/').indexOf('她是谁') >= 0 && titles.join('/').indexOf('存档') >= 0, '她页分区标题正确：' + titles.join(' / '));
}

// ---------- 内容完整性：每个页签都必须真的有字段/卡片（防"被别的页清空"这类竞态回归） ----------
const MUST_HAVE_FIELDS = { home: 1, persona: 10, world: 3, relation: 2, memory: 5, brain: 10, nwa: 3, ops: 5 };
for (const tabId of Object.keys(MUST_HAVE_FIELDS)) {
  hooks.go(tabId);
  await new Promise((r) => setTimeout(r, 60));
  const all = [];
  const walk2 = (n) => { for (const c of (n.children || [])) { all.push(c); walk2(c); } };
  walk2(byId['main']);
  const fields = all.filter((e) => /(^|\s)f(\s|$)/.test(String(e.className || '')) && (e.children || []).some((k) => k.tagName === 'LABEL'));
  const cards = all.filter((e) => /(^|\s)card(\s|$)/.test(String(e.className || '')) || /(^|\s)sec(\s|$)/.test(String(e.className || '')));
  ok(fields.length >= MUST_HAVE_FIELDS[tabId], tabId + ' 字段数 = ' + fields.length + '（至少 ' + MUST_HAVE_FIELDS[tabId] + '）');
  ok(cards.length >= 1, tabId + ' 至少有 1 个卡片/分区（实际 ' + cards.length + '）');
}

// ---------- 异步渲染完整性：不许出现「加载失败 / 读取失败 / 加载中…」残留 ----------
// 每个异步渲染块都有自己的 .catch，出错时只往页面上写一句"加载失败"——肉眼不看就永远不知道。
// 这一层专门抓这种"静默失败"：只要页面上出现这些字，就是有块没渲染成功。
for (const tabId of Object.keys(EXPECT)) {
  hooks.go(tabId);
  await new Promise((r) => setTimeout(r, 80));
  const nodes = [];
  const walk3 = (n, p) => {
    for (const c of (n.children || [])) {
      const sm = c.tagName === 'DETAILS' && c.children[0] ? '（' + ((c.children[0].children[0] || {}).textContent || '') + '）' : '';
      const np = p + ' > ' + (c.className || c.tagName) + sm;
      c.__path = np; nodes.push(c); walk3(c, np);
    }
  };
  walk3(byId['main'], 'main');
  const bad = nodes.filter((e) => /加载失败|读取失败|加载中/.test(e._text || '')).map((e) => (e._text || '').slice(0, 24) + '[在 ' + e.__path + ']');
  ok(bad.length === 0, tabId + ' 异步数据全部加载成功' + (bad.length ? '（' + bad.slice(0, 3).join(' ｜ ') + '）' : ''));
}

// ── 交付物守卫：后台是给用户看的成品，不许出现我的备注口吻 ──
{
  const BAD = ['两处打架', '已删掉', '被用户抓', '我踩过', '旧的三件套', '顺位链已取代'];
  const hit = BAD.filter((w) => html.includes(w));
  ok(hit.length === 0, '界面文案干净（无备注口吻）' + (hit.length ? ('：发现 ' + hit.join('、')) : ''));
}

// ── 防"残留空壳/旧控件"（用户抓到过两次）：结构断言 ──
{
  ok(!/itemBlock\('顺位'/.test(html), '没有多余的「顺位」条目（标题只写接口名）');
  ok(!/itemBlock\('对话接口 · 她的大脑'/.test(html), '没有旧的对话空壳条目');
  const gates = (html.match(/if\(role!==.image.&&role!==.vision.\)/g) || []).length;
  ok(gates >= 5, '生图/识图的旧控件全部屏蔽（地址/密钥/模型名/拉取/旧体检，共 ' + gates + ' 处）');
}

// ── 第三次改版守卫（2026-09-13）：下面每一条坑都真实发生过，用断言钉死 ──
{
  const txtOf = async (tabId, ms = 130) => {
    hooks.go(tabId);
    await new Promise((r) => setTimeout(r, ms));
    const acc = [];
    const walk = (n) => { for (const c of (n.children || [])) { if (c._text) acc.push(c._text); walk(c); } };
    walk(byId['main']);
    return acc.join('\n');
  };

  // ① 女娲 API：BaseURL / API Key 必须真的显示出来（曾经被 display:none 藏了：按钮看得见、输入框看不见）
  ok(!/_lg1|_lg2/.test(html), '女娲 API 不再用 display:none 藏输入框');
  const nwaTxt = await txtOf('nwa');
  ok(/BaseURL/.test(nwaTxt) && /API Key/.test(nwaTxt) && /保存女娲API/.test(nwaTxt), '女娲 API 的 BaseURL / API Key / 保存按钮都在页面上');

  // ② 「她怎么说话」的 emoji 与手滑滑杆必须渲染出来（曾经被一段没闭合的注释吞掉）
  const personaTxt = await txtOf('persona');
  ok(/她用 emoji 的频率/.test(personaTxt), '「她怎么说话」里有 emoji 频率滑杆');
  ok(/手滑打错字概率/.test(personaTxt), '「她怎么说话」里有手滑概率滑杆');
  ok(!/改成滑杆 \+ 百分比/.test(html), '那段没闭合注释的坑不会再回来（标志性文字已清掉）');

  // ③ 一键重置必须真挂在「提炼设置」分区里
  const memTxt = await txtOf('memory');
  ok(/一键重置（危险）/.test(memTxt) && /执行重置/.test(memTxt), '「一键重置」和「执行重置」都在记忆页上');

  // ④ 记忆页不许再有重复的「用哪个模型整理记忆」条目（已并进「记忆提炼接口」）
  ok(!/itemBlock\('用哪个模型整理记忆'/.test(html), '记忆页重复条目「用哪个模型整理记忆」已合并');
  ok(/itemBlock\('记忆提炼接口'/.test(html), '合并后的家「记忆提炼接口」还在');

  // ⑤ 向量接口：地址回显 + 自动识别；那个会跟地址打架的「向量来源」下拉已删除
  const brainTxt = await txtOf('brain');
  ok(/向量服务地址/.test(brainTxt), '向量接口有「向量服务地址」输入框（回显真实值）');
  ok(/识别结果：/.test(brainTxt), '向量接口会自动识别本地/云端');
  ok(/记忆引擎实际在用/.test(brainTxt), '向量接口如实显示记忆引擎实际在用什么（禁黑盒）');
  ok(!/f\('向量来源'/.test(html) && !/sourceSelect/.test(html), '「向量来源」下拉及其死代码已删除');

  // ⑥ 你们页：备注名入口在，已退场的概念不许再出现
  const relTxt = await txtOf('relation');
  ok(/起个备注名/.test(relTxt), '所有联系人有「起个备注名」入口');
  ok(/ID：/.test(relTxt), '联系人显示原始 ID（起名字之前你认得出是谁）');
  ['关系阶段', '亲密度'].forEach((w) => ok(!relTxt.includes(w) && !html.includes(w), '已退场的「' + w + '」不再出现在后台'));
  ok(!/itemBlock\('他是谁/.test(html) && !relTxt.includes('他是谁'), '「他是谁」条目已删除（她从零认识你）');

  // ⑦ 画像只能由世界引擎写：后台只读、没有手改按钮
  ok(/pi\.readOnly=true/.test(html), '画像输入框是只读的');
  const worldTxt = await txtOf('world');
  ok(!/保存画像/.test(worldTxt), '画像不再有手改按钮（免得被当晚重写＝白改）');
  ok(/只能由世界引擎写/.test(worldTxt), '画像旁边写清了它只能由世界引擎写');

  // ⑧ 世界页「她的日记」要有月历回看（以前只有最近一晚，她一写新的昨晚就没了）
  ok(/上一月/.test(worldTxt) && /下一月/.test(worldTxt), '她的日记上方有月历（可翻月）');
  ok(/一共 \d+ 天存档/.test(worldTxt), '月历下方标明一共有多少天存档');
  ok(/存档写在 diary 文件夹里/.test(worldTxt), '写清了存档位置（一天一个 .md，记事本能打开）');
  ok(/她的话（私人日记）/.test(worldTxt) && /周末还是没能完全躺平/.test(worldTxt), '点日期能真的渲染出那天存档的内容（不是空白）');

  // ⑨ 专属昵称必须真接线（以前只在已删除的「关系阶段」跃迁时才进提示词）
  ok(/你心里给他起的名字是/.test(fs.readFileSync(path.join(root, 'src/soul.js'), 'utf8')), '「专属昵称」真的进她的提示词了（修黑盒）');
}

console.log(fail === 0 ? '\nCONSOLE-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nCONSOLE-SMOKE 有失败 ❌ ' + fail + ' 项');

process.exit(fail === 0 ? 0 : 1);
