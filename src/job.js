// job.js — 职业 → 生活形状（只让用户填一句话，机器负责判断）
// 优先级链（按用户拍板）：①世界引擎每晚判断（最懂她的生活）→ ②保存职业时用对话模型推断一次（立刻生效）
//                        → ③关键词兜底（永远不失败）。
// 判断结果只是一组参数（工作类型/上下班/工作日），存在 config.job 里、后台看得见也能改；
// 作息"形状"由 daily.js 用，强度由「生活节奏→职业的影响」的滑杆调。

/** 工作类型表：wakeEarly/sleepLate 是相对"作息基准"的分钟偏移（正数=更晚） */
export const JOB_TYPES = {
  office: { label: '上班族（朝九晚六）', workProb: 1, wakeEarly: -60, sleepLate: -30, busy: 0.85, tag: '上班' },
  shift: { label: '排班制（护士/服务/工厂）', workProb: 0.6, wakeEarly: -90, sleepLate: 0, busy: 0.9, tag: '排班' },
  freelance: { label: '自由职业（在家接活）', workProb: 0.65, wakeEarly: 60, sleepLate: 70, busy: 0.5, tag: '赶活' },
  night: { label: '夜班/昼夜颠倒', workProb: 0.7, wakeEarly: 420, sleepLate: 300, busy: 0.8, tag: '夜班' },
  student: { label: '学生', workProb: 1, wakeEarly: -30, sleepLate: -20, busy: 0.45, tag: '上课' },
  none: { label: '无固定工作', workProb: 0, wakeEarly: 0, sleepLate: 0, busy: 0, tag: '' },
};
export const JOB_TYPE_IDS = Object.keys(JOB_TYPES);
export const jobLabel = (t) => (JOB_TYPES[t] || JOB_TYPES.none).label;

/** 关键词兜底：模型不可用时也能给出合理判断（永远是最后一道） */
const RULES = [
  [/夜班|夜店|酒吧|保安|遛|守夜|通宵班|三班倒|四班|倒班/, 'night', '提到夜班/倒班'],
  [/护士|医生|药师|护工|服务员|店员|收银|快递|外卖|司机|厨师|理发|月嫂|保洁|工厂|车间|海员|空乘/, 'shift', '这类工作通常排班'],
  [/学生|读研|研究生|大学生|高中生|考研|在读|全职妈妈|宝妈|退休|失业|待业|自由/, 'freelance', '时间比较自由'],
  [/老师|教师|公务员|银行|会计|审计|律师|程序员|开发|工程师|设计师|运营|市场|销售|客服|行政|人事|文员|编辑|记者|国企|公司|上班|职员|白领|店长|经理/, 'office', '按点上下班'],
];

export function guessJobType(text) {
  const s = String(text || '');
  if (!s.trim()) return { type: 'none', reason: '没写职业' };
  for (const [re, type, reason] of RULES) if (re.test(s)) return { type, reason };
  return { type: 'freelance', reason: '看不出固定坐班，按时间自由处理（判错了你能在后台改）' };
}

/** HH:MM 校验（顺便补零）；越界返回 null */
const hmOk = (v) => {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
};

/** 工作日：只留 0-6、去重、排序、逗号分隔 */
function cleanDays(raw, dflt) {
  const list = String(raw == null || raw === '' ? dflt : raw)
    .split(',')
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const uniq = [...new Set(list)].sort((a, b) => a - b);
  return uniq.length ? uniq.join(',') : dflt;
}

/** 把（模型给的或兜底给的）判断结果规整成可存的形式 */
export function normalizeJob(raw = {}, fallbackText = '') {
  const g = guessJobType(fallbackText);
  const type = JOB_TYPE_IDS.includes(raw.type) ? raw.type : g.type;
  const t = JOB_TYPES[type] || JOB_TYPES.none;
  const dfltStart = type === 'office' ? '09:00' : (type === 'shift' || type === 'student') ? '08:00' : '';
  const dfltEnd = type === 'office' ? '18:00' : type === 'shift' ? '20:00' : type === 'student' ? '17:00' : '';
  const dfltDays = (type === 'shift' || type === 'freelance' || type === 'night') ? '1,2,3,4,5,6' : '1,2,3,4,5';
  return {
    type,
    label: t.label,
    workStart: hmOk(raw.workStart) || dfltStart,
    workEnd: hmOk(raw.workEnd) || dfltEnd,
    workDays: cleanDays(raw.workDays, dfltDays),
    reason: String(raw.reason || g.reason || '').slice(0, 80),
  };
}

/** 提示词：让她自己（对话模型）判断这份职业怎么上班 */
export function buildJobPrompt(jobText, persona = {}) {
  const sys = [
    '你是一个生活规划助手，只输出 JSON，不要解释、不要代码块。',
    '任务：判断这份职业的人平时怎么生活（工作类型、上下班时间、一周哪几天上班）。',
    'type 只能取：office（朝九晚六坐班）/ shift（排班制，班次不固定）/ freelance（自由职业、在家接活）/ night（夜班、昼夜颠倒）/ student（学生）/ none（无固定工作）。',
    '输出格式：{"type":"office","workStart":"09:00","workEnd":"18:00","workDays":"1,2,3,4,5","reason":"一句 60 字内的理由（第一人称不需要，客观陈述即可）"}',
    'workDays 用 0-6 表示周日到周六，逗号分隔。workStart/workEnd 是 HH:MM（24 小时制）。',
    '拿不准就选最接近的那一类，别拒绝回答。',
  ].join('\n');
  const user = [
    '职业：' + String(jobText || '').slice(0, 120),
    persona.city ? '城市：' + persona.city : '',
    persona.age ? '年龄：' + persona.age : '',
    '(只输出 JSON)',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/** 用对话模型推断（失败返回 null，由调用方走关键词兜底） */
export async function inferJobWithModel({ router, jobText, persona = {}, log } = {}) {
  try {
    const r = await router.chat(buildJobPrompt(jobText, persona), { temperature: 0.2, maxTokens: 200 });
    const m = String((r && r.content) || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    return normalizeJob(d, jobText);
  } catch (err) {
    try { log && log('[job] 模型判断失败，退回关键词: ' + (err && err.message)); } catch {}
    return null;
  }
}

/** 完整链路：模型优先 → 关键词兜底；同时把"来源"标清楚（后台要看得见） */
export async function inferJob({ router, jobText, persona = {}, log } = {}) {
  const fromModel = await inferJobWithModel({ router, jobText, persona, log });
  const base = fromModel || normalizeJob({}, jobText);
  return { ...base, source: fromModel ? 'model' : 'keyword', inferredFrom: String(jobText || '').slice(0, 120), inferredAt: Date.now() };
}
