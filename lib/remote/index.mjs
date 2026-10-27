// The Bridge, assembled: startRemote() / stopRemote() / remoteState() (MOBILE.json desktop.new_files). Owned by mob-03.
//
// What starts. Nothing until the first /api/phones request or a guarded timer in lib/routes/remote.mjs asks for it, and then only when
// state.json phones.enabled is on. start() loads the registry (the desktop's encrypted store, or phones.json under plain node), makes
// this computer's static key on first use, binds 127.0.0.1:<port> (random 49152 to 65535 the first time, remembered in state.phones.port,
// another free one when that is taken), and wires the pieces:
//   registry   keys, path key, the paired phones                       (registry.mjs)
//   pairing    the offer state machine and the Allow/Deny gesture        (pairing.mjs)
//   handshaker Noise IK / IKpsk2, DoS controls, HELLO                    (listener.mjs)
//   listener   the http.Server, the upgrade at /b/<pathKey>, the LAN shell (listener.mjs)
//   proxy      REQ to the loopback server, tiers, guards, adapters      (proxy.mjs)
//   stop       STOP on the priority lane, idempotent by id               (stop.mjs)
// It also follows the server's own /api/events stream on loopback (as any window does), which gives it the server's start time and
// generation for HELLO, the approval cards waiting (for the first-line check and for push), runs finishing, and drives.
//
// What it gives the rest of the app:
//   events.publish({ type: 'phone', kind: 'presence', connected: [{ id, name, carrier }] }) when a phone connects or goes,
//   { type: 'phone', kind: 'pairing', state, expiresInS } while an offer lives, { kind: 'revoked', id }, { kind: 'tier', id, tier },
//   { kind: 'activity', device, text } ('via <device>: approved a card'),
//   the shell message phones-indicator { connected: [names] } and, under the desktop app, phones-pair-show for the pairing window.
// The same presence goes to every connected phone as an EVENT frame, so a phone can see the others.
//
// Carriers. A way of reaching this computer other than the loopback port is a module lib/remote/carriers/<kind>.mjs ('lan',
// 'tailscale', 'relay') that exports { start(ctx), stop(), status(), hints() } (each may return a promise). A module that is missing, or
// that fails to load, counts as off. ctx = { kind, settings(), listener: { setLan({ enabled, anyAddress }), status(), port() },
// handshaker: { accept({ carrier, source, transport }) }, registry: { relay(), ensureRelay(), pathKey(), publicKey(), on(name, fn) },
// clock, publish(event), hostname, upstreamPort() }. status() answers { on, ...whatever the panel shows, origins?: string[],
// name?: string (the ts.net name), addresses?: string[] }; hints() answers [{ kind, on, label, urls?: string[] (ws://... for 'lan'),
// url?: string (wss://... for 'tailscale' and 'relay'), web?: string (the page a phone opens: http://<ip>:<port>/p/<pathKey>/ or
// https://<name>/p/<pathKey>/) }].
//
// Pairing links under plain node. There is no capture-protected window, so POST /api/phones/pair/start answers the link itself (to the
// token holder only) and GET /api/phones shows the check code, and POST /api/phones/pair/confirm is the Allow. Under the desktop app the
// link and the code go only to the pairing window (shell message phones-pair-show) and Allow/Deny are buttons in it.
//
// Nothing here logs a token, a key, a link, a payload or a name.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { token as authToken } from '../auth.mjs';
import * as eventsLib from '../events.mjs';
import { APP_ROOT } from '../overlay.mjs';
import { onShellMessage, shellAvailable, shellPost, shellRequest } from '../shell.mjs';
import * as storeLib from '../store.mjs';
import { createHandshaker, createListener } from './listener.mjs';
import { createPairing } from './pairing.mjs';
import { createProxy } from './proxy.mjs';
import { createFileStorage, createRegistry, createShellStorage, cleanName } from './registry.mjs';
import { createPusher, firstLineOf, normalizeSubscription } from './push.mjs';
import { stopEverything } from './stop.mjs';
import { ACTIVITY_MAX, capsForTier, isTier, phonesShape } from './tiers.mjs';

export { phonesShape };

export const CARRIER_KINDS = Object.freeze(['lan', 'tailscale', 'relay']);
export const PROTOCOL = Object.freeze({ major: 1, minor: 1 });
const STOP_CACHE = 64;
const SWEEP_MS = 3_600_000;
const CARRIER_STATUS_MS = 30_000;
const INFO_WAIT_MS = 1000;
const PUSH_KINDS_OF_DRIVE = Object.freeze(['computer', 'browser']);

// A monotonic clock whose timers never keep the process alive.
export function monotonicClock() {
  const unref = t => {
    t?.unref?.();
    return t;
  };
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
    clearTimeout: h => clearTimeout(h),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)),
    clearInterval: h => clearInterval(h),
  };
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const randomPort = () => randomInt(49152, 65536);

