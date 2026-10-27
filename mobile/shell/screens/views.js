// The 22 shell screens of part 1 (mob-10, wave 106; MOBILE-UI 6.1 to 6.16). Each builder takes the render context (route.js ctxFor
// or fixtures.js fixtureCtx) and `io`, the only way a screen reaches the shell:
//   io.act.*    actions (main.js: tryDemo, consent, pair, readClipboard, openSettings, openLegal, cancelConnect, retry, mismatch,
//               enableLock, enableNotifications, unlock, unlockAndStop, forgetActive, sendLog, useCopy, chooseComputer, openStore)
//   io.local    what the screen keeps while open (phoneName, consentDeclined, bioMessage, pinMessage)
//   io.go(id), io.back(), io.advance(), io.later(fn, ms)
// A screen never touches the channel, the store or the keys. Text goes in with textContent only.

import { button, el } from './dom.js';
import * as C from './copy.js';
import * as C2 from './copy2.js';
import { clock, codeLabel, codeSpaced, fill, plural } from './copy.js';
import { failedLines } from './route.js';
import { STORE_LINKS } from './flows.js';

const LOCK_SCREENS = Object.freeze(['lock-bio', 'lock-pin']);

// The line for secure storage that did not load (C6d). It sits at the top of a screen that cannot keep anything.
const storageLine = ctx => (ctx.storageUnavailable ? el('p', { class: 'sh-msg sh-warn', role: 'note', text: C2.STORAGE_UNAVAILABLE }) : null);

// The shared frame (MOBILE-UI 6): top row with an optional back control, the title (h1), the body, and the actions pinned to the
// bottom with the primary button last. A session shows the floating Stop, so the actions keep 80 px clear of it on the right.
export function frame(ctx, io, o) {
  const classes = ['sh-screen'];
  if (ctx.session && !LOCK_SCREENS.includes(ctx.id)) classes.push('sh-has-stop');
  if (ctx.stripInfo) classes.push('sh-has-strip');
  if (o.center) classes.push('sh-center');
  const back = o.back
    ? el('button', { type: 'button', class: 'sh-icon', 'aria-label': 'Back', on: { click: () => io.back() } }, '‹')
    : el('span', { class: 'sh-icon-gap', 'aria-hidden': 'true' });
  const head = el('header', { class: 'sh-top' }, back, o.trailing ?? null);
  const title = el('h1', { class: 'sh-title', id: 'sh-title', tabindex: '-1' }, o.title);
  const main = el('main', { class: 'sh-main', id: 'sh-main' },
    o.lead ?? null,
    o.kicker ? el('p', { class: o.kickerClass ?? 'sh-kicker' }, o.kicker) : null,
    title,
    o.body ?? null,
    ctx.linkMessage ? el('p', { class: 'sh-msg', role: 'alert', text: ctx.linkMessage }) : null);
  const actions = (o.actions ?? []).filter(Boolean);
  const foot = actions.length ? el('footer', { class: 'sh-actions' }, actions) : null;
  const root = el('div', { class: classes.join(' '), 'data-screen': ctx.id }, head, main, foot);
  return root;
}

export const para = (text, cls = null) => el('p', { class: cls, text });

export function mark(size) {
  return el('img', { class: 'sh-mark', src: 'icons/app.svg', alt: '', width: String(size), height: String(size) });
}

