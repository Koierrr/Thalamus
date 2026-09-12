// birthday.js — 生日 → 年龄 & 星座（单一数据源）
// 用户只填一个日期（YYYY-MM-DD），年龄与星座自动算：
//   · 星座只看月日
//   · 年龄必须知道出生年（没填年份就不算，允许手填年龄兜底）
// 提示词里注入的年龄、后台显示的年龄、女娲草稿里的年龄都用这里的结果，避免三处各写一套。

/** 兼容多种写法：1999-03-14 / 1999/3/14 / 1999.3.14 / 19990314 / 3-14 / 03-14 */
export function parseBirthday(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./]/g, '-').replace(/\s+/g, '');
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return null;
    return { year: y, month: mo, day: d, hasYear: true, iso: iso(y, mo, d) };
  }
  m = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    if (!validYmd(2000, mo, d)) return null; // 用闰年校验，2-29 合法
    return { year: null, month: mo, day: d, hasYear: false, iso: iso(null, mo, d) };
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return null;
    return { year: y, month: mo, day: d, hasYear: true, iso: iso(y, mo, d) };
  }
  return null;
}

const iso = (y, mo, d) => (y ? String(y).padStart(4, '0') + '-' : '') + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
function validYmd(y, mo, d) {
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 星座（含边界日：3-21 起白羊 … 12-22 起摩羯） */
const ZODIAC = [
  [1, 20, '水瓶座'], [2, 19, '双鱼座'], [3, 21, '白羊座'], [4, 20, '金牛座'],
  [5, 21, '双子座'], [6, 22, '巨蟹座'], [7, 23, '狮子座'], [8, 23, '处女座'],
  [9, 23, '天秤座'], [10, 24, '天蝎座'], [11, 22, '射手座'], [12, 22, '摩羯座'],
];
export function zodiacOf(month, day) {
  const m = Number(month), d = Number(day);
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const hit = ZODIAC.find(([zm, zd]) => m === zm && d >= zd);
  if (hit) return hit[2];
  // 在某个星座的起始日之前 → 属于上一个星座
  const idx = m - 1;
  const prev = (idx - 1 + 12) % 12;
  return m === 1 ? '摩羯座' : ZODIAC[prev][2];
}

/** 周岁（生日过了没；2-29 出生的人按 3-1 折算，避免四年才长一岁） */
export function ageFrom(birth, now = new Date()) {
  const b = typeof birth === 'string' ? parseBirthday(birth) : birth;
  if (!b || !b.hasYear) return null;
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  let age = y - b.year;
  const bm = b.month, bd = b.month === 2 && b.day === 29 ? 1 : b.day; // 2-29 → 记作 3-1
  const bMonth = b.month === 2 && b.day === 29 ? 3 : bm;
  if (m < bMonth || (m === bMonth && d < bd)) age -= 1;
  return age >= 0 && age <= 150 ? age : null;
}

/** 一站式：给后台与提示词共用的展示信息 */
export function birthdayInfo(raw, now = new Date()) {
  const b = parseBirthday(raw);
  if (!b) return { valid: false, age: null, zodiac: '', iso: '', hint: '按 1999-03-14 这样的格式填（或只填 03-14，但那样算不出年龄）' };
  const zodiac = zodiacOf(b.month, b.day);
  const age = b.hasYear ? ageFrom(b, now) : null;
  return {
    valid: true,
    hasYear: b.hasYear,
    iso: b.iso,
    monthDay: String(b.month).padStart(2, '0') + '-' + String(b.day).padStart(2, '0'),
    zodiac,
    age,
    hint: b.hasYear ? '' : '没填年份 → 只能算星座，年龄要你自己填',
  };
}
