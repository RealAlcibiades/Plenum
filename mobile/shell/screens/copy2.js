// The copy deck for the part 2 screens (mob-10, wave 107; MOBILE-UI 6.11, 6.12, 6.17, 6.18, 10 and 14.1). Every sentence the design gives
// is kept as written; a name is a parameter ({computer}). No exclamation marks, no emoji, sentence case. Plain text only: the screens
// put these strings in with textContent.

// The screens of part 2 (ids the router draws in addition to the 22 of part 1, copy.js SCREEN_IDS).
export const PART2_IDS = Object.freeze([
  'pair-review', 'computers', 'install-ios', 'install-android', 'lan-web', 'connected', 'rename', 'forget',
  'settings', 'settings-connection', 'settings-notify', 'settings-lock', 'phone-lock-off', 'settings-appearance', 'settings-dictation',
  'debug', 'about', 'legal',
  'demo-home', 'demo-run', 'demo-diff', 'demo-artifact',
]);

export const COMPUTERS_TITLE = 'Plenum';
export const COMPUTERS_LABEL = 'COMPUTERS';
export const PAIR_ANOTHER = 'Pair another computer';
export const ROW_MENU = Object.freeze({ connect: 'Connect', ways: 'Ways to reach it', rename: 'Rename on this phone', forget: 'Forget this computer' });
export const STATUS = Object.freeze({ online: 'Online', asleep: 'Asleep', unreachable: 'Not reachable' });

export const INSTALL_IOS_BODY = 'Add Plenum to your Home Screen for notifications and a full-screen app. Tap Share, then Add to Home Screen, then open Plenum from the Home Screen and pair there.';
export const INSTALL_IOS_STEPS = Object.freeze(['Tap Share.', 'Tap Add to Home Screen.', 'Open Plenum from the Home Screen.']);
export const INSTALL_IOS_PAIR_HERE = 'Pair in this tab, without notifications';
export const INSTALL_ANDROID_BODY = 'Install Plenum for notifications and a full-screen app.';
export const INSTALL_NO_PROMPT = 'This browser does not offer the install here. Use the browser menu and choose Install app.';
export const LAN_WEB_STRIP = "This page works only on {computer}'s network and cannot send notifications. It is sent without encryption, so someone on this network could change it. On a network you do not trust, use the Plenum app, Tailscale or your relay.";

// The pairing review (C6e, D5): a pairing link opened from outside the app waits here until the person taps Pair.
export const PAIR_REVIEW_TITLE = name => `Pair with ${name}?`;
export const PAIR_REVIEW_LEAD = 'Pair only if you clicked Add phone on your own computer just now and its window shows a code.';
export const PAIR_REVIEW_HOSTS = 'This phone will connect to:';
export const PAIR_REVIEW_NOTE = 'A computer you pair with runs its own screens in this app.';
export const PAIR_REVIEW_PAIR = 'Pair';
export const PAIR_REVIEW_CANCEL = 'Cancel';

// The shell's own states (C6d, C6f, C6a): secure storage that did not load, lock settings that cannot be read, and a shell that did not start.
export const STORAGE_UNAVAILABLE = "This phone could not open its secure storage, so Plenum cannot keep a computer's key here. Close Plenum and open it again. If it keeps happening, reinstall the app.";
export const LOCK_UNKNOWN = 'Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.';
export const START_FAILED = 'Plenum could not start on this page. Close it and open Plenum again.';
// The lock screens' Stop (C6f): it stops without unlocking when this phone has the computer's Stop key, else it unlocks first.
export const LOCK_STOP = 'Stop everything';
export const LOCK_UNLOCK_STOP = 'Unlock and stop everything';

export const CONNECTED_SINCE = (computer, when) => `Connected to ${computer}${when ? ` since ${when}` : ''}.`;
export const CONNECTED_TITLE = 'Connected';
export const RECONNECTING_TITLE = 'Reconnecting';
export const RECONNECTING_BODY = computer => `Reconnecting to ${computer}. Plenum keeps trying. The strip at the top says what is happening.`;

export const RENAME_TITLE = 'Rename on this phone';
export const RENAME_HELP = 'Only this phone shows this name. The computer keeps its own name.';
export const FORGET_TITLE = 'Forget {computer}?';
export const FORGET_BODY = 'This phone deletes its key for {computer}. {computer} keeps listing this phone until you remove it there under Settings › Phones.';
export const FORGET_CONFIRM = 'Forget';
export const CANCEL = 'Cancel';

// Phone settings (6.17)
export const SETTINGS_TITLE = 'Phone settings';
export const SETTINGS_COMPUTERS = 'COMPUTERS';
export const SETTINGS_THIS_PHONE = 'THIS PHONE';
export const SETTINGS_HELP = 'HELP';
export const PAIR_ANOTHER_SHORT = 'Pair another computer';
export const SETTINGS_NONE = 'No computer is paired yet.';

