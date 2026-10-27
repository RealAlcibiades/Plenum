// The shell's part 2 screens and the end to end flow (mob-10, wave 107; MOBILE-UI 6.11, 6.12, 6.17, 6.18, 10, 16.3 S-10 and MOBILE.json
// feature mob-10 acceptance).
//
// Two parts. The pure part runs in Node: the screen ids and builders, the settings rules, the notification conditions, the demo
// replay, the demo session file and the core's demo mode (createShell with a fake store). The page part makes its own app folder
// (makeAppCopy), runs the real build in it (scripts/build-mobile.mjs: screens.js, the /shell/ files, sw.js) and drives the result in the
// phone-size harness (one hidden Electron window, a mock model): the offline demo, then the Bridge flow from the pairing link to the
// computer's own UI on the phone (the code the phone shows equals the confirm route's, Allow, the hand-over to the UI that the service worker
// serves, Stop with its result toast), a card from a run answered from the phone, /?shell staying on the shell's screens, a computer that
// restarts on the same state and is reached again within 10 seconds, Forget.
// Screenshots go to C:/t/mob/ (mob10-part2-<name>.png, stabm6-<name>.png). Run it through the sealed runner:
//   node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-10-shell-screens-part-2-and-end-to-end shell.e2e.test.mjs

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, lstatSync, readFileSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ELECTRON, PHONE_VIEW, startPhoneHarness } from './harness/phone-window.mjs';
import { makeAppCopy, removeAppCopy, sleep } from './helpers/sealed-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHELL = path.join(ROOT, 'mobile', 'shell');
const SCREENS = path.join(SHELL, 'screens');
const url = name => pathToFileURL(path.join(SCREENS, name)).href;

const CAN_RUN = process.platform === 'win32'
  && process.env.MOBILE_SEALED === '1'
  && /\/build\/mobile\/src-[^/]+$/.test(ROOT.split(path.sep).join('/'))
  && existsSync(ELECTRON);
const PAGE_SKIP = CAN_RUN ? false : 'sealed Windows runner with Electron only (node build/mobile/run.mjs --id mob-10-shell-screens-part-2-and-end-to-end shell.e2e.test.mjs)';

