// Pairing on the phone (mob-10, wave 104; MOBILE.json protocol.pairing_payload and transport.pairing; MOBILE-UI 6.4 to 6.8).
// The page reads a pairing link (scanned or pasted), validates it, and starts one pairing in the channel worker. The worker runs
// IKpsk2 with the offer's secret, shows the six-digit code, and waits for the person to press Allow at the computer. Nothing is
// stored until the computer says allowed; the new record (with this phone's new key) is then saved here.
//
// Accepted links (the fragment never reaches a server):
//   plenum://pair#<b64url JSON>            the native app
//   https://<host>/#pair=<b64url JSON>     the PWA through Tailscale or a relay
//   http://<ip>:<port>/p/<key>/#pair=...   the LAN web page (the page's own origin is tried first, see pageCandidates)

import { answerCounter, b64uToBytes, defaultCreateWorker } from './channel.js';

export const PAIR_FINAL = Object.freeze(['allowed', 'denied', 'expired', 'mismatch', 'failed']);
export const OFFER_TTL_MAX_S = 600;

export class PairingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

// The pairing payload from the text of a link, or PairingError. `text` may be a whole link or only its fragment.
export function parsePairingText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new PairingError('not-plenum');
  // A link is a few hundred characters; anything longer is not one (SL5).
  if (raw.length > 8192) throw new PairingError('not-plenum');
  let fragment = null;
  const native = /^plenum:\/\/pair#(.*)$/i.exec(raw);
  if (native) {
    fragment = native[1];
  } else {
    const hashAt = raw.indexOf('#');
    fragment = hashAt >= 0 ? raw.slice(hashAt + 1) : raw;
  }
  const m = /(?:^|&)pair=([A-Za-z0-9_-]+)$/.exec(fragment) ?? (native ? /^([A-Za-z0-9_-]+)$/.exec(fragment) : null);
  if (!m) throw new PairingError('not-plenum');
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64uToBytes(m[1])));
  } catch {
    throw new PairingError('not-plenum');
  }
  return validatePayload(parsed);
}

export function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PairingError('not-plenum');
  if (p.v !== 1) throw new PairingError('version');
  const key32 = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && b64uToBytes(value).byteLength === 32;
  if (!key32(p.pub) || !key32(p.psk)) throw new PairingError('not-plenum');
  if (typeof p.offer !== 'string' || !/^[0-9a-f]{32}$/.test(p.offer)) throw new PairingError('not-plenum');
  const ttl = Number(p.ttl ?? 120);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > OFFER_TTL_MAX_S) throw new PairingError('expired');
  if (!Array.isArray(p.carriers) || p.carriers.length === 0) throw new PairingError('no-carrier');
  // One entry per kind, in the order given, at most three; each entry keeps at most four URLs (SL5, D5).
  const carriers = [];
  const kinds = new Set();
  for (const c of p.carriers) {
    if (!c || !['lan', 'tailscale', 'relay'].includes(c.kind) || kinds.has(c.kind)) continue;
    kinds.add(c.kind);
    carriers.push(Array.isArray(c.urls) ? { ...c, urls: c.urls.slice(0, 4) } : c);
    if (carriers.length === 3) break;
  }
  if (!carriers.length) throw new PairingError('no-carrier');
  return {
    v: 1,
    name: typeof p.name === 'string' ? p.name.slice(0, 60) : 'Plenum computer',
    pub: p.pub,
    psk: p.psk,
    offer: p.offer,
    ttl,
    carriers,
    sas: '6',
  };
}

// The page's own origin as a LAN carrier, when the page is the LAN web page (http://<ip>:<port>/p/<key>/). Its path key is the one
// in the page address; the phone reaches the computer at the address it loaded the page from.
export function pageCandidates(pageUrl, payload) {
  const m = /^(https?):\/\/([^/]+)\/p\/([0-9a-f]{32})\//.exec(String(pageUrl ?? ''));
  if (!m) return [];
  const url = `${m[1] === 'https' ? 'wss' : 'ws'}://${m[2]}/b/${m[3]}`;
  const listed = (payload?.carriers ?? []).some(c => (Array.isArray(c.urls) ? c.urls : [c.url]).includes(url));
  return listed ? [] : [{ kind: 'lan', url }];
}

