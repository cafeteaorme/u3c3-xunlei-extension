/* u3c3 搜索·迅雷版 - 迅雷 NAS 客户端 + 任务注册表
 * 依赖：config.js（U3C3_CONFIG）、xlauth.js（U3C3XLAUTH）、浏览器 chrome.storage/fetch。
 * 纯函数（parseInfoHash / flattenResources / buildSubFileIndex / buildStatusView /
 * badgeFrom 等）可在 Node 测试。
 *
 * 协议备忘（2026-09-21 实测，迅雷 3.23.5 / cnk3x/xunlei Docker）：
 *   - 入口: http://<NAS>:2345/webman/3rdparty/pan-xunlei-com/index.cgi/
 *   - 鉴权: 面板 HTML 里的 uiauth JWT（xlauth.js 提取，约 3.4 天有效）；
 *     每请求带 query ?pan_auth=<jwt> + header pan-auth: <jwt>
 *   - 登录态: POST device/info/watch {} → data.target = 设备空间 ID；
 *     未登录迅雷账号时 target 为空串
 *   - 磁力解析（含文件列表）: POST drive/v1/resource/list {urls:"magnet:..."} →
 *     list.resources[0]: {name,file_name,file_size,file_count,meta.url,
 *     dir.resources[]: 子文件，每个含 file_index}
 *   - 添加任务（原生支持按文件选择!）: POST drive/v1/task
 *     {type:"user#download-url",name,file_name,file_size:str,space:target,
 *      params:{target,url:meta.url,total_file_count:str,sub_file_index,file_id:"",
 *              parent_folder_id:""}}
 *     sub_file_index: 单文件 '--1,'；多文件 '0-2,5-5,'（区间/单点，尾随逗号）
 *   - 任务列表: GET drive/v1/tasks?filters={"type":{"in":"user#download-url,user#download"}}&space=<target>
 *     行: {id,name,file_size,progress(0-100),phase,params:{speed,info_hash,real_path}}
 *     phase: PHASE_TYPE_RUNNING/PAUSED/PENDING/ERROR/COMPLETE
 *   - 暂停: POST method/patch/drive/v1/task {id,space,type,set_params:{spec:'{"phase":"pause"}'}}
 *   - 删除: POST method/delete/drive/v1/tasks?space=<target>&task_ids=<id> body {}
 *   优点（相对 UGOS 版）: 任务在确认时才创建，取消无需清理；
 *   任务带 info_hash，注册表匹配比 UGOS 的按名字匹配可靠。
 */