// ---- welcome (6.1) ----
function welcome(ctx, io) {
  const declined = Boolean(io.local.consentDeclined);
  const needsConsent = ctx.platform === 'ios' && !ctx.consentGiven;
  const input = el('input', { class: 'sh-input', id: 'sh-name', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '64', 'aria-describedby': 'sh-name-help' });
  input.value = io.local.phoneName ?? ctx.phoneName;
  input.addEventListener('input', () => { io.local.phoneName = input.value; });
  const [first, second] = C.welcomePrivacy(ctx.forwarder);
  return frame(ctx, io, {
    title: C.WELCOME_TITLE,
    lead: mark(72),
    body: [
      storageLine(ctx),
      para(C.WELCOME_LEAD),
      para(`${first} ${second}`, 'sh-note'),
      el('div', { class: 'sh-field' },
        el('label', { class: 'sh-label', for: 'sh-name', text: "This phone's name" }),
        input,
        para('Your computer shows this name.', 'sh-help')),
      declined ? el('button', { type: 'button', class: 'sh-link sh-consent-line', on: { click: () => io.go('consent') } }, C.NEEDS_CONSENT) : null,
    ],
    actions: [
      button('Try the demo', { kind: 'ghost', onClick: () => io.act.tryDemo() }),
      button('Pair with your computer', { kind: 'primary', disabled: declined, onClick: () => io.go(needsConsent ? 'consent' : 'how') }),
    ],
  });
}

// ---- consent (6.2, iOS app only) ----
function consent(ctx, io) {
  return frame(ctx, io, {
    title: 'Before you pair',
    back: true,
    body: [
      para(C.CONSENT_TEXT),
      el('div', { class: 'sh-links' },
        button('Privacy Notice', { kind: 'link', onClick: () => io.act.openLegal('privacy') }),
        button('Third-party services', { kind: 'link', onClick: () => io.act.openLegal('third-party') })),
    ],
    actions: [
      button('Not now', { kind: 'ghost', onClick: () => { io.local.consentDeclined = true; io.go('welcome'); } }),
      button('Allow', { kind: 'primary', onClick: () => { io.act.consent(true); io.go('how'); } }),
    ],
  });
}

// ---- how (6.3) ----
function how(ctx, io) {
  const steps = C.HOW_STEPS.map(text => el('li', { text }));
  const actions = ctx.lan
    ? [button('Paste a link', { kind: 'primary', onClick: () => io.go('paste') })]
    : [button('Paste a link', { kind: 'ghost', onClick: () => io.go('paste') }), button('Scan the code', { kind: 'primary', onClick: () => io.go('scan') })];
  return frame(ctx, io, {
    title: 'Pair with your computer',
    back: true,
    body: [
      el('ol', { class: 'sh-steps' }, steps),
      para(C.HOW_NOTE, 'sh-note'),
      ctx.lan ? para(C.LAN_NO_CAMERA, 'sh-note') : null,
      ctx.install ? el('div', { class: 'sh-links' },
        button(ctx.install === 'ios' ? 'Add Plenum to your Home Screen first' : 'Install Plenum first', { kind: 'link', onClick: () => io.go(ctx.install === 'ios' ? 'install-ios' : 'install-android') })) : null,
    ],
    actions,
  });
}

// ---- scan (6.4) ----
function scan(ctx, io) {
  if (ctx.cameraDenied) return scanDenied(ctx, io);
  // The browser shows its camera in this element; the native apps open the scanner plugin's own camera instead, so theirs stays hidden.
  const video = el('video', { class: 'sh-video', playsinline: true, muted: true, autoplay: true, hidden: ctx.platform !== 'web', 'aria-hidden': 'true' });
  video.muted = true;
  const viewfinder = el('div', { class: 'sh-viewfinder', role: 'img', 'aria-label': 'Camera view. Point at the code on your computer.' },
    video,
    el('span', { class: 'sh-corner sh-c1', 'aria-hidden': 'true' }),
    el('span', { class: 'sh-corner sh-c2', 'aria-hidden': 'true' }),
    el('span', { class: 'sh-corner sh-c3', 'aria-hidden': 'true' }),
    el('span', { class: 'sh-corner sh-c4', 'aria-hidden': 'true' }));
  // The camera starts when the screen is up (app main.js startScan); a page without a camera API goes on to the paste screen, and a denied
  // camera is the denied screen.
  io.later(() => { io.act.startScan?.(video); }, 0);
  return frame(ctx, io, {
    title: 'Scan the code',
    back: true,
    body: [
      viewfinder,
      para(C.SCAN_HINT, 'sh-note sh-center-text'),
      el('p', { class: 'sh-note sh-scan-note', role: 'status' }, io.local.scanNote ?? null),
    ],
    actions: [button('Paste a link', { kind: 'ghost', onClick: () => io.go('paste') })],
  });
}