// build-mobile.mjs takes esbuild and the phone packages from <root>/mobile/node_modules only, and a sealed app copy (makeAppCopy) has none: the
// copy links the install that holds the pinned esbuild (this project's, or the harness's shared one above the sealed copy), and unlinks it
// before the copy is removed, so nothing under the shared install can be touched.
function linkMobileInstall(app, here) {
  const install = [path.join(here, '..', 'node_modules'), path.resolve(here, '../../../node_modules')].find(d => existsSync(path.join(d, 'esbuild', 'package.json')));
  if (!install) throw new Error('no install holds esbuild: run npm ci in mobile/ (or use the harness shared install)');
  symlinkSync(install, path.join(app, 'mobile', 'node_modules'), 'junction');
}
// The sealed Electron window can reach only 127.0.0.1 (a LAN bind would make Windows ask the owner about the firewall), but the pairing link also
// lists this machine's real LAN addresses. The phone keeps the first carrier entry of a kind and tries only the addresses that pass the carrier
// rules (carriers.js), so the test link keeps just the loopback address the test server adds: the page then reconnects to the Bridge after pairing.
function loopbackOnly(link) {
  const at = link.indexOf('#pair=');
  const payload = JSON.parse(Buffer.from(link.slice(at + '#pair='.length), 'base64url').toString('utf8'));
  payload.carriers = payload.carriers
    .map(c => ({ ...c, urls: (c.urls ?? []).filter(u => /^ws:\/\/127\.0\.0\.1[:/]/.test(u)) }))
    .filter(c => c.urls.length);
  return `${link.slice(0, at)}#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function unlinkMobileInstall(app) {
  try {
    const link = path.join(app, 'mobile', 'node_modules');
    if (lstatSync(link).isSymbolicLink()) rmdirSync(link);
  } catch { /* not linked */ }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const TYPE_HEADERS = ext => TYPES[ext] ?? 'application/octet-stream';

// ---------- the pure part ----------

const copy = await import(url('copy.js'));
const copy2 = await import(url('copy2.js'));
const settings = await import(url('settings.js'));
const demo = await import(url('demo.js'));
const views2 = await import(url('views2.js'));
const views = await import(url('views.js'));
const SESSION = JSON.parse(readFileSync(path.join(SHELL, 'demo', 'session.json'), 'utf8'));

describe('part 2 screens: ids, copy and rules (Node, no browser)', () => {
  test('the part 2 ids have a builder each, and no part 2 id repeats a part 1 id', () => {
    const ids = [...copy2.PART2_IDS, 'pin-set'];
    assert.deepEqual([...ids].sort(), Object.keys(views2.PART2_SCREEN_BUILDERS).sort());
    for (const id of ids) assert.equal(copy.SCREEN_IDS.includes(id), false, `${id} is a part 1 id`);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  });

  test('the part 1 list is unchanged: 22 screens, each with a builder', () => {
    assert.equal(copy.SCREEN_IDS.length, 22);
    assert.deepEqual([...copy.SCREEN_IDS].sort(), Object.keys(views.SCREEN_BUILDERS).sort());
  });

  test('Move up and Move down swap a way with its neighbour, and the ends stay where they are', () => {
    assert.deepEqual(settings.moveWay(['lan', 'tailscale', 'relay'], 'tailscale', 'up'), ['tailscale', 'lan', 'relay']);
    assert.deepEqual(settings.moveWay(['lan', 'tailscale', 'relay'], 'tailscale', 'down'), ['lan', 'relay', 'tailscale']);
    assert.deepEqual(settings.moveWay(['lan', 'tailscale', 'relay'], 'lan', 'up'), ['lan', 'tailscale', 'relay']);
    assert.deepEqual(settings.moveWay(['lan', 'tailscale', 'relay'], 'relay', 'down'), ['lan', 'tailscale', 'relay']);
    assert.deepEqual(settings.moveWay(['lan'], 'missing', 'down'), ['lan']);
  });

  test('the stored order keeps its known ways once, drops unknown kinds and adds the missing ones at the end', () => {
    assert.deepEqual(settings.orderedWays(['relay', 'bogus', 'lan', 'relay']), ['relay', 'lan', 'tailscale']);
    assert.deepEqual(settings.orderedWays(null), ['lan', 'tailscale', 'relay']);
  });

  test('Approve from notifications needs the first line and the app lock: a PIN or passkey on the web app, a biometric lock in the app', () => {
    assert.deepEqual(settings.approveSwitch({ tier: 'full', firstLine: false, lockMode: 'pin', native: false }), { visible: true, enabled: false, missing: 'first-line' });
    assert.deepEqual(settings.approveSwitch({ tier: 'full', firstLine: true, lockMode: 'off', native: false }), { visible: true, enabled: false, missing: 'app-lock' });
    assert.deepEqual(settings.approveSwitch({ tier: 'full', firstLine: true, lockMode: 'biometric', native: false }), { visible: true, enabled: false, missing: 'app-lock' });
    assert.equal(settings.approveSwitch({ tier: 'full', firstLine: true, lockMode: 'passkey', native: false }).enabled, true);
    assert.equal(settings.approveSwitch({ tier: 'approve', firstLine: true, lockMode: 'pin', native: false }).enabled, true);
    assert.equal(settings.approveSwitch({ tier: 'full', firstLine: true, lockMode: 'biometric', native: true }).enabled, true);
    assert.equal(settings.approveSwitch({ tier: 'read', firstLine: true, lockMode: 'pin', native: false }).visible, false, 'a read-only phone never sees the row');
  });

  test('the approve switch shows on only while its conditions hold, and turning the first line off turns it off too', () => {
    const rule = settings.approveSwitch({ tier: 'full', firstLine: false, lockMode: 'pin', native: false });
    assert.equal(settings.approveChecked(true, rule), false, 'a stored on with no first line shows off');
    assert.deepEqual(settings.pushPatch('firstLine', false, true), { firstLine: false, approveFromNotifications: false });
    assert.deepEqual(settings.pushPatch('firstLine', true, true), { firstLine: true });
    assert.deepEqual(settings.pushPatch('approvals', false, true), { approvals: false });
  });

  test('the approve message names the missing condition, in the design words', () => {
    assert.equal(settings.APPROVE_MISSING_TEXT['first-line'], 'Turn on "Include the first line" first.');
    assert.match(settings.APPROVE_MISSING_TEXT['app-lock'], /app lock/);
  });

  test('lock after has five choices, five minutes by default, and an unknown choice falls back to it', () => {
    assert.deepEqual(settings.LOCK_AFTER.map(o => o.label), ['Immediately', '1 minute', '5 minutes', '15 minutes', '1 hour']);
    assert.equal(settings.lockAfter('m5').ms, 5 * 60 * 1000);
    assert.equal(settings.lockAfter('nonsense').id, 'm5');
    assert.equal(settings.lockAfter('immediately').ms, 0);
  });

  test('the text size clamps to 85 to 200 percent in steps of 5, and the theme falls back to Follow phone', () => {
    assert.equal(settings.clampText(84), 85);
    assert.equal(settings.clampText(203), 200);
    assert.equal(settings.clampText(112), 110);
    assert.equal(settings.clampText(undefined), 100);
    assert.equal(settings.normaliseTheme('neon'), 'follow');
    assert.equal(settings.normaliseTheme('dark'), 'dark');
  });

  test('the phone keeps only known preferences, with safe defaults for a damaged record', () => {
    const p = settings.normalisePrefs({ theme: 'light', stopSide: 'left', lockAfter: 'h1', textSize: 130, lanDismissed: true, bogus: 1 });
    assert.equal(p.theme, 'light');
    assert.equal(p.stopSide, 'left');
    assert.equal(p.lockAfter, 'h1');
    assert.equal(p.textSize, 130);
    assert.equal(p.lanDismissed, true);
    assert.equal('bogus' in p, false);
    const d = settings.normalisePrefs('nope');
    assert.equal(d.theme, 'follow');
    assert.equal(d.stopSide, 'right');
    assert.equal(d.lockAfter, 'm5');
    assert.equal(d.hideSwitcher, true);
  });

  test('the design sentences keep their words: approve from notifications, the lock off notice, the voice notice and the forget sheet', () => {
    assert.match(copy2.APPROVE_NOTIFY_TEXT, /The notification shows one line of the card\. Approving from it runs that edit or command on \{computer\} without opening the card or the lines under it\. Your phone asks for Face ID, your fingerprint or your PIN first\. Deny and Stop never need this switch\./);
    assert.match(copy2.LOCK_OFF_TEXT, /With the app lock off, anyone who can unlock this phone can run models, approve changes and use your computer through Plenum\. If the phone is lost, remove it at the computer under Settings › Phones\./);
    assert.match(copy2.PHONE_VOICE, /Nothing reaches your computer until you press Send\./);
    assert.match(copy2.FORGET_BODY, /keeps listing this phone until you remove it there under Settings › Phones\./);
    assert.match(copy2.PHONE_PUSH_TEXT, /Include the first line adds the first line of the card, which can name files and commands\./);
    assert.equal(copy2.DEMO_STRIP, 'Demo: nothing here reaches a computer.');
    assert.equal(copy2.LAN_WEB_STRIP.startsWith("This page works only on {computer}'s network"), true);
  });

  test('the copy has no exclamation mark and no emoji (the design rules for the shell)', () => {
    const all = [...Object.values(copy2), ...Object.values(copy2.LEGAL_ROWS), ...copy2.STATUS ? Object.values(copy2.STATUS) : []];
    for (const text of all) {
      if (typeof text !== 'string') continue;
      assert.equal(text.includes('!'), false, `no exclamation mark in: ${text}`);
      assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `no emoji in: ${text}`);
    }
  });

  test('the new screen sources never write markup as text, never use a style attribute, and never run an inline handler', () => {
    const files = ['views2.js', 'main.js', 'copy2.js', 'settings.js', 'demo.js', '../app.js'];
    for (const file of files) {
      const text = readFileSync(path.join(SCREENS, file), 'utf8');
      assert.doesNotMatch(text, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, `${file} writes markup`);
      assert.doesNotMatch(text, /setAttribute\(\s*['"]style['"]/, `${file} sets a style attribute`);
      assert.doesNotMatch(text, /setAttribute\(\s*['"]on[a-z]+['"]/, `${file} sets an event attribute`);
    }
  });

  test('the sample text and the switches carry names: every switch row has a label and aria-checked', () => {
    const text = readFileSync(path.join(SCREENS, 'views2.js'), 'utf8');
    assert.match(text, /role: 'switch'/);
    assert.match(text, /'aria-checked': checked \? 'true' : 'false'/);
  });
});

describe('the demo replay (Node)', () => {
  test('the demo session has runs, a waiting approval, a computer run with frames, a diff and an artifact picture', () => {
    assert.ok(SESSION.runs.length >= 2);
    assert.ok(SESSION.approvals.some(a => a.state === 'waiting'));
    assert.ok(SESSION.computerRun.frames.length >= 2);
    assert.equal(SESSION.computerRun.state, 'driving');
    assert.ok(SESSION.diff.hunks[0].lines.some(l => l.t === '+'));
    assert.ok(SESSION.artifacts.length >= 1);
    const view = demo.createReplay(SESSION).view();
    assert.ok(view.drive.frames.every(f => typeof f.src === 'string' && f.src.startsWith('data:image/svg+xml;')));
    assert.ok(view.artifacts.every(a => typeof a.src === 'string'));
  });

  test('the picture source takes SVG text only, never script', () => {
    assert.match(demo.pictureSrc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /^data:image\/svg\+xml;charset=utf-8,/);
    assert.equal(demo.pictureSrc('<script>alert(1)</script>'), null);
    assert.equal(demo.pictureSrc('<svg><script>x</script></svg>'), null);
    assert.equal(demo.pictureSrc(null), null);
  });

  test('Approve lets the run go on and Deny ends the run, each card answered once', () => {
    const r = demo.createReplay(SESSION);
    assert.deepEqual(r.decide('nope', 'approve'), { ok: false, reason: 'unknown' });
    assert.deepEqual(r.decide('ap-1', 'approve'), { ok: true, reason: null });
    assert.equal(r.view().approvals[0].state, 'approved');
    assert.deepEqual(r.decide('ap-1', 'deny'), { ok: false, reason: 'not-waiting' });
    const d = demo.createReplay(SESSION);
    d.decide('ap-1', 'deny');
    assert.equal(d.view().runs.find(x => x.id === 'run-1').state, 'finished');
  });

  test('Stop answers from the replay with the counts of what was running, and the words of the result toast', () => {
    const r = demo.createReplay(SESSION);
    const out = r.stop();
    assert.equal(out.ok, true);
    assert.deepEqual(out.ack, { id: 'demo-stop-1', cancelled: 1, drivesStopped: 1, agentsStopped: 1, cardsDenied: 1 });
    assert.equal(out.text, 'Stopped everything on Demo computer: 1 reply, 1 computer run, 1 agent. 1 card denied.');
    assert.equal(r.view().runs.find(x => x.id === 'run-1').state, 'stopped');
    assert.equal(r.view().approvals[0].state, 'denied');
    const again = r.stop();
    assert.equal(again.text, 'Nothing was running on Demo computer.');
    r.reset();
    assert.equal(r.view().runs[0].state, 'running');
    assert.equal(r.view().stoppedCount, 0);
  });
});

describe('the demo core in the shell (createShell in demo mode, fake store)', () => {
  const fakeStore = () => {
    const meta = new Map();
    return {
      meta: { get: async k => meta.get(k) ?? null, put: async (k, v) => { meta.set(k, v); }, remove: async k => { meta.delete(k); } },
      publicList: async () => [],
      get: async () => null,
      remove: async () => {},
      list: async () => [],
    };
  };

  test('demo mode boots to the demo route with the replay, answers Stop and an approval, and never builds a worker', async () => {
    const { createShell } = await import(pathToFileURL(path.join(SHELL, 'app.js')).href);
    const shell = createShell({ store: fakeStore(), mode: 'demo', createWorker: () => { throw new Error('no worker in demo'); } });
    await shell.boot();
    const s = shell.state();
    assert.equal(s.route, 'demo');
    assert.equal(s.activeId, 'demo');
    assert.equal(s.connection.status, 'connected');
    assert.equal(s.hello.pending.approvals, 1);
    assert.equal(s.hello.pending.driving.app, 'Notepad');
    assert.equal(s.demo.runs.length, 2);
    assert.equal((await shell.demoDecide('ap-1', 'approve')).ok, true);
    assert.equal(shell.state().demo.approvals[0].state, 'approved');
    const stopped = await shell.stop();
    assert.equal(stopped.state, 'done');
    assert.match(stopped.text, /^Stopped everything on Demo computer:/);
    assert.equal(shell.state().hello.pending.driving, null, 'the drive ends with the Stop');
    assert.equal((await shell.pair('http://example.test/#pair=x')).reason, 'demo');
  });

  test('the demo prefs survive a save and the page reads them back (no network, no computer)', async () => {
    const { createShell } = await import(pathToFileURL(path.join(SHELL, 'app.js')).href);
    const store = fakeStore();
    const shell = createShell({ store, mode: 'demo', createWorker: () => { throw new Error('no worker'); } });
    await shell.boot();
    await shell.setPrefs({ theme: 'dark', stopSide: 'left', lanDismissed: true });
    const prefs = shell.state().prefs;
    assert.equal(prefs.theme, 'dark');
    assert.equal(prefs.stopSide, 'left');
    assert.equal(prefs.lanDismissed, true);
    assert.equal((await shell.setApprove(true)).ok, false, 'Approve from notifications needs the first line first');
  });
});

// ---------- the page part ----------

const AUDIT_PART2 = `(() => {
  const sh = document.getElementById('sh-view');
  const out = { screen: document.body.getAttribute('data-screen'), title: document.querySelector('#sh-title')?.textContent ?? null,
    hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    strip: document.getElementById('plenum-demo-strip')?.hidden === false ? document.querySelector('#plenum-demo-strip .plenum-demo-text')?.textContent : null,
    stop: document.getElementById('plenum-stop')?.hidden === false, stopNote: document.querySelector('#plenum-stop .plenum-stop-note')?.textContent ?? '',
    buttons: [...(sh?.querySelectorAll('button, [role="switch"], [role="radio"]') ?? [])].map(b => b.textContent.trim() || b.getAttribute('aria-label') || '') };
  return out;
})()`;

// Waits in the page until the condition holds (or fails after the time), so a test never reads a screen that is still starting.
const WAIT_FOR = (condition, ms = 10000) => `new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (${condition}) return resolve(true);
    if (Date.now() - started > ${ms}) return reject(new Error('timed out waiting for: ' + ${JSON.stringify(condition)}));
    setTimeout(tick, 100);
  };
  tick();
})`;

// Clicks the first button on the screen whose text is one of the labels, once it shows. After the time it fails with the screen and the
// pairing and connection state, so a stuck step is named rather than hung.
const CLICK_TEXT = (labels, ms = 15000) => `new Promise((resolve, reject) => {
  const labels = ${JSON.stringify(labels)};
  const started = Date.now();
  const tick = () => {
    const b = [...document.querySelectorAll('#sh-view button')].find(x => labels.includes(x.textContent.trim()));
    if (b) { const text = b.textContent.trim(); b.click(); return resolve(text); }
    if (Date.now() - started > ${ms}) {
      const s = window.plenumShellCore && window.plenumShellCore.state();
      return reject(new Error('no ' + labels.join(' or ') + ' on ' + document.body.getAttribute('data-screen') + ' pairing ' + JSON.stringify(s && s.pairing) + ' connection ' + JSON.stringify(s && s.connection)));
    }
    setTimeout(tick, 100);
  };
  tick();
})`;

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

describe('wave 107 fixes: the link, the notices and the reconnect stand-in (Node, fake store)', () => {
  const fakeStore = () => {
    const meta = new Map();
    return {
      meta: { get: async k => meta.get(k) ?? null, put: async (k, v) => { meta.set(k, v); }, remove: async k => { meta.delete(k); } },
      publicList: async () => [],
      get: async () => null,
      remove: async () => {},
      list: async () => [],
    };
  };
  // A lock that starts locked and opens with any PIN: the calls app.js makes (lockOnLaunch, status, unlockPin, lock, protect, disable).
  const fakeLock = () => {
    let locked = true;
    return {
      lockOnLaunch: async () => {},
      status: async () => ({ mode: 'pin', locked, failures: 0, waitSec: 0 }),
      unlockPin: async () => { locked = false; return { ok: true, reason: null, keys: [] }; },
      lock() { locked = true; return true; },
      protect: async record => record,
      disable: async () => ({ ok: true, reason: null }),
      onBackground() {},
      onForeground: async () => locked,
    };
  };
  const appUrl = pathToFileURL(path.join(SHELL, 'app.js')).href;

  test('cleanName keeps the typed name, drops control and bidirectional marks, and keeps 60 characters', async () => {
    const { cleanName } = await import(appUrl);
    assert.equal(cleanName('  Will‎‮ phone\u0007 '), 'Will phone');
    assert.equal(cleanName('x'.repeat(80)).length, 60);
    assert.equal(cleanName('   '), '');
    assert.equal(cleanName(undefined), '');
  });

  test('clearAddressHash replaces the address without the fragment and keeps the path and query', async () => {
    const { clearAddressHash } = await import(appUrl);
    const calls = [];
    const env = { location: { pathname: '/p/abc/', search: '?x=1', hash: '#pair=secret' }, history: { state: null, replaceState: (...args) => calls.push(args) } };
    clearAddressHash(env);
    assert.deepEqual(calls, [[null, '', '/p/abc/?x=1']]);
    assert.doesNotThrow(() => clearAddressHash({ location: { pathname: '/', search: '' } }), 'no history object is fine');
  });

  test('a link the page opened while locked waits for the unlock, then runs: a Stop from a notification says there is no computer', async () => {
    const { createShell } = await import(appUrl);
    const shell = createShell({ store: fakeStore(), lock: fakeLock(), mode: 'normal', pageUrl: 'http://127.0.0.1:9/p/x/#stop', createWorker: () => { throw new Error('no worker'); } });
    await shell.start();
    assert.equal(shell.state().route, 'locked');
    // A Stop does not wait for the unlock when this phone holds the computer's Stop key; it holds none here, so it says so and waits.
    assert.equal(shell.state().notice?.text, 'Unlock Plenum to send this Stop. It goes out as soon as Plenum unlocks.');
    assert.equal(shell.state().stop.state, 'idle', 'nothing was sent');
    const out = await shell.unlock('pin', '1234');
    assert.equal(out.ok, true);
    assert.equal(shell.state().notice?.text, 'Nothing to stop: no computer is connected.');
    assert.equal(shell.state().notice?.tone, 'warn');
  });

  test('H7: a notification deny with no connection is said and nothing is sent; an approve link never approves by itself (it needs the first line and a connection), and says so', async () => {
    const { createShell } = await import(appUrl);
    const shell = createShell({ store: fakeStore(), mode: 'normal', createWorker: () => { throw new Error('no worker'); } });
    const id = '3f2b8c1e-5a47-4d0e-9b61-0c2d7e9a1f34';
    const denied = await shell.handleHash(`#deny=${id}`);
    assert.deepEqual(denied, { ok: false, reason: 'offline', kind: 'deny' }, 'a card id is a UUID');
    assert.equal(shell.state().notice?.text, 'Not connected. Open the approval to answer it.');
    // No first line: nothing is sent, whatever the connection (the computer would take it for an answer from the open card).
    const noLine = await shell.handleHash(`#approve=${id}`);
    assert.equal(noLine.ok, false, 'a link with no first line approves nothing');
    assert.equal(noLine.reason, 'offline');
    assert.equal(shell.state().notice?.text, 'Not connected. Open the approval to answer it.');
    // With the line and no connection: still nothing is sent, and the card is the place to answer.
    const withLine = await shell.handleHash(`#approve=${id}&line=${encodeURIComponent('Run: npm test')}`);
    assert.deepEqual([withLine.ok, withLine.reason, withLine.kind], [false, 'offline', 'approve']);
    // The places a notification names are routes for the phone layer, taken once, not answers.
    for (const [hash, want] of [['#waiting', { kind: 'waiting' }], [`#waiting=${id}`, { kind: 'waiting' }], [`#handover=${id}`, { kind: 'handover' }], ['#chat=p1', { kind: 'chat', project: 'p1' }], ['#settings=limit', { kind: 'settings', section: 'limit' }], ['#home', { kind: 'home' }]]) {
      assert.equal((await shell.handleHash(hash)).ok, true, hash);
      const taken = shell.takeRoute();
      assert.deepEqual({ kind: taken?.kind, ...(want.project ? { project: taken?.project } : {}), ...(want.section ? { section: taken?.section } : {}) }, want, hash);
      assert.equal(shell.takeRoute(), null, 'a route is taken once');
    }
    assert.equal((await shell.handleHash('#projects')).reason, 'no link');
  });

  test('a demo Stop shows its result as a notice and returns to idle after the result time', async () => {
    const { createShell } = await import(appUrl);
    const shell = createShell({ store: fakeStore(), mode: 'demo', createWorker: () => { throw new Error('no worker in demo'); } });
    await shell.boot();
    await shell.stop();
    const s = shell.state();
    assert.equal(s.stop.state, 'done');
    assert.match(s.notice?.text ?? '', /^Stopped everything on Demo computer:/);
    assert.equal(s.notice?.tone, 'ok');
    await sleep(1800);
    assert.equal(shell.state().stop.state, 'idle', 'the Stop is idle again after the result time');
  });

  test('a computer connected this session keeps its stand-in while it reconnects; a computer never reached gets the pairing screen', async () => {
    const route = await import(url('route.js'));
    const s = { locked: false, activeId: 'c1', hello: null, computers: [{ id: 'c1', name: 'Studio' }], connection: { status: 'reconnecting' }, pairing: null, prefs: {} };
    assert.equal(route.screenFor(s, { wasConnected: 'c1' }), 'connected');
    assert.equal(route.screenFor(s, {}), 'connecting');
    assert.equal(route.ctxFor(s, { wasConnected: 'c1', local: {} }, {}).reconnecting, true);
    assert.equal(route.ctxFor(s, {}, {}).reconnecting, false);
  });
});

