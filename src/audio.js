// audio.js — 音频转码（微信 SILK 语音 → WAV，供 ASR 识别）
import { decode } from 'silk-wasm';

/** 识别是否为 SILK 格式（微信语音特征头） */
export function isSilk(buf) {
  if (!buf || buf.length < 10) return false;
  // 微信语音: 0x02 开头 + "#!SILK_V3"
  const head = buf.slice(0, 10).toString('binary');
  return buf[0] === 0x02 && head.slice(1).startsWith('#!SILK_V3');
}

/** PCM(pcm_s16le) → WAV 封装（单声道） */
export function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate = rate*2bytes
  header.writeUInt16LE(2, 32);            // blockAlign
  header.writeUInt16LE(16, 34);           // bitsPerSample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** SILK(微信语音) → WAV；非 SILK 原样返回 */
export async function silkToWav(buf) {
  if (!isSilk(buf)) return buf;
  const r = await decode(new Uint8Array(buf), 24000);
  return pcmToWav(Buffer.from(r.data), 24000);
}