function scanDenied(ctx, io) {
  return frame(ctx, io, {
    title: 'Scan the code',
    back: true,
    body: [para(C.SCAN_DENIED, 'sh-note')],
    actions: [
      button('Paste a link', { kind: 'ghost', onClick: () => io.go('paste') }),
      button('Open Settings', { kind: 'primary', onClick: () => io.act.openSettings('camera') }),
    ],
  });
}

// ---- scan-denied (6.4) is its own id ----
function scanDeniedScreen(ctx, io) {
  return scanDenied({ ...ctx, cameraDenied: true }, io);
}

// ---- paste (6.5) ----
function paste(ctx, io) {
  const area = el('textarea', { class: 'sh-input sh-textarea', id: 'sh-link', rows: '4', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'sh-link-err' });
  area.value = io.local.link ?? '';
  area.addEventListener('input', () => { io.local.link = area.value; });
  const errorKey = ctx.pasteError ?? null;
  const error = errorKey ? C.PASTE_ERRORS[errorKey] : null;
  const native = ctx.platform !== 'web';
  return frame(ctx, io, {
    title: 'Paste a link',
    back: true,
    body: [
      el('div', { class: 'sh-field' },
        el('label', { class: 'sh-label', for: 'sh-link', text: 'Pairing link' }),
        area),
      el('p', { class: 'sh-msg', id: 'sh-link-err', role: 'alert' }, error),
    ],
    actions: [
      native ? button('Paste from clipboard', { kind: 'ghost', onClick: () => io.act.readClipboard(text => { area.value = text; io.local.link = text; }) }) : null,
      button('Connect', { kind: 'primary', onClick: () => io.act.pair(area.value) }),
    ],
  });
}

// ---- localnet (6.6, iOS app) ----
function localnet(ctx, io) {
  const denied = Boolean(ctx.localDenied);
  return frame(ctx, io, {
    title: 'Find your computer on this Wi-Fi',
    back: true,
    body: [para(denied ? C.LOCALNET_DENIED : `To reach ${ctx.computer} on this network, ${C.LOCALNET_BODY}`)],
    actions: denied
      ? [
        button('Try other ways', { kind: 'ghost', onClick: () => io.go('how') }),
        button('Open Settings', { kind: 'primary', onClick: () => io.act.openSettings('local-network') }),
      ]
      : [button('Continue', { kind: 'primary', onClick: () => { io.act.continueLocalNet(); io.back(); } })],
  });
}

// ---- connecting (6.7) ----
function connecting(ctx, io) {
  // The carrier is the one the connection is using; none is named until the core says which (no guessed "Same network").
  const carrier = C.CARRIER_LABEL[ctx.carrier] ?? ctx.carrierLabel ?? null;
  const step = (state, label, note) => {
    const mark = state === 'done' ? '✓' : state === 'active' ? '◌' : '○';
    const status = state === 'done' ? 'done' : state === 'active' ? 'in progress' : 'waiting';
    return el('li', { class: `sh-step sh-step-${state}` },
      el('span', { class: 'sh-step-mark', 'aria-hidden': 'true' }, mark),
      el('span', { class: 'sh-step-text' },
        el('span', { class: 'sh-sr' }, `${status}: `),
        label,
        note ? el('span', { class: 'sh-step-note', text: note }) : null));
  };
  return frame(ctx, io, {
    title: `Connecting to ${ctx.computer}`,
    body: [el('ul', { class: 'sh-steps sh-progress-list' },
      step('done', 'Read the code'),
      step('active', fill('Reaching {computer}', ctx.computer), carrier),
      step('waiting', 'Checking the code'))],
    actions: [button('Cancel', { kind: 'ghost', onClick: () => io.act.cancelConnect() })],
  });
}

