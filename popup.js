/* u3c3 搜索·迅雷版 - 弹窗：搜索（同 UGOS 版）+ 迅雷文件选择（确认才建任务）+ 状态区 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const XL = window.U3C3XL;
  const CFG = window.U3C3_CONFIG;

  document.addEventListener('DOMContentLoaded', boot);

  // ———————————————— 启动 ————————————————
  async function boot() {
    bindDialog();
    await renderStatusArea();
    refreshStatus();
    runSearch();
  }

  // ———————————————— 状态区 ————————————————
  async function renderStatusArea() {
    const reg = XL.pruneRegistry(await XL.getRegistry());
    await XL.saveRegistry(reg);
    drawStatus(XL.buildStatusView(reg));
  }

  async function refreshStatus() {
    let items, err = null;
    try {
      const view = await XL.syncTasks();
      items = view.items;
    } catch (e) {
      err = e;
      items = XL.buildStatusView(await XL.getRegistry());
    }
    drawStatus(items, err ? (err.code === 'LOGIN' ? '迅雷未登录' : '迅雷连接失败') : '');
    try {
      chrome.runtime.sendMessage({ type: 'refreshBadge' }, () => void chrome.runtime.lastError);
    } catch (_) { /* ignore */ }
  }

  // 点击完成项 → 清除该条目（显示清除 + ok 角标消减）
  async function dismissEntry(hash) {
    if (await XL.dismissEntry(hash)) {
      await renderStatusArea();
      try {
        chrome.runtime.sendMessage({ type: 'refreshBadge' }, () => void chrome.runtime.lastError);
      } catch (_) { /* ignore */ }
    }
  }

  function drawStatus(items, metaOverride) {
    const sec = $('dl'), ul = $('dlList');
    if (!items.length) { sec.classList.add('hidden'); return; }
    sec.classList.remove('hidden');
    const activeN = items.filter(i => i.state === 'active').length;
    const doneN = items.filter(i => i.state === 'completed').length;
    $('dlMeta').textContent = metaOverride
      || [activeN ? activeN + ' 个进行中' : '', doneN ? doneN + ' 个已完成' : '']
        .filter(Boolean).join(' · ');
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'dl-item ' + (it.state === 'completed' ? 'st-completed'
        : (it.statusText === '错误' ? 'st-error' : 'st-active'));
      if (it.state === 'completed') {
        li.title = '点击清除该条目';
        li.addEventListener('click', () => dismissEntry(it.hash));
      }
      const dot = document.createElement('span');
      dot.className = 'dl-dot';
      const name = document.createElement('span');
      name.className = 'dl-name';
      name.textContent = it.name;
      name.title = it.name;
      const info = document.createElement('span');
      info.className = 'dl-info';
      info.textContent = it.state === 'completed'
        ? (it.sizeText || '已完成')
        : [it.statusText + (it.plan ? ' ' + it.plan.toFixed(1) + '%' : ''),
           it.speedText, it.sizeText].filter(Boolean).join(' · ');
      li.append(dot, name, info);
      ul.appendChild(li);
    }
  }

  // ———————————————— 搜索（同 UGOS 版） ————————————————
  async function runSearch() {
    showStatus('正在搜索…', '', true);
    let tab = null;
    try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch (_) {}
    const title = tab && tab.title ? tab.title : '';

    const code = U3C3.extractCode(title);
    if (!code) return showStatus('无搜索结果', title ? '' : '无法读取当前标签页标题', false);

    $('query').textContent = code;
    $('query').title = '页面标题：' + title;
    showStatus('正在搜索 ' + code + ' …', '', true);

    let items = [], netError = null;
    try {
      items = await U3C3.searchCode(code);
    } catch (e) { netError = e; }

    if (!items.length) {
      return showStatus('无搜索结果',
        netError ? '连接 u3c3.com 失败（' + (netError.name === 'AbortError' ? '超时' : netError.message || '网络错误') + '）'
                 : '',
        false);
    }
    renderList(items);
  }

  function showStatus(text, hint, spinning) {
    $('status').classList.remove('hidden');
    $('list').classList.add('hidden');
    $('statusText').textContent = text;
    $('hint').textContent = hint || '';
    $('spinner').classList.toggle('hidden', spinning === false);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  function renderList(items) {
    $('status').classList.add('hidden');
    $('list').classList.remove('hidden');
    $('list').innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'item';

      const titleEl = document.createElement('div');
      titleEl.className = 'item-title';
      titleEl.textContent = it.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'item-meta';
      metaEl.textContent = [it.size, it.date].filter(Boolean).join(' · ');

      const badgeEl = document.createElement('span');
      badgeEl.className = 'badge';
      badgeEl.textContent = '已复制 ✓';

      li.append(titleEl, metaEl, badgeEl);
      li.addEventListener('click', async () => {
        if (await copyText(it.magnet)) {
          li.classList.add('copied');
          setTimeout(() => li.classList.remove('copied'), 1200);
        }
        openSendDialog(it.magnet);
      });
      $('list').appendChild(li);
    }
  }

  // ———————————————— 文件选择对话框（迅雷版：解析在前，建任务在后） ————————————————
  let dlg = null; // {magnet, hash, meta, files, failed, cancelled}

  function bindDialog() {
    $('dlgAll').addEventListener('change', () => {
      const on = $('dlgAll').checked;
      for (const cb of $('dlgFiles').querySelectorAll('input[type=checkbox]')) cb.checked = on;
      updateSelInfo();
    });
    $('dlgConfirm').addEventListener('click', confirmDownload);
    $('dlgCancel').addEventListener('click', () => finishDialog());
    $('dlgClose').addEventListener('click', () => finishDialog());
    $('dlgWaitCancel').addEventListener('click', () => finishDialog());
  }

  function showView(name) {
    const dlgMode = name === 'dlg';
    $('dlg').classList.toggle('hidden', !dlgMode);
    $('mainView').classList.toggle('hidden', dlgMode);
    if (dlgMode) {
      $('dl').classList.add('hidden');
    } else if ($('dlList').children.length) {
      $('dl').classList.remove('hidden');
    }
  }

  async function openSendDialog(magnet) {
    dlg = {
      magnet: magnet,
      hash: XL.parseInfoHash(magnet),
      meta: null, files: null, failed: false, cancelled: false
    };
    showView('dlg');
    $('dlgWait').classList.remove('hidden');
    $('dlgBody').classList.add('hidden');
    $('dlgWaitCancel').classList.remove('hidden');
    $('dlgWaitText').textContent = '正在解析磁力文件列表…';
    $('dlgWaitCancel').textContent = '取消';

    (async () => {   // 倒计时（failed/cancelled/出列表后停止）
      const t0 = Date.now();
      while (dlg && !dlg.cancelled && !dlg.failed && !dlg.files) {
        $('dlgWaitText').textContent = '正在解析磁力文件列表… ' + Math.round((Date.now() - t0) / 1000) + 's';
        await XL.sleep(500);
      }
    })();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.META_WAIT_TIMEOUT);
    try {
      if (!dlg.hash) throw new Error('磁力链接无法解析出 infohash');
      const resp = await XL.parseMagnet(magnet);
      const meta = XL.resourceMeta(resp);
      const files = XL.flattenResources(resp);
      if (!meta || !meta.url) throw new Error('迅雷未能解析该磁力（资源可能无效）');
      if (!files.length) {
        // 单文件资源没有 dir.resources——按单文件处理
        dlg.meta = meta;
        dlg.files = [{ name: meta.name, size: meta.file_size, file_index: 0 }];
        renderFileList(dlg.files);
        return;
      }
      dlg.meta = meta;
      dlg.files = files;
      renderFileList(files);
    } catch (e) {
      dlg && (dlg.failed = true);
      showDlgError(e.code === 'LOGIN'
        ? e.message
        : '解析失败：' + (e.message || e) + (e.code === 'NETWORK' ? '（迅雷容器 ' + CFG.XL_BASE + ' 不可达）' : ''));
    } finally {
      clearTimeout(timer);
    }
  }

  function renderFileList(files) {
    $('dlgWait').classList.add('hidden');
    $('dlgBody').classList.remove('hidden');
    const ul = $('dlgFiles');
    ul.innerHTML = '';
    for (const f of files) {
      const li = document.createElement('li');
      li.className = 'dlg-file';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.index = String(f.file_index);
      cb.addEventListener('change', () => { $('dlgAll').checked = false; updateSelInfo(); });
      const name = document.createElement('span');
      name.className = 'f-name';
      name.textContent = f.name;
      name.title = f.name;
      const size = document.createElement('span');
      size.className = 'f-size';
      size.textContent = XL.humanSize(f.size);
      li.addEventListener('click', (ev) => {
        if (ev.target !== cb) { cb.checked = !cb.checked; updateSelInfo(); }
      });
      li.append(cb, name, size);
      ul.appendChild(li);
    }
    $('dlgAll').checked = true;
    updateSelInfo();
  }

  function updateSelInfo() {
    let n = 0, bytes = 0;
    const byIdx = {};
    for (const f of dlg.files) byIdx[String(f.file_index)] = f;
    for (const cb of $('dlgFiles').querySelectorAll('input[type=checkbox]')) {
      if (cb.checked) { n++; bytes += (byIdx[cb.dataset.index] || {}).size || 0; }
    }
    $('dlgSelInfo').textContent = '已选 ' + n + '/' + dlg.files.length + ' 个 · ' + XL.humanSize(bytes);
  }

  async function confirmDownload() {
    if (!dlg || !dlg.meta || !dlg.files) return;
    const btn = $('dlgConfirm');
    btn.disabled = true;
    btn.textContent = '正在提交…';
    try {
      const checked = [];
      for (const cb of $('dlgFiles').querySelectorAll('input[type=checkbox]')) {
        if (cb.checked) checked.push(Number(cb.dataset.index));
      }
      const sub = XL.buildSubFileIndex(dlg.meta.file_count, checked);
      const target = await XL.getTarget();
      await XL.addTask(dlg.meta, sub, target);

      // 落实验证：addTask 云端受理 ≠ 真执行（每日免费限额用尽时任务被静默丢弃）
      btn.textContent = '正在确认任务…';
      const appeared = await XL.waitForTask(dlg.hash, dlg.meta.name, target, 9000);
      if (!appeared) {
        let quota = false;
        try { quota = XL.isQuotaExhausted(await XL.getDevice()); } catch (_) {}
        throw Object.assign(
          new Error(quota
            ? '今日免费下载任务数已用完（非内测账号每日 3 个），任务未被迅雷执行。内测资格申请：迅雷内测 QQ 群 772445453，或等明日额度刷新'
            : '任务提交后未出现在迅雷列表，请到 ' + CFG.XL_BASE + ' 面板查看'),
          { code: quota ? 'QUOTA' : 'NOTASK' });
      }

      // 注册进状态区（按 infohash，任务列表同步时精确匹配）
      const reg = await XL.getRegistry();
      if (dlg.hash) {
        reg[dlg.hash] = {
          addedAt: Date.now(),
          name: dlg.meta.name,
          state: 'active', seen: false,
          phase: 'PHASE_TYPE_PENDING',
          sizeText: XL.humanSize(checked.length === dlg.files.length
            ? dlg.meta.file_size
            : dlg.files.filter(f => checked.indexOf(f.file_index) !== -1)
                .reduce((s, f) => s + f.size, 0))
        };
        await XL.saveRegistry(reg);
      }
      await finishDialog();
      refreshStatus();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '确认下载';
      dlg && (dlg.failed = true);
      showDlgError(e.code === 'LOGIN' ? e.message : '提交失败：' + (e.message || e));
    }
  }

  function showDlgError(msg) {
    if (dlg) dlg.failed = true;   // 停掉倒计时
    $('dlgWait').classList.remove('hidden');
    $('dlgBody').classList.add('hidden');
    $('dlgWaitText').textContent = msg;
    $('dlgWaitCancel').textContent = '关闭';
    $('dlgWaitCancel').onclick = () => finishDialog();
  }

  async function finishDialog() {
    if (dlg) dlg.cancelled = true;
    dlg = null;
    showView('main');
    $('dlgWaitCancel').textContent = '取消';
    $('dlgWaitCancel').onclick = null;
  }
})();
