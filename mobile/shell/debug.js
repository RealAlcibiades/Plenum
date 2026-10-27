// The phone's debug console (mob-10, wave 104; MOBILE-UI 6.17 and MOBILE.json protocol.framing.virtual_paths).
// A ring of the last 500 lines, kept in memory. "Send to computer" posts the lines to /_bridge/log (2 KB a line at most, the Bridge
// keeps them for the Phones panel). Every line is redacted before it is kept: a token, a key, a psk or a nonce never reaches the ring,
// the screen, the log or the computer. Redaction is a safety net; the code never passes those values to log().

export const RING_LINES = 500;
export const LINE_MAX = 2048;
export const SEND_MAX_LINES = 100;

const PATTERNS = [
  [/x-plenum-token\s*[:=]\s*\S+/gi, 'x-plenum-token: [redacted]'],
  [/\b[0-9a-fA-F]{48,}\b/g, '[redacted-hex]'],
  [/\b[A-Za-z0-9_-]{43,}\b/g, '[redacted]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, '[redacted]'],
  [/\[(?:\s*\d{1,3}\s*,){15,}\s*\d{1,3}\s*\]/g, '[redacted-bytes]'],
  [/\b(?:\d{1,3},){15,}\d{1,3}\b/g, '[redacted-bytes]'],
  [/(stopKey|pushKey|desktopPub|handshakeHash|myDeviceId|psk|pub|myPriv|privateKey|nonce|cookie|token|secret|key)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, '$1=[redacted]'],
];

// The line with secrets masked and control characters cut out, at most LINE_MAX characters.
export function redactLine(text) {
  let out = String(text ?? '');
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return out.slice(0, LINE_MAX);
}

export function createDebugLog({ now = () => Date.now(), capacity = RING_LINES } = {}) {
  const ring = [];
  const subs = new Set();
  const notify = () => {
    for (const fn of Array.from(subs)) {
      try { fn(); } catch { /* a listener error must not stop the others */ }
    }
  };
  return {
    // Adds one line. Returns the stored line, or null when there was nothing left after redaction.
    log(text, level = 'info') {
      const line = redactLine(text);
      if (!line) return null;
      const entry = { at: now(), level, text: line };
      ring.push(entry);
      while (ring.length > capacity) ring.shift();
      notify();
      return entry;
    },
    lines() {
      return ring.map(l => ({ ...l }));
    },
    clear() {
      ring.length = 0;
      notify();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // Posts the most recent lines to the computer, one request each (POST /_bridge/log takes { line }). `request` is channel.request.
    // Resolves with the number of lines the computer answered for.
    async sendToComputer(request, count = SEND_MAX_LINES) {
      const picked = ring.slice(-Math.max(0, Math.min(count, SEND_MAX_LINES)));
      let accepted = 0;
      for (const entry of picked) {
        const body = JSON.stringify({ line: `[phone ${entry.level}] ${entry.text}`.slice(0, LINE_MAX) });
        try {
          const res = await request({ method: 'POST', path: '/_bridge/log', headers: { 'content-type': 'application/json' } }, body);
          try { await res.body?.cancel(); } catch { /* nothing to drain */ }
          if (res.status === 200) accepted += 1;
        } catch {
          break;
        }
      }
      return accepted;
    },
  };
}
