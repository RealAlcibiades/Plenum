// mob-13 (wave 105): suites for the Android project, the three local Capacitor plugins and the Capacitor config.
// Run through the sealed runner from the scratch copy's mobile/test folder:
//   node build/mobile/run.mjs --id mob-13-android-project-and-plugins plugins.test.mjs
//
// The JavaScript sides are tested directly (the plugin core.js files import nothing; native.js imports @capacitor/core and two plugin packages, which the sealed runner installs once; the
// web fallbacks are checked as text). The Kotlin, Java, Swift, XML and Gradle files cannot be compiled on this Windows
// machine (no JDK, no Android SDK, no Xcode). They are checked for names, sandbox settings, well-formed XML and balanced
// brackets; CI (mobile.yml) builds them. Nothing here reaches a network, a provider, a push service or a real device.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildPushText } from '../../lib/remote/push.mjs';
import * as UP from '../plugins/unifiedpush/src/core.js';
import * as DI from '../plugins/dictation/src/core.js';
import * as IP from '../plugins/isolated-preview/src/core.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const read = rel => fs.readFileSync(path.join(MOBILE, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(MOBILE, rel));

// ---------------------------------------------------------------- helpers

// A small well-formedness check for the XML files: tags balance, attributes are not repeated, no bare & or stray brackets.
function assertWellFormedXml(text, label) {
  const body = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const token = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  const stack = [];
  let match;
  while ((match = token.exec(body))) {
    const [, closing, name, attributes, selfClosing] = match;
    const names = [...attributes.matchAll(/([A-Za-z_][\w.:-]*)\s*=/g)].map(a => a[1]);
    assert.equal(new Set(names).size, names.length, `${label}: a attribute is repeated in <${name}>`);
    if (closing) {
      assert.equal(selfClosing, '', `${label}: </${name}> is self-closing`);
      assert.equal(stack.pop(), name, `${label}: </${name}> does not match its opening tag`);
    } else if (!selfClosing) {
      stack.push(name);
    }
  }
  assert.deepEqual(stack, [], `${label}: unclosed tags ${stack.join(', ')}`);
  assert.ok(!/[<>]/.test(body.replace(token, '')), `${label}: a stray < or > outside a tag`);
  assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body), `${label}: a bare & in the text`);
}

// Removes strings, char literals and comments, so brackets inside them do not count (Groovy, Kotlin and Java).
function codeOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), i)) {
        const end = text.indexOf(c.repeat(3), i + 3);
        i = end < 0 ? text.length : end + 3;
        out += '""';
        continue;
      }
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      i = j + 1;
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function assertBalanced(text, label) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const ch of codeOnly(text)) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs) assert.equal(stack.pop(), pairs[ch], `${label}: unbalanced ${ch}`);
  }
  assert.equal(stack.length, 0, `${label}: unclosed brackets`);
}

function stripXmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'www') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const KOTLIN_UNIFIEDPUSH = 'plugins/unifiedpush/android/src/main/java/com/realalcibiades/plenum/unifiedpush';
const KOTLIN_DICTATION = 'plugins/dictation/android/src/main/java/com/realalcibiades/plenum/dictation/DictationPlugin.kt';
const KOTLIN_PREVIEW = 'plugins/isolated-preview/android/src/main/java/com/realalcibiades/plenum/isolatedpreview';
const APP_JAVA = 'android/app/src/main/java/com/realalcibiades/plenum';

// ---------------------------------------------------------------- UnifiedPush core

describe('UnifiedPush: registration names, labels, VAPID and package names', () => {
  test('a registration name defaults to "default" and rejects anything outside the allowed set', () => {
    assert.equal(UP.normaliseInstance(), 'default');
    assert.equal(UP.normaliseInstance(''), 'default');
    assert.equal(UP.normaliseInstance('ntfy-1.main_2'), 'ntfy-1.main_2');
    assert.throws(() => UP.normaliseInstance('a b'), { code: 'bad-instance' });
    assert.throws(() => UP.normaliseInstance('x'.repeat(65)), { code: 'bad-instance' });
    assert.throws(() => UP.normaliseInstance(42), { code: 'bad-instance' });
  });

  test('the label defaults to Plenum and is cleaned to 120 characters', () => {
    assert.equal(UP.normaliseMessageForDistributor(undefined), 'Plenum');
    assert.equal(UP.normaliseMessageForDistributor('  Home\u0000 PC  '), 'Home  PC');
    assert.equal(UP.normaliseMessageForDistributor('y'.repeat(300)).length, 120);
  });

  test('a VAPID key is the 87-character base64url public key', () => {
    const key = 'B'.repeat(87);
    assert.equal(UP.normaliseVapid(key), key);
    assert.equal(UP.normaliseVapid(undefined), undefined);
    assert.throws(() => UP.normaliseVapid('B'.repeat(86)), { code: 'bad-vapid' });
    assert.throws(() => UP.normaliseVapid('B'.repeat(86) + '='), { code: 'bad-vapid' });
  });

  test('a distributor is named by its Android package name', () => {
    assert.equal(UP.normalisePackageName('io.heckel.ntfy'), 'io.heckel.ntfy');
    for (const bad of ['ntfy', 'io..heckel', '1.heckel', 'io.heckel ntfy', 'io.heckel.ntfy;rm']) {
      assert.throws(() => UP.normalisePackageName(bad), { code: 'bad-package' }, bad);
    }
  });

  test('register options get the defaults and are validated together', () => {
    assert.deepEqual(UP.normaliseRegisterOptions({}), { instance: 'default', messageForDistributor: 'Plenum', vapid: undefined });
    assert.throws(() => UP.normaliseRegisterOptions({ instance: 'no good' }), { code: 'bad-instance' });
  });
});

describe('UnifiedPush: base64 and the message event', () => {
  test('decodeBase64 reads standard, URL-safe and unpadded text', () => {
    const text = (bytes) => new TextDecoder().decode(bytes);
    assert.equal(text(UP.decodeBase64('aGVsbG8=')), 'hello');
    assert.equal(text(UP.decodeBase64('aGVsbG8')), 'hello');
    assert.equal(UP.decodeBase64('-_8').length, 2);
    assert.throws(() => UP.decodeBase64('not base64!'), { code: 'bad-message' });
    assert.throws(() => UP.decodeBase64('A'), { code: 'bad-message' });
  });

  test('a message larger than 256 KB is refused before anything is decoded into memory', () => {
    const tooBig = 'A'.repeat(349528);
    assert.throws(() => UP.decodeBase64(tooBig), { code: 'message-too-large' });
    assert.throws(() => UP.decodeBase64('A'.repeat(349536 + 4)), { code: 'bad-message' });
  });

  test('an encrypted (undecrypted) message carries no payload', () => {
    const content = Buffer.from('{"v":1,"kind":"approval","title":"x"}').toString('base64');
    const event = UP.parseMessageEvent({ instance: 'default', content, decrypted: false });
    assert.equal(event.decrypted, false);
    assert.equal(event.payload, null);
  });

  test('a decrypted message is parsed into a payload', () => {
    const payload = { v: 1, kind: 'finished', title: 'Home PC · my-app', body: 'Finished: Fix login', tag: `plenum-${'a'.repeat(32)}`, tap: '/#chat=p1', actions: [], ids: { computer: 'c', project: 'p1', approval: '' } };
    const content = Buffer.from(JSON.stringify(payload)).toString('base64');
    const event = UP.parseMessageEvent({ instance: 'default', content, decrypted: true });
    assert.equal(event.payload.kind, 'finished');
    assert.equal(event.payload.tap, '/#chat=p1');
    assert.equal(event.payload.title, 'Home PC · my-app');
  });
});