// ---- failed (6.7, every carrier failed) ----
function failed(ctx, io) {
  const lines = failedLines(ctx).map(line => el('li', { class: 'sh-line' },
    el('span', { class: 'sh-bullet', 'aria-hidden': 'true' }),
    el('span', { text: line.text })));
  const busy = ctx.tried.some(t => t.reason === 'busy');
  return frame(ctx, io, {
    title: `Could not reach ${ctx.computer}`,
    body: [
      storageLine(ctx),
      el('ul', { class: 'sh-lines' }, lines),
      busy ? para(fill(C.FAILED_LINES.busy, ctx.computer), 'sh-note') : null,
    ],
    actions: [button('Try again', { kind: 'primary', onClick: () => io.act.retry() })],
  });
}

// ---- code (6.8) ----
function code(ctx, io) {
  const countdown = el('p', { class: 'sh-countdown' },
    el('span', { text: `Waiting for Allow on ${ctx.computer} ` }),
    el('span', { 'data-countdown': '', text: clock(ctx.countdown ?? 120) }));
  return frame(ctx, io, {
    title: C.PAIRING_CHECK,
    body: [
      el('p', { class: 'sh-code', role: 'img', 'aria-label': codeLabel(ctx.code), text: codeSpaced(ctx.code) }),
      para(`${ctx.computer} ${C.CODE_TEXT}`, 'sh-note'),
      countdown,
    ],
    actions: [button('The codes do not match', { kind: 'danger', onClick: () => io.act.mismatch() })],
  });
}

// ---- mismatch, denied, expired (6.8) ----
function mismatch(ctx, io) {
  return frame(ctx, io, {
    title: 'The codes do not match',
    body: [para(C.MISMATCH_BODY, 'sh-note')],
    actions: [button('Try again', { kind: 'primary', onClick: () => io.go('how') })],
  });
}

function denied(ctx, io) {
  return frame(ctx, io, {
    title: 'Pairing was not allowed',
    body: [para(`${ctx.computer} ${C.DENIED_BODY}`, 'sh-note')],
    actions: [button('Try again', { kind: 'primary', onClick: () => io.go('how') })],
  });
}

function expired(ctx, io) {
  const actions = ctx.lan
    ? [button('Scan the code', { kind: 'primary', onClick: () => io.go('scan') })]
    : [button('Paste a link', { kind: 'ghost', onClick: () => io.go('paste') }), button('Scan the code', { kind: 'primary', onClick: () => io.go('scan') })];
  return frame(ctx, io, {
    title: 'The code expired',
    body: [para(C.EXPIRED_BODY, 'sh-note')],
    actions,
  });
}

// ---- paired-lock and paired-notify (6.9) ----
// A step is done only when the core says so: the screen moves on with ok, and shows the reason otherwise (wave 106 fix).
function stepThen(io, call) {
  return async () => {
    const result = await call();
    if (result?.ok === true) {
      io.local.onboardMessage = null;
      io.advance();
      return;
    }
    io.local.onboardMessage = C.lockFailText(result?.reason ?? 'failed');
    io.repaint();
  };
}

