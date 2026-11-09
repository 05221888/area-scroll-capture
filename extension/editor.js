// 截图编辑器：裁剪 + 标注（矩形/箭头/文字/马赛克/模糊）+ 导出
// 设计：底图永远是原始截图，标注存在数组里，每次重绘按序叠加 —— 所以撤销就是删数组。
// 裁剪只改「视口矩形」，不真的裁底图，直到导出时才切 —— 这样裁剪可随时反悔。

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const KEY = q.get('key');
const FMT = q.get('format') === 'jpeg' ? 'jpeg' : 'png';
const SAVE_AS = q.get('saveAs') === '1';

const cv = $('cv');
const ctx = cv.getContext('2d');
let baseImg = null;         // Image
let baseCanvas = null;      // 原始尺寸的离屏画布（标注先画这上面）
let viewScale = 1;          // 显示缩放
let tool = 'select';
let color = '#e11d48';
let lineW = 4;
let lineWBasis = 4;   // 载图后按图宽重算
let filled = false;
let annos = [];             // 标注
let redoStack = [];
let crop = null;            // {x,y,w,h} 原始坐标
let zoom = 1;

/* ---------------- 载入 ---------------- */
(async () => {
  if (!KEY) { msg('缺少图片参数'); return; }
  const rec = await ascGet(KEY);
  if (!rec || !rec.blob) { msg('图片已过期，请重新截图'); return; }
  const url = URL.createObjectURL(rec.blob);
  baseImg = await loadImg(url);
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  baseCanvas = document.createElement('canvas');
  baseCanvas.width = baseImg.naturalWidth;
  baseCanvas.height = baseImg.naturalHeight;
  baseCanvas.getContext('2d').drawImage(baseImg, 0, 0);

  cv.width = baseCanvas.width;
  cv.height = baseCanvas.height;
  $('dim').textContent = `${baseCanvas.width} × ${baseCanvas.height}`;

  // 线宽/字号随图宽自适应：长图缩到 30% 看时 4px 会细得看不见
  lineWBasis = Math.max(3, Math.round(baseCanvas.width / 260));
  lineW = lineWBasis;
  rebuildWidths();

  fitView();
  render();
  msg('');
})();

function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('图片解码失败'));
    im.src = src;
  });
}

function msg(t) { $('msg').textContent = t || ''; }

/* ---------------- 视图缩放 ---------------- */
function fitView(mode) {
  const stage = $('stage');
  const pad = 40;
  const aw = Math.max(50, stage.clientWidth - pad);
  const ah = Math.max(50, stage.clientHeight - pad);
  if (!baseCanvas) return;
  if (mode === 'window') {
    zoom = Math.min(aw / baseCanvas.width, ah / baseCanvas.height);
  } else if (mode === 'width') {
    zoom = Math.min(aw / baseCanvas.width, 1);
  } else {
    // 自动：长图（高宽比 > 1.8）按宽度铺满，用户上下滚；否则整体适应
    const ratio = baseCanvas.height / baseCanvas.width;
    zoom = ratio > 1.8
      ? Math.min(aw / baseCanvas.width, 1)
      : Math.min(aw / baseCanvas.width, ah / baseCanvas.height);
  }
  zoom = Math.max(0.03, Math.min(4, zoom));
  applyZoom();
}

function applyZoom() {
  if (!baseCanvas) return;
  cv.style.width = Math.round(baseCanvas.width * zoom) + 'px';
  cv.style.height = 'auto';
  $('wrap').style.width = Math.round(baseCanvas.width * zoom) + 'px';
  viewScale = zoom;
  render();
}

/* ---------------- 渲染 ---------------- */
function render() {
  if (!baseCanvas) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(baseCanvas, 0, 0);

  for (const a of annos) drawAnno(a, false, ctx);

  if (drawing) drawAnno(drawing, true, ctx);

  drawTextSelection(ctx);

  // 裁剪态：画暗区
  if (tool === 'crop' && crop) syncCropUI();
}

