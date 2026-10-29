// The Browser pane's endpoints (public/ext-browser.js). The pages live in the desktop app (desktop/browser.cjs); these routes check what
// the page sends and pass it on over lib/browser-bridge.mjs. Under plain `node server.mjs` there is no desktop app: every route answers
// { available: false } with status 200, after checking what was sent (a bad address is a 400 either way).
//
//   GET  /api/browser/state                       { available, tabs, activeTab, events, takeover, agentDriving, agent, downloads, permissions,
//                                                   remembered, settings: { blockDownloads, downloadDir }, maxTabs }, or { available: false }
//   POST /api/browser/open        { url }         a new tab (or the blank active one) opens the address
//   POST /api/browser/navigate    { tab?, url }   the tab (the active one when left out) goes to the address
//   POST /api/browser/back | forward | reload  { tab? }
//   POST /api/browser/tabs        { action: 'new' | 'close' | 'select', tab?, url? }
//   POST /api/browser/bounds      { x, y, width, height, visible, snapshot?, keep? }   where the page view goes (numbers, finite, not negative).
//                                                   visible false with snapshot true also answers { image }: a picture of the page to show
//                                                   in its place while something covers it. The picture is not kept or logged here.
//                                                   keep true (a phone's call, the Bridge adds it) leaves the desktop's page view on its window.
//   POST /api/browser/hide
//   POST /api/browser/download    { id, allow }   answers "Save <name> to Downloads?"; the folder is the one chosen in the pane, checked
//                                                   with folderRisk, or the system Downloads folder
//   POST /api/browser/downloads   { block?, folder? }   the pane's switch "Block all downloads" and its download folder (null = Downloads)
//   POST /api/browser/permission  { id, allow }   answers a site's permission question (camera, microphone, location, notifications, clipboard)
//   POST /api/browser/permission-reset            forgets the answers given for this session
//   POST /api/browser/clear                       clears the browser's cookies, storage and cache (the pane's "Clear browsing data")
//   brw-03, the model driving the browser:
//   GET  /api/browser/log?project=                { available, entries }   the Actions log of a project (the active one when left out):
//                                                   the last 200 things the model did, { at, tool, url, summary, ok, note? }
//   POST /api/browser/settings    { agent?, anySite?, allow?, checks?, snapshotElements?, snapshotChars?, hideNotice?, showNotices? }
//                                                 the pane's switches: "Let the model use this browser", "Any site without asking" (puts
//                                                 '*' in the list), the sites it may open without asking (host patterns, at most 500),
//                                                 the Checks (an object of category ids to true or false), the snapshot sizes, and the
//                                                 notices the person has dismissed ("Don't show again")
//   POST /api/browser/allow       { host }        adds one site to the list (the card's "Always allow this site")
//   POST /api/browser/ask-anyway  { on }          "Ask me anyway this run": Approve all asks again for the run in progress
//   POST /api/browser/type-secret { value, project? }   "Type it for me": types the person's secret into the field the model was
//                                                 refused; the value goes to the page and is kept nowhere
//   mob-20, a phone acting as the person (only for a request the Bridge makes for a Full-tier phone; the others answer 403):
//   POST /api/browser/frame       { tab?, maxEdge? }   a JPEG of the page: { image, width, height, shown, cached?, viewers, nextMs }. A picture is
//                                                 made only when a phone asks, at most 5 a second whoever asks (an earlier ask gets the last one)
//   POST /api/browser/input       { kind: 'tap' | 'scroll' | 'type' | 'key', tab?, x, y, width, height (a point of the picture the phone
//                                                 shows), dx?, dy? (scroll, in that picture's pixels, dy > 0 moves down the page), text?, key?,
//                                                 count? }   the person's tap, swipe, typing or key. 409 while the model is using the browser
//                                                 (Pause it first). Never goes through the model's tools; the text is in no reply, log or event.
//
// The settings sit in the app state under `browser`: blockDownloads and downloadDir (brw-02), agent, allow, checksOff, snapshotElements
// and snapshotChars (brw-03). The desktop app reads blockDownloads from the state file when a download starts. Nothing here reads a
// cookie or a page: addresses, names and numbers only.
// The server checks the Plenum token before any route runs; requireToken checks it again, so each route is safe on its own.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import * as realBridge from '../browser-bridge.mjs';
import { ALLOW_MAX, CATEGORY_IDS, NOTICE_IDS, SNAPSHOT_LIMITS, checkAllowList, cleanPattern, controlOf } from '../browser-tools.mjs';
import { checkUrl } from '../browser-urls.mjs';
import { requireToken } from '../auth.mjs';
import * as realDrives from '../drive.mjs';
import { publish } from '../events.mjs';
import { folderRisk } from '../guard.mjs';
import * as store from '../store.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIONS = new Set(['new', 'close', 'select']);
const LIMIT = 1_000_000;
const NO_FOLDER = 'Give the full path of a folder, such as C:\\Users\\you\\Documents\\Saved.';
const GONE = 'That question is no longer waiting.';
const IN_CHAT = 'That download is waiting for your answer in the chat.';
const NOTHING = 'Send block (true or false) or folder (a path, or null for the Downloads folder).';
// mob-20: the routes a phone acts through as the person.
const PHONE_ONLY = 'This is for a paired phone.';
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const INPUT_KINDS = new Set(['tap', 'scroll', 'type', 'key']);
const PERSON_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
const TEXT_MAX = 1000;
const FRAME_EDGES = { min: 200, max: 1600 };
// A picture for a phone is made at most this often, whoever asks (5 a second); a phone is told to ask again after FRAME_NEXT_MS (4 a second).
const FRAME_MIN_MS = 200;
const FRAME_NEXT_MS = 250;
const VIEWER_MS = 10_000;
const MODEL_USING = 'The model is using the browser. Pause it first.';
const CARD_WAITS = 'A card is waiting for your answer. Answer it first, or press Stop.';

