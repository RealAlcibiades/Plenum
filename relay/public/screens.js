// mobile/shell/screens/dom.js
var doc = globalThis.document ?? null;
function setDocument(d) {
  doc = d;
}
function el(tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === void 0 || value === false) continue;
    if (key === "on") {
      for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
    } else if (key === "text") {
      node.textContent = String(value);
    } else if (key === "class") {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === void 0 || child === false) continue;
    node.append(child instanceof Node ? child : doc.createTextNode(String(child)));
  }
  return node;
}
function button(label, { kind = "ghost", onClick = null, disabled = false, id = null, name = null } = {}) {
  const cls = kind === "link" ? "sh-link" : `sh-btn sh-btn-${kind}${disabled ? " sh-btn-off" : ""}`;
  return el("button", {
    type: "button",
    class: cls,
    id,
    "aria-label": name,
    "aria-disabled": disabled ? "true" : null,
    on: { click: (event) => {
      if (!disabled && onClick) onClick(event);
    } }
  }, label);
}

// mobile/shell/screens/copy.js
var SCREEN_IDS = Object.freeze([
  "welcome",
  "consent",
  "how",
  "scan",
  "scan-denied",
  "paste",
  "localnet",
  "connecting",
  "failed",
  "code",
  "mismatch",
  "denied",
  "expired",
  "paired-lock",
  "paired-notify",
  "loading",
  "lock-bio",
  "lock-pin",
  "update-app",
  "update-desktop",
  "revoked",
  "ui-failed"
]);
var FORWARDER_BUILD = typeof __PLENUM_FORWARDER__ !== "undefined" && __PLENUM_FORWARDER__ === true;
var CONSENT_TEXT = "Messages you send from this app go to your computer. Plenum on your computer sends them, with files from your projects, to the AI providers you set up there, which may include Anthropic, OpenAI, Google, Meta (Muse Code), xAI, DeepSeek, Mistral AI and OpenRouter. Each provider handles them under its own privacy policy. Plenum's developer receives nothing.";
var FORWARDER_SENTENCE = "Only notifications pass through a small forwarder we run; everything else goes to your computer alone.";
var HOW_STEPS = Object.freeze([
  "On your computer, open Plenum.",
  "Go to Settings \u203A Phones and turn on Let phones connect.",
  "Click Add phone. A window with a code opens."
]);
var HOW_NOTE = "A paired phone can do everything Plenum can do on that computer. Keep this phone locked.";
var LAN_NO_CAMERA = "This page cannot use the camera. Scan the code with your phone's Camera app instead; it opens this page with the code.";
var CARRIER_LABEL = Object.freeze({ lan: "Same network", tailscale: "Tailscale", relay: "Your relay" });
var LOCK_FAILED = "Not recognised. Try again or use your passcode.";
var PASTE_ERRORS = Object.freeze({
  "not-plenum": "This is not a Plenum pairing link. Copy it from the Add phone window on your computer.",
  expired: "This link has expired. Click Add phone on your computer again for a new one."
});
var ASLEEP_STRIP = (name, when) => `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.`;
function storeLabel(platform) {
  if (platform === "ios") return "Open the App Store";
  if (platform === "android") return "Open Google Play";
  return "Open the release page";
}
function biometricName(platform) {
  if (platform === "ios") return "Face ID";
  if (platform === "android") return "your fingerprint or screen lock";
  return "a passkey or a PIN";
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function pendingLine(computer, pending) {
  const approvals = Number(pending?.approvals) || 0;
  const runs = Number(pending?.runs) || 0;
  const parts = [];
  if (approvals) parts.push(plural(approvals, "approval waiting", "approvals waiting"));
  if (runs) parts.push(plural(runs, "run going", "runs going"));
  if (!parts.length) return null;
  return `On ${computer} now: ${parts.join(", ")}.`;
}
function updateAppBody(computer, desktop, app) {
  const tail = app ? ` than this one (${app})` : " than this one";
  return `${computer} runs Plenum ${desktop}, which needs a newer Plenum app${tail}. Update the app, then open it again.`;
}
function updateDesktopBody(computer, minimum, have) {
  return `This app needs Plenum ${minimum} or later on ${computer}, which has ${have}. On the computer, open Settings \u203A Updates and install the update.`;
}
function uiFailedBody(computer, cause) {
  if (cause === "not-sent") return `${computer} did not send Plenum's screens. Try again.`;
  if (cause === "stopped") return `Plenum on ${computer} stopped while the screens were loading.`;
  return "A file from " + computer + " did not match its checksum, so the phone kept the copy it had. Try again; if it happens again, restart Plenum on the computer.";
}
function drivingLine(computer, driving) {
  return `A model is driving ${computer}: ${driving}.`;
}
function waitText(waitSec) {
  return `Try again in ${waitSec} seconds.`;
}
function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function codeSpaced(code2) {
  const digits = String(code2 ?? "").replace(/\D/g, "").slice(0, 6);
  if (digits.length !== 6) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
function codeLabel(code2) {
  return `Code ${String(code2 ?? "").replace(/\D/g, "").slice(0, 6).split("").join(" ")}`;
}
var STOP_LABEL = Object.freeze({ idle: "Stop", sending: "Stopping\u2026", queued: "Stop", done: "Stopped", failed: "Stop" });
var FAILED_LINES = Object.freeze({
  lan: "Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.",
  tailscale: "Tailscale: no answer. Open Tailscale on this phone, connect, then try again.",
  relayOff: "Relay: {computer} is not connected to the relay. Check Settings \u203A Phones \u203A Relay on the computer.",
  notOffered: "Not available in this app: same network (an https web app cannot open your network's address). Use the Plenum app, or open the LAN page from the computer's window.",
  busy: "{computer} is busy. Try again in a minute."
});
var FAILURE_LINES = Object.freeze({
  save: "The phone could not store the key. Try again.",
  locked: "Plenum is locked on this phone. Unlock it, then try again.",
  worker: "Plenum could not start the connection on this phone. Try again."
});
function lockFailText(reason) {
  if (reason === "unavailable") return "This is not available on this device yet.";
  if (reason === "format") return "That PIN is not valid. Use six digits.";
  if (reason === "mode") return "This is already on.";
  return "Plenum did not turn this on. Try again.";
}
var LINK_UNAVAILABLE = "This link is not in this build yet.";
var SETTINGS_MANUAL = "Open Settings on this phone and allow Plenum there.";
var CODE_TEXT = "shows a code in the Add phone window. If it is the same, click Allow there.";
var MISMATCH_BODY = "Stopped. Click Deny on your computer, then add the phone again. A different code can mean another device scanned the same code.";
var DENIED_BODY = "did not allow this phone. To try again, click Add phone on the computer.";
var EXPIRED_BODY = "The code expired after 2 minutes. Click Add phone on your computer again, then scan the new code.";
var REVOKED_BODY = "To use Plenum here again, add the phone at the computer under Settings \u203A Phones.";
var SCAN_HINT = "Point at the code in the Add phone window on your computer.";
var SCAN_DENIED = "Plenum cannot use the camera. Allow it in Settings \u203A Plenum \u203A Camera, or paste the link instead.";
var LOCALNET_BODY = "iPhone asks whether Plenum may find devices on your local network. Choose Allow on the next screen.";
var LOCALNET_DENIED = "iPhone is blocking local network access for Plenum. Turn it on in Settings \u203A Privacy & Security \u203A Local Network \u203A Plenum, or connect through Tailscale or your relay.";
var LOADING_HINT = "The first time takes a few seconds; after that only changed files load.";
var NOTIFY_BODY = "Get a notification when an approval waits or a run ends on {computer}. They show only the project and a status.";
var NOTIFY_BODY_LATER = "Notifications show while Plenum is open. Notifications when it is closed come with a later version.";
var PAIRING_CHECK = "Check the code";
var WELCOME_TITLE = "Plenum on your phone";
var WELCOME_LEAD = "Run, watch and approve the coding agents on your own computer.";
var NEEDS_CONSENT = "Pairing needs this consent. You can give it any time.";
function welcomePrivacy(forwarder = FORWARDER_BUILD) {
  return ["Your phone talks only to your computer, encrypted end to end.", forwarder ? FORWARDER_SENTENCE : "Nothing goes through us."];
}
function fill(text, computer) {
  return String(text).split("{computer}").join(computer);
}

// mobile/shell/screens/copy2.js
var PART2_IDS = Object.freeze([
  "pair-review",
  "computers",
  "install-ios",
  "install-android",
  "lan-web",
  "connected",
  "rename",
  "forget",
  "settings",
  "settings-connection",
  "settings-notify",
  "settings-lock",
  "phone-lock-off",
  "settings-appearance",
  "settings-dictation",
  "debug",
  "about",
  "legal",
  "demo-home",
  "demo-run",
  "demo-diff",
  "demo-artifact"
]);
var COMPUTERS_TITLE = "Plenum";
var COMPUTERS_LABEL = "COMPUTERS";
var PAIR_ANOTHER = "Pair another computer";
var ROW_MENU = Object.freeze({ connect: "Connect", ways: "Ways to reach it", rename: "Rename on this phone", forget: "Forget this computer" });
var STATUS = Object.freeze({ online: "Online", asleep: "Asleep", unreachable: "Not reachable" });
var INSTALL_IOS_BODY = "Add Plenum to your Home Screen for notifications and a full-screen app. Tap Share, then Add to Home Screen, then open Plenum from the Home Screen and pair there.";
var INSTALL_IOS_STEPS = Object.freeze(["Tap Share.", "Tap Add to Home Screen.", "Open Plenum from the Home Screen."]);
var INSTALL_IOS_PAIR_HERE = "Pair in this tab, without notifications";
var INSTALL_ANDROID_BODY = "Install Plenum for notifications and a full-screen app.";
var INSTALL_NO_PROMPT = "This browser does not offer the install here. Use the browser menu and choose Install app.";
var LAN_WEB_STRIP = "This page works only on {computer}'s network and cannot send notifications. It is sent without encryption, so someone on this network could change it. On a network you do not trust, use the Plenum app, Tailscale or your relay.";
var PAIR_REVIEW_TITLE = (name) => `Pair with ${name}?`;
var PAIR_REVIEW_LEAD = "Pair only if you clicked Add phone on your own computer just now and its window shows a code.";
var PAIR_REVIEW_HOSTS = "This phone will connect to:";
var PAIR_REVIEW_NOTE = "A computer you pair with runs its own screens in this app.";
var PAIR_REVIEW_PAIR = "Pair";
var PAIR_REVIEW_CANCEL = "Cancel";
var STORAGE_UNAVAILABLE = "This phone could not open its secure storage, so Plenum cannot keep a computer's key here. Close Plenum and open it again. If it keeps happening, reinstall the app.";
var LOCK_UNKNOWN = "Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.";
var START_FAILED = "Plenum could not start on this page. Close it and open Plenum again.";
var LOCK_STOP = "Stop everything";
var LOCK_UNLOCK_STOP = "Unlock and stop everything";
var CONNECTED_SINCE = (computer, when) => `Connected to ${computer}${when ? ` since ${when}` : ""}.`;
var CONNECTED_TITLE = "Connected";
var RECONNECTING_TITLE = "Reconnecting";
var RECONNECTING_BODY = (computer) => `Reconnecting to ${computer}. Plenum keeps trying. The strip at the top says what is happening.`;
var RENAME_TITLE = "Rename on this phone";
var RENAME_HELP = "Only this phone shows this name. The computer keeps its own name.";
var FORGET_TITLE = "Forget {computer}?";
var FORGET_BODY = "This phone deletes its key for {computer}. {computer} keeps listing this phone until you remove it there under Settings \u203A Phones.";
var FORGET_CONFIRM = "Forget";
var CANCEL = "Cancel";
var SETTINGS_TITLE = "Phone settings";
var SETTINGS_COMPUTERS = "COMPUTERS";
var SETTINGS_THIS_PHONE = "THIS PHONE";
var SETTINGS_HELP = "HELP";
var PAIR_ANOTHER_SHORT = "Pair another computer";
var SETTINGS_NONE = "No computer is paired yet.";
var WAYS_TITLE = "Ways to reach {computer}";
var WAYS_LEAD = "Plenum tries them in this order.";
var WAYS_TEST = "Test them now";
var WAYS_NEW = "New ways you turn on at the computer appear here the next time this phone connects.";
var WAY_NOT_AVAILABLE = "Not available in this app";
var WAY_NOT_REACHABLE = "Not reachable";
var WAY_MOVE_UP = "Move up";
var WAY_MOVE_DOWN = "Move down";
var WAY_LAN_WEB = "An https web app cannot open your network's address.";
var WAY_NO_ADDRESS = "Turned off at the computer";
var NOTIFY_TITLE = "Notifications";
var NOTIFY_ON_PHONE = "On this phone";
var NOTIFY_KEPT = "KEPT ON {computer}, FOR EVERY PHONE";
var NOTIFY_APPROVE_ROW = "Approve from notifications";
var NOTIFY_TEST = "Send a test notification";
var NOTIFY_NOT_ARRIVING = "Not arriving? iPhone Focus modes and notification summaries can hold them back: Settings \u203A Notifications \u203A Plenum.";
var NOTIFY_NOT_ARRIVING_ANDROID = "Not arriving? Check Settings \u203A Apps \u203A Plenum \u203A Notifications on the phone.";
var NOTIFY_PERMISSION = Object.freeze({ granted: "Allowed", denied: "Blocked", default: "Not asked", unknown: "Not asked" });
var NOTIFY_DENIED_HINT = "Turn them on in Settings for Plenum on this phone.";
var APPROVE_NOTIFY_TEXT = "The notification shows one line of the card. Approving from it runs that edit or command on {computer} without opening the card or the lines under it. Your phone asks for Face ID, your fingerprint or your PIN first. Deny and Stop never need this switch.";
var APPROVE_BLOCKED_TEXT = "A blocked command never shows Approve on a notification.";
var LOCK_TITLE = "App lock";
var LOCK_ROW = "Lock Plenum";
var LOCK_AFTER_LABEL = "After";
var LOCK_SWITCHER = "Hide content in the app switcher";
var LOCK_NOW = "Lock now";
var LOCK_OFF_TITLE = "Turn off the app lock?";
var LOCK_OFF_TEXT = "With the app lock off, anyone who can unlock this phone can run models, approve changes and use your computer through Plenum. If the phone is lost, remove it at the computer under Settings \u203A Phones.";
var LOCK_OFF_KEEP = "Keep the lock on";
var LOCK_OFF_TURN = "Turn off";
var LOCK_WEB_KEY = "The key that pairs this phone is kept in this browser's storage. Clearing the browser's website data removes it, and you pair again. A PIN or passkey protects the key from someone else using the unlocked phone.";
var PHONE_PUSH_TEXT = "Plenum sends your phone only the project name and a status, such as an approval is waiting. Anyone holding the phone can read that on the lock screen. Turning on Include the first line adds the first line of the card, which can name files and commands.";
var LOCK_OFF_HINT = "The app lock is off. Turn it on to ask for your passcode or Face ID before Plenum connects.";
var APPEARANCE_TITLE = "Appearance";
var APPEARANCE_THEME = "Theme";
var APPEARANCE_TEXT = "Text size";
var APPEARANCE_FOLLOW_TEXT = "Follow phone";
var APPEARANCE_SAMPLE = "Coding agents work in the folders you choose, and you approve what they change. This paragraph shows the text size you picked.";
var APPEARANCE_STOP = "Stop button";
var APPEARANCE_STOP_RIGHT = "Right";
var APPEARANCE_STOP_LEFT = "Left";
var APPEARANCE_HAPTICS = "Haptics";
var APPEARANCE_NOTE = "The theme here is for this phone. Settings \u203A General \u203A Theme changes {computer}.";
var APPEARANCE_HAPTICS_IOS = "Haptics are not available in the web app on iPhone.";
var DICTATION_TITLE = "Dictation";
var DICTATION_PREFER = "Prefer recognition on this phone";
var DICTATION_ALLOW = "Allow that";
var DICTATION_ALLOW_TEXT = "When your language is not available on the phone, Plenum can use Apple's or Google's speech service instead.";
var DICTATION_WEB = "Dictation runs in the Plenum app on your phone.";
var PHONE_VOICE = "Plenum asks your phone to turn what you say into text in the message box. It prefers recognition on the phone itself; where your language is not available there, Apple or Google may process the audio under their own terms. Nothing reaches your computer until you press Send.";
var DEBUG_TITLE = "Debug console";
var DEBUG_LEAD = "Holds the last 500 lines, kept only on this phone.";
var DEBUG_EMPTY = "No log lines yet.";
var DEBUG_COPY = "Copy";
var DEBUG_SEND = "Send to {computer}";
var DEBUG_CLEAR = "Clear";
var DEBUG_SENT = "Sent {n} lines to {computer}.";
var DEBUG_SEND_FAILED = "Could not send the log to {computer}. Connect, then try again.";
var DEBUG_COPIED = "Copied.";
var DEBUG_NO_CLIPBOARD = "This browser does not allow copying here. Select the lines to copy them.";
var ABOUT_TITLE = "About";
var ABOUT_APP = "Plenum app {version}";
var ABOUT_COMPUTER = "{computer}: Plenum {version}";
var ABOUT_LINK = "Link version {version}";
var ABOUT_SCREENS_BUILT = "Screens: built into this app";
var ABOUT_SCREENS_LOADED = "Screens: loaded from {computer}, {n} files, all checked";
var ABOUT_CONNECTED = "Connected over {carrier} since {when}";
var ABOUT_NEWER_UI = "{computer} has features this app does not show yet. Update the app to use them.";
var ABOUT_NOT_CONNECTED = "Not connected to a computer now.";
var LEGAL_TITLE = "Legal";
var LEGAL_ROWS = Object.freeze({ license: "License Agreement", privacy: "Privacy Notice", third: "Third-party notices" });
var LEGAL_VERSIONS = "The versions {computer} uses are in Settings \u203A Legal.";
var DEMO_STRIP = "Demo: nothing here reaches a computer.";
var DEMO_EXIT = "Exit demo";
var DEMO_TITLE = "Demo computer";
var DEMO_RUNS = "RUNS";
var DEMO_APPROVAL = "Waiting for you";
var DEMO_APPROVE = "Approve";
var DEMO_DENY = "Deny";
var DEMO_RUN_LABEL = "Computer run";
var DEMO_DIFF_LABEL = "Changes";
var DEMO_ARTIFACT_LABEL = "Artifacts";
var DEMO_NO_PAIR = "The demo cannot pair with a computer. Exit the demo to pair.";
var DEMO_RESET = "Start the demo again";
var DEMO_EMPTY = "Nothing here yet.";
var SAVE = "Save";
var NOT_NOW = "Not now";
function fillName(text, computer) {
  return String(text).split("{computer}").join(String(computer ?? "your computer"));
}
function fillMany(text, values) {
  let out = String(text);
  for (const [key, value] of Object.entries(values ?? {})) out = out.split(`{${key}}`).join(String(value ?? ""));
  return out;
}
function rowStatus({ active = false, connected: connected2 = false, status = null, lastSeen = null, dateText = null } = {}) {
  if (active && connected2) return STATUS.online;
  if (status === "asleep") return STATUS.asleep;
  if (status === "offline" || status === "reconnecting") return STATUS.unreachable;
  if (lastSeen && dateText) return `Seen ${dateText}`;
  return null;
}

// mobile/shell/screens/settings.js
var LOCK_AFTER = Object.freeze([
  Object.freeze({ id: "immediately", ms: 0, label: "Immediately" }),
  Object.freeze({ id: "m1", ms: 60 * 1e3, label: "1 minute" }),
  Object.freeze({ id: "m5", ms: 5 * 60 * 1e3, label: "5 minutes" }),
  Object.freeze({ id: "m15", ms: 15 * 60 * 1e3, label: "15 minutes" }),
  Object.freeze({ id: "h1", ms: 60 * 60 * 1e3, label: "1 hour" })
]);
var DEFAULT_LOCK_AFTER = "m5";
function lockAfter(id) {
  return LOCK_AFTER.find((o) => o.id === id) ?? LOCK_AFTER.find((o) => o.id === DEFAULT_LOCK_AFTER);
}
var WAY_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
function orderedWays(stored) {
  const seen = [];
  for (const kind of Array.isArray(stored) ? stored : []) {
    if (WAY_KINDS.includes(kind) && !seen.includes(kind)) seen.push(kind);
  }
  for (const kind of WAY_KINDS) if (!seen.includes(kind)) seen.push(kind);
  return seen;
}
function approveSwitch({ tier = "full", firstLine = false, lockMode = "off", native = false } = {}) {
  if (tier === "read") return { visible: false, enabled: false, missing: null };
  const lockOn = native ? lockMode === "biometric" || lockMode === "pin" || lockMode === "passkey" : lockMode === "pin" || lockMode === "passkey";
  if (!firstLine) return { visible: true, enabled: false, missing: "first-line" };
  if (!lockOn) return { visible: true, enabled: false, missing: "app-lock" };
  return { visible: true, enabled: true, missing: null };
}
var APPROVE_MISSING_TEXT = Object.freeze({
  "first-line": 'Turn on "Include the first line" first.',
  "app-lock": "Turn on the app lock first. On the web app that means a PIN or a passkey."
});
function approveChecked(stored, rule) {
  return Boolean(stored) && Boolean(rule?.enabled);
}
var TEXT_MIN = 85;
var TEXT_MAX = 200;
var TEXT_STEP = 5;
var TEXT_DEFAULT = 100;
function clampText(value) {
  const n = Math.round((Number(value) || TEXT_DEFAULT) / TEXT_STEP) * TEXT_STEP;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, n));
}
var THEMES = Object.freeze(["follow", "dark", "light"]);
var THEME_LABEL = Object.freeze({ follow: "Follow phone", dark: "Dark", light: "Light" });
function normaliseTheme(value) {
  return THEMES.includes(value) ? value : "follow";
}
function normaliseStopSide(value) {
  return value === "left" ? "left" : "right";
}
var PUSH_SWITCHES = Object.freeze([
  Object.freeze({ key: "approvals", label: "Approvals and your turn" }),
  Object.freeze({ key: "finished", label: "Finished and failed runs" }),
  Object.freeze({ key: "limits", label: "Spend and plan limits" }),
  Object.freeze({ key: "onlyWhenAway", label: "Only when I am away from {computer}" }),
  Object.freeze({ key: "firstLine", label: "Include the first line" })
]);
var PUSH_DEFAULTS = Object.freeze({ approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });
function pushValues(known) {
  const out = { ...PUSH_DEFAULTS };
  for (const { key } of PUSH_SWITCHES) {
    if (typeof known?.[key] === "boolean") out[key] = known[key];
  }
  return out;
}
function pushPatch(key, value, approveStored) {
  const patch = { [key]: value === true };
  if (key === "firstLine" && value !== true && approveStored) patch.approveFromNotifications = false;
  return patch;
}
function unifiedPushLine(distributor) {
  if (!distributor) return "Install a UnifiedPush app such as ntfy to get notifications while Plenum is closed.";
  if (distributor === "io.heckel.ntfy") return "Notifications from closed app: through ntfy (UnifiedPush).";
  return "Notifications from closed app: through your UnifiedPush app.";
}
function normalisePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    theme: normaliseTheme(p.theme),
    textSize: p.textSize == null ? null : clampText(p.textSize),
    stopSide: normaliseStopSide(p.stopSide),
    haptics: p.haptics !== false,
    hideSwitcher: p.hideSwitcher !== false,
    lockAfter: lockAfter(p.lockAfter).id,
    dictationOnDevice: p.dictationOnDevice !== false,
    dictationAllowService: p.dictationAllowService !== false,
    lanDismissed: p.lanDismissed === true
  };
}

