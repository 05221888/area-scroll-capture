// popup：只负责「选方式 + 开采集窗」。真正的截图/拼接/导出在 capture.html 里做。
// 为什么不在 popup 里截：popup 关掉就消失，长图要十几秒；且它会抢走 active 标签。
const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
// 当前悬停/将要用的方式：'full' | 'region'（决定范围文案）
let hoverMode = 'full';

function rangeMode() {
  const r = document.querySelector('input[name=rng]:checked');
  return r ? r.value : 'all';
}

function opts() {
  const o = {
    overlap: +$('overlap').value,
    delay: +$('delay').value,
    format: $('format').value,
    saveAs: $('saveAs').checked,
    editor: $('editorOn').checked,
    copy: $('copyClip').checked,
  };
  // 截取范围：只有自定义模式才传 from/to
  if (rangeMode() === 'custom') {
    const f = $('fromY').value.trim(), t = $('toY').value.trim();
    if (f !== '') o.from = Math.max(0, +f);
    if (t !== '') o.to = Math.max(0, +t);
  }
  return o;
}

/* ---------- 截取范围 UI ---------- */
function refreshRange() {
  const m = rangeMode();
  $('customWrap').classList.toggle('hidden', m !== 'custom');
  const hint = m === 'all' ? '全部' : (m === 'view' ? '从当前位置到底' : '自定义区间');
  $('rangeHint').textContent = hint;

  // 区域模式也支持范围（作用于小窗口内部）；文案随之变
  const choosing = !$('choose').classList.contains('hidden');   // 还在选方式 = 尚未进入框选
  $('rangeBox').classList.toggle('hidden', !choosing);
  const isRegion = hoverMode === 'region';
  $('rangeTitle').textContent = isRegion ? '截取范围（小窗口内部）' : '截取范围';
  $('labAll').textContent = isRegion ? '整个小窗口' : '整页';
  $('labView').textContent = isRegion ? '从当前可见处' : '从当前可见处';
  $('fillPos').textContent = isRegion ? '取当前' : '取当前';
}
document.querySelectorAll('input[name=rng]').forEach(r => {
  r.onchange = refreshRange;
});

// 鼠标移到哪张卡，范围文案就切到对应模式
$('cardFull').addEventListener('mouseenter', () => { hoverMode = 'full'; refreshRange(); });
$('cardRegion').addEventListener('mouseenter', () => { hoverMode = 'region'; refreshRange(); });
$('cardFull').addEventListener('focus', () => { hoverMode = 'full'; refreshRange(); });
$('cardRegion').addEventListener('focus', () => { hoverMode = 'region'; refreshRange(); });

// 「取当前」：读目标页当前滚动位置填入起始
$('fillPos').onclick = async () => {
  try {
    const tab = await targetTab();
    if (!tab) { showResult({ ok: false, error: '找不到可截图的网页标签' }); return; }
    await ensureContent(tab.id);
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_POS_FULL' });
    if (!r || !r.ok) throw new Error('页面没响应');
    $('fromY').value = r.scrollY;
    $('toY').placeholder = String(r.maxTop);
  } catch (e) {
    showResult({ ok: false, error: '取当前位置失败：' + (e && e.message || e) });
  }
};
refreshRange();

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
    const o = opts();
    // ★ 「从当前可见处」：现读一次滚动位置作为起点，终点留空（到底）
    if (rangeMode() === 'view') {
      const pos = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_POS_FULL' });
      if (!pos || !pos.ok) throw new Error('页面没响应位置查询');
      o.from = pos.scrollY;
      // 已经在最底部就没得截了
      if (pos.maxTop - pos.scrollY < 40) {
        throw new Error('已经在页面最底部，没有可截内容');
      }
    }
    await chrome.runtime.sendMessage({ type: 'ASC_FULL_START', tabId: tab.id, options: o });
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
    // ★ 区域模式也需要先框选，但范围是相对「小窗口内部」的，
    //   所以「从当前可见处」只能等框选完成后由 content 侧读 scrollTop。
    //   这里先把 UI 选择带给 content，让它点选时一并记录。
    let r = null, err = null;
    const rng = { mode: rangeMode() };
    if (rangeMode() === 'custom') {
      const f = $('fromY').value.trim(), t = $('toY').value.trim();
      if (f !== '') rng.from = Math.max(0, +f);
      if (t !== '') rng.to = Math.max(0, +t);
    }
    // 先把当前设置存进 session，框选完成后 background 会合并使用
    await chrome.runtime.sendMessage({ type: 'ASC_SAVE_OPTIONS', options: opts() });
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_BEGIN_PICK', range: rng }); }
    catch (e) { err = e && e.message || String(e); }
    if (!r || !r.ok) {
      throw new Error('页面没响应框选指令（' + (err || '可能需刷新页面') + '）');
    }
    show('choose', false);
    show('stepPick', true);
    refreshRange();
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
