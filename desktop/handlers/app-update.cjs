'use strict';
// Over-the-air updates for the installed app. This is the only file that requires electron-updater, and it runs here in the desktop
// process, never in the server and never in the page. The rules it keeps:
//  - Checks are on by default (Settings > Updates can turn them off). The first check runs 20 s after start, then every 4 hours. A
//    check waits while the legal gate (the terms) is open or has not been looked at yet (before the first state hook), and while a
//    check or a download is already going.
//  - Nothing installs without the person: an update is installed only when they choose Restart to update (the Updates page or the tray
//    item, both through POST /api/app-updates/install, which the server refuses while a run is going or an approval card waits) or
//    when they quit Plenum. Plenum never restarts by itself. While checks are off nothing is downloaded and nothing installs at quit.
//  - A version that did not start on this computer is not offered again: it is reported (skipped) and never downloaded, until a
//    different version is offered or that version starts cleanly.
//  - Which builds install themselves (canInstall): the Windows installer (NSIS), a signed macOS build, and a Linux AppImage. The
//    Windows portable and zip builds, an unsigned macOS build and a Linux deb package still check and report a new version with the
//    release page to open, but they do not download or install it.
//  - The release repository is public and needs no token: the feed is package.json build.publish (GitHub releases of a public
//    repository), which electron-builder also writes into resources/app-update.yml. No feed URL, header or token is set here, and the
//    page and the state file cannot set one. electron-updater checks the sha512 of every download against the release's yml file and,
//    on Windows, the Authenticode signature once win.publisherName is set.
//  - The version, the notes and the link that reach the page are data: the version must look like a version, the notes are plain text
//    (shown with textContent), and the link is built from package.json, never taken from the feed.
//  - The log gets one short line per updater message and never the release notes. A failed check, a failed download and no network are
//    quiet: no dialog, no notification, only the status under Settings > Updates.
//
// Files: the person's settings are read from the app state file (st.updates: check, channel); the updater's own bookkeeping is kept in
// update-state.json beside the log (pending, firstStart, lastUpdate, failedStart, kept, keptInstalled), and the installers kept for
// rollback (Windows only) are in the updates folder beside it.
//
// The server sends { type: 'app-update', action: 'status' | 'check' | 'install' } and { type: 'app-update-settings', settings }; this
// file posts { type: 'app-update-status', status } on every change (lib/routes/app-updates.mjs publishes it as the app-update event).
// desktop/main.cjs calls the startFailed hook when the server will not start, which only this file uses (see onStartFailed).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FIRST_CHECK_MS = 20_000;
const CHECK_MS = 4 * 60 * 60 * 1000;
const AFTER_SETTINGS_MS = 5_000;
const TERMS_RETRY_MS = 60_000;
const PROGRESS_MS = 1_000;
// How long the 'check' action waits for a check to end before it answers with the status as it is (the server waits 15 s for us).
const CHECK_ANSWER_MS = 12_000;
const NOTES_MAX = 4_000;
const MESSAGE_MAX = 200;
const LOG_MAX = 300;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// A sha512 as electron-builder writes it into the yml files: 64 bytes in base64.
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const STATE_FILE = 'update-state.json';
const UPDATES_DIR = 'updates';

const TEXT = {
  dev: 'Update checks run in the installed app.',
  noRepo: 'No release repository is set (package.json build.publish.owner).',
  noUpdater: 'This build is missing its updater, so it cannot check for new versions.',
  badVersion: 'The release feed named a version Plenum cannot read.',
  nothingReady: 'No update is ready to install.',
  checkFailed: 'The update check failed.',
  unknownAction: 'The desktop app does not know that update request.',
};

