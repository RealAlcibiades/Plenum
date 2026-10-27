// Regression for the phone layer's harness (mob-18). One sealed server and one hidden Electron window serve every phase:
//   1. the desktop UI at phone size (390 x 844, DPR 3, touch, data-surface="phone"): every public/ext-*.js panel registers, zero console errors;
//   2. the same UI at desktop size (1280 x 800, no marker): the same checks;
//   3. the bridge: the Bridge in loopback LAN mode serves the fixture page at /p/<pathKey>/; pairing through the link's fragment, the
//      phone's IKpsk2 handshake, the confirm route; every state is shot in light and dark, zero console errors;
//   4. the run leaves no process behind and finishes in under 90 s.
// The panel count is read at run time from this copy's public/ folder (44 in this build; the plan said 43 and more arrive in waves 14-18).
// Run it through the sealed runner (never from the project folder):
//   node build/mobile/run.mjs --id mob-18-phone-size-harness regression.test.mjs
// Screenshots: C:/t/mob/*.png, read back by the builder and reviewed by Fable.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DESKTOP_VIEW, ELECTRON, PHONE_VIEW, startPhoneHarness, trace } from './harness/phone-window.mjs';
import { makeAppCopy, removeAppCopy, until } from './helpers/sealed-server.mjs';

const HERE = import.meta.dirname;
// The harness runs only in the sealed Windows runner with Electron installed (phone-window.mjs assertSealed refuses everywhere else). Outside
// it the suites are skipped with a reason, so `node --test mobile/test/` on another system is not red. The node --check test always runs.
const CAN_RUN = process.platform === 'win32'
  && process.env.MOBILE_SEALED === '1'
  && /\/build\/mobile\/src-[^/]+$/.test(APP_ROOT.split(path.sep).join('/'))
  && existsSync(ELECTRON);
const SKIP = CAN_RUN ? false : 'sealed Windows runner with Electron only (node build/mobile/run.mjs --id <name> regression.test.mjs)';
const CHECKS = path.join(HERE, 'helpers', 'phone-checks.js');
const HARNESS_SCRIPTS = [
  path.join(HERE, 'harness', 'phone-window.mjs'),
  path.join(HERE, 'harness', 'electron-main.cjs'),
  path.join(HERE, 'harness', 'preload.cjs'),
  path.join(HERE, 'harness', 'capacitor-stub.js'),
  path.join(HERE, 'harness', 'fixture', 'fixture.js'),
  path.join(HERE, 'helpers', 'phone-checks.js'),
];
const STATES = ['pairing', 'code', 'connected', 'approval', 'stop-pressed', 'offline', 'reconnecting'];
const MAX_MS = 90_000;

let h = null;
let app = null;
const shots = [];
const started = Date.now();

async function assertNoConsoleErrors(label) {
  const logs = await h.logs();
  assert.deepEqual(logs.errors, [], `${label}: console errors`);
  assert.deepEqual(logs.pageErrors, [], `${label}: uncaught page errors`);
}

async function assertPanels(label) {
  const panels = await h.panels();
  assert.ok(panels.expected.length >= 43, `${label}: at least the 43 planned panels (found ${panels.expected.length})`);
  assert.deepEqual(panels.missing, [], `${label}: panels that did not load`);
  assert.deepEqual(panels.extra, [], `${label}: loaded panels that are not in public/`);
  assert.equal(panels.registered.length, panels.expected.length, `${label}: every panel registers`);
  assert.equal(panels.serverListMatches, true, `${label}: /api/ext-modules lists the same panels as public/`);
  assert.equal(panels.museUi, true, `${label}: window.MuseUI exists`);
  return panels;
}

before(async () => {
  if (!CAN_RUN) return;
  trace('regression: before');
  // A private app folder: the fixture page this suite serves at /p/<pathKey>/ is its own, so another suite's shell build cannot replace it.
  app = await makeAppCopy('regression');
  h = await startPhoneHarness({ name: 'regression', appRoot: app });
});

after(async () => {
  if (h && !h.closed) {
    const report = await h.close();
    trace(`regression: after close leftover=${report.leftover.length}`);
  }
  if (app) removeAppCopy(app);
});

test('the harness scripts parse with node --check before anything runs them', () => {
  for (const file of HARNESS_SCRIPTS) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `node --check ${path.basename(file)}: ${r.stderr}`);
  }
});

describe('phone surface: the desktop UI at 390 x 844', { timeout: 120_000, skip: SKIP }, () => {
  test('data-surface is phone, every ext panel registers, no console error, light and dark', async () => {
    await h.openApp({ view: PHONE_VIEW, surface: 'phone', theme: 'light' });
    assert.equal(await h.eval('document.documentElement.dataset.surface'), 'phone');
    assert.equal(await h.eval('window.plenumShell?.desktop === true'), true, 'the desktop shim is in place');
    assert.equal(await h.eval('window.Capacitor?.isNativePlatform() === true'), true, 'the Capacitor stub is in place');
    const panels = await assertPanels('phone');
    await assertNoConsoleErrors('phone light');
    const light = await h.shot('ui-phone-light');
    shots.push(light);
    assert.equal(light.width, 1170, 'the screenshot is 390 CSS px at DPR 3');
    assert.equal(light.height, 2532);
    await h.evalFile(CHECKS);
    const audit = await h.eval('plenumPhoneChecks.audit()');
    trace(`phone audit ${JSON.stringify(audit).slice(0, 200)}`);
    console.log(`phone surface: ${panels.registered.length} of ${panels.expected.length} panels registered; audit ${JSON.stringify(audit)}`);
    await h.theme('dark');
    const dark = await h.shot('ui-phone-dark');
    shots.push(dark);
    await assertNoConsoleErrors('phone dark');
  });
});

