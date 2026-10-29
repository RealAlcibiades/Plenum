// The shell screens of part 1 (mob-10, wave 106; MOBILE-UI 6, 9, 14 and 16.3 S-01 to S-09).
//
// Two parts. The pure part (routing, copy, formatting) runs in Node. The page part builds the shell with the real build
// (scripts/build-mobile.mjs, which emits screens.js) into a private app folder of this copy, serves its mobile/www on 127.0.0.1 and draws every screen in the phone-size
// harness (mobile/test/harness, one hidden Electron window) at 390 x 844 and 360 x 780, light and dark, with the 16.1 safe areas.
// Screenshots go to C:/t/mob/ (mob10-<screen>-<width>-<theme>.png). Run it through the sealed runner:
//   node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-10-shell-screens-part-1 shell-screens.test.mjs

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ELECTRON, PHONE_VIEW, startPhoneHarness } from './harness/phone-window.mjs';
import { makeAppCopy, removeAppCopy } from './helpers/sealed-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHELL = path.join(ROOT, 'mobile', 'shell');
const SCREENS = path.join(SHELL, 'screens');
const url = name => pathToFileURL(path.join(SCREENS, name)).href;

const VIEWS = Object.freeze([
  { width: 390, height: 844, dpr: 3, mobile: true, touch: true, safe: [47, 0, 34, 0], label: '390' },
  { width: 360, height: 780, dpr: 3, mobile: true, touch: true, safe: [24, 0, 48, 0], label: '360' },
]);
const THEMES = Object.freeze(['light', 'dark']);

// The page part needs the sealed runner on Windows with Electron. Anywhere else (the project folder, CI) it is skipped before the
// build runs, so a run from the project folder never writes mobile/www or relay/public.
const CAN_RUN = process.platform === 'win32'
  && process.env.MOBILE_SEALED === '1'
  && /\/build\/mobile\/src-[^/]+$/.test(ROOT.split(path.sep).join('/'))
  && existsSync(ELECTRON);
const PAGE_SKIP = CAN_RUN ? false : 'sealed Windows runner with Electron only (node build/mobile/run.mjs --id mob-10-shell-screens-part-1 shell-screens.test.mjs)';

// Stop is present on these screens (MOBILE-UI 9.1: a session exists). Lock screens show their own stop, not the floating one.
const STOP_PRESENT = new Set(['connecting', 'failed', 'loading', 'update-app', 'update-desktop', 'ui-failed']);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

// ---------- the pure part ----------

const copy = await import(url('copy.js'));
const route = await import(url('route.js'));
const fixtures = await import(url('fixtures.js'));
const views = await import(url('views.js'));
const flows = await import(url('flows.js'));
const settings = await import(url('settings.js'));
const main = await import(url('main.js'));

describe('routing and copy (Node, no browser)', () => {
  test('the 22 part 1 screens are in the copy deck and each has a builder', () => {
    assert.equal(copy.SCREEN_IDS.length, 22);
    assert.deepEqual([...copy.SCREEN_IDS].sort(), Object.keys(views.SCREEN_BUILDERS).sort());
  });

  test('no screen is chosen while the computer list or the connected UI owns the page', () => {
    const connected = { computers: [{ id: 'a', name: 'Home PC' }], activeId: 'a', hello: { desktopName: 'Home PC' }, connection: { status: 'connected' } };
    assert.equal(route.screenFor(connected, {}), null);
    assert.equal(route.screenFor({ computers: [{ id: 'a' }, { id: 'b' }], activeId: null, connection: {} }, {}), null);
  });

  test('welcome with no computer; the navigation record picks consent, how, paste and scan', () => {
    const empty = { computers: [], connection: {}, pairing: null };
    assert.equal(route.screenFor(empty, {}), 'welcome');
    assert.equal(route.screenFor(empty, { screen: 'consent' }), 'consent');
    assert.equal(route.screenFor(empty, { screen: 'paste' }), 'paste');
  });

  test('pairing states map to code, mismatch, denied, expired; a pasted bad link goes to paste with its error', () => {
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm', code: '482913' } }, {}), 'code');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm' } }, { codeExpired: true }), 'expired');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm' } }, { forced: 'mismatch' }), 'mismatch');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'mismatch' } }, {}), 'mismatch');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'denied' } }, {}), 'denied');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'expired' } }, {}), 'expired');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'failed', reason: 'not-plenum' } }, {}), 'paste');
    assert.equal(route.pasteError({ state: 'failed', reason: 'expired' }), 'expired');
    assert.equal(route.pasteError({ state: 'failed', reason: 'not-plenum' }), 'not-plenum');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'failed', reason: 'no-carrier' } }, {}), 'failed');
  });

  test('lock, revoked, update and onboarding states come before the navigation record', () => {
    assert.equal(route.screenFor({ locked: true, lock: { mode: 'biometric' }, computers: [{ id: 'a' }] }, {}), 'lock-bio');
    assert.equal(route.screenFor({ locked: true, lock: { mode: 'pin' }, computers: [{ id: 'a' }] }, {}), 'lock-pin');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], connection: { status: 'revoked' } }, { screen: 'how' }), 'revoked');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], connection: { status: 'update-app' } }, {}), 'update-app');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], connection: { status: 'update-desktop' } }, {}), 'update-desktop');
    // B-121: three rounds of 'this computer does not know the phone' (not-known) show the revoked screen, with a computer listed.
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'not-known' } }, {}), 'revoked');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'reconnecting' } }, {}), 'connecting');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'connected' } }, { onboarding: ['paired-lock', 'paired-notify'] }), 'paired-lock');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'connecting' } }, {}), 'connecting');
    assert.equal(route.screenFor({ computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'offline' } }, {}), 'failed');
  });

  test('the code countdown runs from 2:00 and the expiry is 120 seconds after the code first showed', () => {
    assert.equal(route.codeSecondsLeft(1000, 1000), 120);
    assert.equal(route.codeSecondsLeft(1000, 13000), 108);
    assert.equal(route.codeSecondsLeft(1000, 121000), 0);
    assert.equal(copy.clock(120), '2:00');
    assert.equal(copy.clock(108), '1:48');
    assert.equal(copy.clock(0), '0:00');
  });

  test('the copy keeps the design sentences word for word (S-06)', () => {
    assert.equal(copy.updateAppBody('Home PC', '2.0', '1.6'), 'Home PC runs Plenum 2.0, which needs a newer Plenum app than this one (1.6). Update the app, then open it again.');
    assert.equal(copy.updateDesktopBody('Home PC', '1.0', '0.9'), 'This app needs Plenum 1.0 or later on Home PC, which has 0.9. On the computer, open Settings › Updates and install the update.');
    assert.equal(copy.REVOKED_BODY, 'To use Plenum here again, add the phone at the computer under Settings › Phones.');
    assert.equal(copy.uiFailedBody('Home PC', 'checksum'), 'A file from Home PC did not match its checksum, so the phone kept the copy it had. Try again; if it happens again, restart Plenum on the computer.');
    assert.equal(copy.uiFailedBody('Home PC', 'not-sent'), "Home PC did not send Plenum's screens. Try again.");
    assert.equal(copy.uiFailedBody('Home PC', 'stopped'), 'Plenum on Home PC stopped while the screens were loading.');
    assert.equal(copy.pendingLine('Home PC', { approvals: 2, runs: 1 }), 'On Home PC now: 2 approvals waiting, 1 run going.');
    assert.equal(copy.pendingLine('Home PC', { approvals: 1, runs: 0 }), 'On Home PC now: 1 approval waiting.');
    assert.equal(copy.MISMATCH_BODY, 'Stopped. Click Deny on your computer, then add the phone again. A different code can mean another device scanned the same code.');
    assert.equal(copy.DENIED_BODY, 'did not allow this phone. To try again, click Add phone on the computer.');
    assert.equal(copy.EXPIRED_BODY, 'The code expired after 2 minutes. Click Add phone on your computer again, then scan the new code.');
    assert.equal(copy.SCAN_DENIED, 'Plenum cannot use the camera. Allow it in Settings › Plenum › Camera, or paste the link instead.');
    assert.equal(copy.CONSENT_TEXT, "Messages you send from this app go to your computer. Plenum on your computer sends them, with files from your projects, to the AI providers you set up there, which may include Anthropic, OpenAI, Google, Meta (Muse Code), xAI, DeepSeek, Mistral AI and OpenRouter. Each provider handles them under its own privacy policy. Plenum's developer receives nothing.");
    assert.equal(copy.PASTE_ERRORS['not-plenum'], 'This is not a Plenum pairing link. Copy it from the Add phone window on your computer.');
    assert.equal(copy.PASTE_ERRORS.expired, 'This link has expired. Click Add phone on your computer again for a new one.');
    assert.equal(copy.LOCALNET_DENIED, 'iPhone is blocking local network access for Plenum. Turn it on in Settings › Privacy & Security › Local Network › Plenum, or connect through Tailscale or your relay.');
    assert.equal(copy.drivingLine('Home PC', 'Notepad, step 12 of 80'), 'A model is driving Home PC: Notepad, step 12 of 80.');
  });

  test('the welcome privacy line follows the build flag: "Nothing goes through us." unless the forwarder is in the build', () => {
    assert.deepEqual(copy.welcomePrivacy(false), ['Your phone talks only to your computer, encrypted end to end.', 'Nothing goes through us.']);
    assert.deepEqual(copy.welcomePrivacy(true), ['Your phone talks only to your computer, encrypted end to end.', 'Only notifications pass through a small forwarder we run; everything else goes to your computer alone.']);
    assert.equal(copy.FORWARDER_BUILD, false, 'no define in this build, so the forwarder line is off');
  });

  test('the biometric name follows the device; the code is spaced and labelled as the design says', () => {
    assert.equal(copy.biometricName('ios'), 'Face ID');
    assert.equal(copy.biometricName('android'), 'your fingerprint or screen lock');
    assert.equal(copy.biometricName('web'), 'a passkey or a PIN');
    assert.equal(copy.codeSpaced('482913'), '482 913');
    assert.equal(copy.codeLabel('482913'), 'Code 4 8 2 9 1 3');
    assert.equal(copy.storeLabel('ios'), 'Open the App Store');
    assert.equal(copy.storeLabel('android'), 'Open Google Play');
    assert.equal(copy.storeLabel('web'), 'Open the release page');
  });

  test('the Android push line names the chosen app, and gives the install hint when none is chosen (M15)', () => {
    assert.equal(settings.unifiedPushLine('io.heckel.ntfy'), 'Notifications from closed app: through ntfy (UnifiedPush).');
    assert.equal(settings.unifiedPushLine('org.example.push'), 'Notifications from closed app: through your UnifiedPush app.');
    assert.equal(settings.unifiedPushLine(null), 'Install a UnifiedPush app such as ntfy to get notifications while Plenum is closed.');
  });

  test('the strip copy and the driving line', () => {
    assert.equal(route.stripFor({ status: 'offline', lastSeen: null }, 'Home PC').text, "Can't reach Home PC.");
    assert.equal(route.stripFor({ status: 'reconnecting' }, 'Home PC').text, 'Reconnecting to Home PC…');
    assert.equal(route.stripFor({ status: 'asleep' }, 'Home PC').text, 'Home PC is asleep or Plenum is closed. Plenum reconnects when it wakes.');
    assert.equal(route.stripFor({ status: 'connected' }, 'Home PC'), null);
    assert.equal(route.drivingText({ app: 'Notepad', step: 12, of: 80 }), 'Notepad, step 12 of 80');
    assert.equal(route.drivingText(null), null);
  });

  test('the failed screen lists the three carriers, and a web page is told the same-network line is not offered', () => {
    const web = route.failedLines({ platform: 'web', lan: false, computer: 'Home PC', tried: [] });
    assert.equal(web.length, 3);
    assert.match(web[0].text, /^Not available in this app: same network/);
    const native = route.failedLines({ platform: 'ios', lan: false, computer: 'Home PC', tried: [] });
    assert.equal(native[0].text, 'Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.');
    assert.equal(native[2].text, 'Relay: Home PC is not connected to the relay. Check Settings › Phones › Relay on the computer.');
  });

  test('every demo fixture is a complete context and unknown ids have none', () => {
    for (const id of copy.SCREEN_IDS) {
      const ctx = fixtures.fixtureCtx(id);
      assert.ok(ctx, `fixture for ${id}`);
      assert.ok(ctx.computer && Array.isArray(ctx.tried), id);
    }
    assert.equal(fixtures.fixtureCtx('unknown-screen'), null);
    assert.deepEqual(new Set(fixtures.SESSION_SCREENS.filter(id => !id.startsWith('lock-'))), STOP_PRESENT);
  });
});

