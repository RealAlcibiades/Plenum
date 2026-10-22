// Over-the-air update routes: what the Settings > Updates page reads and does. The updater itself runs in the desktop app
// (desktop/handlers/app-update.cjs, the only place electron-updater is used); this file is the server's side of it.
//  - The desktop app posts its status whenever it changes ({ type: 'app-update-status', status }). It is cleaned here, field by field,
//    and published to every window as the 'app-update' event (lib/events.mjs), so a malformed message from the shell cannot carry
//    anything else to the page. The latest cleaned status is kept in memory and answers GET.
//  - The person's choices (check on or off, Stable or Beta, and the once-only markers the page keeps) live in the app state file as
//    st.updates. The desktop app reads the same file; a change of check or channel is also sent to it at once.
//  - Restart to update is refused while a run is going or an approval card waits, so a run is never cut off and a waiting card never
//    vanishes. The tray item and the page both come through here.
// The server checks the Plenum token and the JSON content type before any handler here runs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../overlay.mjs';
import { shellAvailable, shellRequest, shellPost, onShellMessage } from '../shell.mjs';
import { publish } from '../events.mjs';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const STATUSES = ['unavailable', 'off', 'idle', 'checking', 'none', 'available', 'downloading', 'downloaded', 'error'];
const REFUSAL = 'Send check as true or false, channel as stable or beta, and versions such as 0.6.0.';
const NO_DESKTOP = 'Update checks run in the Plenum desktop app.';
const READY_REFUSAL = 'No update is ready to install.';
const VERSION_KEYS = ['toldVersion', 'seenVersion', 'toldUpdatedTo'];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const semver = v => (typeof v === 'string' && SEMVER.test(v) ? v : null);
const number = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// package.json, read once: the version that is running and the release repository the build was made for.
const pkg = (() => {
  try {
    const data = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
})();

// The releases page of the repository in build.publish, or null while the owner is still a placeholder (it has brackets in it).
function releasesUrl() {
  let publishInfo = pkg.build?.publish;
  if (Array.isArray(publishInfo)) publishInfo = publishInfo.find(item => isObject(item) && item.provider === 'github');
  if (!isObject(publishInfo) || typeof publishInfo.owner !== 'string' || typeof publishInfo.repo !== 'string') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(publishInfo.owner) || !/^[A-Za-z0-9_.-]+$/.test(publishInfo.repo)) return null;
  return `https://github.com/${publishInfo.owner}/${publishInfo.repo}/releases`;
}

