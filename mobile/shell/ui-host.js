// Showing the desktop's UI on the phone (H3; MOBILE.json client_model.ui_source, MOBILE-UI 6.10 and 6.16). After HELLO the shell pulls the UI
// the computer has (ui-loader.js) and then hands the page over to it:
//
//   web (https: the PWA, the Tailscale page, the relay page)
//        the loader fills the cache the active record names; once the service worker controls the page, location.replace('/') loads the UI
//        document from that cache (sw.js rewrites its index). The shell's own screens stay reachable at /?shell (sw.js lets that through).
//   LAN web page (plain http on the phone's own network)
//        no service worker and no cache: the computer serves the UI document at / to a page that holds the path-key cookie (listener uiPull),
//        so the page only navigates to /.
//   Android app
//        the loader writes the files under the app-data folder and points the WebView at them (WebView.setServerBasePath, persisted), which
//        reloads the page at the UI. The shell files the UI page loads (/shell/...) are written beside them.
//   iPhone app
//        the App Store build runs the bundled snapshot (www/ui/): the WebView's base path moves to that folder. Nothing is pulled.
//
// The way back is openShell(): the shell's screens (computers, Phone settings, lock set-up, pairing) are a separate page.
//   web and LAN <the page the shell's screens were on>?shell (remembered when the page left for the UI, /?shell when nothing is remembered:
//   the Tailscale page keeps them at /p/<key>/), Android WebView.setServerAssetPath('public'), iPhone the base path it started with.
// A link that goes with it (a pairing link, #settings, #computers, #connect=<id>) rides in the address on web and LAN; the apps have no address to
// carry it, so it waits in the linkStore (a short-lived entry in the app's secure storage, app.js) and the shell page takes it out when it
// starts. It is never written to sessionStorage: a pairing link holds the pairing secret, and any script of the page can read web storage.
// Every platform call goes through an injected object, so the Node suites drive this with fakes. Native navigation can be checked only on a
// phone: the suites check the calls, in order.
//
// Nothing here holds a key or a token. The loader talks to the computer only through channel.request.

import { UiError, androidStorage, createUiLoader, webStorage } from './ui-loader.js';

export const SHELL_QUERY = 'shell';
export const SHELL_PAGE_KEY = 'plenum-shell-page';   // sessionStorage and localStorage: where the shell's screens are, for the way back from the UI page
export const SHELL_BASE_KEY = 'plenum-shell-base';   // sessionStorage (iPhone): the folder the shell's screens were loaded from
export const SHELL_LINK_KEY = 'plenum-shell-link';   // the key an older version used in sessionStorage; never written now (app.js clears it once at start)
export const UI_ROOT = 'plenum-ui';
export const BUNDLED_UI_FOLDER = 'ui';
const SW_WAIT_MS = 4000;
const DATA = 'DATA';

// The cause the ui-failed screen words (route.js ctx.cause): checksum, not-sent, stopped, or worker (the browser cannot keep the screens).
export function causeOf(error) {
  const code = error?.code ?? '';
  if (code === 'worker') return 'worker';
  if (code === 'fetch') return 'not-sent';
  if (code === 'cancelled' || code === 'closed' || code === 'stopped' || code === 'offline') return 'stopped';
  return 'checksum';
}

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(text);
}

