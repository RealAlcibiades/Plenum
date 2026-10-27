// Checks that need no runtime: the pins the Deploy button and CI depend on, the
// Wrangler config the button deploys unchanged, the licence grant, the shell's
// CSP rules, the no-logging rule and the limits the spec names.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE, LIMITS } from '../src/limits.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

// JSONC with line comments only, as wrangler.jsonc is written.
const parseJsonc = (text) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));

test('package.json pins miniflare and wrangler exactly and the lockfile agrees', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.devDependencies.miniflare, '4.20260730.0');
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.devDependencies.wrangler, '4.148.0');
  assert.equal(pkg.dependencies, undefined, 'the relay has no runtime dependencies');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/miniflare'].version, '4.20260730.0');
  assert.equal(lock.packages['node_modules/wrangler'].version, pkg.devDependencies.wrangler);
});

test('wrangler.jsonc carries no secrets, accounts or routes and the Deploy button can deploy it', () => {
  const config = parseJsonc(read('wrangler.jsonc'));
  assert.equal(config.name, 'plenum-relay');
  assert.equal(config.main, 'src/index.mjs');
  assert.equal(config.compatibility_date, '2026-10-01');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.directory, './public');
  assert.equal(config.assets.run_worker_first, true);
  assert.deepEqual(config.durable_objects.bindings, [{ name: 'ROOM', class_name: 'Room' }]);
  assert.deepEqual(config.migrations, [{ tag: 'v1', new_sqlite_classes: ['Room'] }]);
  assert.equal(config.observability.enabled, false);
  for (const key of ['vars', 'secrets', 'account_id', 'routes', 'env', 'kv_namespaces']) {
    assert.equal(config[key], undefined, `wrangler.jsonc must not set ${key}`);
  }
});

test('the licence grant is the one the spec names and the holder is a placeholder', () => {
  const licence = read('LICENSE-RELAY.txt');
  assert.match(
    licence,
    /You may deploy unmodified copies of the files in this folder to your own Cloudflare account, and run them, for use with Plenum\. All other rights reserved\./,
  );
  assert.match(licence, /\[LICENSOR NAME\]/);
});

// Every file below public/, as paths relative to it. The built shell has subfolders (icons/, demo/, remote/).
function publicFiles(dir = '') {
  return readdirSync(new URL(`public/${dir}`, ROOT)).flatMap((name) => {
    const rel = `${dir}${name}`;
    return statSync(new URL(`public/${rel}`, ROOT)).isDirectory() ? publicFiles(`${rel}/`) : [rel];
  });
}

test('the shell pages have no inline script or style and no style attribute; the shell scripts do not log', () => {
  for (const file of publicFiles()) {
    const text = read(`public/${file}`);
    if (/\.html$/.test(file)) {
      // Markup only: a script file may say `const style = ...`, which is not an attribute.
      assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${file} has an inline script`);
      assert.doesNotMatch(text, /<style[\s>]/i, `${file} has a style element`);
      assert.doesNotMatch(text, /<[^>]*\sstyle\s*=/i, `${file} has a style attribute`);
    } else if (/\.js$/.test(file)) {
      // The bundled shell carries library code that warns or reports a start failure; what the relay and the shell never do is log.
      assert.doesNotMatch(text, /console\.(log|debug|info|trace)\(/, `${file} must not log`);
    }
  }
});

test('nothing in the relay logs: no console calls in the Worker or the room', () => {
  for (const file of ['src/index.mjs', 'src/room.mjs']) {
    assert.doesNotMatch(read(file), /console\./, `${file} must not log`);
  }
});

test('the room limits and close codes match the spec', () => {
  assert.equal(LIMITS.maxWireFrameBytes, 65540);
  assert.equal(LIMITS.maxPhoneFrameBytes, 65536);
  assert.equal(LIMITS.maxPhonesPerRoom, 8);
  assert.equal(LIMITS.phoneMessagesPerSecond, 200);
  assert.equal(LIMITS.phoneBytesPerSecond, 2 * 1024 * 1024);
  assert.equal(LIMITS.idleMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(CLOSE.hostOffline, 4001);
  assert.equal(CLOSE.policy, 1008);
  assert.equal(CLOSE.tooBig, 1009);
});

test('the README gives the deploy button URL and how to run the tests', () => {
  const readme = read('README.md');
  assert.ok(
    readme.includes(
      'https://deploy.workers.cloudflare.com/?url=https://github.com/RealAlcibiades/Plenum/tree/main/relay',
    ),
    'the README must carry the Deploy to Cloudflare URL',
  );
  assert.match(readme, /node --test "test\/\*\.test\.mjs"/);
});
