// mob-15: tests for scripts/build-mobile.mjs and for the pins in mobile/package.json and mobile/package-lock.json.
// Run sealed: node build/mobile/run.mjs --id mob-15 build.test.mjs (from the scratch copy's mobile/test).
// The build suites run on a fixture (mobile/test/fixtures/build), copied to a fresh temp folder for each test, so the
// project's own mobile/www and relay/public are never touched. Node only, no network, no CLI, nothing signed in.

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SHELL_ENTRY_SRC, SHELL_ENTRY_TAG, SHIM_SRC, SHIM_TAG, UI_SHELL_FILES, colourLiterals, cspViolations, insertShim, plan, readTree, rootBlock, stripCalls,
} from '../../scripts/build-mobile.mjs';
// Read through the namespace, so a build without these exports fails the tests that use them and not the whole file.
import * as buildModule from '../../scripts/build-mobile.mjs';

const { UI_PAGE_CSP, writeTree } = buildModule;

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '../../scripts/build-mobile.mjs');
const FIXTURE = path.join(here, 'fixtures', 'build');
const PROJECT_STYLE = path.resolve(here, '../../public/style.css');
const MOBILE_DIR = path.resolve(here, '..');
const PROJECT = path.resolve(here, '../..');
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${UI_PAGE_CSP}">`;

// esbuild comes from <root>/mobile/node_modules only (build-mobile.mjs loadEsbuild). A fixture has no install of its own, so each temp
// root links its mobile/node_modules to the install that holds the pinned esbuild: this project's, or, in a sealed copy (which has no
// mobile/node_modules), the harness's shared install one level above it. The pinned version is checked in a test below.
const INSTALL = [path.join(MOBILE_DIR, 'node_modules'), path.resolve(here, '../../../node_modules')]
  .find(dir => fs.existsSync(path.join(dir, 'esbuild', 'package.json')));
const PINNED_ESBUILD = JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'package.json'), 'utf8')).devDependencies.esbuild;

const temps = [];
after(() => {
  for (const dir of temps) removeTemp(dir);
});