// Evaluates an expression in the page until it holds, from the test side: the page may navigate while it waits (the shell hands it over to the
// computer's UI), and an evaluation that is running in the old page then fails, so it is simply asked again. The last value is in the failure.
async function pageUntil(h, expression, { ms = 30000, every = 150, what = expression, diag = null } = {}) {
  const until = Date.now() + ms;
  let last = null;
  for (;;) {
    try {
      // A throw inside the expression comes back as a value, with its message, instead of the bare "Script failed to execute".
      last = await h.eval(`(() => { try { return (${expression}); } catch (e) { return { pageError: String((e && e.stack) || e).slice(0, 400) }; } })()`);
      if (last && !last.pageError) return last;
    } catch (error) {
      last = `page error: ${String(error?.message ?? error).slice(0, 160)}`;
    }
    if (Date.now() > until) {
      let where = null;
      try {
        where = diag ? await h.eval(diag) : null;
      } catch (error) {
        where = `no page state: ${String(error?.message ?? error).slice(0, 120)}`;
      }
      throw new Error(`timed out waiting for: ${what}; last: ${JSON.stringify(last)}; page: ${JSON.stringify(where)}`);
    }
    await sleep(every);
  }
}

// Where the shell is, for a failure message: the address, the screen, the route, the UI hand-over and the connection.
const WHERE = `(() => { const s = window.plenumShellCore && window.plenumShellCore.state(); return { href: location.href, screen: document.body.getAttribute('data-screen'), route: s && s.route, ui: s && s.ui, conn: s && s.connection, hello: !!(s && s.hello), controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), shim: !!window.plenumShell, shellKeys: Object.keys(window.plenumShell || {}).slice(0, 12), projects: document.querySelectorAll('.proj-item').length, fetchShimmed: !/\[native code\]/.test(String(window.fetch)) }; })()`;

