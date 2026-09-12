// birthday-smoke.mjs — 生日 → 年龄/星座 的回归（含 12 星座边界日、闰日、各种写法）
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/birthday-smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseBirthday, zodiacOf, ageFrom, birthdayInfo } from '../src/birthday.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

// ── 解析 ──
ok(parseBirthday('1999-03-14').iso === '1999-03-14', '标准格式 1999-03-14');
ok(parseBirthday('1999/3/14').iso === '1999-03-14', '斜杠 + 单位数也能解析');
ok(parseBirthday('1999.3.14').iso === '1999-03-14', '点号分隔');
ok(parseBirthday('19990314').iso === '1999-03-14', '紧凑数字');
ok(parseBirthday('1999年3月14日').iso === '1999-03-14', '中文年月日');
ok(parseBirthday('03-14').hasYear === false, '只有月日 → 不算年份');
ok(parseBirthday('13-40') === null, '非法月日 → null');
ok(parseBirthday('1999-02-30') === null, '不存在的日期 → null');
ok(parseBirthday('') === null && parseBirthday(null) === null, '空值 → null');
ok(parseBirthday('2000-02-29').iso === '2000-02-29', '闰年 2-29 合法');
ok(parseBirthday('1999-02-29') === null, '平年 2-29 非法');

// ── 星座边界（每个星座的第一天与前一天）──
const edges = [
  ['01-19', '摩羯座'], ['01-20', '水瓶座'], ['02-18', '水瓶座'], ['02-19', '双鱼座'],
  ['03-20', '双鱼座'], ['03-21', '白羊座'], ['04-19', '白羊座'], ['04-20', '金牛座'],
  ['05-20', '金牛座'], ['05-21', '双子座'], ['06-21', '双子座'], ['06-22', '巨蟹座'],
  ['07-22', '巨蟹座'], ['07-23', '狮子座'], ['08-22', '狮子座'], ['08-23', '处女座'],
  ['09-22', '处女座'], ['09-23', '天秤座'], ['10-23', '天秤座'], ['10-24', '天蝎座'],
  ['11-21', '天蝎座'], ['11-22', '射手座'], ['12-21', '射手座'], ['12-22', '摩羯座'],
  ['12-31', '摩羯座'], ['01-01', '摩羯座'],
];
let bad = edges.filter(([md, want]) => zodiacOf(Number(md.slice(0, 2)), Number(md.slice(3))) !== want);
ok(bad.length === 0, '12 星座边界日全部正确' + (bad.length ? '（错：' + bad.map((b) => b[0]).join(',') + '）' : ''));
ok(new Set(Array.from({ length: 366 }, (_, i) => {
  const dt = new Date(Date.UTC(2000, 0, 1 + i));
  return zodiacOf(dt.getUTCMonth() + 1, dt.getUTCDate());
})).size === 12, '一年 366 天只落进 12 个星座（不会漏/重复）');

// ── 年龄 ──
ok(ageFrom(parseBirthday('2000-01-01'), new Date('2026-09-12')) === 26, '1-1 出生、9 月已过生日 → 26 岁');
ok(ageFrom(parseBirthday('2000-12-31'), new Date('2026-09-12')) === 25, '12-31 出生、生日还没到 → 25 岁');
ok(ageFrom(parseBirthday('2000-09-12'), new Date('2026-09-12')) === 26, '当天生日 → 已满 26 岁');
ok(ageFrom(parseBirthday('2000-09-13'), new Date('2026-09-12')) === 25, '明天生日 → 还是 25 岁');
ok(ageFrom(parseBirthday('2000-02-29'), new Date('2026-02-28')) === 25, '闰日出生：2-28 还没到（折算 3-1）');
ok(ageFrom(parseBirthday('2000-02-29'), new Date('2026-03-01')) === 26, '闰日出生：3-1 已过生日');
ok(ageFrom('03-14') === null, '没有年份 → 年龄算不出来（返回 null）');

// ── 一站式 ──
const info = birthdayInfo('1999-03-14', new Date('2026-09-12'));
ok(info.valid && info.age === 27 && info.zodiac === '双鱼座' && info.hasYear, '1999-03-14 → 27 岁 · 双鱼座');
const info2 = birthdayInfo('03-14', new Date('2026-09-12'));
ok(info2.valid && info2.age === null && info2.zodiac === '双鱼座' && !info2.hasYear, '只填月日 → 星座有、年龄无 + 提示');
ok(birthdayInfo('乱写的').valid === false && /1999-03-14/.test(birthdayInfo('乱写的').hint), '乱填 → 给出格式示例');

// ── 与前端内联实现保持一致（后台要在输入时实时显示，不能各算一套）──
const html = fs.readFileSync(path.join(process.cwd(), 'src', 'console.html'), 'utf8');
const fnMatch = html.match(/function bdayInfo\(raw\)\{[\s\S]*?\n\}/);
ok(!!fnMatch, '控制台里有内联的 bdayInfo（输入时实时算）');
if (fnMatch) {
  const fn = new Function(fnMatch[0] + '; return bdayInfo;')();
  const days = [];
  for (let m = 1; m <= 12; m++) for (let d = 1; d <= 31; d++) days.push([m, d]);
  const mismatch = days.filter(([m, d]) => String(fn(m + '-' + d).zodiac) !== String(zodiacOf(m, d)));
  ok(mismatch.length === 0, '控制台内联星座与 src/birthday.js 完全一致' + (mismatch.length ? '（不一致 ' + mismatch.length + ' 天，例如 ' + mismatch[0].join('-') + '）' : ''));
}

console.log(fail === 0 ? '\nBIRTHDAY ALL GREEN ✅  ' + pass + ' 项' : '\nBIRTHDAY 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
