(() => {
  // lib/remote/ui-manifest.mjs
  var SHELL_BASE = "/shell/", SHELL_ENTRY = "shell.js", UI_STATIC_PATHS = Object.freeze(["/", "/app.js", "/markdown.js", "/music.js", "/style.css", "/icon.png", "/mark.svg", "/ext.js"]), UI_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'";
  var EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/, STATIC_SET = new Set(UI_STATIC_PATHS);
  var SHELL_BASE_OK = /^\/(?:[A-Za-z0-9._-]+\/)*$/, TYPES = Object.freeze({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  });
  function isUiPath(pathname) {
    return STATIC_SET.has(pathname) || EXT_PATH.test(pathname);
  }
  function rewriteIndex(html, ctx = {}) {
    let shellBase = ctx.shellBase ?? SHELL_BASE;
    if (typeof shellBase != "string" || !SHELL_BASE_OK.test(shellBase)) throw new Error("shellBase must be a path such as /shell/");
    let text2 = String(html);
    if (!/<script\b[^>]*\bsrc="\/app\.js"/i.test(text2)) throw new Error("The index has no app.js tag.");
    let out = text2.replace(/<html\b([^>]*)>/i, (whole, attrs) => `<html${attrs.replace(/\s+data-surface="[^"]*"/i, "")} data-surface="phone">`);
    if (out = out.replace(/(<meta\b[^>]*\bname="viewport"[^>]*\bcontent=")([^"]*)(")/i, (whole, open, content, close) => /viewport-fit=/.test(content) ? whole : `${open}${content}, viewport-fit=cover${close}`), !/http-equiv="Content-Security-Policy"/i.test(out)) {
      let meta = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;
      if (/<meta\b[^>]*\bcharset=[^>]*>/i.test(out)) out = out.replace(/(<meta\b[^>]*\bcharset=[^>]*>)/i, (whole) => `${whole}
  ${meta}`);
      else if (/<head\b[^>]*>/i.test(out)) out = out.replace(/(<head\b[^>]*>)/i, (whole) => `${whole}
  ${meta}`);
      else throw new Error("The index has no <head>.");
    }
    let shimTags = [
      `<script src="${shellBase}boot.js"><\/script>`,
      `<script type="module" src="${shellBase}${SHELL_ENTRY}"><\/script>`
    ].filter((tag) => !out.includes(tag));
    return shimTags.length && (out = out.replace(/([ \t]*)<script\b/i, (whole, indent) => `${shimTags.map((tag) => `${indent}${tag}
`).join("")}${whole}`)), out;
  }

  // mobile/shell/sw.js
  var ACTIVE_CACHE = "plenum-ui-active", ACTIVE_PATH = "/__plenum/active.json", ARTIFACT_VIEW = "/api/artifacts/view", FALLBACK_TITLE = "Plenum", FALLBACK_BODY = "Open Plenum to see what changed.", UI_CSP = `${UI_PAGE_CSP}; frame-ancestors 'none'`, ARTIFACT_TIMEOUT_MS = 3e4, RES_HEADERS = ["content-type", "cache-control", "content-security-policy", "x-content-type-options", "x-plenum-auth", "content-disposition", "content-length"];
  function text(value, fallback, max) {
    return ((typeof value == "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "") || fallback).slice(0, max);
  }
  function hashFor(action, id = "") {
    let safeId = typeof id == "string" ? id.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) : "";
    return action === "stop" ? "#stop" : action === "deny" && safeId ? `#deny=${safeId}` : action === "approve" && safeId ? `#approve=${safeId}` : "";
  }
  async function readActive(caches) {
    let hit = await (await caches.open(ACTIVE_CACHE)).match(ACTIVE_PATH);
    if (!hit) return null;
    try {
      let record = JSON.parse(await hit.text());
      return record && typeof record.cacheName == "string" && record.complete === !0 ? record : null;
    } catch {
      return null;
    }
  }
  function plainHeaders(extra) {
    return { "cache-control": "no-cache", "x-content-type-options": "nosniff", ...extra };
  }
  function isShellPath(pathname, shellBase = "/shell/") {
    return pathname.startsWith(shellBase) && pathname.length > shellBase.length;
  }
  var SHELL_NAMES = Object.freeze(["boot.js", "shell.js", "channel.worker.js", "styles.css"]);
  function wantsShellPage(url) {
    return url.pathname === "/" && url.searchParams.has("shell");
  }
  async function uiResponse(request, env) {
    let url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== env.origin) return null;
    if (url.pathname === ARTIFACT_VIEW) return artifactResponse(url, env);
    if (wantsShellPage(url)) return null;
    let shellBase = env.shellBase ?? "/shell/";
    if (!isUiPath(url.pathname) && !isShellPath(url.pathname, shellBase)) return null;
    let active = await readActive(env.caches);
    if (!active) return isShellPath(url.pathname, shellBase) ? shellFromNetwork(url, env, shellBase) : null;
    let hit = await (await env.caches.open(active.cacheName)).match(url.pathname);
    if (!hit) return isShellPath(url.pathname, shellBase) ? shellFromNetwork(url, env, shellBase) : null;
    if (url.pathname === "/") {
      let html = rewriteIndex(await hit.text(), { shellBase: env.shellBase ?? "/shell/" });
      return new env.Response(html, { status: 200, headers: plainHeaders({ "content-type": "text/html; charset=utf-8", "content-security-policy": UI_CSP }) });
    }
    let type = hit.headers.get("content-type") ?? "application/octet-stream", headers = plainHeaders({ "content-type": type });
    return (type.startsWith("text/html") || type.includes("javascript") || type.includes("css")) && (headers["content-security-policy"] = UI_CSP), new env.Response(await hit.arrayBuffer(), { status: 200, headers });
  }
  async function shellFromNetwork(url, env, shellBase) {
    let name = url.pathname.slice(shellBase.length);
    if (!SHELL_NAMES.includes(name) || typeof env.fetch != "function") return null;
    try {
      let res = await env.fetch(new URL(name, env.workerUrl ?? env.origin + "/").href);
      return res.ok ? res : null;
    } catch {
      return null;
    }
  }
  async function windowClients(clients) {
    return clients.matchAll({ type: "window", includeUncontrolled: !0 });
  }
  async function artifactResponse(url, env) {
    let client = (await windowClients(env.clients))[0], failed = (status2, message) => new env.Response(message, { status: status2, headers: plainHeaders({ "content-type": "text/plain; charset=utf-8" }) });
    if (!client) return failed(503, "Plenum is not connected.");
    let channel = new env.MessageChannel(), answer = new Promise((resolve, reject) => {
      let timer = env.setTimeout(() => reject(new Error("timed out")), ARTIFACT_TIMEOUT_MS);
      channel.port1.onmessage = (event) => {
        env.clearTimeout(timer), resolve(event.data);
      };
    });
    client.postMessage({ op: "plenum-fetch", path: url.pathname + url.search }, [channel.port2]);
    let data;
    try {
      data = await answer;
    } catch {
      return failed(502, "The preview could not be loaded.");
    } finally {
      channel.port1.close();
    }
    let headers = {};
    for (let name of RES_HEADERS) {
      let value = data?.headers?.[name];
      value != null && (headers[name] = String(value));
    }
    let status = Number.isInteger(data?.status) && data.status >= 200 && data.status <= 599 ? data.status : 502, body = [204, 205, 304].includes(status) ? null : data?.body ?? null;
    return new env.Response(body, { status, headers: plainHeaders(headers) });
  }
  var ROUTE = /^\/#[\x21-\x7e]{1,200}$/, ACTION_NAMES = ["deny", "stop", "approve"];
  function routeOf(value) {
    return typeof value == "string" && ROUTE.test(value) ? value : "";
  }
  function computerOf(value) {
    return typeof value == "string" ? value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) : "";
  }
  function withComputer(hash, computer) {
    let id = computerOf(computer);
    return /^[0-9a-f]{64}$/.test(id) && /^#(stop|deny=|approve=)/.test(hash) ? `${hash}&computer=${id}` : hash;
  }
  function chooseActions(list, max) {
    let limit = Number.isInteger(max) && max >= 0 ? max : 2, valid = (Array.isArray(list) ? list : []).filter((a) => a && ACTION_NAMES.includes(a.action));
    if (valid.length <= limit) return valid;
    let keep = [];
    for (let name of ["stop", "approve", "deny"]) {
      let found = valid.find((a) => a.action === name);
      found && keep.length < limit && keep.push(found);
    }
    return valid.filter((a) => keep.includes(a));
  }
  async function showPush(event, env) {
    let data = null;
    try {
      data = event.data ? event.data.json() : null;
    } catch {
      data = null;
    }
    let title = text(data?.title, FALLBACK_TITLE, 60), body = text(data?.body, FALLBACK_BODY, 200), chosen = chooseActions(data?.actions, env.maxActions), routes = {};
    for (let a of Array.isArray(data?.actions) ? data.actions : [])
      a && ACTION_NAMES.includes(a.action) && routeOf(a.route) && (routes[a.action] = a.route);
    let ids = data?.ids && typeof data.ids == "object" ? data.ids : {}, options = {
      body,
      tag: text(data?.tag, "plenum", 40),
      data: {
        kind: text(data?.kind, "open", 20),
        id: text(ids.approval, "", 80),
        project: text(ids.project, "", 80),
        // B-117: the computer that sent this notification, so its Stop all, Deny and Approve reach that computer and not the one open on the phone.
        ...computerOf(ids.computer) ? { computer: computerOf(ids.computer) } : {},
        tap: routeOf(data?.tap),
        line: text(data?.firstLine, "", 200),
        routes
      },
      actions: chosen.map((a) => ({ action: a.action, title: text(a.title, a.action, 20) }))
    };
    try {
      await env.registration.showNotification(title, options);
    } catch {
      await env.registration.showNotification(FALLBACK_TITLE, { body: FALLBACK_BODY, tag: "plenum" }).catch(() => {
      });
    }
  }
  function hashForClick(action, data = {}) {
    let routes = data.routes && typeof data.routes == "object" ? data.routes : {}, route = "";
    if (action && ACTION_NAMES.includes(action) ? route = routeOf(routes[action]) : action || (route = routeOf(data.tap)), !route) return action ? hashFor(action, data.id ?? "") : hashFor(data.kind ?? "", data.id ?? "") || "";
    let hash = route.slice(1);
    return action === "approve" && data.line && (hash += `&line=${encodeURIComponent(String(data.line))}`), hash;
  }
  async function openFromNotification(event, env) {
    event.notification?.close?.();
    let data = event.notification?.data ?? {}, hash = hashForClick(event.action || "", data), computer = computerOf(data.computer), list = await windowClients(env.clients);
    if (list.length) {
      let client = list[0];
      return typeof client.focus == "function" && await client.focus(), client.postMessage(computer ? { op: "plenum-hash", hash, computer } : { op: "plenum-hash", hash }), "focused";
    }
    return await env.clients.openWindow(`${env.scope ?? "/"}${withComputer(hash, computer)}`), "opened";
  }
  function installWorker(self2, { caches, clients, registration, shellBase = "/shell/" }) {
    let env = {
      origin: self2.location.origin,
      caches,
      clients,
      registration,
      Response: self2.Response ?? globalThis.Response,
      MessageChannel: self2.MessageChannel ?? globalThis.MessageChannel,
      setTimeout: (fn, ms) => self2.setTimeout(fn, ms),
      clearTimeout: (id) => self2.clearTimeout(id),
      shellBase,
      scope: "/",
      fetch: (...args) => fetch(...args),
      workerUrl: self2.location.href,
      maxActions: self2.Notification?.maxActions
    };
    self2.addEventListener("install", (event) => event.waitUntil(self2.skipWaiting())), self2.addEventListener("activate", (event) => event.waitUntil(clients.claim())), self2.addEventListener("fetch", (event) => {
      let url = new URL(event.request.url);
      event.request.method !== "GET" || url.origin !== env.origin || wantsShellPage(url) || url.pathname !== ARTIFACT_VIEW && !isUiPath(url.pathname) && !isShellPath(url.pathname, shellBase) || event.respondWith(uiResponse(event.request, env).then((res) => res ?? fetch(event.request)));
    }), self2.addEventListener("push", (event) => event.waitUntil(showPush(event, env))), self2.addEventListener("notificationclick", (event) => event.waitUntil(openFromNotification(event, env)));
  }
  typeof self < "u" && self.registration && typeof self.addEventListener == "function" && typeof self.clients < "u" && installWorker(self, { caches: self.caches, clients: self.clients, registration: self.registration });
})();
