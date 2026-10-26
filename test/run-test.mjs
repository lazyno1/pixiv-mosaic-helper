/* Pixiv 打码助手 - 端到端测试
 *
 * 做法：
 *  1. 起本地 HTTP 服务（127.0.0.1:8123），提供 mock 投稿页和带噪声的测试 PNG；
 *  2. 复制一份扩展，把 matches 改成 http://www.pixiv.test/*（测试域名，避免 HSTS）；
 *  3. 用 --load-extension 启动 headless Edge / Chromium + CDP 驱动页面；
 *  4. 若扩展加载失败，自动退化为把三个内容脚本注入页面（stub chrome.* API）再测。
 *
 * 运行：node test/run-test.mjs [--mode=auto|ext|inject]
 * 浏览器路径：默认自动探测 Edge / Chrome / Chromium，可用环境变量 EDGE_PATH 覆盖。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXTENSION = path.join(ROOT, 'extension');
const TMP = path.join(HERE, '.tmp');
const PROFILE = path.join(TMP, 'profile');
const EXT_COPY = path.join(TMP, 'ext');
const SHOTS = path.join(HERE, 'screenshots');

const HOST = 'www.pixiv.test';
const PORT = 8123;
const CDP_PORT = 9333;
const IMG_W = 320;
const IMG_H = 240;

const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=auto').split('=')[1];

/* ================= 测试 PNG ================= */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : (c >>> 1) >>> 0;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const pngCache = new Map();

function makePng(seed) {
  if (pngCache.has(seed)) return pngCache.get(seed);
  const w = IMG_W;
  const h = IMG_H;
  const rnd = mulberry32(seed * 7919 + 13);
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * stride + 1 + x * 4;
      const base = (x < w / 2 ? 30 : 190) + (y < h / 2 ? 0 : 40);
      raw[i] = byte(base + rnd() * 60);
      raw[i + 1] = byte(120 + rnd() * 80);
      raw[i + 2] = byte(200 - base / 2 + rnd() * 60);
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  pngCache.set(seed, png);
  return png;
}

/* ================= mock 页面服务 ================= */
function makeBigPng(w, h) {
  const key = 'big:' + w + 'x' + h;
  if (pngCache.has(key)) return pngCache.get(key);
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  const A = [220, 70, 90];
  const B = [40, 120, 210];
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    for (let x = 0; x < w; x++) {
      const c = (((x >> 1) + (y >> 1)) & 1) ? B : A;
      const i = row + 1 + x * 4;
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  pngCache.set(key, png);
  return png;
}

function startServer() {
  const html = readFileSync(path.join(HERE, 'mock-pixiv.html'));
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${HOST}:${PORT}`);
    } catch (err) {
      res.writeHead(400).end('bad request');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/mock-pixiv.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (url.pathname === '/test.png') {
      const seed = Number(url.searchParams.get('seed') || '1') || 1;
      const png = makePng(seed);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(png);
      return;
    }
    if (url.pathname === '/big.png') {
      const w = Math.min(6000, Number(url.searchParams.get('w') || '4300') || 4300);
      const h = Math.min(6000, Number(url.searchParams.get('h') || '3100') || 3100);
      const png = makeBigPng(w, h);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(png);
      return;
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/* ================= CDP ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('websocket open timeout')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error: ' + url));
    });
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) list.forEach((fn) => fn(msg.params));
    });
  }

  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() {
    try { this.ws.close(); } catch (err) { /* ignore */ }
  }
}

async function httpJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'unknown';
    throw new Error('页面脚本异常: ' + desc);
  }
  return res.result.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await evaluate(cdp, expression);
      if (value) return value;
    } catch (err) {
      lastError = err.message;
    }
    await sleep(120);
  }
  throw new Error('等待超时：' + label + (lastError ? '（最后错误：' + lastError + '）' : ''));
}

/* ================= 预检 ================= */
function preflight() {
  const checks = [];
  const manifest = JSON.parse(readFileSync(path.join(EXTENSION, 'manifest.json'), 'utf8'));
  checks.push(['manifest 是 MV3', manifest.manifest_version === 3]);
  checks.push(['content_scripts 只匹配 https pixiv', manifest.content_scripts[0].matches.every((m) => m.startsWith('https://'))]);
  checks.push(['注入顺序 styles→editor→content', manifest.content_scripts[0].js.join(',').endsWith('content/styles.js,content/editor.js,content/content.js')]);
  for (const size of [16, 32, 48, 128]) {
    checks.push([`存在 icon${size}.png`, existsSync(path.join(EXTENSION, 'icons', `icon${size}.png`))]);
  }
  checks.push(['background.js 存在', existsSync(path.join(EXTENSION, 'background.js'))]);
  return checks;
}

/* ================= 启动浏览器 ================= */
/** 找一个可用的 Chromium 系浏览器：优先环境变量，其次常见安装路径 */
function findBrowser() {
  const override = process.env.EDGE_PATH || process.env.BROWSER_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error('环境变量指定的浏览器不存在：' + override);
    return override;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
    );
  }
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error('未找到 Edge/Chrome/Chromium，请用环境变量 EDGE_PATH 指定浏览器可执行文件');
  }
  return found;
}

async function launchBrowser() {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const browser = findBrowser();

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_COPY}`,
    `--disable-extensions-except=${EXT_COPY}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1280,900',
    'about:blank',
  ];

  const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
  child.__exitCode = null;
  child.on('exit', (code) => { child.__exitCode = code; });
  child.on('error', (err) => { child.__spawnError = err; });

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    if (child.__spawnError) throw child.__spawnError;
    if (child.__exitCode !== null) throw new Error('浏览器提前退出，code=' + child.__exitCode);
    try {
      version = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/version`, 1500);
      if (version && version.webSocketDebuggerUrl) break;
    } catch (err) {
      // 还没起来
    }
    await sleep(250);
  }
  if (!version) throw new Error('浏览器 DevTools 未在 30 秒内就绪');
  return { child, version };
}