function pairedLock(ctx, io) {
  const bio = C.biometricName(ctx.platform);
  const web = ctx.platform === 'web';
  const advance = () => { io.local.onboardMessage = null; io.advance(); };
  const message = ctx.onboardMessage ? el('p', { class: 'sh-msg', role: 'alert', text: ctx.onboardMessage }) : null;
  const withPasskey = web && ctx.passkeyAvailable === true;
  return frame(ctx, io, {
    kicker: `✓ Paired with ${ctx.computer}`,
    kickerClass: 'sh-status',
    title: `Lock Plenum with ${bio}`,
    body: [
      para(`Plenum asks for ${bio} before it connects, and again after 5 minutes in the background.`, 'sh-note'),
      message,
    ],
    actions: web
      ? [
        button('Not now', { kind: 'ghost', onClick: advance }),
        button('Set a PIN', { kind: withPasskey ? 'ghost' : 'primary', onClick: () => io.go('pin-set') }),
        withPasskey ? button('Use a passkey', { kind: 'primary', onClick: stepThen(io, () => io.act.enableLock('passkey')) }) : null,
      ]
      : [
        button('Not now', { kind: 'ghost', onClick: advance }),
        button('Turn on', { kind: 'primary', onClick: stepThen(io, () => io.act.enableLock('biometric')) }),
      ],
  });
}

function pairedNotify(ctx, io) {
  const advance = () => { io.local.onboardMessage = null; io.advance(); };
  const message = ctx.onboardMessage ? el('p', { class: 'sh-msg', role: 'alert', text: ctx.onboardMessage }) : null;
  if (ctx.platform === 'ios' && !ctx.forwarder) {
    return frame(ctx, io, {
      title: 'Notifications',
      body: [para(C.NOTIFY_BODY_LATER, 'sh-note'), message],
      actions: [button('Continue', { kind: 'primary', onClick: advance })],
    });
  }
  return frame(ctx, io, {
    title: 'Notifications',
    body: [para(fill(C.NOTIFY_BODY, ctx.computer), 'sh-note'), message],
    actions: [
      button('Not now', { kind: 'ghost', onClick: advance }),
      button('Turn on', { kind: 'primary', onClick: stepThen(io, () => io.act.enableNotifications()) }),
    ],
  });
}

// ---- loading (6.10) ----
function loading(ctx, io) {
  const total = Math.max(1, Number(ctx.progress?.total) || 1);
  const done = Math.min(total, Math.max(0, Number(ctx.progress?.done) || 0));
  const root = frame(ctx, io, {
    title: ctx.bundled ? 'Starting Plenum…' : `Loading Plenum from ${ctx.computer}`,
    lead: mark(48),
    body: [
      el('progress', { class: 'sh-progress', max: String(total), value: String(done), 'aria-label': 'Loading Plenum' }),
      para(`${done} of ${total}`, 'sh-note'),
      para(C.LOADING_HINT, 'sh-help'),
    ],
  });
  // The iOS app's bundled UI starts in well under 300 ms, so its screen shows only after 400 ms (MOBILE-UI 6.10).
  if (ctx.bundled) {
    root.hidden = true;
    io.later(() => { root.hidden = false; }, 400);
  }
  return root;
}

// ---- lock-bio and lock-pin (6.13) ----
// The method is the one the lock was set up with: a passkey lock is unlocked by its passkey, a biometric lock by biometrics (wave 106 fix).
function lockBio(ctx, io) {
  const method = ctx.lock.mode === 'passkey' ? 'passkey' : 'biometric';
  const bio = method === 'passkey' ? 'a passkey' : C.biometricName(ctx.platform);
  const message = ctx.bioMessage ?? null;
  // A Stop for a computer this phone holds the Stop key for is sent without unlocking (C6f); otherwise the Stop unlocks first.
  const stopReady = ctx.lockStop?.ready === true;
  const unknown = ctx.lockUnknown === true;
  const stopAll = ctx.session
    ? button(stopReady ? C2.LOCK_STOP : C2.LOCK_UNLOCK_STOP, {
      kind: 'danger',
      onClick: () => (stopReady ? io.act.stopLocked() : io.act.unlockAndStop(method)),
    })
    : null;
  return frame(ctx, io, {
    center: true,
    lead: mark(56),
    title: 'Plenum is locked',
    body: [
      ctx.driving ? el('p', { class: 'sh-note sh-driving', role: 'status', text: C.drivingLine(ctx.computer, ctx.driving) }) : null,
      unknown ? para(C2.LOCK_UNKNOWN, 'sh-note') : null,
      ctx.stopText ? el('p', { class: 'sh-note', role: 'status', text: ctx.stopText }) : null,
      el('p', { class: 'sh-msg', role: 'alert' }, message),
    ],
    actions: [
      stopAll,
      unknown ? null : button(`Unlock with ${bio}`, { kind: 'primary', onClick: () => io.act.unlock(method) }),
    ],
  });
}

