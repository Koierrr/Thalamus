// send-image-check.mjs — 真机验证「她能不能发图片到微信」
// 做的事：读本地账号库 → 取会话令牌 → 把一张本地图上传到微信 CDN → 以 image_item 发给主人
// 用法：ELECTRON_RUN_AS_NODE=1 ~/.dsh/electron/electron.exe test/send-image-check.mjs <图片路径>
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { uploadMediaToCdn } from '../src/weixin-media.js';
import { getUploadUrl, sendMessage, sendTextMessage } from '../src/weixin-api.js';

const dsh = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const stateFile = path.join(dsh, 'wechat-companion', 'state.json');
const imgPath = process.argv[2];
if (!imgPath) { console.log('用法: send-image-check.mjs <图片路径>'); process.exit(2); }

const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const acct = (st.accounts || []).find((a) => a.enabled === 1 && a.token);
if (!acct) { console.log('❌ 账号库里没有可用账号'); process.exit(1); }
const tokens = (st.contextTokens || {})[acct.account_id] || {};
const peers = Object.keys(tokens);
if (!peers.length) { console.log('❌ 没有会话令牌：需要主人先给她发一条消息'); process.exit(1); }
const peer = peers[0];
const contextToken = tokens[peer];

const creds = {
  botToken: acct.token,
  ilinkBotId: acct.account_id,
  baseUrl: acct.base_url || 'https://ilinkai.weixin.qq.com',
  cdnBaseUrl: acct.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
};
const data = fs.readFileSync(imgPath);
console.log('账号: ' + acct.account_id + '  收件人: ' + peer);
console.log('图片: ' + path.basename(imgPath) + '  ' + (data.length / 1024).toFixed(0) + ' KB');

const t0 = Date.now();
try {
  await sendTextMessage(creds, peer, '（发图测试）她在后台试着给你发一张照片…', contextToken);
  console.log('① 文字已发送 ' + (Date.now() - t0) + 'ms');
  const t1 = Date.now();
  const uploaded = await uploadMediaToCdn(creds, getUploadUrl, data, peer, 'image');
  console.log('② 上传 CDN 成功 ' + (Date.now() - t1) + 'ms  fileSize=' + uploaded.fileSize + '  密文=' + uploaded.fileSizeCiphertext);
  await sendMessage(creds, peer, [{ type: 2, image_item: { media: { encrypt_query_param: uploaded.encryptQueryParam, aes_key: uploaded.aesKeyBase64, encrypt_type: 1 }, mid_size: uploaded.fileSizeCiphertext } }], contextToken);
  console.log('③ 图片消息已发送 ✅ 总耗时 ' + (Date.now() - t0) + 'ms');
  console.log('请在小号微信里查看：如果收到图片，说明「她发照片」这条路是通的。');
} catch (e) {
  console.log('❌ 失败：' + e.message);
  process.exit(1);
}