async function pageTarget() {
  const list = await httpJson(`http://127.0.0.1:${CDP_PORT}/json/list`, 3000);
  const pages = list.filter((t) => t.type === 'page');
  return pages.find((t) => t.url === 'about:blank') || pages[0] || null;
}

async function closeBrowser(child, version) {
  try {
    const ws = await openWs(version.webSocketDebuggerUrl);
    const cdp = new CDP(ws);
    await cdp.send('Browser.close');
    cdp.close();
  } catch (err) {
    // 忽略
  }
  const deadline = Date.now() + 6000;
  while (child.__exitCode === null && Date.now() < deadline) await sleep(150);
  if (child.__exitCode === null) {
    try { child.kill(); } catch (err) { /* ignore */ }
  }
}

/* ================= 内容脚本注入（降级模式） ================= */
async function injectContentScripts(cdp) {
  await evaluate(cdp, `(() => {
    const base = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
    base.storage = { local: {
      get: (key) => Promise.resolve({ pxmSettings: null }),
      set: () => Promise.resolve(),
    } };
    base.runtime = { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve() };
    window.chrome = base;
    return true;
  })()`);
  for (const rel of ['content/styles.js', 'content/editor.js', 'content/content.js']) {
    const code = readFileSync(path.join(EXTENSION, rel), 'utf8');
    const res = await cdp.send('Runtime.evaluate', {
      expression: code + '\n//# sourceURL=pxm-' + rel,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(rel + ' 注入失败: ' + desc);
    }
  }
}

/* ================= 截图 ================= */
async function screenshot(cdp, name) {
  try {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOTS, { recursive: true });
    const file = path.join(SHOTS, name);
    writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  } catch (err) {
    return null;
  }
}

/** 等编辑器真正加载完成（apply 按钮从 disabled 变为可用） */
async function waitEditorReady(cdp, label, timeout) {
  await waitFor(cdp, '__state().editorOpen && __state().applyDisabled === false', timeout || 12000, label || '编辑器加载完成');
}

/** 用 CDP 发送真实的 Esc 按键（跨 isolated world，等价用户按键） */
async function pressEscape(cdp) {
  const key = {
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  };
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, key));
  await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
}

/* ================= 主流程 ================= */
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (!ok && detail ? ' — ' + detail : ''));
}