// Removes a temp folder. The mobile/node_modules junction is unlinked first, so nothing under the shared install can be touched.
function removeTemp(dir) {
  const link = path.join(dir, 'mobile', 'node_modules');
  try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.rmdirSync(link);
  } catch {
    // Not linked.
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

function linkInstall(dir) {
  if (!INSTALL) throw new Error('no esbuild install found: run npm ci in mobile/ (or the harness shared install)');
  fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
  fs.symlinkSync(INSTALL, path.join(dir, 'mobile', 'node_modules'), 'junction');
}

// A fresh copy of the fixture project in the temp folder (TEMP is sealed to the run's scratch folder). link: false leaves out the install.
function freshRoot({ link = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mob15-build-'));
  temps.push(dir);
  fs.cpSync(FIXTURE, dir, { recursive: true });
  if (link) linkInstall(dir);
  return dir;
}

function cli(root, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function build(root) {
  const r = cli(root);
  assert.equal(r.code, 0, `build should pass, got ${r.code}: ${r.err}`);
  return r;
}

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const text = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

describe('colour and CSP rules', () => {
  test('colour literals outside var() fallbacks are reported; tokens, fallbacks and url() data are not', () => {
    const flagged = [
      ['body { color: #fff; }', true],
      ['.a { border: 1px solid red; }', true],
      ['.b { color: rgb(0 0 0 / 50%); }', true],
      ['.d { box-shadow: 0 0 0 1px light-dark(#000, #fff); }', true],
      ['.h { outline: 1px solid rgba(0,0,0,.1) }', true],
      ['a{color:var(--x);background:#fff}', true],
      ['.l { background: var(--x) url(a.png) #abc; }', true],
      ['.m { color: currentColor; border-color: Gold; }', true],
      ['.n { --token: #abcdef; }', true],
    ];
    const allowed = [
      'body { color: var(--text); }',
      'body { color: var(--text, #fff); }',
      '.k { color: var(--a, var(--b, #123)); }',
      ".a { background: url(\"data:image/svg+xml,%3Csvg fill='%23000'%3E\"); }",
      '.a:hover { color: var(--accent) }',
      '#add { color: var(--x) }',
      '@media (prefers-color-scheme: dark) { .c { color: var(--text); } }',
      '.e { color: transparent; }',
      '.f { font-family: "Red Hat Display", sans-serif; }',
      '.i { content: "#1"; }',
      '/* color: #fff; */ .j { color: var(--x); }',
      '.g { animation: fade 1s ease-in-out; }',
    ];
    for (const [css] of flagged) assert.ok(colourLiterals(css).length > 0, `should flag: ${css}`);
    for (const css of allowed) assert.deepEqual(colourLiterals(css), [], `should allow: ${css}`);
  });

  test('stripCalls keeps nested parentheses and quotes inside a call out of the scan', () => {
    assert.equal(stripCalls('a var(--x, (1)) b url("a)b") c', ['var', 'url']), 'a () b () c');
  });

  test('CSP check flags inline script, inline style, handlers, javascript: URLs and external scripts', () => {
    const bad = [
      ['<script>alert(1)</script>', 'inline <script>'],
      ['<script src="https://cdn.example/y.js"></script>', 'external <script src>'],
      ['<div onclick="x()"></div>', 'event-handler attribute'],
      ['<div style="color:red"></div>', 'style attribute'],
      ['<style>a{}</style>', '<style> element'],
      ['<a href="javascript:void(0)">x</a>', 'javascript: URL'],
    ];
    for (const [html, want] of bad) assert.ok(cspViolations(html).includes(want), `${want} in ${html}`);
    assert.deepEqual(cspViolations('<script src="shell.js" type="module"></script>'), []);
    assert.deepEqual(cspViolations('<script type="application/json" id="x">{}</script>'), []);
    assert.deepEqual(cspViolations('<p>one = two</p>'), []);
  });
});

describe('tokens and the UI snapshot', () => {
  test('rootBlock copies the :root block exactly, from the first ":root {" line to its closing brace', () => {
    const css = '/* head */\n:root {\n  --a: 1;\n}\n\n:root[data-theme="dark"] { color-scheme: dark; }\n';
    assert.equal(rootBlock(css), ':root {\n  --a: 1;\n}\n');
    assert.throws(() => rootBlock('body { color: var(--a); }'), /no ":root \{" block/);
  });

  test('the real public/style.css has a :root block that carries the surface tokens', () => {
    const block = rootBlock(fs.readFileSync(PROJECT_STYLE, 'utf8'));
    assert.ok(block.startsWith(':root {\n'), 'starts with :root {');
    assert.ok(block.endsWith('\n}\n'), 'ends with a closing brace line');
    assert.ok(block.includes('--bg: light-dark(#f6f6fb, #0a0a11);'), 'carries the surface tokens');
  });

  test('insertShim puts the CSP meta after <meta charset> and the two tags above the first <script>, and removing them restores the page', () => {
    const page = '<head>\n\t<meta charset="utf-8">\n\t<script src="/markdown.js" defer></script>\n\t<script src="/app.js" defer></script>\n</head>';
    const out = insertShim(page);
    assert.equal(out, `<head>\n\t<meta charset="utf-8">\n  ${CSP_META}\n\t${SHIM_TAG}\n\t${SHELL_ENTRY_TAG}\n\t<script src="/markdown.js" defer></script>\n\t<script src="/app.js" defer></script>\n</head>`);
    assert.equal(out.split(SHIM_TAG).length - 1, 1);
    assert.equal(out.split(SHELL_ENTRY_TAG).length - 1, 1);
    assert.equal(out.split(CSP_META).length - 1, 1);
    assert.equal(out.replace(`\n  ${CSP_META}`, '').replace(`\t${SHIM_TAG}\n\t${SHELL_ENTRY_TAG}\n`, ''), page);
    assert.equal(insertShim('<head><script src="/app.js"></script></head>').split(CSP_META).length - 1, 1, 'no charset: the CSP meta goes after <head>');
    assert.throws(() => insertShim('<head></head>'), /no <script src="\/app.js">/);
    assert.throws(() => insertShim(out), /already contains/);
  });

  test('UI_PAGE_CSP is the same string as lib/remote/ui-manifest.mjs, the one the desktop serves', async () => {
    const manifest = await import('../../lib/remote/ui-manifest.mjs');
    assert.equal(UI_PAGE_CSP, manifest.UI_PAGE_CSP);
    assert.match(UI_PAGE_CSP, /^default-src 'self'; script-src 'self'; style-src 'self';/);
  });

  test('the shim path and the shell entry path are the decided ones: /shell/<name> is always a bundle name', () => {
    assert.equal(SHIM_SRC, '/shell/boot.js');
    assert.equal(SHELL_ENTRY_SRC, '/shell/shell.js');
    assert.equal(SHELL_ENTRY_TAG, '<script type="module" src="/shell/shell.js"></script>');
    assert.deepEqual([...UI_SHELL_FILES], ['boot.js', 'shell.js', 'channel.worker.js', 'styles.css']);
  });
});

describe('build on the fixture', () => {
  test('writes the expected mobile/www tree, skipping ui-manifest.mjs with a warning', () => {
    const root = freshRoot();
    const r = build(root);
    assert.match(r.err, /skipped lib\/remote\/ui-manifest\.mjs \(not written yet\)/);
    const www = [...readTree(path.join(root, 'mobile', 'www')).keys()].sort();
    const expected = [
      'boot.js', 'channel.worker.js', 'demo/session.json', 'icons/app.svg', 'index.html', 'manifest.webmanifest',
      'remote/frames.mjs', 'remote/noise.mjs', 'screens.js', 'shell-tokens.css', 'shell.js', 'styles.css', 'sw.js', 'ui/app.js',
      'ui/index.html', 'ui/mark.svg', 'ui/markdown.js', 'ui/shell/boot.js', 'ui/shell/channel.worker.js', 'ui/shell/shell.js',
      'ui/shell/styles.css', 'ui/style.css', 'version.json',
    ];
    assert.deepEqual(www, expected.sort());
  });

  test('shell-tokens.css equals the :root block of public/style.css, byte for byte (S-08)', () => {
    const root = freshRoot();
    build(root);
    const block = rootBlock(text(root, 'public/style.css'));
    assert.equal(text(root, 'mobile/www/shell-tokens.css'), block);
  });

  test('relay/public is mobile/www without the ui/ snapshot, byte for byte', () => {
    const root = freshRoot();
    build(root);
    const www = readTree(path.join(root, 'mobile', 'www'));
    const relay = readTree(path.join(root, 'relay', 'public'));
    const expected = [...www.keys()].filter(k => !k.startsWith('ui/'));
    assert.deepEqual([...relay.keys()].sort(), expected.sort());
    for (const k of relay.keys()) assert.ok(relay.get(k).equals(www.get(k)), `same bytes: ${k}`);
  });

  test('ui/index.html is public/index.html plus the CSP meta after its charset, and the shim and shell entry lines above its first script', () => {
    const root = freshRoot();
    build(root);
    const original = text(root, 'public/index.html');
    const shimmed = text(root, 'mobile/www/ui/index.html');
    assert.equal(shimmed.split(SHIM_TAG).length - 1, 1);
    assert.equal(shimmed.split(SHELL_ENTRY_TAG).length - 1, 1);
    assert.equal(shimmed.split(CSP_META).length - 1, 1, 'the CSP meta once');
    assert.ok(shimmed.indexOf(CSP_META) < shimmed.indexOf(SHIM_TAG), 'the CSP meta before the shim');
    assert.ok(shimmed.indexOf(SHIM_TAG) < shimmed.indexOf(SHELL_ENTRY_TAG), 'the shim first');
    assert.ok(shimmed.indexOf(SHELL_ENTRY_TAG) < shimmed.indexOf('src="/markdown.js"'), 'then the shell entry, above the first script');
    assert.equal(shimmed.replace(`\n  ${CSP_META}`, '').replace(`  ${SHIM_TAG}\n  ${SHELL_ENTRY_TAG}\n`, ''), original);
    // The other snapshot files are byte copies of public/.
    assert.equal(sha(fs.readFileSync(path.join(root, 'mobile', 'www', 'ui', 'app.js'))), sha(fs.readFileSync(path.join(root, 'public', 'app.js'))));
  });

  test('ui/shell/ holds the four bundle files byte for byte, so the bundled snapshot is complete on its own', () => {
    const root = freshRoot();
    build(root);
    const www = readTree(path.join(root, 'mobile', 'www'));
    for (const name of UI_SHELL_FILES) {
      assert.ok(www.has(`ui/shell/${name}`), `ui/shell/${name} exists`);
      assert.ok(www.get(`ui/shell/${name}`).equals(www.get(name)), `ui/shell/${name} is the bundle's ${name}`);
    }
    // The snapshot's index names them as /shell/<name>, and nothing else under /shell/.
    const index = text(root, 'mobile/www/ui/index.html');
    const named = [...index.matchAll(/\/shell\/([A-Za-z0-9._-]+)/g)].map(m => m[1]);
    assert.deepEqual(named.sort(), ['boot.js', 'shell.js']);
  });

  test('version.json has the version from package.json, the protocol, and a hash that changes with the shell', () => {
    const root = freshRoot();
    build(root);
    const v1 = JSON.parse(text(root, 'mobile/www/version.json'));
    assert.equal(v1.name, 'plenum-shell');
    assert.equal(v1.version, '9.8.7');
    assert.equal(v1.protocol, '1.0');
    assert.match(v1.shellSha256, /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(root, 'mobile', 'shell', 'styles.css'), 'body { background: var(--bg); }\n');
    build(root);
    const v2 = JSON.parse(text(root, 'mobile/www/version.json'));
    assert.notEqual(v2.shellSha256, v1.shellSha256);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'plenum-build-fixture', version: '9.9.0' }));
    build(root);
    assert.equal(JSON.parse(text(root, 'mobile/www/version.json')).version, '9.9.0');
  });

  test('bundles: app.js pulls in its imports and the shared remote module, and the define is substituted', () => {
    const root = freshRoot();
    build(root);
    const shell = text(root, 'mobile/www/shell.js');
    assert.ok(shell.includes('hello from the fixture shell'), 'greet.js is bundled');
    assert.ok(shell.includes('"noise"'), 'lib/remote/noise.mjs is bundled through ./remote/');
    assert.ok(shell.includes('"9.8.7"'), '__PLENUM_SHELL_VERSION__ is replaced');
    assert.ok(!/^import\s/m.test(shell), 'bundle is self-contained: no import statements left');
    assert.ok(text(root, 'mobile/www/channel.worker.js').includes('"frames"'), 'worker bundles frames.mjs');
    for (const classic of ['boot.js', 'sw.js']) {
      assert.ok(!/^export\s/m.test(text(root, `mobile/www/${classic}`)), `${classic} is a classic script`);
    }
    assert.ok(text(root, 'mobile/www/sw.js').includes('"9.8.7"'), 'sw.js gets the version define');
  });

  test('the contact address is package.json bugs.email when it is a plain address, and empty otherwise', () => {
    const root = freshRoot();
    const entry = path.join(root, 'mobile', 'shell', 'app.js');
    fs.appendFileSync(entry, '\nwindow.fixtureContact = __PLENUM_CONTACT_EMAIL__;\n');
    const pkgPath = path.join(root, 'package.json');
    const base = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const contactOf = bugs => {
      fs.writeFileSync(pkgPath, JSON.stringify({ ...base, bugs }));
      build(root);
      const m = /window\.fixtureContact\s*=\s*("[^"]*")/.exec(text(root, 'mobile/www/shell.js'));
      assert.ok(m, 'the define is substituted, not left as an identifier');
      return JSON.parse(m[1]);
    };
    assert.equal(contactOf(undefined), '', 'none set: empty, the phone says so');
    assert.equal(contactOf({ email: 'reports@example.org' }), 'reports@example.org');
    assert.equal(contactOf({ email: '  reports@example.org  ' }), 'reports@example.org', 'trimmed');
    for (const bad of ['not an address', 'a@b', 'a@b.c, d@e.f', 'javascript:alert(1)//@x.y', 'a@b.c?cc=d@e.f', '<a@b.c>', 7, null]) {
      assert.equal(contactOf({ email: bad }), '', `refused: ${String(bad)}`);
    }
  });

  test('a second build gives identical bytes for every file (deterministic)', () => {
    const root = freshRoot();
    build(root);
    const first = readTree(path.join(root, 'mobile', 'www'));
    const firstRelay = readTree(path.join(root, 'relay', 'public'));
    build(root);
    const second = readTree(path.join(root, 'mobile', 'www'));
    assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
    for (const k of first.keys()) assert.ok(first.get(k).equals(second.get(k)), `identical: ${k}`);
    const secondRelay = readTree(path.join(root, 'relay', 'public'));
    for (const k of firstRelay.keys()) assert.ok(firstRelay.get(k).equals(secondRelay.get(k)), `identical relay: ${k}`);
  });

  test('a build replaces a stale placeholder in relay/public (the folder mirrors www without ui/)', () => {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, 'relay', 'public'), { recursive: true });
    fs.writeFileSync(path.join(root, 'relay', 'public', 'placeholder.html'), 'old');
    build(root);
    assert.equal(fs.existsSync(path.join(root, 'relay', 'public', 'placeholder.html')), false);
  });

  test('the ui/ snapshot holds only the files the UI page loads (isUiPath), not overlay.* or other public/ files', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'public', 'overlay.js'), 'window.overlay = 1;\n');
    fs.writeFileSync(path.join(root, 'public', 'notes.txt'), 'not a page file\n');
    build(root);
    const ui = [...readTree(path.join(root, 'mobile', 'www', 'ui')).keys()];
    assert.ok(!ui.includes('overlay.js'), 'overlay.js is left out');
    assert.ok(!ui.includes('notes.txt'), 'notes.txt is left out');
    assert.ok(ui.includes('app.js') && ui.includes('index.html') && ui.includes('style.css'), 'the page files are there');
  });
});

