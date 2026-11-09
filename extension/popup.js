// popup：只负责「选方式 + 开采集窗」。真正的截图/拼接/导出在 capture.html 里做。
// 为什么不在 popup 里截：popup 关掉就消失，长图要十几秒；且它会抢走 active 标签。
const $ = id => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);

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
  // 截取范围：custom 直接带 from/to；view 由调用方读位置后补；all 不带（=从头到尾）
  const rm = rangeMode();
  o.rangeMode = rm;
  if (rm === 'custom') {
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
  const hint = m === 'all' ? '从头到尾' : (m === 'view' ? '从当前位置到底' : '自定义区间');
  $('rangeHint').textContent = hint;

  // 区域模式也支持范围（作用于小窗口内部）；文案随之变
  const choosing = !$('choose').classList.contains('hidden');   // 还在选方式 = 尚未进入框选
  $('rangeBox').classList.toggle('hidden', !choosing);
  // 统一文案：两种模式共用同一套设置，不因模式变化
  // （全屏：页面的滚动位置；区域：被选中小窗口内部的滚动位置）
}
document.querySelectorAll('input[name=rng]').forEach(r => {
  r.onchange = refreshRange;
});



/* ---------------- ★ 设置持久化 ----------------
   用户要求：这次选了什么，下次点开还是什么。
   所有可配置项都存 chrome.storage.local，popup 一打开就恢复。
   用 local 而不是 sync：sync 有配额且会跨设备串味，这些是本地偏好。 */
const SETTINGS_KEY = 'ascSettings';
const SETTING_FIELDS = ['overlap', 'delay', 'format', 'saveAs', 'editorOn', 'copyClip', 'rangeMode', 'fromY', 'toY'];

function collectSettings() {
  return {
    overlap: $('overlap').value,
    delay: $('delay').value,
    format: $('format').value,
    saveAs: $('saveAs').checked,
    editorOn: $('editorOn').checked,
    copyClip: $('copyClip').checked,
    rangeMode: rangeMode(),
    fromY: $('fromY').value,
    toY: $('toY').value,
  };
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  // 轻微去抖：拖滑杆时避免每像素都写一次磁盘
  saveTimer = setTimeout(() => {
    try { chrome.storage.local.set({ [SETTINGS_KEY]: collectSettings() }); } catch (_) {}
  }, 120);
}

async function restoreSettings() {
  let s = null;
  try { s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]; } catch (_) {}
  if (!s) return;
  if (s.overlap != null) $('overlap').value = s.overlap;
  if (s.delay != null) $('delay').value = s.delay;
  if (s.format != null) $('format').value = s.format;
  if (typeof s.saveAs === 'boolean') $('saveAs').checked = s.saveAs;
  if (typeof s.editorOn === 'boolean') $('editorOn').checked = s.editorOn;
  if (typeof s.copyClip === 'boolean') $('copyClip').checked = s.copyClip;
  if (typeof s.fromY === 'string') $('fromY').value = s.fromY;
  if (typeof s.toY === 'string') $('toY').value = s.toY;
  if (s.rangeMode) {
    const r = document.querySelector(`input[name=rng][value="${s.rangeMode}"]`);
    if (r) r.checked = true;
  }
  // 恢复后要把滑杆填充、范围区显隐、数值标签都刷一遍
  syncOverlap(); syncDelay();
}

// 把所有控件的变化都接到 saveSettings
function bindSettingListeners() {
  ['overlap', 'delay'].forEach(id => $(id).addEventListener('input', saveSettings));
  ['format', 'saveAs', 'editorOn', 'copyClip', 'fromY', 'toY'].forEach(id => {
    $(id).addEventListener('change', saveSettings);
    $(id).addEventListener('input', saveSettings);
  });
  document.querySelectorAll('input[name=rng]').forEach(r => r.addEventListener('change', saveSettings));
}

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
    // ★ 设置只算一次（opts 里已含 rangeMode 与 custom 的 from/to），两种模式共用
    const o = opts();
    // 先把当前设置存进 session，框选完成后 background 会合并使用
    await chrome.runtime.sendMessage({ type: 'ASC_SAVE_OPTIONS', options: o });
    // 框选时把范围选择带给 content（view 模式的 from 要等点选后才能读小窗口 scrollTop）
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_BEGIN_PICK', range: { mode: o.rangeMode, from: o.from, to: o.to } }); }
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
    const o = opts();   // 两种模式共用同一套设置（含范围）
    if (st.ascPicked) {
      // 区域重截：view 模式要用小窗口「当前」位置，交给 content 现读
      if (o.rangeMode === 'view') {
        const pos = await chrome.tabs.sendMessage(st.ascPicked.tabId, { type: 'ASC_POS_REGION' })
          .catch(() => null);
        if (pos && pos.ok) {
          if (pos.maxTop - pos.scrollTop < 40) throw new Error('小窗口已在最底部，没有可截内容');
          o.from = pos.scrollTop;
        }
      }
      await chrome.runtime.sendMessage({ type: 'ASC_SAVE_OPTIONS', options: o });
      await chrome.runtime.sendMessage({ type: 'ASC_START', options: o });
    } else {
      const tab = await targetTab();
      if (!tab) throw new Error('找不到可截图的网页标签');
      if (o.rangeMode === 'view') {
        const pos = await chrome.tabs.sendMessage(tab.id, { type: 'ASC_POS_FULL' }).catch(() => null);
        if (pos && pos.ok) {
          if (pos.maxTop - pos.scrollY < 40) throw new Error('已经在页面最底部，没有可截内容');
          o.from = pos.scrollY;
        }
      }
      await chrome.runtime.sendMessage({ type: 'ASC_FULL_START', tabId: tab.id, options: o });
    }
    window.close();
  } catch (e) {
    showResult({ ok: false, error: String(e && e.message || e) });
  }
};

/* ---------------- 启动：恢复上次设置并开始监听 ---------------- */
(async () => {
  await restoreSettings();
  bindSettingListeners();
  refreshRange();
})();
