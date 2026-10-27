// Which carrier addresses the phone will dial (phone security round, G2.3; plan decision D5). A pairing link and a stored record both carry
// carrier URLs; the pairing review shows their hosts, the worker dials only the ones that pass here. Pure: no imports, no side effects.
//
// Every URL: it parses, its protocol is ws: or wss:, it has no user name or password, and it is at most 512 characters.
// Loopback (127.0.0.0/8, localhost, [::1]) passes for every kind.
//   lan        an IPv4 literal in 10/8, 172.16/12, 192.168/16, 169.254/16 or 100.64/10; an IPv6 literal in fc00::/7 or fe80::/10;
//              or a host name that ends in .local
//   tailscale  wss: and a host name that ends in .ts.net
//   relay      wss:, any host

export const CARRIER_KINDS = Object.freeze(['lan', 'tailscale', 'relay']);
export const MAX_URLS_PER_KIND = 4;
const MAX_URL_LENGTH = 512;

function ipv4Of(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every(n => n <= 255) ? parts : null;
}

function isLoopback(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const v4 = ipv4Of(hostname);
  return v4 !== null && v4[0] === 127;
}

function isPrivateV4([a, b]) {
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

// fc00::/7 (unique local) and fe80::/10 (link local), by the first group of the address the URL parser wrote.
function isPrivateV6(hostname) {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  const first = hostname.slice(1, -1).split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const value = parseInt(first, 16);
  return (value >= 0xfc00 && value <= 0xfdff) || (value >= 0xfe80 && value <= 0xfebf);
}

export function carrierUrlOk(kind, url) {
  if (!CARRIER_KINDS.includes(kind) || typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  if (isLoopback(host)) return true;
  if (kind === 'relay') return parsed.protocol === 'wss:';
  if (kind === 'tailscale') return parsed.protocol === 'wss:' && host.endsWith('.ts.net');
  const v4 = ipv4Of(host);
  if (v4) return isPrivateV4(v4);
  return isPrivateV6(host) || host.endsWith('.local');
}

export function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// [{ kind, urls }]: the first entry of each kind, at most MAX_URLS_PER_KIND URLs that pass carrierUrlOk, entries with no URL left dropped.
// An entry is { kind, urls } or { kind, url }.
export function usableCarriers(carriers) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(carriers) ? carriers : []) {
    if (!entry || typeof entry !== 'object' || !CARRIER_KINDS.includes(entry.kind) || seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    const listed = Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : [];
    const urls = listed.filter(url => carrierUrlOk(entry.kind, url)).slice(0, MAX_URLS_PER_KIND);
    if (urls.length) out.push({ kind: entry.kind, urls });
  }
  return out;
}
