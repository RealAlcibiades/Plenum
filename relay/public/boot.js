(() => {
  // lib/remote/ui-manifest.mjs
  var UI_STATIC_PATHS = Object.freeze(["/", "/app.js", "/markdown.js", "/music.js", "/style.css", "/icon.png", "/mark.svg", "/ext.js"]);
  var EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/, STATIC_SET = new Set(UI_STATIC_PATHS);
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
    let loc = win?.location ?? {};
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(String(loc.hostname ?? "")) ? !1 : win?.isSecureContext === !1 || String(loc.protocol ?? "") === "http:";
  }
  function isNative(win) {
    return win?.Capacitor?.isNativePlatform?.() === !0;
  }
  function platformFor(win) {
    let cap = win?.Capacitor;
    return cap?.isNativePlatform?.() !== !0 ? "web" : String(cap.getPlatform?.() ?? "ios") === "android" ? "android" : "ios";
  }
  function capsFor(win) {
    return isNative(win) ? ["ui-bundled", "artifacts-picture", "push-none", "share", "save", "camera", "lan-control"] : isLanPage(win) ? ["ui-from-desktop", "artifacts-picture", "push-none", "share", "save"] : ["ui-from-desktop", "artifacts-iframe", "push-webpush", "share", "save"];
  }

  // mobile/shell/stop.js
  var STOP_STATES = Object.freeze(["idle", "sending", "queued", "done", "failed"]);
  var STOP_FAILURE_TEXT = Object.freeze({
    title: "Could not reach the computer",
    body: "The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run."
  });

  // mobile/shell/boot.js
  var DEV_BUILD = !1;
  function debugHooksOn(search, devBuild = DEV_BUILD) {
    return devBuild === !0 && /[?&](debug|demo|selftest)(=|&|$)/.test(String(search ?? ""));
  }
  var FACADE_PLUGINS = Object.freeze(["App", "TextZoom", "Haptics", "Dictation", "IsolatedPreview", "Browser", "Share", "Filesystem"]), REQ_HEADERS = Object.freeze(["accept", "content-type", "x-plenum-client-id"]), RES_HEADERS = Object.freeze(["content-type", "cache-control", "content-security-policy", "x-content-type-options", "x-plenum-auth", "content-disposition", "content-length"]), NULL_BODY_STATUS = Object.freeze([101, 204, 205, 304]), ARTIFACT_VIEW = "/api/artifacts/view", MAX_WORKER_BODY = 32 * 1024 * 1024, STOP_LABELS = Object.freeze({ idle: "Stop", sending: "Stopping\u2026", queued: "Stop", done: "Stopped", failed: "Stop" }), TOAST_MS = 6e3, LOCK_TRY_AGAIN = "That did not unlock Plenum. Try again.", LOCK_PIN_LENGTH = 6, LOCK_STOP_ARMED_NOTE = "Enter your PIN. Plenum stops everything once it unlocks.", LOCK_STOP_READY_LABEL = "Stop everything", LOCK_STOP_UNLOCK_LABEL = "Unlock and stop everything", LOCK_UNKNOWN_NOTE = "Plenum could not read its lock settings, so it stays locked. Stop still works. Close Plenum and open it again.", LOCK_UNKNOWN_NO_STOP_NOTE = "Plenum could not read its lock settings, so it stays locked. This phone cannot send Stop from here. Press Stop on your computer (the Stop bar, or Ctrl+Alt+Esc). Close Plenum and open it again.", RECONNECT_STRIP_MS = 1500, utf8 = new TextEncoder();
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
    let out = {};
    if (!headers) return out;
    let entries;
    Array.isArray(headers) ? entries = headers : typeof headers.forEach == "function" ? (entries = [], headers.forEach((value, key) => entries.push([key, value]))) : entries = Object.entries(headers);
    for (let [key, value] of entries) {
      let name = String(key).toLowerCase();
      REQ_HEADERS.includes(name) && (out[name] = String(value));
    }
    return out;
  }
  function pickResponseHeaders(headers) {
    let out = {};
    for (let name of RES_HEADERS) {
      let value = headers && typeof headers == "object" ? headers[name] : void 0;
      value != null && (out[name] = String(value));
    }
    return out;
  }
  async function bodyBytes(body) {
    if (body == null) return null;
    if (typeof body == "string") return utf8.encode(body);
    if (typeof URLSearchParams < "u" && body instanceof URLSearchParams) return utf8.encode(body.toString());
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    if (typeof Blob < "u" && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    throw new TypeError("This kind of request body is not sent through the phone link.");
  }
  async function readCapped(stream, cap) {
    let reader = stream.getReader(), parts = [], total = 0;
    for (; ; ) {
      let { done, value } = await reader.read();
      if (done) break;
      if (total += value.byteLength, total > cap)
        throw reader.cancel().catch(() => {
        }), new RangeError("too large");
      parts.push(value);
    }
    let out = new Uint8Array(total), offset = 0;
    for (let part of parts)
      out.set(part, offset), offset += part.byteLength;
    return out;
  }
  function sseParser(onData) {
    let buffer = "";
    return {
      push(text) {
        buffer += text;
        let end;
        for (; (end = buffer.indexOf(`

`)) >= 0; ) {
          let block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let data = block.split(`
`).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join(`
`);
          data && onData(data);
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
    let win = options.win, doc = options.doc ?? win?.document ?? null;
    if (!win || !win.location) throw new TypeError("installShim needs a window with a location");
    let origFetch = options.origFetch ?? (typeof win.fetch == "function" ? win.fetch.bind(win) : null), core = options.core ?? null, coreOf = () => core, log = options.log ?? (() => {
    }), ResponseCtor = options.Response ?? win.Response, ReadableStreamCtor = options.ReadableStream ?? win.ReadableStream, decoder = new TextDecoder(), cap = win.Capacitor, native = cap?.isNativePlatform?.() === !0, pluginOf = (name) => options.plugins?.[name] ?? core?.plugin?.(name) ?? (FACADE_PLUGINS.includes(name) ? cap?.Plugins?.[name] : null) ?? null, later = (fn, ms) => {
      let timer = win.setTimeout?.(fn, ms);
      return timer?.unref?.(), timer;
    }, whenPlugin = (name, fn) => {
      if (!native) return;
      let attempt = (tries) => {
        let found = pluginOf(name);
        if (found) {
          fn(found);
          return;
        }
        tries < 150 && later(() => attempt(tries + 1), 200);
      };
      attempt(0);
    }, drives = /* @__PURE__ */ new Map(), helloDriving = null, helloKey = null, reconnectSince = null, connState = { status: "idle" }, locked = !1, stopView = { state: "idle", text: "", seq: 0 }, helloInfo = null, lockInfo = { mode: "off" }, hadSession = !1, lockStop = { ready: !1, computerName: "" }, notice = null, noticeAt = 0, noticeShown = null, noticeClosed = null, sheetClosed = null, lockNote = "", pinDigits = "", pinBusy = !1, pinShown = !1, stopArmed = !1, prefsTheme = "follow";
    function drivingLabel() {
      if (drives.size) {
        let d = [...drives.values()][0], of = d.limits?.steps ? ` of ${d.limits.steps}` : "";
        return `${d.label || d.kind || "computer"}, step ${d.steps ?? 0}${of}`;
      }
      return helloDriving ? `${helloDriving.app || helloDriving.kind || "computer"}, step ${helloDriving.step ?? 0}${helloDriving.of ? ` of ${helloDriving.of}` : ""}` : "";
    }
    function noteDriveEvent(event) {
      if (!event || event.type !== "drive" || !event.drive || typeof event.drive != "object") return;
      let d = event.drive;
      typeof d.id == "string" && (d.state === "stopped" ? drives.delete(d.id) : drives.set(d.id, d), helloDriving = null, paint());
    }
    function syncDrives(list) {
      if (Array.isArray(list)) {
        drives.clear();
        for (let d of list) d && typeof d == "object" && typeof d.id == "string" && d.state !== "stopped" && drives.set(d.id, d);
        helloDriving = null, paint();
      }
    }
    function noteTierEvent(event) {
      event?.type !== "phone" || event.kind !== "tier" || typeof event.tier != "string" || !helloInfo || helloInfo.deviceId && event.id !== helloInfo.deviceId || (helloInfo = { ...helloInfo, tier: event.tier, ...Array.isArray(event.caps) ? { caps: event.caps.filter((c) => typeof c == "string") } : {} }, paint());
    }
    function observeEvents(stream) {
      let reader = stream.getReader(), parser = sseParser((text) => {
        try {
          let event = JSON.parse(text);
          noteDriveEvent(event), noteTierEvent(event), event && (event.type === "hello" || event.type === "state") && syncDrives(event.state?.drives);
        } catch {
        }
      });
      return new ReadableStreamCtor({
        async pull(controller) {
          let { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value), parser.push(decoder.decode(value, { stream: !0 }));
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
    }
    async function shimFetch(input, init = {}) {
      let raw = typeof input == "string" ? input : input?.url ?? String(input), url = new URL(raw, win.location.href);
      if (url.origin !== win.location.origin) throw fetchError();
      if (url.pathname.startsWith("/_bridge/"))
        return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      if (!url.pathname.startsWith("/api/") && !isUiPath(url.pathname) && url.pathname !== "/")
        return origFetch ? origFetch(input, init) : Promise.reject(fetchError());
      let method = String(init.method ?? input?.method ?? "GET").toUpperCase(), headers = pickRequestHeaders(init.headers ?? input?.headers), body = await bodyBytes(init.body);
      if (!core) throw fetchError();
      let signal = init.signal ?? input?.signal ?? null;
      if (signal?.aborted) throw abortError();
      let answer;
      try {
        answer = await core.request({ method, path: url.pathname + url.search, headers }, body, { signal });
      } catch (err) {
        if (err?.code === "refused") return new ResponseCtor('{"error":"Not found."}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
        throw mapChannelError(err);
      }
      if (NULL_BODY_STATUS.includes(answer.status))
        return answer.cancel?.(), new ResponseCtor(null, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
      let stream = url.pathname === "/api/events" ? observeEvents(answer.body) : answer.body;
      return new ResponseCtor(stream, { status: answer.status, headers: pickResponseHeaders(answer.headers) });
    }
    let zoomListeners = /* @__PURE__ */ new Set(), themeListeners = /* @__PURE__ */ new Set(), connListeners = /* @__PURE__ */ new Set(), backListeners = /* @__PURE__ */ new Set(), capsListeners = /* @__PURE__ */ new Set(), routeListeners = /* @__PURE__ */ new Set(), zoom = 1, lastTheme = null, lastRouteSeq = 0, app = options.app ?? { version: "", build: "" }, platform = options.platform ?? platformFor(win), caps = options.caps ?? capsFor(win);
    function connectionView() {
      let s = connState.status ?? "idle";
      return {
        state: s === "connected" ? "connected" : s === "asleep" ? "asleep" : s === "connecting" || s === "reconnecting" ? "reconnecting" : "offline",
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
      return prefsTheme === "dark" || prefsTheme === "light" ? prefsTheme : win.matchMedia?.("(prefers-color-scheme: dark)")?.matches === !0 ? "dark" : "light";
    }
    function fireTheme() {
      let now = themeNow();
      if (now !== lastTheme) {
        lastTheme = now;
        for (let fn of [...themeListeners])
          try {
            fn(now);
          } catch {
          }
      }
    }
    function setZoomFactor(factor) {
      zoom = Number.isFinite(factor) && factor > 0 ? factor : 1;
      for (let fn of [...zoomListeners])
        try {
          fn(zoom);
        } catch {
        }
    }
    function refreshTextZoom() {
      let plugin = pluginOf("TextZoom");
      plugin?.getPreferred && Promise.resolve(plugin.getPreferred()).then((out) => {
        let value = Number(out?.value);
        Number.isFinite(value) && value > 0 && value !== zoom && setZoomFactor(value);
      }, () => {
      });
    }
    let backHooked = !1;
    function runBack() {
      let handled = !1;
      for (let fn of [...backListeners])
        try {
          fn() === !0 && (handled = !0);
        } catch {
        }
      return handled;
    }
    function hookBack() {
      backHooked || !native || (backHooked = !0, whenPlugin("App", (App) => {
        App.addListener?.("backButton", (event) => {
          if (!runBack()) {
            if (event?.canGoBack && typeof win.history?.back == "function") {
              win.history.back();
              return;
            }
            typeof App.minimizeApp == "function" ? App.minimizeApp() : App.exitApp?.();
          }
        });
      }));
    }
    let shell = {
      desktop: !1,
      surface: "phone",
      platform,
      app,
      token: () => "0".repeat(64),
      // The phone's own id on the computer (HELLO.deviceId), so ext-remote can tell which row is this phone. Filled in at the first HELLO.
      device: { id: options.deviceId ?? "", name: options.deviceName ?? "" },
      caps: [...caps],
      stop(project = null) {
        let core2 = coreOf();
        return core2 ? core2.stop(project) : Promise.resolve({ state: "idle", text: "Nothing to stop: no computer is connected." });
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
        return core ? Promise.resolve(core.lock()).then((out) => out?.ok === !0, () => !1) : Promise.resolve(!1);
      },
      onBack(fn) {
        return backListeners.add(fn), hookBack(), () => {
          backListeners.delete(fn);
        };
      },
      // From the UI page to the shell's own page: the computer list, Phone settings, pairing. openSettings() with no section is the phone's
      // own settings; a section name is the desktop UI's settings drawer (MuseUI), as before.
      openSettings(section) {
        if (section == null || section === "" || section === "phone") {
          let core2 = coreOf();
          return core2?.openShell ? Promise.resolve(core2.openShell("#settings")).catch(() => !1) : Promise.resolve(!1);
        }
        let ui = win.MuseUI;
        return ui && typeof ui.openSettings == "function" && ui.openSettings(section), Promise.resolve(!0);
      },
      // The paired computers as { id, name, active } (a copy: nothing in it can change the shell). The one in use is active.
      computers() {
        let state = coreOf()?.state?.();
        return (Array.isArray(state?.computers) ? state.computers : []).filter((c) => c && typeof c.id == "string").map((c) => ({ id: c.id, name: String(c.name ?? "Computer"), active: c.id === state.activeId }));
      },
      // Connects another paired computer. The UI that computer sends replaces this one once, the way a newer UI does (the shell opens it).
      connectComputer(id) {
        let core2 = coreOf(), state = core2?.state?.();
        return !core2 || typeof id != "string" || !(state?.computers ?? []).some((c) => c.id === id) ? Promise.resolve(!1) : Promise.resolve(core2.connect(id)).then((out) => out?.ok !== !1, () => !1);
      },
      // The address the Report sheet may offer to email: set by the build from package.json bugs.email; empty while there is none.
      contactEmail: "",
      switchComputer() {
        let core2 = coreOf();
        return core2?.openShell ? Promise.resolve(core2.openShell("#computers")).catch(() => !1) : Promise.resolve(!1);
      },
      // Try again after the computer could not be reached: the shell reconnects at once.
      retry() {
        let core2 = coreOf(), state = core2?.state?.(), id = state?.activeId ?? state?.computers?.[0]?.id ?? null;
        return !core2 || !id ? Promise.resolve(!1) : Promise.resolve(core2.connect(id)).then((out) => out?.ok !== !1, () => !1);
      },
      haptic(kind = "light") {
        let haptics = pluginOf("Haptics");
        if (!haptics) return !1;
        let impact = kind === "warn" || kind === "error" ? "HEAVY" : "LIGHT";
        return haptics.impact?.({ style: impact })?.catch?.(() => {
        }), !0;
      },
      textZoom: () => zoom,
      onTextZoom(fn) {
        return zoomListeners.add(fn), () => zoomListeners.delete(fn);
      },
      setTextZoom(factor) {
        setZoomFactor(factor);
      },
      theme: () => themeNow(),
      onTheme(fn) {
        return themeListeners.add(fn), () => themeListeners.delete(fn);
      },
      // The capabilities of this phone's UI. 'dictation' joins once the native plugin says it can listen (the composer then shows its mic).
      onCaps(fn) {
        return capsListeners.add(fn), () => capsListeners.delete(fn);
      },
      // A notification named a place in the UI (#waiting, #handover, #chat, #settings=limit, #home): { kind, id?, project?, section?, seq }. The
      // phone layer takes it with takeRoute() when it starts, and hears the later ones through onRoute(). 'plenum:route' is the same, as a DOM event.
      onRoute(fn) {
        return routeListeners.add(fn), () => routeListeners.delete(fn);
      },
      takeRoute: () => coreOf()?.takeRoute?.() ?? null,
      notifications: {
        state() {
          return win.Notification?.permission ?? (platform === "web" ? "unsupported" : "native");
        },
        async request() {
          return win.Notification?.requestPermission ? win.Notification.requestPermission() : "unsupported";
        }
      },
      // Dictation on the native apps (the Dictation plugin): on the phone first, the service only when the person allows it. Results arrive as
      // events: partial and final carry text, end says it stopped, error says why.
      dictation: {
        available: async () => {
          let plugin = pluginOf("Dictation");
          return plugin?.available ? plugin.available() : { available: !1, onDevice: !1, permission: "prompt" };
        },
        async start(opts = {}) {
          let plugin = pluginOf("Dictation");
          if (!plugin?.start) return !1;
          let prefs = coreOf()?.state?.()?.prefs ?? {};
          return await plugin.start({ allowServer: prefs.dictationAllowService !== !1, ...opts }), !0;
        },
        async stop() {
          let plugin = pluginOf("Dictation");
          return plugin?.stop ? (await plugin.stop(), !0) : !1;
        },
        async cancel() {
          let plugin = pluginOf("Dictation");
          return plugin?.cancel ? (await plugin.cancel(), !0) : !1;
        },
        // Listens to one event ('partial' | 'final' | 'level' | 'end' | 'error'). Returns a function that stops listening.
        on(event, fn) {
          let plugin = pluginOf("Dictation");
          if (!plugin?.addListener) return () => {
          };
          let handle = Promise.resolve(plugin.addListener(event, fn));
          return () => {
            handle.then((h) => h?.remove?.()).catch(() => {
            });
          };
        }
      },
      // An artifact's HTML in the Android app's isolated view (a WebView with no bridge, no file or network access): show({ html, title }).
      preview: {
        available: () => !!pluginOf("IsolatedPreview"),
        async show({ html, title } = {}) {
          let plugin = pluginOf("IsolatedPreview");
          return plugin?.show ? (await plugin.show({ html: String(html ?? ""), title: String(title ?? "") }), !0) : !1;
        }
      },
      async openExternal(href) {
        let url = new URL(String(href), win.location.href);
        if (url.protocol !== "https:") return !1;
        let browser = pluginOf("Browser");
        return browser?.open ? (await browser.open({ url: url.href }), !0) : (win.open?.(url.href, "_blank", "noopener"), !0);
      },
      async share(data = {}) {
        let payload = { title: String(data.title ?? ""), text: String(data.text ?? ""), url: data.url ? String(data.url) : void 0 }, sharePlugin = pluginOf("Share");
        return sharePlugin?.share ? (await sharePlugin.share(payload), !0) : win.navigator?.share ? (await win.navigator.share(payload), !0) : !1;
      },
      async save({ name, blob } = {}) {
        let file = String(name ?? "plenum-file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "plenum-file";
        if (native) {
          let fsPlugin = pluginOf("Filesystem"), sharePlugin = pluginOf("Share");
          if (!fsPlugin?.writeFile || !sharePlugin?.share || !blob) return !1;
          let bytes = new Uint8Array(await blob.arrayBuffer()), written = await fsPlugin.writeFile({ path: file, data: base64Of(bytes), directory: "CACHE" }), uri = String(written?.uri ?? "");
          return uri ? (await sharePlugin.share({ title: file, files: [uri] }), !0) : !1;
        }
        if (!doc || !win.URL?.createObjectURL) return !1;
        let url = win.URL.createObjectURL(blob), a = doc.createElement("a");
        return a.href = url, a.download = file, doc.body?.append(a), a.click(), a.remove?.(), win.setTimeout?.(() => win.URL.revokeObjectURL?.(url), 1e3), !0;
      },
      // A line for the computer's debug log. The shell redacts it, keeps it in the phone's own console and posts it (the page cannot reach
      // /_bridge/ itself: the worker refuses a page request there).
      debug(line) {
        core?.log?.(String(line ?? ""));
      }
    }, els = {};
    function build(tag, id, className) {
      let el = doc.createElement(tag);
      return id && (el.id = id), className && (el.className = className), el;
    }
    function button(label, className, onClick) {
      let b = build("button", null, className);
      return b.setAttribute("type", "button"), b.textContent = label, b.addEventListener("click", onClick), b;
    }
    function lockMethod() {
      let mode = lockInfo.mode;
      return mode === "passkey" ? "passkey" : mode === "pin" ? "pin" : "biometric";
    }
    async function unlockFromOverlay(alsoStop) {
      let core2 = coreOf();
      if (!core2) return;
      let method = lockMethod();
      if (method === "pin") return;
      let out = await core2.unlock(method);
      out?.ok ? (lockNote = "", alsoStop && await core2.stop()) : ["cancelled", "mode", "unavailable"].includes(out?.reason) || (lockNote = LOCK_TRY_AGAIN), paint();
    }
    function pinNoteFor(out) {
      let wait = Math.ceil(Number(out?.waitSec) || 0);
      return out?.reason === "wrong" ? wait > 0 ? `Wrong PIN. Try again in ${wait} seconds.` : "Wrong PIN." : out?.reason === "wait" ? `Try again in ${Math.max(1, wait)} seconds.` : LOCK_TRY_AGAIN;
    }
    function clearPinEntry(withNote) {
      pinDigits = "", stopArmed = !1, withNote && (lockNote = "");
    }
    function armStop() {
      stopArmed = !0, lockNote = LOCK_STOP_ARMED_NOTE, paintLock();
    }
    function pressPinKey(key) {
      if (!(pinBusy || !locked || lockMethod() !== "pin")) {
        if (key === "Delete") {
          pinDigits = pinDigits.slice(0, -1), paintLock();
          return;
        }
        if (!(pinDigits.length >= LOCK_PIN_LENGTH)) {
          if (pinDigits += key, pinDigits.length < LOCK_PIN_LENGTH) {
            paintLock();
            return;
          }
          submitPin().catch(() => {
          });
        }
      }
    }
    async function submitPin() {
      let entered = pinDigits;
      pinDigits = "", pinBusy = !0, paintLock();
      let out = null;
      try {
        let core2 = coreOf();
        out = core2 ? await core2.unlock("pin", entered) : null;
      } catch {
        out = null;
      }
      if (pinBusy = !1, out?.ok === !0) {
        if (lockNote = "", stopArmed) {
          stopArmed = !1;
          try {
            await coreOf()?.stop?.();
          } catch {
          }
        }
      } else
        lockNote = pinNoteFor(out);
      paintLock();
    }
    function mount() {
      if (!doc?.body) return;
      els.stop = build("button", "plenum-stop", "plenum-stop"), els.stop.setAttribute("type", "button"), els.stop.setAttribute("aria-label", "Stop");
      let mark = build("span", null, "plenum-stop-mark");
      mark.setAttribute("aria-hidden", "true"), els.stopLabel = build("span", null, "plenum-stop-label"), els.stopLabel.textContent = "Stop", els.stopNote = build("span", null, "plenum-stop-note"), els.stopNote.setAttribute("aria-hidden", "true"), els.stop.append(mark, els.stopLabel, els.stopNote), els.stop.addEventListener("click", () => {
        Promise.resolve(shell.stop()).catch(() => {
        });
      }), els.strip = build("div", "plenum-conn-strip", "plenum-conn-strip"), els.strip.setAttribute("role", "status"), els.strip.hidden = !0, els.stripText = build("span", null, "plenum-conn-text"), els.strip.append(els.stripText), els.toast = build("div", "plenum-toast", "plenum-toast"), els.toast.setAttribute("role", "status"), els.toast.hidden = !0, els.toastText = build("span", null, "plenum-toast-text"), els.toastClose = button("Close", "sh-link plenum-toast-close", () => {
        noticeClosed = notice?.seq ?? null, paint();
      }), els.toast.append(els.toastText, els.toastClose), els.sheet = build("div", "plenum-stop-sheet", "plenum-stop-sheet"), els.sheet.setAttribute("role", "alertdialog"), els.sheet.setAttribute("aria-labelledby", "plenum-stop-sheet-title"), els.sheet.setAttribute("aria-describedby", "plenum-stop-sheet-body"), els.sheet.hidden = !0;
      let sheetTitle = build("h2", "plenum-stop-sheet-title", "plenum-stop-sheet-title");
      sheetTitle.textContent = STOP_FAILURE_TEXT.title;
      let sheetBody = build("p", "plenum-stop-sheet-body", "plenum-stop-sheet-body");
      sheetBody.textContent = STOP_FAILURE_TEXT.body;
      let sheetActions = build("div", null, "plenum-stop-sheet-actions");
      sheetActions.append(
        button("Try again", "sh-btn sh-btn-primary plenum-stop-sheet-retry", () => {
          Promise.resolve(shell.stop()).catch(() => {
          });
        }),
        button("Close", "sh-link plenum-stop-sheet-close", () => {
          sheetClosed = stopView.seq, paint();
        })
      ), els.sheet.append(sheetTitle, sheetBody, sheetActions), els.lock = build("section", "plenum-lock", "plenum-lock"), els.lock.setAttribute("role", "dialog"), els.lock.setAttribute("aria-modal", "true"), els.lock.setAttribute("aria-labelledby", "plenum-lock-title"), els.lock.hidden = !0, els.lockTitle = build("h2", "plenum-lock-title", "plenum-lock-title"), els.lockTitle.textContent = "Plenum is locked", els.lockLine = build("p", null, "plenum-lock-line"), els.lockDots = build("div", null, "sh-dots plenum-lock-dots"), els.lockDots.setAttribute("aria-hidden", "true"), els.lockDotList = Array.from({ length: LOCK_PIN_LENGTH }, () => build("span", null, "sh-dot")), els.lockDots.append(...els.lockDotList), els.lockCount = build("span", null, "sh-sr"), els.lockCount.setAttribute("aria-live", "polite"), els.lockCount.textContent = `0 of ${LOCK_PIN_LENGTH} digits entered`, els.lockNote = build("p", null, "plenum-lock-note"), els.lockNote.setAttribute("role", "alert"), els.lockPad = build("div", null, "sh-pad plenum-lock-pad"), els.lockPad.setAttribute("role", "group"), els.lockPad.setAttribute("aria-label", "PIN"), els.lockKeys = [];
      for (let key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", null, "0", "Delete"]) {
        if (key === null) {
          let gap = build("span", null, "sh-key-gap");
          gap.setAttribute("aria-hidden", "true"), els.lockPad.append(gap);
          continue;
        }
        let cell = build("button", null, key === "Delete" ? "sh-key sh-key-del" : "sh-key");
        cell.setAttribute("type", "button"), cell.setAttribute("aria-label", key), cell.textContent = key, cell.addEventListener("click", () => {
          pressPinKey(key);
        }), els.lockKeys.push(cell), els.lockPad.append(cell);
      }
      if (els.unlock = build("button", null, "plenum-lock-unlock"), els.unlock.setAttribute("type", "button"), els.unlock.textContent = "Unlock", els.unlock.addEventListener("click", () => {
        unlockFromOverlay(!1).catch(() => {
        });
      }), els.unlockStop = build("button", null, "plenum-lock-unlock-stop"), els.unlockStop.setAttribute("type", "button"), els.unlockStop.textContent = LOCK_STOP_UNLOCK_LABEL, els.unlockStop.hidden = !0, els.unlockStop.addEventListener("click", () => {
        lockStop.ready ? Promise.resolve(coreOf()?.stop?.()).catch(() => {
        }) : lockMethod() === "pin" ? armStop() : unlockFromOverlay(!0).catch(() => {
        });
      }), els.lock.append(els.lockTitle, els.lockLine, els.lockDots, els.lockCount, els.lockNote, els.lockPad, els.unlock, els.unlockStop), doc.body.append(els.strip, els.stop, els.toast, els.sheet, els.lock), doc.head && !doc.getElementById?.("plenum-shell-css")) {
        let link = build("link", "plenum-shell-css", null);
        link.setAttribute("rel", "stylesheet"), link.setAttribute("href", `${options.shellBase ?? "/shell/"}styles.css`), doc.head.append(link);
      }
      paint();
    }
    function paint() {
      if (!els.stop) return;
      let driving = drives.size > 0 || helloDriving !== null, running = Number(coreOf()?.state?.()?.hello?.pending?.runs) || 0;
      driving ? (els.stop.setAttribute("data-driving", ""), els.stop.setAttribute("aria-description", `A model is driving: ${drivingLabel()}`)) : (els.stop.removeAttribute("data-driving"), running > 0 ? els.stop.setAttribute("aria-description", running === 1 ? "1 run is going" : `${running} runs are going`) : els.stop.removeAttribute("aria-description")), els.stop.setAttribute("data-state", stopView.state), els.stopLabel.textContent = STOP_LABELS[stopView.state] ?? "Stop", els.stopNote.textContent = stopView.text || "", paintResult();
      let conn = connectionView(), name = conn.desktopName || "your computer", when = conn.lastSeen ? ` Last seen ${conn.lastSeen}.` : "", text = conn.state === "reconnecting" ? `Reconnecting to ${name}\u2026` : conn.state === "offline" ? `Can't reach ${name}.${when}` : conn.state === "asleep" ? `${name} is asleep or Plenum is closed.${when} Plenum reconnects when it wakes.` : "", reconnecting = conn.state === "reconnecting";
      reconnecting ? reconnectSince === null && (reconnectSince = Date.now(), later(paint, RECONNECT_STRIP_MS + 10)) : reconnectSince = null;
      let waited = !reconnecting || Date.now() - reconnectSince >= RECONNECT_STRIP_MS;
      els.strip.hidden = text === "" || connState.status === "idle" || !waited, els.strip.setAttribute("data-state", conn.state), els.stripText.textContent = text, paintLock();
      for (let fn of Array.from(connListeners))
        try {
          fn(connectionView());
        } catch {
        }
    }
    function paintLock() {
      if (!els.lock) return;
      let driving = drives.size > 0 || helloDriving !== null;
      els.lock.hidden = !locked, els.lockLine.textContent = driving ? `A model is driving ${drivingLabel()}.` : "";
      let method = lockMethod(), pinMode = locked && method === "pin";
      !pinBusy && (!locked || pinShown && !pinMode) && clearPinEntry(!0), pinShown = pinMode;
      let unknown = locked && lockInfo.mode === "unknown";
      els.unlock.textContent = method === "passkey" ? "Unlock with a passkey" : "Unlock", els.unlock.hidden = method === "pin" || unknown, els.lockDots.hidden = !pinMode, els.lockCount.hidden = !pinMode, els.lockPad.hidden = !pinMode, els.lockDotList.forEach((dot, i) => {
        i < pinDigits.length ? dot.setAttribute("data-on", "") : dot.removeAttribute("data-on");
      }), els.lockCount.textContent = `${pinDigits.length} of ${LOCK_PIN_LENGTH} digits entered`, pinBusy ? els.lockPad.setAttribute("aria-busy", "true") : els.lockPad.removeAttribute("aria-busy");
      for (let cell of els.lockKeys) cell.disabled = pinBusy;
      pinMode && stopArmed ? els.unlockStop.setAttribute("aria-pressed", "true") : els.unlockStop.removeAttribute("aria-pressed"), els.unlockStop.hidden = !hadSession || unknown && !lockStop.ready, els.unlockStop.textContent = lockStop.ready ? LOCK_STOP_READY_LABEL : LOCK_STOP_UNLOCK_LABEL;
      let stopShown = locked && ["sending", "queued", "done", "failed"].includes(stopView.state) && !!stopView.text;
      els.lockNote.textContent = stopShown ? stopView.text : unknown ? lockStop.ready ? LOCK_UNKNOWN_NOTE : LOCK_UNKNOWN_NO_STOP_NOTE : lockNote;
    }
    function paintResult() {
      let note = notice, open = !!note && noticeClosed !== note.seq, waiting = open && note.tone === "warn" && stopView.state === "queued", show = open && Date.now() - noticeAt < TOAST_MS || waiting;
      els.toast.hidden = !show, show && (els.toastText.textContent = note.text, els.toast.setAttribute("data-tone", note.tone ?? "info")), els.sheet.hidden = !(stopView.state === "failed" && sheetClosed !== stopView.seq);
    }
    let boundCore = null, unsubscribe = null;
    function syncFromCore() {
      core !== boundCore && (unsubscribe?.(), boundCore = core, unsubscribe = null, core?.subscribe && (unsubscribe = core.subscribe((snapshot) => {
        if (connState = snapshot.connection ?? connState, locked = !!snapshot.locked, stopView = snapshot.stop ?? stopView, !snapshot.hello)
          helloDriving = null, helloKey = null;
        else {
          let key = JSON.stringify(snapshot.hello.pending?.driving ?? null);
          key !== helloKey && (helloKey = key, helloDriving = snapshot.hello.pending?.driving ?? null);
        }
        lockInfo = snapshot.lock ?? lockInfo, lockStop = snapshot.lockStop ?? lockStop, hadSession = !!snapshot.activeId || Array.isArray(snapshot.computers) && snapshot.computers.length > 0 || hadSession, snapshot.hello && (helloInfo = {
          deviceId: snapshot.hello.deviceId ?? helloInfo?.deviceId ?? "",
          tier: snapshot.hello.tier ?? helloInfo?.tier ?? null,
          caps: Array.isArray(snapshot.hello.caps) ? snapshot.hello.caps.filter((c) => typeof c == "string") : helloInfo?.caps ?? []
        }, helloInfo.deviceId && shell.device.id !== helloInfo.deviceId && (shell.device.id = helloInfo.deviceId)), snapshot.notice && snapshot.notice.seq !== notice?.seq && (notice = snapshot.notice, noticeAt = Date.now(), later(paint, TOAST_MS + 50));
        let theme = snapshot.prefs?.theme ?? "follow";
        theme !== prefsTheme && (prefsTheme = theme, fireTheme());
        let intent = snapshot.intent;
        if (intent && !intent.taken && intent.seq !== lastRouteSeq) {
          lastRouteSeq = intent.seq;
          let { taken, ...detail } = intent, heard = !1;
          for (let fn of [...routeListeners])
            try {
              fn(detail), heard = !0;
            } catch {
            }
          try {
            let Custom = win.CustomEvent ?? globalThis.CustomEvent;
            typeof win.dispatchEvent == "function" && typeof Custom == "function" && win.dispatchEvent(new Custom("plenum:route", { detail }));
          } catch {
          }
          heard && core.takeRoute?.();
        }
        paint();
      })));
    }
    function serveWorkerRequests() {
      let sw = win.navigator?.serviceWorker;
      sw?.addEventListener && sw.addEventListener("message", (event) => {
        let data = event?.data, port = event?.ports?.[0];
        if (!data || data.op !== "plenum-fetch" || !port) return;
        let path = String(data.path ?? ""), reply = (message) => port.postMessage(message);
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
          answer.body && (bytes = await readCapped(answer.body, MAX_WORKER_BODY));
          let buffer = bytes ? bytes.buffer : null;
          reply(buffer ? { status: answer.status, headers: pickResponseHeaders(answer.headers), body: buffer } : { status: answer.status, headers: pickResponseHeaders(answer.headers), body: null });
        }).catch((err) => {
          err?.code === "offline" ? reply({ status: 503, headers: { "content-type": "text/plain; charset=utf-8" }, body: null }) : reply({ status: err?.code === "cancelled" ? 499 : 502, headers: {}, body: null });
        });
      });
    }
    if ((origFetch || win.fetch) && (win.fetch = shimFetch), win.plenumShell = shell, doc?.documentElement && doc.documentElement.setAttribute("data-surface", "phone"), debugHooksOn(win.location.search) && (win.plenumPhoneDebug = {
      ...win.plenumPhoneDebug ?? {},
      connection(state) {
        connState = { ...connState, status: state === "connected" ? "connected" : state === "asleep" ? "asleep" : state === "reconnecting" ? "reconnecting" : "offline" }, paint();
      },
      stopState(s) {
        stopView = { ...stopView, state: String(s), text: "" }, paint();
      }
    }), syncFromCore(), !options.core)
      try {
        Object.defineProperty(win, "__plenumAttachShell", {
          configurable: !0,
          enumerable: !1,
          value: (facade) => core || !facade ? !1 : (core = facade, syncFromCore(), !0)
        });
      } catch {
      }
    doc && (doc.readyState === "loading" && typeof doc.addEventListener == "function" ? doc.addEventListener("DOMContentLoaded", mount, { once: !0 }) : mount()), serveWorkerRequests(), lastTheme = themeNow();
    let scheme = win.matchMedia?.("(prefers-color-scheme: dark)");
    return scheme?.addEventListener ? scheme.addEventListener("change", () => fireTheme()) : scheme?.addListener && scheme.addListener(() => fireTheme()), whenPlugin("TextZoom", refreshTextZoom), doc?.addEventListener?.("visibilitychange", () => {
      doc.visibilityState !== "hidden" && refreshTextZoom();
    }), whenPlugin("App", (App) => {
      App.addListener?.("resume", refreshTextZoom);
    }), whenPlugin("Dictation", (plugin) => {
      Promise.resolve(plugin.available?.()).then((out) => {
        if (!(out?.available !== !0 || shell.caps.includes("dictation"))) {
          shell.caps.push("dictation");
          for (let fn of [...capsListeners])
            try {
              fn([...shell.caps]);
            } catch {
            }
        }
      }, () => {
      });
    }), { shell, shimFetch, noteDriveEvent, paint, mount, syncFromCore, els, drives, setHelloDriving: (v) => {
      helloDriving = v, paint();
    } };
  }
  typeof window < "u" && typeof document < "u" && !window.__PLENUM_SHIM_NO_AUTOINSTALL__ && installShim({ win: window, doc: document, origFetch: window.fetch ? window.fetch.bind(window) : null, log: () => {
  } });
})();