// mobile/shell/device.js
function isLanPage(win) {
  const loc = win?.location ?? {};
  if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(loc.hostname ?? ""))) return false;
  return win?.isSecureContext === false || String(loc.protocol ?? "") === "http:";
}

// mobile/shell/screens/route.js
var COUNTDOWN_S = 120;
var CARRIERS = Object.freeze(["lan", "tailscale", "relay"]);
var STATUS_SCREENS = Object.freeze(["revoked", "update-app", "update-desktop"]);
var RECONNECT_STATES = Object.freeze(["connecting", "reconnecting", "offline", "asleep"]);
function stateKey(s) {
  return JSON.stringify([
    s?.locked === true,
    s?.pairing?.state ?? null,
    s?.pairing?.reason ?? null,
    s?.connection?.status ?? null,
    s?.activeId ?? null
  ]);
}
function terminalScreen(s) {
  const p = s.pairing ?? null;
  if (p?.state === "mismatch") return "mismatch";
  if (p?.state === "denied") return "denied";
  if (p?.state === "expired") return "expired";
  if (p?.state === "failed") return pairingFailureScreen(p.reason);
  const status = s.connection?.status ?? null;
  if (STATUS_SCREENS.includes(status)) return status;
  return null;
}
function screenFor(s, nav = {}) {
  if (!s) return null;
  if (s.locked) return s.lock?.mode === "pin" ? "lock-pin" : "lock-bio";
  const p = s.pairing ?? null;
  if (p?.state === "review") return "pair-review";
  if (p?.state === "confirm" && !nav.pairingCancelled) {
    if (nav.forced) return nav.forced;
    return nav.codeExpired ? "expired" : "code";
  }
  if (nav.pairingCancelled && nav.screen === "mismatch") return "mismatch";
  const dismissed = nav.dismissedKey != null && nav.dismissedKey === stateKey(s);
  if (p?.state === "starting") return "connecting";
  if (!dismissed) {
    const shown = terminalScreen(s);
    if (shown) return shown;
  }
  if (nav.onboarding?.length) return nav.onboarding[0];
  if (nav.uiState) return nav.uiState;
  if (s.ui?.state === "loading" || s.ui?.state === "navigating") return "loading";
  if (s.ui?.state === "failed") return "ui-failed";
  if (!dismissed && s.activeId && !s.hello) {
    const status = s.connection?.status ?? null;
    if (nav.wasConnected === s.activeId && RECONNECT_STATES.includes(status)) return "connected";
    if (status === "connecting" || status === "reconnecting") return "connecting";
    if (status === "offline" || status === "asleep") return "failed";
  }
  if (nav.screen === "computers") return null;
  if (nav.screen) return nav.screen;
  if (!s.computers?.length) return "welcome";
  return null;
}
function pairingFailureScreen(reason) {
  if (reason === "not-plenum" || reason === "version" || reason === "bad-link" || reason === "expired") return "paste";
  return "failed";
}
function pasteError(pairing) {
  if (pairing?.state !== "failed") return null;
  return pairing.reason === "expired" ? "expired" : "not-plenum";
}
function codeSecondsLeft(codeSince, now) {
  if (codeSince == null) return COUNTDOWN_S;
  const used = Math.floor((now - codeSince) / 1e3);
  return Math.max(0, COUNTDOWN_S - used);
}
function platformOf(env = {}) {
  const cap = env.Capacitor;
  if (cap?.isNativePlatform?.() === true) return cap.getPlatform?.() === "android" ? "android" : "ios";
  return "web";
}
function lanPage(env = {}) {
  return isLanPage(env);
}
function defaultPhoneName(platform) {
  if (platform === "ios") return "iPhone";
  if (platform === "android") return "Android phone";
  return "Phone";
}
function passkeyAvailable(env = {}) {
  return env.isSecureContext === true && typeof env.PublicKeyCredential === "function";
}
function drivingText(driving) {
  if (!driving || typeof driving !== "object") return null;
  const app = String(driving.app ?? "").trim();
  if (!app) return null;
  const step = Number(driving.step);
  const of = Number(driving.of);
  if (Number.isFinite(step) && Number.isFinite(of) && of > 0) return `${app}, step ${step} of ${of}`;
  return app;
}
function clockTime(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function stripFor(conn, computer, env = {}) {
  if (env.navigator?.onLine === false) return { tone: "muted", text: "This phone is offline." };
  const status = conn?.status ?? null;
  const when = conn?.lastSeen ? ` Last seen ${clockTime(conn.lastSeen)}.` : "";
  if (status === "reconnecting") return { tone: "warn", text: `Reconnecting to ${computer}\u2026` };
  if (status === "offline") return { tone: "bad", text: `Can't reach ${computer}.${when}` };
  if (status === "asleep") return { tone: "muted", text: ASLEEP_STRIP(computer, when) };
  return null;
}
function ctxFor(s, nav = {}, env = {}) {
  const platform = platformOf(env);
  const lan = lanPage(env);
  const hello = s?.hello ?? null;
  const active = (s?.computers ?? []).find((c) => c.id === s?.activeId) ?? null;
  const computer = String(hello?.desktopName || active?.name || "your computer");
  const conn = s?.connection ?? {};
  const pairing = s?.pairing ?? null;
  const tried = pairing?.tried ?? conn.failure?.tried ?? [];
  const driving = hello?.pending?.driving ?? nav.lastDriving ?? null;
  return {
    platform,
    lan,
    computer,
    session: Boolean(s?.activeId) || Boolean(s?.locked && s?.computers?.length),
    phoneName: nav.local?.phoneName ?? defaultPhoneName(platform),
    code: pairing?.code ?? null,
    carrier: conn.carrier ?? pairing?.carrier ?? null,
    failReason: pairing?.state === "failed" ? pairing.reason ?? null : null,
    tried: (Array.isArray(tried) ? tried : []).map((t) => ({ carrier: String(t?.carrier ?? t?.kind ?? ""), reason: t?.reason ?? null })),
    lock: { mode: s?.lock?.mode ?? "off", failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0 },
    pending: hello?.pending ?? null,
    driving: drivingText(driving),
    // True while a computer this session was connected to is coming back (the stand-in says so, and no "Connected").
    reconnecting: Boolean(s?.activeId) && !hello && nav.wasConnected === s?.activeId,
    pasteError: pasteError(pairing),
    desktopVersion: hello?.desktopVersion || null,
    minVersion: conn.failure?.minimum ?? null,
    haveVersion: conn.failure?.have ?? hello?.desktopVersion ?? null,
    appVersion: env.plenumAppVersion ?? null,
    cause: s?.ui?.cause ?? nav.uiCause ?? "checksum",
    hasCopy: Boolean(s?.ui?.hasCopy ?? nav.hasCopy),
    forwarder: FORWARDER_BUILD,
    consentGiven: Boolean(nav.consentGiven),
    passkeyAvailable: passkeyAvailable(env),
    bundled: s?.ui?.kind === "ios",
    progress: s?.ui?.progress ?? nav.progress ?? null,
    // The shell page can open the desktop's UI ("Open Plenum") when it has a UI host; /?shell keeps the person on the shell's own screens.
    uiAvailable: Boolean(s?.ui?.kind),
    stopState: s?.stop?.state ?? "idle",
    // The Stop result text shows only while a Stop is sending, queued, done or failed (C6d).
    stopText: ["sending", "queued", "done", "failed"].includes(s?.stop?.state) ? s.stop.text ?? "" : "",
    review: pairing?.review ?? null,
    lockStop: s?.lockStop ?? { ready: false, computerName: "" },
    storageUnavailable: s?.storage === "unavailable",
    lockUnknown: s?.lock?.mode === "unknown",
    stripInfo: stripFor(conn, computer, env),
    alreadyPaired: false,
    localDenied: false,
    cameraDenied: Boolean(nav.local?.cameraDenied),
    carrierLabel: CARRIER_LABEL[conn.carrier] ?? null,
    onboardMessage: nav.local?.onboardMessage ?? null,
    linkMessage: nav.local?.linkMessage ?? null
  };
}
function offeredCarriers(tried) {
  const seen = [];
  for (const t of Array.isArray(tried) ? tried : []) {
    if (CARRIERS.includes(t?.carrier) && !seen.includes(t.carrier)) seen.push(t.carrier);
  }
  return seen.length ? seen : [...CARRIERS];
}
function failedLines(ctx) {
  const alone = FAILURE_LINES[ctx.failReason ?? ""];
  if (alone) return [{ kind: "reason", text: alone }];
  const notOffered = ctx.platform === "web" && !ctx.lan;
  return offeredCarriers(ctx.tried).map((kind) => {
    const reason = (ctx.tried ?? []).find((t) => t.carrier === kind)?.reason ?? null;
    let text;
    if (reason === "busy") text = FAILED_LINES.busy;
    else if (kind === "lan") text = notOffered ? FAILED_LINES.notOffered : FAILED_LINES.lan;
    else if (kind === "tailscale") text = FAILED_LINES.tailscale;
    else text = FAILED_LINES.relayOff;
    return { kind, text: fill(text, ctx.computer) };
  });
}

// mobile/shell/screens/fixtures.js
var DEMO_BASE = Object.freeze({
  platform: "web",
  lan: false,
  computer: "Home PC",
  session: false,
  phoneName: "Phone",
  code: "482913",
  carrier: "lan",
  tried: Object.freeze([
    Object.freeze({ carrier: "lan", reason: "timeout" }),
    Object.freeze({ carrier: "tailscale", reason: "timeout" }),
    Object.freeze({ carrier: "relay", reason: "closed" })
  ]),
  lock: Object.freeze({ mode: "off", failures: 0, waitSec: 0 }),
  pending: Object.freeze({ approvals: 2, runs: 1 }),
  driving: null,
  pasteError: null,
  desktopVersion: "2.0",
  minVersion: "1.0",
  haveVersion: "0.9",
  appVersion: "1.6",
  cause: "checksum",
  hasCopy: true,
  forwarder: FORWARDER_BUILD,
  consentGiven: false,
  passkeyAvailable: true,
  bundled: false,
  progress: Object.freeze({ done: 21, total: 47 }),
  stopState: "idle",
  stopText: "",
  stripInfo: null,
  alreadyPaired: false,
  localDenied: false,
  cameraDenied: false,
  carrierLabel: "Same network",
  countdown: 120
});
var PER_SCREEN = Object.freeze({
  welcome: { platform: "web", phoneName: "Phone" },
  consent: { platform: "ios", phoneName: "iPhone" },
  how: { platform: "web" },
  scan: { platform: "web" },
  "scan-denied": { platform: "web", cameraDenied: true },
  paste: { platform: "web" },
  localnet: { platform: "ios", phoneName: "iPhone" },
  connecting: { platform: "ios", session: true, carrier: "lan", carrierLabel: "Same network" },
  failed: { platform: "ios", session: true },
  code: { platform: "ios", phoneName: "iPhone" },
  mismatch: { platform: "ios" },
  denied: { platform: "ios" },
  expired: { platform: "ios" },
  "paired-lock": { platform: "ios" },
  "paired-notify": { platform: "ios" },
  loading: { platform: "ios", session: true },
  "lock-bio": { platform: "ios", session: true, driving: "Notepad, step 12 of 80", lock: { mode: "biometric", failures: 0, waitSec: 0 } },
  "lock-pin": { platform: "web", lock: { mode: "pin", failures: 5, waitSec: 30 } },
  "update-app": { platform: "ios", session: true },
  "update-desktop": { platform: "web", session: true },
  revoked: { platform: "web" },
  "ui-failed": { platform: "web", session: true, cause: "checksum", hasCopy: true }
});
function fixtureCtx(id, overrides = {}) {
  if (!SCREEN_IDS.includes(id)) return null;
  return { ...DEMO_BASE, ...PER_SCREEN[id], ...overrides, id };
}
var SESSION_SCREENS = Object.freeze(["connecting", "failed", "loading", "lock-bio", "update-app", "update-desktop", "ui-failed"]);

// mobile/shell/stop.js
var STOP_STATES = Object.freeze(["idle", "sending", "queued", "done", "failed"]);
var STOP_FAILURE_TEXT = Object.freeze({
  title: "Could not reach the computer",
  body: "The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run."
});

// mobile/shell/screens/flows.js
async function call(core, name, ...args) {
  const fn = core?.[name];
  if (typeof fn !== "function") return { ok: false, reason: "unavailable" };
  try {
    const out = await fn.apply(core, args);
    if (out === true) return { ok: true, reason: null };
    if (out && typeof out === "object") {
      const ok = out.ok === true;
      return { ...out, ok, reason: ok ? out.reason ?? null : out.reason ?? "failed" };
    }
    return { ok: false, reason: "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
function enableLockFlow(core, mode) {
  return call(core, "enableLock", mode);
}
function enableNotificationsFlow(core) {
  return call(core, "enableNotifications");
}
function unlockFlow(core, method, arg = null) {
  return call(core, "unlock", method, arg);
}
async function unlockAndStopFlow(core, method) {
  const result = await unlockFlow(core, method);
  if (!result.ok) return result;
  try {
    await core.stop?.();
  } catch {
    return { ...result, stopped: false };
  }
  return { ...result, stopped: true };
}
async function forgetFlow(core, id) {
  if (typeof core?.forget !== "function" || !id) return { ok: false, reason: "unavailable" };
  try {
    await core.forget(id);
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
var REPO = "https://github.com/RealAlcibiades/Plenum";
var LEGAL_LINKS = Object.freeze({
  privacy: `${REPO}/blob/main/legal/PRIVACY.md`,
  "third-party": `${REPO}/blob/main/legal/THIRD-PARTY-SERVICES.md`,
  license: `${REPO}/blob/main/legal/EULA.md`,
  third: `${REPO}/blob/main/THIRD-PARTY-NOTICES.txt`
});
var STORE_LINKS = Object.freeze({ ios: null, android: `${REPO}/releases`, web: `${REPO}/releases` });
function openLinkFlow(env, href) {
  if (!href) return { ok: false, reason: "not-configured" };
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return { ok: false, reason: "bad-link" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "bad-link" };
  const browser = env?.Capacitor?.Plugins?.Browser;
  if (browser?.open) {
    Promise.resolve(browser.open({ url: url.href })).catch(() => {
    });
    return { ok: true, reason: null };
  }
  if (typeof env?.open === "function") {
    env.open(url.href, "_blank", "noopener");
    return { ok: true, reason: null };
  }
  return { ok: false, reason: "unavailable" };
}
function openSettingsFlow() {
  return { ok: false, reason: "manual" };
}
function cleanPhoneName(text, fallback) {
  const cleaned = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, 60).trim();
  return cleaned || fallback;
}

// mobile/shell/screens/views.js
var LOCK_SCREENS = Object.freeze(["lock-bio", "lock-pin"]);
var storageLine = (ctx) => ctx.storageUnavailable ? el("p", { class: "sh-msg sh-warn", role: "note", text: STORAGE_UNAVAILABLE }) : null;
function frame(ctx, io, o) {
  const classes = ["sh-screen"];
  if (ctx.session && !LOCK_SCREENS.includes(ctx.id)) classes.push("sh-has-stop");
  if (ctx.stripInfo) classes.push("sh-has-strip");
  if (o.center) classes.push("sh-center");
  const back = o.back ? el("button", { type: "button", class: "sh-icon", "aria-label": "Back", on: { click: () => io.back() } }, "\u2039") : el("span", { class: "sh-icon-gap", "aria-hidden": "true" });
  const head = el("header", { class: "sh-top" }, back, o.trailing ?? null);
  const title = el("h1", { class: "sh-title", id: "sh-title", tabindex: "-1" }, o.title);
  const main = el(
    "main",
    { class: "sh-main", id: "sh-main" },
    o.lead ?? null,
    o.kicker ? el("p", { class: o.kickerClass ?? "sh-kicker" }, o.kicker) : null,
    title,
    o.body ?? null,
    ctx.linkMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.linkMessage }) : null
  );
  const actions = (o.actions ?? []).filter(Boolean);
  const foot = actions.length ? el("footer", { class: "sh-actions" }, actions) : null;
  const root = el("div", { class: classes.join(" "), "data-screen": ctx.id }, head, main, foot);
  return root;
}
var para = (text, cls = null) => el("p", { class: cls, text });
function mark(size) {
  return el("img", { class: "sh-mark", src: "icons/app.svg", alt: "", width: String(size), height: String(size) });
}
function welcome(ctx, io) {
  const declined = Boolean(io.local.consentDeclined);
  const needsConsent = ctx.platform === "ios" && !ctx.consentGiven;
  const input = el("input", { class: "sh-input", id: "sh-name", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "64", "aria-describedby": "sh-name-help" });
  input.value = io.local.phoneName ?? ctx.phoneName;
  input.addEventListener("input", () => {
    io.local.phoneName = input.value;
  });
  const [first, second] = welcomePrivacy(ctx.forwarder);
  return frame(ctx, io, {
    title: WELCOME_TITLE,
    lead: mark(72),
    body: [
      storageLine(ctx),
      para(WELCOME_LEAD),
      para(`${first} ${second}`, "sh-note"),
      el(
        "div",
        { class: "sh-field" },
        el("label", { class: "sh-label", for: "sh-name", text: "This phone's name" }),
        input,
        para("Your computer shows this name.", "sh-help")
      ),
      declined ? el("button", { type: "button", class: "sh-link sh-consent-line", on: { click: () => io.go("consent") } }, NEEDS_CONSENT) : null
    ],
    actions: [
      button("Try the demo", { kind: "ghost", onClick: () => io.act.tryDemo() }),
      button("Pair with your computer", { kind: "primary", disabled: declined, onClick: () => io.go(needsConsent ? "consent" : "how") })
    ]
  });
}
function consent(ctx, io) {
  return frame(ctx, io, {
    title: "Before you pair",
    back: true,
    body: [
      para(CONSENT_TEXT),
      el(
        "div",
        { class: "sh-links" },
        button("Privacy Notice", { kind: "link", onClick: () => io.act.openLegal("privacy") }),
        button("Third-party services", { kind: "link", onClick: () => io.act.openLegal("third-party") })
      )
    ],
    actions: [
      button("Not now", { kind: "ghost", onClick: () => {
        io.local.consentDeclined = true;
        io.go("welcome");
      } }),
      button("Allow", { kind: "primary", onClick: () => {
        io.act.consent(true);
        io.go("how");
      } })
    ]
  });
}
function how(ctx, io) {
  const steps = HOW_STEPS.map((text) => el("li", { text }));
  const actions = ctx.lan ? [button("Paste a link", { kind: "primary", onClick: () => io.go("paste") })] : [button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }), button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })];
  return frame(ctx, io, {
    title: "Pair with your computer",
    back: true,
    body: [
      el("ol", { class: "sh-steps" }, steps),
      para(HOW_NOTE, "sh-note"),
      ctx.lan ? para(LAN_NO_CAMERA, "sh-note") : null,
      ctx.install ? el(
        "div",
        { class: "sh-links" },
        button(ctx.install === "ios" ? "Add Plenum to your Home Screen first" : "Install Plenum first", { kind: "link", onClick: () => io.go(ctx.install === "ios" ? "install-ios" : "install-android") })
      ) : null
    ],
    actions
  });
}
function scan(ctx, io) {
  if (ctx.cameraDenied) return scanDenied(ctx, io);
  const video = el("video", { class: "sh-video", playsinline: true, muted: true, autoplay: true, hidden: ctx.platform !== "web", "aria-hidden": "true" });
  video.muted = true;
  const viewfinder = el(
    "div",
    { class: "sh-viewfinder", role: "img", "aria-label": "Camera view. Point at the code on your computer." },
    video,
    el("span", { class: "sh-corner sh-c1", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c2", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c3", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c4", "aria-hidden": "true" })
  );
  io.later(() => {
    io.act.startScan?.(video);
  }, 0);
  return frame(ctx, io, {
    title: "Scan the code",
    back: true,
    body: [
      viewfinder,
      para(SCAN_HINT, "sh-note sh-center-text"),
      el("p", { class: "sh-note sh-scan-note", role: "status" }, io.local.scanNote ?? null)
    ],
    actions: [button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") })]
  });
}
function scanDenied(ctx, io) {
  return frame(ctx, io, {
    title: "Scan the code",
    back: true,
    body: [para(SCAN_DENIED, "sh-note")],
    actions: [
      button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }),
      button("Open Settings", { kind: "primary", onClick: () => io.act.openSettings("camera") })
    ]
  });
}
function scanDeniedScreen(ctx, io) {
  return scanDenied({ ...ctx, cameraDenied: true }, io);
}
function paste(ctx, io) {
  const area = el("textarea", { class: "sh-input sh-textarea", id: "sh-link", rows: "4", autocomplete: "off", spellcheck: "false", "aria-describedby": "sh-link-err" });
  area.value = io.local.link ?? "";
  area.addEventListener("input", () => {
    io.local.link = area.value;
  });
  const errorKey = ctx.pasteError ?? null;
  const error = errorKey ? PASTE_ERRORS[errorKey] : null;
  const native = ctx.platform !== "web";
  return frame(ctx, io, {
    title: "Paste a link",
    back: true,
    body: [
      el(
        "div",
        { class: "sh-field" },
        el("label", { class: "sh-label", for: "sh-link", text: "Pairing link" }),
        area
      ),
      el("p", { class: "sh-msg", id: "sh-link-err", role: "alert" }, error)
    ],
    actions: [
      native ? button("Paste from clipboard", { kind: "ghost", onClick: () => io.act.readClipboard((text) => {
        area.value = text;
        io.local.link = text;
      }) }) : null,
      button("Connect", { kind: "primary", onClick: () => io.act.pair(area.value) })
    ]
  });
}
function localnet(ctx, io) {
  const denied2 = Boolean(ctx.localDenied);
  return frame(ctx, io, {
    title: "Find your computer on this Wi-Fi",
    back: true,
    body: [para(denied2 ? LOCALNET_DENIED : `To reach ${ctx.computer} on this network, ${LOCALNET_BODY}`)],
    actions: denied2 ? [
      button("Try other ways", { kind: "ghost", onClick: () => io.go("how") }),
      button("Open Settings", { kind: "primary", onClick: () => io.act.openSettings("local-network") })
    ] : [button("Continue", { kind: "primary", onClick: () => {
      io.act.continueLocalNet();
      io.back();
    } })]
  });
}
function connecting(ctx, io) {
  const carrier = CARRIER_LABEL[ctx.carrier] ?? ctx.carrierLabel ?? null;
  const step = (state, label, note) => {
    const mark2 = state === "done" ? "\u2713" : state === "active" ? "\u25CC" : "\u25CB";
    const status = state === "done" ? "done" : state === "active" ? "in progress" : "waiting";
    return el(
      "li",
      { class: `sh-step sh-step-${state}` },
      el("span", { class: "sh-step-mark", "aria-hidden": "true" }, mark2),
      el(
        "span",
        { class: "sh-step-text" },
        el("span", { class: "sh-sr" }, `${status}: `),
        label,
        note ? el("span", { class: "sh-step-note", text: note }) : null
      )
    );
  };
  return frame(ctx, io, {
    title: `Connecting to ${ctx.computer}`,
    body: [el(
      "ul",
      { class: "sh-steps sh-progress-list" },
      step("done", "Read the code"),
      step("active", fill("Reaching {computer}", ctx.computer), carrier),
      step("waiting", "Checking the code")
    )],
    actions: [button("Cancel", { kind: "ghost", onClick: () => io.act.cancelConnect() })]
  });
}
function failed(ctx, io) {
  const lines = failedLines(ctx).map((line) => el(
    "li",
    { class: "sh-line" },
    el("span", { class: "sh-bullet", "aria-hidden": "true" }),
    el("span", { text: line.text })
  ));
  const busy = ctx.tried.some((t) => t.reason === "busy");
  return frame(ctx, io, {
    title: `Could not reach ${ctx.computer}`,
    body: [
      storageLine(ctx),
      el("ul", { class: "sh-lines" }, lines),
      busy ? para(fill(FAILED_LINES.busy, ctx.computer), "sh-note") : null
    ],
    actions: [button("Try again", { kind: "primary", onClick: () => io.act.retry() })]
  });
}
function code(ctx, io) {
  const countdown = el(
    "p",
    { class: "sh-countdown" },
    el("span", { text: `Waiting for Allow on ${ctx.computer} ` }),
    el("span", { "data-countdown": "", text: clock(ctx.countdown ?? 120) })
  );
  return frame(ctx, io, {
    title: PAIRING_CHECK,
    body: [
      el("p", { class: "sh-code", role: "img", "aria-label": codeLabel(ctx.code), text: codeSpaced(ctx.code) }),
      para(`${ctx.computer} ${CODE_TEXT}`, "sh-note"),
      countdown
    ],
    actions: [button("The codes do not match", { kind: "danger", onClick: () => io.act.mismatch() })]
  });
}
function mismatch(ctx, io) {
  return frame(ctx, io, {
    title: "The codes do not match",
    body: [para(MISMATCH_BODY, "sh-note")],
    actions: [button("Try again", { kind: "primary", onClick: () => io.go("how") })]
  });
}
function denied(ctx, io) {
  return frame(ctx, io, {
    title: "Pairing was not allowed",
    body: [para(`${ctx.computer} ${DENIED_BODY}`, "sh-note")],
    actions: [button("Try again", { kind: "primary", onClick: () => io.go("how") })]
  });
}
function expired(ctx, io) {
  const actions = ctx.lan ? [button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })] : [button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }), button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })];
  return frame(ctx, io, {
    title: "The code expired",
    body: [para(EXPIRED_BODY, "sh-note")],
    actions
  });
}
function stepThen(io, call2) {
  return async () => {
    const result = await call2();
    if (result?.ok === true) {
      io.local.onboardMessage = null;
      io.advance();
      return;
    }
    io.local.onboardMessage = lockFailText(result?.reason ?? "failed");
    io.repaint();
  };
}
function pairedLock(ctx, io) {
  const bio = biometricName(ctx.platform);
  const web = ctx.platform === "web";
  const advance = () => {
    io.local.onboardMessage = null;
    io.advance();
  };
  const message = ctx.onboardMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.onboardMessage }) : null;
  const withPasskey = web && ctx.passkeyAvailable === true;
  return frame(ctx, io, {
    kicker: `\u2713 Paired with ${ctx.computer}`,
    kickerClass: "sh-status",
    title: `Lock Plenum with ${bio}`,
    body: [
      para(`Plenum asks for ${bio} before it connects, and again after 5 minutes in the background.`, "sh-note"),
      message
    ],
    actions: web ? [
      button("Not now", { kind: "ghost", onClick: advance }),
      button("Set a PIN", { kind: withPasskey ? "ghost" : "primary", onClick: () => io.go("pin-set") }),
      withPasskey ? button("Use a passkey", { kind: "primary", onClick: stepThen(io, () => io.act.enableLock("passkey")) }) : null
    ] : [
      button("Not now", { kind: "ghost", onClick: advance }),
      button("Turn on", { kind: "primary", onClick: stepThen(io, () => io.act.enableLock("biometric")) })
    ]
  });
}
function pairedNotify(ctx, io) {
  const advance = () => {
    io.local.onboardMessage = null;
    io.advance();
  };
  const message = ctx.onboardMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.onboardMessage }) : null;
  if (ctx.platform === "ios" && !ctx.forwarder) {
    return frame(ctx, io, {
      title: "Notifications",
      body: [para(NOTIFY_BODY_LATER, "sh-note"), message],
      actions: [button("Continue", { kind: "primary", onClick: advance })]
    });
  }
  return frame(ctx, io, {
    title: "Notifications",
    body: [para(fill(NOTIFY_BODY, ctx.computer), "sh-note"), message],
    actions: [
      button("Not now", { kind: "ghost", onClick: advance }),
      button("Turn on", { kind: "primary", onClick: stepThen(io, () => io.act.enableNotifications()) })
    ]
  });
}
function loading(ctx, io) {
  const total = Math.max(1, Number(ctx.progress?.total) || 1);
  const done = Math.min(total, Math.max(0, Number(ctx.progress?.done) || 0));
  const root = frame(ctx, io, {
    title: ctx.bundled ? "Starting Plenum\u2026" : `Loading Plenum from ${ctx.computer}`,
    lead: mark(48),
    body: [
      el("progress", { class: "sh-progress", max: String(total), value: String(done), "aria-label": "Loading Plenum" }),
      para(`${done} of ${total}`, "sh-note"),
      para(LOADING_HINT, "sh-help")
    ]
  });
  if (ctx.bundled) {
    root.hidden = true;
    io.later(() => {
      root.hidden = false;
    }, 400);
  }
  return root;
}
function lockBio(ctx, io) {
  const method = ctx.lock.mode === "passkey" ? "passkey" : "biometric";
  const bio = method === "passkey" ? "a passkey" : biometricName(ctx.platform);
  const message = ctx.bioMessage ?? null;
  const stopReady = ctx.lockStop?.ready === true;
  const unknown = ctx.lockUnknown === true;
  const stopAll = ctx.session ? button(stopReady ? LOCK_STOP : LOCK_UNLOCK_STOP, {
    kind: "danger",
    onClick: () => stopReady ? io.act.stopLocked() : io.act.unlockAndStop(method)
  }) : null;
  return frame(ctx, io, {
    center: true,
    lead: mark(56),
    title: "Plenum is locked",
    body: [
      ctx.driving ? el("p", { class: "sh-note sh-driving", role: "status", text: drivingLine(ctx.computer, ctx.driving) }) : null,
      unknown ? para(LOCK_UNKNOWN, "sh-note") : null,
      ctx.stopText ? el("p", { class: "sh-note", role: "status", text: ctx.stopText }) : null,
      el("p", { class: "sh-msg", role: "alert" }, message)
    ],
    actions: [
      stopAll,
      unknown ? null : button(`Unlock with ${bio}`, { kind: "primary", onClick: () => io.act.unlock(method) })
    ]
  });
}
function lockPin(ctx, io) {
  if (ctx.lockUnknown) return lockBio(ctx, io);
  let digits = "";
  const dots = Array.from({ length: 6 }, () => el("span", { class: "sh-dot", "aria-hidden": "true" }));
  const counter = el("span", { class: "sh-sr", "aria-live": "polite" }, "0 of 6 digits entered");
  const message = el(
    "p",
    { class: "sh-msg", id: "sh-pin-msg", role: "alert" },
    io.local.pinMessage ?? (ctx.lock.waitSec > 0 ? `Wrong PIN. ${waitText(ctx.lock.waitSec)}` : null)
  );
  const draw = () => {
    dots.forEach((dot, i) => {
      if (i < digits.length) dot.setAttribute("data-on", "");
      else dot.removeAttribute("data-on");
    });
    counter.textContent = `${digits.length} of 6 digits entered`;
  };
  const press = async (key) => {
    if (key === "Delete") {
      digits = digits.slice(0, -1);
      draw();
      return;
    }
    if (digits.length >= 6) return;
    digits += key;
    draw();
    if (digits.length < 6) return;
    const entered = digits;
    digits = "";
    draw();
    const result = await io.act.unlock("pin", entered);
    if (result && result.ok === false) {
      const wait = Number(result.waitSec) || 0;
      io.local.pinMessage = result.reason === "wait" ? waitText(wait) : wait > 0 ? `Wrong PIN. ${waitText(wait)}` : "Wrong PIN.";
      message.textContent = io.local.pinMessage;
      return;
    }
    if (result?.ok === true && io.local.stopAfterUnlock) {
      io.local.stopAfterUnlock = false;
      await io.act.stop();
    }
  };
  const keyNames = ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"];
  const pad = el(
    "div",
    { class: "sh-pad", role: "group", "aria-label": "PIN" },
    keyNames.map((key) => key === null ? el("span", { class: "sh-key-gap", "aria-hidden": "true" }) : el("button", {
      type: "button",
      class: key === "Delete" ? "sh-key sh-key-del" : "sh-key",
      "aria-label": key === "Delete" ? "Delete" : key,
      on: { click: () => {
        press(key);
      } }
    }, key === "Delete" ? "Delete" : key))
  );
  draw();
  const stopReady = ctx.lockStop?.ready === true;
  const stopAll = ctx.session ? button(stopReady ? LOCK_STOP : LOCK_UNLOCK_STOP, {
    kind: "danger",
    onClick: () => {
      if (stopReady) {
        io.act.stopLocked();
        return;
      }
      io.local.stopAfterUnlock = true;
      message.textContent = "Enter your PIN. Plenum stops everything once it unlocks.";
    }
  }) : null;
  return frame(ctx, io, {
    center: true,
    lead: mark(56),
    title: "Plenum is locked",
    body: [
      ctx.driving ? el("p", { class: "sh-note sh-driving", role: "status", text: drivingLine(ctx.computer, ctx.driving) }) : null,
      el("div", { class: "sh-dots" }, dots),
      counter,
      pad,
      ctx.stopText ? el("p", { class: "sh-note", role: "status", text: ctx.stopText }) : null,
      message
    ],
    actions: [stopAll]
  });
}
function storeButtonLabel(platform) {
  const link = STORE_LINKS[platform] ?? null;
  if (link && link.startsWith("https://github.com/")) return storeLabel("web");
  return storeLabel(platform);
}
function updateApp(ctx, io) {
  return frame(ctx, io, {
    title: "Update the app",
    body: [para(updateAppBody(ctx.computer, ctx.desktopVersion ?? "", ctx.appVersion), "sh-note")],
    actions: [
      button("Choose another computer", { kind: "ghost", onClick: () => io.act.chooseComputer() }),
      button(storeButtonLabel(ctx.platform), { kind: "primary", onClick: () => io.act.openStore() })
    ]
  });
}
function updateDesktop(ctx, io) {
  return frame(ctx, io, {
    title: "Update Plenum on your computer",
    body: [para(updateDesktopBody(ctx.computer, ctx.minVersion ?? "", ctx.haveVersion ?? ""), "sh-note")],
    actions: [button("Try again", { kind: "primary", onClick: () => io.act.retry() })]
  });
}
function revoked(ctx, io) {
  return frame(ctx, io, {
    title: `${ctx.computer} removed this phone`,
    body: [para(REVOKED_BODY, "sh-note")],
    actions: [
      button(`Forget ${ctx.computer} here`, { kind: "ghost", onClick: () => io.act.forgetActive() }),
      button("Pair again", {
        kind: "primary",
        onClick: async () => {
          await io.act.forgetActive();
          io.go(ctx.platform === "ios" && !ctx.consentGiven ? "consent" : "how");
        }
      })
    ]
  });
}
var WORKER_TEXT = "This browser cannot keep Plenum's screens on the phone. Open Plenum in Chrome or Safari, or add it to your Home Screen, then try again.";
function uiFailed(ctx, io) {
  const pending = pendingLine(ctx.computer, ctx.pending);
  return frame(ctx, io, {
    title: "Plenum's screens did not load",
    body: [
      para(ctx.cause === "worker" ? WORKER_TEXT : uiFailedBody(ctx.computer, ctx.cause), "sh-note"),
      pending ? para(pending, "sh-help") : null
    ],
    actions: [
      button(`Send the log to ${ctx.computer}`, { kind: "ghost", onClick: () => io.act.sendLog() }),
      ctx.hasCopy ? button("Use the copy in this app", { kind: "ghost", onClick: () => io.act.useCopy() }) : null,
      button("Try again", { kind: "primary", onClick: () => io.act.retry() })
    ]
  });
}
var BUILDERS = Object.freeze({
  welcome,
  consent,
  how,
  scan,
  "scan-denied": scanDeniedScreen,
  paste,
  localnet,
  connecting,
  failed,
  code,
  mismatch,
  denied,
  expired,
  "paired-lock": pairedLock,
  "paired-notify": pairedNotify,
  loading,
  "lock-bio": lockBio,
  "lock-pin": lockPin,
  "update-app": updateApp,
  "update-desktop": updateDesktop,
  revoked,
  "ui-failed": uiFailed
});
function renderScreen(id, ctx, io) {
  const build = BUILDERS[id];
  if (!build) return null;
  return build({ ...ctx, id }, io);
}

