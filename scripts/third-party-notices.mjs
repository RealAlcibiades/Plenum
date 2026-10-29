#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.txt at the project root. Every runtime package in package-lock.json and in mobile/package-lock.json
// (the phone packages that ship in the app's mobile/www; a dependency missing from the phone lock is an error)
// (the packages electron-builder ships: those without "dev": true) is listed with its licence,
// its source and the full text of its licence files, copied from node_modules. Fixed entries cover
// what the lock file cannot see: Electron (a dev dependency that ships in the app), Chromium (its
// text is LICENSES.chromium.html beside the app), partial-json-parser (vendored inside
// @anthropic-ai/sdk), elevate.exe (electron-builder's NSIS tools, Windows only) and any package
// whose npm package ships no licence file (standardwebhooks, lazy-val). A lock package whose folder build.files leaves out of
// the app whole ('!node_modules/<folder>/**', such as the optional @napi-rs canvas packages) is not shipped, so it is skipped:
// neither listed nor checked.
//
// Usage: node scripts/third-party-notices.mjs [--check]
//   (no flag)  writes THIRD-PARTY-NOTICES.txt when there are no errors
//   --check    writes nothing; exits 1 on an error or when the file on disk is out of date
// Environment: PLENUM_RELEASE=1 turns unconfirmed entries and dependencies missing from the lock
// file into errors. Without it they are printed as warnings. Licence errors are always errors.
//
// Called by scripts/build-legal.mjs (npm run legal, which every pack and dist script runs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'THIRD-PARTY-NOTICES.txt';

// Licences a shipped package may carry. Anything else, or no licence at all, is an error.
// Python-2.0 is the Python Software Foundation licence that argparse (a js-yaml dependency of electron-updater) carries. It is
// permissive: it asks only that the licence text and the copyright notices stay with the software, which the notices file does.
export const ALLOWED_LICENCES = Object.freeze([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', '0BSD', 'CC0-1.0',
  'BlueOak-1.0.0', 'Zlib', 'Python-2.0',
]);

// Licence file names inside a package folder (any depth, vendored copies included).
const LICENCE_FILE = /^(LICEN[CS]E|COPYING|NOTICE)/i;

// The Apache License 2.0 text, the same file as node_modules/pdfjs-dist/LICENSE (checked by sha256 against node-gyp's
// LICENSE.APACHE). The Android libraries below are Apache-2.0; the text lives here so the notices do not need another package.
const APACHE_2_0_TEXT = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS
`;

// qrcode-generator declares MIT and its author as Kazuhiko Arase, and ships no licence file. The text is the upstream MIT licence
// of github.com/kazuhikoarase/qrcode-generator (its LICENSE file, checked in October 2026), kept here because the package ships none.
const MIT_QRCODE_GENERATOR_TEXT = `MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// Lock-file keys whose text comes from a fixed source instead of (or because of) the scan.
// textFrom: a path under the project (read at build time). textFile: a file under legal/third-party/.
// status 'unconfirmed' marks a licence that the developer has not yet checked against the upstream.
export const FIXED_BY_KEY = Object.freeze({
  'node_modules/electron': {
    name: 'Electron',
    licence: 'MIT',
    textFrom: 'node_modules/electron/dist/LICENSE',
    status: 'confirmed',
    note: 'Electron is the app runtime. It is a dev dependency in package.json, but it ships in the app.',
  },
  'node_modules/standardwebhooks': {
    name: 'standardwebhooks',
    licence: 'MIT (declared; not confirmed)',
    textFile: 'legal/third-party/standardwebhooks.txt',
    status: 'unconfirmed',
    note: 'The npm package declares MIT and ships no licence file. See the text below.',
  },
  // electron-updater and builder-util-runtime depend on lazy-val, which states MIT in its package.json but ships no licence file.
  // Its repository (github.com/develar/lazy-val) has none either (checked in October 2026), so there is no upstream text to copy.
  // The text is the standard MIT licence with the author that package.json names as the copyright holder. The licence itself is
  // confirmed: the package, the lock file and the repository all say MIT.
  'node_modules/lazy-val': {
    name: 'lazy-val',
    licence: 'MIT',
    textFile: 'legal/third-party/lazy-val.txt',
    status: 'confirmed',
    note: 'The npm package declares MIT and ships no licence file, and neither does its repository. The text below is the standard MIT licence, with the author named in the package as the copyright holder.',
  },
  // The phone link draws its pairing QR code with this package. It ships no licence file, so the text is kept in this script.
  'node_modules/qrcode-generator': {
    name: 'qrcode-generator',
    licence: 'MIT',
    text: MIT_QRCODE_GENERATOR_TEXT,
    status: 'confirmed',
    note: 'The npm package declares MIT and ships no licence file. The text below is the upstream MIT licence of the repository.',
  },
});