function drawAnno(a, preview, C) {
  const g = C || ctx;
  g.save();
  g.lineWidth = a.w;
  g.strokeStyle = a.color;
  g.fillStyle = a.color;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  if (a.type === 'rect') {
    g.globalAlpha = preview ? 0.75 : 1;
    if (a.filled) {
      g.globalAlpha = preview ? 0.28 : 0.34;
      g.fillRect(a.x, a.y, a.w2, a.h2);
      g.globalAlpha = 1;
    }
    g.strokeRect(a.x, a.y, a.w2, a.h2);
  }

  if (a.type === 'arrow') {
    g.globalAlpha = preview ? 0.8 : 1;
    drawArrow(a.x, a.y, a.x2, a.y2, a.w);
  }

  if (a.type === 'text') {
    g.globalAlpha = preview ? 0.8 : 1;
    const fs = a.size;
    g.font = `600 ${fs}px -apple-system,"PingFang SC",sans-serif`;
    g.textBaseline = 'top';
    // 描边让文字在任何底色上都可读
    g.lineWidth = Math.max(2, fs * 0.14);
    g.strokeStyle = 'rgba(255,255,255,.92)';
    g.strokeText(a.text, a.x, a.y);
    g.fillStyle = a.color;
    g.fillText(a.text, a.x, a.y);
  }

  if (a.type === 'mosaic') {
    g.globalAlpha = 1;
    const block = Math.max(6, Math.round(12 / viewScale));
    const sx = Math.max(0, Math.round(a.x)), sy = Math.max(0, Math.round(a.y));
    const sw = Math.round(a.w2), sh = Math.round(a.h2);
    if (sw > 1 && sh > 1) {
      const tmp = document.createElement('canvas');
      const cols = Math.max(1, Math.round(sw / block));
      const rows = Math.max(1, Math.round(sh / block));
      tmp.width = cols; tmp.height = rows;
      const tc = tmp.getContext('2d');
      tc.drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, cols, rows);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, cols, rows, sx, sy, sw, sh);
      g.imageSmoothingEnabled = true;
    }
  }

  if (a.type === 'blur') {
    g.globalAlpha = 1;
    g.save();
    g.beginPath();
    g.rect(a.x, a.y, a.w2, a.h2);
    g.clip();
    try { g.filter = 'blur(9px)'; } catch (_) {}
    g.drawImage(baseCanvas, 0, 0);
    g.filter = 'none';
    g.restore();
  }

  g.restore();
}

function drawArrow(x1, y1, x2, y2, w) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, w * 3.2);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/* ---------------- 文字：包围盒 / 命中 / 选中 ---------------- */
let selText = null;       // 当前选中的文字标注

function textMetrics(a) {
  const fs = a.size;
  ctx.save();
  ctx.font = `600 ${fs}px -apple-system,"PingFang SC",sans-serif`;
  const w = ctx.measureText(a.text).width;
  ctx.restore();
  return { w, h: fs * 1.25 };
}

function textBounds(a) {
  const m = textMetrics(a);
  return { x: a.x, y: a.y, w: m.w, h: m.h };
}

// 从后往前找（后画的在上面），留 6px 容错方便点中
function hitText(p, pad) {
  const tol = (pad == null ? 6 : pad) / viewScale;
  for (let i = annos.length - 1; i >= 0; i--) {
    const a = annos[i];
    if (a.type !== 'text') continue;
    const b = textBounds(a);
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol &&
        p.y >= b.y - tol && p.y <= b.y + b.h + tol) return a;
  }
  return null;
}

// 选中态用虚线框标出来
function drawTextSelection(g) {
  if (!selText) return;
  const b = textBounds(selText);
  const d = 3 / viewScale;
  g.save();
  g.strokeStyle = '#2563eb';
  g.lineWidth = 1.5;
  g.setLineDash([5, 4]);
  g.strokeRect(b.x - d, b.y - d, b.w + d * 2, b.h + d * 2);
  g.setLineDash([]);
  g.restore();
}

/* ---------------- 坐标换算 ---------------- */
function toCanvas(e) {
  const r = cv.getBoundingClientRect();
  const x = (e.clientX - r.left) / (r.width / cv.width);
  const y = (e.clientY - r.top) / (r.height / cv.height);
  return { x: Math.max(0, Math.min(cv.width, x)), y: Math.max(0, Math.min(cv.height, y)) };
}

/* ---------------- 交互 ---------------- */
let drawing = null, dragStart = null;

