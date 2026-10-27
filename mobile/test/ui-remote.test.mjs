// Settings > Phones (public/ext-remote.js) in the phone-size harness (mob-18): the section and the title-bar chip at 1280 and 480 px in
// light and dark; the chip from a presence event, with no close control, and its end; Same network turning on, saving and showing its
// strip; Remove and Remove all asking first with focus on Cancel; the phone surface hiding Add phone and the tier menus; Stop all and
// Test answering on their rows; and no console error. Screenshots go to C:/t/mob/ (remote-*.png), read back by the builder.
// Run it through the sealed runner, never from the project folder:
//   node build/mobile/run.mjs --id mob-07-panel ui-remote.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, DESKTOP_VIEW, ELECTRON, PHONE_VIEW, startPhoneHarness, trace } from './harness/phone-window.mjs';

// A failure in this test process ends it with an error on the console, never with a dialog on the owner's screen.
process.on('uncaughtException', e => {
  console.error(e);
  process.exitCode = 1;
});
process.on('unhandledRejection', e => {
  console.error(e);
  process.exitCode = 1;
});

const HERE = import.meta.dirname;
const CAN_RUN = process.platform === 'win32'
  && process.env.MOBILE_SEALED === '1'
  && /\/build\/mobile\/src-[^/]+$/.test(APP_ROOT.split(path.sep).join('/'))
  && existsSync(ELECTRON);
const SKIP = CAN_RUN ? false : 'sealed Windows runner with Electron only (node build/mobile/run.mjs --id <name> ui-remote.test.mjs)';
const NARROW_VIEW = Object.freeze({ width: 480, height: 800, dpr: 1, mobile: false, touch: false });
const HARNESS_SCRIPTS = [
  path.join(HERE, 'harness', 'phone-window.mjs'),
  path.join(HERE, 'harness', 'electron-main.cjs'),
  path.join(HERE, 'harness', 'preload.cjs'),
];
const SECTION = `document.querySelector('.settings-card[data-section="phones"]')`;
const started = Date.now();
const shots = [];
let h = null;

// Waits inside the page until a condition holds. The label names what was waited for, for the failure message.
async function waitIn(condition, label, ms = 10000) {
  // The label goes in as a JSON string literal, so an apostrophe or a quote in it cannot break the page code.
  const ok = await h.eval(`new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let hit = false;
      try { hit = Boolean(${condition}); } catch { hit = false; }
      if (hit) return resolve(true);
      if (Date.now() - t0 > ${ms}) return reject(new Error(${JSON.stringify(`timed out waiting for ${label}`)}));
      setTimeout(tick, 50);
    };
    tick();
  })`);
  assert.equal(ok, true, label);
}

async function openPhones() {
  await h.eval("window.MuseUI.openSettings('phones')");
  await waitIn(`${SECTION} && ${SECTION}.querySelector('.remote-root')`, 'the Phones section');
}

// The first state read of the page has landed, so a synthetic presence event is not overwritten by it.
async function firstRead() {
  await waitIn("performance.getEntriesByType('resource').some(e => e.name.includes('/api/phones') && !e.name.includes('/activity'))", 'the first state read');
  await new Promise(resolve => setTimeout(resolve, 1200));
}

async function assertNoConsoleErrors(label) {
  const logs = await h.logs();
  assert.deepEqual(logs.errors, [], `${label}: console errors`);
  assert.deepEqual(logs.pageErrors, [], `${label}: uncaught page errors`);
}

async function shot(name) {
  const s = await h.shot(name);
  shots.push(s);
  return s;
}

// Once per page: GET /api/phones answers pass through window.__g4patch when a test sets it (a page-side function that edits the state), and
// the paths the section posts to are listed in window.__g4posts. Only the page's stand-ins for MuseUI.request and MuseUI.api are wrapped.
async function probePhones() {
  await h.eval(`(() => {
    if (window.__g4probe) return true;
    window.__g4probe = true;
    window.__g4patch = null;
    window.__g4posts = [];
    const request = window.MuseUI.request;
    window.MuseUI.request = async (path, opts) => {
      const res = await request(path, opts);
      if (path !== '/api/phones' || !window.__g4patch || !res.ok) return res;
      const data = window.__g4patch(await res.json());
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = window.MuseUI.api;
    window.MuseUI.api = (path, body) => { window.__g4posts.push(path); return api(path, body); };
    return true;
  })()`);
}

