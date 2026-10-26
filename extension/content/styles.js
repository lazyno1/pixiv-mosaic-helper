/* Pixiv 打码助手 - 样式（注入到 shadow DOM）
 * 以字符串形式提供，避免加载外部 CSS 文件。
 */
(() => {
  'use strict';
  const NS = (window.PXM = window.PXM || {});
  if (NS.css) return;

  NS.css = `
  .pxm-root, .pxm-root * { box-sizing: border-box; }
  .pxm-root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
    font-size: 14px;
    line-height: 1.45;
    color: #e9ecf3;
    -webkit-font-smoothing: antialiased;
  }
  .pxm-root [hidden] { display: none !important; }
  .pxm-root button { font-family: inherit; }
  .pxm-root :focus-visible { outline: 2px solid #ff5d9e; outline-offset: 2px; }

  /* ---------- 悬浮按钮 ---------- */
  .pxm-fab {
    position: fixed; right: 18px; bottom: 18px;
    width: 54px; height: 54px; border-radius: 17px; border: none;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; line-height: 1; color: #fff; cursor: pointer;
    background: linear-gradient(135deg, #ff5d9e 0%, #a855f7 100%);
    box-shadow: 0 10px 26px rgba(168, 85, 247, .42), 0 2px 6px rgba(0, 0, 0, .35);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .pxm-fab:hover { transform: translateY(-2px); box-shadow: 0 14px 30px rgba(168, 85, 247, .5); }
  .pxm-fab:active { transform: translateY(0); }
  .pxm-fab .pxm-fab-badge {
    position: absolute; right: -3px; top: -3px;
    min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px;
    background: #fff; color: #a855f7; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
  }

  /* ---------- 小面板 ---------- */
  .pxm-panel {
    position: fixed; right: 18px; bottom: 18px;
    width: 330px; max-width: calc(100vw - 24px);
    background: #15171e; color: #e9ecf3;
    border: 1px solid #2b3040; border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .55);
    overflow: hidden;
    display: none;
  }
  .pxm-panel.pxm-open { display: block; }
  .pxm-panel::before {
    content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
    background: linear-gradient(90deg, #ff5d9e, #a855f7);
  }
  .pxm-head {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 14px 10px;
    cursor: grab; user-select: none;
  }
  .pxm-head:active { cursor: grabbing; }
  .pxm-logo {
    width: 30px; height: 30px; border-radius: 9px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    font-size: 17px; color: #fff;
    background: linear-gradient(135deg, #ff5d9e, #a855f7);
  }
  .pxm-title { flex: 1 1 auto; min-width: 0; }
  .pxm-title b { display: block; font-size: 14px; font-weight: 700; letter-spacing: .2px; }
  .pxm-title small { display: block; font-size: 11.5px; color: #8f98ac; margin-top: 1px; }
  .pxm-min {
    flex: 0 0 auto; width: 26px; height: 26px; border-radius: 8px;
    border: 1px solid #333a4c; background: #1e2230; color: #c3cad9;
    font-size: 15px; line-height: 1; cursor: pointer;
  }
  .pxm-min:hover { background: #262b3b; color: #fff; }
  .pxm-body { padding: 4px 14px 14px; }

  .pxm-drop {
    position: relative;
    border: 1.5px dashed #3b4256; border-radius: 12px;
    background: #1b1f2b; padding: 16px 12px; text-align: center;
    cursor: pointer; transition: border-color .15s, background .15s;
  }
  .pxm-drop:hover { border-color: #6d5bd0; background: #1f2331; }
  .pxm-drop.pxm-over { border-color: #ff5d9e; background: #2a1f2c; }
  .pxm-drop-title { font-size: 13.5px; font-weight: 600; color: #f2f4f9; }
  .pxm-drop-sub { font-size: 11.5px; color: #8f98ac; margin-top: 3px; }
  .pxm-drop-icon { font-size: 20px; line-height: 1; margin-bottom: 6px; opacity: .9; }

  .pxm-field { margin-top: 12px; }
  .pxm-field-head {
    display: flex; align-items: baseline; justify-content: space-between;
    font-size: 12.5px; color: #aab2c4; margin-bottom: 5px;
  }
  .pxm-field-head b { color: #e9ecf3; font-weight: 600; font-size: 12.5px; }
  .pxm-field-head output {
    font-variant-numeric: tabular-nums; color: #ffb3d0; font-weight: 600;
  }
  .pxm-field input[type="range"] {
    width: 100%; margin: 0; accent-color: #ff5d9e; height: 18px; cursor: pointer;
  }
  .pxm-field-scale {
    display: flex; justify-content: space-between; font-size: 10.5px; color: #6f7890; margin-top: 2px;
  }

  .pxm-check {
    display: flex; align-items: flex-start; gap: 8px;
    margin-top: 12px; font-size: 12.5px; color: #c3cad9; cursor: pointer;
  }
  .pxm-check input { margin: 2px 0 0; accent-color: #ff5d9e; width: 15px; height: 15px; cursor: pointer; }

  .pxm-hint { margin-top: 10px; font-size: 11.5px; line-height: 1.55; color: #7f889e; }

  .pxm-status {
    margin-top: 10px; padding: 8px 10px; border-radius: 9px;
    font-size: 11.5px; line-height: 1.5;
    background: #1d2231; border: 1px solid #2c3346; color: #b9c2d4;
  }
  .pxm-status[data-kind="ok"] { background: #16281f; border-color: #2c5a40; color: #9ee2b8; }
  .pxm-status[data-kind="warn"] { background: #2a2318; border-color: #5d4a24; color: #f0cf94; }

  /* ---------- 全屏编辑器 ---------- */
  .pxm-editor {
    position: fixed; inset: 0; z-index: 10;
    display: none; flex-direction: column;
    background: #0d0f14;
    color: #e9ecf3;
  }
  .pxm-editor.pxm-open { display: flex; }

  .pxm-top {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 16px; min-height: 62px;
    background: #14161d; border-bottom: 1px solid #262b38;
    flex-wrap: wrap;
  }
  .pxm-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .pxm-brand-mark {
    width: 28px; height: 28px; border-radius: 8px; flex: 0 0 auto;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #ff5d9e, #a855f7); color: #fff; font-size: 16px;
  }
  .pxm-brand-text { min-width: 0; }
  .pxm-brand-text b { display: block; font-size: 14px; font-weight: 700; }
  .pxm-brand-text small {
    display: block; font-size: 11.5px; color: #8f98ac;
    max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pxm-tools { display: flex; align-items: center; gap: 14px; flex: 1 1 auto; flex-wrap: wrap; }
  .pxm-range { display: flex; align-items: center; gap: 7px; font-size: 12px; color: #aab2c4; white-space: nowrap; }
  .pxm-range input[type="range"] { width: 104px; margin: 0; accent-color: #ff5d9e; cursor: pointer; }
  .pxm-range output {
    min-width: 30px; text-align: right; color: #fff; font-weight: 600;
    font-variant-numeric: tabular-nums; font-size: 12px;
  }
  .pxm-sep { width: 1px; height: 22px; background: #2b3040; flex: 0 0 auto; }
  .pxm-size { font-size: 11.5px; color: #7f889e; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .pxm-btn {
    border: 1px solid #333a4c; background: #1e2230; color: #d8deea;
    border-radius: 9px; padding: 7px 12px; font-size: 12.5px; line-height: 1.2;
    cursor: pointer; white-space: nowrap; transition: background .13s, border-color .13s;
  }
  .pxm-btn:hover:not(:disabled) { background: #262b3b; border-color: #414a60; color: #fff; }
  .pxm-btn:disabled { opacity: .38; cursor: default; }
  .pxm-icon-btn {
    width: 32px; height: 32px; border-radius: 9px; border: 1px solid #333a4c;
    background: #1e2230; color: #c3cad9; font-size: 14px; line-height: 1; cursor: pointer;
  }
  .pxm-icon-btn:hover { background: #2c2230; border-color: #5c3350; color: #ffb3d0; }

  .pxm-stage {
    flex: 1 1 auto; min-height: 0;
    display: flex; align-items: center; justify-content: center;
    padding: 18px; overflow: hidden;
    background:
      radial-gradient(1200px 600px at 50% 0%, rgba(120, 80, 200, .10), transparent 70%),
      #0a0c10;
  }
  .pxm-wrap {
    position: relative; flex: 0 0 auto;
    box-shadow: 0 18px 60px rgba(0, 0, 0, .65);
    outline: 1px solid #2b3040;
    background: #14161d;
  }
  .pxm-wrap canvas { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }
  .pxm-wrap canvas.pxm-preview { cursor: crosshair; touch-action: none; }
  .pxm-wrap canvas.pxm-cursor { pointer-events: none; }

  .pxm-bottom {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 11px 16px; background: #14161d; border-top: 1px solid #262b38;
    flex-wrap: wrap;
  }
  .pxm-tip { font-size: 11.5px; color: #7f889e; min-width: 0; }
  .pxm-actions { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .pxm-btn.pxm-apply {
    border: none; color: #fff; font-weight: 700; font-size: 13px; padding: 10px 18px;
    background: linear-gradient(135deg, #ff5d9e, #a855f7);
    box-shadow: 0 6px 18px rgba(168, 85, 247, .35);
  }
  .pxm-btn.pxm-apply:hover:not(:disabled) { filter: brightness(1.06); }
  .pxm-btn.pxm-cancel { padding: 10px 15px; }

  .pxm-toast {
    position: fixed; left: 50%; top: 78px; transform: translateX(-50%);
    max-width: min(560px, calc(100vw - 32px));
    padding: 10px 16px; border-radius: 10px;
    background: #2b2030; border: 1px solid #6d3d5c; color: #ffe3ef;
    font-size: 12.5px; line-height: 1.5; text-align: center;
    box-shadow: 0 12px 32px rgba(0, 0, 0, .5);
    z-index: 20;
  }

  @media (max-width: 720px) {
    .pxm-editor .pxm-tip { display: none; }
    .pxm-top { gap: 8px; padding: 8px 10px; }
    .pxm-tools { gap: 8px; }
    .pxm-range input[type="range"] { width: 78px; }
    .pxm-size { display: none; }
  }
  `;
})();