describe('desktop surface: the same UI at 1280 x 800, no phone marker', { timeout: 120_000, skip: SKIP }, () => {
  test('no data-surface marker, every ext panel registers, no console error', async () => {
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop', theme: 'light' });
    assert.equal(await h.eval('document.documentElement.dataset.surface ?? null'), null, 'the desktop surface gets no marker');
    const panels = await assertPanels('desktop');
    await assertNoConsoleErrors('desktop');
    const shot = await h.shot('ui-desktop-light');
    shots.push(shot);
    assert.equal(shot.width, 1280);
    assert.equal(shot.height, 800);
    console.log(`desktop surface: ${panels.registered.length} of ${panels.expected.length} panels registered`);
  });
});

describe('bridge: the fixture page at /p/<pathKey>/, pairing through the link and the confirm route', { timeout: 120_000, skip: SKIP }, () => {
  test('pairing: the link fragment is cleared, the phone pairs, Allow connects, and every state is shot in light and dark', async () => {
    const b = await h.enableBridge();
    assert.match(b.pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/$/);
    await h.openFixture(b.link, { theme: 'light' });
    // The page clears the fragment as soon as its script has read it; on a loaded machine that is a moment after the load event.
    await until(async () => !(await h.eval('location.href')).includes('pair='), 'the pairing secret to leave the address bar', 2000, 20);
    const href = await h.eval('location.href');
    assert.equal(href.includes('pair='), false, 'the pairing secret left the address bar');
    await until(async () => (await h.eval('document.body.dataset.screen')) === 'pairing', 'the pairing screen', 2000, 20);
    assert.equal(await h.eval('document.body.dataset.screen'), 'pairing');
    assert.equal(await h.eval('window.plenumFixture.pairFragmentSeen'), true, 'the page read the fragment');
    const html = await h.eval('document.documentElement.outerHTML');
    assert.equal(html.includes(b.payload.psk), false, 'the pre-shared key is not in the page');
    shots.push(await h.shot('fx-pairing-light'));

    const p = await h.phonePair({ name: "Will's iPhone" });
    assert.match(p.code, /^\d{6}$/, 'the phone shows six digits');
    await h.fixture('code', { code: p.code });
    shots.push(await h.shot('fx-code-light'));

    await h.confirmPairing();
    const hello = await p.hello;
    assert.equal(hello.deviceId, p.phone.id, 'HELLO after Allow');
    const state = await p.session.request('GET', '/api/state');
    assert.equal(state.status, 200, 'the paired phone reaches the desktop server through the Bridge');
    await h.fixture('connected', { device: "Will's iPhone", desktop: 'Test PC', carrier: 'Same network' });
    shots.push(await h.shot('fx-connected-light'));

    await h.fixture('approval', { command: 'git status' });
    shots.push(await h.shot('fx-approval-light'));

    const ack = await p.session.stop('0123abcd');
    const ackText = `in ${Math.round(ack.ms)} ms`;
    await h.fixture('stop-pressed', { ack: ackText });
    shots.push(await h.shot('fx-stop-light'));

    p.session.close();
    await h.fixture('offline', { lastSeen: 'a few minutes ago' });
    shots.push(await h.shot('fx-offline-light'));

    await h.fixture('reconnecting', {});
    shots.push(await h.shot('fx-reconnecting-light'));

    const again = h.track(await p.phone.connect(b.desktopPub, b.wsUrl));
    assert.equal(again.hello.deviceId, p.phone.id, 'Noise IK reconnect of the paired phone');
    await h.fixture('connected', { device: "Will's iPhone", desktop: 'Test PC', carrier: 'Same network' });
    shots.push(await h.shot('fx-connected-again-light'));

    await h.theme('dark');
    const dataFor = {
      pairing: {},
      code: { code: p.code },
      connected: { device: "Will's iPhone", desktop: 'Test PC', carrier: 'Same network' },
      approval: { command: 'git status' },
      'stop-pressed': { ack: ackText },
      offline: { lastSeen: 'a few minutes ago' },
      reconnecting: {},
    };
    for (const screen of STATES) {
      await h.fixture(screen, dataFor[screen]);
      shots.push(await h.shot(`fx-${screen}-dark`));
    }
    await assertNoConsoleErrors('bridge fixture');
    again.close();
  });
});

test('the run leaves no process behind, every screenshot exists, and it finished in under 90 s', { skip: SKIP }, async () => {
  for (const s of shots) {
    assert.ok(existsSync(s.path), `screenshot ${s.path} exists`);
    assert.ok(statSync(s.path).size > 1000, `screenshot ${s.path} is a real image`);
  }
  const report = await h.close();
  assert.deepEqual(report.leftover, [], 'no Electron or server process is left');
  assert.equal(report.serverExited, true, 'the sealed server exited');
  const total = Date.now() - started;
  trace(`regression: total ${total} ms, ${shots.length} screenshots`);
  console.log(`regression: ${shots.length} screenshots, ${total} ms, leftover ${report.leftover.length}`);
  assert.ok(total < MAX_MS, `the run took ${total} ms (limit ${MAX_MS} ms)`);
});
