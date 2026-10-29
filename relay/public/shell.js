var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: !0, configurable: !0, writable: !0, value }) : obj[key] = value;
var __esm = (fn, res, err) => function() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: !0 });
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key != "symbol" ? key + "" : key, value);

// mobile/plugins/unifiedpush/src/core.js
function isPlainObject(value) {
  return value !== null && typeof value == "object" && !Array.isArray(value);
}
function cleanText(value, max) {
  return typeof value != "string" ? "" : value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function isRoute(value) {
  return typeof value == "string" && ROUTE_RE.test(value);
}
function normaliseInstance(value) {
  if (value == null || value === "") return DEFAULT_INSTANCE;
  if (typeof value != "string" || !INSTANCE_RE.test(value))
    throw new UnifiedPushError("bad-instance", "A registration name is 1 to 64 letters, digits, dots, dashes or underscores.");
  return value;
}
function decodeBase64(text) {
  if (typeof text != "string" || text.length > Math.ceil(MAX_MESSAGE_BYTES * 4 / 3) + 8)
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  let standard = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!BASE64_RE.test(standard))
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  let unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1)
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  let padded = unpadded + "=".repeat((4 - unpadded.length % 4) % 4), binary;
  try {
    binary = atob(padded);
  } catch {
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  }
  if (binary.length > MAX_MESSAGE_BYTES)
    throw new UnifiedPushError("message-too-large", "The push message is larger than the 256 KB limit.");
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: !0 }).decode(bytes);
  } catch {
    return null;
  }
}
function parseJsonObject(text) {
  if (typeof text != "string" || text.trimStart()[0] !== "{") return null;
  try {
    let value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}
function parsePushPayload(value) {
  if (!isPlainObject(value) || value.v !== 1 || !PUSH_KINDS.includes(value.kind)) return null;
  let title = cleanText(value.title, 120) || "Plenum", body = cleanText(value.body, 240) || "Plenum has an update.", tag = typeof value.tag == "string" && TAG_RE.test(value.tag) ? value.tag : "plenum", tap = isRoute(value.tap) ? value.tap : "/#home", firstLine = cleanText(value.firstLine, 200), actions = [];
  if (Array.isArray(value.actions))
    for (let entry of value.actions) {
      if (actions.length >= 3) break;
      isPlainObject(entry) && PUSH_ACTIONS.includes(entry.action) && isRoute(entry.route) && actions.push({ action: entry.action, title: cleanText(entry.title, 40) || entry.action, route: entry.route });
    }
  let ids = isPlainObject(value.ids) ? value.ids : {};
  return {
    v: 1,
    kind: value.kind,
    title,
    body,
    tag,
    tap,
    actions,
    firstLine: firstLine || void 0,
    ids: {
      computer: cleanText(ids.computer, 80),
      project: cleanText(ids.project, 80),
      approval: cleanText(ids.approval, 80)
    }
  };
}
function routeForAction(action, firstLine) {
  return action.action !== "approve" || !firstLine ? action.route : `${action.route}&line=${encodeURIComponent(firstLine)}`;
}
function channelForKind(kind) {
  return kind === "approval" || kind === "handover" ? NOTIFICATION_CHANNELS.approvals : kind === "limit" ? NOTIFICATION_CHANNELS.limits : NOTIFICATION_CHANNELS.finished;
}
function parseMessageEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError("bad-event", "The push event is not an object.");
  let instance = normaliseInstance(event.instance), decrypted = event.decrypted === !0, bytes = decodeBase64(event.content), text = decrypted ? decodeUtf8(bytes) : null, payload = text === null ? null : parsePushPayload(parseJsonObject(text));
  return { instance, decrypted, bytes, text, payload };
}
function parseEndpointEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError("bad-event", "The endpoint event is not an object.");
  let instance = normaliseInstance(event.instance);
  if (typeof event.url != "string" || !HTTPS_URL_RE.test(event.url))
    throw new UnifiedPushError("endpoint-not-https", "The push app gave an address that is not https.");
  let keys = isPlainObject(event.pubKeySet) && typeof event.pubKeySet.pubKey == "string" && BASE64URL_RE.test(event.pubKeySet.pubKey) && typeof event.pubKeySet.auth == "string" && BASE64URL_RE.test(event.pubKeySet.auth) ? { pubKey: event.pubKeySet.pubKey, auth: event.pubKeySet.auth } : null;
  return { instance, url: event.url, temporary: event.temporary === !0, keys };
}
var UNIFIEDPUSH_EVENTS, FAILED_REASONS, DEFAULT_INSTANCE, MAX_MESSAGE_BYTES, PUSH_KINDS, PUSH_ACTIONS, NOTIFICATION_CHANNELS, INSTANCE_RE, BASE64URL_RE, BASE64_RE, HTTPS_URL_RE, TAG_RE, ROUTE_RE, UnifiedPushError, init_core = __esm({
  "mobile/plugins/unifiedpush/src/core.js"() {
    UNIFIEDPUSH_EVENTS = Object.freeze(["endpoint", "registrationFailed", "unregistered", "tempUnavailable", "message"]), FAILED_REASONS = Object.freeze(["INTERNAL_ERROR", "NETWORK", "ACTION_REQUIRED", "VAPID_REQUIRED"]), DEFAULT_INSTANCE = "default", MAX_MESSAGE_BYTES = 256 * 1024, PUSH_KINDS = Object.freeze(["approval", "handover", "finished", "failed", "limit", "test"]), PUSH_ACTIONS = Object.freeze(["deny", "stop", "approve"]), NOTIFICATION_CHANNELS = Object.freeze({
      approvals: "plenum-approvals",
      finished: "plenum-finished",
      limits: "plenum-limits"
    }), INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/, BASE64URL_RE = /^[A-Za-z0-9_-]+$/, BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/, HTTPS_URL_RE = /^https:\/\/\S{1,2000}$/, TAG_RE = /^plenum-[0-9a-f]{32}$/, ROUTE_RE = /^\/#[\x21-\x7e]{1,200}$/, UnifiedPushError = class extends Error {
      constructor(code, message) {
        super(message), this.name = "UnifiedPushError", this.code = code;
      }
    };
  }
});

