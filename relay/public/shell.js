var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// mobile/plugins/unifiedpush/src/core.js
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
function isRoute(value) {
  return typeof value === "string" && ROUTE_RE.test(value);
}
function normaliseInstance(value) {
  if (value === void 0 || value === null || value === "") return DEFAULT_INSTANCE;
  if (typeof value !== "string" || !INSTANCE_RE.test(value)) {
    throw new UnifiedPushError("bad-instance", "A registration name is 1 to 64 letters, digits, dots, dashes or underscores.");
  }
  return value;
}
function decodeBase64(text) {
  if (typeof text !== "string" || text.length > Math.ceil(MAX_MESSAGE_BYTES * 4 / 3) + 8) {
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  }
  const standard = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!BASE64_RE.test(standard)) {
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  }
  const unpadded = standard.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) {
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  }
  const padded = unpadded + "=".repeat((4 - unpadded.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new UnifiedPushError("bad-message", "The push message is not base64 text.");
  }
  if (binary.length > MAX_MESSAGE_BYTES) {
    throw new UnifiedPushError("message-too-large", "The push message is larger than the 256 KB limit.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
function parseJsonObject(text) {
  if (typeof text !== "string" || text.trimStart()[0] !== "{") return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}
function parsePushPayload(value) {
  if (!isPlainObject(value) || value.v !== 1 || !PUSH_KINDS.includes(value.kind)) return null;
  const title = cleanText(value.title, 120) || "Plenum";
  const body = cleanText(value.body, 240) || "Plenum has an update.";
  const tag = typeof value.tag === "string" && TAG_RE.test(value.tag) ? value.tag : "plenum";
  const tap = isRoute(value.tap) ? value.tap : "/#home";
  const firstLine = cleanText(value.firstLine, 200);
  const actions = [];
  if (Array.isArray(value.actions)) {
    for (const entry of value.actions) {
      if (actions.length >= 3) break;
      if (isPlainObject(entry) && PUSH_ACTIONS.includes(entry.action) && isRoute(entry.route)) {
        actions.push({ action: entry.action, title: cleanText(entry.title, 40) || entry.action, route: entry.route });
      }
    }
  }
  const ids = isPlainObject(value.ids) ? value.ids : {};
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
  if (action.action !== "approve" || !firstLine) return action.route;
  return `${action.route}&line=${encodeURIComponent(firstLine)}`;
}
function channelForKind(kind) {
  if (kind === "approval" || kind === "handover") return NOTIFICATION_CHANNELS.approvals;
  if (kind === "limit") return NOTIFICATION_CHANNELS.limits;
  return NOTIFICATION_CHANNELS.finished;
}
function parseMessageEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError("bad-event", "The push event is not an object.");
  const instance = normaliseInstance(event.instance);
  const decrypted = event.decrypted === true;
  const bytes = decodeBase64(event.content);
  const text = decrypted ? decodeUtf8(bytes) : null;
  const payload = text === null ? null : parsePushPayload(parseJsonObject(text));
  return { instance, decrypted, bytes, text, payload };
}
function parseEndpointEvent(event) {
  if (!isPlainObject(event)) throw new UnifiedPushError("bad-event", "The endpoint event is not an object.");
  const instance = normaliseInstance(event.instance);
  if (typeof event.url !== "string" || !HTTPS_URL_RE.test(event.url)) {
    throw new UnifiedPushError("endpoint-not-https", "The push app gave an address that is not https.");
  }
  const keys = isPlainObject(event.pubKeySet) && typeof event.pubKeySet.pubKey === "string" && BASE64URL_RE.test(event.pubKeySet.pubKey) && typeof event.pubKeySet.auth === "string" && BASE64URL_RE.test(event.pubKeySet.auth) ? { pubKey: event.pubKeySet.pubKey, auth: event.pubKeySet.auth } : null;
  return { instance, url: event.url, temporary: event.temporary === true, keys };
}
var UNIFIEDPUSH_EVENTS, FAILED_REASONS, DEFAULT_INSTANCE, MAX_MESSAGE_BYTES, PUSH_KINDS, PUSH_ACTIONS, NOTIFICATION_CHANNELS, INSTANCE_RE, BASE64URL_RE, BASE64_RE, HTTPS_URL_RE, TAG_RE, ROUTE_RE, UnifiedPushError;
var init_core = __esm({
  "mobile/plugins/unifiedpush/src/core.js"() {
    UNIFIEDPUSH_EVENTS = Object.freeze(["endpoint", "registrationFailed", "unregistered", "tempUnavailable", "message"]);
    FAILED_REASONS = Object.freeze(["INTERNAL_ERROR", "NETWORK", "ACTION_REQUIRED", "VAPID_REQUIRED"]);
    DEFAULT_INSTANCE = "default";
    MAX_MESSAGE_BYTES = 256 * 1024;
    PUSH_KINDS = Object.freeze(["approval", "handover", "finished", "failed", "limit", "test"]);
    PUSH_ACTIONS = Object.freeze(["deny", "stop", "approve"]);
    NOTIFICATION_CHANNELS = Object.freeze({
      approvals: "plenum-approvals",
      finished: "plenum-finished",
      limits: "plenum-limits"
    });
    INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
    BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
    BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
    HTTPS_URL_RE = /^https:\/\/\S{1,2000}$/;
    TAG_RE = /^plenum-[0-9a-f]{32}$/;
    ROUTE_RE = /^\/#[\x21-\x7e]{1,200}$/;
    UnifiedPushError = class extends Error {
      constructor(code, message) {
        super(message);
        this.name = "UnifiedPushError";
        this.code = code;
      }
    };
  }
});

// mobile/node_modules/@capacitor/core/dist/index.js
var ExceptionCode, CapacitorException, getPlatformId, createCapacitor, initCapacitorGlobal, Capacitor, registerPlugin, WebPlugin, WebView, encode, decode, CapacitorCookiesPluginWeb, CapacitorCookies, readBlobAsBase64, normalizeHttpHeaders, buildUrlParams, buildRequestInit, CapacitorHttpPluginWeb, CapacitorHttp, SystemBarsStyle, SystemBarType, SystemBarsPluginWeb, SystemBars;
var init_dist = __esm({
  "mobile/node_modules/@capacitor/core/dist/index.js"() {
    (function(ExceptionCode2) {
      ExceptionCode2["Unimplemented"] = "UNIMPLEMENTED";
      ExceptionCode2["Unavailable"] = "UNAVAILABLE";
    })(ExceptionCode || (ExceptionCode = {}));
    CapacitorException = class extends Error {
      constructor(message, code, data) {
        super(message);
        this.message = message;
        this.code = code;
        this.data = data;
      }
    };
    getPlatformId = (win) => {
      var _a, _b;
      if (win === null || win === void 0 ? void 0 : win.androidBridge) {
        return "android";
      } else if ((_b = (_a = win === null || win === void 0 ? void 0 : win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.bridge) {
        return "ios";
      } else {
        return "web";
      }
    };
    createCapacitor = (win) => {
      const capCustomPlatform = win.CapacitorCustomPlatform || null;
      const cap = win.Capacitor || {};
      const Plugins = cap.Plugins = cap.Plugins || {};
      const getPlatform = () => {
        return capCustomPlatform !== null ? capCustomPlatform.name : getPlatformId(win);
      };
      const isNativePlatform = () => getPlatform() !== "web";
      const isPluginAvailable = (pluginName) => {
        const plugin = registeredPlugins.get(pluginName);
        if (plugin === null || plugin === void 0 ? void 0 : plugin.platforms.has(getPlatform())) {
          return true;
        }
        if (getPluginHeader(pluginName)) {
          return true;
        }
        return false;
      };
      const getPluginHeader = (pluginName) => {
        var _a;
        return (_a = cap.PluginHeaders) === null || _a === void 0 ? void 0 : _a.find((h) => h.name === pluginName);
      };
      const handleError = (err) => win.console.error(err);
      const registeredPlugins = /* @__PURE__ */ new Map();
      const registerPlugin2 = (pluginName, jsImplementations = {}) => {
        const registeredPlugin = registeredPlugins.get(pluginName);
        if (registeredPlugin) {
          console.warn(`Capacitor plugin "${pluginName}" already registered. Cannot register plugins twice.`);
          return registeredPlugin.proxy;
        }
        const platform = getPlatform();
        const pluginHeader = getPluginHeader(pluginName);
        let jsImplementation;
        const loadPluginImplementation = async () => {
          if (!jsImplementation && platform in jsImplementations) {
            jsImplementation = typeof jsImplementations[platform] === "function" ? jsImplementation = await jsImplementations[platform]() : jsImplementation = jsImplementations[platform];
          } else if (capCustomPlatform !== null && !jsImplementation && "web" in jsImplementations) {
            jsImplementation = typeof jsImplementations["web"] === "function" ? jsImplementation = await jsImplementations["web"]() : jsImplementation = jsImplementations["web"];
          }
          return jsImplementation;
        };
        const createPluginMethod = (impl, prop) => {
          var _a, _b;
          if (pluginHeader) {
            const methodHeader = pluginHeader === null || pluginHeader === void 0 ? void 0 : pluginHeader.methods.find((m) => prop === m.name);
            if (methodHeader) {
              if (methodHeader.rtype === "promise") {
                return (options) => cap.nativePromise(pluginName, prop.toString(), options);
              } else {
                return (options, callback) => cap.nativeCallback(pluginName, prop.toString(), options, callback);
              }
            } else if (impl) {
              return (_a = impl[prop]) === null || _a === void 0 ? void 0 : _a.bind(impl);
            }
          } else if (impl) {
            return (_b = impl[prop]) === null || _b === void 0 ? void 0 : _b.bind(impl);
          } else {
            throw new CapacitorException(`"${pluginName}" plugin is not implemented on ${platform}`, ExceptionCode.Unimplemented);
          }
        };
        const createPluginMethodWrapper = (prop) => {
          let remove;
          const wrapper = (...args) => {
            const p = loadPluginImplementation().then((impl) => {
              const fn = createPluginMethod(impl, prop);
              if (fn) {
                const p2 = fn(...args);
                remove = p2 === null || p2 === void 0 ? void 0 : p2.remove;
                return p2;
              } else {
                throw new CapacitorException(`"${pluginName}.${prop}()" is not implemented on ${platform}`, ExceptionCode.Unimplemented);
              }
            });
            if (prop === "addListener") {
              p.remove = async () => remove();
            }
            return p;
          };
          wrapper.toString = () => `${prop.toString()}() { [capacitor code] }`;
          Object.defineProperty(wrapper, "name", {
            value: prop,
            writable: false,
            configurable: false
          });
          return wrapper;
        };
        const addListener = createPluginMethodWrapper("addListener");
        const removeListener = createPluginMethodWrapper("removeListener");
        const addListenerNative = (eventName, callback) => {
          const call = addListener({ eventName }, callback);
          const remove = async () => {
            const callbackId = await call;
            removeListener({
              eventName,
              callbackId
            }, callback);
          };
          const p = new Promise((resolve) => call.then(() => resolve({ remove })));
          p.remove = async () => {
            console.warn(`Using addListener() without 'await' is deprecated.`);
            await remove();
          };
          return p;
        };
        const proxy3 = new Proxy({}, {
          get(_, prop) {
            switch (prop) {
              // https://github.com/facebook/react/issues/20030
              case "$$typeof":
                return void 0;
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
        Plugins[pluginName] = proxy3;
        registeredPlugins.set(pluginName, {
          name: pluginName,
          proxy: proxy3,
          platforms: /* @__PURE__ */ new Set([...Object.keys(jsImplementations), ...pluginHeader ? [platform] : []])
        });
        return proxy3;
      };
      if (!cap.convertFileSrc) {
        cap.convertFileSrc = (filePath) => filePath;
      }
      cap.getPlatform = getPlatform;
      cap.handleError = handleError;
      cap.isNativePlatform = isNativePlatform;
      cap.isPluginAvailable = isPluginAvailable;
      cap.registerPlugin = registerPlugin2;
      cap.Exception = CapacitorException;
      cap.DEBUG = !!cap.DEBUG;
      cap.isLoggingEnabled = !!cap.isLoggingEnabled;
      return cap;
    };
    initCapacitorGlobal = (win) => win.Capacitor = createCapacitor(win);
    Capacitor = /* @__PURE__ */ initCapacitorGlobal(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : {});
    registerPlugin = Capacitor.registerPlugin;
    WebPlugin = class {
      constructor() {
        this.listeners = {};
        this.retainedEventArguments = {};
        this.windowListeners = {};
      }
      addListener(eventName, listenerFunc) {
        let firstListener = false;
        const listeners = this.listeners[eventName];
        if (!listeners) {
          this.listeners[eventName] = [];
          firstListener = true;
        }
        this.listeners[eventName].push(listenerFunc);
        const windowListener = this.windowListeners[eventName];
        if (windowListener && !windowListener.registered) {
          this.addWindowListener(windowListener);
        }
        if (firstListener) {
          this.sendRetainedArgumentsForEvent(eventName);
        }
        const remove = async () => this.removeListener(eventName, listenerFunc);
        const p = Promise.resolve({ remove });
        return p;
      }
      async removeAllListeners() {
        this.listeners = {};
        for (const listener in this.windowListeners) {
          this.removeWindowListener(this.windowListeners[listener]);
        }
        this.windowListeners = {};
      }
      notifyListeners(eventName, data, retainUntilConsumed) {
        const listeners = this.listeners[eventName];
        if (!listeners) {
          if (retainUntilConsumed) {
            let args = this.retainedEventArguments[eventName];
            if (!args) {
              args = [];
            }
            args.push(data);
            this.retainedEventArguments[eventName] = args;
          }
          return;
        }
        listeners.forEach((listener) => listener(data));
      }
      hasListeners(eventName) {
        var _a;
        return !!((_a = this.listeners[eventName]) === null || _a === void 0 ? void 0 : _a.length);
      }
      registerWindowListener(windowEventName, pluginEventName) {
        this.windowListeners[pluginEventName] = {
          registered: false,
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
        const listeners = this.listeners[eventName];
        if (!listeners) {
          return;
        }
        const index = listeners.indexOf(listenerFunc);
        if (index !== -1) {
          this.listeners[eventName].splice(index, 1);
        }
        if (!this.listeners[eventName].length) {
          this.removeWindowListener(this.windowListeners[eventName]);
        }
      }
      addWindowListener(handle) {
        window.addEventListener(handle.windowEventName, handle.handler);
        handle.registered = true;
      }
      removeWindowListener(handle) {
        if (!handle) {
          return;
        }
        window.removeEventListener(handle.windowEventName, handle.handler);
        handle.registered = false;
      }
      sendRetainedArgumentsForEvent(eventName) {
        const args = this.retainedEventArguments[eventName];
        if (!args) {
          return;
        }
        delete this.retainedEventArguments[eventName];
        args.forEach((arg) => {
          this.notifyListeners(eventName, arg);
        });
      }
    };
    WebView = /* @__PURE__ */ registerPlugin("WebView");
    encode = (str) => encodeURIComponent(str).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent).replace(/[()]/g, escape);
    decode = (str) => str.replace(/(%[\dA-F]{2})+/gi, decodeURIComponent);
    CapacitorCookiesPluginWeb = class extends WebPlugin {
      async getCookies() {
        const cookies = document.cookie;
        const cookieMap = {};
        cookies.split(";").forEach((cookie) => {
          if (cookie.length <= 0)
            return;
          let [key, value] = cookie.replace(/=/, "CAP_COOKIE").split("CAP_COOKIE");
          key = decode(key).trim();
          value = decode(value).trim();
          cookieMap[key] = value;
        });
        return cookieMap;
      }
      async setCookie(options) {
        try {
          const encodedKey = encode(options.key);
          const encodedValue = encode(options.value);
          const expires = options.expires ? `; expires=${options.expires.replace("expires=", "")}` : "";
          const path = (options.path || "/").replace("path=", "");
          const domain = options.url != null && options.url.length > 0 ? `domain=${options.url}` : "";
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
          const cookies = document.cookie.split(";") || [];
          for (const cookie of cookies) {
            document.cookie = cookie.replace(/^ +/, "").replace(/=.*/, `=;expires=${(/* @__PURE__ */ new Date()).toUTCString()};path=/`);
          }
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
    };
    CapacitorCookies = registerPlugin("CapacitorCookies", {
      web: () => new CapacitorCookiesPluginWeb()
    });
    readBlobAsBase64 = async (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result;
        resolve(base64String.indexOf(",") >= 0 ? base64String.split(",")[1] : base64String);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(blob);
    });
    normalizeHttpHeaders = (headers = {}) => {
      const originalKeys = Object.keys(headers);
      const loweredKeys = Object.keys(headers).map((k) => k.toLocaleLowerCase());
      const normalized = loweredKeys.reduce((acc, key, index) => {
        acc[key] = headers[originalKeys[index]];
        return acc;
      }, {});
      return normalized;
    };
    buildUrlParams = (params, shouldEncode = true) => {
      if (!params)
        return null;
      const output = Object.entries(params).reduce((accumulator, entry) => {
        const [key, value] = entry;
        let encodedValue;
        let item;
        if (Array.isArray(value)) {
          item = "";
          value.forEach((str) => {
            encodedValue = shouldEncode ? encodeURIComponent(str) : str;
            item += `${key}=${encodedValue}&`;
          });
          item.slice(0, -1);
        } else {
          encodedValue = shouldEncode ? encodeURIComponent(value) : value;
          item = `${key}=${encodedValue}`;
        }
        return `${accumulator}&${item}`;
      }, "");
      return output.substr(1);
    };
    buildRequestInit = (options, extra = {}) => {
      const output = Object.assign({ method: options.method || "GET", headers: options.headers }, extra);
      const headers = normalizeHttpHeaders(options.headers);
      const type = headers["content-type"] || "";
      if (typeof options.data === "string") {
        output.body = options.data;
      } else if (type.includes("application/x-www-form-urlencoded")) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(options.data || {})) {
          params.set(key, value);
        }
        output.body = params.toString();
      } else if (type.includes("multipart/form-data") || options.data instanceof FormData) {
        const form = new FormData();
        if (options.data instanceof FormData) {
          options.data.forEach((value, key) => {
            form.append(key, value);
          });
        } else {
          for (const key of Object.keys(options.data)) {
            form.append(key, options.data[key]);
          }
        }
        output.body = form;
        const headers2 = new Headers(output.headers);
        headers2.delete("content-type");
        output.headers = headers2;
      } else if (type.includes("application/json") || typeof options.data === "object") {
        output.body = JSON.stringify(options.data);
      }
      return output;
    };
    CapacitorHttpPluginWeb = class extends WebPlugin {
      /**
       * Perform an Http request given a set of options
       * @param options Options to build the HTTP request
       */
      async request(options) {
        const requestInit = buildRequestInit(options, options.webFetchExtra);
        const urlParams = buildUrlParams(options.params, options.shouldEncodeUrlParams);
        const url = urlParams ? `${options.url}?${urlParams}` : options.url;
        const response = await fetch(url, requestInit);
        const contentType = response.headers.get("content-type") || "";
        let { responseType = "text" } = response.ok ? options : {};
        if (contentType.includes("application/json")) {
          responseType = "json";
        }
        let data;
        let blob;
        switch (responseType) {
          case "arraybuffer":
          case "blob":
            blob = await response.blob();
            data = await readBlobAsBase64(blob);
            break;
          case "json":
            data = await response.json();
            break;
          case "document":
          case "text":
          default:
            data = await response.text();
        }
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
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
    };
    CapacitorHttp = registerPlugin("CapacitorHttp", {
      web: () => new CapacitorHttpPluginWeb()
    });
    (function(SystemBarsStyle2) {
      SystemBarsStyle2["Dark"] = "DARK";
      SystemBarsStyle2["Light"] = "LIGHT";
      SystemBarsStyle2["Default"] = "DEFAULT";
    })(SystemBarsStyle || (SystemBarsStyle = {}));
    (function(SystemBarType2) {
      SystemBarType2["StatusBar"] = "StatusBar";
      SystemBarType2["NavigationBar"] = "NavigationBar";
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
    };
    SystemBars = registerPlugin("SystemBars", {
      web: () => new SystemBarsPluginWeb()
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/definitions.js
var StorageErrorType, KeychainAccess, StorageError;
var init_definitions = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/definitions.js"() {
    (function(StorageErrorType2) {
      StorageErrorType2["missingKey"] = "missingKey";
      StorageErrorType2["invalidData"] = "invalidData";
      StorageErrorType2["osError"] = "osError";
      StorageErrorType2["unknownError"] = "unknownError";
      StorageErrorType2["missingPrefix"] = "missingPrefix";
    })(StorageErrorType || (StorageErrorType = {}));
    (function(KeychainAccess2) {
      KeychainAccess2[KeychainAccess2["whenUnlocked"] = 0] = "whenUnlocked";
      KeychainAccess2[KeychainAccess2["whenUnlockedThisDeviceOnly"] = 1] = "whenUnlockedThisDeviceOnly";
      KeychainAccess2[KeychainAccess2["afterFirstUnlock"] = 2] = "afterFirstUnlock";
      KeychainAccess2[KeychainAccess2["afterFirstUnlockThisDeviceOnly"] = 3] = "afterFirstUnlockThisDeviceOnly";
      KeychainAccess2[KeychainAccess2["whenPasscodeSetThisDeviceOnly"] = 4] = "whenPasscodeSetThisDeviceOnly";
    })(KeychainAccess || (KeychainAccess = {}));
    StorageError = class extends Error {
      constructor(message, code) {
        super(message);
        this.name = "StorageError";
        this.code = code;
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/base.js
function isStorageErrorType(value) {
  return value !== void 0 && Object.keys(StorageErrorType).includes(value);
}
function parseISODate(isoDate) {
  const match = isoDateRE.exec(isoDate);
  if (match) {
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10) - 1;
    const day = Number.parseInt(match[3], 10);
    const hour = Number.parseInt(match[4], 10);
    const minute = Number.parseInt(match[5], 10);
    const second = Number.parseInt(match[6], 10);
    const millis = Number.parseInt(match[7], 10);
    const epochTime = Date.UTC(year, month, day, hour, minute, second, millis);
    return new Date(epochTime);
  }
  return null;
}
var SecureStorageBase, isoDateRE;
var init_base = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/base.js"() {
    init_dist();
    init_definitions();
    SecureStorageBase = class _SecureStorageBase extends WebPlugin {
      constructor() {
        super(...arguments);
        this.prefix = "capacitor-storage_";
        this.sync = false;
        this.access = KeychainAccess.whenUnlocked;
      }
      async setSynchronize(sync) {
        this.sync = sync;
        if (Capacitor.getPlatform() === "ios") {
          return this.setSynchronizeKeychain({ sync });
        }
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
          if (error instanceof CapacitorException && isStorageErrorType(error.code)) {
            throw new StorageError(error.message, error.code);
          }
          throw error;
        }
      }
      async get(key, convertDate = true, sync) {
        if (key) {
          const { data } = await this.tryOperation(async () => this.internalGetItem({
            prefixedKey: this.prefixedKey(key),
            sync: sync !== null && sync !== void 0 ? sync : this.sync
          }));
          if (data === null) {
            return null;
          }
          if (convertDate) {
            const date = parseISODate(data);
            if (date) {
              return date;
            }
          }
          try {
            return JSON.parse(data);
          } catch (_a) {
            throw new StorageError("Invalid data", StorageErrorType.invalidData);
          }
        }
        return _SecureStorageBase.missingKey();
      }
      async getItem(key) {
        if (key) {
          const { data } = await this.tryOperation(async () => this.internalGetItem({
            prefixedKey: this.prefixedKey(key),
            sync: this.sync
          }));
          return data;
        }
        return null;
      }
      async set(key, data, convertDate = true, sync, access) {
        if (key) {
          let convertedData = data;
          if (convertDate && data instanceof Date) {
            convertedData = data.toISOString();
          }
          return this.tryOperation(async () => this.internalSetItem({
            prefixedKey: this.prefixedKey(key),
            data: JSON.stringify(convertedData),
            sync: sync !== null && sync !== void 0 ? sync : this.sync,
            access: access !== null && access !== void 0 ? access : this.access
          }));
        }
        return _SecureStorageBase.missingKey();
      }
      async setItem(key, value) {
        if (key) {
          return this.tryOperation(async () => this.internalSetItem({
            prefixedKey: this.prefixedKey(key),
            data: value,
            sync: this.sync,
            access: this.access
          }));
        }
        return _SecureStorageBase.missingKey();
      }
      async remove(key, sync) {
        if (key) {
          const { success } = await this.tryOperation(async () => this.internalRemoveItem({
            prefixedKey: this.prefixedKey(key),
            sync: sync !== null && sync !== void 0 ? sync : this.sync
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
        const prefix = this.checkPrefix(options.prefix);
        await this.tryOperation(async () => this.internalClearItemsWithPrefix({
          prefix,
          sync: this.sync
        }));
      }
      checkPrefix(prefix) {
        if (prefix.trim().length === 0) {
          throw new StorageError("Non-blank prefix provided", StorageErrorType.missingPrefix);
        }
        return prefix;
      }
      async keys(sync) {
        const { keys } = await this.tryOperation(async () => this.internalGetPrefixedKeys({
          prefix: this.prefix,
          sync: sync !== null && sync !== void 0 ? sync : this.sync
        }));
        const prefixLength = this.prefix.length;
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
    };
    isoDateRE = /^"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).(\d{3})Z"$/u;
  }
});

// mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/web.js
var web_exports = {};
__export(web_exports, {
  SecureStorageWeb: () => SecureStorageWeb
});
var SecureStorageWeb;
var init_web = __esm({
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
        const item = localStorage.getItem(options.prefixedKey);
        if (item !== null) {
          localStorage.removeItem(options.prefixedKey);
          return { success: true };
        }
        return { success: false };
      }
      async clear() {
        const { keys } = await this.internalGetPrefixedKeys({ prefix: this.prefix });
        for (const key of keys) {
          localStorage.removeItem(key);
        }
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalClearItemsWithPrefix(_options) {
        console.warn("internalClearItemsWithPrefix is native only");
      }
      // @native
      // eslint-disable-next-line @typescript-eslint/require-await
      async internalGetPrefixedKeys(options) {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key === null || key === void 0 ? void 0 : key.startsWith(options.prefix)) {
            keys.push(key);
          }
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
var SecureStorageNative;
var init_native = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/native.js"() {
    init_base();
    SecureStorageNative = class extends SecureStorageBase {
      constructor(capProxy) {
        super();
        const proxy3 = capProxy;
        this.setSynchronizeKeychain = proxy3.setSynchronizeKeychain;
        this.internalGetItem = proxy3.internalGetItem;
        this.internalSetItem = proxy3.internalSetItem;
        this.internalRemoveItem = proxy3.internalRemoveItem;
        this.internalClearItemsWithPrefix = proxy3.internalClearItemsWithPrefix;
        this.internalGetPrefixedKeys = proxy3.internalGetPrefixedKeys;
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
        return { success: true };
      }
      async clear(sync) {
        return this.tryOperation(async () => this.clearItemsWithPrefix({
          prefix: this.prefix,
          sync: sync !== null && sync !== void 0 ? sync : this.sync
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
var proxy;
var init_esm = __esm({
  "mobile/node_modules/@aparajita/capacitor-secure-storage/dist/esm/index.js"() {
    init_dist();
    init_definitions();
    proxy = registerPlugin("SecureStorage", {
      web: async () => {
        const module = await Promise.resolve().then(() => (init_web(), web_exports));
        return new module.SecureStorageWeb();
      },
      ios: async () => {
        const module = await Promise.resolve().then(() => (init_native(), native_exports));
        return new module.SecureStorageNative(proxy);
      },
      android: async () => {
        const module = await Promise.resolve().then(() => (init_native(), native_exports));
        return new module.SecureStorageNative(proxy);
      }
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/definitions.js
function isBiometryErrorType(value) {
  return typeof value === "string" && // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  Object.values(BiometryErrorType).includes(value);
}
var BiometryType, AndroidBiometryStrength, BiometryErrorType, BiometryError;
var init_definitions2 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/definitions.js"() {
    (function(BiometryType2) {
      BiometryType2[BiometryType2["none"] = 0] = "none";
      BiometryType2[BiometryType2["touchId"] = 1] = "touchId";
      BiometryType2[BiometryType2["faceId"] = 2] = "faceId";
      BiometryType2[BiometryType2["fingerprintAuthentication"] = 3] = "fingerprintAuthentication";
      BiometryType2[BiometryType2["faceAuthentication"] = 4] = "faceAuthentication";
      BiometryType2[BiometryType2["irisAuthentication"] = 5] = "irisAuthentication";
    })(BiometryType || (BiometryType = {}));
    (function(AndroidBiometryStrength2) {
      AndroidBiometryStrength2[AndroidBiometryStrength2["weak"] = 0] = "weak";
      AndroidBiometryStrength2[AndroidBiometryStrength2["strong"] = 1] = "strong";
    })(AndroidBiometryStrength || (AndroidBiometryStrength = {}));
    (function(BiometryErrorType2) {
      BiometryErrorType2["none"] = "";
      BiometryErrorType2["appCancel"] = "appCancel";
      BiometryErrorType2["authenticationFailed"] = "authenticationFailed";
      BiometryErrorType2["invalidContext"] = "invalidContext";
      BiometryErrorType2["notInteractive"] = "notInteractive";
      BiometryErrorType2["passcodeNotSet"] = "passcodeNotSet";
      BiometryErrorType2["systemCancel"] = "systemCancel";
      BiometryErrorType2["userCancel"] = "userCancel";
      BiometryErrorType2["userFallback"] = "userFallback";
      BiometryErrorType2["biometryLockout"] = "biometryLockout";
      BiometryErrorType2["biometryNotAvailable"] = "biometryNotAvailable";
      BiometryErrorType2["biometryNotEnrolled"] = "biometryNotEnrolled";
      BiometryErrorType2["noDeviceCredential"] = "noDeviceCredential";
    })(BiometryErrorType || (BiometryErrorType = {}));
    BiometryError = class _BiometryError extends Error {
      constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "BiometryError";
        Object.setPrototypeOf(this, _BiometryError.prototype);
      }
    };
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web-utils.js
function getBiometryName(type) {
  return kBiometryTypeNameMap[type] || "";
}
var kBiometryTypeNameMap;
var init_web_utils = __esm({
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
var AppWeb;
var init_web2 = __esm({
  "mobile/node_modules/@capacitor/app/dist/esm/web.js"() {
    init_dist();
    AppWeb = class extends WebPlugin {
      constructor() {
        super();
        this.handleVisibilityChange = () => {
          const data = {
            isActive: document.hidden !== true
          };
          this.notifyListeners("appStateChange", data);
          if (document.hidden) {
            this.notifyListeners("pause", null);
          } else {
            this.notifyListeners("resume", null);
          }
        };
        document.addEventListener("visibilitychange", this.handleVisibilityChange, false);
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
        return { isActive: document.hidden !== true };
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
var App;
var init_esm2 = __esm({
  "mobile/node_modules/@capacitor/app/dist/esm/index.js"() {
    init_dist();
    init_definitions3();
    App = registerPlugin("App", {
      web: () => Promise.resolve().then(() => (init_web2(), web_exports2)).then((m) => new m.AppWeb())
    });
  }
});

// mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/base.js
var BiometricAuthBase;
var init_base2 = __esm({
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
          if (isActive) {
            ;
            (async () => {
              try {
                const info = await this.checkBiometry();
                listener(info);
              } catch (error) {
                console.error(error);
              }
            })();
          }
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
var BiometricAuthWeb;
var init_web3 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/web.js"() {
    init_base2();
    init_definitions2();
    init_web_utils();
    BiometricAuthWeb = class extends BiometricAuthBase {
      constructor() {
        super(...arguments);
        this.biometryType = BiometryType.none;
        this.biometryTypes = [];
        this.biometryIsEnrolled = false;
        this.deviceIsSecure = false;
      }
      // On the web, return the fake biometry set by setBiometryType().
      async checkBiometry() {
        const hasBiometry = this.biometryType !== BiometryType.none;
        const available = hasBiometry && this.biometryIsEnrolled;
        let reason = "";
        let code = BiometryErrorType.none;
        if (!hasBiometry) {
          reason = "No biometry is available";
          code = BiometryErrorType.biometryNotAvailable;
        } else if (!this.biometryIsEnrolled) {
          reason = "Biometry is not enrolled";
          code = BiometryErrorType.biometryNotEnrolled;
        }
        return {
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
        const result = await this.checkBiometry();
        if (result.isAvailable && // oxlint-disable-next-line no-alert
        confirm(
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- we want to use the default value if options?.reason is an empty string
          (options === null || options === void 0 ? void 0 : options.reason) || `Authenticate with ${result.biometryTypes.map((type) => getBiometryName(type)).join(" or ")}?`
        )) {
          return;
        }
        if (options === null || options === void 0 ? void 0 : options.allowDeviceCredential) {
          if (result.deviceIsSecure) {
            if (confirm("Authenticate with device security?")) {
              return;
            }
            throw new BiometryError("User cancelled", BiometryErrorType.userCancel);
          } else if (result.isAvailable) {
            throw new BiometryError("Device is not secure", BiometryErrorType.noDeviceCredential);
          }
        } else if (!result.isAvailable) {
          throw result.biometryType === BiometryType.none ? new BiometryError("Biometry is not available", BiometryErrorType.biometryNotAvailable) : new BiometryError("Biometry is not enrolled", BiometryErrorType.biometryNotEnrolled);
        }
        throw new BiometryError("User cancelled", BiometryErrorType.userCancel);
      }
      // Web only, used for simulating biometric authentication.
      async setBiometryType(type) {
        if (type === void 0) {
          return;
        }
        const types = Array.isArray(type) ? type : [type];
        this.biometryTypes = [];
        this.biometryType = BiometryType.none;
        if (types.length === 0) {
          return;
        }
        if (isBiometryTypes(types)) {
          this.biometryType = types[0];
          if (this.biometryType !== BiometryType.none) {
            this.biometryTypes = types;
          }
        } else {
          for (const [i, theType] of types.entries()) {
            if (isBiometryType(theType)) {
              if (this.biometryType === BiometryType.none) {
                this.biometryTypes = [];
              } else {
                this.biometryTypes.push(theType);
              }
              if (i === 0) {
                this.biometryType = theType;
              }
            }
          }
        }
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
var BiometricAuthNative;
var init_native2 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/native.js"() {
    init_base2();
    init_definitions2();
    BiometricAuthNative = class extends BiometricAuthBase {
      constructor(capProxy) {
        super();
        const proxy3 = capProxy;
        this.checkBiometry = proxy3.checkBiometry;
        this.internalAuthenticate = proxy3.internalAuthenticate;
      }
      // @native
      async checkBiometry() {
        return {
          isAvailable: false,
          strongBiometryIsAvailable: false,
          biometryType: BiometryType.none,
          biometryTypes: [],
          deviceIsSecure: false,
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
var proxy2;
var init_esm3 = __esm({
  "mobile/node_modules/@aparajita/capacitor-biometric-auth/dist/esm/index.js"() {
    init_dist();
    init_definitions2();
    init_web_utils();
    proxy2 = registerPlugin("BiometricAuthNative", {
      web: async () => {
        const module = await Promise.resolve().then(() => (init_web3(), web_exports3));
        return new module.BiometricAuthWeb();
      },
      ios: async () => {
        const module = await Promise.resolve().then(() => (init_native2(), native_exports2));
        return new module.BiometricAuthNative(proxy2);
      },
      android: async () => {
        const module = await Promise.resolve().then(() => (init_native2(), native_exports2));
        return new module.BiometricAuthNative(proxy2);
      }
    });
  }
});

// mobile/plugins/dictation/src/core.js
var DICTATION_EVENTS, END_REASONS, ERROR_CODES;
var init_core2 = __esm({
  "mobile/plugins/dictation/src/core.js"() {
    DICTATION_EVENTS = Object.freeze(["partial", "final", "level", "end", "error"]);
    END_REASONS = Object.freeze(["done", "silence", "no-speech", "cancelled", "error"]);
    ERROR_CODES = Object.freeze([
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
var NOT_ON_WEB, DictationWeb;
var init_web4 = __esm({
  "mobile/plugins/dictation/src/web.js"() {
    init_dist();
    NOT_ON_WEB = "Dictation is in the Android and iPhone apps. The browser keyboard has its own dictation key.";
    DictationWeb = class extends WebPlugin {
      async available() {
        return { available: false, onDevice: false, serverAvailable: false, permission: "denied", platform: "web" };
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
var Dictation;
var init_src = __esm({
  "mobile/plugins/dictation/src/index.js"() {
    init_dist();
    init_core2();
    Dictation = registerPlugin("Dictation", {
      web: () => Promise.resolve().then(() => (init_web4(), web_exports4)).then((module) => new module.DictationWeb())
    });
  }
});

// mobile/plugins/isolated-preview/src/core.js
var MAX_HTML_BYTES, SANDBOX_POLICY;
var init_core3 = __esm({
  "mobile/plugins/isolated-preview/src/core.js"() {
    MAX_HTML_BYTES = 8 * 1024 * 1024;
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
var IsolatedPreviewWeb;
var init_web5 = __esm({
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
var IsolatedPreview;
var init_src2 = __esm({
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
var NOT_ON_WEB2, UnifiedPushWeb;
var init_web6 = __esm({
  "mobile/plugins/unifiedpush/src/web.js"() {
    init_dist();
    NOT_ON_WEB2 = "UnifiedPush is only in the Android app. The browser uses Web Push.";
    UnifiedPushWeb = class extends WebPlugin {
      async getState() {
        return { supported: false, distributor: null, endpoints: {}, failures: {}, registrations: [], visible: false };
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
        return { granted: false };
      }
      async getNotificationPermission() {
        return { granted: false };
      }
    };
  }
});

// mobile/plugins/unifiedpush/src/index.js
var UnifiedPush;
var init_src3 = __esm({
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
    const text = typeof result?.ScanResult === "string" ? result.ScanResult : "";
    return text ? { ok: true, text } : { ok: false, reason: "cancelled" };
  }
  const said = `${error?.code ?? ""} ${error?.message ?? error ?? ""}`;
  if (/permission|denied|not authori[sz]ed|restricted/i.test(said)) return { ok: false, reason: "denied" };
  if (/cancel|dismiss|closed/i.test(said)) return { ok: false, reason: "cancelled" };
  return { ok: false, reason: "failed" };
}
function buildNative(parts, { platform = "" } = {}) {
  const register = parts.registerPlugin;
  const scanner = register("CapacitorBarcodeScanner");
  const plugins = {
    App: register("App"),
    Haptics: register("Haptics"),
    Browser: register("Browser"),
    Share: register("Share"),
    Filesystem: register("Filesystem"),
    TextZoom: register("TextZoom"),
    Network: register("Network"),
    LocalNotifications: register("LocalNotifications"),
    PlenumPrivacy: register("PlenumPrivacy")
  };
  return {
    ...plugins,
    secureStorage: secureStorageAdapter(parts.SecureStorage),
    // Settings the shell wants for the keys: never synchronised to iCloud, and on this device only. On iOS the Keychain setting must hold:
    // when it cannot be set, this throws, and app.js treats a throwing loadPlugins as no secure storage, so no key is stored.
    async configureStorage() {
      await Promise.resolve(parts.SecureStorage.setSynchronize?.(false)).catch(() => {
      });
      if (platform !== "ios") return;
      if (typeof parts.SecureStorage.setDefaultKeychainAccess !== "function") throw new Error("keychain access cannot be set");
      await parts.SecureStorage.setDefaultKeychainAccess(1);
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
          const result = await scanner.scanBarcode({
            hint: QR_CODE_HINT,
            scanInstructions: " ",
            scanButton: false,
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
  const native = buildNative({ registerPlugin, WebView, SecureStorage: proxy, BiometricAuth: proxy2, Dictation, IsolatedPreview, UnifiedPush }, { platform: Capacitor.getPlatform() });
  await native.configureStorage();
  return native;
}
var REGISTERED_NAMES, QR_CODE_HINT, CAMERA_BACK, ORIENTATION_ADAPTIVE;
var init_native3 = __esm({
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
    ]);
    QR_CODE_HINT = 0;
    CAMERA_BACK = 1;
    ORIENTATION_ADAPTIVE = 3;
  }
});

// mobile/shell/channel.js
var CHANNEL_WORKER_NAME = "plenum-channel";
var utf8 = new TextEncoder();
function b64uToBytes(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
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
    myPriv: b64uToBytes(typeof record.myPriv === "string" ? record.myPriv : fail("locked")),
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
    const counter = store ? await store.raiseCounter(msg.id, msg.minimum) : msg.minimum;
    reply({ op: "counterSaved", rid: msg.rid, ok: true, counter });
  } catch {
    reply({ op: "counterSaved", rid: msg.rid, ok: false });
  }
}
function sendLockedStop({ record, store = null, createWorker = defaultCreateWorker, onStopState = () => {
} } = {}) {
  const validKey = typeof record?.stopKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey);
  const validId = /^[0-9a-f]{64}$/.test(String(record?.myDeviceId ?? ""));
  if (!record || typeof record.id !== "string" || !validKey || !validId) return Promise.reject(coded("no-key"));
  const worker = createWorker();
  const sid = 1;
  let settled = false;
  return new Promise((resolve, reject) => {
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      setTimeout(() => {
        try {
          worker.terminate();
        } catch {
        }
      }, 0);
      fn(value);
    };
    worker.onmessage = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.op === "counter") {
        answerCounter(store, msg, (reply) => worker.postMessage(reply));
      } else if (msg.op === "stopState") {
        if (msg.sid === sid && !settled) {
          try {
            onStopState({ sid, state: msg.state });
          } catch {
          }
        }
      } else if (msg.op === "stopAck" && msg.sid === sid) {
        if (msg.error) end(reject, coded(msg.error, msg.error));
        else end(resolve, msg.ack);
      }
    };
    worker.onerror = () => end(reject, coded("unreachable"));
    worker.postMessage({
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
  if (!computer || typeof computer.id !== "string") throw new TypeError("openChannel needs a computer record");
  const worker = createWorker();
  let seq = 0;
  let closed = false;
  let state = { status: "connecting", carrier: null, desktopName: "", lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null, computerId: computer.id, stopsPending: 0 };
  let hello = null;
  const reqs = /* @__PURE__ */ new Map();
  const stops = /* @__PURE__ */ new Map();
  const stateSubs = /* @__PURE__ */ new Set();
  const eventSubs = /* @__PURE__ */ new Set();
  const stopSubs = /* @__PURE__ */ new Set();
  const helloSubs = /* @__PURE__ */ new Set();
  const post = (msg, transfer = []) => worker.postMessage(msg, transfer);
  const notify = (set, value) => {
    for (const fn of Array.from(set)) {
      try {
        fn(value);
      } catch {
      }
    }
  };
  const endRequest = (msg) => {
    const entry = reqs.get(msg.sid);
    if (!entry) return;
    reqs.delete(msg.sid);
    entry.detach?.();
    const controller = entry.controller;
    if (msg.error || msg.cancelled) {
      const code = msg.cancelled ? "cancelled" : msg.error;
      const err = coded(code, code);
      if (!entry.head) entry.reject(err);
      try {
        controller?.error(err);
      } catch {
      }
    } else {
      try {
        controller?.close();
      } catch {
      }
    }
  };
  worker.onmessage = (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.op) {
      case "state":
        state = msg.state;
        notify(stateSubs, state);
        if (state.status === "closed") {
          setTimeout(() => {
            try {
              worker.terminate();
            } catch {
            }
          }, 0);
        }
        return;
      case "hello":
        hello = msg.hello;
        notify(helloSubs, hello);
        return;
      case "event":
        notify(eventSubs, msg.event);
        return;
      case "res": {
        const entry = reqs.get(msg.sid);
        if (!entry || entry.head) return;
        entry.head = true;
        entry.resolve({ status: msg.status, headers: msg.headers ?? {}, body: entry.stream, id: msg.sid, cancel: () => cancel(msg.sid) });
        return;
      }
      case "data": {
        const entry = reqs.get(msg.sid);
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
        const waiter = stops.get(msg.sid);
        if (!waiter) return;
        stops.delete(msg.sid);
        if (msg.error) waiter.reject(coded(msg.error, msg.error));
        else waiter.resolve(msg.ack);
        return;
      }
      case "counter":
        answerCounter(store, msg, (reply) => post(reply));
        return;
      case "patch":
        if (store) store.patchComputer(msg.id, msg.patch).catch(() => {
        });
        return;
      case "log":
        onWorkerError(String(msg.line ?? ""));
        return;
      default:
        return;
    }
  };
  worker.onerror = (event) => {
    onWorkerError(String(event?.message ?? "worker error"));
    closed = true;
    for (const [sid, waiter] of Array.from(stops)) {
      stops.delete(sid);
      waiter.reject(coded("unreachable"));
    }
    for (const sid of Array.from(reqs.keys())) endRequest({ sid, error: "lost" });
    try {
      worker.terminate();
    } catch {
    }
  };
  const request = ({ method = "GET", path = "/", headers = {} } = {}, body = null, { signal = null, scope = "page" } = {}) => {
    if (closed) return Promise.reject(coded("closed"));
    if (signal?.aborted) return Promise.reject(coded("cancelled"));
    const sid = ++seq;
    let controller = null;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        cancel(sid);
      }
    });
    return new Promise((resolve, reject) => {
      const entry = { sid, head: false, resolve, reject, stream, controller: null, detach: null };
      reqs.set(sid, entry);
      entry.controller = controller;
      if (signal) {
        const onAbort = () => {
          if (reqs.get(sid) !== entry) return;
          reqs.delete(sid);
          post({ op: "cancel", sid });
          const err = coded("cancelled");
          if (!entry.head) entry.reject(err);
          try {
            controller?.error(err);
          } catch {
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      let bytes = null;
      if (body !== null && body !== void 0) {
        if (typeof body === "string") bytes = utf8.encode(body);
        else if (body instanceof Uint8Array) bytes = body.slice();
        else bytes = new Uint8Array(body);
      }
      post({ op: "request", sid, method, path, headers, scope: scope === "shell" ? "shell" : "page", body: bytes }, bytes ? [bytes.buffer] : []);
    });
  };
  const cancel = (sid) => {
    if (closed) return false;
    post({ op: "cancel", sid });
    return true;
  };
  const stop = (project = null) => {
    if (closed) return Promise.reject(coded("closed"));
    const sid = ++seq;
    return new Promise((resolve, reject) => {
      stops.set(sid, { resolve, reject });
      post({ op: "stop", sid, project: project ?? null });
    });
  };
  const api = {
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
      eventSubs.add(fn);
      return () => eventSubs.delete(fn);
    },
    onStopState(fn) {
      stopSubs.add(fn);
      return () => stopSubs.delete(fn);
    },
    // fn(hello) each time the computer answers a session with HELLO (after every reconnect too).
    onHello(fn) {
      helloSubs.add(fn);
      if (hello) {
        try {
          fn(hello);
        } catch {
        }
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
      if (!closed) post({ op: "reconnect" });
    },
    close() {
      if (closed) return;
      closed = true;
      post({ op: "close" });
      setTimeout(() => {
        try {
          worker.terminate();
        } catch {
        }
      }, 2e3);
    }
  };
  post({
    op: "init",
    computer: workerComputer(computer, carriers),
    device,
    caps: caps ?? void 0,
    hasStopKey: Boolean(computer.stopKey && computer.myDeviceId)
  });
  return api;
}

// mobile/shell/store.js
var STORE_DB = "plenum-shell";
var STORE_OBJECT = "kv";
var SECURE_PREFIX = "plenum.";
function createIdbKv({ indexedDB: factory, name = STORE_DB } = {}) {
  if (!factory || typeof factory.open !== "function") throw new TypeError("createIdbKv needs an IndexedDB factory");
  let opening = null;
  const database = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(name, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_OBJECT)) db.createObjectStore(STORE_OBJECT);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      });
      opening.catch(() => {
        opening = null;
      });
    }
    return opening;
  };
  const run = async (mode, fn) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_OBJECT, mode, mode === "readwrite" ? { durability: "strict" } : void 0);
      const os = tx.objectStore(STORE_OBJECT);
      let result;
      const req = fn(os);
      if (req) req.onsuccess = () => {
        result = req.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  };
  return {
    kind: "web",
    get: async (key) => {
      const value = await run("readonly", (os) => os.get(key));
      return value === void 0 ? void 0 : value;
    },
    put: (key, value) => run("readwrite", (os) => os.put(value, key)).then(() => void 0),
    delete: (key) => run("readwrite", (os) => os.delete(key)).then(() => void 0),
    keys: async () => {
      const list = await run("readonly", (os) => os.getAllKeys());
      return Array.from(list ?? []).map(String);
    }
  };
}
function createSecureKv({ plugin, prefix = SECURE_PREFIX } = {}) {
  if (!plugin || typeof plugin.setItem !== "function") throw new TypeError("createSecureKv needs the SecureStorage plugin");
  return {
    kind: "native",
    get: async (key) => {
      const answer = await plugin.getItem({ key: prefix + key });
      const text = answer?.value;
      return text === null || text === void 0 ? void 0 : JSON.parse(String(text));
    },
    put: async (key, value) => {
      await plugin.setItem({ key: prefix + key, value: JSON.stringify(value) });
    },
    delete: async (key) => {
      await plugin.removeItem({ key: prefix + key });
    },
    keys: async () => {
      const answer = await plugin.keys();
      return (answer?.keys ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    }
  };
}
var isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function publicComputer(record) {
  if (!isObject(record)) return null;
  return {
    id: record.id,
    name: record.name ?? "",
    carriers: Array.isArray(record.carriers) ? record.carriers.map((c) => ({ kind: c.kind })) : [],
    lastCarrier: record.lastCarrier ?? null,
    lastSeen: record.lastSeen ?? null,
    pairedAt: record.pairedAt ?? null,
    counter: Number.isSafeInteger(record.counter) ? record.counter : 0,
    // Whether this phone holds the computer's Stop key and its own id there (C5): Stop can then be sent without unlocking.
    stopReady: typeof record.stopKey === "string" && /^[A-Za-z0-9_-]{43}$/.test(record.stopKey) && /^[0-9a-f]{64}$/.test(String(record.myDeviceId ?? ""))
  };
}
function createStore({ kv } = {}) {
  if (!kv || typeof kv.get !== "function") throw new TypeError("createStore needs a key-value back end");
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {
    });
    return run;
  };
  const readComputers = async () => {
    const list = await kv.get("computers");
    return Array.isArray(list) ? list.filter(isObject) : [];
  };
  const readCounter = async (id) => {
    const value = await kv.get(`ctr:${id}`);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const store = {
    kind: kv.kind,
    // Every record, keys included. Only the unlock path and the connect path may use these.
    list: () => serial(readComputers),
    get: (id) => serial(async () => (await readComputers()).find((c) => c.id === id) ?? null),
    publicList: () => serial(async () => (await readComputers()).map(publicComputer)),
    put: (record) => serial(async () => {
      if (!isObject(record) || typeof record.id !== "string" || !record.id) throw new TypeError("a computer record needs an id");
      const all = await readComputers();
      const next = all.some((c) => c.id === record.id) ? all.map((c) => c.id === record.id ? record : c) : [...all, record];
      await kv.put("computers", next);
      return record;
    }),
    // Merges fields into a record. Keys in `fields` replace the record's value; a null value removes the field.
    patchComputer: (id, fields) => serial(async () => {
      const all = await readComputers();
      const found = all.find((c) => c.id === id);
      if (!found) return null;
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (v === null) delete found[k];
        else found[k] = v;
      }
      await kv.put("computers", all);
      return publicComputer(found);
    }),
    remove: (id) => serial(async () => {
      const all = await readComputers();
      await kv.put("computers", all.filter((c) => c.id !== id));
      return true;
    }),
    counter: (id) => serial(() => readCounter(id)),
    // Stores a counter of at least `minimum`, never lower than what is stored, and returns the value stored. The handshake only
    // goes out with a value this returns (channel.js answerCounter).
    raiseCounter: (id, minimum) => serial(async () => {
      const current = await readCounter(id);
      const next = Math.max(current, Number(minimum) - 1) + 1;
      if (!Number.isSafeInteger(next)) throw new RangeError("counter out of range");
      await kv.put(`ctr:${id}`, next);
      const all = await readComputers();
      const found = all.find((c) => c.id === id);
      if (found) {
        found.counter = next;
        await kv.put("computers", all);
      }
      return next;
    }),
    meta: {
      get: (name) => serial(() => kv.get(`meta:${name}`)),
      put: (name, value) => serial(() => kv.put(`meta:${name}`, value)),
      remove: (name) => serial(() => kv.delete(`meta:${name}`))
    },
    // Used by the Node suites and the debug console: what the store holds under which keys (names only).
    keys: () => serial(() => kv.keys())
  };
  return store;
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
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new TypeError("expected hash wrapped by utils.createHasher");
  anumber(h.outputLen);
  anumber(h.blockLen);
  if (h.outputLen < 1 || h.blockLen < 1)
    throw new Error("hash blockLen / outputLen must be >= 1");
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function utf8ToBytes(str) {
  if (typeof str !== "string")
    throw new TypeError("string expected");
  const encoded = new TextEncoder().encode(str);
  try {
    return new Uint8Array(encoded);
  } finally {
    clean(encoded);
  }
}
function kdfInputToBytes(data, errorTitle = "") {
  if (typeof data === "string")
    return utf8ToBytes(data);
  return abytes(data, void 0, errorTitle);
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  anumber(bytesLength, "bytesLength");
  const cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
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
    __publicField(this, "canXOF", false);
    __publicField(this, "finished", false);
    __publicField(this, "destroyed", false);
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("expected Hash instance");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const buf = out.subarray(0, this.outputLen);
    this.iHash.digestInto(buf);
    this.oHash.update(buf);
    this.oHash.digestInto(buf);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen, canXOF } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.canXOF = canXOF;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = /* @__PURE__ */ (() => {
  const hmac_ = ((hash, key, message) => new _HMAC(hash, key).update(message).digest());
  hmac_.create = (hash, key) => new _HMAC(hash, key);
  return hmac_;
})();

// mobile/node_modules/@noble/hashes/pbkdf2.js
function pbkdf2Init(hash, _password, _salt, _opts) {
  ahash(hash);
  const opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts);
  const { c, dkLen, asyncTick } = opts;
  anumber(c, "c");
  anumber(dkLen, "dkLen");
  anumber(asyncTick, "asyncTick");
  if (c < 1)
    throw new Error('"c" (iterations) must be >= 1');
  if (dkLen < 1)
    throw new Error('"dkLen" must be >= 1');
  if (dkLen > (2 ** 32 - 1) * hash.outputLen)
    throw new Error("derived key too long");
  const p = kdfInputToBytes(_password, "password");
  try {
    const s = kdfInputToBytes(_salt, "salt");
    try {
      const DK = new Uint8Array(dkLen);
      const { iHash, oHash, outputLen } = hmac.create(hash, p);
      const u = new Uint8Array(outputLen);
      const eng = pbkdf2Engine(iHash, oHash, s, u);
      return { c, dkLen, asyncTick, DK, outputLen, eng };
    } finally {
      if (typeof _salt === "string")
        clean(s);
    }
  } finally {
    if (typeof _password === "string")
      clean(p);
  }
}
function pbkdf2Engine(iHash, oHash, salt, u) {
  const counter = new Uint8Array(4);
  const view = createView(counter);
  const salted = iHash._cloneInto().update(salt);
  const work = oHash._cloneInto();
  const iClone = iHash._cloneInto;
  const oClone = oHash._cloneInto;
  return {
    u1: (ti, Ti) => {
      view.setInt32(0, ti, false);
      salted._cloneInto(work).update(counter).digestInto(u);
      oHash._cloneInto(work).update(u).digestInto(u);
      Ti.set(u.subarray(0, Ti.length));
    },
    // Whole `F` inner loop for the sync variant: one optimized function owns the hot loop.
    rounds: (c, Ti) => {
      for (let ui = 1; ui < c; ui++) {
        iClone.call(iHash, work).update(u).digestInto(u);
        oClone.call(oHash, work).update(u).digestInto(u);
        for (let i = 0; i < Ti.length; i++)
          Ti[i] ^= u[i];
      }
    },
    output: (DK) => {
      iHash.destroy();
      oHash.destroy();
      salted.destroy();
      work.destroy();
      clean(u);
      return DK;
    }
  };
}
function pbkdf2(hash, password, salt, opts) {
  const { c, dkLen, DK, outputLen, eng } = pbkdf2Init(hash, password, salt, opts);
  for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += outputLen) {
    const Ti = DK.subarray(pos, pos + outputLen);
    eng.u1(ti, Ti);
    eng.rounds(c, Ti);
  }
  return eng.output(DK);
}

// mobile/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE2) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE2 ? l : h, isLE2);
  view.setUint32(byteOffset + 4, isLE2 ? h : l, isLE2);
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
    __publicField(this, "canXOF", false);
    __publicField(this, "padOffset");
    __publicField(this, "isLE");
    // For partial updates less than block size
    __publicField(this, "buffer");
    __publicField(this, "view");
    __publicField(this, "finished", false);
    __publicField(this, "length", 0);
    __publicField(this, "pos", 0);
    __publicField(this, "destroyed", false);
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE2);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
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
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
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
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
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
  if (typeof value !== "boolean")
    throw new TypeError(atitle2(title) + "expected boolean, got type=" + typeof value);
  return value;
}
function anumber2(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle2(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle2(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes2(value, length, title = "") {
  if (isBytes2(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber2(length, "length");
  const bytes = isBytes2(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle2(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput2(out, instance) {
  abytes2(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function aoutput32(out, instance) {
  aoutput2(out, instance);
  if (!isAligned32(out))
    throw new Error("invalid output, must be aligned");
}
function u8(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean2(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView2(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word) {
  return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
}
var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n) >>> 0;
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function equalBytes(a, b) {
  a = abytes2(a);
  b = abytes2(b);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function wrapMacConstructor(keyLen, macCons, fromMsg) {
  const mac = macCons;
  const getArgs = fromMsg || (() => []);
  const macC = (msg, key) => mac(key, ...getArgs(msg)).update(msg).digest();
  const tmp = mac(new Uint8Array(keyLen), ...getArgs(new Uint8Array(0)));
  macC.outputLen = tmp.outputLen;
  macC.blockLen = tmp.blockLen;
  macC.create = (key, ...args) => mac(key, ...args);
  return macC;
}
var wrapCipher = /* @__NO_SIDE_EFFECTS__ */ (params, constructor) => {
  function wrappedCipher(key, ...args) {
    abytes2(key, void 0, "key");
    if (params.nonceLength !== void 0) {
      const nonce = args[0];
      abytes2(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
    }
    const tagl = params.tagLength;
    const aadStart = params.nonceLength !== void 0 ? 1 : 0;
    if (!params.withAAD) {
      for (let i = aadStart; i < args.length; i++)
        if (isBytes2(args[i]))
          throw new Error("AAD not supported");
    }
    if (params.withAAD && args[aadStart] !== void 0)
      abytes2(args[aadStart], void 0, "AAD");
    const cipher = constructor(key, ...args);
    const checkOutput = (fnLength, output) => {
      if (output !== void 0) {
        if (fnLength !== 2)
          throw new Error("cipher output not supported");
        abytes2(output, void 0, "output");
      }
    };
    let called = false;
    const wrCipher = {
      encrypt(data, output) {
        if (called)
          throw new Error("cannot encrypt() twice with same key + nonce");
        called = true;
        abytes2(data, void 0, "data");
        checkOutput(cipher.encrypt.length, output);
        return cipher.encrypt(data, output);
      },
      decrypt(data, output) {
        abytes2(data, void 0, "data");
        if (tagl && data.length < tagl)
          throw new Error('"ciphertext" expected length >= tagLength=' + tagl);
        checkOutput(cipher.decrypt.length, output);
        return cipher.decrypt(data, output);
      }
    };
    return wrCipher;
  }
  Object.assign(wrappedCipher, params);
  return wrappedCipher;
};
function getOutput(expectedLength, out, onlyAligned = true) {
  if (out === void 0)
    return new Uint8Array(expectedLength);
  abytes2(out, expectedLength, "output");
  if (onlyAligned && !isAligned32(out))
    throw new Error("invalid output, must be aligned");
  return out;
}
function u64Lengths(dataLength, aadLength, isLE2) {
  anumber2(dataLength);
  anumber2(aadLength);
  abool(isLE2);
  const num = new Uint8Array(16);
  const view = createView2(num);
  view.setBigUint64(0, BigInt(aadLength), isLE2);
  view.setBigUint64(8, BigInt(dataLength), isLE2);
  return num;
}
function isAligned32(bytes) {
  return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
  return Uint8Array.from(abytes2(bytes));
}

// mobile/node_modules/@noble/ciphers/_polyval.js
var BLOCK_SIZE = 16;
var ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
var ZEROS32 = /* @__PURE__ */ u32(ZEROS16);
var POLY = 225;
var mul2 = (s0, s1, s2, s3) => {
  const hiBit = s3 & 1;
  return {
    s3: s2 << 31 | s3 >>> 1,
    s2: s1 << 31 | s2 >>> 1,
    s1: s0 << 31 | s1 >>> 1,
    // NIST SP 800-38D §6.3 applies `V >> 1` and XORs R on carry. In this
    // 4x32-bit split, R = 0xe1 || 0^120 lives in the top byte of s0.
    s0: s0 >>> 1 ^ POLY << 24 & -(hiBit & 1)
    // reduce % poly
  };
};
var swapLE = (n) => (n >>> 0 & 255) << 24 | (n >>> 8 & 255) << 16 | (n >>> 16 & 255) << 8 | n >>> 24 & 255 | 0;
var estimateWindow = (bytes) => {
  if (bytes > 64 * 1024)
    return 8;
  if (bytes > 1024)
    return 4;
  return 2;
};
var GHASH = class {
  // We select bits per window adaptively based on expectedLength
  constructor(key, expectedLength) {
    __publicField(this, "blockLen", BLOCK_SIZE);
    __publicField(this, "outputLen", BLOCK_SIZE);
    __publicField(this, "s0", 0);
    __publicField(this, "s1", 0);
    __publicField(this, "s2", 0);
    __publicField(this, "s3", 0);
    __publicField(this, "finished", false);
    __publicField(this, "destroyed", false);
    __publicField(this, "t");
    __publicField(this, "W");
    __publicField(this, "windowSize");
    abytes2(key, 16, "key");
    key = copyBytes(key);
    const kView = createView2(key);
    let k0 = kView.getUint32(0, false);
    let k1 = kView.getUint32(4, false);
    let k2 = kView.getUint32(8, false);
    let k3 = kView.getUint32(12, false);
    const doubles = [];
    for (let i = 0; i < 128; i++) {
      doubles.push({ s0: swapLE(k0), s1: swapLE(k1), s2: swapLE(k2), s3: swapLE(k3) });
      ({ s0: k0, s1: k1, s2: k2, s3: k3 } = mul2(k0, k1, k2, k3));
    }
    const W = estimateWindow(expectedLength || 1024);
    if (![1, 2, 4, 8].includes(W))
      throw new Error("ghash: invalid window size, expected 2, 4 or 8");
    this.W = W;
    const bits = 128;
    const windows = bits / W;
    const windowSize = this.windowSize = 2 ** W;
    const items = [];
    for (let w = 0; w < windows; w++) {
      for (let byte = 0; byte < windowSize; byte++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let j = 0; j < W; j++) {
          const bit = byte >>> W - j - 1 & 1;
          if (!bit)
            continue;
          const { s0: d0, s1: d1, s2: d2, s3: d3 } = doubles[W * w + j];
          s0 ^= d0, s1 ^= d1, s2 ^= d2, s3 ^= d3;
        }
        items.push({ s0, s1, s2, s3 });
      }
    }
    this.t = items;
  }
  _updateBlock(s0, s1, s2, s3) {
    s0 ^= this.s0, s1 ^= this.s1, s2 ^= this.s2, s3 ^= this.s3;
    const { W, t, windowSize } = this;
    let o0 = 0, o1 = 0, o2 = 0, o3 = 0;
    const mask = (1 << W) - 1;
    let w = 0;
    for (const num of [s0, s1, s2, s3]) {
      for (let bytePos = 0; bytePos < 4; bytePos++) {
        const byte = num >>> 8 * bytePos & 255;
        for (let bitPos = 8 / W - 1; bitPos >= 0; bitPos--) {
          const bit = byte >>> W * bitPos & mask;
          const { s0: e0, s1: e1, s2: e2, s3: e3 } = t[w * windowSize + bit];
          o0 ^= e0, o1 ^= e1, o2 ^= e2, o3 ^= e3;
          w += 1;
        }
      }
    }
    this.s0 = o0;
    this.s1 = o1;
    this.s2 = o2;
    this.s3 = o3;
  }
  update(data) {
    aexists2(this);
    abytes2(data);
    data = copyBytes(data);
    const b32 = u32(data);
    const blocks = Math.floor(data.length / BLOCK_SIZE);
    const left = data.length % BLOCK_SIZE;
    for (let i = 0; i < blocks; i++) {
      this._updateBlock(swap8IfBE(b32[i * 4 + 0]), swap8IfBE(b32[i * 4 + 1]), swap8IfBE(b32[i * 4 + 2]), swap8IfBE(b32[i * 4 + 3]));
    }
    if (left) {
      ZEROS16.set(data.subarray(blocks * BLOCK_SIZE));
      this._updateBlock(swap8IfBE(ZEROS32[0]), swap8IfBE(ZEROS32[1]), swap8IfBE(ZEROS32[2]), swap8IfBE(ZEROS32[3]));
      clean2(ZEROS32);
    }
    return this;
  }
  destroy() {
    this.destroyed = true;
    const { t } = this;
    for (const elm of t) {
      elm.s0 = 0, elm.s1 = 0, elm.s2 = 0, elm.s3 = 0;
    }
  }
  digestInto(out) {
    aexists2(this);
    aoutput32(out, this);
    this.finished = true;
    const { s0, s1, s2, s3 } = this;
    const o32 = u32(out);
    o32[0] = s0;
    o32[1] = s1;
    o32[2] = s2;
    o32[3] = s3;
    if (!isLE)
      swap32IfBE(o32.subarray(0, BLOCK_SIZE / 4));
  }
  digest() {
    const res = new Uint8Array(BLOCK_SIZE);
    this.digestInto(res);
    this.destroy();
    return res;
  }
};
var ghash = /* @__PURE__ */ wrapMacConstructor(16, (key, expectedLength) => new GHASH(key, expectedLength), (msg) => [msg.length]);

// mobile/node_modules/@noble/ciphers/aes.js
var BLOCK_SIZE2 = 16;
var BLOCK_SIZE32 = 4;
var EMPTY_BLOCK = /* @__PURE__ */ new Uint8Array(BLOCK_SIZE2);
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
  for (; b > 0; b >>= 1) {
    res ^= a & -(b & 1);
    a = mul22(a);
  }
  return res;
}
var sbox = /* @__PURE__ */ (() => {
  const t = new Uint8Array(256);
  for (let i = 0, x = 1; i < 256; i++, x ^= mul22(x))
    t[i] = x;
  const box = new Uint8Array(256);
  box[0] = 99;
  for (let i = 0; i < 255; i++) {
    let x = t[255 - i];
    x |= x << 8;
    box[t[i]] = (x ^ x >> 4 ^ x >> 5 ^ x >> 6 ^ x >> 7 ^ 99) & 255;
  }
  clean2(t);
  return box;
})();
var rotr32_8 = (n) => n << 24 | n >>> 8;
var rotl32_8 = (n) => n << 8 | n >>> 24;
function genTtable(sbox2, fn) {
  if (sbox2.length !== 256)
    throw new Error("wrong sbox length");
  const T0 = new Uint32Array(256).map((_, j) => fn(sbox2[j]));
  const T1 = T0.map(rotl32_8);
  const T2 = T1.map(rotl32_8);
  const T3 = T2.map(rotl32_8);
  const T01 = new Uint32Array(256 * 256);
  const T23 = new Uint32Array(256 * 256);
  const sbox22 = new Uint16Array(256 * 256);
  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 256; j++) {
      const idx = i * 256 + j;
      T01[idx] = T0[i] ^ T1[j];
      T23[idx] = T2[i] ^ T3[j];
      sbox22[idx] = sbox2[i] << 8 | sbox2[j];
    }
  }
  return { sbox: sbox2, sbox2: sbox22, T0, T1, T2, T3, T01, T23 };
}
var tableEncoding = /* @__PURE__ */ genTtable(sbox, (s) => mul(s, 3) << 24 | s << 16 | s << 8 | mul(s, 2));
var xPowers = /* @__PURE__ */ (() => {
  const p = new Uint8Array(16);
  for (let i = 0, x = 1; i < 16; i++, x = mul22(x))
    p[i] = x;
  return p;
})();
function expandKeyLE(key) {
  abytes2(key);
  const len = key.length;
  validateKeyLength(key);
  const { sbox2 } = tableEncoding;
  const toClean = [];
  if (!isLE || !isAligned32(key))
    toClean.push(key = copyBytes(key));
  const k32 = swap32IfBE(u32(key));
  const Nk = k32.length;
  const subByte = (n) => applySbox(sbox2, n, n, n, n);
  const xk = new Uint32Array(len + 28);
  xk.set(k32);
  for (let i = Nk; i < xk.length; i++) {
    let t = xk[i - 1];
    if (i % Nk === 0)
      t = subByte(rotr32_8(t)) ^ xPowers[i / Nk - 1];
    else if (Nk > 6 && i % Nk === 4)
      t = subByte(t);
    xk[i] = xk[i - Nk] ^ t;
  }
  clean2(...toClean);
  return xk;
}
function apply0123(T01, T23, s0, s1, s2, s3) {
  return T01[s0 << 8 & 65280 | s1 >>> 8 & 255] ^ T23[s2 >>> 8 & 65280 | s3 >>> 24 & 255];
}
function applySbox(sbox2, s0, s1, s2, s3) {
  return sbox2[s0 & 255 | s1 & 65280] | sbox2[s2 >>> 16 & 255 | s3 >>> 16 & 65280] << 16;
}
function encrypt(xk, s0, s1, s2, s3) {
  const { sbox2, T01, T23 } = tableEncoding;
  let k = 0;
  s0 ^= xk[k++], s1 ^= xk[k++], s2 ^= xk[k++], s3 ^= xk[k++];
  const rounds = xk.length / 4 - 2;
  for (let i = 0; i < rounds; i++) {
    const t02 = xk[k++] ^ apply0123(T01, T23, s0, s1, s2, s3);
    const t12 = xk[k++] ^ apply0123(T01, T23, s1, s2, s3, s0);
    const t22 = xk[k++] ^ apply0123(T01, T23, s2, s3, s0, s1);
    const t32 = xk[k++] ^ apply0123(T01, T23, s3, s0, s1, s2);
    s0 = t02, s1 = t12, s2 = t22, s3 = t32;
  }
  const t0 = xk[k++] ^ applySbox(sbox2, s0, s1, s2, s3);
  const t1 = xk[k++] ^ applySbox(sbox2, s1, s2, s3, s0);
  const t2 = xk[k++] ^ applySbox(sbox2, s2, s3, s0, s1);
  const t3 = xk[k++] ^ applySbox(sbox2, s3, s0, s1, s2);
  return { s0: t0, s1: t1, s2: t2, s3: t3 };
}
function ctr32(xk, isLE2, nonce, src, dst) {
  abytes2(nonce, BLOCK_SIZE2, "nonce");
  abytes2(src);
  dst = getOutput(src.length, dst);
  const ctr = nonce;
  const c32 = u32(ctr);
  const view = createView2(ctr);
  const src32 = u32(src);
  const dst32 = u32(dst);
  const ctrPos = isLE2 ? 0 : 12;
  const srcLen = src.length;
  let ctrNum = view.getUint32(ctrPos, isLE2);
  for (let i = 0; i + 4 <= src32.length; i += 4) {
    const { s0, s1, s2, s3 } = encrypt(xk, swap8IfBE(c32[0]), swap8IfBE(c32[1]), swap8IfBE(c32[2]), swap8IfBE(c32[3]));
    dst32[i + 0] = src32[i + 0] ^ swap8IfBE(s0);
    dst32[i + 1] = src32[i + 1] ^ swap8IfBE(s1);
    dst32[i + 2] = src32[i + 2] ^ swap8IfBE(s2);
    dst32[i + 3] = src32[i + 3] ^ swap8IfBE(s3);
    ctrNum = ctrNum + 1 >>> 0;
    view.setUint32(ctrPos, ctrNum, isLE2);
  }
  const start = BLOCK_SIZE2 * Math.floor(src32.length / BLOCK_SIZE32);
  if (start < srcLen) {
    const { s0, s1, s2, s3 } = encrypt(xk, swap8IfBE(c32[0]), swap8IfBE(c32[1]), swap8IfBE(c32[2]), swap8IfBE(c32[3]));
    const b32 = new Uint32Array([s0, s1, s2, s3]);
    swap32IfBE(b32);
    const buf = u8(b32);
    for (let i = start, pos = 0; i < srcLen; i++, pos++)
      dst[i] = src[i] ^ buf[pos];
    clean2(b32);
  }
  return dst;
}
function computeTag(fn, isLE2, key, data, AAD) {
  const aadLength = AAD ? AAD.length : 0;
  const h = fn.create(key, data.length + aadLength);
  if (AAD)
    h.update(AAD);
  const num = u64Lengths(8 * data.length, 8 * aadLength, isLE2);
  h.update(data);
  h.update(num);
  const res = h.digest();
  clean2(num);
  return res;
}
var gcm = /* @__PURE__ */ wrapCipher({ blockSize: 16, nonceLength: 12, tagLength: 16, withAAD: true, varSizeNonce: true }, function aesgcm(key, nonce, AAD) {
  if (nonce.length < 8)
    throw new Error("aes/gcm: invalid nonce length");
  const tagLength = 16;
  function _computeTag(authKey, tagMask, data) {
    const tag = computeTag(ghash, false, authKey, data, AAD);
    for (let i = 0; i < tagMask.length; i++)
      tag[i] ^= tagMask[i];
    return tag;
  }
  function deriveKeys() {
    const xk = expandKeyLE(key);
    const authKey = EMPTY_BLOCK.slice();
    const counter = EMPTY_BLOCK.slice();
    ctr32(xk, false, counter, counter, authKey);
    if (nonce.length === 12) {
      counter.set(nonce);
    } else {
      const nonceLen = EMPTY_BLOCK.slice();
      const view = createView2(nonceLen);
      view.setBigUint64(8, BigInt(nonce.length * 8), false);
      const g = ghash.create(authKey).update(nonce).update(nonceLen);
      g.digestInto(counter);
      g.destroy();
    }
    const tagMask = ctr32(xk, false, counter, EMPTY_BLOCK);
    return { xk, authKey, counter, tagMask };
  }
  return {
    encrypt(plaintext) {
      const { xk, authKey, counter, tagMask } = deriveKeys();
      const out = new Uint8Array(plaintext.length + tagLength);
      const toClean = [xk, authKey, counter, tagMask];
      if (!isAligned32(plaintext))
        toClean.push(plaintext = copyBytes(plaintext));
      ctr32(xk, false, counter, plaintext, out.subarray(0, plaintext.length));
      const tag = _computeTag(authKey, tagMask, out.subarray(0, out.length - tagLength));
      toClean.push(tag);
      out.set(tag, plaintext.length);
      clean2(...toClean);
      return out;
    },
    decrypt(ciphertext) {
      const { xk, authKey, counter, tagMask } = deriveKeys();
      const toClean = [xk, authKey, tagMask, counter];
      if (!isAligned32(ciphertext))
        toClean.push(ciphertext = copyBytes(ciphertext));
      const data = ciphertext.subarray(0, -tagLength);
      const passedTag = ciphertext.subarray(-tagLength);
      const tag = _computeTag(authKey, tagMask, data);
      toClean.push(tag);
      if (!equalBytes(tag, passedTag)) {
        clean2(...toClean);
        throw new Error("aes-gcm: invalid tag");
      }
      const out = ctr32(xk, false, counter, data);
      clean2(...toClean);
      return out;
    }
  };
});

// mobile/shell/lock.js
var PIN_ITERATIONS = 6e5;
var PIN_LENGTH = 6;
var PIN_KEY_BYTES = 32;
var PIN_MIN_ITERATIONS = 1e5;
var PIN_MAX_ITERATIONS = 1e7;
var DEVICE_META = "pin-device";
var BACKGROUND_LOCK_MS = 5 * 60 * 1e3;
var PIN_WAIT_FROM = 5;
var PIN_WAIT_CAP_S = 900;
var VERIFIER_TEXT = new TextEncoder().encode("plenum-pin-check/1");
var VERIFIER_AAD = new TextEncoder().encode("plenum-lock-verifier");
function pinWaitSeconds(failures) {
  if (!Number.isSafeInteger(failures) || failures < PIN_WAIT_FROM) return 0;
  return Math.min(PIN_WAIT_CAP_S, 30 * 2 ** (failures - PIN_WAIT_FROM));
}
var b64u = {
  enc(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(text) {
    const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
};
function isValidPin(pin) {
  return typeof pin === "string" && new RegExp(`^[0-9]{${PIN_LENGTH}}$`).test(pin);
}
function wrapKey(keyBytes, pinKey, computerId) {
  const iv = randomBytes(12);
  const ct = gcm(pinKey, iv, new TextEncoder().encode(`plenum-key/${computerId}`)).encrypt(keyBytes);
  return { v: 1, iv: b64u.enc(iv), ct: b64u.enc(ct) };
}
function unwrapKey(wrap, pinKey, computerId) {
  if (!wrap || wrap.v !== 1) throw new Error("bad wrap");
  const plain = gcm(pinKey, b64u.dec(wrap.iv), new TextEncoder().encode(`plenum-key/${computerId}`)).decrypt(b64u.dec(wrap.ct));
  if (plain.byteLength !== PIN_KEY_BYTES) throw new Error("bad key");
  return plain;
}
function derivePinKey(pin, salt, iterations = PIN_ITERATIONS) {
  return pbkdf2(sha256, new TextEncoder().encode(pin), salt, { c: iterations, dkLen: PIN_KEY_BYTES });
}
function createPasskeyGate({ credentials = globalThis.navigator?.credentials, PublicKeyCredentialCtor = globalThis.PublicKeyCredential, rpId = globalThis.location?.hostname ?? "localhost", random = randomBytes } = {}) {
  return {
    async available() {
      if (!credentials || !PublicKeyCredentialCtor) return false;
      try {
        return await PublicKeyCredentialCtor.isUserVerifyingPlatformAuthenticatorAvailable?.() === true;
      } catch {
        return false;
      }
    },
    async register() {
      const cred = await credentials.create({
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
      const assertion = await credentials.get({
        publicKey: {
          challenge: random(32),
          allowCredentials: [{ type: "public-key", id: b64u.dec(credentialId) }],
          userVerification: "required",
          timeout: 6e4
        }
      });
      return assertion !== null && assertion !== void 0;
    }
  };
}
function createBiometricGate({ plugin = null } = {}) {
  return {
    async available() {
      if (!plugin) return false;
      try {
        const answer = await plugin.checkBiometry();
        return answer?.isAvailable === true;
      } catch {
        return false;
      }
    },
    async verify(reason = "Unlock Plenum") {
      if (!plugin) return false;
      try {
        await plugin.authenticate({ reason, allowDeviceCredential: true, cancelTitle: "Cancel", iosFallbackTitle: "Use passcode" });
        return true;
      } catch {
        return false;
      }
    }
  };
}
function createLock({ store, now = () => Date.now(), biometric = null, passkey = null, iterations = PIN_ITERATIONS, subtle = globalThis.crypto?.subtle ?? null, mono = () => globalThis.performance?.now?.() ?? Date.now() } = {}) {
  if (!store) throw new TypeError("createLock needs the store");
  let backgroundAt = null;
  let locked = false;
  let settings = null;
  let pinKeyHeld = null;
  let monoUntil = 0;
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {
    });
    return run;
  };
  const readSettings = async () => {
    if (!settings) settings = await store.meta.get("lock") ?? { mode: "off", failures: 0, lockedUntil: 0 };
    return settings;
  };
  const writeSettings = async (next) => {
    settings = next;
    await store.meta.put("lock", next);
  };
  const plainKeys = async (pinKey) => {
    const out = /* @__PURE__ */ new Map();
    for (const rec of await store.list()) {
      if (typeof rec.myPriv === "string") out.set(rec.id, b64u.dec(rec.myPriv));
      else if (rec.myPriv && pinKey) out.set(rec.id, unwrapKey(rec.myPriv, pinKey, rec.id));
    }
    return out;
  };
  const lockout = (s) => {
    const wall = s.lockedUntil > now() ? Math.ceil((s.lockedUntil - now()) / 1e3) : 0;
    const steady = monoUntil > mono() ? Math.ceil((monoUntil - mono()) / 1e3) : 0;
    return Math.max(wall, steady);
  };
  const api = {
    // What the lock screen and Settings show. No key material.
    async status() {
      const s = await readSettings();
      return {
        mode: s.mode,
        locked,
        failures: s.failures ?? 0,
        waitSec: lockout(s),
        biometricAvailable: biometric ? await biometric.available() : false,
        passkeyAvailable: passkey ? await passkey.available() : false
      };
    },
    // Called once at launch: a lock that is on starts locked.
    async lockOnLaunch() {
      const s = await readSettings();
      locked = s.mode !== "off";
      return locked;
    },
    isLocked: () => locked,
    lock() {
      locked = true;
      pinKeyHeld = null;
      return true;
    },
    onBackground() {
      backgroundAt = now();
    },
    async onForeground() {
      const s = await readSettings();
      if (s.mode !== "off" && backgroundAt !== null && now() - backgroundAt >= BACKGROUND_LOCK_MS) {
        locked = true;
        pinKeyHeld = null;
      }
      backgroundAt = null;
      return locked;
    },
    // The record as it must rest in the store: in PIN mode its private key is wrapped under the PIN key held while unlocked. It refuses
    // (throws 'locked') when the PIN key is not held, so a key is never written plain under a PIN.
    async protect(record) {
      const s = await readSettings();
      if (s.mode !== "pin") return record;
      if (!pinKeyHeld) throw new Error("locked");
      if (typeof record.myPriv !== "string") return record;
      return { ...record, myPriv: wrapKey(b64u.dec(record.myPriv), pinKeyHeld, record.id) };
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
    const have = await store.meta.get(DEVICE_META);
    if (have && typeof have === "object" && have.type === "secret") return have;
    if (!create) return null;
    const made = await subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await store.meta.put(DEVICE_META, made);
    return made;
  }
  async function pinKeyV2(pin, salt, its, key) {
    const stretched = derivePinKey(pin, salt, its);
    const mixed = new Uint8Array(await subtle.sign("HMAC", key, stretched));
    stretched.fill(0);
    return mixed;
  }
  async function enableBiometricInner() {
    settings = null;
    if (!biometric || !await biometric.available()) return { ok: false, reason: "unavailable" };
    if (!await biometric.verify("Turn on app lock for Plenum")) return { ok: false, reason: "cancelled" };
    await writeSettings({ mode: "biometric", failures: 0, lockedUntil: 0 });
    return { ok: true };
  }
  async function unlockBiometricInner() {
    settings = null;
    const s = await readSettings();
    if (s.mode !== "biometric") return { ok: false, reason: "mode" };
    if (!await biometric.verify()) return { ok: false, reason: "cancelled" };
    locked = false;
    return { ok: true, keys: await plainKeys(null) };
  }
  async function setPinInner(pin) {
    settings = null;
    if (!isValidPin(pin)) return { ok: false, reason: "format" };
    const current = await readSettings();
    if (current.mode !== "off") return { ok: false, reason: "mode" };
    const salt = randomBytes(16);
    const dk = await deviceKey(true);
    const pinKey = dk ? await pinKeyV2(pin, salt, iterations, dk) : derivePinKey(pin, salt, iterations);
    const nonce = randomBytes(12);
    const ct = gcm(pinKey, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT);
    const keys = await plainKeys(null);
    for (const rec of await store.list()) {
      const key = keys.get(rec.id);
      if (!key) continue;
      const next = { ...rec, myPriv: wrapKey(key, pinKey, rec.id) };
      await store.put(next);
    }
    await store.meta.put("pin", { v: dk ? 2 : 1, salt: b64u.enc(salt), iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) });
    await writeSettings({ mode: "pin", failures: 0, lockedUntil: 0 });
    pinKeyHeld = pinKey;
    return { ok: true, keys };
  }
  async function unlockPinInner(pin) {
    settings = null;
    const s = await readSettings();
    if (s.mode !== "pin") return { ok: false, reason: "mode" };
    if (!isValidPin(pin)) return { ok: false, reason: "format" };
    if (lockout(s) > 0) return { ok: false, reason: "wait", waitSec: lockout(s), failures: s.failures };
    const pinRecord = await store.meta.get("pin");
    if (!pinRecord) return { ok: false, reason: "mode" };
    if (!Number.isSafeInteger(pinRecord.iterations) || pinRecord.iterations < Math.min(PIN_MIN_ITERATIONS, iterations) || pinRecord.iterations > PIN_MAX_ITERATIONS) {
      return { ok: false, reason: "damaged" };
    }
    const salt = b64u.dec(pinRecord.salt);
    let pinKey;
    if (pinRecord.v === 2) {
      const dk = await deviceKey(false);
      if (!dk) return { ok: false, reason: "damaged" };
      pinKey = await pinKeyV2(pin, salt, pinRecord.iterations, dk);
    } else {
      pinKey = derivePinKey(pin, salt, pinRecord.iterations);
    }
    let right = false;
    try {
      const plain = gcm(pinKey, b64u.dec(pinRecord.nonce), VERIFIER_AAD).decrypt(b64u.dec(pinRecord.ct));
      right = plain.length === VERIFIER_TEXT.length && plain.every((b, i) => b === VERIFIER_TEXT[i]);
    } catch {
      right = false;
    }
    if (!right) {
      const failures = (s.failures ?? 0) + 1;
      const wait = pinWaitSeconds(failures);
      monoUntil = wait > 0 ? mono() + wait * 1e3 : 0;
      await writeSettings({ ...s, failures, lockedUntil: wait > 0 ? now() + wait * 1e3 : 0 });
      return { ok: false, reason: "wrong", failures, waitSec: wait };
    }
    let held = pinKey;
    if (pinRecord.v !== 2 && subtle && store.kind === "web") {
      const made = await deviceKey(true);
      const v2 = await pinKeyV2(pin, salt, pinRecord.iterations, made);
      const keysV1 = await plainKeys(pinKey);
      for (const rec of await store.list()) {
        const key = keysV1.get(rec.id);
        if (!key) continue;
        await store.put({ ...rec, myPriv: wrapKey(key, v2, rec.id) });
      }
      const nonce = randomBytes(12);
      const ct = gcm(v2, nonce, VERIFIER_AAD).encrypt(VERIFIER_TEXT);
      await store.meta.put("pin", { v: 2, salt: pinRecord.salt, iterations: pinRecord.iterations, nonce: b64u.enc(nonce), ct: b64u.enc(ct) });
      held = v2;
    }
    await writeSettings({ ...s, failures: 0, lockedUntil: 0 });
    locked = false;
    pinKeyHeld = held;
    return { ok: true, keys: await plainKeys(held) };
  }
  async function enablePasskeyInner() {
    settings = null;
    if (!passkey || !await passkey.available()) return { ok: false, reason: "unavailable" };
    const credentialId = await passkey.register();
    await store.meta.put("passkey", { id: credentialId });
    await writeSettings({ mode: "passkey", failures: 0, lockedUntil: 0 });
    return { ok: true };
  }
  async function unlockPasskeyInner() {
    settings = null;
    const s = await readSettings();
    if (s.mode !== "passkey") return { ok: false, reason: "mode" };
    const record = await store.meta.get("passkey");
    if (!record || !await passkey.verify(record.id)) return { ok: false, reason: "cancelled" };
    locked = false;
    return { ok: true, keys: await plainKeys(null) };
  }
  async function disableInner({ pin = null } = {}) {
    settings = null;
    const s = await readSettings();
    if (s.mode === "biometric") {
      if (!await biometric?.verify("Turn off app lock for Plenum")) return { ok: false, reason: "cancelled" };
    } else if (s.mode === "passkey") {
      const rec = await store.meta.get("passkey");
      if (!rec || !await passkey?.verify(rec.id)) return { ok: false, reason: "cancelled" };
    }
    if (s.mode === "pin") {
      const unlocked = await unlockPinInner(pin);
      if (!unlocked.ok) return unlocked;
      for (const rec of await store.list()) {
        const key = unlocked.keys.get(rec.id);
        if (key) await store.put({ ...rec, myPriv: b64u.enc(key) });
      }
      await store.meta.remove("pin");
      await store.meta.remove(DEVICE_META);
    } else if (s.mode === "passkey") {
      await store.meta.remove("passkey");
    }
    await writeSettings({ mode: "off", failures: 0, lockedUntil: 0 });
    locked = false;
    pinKeyHeld = null;
    return { ok: true };
  }
  return api;
}

// mobile/shell/pairing.js
var PAIR_FINAL = Object.freeze(["allowed", "denied", "expired", "mismatch", "failed"]);
var OFFER_TTL_MAX_S = 600;
var PairingError = class extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
};
function parsePairingText(text) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new PairingError("not-plenum");
  if (raw.length > 8192) throw new PairingError("not-plenum");
  let fragment = null;
  const native = /^plenum:\/\/pair#(.*)$/i.exec(raw);
  if (native) {
    fragment = native[1];
  } else {
    const hashAt = raw.indexOf("#");
    fragment = hashAt >= 0 ? raw.slice(hashAt + 1) : raw;
  }
  const m = /(?:^|&)pair=([A-Za-z0-9_-]+)$/.exec(fragment) ?? (native ? /^([A-Za-z0-9_-]+)$/.exec(fragment) : null);
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
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new PairingError("not-plenum");
  if (p.v !== 1) throw new PairingError("version");
  const key32 = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && b64uToBytes(value).byteLength === 32;
  if (!key32(p.pub) || !key32(p.psk)) throw new PairingError("not-plenum");
  if (typeof p.offer !== "string" || !/^[0-9a-f]{32}$/.test(p.offer)) throw new PairingError("not-plenum");
  const ttl = Number(p.ttl ?? 120);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > OFFER_TTL_MAX_S) throw new PairingError("expired");
  if (!Array.isArray(p.carriers) || p.carriers.length === 0) throw new PairingError("no-carrier");
  const carriers = [];
  const kinds = /* @__PURE__ */ new Set();
  for (const c of p.carriers) {
    if (!c || !["lan", "tailscale", "relay"].includes(c.kind) || kinds.has(c.kind)) continue;
    kinds.add(c.kind);
    carriers.push(Array.isArray(c.urls) ? { ...c, urls: c.urls.slice(0, 4) } : c);
    if (carriers.length === 3) break;
  }
  if (!carriers.length) throw new PairingError("no-carrier");
  return {
    v: 1,
    name: typeof p.name === "string" ? p.name.slice(0, 60) : "Plenum computer",
    pub: p.pub,
    psk: p.psk,
    offer: p.offer,
    ttl,
    carriers,
    sas: "6"
  };
}
function pageCandidates(pageUrl, payload) {
  const m = /^(https?):\/\/([^/]+)\/p\/([0-9a-f]{32})\//.exec(String(pageUrl ?? ""));
  if (!m) return [];
  const url = `${m[1] === "https" ? "wss" : "ws"}://${m[2]}/b/${m[3]}`;
  const listed = (payload?.carriers ?? []).some((c) => (Array.isArray(c.urls) ? c.urls : [c.url]).includes(url));
  return listed ? [] : [{ kind: "lan", url }];
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
  if (!payload || typeof payload !== "object") throw new PairingError("not-plenum");
  const worker = createWorker();
  let current = { state: "starting", code: null, tried: [], reason: null };
  let saving = Promise.resolve();
  let finished = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const extraUrls = pageCandidates(pageUrl, payload);
  const finish = (value) => {
    if (finished) return;
    finished = true;
    resolveDone(value);
    setTimeout(() => {
      try {
        worker.terminate();
      } catch {
      }
    }, 0);
  };
  const set = (patch) => {
    current = { ...current, ...patch };
    try {
      onState({ ...current });
    } catch {
    }
  };
  worker.onmessage = (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.op === "counter") {
      answerCounter(store, msg, (reply) => worker.postMessage(reply));
      return;
    }
    if (msg.op === "paired") {
      saving = Promise.resolve().then(async () => {
        if (!store) return true;
        const record = prepareRecord ? await prepareRecord(msg.computer) : msg.computer;
        await store.put(record);
        return true;
      }).catch(() => false);
      return;
    }
    if (msg.op !== "pairState") return;
    if (msg.state === "confirm") {
      set({ state: "confirm", code: msg.code ?? null });
      return;
    }
    if (msg.state === "allowed") {
      saving.then((ok) => {
        if (!ok) {
          set({ state: "failed", reason: "save" });
          finish({ ...current });
          return;
        }
        set({ state: "allowed", reason: null });
        finish({ ...current, computerId: msg.computerId ?? null });
      });
      return;
    }
    if (PAIR_FINAL.includes(msg.state)) {
      set({ state: msg.state, tried: msg.tried ?? current.tried, reason: msg.reason ?? null });
      finish({ ...current });
    }
  };
  worker.onerror = () => {
    set({ state: "failed", reason: "worker" });
    finish({ ...current });
  };
  set({ state: "starting" });
  worker.postMessage({ op: "pair", payload, device, caps: caps ?? void 0, extraUrls });
  return {
    cancel() {
      if (!finished) worker.postMessage({ op: "pairCancel" });
    },
    done,
    state: () => ({ ...current })
  };
}

// mobile/shell/carriers.js
var CARRIER_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
var MAX_URLS_PER_KIND = 4;
var MAX_URL_LENGTH = 512;
function ipv4Of(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}
function isLoopback(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const v4 = ipv4Of(hostname);
  return v4 !== null && v4[0] === 127;
}
function isPrivateV4([a, b]) {
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
function isPrivateV6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const first = hostname.slice(1, -1).split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const value = parseInt(first, 16);
  return value >= 64512 && value <= 65023 || value >= 65152 && value <= 65215;
}
function carrierUrlOk(kind, url) {
  if (!CARRIER_KINDS.includes(kind) || typeof url !== "string" || url.length > MAX_URL_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  if (isLoopback(host)) return true;
  if (kind === "relay") return parsed.protocol === "wss:";
  if (kind === "tailscale") return parsed.protocol === "wss:" && host.endsWith(".ts.net");
  const v4 = ipv4Of(host);
  if (v4) return isPrivateV4(v4);
  return isPrivateV6(host) || host.endsWith(".local");
}
function hostLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function usableCarriers(carriers) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of Array.isArray(carriers) ? carriers : []) {
    if (!entry || typeof entry !== "object" || !CARRIER_KINDS.includes(entry.kind) || seen.has(entry.kind)) continue;
    seen.add(entry.kind);
    const listed = Array.isArray(entry.urls) ? entry.urls : entry.url ? [entry.url] : [];
    const urls = listed.filter((url) => carrierUrlOk(entry.kind, url)).slice(0, MAX_URLS_PER_KIND);
    if (urls.length) out.push({ kind: entry.kind, urls });
  }
  return out;
}

// mobile/shell/stop.js
var STOP_DONE_MS = 1600;
var STOP_WATCHDOG_MS = 65e3;
var STOP_STATES = Object.freeze(["idle", "sending", "queued", "done", "failed"]);
var plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function stopResultText(ack, computerName = "this computer") {
  const replies = Number(ack?.cancelled) || 0;
  const runs = Number(ack?.drivesStopped) || 0;
  const agents = Number(ack?.agentsStopped) || 0;
  const cards = Number(ack?.cardsDenied) || 0;
  if (!replies && !runs && !agents && !cards) return `Nothing was running on ${computerName}.`;
  const parts = [];
  if (replies) parts.push(plural(replies, "reply", "replies"));
  if (runs) parts.push(plural(runs, "computer run", "computer runs"));
  if (agents) parts.push(plural(agents, "agent", "agents"));
  const tail = cards ? ` ${plural(cards, "card", "cards")} denied.` : "";
  return `Stopped everything on ${computerName}: ${parts.join(", ")}.${tail}`;
}
var STOP_FAILURE_TEXT = Object.freeze({
  title: "Could not reach the computer",
  body: "The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run."
});
var STOP_QUEUED_TEXT = "Stop will be sent when the computer is reachable. Trying for 60 seconds.";
var STOP_NOT_ACCEPTED = (computer) => `${computer} did not accept this Stop. This phone may have been removed there. At the computer, press Stop on the bar or Ctrl+Alt+Esc.`;
var STOP_NEEDS_UNLOCK = "Unlock Plenum to send this Stop. It goes out as soon as Plenum unlocks.";
function createStopController({ channel, clock = globalThis, computerName = "" } = {}) {
  if (!channel || typeof channel.stop !== "function") throw new TypeError("createStopController needs a channel");
  let state = "idle";
  let lastAck = null;
  let lastError = null;
  let timer = null;
  const subs = /* @__PURE__ */ new Set();
  const set = (next, extra = {}) => {
    state = next;
    if (extra.ack !== void 0) lastAck = extra.ack;
    if (extra.error !== void 0) lastError = extra.error;
    const view = { state, ack: lastAck, error: lastError, text: textFor(next, lastAck, lastError) };
    for (const fn of Array.from(subs)) {
      try {
        fn(view);
      } catch {
      }
    }
  };
  const textFor = (s, ack, error) => {
    if (s === "done") return stopResultText(ack, computerName || "this computer");
    if (s === "queued") return STOP_QUEUED_TEXT;
    if (s === "failed" && error === "unknown") return STOP_NOT_ACCEPTED(computerName || "this computer");
    if (s === "failed") return `${STOP_FAILURE_TEXT.title}. ${STOP_FAILURE_TEXT.body}`;
    if (s === "sending") return "Stopping everything on the computer";
    return error ? String(error) : "";
  };
  const unsubscribe = channel.onStopState?.((view) => {
    if (state === "sending" && view.state === "queued") set("queued");
    if (state === "queued" && view.state === "sent") set("sending");
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
      clock.clearTimeout(timer);
      timer = null;
      set("sending", { error: null });
      let watchdog = null;
      const silent = new Promise((_, reject) => {
        watchdog = clock.setTimeout(() => reject(Object.assign(new Error("unreachable"), { code: "unreachable" })), STOP_WATCHDOG_MS);
      });
      try {
        const ack = await Promise.race([channel.stop(project), silent]);
        clock.clearTimeout(watchdog);
        set("done", { ack, error: null });
        timer = clock.setTimeout(() => {
          timer = null;
          if (state === "done") set("idle");
        }, STOP_DONE_MS);
      } catch (err) {
        clock.clearTimeout(watchdog);
        set("failed", { error: err?.code ?? "unreachable" });
      }
      return this.view;
    },
    dispose() {
      clock.clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      subs.clear();
    }
  };
}

// mobile/shell/debug.js
var RING_LINES = 500;
var LINE_MAX = 2048;
var SEND_MAX_LINES = 100;
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
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return out.slice(0, LINE_MAX);
}
function createDebugLog({ now = () => Date.now(), capacity = RING_LINES } = {}) {
  const ring = [];
  const subs = /* @__PURE__ */ new Set();
  const notify = () => {
    for (const fn of Array.from(subs)) {
      try {
        fn();
      } catch {
      }
    }
  };
  return {
    // Adds one line. Returns the stored line, or null when there was nothing left after redaction.
    log(text, level = "info") {
      const line = redactLine(text);
      if (!line) return null;
      const entry = { at: now(), level, text: line };
      ring.push(entry);
      while (ring.length > capacity) ring.shift();
      notify();
      return entry;
    },
    lines() {
      return ring.map((l) => ({ ...l }));
    },
    clear() {
      ring.length = 0;
      notify();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // Posts the most recent lines to the computer, one request each (POST /_bridge/log takes { line }). `request` is channel.request.
    // Resolves with the number of lines the computer answered for.
    async sendToComputer(request, count = SEND_MAX_LINES) {
      const picked = ring.slice(-Math.max(0, Math.min(count, SEND_MAX_LINES)));
      let accepted = 0;
      for (const entry of picked) {
        const body = JSON.stringify({ line: `[phone ${entry.level}] ${entry.text}`.slice(0, LINE_MAX) });
        try {
          const res = await request({ method: "POST", path: "/_bridge/log", headers: { "content-type": "application/json" } }, body);
          try {
            await res.body?.cancel();
          } catch {
          }
          if (res.status === 200) accepted += 1;
        } catch {
          break;
        }
      }
      return accepted;
    }
  };
}

// mobile/shell/selftest.js
var STEP_NAMES = Object.freeze(["connect", "ui-pull", "chat-echo", "approval", "stop"]);
var decoder = new TextDecoder();
async function readAll(body, limit = 1e6) {
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {
      });
      break;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return decoder.decode(out);
}
var withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  promise.then((v) => {
    clearTimeout(timer);
    resolve(v);
  }, (e) => {
    clearTimeout(timer);
    reject(e);
  });
});
async function waitFor(fn, ms, label, step = 100) {
  const end = Date.now() + ms;
  for (; ; ) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${label} timed out`);
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}
async function runSelfTest({ channel, project, approvalWaitMs = 15e3, connectMs = 15e3, log = () => {
}, now = () => Date.now() } = {}) {
  if (!channel) throw new TypeError("runSelfTest needs a channel");
  const started = now();
  const steps = [];
  const step = async (name, fn) => {
    const t0 = now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: now() - t0, detail: detail ?? "" });
    } catch (err) {
      steps.push({ name, ok: false, ms: now() - t0, detail: String(err?.message ?? err).slice(0, 200) });
    }
  };
  await step("connect", async () => {
    await waitFor(() => channel.state.status === "connected" && channel.hello, connectMs, "the connection");
    return `protocol ${channel.hello?.protocol?.major}.${channel.hello?.protocol?.minor}`;
  });
  await step("ui-pull", async () => {
    const res = await withTimeout(channel.request({ method: "GET", path: "/" }), 15e3, "GET /");
    const text = await readAll(res.body, 4e6);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!/<html/i.test(text)) throw new Error("no page");
    return `${text.length} characters`;
  });
  let chatProject = project ?? null;
  await step("chat-echo", async () => {
    if (!chatProject) {
      const st = await withTimeout(channel.request({ method: "GET", path: "/api/state" }), 1e4, "GET /api/state");
      const parsed = JSON.parse(await readAll(st.body));
      chatProject = parsed?.projects?.[0]?.id ?? null;
    }
    if (!chatProject) throw new Error("no project");
    const res = await withTimeout(channel.request(
      { method: "POST", path: "/api/chat", headers: { "content-type": "application/json" } },
      JSON.stringify({ project: chatProject, message: "selftest: say echo" })
    ), 2e4, "POST /api/chat");
    const text = await withTimeout(readAll(res.body), 2e4, "the reply");
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!/Echo/.test(text)) throw new Error("no echo in the reply");
    return "the echo model answered";
  });
  await step("approval", async () => {
    const events = await channel.request({ method: "GET", path: "/api/events" });
    let found = null;
    let buffer = "";
    const reader = events.body.getReader();
    const until = now() + approvalWaitMs;
    try {
      while (!found && now() < until) {
        const read = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true, timeout: true }), Math.max(0, until - now())))]);
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0 && !found) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            let value = null;
            try {
              value = JSON.parse(line.slice(6));
            } catch {
              value = null;
            }
            if (value?.type === "approval" && typeof value.approvalId === "string" && value.action === void 0) {
              found = value;
              break;
            }
          }
          cut = buffer.indexOf("\n\n");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
      }
    }
    if (!found) throw new Error("no approval card came in the wait");
    const answer = await withTimeout(channel.request(
      { method: "POST", path: "/api/approve", headers: { "content-type": "application/json" } },
      JSON.stringify({ approvalId: found.approvalId, allow: false })
    ), 1e4, "POST /api/approve");
    await readAll(answer.body);
    if (answer.status !== 200) throw new Error(`status ${answer.status}`);
    return "denied from the phone";
  });
  await step("stop", async () => {
    if (!chatProject) throw new Error("no project");
    const res = await withTimeout(channel.request(
      { method: "POST", path: "/api/chat", headers: { "content-type": "application/json" } },
      JSON.stringify({ project: chatProject, message: "selftest: stop me" })
    ), 2e4, "POST /api/chat");
    const reader = res.body.getReader();
    await withTimeout(reader.read(), 2e4, "the first chunk");
    const ack = await withTimeout(channel.stop(chatProject), 15e3, "STOP");
    if (!ack?.id) throw new Error("no STOP_ACK");
    try {
      await withTimeout((async () => {
        for (; ; ) {
          const r = await reader.read();
          if (r.done) return;
        }
      })(), 1e4, "the stream end");
    } catch {
      await reader.cancel().catch(() => {
      });
    }
    return `cancelled ${ack.cancelled}, agents ${ack.agentsStopped}, cards ${ack.cardsDenied}`;
  });
  const report = {
    kind: "plenum-shell-selftest",
    ok: steps.length === STEP_NAMES.length && steps.every((s) => s.ok),
    passed: steps.filter((s) => s.ok).length,
    total: STEP_NAMES.length,
    ms: now() - started,
    steps
  };
  try {
    log(`selftest ${JSON.stringify(report)}`);
  } catch {
  }
  return report;
}

// mobile/shell/push.js
init_core();
var ID = /^[A-Za-z0-9_.-]{1,80}$/;
var FIRST_LINE_MAX = 200;
function pushAvailable(env = globalThis) {
  const nav = env.navigator;
  return Boolean(env.isSecureContext && nav && "serviceWorker" in nav && env.PushManager && env.Notification);
}
function cleanLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, FIRST_LINE_MAX);
}
function parseNotificationHash(hash) {
  const text = String(hash ?? "").replace(/^#/, "");
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
    if (m[3] !== void 0) return null;
    return { kind: m[1], id: m[2] };
  }
  m = /^chat=([A-Za-z0-9_.-]{1,80})$/.exec(text);
  if (m) return { kind: "chat", project: m[1] };
  return null;
}
function isRouteLink(link) {
  return Boolean(link) && ["waiting", "handover", "chat", "settings", "home"].includes(link.kind);
}
async function subscribeWebPush({ registration, applicationServerKey, request, deviceId, notification, env = globalThis } = {}) {
  if (!pushAvailable(env) || !registration?.pushManager) return { ok: false, state: "unsupported", status: 0 };
  if (!applicationServerKey || typeof request !== "function" || !deviceId) return { ok: false, state: "failed", status: 0 };
  const permission = await (notification ?? env.Notification).requestPermission();
  if (permission !== "granted") return { ok: false, state: "denied", status: 0 };
  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesFromB64u(applicationServerKey) });
  } catch {
    return { ok: false, state: "failed", status: 0 };
  }
  const json = subscription.toJSON ? subscription.toJSON() : subscription;
  const body = JSON.stringify({ id: deviceId, subscription: { endpoint: json.endpoint, keys: json.keys } });
  const res = await request({ method: "POST", path: "/api/phones/push", headers: { "content-type": "application/json" } }, body);
  try {
    await res.body?.cancel();
  } catch {
  }
  if (res.status !== 200) return { ok: false, state: "failed", status: res.status };
  return { ok: true, state: "on", status: res.status };
}
function bytesFromB64u(text) {
  const s = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var ANDROID_CHANNELS = Object.freeze([
  Object.freeze({ id: "plenum-approvals", name: "Approvals and your turn", importance: 4 }),
  Object.freeze({ id: "plenum-finished", name: "Finished and failed runs", importance: 3 }),
  Object.freeze({ id: "plenum-limits", name: "Spend and plan limits", importance: 3 })
]);
var ENDPOINT_WAIT_MS = 15e3;
function unifiedPushSubscription(event) {
  const endpoint = parseEndpointEvent(event);
  if (!endpoint.keys) return null;
  return { subscription: { kind: "unifiedpush", endpoint: endpoint.url, keys: { p256dh: endpoint.keys.pubKey, auth: endpoint.keys.auth } } };
}
function notificationFor(payload) {
  const names = payload.actions.map((a) => a.action);
  const routes = {};
  for (const a of payload.actions) routes[a.action] = a.route;
  return {
    title: payload.title,
    body: payload.body,
    channelId: channelForKind(payload.kind),
    actionTypeId: names.length ? `plenum-${names.join("-")}` : void 0,
    actions: payload.actions.map((a) => ({
      id: a.action,
      title: a.title,
      requiresAuthentication: true,
      destructive: a.action !== "approve",
      foreground: false
    })),
    extra: { tap: payload.tap, routes, line: payload.firstLine ?? "" }
  };
}
function notificationId(tag) {
  let h = 0;
  for (const ch of String(tag ?? "plenum")) h = h * 31 + ch.charCodeAt(0) | 0;
  return Math.abs(h) % 2147483e3 + 1;
}
function createAndroidPush({
  native,
  requestOf,
  vapidOf = () => null,
  isVisible = () => true,
  onLink = () => {
  },
  log = () => {
  },
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
} = {}) {
  const up = native?.UnifiedPush ?? null;
  const local = native?.LocalNotifications ?? null;
  let started = false;
  let waiting = null;
  let lastEndpoint = null;
  let failure = null;
  let posted = false;
  const types = /* @__PURE__ */ new Set();
  async function post(body) {
    const request = requestOf?.();
    if (typeof request !== "function") return { ok: false, status: 0 };
    try {
      const res = await request({ method: "POST", path: "/api/phones/push", headers: { "content-type": "application/json" } }, JSON.stringify(body));
      try {
        await res.body?.cancel();
      } catch {
      }
      return { ok: res.status === 200, status: res.status };
    } catch {
      return { ok: false, status: 0 };
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
      failure = "endpoint";
      waiting?.resolve({ ok: false, reason: "endpoint" });
      return;
    }
    lastEndpoint = body.subscription.endpoint;
    const out = await post(body);
    posted = out.ok;
    if (out.ok) failure = null;
    waiting?.resolve(out.ok ? { ok: true, reason: null } : { ok: false, reason: "failed" });
  }
  async function showLocal(payload) {
    if (!local?.schedule) return;
    const note = notificationFor(payload);
    if (note.actionTypeId && !types.has(note.actionTypeId)) {
      types.add(note.actionTypeId);
      await local.registerActionTypes?.({ types: [{ id: note.actionTypeId, actions: note.actions }] });
    }
    await local.schedule({
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
    if (!parsed.payload) return;
    if (!isVisible()) return;
    try {
      await showLocal(parsed.payload);
    } catch (err) {
      log(`push: local notification ${err?.code ?? "failed"}`);
    }
  }
  function onAction(event) {
    const extra = event?.notification?.extra ?? {};
    const id = String(event?.actionId ?? "tap");
    const route = id === "tap" ? extra.tap : extra.routes?.[id];
    if (typeof route !== "string") return;
    const link = routeForAction({ action: id === "tap" ? "tap" : id, route }, extra.line ? String(extra.line) : "");
    onLink(String(link).replace(/^\//, ""));
  }
  return {
    // Channels, action types and listeners. Safe to call again; a plugin that is missing does nothing.
    async start() {
      if (started || !up) return false;
      started = true;
      try {
        for (const c of ANDROID_CHANNELS) await local?.createChannel?.({ id: c.id, name: c.name, importance: c.importance, visibility: 0 });
        await up.addListener("endpoint", onEndpoint);
        await up.addListener("message", onMessage);
        await up.addListener("registrationFailed", (event) => {
          failure = String(event?.reason ?? "INTERNAL_ERROR");
          waiting?.resolve({ ok: false, reason: "registration" });
        });
        await up.addListener("unregistered", () => {
          posted = false;
          lastEndpoint = null;
        });
        await local?.addListener?.("localNotificationActionPerformed", onAction);
      } catch (err) {
        log(`push: start ${err?.code ?? "failed"}`);
        return false;
      }
      return true;
    },
    // What the settings line shows: whether UnifiedPush is on this phone, which push app, and whether the computer has the subscription.
    async state() {
      if (!up) return { supported: false, distributor: null, registered: false, failure };
      try {
        const s = await up.getState();
        return { supported: s?.supported !== false, distributor: s?.distributor ?? null, registered: posted, endpoint: Boolean(lastEndpoint) || Object.keys(s?.endpoints ?? {}).length > 0, failure };
      } catch {
        return { supported: false, distributor: null, registered: false, failure };
      }
    },
    // The system chooser for the push app (when more than one is installed, or none is chosen).
    async chooseDistributor() {
      if (!up) return { ok: false, reason: "unavailable" };
      try {
        const out = await up.pickDistributor();
        return { ok: out?.ok !== false, reason: null };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
    // Turn on: the permissions (after a tap), a push app, then register. Resolves once the computer has the subscription.
    async enable() {
      if (!up) return { ok: false, reason: "unavailable" };
      await this.start();
      try {
        const granted = await up.requestNotificationPermission();
        if (granted?.granted === false) return { ok: false, reason: "denied" };
        await local?.requestPermissions?.();
        const s = await up.getState();
        if (s?.supported === false) return { ok: false, reason: "unavailable" };
        if (!s?.distributor) {
          const list = await up.getDistributors();
          const names = list?.distributors ?? [];
          if (list?.saved) {
          } else if (names.length === 1) {
            await up.chooseDistributor({ packageName: names[0] });
          } else if (names.length === 0) {
            return { ok: false, reason: "no-distributor" };
          } else {
            const picked = await up.pickDistributor();
            if (picked?.ok === false) return { ok: false, reason: "no-distributor" };
          }
        }
        const answer = new Promise((resolve) => {
          const timer = setTimer(() => resolve({ ok: false, reason: "timeout" }), ENDPOINT_WAIT_MS);
          waiting = { resolve: (value) => {
            clearTimer(timer);
            waiting = null;
            resolve(value);
          } };
        });
        const vapid = vapidOf();
        await up.register({ instance: "default", messageForDistributor: "Plenum", ...vapid ? { vapid } : {} });
        return await answer;
      } catch (err) {
        waiting = null;
        return { ok: false, reason: err?.code === "VAPID_REQUIRED" ? "vapid" : "failed" };
      }
    },
    // Turn off: the computer forgets the subscription and the push app registration ends.
    async disable() {
      if (!up) return { ok: false, reason: "unavailable" };
      const out = await post({ subscription: null });
      try {
        await up.unregister({ instance: "default" });
      } catch {
      }
      posted = false;
      lastEndpoint = null;
      return { ok: out.ok, reason: out.ok ? null : "failed" };
    },
    // Test hooks: the handlers the listeners call.
    handlers: { onEndpoint, onMessage, onAction }
  };
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
function appKindFor(win) {
  if (isNative(win)) return { app: platformFor(win), name: "This phone" };
  if (isLanPage(win)) return { app: "lan-web", name: "This browser" };
  return { app: "pwa", name: "This phone (web app)" };
}
function pageKindFor(win) {
  const root = win?.document?.documentElement;
  if (!root || typeof root.hasAttribute !== "function") return "shell";
  if (root.hasAttribute("data-shell-page")) return "shell";
  if (typeof root.getAttribute === "function" && root.getAttribute("data-surface") === "phone") return "ui";
  return "shell";
}

// lib/remote/ui-manifest.mjs
var MANIFEST_PATH = "/_bridge/ui-manifest";
var SHELL_BASE = "/shell/";
var SHELL_ENTRY = "shell.js";
var UI_STATIC_PATHS = Object.freeze(["/", "/app.js", "/markdown.js", "/music.js", "/style.css", "/icon.png", "/mark.svg", "/ext.js"]);
var UI_PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; worker-src 'self'; base-uri 'none'; form-action 'self'";
var EXT_PATH = /^\/ext(?:-[a-z0-9-]{1,60})?\.(?:js|css)$/;
var STATIC_SET = new Set(UI_STATIC_PATHS);
var SHELL_BASE_OK = /^\/(?:[A-Za-z0-9._-]+\/)*$/;
var TYPES = Object.freeze({
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
  const dot = name.lastIndexOf(".");
  return TYPES[dot >= 0 ? name.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}
function isUiPath(pathname) {
  return STATIC_SET.has(pathname) || EXT_PATH.test(pathname);
}
function manifestHash(files, sha256Hex2, meta = {}) {
  const rows = files.map((f) => [f.path, f.sha256, f.size]);
  return sha256Hex2(JSON.stringify([String(meta.desktopVersion ?? ""), meta.generation ?? null, rows]));
}
function rewriteIndex(html, ctx = {}) {
  const shellBase = ctx.shellBase ?? SHELL_BASE;
  if (typeof shellBase !== "string" || !SHELL_BASE_OK.test(shellBase)) throw new Error("shellBase must be a path such as /shell/");
  const text = String(html);
  if (!/<script\b[^>]*\bsrc="\/app\.js"/i.test(text)) throw new Error("The index has no app.js tag.");
  let out = text.replace(/<html\b([^>]*)>/i, (whole, attrs) => `<html${attrs.replace(/\s+data-surface="[^"]*"/i, "")} data-surface="phone">`);
  out = out.replace(/(<meta\b[^>]*\bname="viewport"[^>]*\bcontent=")([^"]*)(")/i, (whole, open, content, close) => /viewport-fit=/.test(content) ? whole : `${open}${content}, viewport-fit=cover${close}`);
  if (!/http-equiv="Content-Security-Policy"/i.test(out)) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;
    if (/<meta\b[^>]*\bcharset=[^>]*>/i.test(out)) out = out.replace(/(<meta\b[^>]*\bcharset=[^>]*>)/i, (whole) => `${whole}
  ${meta}`);
    else if (/<head\b[^>]*>/i.test(out)) out = out.replace(/(<head\b[^>]*>)/i, (whole) => `${whole}
  ${meta}`);
    else throw new Error("The index has no <head>.");
  }
  const shimTags = [
    `<script src="${shellBase}boot.js"><\/script>`,
    `<script type="module" src="${shellBase}${SHELL_ENTRY}"><\/script>`
  ].filter((tag) => !out.includes(tag));
  if (shimTags.length) {
    out = out.replace(/([ \t]*)<script\b/i, (whole, indent) => `${shimTags.map((tag) => `${indent}${tag}
`).join("")}${whole}`);
  }
  return out;
}

// mobile/shell/ui-loader.js
var CACHE_PREFIX = "plenum-ui-";
var ACTIVE_CACHE = "plenum-ui-active";
var ACTIVE_PATH = "/__plenum/active.json";
var SHA_HEADER = "x-plenum-sha256";
var SIZE_HEADER = "x-plenum-size";
var MAX_FILE_BYTES = 16 * 1024 * 1024;
var MAX_MANIFEST_BYTES = 1024 * 1024;
var BOOT_FILE = "shell/boot.js";
var SHELL_FILES = Object.freeze([BOOT_FILE, "shell/shell.js", "shell/channel.worker.js", "shell/styles.css"]);
var utf82 = new TextEncoder();
var utf8Decode = new TextDecoder();
var HEX64 = /^[0-9a-f]{64}$/;
var UiError = class extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "UiError";
    this.code = code;
  }
};
function hexOf(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
function sha256Hex(bytes) {
  return hexOf(sha256(bytes));
}
function verifyBytes(bytes, entry) {
  if (bytes.byteLength !== entry.size) throw new UiError("size", `${entry.path} is ${bytes.byteLength} bytes, not ${entry.size}`);
  if (sha256Hex(bytes) !== entry.sha256) throw new UiError("verify", `${entry.path} does not match the manifest`);
  return true;
}
function checkManifest(value) {
  const bad = (why) => new UiError("manifest", `The computer sent a damaged UI manifest (${why}).`);
  if (!value || typeof value !== "object" || !Array.isArray(value.files) || typeof value.hash !== "string") throw bad("shape");
  const seen = /* @__PURE__ */ new Set();
  const files = [];
  for (const f of value.files) {
    if (!f || typeof f.path !== "string" || !isUiPath(f.path)) throw bad("path");
    if (seen.has(f.path)) throw bad("duplicate");
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) throw bad("sha256");
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) throw bad("size");
    seen.add(f.path);
    files.push({ path: f.path, sha256: f.sha256, size: f.size, type: typeof f.type === "string" ? f.type.slice(0, 100) : "application/octet-stream" });
  }
  if (!seen.has("/")) throw bad("no index");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const desktopVersion = String(value.desktopVersion ?? "");
  if (desktopVersion.length > 40) throw bad("version");
  const generation = value.generation === null || value.generation === void 0 ? null : value.generation;
  if (generation !== null && !Number.isInteger(generation)) throw bad("generation");
  const hashText = (text) => sha256Hex(utf82.encode(text));
  if (manifestHash(files, hashText, { desktopVersion, generation }) !== value.hash) throw bad("hash");
  return { desktopVersion, generation, hash: value.hash, files };
}
function cacheNameFor(manifest) {
  const slug = (text) => String(text).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `${CACHE_PREFIX}${slug(manifest.desktopVersion || "dev")}-${manifest.generation ?? 0}-${slug(manifest.hash.slice(0, 16))}`;
}
function diffFiles(previousFiles, next, hasCopy = () => false) {
  const before = new Map((previousFiles ?? []).map((f) => [f.path, f.sha256]));
  const changed = [];
  const reused = [];
  for (const f of next.files) {
    if (before.get(f.path) === f.sha256 && hasCopy(f)) reused.push(f.path);
    else changed.push(f);
  }
  const keep = new Set(next.files.map((f) => f.path));
  const removed = [...before.keys()].filter((p) => !keep.has(p));
  return { changed, reused, removed };
}
function shouldReload({ loadedHash, nextHash, reloadedFor }) {
  if (!loadedHash || !nextHash || loadedHash === nextHash) return false;
  return reloadedFor !== nextHash;
}
async function readAll2(body, cap = MAX_FILE_BYTES) {
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.cancel().catch(() => {
      });
      throw new UiError("size", "The file is larger than the UI allows.");
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
function computerOf(value) {
  return typeof value === "string" ? value : null;
}
function webStorage(caches) {
  const slotOn = (cache) => ({
    async get(path) {
      const res = await cache.match(path);
      if (!res) return null;
      return { bytes: new Uint8Array(await res.arrayBuffer()), sha256: res.headers.get(SHA_HEADER), size: Number(res.headers.get(SIZE_HEADER)) };
    },
    async put(path, bytes, entry) {
      await cache.put(path, new Response(bytes, {
        headers: { "content-type": entry.type, [SHA_HEADER]: entry.sha256, [SIZE_HEADER]: String(entry.size), "cache-control": "no-store" }
      }));
    }
  });
  return {
    async readActive() {
      const cache = await caches.open(ACTIVE_CACHE);
      const res = await cache.match(ACTIVE_PATH);
      const record = res ? JSON.parse(await res.text()) : null;
      return record ? { ...record, computerId: computerOf(record.computerId) } : null;
    },
    async writeActive(record) {
      const cache = await caches.open(ACTIVE_CACHE);
      await cache.put(ACTIVE_PATH, new Response(JSON.stringify(record), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    },
    async openSlot(name) {
      return slotOn(await caches.open(name));
    },
    async dropSlot(name) {
      if (name !== ACTIVE_CACHE) await caches.delete(name);
    },
    async dropSlotsExcept(name) {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== ACTIVE_CACHE && key !== name) await caches.delete(key);
      }
    },
    async activate() {
    }
  };
}
async function bundledShellFiles(readBundled) {
  const out = [];
  if (!readBundled) return out;
  for (const rel of SHELL_FILES) {
    let bytes = null;
    try {
      bytes = await readBundled(rel);
    } catch {
      bytes = null;
    }
    if (bytes && bytes.byteLength) out.push({ path: `/${rel}`, bytes });
  }
  return out;
}
function androidStorage({ files, webView, root = "plenum-ui" }) {
  const base = (name) => `${root}/${name}`;
  const slotOn = (name) => ({
    async get(path) {
      const bytes = await files.read(`${base(name)}/${fileNameFor(path)}`);
      if (!bytes) return null;
      return { bytes, sha256: null, size: bytes.byteLength };
    },
    async put(path, bytes) {
      await files.write(`${base(name)}/${fileNameFor(path)}`, bytes);
    }
  });
  async function activate(record, { readBundled, shellBase } = {}) {
    const dir = base(record.cacheName);
    const index = await files.read(`${dir}/index.html`);
    if (!index) throw new UiError("storage", "The index is missing.");
    for (const file of await bundledShellFiles(readBundled)) await files.write(`${dir}/${fileNameFor(file.path)}`, file.bytes);
    const html = rewriteIndex(utf8Decode.decode(index), { shellBase });
    await files.write(`${dir}/index.html`, utf82.encode(html));
    await webView?.persistServerBasePath({ path: dir });
    await webView?.setServerBasePath({ path: dir });
  }
  return {
    async readActive() {
      const bytes = await files.read(`${root}/active.json`);
      const record = bytes ? JSON.parse(utf8Decode.decode(bytes)) : null;
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
      if (!webView?.getServerBasePath) return false;
      const current = await webView.getServerBasePath();
      if (current?.path === base(record.cacheName)) return false;
      await activate(record, opts);
      return true;
    },
    async dropSlotsExcept(name) {
      const dirs = await files.listDirs?.(root) ?? [];
      for (const dir of dirs) {
        if (dir !== name && dir.startsWith(CACHE_PREFIX)) await files.removeDir(base(dir));
      }
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
  if (!channel || typeof channel.request !== "function") throw new TypeError("createUiLoader needs a channel");
  if (!storage) throw new TypeError("createUiLoader needs a storage");
  async function fetchFile(path, max) {
    const res = await channel.request({ method: "GET", path, headers: { accept: "*/*" } }, null, { scope: "shell" });
    if (res.status !== 200) {
      res.cancel?.();
      throw new UiError("fetch", `${path}: the computer answered ${res.status}`);
    }
    return readAll2(res.body, max);
  }
  async function fetchManifest() {
    const bytes = await fetchFile(MANIFEST_PATH, MAX_MANIFEST_BYTES);
    let value;
    try {
      value = JSON.parse(utf8Decode.decode(bytes));
    } catch {
      throw new UiError("manifest", "The computer sent a UI manifest that is not JSON.");
    }
    return checkManifest(value);
  }
  async function alreadyCurrent(prev, loadedHash, computerId = null) {
    const reload = shouldReload({ loadedHash, nextHash: prev.hash, reloadedFor: prev.reloadedFor ?? null });
    const owner = computerOf(computerId);
    const moved = computerOf(prev.computerId) !== owner;
    let record = prev;
    if (reload || moved) {
      record = { ...prev, computerId: owner, ...reload ? { reloadedFor: prev.hash } : {} };
      await storage.writeActive(record);
    }
    try {
      await storage.ensureActive?.(prev, { readBundled, shellBase });
    } catch (err) {
      log(`ui: ${err.code ?? "error"}`);
    }
    return { status: "current", hash: prev.hash, generation: prev.generation, changed: [], reload, record };
  }
  async function pull({ loadedHash = null, computerId = null } = {}) {
    if (platform === "ios") throw new UiError("refused", "iOS runs the bundled UI; desktop files are refused.");
    const next = await fetchManifest();
    const prev = await storage.readActive();
    if (prev && prev.hash === next.hash && prev.complete) return alreadyCurrent(prev, loadedHash, computerId);
    const cacheName = cacheNameFor(next);
    const slot = await storage.openSlot(cacheName);
    const previousSlot = prev && prev.cacheName !== cacheName ? await storage.openSlot(prev.cacheName) : null;
    const diff = diffFiles(prev?.files ?? null, next, () => previousSlot !== null);
    const changed = [];
    try {
      for (const entry of diff.changed) {
        const have = await slot.get(entry.path);
        if (have && have.size === entry.size && sha256Hex(have.bytes) === entry.sha256) continue;
        const bytes = await fetchFile(entry.path, MAX_FILE_BYTES);
        verifyBytes(bytes, entry);
        await slot.put(entry.path, bytes, entry);
        changed.push(entry.path);
      }
      for (const path of diff.reused) {
        const old = await previousSlot.get(path);
        const entry = next.files.find((f) => f.path === path);
        if (old && old.bytes.byteLength === entry.size && sha256Hex(old.bytes) === entry.sha256) {
          await slot.put(path, old.bytes, entry);
        } else {
          const bytes = await fetchFile(path, MAX_FILE_BYTES);
          verifyBytes(bytes, entry);
          await slot.put(path, bytes, entry);
          changed.push(path);
        }
      }
      for (const file of await bundledShellFiles(readBundled)) {
        await slot.put(file.path, file.bytes, { type: contentTypeFor(fileNameFor(file.path)), sha256: sha256Hex(file.bytes), size: file.bytes.byteLength });
      }
    } catch (err) {
      await storage.dropSlot(cacheName).catch(() => {
      });
      log(`ui: ${err.code ?? "error"}`);
      throw err;
    }
    const reload = shouldReload({ loadedHash, nextHash: next.hash, reloadedFor: prev?.reloadedFor ?? null });
    const record = {
      hash: next.hash,
      generation: next.generation,
      desktopVersion: next.desktopVersion,
      cacheName,
      complete: true,
      reloadedFor: reload ? next.hash : prev?.reloadedFor ?? null,
      files: next.files,
      pulledAt: now(),
      computerId: computerOf(computerId)
    };
    await storage.writeActive(record);
    await storage.activate?.(record, { readBundled, shellBase });
    await storage.dropSlotsExcept(cacheName);
    return { status: "updated", hash: next.hash, generation: next.generation, changed, reload, record };
  }
  return {
    pull,
    // The HELLO's uiManifestHash decides whether anything needs fetching: equal hashes need no manifest request at all.
    async check({ helloHash = null, loadedHash = null, computerId = null } = {}) {
      if (platform === "ios") throw new UiError("refused", "iOS runs the bundled UI; desktop files are refused.");
      const prev = await storage.readActive();
      if (prev && prev.complete && helloHash && prev.hash === helloHash) return alreadyCurrent(prev, loadedHash, computerId);
      return pull({ loadedHash, computerId });
    },
    current: () => storage.readActive()
  };
}

// mobile/shell/ui-host.js
var SHELL_QUERY = "shell";
var SHELL_PAGE_KEY = "plenum-shell-page";
var SHELL_BASE_KEY = "plenum-shell-base";
var SHELL_LINK_KEY = "plenum-shell-link";
var UI_ROOT = "plenum-ui";
var BUNDLED_UI_FOLDER = "ui";
var SW_WAIT_MS = 4e3;
var DATA = "DATA";
function causeOf(error) {
  const code = error?.code ?? "";
  if (code === "worker") return "worker";
  if (code === "fetch") return "not-sent";
  if (code === "cancelled" || code === "closed" || code === "stopped" || code === "offline") return "stopped";
  return "checksum";
}
function toBase64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return globalThis.btoa(text);
}
function fromBase64(text) {
  const bin = globalThis.atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
var stripFileScheme = (uri) => String(uri ?? "").replace(/^file:\/\//, "").replace(/\/+$/, "");
function filesOver(filesystem) {
  return {
    async write(rel, bytes) {
      await filesystem.writeFile({ path: rel, data: toBase64(bytes), directory: DATA, recursive: true });
    },
    async read(rel) {
      try {
        const out = await filesystem.readFile({ path: rel, directory: DATA });
        return typeof out?.data === "string" ? fromBase64(out.data) : null;
      } catch {
        return null;
      }
    },
    async removeDir(rel) {
      try {
        await filesystem.rmdir({ path: rel, directory: DATA, recursive: true });
      } catch {
      }
    },
    async listDirs(rel) {
      try {
        const out = await filesystem.readdir({ path: rel, directory: DATA });
        return (out?.files ?? []).filter((f) => f.type === "directory" || f.type === void 0).map((f) => String(f.name ?? f));
      } catch {
        return [];
      }
    }
  };
}
function webViewOver({ webView, filesystem }) {
  let dataRoot = null;
  let noted = null;
  const root = async () => {
    if (dataRoot === null) {
      const out = await filesystem.getUri({ path: "", directory: DATA });
      dataRoot = stripFileScheme(out?.uri);
    }
    return dataRoot;
  };
  const absolute = async (rel) => `${await root()}/${String(rel).replace(/^\/+/, "")}`;
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
      const abs = String(out?.path ?? "");
      const prefix = `${await root()}/`;
      return { path: abs.startsWith(prefix) ? abs.slice(prefix.length) : abs };
    }
  };
}
function bundledReader(fetchImpl, base) {
  return async (rel) => {
    const name = String(rel).replace(/^shell\//, "");
    try {
      const res = await fetchImpl(new URL(name, base).href, { cache: "no-store" });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
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
  swWaitMs = SW_WAIT_MS,
  loaderFactory = createUiLoader,
  // the Node suites pass a fake loader
  setTimer = (fn, ms) => env.setTimeout(fn, ms),
  clearTimer = (id) => env.clearTimeout(id)
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
    }
  };
  const recall = (key) => {
    try {
      return session()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
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
    }
  };
  const recallDurable = (key) => {
    try {
      return durable()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const isShellPage = (value) => typeof value === "string" && /^\/(?![/\\])[^#\s]*\?shell(?:&[^#\s]*)?$/.test(value);
  function androidStore() {
    if (!native?.Filesystem || !native?.WebView) throw new UiError("storage", "The app-data folder is not available.");
    return androidStorage({
      files: filesOver(native.Filesystem),
      webView: webViewOver({ webView: native.WebView, filesystem: native.Filesystem }),
      root: UI_ROOT
    });
  }
  function buildLoader() {
    const channel = channelOf();
    if (!channel) throw new UiError("offline", "The phone is not connected.");
    if (kind === "android") {
      const storage = androidStore();
      const base = location().href;
      return loaderFactory({ channel, storage, platform: "android", shellBase: "/shell/", readBundled: bundledReader(env.fetch.bind(env), base) });
    }
    if (!env.caches) throw new UiError("worker", "This browser cannot keep Plenum's screens.");
    return loaderFactory({ channel, storage: webStorage(env.caches), platform: "web", shellBase: "/shell/" });
  }
  async function workerControls() {
    const sw = env.navigator?.serviceWorker;
    if (!sw) return false;
    if (sw.controller) return true;
    try {
      await Promise.race([sw.ready, new Promise((_, reject) => setTimer(() => reject(new Error("timeout")), swWaitMs))]);
    } catch {
      return Boolean(sw.controller);
    }
    if (sw.controller) return true;
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        if (timer !== null) clearTimer(timer);
        resolve(Boolean(sw.controller));
      };
      sw.addEventListener?.("controllerchange", done, { once: true });
      timer = setTimer(done, swWaitMs);
    });
  }
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
      return new URLSearchParams(String(location()?.search ?? "")).has(SHELL_QUERY);
    },
    // Pulls what the computer has and hands the page to the UI. Resolves { ok: true, status, navigated } or { ok: false, cause, code }.
    async show({ hello, computerId = null, loadedHash = null, onProgress = () => {
    } } = {}) {
      onProgress({ done: 0, total: 1 });
      try {
        if (kind === "lan") {
          this.rememberShellPage();
          location().replace("/");
          return { ok: true, status: "lan", navigated: true };
        }
        if (kind === "ios") {
          const webView = native?.WebView;
          if (!webView?.getServerBasePath || !webView?.setServerBasePath) throw new UiError("storage", "The app cannot switch to its bundled screens.");
          const here = await webView.getServerBasePath();
          const base = String(here?.path ?? "").replace(/\/+$/, "");
          if (!base) throw new UiError("storage", "The bundled screens are not where the app expects them.");
          remember(SHELL_BASE_KEY, base);
          await webView.setServerBasePath({ path: `${base}/${BUNDLED_UI_FOLDER}` });
          return { ok: true, status: "bundled", navigated: true };
        }
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        onProgress({ done: 1, total: 1 });
        if (kind === "android") {
          return { ok: true, status: result.status, navigated: true, reload: result.reload };
        }
        if (!await workerControls()) throw new UiError("worker", "No service worker controls this page.");
        this.rememberShellPage();
        location().replace("/");
        return { ok: true, status: result.status, navigated: true, reload: result.reload };
      } catch (error) {
        log(`ui: ${error?.code ?? "error"}`);
        return { ok: false, cause: causeOf(error), code: error?.code ?? "error" };
      }
    },
    // On the UI page: asks whether the computer has a newer UI. { ok, changed, reload }. The page reloads once per new UI (the loader's
    // shouldReload keeps the count), and the caller does the reload.
    async refresh({ hello, loadedHash = null, computerId = null } = {}) {
      if (kind === "lan" || kind === "ios") return { ok: true, changed: false, reload: false };
      try {
        const loader = buildLoader();
        const result = await loader.check({ helloHash: hello?.uiManifestHash ?? null, loadedHash, computerId });
        return { ok: true, changed: result.status === "updated", reload: result.reload === true };
      } catch (error) {
        log(`ui: ${error?.code ?? "error"}`);
        return { ok: false, changed: false, reload: false, cause: causeOf(error) };
      }
    },
    // Which computer the UI on this page came from (one UI per computer): the active record's computerId on web and Android (null when it is not
    // known: no record, or one written before the id was kept), and 'any' where the page cannot tell and the computer serves it (the LAN page, the
    // iPhone's bundled copy).
    async uiComputerId() {
      if (kind === "lan" || kind === "ios") return "any";
      try {
        const storage = kind === "android" ? androidStore() : env.caches ? webStorage(env.caches) : null;
        const record = storage ? await storage.readActive() : null;
        return typeof record?.computerId === "string" && record.computerId ? record.computerId : null;
      } catch {
        return null;
      }
    },
    // The hash of the UI the cache serves now, or null.
    async loadedHash() {
      if (kind !== "web" || !env.caches) return null;
      try {
        const record = await webStorage(env.caches).readActive();
        return record?.complete === true ? record.hash : null;
      } catch {
        return null;
      }
    },
    // Whether a complete copy of the UI is on the phone, for "Use the copy in this app".
    async hasCopy() {
      if (kind === "ios") return true;
      if (kind === "lan") return false;
      return await this.loadedHash() !== null;
    },
    // Uses the copy that is already on the phone, without asking the computer.
    async useCopy() {
      if (kind === "ios") return this.show({});
      if (kind === "web" && await this.loadedHash() !== null && await workerControls()) {
        this.rememberShellPage();
        location().replace("/");
        return { ok: true, status: "copy", navigated: true };
      }
      return { ok: false, cause: "worker", code: "worker" };
    },
    // From the UI page back to the shell's screens. link (a pairing link, #settings, #computers, #connect=<id>) rides along: in the address on web
    // and LAN pages (the '#...' part only), in the linkStore for the apps (the shell page takes it out once, within two minutes).
    async openShell(link = "") {
      const text = typeof link === "string" ? link : "";
      if (kind === "web" || kind === "lan") {
        location().assign(`${shellUrl()}${text.startsWith("#") ? text : ""}`);
        return true;
      }
      const webView = native?.WebView;
      if (!webView) return false;
      const base = kind === "android" ? null : recall(SHELL_BASE_KEY);
      const switchPage = kind === "android" ? webView.setServerAssetPath ? () => webView.setServerAssetPath({ path: "public" }) : null : base && webView.setServerBasePath ? () => webView.setServerBasePath({ path: base }) : null;
      if (!switchPage) return false;
      if (text) await linkStore?.put(text);
      try {
        await switchPage();
      } catch (error) {
        if (text) {
          try {
            await linkStore?.take();
          } catch {
          }
        }
        throw error;
      }
      return true;
    }
  };
}

// mobile/shell/screens/demo.js
var RUN_STATES = Object.freeze(["running", "finished", "failed", "stopped"]);
function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
function pictureSrc(svg) {
  const text = String(svg ?? "");
  if (!/^\s*<svg[\s>]/.test(text) || /<script/i.test(text)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
}
function createReplay(session) {
  const original = cloneDeep(session) ?? {};
  let state = cloneDeep(original);
  if (!Array.isArray(state.runs)) state.runs = [];
  if (!Array.isArray(state.approvals)) state.approvals = [];
  if (!Array.isArray(state.agents)) state.agents = [];
  if (!Array.isArray(state.artifacts)) state.artifacts = [];
  let stoppedCount = 0;
  const view = () => ({
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
    const card = state.approvals.find((a) => a.id === id);
    if (!card) return { ok: false, reason: "unknown" };
    if (card.state !== "waiting") return { ok: false, reason: "not-waiting" };
    if (decision !== "approve" && decision !== "deny") return { ok: false, reason: "decision" };
    card.state = decision === "approve" ? "approved" : "denied";
    const run = state.runs.find((r) => r.id === card.runId);
    if (run && run.waitingFor === "approval") {
      delete run.waitingFor;
      if (decision === "deny") run.state = "finished";
    }
    return { ok: true, reason: null };
  }
  function stop() {
    const runs = state.runs.filter((r) => r.state === "running").length;
    const drives = state.computerRun && state.computerRun.state === "driving" ? 1 : 0;
    const agents = state.agents.filter((a) => a.state === "running").length;
    const cards = state.approvals.filter((a) => a.state === "waiting").length;
    for (const r of state.runs) if (r.state === "running") {
      r.state = "stopped";
      delete r.waitingFor;
    }
    for (const a of state.agents) if (a.state === "running") a.state = "stopped";
    if (state.computerRun && state.computerRun.state === "driving") state.computerRun.state = "stopped";
    for (const a of state.approvals) if (a.state === "waiting") a.state = "denied";
    stoppedCount += 1;
    const ack = { id: `demo-stop-${stoppedCount}`, cancelled: runs, drivesStopped: drives, agentsStopped: agents, cardsDenied: cards };
    return { ok: true, ack, text: stopResultText(ack, String(state.computer?.name ?? "Demo computer")) };
  }
  function reset() {
    state = cloneDeep(original);
    if (!Array.isArray(state.runs)) state.runs = [];
    if (!Array.isArray(state.approvals)) state.approvals = [];
    if (!Array.isArray(state.agents)) state.agents = [];
    if (!Array.isArray(state.artifacts)) state.artifacts = [];
    stoppedCount = 0;
    return view();
  }
  return { view, decide, stop, reset };
}

// mobile/shell/screens/settings.js
var LOCK_AFTER = Object.freeze([
  Object.freeze({ id: "immediately", ms: 0, label: "Immediately" }),
  Object.freeze({ id: "m1", ms: 60 * 1e3, label: "1 minute" }),
  Object.freeze({ id: "m5", ms: 5 * 60 * 1e3, label: "5 minutes" }),
  Object.freeze({ id: "m15", ms: 15 * 60 * 1e3, label: "15 minutes" }),
  Object.freeze({ id: "h1", ms: 60 * 60 * 1e3, label: "1 hour" })
]);
var DEFAULT_LOCK_AFTER = "m5";
function lockAfter(id) {
  return LOCK_AFTER.find((o) => o.id === id) ?? LOCK_AFTER.find((o) => o.id === DEFAULT_LOCK_AFTER);
}
var WAY_KINDS = Object.freeze(["lan", "tailscale", "relay"]);
function moveWay(order, kind, dir) {
  const list = Array.isArray(order) ? [...order] : [];
  const i = list.indexOf(kind);
  const j = i + (dir === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}
function orderedWays(stored) {
  const seen = [];
  for (const kind of Array.isArray(stored) ? stored : []) {
    if (WAY_KINDS.includes(kind) && !seen.includes(kind)) seen.push(kind);
  }
  for (const kind of WAY_KINDS) if (!seen.includes(kind)) seen.push(kind);
  return seen;
}
var APPROVE_MISSING_TEXT = Object.freeze({
  "first-line": 'Turn on "Include the first line" first.',
  "app-lock": "Turn on the app lock first. On the web app that means a PIN or a passkey."
});
var TEXT_MIN = 85;
var TEXT_MAX = 200;
var TEXT_STEP = 5;
var TEXT_DEFAULT = 100;
function clampText(value) {
  const n = Math.round((Number(value) || TEXT_DEFAULT) / TEXT_STEP) * TEXT_STEP;
  return Math.min(TEXT_MAX, Math.max(TEXT_MIN, n));
}
var THEMES = Object.freeze(["follow", "dark", "light"]);
var THEME_LABEL = Object.freeze({ follow: "Follow phone", dark: "Dark", light: "Light" });
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
]);
var PUSH_DEFAULTS = Object.freeze({ approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false });
function pushValues(known) {
  const out = { ...PUSH_DEFAULTS };
  for (const { key } of PUSH_SWITCHES) {
    if (typeof known?.[key] === "boolean") out[key] = known[key];
  }
  return out;
}
function normalisePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    theme: normaliseTheme(p.theme),
    textSize: p.textSize == null ? null : clampText(p.textSize),
    stopSide: normaliseStopSide(p.stopSide),
    haptics: p.haptics !== false,
    hideSwitcher: p.hideSwitcher !== false,
    lockAfter: lockAfter(p.lockAfter).id,
    dictationOnDevice: p.dictationOnDevice !== false,
    dictationAllowService: p.dictationAllowService !== false,
    lanDismissed: p.lanDismissed === true
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
      defaultDeny: false,
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
var APP_VERSION = true ? "0.5.0" : "0.0.0";
var LINK_VERSION = true ? "1.0" : "1.0";
var DEV_BUILD = true ? false : true;
var pageStarted = false;
var PAGE_STARTED_KEY = "__plenumPageStarted";
function takePageStart() {
  if (pageStarted || Object.getOwnPropertyDescriptor(globalThis, PAGE_STARTED_KEY) !== void 0) return false;
  pageStarted = true;
  try {
    Object.defineProperty(globalThis, PAGE_STARTED_KEY, { value: true });
  } catch {
  }
  return true;
}
var attachShim = (() => {
  const f = globalThis.__plenumAttachShell;
  try {
    delete globalThis.__plenumAttachShell;
  } catch {
  }
  return typeof f === "function" ? f : null;
})();
var giveShellCore = () => {
};
if (typeof document !== "undefined" && document.documentElement?.hasAttribute?.("data-shell-page") && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  const handed = new Promise((resolve) => {
    giveShellCore = resolve;
  });
  Object.defineProperty(globalThis, "__plenumTakeShellCore", {
    configurable: true,
    enumerable: false,
    value: () => {
      try {
        delete globalThis.__plenumTakeShellCore;
      } catch {
      }
      return handed;
    }
  });
}
var ACTIVE_META = "active";
var PREFS_META = "prefs";
var DEMO_COMPUTER = Object.freeze({ id: "demo", name: "Demo computer", carriers: [], lastCarrier: null, lastSeen: null, pairedAt: null, counter: 0 });
var utf83 = new TextEncoder();
var utf8Read = new TextDecoder();
var STOP_RETRY_MS = 60 * 1e3;
var APPROVE_META = "approve";
var STOP_NOTICE = /* @__PURE__ */ new Set(["done", "queued", "failed"]);
var APPROVE_OFF_META = "approve-off-pending";
var LINK_META = "shell-link";
var LINK_TTL_MS = 120 * 1e3;
var NOTIFICATION_LINK_MAX_AGE_MS = 60 * 1e3;
var NOTIFICATION_OLD = "That notification is more than a minute old. Open the approval to answer it.";
var OPEN_SHELL_HASHES = Object.freeze(["", "#settings", "#computers"]);
var FACADE_PLUGINS = Object.freeze(["App", "TextZoom", "Haptics", "Dictation", "IsolatedPreview", "Browser", "Share", "Filesystem"]);
var SW_REGISTRATION_WAIT_MS = 3e3;
var CARD_CHANGED = "That card changed. Open it to answer.";
function modeFor(search, devBuild = DEV_BUILD) {
  const params = new URLSearchParams(String(search ?? ""));
  if (devBuild === true && params.has("selftest")) return "selftest";
  return params.has("demo") ? "demo" : "normal";
}
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) if (item !== void 0) out[key] = frozenCopy(item);
    return Object.freeze(out);
  }
  return value;
}
function safeState(state) {
  const s = state ?? {};
  const hello = s.hello;
  return frozenCopy({
    page: s.page,
    locked: s.locked === true,
    lock: { mode: s.lock?.mode, locked: s.lock?.locked, failures: s.lock?.failures, waitSec: s.lock?.waitSec },
    lockStop: { ready: s.lockStop?.ready === true, computerName: String(s.lockStop?.computerName ?? "") },
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
      const channel = shell.channel;
      if (!channel) return Promise.reject(Object.assign(new Error("offline"), { code: "offline" }));
      return channel.request(spec, body, { signal: opts?.signal ?? null, scope: "page" });
    },
    stop: (project) => shell.stop(project ?? null),
    lock: () => shell.lockNow(),
    unlock: (method, pin = null) => shell.unlock(method, pin),
    connect: (id) => shell.connect(id),
    openShell: (hash) => OPEN_SHELL_HASHES.includes(hash) ? shell.openShell(hash) : Promise.resolve(false),
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
        kept = await meta.get(LINK_META);
        if (kept !== void 0 && kept !== null) await meta.remove(LINK_META);
      } catch {
        return null;
      }
      return kept && typeof kept.text === "string" && typeof kept.at === "number" && now() - kept.at < LINK_TTL_MS ? kept.text : null;
    }
  };
}
function cleanName(name) {
  return String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim().slice(0, 60).trim();
}
function clearAddressHash(env = globalThis) {
  try {
    const loc = env.location;
    if (!loc || !env.history?.replaceState) return;
    env.history.replaceState(null, "", `${loc.pathname}${loc.search}`);
  } catch {
  }
}
function deviceFor(env = globalThis) {
  const native = isNative(env);
  const kind = appKindFor(env);
  return {
    device: { name: kind.name, platform: platformFor(env), app: kind.app, appVersion: APP_VERSION, uiHash: "" },
    caps: capsFor(env),
    native
  };
}
function demoHello(replayView) {
  const drive = replayView?.drive && replayView.drive.state === "driving" ? replayView.drive : null;
  const waiting = (replayView?.approvals ?? []).filter((a) => a.state === "waiting").length;
  const running = (replayView?.runs ?? []).filter((r) => r.state === "running").length;
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
  if (!body || typeof body.getReader !== "function") return "";
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (; ; ) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      reader.cancel?.().catch?.(() => {
      });
      break;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return utf8Read.decode(all);
}
async function registrationOf(serviceWorker, { wait = SW_REGISTRATION_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!serviceWorker) return null;
  try {
    const found = await serviceWorker.getRegistration?.();
    if (found) return found;
  } catch {
  }
  if (!serviceWorker.ready) return null;
  let timer = null;
  const gave = new Promise((resolve) => {
    timer = setTimer(() => resolve(null), wait);
  });
  try {
    return await Promise.race([Promise.resolve(serviceWorker.ready).catch(() => null), gave]);
  } finally {
    clearTimer(timer);
  }
}
async function registerServiceWorker(env = globalThis) {
  const sw = env.navigator?.serviceWorker;
  if (!sw || typeof sw.register !== "function") return null;
  if (isNative(env) || env.isSecureContext !== true || isLanPage(env)) return null;
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
  selftestFn = runSelfTest,
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
  stay = false,
  initialIntent = null,
  initialLink = null,
  onIntent = () => {
  },
  onReload = () => {
  },
  devBuild = DEV_BUILD,
  storage = "ok"
} = {}) {
  if (!store) throw new TypeError("createShell needs a store");
  let computers = [];
  let activeId = null;
  let channel = null;
  let channelState = { status: "idle", carrier: null, desktopName: "", lastSeen: null, since: 0, nextRetryAt: null, failedRounds: 0, failure: null };
  let hello = null;
  let stopCtl = null;
  let stopView = { state: "idle", ack: null, error: null, text: "", seq: 0 };
  let notice = null;
  let noticeSeq = 0;
  let stopSeq = 0;
  let pendingLink = null;
  let pendingPair = null;
  let forceUi = false;
  let screenRequest = null;
  let screenSeq = 0;
  let pairing = null;
  let pairingFlow = null;
  let lockStatus = { mode: "off", locked: false, failures: 0, waitSec: 0 };
  let lockStop = { ready: false, computerName: "" };
  let lockedCtl = null;
  let selftest = null;
  let booted = false;
  let lockKnown = () => {
  };
  const lockRead = new Promise((resolve) => {
    lockKnown = resolve;
  });
  let lockUnreadable = false;
  let loaded = false;
  let started = false;
  let prefs = normalisePrefs(null);
  let pushKnown = null;
  let approveStored = false;
  let hiddenAt = null;
  let pairedSeq = 0;
  let pairedId = null;
  let ui = { state: "idle", cause: null, progress: null, hasCopy: false };
  let loadedUiHash;
  let refreshingUi = false;
  let holdUi = false;
  let leaving = false;
  let intent = initialIntent && typeof initialIntent === "object" ? { ...initialIntent, seq: 1, taken: false } : null;
  let intentSeq = intent ? 1 : 0;
  let dictationState = null;
  let androidPushState = null;
  const replay = mode === "demo" ? createReplay(session_default) : null;
  const unlockedKeys = /* @__PURE__ */ new Map();
  const subs = /* @__PURE__ */ new Set();
  const wall = () => typeof stopClock?.now === "function" ? stopClock.now() : Date.now();
  const androidPush = native && device.platform === "android" && native.UnifiedPush ? createAndroidPush({
    native,
    requestOf: () => channel?.request,
    vapidOf: () => typeof hello?.vapidPublicKey === "string" ? hello.vapidPublicKey : null,
    isVisible: () => pushEnv?.document?.visibilityState !== "hidden",
    onLink: (link) => {
      api.handleHash(link).catch(() => {
      });
    },
    log: (line) => debug.log(line, "warn")
  }) : null;
  const view = () => ({
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
  });
  let snapshot = view();
  const refresh = () => {
    if (replay) hello = demoHello(replay.view());
    snapshot = view();
    for (const fn of Array.from(subs)) {
      try {
        fn(snapshot);
      } catch {
      }
    }
    leaveForShellIfNeeded();
    return snapshot;
  };
  function say(text, tone = "info") {
    noticeSeq += 1;
    notice = { seq: noticeSeq, text: String(text ?? ""), tone };
  }
  function route() {
    if (mode === "demo") return "demo";
    if (lockStatus.locked) return "locked";
    if (pairing && !["allowed", "denied", "expired", "mismatch", "failed"].includes(pairing.state)) return "code";
    if (mode === "selftest") return "selftest";
    if (!computers.length) return "welcome";
    if (computers.length > 1 && !channel) return "computers";
    return channel ? "connected" : "computers";
  }
  function publicHello(h) {
    return {
      desktopName: String(h.desktopName ?? ""),
      desktopVersion: String(h.desktopVersion ?? ""),
      protocol: h.protocol ?? null,
      deviceId: typeof h.deviceId === "string" ? h.deviceId : "",
      tier: h.tier ?? null,
      caps: Array.isArray(h.caps) ? [...h.caps] : [],
      pending: h.pending ?? null,
      minShell: h.minShell ?? null
    };
  }
  async function loadComputers() {
    const list = await store.publicList();
    computers = list.map((c) => ({ ...c }));
    await refreshLockStop();
  }
  async function lockStopTarget() {
    let id = activeId;
    if (!id) id = await store.meta.get(ACTIVE_META).catch(() => null);
    let record = id ? await store.get(id) : null;
    if (!record) {
      const list = await store.publicList();
      if (list.length === 1) record = await store.get(list[0].id);
    }
    return record ?? null;
  }
  async function refreshLockStop() {
    let next = { ready: false, computerName: "" };
    try {
      const target = await lockStopTarget();
      if (target) next = { ready: publicComputer(target)?.stopReady === true, computerName: String(target.name ?? "") };
    } catch {
    }
    lockStop = next;
  }
  function keyedRecord(record) {
    if (typeof record.myPriv === "string") return record;
    const key = unlockedKeys.get(record.id);
    if (!key) return null;
    return { ...record, myPriv: bytesToB64u(key) };
  }
  function applyStopView(v) {
    const changed = v.state !== stopView.state;
    const seq = changed && STOP_NOTICE.has(v.state) ? ++stopSeq : stopView.seq;
    stopView = { ...v, seq };
    if (changed && v.state === "done") say(v.text, "ok");
    if (changed && v.state === "queued") say(v.text, "warn");
    refresh();
  }
  function bindStop(ch, name) {
    stopCtl?.dispose();
    stopCtl = createStopController({ channel: ch, clock: stopClock, computerName: name });
    stopCtl.subscribe(applyStopView);
  }
  async function lockedStop(project) {
    if (lockedCtl && (stopView.state === "sending" || stopView.state === "queued")) return lockedCtl.press(project);
    const target = await lockStopTarget().catch(() => null);
    if (!target || publicComputer(target)?.stopReady !== true) {
      say(STOP_NEEDS_UNLOCK, "warn");
      pendingLink = { text: "#stop", at: wall() };
      refresh();
      return { ...stopView, state: "idle", reason: "needs-unlock" };
    }
    const listeners = /* @__PURE__ */ new Set();
    const viaLockedWorker = {
      stop: () => sendLockedStop({ record: target, store, createWorker, onStopState: (view2) => {
        for (const fn of Array.from(listeners)) fn(view2);
      } }),
      onStopState: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      }
    };
    lockedCtl?.dispose();
    lockedCtl = createStopController({ channel: viaLockedWorker, clock: stopClock, computerName: String(target.name ?? "") });
    lockedCtl.subscribe(applyStopView);
    const out = await lockedCtl.press(project);
    refresh();
    return out;
  }
  function attachChannel(ch, name) {
    channel = ch;
    bindStop(ch, name);
    ch.onState((s) => {
      channelState = { ...s };
      if (s.status !== "connected") {
        hello = null;
      }
      refresh();
    });
    ch.onEvent((event) => {
      if (event && event.type === "phone" && event.kind === "revoked") refresh();
    });
    ch.onHello((h) => {
      hello = h;
      refresh();
      loadPush();
      retryApproveOff();
      refreshLockStop().then(refresh);
      afterHello();
    });
    refresh();
  }
  function retireChannel(ch) {
    if (!ch) return;
    if (stopView.state === "queued" || stopView.state === "sending") {
      stopClock.setTimeout(() => ch.close(), STOP_RETRY_MS + 1e3);
      return;
    }
    ch.close();
  }
  async function loadPush() {
    if (replay || !channel) return;
    const out = await postJson("/api/phones/push", {});
    if (out.ok && out.json?.push && typeof out.json.push === "object") {
      pushKnown = { ...out.json.push };
      refresh();
    }
  }
  async function keepApprove(on) {
    approveStored = on === true;
    if (!replay) await store.meta.put(APPROVE_META, approveStored).catch(() => {
    });
  }
  async function runPendingLink() {
    const link = pendingLink;
    if (!link) return null;
    const parsed = parseNotificationHash(link.text);
    if (lockStatus.locked || lockUnreadable) {
      if (parsed?.kind !== "stop") return null;
      pendingLink = null;
      return api.stop();
    }
    pendingLink = null;
    if ((parsed?.kind === "approve" || parsed?.kind === "deny") && wall() - link.at > NOTIFICATION_LINK_MAX_AGE_MS) {
      say(NOTIFICATION_OLD, "warn");
      emitRoute({ kind: "waiting", id: parsed.id });
      return { ok: false, reason: "expired", kind: parsed.kind };
    }
    return api.handleHash(link.text);
  }
  async function retryApproveOff() {
    if (replay) return;
    const waiting = await store.meta.get(APPROVE_OFF_META).catch(() => null);
    if (waiting !== true) return;
    const out = await postJson("/api/phones/push", { approveFromNotifications: false });
    if (!out.ok) return;
    await keepApprove(false);
    await store.meta.remove(APPROVE_OFF_META).catch(() => {
    });
    refresh();
  }
  async function connectNow(id) {
    const record = await store.get(id);
    if (!record) return { ok: false, reason: "unknown" };
    const keyed = keyedRecord(record);
    if (!keyed) return { ok: false, reason: "locked" };
    if (channel) {
      retireChannel(channel);
      channel = null;
    }
    hello = null;
    activeId = id;
    await store.meta.put(ACTIVE_META, id).catch(() => {
    });
    await refreshLockStop();
    const ch = openChannel({
      computer: keyed,
      store,
      device,
      caps,
      createWorker,
      onWorkerError: (line) => debug.log(`channel: ${line}`, "warn")
    });
    attachChannel(ch, keyed.name);
    return { ok: true, id };
  }
  async function postJson(path, body, headers = {}) {
    if (!channel) return { ok: false, status: 0, json: null, reason: "offline" };
    try {
      const res = await channel.request({ method: "POST", path, headers: { "content-type": "application/json", ...headers } }, JSON.stringify(body ?? {}), { scope: "shell" });
      const text = await readText(res.body);
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const ok = res.status >= 200 && res.status < 300;
      return { ok, status: res.status, json, reason: ok ? null : json?.error ?? "failed" };
    } catch (err) {
      return { ok: false, status: 0, json: null, reason: String(err?.code ?? "offline") };
    }
  }
  const shellRequest = (ch) => (spec, body, opts) => ch.request(spec, body, { ...opts ?? {}, scope: "shell" });
  function whenConnected(ms = 8e3) {
    if (!channel) return Promise.resolve(false);
    if (hello) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      let off = () => {
      };
      const done = (value) => {
        if (timer !== null) stopClock.clearTimeout(timer);
        off();
        resolve(value);
      };
      timer = stopClock.setTimeout(() => done(false), ms);
      off = api.subscribe(() => {
        if (hello) done(true);
        else if (!channel) done(false);
      });
    });
  }
  async function savePrefs(next) {
    prefs = normalisePrefs(next);
    await store.meta.put(PREFS_META, prefs).catch(() => {
    });
    return refresh();
  }
  let appliedHide = null;
  async function applyPrivacy() {
    if (device.platform !== "android" || !native?.PlenumPrivacy?.setHideInSwitcher) return;
    const enabled = prefs.hideSwitcher !== false;
    if (appliedHide === enabled) return;
    try {
      await native.PlenumPrivacy.setHideInSwitcher({ enabled });
      appliedHide = enabled;
    } catch (err) {
      debug.log(`privacy: ${err?.code ?? "failed"}`, "warn");
    }
  }
  async function loadDictation() {
    if (!native?.Dictation?.available) return;
    try {
      const out = await native.Dictation.available();
      dictationState = { available: out?.available === true, onDevice: out?.onDevice === true, permission: String(out?.permission ?? "prompt") };
    } catch {
      dictationState = { available: false, onDevice: false, permission: "prompt" };
    }
    refresh();
  }
  async function loadAndroidPush() {
    if (!androidPush) return;
    await androidPush.start();
    androidPushState = await androidPush.state();
    refresh();
  }
  function afterHello() {
    if (!uiHost || replay || mode !== "normal") return;
    if (pageKind === "ui") {
      refreshUi();
      return;
    }
    if (lockStatus.locked || holdUi) return;
    if (forceUi) {
      forceUi = false;
      showUi({ force: true });
      return;
    }
    if (stay) return;
    showUi();
  }
  async function showUi({ force = false } = {}) {
    if (!uiHost || pageKind !== "shell" || !hello || replay) return { ok: false, reason: "unavailable" };
    if (ui.state === "loading" || ui.state === "navigating") return { ok: true, reason: null };
    if (stay && !force) return { ok: false, reason: "stay" };
    ui = { state: "loading", cause: null, progress: { done: 0, total: 1 }, hasCopy: false };
    refresh();
    const out = await uiHost.show({
      hello,
      computerId: activeId,
      loadedHash: null,
      onProgress: (progress) => {
        ui = { ...ui, progress };
        refresh();
      }
    });
    if (out.ok) {
      ui = { ...ui, state: "navigating", progress: { done: 1, total: 1 } };
    } else {
      ui = { state: "failed", cause: out.cause ?? "checksum", progress: null, hasCopy: await uiHost.hasCopy().catch(() => false) };
    }
    refresh();
    return { ok: out.ok, reason: out.ok ? null : out.cause };
  }
  async function refreshUi() {
    if (!uiHost || refreshingUi) return;
    refreshingUi = true;
    try {
      if (loadedUiHash === void 0) loadedUiHash = await uiHost.loadedHash();
      const out = await uiHost.refresh({ hello, loadedHash: loadedUiHash, computerId: activeId });
      if (out.ok && out.reload) onReload();
    } finally {
      refreshingUi = false;
    }
  }
  async function uiComputerOf() {
    return typeof uiHost?.uiComputerId === "function" ? uiHost.uiComputerId() : "any";
  }
  function leaveForShellIfNeeded() {
    if (pageKind !== "ui" || !uiHost || leaving || !loaded || mode !== "normal") return;
    const status = channelState.status;
    const needs = computers.length === 0 || ["revoked", "update-app", "update-desktop"].includes(status);
    if (!needs) return;
    leaving = true;
    Promise.resolve(uiHost.openShell()).catch(() => {
      leaving = false;
    });
  }
  function emitRoute(link) {
    intentSeq += 1;
    intent = { ...link, seq: intentSeq, taken: false };
    if (pageKind === "shell") onIntent({ ...link });
    refresh();
  }
  const api = {
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
      booted = true;
      prefs = normalisePrefs(await store.meta.get(PREFS_META).catch(() => null));
      approveStored = await store.meta.get(APPROVE_META).catch(() => null) === true;
      try {
        if (lock) {
          await lock.lockOnLaunch();
          lockStatus = { ...lockStatus, ...await lock.status() };
        }
      } catch {
        lockUnreadable = true;
        lockStatus = { ...lockStatus, mode: "unknown", locked: true };
      } finally {
        lockKnown();
      }
      try {
        await loadComputers();
      } catch {
        computers = [];
      }
      loaded = true;
      applyPrivacy();
      loadDictation();
      loadAndroidPush();
      if (mode === "demo") {
        computers = [{ ...DEMO_COMPUTER }];
        activeId = DEMO_COMPUTER.id;
        channelState = { ...channelState, status: "connected", carrier: "lan", desktopName: "Demo computer", since: Date.now() };
        return refresh();
      }
      const saved = await store.meta.get(ACTIVE_META).catch(() => null);
      if (lockStatus.locked) return refresh();
      if (mode === "selftest" || computers.length) {
        const asked = /^#connect=([0-9a-f]{64})$/.exec(pendingLink?.text ?? "")?.[1] ?? null;
        const target = computers.find((c) => c.id === asked) ?? computers.find((c) => c.id === saved) ?? computers[0];
        if (target) {
          if (pageKind === "ui" && uiHost) {
            const uiFor = await uiComputerOf();
            if (uiFor !== "any" && uiFor !== target.id) {
              await api.openShell(`#connect=${target.id}`);
              return refresh();
            }
          }
          const opened = await connectNow(target.id);
          if (!opened.ok) debug.log(`connect: ${opened.reason}`, "warn");
        }
      }
      return refresh();
    },
    // Pairing from a link. The final state is returned (allowed, denied, expired, mismatch or failed).
    async pair(text, options = {}) {
      if (mode === "demo") {
        pairing = { state: "failed", code: null, tried: [], reason: "demo" };
        refresh();
        return { ...pairing };
      }
      if (lockStatus.locked) {
        pairing = { state: "failed", code: null, tried: [], reason: "locked" };
        refresh();
        return { ...pairing };
      }
      let payload;
      try {
        payload = parsePairingText(text);
      } catch (err) {
        pairing = { state: "failed", code: null, tried: [], reason: err?.code ?? "not-plenum" };
        refresh();
        return { ...pairing };
      }
      pairing = { state: "starting", code: null, tried: [], reason: null };
      refresh();
      let wrapped = null;
      const typed = cleanName(options?.name);
      const flow = startPairing({
        payload,
        store,
        createWorker,
        device: typed ? { ...device, name: typed } : device,
        caps,
        pageUrl,
        prepareRecord: async (record) => {
          const kept = lock ? await lock.protect(record) : record;
          if (kept !== record) wrapped = { id: record.id, key: b64uToBytes(record.myPriv) };
          return kept;
        },
        onState: (s) => {
          pairing = { ...s };
          refresh();
        }
      });
      pairingFlow = flow;
      const final = await flow.done;
      if (pairingFlow === flow) pairingFlow = null;
      if (final.state === "allowed") {
        await loadComputers();
        const id = final.computerId ?? computers.at(-1)?.id;
        pairing = null;
        pairedSeq += 1;
        pairedId = id ?? null;
        holdUi = true;
        if (wrapped) unlockedKeys.set(wrapped.id, wrapped.key);
        if (id && !lockStatus.locked) await connectNow(id);
        refresh();
        return { ...final, computerId: id ?? null };
      }
      refresh();
      return { ...final };
    },
    async connect(id) {
      if (lockStatus.locked) return { ok: false, reason: "locked" };
      if (pageKind === "ui" && uiHost) {
        const uiFor = await uiComputerOf();
        if (uiFor !== "any" && uiFor !== id) {
          await api.openShell(`#connect=${id}`);
          return { ok: true, reason: "opening" };
        }
      }
      const result = await connectNow(id);
      refresh();
      return result;
    },
    async stop(project = null) {
      if (replay) {
        const out2 = replay.stop();
        stopView = { state: "done", ack: out2.ack, error: null, text: out2.text, seq: ++stopSeq };
        say(out2.text, "ok");
        refresh();
        stopClock.setTimeout(() => {
          if (stopView.state !== "done") return;
          stopView = { state: "idle", ack: null, error: null, text: "", seq: stopView.seq };
          refresh();
        }, STOP_DONE_MS);
        return { ...stopView };
      }
      if (lockStatus.locked || lockUnreadable) return lockedStop(project);
      if (!stopCtl) return { ...stopView, state: "idle", text: "Nothing to stop: no computer is connected." };
      const out = await stopCtl.press(project);
      refresh();
      return out;
    },
    async forget(id) {
      if (replay) return { ...refresh(), ok: false, reason: "demo" };
      if (activeId === id && channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        channelState = { ...channelState, status: "closed" };
        activeId = null;
        await store.meta.remove(ACTIVE_META).catch(() => {
        });
      }
      unlockedKeys.delete(id);
      await store.remove(id);
      await loadComputers();
      return { ...refresh(), ok: true, reason: null };
    },
    // Phone settings: the name on this phone only (the computer keeps its own).
    async rename(id, name) {
      if (replay) return { ok: false, reason: "demo" };
      const clean3 = cleanName(name);
      if (!id || !clean3) return { ok: false, reason: "name" };
      const saved = await store.patchComputer(id, { name: clean3 });
      if (!saved) return { ok: false, reason: "unknown" };
      await loadComputers();
      if (activeId === id) hello = hello ? { ...hello } : null;
      refresh();
      return { ok: true, reason: null };
    },
    // Ways to reach: Move up and Move down reorder the carriers the record holds. The order is used at the next connection.
    async moveWay(id, kind, dir) {
      if (replay) return { ok: false, reason: "demo" };
      const record = await store.get(id);
      if (!record) return { ok: false, reason: "unknown" };
      const current = (Array.isArray(record.carriers) ? record.carriers : []).map((c) => c.kind);
      const order = orderedWays(current);
      const next = moveWay(order, kind, dir);
      if (next.join() === order.join()) return { ok: true, reason: null, order: next };
      const sorted = [...record.carriers].sort((a, b) => next.indexOf(a.kind) - next.indexOf(b.kind));
      await store.patchComputer(id, { carriers: sorted });
      await loadComputers();
      refresh();
      return { ok: true, reason: null, order: next };
    },
    // Test them now: the phone reconnects and the carrier that answers is shown in the connection state.
    async testWays(id) {
      if (replay) return { ok: false, reason: "demo" };
      if (!channel || activeId !== id) return { ok: false, reason: "offline" };
      channel.reconnect?.();
      refresh();
      return { ok: true, reason: null };
    },
    // Notifications kept on the computer (POST /api/phones/push). A switch the computer refuses stays where it was.
    async setPush(patch) {
      if (replay) {
        pushKnown = { ...pushValues(pushKnown), ...patch };
        refresh();
        return { ok: true, reason: null };
      }
      const sent = patch.firstLine === false ? { ...patch, approveFromNotifications: false } : { ...patch };
      const out = await postJson("/api/phones/push", sent);
      if (out.ok) {
        pushKnown = { ...pushValues(pushKnown), ...patch };
        if (sent.approveFromNotifications !== void 0) await keepApprove(sent.approveFromNotifications === true);
      }
      refresh();
      return { ok: out.ok, reason: out.reason };
    },
    // Approve from notifications: asked of the computer, which checks the first line itself (409 when it is off).
    async setApprove(value) {
      const on = value === true;
      if (on && !(pushKnown?.firstLine === true)) return { ok: false, reason: "first-line" };
      if (replay) {
        approveStored = on;
        refresh();
        return { ok: true, reason: null };
      }
      const out = await postJson("/api/phones/push", { approveFromNotifications: on });
      if (out.ok) await keepApprove(on);
      refresh();
      return { ok: out.ok, reason: out.reason };
    },
    async testPush() {
      if (replay) return { ok: true, reason: null };
      const out = await postJson("/api/phones/test-push", {});
      refresh();
      return { ok: out.ok, reason: out.reason };
    },
    // Turn on notifications: the browser's permission (the user gesture is the tap on the screen). The native app asks through its plugin.
    // Web: the permission, then the push subscription, which the computer keeps: "Allowed" means a subscription is on the computer. The
    // computer's VAPID public key comes in its HELLO (vapidPublicKey); without it nothing is subscribed and the answer says so.
    // Android: UnifiedPush through the person's push app (push.js createAndroidPush); the endpoint it gives goes to the computer.
    async enableNotifications() {
      if (replay) return { ok: true, reason: null };
      if (androidPush) {
        const out2 = await androidPush.enable();
        androidPushState = await androidPush.state();
        refresh();
        return { ok: out2.ok === true, reason: out2.ok === true ? null : out2.reason ?? "failed" };
      }
      const key = typeof hello?.vapidPublicKey === "string" ? hello.vapidPublicKey : null;
      if (!key || !channel || !serviceWorker || !notifications) return { ok: false, reason: "unavailable" };
      const registration = await registrationOf(serviceWorker);
      if (!registration) return { ok: false, reason: "unavailable" };
      const out = await subscribeWebPush({
        registration,
        applicationServerKey: key,
        request: channel.request,
        deviceId: typeof hello?.deviceId === "string" && hello.deviceId ? hello.deviceId : activeId,
        notification: notifications,
        env: pushEnv
      });
      refresh();
      if (out.ok) return { ok: true, reason: null };
      if (out.state === "denied") return { ok: false, reason: "denied" };
      if (out.state === "unsupported") return { ok: false, reason: "unavailable" };
      return { ok: false, reason: "failed" };
    },
    notificationPermission() {
      return notifications?.permission ?? "unknown";
    },
    // Android: the person chooses the push app (the system chooser). The settings line reads the answer from state().androidPush.
    async chooseDistributor() {
      if (!androidPush) return { ok: false, reason: "unavailable" };
      const out = await androidPush.chooseDistributor();
      androidPushState = await androidPush.state();
      refresh();
      return out;
    },
    // Turn the notifications of this phone off at the computer (the subscription is dropped there).
    async disableNotifications() {
      if (replay) return { ok: true, reason: null };
      if (androidPush) {
        const out2 = await androidPush.disable();
        androidPushState = await androidPush.state();
        refresh();
        return out2;
      }
      const out = await postJson("/api/phones/push", { subscription: null });
      refresh();
      return { ok: out.ok, reason: out.reason };
    },
    // App lock on: biometric (native), a passkey (web) or a PIN (web, through setPin).
    async enableLock(mode2) {
      if (!lock) return { ok: false, reason: "unavailable" };
      let result;
      if (mode2 === "biometric") result = await lock.enableBiometric();
      else if (mode2 === "passkey") result = await lock.enablePasskey();
      else return { ok: false, reason: "mode" };
      lockStatus = { ...lockStatus, ...await lock.status() };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },
    async setPin(pin) {
      if (!lock) return { ok: false, reason: "unavailable" };
      const result = await lock.setPin(String(pin ?? ""));
      if (result?.ok) for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
      lockStatus = { ...lockStatus, ...await lock.status() };
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? null };
    },
    async lockOff(pin = null) {
      if (!lock) return { ok: false, reason: "unavailable" };
      const result = await lock.disable({ pin: pin === null ? null : String(pin) });
      lockStatus = { ...lockStatus, ...await lock.status() };
      if (result?.ok && approveStored && !replay) {
        let told = false;
        if (channel) {
          const out = await postJson("/api/phones/push", { approveFromNotifications: false });
          if (out.ok) {
            await keepApprove(false);
            told = true;
          }
        }
        if (!told) await store.meta.put(APPROVE_OFF_META, true).catch(() => {
        });
      }
      refresh();
      return { ok: result?.ok === true, reason: result?.reason ?? (result?.ok ? null : "pin") };
    },
    // The phone's own preferences (theme, text size, Stop side, haptics, switcher, lock time, dictation, the LAN strip).
    async setPrefs(patch) {
      await savePrefs({ ...prefs, ...patch ?? {} });
      applyPrivacy();
      return { ok: true, reason: null };
    },
    cancelConnect() {
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
        channelState = { ...channelState, status: "closed" };
        activeId = null;
        store.meta.remove(ACTIVE_META).catch(() => {
        });
        refreshLockStop().then(refresh);
      }
      refresh();
      return { ok: true, reason: null };
    },
    // Drops a pairing in progress, and a pairing link that waits for review.
    cancelPairing() {
      const flow = pairingFlow;
      pairingFlow = null;
      pendingPair = null;
      try {
        flow?.cancel?.();
      } catch {
      }
      pairing = null;
      refresh();
      return { ok: true, reason: null };
    },
    // The person pressed Pair on the review screen: the parked link starts pairing. Resolves the final pairing state, or { ok: false, reason: 'none' }.
    async confirmPair() {
      const parked = pendingPair;
      if (!parked) return { ok: false, reason: "none" };
      pendingPair = null;
      return api.pair(parked.text);
    },
    // A line from the UI page's console (the facade's log): redacted, kept in the phone's own console and, when connected, sent to the computer.
    pageLog(line) {
      const entry = debug.log(String(line ?? "").slice(0, 2e3), "page");
      if (entry && channel && !replay) {
        channel.request({ method: "POST", path: "/_bridge/log", headers: { "content-type": "application/json" } }, JSON.stringify({ line: entry.text }), { scope: "shell" }).then((answer) => answer.cancel?.(), () => {
        });
      }
      return Boolean(entry);
    },
    debugClear() {
      debug.clear();
      refresh();
      return { ok: true, reason: null };
    },
    // Posts the most recent debug lines to the computer. A phone not connected cannot send (the screen says so).
    async debugSend() {
      if (replay) return { ok: true, reason: null, n: 0 };
      if (!channel) return { ok: false, reason: "offline", n: 0 };
      const n = await debug.sendToComputer(shellRequest(channel), 100).catch(() => 0);
      return { ok: n > 0, reason: n > 0 ? null : "failed", n };
    },
    async demoDecide(id, decision) {
      if (!replay) return { ok: false, reason: "not-demo" };
      const out = replay.decide(id, decision);
      refresh();
      return out;
    },
    demoReset() {
      if (!replay) return { ok: false, reason: "not-demo" };
      replay.reset();
      stopView = { state: "idle", ack: null, error: null, text: "", seq: stopView.seq };
      refresh();
      return { ok: true, reason: null };
    },
    async unlock(method, arg = null) {
      if (!lock) return { ok: false, reason: "unavailable" };
      let result;
      if (method === "biometric") result = await lock.unlockBiometric();
      else if (method === "pin") result = await lock.unlockPin(arg);
      else if (method === "passkey") result = await lock.unlockPasskey();
      else return { ok: false, reason: "method" };
      if (result.ok) {
        for (const [id, key] of result.keys ?? []) unlockedKeys.set(id, key);
        lockUnreadable = false;
        lockStatus = { ...lockStatus, ...await lock.status(), locked: false };
        refresh();
        const saved = await store.meta.get(ACTIVE_META).catch(() => null);
        if (saved && computers.some((c) => c.id === saved)) await connectNow(saved);
        await runPendingLink();
        refresh();
      } else {
        lockStatus = { ...lockStatus, ...await lock.status() };
        refresh();
      }
      return { ok: result.ok, reason: result.reason ?? null, waitSec: result.waitSec ?? 0, failures: result.failures ?? 0 };
    },
    // Locks the app now. With no lock set there is nothing to unlock with, so nothing happens: the channel stays open and Stop stays reachable
    // (F4: locking without a lock used to close the channel and leave the phone locked until it was relaunched).
    async lockNow() {
      const status = lock ? await lock.status() : { mode: "off" };
      if (!lock || status.mode === "off") return { ok: false, reason: "no-lock" };
      if (channel) {
        retireChannel(channel);
        channel = null;
        hello = null;
      }
      unlockedKeys.clear();
      await refreshLockStop();
      lock.lock();
      lockStatus = { ...lockStatus, ...await lock.status(), locked: true };
      refresh();
      return { ok: true, reason: null };
    },
    // The page went to the background or came back. The lock comes on after the time the person chose (prefs.lockAfter, five
    // minutes by default); "Immediately" locks on every return. The channel reconnects at once on return.
    async visibility(visible) {
      if (!visible) {
        hiddenAt = wall();
        return refresh();
      }
      const away = hiddenAt == null ? null : wall() - hiddenAt;
      hiddenAt = null;
      if (lock) {
        const after = lockAfter(prefs.lockAfter).ms;
        const locked = lockStatus.mode !== "off" && away !== null && away >= after;
        if (locked && !lockStatus.locked) await api.lockNow();
      }
      channel?.reconnect();
      return refresh();
    },
    async runSelftest(options = {}) {
      if (!channel) return { ok: false, passed: 0, total: 5, steps: [], reason: "not connected" };
      selftest = { running: true };
      refresh();
      const report = await selftestFn({
        channel,
        log: (line) => debug.log(line),
        ...options
      });
      selftest = { ...report, running: false };
      if (mode === "selftest") await debug.sendToComputer(shellRequest(channel), 1).catch(() => 0);
      refresh();
      return report;
    },
    // A link the page was opened with, a fragment the service worker posts, a native deep link or a fragment typed into the address bar:
    // a pairing link (#pair=..., plenum://pair#...), or a notification link (see push.js parseNotificationHash). While the app is locked the
    // link waits for the unlock.
    async handleHash(hash) {
      const text = String(hash ?? "");
      if (pageKind === "shell" && (text === "#settings" || text === "#computers")) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: "locked" };
        }
        screenSeq += 1;
        screenRequest = { screen: text.slice(1), seq: screenSeq };
        refresh();
        return { ok: true, reason: null, kind: "screen" };
      }
      const connectId = pageKind === "shell" ? /^#connect=([0-9a-f]{64})$/.exec(text)?.[1] ?? null : null;
      if (connectId) {
        if (booted) await lockRead;
        if (lockStatus.locked || lockUnreadable) {
          pendingLink = { text, at: wall() };
          return { ok: false, reason: "locked" };
        }
        if (!computers.some((c) => c.id === connectId)) return { ok: false, reason: "unknown", kind: "connect" };
        forceUi = true;
        if (channel && activeId === connectId) {
          if (hello) afterHello();
          return { ok: true, reason: null, kind: "connect" };
        }
        const opened = await connectNow(connectId);
        if (!opened.ok) forceUi = false;
        refresh();
        return { ...opened, kind: "connect" };
      }
      const isPair = text.includes("pair=") || /^plenum:\/\/pair#/.test(text);
      const link = parseNotificationHash(text);
      if (!isPair && !link) return { ok: false, reason: "no link" };
      if (booted) await lockRead;
      if (lockStatus.locked || lockUnreadable) {
        if (!isPair && link?.kind === "stop") return api.stop();
        pendingLink = { text, at: wall() };
        return { ok: false, reason: "locked" };
      }
      if (isPair) {
        if (pageKind === "ui" && uiHost) {
          leaving = true;
          await uiHost.openShell(text).catch(() => {
          });
          return { ok: true, reason: null, kind: "pair" };
        }
        const marked = /&ci-confirm=1$/.test(text);
        const bare = marked ? text.replace(/&ci-confirm=1$/, "") : text;
        if (replay || marked && devBuild) return api.pair(bare);
        let payload;
        try {
          payload = parsePairingText(bare);
        } catch (err) {
          pairing = { state: "failed", code: null, tried: [], reason: err?.code ?? "not-plenum" };
          refresh();
          return { ...pairing };
        }
        const hosts = [];
        const addHost = (kind, url) => {
          const host = hostLabel(url);
          if (host && !hosts.some((h) => h.kind === kind && h.host === host)) hosts.push({ kind, host });
        };
        for (const c of usableCarriers(payload.carriers)) for (const url of c.urls) addHost(c.kind, url);
        for (const c of pageCandidates(pageUrl, payload)) if (carrierUrlOk(c.kind, c.url)) addHost(c.kind, c.url);
        if (!hosts.length) {
          pairing = { state: "failed", code: null, tried: [], reason: "no-carrier" };
          refresh();
          return { ...pairing };
        }
        pendingPair = { text: bare };
        pairing = { state: "review", code: null, tried: [], reason: null, review: { name: cleanName(payload.name) || "Plenum computer", hosts } };
        refresh();
        return { ok: true, reason: null, kind: "review" };
      }
      if (link.kind === "stop") {
        if (channel) return api.stop();
        say("Nothing to stop: no computer is connected.", "warn");
        refresh();
        return { ok: false, reason: "not connected" };
      }
      if (link.kind === "deny") {
        if (!await whenConnected()) {
          say("Not connected. Open the approval to answer it.", "warn");
          refresh();
          return { ok: false, reason: "offline", kind: "deny" };
        }
        const out = await postJson("/api/approve", { approvalId: link.id, allow: false });
        say(out.ok ? "Denied." : "That card is no longer waiting. Open it to see what changed.", out.ok ? "ok" : "warn");
        refresh();
        return { ok: out.ok, reason: out.reason, kind: "deny" };
      }
      if (link.kind === "approve") {
        const reachable = link.line ? await whenConnected() : Boolean(channel);
        if (!link.line || !reachable) {
          say(reachable ? "Open the approval to answer it." : "Not connected. Open the approval to answer it.", reachable ? "info" : "warn");
          emitRoute({ kind: "waiting", id: link.id });
          return { ok: false, reason: reachable ? "open-card" : "offline", kind: "approve" };
        }
        const out = await postJson("/api/approve", { approvalId: link.id, allow: true }, { "x-plenum-notify-line": link.line });
        if (out.ok) {
          say("Approved.", "ok");
          refresh();
          return { ok: true, reason: null, kind: "approve" };
        }
        if (out.status === 409 || out.status === 403) {
          say(CARD_CHANGED, "warn");
          emitRoute({ kind: "waiting", id: link.id });
          return { ok: false, reason: "changed", kind: "approve" };
        }
        say("Could not reach your computer. Open the approval to answer it.", "warn");
        emitRoute({ kind: "waiting", id: link.id });
        return { ok: false, reason: out.reason, kind: "approve" };
      }
      if (isRouteLink(link)) {
        emitRoute(link);
        return { ok: true, reason: null, kind: link.kind };
      }
      return { ok: false, reason: "no link" };
    },
    // The desktop UI. On the shell page: pulls what the computer has and hands the page to it (it does that by itself after HELLO; this is for
    // "Open Plenum" on /?shell and for Try again).
    showUi,
    // The screens call this when the steps after a pairing are over (or were skipped): the page may go to the UI now.
    releaseUi() {
      if (!holdUi) return;
      holdUi = false;
      if (hello) afterHello();
    },
    // "Use the copy in this app": the UI that is already on the phone, without asking the computer.
    async useCopy() {
      if (!uiHost) return { ok: false, reason: "unavailable" };
      ui = { ...ui, state: "loading", cause: null };
      refresh();
      const out = await uiHost.useCopy();
      if (out.ok) ui = { ...ui, state: "navigating" };
      else ui = { state: "failed", cause: out.cause ?? "worker", progress: null, hasCopy: false };
      refresh();
      return { ok: out.ok, reason: out.ok ? null : out.cause };
    },
    // From the UI page back to the shell's screens (Phone settings, the computer list, pairing).
    async openShell(hash = "") {
      if (!uiHost) return false;
      leaving = true;
      const done = await uiHost.openShell(hash).catch(() => false);
      if (!done) leaving = false;
      return done;
    },
    // The route a notification named, once: { kind, id?, project?, section?, seq } or null.
    takeRoute() {
      if (!intent || intent.taken) return null;
      intent = { ...intent, taken: true };
      const out = { ...intent };
      refresh();
      return out;
    },
    // Scans a pairing code with the phone's camera (native). { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' | 'unavailable' }.
    // The text is a pairing link: the caller hands it to pair().
    async scan() {
      if (!native?.BarcodeScanner) return { ok: false, reason: "unavailable" };
      return native.BarcodeScanner.scan();
    },
    // Turns the dictation on the phone on or off: the plugin's start/stop. Result events go to boot.js (plenumShell.dictation).
    async dictation() {
      await loadDictation();
      return dictationState ? { ...dictationState } : { available: false, onDevice: false, permission: "prompt" };
    },
    async start() {
      if (started) return snapshot;
      started = true;
      const hash = String(pageUrl && pageUrl.includes("#") ? pageUrl.slice(pageUrl.indexOf("#")) : "");
      if (hash.length > 1) {
        clearHash();
        pendingLink = { text: hash, at: wall() };
      } else if (typeof initialLink === "string" && initialLink) {
        pendingLink = { text: initialLink, at: wall() };
      }
      await api.boot();
      await runPendingLink();
      return snapshot;
    }
  };
  return api;
}
function hasNativeBridge(env) {
  return Boolean(env?.androidBridge || env?.webkit?.messageHandlers?.bridge);
}
function wantsNativePlugins(env) {
  return isNative(env) && hasNativeBridge(env);
}
async function loadNativePlugins2(env) {
  if (!wantsNativePlugins(env)) return null;
  const mod = await Promise.resolve().then(() => (init_native3(), native_exports3));
  return mod.loadNativePlugins();
}
function linkOfUrl(url) {
  const text = String(url ?? "");
  const app = /^plenum:\/\/app\/?(?:\?[^#]*)?(#.*)$/.exec(text);
  if (app) return app[1];
  if (/^plenum:\/\/pair#/.test(text)) return text;
  return null;
}
function wireAppPlugin({ appPlugin, shell, env, pageKind, platform = null }) {
  const opened = /* @__PURE__ */ new Set();
  let launchRan = false;
  const wanted = (link) => Boolean(link) && !(platform === "ios" && link.startsWith("#"));
  if (appPlugin?.addListener) {
    appPlugin.addListener("appUrlOpen", (event) => {
      const url = String(event?.url ?? "");
      const link = linkOfUrl(url);
      if (!wanted(link)) return;
      opened.add(url);
      shell.handleHash(link).catch(() => {
      });
    });
    if (pageKind === "shell") {
      appPlugin.addListener("backButton", () => {
        const event = typeof env?.CustomEvent === "function" ? new env.CustomEvent("plenum-back", { cancelable: true }) : null;
        if (event && env.dispatchEvent?.(event) === false) return;
        if (typeof appPlugin.minimizeApp === "function") appPlugin.minimizeApp();
        else appPlugin.exitApp?.();
      });
    }
  }
  return async function afterStart() {
    if (launchRan || !appPlugin?.getLaunchUrl) return;
    launchRan = true;
    try {
      const launched = await appPlugin.getLaunchUrl();
      const url = String(launched?.url ?? "");
      const link = linkOfUrl(url);
      if (wanted(link) && !opened.has(url)) shell.handleHash(link).catch(() => {
      });
    } catch {
    }
  };
}
function takeAttachSlot(env) {
  const f = env?.__plenumAttachShell;
  try {
    delete env.__plenumAttachShell;
  } catch {
  }
  return typeof f === "function" ? f : null;
}
async function startShell(env = globalThis, { loadPlugins = loadNativePlugins2, devBuild = DEV_BUILD, attach, giveCore } = {}) {
  const ofPage = env === globalThis;
  if (ofPage) {
    if (!takePageStart()) {
      giveCore?.(null);
      return null;
    }
    devBuild = DEV_BUILD;
  }
  const give = giveCore ?? (ofPage ? giveShellCore : () => {
  });
  const attachFn = attach !== void 0 ? attach : ofPage ? attachShim : takeAttachSlot(env);
  let handed = false;
  try {
    return await runStart(env, { loadPlugins, devBuild, attach: attachFn, give: (value) => {
      handed = true;
      give(value);
    } });
  } catch (error) {
    if (!handed) give(null);
    throw error;
  }
}
async function runStart(env, { loadPlugins, devBuild, attach, give }) {
  let framed = false;
  try {
    framed = env.top !== env.self;
  } catch {
    framed = true;
  }
  let sameOriginOpener = false;
  try {
    sameOriginOpener = Boolean(env.opener) && env.opener.location.origin === env.location.origin;
  } catch {
    sameOriginOpener = false;
  }
  if (framed || sameOriginOpener) {
    give(null);
    return null;
  }
  const { device, caps, native } = deviceFor(env);
  const cap = env.Capacitor;
  const pageKind = pageKindFor(env);
  const lan = isLanPage(env);
  const bridge = hasNativeBridge(env);
  let plugins = null;
  let pluginFailure = false;
  if (native) {
    try {
      plugins = await loadPlugins(env);
    } catch {
      pluginFailure = true;
    }
  }
  const registered = plugins?.secureStorage ?? cap?.Plugins?.SecureStorage ?? null;
  const secureStorage = native || bridge ? pluginFailure || bridge && (!plugins || !registered) ? NO_SECURE_STORAGE : registered : null;
  const store = createPlatformStore({ secureStorage, indexedDB: env.indexedDB ?? null });
  const biometricPlugin = native ? plugins?.BiometricAuth ?? cap?.Plugins?.BiometricAuth ?? null : null;
  const lock = createLock({
    store,
    now: () => Date.now(),
    biometric: createBiometricGate({ plugin: biometricPlugin }),
    passkey: native ? null : createPasskeyGate({ credentials: env.navigator?.credentials, PublicKeyCredentialCtor: env.PublicKeyCredential, rpId: env.location?.hostname })
  });
  const params = new URLSearchParams(String(env.location?.search ?? ""));
  const mode = modeFor(env.location?.search, devBuild);
  const stay = params.has(SHELL_QUERY);
  const linkStore = createLinkStore(store.meta);
  try {
    env.sessionStorage?.removeItem(SHELL_LINK_KEY);
  } catch {
  }
  if (!native && pageKind === "shell") registerServiceWorker(env);
  let shell = null;
  const kind = native ? device.platform === "android" ? "android" : "ios" : lan ? "lan" : "web";
  const uiHost = mode === "normal" && env.location && (!native || plugins) ? createUiHost({ env, kind, native: plugins, channelOf: () => shell?.channel ?? null, log: (line) => shell?.debug.log(line, "warn"), linkStore }) : null;
  let initialIntent = null;
  try {
    const saved = pageKind === "ui" ? env.sessionStorage?.getItem("plenum-intent") : null;
    if (saved) {
      env.sessionStorage.removeItem("plenum-intent");
      initialIntent = JSON.parse(saved);
    }
  } catch {
    initialIntent = null;
  }
  let initialLink = null;
  if (native && plugins && pageKind === "shell") initialLink = await linkStore.take();
  shell = createShell({
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
      shell?.showUi({ force: true });
    },
    onReload: () => {
      env.location?.reload?.();
    },
    devBuild,
    storage: secureStorage === NO_SECURE_STORAGE ? "unavailable" : "ok"
  });
  if (secureStorage === NO_SECURE_STORAGE) shell.debug.log("storage: unavailable", "warn");
  if (devBuild) {
    env.plenumShellCore = shell;
    env.plenumNative = plugins;
  }
  attach?.(makeFacade(shell, plugins));
  give(shell);
  env.addEventListener?.("visibilitychange", () => {
    shell.visibility(env.document?.visibilityState !== "hidden");
  });
  env.addEventListener?.("pagehide", () => shell.visibility(false));
  env.addEventListener?.("hashchange", () => {
    const hash = String(env.location?.hash ?? "");
    if (hash.length > 1) {
      clearAddressHash(env);
      shell.handleHash(hash).catch(() => {
      });
    }
  });
  env.navigator?.serviceWorker?.addEventListener?.("message", (event) => {
    const data = event?.data;
    if (data?.op === "plenum-hash" && typeof data.hash === "string") shell.handleHash(data.hash).catch(() => {
    });
  });
  const afterStart = wireAppPlugin({ appPlugin: plugins?.App ?? null, shell, env, pageKind, platform: device.platform });
  await shell.start();
  await afterStart();
  if (mode === "selftest") {
    const report = await shell.runSelftest();
    shell.debug.log(`selftest ${report.passed}/${report.total}`);
  }
  return shell;
}
if (typeof document !== "undefined" && typeof window !== "undefined" && !globalThis.__PLENUM_SHELL_NO_AUTOSTART__) {
  startShell(globalThis).catch((err) => {
    giveShellCore(null);
    console.error(String(err?.message ?? err));
  });
}
export {
  CARD_CHANGED,
  DEV_BUILD,
  NOTIFICATION_OLD,
  cleanName,
  clearAddressHash,
  createLinkStore,
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