describe('the router after an action, a lock and a failed pairing (Node)', () => {
  test('Try again after "the codes do not match" reaches How, and the code is not drawn back while the core still says confirm', () => {
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm', code: '482913' } }, { screen: 'mismatch', pairingCancelled: true }), 'mismatch');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm', code: '482913' } }, { screen: 'how', pairingCancelled: true }), 'how');
    assert.equal(route.screenFor({ computers: [], pairing: null }, { screen: 'how', pairingCancelled: false }), 'how');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'confirm', code: '482913' } }, { screen: 'how' }), 'code', 'the code still shows while the person has not cancelled it');
  });

  test('a terminal pairing screen the person acted on stays down until the core state changes', () => {
    const failed = { computers: [], pairing: { state: 'failed', reason: 'no-carrier', tried: [] } };
    assert.equal(route.screenFor(failed, {}), 'failed');
    const key = route.stateKey(failed);
    assert.equal(route.screenFor(failed, { screen: 'how', dismissedKey: key }), 'how');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'denied' } }, { screen: 'how', dismissedKey: key }), 'denied');
  });

  test('Pair again on a revoked phone reaches How; Cancel on connecting reaches Welcome, and connecting comes back on a new state', () => {
    const revoked = { computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'revoked' } };
    assert.equal(route.screenFor(revoked, { screen: 'how', dismissedKey: route.stateKey(revoked) }), 'how');
    const connecting = { computers: [{ id: 'a' }], activeId: 'a', connection: { status: 'connecting' } };
    assert.equal(route.screenFor(connecting, { screen: 'welcome', dismissedKey: route.stateKey(connecting) }), 'welcome');
    assert.equal(route.screenFor(connecting, {}), 'connecting');
  });

  test('Choose another computer on update-app leaves the page to the computer list, which this part does not draw', () => {
    const update = { computers: [{ id: 'a' }, { id: 'b' }], activeId: 'a', connection: { status: 'update-app' } };
    assert.equal(route.screenFor(update, {}), 'update-app');
    assert.equal(route.screenFor(update, { screen: 'computers', dismissedKey: route.stateKey(update) }), null);
  });

  test('a cold launch locked with a computer keeps the stop path and the driving line the lock screens need', () => {
    const locked = { locked: true, lock: { mode: 'pin', failures: 0, waitSec: 0 }, computers: [{ id: 'a', name: 'Home PC' }], activeId: null, hello: null };
    const ctx = route.ctxFor(locked, { lastDriving: { app: 'Notepad', step: 12, of: 80 } }, {});
    assert.equal(route.screenFor(locked, {}), 'lock-pin');
    assert.equal(ctx.session, true);
    assert.equal(ctx.driving, 'Notepad, step 12 of 80');
    assert.equal(route.ctxFor({ computers: [] }, {}, {}).session, false);
  });

  test('the passkey is offered only in a secure context where WebAuthn exists', () => {
    assert.equal(route.passkeyAvailable({ isSecureContext: false, PublicKeyCredential: function () {} }), false);
    assert.equal(route.passkeyAvailable({ isSecureContext: true }), false);
    assert.equal(route.passkeyAvailable({ isSecureContext: true, PublicKeyCredential: function () {} }), true);
  });

  test('the failed screen lists only the carriers the QR offered; save, locked and worker failures are their own sentence', () => {
    const relayOnly = route.failedLines({ platform: 'ios', lan: false, computer: 'Home PC', tried: [{ carrier: 'relay', reason: 'closed' }] });
    assert.deepEqual(relayOnly.map(l => l.kind), ['relay']);
    assert.match(relayOnly[0].text, /not connected to the relay/);
    assert.deepEqual(route.failedLines({ platform: 'ios', lan: false, computer: 'Home PC', tried: [], failReason: 'save' }),
      [{ kind: 'reason', text: 'The phone could not store the key. Try again.' }]);
    const busy = route.failedLines({ platform: 'ios', lan: false, computer: 'Home PC', tried: [{ carrier: 'lan', reason: 'busy' }, { carrier: 'tailscale', reason: 'timeout' }] });
    assert.deepEqual(busy.map(l => l.kind), ['lan', 'tailscale']);
    assert.match(busy[0].text, /^Home PC is busy/);
  });

  test('the connecting line names the carrier the core reports, and no carrier is guessed', () => {
    assert.equal(route.ctxFor({ pairing: { state: 'starting', carrier: 'tailscale' } }, {}, {}).carrier, 'tailscale');
    assert.equal(route.ctxFor({ pairing: { state: 'starting' } }, {}, {}).carrier, null);
  });

  test('the state key changes with the pairing or the connection, and not with the Stop', () => {
    const a = { computers: [], pairing: { state: 'failed', reason: 'save' } };
    assert.notEqual(route.stateKey(a), route.stateKey({ computers: [], pairing: { state: 'failed', reason: 'worker' } }));
    assert.equal(route.stateKey(a), route.stateKey({ ...a, stop: { state: 'sending' } }));
  });
});