function lockPin(ctx, io) {
  // Settings that cannot be read leave no PIN pad: the lock screen says so, and Stop still works (C6f).
  if (ctx.lockUnknown) return lockBio(ctx, io);
  let digits = '';
  const dots = Array.from({ length: 6 }, () => el('span', { class: 'sh-dot', 'aria-hidden': 'true' }));
  const counter = el('span', { class: 'sh-sr', 'aria-live': 'polite' }, '0 of 6 digits entered');
  const message = el('p', { class: 'sh-msg', id: 'sh-pin-msg', role: 'alert' },
    io.local.pinMessage ?? (ctx.lock.waitSec > 0 ? `Wrong PIN. ${C.waitText(ctx.lock.waitSec)}` : null));
  const draw = () => {
    dots.forEach((dot, i) => { if (i < digits.length) dot.setAttribute('data-on', ''); else dot.removeAttribute('data-on'); });
    counter.textContent = `${digits.length} of 6 digits entered`;
  };
  const press = async key => {
    if (key === 'Delete') { digits = digits.slice(0, -1); draw(); return; }
    if (digits.length >= 6) return;
    digits += key;
    draw();
    if (digits.length < 6) return;
    const entered = digits;
    digits = '';
    draw();
    const result = await io.act.unlock('pin', entered);
    if (result && result.ok === false) {
      const wait = Number(result.waitSec) || 0;
      io.local.pinMessage = result.reason === 'wait'
        ? C.waitText(wait)
        : wait > 0 ? `Wrong PIN. ${C.waitText(wait)}` : 'Wrong PIN.';
      message.textContent = io.local.pinMessage;
      return;
    }
    // "Unlock and stop everything" asked for the stop: it is sent once the PIN has unlocked the phone.
    if (result?.ok === true && io.local.stopAfterUnlock) {
      io.local.stopAfterUnlock = false;
      await io.act.stop();
    }
  };
  const keyNames = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'Delete'];
  const pad = el('div', { class: 'sh-pad', role: 'group', 'aria-label': 'PIN' },
    keyNames.map(key => key === null
      ? el('span', { class: 'sh-key-gap', 'aria-hidden': 'true' })
      : el('button', {
        type: 'button',
        class: key === 'Delete' ? 'sh-key sh-key-del' : 'sh-key',
        'aria-label': key === 'Delete' ? 'Delete' : key,
        on: { click: () => { press(key); } },
      }, key === 'Delete' ? 'Delete' : key)));
  draw();
  // A Stop for a computer this phone holds the Stop key for is sent now, without a PIN (C6f); otherwise it waits for the PIN.
  const stopReady = ctx.lockStop?.ready === true;
  const stopAll = ctx.session
    ? button(stopReady ? C2.LOCK_STOP : C2.LOCK_UNLOCK_STOP, {
      kind: 'danger',
      onClick: () => {
        if (stopReady) {
          io.act.stopLocked();
          return;
        }
        io.local.stopAfterUnlock = true;
        message.textContent = 'Enter your PIN. Plenum stops everything once it unlocks.';
      },
    })
    : null;
  return frame(ctx, io, {
    center: true,
    lead: mark(56),
    title: 'Plenum is locked',
    body: [
      ctx.driving ? el('p', { class: 'sh-note sh-driving', role: 'status', text: C.drivingLine(ctx.computer, ctx.driving) }) : null,
      el('div', { class: 'sh-dots' }, dots),
      counter,
      pad,
      ctx.stopText ? el('p', { class: 'sh-note', role: 'status', text: ctx.stopText }) : null,
      message,
    ],
    actions: [stopAll],
  });
}