describe('UnifiedPush: the desktop payload contract (lib/remote/push.mjs builds it, the phone reads it)', () => {
  const computer = { id: 'c1', name: 'Home PC' };
  const device = { tier: 'approve', approveFromNotifications: true };

  test('every kind the desktop sends parses, and the phone keeps the desktop title, body, tag and tap', () => {
    const cases = [
      { kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'ap1', count: 1, firstLine: 'npm test -- --watch=false' },
      { kind: 'approval', projectName: 'my-app', projectId: 'p1', count: 3, firstLine: 'npm test' },
      { kind: 'handover', projectName: 'my-app', projectId: 'p1', approvalId: 'ho1', firstLine: 'Enter the 2FA code' },
      { kind: 'finished', projectName: 'my-app', projectId: 'p1', firstLine: 'Fix the login redirect' },
      { kind: 'failed', projectName: 'my-app', projectId: 'p1', firstLine: 'npm test exited with 1' },
      { kind: 'limit', limitKind: 'plan' },
      { kind: 'test' },
    ];
    for (const event of cases) {
      const built = buildPushText(event, { prefs: { firstLine: true }, device, computer });
      const parsed = UP.parsePushPayload(built.payload);
      assert.ok(parsed, `${event.kind} parses`);
      assert.equal(parsed.kind, event.kind);
      assert.equal(parsed.title, built.payload.title);
      assert.equal(parsed.body, built.payload.body);
      assert.equal(parsed.tag, built.tag);
      assert.equal(parsed.tap, built.payload.tap);
    }
  });

  test('a single approval with the first line on carries Deny, Stop all and an Approve that gets the line', () => {
    const built = buildPushText(
      { kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'ap1', count: 1, firstLine: 'npm test -- --watch=false' },
      { prefs: { firstLine: true }, device, computer },
    );
    const parsed = UP.parsePushPayload(built.payload);
    assert.deepEqual(parsed.actions.map(a => a.action), ['deny', 'stop', 'approve']);
    const approve = parsed.actions.find(a => a.action === 'approve');
    assert.equal(UP.routeForAction(approve, parsed.firstLine), '/#approve=ap1&line=npm%20test%20--%20--watch%3Dfalse');
    assert.equal(UP.routeForAction(parsed.actions[0], parsed.firstLine), '/#deny=ap1');
  });

  test('without the opt-in there is no Approve action at all', () => {
    const built = buildPushText(
      { kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'ap1', count: 1, firstLine: 'npm test' },
      { prefs: { firstLine: true }, device: { tier: 'approve', approveFromNotifications: false }, computer },
    );
    assert.deepEqual(UP.parsePushPayload(built.payload).actions.map(a => a.action), ['deny', 'stop']);
  });

  test('a hand-over keeps Stop all and no Deny', () => {
    const built = buildPushText({ kind: 'handover', approvalId: 'ho1', firstLine: 'Enter the 2FA code' }, { prefs: { firstLine: true }, device, computer });
    assert.deepEqual(UP.parsePushPayload(built.payload).actions.map(a => a.action), ['stop']);
  });
});

describe('UnifiedPush: hostile or unknown payloads are cleaned, not trusted', () => {
  test('control characters are removed, text is kept as text, and unknown routes are replaced', () => {
    const payload = UP.parsePushPayload({
      v: 1,
      kind: 'approval',
      title: 'x\u0007\u0000<script>',
      body: 'b'.repeat(900),
      tag: 'plenum-' + 'a'.repeat(32),
      tap: 'javascript:alert(1)',
      actions: [],
    });
    assert.equal(payload.title, 'x  <script>');
    assert.equal(payload.body.length, 240);
    assert.equal(payload.tap, '/#home');
    assert.equal(payload.tag, 'plenum-' + 'a'.repeat(32));
  });

  test('actions: the first three valid ones count; an invalid action or route is skipped', () => {
    const payload = UP.parsePushPayload({
      v: 1,
      kind: 'approval',
      actions: [
        { action: 'deny', title: 'Deny', route: '/#deny=1' },
        { action: 'eval', title: 'x', route: '/#x' },
        { action: 'stop', title: 'Stop', route: 'https://evil.example' },
        { action: 'approve', title: 'Approve', route: '/#approve=2' },
        { action: 'deny', title: 'Deny again', route: '/#deny=3' },
        { action: 'stop', title: 'Stop again', route: '/#stop' },
      ],
    });
    assert.deepEqual(payload.actions.map(a => a.action), ['deny', 'approve', 'deny']);
  });

  test('an unknown kind, an unknown version or a non-object is ignored', () => {
    assert.equal(UP.parsePushPayload({ v: 1, kind: 'shell' }), null);
    assert.equal(UP.parsePushPayload({ v: 2, kind: 'approval' }), null);
    assert.equal(UP.parsePushPayload(['approval']), null);
    assert.equal(UP.parsePushPayload(null), null);
  });

  test('a non-JSON decrypted message gives no payload instead of a crash', () => {
    const content = Buffer.from('plain text, not JSON').toString('base64');
    assert.equal(UP.parseMessageEvent({ instance: 'default', content, decrypted: true }).payload, null);
  });
});

describe('UnifiedPush: routes, intents, channels and endpoints', () => {
  test('a route becomes a plenum:// intent under the app prefix', () => {
    assert.equal(UP.intentUrlForRoute('/#deny=abc'), 'plenum://app/#deny=abc');
    assert.throws(() => UP.intentUrlForRoute('javascript:alert(1)'), { code: 'bad-route' });
  });

  test('closed-app notifications use the three channels the shell and the Kotlin side share', () => {
    assert.equal(UP.channelForKind('approval'), 'plenum-approvals');
    assert.equal(UP.channelForKind('handover'), 'plenum-approvals');
    assert.equal(UP.channelForKind('limit'), 'plenum-limits');
    assert.equal(UP.channelForKind('finished'), 'plenum-finished');
    assert.equal(UP.channelForKind('test'), 'plenum-finished');
  });

  test('the endpoint must be https; its key set is kept only when it is well formed', () => {
    const ok = UP.parseEndpointEvent({ instance: 'default', url: 'https://push.example.org/up/abc', temporary: false, pubKeySet: { pubKey: 'BPk-_x', auth: 'aGVsbG8' } });
    assert.equal(ok.url, 'https://push.example.org/up/abc');
    assert.deepEqual(ok.keys, { pubKey: 'BPk-_x', auth: 'aGVsbG8' });
    assert.throws(() => UP.parseEndpointEvent({ instance: 'default', url: 'http://push.example.org/x' }), { code: 'endpoint-not-https' });
    const noKeys = UP.parseEndpointEvent({ instance: 'default', url: 'https://push.example.org/x', pubKeySet: { pubKey: 'B+=', auth: 'a' } });
    assert.equal(noKeys.keys, null);
    assert.equal(noKeys.temporary, false);
  });

  test('every registration failure has a sentence and a retry rule; an unknown reason becomes INTERNAL_ERROR', () => {
    assert.equal(UP.describeRegistrationFailure('NETWORK').retry, 'when-online');
    assert.equal(UP.describeRegistrationFailure('ACTION_REQUIRED').retry, 'after-person');
    assert.equal(UP.describeRegistrationFailure('VAPID_REQUIRED').retry, 'with-vapid');
    const unknown = UP.describeRegistrationFailure('SOMETHING_ELSE');
    assert.equal(unknown.reason, 'INTERNAL_ERROR');
    assert.equal(unknown.retry, 'now');
  });
});

// ---------------------------------------------------------------- dictation core

