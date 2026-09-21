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

// 6. 等任务出现（info_hash 要等元数据解析，name 先兜底；优先取 sub_file_index 匹配的那个）
//    每日免费限额用尽时任务被静默丢弃——降级为限额报告
let task = null;
for (let i = 0; i < 20 && !task; i++) {
  await sleep(1500);
  const tasks = await XL.listTasksAll(target).catch(() => []);
  const byHash = tasks.filter(t => t.params && String(t.params.info_hash || '').toLowerCase() === HASH);
  if (byHash.length) { task = byHash[0]; continue; }
  const bySub = tasks.filter(t => t.name === meta.name && t.params && t.params.sub_file_index === sub);
  if (bySub.length) task = bySub[0];
}
if (!task) {
  let quota = false;
  try { quota = XL.isQuotaExhausted(await XL.getDevice()); } catch (_) {}
  if (quota) {
    console.log('  ⚠ 今日免费下载限额已用完（非内测账号每日 3 个），任务被迅雷静默丢弃——限额检测路径验证 ✓，任务相关断言跳过');
    const view0 = await XL.syncTasks();
    console.log('  ✓ syncTasks 在无任务时正常返回', `（items=${view0.items.length}）`);
    // 注册表生命周期（不依赖真实任务）
    {
      const reg = await XL.getRegistry();
      reg['deadbeef'.repeat(5)] = { name: '测试完成', addedAt: Date.now(), state: 'completed', phase: 'PHASE_TYPE_COMPLETE', progress: 100 };
      await XL.saveRegistry(reg);
      const v2 = await XL.syncTasks();
      ok(v2.completedUnseen >= 1, '完成项常驻（sync 不清除）');
      ok(!!XL.pruneRegistry(await XL.getRegistry())['deadbeef'.repeat(5)], 'prune 不清完成项');
      ok((await XL.dismissEntry('deadbeef'.repeat(5))) === true, 'dismissEntry 点击清除');
      await XL.saveRegistry(await XL.getRegistry());
    }
    console.log(failed ? `\n${failed} 项失败` : '\n端到端通过（限额日降级模式）✓');
    process.exit(failed ? 1 : 0);
  }
  ok(false, '任务既未出现也非限额原因');
  process.exit(1);
}
ok(!!task, '任务列表找到任务（hash 或 name）', task ? `${task.name} · phase=${task.phase} · progress=${task.progress}` : '');
ok(task && task.params && task.params.sub_file_index === sub,
  'sub_file_index 生效（只下选中文件）', task && task.params ? '实际=' + task.params.sub_file_index : '');

// 7. syncTasks 注册表同步（VIP 加速下任务可能已 100%——完成态也算跟踪成功）
const view = await XL.syncTasks();
const entry = view.items.find(i => i.hash === HASH);
ok(view.items.length >= 1 && !!entry, 'syncTasks 注册表视图包含新任务',
  entry ? entry.state + ' ' + entry.statusText : '');

// 8. 清理：删除任务（含探测期间遗留的同名任务）+ 注册表
if (task) {
  await XL.deleteTask(task.id, target);
  await sleep(2500);
  const tasks2 = await XL.listTasksAll(target).catch(() => []);
  ok(!tasks2.some(t => String(t.params && t.params.info_hash || '').toLowerCase() === HASH || t.name === meta.name),
    'deleteTask 清理完成');
}
{
  const reg = await XL.getRegistry();
  delete reg[HASH];
  await XL.saveRegistry(reg);
}

// 9. 注册表生命周期（v1.0.1：完成项常驻 → 点击 dismissEntry 清除）
{
  const reg = await XL.getRegistry();
  reg['deadbeef'.repeat(5)] = { name: '测试完成', addedAt: Date.now(), state: 'completed', phase: 'PHASE_TYPE_COMPLETE', progress: 100 };
  await XL.saveRegistry(reg);
  const v2 = await XL.syncTasks();
  ok(v2.completedUnseen >= 1, '完成项常驻（sync 不清除）');
  const pruned = XL.pruneRegistry(await XL.getRegistry());
  ok(!!pruned['deadbeef'.repeat(5)], 'prune 不清完成项（等用户点击）');
  ok((await XL.dismissEntry('deadbeef'.repeat(5))) === true, 'dismissEntry 点击清除');
  const after = await XL.getRegistry();
  ok(!after['deadbeef'.repeat(5)], '清除后条目消失');
  await XL.saveRegistry(after);
}

console.log(failed ? `\n${failed} 项失败` : '\n端到端全部通过 ✓');
process.exit(failed ? 1 : 0);