// Makes the section read the state again (the page does this on a tier event).
const READ_AGAIN = "window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'tier' } }))";

// Opens the page at the section and scrolls it so the section's top is in the picture.
async function frameSection() {
  await h.eval(`(() => { ${SECTION}.scrollIntoView({ block: 'start' }); return true; })()`);
  await new Promise(resolve => setTimeout(resolve, 300));
}

before(async () => {
  if (!CAN_RUN) return;
  trace('ui-remote: before');
  h = await startPhoneHarness({ name: 'ui-remote' });
});

after(async () => {
  if (h && !h.closed) {
    const report = await h.close();
    trace(`ui-remote: after close leftover=${report.leftover.length}`);
  }
});

test('the harness scripts parse with node --check before anything runs them', () => {
  for (const file of HARNESS_SCRIPTS) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `node --check ${path.basename(file)}: ${r.stderr}`);
  }
});

// The LAN notice and the LAN web strip say the web page is sent as plain http (finding F1), so a person on a network they do not trust
// uses the app, Tailscale or the relay. The texts are read from the project as they are; no Electron is needed.
test('the phone-lan notice says the web page is sent as plain http with no claim that everything is encrypted, and the LAN strip says it is sent without encryption', async () => {
  const extSource = readFileSync(path.join(APP_ROOT, 'public', 'ext-remote.js'), 'utf8');
  const note = /"phone-lan": \{ tone: "warn", title: "[^"]*",\s*text: "([^"]*)" \}/.exec(extSource);
  assert.ok(note, 'the phone-lan notice is in public/ext-remote.js');
  assert.match(note[1], /^Plenum now listens on a port on this computer\./, 'the notice keeps its first sentence');
  assert.ok(note[1].includes('sent as plain http: someone on the same network could change it'), 'the notice says the web page is sent as plain http');
  assert.equal(note[1].includes('everything is encrypted'), false, 'the notice does not say everything is encrypted');
  assert.ok(note[1].length <= 450, `the phone-lan notice is ${note[1].length} characters (cap 450)`);
  const copy2 = await import(pathToFileURL(path.join(APP_ROOT, 'mobile', 'shell', 'screens', 'copy2.js')).href);
  assert.ok(copy2.LAN_WEB_STRIP.startsWith("This page works only on {computer}'s network"), 'the LAN strip keeps its first sentence');
  assert.ok(copy2.LAN_WEB_STRIP.includes('It is sent without encryption, so someone on this network could change it.'), 'the LAN strip says the page is sent without encryption');
  assert.match(copy2.LAN_WEB_STRIP, /use the Plenum app, Tailscale or your relay/, 'the LAN strip names the app, Tailscale and the relay');
});

// The chip is a floor item (MOBILE.json): ext.js loads this panel with the other known panels, and the panel's chip does not need the
// Settings page. Old code: ext-remote.js returned at once without MuseUI.settings, so no chip ever drew.
test('ext.js lists ext-remote right after ext-notices, so the chip loads with the known panels', () => {
  const extJs = readFileSync(path.join(APP_ROOT, 'public', 'ext.js'), 'utf8');
  const list = /const KNOWN = \[([^\]]*)\]/.exec(extJs);
  assert.ok(list, 'ext.js has a KNOWN list');
  const names = [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(names.includes('ext-remote'), 'ext-remote is in KNOWN');
  assert.equal(names.indexOf('ext-remote'), names.indexOf('ext-notices') + 1, 'ext-remote comes right after ext-notices');
});

// A stand-in element for the panel's document: it keeps textContent and the children it is given, and does nothing else.
function fakeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(), textContent: '', title: '', className: '', hidden: false, disabled: false, checked: false,
    value: '', dataset: {}, isConnected: true, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, remove() {},
    append(...items) { this.children.push(...items); }, replaceChildren() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

test('the chip appears from a presence event when MuseUI.settings is missing', async () => {
  const source = readFileSync(path.join(APP_ROOT, 'public', 'ext-remote.js'), 'utf8');
  const listeners = {};
  const slotted = [];
  const MuseUI = {
    ready: Promise.resolve(),
    request: async () => ({ status: 200, ok: true, json: async () => ({ devices: [], carriers: {} }) }),
    slots: {
      add: (name, id, value, order) => { slotted.push({ name, id, value, order }); return { remove() {} }; },
      remove: () => false,
    },
    ui: { chip: ({ label, title }) => Object.assign(fakeNode('button'), { textContent: label, title }) },
    toast() {},
    openSettings() {},
  };
  const context = {
    window: { MuseUI, addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); } },
    document: { createElement: tag => fakeNode(tag), documentElement: { dataset: {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  // The first state read lands (an empty list) before the event, as it does in the page.
  await new Promise(resolve => setTimeout(resolve, 50));
  for (const fn of listeners['plenum:event'] ?? []) fn({ detail: { type: 'phone', kind: 'presence', connected: [{ id: 'a1b2c3', name: "Will's iPhone", carrier: 'lan' }] } });
  const chip = slotted.find(s => s.name === 'titlebar' && s.id === 'phones');
  assert.ok(chip, 'the chip is put in the title bar slot');
  assert.equal(chip.value.textContent, "Phone connected: Will's iPhone", 'the chip names the phone');
});

describe('desktop, 1280 px, light: the section, its notices and the chip', { timeout: 120_000, skip: SKIP }, () => {
  test('the panel loads and registers, and the Phones section draws with its switches, Add phone and the notices', async () => {
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop', theme: 'light' });
    const panels = await h.panels();
    assert.ok(panels.registered.includes('ext-remote'), 'ext-remote registers');
    assert.deepEqual(panels.missing, [], 'every panel loads');
    await firstRead();
    await openPhones();
    assert.equal(await h.eval(`${SECTION}.querySelector('.remote-root [style]') === null`), true, 'no style attribute in the section');
    const labels = await h.eval(`[...${SECTION}.querySelectorAll('label.switch-row')].map(l => l.textContent.trim().split('\\n')[0])`);
    for (const word of ['Let phones connect', 'Same network', 'Any address', 'Tailscale', 'Your relay', 'Include the first line']) {
      assert.ok(labels.some(text => text.startsWith(word)), `a switch named ${word}`);
    }
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('button')].some(b => b.textContent === 'Add phone' && !b.hidden)`), true, 'Add phone is shown on the computer');
    for (const id of ['phone-pairing', 'phone-tailscale', 'phone-relay', 'phone-push']) {
      assert.equal(await h.eval(`Boolean(${SECTION}.querySelector('[data-notice="${id}"]'))`), true, `the ${id} notice is drawn`);
    }
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('button')].some(b => b.textContent === 'Deploy to Cloudflare')`), true, 'Deploy to Cloudflare is there');
    await frameSection();
    shots.push(await shot('remote-desk-1280-light-section'));
    await assertNoConsoleErrors('desktop 1280 light');
  });

  test('the title-bar chip appears from a presence event, has no close control, counts two phones, and goes when they leave', async () => {
    await h.eval(`window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'presence', connected: [{ id: 'a1b2c3', name: "Will's iPhone", carrier: 'lan' }] } }))`);
    await waitIn("document.querySelector('#titlebarSlot [data-slot-item=\"phones\"]')", 'the chip in the title bar');
    const chip = await h.eval(`(() => { const c = document.querySelector('#titlebarSlot [data-slot-item="phones"]'); return { tag: c.tagName, text: c.textContent, inner: c.querySelectorAll('button, [role="button"], .chip-x, [aria-label*="lose" i]').length, cls: c.className }; })()`);
    assert.equal(chip.tag, 'BUTTON');
    assert.equal(chip.text, "Phone connected: Will's iPhone");
    assert.equal(chip.inner, 0, 'the chip has no control inside it, so no close');
    assert.match(chip.cls, /remote-chip/);
    shots.push(await shot('remote-desk-1280-light-chip'));
    await h.eval(`window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'presence', connected: [{ id: 'a1b2c3', name: "Will's iPhone", carrier: 'lan' }, { id: 'd4e5f6', name: 'Work Pixel', carrier: 'tailscale' }] } }))`);
    await waitIn(`document.querySelector('#titlebarSlot [data-slot-item="phones"]').textContent === '2 phones connected'`, 'the two-phone chip');
    await h.eval(`window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'presence', connected: [] } }))`);
    await waitIn("!document.querySelector('#titlebarSlot [data-slot-item=\"phones\"]')", 'the chip to leave');
    await assertNoConsoleErrors('chip');
  });

  test('Same network: turning it on saves, shows its strip under the switch, and turning it off hides the strip again', async () => {
    await openPhones();
    const lanOn = `[...${SECTION}.querySelectorAll('label.switch-row')].find(l => l.textContent.startsWith('Same network')).querySelector('input')`;
    await h.eval(`(() => { ${lanOn}.click(); return true; })()`);
    await waitIn(`(() => { const n = ${SECTION}.querySelector('[data-notice="phone-lan"]'); return Boolean(n) && !n.parentElement.hidden; })()`, 'the phone-lan strip');
    await waitIn(`${SECTION}.querySelector('.setting-status') && [...${SECTION}.querySelectorAll('.setting-status')].some(s => s.textContent === 'Saved')`, 'Saved on the Same network row');
    const drawnNote = await h.eval(`${SECTION}.querySelector('[data-notice="phone-lan"]').textContent`);
    assert.match(drawnNote, /the web page a phone opens from this network is sent as plain http/, 'the phone-lan notice on screen says the web page is sent as plain http');
    assert.equal(drawnNote.includes('everything is encrypted'), false, 'the phone-lan notice on screen does not say everything is encrypted');
    const served = await h.server.get('/api/phones');
    assert.equal(served.body?.carriers?.lan?.on, true, 'the server stored Same network on');
    await frameSection();
    shots.push(await shot('remote-desk-1280-light-lan'));
    await h.eval(`(() => { ${lanOn}.click(); return true; })()`);
    await waitIn(`(() => { const n = ${SECTION}.querySelector('[data-notice="phone-lan"]'); return !n || n.parentElement.hidden; })()`, 'the phone-lan strip to hide');
    const off = await h.server.get('/api/phones');
    assert.equal(off.body?.carriers?.lan?.on, false, 'the server stored Same network off');
    await assertNoConsoleErrors('lan switch');
  });

  test('a paired phone shows its row, and Remove and Remove all ask first with focus on Cancel', async () => {
    const b = await h.enableBridge();
    assert.ok(b.link, 'the Bridge is on');
    await h.phonePair({ name: "Will's iPhone" });
    await h.confirmPairing();
    await openPhones();
    await waitIn(`[...${SECTION}.querySelectorAll('.remote-device .remote-name')].some(n => n.textContent === "Will's iPhone")`, "Will's iPhone in the list");
    const removeRow = `[...${SECTION}.querySelectorAll('.remote-device')].find(li => li.querySelector('.remote-name').textContent === "Will's iPhone").querySelector('button.ghost')`;
    await h.eval(`(() => { ${removeRow}.click(); return true; })()`);
    await waitIn("document.querySelector('dialog.confirm-dialog[open]')", 'the Remove question');
    assert.equal(await h.eval("document.activeElement?.textContent"), 'Cancel', 'Remove asks with focus on Cancel');
    await h.eval("[...document.querySelectorAll('dialog.confirm-dialog button')].find(b => b.textContent === 'Cancel').click()");
    await waitIn("!document.querySelector('dialog.confirm-dialog[open]')", 'the question to close');
    assert.equal(await h.eval(`${SECTION}.querySelectorAll('.remote-device').length`), 1, 'Cancel keeps the phone');
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('button')].find(x => x.textContent === 'Remove all').click(); return true; })()`);
    await waitIn("document.querySelector('dialog.confirm-dialog[open]')", 'the Remove all question');
    assert.equal(await h.eval("document.activeElement?.textContent"), 'Cancel', 'Remove all asks with focus on Cancel');
    await h.eval("[...document.querySelectorAll('dialog.confirm-dialog button')].find(b => b.textContent === 'Cancel').click()");
    await waitIn("!document.querySelector('dialog.confirm-dialog[open]')", 'the Remove all question to close');
    assert.equal(await h.eval(`${SECTION}.querySelectorAll('.remote-device').length`), 1, 'Cancel keeps every phone');
    await frameSection();
    shots.push(await shot('remote-desk-1280-light-devices'));
    await assertNoConsoleErrors('devices');
  });

  test('raising a phone to Full control asks first, Cancel puts the choice back with no request, and lowering asks nothing', async () => {
    await probePhones();
    await openPhones();
    const id = (await h.server.get('/api/phones')).body.devices.find(d => d.name === "Will's iPhone").id;
    const row = `[...${SECTION}.querySelectorAll('.remote-device')].find(li => li.querySelector('.remote-name').textContent === "Will's iPhone")`;
    const setTier = async tier => {
      const answer = await h.server.post('/api/phones/tier', { id, tier });
      assert.equal(answer.status, 200, `the computer set ${tier}`);
      await h.eval(READ_AGAIN);
    };
    await setTier('read');
    await waitIn(`${row} && ${row}.querySelector('select').value === 'read'`, 'the phone shows Read only');
    await h.eval(`(() => { const s = ${row}.querySelector('select'); s.value = 'full'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitIn("document.querySelector('dialog.confirm-dialog[open]')", 'the Full control question');
    const asked = await h.eval("(() => { const d = document.querySelector('dialog.confirm-dialog[open]'); return { title: d.querySelector('.confirm-title').textContent, body: d.querySelector('.confirm-body').textContent }; })()");
    assert.equal(asked.title, "Give Will's iPhone Full control?", 'the question names the phone and the tier');
    assert.ok(asked.body.startsWith('With Full control this phone can do everything this window can: start runs that edit files and run commands, use the browser and the computer, and change settings.'), 'the question says what Full control allows');
    await h.eval("[...document.querySelectorAll('dialog.confirm-dialog button')].find(b => b.textContent === 'Cancel').click()");
    await waitIn("!document.querySelector('dialog.confirm-dialog[open]')", 'the question to close');
    assert.equal(await h.eval(`${row}.querySelector('select').value`), 'read', 'Cancel puts Read only back');
    assert.equal(await h.eval("window.__g4posts.includes('/api/phones/tier')"), false, 'Cancel sends no tier change');
    await setTier('full');
    await waitIn(`${row} && ${row}.querySelector('select').value === 'full'`, 'the phone shows Full control');
    await h.eval(`(() => { const s = ${row}.querySelector('select'); s.value = 'approve'; s.dispatchEvent(new Event('change')); return true; })()`);
    await waitIn("window.__g4posts.includes('/api/phones/tier')", 'the lowering change sent');
    assert.equal(await h.eval("Boolean(document.querySelector('dialog.confirm-dialog[open]'))"), false, 'lowering asks nothing');
    assert.equal((await h.server.get('/api/phones')).body.devices.find(d => d.id === id).tier, 'approve', 'the computer stored Approve and watch');
    await h.eval("window.__g4patch = null");
  });

  test('a phone paired through the plain http web page reads Web page (plain http) on its row', async () => {
    await probePhones();
    await openPhones();
    await h.eval("window.__g4patch = d => { d.devices = d.devices.map(x => ({ ...x, app: 'lan-web' })); return d; }; true");
    await h.eval(READ_AGAIN);
    await waitIn(`[...${SECTION}.querySelectorAll('.remote-device .remote-meta')].some(m => m.textContent.startsWith('Web page (plain http). '))`, 'the Web page row');
    await h.eval("window.__g4patch = null");
    await h.eval(READ_AGAIN);
  });

  test("a relay that refused this computer says so, and New room asks first and then posts /api/phones/relay/new-room", async () => {
    await probePhones();
    await openPhones();
    await h.eval("window.__g4patch = d => { d.carriers = { ...(d.carriers ?? {}), relay: { on: true, reason: 'refused', connected: false, url: 'https://relay.example.workers.dev' } }; return d; }; true");
    await h.eval(READ_AGAIN);
    const words = 'Your relay turned this computer away. Someone else may have claimed this room. Start a new room to use the relay again.';
    await waitIn(`[...${SECTION}.querySelectorAll('p')].some(p => p.textContent === ${JSON.stringify(words)})`, 'the refused words');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('p')].some(p => p.textContent === 'refused')`), false, 'the raw word is not shown');
    await waitIn(`[...${SECTION}.querySelectorAll('button')].some(b => b.textContent === 'New room' && !b.hidden)`, 'the New room button');
    // The computer has no relay saved in this sealed run, so its answer would be a 409. The page is given that answer here, so the
    // refusal is shown as text and no network error is logged (the route itself is tested in the route suites).
    await h.eval("(() => { const inner = window.MuseUI.api; window.MuseUI.api = (path, body) => { if (path !== '/api/phones/relay/new-room') return inner(path, body); window.__g4posts.push(path); return Promise.reject(new Error('Save a relay address first.')); }; return true; })()");
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('button')].find(b => b.textContent === 'New room').click(); return true; })()`);
    await waitIn("document.querySelector('dialog.confirm-dialog[open]')", 'the New room question');
    assert.equal(await h.eval("document.querySelector('dialog.confirm-dialog[open] .confirm-title').textContent"), 'Start a new room?', 'New room asks first');
    assert.equal(await h.eval("window.__g4posts.includes('/api/phones/relay/new-room')"), false, 'nothing is sent before the answer');
    await h.eval("[...document.querySelectorAll('dialog.confirm-dialog button')].find(b => b.textContent === 'New room').click()");
    await waitIn("window.__g4posts.includes('/api/phones/relay/new-room')", 'the new room request');
    await waitIn(`[...${SECTION}.querySelectorAll('.setting-status')].some(s => s.textContent === 'Save a relay address first.' && s.classList.contains('bad'))`, 'the refusal shown in red');
    await h.eval("window.__g4patch = null");
  });

  test('Stop all and Test answer on their rows', async () => {
    await openPhones();
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('button')].find(x => x.textContent === 'Stop all').click(); return true; })()`);
    await waitIn(`[...${SECTION}.querySelectorAll('.setting-status')].some(s => s.textContent.startsWith('Stopped.'))`, 'the Stop all answer');
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('button')].find(x => x.textContent === 'Test').click(); return true; })()`);
    await waitIn(`[...${SECTION}.querySelectorAll('.setting-status')].some(s => /test|No phone/.test(s.textContent))`, 'the Test answer');
    await assertNoConsoleErrors('stop and test');
  });
});

