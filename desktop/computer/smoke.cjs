'use strict';
// The smoke test of the computer-use backend, run by a person on this computer: PLENUM_SMOKE=1 npm run computer:smoke (on Windows
// and Linux X11 as is; on macOS Plenum must hold Screen Recording and Accessibility first). It opens a throwaway window of its own,
// titled 'Plenum smoke target', and checks in order: the backend probes as supported; the window is listed as our own; a capture of
// it has the right size and a green centre; the window comes to the front; one click lands in it and the window turns red; the
// text 'hello' is typed into its box and cleared with Ctrl+A and Backspace; the control overlay shows, keeps its marker out of
// pictures, and hides its frame while paused. Every injected action is aimed at that window and checked against the foreground
// first, so nothing lands in another program. The test never calls a model or the server, never reads a key or a setting, and
// npm test never starts it.
//
// Output: one JSON line per step ({ step, ok, ... }), then { ok, steps, platform, overlay }. Exit codes: 0 all seven steps passed;
// 1 a step failed (its line says which); 2 macOS without the screen or input permission (the line names the state and the help);
// 3 PLENUM_SMOKE is not 1, so nothing was started; 4 another window was in front, so nothing was sent.
//
// The target page carries no script and no stylesheet: the main process sizes its two controls and wires the click with
// executeJavaScript, which the page's own policy does not govern. The overlay bar loads the app's public/overlay.html from a
// loopback server this test starts on a free port (never the app's port).
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const geometry = require('./geometry.cjs');
const png = require('./png.cjs');
const { PARTITION } = require('./overlay.cjs');

const TITLE = 'Plenum smoke target';
const GREEN = '#2bd36b';
const RED = '#d92d20';
const TOLERANCE = 24;
const MAX_EDGE = 1280;
const MARKER_MIN = 4;
const GUARD_MESSAGE = 'Set PLENUM_SMOKE=1 to run the smoke test; it clicks once inside its own window.';
const PERMISSION_HELP = 'Grant Screen Recording and Accessibility to Plenum in System Settings > Privacy & Security, then run the smoke test again.';
const BOX_VALUE = "document.getElementById('box').value";
const CLICKED = 'window.__clicked === true';
const EXIT = Object.freeze({ ok: 0, failed: 1, permission: 2, guard: 3, inFront: 4 });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plenum smoke target</title></head>'
  + '<body><button id="go" type="button"></button><input id="box" type="text" aria-label="Smoke input"></body></html>';

// Injected into the target page by the main process. Sizes the button to fill the window above the box, and on a click turns the
// button red, sets window.__clicked and moves focus to the box.
function setupPage(green, red) {
  document.body.style.cssText = `margin:0;height:100%;background:${green};`;
  const go = document.getElementById('go');
  go.textContent = 'Click this window';
  go.style.cssText = `position:fixed;left:0;top:0;width:100%;height:75%;margin:0;border:0;border-radius:0;background:${green};`
    + 'color:#fff;font:600 22px system-ui,sans-serif;cursor:pointer;';
  const box = document.getElementById('box');
  box.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;height:40px;box-sizing:border-box;font:16px system-ui,sans-serif;';
  window.__clicked = false;
  go.addEventListener('click', () => {
    window.__clicked = true;
    go.style.background = red;
    box.focus();
  });
}

const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const GREEN_RGB = hexRgb(GREEN);
const RED_RGB = hexRgb(RED);
const near = (px, rgb) => px.every((v, i) => Math.abs(v - rgb[i]) <= TOLERANCE);
const isMaskGrey = (r, g, b) => Math.abs(r - 128) <= 2 && Math.abs(g - 128) <= 2 && Math.abs(b - 128) <= 2;
const isMagenta = (r, g, b) => r >= 250 && g <= 5 && b >= 250;

// A PNG from the backend as { width, height, rgba }, or null when it is not one.
function readPicture(shot) {
  if (!shot || !shot.png) return null;
  try {
    return png.decodePng(shot.png);
  } catch {
    return null;
  }
}

function pixel(pic, x, y) {
  const i = (y * pic.width + x) * 4;
  return [pic.rgba[i], pic.rgba[i + 1], pic.rgba[i + 2]];
}