// Ways to reach (6.17)
export const WAYS_TITLE = 'Ways to reach {computer}';
export const WAYS_LEAD = 'Plenum tries them in this order.';
export const WAYS_TEST = 'Test them now';
export const WAYS_NEW = 'New ways you turn on at the computer appear here the next time this phone connects.';
export const WAY_NOT_AVAILABLE = 'Not available in this app';
export const WAY_NOT_REACHABLE = 'Not reachable';
export const WAY_NOT_TRIED = 'Not tried yet';
export const WAY_MOVE_UP = 'Move up';
export const WAY_MOVE_DOWN = 'Move down';
export const WAY_LAN_WEB = "An https web app cannot open your network's address.";
export const WAY_NO_ADDRESS = 'Turned off at the computer';

// Notifications (6.17, 10, 14.1)
export const NOTIFY_TITLE = 'Notifications';
export const NOTIFY_ON_PHONE = 'On this phone';
export const NOTIFY_KEPT = 'KEPT ON {computer}, FOR EVERY PHONE';
export const NOTIFY_APPROVE_ROW = 'Approve from notifications';
export const NOTIFY_TEST = 'Send a test notification';
export const NOTIFY_NOT_ARRIVING = "Not arriving? iPhone Focus modes and notification summaries can hold them back: Settings › Notifications › Plenum.";
export const NOTIFY_NOT_ARRIVING_ANDROID = 'Not arriving? Check Settings › Apps › Plenum › Notifications on the phone.';
export const NOTIFY_SAVE_FAILED = "Not saved on {computer}. Connect, then try again.";
export const NOTIFY_TEST_SENT = 'A test notification was sent.';
export const NOTIFY_PERMISSION = Object.freeze({ granted: 'Allowed', denied: 'Blocked', default: 'Not asked', unknown: 'Not asked' });
export const NOTIFY_DENIED_HINT = 'Turn them on in Settings for Plenum on this phone.';
export const APPROVE_NOTIFY_TEXT = 'The notification shows one line of the card. Approving from it runs that edit or command on {computer} without opening the card or the lines under it. Your phone asks for Face ID, your fingerprint or your PIN first. Deny and Stop never need this switch.';
export const APPROVE_BLOCKED_TEXT = 'A blocked command never shows Approve on a notification.';

// Lock (6.13, 6.17, 14.1)
export const LOCK_TITLE = 'App lock';
export const LOCK_ROW = 'Lock Plenum';
export const LOCK_AFTER_LABEL = 'After';
export const LOCK_SWITCHER = 'Hide content in the app switcher';
export const LOCK_NOW = 'Lock now';
export const LOCK_OFF_TITLE = 'Turn off the app lock?';
export const LOCK_OFF_TEXT = 'With the app lock off, anyone who can unlock this phone can run models, approve changes and use your computer through Plenum. If the phone is lost, remove it at the computer under Settings › Phones.';
export const LOCK_OFF_KEEP = 'Keep the lock on';
export const LOCK_OFF_TURN = 'Turn off';
export const LOCK_WEB_KEY_TITLE = 'This web app keeps the phone\x27s key in the browser';
export const LOCK_WEB_KEY = 'The key that pairs this phone is kept in this browser\x27s storage. Clearing the browser\x27s website data removes it, and you pair again. A PIN or passkey protects the key from someone else using the unlocked phone.';
export const PHONE_PUSH_TITLE = 'Notification text shows on the lock screen';
export const PHONE_PUSH_TEXT = 'Plenum sends your phone only the project name and a status, such as an approval is waiting. Anyone holding the phone can read that on the lock screen. Turning on Include the first line adds the first line of the card, which can name files and commands.';
export const LOCK_OFF_HINT = 'The app lock is off. Turn it on to ask for your passcode or Face ID before Plenum connects.';

// Appearance (6.17, 8.12)
export const APPEARANCE_TITLE = 'Appearance';
export const APPEARANCE_THEME = 'Theme';
export const APPEARANCE_TEXT = 'Text size';
export const APPEARANCE_FOLLOW_TEXT = 'Follow phone';
export const APPEARANCE_SAMPLE = 'Coding agents work in the folders you choose, and you approve what they change. This paragraph shows the text size you picked.';
export const APPEARANCE_STOP = 'Stop button';
export const APPEARANCE_STOP_RIGHT = 'Right';
export const APPEARANCE_STOP_LEFT = 'Left';
export const APPEARANCE_HAPTICS = 'Haptics';
export const APPEARANCE_NOTE = 'The theme here is for this phone. Settings › General › Theme changes {computer}.';
export const APPEARANCE_HAPTICS_IOS = 'Haptics are not available in the web app on iPhone.';