// M7: the web page reads the pairing QR with the browser's BarcodeDetector over a camera stream. Everything the browser would do is a fake here.
describe('scanning the pairing code in the browser (M7, Node, fake camera and detector)', () => {
  function rig({ detector = true, camera = true, cameraError = null, frames = [[], [{ rawValue: 'https://relay.example/#pair=abc' }]] } = {}) {
    const events = [];
    const tracks = [{ stop: () => events.push('track-stopped') }];
    const timers = [];
    const video = { srcObject: null, play: () => { events.push('play'); return Promise.resolve(); } };
    let at = 0;
    class FakeDetector {
      constructor(options) { events.push(`detector:${JSON.stringify(options)}`); }
      async detect() { const out = frames[Math.min(at, frames.length - 1)]; at += 1; return out; }
    }
    const env = {
      ...(detector ? { BarcodeDetector: FakeDetector } : {}),
      navigator: camera ? { mediaDevices: { getUserMedia: async constraints => { events.push(`camera:${JSON.stringify(constraints)}`); if (cameraError) throw cameraError; return { getTracks: () => tracks }; } } } : {},
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: id => { events.push(`cleared:${id}`); },
    };
    const pump = async () => { for (let i = 0; i < 50 && timers.length; i += 1) { const t = timers.shift(); await t.fn(); await new Promise(r => setImmediate(r)); } };
    return { env, events, video, timers, pump };
  }

  test('a browser with no detector, or no camera API, sends the person to the paste screen', async () => {
    for (const options of [{ detector: false }, { camera: false }]) {
      const r = rig(options);
      assert.deepEqual(await main.scanWithBrowser(r.env, r.video, () => {}), { ok: false, reason: 'unavailable' });
      assert.equal(r.events.some(e => e.startsWith('camera:')), false, 'the camera is not asked for');
    }
  });

  test('the back camera is asked for, with no audio, and the first frame with a code is the answer; the camera is stopped after it', async () => {
    const r = rig();
    let stop = null;
    const scanning = main.scanWithBrowser(r.env, r.video, fn => { stop = fn; }, { interval: 10 });
    await new Promise(resolve => setImmediate(resolve));
    await r.pump();
    const out = await scanning;
    assert.deepEqual(out, { ok: true, text: 'https://relay.example/#pair=abc' });
    assert.ok(r.events.includes('camera:{"video":{"facingMode":"environment"},"audio":false}'), `the constraints: ${r.events}`);
    assert.ok(r.events.includes('detector:{"formats":["qr_code"]}'), 'only QR codes are looked for');
    assert.ok(r.events.includes('track-stopped'), 'the camera is stopped once a code is read');
    assert.equal(r.video.srcObject, null, 'the preview is cleared');
    assert.equal(typeof stop, 'function', 'the router gets a way to stop the camera when the screen is left');
  });

  test('a refused camera is "denied"; any other camera error is "failed"; both leave nothing running', async () => {
    const denied = rig({ cameraError: Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }) });
    assert.deepEqual(await main.scanWithBrowser(denied.env, denied.video, () => {}), { ok: false, reason: 'denied' });
    const failed = rig({ cameraError: Object.assign(new Error('no camera'), { name: 'NotFoundError' }) });
    assert.deepEqual(await main.scanWithBrowser(failed.env, failed.video, () => {}), { ok: false, reason: 'failed' });
    assert.equal(denied.timers.length + failed.timers.length, 0, 'no loop was started');
  });

  test('leaving the screen stops the camera and the loop, and the scan ends as cancelled', async () => {
    const r = rig({ frames: [[]] });
    let stop = null;
    const scanning = main.scanWithBrowser(r.env, r.video, fn => { stop = fn; }, { interval: 10 });
    await new Promise(resolve => setImmediate(resolve));
    await r.pump();
    stop();
    await r.pump();
    const out = await scanning;
    assert.deepEqual(out, { ok: false, reason: 'cancelled' });
    assert.ok(r.events.includes('track-stopped'), 'the camera is off');
  });

  test('a frame the detector cannot read is skipped, and a code with no text is not an answer', async () => {
    const r = rig({ frames: [[{ rawValue: '' }], [{ other: 1 }], [{ rawValue: 'plenum://pair#x' }]] });
    const scanning = main.scanWithBrowser(r.env, r.video, () => {}, { interval: 10 });
    await new Promise(resolve => setImmediate(resolve));
    await r.pump();
    assert.deepEqual(await scanning, { ok: true, text: 'plenum://pair#x' });
  });
});

