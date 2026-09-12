// voice-smoke：语音决策 + TTS 二进制处理（假 fetch）
import { Soul } from '../src/soul.js';
import { ModelRouter, speech } from '../src/model-router.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));

// ① 语音决策：rate=0 永不；rate=1 短文本必发
const soul = new Soul({ dir, router: { async chat() { return { content: '好呀 哈哈', backend: 'stub' }; } }, logger: () => {} });
const r0 = await soul.reply({ peerKey: 'p1', isOwner: true, text: '在吗', voiceRate: 0 });
if (r0.voice !== false) throw new Error('rate=0 不应有语音');
const r1 = await soul.reply({ peerKey: 'p1', isOwner: true, text: '在吗', voiceRate: 1 });
if (r1.voice !== true) throw new Error('rate=1 短文本应有语音');
console.log('✅ 语音决策（rate=0 永不 / rate=1 必发）');

// ② 长文本（>160字）不发语音条
const longSoul = new Soul({ dir, router: { async chat() { return { content: '啊'.repeat(200), backend: 'stub' }; } }, logger: () => {} });
const r2 = await longSoul.reply({ peerKey: 'p1', isOwner: true, text: '在吗', voiceRate: 1 });
if (r2.voice !== false) throw new Error('长文本不应有语音');
console.log('✅ 长文本自动跳过语音条');

// ③ TTS 二进制返回 → Buffer
const realFetch = global.fetch;
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'audio/mpeg']]), arrayBuffer: async () => MP3.buffer.slice(MP3.byteOffset, MP3.byteOffset + MP3.length), text: async () => '' });
const buf = await speech({ baseURL: 'https://x.cn', apiKey: 'k', model: 'tts-1', input: '你好' });
if (!Buffer.isBuffer(buf) || buf.length !== MP3.length) throw new Error('二进制 mp3 处理失败');
console.log('✅ TTS 二进制返回 → Buffer');

// ④ TTS JSON b64 兜底
global.fetch = async () => ({ ok: true, headers: new Map([['content-type', 'application/json']]), json: async () => ({ data: { b64: MP3.toString('base64') } }), text: async () => '' });
const buf2 = await speech({ baseURL: 'https://x.cn', apiKey: 'k', model: 'tts-1', input: '你好' });
if (!Buffer.isBuffer(buf2) || buf2.length !== MP3.length) throw new Error('JSON b64 兜底失败');
console.log('✅ TTS JSON b64 兜底');

// ⑤ TTS 错误透出
global.fetch = async () => ({ ok: false, status: 401, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ error: { message: 'bad key' } }) });
let threw = '';
try { await speech({ baseURL: 'https://x.cn', apiKey: 'bad', model: 'tts-1', input: '你好' }); } catch (e) { threw = e.message; }
if (!threw.includes('bad key')) throw new Error('TTS 错误未透出: ' + threw);
console.log('✅ TTS 错误透出（退回文字的上游前提）');
global.fetch = realFetch;

console.log('VOICE-SMOKE ALL GREEN ✅');