// mobile/shell/screens/views2.js
var section = (label) => el("p", { class: "sh-section", text: label });
function row(label, value, onClick, extra = {}) {
  return el(
    "button",
    { type: "button", class: "sh-row", ...extra, on: { click: onClick } },
    el("span", { class: "sh-row-label", text: label }),
    value ? el("span", { class: "sh-row-value", text: value }) : null,
    el("span", { class: "sh-row-chev", "aria-hidden": "true", text: "\u203A" })
  );
}
function switchRow({ label, checked, disabled = false, note = null, onChange, id = null }) {
  const noteId = note && id ? `${id}-note` : null;
  return el(
    "div",
    { class: `sh-switch-wrap${disabled ? " sh-switch-off" : ""}` },
    el(
      "button",
      {
        type: "button",
        class: "sh-switch",
        role: "switch",
        id,
        "aria-checked": checked ? "true" : "false",
        "aria-disabled": disabled ? "true" : null,
        "aria-describedby": noteId,
        on: { click: () => {
          if (!disabled && onChange) onChange(!checked);
        } }
      },
      el("span", { class: "sh-switch-label", text: label }),
      el("span", { class: "sh-switch-knob", "aria-hidden": "true" })
    ),
    note ? el("p", { class: "sh-help", id: noteId, text: note }) : null
  );
}
function radioGroup(label, options, value, onPick) {
  return el(
    "div",
    { class: "sh-radios", role: "radiogroup", "aria-label": label },
    options.map((opt) => el("button", {
      type: "button",
      class: "sh-radio",
      role: "radio",
      "aria-checked": opt.id === value ? "true" : "false",
      on: { click: () => onPick(opt.id) }
    }, el("span", { class: "sh-radio-dot", "aria-hidden": "true" }), el("span", { text: opt.label })))
  );
}
var msgNode = (text) => text ? el("p", { class: "sh-msg", role: "status", text }) : null;
function pairReview(ctx, io) {
  const hosts = Array.isArray(ctx.review?.hosts) ? ctx.review.hosts : [];
  return frame(ctx, io, {
    title: PAIR_REVIEW_TITLE(ctx.review?.name || "Plenum computer"),
    body: [
      para(PAIR_REVIEW_LEAD, "sh-note"),
      para(PAIR_REVIEW_HOSTS, "sh-label"),
      ...hosts.map((h) => para(`${CARRIER_LABEL[h.kind]}: ${h.host}`, "sh-note")),
      para(PAIR_REVIEW_NOTE, "sh-help")
    ],
    actions: [
      button(PAIR_REVIEW_CANCEL, { kind: "ghost", onClick: () => io.act.cancelPair() }),
      button(PAIR_REVIEW_PAIR, { kind: "primary", onClick: () => io.act.confirmPair() })
    ]
  });
}
function computers(ctx, io) {
  const vm = ctx.vm;
  const menuOpen = io.local.rowMenu ?? null;
  const rows = vm.computers.map((c) => {
    const status = rowStatus({ active: c.active, connected: c.connected, status: c.status, lastSeen: c.lastSeen, dateText: c.dateText });
    const meta = [c.active && c.connected ? c.carrierLabel : c.lastCarrierLabel ? `Last by ${c.lastCarrierLabel}` : null, c.version ? `Plenum ${c.version}` : null].filter(Boolean).join(" \xB7 ");
    const menu = menuOpen === c.id ? el(
      "div",
      { class: "sh-rowmenu" },
      button(ROW_MENU.connect, { kind: "ghost", onClick: () => io.act.connect(c.id) }),
      button(ROW_MENU.ways, { kind: "ghost", onClick: () => {
        io.local.waysFor = c.id;
        io.go("settings-connection");
      } }),
      button(ROW_MENU.rename, { kind: "ghost", onClick: () => {
        io.local.renameId = c.id;
        io.go("rename");
      } }),
      button(ROW_MENU.forget, { kind: "danger", onClick: () => {
        io.local.forgetId = c.id;
        io.go("forget");
      } })
    ) : null;
    return el(
      "li",
      { class: "sh-computer" },
      el(
        "div",
        { class: "sh-computer-main" },
        el(
          "button",
          { type: "button", class: "sh-computer-open", on: { click: () => io.act.connect(c.id) } },
          el("span", { class: "sh-computer-name", text: c.name }),
          status ? el("span", { class: "sh-computer-status", text: status }) : null,
          meta ? el("span", { class: "sh-computer-meta", text: meta }) : null
        ),
        el("button", {
          type: "button",
          class: "sh-icon sh-computer-more",
          "aria-label": `More for ${c.name}`,
          "aria-expanded": menuOpen === c.id ? "true" : "false",
          on: { click: () => {
            io.local.rowMenu = menuOpen === c.id ? null : c.id;
            io.repaint();
          } }
        }, "\u22EF")
      ),
      menu
    );
  });
  const gear = el("button", { type: "button", class: "sh-icon", "aria-label": SETTINGS_TITLE, on: { click: () => io.go("settings") } }, "\u2699");
  return frame(ctx, io, {
    title: COMPUTERS_TITLE,
    trailing: gear,
    body: [
      section(COMPUTERS_LABEL),
      rows.length ? el("ul", { class: "sh-computers" }, rows) : para(SETTINGS_NONE, "sh-note")
    ],
    actions: [button(PAIR_ANOTHER, { kind: "primary", onClick: () => io.go("how") })]
  });
}
function installIos(ctx, io) {
  return frame(ctx, io, {
    title: "Add Plenum to your Home Screen",
    back: true,
    body: [
      para(INSTALL_IOS_BODY, "sh-note"),
      el("ol", { class: "sh-steps sh-install-steps" }, INSTALL_IOS_STEPS.map((text, i) => el("li", { class: "sh-install-step", "data-step": String(i + 1) }, text)))
    ],
    actions: [button(INSTALL_IOS_PAIR_HERE, { kind: "primary", onClick: () => io.go("how") })]
  });
}
function installAndroid(ctx, io) {
  return frame(ctx, io, {
    title: "Install Plenum",
    back: true,
    body: [
      para(INSTALL_ANDROID_BODY, "sh-note"),
      msgNode(io.local.installNote ?? null)
    ],
    actions: [
      button(NOT_NOW, { kind: "ghost", onClick: () => io.go("how") }),
      button("Install", { kind: "primary", onClick: () => io.act.installApp() })
    ]
  });
}
function lanWeb(ctx, io) {
  return frame(ctx, io, {
    title: "Plenum on this page",
    back: true,
    body: [para(fill(LAN_WEB_STRIP, ctx.computer), "sh-note")],
    actions: [button("Got it", { kind: "primary", onClick: () => {
      io.act.dismissLan();
      io.back();
    } })]
  });
}
function connected(ctx, io) {
  const vm = ctx.vm;
  const pending = pendingLine(ctx.computer, ctx.pending);
  const actions = [
    // The computer's UI is the phone's home (ui-host.js hands the page to it after HELLO). This page is the shell's own screens (/?shell), so
    // the way back to the UI is a button.
    ctx.uiAvailable && !ctx.reconnecting ? button("Open Plenum", { kind: "primary", onClick: () => io.act.openUi() }) : null,
    vm.computers.length > 1 ? button("Computers", { kind: "ghost", onClick: () => io.go("computers") }) : null,
    button("Ways to reach", { kind: "ghost", onClick: () => io.go("settings-connection") }),
    button("Phone settings", { kind: ctx.uiAvailable && !ctx.reconnecting ? "ghost" : "primary", onClick: () => io.go("settings") })
  ];
  if (ctx.reconnecting) {
    return frame(ctx, io, {
      kicker: RECONNECTING_TITLE,
      kickerClass: "sh-status",
      title: ctx.computer,
      body: [para(RECONNECTING_BODY(ctx.computer), "sh-note")],
      actions
    });
  }
  return frame(ctx, io, {
    kicker: `\u2713 ${CONNECTED_TITLE}`,
    kickerClass: "sh-status",
    title: ctx.computer,
    body: [
      para(CONNECTED_SINCE(ctx.computer, vm.connected.since), "sh-note"),
      para(`${vm.connected.carrierLabel ?? "No carrier named"}${ctx.desktopVersion ? ` \xB7 Plenum ${ctx.desktopVersion}` : ""}`, "sh-help"),
      pending ? para(pending, "sh-note") : null
    ],
    actions
  });
}
function rename(ctx, io) {
  const target = (vm) => vm.computers.find((c) => c.id === io.local.renameId) ?? vm.computers.find((c) => c.active) ?? null;
  const current = target(ctx.vm);
  const input = el("input", { class: "sh-input", id: "sh-rename", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "60", "aria-describedby": "sh-rename-help" });
  input.value = io.local.renameValue ?? current?.name ?? "";
  input.addEventListener("input", () => {
    io.local.renameValue = input.value;
  });
  return frame(ctx, io, {
    title: RENAME_TITLE,
    back: true,
    body: [
      el(
        "div",
        { class: "sh-field" },
        el("label", { class: "sh-label", for: "sh-rename", text: "Name" }),
        input,
        para(RENAME_HELP, "sh-help")
      ),
      msgNode(io.local.renameNote ?? null)
    ],
    actions: [
      button(CANCEL, { kind: "ghost", onClick: () => io.back() }),
      button(SAVE, { kind: "primary", onClick: async () => {
        const result = await io.act.rename(current?.id ?? null, String(input.value ?? ""));
        if (result?.ok) {
          io.local.renameNote = null;
          io.back();
          return;
        }
        io.local.renameNote = "The name could not be saved. Try again.";
        io.repaint();
      } })
    ]
  });
}
function forget(ctx, io) {
  const id = io.local.forgetId ?? ctx.vm.computers.find((c) => c.active)?.id ?? null;
  const name = ctx.vm.computers.find((c) => c.id === id)?.name ?? ctx.computer;
  let cancel = null;
  const root = frame(ctx, io, {
    title: fillName(FORGET_TITLE, name),
    back: true,
    body: [para(fillName(FORGET_BODY, name), "sh-note"), msgNode(io.local.forgetNote ?? null)],
    actions: [
      cancel = button(CANCEL, { kind: "ghost", onClick: () => io.back() }),
      button(FORGET_CONFIRM, {
        kind: "danger",
        onClick: async () => {
          const result = await io.act.forget(id);
          if (result?.ok) {
            io.local.forgetId = null;
            io.go("computers");
            return;
          }
          io.local.forgetNote = "Plenum could not forget this computer. Try again.";
          io.repaint();
        }
      })
    ]
  });
  io.later(() => {
    cancel?.focus?.({ preventScroll: true });
  }, 0);
  return root;
}
function settings(ctx, io) {
  const vm = ctx.vm;
  const computerRows = vm.computers.map((c) => row(c.name, c.active && c.connected ? "Connected" : null, () => {
    io.local.waysFor = c.id;
    io.go("settings-connection");
  }));
  const lockValue = vm.lock.mode === "off" ? "Off" : `${vm.lock.label} \xB7 ${lockAfter(vm.prefs.lockAfter).label}`;
  return frame(ctx, io, {
    title: SETTINGS_TITLE,
    back: true,
    body: [
      section(SETTINGS_COMPUTERS),
      el("div", { class: "sh-rows" }, computerRows, row(PAIR_ANOTHER_SHORT, null, () => io.go("how"))),
      section(SETTINGS_THIS_PHONE),
      el(
        "div",
        { class: "sh-rows" },
        row(NOTIFY_TITLE, vm.notify.label, () => io.go("settings-notify")),
        row(LOCK_TITLE, lockValue, () => io.go("settings-lock")),
        row(APPEARANCE_TITLE, THEME_LABEL[vm.prefs.theme], () => io.go("settings-appearance")),
        vm.native ? row(DICTATION_TITLE, "On this phone", () => io.go("settings-dictation")) : null
      ),
      section(SETTINGS_HELP),
      el(
        "div",
        { class: "sh-rows" },
        row("Debug console", null, () => io.go("debug")),
        row("About", vm.about.appVersion ? vm.about.appVersion : null, () => io.go("about")),
        row(LEGAL_TITLE, null, () => io.go("legal")),
        row("Report a problem", null, () => io.go("debug"))
      )
    ]
  });
}
function settingsConnection(ctx, io) {
  const vm = ctx.vm;
  const id = io.local.waysFor ?? vm.computers.find((c) => c.active)?.id ?? vm.computers[0]?.id ?? null;
  const target = vm.computers.find((c) => c.id === id) ?? null;
  const name = target?.name ?? ctx.computer;
  const order = orderedWays(target?.carrierOrder ?? []);
  const present = new Set(target?.ways ?? []);
  const ways = order.map((kind, i) => {
    const on = present.has(kind);
    const web = ctx.platform === "web" && !ctx.lan && kind === "lan";
    const label = CARRIER_LABEL[kind];
    const note = web ? WAY_LAN_WEB : on ? target?.waysDetail?.[kind] ?? null : WAY_NO_ADDRESS;
    const probe = io.local.wayProbe?.[kind] ?? null;
    return el(
      "li",
      { class: `sh-way${on ? "" : " sh-way-off"}` },
      el(
        "div",
        { class: "sh-way-main" },
        el(
          "p",
          { class: "sh-way-title" },
          el("span", { class: "sh-way-state", "aria-hidden": "true", text: on ? "[x]" : "[ ]" }),
          el("span", { text: label }),
          el("span", { class: "sh-way-probe", text: web ? WAY_NOT_AVAILABLE : probe ?? (on ? "" : WAY_NOT_REACHABLE) })
        ),
        note ? el("p", { class: "sh-help", text: note }) : null
      ),
      el(
        "div",
        { class: "sh-way-move" },
        el("button", {
          type: "button",
          class: "sh-move",
          "aria-label": `${WAY_MOVE_UP}: ${label}`,
          "aria-disabled": i === 0 ? "true" : null,
          on: { click: () => {
            if (i > 0) io.act.moveWay(id, kind, "up");
          } }
        }, "\u2191"),
        el("button", {
          type: "button",
          class: "sh-move",
          "aria-label": `${WAY_MOVE_DOWN}: ${label}`,
          "aria-disabled": i === order.length - 1 ? "true" : null,
          on: { click: () => {
            if (i < order.length - 1) io.act.moveWay(id, kind, "down");
          } }
        }, "\u2193")
      )
    );
  });
  return frame(ctx, io, {
    title: fill(WAYS_TITLE, name),
    back: true,
    body: [
      para(WAYS_LEAD, "sh-note"),
      el("ul", { class: "sh-ways" }, ways),
      button(WAYS_TEST, { kind: "ghost", onClick: () => io.act.testWays(id) }),
      msgNode(io.local.waysNote ?? null),
      para(WAYS_NEW, "sh-help"),
      el(
        "div",
        { class: "sh-links" },
        button("Rename on this phone", { kind: "link", onClick: () => {
          io.local.renameId = id;
          io.go("rename");
        } }),
        button(ROW_MENU.forget, { kind: "link", onClick: () => {
          io.local.forgetId = id;
          io.go("forget");
        } })
      )
    ]
  });
}
function settingsNotify(ctx, io) {
  const vm = ctx.vm;
  const push = vm.push;
  const approve = vm.approve;
  const pushRows = PUSH_SWITCHES.map((sw) => {
    const key = sw.key;
    const label = sw.key === "onlyWhenAway" ? fill(sw.label, ctx.computer) : sw.label;
    const note = key === "firstLine" ? PHONE_PUSH_TEXT : null;
    return switchRow({
      label,
      checked: push[key] === true,
      note,
      id: `sh-push-${key}`,
      onChange: (value) => io.act.setPush(key, value)
    });
  });
  const approveRow = approve.visible ? switchRow({
    label: NOTIFY_APPROVE_ROW,
    checked: approve.checked,
    disabled: !approve.enabled,
    note: approve.enabled ? null : APPROVE_MISSING_TEXT[approve.missing] ?? null,
    id: "sh-approve",
    onChange: (value) => io.act.setApprove(value)
  }) : null;
  const notes = [
    para(fill(APPROVE_NOTIFY_TEXT, ctx.computer), "sh-note"),
    para(APPROVE_BLOCKED_TEXT, "sh-help")
  ];
  const up = vm.unifiedPush;
  const androidLine = up ? para(unifiedPushLine(up.distributor ?? null), "sh-note") : null;
  const chooseApp = up?.supported ? button("Choose app", { kind: "ghost", onClick: () => io.act.chooseDistributor() }) : null;
  return frame(ctx, io, {
    title: NOTIFY_TITLE,
    back: true,
    body: [
      section(NOTIFY_ON_PHONE),
      el("div", { class: "sh-rows" }, row(NOTIFY_ON_PHONE, vm.notify.label, () => io.act.enableNotifications())),
      vm.notify.hint ? para(vm.notify.hint, "sh-help") : null,
      section(fill(NOTIFY_KEPT, ctx.computer)),
      el("div", { class: "sh-switches" }, pushRows, approveRow, approve.visible ? el("div", { class: "sh-notes" }, notes) : null),
      androidLine,
      chooseApp,
      button(NOTIFY_TEST, { kind: "ghost", onClick: () => io.act.testPush() }),
      msgNode(io.local.notifyNote ?? null),
      para(ctx.platform === "android" ? NOTIFY_NOT_ARRIVING_ANDROID : NOTIFY_NOT_ARRIVING, "sh-help")
    ]
  });
}
function settingsLock(ctx, io) {
  const vm = ctx.vm;
  const on = vm.lock.mode !== "off";
  const web = ctx.platform === "web";
  return frame(ctx, io, {
    title: LOCK_TITLE,
    back: true,
    body: [
      switchRow({
        label: LOCK_ROW,
        checked: on,
        id: "sh-lock-switch",
        onChange: async (value) => {
          if (!value) {
            io.go("phone-lock-off");
            return;
          }
          if (web) {
            io.go("pin-set");
            return;
          }
          const result = await io.act.lockOn("biometric");
          io.local.lockNote = result?.ok ? null : "Plenum did not turn the app lock on. Try again.";
          io.repaint();
        }
      }),
      on ? null : para(LOCK_OFF_HINT, "sh-note"),
      on ? para(`${LOCK_AFTER_LABEL}`, "sh-section") : null,
      on ? radioGroup(LOCK_AFTER_LABEL, LOCK_AFTER, vm.prefs.lockAfter, (id) => io.act.setPref({ lockAfter: id })) : null,
      switchRow({
        label: LOCK_SWITCHER,
        checked: vm.prefs.hideSwitcher,
        id: "sh-switcher",
        onChange: (value) => io.act.setPref({ hideSwitcher: value })
      }),
      web ? para(LOCK_WEB_KEY, "sh-note") : null,
      msgNode(io.local.lockNote ?? null)
    ],
    actions: [
      on ? button(LOCK_NOW, { kind: "primary", onClick: () => io.act.lockNow() }) : null,
      !on && web && ctx.passkeyAvailable ? button("Use a passkey", { kind: "ghost", onClick: async () => {
        const r = await io.act.lockOn("passkey");
        io.local.lockNote = r?.ok ? null : "A passkey could not be set up here.";
        io.repaint();
      } }) : null
    ]
  });
}
function phoneLockOff(ctx, io) {
  const pinMode = ctx.vm.lock.mode === "pin";
  const input = pinMode ? el("input", { class: "sh-input", id: "sh-pin-off", type: "password", inputmode: "numeric", autocomplete: "off", maxlength: "6", "aria-label": "PIN" }) : null;
  return frame(ctx, io, {
    title: LOCK_OFF_TITLE,
    back: true,
    body: [
      el("p", { class: "sh-msg sh-warn", role: "note", text: LOCK_OFF_TEXT }),
      input ? el("div", { class: "sh-field" }, el("label", { class: "sh-label", for: "sh-pin-off", text: "Enter your PIN" }), input) : null,
      msgNode(io.local.lockNote ?? null)
    ],
    actions: [
      button(LOCK_OFF_KEEP, { kind: "primary", onClick: () => io.back() }),
      button(LOCK_OFF_TURN, {
        kind: "danger",
        onClick: async () => {
          const result = await io.act.lockOff(input ? String(input.value ?? "") : null);
          if (result?.ok) {
            io.local.lockNote = null;
            io.go("settings-lock");
            return;
          }
          io.local.lockNote = result?.reason === "pin" ? "That PIN is not right." : "Plenum did not turn the lock off. Try again.";
          io.repaint();
        }
      })
    ]
  });
}
function pinSet(ctx, io) {
  const state = io.local.pinSet ?? (io.local.pinSet = { first: null, digits: "", note: null });
  const dots = Array.from({ length: 6 }, () => el("span", { class: "sh-dot", "aria-hidden": "true" }));
  const counter = el("span", { class: "sh-sr", "aria-live": "polite" }, "0 of 6 digits entered");
  const message = el("p", { class: "sh-msg", role: "alert", id: "sh-pin-set-msg" }, state.note ?? null);
  const draw = () => {
    dots.forEach((dot, i) => {
      if (i < state.digits.length) dot.setAttribute("data-on", "");
      else dot.removeAttribute("data-on");
    });
    counter.textContent = `${state.digits.length} of 6 digits entered`;
  };
  const press = async (key) => {
    if (key === "Delete") {
      state.digits = state.digits.slice(0, -1);
      draw();
      return;
    }
    if (state.digits.length >= 6) return;
    state.digits += key;
    draw();
    if (state.digits.length < 6) return;
    const entered = state.digits;
    state.digits = "";
    draw();
    if (state.first === null) {
      state.first = entered;
      state.note = "Enter the same PIN again.";
      io.repaint();
      return;
    }
    if (entered !== state.first) {
      state.first = null;
      state.note = "The two PINs did not match. Start again.";
      io.repaint();
      return;
    }
    const result = await io.act.setPin(entered);
    state.first = null;
    if (result?.ok) {
      state.note = null;
      io.afterPin();
      return;
    }
    state.note = result?.reason === "mode" ? "The lock is already on." : "That PIN is not valid. Use six digits.";
    io.repaint();
  };
  const keyNames = ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"];
  const pad = el(
    "div",
    { class: "sh-pad", role: "group", "aria-label": "PIN" },
    keyNames.map((key) => key === null ? el("span", { class: "sh-key-gap", "aria-hidden": "true" }) : el("button", {
      type: "button",
      class: key === "Delete" ? "sh-key sh-key-del" : "sh-key",
      "aria-label": key === "Delete" ? "Delete" : key,
      on: { click: () => {
        press(key);
      } }
    }, key === "Delete" ? "Delete" : key))
  );
  draw();
  return frame(ctx, io, {
    title: state.first === null ? "Set a PIN" : "Enter the PIN again",
    back: true,
    body: [
      para("Plenum asks for this PIN before it connects, and again after the lock time you choose. Six digits.", "sh-note"),
      el("div", { class: "sh-dots" }, dots),
      counter,
      pad,
      message
    ]
  });
}
function settingsAppearance(ctx, io) {
  const vm = ctx.vm;
  const prefs = vm.prefs;
  const following = prefs.textSize == null;
  const slider = el("input", {
    class: "sh-range",
    type: "range",
    min: String(TEXT_MIN),
    max: String(TEXT_MAX),
    step: String(TEXT_STEP),
    value: String(prefs.textSize ?? TEXT_DEFAULT),
    "aria-label": "Text size",
    "aria-valuetext": `${prefs.textSize ?? TEXT_DEFAULT} percent`,
    on: { input: (event) => {
      io.act.setPref({ textSize: Number(event.target.value) }, { quiet: true });
    } }
  });
  return frame(ctx, io, {
    title: APPEARANCE_TITLE,
    back: true,
    body: [
      section(APPEARANCE_THEME),
      radioGroup(APPEARANCE_THEME, THEMES.map((id) => ({ id, label: THEME_LABEL[id] })), prefs.theme, (id) => io.act.setPref({ theme: id })),
      section(APPEARANCE_TEXT),
      switchRow({
        label: APPEARANCE_FOLLOW_TEXT,
        checked: following,
        id: "sh-text-follow",
        onChange: (value) => io.act.setPref({ textSize: value ? null : TEXT_DEFAULT })
      }),
      following ? null : el(
        "div",
        { class: "sh-field" },
        slider,
        el("p", { class: "sh-sample", text: APPEARANCE_SAMPLE })
      ),
      section(APPEARANCE_STOP),
      radioGroup(APPEARANCE_STOP, [{ id: "right", label: APPEARANCE_STOP_RIGHT }, { id: "left", label: APPEARANCE_STOP_LEFT }], prefs.stopSide, (id) => io.act.setPref({ stopSide: id })),
      vm.haptics.visible ? switchRow({ label: APPEARANCE_HAPTICS, checked: prefs.haptics, id: "sh-haptics", onChange: (value) => io.act.setPref({ haptics: value }) }) : null,
      vm.haptics.visible ? null : para(APPEARANCE_HAPTICS_IOS, "sh-help"),
      para(fill(APPEARANCE_NOTE, ctx.computer), "sh-help")
    ]
  });
}
function dictationStatus(dictation) {
  if (!dictation?.known) return "Checking what this phone can do\u2026";
  if (!dictation.available) return "Dictation is not available on this phone.";
  const where = dictation.onDevice ? "on this phone" : "through the phone's speech service";
  const mic = dictation.permission === "denied" ? " The microphone is off for Plenum: allow it in the phone's Settings." : "";
  return `Dictation is available ${where}.${mic}`;
}
function settingsDictation(ctx, io) {
  const prefs = ctx.vm.prefs;
  const native = ctx.vm.native;
  return frame(ctx, io, {
    title: DICTATION_TITLE,
    back: true,
    body: native ? [
      el("p", { class: "sh-note", id: "sh-dict-status", role: "status", text: dictationStatus(ctx.vm.dictation) }),
      switchRow({ label: DICTATION_PREFER, checked: prefs.dictationOnDevice, id: "sh-dict-device", onChange: (value) => io.act.setPref({ dictationOnDevice: value }) }),
      switchRow({ label: DICTATION_ALLOW, checked: prefs.dictationAllowService, id: "sh-dict-service", note: DICTATION_ALLOW_TEXT, onChange: (value) => io.act.setPref({ dictationAllowService: value }) }),
      el("p", { class: "sh-msg sh-info", role: "note", text: PHONE_VOICE })
    ] : [para(DICTATION_WEB, "sh-note")]
  });
}
function debug(ctx, io) {
  const lines = ctx.vm.debug.lines;
  const rows = lines.map((line) => el(
    "li",
    { class: `sh-log sh-log-${line.level}` },
    el("span", { class: "sh-log-time", text: line.time }),
    el("span", { class: "sh-log-text", text: line.text })
  ));
  return frame(ctx, io, {
    title: DEBUG_TITLE,
    back: true,
    body: [
      para(DEBUG_LEAD, "sh-help"),
      lines.length ? el("ol", { class: "sh-logs", role: "log", "aria-label": DEBUG_TITLE, "aria-live": "off" }, rows) : para(DEBUG_EMPTY, "sh-note"),
      msgNode(io.local.debugNote ?? null)
    ],
    actions: [
      button(DEBUG_CLEAR, { kind: "ghost", onClick: () => {
        io.act.debugClear();
        io.local.debugNote = null;
      } }),
      button(DEBUG_COPY, { kind: "ghost", onClick: () => io.act.debugCopy(lines.map((l) => `${l.time} ${l.text}`).join("\n")) }),
      button(fill(DEBUG_SEND, ctx.computer), { kind: "primary", onClick: () => io.act.debugSend() })
    ]
  });
}
function about(ctx, io) {
  const a = ctx.vm.about;
  const lines = [
    fillMany(ABOUT_APP, { version: a.appVersion || "0.0.0" }),
    a.desktopVersion ? fillMany(ABOUT_COMPUTER, { computer: ctx.computer, version: a.desktopVersion }) : ABOUT_NOT_CONNECTED,
    fillMany(ABOUT_LINK, { version: a.protocol || "1.0" }),
    a.screensLoaded ? fillMany(ABOUT_SCREENS_LOADED, { computer: ctx.computer, n: a.screensLoaded }) : ABOUT_SCREENS_BUILT,
    a.since ? fillMany(ABOUT_CONNECTED, { carrier: a.carrierLabel ?? "this network", when: a.since }) : null,
    a.newerUi ? fill(ABOUT_NEWER_UI, ctx.computer) : null
  ];
  return frame(ctx, io, {
    title: ABOUT_TITLE,
    back: true,
    body: [el("ul", { class: "sh-about" }, lines.filter(Boolean).map((text) => el("li", { text })))]
  });
}
function legal(ctx, io) {
  const rows = Object.entries(LEGAL_ROWS).map(([name, label]) => row(label, null, () => io.act.openLegal(name)));
  return frame(ctx, io, {
    title: LEGAL_TITLE,
    back: true,
    body: [
      el("div", { class: "sh-rows" }, rows),
      msgNode(io.local.legalNote ?? null),
      ctx.vm.connected.id ? para(fill(LEGAL_VERSIONS, ctx.computer), "sh-help") : null
    ]
  });
}
function demoHome(ctx, io) {
  const d = ctx.vm.demo;
  const waiting = d.approvals.filter((a) => a.state === "waiting");
  const runRows = d.runs.map((r) => el(
    "li",
    { class: `sh-run sh-run-${r.state}` },
    el("span", { class: "sh-run-title", text: r.title }),
    el("span", { class: "sh-run-meta", text: `${r.project} \xB7 ${RUN_WORD[r.state] ?? r.state}${r.waitingFor === "approval" ? " \xB7 waiting for you" : ""}` })
  ));
  const cards = waiting.map((card) => el(
    "div",
    { class: "sh-card", role: "group", "aria-label": DEMO_APPROVAL },
    el("p", { class: "sh-status", text: DEMO_APPROVAL }),
    el("p", { class: "sh-code-line", text: card.firstLine }),
    el("p", { class: "sh-help", text: card.detail ?? "" }),
    el(
      "div",
      { class: "sh-card-actions" },
      button(DEMO_DENY, { kind: "ghost", onClick: () => io.act.demoDecide(card.id, "deny") }),
      button(DEMO_APPROVE, { kind: "primary", onClick: () => io.act.demoDecide(card.id, "approve") })
    )
  ));
  const agents = d.agents.map((a) => el("p", { class: "sh-help", text: `${a.name}: ${a.state}` }));
  return frame(ctx, io, {
    title: DEMO_TITLE,
    body: [
      section(DEMO_RUNS),
      el("ul", { class: "sh-runs" }, runRows),
      cards.length ? el("div", { class: "sh-cards" }, cards) : null,
      agents.length ? el("div", { class: "sh-agents" }, agents) : null,
      el(
        "div",
        { class: "sh-rows" },
        row(DEMO_RUN_LABEL, d.drive ? `${d.drive.app}, step ${d.drive.step} of ${d.drive.of}` : null, () => io.go("demo-run")),
        row(DEMO_DIFF_LABEL, d.diff ? `${d.diff.file} \xB7 +${d.diff.added} \u2212${d.diff.removed}` : null, () => io.go("demo-diff")),
        row(DEMO_ARTIFACT_LABEL, d.artifacts.length ? `${d.artifacts.length} picture${d.artifacts.length === 1 ? "" : "s"}` : null, () => io.go("demo-artifact")),
        row("Phone settings", null, () => io.go("settings"))
      ),
      button(DEMO_RESET, { kind: "link", onClick: () => io.act.demoReset() })
    ]
  });
}
var RUN_WORD = Object.freeze({ running: "Running", finished: "Finished", failed: "Failed", stopped: "Stopped" });
function demoRun(ctx, io) {
  const drive = ctx.vm.demo.drive;
  if (!drive) return frame(ctx, io, { title: DEMO_RUN_LABEL, back: true, body: [para(DEMO_EMPTY, "sh-note")] });
  const frames = (drive.frames ?? []).map((f, i) => el(
    "figure",
    { class: "sh-frame" },
    f.src ? el("img", { class: "sh-picture", src: f.src, alt: f.caption, width: "360", height: "220" }) : null,
    el("figcaption", { class: "sh-help", text: `${i + 1}. ${f.caption}` })
  ));
  const stateWord = drive.state === "driving" ? "A model is driving" : "Stopped";
  return frame(ctx, io, {
    title: DEMO_RUN_LABEL,
    back: true,
    body: [
      para(`${stateWord} ${ctx.computer}: ${drive.app}, step ${drive.step} of ${drive.of}.`, "sh-note"),
      el("div", { class: "sh-frames" }, frames)
    ]
  });
}
function demoDiff(ctx, io) {
  const diff = ctx.vm.demo.diff;
  if (!diff) return frame(ctx, io, { title: DEMO_DIFF_LABEL, back: true, body: [para(DEMO_EMPTY, "sh-note")] });
  const hunks = (diff.hunks ?? []).map((h) => el(
    "div",
    { class: "sh-hunk" },
    el("p", { class: "sh-hunk-head", text: h.header }),
    el("ol", { class: "sh-diff" }, (h.lines ?? []).map((line) => el(
      "li",
      { class: `sh-diff-${line.t === "+" ? "add" : line.t === "-" ? "del" : "ctx"}` },
      el("span", { class: "sh-diff-mark", "aria-hidden": "true", text: line.t === " " ? " " : line.t }),
      el("span", { text: line.s })
    )))
  ));
  return frame(ctx, io, {
    title: DEMO_DIFF_LABEL,
    back: true,
    body: [
      el("p", { class: "sh-note", text: `${diff.file} \xB7 +${diff.added} \u2212${diff.removed}` }),
      hunks
    ]
  });
}
function demoArtifact(ctx, io) {
  const list = ctx.vm.demo.artifacts;
  return frame(ctx, io, {
    title: DEMO_ARTIFACT_LABEL,
    back: true,
    body: list.length ? list.map((a) => el(
      "figure",
      { class: "sh-frame" },
      a.src ? el("img", { class: "sh-picture", src: a.src, alt: a.caption || a.name, width: "360", height: "160" }) : null,
      el("figcaption", { class: "sh-help", text: `${a.name}. ${a.caption}` })
    )) : [para(DEMO_EMPTY, "sh-note")],
    lead: null
  });
}
var PART2_BUILDERS = Object.freeze({
  "pair-review": pairReview,
  computers,
  "install-ios": installIos,
  "install-android": installAndroid,
  "lan-web": lanWeb,
  connected,
  rename,
  forget,
  settings,
  "settings-connection": settingsConnection,
  "settings-notify": settingsNotify,
  "settings-lock": settingsLock,
  "phone-lock-off": phoneLockOff,
  "settings-appearance": settingsAppearance,
  "settings-dictation": settingsDictation,
  debug,
  about,
  legal,
  "demo-home": demoHome,
  "demo-run": demoRun,
  "demo-diff": demoDiff,
  "demo-artifact": demoArtifact,
  "pin-set": pinSet
});
var PART2_SCREEN_BUILDERS = PART2_BUILDERS;
function renderPart2(id, ctx, io) {
  const build = PART2_BUILDERS[id];
  if (!build) return null;
  return build({ ...ctx, id }, io);
}

