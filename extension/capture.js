// 长截图 · 采集工作页（照搬 GoFullPage 的架构）
// 为什么不放在 service worker：MV3 SW 会被回收、且 captureVisibleTab 在 SW 里
// 受配额限制只能整秒等；放在扩展页面（有 DOM、常驻渲染进程）就能像 GoFullPage 那样
// 「滚动完立刻截、撞配额只等 50ms 再试」。
//
// 关键前提：本页必须**不影响目标页成为其窗口的 active 标签**，
// 所以由 popup 用 chrome.windows.create({type:'popup'}) 开成独立小窗口。

const q = new URLSearchParams(location.search);
const TAB_ID = Number(q.get('tabId'));
const MODE = q.get('mode') === 'full' ? 'full' : 'region';
const OVERLAP = q.has('overlap') ? Number(q.get('overlap')) : 16;
const DELAY = q.has('delay') ? Number(q.get('delay')) : 120;
const FORMAT = q.get('format') === 'jpeg' ? 'jpeg' : 'png';
const SAVE_AS = q.get('saveAs') === '1';
const OPEN_EDITOR = q.get('editor') !== '0';   // 默认截完进编辑器

const $t = document.getElementById('t');
const $barI = document.querySelector('#bar > i');
const $s = document.getElementById('s');
const $e = document.getElementById('e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function setProg(done, total, text) {
  if (total) $barI.style.width = Math.round(100 * done / total) + '%';
  $s.textContent = text || (total ? `第 ${done} / ${total} 帧` : '准备中…');
}
function fail(msg) {
  document.body.className = 'bad';
  $t.textContent = '截图失败';
  $e.style.display = 'block';
  $e.textContent = msg;
  $s.textContent = '窗口将在 8 秒后关闭';
  setTimeout(() => window.close(), 8000);
}

// ★ GoFullPage 同款：不预设帧间隔，撞配额 sleep(50) 无限重试
async function captureOnce(windowId) {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('截图等待超时（配额长时间未释放）');
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const m = String(err && err.message || err);
      if (/image readback failed/i.test(m)) {
        throw new Error('屏幕可能处于锁屏状态（GPU 无法读回窗口像素），请解锁后重试');
      }
      if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(m)) { await sleep(50); continue; }
      throw err;
    }
  }
}

