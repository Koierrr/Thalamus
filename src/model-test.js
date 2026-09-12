// model-test.js — 「大脑」六个接口的体检（两级：测连通 / 真跑一次）
// 目标：不许黑盒。填了 BaseURL+Key 之后，点一下就知道这个接口到底能不能用、慢不慢、长什么样。
//   shallow（测连通，零成本）：只验证"地址通、钥匙对、模型名在列表里"——一次 /models 请求。
//   deep（真跑一次）：发一个最小真实请求看结果；识图/语音识别会自动造素材：
//      · 识图：本地画一张"白底红圆"的 PNG → 问它是什么颜色形状
//      · 语音识别：先用 TTS 读一句话 → 把音频喂回 ASR（闭环，不用你出声）
// 所有网络调用都走 model-router 的同一套函数——测的就是她真正用的那条路。

import { fetchModels, chatCompletion, generateImage, speech, transcribe, embedText } from './model-router.js';

/** 本地生成一张"白底红圆"的测试图（用仓库里已有的 pngjs，不引入新依赖） */
export async function makeTestPng(size = 128) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: size, height: size });
  const cx = size / 2, cy = size / 2, r = size * 0.32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (size * y + x) << 2;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      png.data[i] = inside ? 220 : 255;
      png.data[i + 1] = inside ? 40 : 255;
      png.data[i + 2] = inside ? 40 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** 生成一段合法的最小 WAV（静音）：给"没配 TTS 也想验 ASR 接口"兜底 */
