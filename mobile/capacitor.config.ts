// Capacitor configuration for the Plenum phone shell (Android and iPhone).
// This is the one place the native identifiers live. scripts/build-mobile.mjs writes mobile/www;
// `npx cap sync` copies it into mobile/android and mobile/ios.
//
// Owner to confirm: appId (com.realalcibiades.plenum) is the value MOBILE.json names. Changing it
// after the first store upload is not possible, so confirm it before any upload.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.realalcibiades.plenum',
  appName: 'Plenum',
  webDir: 'www',

  server: {
    // https://localhost inside the WebView, so IndexedDB, Web Crypto and the service-worker-free
    // shell all run in a secure context. Plain-HTTP traffic is only the LAN WebSocket, allowed by
    // android/app/src/main/res/xml/network_security_config.xml (base-config), never a page load.
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },

  android: {
    // Needed so the shell can open ws:// LAN channels from its https origin. The channel itself is
    // end-to-end encrypted (Noise), so the cleartext hop carries only ciphertext.
    allowMixedContent: true,
    // Keep the WebView's remote debugging to debug builds (Capacitor's default behaviour).
    // Signing is never configured here: release builds read the keystore from environment
    // variables in CI only (android/app/build.gradle).
  },

  ios: {
    // The shell positions everything with env(safe-area-inset-*), so the WebView content runs
    // edge to edge and the page owns the insets.
    contentInset: 'never',
    allowsLinkPreview: false,
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
    preferredContentMode: 'mobile',
    // ios.scheme is left at Capacitor's default ('App') so the generated project is
    // mobile/ios/App/App.xcodeproj, which the iOS builds and CI expect.
  },

  plugins: {
    CapacitorHttp: {
      // The shell talks to the desktop over its own Noise channel, never through the native HTTP
      // stack, so Capacitor's HTTP patch stays off.
      enabled: false,
    },
    LocalNotifications: {
      // Drawable res/drawable/ic_stat_plenum.xml (android/app/src/main/res/drawable).
      smallIcon: 'ic_stat_plenum',
    },
  },
};

export default config;