// Components with no node_modules entry of their own.
export const EXTRA_ENTRIES = Object.freeze([
  {
    key: 'chromium',
    name: 'Chromium (inside Electron)',
    licence: 'See LICENSES.chromium.html',
    pointer: 'The Chromium licences and the notices of its third-party components are in LICENSES.chromium.html, which electron-builder places beside the app (inside the app bundle on macOS). The text is about 20 MB, so it is not copied here.',
    status: 'confirmed',
  },
  {
    key: 'partial-json-parser',
    name: 'partial-json-parser (vendored in @anthropic-ai/sdk at src/_vendor/partial-json-parser)',
    licence: 'MIT',
    textFile: 'legal/third-party/partial-json-parser.txt',
    requires: 'node_modules/@anthropic-ai/sdk/src/_vendor/partial-json-parser',
    status: 'confirmed',
    note: 'The vendored copy carries no licence file. The licence text is the upstream MIT licence of partial-json-parser.',
  },
  {
    key: 'elevate.exe',
    name: 'elevate.exe (electron-builder NSIS tools, Windows build only)',
    licence: 'UNCONFIRMED',
    textFile: 'legal/third-party/elevate.txt',
    status: 'unconfirmed',
    note: 'Placed in the resources folder of the Windows build by electron-builder. It is not in package-lock.json.',
  },
  // The Android phone app's libraries (mobile/plugins/unifiedpush and its Gradle build). They are not in package-lock.json, so they
  // are listed here by hand. Both are Apache-2.0, with the Apache License 2.0 text above.
  {
    key: 'org.unifiedpush.android:connector',
    name: 'UnifiedPush connector for Android (org.unifiedpush.android:connector 3.3.5)',
    licence: 'Apache-2.0',
    source: 'https://github.com/UnifiedPush/android-connector',
    text: APACHE_2_0_TEXT,
    status: 'confirmed',
    note: 'Used by the Android phone app to receive push messages through a UnifiedPush distributor. Upstream LICENSE: Apache License 2.0.',
  },
  {
    key: 'com.google.crypto.tink:tink',
    name: 'Tink (com.google.crypto.tink:tink 1.23.0)',
    licence: 'Apache-2.0',
    source: 'https://github.com/tink-crypto/tink-java',
    text: APACHE_2_0_TEXT,
    status: 'confirmed',
    note: 'A Gradle dependency of the Android phone app. Upstream LICENSE: Apache License 2.0.',
  },
]);

// ---------- pure helpers (exported for tests) ----------

export function normalizeNewlines(s) {
  return s.replace(/\r\n/g, '\n');
}

export function licenceOf(pkgJson) {
  let l = pkgJson.license;
  if (l && typeof l === 'object') l = l.type;
  if (!l && Array.isArray(pkgJson.licenses)) {
    l = pkgJson.licenses.map((x) => (typeof x === 'string' ? x : x && x.type)).filter(Boolean).join(' OR ');
  }
  return typeof l === 'string' ? l.trim() : '';
}

