/* 迅雷版真机端到端：token → target → 解析磁力 → 部分文件建任务 → 列表同步 → 删除。
 * 运行：node test/e2e-xl.mjs（需迅雷已扫码登录） */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Node 无 chrome.storage：注入 Map-backed shim
const __store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => ({ [key]: __store.has(key) ? __store.get(key) : undefined }),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) __store.set(k, v); }
    }
  }
};
require('../config.js');
require('../xlauth.js');
const XL = require('../xunlei.js');

const MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337';
let failed = 0;
const ok = (c, label, detail) => {
  if (c) console.log('  ✓ ' + label + (detail ? ' | ' + detail : ''));
  else { failed++; console.error('  ✗ ' + label); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('== 迅雷 e2e（真容器） ==');
// 1. token
const tok = await XL.getToken(true);
ok(tok && tok.split('.').length === 3, 'token 提取（面板 uiauth JWT）', tok.slice(0, 24) + '…');

// 2. target（登录态）
let target = null;
try { target = await XL.getTarget(); } catch (e) { console.log('  ✗ ' + e.message); process.exit(1); }
ok(!!target, '登录态 target 获取', target);

// 3. 磁力解析（文件列表）
const resp = await XL.parseMagnet(MAGNET);
const meta = XL.resourceMeta(resp);
const files = XL.flattenResources(resp);
ok(!!meta && !!meta.url, '磁力解析 meta', `${meta.name} · ${meta.file_count} 文件 · ${XL.humanSize(meta.file_size)}`);
ok(files.length >= 10, '文件列表解析', files.length + ' 个子文件');

// 4. 注册表预登记（插件同款）
const HASH = XL.parseInfoHash(MAGNET);
{
  const reg = await XL.getRegistry();
  reg[HASH] = { addedAt: Date.now(), name: meta.name, state: 'active', seen: false, phase: 'PHASE_TYPE_PENDING' };
  await XL.saveRegistry(reg);
}

// 5. 部分文件建任务（只选 mp4 + poster，即 index 5 和 10）
const wantIdx = files.filter(f => /mp4$|poster\.jpg$/.test(f.name)).map(f => f.file_index);
const sub = XL.buildSubFileIndex(meta.file_count, wantIdx);
console.log('  选择文件 index:', wantIdx.join(','), '→ sub_file_index:', sub);
await XL.addTask(meta, sub, target);
ok(true, 'addTask 已提交');

// 6. 等任务出现并同步
let task = null;
for (let i = 0; i < 20 && !task; i++) {
  await sleep(1500);
  const tasks = await XL.listTasks(target).catch(() => []);
  task = tasks.find(t => t.params && String(t.params.info_hash || '').toLowerCase() === HASH);
}
ok(!!task, '任务列表按 info_hash 找到任务', task ? `${task.name} · phase=${task.phase} · progress=${task.progress}` : '');
ok(task && task.params && task.params.sub_file_index === sub,
  'sub_file_index 生效（只下选中文件）', task && task.params ? '实际=' + task.params.sub_file_index : '');

// 7. syncTasks 注册表同步
const view = await XL.syncTasks();
ok(view.activeCount >= 1, 'syncTasks 活动计数', `active=${view.activeCount}`);
ok(view.items.some(i => i.hash === HASH && i.state === 'active'), '注册表视图包含新任务');

// 8. 清理：删除任务 + 注册表
if (task) {
  await XL.deleteTask(task.id, target);
  await sleep(2500);
  const tasks2 = await XL.listTasks(target).catch(() => []);
  ok(!tasks2.some(t => String(t.params && t.params.info_hash || '').toLowerCase() === HASH), 'deleteTask 清理完成');
}
{
  const reg = await XL.getRegistry();
  delete reg[HASH];
  await XL.saveRegistry(reg);
}

// 9. 注册表生命周期（伪造完成未读 → markSeen → prune）
{
  const reg = await XL.getRegistry();
  reg['deadbeef'.repeat(5)] = { name: '测试完成', addedAt: Date.now(), state: 'completed', seen: false, phase: 'PHASE_TYPE_COMPLETE', progress: 100 };
  await XL.saveRegistry(reg);
  const v2 = await XL.syncTasks();
  ok(v2.completedUnseen >= 1, '完成未读保留');
  await XL.markCompletedSeen();
  const pruned = XL.pruneRegistry(await XL.getRegistry());
  ok(!pruned['deadbeef'.repeat(5)], '已读完成 prune 清除');
  await XL.saveRegistry(pruned);
}

console.log(failed ? `\n${failed} 项失败` : '\n端到端全部通过 ✓');
process.exit(failed ? 1 : 0);
