// 长截图 · service worker（精简版）
// ★ 架构照搬 GoFullPage：SW 只做「消息路由 + 开采集页」，不在这里截图/拼接。
//   原因：MV3 SW 会被回收，且 chrome.tabs.captureVisibleTab 在 SW 里只能整秒等配额；
//   放到扩展页面（capture.html，常驻渲染进程、有 DOM/canvas）就能
//   「滚动完立刻截、撞配额只 sleep(50) 重试」，实测快数倍。

const S = {
  picked: null,   // 最近一次框选的小窗口信息（区域模式用）
};

/* ---------------- 工具 ---------------- */

function openCapture(tabId, mode, opts) {
  const o = opts || {};
  const qs = new URLSearchParams({
    tabId: String(tabId),
    mode: mode === 'full' ? 'full' : 'region',
    overlap: String(Number.isFinite(o.overlap) ? o.overlap : 16),
    delay: String(Number.isFinite(o.delay) ? o.delay : 120),
    format: o.format === 'jpeg' ? 'jpeg' : 'png',
    saveAs: o.saveAs ? '1' : '0',
  });
  return chrome.windows.create({
    url: chrome.runtime.getURL('capture.html?' + qs.toString()),
    type: 'popup', width: 380, height: 200, left: 40, top: 40, focused: true,
  });
}

/* ---------------- 消息入口 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content：用户框选完了 → 开采集窗（区域模式）
  if (msg && msg.type === 'ASC_PICKED') {
    const tabId = sender.tab && sender.tab.id;
    S.picked = { ...msg.info, tabId, mode: 'region' };
    chrome.storage.session.set({ ascPicked: S.picked }).catch(() => {});
    if (msg.auto !== false && tabId) {
      openCapture(tabId, 'region', msg.options).catch(e => {
        chrome.storage.session.set({ ascLastResult: { ok: false, error: String(e && e.message || e), ts: Date.now() } }).catch(() => {});
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // 全屏长截图
  if (msg && msg.type === 'ASC_FULL_START') {
    const tabId = msg.tabId;
    if (!tabId) { sendResponse({ ok: false, error: '找不到目标标签页' }); return; }
    openCapture(tabId, 'full', msg.options)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }

  // 区域模式重截（已框选过）
  if (msg && msg.type === 'ASC_START') {
    chrome.storage.session.get('ascPicked').then(st => {
      const info = st.ascPicked;
      if (!info || !info.tabId) { sendResponse({ ok: false, error: '还没框选小窗口' }); return; }
      openCapture(info.tabId, 'region', msg.options)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
    });
    return true;
  }

  if (msg && msg.type === 'ASC_CLEAR') {
    S.picked = null;
    chrome.storage.session.remove(['ascPicked', 'ascProgress', 'ascLastResult']).catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg && msg.type === 'ASC_STATE') {
    sendResponse({ picked: S.picked });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ ascProgress: { phase: 'idle' } }).catch(() => {});
});