// An SPDX-like expression. OR: any alternative on the allowlist is enough (the user may take it).
// AND: every part must be on the allowlist.
export function licenceAllowed(expr) {
  const e = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!e) return false;
  if (/ OR /.test(e)) return e.split(' OR ').some((part) => licenceAllowed(part));
  if (/ AND /.test(e)) return e.split(' AND ').every((part) => licenceAllowed(part));
  return ALLOWED_LICENCES.includes(e);
}

export function repoUrl(pkgJson) {
  let r = pkgJson.repository;
  if (r && typeof r === 'object') r = r.url;
  if (typeof r !== 'string' || !r.trim()) r = pkgJson.homepage;
  if (typeof r !== 'string') return '';
  r = r.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  return r.startsWith('https://') ? r : '';
}

// Licence files under a package folder, sorted, skipping nested node_modules and .git.
export function licenceFiles(dir) {
  const found = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(full, r);
      else if (ent.isFile() && LICENCE_FILE.test(ent.name)) found.push(r);
    }
  };
  walk(dir, '');
  return found.sort();
}

// The folders under node_modules that build.files leaves out of the app whole: a plain '!node_modules/<folder>/**' pattern with no
// wildcard or brace in the folder name. A pattern that leaves out only part of a package (pdfjs-dist/web, or the koffi platform
// builds in braces) does not exclude the package: the rest of it still ships.
export function wholeFolderExclusions(buildFiles) {
  const folders = [];
  for (const p of Array.isArray(buildFiles) ? buildFiles : []) {
    if (typeof p !== 'string' || !p.startsWith('!node_modules/') || !p.endsWith('/**')) continue;
    const folder = p.slice(1, -3);
    if (!/[*?{}[\]]/.test(folder)) folders.push(folder);
  }
  return folders;
}

// True when a lock-file key (node_modules/<name>, or a package nested under it) lies inside one of those folders.
export function isExcludedFromApp(key, folders) {
  return folders.some((f) => key === f || key.startsWith(`${f}/`));
}

function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTextIfExists(p) {
  if (!fs.existsSync(p)) return null;
  return normalizeNewlines(fs.readFileSync(p, 'utf8')).replace(/\n+$/, '');
}

// ---------- the build ----------

