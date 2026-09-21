/* 迅雷版纯函数单测（不触网）。运行：node test/xunlei.test.mjs */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
// chrome.storage shim 必须在 require xunlei.js 之前注入（hasChrome 在模块加载时求值）
globalThis.chrome = {
  storage: { local: {
    get: async (key) => ({ [key]: globalThis.__store && globalThis.__store.has(key) ? globalThis.__store.get(key) : undefined }),
    set: async (obj) => { globalThis.__store = globalThis.__store || new Map(); for (const [k, v] of Object.entries(obj)) globalThis.__store.set(k, v); }
  } }
};
require('../config.js');
require('../xlauth.js');
const XL = require('../xunlei.js');
const AUTH = require('../xlauth.js');

let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label + '\n    期望: ' + e + '\n    实际: ' + a); }
}
function ok(cond, label) {
  if (cond) console.log('  ✓ ' + label);
  else { failed++; console.error('  ✗ ' + label); }
}

console.log('xlauth.extractTokenFromHtml:');
{
  // 真机面板样本（2026-09-21 从 3.23.5 容器抓取，token 已换为等长假值）
  const html = `<!DOCTYPE html><html><head><script>
      window.foo = 1;
      function uiauth(value){ return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJrZXkiOiJVSUF1dGgiLCJleHAiOjE3OTAxOTk2MzksImlhdCI6MTc4OTk0MDQzOSwibmJmIjoxNzg5OTQwNDM5fQ.zdbEqIW6_iN6EpCciOA7zm2AtiUIolQUV" }
      other();
  </script></head><body></body></html>`;
  const tok = AUTH.extractTokenFromHtml(html);
  ok(tok && tok.startsWith('eyJhbGciOiJIUzI1NiIs'), '从面板 HTML 提取 JWT');
  eq(tok.split('.').length, 3, 'token 是三段式 JWT');
  eq(AUTH.extractTokenFromHtml('<html>无函数</html>'), null, '无 uiauth 返回 null');
  eq(AUTH.extractTokenFromHtml(''), null, '空串返回 null');
  // 单行内联形态（部分版本是单行 script）
  eq(AUTH.extractTokenFromHtml('<script>function uiauth(value){ return "abc.def.ghi" }</script>'),
    'abc.def.ghi', '单行内联形态提取');
}

console.log('parseInfoHash:');
eq(XL.parseInfoHash('magnet:?xt=urn:btih:08ADA5A7A6183AAE1E09D831DF6748D566095A10&dn=x'),
  '08ada5a7a6183aae1e09d831df6748d566095a10', '大写 hex 归一小写');
eq(XL.parseInfoHash('http://x'), null, '非磁力 null');
eq(XL.parseInfoHash(null), null, 'null 安全');

console.log('flattenResources / resourceMeta:');
{
  const resp = {
    list: { resources: [{
      name: 'Sintel', file_name: 'Sintel', file_size: 129302391, file_count: 11,
      meta: { url: 'magnet:?xt=urn:btih:08ada5...&xl=true' },
      dir: { resources: [
        { name: 'Sintel.de.srt', file_size: 1652, file_index: 0 },
        { name: 'Sintel/Sintel.mp4', file_size: 129241752, file_index: 5 },
        { name: 'poster.jpg', file_size: 46115, file_index: 10 }
      ] }
    }] }
  };
  eq(XL.flattenResources(resp), [
    { name: 'Sintel.de.srt', size: 1652, file_index: 0 },
    { name: 'Sintel/Sintel.mp4', size: 129241752, file_index: 5 },
    { name: 'poster.jpg', size: 46115, file_index: 10 }
  ], '子文件展平（含 file_index）');
  eq(XL.resourceMeta(resp), {
    name: 'Sintel', file_name: 'Sintel', file_size: 129302391, file_count: 11,
    url: 'magnet:?xt=urn:btih:08ada5...&xl=true'
  }, 'meta 提取');
  eq(XL.flattenResources({}), [], '空响应安全');
  eq(XL.flattenResources(null), [], 'null 安全');
  eq(XL.resourceMeta({}), null, '无资源 meta 返回 null');
}

