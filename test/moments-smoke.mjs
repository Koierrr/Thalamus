// moments-smoke：假模型下验证 生成→落盘→列表→标记已发→删除 全链路
import { MomentsWorkshop } from '../src/moments.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const fakeSoul = {
  getPersona: () => ({ name: '小暖', personaText: '爱看剧爱美食的女生', interests: ['美食'] }),
  _retrieveHybrid: async () => [{ text: '主人今天加班', importance: 3 }],
};
const moments = new MomentsWorkshop({
  dir,
  router: { async chat() { return { content: '下雨天和奶茶更配哦 ☔', backend: 'stub' }; }, async image() { return [{ b64: PNG_B64 }]; } },
  soul: fakeSoul,
  logger: () => {},
});

const d = await moments.generate({ theme: '下雨了' });
console.log('文案:', d.text, '| 配图:', d.images.length, '| 状态:', d.status);
if (!d.text.includes('奶茶')) throw new Error('文案生成异常');
if (d.images.length !== 1 || !fs.existsSync(d.images[0])) throw new Error('配图未落盘');

const list = moments.list();
if (list.length !== 1 || list[0].id !== d.id) throw new Error('草稿列表异常');

moments.markPosted(d.id);
if (moments.list()[0].status !== 'posted') throw new Error('标记已发失败');

moments.deleteDraft(d.id);
if (moments.list().length !== 0) throw new Error('删除失败');
if (fs.existsSync(d.images[0])) throw new Error('图片未清理');

console.log('MOMENTS-SMOKE ALL GREEN ✅');


// 显式退出（2026-09-13 修）：本测试会拉起定时器 / 向量预热等后台任务，事件循环不会自己空掉
// → 进程跑完不退出，外部看起来就是"烟测卡死"。断言失败时上面的 throw 会让进程以非 0 退出，
// 只有全绿才会执行到这里，所以这里就是"成功退出"的唯一出口。
process.exit(0);