describe('the release gate: __PLENUM_DEV_BUILD__', () => {
  // A line that reads the define, appended to each bundle's entry; the build substitutes true or false for the identifier.
  const PROBE = '\nwindow.fixtureDev = __PLENUM_DEV_BUILD__;\n';

  test('the default build is a release build: shell.js, screens.js and boot.js carry __PLENUM_DEV_BUILD__ as false; --dev as true', () => {
    const root = freshRoot();
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'app.js'), PROBE);
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'screens', 'main.js'), PROBE);
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'boot.js'), PROBE);
    build(root);
    for (const name of ['shell.js', 'screens.js', 'boot.js']) {
      // A release build minifies the define's false to !1 (minifySyntax is on for release builds only).
      assert.match(text(root, `mobile/www/${name}`), /fixtureDev\s*=\s*(?:false|!1)/, `${name} is a release build`);
    }
    const dev = cli(root, ['--dev']);
    assert.equal(dev.code, 0, dev.err);
    for (const name of ['shell.js', 'screens.js', 'boot.js']) {
      assert.match(text(root, `mobile/www/${name}`), /fixtureDev\s*=\s*true/, `${name} is a dev build`);
    }
  });

  test('--check is always a release build: it passes against a release build even when given --dev, and a dev build is stale', () => {
    const root = freshRoot();
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'app.js'), PROBE);
    build(root);
    assert.equal(cli(root, ['--check', '--dev']).code, 0, 'a release tree is current for --check --dev');
    assert.equal(cli(root, ['--dev']).code, 0);
    const stale = cli(root, ['--check']);
    assert.equal(stale.code, 1, 'a dev tree is not what --check expects');
    assert.match(stale.err, /changed mobile\/www\/shell\.js/);
  });

  test('--dev never changes relay/public: the committed relay tree stays the release build while mobile/www gets the dev build', () => {
    const root = freshRoot();
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'app.js'), PROBE);
    build(root);
    const dev = cli(root, ['--dev']);
    assert.equal(dev.code, 0, dev.err);
    assert.match(text(root, 'mobile/www/shell.js'), /fixtureDev\s*=\s*true/, 'mobile/www is the dev build');
    assert.match(text(root, 'relay/public/shell.js'), /fixtureDev\s*=\s*(?:false|!1)/, 'relay/public is the release build');
  });

  test('the usage line lists --dev', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.match(r.stderr, /usage: node scripts\/build-mobile\.mjs \[--check\] \[--dev\] \[--root <dir>\]/);
  });
});

