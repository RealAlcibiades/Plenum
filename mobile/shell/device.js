// What kind of page this is, shared by boot.js (the UI page's shim) and app.js (the shell). One module, so both say the same thing in the
// handshake and on the screens (M8: app.js used to look for a /p/<key>/ path while boot.js looked at the origin, so one phone reported two
// different capability lists). No side effects at import: boot.js installs itself when it loads, so app.js must not import boot.js.

// The LAN page is the one the computer serves over plain http on the phone's own network (proxy.serveUi). It is not a secure context, so
// it has no service worker and no Web Push, and its artifact is a picture (a plain navigation to the listener would answer 404). Found by
// the origin, not by the path: the UI document of the LAN page is served at /, and the shell's own page at /p/<key>/ is the same origin.
// localhost and loopback count as a development page, not a LAN.
export function isLanPage(win) {
  const loc = win?.location ?? {};
  if (['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(loc.hostname ?? ''))) return false;
  return win?.isSecureContext === false || String(loc.protocol ?? '') === 'http:';
}

export function isNative(win) {
  return win?.Capacitor?.isNativePlatform?.() === true;
}

export function platformFor(win) {
  const cap = win?.Capacitor;
  if (cap?.isNativePlatform?.() !== true) return 'web';
  return String(cap.getPlatform?.() ?? 'ios') === 'android' ? 'android' : 'ios';
}

// The phone's own caps, as the shell reports them in its handshake (MOBILE.json handshake caps).
export function capsFor(win) {
  if (isNative(win)) return ['ui-bundled', 'artifacts-picture', 'push-none', 'share', 'save', 'camera', 'lan-control'];
  return isLanPage(win) ? ['ui-from-desktop', 'artifacts-picture', 'push-none', 'share', 'save'] : ['ui-from-desktop', 'artifacts-iframe', 'push-webpush', 'share', 'save'];
}

// { app, name } for the handshake: 'android' | 'ios' on a native app, 'lan-web' on the LAN page, 'pwa' everywhere else.
export function appKindFor(win) {
  if (isNative(win)) return { app: platformFor(win), name: 'This phone' };
  if (isLanPage(win)) return { app: 'lan-web', name: 'This browser' };
  return { app: 'pwa', name: 'This phone (web app)' };
}

// The page the person is looking at: the shell's own screens (index.html of the shell, marked data-shell-page) or the desktop's UI (marked
// data-surface="phone" by rewriteIndex). Without a document (a Node suite) it is the shell.
export function pageKindFor(win) {
  const root = win?.document?.documentElement;
  if (!root || typeof root.hasAttribute !== 'function') return 'shell';
  if (root.hasAttribute('data-shell-page')) return 'shell';
  if (typeof root.getAttribute === 'function' && root.getAttribute('data-surface') === 'phone') return 'ui';
  return 'shell';
}