async function runTests(cdp, mode) {
  console.log(`\n== 运行测试（模式：${mode}） ==`);

  // 让页面获得焦点，后续 CDP 按键才会派发到页面
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 6, y: 6, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 6, y: 6, button: 'left', clickCount: 1 });

  const st0 = await evaluate(cdp, '__state()');
  check('扩展 UI 已注入 shadow DOM', st0.host);
  check('FAB 在投稿上下文可见', st0.fabHidden === false);

  // ---- 1. 拦截「选择图片」 ----
  await evaluate(cdp, '__pick([1])');
  await waitEditorReady(cdp, '选择图片后打开编辑器');
  const st1 = await evaluate(cdp, '__state()');
  check('拦截后页面没有收到 change（原图未泄漏）', st1.changes === 0, 'changes=' + st1.changes);
  check('拦截后原 input 被清空', st1.inputFiles.length === 0, JSON.stringify(st1.inputFiles));
  check('编辑器显示当前文件名', st1.editorFile.includes('photo-1.png'), st1.editorFile);

  await evaluate(cdp, '__setEditorRange(120, 20)');
  const st2 = await evaluate(cdp, '__state()');
  check('笔刷/马赛克滑块生效', st2.brush === '120' && st2.block === '20', st2.brush + '/' + st2.block);

  await evaluate(cdp, '__paint()');
  const toastAfterPaint = await evaluate(cdp, '__toast()');
  check('涂抹后没有报错提示', toastAfterPaint === '', toastAfterPaint);

  const geo = await evaluate(cdp, `(() => {
    const sr = document.getElementById('pixiv-mosaic-host').shadowRoot;
    const wrap = sr.querySelector('.pxm-wrap');
    const prev = sr.querySelector('.pxm-preview');
    const r = wrap.getBoundingClientRect();
    const w = prev.width, h = prev.height;
    const d = prev.getContext('2d').getImageData(0, 0, w, h).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 12) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    return {
      width: Math.round(r.width), height: Math.round(r.height),
      imgW: 320, imgH: 240,
      box: {
        x0: (minX / w) * 320, y0: (minY / h) * 240,
        x1: ((maxX + 1) / w) * 320, y1: ((maxY + 1) / h) * 240,
      },
    };
  })()`);
  const previewScale = geo.width / 320;
  const brushR = 60 / previewScale; // 笔刷 120 屏幕 px → 半径 60 / 显示缩放
  const near = (v, target) => Math.abs(v - target) <= 22;
  check(
    '预览马赛克画在笔迹位置',
    near(geo.box.x0, 80 - brushR) && near(geo.box.x1, 240 + brushR) &&
    near(geo.box.y0, 120 - brushR) && near(geo.box.y1, 120 + brushR),
    JSON.stringify(geo.box) + ' 期望 r≈' + brushR.toFixed(1)
  );

  await screenshot(cdp, 'editor-painted.png');

  await evaluate(cdp, '__apply()');
  await waitFor(cdp, '__state().editorOpen === false && __state().inputFiles.length === 1', 20000, '导出并回填投稿框');
  await waitFor(cdp, '__state().analyses.length === 1', 20000, 'mock 页完成像素分析');
  const st3 = await evaluate(cdp, '__state()');
  const a1 = st3.analyses[0] || {};
  check('回填文件名带 -mosaic 后缀', st3.inputFiles[0].endsWith('-mosaic.png'), st3.inputFiles[0]);
  check('输出尺寸与原图一致', a1.width === IMG_W && a1.height === IMG_H, a1.width + 'x' + a1.height);
  check('涂抹区被马赛克（颜色数很少）', a1.painted <= 30, 'painted=' + a1.painted);
  check('涂抹区像素块平整', a1.paintedFlat > 0.7, 'flat=' + a1.paintedFlat);
  check('未涂抹区保留细节', a1.plain > 800 && a1.plainFlat < 0.05, `plain=${a1.plain} flat=${a1.plainFlat}`);
  check('只触发一次 change（无重复注入）', st3.changes === 1, 'changes=' + st3.changes);

  // ---- 2. 取消 ----
  await evaluate(cdp, '__pick([2])');
  await waitEditorReady(cdp, '再次打开编辑器');
  await pressEscape(cdp);
  await waitFor(cdp, '__state().editorOpen === false', 8000, 'Esc 关闭编辑器');
  const st4 = await evaluate(cdp, '__state()');
  check('取消后投稿框保持空', st4.inputFiles.length === 0, JSON.stringify(st4.inputFiles));
  check('取消后没有新的 change', st4.changes === 1, 'changes=' + st4.changes);

  // ---- 3. 多图队列 ----
  await evaluate(cdp, '__pick([3, 4])');
  await waitFor(cdp, '__state().editorOpen && __state().editorFile.includes("1/2")', 10000, '队列第 1 张');
  await waitEditorReady(cdp, '队列第 1 张就绪');
  await evaluate(cdp, '__paint()');
  await evaluate(cdp, '__apply()');
  await waitFor(cdp, '__state().editorOpen && __state().editorFile.includes("2/2")', 15000, '队列第 2 张');
  await waitEditorReady(cdp, '队列第 2 张就绪');
  const midQueue = await evaluate(cdp, '__state()');
  check('队列第 1 张完成时还没有注入', midQueue.inputFiles.length === 0, JSON.stringify(midQueue.inputFiles));
  await evaluate(cdp, '__paint()');
  await evaluate(cdp, '__apply()');
  await waitFor(cdp, '__state().editorOpen === false && __state().inputFiles.length === 2', 25000, '两张一起注入');
  await waitFor(cdp, '__state().analyses.length === 2', 20000, '分析两张');
  const st5 = await evaluate(cdp, '__state()');
  check('多图全部回填', st5.inputFiles.length === 2, JSON.stringify(st5.inputFiles));
  check('多图只发一次 change', st5.changes === 2, 'changes=' + st5.changes);
  const multiOk = (st5.analyses || []).every((a) => a.painted <= 30 && a.paintedFlat > 0.7);
  check('多图每张都打码', multiOk, JSON.stringify(st5.analyses));

  // ---- 3.5 超大图（长边 > 4096）导出缩放 ----
  await evaluate(cdp, '__pickBig()');
  await waitFor(cdp, '__state().editorOpen', 30000, '大图打开编辑器');
  await waitEditorReady(cdp, '大图加载完成', 30000);
  await evaluate(cdp, '__paintMid()');
  await evaluate(cdp, '__apply()');
  await waitFor(cdp, '__state().editorOpen === false && __state().inputFiles.length === 1', 120000, '大图导出并回填');
  await waitFor(cdp, '__state().analyses.length === 1', 120000, '大图像素分析');
  const bigState = await evaluate(cdp, '__state()');
  const big = bigState.analyses[0];
  check('大图输出限制在 4096', big.width === 4096 && big.height < 4096, big.width + 'x' + big.height);
  check('大图缩放后仍然打码', big.paintedFlat > 0.7 && big.painted <= 30, JSON.stringify(big));
  check('大图文件名带 -mosaic', bigState.inputFiles[0] === 'big-mosaic.png', bigState.inputFiles[0]);

  // ---- 4. 未涂抹时二次确认 ----
  await evaluate(cdp, '__pick([7])');
  await waitEditorReady(cdp, '打开编辑器（空涂抹）');
  await evaluate(cdp, '__apply()');
  const toast = await evaluate(cdp, '__toast()');
  check('空涂抹第一次点完成会提示', toast.includes('还没有涂抹'), toast);
  const st6 = await evaluate(cdp, '__state()');
  check('空涂抹提示时编辑器保持打开', st6.editorOpen === true);
  await evaluate(cdp, '__apply()');
  await waitFor(cdp, '__state().editorOpen === false && __state().inputFiles.length === 1', 20000, '再次点击导出原图');
  const st7 = await evaluate(cdp, '__state()');
  check('原图也能填入投稿框', st7.inputFiles.length === 1, JSON.stringify(st7.inputFiles));
  check('原图导出仍为 png', st7.inputFiles[0].endsWith('.png'), st7.inputFiles[0]);

  // ---- 5. 拖拽导入 ----
  const beforeDrop = (await evaluate(cdp, '__state()')).inputFiles;
  await evaluate(cdp, '__drop(5)');
  await waitEditorReady(cdp, '拖拽后打开编辑器');
  const st8 = await evaluate(cdp, '__state()');
  check('拖拽打开编辑器且未直接注入', st8.editorOpen && JSON.stringify(st8.inputFiles) === JSON.stringify(beforeDrop), JSON.stringify(st8.inputFiles));
  check('拖拽图片是拖入的文件', st8.editorFile.includes('dropped-5.png'), st8.editorFile);
  await pressEscape(cdp);
  await waitFor(cdp, '__state().editorOpen === false', 8000, '拖拽后取消');
  const st8b = await evaluate(cdp, '__state()');
  check('拖拽取消后投稿框不变', JSON.stringify(st8b.inputFiles) === JSON.stringify(beforeDrop), JSON.stringify(st8b.inputFiles));

  // ---- 6. 面板与滑块同步 ----
  await evaluate(cdp, '__clickPanel()');
  const st9 = await evaluate(cdp, '__state()');
  check('点 FAB 打开面板', st9.panelOpen === true);
  check('面板打开时 FAB 隐藏', st9.fabHidden === true);
  const panelVals = await evaluate(cdp, '__setPanelRange(88, 6)');
  check('面板滑块输出更新', panelVals.brushOut === '88' && panelVals.blockOut === '6', JSON.stringify(panelVals));

  await evaluate(cdp, '__pick([6])');
  await waitEditorReady(cdp, '从面板参数打开编辑器');
  const st10 = await evaluate(cdp, '__state()');
  check('编辑器继承面板参数', st10.brush === '88' && st10.block === '6', st10.brush + '/' + st10.block);
  await pressEscape(cdp);
  await waitFor(cdp, '__state().editorOpen === false', 8000, '关闭编辑器');

  await evaluate(cdp, '__setEditorRange(60, 12)');
  const panelSynced = await evaluate(cdp, `(() => {
    const sr = document.getElementById('pixiv-mosaic-host').shadowRoot;
    return {
      brush: sr.querySelector('.pxm-panel .pxm-brush').value,
      block: sr.querySelector('.pxm-panel .pxm-block').value,
      brushOut: sr.querySelector('.pxm-panel .pxm-brush-out').textContent,
    };
  })()`);
  check('编辑器调参反向同步到面板', panelSynced.brush === '60' && panelSynced.block === '12', JSON.stringify(panelSynced));

  await screenshot(cdp, 'panel-open.png');

  // ---- 7. 收起面板 ----
  await evaluate(cdp, `document.getElementById('pixiv-mosaic-host').shadowRoot.querySelector('.pxm-min').click()`);
  const st11 = await evaluate(cdp, '__state()');
  check('收起按钮关闭面板', st11.panelOpen === false);
  check('收起后 FAB 恢复', st11.fabHidden === false);

  const errs = st11.errors || [];
  check('mock 页没有异常', errs.length === 0, errs.join(' | '));
}