// Under plain node (no desktop window) the pairing is answered in this panel: the code and the phone's name are shown, and Allow or
// Deny is the answer. The phone sim pairs through the sealed server's own route, so the page's Allow is the thing under test.
describe('plain node, 1280 px: a phone waiting is answered in this panel', { timeout: 120_000, skip: SKIP }, () => {
  test('the code and the phone name show with Allow and Deny (Deny focused); Allow adds the phone and the pairing ends allowed', async () => {
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop', theme: 'light' });
    await firstRead();
    await openPhones();
    const b = await h.enableBridge();
    assert.ok(b.link, 'the Bridge is on');
    const phone = await h.phonePair({ name: 'Plain node phone' });
    await waitIn(`(() => { const row = ${SECTION}.querySelector('.remote-answer'); return Boolean(row) && !row.hidden; })()`, 'the Allow row');
    const shown = await h.eval(`(() => ({
      focus: document.activeElement?.textContent ?? '',
      code: ${SECTION}.querySelector('.remote-offer-code').textContent,
      title: ${SECTION}.querySelector('.remote-offer-title').textContent,
    }))()`);
    assert.equal(shown.focus, 'Deny', 'Deny has the focus, so an Enter does not allow by accident');
    assert.equal(shown.code.replace(/\D/g, ''), phone.code, 'the panel shows the code the phone shows');
    assert.match(shown.title, /Plain node phone/, 'the panel names the phone that waits');
    await frameSection();
    shots.push(await shot('remote-desk-1280-light-plain-allow'));
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('.remote-answer button')].find(x => x.textContent === 'Allow').click(); return true; })()`);
    await waitIn(`[...${SECTION}.querySelectorAll('.remote-device .remote-name')].some(n => n.textContent === 'Plain node phone')`, 'the new phone in the list');
    assert.equal(await h.eval(`${SECTION}.querySelector('.remote-offer-title').textContent`), 'A phone is paired.', 'the pairing ends allowed');
    assert.equal(await h.eval(`${SECTION}.querySelector('.remote-answer').hidden`), true, 'the Allow row is gone once allowed');
    const served = await h.server.get('/api/phones');
    assert.equal((served.body?.devices ?? []).some(d => d.name === 'Plain node phone'), true, 'the server stored the phone');
    await assertNoConsoleErrors('plain node allow');
  });
});

describe('phone surface, 390 px: Add phone and the tier menus are hidden', { timeout: 120_000, skip: SKIP }, () => {
  test('the section shows the paired phone with its tier as text, and no Add phone or tier menu', async () => {
    await h.openApp({ view: PHONE_VIEW, surface: 'phone', theme: 'light' });
    assert.equal(await h.eval('document.documentElement.dataset.surface'), 'phone');
    await firstRead();
    await openPhones();
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('button')].find(b => b.textContent === 'Add phone').hidden`), true, 'Add phone is hidden');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('.remote-tier')].every(el => el.hidden)`), true, 'every tier menu is hidden');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('.remote-tier-text')].every(el => !el.hidden && el.textContent.length > 0)`), true, 'each tier shows as text');
    // Each paired phone shows its tier as text (the plain-node test above pairs a second phone, so every row is counted).
    const phones = await h.eval(`${SECTION}.querySelectorAll('.remote-device').length`);
    assert.ok(phones >= 1, 'a paired phone is listed');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('.remote-device .remote-tier-text')].length`), phones, 'each paired phone shows its tier');
    await frameSection();
    shots.push(await shot('remote-phone-390-light-section'));
    await assertNoConsoleErrors('phone surface light');
  });

  test('the phone says only the computer changes how phones reach it, and its ways, power, relay and expiry controls are off', async () => {
    await openPhones();
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('p.remote-help')].some(p => p.textContent === 'Only the computer can change how phones reach it. Use Settings › Phones there.' && !p.hidden)`), true, 'the computer-only line shows');
    for (const label of ['Let phones connect', 'Same network', 'Any address', 'Tailscale', 'Your relay']) {
      assert.equal(await h.eval(`(() => { const l = [...${SECTION}.querySelectorAll('label.switch-row')].find(x => x.textContent.startsWith(${JSON.stringify(label)})); return Boolean(l) && l.querySelector('input').disabled; })()`), true, `${label} is off on the phone`);
    }
    assert.equal(await h.eval(`${SECTION}.querySelector('input[type="url"]').disabled`), true, 'the relay address is off on the phone');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('button')].find(b => b.textContent === 'Save address').disabled`), true, 'Save address is off on the phone');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === 'After 30 days')).disabled`), true, 'auto-expiry is off on the phone');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('button')].find(b => b.textContent === 'Remove all').hidden`), true, 'Remove all is hidden on the phone');
    assert.equal(await h.eval(`(() => { const b = [...${SECTION}.querySelectorAll('button')].find(x => x.textContent === 'New room'); return !b || b.hidden; })()`), true, 'New room is hidden on the phone');
  });

  test('dark: the phone surface keeps the same rules and logs no error', async () => {
    await h.theme('dark');
    await frameSection();
    shots.push(await shot('remote-phone-390-dark-section'));
    await assertNoConsoleErrors('phone surface dark');
  });
});

// A computer whose server says it is not plain node (the desktop app's window answers pairing, not this panel): the code and the link
// that the server sends are not drawn here.
describe('desktop, 1280 px: with the desktop window answering, this panel shows no pairing code or link', { timeout: 120_000, skip: SKIP }, () => {
  test('a code the server sends is not drawn, and the link that Add phone gets is not offered as Copy link', async () => {
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop', theme: 'light' });
    await firstRead();
    await probePhones();
    await openPhones();
    await h.eval("window.__g4patch = d => { d.plainNode = false; d.offer = { state: 'confirm', expiresInS: 100, code: '482913', device: { name: \"Will's iPhone\" } }; return d; }; true");
    await h.eval(READ_AGAIN);
    await waitIn(`${SECTION}.querySelector('.remote-offer-title').textContent === 'A phone is waiting'`, 'the pairing words');
    assert.equal(await h.eval(`${SECTION}.querySelector('.remote-offer-code').hidden`), true, 'the code is not drawn here');
    assert.equal(await h.eval(`${SECTION}.querySelector('.remote-offer-code').textContent`), '', 'the code text is empty');
    await h.eval("window.__g4patch = d => { d.plainNode = false; d.offer = null; return d; }; true");
    await h.eval(READ_AGAIN);
    await waitIn(`!${SECTION}.querySelector('.remote-offer-title').textContent`, 'the offer to clear');
    // The server's Add phone answer carries a link here, so the panel has one to show or to leave out.
    await h.eval("(() => { const inner = window.MuseUI.api; window.MuseUI.api = (path, body) => path === '/api/phones/pair/start' ? Promise.resolve({ state: 'offer', expiresInS: 120, link: 'https://example.invalid/pair#pair=x' }) : inner(path, body); return true; })()");
    await h.eval(`(() => { [...${SECTION}.querySelectorAll('button')].find(b => b.textContent === 'Add phone').click(); return true; })()`);
    await waitIn(`${SECTION}.querySelector('.remote-offer-title').textContent === 'Look at the window on your computer'`, 'the window words');
    assert.equal(await h.eval(`[...${SECTION}.querySelectorAll('.remote-offer button')].find(b => b.textContent === 'Copy link').hidden`), true, 'Copy link is not offered here');
    assert.equal(await h.eval(`${SECTION}.textContent.includes('example.invalid')`), false, 'the link is not drawn here');
    await h.eval("window.__g4patch = null");
  });
});

describe('desktop at 480 px and 1280 px in dark: the section fits its width', { timeout: 120_000, skip: SKIP }, () => {
  test('480 px light: every element of the section sits inside its width', async () => {
    await h.openApp({ view: NARROW_VIEW, surface: 'desktop', theme: 'light' });
    await firstRead();
    await openPhones();
    const overflow = await h.eval(`(() => { const root = document.querySelector('.settings-card[data-section="phones"] .remote-root'); const right = root.getBoundingClientRect().right; return [...root.querySelectorAll('*')].filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > right + 1).map(el => el.className || el.tagName).slice(0, 5); })()`);
    assert.deepEqual(overflow, [], 'nothing in the section runs past its right edge');
    await frameSection();
    shots.push(await shot('remote-desk-480-light-section'));
    await assertNoConsoleErrors('480 light');
  });

  test('480 px dark: the section and the chip draw with no error', async () => {
    await h.theme('dark');
    await frameSection();
    await h.eval(`window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'presence', connected: [{ id: 'a1b2c3', name: "Will's iPhone", carrier: 'lan' }] } }))`);
    await waitIn("document.querySelector('#titlebarSlot [data-slot-item=\"phones\"]')", 'the chip at 480 px');
    // The chip keeps to a short word here and sits inside the window, so the title bar does not run past its edge.
    const fit = await h.eval(`(() => { const c = document.querySelector('#titlebarSlot [data-slot-item="phones"]'); return { right: c.getBoundingClientRect().right, width: window.innerWidth, text: c.textContent }; })()`);
    assert.ok(fit.right <= fit.width, `the chip ends inside the window at 480 px (right ${fit.right}, window ${fit.width})`);
    assert.equal(fit.text, 'Phone', 'the chip keeps to a short word at 480 px');
    // A toast from the connect can cover the title bar for a moment: once it has gone, the chip is the element at its centre.
    await new Promise(resolve => setTimeout(resolve, 4500));
    const top = await h.eval(`(() => { const c = document.querySelector('#titlebarSlot [data-slot-item="phones"]'); const r = c.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(hit) && (hit === c || c.contains(hit)); })()`);
    assert.equal(top, true, 'the chip is not covered at 480 px');
    shots.push(await shot('remote-desk-480-dark-section'));
    await h.eval(`window.dispatchEvent(new CustomEvent('plenum:event', { detail: { type: 'phone', kind: 'presence', connected: [] } }))`);
    await assertNoConsoleErrors('480 dark');
  });

  test('1280 px dark: the section draws with no error', async () => {
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop', theme: 'dark' });
    await firstRead();
    await openPhones();
    await frameSection();
    shots.push(await shot('remote-desk-1280-dark-section'));
    await assertNoConsoleErrors('1280 dark');
  });
});

test('the run leaves no process behind, every screenshot exists, and it finished in under 180 s', { skip: SKIP }, async () => {
  for (const s of shots) {
    assert.ok(existsSync(s.path), `screenshot ${s.path} exists`);
    assert.ok(statSync(s.path).size > 1000, `screenshot ${s.path} is a real image`);
  }
  const report = await h.close();
  assert.deepEqual(report.leftover, [], 'no Electron or server process is left');
  assert.equal(report.serverExited, true, 'the sealed server exited');
  const total = Date.now() - started;
  trace(`ui-remote: total ${total} ms, ${shots.length} screenshots`);
  console.log(`ui-remote: ${shots.length} screenshots, ${total} ms, leftover ${report.leftover.length}`);
  assert.ok(total < 180_000, `the run took ${total} ms (limit 180000 ms)`);
});