// The settings the pane shows and the desktop app reads. Both sit in the app state under `browser`.
export function settingsOf(st) {
  const b = isObject(st?.browser) ? st.browser : {};
  return { blockDownloads: b.blockDownloads === true, downloadDir: typeof b.downloadDir === 'string' && b.downloadDir ? b.downloadDir : null };
}

// What GET /api/browser/state answers, and what the events channel carries as { type: 'browser', kind: 'state', state }.
export function describeState(bridge, st) {
  const snap = bridge.snapshot();
  return {
    available: true,
    tabs: snap.tabs,
    activeTab: snap.activeTab,
    events: snap.events,
    takeover: snap.takeover,
    agentDriving: snap.agentDriving,
    // brw-03's switch "Let the model use this browser": on unless the person turned it off.
    agent: st?.browser?.agent !== false,
    downloads: snap.downloads,
    permissions: snap.permissions,
    remembered: snap.remembered,
    settings: settingsOf(st),
    maxTabs: realBridge.MAX_TABS,
    // brw-03: the switches (agent, allow, anySite, checks, snapshot sizes), "Ask me anyway", and the field that waits for the person.
    control: controlOf(st),
    askAnyway: snap.askAnyway === true,
    secret: snap.secret ?? null,
  };
}

// A folder the pane may save downloads into: absolute, there, a folder, writable, and not a credential, Plenum, system or user-root folder.
// Returns the folder as a resolved path, or throws a 400 with the reason.
export async function checkFolder(raw, httpError) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || raw.includes('\0') || !path.isAbsolute(raw.trim())) throw httpError(400, NO_FOLDER);
  const dir = path.resolve(raw.trim());
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw httpError(400, 'That folder does not exist.');
  }
  if (!stat.isDirectory()) throw httpError(400, 'That is a file, not a folder.');
  const risk = folderRisk(dir);
  if (risk) throw httpError(400, risk);
  try {
    await fs.access(dir, fsConstants.W_OK);
  } catch {
    throw httpError(400, 'Plenum cannot write to that folder.');
  }
  return dir;
}

// The folder a saved download goes to: the folder chosen in the pane (checked again now), else null for the system Downloads folder.
// The system folder is checked too when the desktop named it in the question (defaultDir), so no download lands in a credential or
// Plenum folder whatever the operating system's Downloads setting says.
async function folderForDownload(pending, st, httpError) {
  const chosen = settingsOf(st).downloadDir;
  if (chosen) return checkFolder(chosen, httpError);
  if (pending?.defaultDir) {
    const risk = folderRisk(pending.defaultDir);
    if (risk) throw httpError(400, `Plenum will not save into the Downloads folder: ${risk} Choose another folder under Downloads and site permissions.`);
  }
  return null;
}