describe('the core calls behind the screens (Node, fake core)', () => {
  test('a step advances only on ok: a core without the method, or one that refuses, answers not ok', async () => {
    assert.deepEqual(await flows.enableLockFlow({}, 'pin'), { ok: false, reason: 'unavailable' });
    assert.deepEqual(await flows.enableLockFlow({ enableLock: async () => ({ ok: false, reason: 'format' }) }, 'pin'), { ok: false, reason: 'format' });
    assert.deepEqual(await flows.enableNotificationsFlow({ enableNotifications: () => true }), { ok: true, reason: null });
    assert.equal(copy.lockFailText('unavailable'), 'This is not available on this device yet.');
  });

  test('a passkey lock is unlocked with the passkey, and Stop is sent only after the unlock worked', async () => {
    const calls = [];
    const core = {
      unlock: async method => { calls.push(['unlock', method]); return { ok: true, reason: null }; },
      stop: async () => { calls.push(['stop']); },
    };
    const done = await flows.unlockAndStopFlow(core, 'passkey');
    assert.equal(done.ok, true);
    assert.deepEqual(calls, [['unlock', 'passkey'], ['stop']]);
    calls.length = 0;
    const refused = { unlock: async () => ({ ok: false, reason: 'cancelled' }), stop: async () => { calls.push(['stop']); } };
    assert.equal((await flows.unlockAndStopFlow(refused, 'biometric')).ok, false);
    assert.deepEqual(calls, []);
  });

  test('forget and cancel reach the core with the computer id', async () => {
    const seen = [];
    const core = { forget: async id => { seen.push(['forget', id]); }, cancelConnect: () => { seen.push(['cancelConnect']); return true; } };
    assert.deepEqual(await flows.forgetFlow(core, 'a'), { ok: true, reason: null });
    assert.deepEqual(await flows.call(core, 'cancelConnect'), { ok: true, reason: null });
    assert.deepEqual(seen, [['forget', 'a'], ['cancelConnect']]);
    assert.deepEqual(await flows.forgetFlow({}, 'a'), { ok: false, reason: 'unavailable' });
  });

  test('a link opens only as https, and a link this build does not have opens nothing', () => {
    const opened = [];
    const env = { open: (...args) => { opened.push(args); } };
    assert.deepEqual(flows.openLinkFlow(env, null), { ok: false, reason: 'not-configured' });
    assert.deepEqual(flows.openLinkFlow(env, 'http://example.test/privacy'), { ok: false, reason: 'bad-link' });
    assert.deepEqual(flows.openLinkFlow(env, 'https://example.test/privacy'), { ok: true, reason: null });
    assert.deepEqual(opened, [['https://example.test/privacy', '_blank', 'noopener']]);
    assert.deepEqual(flows.openLinkFlow({}, 'https://example.test/x'), { ok: false, reason: 'unavailable' });
    assert.equal(flows.STORE_LINKS.ios, null, 'the iPhone app has no store page yet, so nothing is made up for it');
  });

  test('the legal and store links are https, and the Legal screen rows, the consent buttons and the store buttons all have one', async () => {
    const repo = 'https://github.com/RealAlcibiades/Plenum';
    assert.equal(flows.LEGAL_LINKS.privacy, `${repo}/blob/main/legal/PRIVACY.md`);
    assert.equal(flows.LEGAL_LINKS['third-party'], `${repo}/blob/main/legal/THIRD-PARTY-SERVICES.md`);
    assert.equal(flows.STORE_LINKS.web, `${repo}/releases`);
    assert.equal(flows.STORE_LINKS.android, `${repo}/releases`);
    for (const link of [...Object.values(flows.LEGAL_LINKS), flows.STORE_LINKS.web, flows.STORE_LINKS.android]) {
      assert.match(link, /^https:\/\/github\.com\/RealAlcibiades\/Plenum\//);
      const opened = [];
      assert.deepEqual(flows.openLinkFlow({ open: (...args) => opened.push(args) }, link), { ok: true, reason: null });
      assert.equal(opened[0][0], link);
    }
    // The Legal screen's rows (license, privacy, third) all have a link; the consent screen's two buttons use privacy and third-party.
    const c2 = await import(url('copy2.js'));
    for (const name of Object.keys(c2.LEGAL_ROWS)) assert.ok(flows.LEGAL_LINKS[name], `the Legal row ${name} has a link`);
    // On the native apps the link opens in the system browser plugin, not in the app's own WebView.
    const calls = [];
    const native = { Capacitor: { Plugins: { Browser: { open: async arg => { calls.push(arg.url); } } } } };
    assert.deepEqual(flows.openLinkFlow(native, flows.LEGAL_LINKS.privacy), { ok: true, reason: null });
    assert.deepEqual(calls, [flows.LEGAL_LINKS.privacy]);
  });

  test('the pairing name is cleaned: no control or bidirectional characters, 60 characters at most, the default when empty', () => {
    assert.equal(flows.cleanPhoneName('  Ana‮phone\u0007  ', 'iPhone'), 'Anaphone');
    assert.equal(flows.cleanPhoneName('   ', 'iPhone'), 'iPhone');
    assert.equal(flows.cleanPhoneName('x'.repeat(80), 'iPhone').length, 60);
  });
});

// The router on a fake page (no browser). The fake keeps elements, attributes, text and children; querySelector takes a class, an attribute
// or a tag, which is all the screens use. The router and the screens run for real. Covers the screen requests from the shell (H3), the
// way back (M6) and the Android push line with its failed choose (M15).
describe('the router on a fake page (Node, fake core): screen requests, the way back and the Android push line', () => {
  class FakeNode {}
  class FakeText extends FakeNode {
    constructor(data) { super(); this.data = String(data); }
  }
  class FakeEl extends FakeNode {
    constructor(tag) {
      super();
      this.tagName = String(tag).toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.parent = null;
      this.className = '';
      this.textContent = '';
    }
    get firstChild() { return this.children[0] ?? null; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    removeAttribute(k) { this.attrs.delete(k); }
    append(...nodes) {
      for (const node of nodes) {
        if (!(node instanceof FakeNode)) continue;
        if (node.parent) node.parent.children = node.parent.children.filter(c => c !== node);
        node.parent = this;
        this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this.append(...nodes);
    }
    removeChild(node) { this.children = this.children.filter(c => c !== node); node.parent = null; return node; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    focus() {}
    matches(sel) {
      if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
      const attr = /^\[([\w-]+)\]$/.exec(sel);
      if (attr) return this.attrs.has(attr[1]);
      return this.tagName === sel.toUpperCase();
    }
    querySelector(sel) {
      for (const c of this.children) {
        if (!(c instanceof FakeEl)) continue;
        if (c.matches(sel)) return c;
        const hit = c.querySelector(sel);
        if (hit) return hit;
      }
      return null;
    }
  }
  const elementsOf = node => [node, ...node.children.filter(c => c instanceof FakeEl).flatMap(elementsOf)];
  const textOf = node => (node instanceof FakeText ? node.data : [node.textContent, ...node.children.map(textOf)].join(''));
  const byId = (node, id) => elementsOf(node).find(e => e.getAttribute('id') === id) ?? null;

  let savedNode;
  before(() => { savedNode = globalThis.Node; globalThis.Node = FakeNode; });
  after(() => { if (savedNode === undefined) delete globalThis.Node; else globalThis.Node = savedNode; });

  function fakePage() {
    const body = new FakeEl('body');
    const documentElement = new FakeEl('html');
    return {
      body,
      documentElement,
      visibilityState: 'visible',
      createElement: tag => new FakeEl(tag),
      createTextNode: text => new FakeText(text),
      getElementById: id => byId(body, id) ?? byId(documentElement, id),
    };
  }

  // The env mountScreens takes: a web or native platform, timers that never fire (the tests call paint themselves), and the
  // listeners the router adds, which the test fires by hand (fire returns the event, so defaultPrevented can be read).
  function fakePageEnv(core, { doc = fakePage(), capacitor = null } = {}) {
    const listeners = new Map();
    return {
      document: doc,
      location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', search: '' },
      navigator: { userAgent: 'Test' },
      Capacitor: capacitor,
      // The shell core is handed over once, at mount (C6a); the window is never read for it.
      __plenumTakeShellCore: () => Promise.resolve(core),
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      fire(type) {
        const event = { type, cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const fn of listeners.get(type) ?? []) fn(event);
        return event;
      },
    };
  }

  // A fake shell core: state() answers the snapshot the test sets (core.snap); the methods the screens call are passed in.
  function fakeShell(snap, methods = {}) {
    return {
      snap,
      state() { return this.snap; },
      subscribe() { return () => {}; },
      ...methods,
    };
  }
  const WELCOME = Object.freeze({ computers: [], activeId: null, connection: {}, pairing: null, locked: false });
  // The hand-over resolves in a later turn; a test waits for it before it looks at the page.
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const lockedWith = (lockStop, lock = { mode: 'biometric', failures: 0, waitSec: 0 }) => ({
    ...WELCOME,
    computers: [{ id: 'a', name: 'Home PC' }],
    activeId: 'a',
    locked: true,
    lock,
    lockStop,
  });

  test('a screen request from the shell opens its screen once per seq (H3); a request made while locked waits for the unlock', async () => {
    const doc = fakePage();
    const core = fakeShell({ ...WELCOME, screenRequest: { screen: 'settings', seq: 1 } });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'settings', 'seq 1 opens settings');
    assert.equal(mounted.nav.screenSeq, 1);
    mounted.io.back();
    mounted.paint();
    assert.equal(doc.body.getAttribute('data-screen'), 'welcome', 'the same seq does not open settings again');
    core.snap = { ...WELCOME, locked: true, lock: { mode: 'biometric', failures: 0, waitSec: 0 }, screenRequest: { screen: 'computers', seq: 2 } };
    mounted.paint();
    assert.equal(doc.body.getAttribute('data-screen'), 'lock-bio', 'the lock stays up');
    assert.equal(mounted.nav.screenSeq, 1, 'the request waits while locked');
    core.snap = { ...core.snap, locked: false };
    mounted.paint();
    assert.equal(doc.body.getAttribute('data-screen'), 'computers', 'seq 2 opens the computer list once the lock is off');
    assert.equal(mounted.nav.screenSeq, 2);
  });

  test('plenum-back (M6): on a pushed screen it is cancelled and goes back; on the first screen it is left to the app', async () => {
    const doc = fakePage();
    const env = fakePageEnv(fakeShell({ ...WELCOME }), { doc });
    const mounted = main.mountScreens(env);
    await settle();
    assert.equal(env.fire('plenum-back').defaultPrevented, false, 'the first screen does not take the back event');
    mounted.io.go('how');
    assert.equal(doc.body.getAttribute('data-screen'), 'how');
    assert.equal(env.fire('plenum-back').defaultPrevented, true, 'a pushed screen takes the back event');
    assert.equal(doc.body.getAttribute('data-screen'), 'welcome', 'and goes back to the screen before');
  });

  test('on Android the push line names the chosen app, "Choose app" sits under it, and a failed choose shows the install line (M15)', async () => {
    const doc = fakePage();
    const android = { isNativePlatform: () => true, getPlatform: () => 'android' };
    const core = fakeShell({ ...WELCOME, computers: [{ id: 'a', name: 'Home PC' }], androidPush: { supported: true, distributor: null } }, {
      chooseDistributor: async () => ({ ok: false, reason: 'no-distributor' }),
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc, capacitor: android }));
    await settle();
    mounted.io.go('settings-notify');
    const view = () => doc.getElementById('sh-view');
    const buttons = () => elementsOf(view()).filter(e => e.tagName === 'BUTTON').map(textOf);
    const install = 'Install a UnifiedPush app such as ntfy to get notifications while Plenum is closed.';
    assert.equal(doc.body.getAttribute('data-screen'), 'settings-notify');
    assert.ok(textOf(view()).includes(install), 'no push app chosen: the install line');
    assert.ok(buttons().includes('Choose app'), 'the chooser reads Choose app');
    assert.equal(buttons().includes('Choose a push app'), false);
    const failed = await mounted.actions.chooseDistributor();
    assert.equal(failed.ok, false);
    assert.ok(elementsOf(view()).some(e => e.className === 'sh-msg' && textOf(e) === install), 'a failed choose shows the install line');
    core.snap = { ...core.snap, androidPush: { supported: true, distributor: 'io.heckel.ntfy' } };
    mounted.paint();
    assert.ok(textOf(view()).includes('Notifications from closed app: through ntfy (UnifiedPush).'), 'the chosen ntfy app is named');
    assert.ok(buttons().includes('Choose app'));
    core.snap = { ...core.snap, androidPush: { supported: false, distributor: null } };
    mounted.paint();
    assert.equal(buttons().includes('Choose app'), false, 'no chooser when the phone cannot use UnifiedPush');
  });

  test('the shell core comes from the one-shot hand-over, and a window core is never read (C6a)', async () => {
    const doc = fakePage();
    const env = fakePageEnv(fakeShell({ ...WELCOME }), { doc });
    let takes = 0;
    env.__plenumTakeShellCore = () => { takes += 1; return Promise.resolve(fakeShell({ ...WELCOME })); };
    env.plenumShellCore = fakeShell({ ...WELCOME, computers: [{ id: 'z', name: 'Other' }] });
    main.mountScreens(env);
    await settle();
    assert.equal(takes, 1, 'taken once, at mount');
    assert.equal(doc.body.getAttribute('data-screen'), 'welcome', 'the hand-over core decides the screen, not the window core');
  });

  test('a shell that did not start leaves the page the could-not-start note, not a blank page (C6a)', async () => {
    const doc = fakePage();
    const env = fakePageEnv(null, { doc });
    env.__plenumTakeShellCore = () => Promise.resolve(null);
    main.mountScreens(env);
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'start-failed');
    assert.ok(textOf(doc.getElementById('sh-view')).includes('Plenum could not start on this page. Close it and open Plenum again.'));
  });

  test('pair-review shows the name, every host line, Cancel and Pair; Pair calls confirmPair and Cancel calls cancelPairing (C6e)', async () => {
    const doc = fakePage();
    const calls = [];
    const review = { ...WELCOME, pairing: { state: 'review', code: null, tried: [], reason: null, review: { name: 'Home PC', hosts: [{ kind: 'lan', host: '192.168.1.5:40123' }, { kind: 'relay', host: 'wss://relay.example' }] } } };
    const core = fakeShell(review, {
      confirmPair: async () => { calls.push('confirmPair'); return { ok: true, state: 'allowed' }; },
      cancelPairing: async () => { calls.push('cancelPairing'); return true; },
    });
    main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'pair-review');
    const view = doc.getElementById('sh-view');
    const shown = textOf(view);
    assert.ok(shown.includes('Pair with Home PC?'), 'the title names the computer');
    assert.ok(shown.includes('Same network: 192.168.1.5:40123'), 'the LAN host line');
    assert.ok(shown.includes('Your relay: wss://relay.example'), 'the relay host line');
    const buttons = elementsOf(view).filter(e => e.tagName === 'BUTTON');
    assert.deepEqual(buttons.map(textOf), ['Cancel', 'Pair']);
    buttons[1].listeners.get('click')[0]({});
    await settle();
    buttons[0].listeners.get('click')[0]({});
    await settle();
    assert.deepEqual(calls, ['confirmPair', 'cancelPairing']);
  });

  test('the lock screen says Stop everything and stops without unlocking when the Stop key is held; otherwise it unlocks first (C6f)', async () => {
    const doc = fakePage();
    const calls = [];
    const core = fakeShell(lockedWith({ ready: true, computerName: 'Home PC' }), {
      stop: async () => { calls.push('stop'); return { state: 'sending' }; },
      unlock: async method => { calls.push(['unlock', method]); return { ok: true, reason: null }; },
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'lock-bio');
    const stopButton = () => elementsOf(doc.getElementById('sh-view')).find(e => e.tagName === 'BUTTON' && /stop everything/i.test(textOf(e)));
    assert.equal(textOf(stopButton()), 'Stop everything');
    stopButton().listeners.get('click')[0]({});
    await settle();
    assert.deepEqual(calls, ['stop'], 'Stop is sent with no unlock');
    core.snap = lockedWith({ ready: false, computerName: 'Home PC' });
    mounted.paint();
    assert.equal(textOf(stopButton()), 'Unlock and stop everything', 'a computer with no Stop key still unlocks first');
  });

  test('the PIN lock screen sends Stop without arming the PIN when the Stop key is held (C6f)', async () => {
    const doc = fakePage();
    const calls = [];
    const core = fakeShell(lockedWith({ ready: true, computerName: 'Home PC' }, { mode: 'pin', failures: 0, waitSec: 0 }), {
      stop: async () => { calls.push('stop'); return { state: 'sending' }; },
    });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'lock-pin');
    const stopButton = elementsOf(doc.getElementById('sh-view')).find(e => e.tagName === 'BUTTON' && textOf(e) === 'Stop everything');
    stopButton.listeners.get('click')[0]({});
    await settle();
    assert.deepEqual(calls, ['stop']);
    assert.equal(mounted.io.local.stopAfterUnlock, undefined, 'nothing is armed for after the PIN');
  });

  test('the Stop result shows on the lock screen while it is queued, done or failed, and clears when idle (C6d)', async () => {
    const doc = fakePage();
    const queued = 'Stop will be sent when the computer is reachable. Trying for 60 seconds.';
    const core = fakeShell({ ...lockedWith({ ready: true, computerName: 'Home PC' }), stop: { state: 'queued', text: queued, seq: 1 } });
    const mounted = main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    const view = () => doc.getElementById('sh-view');
    assert.ok(textOf(view()).includes(queued), 'the queued text shows on the lock screen');
    core.snap = { ...core.snap, stop: { state: 'idle', text: '', seq: 2 } };
    mounted.paint();
    assert.equal(textOf(view()).includes(queued), false, 'the text clears when the Stop is idle');
  });

  test('lock settings that cannot be read show the lock-unknown line and no Unlock button, and Stop still works (C6f)', async () => {
    const doc = fakePage();
    const core = fakeShell(lockedWith({ ready: true, computerName: 'Home PC' }, { mode: 'unknown', failures: 0, waitSec: 0 }));
    main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    const view = doc.getElementById('sh-view');
    assert.ok(textOf(view).includes('Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.'));
    const buttons = elementsOf(view).filter(e => e.tagName === 'BUTTON').map(textOf);
    assert.equal(buttons.some(t => /^Unlock with /.test(t)), false, 'no Unlock button');
    assert.ok(buttons.includes('Stop everything'), 'Stop is still there');
  });

  test('B-130: lock settings that cannot be read and no Stop key to send without them: the line says Stop is at the computer, and there is no Stop button that cannot work', async () => {
    const doc = fakePage();
    const core = fakeShell(lockedWith({ ready: false, computerName: '' }, { mode: 'unknown', failures: 0, waitSec: 0 }));
    main.mountScreens(fakePageEnv(core, { doc }));
    await settle();
    const view = doc.getElementById('sh-view');
    const text = textOf(view);
    assert.ok(text.includes('This phone cannot send Stop from here. Press Stop on your computer (the Stop bar, or Ctrl+Alt+Esc).'));
    assert.equal(text.includes('Stop still works'), false, 'the promise is not made when the key cannot be read');
    const buttons = elementsOf(view).filter(e => e.tagName === 'BUTTON').map(textOf);
    assert.equal(buttons.some(t => /^Unlock with /.test(t)), false, 'no Unlock button');
    assert.equal(buttons.includes('Stop everything'), false);
    assert.equal(buttons.includes('Unlock and stop everything'), false, 'no button promises an unlock that cannot run');
  });

  test('a phone whose secure storage did not load says so on the welcome screen (C6d)', async () => {
    const doc = fakePage();
    main.mountScreens(fakePageEnv(fakeShell({ ...WELCOME, storage: 'unavailable' }), { doc }));
    await settle();
    assert.equal(doc.body.getAttribute('data-screen'), 'welcome');
    assert.ok(textOf(doc.getElementById('sh-view')).includes('This phone could not open its secure storage, so Plenum cannot keep a computer\'s key here.'));
  });
});