describe('Dictation: start options and the copy for each error', () => {
  test('the defaults are on-device only, a 2 s silence, and the device language', () => {
    assert.deepEqual(DI.normaliseStartOptions(), { locale: undefined, allowServer: false, silenceMs: 2000 });
    assert.equal(DI.normaliseStartOptions({ allowServer: 'yes' }).allowServer, false, 'only true enables server recognition');
    assert.equal(DI.normaliseStartOptions({ allowServer: true }).allowServer, true);
  });

  test('the silence time is clamped to 0.5 s to 5 s, and a language tag must be a tag', () => {
    assert.equal(DI.normaliseStartOptions({ silenceMs: 10 }).silenceMs, 500);
    assert.equal(DI.normaliseStartOptions({ silenceMs: 99999 }).silenceMs, 5000);
    assert.equal(DI.normaliseStartOptions({ locale: 'en-GB' }).locale, 'en-GB');
    assert.throws(() => DI.normaliseStartOptions({ silenceMs: 'soon' }), { code: 'bad-silence' });
    assert.throws(() => DI.normaliseStartOptions({ locale: 'en GB' }), { code: 'bad-locale' });
  });

  test('the on-device-unavailable copy names the service of each platform and the Allow that switch', () => {
    const android = DI.dictationMessage('on-device-unavailable', { locale: 'en-GB', platform: 'android' });
    const ios = DI.dictationMessage('on-device-unavailable', { locale: 'en-GB', platform: 'ios' });
    assert.match(android, /Google's speech service/);
    assert.match(ios, /Apple's speech service/);
    for (const text of [android, ios]) {
      assert.match(text, /Turn on 'Allow that' in Phone settings › Dictation/);
      assert.match(text, /not available for/);
    }
  });

  test('the other error codes have plain sentences, and an unknown code gets the generic one', () => {
    assert.equal(DI.dictationMessage('permission-denied'), 'Plenum cannot use the microphone. Allow it in Settings › Plenum.');
    assert.equal(DI.dictationMessage('busy'), 'Dictation is already listening.');
    assert.match(DI.dictationMessage('no-speech'), /No speech was heard/);
    assert.equal(DI.dictationMessage('whatever'), 'Dictation stopped. Try again.');
  });
});

describe('Dictation: the composer state and the native events', () => {
  test('the composer state follows the availability, the permission and the server switch', () => {
    assert.equal(DI.dictationStatus({}).state, 'unavailable');
    assert.equal(DI.dictationStatus({ available: true, permission: 'denied' }).state, 'denied');
    assert.equal(DI.dictationStatus({ available: true, permission: 'prompt' }).state, 'needs-permission');
    assert.equal(DI.dictationStatus({ available: true, permission: 'granted', onDevice: false }).state, 'needs-server-switch');
    assert.equal(DI.dictationStatus({ available: true, permission: 'granted', onDevice: false, allowServer: true }).state, 'ready');
    assert.deepEqual(DI.dictationStatus({ available: true, permission: 'granted', onDevice: true }), { state: 'ready', canStart: true });
  });

  test('partial and final text lose control characters and are capped', () => {
    const partial = DI.parseDictationEvent('partial', { text: 'hel\u0000lo' });
    assert.deepEqual(partial, { type: 'partial', text: 'hel lo' });
    assert.equal(DI.parseDictationEvent('final', { text: 'z'.repeat(9000) }).text.length, 4000);
    assert.equal(DI.parseDictationEvent('final', null).text, '');
  });

  test('a level is clamped to 0..1 and a bad level is zero', () => {
    assert.equal(DI.parseDictationEvent('level', { value: 3 }).value, 1);
    assert.equal(DI.parseDictationEvent('level', { value: -1 }).value, 0);
    assert.equal(DI.parseDictationEvent('level', { value: 'loud' }).value, 0);
  });

  test('an unknown end reason becomes done, an unknown error code becomes unknown', () => {
    assert.equal(DI.parseDictationEvent('end', { reason: 'silence' }).reason, 'silence');
    assert.equal(DI.parseDictationEvent('end', { reason: 'hacked' }).reason, 'done');
    assert.equal(DI.parseDictationEvent('error', { code: 'nope', message: 'x' }).code, 'unknown');
    assert.throws(() => DI.parseDictationEvent('shout', {}), { code: 'bad-event' });
  });
});

// ---------------------------------------------------------------- isolated preview core

describe('Isolated preview: size, title and the sandbox policy', () => {
  test('an empty page is refused and the size is counted in UTF-8 bytes', () => {
    assert.throws(() => IP.checkHtml(''), { code: 'empty' });
    assert.throws(() => IP.checkHtml(undefined), { code: 'empty' });
    assert.equal(IP.checkHtml('<p>ok</p>'), 9);
    assert.throws(() => IP.checkHtml('é'.repeat(4 * 1024 * 1024 + 1)), { code: 'too-large' });
    assert.equal(IP.checkHtml('é'.repeat(4 * 1024 * 1024)), 8 * 1024 * 1024);
  });

  test('the title is cleaned and falls back to the default', () => {
    assert.equal(IP.normaliseTitle(' Chart\u0000 '), 'Chart');
    assert.equal(IP.normaliseTitle(undefined), 'Artifact preview');
    assert.equal(IP.normaliseTitle('t'.repeat(300)).length, 120);
  });

  test('the sandbox policy keeps the bridge, the network, files and storage closed', () => {
    assert.equal(Object.isFrozen(IP.SANDBOX_POLICY), true);
    assert.equal(IP.SANDBOX_POLICY.bridge, 'none');
    assert.equal(IP.SANDBOX_POLICY.network, 'blocked');
    assert.equal(IP.SANDBOX_POLICY.files, 'blocked');
    assert.equal(IP.SANDBOX_POLICY.storage, 'off');
    assert.equal(IP.SANDBOX_POLICY.javascript, 'on');
  });
});

// ---------------------------------------------------------------- JS side wiring and web fallbacks (text checks)

describe('plugin JavaScript sides: names, web fallbacks and the native method list', () => {
  const pluginNames = { unifiedpush: 'UnifiedPush', dictation: 'Dictation', 'isolated-preview': 'IsolatedPreview' };

  test('each index.js registers its plugin under the name the Kotlin class uses', () => {
    for (const [dir, name] of Object.entries(pluginNames)) {
      const source = read(`plugins/${dir}/src/index.js`);
      assert.match(source, new RegExp(`registerPlugin\\('${name}'`), dir);
      assert.match(source, /web: \(\) => import\('\.\/web\.js'\)/, dir);
    }
  });

  test('the web fallbacks say the feature is unavailable rather than pretending', () => {
    assert.match(read('plugins/unifiedpush/src/web.js'), /class UnifiedPushWeb extends WebPlugin/);
    assert.match(read('plugins/dictation/src/web.js'), /class DictationWeb extends WebPlugin/);
    assert.match(read('plugins/isolated-preview/src/web.js'), /class IsolatedPreviewWeb extends WebPlugin/);
    assert.match(read('plugins/unifiedpush/src/web.js'), /throw this\.unavailable\(NOT_ON_WEB\)/);
    assert.match(read('plugins/isolated-preview/src/web.js'), /throw this\.unimplemented\(/);
  });

  test('the Kotlin @PluginMethod names match the methods the typings declare', () => {
    const kotlinNames = text => [...text.matchAll(/@PluginMethod\s+fun\s+(\w+)/g)].map(m => m[1]).sort();
    const typed = rel => [...read(rel).matchAll(/^\s{2}(\w+)\(/gm)].map(m => m[1]).filter(n => n !== 'addListener').sort();
    const up = kotlinNames(fs.readFileSync(path.join(MOBILE, KOTLIN_UNIFIEDPUSH, 'UnifiedPushPlugin.kt'), 'utf8'));
    assert.deepEqual(up, typed('plugins/unifiedpush/src/index.d.ts'));
    const dictation = kotlinNames(fs.readFileSync(path.join(MOBILE, KOTLIN_DICTATION), 'utf8'));
    assert.deepEqual(dictation, typed('plugins/dictation/src/index.d.ts'));
    const preview = kotlinNames(fs.readFileSync(path.join(MOBILE, KOTLIN_PREVIEW, 'IsolatedPreviewPlugin.kt'), 'utf8'));
    assert.deepEqual(preview, typed('plugins/isolated-preview/src/index.d.ts'));
  });

  test('every event the native side sends is one the JavaScript side accepts', () => {
    const sent = (text, call) => new Set([...text.matchAll(new RegExp(`${call}\\("(\\w+)"`, 'g'))].map(m => m[1]));
    const upEvents = new Set([...sent(fs.readFileSync(path.join(MOBILE, KOTLIN_UNIFIEDPUSH, 'UnifiedPushService.kt'), 'utf8'), 'deliver')]);
    assert.deepEqual([...upEvents].sort(), [...UP.UNIFIEDPUSH_EVENTS].sort());
    const dictationText = fs.readFileSync(path.join(MOBILE, KOTLIN_DICTATION), 'utf8');
    const dictationEvents = sent(dictationText, 'emit');
    for (const name of dictationEvents) assert.ok(DI.DICTATION_EVENTS.includes(name), name);
    assert.deepEqual([...DI.DICTATION_EVENTS].filter(e => dictationText.includes(`"${e}"`)).sort(), [...DI.DICTATION_EVENTS].sort());
  });

  test('the Swift dictation plugin uses the same JavaScript name and the same events and defaults', () => {
    const swift = read('plugins/dictation/ios/Sources/DictationPlugin/DictationPlugin.swift');
    assert.match(swift, /@objc\(DictationPlugin\)/);
    assert.match(swift, /jsName = "Dictation"/);
    assert.match(swift, /requiresOnDeviceRecognition = !allowServer/);
    assert.match(swift, /call\.getBool\("allowServer", false\)/, 'server recognition is off unless allowed');
    for (const event of ['partial', 'final', 'level', 'end', 'error']) assert.match(swift, new RegExp(`emit\\("${event}"`), event);
    assert.match(read('plugins/dictation/Package.swift'), /\.iOS\(\.v16\)/);
  });
});

// ---------------------------------------------------------------- packages and the Capacitor config

describe('mobile/package.json, the lock file and the plugin packages', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  test('the three plugins are file: entries and nothing else was added', () => {
    assert.equal(pkg.dependencies['plenum-unifiedpush'], 'file:plugins/unifiedpush');
    assert.equal(pkg.dependencies['plenum-isolated-preview'], 'file:plugins/isolated-preview');
    assert.equal(pkg.dependencies['plenum-dictation'], 'file:plugins/dictation');
    assert.equal(pkg.devDependencies.typescript, '5.9.3', 'TypeScript is pinned: the Capacitor CLI reads capacitor.config.ts with it');
    assert.equal(pkg.dependencies['@capacitor/core'], '8.5.3');
    assert.equal(pkg.dependencies['@capacitor/android'], '8.5.3');
    assert.equal(pkg.dependencies['@capacitor/ios'], '8.5.3');
    assert.equal(pkg.dependencies['@capacitor/share'], '^8');
    assert.equal(pkg.scripts.sync, 'cap sync');
  });

  test('the lock file links each plugin to its folder and resolves TypeScript', () => {
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages[''].dependencies['plenum-dictation'], 'file:plugins/dictation');
    assert.equal(lock.packages['node_modules/plenum-dictation'].link, true);
    assert.equal(lock.packages['node_modules/plenum-dictation'].resolved, 'plugins/dictation');
    assert.equal(lock.packages['plugins/unifiedpush'].version, '8.0.0');
    assert.equal(lock.packages['node_modules/typescript'].version, '5.9.3');
  });

  for (const dir of ['unifiedpush', 'isolated-preview', 'dictation']) {
    test(`plugins/${dir}: package.json names its Android module, which exists, and has the entry files`, () => {
      const p = JSON.parse(read(`plugins/${dir}/package.json`));
      assert.equal(p.private, true);
      assert.equal(p.capacitor.android.src, 'android');
      assert.ok(exists(`plugins/${dir}/android/build.gradle`));
      assert.ok(exists(`plugins/${dir}/android/src/main/AndroidManifest.xml`));
      assert.ok(exists(`plugins/${dir}/${p.main}`), p.main);
      assert.equal(p.peerDependencies['@capacitor/core'], '>=8.0.0');
    });
  }

  test('only the dictation plugin ships iOS code, with a Package.swift for Swift Package Manager', () => {
    const dictation = JSON.parse(read('plugins/dictation/package.json'));
    assert.equal(dictation.capacitor.ios.src, 'ios');
    assert.ok(exists('plugins/dictation/Package.swift'));
    assert.ok(exists('plugins/dictation/ios/Sources/DictationPlugin/DictationPlugin.swift'));
    for (const dir of ['unifiedpush', 'isolated-preview']) {
      assert.equal(JSON.parse(read(`plugins/${dir}/package.json`)).capacitor.ios, undefined, `${dir} is Android only`);
      assert.ok(!exists(`plugins/${dir}/Package.swift`));
    }
  });

  test('a local plugin names its SwiftPM package and product the way the Capacitor CLI does (plenum-dictation -> PlenumDictation)', () => {
    // The CLI takes the name from the npm package: each part of the name capitalised, the scope and the separators dropped.
    const fixName = name => name.replace(/^@/, '').split(/[/-]/).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
    const pkg = JSON.parse(read('package.json'));
    const local = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, spec]) => spec.startsWith('file:'));
    assert.ok(local.length >= 3, 'the three local plugins are declared');
    const spm = read('ios/App/CapApp-SPM/Package.swift');
    for (const [dep, spec] of local) {
      const rel = spec.slice('file:'.length);
      const npmName = JSON.parse(read(`${rel}/package.json`)).name;
      assert.equal(npmName, dep, `${rel} is the package ${dep}`);
      if (!exists(`${rel}/Package.swift`)) continue;
      const swift = read(`${rel}/Package.swift`);
      const product = swift.match(/\.library\(\s*name:\s*"([^"]+)"/)?.[1];
      assert.equal(product, fixName(npmName), `${npmName}: the library product`);
      assert.match(swift, new RegExp(`Package\\(\\s*name: "${fixName(npmName)}"`), `${npmName}: the package name`);
      assert.ok(spm.includes(`.package(name: "${fixName(npmName)}", path: "../../../node_modules/${npmName}")`), `${npmName} is in CapApp-SPM`);
      assert.ok(spm.includes(`.product(name: "${fixName(npmName)}", package: "${fixName(npmName)}")`), `${npmName} product is linked`);
    }
  });

  test('the connector is pinned to 3.3.5 and the Kotlin plugin version to 2.2.10', () => {
    const gradle = read('plugins/unifiedpush/android/build.gradle');
    assert.match(gradle, /unifiedpushConnectorVersion = '3\.3\.5'/);
    assert.match(gradle, /implementation "org\.unifiedpush\.android:connector:\$unifiedpushConnectorVersion"/);
    assert.match(gradle, /kotlin_version = '2\.2\.10'/);
  });
});

