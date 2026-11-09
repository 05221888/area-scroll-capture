// popup：只负责「选方式 + 开采集窗」。真正的截图/拼接/导出在 capture.html 里做。
// 为什么不在 popup 里截：popup 关掉就消失，长图要十几秒；且它会抢走 active 标签。
const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function opts() {
  return {
    overlap: +$('overlap').value,
    delay: +$('delay').value,
    format: $('format').value,
    saveAs: $('saveAs').checked,
  };
}

/** 给 range 画「已填充」渐变（Chrome 不自动填） */
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100, v = +el.value;
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.background =
    `linear-gradient(to right, var(--brand) 0%, var(--brand) ${pct}%, var(--line) ${pct}%, var(--line) 100%)`;
}
const syncOverlap = () => { $('overlapV').textContent = $('overlap').value + 'px'; paintRange($('overlap')); };
const syncDelay   = () => { $('delayV').textContent   = $('delay').value   + 'ms'; paintRange($('delay')); };

$('overlap').oninput = syncOverlap;
$('delay').oninput = syncDelay;
syncOverlap(); syncDelay();

function showResult(r) {
  const el = $('res');
  el.style.display = 'block';
  el.className = 'res err';
  el.textContent = '❌ ' + (r.error || '操作失败');
}

// 取要操作的网页标签：优先当前窗口的 active tab
async function targetTab() {
  const inWin = (await chrome.tabs.query({ currentWindow: true }))
    .filter(t => /^https?:|^file:/.test(t.url || ''));
  if (inWin.length) {
    inWin.sort((a, b) => (Number(!!b.active) - Number(!!a.active)) ||
                         (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return inWin[0];
  }
  const all = (await chrome.tabs.query({})).filter(t => /^https?:|^file:/.test(t.url || ''));
  all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return all[0] || null;
}

// 页面在扩展安装前就打开时，静态 content.js 不会注入，这里兜底
async function ensureContent(tabId) {
  try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
  catch (_) {}
}

/* ---------------- 方式一：全屏长截图 ---------------- */
$('cardFull').onclick = async () => {
  try {
    const tab = await targetTab();
    if (!tab) { showResult({ ok: false, error: '找不到可截图的网页标签' }); return; }
    await ensureContent(tab.id);
    await chrome.runtime.sendMessage({ type: 'ASC_FULL_START', tabId: tab.id, options: opts() });
    window.close();
  } catch (e) {
    showResult({ ok: false, error: '启动全屏截图失败：' + (e && e.message || e) });
  }
};

/* ---------------- 方式二：区域截图（先框选） ---------------- */
$('cardRegion').onclick = async () => {
  try {
    const tab = await targetTab();
    if (!tab) { showResult({ ok: false, error: '找不到可截图的网页标签' }); return; }
    await ensureContent(tab.id);
    let r = null, err = null;
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_BEGIN_PICK' }); }
    catch (e) { err = e && e.message || String(e); }
    if (!r || !r.ok) {
      throw new Error('页面没响应框选指令（' + (err || '可能需刷新页面') + '）');
    }
    show('choose', false);
    show('stepPick', true);
    setTimeout(() => window.close(), 900);
  } catch (e) {
    showResult({ ok: false, error: '启动框选失败：' + (e && e.message || e) });
  }
};

// 打开时若已框选过，直接展示「重新截一次」
(async () => {
  const st = await chrome.storage.session.get('ascPicked');
  if (st.ascPicked) {
    show('redo', true);
    const el = $('info');
    el.style.display = 'block';
    el.innerHTML = `上次框选：<b>${st.ascPicked.tag}${st.ascPicked.id || ''}</b>（可直接重截）`;
  }
})();

$('redo').onclick = async () => {
  const st = await chrome.storage.session.get('ascPicked');
  try {
    if (st.ascPicked) {
      await chrome.runtime.sendMessage({ type: 'ASC_START', options: opts() });
    } else {
      const tab = await targetTab();
      if (!tab) throw new Error('找不到可截图的网页标签');
      await chrome.runtime.sendMessage({ type: 'ASC_FULL_START', tabId: tab.id, options: opts() });
    }
    window.close();
  } catch (e) {
    showResult({ ok: false, error: String(e && e.message || e) });
  }
};
