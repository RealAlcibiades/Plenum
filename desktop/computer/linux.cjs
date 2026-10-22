'use strict';
// The Linux half of the computer-use backend: X11 only, through the xdotool program. UNVERIFIED on a real Linux desktop: it is
// written from xdotool's documentation and tested here with the program stubbed out (the unit tests check every argument list).
//
//  - Wayland is refused (XDG_SESSION_TYPE is "wayland", or WAYLAND_DISPLAY is set): under Wayland the window in front cannot be
//    read, so the allowed apps could not be enforced, and Plenum will not drive blind.
//  - Every command is execFile with a fixed argument list and the cleaned environment (env.cjs: no key, token or sign-in setting).
//    Typed text goes to xdotool on its standard input ("type --file -"), never on the command line, so it is not in a process
//    listing. Coordinates are physical pixels, which is what X11 uses.
//  - exe comes from readlink /proc/<pid>/exe; a window is elevated when its process belongs to another user (the uid in
//    /proc/<pid>/status differs from ours) or when the process cannot be read.
//  - xdotool gives no stacking order, so windows({ all: true }) is null and window-scope capture uses the window source.
//  - There is no way to see the person's keys: userInput().keys is always false. isSecureField() is null (cannot tell), so the start
//    card, the computer-use notice and the system text say that the password-field rule rests on the model here (hasPasswordGuard in
//    lib/computer/policy.mjs). AT-SPI (a focused element with the role password text) would close this; it needs a desktop to check on.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFile } = require('node:child_process');
const { CHAR_KEYSYMS } = require('./actions.cjs');
const { cleanEnv } = require('./env.cjs');

const WAYLAND_MESSAGE = 'Computer use needs an X11 session on Linux. Under Wayland Plenum cannot see which window has focus, so it cannot keep the model inside the apps you allowed. Log in with an X11 session, or use the in-app browser.';
const XDOTOOL_MESSAGE = 'Computer use on Linux needs xdotool. Install it with your package manager (for example: sudo apt install xdotool), then restart Plenum.';
const NO_DISPLAY_MESSAGE = 'Computer use needs an X11 display, and none is set (DISPLAY is empty).';

