/* u3c3 搜索·迅雷版 - 后台：定期同步迅雷任务状态并维护图标角标
 * 角标规则：有完成未读 → 橙色 ok；否则进行中数量（橙色）；无任务 → 清除 */
'use strict';

importScripts('config.js', 'xlauth.js', 'xunlei.js');

const CFG = self.U3C3_CONFIG;

function ensureAlarm() {
  chrome.alarms.create(CFG.SYNC_ALARM, { periodInMinutes: CFG.ALARM_MINUTES });
}

async function refreshBadge() {
  try {
    const view = await self.U3C3XL.syncTasks();
    const badge = self.U3C3XL.badgeFrom(view.items);
    if (badge.text) {
      await chrome.action.setBadgeBackgroundColor({ color: badge.color });
      await chrome.action.setBadgeText({ text: badge.text });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) {
    try { await chrome.action.setBadgeText({ text: '' }); } catch (_) {}
  }
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refreshBadge(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refreshBadge(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === CFG.SYNC_ALARM) refreshBadge(); });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'refreshBadge') {
    refreshBadge().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
