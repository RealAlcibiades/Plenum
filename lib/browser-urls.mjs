// The one rule for an address the Browser pane may open (brw-02). Pure: it imports nothing and touches nothing, so the server's routes,
// the browser tools and the tests all use it. The desktop app applies the same rule again on its own side (desktop/browser.cjs).
//
// checkUrl(raw) trims the text, adds https:// when there is no scheme and the text looks like a host ("example.com",
// "localhost:3000", "[::1]:8080/x"), parses it with the URL class, and answers the address in its normal form. It accepts only http
// and https, at most 2048 characters, and nothing with a user name or password in it (a secret in an address ends up in history,
// logs and referrers). Anything else throws a BrowserUrlError with status 400 and a sentence that says what to do.

export const MAX_URL_LENGTH = 2048;

export const NOT_HTTP = 'Only http and https addresses can be opened.';
export const NOT_AN_ADDRESS = 'That is not a web address. Type one such as example.com.';
export const HAS_CREDENTIALS = 'Addresses with a user name or password in them are not opened.';
export const TOO_LONG = `That address is longer than ${MAX_URL_LENGTH} characters.`;

export class BrowserUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowserUrlError';
    this.status = 400;
  }
}

// Schemes that are always taken as schemes, never as "host:port" (so javascript:1 is refused, not read as a host called javascript).
const KNOWN_SCHEMES = new Set([
  'javascript', 'data', 'file', 'ftp', 'mailto', 'about', 'blob', 'view-source', 'chrome', 'devtools', 'ws', 'wss', 'tel', 'sms',
  'intent', 'vbscript', 'filesystem', 'chrome-extension', 'edge', 'resource', 'jar', 'gopher', 'ssh', 'telnet', 'smb', 'news', 'ldap',
]);
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]');
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// What may follow "host:" when the text is a host and a port.
const PORT_AFTER = /^\d{1,5}(?:[/?#]|$)/;

// True when the first part of a scheme-less text (up to the first / ? or #) can be a host: it has a dot, is localhost, or is an IPv6
// literal in brackets.
function looksLikeHost(text) {
  const head = text.split(/[/?#]/, 1)[0];
  if (!head || /\s/.test(head)) return false;
  const name = head.replace(/:\d{0,5}$/, '');
  if (name.startsWith('[')) return name.endsWith(']');
  return name.includes('.') || name.toLowerCase() === 'localhost';
}

// "name:" at the start is a scheme unless the text is host:port ("localhost:3000", "example.com:8080/x").
function hasScheme(text) {
  const m = SCHEME.exec(text);
  if (!m) return false;
  const scheme = m[1].toLowerCase();
  if (KNOWN_SCHEMES.has(scheme)) return true;
  const rest = text.slice(m[0].length);
  if (rest.startsWith('//')) return true;
  const hostLike = m[1].includes('.') || scheme === 'localhost';
  return !(hostLike && PORT_AFTER.test(rest));
}

// The address to open, as a string in URL's normal form. Throws a BrowserUrlError (status 400) when the text cannot be opened.
export function checkUrl(raw) {
  if (typeof raw !== 'string') throw new BrowserUrlError(NOT_AN_ADDRESS);
  const text = raw.trim();
  if (!text) throw new BrowserUrlError(NOT_AN_ADDRESS);
  if (text.length > MAX_URL_LENGTH) throw new BrowserUrlError(TOO_LONG);
  // A tab or a line break inside the text would be dropped by the URL parser and could hide what the address really is.
  if (CONTROL.test(text)) throw new BrowserUrlError(NOT_AN_ADDRESS);
  let candidate = text;
  if (!hasScheme(text)) {
    if (!looksLikeHost(text)) throw new BrowserUrlError(NOT_AN_ADDRESS);
    candidate = `https://${text}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new BrowserUrlError(NOT_AN_ADDRESS);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserUrlError(NOT_HTTP);
  if (url.username || url.password) throw new BrowserUrlError(HAS_CREDENTIALS);
  if (!url.hostname) throw new BrowserUrlError(NOT_AN_ADDRESS);
  if (url.href.length > MAX_URL_LENGTH) throw new BrowserUrlError(TOO_LONG);
  return url.href;
}

// The same check without the throw: the address, or null.
export function tryCheckUrl(raw) {
  try {
    return checkUrl(raw);
  } catch {
    return null;
  }
}

// The host of an address for a short label ("example.com"), or '' when the text is not an address.
export function hostOf(raw) {
  try {
    return new URL(String(raw)).host;
  } catch {
    return '';
  }
}