cv.addEventListener('pointerdown', e => {
  if (!baseCanvas) return;
  try { cv.setPointerCapture(e.pointerId); } catch (_) {}   // 合成事件/异常 pointerId 不应中断后续逻辑
  const p = toCanvas(e);

  if (tool === 'select') {
    // ★ 点中已有文字 → 打开属性面板改内容/大小/颜色
    const hit = hitText(p);
    if (hit) {
      e.preventDefault();
      openTextPanel(hit);
      dragStart = null;
      return;
    }
    closeTextPanelIfOpen();
    dragStart = p;
    return;
  }

  if (tool === 'crop') {
    if (crop) { dragStart = { ...p, mode: hitCrop(p) }; }
    else { dragStart = { ...p, mode: 'new' }; crop = { x: p.x, y: p.y, w: 0, h: 0 }; }
    return;
  }

  if (tool === 'text') {
    // 点已有文字 → 编辑它；点空白 → 新建
    const hit = hitText(p);
    if (hit) { e.preventDefault(); openTextPanel(hit); return; }
    const a = {
      type: 'text', x: p.x, y: p.y, text: '双击修改',
      color, size: Math.max(20, Math.round(lineW * 4.5)),
    };
    annos.push(a);
    redoStack = [];
    render(); syncUndo();
    // 直接进入面板，光标已选中占位文字，输入即替换
    openTextPanel(a);
    $('txText').select();
    return;
  }

  drawing = newAnno(tool, p);
});

cv.addEventListener('pointermove', e => {
  const p = toCanvas(e);
  $('posX').textContent = `${Math.round(p.x)}, ${Math.round(p.y)}`;

  if (!dragStart && !drawing) return;

  if (drawing) {
    drawing.x2 = p.x; drawing.y2 = p.y;
    if (drawing.type === 'rect' || drawing.type === 'mosaic' || drawing.type === 'blur') {
      drawing.w2 = Math.abs(p.x - drawing.x); drawing.h2 = Math.abs(p.y - drawing.y);
      drawing.x = Math.min(drawing.x, p.x); drawing.y = Math.min(drawing.y, p.y);
      // 保持 x/y 为左上角，同时把起点记住
      drawing._sx = drawing._sx ?? drawing.x;
    }
    render();
    return;
  }

  if (dragStart && tool === 'crop') {
    if (dragStart.mode === 'new') {
      crop.x = Math.min(dragStart.x, p.x);
      crop.y = Math.min(dragStart.y, p.y);
      crop.w = Math.abs(p.x - dragStart.x);
      crop.h = Math.abs(p.y - dragStart.y);
    } else if (dragStart.mode === 'move') {
      crop.x += p.x - dragStart.x; crop.y += p.y - dragStart.y;
      dragStart = { ...p, mode: 'move' };
    } else {
      applyHandle(dragStart.mode, p);
    }
    syncCropUI();
  }
});

cv.addEventListener('pointerup', e => {
  const p = toCanvas(e);
  if (drawing) {
    finalizeAnno(drawing);
    drawing = null;
    render(); syncUndo();
  }
  if (tool === 'crop' && crop) {
    clampCrop();
    syncCropUI();
    msg(`裁剪 ${Math.round(crop.w)} × ${Math.round(crop.h)}`);
  }
  dragStart = null;
  try { cv.releasePointerCapture(e.pointerId); } catch (_) {}
});

function newAnno(type, p) {
  const base = { type, color, w: lineW, filled };
  if (type === 'rect' || type === 'mosaic' || type === 'blur') {
    return { ...base, x: p.x, y: p.y, w2: 0, h2: 0 };
  }
  return { ...base, x: p.x, y: p.y, x2: p.x, y2: p.y };
}

function finalizeAnno(a) {
  if (a.type === 'rect' || a.type === 'mosaic' || a.type === 'blur') {
    if (a.w2 < 3 || a.h2 < 3) return;      // 误点忽略
    a.x = Math.min(a.x, a.x + a.w2);
    a.y = Math.min(a.y, a.y + a.h2);
  } else {
    const d = Math.hypot(a.x2 - a.x, a.y2 - a.y);
    if (d < 5) return;
  }
  delete a._sx;
  annos.push(a);
  redoStack = [];
}

/* ---------------- 裁剪辅助 ---------------- */
function hitCrop(p) {
  if (!crop) return 'new';
  const pad = 10 / viewScale;
  const near = (v, t) => Math.abs(v - t) < pad;
  const inL = near(p.x, crop.x), inR = near(p.x, crop.x + crop.w);
  const inT = near(p.y, crop.y), inB = near(p.y, crop.y + crop.h);
  if (inL && inT) return 'nw';
  if (inR && inT) return 'ne';
  if (inL && inB) return 'sw';
  if (inR && inB) return 'se';
  const inside = p.x > crop.x && p.x < crop.x + crop.w && p.y > crop.y && p.y < crop.y + crop.h;
  return inside ? 'move' : 'new';
}