// ---- update-app, update-desktop, revoked, ui-failed (6.14 to 6.16) ----
// The store button names where it goes: the store's name when the link is a store page, and the release page when it is the repository's.
function storeButtonLabel(platform) {
  const link = STORE_LINKS[platform] ?? null;
  if (link && link.startsWith('https://github.com/')) return C.storeLabel('web');
  return C.storeLabel(platform);
}

function updateApp(ctx, io) {
  return frame(ctx, io, {
    title: 'Update the app',
    body: [para(C.updateAppBody(ctx.computer, ctx.desktopVersion ?? '', ctx.appVersion), 'sh-note')],
    actions: [
      button('Choose another computer', { kind: 'ghost', onClick: () => io.act.chooseComputer() }),
      button(storeButtonLabel(ctx.platform), { kind: 'primary', onClick: () => io.act.openStore() }),
    ],
  });
}

function updateDesktop(ctx, io) {
  return frame(ctx, io, {
    title: 'Update Plenum on your computer',
    body: [para(C.updateDesktopBody(ctx.computer, ctx.minVersion ?? '', ctx.haveVersion ?? ''), 'sh-note')],
    actions: [button('Try again', { kind: 'primary', onClick: () => io.act.retry() })],
  });
}

function revoked(ctx, io) {
  return frame(ctx, io, {
    title: `${ctx.computer} removed this phone`,
    body: [para(C.REVOKED_BODY, 'sh-note')],
    actions: [
      button(`Forget ${ctx.computer} here`, { kind: 'ghost', onClick: () => io.act.forgetActive() }),
      button('Pair again', {
        kind: 'primary',
        onClick: async () => {
          // The old record goes first, so the new pairing starts clean (the revoked screen does not come back).
          await io.act.forgetActive();
          io.go(ctx.platform === 'ios' && !ctx.consentGiven ? 'consent' : 'how');
        },
      }),
    ],
  });
}

// A browser that cannot keep Plenum's screens (no service worker): the cause 'worker' of the UI hand-over (ui-host.js).
const WORKER_TEXT = "This browser cannot keep Plenum's screens on the phone. Open Plenum in Chrome or Safari, or add it to your Home Screen, then try again.";

function uiFailed(ctx, io) {
  const pending = C.pendingLine(ctx.computer, ctx.pending);
  return frame(ctx, io, {
    title: "Plenum's screens did not load",
    body: [
      para(ctx.cause === 'worker' ? WORKER_TEXT : C.uiFailedBody(ctx.computer, ctx.cause), 'sh-note'),
      pending ? para(pending, 'sh-help') : null,
    ],
    actions: [
      button(`Send the log to ${ctx.computer}`, { kind: 'ghost', onClick: () => io.act.sendLog() }),
      ctx.hasCopy ? button('Use the copy in this app', { kind: 'ghost', onClick: () => io.act.useCopy() }) : null,
      button('Try again', { kind: 'primary', onClick: () => io.act.retry() }),
    ],
  });
}

// The builder for each screen id, in MOBILE-UI 6 order.
const BUILDERS = Object.freeze({
  welcome,
  consent,
  how,
  scan,
  'scan-denied': scanDeniedScreen,
  paste,
  localnet,
  connecting,
  failed,
  code,
  mismatch,
  denied,
  expired,
  'paired-lock': pairedLock,
  'paired-notify': pairedNotify,
  loading,
  'lock-bio': lockBio,
  'lock-pin': lockPin,
  'update-app': updateApp,
  'update-desktop': updateDesktop,
  revoked,
  'ui-failed': uiFailed,
});

export function renderScreen(id, ctx, io) {
  const build = BUILDERS[id];
  if (!build) return null;
  return build({ ...ctx, id }, io);
}

export const SCREEN_BUILDERS = BUILDERS;
export { plural };