describe('esbuild and the phone packages come only from mobile/node_modules', () => {
  test('a build with no mobile/node_modules fails and never uses an esbuild from a parent folder', () => {
    const root = freshRoot({ link: false });
    const r = cli(root);
    assert.equal(r.code, 1, 'no install in mobile/node_modules');
    assert.match(r.err, /esbuild is not installed in mobile\/node_modules/);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www')), false);
  });

  test('a bare import of a package that mobile/node_modules does not have fails, even when a parent node_modules has it', () => {
    const root = freshRoot();
    const decoy = path.join(root, 'node_modules', 'decoy-pkg');
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'package.json'), '{"name":"decoy-pkg","version":"1.0.0","main":"index.js"}');
    fs.writeFileSync(path.join(decoy, 'index.js'), 'export const decoy = 1;\n');
    fs.writeFileSync(path.join(root, 'mobile', 'shell', 'decoy.js'), "import { decoy } from 'decoy-pkg';\nwindow.fixtureDecoy = decoy;\n");
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'app.js'), "\nimport './decoy.js';\n");
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /decoy-pkg is not installed in mobile\/node_modules/);
  });

  test('a package that mobile/node_modules has resolves for a shell file and for lib/remote', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'mobile', 'shell', 'pkg.js'), "import { sha256 } from '@noble/hashes/sha2.js';\nwindow.fixtureSha = typeof sha256;\n");
    fs.appendFileSync(path.join(root, 'mobile', 'shell', 'app.js'), "\nimport './pkg.js';\n");
    build(root);
    assert.match(text(root, 'mobile/www/shell.js'), /fixtureSha/);
  });

  test('the esbuild that the fixtures link to is the version mobile/package.json pins', () => {
    assert.ok(INSTALL, 'an install with esbuild was found');
    assert.equal(JSON.parse(fs.readFileSync(path.join(INSTALL, 'esbuild', 'package.json'), 'utf8')).version, PINNED_ESBUILD);
  });
});