// ------------------------------------------------------------------------------------------------------------- state
// Everything below belongs to the one updater of this process. It is set up by init(), on the first hook or message that carries the
// shell (windowCreated is the first, right after the app starts).
let inited = false;
let shell = null;
let app = null;
let current = '';
let pkg = {};
let build = 'dev';
let canInstall = false;
// The reason the updater cannot run in this build, or ''.
let unavailable = '';
let updater = null;
// What the person chose (st.updates in the state file): { check, channel, noticed }.
let settings = { check: true, channel: 'stable', noticed: false };
// Whether this process has set autoUpdater.channel (it cannot be set back to null, so Stable then uses 'latest', the default name).
let channelSet = false;
// The legal gate: true while the terms are waiting to be accepted (the state hook sets it from st.legal.required). It starts true, so
// until the state hook has run once (the server may be slow to start, and the agreement screen has not been seen yet) no check can go
// out: check() waits and tries again in 60 s.
let termsPending = true;
let cleanStartDone = false;
let postNeeded = true;
// The status as the page sees it: its name and the fields that go with it. The rest of the status object is built from the other state.
let view = { status: 'idle', extra: {} };
// The release the last check found: { version, notes, downloadUrl }.
let offered = null;
let checking = false;
let downloading = false;
let installing = false;
let trayShown = false;
let lastError = null;
let lastProgress = { at: 0, percent: -1 };
// failedStart ({ from, to, at }) and lastUpdate ({ from, to, at, notes }) as update-state.json holds them.
let failed = null;
let lastUpdate = null;
let firstTimer = null;
let intervalTimer = null;
let retryTimer = null;
let restartNote = null;

// ----------------------------------------------------------------------------------------------------------- helpers
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The first line of a text, cut short, for the log and for the one-line messages.
function oneLine(text, max = LOG_MAX) {
  return String(text ?? '').split(/\r?\n/)[0].replace(/[\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function log(line) {
  try {
    shell?.log?.(`updater: ${oneLine(line)}`);
  } catch {
    // A log that cannot be written changes nothing.
  }
}

// A timer that never keeps the process alive.
function later(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer?.unref?.();
  return timer;
}

function every(fn, ms) {
  const timer = setInterval(fn, ms);
  timer?.unref?.();
  return timer;
}

// An Electron part (app, dialog, Notification, shell): the one the shell object carries, else the one the electron module has.
function part(name) {
  if (shell && shell[name] !== undefined) return shell[name];
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron[name] : undefined;
  } catch {
    return undefined;
  }
}

function readPackage() {
  try {
    const mod = require('../../package.json');
    return isObject(mod) ? mod : {};
  } catch {
    return {};
  }
}

// The release repository from package.json build.publish, or null when it is not set to a real owner and repository (the placeholder
// has brackets in it).
function repoInfo() {
  let publish = pkg?.build?.publish;
  if (Array.isArray(publish)) publish = publish.find(item => isObject(item) && item.provider === 'github');
  if (!isObject(publish) || typeof publish.owner !== 'string' || typeof publish.repo !== 'string') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(publish.owner) || !/^[A-Za-z0-9_.-]+$/.test(publish.repo)) return null;
  return { owner: publish.owner, repo: publish.repo };
}

// The release page of a version, built from package.json and never from the feed. Null while no repository is set.
function releaseUrl(version) {
  const repo = repoInfo();
  return repo && SEMVER.test(version) ? `https://github.com/${repo.owner}/${repo.repo}/releases/tag/v${version}` : null;
}

// Release notes as text that keeps its lines. The GitHub feed gives the release body as HTML, or an array of { note }. Every tag is
// dropped (a list item becomes a line that starts with a bullet), the common entities are decoded, and the result is cut at 4000
// characters. It is shown with textContent only, and nothing else is done with it.
function cleanNotes(raw) {
  let html = '';
  if (typeof raw === 'string') html = raw;
  else if (Array.isArray(raw)) html = raw.map(item => (typeof item === 'string' ? item : typeof item?.note === 'string' ? item.note : '')).filter(Boolean).join('\n');
  if (!html) return '';
  // Only the start of a very long body is looked at; the result is cut at 4000 characters anyway.
  html = html.slice(0, 100_000);
  const decode = (_, code) => {
    const n = code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
    return Number.isInteger(n) && n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  };
  let text = html
    .replace(/\r\n?/g, '\n')
    // A run of spaces is one space (and a long run cannot slow the later searches down).
    .replace(/[ \t]+/g, ' ')
    // Comments, scripts and styles have no text to show. Their bodies are limited in length, so an opening tag that never ends cannot
    // make the search slow.
    .replace(/<!--[\s\S]{0,5000}?-->/g, '')
    .replace(/<(script|style)\b[^<>]{0,200}>[\s\S]{0,20000}?<\/\1\s*>/gi, '')
    // A line break between two tags is not a line of the text.
    .replace(/(<[^<>]*>)[ \t]*\n[ \t]*/g, '$1')
    .replace(/[ \t]*\n[ \t]*(<[^<>]*>)/g, '$1')
    .replace(/<li\b[^<>]*>/gi, '• ')
    .replace(/<br\s*\/?>|<\/(?:p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^<>]*>/g, '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decode)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > NOTES_MAX) {
    let end = NOTES_MAX - 1;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    text = `${text.slice(0, end)}…`;
  }
  return text;
}

const capText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// ------------------------------------------------------------------------------------------- the settings and the files
// What the person chose, read from the app state file at every use, so a change in Settings applies at the next check.
function readSettings() {
  let updates = null;
  try {
    updates = JSON.parse(fs.readFileSync(shell.stateFile(), 'utf8'))?.updates;
  } catch {
    updates = null;
  }
  const u = isObject(updates) ? updates : {};
  return { check: u.check !== false, channel: u.channel === 'beta' ? 'beta' : 'stable', noticed: u.noticed === true };
}

function userDataDir() {
  try {
    return String(app.getPath('userData'));
  } catch {
    return '';
  }
}

function stateFilePath() {
  const dir = userDataDir();
  return dir ? path.join(dir, STATE_FILE) : '';
}

function updatesDir() {
  const dir = userDataDir();
  return dir ? path.join(dir, UPDATES_DIR) : '';
}

function readUpdateState() {
  const file = stateFilePath();
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

// Merges keys into update-state.json (a null value removes a key). The file is small, so it is read, changed and written again in
// one go, which keeps two writes from mixing; it is written to a temporary name and renamed.
function mergeUpdateState(patch) {
  const file = stateFilePath();
  if (!file) return;
  const next = { ...readUpdateState() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2));
    fs.renameSync(temp, file);
  } catch (err) {
    log(`error: update-state.json could not be written (${err?.code ?? 'unknown'})`);
  }
}

