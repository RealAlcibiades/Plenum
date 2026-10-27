// capacitor-stub.js (mob-18). A stand-in for the Capacitor bridge of the native shell, for the Electron harness only. It is injected
// into every page of the harness window before the page's own scripts run (Page.addScriptToEvaluateOnNewDocument), so the shell sees
// window.Capacitor the way it does on a phone:
//   - secure storage (@aparajita/capacitor-secure-storage) lives in memory only;
//   - the barcode scanner (@capacitor/barcode-scanner) returns the link the test set in plenumHarness.scanLink;
//   - push registration (@capacitor/push-notifications) is recorded in plenumHarness.pushRegistrations: nothing reaches a push service;
//   - app pause and resume (@capacitor/app) are emitted by the test with plenumHarness.emit('pause') and emit('resume');
//   - Browser.open is recorded, never opened.
// Every plugin call is also written to plenumHarness.calls as 'Plugin.method', so a test can check what the shell asked for.
// Nothing here touches a camera, a microphone, a real store or a real network. Values never go to the console.
(function () {
  if (window.Capacitor) return;

  const listeners = new Map();
  const secure = new Map();
  const harness = {
    platform: 'ios',
    scanLink: '',
    scans: 0,
    pushPermission: 'granted',
    pushRegistrations: [],
    calls: [],
    active: true,
    storageKeys: () => [...secure.keys()],
    emit(event, data) {
      if (event === 'pause') harness.active = false;
      if (event === 'resume') harness.active = true;
      for (const fn of listeners.get(event) ?? []) {
        try {
          fn(data);
        } catch {
          // A listener that throws must not stop the others.
        }
      }
    },
  };
  window.plenumHarness = harness;

  const log = (plugin, method) => { harness.calls.push(`${plugin}.${method}`); };
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
    return { remove: () => { const list = listeners.get(event) ?? []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } };
  };

  const plugins = {
    App: {
      addListener: (event, fn) => { log('App', 'addListener'); return on(event, fn); },
      getState: async () => { log('App', 'getState'); return { isActive: harness.active }; },
    },
    SecureStorage: {
      setItem: async ({ key, value }) => { log('SecureStorage', 'setItem'); secure.set(String(key), String(value)); return {}; },
      getItem: async ({ key }) => { log('SecureStorage', 'getItem'); return { value: secure.has(String(key)) ? secure.get(String(key)) : null }; },
      removeItem: async ({ key }) => { log('SecureStorage', 'removeItem'); secure.delete(String(key)); return {}; },
      keys: async () => { log('SecureStorage', 'keys'); return { keys: [...secure.keys()] }; },
      clear: async () => { log('SecureStorage', 'clear'); secure.clear(); return {}; },
    },
    BarcodeScanner: {
      checkPermission: async () => { log('BarcodeScanner', 'checkPermission'); return { granted: true, denied: false, neverAsked: false, restricted: false, unknown: false }; },
      startScan: async () => {
        log('BarcodeScanner', 'startScan');
        harness.scans += 1;
        return harness.scanLink ? { hasContent: true, content: harness.scanLink } : { hasContent: false, content: '' };
      },
      stopScan: async () => { log('BarcodeScanner', 'stopScan'); return {}; },
    },
    PushNotifications: {
      requestPermissions: async () => { log('PushNotifications', 'requestPermissions'); return { receive: harness.pushPermission }; },
      register: async () => { log('PushNotifications', 'register'); harness.pushRegistrations.push({ at: Date.now() }); return {}; },
      addListener: (event, fn) => { log('PushNotifications', 'addListener'); return on(event, fn); },
    },
    Browser: {
      open: async ({ url }) => { log('Browser', 'open'); harness.opened = [...(harness.opened ?? []), String(url)]; return {}; },
    },
  };

  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => harness.platform,
    isPluginAvailable: name => Object.prototype.hasOwnProperty.call(plugins, name),
    Plugins: plugins,
  };
})();
