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
  if (u.startsWith('panel/memory')) return { engine: 'mem0', entries: [{ id: 'm1', text: '主人不吃香菜', ts: Date.now(), who: 'p1', source: 'manual' }, { id: 'm2', text: '我下周要去杭州', ts: Date.now(), who: 'self', source: 'self' }], relations: {} };
  if (u.startsWith('panel/mem-engine')) return { running: true, info: { ready: true } };
  if (u.startsWith('panel/wxauto/status')) return { mode: 'clawbot', enabled: false, bridge: { ready: false } };
  if (u.startsWith('panel/features')) return { groups: [{ name: '聊天', items: [{ id: 'chat', name: '文字聊天', status: 'done', detail: 'd' }] }] };
  if (u.startsWith('panel/avatar')) return { refs: [{ id: 'r1', file: 'r1.png', angle: '正面', bytes: 1024, addedAt: Date.now(), url: 'panel/avatar/file?id=r1' }], mainId: 'r1', appearance: { face: '圆脸' }, albumCount: 1, canGenerate: true, hint: '' };
  if (u.startsWith('panel/album')) return { items: [{ id: 'p1', file: 'p1.png', scene: '咖啡店', mode: 'i2i', createdAt: Date.now(), bytes: 2048, url: 'panel/album/file?id=p1' }] };
  if (u.startsWith('panel/moments')) return { drafts: [{ id: 'd1', text: '文案', createdAt: Date.now(), status: 'draft', images: [] }] };
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

console.log(fail === 0 ? '\nCONSOLE-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nCONSOLE-SMOKE 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