// The shapes update-state.json may hold. Anything that does not fit is treated as not there.
function versionPair(value, extra = []) {
  if (!isObject(value) || !SEMVER.test(String(value.from)) || !SEMVER.test(String(value.to))) return null;
  return { from: value.from, to: value.to, ...Object.fromEntries(extra.map(([key, fn]) => [key, fn(value[key])])) };
}
const toNumber = v => (Number.isFinite(v) ? v : 0);
const asPending = value => versionPair(value, [['at', toNumber], ['notes', v => capText(v, NOTES_MAX)]]);
const asFailed = value => versionPair(value, [['at', toNumber]]);
const asLastUpdate = value => versionPair(value, [['at', toNumber], ['notes', v => capText(v, NOTES_MAX)]]);

// ---------------------------------------------------------------------------------------------------- which build this is
// Decided once, when the handler starts. canInstall says whether this build puts an update in place itself.
function classify() {
  if (!app.isPackaged) return { build: 'dev', canInstall: false };
  const platform = process.platform;
  if (platform === 'win32') {
    // The NSIS installer writes this uninstaller beside the program; the portable and zip builds do not have it.
    let installed = false;
    try {
      installed = fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Plenum.exe'));
    } catch {
      installed = false;
    }
    if (installed) return { build: 'nsis', canInstall: true };
    if (process.env.PORTABLE_EXECUTABLE_FILE) return { build: 'portable', canInstall: false };
    return { build: 'zip', canInstall: false };
  }
  if (platform === 'darwin') {
    // Squirrel.Mac refuses to install over an app that is not signed, so an unsigned build must not try. The release workflow
    // sets plenumSigned in package.json only when its macOS job signs.
    return pkg.plenumSigned === true ? { build: 'mac', canInstall: true } : { build: 'mac-unsigned', canInstall: false };
  }
  if (platform === 'linux') {
    // An AppImage replaces itself. A deb package would need a password prompt for root from inside the app, so it stays a notice.
    return process.env.APPIMAGE ? { build: 'appimage', canInstall: true } : { build: 'deb', canInstall: false };
  }
  return { build: 'other', canInstall: false };
}

// ------------------------------------------------------------------------------------------------------------- the status
// The status object the server publishes. The fields that do not change with the status are added here.
function statusObject() {
  const status = { status: view.status, current, channel: settings.channel, canInstall, build, ...view.extra };
  if (lastUpdate && lastUpdate.to === current) status.installed = { version: lastUpdate.to, from: lastUpdate.from, at: lastUpdate.at, notes: lastUpdate.notes };
  if (failed) status.failedStart = { from: failed.from, to: failed.to, at: failed.at };
  return status;
}

function post() {
  postNeeded = false;
  try {
    shell.tell({ type: 'app-update-status', status: statusObject() });
  } catch {
    // The server is not there to hear it; it asks for the status when it needs it.
  }
}

