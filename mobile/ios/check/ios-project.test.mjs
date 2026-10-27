// Static checks for mobile/ios: the plists, the project file, the SPM package, the store assets and
// the review notes. There is no Mac here, so the simulator build runs in mobile.yml (ios-sim job).
// Run: node --test mobile/ios/check/ios-project.test.mjs   (reads files only; writes nothing)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parsePlist } from './plist.mjs';

const IOS = path.resolve(import.meta.dirname, '..');
const MOBILE = path.resolve(IOS, '..');
const read = (...p) => readFileSync(path.join(IOS, ...p), 'utf8');

const info = parsePlist(read('App', 'App', 'Info.plist'));
const pbx = read('App', 'App.xcodeproj', 'project.pbxproj');
const pkg = JSON.parse(readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));
const spmManifest = read('App', 'CapApp-SPM', 'Package.swift');

const NOT_PLUGINS = new Set(['@capacitor/core', '@capacitor/android', '@capacitor/ios', '@capacitor/cli', '@capacitor/synapse', '@capacitor/keyboard']);
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const pluginNames = Object.keys(allDeps).filter((n) => (n.startsWith('@capacitor/') || n.startsWith('@aparajita/')) && !NOT_PLUGINS.has(n));
const localPlugins = Object.entries(allDeps).filter(([, v]) => String(v).startsWith('file:')).map(([n, v]) => [n, String(v).slice(5)]);

