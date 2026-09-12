// diary-smoke.mjs — 世界剧本按天留档（第三次改版 批3-E，2026-09-13）
// 背景：以前 world-state.json 只存"最近一晚"，她写新的一晚，昨天的日记/流水/念头/秘密就全没了。
// 现在每晚顺手写一份 diary/<日期>.md（人能用记事本打开），后台按日历翻旧账。
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/diary-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldEngine } from '../src/world-engine.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
const eng = (dir) => new WorldEngine({ dir, logger: () => {} });

const FULL = {
  date: '2026-09-11', forDate: '2026-09-12',
  diary: '今天接了个新案子，晚上改到两点。',
  wake: '09:30', sleep: '01:10',
  weather: '多云转晴，25~31°C', weatherSource: 'real',
  mood: 62, focus: '大理民宿路线', workload: 40,
  job: { type: 'office', workStart: '09:00', workEnd: '18:00', reason: '律所坐班' },
  flow: [{ time: '10:10', text: '赖床到自然醒' }, { time: '14:30', text: '去咖啡馆改稿' }],
  thoughts: ['想去大理', '想换笔记本'],
  secrets: ['存了他的一句话'],
  npcs: [{ name: '张姐', rel: '同事', note: '爱八卦但心软' }],
  longterm: [{ text: '想把画册画完送给他' }],
  disclosed: [{ layer: '表层', topic: '老家在苏州' }],
  tone: {
    intimacy: 25, address: '直接叫名字', style: '客气但放松', reason: '刚认识', forbid: ['撒娇', '叫昵称'],
    proactive: { morning: true, night: false, pokes: 2, nudges: 1 }, proactiveAt: '16:00 前后',
    statusLine: '今天案子卡住了，有点闷', insomnia: true,
    rhythm: { baseWake: '08:30', baseSleep: '00:30', weekendShiftMin: 90, nightOwlProb: 0.2, allNighterProb: 0.05 },
  },
  portrait: '刚认识没多久，他话不多，但不讨厌。',
  milestone: '认识 100 天',
  generatedAt: Date.now(),
};

