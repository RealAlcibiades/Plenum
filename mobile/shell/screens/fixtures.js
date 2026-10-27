// The demo contexts for ?demo=1&screen=<id> (mob-10, wave 106; MOBILE-UI 16.1). Each screen can be drawn with no computer, so the
// store review and the harness reach every screen. Values are the design's own examples (Home PC, 2.0, 1.6, 482 913).
// The shell's state is not read in this mode; the router only draws the screen with these values.
import { FORWARDER_BUILD, SCREEN_IDS } from './copy.js';

export const DEMO_BASE = Object.freeze({
  platform: 'web',
  lan: false,
  computer: 'Home PC',
  session: false,
  phoneName: 'Phone',
  code: '482913',
  carrier: 'lan',
  tried: Object.freeze([
    Object.freeze({ carrier: 'lan', reason: 'timeout' }),
    Object.freeze({ carrier: 'tailscale', reason: 'timeout' }),
    Object.freeze({ carrier: 'relay', reason: 'closed' }),
  ]),
  lock: Object.freeze({ mode: 'off', failures: 0, waitSec: 0 }),
  pending: Object.freeze({ approvals: 2, runs: 1 }),
  driving: null,
  pasteError: null,
  desktopVersion: '2.0',
  minVersion: '1.0',
  haveVersion: '0.9',
  appVersion: '1.6',
  cause: 'checksum',
  hasCopy: true,
  forwarder: FORWARDER_BUILD,
  consentGiven: false,
  passkeyAvailable: true,
  bundled: false,
  progress: Object.freeze({ done: 21, total: 47 }),
  stopState: 'idle',
  stopText: '',
  stripInfo: null,
  alreadyPaired: false,
  localDenied: false,
  cameraDenied: false,
  carrierLabel: 'Same network',
  countdown: 120,
});

// Per-screen values. Anything not listed keeps DEMO_BASE.
const PER_SCREEN = Object.freeze({
  welcome: { platform: 'web', phoneName: 'Phone' },
  consent: { platform: 'ios', phoneName: 'iPhone' },
  how: { platform: 'web' },
  scan: { platform: 'web' },
  'scan-denied': { platform: 'web', cameraDenied: true },
  paste: { platform: 'web' },
  localnet: { platform: 'ios', phoneName: 'iPhone' },
  connecting: { platform: 'ios', session: true, carrier: 'lan', carrierLabel: 'Same network' },
  failed: { platform: 'ios', session: true },
  code: { platform: 'ios', phoneName: 'iPhone' },
  mismatch: { platform: 'ios' },
  denied: { platform: 'ios' },
  expired: { platform: 'ios' },
  'paired-lock': { platform: 'ios' },
  'paired-notify': { platform: 'ios' },
  loading: { platform: 'ios', session: true },
  'lock-bio': { platform: 'ios', session: true, driving: 'Notepad, step 12 of 80', lock: { mode: 'biometric', failures: 0, waitSec: 0 } },
  'lock-pin': { platform: 'web', lock: { mode: 'pin', failures: 5, waitSec: 30 } },
  'update-app': { platform: 'ios', session: true },
  'update-desktop': { platform: 'web', session: true },
  revoked: { platform: 'web' },
  'ui-failed': { platform: 'web', session: true, cause: 'checksum', hasCopy: true },
});

// The context for one demo screen. `overrides` come from the debug hook (for example session: false).
export function fixtureCtx(id, overrides = {}) {
  if (!SCREEN_IDS.includes(id)) return null;
  return { ...DEMO_BASE, ...PER_SCREEN[id], ...overrides, id };
}

// Screens with a live session show the floating Stop (MOBILE-UI 9.1 table). Lock screens show their own "Unlock and stop
// everything" instead, so the floating Stop is hidden there (main.js).
export const SESSION_SCREENS = Object.freeze(['connecting', 'failed', 'loading', 'lock-bio', 'update-app', 'update-desktop', 'ui-failed']);