describe('the review screen, the release gate and the copy the phone shows (Node)', () => {
  test('a pairing waiting for Pair is its own screen, before the starting screen and the code (D5)', () => {
    const review = { computers: [], pairing: { state: 'review', code: null, tried: [], reason: null, review: { name: 'Home PC', hosts: [] } } };
    assert.equal(route.screenFor(review, {}), 'pair-review');
    assert.equal(route.screenFor({ computers: [], pairing: { state: 'starting' } }, {}), 'connecting');
  });

  test('the context carries the Stop text only while a Stop is sending, queued, done or failed (C6d)', () => {
    assert.equal(route.ctxFor({ stop: { state: 'idle', text: 'stale' } }, {}, {}).stopText, '');
    assert.equal(route.ctxFor({ stop: { state: 'done', text: 'Stopped.' } }, {}, {}).stopText, 'Stopped.');
    assert.deepEqual(route.ctxFor({}, {}, {}).lockStop, { ready: false, computerName: '' });
    assert.equal(route.ctxFor({ storage: 'unavailable' }, {}, {}).storageUnavailable, true);
    assert.equal(route.ctxFor({ lock: { mode: 'unknown' } }, {}, {}).lockUnknown, true);
  });

  test('the LAN web strip is the C11 text, with the computer name filled in', async () => {
    const c2 = await import(url('copy2.js'));
    assert.equal(c2.fillName(c2.LAN_WEB_STRIP, 'Home PC'), 'This page works only on Home PC\'s network and cannot send notifications. It is sent without encryption, so someone on this network could change it. On a network you do not trust, use the Plenum app, Tailscale or your relay.');
  });

  test('the fixture screens and window.plenumScreensDebug are off in a release build; the demo replay is not a debug hook (C7)', () => {
    const params = query => new URLSearchParams(query);
    assert.equal(main.screensDebugOn(params('demo=1&screen=welcome'), false), false, 'a fixture is not in a release build');
    assert.equal(main.screensDebugOn(params('debug=1'), false), false, 'the debug hook is not in a release build');
    assert.equal(main.screensDebugOn(params('demo=1'), false), false, 'the replay has no debug hook in a release build');
    assert.equal(main.screensDebugOn(params('demo=1&screen=welcome'), true), true, 'a dev build has the fixture hook');
    assert.equal(main.screensDebugOn(params('debug=1'), true), true, 'a dev build has the debug hook');
    assert.equal(main.screensDebugOn(params(''), true), false, 'no parameter, no hook');
  });
});

