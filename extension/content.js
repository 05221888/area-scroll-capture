// 区域滚动截图 · content script
// 职责：①框选可滚动小窗口 ②按指令滚动并回报"真实 scrollTop" ③采集结束后恢复页面
// 隔离世界，不污染页面全局变量；所有样式注入都带 __ASC__ 前缀且可完整还原。

(() => {
  if (window.__ASC_LOADED__) return;
  window.__ASC_LOADED__ = true;

  const ID = '__ASC_OVERLAY__';
  const LABEL = '__ASC_LABEL__';
  const HUD = '__ASC_HUD__';
  let pickerOn = false, hoverElt = null, chosen = null;
  let saved = null;       // 区域采集前的页面状态
  let fullSaved = null;   // 全屏采集前的文档滚动状态
  let savedSpec = null;   // 目标元素的稳定定位信息（chosen 丢失时用于恢复）

  /* ---------- 采集进度提示（用户点选后必须有可见反馈） ---------- */
  function showHUD(text, isError) {
    let h = document.getElementById(HUD);
    if (!h) {
      h = document.createElement('div');
      h.id = HUD;
      h.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);' +
        'background:#1b6fe0;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
        'padding:10px 18px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.35);' +
        'pointer-events:none;max-width:80vw;text-align:center;';
      document.documentElement.appendChild(h);
    }
    h.style.background = isError ? '#c62828' : '#1b6fe0';
    h.textContent = text;
    h.style.display = 'block';
  }
  function hideHUD(delay) {
    setTimeout(() => { const h = document.getElementById(HUD); if (h) h.remove(); }, delay || 0);
  }
  /* ---------- 找一个元素自身是否可滚动 ---------- */
  function scrollInfo(el) {
    if (!el || el === document.documentElement || el === document.body) return null;
    const cs = getComputedStyle(el);
    const ov = cs.overflowY;
    const canScrollY = el.scrollHeight > el.clientHeight + 2 &&
      (ov === 'auto' || ov === 'scroll' || ov === 'overlay');
    const canScrollX = el.scrollWidth > el.clientWidth + 2 &&
      (cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowX === 'overlay');
    if (!canScrollY && !canScrollX) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return {
      el, rect: r,
      scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
      maxTop: el.scrollHeight - el.clientHeight,
      vertical: canScrollY, horizontal: canScrollX,
      tag: el.tagName.toLowerCase(),
      id: el.id ? '#' + el.id : '',
      cls: (typeof el.className === 'string' && el.className.trim())
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '',
    };
  }

  // 从鼠标下的元素往上找第一个可滚动祖先（含自身）
  function findScrollable(node) {
    let el = node;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      if (el.nodeType !== 1) continue;
      const info = scrollInfo(el);
      if (info) return info;
    }
    return null;
  }

  /* ---------- 框选 UI ---------- */
  function ensureOverlay() {
    let box = document.getElementById(ID);
    if (!box) {
      box = document.createElement('div');
      box.id = ID;
      box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #4a9eff;' +
        'background:rgba(74,158,255,.12);box-shadow:0 0 0 9999px rgba(0,0,0,.35);' +
        'border-radius:4px;display:none;transition:all .06s linear;';
      document.documentElement.appendChild(box);
    }
    let lab = document.getElementById(LABEL);
    if (!lab) {
      lab = document.createElement('div');
      lab.id = LABEL;
      lab.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;' +
        'background:#1b6fe0;color:#fff;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
        'padding:5px 9px;border-radius:5px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.documentElement.appendChild(lab);
    }
    return { box, lab };
  }

  function showHover(info) {
    const { box, lab } = ensureOverlay();
    const r = info.rect;
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    lab.style.display = 'block';
    lab.style.left = Math.max(4, r.left) + 'px';
    lab.style.top = Math.max(4, r.top - 26) + 'px';
    lab.textContent = `${info.tag}${info.id}${info.cls} · ${Math.round(r.width)}×${Math.round(r.height)} · 可滚 ${info.maxTop}px`;
  }

  function hideOverlay() {
    const b = document.getElementById(ID), l = document.getElementById(LABEL);
    if (b) b.style.display = 'none';
    if (l) l.style.display = 'none';
  }

  function removeOverlay() {
    const b = document.getElementById(ID), l = document.getElementById(LABEL);
    if (b) b.remove(); if (l) l.remove();
  }

  function stopPicker() {
    pickerOn = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.style.cursor = '';
    removeOverlay();
  }

  function onMove(e) {
    if (!pickerOn) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t.id === ID || t.id === LABEL) return;
    const info = findScrollable(t);
    hoverElt = info;
    if (info) { showHover(info); document.body.style.cursor = 'crosshair'; }
    else { hideOverlay(); document.body.style.cursor = 'not-allowed'; }
  }

  function describe(info) {
    const r = info.rect;
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      scrollHeight: info.scrollHeight, clientHeight: info.clientHeight,
      scrollWidth: info.scrollWidth, clientWidth: info.clientWidth,
      maxTop: info.maxTop, vertical: info.vertical, horizontal: info.horizontal,
      tag: info.tag, id: info.id, cls: info.cls,
      pageTitle: document.title, pageUrl: location.href,
    };
  }

  function onClick(e) {
    if (!pickerOn) return;
    e.preventDefault(); e.stopPropagation();
    if (!hoverElt) return;                       // 没选中就继续选
    chosen = hoverElt.el;
    stopPicker();
    // 记住原始滚动位置，采集完恢复
    saved = { top: chosen.scrollTop, left: chosen.scrollLeft };
    // 记下稳定定位信息，便于 chosen 丢失时恢复（多实例/页面重绘）
    savedSpec = {
      sel: chosen.id ? '#' + CSS.escape(chosen.id) : null,
      cls: (typeof chosen.className === 'string' && chosen.className.trim())
        ? chosen.tagName.toLowerCase() + '.' + chosen.className.trim().split(/\s+/).slice(0, 2).map(CSS.escape).join('.')
        : null,
    };
    // ★ 不在页面上留常驻 HUD：它会被 captureVisibleTab 截进每一帧。
    //   可见反馈改由扩展图标 badge（background 里 setBadgeText）+ 完成时的 ASC_DONE 提示承担。
    const label = describe(hoverElt);
    chrome.runtime.sendMessage({ type: 'ASC_PICKED', info: label, auto: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      stopPicker();
      chrome.runtime.sendMessage({ type: 'ASC_CLEAR' });
    }
  }

  function startPicker() {
    if (pickerOn) return;
    pickerOn = true; hoverElt = null; chosen = null;
    ensureOverlay();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  /* ---------- 采集期：滚动 + 抑制干扰 ---------- */
  function prepare(el) {
    // 关掉平滑滚动，否则 chrome.tabs.captureVisibleTab 会截到动画中间态
    const old = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    // 隐藏该容器自身滚动条（避免每帧滚动条位置不一）
    const style = document.createElement('style');
    style.id = '__ASC_STYLE__';
    // 用属性选择器给目标打标记，避免生成不可靠的 CSS 路径
    el.setAttribute('data-asc-target', '1');
    style.textContent = '[data-asc-target="1"]::-webkit-scrollbar{width:0!important;height:0!important}' +
      '[data-asc-target="1"]{scrollbar-width:none!important}';
    document.head.appendChild(style);
    return { old, style };
  }

  /* ---------- ★ 抑制重复的 sticky/fixed 元素（学 GoFullPage）----------
     GoFullPage 的做法（js/page/index.js · updateFixed）：
       · 固定/粘性元素 → position:absolute 并重算 left/top 保持视觉位置
       · 若仍会重复，则非首帧直接 visibility:hidden 隐藏
     解粘（absolute）会改变容器 scrollHeight、可能顶掉内容，风险大；
     这里采用**更稳的第二条路**：这些元素只在第 1 帧可见，之后一律隐藏。
     这样长图里黄色 sticky 标题栏只出现一次，且完全不改变页面布局。 */
  const pinnedUndo = [];
  let pinnedFound = false;

  function collectPinned(scope) {
    if (!scope || pinnedFound) return;
    pinnedFound = true;
    let nodes;
    try { nodes = scope.querySelectorAll('*'); } catch (_) { return; }
    for (const n of nodes) {
      if (n.nodeType !== 1) continue;
      // 容器自身不算
      if (n === scope) continue;
      let cs;
      try { cs = getComputedStyle(n); } catch (_) { continue; }
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      pinnedUndo.push({ el: n, vis: n.style.visibility, hadStyle: n.hasAttribute('style') });
      n.setAttribute('data-asc-pinned', '1');
    }
  }

  // 首帧之后调用：把所有 sticky/fixed 元素隐藏，长图里只保留第一次出现的
  function hidePinnedAfterFirst() {
    for (const it of pinnedUndo) {
      try { it.el.style.setProperty('visibility', 'hidden', 'important'); } catch (_) {}
    }
  }

  function restorePinned() {
    while (pinnedUndo.length) {
      const it = pinnedUndo.pop();
      try {
        it.el.style.removeProperty('visibility');
        it.el.removeAttribute('data-asc-pinned');
        if (!it.hadStyle && !it.el.getAttribute('style')) it.el.removeAttribute('style');
      } catch (_) {}
    }
    pinnedFound = false;
  }

  function cleanup() {
    restorePinned();
    if (!chosen) return;
    try { chosen.style.scrollBehavior = saved ? (saved.sb || '') : ''; } catch (_) {}
    try { chosen.removeAttribute('data-asc-target'); } catch (_) {}
    const s = document.getElementById('__ASC_STYLE__');
    if (s) s.remove();
    if (saved && chosen.isConnected) {
      try { chosen.scrollTop = saved.top; chosen.scrollLeft = saved.left; } catch (_) {}
    }
    saved = null;
    chosen = null;
    savedSpec = null;
  }

  /* ---------- 消息 ---------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    // 采集进度/结果：由 SW 广播，页面里显示，避免「点了没变化」
    if (msg.type === 'ASC_PROGRESS') {
      // ★ 采集期间页面内一律不显示 HUD：captureVisibleTab 会把它截进每一帧，
      //   长图里会反复出现蓝色提示条。进度只由扩展图标 badge 显示（background 里 setBadgeText）。
      //   完成/失败时才在页面上给一次性提示（ASC_DONE 分支）。
      const h = document.getElementById(HUD); if (h) h.remove();
      return;
    }
    if (msg.type === 'ASC_DONE') {
      if (msg.ok) showHUD('✅ 长图已生成，正在下载到「下载」文件夹');
      else showHUD('❌ 采集失败：' + (msg.error || '未知错误') + '（可重新点选再试）', true);
      hideHUD(6000);
      return;
    }

    if (msg.type === 'ASC_PING') {
      sendResponse({ ok: true, alive: true });
      return;
    }

    if (msg.type === 'ASC_BEGIN_PICK') {
      startPicker();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'ASC_STOP_PICK') {
      stopPicker();
      sendResponse({ ok: true });
      return;
    }

    // ★ 全屏长图：不框选，直接滚动整个 document（等价于 GoFullPage 的活）
    if (msg.type === 'ASC_PROBE_FULL') {
      const de = document.documentElement, b = document.body;
      const innerWidth = window.innerWidth, innerHeight = window.innerHeight;
      const scrollHeight = Math.max(de.scrollHeight, b ? b.scrollHeight : 0);
      const clientHeight = de.clientHeight || innerHeight;
      const maxTop = Math.max(0, scrollHeight - clientHeight);
      fullSaved = { x: window.scrollX, y: window.scrollY, sb: de.style.scrollBehavior, htmlSb: de.style.scrollBehavior };
      de.style.scrollBehavior = 'auto';
      if (b) b.style.scrollBehavior = 'auto';
      sendResponse({
        ok: true,
        rect: { left: 0, top: 0, width: innerWidth, height: innerHeight },
        scrollHeight, clientHeight, maxTop,
        innerWidth, innerHeight,
        bg: getComputedStyle(b || de).backgroundColor || '#ffffff',
        pageTitle: document.title, pageUrl: location.href,
      });
      return;
    }

    if (msg.type === 'ASC_SCROLL_FULL') {
      const de = document.documentElement;
      if (!fullSaved) fullSaved = { x: 0, y: 0 };
      // 首次进入全屏采集：回顶部并记录 sticky/fixed 元素
      if (!fullSaved.unpinned) {
        try { window.scrollTo(0, 0); } catch (_) {}
        collectPinned(document.body || de);
        fullSaved.unpinned = true;
      } else if (msg.top > 0) {
        hidePinnedAfterFirst();
      }
      window.scrollTo({ top: msg.top, left: 0, behavior: 'auto' });
      if (window.scrollY !== msg.top && msg.top > 0) window.scrollTo(0, msg.top);
      const delay = Math.max(60, Math.min(2000, msg.delay || 350));
      setTimeout(() => {
        sendResponse({
          ok: true,
          actualTop: window.scrollY,
          rect: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          bg: getComputedStyle(document.body || de).backgroundColor || '#ffffff',
          scrollHeight: Math.max(de.scrollHeight, (document.body || de).scrollHeight),
          clientHeight: de.clientHeight || window.innerHeight,
        });
      }, delay);
      return true;
    }

    if (msg.type === 'ASC_FULL_RESTORE') {
      restorePinned();
      if (fullSaved) {
        try { window.scrollTo(fullSaved.x || 0, fullSaved.y || 0); } catch (_) {}
        try { document.documentElement.style.scrollBehavior = fullSaved.sb || ''; } catch (_) {}
        try { if (document.body) document.body.style.scrollBehavior = ''; } catch (_) {}
        fullSaved = null;
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'ASC_SCROLL') {
      // ★ 若 chosen 丢了（页面刷新、或多个 content 实例并存导致变量不共享），
      //   用采集开始时记下的定位信息尝试恢复，而不是直接失败。
      if (!chosen || !chosen.isConnected) {
        if (savedSpec) {
          const el = document.querySelector(savedSpec.sel || savedSpec.cls || 'body');
          if (el) { chosen = el; }
        }
      }
      if (!chosen || !chosen.isConnected) {
        sendResponse({ ok: false, error: '目标元素已不存在' }); return;
      }
      if (!saved) saved = { top: chosen.scrollTop, left: chosen.scrollLeft };
      if (!saved.prepared) {
        saved.sb = chosen.style.scrollBehavior;
        prepare(chosen);
        // 首帧：记录容器内所有 sticky/fixed 元素（此时它们还在正常位置）
        try { chosen.scrollTop = 0; } catch (_) {}
        collectPinned(chosen);
        saved.prepared = true;
      } else if (msg.top > 0) {
        // 第 2 帧起隐藏它们，长图里只保留第一次出现 —— 这是 GoFullPage 的精髓
        hidePinnedAfterFirst();
      }
      chosen.scrollTop = msg.top;
      // ★ 有些页面会在同步赋值后被布局/框架把 scrollTop 拉回 0。
      //   用 scrollTo 再钉一次，并在回报前校验；否则 12 帧全停在顶部重复 1→5 行。
      try { chosen.scrollTo({ top: msg.top, left: saved.left || 0, behavior: 'auto' }); } catch (_) {}
      if (chosen.scrollTop !== msg.top && msg.top > 0) chosen.scrollTop = msg.top;
      // 等两帧让渲染/懒加载落地，再读真实滚动位置
      const delay = Math.max(60, Math.min(2000, msg.delay || 350));
      setTimeout(() => {
        const r = chosen.getBoundingClientRect();
        // ★ 只取「内容区」矩形，排除 border —— getBoundingClientRect 含 border，
        //   而 scrollTop 只滚动内容区；把边框裁进去会在每个拼接处重复出现一条蓝边。
        const bl = chosen.clientLeft || 0, bt = chosen.clientTop || 0;
        const cw = chosen.clientWidth || Math.max(0, r.width - bl * 2);
        const ch = chosen.clientHeight || Math.max(0, r.height - bt * 2);
        sendResponse({
          ok: true,
          actualTop: chosen.scrollTop,
          actualLeft: chosen.scrollLeft,
          // 内容区（不含 border），供拼接裁剪
          rect: { left: r.left + bl, top: r.top + bt, width: cw, height: ch },
          // 容器外框（含 border），仅用于框选高亮显示
          box: { left: r.left, top: r.top, width: r.width, height: r.height },
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          bg: getComputedStyle(chosen).backgroundColor || '#ffffff',
          scrollHeight: chosen.scrollHeight, clientHeight: chosen.clientHeight,
        });
      }, delay);
      return true; // 异步 sendResponse
    }

    if (msg.type === 'ASC_RESTORE') {
      cleanup();
      sendResponse({ ok: true });
      return;
    }
  });
})();
