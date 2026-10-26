/* Pixiv 打码助手 - 全屏打码编辑器
 * 依赖 window.PXM.css（styles.js 注入）。
 */
(() => {
  'use strict';
  const NS = (window.PXM = window.PXM || {});
  if (NS.Editor) return;

  const MAX_OUTPUT = 4096;
  const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const int = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
  };

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片解码失败'));
      };
      img.src = url;
    });
  }

  class Editor {
    constructor(shadow, opts) {
      this.shadow = shadow;
      this.opts = opts || {};
      this.settings = this.opts.settings || { brush: 44, block: 14 };
      this.dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
      this.open_ = false;
      this.busy = false;
      this.loading = false;
      this.exporting = false;
      this.token = 0;
      this.bitmap = null;
      this.info = null;
      this.iw = 0;
      this.ih = 0;
      this.scale = 1;
      this.cw = 1;
      this.ch = 1;
      this.strokes = [];
      this.redoStack = [];
      this.cur = null;
      this.painting = false;
      this.pointerId = null;
      this.cursorPos = null;
      this.raf = 0;
      this.tmp = {};
      this.warnedEmpty = false;
      this.toastTimer = 0;
      this.resizeTimer = 0;
      this.onKeyBound = (e) => this.onKey(e);
      this.build();
      window.addEventListener('keydown', this.onKeyBound, true);
      window.addEventListener('resize', () => {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          if (this.open_) this.relayout();
        }, 140);
      });
    }

    /* ---------------- DOM ---------------- */
    build() {
      const el = document.createElement('div');
      el.className = 'pxm-editor';
      el.setAttribute('aria-hidden', 'true');
      el.innerHTML = [
        '<header class="pxm-top">',
        '  <div class="pxm-brand">',
        '    <div class="pxm-brand-mark">▦</div>',
        '    <div class="pxm-brand-text"><b>打码编辑</b><small class="pxm-file"></small></div>',
        '  </div>',
        '  <div class="pxm-tools">',
        '    <label class="pxm-range" title="笔刷直径（屏幕像素），也可用鼠标滚轮调整">',
        '      <span>笔刷</span>',
        '      <input class="pxm-brush" type="range" min="4" max="200" step="1">',
        '      <output class="pxm-brush-out"></output>',
        '    </label>',
        '    <label class="pxm-range" title="一个马赛克方块的边长（原图像素）">',
        '      <span>马赛克</span>',
        '      <input class="pxm-block" type="range" min="2" max="100" step="1">',
        '      <output class="pxm-block-out"></output>',
        '    </label>',
        '    <span class="pxm-sep"></span>',
        '    <button type="button" class="pxm-btn pxm-undo" title="撤销 (Ctrl+Z)">↶ 撤销</button>',
        '    <button type="button" class="pxm-btn pxm-redo" title="重做 (Ctrl+Shift+Z)">↷ 重做</button>',
        '    <button type="button" class="pxm-btn pxm-reset" title="清除所有涂抹">重置</button>',
        '    <span class="pxm-size"></span>',
        '  </div>',
        '  <button type="button" class="pxm-icon-btn pxm-close" title="关闭 (Esc)">✕</button>',
        '</header>',
        '<div class="pxm-stage">',
        '  <div class="pxm-wrap">',
        '    <canvas class="pxm-base"></canvas>',
        '    <canvas class="pxm-preview"></canvas>',
        '    <canvas class="pxm-cursor"></canvas>',
        '  </div>',
        '</div>',
        '<footer class="pxm-bottom">',
        '  <div class="pxm-tip">按住左键涂抹需要打码的位置 · 滚轮调整笔刷 · Ctrl+Z 撤销 · 完成后点右侧按钮填入投稿</div>',
        '  <div class="pxm-actions">',
        '    <button type="button" class="pxm-btn pxm-cancel">取消</button>',
        '    <button type="button" class="pxm-btn pxm-apply">完成，填入投稿</button>',
        '  </div>',
        '</footer>',
        '<div class="pxm-toast" hidden></div>',
      ].join('\n');

      this.root = el;
      this.shadow.appendChild(el);

      const q = (s) => el.querySelector(s);
      this.wrap = q('.pxm-wrap');
      this.baseCanvas = q('.pxm-base');
      this.previewCanvas = q('.pxm-preview');
      this.cursorCanvas = q('.pxm-cursor');
      this.stage = q('.pxm-stage');
      this.fileEl = q('.pxm-file');
      this.sizeEl = q('.pxm-size');
      this.brushInput = q('.pxm-brush');
      this.brushOut = q('.pxm-brush-out');
      this.blockInput = q('.pxm-block');
      this.blockOut = q('.pxm-block-out');
      this.undoBtn = q('.pxm-undo');
      this.redoBtn = q('.pxm-redo');
      this.resetBtn = q('.pxm-reset');
      this.applyBtn = q('.pxm-apply');
      this.cancelBtn = q('.pxm-cancel');
      this.toastEl = q('.pxm-toast');

      // 独立的 committed 画布：已确认笔画合成结果，预览层 = committed + 当前笔画
      this.committedCanvas = document.createElement('canvas');

      this.baseCtx = this.baseCanvas.getContext('2d');
      this.pctx = this.previewCanvas.getContext('2d');
      this.cctx = this.cursorCanvas.getContext('2d');
      this.committedCtx = this.committedCanvas.getContext('2d');

      this.syncFromSettings();
      this.bindEvents();
    }

    bindEvents() {
      this.brushInput.addEventListener('input', () => {
        const v = int(this.brushInput.value, 4, 200, 44);
        this.setSetting('brush', v);
        this.drawCursor();
      });
      this.blockInput.addEventListener('input', () => {
        const v = int(this.blockInput.value, 2, 100, 14);
        this.setSetting('block', v);
      });

      this.undoBtn.addEventListener('click', () => this.undo());
      this.redoBtn.addEventListener('click', () => this.redo());
      this.resetBtn.addEventListener('click', () => this.resetStrokes());
      this.applyBtn.addEventListener('click', () => {
        this.apply().catch(() => {});
      });
      this.cancelBtn.addEventListener('click', () => this.cancel());
      this.root.querySelector('.pxm-close').addEventListener('click', () => this.cancel());

      this.previewCanvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      this.previewCanvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      this.previewCanvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      this.previewCanvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
      this.previewCanvas.addEventListener('pointerleave', (e) => {
        if (!this.painting) {
          this.cursorPos = null;
          this.drawCursor();
        }
      });
      this.previewCanvas.addEventListener('lostpointercapture', () => {
        // 捕获丢失时确保笔画落笔，避免卡在绘制状态
        if (this.painting) this.onPointerUp({ pointerId: this.pointerId });
      });

      this.wrap.addEventListener('wheel', (e) => {
        if (!this.open_ || this.busy) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.deltaY > 0 ? -4 : 4;
        const v = clamp(int(this.settings.brush, 4, 200, 44) + step, 4, 200);
        this.setSetting('brush', v);
        this.drawCursor();
      }, { passive: false });
    }

    /* ---------------- 设置同步 ---------------- */
    syncFromSettings() {
      const brush = int(this.settings.brush, 4, 200, 44);
      const block = int(this.settings.block, 2, 100, 14);
      if (this.brushInput.value !== String(brush)) this.brushInput.value = String(brush);
      if (this.blockInput.value !== String(block)) this.blockInput.value = String(block);
      this.brushOut.textContent = String(brush);
      this.blockOut.textContent = String(block);
    }

    setSetting(key, value) {
      this.settings[key] = value;
      this.syncFromSettings();
      if (typeof this.opts.onSetting === 'function') this.opts.onSetting(key, value);
    }

    /* ---------------- 打开 / 关闭 ---------------- */
    isOpen() {
      return this.open_;
    }

    async open(file, meta) {
      if (this.open_) this.dismissQuiet();
      const token = ++this.token;
      this.root.classList.add('pxm-open');
      this.root.setAttribute('aria-hidden', 'false');
      this.open_ = true;
      this.info = {
        name: (meta && meta.name) || file.name || 'image',
        type: (meta && meta.type) || file.type || '',
        index: meta && Number.isFinite(meta.index) ? meta.index : 0,
        total: meta && Number.isFinite(meta.total) ? meta.total : 1,
      };
      this.strokes = [];
      this.redoStack = [];
      this.cur = null;
      this.warnedEmpty = false;
      this.cursorPos = null;
      this.painting = false;
      this.fileEl.textContent = this.info.total > 1
        ? this.info.name + ' · 第 ' + (this.info.index + 1) + '/' + this.info.total + ' 张'
        : this.info.name;
      this.hideToast();
      this.syncFromSettings();
      this.loading = true;
      this.setBusy(true, '正在读取图片…');
      this.updateHistory();

      let source = null;
      try {
        source = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) {
        source = null;
      }
      if (!source) {
        try {
          source = await loadImageElement(file);
        } catch (err) {
          source = null;
        }
      }

      // 解码期间用户可能已经取消，或队列已切到下一张
      if (token !== this.token || !this.open_) {
        if (source && typeof source.close === 'function') {
          try { source.close(); } catch (err) { /* ignore */ }
        }
        return false;
      }

      this.loading = false;
      if (!source) {
        this.setBusy(false);
        this.dismissQuiet();
        return false;
      }

      this.bitmap = source;
      this.iw = Math.max(1, Math.round(source.width || source.naturalWidth || 1));
      this.ih = Math.max(1, Math.round(source.height || source.naturalHeight || 1));
      this.setBusy(false);
      this.relayout();
      this.updateHistory();
      return true;
    }

    setBusy(busy, label) {
      this.busy = !!busy;
      this.applyBtn.disabled = this.busy;
      this.undoBtn.disabled = this.busy;
      this.redoBtn.disabled = this.busy;
      this.resetBtn.disabled = this.busy;
      this.applyBtn.textContent = this.busy ? (label || '处理中…') : '完成，填入投稿';
      if (!this.busy) this.updateHistory();
    }

    dismissQuiet() {
      this.open_ = false;
      this.root.classList.remove('pxm-open');
      this.root.setAttribute('aria-hidden', 'true');
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
      if (this.bitmap && typeof this.bitmap.close === 'function') {
        try { this.bitmap.close(); } catch (err) { /* ignore */ }
      }
      this.bitmap = null;
      this.strokes = [];
      this.redoStack = [];
      this.cur = null;
      this.painting = false;
      this.cursorPos = null;
      this.info = null;
      this.iw = 0;
      this.ih = 0;
      const shrink = (c) => { if (c) { c.width = 1; c.height = 1; } };
      shrink(this.baseCanvas);
      shrink(this.previewCanvas);
      shrink(this.cursorCanvas);
      shrink(this.committedCanvas);
      Object.keys(this.tmp).forEach((k) => shrink(this.tmp[k]));
      this.clearCursor();
    }

    /** 只关闭界面（用于「完成」后进入下一步） */
    close() {
      this.setBusy(false);
      this.hideToast();
      this.dismissQuiet();
    }

    /** 关闭界面并通知外部取消 */
    cancel() {
      if (this.exporting) return;
      this.close();
      if (typeof this.opts.onCancel === 'function') this.opts.onCancel();
    }

    /* ---------------- 布局 ---------------- */
    relayout() {
      if (!this.open_ || !this.bitmap) return;
      const availW = Math.max(120, this.stage.clientWidth - 36);
      const availH = Math.max(120, this.stage.clientHeight - 36);
      let s = Math.min(availW / this.iw, availH / this.ih);
      s = clamp(s, 0.02, 4);
      const cw = Math.max(1, Math.round(this.iw * s));
      const ch = Math.max(1, Math.round(this.ih * s));
      this.cw = cw;
      this.ch = ch;
      this.scale = cw / this.iw;

      this.wrap.style.width = cw + 'px';
      this.wrap.style.height = ch + 'px';

      const dpr = this.dpr;
      const size = (c) => {
        c.width = Math.max(1, Math.round(cw * dpr));
        c.height = Math.max(1, Math.round(ch * dpr));
      };
      size(this.baseCanvas);
      size(this.previewCanvas);
      size(this.cursorCanvas);
      size(this.committedCanvas);

      this.baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.baseCtx.imageSmoothingEnabled = true;
      this.baseCtx.imageSmoothingQuality = 'high';
      this.baseCtx.clearRect(0, 0, cw, ch);
      this.baseCtx.drawImage(this.bitmap, 0, 0, cw, ch);

      this.pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const outScale = Math.min(1, MAX_OUTPUT / Math.max(this.iw, this.ih));
      this.sizeEl.textContent = this.iw + ' × ' + this.ih +
        (outScale < 1 ? ' → ' + Math.round(this.iw * outScale) + ' × ' + Math.round(this.ih * outScale) : '');

      this.repaintCommitted();
      this.clearCursor();
    }

    clearCursor() {
      if (!this.cctx) return;
      this.cctx.save();
      this.cctx.setTransform(1, 0, 0, 1, 0, 0);
      this.cctx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
      this.cctx.restore();
    }

    /* ---------------- 光标 ---------------- */
    drawCursor() {
      if (!this.open_) return;
      const ctx = this.cctx;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cw, this.ch);
      if (this.cursorPos && !this.busy) {
        const r = Math.max(2.5, this.settings.brush / 2);
        const x = this.cursorPos.x;
        const y = this.cursorPos.y;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,.55)';
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.fill();
      }
      ctx.restore();
    }

    /* ---------------- 坐标 ---------------- */
    toCss(e) {
      const rect = this.previewCanvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    toImage(css) {
      return { x: css.x / this.scale, y: css.y / this.scale };
    }

    /* ---------------- 绘制 ---------------- */
    pointerDown(e) {
      if (!this.open_ || this.busy || !this.bitmap) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      const css = this.toCss(e);
      this.cursorPos = css;
      this.painting = true;
      this.pointerId = e.pointerId;
      try { this.previewCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const p = this.toImage(css);
      this.cur = {
        points: [p],
        rImg: Math.max(0.5, (this.settings.brush / 2) / this.scale),
        block: this.settings.block,
      };
      this.warnedEmpty = false;
      this.drawCursor();
      this.schedule();
    }

    onPointerDown(e) {
      this.pointerDown(e);
    }

    onPointerMove(e) {
      if (!this.open_) return;
      const css = this.toCss(e);
      this.cursorPos = css;
      this.drawCursor();
      if (!this.painting || !this.cur) return;
      e.preventDefault();
      const p = this.toImage(css);
      const pts = this.cur.points;
      const last = pts[pts.length - 1];
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = Math.max(0.5, this.cur.rImg * 0.22);
      if (dist < step) return;
      const n = Math.min(400, Math.ceil(dist / step));
      for (let i = 1; i <= n; i++) {
        pts.push({ x: last.x + (dx * i) / n, y: last.y + (dy * i) / n });
      }
      this.schedule();
    }

    onPointerUp(e) {
      if (!this.painting) return;
      this.painting = false;
      if (this.pointerId != null) {
        try { this.previewCanvas.releasePointerCapture(this.pointerId); } catch (err) { /* ignore */ }
        this.pointerId = null;
      }
      if (!this.cur) return;
      const stroke = this.cur;
      this.cur = null;
      this.strokes.push(stroke);
      this.redoStack.length = 0;
      this.cur = null;
      const ctx = this.committedCtx;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.paintStroke(ctx, stroke, this.scale, this.baseCanvas, this.scale * this.dpr, 2);
      ctx.restore();
      this.renderPreview();
      this.updateHistory();
    }

    schedule() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.renderPreview();
      });
    }

    /** 把一个笔画（马赛克）画到 ctx 上。
     * stroke.points 与 stroke.rImg 使用「图像坐标」；
     * scale = 输出坐标 / 图像坐标；
     * src = 原图来源画布，srcScale = src 的像素 / 图像坐标。
     */
    paintStroke(ctx, stroke, scale, src, srcScale, minBd) {
      if (!stroke || !stroke.points || !stroke.points.length || !src) return;
      if (!(scale > 0) || !(srcScale > 0)) return;
      const pts = stroke.points;
      const r = Math.max(0.5, (stroke.rImg || 1) * scale);
      const bd = Math.max(minBd || 1, Math.round((stroke.block || 14) * scale));
      // 目标坐标（输出像素）下的整幅尺寸
      const outW = Math.max(1, Math.round((src.width / srcScale) * scale));
      const outH = Math.max(1, Math.round((src.height / srcScale) * scale));

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const x = pts[i].x * scale;
        const y = pts[i].y * scale;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      const x0 = Math.max(0, Math.min(outW, Math.floor((minX - r) / bd) * bd));
      const y0 = Math.max(0, Math.min(outH, Math.floor((minY - r) / bd) * bd));
      const x1 = Math.max(0, Math.min(outW, Math.ceil((maxX + r) / bd) * bd));
      const y1 = Math.max(0, Math.min(outH, Math.ceil((maxY + r) / bd) * bd));
      if (!(x1 > x0) || !(y1 > y0)) return;

      const bw = Math.max(1, Math.round(x1 - x0));
      const bh = Math.max(1, Math.round(y1 - y0));
      const sw = Math.max(1, Math.round(bw / bd));
      const sh = Math.max(1, Math.round(bh / bd));

      // 1) 笔刷形状遮罩（与目标画布 1:1，输出坐标）
      const mctx = this.tmpCanvas('mask', bw, bh);
      mctx.fillStyle = '#000';
      mctx.strokeStyle = '#000';
      mctx.lineJoin = 'round';
      mctx.lineCap = 'round';
      mctx.save();
      mctx.translate(-x0, -y0);
      mctx.beginPath();
      if (pts.length === 1) {
        mctx.arc(pts[0].x * scale, pts[0].y * scale, r, 0, Math.PI * 2);
      } else {
        mctx.moveTo(pts[0].x * scale, pts[0].y * scale);
        for (let i = 1; i < pts.length; i++) mctx.lineTo(pts[i].x * scale, pts[i].y * scale);
      }
      mctx.lineWidth = r * 2;
      mctx.stroke();
      mctx.restore();

      // 2) 降采样 → 放大，得到像素块（马赛克）；k = src 像素 / 输出像素
      const k = srcScale / scale;
      const small = this.tmpCtx('small', sw, sh);
      small.imageSmoothingEnabled = true;
      small.imageSmoothingQuality = 'high';
      small.drawImage(src, x0 * k, y0 * k, bw * k, bh * k, 0, 0, sw, sh);

      const local = this.tmpCtx('local', bw, bh);
      local.imageSmoothingEnabled = false;
      local.drawImage(this.tmp.small, 0, 0, sw, sh, 0, 0, bw, bh);

      // 3) 只保留笔刷覆盖的区域
      local.globalCompositeOperation = 'destination-in';
      local.drawImage(this.tmp.mask, 0, 0);
      local.globalCompositeOperation = 'source-over';

      // 4) 盖到目标画布
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.tmp.local, 0, 0, bw, bh, x0, y0, bw, bh);
      ctx.restore();
    }

    /** 取得（按需扩容的）临时画布，返回 2d context，画布已清空、状态已重置 */
    tmpCtx(name, w, h) {
      w = Math.max(1, Math.round(w));
      h = Math.max(1, Math.round(h));
      let c = this.tmp[name];
      if (!c) {
        c = document.createElement('canvas');
        this.tmp[name] = c;
      }
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, w, h);
      return ctx;
    }

    /** 同上，但返回遮罩画布本身（用于 destination-in） */
    tmpCanvas(name, w, h) {
      this.tmpCtx(name, w, h);
      return this.tmp[name].getContext('2d');
    }

    repaintCommitted() {
      const ctx = this.committedCtx;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.committedCanvas.width, this.committedCanvas.height);
      ctx.restore();
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      for (let i = 0; i < this.strokes.length; i++) {
        this.paintStroke(ctx, this.strokes[i], this.scale, this.baseCanvas, this.scale * this.dpr, 2);
      }
      ctx.restore();
      this.renderPreview();
      this.updateHistory();
    }

    renderPreview() {
      if (!this.open_) return;
      const ctx = this.pctx;
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cw, this.ch);
      ctx.imageSmoothingEnabled = false;
      if (this.committedCanvas.width > 1) {
        ctx.drawImage(this.committedCanvas, 0, 0, this.cw, this.ch);
      }
      if (this.cur) {
        this.paintStroke(ctx, this.cur, this.scale, this.baseCanvas, this.scale * this.dpr, 2);
      }
      ctx.restore();
    }

    /* ---------------- 历史 ---------------- */
    updateHistory() {
      const canUndo = this.strokes.length > 0;
      const canRedo = this.redoStack.length > 0;
      this.undoBtn.disabled = this.busy || !canUndo;
      this.redoBtn.disabled = this.busy || !canRedo;
      this.resetBtn.disabled = this.busy || (!canUndo && !canRedo);
      this.applyBtn.disabled = this.busy;
    }

    undo() {
      if (this.busy || !this.open_ || !this.strokes.length) return;
      this.redoStack.push(this.strokes.pop());
      this.repaintCommitted();
    }

    redo() {
      if (this.busy || !this.open_ || !this.redoStack.length) return;
      this.strokes.push(this.redoStack.pop());
      this.repaintCommitted();
    }

    resetStrokes() {
      if (this.busy || !this.open_) return;
      this.strokes = [];
      this.redoStack = [];
      this.repaintCommitted();
      this.warnedEmpty = false;
    }

    onKey(e) {
      if (!this.open_) return;
      if (e.key === 'Escape') {
        if (this.exporting) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        this.cancel();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) {
        if (e.key === '[' || e.key === ']') {
          if (e.target && e.target.tagName === 'INPUT') return;
          e.preventDefault();
          e.stopPropagation();
          const step = e.key === ']' ? 4 : -4;
          this.setSetting('brush', clamp(int(this.settings.brush, 4, 200, 44) + step, 4, 200));
          this.drawCursor();
        }
        return;
      }
      const k = (e.key || '').toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (k === 'y') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        this.redo();
      }
    }

    /* ---------------- 导出 ---------------- */
    async apply() {
      if (!this.open_ || this.busy || !this.bitmap) return;
      if (!this.strokes.length && !this.warnedEmpty) {
        this.warnedEmpty = true;
        this.showToast('还没有涂抹任何区域，再点一次将直接使用原图');
        return;
      }
      this.setBusy(true, '正在生成…');
      this.exporting = true;
      try {
        const file = await this.exportFile();
        this.exporting = false;
        this.setBusy(false);
        if (typeof this.opts.onDone === 'function') this.opts.onDone(file, this.info);
      } catch (err) {
        this.exporting = false;
        this.setBusy(false);
        this.showToast('生成图片失败：' + ((err && err.message) || err));
      }
    }

    async exportFile() {
      const outScale = Math.min(1, MAX_OUTPUT / Math.max(this.iw, this.ih));
      const outW = Math.max(1, Math.round(this.iw * outScale));
      const outH = Math.max(1, Math.round(this.ih * outScale));
      const mime = this.pickMime();
      const quality = 0.92;

      // 原图按输出尺寸重绘（JPEG 需要白底，避免透明变黑）
      const src = document.createElement('canvas');
      src.width = outW;
      src.height = outH;
      const sctx = src.getContext('2d');
      if (mime === 'image/jpeg') {
        sctx.fillStyle = '#ffffff';
        sctx.fillRect(0, 0, outW, outH);
      }
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(this.bitmap, 0, 0, outW, outH);

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const octx = out.getContext('2d');
      octx.drawImage(src, 0, 0);

      for (let i = 0; i < this.strokes.length; i++) {
        octx.save();
        octx.setTransform(1, 0, 0, 1, 0, 0);
        this.paintStroke(octx, this.strokes[i], outScale, src, outScale, 1);
        octx.restore();
      }

      const blob = await new Promise((resolve) => {
        try {
          out.toBlob((b) => resolve(b), mime, quality);
        } catch (err) {
          resolve(null);
        }
      });
      if (!blob) throw new Error('浏览器无法编码该图片');

      const ext = mime === 'image/jpeg' ? 'jpg' : (MIME_EXT[mime] || 'png');
      const base = this.stripExt(this.info && this.info.name);
      return new File([blob], base + '-mosaic.' + ext, { type: mime, lastModified: Date.now() });
    }

    pickMime() {
      const t = ((this.info && this.info.type) || '').toLowerCase();
      if (t === 'image/jpeg' || t === 'image/png' || t === 'image/webp') return t;
      return 'image/png';
    }

    stripExt(name) {
      const n = String(name || 'image').replace(/\.[a-z0-9]{1,8}$/i, '');
      return n || 'image';
    }

    /* ---------------- 提示 ---------------- */
    showToast(text, ms) {
      if (!this.toastEl) return;
      clearTimeout(this.toastTimer);
      this.toastEl.textContent = text;
      this.toastEl.hidden = false;
      this.toastTimer = setTimeout(() => this.hideToast(), ms || 3600);
    }

    hideToast() {
      clearTimeout(this.toastTimer);
      if (this.toastEl) {
        this.toastEl.hidden = true;
        this.toastEl.textContent = '';
      }
    }
  }

  NS.Editor = Editor;
})();