(async () => {
  try {
    if (!TAB_ID) throw new Error('缺少目标标签页参数');
    const tab = await chrome.tabs.get(TAB_ID);
    const windowId = tab.windowId;

    // 确保目标标签是其窗口的 active 标签（本页在独立小窗口里，不会抢）
    const cur = await chrome.tabs.query({ windowId, active: true });
    if (!cur[0] || cur[0].id !== TAB_ID) {
      await chrome.tabs.update(TAB_ID, { active: true });
      await sleep(220);
    }

    // 确保 content.js 已注入（页面在扩展安装/重载前就打开时，静态注入不会生效）
    try {
      await chrome.tabs.sendMessage(TAB_ID, { type: 'ASC_PING' });
    } catch (_) {
      try { await chrome.scripting.executeScript({ target: { tabId: TAB_ID }, files: ['content.js'] }); }
      catch (e) { throw new Error('无法注入到目标页面（' + (e && e.message || e) + '）'); }
    }

    const scrollType = MODE === 'full' ? 'ASC_SCROLL_FULL' : 'ASC_SCROLL';
    const restoreType = MODE === 'full' ? 'ASC_FULL_RESTORE' : 'ASC_RESTORE';

    // 1) 第一帧 = 位置 0，同时拿真实视口/内容尺寸
    let info = await chrome.tabs.sendMessage(TAB_ID, { type: scrollType, top: 0, delay: DELAY });
    if (!info || !info.ok) throw new Error('页面没响应滚动（请刷新页面后重试）');

    const maxScroll = Math.max(0, info.scrollHeight - info.clientHeight);
    const viewH = info.rect.height;
    const stride = Math.max(1, Math.floor(Math.min(info.clientHeight, viewH) - OVERLAP));
    const tops = [];
    for (let t = 0; t < maxScroll; t += stride) tops.push(t);
    if (tops.length === 0 || tops[tops.length - 1] !== maxScroll) tops.push(maxScroll);

    document.body.className = 'busy';
    $t.textContent = MODE === 'full' ? '正在截整个网页…' : '正在截小窗口…';
    setProg(0, tops.length);

    // 2) 逐帧：滚动 → 立刻截（不等固定间隔）
    const shots = [];   // { dataUrl, actualTop, rect }
    for (let i = 0; i < tops.length; i++) {
      let r = info;
      if (i > 0) {
        r = await chrome.tabs.sendMessage(TAB_ID, { type: scrollType, top: tops[i], delay: DELAY });
        if (!r || !r.ok) throw new Error(`第 ${i + 1} 帧滚动失败（页面可能已刷新）`);
      }
      const dataUrl = await captureOnce(windowId);
      shots.push({ dataUrl, actualTop: r.actualTop, rect: r.rect });
      setProg(i + 1, tops.length);
    }

    // 3) 恢复页面
    try { await chrome.tabs.sendMessage(TAB_ID, { type: restoreType }); } catch (_) {}

    // 4) 页面侧 canvas 拼接（有 DOM 环境，比 SW 里的 OffscreenCanvas 稳）
    setProg(tops.length, tops.length, '正在拼接…');
    const first = shots[0];
    const probeImg = await loadImg(first.dataUrl);
    const scale = probeImg.naturalWidth / (info.innerWidth || probeImg.naturalWidth);

    // 与裁剪一致地内缩 1 CSS 像素（见下面 INSET 说明）
    const INSET_CSS = 1;
    const insPx = Math.round(INSET_CSS * scale);
    const W = Math.max(1, Math.round(first.rect.width * scale) - insPx * 2);
    const H = Math.max(1, Math.round((maxScroll + viewH) * scale) - insPx * 2);
    if (W > 16384 || H > 16384 || W * H > 200e6) {
      throw new Error(`拼接图过大（${W}×${H}），请缩小窗口或调大重叠像素`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = info.bg || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    const firstTop = first.actualTop;
    // ★ 安全内缩：即便已用 clientLeft/clientTop 排掉 border，Retina 下 Math.round
    //   仍可能残留 1 物理像素的边框/阴影，拼接处就会看到一条细蓝线。
    //   这里四边各内缩 1 个 CSS 像素，彻底避免「接缝」。
    const INSET = INSET_CSS;
    for (const s of shots) {
      const img = await loadImg(s.dataUrl);
      const ins = Math.round(INSET * scale);
      const sx = Math.max(0, Math.round(s.rect.left * scale) + ins);
      const sy = Math.max(0, Math.round(s.rect.top * scale) + ins);
      const sw = Math.min(Math.round(s.rect.width * scale) - ins * 2, img.naturalWidth - sx);
      const sh = Math.min(Math.round(s.rect.height * scale) - ins * 2, img.naturalHeight - sy);
      const dy = Math.round((s.actualTop - firstTop) * scale);
      if (sw > 0 && sh > 0) ctx.drawImage(img, sx, sy, sw, sh, 0, dy, sw, sh);
    }

    // 5) 导出：canvas.toBlob → createObjectURL → downloads（GoFullPage 同款）
    setProg(tops.length, tops.length, '正在导出…');
    const mime = FORMAT === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise(res => canvas.toBlob(
      res, mime, FORMAT === 'jpeg' ? 0.92 : undefined));
    if (!blob) throw new Error('生成图片失败（canvas 过大？）');

    const prefix = MODE === 'full' ? '全屏长图' : '区域截图';
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const filename = `${prefix}-${stamp}.${FORMAT === 'jpeg' ? 'jpg' : 'png'}`;

    // ★ 先把图存进 IndexedDB（扩展页同源），编辑器据此打开；
    //   不开编辑器时退回老行为：直接下载。
    let key = null;
    try {
      await ascSweep();
      key = await ascPut(blob, { filename, w: W, h: H, mode: MODE });
    } catch (_) { key = null; }

    if (OPEN_EDITOR && key) {
      // 交接给编辑器：本窗口 380×200 太小，交给 SW 开一个够大的窗口
      document.body.className = 'ok';
      $t.textContent = '已生成';
      $barI.style.width = '100%';
      $s.textContent = `${W}×${H} · ${(blob.size / 1024 / 1024).toFixed(2)} MB · 正在打开编辑器…`;
      try {
        await chrome.runtime.sendMessage({
          type: 'ASC_EDIT', key,
          options: { format: FORMAT, saveAs: SAVE_AS },
        });
        setTimeout(() => window.close(), 260);
        return;
      } catch (e) {
        // SW 不可用就退回直接下载，别让用户白等
        console.warn('打开编辑器失败，改为直接下载', e);
      }
    }

    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename, saveAs: SAVE_AS, conflictAction: 'uniquify' });
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);

    document.body.className = 'ok';
    $t.textContent = '已保存';
    $barI.style.width = '100%';
    $s.textContent = `${W}×${H} · ${(blob.size / 1024 / 1024).toFixed(2)} MB · ${filename}`;
    setTimeout(() => window.close(), 1600);
  } catch (err) {
    fail(String(err && err.message || err));
  }
})();

function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('截图数据解码失败'));
    im.src = src;
  });
}