(function (global) {
  'use strict';

  const CFG = global.U3C3_CONFIG || {};
  const TOKEN_KEY = 'xlToken';
  const REG_KEY = 'xlRegistry';
  const PHASE_TEXT = {
    PHASE_TYPE_RUNNING: '下载中',
    PHASE_TYPE_PENDING: '等待中',
    PHASE_TYPE_PAUSED: '已暂停',
    PHASE_TYPE_ERROR: '错误',
    PHASE_TYPE_COMPLETE: '已完成'
  };

  // ———————————————— 纯函数（Node 可测） ————————————————

  function parseInfoHash(magnet) {
    const m = String(magnet || '').match(/xt=urn:btih:([A-Za-z0-9]+)/);
    if (!m) return null;
    const v = m[1];
    if (v.length === 40 && /^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
    if (v.length === 32 && /^[a-zA-Z2-7]+$/.test(v)) return base32ToHex(v);
    return null;
  }

  function base32ToHex(s) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0, out = '';
    for (const ch of s.toUpperCase()) {
      value = (value << 5) | A.indexOf(ch);
      bits += 5;
      if (bits >= 8) { out += ((value >> (bits - 8)) & 0xff).toString(16).padStart(2, '0'); bits -= 8; }
    }
    return out;
  }

  // resource/list 响应 → 子文件清单 [{name, size, file_index}]
  function flattenResources(resp) {
    const res = resp && resp.list && resp.list.resources && resp.list.resources[0];
    if (!res) return [];
    const dir = (res.dir && res.dir.resources) || [];
    return dir.map(f => ({
      name: f.name || f.file_name || '',
      size: Number(f.file_size) || 0,
      file_index: Number(f.file_index) || 0
    }));
  }

  function resourceMeta(resp) {
    const res = resp && resp.list && resp.list.resources && resp.list.resources[0];
    if (!res) return null;
    return {
      name: res.name,
      file_name: res.file_name,
      file_size: Number(res.file_size) || 0,
      file_count: Number(res.file_count) || 1,
      url: res.meta && res.meta.url
    };
  }

  // 选中文件索引（升序）→ sub_file_index 串
  // 单文件 '--1,'；多文件压缩连续段 '0-2,5-5,'（单点也写区间形式，尾随逗号）
  function buildSubFileIndex(fileCount, indexes) {
    if (fileCount <= 1) return '--1,';
    const sorted = [...new Set(indexes)].sort((a, b) => a - b);
    if (!sorted.length) return '--1,';
    const parts = [];
    let start = sorted[0], prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const cur = sorted[i];
      if (cur !== prev + 1) {
        parts.push(start + '-' + prev);
        start = cur;
      }
      prev = cur;
    }
    return parts.join(',') + ',';
  }

  function humanSize(n) {
    n = Number(n) || 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(1)) + units[i];
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 注册表 → 弹窗状态区视图（结构同 UGOS 版 nas.js）
  function buildStatusView(reg) {
    const items = Object.entries(reg || {}).map(([hash, t]) => ({
      hash,
      addedAt: t.addedAt || 0,
      name: t.name || hash,
      state: t.state || 'active',
      seen: !!t.seen,
      statusText: t.error ? '错误' : (PHASE_TEXT[t.phase] || '下载中'),
      plan: Math.min(100, Math.max(0, t.progress || 0)),
      speedText: t.state === 'active' && t.speed > 0 ? humanSize(t.speed) + '/s' : '',
      sizeText: t.total ? humanSize(t.done) + '/' + humanSize(t.total) : (t.sizeText || '')
    }));
    items.sort((a, b) => b.addedAt - a.addedAt);
    return items;
  }

  function badgeFrom(view) {
    const unseen = view.filter(i => i.state === 'completed' && !i.seen).length;
    if (unseen > 0) return { text: 'ok', color: '#e8590c' };  // 迅雷版用橙色 ok
    const active = view.filter(i => i.state === 'active').length;
    if (active > 0) return { text: String(active), color: '#e8590c' };
    return { text: '', color: null };
  }

  function pruneRegistry(reg) {
    const out = {};
    for (const [hash, t] of Object.entries(reg || {})) {
      if (t.state === 'completed' && t.seen) continue;
      if (t.state === 'gone') continue;
      out[hash] = t;
    }
    return out;
  }

  // ———————————————— IO（浏览器专用） ————————————————
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  async function storageGet(key, fallback) {
    if (!hasChrome) return fallback;
    const o = await chrome.storage.local.get(key);
    return o[key] != null ? o[key] : fallback;
  }
  async function storageSet(key, value) {
    if (!hasChrome) return;
    await chrome.storage.local.set({ [key]: value });
  }

  class XlError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  let tokenCache = { token: null, at: 0 };

  async function getToken(force) {
    if (!force && tokenCache.token && Date.now() - tokenCache.at < 10 * 60 * 1000) {
      return tokenCache.token;
    }
    let saved = force ? null : await storageGet(TOKEN_KEY, null);
    if (saved && saved.token && Date.now() - saved.at < 6 * 60 * 60 * 1000) {
      tokenCache = saved;
      return saved.token;
    }
    const res = await fetch(CFG.XL_BASE + CFG.XL_CGI + '/', { cache: 'no-store' });
    if (!res.ok) throw new XlError('面板不可达（HTTP ' + res.status + '）', 'PANEL');
    const token = global.U3C3XLAUTH.extractTokenFromHtml(await res.text());
    if (!token) throw new XlError('面板 HTML 中未找到 uiauth token', 'TOKEN');
    tokenCache = { token: token, at: Date.now() };
    await storageSet(TOKEN_KEY, tokenCache);
    return token;
  }

  let cookieJar = '';   // Node 手工 cookie；浏览器走 credentials:'include' 自动管理

  async function api(method, path, { params, json } = {}, retried) {
    const token = await getToken();
    const url = new URL(CFG.XL_BASE + CFG.XL_CGI + path);
    url.searchParams.set('pan_auth', token);
    url.searchParams.set('device_space', '');
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const opts = {
      method,
      cache: 'no-store',
      credentials: 'include',   // 浏览器：自动携带/存储 xtoken cookie
      headers: {
        'pan-auth': token,
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };
    if (cookieJar) opts.headers['Cookie'] = cookieJar;   // Node：手工 jar
    if (json !== undefined) opts.body = JSON.stringify(json);
    let res;
    try {
      res = await fetch(url.toString(), opts);
    } catch (e) {
      throw new XlError('无法连接迅雷容器（' + (e.message || '网络错误') + '）', 'NETWORK');
    }
    const setCookie = res.headers && res.headers.get && res.headers.get('set-cookie');
    if (setCookie) {   // Node 可读到；浏览器为 null（自动处理）
      const m = String(setCookie).match(/xtoken=([^;]+)/);
      if (m) cookieJar = 'xtoken=' + m[1];
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* 容错 */ }
    if (body && body.error === 'unauthenticated') {
      throw new XlError('迅雷账号未登录：请先打开 ' + CFG.XL_BASE + ' 扫码登录迅雷账号', 'LOGIN');
    }
    if (res.status === 401 || res.status === 402) {
      if (!retried) {
        await getToken(true);
        return api(method, path, { params, json }, true);
      }
      throw new XlError('迅雷鉴权失败（' + JSON.stringify(body || '').slice(0, 120) + '）', 'AUTH');
    }
    if (!res.ok) {
      throw new XlError('HTTP ' + res.status + ' ' + JSON.stringify(body || '').slice(0, 120), res.status);
    }
    return body;
  }

  // ———————————————— 迅雷操作 ————————————————

  async function getTarget() {
    const d = await api('POST', '/device/info/watch', { json: {} });
    const target = d && d.target;
    if (!target) {
      throw new XlError('迅雷账号未登录：请打开 ' + CFG.XL_BASE + ' 扫码登录', 'LOGIN');
    }
    return target;
  }

  async function parseMagnet(magnet) {
    return api('POST', '/drive/v1/resource/list', { json: { urls: magnet } });
  }

  async function addTask(meta, subFileIndex, target) {
    return api('POST', '/drive/v1/task', {
      json: {
        type: 'user#download-url',
        name: meta.name,
        file_name: meta.file_name,
        file_size: String(meta.file_size || 0),
        space: target,
        params: {
          target: target,
          url: meta.url,
          total_file_count: String(meta.file_count || 1),
          sub_file_index: subFileIndex,
          file_id: '',
          parent_folder_id: ''
        }
      }
    });
  }

  async function listTasks(target) {
    const filters = JSON.stringify({ type: { in: 'user#download-url,user#download' } });
    const d = await api('GET', '/drive/v1/tasks', { params: { filters: filters, space: target } });
    return (d && d.tasks) || [];
  }

  async function pauseTask(id, space) {
    return api('POST', '/method/patch/drive/v1/task', {
      json: { id: id, space: space, type: 'user#download-url', set_params: { spec: '{"phase":"pause"}' } }
    });
  }

  async function deleteTask(id, space) {
    return api('POST', '/method/delete/drive/v1/tasks', { params: { space: space, task_ids: id }, json: {} });
  }

  // ———————————————— 任务注册表 + 同步 ————————————————

  async function getRegistry() { return storageGet(REG_KEY, {}); }
  async function saveRegistry(reg) { await storageSet(REG_KEY, reg); return reg; }

  async function syncTasks() {
    const reg = await getRegistry();
    const hashes = Object.keys(reg);
    if (!hashes.length) return { items: [], activeCount: 0, completedUnseen: 0 };

    let tasks = [];
    try {
      const target = await getTarget();
      tasks = await listTasks(target);
    } catch (e) {
      if (e.code === 'LOGIN') throw e;   // 未登录：向上抛给角标逻辑清空
      tasks = [];
    }

    const byHash = {};
    for (const t of tasks) {
      const h = t.params && t.params.info_hash;
      if (h) byHash[String(h).toLowerCase()] = t;
    }
    for (const hash of hashes) {
      const t = reg[hash];
      const task = byHash[hash];
      if (task) {
        t.state = task.phase === 'PHASE_TYPE_COMPLETE' ? 'completed' : 'active';
        if (t.state === 'completed' && t.phase !== task.phase) t.seen = false;
        t.phase = task.phase;
        t.name = task.name || t.name;
        t.progress = Number(task.progress) || 0;
        t.speed = Number(task.params && task.params.speed) || 0;
        t.total = Number(task.file_size) || t.total || 0;
        t.done = Math.floor((Number(task.progress) || 0) / 100 * (t.total || 0));
        t.taskId = task.id;
        t.error = task.phase === 'PHASE_TYPE_ERROR';
        if (t.state === 'completed') t.completedAt = t.completedAt || Date.now();
      } else if (t.state !== 'completed') {
        t.state = 'gone';
      }
    }
    await saveRegistry(reg);
    const items = buildStatusView(reg);
    return {
      items: items,
      activeCount: items.filter(i => i.state === 'active').length,
      completedUnseen: items.filter(i => i.state === 'completed' && !i.seen).length
    };
  }

  async function markCompletedSeen() {
    const reg = await getRegistry();
    let changed = false;
    for (const t of Object.values(reg)) {
      if (t.state === 'completed' && !t.seen) { t.seen = true; changed = true; }
    }
    if (changed) await saveRegistry(reg);
    return changed;
  }

  const api_all = {
    XlError: XlError,
    PHASE_TEXT: PHASE_TEXT,
    parseInfoHash: parseInfoHash,
    base32ToHex: base32ToHex,
    flattenResources: flattenResources,
    resourceMeta: resourceMeta,
    buildSubFileIndex: buildSubFileIndex,
    humanSize: humanSize,
    sleep: sleep,
    buildStatusView: buildStatusView,
    badgeFrom: badgeFrom,
    pruneRegistry: pruneRegistry,
    getToken: getToken,
    getTarget: getTarget,
    parseMagnet: parseMagnet,
    addTask: addTask,
    listTasks: listTasks,
    pauseTask: pauseTask,
    deleteTask: deleteTask,
    getRegistry: getRegistry,
    saveRegistry: saveRegistry,
    syncTasks: syncTasks,
    markCompletedSeen: markCompletedSeen
  };

  global.U3C3XL = api_all;
  if (typeof module !== 'undefined' && module.exports) module.exports = api_all;
})(typeof window !== 'undefined' ? window : globalThis);
