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
const COPY_CLIP = q.get('copy') === '1';      // 截完自动复制到剪贴板
// 每帧截图前的稳定等待（ms）。0 = 只靠 content 侧的双 rAF 保证。
const FRAME_SETTLE = q.has('settle') ? Number(q.get('settle')) : 90;
// 截取范围（仅全屏模式）：from = 起始滚动位置，to = 结束滚动位置；空 = 整页
const FROM = q.has('from') && q.get('from') !== '' ? Number(q.get('from')) : null;
const TO   = q.has('to')   && q.get('to')   !== '' ? Number(q.get('to'))   : null;

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
// 让目标窗口成为前台（否则后台窗口不重绘，截图会拿到旧帧）
let capWinId = null;
async function focusTargetWindow(windowId) {
  try {
    capWinId = capWinId || (await chrome.windows.getCurrent()).id;
    await chrome.windows.update(windowId, { focused: true });
    await sleep(30);
  } catch (_) {}
}
async function restoreCaptureWindow() {
  try {
    if (capWinId) await chrome.windows.update(capWinId, { focused: true });
  } catch (_) {}
}

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
    // 先用 top=0 拿真实尺寸（也把 sticky 元素收集到"自然位置"），再滚到起始位置
    let info = await chrome.tabs.sendMessage(TAB_ID, { type: scrollType, top: 0, delay: DELAY });
    if (!info || !info.ok) throw new Error('页面没响应滚动（请刷新页面后重试）');

    const pageMax = Math.max(0, info.scrollHeight - info.clientHeight);
    const viewH = info.rect.height;
    const stride = Math.max(1, Math.floor(Math.min(info.clientHeight, viewH) - OVERLAP));

    // ★ 截取范围：默认整页；给了 from/to 就只截这一段（区域模式恒为整段）
    let startTop = 0, endTop = pageMax;
    if (MODE === 'full') {
      if (Number.isFinite(FROM)) startTop = Math.max(0, Math.min(FROM, pageMax));
      if (Number.isFinite(TO))   endTop   = Math.max(startTop, Math.min(TO, pageMax));
    }
    // 起始位置对齐到 stride 网格，保证拼接口径一致
    startTop = Math.max(0, Math.floor(startTop / stride) * stride);
    const maxScroll = endTop;

    const tops = [];
    for (let t = startTop; t < endTop; t += stride) tops.push(t);
    // 始终补最后一帧，并保证它 >= startTop
    if (!tops.length || tops[tops.length - 1] !== endTop) {
      if (endTop > startTop || !tops.length) tops.push(endTop);
    }
    if (!tops.length) tops.push(startTop);

    document.body.className = 'busy';
    $t.textContent = MODE === 'full' ? '正在截整个网页…' : '正在截小窗口…';
    setProg(0, tops.length);

    // 2) 逐帧：滚动 → 立刻截（不等固定间隔）
    const shots = [];   // { dataUrl, actualTop, rect }
    for (let i = 0; i < tops.length; i++) {
      // 每帧都显式滚到目标位置（包括第 0 帧，起始位置可能不是 0）
      let r = info;
      if (i > 0 || tops[0] !== 0) {
        // ★ 起始位置不是 0 时，第 0 帧也必须真滚一次并等渲染 —
        //   否则会拿 top=0 时的 info 当第 0 帧位置，导致整条拼接偏移（内容错序）
        r = await chrome.tabs.sendMessage(TAB_ID, { type: scrollType, top: tops[i], delay: DELAY });
        if (!r || !r.ok) throw new Error(`第 ${i + 1} 帧滚动失败（页面可能已刷新）`);
        if (Math.abs(r.actualTop - tops[i]) > 2) {
          // 页面没滚到位（惯性/懒加载/被拉回），再钉一次
          r = await chrome.tabs.sendMessage(TAB_ID, { type: scrollType, top: tops[i], delay: DELAY });
        }
      }
      // ★★ 关键：captureVisibleTab 对「非前台窗口」可能返回陈旧的合成帧。
      //   页面在后台窗口里不会持续重绘，滚动后画面不更新，截图就重复同一批内容。
      //   修法：每帧截图前把目标窗口拉到前台（本采集小窗用 focused:false 避免抢焦点）。
      await focusTargetWindow(windowId);
      await sleep(FRAME_SETTLE);
      const dataUrl = await captureOnce(windowId);
      await restoreCaptureWindow();
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
    const H = Math.max(1, Math.round((maxScroll - first.actualTop + viewH) * scale) - insPx * 2);
    if (W > 16384 || H > 16384 || W * H > 200e6) {
      throw new Error(`拼接图过大（${W}×${H}），请缩小窗口或调大重叠像素`);
    }

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = info.bg || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // ★ 用「第一帧的目标位置」作为拼接基准，而不是它回报的 actualTop：
    //   若页面没滚到位，用 actualTop 会把整条图按错误偏移拼起来（内容会错序）。
    const firstTop = Math.min(first.actualTop, tops[0]);
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
          options: { format: FORMAT, saveAs: SAVE_AS, copy: COPY_CLIP },
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

    // 不走编辑器时也支持自动复制（窗口有焦点才成功，失败静默忽略）
    if (COPY_CLIP) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      } catch (_) {}
    }

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