function applyHandle(mode, p) {
  const r = { x: crop.x, y: crop.y, r: crop.x + crop.w, b: crop.y + crop.h };
  if (mode.includes('n')) r.y = p.y;
  if (mode.includes('s')) r.b = p.y;
  if (mode.includes('w')) r.x = p.x;
  if (mode.includes('e')) r.r = p.x;
  crop = { x: Math.min(r.x, r.r), y: Math.min(r.y, r.b), w: Math.abs(r.r - r.x), h: Math.abs(r.b - r.y) };
}

function clampCrop() {
  if (!crop) return;
  crop.w = Math.max(10, Math.min(crop.w, cv.width));
  crop.h = Math.max(10, Math.min(crop.h, cv.height));
  crop.x = Math.max(0, Math.min(crop.x, cv.width - crop.w));
  crop.y = Math.max(0, Math.min(crop.y, cv.height - crop.h));
}

// 裁剪初始框：不要占满整图（长图上会是个巨大的框，反而不好调），
// 给一个居中的中等尺寸，用户拖边框/四角自行扩大缩小。
function defaultCrop() {
  const cw = Math.min(cv.width * 0.6, 1200);
  const ch = Math.min(cv.height * 0.35, 900);
  return {
    x: Math.round((cv.width - cw) / 2),
    y: Math.round((cv.height - ch) / 2),
    w: Math.round(cw),
    h: Math.round(ch),
  };
}

function syncCropUI() {
  const mask = $('cropMask');
  if (tool !== 'crop' || !crop) { mask.classList.remove('on'); return; }
  mask.classList.add('on');
  const s = viewScale;
  const x = crop.x * s, y = crop.y * s, w = crop.w * s, h = crop.h * s;
  const W = cv.clientWidth, H = cv.clientHeight;
  const box = $('cropBox');
  box.style.left = x + 'px'; box.style.top = y + 'px';
  box.style.width = w + 'px'; box.style.height = h + 'px';
  $('shT').style.cssText = `left:0;top:0;width:${W}px;height:${Math.max(0, y)}px`;
  $('shB').style.cssText = `left:0;top:${y + h}px;width:${W}px;height:${Math.max(0, H - y - h)}px`;
  $('shL').style.cssText = `left:0;top:${y}px;width:${Math.max(0, x)}px;height:${h}px`;
  $('shR').style.cssText = `left:${x + w}px;top:${y}px;width:${Math.max(0, W - x - w)}px;height:${h}px`;
}


/* ---------------- 工具悬浮提示 ---------------- */
// 悬停 450ms 才显示（避免扫过一排工具时就乱弹），移开立即隐藏。
// 用自定义 tooltip 而不是 title：原生 title 要 1 秒以上、样式不可控、且无法放快捷键。
const TIP = $('tip');
let tipTimer = null, tipOn = null;

function showTip(btn) {
  const name = btn.dataset.tip;
  const desc = btn.dataset.desc || '';
  if (!name) return;
  TIP.innerHTML = `<b>${name}</b>${desc}`;
  TIP.classList.add('on');
  tipOn = btn;
  const r = btn.getBoundingClientRect();
  // 先定 left，量到实际高度后再垂直居中（否则用旧高度会偏）
  TIP.style.left = (r.right + 12) + 'px';
  TIP.style.top = '0px';
  const th = TIP.offsetHeight;
  let top = r.top + r.height / 2 - th / 2;
  top = Math.max(8, Math.min(window.innerHeight - th - 8, top));
  TIP.style.top = top + 'px';
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  TIP.classList.remove('on');
  tipOn = null;
}

document.querySelectorAll('#tools .tool, #opts .tool').forEach(btn => {
  btn.addEventListener('mouseenter', () => {
    hideTip();
    tipTimer = setTimeout(() => showTip(btn), 450);
  });
  btn.addEventListener('mouseleave', hideTip);
  btn.addEventListener('mousedown', hideTip);   // 点了就收起
});

// 滚动/缩放时提示位置会失效，直接收起
$('stage').addEventListener('scroll', hideTip, true);
window.addEventListener('resize', hideTip);

/* ---------------- 工具切换 ---------------- */
document.querySelectorAll('#tools .tool').forEach(b => {
  b.onclick = () => setTool(b.dataset.t);
});