// What stopped a run, when it was a limit: the project's spend cap (lib/budget.mjs throws 'Spend cap reached: ...') is 'spend'; a
// plan or rate limit that a model CLI or API reports is 'plan'. Anything else is an ordinary failure (null).
export function limitKindOf(message) {
  const text = String(message ?? '');
  if (/^\s*spend cap reached/i.test(text)) return 'spend';
  if (/\b(usage limit|rate[ -]limit(ed)?|hit your limit|limit reached|(5[- ]hour|weekly|daily|monthly|session) limit|out of (extra )?usage|quota (exceeded|reached)|too many requests)\b/i.test(text)) return 'plan';
  return null;
}

/**
 * Builds a Bridge. Every dependency can be replaced (tests do); the defaults are the running server's own.
 * @param {object} [options]
 * @param {number|(() => number)} [options.port]   the server's real listen port (default PORT or 4317, which routes/remote.mjs overrides with the socket's)
 * @param {object} [options.settings]  { get(): state.phones object, save(): Promise<void> }
 * @param {Map} [options.running]      the server's running map
 * @param {(opts?: object) => object} [options.publicState]
 * @param {string} [options.host]      the loopback bind host (default 127.0.0.1)
 * @param {string[]} [options.lanHosts]
 * @param {(req) => string} [options.remoteAddress]
 * @param {string|null} [options.shellRoot]
 * @param {(line: string) => void} [options.log]   writes one fixed sentence (never key material); default none
 */
