// model-router.js — 她的大脑接线员
// 对接 OpenAI 兼容中转站（硅基流动等）：对话/生图/TTS 三角色，
// 主模型失败自动走备用链，最后兜底本地 Ollama。
// 纯协议层：不含业务逻辑。

const DEFAULT_TIMEOUT_MS = 120000;

function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!u.includes('/v1')) u += '/v1';
  return u;
}

function authHeaders(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = 'Bearer ' + apiKey;
  return h;
}

async function postJson(url, apiKey, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { data = { _raw: text.slice(0, 500) }; }
    if (!res.ok || data.error) {
      const msg = data.error?.message || data.message || data._raw || ('HTTP ' + res.status);
      throw new Error('model api error: ' + msg);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取模型列表（面板下拉用） */
export async function fetchModels({ baseURL, apiKey }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base) throw new Error('baseURL 未配置');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 15000);
  try {
    const res = await fetch(base + '/models', { headers: authHeaders(apiKey), signal: ctrl.signal });
    const text = await res.text();
    let data = {};
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok || data.error) throw new Error(data.error?.message || ('HTTP ' + res.status));
    const list = Array.isArray(data.data) ? data.data : [];
    return list.map((m) => ({ id: m.id, owned_by: m.owned_by || '' })).filter((m) => m.id);
  } finally {
    clearTimeout(timer);
  }
}

/** 对话补全：返回 { content, usage } */
export async function chatCompletion({ baseURL, apiKey, model, messages, temperature, maxTokens, signal, timeoutMs }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('chat baseURL/model 未配置');
  const body = { model, messages, stream: false };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  const data = await postJson(base + '/chat/completions', apiKey, body, timeoutMs, signal);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    // 把原始响应带出来：否则这种失败只留一句"缺少 content"，看不出是模型返回了别的形状还是接口报错
    //（真机上就遇到过：长对话摘要那条链每次失败，日志里只有这一句）。
    throw new Error('chat 返回缺少 content（原始响应：' + JSON.stringify(data).slice(0, 220) + '）');
  }
  return { content, usage: data.usage || null };
}

/** 生图（SiliconFlow 兼容）：返回 [{ url | b64 }] */
export async function generateImage({ baseURL, apiKey, model, prompt, size, n = 1, signal }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('image baseURL/model 未配置');
  const body = { model, prompt, n };
  if (size) body.size = size;
  const data = await postJson(base + '/images/generations', apiKey, body, DEFAULT_TIMEOUT_MS, signal);
  const out = (data.data || []).map((d) => (d.url ? { url: d.url } : d.b64_json ? { b64: d.b64_json } : null)).filter(Boolean);
  if (!out.length) throw new Error('image 返回为空');
  return out;
}

/** 图生图（OpenAI 兼容 /images/edits，multipart）：拿她的定稿图当底图，长相才一致。返回 {url|b64} */
export async function editImage({ baseURL, apiKey, model, prompt, image, filename = 'ref.png', size, signal }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('image baseURL/model 未配置');
  const fd = new FormData();
  fd.append('image', new Blob([image]), filename);
  fd.append('prompt', String(prompt || '').slice(0, 1200));
  fd.append('model', model);
  if (size) fd.append('size', size);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 180000);
  try {
    const res = await fetch(base + '/images/edits', {
      method: 'POST',
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
      body: fd,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok || data.error) throw new Error('图生图失败：' + (data.error?.message || ('HTTP ' + res.status + ' ' + text.slice(0, 160))));
    const list = (data.data || []).map((d) => (d.url ? { url: d.url } : d.b64_json ? { b64: d.b64_json } : null)).filter(Boolean);
    if (!list.length) throw new Error('图生图返回为空');
    return list;
  } finally {
    clearTimeout(timer);
  }
}