// ① 留档：写进 diary/<日期>.md，且内容真的全（不是 dump JSON，是人能读的 Markdown）
{
  const dir = mk();
  const w = eng(dir);
  const f = w._archive(FULL);
  ok(!!f && fs.existsSync(f), '生成后写出 diary/' + FULL.date + '.md');
  const md = fs.readFileSync(f, 'utf8');
  ok(md.startsWith('# ' + FULL.date), '文件开头就是日期标题（记事本一打开就知道是哪天）');
  ok(md.includes(FULL.diary), '日记原文在里面');
  ok(md.includes('赖床到自然醒') && md.includes('去咖啡馆改稿'), '生活流水在里面');
  ok(md.includes('想去大理'), '念头在里面');
  ok(md.includes('存了他的一句话'), '秘密在里面');
  ok(md.includes('张姐'), '社交圈在里面');
  ok(md.includes('画册画完'), '长线小心思在里面');
  ok(md.includes('老家在苏州'), '已透露的过去在里面');
  ok(md.includes('16:00 前后') && md.includes('撒娇'), '第二天的分寸（含主动时间/禁令）在里面');
  ok(md.includes('周末最多推迟 90 分钟'), '世界引擎推的作息基准在里面');
  ok(md.includes(FULL.portrait), '她眼中的你（画像）在里面');
  ok(md.includes('认识 100 天'), '纪念日标注在里面');
  ok(!/^\s*\{"/m.test(md), '不是 JSON dump（是给人读的 Markdown）');
}

// ② 不覆盖：一天一个文件，写第二天不会动第一天
{
  const dir = mk();
  const w = eng(dir);
  w._archive(FULL);
  w._archive({ ...FULL, date: '2026-09-12', diary: '第二天。' });
  const days = w.diaryDays();
  ok(days.length === 2, '两天 = 两个文件（' + days.join(',') + '）');
  ok(days[0] === '2026-09-12', '列表新→旧（最新在前）');
  ok(fs.readFileSync(path.join(dir, 'diary', '2026-09-11.md'), 'utf8').includes(FULL.diary), '第一天没被覆盖');
  ok(w.diaryOf('2026-09-11').includes('赖床到自然醒'), 'diaryOf 能读回第一天');
}

// ③ 脏输入不炸：日期不对就不写、读不存在/乱写的日期返回空串
{
  const dir = mk();
  const w = eng(dir);
  ok(w._archive({ date: '不是日期', diary: 'x' }) === '', '日期不合法 → 不写文件');
  ok(w._archive(null) === '', '传空 → 不写文件');
  ok(w.diaryOf('2026-01-01') === '', '读不存在的日期 → 空串');
  ok(w.diaryOf('../../etc/passwd') === '', '读非法日期 → 空串（不会跑出 diary 目录）');
  ok(w.diaryDays().length === 0, '没留过档时列表为空');
  ok(w._archive({ date: '2026-09-11', diary: '' }) !== '', '日记为空也照常留档（那天的流水/念头还在，不该丢）');
}

// ④ 老数据升级：state 里已经有一晚但还没留档 → 列一次日历就自动补上
{
  const dir = mk();
  fs.writeFileSync(path.join(dir, 'world-state.json'), JSON.stringify(FULL), 'utf8');
  const w = eng(dir);
  ok(!fs.existsSync(path.join(dir, 'diary')), '开始确实没有 diary 目录（模拟改版前的老数据）');
  const days = w.diaryDays();
  ok(days.length === 1 && days[0] === FULL.date, '第一次读日历就把当前这一晚补档了（老数据不丢）');
  ok(w.diaryOf(FULL.date).includes(FULL.diary), '补出来的存档内容完整');
}

// ⑤ 路由与消费点：后台真的能按月翻（源级断言，避免"界面在、后端没接口"）
{
  const root = process.cwd();
  const idx = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'console.html'), 'utf8');
  ok(/path === 'panel\/diary\/days'/.test(idx), '后端有 panel/diary/days（日历点亮哪些天）');
  ok(/path === 'panel\/diary'/.test(idx) && /searchParams\.get\('date'\)/.test(idx), '后端有 panel/diary?date=（读某一天的存档）');
  ok(/'panel\/diary'\+/.test(html) && /\?date=/.test(html), '后台日历真的在调这个接口（不是摆设）');
  ok(/上一月/.test(html) && /下一月/.test(html), '日历有翻月按钮');
  ok(/world\.diaryDays\(\)/.test(idx) && /world\.diaryOf\(/.test(idx), '两个接口都真的接到世界引擎的留档上');
}

// ⑥ 向量维度护栏必须真的在（换模型维度不同会静默检索错，所以要在引擎启动前拦住）
{
  const py = fs.readFileSync(path.join(process.cwd(), 'python', 'memory_service.py'), 'utf8');
  ok(/_embed_dims_guard/.test(py), '记忆引擎里有向量维度护栏');
  ok(/向量维度变了/.test(py), '维度不一致时会给出人话提示（而不是底层报错）');
  ok(/'provider': emb_provider/.test(py), '嵌入服务商由后台配置决定（不再写死 ollama）');
  const idx = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
  ok(/panel\/embed\/probe/.test(idx), '后端有"真跑一次并量维度"的接口');
  ok(/provider: 'openai'/.test(idx) && /provider: 'ollama'/.test(idx), '云端/本地两种向量都真的同步给记忆引擎');
}

// ⑦ 端到端：真跑一次 generate()（模型用桩，不花钱不联网）→ 新 schema 全部落地 + 自动留档
//    这是"世界引擎真的能落地"的离线证明：重启 DSH 后点「立刻生成一次世界」走的就是这条路径。
{
  const dir = mk();
  const NEW_SCHEMA = JSON.stringify({
    diary: '今天把稿子改完了，心里空出来一块。',
    wake: '08:40', sleep: '00:20', mood: 68,
    focus: '大理民宿',
    flow: [{ time: '10:00', text: '去咖啡馆改稿' }, { time: '15:30', text: '沿河散步' }],
    thoughts: ['想去大理'],
    secrets: [{ text: '偷偷存了他的一句话' }],
    npc: [{ name: '张姐', rel: '同事', note: '爱八卦但心软' }],
    portrait: '刚认识，他话不多但不讨厌。',
    longline: '想把画册画完送给他',
    disclosedAdd: [{ layer: '表层', topic: '老家在苏州' }],
    tone: {
      intimacy: 28, address: '直接叫名字', style: '客气但放松', chunks: 2, maxChars: 40,
      proactive: { morning: true, night: false, pokes: 2, nudges: 1 },
      forbid: ['撒娇', '叫昵称'], reason: '刚认识',
    },
    statusLine: '今天案子卡住了，有点闷',
    insomnia: true,
    proactiveAt: '16:00 前后',
    rhythm: { baseWake: '08:30', baseSleep: '00:30', weekendShiftMin: 90, nightOwlProb: 0.2, allNighterProb: 0.05 },
    workload: 35,
  });
  const w = new WorldEngine({
    dir,
    router: { chat: async () => { throw new Error('对话接口不该被世界引擎调用'); } },
    chatFn: async () => ({ content: NEW_SCHEMA }),
    config: () => ({ world: { baseURL: 'https://world.example', model: 'world-model' } }),
    soul: null,
    logger: () => {},
  });
  const now = new Date('2026-09-11T23:40:00');
  const P = { name: '苏镜语', job: '律师', city: '上海', traits: { orderliness: 73, socialBattery: 59 }, behavior: { baseWake: '08:00', baseSleep: '23:30', jitterMin: 45 }, interests: ['拼图'], assessments: { mbti: 'INTJ' }, relationship: {} };
  const out = await w.generate({ persona: P, today: { sleep: '23:30', events: [] }, memories: [], now });

  ok(out.date === '2026-09-11' && out.forDate === '2026-09-12', 'forDate 落在她醒来那天（' + out.date + ' → ' + out.forDate + '）');
  ok(out.tone && out.tone.statusLine === '今天案子卡住了，有点闷', '新字段 statusLine 落进 tone（她的状态第一行）');
  ok(out.tone.insomnia === true, '新字段 insomnia 落进 tone（今晚失眠→入睡时长变长）');
  ok(out.tone.proactive && out.tone.proactive.morning === true && out.tone.proactive.night === false && out.tone.proactive.pokes === 2, '新字段 proactive 落进 tone（明天要不要主动、最多几次）');
  ok(out.tone.proactiveAt === '16:00 前后', '新字段 proactiveAt 落进 tone（主动时间倾向）');
  ok(out.tone.rhythm && out.tone.rhythm.baseWake === '08:30' && out.tone.rhythm.weekendShiftMin === 90, '新字段 rhythm 落进 tone（作息基准，会覆盖后台手改）');
  ok(out.workload === 35, 'workload 解析正常（≥50 才累压力）');

  const days = w.diaryDays();
  ok(days.length === 1 && days[0] === '2026-09-11', 'generate 之后自动留档（不用手动点）');
  const md = w.diaryOf('2026-09-11');
  ok(md.includes('今天案子卡住了，有点闷'), '存档里含"她今天的状态"');
  ok(md.includes('今晚失眠到很晚'), '存档里含"今晚失眠"');
  ok(md.includes('16:00 前后'), '存档里含"明天大概什么时候想找你"');
  ok(md.includes('最多主动 2 次'), '存档里含"明天最多主动几次"');
  ok(md.includes('平时：08:30 起'), '存档里含"她的作息基准"');
  ok(md.includes('08:40 起') && md.includes('00:20 睡'), '存档里含明天作息（剧情熬夜→次日赖床链路的落点）');
  ok(md.includes('老家在苏州'), '存档里含"她已经告诉过你的过去"');

  // 同一晚重复生成 → 覆盖同一天的文件，不会长出第二份
  await w.generate({ persona: P, today: { sleep: '23:30', events: [] }, memories: [], now });
  ok(w.diaryDays().length === 1, '同一晚重复生成只覆盖那一天的文件（不会重复留档）');
}

console.log(fail === 0 ? '\nDIARY-SMOKE ALL GREEN ✅  ' + pass + ' 项' : '\nDIARY-SMOKE 有失败 ❌ ' + fail + ' 项');

process.exit(fail === 0 ? 0 : 1);