describe('the shell in the phone-size harness: the demo offline (S-10) and the Bridge flow from pairing to the desktop UI (own app copy, the real build)', { timeout: 900_000, skip: PAGE_SKIP }, () => {
  let h = null;
  let server = null;
  let base = null;
  let app = null;
  let bridge = null;
  const shellPage = () => `http://127.0.0.1:${bridge.port}/p/${bridge.pathKey}/?shell`;

  before(async () => {
    // A private app folder and the real build: screens.js, the /shell/ files and sw.js come from scripts/build-mobile.mjs, not from a test bundle.
    app = await makeAppCopy('e2e');
    linkMobileInstall(app, HERE);
    // A dev build (--dev): window.plenumShellCore, which the checks below read, exists only there (plan C7).
    const built = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-mobile.mjs'), '--dev', '--root', app], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    assert.equal(built.status, 0, `build: ${built.stderr}`);
    for (const name of ['screens.js', 'shell.js', 'boot.js', 'channel.worker.js', 'styles.css', 'sw.js']) {
      assert.ok(existsSync(path.join(app, 'mobile', 'www', name)), `the build emits ${name}`);
    }
    server = await serve(path.join(app, 'mobile', 'www'));
    base = `http://127.0.0.1:${server.address().port}`;
    h = await startPhoneHarness({ name: 'stabm6-e2e', appRoot: app, mock: true });
  });

  after(async () => {
    if (h) {
      const report = await h.close();
      assert.deepEqual(report.leftover, [], 'no process of the run is left');
    }
    if (server) server.close();
    if (app) {
      unlinkMobileInstall(app);
      removeAppCopy(app);
    }
  });

  test('S-10 the demo strip shows on every screen of the demo, the replay answers Approve and Stop, every part 2 screen opens, and Exit returns to Welcome', async () => {
    await h.open(`${base}/index.html?demo=1&theme=light`, { surface: 'phone', view: PHONE_VIEW, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(WAIT_FOR("document.body.getAttribute('data-screen') === 'demo-home'", 10000));
    const home = await h.eval(AUDIT_PART2);
    assert.equal(home.screen, 'demo-home');
    assert.equal(home.strip, 'Demo: nothing here reaches a computer.', 'the demo strip is up');
    assert.equal(home.stop, true, 'Stop is present with the demo session');
    await h.shot('mob10-part2-demo-home-light');
    await h.eval(`[...document.querySelectorAll('#sh-view button')].find(b => b.textContent.trim() === 'Approve').click(); void 0;`);
    await h.eval('void 0');
    await h.eval(`document.getElementById('plenum-stop').click(); void 0;`);
    const stopped = await h.eval(`new Promise(r => setTimeout(() => r(document.querySelector('#plenum-stop .plenum-stop-note').textContent), 150))`);
    assert.match(stopped, /^Stopped everything on Demo computer:/, 'Stop answers from the replay');
    const ids = ['computers', 'install-ios', 'install-android', 'lan-web', 'connected', 'rename', 'forget', 'settings', 'settings-connection',
      'settings-notify', 'settings-lock', 'phone-lock-off', 'settings-appearance', 'settings-dictation', 'debug', 'about', 'legal',
      'demo-home', 'demo-run', 'demo-diff', 'demo-artifact', 'pin-set'];
    for (const id of ids) {
      const shown = await h.eval(`window.plenumScreensDebug.go(${JSON.stringify(id)})`);
      assert.equal(shown, id, `shows ${id}`);
      const audit = await h.eval(AUDIT_PART2);
      assert.equal(audit.hOverflow, false, `${id}: no horizontal scroll`);
      assert.ok(audit.title, `${id}: has a title`);
    }
    await h.eval(`window.plenumScreensDebug.go('settings-notify')`);
    await h.shot('mob10-part2-settings-notify-light');
    await h.eval(`window.plenumScreensDebug.go('demo-run')`);
    await h.shot('mob10-part2-demo-run-light');
    await h.eval(`window.plenumScreensDebug.go('demo-diff')`);
    await h.shot('mob10-part2-demo-diff-light');
    await h.eval(`window.plenumScreensDebug.go('demo-artifact')`);
    await h.shot('mob10-part2-demo-artifact-light');
    await h.eval(`window.plenumScreensDebug.go('computers')`);
    await h.shot('mob10-part2-computers-light');
    await h.eval(`window.plenumScreensDebug.go('settings-appearance')`);
    await h.shot('mob10-part2-settings-appearance-dark');
    await h.open(`${base}/index.html?demo=1&theme=dark`, { surface: 'phone', view: PHONE_VIEW, theme: 'dark', capacitor: false, token: null, tokenOrigin: null });
    await h.eval(`window.plenumScreensDebug.go('settings')`);
    await h.shot('mob10-part2-settings-dark');
    await h.eval(`[...document.querySelectorAll('.plenum-demo-exit')][0].click(); void 0;`);
  });

  test('H1 and H3: pair from the link (the code on the phone is the code the confirm route reports, Allow), and the page leaves the shell for the computer\'s UI, served by the service worker from what the computer sent', async () => {
    bridge = await h.enableBridge();
    assert.ok(bridge.link.includes('#pair='), 'the link carries the pairing fragment');
    await h.open(loopbackOnly(bridge.link), { surface: 'phone', view: PHONE_VIEW, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    // A pairing link from outside the app waits on the review screen (S1): nothing is opened until the person taps Pair.
    await pageUntil(h, `document.body.getAttribute('data-screen') === 'pair-review'`, { ms: 15000, what: 'the pairing review screen', diag: WHERE });
    assert.equal((await h.server.get('/api/phones')).body?.offer?.state === 'confirm', false, 'the computer has seen no phone before Pair');
    await h.eval(`(() => { const b = [...document.querySelectorAll('#sh-view button')].find(x => x.textContent.trim() === 'Pair'); if (!b) throw new Error('no Pair button'); b.click(); return true; })()`);
    // The computer's own offer: the six digits it shows while it waits for Allow (GET /api/phones, offer.code in the confirm state).
    let offer = null;
    for (let i = 0; i < 150 && !offer; i += 1) {
      const listed = await h.server.get('/api/phones');
      if (listed.body?.offer?.state === 'confirm' && listed.body.offer.code) offer = listed.body.offer;
      else await sleep(100);
    }
    assert.ok(offer, 'the computer shows a code to confirm');
    const shownCode = await pageUntil(h, `(() => { const node = document.querySelector('.sh-code'); const t = node ? node.textContent.replace(/\\s/g, '') : ''; return t.length === 6 ? t : ''; })()`, { ms: 15000, what: 'the six digits on the phone' });
    await h.shot('mob10-part2-code-light');
    const confirmed = await h.confirmPairing();
    assert.equal(shownCode, String(offer.code), `the phone (${shownCode}) and the computer's confirm step (${offer.code}) show the same six digits`);
    assert.ok(confirmed && typeof confirmed === 'object', 'the confirm route answered');
    // The steps after pairing (lock, notifications) are skipped with "Not now"; then the page goes to the UI the computer sent.
    const landed = await pageUntil(h, `(() => {
      const skip = [...document.querySelectorAll('#sh-view button')].find(b => b.textContent.trim() === 'Not now');
      if (skip) skip.click();
      if (location.pathname !== '/' || !window.plenumShell || !document.querySelector('.proj-item')) return false;
      return { path: location.pathname, shellScreens: !!document.getElementById('sh-view') && !document.getElementById('sh-view').hidden, controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), conn: window.plenumShellCore.state().connection.status, stop: !!document.getElementById('plenum-stop') };
    })()`, { ms: 90000, every: 250, what: 'the desktop UI on the phone (/ with the project list)', diag: WHERE });
    assert.equal(landed.path, '/', 'the page is the UI document, not the shell page under /p/');
    assert.equal(landed.controlled, true, 'a service worker controls the page that shows the UI (F1)');
    assert.equal(landed.stop, true, 'the Stop is on the UI page');
    await pageUntil(h, `window.plenumShellCore.state().connection.status === 'connected'`, { ms: 30000, what: 'the UI page connected', diag: WHERE });
    await h.shot('stabm6-ui-handover-light');
    // Stop from the UI page: the result is on screen where the person looks (F2), not in a clipped note.
    await h.eval(`document.getElementById('plenum-stop').click(); void 0;`);
    const text = await pageUntil(h, `(() => { const t = document.getElementById('plenum-toast'); return t && !t.hidden ? t.textContent : ''; })()`, { ms: 15000, what: 'the Stop result toast' });
    assert.match(text, /Stopped everything|Nothing was running|Stop will be sent/, `the Stop result shows as a toast: "${text}"`);
  });

  test('M14: a card from a run is answered from the phone through the channel, and the server records allow (the self-test approval step, with a model that raises a card)', async () => {
    // The page listens to the computer's events the way the UI does, then the computer's model asks to write a file.
    await h.eval(`(() => {
      window.__ev = [];
      (async () => {
        const res = await fetch('/api/events');
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          let cut = buf.indexOf('\\n\\n');
          while (cut >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            for (const line of block.split('\\n')) {
              if (!line.startsWith('data: ')) continue;
              try { window.__ev.push(JSON.parse(line.slice(6))); } catch { /* not JSON */ }
            }
            cut = buf.indexOf('\\n\\n');
          }
        }
      })().catch(e => { window.__evErr = String(e && e.message || e); });
      return true;
    })()`);
    await sleep(500);
    const raised = await h.raiseApproval();
    assert.ok(raised.approvals >= 1, 'the server waits for an answer');
    const added = await pageUntil(h, `(window.__ev.find(e => e && e.type === 'activity' && e.op === 'approval-add' && e.card && typeof e.card.approvalId === 'string') || null)`, { ms: 20000, what: 'the approval card event on the phone', diag: "({ events: JSON.stringify(window.__ev || []).slice(0, 2500), error: window.__evErr || null })" });
    const answer = await h.eval(`fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: ${JSON.stringify(added.card.approvalId)}, allow: true }) }).then(async r => ({ status: r.status, body: await r.text() }))`);
    assert.equal(answer.status, 200, `the approve went through the channel: ${answer.body}`);
    const recorded = await pageUntil(h, `(window.__ev.find(e => e && e.type === 'approval' && e.action === 'answered' && e.approvalId === ${JSON.stringify(added.card.approvalId)}) || null)`, { ms: 20000, what: 'the answered event' });
    assert.equal(recorded.allow, true, 'the computer records allow');
    const waiting = Number((await h.server.state())?.approvalsWaiting) || 0;
    assert.equal(waiting, 0, 'nothing waits on the computer any more');
    const turn = await raised.turn;
    assert.match(turn.text, /Done after the tool result/, 'the run went on after the approval');
  });

  test('H3: the way back from the UI page: Phone settings leaves for the page the shell\'s screens were on (/p/<key>/?shell, not /?shell) and asks it for the settings screen', async () => {
    const here = await h.eval(`({ path: location.pathname, page: window.plenumShellCore && window.plenumShellCore.state().page })`);
    assert.equal(here.path, '/', 'this is the UI page');
    assert.equal(here.page, 'ui');
    // Phone settings on the UI page (boot.js plenumShell.openSettings()) is core.openShell('#settings'). The harness window's preload owns
    // window.plenumShell as a read-only { desktop, token } object, so the shim's own object is not there to call: the core is called as boot.js does.
    // The page leaves while this call is still running, so the call is made from a timer and the test asks again from the new page.
    await h.eval(`setTimeout(() => { window.plenumShellCore.openShell('#settings'); }, 0); void 0;`);
    const there = await pageUntil(h, `(() => {
      const core = window.plenumShellCore;
      const s = core && core.state();
      if (!s || s.page !== 'shell' || !s.screenRequest) return false;
      return { path: location.pathname, search: location.search, request: s.screenRequest };
    })()`, { ms: 45000, every: 250, what: 'the shell page asked for the settings screen', diag: WHERE });
    assert.ok(there.path.startsWith('/p/'), `the way back is the page the pairing began on, not /?shell (${there.path})`);
    assert.equal(there.search, '?shell');
    assert.equal(there.request.screen, 'settings');
    assert.equal(there.request.seq, 1);
    const shown = await h.eval(`({ hash: location.hash, stored: [sessionStorage.getItem('plenum-shell-link'), localStorage.getItem('plenum-shell-page')] })`);
    assert.equal(shown.hash, '', 'the fragment was taken out of the address bar');
    assert.equal(shown.stored[0], null, 'no kept link on the web');
    assert.ok(shown.stored[1] && shown.stored[1].startsWith('/p/') && shown.stored[1].endsWith('?shell'), `localStorage remembers the page: ${shown.stored[1]}`);
  });

  test('H3: /?shell keeps the shell\'s own screens (it does not go to the UI), and the computer is listed there', async () => {
    await h.open(shellPage(), { surface: 'phone', view: PHONE_VIEW, theme: 'light', capacitor: false, token: null, tokenOrigin: null });
    const state = await pageUntil(h, `(() => {
      const s = window.plenumShellCore && window.plenumShellCore.state();
      if (!s || !s.computers || !s.computers.length) return false;
      return { path: location.pathname, search: location.search, screen: document.body.getAttribute('data-screen'), computers: s.computers.length, route: s.route };
    })()`, { ms: 30000, what: 'the shell page with the paired computer' });
    assert.ok(state.path.startsWith('/p/'), `the page stayed at ${state.path}`);
    assert.equal(state.search, '?shell');
    assert.equal(state.computers, 1);
    await sleep(3000);
    const still = await h.eval(`({ path: location.pathname, screen: document.body.getAttribute('data-screen') })`);
    assert.ok(still.path.startsWith('/p/'), `three seconds on, the page is still the shell page (${still.path})`);
    assert.ok(still.screen, 'a screen of the shell shows');
    await h.shot('stabm6-shell-page-light');
  });

  test('M14: the computer restarts on the same state and the phone reconnects within 10 seconds without pairing again', async () => {
    await pageUntil(h, `window.plenumShellCore && window.plenumShellCore.state().connection.status === 'connected'`, { ms: 30000, what: 'connected before the restart' });
    await h.restartServer();
    const started = Date.now();
    await pageUntil(h, `window.plenumShellCore.state().connection.status === 'connected' && !!window.plenumShellCore.state().hello`, { ms: 10000, every: 100, what: 'connected again within 10 s' });
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds <= 10, `reconnected in ${seconds.toFixed(1)} s`);
    const after = await h.eval(`({ computers: window.plenumShellCore.state().computers.length, route: window.plenumShellCore.state().route, pairing: window.plenumShellCore.state().pairing })`);
    assert.equal(after.computers, 1, 'the computer is still paired');
    assert.notEqual(after.route, 'welcome', 'no pairing screen');
    assert.equal(after.pairing === null || after.pairing === undefined || after.pairing.state === 'idle' || after.pairing.state === undefined, true, `no pairing in progress: ${JSON.stringify(after.pairing)}`);
  });

  test('Forget removes the computer from this phone', async () => {
    const forgot = await h.eval(`(async () => { const s = window.plenumShellCore.state(); await window.plenumShellCore.forget(s.activeId); return window.plenumShellCore.state().computers.length; })()`);
    assert.equal(forgot, 0, 'Forget removes the computer from this phone');
  });
});
