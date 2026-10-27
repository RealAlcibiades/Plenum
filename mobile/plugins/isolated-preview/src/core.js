// Pure logic for the isolated-preview plugin's JavaScript side (mob-13; MOBILE-UI 8.9). No imports.
//
// An artifact preview runs in its own WebView on Android: no Capacitor bridge, no file or content access, no network, no
// storage, and no way out of the page. JavaScript runs, so charts and small apps still work; the page cannot reach the
// computer, the keys or the app. iOS shows artifacts as pictures and never uses this plugin.

export const MAX_HTML_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TITLE = 'Artifact preview';
export const MAX_TITLE_CHARS = 120;

// What the Android activity enforces. Mirrored by IsolatedPreviewActivity.kt; the sealed suite checks the Kotlin text.
export const SANDBOX_POLICY = Object.freeze({
  javascript: 'on',
  bridge: 'none',
  network: 'blocked',
  files: 'blocked',
  content: 'blocked',
  storage: 'off',
  navigation: 'blocked',
  popups: 'blocked',
  screenshots: 'blocked',
});

export class IsolatedPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IsolatedPreviewError';
    this.code = code;
  }
}

export function normaliseTitle(value) {
  if (typeof value !== 'string') return DEFAULT_TITLE;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  return clean || DEFAULT_TITLE;
}

// Returns the UTF-8 byte length of the HTML, or throws when the page is empty or over the limit.
export function checkHtml(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new IsolatedPreviewError('empty', 'There is nothing to preview.');
  }
  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > MAX_HTML_BYTES) {
    throw new IsolatedPreviewError('too-large', 'The artifact is larger than 8 MB. Open it on the computer instead.');
  }
  return bytes;
}

export function normaliseShowOptions(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  return { html: opts.html, title: normaliseTitle(opts.title), bytes: checkHtml(opts.html) };
}
