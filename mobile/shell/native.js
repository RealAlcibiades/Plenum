// The native plugins of the Android and iPhone apps, registered for the shell (H6, L18, M7, M11, M15; MOBILE.json mobile.plugins).
//
// Capacitor puts nothing on window.Capacitor.Plugins by itself: a plugin appears there only once JavaScript has called registerPlugin for it,
// which is what each plugin package's own index.js does when it is imported. Until this file existed the shell read Capacitor.Plugins.X for
// plugins that nothing had registered, so on a phone the keys fell back to IndexedDB (not the Keychain or Keystore), the biometric lock was
// unavailable, and share, save, haptics, Back and the camera did nothing.
//
// app.js loads this module with a dynamic import, and only when Capacitor.isNativePlatform() and the page has Capacitor's registerPlugin
// (the harness stub for the Electron suites has neither, so it keeps working from Capacitor.Plugins). The web shell never runs this code.
//
// What is imported and what is registered by name:
//   imported (their JS wrappers hold real logic)   @aparajita/capacitor-secure-storage (keys, prefixes), @aparajita/capacitor-biometric-auth
//                                                  (registers 'BiometricAuthNative', so Capacitor.Plugins.BiometricAuth never exists), and the
//                                                  three app-local plugins under mobile/plugins (pure logic in their core.js).
//   registered by name (the package's index.js is   App, Haptics, Browser, Share, Filesystem, TextZoom, Network, LocalNotifications, the barcode
//   only registerPlugin(name) plus a web fallback)  scanner ('CapacitorBarcodeScanner', whose web fallback would add a camera library to the
//                                                  shell), and the app's own PlenumPrivacy (android/.../PlenumPrivacyPlugin.java).
// Those packages stay in mobile/package.json: `cap sync` reads them to wire the native side.
//
// The result of buildNative() is what app.js hands to the store, the lock, the push code and the screens, and what boot.js reads through
// window.plenumNative. Nothing here stores or logs a key: the secure-storage adapter passes values straight through.

import { Capacitor, WebView, registerPlugin } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Dictation } from '../plugins/dictation/src/index.js';
import { IsolatedPreview } from '../plugins/isolated-preview/src/index.js';
import { UnifiedPush } from '../plugins/unifiedpush/src/index.js';

// The plugins this file registers by name, in one list: the build test looks for each of them in the shell bundle.
export const REGISTERED_NAMES = Object.freeze([
  'App', 'Haptics', 'Browser', 'Share', 'Filesystem', 'TextZoom', 'Network', 'LocalNotifications', 'CapacitorBarcodeScanner', 'PlenumPrivacy',
]);

// The barcode scanner's option defaults (@capacitor/barcode-scanner 3.x index.js) and enum values (definitions.js), kept here so the shell
// does not bundle the package's web scanner.
const QR_CODE_HINT = 0;
const CAMERA_BACK = 1;
const ORIENTATION_ADAPTIVE = 3;

// The shape store.js reads (getItem({ key }) -> { value }, setItem({ key, value }), removeItem({ key }), keys() -> { keys }), over the
// package's own API (getItem(key) -> string | null, setItem(key, value), removeItem(key), keys() -> string[]).
export function secureStorageAdapter(plugin) {
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
    },
  };
}

// The scan result as the shell wants it: { ok, text } or { ok: false, reason: 'denied' | 'cancelled' | 'failed' }.
export function scanOutcome(error, result) {
  if (!error) {
    const text = typeof result?.ScanResult === 'string' ? result.ScanResult : '';
    return text ? { ok: true, text } : { ok: false, reason: 'cancelled' };
  }
  const said = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  if (/permission|denied|not authori[sz]ed|restricted/i.test(said)) return { ok: false, reason: 'denied' };
  if (/cancel|dismiss|closed/i.test(said)) return { ok: false, reason: 'cancelled' };
  return { ok: false, reason: 'failed' };
}

// parts: { registerPlugin, WebView, SecureStorage, BiometricAuth, Dictation, IsolatedPreview, UnifiedPush }. The Node suites pass fakes.
// platform: Capacitor.getPlatform(), 'android' | 'ios' | 'web'. Only iOS has the Keychain setting.
export function buildNative(parts, { platform = '' } = {}) {
  const register = parts.registerPlugin;
  const scanner = register('CapacitorBarcodeScanner');
  const plugins = {
    App: register('App'),
    Haptics: register('Haptics'),
    Browser: register('Browser'),
    Share: register('Share'),
    Filesystem: register('Filesystem'),
    TextZoom: register('TextZoom'),
    Network: register('Network'),
    LocalNotifications: register('LocalNotifications'),
    PlenumPrivacy: register('PlenumPrivacy'),
  };
  return {
    ...plugins,
    secureStorage: secureStorageAdapter(parts.SecureStorage),
    // Settings the shell wants for the keys: never synchronised to iCloud, and on this device only. On iOS the Keychain setting must hold:
    // when it cannot be set, this throws, and app.js treats a throwing loadPlugins as no secure storage, so no key is stored.
    async configureStorage() {
      await Promise.resolve(parts.SecureStorage.setSynchronize?.(false)).catch(() => {});   // off is the plugin's default too
      if (platform !== 'ios') return;
      if (typeof parts.SecureStorage.setDefaultKeychainAccess !== 'function') throw new Error('keychain access cannot be set');
      await parts.SecureStorage.setDefaultKeychainAccess(1); // whenUnlockedThisDeviceOnly; a refusal throws, so no key is stored
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
            scanInstructions: ' ',
            scanButton: false,
            scanText: ' ',
            cameraDirection: CAMERA_BACK,
            scanOrientation: ORIENTATION_ADAPTIVE,
            ...options,
          });
          return scanOutcome(null, result);
        } catch (error) {
          return scanOutcome(error, null);
        }
      },
    },
    names: [...REGISTERED_NAMES],
  };
}

// The real plugins. Called once by app.js on a phone.
export async function loadNativePlugins() {
  const native = buildNative({ registerPlugin, WebView, SecureStorage, BiometricAuth, Dictation, IsolatedPreview, UnifiedPush }, { platform: Capacitor.getPlatform() });
  await native.configureStorage();
  return native;
}