describe('capacitor.config.ts (the one place the native identifiers live)', () => {
  const config = read('capacitor.config.ts');

  test('the appId, the app name and the web directory are as MOBILE.json decided', () => {
    assert.match(config, /appId: 'com\.realalcibiades\.plenum'/);
    assert.match(config, /appName: 'Plenum'/);
    assert.match(config, /webDir: 'www'/);
  });

  test('the origin scheme is https on Android and capacitor on iOS, and mixed content is allowed for the LAN channel', () => {
    assert.match(config, /androidScheme: 'https'/);
    assert.match(config, /iosScheme: 'capacitor'/);
    assert.match(config, /allowMixedContent: true/);
  });

  test('the iOS scheme is left at its default, so the generated project is App.xcodeproj', () => {
    assert.ok(!/\bios:\s*{[^}]*\bscheme:/s.test(config), 'no ios.scheme');
  });

  test('CapacitorHttp stays off and no signing secret or keystore is named in the config', () => {
    assert.match(config, /CapacitorHttp: \{[\s\S]*?enabled: false/);
    assert.ok(!/keystore\s*[:=]|password\s*[:=]|storeFile|keyPassword/i.test(config), 'no signing values in the config');
  });
});

// ---------------------------------------------------------------- the Android project (text and structure)

describe('the Android project: manifest, network security, resources and Gradle', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');

  test('every XML file under mobile/ is well formed', () => {
    const xmlFiles = walk(MOBILE).filter(f => f.endsWith('.xml') && !f.includes(`${path.sep}www${path.sep}`));
    assert.ok(xmlFiles.length >= 10, `found ${xmlFiles.length} XML files`);
    for (const file of xmlFiles) assertWellFormedXml(fs.readFileSync(file, 'utf8'), path.relative(MOBILE, file));
  });

  test('the app manifest asks for exactly the permissions MOBILE-UI names, and nothing else', () => {
    const code = stripXmlComments(manifest);
    for (const perm of ['INTERNET', 'ACCESS_NETWORK_STATE', 'CAMERA', 'POST_NOTIFICATIONS', 'RECORD_AUDIO', 'VIBRATE']) {
      assert.match(manifest, new RegExp(`android\\.permission\\.${perm}"`), perm);
    }
    const declared = [...code.matchAll(/uses-permission android:name="android\.permission\.(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(declared.sort(), ['ACCESS_NETWORK_STATE', 'CAMERA', 'INTERNET', 'POST_NOTIFICATIONS', 'RECORD_AUDIO', 'VIBRATE']);
    assert.ok(!/FOREGROUND_SERVICE|ACCESS_LOCAL_NETWORK|READ_EXTERNAL|WRITE_EXTERNAL|SYSTEM_ALERT/.test(code));
  });

  test('backups are off (encrypted key blobs are never copied), the network config is referenced, and debug is not forced', () => {
    const code = stripXmlComments(manifest);
    assert.match(code, /android:allowBackup="false"/);
    assert.match(code, /android:networkSecurityConfig="@xml\/network_security_config"/);
    assert.ok(!/debuggable/i.test(code));
    assert.ok(!/usesCleartextTraffic/.test(code), 'cleartext is set in the network config, not here');
  });

  test('the plenum scheme opens the app (a pairing link from outside, and the notification routes), and the launcher still starts it', () => {
    assert.match(manifest, /<data android:scheme="plenum" android:host="pair" \/>/);
    assert.match(manifest, /<data android:scheme="plenum" android:host="app" \/>/);
    assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
    assert.match(manifest, /android:launchMode="singleTask"/);
  });

  test('the network security config allows cleartext only in base-config, as MOBILE.json says', () => {
    const nsc = read('android/app/src/main/res/xml/network_security_config.xml');
    assert.match(stripXmlComments(nsc), /<base-config cleartextTrafficPermitted="true">/);
    assert.ok(!/domain-config|debug-overrides/.test(stripXmlComments(nsc)));
  });

  test('the template theme colours exist (the theme refers to them)', () => {
    const styles = read('android/app/src/main/res/values/styles.xml');
    const colors = read('android/app/src/main/res/values/colors.xml');
    for (const name of [...styles.matchAll(/@color\/(\w+)/g)].map(m => m[1])) {
      assert.match(colors, new RegExp(`name="${name}"`), name);
    }
  });

  test('the SDK levels are minSdk 26, compile 36, target 36', () => {
    const variables = read('android/variables.gradle');
    assert.match(variables, /minSdkVersion = 26/);
    assert.match(variables, /compileSdkVersion = 36/);
    assert.match(variables, /targetSdkVersion = 36/);
  });

  test('no Google services are applied (Plenum uses no Firebase)', () => {
    assert.ok(!/google-services|google\.gms/.test(read('android/build.gradle') + read('android/app/build.gradle')));
  });

  test('signing comes only from the environment: no keystore file or password is in the repository', () => {
    const gradle = read('android/app/build.gradle');
    assert.match(gradle, /System\.getenv\('ANDROID_KEYSTORE_PATH'\)/);
    assert.match(gradle, /System\.getenv\('ANDROID_KEYSTORE_PASSWORD'\)/);
    assert.match(gradle, /System\.getenv\('ANDROID_KEY_ALIAS'\)/);
    assert.match(gradle, /System\.getenv\('ANDROID_KEY_PASSWORD'\)/);
    assert.ok(!/storePassword\s+'/.test(gradle) && !/keyPassword\s+'/.test(gradle), 'no literal password');
    assert.ok(!/storeFile\s+file\('[^']/.test(gradle), 'no literal keystore path');
    const keystores = walk(MOBILE).filter(f => /\.(jks|keystore|p12|pfx|mobileprovision|p8)$/i.test(f));
    assert.deepEqual(keystores, [], 'no signing material in mobile/');
  });

  test('the release Gradle line passes the version from the tag, so a store upload never repeats versionCode 1', () => {
    const release = fs.readFileSync(path.join(MOBILE, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    assert.match(release, /PLENUM_VERSION: \$\{\{ needs\.prepare\.outputs\.version \}\}/, 'the version comes from the tag check');
    assert.match(release, /\.\/gradlew --no-daemon -PplenumVersionName="\$PLENUM_VERSION" -PplenumVersionCode="\$code" assembleRelease bundleRelease/, 'the release gradlew line carries both -P flags');
    assert.match(release, /code=\$\(\( major \* 10000 \+ minor \* 100 \+ patch \)\)/, 'versionCode is major*10000 + minor*100 + patch');
  });

  test('every Gradle file has balanced brackets', () => {
    const gradleFiles = walk(MOBILE).filter(f => f.endsWith('.gradle'));
    assert.ok(gradleFiles.length >= 8, `found ${gradleFiles.length} Gradle files`);
    for (const file of gradleFiles) assertBalanced(fs.readFileSync(file, 'utf8'), path.relative(MOBILE, file));
  });

  test('the Gradle settings include the three plugins and the app depends on them', () => {
    const settings = read('android/capacitor.settings.gradle');
    const build = read('android/app/capacitor.build.gradle');
    for (const dir of ['dictation', 'isolated-preview', 'unifiedpush']) {
      assert.match(settings, new RegExp(`plenum-${dir}/android'\\)`));
      assert.match(build, new RegExp(`implementation project\\(':plenum-${dir}'\\)`));
    }
  });

  test('the notification icon the plugins and the local-notifications config use exists as a vector', () => {
    const icon = read('plugins/unifiedpush/android/src/main/res/drawable/ic_stat_plenum.xml');
    assert.match(icon, /android:viewportWidth="24"/);
    assert.match(read('capacitor.config.ts'), /smallIcon: 'ic_stat_plenum'/);
  });
});

describe('the native code: names, sandbox, privacy and the notification rules', () => {
  test('each Kotlin or Java class carries the plugin name the JavaScript side registers', () => {
    const names = [
      [path.join(KOTLIN_UNIFIEDPUSH, 'UnifiedPushPlugin.kt'), 'UnifiedPush'],
      [KOTLIN_DICTATION, 'Dictation'],
      [path.join(KOTLIN_PREVIEW, 'IsolatedPreviewPlugin.kt'), 'IsolatedPreview'],
      [path.join(APP_JAVA, 'PlenumPrivacyPlugin.java'), 'PlenumPrivacy'],
    ];
    for (const [rel, name] of names) {
      const text = fs.readFileSync(path.join(MOBILE, rel), 'utf8');
      assert.match(text, new RegExp(`@CapacitorPlugin\\(\\s*name = "${name}"`), rel);
    }
  });

  test('the push service is the connector PushService, not exported, and listens for PUSH_EVENT', () => {
    const service = fs.readFileSync(path.join(MOBILE, KOTLIN_UNIFIEDPUSH, 'UnifiedPushService.kt'), 'utf8');
    assert.match(service, /class UnifiedPushService : PushService\(\)/);
    const manifest = read('plugins/unifiedpush/android/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:name="com\.realalcibiades\.plenum\.unifiedpush\.UnifiedPushService"\s+android:exported="false"/);
    assert.match(manifest, /org\.unifiedpush\.android\.connector\.PUSH_EVENT/);
    assert.match(manifest, /org\.unifiedpush\.android\.distributor\.REGISTER/);
  });

  test('the closed-app notifications use the approval-only Approve rule and device authentication on every action', () => {
    const notifier = fs.readFileSync(path.join(MOBILE, KOTLIN_UNIFIEDPUSH, 'PlenumNotifier.kt'), 'utf8');
    assert.match(notifier, /setAuthenticationRequired\(true\)/);
    assert.match(notifier, /"Plenum has an update\."/);
    assert.match(notifier, /plenum:\/\/app\$route/);
    assert.match(notifier, /"&line=" \+ URLEncoder\.encode/);
  });

  test('the isolated preview has no bridge, no interface, no file or content access, and refuses the network', () => {
    const activity = fs.readFileSync(path.join(MOBILE, KOTLIN_PREVIEW, 'IsolatedPreviewActivity.kt'), 'utf8');
    for (const setting of [
      'javaScriptEnabled = true',
      'domStorageEnabled = false',
      'allowFileAccess = false',
      'allowContentAccess = false',
      'allowFileAccessFromFileURLs = false',
      'allowUniversalAccessFromFileURLs = false',
      'setGeolocationEnabled(false)',
      'javaScriptCanOpenWindowsAutomatically = false',
      'setSupportMultipleWindows(false)',
      'mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW',
      'FLAG_SECURE',
    ]) {
      assert.ok(activity.includes(setting), setting);
    }
    assert.match(activity, /override fun shouldInterceptRequest/);
    assert.match(activity, /override fun shouldOverrideUrlLoading\(view: WebView\?, request: WebResourceRequest\?\): Boolean = true/);
    assert.match(activity, /loadDataWithBaseURL\("about:blank"/);
    const preview = walk(path.join(MOBILE, 'plugins/isolated-preview')).filter(f => f.endsWith('.kt'));
    for (const file of preview) assert.ok(!fs.readFileSync(file, 'utf8').includes('addJavascriptInterface'), path.basename(file));
    const manifest = read('plugins/isolated-preview/android/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:process=":isolatedpreview"/);
    assert.match(manifest, /android:exported="false"/);
    assert.match(manifest, /excludeFromRecents="true"/);
  });

  test('the preview reads only the file it staged, and deletes it after the read', () => {
    const activity = fs.readFileSync(path.join(MOBILE, KOTLIN_PREVIEW, 'IsolatedPreviewActivity.kt'), 'utf8');
    assert.match(activity, /if \(!inside\) return ""/);
    assert.match(activity, /finally \{\s*file\.delete\(\)/);
  });

  test('FLAG_SECURE is set only by the privacy switch and the isolated preview, never by default elsewhere', () => {
    const hits = walk(MOBILE).filter(f => /\.(kt|java)$/.test(f) && fs.readFileSync(f, 'utf8').includes('FLAG_SECURE'));
    const rels = hits.map(f => path.relative(MOBILE, f).split(path.sep).join('/')).sort();
    assert.deepEqual(rels, [
      'android/app/src/main/java/com/realalcibiades/plenum/PlenumPrivacyPlugin.java',
      'plugins/isolated-preview/android/src/main/java/com/realalcibiades/plenum/isolatedpreview/IsolatedPreviewActivity.kt',
    ]);
    const privacy = read('android/app/src/main/java/com/realalcibiades/plenum/PlenumPrivacyPlugin.java');
    assert.match(privacy, /getBoolean\(KEY_HIDE, true\)/, 'on by default, as MOBILE-UI 6.17 shows it checked');
    assert.match(privacy, /if \(hide\) \{\s*window\.addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  });

  test('MainActivity registers the privacy plugin before the bridge starts and applies the setting on the first frame', () => {
    const main = read('android/app/src/main/java/com/realalcibiades/plenum/MainActivity.java');
    const register = main.indexOf('registerPlugin(PlenumPrivacyPlugin.class)');
    const bridge = main.indexOf('super.onCreate(savedInstanceState)');
    assert.ok(register >= 0 && bridge > register, 'registration comes before super.onCreate');
    assert.match(main, /PlenumPrivacyPlugin\.applyTo\(getWindow\(\), PlenumPrivacyPlugin\.hideInSwitcher\(this\)\)/);
  });

  test('the dictation plugin asks for the microphone only through its permission alias and uses on-device recognition first', () => {
    const kotlin = fs.readFileSync(path.join(MOBILE, KOTLIN_DICTATION), 'utf8');
    assert.match(kotlin, /alias = "microphone"/);
    assert.match(kotlin, /createOnDeviceSpeechRecognizer/);
    assert.match(kotlin, /EXTRA_PREFER_OFFLINE, !allowServer/);
    assert.match(kotlin, /val allowServer = call\.getBoolean\("allowServer", false\) \?: false/);
    assert.match(kotlin, /SpeechRecognizer\.createSpeechRecognizer\(context\)/, 'the server recogniser is reachable only with allowServer');
  });

  test('no native file logs the payload, the keys or the auth secret, and the Swift code never prints', () => {
    const native = walk(MOBILE).filter(f => /\.(kt|java|swift)$/.test(f));
    assert.ok(native.length >= 8, `found ${native.length} native files`);
    for (const file of native) {
      const text = codeOnly(fs.readFileSync(file, 'utf8'));
      assert.ok(!/Log\.[dviwe]\([^)]*(content|pubKey|auth|payload|text)/.test(text), path.basename(file));
      if (file.endsWith('.swift')) assert.ok(!/\bprint\(/.test(text), path.basename(file));
    }
  });

  test('the Kotlin and Java files have balanced brackets', () => {
    const native = walk(MOBILE).filter(f => /\.(kt|java)$/.test(f));
    for (const file of native) assertBalanced(fs.readFileSync(file, 'utf8'), path.relative(MOBILE, file));
  });
});

// ---------------------------------------------------------------- the shell side: native.js and the Android push (H6, L18, M15, M11)

describe('native.js: the plugins the shell registers (H6)', () => {
  const fakeParts = () => {
    const registered = [];
    const registerPlugin = name => {
      registered.push(name);
      return { name, calls: [] };
    };
    return {
      registered,
      parts: {
        registerPlugin,
        WebView: { name: 'WebView' },
        SecureStorage: { async getItem() { return null; }, async setItem() {}, async removeItem() {}, async keys() { return []; } },
        BiometricAuth: { async checkBiometry() { return { isAvailable: true }; }, async authenticate() {} },
        Dictation: { name: 'Dictation' },
        IsolatedPreview: { name: 'IsolatedPreview' },
        UnifiedPush: { name: 'UnifiedPush' },
      },
    };
  };

  test('buildNative registers every plugin the shell reads, once, by the name its native side uses', async () => {
    const { buildNative, REGISTERED_NAMES } = await import('../shell/native.js');
    const { registered, parts } = fakeParts();
    const native = buildNative(parts);
    assert.deepEqual([...registered].sort(), [...REGISTERED_NAMES].sort());
    assert.equal(new Set(registered).size, registered.length, 'no plugin is registered twice (Capacitor warns and ignores a second one)');
    for (const name of ['App', 'Haptics', 'Browser', 'Share', 'Filesystem', 'TextZoom', 'Network', 'LocalNotifications', 'PlenumPrivacy']) assert.ok(native[name], name);
    assert.ok(native.BiometricAuth && native.WebView && native.UnifiedPush && native.Dictation && native.IsolatedPreview && native.secureStorage && native.BarcodeScanner);
    // The scanner's native name is the barcode package's (read from its index.js); the app's own plugin is the Java class's @CapacitorPlugin name.
    assert.ok(registered.includes('CapacitorBarcodeScanner'));
    assert.match(read('android/app/src/main/java/com/realalcibiades/plenum/PlenumPrivacyPlugin.java'), /@CapacitorPlugin\(name = "PlenumPrivacy"\)/);
  });

  test('the secure storage adapter gives store.js the shape it reads, over the package API', async () => {
    const { secureStorageAdapter } = await import('../shell/native.js');
    const { createSecureKv } = await import('../shell/store.js');
    const data = new Map();
    // The aparajita package: getItem(key) -> string | null, setItem(key, value), removeItem(key), keys() -> string[].
    const plugin = {
      async getItem(key) { return data.has(key) ? data.get(key) : null; },
      async setItem(key, value) { assert.equal(typeof key, 'string'); assert.equal(typeof value, 'string'); data.set(key, value); },
      async removeItem(key) { data.delete(key); },
      async keys() { return [...data.keys()]; },
    };
    const kv = createSecureKv({ plugin: secureStorageAdapter(plugin) });
    await kv.put('computer:a', { id: 'a', myPriv: 'SECRET' });
    assert.deepEqual(await kv.get('computer:a'), { id: 'a', myPriv: 'SECRET' });
    assert.equal(await kv.get('missing'), undefined);
    assert.deepEqual(await kv.keys(), ['computer:a']);
    await kv.delete('computer:a');
    assert.deepEqual(await kv.keys(), []);
    assert.equal([...data.keys()].length, 0);
  });

  test('configureStorage on iOS throws when the Keychain setting is refused or missing, and on Android it does not set it', async () => {
    const { buildNative } = await import('../shell/native.js');
    const { parts } = fakeParts();
    const calls = [];
    parts.SecureStorage.setSynchronize = async v => { calls.push(['sync', v]); };
    parts.SecureStorage.setDefaultKeychainAccess = async v => { calls.push(['access', v]); throw new Error('refused'); };
    await assert.rejects(buildNative(parts, { platform: 'ios' }).configureStorage(), /refused/, 'a refused Keychain setting fails closed');
    assert.deepEqual(calls, [['sync', false], ['access', 1]], 'off for iCloud first, then this device only');
    delete parts.SecureStorage.setDefaultKeychainAccess;
    await assert.rejects(buildNative(parts, { platform: 'ios' }).configureStorage(), /keychain access cannot be set/, 'a missing setting fails closed');
    calls.length = 0;
    parts.SecureStorage.setDefaultKeychainAccess = async v => { calls.push(['access', v]); };
    await buildNative(parts, { platform: 'android' }).configureStorage();
    assert.deepEqual(calls, [['sync', false]], 'Android has no Keychain setting');
  });

  test('the BROWSABLE pairing filter has host pair, the app filter is not BROWSABLE, and no scheme-only filter is left', () => {
    const xml = read('android/app/src/main/AndroidManifest.xml');
    const filters = [...xml.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)].map(m => m[1]);
    const browsable = filters.filter(f => f.includes('android.intent.category.BROWSABLE'));
    assert.equal(browsable.length, 1, 'one BROWSABLE filter');
    assert.match(browsable[0], /<data android:scheme="plenum" android:host="pair" \/>/);
    const app = filters.filter(f => f.includes('android:host="app"'));
    assert.equal(app.length, 1, 'one app filter');
    assert.doesNotMatch(app[0], /BROWSABLE/, 'the app filter is not BROWSABLE');
    assert.ok(!filters.some(f => /<data android:scheme="plenum" \/>/.test(f)), 'no scheme-only plenum filter');
  });

  test('file_paths.xml has no external-path, so the file provider shares only the app cache', () => {
    const xml = read('android/app/src/main/res/xml/file_paths.xml');
    assert.doesNotMatch(xml, /external-path/);
    assert.match(xml, /<cache-path name="my_cache_images" path="\." \/>/);
  });

  test('the barcode scan maps a result and each refusal: text, cancelled, denied, failed', async () => {
    const { buildNative, scanOutcome } = await import('../shell/native.js');
    assert.deepEqual(scanOutcome(null, { ScanResult: 'plenum://pair#abc' }), { ok: true, text: 'plenum://pair#abc' });
    assert.deepEqual(scanOutcome(null, { ScanResult: '' }), { ok: false, reason: 'cancelled' });
    assert.deepEqual(scanOutcome(new Error('Camera permission was denied'), null), { ok: false, reason: 'denied' });
    assert.deepEqual(scanOutcome({ code: 'OS-PLUG-BARC-0006', message: 'The user cancelled the scan' }, null), { ok: false, reason: 'cancelled' });
    assert.deepEqual(scanOutcome(new Error('boom'), null), { ok: false, reason: 'failed' });
    const seen = [];
    const { parts } = fakeParts();
    parts.registerPlugin = name => (name === 'CapacitorBarcodeScanner' ? { async scanBarcode(options) { seen.push(options); return { ScanResult: 'https://x/#pair=1' }; } } : {});
    const native = buildNative(parts);
    assert.deepEqual(await native.BarcodeScanner.scan(), { ok: true, text: 'https://x/#pair=1' });
    assert.equal(seen[0].hint, 0, 'QR codes only (Html5QrcodeSupportedFormats.QR_CODE)');
    assert.equal(seen[0].cameraDirection, 1);
    assert.equal(seen[0].scanButton, false);
  });

  test('loadNativePlugins registers the real plugins: every name the shell reads is on Capacitor.Plugins afterwards', async () => {
    const { loadNativePlugins } = await import('../shell/native.js');
    const native = await loadNativePlugins();
    const present = Object.keys(globalThis.Capacitor?.Plugins ?? {});
    for (const name of ['App', 'Haptics', 'Browser', 'Share', 'Filesystem', 'TextZoom', 'Network', 'LocalNotifications', 'CapacitorBarcodeScanner', 'PlenumPrivacy',
      'SecureStorage', 'BiometricAuthNative', 'UnifiedPush', 'Dictation', 'IsolatedPreview', 'WebView']) {
      assert.ok(present.includes(name), `${name} is registered (have ${present.join(', ')})`);
    }
    assert.equal(typeof native.secureStorage.getItem, 'function');
    assert.equal(typeof native.BiometricAuth.authenticate, 'function', 'the biometric plugin is the package object: Capacitor.Plugins.BiometricAuth never exists');
    assert.equal(present.includes('BiometricAuth'), false);
  });

  test('app.js reads the registered objects, not Capacitor.Plugins.SecureStorage or BiometricAuth alone', () => {
    const app = fs.readFileSync(path.join(MOBILE, 'shell', 'app.js'), 'utf8');
    assert.match(app, /plugins\?\.secureStorage \?\? cap\?\.Plugins\?\.SecureStorage/);
    assert.match(app, /plugins\?\.BiometricAuth \?\? cap\?\.Plugins\?\.BiometricAuth/);
    assert.match(app, /await import\('\.\/native\.js'\)/, 'native.js is loaded with a dynamic import');
    assert.match(app, /isNative\(env\)/);
  });
});

describe('Android push through UnifiedPush and local notifications (M15)', () => {
  const keyPair = () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { pubKey: ecdh.getPublicKey(null, 'uncompressed').toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  };

  function fakePlugins({ distributors = ['io.heckel.ntfy'], saved = null, permission = true } = {}) {
    const handlers = new Map();
    const local = { channels: [], types: [], scheduled: [], listeners: new Map(), asked: 0 };
    const log = [];
    const up = {
      async getState() { return { supported: true, distributor: saved, endpoints: {}, failures: {}, registrations: [], visible: true }; },
      async getDistributors() { return { distributors, saved }; },
      async chooseDistributor(arg) { log.push(['choose', arg.packageName]); saved = arg.packageName; return { saved }; },
      async pickDistributor() { log.push(['pick']); return { ok: true }; },
      async register(options) { log.push(['register', options]); },
      async unregister(options) { log.push(['unregister', options]); },
      async requestNotificationPermission() { return { granted: permission }; },
      async addListener(event, fn) { handlers.set(event, fn); return { remove: async () => handlers.delete(event) }; },
    };
    const localNotifications = {
      async createChannel(c) { local.channels.push(c); },
      async registerActionTypes(arg) { local.types.push(...arg.types); },
      async schedule(arg) { local.scheduled.push(...arg.notifications); },
      async requestPermissions() { local.asked += 1; return { display: 'granted' }; },
      async addListener(event, fn) { local.listeners.set(event, fn); return { remove: async () => {} }; },
    };
    return { up, localNotifications, handlers, local, log };
  }

  const requestRecorder = () => {
    const posted = [];
    const request = async (req, body) => {
      posted.push({ req, body: JSON.parse(body) });
      return { status: 200, body: { cancel: async () => {} } };
    };
    return { posted, request };
  };

  const registered = async f => {
    for (let i = 0; i < 100 && !f.log.some(l => l[0] === 'register'); i++) await new Promise(r => setTimeout(r, 5));
  };

  test('start creates the three channels the Kotlin service uses and listens for the push app events', async () => {
    const { createAndroidPush, ANDROID_CHANNELS } = await import('../shell/push.js');
    const f = fakePlugins();
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => null });
    assert.equal(await push.start(), true);
    assert.deepEqual(f.local.channels.map(c => c.id), ['plenum-approvals', 'plenum-finished', 'plenum-limits']);
    assert.deepEqual(ANDROID_CHANNELS.map(c => c.id), Object.values(UP.NOTIFICATION_CHANNELS), 'the same ids as the plugin core.js and the Kotlin side');
    assert.deepEqual([...f.handlers.keys()].sort(), ['endpoint', 'message', 'registrationFailed', 'unregistered']);
    assert.ok(f.local.listeners.has('localNotificationActionPerformed'));
    assert.equal(await push.start(), false, 'a second start does nothing');
  });

  test('turning notifications on registers once, and the endpoint the push app gives reaches POST /api/phones/push as a unifiedpush subscription the computer accepts', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const { normalizeSubscription } = await import('../../lib/remote/push.mjs');
    const f = fakePlugins();
    const { posted, request } = requestRecorder();
    const vapid = 'A'.repeat(87);
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => request, vapidOf: () => vapid });
    const keys = keyPair();
    const enabling = push.enable();
    await registered(f);
    assert.deepEqual(f.log.filter(l => l[0] === 'choose'), [['choose', 'io.heckel.ntfy']], 'the only push app is chosen');
    assert.deepEqual(f.log.find(l => l[0] === 'register')[1], { instance: 'default', messageForDistributor: 'Plenum', vapid });
    await f.handlers.get('endpoint')({ instance: 'default', url: 'https://ntfy.example.net/up/abc123', temporary: false, pubKeySet: { pubKey: keys.pubKey, auth: keys.auth } });
    assert.deepEqual(await enabling, { ok: true, reason: null });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].req.path, '/api/phones/push');
    assert.deepEqual(posted[0].body, { subscription: { kind: 'unifiedpush', endpoint: 'https://ntfy.example.net/up/abc123', keys: { p256dh: keys.pubKey, auth: keys.auth } } });
    // The computer's own check (lib/remote/push.mjs) takes it as it is.
    const accepted = normalizeSubscription(posted[0].body.subscription);
    assert.equal(accepted.kind, 'unifiedpush');
    assert.equal(accepted.endpoint, 'https://ntfy.example.net/up/abc123');
    assert.equal((await push.state()).registered, true);
  });

  test('an endpoint the computer did not get (no channel, or a refusal) is sent again at the next HELLO, once, and never after turning notifications off (B-129)', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const f = fakePlugins();
    const { posted, request } = requestRecorder();
    let live = null;
    const kept = { value: undefined };
    const pendingStore = {
      load: async () => kept.value,
      save: async body => { kept.value = body; },
      clear: async () => { kept.value = undefined; },
    };
    const make = fake => createAndroidPush({ native: { UnifiedPush: fake.up, LocalNotifications: fake.localNotifications }, requestOf: () => live, pendingStore });
    const push = make(f);
    await push.start();
    const keys = keyPair();
    // The push app gives its endpoint while the phone has no channel to a computer.
    await f.handlers.get('endpoint')({ instance: 'default', url: 'https://ntfy.example.net/up/abc123', temporary: false, pubKeySet: { pubKey: keys.pubKey, auth: keys.auth } });
    assert.equal(posted.length, 0);
    assert.deepEqual(await push.state(), { supported: true, distributor: null, registered: false, endpoint: true, failure: null });
    assert.equal(kept.value?.subscription?.endpoint, 'https://ntfy.example.net/up/abc123', 'the key set waits in the phone\x27s own store');
    assert.deepEqual(await push.resend(), { ok: false, reason: 'failed' }, 'still no channel');
    live = request;
    assert.deepEqual(await push.resend(), { ok: true, reason: null });
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { subscription: { kind: 'unifiedpush', endpoint: 'https://ntfy.example.net/up/abc123', keys: { p256dh: keys.pubKey, auth: keys.auth } } });
    assert.equal(kept.value, undefined, 'nothing waits once the computer has it');
    assert.equal((await push.state()).registered, true);
    assert.deepEqual(await push.resend(), { ok: true, reason: null });
    assert.equal(posted.length, 1, 'a second HELLO sends nothing more');
    // Turning notifications off forgets a waiting endpoint, so a later HELLO does not subscribe the phone again.
    live = null;
    const g = fakePlugins();
    const again = make(g);
    await again.start();
    await g.handlers.get('endpoint')({ instance: 'default', url: 'https://ntfy.example.net/up/def456', temporary: false, pubKeySet: { pubKey: keys.pubKey, auth: keys.auth } });
    assert.ok(kept.value);
    live = request;
    await again.disable();
    assert.equal(kept.value, undefined);
    const before = posted.length;
    await again.resend();
    assert.equal(posted.length, before, 'only the turn-off (a null subscription) was sent');
    assert.deepEqual(posted.at(-1).body, { subscription: null });
  });

  test('an endpoint left by the last run is picked up at start and sent at the first HELLO of this run (B-129)', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const f = fakePlugins();
    const { posted, request } = requestRecorder();
    const keys = keyPair();
    const body = { subscription: { kind: 'unifiedpush', endpoint: 'https://ntfy.example.net/up/left1', keys: { p256dh: keys.pubKey, auth: keys.auth } } };
    let kept = body;
    const pendingStore = { load: async () => kept, save: async b => { kept = b; }, clear: async () => { kept = undefined; } };
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => request, pendingStore });
    await push.start();
    assert.deepEqual(await push.resend(), { ok: true, reason: null });
    assert.deepEqual(posted.map(p => p.body), [body]);
    assert.equal(kept, undefined);
  });

  test('a notification action carries the computer that sent it to the link handler (B-117)', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const f = fakePlugins();
    const links = [];
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => null, onLink: (link, computer) => links.push([link, computer]) });
    await push.start();
    const id = 'ab'.repeat(32);
    const extra = { tap: '/#waiting=ap1', routes: { deny: '/#deny=ap1', stop: '/#stop' }, line: '', computer: id };
    const fire = actionId => f.local.listeners.get('localNotificationActionPerformed')({ actionId, notification: { extra } });
    fire('tap');
    fire('deny');
    fire('stop');
    assert.deepEqual(links, [['#waiting=ap1', ''], ['#deny=ap1', id], ['#stop', id]]);
  });

  test('no push app installed, a denied permission and an endpoint with no key set each answer a reason and send nothing', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const none = fakePlugins({ distributors: [] });
    const { posted, request } = requestRecorder();
    const a = createAndroidPush({ native: { UnifiedPush: none.up, LocalNotifications: none.localNotifications }, requestOf: () => request });
    assert.deepEqual(await a.enable(), { ok: false, reason: 'no-distributor' });
    const denied = fakePlugins({ permission: false });
    const b = createAndroidPush({ native: { UnifiedPush: denied.up, LocalNotifications: denied.localNotifications }, requestOf: () => request });
    assert.deepEqual(await b.enable(), { ok: false, reason: 'denied' });
    const keyless = fakePlugins();
    const c = createAndroidPush({ native: { UnifiedPush: keyless.up, LocalNotifications: keyless.localNotifications }, requestOf: () => request });
    const run = c.enable();
    await registered(keyless);
    await keyless.handlers.get('endpoint')({ instance: 'default', url: 'https://ntfy.example.net/up/x', temporary: false });
    assert.deepEqual(await run, { ok: false, reason: 'endpoint' });
    assert.deepEqual(posted, []);
    assert.equal((await createAndroidPush({ native: null }).enable()).reason, 'unavailable');
  });

  test('a message shows a local notification while Plenum is in front, with the right channel and the Deny / Stop all / Approve actions, and none while it is behind', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const f = fakePlugins();
    let visible = true;
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => null, isVisible: () => visible });
    await push.start();
    const built = buildPushText(
      { kind: 'approval', projectName: 'my-app', projectId: 'p1', approvalId: 'ap1', count: 1, firstLine: 'npm test' },
      { prefs: { firstLine: true }, device: { tier: 'full', approveFromNotifications: true }, computer: { id: 'c1', name: 'Home PC' } },
    );
    const content = Buffer.from(JSON.stringify(built.payload)).toString('base64');
    await f.handlers.get('message')({ instance: 'default', content, decrypted: true });
    assert.equal(f.local.scheduled.length, 1);
    const note = f.local.scheduled[0];
    assert.equal(note.channelId, 'plenum-approvals');
    assert.equal(note.title, built.payload.title);
    assert.equal(note.actionTypeId, 'plenum-deny-stop-approve');
    const type = f.local.types.find(t => t.id === note.actionTypeId);
    assert.deepEqual(type.actions.map(a => [a.id, a.requiresAuthentication]), [['deny', true], ['stop', true], ['approve', true]], 'every action asks for the device own authentication, as PlenumNotifier.kt does (M15)');
    assert.deepEqual(note.extra.routes, { deny: '/#deny=ap1', stop: '/#stop', approve: '/#approve=ap1' });
    // Behind the lock screen or in the background, the plugin service showed it already: not a second one here.
    visible = false;
    await f.handlers.get('message')({ instance: 'default', content, decrypted: true });
    assert.equal(f.local.scheduled.length, 1);
    // A limit goes to its own channel; an undecryptable message shows nothing.
    visible = true;
    const limit = buildPushText({ kind: 'limit', limitKind: 'spend' }, { prefs: {}, device: {}, computer: { id: 'c1', name: 'Home PC' } });
    await f.handlers.get('message')({ instance: 'default', content: Buffer.from(JSON.stringify(limit.payload)).toString('base64'), decrypted: true });
    assert.equal(f.local.scheduled.at(-1).channelId, 'plenum-limits');
    await f.handlers.get('message')({ instance: 'default', content: 'AAAA', decrypted: false });
    assert.equal(f.local.scheduled.length, 2);
  });

  test('a tap and each action run the route the desktop named; Approve carries the first line the notification showed', async () => {
    const { createAndroidPush, parseNotificationHash } = await import('../shell/push.js');
    const f = fakePlugins();
    const links = [];
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => null, onLink: link => links.push(link) });
    await push.start();
    const extra = { tap: '/#waiting=ap1', routes: { deny: '/#deny=ap1', stop: '/#stop', approve: '/#approve=ap1' }, line: 'npm test -- --watch=false' };
    const fire = actionId => f.local.listeners.get('localNotificationActionPerformed')({ actionId, notification: { extra } });
    fire('tap');
    fire('deny');
    fire('stop');
    fire('approve');
    assert.deepEqual(links, ['#waiting=ap1', '#deny=ap1', '#stop', `#approve=ap1&line=${encodeURIComponent('npm test -- --watch=false')}`]);
    assert.deepEqual(links.map(parseNotificationHash).map(l => l.kind), ['waiting', 'deny', 'stop', 'approve']);
    assert.equal(parseNotificationHash(links[3]).line, 'npm test -- --watch=false');
  });

  test('turning notifications off drops the subscription at the computer and ends the registration', async () => {
    const { createAndroidPush } = await import('../shell/push.js');
    const f = fakePlugins();
    const { posted, request } = requestRecorder();
    const push = createAndroidPush({ native: { UnifiedPush: f.up, LocalNotifications: f.localNotifications }, requestOf: () => request });
    assert.deepEqual(await push.disable(), { ok: true, reason: null });
    assert.deepEqual(posted.map(p => p.body), [{ subscription: null }]);
    assert.deepEqual(f.log.at(-1), ['unregister', { instance: 'default' }]);
  });
});