function countWhere(pic, test) {
  let n = 0;
  for (let i = 0; i < pic.rgba.length; i += 4) {
    if (test(pic.rgba[i], pic.rgba[i + 1], pic.rgba[i + 2])) n += 1;
  }
  return n;
}

const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Whether another program's window overlaps the target (true also when the window list cannot be read: the caller then warns).
async function overlapsAnother(backend, target) {
  const stack = await backend.windows({ all: true });
  if (!Array.isArray(stack)) return true;
  return stack.some(w => String(w.id) !== String(target.id) && w.bounds && intersects(w.bounds, target.bounds));
}

// Where the bar sits against the target, from their rectangles in DIP.
function placementOf(bar, t) {
  if (bar.y + bar.height <= t.y) return 'above';
  if (bar.y >= t.y + t.height) return 'below';
  return 'top centre';
}

// The overlay's windows: the bar (the one of the bar's size) and the frame strips, found by their session partition.
function overlayParts(electron) {
  const ses = electron.session.fromPartition(PARTITION);
  const wins = electron.BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.webContents.session === ses);
  const isBar = w => {
    const b = w.getBounds();
    return b.width === geometry.BAR_SIZE.width && b.height === geometry.BAR_SIZE.height;
  };
  const bar = wins.find(isBar) ?? null;
  return { bar, strips: wins.filter(w => w !== bar) };
}

async function openTarget(BrowserWindow, wait) {
  const win = new BrowserWindow({
    width: 640,
    height: 420,
    x: 120,
    y: 120,
    title: TITLE,
    show: false,
    backgroundColor: GREEN,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
  });
  const ready = new Promise(resolve => win.once('ready-to-show', resolve));
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  await win.webContents.executeJavaScript(`(${setupPage.toString()})(${JSON.stringify(GREEN)}, ${JSON.stringify(RED)});`);
  await Promise.race([ready, wait(3000)]);
  await wait(500);
  win.show();
  win.focus();
  return win;
}

async function readPage(win, expression) {
  try {
    return await win.webContents.executeJavaScript(expression, false);
  } catch {
    return undefined;
  }
}

async function waitFor(check, ms, wait) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= until) return false;
    await wait(100);
  }
}

// Closes what the test opened, whatever happened: the overlay, held keys and the window.
async function tidy(backend, win) {
  try {
    await backend.overlay({ show: false });
  } catch {
    // Nothing more can be done.
  }
  try {
    await backend.release();
  } catch {
    // Nothing more can be done.
  }
  try {
    if (win && !win.isDestroyed()) win.close();
  } catch {
    // The window is already gone.
  }
}