// ---------- the page part (Electron harness, sealed copy) ----------

// Runs in the page: the audit of one screen. Returns plain numbers and strings only. Targets are the section 16.1 helpers.
const AUDIT = `(() => {
  const sa = name => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
  const vis = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const targets = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [tabindex="0"]')].filter(vis);
  const small = targets.filter(el => { const r = el.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; })
    .map(el => (el.id || el.className || el.tagName) + ':' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height));
  const hOverflow = document.scrollingElement.scrollWidth > innerWidth + 0.5;
  const smallInputs = [...document.querySelectorAll('input, select, textarea')].filter(vis).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.id || el.tagName);
  const unnamed = targets.filter(el => !((el.getAttribute('aria-label') || el.textContent || '').trim()) && !(el.labels && el.labels.length)).map(el => el.className || el.tagName);
  const stop = document.getElementById('plenum-stop');
  const stopVisible = Boolean(stop) && !stop.hidden && vis(stop);
  let stopHittable = false;
  if (stopVisible) { const r = stop.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); stopHittable = Boolean(t) && (t === stop || stop.contains(t)); }
  const primaries = [...document.querySelectorAll('.sh-actions .sh-btn-primary')].filter(vis);
  const primary = primaries.length ? primaries[primaries.length - 1] : null;
  const primaryGap = primary ? Math.round((innerHeight - sa('--sa-bottom') - 16 - primary.getBoundingClientRect().bottom) * 10) / 10 : null;
  const h1 = document.querySelector('h1') ? document.querySelector('h1').textContent : '';
  // Every button that the floating Stop overlaps vertically ends at least 8 px left of it (MOBILE-UI 2.3).
  const sr = stop ? stop.getBoundingClientRect() : null;
  const stopClear = stopVisible ? [...document.querySelectorAll('.sh-btn')].filter(vis).filter(b => { const br = b.getBoundingClientRect(); return br.bottom > sr.top && br.top < sr.bottom && sr.left - br.right < 8; }).map(b => b.textContent.trim()) : [];
  return { h1, stopClear, small, hOverflow, smallInputs, unnamed, stopVisible, stopHittable, primaryGap, primaryHeight: primary ? primary.getBoundingClientRect().height : null,
    text: (document.getElementById('sh-view') || document.body).innerText, stopState: stop ? stop.getAttribute('data-state') : null };
})()`;