// The tray item follows the status: it shows while an update is downloaded and checks are on, and nowhere else.
function syncTray() {
  const wanted = view.status === 'downloaded' && settings.check && view.extra.version;
  try {
    if (wanted) {
      shell.tray.setUpdateItem({ label: `Restart to update (${view.extra.version})`, click: () => requestInstall() });
      trayShown = true;
    } else if (trayShown) {
      shell.tray.setUpdateItem(null);
      trayShown = false;
    }
  } catch {
    // A tray that cannot be changed leaves the page's button as the way to restart.
  }
}

function setView(status, extra = {}) {
  view = { status, extra };
  post();
  syncTray();
}

// What the status is when nothing is going on.
function restingView() {
  if (unavailable) return { status: 'unavailable', extra: { message: unavailable } };
  if (!settings.check) return { status: 'off', extra: {} };
  return { status: 'idle', extra: {} };
}

function offeredExtra() {
  return offered ? { version: offered.version, notes: offered.notes, ...(offered.downloadUrl ? { downloadUrl: offered.downloadUrl } : {}) } : {};
}

// ------------------------------------------------------------------------------------------------------ the updater events
function onChecking() {
  if (!settings.check) return;
  offered = null;
  setView('checking', settings.noticed ? {} : { firstCheck: true });
}

function onNone() {
  if (!settings.check) return;
  setView('none', { checkedAt: Date.now() });
}

function onAvailable(info) {
  if (!settings.check) return;
  const version = typeof info?.version === 'string' && SEMVER.test(info.version) ? info.version : '';
  if (!version) {
    offered = null;
    setView('error', { message: TEXT.badVersion, checkedAt: Date.now() });
    return;
  }
  const downloadUrl = releaseUrl(version);
  offered = { version, notes: cleanNotes(info.releaseNotes), downloadUrl };
  const extra = { ...offeredExtra(), checkedAt: Date.now() };
  // A version that did not start on this computer is reported and left alone: nothing downloads, and no tray item is made.
  if (failed && failed.to === version) {
    setView('available', { ...extra, skipped: true });
    return;
  }
  if (failed) {
    failed = null;
    mergeUpdateState({ failedStart: null });
  }
  setView('available', extra);
  if (canInstall) startDownload();
}

// The updater does not download by itself (autoDownload is false), so a version can be left out first. A rejection is an error;
// the updater also sends it as an error event, and onError ignores the second report of the same error.
function startDownload() {
  downloading = true;
  lastProgress = { at: 0, percent: -1 };
  let started;
  try {
    started = updater.downloadUpdate();
  } catch (err) {
    downloading = false;
    onError(err);
    return;
  }
  Promise.resolve(started).then(undefined, err => onError(err)).finally(() => {
    downloading = false;
  });
}

// Progress is posted at most once a second, and only when the whole percent changed.
function onProgress(progress) {
  if (!settings.check) return;
  const raw = Number(progress?.percent);
  if (!Number.isFinite(raw)) return;
  const percent = Math.max(0, Math.min(100, Math.floor(raw)));
  const now = Date.now();
  if (percent === lastProgress.percent || now - lastProgress.at < PROGRESS_MS) return;
  lastProgress = { at: now, percent };
  setView('downloading', { ...offeredExtra(), percent });
}

function onDownloaded(info) {
  downloading = false;
  if (!settings.check) {
    log('info: a download ended while checks are off; it stays unused');
    return;
  }
  const version = typeof info?.version === 'string' && SEMVER.test(info.version) ? info.version : '';
  if (!version) {
    setView('error', { message: TEXT.badVersion, checkedAt: Date.now() });
    return;
  }
  if (!offered || offered.version !== version) offered = { version, notes: cleanNotes(info.releaseNotes), downloadUrl: releaseUrl(version) };
  // pending is written now, not at Restart to update, so the first-start watch and 'What changed' also cover the install at quit.
  mergeUpdateState({ pending: { from: current, to: version, at: Date.now(), notes: offered.notes } });
  setView('downloaded', { ...offeredExtra(), checkedAt: Date.now() });
  keepInstaller(info, version).catch(err => log(`warn: the installer could not be kept (${err?.code ?? oneLine(err?.message, 80)})`));
}

function onError(err) {
  if (err !== null && typeof err === 'object' && err === lastError) return;
  lastError = err ?? null;
  if (!settings.check) return;
  const message = oneLine(err?.message ?? err, MESSAGE_MAX) || TEXT.checkFailed;
  installing = false;
  setView('error', { message, checkedAt: Date.now(), ...(offered ? { version: offered.version, ...(offered.downloadUrl ? { downloadUrl: offered.downloadUrl } : {}) } : {}) });
}