function setTool(t) {
  closeTextPanelIfOpen();
  tool = t;
  document.querySelectorAll('#tools .tool').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const needOpts = ['rect', 'arrow', 'text'].includes(t);
  $('opts').classList.toggle('show', needOpts);
  $('wrap').className = t === 'select' ? 'cursor-default' : (t === 'crop' ? 'cursor-move' : '');
  if (t !== 'crop') { $('cropMask').classList.remove('on'); }
  else if (!crop) { crop = defaultCrop(); }
  if (t === 'crop') { syncCropUI(); msg('拖动边框或四角调整范围，拖框内可移动'); }
  render();
}

/* 颜色 */
const COLORS = ['#e11d48', '#dc2626', '#f59e0b', '#059669', '#2563eb', '#7c3aed', '#111827', '#ffffff'];
COLORS.forEach((c, i) => {
  const d = document.createElement('div');
  d.className = 'sw' + (i === 0 ? ' on' : '');
  d.style.background = c;
  d.onclick = () => {
    color = c;
    document.querySelectorAll('.sw').forEach(x => x.classList.remove('on'));
    d.classList.add('on');
    if (tool === 'rect') { /* 已画的不改，只改后续 */ }
  };
  $('colors').appendChild(d);
});

/* 粗细 */
let widthChips = [];
function rebuildWidths() {
  const b = lineWBasis;
  const opts = [Math.max(1, Math.round(b * 0.5)), b, Math.round(b * 1.8), Math.round(b * 3)];
  const box = $('widths');
  box.innerHTML = '';
  widthChips = [];
  opts.forEach((w, i) => {
    const d = document.createElement('div');
    d.className = 'wd' + (i === 1 ? ' on' : '');
    d.innerHTML = `<i style="width:${Math.min(14, w + 3)}px;height:${Math.max(1, Math.min(9, w))}px"></i>`;
    d.title = w + 'px';
    d.onclick = () => {
      lineW = w;
      document.querySelectorAll('.wd').forEach(x => x.classList.remove('on'));
      d.classList.add('on');
    };
    box.appendChild(d);
    widthChips.push(d);
  });
  lineW = opts[1];
}
rebuildWidths();

$('fillToggle').onclick = () => {
  filled = !filled;
  $('fillToggle').style.background = filled ? 'var(--brand-weak)' : '';
  $('fillToggle').style.color = filled ? 'var(--brand)' : '';
};

/* ---------------- 文字属性面板 ---------------- */
const TPC = $('txPanel');

function openTextPanel(a) {
  selText = a;
  $('txText').value = a.text;
  $('txSize').value = Math.round(a.size);
  $('txSizeV').textContent = Math.round(a.size);
  paintTxColors(a.color);
  TPC.classList.add('on');
  // 定位：优先放在文字右侧，放不下就放左侧，再不行才放下方 —— 始终避开文字本体
  const r = cv.getBoundingClientRect();
  const kx = r.width / cv.width, ky = r.height / cv.height;
  const bx = r.left + a.x * kx;
  const by = r.top + a.y * ky;
  const bw = textBounds(a).w * kx;
  const bh = textBounds(a).h * ky;
  const pw = 238, ph = TPC.offsetHeight || 236, gap = 14;

  let left = bx + bw + gap;                       // 右侧
  if (left + pw > window.innerWidth - 8) left = bx - pw - gap;   // 右侧放不下 → 左侧
  left = Math.max(8, Math.min(window.innerWidth - pw - 8, left));

  let top = by + bh / 2 - ph / 2;                 // 与文字垂直居中
  if (left === Math.max(8, Math.min(window.innerWidth - pw - 8, bx + bw + gap)) &&
      top + ph > window.innerHeight - 8) {
    // 右侧且底部溢出 → 上方对齐
    top = by - ph - gap;
  }
  top = Math.max(8, Math.min(window.innerHeight - ph - 8, top));

  TPC.style.left = left + 'px';
  TPC.style.top = top + 'px';
  $('txText').focus();
  $('txText').select();
  render();
}

function closeTextPanelIfOpen() {
  if (TPC && TPC.classList.contains('on')) closeTextPanel();
}

function closeTextPanel() {
  TPC.classList.remove('on');
  selText = null;
  render();
}

function paintTxColors(cur) {
  const box = $('txColors');
  box.innerHTML = '';
  ['#e11d48','#dc2626','#f59e0b','#059669','#2563eb','#7c3aed','#111827','#ffffff'].forEach(c => {
    const i = document.createElement('i');
    i.style.background = c;
    if (c === cur) i.classList.add('on');
    i.onclick = () => {
      if (!selText) return;
      selText.color = c;
      paintTxColors(c);
      render();
    };
    box.appendChild(i);
  });
}