describe('the real shell builds into a complete tree', () => {
  // plan() writes nothing: it builds the whole tree in memory from this project's own sources (the plugin packages come from mobile/node_modules
  // on CI and from the shared install in a sealed copy), so what the page and the manifest name can be checked against what the build emits.
  // A temp copy of the real sources (the shell, its plugins, public/, lib/remote and package.json), with the install linked, so the build
  // reads the same files as the project whether or not this folder has its own mobile/node_modules.
  let planned;
  before(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mob15-real-'));
    temps.push(root);
    for (const rel of ['package.json', path.join('mobile', 'shell'), path.join('mobile', 'plugins'), 'public', path.join('lib', 'remote')]) {
      fs.cpSync(path.join(PROJECT, rel), path.join(root, rel), { recursive: true });
    }
    linkInstall(root);
    planned = await plan(root);
  });

  test('a release bundle carries no self-test: selftest.js is not imported, so its code and its option names are left out', () => {
    const shell = planned.files.get('shell.js').toString('utf8');
    assert.doesNotMatch(shell, /runSelfTest/, 'no self-test function');
    assert.doesNotMatch(shell, /approvalWaitMs/, 'no self-test option names');
  });

  test('the build emits screens.js and every file index.html names, with no entry skipped', () => {
    const files = planned.files;
    assert.deepEqual(planned.warnings.filter(w => w.startsWith('skipped mobile/shell/')), [], 'no shell entry is missing');
    assert.ok(files.has('screens.js'), 'index.html loads screens.js, so the build must emit it (the page was blank without it)');
    const index = files.get('index.html').toString('utf8');
    const named = [...index.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1]).filter(u => !/^[a-z]+:|^\//.test(u));
    assert.ok(named.includes('screens.js') && named.includes('shell.js'));
    for (const url of named) assert.ok(files.has(url), `index.html names ${url}, which the build must emit`);
  });

  test('the manifest names only files the build emits', () => {
    const manifest = JSON.parse(planned.files.get('manifest.webmanifest').toString('utf8'));
    const urls = [manifest.start_url, ...(manifest.icons ?? []).map(i => i.src)].filter(u => typeof u === 'string' && !/^[a-z]+:/.test(u));
    for (const url of urls) {
      const clean = url.replace(/^\.?\//, '').replace(/[?#].*$/, '');
      if (clean === '' || clean === '.') continue;
      assert.ok(planned.files.has(clean), `the manifest names ${url}`);
    }
  });

  test('ui/shell/ holds the bundle files, and the UI snapshot index names them with the entry tag', () => {
    for (const name of UI_SHELL_FILES) assert.ok(planned.files.get(`ui/shell/${name}`)?.equals(planned.files.get(name)), `ui/shell/${name}`);
    const index = planned.files.get('ui/index.html').toString('utf8');
    assert.ok(index.includes(SHIM_TAG) && index.includes(SHELL_ENTRY_TAG));
  });

  test('the shell bundle registers the native plugins by name, and keeps the web scanner out', () => {
    const shell = planned.files.get('shell.js').toString('utf8');
    for (const name of ['App', 'Haptics', 'Browser', 'Share', 'Filesystem', 'TextZoom', 'Network', 'LocalNotifications', 'CapacitorBarcodeScanner', 'PlenumPrivacy',
      'SecureStorage', 'BiometricAuthNative', 'UnifiedPush', 'Dictation', 'IsolatedPreview']) {
      assert.ok(shell.includes(`"${name}"`), `the shell bundle registers ${name}`);
    }
    assert.ok(!/html5-qrcode|Html5Qrcode/.test(shell), "the barcode package's web scanner is not bundled");
    assert.ok(!/^import\s/m.test(shell), 'self-contained');
  });

  test('the shell sources do not log (a bundle carries library code, so the own files are read), and the page has no style attribute', () => {
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(path.join(PROJECT, 'mobile', 'shell')).filter(p => p.endsWith('.js'))) {
      const code = fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /console\.(log|debug|info|warn|trace)\(/, `${path.relative(PROJECT, file)} does not log`);
    }
    assert.doesNotMatch(planned.files.get('index.html').toString('utf8'), /<[^>]*\sstyle\s*=/);
  });
});

describe('--check', () => {
  test('exits 1 when mobile/www does not exist, 0 after a build, 1 after a change or an extra file, 0 after a rebuild', () => {
    const root = freshRoot();
    assert.equal(cli(root, ['--check']).code, 1, 'nothing built yet');
    build(root);
    assert.equal(cli(root, ['--check']).code, 0, 'current after a build');
    fs.appendFileSync(path.join(root, 'mobile', 'www', 'styles.css'), '\n/* edited */\n');
    const stale = cli(root, ['--check']);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /changed mobile\/www\/styles\.css/);
    build(root);
    assert.equal(cli(root, ['--check']).code, 0, 'current after a rebuild');
    fs.writeFileSync(path.join(root, 'relay', 'public', 'extra.txt'), 'x');
    const extra = cli(root, ['--check']);
    assert.equal(extra.code, 1);
    assert.match(extra.err, /extra relay\/public\/extra\.txt/);
  });

  test('a change to public/style.css makes the build stale: the ui/ copy always, shell-tokens.css when the :root block changes', () => {
    const root = freshRoot();
    build(root);
    const stylePath = path.join(root, 'public', 'style.css');
    fs.appendFileSync(stylePath, '\n/* note */\n');
    const noted = cli(root, ['--check']);
    assert.equal(noted.code, 1, 'ui/style.css is a byte copy of public/style.css');
    assert.match(noted.err, /changed mobile\/www\/ui\/style\.css/);
    assert.doesNotMatch(noted.err, /shell-tokens\.css/, 'the :root block did not change');
    build(root);
    fs.writeFileSync(stylePath, fs.readFileSync(stylePath, 'utf8').replace('--accent: light-dark(#5a48dd, #a9b2ff);', '--accent: light-dark(#111111, #eeeeee);'));
    const stale = cli(root, ['--check']);
    assert.equal(stale.code, 1);
    assert.match(stale.err, /changed mobile\/www\/shell-tokens\.css/);
  });
});

describe('failures stop the build and write nothing', () => {
  test('a colour literal in shell CSS fails the build', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'mobile', 'shell', 'styles.css'), 'body { color: #fff; }\n');
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /colour literals outside shell-tokens\.css/);
    assert.match(r.err, /mobile\/shell\/styles\.css: color: #fff/);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www')), false);
    assert.equal(fs.existsSync(path.join(root, 'relay', 'public')), false);
  });

  test('an inline script in mobile/shell/index.html fails the build (strict CSP)', () => {
    const root = freshRoot();
    const p = path.join(root, 'mobile', 'shell', 'index.html');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('</body>', '<script>window.x = 1;</script>\n</body>'));
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /breaks the strict CSP: inline <script>/);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www')), false);
  });

  test('a syntax error in a shell entry fails the build and names the file', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'mobile', 'shell', 'greet.js'), 'export function greet( {\n');
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /esbuild failed for mobile\/shell\/app\.js/);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www')), false);
  });

  test('a public/index.html without an app.js script tag fails the build', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html><html><head></head></html>\n');
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /no <script src="\/app\.js">/);
  });

  test('a missing :root block in public/style.css fails the build', () => {
    const root = freshRoot();
    fs.writeFileSync(path.join(root, 'public', 'style.css'), 'body { margin: 0; }\n');
    const r = cli(root);
    assert.equal(r.code, 1);
    assert.match(r.err, /no ":root \{" block/);
  });
});