// The updater's own log lines, one short line each. A message can carry a whole feed (the releases page with every release's notes),
// so only its first line is kept.
function makeLogger() {
  const write = prefix => message => log(`${prefix}${message instanceof Error ? message.message : message}`);
  return { info: write(''), warn: write('warn: '), error: write('error: '), debug: write('debug: ') };
}

// -------------------------------------------------------------------------------------------------------- configuration
// Sets the updater up for the settings. It runs at start and again when the channel changes.
function configure() {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = canInstall && settings.check;
  updater.allowPrerelease = settings.channel === 'beta';
  // A web installer is a small stub that downloads the program later and may skip the signature check; Plenum does not ship one.
  updater.disableWebInstaller = true;
  if (settings.channel === 'beta') {
    updater.channel = 'beta';
    channelSet = true;
  } else {
    // 'latest' is the default channel's name; the updater cannot be given null once a channel was set.
    if (channelSet) updater.channel = 'latest';
    // A person who goes from Beta back to Stable keeps the beta until a newer stable version is out. (Setting the channel turns
    // downgrades on, so this comes after it.)
    updater.allowDowngrade = false;
  }
}

function wire() {
  updater.logger = makeLogger();
  const safe = fn => (...args) => {
    try {
      fn(...args);
    } catch (err) {
      log(`error: an updater event could not be handled (${oneLine(err?.message, 80)})`);
    }
  };
  updater.on('checking-for-update', safe(onChecking));
  updater.on('update-not-available', safe(onNone));
  updater.on('update-available', safe(onAvailable));
  updater.on('download-progress', safe(onProgress));
  updater.on('update-downloaded', safe(onDownloaded));
  updater.on('error', safe(onError));
}

function clearTimers() {
  clearTimeout(firstTimer);
  clearInterval(intervalTimer);
  clearTimeout(retryTimer);
  firstTimer = null;
  intervalTimer = null;
  retryTimer = null;
}

// The first check runs after firstMs, then one runs every 4 hours.
function startSchedule(firstMs) {
  clearTimers();
  if (!updater || unavailable || !settings.check) return;
  firstTimer = later(() => {
    firstTimer = null;
    intervalTimer = every(() => void check(), CHECK_MS);
    void check();
  }, firstMs);
}

// Checks are off: no timer, nothing installs at quit, no tray item, and the status says so. A downloaded update stays in the
// updater's cache, and the first check after checks are turned on finds it again.
function goOff() {
  clearTimers();
  if (updater) updater.autoInstallOnAppQuit = false;
  try {
    shell.tray.setUpdateItem(null);
  } catch {
    // No tray to change.
  }
  trayShown = false;
  const resting = restingView();
  setView(resting.status, resting.extra);
}

// Takes new settings. Returns whether the check switch or the channel changed. When `schedule` is true a change that needs a check
// schedules one in 5 s.
function applySettings(next, { schedule }) {
  const previous = settings;
  settings = next;
  const switched = previous.check !== next.check;
  const moved = previous.channel !== next.channel;
  if (!switched && !moved) return false;
  if (switched && !next.check) {
    goOff();
    return true;
  }
  if (updater) {
    if (switched) updater.autoInstallOnAppQuit = canInstall;
    if (moved) configure();
  }
  if (!checking && !downloading) {
    // Whatever was found or downloaded belonged to the old setting. The tray item goes with a downloaded update; the next check
    // finds it again (from the updater's cache) when it is still the newest.
    const resting = restingView();
    setView(resting.status, resting.extra);
  }
  if (schedule) {
    startSchedule(AFTER_SETTINGS_MS);
  } else if (switched && !intervalTimer && updater && !unavailable) {
    // Checks were turned on while a check is being asked for (Check now): the 4-hour rhythm starts again too.
    intervalTimer = every(() => void check(), CHECK_MS);
  }
  return true;
}