const SAFE = (view, theme) => `(() => { const s = document.documentElement.style;
  s.setProperty('--dbg-sa-top', '${view.safe[0]}px'); s.setProperty('--dbg-sa-right', '${view.safe[1]}px');
  s.setProperty('--dbg-sa-bottom', '${view.safe[2]}px'); s.setProperty('--dbg-sa-left', '${view.safe[3]}px');
  return document.documentElement.getAttribute('data-theme'); })()`;

const TYPE_HEADERS = ext => TYPES[ext] ?? 'application/octet-stream';

// The page build loads esbuild from <app>/mobile/node_modules only (build-mobile.mjs loadEsbuild). A sealed copy has none, so the app copy
// links the install that holds the pinned esbuild: this project's, or the harness's shared install (as build.test.mjs does). The link is
// removed before the copy is, so nothing under the install is touched.
const SHARED_INSTALL = path.resolve(HERE, '..', '..', '..', 'node_modules');
function linkEsbuild(app) {
  const project = path.join(ROOT, 'mobile', 'node_modules');
  const install = existsSync(path.join(project, 'esbuild', 'package.json')) ? project : SHARED_INSTALL;
  mkdirSync(path.join(app, 'mobile'), { recursive: true });
  symlinkSync(install, path.join(app, 'mobile', 'node_modules'), 'junction');
}
function unlinkEsbuild(app) {
  const link = path.join(app, 'mobile', 'node_modules');
  try {
    if (lstatSync(link).isSymbolicLink()) rmdirSync(link);
  } catch {
    // Not linked.
  }
}