function numberField(body, name, httpError) {
  const v = body[name];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > LIMIT) throw httpError(400, `${name} must be a number from 0 to ${LIMIT}.`);
  return v;
}

function tabField(body, httpError, { required = false } = {}) {
  const v = body.tab;
  if (v === undefined || v === null || v === '') {
    if (required) throw httpError(400, 'Send the tab id.');
    return undefined;
  }
  if (typeof v !== 'string' || !ID.test(v)) throw httpError(400, 'That is not a tab id.');
  return v;
}

// The request came through the Bridge for a paired phone. The Bridge sets x-plenum-device and drops any such header a phone sends, so the
// desktop page, the model's tools and the MCP bridge (which have none) can never reach the routes that act as the person.
function phoneOf(ctx) {
  const v = ctx.req.headers?.['x-plenum-device'];
  if (typeof v !== 'string' || !DEVICE.test(v)) throw ctx.httpError(403, PHONE_ONLY);
  return v;
}

// A point of the picture the phone shows, with the picture's size: finite numbers, the size above 0, the point inside it.
function pointOf(body, httpError) {
  const picture = { width: numberField(body, 'width', httpError), height: numberField(body, 'height', httpError) };
  if (picture.width <= 0 || picture.height <= 0) throw httpError(400, 'width and height must be above 0.');
  const at = { x: numberField(body, 'x', httpError), y: numberField(body, 'y', httpError) };
  if (at.x > picture.width || at.y > picture.height) throw httpError(400, 'That spot is outside the picture.');
  return { ...picture, ...at };
}

function idField(body, httpError) {
  if (typeof body.id !== 'string' || !ID.test(body.id)) throw httpError(400, 'Send the id of the question.');
  return body.id;
}

function urlField(value, httpError) {
  try {
    return checkUrl(value);
  } catch (err) {
    throw httpError(err.status ?? 400, err.message);
  }
}

// The reply as the page gets it: the desktop's fields without its message type and id.
function shape(reply) {
  const { type: _type, id: _id, ...rest } = reply ?? {};
  return { available: true, ...rest };
}

// The new `browser` object for a body of POST /api/browser/settings (the keys brw-02 and brw-03 do not touch are kept). Throws a 400
// with a plain sentence when a value is not allowed. Nothing is stored here.
//   agent             true or false
//   anySite           true puts '*' in the list (every site opens without asking), false takes it out; the named sites stay
//   allow             the named sites, host patterns such as example.com or *.example.com (a '*' entry means anySite)
//   checks            { send, buy, signin, delete, agree, personal }: true or false each; false is stored in checksOff
//   snapshotElements  1 to 2000, snapshotChars 1000 to 60000
//   hideNotice        the id of one of the pane's notices (NOTICE_IDS): "Don't show again"; showNotices true shows them all again
export function applySettings(st, body, httpError) {
  const bad = message => httpError(400, message);
  const next = isObject(st?.browser) ? { ...st.browser } : {};
  const current = controlOf(st);
  let touched = false;
  if (body.agent !== undefined) {
    if (typeof body.agent !== 'boolean') throw bad('agent must be true or false.');
    next.agent = body.agent;
    touched = true;
  }
  if (body.allow !== undefined || body.anySite !== undefined) {
    if (body.anySite !== undefined && typeof body.anySite !== 'boolean') throw bad('anySite must be true or false.');
    let named = current.allow.filter(h => h !== '*');
    let any = current.anySite;
    if (body.allow !== undefined) {
      let list;
      try {
        list = checkAllowList(body.allow);
      } catch (err) {
        throw bad(err.message);
      }
      if (list.includes('*')) any = true;
      named = list.filter(h => h !== '*');
    }
    if (body.anySite !== undefined) any = body.anySite;
    const all = any ? ['*', ...named] : named;
    if (all.length > ALLOW_MAX) throw bad(`At most ${ALLOW_MAX} sites can be listed.`);
    if (all.length) next.allow = all;
    else delete next.allow;
    touched = true;
  }
  if (body.checks !== undefined) {
    const help = `checks must be an object with ${CATEGORY_IDS.join(', ')}, each true or false.`;
    if (!isObject(body.checks)) throw bad(help);
    const off = new Set(Object.entries(current.checks).filter(([, on]) => !on).map(([id]) => id));
    for (const [id, on] of Object.entries(body.checks)) {
      if (!CATEGORY_IDS.includes(id) || typeof on !== 'boolean') throw bad(help);
      if (on) off.delete(id);
      else off.add(id);
    }
    if (off.size) next.checksOff = CATEGORY_IDS.filter(id => off.has(id));
    else delete next.checksOff;
    touched = true;
  }
  for (const [key, range, label] of [['snapshotElements', SNAPSHOT_LIMITS.elements, 'controls'], ['snapshotChars', SNAPSHOT_LIMITS.chars, 'characters']]) {
    if (body[key] === undefined) continue;
    const v = body[key];
    if (!Number.isInteger(v) || v < range[0] || v > range[1]) throw bad(`${key} must be a whole number of ${label} from ${range[0]} to ${range[1]}.`);
    next[key] = v;
    touched = true;
  }
  if (body.hideNotice !== undefined) {
    if (typeof body.hideNotice !== 'string' || !NOTICE_IDS.includes(body.hideNotice)) throw bad(`hideNotice must be one of ${NOTICE_IDS.join(', ')}.`);
    next.hiddenNotices = NOTICE_IDS.filter(id => id === body.hideNotice || current.hiddenNotices.includes(id));
    touched = true;
  }
  if (body.showNotices !== undefined) {
    if (body.showNotices !== true) throw bad('showNotices must be true.');
    delete next.hiddenNotices;
    touched = true;
  }
  if (!touched) throw bad('Send agent, anySite, allow, checks, snapshotElements, snapshotChars, hideNotice or showNotices.');
  return next;
}