// Runs the seven steps against the backend. Returns the exit code; every outcome is also printed through log.
// electron: { app, BrowserWindow, session }. backend: the computer backend (real, or a stand-in in tests).
async function runSmoke({ electron, backend, log = () => {}, sleep: wait = sleep, platform = process.platform, pid = process.pid } = {}) {
  const { BrowserWindow } = electron;
  let passed = 0;
  let overlayMode = 'unknown';
  const ok = (step, data = {}) => {
    passed += 1;
    log({ step, ok: true, ...data });
  };
  const fail = (step, reason, data = {}) => {
    log({ step, ok: false, reason, ...data });
    return EXIT.failed;
  };
  const inFront = step => {
    log({ step, ok: false, reason: 'Another window is in front, so nothing was sent.' });
    return EXIT.inFront;
  };

  let win = null;
  let code = EXIT.failed;
  try {
    win = await openTarget(BrowserWindow, wait);

    // 1. The backend probes as supported.
    const probe = await backend.probe();
    if (!probe || probe.supported !== true) {
      const perms = probe?.permissions ?? {};
      const missing = ['screen', 'input'].filter(k => perms[k] && perms[k] !== 'granted' && perms[k] !== 'n/a');
      if (platform === 'darwin' && missing.length > 0) {
        log({ step: 1, ok: false, reason: 'A macOS permission is missing.', permissions: perms, help: PERMISSION_HELP });
        return EXIT.permission;
      }
      return fail(1, probe?.reason || 'The backend says computer use is not supported on this computer.', { platform });
    }
    ok(1, { platform });

    // 2. The target is listed as our own window.
    const listed = await backend.windows({ all: false });
    const target = Array.isArray(listed) ? listed.find(w => w.title === TITLE && w.pid === pid && w.own === true) : null;
    if (!target) return fail(2, 'The target window is not listed as our own window.', { listed: Array.isArray(listed) ? listed.length : null });
    await backend.focus(target.id);
    await wait(300);
    ok(2, { own: true, displayId: target.displayId ?? null });

    // 3. A window capture has the window's size, a green centre, and no mask grey unless another program covers it.
    const seen = readPicture(await backend.capture({ scope: 'window', target: target.id, maxEdge: MAX_EDGE }));
    if (!seen) return fail(3, 'The capture is not a PNG picture.');
    const want = geometry.fitEdge(target.bounds.width, target.bounds.height, MAX_EDGE);
    if (Math.abs(seen.width - want.width) > 1 || Math.abs(seen.height - want.height) > 1) {
      return fail(3, 'The picture is not the size of the window.', { size: [seen.width, seen.height], expected: [want.width, want.height] });
    }
    const centre = pixel(seen, seen.width >> 1, seen.height >> 1);
    if (!near(centre, GREEN_RGB)) return fail(3, 'The centre of the window is not green.', { centre });
    const grey = countWhere(seen, isMaskGrey);
    let warning;
    if (grey > 0) {
      if (!(await overlapsAnother(backend, target))) return fail(3, 'Mask grey shows in a window that nothing covers.', { grey });
      warning = 'Another program overlaps the window, so part of the capture is masked grey.';
    }
    ok(3, { size: [seen.width, seen.height], centre: 'green', ...(warning ? { warning } : {}) });

    // 4. The target is in front and is not elevated.
    const front = await backend.foreground();
    if (!front || String(front.id) !== String(target.id)) return inFront(4);
    if (front.elevated === true) return fail(4, 'The target reads as elevated.');
    ok(4, { foreground: 'target', elevated: false });

    // 5. One click at the window's centre turns it red.
    if (!(await isFront(backend, target))) return inFront(5);
    const b = target.bounds;
    const cx = Math.round(b.x + b.width / 2);
    const cy = Math.round(b.y + b.height / 2);
    const clicked = await backend.input({ kind: 'click', x: cx, y: cy, button: 'left', count: 1, modifiers: [] });
    if (!clicked || clicked.ok !== true) return fail(5, 'The click was refused.', { reason: clicked?.reason ?? null });
    const registered = await waitFor(async () => (await readPage(win, CLICKED)) === true, 2000, wait);
    if (!registered) return fail(5, 'The page did not register the click.');
    const after = readPicture(await backend.capture({ scope: 'window', target: target.id, maxEdge: MAX_EDGE }));
    if (!after || !near(pixel(after, after.width >> 1, after.height >> 1), RED_RGB)) return fail(5, 'The centre did not turn red.');
    ok(5, { clicked: true, centre: 'red' });

    // 6. Five characters are typed, then Ctrl+A and Backspace clear them.
    if (!(await isFront(backend, target))) return inFront(6);
    const typed = await backend.input({ kind: 'type', text: 'hello' });
    if (!typed || typed.ok !== true) return fail(6, 'The text was refused.', { reason: typed?.reason ?? null });
    const written = await readPage(win, BOX_VALUE);
    if (written !== 'hello') return fail(6, 'The box does not read hello after typing.', { length: typeof written === 'string' ? written.length : null });
    if (!(await isFront(backend, target))) return inFront(6);
    const selected = await backend.input({ kind: 'key', keys: ['ctrl', 'a'] });
    if (!selected || selected.ok !== true) return fail(6, 'A key was refused.', { reason: selected?.reason ?? null });
    if (!(await isFront(backend, target))) return inFront(6);
    const erased = await backend.input({ kind: 'key', keys: ['BackSpace'] });
    if (!erased || erased.ok !== true) return fail(6, 'A key was refused.', { reason: erased?.reason ?? null });
    const cleared = await readPage(win, BOX_VALUE);
    if (cleared !== '') return fail(6, 'The box was not cleared by Ctrl+A and Backspace.');
    ok(6, { typed: 'hello', cleared: true });

    // 7. The overlay shows: its marker stays out of a display capture, the bar sits next to the target, the frame shows while
    //    running and hides while paused.
    const display = target.displayId ?? null;
    const rect = target.bounds;
    const shown = await backend.overlay({ show: true, displayId: display, rect, state: 'running', model: '', label: 'Smoke test' });
    if (!shown || shown.ok !== true) return fail(7, 'The overlay did not show.');
    await wait(800);
    const screen = readPicture(await backend.capture({ scope: 'display', target: display, maxEdge: MAX_EDGE }));
    if (!screen) return fail(7, 'The display capture is not a PNG picture.');
    const magenta = countWhere(screen, isMagenta);
    if (magenta >= MARKER_MIN) return fail(7, 'The overlay marker shows in a capture, so the overlay is not kept out of pictures.', { magenta });
    overlayMode = (await backend.probe())?.overlay ?? 'unknown';
    const parts = overlayParts(electron);
    if (!parts.bar) return fail(7, 'The overlay bar window is missing.');
    const placement = placementOf(parts.bar.getBounds(), win.getBounds());
    const runningFrame = overlayParts(electron).strips.filter(w => w.isVisible()).length;
    if (runningFrame === 0) return fail(7, 'No frame strip shows while the drive is running.');
    await backend.overlay({ show: true, displayId: display, rect, state: 'paused', model: '', label: 'Smoke test' });
    await wait(200);
    const pausedFrame = overlayParts(electron).strips.filter(w => w.isVisible()).length;
    if (pausedFrame !== 0) return fail(7, 'A frame strip still shows while paused.', { visible: pausedFrame });
    await backend.overlay({ show: false });
    ok(7, { overlay: overlayMode, placement, frame: { running: runningFrame, paused: 0 }, magenta: 0 });

    code = EXIT.ok;
  } catch (err) {
    log({ ok: false, reason: 'The smoke test stopped with an error.', error: String(err?.message ?? err).slice(0, 200) });
    code = EXIT.failed;
  } finally {
    await tidy(backend, win);
  }
  if (code === EXIT.ok) log({ ok: true, steps: passed, platform, overlay: overlayMode });
  return code;
}