function serve(dir) {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
      const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const file = path.normalize(path.join(dir, rel));
      if (!file.startsWith(path.normalize(dir)) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPE_HEADERS(path.extname(file)), 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('shell screens in the phone-size harness (S-01 to S-09)', { timeout: 900_000, skip: PAGE_SKIP }, () => {
  let h = null;
  let server = null;
  let base = null;
  let app = null;
  let WWW = null;
  const shots = [];
  const failures = [];

  before(async () => {
    // A private app folder: this suite's build never shares a mobile/www with another suite. The build is the real one, with screens.js in it.
    app = await makeAppCopy('screens');
    linkEsbuild(app);
    WWW = path.join(app, 'mobile', 'www');
    // --dev: the fixture screens (?demo=1&screen=) and the debug hooks exist only in a dev build (C7).
    const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-mobile.mjs'), '--root', app, '--dev'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    assert.equal(built.status, 0, `build: ${built.stderr}`);
    assert.ok(existsSync(path.join(WWW, 'screens.js')), 'the build emits screens.js');
    server = await serve(WWW);
    base = `http://127.0.0.1:${server.address().port}`;
    h = await startPhoneHarness({ name: 'mob10-screens', appRoot: app });
  });

  after(async () => {
    if (h) {
      const report = await h.close();
      assert.deepEqual(report.leftover, [], 'no process of the run is left');
    }
    if (server) server.close();
    if (app) {
      unlinkEsbuild(app);
      removeAppCopy(app);
    }
  });

  test('S-01 every screen renders with no console error, no horizontal scroll, 44 px targets, 16 px inputs and a name on every control, at both sizes and both themes', async () => {
    for (const view of VIEWS) {
      for (const theme of THEMES) {
        await h.open(`${base}/index.html?demo=1&screen=welcome&theme=${theme}`, { surface: 'phone', view, theme, capacitor: false, token: null, tokenOrigin: null });
        const themed = await h.eval(SAFE(view, theme));
        assert.equal(themed, theme, 'the data-theme attribute follows the theme parameter');
        for (const id of copy.SCREEN_IDS) {
          const before = (await h.logs()).errors.length;
          const shown = await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
          assert.equal(shown, id, `shows ${id}`);
          const audit = await h.eval(AUDIT);
          const after = (await h.logs()).errors.length;
          if (after > before) failures.push(`${id} ${view.label} ${theme}: console error`);
          if (audit.hOverflow) failures.push(`${id} ${view.label} ${theme}: horizontal scroll`);
          if (audit.small.length) failures.push(`${id} ${view.label} ${theme}: small targets ${audit.small.join(', ')}`);
          if (audit.smallInputs.length) failures.push(`${id} ${view.label} ${theme}: inputs under 16 px ${audit.smallInputs.join(', ')}`);
          if (audit.unnamed.length) failures.push(`${id} ${view.label} ${theme}: unnamed controls ${audit.unnamed.join(', ')}`);
          if (!audit.h1) failures.push(`${id} ${view.label} ${theme}: no title`);
          const shot = await h.shot(`mob10-${id}-${view.label}-${theme}`);
          shots.push(shot.path);
        }
      }
    }
    assert.deepEqual(failures, []);
    assert.equal(shots.length, copy.SCREEN_IDS.length * VIEWS.length * THEMES.length);
  });

  test('S-02 the pairing code is 40 px mono on one line, reads 482 913 and is labelled "Code 4 8 2 9 1 3"', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=code&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'light'));
    const info = await h.eval(`(() => { const c = document.querySelector('.sh-code'); const s = getComputedStyle(c);
      return { size: parseFloat(s.fontSize), text: c.textContent, label: c.getAttribute('aria-label'), fits: c.scrollWidth <= c.clientWidth + 1, nowrap: s.whiteSpace }; })()`);
    assert.ok(info.size >= 36, `font-size ${info.size}`);
    assert.equal(info.text, '482 913');
    assert.equal(info.label, 'Code 4 8 2 9 1 3');
    assert.equal(info.nowrap, 'nowrap');
    assert.equal(info.fits, true);
    // A larger platform text size (the factor the shell gives --tz) keeps the digits on one line at 360.
    const zoomed = await h.eval(`(() => { document.documentElement.style.setProperty('--tz', '2'); const c = document.querySelector('.sh-code');
      return { fits: c.scrollWidth <= c.clientWidth + 1, width: c.getBoundingClientRect().width, size: parseFloat(getComputedStyle(c).fontSize) }; })()`);
    assert.equal(zoomed.fits, true, 'digits stay on one line at text factor 2');
    await h.eval(`document.documentElement.style.removeProperty('--tz')`);
    await h.shot('mob10-code-digits-360-light');
  });

  test('S-03 the countdown starts at 2:00 and moves down with the clock; at zero the code screen becomes expired', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=code&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'light'));
    const read = () => h.eval(`(() => { const d = document.querySelector('[data-countdown]'); return d ? d.textContent : null; })()`);
    const start = await read();
    assert.ok(start === '2:00' || start === '1:59', `start ${start}`);
    await h.eval(`window.plenumScreensDebug.advance(12000)`);
    const moved = await read();
    assert.ok(['1:48', '1:47', '1:46'].includes(moved), `after 12 s: ${moved}`);
    await h.eval(`window.plenumScreensDebug.advance(108000)`);
    const title = await h.eval(`document.querySelector('h1').textContent`);
    assert.equal(title, 'The code expired');
  });

  test('S-04 the scanner viewfinder is at most 280 px and 72vw; Paste a link is 48 px or taller; the denied copy is exact', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=scan&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'light'));
    const vf = await h.eval(`(() => { const v = document.querySelector('.sh-viewfinder').getBoundingClientRect(); return { w: v.width, max: innerWidth * 0.72 }; })()`);
    assert.ok(vf.w <= 280.5 && vf.w <= vf.max + 0.5, `viewfinder ${vf.w}`);
    const paste = await h.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'Paste a link'); return b ? b.getBoundingClientRect().height : 0; })()`);
    assert.ok(paste >= 48, `paste button ${paste}`);
    await h.eval(`window.plenumScreensDebug.go('scan-denied')`);
    const denied = await h.eval(`document.querySelector('.sh-note').textContent`);
    assert.equal(denied, 'Plenum cannot use the camera. Allow it in Settings › Plenum › Camera, or paste the link instead.');
  });

  test('S-05 the lock shows Unlock at 48 px or taller, the stop-everything button only with a session, and the driving line', async () => {
    const view = VIEWS[1];
    await h.open(`${base}/index.html?demo=1&screen=lock-bio&theme=dark`, { surface: 'phone', view, theme: 'dark', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'dark'));
    const withSession = await h.eval(`(() => { const btns = [...document.querySelectorAll('button')]; const unlock = btns.find(b => /^Unlock with /.test(b.textContent));
      return { unlockHeight: unlock ? unlock.getBoundingClientRect().height : 0, stopAll: btns.some(b => b.textContent === 'Unlock and stop everything'),
        driving: (document.querySelector('.sh-driving') || {}).textContent || null, label: unlock ? unlock.textContent : null }; })()`);
    assert.ok(withSession.unlockHeight >= 48, `unlock ${withSession.unlockHeight}`);
    assert.equal(withSession.label, 'Unlock with Face ID');
    assert.equal(withSession.stopAll, true);
    assert.equal(withSession.driving, 'A model is driving Home PC: Notepad, step 12 of 80.');
    await h.eval(`window.plenumScreensDebug.setFixture({ session: false })`);
    const noSession = await h.eval(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Unlock and stop everything')`);
    assert.equal(noSession, false, 'no stop-all without a session');
    // A passkey lock is unlocked with its passkey, not with the biometric (wave 106 fix).
    await h.eval(`window.plenumScreensDebug.setFixture({ session: true, lock: { mode: 'passkey', failures: 0, waitSec: 0 } })`);
    const passkeyLabel = await h.eval(`(() => { const u = [...document.querySelectorAll('button')].find(b => /^Unlock with /.test(b.textContent)); return u ? u.textContent : null; })()`);
    assert.equal(passkeyLabel, 'Unlock with a passkey');
  });

  test('S-06 the design copy appears word for word on the update, revoked, ui-failed, failed, mismatch, denied and expired screens', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=update-app&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'light'));
    const expectations = [
      ['update-app', 'Home PC runs Plenum 2.0, which needs a newer Plenum app than this one (1.6). Update the app, then open it again.'],
      ['update-desktop', 'This app needs Plenum 1.0 or later on Home PC, which has 0.9. On the computer, open Settings › Updates and install the update.'],
      ['revoked', 'To use Plenum here again, add the phone at the computer under Settings › Phones.'],
      ['ui-failed', 'A file from Home PC did not match its checksum, so the phone kept the copy it had. Try again; if it happens again, restart Plenum on the computer.'],
      ['ui-failed', 'On Home PC now: 2 approvals waiting, 1 run going.'],
      ['failed', 'Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.'],
      ['failed', 'Relay: Home PC is not connected to the relay. Check Settings › Phones › Relay on the computer.'],
      ['mismatch', 'Stopped. Click Deny on your computer, then add the phone again. A different code can mean another device scanned the same code.'],
      ['denied', 'Home PC did not allow this phone. To try again, click Add phone on the computer.'],
      ['expired', 'The code expired after 2 minutes. Click Add phone on your computer again, then scan the new code.'],
      ['revoked', 'Home PC removed this phone'],
      ['welcome', 'Nothing goes through us.'],
    ];
    const misses = [];
    for (const [id, text] of expectations) {
      await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
      const shown = await h.eval(`document.getElementById('sh-view').innerText`);
      if (!shown.includes(text)) misses.push(`${id}: ${text}`);
    }
    assert.deepEqual(misses, []);
  });

  test('S-07 the floating Stop is present with a session (connecting, failed, loading, update, ui-failed) and absent on welcome, consent, how, scan, paste and code', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=welcome&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(SAFE(view, 'light'));
    const wrong = [];
    for (const id of copy.SCREEN_IDS) {
      await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
      const present = await h.eval(`(() => { const s = document.getElementById('plenum-stop'); return Boolean(s) && !s.hidden; })()`);
      const want = STOP_PRESENT.has(id);
      if (present !== want) wrong.push(`${id}: stop ${present ? 'shown' : 'hidden'}`);
    }
    for (const id of ['welcome', 'consent', 'how', 'scan', 'paste', 'code']) {
      await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
      const present = await h.eval(`(() => { const s = document.getElementById('plenum-stop'); return Boolean(s) && !s.hidden; })()`);
      if (present) wrong.push(`${id}: stop must be absent`);
    }
    assert.deepEqual(wrong, []);
  });

  test('S-08 the shell tokens equal the :root block of public/style.css, and the shell CSS and HTML have no colour literal and no inline script or style', async () => {
    const { rootBlock, colourLiterals, cspViolations } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'build-mobile.mjs')).href);
    const expected = rootBlock(readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8'));
    assert.equal(readFileSync(path.join(WWW, 'shell-tokens.css'), 'utf8'), expected);
    assert.deepEqual(colourLiterals(readFileSync(path.join(SHELL, 'styles.css'), 'utf8')), []);
    assert.deepEqual(cspViolations(readFileSync(path.join(SHELL, 'index.html'), 'utf8')), []);
    assert.doesNotMatch(readFileSync(path.join(SHELL, 'screens', 'views.js'), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.doesNotMatch(readFileSync(path.join(SHELL, 'screens', 'main.js'), 'utf8'), /innerHTML|insertAdjacentHTML|outerHTML/);
  });

  test('S-09 the primary button of every screen sits 16 px above the safe area at the bottom (within 2 px), and the Stop is hittable', async () => {
    const misses = [];
    for (const view of VIEWS) {
      for (const theme of THEMES) {
        await h.open(`${base}/index.html?demo=1&screen=welcome&theme=${theme}`, { surface: 'phone', view, theme, capacitor: false, token: null, tokenOrigin: null });
        await h.eval(SAFE(view, theme));
        for (const id of copy.SCREEN_IDS) {
          await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
          const audit = await h.eval(AUDIT);
          if (audit.primaryGap !== null && Math.abs(audit.primaryGap) > 2) misses.push(`${id} ${view.label} ${theme}: gap ${audit.primaryGap}`);
          if (audit.stopVisible && !audit.stopHittable) misses.push(`${id} ${view.label} ${theme}: stop not hittable`);
          if (audit.stopClear.length) misses.push(`${id} ${view.label} ${theme}: under the stop by under 8 px: ${audit.stopClear.join(', ')}`);
        }
      }
    }
    assert.deepEqual(misses, []);
  });

  test('M12 Privacy Notice, Third-party services and the store button open their https links (window.open is recorded, nothing opens)', async () => {
    const view = VIEWS[0];
    await h.open(`${base}/index.html?demo=1&screen=consent&theme=light`, { surface: 'phone', view, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(`(() => { window.__opened = []; window.open = (...args) => { window.__opened.push(args); return null; }; return true; })()`);
    const press = label => h.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    assert.equal(await press('Privacy Notice'), true);
    assert.equal(await press('Third-party services'), true);
    await h.eval(`window.plenumScreensDebug.go('update-app', { platform: 'web' })`);
    assert.equal(await press('Open the release page'), true, 'the web page names the release page');
    const opened = await h.eval('window.__opened');
    assert.deepEqual(opened.map(args => args[0]), [flows.LEGAL_LINKS.privacy, flows.LEGAL_LINKS['third-party'], flows.STORE_LINKS.web]);
    assert.ok(opened.every(args => args[1] === '_blank' && args[2] === 'noopener'));
    const note = await h.eval(`(() => { const m = document.querySelector('.sh-msg[role=alert]'); return m ? m.textContent : null; })()`);
    assert.equal(note, null, 'no "not available" message is left on the screen');
  });
});

describe('the shell screens (Node) keep to the brief', () => {
  test('the screen router is the only shell module that starts itself, and only in a document', () => {
    const main = readFileSync(path.join(SCREENS, 'main.js'), 'utf8');
    assert.match(main, /typeof document !== 'undefined'/);
    assert.doesNotMatch(readFileSync(path.join(SCREENS, 'route.js'), 'utf8'), /document\./);
  });
});