// mobile/shell/screens/main.js
var LOCK_IDS = Object.freeze(["lock-bio", "lock-pin"]);
var NOT_A_FAILED_CHECK = Object.freeze(["cancelled", "mode", "unavailable"]);
var NAV_IDS = Object.freeze([...PART2_IDS, "pin-set"]);
var SCAN_FAILED = "The camera could not read a code. Hold it steady, or paste the link instead.";
var DEV_BUILD = true ? false : true;
function screensDebugOn(params, devBuild = DEV_BUILD) {
  return devBuild === true && (params.get("demo") === "1" || params.get("debug") === "1");
}
async function scanWithBrowser(env, getVideo, register, { interval = 250 } = {}) {
  const videoNow = () => typeof getVideo === "function" ? getVideo() : getVideo;
  const Detector = env.BarcodeDetector;
  const media = env.navigator?.mediaDevices;
  if (typeof Detector !== "function" || typeof media?.getUserMedia !== "function") return { ok: false, reason: "unavailable" };
  let stream = null;
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    for (const track of stream?.getTracks?.() ?? []) track.stop?.();
    stream = null;
    const shown2 = videoNow();
    if (shown2) shown2.srcObject = null;
  };
  register(stop);
  try {
    stream = await media.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch (err) {
    stop();
    return { ok: false, reason: /NotAllowed|Permission|Security/i.test(String(err?.name ?? err)) ? "denied" : "failed" };
  }
  if (stopped) {
    stop();
    return { ok: false, reason: "cancelled" };
  }
  const shown = videoNow();
  if (shown) {
    shown.srcObject = stream;
    shown.play?.().catch?.(() => {
    });
  }
  let detector;
  try {
    detector = new Detector({ formats: ["qr_code"] });
  } catch {
    stop();
    return { ok: false, reason: "unavailable" };
  }
  return new Promise((resolve) => {
    const look = async () => {
      if (stopped) {
        resolve({ ok: false, reason: "cancelled" });
        return;
      }
      try {
        const found = await detector.detect(videoNow());
        const text = found?.find?.((c) => typeof c?.rawValue === "string" && c.rawValue)?.rawValue;
        if (text) {
          stop();
          resolve({ ok: true, text });
          return;
        }
      } catch {
      }
      timer = env.setTimeout(look, interval);
    };
    look();
  });
}
function setHidden(node, flag) {
  if (flag) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}
