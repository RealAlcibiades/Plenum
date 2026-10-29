// The copy deck for the shell screens (MOBILE-UI 6.1 to 6.16, 9 and 14). Wave 106 (mob-10, part 1). Every sentence the design
// gives word for word is kept as written; a name ("Home PC", "Face ID") is a parameter. No exclamation marks, no emoji, sentence
// case. Plain text only: the screens put these strings in with textContent.

// The 22 screen ids of part 1, in the order of MOBILE-UI 6.
export const SCREEN_IDS = Object.freeze([
  'welcome', 'consent', 'how', 'scan', 'scan-denied', 'paste', 'localnet', 'connecting', 'failed', 'code',
  'mismatch', 'denied', 'expired', 'paired-lock', 'paired-notify', 'loading', 'lock-bio', 'lock-pin',
  'update-app', 'update-desktop', 'revoked', 'ui-failed',
]);

// The forwarder flag is keyed in the build (esbuild define). Without the define it is false, so the app never claims more than
// the Privacy Notice does (MOBILE-UI 6.1 and 15.17).
export const FORWARDER_BUILD = typeof __PLENUM_FORWARDER__ !== 'undefined' && __PLENUM_FORWARDER__ === true;

export const CONSENT_TEXT = "Messages you send from this app go to your computer. Plenum on your computer sends them, with files from your projects, to the AI providers you set up there, which may include Anthropic, OpenAI, Google, Meta (Muse Code), xAI, DeepSeek, Mistral AI and OpenRouter. Each provider handles them under its own privacy policy. Plenum's developer receives nothing.";

export const FORWARDER_SENTENCE = 'Only notifications pass through a small forwarder we run; everything else goes to your computer alone.';

export const HOW_STEPS = Object.freeze([
  'On your computer, open Plenum.',
  'Go to Settings › Phones and turn on Let phones connect.',
  'Click Add phone. A window with a code opens.',
]);

export const HOW_NOTE = 'A paired phone can do everything Plenum can do on that computer. Keep this phone locked.';

export const LAN_NO_CAMERA = "This page cannot use the camera. Scan the code with your phone's Camera app instead; it opens this page with the code.";

export const CARRIER_LABEL = Object.freeze({ lan: 'Same network', tailscale: 'Tailscale', relay: 'Your relay' });

export const LOCK_FAILED = 'Not recognised. Try again or use your passcode.';

export const PASTE_ERRORS = Object.freeze({
  'not-plenum': 'This is not a Plenum pairing link. Copy it from the Add phone window on your computer.',
  expired: 'This link has expired. Click Add phone on your computer again for a new one.',
});

export const ASLEEP_STRIP = (name, when) => `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.`;

// The text of a button names the target, so each builder takes the computer name.
export function storeLabel(platform) {
  if (platform === 'ios') return 'Open the App Store';
  if (platform === 'android') return 'Open Google Play';
  return 'Open the release page';
}

// The biometric name follows the device (MOBILE-UI 6.9).
export function biometricName(platform) {
  if (platform === 'ios') return 'Face ID';
  if (platform === 'android') return 'your fingerprint or screen lock';
  return 'a passkey or a PIN';
}

// "2 approvals waiting", "1 run going" (MOBILE-UI 6.16).
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function pendingLine(computer, pending) {
  const approvals = Number(pending?.approvals) || 0;
  const runs = Number(pending?.runs) || 0;
  const parts = [];
  if (approvals) parts.push(plural(approvals, 'approval waiting', 'approvals waiting'));
  if (runs) parts.push(plural(runs, 'run going', 'runs going'));
  if (!parts.length) return null;
  return `On ${computer} now: ${parts.join(', ')}.`;
}

// The line for the desktop's Plenum version and the phone's app version (MOBILE-UI 6.14).
export function updateAppBody(computer, desktop, app) {
  const tail = app ? ` than this one (${app})` : ' than this one';
  return `${computer} runs Plenum ${desktop}, which needs a newer Plenum app${tail}. Update the app, then open it again.`;
}

export function updateDesktopBody(computer, minimum, have) {
  return `This app needs Plenum ${minimum} or later on ${computer}, which has ${have}. On the computer, open Settings › Updates and install the update.`;
}

export function uiFailedBody(computer, cause) {
  if (cause === 'not-sent') return `${computer} did not send Plenum's screens. Try again.`;
  if (cause === 'stopped') return `Plenum on ${computer} stopped while the screens were loading.`;
  return 'A file from ' + computer + ' did not match its checksum, so the phone kept the copy it had. Try again; if it happens again, restart Plenum on the computer.';
}

export function drivingLine(computer, driving) {
  return `A model is driving ${computer}: ${driving}.`;
}