// ------------------------------------------------------------------------------------------------------------- checking
async function check() {
  if (!inited || !shell) return;
  applySettings(readSettings(), { schedule: false });
  if (!updater || unavailable || !settings.check) return;
  if (checking || downloading) return;
  // An update that is downloaded waits for the person; looking again would only take Restart to update away for a moment.
  if (view.status === 'downloaded') return;
  // The terms are open, or the state hook has not run yet (termsPending starts true): nothing goes out until it has said otherwise.
  if (termsPending) {
    if (!retryTimer) {
      retryTimer = later(() => {
        retryTimer = null;
        void check();
      }, TERMS_RETRY_MS);
    }
    return;
  }
  clearTimeout(retryTimer);
  retryTimer = null;
  checking = true;
  lastError = null;
  try {
    const result = await updater.checkForUpdates();
    if (result === null) {
      // The updater says it is switched off in this build.
      unavailable = TEXT.dev;
      setView('unavailable', { message: unavailable });
    }
  } catch (err) {
    onError(err);
  } finally {
    checking = false;
  }
}

// ---------------------------------------------------------------------------------------------------------- kept installer
// Windows only. After a download the installer is copied to updates/next-<version>.exe and its sha512 (the one electron-updater
// checked) is recorded. On the first clean start of that version the file becomes installed-<version>.exe, and every other installer
// is deleted, so at most one stays: the one that installed the running version, which is what Reinstall puts back if the next
// update does not start.
function installerSha(info) {
  const files = Array.isArray(info?.files) ? info.files : [];
  const wanted = files.find(file => typeof file?.url === 'string' && /\.exe$/i.test(file.url) && SHA512.test(String(file.sha512))) ?? files.find(file => SHA512.test(String(file?.sha512)));
  const sha = wanted?.sha512 ?? info?.sha512;
  return typeof sha === 'string' && SHA512.test(sha) ? sha : '';
}

async function keepInstaller(info, version) {
  if (process.platform !== 'win32' || typeof info?.downloadedFile !== 'string') return;
  const sha512 = installerSha(info);
  const dir = updatesDir();
  if (!sha512 || !dir) return;
  const ext = path.extname(info.downloadedFile).toLowerCase() === '.exe' ? '.exe' : '';
  if (!ext) return;
  const target = path.join(dir, `next-${version}${ext}`);
  await fs.promises.mkdir(dir, { recursive: true });
  const known = readUpdateState().kept;
  let same = false;
  if (isObject(known) && known.version === version && known.sha512 === sha512) {
    try {
      same = fs.statSync(target).size === fs.statSync(info.downloadedFile).size;
    } catch {
      same = false;
    }
  }
  if (!same) {
    const temp = `${target}.tmp`;
    await fs.promises.copyFile(info.downloadedFile, temp);
    await fs.promises.rename(temp, target);
  }
  // Only one waiting installer is kept: the newest.
  for (const name of safeList(dir)) {
    if (/^next-.+\.exe(\.tmp)?$/.test(name) && name !== path.basename(target)) removeFile(path.join(dir, name));
  }
  mergeUpdateState({ kept: { version, file: target, sha512 } });
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A file that cannot be deleted now is deleted at the next clean start.
  }
}

// The first clean start of the version that was waiting: next-<version>.exe becomes installed-<version>.exe. Returns the changes for
// update-state.json.
function promoteKept(saved) {
  const kept = saved.kept;
  const dir = updatesDir();
  if (process.platform !== 'win32' || !dir || !isObject(kept) || kept.version !== current || !SHA512.test(String(kept.sha512))) return {};
  const next = path.join(dir, `next-${current}.exe`);
  const installed = path.join(dir, `installed-${current}.exe`);
  try {
    if (!fs.existsSync(next)) return { kept: null };
    fs.renameSync(next, installed);
  } catch (err) {
    log(`warn: the installer could not be kept as installed (${err?.code ?? 'unknown'})`);
    return { kept: null };
  }
  // At most one installer stays: the one that installed this version. Older ones, and waiting ones that were never used, go.
  for (const name of safeList(dir)) {
    if (/^(installed|next)-.+\.exe(\.tmp)?$/.test(name) && name !== path.basename(installed)) removeFile(path.join(dir, name));
  }
  return { kept: null, keptInstalled: { version: current, file: installed, sha512: kept.sha512 } };
}