describe('dictation and the isolated preview through plenumShell (L18)', () => {
  test('plenumShell.dictation starts with the phone own switches, stops, and reports through the plugin events; the mic cap joins once the phone can listen', async () => {
    const { installShim } = await import('../shell/boot.js');
    const calls = [];
    const listeners = new Map();
    const Dictation = {
      async available() { return { available: true, onDevice: true, permission: 'granted', platform: 'android' }; },
      async start(options) { calls.push(['start', options]); },
      async stop() { calls.push(['stop']); },
      async cancel() { calls.push(['cancel']); },
      async addListener(event, fn) { listeners.set(event, fn); return { remove: async () => listeners.delete(event) }; },
    };
    const shown = [];
    const IsolatedPreview = { async show(arg) { shown.push(arg); } };
    const prefs = { dictationAllowService: false, dictationOnDevice: true };
    const core = { state: () => ({ prefs }), subscribe: () => () => {}, channel: null };
    const win = {
      location: new URL('https://localhost/index.html'),
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} },
      Response, ReadableStream, setTimeout, clearTimeout, navigator: {},
      plenumShellCore: core,
      fetch: async () => new Response(''),
    };
    // The plugins reach the shim through its options (C13), not through a global on the window.
    const { shell } = installShim({ win, doc: null, origFetch: win.fetch, core, plugins: { Dictation, IsolatedPreview } });
    const heard = [];
    shell.onCaps(list => heard.push(list));
    for (let i = 0; i < 40 && !shell.caps.includes('dictation'); i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(shell.caps.includes('dictation'), 'the composer shows its mic when this cap is there');
    assert.equal(heard.length, 1);
    assert.deepEqual(await shell.dictation.available(), { available: true, onDevice: true, permission: 'granted', platform: 'android' });
    assert.equal(await shell.dictation.start({ locale: 'en-US' }), true);
    assert.deepEqual(calls[0], ['start', { allowServer: false, locale: 'en-US' }], 'the service is off unless the person allowed it');
    // L18: the service switch is the person's alone. Turning the on-device switch off does not turn the service on.
    prefs.dictationAllowService = false;
    prefs.dictationOnDevice = false;
    await shell.dictation.start({ locale: 'en-US' });
    assert.equal(calls.at(-1)[1].allowServer, false, 'both switches off: the service stays off');
    prefs.dictationAllowService = true;
    await shell.dictation.start({ locale: 'en-US' });
    assert.equal(calls.at(-1)[1].allowServer, true, 'the person allowed the service');
    prefs.dictationAllowService = false;
    prefs.dictationOnDevice = true;
    const texts = [];
    const off = shell.dictation.on('final', e => texts.push(e.text));
    await new Promise(r => setTimeout(r, 0));
    listeners.get('final')({ text: 'hello there' });
    assert.deepEqual(texts, ['hello there']);
    off();
    await shell.dictation.stop();
    assert.deepEqual(calls.at(-1), ['stop']);
    assert.equal(shell.preview.available(), true);
    assert.equal(await shell.preview.show({ html: '<p>art</p>', title: 'Page' }), true);
    assert.deepEqual(shown, [{ html: '<p>art</p>', title: 'Page' }]);
  });

  test('without the plugins the shim says so and never throws: no mic cap, an unavailable preview, dictation false', async () => {
    const { installShim } = await import('../shell/boot.js');
    const win = { location: new URL('https://x.example/'), Response, ReadableStream, setTimeout, clearTimeout, navigator: {}, plenumShellCore: null, fetch: async () => new Response('') };
    const { shell } = installShim({ win, doc: null, origFetch: win.fetch });
    assert.equal(shell.caps.includes('dictation'), false);
    assert.equal(shell.preview.available(), false);
    assert.equal(await shell.preview.show({ html: '<p>x</p>' }), false);
    assert.equal(await shell.dictation.start(), false);
    assert.deepEqual(await shell.dictation.available(), { available: false, onDevice: false, permission: 'prompt' });
  });
});
