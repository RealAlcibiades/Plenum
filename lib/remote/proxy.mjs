// The Bridge's proxy: turns what a paired phone asks for into requests to this server on the loopback address, and streams the
// answers back (MOBILE.json decision.transport.bridge, protocol.carriage, powers.tiers, powers.adapters). Owned by mob-03; the
// adapters table was filled by mob-19.
//
// The Bridge is a proxy, not a second API. A REQ frame becomes one http.request to 127.0.0.1:<the server's real port> with
//   Host            127.0.0.1:<port>
//   x-plenum-token  the real per-launch token (lib/auth.mjs), which the phone never sees in any frame
//   x-plenum-device the phone's id, set here only
//   content-type, accept and x-plenum-client-id, copied from the REQ when they look like what they are
// and nothing else: a token, cookie, host, origin or other x-plenum-* header the phone sends is dropped. The path is the normalised
// pathname and query the server itself will read (lib/remote/tiers.mjs pathnameOf), so the tier check and the server judge the same
// route. The server therefore applies every check it applies to a desktop request: Host and Origin, the token, the terms gate, the deny
// rules, checkAccess and the credential floor. A refusal comes back as the server wrote it.
//
// Per request, in order: method (GET or POST), path shape, the phone's tier (403 { error } when it may not), a body over 40,000,000 bytes
// (RES 413), the /_bridge/ virtual paths (answered here, never proxied), the guards and adapters (which buffer a small body), then the
// proxied request. A response is streamed as it arrives: SSE streams are never buffered, DATA frames under 1 KiB are coalesced for 30 ms
// by the frame session, and a slow phone pauses the upstream response while its socket's buffer is over 256 KiB.
//
// Adapters (keyed 'METHOD /path', applied only to phone requests; MOBILE.json powers.adapters) are listed where ADAPTERS is made below.
// An adapter is
//   { maxBody?: number, run(ctx) }  with ctx = { rec, method, pathname, search, body: Buffer, headers, clientId, notifyLine, respond(status,
//                                                  json|Buffer, headers?), forward(body?: Buffer), activity(text: string),
//                                                  upstream({ method, path, body?, contentType? }) -> Promise<{ status, headers, body }> }
// and answers the request itself with ctx.respond, or sends it on (with a rewritten body if it likes) with ctx.forward.
// The one guard that is built in is the check for Approve from a notification (MOBILE-UI 10 and 15.8): POST /api/approve with allow: true
// that carries x-plenum-notify-line (the first line the notification showed) is forwarded only when the phone has the opt-in, the card is
// still waiting, it is not a defaultDeny (or blocked) card and its first line is that line. Anything else answers 409 { error, changed }.
// The header is never forwarded: only the three headers named above are copied to the server.
//
// /_bridge/ui-manifest imports ./ui-manifest.mjs when it is asked (404 until that file exists) and calls its manifest(ctx);
// the LAN page's UI pull calls its rewriteIndex(html, ctx). Both are optional exports of that module.
//
// Nothing here logs a token, a payload, a header value or a path with a query.
import http from 'node:http';
import { BUFFER_CAP, MAX_BODY_BYTES, jsonBytes } from './frames.mjs';
import { NO_METHOD_TEXT, REFUSAL_TEXT, allows, classifyDetailed, pathnameOf } from './tiers.mjs';
import { firstLineOf } from './push.mjs';