const BUTTONS = { left: '1', middle: '2', right: '3' };
const SCROLL_BUTTONS = { up: '4', down: '5', left: '6', right: '7' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- argument builders (pure; exported for the tests) ----------

// The xdotool spelling of a canonical key: names are already xdotool's; a character is its letter or digit, the keysym name of
// ASCII punctuation, or U+hex for anything else.
function keysymOf(key) {
  if ([...key].length !== 1) return key;
  if (/^[a-z0-9]$/i.test(key)) return key;
  if (Object.hasOwn(CHAR_KEYSYMS, key)) return CHAR_KEYSYMS[key];
  return `U${key.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

const comboOf = keys => keys.map(keysymOf).join('+');

const argv = Object.freeze({
  activeWindow: () => ['getactivewindow'],
  windowName: id => ['getwindowname', String(id)],
  windowPid: id => ['getwindowpid', String(id)],
  windowGeometry: id => ['getwindowgeometry', '--shell', String(id)],
  searchVisible: () => ['search', '--onlyvisible', '--name', '.'],
  mouseLocation: () => ['getmouselocation', '--shell'],
  mouseMove: (x, y) => ['mousemove', '--sync', String(x), String(y)],
  click: (button, count) => ['click', '--repeat', String(count), '--delay', '60', BUTTONS[button]],
  mouseDown: button => ['mousedown', BUTTONS[button]],
  mouseUp: button => ['mouseup', BUTTONS[button]],
  scroll: (direction, amount) => ['click', '--repeat', String(amount), '--delay', '15', SCROLL_BUTTONS[direction]],
  key: (keys, repeat = 1) => ['key', '--clearmodifiers', ...(repeat > 1 ? ['--repeat', String(repeat), '--delay', '40'] : []), comboOf(keys)],
  keyDown: key => ['keydown', keysymOf(key)],
  keyUp: key => ['keyup', keysymOf(key)],
  // The text itself is the standard input of this command.
  type: () => ['type', '--delay', '12', '--file', '-'],
  activate: id => ['windowactivate', '--sync', String(id)],
});

// "X=10\nY=20\nWIDTH=800\nHEIGHT=600" -> { X: 10, ... }
function parseShell(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(-?\d+)$/.exec(line.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// Whether the session is Wayland, from an environment.
function isWayland(env) {
  return String(env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' || !!env.WAYLAND_DISPLAY;
}

// ---------- the backend ----------

function defaultRun(file, args, { input, timeout = 5000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function createLinuxNative({
  run = defaultRun,
  env = process.env,
  fs = nodeFs,
  ownPid = process.pid,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : -1),
  wait = sleep,
} = {}) {
  const helperEnv = cleanEnv(env);
  const held = new Set();
  const heldButtons = new Set();
  let current = { cancelled: false };
  let lastCursor = null;
  let xdotool = null;

  function findXdotool() {
    if (xdotool) return xdotool;
    for (const dir of String(env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const file = nodePath.posix.join(dir, 'xdotool');
      try {
        fs.accessSync(file, nodeFs.constants.X_OK);
        xdotool = file;
        return file;
      } catch {
        // Not in this folder.
      }
    }
    return null;
  }

  async function tool(args, options = {}) {
    const file = findXdotool();
    if (!file) throw new Error('xdotool is not installed.');
    return run(file, args, { env: helperEnv, ...options });
  }

  // ---------- facts about windows ----------

  function processFacts(pid) {
    if (!pid) return { exe: '', elevated: false };
    let exe = '';
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return { exe: '', elevated: true };
    }
    let elevated = false;
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
      const me = getuid();
      elevated = !m || Number(m[1]) !== me || Number(m[2]) !== me;
    } catch {
      elevated = true;
    }
    return { exe, elevated };
  }

  async function describe(id) {
    const [name, pidText, geometry] = await Promise.all([
      tool(argv.windowName(id)).catch(() => ''),
      tool(argv.windowPid(id)).catch(() => ''),
      tool(argv.windowGeometry(id)).catch(() => ''),
    ]);
    const pid = Number.parseInt(String(pidText).trim(), 10) || 0;
    const g = parseShell(geometry);
    const facts = processFacts(pid);
    return {
      id: String(id),
      title: String(name).replace(/\r?\n$/, ''),
      exe: facts.exe,
      pid,
      elevated: facts.elevated,
      bounds: { x: g.X ?? 0, y: g.Y ?? 0, width: g.WIDTH ?? 0, height: g.HEIGHT ?? 0 },
      own: pid === ownPid,
      minimized: false,
    };
  }

  async function foreground() {
    let id;
    try {
      id = (await tool(argv.activeWindow())).trim();
    } catch {
      return null;
    }
    if (!/^\d+$/.test(id)) return null;
    const w = await describe(id);
    return { id: w.id, title: w.title, exe: w.exe, pid: w.pid, elevated: w.elevated, bounds: w.bounds, own: w.own };
  }

  async function windows({ all = false } = {}) {
    if (all) return null;
    let ids;
    try {
      ids = (await tool(argv.searchVisible())).split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
    } catch {
      return [];
    }
    const out = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = await Promise.all(ids.slice(i, i + 8).map(describe));
      for (const w of batch) if (w.title && w.bounds.width >= 10 && w.bounds.height >= 10) out.push(w);
    }
    return out;
  }

  async function cursor() {
    const g = parseShell(await tool(argv.mouseLocation()));
    return { x: g.X ?? 0, y: g.Y ?? 0 };
  }

  // ---------- input ----------

  const checkLive = token => {
    if (token.cancelled) throw Object.assign(new Error('stopped'), { stopped: true });
  };

  async function pause(ms, token) {
    let left = ms;
    while (left > 0) {
      checkLive(token);
      const slice = Math.min(left, 50);
      await wait(slice);
      left -= slice;
    }
    checkLive(token);
  }

  async function keysDown(keys) {
    for (const k of keys) {
      await tool(argv.keyDown(k));
      held.add(k);
    }
  }

  async function keysUp(keys) {
    for (const k of [...keys].reverse()) {
      try {
        await tool(argv.keyUp(k));
      } finally {
        held.delete(k);
      }
    }
  }

  async function withModifiers(mods, fn) {
    try {
      await keysDown(mods);
      return await fn();
    } finally {
      await keysUp(mods.filter(m => held.has(m))).catch(() => {});
    }
  }

  async function release() {
    current.cancelled = true;
    for (const k of [...held]) {
      try {
        await tool(argv.keyUp(k));
      } catch {
        // Nothing more can be done.
      }
      held.delete(k);
    }
    for (const b of [...heldButtons]) {
      try {
        await tool(argv.mouseUp(b));
      } catch {
        // Nothing more can be done.
      }
      heldButtons.delete(b);
    }
  }

  async function perform(a, token) {
    switch (a.kind) {
      case 'move':
        await tool(argv.mouseMove(a.x, a.y));
        break;
      case 'click':
        await withModifiers(a.modifiers ?? [], async () => {
          if (typeof a.x === 'number') await tool(argv.mouseMove(a.x, a.y));
          await tool(argv.click(a.button, a.count));
        });
        break;
      case 'down':
        await tool(argv.mouseDown(a.button));
        heldButtons.add(a.button);
        break;
      case 'up':
        await tool(argv.mouseUp(a.button));
        heldButtons.delete(a.button);
        break;
      case 'drag':
        await withModifiers(a.modifiers ?? [], async () => {
          await tool(argv.mouseMove(a.from.x, a.from.y));
          await pause(30, token);
          await tool(argv.mouseDown('left'));
          heldButtons.add('left');
          try {
            const steps = Math.max(4, Math.min(40, Math.round(Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) / 20)));
            for (let i = 1; i <= steps; i++) {
              await tool(argv.mouseMove(Math.round(a.from.x + ((a.to.x - a.from.x) * i) / steps), Math.round(a.from.y + ((a.to.y - a.from.y) * i) / steps)));
              await pause(8, token);
            }
          } finally {
            await tool(argv.mouseUp('left'));
            heldButtons.delete('left');
          }
        });
        break;
      case 'scroll':
        if (typeof a.x === 'number') await tool(argv.mouseMove(a.x, a.y));
        await tool(argv.scroll(a.direction, a.amount));
        break;
      case 'type':
        await tool(argv.type(), { input: a.text, timeout: 20000 + a.text.length * 30 });
        break;
      case 'key':
        await tool(argv.key(a.keys, a.repeat), { timeout: 5000 + a.repeat * 100 });
        break;
      case 'hold':
        try {
          await keysDown(a.keys);
          await pause(a.ms, token);
        } finally {
          await keysUp(a.keys.filter(k => held.has(k))).catch(() => {});
        }
        break;
      default:
        throw Object.assign(new Error('That action is not one the desktop can inject.'), { unsupported: true });
    }
  }

  return {
    platform: 'linux',

    async probe() {
      if (isWayland(env)) return { supported: false, reason: WAYLAND_MESSAGE, permissions: { screen: 'n/a', input: 'n/a' }, wayland: true, tools: { xdotool: findXdotool() } };
      if (!env.DISPLAY) return { supported: false, reason: NO_DISPLAY_MESSAGE, permissions: { screen: 'n/a', input: 'n/a' }, wayland: false, tools: { xdotool: findXdotool() } };
      const found = findXdotool();
      if (!found) return { supported: false, reason: XDOTOOL_MESSAGE, permissions: { screen: 'n/a', input: 'n/a' }, wayland: false, tools: { xdotool: null } };
      return { supported: true, reason: '', permissions: { screen: 'n/a', input: 'n/a' }, wayland: false, tools: { xdotool: found } };
    },

    windows,
    foreground,
    cursor,

    async focus(windowId) {
      const id = String(windowId);
      if (!/^\d+$/.test(id)) return { ok: false, reason: 'no-focus', message: 'That window is gone.' };
      try {
        await tool(argv.activate(id), { timeout: 4000 });
      } catch {
        return { ok: false, reason: 'no-focus', message: 'The window manager did not bring that window to the front.' };
      }
      const now = await foreground();
      return now && now.id === id ? { ok: true } : { ok: false, reason: 'no-focus', message: 'The window manager did not bring that window to the front.' };
    },

    async isSecureField() {
      return null;
    },

    async userInput() {
      const here = await cursor().catch(() => null);
      const mouse = here !== null && lastCursor !== null && Math.hypot(here.x - lastCursor.x, here.y - lastCursor.y) > 3;
      lastCursor = here;
      return { mouse, keys: false };
    },

    watch() {},

    async input(action) {
      const token = { cancelled: false };
      current = token;
      try {
        await perform(action, token);
        return { ok: true };
      } catch (err) {
        await release();
        if (err?.unsupported) return { ok: false, reason: 'unsupported', message: err.message };
        if (err?.stopped) return { ok: false, reason: 'blocked', message: 'The action was stopped.' };
        return { ok: false, reason: 'blocked', message: 'xdotool could not send the input.' };
      } finally {
        lastCursor = await cursor().catch(() => null);
      }
    },

    release,

    close() {
      return release();
    },
  };
}

module.exports = { createLinuxNative, argv, keysymOf, parseShell, isWayland, WAYLAND_MESSAGE, XDOTOOL_MESSAGE, NO_DISPLAY_MESSAGE };