// The path of the kept installer of a version when it is there and still matches the sha512 recorded for it; else ''.
function verifiedInstaller(version) {
  if (process.platform !== 'win32') return '';
  const record = readUpdateState().keptInstalled;
  const dir = updatesDir();
  if (!dir || !isObject(record) || record.version !== version || !SHA512.test(String(record.sha512))) return '';
  const file = path.join(dir, `installed-${version}.exe`);
  try {
    const hash = crypto.createHash('sha512');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      let read;
      while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('base64') === record.sha512 ? file : '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------------------------------- the first start after an update
// At start: when an update was downloaded for this very version (pending), this is its first start. firstStart says so until the
// server answers; if the server never does, the startFailed hook reads it.
function noteFirstStart() {
  const saved = readUpdateState();
  failed = asFailed(saved.failedStart);
  lastUpdate = asLastUpdate(saved.lastUpdate);
  const pending = asPending(saved.pending);
  if (pending && pending.to === current) {
    const attempts = Number.isFinite(saved.firstStart?.attempts) ? saved.firstStart.attempts : 0;
    mergeUpdateState({ firstStart: { from: pending.from, to: current, attempts: attempts + 1 } });
  }
}

// The state hook's first call: the server is up, so this start was clean.
function onCleanStart() {
  const saved = readUpdateState();
  const patch = {};
  const pending = asPending(saved.pending);
  if (pending && pending.to === current) {
    lastUpdate = { from: pending.from, to: pending.to, at: Date.now(), notes: pending.notes };
    patch.lastUpdate = lastUpdate;
    patch.pending = null;
    patch.firstStart = null;
  } else if (saved.firstStart !== undefined) {
    patch.firstStart = null;
  }
  // A version that did not start earlier has started after all.
  if (failed && failed.to === current) {
    failed = null;
    patch.failedStart = null;
  }
  Object.assign(patch, promoteKept(saved));
  if (Object.keys(patch).length) mergeUpdateState(patch);
}

// desktop/main.cjs calls this when the server exits with an error or never answers. When it was the first start after an update, one
// box offers to put the previous version back, and this returns true (the core then shows no box of its own and does not quit; the
// choice here ends in a quit). Otherwise it returns false and opens nothing. The version that failed is remembered and never
// downloaded again (see onAvailable).
function onStartFailed(sh) {
  init(sh);
  const saved = readUpdateState();
  const first = versionPair(saved.firstStart);
  if (!first) return false;
  const { from, to } = first;
  failed = { from, to, at: Date.now() };
  mergeUpdateState({ failedStart: failed, firstStart: null, pending: null });
  post();

  const reinstall = verifiedInstaller(from);
  const page = releaseUrl(from);
  const buttons = [];
  if (reinstall) buttons.push({ id: 'reinstall', label: `Reinstall ${from}` });
  if (page) buttons.push({ id: 'get', label: `Get ${from}` });
  buttons.push({ id: 'quit', label: 'Quit' });
  const lead = reinstall ? `Reinstall ${from} puts the previous version back.` : page ? `Get ${from} opens its release page.` : '';
  const detail = `${lead ? `${lead} ` : ''}If you quit, Plenum tries ${to} again at the next start.\nLog: ${shell.logFile}`;
  const quitIndex = buttons.length - 1;
  const dialog = part('dialog');
  const electronApp = part('app');
  const quit = () => electronApp?.quit?.();
  try {
    const shown = dialog.showMessageBox({
      type: 'warning',
      title: `Plenum ${to} did not start`,
      message: `Plenum ${to} did not start after the update.`,
      detail,
      buttons: buttons.map(button => button.label),
      defaultId: quitIndex,
      cancelId: quitIndex,
    });
    Promise.resolve(shown).then(result => {
      const choice = buttons[Number(result?.response)]?.id ?? 'quit';
      if (choice === 'reinstall') runInstaller(reinstall);
      else if (choice === 'get') part('shell')?.openExternal?.(page);
      quit();
    }, quit);
  } catch (err) {
    log(`error: the start-failed box could not be shown (${oneLine(err?.message, 80)})`);
    quit();
  }
  return true;
}

// Runs a kept installer silently and leaves it to finish after this app quits.
function runInstaller(file) {
  try {
    const child = require('node:child_process').spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
    child.on?.('error', () => log('error: the kept installer could not be started'));
    child.unref?.();
  } catch (err) {
    log(`error: the kept installer could not be started (${oneLine(err?.message, 80)})`);
  }
}

// ----------------------------------------------------------------------------------------------------------- the tray item
// The tray's Restart to update goes through the same server route as the page's button, so a run or a waiting approval card
// refuses it the same way. A refusal is shown as one notification with the server's own words.
function requestInstall() {
  const fail = body => {
    try {
      const Notification = part('Notification');
      if (!Notification?.isSupported?.()) return;
      restartNote = new Notification({ title: 'Plenum cannot restart now', body: oneLine(body, MESSAGE_MAX) || 'Try again in a moment.' });
      restartNote.show();
    } catch {
      // A notification that cannot be shown changes nothing.
    }
  };
  try {
    const body = '{}';
    const request = require('node:http').request({
      host: '127.0.0.1',
      port: shell.port ?? 4317,
      path: '/api/app-updates/install',
      method: 'POST',
      headers: { 'x-plenum-token': shell.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (text.length < 2000) text += chunk;
      });
      response.on('end', () => {
        if (response.statusCode === 200) return;
        let message = '';
        try {
          const parsed = JSON.parse(text);
          message = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : '';
        } catch {
          message = '';
        }
        fail(message);
      });
    });
    request.on('error', () => fail('Plenum did not answer. Try again in a moment.'));
    request.setTimeout?.(10_000, () => request.destroy());
    request.end(body);
  } catch {
    fail('');
  }
}

// ------------------------------------------------------------------------------------------------------------------ start
function setup() {
  app = part('app');
  current = String(app.getVersion());
  pkg = readPackage();
  ({ build, canInstall } = classify());
  settings = readSettings();
  noteFirstStart();
  if (!app.isPackaged) {
    unavailable = TEXT.dev;
  } else if (!repoInfo()) {
    unavailable = TEXT.noRepo;
  } else {
    try {
      updater = require('electron-updater').autoUpdater;
      if (!updater) throw new Error('no autoUpdater');
    } catch (err) {
      updater = null;
      unavailable = TEXT.noUpdater;
      log(`error: electron-updater could not be loaded (${oneLine(err?.message, 80)})`);
    }
  }
  if (updater) {
    configure();
    wire();
  }
  const resting = restingView();
  view = resting;
  startSchedule(FIRST_CHECK_MS);
}

function init(sh) {
  if (inited || !sh) return;
  inited = true;
  shell = sh;
  try {
    setup();
  } catch (err) {
    unavailable = unavailable || TEXT.noUpdater;
    updater = null;
    view = restingView();
    log(`error: the updater could not start (${oneLine(err?.message, 80)})`);
  }
}

// ----------------------------------------------------------------------------------------------------------------- hooks
function onState(sh, st) {
  init(sh);
  termsPending = st?.legal?.required === true;
  if (!cleanStartDone) {
    cleanStartDone = true;
    try {
      onCleanStart();
    } catch (err) {
      log(`error: the first clean start could not be recorded (${oneLine(err?.message, 80)})`);
    }
    post();
  } else if (postNeeded) {
    post();
  }
}

// ------------------------------------------------------------------------------------------------------------- messages
async function answerCheck() {
  let timer = null;
  const limit = new Promise(resolve => {
    timer = later(resolve, CHECK_ANSWER_MS);
  });
  try {
    await Promise.race([check(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function onUpdateMessage(message, sh) {
  init(sh);
  switch (message?.action) {
    case 'status':
      return { ok: true, status: statusObject() };
    case 'check':
      await answerCheck();
      return { ok: true, status: statusObject() };
    case 'install': {
      if (view.status !== 'downloaded' || !updater || !settings.check) return { ok: false, message: TEXT.nothingReady };
      if (installing) return { ok: true };
      installing = true;
      // The answer is posted first; the install and the quit follow on the next turn of the loop.
      setImmediate(() => {
        try {
          updater.quitAndInstall(true, true);
        } catch (err) {
          onError(err);
        }
      });
      return { ok: true };
    }
    default:
      return { ok: false, message: TEXT.unknownAction };
  }
}

// The server saved new settings. Only a change of the check switch or the channel does anything.
async function onSettingsMessage(message, sh) {
  init(sh);
  const saved = readSettings();
  const given = isObject(message?.settings) ? message.settings : {};
  const next = {
    check: typeof given.check === 'boolean' ? given.check : saved.check,
    channel: given.channel === 'beta' || given.channel === 'stable' ? given.channel : saved.channel,
    noticed: saved.noticed,
  };
  applySettings(next, { schedule: true });
}

module.exports = {
  name: 'app-update',
  messages: {
    'app-update': onUpdateMessage,
    'app-update-settings': onSettingsMessage,
  },
  hooks: {
    windowCreated: sh => init(sh),
    serverStarted: sh => {
      init(sh);
      // A server that has just started has no status yet; it gets one with the next state.
      postNeeded = true;
    },
    state: onState,
    startFailed: onStartFailed,
    beforeQuit: () => clearTimers(),
  },
};
