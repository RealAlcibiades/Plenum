// mobile/shell/screens/dom.js
var doc = globalThis.document ?? null;
function setDocument(d) {
  doc = d;
}
function el(tag, props = {}, ...children) {
  let node = doc.createElement(tag);
  for (let [key, value] of Object.entries(props ?? {}))
    if (!(value == null || value === !1))
      if (key === "on")
        for (let [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
      else key === "text" ? node.textContent = String(value) : key === "class" ? node.className = String(value) : value === !0 ? node.setAttribute(key, "") : node.setAttribute(key, String(value));
  for (let child of children.flat())
    child == null || child === !1 || node.append(child instanceof Node ? child : doc.createTextNode(String(child)));
  return node;
}
function button(label, { kind = "ghost", onClick = null, disabled = !1, id = null, name = null } = {}) {
  let cls = kind === "link" ? "sh-link" : `sh-btn sh-btn-${kind}${disabled ? " sh-btn-off" : ""}`;
  return el("button", {
    type: "button",
    class: cls,
    id,
    "aria-label": name,
    "aria-disabled": disabled ? "true" : null,
    on: { click: (event) => {
      !disabled && onClick && onClick(event);
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
]), FORWARDER_BUILD = typeof __PLENUM_FORWARDER__ < "u" && __PLENUM_FORWARDER__ === !0, CONSENT_TEXT = "Messages you send from this app go to your computer. Plenum on your computer sends them, with files from your projects, to the AI providers you set up there, which may include Anthropic, OpenAI, Google, Meta (Muse Code), xAI, DeepSeek, Mistral AI and OpenRouter. Each provider handles them under its own privacy policy. Plenum's developer receives nothing.", FORWARDER_SENTENCE = "Only notifications pass through a small forwarder we run; everything else goes to your computer alone.", HOW_STEPS = Object.freeze([
  "On your computer, open Plenum.",
  "Go to Settings \u203A Phones and turn on Let phones connect.",
  "Click Add phone. A window with a code opens."
]), HOW_NOTE = "A paired phone can do everything Plenum can do on that computer. Keep this phone locked.", LAN_NO_CAMERA = "This page cannot use the camera. Scan the code with your phone's Camera app instead; it opens this page with the code.", CARRIER_LABEL = Object.freeze({ lan: "Same network", tailscale: "Tailscale", relay: "Your relay" }), LOCK_FAILED = "Not recognised. Try again or use your passcode.", PASTE_ERRORS = Object.freeze({
  "not-plenum": "This is not a Plenum pairing link. Copy it from the Add phone window on your computer.",
  expired: "This link has expired. Click Add phone on your computer again for a new one."
}), ASLEEP_STRIP = (name, when) => `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.`;
function storeLabel(platform) {
  return platform === "ios" ? "Open the App Store" : platform === "android" ? "Open Google Play" : "Open the release page";
}
function biometricName(platform) {
  return platform === "ios" ? "Face ID" : platform === "android" ? "your fingerprint or screen lock" : "a passkey or a PIN";
}
function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
function pendingLine(computer, pending) {
  let approvals = Number(pending?.approvals) || 0, runs = Number(pending?.runs) || 0, parts = [];
  return approvals && parts.push(plural(approvals, "approval waiting", "approvals waiting")), runs && parts.push(plural(runs, "run going", "runs going")), parts.length ? `On ${computer} now: ${parts.join(", ")}.` : null;
}
function updateAppBody(computer, desktop, app) {
  let tail = app ? ` than this one (${app})` : " than this one";
  return `${computer} runs Plenum ${desktop}, which needs a newer Plenum app${tail}. Update the app, then open it again.`;
}
function updateDesktopBody(computer, minimum, have) {
  return `This app needs Plenum ${minimum} or later on ${computer}, which has ${have}. On the computer, open Settings \u203A Updates and install the update.`;
}
function uiFailedBody(computer, cause) {
  return cause === "not-sent" ? `${computer} did not send Plenum's screens. Try again.` : cause === "stopped" ? `Plenum on ${computer} stopped while the screens were loading.` : "A file from " + computer + " did not match its checksum, so the phone kept the copy it had. Try again; if it happens again, restart Plenum on the computer.";
}
function drivingLine(computer, driving) {
  return `A model is driving ${computer}: ${driving}.`;
}
function waitText(waitSec) {
  return `Try again in ${waitSec} seconds.`;
}
function clock(seconds) {
  let s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function codeSpaced(code2) {
  let digits = String(code2 ?? "").replace(/\D/g, "").slice(0, 6);
  return digits.length !== 6 ? digits : `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
function codeLabel(code2) {
  return `Code ${String(code2 ?? "").replace(/\D/g, "").slice(0, 6).split("").join(" ")}`;
}
var STOP_LABEL = Object.freeze({ idle: "Stop", sending: "Stopping\u2026", queued: "Stop", done: "Stopped", failed: "Stop" }), FAILED_LINES = Object.freeze({
  lan: "Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.",
  tailscale: "Tailscale: no answer. Open Tailscale on this phone, connect, then try again.",
  relayOff: "Relay: {computer} is not connected to the relay. Check Settings \u203A Phones \u203A Relay on the computer.",
  notOffered: "Not available in this app: same network (an https web app cannot open your network's address). Use the Plenum app, or open the LAN page from the computer's window.",
  busy: "{computer} is busy. Try again in a minute."
}), FAILURE_LINES = Object.freeze({
  save: "The phone could not store the key. Try again.",
  locked: "Plenum is locked on this phone. Unlock it, then try again.",
  worker: "Plenum could not start the connection on this phone. Try again."
}), PUSH_OTHER_COMPUTER = "Web notifications on this address are on for another computer. Turn them off there first.";
function lockFailText(reason) {
  return reason === "other-computer" ? PUSH_OTHER_COMPUTER : reason === "unavailable" ? "This is not available on this device yet." : reason === "format" ? "That PIN is not valid. Use six digits." : reason === "mode" ? "This is already on." : "Plenum did not turn this on. Try again.";
}
var LINK_UNAVAILABLE = "This link is not in this build yet.", SETTINGS_MANUAL = "Open Settings on this phone and allow Plenum there.", CODE_TEXT = "shows a code in the Add phone window. If it is the same, click Allow there.", MISMATCH_BODY = "Stopped. Click Deny on your computer, then add the phone again. A different code can mean another device scanned the same code.", DENIED_BODY = "did not allow this phone. To try again, click Add phone on the computer.", EXPIRED_BODY = "The code expired after 2 minutes. Click Add phone on your computer again, then scan the new code.", REVOKED_BODY = "To use Plenum here again, add the phone at the computer under Settings \u203A Phones.", SCAN_HINT = "Point at the code in the Add phone window on your computer.";
var SCAN_DENIED = "Plenum cannot use the camera. Allow it in Settings \u203A Plenum \u203A Camera, or paste the link instead.", LOCALNET_BODY = "iPhone asks whether Plenum may find devices on your local network. Choose Allow on the next screen.", LOCALNET_DENIED = "iPhone is blocking local network access for Plenum. Turn it on in Settings \u203A Privacy & Security \u203A Local Network \u203A Plenum, or connect through Tailscale or your relay.", LOADING_HINT = "The first time takes a few seconds; after that only changed files load.", NOTIFY_BODY = "Get a notification when an approval waits or a run ends on {computer}. They show only the project and a status.", NOTIFY_BODY_LATER = "Notifications show while Plenum is open. Notifications when it is closed come with a later version.";
var PAIRING_CHECK = "Check the code", WELCOME_TITLE = "Plenum on your phone", WELCOME_LEAD = "Run, watch and approve the coding agents on your own computer.", NEEDS_CONSENT = "Pairing needs this consent. You can give it any time.";
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
]), COMPUTERS_TITLE = "Plenum", COMPUTERS_LABEL = "COMPUTERS", PAIR_ANOTHER = "Pair another computer", ROW_MENU = Object.freeze({ connect: "Connect", ways: "Ways to reach it", rename: "Rename on this phone", forget: "Forget this computer" }), STATUS = Object.freeze({ online: "Online", asleep: "Asleep", unreachable: "Not reachable" }), INSTALL_IOS_BODY = "Add Plenum to your Home Screen for notifications and a full-screen app. Tap Share, then Add to Home Screen, then open Plenum from the Home Screen and pair there.", INSTALL_IOS_STEPS = Object.freeze(["Tap Share.", "Tap Add to Home Screen.", "Open Plenum from the Home Screen."]), INSTALL_IOS_PAIR_HERE = "Pair in this tab, without notifications", INSTALL_ANDROID_BODY = "Install Plenum for notifications and a full-screen app.", INSTALL_NO_PROMPT = "This browser does not offer the install here. Use the browser menu and choose Install app.", LAN_WEB_STRIP = "This page works only on {computer}'s network and cannot send notifications. It is sent without encryption, so someone on this network could change it. On a network you do not trust, use the Plenum app, Tailscale or your relay.", PAIR_REVIEW_TITLE = (name) => `Pair with ${name}?`, PAIR_REVIEW_LEAD = "Pair only if you clicked Add phone on your own computer just now and its window shows a code.", PAIR_REVIEW_HOSTS = "This phone will connect to:", PAIR_REVIEW_NOTE = "A computer you pair with runs its own screens in this app.", PAIR_REVIEW_PAIR = "Pair", PAIR_REVIEW_CANCEL = "Cancel", STORAGE_UNAVAILABLE = "This phone could not open its secure storage, so Plenum cannot keep a computer's key here. Close Plenum and open it again. If it keeps happening, reinstall the app.", LOCK_UNKNOWN = "Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.", LOCK_UNKNOWN_NO_STOP = "Plenum could not read its lock settings, so it stays locked. This phone cannot send Stop from here. Press Stop on your computer (the Stop bar, or Ctrl+Alt+Esc). Close Plenum and open it again.", START_FAILED = "Plenum could not start on this page. Close it and open Plenum again.", LOCK_STOP = "Stop everything", LOCK_UNLOCK_STOP = "Unlock and stop everything", CONNECTED_SINCE = (computer, when) => `Connected to ${computer}${when ? ` since ${when}` : ""}.`, CONNECTED_TITLE = "Connected", RECONNECTING_TITLE = "Reconnecting", RECONNECTING_BODY = (computer) => `Reconnecting to ${computer}. Plenum keeps trying. The strip at the top says what is happening.`, RENAME_TITLE = "Rename on this phone", RENAME_HELP = "Only this phone shows this name. The computer keeps its own name.", FORGET_TITLE = "Forget {computer}?", FORGET_BODY = "This phone deletes its key for {computer}. {computer} keeps listing this phone until you remove it there under Settings \u203A Phones.", FORGET_CONFIRM = "Forget", CANCEL = "Cancel", SETTINGS_TITLE = "Phone settings", SETTINGS_COMPUTERS = "COMPUTERS", SETTINGS_THIS_PHONE = "THIS PHONE", SETTINGS_HELP = "HELP", PAIR_ANOTHER_SHORT = "Pair another computer", SETTINGS_NONE = "No computer is paired yet.", WAYS_TITLE = "Ways to reach {computer}", WAYS_LEAD = "Plenum tries the way it last connected first, then the others in this order.", WAYS_TEST = "Test them now", WAYS_CARRIER = Object.freeze({ lan: "the same network", tailscale: "Tailscale", relay: "your relay" }), WAYS_CONNECTED = (carrier) => `Connected by ${carrier} now. Test them again when the phone is not connected.`, WAYS_TRYING = "Trying the ways now. The line at the top says which one answers.", WAYS_NEW = "New ways you turn on at the computer appear here the next time this phone connects.", WAY_NOT_AVAILABLE = "Not available in this app", WAY_NOT_REACHABLE = "Not reachable";
var WAY_MOVE_UP = "Move up", WAY_MOVE_DOWN = "Move down", WAY_LAN_WEB = "An https web app cannot open your network's address.", WAY_NO_ADDRESS = "Turned off at the computer", NOTIFY_TITLE = "Notifications", NOTIFY_ON_PHONE = "On this phone", NOTIFY_KEPT = "KEPT ON {computer}, FOR EVERY PHONE", NOTIFY_APPROVE_ROW = "Approve from notifications", NOTIFY_TEST = "Send a test notification", NOTIFY_NOT_ARRIVING = "Not arriving? iPhone Focus modes and notification summaries can hold them back: Settings \u203A Notifications \u203A Plenum.", NOTIFY_NOT_ARRIVING_ANDROID = "Not arriving? Check Settings \u203A Apps \u203A Plenum \u203A Notifications on the phone.";
var NOTIFY_PERMISSION = Object.freeze({ granted: "Allowed", denied: "Blocked", default: "Not asked", unknown: "Not asked" }), NOTIFY_DENIED_HINT = "Turn them on in Settings for Plenum on this phone.", APPROVE_NOTIFY_TEXT = "The notification shows one line of the card. Approving from it runs that edit or command on {computer} without opening the card or the lines under it. Your phone asks for Face ID, your fingerprint or your PIN first. Deny and Stop never need this switch.", APPROVE_BLOCKED_TEXT = "A blocked command never shows Approve on a notification.", LOCK_TITLE = "App lock", LOCK_ROW = "Lock Plenum", LOCK_AFTER_LABEL = "After", LOCK_SWITCHER = "Hide content in the app switcher", LOCK_NOW = "Lock now", LOCK_OFF_TITLE = "Turn off the app lock?", LOCK_OFF_TEXT = "With the app lock off, anyone who can unlock this phone can run models, approve changes and use your computer through Plenum. If the phone is lost, remove it at the computer under Settings \u203A Phones.", LOCK_OFF_KEEP = "Keep the lock on", LOCK_OFF_TURN = "Turn off";
var LOCK_WEB_KEY = "The key that pairs this phone is kept in this browser's storage. Clearing the browser's website data removes it, and you pair again. A PIN or passkey protects the key from someone else using the unlocked phone.";
var PHONE_PUSH_TEXT = "Plenum sends your phone only the project name and a status, such as an approval is waiting. Anyone holding the phone can read that on the lock screen. Turning on Include the first line adds the first line of the card, which can name files and commands.", LOCK_OFF_HINT = "The app lock is off. Turn it on to ask for your passcode or Face ID before Plenum connects.", APPEARANCE_TITLE = "Appearance", APPEARANCE_THEME = "Theme", APPEARANCE_TEXT = "Text size", APPEARANCE_FOLLOW_TEXT = "Follow phone", APPEARANCE_SAMPLE = "Coding agents work in the folders you choose, and you approve what they change. This paragraph shows the text size you picked.", APPEARANCE_STOP = "Stop button", APPEARANCE_STOP_RIGHT = "Right", APPEARANCE_STOP_LEFT = "Left", APPEARANCE_HAPTICS = "Haptics", APPEARANCE_NOTE = "The theme here is for this phone. Settings \u203A General \u203A Theme changes {computer}.", APPEARANCE_HAPTICS_IOS = "Haptics are not available in the web app on iPhone.", DICTATION_TITLE = "Dictation", DICTATION_PREFER = "Prefer recognition on this phone", DICTATION_ALLOW = "Allow that", DICTATION_ALLOW_TEXT = "When your language is not available on the phone, Plenum can use Apple's or Google's speech service instead.", DICTATION_WEB = "Dictation runs in the Plenum app on your phone.", PHONE_VOICE = "Plenum asks your phone to turn what you say into text in the message box. It prefers recognition on the phone itself; where your language is not available there, Apple or Google may process the audio under their own terms. Nothing reaches your computer until you press Send.", DEBUG_TITLE = "Debug console", DEBUG_LEAD = "Holds the last 500 lines, kept only on this phone.", DEBUG_EMPTY = "No log lines yet.", DEBUG_COPY = "Copy", DEBUG_SEND = "Send to {computer}", DEBUG_CLEAR = "Clear", DEBUG_SENT = "Sent {n} lines to {computer}.", DEBUG_SEND_FAILED = "Could not send the log to {computer}. Connect, then try again.", DEBUG_COPIED = "Copied.", DEBUG_NO_CLIPBOARD = "This browser does not allow copying here. Select the lines to copy them.", ABOUT_TITLE = "About", ABOUT_APP = "Plenum app {version}", ABOUT_COMPUTER = "{computer}: Plenum {version}", ABOUT_LINK = "Link version {version}", ABOUT_SCREENS_BUILT = "Screens: built into this app", ABOUT_SCREENS_LOADED = "Screens: loaded from {computer}, {n} files, all checked", ABOUT_CONNECTED = "Connected over {carrier} since {when}", ABOUT_NEWER_UI = "{computer} has features this app does not show yet. Update the app to use them.", ABOUT_NOT_CONNECTED = "Not connected to a computer now.", LEGAL_TITLE = "Legal", LEGAL_ROWS = Object.freeze({ license: "License Agreement", privacy: "Privacy Notice", third: "Third-party notices" }), LEGAL_VERSIONS = "The versions {computer} uses are in Settings \u203A Legal.";
var DEMO_STRIP = "Demo: nothing here reaches a computer.", DEMO_EXIT = "Exit demo", DEMO_TITLE = "Demo computer", DEMO_RUNS = "RUNS", DEMO_APPROVAL = "Waiting for you", DEMO_APPROVE = "Approve", DEMO_DENY = "Deny", DEMO_RUN_LABEL = "Computer run", DEMO_DIFF_LABEL = "Changes", DEMO_ARTIFACT_LABEL = "Artifacts", DEMO_NO_PAIR = "The demo cannot pair with a computer. Exit the demo to pair.";
var DEMO_RESET = "Start the demo again", DEMO_EMPTY = "Nothing here yet.";
var SAVE = "Save", NOT_NOW = "Not now";
function fillName(text, computer) {
  return String(text).split("{computer}").join(String(computer ?? "your computer"));
}
function fillMany(text, values) {
  let out = String(text);
  for (let [key, value] of Object.entries(values ?? {})) out = out.split(`{${key}}`).join(String(value ?? ""));
  return out;
}
function rowStatus({ active = !1, connected: connected2 = !1, status = null, lastSeen = null, dateText = null } = {}) {
  return active && connected2 ? STATUS.online : status === "asleep" ? STATUS.asleep : status === "offline" || status === "reconnecting" ? STATUS.unreachable : lastSeen && dateText ? `Seen ${dateText}` : null;
}

// mobile/shell/screens/settings.js
var LOCK_AFTER = Object.freeze([
  Object.freeze({ id: "immediately", ms: 0, label: "Immediately" }),
  Object.freeze({ id: "m1", ms: 6e4, label: "1 minute" }),
  Object.freeze({ id: "m5", ms: 3e5, label: "5 minutes" }),
  Object.freeze({ id: "m15", ms: 9e5, label: "15 minutes" }),
  Object.freeze({ id: "h1", ms: 36e5, label: "1 hour" })
]), DEFAULT_LOCK_AFTER = "m5";
function lockAfter(id) {
  return LOCK_AFTER.find((o) => o.id === id) ?? LOCK_AFTER.find((o) => o.id === DEFAULT_LOCK_AFTER);
}
var WAY_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
function orderedWays(stored) {
  let seen = [];
  for (let kind of Array.isArray(stored) ? stored : [])
    WAY_KINDS.includes(kind) && !seen.includes(kind) && seen.push(kind);
  for (let kind of WAY_KINDS) seen.includes(kind) || seen.push(kind);
  return seen;
}
function approveSwitch({ tier = "full", firstLine = !1, lockMode = "off", native = !1 } = {}) {
  if (tier === "read") return { visible: !1, enabled: !1, missing: null };
  let lockOn = native ? lockMode === "biometric" || lockMode === "pin" || lockMode === "passkey" : lockMode === "pin" || lockMode === "passkey";
  return firstLine ? lockOn ? { visible: !0, enabled: !0, missing: null } : { visible: !0, enabled: !1, missing: "app-lock" } : { visible: !0, enabled: !1, missing: "first-line" };
}
var APPROVE_MISSING_TEXT = Object.freeze({
  "first-line": 'Turn on "Include the first line" first.',
  "app-lock": "Turn on the app lock first. On the web app that means a PIN or a passkey."
});
function approveChecked(stored, rule) {
  return !!stored && !!rule?.enabled;
}
var TEXT_MIN = 85, TEXT_MAX = 200, TEXT_STEP = 5, TEXT_DEFAULT = 100;
function clampText(value) {
  let n = Math.round((Number(value) || TEXT_DEFAULT) / TEXT_STEP) * TEXT_STEP;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, n));
}
var THEMES = Object.freeze(["follow", "dark", "light"]), THEME_LABEL = Object.freeze({ follow: "Follow phone", dark: "Dark", light: "Light" });
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
]), PUSH_DEFAULTS = Object.freeze({ approvals: !0, finished: !0, limits: !0, onlyWhenAway: !0, firstLine: !1 });
function pushValues(known) {
  let out = { ...PUSH_DEFAULTS };
  for (let { key } of PUSH_SWITCHES)
    typeof known?.[key] == "boolean" && (out[key] = known[key]);
  return out;
}
function pushPatch(key, value, approveStored) {
  let patch = { [key]: value === !0 };
  return key === "firstLine" && value !== !0 && approveStored && (patch.approveFromNotifications = !1), patch;
}
function unifiedPushLine(distributor) {
  return distributor ? distributor === "io.heckel.ntfy" ? "Notifications from closed app: through ntfy (UnifiedPush)." : "Notifications from closed app: through your UnifiedPush app." : "Install a UnifiedPush app such as ntfy to get notifications while Plenum is closed.";
}
function normalisePrefs(raw) {
  let p = raw && typeof raw == "object" ? raw : {};
  return {
    theme: normaliseTheme(p.theme),
    textSize: p.textSize == null ? null : clampText(p.textSize),
    stopSide: normaliseStopSide(p.stopSide),
    haptics: p.haptics !== !1,
    hideSwitcher: p.hideSwitcher !== !1,
    lockAfter: lockAfter(p.lockAfter).id,
    dictationOnDevice: p.dictationOnDevice !== !1,
    dictationAllowService: p.dictationAllowService !== !1,
    lanDismissed: p.lanDismissed === !0
  };
}

// mobile/shell/device.js
function isLanPage(win) {
  let loc = win?.location ?? {};
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(loc.hostname ?? "")) ? !1 : win?.isSecureContext === !1 || String(loc.protocol ?? "") === "http:";
}

// mobile/shell/screens/route.js
var COUNTDOWN_S = 120, CARRIERS = Object.freeze(["lan", "tailscale", "relay"]), STATUS_SCREENS = Object.freeze(["revoked", "update-app", "update-desktop"]), RECONNECT_STATES = Object.freeze(["connecting", "reconnecting", "offline", "asleep"]);
function stateKey(s) {
  return JSON.stringify([
    s?.locked === !0,
    s?.pairing?.state ?? null,
    s?.pairing?.reason ?? null,
    s?.connection?.status ?? null,
    s?.activeId ?? null
  ]);
}
function terminalScreen(s) {
  let p = s.pairing ?? null;
  if (p?.state === "mismatch") return "mismatch";
  if (p?.state === "denied") return "denied";
  if (p?.state === "expired") return "expired";
  if (p?.state === "failed") return pairingFailureScreen(p.reason);
  let status = s.connection?.status ?? null;
  return status === "not-known" ? "revoked" : STATUS_SCREENS.includes(status) ? status : null;
}
function screenFor(s, nav = {}) {
  if (!s) return null;
  if (s.locked) return s.lock?.mode === "pin" ? "lock-pin" : "lock-bio";
  let p = s.pairing ?? null;
  if (p?.state === "review") return "pair-review";
  if (p?.state === "confirm" && !nav.pairingCancelled)
    return nav.forced ? nav.forced : nav.codeExpired ? "expired" : "code";
  if (nav.pairingCancelled && nav.screen === "mismatch") return "mismatch";
  let dismissed = nav.dismissedKey != null && nav.dismissedKey === stateKey(s);
  if (p?.state === "starting") return "connecting";
  if (!dismissed) {
    let shown = terminalScreen(s);
    if (shown) return shown;
  }
  if (nav.onboarding?.length) return nav.onboarding[0];
  if (nav.uiState) return nav.uiState;
  if (s.ui?.state === "loading" || s.ui?.state === "navigating") return "loading";
  if (s.ui?.state === "failed") return "ui-failed";
  if (!dismissed && s.activeId && !s.hello) {
    let status = s.connection?.status ?? null;
    if (nav.wasConnected === s.activeId && RECONNECT_STATES.includes(status)) return "connected";
    if (status === "connecting" || status === "reconnecting") return "connecting";
    if (status === "offline" || status === "asleep") return "failed";
  }
  return nav.screen === "computers" ? null : nav.screen ? nav.screen : s.computers?.length ? null : "welcome";
}
function pairingFailureScreen(reason) {
  return reason === "not-plenum" || reason === "version" || reason === "bad-link" || reason === "expired" ? "paste" : "failed";
}
function pasteError(pairing) {
  return pairing?.state !== "failed" ? null : pairing.reason === "expired" ? "expired" : "not-plenum";
}
function codeSecondsLeft(codeSince, now) {
  if (codeSince == null) return COUNTDOWN_S;
  let used = Math.floor((now - codeSince) / 1e3);
  return Math.max(0, COUNTDOWN_S - used);
}
function platformOf(env = {}) {
  let cap = env.Capacitor;
  return cap?.isNativePlatform?.() === !0 ? cap.getPlatform?.() === "android" ? "android" : "ios" : "web";
}
function lanPage(env = {}) {
  return isLanPage(env);
}
function defaultPhoneName(platform) {
  return platform === "ios" ? "iPhone" : platform === "android" ? "Android phone" : "Phone";
}
function passkeyAvailable(env = {}) {
  return env.isSecureContext === !0 && typeof env.PublicKeyCredential == "function";
}
function drivingText(driving) {
  if (!driving || typeof driving != "object") return null;
  let app = String(driving.app ?? "").trim();
  if (!app) return null;
  let step = Number(driving.step), of = Number(driving.of);
  return Number.isFinite(step) && Number.isFinite(of) && of > 0 ? `${app}, step ${step} of ${of}` : app;
}
function clockTime(ms) {
  let d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function stripFor(conn, computer, env = {}) {
  if (env.navigator?.onLine === !1) return { tone: "muted", text: "This phone is offline." };
  let status = conn?.status ?? null, when = conn?.lastSeen ? ` Last seen ${clockTime(conn.lastSeen)}.` : "";
  return status === "reconnecting" ? { tone: "warn", text: `Reconnecting to ${computer}\u2026` } : status === "offline" ? { tone: "bad", text: `Can't reach ${computer}.${when}` } : status === "asleep" ? { tone: "muted", text: ASLEEP_STRIP(computer, when) } : null;
}
function ctxFor(s, nav = {}, env = {}) {
  let platform = platformOf(env), lan = lanPage(env), hello = s?.hello ?? null, active = (s?.computers ?? []).find((c) => c.id === s?.activeId) ?? null, computer = String(hello?.desktopName || active?.name || "your computer"), conn = s?.connection ?? {}, pairing = s?.pairing ?? null, tried = pairing?.tried ?? conn.failure?.tried ?? [], driving = hello?.pending?.driving ?? nav.lastDriving ?? null;
  return {
    platform,
    lan,
    computer,
    session: !!s?.activeId || !!(s?.locked && s?.computers?.length),
    phoneName: nav.local?.phoneName ?? defaultPhoneName(platform),
    code: pairing?.code ?? null,
    carrier: conn.carrier ?? pairing?.carrier ?? null,
    failReason: pairing?.state === "failed" ? pairing.reason ?? null : null,
    tried: (Array.isArray(tried) ? tried : []).map((t) => ({ carrier: String(t?.carrier ?? t?.kind ?? ""), reason: t?.reason ?? null })),
    lock: { mode: s?.lock?.mode ?? "off", failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0 },
    pending: hello?.pending ?? null,
    driving: drivingText(driving),
    // True while a computer this session was connected to is coming back (the stand-in says so, and no "Connected").
    reconnecting: !!s?.activeId && !hello && nav.wasConnected === s?.activeId,
    pasteError: pasteError(pairing),
    desktopVersion: hello?.desktopVersion || null,
    minVersion: conn.failure?.minimum ?? null,
    haveVersion: conn.failure?.have ?? hello?.desktopVersion ?? null,
    appVersion: env.plenumAppVersion ?? null,
    cause: s?.ui?.cause ?? nav.uiCause ?? "checksum",
    hasCopy: !!(s?.ui?.hasCopy ?? nav.hasCopy),
    forwarder: FORWARDER_BUILD,
    consentGiven: !!nav.consentGiven,
    passkeyAvailable: passkeyAvailable(env),
    bundled: s?.ui?.kind === "ios",
    progress: s?.ui?.progress ?? nav.progress ?? null,
    // The shell page can open the desktop's UI ("Open Plenum") when it has a UI host; /?shell keeps the person on the shell's own screens.
    uiAvailable: !!s?.ui?.kind,
    stopState: s?.stop?.state ?? "idle",
    // The Stop result text shows only while a Stop is sending, queued, done or failed (C6d).
    stopText: ["sending", "queued", "done", "failed"].includes(s?.stop?.state) ? s.stop.text ?? "" : "",
    review: pairing?.review ?? null,
    lockStop: s?.lockStop ?? { ready: !1, computerName: "" },
    storageUnavailable: s?.storage === "unavailable",
    lockUnknown: s?.lock?.mode === "unknown",
    stripInfo: stripFor(conn, computer, env),
    alreadyPaired: !1,
    localDenied: !1,
    cameraDenied: !!nav.local?.cameraDenied,
    carrierLabel: CARRIER_LABEL[conn.carrier] ?? null,
    onboardMessage: nav.local?.onboardMessage ?? null,
    linkMessage: nav.local?.linkMessage ?? null
  };
}
function offeredCarriers(tried) {
  let seen = [];
  for (let t of Array.isArray(tried) ? tried : [])
    CARRIERS.includes(t?.carrier) && !seen.includes(t.carrier) && seen.push(t.carrier);
  return seen.length ? seen : [...CARRIERS];
}
function failedLines(ctx) {
  let alone = FAILURE_LINES[ctx.failReason ?? ""];
  if (alone) return [{ kind: "reason", text: alone }];
  let notOffered = ctx.platform === "web" && !ctx.lan;
  return offeredCarriers(ctx.tried).map((kind) => {
    let reason = (ctx.tried ?? []).find((t) => t.carrier === kind)?.reason ?? null, text;
    return reason === "busy" ? text = FAILED_LINES.busy : kind === "lan" ? text = notOffered ? FAILED_LINES.notOffered : FAILED_LINES.lan : kind === "tailscale" ? text = FAILED_LINES.tailscale : text = FAILED_LINES.relayOff, { kind, text: fill(text, ctx.computer) };
  });
}

// mobile/shell/screens/fixtures.js
var DEMO_BASE = Object.freeze({
  platform: "web",
  lan: !1,
  computer: "Home PC",
  session: !1,
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
  hasCopy: !0,
  forwarder: FORWARDER_BUILD,
  consentGiven: !1,
  passkeyAvailable: !0,
  bundled: !1,
  progress: Object.freeze({ done: 21, total: 47 }),
  stopState: "idle",
  stopText: "",
  stripInfo: null,
  alreadyPaired: !1,
  localDenied: !1,
  cameraDenied: !1,
  carrierLabel: "Same network",
  countdown: 120
}), PER_SCREEN = Object.freeze({
  welcome: { platform: "web", phoneName: "Phone" },
  consent: { platform: "ios", phoneName: "iPhone" },
  how: { platform: "web" },
  scan: { platform: "web" },
  "scan-denied": { platform: "web", cameraDenied: !0 },
  paste: { platform: "web" },
  localnet: { platform: "ios", phoneName: "iPhone" },
  connecting: { platform: "ios", session: !0, carrier: "lan", carrierLabel: "Same network" },
  failed: { platform: "ios", session: !0 },
  code: { platform: "ios", phoneName: "iPhone" },
  mismatch: { platform: "ios" },
  denied: { platform: "ios" },
  expired: { platform: "ios" },
  "paired-lock": { platform: "ios" },
  "paired-notify": { platform: "ios" },
  loading: { platform: "ios", session: !0 },
  "lock-bio": { platform: "ios", session: !0, driving: "Notepad, step 12 of 80", lock: { mode: "biometric", failures: 0, waitSec: 0 } },
  "lock-pin": { platform: "web", lock: { mode: "pin", failures: 5, waitSec: 30 } },
  "update-app": { platform: "ios", session: !0 },
  "update-desktop": { platform: "web", session: !0 },
  revoked: { platform: "web" },
  "ui-failed": { platform: "web", session: !0, cause: "checksum", hasCopy: !0 }
});
function fixtureCtx(id, overrides = {}) {
  return SCREEN_IDS.includes(id) ? { ...DEMO_BASE, ...PER_SCREEN[id], ...overrides, id } : null;
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
  let fn = core?.[name];
  if (typeof fn != "function") return { ok: !1, reason: "unavailable" };
  try {
    let out = await fn.apply(core, args);
    if (out === !0) return { ok: !0, reason: null };
    if (out && typeof out == "object") {
      let ok = out.ok === !0;
      return { ...out, ok, reason: ok ? out.reason ?? null : out.reason ?? "failed" };
    }
    return { ok: !1, reason: "failed" };
  } catch {
    return { ok: !1, reason: "failed" };
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
  let result = await unlockFlow(core, method);
  if (!result.ok) return result;
  try {
    await core.stop?.();
  } catch {
    return { ...result, stopped: !1 };
  }
  return { ...result, stopped: !0 };
}
async function forgetFlow(core, id) {
  if (typeof core?.forget != "function" || !id) return { ok: !1, reason: "unavailable" };
  try {
    return await core.forget(id), { ok: !0, reason: null };
  } catch {
    return { ok: !1, reason: "failed" };
  }
}
var REPO = "https://github.com/RealAlcibiades/Plenum", LEGAL_LINKS = Object.freeze({
  privacy: `${REPO}/blob/main/legal/PRIVACY.md`,
  "third-party": `${REPO}/blob/main/legal/THIRD-PARTY-SERVICES.md`,
  license: `${REPO}/blob/main/legal/EULA.md`,
  third: `${REPO}/blob/main/THIRD-PARTY-NOTICES.txt`
}), STORE_LINKS = Object.freeze({ ios: null, android: `${REPO}/releases`, web: `${REPO}/releases` });
function openLinkFlow(env, href) {
  if (!href) return { ok: !1, reason: "not-configured" };
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return { ok: !1, reason: "bad-link" };
  }
  if (url.protocol !== "https:") return { ok: !1, reason: "bad-link" };
  let browser = env?.Capacitor?.Plugins?.Browser;
  return browser?.open ? (Promise.resolve(browser.open({ url: url.href })).catch(() => {
  }), { ok: !0, reason: null }) : typeof env?.open == "function" ? (env.open(url.href, "_blank", "noopener"), { ok: !0, reason: null }) : { ok: !1, reason: "unavailable" };
}
function openSettingsFlow() {
  return { ok: !1, reason: "manual" };
}
function cleanPhoneName(text, fallback) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, 60).trim() || fallback;
}

// mobile/shell/screens/views.js
var LOCK_SCREENS = Object.freeze(["lock-bio", "lock-pin"]), storageLine = (ctx) => ctx.storageUnavailable ? el("p", { class: "sh-msg sh-warn", role: "note", text: STORAGE_UNAVAILABLE }) : null;
function frame(ctx, io, o) {
  let classes = ["sh-screen"];
  ctx.session && !LOCK_SCREENS.includes(ctx.id) && classes.push("sh-has-stop"), ctx.stripInfo && classes.push("sh-has-strip"), o.center && classes.push("sh-center");
  let back = o.back ? el("button", { type: "button", class: "sh-icon", "aria-label": "Back", on: { click: () => io.back() } }, "\u2039") : el("span", { class: "sh-icon-gap", "aria-hidden": "true" }), head = el("header", { class: "sh-top" }, back, o.trailing ?? null), title = el("h1", { class: "sh-title", id: "sh-title", tabindex: "-1" }, o.title), main = el(
    "main",
    { class: "sh-main", id: "sh-main" },
    o.lead ?? null,
    o.kicker ? el("p", { class: o.kickerClass ?? "sh-kicker" }, o.kicker) : null,
    title,
    o.body ?? null,
    ctx.linkMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.linkMessage }) : null
  ), actions = (o.actions ?? []).filter(Boolean), foot = actions.length ? el("footer", { class: "sh-actions" }, actions) : null;
  return el("div", { class: classes.join(" "), "data-screen": ctx.id }, head, main, foot);
}
var para = (text, cls = null) => el("p", { class: cls, text });
function mark(size) {
  return el("img", { class: "sh-mark", src: "icons/app.svg", alt: "", width: String(size), height: String(size) });
}
function welcome(ctx, io) {
  let declined = !!io.local.consentDeclined, needsConsent = ctx.platform === "ios" && !ctx.consentGiven, input = el("input", { class: "sh-input", id: "sh-name", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "64", "aria-describedby": "sh-name-help" });
  input.value = io.local.phoneName ?? ctx.phoneName, input.addEventListener("input", () => {
    io.local.phoneName = input.value;
  });
  let [first, second] = welcomePrivacy(ctx.forwarder);
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
    back: !0,
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
        io.local.consentDeclined = !0, io.go("welcome");
      } }),
      button("Allow", { kind: "primary", onClick: () => {
        io.act.consent(!0), io.go("how");
      } })
    ]
  });
}
function how(ctx, io) {
  let steps = HOW_STEPS.map((text) => el("li", { text })), actions = ctx.lan ? [button("Paste a link", { kind: "primary", onClick: () => io.go("paste") })] : [button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }), button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })];
  return frame(ctx, io, {
    title: "Pair with your computer",
    back: !0,
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
  let video = el("video", { class: "sh-video", playsinline: !0, muted: !0, autoplay: !0, hidden: ctx.platform !== "web", "aria-hidden": "true" });
  video.muted = !0;
  let viewfinder = el(
    "div",
    { class: "sh-viewfinder", role: "img", "aria-label": "Camera view. Point at the code on your computer." },
    video,
    el("span", { class: "sh-corner sh-c1", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c2", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c3", "aria-hidden": "true" }),
    el("span", { class: "sh-corner sh-c4", "aria-hidden": "true" })
  );
  return io.later(() => {
    io.act.startScan?.(video);
  }, 0), frame(ctx, io, {
    title: "Scan the code",
    back: !0,
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
    back: !0,
    body: [para(SCAN_DENIED, "sh-note")],
    actions: [
      button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }),
      button("Open Settings", { kind: "primary", onClick: () => io.act.openSettings("camera") })
    ]
  });
}
function scanDeniedScreen(ctx, io) {
  return scanDenied({ ...ctx, cameraDenied: !0 }, io);
}
function paste(ctx, io) {
  let area = el("textarea", { class: "sh-input sh-textarea", id: "sh-link", rows: "4", autocomplete: "off", spellcheck: "false", "aria-describedby": "sh-link-err" });
  area.value = io.local.link ?? "", area.addEventListener("input", () => {
    io.local.link = area.value;
  });
  let errorKey = ctx.pasteError ?? null, error = errorKey ? PASTE_ERRORS[errorKey] : null, native = ctx.platform !== "web";
  return frame(ctx, io, {
    title: "Paste a link",
    back: !0,
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
        area.value = text, io.local.link = text;
      }) }) : null,
      button("Connect", { kind: "primary", onClick: () => io.act.pair(area.value) })
    ]
  });
}
function localnet(ctx, io) {
  let denied2 = !!ctx.localDenied;
  return frame(ctx, io, {
    title: "Find your computer on this Wi-Fi",
    back: !0,
    body: [para(denied2 ? LOCALNET_DENIED : `To reach ${ctx.computer} on this network, ${LOCALNET_BODY}`)],
    actions: denied2 ? [
      button("Try other ways", { kind: "ghost", onClick: () => io.go("how") }),
      button("Open Settings", { kind: "primary", onClick: () => io.act.openSettings("local-network") })
    ] : [button("Continue", { kind: "primary", onClick: () => {
      io.act.continueLocalNet(), io.back();
    } })]
  });
}
function connecting(ctx, io) {
  let carrier = CARRIER_LABEL[ctx.carrier] ?? ctx.carrierLabel ?? null, step = (state, label, note) => {
    let mark2 = state === "done" ? "\u2713" : state === "active" ? "\u25CC" : "\u25CB", status = state === "done" ? "done" : state === "active" ? "in progress" : "waiting";
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
  let lines = failedLines(ctx).map((line) => el(
    "li",
    { class: "sh-line" },
    el("span", { class: "sh-bullet", "aria-hidden": "true" }),
    el("span", { text: line.text })
  )), busy = ctx.tried.some((t) => t.reason === "busy");
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
  let countdown = el(
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
  let actions = ctx.lan ? [button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })] : [button("Paste a link", { kind: "ghost", onClick: () => io.go("paste") }), button("Scan the code", { kind: "primary", onClick: () => io.go("scan") })];
  return frame(ctx, io, {
    title: "The code expired",
    body: [para(EXPIRED_BODY, "sh-note")],
    actions
  });
}
function stepThen(io, call2) {
  return async () => {
    let result = await call2();
    if (result?.ok === !0) {
      io.local.onboardMessage = null, io.advance();
      return;
    }
    io.local.onboardMessage = lockFailText(result?.reason ?? "failed"), io.repaint();
  };
}
function pairedLock(ctx, io) {
  let bio = biometricName(ctx.platform), web = ctx.platform === "web", advance = () => {
    io.local.onboardMessage = null, io.advance();
  }, message = ctx.onboardMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.onboardMessage }) : null, withPasskey = web && ctx.passkeyAvailable === !0;
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
  let advance = () => {
    io.local.onboardMessage = null, io.advance();
  }, message = ctx.onboardMessage ? el("p", { class: "sh-msg", role: "alert", text: ctx.onboardMessage }) : null;
  return ctx.platform === "ios" && !ctx.forwarder ? frame(ctx, io, {
    title: "Notifications",
    body: [para(NOTIFY_BODY_LATER, "sh-note"), message],
    actions: [button("Continue", { kind: "primary", onClick: advance })]
  }) : frame(ctx, io, {
    title: "Notifications",
    body: [para(fill(NOTIFY_BODY, ctx.computer), "sh-note"), message],
    actions: [
      button("Not now", { kind: "ghost", onClick: advance }),
      button("Turn on", { kind: "primary", onClick: stepThen(io, () => io.act.enableNotifications()) })
    ]
  });
}
function loading(ctx, io) {
  let total = Math.max(1, Number(ctx.progress?.total) || 1), done = Math.min(total, Math.max(0, Number(ctx.progress?.done) || 0)), root = frame(ctx, io, {
    title: ctx.bundled ? "Starting Plenum\u2026" : `Loading Plenum from ${ctx.computer}`,
    lead: mark(48),
    body: [
      el("progress", { class: "sh-progress", max: String(total), value: String(done), "aria-label": "Loading Plenum" }),
      para(`${done} of ${total}`, "sh-note"),
      para(LOADING_HINT, "sh-help")
    ]
  });
  return ctx.bundled && (root.hidden = !0, io.later(() => {
    root.hidden = !1;
  }, 400)), root;
}
function lockBio(ctx, io) {
  let method = ctx.lock.mode === "passkey" ? "passkey" : "biometric", bio = method === "passkey" ? "a passkey" : biometricName(ctx.platform), message = ctx.bioMessage ?? null, stopReady = ctx.lockStop?.ready === !0, unknown = ctx.lockUnknown === !0, stopAll = ctx.session && !(unknown && !stopReady) ? button(stopReady ? LOCK_STOP : LOCK_UNLOCK_STOP, {
    kind: "danger",
    onClick: () => stopReady ? io.act.stopLocked() : io.act.unlockAndStop(method)
  }) : null;
  return frame(ctx, io, {
    center: !0,
    lead: mark(56),
    title: "Plenum is locked",
    body: [
      ctx.driving ? el("p", { class: "sh-note sh-driving", role: "status", text: drivingLine(ctx.computer, ctx.driving) }) : null,
      unknown ? para(stopReady ? LOCK_UNKNOWN : LOCK_UNKNOWN_NO_STOP, "sh-note") : null,
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
  let digits = "", dots = Array.from({ length: 6 }, () => el("span", { class: "sh-dot", "aria-hidden": "true" })), counter = el("span", { class: "sh-sr", "aria-live": "polite" }, "0 of 6 digits entered"), message = el(
    "p",
    { class: "sh-msg", id: "sh-pin-msg", role: "alert" },
    io.local.pinMessage ?? (ctx.lock.waitSec > 0 ? `Wrong PIN. ${waitText(ctx.lock.waitSec)}` : null)
  ), draw = () => {
    dots.forEach((dot, i) => {
      i < digits.length ? dot.setAttribute("data-on", "") : dot.removeAttribute("data-on");
    }), counter.textContent = `${digits.length} of 6 digits entered`;
  }, press = async (key) => {
    if (key === "Delete") {
      digits = digits.slice(0, -1), draw();
      return;
    }
    if (digits.length >= 6 || (digits += key, draw(), digits.length < 6)) return;
    let entered = digits;
    digits = "", draw();
    let result = await io.act.unlock("pin", entered);
    if (result && result.ok === !1) {
      let wait = Number(result.waitSec) || 0;
      io.local.pinMessage = result.reason === "wait" ? waitText(wait) : wait > 0 ? `Wrong PIN. ${waitText(wait)}` : "Wrong PIN.", message.textContent = io.local.pinMessage;
      return;
    }
    result?.ok === !0 && io.local.stopAfterUnlock && (io.local.stopAfterUnlock = !1, await io.act.stop());
  }, pad = el(
    "div",
    { class: "sh-pad", role: "group", "aria-label": "PIN" },
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"].map((key) => key === null ? el("span", { class: "sh-key-gap", "aria-hidden": "true" }) : el("button", {
      type: "button",
      class: key === "Delete" ? "sh-key sh-key-del" : "sh-key",
      "aria-label": key === "Delete" ? "Delete" : key,
      on: { click: () => {
        press(key);
      } }
    }, key === "Delete" ? "Delete" : key))
  );
  draw();
  let stopReady = ctx.lockStop?.ready === !0, stopAll = ctx.session ? button(stopReady ? LOCK_STOP : LOCK_UNLOCK_STOP, {
    kind: "danger",
    onClick: () => {
      if (stopReady) {
        io.act.stopLocked();
        return;
      }
      io.local.stopAfterUnlock = !0, message.textContent = "Enter your PIN. Plenum stops everything once it unlocks.";
    }
  }) : null;
  return frame(ctx, io, {
    center: !0,
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
  let link = STORE_LINKS[platform] ?? null;
  return link && link.startsWith("https://github.com/") ? storeLabel("web") : storeLabel(platform);
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
          await io.act.forgetActive(), io.go(ctx.platform === "ios" && !ctx.consentGiven ? "consent" : "how");
        }
      })
    ]
  });
}
var WORKER_TEXT = "This browser cannot keep Plenum's screens on the phone. Open Plenum in Chrome or Safari, or add it to your Home Screen, then try again.";
function uiFailed(ctx, io) {
  let pending = pendingLine(ctx.computer, ctx.pending);
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
  let build = BUILDERS[id];
  return build ? build({ ...ctx, id }, io) : null;
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
function switchRow({ label, checked, disabled = !1, note = null, onChange, id = null }) {
  let noteId = note && id ? `${id}-note` : null;
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
          !disabled && onChange && onChange(!checked);
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
  let hosts = Array.isArray(ctx.review?.hosts) ? ctx.review.hosts : [];
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
  let vm = ctx.vm, menuOpen = io.local.rowMenu ?? null, rows = vm.computers.map((c) => {
    let status = rowStatus({ active: c.active, connected: c.connected, status: c.status, lastSeen: c.lastSeen, dateText: c.dateText }), meta = [c.active && c.connected ? c.carrierLabel : c.lastCarrierLabel ? `Last by ${c.lastCarrierLabel}` : null, c.version ? `Plenum ${c.version}` : null].filter(Boolean).join(" \xB7 "), menu = menuOpen === c.id ? el(
      "div",
      { class: "sh-rowmenu" },
      button(ROW_MENU.connect, { kind: "ghost", onClick: () => io.act.connect(c.id) }),
      button(ROW_MENU.ways, { kind: "ghost", onClick: () => {
        io.local.waysFor = c.id, io.go("settings-connection");
      } }),
      button(ROW_MENU.rename, { kind: "ghost", onClick: () => {
        io.local.renameId = c.id, io.go("rename");
      } }),
      button(ROW_MENU.forget, { kind: "danger", onClick: () => {
        io.local.forgetId = c.id, io.go("forget");
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
            io.local.rowMenu = menuOpen === c.id ? null : c.id, io.repaint();
          } }
        }, "\u22EF")
      ),
      menu
    );
  }), gear = el("button", { type: "button", class: "sh-icon", "aria-label": SETTINGS_TITLE, on: { click: () => io.go("settings") } }, "\u2699");
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
    back: !0,
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
    back: !0,
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
    back: !0,
    body: [para(fill(LAN_WEB_STRIP, ctx.computer), "sh-note")],
    actions: [button("Got it", { kind: "primary", onClick: () => {
      io.act.dismissLan(), io.back();
    } })]
  });
}
function connected(ctx, io) {
  let vm = ctx.vm, pending = pendingLine(ctx.computer, ctx.pending), actions = [
    // The computer's UI is the phone's home (ui-host.js hands the page to it after HELLO). This page is the shell's own screens (/?shell), so
    // the way back to the UI is a button.
    ctx.uiAvailable && !ctx.reconnecting ? button("Open Plenum", { kind: "primary", onClick: () => io.act.openUi() }) : null,
    vm.computers.length > 1 ? button("Computers", { kind: "ghost", onClick: () => io.go("computers") }) : null,
    button("Ways to reach", { kind: "ghost", onClick: () => io.go("settings-connection") }),
    button("Phone settings", { kind: ctx.uiAvailable && !ctx.reconnecting ? "ghost" : "primary", onClick: () => io.go("settings") })
  ];
  return ctx.reconnecting ? frame(ctx, io, {
    kicker: RECONNECTING_TITLE,
    kickerClass: "sh-status",
    title: ctx.computer,
    body: [para(RECONNECTING_BODY(ctx.computer), "sh-note")],
    actions
  }) : frame(ctx, io, {
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
  let current = ((vm) => vm.computers.find((c) => c.id === io.local.renameId) ?? vm.computers.find((c) => c.active) ?? null)(ctx.vm), input = el("input", { class: "sh-input", id: "sh-rename", type: "text", autocomplete: "off", spellcheck: "false", maxlength: "60", "aria-describedby": "sh-rename-help" });
  return input.value = io.local.renameValue ?? current?.name ?? "", input.addEventListener("input", () => {
    io.local.renameValue = input.value;
  }), frame(ctx, io, {
    title: RENAME_TITLE,
    back: !0,
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
        if ((await io.act.rename(current?.id ?? null, String(input.value ?? "")))?.ok) {
          io.local.renameNote = null, io.back();
          return;
        }
        io.local.renameNote = "The name could not be saved. Try again.", io.repaint();
      } })
    ]
  });
}
function forget(ctx, io) {
  let id = io.local.forgetId ?? ctx.vm.computers.find((c) => c.active)?.id ?? null, name = ctx.vm.computers.find((c) => c.id === id)?.name ?? ctx.computer, cancel = null, root = frame(ctx, io, {
    title: fillName(FORGET_TITLE, name),
    back: !0,
    body: [para(fillName(FORGET_BODY, name), "sh-note"), msgNode(io.local.forgetNote ?? null)],
    actions: [
      cancel = button(CANCEL, { kind: "ghost", onClick: () => io.back() }),
      button(FORGET_CONFIRM, {
        kind: "danger",
        onClick: async () => {
          if ((await io.act.forget(id))?.ok) {
            io.local.forgetId = null, io.go("computers");
            return;
          }
          io.local.forgetNote = "Plenum could not forget this computer. Try again.", io.repaint();
        }
      })
    ]
  });
  return io.later(() => {
    cancel?.focus?.({ preventScroll: !0 });
  }, 0), root;
}
function settings(ctx, io) {
  let vm = ctx.vm, computerRows = vm.computers.map((c) => row(c.name, c.active && c.connected ? "Connected" : null, () => {
    io.local.waysFor = c.id, io.go("settings-connection");
  })), lockValue = vm.lock.mode === "off" ? "Off" : `${vm.lock.label} \xB7 ${lockAfter(vm.prefs.lockAfter).label}`;
  return frame(ctx, io, {
    title: SETTINGS_TITLE,
    back: !0,
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
  let vm = ctx.vm, id = io.local.waysFor ?? vm.computers.find((c) => c.active)?.id ?? vm.computers[0]?.id ?? null, target = vm.computers.find((c) => c.id === id) ?? null, name = target?.name ?? ctx.computer, order = orderedWays(target?.carrierOrder ?? []), present = new Set(target?.ways ?? []), ways = order.map((kind, i) => {
    let on = present.has(kind), web = ctx.platform === "web" && !ctx.lan && kind === "lan", label = CARRIER_LABEL[kind], note = web ? WAY_LAN_WEB : on ? target?.waysDetail?.[kind] ?? null : WAY_NO_ADDRESS, probe = io.local.wayProbe?.[kind] ?? null;
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
            i > 0 && io.act.moveWay(id, kind, "up");
          } }
        }, "\u2191"),
        el("button", {
          type: "button",
          class: "sh-move",
          "aria-label": `${WAY_MOVE_DOWN}: ${label}`,
          "aria-disabled": i === order.length - 1 ? "true" : null,
          on: { click: () => {
            i < order.length - 1 && io.act.moveWay(id, kind, "down");
          } }
        }, "\u2193")
      )
    );
  });
  return frame(ctx, io, {
    title: fill(WAYS_TITLE, name),
    back: !0,
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
          io.local.renameId = id, io.go("rename");
        } }),
        button(ROW_MENU.forget, { kind: "link", onClick: () => {
          io.local.forgetId = id, io.go("forget");
        } })
      )
    ]
  });
}
function settingsNotify(ctx, io) {
  let vm = ctx.vm, push = vm.push, approve = vm.approve, pushRows = PUSH_SWITCHES.map((sw) => {
    let key = sw.key, label = sw.key === "onlyWhenAway" ? fill(sw.label, ctx.computer) : sw.label, note = key === "firstLine" ? PHONE_PUSH_TEXT : null;
    return switchRow({
      label,
      checked: push[key] === !0,
      note,
      id: `sh-push-${key}`,
      onChange: (value) => io.act.setPush(key, value)
    });
  }), approveRow = approve.visible ? switchRow({
    label: NOTIFY_APPROVE_ROW,
    checked: approve.checked,
    disabled: !approve.enabled,
    note: approve.enabled ? null : APPROVE_MISSING_TEXT[approve.missing] ?? null,
    id: "sh-approve",
    onChange: (value) => io.act.setApprove(value)
  }) : null, notes = [
    para(fill(APPROVE_NOTIFY_TEXT, ctx.computer), "sh-note"),
    para(APPROVE_BLOCKED_TEXT, "sh-help")
  ], up = vm.unifiedPush, androidLine = up ? para(unifiedPushLine(up.distributor ?? null), "sh-note") : null, chooseApp = up?.supported ? button("Choose app", { kind: "ghost", onClick: () => io.act.chooseDistributor() }) : null;
  return frame(ctx, io, {
    title: NOTIFY_TITLE,
    back: !0,
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
  let vm = ctx.vm, on = vm.lock.mode !== "off", web = ctx.platform === "web";
  return frame(ctx, io, {
    title: LOCK_TITLE,
    back: !0,
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
          let result = await io.act.lockOn("biometric");
          io.local.lockNote = result?.ok ? null : "Plenum did not turn the app lock on. Try again.", io.repaint();
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
        let r = await io.act.lockOn("passkey");
        io.local.lockNote = r?.ok ? null : "A passkey could not be set up here.", io.repaint();
      } }) : null
    ]
  });
}
function phoneLockOff(ctx, io) {
  let input = ctx.vm.lock.mode === "pin" ? el("input", { class: "sh-input", id: "sh-pin-off", type: "password", inputmode: "numeric", autocomplete: "off", maxlength: "6", "aria-label": "PIN" }) : null;
  return frame(ctx, io, {
    title: LOCK_OFF_TITLE,
    back: !0,
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
          let result = await io.act.lockOff(input ? String(input.value ?? "") : null);
          if (result?.ok) {
            io.local.lockNote = null, io.go("settings-lock");
            return;
          }
          io.local.lockNote = result?.reason === "pin" ? "That PIN is not right." : "Plenum did not turn the lock off. Try again.", io.repaint();
        }
      })
    ]
  });
}
function pinSet(ctx, io) {
  let state = io.local.pinSet ?? (io.local.pinSet = { first: null, digits: "", note: null }), dots = Array.from({ length: 6 }, () => el("span", { class: "sh-dot", "aria-hidden": "true" })), counter = el("span", { class: "sh-sr", "aria-live": "polite" }, "0 of 6 digits entered"), message = el("p", { class: "sh-msg", role: "alert", id: "sh-pin-set-msg" }, state.note ?? null), draw = () => {
    dots.forEach((dot, i) => {
      i < state.digits.length ? dot.setAttribute("data-on", "") : dot.removeAttribute("data-on");
    }), counter.textContent = `${state.digits.length} of 6 digits entered`;
  }, press = async (key) => {
    if (key === "Delete") {
      state.digits = state.digits.slice(0, -1), draw();
      return;
    }
    if (state.digits.length >= 6 || (state.digits += key, draw(), state.digits.length < 6)) return;
    let entered = state.digits;
    if (state.digits = "", draw(), state.first === null) {
      state.first = entered, state.note = "Enter the same PIN again.", io.repaint();
      return;
    }
    if (entered !== state.first) {
      state.first = null, state.note = "The two PINs did not match. Start again.", io.repaint();
      return;
    }
    let result = await io.act.setPin(entered);
    if (state.first = null, result?.ok) {
      state.note = null, io.afterPin();
      return;
    }
    state.note = result?.reason === "mode" ? "The lock is already on." : "That PIN is not valid. Use six digits.", io.repaint();
  }, pad = el(
    "div",
    { class: "sh-pad", role: "group", "aria-label": "PIN" },
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"].map((key) => key === null ? el("span", { class: "sh-key-gap", "aria-hidden": "true" }) : el("button", {
      type: "button",
      class: key === "Delete" ? "sh-key sh-key-del" : "sh-key",
      "aria-label": key === "Delete" ? "Delete" : key,
      on: { click: () => {
        press(key);
      } }
    }, key === "Delete" ? "Delete" : key))
  );
  return draw(), frame(ctx, io, {
    title: state.first === null ? "Set a PIN" : "Enter the PIN again",
    back: !0,
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
  let vm = ctx.vm, prefs = vm.prefs, following = prefs.textSize == null, slider = el("input", {
    class: "sh-range",
    type: "range",
    min: String(TEXT_MIN),
    max: String(TEXT_MAX),
    step: String(TEXT_STEP),
    value: String(prefs.textSize ?? TEXT_DEFAULT),
    "aria-label": "Text size",
    "aria-valuetext": `${prefs.textSize ?? TEXT_DEFAULT} percent`,
    on: { input: (event) => {
      io.act.setPref({ textSize: Number(event.target.value) }, { quiet: !0 });
    } }
  });
  return frame(ctx, io, {
    title: APPEARANCE_TITLE,
    back: !0,
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
  let where = dictation.onDevice ? "on this phone" : "through the phone's speech service", mic = dictation.permission === "denied" ? " The microphone is off for Plenum: allow it in the phone's Settings." : "";
  return `Dictation is available ${where}.${mic}`;
}
function settingsDictation(ctx, io) {
  let prefs = ctx.vm.prefs, native = ctx.vm.native;
  return frame(ctx, io, {
    title: DICTATION_TITLE,
    back: !0,
    body: native ? [
      el("p", { class: "sh-note", id: "sh-dict-status", role: "status", text: dictationStatus(ctx.vm.dictation) }),
      switchRow({ label: DICTATION_PREFER, checked: prefs.dictationOnDevice, id: "sh-dict-device", onChange: (value) => io.act.setPref({ dictationOnDevice: value }) }),
      switchRow({ label: DICTATION_ALLOW, checked: prefs.dictationAllowService, id: "sh-dict-service", note: DICTATION_ALLOW_TEXT, onChange: (value) => io.act.setPref({ dictationAllowService: value }) }),
      el("p", { class: "sh-msg sh-info", role: "note", text: PHONE_VOICE })
    ] : [para(DICTATION_WEB, "sh-note")]
  });
}
function debug(ctx, io) {
  let lines = ctx.vm.debug.lines, rows = lines.map((line) => el(
    "li",
    { class: `sh-log sh-log-${line.level}` },
    el("span", { class: "sh-log-time", text: line.time }),
    el("span", { class: "sh-log-text", text: line.text })
  ));
  return frame(ctx, io, {
    title: DEBUG_TITLE,
    back: !0,
    body: [
      para(DEBUG_LEAD, "sh-help"),
      lines.length ? el("ol", { class: "sh-logs", role: "log", "aria-label": DEBUG_TITLE, "aria-live": "off" }, rows) : para(DEBUG_EMPTY, "sh-note"),
      msgNode(io.local.debugNote ?? null)
    ],
    actions: [
      button(DEBUG_CLEAR, { kind: "ghost", onClick: () => {
        io.act.debugClear(), io.local.debugNote = null;
      } }),
      button(DEBUG_COPY, { kind: "ghost", onClick: () => io.act.debugCopy(lines.map((l) => `${l.time} ${l.text}`).join(`
`)) }),
      button(fill(DEBUG_SEND, ctx.computer), { kind: "primary", onClick: () => io.act.debugSend() })
    ]
  });
}
function about(ctx, io) {
  let a = ctx.vm.about, lines = [
    fillMany(ABOUT_APP, { version: a.appVersion || "0.0.0" }),
    a.desktopVersion ? fillMany(ABOUT_COMPUTER, { computer: ctx.computer, version: a.desktopVersion }) : ABOUT_NOT_CONNECTED,
    fillMany(ABOUT_LINK, { version: a.protocol || "1.0" }),
    a.screensLoaded ? fillMany(ABOUT_SCREENS_LOADED, { computer: ctx.computer, n: a.screensLoaded }) : ABOUT_SCREENS_BUILT,
    a.since ? fillMany(ABOUT_CONNECTED, { carrier: a.carrierLabel ?? "this network", when: a.since }) : null,
    a.newerUi ? fill(ABOUT_NEWER_UI, ctx.computer) : null
  ];
  return frame(ctx, io, {
    title: ABOUT_TITLE,
    back: !0,
    body: [el("ul", { class: "sh-about" }, lines.filter(Boolean).map((text) => el("li", { text })))]
  });
}
function legal(ctx, io) {
  let rows = Object.entries(LEGAL_ROWS).map(([name, label]) => row(label, null, () => io.act.openLegal(name)));
  return frame(ctx, io, {
    title: LEGAL_TITLE,
    back: !0,
    body: [
      el("div", { class: "sh-rows" }, rows),
      msgNode(io.local.legalNote ?? null),
      ctx.vm.connected.id ? para(fill(LEGAL_VERSIONS, ctx.computer), "sh-help") : null
    ]
  });
}
function demoHome(ctx, io) {
  let d = ctx.vm.demo, waiting = d.approvals.filter((a) => a.state === "waiting"), runRows = d.runs.map((r) => el(
    "li",
    { class: `sh-run sh-run-${r.state}` },
    el("span", { class: "sh-run-title", text: r.title }),
    el("span", { class: "sh-run-meta", text: `${r.project} \xB7 ${RUN_WORD[r.state] ?? r.state}${r.waitingFor === "approval" ? " \xB7 waiting for you" : ""}` })
  )), cards = waiting.map((card) => el(
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
  )), agents = d.agents.map((a) => el("p", { class: "sh-help", text: `${a.name}: ${a.state}` }));
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
  let drive = ctx.vm.demo.drive;
  if (!drive) return frame(ctx, io, { title: DEMO_RUN_LABEL, back: !0, body: [para(DEMO_EMPTY, "sh-note")] });
  let frames = (drive.frames ?? []).map((f, i) => el(
    "figure",
    { class: "sh-frame" },
    f.src ? el("img", { class: "sh-picture", src: f.src, alt: f.caption, width: "360", height: "220" }) : null,
    el("figcaption", { class: "sh-help", text: `${i + 1}. ${f.caption}` })
  )), stateWord = drive.state === "driving" ? "A model is driving" : "Stopped";
  return frame(ctx, io, {
    title: DEMO_RUN_LABEL,
    back: !0,
    body: [
      para(`${stateWord} ${ctx.computer}: ${drive.app}, step ${drive.step} of ${drive.of}.`, "sh-note"),
      el("div", { class: "sh-frames" }, frames)
    ]
  });
}
function demoDiff(ctx, io) {
  let diff = ctx.vm.demo.diff;
  if (!diff) return frame(ctx, io, { title: DEMO_DIFF_LABEL, back: !0, body: [para(DEMO_EMPTY, "sh-note")] });
  let hunks = (diff.hunks ?? []).map((h) => el(
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
    back: !0,
    body: [
      el("p", { class: "sh-note", text: `${diff.file} \xB7 +${diff.added} \u2212${diff.removed}` }),
      hunks
    ]
  });
}
function demoArtifact(ctx, io) {
  let list = ctx.vm.demo.artifacts;
  return frame(ctx, io, {
    title: DEMO_ARTIFACT_LABEL,
    back: !0,
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
}), PART2_SCREEN_BUILDERS = PART2_BUILDERS;
function renderPart2(id, ctx, io) {
  let build = PART2_BUILDERS[id];
  return build ? build({ ...ctx, id }, io) : null;
}

// mobile/shell/screens/main.js
var LOCK_IDS = Object.freeze(["lock-bio", "lock-pin"]), NOT_A_FAILED_CHECK = Object.freeze(["cancelled", "mode", "unavailable"]), NAV_IDS = Object.freeze([...PART2_IDS, "pin-set"]), SCAN_FAILED = "The camera could not read a code. Hold it steady, or paste the link instead.", DEV_BUILD = !1;
function screensDebugOn(params, devBuild = DEV_BUILD) {
  return devBuild === !0 && (params.get("demo") === "1" || params.get("debug") === "1");
}
async function scanWithBrowser(env, getVideo, register, { interval = 250 } = {}) {
  let videoNow = () => typeof getVideo == "function" ? getVideo() : getVideo, Detector = env.BarcodeDetector, media = env.navigator?.mediaDevices;
  if (typeof Detector != "function" || typeof media?.getUserMedia != "function") return { ok: !1, reason: "unavailable" };
  let stream = null, timer = null, stopped = !1, stop = () => {
    stopped = !0, timer !== null && env.clearTimeout(timer), timer = null;
    for (let track of stream?.getTracks?.() ?? []) track.stop?.();
    stream = null;
    let shown2 = videoNow();
    shown2 && (shown2.srcObject = null);
  };
  register(stop);
  try {
    stream = await media.getUserMedia({ video: { facingMode: "environment" }, audio: !1 });
  } catch (err) {
    return stop(), { ok: !1, reason: /NotAllowed|Permission|Security/i.test(String(err?.name ?? err)) ? "denied" : "failed" };
  }
  if (stopped)
    return stop(), { ok: !1, reason: "cancelled" };
  let shown = videoNow();
  shown && (shown.srcObject = stream, shown.play?.().catch?.(() => {
  }));
  let detector;
  try {
    detector = new Detector({ formats: ["qr_code"] });
  } catch {
    return stop(), { ok: !1, reason: "unavailable" };
  }
  return new Promise((resolve) => {
    let look = async () => {
      if (stopped) {
        resolve({ ok: !1, reason: "cancelled" });
        return;
      }
      try {
        let text = (await detector.detect(videoNow()))?.find?.((c) => typeof c?.rawValue == "string" && c.rawValue)?.rawValue;
        if (text) {
          stop(), resolve({ ok: !0, text });
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
  flag ? node.setAttribute("hidden", "") : node.removeAttribute("hidden");
}
function applyTheme(doc2, theme) {
  let root = doc2.documentElement;
  theme === "dark" || theme === "light" ? root.setAttribute("data-theme", theme) : root.removeAttribute("data-theme");
}
function signatureOf(ctx) {
  let { countdown, stripInfo, stopState, stopText, carrierLabel, ...rest } = ctx;
  return JSON.stringify(LOCK_IDS.includes(ctx.id) ? { ...rest, stopText } : rest);
}
function lockMessage(method, result) {
  return method === "pin" || result?.ok === !0 || NOT_A_FAILED_CHECK.includes(result?.reason) ? null : LOCK_FAILED;
}
function hhmmss(ms) {
  let d = new Date(Number(ms) || 0), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
var MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
function seenText(ms) {
  let d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clockTime(ms)}`;
}
function installHint(env = globalThis) {
  if (platformOf(env) !== "web" || lanPage(env) || String(env.location?.protocol ?? "") !== "https:" || env.matchMedia?.("(display-mode: standalone)")?.matches === !0 || env.navigator?.standalone === !0) return null;
  let ua = String(env.navigator?.userAgent ?? "");
  return /iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : null;
}
function buildVm(s, nav, env, core = null) {
  let platform = platformOf(env), native = platform !== "web", ua = String(env.navigator?.userAgent ?? ""), iosWeb = !native && /iPhone|iPad|iPod/.test(ua), prefs = s?.prefs ?? normalisePrefs(null), hello = s?.hello ?? null, conn = s?.connection ?? {}, lockMode = s?.lock?.mode ?? "off", push = pushValues(s?.pushKnown ?? null), approveRule = approveSwitch({ tier: hello?.tier ?? "full", firstLine: push.firstLine, lockMode, native }), approve = { ...approveRule, checked: approveChecked(s?.approveStored, approveRule) }, computers2 = (s?.computers ?? []).map((c) => {
    let active = c.id === s.activeId, connected2 = active && conn.status === "connected" && !!hello;
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
      version: active && hello?.desktopVersion || null,
      carrierOrder: (Array.isArray(c.carriers) ? c.carriers : []).map((x) => x.kind),
      ways: (Array.isArray(c.carriers) ? c.carriers : []).map((x) => x.kind),
      waysDetail: null
    };
  }), since = conn.since ? clockTime(conn.since) : null, connectedCarrier = CARRIER_LABEL[conn.carrier] ?? null, perm = core?.notificationPermission?.() ?? "unknown", lockLabel = lockMode === "biometric" ? biometricName(platform) : lockMode === "pin" ? "PIN" : lockMode === "passkey" ? "passkey" : "Off", debugLines = core?.debug?.lines?.() ?? [], demo = s?.demo ?? { computer: { name: "Demo computer" }, projects: [], runs: [], approvals: [], agents: [], drive: null, diff: null, artifacts: [] };
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
      newerUi: !1
    },
    notify: { label: NOTIFY_PERMISSION[perm] ?? NOTIFY_PERMISSION.unknown, hint: perm === "denied" ? NOTIFY_DENIED_HINT : null },
    lock: { mode: lockMode, label: lockLabel, failures: Number(s?.lock?.failures) || 0, waitSec: Number(s?.lock?.waitSec) || 0, prefs: null },
    prefs,
    push,
    approve,
    haptics: { visible: !iosWeb },
    unifiedPush: platform === "android" ? { supported: s?.androidPush?.supported === !0, distributor: s?.androidPush?.distributor ?? null, registered: s?.androidPush?.registered === !0, failure: s?.androidPush?.failure ?? null } : null,
    dictation: native ? { available: s?.dictation?.available === !0, onDevice: s?.dictation?.onDevice === !0, permission: s?.dictation?.permission ?? "prompt", known: !!s?.dictation } : null,
    debug: { lines: debugLines.slice(-500).map((l) => ({ level: l.level ?? "info", time: hhmmss(l.at), text: String(l.text ?? "") })) },
    demo,
    replay: !!s?.demo
  };
}
function mountScreens(env = globalThis) {
  let doc2 = env.document;
  if (!doc2?.body) return null;
  setDocument(doc2);
  let params = new URLSearchParams(env.location?.search ?? ""), demoParam = params.get("demo") === "1", screenParam = params.get("screen"), fixtureMode = DEV_BUILD && demoParam && SCREEN_IDS.includes(screenParam), replayMode = demoParam && !fixtureMode, debug2 = screensDebugOn(params, DEV_BUILD);
  applyTheme(doc2, params.get("theme")), doc2.documentElement.setAttribute("data-shell-page", "");
  let nav = {
    screen: null,
    forced: null,
    pairingCancelled: !1,
    dismissedKey: null,
    lastDriving: null,
    onboarding: null,
    codeSince: null,
    codeExpired: !1,
    uiState: null,
    consentGiven: !1,
    progress: null,
    uiCause: "checksum",
    hasCopy: !1,
    local: {},
    stack: []
  };
  replayMode && NAV_IDS.includes(screenParam) && (nav.screen = screenParam);
  let demoId = fixtureMode ? screenParam ?? "welcome" : null, demoOverrides = {}, clockOffset = 0, core = null, coreKnown = !1, snapshot = null, lastId = null, lastSig = "", unsubscribe = null, deferredInstall = null, scanning = !1, scanStop = null, stopScan = () => {
    scanning = !1;
    let stop2 = scanStop;
    scanStop = null, stop2?.();
  }, timers = /* @__PURE__ */ new Set(), now = () => Date.now() + clockOffset, later = (fn, ms) => {
    let t = env.setTimeout(() => {
      timers.delete(t), fn();
    }, ms);
    return timers.add(t), t;
  }, stateKeyNow = () => stateKey(snapshot), host = doc2.getElementById("sh-app") ?? doc2.body.appendChild(el("div", { id: "sh-app" })), demoStrip = el(
    "div",
    { id: "plenum-demo-strip", class: "plenum-demo-strip", role: "status", hidden: !0 },
    el("span", { class: "plenum-demo-text", text: DEMO_STRIP }),
    el("button", { type: "button", class: "sh-link plenum-demo-exit", on: { click: () => actions.exitDemo() } }, DEMO_EXIT)
  ), lanStrip = el(
    "div",
    { id: "plenum-lan-strip", class: "plenum-lan-strip", role: "status", hidden: !0 },
    el("span", { class: "plenum-lan-text" }),
    el("button", { type: "button", class: "sh-link plenum-lan-got", on: { click: () => actions.dismissLan() } }, "Got it")
  ), strip = el(
    "div",
    { id: "plenum-conn-strip", class: "plenum-conn-strip", role: "status", hidden: !0 },
    el("span", { class: "plenum-conn-text" })
  ), view = el("div", { id: "sh-view", class: "sh-view" }), stripStack = el("div", { id: "plenum-strips", class: "plenum-strips", hidden: !0 }, demoStrip, lanStrip, strip);
  host.replaceChildren(stripStack, view);
  let stop = el(
    "button",
    {
      id: "plenum-stop",
      class: "plenum-stop",
      type: "button",
      "aria-label": "Stop everything on your computer",
      hidden: !0,
      on: { click: () => {
        actions.stop();
      } }
    },
    el("span", { class: "plenum-stop-mark", "aria-hidden": "true" }),
    el("span", { class: "plenum-stop-label", text: "Stop" }),
    el("span", { class: "plenum-stop-note", role: "status" })
  );
  doc2.body.appendChild(stop);
  let toast = el(
    "div",
    { id: "plenum-toast", class: "plenum-toast", role: "status", hidden: !0 },
    el("span", { class: "plenum-toast-text" }),
    el("button", { type: "button", class: "sh-link plenum-toast-close", on: { click: () => actions.dismissToast() } }, "Close")
  ), sheet = el(
    "div",
    {
      id: "plenum-stop-sheet",
      class: "plenum-stop-sheet",
      role: "alertdialog",
      "aria-labelledby": "plenum-stop-sheet-title",
      "aria-describedby": "plenum-stop-sheet-body",
      hidden: !0
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
  let TOAST_MS = 6e3;
  function updateNotices() {
    if (fixtureMode) {
      setHidden(toast, !0), setHidden(sheet, !0);
      return;
    }
    let note = snapshot?.notice ?? null;
    note && note.seq !== nav.local.noticeSeq && (nav.local.noticeSeq = note.seq, nav.local.noticeAt = now());
    let stopState = snapshot?.stop?.state ?? "idle", open = !!note && nav.local.noticeClosed !== note.seq, fresh = open && now() - (nav.local.noticeAt ?? 0) < TOAST_MS, waiting = open && note.tone === "warn" && stopState === "queued", showToast = fresh || waiting;
    setHidden(toast, !showToast), showToast && (toast.querySelector(".plenum-toast-text").textContent = note.text, toast.setAttribute("data-tone", note.tone ?? "info"));
    let st = snapshot?.stop ?? null;
    setHidden(sheet, !(st?.state === "failed" && nav.local.sheetClosed !== st.seq));
  }
  function focusTitle() {
    let title = doc2.getElementById("sh-title");
    title && title.focus({ preventScroll: !0 });
  }
  function showStartFailed() {
    lastId !== "start-failed" && (view.replaceChildren(el(
      "div",
      { class: "sh-screen sh-center", "data-screen": "start-failed" },
      el("main", { class: "sh-main", id: "sh-main" }, el("p", { class: "sh-note", text: START_FAILED }))
    )), doc2.body.setAttribute("data-screen", "start-failed"), lastId = "start-failed", lastSig = "");
  }
  function fallbackId(s) {
    return nav.screen === "computers" ? "computers" : replayMode ? "demo-home" : s.activeId && s.connection?.status === "connected" && s.hello ? "connected" : s.computers?.length ? "computers" : null;
  }
  function applyPrefs(s) {
    if (fixtureMode || !s?.prefs) return;
    let p = s.prefs;
    params.get("theme") || (p.theme === "dark" || p.theme === "light" ? applyTheme(doc2, p.theme) : applyTheme(doc2, null)), doc2.documentElement.setAttribute("data-stop-side", p.stopSide === "left" ? "left" : "right");
    let scale = p.textSize == null ? 1 : p.textSize / 100;
    doc2.documentElement.style?.setProperty?.("--text-scale", String(scale));
  }
  function paint() {
    if (!fixtureMode && (snapshot = core ? core.state() : null, coreKnown && !core)) {
      showStartFailed();
      return;
    }
    if (!fixtureMode && snapshot) {
      snapshot.paired && snapshot.paired.seq > (nav.pairedSeq ?? 0) && (nav.pairedSeq = snapshot.paired.seq, nav.onboarding = lanPage(env) ? ["paired-lock"] : ["paired-lock", "paired-notify"]), snapshot.hello && (nav.lastDriving = snapshot.hello.pending?.driving ?? null), snapshot.hello && snapshot.activeId && (nav.wasConnected = snapshot.activeId), snapshot.activeId || (nav.lastDriving = null), nav.pairingCancelled && snapshot.pairing?.state !== "confirm" && (nav.pairingCancelled = !1);
      let request = snapshot.screenRequest ?? null;
      !snapshot.locked && request?.seq > (nav.screenSeq ?? 0) && (nav.screenSeq = request.seq, nav.stack = [], nav.screen = request.screen, nav.dismissedKey = null), applyPrefs(snapshot);
    }
    let showingCode = fixtureMode ? demoId === "code" : snapshot?.pairing?.state === "confirm" && !nav.pairingCancelled;
    showingCode ? (nav.codeSince == null && (nav.codeSince = now()), codeSecondsLeft(nav.codeSince, now()) === 0 && (nav.codeExpired = !0)) : (nav.codeSince = null, nav.codeExpired = !1, fixtureMode || (nav.forced = null));
    let id;
    fixtureMode ? (id = demoId, id === "code" && nav.codeExpired && (id = "expired")) : snapshot?.locked || !snapshot ? id = screenFor(snapshot, nav) : nav.screen === "pin-set" ? id = "pin-set" : id = screenFor(snapshot, nav) ?? fallbackId(snapshot);
    let ctx = fixtureMode ? fixtureCtx(id, demoOverrides) : ctxFor(snapshot, nav, env);
    if (!ctx) return;
    let isPart2 = PART2_SCREEN_BUILDERS[id] !== void 0;
    if (isPart2 && !snapshot) return;
    if (ctx.id = id, id !== "scan" && scanning && stopScan(), fixtureMode || (ctx.cameraDenied = !!nav.local.cameraDenied), ctx.countdown = showingCode ? codeSecondsLeft(nav.codeSince, now()) : null, id === "failed" && (ctx.stripInfo = null), ctx.bioMessage = nav.local.bioMessage ?? null, ctx.linkMessage = nav.local.linkMessage ?? null, ctx.onboardMessage = nav.local.onboardMessage ?? null, ctx.notifyNote = nav.local.notifyNote ?? null, ctx.install = fixtureMode ? null : installHint(env), ctx.vm = fixtureMode ? null : buildVm(snapshot, nav, env, core), updateChrome(ctx, id), !id) {
      view.replaceChildren(), lastId = null, lastSig = "", doc2.body.removeAttribute("data-screen");
      return;
    }
    let sig = `${id}|${signatureOf(ctx)}`;
    if (sig === lastSig && id === lastId) {
      let cd = view.querySelector("[data-countdown]");
      cd && ctx.countdown != null && (cd.textContent = clock(ctx.countdown));
      return;
    }
    for (let t of timers) env.clearTimeout(t);
    timers.clear();
    let node = isPart2 ? renderPart2(id, { ...ctx, id }, io) : renderScreen(id, { ...ctx, id }, io);
    node && view.replaceChildren(node), id !== lastId && focusTitle(), lastId = id, lastSig = sig, doc2.body.setAttribute("data-screen", id);
  }
  function updateChrome(ctx, id) {
    let locked = fixtureMode ? LOCK_IDS.includes(id) : !!snapshot?.locked, showStop = (fixtureMode ? !!ctx.session : !!snapshot?.activeId) && !locked;
    setHidden(stop, !showStop);
    let computer = ctx.computer || "your computer";
    stop.setAttribute("aria-label", `Stop everything on ${computer}`);
    let state = fixtureMode ? ctx.stopState : snapshot?.stop?.state ?? "idle";
    stop.setAttribute("data-state", state), state === "sending" ? stop.setAttribute("aria-busy", "true") : stop.removeAttribute("aria-busy");
    let driving = ctx.driving ?? drivingText(snapshot?.hello?.pending?.driving);
    driving ? (stop.setAttribute("data-driving", ""), stop.setAttribute("aria-description", `A model is driving: ${driving}`)) : (stop.removeAttribute("data-driving"), stop.removeAttribute("aria-description")), ctx.pending?.runs > 0 || driving || state === "sending" ? stop.setAttribute("data-active", "") : stop.removeAttribute("data-active"), stop.querySelector(".plenum-stop-label").textContent = STOP_LABEL[state] ?? "Stop", stop.querySelector(".plenum-stop-note").textContent = (fixtureMode ? ctx.stopText : snapshot?.stop?.text) || "", updateNotices(), setHidden(demoStrip, !replayMode);
    let lanOn = !fixtureMode && !!ctx.lan && snapshot?.prefs?.lanDismissed !== !0;
    setHidden(lanStrip, !lanOn), lanOn && (lanStrip.querySelector(".plenum-lan-text").textContent = fill2(LAN_WEB_STRIP, computer));
    let info = ctx.stripInfo ?? null;
    setHidden(strip, !info), info && (strip.querySelector(".plenum-conn-text").textContent = info.text, info.tone === "warn" || info.tone === "bad" ? strip.setAttribute("data-tone", info.tone) : strip.removeAttribute("data-tone"));
    let stacked = replayMode || lanOn || !!info;
    setHidden(stripStack, !stacked), stacked ? host.setAttribute("data-strips", "") : host.removeAttribute("data-strips");
  }
  let fill2 = (text, computer) => fillName(text, computer);
  function openFromScreen(result, failText) {
    return nav.local.linkMessage = result.ok ? null : failText, paint(), result;
  }
  function coreCall(name, ...args) {
    return call(core, name, ...args);
  }
  let actions = {
    stop: () => {
      fixtureMode || core?.stop?.();
    },
    // The sheet's Try again sends the Stop again; the sheet closes when the next result comes.
    retryStop: () => {
      fixtureMode || core?.stop?.();
    },
    dismissStopSheet: () => {
      snapshot?.stop && (nav.local.sheetClosed = snapshot.stop.seq), paint();
    },
    dismissToast: () => {
      snapshot?.notice && (nav.local.noticeClosed = snapshot.notice.seq), paint();
    },
    // Locks the app now (Settings and the lock screen use it): the channel closes and the keys leave memory, as the core does.
    lockNow: async () => {
      if (fixtureMode || !core?.lockNow) return { ok: !1, reason: "unavailable" };
      let out = await core.lockNow();
      return paint(), { ok: out?.ok === !0, reason: out?.reason ?? null };
    },
    tryDemo: () => {
      env.location?.assign?.(`${env.location.pathname}?demo=1`);
    },
    exitDemo: () => {
      env.location?.assign?.(String(env.location?.pathname ?? "/"));
    },
    consent: (value) => {
      nav.consentGiven = !!value;
    },
    pair: async (text) => {
      if (fixtureMode) return null;
      if (replayMode)
        return nav.local.linkMessage = DEMO_NO_PAIR, paint(), null;
      nav.screen = null, nav.pairingCancelled = !1, nav.dismissedKey = null;
      let name = cleanPhoneName(nav.local.phoneName, defaultPhoneName(platformOf(env))), final = await core?.pair?.(String(text ?? ""), { name });
      return final?.state === "allowed" && (nav.onboarding = lanPage(env) ? ["paired-lock"] : ["paired-lock", "paired-notify"]), paint(), final;
    },
    readClipboard: (setter) => {
      let clipboard = env.navigator?.clipboard;
      clipboard?.readText && clipboard.readText().then((text) => setter(String(text ?? "")), () => {
      });
    },
    // Phone settings that are not in the web shell's own reach show the manual path.
    openSettings: (section2) => {
      let result = openSettingsFlow(section2);
      return openFromScreen(result, SETTINGS_MANUAL);
    },
    openLegal: (name) => openFromScreen(openLinkFlow(env, LEGAL_LINKS[name] ?? null), LINK_UNAVAILABLE),
    openStore: () => openFromScreen(openLinkFlow(env, STORE_LINKS[platformOf(env)] ?? null), LINK_UNAVAILABLE),
    chooseComputer: () => {
      io.go("computers");
    },
    cancelConnect: async () => {
      await coreCall("cancelConnect"), nav.screen = null, nav.stack = [], nav.dismissedKey = stateKeyNow(), io.go("welcome");
    },
    continueLocalNet: () => {
    },
    retry: () => {
      if (replayMode || !core) return;
      let s = core.state();
      if (s.ui?.state === "failed" && s.hello) {
        core.showUi?.({ force: !0 });
        return;
      }
      let id = s.activeId ?? s.computers[0]?.id;
      id && core.connect(id);
    },
    // "Open Plenum" on the shell's own page (/?shell): the computer's UI is pulled and the page goes to it.
    openUi: () => {
      !fixtureMode && !replayMode && core?.showUi?.({ force: !0 });
    },
    // "The codes do not match": the pairing is cancelled (a CLOSE goes to the computer), and the screen says it stopped.
    mismatch: async () => {
      if (fixtureMode) {
        io.go("mismatch");
        return;
      }
      nav.pairingCancelled = !0, nav.screen = "mismatch", nav.dismissedKey = null, paint(), await coreCall("cancelPairing"), paint();
    },
    enableLock: async (mode) => fixtureMode ? { ok: !0, reason: null } : enableLockFlow(core, mode),
    enableNotifications: async () => {
      if (fixtureMode) return { ok: !0, reason: null };
      let out = await enableNotificationsFlow(core);
      return nav.local.notifyNote = out?.reason === "other-computer" ? PUSH_OTHER_COMPUTER : null, paint(), out;
    },
    unlock: async (method, arg = null) => {
      if (fixtureMode || !core) return { ok: !1, reason: "demo" };
      let result = await unlockFlow(core, method, arg);
      return method !== "pin" && (nav.local.bioMessage = lockMessage(method, result), paint()), result;
    },
    // Unlocks with the method the lock uses, then stops everything (the stop is sent only after the unlock worked).
    unlockAndStop: async (method = "biometric") => {
      if (fixtureMode || !core) return;
      let result = await unlockAndStopFlow(core, method);
      nav.local.bioMessage = lockMessage(method, result), paint();
    },
    // The pairing link that waits for review (D5): Pair starts it, Cancel drops it (C6c).
    confirmPair: async () => {
      await call(core, "confirmPair"), paint();
    },
    cancelPair: async () => {
      await call(core, "cancelPairing"), paint();
    },
    // Stop from a lock screen: sent without unlocking when this phone holds the computer's Stop key (C6c, C6f).
    stopLocked: async () => {
      await call(core, "stop"), paint();
    },
    forgetActive: async () => {
      if (fixtureMode || !core) return;
      let id = core.state().activeId;
      id && await forgetFlow(core, id), paint();
    },
    sendLog: () => {
      fixtureMode || !core?.channel || core.debug?.sendToComputer?.(core.channel.request, 60);
    },
    // "Use the copy in this app" on the failed-screens screen: the UI that is already on the phone.
    useCopy: () => {
      !fixtureMode && !replayMode && core?.useCopy?.();
    },
    // ---- scanning (M7) ----
    // The pairing code is scanned with the phone's camera: the native apps use the scanner plugin (its own full-screen camera); the web
    // page uses the browser's BarcodeDetector over getUserMedia where both exist, and otherwise sends the person to the paste screen.
    // A denied camera is the scan-denied screen. Whatever is read goes to pair(), as a pasted link does.
    startScan: async (videoArg) => {
      if (fixtureMode || replayMode || scanning) return;
      scanning = !0, nav.local.cameraDenied = !1, nav.local.scanNote = null;
      let done = async (result) => {
        if (scanning = !1, stopScan(), result.ok) {
          await actions.pair(result.text);
          return;
        }
        result.reason === "denied" ? nav.local.cameraDenied = !0 : result.reason === "cancelled" ? (nav.screen = nav.stack.length ? nav.stack.pop() : null, nav.dismissedKey = null) : result.reason === "unavailable" ? (nav.screen = "paste", nav.local.linkMessage = null) : nav.local.scanNote = SCAN_FAILED, paint();
      };
      if (platformOf(env) !== "web") {
        done(await (core?.scan?.() ?? { ok: !1, reason: "unavailable" }));
        return;
      }
      done(await scanWithBrowser(env, () => view.querySelector(".sh-video") ?? videoArg, (stop2) => {
        scanStop = stop2;
      }));
    },
    // ---- wave 107: computers, phone settings and the demo ----
    connect: async (id) => {
      if (replayMode)
        return io.go(null), { ok: !0, reason: null };
      let result = await coreCall("connect", id);
      return result.ok && (nav.screen = null, nav.stack = []), paint(), result;
    },
    rename: async (id, name) => replayMode ? { ok: !1, reason: "demo" } : coreCall("rename", id, name),
    forget: async (id) => replayMode ? { ok: !1, reason: "demo" } : forgetFlow(core, id),
    moveWay: async (id, kind, dir) => replayMode ? { ok: !1, reason: "demo" } : coreCall("moveWay", id, kind, dir),
    testWays: async (id) => {
      if (replayMode) return { ok: !1, reason: "demo" };
      let out = await coreCall("testWays", id);
      return nav.local.waysNote = out?.reason === "connected" ? WAYS_CONNECTED(WAYS_CARRIER[out.carrier] ?? "a way") : out?.ok === !0 ? WAYS_TRYING : null, paint(), out;
    },
    setPush: async (key, value) => {
      let patch = pushPatch(key, value, snapshot?.approveStored === !0);
      return coreCall("setPush", patch);
    },
    setApprove: async (value) => coreCall("setApprove", value === !0),
    testPush: async () => coreCall("testPush"),
    // Android: the system chooser for the push app UnifiedPush goes through (the settings line shows which one is chosen).
    chooseDistributor: async () => {
      let out = await coreCall("chooseDistributor");
      return nav.local.notifyNote = out.ok ? null : unifiedPushLine(null), paint(), out;
    },
    lockOn: async (mode) => fixtureMode ? { ok: !0, reason: null } : enableLockFlow(core, mode),
    lockOff: async (pin) => coreCall("lockOff", pin),
    setPin: async (pin) => coreCall("setPin", pin),
    afterPin: () => {
      nav.screen = nav.stack.length ? nav.stack.pop() : null, nav.onboarding?.length ? io.advance() : paint();
    },
    setPref: async (patch) => fixtureMode ? { ok: !0, reason: null } : coreCall("setPrefs", patch),
    installApp: async () => {
      if (!deferredInstall)
        return nav.local.installNote = INSTALL_NO_PROMPT, paint(), { ok: !1, reason: "unavailable" };
      try {
        deferredInstall.prompt();
        let choice = await deferredInstall.userChoice;
        return deferredInstall = null, nav.local.installNote = (choice?.outcome === "accepted", null), paint(), { ok: choice?.outcome === "accepted", reason: choice?.outcome ?? null };
      } catch {
        return nav.local.installNote = INSTALL_NO_PROMPT, paint(), { ok: !1, reason: "failed" };
      }
    },
    dismissLan: () => {
      fixtureMode || coreCall("setPrefs", { lanDismissed: !0 });
    },
    debugCopy: async (text) => {
      let clipboard = env.navigator?.clipboard;
      if (!clipboard?.writeText)
        nav.local.debugNote = DEBUG_NO_CLIPBOARD;
      else
        try {
          await clipboard.writeText(String(text ?? "")), nav.local.debugNote = DEBUG_COPIED;
        } catch {
          nav.local.debugNote = DEBUG_NO_CLIPBOARD;
        }
      paint();
    },
    debugSend: async () => {
      let result = fixtureMode || !core ? { ok: !1, n: 0 } : await coreCall("debugSend"), computer = snapshot?.hello?.desktopName || snapshot?.computers?.find((c) => c.id === snapshot?.activeId)?.name || "your computer";
      return nav.local.debugNote = result.ok ? fillMany(DEBUG_SENT, { n: result.n ?? 0, computer }) : fillName(DEBUG_SEND_FAILED, computer), paint(), result;
    },
    debugClear: () => {
      fixtureMode || coreCall("debugClear");
    },
    demoDecide: async (id, decision) => replayMode ? coreCall("demoDecide", id, decision) : { ok: !1, reason: "demo" },
    demoReset: () => {
      replayMode && coreCall("demoReset");
    }
  }, io = {
    local: nav.local,
    act: actions,
    later,
    go: (id) => {
      fixtureMode ? (demoOverrides = {}, nav.codeSince = null, nav.codeExpired = !1, demoId = id) : (nav.stack.push(nav.screen), nav.screen = id, nav.forced = null, nav.dismissedKey = stateKeyNow(), nav.local.linkMessage = null, nav.local.onboardMessage = null), paint();
    },
    back: () => {
      fixtureMode ? demoId = "welcome" : (nav.screen = nav.stack.length ? nav.stack.pop() : null, nav.dismissedKey = null, nav.local.linkMessage = null), paint();
    },
    advance: () => {
      nav.onboarding && nav.onboarding.shift(), nav.onboarding?.length || (nav.onboarding = null, core?.releaseUi?.()), nav.local.onboardMessage = null, paint();
    },
    repaint: () => paint()
  }, take = typeof env.__plenumTakeShellCore == "function" ? env.__plenumTakeShellCore : null, handed = take ? take.call(env) : null;
  return !fixtureMode && handed && typeof handed.then == "function" && handed.then(
    (answer) => {
      core = answer ?? null, coreKnown = !0, core && (unsubscribe = core.subscribe(() => paint())), paint();
    },
    () => {
      core = null, coreKnown = !0, paint();
    }
  ), env.addEventListener?.("plenum-back", (event) => {
    fixtureMode || (nav.stack.length || nav.screen) && (event.preventDefault?.(), io.back());
  }), env.addEventListener?.("beforeinstallprompt", (event) => {
    event.preventDefault?.(), deferredInstall = event, paint();
  }), doc2.addEventListener?.("visibilitychange", () => {
    snapshot?.prefs?.hideSwitcher === !0 && doc2.visibilityState === "hidden" ? doc2.documentElement.setAttribute("data-app-hidden", "") : doc2.documentElement.removeAttribute("data-app-hidden");
  }), env.setInterval(() => {
    paint();
  }, 1e3), env.addEventListener?.("online", () => paint()), env.addEventListener?.("offline", () => paint()), paint(), debug2 && (env.plenumScreensDebug = Object.freeze({
    ids: [...SCREEN_IDS, ...NAV_IDS],
    go(id, patch = {}) {
      return !SCREEN_IDS.includes(id) && !NAV_IDS.includes(id) ? !1 : (io.go(id), demoOverrides = { ...patch }, paint(), lastId);
    },
    setFixture(patch = {}) {
      return demoOverrides = { ...demoOverrides, ...patch }, paint(), lastId;
    },
    advance(ms) {
      return clockOffset += Number(ms) || 0, paint(), lastId;
    },
    current: () => lastId
  })), { paint, io, actions, nav, unsubscribe: () => unsubscribe?.() };
}
if (typeof document < "u" && typeof window < "u" && !globalThis.__PLENUM_SCREENS_NO_AUTOSTART__)
  try {
    mountScreens(globalThis);
  } catch (err) {
    console.error(String(err?.message ?? err));
  }
export {
  buildVm,
  installHint,
  mountScreens,
  scanWithBrowser,
  screensDebugOn
};