// Returns { entries, errors, warnings }. Entries are sorted by name and carry their licence texts.
export function buildNotices({ root = ROOT, release = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const releaseOnly = (m) => (release ? errors : warnings).push(m);

  const lock = readJsonIfExists(path.join(root, 'package-lock.json'));
  const pkg = readJsonIfExists(path.join(root, 'package.json'));
  const mobileLock = readJsonIfExists(path.join(root, 'mobile', 'package-lock.json'));
  const mobilePkg = readJsonIfExists(path.join(root, 'mobile', 'package.json'));
  if (!mobileLock || !mobileLock.packages) err('mobile/package-lock.json is missing or has no packages list.');
  if (!mobilePkg) err('mobile/package.json is missing.');
  for (const dep of Object.keys((mobilePkg && mobilePkg.dependencies) || {})) {
    const e = mobileLock && mobileLock.packages && mobileLock.packages[`node_modules/${dep}`];
    if (!e || e.dev) releaseOnly(`${dep} is in mobile/package.json dependencies but not in mobile/package-lock.json.`);
  }
  if (!lock || !lock.packages) {
    err('package-lock.json is missing or has no packages list.');
    return { entries: [], errors, warnings };
  }
  if (!pkg) {
    err('package.json is missing.');
    return { entries: [], errors, warnings };
  }

  // Every declared runtime dependency must be in the lock file, or the notices would miss it.
  for (const dep of Object.keys(pkg.dependencies || {})) {
    const e = lock.packages[`node_modules/${dep}`];
    if (!e || e.dev) {
      releaseOnly(`${dep} is in package.json dependencies but not in package-lock.json. Run npm install and commit the lock file; until then it is missing from the notices.`);
    }
  }

  // Packages that build.files leaves out of the app whole are not shipped, so they are neither listed nor checked.
  const outOfApp = wholeFolderExclusions(pkg.build && pkg.build.files);
  const scannedKeys = Object.keys(lock.packages)
    .filter((k) => k.startsWith('node_modules/') && !lock.packages[k].dev)
    .filter((k) => !isExcludedFromApp(k, outOfApp));
  const phoneKeys = mobileLock && mobileLock.packages
    ? Object.keys(mobileLock.packages)
        .filter((k) => k.startsWith('node_modules/') && !mobileLock.packages[k].dev && !mobileLock.packages[k].link)
        .map((k) => `mobile/${k}`)
    : [];
  const keys = [...new Set([...scannedKeys, ...phoneKeys, ...Object.keys(FIXED_BY_KEY)])];
  const entries = [];

  for (const key of keys) {
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const dir = path.join(root, key);
    const fixed = FIXED_BY_KEY[key];
    const lockEntry = key.startsWith('mobile/') ? mobileLock.packages[key.slice('mobile/'.length)] : lock.packages[key];
    const lockVersion = lockEntry && lockEntry.version;

    if (fixed) {
      const pj = readJsonIfExists(path.join(dir, 'package.json'));
      const files = [];
      if (fixed.textFrom) {
        const t = readTextIfExists(path.join(root, fixed.textFrom));
        if (t === null) err(`${fixed.name}: licence text ${fixed.textFrom} is missing. Run npm install.`);
        else files.push({ name: fixed.textFrom, text: t });
      }
      if (fixed.textFile) {
        const t = readTextIfExists(path.join(root, fixed.textFile));
        if (t === null) err(`${fixed.name}: licence text ${fixed.textFile} is missing.`);
        else files.push({ name: fixed.textFile, text: t });
      }
      if (fixed.text) files.push({ name: 'LICENSE (kept in scripts/third-party-notices.mjs)', text: normalizeNewlines(fixed.text).replace(/\n+$/, '') });
      if (fixed.status === 'unconfirmed') {
        releaseOnly(`${fixed.name}: licence not confirmed (${fixed.textFile}). Confirm it and replace that file before a release.`);
      }
      entries.push({
        name: fixed.name,
        version: (pj && pj.version) || lockVersion || '',
        licence: fixed.licence,
        source: pj ? repoUrl(pj) : '',
        note: fixed.note || '',
        status: fixed.status,
        files,
      });
      continue;
    }

    const pj = readJsonIfExists(path.join(dir, 'package.json'));
    if (!pj) {
      err(`${name}: not installed (no ${key}/package.json). Run npm ci.`);
      continue;
    }
    const licence = licenceOf(pj);
    if (!licence) err(`${name}: package.json states no licence.`);
    else if (!licenceAllowed(licence)) err(`${name}: licence "${licence}" is not on the allowlist.`);

    const rels = licenceFiles(dir);
    if (rels.length === 0) err(`${name}: no licence file in the package. Add a fixed entry in scripts/third-party-notices.mjs with its licence text.`);
    const files = rels.map((rel) => ({ name: rel, text: readTextIfExists(path.join(dir, rel)) || '' }));

    entries.push({
      name,
      version: pj.version || lockVersion || '',
      licence: licence || 'none stated',
      source: repoUrl(pj),
      note: '',
      status: 'confirmed',
      files,
    });
  }

  for (const extra of EXTRA_ENTRIES) {
    if (extra.requires && !fs.existsSync(path.join(root, extra.requires))) {
      warnings.push(`${extra.name}: ${extra.requires} is not present, so this entry is skipped.`);
      continue;
    }
    const files = [];
    if (extra.textFile) {
      const t = readTextIfExists(path.join(root, extra.textFile));
      if (t === null) err(`${extra.name}: licence text ${extra.textFile} is missing.`);
      else files.push({ name: extra.textFile, text: t });
    }
    if (extra.text) files.push({ name: 'LICENSE (kept in scripts/third-party-notices.mjs)', text: normalizeNewlines(extra.text).replace(/\n+$/, '') });
    if (extra.status === 'unconfirmed') {
      releaseOnly(`${extra.name}: licence not confirmed (${extra.textFile}). Confirm it and replace that file before a release.`);
    }
    entries.push({
      name: extra.name,
      version: '',
      licence: extra.licence,
      source: extra.source || '',
      note: extra.note || '',
      pointer: extra.pointer || '',
      status: extra.status,
      files,
    });
  }

  const seen = new Set();
  const unique = entries.filter((e) => { const k = `${e.name}@${e.version}`; if (seen.has(k)) return false; seen.add(k); return true; });
  unique.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries: unique, errors, warnings };
}