export function waitText(waitSec) {
  return `Try again in ${waitSec} seconds.`;
}

// The countdown reads m:ss from the offer's 120 seconds (MOBILE-UI 6.8).
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function codeSpaced(code) {
  const digits = String(code ?? '').replace(/\D/g, '').slice(0, 6);
  if (digits.length !== 6) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function codeLabel(code) {
  return `Code ${String(code ?? '').replace(/\D/g, '').slice(0, 6).split('').join(' ')}`;
}

export const STOP_LABEL = Object.freeze({ idle: 'Stop', sending: 'Stopping…', queued: 'Stop', done: 'Stopped', failed: 'Stop' });

export const FAILED_LINES = Object.freeze({
  lan: 'Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.',
  tailscale: 'Tailscale: no answer. Open Tailscale on this phone, connect, then try again.',
  relayOff: 'Relay: {computer} is not connected to the relay. Check Settings › Phones › Relay on the computer.',
  notOffered: "Not available in this app: same network (an https web app cannot open your network's address). Use the Plenum app, or open the LAN page from the computer's window.",
  busy: '{computer} is busy. Try again in a minute.',
});

// The failed screen shows one of these alone when the pairing failed for a reason that is not about a carrier (wave 106 fix).
export const FAILURE_LINES = Object.freeze({
  save: 'The phone could not store the key. Try again.',
  locked: 'Plenum is locked on this phone. Unlock it, then try again.',
  worker: 'Plenum could not start the connection on this phone. Try again.',
});

// B-128: the browser keeps one push subscription per address, and another computer behind this address holds it.
export const PUSH_OTHER_COMPUTER = 'Web notifications on this address are on for another computer. Turn them off there first.';

// What a lock or onboarding step says when the phone did not turn it on. The reason comes from the shell core.
export function lockFailText(reason) {
  if (reason === 'other-computer') return PUSH_OTHER_COMPUTER;
  if (reason === 'unavailable') return 'This is not available on this device yet.';
  if (reason === 'format') return 'That PIN is not valid. Use six digits.';
  if (reason === 'mode') return 'This is already on.';
  return 'Plenum did not turn this on. Try again.';
}

export const LINK_UNAVAILABLE = 'This link is not in this build yet.';
export const SETTINGS_MANUAL = 'Open Settings on this phone and allow Plenum there.';

export const CODE_TEXT = 'shows a code in the Add phone window. If it is the same, click Allow there.';
export const MISMATCH_BODY = 'Stopped. Click Deny on your computer, then add the phone again. A different code can mean another device scanned the same code.';
export const DENIED_BODY = 'did not allow this phone. To try again, click Add phone on the computer.';
export const EXPIRED_BODY = 'The code expired after 2 minutes. Click Add phone on your computer again, then scan the new code.';
export const REVOKED_BODY = 'To use Plenum here again, add the phone at the computer under Settings › Phones.';
export const SCAN_HINT = 'Point at the code in the Add phone window on your computer.';
export const SCAN_NOT_PLENUM = 'This is not a Plenum pairing code.';
export const SCAN_DENIED = 'Plenum cannot use the camera. Allow it in Settings › Plenum › Camera, or paste the link instead.';
export const LOCALNET_BODY = 'iPhone asks whether Plenum may find devices on your local network. Choose Allow on the next screen.';
export const LOCALNET_DENIED = 'iPhone is blocking local network access for Plenum. Turn it on in Settings › Privacy & Security › Local Network › Plenum, or connect through Tailscale or your relay.';
export const LOADING_HINT = 'The first time takes a few seconds; after that only changed files load.';
export const NOTIFY_BODY = 'Get a notification when an approval waits or a run ends on {computer}. They show only the project and a status.';
export const NOTIFY_BODY_LATER = 'Notifications show while Plenum is open. Notifications when it is closed come with a later version.';
export const ALREADY_PAIRED = 'This phone is already paired with {computer}.';
export const PAIRING_CHECK = 'Check the code';
export const WELCOME_TITLE = 'Plenum on your phone';
export const WELCOME_LEAD = 'Run, watch and approve the coding agents on your own computer.';
export const NEEDS_CONSENT = 'Pairing needs this consent. You can give it any time.';

// The privacy line on Welcome: the second sentence depends on the build's forwarder flag (MOBILE-UI 6.1, S-06).
export function welcomePrivacy(forwarder = FORWARDER_BUILD) {
  return ['Your phone talks only to your computer, encrypted end to end.', forwarder ? FORWARDER_SENTENCE : 'Nothing goes through us.'];
}

// Fills the {computer} placeholder of a copy string.
export function fill(text, computer) {
  return String(text).split('{computer}').join(computer);
}