/** 语音合成（SiliconFlow 兼容）：返回 Buffer(mp3) */
export async function speech({ baseURL, apiKey, model, input, voice, speed, signal }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('tts baseURL/model 未配置');
  const body = { model, input: String(input || '').slice(0, 500), response_format: 'mp3' };
  if (voice) body.voice = voice;
  if (speed) body.speed = speed;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 120000);
  try {
    const res = await fetch(base + '/audio/speech', { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = 'HTTP ' + res.status;
      try { msg = JSON.parse(t).error?.message || msg; } catch {}
      throw new Error('tts error: ' + msg);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json')) {
      const data = await res.json();
      if (data.data && data.data.b64) return Buffer.from(data.data.b64, 'base64');
      if (data.audio) return Buffer.from(data.audio, 'base64');
      throw new Error('tts 返回无法识别');
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 语音识别 ASR（OpenAI 兼容 multipart /audio/transcriptions）：返回 { text } */
export async function transcribe({ baseURL, apiKey, model, file, filename = 'voice.wav', signal }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('asr baseURL/model 未配置');
  const fd = new FormData();
  fd.append('file', new Blob([file]), filename);
  fd.append('model', model);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), 120000);
  try {
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
      body: fd,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try { data = text.trim() ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!res.ok || data.error) throw new Error(data.error?.message || ('HTTP ' + res.status));
    return { text: String(data.text || '').trim() };
  } finally {
    clearTimeout(timer);
  }
}

/** 云端向量（OpenAI 兼容 /embeddings） */
export async function embedText({ baseURL, apiKey, model, input, signal }) {
  const base = normalizeBaseUrl(baseURL);
  if (!base || !model) throw new Error('embed baseURL/model 未配置');
  const data = await postJson(base + '/embeddings', apiKey, { model, input: Array.isArray(input) ? input : [input] }, 60000, signal);
  const arr = (data.data || []).map((d) => d.embedding);
  if (!arr.length) throw new Error('embeddings 返回为空');
  return Array.isArray(input) ? arr : arr[0];
}

/** 本地 Ollama 兜底（OpenAI 兼容端点） */
export async function ollamaChat({ url = 'http://127.0.0.1:11434', model, messages, temperature }, signal) {
  return chatCompletion({ baseURL: url.replace(/\/+$/, '') + '/v1', apiKey: '', model, messages, temperature, timeoutMs: 180000, signal });
}

/**
 * ModelRouter：按角色路由 + 失败降级链
 * cfg 可以是配置对象，也可以是 () => config 的加载器（面板改完即生效）
 */
export class ModelRouter {
  constructor(cfgOrLoader = {}) {
    this._get = typeof cfgOrLoader === 'function' ? cfgOrLoader : () => cfgOrLoader;
    this.lastBackend = '';
  }

  get cfg() { return this._get() || {}; }

  /**
   * 某个角色的顺位链（2026-09-12 新增：五个接口各留三个回落槽）
   * 优先用 cfg.chain[role]（一个数组，[主力, 回落1, 回落2, 回落3]）；
   * 没配 chain 就退回老写法 [cfg[role], ...cfg.fallbacks]（向后兼容）。
   */
  _chain(role, primaryKey) {
    const out = [];
    const ch = (this.cfg.chain || {})[role];
    if (Array.isArray(ch) && ch.length) {
      ch.forEach((c, i) => {
        if (c && c.baseURL && c.model) out.push({ label: role + '.' + (i === 0 ? 'primary' : 'fallback' + i), ...c });
      });
      return out;
    }
    const pri = this.cfg[primaryKey || role];
    if (pri && pri.baseURL && pri.model) out.push({ label: role + '.primary', ...pri });
    if (role === 'chat') {
      for (const fb of this.cfg.fallbacks || []) {
        if (fb && fb.baseURL && fb.model) out.push({ label: 'chat.fallback', ...fb });
      }
    }
    return out;
  }

  /** 依次尝试一条链，全部失败时抛出带每一条原因的错（排查"到底谁挂了"用） */
  async _tryChain(role, primaryKey, run) {
    const chain = this._chain(role, primaryKey);
    if (!chain.length) throw new Error(role + ' 未配置任何接口');
    const errors = [];
    for (const a of chain) {
      try {
        const r = await run(a);
        this.lastBackend = a.label;
        // 数组（生图返回 [{url|b64}]）与字符串（识图描述）原样返回——展开会把调用方弄坏
        if (Array.isArray(r) || typeof r === 'string' || r === null || r === undefined) return r;
        return { ...r, backend: a.label };
      } catch (err) {
        errors.push(a.label + '(' + (a.model || '?') + '): ' + err.message);
      }
    }
    throw new Error('全部 ' + chain.length + ' 个接口都失败了 → ' + errors.join(' | '));
  }

  _params(over = {}) {
    return { ...(this.cfg.params || {}), ...over };
  }

  async chat(messages, over = {}, signal) {
    const p = this._params(over);
    const attempts = this._chain('chat', 'chat');
    const errors = [];
    for (const a of attempts) {
      try {
        const r = await chatCompletion({
          baseURL: a.baseURL, apiKey: a.apiKey, model: a.model,
          messages, temperature: p.temperature, maxTokens: p.maxTokens, signal,
        });
        this.lastBackend = a.label;
        return { ...r, backend: a.label };
      } catch (err) {
        errors.push(a.label + '(' + (a.model || '?') + '): ' + err.message);
      }
    }
    if (this.cfg.ollama?.model) {
      try {
        const r = await ollamaChat({ url: this.cfg.ollama.url, model: this.cfg.ollama.model, messages, temperature: p.temperature }, signal);
        this.lastBackend = 'chat.ollama';
        return { ...r, backend: 'chat.ollama' };
      } catch (err) {
        errors.push('ollama: ' + err.message);
      }
    }
    throw new Error('所有对话模型都失败了 → ' + errors.join(' | '));
  }

  async image(prompt, over = {}, signal) {
    const base = { ...this.cfg.image, ...over };
    return this._tryChain('image', 'image', (a) => {
      const cfg = { ...base, ...a };
      return generateImage({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, prompt, size: cfg.size, n: cfg.n || 1, signal });
    });
  }

  async tts(input, over = {}, signal) {
    const cfg = { ...this.cfg.tts, ...over };
    return speech({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, input, voice: cfg.voice, speed: cfg.speed, signal });
  }

  /** 语音识别 ASR（她听懂语音条）：Buffer → { text } */
  async asr(fileBuffer, over = {}, signal) {
    const cfg = { ...this.cfg.asr, ...over };
    return transcribe({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model, file: fileBuffer, filename: cfg.filename || 'voice.wav', signal });
  }

  /** 识图（主模型没眼睛时借眼睛）：返回图片文字描述 */
  async visionDescribe({ imageData, mime, prompt }, over = {}, signal) {
    const base = { ...this.cfg.vision, ...over };
    const b64 = Buffer.from(imageData).toString('base64');
    return this._tryChain('vision', 'vision', async (a) => {
      const cfg = { ...base, ...a };
      const data = await postJson(normalizeBaseUrl(cfg.baseURL) + '/chat/completions', cfg.apiKey, {
        model: cfg.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt || '用一两句话描述这张图片的内容' },
          { type: 'image_url', image_url: { url: 'data:' + (mime || 'image/jpeg') + ';base64,' + b64 } },
        ] }],
        max_tokens: 300,
      }, 120000, signal);
      const text = data.choices?.[0]?.message?.content || '';
      if (!text.trim()) throw new Error('返回空内容');
      return text;
    });
  }

  /** 云端向量（OpenAI 兼容 /embeddings） */
  async embedApi({ baseURL, apiKey, model, input }, signal) {
    const data = await postJson(normalizeBaseUrl(baseURL) + '/embeddings', apiKey, { model, input: Array.isArray(input) ? input : [input] }, 60000, signal);
    const arr = (data.data || []).map((d) => d.embedding);
    if (!arr.length) throw new Error('embeddings 返回为空');
    return Array.isArray(input) ? arr : arr[0];
  }
}
