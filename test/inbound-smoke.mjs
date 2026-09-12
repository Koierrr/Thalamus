// inbound-smoke.mjs — 入站消息解析的回归（防"她收到却永远不回"这类事故）
// 事故背景：解析逻辑曾写在用它的那行之后 → 每条消息都在 TDZ 抛错、整段入站处理中断。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/inbound-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseInboundText, hasMedia } from '../src/inbound.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ── 解析 ──
ok(parseInboundText({ item_list: [{ type: 1, text_item: { text: '在吗' } }] }).text === '在吗', '单条文本');
ok(parseInboundText({ item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 1, text_item: { text: '在吗' } }] }).text === '你好在吗', '多条文本拼接');
ok(parseInboundText({ item_list: [{ type: 2, image_item: {} }] }).text === '', '纯图片 → 正文为空（由媒体流程处理）');
ok(parseInboundText({}).text === '', '空消息不崩');
const withRef = parseInboundText({ item_list: [{ type: 1, text_item: { text: '这句' } }], ref_message: { title: '她', content: '上一句' } });
ok(withRef.text.indexOf('[引用: 她 | 上一句]') === 0 && withRef.text.indexOf('这句') > 0, '引用消息带上上下文');
ok(parseInboundText({ item_list: [{ type: 1, text_item: { text: '  空格  ' } }] }).text === '空格', '正文去首尾空白');
ok(parseInboundText({ item_list: [null, { type: 1, text_item: { text: 'x' } }] }).text === 'x', 'item_list 里混了空项也不崩');
ok(parseInboundText({ item_list: [{ type: 1, text_item: {} }] }).text === '', 'text_item 空对象不崩');

// ── 媒体识别 ──
ok(hasMedia({ item_list: [{ type: 2 }] }) === true, '图片=媒体');
ok(hasMedia({ item_list: [{ type: 3 }] }) === true, '语音=媒体');
ok(hasMedia({ item_list: [{ type: 1 }] }) === false, '纯文本不等于媒体');

// ── 顺序守卫：解析必须在"用它的地方"之前（静态检查 index.js）──
const idx = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
const useLine = idx.split('\n').findIndex((l) => l.indexOf("this.activity('[收到] '") >= 0);
const declLine = idx.split('\n').findIndex((l) => l.indexOf('const parsed = parseInboundText(') >= 0);
const legacyLet = idx.split('\n').findIndex((l) => /^\s*let text = '';\s*$/.test(l));
ok(declLine > 0 && useLine > 0 && declLine < useLine, '解析（第 ' + (declLine + 1) + ' 行）在用它的实况记录（第 ' + (useLine + 1) + ' 行）之前');
ok(legacyLet < 0, 'index.js 里不再残留旧的 `let text = \'\'` 解析块（易与实况行顺序打架）');

console.log(fail === 0 ? '\nINBOUND ALL GREEN ✅  ' + pass + ' 项' : '\nINBOUND 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
