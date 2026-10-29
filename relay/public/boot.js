(() => {
  // lib/remote/ui-manifest.mjs
  var UI_STATIC_PATHS = Object.freeze(["/", "/app.js", "/markdown.js", "/music.js", "/style.css", "/icon.png", "/mark.svg", "/ext.js"]);
  var EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/;
  var STATIC_SET = new Set(UI_STATIC_PATHS);
  var TYPES = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  });
  function isUiPath(pathname) {
    return STATIC_SET.has(pathname) || EXT_PATH.test(pathname);
  }

  // mobile/shell/device.js
  function isLanPage(win) {
    const loc = win?.location ?? {};
    if (["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(loc.hostname ?? ""))) return false;
    return win?.isSecureContext === false || String(loc.protocol ?? "") === "http:";
  }
  function isNative(win) {
    return win?.Capacitor?.isNativePlatform?.() === true;
  }
  function platformFor(win) {
    const cap = win?.Capacitor;
    if (cap?.isNativePlatform?.() !== true) return "web";
    return String(cap.getPlatform?.() ?? "ios") === "android" ? "android" : "ios";
  }
  function capsFor(win) {
    if (isNative(win)) return ["ui-bundled", "artifacts-picture", "push-none", "share", "save", "camera", "lan-control"];
    return isLanPage(win) ? ["ui-from-desktop", "artifacts-picture", "push-none", "share", "save"] : ["ui-from-desktop", "artifacts-iframe", "push-webpush", "share", "save"];
  }

  // mobile/shell/stop.js
  var STOP_STATES = Object.freeze(["idle", "sending", "queued", "done", "failed"]);
  var STOP_FAILURE_TEXT = Object.freeze({
    title: "Could not reach the computer",
    body: "The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run."
  });

  // mobile/shell/boot.js
  var DEV_BUILD = true ? false : true;
  function debugHooksOn(search, devBuild = DEV_BUILD) {
    return devBuild === true && /[?&](debug|demo|selftest)(=|&|$)/.test(String(search ?? ""));
  }
  var FACADE_PLUGINS = Object.freeze(["App", "TextZoom", "Haptics", "Dictation", "IsolatedPreview", "Browser", "Share", "Filesystem"]);
  var REQ_HEADERS = Object.freeze(["accept", "content-type", "x-plenum-client-id"]);
  var RES_HEADERS = Object.freeze(["content-type", "cache-control", "content-security-policy", "x-content-type-options", "x-plenum-auth", "content-disposition", "content-length"]);
  var NULL_BODY_STATUS = Object.freeze([101, 204, 205, 304]);
  var ARTIFACT_VIEW = "/api/artifacts/view";
  var MAX_WORKER_BODY = 32 * 1024 * 1024;
  var STOP_LABELS = Object.freeze({ idle: "Stop", sending: "Stopping\u2026", queued: "Stop", done: "Stopped", failed: "Stop" });
  var TOAST_MS = 6e3;
  var LOCK_TRY_AGAIN = "That did not unlock Plenum. Try again.";
  var LOCK_PIN_LENGTH = 6;
  var LOCK_STOP_ARMED_NOTE = "Enter your PIN. Plenum stops everything once it unlocks.";
  var LOCK_STOP_READY_LABEL = "Stop everything";
  var LOCK_STOP_UNLOCK_LABEL = "Unlock and stop everything";
  var LOCK_UNKNOWN_NOTE = "Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.";
  var utf8 = new TextEncoder();
  function fetchError() {
    return new TypeError("Failed to fetch");
  }
  function abortError() {
    try {
      return new DOMException("The operation was aborted.", "AbortError");
    } catch {
      return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }
  }
  function mapChannelError(err) {
    return err?.code === "cancelled" ? abortError() : fetchError();
  }
  function pickRequestHeaders(headers) {
    const out = {};
    if (!headers) return out;
    let entries;
    if (Array.isArray(headers)) entries = headers;
    else if (typeof headers.forEach === "function") {
      entries = [];
      headers.forEach((value, key) => entries.push([key, value]));
    } else entries = Object.entries(headers);
    for (const [key, value] of entries) {
      const name = String(key).toLowerCase();
      if (REQ_HEADERS.includes(name)) out[name] = String(value);
    }
    return out;
  }
  function pickResponseHeaders(headers) {
    const out = {};
    for (const name of RES_HEADERS) {
      const value = headers && typeof headers === "object" ? headers[name] : void 0;
      if (value !== void 0 && value !== null) out[name] = String(value);
    }
    return out;
  }
  async function bodyBytes(body) {
    if (body === null || body === void 0) return null;
    if (typeof body === "string") return utf8.encode(body);
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return utf8.encode(body.toString());
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    if (typeof Blob !== "undefined" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    throw new TypeError("This kind of request body is not sent through the phone link.");
  }
  async function readCapped(stream, cap) {
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        reader.cancel().catch(() => {
        });
        throw new RangeError("too large");
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
  function sseParser(onData) {
    let buffer = "";
    return {
      push(text) {
        buffer += text;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
          if (data) onData(data);
        }
      }
    };
  }
  function base64Of(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return globalThis.btoa(text);
  }
  function installShim(options = {}) {
    const win = options.win;
    const doc = options.doc ?? win?.document ?? null;
    if (!win || !win.location) throw new TypeError("installShim needs a window with a location");
    const origFetch = options.origFetch ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : null);
    let core = options.core ?? null;
    const coreOf = () => core;
    const log = options.log ?? (() => {
    });
    const ResponseCtor = options.Response ?? win.Response;
    const ReadableStreamCtor = options.ReadableStream ?? win.ReadableStream;
    const decoder = new TextDecoder();
    const cap = win.Capacitor;
    const native = cap?.isNativePlatform?.() === true;
    const pluginOf = (name) => options.plugins?.[name] ?? core?.plugin?.(name) ?? (FACADE_PLUGINS.includes(name) ? cap?.Plugins?.[name] : null) ?? null;
    const later = (fn, ms) => {
      const timer = win.setTimeout?.(fn, ms);
      timer?.unref?.();
      return timer;
    };
    const whenPlugin = (name, fn) => {
      if (!native) return;
      const attempt = (tries) => {
        const found = pluginOf(name);
        if (found) {
          fn(found);
          return;
        }
        if (tries < 150) later(() => attempt(tries + 1), 200);
      };
      attempt(0);
    };
    const drives = /* @__PURE__ */ new Map();
    let helloDriving = null;
    let connState = { status: "idle" };
    let locked = false;
    let stopView = { state: "idle", text: "", seq: 0 };
    let helloInfo = null;
    let lockInfo = { mode: "off" };
    let hadSession = false;
    let lockStop = { ready: false, computerName: "" };
    let notice = null;
    let noticeAt = 0;
    let noticeShown = null;
    let noticeClosed = null;
    let sheetClosed = null;
    let lockNote = "";
    let pinDigits = "";
    let pinBusy = false;
    let pinShown = false;
    let stopArmed = false;
    let prefsTheme = "follow";
    function drivingLabel() {
      if (drives.size) {
        const d = [...drives.values()][0];
        const of = d.limits?.steps ? ` of ${d.limits.steps}` : "";
        return `${d.label || d.kind || "computer"}, step ${d.steps ?? 0}${of}`;
      }
      if (helloDriving) return `${helloDriving.app || helloDriving.kind || "computer"}, step ${helloDriving.step ?? 0}${helloDriving.of ? ` of ${helloDriving.of}` : ""}`;
      return "";
    }
    function noteDriveEvent(event) {
      if (!event || event.type !== "drive" || !event.drive || typeof event.drive !== "object") return;
      const d = event.drive;
      if (typeof d.id !== "string") return;
      if (d.state === "running") drives.set(d.id, d);
      else drives.delete(d.id);
      paint();
    }
    function noteTierEvent(event) {
      if (event?.type !== "phone" || event.kind !== "tier") return;
      if (typeof event.tier !== "string" || !helloInfo || helloInfo.deviceId && event.id !== helloInfo.deviceId) return;
      helloInfo = { ...helloInfo, tier: event.tier };
      paint();
    }
    function observeEvents(stream) {
      const reader = stream.getReader();
      const parser = sseParser((text) => {
        try {
          const event = JSON.parse(text);
          noteDriveEvent(event);
          noteTierEvent(event);
          if (event && event.type === "hello") helloDriving = event.state?.pending?.driving ?? helloDriving;
        } catch {
        }
      });
      return new ReadableStreamCtor({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          parser.push(decoder.decode(value, { stream: true }));
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
    }
    async function shimFetch(input, init = {}) {
      const raw = typeof input === "string" ? input : input?.url ?? String(input);
      const url = new URL(raw, win.location.href);
      if (url.origin !== win.location.origin) throw fetchError();
      if (url.pathname.startsWith("/_bridge/")) {
        return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      const isApi = url.pathname.startsWith("/api/");
      if (!isApi && !isUiPath(url.pathname) && url.pathname !== "/") {
        return origFetch ? origFetch(input, init) : Promise.reject(fetchError());
      }
      const method = String(init.method ?? input?.method ?? "GET").toUpperCase();
      const headers = pickRequestHeaders(init.headers ?? input?.headers);
      const body = await bodyBytes(init.body);
      if (!core) throw fetchError();
      const signal = init.signal ?? input?.signal ?? null;
      if (signal?.aborted) throw abortError();
      let answer;
      try {
        answer = await core.request({ method, path: url.pathname + url.search, headers }, body, { signal });
      } catch (err) {
        if (err?.code === "refused") return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
        throw mapChannelError(err);
      }
      if (NULL_BODY_STATUS.includes(answer.status)) {
        answer.cancel?.();
        return new ResponseCtor(null, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
      }
      const stream = url.pathname === "/api/events" ? observeEvents(answer.body) : answer.body;
      return new ResponseCtor(stream, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
    }
    const zoomListeners = /* @__PURE__ */ new Set();
    const themeListeners = /* @__PURE__ */ new Set();
    const connListeners = /* @__PURE__ */ new Set();
    const backListeners = /* @__PURE__ */ new Set();
    const capsListeners = /* @__PURE__ */ new Set();
    const routeListeners = /* @__PURE__ */ new Set();
    let zoom = 1;
    let lastTheme = null;
    let lastRouteSeq = 0;
    const app = options.app ?? { version: "", build: "" };
    const platform = options.platform ?? platformFor(win);
    const caps = options.caps ?? capsFor(win);
    function connectionView() {
      const s = connState.status ?? "idle";
      const state = s === "connected" ? "connected" : s === "asleep" ? "asleep" : s === "connecting" || s === "reconnecting" ? "reconnecting" : "offline";
      return {
        state,
        carrier: connState.carrier ?? null,
        desktopName: connState.desktopName ?? "",
        lastSeen: connState.lastSeen ?? null,
        // The phone's own tier (full, approve or read) from the computer's HELLO, and whether an app lock is set (the phone layer shows "Lock now"
        // only then). A phone that has not heard from a computer yet is 'full' to the layer, as before.
        tier: helloInfo?.tier ?? null,
        // What the computer says it can do (HELLO.caps, by the phone's tier): the phone layer shows the Browser and Computer controls only when
        // 'browser-control' or 'computer-control' is in it. A copy, so a screen cannot change what the shell keeps.
        caps: helloInfo ? [...helloInfo.caps] : [],
        lockMode: lockInfo.mode ?? "off"
      };
    }
    function themeNow() {
      if (prefsTheme === "dark" || prefsTheme === "light") return prefsTheme;
      return win.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true ? "dark" : "light";
    }
    function fireTheme() {
      const now = themeNow();
      if (now === lastTheme) return;
      lastTheme = now;
      for (const fn of [...themeListeners]) {
        try {
          fn(now);
        } catch {
        }
      }
    }
    function setZoomFactor(factor) {
      zoom = Number.isFinite(factor) && factor > 0 ? factor : 1;
      for (const fn of [...zoomListeners]) {
        try {
          fn(zoom);
        } catch {
        }
      }
    }
    function refreshTextZoom() {
      const plugin = pluginOf("TextZoom");
      if (!plugin?.getPreferred) return;
      Promise.resolve(plugin.getPreferred()).then((out) => {
        const value = Number(out?.value);
        if (Number.isFinite(value) && value > 0 && value !== zoom) setZoomFactor(value);
      }, () => {
      });
    }
    let backHooked = false;
    function runBack() {
      let handled = false;
      for (const fn of [...backListeners]) {
        try {
          if (fn() === true) handled = true;
        } catch {
        }
      }
      return handled;
    }
    function hookBack() {
      if (backHooked || !native) return;
      backHooked = true;
      whenPlugin("App", (App) => {
        App.addListener?.("backButton", (event) => {
          if (runBack()) return;
          if (event?.canGoBack && typeof win.history?.back === "function") {
            win.history.back();
            return;
          }
          if (typeof App.minimizeApp === "function") App.minimizeApp();
          else App.exitApp?.();
        });
      });
    }
    const shell = {
      desktop: false,
      surface: "phone",
      platform,
      app,
      token: () => "0".repeat(64),
      // The phone's own id on the computer (HELLO.deviceId), so ext-remote can tell which row is this phone. Filled in at the first HELLO.
      device: { id: options.deviceId ?? "", name: options.deviceName ?? "" },
      caps: [...caps],
      stop(project = null) {
        const core2 = coreOf();
        if (!core2) return Promise.resolve({ state: "idle", text: "Nothing to stop: no computer is connected." });
        return core2.stop(project);
      },
      connection: () => connectionView(),
      onConnection(fn) {
        connListeners.add(fn);
        try {
          fn(connectionView());
        } catch {
        }
        return () => connListeners.delete(fn);
      },
      // Locks the app now. Resolves true when it locked; false when no lock is set (nothing happens, the channel stays open).
      lock() {
        if (!core) return Promise.resolve(false);
        return Promise.resolve(core.lock()).then((out) => out?.ok === true, () => false);
      },
      onBack(fn) {
        backListeners.add(fn);
        hookBack();
        return () => {
          backListeners.delete(fn);
        };
      },
      // From the UI page to the shell's own page: the computer list, Phone settings, pairing. openSettings() with no section is the phone's
      // own settings; a section name is the desktop UI's settings drawer (MuseUI), as before.
      openSettings(section) {
        if (section === void 0 || section === null || section === "" || section === "phone") {
          const core2 = coreOf();
          if (core2?.openShell) return Promise.resolve(core2.openShell("#settings")).catch(() => false);
          return Promise.resolve(false);
        }
        const ui = win.MuseUI;
        if (ui && typeof ui.openSettings === "function") ui.openSettings(section);
        return Promise.resolve(true);
      },
      // The paired computers as { id, name, active } (a copy: nothing in it can change the shell). The one in use is active.
      computers() {
        const state = coreOf()?.state?.();
        const list = Array.isArray(state?.computers) ? state.computers : [];
        return list.filter((c) => c && typeof c.id === "string").map((c) => ({ id: c.id, name: String(c.name ?? "Computer"), active: c.id === state.activeId }));
      },
      // Connects another paired computer. The UI that computer sends replaces this one once, the way a newer UI does (the shell opens it).
      connectComputer(id) {
        const core2 = coreOf();
        const state = core2?.state?.();
        if (!core2 || typeof id !== "string" || !(state?.computers ?? []).some((c) => c.id === id)) return Promise.resolve(false);
        return Promise.resolve(core2.connect(id)).then((out) => out?.ok !== false, () => false);
      },
      // The address the Report sheet may offer to email: set by the build from package.json bugs.email; empty while there is none.
      contactEmail: true ? "" : "",
      switchComputer() {
        const core2 = coreOf();
        return core2?.openShell ? Promise.resolve(core2.openShell("#computers")).catch(() => false) : Promise.resolve(false);
      },
      // Try again after the computer could not be reached: the shell reconnects at once.
      retry() {
        const core2 = coreOf();
        const state = core2?.state?.();
        const id = state?.activeId ?? state?.computers?.[0]?.id ?? null;
        if (!core2 || !id) return Promise.resolve(false);
        return Promise.resolve(core2.connect(id)).then((out) => out?.ok !== false, () => false);
      },
      haptic(kind = "light") {
        const haptics = pluginOf("Haptics");
        if (!haptics) return false;
        const impact = kind === "warn" || kind === "error" ? "HEAVY" : "LIGHT";
        haptics.impact?.({ style: impact })?.catch?.(() => {
        });
        return true;
      },
      textZoom: () => zoom,
      onTextZoom(fn) {
        zoomListeners.add(fn);
        return () => zoomListeners.delete(fn);
      },
      setTextZoom(factor) {
        setZoomFactor(factor);
      },
      theme: () => themeNow(),
      onTheme(fn) {
        themeListeners.add(fn);
        return () => themeListeners.delete(fn);
      },
      // The capabilities of this phone's UI. 'dictation' joins once the native plugin says it can listen (the composer then shows its mic).
      onCaps(fn) {
        capsListeners.add(fn);
        return () => capsListeners.delete(fn);
      },
      // A notification named a place in the UI (#waiting, #handover, #chat, #settings=limit, #home): { kind, id?, project?, section?, seq }. The
      // phone layer takes it with takeRoute() when it starts, and hears the later ones through onRoute(). 'plenum:route' is the same, as a DOM event.
      onRoute(fn) {
        routeListeners.add(fn);
        return () => routeListeners.delete(fn);
      },
      takeRoute: () => coreOf()?.takeRoute?.() ?? null,
      notifications: {
        state() {
          const perm = win.Notification?.permission;
          return perm ?? (platform === "web" ? "unsupported" : "native");
        },
        async request() {
          if (!win.Notification?.requestPermission) return "unsupported";
          return win.Notification.requestPermission();
        }
      },
      // Dictation on the native apps (the Dictation plugin): on the phone first, the service only when the person allows it. Results arrive as
      // events: partial and final carry text, end says it stopped, error says why.
      dictation: {
        available: async () => {
          const plugin = pluginOf("Dictation");
          if (!plugin?.available) return { available: false, onDevice: false, permission: "prompt" };
          return plugin.available();
        },
        async start(opts = {}) {
          const plugin = pluginOf("Dictation");
          if (!plugin?.start) return false;
          const prefs = coreOf()?.state?.()?.prefs ?? {};
          await plugin.start({ allowServer: prefs.dictationAllowService !== false, ...opts });
          return true;
        },
        async stop() {
          const plugin = pluginOf("Dictation");
          if (!plugin?.stop) return false;
          await plugin.stop();
          return true;
        },
        async cancel() {
          const plugin = pluginOf("Dictation");
          if (!plugin?.cancel) return false;
          await plugin.cancel();
          return true;
        },
        // Listens to one event ('partial' | 'final' | 'level' | 'end' | 'error'). Returns a function that stops listening.
        on(event, fn) {
          const plugin = pluginOf("Dictation");
          if (!plugin?.addListener) return () => {
          };
          const handle = Promise.resolve(plugin.addListener(event, fn));
          return () => {
            handle.then((h) => h?.remove?.()).catch(() => {
            });
          };
        }
      },
      // An artifact's HTML in the Android app's isolated view (a WebView with no bridge, no file or network access): show({ html, title }).
      preview: {
        available: () => Boolean(pluginOf("IsolatedPreview")),
        async show({ html, title } = {}) {
          const plugin = pluginOf("IsolatedPreview");
          if (!plugin?.show) return false;
          await plugin.show({ html: String(html ?? ""), title: String(title ?? "") });
          return true;
        }
      },
      async openExternal(href) {
        const url = new URL(String(href), win.location.href);
        if (url.protocol !== "https:") return false;
        const browser = pluginOf("Browser");
        if (browser?.open) {
          await browser.open({ url: url.href });
          return true;
        }
        win.open?.(url.href, "_blank", "noopener");
        return true;
      },
      async share(data = {}) {
        const payload = { title: String(data.title ?? ""), text: String(data.text ?? ""), url: data.url ? String(data.url) : void 0 };
        const sharePlugin = pluginOf("Share");
        if (sharePlugin?.share) {
          await sharePlugin.share(payload);
          return true;
        }
        if (win.navigator?.share) {
          await win.navigator.share(payload);
          return true;
        }
        return false;
      },
      async save({ name, blob } = {}) {
        const file = String(name ?? "plenum-file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "plenum-file";
        if (native) {
          const fsPlugin = pluginOf("Filesystem");
          const sharePlugin = pluginOf("Share");
          if (!fsPlugin?.writeFile || !sharePlugin?.share || !blob) return false;
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const written = await fsPlugin.writeFile({ path: file, data: base64Of(bytes), directory: "CACHE" });
          const uri = String(written?.uri ?? "");
          if (!uri) return false;
          await sharePlugin.share({ title: file, files: [uri] });
          return true;
        }
        if (!doc || !win.URL?.createObjectURL) return false;
        const url = win.URL.createObjectURL(blob);
        const a = doc.createElement("a");
        a.href = url;
        a.download = file;
        doc.body?.append(a);
        a.click();
        a.remove?.();
        win.setTimeout?.(() => win.URL.revokeObjectURL?.(url), 1e3);
        return true;
      },
      // A line for the computer's debug log. The shell redacts it, keeps it in the phone's own console and posts it (the page cannot reach
      // /_bridge/ itself: the worker refuses a page request there).
      debug(line) {
        core?.log?.(String(line ?? ""));
      }
    };
    const els = {};
    function build(tag, id, className) {
      const el = doc.createElement(tag);
      if (id) el.id = id;
      if (className) el.className = className;
      return el;
    }
    function button(label, className, onClick) {
      const b = build("button", null, className);
      b.setAttribute("type", "button");
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    }
    function lockMethod() {
      const mode = lockInfo.mode;
      return mode === "passkey" ? "passkey" : mode === "pin" ? "pin" : "biometric";
    }
    async function unlockFromOverlay(alsoStop) {
      const core2 = coreOf();
      if (!core2) return;
      const method = lockMethod();
      if (method === "pin") return;
      const out = await core2.unlock(method);
      if (out?.ok) {
        lockNote = "";
        if (alsoStop) await core2.stop();
      } else if (!["cancelled", "mode", "unavailable"].includes(out?.reason)) {
        lockNote = LOCK_TRY_AGAIN;
      }
      paint();
    }
    function pinNoteFor(out) {
      const wait = Math.ceil(Number(out?.waitSec) || 0);
      if (out?.reason === "wrong") return wait > 0 ? `Wrong PIN. Try again in ${wait} seconds.` : "Wrong PIN.";
      if (out?.reason === "wait") return `Try again in ${Math.max(1, wait)} seconds.`;
      return LOCK_TRY_AGAIN;
    }
    function clearPinEntry(withNote) {
      pinDigits = "";
      stopArmed = false;
      if (withNote) lockNote = "";
    }
    function armStop() {
      stopArmed = true;
      lockNote = LOCK_STOP_ARMED_NOTE;
      paintLock();
    }
    function pressPinKey(key) {
      if (pinBusy || !locked || lockMethod() !== "pin") return;
      if (key === "Delete") {
        pinDigits = pinDigits.slice(0, -1);
        paintLock();
        return;
      }
      if (pinDigits.length >= LOCK_PIN_LENGTH) return;
      pinDigits += key;
      if (pinDigits.length < LOCK_PIN_LENGTH) {
        paintLock();
        return;
      }
      submitPin().catch(() => {
      });
    }
    async function submitPin() {
      const entered = pinDigits;
      pinDigits = "";
      pinBusy = true;
      paintLock();
      let out = null;
      try {
        const core2 = coreOf();
        out = core2 ? await core2.unlock("pin", entered) : null;
      } catch {
        out = null;
      }
      pinBusy = false;
      if (out?.ok === true) {
        lockNote = "";
        if (stopArmed) {
          stopArmed = false;
          try {
            await coreOf()?.stop?.();
          } catch {
          }
        }
      } else {
        lockNote = pinNoteFor(out);
      }
      paintLock();
    }
    function mount() {
      if (!doc?.body) return;
      els.stop = build("button", "plenum-stop", "plenum-stop");
      els.stop.setAttribute("type", "button");
      els.stop.setAttribute("aria-label", "Stop");
      const mark = build("span", null, "plenum-stop-mark");
      mark.setAttribute("aria-hidden", "true");
      els.stopLabel = build("span", null, "plenum-stop-label");
      els.stopLabel.textContent = "Stop";
      els.stopNote = build("span", null, "plenum-stop-note");
      els.stopNote.setAttribute("aria-hidden", "true");
      els.stop.append(mark, els.stopLabel, els.stopNote);
      els.stop.addEventListener("click", () => {
        Promise.resolve(shell.stop()).catch(() => {
        });
      });
      els.strip = build("div", "plenum-conn-strip", "plenum-conn-strip");
      els.strip.setAttribute("role", "status");
      els.strip.hidden = true;
      els.stripText = build("span", null, "plenum-conn-text");
      els.strip.append(els.stripText);
      els.toast = build("div", "plenum-toast", "plenum-toast");
      els.toast.setAttribute("role", "status");
      els.toast.hidden = true;
      els.toastText = build("span", null, "plenum-toast-text");
      els.toastClose = button("Close", "sh-link plenum-toast-close", () => {
        noticeClosed = notice?.seq ?? null;
        paint();
      });
      els.toast.append(els.toastText, els.toastClose);
      els.sheet = build("div", "plenum-stop-sheet", "plenum-stop-sheet");
      els.sheet.setAttribute("role", "alertdialog");
      els.sheet.setAttribute("aria-labelledby", "plenum-stop-sheet-title");
      els.sheet.setAttribute("aria-describedby", "plenum-stop-sheet-body");
      els.sheet.hidden = true;
      const sheetTitle = build("h2", "plenum-stop-sheet-title", "plenum-stop-sheet-title");
      sheetTitle.textContent = STOP_FAILURE_TEXT.title;
      const sheetBody = build("p", "plenum-stop-sheet-body", "plenum-stop-sheet-body");
      sheetBody.textContent = STOP_FAILURE_TEXT.body;
      const sheetActions = build("div", null, "plenum-stop-sheet-actions");
      sheetActions.append(
        button("Try again", "sh-btn sh-btn-primary plenum-stop-sheet-retry", () => {
          Promise.resolve(shell.stop()).catch(() => {
          });
        }),
        button("Close", "sh-link plenum-stop-sheet-close", () => {
          sheetClosed = stopView.seq;
          paint();
        })
      );
      els.sheet.append(sheetTitle, sheetBody, sheetActions);
      els.lock = build("section", "plenum-lock", "plenum-lock");
      els.lock.setAttribute("role", "dialog");
      els.lock.setAttribute("aria-modal", "true");
      els.lock.setAttribute("aria-labelledby", "plenum-lock-title");
      els.lock.hidden = true;
      els.lockTitle = build("h2", "plenum-lock-title", "plenum-lock-title");
      els.lockTitle.textContent = "Plenum is locked";
      els.lockLine = build("p", null, "plenum-lock-line");
      els.lockDots = build("div", null, "sh-dots plenum-lock-dots");
      els.lockDots.setAttribute("aria-hidden", "true");
      els.lockDotList = Array.from({ length: LOCK_PIN_LENGTH }, () => build("span", null, "sh-dot"));
      els.lockDots.append(...els.lockDotList);
      els.lockCount = build("span", null, "sh-sr");
      els.lockCount.setAttribute("aria-live", "polite");
      els.lockCount.textContent = `0 of ${LOCK_PIN_LENGTH} digits entered`;
      els.lockNote = build("p", null, "plenum-lock-note");
      els.lockNote.setAttribute("role", "alert");
      els.lockPad = build("div", null, "sh-pad plenum-lock-pad");
      els.lockPad.setAttribute("role", "group");
      els.lockPad.setAttribute("aria-label", "PIN");
      els.lockKeys = [];
      for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"]) {
        if (key === null) {
          const gap = build("span", null, "sh-key-gap");
          gap.setAttribute("aria-hidden", "true");
          els.lockPad.append(gap);
          continue;
        }
        const cell = build("button", null, key === "Delete" ? "sh-key sh-key-del" : "sh-key");
        cell.setAttribute("type", "button");
        cell.setAttribute("aria-label", key);
        cell.textContent = key;
        cell.addEventListener("click", () => {
          pressPinKey(key);
        });
        els.lockKeys.push(cell);
        els.lockPad.append(cell);
      }
      els.unlock = build("button", null, "plenum-lock-unlock");
      els.unlock.setAttribute("type", "button");
      els.unlock.textContent = "Unlock";
      els.unlock.addEventListener("click", () => {
        unlockFromOverlay(false).catch(() => {
        });
      });
      els.unlockStop = build("button", null, "plenum-lock-unlock-stop");
      els.unlockStop.setAttribute("type", "button");
      els.unlockStop.textContent = LOCK_STOP_UNLOCK_LABEL;
      els.unlockStop.hidden = true;
      els.unlockStop.addEventListener("click", () => {
        if (lockStop.ready) Promise.resolve(coreOf()?.stop?.()).catch(() => {
        });
        else if (lockMethod() === "pin") armStop();
        else unlockFromOverlay(true).catch(() => {
        });
      });
      els.lock.append(els.lockTitle, els.lockLine, els.lockDots, els.lockCount, els.lockNote, els.lockPad, els.unlock, els.unlockStop);
      doc.body.append(els.strip, els.stop, els.toast, els.sheet, els.lock);
      if (doc.head && !doc.getElementById?.("plenum-shell-css")) {
        const link = build("link", "plenum-shell-css", null);
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("href", `${options.shellBase ?? "/shell/"}styles.css`);
        doc.head.append(link);
      }
      paint();
    }
    function paint() {
      if (!els.stop) return;
      const driving = drives.size > 0 || helloDriving !== null;
      const running = Number(coreOf()?.state?.()?.hello?.pending?.runs) || 0;
      if (driving) {
        els.stop.setAttribute("data-driving", "");
        els.stop.setAttribute("aria-description", `A model is driving: ${drivingLabel()}`);
      } else {
        els.stop.removeAttribute("data-driving");
        if (running > 0) els.stop.setAttribute("aria-description", running === 1 ? "1 run is going" : `${running} runs are going`);
        else els.stop.removeAttribute("aria-description");
      }
      els.stop.setAttribute("data-state", stopView.state);
      els.stopLabel.textContent = STOP_LABELS[stopView.state] ?? "Stop";
      els.stopNote.textContent = stopView.text || "";
      paintResult();
      const conn = connectionView();
      const name = conn.desktopName || "your computer";
      const when = conn.lastSeen ? ` Last seen ${conn.lastSeen}.` : "";
      const text = conn.state === "reconnecting" ? `Reconnecting to ${name}\u2026` : conn.state === "offline" ? `Can't reach ${name}.${when}` : conn.state === "asleep" ? `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.` : "";
      els.strip.hidden = text === "" || connState.status === "idle";
      els.strip.setAttribute("data-state", conn.state);
      els.stripText.textContent = text;
      paintLock();
      for (const fn of Array.from(connListeners)) {
        try {
          fn(connectionView());
        } catch {
        }
      }
    }
    function paintLock() {
      if (!els.lock) return;
      const driving = drives.size > 0 || helloDriving !== null;
      els.lock.hidden = !locked;
      els.lockLine.textContent = driving ? `A model is driving ${drivingLabel()}.` : "";
      const method = lockMethod();
      const pinMode = locked && method === "pin";
      if (!pinBusy && (!locked || pinShown && !pinMode)) clearPinEntry(true);
      pinShown = pinMode;
      const unknown = locked && lockInfo.mode === "unknown";
      els.unlock.textContent = method === "passkey" ? "Unlock with a passkey" : "Unlock";
      els.unlock.hidden = method === "pin" || unknown;
      els.lockDots.hidden = !pinMode;
      els.lockCount.hidden = !pinMode;
      els.lockPad.hidden = !pinMode;
      els.lockDotList.forEach((dot, i) => {
        if (i < pinDigits.length) dot.setAttribute("data-on", "");
        else dot.removeAttribute("data-on");
      });
      els.lockCount.textContent = `${pinDigits.length} of ${LOCK_PIN_LENGTH} digits entered`;
      if (pinBusy) els.lockPad.setAttribute("aria-busy", "true");
      else els.lockPad.removeAttribute("aria-busy");
      for (const cell of els.lockKeys) cell.disabled = pinBusy;
      if (pinMode && stopArmed) els.unlockStop.setAttribute("aria-pressed", "true");
      else els.unlockStop.removeAttribute("aria-pressed");
      els.unlockStop.hidden = !hadSession;
      els.unlockStop.textContent = lockStop.ready ? LOCK_STOP_READY_LABEL : LOCK_STOP_UNLOCK_LABEL;
      const stopShown = locked && ["sending", "queued", "done", "failed"].includes(stopView.state) && Boolean(stopView.text);
      els.lockNote.textContent = stopShown ? stopView.text : unknown ? LOCK_UNKNOWN_NOTE : lockNote;
    }
    function paintResult() {
      const note = notice;
      const open = Boolean(note) && noticeClosed !== note.seq;
      const waiting = open && note.tone === "warn" && stopView.state === "queued";
      const fresh = open && Date.now() - noticeAt < TOAST_MS;
      const show = fresh || waiting;
      els.toast.hidden = !show;
      if (show) {
        els.toastText.textContent = note.text;
        els.toast.setAttribute("data-tone", note.tone ?? "info");
      }
      els.sheet.hidden = !(stopView.state === "failed" && sheetClosed !== stopView.seq);
    }
    let boundCore = null;
    let unsubscribe = null;
    function syncFromCore() {
      if (core === boundCore) return;
      unsubscribe?.();
      boundCore = core;
      unsubscribe = null;
      if (!core?.subscribe) return;
      unsubscribe = core.subscribe((snapshot) => {
        connState = snapshot.connection ?? connState;
        locked = Boolean(snapshot.locked);
        stopView = snapshot.stop ?? stopView;
        helloDriving = snapshot.hello?.pending?.driving ?? null;
        lockInfo = snapshot.lock ?? lockInfo;
        lockStop = snapshot.lockStop ?? lockStop;
        hadSession = Boolean(snapshot.activeId) || Array.isArray(snapshot.computers) && snapshot.computers.length > 0 || hadSession;
        if (snapshot.hello) {
          helloInfo = {
            deviceId: snapshot.hello.deviceId ?? helloInfo?.deviceId ?? "",
            tier: snapshot.hello.tier ?? helloInfo?.tier ?? null,
            caps: Array.isArray(snapshot.hello.caps) ? snapshot.hello.caps.filter((c) => typeof c === "string") : helloInfo?.caps ?? []
          };
          if (helloInfo.deviceId && shell.device.id !== helloInfo.deviceId) shell.device.id = helloInfo.deviceId;
        }
        if (snapshot.notice && snapshot.notice.seq !== notice?.seq) {
          notice = snapshot.notice;
          noticeAt = Date.now();
          later(paint, TOAST_MS + 50);
        }
        const theme = snapshot.prefs?.theme ?? "follow";
        if (theme !== prefsTheme) {
          prefsTheme = theme;
          fireTheme();
        }
        const intent = snapshot.intent;
        if (intent && !intent.taken && intent.seq !== lastRouteSeq) {
          lastRouteSeq = intent.seq;
          const { taken, ...detail } = intent;
          void taken;
          let heard = false;
          for (const fn of [...routeListeners]) {
            try {
              fn(detail);
              heard = true;
            } catch {
            }
          }
          try {
            const Custom = win.CustomEvent ?? globalThis.CustomEvent;
            if (typeof win.dispatchEvent === "function" && typeof Custom === "function") win.dispatchEvent(new Custom("plenum:route", { detail }));
          } catch {
          }
          if (heard) core.takeRoute?.();
        }
        paint();
      });
    }
    function serveWorkerRequests() {
      const sw = win.navigator?.serviceWorker;
      if (!sw?.addEventListener) return;
      sw.addEventListener("message", (event) => {
        const data = event?.data;
        const port = event?.ports?.[0];
        if (!data || data.op !== "plenum-fetch" || !port) return;
        const path = String(data.path ?? "");
        const reply = (message) => port.postMessage(message);
        if (!path.startsWith(`${ARTIFACT_VIEW}?`) && path !== ARTIFACT_VIEW) {
          reply({ status: 404, headers: {}, body: null });
          return;
        }
        if (!core?.request) {
          reply({ status: 503, headers: { "content-type": "text/plain; charset=utf-8" }, body: null });
          return;
        }
        core.request({ method: "GET", path, headers: { accept: "text/html" } }).then(async (answer) => {
          let bytes = null;
          if (answer.body) bytes = await readCapped(answer.body, MAX_WORKER_BODY);
          const buffer = bytes ? bytes.buffer : null;
          reply(buffer ? { status: answer.status, headers: pickResponseHeaders(answer.headers), body: buffer } : { status: answer.status, headers: pickResponseHeaders(answer.headers), body: null });
        }).catch((err) => {
          if (err?.code === "offline") reply({ status: 503, headers: { "content-type": "text/plain; charset=utf-8" }, body: null });
          else reply({ status: err?.code === "cancelled" ? 499 : 502, headers: {}, body: null });
        });
      });
    }
    if (origFetch || win.fetch) win.fetch = shimFetch;
    win.plenumShell = shell;
    if (doc?.documentElement) doc.documentElement.setAttribute("data-surface", "phone");
    if (debugHooksOn(win.location.search)) {
      win.plenumPhoneDebug = {
        ...win.plenumPhoneDebug ?? {},
        connection(state) {
          connState = { ...connState, status: state === "connected" ? "connected" : state === "asleep" ? "asleep" : state === "reconnecting" ? "reconnecting" : "offline" };
          paint();
        },
        stopState(s) {
          stopView = { ...stopView, state: String(s), text: "" };
          paint();
        }
      };
    }
    syncFromCore();
    if (!options.core) {
      try {
        Object.defineProperty(win, "__plenumAttachShell", {
          configurable: true,
          enumerable: false,
          value: (facade) => {
            if (core || !facade) return false;
            core = facade;
            syncFromCore();
            return true;
          }
        });
      } catch {
      }
    }
    if (doc) {
      if (doc.readyState === "loading" && typeof doc.addEventListener === "function") doc.addEventListener("DOMContentLoaded", mount, { once: true });
      else mount();
    }
    serveWorkerRequests();
    lastTheme = themeNow();
    const scheme = win.matchMedia?.("(prefers-color-scheme: dark)");
    if (scheme?.addEventListener) scheme.addEventListener("change", () => fireTheme());
    else if (scheme?.addListener) scheme.addListener(() => fireTheme());
    whenPlugin("TextZoom", refreshTextZoom);
    doc?.addEventListener?.("visibilitychange", () => {
      if (doc.visibilityState !== "hidden") refreshTextZoom();
    });
    whenPlugin("App", (App) => {
      App.addListener?.("resume", refreshTextZoom);
    });
    whenPlugin("Dictation", (plugin) => {
      Promise.resolve(plugin.available?.()).then((out) => {
        if (out?.available !== true || shell.caps.includes("dictation")) return;
        shell.caps.push("dictation");
        for (const fn of [...capsListeners]) {
          try {
            fn([...shell.caps]);
          } catch {
          }
        }
      }, () => {
      });
    });
    return { shell, shimFetch, noteDriveEvent, paint, mount, syncFromCore, els, drives, setHelloDriving: (v) => {
      helloDriving = v;
      paint();
    } };
  }
  if (typeof window !== "undefined" && typeof document !== "undefined" && !window.__PLENUM_SHIM_NO_AUTOINSTALL__) {
    installShim({ win: window, doc: document, origFetch: window.fetch ? window.fetch.bind(window) : null, log: () => {
    } });
  }
})();