export function makeSilentWav(ms = 800, rate = 16000) {
  const n = Math.round((rate * ms) / 1000);
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

const ROLE_NAME = { chat: '对话接口', image: '生图接口', tts: '语音合成', asr: '语音识别', vision: '识图', embed: '记忆向量' };

/** 把表单里的值和已保存的配置合起来（留空=沿用对话接口，和真正跑的时候同一套规则） */
export function resolveConf(role, saved, form = {}) {
  const chat = saved.chat || {};
  if (role === 'chat') {
    return {
      baseURL: form.baseURL || chat.baseURL || '',
      apiKey: form.apiKey || chat.apiKey || '',
      model: form.model || chat.model || '',
    };
  }
  const r = saved[role] || {};
  return {
    baseURL: form.baseURL || r.baseURL || chat.baseURL || '',
    apiKey: form.apiKey || r.apiKey || chat.apiKey || '',
    model: form.model || r.model || '',
    voice: form.voice || r.voice || '',
    source: role === 'embed' ? (form.source || r.source || 'local') : undefined,
    url: role === 'embed' ? (form.url || r.url || 'http://127.0.0.1:11434') : undefined,
  };
}

async function localOllamaModels(url) {
  const res = await fetch(String(url || 'http://127.0.0.1:11434').replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return (data.models || []).map((m) => ({ id: m.name || m.model })).filter((m) => m.id);
}

/**
 * 跑一次体检。
 * @returns {Promise<{role,deep,ok,ms,detail,sample,hint}>} 永远 resolve（失败在 ok=false + detail 里）
 */
export async function runModelTest({ role, deep = false, saved = {}, form = {}, saveFile } = {}) {
  const conf = resolveConf(role, saved, form);
  const t0 = Date.now();
  const done = (ok, detail, sample, hint) => ({ role, deep: !!deep, ok, ms: Date.now() - t0, detail, sample: sample || '', hint: hint || '' });
  const label = ROLE_NAME[role] || role;

  try {
    /* ── 记忆向量：本地 Ollama 与云端是两条完全不同的路 ── */
    if (role === 'embed' && conf.source === 'local') {
      if (!deep) {
        const ids = (await localOllamaModels(conf.url)).map((m) => m.id);
        const has = ids.includes(conf.model) || ids.some((x) => x.split(':')[0] === String(conf.model).split(':')[0]);
        return done(has, '本地 Ollama 通（' + conf.url + '）：模型 ' + ids.length + ' 个' + (has ? '，' + conf.model + ' ✅' : '，但没找到 ' + conf.model + ' ⚠️'), ids.slice(0, 6).join('、'),
          has ? '' : '执行 `ollama pull ' + conf.model + '`，或把「向量来源」改成云端接口。');
      }
      const vec = await embedText({ baseURL: conf.url.replace(/\/+$/, '') + '/v1', apiKey: '', model: conf.model, input: '测试这句话的向量' });
      return done(Array.isArray(vec) && vec.length > 0, '本地 Ollama 出向量成功：' + vec.length + ' 维', '前 5 维 ' + vec.slice(0, 5).map((x) => x.toFixed(3)).join(', '));
    }

    /* ── 其他五个接口：测连通都是一次 /models ── */
    if (!deep) {
      if (!conf.baseURL) return done(false, 'BaseURL 没填（也没法沿用对话接口）', '', '先在「对话接口」里填 BaseURL+Key，或在这里单独填。');
      const ids = (await fetchModels({ baseURL: conf.baseURL, apiKey: conf.apiKey })).map((m) => m.id);
      const has = !!conf.model && ids.includes(conf.model);
      if (!conf.model) return done(true, '地址和钥匙都对（能拉到 ' + ids.length + ' 个模型），但模型名还没填', ids.slice(0, 6).join('、'), '点「拉取列表」选一个模型名。');
      return done(has, has ? '地址/钥匙/模型名 三样都对 ✅（列表里共 ' + ids.length + ' 个模型）' : '地址和钥匙对，但列表里没有「' + conf.model + '」（可能名字拼错或该账号没这个模型的权限）', ids.slice(0, 6).join('、'), has ? '' : '点「拉取列表」从可用模型里挑一个。');
    }

    /* ── 真跑一次 ── */
    if (role === 'embed') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '云端向量需要一个 embedding 模型名（如 bge-m3 / text-embedding-3-small）。');
      const vec = await embedText({ baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model, input: '测试这句话的向量' });
      return done(Array.isArray(vec) && vec.length > 0, '云端出向量成功：' + (vec || []).length + ' 维', '前 5 维 ' + (vec || []).slice(0, 5).map((x) => Number(x).toFixed(3)).join(', '));
    }
    if (role === 'chat') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '填好再测。');
      const r = await chatCompletion({ baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model, messages: [{ role: 'user', content: '只回复两个字：在的' }], temperature: 0, maxTokens: 16 });
      return done(!!r.content, '她的大脑回话了：' + (r.content || '').slice(0, 40), (r.usage ? 'tokens ' + JSON.stringify(r.usage) : ''));
    }
    if (role === 'image') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '生图接口需要单独的模型名（如 kolors / flux）。');
      const out = await generateImage({ baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model, prompt: '一只橘猫趴在窗台上午睡，手机随手拍，自然光', size: '512x512', n: 1 });
      const first = out[0] || {};
      let bytes = 0;
      if (first.b64) bytes = Buffer.from(first.b64, 'base64').length;
      else if (first.url) { try { const r2 = await fetch(first.url, { signal: AbortSignal.timeout(30000) }); bytes = (await r2.arrayBuffer()).byteLength; } catch {} }
      const saved = saveFile && (first.b64 || first.url) ? await saveFile({ b64: first.b64, url: first.url, name: 'model-test-image' }).catch(() => '') : '';
      const sizeTxt = bytes ? '：' + (bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' 字节') : '';
      return done(true, '出图成功' + sizeTxt + (saved ? '，已存到 ' + saved : ''), first.url ? first.url.slice(0, 80) : '(base64)');
    }
    if (role === 'tts') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '语音合成需要单独的模型名（如 cosyvoice / fish-speech）。');
      const buf = await speech({ baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model, input: '在的，我刚忙完，你找我有事吗？', voice: conf.voice || undefined });
      const saved = saveFile ? await saveFile({ buf, name: 'model-test-voice', ext: 'mp3' }).catch(() => '') : '';
      return done(buf.length > 1000, '合成成功：' + (buf.length >= 1024 ? Math.round(buf.length / 1024) + ' KB' : buf.length + ' 字节') + ' 音频' + (saved ? '，已存到 ' + saved : ''), '第一个字节 0x' + buf.slice(0, 2).toString('hex'));
    }
    if (role === 'asr') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '语音识别需要单独的模型名。');
      // 闭环：先用 TTS 读一句，再让 ASR 听回来；TTS 不可用则退回静音样本
      let audio = null; let path2 = '（静音样本）';
      const ttsConf = resolveConf('tts', saved, {});
      if (ttsConf.baseURL && ttsConf.model) {
        try { audio = await speech({ baseURL: ttsConf.baseURL, apiKey: ttsConf.apiKey, model: ttsConf.model, input: '今天天气不错，我们出去走走吧', voice: ttsConf.voice || undefined }); path2 = '（TTS→ASR 闭环）'; } catch { audio = null; }
      }
      if (!audio) audio = makeSilentWav();
      const r = await transcribe({ baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model, file: audio, filename: 'test.wav' });
      return done(true, '接口通了 ' + path2 + '，识别结果：' + (r.text ? '「' + r.text.slice(0, 40) + '」' : '（空——用的是静音样本，属正常）'), path2);
    }
    if (role === 'vision') {
      if (!conf.baseURL || !conf.model) return done(false, 'BaseURL 或模型名没填', '', '识图需要单独的模型名（如 qwen-vl / deepseek-ocr）。');
      const png = await makeTestPng();
      const saved = saveFile ? await saveFile({ buf: png, name: 'model-test-vision.png', ext: 'png' }).catch(() => '') : '';
      const { ModelRouter } = await import('./model-router.js');
      const mr = new ModelRouter({ vision: { baseURL: conf.baseURL, apiKey: conf.apiKey, model: conf.model } });
      const text = await mr.visionDescribe({ imageData: png, mime: 'image/png', prompt: '这张图里主要是什么形状、什么颜色？一句话回答。' });
      const hit = /红/.test(text) && /(圆|圈|点|球)/.test(text);
      return done(!!text, '她看见了：' + String(text).slice(0, 60) + (saved ? '（测试图已存 ' + saved + '）' : ''), path2hint(hit));
    }
    return done(false, '未知接口：' + role);
  } catch (err) {
    const m = (err && err.message) || String(err);
    return done(false, '失败：' + m, '', hintFor(m));
  }
}

function path2hint(hit) { return hit === true ? '测试图是白底红圆，它答对了 ✅' : (hit === false ? '测试图是白底红圆，它的答案不太对，但这个模型能看图' : ''); }
function hintFor(m) {
  if (/401|403|unauthor/i.test(m)) return '钥匙不对或没权限，检查 API Key。';
  if (/404/i.test(m)) return '地址可能多了/少了一段（一般要到 /v1 为止），或者这个模型名不存在。';
  if (/timeout|abort/i.test(m)) return '超时：网络慢，或者中转站这会儿不稳。';
  if (/model/i.test(m)) return '多半是模型名不对——点「拉取列表」看看这个账号到底能用哪些。';
  return '';
}