// Dictation (6.17, 14.1 phone-voice)
export const DICTATION_TITLE = 'Dictation';
export const DICTATION_PREFER = 'Prefer recognition on this phone';
export const DICTATION_ALLOW = 'Allow that';
export const DICTATION_ALLOW_TEXT = "When your language is not available on the phone, Plenum can use Apple's or Google's speech service instead.";
export const DICTATION_WEB = 'Dictation runs in the Plenum app on your phone.';
export const PHONE_VOICE = 'Plenum asks your phone to turn what you say into text in the message box. It prefers recognition on the phone itself; where your language is not available there, Apple or Google may process the audio under their own terms. Nothing reaches your computer until you press Send.';

// Debug console (6.17)
export const DEBUG_TITLE = 'Debug console';
export const DEBUG_LEAD = 'Holds the last 500 lines, kept only on this phone.';
export const DEBUG_EMPTY = 'No log lines yet.';
export const DEBUG_COPY = 'Copy';
export const DEBUG_SEND = 'Send to {computer}';
export const DEBUG_CLEAR = 'Clear';
export const DEBUG_SENT = 'Sent {n} lines to {computer}.';
export const DEBUG_SEND_FAILED = 'Could not send the log to {computer}. Connect, then try again.';
export const DEBUG_COPIED = 'Copied.';
export const DEBUG_NO_CLIPBOARD = 'This browser does not allow copying here. Select the lines to copy them.';

// About (6.17)
export const ABOUT_TITLE = 'About';
export const ABOUT_APP = 'Plenum app {version}';
export const ABOUT_COMPUTER = '{computer}: Plenum {version}';
export const ABOUT_LINK = 'Link version {version}';
export const ABOUT_SCREENS_BUILT = 'Screens: built into this app';
export const ABOUT_SCREENS_LOADED = 'Screens: loaded from {computer}, {n} files, all checked';
export const ABOUT_CONNECTED = 'Connected over {carrier} since {when}';
export const ABOUT_NEWER_UI = '{computer} has features this app does not show yet. Update the app to use them.';
export const ABOUT_NOT_CONNECTED = 'Not connected to a computer now.';

// Legal (6.17)
export const LEGAL_TITLE = 'Legal';
export const LEGAL_ROWS = Object.freeze({ license: 'License Agreement', privacy: 'Privacy Notice', third: 'Third-party notices' });
export const LEGAL_VERSIONS = 'The versions {computer} uses are in Settings › Legal.';
export const LEGAL_NOT_HERE = 'This link is not in this build yet.';

// Demo (6.18)
export const DEMO_STRIP = 'Demo: nothing here reaches a computer.';
export const DEMO_EXIT = 'Exit demo';
export const DEMO_TITLE = 'Demo computer';
export const DEMO_RUNS = 'RUNS';
export const DEMO_APPROVAL = 'Waiting for you';
export const DEMO_APPROVE = 'Approve';
export const DEMO_DENY = 'Deny';
export const DEMO_RUN_LABEL = 'Computer run';
export const DEMO_DIFF_LABEL = 'Changes';
export const DEMO_ARTIFACT_LABEL = 'Artifacts';
export const DEMO_NO_PAIR = 'The demo cannot pair with a computer. Exit the demo to pair.';
export const DEMO_NO_FORGET = 'The demo has no computer to forget. Exit the demo to pair one.';
export const DEMO_RESET = 'Start the demo again';
export const DEMO_EMPTY = 'Nothing here yet.';

// Shared labels
export const BACK = 'Back';
export const SAVE = 'Save';
export const NOT_NOW = 'Not now';
export const DONE = 'Done';
export const OPEN_SETTINGS_PHONE = 'Open Settings';

// The forwarded app version line and the about values come from the build; these helpers only fill the placeholders.
export function fillName(text, computer) {
  return String(text).split('{computer}').join(String(computer ?? 'your computer'));
}

export function fillMany(text, values) {
  let out = String(text);
  for (const [key, value] of Object.entries(values ?? {})) out = out.split(`{${key}}`).join(String(value ?? ''));
  return out;
}

// The status word of a computer row (6.11): Online when a session is open, Asleep when the relay reports the host offline, Not
// reachable when the last try failed, else "Seen <date>".
export function rowStatus({ active = false, connected = false, status = null, lastSeen = null, dateText = null } = {}) {
  if (active && connected) return STATUS.online;
  if (status === 'asleep') return STATUS.asleep;
  if (status === 'offline' || status === 'reconnecting') return STATUS.unreachable;
  if (lastSeen && dateText) return `Seen ${dateText}`;
  return null;
}