describe('entries that are not written yet', () => {
  test('missing shell entries are skipped with a warning and the build still passes', () => {
    const root = freshRoot();
    fs.rmSync(path.join(root, 'mobile', 'shell', 'sw.js'));
    fs.rmSync(path.join(root, 'mobile', 'shell', 'icons'), { recursive: true });
    const r = build(root);
    assert.match(r.err, /skipped mobile\/shell\/sw\.js \(not written yet\)/);
    assert.match(r.err, /skipped mobile\/shell\/icons \(not written yet\)/);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www', 'sw.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'mobile', 'www', 'icons')), false);
    assert.equal(cli(root, ['--check']).code, 0);
  });

  test('with no shell at all the UI snapshot, tokens, remote copies and version still build', () => {
    const root = freshRoot();
    fs.rmSync(path.join(root, 'mobile', 'shell'), { recursive: true });
    const r = build(root);
    assert.match(r.err, /skipped mobile\/shell\/index\.html/);
    const www = [...readTree(path.join(root, 'mobile', 'www')).keys()];
    assert.ok(www.includes('shell-tokens.css') && www.includes('version.json') && www.includes('ui/index.html'));
    assert.ok(www.includes('remote/noise.mjs') && www.includes('remote/frames.mjs'));
    assert.equal(www.includes('shell.js'), false);
  });
});

describe('command line', () => {
  test('--root needs a folder and unknown options exit 2', () => {
    const root = freshRoot();
    assert.equal(cli(root, ['--root']).code, 2);
    const bad = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown option --nope/);
  });
});

describe('writing the output', () => {
  test('writeTree leaves the old tree when a write fails, and writes nothing into the folder', () => {
    const root = freshRoot();
    const dir = path.join(root, 'out');
    writeTree(dir, new Map([['old.txt', Buffer.from('old')]]));
    let writes = 0;
    const fsImpl = {
      ...fs,
      writeFileSync(file, buf, opts) {
        writes += 1;
        if (writes === 3) throw new Error('disk full');
        return fs.writeFileSync(file, buf, opts);
      },
    };
    const files = new Map([['a.txt', Buffer.from('a')], ['b.txt', Buffer.from('b')], ['c.txt', Buffer.from('c')], ['d.txt', Buffer.from('d')]]);
    assert.throws(() => writeTree(dir, files, { fsImpl }), /disk full/);
    assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old', 'the old tree is still there');
    assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false, 'no partial new tree');
    assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('out.tmp-')), [], 'the temporary folder is removed');
  });

  test('writeTree replaces the tree with the new files on success, with no temporary folder left', () => {
    const root = freshRoot();
    const dir = path.join(root, 'out');
    writeTree(dir, new Map([['old.txt', Buffer.from('old')]]));
    writeTree(dir, new Map([['sub/new.txt', Buffer.from('new')]]));
    assert.deepEqual([...readTree(dir).keys()], ['sub/new.txt']);
    assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('out.tmp-') || n.startsWith('out.old-')), []);
  });

  test('F8: a live tree that cannot be moved (a file held open on Windows) stays whole, and nothing is deleted', () => {
    const root = freshRoot();
    const dir = path.join(root, 'out');
    writeTree(dir, new Map([['old.txt', Buffer.from('old')]]));
    const locked = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (from === dir) throw locked;
        return fs.renameSync(from, to);
      },
    };
    assert.throws(() => writeTree(dir, new Map([['new.txt', Buffer.from('new')]]), { fsImpl }), /EPERM/);
    assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old', 'the live tree is untouched');
    assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('out.tmp-') || n.startsWith('out.old-')), [], 'no temporary or old folder is left');
  });

  test('F8: when the new tree cannot move in, the old one is put back', () => {
    const root = freshRoot();
    const dir = path.join(root, 'out');
    writeTree(dir, new Map([['old.txt', Buffer.from('old')]]));
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (to === dir && from.includes('.tmp-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        return fs.renameSync(from, to);
      },
    };
    assert.throws(() => writeTree(dir, new Map([['new.txt', Buffer.from('new')]]), { fsImpl }), /EBUSY/);
    assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old', 'the old tree is back in place');
    assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('out.tmp-') || n.startsWith('out.old-')), []);
  });
});