// The notice file as text with LF line ends. Deterministic: no dates and no machine paths.
export function renderNotices(entries) {
  const L = [];
  const rule = '='.repeat(72);
  const thin = '-'.repeat(72);
  L.push('THIRD-PARTY NOTICES');
  L.push('');
  L.push('Plenum includes the open-source components listed below. Each is used under the licence shown');
  L.push('with it, and that licence text follows its entry.');
  L.push('Plenum itself is under LICENSE.txt. The end-user agreement is EULA.txt beside the app.');
  L.push('Chromium and its third-party components are in LICENSES.chromium.html, beside the app.');
  L.push('This file is generated by scripts/third-party-notices.mjs from package-lock.json and node_modules.');
  L.push('Do not edit it by hand. Run npm run legal.');
  L.push('');
  L.push(`Components: ${entries.length}`);
  L.push('');
  for (const e of entries) {
    L.push(rule);
    const head = `${e.name}${e.version ? ` ${e.version}` : ''}`;
    L.push(e.status === 'unconfirmed' ? `${head}  [UNCONFIRMED LICENCE]` : head);
    L.push(`Licence: ${e.licence}`);
    if (e.source) L.push(`Source: ${e.source}`);
    if (e.note) L.push(e.note);
    if (e.pointer) L.push(e.pointer);
    for (const f of e.files) {
      L.push(thin);
      L.push(`File: ${f.name}`);
      L.push('');
      L.push(f.text.replace(/\n+$/, ''));
    }
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

// Build, then either check the file on disk or write it. Used by build-legal.mjs too.
export function runThirdParty({
  root = ROOT,
  check = false,
  release = process.env.PLENUM_RELEASE === '1',
  write = !check,
} = {}) {
  const built = buildNotices({ root, release });
  const text = renderNotices(built.entries);
  const errors = [...built.errors];
  let written = false;
  const target = path.join(root, OUTPUT);
  if (check) {
    const disk = fs.existsSync(target) ? normalizeNewlines(fs.readFileSync(target, 'utf8')) : null;
    if (disk !== text) errors.push(`${OUTPUT} is out of date. Run npm run legal.`);
  } else if (write && errors.length === 0) {
    fs.writeFileSync(target, text.replace(/\n/g, '\r\n'), 'utf8');
    written = true;
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings: built.warnings,
    entries: built.entries.map((e) => e.name),
    text,
    written,
  };
}

// ---------- command line ----------

function isMain() {
  return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

if (isMain()) {
  const check = process.argv.includes('--check');
  const r = runThirdParty({ check });
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  for (const e of r.errors) console.error(`error: ${e}`);
  console.log(`${r.entries.length} components: ${r.entries.join(', ')}`);
  if (check) console.log(r.ok ? 'check passed' : 'check failed');
  else console.log(r.ok ? `wrote ${OUTPUT}` : `not written: ${OUTPUT}`);
  process.exit(r.ok ? 0 : 1);
}
