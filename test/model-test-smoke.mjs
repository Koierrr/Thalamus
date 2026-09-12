// model-test-smoke.mjs — 「大脑」六接口体检的回归（用本地假中转站，不联网、不花钱）
// 覆盖：测连通、真跑一次、模型名拼错、钥匙错、没填地址、识图自动造图、语音识别 TTS→ASR 闭环、本地 Ollama 向量
// 用法：ELECTRON_RUN_AS_NODE=1 electron test/model-test-smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runModelTest, makeTestPng, makeSilentWav, resolveConf } from '../src/model-test.js';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('✅ ' + n); } else { fail++; console.log('❌ ' + n); } };

const seen = [];
const srv = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  let body = '';
  for await (const c of req) body += c;
  seen.push(req.method + ' ' + u);
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization && /bad-key/.test(req.headers.authorization)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'invalid api key' } })); }
  if (u === '/v1/models') return json({ data: [{ id: 'm-chat' }, { id: 'm-image' }, { id: 'm-tts' }, { id: 'm-asr' }, { id: 'm-vision' }] });
  if (u === '/api/tags') return json({ models: [{ name: 'bge-m3:latest' }] });
  if (u === '/v1/chat/completions') {
    const b = JSON.parse(body || '{}');
    const isVision = JSON.stringify(b.messages || []).includes('image_url');
    return json({ choices: [{ message: { content: isVision ? '图里是一个红色的圆形。' : '在的' } }], usage: { total_tokens: 7 } });
  }
  if (u === '/v1/images/generations') return json({ data: [{ b64_json: (await makeTestPng(32)).toString('base64') }] });
  if (u === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.alloc(4096, 7)); }
  if (u === '/v1/audio/transcriptions') return json({ text: '今天天气不错，我们出去走走吧' });
  if (u === '/v1/embeddings') return json({ data: [{ embedding: [0.11, 0.22, 0.33, 0.44] }] });
  res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found ' + u } }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + srv.address().port + '/v1';
const saved = [];
const saveFile = async ({ buf, b64, url, name, ext }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-'));
  const f = path.join(dir, name + '.' + (ext || 'png'));
  if (buf) fs.writeFileSync(f, buf); else if (b64) fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  saved.push(f);
  return f;
};
const savedCfg = { chat: { baseURL: BASE, apiKey: 'k', model: 'm-chat' }, tts: { baseURL: BASE, apiKey: 'k', model: 'm-tts' }, embed: { source: 'api', model: 'm-embed' } };
const T = (args) => runModelTest({ saved: savedCfg, saveFile, ...args });

// ── 素材生成器本身要正确（否则识图/语音识别测的是垃圾） ──
const png = await makeTestPng(64);
ok(png.slice(0, 8).toString('hex') === '89504e470d0a1a0a', '测试图是合法 PNG（' + png.length + ' 字节）');
const wav = makeSilentWav(200, 16000);
ok(wav.slice(0, 4).toString() === 'RIFF' && wav.readUInt32LE(4) === wav.length - 8, '静音样本是合法 WAV（' + wav.length + ' 字节）');

// ── 测连通 ──
let r = await T({ role: 'chat', deep: false, form: { baseURL: BASE, apiKey: 'k', model: 'm-chat' } });
ok(r.ok && /三样都对/.test(r.detail), '对话接口·测连通：三样都对 ✅（' + r.detail + '）');
r = await T({ role: 'vision', deep: false, form: { baseURL: BASE, apiKey: 'k', model: 'm-nope' } });
ok(!r.ok && /没有/.test(r.detail), '模型名拼错 → 测连通明确报错');
r = await runModelTest({ role: 'chat', deep: false, saved: {}, form: {} });
ok(!r.ok && /BaseURL/.test(r.detail), '没填 BaseURL → 明确失败（不会静默通过）');
r = await T({ role: 'chat', deep: false, form: { baseURL: '', apiKey: '', model: '' } });
ok(r.ok, '表单留空但保存过配置 → 回落用保存的那份（和真跑时同一规则）');
r = await T({ role: 'chat', deep: false, form: { baseURL: BASE, apiKey: 'bad-key', model: 'm-chat' } });
ok(!r.ok && /钥匙|api key/i.test(r.detail + r.hint), '钥匙错 → 提示检查 API Key');
r = await runModelTest({ role: 'chat', deep: false, saved: { chat: { baseURL: BASE, apiKey: 'k', model: '' } }, form: {} });
ok(r.ok && /模型名还没填/.test(r.detail), '只差模型名时也给通过但提醒（不骗人）');

// ── 真跑一次 ──
r = await T({ role: 'chat', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-chat' } });
ok(r.ok && /在的/.test(r.detail), '对话接口·真跑：她的大脑回话了（' + r.detail + '）');
r = await T({ role: 'image', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-image' } });
ok(r.ok && /(KB|字节)/.test(r.detail), '生图·真跑：出图并报大小（' + r.detail + '）');
r = await T({ role: 'tts', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-tts' } });
ok(r.ok && /音频/.test(r.detail), '语音合成·真跑：出音频（' + r.detail + '）');
r = await T({ role: 'asr', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-asr' } });
ok(r.ok && /天气/.test(r.detail), '语音识别·真跑：TTS→ASR 闭环听到内容（' + r.detail + '）');
r = await T({ role: 'vision', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-vision' } });
ok(r.ok && /红/.test(r.detail), '识图·真跑：自动造图后她看见了红色');
r = await T({ role: 'embed', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-embed', source: 'api' } });
ok(r.ok && /4 维/.test(r.detail), '云端向量·真跑：返回 4 维');
const ollamaUrl = 'http://127.0.0.1:' + srv.address().port;
r = await T({ role: 'embed', deep: true, form: { source: 'local', url: ollamaUrl, model: 'bge-m3' } });
ok(r.ok && /4 维/.test(r.detail), '本地 Ollama 向量·真跑：返回向量');
r = await T({ role: 'embed', deep: false, form: { source: 'local', url: ollamaUrl, model: 'bge-m3' } });
ok(r.ok, '本地 Ollama·测连通：模型在列表里 ✅');
r = await T({ role: 'embed', deep: false, form: { source: 'local', url: ollamaUrl, model: '不存在的模型' } });
ok(!r.ok && /ollama pull/.test(r.hint), '本地模型没拉过 → 给出 `ollama pull` 的建议');

// ── 兜底分支 ──
r = await T({ role: 'asr', deep: true, form: { baseURL: BASE, apiKey: 'k', model: 'm-asr' }, saved: { chat: { baseURL: BASE, apiKey: 'k', model: 'm-chat' } } });
ok(r.ok, '没配 TTS 时，语音识别退回静音样本也能测通接口');
r = await T({ role: '不存在的接口', deep: true, form: {} });
ok(!r.ok && /还没有探针|可用角色/.test(String(r.detail) + String(r.hint)), '不认识的接口名安全失败，并告诉你有哪些可用');
ok(resolveConf('vision', savedCfg, {}).baseURL === BASE, '留空=沿用对话接口（同一套回落规则）');
ok(Array.isArray(seen) && seen.some((x) => x.includes('/v1/chat/completions')), '真跑确实发出了真实 HTTP 请求');
ok(saved.length >= 3 && saved.every((f) => fs.existsSync(f)), '真跑产生的文件都落盘了（' + saved.length + ' 个）');

for (const f of saved) { try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch {} }
srv.close();
console.log(fail === 0 ? '\nMODEL-TEST ALL GREEN ✅  ' + pass + ' 项' : '\nMODEL-TEST 有失败 ❌ ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