function pngSize(file) {
  const b = readFileSync(file);
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

test('Info.plist parses and the app is named Plenum with the bundle identifier from the project', () => {
  assert.equal(info.CFBundleDisplayName, 'Plenum');
  assert.equal(info.CFBundleIdentifier, '$(PRODUCT_BUNDLE_IDENTIFIER)');
  const ids = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(ids.length >= 2, 'both build configurations set a bundle identifier');
  assert.ok(ids.every((id) => id === 'com.realalcibiades.plenum'), `bundle identifiers: ${ids.join(', ')}`);
});

test('deployment target is 16.0 in every configuration and no 15.0 setting is left', () => {
  const targets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(targets.length >= 4, 'project and target settings for Debug and Release');
  assert.ok(targets.every((t) => t === '16.0'), `targets: ${targets.join(', ')}`);
});

test('the target is iPhone only and no signing team is hard-coded', () => {
  const families = [...pbx.matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(families.length >= 2);
  assert.ok(families.every((f) => f === '1'), `families: ${families.join(', ')}`);
  assert.equal(/DEVELOPMENT_TEAM/.test(pbx), false, 'no DEVELOPMENT_TEAM in the project');
});

test('pbxproj braces and parentheses balance (a basic structural parse)', () => {
  const code = pbx.replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  let inString = false;
  let braces = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' && code[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (c === '{' || c === '(') depth++;
    if (c === '}' || c === ')') depth--;
    if (c === '{') braces++;
    assert.ok(depth >= 0, `unbalanced close at offset ${i}`);
  }
  assert.equal(depth, 0);
  assert.ok(braces > 10);
});

test('encryption export answer is set and App Transport Security allows only local networking', () => {
  assert.equal(info.ITSAppUsesNonExemptEncryption, true);
  const ats = info.NSAppTransportSecurity;
  assert.equal(ats.NSAllowsLocalNetworking, true);
  assert.notEqual(ats.NSAllowsArbitraryLoads, true, 'no arbitrary loads');
  // ATS exception domains are host names, so a CIDR key there did nothing: Tailscale addresses are reached through the carrier rules instead.
  assert.equal(ats.NSExceptionDomains, undefined, 'no exception domains');
});

test('usage strings are present; microphone and speech text is the MOBILE-UI 15.6 wording', () => {
  for (const key of ['NSCameraUsageDescription', 'NSFaceIDUsageDescription', 'NSLocalNetworkUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
    assert.equal(typeof info[key], 'string', key);
    assert.ok(info[key].length > 20, `${key} is a sentence`);
  }
  assert.equal(info.NSMicrophoneUsageDescription, 'Plenum uses the microphone only while you dictate a message.');
  assert.equal(info.NSSpeechRecognitionUsageDescription, 'Plenum turns what you say into text in the message box.');
});

test('the plenum URL scheme is registered for the pairing link (plenum://pair#...)', () => {
  const schemes = info.CFBundleURLTypes.flatMap((t) => t.CFBundleURLSchemes);
  assert.ok(schemes.includes('plenum'));
});

test('UIScene manifest names SceneDelegate, the launch storyboard exists and no background mode is declared', () => {
  const role = info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0];
  assert.equal(role.UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).SceneDelegate');
  assert.equal(info.UILaunchStoryboardName, 'LaunchScreen');
  assert.ok(existsSync(path.join(IOS, 'App', 'App', 'Base.lproj', 'LaunchScreen.storyboard')));
  assert.equal(info.UIBackgroundModes, undefined, 'no background socket: the app reconnects on foreground');
  assert.equal(info.LSRequiresIPhoneOS, true);
});

test('no CocoaPods: no Podfile, no Pods, and the App target links the local CapApp-SPM package', () => {
  assert.equal(existsSync(path.join(IOS, 'Podfile')), false);
  assert.equal(/\bPods\b/.test(pbx), false);
  assert.ok(pbx.includes('XCLocalSwiftPackageReference "CapApp-SPM"'));
  assert.ok(existsSync(path.join(IOS, 'App', 'CapApp-SPM', 'Package.swift')));
  assert.ok(/exact: "8\.5\.3"/.test(spmManifest), 'Capacitor SPM core pinned to 8.5.3');
});

test('the shared App scheme exists and points at the App target', () => {
  const target = pbx.match(/([0-9A-F]{24}) \/\* App \*\/ = \{\s*isa = PBXNativeTarget;/);
  assert.ok(target, 'App native target found');
  const scheme = read('App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme');
  assert.ok(scheme.includes(`BlueprintIdentifier = "${target[1]}"`));
  assert.ok(scheme.includes('BlueprintName = "App"'));
});

test('every Capacitor plugin in mobile/package.json has a Package.swift and is listed in CapApp-SPM', () => {
  assert.ok(pluginNames.length >= 9, `found ${pluginNames.length} plugins`);
  for (const name of pluginNames) {
    assert.ok(spmManifest.includes(`path: "../../../node_modules/${name}"`), `${name} is not in CapApp-SPM/Package.swift (run cap sync ios)`);
    const dir = path.join(MOBILE, 'node_modules', name);
    if (existsSync(dir)) assert.ok(existsSync(path.join(dir, 'Package.swift')), `${name} ships no Package.swift`);
  }
});

test('local plugins named file: in mobile/package.json that have iOS code ship a Package.swift and are listed in CapApp-SPM', () => {
  // The Android-only plugins (unifiedpush, isolated-preview: wave 105, mob-13) declare no capacitor.ios, so they have no SwiftPM package.
  for (const [name, rel] of localPlugins) {
    const own = JSON.parse(readFileSync(path.join(MOBILE, rel, 'package.json'), 'utf8'));
    if (!own.capacitor?.ios) continue;
    assert.ok(existsSync(path.join(MOBILE, rel, 'Package.swift')), `${name} at ${rel} ships no Package.swift`);
    assert.ok(spmManifest.includes(`path: "../../../node_modules/${name}"`), `${name} is not in CapApp-SPM/Package.swift (run cap sync ios)`);
  }
});

test('push plugin: inactive; when mobile/package.json names it, CapApp-SPM must carry it', (t) => {
  if (!allDeps['@capacitor/push-notifications']) {
    t.todo('@capacitor/push-notifications is not in mobile/package.json yet (mob-13 owns that file); the iOS project carries no push plugin until it is added and cap sync runs');
    return;
  }
  assert.ok(spmManifest.includes('node_modules/@capacitor/push-notifications'));
});

test('privacy screen: sceneWillResignActive shows the mark on --bg (light and dark) and sceneDidBecomeActive removes it', () => {
  const src = read('App', 'App', 'SceneDelegate.swift');
  assert.ok(src.includes('func sceneWillResignActive(_ scene: UIScene)'));
  assert.ok(src.includes('func sceneDidBecomeActive(_ scene: UIScene)'));
  assert.ok(src.includes('UIImage(named: "PlenumMark")'));
  assert.ok(src.includes('red: 246.0 / 255.0, green: 246.0 / 255.0, blue: 251.0 / 255.0'), 'light --bg #f6f6fb');
  assert.ok(src.includes('red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 17.0 / 255.0'), 'dark --bg #0a0a11');
  assert.ok(/sceneDidBecomeActive[\s\S]*removeFromSuperview/.test(src));
});

test('store icon is an opaque 1024 px PNG (no alpha) and every asset catalog image file exists', () => {
  const icon = path.join(IOS, 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png');
  const size = pngSize(icon);
  assert.equal(size.width, 1024);
  assert.equal(size.height, 1024);
  assert.ok([0, 2, 3].includes(size.colorType), `colour type ${size.colorType} has alpha`);
  const splash = pngSize(path.join(IOS, 'App', 'App', 'Assets.xcassets', 'Splash.imageset', 'splash-2732x2732.png'));
  assert.equal(splash.width, 2732);
  assert.equal(pngSize(path.join(IOS, 'App', 'App', 'Assets.xcassets', 'PlenumMark.imageset', 'PlenumMark.png')).width, 512);
  const catalog = path.join(IOS, 'App', 'App', 'Assets.xcassets');
  const sets = readdirSync(catalog, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const set of sets) {
    const contents = path.join(catalog, set.name, 'Contents.json');
    if (!existsSync(contents)) continue;
    for (const image of JSON.parse(readFileSync(contents, 'utf8')).images || []) {
      if (image.filename) assert.ok(existsSync(path.join(catalog, set.name, image.filename)), `${set.name}/${image.filename}`);
    }
  }
});

test('review-notes.md keeps the placeholders, names no person or address, and covers the store sections', () => {
  const notes = read('review-notes.md');
  for (const ph of ['[LICENSOR NAME]', '[CONTACT EMAIL]', '[GOVERNING LAW]']) assert.ok(notes.includes(ph), ph);
  assert.equal(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(notes), false, 'no e-mail address written into the notes');
  for (const heading of ['Demo mode', 'Export', 'Permissions', '5.1.2(i)', 'Privacy', 'Open items']) {
    assert.ok(notes.includes(heading), `section ${heading}`);
  }
});