// Copy for the failure list (MOBILE-UI 6.7). Each carrier that was tried, with the next step.
export function describeTried(tried = []) {
  const lines = [];
  const seen = new Set();
  for (const t of tried) {
    if (seen.has(t.carrier)) continue;
    seen.add(t.carrier);
    if (t.carrier === 'lan') lines.push('Same network: no answer. Check that this phone is on the same Wi-Fi as the computer. Guest Wi-Fi often keeps devices apart.');
    else if (t.carrier === 'tailscale') lines.push('Tailscale: no answer. Open Tailscale on this phone, connect, then try again.');
    else if (t.carrier === 'relay') lines.push('Relay: the computer is not connected to the relay. Check Settings › Phones › Relay on the computer.');
  }
  return lines;
}

// Starts one pairing in a channel worker. `store` saves the record the computer allowed (keys included, into the store only).
// `prepareRecord(record) -> Promise<record>` (the app lock) returns the record as it must rest, e.g. with the key wrapped under a PIN;
// when it throws, nothing is stored and the pairing fails with reason 'save'.
// Returns { cancel(), done (a Promise of the final state), state() }. The final state is one of PAIR_FINAL; on 'allowed' the
// result also carries `computer` (the public view) and the store already holds the record.
export function startPairing({
  payload,
  store = null,
  createWorker = defaultCreateWorker,
  device = {},
  caps = null,
  pageUrl = null,
  prepareRecord = null,
  onState = () => {},
} = {}) {
  if (!payload || typeof payload !== 'object') throw new PairingError('not-plenum');
  const worker = createWorker();
  let current = { state: 'starting', code: null, tried: [], reason: null };
  let saving = Promise.resolve();
  let finished = false;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const extraUrls = pageCandidates(pageUrl, payload);
  const finish = value => {
    if (finished) return;
    finished = true;
    resolveDone(value);
    setTimeout(() => { try { worker.terminate(); } catch { /* gone */ } }, 0);
  };
  const set = patch => {
    current = { ...current, ...patch };
    try { onState({ ...current }); } catch { /* a screen error must not stop pairing */ }
  };

  worker.onmessage = event => {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'counter') {
      answerCounter(store, msg, reply => worker.postMessage(reply));
      return;
    }
    if (msg.op === 'paired') {
      saving = Promise.resolve()
        .then(async () => {
          if (!store) return true;
          const record = prepareRecord ? await prepareRecord(msg.computer) : msg.computer;
          await store.put(record);
          return true;
        })
        .catch(() => false);
      return;
    }
    if (msg.op !== 'pairState') return;
    if (msg.state === 'confirm') {
      set({ state: 'confirm', code: msg.code ?? null });
      return;
    }
    if (msg.state === 'allowed') {
      saving.then(ok => {
        if (!ok) {
          set({ state: 'failed', reason: 'save' });
          finish({ ...current });
          return;
        }
        set({ state: 'allowed', reason: null });
        finish({ ...current, computerId: msg.computerId ?? null });
      });
      return;
    }
    if (PAIR_FINAL.includes(msg.state)) {
      set({ state: msg.state, tried: msg.tried ?? current.tried, reason: msg.reason ?? null });
      finish({ ...current });
    }
  };
  worker.onerror = () => {
    set({ state: 'failed', reason: 'worker' });
    finish({ ...current });
  };

  set({ state: 'starting' });
  worker.postMessage({ op: 'pair', payload, device, caps: caps ?? undefined, extraUrls });
  return {
    cancel() {
      if (!finished) worker.postMessage({ op: 'pairCancel' });
    },
    done,
    state: () => ({ ...current }),
  };
}