$('txText').addEventListener('input', () => {
  if (!selText) return;
  selText.text = $('txText').value || ' ';
  render();
});

$('txSize').addEventListener('input', () => {
  const v = +$('txSize').value;
  $('txSizeV').textContent = v;
  if (!selText) return;
  selText.size = v;
  render();
});

$('txDel').onclick = () => {
  if (!selText) return;
  annos = annos.filter(x => x !== selText);
  redoStack = [];
  closeTextPanel();
  syncUndo();
};

$('txClose').onclick = closeTextPanel;

// 点画布空白处 / 切工具时收起面板
document.addEventListener('pointerdown', e => {
  if (!TPC.classList.contains('on')) return;
  if (TPC.contains(e.target)) return;
  if (e.target === cv) return;      // 画布上的点击由主逻辑处理
  closeTextPanel();
}, true);

/* ---------------- 撤销 / 重做 / 原图 ---------------- */
function syncUndo() {
  $('undo').disabled = annos.length === 0;
  $('redo').disabled = redoStack.length === 0;
}
$('undo').onclick = () => {
  if (!annos.length) return;
  redoStack.push(annos.pop());
  render(); syncUndo();
};
$('redo').onclick = () => {
  if (!redoStack.length) return;
  annos.push(redoStack.pop());
  render(); syncUndo();
};
$('reset').onclick = () => {
  annos = []; redoStack = []; crop = null;
  setTool('select'); render(); syncUndo(); msg('已还原');
};

/* ---------------- 缩放 / 平移 ---------------- */
$('stage').addEventListener('wheel', e => {
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return;  // 普通滚轮留给滚动
  e.preventDefault();
  zoom = Math.max(0.05, Math.min(4, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  applyZoom();
}, { passive: false });

/* ---------------- 导出 ---------------- */
$('expBtn').onclick = e => {
  e.stopPropagation();
  $('menu').classList.toggle('on');
};
document.addEventListener('click', () => $('menu').classList.remove('on'));

$('menu').onclick = async e => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === 'download') await exportImage(false);
    if (act === 'downloadAs') await exportImage(true);
    if (act === 'copy') await copyImage();
    if (act === 'close') { await ascDel(KEY); window.close(); }
  } catch (err) { msg('失败：' + (err.message || err)); }
};

// 把底图 + 标注 + 裁剪合成到一张画布
function compose() {
  const r = crop || { x: 0, y: 0, w: baseCanvas.width, h: baseCanvas.height };
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(r.w));
  out.height = Math.max(1, Math.round(r.h));
  const oc = out.getContext('2d', { alpha: false });
  oc.fillStyle = '#ffffff';
  oc.fillRect(0, 0, out.width, out.height);

  // 底图：按裁剪矩形取源
  oc.drawImage(baseCanvas, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);

  // 标注：平移到裁剪坐标系后逐条叠加
  oc.save();
  oc.translate(-r.x, -r.y);
  for (const a of annos) drawAnno(a, false, oc);
  oc.restore();
  return out;
}

async function exportImage(saveAs) {
  const out = compose();
  const mime = FMT === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise(res => out.toBlob(res, mime, FMT === 'jpeg' ? 0.92 : undefined));
  if (!blob) throw new Error('生成失败');
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `区域截图-${stamp}.${FMT === 'jpeg' ? 'jpg' : 'png'}`;
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({ url, filename: name, saveAs: saveAs || SAVE_AS, conflictAction: 'uniquify' });
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  await ascDel(KEY);
  msg('已保存 ' + name);
  setTimeout(() => window.close(), 900);
}

async function copyImage() {
  const out = compose();
  const blob = await new Promise(res => out.toBlob(res, 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  msg('已复制到剪贴板');
}

/* ---------------- 快捷键 ---------------- */
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? $('redo').click() : $('undo').click(); return; }
  if (mod && e.key === 's') { e.preventDefault(); exportImage(false); return; }
  if (mod && e.key === 'c') { e.preventDefault(); copyImage(); return; }
  if (e.key === 'Escape') { $('menu').classList.remove('on'); return; }
  if (mod) return;
  const map = { v: 'select', c: 'crop', r: 'rect', a: 'arrow', t: 'text', m: 'mosaic', b: 'blur' };
  if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});

window.addEventListener('resize', () => { if (baseCanvas) { syncCropUI(); } });

/* 启动 */
setTool('select');
syncUndo();