// Whether the target is the window in front now (checked before every injected action).
async function isFront(backend, target) {
  const front = await backend.foreground();
  return !!front && String(front.id) === String(target.id);
}

// A loopback server on a free port for the overlay page: public/overlay.html, and nothing else.
function startOverlayServer() {
  const file = path.join(__dirname, '..', '..', 'public', 'overlay.html');
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const isPage = req.method === 'GET' && String(req.url ?? '').split('?')[0] === '/overlay.html';
      if (isPage && fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

// Ends the process after everything written so far has been flushed.
function exitNow(code, app) {
  process.stdout.write('', () => {
    if (app && typeof app.exit === 'function') app.exit(code);
    else process.exit(code);
  });
}

async function main() {
  let electron = null;
  try {
    electron = require('electron');
  } catch {
    electron = null;
  }
  if (!electron || typeof electron !== 'object' || !electron.app) {
    emit({ ok: false, reason: 'The smoke test must run under Electron: npm run computer:smoke.' });
    exitNow(EXIT.failed, null);
    return;
  }
  const { app } = electron;
  let server = null;
  let code = EXIT.failed;
  try {
    const { createComputerBackend } = require('./index.cjs');
    server = await startOverlayServer();
    const origin = server.origin;
    const backend = createComputerBackend({
      electron,
      fake: false,
      overlayUrl: () => `${origin}/overlay.html`,
      getToken: () => '',
      theme: () => 'dark',
    });
    await app.whenReady();
    code = await runSmoke({ electron, backend, log: emit, platform: process.platform, pid: process.pid });
  } catch (err) {
    emit({ ok: false, reason: 'The smoke test could not start.', error: String(err?.message ?? err).slice(0, 200) });
    code = EXIT.failed;
  } finally {
    if (server) await server.close();
  }
  exitNow(code, app);
}

// Runs as a program (node, or electron for this file). A require from a test runs nothing.
const isEntry = require.main === module || typeof process.versions.electron === 'string';
if (isEntry) {
  if (process.env.PLENUM_SMOKE !== '1') {
    process.stdout.write(`${GUARD_MESSAGE}\n`, () => process.exit(EXIT.guard));
  } else {
    main();
  }
}

module.exports = { runSmoke, readPicture, placementOf, isMaskGrey, isMagenta, EXIT, TITLE, GUARD_MESSAGE, PERMISSION_HELP, GREEN, RED, setupPage, PAGE };