console.log('buildSubFileIndex:');
eq(XL.buildSubFileIndex(1, [0]), '--1,', '单文件 → --1,');
eq(XL.buildSubFileIndex(1, []), '--1,', '单文件未选 → --1,');
eq(XL.buildSubFileIndex(11, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), '0-10,', '全选 → 单区间');
eq(XL.buildSubFileIndex(11, [5]), '5-5,', '只选一个 → 单点段');
eq(XL.buildSubFileIndex(11, [3, 4, 5, 8, 10]), '3-5,8-8,10-10,', '混合区间压缩');
eq(XL.buildSubFileIndex(11, [5, 3, 4, 4]), '3-5,', '乱序+去重自动整理');
eq(XL.buildSubFileIndex(2, []), '--1,', '多文件但空选 → 兜底全选形态');

console.log('buildStatusView / badgeFrom / pruneRegistry:');
{
  const reg = {
    aaa: { name: 'T1', addedAt: 100, state: 'active', seen: false, phase: 'PHASE_TYPE_RUNNING', progress: 40.5, speed: 524288, total: 10485760, done: 4194304 },
    bbb: { name: 'T2', addedAt: 200, state: 'completed', phase: 'PHASE_TYPE_COMPLETE', progress: 100 },
    ccc: { name: 'T3', addedAt: 300, state: 'completed', phase: 'PHASE_TYPE_COMPLETE', progress: 100 },
    ddd: { name: 'T4', addedAt: 400, state: 'active', phase: 'PHASE_TYPE_ERROR', error: true, progress: 0 },
    eee: { name: 'T5', addedAt: 500, state: 'gone' }
  };
  const view = XL.buildStatusView(reg);
  eq(view.map(i => i.hash), ['eee', 'ddd', 'ccc', 'bbb', 'aaa'], '按加入时间倒序');
  eq(view.find(i => i.hash === 'aaa').statusText, '下载中', 'RUNNING → 下载中');
  eq(view.find(i => i.hash === 'aaa').plan, 40.5, 'progress 直通（0-100）');
  eq(view.find(i => i.hash === 'aaa').speedText, '512.0KB/s', '速度文案');
  eq(view.find(i => i.hash === 'ddd').statusText, '错误', 'ERROR → 错误');
  eq(view.find(i => i.hash === 'bbb').statusText, '已完成', '完成态文案');
  eq(XL.badgeFrom(view).text, 'ok', '有完成未清除 → ok');
  eq(XL.badgeFrom(view).color, '#e8590c', 'ok 为迅雷橙');
  eq(XL.badgeFrom(view.filter(i => i.state !== 'completed' && i.hash !== 'ddd')).text, '1',
    '无完成时显示进行中数量');
  const pruned = XL.pruneRegistry(reg);
  eq(Object.keys(pruned).sort(), ['aaa', 'bbb', 'ccc', 'ddd'], 'prune 只清 gone，完成项常驻');
}

console.log('dismissEntry（点击完成项清除）:');
{
  const reg = {
    aaa: { name: 'T1', addedAt: 1, state: 'completed', phase: 'PHASE_TYPE_COMPLETE', progress: 100 },
    bbb: { name: 'T2', addedAt: 2, state: 'active', phase: 'PHASE_TYPE_RUNNING' }
  };
  await XL.saveRegistry(reg);
  ok((await XL.dismissEntry('aaa')) === true, '清除完成条目成功');
  ok((await XL.dismissEntry('zzz')) === false, '清除不存在条目返回 false');
  const after = await XL.getRegistry();
  eq(Object.keys(after), ['bbb'], '仅剩未完成条目');
  eq(XL.badgeFrom(XL.buildStatusView(after)).text, '1', '清除后 ok 消失、回到进行中数字');
}

console.log('isQuotaExhausted:');
eq(XL.isQuotaExhausted({ task_daily_limit: { title: '今日3个免费下载任务数已用完，开通会员不限次数' } }), true, '限额用完 → true');
eq(XL.isQuotaExhausted({ task_daily_limit: { title: '今日剩余 2 个免费下载任务' } }), false, '有余额 → false');
eq(XL.isQuotaExhausted({}), false, '无字段 → false');
eq(XL.isQuotaExhausted(null), false, 'null 安全');

console.log('humanSize:');
eq(XL.humanSize(0), '0B', '0 → 0B');
eq(XL.humanSize(129302391), '123.3MB', 'MB 换算');

console.log(failed ? `\n${failed} 个用例失败` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