async function main() {
  console.log('Pixiv 打码助手 · 端到端测试\n');

  console.log('== 预检 ==');
  let preflightOk = true;
  for (const [name, ok] of preflight()) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + name);
    if (!ok) preflightOk = false;
  }
  if (!preflightOk) throw new Error('预检失败');

  // 复制扩展并把 match 换成测试域名（保持生产 manifest 只有 https pixiv）
  rmSync(EXT_COPY, { recursive: true, force: true });
  cpSync(EXTENSION, EXT_COPY, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(EXT_COPY, 'manifest.json'), 'utf8'));
  const testMatch = `http://${HOST}/*`;
  manifest.content_scripts.forEach((cs) => { cs.matches = [testMatch]; });
  manifest.host_permissions = [testMatch];
  writeFileSync(path.join(EXT_COPY, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const server = await startServer();
  console.log(`\n本地 mock 服务：http://${HOST}:${PORT}/mock-pixiv.html`);

  let child = null;
  let version = null;
  let cdp = null;

  try {
    ({ child, version } = await launchBrowser());
    const target = await pageTarget();
    if (!target) throw new Error('找不到可调试的页面 target');
    const ws = await openWs(target.webSocketDebuggerUrl);
    cdp = new CDP(ws);

    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push((p.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push((p.exceptionDetails && (p.exceptionDetails.text || (p.exceptionDetails.exception && p.exceptionDetails.exception.description))) || 'exception');
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: `http://${HOST}:${PORT}/mock-pixiv.html` });
    await waitFor(cdp, `document.readyState === 'complete'`, 20000, 'mock 页加载');

    let mode = 'ext';
    let ready = false;
    try {
      await waitFor(cdp, `!!document.getElementById('pixiv-mosaic-host')`, 12000, '扩展内容脚本注入');
      ready = true;
    } catch (err) {
      console.log('  ! 扩展未能自动注入：' + err.message);
    }

    if (!ready && modeArg !== 'ext') {
      mode = 'inject';
      console.log('  → 退化为直接注入内容脚本模式');
      await injectContentScripts(cdp);
      await waitFor(cdp, `!!document.getElementById('pixiv-mosaic-host')`, 10000, '注入后出现 UI');
      ready = true;
    }
    if (!ready) throw new Error('内容脚本没有运行，请查看控制台错误：' + consoleErrors.join(' | '));

    await runTests(cdp, mode);

    if (consoleErrors.length) {
      console.log('\n== 浏览器控制台错误 ==');
      for (const line of consoleErrors.slice(0, 20)) console.log('  ! ' + line);
    }
  } finally {
    if (cdp) cdp.close();
    if (child) await closeBrowser(child, version);
    await new Promise((resolve) => server.close(resolve));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((r) => console.log('  - ' + r.name + (r.detail ? '：' + r.detail : '')));
    process.exitCode = 1;
  }
  console.log('截图目录：' + SHOTS);
}

main().catch((err) => {
  console.error('\n测试失败：' + err.message);
  process.exitCode = 1;
});