// Tells every window the state changed now (the pane's own switches), without waiting for the desktop to report anything.
function publishNow(bridge, st, enabled) {
  if (!enabled) return;
  try {
    publish({ type: 'browser', kind: 'state', state: describeState(bridge, st) });
  } catch {
    // The state is published with the next change.
  }
}

// Builds the routes over a bridge. The server uses the real one; the tests pass a fake.
export function createRoutes(bridge = realBridge, { events = true, drives = realDrives } = {}) {
  // The picture last made for a phone, the one being made, and the phones that asked lately (device -> time).
  const frame = { last: null, job: null, viewers: new Map() };
  const viewersNow = (device, now) => {
    frame.viewers.set(device, now);
    for (const [id, at] of frame.viewers) if (now - at > VIEWER_MS) frame.viewers.delete(id);
    return frame.viewers.size;
  };

  // Body of a POST as an object, or a 400.
  async function bodyOf(ctx) {
    const body = await ctx.readBody(ctx.req);
    if (!isObject(body)) throw ctx.httpError(400, 'Send a JSON object.');
    return body;
  }

  // Passes one request to the desktop app and answers its reply. A refusal from the desktop (ok: false) is a 400 with its sentence.
  async function toDesktop(ctx, type, payload) {
    if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
    const reply = await bridge.ask(type, payload);
    if (reply?.ok === false) throw ctx.httpError(400, typeof reply.message === 'string' && reply.message ? reply.message : 'The browser could not do that.');
    return ctx.json(ctx.res, 200, shape(reply));
  }

  const guarded = handler => async ctx => {
    requireToken(ctx.req, ctx.httpError);
    return handler(ctx);
  };

  const list = [
    {
      method: 'GET',
      path: '/api/browser/state',
      handler: guarded(async ctx => {
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        if (!bridge.snapshot().known) {
          try {
            await bridge.refresh();
          } catch {
            // The desktop did not answer; the state below is empty and the next change fills it.
          }
        }
        return ctx.json(ctx.res, 200, describeState(bridge, ctx.store.get()));
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/open',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        return toDesktop(ctx, 'browser-open', { url: urlField(body.url, ctx.httpError) });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/navigate',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const tab = tabField(body, ctx.httpError);
        return toDesktop(ctx, 'browser-navigate', { tab, url: urlField(body.url, ctx.httpError) });
      }),
    },
    ...['back', 'forward', 'reload'].map(action => ({
      method: 'POST',
      path: `/api/browser/${action}`,
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        return toDesktop(ctx, `browser-${action}`, { tab: tabField(body, ctx.httpError) });
      }),
    })),
    {
      method: 'POST',
      path: '/api/browser/tabs',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        if (!ACTIONS.has(body.action)) throw ctx.httpError(400, 'action must be new, close or select.');
        const payload = { action: body.action };
        if (body.action === 'new') {
          if (body.url !== undefined && body.url !== null && body.url !== '') payload.url = urlField(body.url, ctx.httpError);
        } else {
          payload.tab = tabField(body, ctx.httpError, { required: true });
        }
        return toDesktop(ctx, 'browser-tabs', payload);
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/bounds',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        if (typeof body.visible !== 'boolean') throw ctx.httpError(400, 'visible must be true or false.');
        const payload = { visible: body.visible };
        if (body.visible) {
          for (const name of ['x', 'y', 'width', 'height']) payload[name] = numberField(body, name, ctx.httpError);
        } else {
          for (const name of ['x', 'y', 'width', 'height']) if (body[name] !== undefined) payload[name] = numberField(body, name, ctx.httpError);
          payload.snapshot = body.snapshot === true;
          payload.keep = body.keep === true;
        }
        return toDesktop(ctx, 'browser-bounds', payload);
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/frame',
      handler: guarded(async ctx => {
        const device = phoneOf(ctx);
        const body = await bodyOf(ctx);
        const tab = tabField(body, ctx.httpError);
        let maxEdge;
        if (body.maxEdge !== undefined) {
          if (!Number.isInteger(body.maxEdge) || body.maxEdge < FRAME_EDGES.min || body.maxEdge > FRAME_EDGES.max) {
            throw ctx.httpError(400, `maxEdge must be a whole number from ${FRAME_EDGES.min} to ${FRAME_EDGES.max}.`);
          }
          maxEdge = body.maxEdge;
        }
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        const now = Date.now();
        const viewers = viewersNow(device, now);
        const key = `${tab ?? ''}|${maxEdge ?? ''}`;
        const answer = reply => ctx.json(ctx.res, 200, { ...shape(reply), viewers, nextMs: FRAME_NEXT_MS });
        // Whoever asks, a picture is made at most five times a second: an earlier ask gets the last one, and asks that overlap share one.
        if (frame.last && frame.last.key === key && now - frame.last.at < FRAME_MIN_MS) return answer({ ...frame.last.reply, cached: true });
        let job = frame.job && frame.job.key === key ? frame.job : null;
        if (!job) {
          job = { key, promise: null };
          const made = job;
          made.promise = bridge.ask('browser-frame', { ...(tab ? { tab } : {}), ...(maxEdge ? { maxEdge } : {}) })
            .then(reply => {
              if (reply?.ok !== false) frame.last = { key, at: Date.now(), reply };
              return reply;
            })
            .finally(() => {
              if (frame.job === made) frame.job = null;
            });
          frame.job = made;
        }
        const reply = await job.promise;
        if (reply?.ok === false) throw ctx.httpError(400, typeof reply.message === 'string' && reply.message ? reply.message : 'The browser could not make a picture.');
        return answer(reply);
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/input',
      handler: guarded(async ctx => {
        phoneOf(ctx);
        const body = await bodyOf(ctx);
        if (typeof body.kind !== 'string' || !INPUT_KINDS.has(body.kind)) throw ctx.httpError(400, 'kind must be tap, scroll, type or key.');
        const payload = { kind: body.kind };
        const tab = tabField(body, ctx.httpError);
        if (tab) payload.tab = tab;
        if (body.kind === 'tap') {
          Object.assign(payload, pointOf(body, ctx.httpError));
        } else if (body.kind === 'scroll') {
          Object.assign(payload, pointOf(body, ctx.httpError));
          for (const name of ['dx', 'dy']) {
            if (body[name] === undefined) continue;
            if (typeof body[name] !== 'number' || !Number.isFinite(body[name]) || Math.abs(body[name]) > LIMIT) throw ctx.httpError(400, `${name} must be a number.`);
            payload[name] = body[name];
          }
          if (!payload.dx && !payload.dy) throw ctx.httpError(400, 'Say how far to scroll: dx or dy.');
        } else if (body.kind === 'type') {
          if (typeof body.text !== 'string' || body.text === '') throw ctx.httpError(400, 'Type something first.');
          if (body.text.length > TEXT_MAX) throw ctx.httpError(400, `Type at most ${TEXT_MAX} characters at a time.`);
          payload.text = body.text;
        } else {
          if (typeof body.key !== 'string' || !PERSON_KEYS.has(body.key)) throw ctx.httpError(400, `key must be one of ${[...PERSON_KEYS].join(', ')}.`);
          payload.key = body.key;
          if (body.count !== undefined) {
            if (!Number.isInteger(body.count) || body.count < 1 || body.count > 20) throw ctx.httpError(400, 'count must be a whole number from 1 to 20.');
            payload.count = body.count;
          }
        }
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        // A person acts only when the model does not: a running browser drive is refused, a paused one (the person's Pause, or the model's
        // hand-over) lets the person in, and the desktop is told which so it can refuse too.
        const live = drives.listDrives().filter(d => d.kind === 'browser');
        if (live.some(d => d.state === 'running')) throw ctx.httpError(409, MODEL_USING);
        if (live.some(d => d.pausedBy === 'card')) throw ctx.httpError(409, CARD_WAITS);
        payload.paused = live.length > 0;
        return toDesktop(ctx, 'browser-input', payload);
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/hide',
      handler: guarded(async ctx => {
        await bodyOf(ctx);
        return toDesktop(ctx, 'browser-hide', {});
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/download',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const id = idField(body, ctx.httpError);
        if (typeof body.allow !== 'boolean') throw ctx.httpError(400, 'allow must be true or false.');
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        const pending = bridge.snapshot().downloads.find(d => d.id === id);
        if (!pending) throw ctx.httpError(404, GONE);
        // While the model drives, the question is a card in the chat (brw-03); the pane does not answer it.
        if (pending.driving) throw ctx.httpError(409, IN_CHAT);
        const dir = body.allow ? await folderForDownload(pending, ctx.store.get(), ctx.httpError) : null;
        const reply = await bridge.answerDownload(id, body.allow, { dir });
        if (reply?.ok === false) throw ctx.httpError(400, typeof reply.message === 'string' && reply.message ? reply.message : GONE);
        return ctx.json(ctx.res, 200, shape(reply));
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/downloads',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const hasBlock = body.block !== undefined;
        const hasFolder = body.folder !== undefined;
        if (!hasBlock && !hasFolder) throw ctx.httpError(400, NOTHING);
        if (hasBlock && typeof body.block !== 'boolean') throw ctx.httpError(400, 'block must be true or false.');
        if (hasFolder && body.folder !== null && typeof body.folder !== 'string') throw ctx.httpError(400, NO_FOLDER);
        const dir = hasFolder && body.folder !== null ? await checkFolder(body.folder, ctx.httpError) : null;
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        const st = ctx.store.get();
        const next = isObject(st.browser) ? { ...st.browser } : {};
        if (hasBlock) {
          if (body.block) next.blockDownloads = true;
          else delete next.blockDownloads;
        }
        if (hasFolder) {
          if (dir) next.downloadDir = dir;
          else delete next.downloadDir;
        }
        st.browser = next;
        await ctx.store.saveOrFail();
        return ctx.json(ctx.res, 200, { available: true, settings: settingsOf(st) });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/permission',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const id = idField(body, ctx.httpError);
        if (typeof body.allow !== 'boolean') throw ctx.httpError(400, 'allow must be true or false.');
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        const reply = await bridge.answerPermission(id, body.allow);
        if (reply?.ok === false) throw ctx.httpError(400, typeof reply.message === 'string' && reply.message ? reply.message : GONE);
        return ctx.json(ctx.res, 200, shape(reply));
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/permission-reset',
      handler: guarded(async ctx => {
        await bodyOf(ctx);
        return toDesktop(ctx, 'browser-permission-reset', {});
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/clear',
      handler: guarded(async ctx => {
        await bodyOf(ctx);
        return toDesktop(ctx, 'browser-clear', {});
      }),
    },
    {
      method: 'GET',
      path: '/api/browser/log',
      handler: guarded(async ctx => {
        const st = ctx.store.get();
        const asked = ctx.url?.searchParams?.get('project');
        const project = asked === null || asked === undefined || asked === '' ? (typeof st.activeProject === 'string' ? st.activeProject : '') : asked;
        if (project && !ID.test(project)) throw ctx.httpError(400, 'That is not a project id.');
        const entries = typeof bridge.getLog === 'function' ? bridge.getLog(project) : [];
        return ctx.json(ctx.res, 200, { available: bridge.available(), project, entries });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/settings',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const next = applySettings(ctx.store.get(), body, ctx.httpError);
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        const st = ctx.store.get();
        st.browser = next;
        await ctx.store.saveOrFail();
        publishNow(bridge, st, events);
        return ctx.json(ctx.res, 200, { available: true, control: controlOf(st), settings: settingsOf(st) });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/allow',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        const host = cleanPattern(body.host);
        if (!host || host === '*') throw ctx.httpError(400, 'Send a site such as example.com, or *.example.com for its subdomains.');
        const st = ctx.store.get();
        const current = controlOf(st);
        const next = applySettings(st, { allow: [...current.allow.filter(h => h !== '*'), host], anySite: current.anySite }, ctx.httpError);
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        st.browser = next;
        await ctx.store.saveOrFail();
        publishNow(bridge, st, events);
        return ctx.json(ctx.res, 200, { available: true, control: controlOf(st) });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/ask-anyway',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        if (typeof body.on !== 'boolean') throw ctx.httpError(400, 'on must be true or false.');
        if (typeof bridge.setAskAnyway !== 'function') return ctx.json(ctx.res, 200, { available: false });
        const askAnyway = bridge.setAskAnyway(body.on);
        publishNow(bridge, ctx.store.get(), events);
        return ctx.json(ctx.res, 200, { available: bridge.available(), askAnyway });
      }),
    },
    {
      method: 'POST',
      path: '/api/browser/type-secret',
      handler: guarded(async ctx => {
        const body = await bodyOf(ctx);
        if (typeof body.value !== 'string' || !body.value) throw ctx.httpError(400, 'Type the value first.');
        if (body.project !== undefined && (typeof body.project !== 'string' || (body.project && !ID.test(body.project)))) throw ctx.httpError(400, 'That is not a project id.');
        if (!bridge.available()) return ctx.json(ctx.res, 200, { available: false });
        if (typeof bridge.typeSecret !== 'function') throw ctx.httpError(409, 'No field is waiting for you.');
        try {
          await bridge.typeSecret(body.value, { project: body.project });
        } catch (err) {
          // The sentence is fixed text; it never holds what was typed.
          throw ctx.httpError(err?.status ?? 400, err?.message || 'The browser could not type that.');
        }
        publishNow(bridge, ctx.store.get(), events);
        return ctx.json(ctx.res, 200, { available: true, ok: true });
      }),
    },
  ];

  if (events) wireEvents(bridge);
  return list;
}

// The events channel: each change the desktop reports is published as { type: 'browser', kind: 'state', state } (changes within 40 ms
// become one), and a shortcut pressed inside the page as { type: 'browser', kind: 'key', key } so the app page can act on it.
// Wired once per bridge, so loading the module twice does not publish twice.
const wired = new WeakSet();
function wireEvents(bridge) {
  if (wired.has(bridge) || typeof bridge.onChange !== 'function') return;
  wired.add(bridge);
  let timer = null;
  bridge.onChange(change => {
    if (change.kind === 'key') {
      publish({ type: 'browser', kind: 'key', key: { key: change.key, ctrl: change.ctrl, shift: change.shift, alt: change.alt, meta: change.meta } });
      return;
    }
    // One thing the model did: the Actions log of the project grows (the pane appends it, and shows it in the "Model is driving" badge).
    if (change.kind === 'log') {
      publish({ type: 'browser', kind: 'log', project: change.project, entry: change.entry });
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        publish({ type: 'browser', kind: 'state', state: describeState(bridge, store.get()) });
      } catch {
        // A state that cannot be read now is published with the next change.
      }
    }, 40);
    timer.unref?.();
  });
}

export const routes = createRoutes(realBridge);

// For brw-03 and the chat: answers a download that waits while the model drives (the approval card's answer), with the folder rule
// of the pane applied. Resolves the desktop's reply { ok, message? }.
export async function answerDownload(id, allow, st = store.get(), bridge = realBridge) {
  const pending = bridge.snapshot().downloads.find(d => d.id === id);
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const dir = allow ? await folderForDownload(pending, st, httpError) : null;
  return bridge.answerDownload(id, allow, { dir });
}