describe('mobile/package.json and mobile/package-lock.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(MOBILE_DIR, 'package-lock.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  test('the decided exact pins are in place', () => {
    const exact = {
      '@capacitor/core': '8.5.3', '@capacitor/cli': '8.5.3', '@capacitor/android': '8.5.3', '@capacitor/ios': '8.5.3',
      '@capacitor/local-notifications': '8.3.1', '@capacitor/barcode-scanner': '3.1.3', '@capacitor/text-zoom': '8.0.1',
      '@noble/curves': '2.4.0', '@noble/ciphers': '2.4.0', '@noble/hashes': '2.4.0', jsqr: '1.4.0', esbuild: '0.28.2',
      '@aparajita/capacitor-secure-storage': '8.0.1', '@aparajita/capacitor-biometric-auth': '10.0.0',
    };
    for (const [name, version] of Object.entries(exact)) assert.equal(deps[name], version, name);
    for (const name of ['@capacitor/app', '@capacitor/browser', '@capacitor/filesystem', '@capacitor/haptics', '@capacitor/network', '@capacitor/share']) {
      assert.equal(deps[name], '^8', name);
    }
    assert.equal(pkg.devDependencies.esbuild, '0.28.2', 'esbuild is a dev dependency');
    assert.equal(deps['@capacitor/push-notifications'], undefined, 'push is iOS phase 3 only, not in phase 1 or 2');
  });

  test('scripts run the build, the dev build, the check and the sealed suite', () => {
    assert.equal(pkg.scripts.build, 'node ../scripts/build-mobile.mjs');
    assert.equal(pkg.scripts['build:dev'], 'node ../scripts/build-mobile.mjs --dev');
    assert.equal(pkg.scripts.check, 'node ../scripts/build-mobile.mjs --check');
    assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
    assert.ok(pkg.scripts.sync.startsWith('cap sync'));
    assert.ok(pkg.scripts.selftest, 'selftest script exists');
  });

  test('the lock file resolves each pinned package at the pinned version and matches the root entry', () => {
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages[''].name, 'plenum-mobile');
    for (const [name, spec] of Object.entries(deps)) {
      assert.equal(lock.packages[''].dependencies?.[name] ?? lock.packages[''].devDependencies?.[name], spec, `root ${name}`);
      const entry = lock.packages[`node_modules/${name}`];
      if (spec.startsWith('file:')) {
        // A local plugin (wave 105, mob-13) is a link to its folder: npm writes link: true and resolved: the folder, and the folder's own
        // entry carries the name and the version. This expectation predates the file: specs, so it reads the link instead of a version.
        assert.equal(entry?.link, true, `locked link: ${name}`);
        assert.equal(entry.resolved, spec.slice('file:'.length), `${name} links to ${spec}`);
        assert.equal(lock.packages[entry.resolved]?.name, name, `${name} is the package in ${entry.resolved}`);
        assert.ok(lock.packages[entry.resolved].version, `${name} has a version`);
        continue;
      }
      assert.ok(entry && entry.version, `locked: ${name}`);
      if (/^\d/.test(spec)) assert.equal(entry.version, spec, `${name} resolves to ${spec}`);
      else assert.ok(entry.version.startsWith('8.'), `${name} is in the 8.x line (${entry.version})`);
    }
  });

  test('mobile/.gitignore keeps the built shell and the local dependencies out of git', () => {
    const ignore = fs.readFileSync(path.join(MOBILE_DIR, '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('www/'));
    assert.ok(ignore.includes('node_modules/'));
  });

  test('mobile/.gitignore lists *.jks, *.keystore, *key*.properties, keystore.properties and google-services.json', () => {
    const ignore = fs.readFileSync(path.join(MOBILE_DIR, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const pattern of ['*.jks', '*.keystore', '*key*.properties', 'keystore.properties', 'android/app/google-services.json']) {
      assert.ok(ignore.includes(pattern), pattern);
    }
    const android = fs.readFileSync(path.join(MOBILE_DIR, 'android', '.gitignore'), 'utf8').split(/\r?\n/);
    assert.ok(android.includes('*.jks') && android.includes('*.keystore'), 'the Android ignore lines are not commented out');
  });

  test('the Gradle wrapper pins the distribution checksum and validates the URL', () => {
    const props = fs.readFileSync(path.join(MOBILE_DIR, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    assert.match(props, /^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.3-all\.zip$/m);
    assert.match(props, /^distributionSha256Sum=[0-9a-f]{64}$/m, 'a 64-hex SHA-256 of gradle-8.14.3-all.zip');
    assert.match(props, /^validateDistributionUrl=true$/m);
  });
});

// mobile/.github/workflows/mobile.yml, checked as text: every job and step is found by its indentation, so no YAML parser is needed.
describe('.github/workflows/mobile.yml, phone-tests.yml and release.yml', () => {
  const WORKFLOW = path.join(PROJECT, '.github', 'workflows', 'mobile.yml');
  const PHONE_TESTS = path.join(PROJECT, '.github', 'workflows', 'phone-tests.yml');
  const RELEASE = path.join(PROJECT, '.github', 'workflows', 'release.yml');
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const phoneYml = fs.readFileSync(PHONE_TESTS, 'utf8');
  const releaseYml = fs.readFileSync(RELEASE, 'utf8');
  const lines = yml.split('\n');
  const phoneLines = phoneYml.split('\n');
  // The jobs: each top-level job under jobs: with its lines. The test job is phone-tests.yml's (mobile.yml only calls it).
  const jobsOf = all => {
    const found = {};
    let current = null;
    for (const line of all.slice(all.indexOf('jobs:') + 1)) {
      const head = /^ {2}([a-z0-9-]+):$/.exec(line);
      if (head) {
        current = head[1];
        found[current] = [];
      } else if (current) {
        found[current].push(line);
      }
    }
    return found;
  };
  const jobs = { ...jobsOf(lines), ...jobsOf(phoneLines) };
  const jobText = id => jobs[id].join('\n');
  // The steps of one job: each starts at a line "      - ".
  const stepsOf = id => {
    const steps = [];
    for (const line of jobs[id]) {
      if (/^ {6}- /.test(line)) steps.push([line]);
      else if (steps.length) steps[steps.length - 1].push(line);
    }
    return steps.map(s => s.join('\n'));
  };
  const stepNamed = (id, name) => stepsOf(id).find(s => s.includes(`- name: ${name}\n`) || s.startsWith(`      - name: ${name}\n`));

  test('the jobs are there, and every uses: is pinned to a 40-hex commit with a version comment (the local phone-tests.yml call is not an action)', () => {
    assert.deepEqual(Object.keys(jobs).sort(), ['android-debug', 'android-emulator', 'apple-secrets', 'ios-archive', 'ios-sim', 'test']);
    const refs = [...(yml + '\n' + phoneYml).matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].filter(([, ref]) => !ref.startsWith('./'));
    assert.ok(refs.length >= 15, `found ${refs.length} uses lines`);
    for (const [, ref, rest] of refs) {
      assert.match(ref, /^[^@\s]+@[0-9a-f]{40}$/, `${ref} is pinned to a commit`);
      assert.match(rest, /^\s+# v\d/, `${ref} has a version comment`);
    }
  });

  test('every actions/checkout has persist-credentials: false', () => {
    let count = 0;
    for (const id of Object.keys(jobs)) {
      for (const step of stepsOf(id)) {
        if (!/uses: actions\/checkout@/.test(step)) continue;
        count += 1;
        assert.match(step, /with:\n\s+persist-credentials: false/, `${id}: checkout keeps no credentials`);
      }
    }
    assert.equal(count, 5, 'five checkouts');
  });

  test('no job in the phone workflows has write access, and the Apple archive runs in the release-signing environment with read access', () => {
    for (const id of Object.keys(jobs)) {
      assert.doesNotMatch(jobText(id), /^ {4}permissions:\n {6}contents: write$/m, `${id}: no write access`);
    }
    assert.match(jobText('ios-archive'), /^ {4}environment: release-signing$/m, 'ios-archive runs in the release-signing environment (the one release.yml uses)');
    assert.match(jobText('ios-archive'), /^ {4}permissions:\n {6}contents: read$/m, 'ios-archive reads only');
  });

  test('a tag signs nothing in mobile.yml: no tag clause, no Android release build, and the Apple jobs run only on a manual TestFlight run', () => {
    assert.doesNotMatch(yml, /refs\/tags\/v/, 'no tag clause');
    assert.doesNotMatch(yml, /assembleRelease|bundleRelease/, 'no Android release build');
    for (const id of ['apple-secrets', 'ios-archive']) {
      assert.match(jobText(id), /^ {4}if: .*github\.event_name == 'workflow_dispatch' && inputs\.upload_testflight/m, `${id} runs only on a manual TestFlight run`);
    }
    assert.match(jobText('ios-archive'), /^ {4}needs: \[apple-secrets, test\]$/m, 'ios-archive waits for the test job');
    assert.match(releaseYml, /^  mobile-android:[\s\S]*?environment: release-signing/m, 'release.yml signs Android in release-signing');
    assert.match(releaseYml, /^  mobile-ios:[\s\S]*?environment: release-signing/m, 'release.yml signs iOS in release-signing');
  });

  test('only release.yml signs a tag, and its fastlane pin is the same as mobile.yml', () => {
    const pin = text => /gem install fastlane -v (\d+\.\d+\.\d+) -N/.exec(text)?.[1];
    assert.ok(pin(yml), 'mobile.yml pins fastlane');
    assert.equal(pin(yml), pin(releaseYml), 'the two fastlane pins are equal');
  });

  test('the phone tests run before a tag drafts a release: phone-tests.yml is reusable, release.yml calls it, and prepare waits for it', () => {
    assert.match(phoneYml, /^on:\n  workflow_call:$/m, 'phone-tests.yml is reusable');
    assert.match(yml, /^ {4}uses: \.\/\.github\/workflows\/phone-tests\.yml$/m, 'mobile.yml calls it');
    assert.match(releaseYml, /^  suites:\n    name: Phone tests\n    uses: \.\/\.github\/workflows\/phone-tests\.yml$/m, 'release.yml calls it');
    assert.match(releaseYml, /^  prepare:\n    name: Create the draft release\n    needs: suites$/m, 'the draft waits for the suites');
  });

  test('the test job checks the committed relay/public after the build: a git diff and an untracked-file check', () => {
    assert.ok(phoneLines.includes('          git diff --exit-code -- relay/public'), 'the diff line');
    assert.ok(phoneLines.includes('          test -z "$(git status --porcelain -- relay/public)"'), 'the untracked-file line');
    const step = stepNamed('test', 'Build the phone shell and check its output');
    assert.ok(step.indexOf('node scripts/build-mobile.mjs\n') < step.indexOf('git diff --exit-code'), 'after the build');
  });

  test('the device jobs build the dev shell, and the Apple archive builds the release shell', () => {
    assert.match(stepNamed('android-debug', 'Build the shell and sync the Android project'), /npm run build:dev/);
    assert.match(jobText('ios-sim'), /npm run build:dev/);
    assert.match(jobText('ios-archive'), /npm run build\n/);
    assert.doesNotMatch(jobText('ios-archive'), /npm run build:dev/);
  });

  test('the pairing driver appends the ci-confirm marker to the native link it writes for both smoke jobs', () => {
    assert.ok((yml + phoneYml).includes("const link = (PAIR_HOST ? rewriteHost(native, PAIR_HOST) : native) + '&ci-confirm=1';"));
  });

  test('the cleanup steps of the Apple archive are if: always()', () => {
    assert.match(stepNamed('ios-archive', 'Remove the TestFlight key file'), /if: always\(\)\n/);
    assert.match(stepNamed('ios-archive', 'Remove the App Store Connect key'), /if: always\(\)/);
    assert.match(stepNamed('ios-archive', 'Remove the TestFlight key file'), /rm -f "\$RUNNER_TEMP\/asc-key\.json"/);
  });

  test('a token redaction step runs before each server.log upload, and fastlane is pinned', () => {
    for (const id of ['android-emulator', 'ios-sim']) {
      const steps = stepsOf(id);
      const up = steps.findIndex(s => /server\.log/.test(s) && /upload-artifact/.test(s));
      assert.ok(up > 0, `${id} uploads the server log`);
      assert.match(steps[up - 1], /sed -i -E 's\/\(#token=\)\[0-9A-Fa-f\]\+\/\\1\[redacted\]\/g'/, `${id}: redaction before the upload`);
      assert.match(steps[up - 1], /if: failure\(\)/);
    }
    assert.match(jobText('ios-archive'), /gem install fastlane -v \d+\.\d+\.\d+ -N/);
    assert.doesNotMatch(jobText('ios-archive'), /gem install fastlane -N/);
  });

  test('the Gradle wrapper is validated in the Android debug job', () => {
    assert.ok(stepsOf('android-debug').some(s => /uses: gradle\/actions\/wrapper-validation@[0-9a-f]{40}/.test(s)), 'android-debug validates the wrapper');
  });

  test('the iOS archives sign with the APPLE_TEAM_ID variable and set the build number and version, in mobile.yml and release.yml', () => {
    for (const [name, text] of [['mobile.yml', yml], ['release.yml', releaseYml]]) {
      assert.match(text, /APPLE_TEAM_ID: \$\{\{ vars\.APPLE_TEAM_ID \}\}/, `${name} reads the team variable`);
      assert.match(text, /echo "::error::Set the APPLE_TEAM_ID repository variable\."/, `${name} stops without it`);
      assert.match(text, /IOS_BUILD: \$\{\{ github\.run_number \}\}/, `${name} sets the build number`);
      assert.match(text, /DEVELOPMENT_TEAM="\$APPLE_TEAM_ID" CURRENT_PROJECT_VERSION="\$IOS_BUILD" MARKETING_VERSION="\$IOS_VERSION"/, `${name} passes the team, build and version to xcodebuild`);
      assert.match(text, /<<PLIST\n/, `${name} expands the export options`);
      assert.doesNotMatch(text, /<<'PLIST'/, `${name} does not quote the export options`);
      assert.match(text, /<key>teamID<\/key>\n\s+<string>\$APPLE_TEAM_ID<\/string>/, `${name} exports with the team`);
    }
    assert.match(yml, /APP_STORE_CONNECT_API_KEY_KEY_ID: \$\{\{ secrets\.APPLE_API_KEY_ID \}\}/, 'the match step gets the App Store Connect key');
    assert.match(yml, /APP_STORE_CONNECT_API_KEY_KEY_FILEPATH: \$\{\{ runner\.temp \}\}\/AuthKey\.p8/, 'the match step gets the key file');
  });
});