export function createRemote(options = {}) {
  const o = options;
  const shell = o.shell ?? { available: shellAvailable, request: shellRequest, post: shellPost, on: onShellMessage };
  const events = o.events ?? { publish: ev => eventsLib.publish(ev) };
  const clock = o.clock ?? monotonicClock();
  const wallNow = o.wallNow ?? Date.now;
  const random = o.random ?? (n => new Uint8Array(randomBytes(n)));
  const getToken = o.getToken ?? authToken;
  const loadCarrierModule = o.loadCarrier ?? (kind => import(`./carriers/${kind}.mjs`));
  const loadPush = o.createPusher ?? createPusher;
  const loadUiManifest = o.loadUiManifest ?? (() => import('./ui-manifest.mjs'));
  const hostname = clip(o.hostname ?? os.hostname(), 60) || 'this computer';
  let serverPort = o.port;
  let running = o.running ?? null;
  let publicState = o.publicState ?? null;
  const upstreamPort = () => {
    const value = typeof serverPort === 'function' ? serverPort() : serverPort;
    return Number.isInteger(value) ? value : (Number(process.env.PORT) || 4317);
  };
  const settings = o.settings ?? { get: () => (storeLib.get().phones ??= {}), save: () => storeLib.saveOrFail() };
  const phones = () => phonesShape(settings.get());
  const storage = o.storage ?? (shell.available()
    ? createShellStorage({ request: (type, payload) => shell.request(type, payload) })
    : createFileStorage({ dir: o.home ?? storeLib.HOME }));
  const registry = createRegistry({ storage, wallNow, random });

  const sessions = new Map(); // device id -> Set of session records
  const cards = new Map(); // approval id -> { id, project, summary, defaultDeny, blocked, kind, at }
  const runs = new Map(); // run id -> { project, error }
  const drives = new Map(); // drive id -> summary
  const handovers = new Map(); // drive id -> the note of the hand-over already pushed
  const projectNames = new Map();
  const stopCache = new Map();
  const loggedOnce = new Set(); // fixed log sentences already written
  const carriers = {}; // kind -> loaded module
  const carrierStatus = {}; // kind -> last status
  const carrierHints = {}; // kind -> last hints
  let info = { desktopVersion: '', generation: null, startedAt: o.startedAt ?? 0 };
  let infoReady = null;
  let infoResolve = null;
  let started = null;
  let pusher = null;
  let listener = null;
  let handshaker = null;
  let pairing = null;
  let proxy = null;
  let sse = null;
  let timers = [];
  let lastPresence = '';
  let manifestCache = { generation: undefined, hash: '' };
  let stopped = true;
  let unsubscribe = [];

  const publish = ev => {
    try {
      events.publish(ev);
    } catch {
      // The events channel is a courtesy to the windows.
    }
  };

  // ----- presence -----

  const connectedList = () => {
    const out = [];
    for (const [id, set] of sessions) {
      const rec = [...set][0];
      if (rec) out.push({ id, name: registry.get(id)?.name ?? rec.device?.name ?? 'Phone', carrier: rec.carrier });
    }
    return out;
  };

  function broadcast(event, only = null) {
    for (const [id, set] of sessions) {
      if (only && id !== only) continue;
      for (const rec of set) {
        try {
          if (!rec.frames.isClosed) rec.frames.event(event);
        } catch {
          // A session that is closing misses the event.
        }
      }
    }
  }

  function presenceChanged() {
    const connected = connectedList();
    const key = JSON.stringify(connected);
    if (key === lastPresence) return;
    lastPresence = key;
    const event = { type: 'phone', kind: 'presence', connected };
    publish(event);
    broadcast(event);
    shell.post({ type: 'phones-indicator', connected: connected.map(c => c.name) });
  }

  function addActivity(device, text) {
    const entry = { at: wallNow(), device: clip(device, 60), text: clip(text, 120) };
    const p = phones();
    p.activity.unshift(entry);
    p.activity.length = Math.min(p.activity.length, ACTIVITY_MAX);
    publish({ type: 'phone', kind: 'activity', device: entry.device, text: entry.text });
    Promise.resolve(settings.save()).catch(() => {});
  }

  // ----- events from the server's own stream -----

  function handleEvent(ev) {
    if (!isObject(ev) || typeof ev.type !== 'string') return;
    if (ev.type === 'hello') {
      info = { desktopVersion: clip(ev.version, 40), generation: ev.generation ?? null, startedAt: Number(ev.startedAt) || info.startedAt };
      infoResolve?.();
      syncProjects(ev.state);
      if (Number(ev.state?.approvalsWaiting) === 0) cards.clear();
      return;
    }
    if (ev.type === 'state') {
      syncProjects(ev.state);
      if (Number(ev.state?.approvalsWaiting) === 0) cards.clear();
      return;
    }
    if (ev.type === 'approval') {
      cards.delete(String(ev.approvalId ?? ''));
      return;
    }
    if (ev.type === 'drive') {
      const d = ev.drive;
      if (!isObject(d) || typeof d.id !== 'string') return;
      if (d.state === 'stopped') drives.delete(d.id);
      else drives.set(d.id, d);
      // A model asking the person to do a step: told once per ask, however many times the drive reports the same pause.
      if (d.state === 'paused' && d.pausedBy === 'model' && d.note) {
        if (handovers.get(d.id) !== d.note) {
          handovers.set(d.id, d.note);
          pushEvent({ kind: 'handover', projectId: d.projectId, approvalId: d.id, firstLine: d.note });
        }
      } else {
        handovers.delete(d.id);
      }
      return;
    }
    if (ev.type === 'run' && isObject(ev.event)) handleRunEvent(ev);
  }

  function syncProjects(state) {
    if (!Array.isArray(state?.projects)) return;
    projectNames.clear();
    for (const p of state.projects) if (isObject(p) && typeof p.id === 'string') projectNames.set(p.id, clip(p.name, 60));
  }

  function handleRunEvent(ev) {
    const e = ev.event;
    const runId = String(ev.runId ?? '');
    if (e.type === 'start') runs.set(runId, { project: ev.project, error: '' });
    else if (e.type === 'approval') {
      const id = String(e.approvalId ?? '');
      if (!id) return;
      // Only the headline of a card is kept (its detail can hold file contents), with its line breaks, because the first line is what a notification shows.
      const summary = String(e.summary ?? '').slice(0, 600);
      cards.set(id, { id, project: ev.project, summary, defaultDeny: e.defaultDeny === true, blocked: e.blocked === true, kind: e.kind ?? '', at: wallNow() });
      pushEvent({ kind: 'approval', projectId: ev.project, approvalId: id, count: cards.size, firstLine: firstLineOf(summary), defaultDeny: e.defaultDeny === true });
    } else if (e.type === 'approval-closed') cards.delete(String(e.approvalId ?? ''));
    else if (e.type === 'error') {
      const run = runs.get(runId);
      if (!run) return;
      run.error = clip(e.message, 200);
      // A spend cap or a plan limit that stops a run is its own ping (the 'limits' switch), and it replaces the 'failed' one for that run.
      const limitKind = limitKindOf(e.message);
      if (limitKind && !run.limited) {
        run.limited = true;
        pushEvent({ kind: 'limit', limitKind, projectId: run.project });
      }
    } else if (e.type === 'done') {
      const run = runs.get(runId);
      runs.delete(runId);
      if (!run || e.aborted === true) return;
      if (run.limited) return;
      if (run.error) pushEvent({ kind: 'failed', projectId: run.project, firstLine: run.error });
      else pushEvent({ kind: 'finished', projectId: run.project });
    }
  }

  function pushEvent(event) {
    if (!pusher) return;
    const withName = { ...event, projectName: projectNames.get(event.projectId) ?? '', computerName: hostname };
    Promise.resolve(pusher.sendEvent(withName)).catch(() => {});
  }

  function followEvents() {
    let closed = false;
    let req = null;
    let timer = null;
    let backoff = 1000;
    const retry = () => {
      if (closed || timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        connect();
      }, backoff);
      backoff = Math.min(10_000, backoff * 2);
    };
    function connect() {
      if (closed) return;
      const port = upstreamPort();
      let token = '';
      try {
        token = getToken();
      } catch {
        token = '';
      }
      req = http.request({ host: '127.0.0.1', port, path: '/api/events', method: 'GET', agent: false, headers: { host: `127.0.0.1:${port}`, 'x-plenum-token': token, accept: 'text/event-stream' } });
      req.on('response', res => {
        if (res.statusCode !== 200) {
          res.resume();
          return retry();
        }
        backoff = 1000;
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk;
          if (buffer.length > 8_000_000) {
            buffer = '';
            res.destroy();
            return;
          }
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const line = block.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            try {
              handleEvent(JSON.parse(line.slice(5)));
            } catch {
              // A line that is not an event is skipped.
            }
          }
        });
        res.on('end', retry);
        res.on('error', retry);
        return undefined;
      });
      req.on('error', retry);
      req.end();
    }
    connect();
    return {
      close() {
        closed = true;
        if (timer !== null) clock.clearTimeout(timer);
        req?.destroy();
      },
    };
  }

  // ----- HELLO -----

  async function uiManifestHash() {
    if (manifestCache.generation === info.generation && manifestCache.hash) return manifestCache.hash;
    try {
      const mod = await loadUiManifest();
      const fn = mod.manifest ?? mod.uiManifest;
      const value = typeof fn === 'function' ? await fn(uiContext()) : null;
      const hash = typeof value?.hash === 'string' ? value.hash : '';
      manifestCache = { generation: info.generation, hash };
      return hash;
    } catch {
      return '';
    }
  }

  const uiContext = () => ({ desktopVersion: info.desktopVersion, generation: info.generation, startedAt: info.startedAt });

  async function waitForInfo() {
    if (!infoReady) return;
    await Promise.race([infoReady, new Promise(resolve => clock.setTimeout(resolve, INFO_WAIT_MS))]);
  }

  function pendingNow() {
    const driving = [...drives.values()].find(d => PUSH_KINDS_OF_DRIVE.includes(d.kind) && d.state !== 'stopped');
    return {
      approvals: cards.size,
      running: running ? running.size : runs.size,
      ...(driving ? { driving: { kind: driving.kind, app: clip(driving.label, 60), step: Number(driving.steps) || 0, of: Number.isInteger(driving.limits?.steps) ? driving.limits.steps : null } } : {}),
    };
  }

  function carriersInHello() {
    const out = [];
    for (const kind of CARRIER_KINDS) {
      for (const hint of carrierHints[kind] ?? []) {
        if (!hint?.on) continue;
        const url = hint.url ?? hint.urls?.[0];
        if (typeof url === 'string' && url) out.push({ kind, url });
      }
    }
    return out;
  }

  // The VAPID public key (public by design: the browser needs it to subscribe), only when this Bridge has a pusher. Never the private half.
  function vapidField() {
    let key = null;
    try {
      key = pusher?.vapidPublicKey?.() ?? null;
    } catch {
      key = null;
    }
    return typeof key === 'string' && key ? { vapidPublicKey: key } : {};
  }

  async function helloFor({ device, kind, payload, carrier, refused, stopKeyNew }) {
    await waitForInfo();
    let stopAck;
    if (kind === 'session' && payload?.stop) {
      try {
        stopAck = (await runStop({ id: payload.stop }, device.name)).id;
      } catch {
        stopAck = undefined;
      }
    }
    const tier = registry.tierOf(device.id) ?? device.tier;
    return {
      v: '1.0',
      protocol: { ...PROTOCOL },
      desktopVersion: info.desktopVersion,
      generation: info.generation,
      startedAt: info.startedAt,
      desktopName: hostname,
      deviceId: device.id,
      tier,
      uiManifestHash: await uiManifestHash(),
      ...vapidField(),
      caps: capsForTier(tier),
      minShell: '1.0.0',
      pending: pendingNow(),
      carriers: carriersInHello(),
      ...(stopAck ? { stopAck } : {}),
      ...(refused ? { refused } : {}),
      // The desktop keeps this session's Stop key for a phone that asked for one (listener.mjs startSession); the phone derives the same key.
      ...(stopKeyNew ? { stopKeyNew: true } : {}),
    };
  }

  // ----- stop -----

  async function countCards() {
    if (publicState) return Number(publicState({ messages: false })?.approvalsWaiting) || 0;
    const port = upstreamPort();
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/state', method: 'GET', agent: false, headers: { host: `127.0.0.1:${port}`, 'x-plenum-token': getToken() } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(Number(JSON.parse(Buffer.concat(chunks).toString('utf8')).approvalsWaiting) || 0);
          } catch {
            resolve(0);
          }
        });
      });
      req.on('error', () => resolve(0));
      req.setTimeout(2000, () => req.destroy());
      req.end();
    });
  }

  function runStop(value, deviceName) {
    const id = typeof value?.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) ? value.id : '';
    if (id && stopCache.has(id)) return stopCache.get(id);
    const project = typeof value?.project === 'string' && value.project ? value.project : null;
    const work = stopEverything({
      project, running, port: upstreamPort(), token: getToken, countCards, by: deviceName,
      publish: ev => {
        publish(ev);
      },
      ...(o.stopDeps ?? {}),
    }).then(counts => ({ id, ...counts }));
    if (id) {
      stopCache.set(id, work);
      while (stopCache.size > STOP_CACHE) stopCache.delete(stopCache.keys().next().value);
      work.catch(() => stopCache.delete(id));
    }
    return work;
  }

  // ----- pairing, and the window that shows it -----

  async function collectHints() {
    const hints = [];
    for (const kind of CARRIER_KINDS) {
      const mod = carriers[kind];
      if (!mod) continue;
      try {
        const list = await mod.hints();
        carrierHints[kind] = Array.isArray(list) ? list.filter(isObject) : [];
      } catch {
        carrierHints[kind] = [];
      }
      hints.push(...carrierHints[kind]);
    }
    if (process.env.PLENUM_REMOTE_LOOPBACK_HINT === '1' && listener) {
      const key = registry.pathKey();
      const port = listener.port();
      hints.push({ kind: 'lan', on: true, label: 'This computer (test)', urls: [`ws://127.0.0.1:${port}/b/${key}`], web: `http://127.0.0.1:${port}/p/${key}/` });
    }
    return hints;
  }

  function windowHints(list) {
    return list.map(h => ({ label: clip(h.label ?? (h.kind === 'lan' ? 'Same network' : h.kind === 'tailscale' ? 'Tailscale' : 'Your relay'), 120), on: h.on === true })).slice(0, 6);
  }

  let lastHints = [];

  // The tier the phone on screen gets if it is allowed: its stored tier on a re-pair, else Full (D6: the owner's default). null when nobody is shown.
  function shownTier() {
    const key = pairing?.shownPublicKey?.() ?? null;
    if (!key) return null;
    const id = registry.idOfPublic(key);
    return (id && registry.tierOf(id)) || 'full';
  }

  function onPairingChange(view, change) {
    publish({ type: 'phone', kind: 'pairing', state: view.state, expiresInS: view.expiresInS });
    if (!shell.available()) return;
    if (change === 'cancelled') {
      shell.post({ type: 'phones-pair-close' });
      return;
    }
    if (['offer', 'confirm', 'allowed', 'denied', 'expired', 'failed3', 'no-carrier'].includes(view.state)) {
      Promise.resolve(shell.request('phones-pair-show', {
        state: view.state,
        offer: pairing.offerId(),
        name: hostname,
        hints: windowHints(lastHints),
        expiresInS: view.expiresInS,
        code: view.code ?? '',
        device: view.device ?? null,
        second: view.second === true,
        tried: view.tried === true,
        left: view.left === true,
        qrKind: pairing.qrKind(),
        tier: shownTier(),
        link: pairing.link(),
      })).catch(() => {});
    }
  }

  async function pairStart() {
    await start();
    if (!registry.available()) throw Object.assign(new Error(registry.status().message), { status: 503 });
    lastHints = await collectHints();
    const hints = lastHints.filter(h => h.on === true);
    const made = pairing.start({ name: hostname, pub: registry.publicKeyHex(), hints });
    if (!made.ok) return { ok: false, state: made.state };
    return {
      ok: true,
      state: 'offer',
      offer: made.offer,
      expiresInS: made.expiresInS,
      // Without a window the link is the only way to show the code, and only the token holder asks.
      ...(shell.available() ? {} : { link: made.link, hints: windowHints(lastHints) }),
    };
  }

  async function onWindowAnswer(msg) {
    const action = typeof msg?.action === 'string' ? msg.action : '';
    const offer = typeof msg?.offer === 'string' ? msg.offer : '';
    if (!pairing) return;
    const live = pairing.offerId();
    if (action === 'new-code') {
      await pairStart().catch(() => {});
      return;
    }
    if (offer && live && offer !== live) return;
    if (action === 'allow') await pairing.allow();
    else if (action === 'deny') pairing.deny();
    else if (action === 'cancel') pairing.cancel();
    else if (action === 'copy') {
      const text = pairing.link();
      if (text) await shell.request('phones-clipboard', { text, clearAfterMs: Math.max(5000, pairing.view().expiresInS * 1000) }).catch(() => {});
    }
  }

  // ----- carriers -----

  async function loadCarrier(kind) {
    if (carriers[kind]) return carriers[kind];
    try {
      const mod = await loadCarrierModule(kind);
      const api = mod?.default ?? mod;
      if (api && typeof api.start === 'function' && typeof api.stop === 'function' && typeof api.status === 'function' && typeof api.hints === 'function') {
        carriers[kind] = api;
        return api;
      }
    } catch {
      // A carrier that is not there, or does not load, is off.
    }
    return null;
  }

  function carrierCtx(kind) {
    return {
      kind,
      settings: () => phones()[kind],
      // A carrier keeps a small fact it must recall after a restart (the Tailscale name it served) in state.phones; nothing secret goes here.
      remember: patch => {
        const target = phones()[kind];
        if (!target || typeof patch !== 'object' || patch === null) return;
        Object.assign(target, patch);
        Promise.resolve(settings.save()).catch(() => {});
      },
      listener: { setLan: next => listener.setLan(next), status: () => listener.status(), port: () => listener.port() },
      handshaker: { accept: a => handshaker.accept(a) },
      registry: {
        relay: () => registry.relay(), ensureRelay: () => registry.ensureRelay(), pathKey: () => registry.pathKey(),
        publicKey: () => registry.publicKeyHex(), on: (name, fn) => registry.on(name, fn),
      },
      clock,
      publish,
      hostname,
      upstreamPort,
    };
  }

  async function refreshCarrierStatus() {
    for (const kind of CARRIER_KINDS) {
      const mod = carriers[kind];
      if (!mod) continue;
      try {
        carrierStatus[kind] = (await mod.status()) ?? {};
      } catch {
        carrierStatus[kind] = {};
      }
      try {
        const list = await mod.hints();
        carrierHints[kind] = Array.isArray(list) ? list.filter(isObject) : [];
      } catch {
        carrierHints[kind] = [];
      }
    }
  }

  // Starts or stops each carrier module to match state.phones. A module that is not there stays off.
  async function applyCarriers() {
    const p = phones();
    for (const kind of CARRIER_KINDS) {
      const mod = await loadCarrier(kind);
      if (!mod) continue;
      try {
        // A context is given on stop too: a carrier that must undo what it set (LAN mode, a Tailscale serve config) needs the listener.
        if (p[kind].enabled) await mod.start(carrierCtx(kind));
        else await mod.stop(carrierCtx(kind));
      } catch {
        // A carrier that fails to start reports it through its own status().
      }
    }
    await refreshCarrierStatus();
  }

  // ----- the listener -----

  async function bindListener() {
    const p = phones();
    const tries = [];
    if (Number.isInteger(p.port)) tries.push(p.port);
    while (tries.length < 8) tries.push(randomPort());
    let last = null;
    for (const port of tries) {
      if (port === upstreamPort()) continue;
      const candidate = createListener({
        handshaker,
        getPathKey: () => registry.pathKey(),
        clock,
        host: o.host ?? '127.0.0.1',
        port,
        lanHosts: o.lanHosts,
        remoteAddress: o.remoteAddress,
        getTailscaleName: () => carrierStatus.tailscale?.name ?? p.tailscale.name ?? '',
        getOrigins: () => CARRIER_KINDS.flatMap(kind => (Array.isArray(carrierStatus[kind]?.origins) ? carrierStatus[kind].origins : [])),
        shellRoot: o.shellRoot === undefined ? path.join(APP_ROOT, 'mobile', 'www') : o.shellRoot,
        uiPull: (req, res, pathname, search) => proxy.serveUi(req, res, pathname, search),
      });
      try {
        await candidate.start();
        listener = candidate;
        if (p.port !== candidate.port()) {
          p.port = candidate.port();
          await Promise.resolve(settings.save()).catch(() => {});
        }
        return;
      } catch (err) {
        last = err;
        if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
      }
    }
    throw last ?? new Error('Plenum could not find a free port for phones.');
  }

  // ----- lifecycle -----

  function build() {
    // A phone allowed now gets the auto-expire setting that is in force.
    const pairingRegistry = { add: input => registry.add({ expiresAfterDays: phones().autoExpireDays, ...input }), remove: id => registry.remove(id), idOfPublic: pub => registry.idOfPublic(pub) };
    pairing = createPairing({ registry: pairingRegistry, clock, random, onChange: onPairingChange });
    proxy = createProxy({
      upstreamPort,
      getToken,
      registry,
      clock,
      loadUiManifest,
      cards: { get: id => cards.get(id) ?? null },
      uiContext,
      onStop: (rec, value) => runStop(value, rec.device?.name ?? 'a phone').then(ack => {
        addActivity(rec.device?.name ?? 'Phone', 'stopped everything');
        return ack;
      }),
      onActivity: ({ rec, text }) => addActivity(rec.device?.name ?? 'Phone', text),
      ...(o.proxy ?? {}),
    });
    handshaker = createHandshaker({
      registry,
      pairing,
      identity: () => registry.identity(),
      clock,
      random,
      helloFor,
      makeHandlers: rec => proxy.attach(rec),
      // A signed STOP_ONLY from a phone that did not unlock (listener.mjs onStopOnly): the same function as the STOP frame, cached by id.
      onStopOnly: async ({ deviceId, stopId }) => {
        const name = registry.get(deviceId)?.name ?? 'a phone';
        const out = await runStop({ id: stopId }, name);
        addActivity(name, 'stopped everything');
        return out;
      },
      // A fixed sentence, once: a storage that fails to save fails every time, and the line holds no key material. This module never
      // writes to the console itself (the logging test); the server hands it a writer in options.log (lib/routes/remote.mjs).
      log: line => {
        if (loggedOnce.has(line)) return;
        loggedOnce.add(line);
        try {
          o.log?.(line);
        } catch {
          // A writer that throws changes nothing.
        }
      },
      onSession: rec => {
        if (!sessions.has(rec.deviceId)) sessions.set(rec.deviceId, new Set());
        sessions.get(rec.deviceId).add(rec);
        presenceChanged();
      },
      onClose: rec => {
        const set = sessions.get(rec.deviceId);
        if (set) {
          set.delete(rec);
          if (set.size === 0) sessions.delete(rec.deviceId);
        }
        presenceChanged();
      },
      ...(o.handshaker ?? {}),
    });
    unsubscribe.push(registry.on('removed', ({ id }) => {
      const set = sessions.get(id);
      for (const rec of set ? [...set] : []) {
        try {
          rec.frames.event({ type: 'phone', kind: 'revoked', id });
          rec.frames.close('revoked');
        } catch {
          // The phone was already going.
        }
      }
      publish({ type: 'phone', kind: 'revoked', id });
    }));
    unsubscribe.push(registry.on('reset', () => {
      pairing.cancel();
      listener?.closeConnections('revoked');
    }));
    unsubscribe.push(registry.on('tier', ({ id, tier }) => {
      const event = { type: 'phone', kind: 'tier', id, tier };
      broadcast(event, id);
      publish(event);
    }));
  }

  async function doStart() {
    stopped = false;
    const status = await registry.ready();
    if (!status.ok) throw Object.assign(new Error(status.message || 'Phone keys cannot be kept on this computer right now.'), { status: 503 });
    await registry.ensureIdentity();
    if (registry.list().some(d => d.expiresAfterDays !== phones().autoExpireDays)) await registry.updateAll({ expiresAfterDays: phones().autoExpireDays }).catch(() => {});
    build();
    // HELLO waits (up to a second) for the server's own hello event, but only when this Bridge is following the events stream.
    infoReady = o.followEvents === false ? null : new Promise(resolve => {
      infoResolve = resolve;
    });
    try {
      pusher = loadPush({
        devices: {
          list: () => registry.list().map(d => ({ id: d.id, tier: d.tier, approveFromNotifications: d.approveFromNotifications, pushSubscription: registry.pushSubscriptionOf(d.id) })),
        },
        removeSubscription: id => registry.update(id, { pushSubscription: null }).catch(() => {}),
        presence: shell.available() ? () => shell.request('phones-presence', {}, { timeoutMs: 2000 }) : undefined,
        foreground: id => Math.max(0, ...[...(sessions.get(id) ?? [])].map(rec => rec.lastReq || 0)),
        settings: () => ({ push: phones().push, computer: { id: registry.computerId(), name: hostname } }),
        vapidStore: registry.vapidStore,
        now: wallNow,
        allowLocalEndpoints: o.allowLocalPushEndpoints === true,
        ...(o.push ?? {}),
      });
    } catch {
      pusher = null;
    }
    await bindListener();
    if (shell.available()) {
      unsubscribe.push(shell.on('phones-pair-answer', msg => onWindowAnswer(msg).catch(() => {})));
    }
    await applyCarriers();
    if (o.followEvents !== false) sse = followEvents();
    timers.push(clock.setInterval(() => {
      registry.sweepExpired({ connected: id => sessions.has(id) }).catch(() => {});
    }, SWEEP_MS));
    timers.push(clock.setInterval(() => {
      refreshCarrierStatus().catch(() => {});
    }, CARRIER_STATUS_MS));
    registry.sweepExpired({ connected: id => sessions.has(id) }).catch(() => {});
  }

  // Starts the Bridge once; later calls wait for or return the first.
  function start(next = {}) {
    if (next.running) running = next.running;
    if (next.publicState) publicState = next.publicState;
    if (next.port !== undefined && o.port === undefined) serverPort = next.port;
    if (!started) {
      started = doStart().catch(async err => {
        started = null;
        stopped = true;
        await teardown().catch(() => {});
        throw err;
      });
    }
    return started;
  }

  // Lets go of everything start() made. Safe to call at any point of a start, and twice.
  async function teardown() {
    for (const fn of unsubscribe.splice(0)) {
      try {
        fn();
      } catch {
        // Nothing to undo.
      }
    }
    for (const h of timers.splice(0)) {
      clock.clearInterval(h);
      clock.clearTimeout(h);
    }
    sse?.close();
    sse = null;
    pairing?.shutdown();
    for (const kind of CARRIER_KINDS) {
      try {
        await carriers[kind]?.stop();
      } catch {
        // A carrier that cannot stop is dropped with the process.
      }
    }
    await listener?.stop();
    listener = null;
    sessions.clear();
    cards.clear();
    drives.clear();
    handovers.clear();
    runs.clear();
    lastPresence = '';
    await registry.flush().catch(() => {});
  }

  async function stop() {
    const was = started;
    started = null;
    stopped = true;
    try {
      await was;
    } catch {
      // It never started.
    }
    await teardown();
  }

  // ----- the view GET /api/phones answers -----

  async function state() {
    const p = phones();
    const plain = !shell.available();
    // The paired phones are listed even while phones are off, so a person can see and remove them.
    if (!started) await registry.ready();
    const reg = registry.status();
    if (started && !stopped) await refreshCarrierStatus();
    const lanStatus = carrierStatus.lan ?? {};
    const tsStatus = carrierStatus.tailscale ?? {};
    const relayStatus = carrierStatus.relay ?? {};
    const view = pairing ? pairing.view() : { active: false, state: 'idle', expiresInS: 0, second: false, name: '' };
    return {
      available: true,
      enabled: p.enabled,
      running: !stopped && listener !== null,
      port: listener?.port() || p.port || 0,
      storage: reg.loaded ? reg.storage : (plain ? 'file' : 'keychain'),
      storageNote: reg.loaded && !reg.ok ? reg.message : '',
      plainNode: plain,
      carriers: {
        lan: { on: p.lan.enabled, anyAddress: p.lan.anyAddress, addresses: Array.isArray(lanStatus.addresses) ? lanStatus.addresses : [], available: Boolean(carriers.lan), error: String(lanStatus.error ?? ''), firewall: String(lanStatus.firewall ?? '') },
        tailscale: { on: p.tailscale.enabled, name: tsStatus.name ?? p.tailscale.name ?? '', available: Boolean(carriers.tailscale), installed: tsStatus.installed, message: String(tsStatus.message ?? '') },
        relay: { on: p.relay.enabled, url: p.relay.url, connected: relayStatus.connected === true, available: Boolean(carriers.relay), reason: String(relayStatus.reason ?? '') },
      },
      devices: registry.list().map(d => ({ ...d, connected: sessions.has(d.id) })),
      offer: {
        active: view.active,
        state: view.state,
        expiresInS: view.expiresInS,
        second: view.second === true,
        tried: view.tried === true,
        left: view.left === true,
        ...(plain && view.code ? { code: view.code } : {}),
        ...(plain && view.device ? { device: view.device } : {}),
      },
      push: { ...p.push },
      autoExpireDays: p.autoExpireDays,
      indicator: { connected: connectedList().map(c => c.name) },
    };
  }

  return {
    start,
    stop,
    state,
    registry,
    get pairing() {
      return pairing;
    },
    get listener() {
      return listener;
    },
    get handshaker() {
      return handshaker;
    },
    get proxy() {
      return proxy;
    },
    cards: () => [...cards.values()],
    // Feeds one event of the server's own stream (what the SSE follower does with each line). For tests.
    handleEvent,
    sessions: () => sessions,
    isRunning: () => !stopped && listener !== null,
    configure(next = {}) {
      if (next.running) running = next.running;
      if (next.publicState) publicState = next.publicState;
      if (next.port !== undefined && o.port === undefined) serverPort = next.port;
    },
    applyCarriers,
    pairStart,
    pairCancel: () => pairing?.cancel() ?? { ok: true },
    pairConfirm: allow => (allow ? pairing.allow() : Promise.resolve(pairing.deny())),
    async setLan(next) {
      return listener?.setLan(next);
    },
    async removeDevice(id) {
      return registry.remove(id);
    },
    async removeAll() {
      return registry.removeAll({ rotate: true });
    },
    // A new relay room id and host secret (D9). The relay carrier follows the registry's 'relay-room' event; applyCarriers makes sure one runs.
    async newRelayRoom() {
      await registry.newRelayRoom();
      if (!stopped && listener) await applyCarriers();
      return state();
    },
    async setTier(id, tier) {
      if (!isTier(tier)) throw Object.assign(new Error('The tier must be full, approve or read.'), { status: 400 });
      return registry.update(id, { tier });
    },
    async setApproveFromNotifications(id, value) {
      return registry.update(id, { approveFromNotifications: value === true });
    },
    async setSubscription(id, subscription) {
      let normalized = null;
      if (subscription !== null) normalized = normalizeSubscription(subscription, { allowLocalEndpoints: o.allowLocalPushEndpoints === true });
      return registry.update(id, { pushSubscription: normalized });
    },
    async setAutoExpire(days) {
      return registry.updateAll({ expiresAfterDays: days });
    },
    async testPush(only = null) {
      if (!pusher) throw Object.assign(new Error('Notifications are not available in this build.'), { status: 503 });
      const results = await pusher.sendEvent({ kind: 'test', computerName: hostname });
      return results.filter(r => !only || r.deviceId === only);
    },
    activity: () => phones().activity.slice(),
    addActivity,
    hello: helloFor,
    runStop,
    cleanName,
    firstLineOf,
    wallNow,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The one Bridge of this process

let current = null;

// Starts (or returns) the Bridge. `next` may carry { running, publicState, port } from the server.
export async function startRemote(next = {}) {
  current ??= createRemote(next.options ?? {});
  await current.start(next);
  return current;
}

export async function stopRemote() {
  const was = current;
  current = null;
  if (was) await was.stop();
}

export function getRemote(next = {}) {
  current ??= createRemote(next.options ?? {});
  current.configure(next);
  return current;
}

export async function remoteState() {
  return current ? current.state() : null;
}