function fromBase64(text) {
  const bin = globalThis.atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const stripFileScheme = uri => String(uri ?? '').replace(/^file:\/\//, '').replace(/\/+$/, '');

// The app-data folder through Capacitor's Filesystem plugin, in the shape androidStorage wants:
// { write(rel, bytes), read(rel) -> Uint8Array | null, removeDir(rel), listDirs(rel) -> names }.
export function filesOver(filesystem) {
  return {
    async write(rel, bytes) {
      await filesystem.writeFile({ path: rel, data: toBase64(bytes), directory: DATA, recursive: true });
    },
    async read(rel) {
      try {
        const out = await filesystem.readFile({ path: rel, directory: DATA });
        return typeof out?.data === 'string' ? fromBase64(out.data) : null;
      } catch {
        return null;
      }
    },
    async removeDir(rel) {
      try {
        await filesystem.rmdir({ path: rel, directory: DATA, recursive: true });
      } catch {
        // Nothing there.
      }
    },
    async listDirs(rel) {
      try {
        const out = await filesystem.readdir({ path: rel, directory: DATA });
        return (out?.files ?? []).filter(f => f.type === 'directory' || f.type === undefined).map(f => String(f.name ?? f));
      } catch {
        return [];
      }
    },
  };
}

// Capacitor's WebView plugin in the shape androidStorage wants. androidStorage names folders relative to the app-data folder
// ('plenum-ui/<cache>'); the plugin wants absolute paths, so they are translated both ways. androidStorage calls persist before set (set
// reloads the page at once); the plugin persists the base path it currently serves, so here persist only notes the path and set does both
// calls back to back, set first, before the reload can take the page away.
export function webViewOver({ webView, filesystem }) {
  let dataRoot = null;
  let noted = null;
  const root = async () => {
    if (dataRoot === null) {
      const out = await filesystem.getUri({ path: '', directory: DATA });
      dataRoot = stripFileScheme(out?.uri);
    }
    return dataRoot;
  };
  const absolute = async rel => `${await root()}/${String(rel).replace(/^\/+/, '')}`;
  return {
    async persistServerBasePath({ path }) {
      noted = path;
    },
    async setServerBasePath({ path }) {
      const target = await absolute(path ?? noted);
      const set = webView.setServerBasePath({ path: target });
      const keep = webView.persistServerBasePath?.();
      await Promise.all([set, keep]);
    },
    async getServerBasePath() {
      const out = await webView.getServerBasePath();
      const abs = String(out?.path ?? '');
      const prefix = `${await root()}/`;
      return { path: abs.startsWith(prefix) ? abs.slice(prefix.length) : abs };
    },
  };
}

// Reads one bundled file of the app (its own www folder) as bytes, or null. rel is 'shell/boot.js'; the bundle keeps those files at the root.
export function bundledReader(fetchImpl, base) {
  return async rel => {
    const name = String(rel).replace(/^shell\//, '');
    try {
      const res = await fetchImpl(new URL(name, base).href, { cache: 'no-store' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
}

// kind: 'web' | 'lan' | 'android' | 'ios'.
export function createUiHost({
  env,
  kind,
  native = null,
  channelOf,
  log = () => {},
  linkStore = null,       // { put(text), take() }: where a link for the shell page waits on the apps (never web storage)
  swWaitMs = SW_WAIT_MS,
  loaderFactory = createUiLoader, // the Node suites pass a fake loader
  setTimer = (fn, ms) => env.setTimeout(fn, ms),
  clearTimer = id => env.clearTimeout(id),
} = {}) {
  const location = () => env.location;
  const session = () => {
    try {
      return env.sessionStorage ?? null;
    } catch {
      return null;
    }
  };
  const remember = (key, value) => {
    try {
      session()?.setItem(key, value);
    } catch {
      // The way back then falls to the default page.
    }
  };
  const recall = key => {
    try {
      return session()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  // localStorage outlives the session: the installed web app opens a fresh session at its start page, and the way back still needs the page.
  const durable = () => {
    try {
      return env.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const rememberDurable = (key, value) => {
    try {
      durable()?.setItem(key, value);
    } catch {
      // The session copy, or the default page.
    }
  };
  const recallDurable = key => {
    try {
      return durable()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  // A remembered page is used only when it is a path of this origin that names the shell's screens.
  const isShellPage = value => typeof value === 'string' && /^\/(?![/\\])[^#\s]*\?shell(?:&[^#\s]*)?$/.test(value);

  function androidStore() {
    if (!native?.Filesystem || !native?.WebView) throw new UiError('storage', 'The app-data folder is not available.');
    return androidStorage({
      files: filesOver(native.Filesystem),
      webView: webViewOver({ webView: native.WebView, filesystem: native.Filesystem }),
      root: UI_ROOT,
    });
  }

  function buildLoader() {
    const channel = channelOf();
    if (!channel) throw new UiError('offline', 'The phone is not connected.');
    if (kind === 'android') {
      const storage = androidStore();
      const base = location().href;
      return loaderFactory({ channel, storage, platform: 'android', shellBase: '/shell/', readBundled: bundledReader(env.fetch.bind(env), base) });
    }
    if (!env.caches) throw new UiError('worker', 'This browser cannot keep Plenum\'s screens.');
    return loaderFactory({ channel, storage: webStorage(env.caches), platform: 'web', shellBase: '/shell/' });
  }

  // Waits until a service worker controls this page: the registration is ready, and the worker has claimed the page.
  async function workerControls() {
    const sw = env.navigator?.serviceWorker;
    if (!sw) return false;
    if (sw.controller) return true;
    try {
      await Promise.race([sw.ready, new Promise((_, reject) => setTimer(() => reject(new Error('timeout')), swWaitMs))]);
    } catch {
      return Boolean(sw.controller);
    }
    if (sw.controller) return true;
    return new Promise(resolve => {
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimer(timer);
        resolve(Boolean(sw.controller));
      };
      sw.addEventListener?.('controllerchange', done, { once: true });
      timer = setTimer(done, swWaitMs);
    });
  }

  // Web and LAN: the page the shell's screens were on when the page left them (the Tailscale page keeps them at /p/<key>/, where /?shell would
  // be a 404, and on the loopback it would answer the UI document), else /?shell.
  function shellUrl() {
    for (const saved of [recall(SHELL_PAGE_KEY), recallDurable(SHELL_PAGE_KEY)]) {
      if (isShellPage(saved)) return saved;
    }
    return `/?${SHELL_QUERY}`;
  }

  return {
    kind,

    // The shell page, before it leaves for the UI: remembers where its screens are.
    rememberShellPage() {
      const page = `${location().pathname}?${SHELL_QUERY}`;
      remember(SHELL_PAGE_KEY, page);
      rememberDurable(SHELL_PAGE_KEY, page);
    },

    // True when the page was opened for the shell's own screens (/?shell): it stays on them and does not go to the UI.
    staysOnShell() {
      return new URLSearchParams(String(location()?.search ?? '')).has(SHELL_QUERY);
    },

    // Pulls what the computer has and hands the page to the UI. Resolves { ok: true, status, navigated } or { ok: false, cause, code }.
    async show({ hello, computerId = null, loadedHash = null, onProgress = () => {} } = {}) {
      onProgress({ done: 0, total: 1 });
      try {
        if (kind === 'lan') {
          this.rememberShellPage();
          location().replace('/');
          return { ok: true, status: 'lan', navigated: true };
        }
        if (kind === 'ios') {
          const webView = native?.WebView;
          if (!webView?.getServerBasePath || !webView?.setServerBasePath) throw new UiError('storage', 'The app cannot switch to its bundled screens.');
          const here = await webView.getServerBasePath();
          const base = String(here?.path ?? '').replace(/\/+$/, '');
          if (!base) throw new UiError('storage', 'The bundled screens are not where the app expects them.');
          remember(SHELL_BASE_KEY, base);
          await webView.setServerBasePath({ path: `${base}/${BUNDLED_UI_FOLDER}` });
          return { ok: true, status: 'bundled', navigated: true };
        }
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        onProgress({ done: 1, total: 1 });
        if (kind === 'android') {
          // check() has already pointed the WebView at the UI (activate, or ensureActive for a UI that was current): the page reloads there.
          return { ok: true, status: result.status, navigated: true, reload: result.reload };
        }
        if (!(await workerControls())) throw new UiError('worker', 'No service worker controls this page.');
        this.rememberShellPage();
        location().replace('/');
        return { ok: true, status: result.status, navigated: true, reload: result.reload };
      } catch (error) {
        log(`ui: ${error?.code ?? 'error'}`);
        return { ok: false, cause: causeOf(error), code: error?.code ?? 'error' };
      }
    },

    // On the UI page: asks whether the computer has a newer UI. { ok, changed, reload }. The page reloads once per new UI (the loader's
    // shouldReload keeps the count), and the caller does the reload.
    async refresh({ hello, loadedHash = null, computerId = null } = {}) {
      if (kind === 'lan' || kind === 'ios') return { ok: true, changed: false, reload: false };
      try {
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        return { ok: true, changed: result.status === 'updated', reload: result.reload === true };
      } catch (error) {
        log(`ui: ${error?.code ?? 'error'}`);
        return { ok: false, changed: false, reload: false, cause: causeOf(error) };
      }
    },

    // Which computer the UI on this page came from (one UI per computer): the active record's computerId on web and Android (null when it is not
    // known: no record, or one written before the id was kept), and 'any' where the page cannot tell and the computer serves it (the LAN page, the
    // iPhone's bundled copy).
    async uiComputerId() {
      if (kind === 'lan' || kind === 'ios') return 'any';
      try {
        const storage = kind === 'android' ? androidStore() : env.caches ? webStorage(env.caches) : null;
        const record = storage ? await storage.readActive() : null;
        return typeof record?.computerId === 'string' && record.computerId ? record.computerId : null;
      } catch {
        return null;
      }
    },

    // The hash of the UI the cache serves now, or null.
    async loadedHash() {
      if (kind !== 'web' || !env.caches) return null;
      try {
        const record = await webStorage(env.caches).readActive();
        return record?.complete === true ? record.hash : null;
      } catch {
        return null;
      }
    },

    // Whether a complete copy of the UI is on the phone, for "Use the copy in this app".
    async hasCopy() {
      if (kind === 'ios') return true;
      if (kind === 'lan') return false;
      return (await this.loadedHash()) !== null;
    },

    // Uses the copy that is already on the phone, without asking the computer.
    async useCopy() {
      if (kind === 'ios') return this.show({});
      if (kind === 'web' && (await this.loadedHash()) !== null && (await workerControls())) {
        this.rememberShellPage();
        location().replace('/');
        return { ok: true, status: 'copy', navigated: true };
      }
      return { ok: false, cause: 'worker', code: 'worker' };
    },

    // From the UI page back to the shell's screens. link (a pairing link, #settings, #computers, #connect=<id>) rides along: in the address on web
    // and LAN pages (the '#...' part only), in the linkStore for the apps (the shell page takes it out once, within two minutes).
    async openShell(link = '') {
      const text = typeof link === 'string' ? link : '';
      if (kind === 'web' || kind === 'lan') {
        location().assign(`${shellUrl()}${text.startsWith('#') ? text : ''}`);
        return true;
      }
      const webView = native?.WebView;
      if (!webView) return false;
      const base = kind === 'android' ? null : recall(SHELL_BASE_KEY);
      const switchPage = kind === 'android'
        ? (webView.setServerAssetPath ? () => webView.setServerAssetPath({ path: 'public' }) : null)
        : (base && webView.setServerBasePath ? () => webView.setServerBasePath({ path: base }) : null);
      if (!switchPage) return false;
      if (text) await linkStore?.put(text);
      try {
        await switchPage();
      } catch (error) {
        // The page did not switch, so nothing is left to take the link: it does not stay.
        if (text) {
          try { await linkStore?.take(); } catch { /* nothing to take back */ }
        }
        throw error;
      }
      return true;
    },
  };
}
