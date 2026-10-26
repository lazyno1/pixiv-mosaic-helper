/* Pixiv 打码助手 - 内容脚本
 * 1) 注入悬浮面板 + 全屏编辑器（shadow DOM）
 * 2) 拦截 pixiv 投稿页的图片选择 / 拖拽，先进入打码编辑器
 * 3) 完成后把处理好的文件写回投稿框，由用户点 pixiv 的「投稿」上传
 */
(() => {
  'use strict';
  const NS = (window.PXM = window.PXM || {});
  if (NS.appBooted) return;
  NS.appBooted = true;
  if (window.top !== window) return;
  if (!document.documentElement) return;

  const DEFAULTS = { brush: 44, block: 14, autoIntercept: true };
  const MAX_FILES = 40;
  const PATH_RE = /\/artworks?\/(?:new|create|upload)|\/artworks?\/\d+\/edit|\/illust\/(?:new|create)|\/manga\/(?:new|create)|\/upload(?:\.php)?(?=[/?#]|$)/i;

  const state = {
    settings: Object.assign({}, DEFAULTS),
    host: null,
    shadow: null,
    root: null,
    panel: null,
    fab: null,
    editor: null,
    panelOpen: false,
    minimized: false,
    forceVisible: false,
    uploadPage: false,
    detected: false,
    autoOpenedFor: '',
    editorOpen: false,
    session: null,
    replaying: false,
    lastHref: location.href,
    saveTimer: 0,
    statusTimer: 0,
    pollTimer: 0,
  };

  /* ================= 小工具 ================= */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const int = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
  };

  function isImageFile(f) {
    if (!f) return false;
    const type = String(f.type || '').toLowerCase();
    if (type.indexOf('image/') === 0) return true;
    return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(f.name || ''));
  }

  function isImageInput(el) {
    if (!el || el.tagName !== 'INPUT' || el.type !== 'file') return false;
    if (el.disabled) return false;
    if (el.closest && el.closest('#pixiv-mosaic-host')) return false;
    const accept = String(el.accept || '').toLowerCase();
    if (!accept) return true;
    if (accept.indexOf('image') >= 0) return true;
    return /\.(png|jpe?g|webp|gif|bmp|avif)/.test(accept);
  }

  function findImageInput() {
    const list = document.querySelectorAll('input[type="file"]');
    let best = null;
    let bestScore = -1;
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!el.isConnected || !isImageInput(el)) continue;
      let score = 0;
      if (el.multiple) score += 2;
      if (/image/i.test(String(el.accept || ''))) score += 1;
      if (el.offsetParent !== null) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function detectContext() {
    const pathHit = PATH_RE.test(location.pathname);
    state.uploadPage = pathHit;
    state.detected = pathHit || !!findImageInput();
    return state.detected;
  }

  /* ================= 设置 ================= */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get('pxmSettings');
      const s = stored && stored.pxmSettings;
      if (s && typeof s === 'object') {
        state.settings.brush = int(s.brush, 4, 200, DEFAULTS.brush);
        state.settings.block = int(s.block, 2, 100, DEFAULTS.block);
        state.settings.autoIntercept = s.autoIntercept !== false;
      }
    } catch (err) {
      // 读取失败时使用默认值
    }
  }

  function saveSettings() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ pxmSettings: state.settings });
      } catch (err) {
        // 忽略
      }
    }, 200);
  }

  /* ================= 界面 ================= */
  function ensureUI() {
    if (state.host && state.host.isConnected) return;
    if (!state.host) {
      const host = document.createElement('div');
      host.id = 'pixiv-mosaic-host';
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = NS.css || '';
      shadow.appendChild(style);
      const root = document.createElement('div');
      root.className = 'pxm-root';
      shadow.appendChild(root);

      state.host = host;
      state.shadow = shadow;
      state.root = root;

      buildPanel(root);
      state.editor = new NS.Editor(root, {
        settings: state.settings,
        onSetting: (key, value) => {
          state.settings[key] = value;
          syncPanelSettings();
          saveSettings();
        },
        onDone: (file, info) => {
          handleEditorDone(file, info).catch(() => {});
        },
        onCancel: () => handleEditorCancel(),
      });
      document.documentElement.appendChild(host);
    } else {
      document.documentElement.appendChild(state.host);
    }
    syncPanelSettings();
    renderVisibility();
  }

  function buildPanel(root) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = [
      '<button type="button" class="pxm-fab" title="打开 Pixiv 打码助手">▦</button>',
      '<div class="pxm-panel" role="dialog" aria-label="Pixiv 打码助手">',
      '  <div class="pxm-head">',
      '    <div class="pxm-logo">▦</div>',
      '    <div class="pxm-title"><b>Pixiv 打码助手</b><small>投稿前先涂抹打码</small></div>',
      '    <button type="button" class="pxm-min" title="收起面板">–</button>',
      '  </div>',
      '  <div class="pxm-body">',
      '    <div class="pxm-drop" role="button" tabindex="0">',
      '      <div class="pxm-drop-icon">＋</div>',
      '      <div class="pxm-drop-title">拖入图片开始打码</div>',
      '      <div class="pxm-drop-sub">或点击选择本地图片（可多选）</div>',
      '      <input class="pxm-file-input" type="file" accept="image/*" multiple hidden>',
      '    </div>',
      '    <div class="pxm-field">',
      '      <div class="pxm-field-head"><b>笔刷大小</b><output class="pxm-brush-out"></output></div>',
      '      <input class="pxm-brush" type="range" min="4" max="200" step="1">',
      '      <div class="pxm-field-scale"><span>细</span><span>粗</span></div>',
      '    </div>',
      '    <div class="pxm-field">',
      '      <div class="pxm-field-head"><b>马赛克像素</b><output class="pxm-block-out"></output></div>',
      '      <input class="pxm-block" type="range" min="2" max="100" step="1">',
      '      <div class="pxm-field-scale"><span>细密</span><span>粗糙</span></div>',
      '    </div>',
      '    <label class="pxm-check"><input class="pxm-auto" type="checkbox"><span>在 pixiv 选择图片时，先打开打码编辑器</span></label>',
      '    <div class="pxm-hint">打码完全在本机浏览器里完成。编辑好点「完成，填入投稿」，再点 pixiv 的投稿按钮即可。</div>',
      '    <div class="pxm-status" hidden></div>',
      '  </div>',
      '</div>',
    ].join('\n');

    const fab = wrapper.querySelector('.pxm-fab');
    const panel = wrapper.querySelector('.pxm-panel');
    const drop = wrapper.querySelector('.pxm-drop');
    const fileInput = wrapper.querySelector('.pxm-file-input');
    const brush = wrapper.querySelector('.pxm-brush');
    const brushOut = wrapper.querySelector('.pxm-brush-out');
    const block = wrapper.querySelector('.pxm-block');
    const blockOut = wrapper.querySelector('.pxm-block-out');
    const auto = wrapper.querySelector('.pxm-auto');
    const status = wrapper.querySelector('.pxm-status');

    root.appendChild(fab);
    root.appendChild(panel);

    state.fab = fab;
    state.panel = panel;
    state.panelEls = { drop, fileInput, brush, brushOut, block, blockOut, auto, status };

    fab.addEventListener('click', () => {
      setPanelOpen(true);
    });
    panel.querySelector('.pxm-min').addEventListener('click', () => {
      setPanelOpen(false);
      state.minimized = true;
    });

    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', () => {
      const files = Array.prototype.slice.call(fileInput.files || []);
      try { fileInput.value = ''; } catch (err) { /* ignore */ }
      if (files.length) startEdit(files, { kind: 'panel' });
    });

    // 面板拖拽
    const head = panel.querySelector('.pxm-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, w: rect.width, h: rect.height };
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      try { head.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const left = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - drag.w - 4));
      const top = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - 60));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });
    const endDrag = () => { drag = null; };
    head.addEventListener('pointerup', endDrag);
    head.addEventListener('pointercancel', endDrag);

    // 面板内拖拽图片
    ['dragenter', 'dragover'].forEach((type) => {
      panel.addEventListener(type, (e) => {
        if (!e.dataTransfer || !hasFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        drop.classList.add('pxm-over');
      }, true);
    });
    panel.addEventListener('dragleave', (e) => {
      if (e.target === panel || !panel.contains(e.relatedTarget)) drop.classList.remove('pxm-over');
    }, true);
    panel.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('pxm-over');
      const files = Array.prototype.slice.call(e.dataTransfer.files).filter(isImageFile);
      if (files.length) startEdit(files, { kind: 'panel' });
      else setStatus('请拖入图片文件（png / jpg / webp / gif）', 'warn');
    }, true);

    brush.addEventListener('input', () => {
      const v = int(brush.value, 4, 200, DEFAULTS.brush);
      state.settings.brush = v;
      brushOut.textContent = String(v);
      if (state.editor) state.editor.syncFromSettings();
      saveSettings();
    });
    block.addEventListener('input', () => {
      const v = int(block.value, 2, 100, DEFAULTS.block);
      state.settings.block = v;
      blockOut.textContent = String(v);
      if (state.editor) state.editor.syncFromSettings();
      saveSettings();
    });
    auto.addEventListener('change', () => {
      state.settings.autoIntercept = !!auto.checked;
      saveSettings();
      setStatus(
        state.settings.autoIntercept
          ? '已开启：在 pixiv 选择图片时会先打开打码编辑器'
          : '已关闭自动拦截：请从上方拖拽框手动开始打码',
        'ok'
      );
    });
  }

  function hasFileDrag(dt) {
    const types = dt.types ? Array.prototype.slice.call(dt.types) : [];
    return types.some((t) => String(t).toLowerCase() === 'files');
  }

  function syncPanelSettings() {
    const els = state.panelEls;
    if (!els) return;
    const brush = int(state.settings.brush, 4, 200, DEFAULTS.brush);
    const block = int(state.settings.block, 2, 100, DEFAULTS.block);
    if (els.brush.value !== String(brush)) els.brush.value = String(brush);
    if (els.block.value !== String(block)) els.block.value = String(block);
    els.brushOut.textContent = String(brush);
    els.blockOut.textContent = String(block);
    els.auto.checked = state.settings.autoIntercept !== false;
  }

  function setPanelOpen(open) {
    ensureUI();
    state.panelOpen = !!open;
    state.panel.classList.toggle('pxm-open', state.panelOpen);
    if (state.panelOpen) {
      state.minimized = false;
      syncPanelSettings();
    }
    renderVisibility();
    if (state.panelOpen) setStatus('');
  }

  function renderVisibility() {
    if (!state.fab) return;
    const visible = state.uploadPage || state.detected || state.forceVisible;
    if (!visible && state.panelOpen) {
      state.panelOpen = false;
      state.panel.classList.remove('pxm-open');
    }
    state.fab.hidden = !visible || state.panelOpen;
  }

  function setStatus(text, kind) {
    const el = state.panelEls && state.panelEls.status;
    if (!el) return;
    clearTimeout(state.statusTimer);
    if (!text) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.dataset.kind = kind || 'info';
    state.statusTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
    }, 7000);
  }

  /* ================= 编辑队列 ================= */
  async function startEdit(files, source) {
    if (state.editorOpen) return;
    const images = Array.prototype.slice.call(files || []).filter(isImageFile).slice(0, MAX_FILES);
    if (!images.length) {
      setStatus('只支持图片文件（png / jpg / webp / gif）', 'warn');
      return;
    }
    state.session = {
      files: images,
      source: source || { kind: 'panel' },
      results: [],
      index: 0,
    };
    state.editorOpen = true;
    ensureUI();
    await loadCurrent();
  }

  async function loadCurrent() {
    const session = state.session;
    if (!session) return;
    if (session.index >= session.files.length) {
      await completeSession();
      return;
    }
    const file = session.files[session.index];
    let ok = false;
    try {
      ok = await state.editor.open(file, {
        name: file.name,
        type: file.type,
        index: session.index,
        total: session.files.length,
      });
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      if (!state.session) return;
      setStatus('无法读取「' + (file.name || '图片') + '」，已跳过', 'warn');
      session.index += 1;
      await loadCurrent();
    }
  }

  async function handleEditorDone(file, info) {
    const session = state.session;
    if (!session) {
      state.editor.close();
      return;
    }
    session.results.push(file);
    session.index += 1;
    if (session.index < session.files.length) {
      await loadCurrent();
      return;
    }
    state.editor.close();
    await completeSession();
  }

  function handleEditorCancel() {
    const session = state.session;
    state.session = null;
    state.editorOpen = false;
    if (session && session.source && session.source.kind === 'change' && session.source.input) {
      try { session.source.input.value = ''; } catch (err) { /* ignore */ }
    }
    setStatus('已取消，没有填入任何图片', 'info');
    renderVisibility();
  }

  async function completeSession() {
    const session = state.session;
    state.session = null;
    state.editorOpen = false;
    renderVisibility();
    if (!session) return;
    if (!session.results.length) {
      setStatus('没有可用的编辑结果', 'warn');
      return;
    }
    const ok = await applyEdited(session.results, session.source);
    if (ok) {
      const n = session.results.length;
      setStatus(n > 1
        ? '已把 ' + n + ' 张打码后的图片填入投稿框，请继续在 pixiv 完成投稿'
        : '已填入投稿框，请继续在 pixiv 完成投稿', 'ok');
    }
  }

  /* ================= 回填投稿框 ================= */
  async function applyEdited(files, source) {
    try {
      if (source && source.kind === 'change' && source.input && source.input.isConnected) {
        if (injectViaInput(files, source.input)) return true;
      }
      const input = findImageInput();
      if (input && injectViaInput(files, input)) return true;
      if (source && source.kind === 'drop' && source.target && source.target.isConnected) {
        if (replayDrop(files, source.target)) return true;
      }
      downloadFiles(files);
      setStatus('没有找到 pixiv 的图片投稿框，已把处理后的图片下载到本地', 'warn');
      return false;
    } catch (err) {
      downloadFiles(files);
      setStatus('自动填入失败，已下载处理后的图片：' + ((err && err.message) || err), 'warn');
      return false;
    }
  }

  function injectViaInput(files, input) {
    if (!input || !input.isConnected) return false;
    let list = files.slice();
    let extra = [];
    if (list.length > 1 && !input.multiple) {
      extra = list.slice(1);
      list = list.slice(0, 1);
    }
    const dt = new DataTransfer();
    for (let i = 0; i < list.length; i++) dt.items.add(list[i]);
    try {
      input.files = dt.files;
    } catch (err) {
      return false;
    }
    if (!input.files || input.files.length !== list.length) return false;
    input.dataset.pxmosaicIgnore = '1';
    try {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      setTimeout(() => {
        try { delete input.dataset.pxmosaicIgnore; } catch (err) { /* ignore */ }
      }, 0);
    }
    if (extra.length) {
      downloadFiles(extra);
      setStatus('投稿框一次只能放一张图片，其余 ' + extra.length + ' 张已下载到本地', 'warn');
    }
    return true;
  }

  function replayDrop(files, target) {
    try {
      const dt = new DataTransfer();
      for (let i = 0; i < files.length; i++) dt.items.add(files[i]);
      state.replaying = true;
      setTimeout(() => { state.replaying = false; }, 0);
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      }));
      return true;
    } catch (err) {
      state.replaying = false;
      return false;
    }
  }

  function downloadFiles(files) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const url = URL.createObjectURL(f);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name || 'pixiv-mosaic.png';
        a.style.display = 'none';
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {
        // 忽略单张失败
      }
    }
  }

  /* ================= 拦截 ================= */
  function installInterceptors() {
    window.addEventListener('change', onChangeCapture, true);
    window.addEventListener('dragover', onDragOverCapture, true);
    window.addEventListener('drop', onDropCapture, true);
  }

  function onChangeCapture(e) {
    if (state.replaying || state.editorOpen) return;
    if (!state.settings.autoIntercept) return;
    const el = e.target;
    if (!isImageInput(el)) return;
    if (el.dataset && el.dataset.pxmosaicIgnore) return;
    if (!detectContext()) return;
    const files = Array.prototype.slice.call(el.files || []).filter(isImageFile);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    try { el.value = ''; } catch (err) { /* ignore */ }
    startEdit(files, { kind: 'change', input: el });
  }

  function onDragOverCapture(e) {
    if (state.replaying) return;
    const dt = e.dataTransfer;
    if (!dt || !hasFileDrag(dt)) return;
    if (state.editorOpen) {
      e.preventDefault();
      return;
    }
    if (!state.settings.autoIntercept) return;
    if (!detectContext()) return;
    e.preventDefault();
    dt.dropEffect = 'copy';
  }

  function onDropCapture(e) {
    if (state.replaying) return;
    const dt = e.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const files = Array.prototype.slice.call(dt.files).filter(isImageFile);
    if (!files.length) return;
    if (state.editorOpen) {
      e.preventDefault();
      return;
    }
    if (!state.settings.autoIntercept) return;
    if (!detectContext()) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    startEdit(files, { kind: 'drop', target: e.target });
  }

  /* ================= 工具栏消息 / 导航 ================= */
  function installMessageListener() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== 'PXM_TOGGLE_PANEL') return undefined;
        state.forceVisible = true;
        if (state.panelOpen) {
          setPanelOpen(false);
          state.minimized = true;
        } else {
          setPanelOpen(true);
        }
        if (sendResponse) sendResponse({ ok: true });
        return undefined;
      });
    } catch (err) {
      // 扩展上下文失效时忽略
    }
  }

  function refreshMode() {
    const pathHit = PATH_RE.test(location.pathname);
    state.uploadPage = pathHit;
    state.detected = pathHit || !!findImageInput();
    renderVisibility();
    if (state.uploadPage && !state.panelOpen && state.autoOpenedFor !== location.pathname) {
      state.autoOpenedFor = location.pathname;
      setPanelOpen(true);
    }
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      if (state.host && !state.host.isConnected) {
        try { document.documentElement.appendChild(state.host); } catch (err) { /* ignore */ }
      }
      if (location.href !== state.lastHref) {
        state.lastHref = location.href;
        state.autoOpenedFor = '';
        refreshMode();
      } else if (!state.editorOpen) {
        const before = state.detected;
        state.detected = state.uploadPage || !!findImageInput();
        if (before !== state.detected) renderVisibility();
      }
    }, 1200);
  }

  /* ================= 启动 ================= */
  async function init() {
    await loadSettings();
    ensureUI();
    installInterceptors();
    installMessageListener();
    refreshMode();
    startPolling();
  }

  init().catch(() => {});
})();