function applyTheme(doc2, theme) {
  const root = doc2.documentElement;
  if (theme === "dark" || theme === "light") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
}
function signatureOf(ctx) {
  const { countdown, stripInfo, stopState, stopText, carrierLabel, ...rest } = ctx;
  return JSON.stringify(LOCK_IDS.includes(ctx.id) ? { ...rest, stopText } : rest);
}
function lockMessage(method, result) {
  if (method === "pin" || result?.ok === true) return null;
  return NOT_A_FAILED_CHECK.includes(result?.reason) ? null : LOCK_FAILED;
}
function hhmmss(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
var MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
function seenText(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockTime(ms)}`;
}
function installHint(env = globalThis) {
  if (platformOf(env) !== "web" || lanPage(env)) return null;
  if (String(env.location?.protocol ?? "") !== "https:") return null;
  const standalone = env.matchMedia?.("(display-mode: standalone)")?.matches === true || env.navigator?.standalone === true;
  if (standalone) return null;
  const ua = String(env.navigator?.userAgent ?? "");
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  return null;
}
function buildVm(s, nav, env, core = null) {
  const platform = platformOf(env);
  const native = platform !== "web";
  const ua = String(env.navigator?.userAgent ?? "");
  const iosWeb = !native && /iPhone|iPad|iPod/.test(ua);
  const prefs = s?.prefs ?? normalisePrefs(null);
  const hello = s?.hello ?? null;
  const conn = s?.connection ?? {};
  const lockMode = s?.lock?.mode ?? "off";
  const push = pushValues(s?.pushKnown ?? null);
  const approveRule = approveSwitch({ tier: hello?.tier ?? "full", firstLine: push.firstLine, lockMode, native });
  const approve = { ...approveRule, checked: approveChecked(s?.approveStored, approveRule) };
  const computers2 = (s?.computers ?? []).map((c) => {
    const active = c.id === s.activeId;
    const connected2 = active && conn.status === "connected" && Boolean(hello);
    return {
      id: c.id,
      name: String(c.name ?? ""),
      active,
      connected: connected2,
      status: active ? conn.status ?? null : null,
      lastSeen: c.lastSeen ?? null,
      dateText: c.lastSeen ? seenText(c.lastSeen) : null,
      carrierLabel: active ? CARRIER_LABEL[conn.carrier] ?? null : null,
      lastCarrierLabel: CARRIER_LABEL[c.lastCarrier] ?? null,
      version: active ? hello?.desktopVersion || null : null,
      carrierOrder: (Array.isArray(c.carriers) ? c.carriers : []).map((x) => x.kind),
      ways: (Array.isArray(c.carriers) ? c.carriers : []).map((x) => x.kind),
      waysDetail: null
    };
  });
  const since = conn.since ? clockTime(conn.since) : null;
  const connectedCarrier = CARRIER_LABEL[conn.carrier] ?? null;
  const perm = core?.notificationPermission?.() ?? "unknown";
  const lockLabel = lockMode === "biometric" ? biometricName(platform) : lockMode === "pin" ? "PIN" : lockMode === "passkey" ? "passkey" : "Off";
  const debugLines = core?.debug?.lines?.() ?? [];
  const demo = s?.demo ?? { computer: { name: "Demo computer" }, projects: [], runs: [], approvals: [], agents: [], drive: null, diff: null, artifacts: [] };
  return {
    native,
    platform,
    computers: computers2,
    connected: { id: s?.activeId ?? null, since, carrierLabel: connectedCarrier },
    about: {
      appVersion: s?.device?.appVersion ?? "",
      protocol: s?.device?.protocol ?? "1.0",
      desktopVersion: hello?.desktopVersion || null,
      since,
      carrierLabel: connectedCarrier,
      screensLoaded: null,
      newerUi: false
    },
    notify: { label: NOTIFY_PERMISSION[perm] ?? NOTIFY_PERMISSION.unknown, hint: perm === "denied" ? NOTIFY_DENIED_HINT : null },
    lock: { mode: lockMode, label: lockLabel, failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0, prefs: null },
    prefs,
    push,
    approve,
    haptics: { visible: !iosWeb },
    unifiedPush: platform === "android" ? { supported: s?.androidPush?.supported === true, distributor: s?.androidPush?.distributor ?? null, registered: s?.androidPush?.registered === true, failure: s?.androidPush?.failure ?? null } : null,
    dictation: native ? { available: s?.dictation?.available === true, onDevice: s?.dictation?.onDevice === true, permission: s?.dictation?.permission ?? "prompt", known: Boolean(s?.dictation) } : null,
    debug: { lines: debugLines.slice(-500).map((l) => ({ level: l.level ?? "info", time: hhmmss(l.at), text: String(l.text ?? "") })) },
    demo,
    replay: Boolean(s?.demo)
  };
}
function mountScreens(env = globalThis) {
  const doc2 = env.document;
  if (!doc2?.body) return null;
  setDocument(doc2);
  const params = new URLSearchParams(env.location?.search ?? "");
  const demoParam = params.get("demo") === "1";
  const screenParam = params.get("screen");
  const fixtureMode = DEV_BUILD && demoParam && SCREEN_IDS.includes(screenParam);
  const replayMode = demoParam && !fixtureMode;
  const debug2 = screensDebugOn(params, DEV_BUILD);
  applyTheme(doc2, params.get("theme"));
  doc2.documentElement.setAttribute("data-shell-page", "");
  const nav = {
    screen: null,
    forced: null,
    pairingCancelled: false,
    dismissedKey: null,
    lastDriving: null,
    onboarding: null,
    codeSince: null,
    codeExpired: false,
    uiState: null,
    consentGiven: false,
    progress: null,
    uiCause: "checksum",
    hasCopy: false,
    local: {},
    stack: []
  };
  if (replayMode && NAV_IDS.includes(screenParam)) nav.screen = screenParam;
  let demoId = fixtureMode ? screenParam ?? "welcome" : null;
  let demoOverrides = {};
  let clockOffset = 0;
  let core = null;
  let coreKnown = false;
  let snapshot = null;
  let lastId = null;
  let lastSig = "";
  let unsubscribe = null;
  let deferredInstall = null;
  let scanning = false;
  let scanStop = null;
  const stopScan = () => {
    scanning = false;
    const stop2 = scanStop;
    scanStop = null;
    stop2?.();
  };
  const timers = /* @__PURE__ */ new Set();
  const now = () => Date.now() + clockOffset;
  const later = (fn, ms) => {
    const t = env.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const stateKeyNow = () => stateKey(snapshot);
  const host = doc2.getElementById("sh-app") ?? doc2.body.appendChild(el("div", { id: "sh-app" }));
  const demoStrip = el(
    "div",
    { id: "plenum-demo-strip", class: "plenum-demo-strip", role: "status", hidden: true },
    el("span", { class: "plenum-demo-text", text: DEMO_STRIP }),
    el("button", { type: "button", class: "sh-link plenum-demo-exit", on: { click: () => actions.exitDemo() } }, DEMO_EXIT)
  );
  const lanStrip = el(
    "div",
    { id: "plenum-lan-strip", class: "plenum-lan-strip", role: "status", hidden: true },
    el("span", { class: "plenum-lan-text" }),
    el("button", { type: "button", class: "sh-link plenum-lan-got", on: { click: () => actions.dismissLan() } }, "Got it")
  );
  const strip = el(
    "div",
    { id: "plenum-conn-strip", class: "plenum-conn-strip", role: "status", hidden: true },
    el("span", { class: "plenum-conn-text" })
  );
  const view = el("div", { id: "sh-view", class: "sh-view" });
  const stripStack = el("div", { id: "plenum-strips", class: "plenum-strips", hidden: true }, demoStrip, lanStrip, strip);
  host.replaceChildren(stripStack, view);
  const stop = el(
    "button",
    {
      id: "plenum-stop",
      class: "plenum-stop",
      type: "button",
      "aria-label": "Stop everything on your computer",
      hidden: true,
      on: { click: () => {
        actions.stop();
      } }
    },
    el("span", { class: "plenum-stop-mark", "aria-hidden": "true" }),
    el("span", { class: "plenum-stop-label", text: "Stop" }),
    el("span", { class: "plenum-stop-note", role: "status" })
  );
  doc2.body.appendChild(stop);
  const toast = el(
    "div",
    { id: "plenum-toast", class: "plenum-toast", role: "status", hidden: true },
    el("span", { class: "plenum-toast-text" }),
    el("button", { type: "button", class: "sh-link plenum-toast-close", on: { click: () => actions.dismissToast() } }, "Close")
  );
  const sheet = el(
    "div",
    {
      id: "plenum-stop-sheet",
      class: "plenum-stop-sheet",
      role: "alertdialog",
      "aria-labelledby": "plenum-stop-sheet-title",
      "aria-describedby": "plenum-stop-sheet-body",
      hidden: true
    },
    el("h2", { id: "plenum-stop-sheet-title", class: "plenum-stop-sheet-title", text: STOP_FAILURE_TEXT.title }),
    el("p", { id: "plenum-stop-sheet-body", class: "plenum-stop-sheet-body", text: STOP_FAILURE_TEXT.body }),
    el(
      "div",
      { class: "plenum-stop-sheet-actions" },
      el("button", { type: "button", class: "sh-btn sh-btn-primary plenum-stop-sheet-retry", on: { click: () => actions.retryStop() } }, "Try again"),
      el("button", { type: "button", class: "sh-link plenum-stop-sheet-close", on: { click: () => actions.dismissStopSheet() } }, "Close")
    )
  );
  doc2.body.append(toast, sheet);
  const TOAST_MS = 6e3;
  function updateNotices() {
    if (fixtureMode) {
      setHidden(toast, true);
      setHidden(sheet, true);
      return;
    }
    const note = snapshot?.notice ?? null;
    if (note && note.seq !== nav.local.noticeSeq) {
      nav.local.noticeSeq = note.seq;
      nav.local.noticeAt = now();
    }
    const stopState = snapshot?.stop?.state ?? "idle";
    const open = Boolean(note) && nav.local.noticeClosed !== note.seq;
    const fresh = open && now() - (nav.local.noticeAt ?? 0) < TOAST_MS;
    const waiting = open && note.tone === "warn" && stopState === "queued";
    const showToast = fresh || waiting;
    setHidden(toast, !showToast);
    if (showToast) {
      toast.querySelector(".plenum-toast-text").textContent = note.text;
      toast.setAttribute("data-tone", note.tone ?? "info");
    }
    const st = snapshot?.stop ?? null;
    setHidden(sheet, !(st?.state === "failed" && nav.local.sheetClosed !== st.seq));
  }
  function focusTitle() {
    const title = doc2.getElementById("sh-title");
    if (title) title.focus({ preventScroll: true });
  }
  function showStartFailed() {
    if (lastId === "start-failed") return;
    view.replaceChildren(el(
      "div",
      { class: "sh-screen sh-center", "data-screen": "start-failed" },
      el("main", { class: "sh-main", id: "sh-main" }, el("p", { class: "sh-note", text: START_FAILED }))
    ));
    doc2.body.setAttribute("data-screen", "start-failed");
    lastId = "start-failed";
    lastSig = "";
  }
  function fallbackId(s) {
    if (nav.screen === "computers") return "computers";
    if (replayMode) return "demo-home";
    if (s.activeId && s.connection?.status === "connected" && s.hello) return "connected";
    if (s.computers?.length) return "computers";
    return null;
  }
  function applyPrefs(s) {
    if (fixtureMode || !s?.prefs) return;
    const p = s.prefs;
    if (!params.get("theme")) {
      if (p.theme === "dark" || p.theme === "light") applyTheme(doc2, p.theme);
      else applyTheme(doc2, null);
    }
    doc2.documentElement.setAttribute("data-stop-side", p.stopSide === "left" ? "left" : "right");
    const scale = p.textSize == null ? 1 : p.textSize / 100;
    doc2.documentElement.style?.setProperty?.("--text-scale", String(scale));
  }
  function paint() {
    if (!fixtureMode) {
      snapshot = core ? core.state() : null;
      if (coreKnown && !core) {
        showStartFailed();
        return;
      }
    }
    if (!fixtureMode && snapshot) {
      if (snapshot.paired && snapshot.paired.seq > (nav.pairedSeq ?? 0)) {
        nav.pairedSeq = snapshot.paired.seq;
        nav.onboarding = lanPage(env) ? ["paired-lock"] : ["paired-lock", "paired-notify"];
      }
      if (snapshot.hello) nav.lastDriving = snapshot.hello.pending?.driving ?? null;
      if (snapshot.hello && snapshot.activeId) nav.wasConnected = snapshot.activeId;
      if (!snapshot.activeId) nav.lastDriving = null;
      if (nav.pairingCancelled && snapshot.pairing?.state !== "confirm") nav.pairingCancelled = false;
      const request = snapshot.screenRequest ?? null;
      if (!snapshot.locked && request?.seq > (nav.screenSeq ?? 0)) {
        nav.screenSeq = request.seq;
        nav.stack = [];
        nav.screen = request.screen;
        nav.dismissedKey = null;
      }
      applyPrefs(snapshot);
    }
    const showingCode = fixtureMode ? demoId === "code" : snapshot?.pairing?.state === "confirm" && !nav.pairingCancelled;
    if (showingCode) {
      if (nav.codeSince == null) nav.codeSince = now();
      if (codeSecondsLeft(nav.codeSince, now()) === 0) nav.codeExpired = true;
    } else {
      nav.codeSince = null;
      nav.codeExpired = false;
      if (!fixtureMode) nav.forced = null;
    }
    let id;
    if (fixtureMode) {
      id = demoId;
      if (id === "code" && nav.codeExpired) id = "expired";
    } else if (snapshot?.locked || !snapshot) {
      id = screenFor(snapshot, nav);
    } else if (nav.screen === "pin-set") {
      id = "pin-set";
    } else {
      id = screenFor(snapshot, nav) ?? fallbackId(snapshot);
    }
    const ctx = fixtureMode ? fixtureCtx(id, demoOverrides) : ctxFor(snapshot, nav, env);
    if (!ctx) return;
    const isPart2 = PART2_SCREEN_BUILDERS[id] !== void 0;
    if (isPart2 && !snapshot) return;
    ctx.id = id;
    if (id !== "scan" && scanning) stopScan();
    if (!fixtureMode) ctx.cameraDenied = Boolean(nav.local.cameraDenied);
    ctx.countdown = showingCode ? codeSecondsLeft(nav.codeSince, now()) : null;
    if (id === "failed") ctx.stripInfo = null;
    ctx.bioMessage = nav.local.bioMessage ?? null;
    ctx.linkMessage = nav.local.linkMessage ?? null;
    ctx.onboardMessage = nav.local.onboardMessage ?? null;
    ctx.notifyNote = nav.local.notifyNote ?? null;
    ctx.install = fixtureMode ? null : installHint(env);
    ctx.vm = fixtureMode ? null : buildVm(snapshot, nav, env, core);
    updateChrome(ctx, id);
    if (!id) {
      view.replaceChildren();
      lastId = null;
      lastSig = "";
      doc2.body.removeAttribute("data-screen");
      return;
    }
    const sig = `${id}|${signatureOf(ctx)}`;
    if (sig === lastSig && id === lastId) {
      const cd = view.querySelector("[data-countdown]");
      if (cd && ctx.countdown != null) cd.textContent = clock(ctx.countdown);
      return;
    }
    for (const t of timers) env.clearTimeout(t);
    timers.clear();
    const node = isPart2 ? renderPart2(id, { ...ctx, id }, io) : renderScreen(id, { ...ctx, id }, io);
    if (node) view.replaceChildren(node);
    if (id !== lastId) focusTitle();
    lastId = id;
    lastSig = sig;
    doc2.body.setAttribute("data-screen", id);
  }
  function updateChrome(ctx, id) {
    const locked = fixtureMode ? LOCK_IDS.includes(id) : Boolean(snapshot?.locked);
    const session = fixtureMode ? Boolean(ctx.session) : Boolean(snapshot?.activeId);
    const showStop = session && !locked;
    setHidden(stop, !showStop);
    const computer = ctx.computer || "your computer";
    stop.setAttribute("aria-label", `Stop everything on ${computer}`);
    const state = fixtureMode ? ctx.stopState : snapshot?.stop?.state ?? "idle";
    stop.setAttribute("data-state", state);
    if (state === "sending") stop.setAttribute("aria-busy", "true");
    else stop.removeAttribute("aria-busy");
    const driving = ctx.driving ?? drivingText(snapshot?.hello?.pending?.driving);
    if (driving) {
      stop.setAttribute("data-driving", "");
      stop.setAttribute("aria-description", `A model is driving: ${driving}`);
    } else {
      stop.removeAttribute("data-driving");
      stop.removeAttribute("aria-description");
    }
    if (ctx.pending?.runs > 0 || driving || state === "sending") stop.setAttribute("data-active", "");
    else stop.removeAttribute("data-active");
    stop.querySelector(".plenum-stop-label").textContent = STOP_LABEL[state] ?? "Stop";
    stop.querySelector(".plenum-stop-note").textContent = (fixtureMode ? ctx.stopText : snapshot?.stop?.text) || "";
    updateNotices();
    setHidden(demoStrip, !replayMode);
    const lanOn = !fixtureMode && Boolean(ctx.lan) && !(snapshot?.prefs?.lanDismissed === true);
    setHidden(lanStrip, !lanOn);
    if (lanOn) lanStrip.querySelector(".plenum-lan-text").textContent = fill2(LAN_WEB_STRIP, computer);
    const info = ctx.stripInfo ?? null;
    setHidden(strip, !info);
    if (info) {
      strip.querySelector(".plenum-conn-text").textContent = info.text;
      if (info.tone === "warn" || info.tone === "bad") strip.setAttribute("data-tone", info.tone);
      else strip.removeAttribute("data-tone");
    }
    const stacked = replayMode || lanOn || Boolean(info);
    setHidden(stripStack, !stacked);
    if (stacked) host.setAttribute("data-strips", "");
    else host.removeAttribute("data-strips");
  }
  const fill2 = (text, computer) => fillName(text, computer);
  function openFromScreen(result, failText) {
    nav.local.linkMessage = result.ok ? null : failText;
    paint();
    return result;
  }
  function coreCall(name, ...args) {
    return call(core, name, ...args);
  }
  const actions = {
    stop: () => {
      if (!fixtureMode) core?.stop?.();
    },
    // The sheet's Try again sends the Stop again; the sheet closes when the next result comes.
    retryStop: () => {
      if (!fixtureMode) core?.stop?.();
    },
    dismissStopSheet: () => {
      if (snapshot?.stop) nav.local.sheetClosed = snapshot.stop.seq;
      paint();
    },
    dismissToast: () => {
      if (snapshot?.notice) nav.local.noticeClosed = snapshot.notice.seq;
      paint();
    },
    // Locks the app now (Settings and the lock screen use it): the channel closes and the keys leave memory, as the core does.
    lockNow: async () => {
      if (fixtureMode || !core?.lockNow) return { ok: false, reason: "unavailable" };
      const out = await core.lockNow();
      paint();
      return { ok: out?.ok === true, reason: out?.reason ?? null };
    },
    tryDemo: () => {
      env.location?.assign?.(`${env.location.pathname}?demo=1`);
    },
    exitDemo: () => {
      env.location?.assign?.(String(env.location?.pathname ?? "/"));
    },
    consent: (value) => {
      nav.consentGiven = Boolean(value);
    },
    pair: async (text) => {
      if (fixtureMode) return null;
      if (replayMode) {
        nav.local.linkMessage = DEMO_NO_PAIR;
        paint();
        return null;
      }
      nav.screen = null;
      nav.pairingCancelled = false;
      nav.dismissedKey = null;
      const name = cleanPhoneName(nav.local.phoneName, defaultPhoneName(platformOf(env)));
      const final = await core?.pair?.(String(text ?? ""), { name });
      if (final?.state === "allowed") {
        nav.onboarding = lanPage(env) ? ["paired-lock"] : ["paired-lock", "paired-notify"];
      }
      paint();
      return final;
    },
    readClipboard: (setter) => {
      const clipboard = env.navigator?.clipboard;
      if (!clipboard?.readText) return;
      clipboard.readText().then((text) => setter(String(text ?? "")), () => {
      });
    },
    // Phone settings that are not in the web shell's own reach show the manual path.
    openSettings: (section2) => {
      const result = openSettingsFlow(section2);
      return openFromScreen(result, SETTINGS_MANUAL);
    },
    openLegal: (name) => openFromScreen(openLinkFlow(env, LEGAL_LINKS[name] ?? null), LINK_UNAVAILABLE),
    openStore: () => openFromScreen(openLinkFlow(env, STORE_LINKS[platformOf(env)] ?? null), LINK_UNAVAILABLE),
    chooseComputer: () => {
      io.go("computers");
    },
    cancelConnect: async () => {
      await coreCall("cancelConnect");
      nav.screen = null;
      nav.stack = [];
      nav.dismissedKey = stateKeyNow();
      io.go("welcome");
    },
    continueLocalNet: () => {
    },
    retry: () => {
      if (replayMode || !core) return;
      const s = core.state();
      if (s.ui?.state === "failed" && s.hello) {
        core.showUi?.({ force: true });
        return;
      }
      const id = s.activeId ?? s.computers[0]?.id;
      if (id) core.connect(id);
    },
    // "Open Plenum" on the shell's own page (/?shell): the computer's UI is pulled and the page goes to it.
    openUi: () => {
      if (!fixtureMode && !replayMode) core?.showUi?.({ force: true });
    },
    // "The codes do not match": the pairing is cancelled (a CLOSE goes to the computer), and the screen says it stopped.
    mismatch: async () => {
      if (fixtureMode) {
        io.go("mismatch");
        return;
      }
      nav.pairingCancelled = true;
      nav.screen = "mismatch";
      nav.dismissedKey = null;
      paint();
      await coreCall("cancelPairing");
      paint();
    },
    enableLock: async (mode) => fixtureMode ? { ok: true, reason: null } : enableLockFlow(core, mode),
    enableNotifications: async () => fixtureMode ? { ok: true, reason: null } : enableNotificationsFlow(core),
    unlock: async (method, arg = null) => {
      if (fixtureMode || !core) return { ok: false, reason: "demo" };
      const result = await unlockFlow(core, method, arg);
      if (method !== "pin") {
        nav.local.bioMessage = lockMessage(method, result);
        paint();
      }
      return result;
    },
    // Unlocks with the method the lock uses, then stops everything (the stop is sent only after the unlock worked).
    unlockAndStop: async (method = "biometric") => {
      if (fixtureMode || !core) return;
      const result = await unlockAndStopFlow(core, method);
      nav.local.bioMessage = lockMessage(method, result);
      paint();
    },
    // The pairing link that waits for review (D5): Pair starts it, Cancel drops it (C6c).
    confirmPair: async () => {
      await call(core, "confirmPair");
      paint();
    },
    cancelPair: async () => {
      await call(core, "cancelPairing");
      paint();
    },
    // Stop from a lock screen: sent without unlocking when this phone holds the computer's Stop key (C6c, C6f).
    stopLocked: async () => {
      await call(core, "stop");
      paint();
    },
    forgetActive: async () => {
      if (fixtureMode || !core) return;
      const id = core.state().activeId;
      if (id) await forgetFlow(core, id);
      paint();
    },
    sendLog: () => {
      if (fixtureMode || !core?.channel) return;
      core.debug?.sendToComputer?.(core.channel.request, 60);
    },
    // "Use the copy in this app" on the failed-screens screen: the UI that is already on the phone.
    useCopy: () => {
      if (!fixtureMode && !replayMode) core?.useCopy?.();
    },
    // ---- scanning (M7) ----
    // The pairing code is scanned with the phone's camera: the native apps use the scanner plugin (its own full-screen camera); the web
    // page uses the browser's BarcodeDetector over getUserMedia where both exist, and otherwise sends the person to the paste screen.
    // A denied camera is the scan-denied screen. Whatever is read goes to pair(), as a pasted link does.
    startScan: async (videoArg) => {
      if (fixtureMode || replayMode || scanning) return;
      scanning = true;
      nav.local.cameraDenied = false;
      nav.local.scanNote = null;
      const done = async (result) => {
        scanning = false;
        stopScan();
        if (result.ok) {
          await actions.pair(result.text);
          return;
        }
        if (result.reason === "denied") nav.local.cameraDenied = true;
        else if (result.reason === "cancelled") {
          nav.screen = nav.stack.length ? nav.stack.pop() : null;
          nav.dismissedKey = null;
        } else if (result.reason === "unavailable") {
          nav.screen = "paste";
          nav.local.linkMessage = null;
        } else nav.local.scanNote = SCAN_FAILED;
        paint();
      };
      if (platformOf(env) !== "web") {
        done(await (core?.scan?.() ?? { ok: false, reason: "unavailable" }));
        return;
      }
      done(await scanWithBrowser(env, () => view.querySelector(".sh-video") ?? videoArg, (stop2) => {
        scanStop = stop2;
      }));
    },
    // ---- wave 107: computers, phone settings and the demo ----
    connect: async (id) => {
      if (replayMode) {
        io.go(null);
        return { ok: true, reason: null };
      }
      const result = await coreCall("connect", id);
      if (result.ok) {
        nav.screen = null;
        nav.stack = [];
      }
      paint();
      return result;
    },
    rename: async (id, name) => replayMode ? { ok: false, reason: "demo" } : coreCall("rename", id, name),
    forget: async (id) => replayMode ? { ok: false, reason: "demo" } : forgetFlow(core, id),
    moveWay: async (id, kind, dir) => replayMode ? { ok: false, reason: "demo" } : coreCall("moveWay", id, kind, dir),
    testWays: async (id) => replayMode ? { ok: false, reason: "demo" } : coreCall("testWays", id),
    setPush: async (key, value) => {
      const patch = pushPatch(key, value, snapshot?.approveStored === true);
      return coreCall("setPush", patch);
    },
    setApprove: async (value) => coreCall("setApprove", value === true),
    testPush: async () => coreCall("testPush"),
    // Android: the system chooser for the push app UnifiedPush goes through (the settings line shows which one is chosen).
    chooseDistributor: async () => {
      const out = await coreCall("chooseDistributor");
      nav.local.notifyNote = out.ok ? null : unifiedPushLine(null);
      paint();
      return out;
    },
    lockOn: async (mode) => fixtureMode ? { ok: true, reason: null } : enableLockFlow(core, mode),
    lockOff: async (pin) => coreCall("lockOff", pin),
    setPin: async (pin) => coreCall("setPin", pin),
    afterPin: () => {
      nav.screen = nav.stack.length ? nav.stack.pop() : null;
      if (nav.onboarding?.length) io.advance();
      else paint();
    },
    setPref: async (patch) => {
      if (fixtureMode) return { ok: true, reason: null };
      return coreCall("setPrefs", patch);
    },
    installApp: async () => {
      if (!deferredInstall) {
        nav.local.installNote = INSTALL_NO_PROMPT;
        paint();
        return { ok: false, reason: "unavailable" };
      }
      try {
        deferredInstall.prompt();
        const choice = await deferredInstall.userChoice;
        deferredInstall = null;
        nav.local.installNote = choice?.outcome === "accepted" ? null : null;
        paint();
        return { ok: choice?.outcome === "accepted", reason: choice?.outcome ?? null };
      } catch {
        nav.local.installNote = INSTALL_NO_PROMPT;
        paint();
        return { ok: false, reason: "failed" };
      }
    },
    dismissLan: () => {
      if (fixtureMode) return;
      coreCall("setPrefs", { lanDismissed: true });
    },
    debugCopy: async (text) => {
      const clipboard = env.navigator?.clipboard;
      if (!clipboard?.writeText) {
        nav.local.debugNote = DEBUG_NO_CLIPBOARD;
      } else {
        try {
          await clipboard.writeText(String(text ?? ""));
          nav.local.debugNote = DEBUG_COPIED;
        } catch {
          nav.local.debugNote = DEBUG_NO_CLIPBOARD;
        }
      }
      paint();
    },
    debugSend: async () => {
      const result = fixtureMode || !core ? { ok: false, n: 0 } : await coreCall("debugSend");
      const computer = snapshot?.hello?.desktopName || snapshot?.computers?.find((c) => c.id === snapshot?.activeId)?.name || "your computer";
      nav.local.debugNote = result.ok ? fillMany(DEBUG_SENT, { n: result.n ?? 0, computer }) : fillName(DEBUG_SEND_FAILED, computer);
      paint();
      return result;
    },
    debugClear: () => {
      if (!fixtureMode) coreCall("debugClear");
    },
    demoDecide: async (id, decision) => replayMode ? coreCall("demoDecide", id, decision) : { ok: false, reason: "demo" },
    demoReset: () => {
      if (replayMode) coreCall("demoReset");
    }
  };
  const io = {
    local: nav.local,
    act: actions,
    later,
    go: (id) => {
      if (fixtureMode) {
        demoOverrides = {};
        nav.codeSince = null;
        nav.codeExpired = false;
        demoId = id;
      } else {
        nav.stack.push(nav.screen);
        nav.screen = id;
        nav.forced = null;
        nav.dismissedKey = stateKeyNow();
        nav.local.linkMessage = null;
        nav.local.onboardMessage = null;
      }
      paint();
    },
    back: () => {
      if (fixtureMode) {
        demoId = "welcome";
      } else {
        nav.screen = nav.stack.length ? nav.stack.pop() : null;
        nav.dismissedKey = null;
        nav.local.linkMessage = null;
      }
      paint();
    },
    advance: () => {
      if (nav.onboarding) nav.onboarding.shift();
      if (!nav.onboarding?.length) {
        nav.onboarding = null;
        core?.releaseUi?.();
      }
      nav.local.onboardMessage = null;
      paint();
    },
    repaint: () => paint()
  };
  const take = typeof env.__plenumTakeShellCore === "function" ? env.__plenumTakeShellCore : null;
  const handed = take ? take.call(env) : null;
  if (!fixtureMode && handed && typeof handed.then === "function") {
    handed.then(
      (answer) => {
        core = answer ?? null;
        coreKnown = true;
        if (core) unsubscribe = core.subscribe(() => paint());
        paint();
      },
      () => {
        core = null;
        coreKnown = true;
        paint();
      }
    );
  }
  env.addEventListener?.("plenum-back", (event) => {
    if (fixtureMode) return;
    if (nav.stack.length || nav.screen) {
      event.preventDefault?.();
      io.back();
    }
  });
  env.addEventListener?.("beforeinstallprompt", (event) => {
    event.preventDefault?.();
    deferredInstall = event;
    paint();
  });
  doc2.addEventListener?.("visibilitychange", () => {
    const cover = snapshot?.prefs?.hideSwitcher === true && doc2.visibilityState === "hidden";
    if (cover) doc2.documentElement.setAttribute("data-app-hidden", "");
    else doc2.documentElement.removeAttribute("data-app-hidden");
  });
  env.setInterval(() => {
    paint();
  }, 1e3);
  env.addEventListener?.("online", () => paint());
  env.addEventListener?.("offline", () => paint());
  paint();
  if (debug2) {
    env.plenumScreensDebug = Object.freeze({
      ids: [...SCREEN_IDS, ...NAV_IDS],
      go(id, patch = {}) {
        if (!SCREEN_IDS.includes(id) && !NAV_IDS.includes(id)) return false;
        io.go(id);
        demoOverrides = { ...patch };
        paint();
        return lastId;
      },
      setFixture(patch = {}) {
        demoOverrides = { ...demoOverrides, ...patch };
        paint();
        return lastId;
      },
      advance(ms) {
        clockOffset += Number(ms) || 0;
        paint();
        return lastId;
      },
      current: () => lastId
    });
  }
  return { paint, io, actions, nav, unsubscribe: () => unsubscribe?.() };
}
if (typeof document !== "undefined" && typeof window !== "undefined" && !globalThis.__PLENUM_SCREENS_NO_AUTOSTART__) {
  try {
    mountScreens(globalThis);
  } catch (err) {
    console.error(String(err?.message ?? err));
  }
}
export {
  buildVm,
  installHint,
  mountScreens,
  scanWithBrowser,
  screensDebugOn
};