// mobile/node_modules/@capacitor/core/dist/index.js
var ExceptionCode, CapacitorException, getPlatformId, createCapacitor, initCapacitorGlobal, Capacitor, registerPlugin, WebPlugin, WebView, encode, decode, CapacitorCookiesPluginWeb, CapacitorCookies, readBlobAsBase64, normalizeHttpHeaders, buildUrlParams, buildRequestInit, CapacitorHttpPluginWeb, CapacitorHttp, SystemBarsStyle, SystemBarType, SystemBarsPluginWeb, SystemBars, init_dist = __esm({
  "mobile/node_modules/@capacitor/core/dist/index.js"() {
    (function(ExceptionCode2) {
      ExceptionCode2.Unimplemented = "UNIMPLEMENTED", ExceptionCode2.Unavailable = "UNAVAILABLE";
    })(ExceptionCode || (ExceptionCode = {}));
    CapacitorException = class extends Error {
      constructor(message, code, data) {
        super(message), this.message = message, this.code = code, this.data = data;
      }
    }, getPlatformId = (win) => {
      var _a, _b;
      return win?.androidBridge ? "android" : !((_b = (_a = win?.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0) && _b.bridge ? "ios" : "web";
    }, createCapacitor = (win) => {
      let capCustomPlatform = win.CapacitorCustomPlatform || null, cap = win.Capacitor || {}, Plugins = cap.Plugins = cap.Plugins || {}, getPlatform = () => capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win), isNativePlatform = () => getPlatform() !== "web", isPluginAvailable = (pluginName) => {
        let plugin = registeredPlugins.get(pluginName);
        return !!(plugin?.platforms.has(getPlatform()) || getPluginHeader(pluginName));
      }, getPluginHeader = (pluginName) => {
        var _a;
        return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
      }, handleError = (err) => win.console.error(err), registeredPlugins = /* @__PURE__ */ new Map(), registerPlugin2 = (pluginName, jsImplementations = {}) => {
        let registeredPlugin = registeredPlugins.get(pluginName);
        if (registeredPlugin)
          return console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`), registeredPlugin.proxy;
        let platform = getPlatform(), pluginHeader = getPluginHeader(pluginName), jsImplementation, loadPluginImplementation = async () => (!jsImplementation && platform in jsImplementations ? jsImplementation = typeof jsImplementations[platform] == "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform] : capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations && (jsImplementation = typeof jsImplementations.web == "function" ? jsImplementation = await jsImplementations.web() : jsImplementation = jsImplementations.web), jsImplementation), createPluginMethod = (impl, prop) => {
          var _a, _b;
          if (pluginHeader) {
            let methodHeader = pluginHeader?.methods.find((m) => prop === m.name);
            if (methodHeader)
              return methodHeader.rtype === "promise" ? (options) => cap.nativePromise(pluginName, prop.toString(), options) : (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
            if (impl)
              return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
          } else {
            if (impl)
              return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
            throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, ExceptionCode.Unimplemented);
          }
        }, createPluginMethodWrapper = (prop) => {
          let remove, wrapper = (...args) => {
            let p = loadPluginImplementation().then((impl) => {
              let fn = createPluginMethod(impl, prop);
              if (fn) {
                let p2 = fn(...args);
                return remove = p2?.remove, p2;
              } else
                throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, ExceptionCode.Unimplemented);
            });
            return prop === "addListener" && (p.remove = async () => remove()), p;
          };
          return wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`, Object.defineProperty(wrapper, "name", {
            value: prop,
            writable: !1,
            configurable: !1
          }), wrapper;
        }, addListener = createPluginMethodWrapper("addListener"), removeListener = createPluginMethodWrapper("removeListener"), addListenerNative = (eventName, callback) => {
          let call = addListener({ eventName }, callback), remove = async () => {
            let callbackId = await call;
            removeListener({
              eventName,
              callbackId
            }, callback);
          }, p = new Promise((resolve) => call.then(() => resolve({ remove })));
          return p.remove = async () => {
            console.warn("Using addListener() without 'await' is deprecated."), await remove();
          }, p;
        }, proxy3 = new Proxy({}, {
          get(_, prop) {
            switch (prop) {
              // https://github.com/facebook/react/issues/20030
              case "$$typeof":
                return;
              case "toJSON":
                return () => ({});
              case "addListener":
                return pluginHeader ? addListenerNative : addListener;
              case "removeListener":
                return removeListener;
              default:
                return createPluginMethodWrapper(prop);
            }
          }
        });
        return Plugins[pluginName] = proxy3, registeredPlugins.set(pluginName, {
          name: pluginName,
          proxy: proxy3,
          platforms: /* @__PURE__ */ new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
        }), proxy3;
      };
      return cap.convertFileSrc || (cap.convertFileSrc = (filePath) => filePath), cap.getPlatform = getPlatform, cap.handleError = handleError, cap.isNativePlatform = isNativePlatform, cap.isPluginAvailable = isPluginAvailable, cap.registerPlugin = registerPlugin2, cap.Exception = CapacitorException, cap.DEBUG = !!cap.DEBUG, cap.isLoggingEnabled = !!cap.isLoggingEnabled, cap;
    }, initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win), Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis < "u" ? globalThis : typeof self < "u" ? self : typeof window < "u" ? window : typeof global < "u" ? global : {}), registerPlugin = Capacitor.registerPlugin, WebPlugin = class {
      constructor() {
        this.listeners = {}, this.retainedEventArguments = {}, this.windowListeners = {};
      }
      addListener(eventName, listenerFunc) {
        let firstListener = !1;
        this.listeners[eventName] || (this.listeners[eventName] = [], firstListener = !0), this.listeners[eventName].push(listenerFunc);
        let windowListener = this.windowListeners[eventName];
        windowListener && !windowListener.registered && this.addWindowListener(windowListener), firstListener && this.sendRetainedArgumentsForEvent(eventName);
        let remove = async () => this.removeListener(eventName, listenerFunc);
        return Promise.resolve({ remove });
      }
      async removeAllListeners() {
        this.listeners = {};
        for (let listener in this.windowListeners)
          this.removeWindowListener(this.windowListeners[listener]);
        this.windowListeners = {};
      }
      notifyListeners(eventName, data, retainUntilConsumed) {
        let listeners = this.listeners[eventName];
        if (!listeners) {
          if (retainUntilConsumed) {
            let args = this.retainedEventArguments[eventName];
            args || (args = []), args.push(data), this.retainedEventArguments[eventName] = args;
          }
          return;
        }
        listeners.forEach((listener) => listener(data));
      }
      hasListeners(eventName) {
        var _a;
        return !!(!((_a = this.listeners[eventName]) === null || _a === void 0) && _a.length);
      }
      registerWindowListener(windowEventName, pluginEventName) {
        this.windowListeners[pluginEventName] = {
          registered: !1,
          windowEventName,
          pluginEventName,
          handler: (event) => {
            this.notifyListeners(pluginEventName, event);
          }
        };
      }
      unimplemented(msg = "not implemented") {
        return new Capacitor.Exception(msg, ExceptionCode.Unimplemented);
      }
      unavailable(msg = "not available") {
        return new Capacitor.Exception(msg, ExceptionCode.Unavailable);
      }
      async removeListener(eventName, listenerFunc) {
        let listeners = this.listeners[eventName];
        if (!listeners)
          return;
        let index = listeners.indexOf(listenerFunc);
        index !== -1 && this.listeners[eventName].splice(index, 1), this.listeners[eventName].length || this.removeWindowListener(this.windowListeners[eventName]);
      }
      addWindowListener(handle) {
        window.addEventListener(handle.windowEventName, handle.handler), handle.registered = !0;
      }
      removeWindowListener(handle) {
        handle && (window.removeEventListener(handle.windowEventName, handle.handler), handle.registered = !1);
      }
      sendRetainedArgumentsForEvent(eventName) {
        let args = this.retainedEventArguments[eventName];
        args && (delete this.retainedEventArguments[eventName], args.forEach((arg) => {
          this.notifyListeners(eventName, arg);
        }));
      }
    }, WebView = /* @__PURE__ */ registerPlugin("WebView"), encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape), decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent), CapacitorCookiesPluginWeb = class extends WebPlugin {
      async getCookies() {
        let cookies = document.cookie, cookieMap = {};
        return cookies.split(";").forEach((cookie) => {
          if (cookie.length <= 0)
            return;
          let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
          key = decode(key).trim(), value = decode(value).trim(), cookieMap[key] = value;
        }), cookieMap;
      }
      async setCookie(options) {
        try {
          let encodedKey = encode(options.key), encodedValue = encode(options.value), expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "", path = (options.path || "/").replace("path=", ""), domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
          document.cookie = `${encodedKey}=${encodedValue || ""}${expires}; path=${path}; ${domain};`;
        } catch (error) {
          return Promise.reject(error);
        }
      }
      async deleteCookie(options) {
        try {
          document.cookie = `${options.key}=; Max-Age=0`;
        } catch (error) {
          return Promise.reject(error);
        }
      }
      async clearCookies() {
        try {
          let cookies = document.cookie.split(";") || [];
          for (let cookie of cookies)
            document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      async clearAllCookies() {
        try {
          await this.clearCookies();
        } catch (error) {
          return Promise.reject(error);
        }
      }
    }, CapacitorCookies = registerPlugin("CapacitorCookies", {
      web: () => new CapacitorCookiesPluginWeb()
    }), readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
      let reader = new FileReader();
      reader.onload = () => {
        let base64String = reader.result;
        resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
      }, reader.onerror = (error) => reject(error), reader.readAsDataURL(blob);
    }), normalizeHttpHeaders = (headers = {}) => {
      let originalKeys = Object.keys(headers);
      return Object.keys(headers).map((k) => k.toLocaleLowerCase()).reduce((acc, key, index) => (acc[key] = headers[originalKeys[index]], acc), {});
    }, buildUrlParams = (params, shouldEncode = !0) => params ? Object.entries(params).reduce((accumulator, entry) => {
      let [key, value] = entry, encodedValue, item;
      return Array.isArray(value) ? (item = "", value.forEach((str) => {
        encodedValue = shouldEncode ? encodeURIComponent(str) : str, item += `${key}=${encodedValue}&`;
      }), item.slice(0, -1)) : (encodedValue = shouldEncode ? encodeURIComponent(value) : value, item = `${key}=${encodedValue}`), `${accumulator}&${item}`;
    }, "").substr(1) : null, buildRequestInit = (options, extra = {}) => {
      let output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra), type = normalizeHttpHeaders(options.headers)["content-type"] || "";
      if (typeof options.data == "string")
        output.body = options.data;
      else if (type.includes("application/x-www-form-urlencoded")) {
        let params = new URLSearchParams();
        for (let [key, value] of Object.entries(options.data || {}))
          params.set(key, value);
        output.body = params.toString();
      } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
        let form = new FormData();
        if (options.data instanceof FormData)
          options.data.forEach((value, key) => {
            form.append(key, value);
          });
        else
          for (let key of Object.keys(options.data))
            form.append(key, options.data[key]);
        output.body = form;
        let headers2 = new Headers(output.headers);
        headers2.delete("content-type"), output.headers = headers2;
      } else (type.includes("application/json") || typeof options.data == "object") && (output.body = JSON.stringify(options.data));
      return output;
    }, CapacitorHttpPluginWeb = class extends WebPlugin {
      /**
       * Perform an Http request given a set of options
       * @param options Options to build the HTTP request
       */
      async request(options) {
        let requestInit = buildRequestInit(options, options.webFetchExtra), urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams), url = urlParams ? `${options.url}?${urlParams}` : options.url, response = await fetch(url, requestInit), contentType = response.headers.get("content-type") || "", { responseType = "text" } = response.ok ? options : {};
        contentType.includes("application/json") && (responseType = "json");
        let data, blob;
        switch (responseType) {
          case "arraybuffer":
          case "blob":
            blob = await response.blob(), data = await readBlobAsBase64(blob);
            break;
          case "json":
            data = await response.json();
            break;
          default:
            data = await response.text();
        }
        let headers = {};
        return response.headers.forEach((value, key) => {
          headers[key] = value;
        }), {
          data,
          headers,
          status: response.status,
          url: response.url
        };
      }
      /**
       * Perform an Http GET request given a set of options
       * @param options Options to build the HTTP request
       */
      async get(options) {
        return this.request(Object.assign(Object.assign({}, options), { method: "GET" }));
      }
      /**
       * Perform an Http POST request given a set of options
       * @param options Options to build the HTTP request
       */
      async post(options) {
        return this.request(Object.assign(Object.assign({}, options), { method: "POST" }));
      }
      /**
       * Perform an Http PUT request given a set of options
       * @param options Options to build the HTTP request
       */
      async put(options) {
        return this.request(Object.assign(Object.assign({}, options), { method: "PUT" }));
      }
      /**
       * Perform an Http PATCH request given a set of options
       * @param options Options to build the HTTP request
       */
      async patch(options) {
        return this.request(Object.assign(Object.assign({}, options), { method: "PATCH" }));
      }
      /**
       * Perform an Http DELETE request given a set of options
       * @param options Options to build the HTTP request
       */
      async delete(options) {
        return this.request(Object.assign(Object.assign({}, options), { method: "DELETE" }));
      }
    }, CapacitorHttp = registerPlugin("CapacitorHttp", {
      web: () => new CapacitorHttpPluginWeb()
    });
    (function(SystemBarsStyle2) {
      SystemBarsStyle2.Dark = "DARK", SystemBarsStyle2.Light = "LIGHT", SystemBarsStyle2.Default = "DEFAULT";
    })(SystemBarsStyle || (SystemBarsStyle = {}));
    (function(SystemBarType2) {
      SystemBarType2.StatusBar = "StatusBar", SystemBarType2.NavigationBar = "NavigationBar";
    })(SystemBarType || (SystemBarType = {}));
    SystemBarsPluginWeb = class extends WebPlugin {
      async setStyle() {
        this.unavailable("not available for web");
      }
      async setAnimation() {
        this.unavailable("not available for web");
      }
      async show() {
        this.unavailable("not available for web");
      }
      async hide() {
        this.unavailable("not available for web");
      }
    }, SystemBars = registerPlugin("SystemBars", {
      web: () => new SystemBarsPluginWeb()
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/definitions.js
var StorageErrorType, KeychainAccess, StorageError, init_definitions = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/definitions.js"() {
    (function(StorageErrorType2) {
      StorageErrorType2.missingKey = "missingKey", StorageErrorType2.invalidData = "invalidData", StorageErrorType2.osError = "osError", StorageErrorType2.unknownError = "unknownError", StorageErrorType2.missingPrefix = "missingPrefix";
    })(StorageErrorType || (StorageErrorType = {}));
    (function(KeychainAccess2) {
      KeychainAccess2[KeychainAccess2.whenUnlocked = 0] = "whenUnlocked", KeychainAccess2[KeychainAccess2.whenUnlockedThisDeviceOnly = 1] = "whenUnlockedThisDeviceOnly", KeychainAccess2[KeychainAccess2.afterFirstUnlock = 2] = "afterFirstUnlock", KeychainAccess2[KeychainAccess2.afterFirstUnlockThisDeviceOnly = 3] = "afterFirstUnlockThisDeviceOnly", KeychainAccess2[KeychainAccess2.whenPasscodeSetThisDeviceOnly = 4] = "whenPasscodeSetThisDeviceOnly";
    })(KeychainAccess || (KeychainAccess = {}));
    StorageError = class extends Error {
      constructor(message, code) {
        super(message), this.name = "StorageError", this.code = code;
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/base.js
function isStorageErrorType(value) {
  return value !== void 0 && Object.keys(StorageErrorType).includes(value);
}
function parseISODate(isoDate) {
  let match = isoDateRE.exec(isoDate);
  if (match) {
    let year = Number.parseInt(match[1], 10), month = Number.parseInt(match[2], 10) - 1, day = Number.parseInt(match[3], 10), hour = Number.parseInt(match[4], 10), minute = Number.parseInt(match[5], 10), second = Number.parseInt(match[6], 10), millis = Number.parseInt(match[7], 10), epochTime = Date.UTC(year, month, day, hour, minute, second, millis);
    return new Date(epochTime);
  }
  return null;
}
var SecureStorageBase, isoDateRE, init_base = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/base.js"() {
    init_dist();
    init_definitions();
    SecureStorageBase = class _SecureStorageBase extends WebPlugin {
      constructor() {
        super(...arguments), this.prefix = "capacitor-storage_", this.sync = !1, this.access = KeychainAccess.whenUnlocked;
      }
      async setSynchronize(sync) {
        if (this.sync = sync, Capacitor.getPlatform() === "ios")
          return this.setSynchronizeKeychain({ sync });
      }
      async getSynchronize() {
        return this.sync;
      }
      async setDefaultKeychainAccess(access) {
        this.access = access;
      }
      async tryOperation(operation) {
        try {
          return await operation();
        } catch (error) {
          throw error instanceof CapacitorException && isStorageErrorType(error.code) ? new StorageError(error.message, error.code) : error;
        }
      }
      async get(key, convertDate = !0, sync) {
        if (key) {
          let { data } = await this.tryOperation(async () => this.internalGetItem({
            prefixedKey: this.prefixedKey(key),
            sync: sync ?? this.sync
          }));
          if (data === null)
            return null;
          if (convertDate) {
            let date = parseISODate(data);
            if (date)
              return date;
          }
          try {
            return JSON.parse(data);
          } catch {
            throw new StorageError("Invalid data", StorageErrorType.invalidData);
          }
        }
        return _SecureStorageBase.missingKey();
      }
      async getItem(key) {
        if (key) {
          let { data } = await this.tryOperation(async () => this.internalGetItem({
            prefixedKey: this.prefixedKey(key),
            sync: this.sync
          }));
          return data;
        }
        return null;
      }
      async set(key, data, convertDate = !0, sync, access) {
        if (key) {
          let convertedData = data;
          return convertDate && data instanceof Date && (convertedData = data.toISOString()), this.tryOperation(async () => this.internalSetItem({
            prefixedKey: this.prefixedKey(key),
            data: JSON.stringify(convertedData),
            sync: sync ?? this.sync,
            access: access ?? this.access
          }));
        }
        return _SecureStorageBase.missingKey();
      }
      async setItem(key, value) {
        return key ? this.tryOperation(async () => this.internalSetItem({
          prefixedKey: this.prefixedKey(key),
          data: value,
          sync: this.sync,
          access: this.access
        })) : _SecureStorageBase.missingKey();
      }
      async remove(key, sync) {
        if (key) {
          let { success } = await this.tryOperation(async () => this.internalRemoveItem({
            prefixedKey: this.prefixedKey(key),
            sync: sync ?? this.sync
          }));
          return success;
        }
        return _SecureStorageBase.missingKey();
      }
      async removeItem(key) {
        if (key) {
          await this.tryOperation(async () => this.internalRemoveItem({
            prefixedKey: this.prefixedKey(key),
            sync: this.sync
          }));
          return;
        }
        _SecureStorageBase.missingKey();
      }
      async clearItemsWithPrefix(options) {
        let prefix = this.checkPrefix(options.prefix);
        await this.tryOperation(async () => this.internalClearItemsWithPrefix({
          prefix,
          sync: this.sync
        }));
      }
      checkPrefix(prefix) {
        if (prefix.trim().length === 0)
          throw new StorageError("Non-blank prefix provided", StorageErrorType.missingPrefix);
        return prefix;
      }
      async keys(sync) {
        let { keys } = await this.tryOperation(async () => this.internalGetPrefixedKeys({
          prefix: this.prefix,
          sync: sync ?? this.sync
        })), prefixLength = this.prefix.length;
        return keys.map((key) => key.slice(prefixLength));
      }
      async getKeyPrefix() {
        return this.prefix;
      }
      async setKeyPrefix(prefix) {
        this.prefix = this.checkPrefix(prefix);
      }
      prefixedKey(key) {
        return this.prefix + key;
      }
      static missingKey() {
        throw new StorageError("No key provided", StorageErrorType.missingKey);
      }
    }, isoDateRE = /^"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).(\d{3})Z"$/u;
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/web.js
var web_exports = {};
__export(web_exports, {
  SecureStorageWeb: () => SecureStorageWeb
});
var SecureStorageWeb, init_web = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/web.js"() {
    init_base();
    SecureStorageWeb = class extends SecureStorageBase {
      // @native
      async setSynchronizeKeychain(_options) {
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalGetItem(options) {
        return { data: localStorage.getItem(options.prefixedKey) };
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalSetItem(options) {
        localStorage.setItem(options.prefixedKey, options.data);
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalRemoveItem(options) {
        return localStorage.getItem(options.prefixedKey) !== null ? (localStorage.removeItem(options.prefixedKey), { success: !0 }) : { success: !1 };
      }
      async clear() {
        let { keys } = await this.internalGetPrefixedKeys({ prefix: this.prefix });
        for (let key of keys)
          localStorage.removeItem(key);
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalClearItemsWithPrefix(_options) {
        console.warn("internalClearItemsWithPrefix is native only");
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalGetPrefixedKeys(options) {
        let keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          let key = localStorage.key(i);
          key?.startsWith(options.prefix) && keys.push(key);
        }
        return { keys };
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/native.js
var native_exports = {};
__export(native_exports, {
  SecureStorageNative: () => SecureStorageNative
});
var SecureStorageNative, init_native = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/native.js"() {
    init_base();
    SecureStorageNative = class extends SecureStorageBase {
      constructor(capProxy) {
        super();
        let proxy3 = capProxy;
        this.setSynchronizeKeychain = proxy3.setSynchronizeKeychain, this.internalGetItem = proxy3.internalGetItem, this.internalSetItem = proxy3.internalSetItem, this.internalRemoveItem = proxy3.internalRemoveItem, this.internalClearItemsWithPrefix = proxy3.internalClearItemsWithPrefix, this.internalGetPrefixedKeys = proxy3.internalGetPrefixedKeys;
      }
      // @native
      async setSynchronizeKeychain(_options) {
      }
      // @native
      async internalGetItem(_options) {
        return { data: "" };
      }
      // @native
      async internalSetItem(_options) {
      }
      // @native
      async internalRemoveItem(_options) {
        return { success: !0 };
      }
      async clear(sync) {
        return this.tryOperation(async () => this.clearItemsWithPrefix({
          prefix: this.prefix,
          sync: sync ?? this.sync
        }));
      }
      // @native
      async internalClearItemsWithPrefix(_options) {
      }
      // @native
      async internalGetPrefixedKeys(_options) {
        return { keys: [] };
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/index.js
var proxy, init_esm = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/index.js"() {
    init_dist();
    init_definitions();
    proxy = registerPlugin("SecureStorage", {
      web: async () => {
        let module = await Promise.resolve().then(() => (init_web(), web_exports));
        return new module.SecureStorageWeb();
      },
      ios: async () => {
        let module = await Promise.resolve().then(() => (init_native(), native_exports));
        return new module.SecureStorageNative(proxy);
      },
      android: async () => {
        let module = await Promise.resolve().then(() => (init_native(), native_exports));
        return new module.SecureStorageNative(proxy);
      }
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/definitions.js
function isBiometryErrorType(value) {
  return typeof value == "string" && // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Object.values(BiometryErrorType).includes(value);
}
var BiometryType, AndroidBiometryStrength, BiometryErrorType, BiometryError, init_definitions2 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/definitions.js"() {
    (function(BiometryType2) {
      BiometryType2[BiometryType2.none = 0] = "none", BiometryType2[BiometryType2.touchId = 1] = "touchId", BiometryType2[BiometryType2.faceId = 2] = "faceId", BiometryType2[BiometryType2.fingerprintAuthentication = 3] = "fingerprintAuthentication", BiometryType2[BiometryType2.faceAuthentication = 4] = "faceAuthentication", BiometryType2[BiometryType2.irisAuthentication = 5] = "irisAuthentication";
    })(BiometryType || (BiometryType = {}));
    (function(AndroidBiometryStrength2) {
      AndroidBiometryStrength2[AndroidBiometryStrength2.weak = 0] = "weak", AndroidBiometryStrength2[AndroidBiometryStrength2.strong = 1] = "strong";
    })(AndroidBiometryStrength || (AndroidBiometryStrength = {}));
    (function(BiometryErrorType2) {
      BiometryErrorType2.none = "", BiometryErrorType2.appCancel = "appCancel", BiometryErrorType2.authenticationFailed = "authenticationFailed", BiometryErrorType2.invalidContext = "invalidContext", BiometryErrorType2.notInteractive = "notInteractive", BiometryErrorType2.passcodeNotSet = "passcodeNotSet", BiometryErrorType2.systemCancel = "systemCancel", BiometryErrorType2.userCancel = "userCancel", BiometryErrorType2.userFallback = "userFallback", BiometryErrorType2.biometryLockout = "biometryLockout", BiometryErrorType2.biometryNotAvailable = "biometryNotAvailable", BiometryErrorType2.biometryNotEnrolled = "biometryNotEnrolled", BiometryErrorType2.noDeviceCredential = "noDeviceCredential";
    })(BiometryErrorType || (BiometryErrorType = {}));
    BiometryError = class _BiometryError extends Error {
      constructor(message, code) {
        super(message), this.code = code, this.name = "BiometryError", Object.setPrototypeOf(this, _BiometryError.prototype);
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web-utils.js
function getBiometryName(type) {
  return kBiometryTypeNameMap[type] || "";
}
var kBiometryTypeNameMap, init_web_utils = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web-utils.js"() {
    init_definitions2();
    kBiometryTypeNameMap = {
      [BiometryType.none]: "",
      [BiometryType.touchId]: "Touch ID",
      [BiometryType.faceId]: "Face ID",
      [BiometryType.fingerprintAuthentication]: "Fingerprint Authentication",
      [BiometryType.faceAuthentication]: "Face Authentication",
      [BiometryType.irisAuthentication]: "Iris Authentication"
    };
  }
});

// mobile/node_modules/@capacitor/app/dist/esm/definitions.js
var init_definitions3 = __esm({
  "mobile/node_modules/@capacitor/app/dist/esm/definitions.js"() {
  }
});

// mobile/node_modules/@capacitor/app/dist/esm/web.js
var web_exports2 = {};
__export(web_exports2, {
  AppWeb: () => AppWeb
});
var AppWeb, init_web2 = __esm({
  "mobile/node_modules/@capacitor/app/dist/esm/web.js"() {
    init_dist();
    AppWeb = class extends WebPlugin {
      constructor() {
        super(), this.handleVisibilityChange = () => {
          let data = {
            isActive: document.hidden !== !0
          };
          this.notifyListeners("appStateChange", data), document.hidden ? this.notifyListeners("pause", null) : this.notifyListeners("resume", null);
        }, document.addEventListener("visibilitychange", this.handleVisibilityChange, !1);
      }
      exitApp() {
        throw this.unimplemented("Not implemented on web.");
      }
      async getInfo() {
        throw this.unimplemented("Not implemented on web.");
      }
      async getLaunchUrl() {
        return { url: "" };
      }
      async getState() {
        return { isActive: document.hidden !== !0 };
      }
      async minimizeApp() {
        throw this.unimplemented("Not implemented on web.");
      }
      async toggleBackButtonHandler() {
        throw this.unimplemented("Not implemented on web.");
      }
      async getAppLanguage() {
        return {
          value: navigator.language.split("-")[0].toLowerCase()
        };
      }
    };
  }
});

// mobile/node_modules/@capacitor/app/dist/esm/index.js
var App, init_esm2 = __esm({
  "mobile/node_modules/@capacitor/app/dist/esm/index.js"() {
    init_dist();
    init_definitions3();
    App = registerPlugin("App", {
      web: () => Promise.resolve().then(() => (init_web2(), web_exports2)).then((m) => new m.AppWeb())
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/base.js
var BiometricAuthBase, init_base2 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/base.js"() {
    init_esm2();
    init_dist();
    init_definitions2();
    BiometricAuthBase = class extends WebPlugin {
      async authenticate(options) {
        try {
          await this.internalAuthenticate(options);
        } catch (error) {
          throw error instanceof CapacitorException && isBiometryErrorType(error.code) ? new BiometryError(error.message, error.code) : error;
        }
      }
      async addResumeListener(listener) {
        return App.addListener("appStateChange", ({ isActive }) => {
          isActive && (async () => {
            try {
              let info = await this.checkBiometry();
              listener(info);
            } catch (error) {
              console.error(error);
            }
          })();
        });
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web.js
var web_exports3 = {};
__export(web_exports3, {
  BiometricAuthWeb: () => BiometricAuthWeb
});
function isBiometryType(value) {
  return Object.values(BiometryType).includes(value);
}
function isBiometryTypes(value) {
  return value.every((type) => isBiometryType(type));
}
var BiometricAuthWeb, init_web3 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web.js"() {
    init_base2();
    init_definitions2();
    init_web_utils();
    BiometricAuthWeb = class extends BiometricAuthBase {
      constructor() {
        super(...arguments), this.biometryType = BiometryType.none, this.biometryTypes = [], this.biometryIsEnrolled = !1, this.deviceIsSecure = !1;
      }
      // On the web, return the fake biometry set by setBiometryType().
      async checkBiometry() {
        let hasBiometry = this.biometryType !== BiometryType.none, available = hasBiometry && this.biometryIsEnrolled, reason = "", code = BiometryErrorType.none;
        return hasBiometry ? this.biometryIsEnrolled || (reason = "Biometry is not enrolled", code = BiometryErrorType.biometryNotEnrolled) : (reason = "No biometry is available", code = BiometryErrorType.biometryNotAvailable), {
          isAvailable: available,
          strongBiometryIsAvailable: this.biometryIsEnrolled && this.hasStrongBiometry(),
          biometryType: this.biometryType,
          biometryTypes: this.biometryTypes,
          deviceIsSecure: this.deviceIsSecure,
          reason,
          code
        };
      }
      hasStrongBiometry() {
        return this.biometryTypes.some((type) => type === BiometryType.faceId || type === BiometryType.touchId || type === BiometryType.fingerprintAuthentication);
      }
      // On the web, fake authentication with a confirm dialog.
      async internalAuthenticate(options) {
        let result = await this.checkBiometry();
        if (!(result.isAvailable && // oxlint-disable-next-line no-alert
        confirm(
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- we want to use the default value if options?.reason is an empty string
          options?.reason || `Authenticate with ${result.biometryTypes.map((type) => getBiometryName(type)).join(" or ")}?`
        ))) {
          if (options?.allowDeviceCredential) {
            if (result.deviceIsSecure) {
              if (confirm("Authenticate with device security?"))
                return;
              throw new BiometryError("User cancelled", BiometryErrorType.userCancel);
            } else if (result.isAvailable)
              throw new BiometryError("Device is not secure", BiometryErrorType.noDeviceCredential);
          } else if (!result.isAvailable)
            throw result.biometryType === BiometryType.none ? new BiometryError("Biometry is not available", BiometryErrorType.biometryNotAvailable) : new BiometryError("Biometry is not enrolled", BiometryErrorType.biometryNotEnrolled);
          throw new BiometryError("User cancelled", BiometryErrorType.userCancel);
        }
      }
      // Web only, used for simulating biometric authentication.
      async setBiometryType(type) {
        if (type === void 0)
          return;
        let types = Array.isArray(type) ? type : [type];
        if (this.biometryTypes = [], this.biometryType = BiometryType.none, types.length !== 0)
          if (isBiometryTypes(types))
            this.biometryType = types[0], this.biometryType !== BiometryType.none && (this.biometryTypes = types);
          else
            for (let [i, theType] of types.entries())
              isBiometryType(theType) && (this.biometryType === BiometryType.none ? this.biometryTypes = [] : this.biometryTypes.push(theType), i === 0 && (this.biometryType = theType));
      }
      // Web only, used for simulating device unlock security.
      async setBiometryIsEnrolled(enrolled) {
        this.biometryIsEnrolled = enrolled;
      }
      // Web only, used for simulating device unlock security.
      async setDeviceIsSecure(isSecure) {
        this.deviceIsSecure = isSecure;
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/native.js
var native_exports2 = {};
__export(native_exports2, {
  BiometricAuthNative: () => BiometricAuthNative
});
var BiometricAuthNative, init_native2 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/native.js"() {
    init_base2();
    init_definitions2();
    BiometricAuthNative = class extends BiometricAuthBase {
      constructor(capProxy) {
        super();
        let proxy3 = capProxy;
        this.checkBiometry = proxy3.checkBiometry, this.internalAuthenticate = proxy3.internalAuthenticate;
      }
      // @native
      async checkBiometry() {
        return {
          isAvailable: !1,
          strongBiometryIsAvailable: !1,
          biometryType: BiometryType.none,
          biometryTypes: [],
          deviceIsSecure: !1,
          reason: "",
          code: BiometryErrorType.none,
          strongReason: "",
          strongCode: BiometryErrorType.none
        };
      }
      // @native
      // On native platforms, this will present the native authentication UI.
      async internalAuthenticate(_options) {
      }
      // Web only, used for simulating biometric authentication.
      async setBiometryType(_type) {
        console.warn("setBiometryType() is web only");
      }
      // Web only, used for simulating biometry enrollment.
      async setBiometryIsEnrolled(_enrolled) {
        console.warn("setBiometryEnrolled() is web only");
      }
      // Web only, used for simulating device security.
      async setDeviceIsSecure(_isSecure) {
        console.warn("setDeviceIsSecure() is web only");
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/index.js
var proxy2, init_esm3 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/index.js"() {
    init_dist();
    init_definitions2();
    init_web_utils();
    proxy2 = registerPlugin("BiometricAuthNative", {
      web: async () => {
        let module = await Promise.resolve().then(() => (init_web3(), web_exports3));
        return new module.BiometricAuthWeb();
      },
      ios: async () => {
        let module = await Promise.resolve().then(() => (init_native2(), native_exports2));
        return new module.BiometricAuthNative(proxy2);
      },
      android: async () => {
        let module = await Promise.resolve().then(() => (init_native2(), native_exports2));
        return new module.BiometricAuthNative(proxy2);
      }
    });
  }
});

// mobile/plugins/dictation/src/core.js
var DICTATION_EVENTS, END_REASONS, ERROR_CODES, init_core2 = __esm({
  "mobile/plugins/dictation/src/core.js"() {
    DICTATION_EVENTS = Object.freeze(["partial", "final", "level", "end", "error"]), END_REASONS = Object.freeze(["done", "silence", "no-speech", "cancelled", "error"]), ERROR_CODES = Object.freeze([
      "permission-denied",
      "on-device-unavailable",
      "locale-unavailable",
      "busy",
      "network",
      "no-speech",
      "unknown"
    ]);
  }
});

// mobile/plugins/dictation/src/web.js
var web_exports4 = {};
__export(web_exports4, {
  DictationWeb: () => DictationWeb
});
var NOT_ON_WEB, DictationWeb, init_web4 = __esm({
  "mobile/plugins/dictation/src/web.js"() {
    init_dist();
    NOT_ON_WEB = "Dictation is in the Android and iPhone apps. The browser keyboard has its own dictation key.", DictationWeb = class extends WebPlugin {
      async available() {
        return { available: !1, onDevice: !1, serverAvailable: !1, permission: "denied", platform: "web" };
      }
      async requestPermission() {
        throw this.unavailable(NOT_ON_WEB);
      }
      async start() {
        throw this.unavailable(NOT_ON_WEB);
      }
      async stop() {
      }
      async cancel() {
      }
    };
  }
});

// mobile/plugins/dictation/src/index.js
var Dictation, init_src = __esm({
  "mobile/plugins/dictation/src/index.js"() {
    init_dist();
    init_core2();
    Dictation = registerPlugin("Dictation", {
      web: () => Promise.resolve().then(() => (init_web4(), web_exports4)).then((module) => new module.DictationWeb())
    });
  }
});

// mobile/plugins/isolated-preview/src/core.js
var SANDBOX_POLICY, init_core3 = __esm({
  "mobile/plugins/isolated-preview/src/core.js"() {
    SANDBOX_POLICY = Object.freeze({
      javascript: "on",
      bridge: "none",
      network: "blocked",
      files: "blocked",
      content: "blocked",
      storage: "off",
      navigation: "blocked",
      popups: "blocked",
      screenshots: "blocked"
    });
  }
});

// mobile/plugins/isolated-preview/src/web.js
var web_exports5 = {};
__export(web_exports5, {
  IsolatedPreviewWeb: () => IsolatedPreviewWeb
});
var IsolatedPreviewWeb, init_web5 = __esm({
  "mobile/plugins/isolated-preview/src/web.js"() {
    init_dist();
    IsolatedPreviewWeb = class extends WebPlugin {
      async show() {
        throw this.unimplemented("The isolated preview is Android only. Artifacts are shown as pictures here.");
      }
    };
  }
});

// mobile/plugins/isolated-preview/src/index.js
var IsolatedPreview, init_src2 = __esm({
  "mobile/plugins/isolated-preview/src/index.js"() {
    init_dist();
    init_core3();
    IsolatedPreview = registerPlugin("IsolatedPreview", {
      web: () => Promise.resolve().then(() => (init_web5(), web_exports5)).then((module) => new module.IsolatedPreviewWeb())
    });
  }
});

// mobile/plugins/unifiedpush/src/web.js
var web_exports6 = {};
__export(web_exports6, {
  UnifiedPushWeb: () => UnifiedPushWeb
});
var NOT_ON_WEB2, UnifiedPushWeb, init_web6 = __esm({
  "mobile/plugins/unifiedpush/src/web.js"() {
    init_dist();
    NOT_ON_WEB2 = "UnifiedPush is only in the Android app. The browser uses Web Push.", UnifiedPushWeb = class extends WebPlugin {
      async getState() {
        return { supported: !1, distributor: null, endpoints: {}, failures: {}, registrations: [], visible: !1 };
      }
      async getDistributors() {
        return { distributors: [], saved: null };
      }
      async chooseDistributor() {
        throw this.unavailable(NOT_ON_WEB2);
      }
      async pickDistributor() {
        throw this.unavailable(NOT_ON_WEB2);
      }
      async register() {
        throw this.unavailable(NOT_ON_WEB2);
      }
      async unregister() {
        throw this.unavailable(NOT_ON_WEB2);
      }
      async requestNotificationPermission() {
        return { granted: !1 };
      }
      async getNotificationPermission() {
        return { granted: !1 };
      }
    };
  }
});

// mobile/plugins/unifiedpush/src/index.js
var UnifiedPush, init_src3 = __esm({
  "mobile/plugins/unifiedpush/src/index.js"() {
    init_dist();
    init_core();
    UnifiedPush = registerPlugin("UnifiedPush", {
      web: () => Promise.resolve().then(() => (init_web6(), web_exports6)).then((module) => new module.UnifiedPushWeb())
    });
  }
});

// mobile/shell/native.js
var native_exports3 = {};
__export(native_exports3, {
  REGISTERED_NAMES: () => REGISTERED_NAMES,
  buildNative: () => buildNative,
  loadNativePlugins: () => loadNativePlugins,
  scanOutcome: () => scanOutcome,
  secureStorageAdapter: () => secureStorageAdapter
});
function secureStorageAdapter(plugin) {
  return {
    async getItem({ key }) {
      return { value: await plugin.getItem(String(key)) };
    },
    async setItem({ key, value }) {
      await plugin.setItem(String(key), String(value));
    },
    async removeItem({ key }) {
      await plugin.removeItem(String(key));
    },
    async keys() {
      return { keys: await plugin.keys() };
    }
  };
}
function scanOutcome(error, result) {
  if (!error) {
    let text = typeof result?.ScanResult == "string" ? result.ScanResult : "";
    return text ? { ok: !0, text } : { ok: !1, reason: "cancelled" };
  }
  let said = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  return /permission|denied|not authori[sz]ed|restricted/i.test(said) ? { ok: !1, reason: "denied" } : /cancel|dismiss|closed/i.test(said) ? { ok: !1, reason: "cancelled" } : { ok: !1, reason: "failed" };
}
function buildNative(parts, { platform = "" } = {}) {
  let register = parts.registerPlugin, scanner = register("CapacitorBarcodeScanner");
  return {
    ...{
      App: register("App"),
      Haptics: register("Haptics"),
      Browser: register("Browser"),
      Share: register("Share"),
      Filesystem: register("Filesystem"),
      TextZoom: register("TextZoom"),
      Network: register("Network"),
      LocalNotifications: register("LocalNotifications"),
      PlenumPrivacy: register("PlenumPrivacy")
    },
    secureStorage: secureStorageAdapter(parts.SecureStorage),
    // Settings the shell wants for the keys: never synchronised to iCloud, and on this device only. On iOS the Keychain setting must hold:
    // when it cannot be set, this throws, and app.js treats a throwing loadPlugins as no secure storage, so no key is stored.
    async configureStorage() {
      if (await Promise.resolve(parts.SecureStorage.setSynchronize?.(!1)).catch(() => {
      }), platform === "ios") {
        if (typeof parts.SecureStorage.setDefaultKeychainAccess != "function") throw new Error("keychain access cannot be set");
        await parts.SecureStorage.setDefaultKeychainAccess(1);
      }
    },
    BiometricAuth: parts.BiometricAuth,
    WebView: parts.WebView,
    UnifiedPush: parts.UnifiedPush,
    Dictation: parts.Dictation,
    IsolatedPreview: parts.IsolatedPreview,
    BarcodeScanner: {
      // Scans one QR code. The result is { ok, text } or { ok: false, reason }.
      async scan(options = {}) {
        try {
          let result = await scanner.scanBarcode({
            hint: QR_CODE_HINT,
            scanInstructions: " ",
            scanButton: !1,
            scanText: " ",
            cameraDirection: CAMERA_BACK,
            scanOrientation: ORIENTATION_ADAPTIVE,
            ...options
          });
          return scanOutcome(null, result);
        } catch (error) {
          return scanOutcome(error, null);
        }
      }
    },
    names: [...REGISTERED_NAMES]
  };
}
async function loadNativePlugins() {
  let native = buildNative({ registerPlugin, WebView, SecureStorage: proxy, BiometricAuth: proxy2, Dictation, IsolatedPreview, UnifiedPush }, { platform: Capacitor.getPlatform() });
  return await native.configureStorage(), native;
}
var REGISTERED_NAMES, QR_CODE_HINT, CAMERA_BACK, ORIENTATION_ADAPTIVE, init_native3 = __esm({
  "mobile/shell/native.js"() {
    init_dist();
    init_esm();
    init_esm3();
    init_src();
    init_src2();
    init_src3();
    REGISTERED_NAMES = Object.freeze([
      "App",
      "Haptics",
      "Browser",
      "Share",
      "Filesystem",
      "TextZoom",
      "Network",
      "LocalNotifications",
      "CapacitorBarcodeScanner",
      "PlenumPrivacy"
    ]), QR_CODE_HINT = 0, CAMERA_BACK = 1, ORIENTATION_ADAPTIVE = 3;
  }
});

// mobile/shell/channel.js
var CHANNEL_WORKER_NAME = "plenum-channel", utf8 = new TextEncoder();
function b64uToBytes(text) {
  let s = String(text).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(s + "=".repeat((4 - s.length % 4) % 4)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = "";
  for (let b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function defaultCreateWorker() {
  return new Worker(new URL("./channel.worker.js", import.meta.url), { type: "module", name: CHANNEL_WORKER_NAME });
}
function workerComputer(record, carriers = null) {
  return {
    id: record.id,
    name: record.name ?? "",
    desktopPub: b64uToBytes(record.desktopPub),
    myPriv: b64uToBytes(typeof record.myPriv == "string" ? record.myPriv : fail("locked")),
    carriers: carriers ?? record.carriers ?? [],
    lastCarrier: record.lastCarrier ?? null,
    counter: Number.isSafeInteger(record.counter) ? record.counter : 0
  };
}
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}
async function answerCounter(store, msg, reply) {
  try {
    let counter = store ? await store.raiseCounter(msg.id, msg.minimum) : msg.minimum;
    reply({ op: "counterSaved", rid: msg.rid, ok: !0, counter });
  } catch {
    reply({ op: "counterSaved", rid: msg.rid, ok: !1 });
  }
}
function sendLockedStop({ record, store = null, createWorker = defaultCreateWorker, onStopState = () => {
} } = {}) {
  let validKey = typeof record?.stopKey == "string" && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey), validId = /^[0-9a-f]{64}$/.test(String(record?.myDeviceId ?? ""));
  if (!record || typeof record.id != "string" || !validKey || !validId) return Promise.reject(coded("no-key"));
  let worker = createWorker(), sid = 1, settled = !1;
  return new Promise((resolve, reject) => {
    let end = (fn, value) => {
      settled || (settled = !0, setTimeout(() => {
        try {
          worker.terminate();
        } catch {
        }
      }, 0), fn(value));
    };
    worker.onmessage = (event) => {
      let msg = event?.data;
      if (!(!msg || typeof msg != "object"))
        if (msg.op === "counter")
          answerCounter(store, msg, (reply) => worker.postMessage(reply));
        else if (msg.op === "stopState") {
          if (msg.sid === sid && !settled)
            try {
              onStopState({ sid, state: msg.state });
            } catch {
            }
        } else msg.op === "stopAck" && msg.sid === sid && (msg.error ? end(reject, coded(msg.error, msg.error)) : end(resolve, msg.ack));
    }, worker.onerror = () => end(reject, coded("unreachable")), worker.postMessage({
      op: "stopLocked",
      sid,
      computer: {
        id: record.id,
        deviceId: record.myDeviceId,
        stopKey: b64uToBytes(record.stopKey),
        carriers: Array.isArray(record.carriers) ? record.carriers : [],
        lastCarrier: record.lastCarrier ?? null,
        counter: Number.isSafeInteger(record.counter) ? record.counter : 0
      }
    });
  });
}
function openChannel({
  computer,
  carriers = null,
  store = null,
  device = {},
  caps = null,
  createWorker = defaultCreateWorker,
  onWorkerError = () => {
  }
} = {}) {
  if (!computer || typeof computer.id != "string") throw new TypeError("openChannel needs a computer record");
  let worker = createWorker(), seq = 0, closed = !1, state = { status: "connecting", carrier: null, desktopName: "", lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null, computerId: computer.id, stopsPending: 0 }, hello = null, reqs = /* @__PURE__ */ new Map(), stops = /* @__PURE__ */ new Map(), stateSubs = /* @__PURE__ */ new Set(), eventSubs = /* @__PURE__ */ new Set(), stopSubs = /* @__PURE__ */ new Set(), helloSubs = /* @__PURE__ */ new Set(), post = (msg, transfer = []) => worker.postMessage(msg, transfer), notify = (set, value) => {
    for (let fn of Array.from(set))
      try {
        fn(value);
      } catch {
      }
  }, endRequest = (msg) => {
    let entry = reqs.get(msg.sid);
    if (!entry) return;
    reqs.delete(msg.sid), entry.detach?.();
    let controller = entry.controller;
    if (msg.error || msg.cancelled) {
      let code = msg.cancelled ? "cancelled" : msg.error, err = coded(code, code);
      entry.head || entry.reject(err);
      try {
        controller?.error(err);
      } catch {
      }
    } else
      try {
        controller?.close();
      } catch {
      }
  };
  worker.onmessage = (event) => {
    let msg = event?.data;
    if (!(!msg || typeof msg != "object"))
      switch (msg.op) {
        case "state":
          state = msg.state, notify(stateSubs, state), state.status === "closed" && setTimeout(() => {
            try {
              worker.terminate();
            } catch {
            }
          }, 0);
          return;
        case "hello":
          hello = msg.hello, notify(helloSubs, hello);
          return;
        case "event":
          notify(eventSubs, msg.event);
          return;
        case "res": {
          let entry = reqs.get(msg.sid);
          if (!entry || entry.head) return;
          entry.head = !0, entry.resolve({ status: msg.status, headers: msg.headers ?? {}, body: entry.stream, id: msg.sid, cancel: () => cancel(msg.sid) });
          return;
        }
        case "data": {
          let entry = reqs.get(msg.sid);
          if (!entry || !entry.controller) return;
          try {
            entry.controller.enqueue(new Uint8Array(msg.bytes));
          } catch {
          }
          return;
        }
        case "end":
          endRequest(msg);
          return;
        case "stopState":
          notify(stopSubs, { sid: msg.sid, state: msg.state });
          return;
        case "stopAck": {
          let waiter = stops.get(msg.sid);
          if (!waiter) return;
          stops.delete(msg.sid), msg.error ? waiter.reject(coded(msg.error, msg.error)) : waiter.resolve(msg.ack);
          return;
        }
        case "counter":
          answerCounter(store, msg, (reply) => post(reply));
          return;
        case "patch":
          store && store.patchComputer(msg.id, msg.patch).catch(() => {
          });
          return;
        case "log":
          onWorkerError(String(msg.line ?? ""));
          return;
        default:
          return;
      }
  }, worker.onerror = (event) => {
    onWorkerError(String(event?.message ?? "worker error")), closed = !0;
    for (let [sid, waiter] of Array.from(stops))
      stops.delete(sid), waiter.reject(coded("unreachable"));
    for (let sid of Array.from(reqs.keys())) endRequest({ sid, error: "lost" });
    try {
      worker.terminate();
    } catch {
    }
  };
  let request = ({ method = "GET", path = "/", headers = {} } = {}, body = null, { signal = null, scope = "page" } = {}) => {
    if (closed) return Promise.reject(coded("closed"));
    if (signal?.aborted) return Promise.reject(coded("cancelled"));
    let sid = ++seq, controller = null, stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        cancel(sid);
      }
    });
    return new Promise((resolve, reject) => {
      let entry = { sid, head: !1, resolve, reject, stream, controller: null, detach: null };
      if (reqs.set(sid, entry), entry.controller = controller, signal) {
        let onAbort = () => {
          if (reqs.get(sid) !== entry) return;
          reqs.delete(sid), post({ op: "cancel", sid });
          let err = coded("cancelled");
          entry.head || entry.reject(err);
          try {
            controller?.error(err);
          } catch {
          }
        };
        signal.addEventListener("abort", onAbort, { once: !0 }), entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      let bytes = null;
      body != null && (typeof body == "string" ? bytes = utf8.encode(body) : body instanceof Uint8Array ? bytes = body.slice() : bytes = new Uint8Array(body)), post({ op: "request", sid, method, path, headers, scope: scope === "shell" ? "shell" : "page", body: bytes }, bytes ? [bytes.buffer] : []);
    });
  }, cancel = (sid) => closed ? !1 : (post({ op: "cancel", sid }), !0), stop = (project = null) => {
    if (closed) return Promise.reject(coded("closed"));
    let sid = ++seq;
    return new Promise((resolve, reject) => {
      stops.set(sid, { resolve, reject }), post({ op: "stop", sid, project: project ?? null });
    });
  }, api = {
    id: computer.id,
    request,
    cancel,
    stop,
    onState(fn) {
      stateSubs.add(fn);
      try {
        fn(state);
      } catch {
      }
      return () => stateSubs.delete(fn);
    },
    onEvent(fn) {
      return eventSubs.add(fn), () => eventSubs.delete(fn);
    },
    onStopState(fn) {
      return stopSubs.add(fn), () => stopSubs.delete(fn);
    },
    // fn(hello) each time the computer answers a session with HELLO (after every reconnect too).
    onHello(fn) {
      if (helloSubs.add(fn), hello)
        try {
          fn(hello);
        } catch {
        }
      return () => helloSubs.delete(fn);
    },
    get hello() {
      return hello;
    },
    get state() {
      return state;
    },
    reconnect() {
      closed || post({ op: "reconnect" });
    },
    close() {
      closed || (closed = !0, post({ op: "close" }), setTimeout(() => {
        try {
          worker.terminate();
        } catch {
        }
      }, 2e3));
    }
  };
  return post({
    op: "init",
    computer: workerComputer(computer, carriers),
    device,
    caps: caps ?? void 0,
    hasStopKey: !!(computer.stopKey && computer.myDeviceId)
  }), api;
}

// mobile/shell/store.js
var STORE_DB = "plenum-shell";
var SECURE_PREFIX = "plenum.";
function createIdbKv({ indexedDB: factory, name = STORE_DB } = {}) {
  if (!factory || typeof factory.open != "function") throw new TypeError("createIdbKv needs an IndexedDB factory");
  let opening = null, database = () => (opening || (opening = new Promise((resolve, reject) => {
    let req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      let db = req.result;
      db.objectStoreNames.contains("kv") || db.createObjectStore("kv");
    }, req.onsuccess = () => resolve(req.result), req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed")), req.onblocked = () => reject(new Error("IndexedDB blocked"));
  }), opening.catch(() => {
    opening = null;
  })), opening), run = async (mode, fn) => {
    let db = await database();
    return new Promise((resolve, reject) => {
      let tx = db.transaction("kv", mode, mode === "readwrite" ? { durability: "strict" } : void 0), os = tx.objectStore("kv"), result, req = fn(os);
      req && (req.onsuccess = () => {
        result = req.result;
      }), tx.oncomplete = () => resolve(result), tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed")), tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    kind: "web",
    get: async (key) => {
      let value = await run("readonly", (os) => os.get(key));
      return value === void 0 ? void 0 : value;
    },
    put: (key, value) => run("readwrite", (os) => os.put(value, key)).then(() => {
    }),
    delete: (key) => run("readwrite", (os) => os.delete(key)).then(() => {
    }),
    keys: async () => {
      let list = await run("readonly", (os) => os.getAllKeys());
      return Array.from(list ?? []).map(String);
    }
  };
}
function createSecureKv({ plugin, prefix = SECURE_PREFIX } = {}) {
  if (!plugin || typeof plugin.setItem != "function") throw new TypeError("createSecureKv needs the SecureStorage plugin");
  return {
    kind: "native",
    get: async (key) => {
      let text = (await plugin.getItem({ key: prefix + key }))?.value;
      return text == null ? void 0 : JSON.parse(String(text));
    },
    put: async (key, value) => {
      await plugin.setItem({ key: prefix + key, value: JSON.stringify(value) });
    },
    delete: async (key) => {
      await plugin.removeItem({ key: prefix + key });
    },
    keys: async () => ((await plugin.keys())?.keys ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  };
}
var isObject = (v) => v !== null && typeof v == "object" && !Array.isArray(v);
function publicComputer(record) {
  return isObject(record) ? {
    id: record.id,
    name: record.name ?? "",
    carriers: Array.isArray(record.carriers) ? record.carriers.map((c) => ({ kind: c.kind })) : [],
    lastCarrier: record.lastCarrier ?? null,
    lastSeen: record.lastSeen ?? null,
    pairedAt: record.pairedAt ?? null,
    counter: Number.isSafeInteger(record.counter) ? record.counter : 0,
    // Whether this phone holds the computer's Stop key and its own id there (C5): Stop can then be sent without unlocking.
    stopReady: typeof record.stopKey == "string" && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey) && /^[0-9a-f]{64}$/.test(String(record.myDeviceId ?? ""))
  } : null;
}
function createStore({ kv } = {}) {
  if (!kv || typeof kv.get != "function") throw new TypeError("createStore needs a key-value back end");
  let chain = Promise.resolve(), serial = (fn) => {
    let run = chain.then(fn, fn);
    return chain = run.catch(() => {
    }), run;
  }, readComputers = async () => {
    let list = await kv.get("computers");
    return Array.isArray(list) ? list.filter(isObject) : [];
  }, readCounter = async (id) => {
    let value = await kv.get(`ctr:${id}`);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    kind: kv.kind,
    // Every record, keys included. Only the unlock path and the connect path may use these.
    list: () => serial(readComputers),
    get: (id) => serial(async () => (await readComputers()).find((c) => c.id === id) ?? null),
    publicList: () => serial(async () => (await readComputers()).map(publicComputer)),
    put: (record) => serial(async () => {
      if (!isObject(record) || typeof record.id != "string" || !record.id) throw new TypeError("a computer record needs an id");
      let all = await readComputers(), next = all.some((c) => c.id === record.id) ? all.map((c) => c.id === record.id ? record : c) : [...all, record];
      return await kv.put("computers", next), record;
    }),
    // Merges fields into a record. Keys in `fields` replace the record's value; a null value removes the field.
    patchComputer: (id, fields) => serial(async () => {
      let all = await readComputers(), found = all.find((c) => c.id === id);
      if (!found) return null;
      for (let [k, v] of Object.entries(fields ?? {}))
        v === null ? delete found[k] : found[k] = v;
      return await kv.put("computers", all), publicComputer(found);
    }),
    remove: (id) => serial(async () => {
      let all = await readComputers();
      return await kv.put("computers", all.filter((c) => c.id !== id)), !0;
    }),
    counter: (id) => serial(() => readCounter(id)),
    // Stores a counter of at least `minimum`, never lower than what is stored, and returns the value stored. The handshake only
    // goes out with a value this returns (channel.js answerCounter).
    raiseCounter: (id, minimum) => serial(async () => {
      let current = await readCounter(id), next = Math.max(current, Number(minimum) - 1) + 1;
      if (!Number.isSafeInteger(next)) throw new RangeError("counter out of range");
      await kv.put(`ctr:${id}`, next);
      let all = await readComputers(), found = all.find((c) => c.id === id);
      return found && (found.counter = next, await kv.put("computers", all)), next;
    }),
    meta: {
      get: (name) => serial(() => kv.get(`meta:${name}`)),
      put: (name, value) => serial(() => kv.put(`meta:${name}`, value)),
      remove: (name) => serial(() => kv.delete(`meta:${name}`))
    },
    // Used by the Node suites and the debug console: what the store holds under which keys (names only).
    keys: () => serial(() => kv.keys())
  };
}
function createPlatformStore({ secureStorage = null, indexedDB = null } = {}) {
  if (secureStorage) return createStore({ kv: createSecureKv({ plugin: secureStorage }) });
  if (indexedDB) return createStore({ kv: createIdbKv({ indexedDB }) });
  throw new Error("no storage: neither secure storage nor IndexedDB is available");
}

// mobile/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n != "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  length !== void 0 && anumber(length, "length");
  let bytes = isBytes(value), ofLen = length !== void 0 ? ` of length ${length}` : "", got = bytes ? `length=${value.length}` : `type=${typeof value}`, message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  throw bytes ? new RangeError(message) : new TypeError(message);
}
function ahash(h) {
  if (typeof h != "function" || typeof h.create != "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  if (anumber(h.outputLen), anumber(h.blockLen), h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value != "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
}, aopts = (value, label) => {
  aobject(value, label);
  let proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = !0) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  let min = instance.outputLen;
  if (!(out.length >= min))
    throw new RangeError('"output" expected length >= ' + min);
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++)
    arrays[i].fill(0);
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function utf8ToBytes(str) {
  if (typeof str != "string")
    throw new TypeError("string expected");
  let encoded = new TextEncoder().encode(str);
  try {
    return new Uint8Array(encoded);
  } finally {
    clean(encoded);
  }
}
function kdfInputToBytes(data, errorTitle = "") {
  return typeof data == "string" ? utf8ToBytes(data) : abytes(data, void 0, errorTitle);
}
function checkOpts(defaults, opts, title = "opts") {
  return aopts(defaults, "defaults"), opts !== void 0 && aopts(opts, title), Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons != "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  let hashC = (msg, opts) => hashCons(opts).update(msg).digest(), tmp = hashCons(void 0);
  return hashC.outputLen = tmp.outputLen, hashC.blockLen = tmp.blockLen, hashC.canXOF = tmp.canXOF, hashC.create = (opts) => hashCons(opts), Object.assign(hashC, info), Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  let cr = typeof globalThis == "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues != "function")
    throw new Error("crypto.getRandomValues must be defined");
  if (bytesLength > 65536)
    throw new RangeError(`"bytesLength" expected <= 65536, got ${bytesLength}`);
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// mobile/node_modules/@noble/hashes/hmac.js
var _HMAC = class {
  constructor(hash, key) {
    __publicField(this, "oHash");
    __publicField(this, "iHash");
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", !1);
    __publicField(this, "finished", !1);
    __publicField(this, "destroyed", !1);
    if (ahash(hash), abytes(key, void 0, "key"), this.iHash = hash.create(), typeof this.iHash.update != "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
    let blockLen = this.blockLen, pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad), this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 106;
    this.oHash.update(pad), clean(pad);
  }
  update(buf) {
    return aexists(this), this.iHash.update(buf), this;
  }
  digestInto(out) {
    aexists(this), aoutput(out, this), this.finished = !0;
    let buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf), this.oHash.update(buf), this.oHash.digestInto(buf), this.destroy();
  }
  digest() {
    let out = new Uint8Array(this.oHash.outputLen);
    return this.digestInto(out), out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    let { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    return to = to, to.finished = finished, to.destroyed = destroyed, to.blockLen = blockLen, to.outputLen = outputLen, to.canXOF = canXOF, to.oHash = oHash._cloneInto(to.oHash), to.iHash = iHash._cloneInto(to.iHash), to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
  }
}, hmac = /* @__PURE__ */ (() => {
  let hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  return hmac_.create = (hash, key) => new _HMAC(hash, key), hmac_;
})();

// mobile/node_modules/@noble/hashes/pbkdf2.js
function pbkdf2Init(hash, _password, _salt, _opts) {
  ahash(hash);
  let opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts), { c, dkLen, asyncTick } = opts;
  if (anumber(c, "c"), anumber(dkLen, "dkLen"), anumber(asyncTick, "asyncTick"), c < 1)
    throw new Error('"c" (iterations) must be >= 1');
  if (dkLen < 1)
    throw new Error('"dkLen" must be >= 1');
  if (dkLen > (2 ** 32 - 1) * hash.outputLen)
    throw new Error("derived key too long");
  let p = kdfInputToBytes(_password, "password");
  try {
    let s = kdfInputToBytes(_salt, "salt");
    try {
      let DK = new Uint8Array(dkLen), { iHash, oHash, outputLen } = hmac.create(hash, p), u = new Uint8Array(outputLen), eng = pbkdf2Engine(iHash, oHash, s, u);
      return { c, dkLen, asyncTick, DK, outputLen, eng };
    } finally {
      typeof _salt == "string" && clean(s);
    }
  } finally {
    typeof _password == "string" && clean(p);
  }
}
function pbkdf2Engine(iHash, oHash, salt, u) {
  let counter = new Uint8Array(4), view = createView(counter), salted = iHash._cloneInto().update(salt), work = oHash._cloneInto(), iClone = iHash._cloneInto, oClone = oHash._cloneInto;
  return {
    u1: (ti, Ti) => {
      view.setInt32(0, ti, !1), salted._cloneInto(work).update(counter).digestInto(u), oHash._cloneInto(work).update(u).digestInto(u), Ti.set(u.subarray(0, Ti.length));
    },
    // Whole `F` inner loop for the sync variant: one optimized function owns the hot loop.
    rounds: (c, Ti) => {
      for (let ui = 1; ui < c; ui++) {
        iClone.call(iHash, work).update(u).digestInto(u), oClone.call(oHash, work).update(u).digestInto(u);
        for (let i = 0; i < Ti.length; i++)
          Ti[i] ^= u[i];
      }
    },
    output: (DK) => (iHash.destroy(), oHash.destroy(), salted.destroy(), work.destroy(), clean(u), DK)
  };
}
function pbkdf2(hash, password, salt, opts) {
  let { c, dkLen, DK, outputLen, eng } = pbkdf2Init(hash, password, salt, opts);
  for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += outputLen) {
    let Ti = DK.subarray(pos, pos + outputLen);
    eng.u1(ti, Ti), eng.rounds(c, Ti);
  }
  return eng.output(DK);
}

// mobile/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0, fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE2) {
  let h = fromNumH(n), l = fromNumL(n);
  view.setUint32(byteOffset, isLE2 ? l : h, isLE2), view.setUint32(byteOffset + 4, isLE2 ? h : l, isLE2);
}

// mobile/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    __publicField(this, "blockLen");
    __publicField(this, "outputLen");
    __publicField(this, "canXOF", !1);
    __publicField(this, "padOffset");
    __publicField(this, "isLE");
    // For partial updates less than block size
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "finished", !1);
    __publicField(this, "length", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "destroyed", !1);
    this.blockLen = blockLen, this.outputLen = outputLen, this.padOffset = padOffset, this.isLE = isLE2, this.buffer = new Uint8Array(blockLen), this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this), abytes(data);
    let { view, buffer, blockLen } = this, len = data.length, processed = !1;
    for (let pos = 0; pos < len; ) {
      let take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        let dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = !0;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos), this.pos += take, pos += take, this.pos === blockLen && (this.process(view, 0), this.pos = 0, processed = !0);
    }
    return this.length += data.length, processed && this.roundClean(), this;
  }
  digestInto(out) {
    aexists(this), aoutput(out, this), this.finished = !0;
    let { buffer, view, blockLen, isLE: isLE2 } = this, { pos } = this;
    buffer[pos++] = 128, buffer.fill(0, pos), this.padOffset > blockLen - pos && (this.process(view, 0), buffer.fill(0)), setU64FromNum(view, blockLen - 8, this.length * 8, isLE2), this.process(view, 0), this.roundClean();
    let oview = out === buffer ? view : createView(out), len = this.outputLen, outLen = len / 4, state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    let { buffer, outputLen } = this;
    this.digestInto(buffer);
    let res = buffer.slice(0, outputLen);
    return this.destroy(), res;
  }
  _cloneIntoMeta(to) {
    let { buffer, length, finished, destroyed, pos } = this;
    return to.destroyed = destroyed, to.finished = finished, to.length = length, to.pos = pos, pos && to.buffer.set(buffer), to;
  }
  clone() {
    return this._cloneInto();
  }
}, SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// mobile/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), SHA256_W = /* @__PURE__ */ new Uint32Array(64), SHA2_32B = class extends HashMD {
  constructor(outputLen, IV) {
    super(64, outputLen, 8, !1);
    // We cannot use array here since array allows indexing by variable
    // which means optimizer/compiler cannot use registers.
    // Numeric initializers matter: starting the fields as `undefined` changes
    // V8's field representation and makes sha256 3x slower (measured).
    __publicField(this, "A", 0);
    __publicField(this, "B", 0);
    __publicField(this, "C", 0);
    __publicField(this, "D", 0);
    __publicField(this, "E", 0);
    __publicField(this, "F", 0);
    __publicField(this, "G", 0);
    __publicField(this, "H", 0);
    this.A = IV[0] | 0, this.B = IV[1] | 0, this.C = IV[2] | 0, this.D = IV[3] | 0, this.E = IV[4] | 0, this.F = IV[5] | 0, this.G = IV[6] | 0, this.H = IV[7] | 0;
  }
  get() {
    let { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0, this.B = B | 0, this.C = C | 0, this.D = D | 0, this.E = E | 0, this.F = F | 0, this.G = G | 0, this.H = H | 0;
  }
  _cloneInto(to) {
    return (to ||= new this.constructor()).set(...this.get()), this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, !1);
    for (let i = 16; i < 64; i++) {
      let W15 = SHA256_W[i - 15], W2 = SHA256_W[i - 2], s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3, s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      let sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25), T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0, T2 = (rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + Maj(A, B, C) | 0;
      H = G, G = F, F = E, E = D + T1 | 0, D = C, C = B, B = A, A = T1 + T2 | 0;
    }
    A = A + this.A | 0, B = B + this.B | 0, C = C + this.C | 0, D = D + this.D | 0, E = E + this.E | 0, F = F + this.F | 0, G = G + this.G | 0, H = H + this.H | 0, this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = !0, this.set(0, 0, 0, 0, 0, 0, 0, 0), clean(this.buffer);
  }
}, _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// mobile/node_modules/@noble/ciphers/utils.js
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle2 = (title) => title ? `"${title}" ` : "";
function abool(value, title = "") {
  if (typeof value != "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function anumber2(n, title = "") {
  if (typeof n != "number")
    throw new TypeError(atitle2(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle2(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes2(value, length, title = "") {
  if (isBytes2(value) && (length === void 0 || value.length === length))
    return value;
  length !== void 0 && anumber2(length, "length");
  let bytes = isBytes2(value), ofLen = length !== void 0 ? ` of length ${length}` : "", got = bytes ? `length=${value.length}` : `type=${typeof value}`, message = atitle2(title) + "expected Uint8Array" + ofLen + ", got " + got;
  throw bytes ? new RangeError(message) : new TypeError(message);
}
function aexists2(instance, checkFinished = !0) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput2(out, instance) {
  abytes2(out, void 0, "output");
  let min = instance.outputLen;
  if (!(out.length >= min))
    throw new RangeError('"output" expected length >= ' + min);
}
function aoutput32(out, instance) {
  if (aoutput2(out, instance), !isAligned32(out))
    throw new Error("invalid output, must be aligned");
}
function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++)
    arrays[i].fill(0);
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n) >>> 0;
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++)
    arr[i] = byteSwap(arr[i]);
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function equalBytes(a, b) {
  if (a = abytes2(a), b = abytes2(b), a.length !== b.length)
    return !1;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function wrapMacConstructor(keyLen, macCons, fromMsg) {
  let mac = macCons, getArgs = fromMsg || (() => []), macC = (msg, key) => mac(key, ...getArgs(msg)).update(msg).digest(), tmp = mac(new Uint8Array(keyLen), ...getArgs(new Uint8Array(0)));
  return macC.outputLen = tmp.outputLen, macC.blockLen = tmp.blockLen, macC.create = (key, ...args) => mac(key, ...args), macC;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    if (abytes2(key, void 0, "key"), params.nonceLength !== void 0) {
      let nonce = args[0];
      abytes2(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
    }
    let tagl = params.tagLength, aadStart = params.nonceLength !== void 0 ? 1 : 0;
    if (!params.withAAD) {
      for (let i = aadStart; i < args.length; i++)
        if (isBytes2(args[i]))
          throw new Error("AAD not supported");
    }
    params.withAAD && args[aadStart] !== void 0 && abytes2(args[aadStart], void 0, "AAD");
    let cipher = constructor(key, ...args), checkOutput = (fnLength, output) => {
      if (output !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes2(output, void 0, "output");
      }
    }, called = !1;
    return {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        return called = !0, abytes2(data, void 0, "data"), checkOutput(cipher.encrypt.length, output), cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        if (abytes2(data, void 0, "data"), tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length >= tagLength=' + tagl);
        return checkOutput(cipher.decrypt.length, output), cipher.decrypt(data, output);
      }
    };
  }
  return Object.assign(wrappedCipher, params), wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = !0) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  if (abytes2(out, expectedLength, "output"), onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  anumber2(dataLength), anumber2(aadLength), abool(isLE2);
  let num = new Uint8Array(16), view = createView2(num);
  return view.setBigUint64(0, BigInt(aadLength), isLE2), view.setBigUint64(8, BigInt(dataLength), isLE2), num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}

// mobile/node_modules/@noble/ciphers/_polyval.js
var BLOCK_SIZE = 16, ZEROS16 = /* @__PURE__ */ new Uint8Array(16), ZEROS32 = /* @__PURE__ */ u32(ZEROS16), POLY = 225, mul2 = (s0, s1, s2, s3) => {
  let hiBit = s3 & 1;
  return {
    s3: s2 << 31 | s3 >>> 1,
    s2: s1 << 31 | s2 >>> 1,
    s1: s0 << 31 | s1 >>> 1,
    // NIST SP 800-38D §6.3 applies `V >> 1` and XORs R on carry. In this
    // 4x32-bit split, R = 0xe1 || 0^120 lives in the top byte of s0.
    s0: s0 >>> 1 ^ POLY << 24 & -(hiBit & 1)
    // reduce % poly
  };
}, swapLE = (n) => (n >>> 0 & 255) << 24 | (n >>> 8 & 255) << 16 | (n >>> 16 & 255) << 8 | n >>> 24 & 255 | 0;
var estimateWindow = (bytes) => bytes > 64 * 1024 ? 8 : bytes > 1024 ? 4 : 2, GHASH = class {
  // We select bits per window adaptively based on expectedLength
  constructor(key, expectedLength) {
    __publicField(this, "blockLen", BLOCK_SIZE);
    __publicField(this, "outputLen", BLOCK_SIZE);
    __publicField(this, "s0", 0);
    __publicField(this, "s1", 0);
    __publicField(this, "s2", 0);
    __publicField(this, "s3", 0);
    __publicField(this, "finished", !1);
    __publicField(this, "destroyed", !1);
    __publicField(this, "t");
    __publicField(this, "W");
    __publicField(this, "windowSize");
    abytes2(key, 16, "key"), key = copyBytes(key);
    let kView = createView2(key), k0 = kView.getUint32(0, !1), k1 = kView.getUint32(4, !1), k2 = kView.getUint32(8, !1), k3 = kView.getUint32(12, !1), doubles = [];
    for (let i = 0; i < 128; i++)
      doubles.push({ s0: swapLE(k0), s1: swapLE(k1), s2: swapLE(k2), s3: swapLE(k3) }), { s0: k0, s1: k1, s2: k2, s3: k3 } = mul2(k0, k1, k2, k3);
    let W = estimateWindow(expectedLength || 1024);
    if (![1, 2, 4, 8].includes(W))
      throw new Error("ghash: invalid window size, expected 2, 4 or 8");
    this.W = W;
    let windows = 128 / W, windowSize = this.windowSize = 2 ** W, items = [];
    for (let w = 0; w < windows; w++)
      for (let byte = 0; byte < windowSize; byte++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let j = 0; j < W; j++) {
          if (!(byte >>> W - j - 1 & 1))
            continue;
          let { s0: d0, s1: d1, s2: d2, s3: d3 } = doubles[W * w + j];
          s0 ^= d0, s1 ^= d1, s2 ^= d2, s3 ^= d3;
        }
        items.push({ s0, s1, s2, s3 });
      }
    this.t = items;
  }
  _updateBlock(s0, s1, s2, s3) {
    s0 ^= this.s0, s1 ^= this.s1, s2 ^= this.s2, s3 ^= this.s3;
    let { W, t, windowSize } = this, o0 = 0, o1 = 0, o2 = 0, o3 = 0, mask = (1 << W) - 1, w = 0;
    for (let num of [s0, s1, s2, s3])
      for (let bytePos = 0; bytePos < 4; bytePos++) {
        let byte = num >>> 8 * bytePos & 255;
        for (let bitPos = 8 / W - 1; bitPos >= 0; bitPos--) {
          let bit = byte >>> W * bitPos & mask, { s0: e0, s1: e1, s2: e2, s3: e3 } = t[w * windowSize + bit];
          o0 ^= e0, o1 ^= e1, o2 ^= e2, o3 ^= e3, w += 1;
        }
      }
    this.s0 = o0, this.s1 = o1, this.s2 = o2, this.s3 = o3;
  }
  update(data) {
    aexists2(this), abytes2(data), data = copyBytes(data);
    let b32 = u32(data), blocks = Math.floor(data.length / BLOCK_SIZE), left = data.length % BLOCK_SIZE;
    for (let i = 0; i < blocks; i++)
      this._updateBlock(swap8IfBE(b32[i * 4 + 0]), swap8IfBE(b32[i * 4 + 1]), swap8IfBE(b32[i * 4 + 2]), swap8IfBE(b32[i * 4 + 3]));
    return left && (ZEROS16.set(data.subarray(blocks * BLOCK_SIZE)), this._updateBlock(swap8IfBE(ZEROS32[0]), swap8IfBE(ZEROS32[1]), swap8IfBE(ZEROS32[2]), swap8IfBE(ZEROS32[3])), clean2(ZEROS32)), this;
  }
  destroy() {
    this.destroyed = !0;
    let { t } = this;
    for (let elm of t)
      elm.s0 = 0, elm.s1 = 0, elm.s2 = 0, elm.s3 = 0;
  }
  digestInto(out) {
    aexists2(this), aoutput32(out, this), this.finished = !0;
    let { s0, s1, s2, s3 } = this, o32 = u32(out);
    o32[0] = s0, o32[1] = s1, o32[2] = s2, o32[3] = s3, isLE || swap32IfBE(o32.subarray(0, BLOCK_SIZE / 4));
  }
  digest() {
    let res = new Uint8Array(BLOCK_SIZE);
    return this.digestInto(res), this.destroy(), res;
  }
};
var ghash = /* @__PURE__ */ wrapMacConstructor(16, (key, expectedLength) => new GHASH(key, expectedLength), (msg) => [msg.length]);

// mobile/node_modules/@noble/ciphers/aes.js
var BLOCK_SIZE2 = 16, BLOCK_SIZE32 = 4, EMPTY_BLOCK = /* @__PURE__ */ new Uint8Array(BLOCK_SIZE2);
var POLY2 = 283;
function validateKeyLength(key) {
  if (![16, 24, 32].includes(key.length))
    throw new Error('"aes key" expected Uint8Array of length 16/24/32, got length=' + key.length);
}
function mul22(n) {
  return n << 1 ^ POLY2 & -(n >> 7);
}
function mul(a, b) {
  let res = 0;
  for (; b > 0; b >>= 1)
    res ^= a & -(b & 1), a = mul22(a);
  return res;
}
var sbox = /* @__PURE__ */ (() => {
  let t = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++, x ^= mul22(x))
    t[i] = x;
  let box = new Uint8Array(256);
  box[0] = 99;
  for (let i = 0; i < 255; i++) {
    let x = t[255 - i];
    x |= x << 8, box[t[i]] = (x ^ x >> 4 ^ x >> 5 ^ x >> 6 ^ x >> 7 ^ 99) & 255;
  }
  return clean2(t), box;
})();
var rotr32_8 = (n) => n << 24 | n >>> 8, rotl32_8 = (n) => n << 8 | n >>> 24;
function genTtable(sbox2, fn) {
  if (sbox2.length !== 256)
    throw new Error("wrong sbox length");
  let T0 = new Uint32Array(256).map((_, j) => fn(sbox2[j])), T1 = T0.map(rotl32_8), T2 = T1.map(rotl32_8), T3 = T2.map(rotl32_8), T01 = new Uint32Array(256 * 256), T23 = new Uint32Array(256 * 256), sbox22 = new Uint16Array(256 * 256);
  for (let i = 0; i < 256; i++)
    for (let j = 0; j < 256; j++) {
      let idx = i * 256 + j;
      T01[idx] = T0[i] ^ T1[j], T23[idx] = T2[i] ^ T3[j], sbox22[idx] = sbox2[i] << 8 | sbox2[j];
    }
  return { sbox: sbox2, sbox2: sbox22, T0, T1, T2, T3, T01, T23 };
}
var tableEncoding = /* @__PURE__ */ genTtable(sbox, (s) => mul(s, 3) << 24 | s << 16 | s << 8 | mul(s, 2));
var xPowers = /* @__PURE__ */ (() => {
  let p = new Uint8Array(16);
  for (let i = 0, x = 1; i < 16; i++, x = mul22(x))
    p[i] = x;
  return p;
})();
function expandKeyLE(key) {
  abytes2(key);
  let len = key.length;
  validateKeyLength(key);
  let { sbox2 } = tableEncoding, toClean = [];
  (!isLE || !isAligned32(key)) && toClean.push(key = copyBytes(key));
  let k32 = swap32IfBE(u32(key)), Nk = k32.length, subByte = (n) => applySbox(sbox2, n, n, n, n), xk = new Uint32Array(len + 28);
  xk.set(k32);
  for (let i = Nk; i < xk.length; i++) {
    let t = xk[i - 1];
    i % Nk === 0 ? t = subByte(rotr32_8(t)) ^ xPowers[i / Nk - 1] : Nk > 6 && i % Nk === 4 && (t = subByte(t)), xk[i] = xk[i - Nk] ^ t;
  }
  return clean2(...toClean), xk;
}
function apply0123(T01, T23, s0, s1, s2, s3) {
  return T01[s0 << 8 & 65280 | s1 >>> 8 & 255] ^ T23[s2 >>> 8 & 65280 | s3 >>> 24 & 255];
}
function applySbox(sbox2, s0, s1, s2, s3) {
  return sbox2[s0 & 255 | s1 & 65280] | sbox2[s2 >>> 16 & 255 | s3 >>> 16 & 65280] << 16;
}
function encrypt(xk, s0, s1, s2, s3) {
  let { sbox2, T01, T23 } = tableEncoding, k = 0;
  s0 ^= xk[k++], s1 ^= xk[k++], s2 ^= xk[k++], s3 ^= xk[k++];
  let rounds = xk.length / 4 - 2;
  for (let i = 0; i < rounds; i++) {
    let t02 = xk[k++] ^ apply0123(T01, T23, s0, s1, s2, s3), t12 = xk[k++] ^ apply0123(T01, T23, s1, s2, s3, s0), t22 = xk[k++] ^ apply0123(T01, T23, s2, s3, s0, s1), t32 = xk[k++] ^ apply0123(T01, T23, s3, s0, s1, s2);
    s0 = t02, s1 = t12, s2 = t22, s3 = t32;
  }
  let t0 = xk[k++] ^ applySbox(sbox2, s0, s1, s2, s3), t1 = xk[k++] ^ applySbox(sbox2, s1, s2, s3, s0), t2 = xk[k++] ^ applySbox(sbox2, s2, s3, s0, s1), t3 = xk[k++] ^ applySbox(sbox2, s3, s0, s1, s2);
  return { s0: t0, s1: t1, s2: t2, s3: t3 };
}
function ctr32(xk, isLE2, nonce, src, dst) {
  abytes2(nonce, BLOCK_SIZE2, "nonce"), abytes2(src), dst = getOutput(src.length, dst);
  let ctr = nonce, c32 = u32(ctr), view = createView2(ctr), src32 = u32(src), dst32 = u32(dst), ctrPos = isLE2 ? 0 : 12, srcLen = src.length, ctrNum = view.getUint32(ctrPos, isLE2);
  for (let i = 0; i + 4 <= src32.length; i += 4) {
    let { s0, s1, s2, s3 } = encrypt(xk, swap8IfBE(c32[0]), swap8IfBE(c32[1]), swap8IfBE(c32[2]), swap8IfBE(c32[3]));
    dst32[i + 0] = src32[i + 0] ^ swap8IfBE(s0), dst32[i + 1] = src32[i + 1] ^ swap8IfBE(s1), dst32[i + 2] = src32[i + 2] ^ swap8IfBE(s2), dst32[i + 3] = src32[i + 3] ^ swap8IfBE(s3), ctrNum = ctrNum + 1 >>> 0, view.setUint32(ctrPos, ctrNum, isLE2);
  }
  let start = BLOCK_SIZE2 * Math.floor(src32.length / BLOCK_SIZE32);
  if (start < srcLen) {
    let { s0, s1, s2, s3 } = encrypt(xk, swap8IfBE(c32[0]), swap8IfBE(c32[1]), swap8IfBE(c32[2]), swap8IfBE(c32[3])), b32 = new Uint32Array([s0, s1, s2, s3]);
    swap32IfBE(b32);
    let buf = u8(b32);
    for (let i = start, pos = 0; i < srcLen; i++, pos++)
      dst[i] = src[i] ^ buf[pos];
    clean2(b32);
  }
  return dst;
}
function computeTag(fn, isLE2, key, data, AAD) {
  let aadLength = AAD ? AAD.length : 0, h = fn.create(key, data.length + aadLength);
  AAD && h.update(AAD);
  let num = u64Lengths(8 * data.length, 8 * aadLength, isLE2);
  h.update(data), h.update(num);
  let res = h.digest();
  return clean2(num), res;
}
var gcm = /* @__PURE__ */ wrapCipher({ blockSize: 16, nonceLength: 12, tagLength: 16, withAAD: !0, varSizeNonce: !0 }, function(key, nonce, AAD) {
  if (nonce.length < 8)
    throw new Error("aes/gcm: invalid nonce length");
  let tagLength = 16;
  function _computeTag(authKey, tagMask, data) {
    let tag = computeTag(ghash, !1, authKey, data, AAD);
    for (let i = 0; i < tagMask.length; i++)
      tag[i] ^= tagMask[i];
    return tag;
  }
  function deriveKeys() {
    let xk = expandKeyLE(key), authKey = EMPTY_BLOCK.slice(), counter = EMPTY_BLOCK.slice();
    if (ctr32(xk, !1, counter, counter, authKey), nonce.length === 12)
      counter.set(nonce);
    else {
      let nonceLen = EMPTY_BLOCK.slice();
      createView2(nonceLen).setBigUint64(8, BigInt(nonce.length * 8), !1);
      let g = ghash.create(authKey).update(nonce).update(nonceLen);
      g.digestInto(counter), g.destroy();
    }
    let tagMask = ctr32(xk, !1, counter, EMPTY_BLOCK);
    return { xk, authKey, counter, tagMask };
  }
  return {
    encrypt(plaintext) {
      let { xk, authKey, counter, tagMask } = deriveKeys(), out = new Uint8Array(plaintext.length + tagLength), toClean = [xk, authKey, counter, tagMask];
      isAligned32(plaintext) || toClean.push(plaintext = copyBytes(plaintext)), ctr32(xk, !1, counter, plaintext, out.subarray(0, plaintext.length));
      let tag = _computeTag(authKey, tagMask, out.subarray(0, out.length - tagLength));
      return toClean.push(tag), out.set(tag, plaintext.length), clean2(...toClean), out;
    },
    decrypt(ciphertext) {
      let { xk, authKey, counter, tagMask } = deriveKeys(), toClean = [xk, authKey, tagMask, counter];
      isAligned32(ciphertext) || toClean.push(ciphertext = copyBytes(ciphertext));
      let data = ciphertext.subarray(0, -tagLength), passedTag = ciphertext.subarray(-tagLength), tag = _computeTag(authKey, tagMask, data);
      if (toClean.push(tag), !equalBytes(tag, passedTag))
        throw clean2(...toClean), new Error("aes-gcm: invalid tag");
      let out = ctr32(xk, !1, counter, data);
      return clean2(...toClean), out;
    }
  };
});

// mobile/shell/lock.js
var PIN_ITERATIONS = 6e5, PIN_LENGTH = 6, PIN_KEY_BYTES = 32, PIN_MIN_ITERATIONS = 1e5, PIN_MAX_ITERATIONS = 1e7, DEVICE_META = "pin-device", BACKGROUND_LOCK_MS = 300 * 1e3, PIN_WAIT_FROM = 5, PIN_WAIT_CAP_S = 900, VERIFIER_TEXT = new TextEncoder().encode("plenum-pin-check/1"), VERIFIER_AAD = new TextEncoder().encode("plenum-lock-verifier");
function pinWaitSeconds(failures) {
  return !Number.isSafeInteger(failures) || failures < PIN_WAIT_FROM ? 0 : Math.min(PIN_WAIT_CAP_S, 30 * 2 ** (failures - PIN_WAIT_FROM));
}
var b64u = {
  enc(bytes) {
    let bin = "";
    for (let b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(text) {
    let s = String(text).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(s + "=".repeat((4 - s.length % 4) % 4)), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
};
function isValidPin(pin) {
  return typeof pin == "string" && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
}
function wrapKey(keyBytes, pinKey, computerId) {
  let iv = randomBytes(12), ct = gcm(pinKey, iv, new TextEncoder().encode(`plenum-key/${computerId}`)).encrypt(keyBytes);
  return { v: 1, iv: b64u.enc(iv), ct: b64u.enc(ct) };
}
function unwrapKey(wrap, pinKey, computerId) {
  if (!wrap || wrap.v !== 1) throw new Error("bad wrap");
  let plain = gcm(pinKey, b64u.dec(wrap.iv), new TextEncoder().encode(`plenum-key/${computerId}`)).decrypt(b64u.dec(wrap.ct));
  if (plain.byteLength !== PIN_KEY_BYTES) throw new Error("bad key");
  return plain;
}
function derivePinKey(pin, salt, iterations = PIN_ITERATIONS) {
  return pbkdf2(sha256, new TextEncoder().encode(pin), salt, { c: iterations, dkLen: PIN_KEY_BYTES });
}
function createPasskeyGate({ credentials = globalThis.navigator?.credentials, PublicKeyCredentialCtor = globalThis.PublicKeyCredential, rpId = globalThis.location?.hostname ?? "localhost", random = randomBytes } = {}) {
  return {
    async available() {
      if (!credentials || !PublicKeyCredentialCtor) return !1;
      try {
        return await PublicKeyCredentialCtor.isUserVerifyingPlatformAuthenticatorAvailable?.() === !0;
      } catch {
        return !1;
      }
    },
    async register() {
      let cred = await credentials.create({
        publicKey: {
          challenge: random(32),
          rp: { name: "Plenum", id: rpId },
          user: { id: random(16), name: "plenum-phone", displayName: "Plenum on this phone" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
          timeout: 6e4
        }
      });
      if (!cred || !cred.rawId) throw new Error("no passkey");
      return b64u.enc(new Uint8Array(cred.rawId));
    },
    async verify(credentialId) {
      let assertion = await credentials.get({
        publicKey: {
          challenge: random(32),
          allowCredentials: [{ type: "public-key", id: b64u.dec(credentialId) }],
          userVerification: "required",
          timeout: 6e4
        }
      });
      return assertion != null;
    }
  };
}
function createBiometricGate({ plugin = null } = {}) {
  return {
    async available() {
      if (!plugin) return !1;
      try {
        return (await plugin.checkBiometry())?.isAvailable === !0;
      } catch {
        return !1;
      }
    },
    async verify(reason = "Unlock Plenum") {
      if (!plugin) return !1;
      try {
        return await plugin.authenticate({ reason, allowDeviceCredential: !0, cancelTitle: "Cancel", iosFallbackTitle: "Use passcode" }), !0;
      } catch {
        return !1;
      }
    }
  };
}
function createLock({ store, now = () => Date.now(), biometric = null, passkey = null, iterations = PIN_ITERATIONS, subtle = globalThis.crypto?.subtle ?? null, mono = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  if (!store) throw new TypeError("createLock needs the store");
  let backgroundAt = null, locked = !1, settings = null, pinKeyHeld = null, monoUntil = 0, queue = Promise.resolve(), serial = (fn) => {
    let run = queue.then(fn, fn);
    return queue = run.catch(() => {
    }), run;
  }, readSettings = async () => (settings || (settings = await store.meta.get("lock") ?? { mode: "off", failures: 0, lockedUntil: 0 }), settings), writeSettings = async (next) => {
    settings = next, await store.meta.put("lock", next);
  }, plainKeys = async (pinKey) => {
    let out = /* @__PURE__ */ new Map();
    for (let rec of await store.list())
      typeof rec.myPriv == "string" ? out.set(rec.id, b64u.dec(rec.myPriv)) : rec.myPriv && pinKey && out.set(rec.id, unwrapKey(rec.myPriv, pinKey, rec.id));
    return out;
  }, lockout = (s) => {
    let wall = s.lockedUntil > now() ? Math.ceil((s.lockedUntil - now()) / 1e3) : 0, steady = monoUntil > mono() ? Math.ceil((monoUntil - mono()) / 1e3) : 0;
    return Math.max(wall, steady);
  }, api = {
    // What the lock screen and Settings show. No key material.
    async status() {
      let s = await readSettings();
      return {
        mode: s.mode,
        locked,
        failures: s.failures ?? 0,
        waitSec: lockout(s),
        biometricAvailable: biometric ? await biometric.available() : !1,
        passkeyAvailable: passkey ? await passkey.available() : !1
      };
    },
    // Called once at launch: a lock that is on starts locked.
    async lockOnLaunch() {
      return locked = (await readSettings()).mode !== "off", locked;
    },
    isLocked: () => locked,
    lock() {
      return locked = !0, pinKeyHeld = null, !0;
    },
    onBackground() {
      backgroundAt = now();
    },
    async onForeground() {
      return (await readSettings()).mode !== "off" && backgroundAt !== null && now() - backgroundAt >= BACKGROUND_LOCK_MS && (locked = !0, pinKeyHeld = null), backgroundAt = null, locked;
    },
    // The record as it must rest in the store: in PIN mode its private key is wrapped under the PIN key held while unlocked. It refuses
    // (throws 'locked') when the PIN key is not held, so a key is never written plain under a PIN.
    async protect(record) {
      if ((await readSettings()).mode !== "pin") return record;
      if (!pinKeyHeld) throw new Error("locked");
      return typeof record.myPriv != "string" ? record : { ...record, myPriv: wrapKey(b64u.dec(record.myPriv), pinKeyHeld, record.id) };
    },
    // The public calls that read or write lock state run one at a time (serial above). The bodies are the *Inner functions below.
    enableBiometric: (...a) => serial(() => enableBiometricInner(...a)),
    unlockBiometric: (...a) => serial(() => unlockBiometricInner(...a)),
    setPin: (...a) => serial(() => setPinInner(...a)),
    unlockPin: (...a) => serial(() => unlockPinInner(...a)),
    enablePasskey: (...a) => serial(() => enablePasskeyInner(...a)),
    unlockPasskey: (...a) => serial(() => unlockPasskeyInner(...a)),
    disable: (...a) => serial(() => disableInner(...a))
  };
  async function deviceKey(create) {
    if (!subtle || store.kind !== "web") return null;
    let have = await store.meta.get(DEVICE_META);
    if (have && typeof have == "object" && have.type === "secret") return have;
    if (!create) return null;
    let made = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, !1, ["sign"]);
    return await store.meta.put(DEVICE_META, made), made;
  }
  async function pinKeyV2(pin, salt, its, key) {
    let stretched = derivePinKey(pin, salt, its), mixed = new Uint8Array(await subtle.sign("HMAC", key, stretched));
    return stretched.fill(0), mixed;
  }
  async function enableBiometricInner() {
    return settings = null, !biometric || !await biometric.available() ? { ok: !1, reason: "unavailable" } : await biometric.verify("Turn on app lock for Plenum") ? (await writeSettings({ mode: "biometric", failures: 0, lockedUntil: 0 }), { ok: !0 }) : { ok: !1, reason: "cancelled" };
  }
  async function unlockBiometricInner() {
    return settings = null, (await readSettings()).mode !== "biometric" ? { ok: !1, reason: "mode" } : await biometric.verify() ? (locked = !1, { ok: !0, keys: await plainKeys(null) }) : { ok: !1, reason: "cancelled" };
  }
  async function setPinInner(pin) {
    if (settings = null, !isValidPin(pin)) return { ok: !1, reason: "format" };
    if ((await readSettings()).mode !== "off") return { ok: !1, reason: "mode" };
    let salt = randomBytes(16), dk = await deviceKey(!0), pinKey = dk ? await pinKeyV2(pin, salt, iterations, dk) : derivePinKey(pin, salt, iterations), nonce = randomBytes(12), ct = gcm(pinKey, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT), keys = await plainKeys(null);
    for (let rec of await store.list()) {
      let key = keys.get(rec.id);
      if (!key) continue;
      let next = { ...rec, myPriv: wrapKey(key, pinKey, rec.id) };
      await store.put(next);
    }
    return await store.meta.put("pin", { v: dk ? 2 : 1, salt: b64u.enc(salt), iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) }), await writeSettings({ mode: "pin", failures: 0, lockedUntil: 0 }), pinKeyHeld = pinKey, { ok: !0, keys };
  }
  async function unlockPinInner(pin) {
    settings = null;
    let s = await readSettings();
    if (s.mode !== "pin") return { ok: !1, reason: "mode" };
    if (!isValidPin(pin)) return { ok: !1, reason: "format" };
    if (lockout(s) > 0) return { ok: !1, reason: "wait", waitSec: lockout(s), failures: s.failures };
    let pinRecord = await store.meta.get("pin");
    if (!pinRecord) return { ok: !1, reason: "mode" };
    if (!Number.isSafeInteger(pinRecord.iterations) || pinRecord.iterations < Math.min(PIN_MIN_ITERATIONS, iterations) || pinRecord.iterations > PIN_MAX_ITERATIONS)
      return { ok: !1, reason: "damaged" };
    let salt = b64u.dec(pinRecord.salt), pinKey;
    if (pinRecord.v === 2) {
      let dk = await deviceKey(!1);
      if (!dk) return { ok: !1, reason: "damaged" };
      pinKey = await pinKeyV2(pin, salt, pinRecord.iterations, dk);
    } else
      pinKey = derivePinKey(pin, salt, pinRecord.iterations);
    let right = !1;
    try {
      let plain = gcm(pinKey, b64u.dec(pinRecord.nonce), VERIFIER_AAD).decrypt(b64u.dec(pinRecord.ct));
      right = plain.length === VERIFIER_TEXT.length && plain.every((b, i) => b === VERIFIER_TEXT[i]);
    } catch {
      right = !1;
    }
    if (!right) {
      let failures = (s.failures ?? 0) + 1, wait = pinWaitSeconds(failures);
      return monoUntil = wait > 0 ? mono() + wait * 1e3 : 0, await writeSettings({ ...s, failures, lockedUntil: wait > 0 ? now() + wait * 1e3 : 0 }), { ok: !1, reason: "wrong", failures, waitSec: wait };
    }
    let held = pinKey;
    if (pinRecord.v !== 2 && subtle && store.kind === "web") {
      let made = await deviceKey(!0), v2 = await pinKeyV2(pin, salt, pinRecord.iterations, made), keysV1 = await plainKeys(pinKey);
      for (let rec of await store.list()) {
        let key = keysV1.get(rec.id);
        key && await store.put({ ...rec, myPriv: wrapKey(key, v2, rec.id) });
      }
      let nonce = randomBytes(12), ct = gcm(v2, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT);
      await store.meta.put("pin", { v: 2, salt: pinRecord.salt, iterations: pinRecord.iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) }), held = v2;
    }
    return await writeSettings({ ...s, failures: 0, lockedUntil: 0 }), locked = !1, pinKeyHeld = held, { ok: !0, keys: await plainKeys(held) };
  }
  async function enablePasskeyInner() {
    if (settings = null, !passkey || !await passkey.available()) return { ok: !1, reason: "unavailable" };
    let credentialId = await passkey.register();
    return await store.meta.put("passkey", { id: credentialId }), await writeSettings({ mode: "passkey", failures: 0, lockedUntil: 0 }), { ok: !0 };
  }
  async function unlockPasskeyInner() {
    if (settings = null, (await readSettings()).mode !== "passkey") return { ok: !1, reason: "mode" };
    let record = await store.meta.get("passkey");
    return !record || !await passkey.verify(record.id) ? { ok: !1, reason: "cancelled" } : (locked = !1, { ok: !0, keys: await plainKeys(null) });
  }
  async function disableInner({ pin = null } = {}) {
    settings = null;
    let s = await readSettings();
    if (s.mode === "biometric") {
      if (!await biometric?.verify("Turn off app lock for Plenum")) return { ok: !1, reason: "cancelled" };
    } else if (s.mode === "passkey") {
      let rec = await store.meta.get("passkey");
      if (!rec || !await passkey?.verify(rec.id)) return { ok: !1, reason: "cancelled" };
    }
    if (s.mode === "pin") {
      let unlocked = await unlockPinInner(pin);
      if (!unlocked.ok) return unlocked;
      for (let rec of await store.list()) {
        let key = unlocked.keys.get(rec.id);
        key && await store.put({ ...rec, myPriv: b64u.enc(key) });
      }
      await store.meta.remove("pin"), await store.meta.remove(DEVICE_META);
    } else s.mode === "passkey" && await store.meta.remove("passkey");
    return await writeSettings({ mode: "off", failures: 0, lockedUntil: 0 }), locked = !1, pinKeyHeld = null, { ok: !0 };
  }
  return api;
}

// mobile/shell/pairing.js
var PAIR_FINAL = Object.freeze(["allowed", "denied", "expired", "mismatch", "failed"]), OFFER_TTL_MAX_S = 600, PairingError = class extends Error {
  constructor(code, message = code) {
    super(message), this.name = "PairingError", this.code = code;
  }
};
function parsePairingText(text) {
  let raw = String(text ?? "").trim();
  if (!raw) throw new PairingError("not-plenum");
  if (raw.length > 8192) throw new PairingError("not-plenum");
  let fragment = null, native = /^plenum:\/\/pair#(.*)$/i.exec(raw);
  if (native)
    fragment = native[1];
  else {
    let hashAt = raw.indexOf("#");
    fragment = hashAt >= 0 ? raw.slice(hashAt + 1) : raw;
  }
  let m = /(?:^|&)pair=([A-Za-z0-9_-]+)$/.exec(fragment) ?? (native ? /^([A-Za-z0-9_-]+)$/.exec(fragment) : null);
  if (!m) throw new PairingError("not-plenum");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64uToBytes(m[1])));
  } catch {
    throw new PairingError("not-plenum");
  }
  return validatePayload(parsed);
}
function validatePayload(p) {
  if (!p || typeof p != "object" || Array.isArray(p)) throw new PairingError("not-plenum");
  if (p.v !== 1) throw new PairingError("version");
  let key32 = (value) => typeof value == "string" && /^[A-Za-z0-9_-]+$/.test(value) && b64uToBytes(value).byteLength === 32;
  if (!key32(p.pub) || !key32(p.psk)) throw new PairingError("not-plenum");
  if (typeof p.offer != "string" || !/^[0-9a-f]{32}$/.test(p.offer)) throw new PairingError("not-plenum");
  let ttl = Number(p.ttl ?? 120);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > OFFER_TTL_MAX_S) throw new PairingError("expired");
  if (!Array.isArray(p.carriers) || p.carriers.length === 0) throw new PairingError("no-carrier");
  let carriers = [], kinds = /* @__PURE__ */ new Set();
  for (let c of p.carriers)
    if (!(!c || !["lan", "tailscale", "relay"].includes(c.kind) || kinds.has(c.kind)) && (kinds.add(c.kind), carriers.push(Array.isArray(c.urls) ? { ...c, urls: c.urls.slice(0, 4) } : c), carriers.length === 3))
      break;
  if (!carriers.length) throw new PairingError("no-carrier");
  return {
    v: 1,
    name: typeof p.name == "string" ? p.name.slice(0, 60) : "Plenum computer",
    pub: p.pub,
    psk: p.psk,
    offer: p.offer,
    ttl,
    carriers,
    sas: "6"
  };
}
function pageCandidates(pageUrl, payload) {
  let m = /^(https?):\/\/([^/]+)\/p\/([0-9a-f]{32})\//.exec(String(pageUrl ?? ""));
  if (!m) return [];
  let url = `${m[1] === "https" ? "wss" : "ws"}://${m[2]}/b/${m[3]}`;
  return (payload?.carriers ?? []).some((c) => (Array.isArray(c.urls) ? c.urls : [c.url]).includes(url)) ? [] : [{ kind: "lan", url }];
}
function startPairing({
  payload,
  store = null,
  createWorker = defaultCreateWorker,
  device = {},
  caps = null,
  pageUrl = null,
  prepareRecord = null,
  onState = () => {
  }
} = {}) {
  if (!payload || typeof payload != "object") throw new PairingError("not-plenum");
  let worker = createWorker(), current = { state: "starting", code: null, tried: [], reason: null }, saving = Promise.resolve(), finished = !1, resolveDone, done = new Promise((resolve) => {
    resolveDone = resolve;
  }), extraUrls = pageCandidates(pageUrl, payload), finish = (value) => {
    finished || (finished = !0, resolveDone(value), setTimeout(() => {
      try {
        worker.terminate();
      } catch {
      }
    }, 0));
  }, set = (patch) => {
    current = { ...current, ...patch };
    try {
      onState({ ...current });
    } catch {
    }
  };
  return worker.onmessage = (event) => {
    let msg = event?.data;
    if (!(!msg || typeof msg != "object")) {
      if (msg.op === "counter") {
        answerCounter(store, msg, (reply) => worker.postMessage(reply));
        return;
      }
      if (msg.op === "paired") {
        saving = Promise.resolve().then(async () => {
          if (!store) return !0;
          let record = prepareRecord ? await prepareRecord(msg.computer) : msg.computer;
          return await store.put(record), !0;
        }).catch(() => !1);
        return;
      }
      if (msg.op === "pairState") {
        if (msg.state === "confirm") {
          set({ state: "confirm", code: msg.code ?? null });
          return;
        }
        if (msg.state === "allowed") {
          saving.then((ok) => {
            if (!ok) {
              set({ state: "failed", reason: "save" }), finish({ ...current });
              return;
            }
            set({ state: "allowed", reason: null }), finish({ ...current, computerId: msg.computerId ?? null });
          });
          return;
        }
        PAIR_FINAL.includes(msg.state) && (set({ state: msg.state, tried: msg.tried ?? current.tried, reason: msg.reason ?? null }), finish({ ...current }));
      }
    }
  }, worker.onerror = () => {
    set({ state: "failed", reason: "worker" }), finish({ ...current });
  }, set({ state: "starting" }), worker.postMessage({ op: "pair", payload, device, caps: caps ?? void 0, extraUrls }), {
    cancel() {
      finished || worker.postMessage({ op: "pairCancel" });
    },
    done,
    state: () => ({ ...current })
  };
}

// mobile/shell/carriers.js
var CARRIER_KINDS = Object.freeze(["lan", "tailscale", "relay"]), MAX_URLS_PER_KIND = 4, MAX_URL_LENGTH = 512;
function ipv4Of(hostname) {
  let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  let parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}
function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return !0;
  let v4 = ipv4Of(hostname);
  return v4 !== null && v4[0] === 127;
}
function isPrivateV4([a, b]) {
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
function isPrivateV6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return !1;
  let first = hostname.slice(1, -1).split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return !1;
  let value = parseInt(first, 16);
  return value >= 64512 && value <= 65023 || value >= 65152 && value <= 65215;
}
function carrierUrlOk(kind, url) {
  if (!CARRIER_KINDS.includes(kind) || typeof url != "string" || url.length > MAX_URL_LENGTH) return !1;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return !1;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:" || parsed.username || parsed.password) return !1;
  let host = parsed.hostname;
  if (isLoopback(host)) return !0;
  if (kind === "relay") return parsed.protocol === "wss:";
  if (kind === "tailscale") return parsed.protocol === "wss:" && host.endsWith(".ts.net");
  let v4 = ipv4Of(host);
  return v4 ? isPrivateV4(v4) : isPrivateV6(host) || host.endsWith(".local");
}
function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function usableCarriers(carriers) {
  let out = [], seen = /* @__PURE__ */ new Set();
  for (let entry of Array.isArray(carriers) ? carriers : []) {
    if (!entry || typeof entry != "object" || !CARRIER_KINDS.includes(entry.kind) || seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    let urls = (Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : []).filter((url) => carrierUrlOk(entry.kind, url)).slice(0, MAX_URLS_PER_KIND);
    urls.length && out.push({ kind: entry.kind, urls });
  }
  return out;
}

// mobile/shell/stop.js
var STOP_STATES = Object.freeze(["idle", "sending", "queued", "done", "failed"]), plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function stopResultText(ack, computerName = "this computer") {
  let replies = Number(ack?.cancelled) || 0, runs = Number(ack?.drivesStopped) || 0, agents = Number(ack?.agentsStopped) || 0, cards = Number(ack?.cardsDenied) || 0;
  if (!replies && !runs && !agents && !cards) return `Nothing was running on ${computerName}.`;
  let parts = [];
  replies && parts.push(plural(replies, "reply", "replies")), runs && parts.push(plural(runs, "computer run", "computer runs")), agents && parts.push(plural(agents, "agent", "agents"));
  let tail = cards ? ` ${plural(cards, "card", "cards")} denied.` : "";
  return `Stopped everything on ${computerName}: ${parts.join(", ")}.${tail}`;
}
var STOP_FAILURE_TEXT = Object.freeze({
  title: "Could not reach the computer",
  body: "The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run."
}), STOP_QUEUED_TEXT = "Stop will be sent when the computer is reachable. Trying for 60 seconds.", STOP_NOT_ACCEPTED = (computer) => `${computer} did not accept this Stop. This phone may have been removed there. At the computer, press Stop on the bar or Ctrl+Alt+Esc.`, STOP_NEEDS_UNLOCK = "Unlock Plenum to send this Stop. It goes out as soon as Plenum unlocks.";
function createStopController({ channel, clock = globalThis, computerName = "" } = {}) {
  if (!channel || typeof channel.stop != "function") throw new TypeError("createStopController needs a channel");
  let state = "idle", lastAck = null, lastError = null, timer = null, subs = /* @__PURE__ */ new Set(), set = (next, extra = {}) => {
    state = next, extra.ack !== void 0 && (lastAck = extra.ack), extra.error !== void 0 && (lastError = extra.error);
    let view = { state, ack: lastAck, error: lastError, text: textFor(next, lastAck, lastError) };
    for (let fn of Array.from(subs))
      try {
        fn(view);
      } catch {
      }
  }, textFor = (s, ack, error) => s === "done" ? stopResultText(ack, computerName || "this computer") : s === "queued" ? STOP_QUEUED_TEXT : s === "failed" && error === "unknown" ? STOP_NOT_ACCEPTED(computerName || "this computer") : s === "failed" ? `${STOP_FAILURE_TEXT.title}. ${STOP_FAILURE_TEXT.body}` : s === "sending" ? "Stopping everything on the computer" : error ? String(error) : "", unsubscribe = channel.onStopState?.((view) => {
    state === "sending" && view.state === "queued" && set("queued"), state === "queued" && view.state === "sent" && set("sending");
  });
  return {
    get state() {
      return state;
    },
    get view() {
      return { state, ack: lastAck, error: lastError, text: textFor(state, lastAck, lastError) };
    },
    subscribe(fn) {
      subs.add(fn);
      try {
        fn(this.view);
      } catch {
      }
      return () => subs.delete(fn);
    },
    // Presses Stop. Resolves with the view that ended the press ('done' or 'failed'). `project` limits the stop to one project.
    async press(project = null) {
      if (state === "sending" || state === "queued") return this.view;
      clock.clearTimeout(timer), timer = null, set("sending", { error: null });
      let watchdog = null, silent = new Promise((_, reject) => {
        watchdog = clock.setTimeout(() => reject(Object.assign(new Error("unreachable"), { code: "unreachable" })), 65e3);
      });
      try {
        let ack = await Promise.race([channel.stop(project), silent]);
        clock.clearTimeout(watchdog), set("done", { ack, error: null }), timer = clock.setTimeout(() => {
          timer = null, state === "done" && set("idle");
        }, 1600);
      } catch (err) {
        clock.clearTimeout(watchdog), set("failed", { error: err?.code ?? "unreachable" });
      }
      return this.view;
    },
    dispose() {
      clock.clearTimeout(timer), timer = null, unsubscribe?.(), subs.clear();
    }
  };
}

// mobile/shell/debug.js
var PATTERNS = [
  [/x-plenum-token\s*[:=]\s*\S+/gi, "x-plenum-token: [redacted]"],
  [/\b[0-9a-fA-F]{48,}\b/g, "[redacted-hex]"],
  [/\b[A-Za-z0-9_-]{43,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]"],
  [/\[(?:\s*\d{1,3}\s*,){15,}\s*\d{1,3}\s*\]/g, "[redacted-bytes]"],
  [/\b(?:\d{1,3},){15,}\d{1,3}\b/g, "[redacted-bytes]"],
  [/(stopKey|pushKey|desktopPub|handshakeHash|myDeviceId|psk|pub|myPriv|privateKey|nonce|cookie|token|secret|key)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[redacted]"]
];
function redactLine(text) {
  let out = String(text ?? "");
  for (let [re, to] of PATTERNS) out = out.replace(re, to);
  return out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim(), out.slice(0, 2048);
}
function createDebugLog({ now = () => Date.now(), capacity = 500 } = {}) {
  let ring = [], subs = /* @__PURE__ */ new Set(), notify = () => {
    for (let fn of Array.from(subs))
      try {
        fn();
      } catch {
      }
  };
  return {
    // Adds one line. Returns the stored line, or null when there was nothing left after redaction.
    log(text, level = "info") {
      let line = redactLine(text);
      if (!line) return null;
      let entry = { at: now(), level, text: line };
      for (ring.push(entry); ring.length > capacity; ) ring.shift();
      return notify(), entry;
    },
    lines() {
      return ring.map((l) => ({ ...l }));
    },
    clear() {
      ring.length = 0, notify();
    },
    subscribe(fn) {
      return subs.add(fn), () => subs.delete(fn);
    },
    // Posts the most recent lines to the computer, one request each (POST /_bridge/log takes { line }). `request` is channel.request.
    // Resolves with the number of lines the computer answered for.
    async sendToComputer(request, count = 100) {
      let picked = ring.slice(-Math.max(0, Math.min(count, 100))), accepted = 0;
      for (let entry of picked) {
        let body = JSON.stringify({ line: `[phone ${entry.level}] ${entry.text}`.slice(0, 2048) });
        try {
          let res = await request({ method: "POST", path: "/_bridge/log", headers: { "content-type": "application/json" } }, body);
          try {
            await res.body?.cancel();
          } catch {
          }
          res.status === 200 && (accepted += 1);
        } catch {
          break;
        }
      }
      return accepted;
    }
  };
}

// mobile/shell/push.js
init_core();
var ID = /^[A-Za-z0-9_.-]{1,80}$/, FIRST_LINE_MAX = 200;
function pushAvailable(env = globalThis) {
  let nav = env.navigator;
  return !!(env.isSecureContext && nav && "serviceWorker" in nav && env.PushManager && env.Notification);
}
function cleanLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, FIRST_LINE_MAX);
}
function parseNotificationHash(hash) {
  let text = String(hash ?? "").replace(/^#/, ""), named = /&computer=([A-Za-z0-9_.-]{1,80})$/.exec(text);
  if (named) {
    let link = parseNotificationHash(text.slice(0, named.index));
    return link ? { ...link, computer: named[1] } : null;
  }
  if (text === "stop") return { kind: "stop" };
  if (text === "home") return { kind: "home" };
  if (text === "waiting") return { kind: "waiting" };
  if (text === "chat") return { kind: "chat" };
  if (text === "settings=limit") return { kind: "settings", section: "limit" };
  let m = /^(deny|approve|waiting|handover)=([A-Za-z0-9_.-]{1,80})(?:&line=([^&]*))?$/.exec(text);
  if (m && ID.test(m[2])) {
    if (m[1] === "approve") {
      let line = "";
      try {
        line = cleanLine(decodeURIComponent(m[3] ?? ""));
      } catch {
        line = "";
      }
      return { kind: "approve", id: m[2], line };
    }
    return m[3] !== void 0 ? null : { kind: m[1], id: m[2] };
  }
  return m = /^chat=([A-Za-z0-9_.-]{1,80})$/.exec(text), m ? { kind: "chat", project: m[1] } : null;
}
function isRouteLink(link) {
  return !!link && ["waiting", "handover", "chat", "settings", "home"].includes(link.kind);
}
async function subscribeWebPush({ registration, applicationServerKey, request, deviceId, notification, env = globalThis } = {}) {
  if (!pushAvailable(env) || !registration?.pushManager) return { ok: !1, state: "unsupported", status: 0 };
  if (!applicationServerKey || typeof request != "function" || !deviceId) return { ok: !1, state: "failed", status: 0 };
  if (await (notification ?? env.Notification).requestPermission() !== "granted") return { ok: !1, state: "denied", status: 0 };
  let key = bytesFromB64u(applicationServerKey), held = null;
  try {
    held = await registration.pushManager.getSubscription?.() ?? null;
  } catch {
    held = null;
  }
  if (held && !sameKey(held.options?.applicationServerKey, key)) return { ok: !1, state: "other-computer", status: 0 };
  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: !0, applicationServerKey: key });
  } catch (err) {
    return { ok: !1, state: err?.name === "InvalidStateError" ? "other-computer" : "failed", status: 0 };
  }
  let json = subscription.toJSON ? subscription.toJSON() : subscription, body = JSON.stringify({ id: deviceId, subscription: { endpoint: json.endpoint, keys: json.keys } }), res = await request({ method: "POST", path: "/api/phones/push", headers: { "content-type": "application/json" } }, body);
  try {
    await res.body?.cancel();
  } catch {
  }
  return res.status !== 200 ? { ok: !1, state: "failed", status: res.status } : { ok: !0, state: "on", status: res.status, endpoint: typeof json.endpoint == "string" ? json.endpoint : "" };
}
function sameKey(held, key) {
  if (!held) return !0;
  let a = held instanceof Uint8Array ? held : ArrayBuffer.isView(held) ? new Uint8Array(held.buffer, held.byteOffset, held.byteLength) : new Uint8Array(held);
  if (a.length !== key.length) return !1;
  for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return !1;
  return !0;
}
async function dropWebPush({ registration, endpoint, applicationServerKey = null } = {}) {
  if (!endpoint && !applicationServerKey || !registration?.pushManager) return !1;
  try {
    let held = await registration.pushManager.getSubscription?.();
    return !held || (endpoint ? held.endpoint !== endpoint : !(held.options?.applicationServerKey && sameKey(held.options.applicationServerKey, bytesFromB64u(applicationServerKey)))) ? !1 : await held.unsubscribe?.() !== !1;
  } catch {
    return !1;
  }
}
function bytesFromB64u(text) {
  let s = String(text).replace(/-/g, "+").replace(/_/g, "/"), bin = atob(s + "=".repeat((4 - s.length % 4) % 4)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var ANDROID_CHANNELS = Object.freeze([
  Object.freeze({ id: "plenum-approvals", name: "Approvals and your turn", importance: 4 }),
  Object.freeze({ id: "plenum-finished", name: "Finished and failed runs", importance: 3 }),
  Object.freeze({ id: "plenum-limits", name: "Spend and plan limits", importance: 3 })
]), ENDPOINT_WAIT_MS = 15e3;
function unifiedPushSubscription(event) {
  let endpoint = parseEndpointEvent(event);
  return endpoint.keys ? { subscription: { kind: "unifiedpush", endpoint: endpoint.url, keys: { p256dh: endpoint.keys.pubKey, auth: endpoint.keys.auth } } } : null;
}
function notificationFor(payload) {
  let names = payload.actions.map((a) => a.action), routes = {};
  for (let a of payload.actions) routes[a.action] = a.route;
  return {
    title: payload.title,
    body: payload.body,
    channelId: channelForKind(payload.kind),
    actionTypeId: names.length ? `plenum-${names.join("-")}` : void 0,
    actions: payload.actions.map((a) => ({
      id: a.action,
      title: a.title,
      requiresAuthentication: !0,
      destructive: a.action !== "approve",
      foreground: !1
    })),
    extra: { tap: payload.tap, routes, line: payload.firstLine ?? "", computer: payload.ids?.computer ?? "" }
  };
}
function notificationId(tag) {
  let h = 0;
  for (let ch of String(tag ?? "plenum")) h = h * 31 + ch.charCodeAt(0) | 0;
  return Math.abs(h) % 2147483e3 + 1;
}
function createAndroidPush({
  native,
  requestOf,
  vapidOf = () => null,
  isVisible = () => !0,
  onLink = () => {
  },
  pendingStore = null,
  log = () => {
  },
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
} = {}) {
  let up = native?.UnifiedPush ?? null, local = native?.LocalNotifications ?? null, started = !1, waiting = null, lastEndpoint = null, failure = null, posted = !1, pending = null, types = /* @__PURE__ */ new Set();
  async function post(body) {
    let request = requestOf?.();
    if (typeof request != "function") return { ok: !1, status: 0 };
    try {
      let res = await request({ method: "POST", path: "/api/phones/push", headers: { "content-type": "application/json" } }, JSON.stringify(body));
      try {
        await res.body?.cancel();
      } catch {
      }
      return { ok: res.status === 200, status: res.status };
    } catch {
      return { ok: !1, status: 0 };
    }
  }
  async function onEndpoint(event) {
    let body = null;
    try {
      body = unifiedPushSubscription(event);
    } catch {
      body = null;
    }
    if (!body) {
      failure = "endpoint", waiting?.resolve({ ok: !1, reason: "endpoint" });
      return;
    }
    lastEndpoint = body.subscription.endpoint, pending = body;
    try {
      await pendingStore?.save(body);
    } catch {
    }
    let out = await post(body);
    if (posted = out.ok, out.ok) {
      failure = null, pending = null;
      try {
        await pendingStore?.clear();
      } catch {
      }
    }
    waiting?.resolve(out.ok ? { ok: !0, reason: null } : { ok: !1, reason: "failed" });
  }
  async function showLocal(payload) {
    if (!local?.schedule) return;
    let note = notificationFor(payload);
    note.actionTypeId && !types.has(note.actionTypeId) && (types.add(note.actionTypeId), await local.registerActionTypes?.({ types: [{ id: note.actionTypeId, actions: note.actions }] })), await local.schedule({
      notifications: [{
        id: notificationId(payload.tag),
        title: note.title,
        body: note.body,
        channelId: note.channelId,
        actionTypeId: note.actionTypeId,
        extra: note.extra
      }]
    });
  }
  async function onMessage(event) {
    let parsed = null;
    try {
      parsed = parseMessageEvent(event);
    } catch {
      return;
    }
    if (parsed.payload && isVisible())
      try {
        await showLocal(parsed.payload);
      } catch (err) {
        log(`push: local notification ${err?.code ?? "failed"}`);
      }
  }
  function onAction(event) {
    let extra = event?.notification?.extra ?? {}, id = String(event?.actionId ?? "tap"), route = id === "tap" ? extra.tap : extra.routes?.[id];
    if (typeof route != "string") return;
    let link = routeForAction({ action: id === "tap" ? "tap" : id, route }, extra.line ? String(extra.line) : ""), computer = id !== "tap" && typeof extra.computer == "string" ? extra.computer.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) : "";
    onLink(String(link).replace(/^\//, ""), computer);
  }
  return {
    // Channels, action types and listeners. Safe to call again; a plugin that is missing does nothing.
    async start() {
      if (started || !up) return !1;
      started = !0;
      try {
        for (let c of ANDROID_CHANNELS) await local?.createChannel?.({ id: c.id, name: c.name, importance: c.importance, visibility: 0 });
        if (await up.addListener("endpoint", onEndpoint), await up.addListener("message", onMessage), await up.addListener("registrationFailed", (event) => {
          failure = String(event?.reason ?? "INTERNAL_ERROR"), waiting?.resolve({ ok: !1, reason: "registration" });
        }), await up.addListener("unregistered", () => {
          posted = !1, lastEndpoint = null, pending = null, Promise.resolve(pendingStore?.clear?.()).catch(() => {
          });
        }), await local?.addListener?.("localNotificationActionPerformed", onAction), !pending && pendingStore) {
          let kept = await pendingStore.load().catch(() => null);
          kept?.subscription?.kind === "unifiedpush" && typeof kept.subscription.endpoint == "string" && (pending = kept);
        }
      } catch (err) {
        return log(`push: start ${err?.code ?? "failed"}`), !1;
      }
      return !0;
    },
    // What the settings line shows: whether UnifiedPush is on this phone, which push app, and whether the computer has the subscription.
    async state() {
      if (!up) return { supported: !1, distributor: null, registered: !1, failure };
      try {
        let s = await up.getState();
        return { supported: s?.supported !== !1, distributor: s?.distributor ?? null, registered: posted, endpoint: !!lastEndpoint || Object.keys(s?.endpoints ?? {}).length > 0, failure };
      } catch {
        return { supported: !1, distributor: null, registered: !1, failure };
      }
    },
    // The system chooser for the push app (when more than one is installed, or none is chosen).
    async chooseDistributor() {
      if (!up) return { ok: !1, reason: "unavailable" };
      try {
        return { ok: (await up.pickDistributor())?.ok !== !1, reason: null };
      } catch {
        return { ok: !1, reason: "failed" };
      }
    },
    // Turn on: the permissions (after a tap), a push app, then register. Resolves once the computer has the subscription.
    async enable() {
      if (!up) return { ok: !1, reason: "unavailable" };
      await this.start();
      try {
        if ((await up.requestNotificationPermission())?.granted === !1) return { ok: !1, reason: "denied" };
        await local?.requestPermissions?.();
        let s = await up.getState();
        if (s?.supported === !1) return { ok: !1, reason: "unavailable" };
        if (!s?.distributor) {
          let list = await up.getDistributors(), names = list?.distributors ?? [];
          if (!list?.saved)
            if (names.length === 1)
              await up.chooseDistributor({ packageName: names[0] });
            else {
              if (names.length === 0)
                return { ok: !1, reason: "no-distributor" };
              if ((await up.pickDistributor())?.ok === !1) return { ok: !1, reason: "no-distributor" };
            }
        }
        let answer = new Promise((resolve) => {
          let timer = setTimer(() => resolve({ ok: !1, reason: "timeout" }), ENDPOINT_WAIT_MS);
          waiting = { resolve: (value) => {
            clearTimer(timer), waiting = null, resolve(value);
          } };
        }), vapid = vapidOf();
        return await up.register({ instance: "default", messageForDistributor: "Plenum", ...vapid ? { vapid } : {} }), await answer;
      } catch (err) {
        return waiting = null, { ok: !1, reason: err?.code === "VAPID_REQUIRED" ? "vapid" : "failed" };
      }
    },
    // B-129: an endpoint the computer did not get (no channel when the push app gave it, or the computer refused) is sent again. app.js calls this at
    // every HELLO. The computer replaces the phone's subscription with each body, so a second send is harmless. Nothing is sent after a turn off.
    async resend() {
      if (posted || !pending) return { ok: posted, reason: null };
      let out = await post(pending);
      if (posted = out.ok, out.ok) {
        pending = null, failure = null;
        try {
          await pendingStore?.clear();
        } catch {
        }
      }
      return { ok: out.ok, reason: out.ok ? null : "failed" };
    },
    // Turn off: the computer forgets the subscription and the push app registration ends.
    async disable() {
      if (!up) return { ok: !1, reason: "unavailable" };
      let out = await post({ subscription: null });
      try {
        await up.unregister({ instance: "default" });
      } catch {
      }
      posted = !1, lastEndpoint = null, pending = null;
      try {
        await pendingStore?.clear();
      } catch {
      }
      return { ok: out.ok, reason: out.ok ? null : "failed" };
    },
    // Test hooks: the handlers the listeners call.
    handlers: { onEndpoint, onMessage, onAction }
  };
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
function appKindFor(win) {
  return isNative(win) ? { app: platformFor(win), name: "This phone" } : isLanPage(win) ? { app: "lan-web", name: "This browser" } : { app: "pwa", name: "This phone (web app)" };
}
function pageKindFor(win) {
  let root = win?.document?.documentElement;
  return !root || typeof root.hasAttribute != "function" || root.hasAttribute("data-shell-page") ? "shell" : typeof root.getAttribute == "function" && root.getAttribute("data-surface") === "phone" ? "ui" : "shell";
}

// lib/remote/ui-manifest.mjs
var MANIFEST_PATH = "/_bridge/ui-manifest", SHELL_BASE = "/shell/", SHELL_ENTRY = "shell.js", UI_STATIC_PATHS = Object.freeze(["/", "/app.js", "/markdown.js", "/music.js", "/style.css", "/icon.png", "/mark.svg", "/ext.js"]), UI_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'";
var EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/, STATIC_SET = new Set(UI_STATIC_PATHS);
var SHELL_BASE_OK = /^\/(?:[A-Za-z0-9._-]+\/)*$/, TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
});
function fileNameFor(urlPath) {
  return urlPath === "/" ? "index.html" : urlPath.slice(1);
}
function contentTypeFor(name) {
  let dot = name.lastIndexOf(".");
  return TYPES[dot >= 0 ? name.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}
function isUiPath(pathname) {
  return STATIC_SET.has(pathname) || EXT_PATH.test(pathname);
}
function manifestHash(files, sha256Hex2, meta = {}) {
  let rows = files.map((f) => [f.path, f.sha256, f.size]);
  return sha256Hex2(JSON.stringify([String(meta.desktopVersion ?? ""), meta.generation ?? null, rows]));
}
function rewriteIndex(html, ctx = {}) {
  let shellBase = ctx.shellBase ?? SHELL_BASE;
  if (typeof shellBase != "string" || !SHELL_BASE_OK.test(shellBase)) throw new Error("shellBase must be a path such as /shell/");
  let text = String(html);
  if (!/<script\b[^>]*\bsrc="\/app\.js"/i.test(text)) throw new Error("The index has no app.js tag.");
  let out = text.replace(/<html\b([^>]*)>/i, (whole, attrs) => `<html${attrs.replace(/\s+data-surface="[^"]*"/i, "")} data-surface="phone">`);
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

// mobile/shell/ui-loader.js
var CACHE_PREFIX = "plenum-ui-", ACTIVE_CACHE = "plenum-ui-active", ACTIVE_PATH = "/__plenum/active.json", SHA_HEADER = "x-plenum-sha256", SIZE_HEADER = "x-plenum-size", MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_MANIFEST_BYTES = 1024 * 1024, BOOT_FILE = "shell/boot.js", SHELL_FILES = Object.freeze([BOOT_FILE, "shell/shell.js", "shell/channel.worker.js", "shell/styles.css"]), utf82 = new TextEncoder(), utf8Decode = new TextDecoder(), HEX64 = /^[0-9a-f]{64}$/, UiError = class extends Error {
  constructor(code, message) {
    super(message ?? code), this.name = "UiError", this.code = code;
  }
};
function hexOf(bytes) {
  let out = "";
  for (let b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function sha256Hex(bytes) {
  return hexOf(sha256(bytes));
}
function verifyBytes(bytes, entry) {
  if (bytes.byteLength !== entry.size) throw new UiError("size", `${entry.path} is ${bytes.byteLength} bytes, not ${entry.size}`);
  if (sha256Hex(bytes) !== entry.sha256) throw new UiError("verify", `${entry.path} does not match the manifest`);
  return !0;
}
function checkManifest(value) {
  let bad = (why) => new UiError("manifest", `The computer sent a damaged UI manifest (${why}).`);
  if (!value || typeof value != "object" || !Array.isArray(value.files) || typeof value.hash != "string") throw bad("shape");
  let seen = /* @__PURE__ */ new Set(), files = [];
  for (let f of value.files) {
    if (!f || typeof f.path != "string" || !isUiPath(f.path)) throw bad("path");
    if (seen.has(f.path)) throw bad("duplicate");
    if (typeof f.sha256 != "string" || !HEX64.test(f.sha256)) throw bad("sha256");
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad("size");
    seen.add(f.path), files.push({ path: f.path, sha256: f.sha256, size: f.size, type: typeof f.type == "string" ? f.type.slice(0, 100) : "application/octet-stream" });
  }
  if (!seen.has("/")) throw bad("no index");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let desktopVersion = String(value.desktopVersion ?? "");
  if (desktopVersion.length > 40) throw bad("version");
  let generation = value.generation === null || value.generation === void 0 ? null : value.generation;
  if (generation !== null && !Number.isInteger(generation)) throw bad("generation");
  if (manifestHash(files, (text) => sha256Hex(utf82.encode(text)), { desktopVersion, generation }) !== value.hash) throw bad("hash");
  return { desktopVersion, generation, hash: value.hash, files };
}
function cacheNameFor(manifest) {
  let slug = (text) => String(text).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${CACHE_PREFIX}${slug(manifest.desktopVersion || "dev")}-${manifest.generation ?? 0}-${slug(manifest.hash.slice(0, 16))}`;
}
function diffFiles(previousFiles, next, hasCopy = () => !1) {
  let before = new Map((previousFiles ?? []).map((f) => [f.path, f.sha256])), changed = [], reused = [];
  for (let f of next.files)
    before.get(f.path) === f.sha256 && hasCopy(f) ? reused.push(f.path) : changed.push(f);
  let keep = new Set(next.files.map((f) => f.path)), removed = [...before.keys()].filter((p) => !keep.has(p));
  return { changed, reused, removed };
}
function shouldReload({ loadedHash, nextHash, reloadedFor }) {
  return !loadedHash || !nextHash || loadedHash === nextHash ? !1 : reloadedFor !== nextHash;
}
async function readAll(body, cap = MAX_FILE_BYTES) {
  let reader = body.getReader(), parts = [], total = 0;
  for (; ; ) {
    let { done, value } = await reader.read();
    if (done) break;
    if (total += value.byteLength, total > cap)
      throw reader.cancel().catch(() => {
      }), new UiError("size", "The file is larger than the UI allows.");
    parts.push(value);
  }
  let out = new Uint8Array(total), offset = 0;
  for (let part of parts)
    out.set(part, offset), offset += part.byteLength;
  return out;
}
function computerOf(value) {
  return typeof value == "string" ? value : null;
}
function webStorage(caches) {
  let slotOn = (cache) => ({
    async get(path) {
      let res = await cache.match(path);
      return res ? { bytes: new Uint8Array(await res.arrayBuffer()), sha256: res.headers.get(SHA_HEADER), size: Number(res.headers.get(SIZE_HEADER)) } : null;
    },
    async put(path, bytes, entry) {
      await cache.put(path, new Response(bytes, {
        headers: { "content-type": entry.type, [SHA_HEADER]: entry.sha256, [SIZE_HEADER]: String(entry.size), "cache-control": "no-store" }
      }));
    }
  });
  return {
    async readActive() {
      let res = await (await caches.open(ACTIVE_CACHE)).match(ACTIVE_PATH), record = res ? JSON.parse(await res.text()) : null;
      return record ? { ...record, computerId: computerOf(record.computerId) } : null;
    },
    async writeActive(record) {
      await (await caches.open(ACTIVE_CACHE)).put(ACTIVE_PATH, new Response(JSON.stringify(record), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    },
    async openSlot(name) {
      return slotOn(await caches.open(name));
    },
    async dropSlot(name) {
      name !== ACTIVE_CACHE && await caches.delete(name);
    },
    async dropSlotsExcept(name) {
      for (let key of await caches.keys())
        key.startsWith(CACHE_PREFIX) && key !== ACTIVE_CACHE && key !== name && await caches.delete(key);
    },
    async activate() {
    }
  };
}
async function bundledShellFiles(readBundled) {
  let out = [];
  if (!readBundled) return out;
  for (let rel of SHELL_FILES) {
    let bytes = null;
    try {
      bytes = await readBundled(rel);
    } catch {
      bytes = null;
    }
    bytes && bytes.byteLength && out.push({ path: `/${rel}`, bytes });
  }
  return out;
}
function androidStorage({ files, webView, root = "plenum-ui" }) {
  let base = (name) => `${root}/${name}`, slotOn = (name) => ({
    async get(path) {
      let bytes = await files.read(`${base(name)}/${fileNameFor(path)}`);
      return bytes ? { bytes, sha256: null, size: bytes.byteLength } : null;
    },
    async put(path, bytes) {
      await files.write(`${base(name)}/${fileNameFor(path)}`, bytes);
    }
  });
  async function activate(record, { readBundled, shellBase } = {}) {
    let dir = base(record.cacheName), index = await files.read(`${dir}/index.html`);
    if (!index) throw new UiError("storage", "The index is missing.");
    for (let file of await bundledShellFiles(readBundled)) await files.write(`${dir}/${fileNameFor(file.path)}`, file.bytes);
    let html = rewriteIndex(utf8Decode.decode(index), { shellBase });
    await files.write(`${dir}/index.html`, utf82.encode(html)), await webView?.persistServerBasePath({ path: dir }), await webView?.setServerBasePath({ path: dir });
  }
  return {
    async readActive() {
      let bytes = await files.read(`${root}/active.json`), record = bytes ? JSON.parse(utf8Decode.decode(bytes)) : null;
      return record ? { ...record, computerId: computerOf(record.computerId) } : null;
    },
    async writeActive(record) {
      await files.write(`${root}/active.json`, utf82.encode(JSON.stringify(record)));
    },
    async openSlot(name) {
      return slotOn(name);
    },
    async dropSlot(name) {
      await files.removeDir(base(name));
    },
    activate,
    // A complete record the WebView does not serve (its persist or set was lost) is activated again. A WebView without
    // getServerBasePath is left alone.
    async ensureActive(record, opts = {}) {
      return !webView?.getServerBasePath || (await webView.getServerBasePath())?.path === base(record.cacheName) ? !1 : (await activate(record, opts), !0);
    },
    async dropSlotsExcept(name) {
      let dirs = await files.listDirs?.(root) ?? [];
      for (let dir of dirs)
        dir !== name && dir.startsWith(CACHE_PREFIX) && await files.removeDir(base(dir));
    }
  };
}
function createUiLoader({
  channel,
  storage,
  platform = "web",
  shellBase = "/shell/",
  readBundled = null,
  now = () => Date.now(),
  log = () => {
  }
} = {}) {
  if (!channel || typeof channel.request != "function") throw new TypeError("createUiLoader needs a channel");
  if (!storage) throw new TypeError("createUiLoader needs a storage");
  async function fetchFile(path, max) {
    let res = await channel.request({ method: "GET", path, headers: { accept: "*/*" } }, null, { scope: "shell" });
    if (res.status !== 200)
      throw res.cancel?.(), new UiError("fetch", `${path}: the computer answered ${res.status}`);
    return readAll(res.body, max);
  }
  async function fetchManifest() {
    let bytes = await fetchFile(MANIFEST_PATH, MAX_MANIFEST_BYTES), value;
    try {
      value = JSON.parse(utf8Decode.decode(bytes));
    } catch {
      throw new UiError("manifest", "The computer sent a UI manifest that is not JSON.");
    }
    return checkManifest(value);
  }
  async function alreadyCurrent(prev, loadedHash, computerId = null) {
    let reload = shouldReload({ loadedHash, nextHash: prev.hash, reloadedFor: prev.reloadedFor ?? null }), owner = computerOf(computerId), moved = computerOf(prev.computerId) !== owner, record = prev;
    (reload || moved) && (record = { ...prev, computerId: owner, ...reload ? { reloadedFor: prev.hash } : {} }, await storage.writeActive(record));
    try {
      await storage.ensureActive?.(prev, { readBundled, shellBase });
    } catch (err) {
      log(`ui: ${err.code ?? "error"}`);
    }
    return { status: "current", hash: prev.hash, generation: prev.generation, changed: [], reload, record };
  }
  async function pull({ loadedHash = null, computerId = null } = {}) {
    if (platform === "ios") throw new UiError("refused", "iOS runs the bundled UI; desktop files are refused.");
    let next = await fetchManifest(), prev = await storage.readActive();
    if (prev && prev.hash === next.hash && prev.complete) return alreadyCurrent(prev, loadedHash, computerId);
    let cacheName = cacheNameFor(next), slot = await storage.openSlot(cacheName), previousSlot = prev && prev.cacheName !== cacheName ? await storage.openSlot(prev.cacheName) : null, diff = diffFiles(prev?.files ?? null, next, () => previousSlot !== null), changed = [];
    try {
      for (let entry of diff.changed) {
        let have = await slot.get(entry.path);
        if (have && have.size === entry.size && sha256Hex(have.bytes) === entry.sha256) continue;
        let bytes = await fetchFile(entry.path, MAX_FILE_BYTES);
        verifyBytes(bytes, entry), await slot.put(entry.path, bytes, entry), changed.push(entry.path);
      }
      for (let path of diff.reused) {
        let old = await previousSlot.get(path), entry = next.files.find((f) => f.path === path);
        if (old && old.bytes.byteLength === entry.size && sha256Hex(old.bytes) === entry.sha256)
          await slot.put(path, old.bytes, entry);
        else {
          let bytes = await fetchFile(path, MAX_FILE_BYTES);
          verifyBytes(bytes, entry), await slot.put(path, bytes, entry), changed.push(path);
        }
      }
      for (let file of await bundledShellFiles(readBundled))
        await slot.put(file.path, file.bytes, { type: contentTypeFor(fileNameFor(file.path)), sha256: sha256Hex(file.bytes), size: file.bytes.byteLength });
    } catch (err) {
      throw await storage.dropSlot(cacheName).catch(() => {
      }), log(`ui: ${err.code ?? "error"}`), err;
    }
    let reload = shouldReload({ loadedHash, nextHash: next.hash, reloadedFor: prev?.reloadedFor ?? null }), record = {
      hash: next.hash,
      generation: next.generation,
      desktopVersion: next.desktopVersion,
      cacheName,
      complete: !0,
      reloadedFor: reload ? next.hash : prev?.reloadedFor ?? null,
      files: next.files,
      pulledAt: now(),
      computerId: computerOf(computerId)
    };
    return await storage.writeActive(record), await storage.activate?.(record, { readBundled, shellBase }), await storage.dropSlotsExcept(cacheName), { status: "updated", hash: next.hash, generation: next.generation, changed, reload, record };
  }
  return {
    pull,
    // The HELLO's uiManifestHash decides whether anything needs fetching: equal hashes need no manifest request at all.
    async check({ helloHash = null, loadedHash = null, computerId = null } = {}) {
      if (platform === "ios") throw new UiError("refused", "iOS runs the bundled UI; desktop files are refused.");
      let prev = await storage.readActive();
      return prev && prev.complete && helloHash && prev.hash === helloHash ? alreadyCurrent(prev, loadedHash, computerId) : pull({ loadedHash, computerId });
    },
    current: () => storage.readActive()
  };
}

// mobile/shell/ui-host.js
var SHELL_QUERY = "shell", SHELL_PAGE_KEY = "plenum-shell-page", SHELL_BASE_KEY = "plenum-shell-base", SHELL_LINK_KEY = "plenum-shell-link", UI_ROOT = "plenum-ui", BUNDLED_UI_FOLDER = "ui", SW_WAIT_MS = 4e3, DATA = "DATA";
function causeOf(error) {
  let code = error?.code ?? "";
  return code === "worker" ? "worker" : code === "fetch" ? "not-sent" : code === "cancelled" || code === "closed" || code === "stopped" || code === "offline" ? "stopped" : "checksum";
}
function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return globalThis.btoa(text);
}
function fromBase64(text) {
  let bin = globalThis.atob(String(text)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var stripFileScheme = (uri) => String(uri ?? "").replace(/^file:\/\//, "").replace(/\/+$/, "");
function filesOver(filesystem) {
  return {
    async write(rel, bytes) {
      await filesystem.writeFile({ path: rel, data: toBase64(bytes), directory: DATA, recursive: !0 });
    },
    async read(rel) {
      try {
        let out = await filesystem.readFile({ path: rel, directory: DATA });
        return typeof out?.data == "string" ? fromBase64(out.data) : null;
      } catch {
        return null;
      }
    },
    async removeDir(rel) {
      try {
        await filesystem.rmdir({ path: rel, directory: DATA, recursive: !0 });
      } catch {
      }
    },
    async listDirs(rel) {
      try {
        return ((await filesystem.readdir({ path: rel, directory: DATA }))?.files ?? []).filter((f) => f.type === "directory" || f.type === void 0).map((f) => String(f.name ?? f));
      } catch {
        return [];
      }
    }
  };
}
function webViewOver({ webView, filesystem }) {
  let dataRoot = null, noted = null, root = async () => {
    if (dataRoot === null) {
      let out = await filesystem.getUri({ path: "", directory: DATA });
      dataRoot = stripFileScheme(out?.uri);
    }
    return dataRoot;
  }, absolute = async (rel) => `${await root()}/${String(rel).replace(/^\/+/, "")}`;
  return {
    async persistServerBasePath({ path }) {
      noted = path;
    },
    async setServerBasePath({ path }) {
      let target = await absolute(path ?? noted), set = webView.setServerBasePath({ path: target }), keep = webView.persistServerBasePath?.();
      await Promise.all([set, keep]);
    },
    async getServerBasePath() {
      let out = await webView.getServerBasePath(), abs = String(out?.path ?? ""), prefix = `${await root()}/`;
      return { path: abs.startsWith(prefix) ? abs.slice(prefix.length) : abs };
    }
  };
}
function bundledReader(fetchImpl, base) {
  return async (rel) => {
    let name = String(rel).replace(/^shell\//, "");
    try {
      let res = await fetchImpl(new URL(name, base).href, { cache: "no-store" });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}
function createUiHost({
  env,
  kind,
  native = null,
  channelOf,
  log = () => {
  },
  linkStore = null,
  // { put(text), take() }: where a link for the shell page waits on the apps (never web storage)
  stopHandoff = null,
  // B-120: { pending(), park(pending), unpark() }: a Stop still queued or sending here goes with the page to the shell page
  swWaitMs = SW_WAIT_MS,
  loaderFactory = createUiLoader,
  // the Node suites pass a fake loader
  setTimer = (fn, ms) => env.setTimeout(fn, ms),
  clearTimer = (id) => env.clearTimeout(id)
} = {}) {
  let location = () => env.location, session = () => {
    try {
      return env.sessionStorage ?? null;
    } catch {
      return null;
    }
  }, remember = (key, value) => {
    try {
      session()?.setItem(key, value);
    } catch {
    }
  }, recall = (key) => {
    try {
      return session()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }, durable = () => {
    try {
      return env.localStorage ?? null;
    } catch {
      return null;
    }
  }, rememberDurable = (key, value) => {
    try {
      durable()?.setItem(key, value);
    } catch {
    }
  }, recallDurable = (key) => {
    try {
      return durable()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }, isShellPage = (value) => typeof value == "string" && /^\/(?![/\\])[^#\s]*\?shell(?:&[^#\s]*)?$/.test(value);
  function androidStore() {
    if (!native?.Filesystem || !native?.WebView) throw new UiError("storage", "The app-data folder is not available.");
    return androidStorage({
      files: filesOver(native.Filesystem),
      webView: webViewOver({ webView: native.WebView, filesystem: native.Filesystem }),
      root: UI_ROOT
    });
  }
  function buildLoader() {
    let channel = channelOf();
    if (!channel) throw new UiError("offline", "The phone is not connected.");
    if (kind === "android") {
      let storage = androidStore(), base = location().href;
      return loaderFactory({ channel, storage, platform: "android", shellBase: "/shell/", readBundled: bundledReader(env.fetch.bind(env), base) });
    }
    if (!env.caches) throw new UiError("worker", "This browser cannot keep Plenum's screens.");
    return loaderFactory({ channel, storage: webStorage(env.caches), platform: "web", shellBase: "/shell/" });
  }
  async function workerControls() {
    let sw = env.navigator?.serviceWorker;
    if (!sw) return !1;
    if (sw.controller) return !0;
    try {
      await Promise.race([sw.ready, new Promise((_, reject) => setTimer(() => reject(new Error("timeout")), swWaitMs))]);
    } catch {
      return !!sw.controller;
    }
    return sw.controller ? !0 : new Promise((resolve) => {
      let timer = null, done = () => {
        timer !== null && clearTimer(timer), resolve(!!sw.controller);
      };
      sw.addEventListener?.("controllerchange", done, { once: !0 }), timer = setTimer(done, swWaitMs);
    });
  }
  function shellUrl() {
    for (let saved of [recall(SHELL_PAGE_KEY), recallDurable(SHELL_PAGE_KEY)])
      if (isShellPage(saved)) return saved;
    return `/?${SHELL_QUERY}`;
  }
  return {
    kind,
    // The shell page, before it leaves for the UI: remembers where its screens are.
    rememberShellPage() {
      let page = `${location().pathname}?${SHELL_QUERY}`;
      remember(SHELL_PAGE_KEY, page), rememberDurable(SHELL_PAGE_KEY, page);
    },
    // True when the page was opened for the shell's own screens (/?shell): it stays on them and does not go to the UI.
    staysOnShell() {
      return new URLSearchParams(String(location()?.search ?? "")).has(SHELL_QUERY);
    },
    // Pulls what the computer has and hands the page to the UI. Resolves { ok: true, status, navigated } or { ok: false, cause, code }.
    async show({ hello, computerId = null, loadedHash = null, onProgress = () => {
    } } = {}) {
      onProgress({ done: 0, total: 1 });
      try {
        if (kind === "lan")
          return this.rememberShellPage(), location().replace("/"), { ok: !0, status: "lan", navigated: !0 };
        if (kind === "ios") {
          let webView = native?.WebView;
          if (!webView?.getServerBasePath || !webView?.setServerBasePath) throw new UiError("storage", "The app cannot switch to its bundled screens.");
          let here = await webView.getServerBasePath(), base = String(here?.path ?? "").replace(/\/+$/, "");
          if (!base) throw new UiError("storage", "The bundled screens are not where the app expects them.");
          return remember(SHELL_BASE_KEY, base), await webView.setServerBasePath({ path: `${base}/${BUNDLED_UI_FOLDER}` }), { ok: !0, status: "bundled", navigated: !0 };
        }
        let result = await buildLoader().check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        if (onProgress({ done: 1, total: 1 }), kind === "android")
          return { ok: !0, status: result.status, navigated: !0, reload: result.reload };
        if (!await workerControls()) throw new UiError("worker", "No service worker controls this page.");
        return this.rememberShellPage(), location().replace("/"), { ok: !0, status: result.status, navigated: !0, reload: result.reload };
      } catch (error) {
        return log(`ui: ${error?.code ?? "error"}`), { ok: !1, cause: causeOf(error), code: error?.code ?? "error" };
      }
    },
    // On the UI page: asks whether the computer has a newer UI. { ok, changed, reload }. The page reloads once per new UI (the loader's
    // shouldReload keeps the count), and the caller does the reload.
    async refresh({ hello, loadedHash = null, computerId = null } = {}) {
      if (kind === "lan" || kind === "ios") return { ok: !0, changed: !1, reload: !1 };
      try {
        let result = await buildLoader().check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        return { ok: !0, changed: result.status === "updated", reload: result.reload === !0 };
      } catch (error) {
        return log(`ui: ${error?.code ?? "error"}`), { ok: !1, changed: !1, reload: !1, cause: causeOf(error) };
      }
    },
    // Which computer the UI on this page came from (one UI per computer): the active record's computerId on web and Android (null when it is not
    // known: no record, or one written before the id was kept), and 'any' where the page cannot tell and the computer serves it (the LAN page, the
    // iPhone's bundled copy).
    async uiComputerId() {
      if (kind === "lan" || kind === "ios") return "any";
      try {
        let storage = kind === "android" ? androidStore() : env.caches ? webStorage(env.caches) : null, record = storage ? await storage.readActive() : null;
        return typeof record?.computerId == "string" && record.computerId ? record.computerId : null;
      } catch {
        return null;
      }
    },
    // The hash of the UI the cache serves now, or null.
    async loadedHash() {
      if (kind !== "web" || !env.caches) return null;
      try {
        let record = await webStorage(env.caches).readActive();
        return record?.complete === !0 ? record.hash : null;
      } catch {
        return null;
      }
    },
    // Whether a complete copy of the UI is on the phone, for "Use the copy in this app".
    async hasCopy() {
      return kind === "ios" ? !0 : kind === "lan" ? !1 : await this.loadedHash() !== null;
    },
    // Uses the copy that is already on the phone, without asking the computer.
    async useCopy() {
      return kind === "ios" ? this.show({}) : kind === "web" && await this.loadedHash() !== null && await workerControls() ? (this.rememberShellPage(), location().replace("/"), { ok: !0, status: "copy", navigated: !0 }) : { ok: !1, cause: "worker", code: "worker" };
    },
    // From the UI page back to the shell's screens. link (a pairing link, #settings, #computers, #connect=<id>) rides along: in the address on web
    // and LAN pages (the '#...' part only), in the linkStore for the apps (the shell page takes it out once, within two minutes).
    //
    // B-120: a Stop that is still queued or sending lives in this page's channel worker, which ends with the page. It is left in the store
    // (the shell page sends it, if it is under a minute old) before the page goes. Only the page that is leaving does this, and it takes
    // the note back when the page does not go.
    async openShell(link = "") {
      let text = typeof link == "string" ? link : "", parked = !1;
      try {
        let pending = stopHandoff?.pending?.() ?? null;
        pending && (await stopHandoff.park(pending), parked = !0);
      } catch {
        parked = !1;
      }
      let unpark = async () => {
        if (parked)
          try {
            await stopHandoff.unpark();
          } catch {
          }
      };
      if (kind === "web" || kind === "lan")
        return location().assign(`${shellUrl()}${text.startsWith("#") ? text : ""}`), !0;
      let webView = native?.WebView;
      if (!webView)
        return await unpark(), !1;
      let base = kind === "android" ? null : recall(SHELL_BASE_KEY), switchPage = kind === "android" ? webView.setServerAssetPath ? () => webView.setServerAssetPath({ path: "public" }) : null : base && webView.setServerBasePath ? () => webView.setServerBasePath({ path: base }) : null;
      if (!switchPage)
        return await unpark(), !1;
      text && await linkStore?.put(text);
      try {
        await switchPage();
      } catch (error) {
        if (text)
          try {
            await linkStore?.take();
          } catch {
          }
        throw await unpark(), error;
      }
      return !0;
    }
  };
}

// mobile/shell/screens/demo.js
var RUN_STATES = Object.freeze(["running", "finished", "failed", "stopped"]);
function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
function pictureSrc(svg) {
  let text = String(svg ?? "");
  return !/^\s*<svg[\s>]/.test(text) || /<script/i.test(text) ? null : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}
function createReplay(session) {
  let original = cloneDeep(session) ?? {}, state = cloneDeep(original);
  Array.isArray(state.runs) || (state.runs = []), Array.isArray(state.approvals) || (state.approvals = []), Array.isArray(state.agents) || (state.agents = []), Array.isArray(state.artifacts) || (state.artifacts = []);
  let stoppedCount = 0, view = () => ({
    computer: { name: String(state.computer?.name ?? "Demo computer"), desktopVersion: String(state.computer?.desktopVersion ?? "") },
    projects: cloneDeep(state.projects ?? []),
    runs: state.runs.map((r) => ({ ...r, state: RUN_STATES.includes(r.state) ? r.state : "finished" })),
    approvals: state.approvals.map((a) => ({ ...a })),
    agents: state.agents.map((a) => ({ ...a })),
    drive: state.computerRun ? { ...state.computerRun, frames: (state.computerRun.frames ?? []).map((f) => ({ caption: String(f.caption ?? ""), src: pictureSrc(f.svg) })) } : null,
    diff: state.diff ? cloneDeep(state.diff) : null,
    artifacts: state.artifacts.map((a) => ({ id: a.id, name: a.name, caption: a.caption ?? "", src: pictureSrc(a.svg) })),
    stoppedCount
  });
  function decide(id, decision) {
    let card = state.approvals.find((a) => a.id === id);
    if (!card) return { ok: !1, reason: "unknown" };
    if (card.state !== "waiting") return { ok: !1, reason: "not-waiting" };
    if (decision !== "approve" && decision !== "deny") return { ok: !1, reason: "decision" };
    card.state = decision === "approve" ? "approved" : "denied";
    let run = state.runs.find((r) => r.id === card.runId);
    return run && run.waitingFor === "approval" && (delete run.waitingFor, decision === "deny" && (run.state = "finished")), { ok: !0, reason: null };
  }
  function stop() {
    let runs = state.runs.filter((r) => r.state === "running").length, drives = state.computerRun && state.computerRun.state === "driving" ? 1 : 0, agents = state.agents.filter((a) => a.state === "running").length, cards = state.approvals.filter((a) => a.state === "waiting").length;
    for (let r of state.runs) r.state === "running" && (r.state = "stopped", delete r.waitingFor);
    for (let a of state.agents) a.state === "running" && (a.state = "stopped");
    state.computerRun && state.computerRun.state === "driving" && (state.computerRun.state = "stopped");
    for (let a of state.approvals) a.state === "waiting" && (a.state = "denied");
    stoppedCount += 1;
    let ack = { id: `demo-stop-${stoppedCount}`, cancelled: runs, drivesStopped: drives, agentsStopped: agents, cardsDenied: cards };
    return { ok: !0, ack, text: stopResultText(ack, String(state.computer?.name ?? "Demo computer")) };
  }
  function reset() {
    return state = cloneDeep(original), Array.isArray(state.runs) || (state.runs = []), Array.isArray(state.approvals) || (state.approvals = []), Array.isArray(state.agents) || (state.agents = []), Array.isArray(state.artifacts) || (state.artifacts = []), stoppedCount = 0, view();
  }
  return { view, decide, stop, reset };
}

// mobile/shell/screens/settings.js
var LOCK_AFTER = Object.freeze([
  Object.freeze({ id: "immediately", ms: 0, label: "Immediately" }),
  Object.freeze({ id: "m1", ms: 6e4, label: "1 minute" }),
  Object.freeze({ id: "m5", ms: 3e5, label: "5 minutes" }),
  Object.freeze({ id: "m15", ms: 9e5, label: "15 minutes" }),
  Object.freeze({ id: "h1", ms: 36e5, label: "1 hour" })
]), DEFAULT_LOCK_AFTER = "m5";
function lockAfter(id) {
  return LOCK_AFTER.find((o) => o.id === id) ?? LOCK_AFTER.find((o) => o.id === DEFAULT_LOCK_AFTER);
}
var WAY_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
function moveWay(order, kind, dir) {
  let list = Array.isArray(order) ? [...order] : [], i = list.indexOf(kind), j = i + (dir === "up" ? -1 : 1);
  return i < 0 || j < 0 || j >= list.length || ([list[i], list[j]] = [list[j], list[i]]), list;
}
function orderedWays(stored) {
  let seen = [];
  for (let kind of Array.isArray(stored) ? stored : [])
    WAY_KINDS.includes(kind) && !seen.includes(kind) && seen.push(kind);
  for (let kind of WAY_KINDS) seen.includes(kind) || seen.push(kind);
  return seen;
}
var APPROVE_MISSING_TEXT = Object.freeze({
  "first-line": 'Turn on "Include the first line" first.',
  "app-lock": "Turn on the app lock first. On the web app that means a PIN or a passkey."
});
var TEXT_MIN = 85, TEXT_MAX = 200, TEXT_STEP = 5, TEXT_DEFAULT = 100;
function clampText(value) {
  let n = Math.round((Number(value) || TEXT_DEFAULT) / TEXT_STEP) * TEXT_STEP;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, n));
}
var THEMES = Object.freeze(["follow", "dark", "light"]), THEME_LABEL = Object.freeze({ follow: "Follow phone", dark: "Dark", light: "Light" });
function normaliseTheme(value) {
  return THEMES.includes(value) ? value : "follow";
}
function normaliseStopSide(value) {
  return value === "left" ? "left" : "right";
}
var PUSH_SWITCHES = Object.freeze([
  Object.freeze({ key: "approvals", label: "Approvals and your turn" }),
  Object.freeze({ key: "finished", label: "Finished and failed runs" }),
  Object.freeze({ key: "limits", label: "Spend and plan limits" }),
  Object.freeze({ key: "onlyWhenAway", label: "Only when I am away from {computer}" }),
  Object.freeze({ key: "firstLine", label: "Include the first line" })
]), PUSH_DEFAULTS = Object.freeze({ approvals: !0, finished: !0, limits: !0, onlyWhenAway: !0, firstLine: !1 });
function pushValues(known) {
  let out = { ...PUSH_DEFAULTS };
  for (let { key } of PUSH_SWITCHES)
    typeof known?.[key] == "boolean" && (out[key] = known[key]);
  return out;
}
function normalisePrefs(raw) {
  let p = raw && typeof raw == "object" ? raw : {};
  return {
    theme: normaliseTheme(p.theme),
    textSize: p.textSize == null ? null : clampText(p.textSize),
    stopSide: normaliseStopSide(p.stopSide),
    haptics: p.haptics !== !1,
    hideSwitcher: p.hideSwitcher !== !1,
    lockAfter: lockAfter(p.lockAfter).id,
    dictationOnDevice: p.dictationOnDevice !== !1,
    dictationAllowService: p.dictationAllowService !== !1,
    lanDismissed: p.lanDismissed === !0
  };
}

// mobile/shell/demo/session.json
var session_default = {
  format: "plenum-demo-session",
  version: 1,
  note: "A recorded session for the store review and the offline demo (MOBILE-UI 6.18). Nothing here reaches a computer. Names are examples.",
  computer: { name: "Demo computer", desktopVersion: "1.4.2", carrier: "lan" },
  projects: [{ id: "my-app", name: "my-app" }],
  runs: [
    { id: "run-1", project: "my-app", title: "Fix the login redirect", state: "running", since: "14:02", waitingFor: "approval" },
    { id: "run-2", project: "my-app", title: "Add a test for the retry queue", state: "finished", since: "13:10", summary: "Finished: Add a test for the retry queue" }
  ],
  approvals: [
    {
      id: "ap-1",
      runId: "run-1",
      project: "my-app",
      kind: "command",
      firstLine: "npm test -- --watch=false",
      detail: "Runs in my-app. Changes nothing outside the folder.",
      defaultDeny: !1,
      state: "waiting"
    }
  ],
  agents: [{ id: "agent-1", name: "Reviewer", runId: "run-1", state: "running" }],
  computerRun: {
    id: "cr-1",
    runId: "run-1",
    app: "Notepad",
    step: 12,
    of: 80,
    state: "driving",
    frames: [
      { caption: "Step 11. Notepad is open.", svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'><rect width='360' height='220' fill='#f4f4f8'/><rect x='12' y='12' width='336' height='24' fill='#d9dbe6'/><text x='20' y='29' font-family='sans-serif' font-size='13' fill='#222'>Notepad</text><rect x='20' y='50' width='320' height='150' fill='#ffffff' stroke='#c8cad6'/><text x='30' y='74' font-family='monospace' font-size='12' fill='#222'>def login(next):</text><text x='30' y='92' font-family='monospace' font-size='12' fill='#222'>  return redirect(next)</text></svg>" },
      { caption: "Step 12. The cursor is on the redirect line.", svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'><rect width='360' height='220' fill='#f4f4f8'/><rect x='12' y='12' width='336' height='24' fill='#d9dbe6'/><text x='20' y='29' font-family='sans-serif' font-size='13' fill='#222'>Notepad</text><rect x='20' y='50' width='320' height='150' fill='#ffffff' stroke='#c8cad6'/><text x='30' y='74' font-family='monospace' font-size='12' fill='#222'>def login(next):</text><text x='30' y='92' font-family='monospace' font-size='12' fill='#1f6feb'>  return redirect(safe(next))</text><rect x='30' y='100' width='120' height='2' fill='#1f6feb'/></svg>" }
    ]
  },
  diff: {
    id: "diff-1",
    runId: "run-1",
    file: "src/login.js",
    added: 2,
    removed: 1,
    hunks: [
      {
        header: "@@ -12,3 +12,4 @@",
        lines: [
          { t: " ", s: "export function login(req) {" },
          { t: "-", s: "  return redirect(req.query.next);" },
          { t: "+", s: "  const next = safeNext(req.query.next);" },
          { t: "+", s: "  return redirect(next);" },
          { t: " ", s: "}" }
        ]
      }
    ]
  },
  artifacts: [
    {
      id: "art-1",
      name: "login-flow.svg",
      caption: "The login flow after the fix.",
      svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 160'><rect width='360' height='160' fill='#f4f4f8'/><rect x='20' y='56' width='90' height='40' rx='6' fill='#dfe3f0' stroke='#6b72a6'/><text x='32' y='80' font-family='sans-serif' font-size='13' fill='#222'>Sign in</text><rect x='135' y='56' width='90' height='40' rx='6' fill='#dfe3f0' stroke='#6b72a6'/><text x='147' y='80' font-family='sans-serif' font-size='13' fill='#222'>Check</text><rect x='250' y='56' width='90' height='40' rx='6' fill='#dfe3f0' stroke='#6b72a6'/><text x='262' y='80' font-family='sans-serif' font-size='13' fill='#222'>Return</text><line x1='110' y1='76' x2='135' y2='76' stroke='#6b72a6' stroke-width='2'/><line x1='225' y1='76' x2='250' y2='76' stroke='#6b72a6' stroke-width='2'/></svg>"
    }
  ]
};

// mobile/shell/app.js
var APP_VERSION = "0.6.0", LINK_VERSION = "1.0", DEV_BUILD = !1, pageStarted = !1, PAGE_STARTED_KEY = "__plenumPageStarted";
function takePageStart() {
  if (pageStarted || Object.getOwnPropertyDescriptor(globalThis, PAGE_STARTED_KEY) !== void 0) return !1;
  pageStarted = !0;
  try {
    Object.defineProperty(globalThis, PAGE_STARTED_KEY, { value: !0 });
  } catch {
  }
  return !0;
}
var attachShim = (() => {
  let f = globalThis.__plenumAttachShell;
  try {
    delete globalThis.__plenumAttachShell;
  } catch {
  }
  return typeof f == "function" ? f : null;
})(), giveShellCore = () => {
};
if (typeof document < "u" && document.documentElement?.hasAttribute?.("data-shell-page") && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  let handed = new Promise((resolve) => {
    giveShellCore = resolve;
  });
  Object.defineProperty(globalThis, "__plenumTakeShellCore", {
    configurable: !0,
    enumerable: !1,
    value: () => {
      try {
        delete globalThis.__plenumTakeShellCore;
      } catch {
      }
      return handed;
    }
  });
}
var ACTIVE_META = "active", PREFS_META = "prefs", DEMO_COMPUTER = Object.freeze({ id: "demo", name: "Demo computer", carriers: [], lastCarrier: null, lastSeen: null, pairedAt: null, counter: 0 }), utf83 = new TextEncoder(), utf8Read = new TextDecoder(), STOP_RETRY_MS = 60 * 1e3, APPROVE_META = "approve", STOP_NOTICE = /* @__PURE__ */ new Set(["done", "queued", "failed"]), APPROVE_OFF_META = "approve-off-pending", UP_PENDING_META = "up-pending", STOP_META = "pending-stop", LINK_META = "shell-link", LINK_TTL_MS = 120 * 1e3, NOTIFICATION_LINK_MAX_AGE_MS = 60 * 1e3, NOTIFICATION_OLD = "That notification is more than a minute old. Open the approval to answer it.", OPEN_SHELL_HASHES = Object.freeze(["", "#settings", "#computers"]), FACADE_PLUGINS = Object.freeze(["App", "TextZoom", "Haptics", "Dictation", "IsolatedPreview", "Browser", "Share", "Filesystem"]);
var SW_REGISTRATION_WAIT_MS = 3e3, CARD_CHANGED = "That card changed. Open it to answer.", RECORD_ID = /^[0-9a-f]{64}$/, UNKNOWN_COMPUTER = "That computer is not paired on this phone. Answer it at that computer.", UNKNOWN_COMPUTER_STOP = "That computer is not paired on this phone. Press Stop at that computer.", STOP_NO_KEY = "This phone cannot read its Stop key, so it cannot send Stop from here. Press Stop on your computer.";
function modeFor(search, devBuild = DEV_BUILD) {
  let params = new URLSearchParams(String(search ?? ""));
  return devBuild === !0 && params.has("selftest") ? "selftest" : params.has("demo") ? "demo" : "normal";
}
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value == "object") {
    let out = {};
    for (let [key, item] of Object.entries(value)) item !== void 0 && (out[key] = frozenCopy(item));
    return Object.freeze(out);
  }
  return value;
}
function safeState(state) {
  let s = state ?? {}, hello = s.hello;
  return frozenCopy({
    page: s.page,
    locked: s.locked === !0,
    lock: { mode: s.lock?.mode, locked: s.lock?.locked, failures: s.lock?.failures, waitSec: s.lock?.waitSec },
    lockStop: { ready: s.lockStop?.ready === !0, computerName: String(s.lockStop?.computerName ?? "") },
    connection: { status: s.connection?.status, carrier: s.connection?.carrier, desktopName: s.connection?.desktopName, lastSeen: s.connection?.lastSeen },
    hello: hello ? { desktopName: hello.desktopName, desktopVersion: hello.desktopVersion, deviceId: hello.deviceId, tier: hello.tier, pending: hello.pending } : null,
    stop: { state: s.stop?.state, text: s.stop?.text, seq: s.stop?.seq, ack: s.stop?.ack },
    activeId: s.activeId ?? null,
    computers: (Array.isArray(s.computers) ? s.computers : []).map((c) => ({ id: c.id, name: c.name })),
    notice: s.notice ?? null,
    prefs: {
      theme: s.prefs?.theme,
      textSize: s.prefs?.textSize,
      stopSide: s.prefs?.stopSide,
      dictationAllowService: s.prefs?.dictationAllowService,
      dictationOnDevice: s.prefs?.dictationOnDevice
    },
    intent: s.intent ?? null,
    device: { platform: s.device?.platform, app: s.device?.app, appVersion: s.device?.appVersion, protocol: s.device?.protocol }
  });
}
function makeFacade(shell, plugins) {
  return Object.freeze({
    state: () => safeState(shell.state()),
    subscribe: (fn) => shell.subscribe((state) => fn(safeState(state))),
    request: (spec, body = null, opts = {}) => {
      let channel = shell.channel;
      return channel ? channel.request(spec, body, { signal: opts?.signal ?? null, scope: "page" }) : Promise.reject(Object.assign(new Error("offline"), { code: "offline" }));
    },
    stop: (project) => shell.stop(project ?? null),
    lock: () => shell.lockNow(),
    unlock: (method, pin = null) => shell.unlock(method, pin),
    connect: (id) => shell.connect(id),
    openShell: (hash) => OPEN_SHELL_HASHES.includes(hash) ? shell.openShell(hash) : Promise.resolve(!1),
    takeRoute: () => shell.takeRoute(),
    log: (line) => shell.pageLog(line),
    plugin: (name) => FACADE_PLUGINS.includes(name) ? plugins?.[name] ?? null : null
  });
}
function createLinkStore(meta, now = () => Date.now()) {
  return {
    async put(text) {
      await meta.put(LINK_META, { text: String(text).slice(0, 8192), at: now() });
    },
    async take() {
      let kept = null;
      try {
        kept = await meta.get(LINK_META), kept != null && await meta.remove(LINK_META);
      } catch {
        return null;
      }
      return kept && typeof kept.text == "string" && typeof kept.at == "number" && now() - kept.at < LINK_TTL_MS ? kept.text : null;
    }
  };
}
function createParkedStop(meta, now = () => Date.now()) {
  return {
    async put(pending) {
      await meta.put(STOP_META, { at: Number(pending?.at) || now(), computer: String(pending?.computer ?? "").slice(0, 80) });
    },
    async unpark() {
      await meta.remove(STOP_META);
    },
    async take() {
      let kept = null;
      try {
        kept = await meta.get(STOP_META), kept != null && await meta.remove(STOP_META);
      } catch {
        return null;
      }
      let age = kept && typeof kept.at == "number" ? now() - kept.at : 1 / 0;
      return age >= 0 && age < STOP_RETRY_MS ? { at: kept.at, computer: typeof kept.computer == "string" ? kept.computer : "" } : null;
    }
  };
}
function cleanName(name) {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, 60).trim();
}
function clearAddressHash(env = globalThis) {
  try {
    let loc = env.location;
    if (!loc || !env.history?.replaceState) return;
    env.history.replaceState(null, "", `${loc.pathname}${loc.search}`);
  } catch {
  }
}
function deviceFor(env = globalThis) {
  let native = isNative(env), kind = appKindFor(env);
  return {
    device: { name: kind.name, platform: platformFor(env), app: kind.app, appVersion: APP_VERSION, uiHash: "" },
    caps: capsFor(env),
    native
  };
}
function demoHello(replayView) {
  let drive = replayView?.drive && replayView.drive.state === "driving" ? replayView.drive : null, waiting = (replayView?.approvals ?? []).filter((a) => a.state === "waiting").length, running = (replayView?.runs ?? []).filter((r) => r.state === "running").length;
  return {
    desktopName: replayView?.computer?.name ?? "Demo computer",
    desktopVersion: replayView?.computer?.desktopVersion || "1.4.2",
    protocol: LINK_VERSION,
    deviceId: "demo",
    tier: "full",
    caps: ["demo"],
    pending: {
      approvals: waiting,
      runs: running,
      driving: drive ? { app: drive.app, step: drive.step, of: drive.of } : null
    },
    minShell: null
  };
}
async function readText(body, cap = 64 * 1024) {
  if (!body || typeof body.getReader != "function") return "";
  let reader = body.getReader(), chunks = [], total = 0;
  for (; ; ) {
    let { value, done } = await reader.read();
    if (done) break;
    if (total += value.byteLength, total > cap) {
      reader.cancel?.().catch?.(() => {
      });
      break;
    }
    chunks.push(value);
  }
  let all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0)), at = 0;
  for (let c of chunks)
    all.set(c, at), at += c.byteLength;
  return utf8Read.decode(all);
}
async function registrationOf(serviceWorker, { wait = SW_REGISTRATION_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!serviceWorker) return null;
  try {
    let found = await serviceWorker.getRegistration?.();
    if (found) return found;
  } catch {
  }
  if (!serviceWorker.ready) return null;
  let timer = null, gave = new Promise((resolve) => {
    timer = setTimer(() => resolve(null), wait);
  });
  try {
    return await Promise.race([Promise.resolve(serviceWorker.ready).catch(() => null), gave]);
  } finally {
    clearTimer(timer);
  }
}
async function registerServiceWorker(env = globalThis) {
  let sw = env.navigator?.serviceWorker;
  if (!sw || typeof sw.register != "function" || isNative(env) || env.isSecureContext !== !0 || isLanPage(env)) return null;
  try {
    return await sw.register(new URL("sw.js", String(env.location?.href ?? "https://localhost/")).href, { scope: "/" }) ?? null;
  } catch {
    return null;
  }
}
var NO_SECURE_STORAGE = Object.freeze({
  async getItem() {
    throw new Error("secure storage is not available");
  },
  async setItem() {
    throw new Error("secure storage is not available");
  },
  async removeItem() {
    throw new Error("secure storage is not available");
  },
  async keys() {
    throw new Error("secure storage is not available");
  }
});
function createShell({
  store,
  lock = null,
  createWorker = defaultCreateWorker,
  device = { name: "Test phone", platform: "web", app: "pwa", appVersion: "0.0.0", uiHash: "" },
  caps = ["ui-from-desktop"],
  pageUrl = null,
  mode = "normal",
  debug = createDebugLog(),
  selftestFn = null,
  // the dev build loads ./selftest.js on first use; a release bundle never imports it
  stopClock = globalThis,
  onFatal = () => {
  },
  notifications = globalThis.Notification ?? null,
  serviceWorker = null,
  pushEnv = globalThis,
  clearHash = () => {
  },
  native = null,
  uiHost = null,
  pageKind = "shell",
  stay = !1,
  initialIntent = null,
  initialLink = null,
  onIntent = () => {
  },
  onReload = () => {
  },
  devBuild = DEV_BUILD,
  storage = "ok",
  parkedStop = null
} = {}) {
  if (!store) throw new TypeError("createShell needs a store");
  let computers = [], activeId = null, channel = null, channelState = { status: "idle", carrier: null, desktopName: "", lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null }, hello = null, stopCtl = null, stopView = { state: "idle", ack: null, error: null, text: "", seq: 0 }, notice = null, noticeSeq = 0, stopSeq = 0, pendingLink = null, pendingPair = null, forceUi = !1, screenRequest = null, screenSeq = 0, pairing = null, pairingFlow = null, lockStatus = { mode: "off", locked: !1, failures: 0, waitSec: 0 }, lockStop = { ready: !1, computerName: "" }, lockedCtl = null, lockedFor = null, selftest = null, booted = !1, lockKnown = () => {
  }, lockRead = new Promise((resolve) => {
    lockKnown = resolve;
  }), lockUnreadable = !1, loaded = !1, started = !1, prefs = normalisePrefs(null), pushKnown = null, approveStored = !1, hiddenAt = null, pairedSeq = 0, pairedId = null, ui = { state: "idle", cause: null, progress: null, hasCopy: !1 }, loadedUiHash, refreshingUi = !1, holdUi = !1, leaving = !1, intent = initialIntent && typeof initialIntent == "object" ? { ...initialIntent, seq: 1, taken: !1 } : null, intentSeq = intent ? 1 : 0, dictationState = null, androidPushState = null, replay = mode === "demo" ? createReplay(session_default) : null, unlockedKeys = /* @__PURE__ */ new Map(), subs = /* @__PURE__ */ new Set(), wall = () => typeof stopClock?.now == "function" ? stopClock.now() : Date.now(), parked = parkedStop ?? createParkedStop(store.meta, wall), stopPressedAt = null, stopComputer = "";
  function notePress(id) {
    stopView.state === "sending" || stopView.state === "queued" || (stopPressedAt = wall(), stopComputer = id ?? "");
  }
  let androidPush = native && device.platform === "android" && native.UnifiedPush ? createAndroidPush({
    native,
    requestOf: () => channel?.request,
    vapidOf: () => typeof hello?.vapidPublicKey == "string" ? hello.vapidPublicKey : null,
    isVisible: () => pushEnv?.document?.visibilityState !== "hidden",
    onLink: (link, computer) => {
      api.handleHash(link, computer).catch(() => {
      });
    },
    pendingStore: {
      load: () => store.meta.get(UP_PENDING_META),
      save: (body) => store.meta.put(UP_PENDING_META, body),
      clear: () => store.meta.remove(UP_PENDING_META)
    },
    log: (line) => debug.log(line, "warn")
  }) : null, view = () => ({
    mode,
    route: route(),
    page: pageKind,
    stay,
    locked: lockStatus.locked,
    lock: { ...lockStatus },
    computers: computers.map((c) => ({ ...c })),
    activeId,
    connection: { ...channelState },
    hello: hello ? publicHello(hello) : null,
    stop: { ...stopView },
    lockStop: { ...lockStop },
    storage: storage === "unavailable" ? "unavailable" : "ok",
    pairing: pairing ? { ...pairing, ...pairing.review ? { review: { name: pairing.review.name, hosts: pairing.review.hosts.map((h) => ({ ...h })) } } : {} } : null,
    selftest,
    debugLines: debug.lines().length,
    prefs: { ...prefs },
    pushKnown: pushKnown ? { ...pushKnown } : null,
    approveStored,
    device: { appVersion: APP_VERSION, protocol: LINK_VERSION, platform: device.platform, app: device.app },
    demo: replay ? replay.view() : null,
    paired: { seq: pairedSeq, id: pairedId },
    notice: notice ? { ...notice } : null,
    ui: { ...ui, kind: uiHost?.kind ?? null },
    intent: intent ? { ...intent } : null,
    screenRequest: screenRequest ? { ...screenRequest } : null,
    dictation: dictationState ? { ...dictationState } : null,
    androidPush: androidPushState ? { ...androidPushState } : null
  }), snapshot = view(), refresh = () => {
    replay && (hello = demoHello(replay.view())), snapshot = view();
    for (let fn of Array.from(subs))
      try {
        fn(snapshot);
      } catch {
      }
    return leaveForShellIfNeeded(), snapshot;
  };
  function say(text, tone = "info") {
    noticeSeq += 1, notice = { seq: noticeSeq, text: String(text ?? ""), tone };
  }
  function route() {
    return mode === "demo" ? "demo" : lockStatus.locked ? "locked" : pairing && !["allowed", "denied", "expired", "mismatch", "failed"].includes(pairing.state) ? "code" : mode === "selftest" ? "selftest" : computers.length ? computers.length > 1 && !channel ? "computers" : channel ? "connected" : "computers" : "welcome";
  }
  function publicHello(h) {
    return {
      desktopName: String(h.desktopName ?? ""),
      desktopVersion: String(h.desktopVersion ?? ""),
      protocol: h.protocol ?? null,
      deviceId: typeof h.deviceId == "string" ? h.deviceId : "",
      tier: h.tier ?? null,
      caps: Array.isArray(h.caps) ? [...h.caps] : [],
      pending: h.pending ?? null,
      minShell: h.minShell ?? null
    };
  }
  async function loadComputers() {
    computers = (await store.publicList()).map((c) => ({ ...c })), await refreshLockStop();
  }
  async function lockStopTarget() {
    let id = activeId;
    id || (id = await store.meta.get(ACTIVE_META).catch(() => null));
    let record = id ? await store.get(id) : null;
    if (!record) {
      let list = await store.publicList();
      list.length === 1 && (record = await store.get(list[0].id));
    }
    return record ?? null;
  }
  async function refreshLockStop() {
    let next = { ready: !1, computerName: "" };
    try {
      let target = await lockStopTarget();
      target && (next = { ready: publicComputer(target)?.stopReady === !0, computerName: String(target.name ?? "") });
    } catch {
    }
    lockStop = next;
  }
  function keyedRecord(record) {
    if (typeof record.myPriv == "string") return record;
    let key = unlockedKeys.get(record.id);
    return key ? { ...record, myPriv: bytesToB64u(key) } : null;
  }
  function applyStopView(v) {
    let changed = v.state !== stopView.state, seq = changed && STOP_NOTICE.has(v.state) ? ++stopSeq : stopView.seq;
    stopView = { ...v, seq }, changed && v.state === "done" && say(v.text, "ok"), changed && v.state === "queued" && say(v.text, "warn"), refresh();
  }
  let stopOwner = null;
  function bindStop(ch, name) {
    let busy = stopCtl?.state === "sending" || stopCtl?.state === "queued";
    busy || stopCtl?.dispose();
    let ctl = createStopController({ channel: ch, clock: stopClock, computerName: name });
    stopCtl = ctl;
    let first = !0;
    ctl.subscribe((view2) => {
      first && (first = !1, busy) || stopCtl !== ctl && view2.state !== "done" && view2.state !== "failed" && !(view2.state === "idle" && stopOwner === ctl) || ((view2.state === "done" || view2.state === "failed") && (stopOwner = ctl), applyStopView(view2));
    });
  }
  async function lockedStop(project, computerId = "") {
    if (lockedCtl && (stopView.state === "sending" || stopView.state === "queued") && (!computerId || computerId === lockedFor)) return lockedCtl.press(project);
    let target = computerId ? await store.get(computerId).catch(() => null) : await lockStopTarget().catch(() => null);
    if (computerId && !target)
      return say(UNKNOWN_COMPUTER_STOP, "warn"), refresh(), { ...stopView, state: "idle", reason: "unknown-computer" };
    if (!target || publicComputer(target)?.stopReady !== !0)
      return lockUnreadable ? (say(STOP_NO_KEY, "warn"), refresh(), { ...stopView, state: "idle", reason: "no-key" }) : (say(STOP_NEEDS_UNLOCK, "warn"), pendingLink = { text: "#stop", at: wall(), ...computerId ? { computer: computerId } : {} }, refresh(), { ...stopView, state: "idle", reason: "needs-unlock" });
    lockedFor = target.id;
    let listeners = /* @__PURE__ */ new Set(), viaLockedWorker = {
      stop: () => sendLockedStop({ record: target, store, createWorker, onStopState: (view2) => {
        for (let fn of Array.from(listeners)) fn(view2);
      } }),
      onStopState: (fn) => (listeners.add(fn), () => listeners.delete(fn))
    };
    lockedCtl?.dispose(), lockedCtl = createStopController({ channel: viaLockedWorker, clock: stopClock, computerName: String(target.name ?? "") }), lockedCtl.subscribe(applyStopView), notePress(target.id);
    let out = await lockedCtl.press(project);
    return refresh(), out;
  }
  async function openComputerFor(id, link) {
    if (pageKind === "ui" && uiHost) {
      let uiFor = await uiComputerOf();
      if (uiFor !== "any" && uiFor !== id) {
        leaving = !0;
        let done = await uiHost.openShell(link).catch(() => !1);
        return done || (leaving = !1), done ? { ok: !0, reason: null, opening: !0 } : { ok: !1, reason: "unavailable" };
      }
    }
    let opened = await connectNow(id);
    return refresh(), opened;
  }
  async function stopOn(id, project = null) {
    let record = await store.get(id).catch(() => null);
    if (!record)
      return say(UNKNOWN_COMPUTER_STOP, "warn"), refresh(), { ...stopView, state: "idle", reason: "unknown-computer" };
    if (publicComputer(record)?.stopReady === !0) return lockedStop(project, id);
    let opened = await openComputerFor(id, `#stop&computer=${id}`);
    return opened.opening ? { ...stopView, state: "idle", reason: "opening" } : opened.ok ? api.stop(project) : (say("Could not open that computer to stop it. Press Stop on that computer.", "warn"), refresh(), { ...stopView, state: "idle", reason: opened.reason ?? "failed" });
  }
  function attachChannel(ch, name) {
    channel = ch, bindStop(ch, name);
    let live = () => channel === ch;
    ch.onState((s) => {
      live() && (channelState = { ...s }, s.status !== "connected" && (hello = null), refresh());
    }), ch.onEvent((event) => {
      live() && (event && event.type === "phone" && event.kind === "revoked" && refresh(), event && event.type === "phone" && event.kind === "tier" && hello && typeof event.tier == "string" && (!hello.deviceId || event.id === hello.deviceId) && (hello = { ...hello, tier: event.tier, ...Array.isArray(event.caps) ? { caps: event.caps.filter((c) => typeof c == "string") } : {} }, refresh()));
    }), ch.onHello((h) => {
      live() && (hello = h, refresh(), loadPush(), retryApproveOff(), (Array.isArray(h?.carriers) ? loadComputers() : refreshLockStop()).then(refresh).catch(() => {
      }), androidPush?.resend().then(async () => {
        androidPushState = await androidPush.state(), refresh();
      }).catch(() => {
      }), afterHello());
    }), refresh();
  }
  function retireChannel(ch) {
    if (ch) {
      if (stopView.state === "queued" || stopView.state === "sending") {
        stopClock.setTimeout(() => ch.close(), STOP_RETRY_MS + 1e3);
        return;
      }
      ch.close();
    }
  }
  async function loadPush() {
    if (replay || !channel) return;
    let out = await postJson("/api/phones/push", {});
    out.ok && out.json?.push && typeof out.json.push == "object" && (pushKnown = { ...out.json.push }, refresh());
  }
  async function keepApprove(on) {
    approveStored = on === !0, replay || await store.meta.put(APPROVE_META, approveStored).catch(() => {
    });
  }
  async function runPendingLink() {
    let link = pendingLink;
    if (!link) return null;
    let parsed = parseNotificationHash(link.text);
    return lockStatus.locked || lockUnreadable ? parsed?.kind !== "stop" ? null : (pendingLink = null, api.stop(null, link.computer ?? parsed.computer ?? "")) : (pendingLink = null, (parsed?.kind === "approve" || parsed?.kind === "deny") && wall() - link.at > NOTIFICATION_LINK_MAX_AGE_MS ? (say(NOTIFICATION_OLD, "warn"), emitRoute({ kind: "waiting", id: parsed.id }), { ok: !1, reason: "expired", kind: parsed.kind }) : api.handleHash(link.text, link.computer ?? ""));
  }
  async function retryApproveOff() {
    replay || await store.meta.get(APPROVE_OFF_META).catch(() => null) !== !0 || !(await postJson("/api/phones/push", { approveFromNotifications: !1 })).ok || (await keepApprove(!1), await store.meta.remove(APPROVE_OFF_META).catch(() => {
    }), refresh());
  }
  let connectSeq = 0;
  async function connectNow(id) {
    let seq = ++connectSeq, record = await store.get(id);
    if (!record) return { ok: !1, reason: "unknown" };
    let keyed = keyedRecord(record);
    if (!keyed) return { ok: !1, reason: "locked" };
    if (channel && (retireChannel(channel), channel = null), hello = null, activeId = id, await store.meta.put(ACTIVE_META, id).catch(() => {
    }), await refreshLockStop(), seq !== connectSeq) return { ok: !1, reason: "superseded" };
    let ch = openChannel({
      computer: keyed,
      store,
      device,
      caps,
      createWorker,
      onWorkerError: (line) => debug.log(`channel: ${line}`, "warn")
    });
    return attachChannel(ch, keyed.name), { ok: !0, id };
  }
  async function postJson(path, body, headers = {}) {
    if (!channel) return { ok: !1, status: 0, json: null, reason: "offline" };
    try {
      let res = await channel.request({ method: "POST", path, headers: { "content-type": "application/json", ...headers } }, JSON.stringify(body ?? {}), { scope: "shell" }), text = await readText(res.body), json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      let ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, json, reason: ok ? null : json?.error ?? "failed" };
    } catch (err) {
      return { ok: !1, status: 0, json: null, reason: String(err?.code ?? "offline") };
    }
  }
  let shellRequest = (ch) => (spec, body, opts) => ch.request(spec, body, { ...opts ?? {}, scope: "shell" });
  function whenConnected(ms = 8e3) {
    return channel ? hello ? Promise.resolve(!0) : new Promise((resolve) => {
      let timer = null, off = () => {
      }, done = (value) => {
        timer !== null && stopClock.clearTimeout(timer), off(), resolve(value);
      };
      timer = stopClock.setTimeout(() => done(!1), ms), off = api.subscribe(() => {
        hello ? done(!0) : channel || done(!1);
      });
    }) : Promise.resolve(!1);
  }
  async function savePrefs(next) {
    return prefs = normalisePrefs(next), await store.meta.put(PREFS_META, prefs).catch(() => {
    }), refresh();
  }
  let appliedHide = null;
  async function applyPrivacy() {
    if (device.platform !== "android" || !native?.PlenumPrivacy?.setHideInSwitcher) return;
    let enabled = prefs.hideSwitcher !== !1;
    if (appliedHide !== enabled)
      try {
        await native.PlenumPrivacy.setHideInSwitcher({ enabled }), appliedHide = enabled;
      } catch (err) {
        debug.log(`privacy: ${err?.code ?? "failed"}`, "warn");
      }
  }
  async function loadDictation() {
    if (native?.Dictation?.available) {
      try {
        let out = await native.Dictation.available();
        dictationState = { available: out?.available === !0, onDevice: out?.onDevice === !0, permission: String(out?.permission ?? "prompt") };
      } catch {
        dictationState = { available: !1, onDevice: !1, permission: "prompt" };
      }
      refresh();
    }
  }
  async function loadAndroidPush() {
    androidPush && (await androidPush.start(), androidPushState = await androidPush.state(), refresh());
  }
  function afterHello() {
    if (!(!uiHost || replay || mode !== "normal")) {
      if (pageKind === "ui") {
        refreshUi();
        return;
      }
      if (!(lockStatus.locked || holdUi)) {
        if (forceUi) {
          forceUi = !1, showUi({ force: !0 });
          return;
        }
        stay || showUi();
      }
    }
  }
  async function showUi({ force = !1 } = {}) {
    if (!uiHost || pageKind !== "shell" || !hello || replay) return { ok: !1, reason: "unavailable" };
    if (ui.state === "loading" || ui.state === "navigating") return { ok: !0, reason: null };
    if (stay && !force) return { ok: !1, reason: "stay" };
    ui = { state: "loading", cause: null, progress: { done: 0, total: 1 }, hasCopy: !1 }, refresh();
    let out = await uiHost.show({
      hello,
      computerId: activeId,
      loadedHash: null,
      onProgress: (progress) => {
        ui = { ...ui, progress }, refresh();
      }
    });
    return out.ok ? ui = { ...ui, state: "navigating", progress: { done: 1, total: 1 } } : ui = { state: "failed", cause: out.cause ?? "checksum", progress: null, hasCopy: await uiHost.hasCopy().catch(() => !1) }, refresh(), { ok: out.ok, reason: out.ok ? null : out.cause };
  }
  async function refreshUi() {
    if (!(!uiHost || refreshingUi)) {
      refreshingUi = !0;
      try {
        loadedUiHash === void 0 && (loadedUiHash = await uiHost.loadedHash());
        let out = await uiHost.refresh({ hello, loadedHash: loadedUiHash, computerId: activeId });
        out.ok && out.reload && onReload();
      } finally {
        refreshingUi = !1;
      }
    }
  }
  async function uiComputerOf() {
    return typeof uiHost?.uiComputerId == "function" ? uiHost.uiComputerId() : "any";
  }
  function leaveForShellIfNeeded() {
    if (pageKind !== "ui" || !uiHost || leaving || !loaded || mode !== "normal") return;
    let status = channelState.status;
    (computers.length === 0 || ["revoked", "not-known", "update-app", "update-desktop"].includes(status)) && (leaving = !0, Promise.resolve(uiHost.openShell()).catch(() => {
      leaving = !1;
    }));
  }
  function emitRoute(link) {
    intentSeq += 1, intent = { ...link, seq: intentSeq, taken: !1 }, pageKind === "shell" && onIntent({ ...link }), refresh();
  }
  let api = {
    state: () => snapshot,
    subscribe(fn) {
      subs.add(fn);
      try {
        fn(snapshot);
      } catch {
      }
      return () => subs.delete(fn);
    },
    get channel() {
      return channel;
    },
    debug,
    // Launch: reads the lock, the saved computers, the saved active computer and the phone's own preferences. Idempotent.
    async boot() {
      if (booted) return snapshot;
      booted = !0, prefs = normalisePrefs(await store.meta.get(PREFS_META).catch(() => null)), approveStored = await store.meta.get(APPROVE_META).catch(() => null) === !0;
      try {
        lock && (await lock.lockOnLaunch(), lockStatus = { ...lockStatus, ...await lock.status() });
      } catch {
        lockUnreadable = !0, lockStatus = { ...lockStatus, mode: "unknown", locked: !0 };
      } finally {
        lockKnown();
      }
      try {
        await loadComputers();
      } catch {
        computers = [];
      }
      if (loaded = !0, applyPrivacy(), loadDictation(), loadAndroidPush(), mode === "demo")
        return computers = [{ ...DEMO_COMPUTER }], activeId = DEMO_COMPUTER.id, channelState = { ...channelState, status: "connected", carrier: "lan", desktopName: "Demo computer", since: Date.now() }, refresh();
      let saved = await store.meta.get(ACTIVE_META).catch(() => null);
      if (lockStatus.locked) return refresh();
      if (mode === "selftest" || computers.length) {
        let asked = /^#connect=([0-9a-f]{64})$/.exec(pendingLink?.text ?? "")?.[1] ?? null, target = computers.find((c) => c.id === asked) ?? computers.find((c) => c.id === saved) ?? computers[0];
        if (target) {
          if (pageKind === "ui" && uiHost) {
            let uiFor = await uiComputerOf();
            if (uiFor !== "any" && uiFor !== target.id)
              return await api.openShell(`#connect=${target.id}`), refresh();
          }
          let opened = await connectNow(target.id);
          opened.ok || debug.log(`connect: ${opened.reason}`, "warn");
        }
      }
      return refresh();
    },
    // Pairing from a link. The final state is returned (allowed, denied, expired, mismatch or failed).
    async pair(text, options = {}) {
      if (mode === "demo")
        return pairing = { state: "failed", code: null, tried: [], reason: "demo" }, refresh(), { ...pairing };
      if (lockStatus.locked)
        return pairing = { state: "failed", code: null, tried: [], reason: "locked" }, refresh(), { ...pairing };
      let payload;
      try {
        payload = parsePairingText(text);
      } catch (err) {
        return pairing = { state: "failed", code: null, tried: [], reason: err?.code ?? "not-plenum" }, refresh(), { ...pairing };
      }
      pairing = { state: "starting", code: null, tried: [], reason: null }, refresh();
      let wrapped = null, typed = cleanName(options?.name), flow = startPairing({
        payload,
        store,
        createWorker,
        device: typed ? { ...device, name: typed } : device,
        caps,
        pageUrl,
        prepareRecord: async (record) => {
          let kept = lock ? await lock.protect(record) : record;
          return kept !== record && (wrapped = { id: record.id, key: b64uToBytes(record.myPriv) }), kept;
        },
        onState: (s) => {
          pairing = { ...s }, refresh();
        }
      });
      pairingFlow = flow;
      let final = await flow.done;
      if (pairingFlow === flow && (pairingFlow = null), final.state === "allowed") {
        await loadComputers();
        let id = final.computerId ?? computers.at(-1)?.id;
        return pairing = null, pairedSeq += 1, pairedId = id ?? null, holdUi = !0, wrapped && unlockedKeys.set(wrapped.id, wrapped.key), id && !lockStatus.locked && await connectNow(id), refresh(), { ...final, computerId: id ?? null };
      }
      return refresh(), { ...final };
    },
    async connect(id) {
      if (lockStatus.locked) return { ok: !1, reason: "locked" };
      if (pageKind === "ui" && uiHost) {
        let uiFor = await uiComputerOf();
        if (uiFor !== "any" && uiFor !== id)
          return await api.openShell(`#connect=${id}`), { ok: !0, reason: "opening" };
      }
      let result = await connectNow(id);
      return refresh(), result;
    },
    async stop(project = null, computer = "") {
      if (replay) {
        let out2 = replay.stop();
        return stopView = { state: "done", ack: out2.ack, error: null, text: out2.text, seq: ++stopSeq }, say(out2.text, "ok"), refresh(), stopClock.setTimeout(() => {
          stopView.state === "done" && (stopView = { state: "idle", ack: null, error: null, text: "", seq: stopView.seq }, refresh());
        }, 1600), { ...stopView };
      }
      let named = RECORD_ID.test(String(computer ?? "")) ? String(computer) : "";
      if (lockStatus.locked || lockUnreadable) return lockedStop(project, named);
      if (named && (named !== activeId || !channel)) return stopOn(named, project);
      if (!stopCtl) return { ...stopView, state: "idle", text: "Nothing to stop: no computer is connected." };
      notePress(activeId);
      let out = await stopCtl.press(project);
      return refresh(), out;
    },
    async forget(id) {
      return replay ? { ...refresh(), ok: !1, reason: "demo" } : (activeId === id && (connectSeq += 1, channel && (retireChannel(channel), channel = null, hello = null, channelState = { ...channelState, status: "closed" }), activeId = null, await store.meta.remove(ACTIVE_META).catch(() => {
      })), unlockedKeys.delete(id), await store.remove(id), await loadComputers(), { ...refresh(), ok: !0, reason: null });
    },
    // Phone settings: the name on this phone only (the computer keeps its own).
    async rename(id, name) {
      if (replay) return { ok: !1, reason: "demo" };
      let clean3 = cleanName(name);
      return !id || !clean3 ? { ok: !1, reason: "name" } : await store.patchComputer(id, { name: clean3 }) ? (await loadComputers(), activeId === id && (hello = hello ? { ...hello } : null), refresh(), { ok: !0, reason: null }) : { ok: !1, reason: "unknown" };
    },
    // Ways to reach: Move up and Move down reorder the carriers the record holds. The order is used at the next connection.
    async moveWay(id, kind, dir) {
      if (replay) return { ok: !1, reason: "demo" };
      let record = await store.get(id);
      if (!record) return { ok: !1, reason: "unknown" };
      let current = (Array.isArray(record.carriers) ? record.carriers : []).map((c) => c.kind), order = orderedWays(current), next = moveWay(order, kind, dir);
      if (next.join() === order.join()) return { ok: !0, reason: null, order: next };
      let sorted = [...record.carriers].sort((a, b) => next.indexOf(a.kind) - next.indexOf(b.kind));
      return await store.patchComputer(id, { carriers: sorted }), await loadComputers(), refresh(), { ok: !0, reason: null, order: next };
    },
    // Test them now: the phone reconnects and the carrier that answers is shown in the connection state.
    async testWays(id) {
      return replay ? { ok: !1, reason: "demo" } : !channel || activeId !== id ? { ok: !1, reason: "offline" } : channelState.status === "connected" ? { ok: !1, reason: "connected", carrier: channelState.carrier ?? null } : (channel.reconnect?.(), refresh(), { ok: !0, reason: null });
    },
    // Notifications kept on the computer (POST /api/phones/push). A switch the computer refuses stays where it was.
    async setPush(patch) {
      if (replay)
        return pushKnown = { ...pushValues(pushKnown), ...patch }, refresh(), { ok: !0, reason: null };
      let sent = patch.firstLine === !1 ? { ...patch, approveFromNotifications: !1 } : { ...patch }, out = await postJson("/api/phones/push", sent);
      return out.ok && (pushKnown = { ...pushValues(pushKnown), ...patch }, sent.approveFromNotifications !== void 0 && await keepApprove(sent.approveFromNotifications === !0)), refresh(), { ok: out.ok, reason: out.reason };
    },
    // Approve from notifications: asked of the computer, which checks the first line itself (409 when it is off).
    async setApprove(value) {
      let on = value === !0;
      if (on && pushKnown?.firstLine !== !0) return { ok: !1, reason: "first-line" };
      if (replay)
        return approveStored = on, refresh(), { ok: !0, reason: null };
      let out = await postJson("/api/phones/push", { approveFromNotifications: on });
      return out.ok && await keepApprove(on), refresh(), { ok: out.ok, reason: out.reason };
    },
    async testPush() {
      if (replay) return { ok: !0, reason: null };
      let out = await postJson("/api/phones/test-push", {});
      return refresh(), { ok: out.ok, reason: out.reason };
    },
    // Turn on notifications: the browser's permission (the user gesture is the tap on the screen). The native app asks through its plugin.
    // Web: the permission, then the push subscription, which the computer keeps: "Allowed" means a subscription is on the computer. The
    // computer's VAPID public key comes in its HELLO (vapidPublicKey); without it nothing is subscribed and the answer says so.
    // Android: UnifiedPush through the person's push app (push.js createAndroidPush); the endpoint it gives goes to the computer.
    async enableNotifications() {
      if (replay) return { ok: !0, reason: null };
      if (androidPush) {
        let out2 = await androidPush.enable();
        return androidPushState = await androidPush.state(), refresh(), { ok: out2.ok === !0, reason: out2.ok === !0 ? null : out2.reason ?? "failed" };
      }
      let key = typeof hello?.vapidPublicKey == "string" ? hello.vapidPublicKey : null;
      if (!key || !channel || !serviceWorker || !notifications) return { ok: !1, reason: "unavailable" };
      let registration = await registrationOf(serviceWorker);
      if (!registration) return { ok: !1, reason: "unavailable" };
      let forId = activeId, out = await subscribeWebPush({
        registration,
        applicationServerKey: key,
        request: channel.request,
        deviceId: typeof hello?.deviceId == "string" && hello.deviceId ? hello.deviceId : activeId,
        notification: notifications,
        env: pushEnv
      });
      return out.ok && out.endpoint && forId && await store.patchComputer(forId, { pushEndpoint: out.endpoint }).catch(() => {
      }), refresh(), out.ok ? { ok: !0, reason: null } : out.state === "denied" ? { ok: !1, reason: "denied" } : out.state === "other-computer" ? { ok: !1, reason: "other-computer" } : out.state === "unsupported" ? { ok: !1, reason: "unavailable" } : { ok: !1, reason: "failed" };
    },
    notificationPermission() {
      return notifications?.permission ?? "unknown";
    },
    // Android: the person chooses the push app (the system chooser). The settings line reads the answer from state().androidPush.
    async chooseDistributor() {
      if (!androidPush) return { ok: !1, reason: "unavailable" };
      let out = await androidPush.chooseDistributor();
      return androidPushState = await androidPush.state(), refresh(), out;
    },
    // Turn the notifications of this phone off at the computer (the subscription is dropped there).
    async disableNotifications() {
      if (replay) return { ok: !0, reason: null };
      if (androidPush) {
        let out2 = await androidPush.disable();
        return androidPushState = await androidPush.state(), refresh(), out2;
      }
      let out = await postJson("/api/phones/push", { subscription: null });
      if (out.ok && activeId) {
        let record = await store.get(activeId).catch(() => null), endpoint = typeof record?.pushEndpoint == "string" ? record.pushEndpoint : "", key = typeof hello?.vapidPublicKey == "string" ? hello.vapidPublicKey : null;
        if (endpoint || key) {
          let registration = await registrationOf(serviceWorker).catch(() => null);
          await dropWebPush({ registration, endpoint, applicationServerKey: endpoint ? null : key }) && endpoint && await store.patchComputer(activeId, { pushEndpoint: null }).catch(() => {
          });
        }
      }
      return refresh(), { ok: out.ok, reason: out.reason };
    },
    // App lock on: biometric (native), a passkey (web) or a PIN (web, through setPin).
    async enableLock(mode2) {
      if (!lock) return { ok: !1, reason: "unavailable" };
      let result;
      if (mode2 === "biometric") result = await lock.enableBiometric();
      else if (mode2 === "passkey") result = await lock.enablePasskey();
      else return { ok: !1, reason: "mode" };
      return lockStatus = { ...lockStatus, ...await lock.status() }, refresh(), { ok: result?.ok === !0, reason: result?.reason ?? null };
    },
    async setPin(pin) {
      if (!lock) return { ok: !1, reason: "unavailable" };
      let result = await lock.setPin(String(pin ?? ""));
      if (result?.ok) for (let [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
      return lockStatus = { ...lockStatus, ...await lock.status() }, refresh(), { ok: result?.ok === !0, reason: result?.reason ?? null };
    },
    async lockOff(pin = null) {
      if (!lock) return { ok: !1, reason: "unavailable" };
      let result = await lock.disable({ pin: pin === null ? null : String(pin) });
      if (lockStatus = { ...lockStatus, ...await lock.status() }, result?.ok && approveStored && !replay) {
        let told = !1;
        channel && (await postJson("/api/phones/push", { approveFromNotifications: !1 })).ok && (await keepApprove(!1), told = !0), told || await store.meta.put(APPROVE_OFF_META, !0).catch(() => {
        });
      }
      return refresh(), { ok: result?.ok === !0, reason: result?.reason ?? (result?.ok ? null : "pin") };
    },
    // The phone's own preferences (theme, text size, Stop side, haptics, switcher, lock time, dictation, the LAN strip).
    async setPrefs(patch) {
      return await savePrefs({ ...prefs, ...patch ?? {} }), applyPrivacy(), { ok: !0, reason: null };
    },
    cancelConnect() {
      return connectSeq += 1, channel && (retireChannel(channel), channel = null, hello = null, channelState = { ...channelState, status: "closed" }, activeId = null, store.meta.remove(ACTIVE_META).catch(() => {
      }), refreshLockStop().then(refresh)), refresh(), { ok: !0, reason: null };
    },
    // Drops a pairing in progress, and a pairing link that waits for review.
    cancelPairing() {
      let flow = pairingFlow;
      pairingFlow = null, pendingPair = null;
      try {
        flow?.cancel?.();
      } catch {
      }
      return pairing = null, refresh(), { ok: !0, reason: null };
    },
    // The person pressed Pair on the review screen: the parked link starts pairing. Resolves the final pairing state, or { ok: false, reason: 'none' }.
    async confirmPair() {
      let parked2 = pendingPair;
      return parked2 ? (pendingPair = null, api.pair(parked2.text)) : { ok: !1, reason: "none" };
    },
    // A line from the UI page's console (the facade's log): redacted, kept in the phone's own console and, when connected, sent to the computer.
    pageLog(line) {
      let entry = debug.log(String(line ?? "").slice(0, 2e3), "page");
      return entry && channel && !replay && channel.request({ method: "POST", path: "/_bridge/log", headers: { "content-type": "application/json" } }, JSON.stringify({ line: entry.text }), { scope: "shell" }).then((answer) => answer.cancel?.(), () => {
      }), !!entry;
    },
    debugClear() {
      return debug.clear(), refresh(), { ok: !0, reason: null };
    },
    // Posts the most recent debug lines to the computer. A phone not connected cannot send (the screen says so).
    async debugSend() {
      if (replay) return { ok: !0, reason: null, n: 0 };
      if (!channel) return { ok: !1, reason: "offline", n: 0 };
      let n = await debug.sendToComputer(shellRequest(channel), 100).catch(() => 0);
      return { ok: n > 0, reason: n > 0 ? null : "failed", n };
    },
    async demoDecide(id, decision) {
      if (!replay) return { ok: !1, reason: "not-demo" };
      let out = replay.decide(id, decision);
      return refresh(), out;
    },
    demoReset() {
      return replay ? (replay.reset(), stopView = { state: "idle", ack: null, error: null, text: "", seq: stopView.seq }, refresh(), { ok: !0, reason: null }) : { ok: !1, reason: "not-demo" };
    },
    async unlock(method, arg = null) {
      if (!lock) return { ok: !1, reason: "unavailable" };
      let result;
      if (method === "biometric") result = await lock.unlockBiometric();
      else if (method === "pin") result = await lock.unlockPin(arg);
      else if (method === "passkey") result = await lock.unlockPasskey();
      else return { ok: !1, reason: "method" };
      if (result.ok) {
        for (let [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
        lockUnreadable = !1, lockStatus = { ...lockStatus, ...await lock.status(), locked: !1 }, refresh();
        let saved = await store.meta.get(ACTIVE_META).catch(() => null);
        saved && computers.some((c) => c.id === saved) && await connectNow(saved), await runPendingLink(), refresh();
      } else
        lockStatus = { ...lockStatus, ...await lock.status() }, refresh();
      return { ok: result.ok, reason: result.reason ?? null, waitSec: result.waitSec ?? 0, failures: result.failures ?? 0 };
    },
    // Locks the app now. With no lock set there is nothing to unlock with, so nothing happens: the channel stays open and Stop stays reachable
    // (F4: locking without a lock used to close the channel and leave the phone locked until it was relaunched).
    async lockNow() {
      let status = lock ? await lock.status() : { mode: "off" };
      return !lock || status.mode === "off" ? { ok: !1, reason: "no-lock" } : (channel && (retireChannel(channel), channel = null, hello = null, channelState = { ...channelState, status: "closed" }), connectSeq += 1, unlockedKeys.clear(), await refreshLockStop(), lock.lock(), lockStatus = { ...lockStatus, ...await lock.status(), locked: !0 }, refresh(), { ok: !0, reason: null });
    },
    // The page went to the background or came back. The lock comes on after the time the person chose (prefs.lockAfter, five
    // minutes by default); "Immediately" locks on every return. The channel reconnects at once on return.
    async visibility(visible) {
      if (!visible)
        return hiddenAt = wall(), refresh();
      let away = hiddenAt == null ? null : wall() - hiddenAt;
      if (hiddenAt = null, lock) {
        let after = lockAfter(prefs.lockAfter).ms;
        lockStatus.mode !== "off" && away !== null && away >= after && !lockStatus.locked && await api.lockNow();
      }
      return channel?.reconnect(), refresh();
    },
    async runSelftest(options = {}) {
      if (!channel) return { ok: !1, passed: 0, total: 5, steps: [], reason: "not connected" };
      let run = selftestFn ?? null;
      if (!run) return { ok: !1, passed: 0, total: 5, steps: [], reason: "not in this build" };
      selftest = { running: !0 }, refresh();
      let report = await run({
        channel,
        log: (line) => debug.log(line),
        ...options
      });
      return selftest = { ...report, running: !1 }, mode === "selftest" && await debug.sendToComputer(shellRequest(channel), 1).catch(() => 0), refresh(), report;
    },
    // A link the page was opened with, a fragment the service worker posts, a native deep link or a fragment typed into the address bar:
    // a pairing link (#pair=..., plenum://pair#...), or a notification link (see push.js parseNotificationHash). While the app is locked the
    // link waits for the unlock.
    // computerHint (B-117) is the computer a notification came from (the service worker's message carries it apart from the fragment; a
    // fragment may also end in &computer=<id>). Stop all, Deny and Approve act on that computer, not on whichever one is open.
    async handleHash(hash, computerHint = "") {
      let text = String(hash ?? "");
      if (pageKind === "shell" && (text === "#settings" || text === "#computers"))
        return booted && await lockRead, lockStatus.locked || lockUnreadable ? (pendingLink = { text, at: wall() }, { ok: !1, reason: "locked" }) : (screenSeq += 1, screenRequest = { screen: text.slice(1), seq: screenSeq }, refresh(), { ok: !0, reason: null, kind: "screen" });
      let connectId = pageKind === "shell" ? /^#connect=([0-9a-f]{64})$/.exec(text)?.[1] ?? null : null;
      if (connectId) {
        if (booted && await lockRead, lockStatus.locked || lockUnreadable)
          return pendingLink = { text, at: wall() }, { ok: !1, reason: "locked" };
        if (!computers.some((c) => c.id === connectId)) return { ok: !1, reason: "unknown", kind: "connect" };
        if (forceUi = !0, channel && activeId === connectId)
          return hello && afterHello(), { ok: !0, reason: null, kind: "connect" };
        let opened = await connectNow(connectId);
        return opened.ok || (forceUi = !1), refresh(), { ...opened, kind: "connect" };
      }
      let isPair = text.includes("pair=") || /^plenum:\/\/pair#/.test(text), parsed = parseNotificationHash(text), link = parsed ? { ...parsed } : null, hinted = String(computerHint ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || link?.computer || "";
      link && delete link.computer;
      let named = !isPair && RECORD_ID.test(hinted) && ["stop", "deny", "approve"].includes(link?.kind) ? hinted : "";
      if (!isPair && !link) return { ok: !1, reason: "no link" };
      if (booted && await lockRead, lockStatus.locked || lockUnreadable)
        return !isPair && link?.kind === "stop" ? api.stop(null, named) : (pendingLink = { text, at: wall(), ...named ? { computer: named } : {} }, { ok: !1, reason: "locked" });
      if (isPair) {
        if (pageKind === "ui" && uiHost)
          return leaving = !0, await uiHost.openShell(text).catch(() => {
          }), { ok: !0, reason: null, kind: "pair" };
        let marked = /&ci-confirm=1$/.test(text), bare = marked ? text.replace(/&ci-confirm=1$/, "") : text;
        if (replay || marked && devBuild) return api.pair(bare);
        let payload;
        try {
          payload = parsePairingText(bare);
        } catch (err) {
          return pairing = { state: "failed", code: null, tried: [], reason: err?.code ?? "not-plenum" }, refresh(), { ...pairing };
        }
        let hosts = [], addHost = (kind, url) => {
          let host = hostLabel(url);
          host && !hosts.some((h) => h.kind === kind && h.host === host) && hosts.push({ kind, host });
        };
        for (let c of usableCarriers(payload.carriers)) for (let url of c.urls) addHost(c.kind, url);
        for (let c of pageCandidates(pageUrl, payload)) carrierUrlOk(c.kind, c.url) && addHost(c.kind, c.url);
        return hosts.length ? (pendingPair = { text: bare }, pairing = { state: "review", code: null, tried: [], reason: null, review: { name: cleanName(payload.name) || "Plenum computer", hosts } }, refresh(), { ok: !0, reason: null, kind: "review" }) : (pairing = { state: "failed", code: null, tried: [], reason: "no-carrier" }, refresh(), { ...pairing });
      }
      if (named && !computers.some((c) => c.id === named))
        return say(link.kind === "stop" ? UNKNOWN_COMPUTER_STOP : UNKNOWN_COMPUTER, "warn"), refresh(), { ok: !1, reason: "unknown-computer", kind: link.kind };
      if (link.kind === "stop")
        return named && (named !== activeId || !channel) ? api.stop(null, named) : channel ? api.stop() : (say("Nothing to stop: no computer is connected.", "warn"), refresh(), { ok: !1, reason: "not connected" });
      if (named && (named !== activeId || !channel)) {
        let opened = await openComputerFor(named, text.includes("&computer=") ? text : `${text}&computer=${named}`);
        if (opened.opening) return { ok: !0, reason: null, kind: link.kind, opening: !0 };
        if (!opened.ok)
          return say("Could not open that computer. Open the approval to answer it.", "warn"), refresh(), { ok: !1, reason: opened.reason ?? "failed", kind: link.kind };
      }
      if (link.kind === "deny") {
        if (!await whenConnected())
          return say("Not connected. Open the approval to answer it.", "warn"), refresh(), { ok: !1, reason: "offline", kind: "deny" };
        let out = await postJson("/api/approve", { approvalId: link.id, allow: !1 });
        return say(out.ok ? "Denied." : "That card is no longer waiting. Open it to see what changed.", out.ok ? "ok" : "warn"), refresh(), { ok: out.ok, reason: out.reason, kind: "deny" };
      }
      if (link.kind === "approve") {
        let reachable = link.line ? await whenConnected() : !!channel;
        if (!link.line || !reachable)
          return say(reachable ? "Open the approval to answer it." : "Not connected. Open the approval to answer it.", reachable ? "info" : "warn"), emitRoute({ kind: "waiting", id: link.id }), { ok: !1, reason: reachable ? "open-card" : "offline", kind: "approve" };
        let out = await postJson("/api/approve", { approvalId: link.id, allow: !0 }, { "x-plenum-notify-line": link.line });
        return out.ok ? (say("Approved.", "ok"), refresh(), { ok: !0, reason: null, kind: "approve" }) : out.status === 409 || out.status === 403 ? (say(CARD_CHANGED, "warn"), emitRoute({ kind: "waiting", id: link.id }), { ok: !1, reason: "changed", kind: "approve" }) : (say("Could not reach your computer. Open the approval to answer it.", "warn"), emitRoute({ kind: "waiting", id: link.id }), { ok: !1, reason: out.reason, kind: "approve" });
      }
      return isRouteLink(link) ? (emitRoute(link), { ok: !0, reason: null, kind: link.kind }) : { ok: !1, reason: "no link" };
    },
    // The desktop UI. On the shell page: pulls what the computer has and hands the page to it (it does that by itself after HELLO; this is for
    // "Open Plenum" on /?shell and for Try again).
    showUi,
    // The screens call this when the steps after a pairing are over (or were skipped): the page may go to the UI now.
    releaseUi() {
      holdUi && (holdUi = !1, hello && afterHello());
    },
    // "Use the copy in this app": the UI that is already on the phone, without asking the computer.
    async useCopy() {
      if (!uiHost) return { ok: !1, reason: "unavailable" };
      ui = { ...ui, state: "loading", cause: null }, refresh();
      let out = await uiHost.useCopy();
      return out.ok ? ui = { ...ui, state: "navigating" } : ui = { state: "failed", cause: out.cause ?? "worker", progress: null, hasCopy: !1 }, refresh(), { ok: out.ok, reason: out.ok ? null : out.cause };
    },
    // From the UI page back to the shell's screens (Phone settings, the computer list, pairing).
    async openShell(hash = "") {
      if (!uiHost) return !1;
      leaving = !0;
      let done = await uiHost.openShell(hash).catch(() => !1);
      return done || (leaving = !1), done;
    },
    // The route a notification named, once: { kind, id?, project?, section?, seq } or null.
    takeRoute() {
      if (!intent || intent.taken) return null;
      intent = { ...intent, taken: !0 };
      let out = { ...intent };
      return refresh(), out;
    },
    // Scans a pairing code with the phone's camera (native). { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' | 'unavailable' }.
    // The text is a pairing link: the caller hands it to pair().
    async scan() {
      return native?.BarcodeScanner ? native.BarcodeScanner.scan() : { ok: !1, reason: "unavailable" };
    },
    // Turns the dictation on the phone on or off: the plugin's start/stop. Result events go to boot.js (plenumShell.dictation).
    async dictation() {
      return await loadDictation(), dictationState ? { ...dictationState } : { available: !1, onDevice: !1, permission: "prompt" };
    },
    // B-120: the Stop that is queued or sending, for the UI page to hand over when it leaves: { at, computer } or null.
    pendingStop() {
      return (stopView.state === "sending" || stopView.state === "queued") && stopPressedAt !== null ? { at: stopPressedAt, computer: stopComputer } : null;
    },
    async start() {
      if (started) return snapshot;
      started = !0;
      let leftStop = mode === "normal" ? await parked.take().catch(() => null) : null, hash = String(pageUrl && pageUrl.includes("#") ? pageUrl.slice(pageUrl.indexOf("#")) : "");
      return hash.length > 1 ? (clearHash(), pendingLink = { text: hash, at: wall() }) : typeof initialLink == "string" && initialLink && (pendingLink = { text: initialLink, at: wall() }), await api.boot(), await runPendingLink(), leftStop && await api.stop(null, leftStop.computer).catch(() => {
      }), snapshot;
    }
  };
  return api;
}
function hasNativeBridge(env) {
  return !!(env?.androidBridge || env?.webkit?.messageHandlers?.bridge);
}
function wantsNativePlugins(env) {
  return isNative(env) && hasNativeBridge(env);
}
async function loadNativePlugins2(env) {
  return wantsNativePlugins(env) ? (await Promise.resolve().then(() => (init_native3(), native_exports3))).loadNativePlugins() : null;
}
function linkOfUrl(url) {
  let text = String(url ?? ""), app = /^plenum:\/\/app\/?(?:\?[^#]*)?(#.*)$/.exec(text);
  return app ? app[1] : /^plenum:\/\/pair#/.test(text) ? text : null;
}
function wireAppPlugin({ appPlugin, shell, env, pageKind, platform = null }) {
  let opened = /* @__PURE__ */ new Set(), launchRan = !1, wanted = (link) => !!link && !(platform === "ios" && link.startsWith("#"));
  return appPlugin?.addListener && (appPlugin.addListener("appUrlOpen", (event) => {
    let url = String(event?.url ?? ""), link = linkOfUrl(url);
    wanted(link) && (opened.add(url), shell.handleHash(link).catch(() => {
    }));
  }), pageKind === "shell" && appPlugin.addListener("backButton", () => {
    let event = typeof env?.CustomEvent == "function" ? new env.CustomEvent("plenum-back", { cancelable: !0 }) : null;
    event && env.dispatchEvent?.(event) === !1 || (typeof appPlugin.minimizeApp == "function" ? appPlugin.minimizeApp() : appPlugin.exitApp?.());
  })), async function() {
    if (!(launchRan || !appPlugin?.getLaunchUrl)) {
      launchRan = !0;
      try {
        let launched = await appPlugin.getLaunchUrl(), url = String(launched?.url ?? ""), link = linkOfUrl(url);
        wanted(link) && !opened.has(url) && shell.handleHash(link).catch(() => {
        });
      } catch {
      }
    }
  };
}
function takeAttachSlot(env) {
  let f = env?.__plenumAttachShell;
  try {
    delete env.__plenumAttachShell;
  } catch {
  }
  return typeof f == "function" ? f : null;
}
async function startShell(env = globalThis, { loadPlugins = loadNativePlugins2, devBuild = DEV_BUILD, attach, giveCore } = {}) {
  let ofPage = env === globalThis;
  if (ofPage) {
    if (!takePageStart())
      return giveCore?.(null), null;
    devBuild = DEV_BUILD;
  }
  let give = giveCore ?? (ofPage ? giveShellCore : () => {
  }), attachFn = attach !== void 0 ? attach : ofPage ? attachShim : takeAttachSlot(env), handed = !1;
  try {
    return await runStart(env, { loadPlugins, devBuild, attach: attachFn, give: (value) => {
      handed = !0, give(value);
    } });
  } catch (error) {
    throw handed || give(null), error;
  }
}
async function runStart(env, { loadPlugins, devBuild, attach, give }) {
  let framed = !1;
  try {
    framed = env.top !== env.self;
  } catch {
    framed = !0;
  }
  let sameOriginOpener = !1;
  try {
    sameOriginOpener = !!env.opener && env.opener.location.origin === env.location.origin;
  } catch {
    sameOriginOpener = !1;
  }
  if (framed || sameOriginOpener)
    return give(null), null;
  let { device, caps, native } = deviceFor(env), cap = env.Capacitor, pageKind = pageKindFor(env), lan = isLanPage(env), bridge = hasNativeBridge(env), plugins = null, pluginFailure = !1;
  if (native)
    try {
      plugins = await loadPlugins(env);
    } catch {
      pluginFailure = !0;
    }
  let registered = plugins?.secureStorage ?? cap?.Plugins?.SecureStorage ?? null, secureStorage = native || bridge ? pluginFailure || bridge && (!plugins || !registered) ? NO_SECURE_STORAGE : registered : null, store = createPlatformStore({ secureStorage, indexedDB: env.indexedDB ?? null }), biometricPlugin = native ? plugins?.BiometricAuth ?? cap?.Plugins?.BiometricAuth ?? null : null, lock = createLock({
    store,
    now: () => Date.now(),
    biometric: createBiometricGate({ plugin: biometricPlugin }),
    passkey: native ? null : createPasskeyGate({ credentials: env.navigator?.credentials, PublicKeyCredentialCtor: env.PublicKeyCredential, rpId: env.location?.hostname })
  }), params = new URLSearchParams(String(env.location?.search ?? "")), mode = modeFor(env.location?.search, devBuild), stay = params.has(SHELL_QUERY), linkStore = createLinkStore(store.meta), parkedStop = createParkedStop(store.meta);
  try {
    env.sessionStorage?.removeItem(SHELL_LINK_KEY);
  } catch {
  }
  !native && pageKind === "shell" && registerServiceWorker(env);
  let shell = null, kind = native ? device.platform === "android" ? "android" : "ios" : lan ? "lan" : "web", uiHost = mode === "normal" && env.location && (!native || plugins) ? createUiHost({ env, kind, native: plugins, channelOf: () => shell?.channel ?? null, log: (line) => shell?.debug.log(line, "warn"), linkStore, stopHandoff: { pending: () => shell?.pendingStop?.() ?? null, park: (pending) => parkedStop.put(pending), unpark: () => parkedStop.unpark() } }) : null, initialIntent = null;
  try {
    let saved = pageKind === "ui" ? env.sessionStorage?.getItem("plenum-intent") : null;
    saved && (env.sessionStorage.removeItem("plenum-intent"), initialIntent = JSON.parse(saved));
  } catch {
    initialIntent = null;
  }
  let initialLink = null;
  native && plugins && pageKind === "shell" && (initialLink = await linkStore.take()), shell = createShell({
    store,
    lock,
    device,
    caps,
    pageUrl: env.location?.href ?? null,
    mode,
    createWorker: defaultCreateWorker,
    notifications: env.Notification ?? null,
    serviceWorker: env.navigator?.serviceWorker ?? null,
    pushEnv: env,
    clearHash: () => clearAddressHash(env),
    native: plugins,
    uiHost,
    pageKind,
    stay,
    initialIntent,
    initialLink,
    // A notification route that arrives on the shell page is kept for the UI page, and the UI is opened.
    onIntent: (link) => {
      try {
        env.sessionStorage?.setItem("plenum-intent", JSON.stringify(link));
      } catch {
      }
      shell?.showUi({ force: !0 });
    },
    onReload: () => {
      env.location?.reload?.();
    },
    devBuild,
    storage: secureStorage === NO_SECURE_STORAGE ? "unavailable" : "ok",
    parkedStop
  }), secureStorage === NO_SECURE_STORAGE && shell.debug.log("storage: unavailable", "warn"), devBuild && (env.plenumShellCore = shell, env.plenumNative = plugins), attach?.(makeFacade(shell, plugins)), give(shell), env.addEventListener?.("visibilitychange", () => {
    shell.visibility(env.document?.visibilityState !== "hidden");
  }), env.addEventListener?.("pagehide", () => shell.visibility(!1)), env.addEventListener?.("hashchange", () => {
    let hash = String(env.location?.hash ?? "");
    hash.length > 1 && (clearAddressHash(env), shell.handleHash(hash).catch(() => {
    }));
  }), env.navigator?.serviceWorker?.addEventListener?.("message", (event) => {
    let data = event?.data;
    data?.op === "plenum-hash" && typeof data.hash == "string" && shell.handleHash(data.hash, typeof data.computer == "string" ? data.computer : "").catch(() => {
    });
  });
  let afterStart = wireAppPlugin({ appPlugin: plugins?.App ?? null, shell, env, pageKind, platform: device.platform });
  if (await shell.start(), await afterStart(), mode === "selftest") {
    let report = await shell.runSelftest();
    shell.debug.log(`selftest ${report.passed}/${report.total}`);
  }
  return shell;
}
typeof document < "u" && typeof window < "u" && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__ && startShell(globalThis).catch((err) => {
  giveShellCore(null), console.error(String(err?.message ?? err));
});
export {
  CARD_CHANGED,
  DEV_BUILD,
  NOTIFICATION_OLD,
  STOP_NO_KEY,
  UNKNOWN_COMPUTER,
  UNKNOWN_COMPUTER_STOP,
  cleanName,
  clearAddressHash,
  createLinkStore,
  createParkedStop,
  createShell,
  deviceFor,
  hasNativeBridge,
  linkOfUrl,
  makeFacade,
  modeFor,
  registerServiceWorker,
  registrationOf,
  safeState,
  startShell,
  wantsNativePlugins,
  wireAppPlugin
};
/*! Bundled license information:

@capacitor/core/dist/index.js:
  (*! Capacitor: https://capacitorjs.com/ - MIT License *)

@noble/ciphers/utils.js:
  (*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) *)
*/
