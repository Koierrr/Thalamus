import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const m = src.match(/const ROOM_HTML = \[([\s\S]*?)\]\.join/);
if (!m) { console.error('未找到 ROOM_HTML'); process.exit(1); }
const html = eval('[' + m[1] + ']').join('\n');
fs.writeFileSync(new URL('./room-preview.html', import.meta.url), html);
console.log('已导出 room-preview.html, ' + html.length + ' 字符');