const oneLine = (v, max) => String(v ?? '').split(/\r?\n/)[0].replace(/[\t\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

// Copies the fields of a status the page may see, each checked. Anything else in the message is dropped. Returns null when the
// message has no status name the page knows.
export function cleanStatus(raw) {
  if (!isObject(raw) || !STATUSES.includes(raw.status)) return null;
  const out = { status: raw.status };
  const current = semver(raw.current);
  if (current) out.current = current;
  if (raw.channel === 'stable' || raw.channel === 'beta') out.channel = raw.channel;
  if (typeof raw.canInstall === 'boolean') out.canInstall = raw.canInstall;
  if (typeof raw.build === 'string' && /^[a-z-]{1,20}$/.test(raw.build)) out.build = raw.build;
  const version = semver(raw.version);
  if (version) out.version = version;
  if (typeof raw.notes === 'string') out.notes = raw.notes.slice(0, 4000);
  if (typeof raw.downloadUrl === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9._~%/-]{1,300}$/.test(raw.downloadUrl)) out.downloadUrl = raw.downloadUrl;
  const percent = number(raw.percent);
  if (percent !== null) out.percent = Math.max(0, Math.min(100, Math.round(percent)));
  const checkedAt = number(raw.checkedAt);
  if (checkedAt !== null) out.checkedAt = checkedAt;
  if (typeof raw.message === 'string') out.message = oneLine(raw.message, 200);
  if (raw.skipped === true) out.skipped = true;
  if (raw.firstCheck === true) out.firstCheck = true;
  if (isObject(raw.installed)) {
    const v = semver(raw.installed.version);
    const from = semver(raw.installed.from);
    const at = number(raw.installed.at);
    if (v && from && at !== null) out.installed = { version: v, from, at, notes: typeof raw.installed.notes === 'string' ? raw.installed.notes.slice(0, 4000) : '' };
  }
  if (isObject(raw.failedStart)) {
    const from = semver(raw.failedStart.from);
    const to = semver(raw.failedStart.to);
    const at = number(raw.failedStart.at);
    if (from && to && at !== null) out.failedStart = { from, to, at };
  }
  return out;
}

// The latest status the desktop app posted, cleaned; null until it posts one.
let last = null;
onShellMessage('app-update-status', msg => {
  const cleaned = cleanStatus(msg?.status);
  if (!cleaned) return;
  last = cleaned;
  publish({ type: 'app-update', ...last });
});

// What the page keeps in the state file: the two switches and the once-only markers. Each marker is a version, or null.
export function updateSettings(st) {
  const u = isObject(st?.updates) ? st.updates : {};
  return {
    check: u.check !== false,
    channel: u.channel === 'beta' ? 'beta' : 'stable',
    noticed: u.noticed === true,
    toldVersion: semver(u.toldVersion),
    seenVersion: semver(u.seenVersion),
    toldUpdatedTo: semver(u.toldUpdatedTo),
  };
}

// The status when nothing has been posted yet: ask the desktop app, or say there is no updater.
async function currentStatus(desktop) {
  if (last) return last;
  if (!desktop) return { status: 'unavailable', message: NO_DESKTOP };
  try {
    const reply = await shellRequest('app-update', { action: 'status' }, { timeoutMs: 3000 });
    const cleaned = cleanStatus(reply?.status);
    if (cleaned) {
      last = cleaned;
      return cleaned;
    }
  } catch {
    // The desktop app did not answer; the page shows the quiet default.
  }
  return { status: 'idle' };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/app-updates',
    handler: async ({ res, json, store }) => {
      const desktop = shellAvailable();
      return json(res, 200, {
        desktop,
        version: typeof pkg.version === 'string' ? pkg.version : '',
        releasesUrl: releasesUrl(),
        settings: updateSettings(store.get()),
        status: await currentStatus(desktop),
      });
    },
  },
  {
    // Body: any of check (true or false), channel ('stable' or 'beta'), noticed (true) and toldVersion, seenVersion and toldUpdatedTo
    // (a version such as 0.6.0). One value that does not fit refuses the whole request, so nothing is written from a half-wrong one.
    method: 'POST',
    path: '/api/app-updates/settings',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, REFUSAL);
      const accepted = {};
      if (body.check !== undefined) {
        if (typeof body.check !== 'boolean') throw httpError(400, REFUSAL);
        accepted.check = body.check;
      }
      if (body.channel !== undefined) {
        if (body.channel !== 'stable' && body.channel !== 'beta') throw httpError(400, REFUSAL);
        accepted.channel = body.channel;
      }
      if (body.noticed !== undefined) {
        if (body.noticed !== true) throw httpError(400, REFUSAL);
        accepted.noticed = true;
      }
      for (const key of VERSION_KEYS) {
        if (body[key] === undefined) continue;
        if (!semver(body[key])) throw httpError(400, REFUSAL);
        accepted[key] = body[key];
      }
      const st = store.get();
      if (Object.keys(accepted).length > 0) {
        st.updates = { ...(isObject(st.updates) ? st.updates : {}), ...accepted };
        // A save that did not reach the file answers 500 (B-28; persist resolves to null on success and to the failure message
        // otherwise, as store.saveOrFail reads it). The desktop app is told only after the save worked.
        const failure = await store.persist();
        if (failure) throw httpError(500, `${failure} The change is shown but is lost on restart until a save works.`);
      }
      const settings = updateSettings(st);
      // The desktop app reads the file at each check; a change of the switch or the channel is also told to it now.
      if ((accepted.check !== undefined || accepted.channel !== undefined) && shellAvailable()) shellPost({ type: 'app-update-settings', settings });
      return json(res, 200, { settings });
    },
  },
  {
    // Checks now and answers the status. The desktop app answers at once when a check is already running or checks are off.
    method: 'POST',
    path: '/api/app-updates/check',
    handler: async ({ res, json }) => {
      const reply = await shellRequest('app-update', { action: 'check' });
      return json(res, 200, { ok: true, status: cleanStatus(reply?.status) ?? { status: 'idle' } });
    },
  },
  {
    // Restart to update. A run in progress or a waiting approval card refuses it; the desktop app refuses it when nothing is
    // downloaded. The tray item posts here too.
    method: 'POST',
    path: '/api/app-updates/install',
    handler: async ({ res, json, httpError, running, publicState }) => {
      if (running.size) throw httpError(409, 'A run is in progress. Restart to update when it ends.');
      if ((publicState({ messages: false }).approvalsWaiting ?? 0) > 0) throw httpError(409, 'An approval card is waiting. Answer it, then restart to update.');
      const reply = await shellRequest('app-update', { action: 'install' });
      if (!reply?.ok) throw httpError(409, oneLine(reply?.message, 200) || READY_REFUSAL);
      return json(res, 200, { ok: true, restarting: true });
    },
  },
];
