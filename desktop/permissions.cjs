'use strict';
// The permission decision for the Plenum window. Electron approves every permission request when no handler is set, so
// desktop/handlers/artifacts.cjs passes each request (and each check) through permissionDecision. Only the app's own page may
// use a permission at all, and of the permissions Electron knows, only clipboard writes (the Copy buttons). Everything else is
// refused: the camera, the microphone, location, notifications, full screen, MIDI, pointer lock, and any name not listed here.
// A page served under /api/ on the app's address is an artifact preview (lib/routes/artifacts.mjs), not the app, so it is refused
// too. This file imports nothing from Electron, so its tests run without the app.

const ALLOWED = new Set(['clipboard-sanitized-write']);

// True only for an allowed permission requested from the app's own page. requestingUrl is the frame's address; appUrl is the
// address of the app window. Anything that does not parse is refused.
function permissionDecision(permission, requestingUrl, appUrl) {
  if (!ALLOWED.has(permission)) return false;
  let from;
  let app;
  try {
    from = new URL(String(requestingUrl ?? ''));
    app = new URL(String(appUrl ?? ''));
  } catch {
    return false;
  }
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return false;
  if (from.origin !== app.origin) return false;
  if (from.pathname === '/api' || from.pathname.startsWith('/api/')) return false;
  return true;
}

module.exports = { permissionDecision };