export const RES_HEADERS = Object.freeze(['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'x-plenum-auth', 'content-disposition', 'content-length']);
export const BODY_TOO_BIG = `That message is over ${MAX_BODY_BYTES / 1_000_000} MB. Split it up or attach the file with @path instead.`;
export const SPECIAL_TOO_BIG = 'That request is too large.';
export const NO_ANSWER = 'Plenum on this computer did not answer.';
export const CARD_CHANGED = 'That card changed. Open it to answer.';
export const PICTURE_FAILED = 'The picture could not be made.';
const STATIC_UI = /^\/(?:index\.html|app\.js|markdown\.js|music\.js|style\.css|icon\.png|mark\.svg|(?:ext-)?[a-z0-9-]{1,60}\.(?:js|css))$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
// Header values from a phone: plain printable characters and single spaces only, so no line break can ride in one.
const CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+/;="' -]{1,120}$/;
const ACCEPT = /^[A-Za-z0-9!#$&^_.+/;=*,"' -]{1,200}$/;
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
const LOG_LINE_MAX = 2048;
const LOG_LINES_MAX = 200;
const EMPTY = new Uint8Array(0);
// The first line a phone sends with an approve from a notification is cut to this before it is compared.
const NOTIFY_LINE_MAX = 1000;
// A staged artifact id (lib/routes/artifacts.mjs makes a UUID) and the picture the desktop answers (lib/routes/remote.mjs).
const PICTURE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_HEADERS = Object.freeze({ 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
// The largest answer an adapter reads from the server (a picture is at most 2 MB, base64 makes it about a third more).
const UPSTREAM_CAP = 4_000_000;
const UPSTREAM_MS = 25_000;

const pickText = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : '');

// A phone that shows artifacts as pictures only: its caps name artifacts-picture and not artifacts-iframe (MOBILE.json decision.powers.adapters).
const wantsPicture = caps => Array.isArray(caps) && caps.includes('artifacts-picture') && !caps.includes('artifacts-iframe');

// The PNG bytes in the desktop's answer ({ png: 'data:image/png;base64,...' }), or null when the answer is anything else.
function pictureBytesOf(reply) {
  if (reply.status !== 200) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(reply.body.toString('utf8'));
  } catch {
    return null;
  }
  const text = typeof parsed?.png === 'string' ? parsed.png : '';
  if (!text.startsWith(PNG_PREFIX)) return null;
  const bytes = Buffer.from(text.slice(PNG_PREFIX.length), 'base64');
  if (bytes.length === 0 || bytes.length >= PICTURE_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return bytes;
}

// The adapters. A browser page view cannot be shown on a phone, so the bounds call asks for the picture the route answers for a covered
// page. The phone's bounds call is forwarded with keep: true, which asks the desktop to take the picture and leave its own page view on
// the window (the desktop heartbeats its view back on every 2 seconds, so a view taken off the window would blink). The desktop honours
// keep only once lib/routes/browser.mjs passes it on and desktop/browser.cjs skips the detach for it; until then the view still moves.
// The folder dialog is the computer's, so the phone is answered locally and types a path instead.
const pickFolderAdapter = { run: ctx => ctx.respond(200, { available: false }) };

const boundsAdapter = {
  maxBody: 4096,
  run: ctx => ctx.forward(Buffer.from('{"visible":false,"snapshot":true,"keep":true}')),
};

// GET /api/artifacts/view: a phone that shows pictures gets a PNG the desktop draws (POST /api/artifacts/picture). Every other phone gets
// the page itself, which the server answers with its own Content-Security-Policy (the artifacts-iframe path).
const artifactViewAdapter = {
  run(ctx) {
    if (!wantsPicture(ctx.rec.caps)) return ctx.forward();
    const id = new URLSearchParams(ctx.search).get('id') ?? '';
    if (!PICTURE_ID.test(id)) return ctx.respond(400, { error: 'Say which artifact.' });
    return ctx.upstream({
      method: 'POST', path: '/api/artifacts/picture', contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ id })),
    }).then(reply => {
      const png = pictureBytesOf(reply);
      if (png) return ctx.respond(200, png, PNG_HEADERS);
      if (reply.status !== 200) return ctx.respond(reply.status, reply.body, JSON_HEADERS);
      return ctx.respond(503, { error: PICTURE_FAILED });
    });
  },
};

// Keyed 'METHOD /path'. Each Bridge starts from a copy, so a test that adds an entry to its own proxy.adapters changes no other Bridge.
export const ADAPTERS = new Map([
  ['POST /api/pick-folder', pickFolderAdapter],
  ['POST /api/browser/bounds', boundsAdapter],
  ['GET /api/artifacts/view', artifactViewAdapter],
]);

// The notification check: the phone's first line must be the card's first line now, the card must still wait, and it must be a card
// that may be approved from a notification (never a defaultDeny or blocked one). The device must have the opt-in (MOBILE-UI 10).
function notificationApproveOk(registry, cards, rec, parsed, line) {
  if (registry.get(rec.deviceId)?.approveFromNotifications !== true) return false;
  const card = cards?.get(String(parsed.approvalId ?? '')) ?? null;
  if (!card || card.defaultDeny === true || card.blocked === true) return false;
  const shown = firstLineOf(line);
  return shown !== '' && shown === firstLineOf(card.summary);
}

/**
 * @param {object} options
 * @param {() => number} options.upstreamPort                     the server's real listen port
 * @param {() => string} options.getToken                         the per-launch token
 * @param {{ tierOf(id: string): (string|null), get(id: string): (object|null) }} options.registry
 * @param {{ now(): number, setTimeout: Function, clearTimeout: Function }} options.clock
 * @param {string} [options.upstreamHost]
 * @param {(method: string, pathname: string) => (boolean|Promise<boolean>)} [options.routeGated]   default: the route table's gated flags
 * @param {Map<string, object>} [options.adapters]
 * @param {{ get(approvalId: string): (object|null) }} [options.cards]   the cards waiting (for the first-line guard)
 * @param {() => Promise<object>} [options.loadUiManifest]               default: import('./ui-manifest.mjs')
 * @param {() => object} [options.uiContext]                              { desktopVersion, generation, startedAt }
 * @param {(rec: object, value: object) => Promise<object>} [options.onStop]   runs a STOP, answers the STOP_ACK object
 * @param {(info: { rec: object, text: string }) => void} [options.onActivity]
 * @param {boolean} [options.selftest]
 */
export function createProxy(options) {
  const {
    upstreamPort, getToken, registry, clock, upstreamHost = '127.0.0.1', adapters = new Map(ADAPTERS), cards = null, uiContext = () => ({}),
    onStop = null, onActivity = () => {}, selftest = process.env.PLENUM_REMOTE_SELFTEST === '1',
  } = options;
  const loadUiManifest = options.loadUiManifest ?? (() => import('./ui-manifest.mjs'));
  const debugLines = [];
  let gated = null;
  let gatedLoad = null;

  async function loadGated() {
    try {
      const mod = await import('../routes/index.mjs');
      gated = new Set(mod.allRoutes().filter(r => r.gated).map(r => `${r.method} ${r.path}`));
    } catch {
      gated = new Set();
    }
  }
  const routeGated = options.routeGated ?? (async (method, pathname) => {
    if (!gated) await (gatedLoad ??= loadGated());
    return gated.has(`${method} ${pathname}`);
  });

  // ----- answering the phone -----

  function sendBytes(frames, stream, status, bytes, headers = {}) {
    const ok = frames.respond(stream, { status, headers: { ...headers, 'content-length': String(bytes.length) } });
    if (ok) frames.data(stream, bytes, { fin: true });
    return ok;
  }
  const sendJson = (frames, stream, status, body) => sendBytes(frames, stream, status, jsonBytes(body), JSON_HEADERS);

  function pickResponseHeaders(raw) {
    const out = {};
    for (const name of RES_HEADERS) {
      const value = raw[name];
      if (typeof value === 'string' && value.length <= 4096) out[name] = value;
    }
    return out;
  }

  // ----- the upstream request -----

  function startUpstream(rec, streams, ctx, body) {
    const { stream } = ctx;
    const frames = rec.frames;
    const headers = {
      host: `${upstreamHost}:${upstreamPort()}`,
      'x-plenum-token': getToken(),
      'x-plenum-device': rec.deviceId,
      connection: 'close',
    };
    if (ctx.contentType) headers['content-type'] = ctx.contentType;
    if (ctx.accept) headers.accept = ctx.accept;
    if (ctx.clientId) headers['x-plenum-client-id'] = ctx.clientId;
    if (body) headers['content-length'] = String(body.length);
    else if (ctx.method === 'POST' && ctx.remoteFin) headers['content-length'] = '0';
    const up = http.request({ host: upstreamHost, port: upstreamPort(), method: ctx.method, path: ctx.url, headers, agent: false });
    ctx.up = up;
    up.on('socket', socket => socket.setNoDelay(true));
    up.on('response', res => {
      ctx.res = res;
      if (ctx.done) return res.destroy();
      const status = res.statusCode ?? 502;
      const bodyless = status === 204 || status === 304 || status < 200;
      const sent = frames.respond(stream, { status, headers: pickResponseHeaders(res.headers) }, { fin: bodyless });
      if (!sent) return finish(streams, ctx);
      if (status < 400) onActivityFor(rec, ctx);
      if (bodyless) {
        res.resume();
        return finish(streams, ctx);
      }
      let paused = false;
      const relieve = () => {
        if (ctx.done) return;
        if (Number(frames.transport.bufferedAmount) >= BUFFER_CAP / 2) {
          clock.setTimeout(relieve, 10);
        } else {
          paused = false;
          res.resume();
        }
      };
      res.on('data', chunk => {
        if (ctx.done) return;
        if (!frames.data(stream, chunk)) {
          res.destroy();
          return finish(streams, ctx);
        }
        if (!paused && Number(frames.transport.bufferedAmount) >= BUFFER_CAP) {
          paused = true;
          res.pause();
          clock.setTimeout(relieve, 10);
        }
        return undefined;
      });
      res.on('end', () => {
        if (ctx.done) return;
        frames.data(stream, EMPTY, { fin: true });
        finish(streams, ctx);
      });
      res.on('error', () => cancelStream(rec, streams, ctx));
      res.on('aborted', () => cancelStream(rec, streams, ctx));
      return undefined;
    });
    up.on('error', () => {
      if (ctx.done) return;
      if (!ctx.res) {
        sendJson(frames, stream, 502, { error: NO_ANSWER });
        discardRest(streams, ctx);
      } else {
        cancelStream(rec, streams, ctx);
      }
    });
    if (body) up.write(body);
    if (ctx.remoteFin || body) up.end();
    return up;
  }

  // A request an adapter makes to the server itself (the picture of an artifact). The whole answer is read, up to UPSTREAM_CAP, and given
  // back; the token and the device are set here, as for every other request the Bridge sends.
  function askUpstream(rec, clientId, { method, path: target, body = null, contentType = '' }) {
    return new Promise((resolve, reject) => {
      const headers = {
        host: `${upstreamHost}:${upstreamPort()}`,
        'x-plenum-token': getToken(),
        'x-plenum-device': rec.deviceId,
        connection: 'close',
      };
      if (contentType) headers['content-type'] = contentType;
      if (clientId) headers['x-plenum-client-id'] = clientId;
      if (body) headers['content-length'] = String(body.length);
      const up = http.request({ host: upstreamHost, port: upstreamPort(), method, path: target, headers, agent: false }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > UPSTREAM_CAP) {
            res.destroy();
            reject(new Error('The answer is too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      up.setTimeout(UPSTREAM_MS, () => up.destroy(new Error('The server did not answer.')));
      up.on('error', reject);
      if (body) up.end(body);
      else up.end();
    });
  }

  function onActivityFor(rec, ctx) {
    const text = ctx.activity ?? ACTIVITY[`${ctx.method} ${ctx.pathname}`];
    if (text) {
      try {
        onActivity({ rec, text });
      } catch {
        // A listener that throws does not change the answer.
      }
    }
  }

  function finish(streams, ctx) {
    ctx.done = true;
    if (streams.get(ctx.stream) === ctx) streams.delete(ctx.stream);
  }

  // The phone's body bytes after an answer was already given are read and dropped until its FIN.
  function discardRest(streams, ctx) {
    ctx.discard = true;
    ctx.up?.destroy();
    if (ctx.remoteFin) finish(streams, ctx);
  }

  function cancelStream(rec, streams, ctx) {
    if (ctx.done) return;
    finish(streams, ctx);
    ctx.up?.destroy();
    ctx.res?.destroy();
    rec.frames.cancel(ctx.stream);
  }

  // ----- the virtual /_bridge/ paths -----

  async function bridgePath(rec, ctx, body) {
    const { frames, stream } = { frames: rec.frames, stream: ctx.stream };
    const notFound = () => sendJson(frames, stream, 404, { error: 'Not found.' });
    if (ctx.pathname === '/_bridge/ui-manifest' && ctx.method === 'GET') {
      try {
        const mod = await loadUiManifest();
        const fn = mod.manifest ?? mod.uiManifest;
        if (typeof fn !== 'function') return notFound();
        const value = await fn(uiContext());
        return sendJson(frames, stream, 200, value);
      } catch {
        return notFound();
      }
    }
    if (ctx.pathname === '/_bridge/selftest' && ctx.method === 'GET' && selftest) {
      return sendJson(frames, stream, 200, { ok: true, protocol: '1.0', device: rec.deviceId, carrier: rec.carrier });
    }
    if (ctx.pathname === '/_bridge/log') {
      // A phone reads only its own lines (F6): the log holds every phone's, with the id each came from.
      if (ctx.method === 'GET') return sendJson(frames, stream, 200, { lines: debugLines.filter(l => l.deviceId === rec.deviceId).map(({ at, device, text }) => ({ at, device, text })) });
      let text = '';
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        text = typeof parsed?.line === 'string' ? parsed.line : typeof parsed?.text === 'string' ? parsed.text : '';
      } catch {
        text = body.toString('utf8');
      }
      // eslint-disable-next-line no-control-regex
      text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LOG_LINE_MAX);
      if (text) {
        debugLines.push({ at: clock.now(), device: rec.device?.name ?? '', deviceId: rec.deviceId, text });
        if (debugLines.length > LOG_LINES_MAX) debugLines.shift();
      }
      return sendJson(frames, stream, 200, { ok: true });
    }
    return notFound();
  }

  // ----- guards -----

  // The guard for an approve. Only an approve (allow: true) that names a notification line is checked; a deny never needs the opt-in.
  const guards = new Map([
    ['POST /api/approve', {
      maxBody: 8192,
      run(ctx) {
        let parsed = null;
        try {
          parsed = JSON.parse(ctx.body.toString('utf8'));
        } catch {
          return ctx.forward();
        }
        const isObject = parsed !== null && typeof parsed === 'object';
        if (isObject && parsed.allow === true && ctx.notifyLine !== null && !notificationApproveOk(registry, cards, ctx.rec, parsed, ctx.notifyLine)) {
          return ctx.respond(409, { error: CARD_CHANGED, changed: true });
        }
        if (isObject && typeof parsed.allow === 'boolean') ctx.activity(parsed.allow ? 'approved a card' : 'denied a card');
        return ctx.forward();
      },
    }],
  ]);

  // ----- one REQ -----

  async function onReq(rec, streams, stream, value, fin) {
    const frames = rec.frames;
    const ctx = {
      stream, method: '', url: '', pathname: '', search: '', contentType: '', accept: '', clientId: '', notifyLine: null, remoteFin: fin, done: false,
      discard: false, up: null, res: null, sent: 0, chunks: null, special: null, rec,
    };
    streams.set(stream, ctx);
    const fail = (status, error, extra = {}) => {
      sendJson(frames, stream, status, { error, ...extra });
      discardRest(streams, ctx);
    };
    try {
      const method = typeof value?.method === 'string' ? value.method.toUpperCase() : '';
      if (method !== 'GET' && method !== 'POST') return fail(405, NO_METHOD_TEXT);
      const parsed = pathnameOf(value.path);
      if (!parsed) return fail(400, 'That request is not valid.');
      ctx.method = method;
      ctx.pathname = parsed.pathname;
      ctx.search = parsed.search;
      ctx.url = parsed.pathname + parsed.search;
      const headers = value.headers !== null && typeof value.headers === 'object' && !Array.isArray(value.headers) ? value.headers : {};
      ctx.contentType = pickText(headers['content-type'], CONTENT_TYPE);
      ctx.accept = pickText(headers.accept, ACCEPT);
      ctx.clientId = pickText(headers['x-plenum-client-id'], CLIENT_ID);
      // The first line of a notification, sent with an approve from one. Absent: null. Sent but not text: ''.
      const notify = headers['x-plenum-notify-line'];
      ctx.notifyLine = notify === undefined || notify === null ? null : typeof notify === 'string' ? notify.slice(0, NOTIFY_LINE_MAX) : '';

      const isGated = method === 'GET' ? await routeGated(method, parsed.pathname) : false;
      const { tier: need } = classifyDetailed(method, ctx.url, isGated === true);
      const have = registry.tierOf(rec.deviceId);
      if (!allows(have, need)) return fail(403, REFUSAL_TEXT);
      if (Number.isSafeInteger(value.bodyLength) && value.bodyLength > MAX_BODY_BYTES) return fail(413, BODY_TOO_BIG);
      if (ctx.done) return undefined;

      if (ctx.pathname.startsWith('/_bridge/')) {
        const needsBody = ctx.pathname === '/_bridge/log' && method === 'POST';
        if (!needsBody) {
          await bridgePath(rec, ctx, Buffer.alloc(0));
          return discardRest(streams, ctx);
        }
        ctx.special = { maxBody: LOG_LINE_MAX * 2, run: sp => bridgePath(rec, ctx, sp.body) };
      } else {
        const key = `${method} ${ctx.pathname}`;
        ctx.special = adapters.get(key) ?? guards.get(key) ?? null;
      }
      if (ctx.pathname !== '/api/events') rec.lastReq = Date.now();

      if (ctx.special) {
        ctx.chunks = [];
        if (fin) return runSpecial(rec, streams, ctx);
        return undefined;
      }
      startUpstream(rec, streams, ctx, null);
      return undefined;
    } catch {
      if (!ctx.done && !ctx.res) fail(502, NO_ANSWER);
      return undefined;
    }
  }

  function runSpecial(rec, streams, ctx) {
    const special = ctx.special;
    const body = Buffer.concat(ctx.chunks);
    ctx.chunks = null;
    const frames = rec.frames;
    const api = {
      rec,
      method: ctx.method,
      pathname: ctx.pathname,
      search: ctx.search,
      body,
      headers: { 'content-type': ctx.contentType, accept: ctx.accept },
      clientId: ctx.clientId,
      notifyLine: ctx.notifyLine,
      upstream: options => askUpstream(rec, ctx.clientId, options),
      respond(status, payload, headers = {}) {
        if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) sendBytes(frames, ctx.stream, status, payload, headers);
        else sendJson(frames, ctx.stream, status, payload);
        finish(streams, ctx);
      },
      activity(text) {
        ctx.activity = text;
      },
      forward(replacement) {
        ctx.remoteFin = true;
        startUpstream(rec, streams, ctx, replacement ?? (body.length > 0 ? body : null));
      },
    };
    Promise.resolve()
      .then(() => special.run(api))
      .then(() => {
        // A special that bridged a virtual path has answered by now.
        if (!ctx.up && !ctx.done && ctx.pathname.startsWith('/_bridge/')) finish(streams, ctx);
      })
      .catch(() => {
        if (!ctx.done && !ctx.res) {
          sendJson(frames, ctx.stream, 502, { error: NO_ANSWER });
          finish(streams, ctx);
        }
      });
  }

  function onBody(rec, streams, stream, payload, fin) {
    const ctx = streams.get(stream);
    if (!ctx) return;
    ctx.remoteFin = ctx.remoteFin || fin;
    if (ctx.discard || ctx.done) {
      if (fin) finish(streams, ctx);
      return;
    }
    ctx.sent += payload.byteLength;
    if (ctx.sent > MAX_BODY_BYTES) {
      sendJson(rec.frames, stream, 413, { error: BODY_TOO_BIG });
      discardRest(streams, ctx);
      return;
    }
    if (ctx.chunks) {
      if (ctx.sent > (ctx.special?.maxBody ?? 65536)) {
        sendJson(rec.frames, stream, 413, { error: SPECIAL_TOO_BIG });
        discardRest(streams, ctx);
        return;
      }
      ctx.chunks.push(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
      if (fin) runSpecial(rec, streams, ctx);
      return;
    }
    if (!ctx.up) return;
    if (payload.byteLength > 0) ctx.up.write(Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength));
    if (fin) ctx.up.end();
  }

  /**
   * Handlers for one live session's FrameSession (lib/remote/listener.mjs makeHandlers). `rec` is the session record.
   */
  function attach(rec) {
    const streams = new Map();
    return {
      req(stream, value, fin) {
        void onReq(rec, streams, stream, value, fin);
      },
      body(stream, payload, fin) {
        onBody(rec, streams, stream, payload, fin);
      },
      abort(stream) {
        const ctx = streams.get(stream);
        if (!ctx) return;
        ctx.done = true;
        streams.delete(stream);
        ctx.up?.destroy();
        ctx.res?.destroy();
      },
      stop(value) {
        if (!onStop) return;
        Promise.resolve(onStop(rec, value)).then(ack => {
          if (ack && !rec.frames.isClosed) rec.frames.stopAck(ack);
        }, () => {
          // No acknowledgement: the phone keeps trying for 60 seconds, which is the safe thing when the stop could not be confirmed.
        });
      },
      closed() {
        for (const ctx of [...streams.values()]) {
          ctx.done = true;
          ctx.up?.destroy();
          ctx.res?.destroy();
        }
        streams.clear();
      },
    };
  }

  // ----- the UI for a LAN page that holds the cookie -----

  function fetchStatic(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: upstreamHost, port: upstreamPort(), method: 'GET', path: pathname, agent: false,
        headers: { host: `${upstreamHost}:${upstreamPort()}`, connection: 'close' },
      }, resolve);
      req.on('error', reject);
      req.end();
    });
  }

  // GET / and the UI's own files, proxied from the loopback server without the token (the server does not gate them). The index is
  // rewritten by ui-manifest.mjs; without that module the LAN page cannot load the UI and gets the empty 404.
  async function serveUi(req, res, pathname) {
    if (req.method !== 'GET') return false;
    const isIndex = pathname === '/' || pathname === '/index.html';
    if (!isIndex && !STATIC_UI.test(pathname)) return false;
    let mod = null;
    if (isIndex) {
      try {
        mod = await loadUiManifest();
      } catch {
        return false;
      }
      if (typeof mod.rewriteIndex !== 'function') return false;
    }
    let upstream;
    try {
      upstream = await fetchStatic(isIndex ? '/' : pathname);
    } catch {
      return false;
    }
    const headers = pickResponseHeaders(upstream.headers);
    if (!isIndex) {
      res.writeHead(upstream.statusCode ?? 502, headers);
      upstream.pipe(res);
      return true;
    }
    const chunks = [];
    for await (const chunk of upstream) chunks.push(chunk);
    if (upstream.statusCode !== 200) return false;
    const html = Buffer.concat(chunks).toString('utf8');
    let result;
    try {
      result = await mod.rewriteIndex(html, uiContext());
    } catch {
      return false;
    }
    const body = typeof result === 'string' ? result : result?.body;
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) return false;
    const out = Buffer.from(body);
    delete headers['content-length'];
    res.writeHead(200, { ...headers, ...(typeof result === 'object' && result?.headers ? result.headers : {}), 'content-length': String(out.length), 'cache-control': 'no-store' });
    res.end(out);
    return true;
  }

  return { attach, serveUi, adapters, guards, debugLines: () => debugLines.map(({ at, device, text }) => ({ at, device, text })) };
}

// What a phone's successful request is called in the activity list and on the events channel ('via <device>: <text>').
const ACTIVITY = Object.freeze({
  'POST /api/stop-all': 'stopped everything',
  'POST /api/cancel': 'cancelled a run',
  'POST /api/drive/pause': 'paused a computer run',
  'POST /api/drive/resume': 'resumed a computer run',
  'POST /api/drive/stop': 'stopped a computer run',
  'POST /api/agents/stop': 'stopped an agent',
  'POST /api/chat': 'sent a message',
  'POST /api/review': 'started a review',
});
