// Phone layer, part 1 (mob-11, wave 106): ext-phone.js and ext-phone.css checked in the Electron phone harness (mob-18), against
// MOBILE-UI.md section 16.2 (P-checks). Covered here: P-01 to P-11, P-13 to P-24, P-35, P-38, plus the static P-18 and the desktop
// inertness of P-20 (DOM only). Part 2 (wave 107) covers the rest of the phone checks below it; part 3 (stabilization) adds P-09 (the strip, the waiting
// bar, badges, muted lines, buttons and Stop), P-29, P-30 and the phone side of P-37, and the routes, Back, mic and approval-guard checks. Run it
// through the sealed runner, never from the project folder; MOB11_PART=p1, p2 or p3 runs one part while a check is being worked on:
//   node build/mobile/run.mjs --id mob-11-phone-layer-part-1 ui-phone.test.mjs
// Screenshots: C:/t/mob/m11-*.png (read back by the builder for Fable's review).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT, ELECTRON, startPhoneHarness } from './harness/phone-window.mjs';

const HERE = import.meta.dirname;
const CAN_RUN = process.platform === 'win32'
  && process.env.MOBILE_SEALED === '1'
  && /\/build\/mobile\/src-[^/]+$/.test(APP_ROOT.split(path.sep).join('/'))
  && existsSync(ELECTRON);
const SKIP = CAN_RUN ? false : 'sealed Windows runner with Electron only (node build/mobile/run.mjs --id mob-11-phone-layer-part-1 ui-phone.test.mjs)';
// MOB11_PART=p3 runs only one part (p1, p2 or p3) while a check is being worked on; the full run leaves it unset.
// MOB11_ONLY is a different filter: the viewport names (360x780, 390x844, 412x915, 844x390) that part 1 runs, see the viewport loop below.
const PART = process.env.MOB11_PART || '';
const skipUnless = part => (PART && PART !== part ? `MOB11_PART=${PART}` : false);

// The four sizes of the brief. safe: [top, right, bottom, left] as in MOBILE-UI 16 (the debug hook's order).
const VIEWS = [
  { name: '360x780', view: { width: 360, height: 780, dpr: 3, mobile: true, touch: true }, safe: [24, 0, 48, 0] },
  { name: '390x844', view: { width: 390, height: 844, dpr: 3, mobile: true, touch: true }, safe: [47, 0, 34, 0] },
  { name: '412x915', view: { width: 412, height: 915, dpr: 3, mobile: true, touch: true }, safe: [24, 0, 34, 0] },
  { name: '844x390', view: { width: 844, height: 390, dpr: 3, mobile: true, touch: true }, safe: [0, 47, 21, 47], landscape: true },
];
const ZOOMS = [1, 1.3, 2];
const THEMES = ['light', 'dark'];
const SHELL_CSS = readFileSync(path.join(APP_ROOT, 'mobile', 'shell', 'styles.css'), 'utf8');

// The page-side helpers. They read the page and change only what a check needs (the stand-in Stop, which the shell draws in the product).
const PAGE_JS = String.raw`(function () {
  const P = {};
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight; };
  const targets = () => [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [tabindex="0"]')]
    .filter(vis).filter(el => !el.closest('.turn-body p, .risk-note-text p, .ext-review-lines'));
  const nameOf = el => (el.getAttribute('aria-label') || el.textContent || '').trim() ||
    (el.getAttribute('aria-labelledby') ? (document.getElementById(el.getAttribute('aria-labelledby')) || {}).textContent || '' : '');
  const label = el => ((el.getAttribute('aria-label') || el.textContent || el.className || el.tagName) + '').trim().slice(0, 50);
  const hittable = el => { const r = el.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === el || el.contains(t)); };
  P.vis = vis;
  P.small = (scope) => targets().filter(el => !scope || scope.contains(el)).filter(el => { const r = el.getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }).map(el => { const r = el.getBoundingClientRect(); return label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
  P.unnamed = (scope) => targets().filter(el => !scope || scope.contains(el)).filter(el => !nameOf(el)).map(label);
  P.hOverflow = () => document.scrollingElement.scrollWidth > innerWidth + 0.5;
  P.wide = () => [...document.querySelectorAll('body *')].filter(vis).filter(el => el.getBoundingClientRect().right > innerWidth + 0.5 && !el.closest('.table-wrap, pre, .ext-brw-tabs, .composer-images, .ext-review-lines, .ph-bar, .ph-sheet, .ph-scrim')).slice(0, 6).map(label);
  P.inputs = () => [...document.querySelectorAll('input, select, textarea')].filter(vis).map(el => parseFloat(getComputedStyle(el).fontSize)).filter(v => v < 16).length;
  P.hittable = hittable;
  // The stand-in Stop: the shell's #plenum-stop is drawn by the shell (mob-10). This page has no shell, so the harness draws a button over
  // the dock geometry the panel publishes, with the shell's z-index (70). It proves the geometry and the stacking, not the shell's look.
  // Wave 106 fix: the stand-in now uses the shell's real markup and CSS (openPhone links shell/styles.css into this page, as boot.js
  // does), so the Stop's position, size and z-index come from styles.css and the dock geometry the panel publishes.
  P.stand = () => {
    let s = document.getElementById('plenum-stop');
    if (!s) {
      s = document.createElement('button');
      s.id = 'plenum-stop';
      s.className = 'plenum-stop';
      s.type = 'button';
      s.setAttribute('aria-label', 'Stop everything on Studio PC');
      const mark = document.createElement('span');
      mark.className = 'plenum-stop-mark';
      mark.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'plenum-stop-label';
      label.textContent = 'Stop';
      const note = document.createElement('span');
      note.className = 'plenum-stop-note';
      note.setAttribute('role', 'status');
      s.append(mark, label, note);
      document.body.append(s);
    }
    return s;
  };
  // True when the Stop's box and the element's box overlap by more than 1.5 px (a shared edge is not an overlap: the dock is next to the tab).
  P.overlap = sel => {
    const e = document.querySelector(sel);
    if (!e || !vis(e)) return false;
    const s = P.stand().getBoundingClientRect();
    const r = e.getBoundingClientRect();
    const t = 1.5;
    return !(s.right <= r.left + t || s.left >= r.right - t || s.bottom <= r.top + t || s.top >= r.bottom - t);
  };
  P.stopState = () => { const s = P.stand(); const r = s.getBoundingClientRect(); return { inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5, hit: hittable(s), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height, mode: document.documentElement.dataset.phStop || '' }; };
  P.bar = () => { const bar = document.getElementById('ph-bar'); if (!bar) return null; const items = [...bar.querySelectorAll('.ph-bar-item')]; const dock = bar.querySelector('.ph-stop-dock'); const cells = [...items, dock].map(el => el.getBoundingClientRect()); return { cells: cells.map(r => ({ l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width })), barTop: bar.getBoundingClientRect().top, itemBottom: Math.max(...items.map(i => i.getBoundingClientRect().bottom)), current: items.filter(i => i.getAttribute('aria-current') === 'page').length, labels: items.map(i => i.getAttribute('aria-label') || ''), navLabel: bar.getAttribute('aria-label'), n: items.length }; };
  P.shownSheet = () => { const s = document.querySelector('.ph-sheet'); if (!s) return null; const r = s.getBoundingClientRect(); const bar = document.getElementById('ph-bar'); return { top: r.top, bottom: r.bottom, h: r.height, barTop: bar.getBoundingClientRect().top, title: (s.querySelector('.ph-sheet-title') || {}).textContent || '', activeIn: s.contains(document.activeElement), kids: [...s.querySelectorAll('.ph-sheet-body button, .ph-sheet-body input')].length, small: P.small(s), unnamed: P.unnamed(s), hOverflow: s.scrollWidth > s.clientWidth + 0.5 && false }; };
  P.zoomCheck = () => ['.ph-bar-label', '.ph-model-chip', '.ph-chip-conn', '.ph-row', '.ph-seg-btn', '.mode-btn', '.send', '.ph-plus'].flatMap(sel => [...document.querySelectorAll(sel)].filter(vis).map(el => ({ sel, over: el.scrollHeight > el.clientHeight + 1 }))).filter(x => x.over).map(x => x.sel);
  P.contrast = () => {
    const parse = v => { let m = /rgba?\(([^)]+)\)/.exec(v); if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return p.slice(0, 3).map(c => c / 255); } m = /color\(srgb ([^)]+)\)/.exec(v); if (m) { const p = m[1].split(/[ \/]+/).filter(Boolean).map(Number); return p.slice(0, 3); } return null; };
    const lum = c => { const f = x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
    const bgOf = el => { const v = getComputedStyle(el).backgroundColor; return parse(v); };
    const out = {};
    const bar = document.getElementById('ph-bar');
    const bgBar = bar ? parse(getComputedStyle(bar).backgroundColor) : null;
    if (bgBar) {
      for (const el of [...document.querySelectorAll('.ph-bar-item:not([aria-current]) .ph-bar-label'), document.querySelector('.ph-bar-item[aria-current] .ph-bar-label')].filter(Boolean)) {
        const fg = parse(getComputedStyle(el).color);
        if (fg) out['bar-' + el.textContent] = ratio(fg, bgBar);
      }
    }
    const title = document.querySelector('.ph-title');
    if (title && bgBar) { const fg = parse(getComputedStyle(title).color); if (fg) out.title = ratio(fg, bgBar); }
    const word = document.querySelector('.ph-chip-word');
    if (word && word.textContent) { const fg = parse(getComputedStyle(word).color); const bg = bgOf(word.parentElement) || bgBar; if (fg && bg) out.chipWord = ratio(fg, bg); }
    return out;
  };
  window.__ph = P;
  return true;
})()`;

let h = null;
const fails = [];
const log = (cfg, msg) => fails.push(`[${cfg}] ${msg}`);

// Runs code in the page and returns its JSON value. A page error comes back with its message (the harness alone only says it failed).
async function js(code) {
  const raw = await h.eval(`(() => { try { return JSON.stringify({ v: (${code}) }); } catch (e) { return JSON.stringify({ err: String((e && e.stack) || e) }); } })()`);
  const out = JSON.parse(raw);
  if (out.err) throw new Error(`page error: ${out.err}`);
  return out.v;
}

async function waitFor(fn, ms = 20000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 100));
  }
}

async function openPhone(v, theme, query = '?debug=1') {
  // The first-run "Set up Plenum" wizard is marked finished first, so the checks measure the phone layer and not the wizard (L9).
  await h.dismissSetup({ view: v.view, theme });
  await h.open(`${h.server.url}/${query}`, {
    surface: 'phone',
    view: v.view,
    theme,
    capacitor: true,
    token: h.server.token,
    tokenOrigin: h.server.url,
  });
  const ready = await waitFor(() => js('!!document.getElementById("ph-bar") && !!window.plenumPhoneDebug && !!document.querySelector(".proj-item")'), 30000);
  if (!ready) throw new Error(`the phone frame did not appear for ${v.name} ${theme}`);
  await h.eval(PAGE_JS);
  // The shell's stylesheet, as boot.js links it into this page. A constructed sheet is used, so the page's CSP is not involved.
  await h.eval(`(() => { if (!window.__shellSheet) { const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(SHELL_CSS)}); window.__shellSheet = sheet; document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; } return true; })()`);
  await js(`plenumPhoneDebug.safeArea(${v.safe.join(',')})`);
}

async function closeAll() {
  for (let i = 0; i < 10; i++) {
    const open = await js('!!document.querySelector(".ph-sheet, .ph-scrim")');
    if (!open) break;
    await js('plenumPhoneDebug.back()');
  }
  await new Promise(r => setTimeout(r, 30));
}

// P-04 / P-05 / P-06 / P-10 on the current screen. cfg is a label for the failure text.
async function checkFrame(cfg, v, zoom, { stopInside = true } = {}) {
  const pg = await js('({ h: __ph.hOverflow(), wide: __ph.wide(), small: __ph.small(), unnamed: __ph.unnamed(), inputs: __ph.inputs(), zoom: __ph.zoomCheck() })');
  if (pg.h) log(cfg, 'P-01 horizontal scroll');
  if (pg.wide.length) log(cfg, `P-01 wider than the screen: ${pg.wide.join(' | ')}`);
  if (pg.small.length) log(cfg, `P-02 small targets: ${pg.small.slice(0, 6).join(' | ')}`);
  if (pg.unnamed.length) log(cfg, `P-16 unnamed: ${pg.unnamed.slice(0, 6).join(' | ')}`);
  if (pg.inputs) log(cfg, `P-03 ${pg.inputs} inputs below 16 px`);
  if (zoom !== 1 && pg.zoom.length) log(cfg, `P-08 text overflows in: ${[...new Set(pg.zoom)].join(', ')}`);
  const stop = await js('__ph.stopState()');
  if (stopInside && (!stop.inside || !stop.hit)) log(cfg, `P-04 stop not inside (${stop.inside}) or not hittable (${stop.hit}) at ${stop.left},${stop.top}`);
  const bar = await js('__ph.bar()');
  if (!bar) {
    log(cfg, 'P-10 bar missing');
    return;
  }
  const widths = bar.cells.map(c => c.w);
  const maxDiff = Math.max(...widths) - Math.min(...widths);
  if (maxDiff > 1.5) log(cfg, `P-10 cells not equal: ${widths.map(w => Math.round(w)).join(',')}`);
  if (v.view.width <= 360 && Math.min(...widths) < 64) log(cfg, 'P-10 a cell is under 64 px at 360');
  if (bar.n !== 4 || bar.navLabel !== 'Plenum') log(cfg, 'P-10 bar must be nav[aria-label=Plenum] with four items');
  if (bar.current !== 1) log(cfg, `P-10 aria-current count ${bar.current}, expected 1`);
  if (!v.landscape) {
    const expected = v.safe[2];
    const itemBottom = bar.itemBottom;
    if (Math.abs(itemBottom - (v.view.height - expected)) > 1.5) log(cfg, `P-06 bar bottom ${itemBottom} is not ${v.view.height - expected}`);
  }
  const dockCell = bar.cells[bar.cells.length - 1];
  const cx = stop.left + stop.w / 2;
  const cy = stop.top + stop.h / 2;
  if (stop.mode === 'cell' && (cx < dockCell.l || cx > dockCell.r || cy < dockCell.t || cy > dockCell.b)) log(cfg, 'P-05 stop is not centred in the last bar cell');
  return { pg, stop, bar };
}

async function checkBands(cfg, v) {
  const bad = await js(`(() => {
    const out = [];
    const pts = [];
    for (let y = 2; y < ${v.safe[0]}; y += 20) for (let x = 4; x < innerWidth; x += 20) pts.push([x, y]);
    for (let y = innerHeight - ${v.safe[2]} + 2; y < innerHeight; y += 20) for (let x = 4; x < innerWidth; x += 20) pts.push([x, y]);
    for (const [x, y] of pts) {
      const t = document.elementFromPoint(x, y);
      if (t && t.closest && t.closest('button, a[href], input, select, textarea, [role=button]')) out.push([x, y, (t.closest('button,a,input,select,textarea,[role=button]')).className || t.tagName]);
    }
    return out.slice(0, 5);
  })()`);
  if (bad.length) log(cfg, `P-06 interactive element in a safe band: ${JSON.stringify(bad)}`);
}

// P-11 for one sheet: opened by selector, from the tab named.
async function checkSheet(cfg, v, name, opener, tab) {
  await js(`plenumPhoneDebug.tab(${JSON.stringify(tab)})`);
  await new Promise(r => setTimeout(r, 40));
  const opened = await js(`(() => { const el = document.querySelector(${JSON.stringify(opener)}); if (!el) return false; el.focus(); el.click(); return true; })()`);
  if (!opened) {
    log(cfg, `P-11 ${name}: opener ${opener} not found`);
    return;
  }
  await new Promise(r => setTimeout(r, 300));
  // The entrance (ph-sheet-in, a 24 px slide) advances only on the page's frames. The harness window does not always produce them, so the
  // resting position is read once the entrance is finished. The slide itself is checked by P-19.
  await js(`(() => { const sh = document.querySelector('.ph-sheet'); if (sh) sh.getAnimations().forEach(a => a.finish()); return true; })()`);
  const s = await js('__ph.shownSheet()');
  if (!s) {
    log(cfg, `P-11 ${name}: no sheet`);
    return;
  }
  if (Math.abs(s.bottom - s.barTop) > 1.5) log(cfg, `P-11 ${name}: sheet bottom ${s.bottom} is not the bar top ${s.barTop}`);
  const barH = v.landscape ? 44 : 56;
  const maxH = v.view.height - v.safe[0] - 24 - barH - v.safe[2];
  if (s.h > maxH + 1.5) log(cfg, `P-11 ${name}: height ${s.h} above ${maxH}`);
  if (!s.activeIn) log(cfg, `P-11 ${name}: focus is not inside the sheet`);
  if (s.small.length) log(cfg, `P-02 ${name}: small ${s.small.slice(0, 4).join(' | ')}`);
  if (s.unnamed.length) log(cfg, `P-16 ${name}: unnamed ${s.unnamed.slice(0, 4).join(' | ')}`);
  const stop = await js('__ph.stopState()');
  if (!stop.hit) log(cfg, `P-04 ${name}: stop not hittable with the sheet open`);
  // Tab stays inside: the focus moves to the first control when Tab is pressed on the last one.
  const trap = await js(`(() => { const sh = document.querySelector('.ph-sheet'); const items = [...sh.querySelectorAll('button:not([disabled]), input, [tabindex="0"]')].filter(e => e.getClientRects().length); if (!items.length) return 'none'; items[items.length - 1].focus(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); return sh.contains(document.activeElement) ? 'in' : 'out'; })()`);
  if (trap === 'out') log(cfg, `P-11 ${name}: Tab leaves the sheet`);
  // Esc closes it and the focus returns to the opener.
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) || true`);
  const closed = await js('!document.querySelector(".ph-sheet")');
  if (!closed) log(cfg, `P-11 ${name}: Esc did not close`);
  const back = await js(`document.activeElement && document.activeElement.matches(${JSON.stringify(opener)})`);
  if (!back) log(cfg, `P-11 ${name}: focus did not return to the opener`);
  // The scrim closes it too, and the title bar's back closes a layer.
  await js(`(() => { const el = document.querySelector(${JSON.stringify(opener)}); el.focus(); el.click(); return true; })()`);
  await js('document.querySelector(".ph-scrim") && document.querySelector(".ph-scrim").click()');
  if (await js('!!document.querySelector(".ph-sheet")')) log(cfg, `P-11 ${name}: scrim tap did not close`);
  await js(`(() => { const el = document.querySelector(${JSON.stringify(opener)}); el.focus(); el.click(); return true; })()`);
  await js('plenumPhoneDebug.back()');
  if (await js('!!document.querySelector(".ph-sheet")')) log(cfg, `P-11 ${name}: back() did not close`);
}

describe('phone layer part 1 (mob-11): static checks', () => {
  test('ext-phone.js parses and carries no style attribute, no innerHTML and no eval', () => {
    const js = path.join(APP_ROOT, 'public', 'ext-phone.js');
    const check = spawnSync(process.execPath, ['--check', js], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const src = readFileSync(js, 'utf8');
    assert.doesNotMatch(src, /setAttribute\(['"]style['"]/);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|cssText|\beval\(/);
  });

  test('P-18: ext-phone.css has no colour literal outside var() (hex, rgb(), hsl(), a named colour)', () => {
    const css = readFileSync(path.join(APP_ROOT, 'public', 'ext-phone.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(stripped, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(stripped, /\brgba?\(|\bhsla?\(/);
    assert.doesNotMatch(stripped, /:\s*(black|white|red|green|blue|gray|grey|silver|transparent|navy|teal)\b/);
  });

  test('the panel is inert without data-surface=phone: no mobile bar, no ph- nodes (P-20, DOM part)', { skip: SKIP }, async () => {
    h = await startPhoneHarness({ name: 'mob11-desk' });
    try {
      await h.openApp({ view: { width: 1280, height: 800, dpr: 1, mobile: false, touch: false }, surface: 'desktop', theme: 'light' });
      await waitFor(() => h.eval('!!document.querySelector(".proj-item")'), 20000);
      const n = await h.eval('({ bar: !!document.getElementById("ph-bar"), ph: document.querySelectorAll("[class*=\\"ph-\\"]").length, plenumPhoneDebug: typeof window.plenumPhoneDebug })');
      assert.equal(n.bar, false, 'a bar on the desktop');
      assert.equal(n.ph, 0, 'ph- nodes on the desktop');
      const logs = await h.logs();
      assert.deepEqual(logs.pageErrors, [], 'uncaught errors on the desktop');
    } finally {
      await h.close();
      h = null;
    }
  });
});

describe('phone layer part 1 (mob-11): the phone surface', { skip: SKIP || skipUnless('p1'), timeout: 1_500_000 }, () => {
  before(async () => {
    if (SKIP) return;
    h = await startPhoneHarness({ name: 'mob11-phone' });
  });

  after(async () => {
    if (!h) return;
    const left = await h.close();
    h = null;
    assert.deepEqual(left.leftover, [], 'processes left behind');
  });

  test('P-21: every panel loads and registers on the phone surface; the page raises no console error', async () => {
    await openPhone(VIEWS[0], 'light');
    const panels = await h.panels();
    assert.deepEqual(panels.missing, [], 'panels that did not load');
    assert.equal(panels.registered.length, panels.expected.length, 'panels that did not register');
    const logs = await h.logs();
    assert.deepEqual(logs.pageErrors, [], 'uncaught page errors');
    assert.equal(logs.errors.length, 0, `console errors: ${logs.errors.slice(0, 3).join(' | ')}`);
  });

  const ONLY = process.env.MOB11_ONLY ? process.env.MOB11_ONLY.split(',') : null;
  for (const v of VIEWS.filter(x => !ONLY || ONLY.includes(x.name))) {
    for (const theme of THEMES) {
      for (const zoom of ZOOMS) {
        const cfg = `${v.name} ${theme} z${zoom}`;
        test(`${cfg}: frame, tabs, sheets, keyboard, text zoom and the back stack`, { timeout: 300_000 }, async () => {
          await openPhone(v, theme);
          if (zoom !== 1) await js(`plenumPhoneDebug.textZoom(${zoom})`);
          await new Promise(r => setTimeout(r, 60));

          // Projects (8.3): the sidebar fills the screen between the title and the bar.
          await js('plenumPhoneDebug.tab("projects")');
          await new Promise(r => setTimeout(r, 40));
          await checkFrame(`${cfg} projects`, v, zoom);
          await checkBands(`${cfg} projects`, v);
          const rows = await js('(() => { const rows = [...document.querySelectorAll(".proj-item")]; return { n: rows.length, more: rows.filter(r => { const b = r.querySelector(".ph-row-more"); return b && b.getClientRects().length > 0; }).length, forgetShown: [...document.querySelectorAll(".proj-item .forget")].some(f => f.getClientRects().length > 0) }; })()');
          if (rows.n < 1 || rows.more !== rows.n) log(cfg, `P-14 project rows without a visible more: ${rows.more} of ${rows.n}`);
          if (rows.forgetShown) log(cfg, 'P-14 .forget is shown (it must be reached through the more sheet)');

          // Long-press (P-15): a 500 ms hold opens the row's sheet; movement over 10 px cancels; contextmenu opens it too.
          await js(`(() => { const row = document.querySelector(".proj-item"); const r = row.getBoundingClientRect(); row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20, button: 0, pointerType: "touch", pointerId: 7 })); return true; })()`);
          await new Promise(r => setTimeout(r, 650));
          const held = await js('(() => { const s = document.querySelector(".ph-sheet"); return s ? (s.querySelector(".ph-sheet-title") || {}).textContent : null; })()');
          if (!held) log(cfg, 'P-15 a 500 ms hold on a project row opened nothing');
          await js('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })) || true');
          await js(`(() => { const row = document.querySelector(".proj-item"); const r = row.getBoundingClientRect(); row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20, button: 0, pointerType: "touch", pointerId: 8 })); row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + 60, clientY: r.top + 20, button: 0, pointerType: "touch", pointerId: 8 })); return true; })()`);
          await new Promise(r => setTimeout(r, 650));
          if (await js('!!document.querySelector(".ph-sheet")')) log(cfg, 'P-15 movement over 10 px did not cancel the hold');
          await js('(() => { const row = document.querySelector(".proj-item"); row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return true; })()');
          if (!(await js('!!document.querySelector(".ph-sheet")'))) log(cfg, 'P-15 contextmenu did not open the sheet');
          await closeAll();

          // The "⋯" sheets (8.14), the model and role sheet (P-13), the "+" sheet and the project sheet, each with P-11.
          await checkSheet(cfg, v, 'more', '.ph-more', 'chat');
          await checkSheet(cfg, v, 'connection', '.ph-chip-conn', 'chat');
          await checkSheet(cfg, v, 'model', '.ph-model-chip', 'chat');
          await checkSheet(cfg, v, 'plus', '.ph-plus', 'chat');
          await checkSheet(cfg, v, 'project', '.proj-item .ph-row-more', 'projects');
          await js('plenumPhoneDebug.tab("chat")');

          // P-13: the model sheet lists every #modelSel option, in order, grouped; choosing one sets it and fires one change.
          await js('(() => { document.querySelector(".ph-model-chip").click(); return true; })()');
          const parity = await js(`(() => {
            const sel = document.getElementById("modelSel");
            const want = [...sel.children].flatMap(n => n.tagName === "OPTGROUP" ? [...n.children] : (n.tagName === "OPTION" ? [n] : [])).map(o => { const n = o.querySelector(".o-name"); return (n ? n.textContent : o.textContent).trim(); });
            const rows = [...document.querySelectorAll(".ph-sheet-model .ph-opt .ph-row-label")].map(e => e.textContent.trim());
            const groups = [...document.querySelectorAll(".ph-sheet-model .ph-group-head")].map(e => e.textContent.trim());
            const wantGroups = [...sel.querySelectorAll("optgroup")].map(g => g.label);
            return { same: JSON.stringify(want) === JSON.stringify(rows), want: want.length, rows: rows.length, groupsOk: JSON.stringify(wantGroups) === JSON.stringify(groups.filter(g => wantGroups.includes(g))), wantGroups, groups };
          })()`);
          if (!parity.same) log(cfg, `P-13 the sheet lists ${parity.rows} models, the select has ${parity.want}, or the order differs`);
          if (!parity.groupsOk) log(cfg, `P-13 optgroups differ: ${parity.wantGroups.join(' / ')} against ${parity.groups.join(' / ')}`);
          const change = await js(`(() => {
            const sel = document.getElementById("modelSel"); let n = 0; const f = () => { n += 1; }; sel.addEventListener("change", f);
            const row = document.querySelector(".ph-sheet-model .ph-opt[aria-checked=\\"true\\"]");
            if (!row) return { n: -1 };
            row.click(); sel.removeEventListener("change", f);
            return { n, value: sel.value, same: row.getAttribute("aria-checked") === "true" };
          })()`);
          if (change.n !== 1) log(cfg, `P-13 choosing a model fired ${change.n} change events, expected 1`);
          await closeAll();

          // The model and role sheet also carries the Chat/Council switch and Effort, and the composer row 2 (P-24).
          await js('(() => { document.querySelector(".ph-model-chip").click(); return true; })()');
          const effort = await js('({ effort: document.querySelectorAll(".ph-effort .ph-seg-btn").length, options: document.querySelectorAll("#effortSel option").length, seg: document.querySelectorAll(".ph-sheet-model .ph-seg-btn").length })');
          if (effort.effort !== effort.options) log(cfg, `P-13 effort rows ${effort.effort} against ${effort.options} options`);
          if (zoom === 1 || zoom === 2) {
            const sh = await js('__ph.shownSheet()');
            if (!sh) log(cfg, 'P-13 the model sheet did not stay open for the screenshot');
          }
          if (v.name === '360x780' && theme === 'light' && zoom === 1) await h.shot('m11-model-sheet-360-light');
          if (zoom === 2 && (v.name === '360x780' || v.name === '844x390')) await h.shot(`m11-model-sheet-${v.name}-${theme}-z2`);
          await checkFrame(`${cfg} model sheet`, v, zoom);
          await closeAll();

          // P-35: a toast sits above an open sheet and under the title bar.
          await js('(() => { document.querySelector(".ph-model-chip").click(); MuseUI.toast("Saved.", "ok"); return true; })()');
          await new Promise(r => setTimeout(r, 120));
          const toast = await js(`(() => { const t = [...document.querySelectorAll("#toasts .toast")].pop(); if (!t) return null; const r = t.getBoundingClientRect(); const top = document.getElementById("titlebar").getBoundingClientRect().bottom; const z = Number(getComputedStyle(document.getElementById("toasts")).zIndex); const sheetZ = Number(getComputedStyle(document.querySelector(".ph-sheet")).zIndex); return { top: r.top, title: top, z, sheetZ, bottom: r.bottom, ih: innerHeight }; })()`);
          if (!toast || !(toast.z > toast.sheetZ) || toast.bottom > toast.ih) log(cfg, `P-35 a toast is not stacked over the open sheet (${JSON.stringify(toast)})`);
          if (toast && toast.top < toast.title - 1) log(cfg, 'P-35 a toast sits under the title bar');
          if (toast && toast.top < toast.title - 1) log(cfg, 'P-35 a toast sits under the title bar');
          await closeAll();

          // Chat (8.4): the composer row 2 is [+] [model chip] [Mode] [Send] (P-24); the bar and Stop are live.
          await js('plenumPhoneDebug.tab("chat")');
          await new Promise(r => setTimeout(r, 60));
          await checkFrame(`${cfg} chat`, v, zoom);
          await checkBands(`${cfg} chat`, v);
          const row2 = await js(`(() => { const bar = document.querySelector(".composer-bar"); const kids = [...bar.children].filter(e => e.getClientRects().length > 0).map(e => e.classList.contains("ph-plus") ? "plus" : e.classList.contains("ph-model-chip") ? "chip" : e.classList.contains("mode-wrap") ? "mode" : e.id === "send" ? "send" : (e.className || e.tagName)); return { kids, mic: !!document.querySelector(".ph-mic") }; })()`);
          if (JSON.stringify(row2.kids) !== JSON.stringify(['plus', 'chip', 'mode', 'send'])) log(cfg, `P-24 composer row 2 is ${row2.kids.join(', ')}`);
          if (row2.mic) log(cfg, 'P-24 a mic is drawn without the dictation capability');
          const chat = await js('({ title: (document.querySelector(".ph-title")||{}).textContent, chat: !!document.querySelector("#chat") })');
          if (!chat.title) log(cfg, 'P-23 the title is empty');
          if (v.landscape) {
            const bar = await js('__ph.bar()');
            if (bar.cells[0].b - bar.cells[0].t > 45) log(cfg, 'P-22 the landscape bar is not 44 tall');
            const labelShown = await js('(() => { const l = document.querySelector(".ph-bar-label"); return l ? l.getClientRects().length > 0 : false; })()');
            if (labelShown) log(cfg, 'P-22 the landscape bar shows labels');
          }
          await h.shot(`m11-chat-${v.name}-${theme}-z${zoom}`).catch(() => {});

          // The keyboard (P-07, P-05 float): the composer rides on it, the bar leaves, the Stop floats over the composer's top right.
          // Wave 106 fix: in the bar (cell mode) the Stop never covers the Review tab.
          if (await js('__ph.overlap(".ph-bar-item[data-tab=review]")')) {
            const geo = await js(`(() => { const s = __ph.stand().getBoundingClientRect(); const r = document.querySelector(".ph-bar-item[data-tab=review]").getBoundingClientRect(); const d = document.querySelector(".ph-stop-dock").getBoundingClientRect(); const f = n => Math.round(n); return { stop: [f(s.left), f(s.top), f(s.width), f(s.height)], review: [f(r.left), f(r.top), f(r.width), f(r.height)], dock: [f(d.left), f(d.top), f(d.width), f(d.height)], mode: document.documentElement.dataset.phStop || '' }; })()`);
            log(cfg, `P-04 the Stop covers the Review tab in the bar: stop ${geo.stop}, review ${geo.review}, dock ${geo.dock}, mode ${geo.mode}`);
          }
          await js('plenumPhoneDebug.keyboard(336)');
          await new Promise(r => setTimeout(r, 220));
          const kb = await js('(() => { const c = document.getElementById("composer").getBoundingClientRect(); const bar = document.getElementById("ph-bar"); const bs = getComputedStyle(bar); return { composerBottom: c.bottom, composerTop: c.top, barOpacity: Number(bs.opacity), barPE: bs.pointerEvents, mode: document.documentElement.dataset.phStop, ih: innerHeight }; })()');
          if (!v.landscape && kb.composerBottom > kb.ih - 336 + 1) log(cfg, `P-07 composer bottom ${kb.composerBottom} is below ${kb.ih - 336}`);
          if (kb.barOpacity > 0.01) log(cfg, 'P-07 the bar is still shown with the keyboard open');
          const floatStop = await js('__ph.stopState()');
          if (floatStop.mode !== 'float') log(cfg, `P-05 the dock is in ${floatStop.mode} mode with the keyboard`);
          // The float keeps the right safe area clear (16.1): 16 px in from the safe edge (landscape has a 47 px notch on the right).
          const floatRight = v.view.width - v.safe[1] - 16;
          if (Math.abs(floatStop.right - floatRight) > 1.5) log(cfg, `P-05 float stop right ${floatStop.right} is not ${floatRight}`);
          if (floatStop.bottom > kb.composerTop - 8 + 1) log(cfg, 'P-05 float stop overlaps the composer top');
          if (!floatStop.hit) log(cfg, 'P-04 the stop is not hittable with the keyboard open');
          if (await js('__ph.overlap("#send")')) log(cfg, 'P-04 the Stop covers Send with the keyboard open');
          if (v.name === '360x780' && theme === 'light' && zoom === 1) await h.shot('m11-keyboard-360-light');
          await js('plenumPhoneDebug.keyboard(0)');
          await new Promise(r => setTimeout(r, 220));
          const back = await js('(() => { const bar = document.getElementById("ph-bar"); return getComputedStyle(bar).opacity; })()');
          if (Number(back) < 0.99) log(cfg, 'P-07 the bar did not return after the keyboard closed');

          // P-04 in every tab and connection state, and P-05 on the bar with a sheet open (the model sheet above).
          for (const tab of ['projects', 'chat', 'agents', 'review']) {
            await js(`plenumPhoneDebug.tab(${JSON.stringify(tab)})`);
            await new Promise(r => setTimeout(r, 60));
            const st = await js('__ph.stopState()');
            if (!st.hit || !st.inside) log(cfg, `P-04 stop not hittable on ${tab}`);
          }
          await js('plenumPhoneDebug.tab("chat")');
          for (const state of ['reconnecting', 'offline', 'asleep', 'connected']) {
            await js(`plenumPhoneDebug.connection(${JSON.stringify(state)})`);
            const st = await js('__ph.stopState()');
            if (!st.hit) log(cfg, `P-04 stop not hittable with the connection ${state}`);
            const word = await js('(() => { const c = document.querySelector(".ph-chip-conn"); return c ? c.getAttribute("aria-label") : null; })()');
            if (!word) log(cfg, `P-25 no connection chip for ${state}`);
          }
          await js('plenumPhoneDebug.connection("connected")');

          // P-04 with a confirm dialog open (MuseUI.confirm), then P-05 with the Mode menu open: it ends at the bar's top edge.
          await js('plenumPhoneDebug.tab("chat")');
          await js('(() => { MuseUI.confirm({ title: "Check", body: "A confirm dialog for the check.", action: "OK" }); return true; })()');
          await new Promise(r => setTimeout(r, 300));
          const dlg = await js('(() => { const d = document.querySelector("dialog.confirm-dialog[open]"); return { open: !!d, stop: __ph.stopState() }; })()');
          if (!dlg.open) log(cfg, 'P-04 the confirm dialog did not open');
          else if (!dlg.stop.hit) log(cfg, 'P-04 stop not hittable with a confirm dialog open');
          await js('(() => { const d = document.querySelector("dialog.confirm-dialog[open]"); const c = d && d.querySelector(".confirm-actions button"); if (c) c.click(); return true; })()');
          await new Promise(r => setTimeout(r, 150));
          await js('(() => { const b = document.getElementById("modeBtn"); b.focus(); b.click(); return true; })()');
          await new Promise(r => setTimeout(r, 300));
          const mode = await js('(() => { const m = document.getElementById("modeMenu"); if (!m || m.hidden) return { open: false }; const r = m.getBoundingClientRect(); const bar = document.getElementById("ph-bar").getBoundingClientRect(); return { open: true, bottom: r.bottom, barTop: bar.top, stop: __ph.stopState() }; })()');
          if (!mode.open) log(cfg, 'P-05 the Mode menu did not open');
          else {
            if (Math.abs(mode.bottom - mode.barTop) > 1.5) log(cfg, `P-05 the Mode menu bottom ${mode.bottom} is not the bar top ${mode.barTop}`);
            if (!mode.stop.hit) log(cfg, 'P-04 stop not hittable with the Mode menu open');
          }
          await js('(() => { const b = document.getElementById("modeBtn"); if (!document.getElementById("modeMenu").hidden) b.click(); return true; })()');
          await new Promise(r => setTimeout(r, 100));

          // The Stop cell in the bar with a sheet open: the sheet ends at the bar top and the stop is still in its cell.
          await js('(() => { document.querySelector(".ph-model-chip").click(); return true; })()');
          await new Promise(r => setTimeout(r, 300));
          const sheetStop = await js('(() => { const s = __ph.stopState(); const sh = __ph.shownSheet(); return { hit: s.hit, sheetBottom: sh.bottom, barTop: sh.barTop, stopTop: s.top }; })()');
          if (!sheetStop.hit) log(cfg, 'P-04 stop not hittable with the model sheet open');
          if (Math.abs(sheetStop.sheetBottom - sheetStop.barTop) > 1.5) log(cfg, 'P-05 the model sheet does not end at the bar top');
          await closeAll();

          // P-22 at 844 x 390 (landscape) is run once in the loop above; P-09 contrast of the bar labels, the title and the chip word.
          await js('plenumPhoneDebug.tab("chat")');
          const contrast = await js('__ph.contrast()');
          for (const [key, value] of Object.entries(contrast)) {
            if (value < 4.5) log(cfg, `P-09 ${key} contrast ${value.toFixed(2)} is under 4.5`);
          }

          if (process.env.MOB11_DIAG) {
            const top = await js('[...document.getElementById("titlebar").children].map(e => [e.className, getComputedStyle(e).order, getComputedStyle(e).display, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().right)])');
            console.log(`TOPBAR ${cfg} ${JSON.stringify(top)}`);
            const dg = await js('(() => { const l = document.querySelector(".ph-bar-label"); const cs = getComputedStyle(l); const m = document.querySelector(".ph-more").getBoundingClientRect(); const c = document.querySelector(".ph-chip-conn").getBoundingClientRect(); const t = document.querySelector(".ph-title"); const tb = t.getBoundingClientRect(); const pt = t.parentElement.getBoundingClientRect(); return { label: [l.scrollHeight, l.clientHeight, cs.lineHeight, cs.fontSize, cs.display], item: l.parentElement.getBoundingClientRect().height, more: [m.left, m.right], chip: [c.left, c.right], title: [tb.left, tb.right, t.scrollWidth, t.clientWidth], proj: [pt.left, pt.right, pt.width] }; })()');
            console.log(`DIAG ${cfg} ${JSON.stringify(dg)}`);
          }
          // P-23: a long project name ellipsizes and leaves the chip and the "⋯" where they were.
          const before = await js('(() => { const m = document.querySelector(".ph-more").getBoundingClientRect(); const c = document.querySelector(".ph-chip-conn").getBoundingClientRect(); return { m: m.right, c: c.right }; })()');
          await js('(() => { document.getElementById("projName").textContent = "A very long project name that goes on and on and on for the title bar test, and then keeps going with more words so that it is longer than a landscape title bar at 844 pixels wide, which is what the check is about, again and again and again"; return true; })()');
          await new Promise(r => setTimeout(r, 60));
          const long = await js('(() => { const t = document.querySelector(".ph-title"); const m = document.querySelector(".ph-more").getBoundingClientRect(); const c = document.querySelector(".ph-chip-conn").getBoundingClientRect(); return { over: t.scrollWidth > t.clientWidth, m: m.right, c: c.right, inside: m.right <= innerWidth + 0.5 }; })()');
          if (process.env.MOB11_DIAG) {
            const tb = await js('[...document.getElementById("titlebar").children].map(e => [e.className, getComputedStyle(e).display, getComputedStyle(e).flex, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().right), Math.round(e.getBoundingClientRect().width)])');
            const pt = await js('(() => { const p = document.querySelector("#titlebar .proj-title"); const t = document.querySelector(".ph-title"); return { p: [getComputedStyle(p).display, getComputedStyle(p).flex, getComputedStyle(p).minWidth, Math.round(p.getBoundingClientRect().width)], t: [getComputedStyle(t).flex, getComputedStyle(t).minWidth, t.scrollWidth, Math.round(t.getBoundingClientRect().width)], bar: Math.round(document.getElementById("titlebar").getBoundingClientRect().width) }; })()');
            console.log(`LONG ${cfg} ${JSON.stringify(tb)} ${JSON.stringify(pt)}`);
          }
          if (!long.over) log(cfg, 'P-23 a long name does not ellipsize');
          if (Math.abs(long.m - before.m) > 1.5 || Math.abs(long.c - before.c) > 1.5 || !long.inside) log(cfg, `P-23 a long name moved the chip or the more (before m ${before.m} c ${before.c}, after m ${long.m} c ${long.c})`);
          await js('(() => { document.getElementById("projName").textContent = "p1"; return true; })()').catch(() => {});

          // P-38: the More sheet names every connected phone and marks this one.
          await js('plenumPhoneDebug.self("d1")');
          await js(`(() => { window.dispatchEvent(new CustomEvent("plenum:event", { detail: { type: "phone", kind: "presence", connected: [{ id: "d1", name: "Will's iPhone" }, { id: "d2", name: "Work Pixel" }] } })); return true; })()`);
          await js('(() => { document.querySelector(".ph-more").click(); return true; })()');
          const phones = await js('(() => { const sh = document.querySelector(".ph-sheet"); if (!sh) return null; const text = sh.textContent; return { both: text.includes("Will\'s iPhone") && text.includes("Work Pixel"), mine: text.includes("Will\'s iPhone (this phone)") || text.includes("(this phone)") }; })()');
          if (!phones || !phones.both) log(cfg, 'P-38 the More sheet does not name both phones');
          if (!phones || !phones.mine) log(cfg, 'P-38 this phone is not marked "(this phone)"');
          await closeAll();

          // The back stack: the sheet first, then Chat goes to Projects, and Projects leaves the app (back returns false).
          await js('plenumPhoneDebug.tab("chat")');
          const back1 = await js('plenumPhoneDebug.back()');
          const tabAfter = await js('document.documentElement.dataset.phTab');
          if (back1 !== true || tabAfter !== 'projects') log(cfg, `back stack: from chat it went to ${tabAfter}`);
          const back2 = await js('plenumPhoneDebug.back()');
          if (back2 !== false) log(cfg, 'back stack: Projects did not report the app should leave');

          // Text zoom 2.0: the bar labels are hidden and their names stay; the tab still works.
          if (zoom === 2) {
            await js('plenumPhoneDebug.tab("chat")');
            const labels = await js('(() => { const l = document.querySelector(".ph-bar-label"); return l ? l.getClientRects().length : 0; })()');
            if (labels !== 0) log(cfg, 'P-08 the bar labels stay at 2.0');
            const names = await js('[...document.querySelectorAll(".ph-bar-item")].every(b => (b.getAttribute("aria-label") || "").length > 0)');
            if (!names) log(cfg, 'P-08 the bar names are missing at 2.0');
          }
          await js('plenumPhoneDebug.tab("chat")');
          if (v.name === '360x780' || v.name === '844x390') await h.shot(`m11-chat-${v.name}-${theme}-z${zoom}-final`).catch(() => {});

          assert.deepEqual(fails.filter(f => f.startsWith(`[${cfg}]`)), [], 'checks that failed');
        });
      }
    }
  }

  test('P-19: a sheet has no transition on transform, so reduced motion keeps it at 0 s', async () => {
    await openPhone(VIEWS[1], 'light');
    await js('plenumPhoneDebug.tab("chat")');
    await js('(() => { document.querySelector(".ph-model-chip").click(); return true; })()');
    const d = await js('getComputedStyle(document.querySelector(".ph-sheet")).transitionDuration');
    assert.equal(d.split(',').every(x => parseFloat(x) === 0), true, `transition-duration ${d}`);
    await closeAll();
  });

  test("the debug hooks are merged with the shell's, never replaced", async () => {
    await openPhone(VIEWS[0], 'dark');
    const hooks = await js('Object.keys(window.plenumPhoneDebug).sort()');
    for (const name of ['safeArea', 'keyboard', 'textZoom', 'tab', 'back', 'connection']) assert.ok(hooks.includes(name), `hook ${name} missing`);
  });

  test('the suite leaves no failure behind', () => {
    assert.deepEqual(fails, [], `${fails.length} phone-layer check(s) failed:\n${fails.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Phone layer, part 2 (mob-11, wave 107): approvals, the waiting bar, hand-over, the connection strip and tiers, Report, the Newer pill,
// the bar's long-press, the sign-in sheet and the picture, against MOBILE-UI.md 8.4.3, 8.4.5, 8.6, 8.10, 8.11, 8.13, 9, 16.2 (P-12,
// P-25, P-26, P-28, P-31, P-32, P-33, P-34, P-36). Covered here by the harness. P-29 and P-30 are in part 3 (a stand-in answer for the changes, and a
// running agent from the mock model); P-37's settings rows and the card-changed answer are in shell.e2e.test.mjs, shell-core.test.mjs and
// ui-loader.test.mjs, and its route into the phone layer in part 3; P-22 (landscape) is in part 1.
// Run it through the sealed runner only:
//   node build/mobile/run.mjs --id mob-11-phone-layer-part-2 ui-phone.test.mjs
// ---------------------------------------------------------------------------------------------------------------------------------------

// Records every non-GET request the page makes, so a check can say "no POST happened". Installed once per page load.
const P2_PAGE = String.raw`(function () {
  if (!window.__posts) {
    window.__posts = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const method = String((init && init.method) || 'GET').toUpperCase();
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (method !== 'GET') window.__posts.push(method + ' ' + url);
      } catch (e) { /* the record is best effort */ }
      return nativeFetch(input, init);
    };
  }
  window.__approves = () => window.__posts.filter(p => /^POST \S*\/api\/approve$/.test(p)).length;
  window.__mkCard = (id, summary, extra) => {
    const approval = plenumPhoneDebug.approval({ id, summary, detail: '' });
    return approval;
  };
  return true;
})()`;

// A hand-over card as the desktop draws it (app.js typeItCard): the box and the two buttons.
function handOverCardJs(id, ask) {
  return `(() => {
    const card = document.createElement('div');
    card.className = 'approval fresh typeit';
    card.setAttribute('role', 'group');
    card.dataset.handover = ${JSON.stringify(id)};
    const head = document.createElement('span');
    head.className = 'approval-head';
    head.textContent = 'Your turn';
    const summary = document.createElement('span');
    summary.className = 'approval-summary';
    summary.textContent = ${JSON.stringify(ask)};
    const box = document.createElement('input');
    box.type = 'password';
    box.className = 'approval-reason';
    box.autocomplete = 'off';
    box.setAttribute('aria-label', 'Text for Plenum to type into the window');
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const resume = document.createElement('button');
    resume.className = 'ghost small';
    resume.textContent = 'Resume';
    const typeBtn = document.createElement('button');
    typeBtn.className = 'primary small';
    typeBtn.textContent = 'Type it for me';
    typeBtn.disabled = true;
    actions.append(resume, typeBtn);
    card.append(head, summary, box, actions);
    document.getElementById('chat').append(card);
    return true;
  })()`;
}

describe('phone layer part 2 (mob-11, wave 107): the phone surface', { skip: SKIP || skipUnless('p2'), timeout: 1_500_000 }, () => {
  before(async () => {
    if (SKIP) return;
    h = await startPhoneHarness({ name: 'mob11-phone-p2' });
  });

  after(async () => {
    if (!h) return;
    const left = await h.close();
    h = null;
    assert.deepEqual(left.leftover, [], 'processes left behind');
  });

  test('P-12 and P-34: an early tap is refused and says so ("Tap again"); a tap after the window is honoured once', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await js('plenumPhoneDebug.tab("chat")');
    await h.eval(P2_PAGE);
    await js('(() => { plenumPhoneDebug.approval({ id: "g-1", summary: "Run: npm test -- --watch=false", detail: "" }); return true; })()');
    const ready = await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"g-1\\"] .ph-approve")'));
    assert.ok(ready, 'the approval card was not decorated');
    await js(`(() => {
      const card = document.querySelector('[data-approval-id="g-1"]');
      const approve = card.querySelector('.ph-approve');
      const deny = card.querySelector('.ph-deny');
      const a = approve.getBoundingClientRect();
      const d = deny.getBoundingClientRect();
      window.__g = { h: a.height, dh: d.height, denyLeft: d.left < a.left, before: window.__approves() };
      setTimeout(() => {
        approve.click();
        window.__g.early = window.__approves() - window.__g.before;
      }, 100);
      setTimeout(() => {
        window.__g.text = approve.textContent;
        window.__g.op = getComputedStyle(approve).opacity;
        window.__g.dis = approve.disabled;
        window.__g.aria = approve.getAttribute('aria-disabled');
        window.__g.live = document.getElementById('ph-live').textContent;
      }, 220);
      setTimeout(() => {
        approve.click();
        window.__g.late = window.__approves() - window.__g.before;
      }, 600);
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 900));
    const g = await js('window.__g');
    assert.ok(g.h >= 48 && g.dh >= 48, `approval buttons ${g.h} and ${g.dh} tall, want 48 or more`);
    assert.equal(g.denyLeft, true, 'Deny is not on the left of Approve');
    assert.equal(g.early, 0, 'an early tap sent POST /api/approve');
    assert.equal(g.text, 'Tap again', `the ignored tap did not say "Tap again": ${g.text}`);
    assert.equal(Number(g.op), 1, 'the ignored tap did not fill the button to 100 %');
    assert.equal(g.dis, false, 'the approval button was disabled while arming');
    assert.equal(g.aria, null, 'the approval button carries aria-disabled while arming');
    assert.match(g.live, /Tap again to approve/, 'the ignored tap was not announced');
    assert.equal(g.late, 1, 'the tap after the window did not send exactly one POST /api/approve');
  });

  test('P-12: a pointer tap within 250 ms after a scroll ends is ignored; keyboard activation is not', { skip: SKIP }, async () => {
    await js(`(() => { plenumPhoneDebug.approval({ id: "g-2", summary: "Run: npm run build", detail: "" }); return true; })()`);
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"g-2\\"] .ph-approve")')), 'card g-2 not decorated');
    await js(`(() => {
      const approve = document.querySelector('[data-approval-id="g-2"] .ph-approve');
      window.__s = { before: window.__approves() };
      setTimeout(() => {
        document.dispatchEvent(new Event('scroll'));
        setTimeout(() => {
          approve.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
          window.__s.blocked = window.__approves() - window.__s.before;
          window.__s.text = approve.textContent;
          setTimeout(() => {
            approve.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
            window.__s.after = window.__approves() - window.__s.before;
          }, 420);
        }, 170);
      }, 700);
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 1500));
    const s = await js('window.__s');
    assert.equal(s.blocked, 0, 'a tap right after a scroll sent POST /api/approve');
    assert.equal(s.text, 'Tap again');
    assert.equal(s.after, 1, 'the tap after the scroll window was not honoured once');
    await closeAll();
  });

  test('P-12: a drag of 10 px or more between down and up is not a tap', { skip: SKIP }, async () => {
    await js(`(() => { plenumPhoneDebug.approval({ id: "g-3", summary: "Run: npm run lint", detail: "" }); return true; })()`);
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"g-3\\"] .ph-deny")')), 'card g-3 not decorated');
    await js(`(() => {
      const deny = document.querySelector('[data-approval-id="g-3"] .ph-deny');
      const r = deny.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      window.__m = { before: window.__approves() };
      setTimeout(() => {
        const pt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch' };
        deny.dispatchEvent(new PointerEvent('pointerdown', { ...pt, clientX: x, clientY: y }));
        deny.dispatchEvent(new PointerEvent('pointermove', { ...pt, clientX: x + 30, clientY: y }));
        deny.dispatchEvent(new PointerEvent('pointerup', { ...pt, clientX: x + 30, clientY: y }));
        deny.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x + 30, clientY: y }));
        window.__m.blocked = window.__approves() - window.__m.before;
        window.__m.text = deny.textContent;
      }, 600);
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 900));
    const m = await js('window.__m');
    assert.equal(m.blocked, 0, 'a drag sent POST /api/approve');
    assert.equal(m.text, 'Tap again');
    await closeAll();
  });

  test('the card: "Deny with a reason…" reveals the 16 px field; scope buttons sit in a 44 px row above the answers', { skip: SKIP }, async () => {
    await js(`(() => {
      const card = document.createElement('div');
      card.className = 'approval';
      card.dataset.approvalId = 'g-4';
      const summary = document.createElement('span');
      summary.className = 'approval-summary';
      summary.textContent = 'Visit example.com';
      const reason = document.createElement('input');
      reason.type = 'text';
      reason.className = 'approval-reason';
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      const yes = document.createElement('button'); yes.textContent = 'Approve';
      const no = document.createElement('button'); no.textContent = 'Deny';
      const always = document.createElement('button'); always.textContent = 'Always allow example.com';
      actions.append(yes, no, always);
      card.append(summary, reason, actions);
      document.getElementById('chat').append(card);
      return true;
    })()`);
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"g-4\\"] .ph-scope")')), 'the scope row was not made');
    const r = await js(`(() => {
      const card = document.querySelector('[data-approval-id="g-4"]');
      const scopeBtn = card.querySelector('.ph-scope button');
      const link = card.querySelector('.ph-link-btn');
      const reason = card.querySelector('.approval-reason');
      const before = { hidden: reason.hidden, link: link ? link.textContent : null };
      if (link) link.click();
      const after = { hidden: reason.hidden, link: link ? link.textContent : null, focused: document.activeElement === reason, font: getComputedStyle(reason).fontSize };
      return { scope: scopeBtn ? scopeBtn.textContent : null, scopeH: scopeBtn ? scopeBtn.getBoundingClientRect().height : 0, inActions: !!card.querySelector('.approval-actions .ph-scope-btn'), before, after };
    })()`);
    assert.equal(r.scope, 'Always allow example.com', 'the scope button was not moved to the scope row');
    assert.ok(r.scopeH >= 44, `scope row ${r.scopeH} tall, want 44 or more`);
    assert.equal(r.inActions, false, 'the scope button is still among the answers');
    assert.equal(r.before.hidden, true, 'the reason field shows before it is asked for');
    assert.equal(r.before.link, 'Deny with a reason…');
    assert.equal(r.after.hidden, false, 'the reason field did not show after the link');
    assert.equal(r.after.link, 'Hide reason');
    assert.equal(r.after.focused, true, 'the reason field did not take the focus');
    assert.equal(r.after.font, '16px', `reason font ${r.after.font}`);
    await closeAll();
  });

  test('P-32: a password hand-over is type=password with autocomplete off; a code is numeric one-time-code; the buttons are 48 px', { skip: SKIP }, async () => {
    await js(handOverCardJs('pw', 'The model asks: "Enter your password"'));
    assert.ok(await waitFor(() => js('document.querySelector(".approval.typeit[data-handover=\\"pw\\"] .ph-secret") !== null')), 'the password box was not decorated');
    const pw = await js(`(() => {
      const card = document.querySelector('.approval.typeit[data-handover="pw"]');
      const box = card.querySelector('.approval-reason');
      return { type: box.type, auto: box.autocomplete, font: getComputedStyle(box).fontSize, btn: Math.min(...[...card.querySelectorAll('.approval-actions button')].map(b => b.getBoundingClientRect().height)) };
    })()`);
    assert.equal(pw.type, 'password');
    assert.equal(pw.auto, 'off');
    assert.equal(pw.font, '16px');
    assert.ok(pw.btn >= 48, `hand-over buttons ${pw.btn} tall`);
    await js(handOverCardJs('otp', 'The model asks: "Enter the 2FA code"'));
    assert.ok(await waitFor(() => js('document.querySelector(".approval.typeit[data-handover=\\"otp\\"] .ph-secret") !== null')), 'the code box was not decorated');
    const otp = await js(`(() => {
      const box = document.querySelector('.approval.typeit[data-handover="otp"] .approval-reason');
      return { type: box.type, mode: box.inputMode, auto: box.autocomplete };
    })()`);
    assert.equal(otp.type, 'text');
    assert.equal(otp.mode, 'numeric');
    assert.equal(otp.auto, 'one-time-code');
    await closeAll();
  });

  test('P-25: the connection strip shows the exact copy and tone, never over the title bar, and disables the approval buttons', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    const read = `(() => {
      const s = document.getElementById('ph-strip');
      const card = document.querySelector('[data-approval-id="g-3"]');
      const title = document.getElementById('titlebar').getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      return {
        hidden: s.hidden,
        text: s.querySelector('.ph-strip-text').textContent,
        tone: s.dataset.tone || '',
        below: sr.top >= title.bottom - 0.5,
        disabled: card ? [...card.querySelectorAll('.approval-actions > button')].map(b => b.disabled) : [],
        note: card && card.querySelector('.ph-off-note') ? card.querySelector('.ph-off-note').textContent : '',
      };
    })()`;
    await js("plenumPhoneDebug.connection('offline')");
    const off = await js(read);
    assert.equal(off.hidden, false, 'the strip is hidden when offline');
    assert.match(off.text, /^Can't reach Studio PC\. Last seen \d\d:\d\d\.$/);
    assert.equal(off.tone, 'bad');
    assert.equal(off.below, true, 'the strip overlaps the title bar');
    assert.ok(off.disabled.length > 0 && off.disabled.every(Boolean), 'the approval buttons are not disabled while offline');
    assert.equal(off.note, 'Reconnecting… answer when Studio PC is back.');
    await js("plenumPhoneDebug.connection('asleep')");
    const asleep = await js(read);
    assert.match(asleep.text, /^Studio PC is asleep or Plenum is closed\. Last seen \d\d:\d\d\. Plenum reconnects when it wakes\.$/);
    assert.equal(asleep.tone, 'muted');
    await js("plenumPhoneDebug.connection('phone-offline')");
    const phone = await js(read);
    assert.equal(phone.text, 'This phone is offline.');
    await js("plenumPhoneDebug.connection('reconnecting')");
    await new Promise(r => setTimeout(r, 1800));
    const rec = await js(read);
    assert.equal(rec.text, 'Reconnecting to Studio PC…');
    assert.equal(rec.tone, 'warn');
    await js("plenumPhoneDebug.connection('connected')");
    const back = await js(read);
    assert.equal(back.hidden, true, 'the strip stays up when connected');
    assert.ok(back.disabled.every(v => v === false), 'the approval buttons stay disabled after the connection is back');
    await closeAll();
  });

  test('P-26: tier approve and tier read replace the composer with the exact note; Stop stays present', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    const note = await js(`(() => { plenumPhoneDebug.tier('approve'); const n = document.getElementById('ph-tier-note'); return { composer: document.getElementById('composer').hidden, note: n && !n.hidden ? n.textContent : '', dock: !!document.querySelector('.ph-stop-dock') }; })()`);
    assert.equal(note.composer, true, 'the composer is still shown on approve');
    assert.equal(note.note, 'This phone can approve, deny and stop. Starting runs needs Full control, which you set at the computer under Settings › Phones.');
    assert.equal(note.dock, true, 'the Stop dock is missing');
    const read = await js(`(() => { plenumPhoneDebug.tier('read'); const n = document.getElementById('ph-tier-note'); return n && !n.hidden ? n.textContent : ''; })()`);
    assert.equal(read, 'This phone can watch and stop. Change it at the computer under Settings › Phones.');
    await js("plenumPhoneDebug.tier('full')");
    const full = await js('({ composer: document.getElementById("composer").hidden, note: document.getElementById("ph-tier-note").hidden })');
    assert.deepEqual(full, { composer: false, note: true }, 'full control shows the composer again');
  });

  test('P-31: a waiting approval of another project shows the bar with "other: …"; View opens Agents and changes no project or state', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    const before = await js('MuseUI.state.activeProject');
    await js('(window.__posts.length = 0, true)');
    await js(`(() => { plenumPhoneDebug.approval({ project: 'other', id: 'w-1', summary: 'Run: npm test' }); return true; })()`);
    const shown = await waitFor(() => js('(() => { const w = document.getElementById("ph-wait"); return !!w && !w.hidden; })()'));
    assert.ok(shown, 'the waiting bar did not show for another project');
    const text = await js('document.querySelector("#ph-wait .ph-wait-text").textContent');
    assert.equal(text, 'other: Run: npm test');
    await js(`(() => { document.querySelector('#ph-wait .ph-wait-view').click(); return true; })()`);
    await new Promise(r => setTimeout(r, 300));
    const tab = await js('document.documentElement.dataset.phTab');
    assert.equal(tab, 'agents', 'View did not open Agents');
    assert.equal(await js('MuseUI.state.activeProject'), before, 'View changed the active project');
    const posts = await h.eval('JSON.stringify(window.__posts)');
    assert.equal(JSON.parse(posts).length, 0, `View sent requests: ${posts}`);
    await closeAll();
  });

  test('P-33: stopState("driving") sets the ring on Stop, and Stop stays hittable with an approval waiting', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    await js('window.__ph.stand()');
    await js('plenumPhoneDebug.stopState("driving")');
    const r = await js(`(() => {
      const s = document.getElementById('plenum-stop');
      const rect = s.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { driving: s.dataset.driving || '', desc: s.getAttribute('aria-description') || '', hit: !!hit && (hit === s || s.contains(hit)), waiting: !document.getElementById('ph-wait').hidden };
    })()`);
    assert.equal(r.driving, 'computer', 'Stop has no driving mark');
    assert.match(r.desc, /A model is driving/);
    assert.equal(r.hit, true, 'Stop is not hittable while a model drives');
    assert.equal(r.waiting, true, 'the waiting bar is not shown with the drive indicator');
    await js('plenumPhoneDebug.stopState("idle")');
    await closeAll();
  });

  test('P-32 and 8.6: hand-over and approval cards never disable their buttons while they arm', { skip: SKIP }, async () => {
    const r = await js(`(() => { const b = document.querySelector('[data-approval-id="g-3"] .ph-deny'); return { dis: b ? b.disabled : null, aria: b ? b.getAttribute('aria-disabled') : null }; })()`);
    assert.equal(r.dis, false, 'a card button is disabled after the connection came back');
    assert.equal(r.aria, null);
  });

  test('P-36: the Newer pill shows while a reply streams far from the end; a tap scrolls to the end and hides it', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    await js('window.__ph.stand()');
    await js(`(() => {
      const chat = document.getElementById('chat');
      for (let i = 0; i < 60; i++) { const p = document.createElement('p'); p.dataset.filler = '1'; p.textContent = 'Filler line ' + i; chat.append(p); }
      MuseUI.state.running = true;
      chat.scrollTop = chat.scrollHeight;
      chat.scrollTop = 0;
      chat.dispatchEvent(new Event('scroll'));
      return true;
    })()`);
    const shown = await waitFor(() => js('!document.querySelector(".ph-newer").hidden'), 4000);
    assert.ok(shown, 'the Newer pill did not show');
    const geo = await js(`(() => {
      const p = document.querySelector('.ph-newer').getBoundingClientRect();
      const s = document.getElementById('plenum-stop').getBoundingClientRect();
      const overlap = !(s.right <= p.left || s.left >= p.right || s.bottom <= p.top || s.top >= p.bottom);
      return { h: p.height, overlap, text: document.querySelector('.ph-newer').textContent };
    })()`);
    assert.ok(geo.h >= 44, `pill ${geo.h} tall`);
    assert.equal(geo.overlap, false, 'the pill covers Stop');
    assert.equal(geo.text, '↓ Newer');
    await js(`(() => { document.querySelector('.ph-newer').click(); return true; })()`);
    // The smooth scroll finishes in a hidden window after a while, so the end is waited for rather than timed.
    await waitFor(() => js('(() => { const c = document.getElementById("chat"); return c.scrollHeight - c.scrollTop - c.clientHeight <= 180; })()'), 6000);
    const end = await js(`(() => { const c = document.getElementById('chat'); return { hidden: document.querySelector('.ph-newer').hidden, far: c.scrollHeight - c.scrollTop - c.clientHeight }; })()`);
    assert.equal(end.hidden, true, 'the pill is still shown after the tap');
    assert.ok(end.far <= 180, `the transcript is still ${end.far} px from its end`);
    await js(`(() => { MuseUI.state.running = false; document.querySelectorAll('#chat > p[data-filler="1"]').forEach(p => p.remove()); return true; })()`);
    await closeAll();
  });

  test('P-36: a 500 ms hold on Chat opens the thread sheet and on Projects the computers sheet', { skip: SKIP }, async () => {
    await js(`(() => { const b = document.querySelector('.ph-bar-item[data-tab="chat"]'); const r = b.getBoundingClientRect(); window.__hold = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; return true; })()`);
    await js(`(() => {
      const b = document.querySelector('.ph-bar-item[data-tab="chat"]');
      const { x, y } = window.__hold;
      const pt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: y };
      b.dispatchEvent(new PointerEvent('pointerdown', pt));
      setTimeout(() => b.dispatchEvent(new PointerEvent('pointerup', pt)), 520);
      return true;
    })()`);
    const threads = await waitFor(() => js('!!document.querySelector(".ph-sheet-title") && /Threads in/.test(document.querySelector(".ph-sheet-title").textContent)'), 3000);
    assert.ok(threads, 'the hold on Chat did not open the thread sheet');
    await closeAll();
    await js('plenumPhoneDebug.tab("projects")');
    await js(`(() => {
      const b = document.querySelector('.ph-bar-item[data-tab="projects"]');
      const r = b.getBoundingClientRect();
      const pt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      b.dispatchEvent(new PointerEvent('pointerdown', pt));
      setTimeout(() => b.dispatchEvent(new PointerEvent('pointerup', pt)), 520);
      return true;
    })()`);
    const computers = await waitFor(() => js('!!document.querySelector(".ph-sheet-title") && document.querySelector(".ph-sheet-title").textContent === "Computers"'), 3000);
    assert.ok(computers, 'the hold on Projects did not open the computers sheet');
    await closeAll();
  });

  test('8.4.5: the turn sheet offers Report this reply; the report has three reasons, Save, Open an issue and a Send by email that names no invented address', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    await js(`(() => {
      const chat = document.getElementById('chat');
      const t = document.createElement('div');
      t.className = 'turn';
      t.dataset.phTest = 'report';
      const head = document.createElement('div');
      head.className = 'turn-head';
      const who = document.createElement('span'); who.className = 'who'; who.textContent = 'Claude Code';
      const when = document.createElement('span'); when.className = 'when'; when.textContent = '22 Oct 2026, 14:02';
      head.append(who, when);
      const body = document.createElement('div'); body.className = 'turn-body'; body.textContent = 'The reply text.';
      t.append(head, body);
      chat.append(t);
      return true;
    })()`);
    assert.ok(await waitFor(() => js('!!document.querySelector(\'[data-ph-test="report"] .ph-turn-more\')')), 'the reply has no More button');
    await js(`(() => { document.querySelector('[data-ph-test="report"] .ph-turn-more').click(); return true; })()`);
    assert.ok(await waitFor(() => js('!!Array.from(document.querySelectorAll(".ph-sheet .ph-row")).find(b => b.textContent.includes("Report this reply"))')), 'Report this reply is not in the turn sheet');
    await js(`(() => { Array.from(document.querySelectorAll(".ph-sheet .ph-row")).find(b => b.textContent.includes("Report this reply")).click(); return true; })()`);
    assert.ok(await waitFor(() => js('document.querySelector(".ph-sheet-report") !== null')), 'the report sheet did not open');
    const r = await js(`(() => {
      const sheet = document.querySelector('.ph-sheet-report');
      const radios = [...sheet.querySelectorAll('.ph-opt')].map(b => b.textContent);
      const buttons = [...sheet.querySelectorAll('button')].map(b => b.textContent);
      const email = [...sheet.querySelectorAll('.ph-row')].find(b => b.textContent.includes('Send by email'));
      return { radios, buttons, emailDisabled: email ? email.getAttribute('aria-disabled') : null, note: sheet.textContent.includes('not your files') };
    })()`);
    assert.deepEqual(r.radios, ['Harmful or unsafe', 'Wrong or misleading', 'Something else']);
    assert.ok(r.buttons.some(t => t.includes('Save report')), 'no Save report');
    assert.ok(r.buttons.some(t => t.includes('Open an issue')), 'no Open an issue');
    assert.equal(r.emailDisabled, 'true', 'Send by email is offered without a contact address');
    assert.equal(r.note, true, 'the report does not say what it holds');
    await closeAll();
  });

  test('8.4.3: an "Sign in to" button opens "Finish this sign-in on your computer" and sends nothing by itself', { skip: SKIP }, async () => {
    await js(`(() => { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Sign in to Codex'; b.dataset.phTest = 'signin'; document.getElementById('chat').append(b); return true; })()`);
    await js('(window.__posts.length = 0, true)');
    await js(`(() => { document.querySelector('[data-ph-test="signin"]').click(); return true; })()`);
    assert.ok(await waitFor(() => js('!!Array.from(document.querySelectorAll(".ph-sheet-title")).find(h => h.textContent === "Finish this sign-in on your computer")')), 'the sign-in sheet did not open');
    const note = await js('document.querySelector(".ph-sheet-note") ? document.querySelector(".ph-sheet-note").textContent : ""');
    assert.equal(note, 'Signing in to Codex opens a browser window on Studio PC. Plenum starts it now; finish it at the computer.');
    assert.equal(JSON.parse(await h.eval('JSON.stringify(window.__posts)')).length, 0, 'opening the sheet sent a request');
    await closeAll();
    await js(`(() => { document.querySelector('[data-ph-test="signin"]').remove(); return true; })()`);
  });

  test('8.11: a tap on the Browser picture is not input in v1; it says so once', { skip: SKIP }, async () => {
    await js('plenumPhoneDebug.tab("chat")');
    await js(`(() => { const img = document.createElement('img'); img.className = 'ext-brw-shot'; img.alt = ''; img.dataset.phTest = 'shot'; document.getElementById('chat').append(img); return true; })()`);
    await js(`(() => { document.querySelector('[data-ph-test="shot"]').click(); return true; })()`);
    const first = await waitFor(() => js('Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("This is a picture of the page on Studio PC."))'), 3000);
    assert.ok(first, 'the picture tap did not say what it is');
    await js(`(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); document.querySelector('[data-ph-test="shot"]').click(); return true; })()`);
    await new Promise(r => setTimeout(r, 300));
    const again = await js('document.querySelectorAll(".toast").length');
    assert.equal(again, 0, 'the picture toast was shown twice');
    await js(`(() => { document.querySelector('[data-ph-test="shot"]').remove(); return true; })()`);
  });

  test('P-28: Settings opens with "This phone" in it, and Add phone is hidden on the phone', { skip: SKIP }, async () => {
    await js('MuseUI.openSettings()');
    const seen = await waitFor(() => js('document.getElementById("settingsPage").textContent.includes("Notifications, app lock, appearance and ways to reach Studio PC are set on the phone.")'), 5000);
    assert.ok(seen, 'the This phone section did not render in Settings');
    const add = await js('Array.from(document.querySelectorAll("#settingsPage button")).filter(b => b.textContent.trim() === "Add phone").map(b => b.hidden)');
    assert.ok(add.every(Boolean), 'Add phone is shown on the phone');
    await closeAll();
  });

  // The new states at every size, theme and zoom: a waiting card, a waiting card of another project, the offline strip and the read tier.
  // P-01 (no horizontal scroll), P-02 (targets), P-03 (16 px inputs) and P-04 (Stop hittable) are checked on each state.
  const P2_ONLY = process.env.MOB11_P2_ONLY ? process.env.MOB11_P2_ONLY.split(',') : null;
  for (const v of VIEWS.filter(x => !P2_ONLY || P2_ONLY.includes(x.name))) {
    for (const theme of THEMES) {
      for (const zoom of ZOOMS) {
        const cfg = `p2 ${v.name} ${theme} z${zoom}`;
        test(`${cfg}: the approval card, the waiting bar, the strip and the tier note keep P-01 to P-04`, { skip: SKIP, timeout: 300_000 }, async () => {
          await openPhone(v, theme);
          if (zoom !== 1) await js(`plenumPhoneDebug.textZoom(${zoom})`);
          await js('plenumPhoneDebug.tab("chat")');
          await js(`(() => {
            plenumPhoneDebug.approval({ id: "s-1", summary: "Run: npm test -- --watch=false", detail: "npm test -- --watch=false\\nrunning 3 suites" });
            plenumPhoneDebug.approval({ project: "other", id: "s-2", summary: "Run: npm run build" });
            return true;
          })()`);
          await new Promise(r => setTimeout(r, 480));
          const shot = (name) => (v.name === '360x780' || v.name === '390x844') && zoom === 1 ? h.shot(`${name}-${v.name}-${theme}`).catch(() => {}) : null;
          const audit = async label => {
            const pg = await js('({ h: __ph.hOverflow(), wide: __ph.wide(), small: __ph.small(), inputs: __ph.inputs() })');
            if (pg.h) log(cfg, `${label}: P-01 horizontal scroll`);
            if (pg.wide.length) log(cfg, `${label}: P-01 wider than the screen: ${pg.wide.join(' | ')}`);
            if (pg.small.length) log(cfg, `${label}: P-02 small targets: ${pg.small.slice(0, 4).join(' | ')}`);
            if (pg.inputs) log(cfg, `${label}: P-03 ${pg.inputs} input(s) under 16 px`);
            await checkFrame(`${cfg} ${label}`, v, zoom);
          };
          await audit('approval and waiting');
          await shot('m11p2-approval');
          await js(`plenumPhoneDebug.connection('offline')`);
          await new Promise(r => setTimeout(r, 120));
          const stripShown = await js('!document.getElementById("ph-strip").hidden');
          if (!stripShown) log(cfg, 'P-25 the offline strip is not shown');
          await audit('offline strip');
          await shot('m11p2-strip');
          await js(`plenumPhoneDebug.connection('connected')`);
          await js(`plenumPhoneDebug.tier('read')`);
          const noteShown = await js('!document.getElementById("ph-tier-note").hidden && document.getElementById("composer").hidden');
          if (!noteShown) log(cfg, 'P-26 the read tier does not replace the composer');
          await audit('read tier');
          await shot('m11p2-tier-read');
          await js(`plenumPhoneDebug.tier('full')`);
          await closeAll();
        });
      }
    }
  }

  test('the suite leaves no failure behind (part 2)', () => {
    assert.deepEqual(fails, [], `${fails.length} phone-layer check(s) failed:\n${fails.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Phone layer, part 3 (stabilization track A, fixer 6): the checks the wave 107 builder left open (L16: P-09, P-29, P-30, P-37's phone side,
// the Settings notes, the Computers sheet, Send by email), the phone side of H7 (a notification names a place), M6 (Back and history), M9 (a
// read-tier HELLO), F4 (Lock now only when a lock is set), L18 (the composer's mic) and M14 (the approval guard keyed by id, the "answered"
// toast only after the computer's event, and an approval answered through the real UI against the mock model).
//   MOB11_PART=p3 node build/mobile/run.mjs --id stabm-6 ui-phone.test.mjs
// ---------------------------------------------------------------------------------------------------------------------------------------

// Colours and the Review/fetch stand-ins, installed once per page load. contrast(sel, bgSel) is the WCAG ratio of the element's text colour
// over the colour behind it (every translucent layer up the tree composited); a canvas turns any CSS colour (color-mix, oklab) into RGBA.
// plenumPhoneDebug.approval appends its card to the chat. A repaint of the chat from the desktop's own state can drop a card it did not build,
// so until readyJs is true (or ms pass) the check puts the card back whenever it is missing. It never adds a second card while one is on the page.
async function keepDebugCard(id, opts, readyJs, ms) {
  const until = Date.now() + ms;
  const card = JSON.stringify(`[data-approval-id="${id}"]`);
  const args = JSON.stringify({ id, ...opts });
  for (;;) {
    await js(`(() => { if (!document.querySelector(${card})) plenumPhoneDebug.approval(${args}); return true; })()`);
    if (await js(readyJs)) return true;
    if (Date.now() > until) return false;
    await new Promise(r => setTimeout(r, 50));
  }
}

const P3_PAGE = String.raw`(function () {
  if (window.__p3) return true;
  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = v => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000000'; cx.fillStyle = v; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
  const back = el => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    let acc = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const lum = c => { const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const nativeFetch = window.fetch.bind(window);
  window.__review = null;
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (window.__review && /\/api\/review\/changes\?/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify(window.__review), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return nativeFetch(input, init);
  };
  window.__p3 = {
    // The ratio of the first visible element that matches sel, over the background of bgSel (default: the element itself and its parents).
    contrast: (sel, bgSel) => {
      const el = [...document.querySelectorAll(sel)].find(visible);
      if (!el) return null;
      const bgEl = bgSel ? document.querySelector(bgSel) : el;
      const fg = rgba(getComputedStyle(el).color);
      const stops = [...getComputedStyle(bgEl || el).backgroundImage.matchAll(/rgba?\([^)]+\)|color\([^)]+\)/g)].map(m => rgba(m[0]));
      if (stops.length) {
        const base = back((bgEl || el).parentElement || bgEl || el);
        return Math.min(...stops.map(c => { const bg = over(c, base); return ratio(over(fg, bg), bg); }));
      }
      const bg = back(bgEl || el);
      return ratio(over(fg, bg), bg);
    },
    tab: () => { const b = document.querySelector('.ph-bar-item[aria-current="page"]'); return b ? b.dataset.tab : ''; },
    describe: sel => { const el = [...document.querySelectorAll(sel)].find(visible); if (!el) return null; const s = getComputedStyle(el); return { cls: el.className, color: s.color, bg: s.backgroundColor, bgImage: s.backgroundImage.slice(0, 60), opacity: s.opacity, parentBg: getComputedStyle(el.parentElement).backgroundColor }; },
    toasts: () => [...document.querySelectorAll('.toast')].map(t => t.textContent),
    clearToasts: () => { document.querySelectorAll('.toast').forEach(t => t.remove()); return true; },
    sheetRows: () => [...document.querySelectorAll('.ph-sheet .ph-row')].map(r => ({ label: (r.querySelector('.ph-row-label') || r).textContent, note: (r.querySelector('.ph-row-note') || {}).textContent || '', checked: !!r.querySelector('.ph-check'), disabled: r.getAttribute('aria-disabled') === 'true' })),
    pickRow: label => { const r = [...document.querySelectorAll('.ph-sheet .ph-row')].find(x => ((x.querySelector('.ph-row-label') || x).textContent) === label); if (!r) return false; r.click(); return true; },
  };
  return true;
})()`;

// What git would report for three files, in the answer shape of /api/review/changes. app.js has a line far wider than a phone.
const LONG_LINE = `const message = '${'a long line of code that does not fit in a phone and has to wrap or scroll '.repeat(4)}';`;
function reviewDiff(lines) {
  return ['diff --git a/x b/x', 'index 1111111..2222222 100644', '--- a/x', '+++ b/x', ...lines].join('\n');
}
const REVIEW_FIXTURE = {
  source: 'git',
  branch: 'plenum/fix-login',
  truncated: false,
  note: null,
  groups: {
    unstaged: [
      { path: 'src/app.js', status: 'M', added: 3, removed: 1, diffHash: 'h-app', binary: false, tooLarge: false, capped: false, diff: reviewDiff(['@@ -10,4 +10,6 @@ function login', ' const a = 1;', '-const b = 2;', '+const b = 3;', `+${LONG_LINE}`, '+const d = 5;', ' const c = 4;']) },
      { path: 'src/login.js', status: 'A', added: 3, removed: 0, diffHash: 'h-login', binary: false, tooLarge: false, capped: false, diff: reviewDiff(['@@ -0,0 +1,3 @@', '+export function login() {', '+  return true;', '+}']) },
      { path: 'old/legacy.js', status: 'D', added: 0, removed: 2, diffHash: 'h-legacy', binary: false, tooLarge: false, capped: false, diff: reviewDiff(['@@ -1,2 +0,0 @@', '-export const legacy = 1;', '-export const gone = 2;']) },
    ],
  },
};

// A press and release on a bottom-bar item, 520 ms apart (the bar's long press).
function holdTabJs(tab) {
  return `(() => {
    const b = document.querySelector('.ph-bar-item[data-tab="${tab}"]');
    const r = b.getBoundingClientRect();
    const pt = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    b.dispatchEvent(new PointerEvent('pointerdown', pt));
    setTimeout(() => b.dispatchEvent(new PointerEvent('pointerup', pt)), 520);
    return true;
  })()`;
}

// A project is active (the Review and Agents panes read the active project).
async function activeProject() {
  await waitFor(() => js('!!(window.MuseUI && MuseUI.state && Array.isArray(MuseUI.state.projects) && MuseUI.state.projects.length)'), 20000);
  if (!(await js('!!MuseUI.state.activeProject'))) await js('(() => { document.querySelector(".proj-item").click(); return true; })()');
  assert.ok(await waitFor(() => js('!!MuseUI.state.activeProject'), 10000), 'no project became active');
  return js('MuseUI.state.activeProject');
}

// The page draws the thread's saved messages some moments after it opens, replacing what the chat holds. A check that adds a card or a
// reply of its own waits for that first, or the page removes it.
async function settleChat() {
  await waitFor(() => js('!!(window.MuseUI && Array.isArray(MuseUI.state.messages) && (MuseUI.state.messages.length === 0 || document.querySelector("#chat .turn")))'), 5000);
  await new Promise(r => setTimeout(r, 400));
}

// A side pane's tab opens once the pane has registered (the panels load one after the other, and slower on a busy machine).
async function openPaneTab(name) {
  assert.ok(await waitFor(() => js(`MuseUI.pane.list().includes(${JSON.stringify(name)})`), 30000), `the ${name} pane never registered`);
  await js(`plenumPhoneDebug.tab(${JSON.stringify(name)})`);
}

async function sendFromComposer(text) {
  await js(`(() => {
    const input = document.getElementById('input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
    return true;
  })()`);
}

describe('phone layer part 3 (stabilization): the checks left open, routes, back, mic, the approval guard', { skip: SKIP || skipUnless('p3'), timeout: 1_500_000 }, () => {
  before(async () => {
    if (SKIP) return;
    h = await startPhoneHarness({ name: 'stabm6-phone-p3', mock: true, projects: ['p1', 'p2', 'p3'] });
  });

  after(async () => {
    if (!h) return;
    const left = await h.close();
    h = null;
    assert.deepEqual(left.leftover, [], 'processes left behind');
  });

  test('P-29: Review lists the files in 56 px rows, Previous, Viewed and Next walk the diffs, Wrap is on by default and Wrap off scrolls only the diff lines', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P2_PAGE);
    await h.eval(P3_PAGE);
    await js(`(window.__review = ${JSON.stringify(REVIEW_FIXTURE)}, true)`);
    await activeProject();
    await openPaneTab('review');
    assert.ok(await waitFor(() => js('document.querySelectorAll(".ext-review-row").length === 3'), 30000), 'the three files were not listed');

    const list = await js(`(() => ({
      heights: [...document.querySelectorAll('.ext-review-row')].map(r => Math.round(r.getBoundingClientRect().height)),
      small: __ph.small(document.querySelector('.ext-review')),
      unnamed: __ph.unnamed(document.querySelector('.ext-review')),
      hOverflow: __ph.hOverflow(),
      nav: !!document.querySelector('.ph-review-nav'),
    }))()`);
    assert.ok(list.heights.every(n => n >= 55), `rows are 56 px or more: ${list.heights}`);
    assert.deepEqual(list.small, [], 'every control in the Review list is 44 px or more');
    assert.deepEqual(list.unnamed, [], 'every control in the Review list has a name');
    assert.equal(list.hOverflow, false, 'the list does not scroll sideways');
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-review-nav") && !!document.querySelector(".ext-review-lines")'), 5000), 'the Previous/Viewed/Next bar did not appear under the diff');

    const nav = () => js(`(() => {
      const n = document.querySelector('.ph-review-nav');
      const title = document.querySelector('.ext-review-file-title');
      const viewed = n.querySelector('.ph-review-viewed');
      const r = n.querySelector('.ph-review-prev').getBoundingClientRect();
      return { where: n.querySelector('.ph-review-where').textContent, prev: !n.querySelector('.ph-review-prev').disabled, next: !n.querySelector('.ph-review-next').disabled, viewed: viewed.textContent, pressed: viewed.getAttribute('aria-pressed'), title: title ? title.textContent : '', h: Math.round(r.height), top: document.querySelector('.ext-review-diff').scrollTop };
    })()`);
    const click = sel => js(`(() => { document.querySelector(${JSON.stringify(sel)}).click(); return true; })()`);
    const settle = () => new Promise(r => setTimeout(r, 120));

    let s = await nav();
    assert.deepEqual([s.where, s.prev, s.next, s.title], ['1 of 3', false, true, 'src/app.js'], 'the first file is open, Previous is off');
    assert.ok(s.h >= 47, `the bar's buttons are 48 px: ${s.h}`);

    // Wrap is on by default: the long line wraps inside the width, and nothing scrolls sideways.
    const wrapped = await js(`(() => {
      const lines = document.querySelector('.ext-review-lines');
      const wrap = document.querySelector('.ph-wrap');
      return { pressed: wrap.getAttribute('aria-pressed'), ws: getComputedStyle(lines).whiteSpace, fits: lines.scrollWidth <= lines.clientWidth + 1, page: __ph.hOverflow(), wide: __ph.wide() };
    })()`);
    assert.equal(wrapped.pressed, 'true', 'Wrap is on by default');
    assert.equal(wrapped.ws, 'pre-wrap');
    assert.equal(wrapped.fits, true, 'with Wrap on the diff lines do not overflow');
    assert.equal(wrapped.page, false, 'with Wrap on the page does not scroll sideways');
    assert.deepEqual(wrapped.wide, [], 'with Wrap on nothing is wider than the screen');

    // Wrap off: only the diff's own lines scroll.
    await click('.ph-wrap');
    await settle();
    const unwrapped = await js(`(() => {
      const lines = document.querySelector('.ext-review-lines');
      const scrollers = [...document.querySelectorAll('.ext-review *')].filter(e => e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).map(e => e.className);
      return { cls: lines.className, ws: getComputedStyle(lines).whiteSpace, scrolls: lines.scrollWidth > lines.clientWidth + 1, page: __ph.hOverflow(), scrollers, pressed: document.querySelector('.ph-wrap').getAttribute('aria-pressed') };
    })()`);
    assert.equal(unwrapped.pressed, 'false');
    assert.match(unwrapped.cls, /ph-nowrap/);
    assert.equal(unwrapped.ws, 'pre');
    assert.equal(unwrapped.scrolls, true, 'with Wrap off the diff lines scroll sideways');
    assert.equal(unwrapped.page, false, 'with Wrap off the page still does not scroll sideways');
    assert.deepEqual(unwrapped.scrollers, ['ext-review-lines ph-nowrap'], 'only .ext-review-lines scrolls sideways');

    // Next, Next, Previous: the position, the title and the buttons follow, and the Wrap choice stays with the person.
    await click('.ph-review-next');
    await settle();
    s = await nav();
    assert.deepEqual([s.where, s.prev, s.next, s.title], ['2 of 3', true, true, 'src/login.js']);
    assert.ok(await waitFor(() => js('document.querySelector(".ph-wrap") && document.querySelector(".ph-wrap").getAttribute("aria-pressed") === "false" && document.querySelector(".ext-review-lines").classList.contains("ph-nowrap")'), 3000), 'Wrap off is kept for the next file');
    await click('.ph-review-next');
    await settle();
    s = await nav();
    assert.deepEqual([s.where, s.prev, s.next, s.title], ['3 of 3', true, false, 'old/legacy.js'], 'on the last file Next is off');
    await click('.ph-review-prev');
    await settle();
    s = await nav();
    assert.deepEqual([s.where, s.title], ['2 of 3', 'src/login.js']);

    // Viewed ticks the file's row, and ticks it off again.
    await click('.ph-review-viewed');
    await settle();
    s = await nav();
    assert.deepEqual([s.viewed, s.pressed], ['Viewed ✓', 'true']);
    assert.equal(await js('document.querySelectorAll(".ext-review-row.is-viewed").length'), 1, 'the row of the open file is marked viewed');
    await click('.ph-review-viewed');
    await settle();
    s = await nav();
    assert.deepEqual([s.viewed, s.pressed], ['Viewed', 'false']);
    assert.equal(await js('document.querySelectorAll(".ext-review-row.is-viewed").length'), 0);

    // Wrap back on for whoever looks next, and the frame holds P-01 to P-04.
    await click('.ph-wrap');
    await settle();
    await checkFrame('p3 review', VIEWS[1], 1);
    await h.shot('stabm6-review-390x844-light').catch(() => {});
    await js('(window.__review = null, true)');
    await closeAll();
  });

  test('P-30: Agents rows are 56 px, and the Stop of a running agent is named by its run and its project', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P2_PAGE);
    await h.eval(P3_PAGE);
    const project = await activeProject();
    await js('plenumPhoneDebug.tab("chat")');
    const gate = h.mock.gate('g30');
    await sendFromComposer('AGENT:g30 start a researcher');
    const held = await Promise.race([gate.reached.then(() => true), new Promise(r => setTimeout(() => r(false), 30000))]);
    assert.ok(held, `the mock model never saw the agent's request; model log: ${JSON.stringify(h.mock.log.map(e => e.user.slice(0, 60)))}; model in the page: ${await js('MuseUI.state.model')}`);
    await openPaneTab('agents');
    assert.ok(await waitFor(() => js('!!document.querySelector(".ext-agl .ext-agl-row .ext-agl-stop")'), 30000), 'the running agent has no row with a Stop');
    // The board draws the run's heading a moment after its agent rows; the Stop names the project once the heading is there.
    await waitFor(() => js(`(() => { const name = (MuseUI.state.projects.find(p => p.id === MuseUI.state.activeProject) || {}).name || ''; const stops = [...document.querySelectorAll('.ext-agl .ext-agl-row .ext-agl-stop')]; return stops.length > 0 && stops.every(b => (b.getAttribute('aria-label') || '').includes(name)); })()`), 15000);
    const rows = await js(`(() => {
      const projectName = (MuseUI.state.projects.find(p => p.id === MuseUI.state.activeProject) || {}).name || '';
      const stops = [...document.querySelectorAll('.ext-agl .ext-agl-row .ext-agl-stop')].map(b => {
        const row = b.closest('.ext-agl-row');
        const title = (row.querySelector('.ext-agl-title') || {}).textContent || '';
        const r = b.getBoundingClientRect();
        return { label: b.getAttribute('aria-label'), title: title.trim(), rowH: Math.round(row.getBoundingClientRect().height), w: Math.round(r.width), h: Math.round(r.height) };
      });
      return { projectName, stops, small: __ph.small(document.querySelector('.ext-agl')), unnamed: __ph.unnamed(document.querySelector('.ext-agl')) };
    })()`);
    assert.ok(rows.stops.length >= 1, 'no Stop in the agent list');
    for (const stop of rows.stops) {
      assert.ok(stop.rowH >= 55, `the row is 56 px or more: ${stop.rowH}`);
      assert.ok(stop.w >= 43.5 && stop.h >= 43.5, `the Stop is 44 px or more: ${stop.w}x${stop.h}`);
      assert.ok(stop.title, 'the row has a name');
      assert.ok(stop.label.startsWith('Stop '), `the Stop is named "Stop ...": ${stop.label}`);
      assert.ok(stop.label.includes(stop.title), `the Stop names the run's agent (${stop.title}): ${stop.label}`);
      assert.ok(rows.projectName && stop.label.includes(rows.projectName), `the Stop names the project (${rows.projectName}): ${stop.label}`);
    }
    assert.deepEqual(rows.unnamed, [], 'every control in the agent list has a name');
    gate.release();
    // The agent finishes and the run ends: the Stop goes.
    assert.ok(await waitFor(() => js('!document.querySelector(".ext-agl .ext-agl-row .ext-agl-stop")'), 30000), 'the Stop stayed after the agent finished');
    await closeAll();
    void project;
  });

  for (const theme of THEMES) {
    test(`P-09 (${theme}): the strip, the waiting bar, the badges, the muted lines, the approval buttons and Stop keep 4.5:1`, { skip: SKIP }, async () => {
      await openPhone(VIEWS[1], theme);
      await h.eval(P3_PAGE);
      await js('plenumPhoneDebug.tab("chat")');
      await settleChat();
      assert.ok(await waitFor(() => js('MuseUI.pane.list().includes("agents")'), 30000), 'the agents pane never registered');
      await js(`(() => {
        plenumPhoneDebug.approval({ id: "c-1", summary: "Run: npm test -- --watch=false", detail: "npm test" });
        plenumPhoneDebug.approval({ project: "other", id: "c-2", summary: "Run: npm run build" });
        plenumPhoneDebug.connection("connected", "Studio PC");
        const stop = __ph.stand();
        stop.dataset.active = "1";
        return true;
      })()`);
      assert.ok(await waitFor(() => js('!!document.querySelector(".ph-approve") && !!document.querySelector(".ph-wait-text")'), 15000), 'the approval card or the waiting bar did not show');
      const approveOnScreen = 'Array.from(document.querySelectorAll(".ph-approve")).some(b => b.getClientRects().length > 0)';
      const cardC1 = { summary: 'Run: npm test -- --watch=false', detail: 'npm test' };
      assert.ok(await keepDebugCard('c-1', cardC1, approveOnScreen, 8000), 'the approval card did not come on screen');
      await new Promise(r => setTimeout(r, 700));
      assert.ok(await keepDebugCard('c-1', cardC1, approveOnScreen, 8000), 'the approval card left the screen before the contrast check');
      const checks = {};
      const take = async (name, sel, bgSel) => {
        const v = await js(`__p3.contrast(${JSON.stringify(sel)}${bgSel ? `, ${JSON.stringify(bgSel)}` : ''})`);
        if (v !== null) checks[name] = v;
        return v;
      };
      // The buttons first: the offline strip disables them, and a disabled control is dimmed.
      await take('approve', '.ph-approve');
      await take('deny', '.ph-deny');
      await js(`(() => {
        plenumPhoneDebug.connection("offline");
        // The bar's badge copies the Agents pane button's badge; give that one a waiting count, as the board does.
        const hold = () => {
          const btn = document.querySelector('#paneButtons [data-pane="agents"]');
          if (!btn) return;
          let pb = btn.querySelector('.badge');
          if (!pb) { pb = document.createElement('span'); pb.className = 'badge'; btn.append(pb); }
          pb.hidden = false;
          pb.textContent = '2';
          pb.dataset.tone = 'amber';
        };
        hold();
        window.__badgeTimer = setInterval(hold, 30);
        return true;
      })()`);
      assert.ok(await waitFor(() => js('!!document.querySelector(".ph-bar-badge[data-tone=\\"amber\\"]:not([hidden])")'), 10000), 'the bar did not show the waiting count');
      await take('strip', '#ph-strip');
      await take('waiting bar text', '.ph-wait-text');
      await take('waiting bar action', '.ph-wait-view');
      await take('amber badge', '.ph-bar-badge[data-tone="amber"]');
      await take('bar label', '.ph-bar-item:not([aria-current]) .ph-bar-label');
      await take('stop active', '#plenum-stop .plenum-stop-label', '#plenum-stop');
      // A sheet's muted lines: the Connection sheet has a note and row notes.
      await js('(() => { document.querySelector(".ph-chip-conn").click(); return true; })()');
      assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000), 'the connection sheet did not open');
      await take('sheet note', '.ph-sheet-note');
      await take('sheet row note', '.ph-row-note');
      await closeAll();
      // Settings: the This phone lines and the notes added to the desktop's sections.
      await js('MuseUI.openSettings("appearance")');
      assert.ok(await waitFor(() => js('!!document.querySelector("#settingsPage .ph-settings-note")'), 8000), 'no Settings note');
      await take('settings note', '#settingsPage .ph-settings-note');
      await take('this phone line', '#settingsPage .ph-note-line');
      await closeAll();
      const failing = Object.entries(checks).filter(([, v]) => v < 4.5).map(([k, v]) => `${k} ${v.toFixed(2)}`);
      const why = failing.length ? JSON.stringify(await Promise.all(['.ph-approve', '.ph-deny', '#ph-strip', '.ph-wait-view', '.ph-bar-badge[data-tone="amber"]'].map(sel => js(`__p3.describe(${JSON.stringify(sel)})`)))) : '';
      assert.deepEqual(failing, [], `contrast under 4.5 in ${theme}: ${failing.join(', ')} (measured ${JSON.stringify(checks)}; ${why})`);
      for (const name of ['strip', 'waiting bar text', 'amber badge', 'bar label', 'approve', 'stop active']) {
        assert.ok(name in checks, `${name} was not on screen to measure (measured: ${Object.keys(checks)}; pane badge: ${await js(`(() => { const p = document.querySelector('#paneButtons [data-pane="agents"] .badge'); const b = document.querySelector('.ph-bar-badge'); return JSON.stringify([p && p.outerHTML, b && b.outerHTML, b && JSON.stringify(b.getBoundingClientRect())]); })()`)})`);
      }
    });
  }

  test('8.12: the desktop Settings sections carry the phone notes (Theme, API keys, Music), once each, with the computer\'s name', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.connection("connected", "Studio PC")');
    const wanted = [
      ['appearance', 'This sets the theme on Studio PC. The phone follows Phone settings › Appearance.'],
      ['api-keys', 'Sent encrypted to Studio PC and kept in its key store.'],
      ['music', 'Music plays on the screen that turned it on.'],
    ];
    for (const [section, copy] of wanted) {
      await js(`MuseUI.openSettings(${JSON.stringify(section)})`);
      const seen = await waitFor(() => js(`(() => { const n = document.querySelector('#settingsPage [data-section="${section}"] .ph-settings-note'); return !!n && n.textContent === ${JSON.stringify(copy)}; })()`), 8000);
      assert.ok(seen, `${section}: the note "${copy}" is not in its section; cards: ${await js('JSON.stringify([...document.querySelectorAll("#settingsPage .settings-card")].map(c => [c.dataset.section, (c.querySelector(".ph-settings-note") || {}).textContent || null]))')}`);
      await new Promise(r => setTimeout(r, 400));
      assert.equal(await js(`document.querySelectorAll('#settingsPage [data-section="${section}"] .ph-settings-note').length`), 1, `${section}: the note is there once`);
      await closeAll();
    }
    // The API key note sits under the key fields; the fields are 16 px passwords.
    await js('MuseUI.openSettings("api-keys")');
    assert.ok(await waitFor(() => js('!!document.querySelector("#settingsPage [data-section=\\"api-keys\\"] input[type=password]")'), 8000), 'no key field');
    const keys = await js(`(() => {
      const card = document.querySelector('#settingsPage [data-section="api-keys"]');
      const fields = [...card.querySelectorAll('input[type=password]')];
      return { sizes: fields.map(f => parseFloat(getComputedStyle(f).fontSize)), noteAfterFields: fields.length > 0 && !!(fields[fields.length - 1].compareDocumentPosition(card.querySelector('.ph-settings-note')) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`);
    assert.ok(keys.sizes.every(n => n >= 16), `key fields are 16 px or more: ${keys.sizes}`);
    assert.equal(keys.noteAfterFields, true, 'the key note comes after the key fields');
    await closeAll();
  });

  test('L16 and 8.7: the Computers sheet lists the shell\'s computers with the one in use checked; another one connects from the sheet', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js(`plenumPhoneDebug.shell({
      computers: () => [{ id: 'c1', name: 'Studio PC', active: true }, { id: 'c2', name: 'Laptop', active: false }],
      connectComputer: id => { (window.__connects = window.__connects || []).push(id); return Promise.resolve(true); },
      switchComputer: () => { window.__switchAsked = true; return Promise.resolve(true); },
    })`);
    await js('plenumPhoneDebug.tab("projects")');
    await js(holdTabJs('projects'));
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet-title") && document.querySelector(".ph-sheet-title").textContent === "Computers"'), 4000), 'the Computers sheet did not open');
    let rows = await js('__p3.sheetRows()');
    assert.deepEqual(rows.map(r => r.label), ['Studio PC', 'Laptop', 'All computers']);
    assert.deepEqual(rows.map(r => r.checked), [true, false, false], 'the computer in use is checked');
    assert.equal(rows[1].note, 'Tap to connect');
    // The one in use does nothing; Laptop connects; All computers goes to the shell's list.
    await js('__p3.pickRow("Studio PC")');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await js('(window.__connects || []).length'), 0, 'the computer already in use is not connected again');
    await js(holdTabJs('projects'));
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000));
    await js('__p3.pickRow("Laptop")');
    assert.ok(await waitFor(() => js('(window.__connects || []).length === 1'), 3000), 'Laptop was not connected');
    assert.deepEqual(await js('window.__connects'), ['c2']);
    assert.ok(await waitFor(() => js('__p3.toasts().some(t => t.includes("Connecting to Laptop"))'), 3000), 'no "Connecting to Laptop" line');
    await js(holdTabJs('projects'));
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000));
    await js('__p3.pickRow("All computers")');
    assert.ok(await waitFor(() => js('window.__switchAsked === true'), 3000), 'All computers did not go to the shell');
    await closeAll();
  });

  test('8.4.5: Send by email is a working button once a contact address is set, and says why it is off while none is', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.tab("chat")');
    await settleChat();
    await js(`(() => {
      const t = document.createElement('div');
      t.className = 'turn';
      t.dataset.phTest = 'mail';
      const head = document.createElement('div'); head.className = 'turn-head';
      const who = document.createElement('span'); who.className = 'who'; who.textContent = 'Claude Code';
      const when = document.createElement('span'); when.className = 'when'; when.textContent = '22 Oct 2026, 14:02';
      head.append(who, when);
      const body = document.createElement('div'); body.className = 'turn-body'; body.textContent = 'The reply text.';
      t.append(head, body);
      document.getElementById('chat').append(t);
      return true;
    })()`);
    const openReport = async () => {
      assert.ok(await waitFor(() => js('!!document.querySelector(\'[data-ph-test="mail"] .ph-turn-more\')'), 4000), `the reply has no More button; chat: ${await js('document.getElementById("chat").innerHTML.slice(0, 600)')}`);
      await js('(() => { document.querySelector(\'[data-ph-test="mail"] .ph-turn-more\').click(); return true; })()');
      assert.ok(await waitFor(() => js('__p3.pickRow("Report this reply")'), 3000), 'no Report this reply row');
      assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet-report")'), 3000), 'the report sheet did not open');
    };
    // No address, a bad address: the row is off and says so.
    for (const bad of [undefined, '', 'not an address', 'a@b']) {
      await js(`plenumPhoneDebug.shell({ contactEmail: ${bad === undefined ? 'undefined' : JSON.stringify(bad)} })`);
      await openReport();
      const row = await js(`(() => { const r = [...document.querySelectorAll('.ph-sheet-report .ph-row')].find(x => (x.querySelector('.ph-row-label') || x).textContent === 'Send by email'); return r ? { disabled: r.getAttribute('aria-disabled') === 'true', note: (r.querySelector('.ph-row-note') || {}).textContent || '' } : null; })()`);
      assert.ok(row && row.disabled, `Send by email is off for ${JSON.stringify(bad)}`);
      assert.match(row.note, /No contact address is set/);
      await closeAll();
    }
    // An address: a button, and a tap hands a mailto link with the report subject to the system (the anchor click is recorded here, not followed).
    await js(`plenumPhoneDebug.shell({ contactEmail: 'reports@example.org' })`);
    await js('(() => { window.__mails = []; HTMLAnchorElement.prototype.click = function () { window.__mails.push(this.href); }; return true; })()');
    await openReport();
    const mail = await js('(() => { const b = [...document.querySelectorAll(".ph-sheet-report button")].find(x => x.textContent === "Send by email"); return b ? { disabled: b.disabled || b.getAttribute("aria-disabled") === "true" } : null; })()');
    assert.ok(mail, 'there is a Send by email button');
    assert.equal(mail.disabled, false, 'Send by email is on');
    await js('(() => { [...document.querySelectorAll(".ph-sheet-report button")].find(x => x.textContent === "Send by email").click(); return true; })()');
    assert.ok(await waitFor(() => js('window.__mails.length === 1'), 3000), 'the tap did not make a mail link');
    const link = await js('window.__mails[0]');
    assert.match(link, /^mailto:reports@example\.org\?subject=Report%3A/);
    assert.ok(link.includes('Reply%20from%20Claude%20Code'), 'the mail names who wrote the reply');
    await js('(() => { delete HTMLAnchorElement.prototype.click; return true; })()');
    await closeAll();
  });

  test('L18 and P-24: the composer shows a mic only when the shell says this phone can listen; the words land in the composer; an error says what to do', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.tab("chat")');
    assert.equal(await js('!!document.querySelector(".ph-mic")'), false, 'no mic while the shell cannot listen');
    await js(`plenumPhoneDebug.shell({
      caps: ['dictation'],
      dictation: {
        start: () => { window.__dictStarts = (window.__dictStarts || 0) + 1; return window.__dictFail ? Promise.reject({ code: window.__dictFail }) : Promise.resolve(); },
        stop: () => { window.__dictStops = (window.__dictStops || 0) + 1; return Promise.resolve(); },
        on: (name, fn) => { (window.__dict = window.__dict || {})[name] = fn; return () => { delete window.__dict[name]; }; },
      },
    })`);
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-mic")'), 3000), 'the mic did not appear');
    const mic = await js(`(() => { const b = document.querySelector('.ph-mic'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), name: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') }; })()`);
    assert.ok(mic.w >= 44 && mic.h >= 44, `the mic is 44 px or more: ${mic.w}x${mic.h}`);
    assert.deepEqual([mic.name, mic.pressed], ['Dictate a message', 'false']);
    await js(`(() => { document.getElementById('input').value = 'Please'; document.querySelector('.ph-mic').click(); return true; })()`);
    assert.ok(await waitFor(() => js('window.__dictStarts === 1 && document.querySelector(".ph-mic").getAttribute("aria-pressed") === "true"'), 3000), 'dictation did not start');
    assert.equal(await js('document.querySelector(".ph-mic").getAttribute("aria-label")'), 'Stop dictation');
    await js('(window.__dict.final({ text: "  look at the tests " }), true)');
    assert.equal(await js('document.getElementById("input").value'), 'Please look at the tests', 'the words are added to what was typed');
    await js('(window.__dict.end(), true)');
    assert.ok(await waitFor(() => js('document.querySelector(".ph-mic").getAttribute("aria-pressed") === "false"'), 3000), 'the end of listening did not reset the mic');
    // A refusal says what to do.
    await js('(window.__dictFail = "permission-denied", document.querySelector(".ph-mic").click(), true)');
    assert.ok(await waitFor(() => js('__p3.toasts().some(t => t.includes("Allow the microphone for Plenum in the phone\'s Settings."))'), 3000), 'a refused microphone says nothing');
    assert.equal(await js('document.querySelector(".ph-mic").getAttribute("aria-pressed")'), 'false');
    // The shell stops being able to listen: the mic goes.
    await js('plenumPhoneDebug.shell({ caps: [] })');
    assert.ok(await waitFor(() => js('!document.querySelector(".ph-mic")'), 3000), 'the mic stayed');
    await js('plenumPhoneDebug.shell({ caps: undefined, dictation: undefined })');
  });

  test('F4: Lock now is in the More sheet only when a lock is set; M9: a read-tier connection replaces the composer with the tier note', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.tab("chat")');
    await js(`plenumPhoneDebug.shell({ lock: () => { window.__locks = (window.__locks || 0) + 1; return Promise.resolve(true); }, openSettings: () => Promise.resolve(true) })`);
    const labels = async mode => {
      await js(`plenumPhoneDebug.connection('connected', 'Studio PC', { lockMode: ${JSON.stringify(mode)} })`);
      await js('(() => { document.querySelector(".ph-more").click(); return true; })()');
      assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000), 'the More sheet did not open');
      const rows = (await js('__p3.sheetRows()')).map(r => r.label);
      if (mode === 'pin') {
        await js('__p3.pickRow("Lock now")');
        assert.ok(await waitFor(() => js('window.__locks === 1'), 3000), 'Lock now did not lock');
      }
      await closeAll();
      return rows;
    };
    assert.ok(!(await labels('off')).includes('Lock now'), 'Lock now is offered with no lock set');
    assert.ok(!(await labels(null)).includes('Lock now'), 'Lock now is offered while the lock mode is unknown');
    assert.ok((await labels('pin')).includes('Lock now'), 'Lock now is missing with a PIN lock');

    // M9: the tier comes from HELLO through the connection view, the same path the shell uses.
    await js(`plenumPhoneDebug.connection('connected', 'Studio PC', { tier: 'read' })`);
    assert.ok(await waitFor(() => js('!document.getElementById("ph-tier-note").hidden && document.getElementById("composer").hidden'), 3000), 'a Read-only phone still shows the composer');
    assert.match(await js('document.getElementById("ph-tier-note").textContent'), /./);
    await js(`plenumPhoneDebug.connection('connected', 'Studio PC', { tier: 'full' })`);
    assert.ok(await waitFor(() => js('document.getElementById("ph-tier-note").hidden && !document.getElementById("composer").hidden'), 3000), 'a Full phone does not get its composer back');
  });

  test('H7: a notification that names a place takes the phone there (waiting, chat, home, the limit settings)', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    const project = await activeProject();
    const route = detail => js(`(window.dispatchEvent(new CustomEvent('plenum:route', { detail: ${JSON.stringify(detail)} })), true)`);
    // #waiting: a card waiting in another project opens Agents.
    await js('plenumPhoneDebug.tab("chat")');
    await js('plenumPhoneDebug.approval({ project: "other", id: "rt-1", summary: "Run: npm run build" })');
    await route({ kind: 'waiting', id: 'rt-1' });
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'agents', 4000), 'the waiting route did not open Agents');
    // #home: the project list.
    await route({ kind: 'home' });
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'projects', 3000), 'the home route did not open Projects');
    // #chat: the project's chat.
    await route({ kind: 'chat', project });
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'chat', 3000), 'the chat route did not open Chat');
    assert.equal(await js('MuseUI.state.activeProject'), project);
    // #settings=limit: the budget chip when there is one, otherwise Settings.
    await route({ kind: 'settings', section: 'limit' });
    assert.ok(await waitFor(() => js('(() => { const chip = document.querySelector(".ext-budget-chip"); return !document.getElementById("settingsPage").hidden || !!document.querySelector(".ph-sheet, .ph-scrim, #budgetDrawer:not([hidden])") || (chip && !chip.hidden); })()'), 4000), 'the limit route opened nothing');
    await closeAll();
    // A card that is gone is said so, and Agents opens so the person sees what is left.
    await js('plenumPhoneDebug.tab("chat")');
    await js('__p3.clearToasts()');
    await route({ kind: 'waiting', id: 'does-not-exist' });
    assert.ok(await waitFor(() => js('__p3.toasts().some(t => t.includes("That approval is no longer waiting."))'), 6000), 'a card that is gone is not said so');
    assert.equal(await js('__p3.tab()'), 'agents');
    await closeAll();
  });

  test('M6: the browser\'s Back and the shell\'s Back close the top layer first, then take Chat to Projects, and stay in step', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.tab("projects")');
    await js('plenumPhoneDebug.tab("chat")');
    assert.equal(await js('history.state && history.state.tab === true'), true, 'leaving Projects pushes one history entry');
    // The browser's Back (popstate) takes Chat to Projects with no shell Back hook.
    await js('(history.back(), true)');
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'projects', 3000), 'the browser Back did not take Chat to Projects');
    assert.equal(await js('!!(history.state && history.state.tab === true)'), false, 'the tab entry is gone');
    // A sheet takes a place in the history: Back closes it and keeps the tab.
    await js('plenumPhoneDebug.tab("chat")');
    await js('(() => { document.querySelector(".ph-more").click(); return true; })()');
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000));
    await js('(history.back(), true)');
    assert.ok(await waitFor(() => js('!document.querySelector(".ph-sheet")'), 3000), 'the browser Back did not close the sheet');
    assert.equal(await js('__p3.tab()'), 'chat', 'closing the sheet kept the tab');
    // The shell's hardware Back (handleBack(false)): the sheet first, then Chat to Projects, then it says it did nothing so the app can leave.
    await js('(() => { document.querySelector(".ph-more").click(); return true; })()');
    assert.ok(await waitFor(() => js('!!document.querySelector(".ph-sheet")'), 3000));
    assert.equal(await js('plenumPhoneDebug.back()'), true);
    assert.ok(await waitFor(() => js('!document.querySelector(".ph-sheet")'), 3000), 'Back did not close the sheet');
    assert.equal(await js('__p3.tab()'), 'chat');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await js('plenumPhoneDebug.back()'), true);
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'projects', 3000), 'Back did not take Chat to Projects');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await js('plenumPhoneDebug.back()'), false, 'at Projects Back is not taken, so the app may leave');
    // The history stayed in step: the tab entry pushed again is the one the browser's Back takes.
    await js('plenumPhoneDebug.tab("chat")');
    await js('(history.back(), true)');
    assert.ok(await waitFor(async () => (await js('__p3.tab()')) === 'projects', 3000), 'after a hardware Back the browser Back is out of step');
  });

  test('M14: a card rebuilt on every build event stays armed by its approval id; a new id or a new detail is armed again', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P2_PAGE);
    await js('plenumPhoneDebug.tab("chat")');
    await settleChat();
    await js('plenumPhoneDebug.approval({ id: "rb-1", summary: "Run: npm test", detail: "npm test" })');
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"rb-1\\"] .ph-approve")')), 'the card was not decorated');
    await new Promise(r => setTimeout(r, 650));
    // The desktop rebuilds every card on each build event: replace the element every 200 ms with a fresh one of the same id and detail.
    await js(`(() => {
      window.__rebuilds = 0;
      const timer = setInterval(() => {
        const old = document.querySelector('[data-approval-id="rb-1"]');
        if (!old) return;
        const card = MuseUI.approvalEl({ approvalId: 'rb-1', summary: 'Run: npm test', detail: 'npm test' });
        old.replaceWith(card);
        window.__rebuilds += 1;
        if (window.__rebuilds >= 5) clearInterval(timer);
      }, 200);
      return true;
    })()`);
    assert.ok(await waitFor(() => js('window.__rebuilds >= 5'), 5000));
    await new Promise(r => setTimeout(r, 120));
    const armed = await js('(() => { const c = document.querySelector("[data-approval-id=\\"rb-1\\"]"); return { arming: c.dataset.phArming === "1", btn: !!c.querySelector(".ph-approve") }; })()');
    assert.deepEqual(armed, { arming: false, btn: true }, 'the rebuilt card is still armed');
    const before = await js('window.__approves()');
    await js('(() => { document.querySelector("[data-approval-id=\\"rb-1\\"] .ph-approve").click(); return true; })()');
    assert.ok(await waitFor(async () => (await js('window.__approves()')) === before + 1, 3000), 'a tap on the rebuilt card was refused');
    // A card with a new id is armed from its first frame: a tap at once is refused with "Tap again".
    await js('plenumPhoneDebug.approval({ id: "rb-2", summary: "Run: npm run build", detail: "npm run build" })');
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"rb-2\\"] .ph-approve")')), 'the second card was not decorated');
    const early = await js(`(() => { const b = document.querySelector('[data-approval-id="rb-2"] .ph-approve'); const n = window.__approves(); b.click(); return { sent: window.__approves() - n, text: b.textContent }; })()`);
    assert.deepEqual(early, { sent: 0, text: 'Tap again' }, 'a new card is armed again');
    // A card whose detail changed is armed again, even with the same id.
    await new Promise(r => setTimeout(r, 650));
    await js(`(() => { const old = document.querySelector('[data-approval-id="rb-2"]'); old.replaceWith(MuseUI.approvalEl({ approvalId: 'rb-2', summary: 'Run: npm run build', detail: 'rm -rf build && npm run build' })); return true; })()`);
    assert.ok(await waitFor(() => js('!!document.querySelector("[data-approval-id=\\"rb-2\\"] .ph-approve")')), 'the changed card was not decorated');
    const changed = await js(`(() => { const b = document.querySelector('[data-approval-id="rb-2"] .ph-approve'); const n = window.__approves(); b.click(); return { sent: window.__approves() - n, text: b.textContent }; })()`);
    assert.deepEqual(changed, { sent: 0, text: 'Tap again' }, 'a card whose detail changed is armed again');
  });

  test('M14: "Approved on this phone" shows only after the computer\'s answered event for that card and that answer', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P2_PAGE);
    await h.eval(P3_PAGE);
    await js('plenumPhoneDebug.tab("chat")');
    await settleChat();
    const an1 = { summary: 'Run: npm test', detail: 'npm test' };
    const an1OnPage = '!!document.querySelector("[data-approval-id=\\"an-1\\"] .ph-approve")';
    assert.ok(await keepDebugCard('an-1', an1, an1OnPage, 8000), 'the card an-1 did not come on the page');
    await new Promise(r => setTimeout(r, 650));
    assert.ok(await keepDebugCard('an-1', an1, an1OnPage, 8000), 'the card an-1 left the page before the answer');
    await js('__p3.clearToasts()');
    assert.equal(await js('(() => { const b = document.querySelector("[data-approval-id=\\"an-1\\"] .ph-approve"); if (!b) return false; b.click(); return true; })()'), true, 'the card an-1 was not on the page to answer');
    await new Promise(r => setTimeout(r, 400));
    assert.equal(await js('__p3.toasts().some(t => t.includes("on this phone"))'), false, 'the toast came before the computer said so');
    const event = detail => js(`(window.dispatchEvent(new CustomEvent('plenum:event', { detail: ${JSON.stringify(detail)} })), true)`);
    await event({ type: 'approval', action: 'answered', approvalId: 'an-OTHER', allow: true });
    await event({ type: 'approval', action: 'answered', approvalId: 'an-1', allow: false });
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await js('__p3.toasts().some(t => t.includes("on this phone"))'), false, 'another card, or the other answer, made the toast');
    await event({ type: 'approval', action: 'answered', approvalId: 'an-1', allow: true });
    assert.ok(await waitFor(() => js('__p3.toasts().some(t => /^Approved on this phone at \\d{2}:\\d{2}$/.test(t))'), 3000), 'the computer\'s event did not make the toast');
    await event({ type: 'approval', action: 'answered', approvalId: 'an-1', allow: true });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await js('__p3.toasts().filter(t => t.includes("on this phone")).length'), 1, 'the toast came twice');
  });

  test('M14: Approve and Deny answered from the phone through the real UI against the mock model reach the server, with the toast after the computer\'s event', { skip: SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(P2_PAGE);
    await h.eval(P3_PAGE);
    await activeProject();
    await js('plenumPhoneDebug.tab("chat")');
    const waiting = async () => Number((await h.server.state())?.approvalsWaiting) || 0;
    // One project per answer: the mock model asks for the file only on a thread that has no tool result yet.
    for (const [answer, pid] of [['approve', 'p2'], ['deny', 'p3']]) {
      await js(`(() => { const at = MuseUI.state.projects.findIndex(p => p.id === ${JSON.stringify(pid)}); document.querySelectorAll('.proj-item')[at].click(); return true; })()`);
      assert.ok(await waitFor(() => js(`MuseUI.state.activeProject === ${JSON.stringify(pid)}`), 8000), `project ${pid} did not become active`);
      await js('plenumPhoneDebug.tab("chat")');
      await js('__p3.clearToasts()');
      await sendFromComposer('WRITE a file for me');
      const shown = await waitFor(() => js('!!document.querySelector(".approval[data-approval-id] .ph-approve")'), 30000);
      assert.ok(shown, `the model's card did not reach the phone (${answer}); model log: ${JSON.stringify(h.mock.log.map(e => e.user.slice(0, 40)))}; waiting on the server: ${await waiting()}`);
      assert.equal(await waiting(), 1, 'the server is waiting for one answer');
      await new Promise(r => setTimeout(r, 650));
      const id = await js('document.querySelector(".approval[data-approval-id]").getAttribute("data-approval-id")');
      await js(`(() => { document.querySelector('.approval[data-approval-id="${id}"] .${answer === 'approve' ? 'ph-approve' : 'ph-deny'}').click(); return true; })()`);
      assert.ok(await waitFor(async () => (await waiting()) === 0, 15000), `${answer}: the server is still waiting`);
      const word = answer === 'approve' ? 'Approved' : 'Denied';
      assert.ok(await waitFor(() => js(`__p3.toasts().some(t => /^${word} on this phone at \\d{2}:\\d{2}$/.test(t))`), 8000), `${answer}: no "${word} on this phone" after the computer answered; toasts: ${await js('JSON.stringify(__p3.toasts())')}`);
      // The turn ends before the next message.
      assert.ok(await waitFor(() => js('!document.getElementById("send").classList.contains("stop")'), 30000), `${answer}: the turn did not end`);
    }
  });

  test('the suite leaves no failure behind (part 3)', () => {
    assert.deepEqual(fails, [], `${fails.length} phone-layer check(s) failed:\n${fails.join('\n')}`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Phone layer, track B (mob-11, wave 121): the phone as the person. Taps, drags, typing and keys on the Browser picture, and Take over from
// phone on a computer run (MOBILE-UI 8.10 and 8.11). The harness server has no Bridge and no run, so the computer's routes are answered by a
// stub in the page, and each check reads the request the phone made. Checks by viewport: MOB11_ONLY (or MOB11_P2_ONLY) = 360x780,390x844, ...
//   MOB11_PART=p2 MOB11_ONLY=390x844 node build/mobile/run.mjs --id mob11rc --timeout 540000 ui-phone.test.mjs
// Screenshots of the controls at 390 x 844 (light and dark) are written to the MOB11_SHOTS folder (plenum-mob11-shots in the temp folder by default).
// ---------------------------------------------------------------------------------------------------------------------------------------

const RC_ONLY = (process.env.MOB11_ONLY || process.env.MOB11_P2_ONLY || '').split(',').filter(Boolean);
const RC_VIEWS = VIEWS.filter(v => RC_ONLY.length === 0 || RC_ONLY.includes(v.name));
const SHOTS = process.env.MOB11_SHOTS || path.join(os.tmpdir(), 'plenum-mob11-shots');
const REMOTE_CAPS = ['browser-control', 'computer-control'];
const settle = ms => new Promise(r => setTimeout(r, ms));

// The stub of the computer's routes, installed in the page after each load. It answers the routes the phone calls for the browser picture, the
// computer run and its drive, records every request that is not a GET (with its body), and holds the run the way the desktop does.
const TB_PAGE = String.raw`(function () {
  if (window.__tb) return true;
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const cx = canvas.getContext('2d');
  cx.fillStyle = '#2b3550';
  cx.fillRect(0, 0, 960, 540);
  cx.fillStyle = '#f3c26b';
  cx.fillRect(120, 80, 360, 160);
  cx.fillStyle = '#ffffff';
  cx.fillRect(480, 300, 300, 120);
  const picture = canvas.toDataURL('image/png');
  const st = {
    posts: [],
    held: false,
    inputStatus: 200,
    drive: { id: 'drv-1', kind: 'computer', state: 'paused', pausedBy: 'user', steps: 12, label: 'Notepad' },
  };
  window.__tb = st;
  const nativeFetch = window.fetch.bind(window);
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } });
  const run = { id: 'drv-1', live: true, startedAt: Date.now(), model: 'echo:offline', settings: { allow: [{ app: 'Notepad' }], scope: 'window' }, frames: 0, frameSizes: [], actions: [], events: [], result: {}, bytes: 0 };
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    if (!/^\/api\/(browser|computer|drive)/.test(path)) return nativeFetch(input, init);
    const method = String((init && init.method) || 'GET').toUpperCase();
    const route = path.split('?')[0];
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
    if (method !== 'GET') st.posts.push({ route: route, body: body });
    if (method === 'GET' && route === '/api/drive') return json({ drives: st.drive ? [st.drive] : [], hotkey: { ok: false } });
    if (method === 'GET' && route === '/api/computer/run') return json(run);
    if (method === 'GET' && route === '/api/computer/runs') return json({ runs: [{ id: 'drv-1', startedAt: Date.now(), model: 'echo:offline', apps: ['Notepad'], actions: 0, bytes: 0, live: true }] });
    if (route === '/api/browser/frame') return json({ available: true, image: picture, width: 960, height: 540, shown: true, viewers: 1, nextMs: 250 });
    if (route === '/api/browser/input') return st.inputStatus === 200 ? json({ ok: true }) : json({ error: 'The model is using the browser. Pause it first.' }, 409);
    if (route === '/api/computer/takeover') { st.held = true; st.drive.state = 'paused'; return json({ ok: true, takeover: true, drive: st.drive }); }
    if (route === '/api/computer/live') return st.held ? json({ ok: true, image: picture, width: 960, height: 540, nextMs: 250 }) : json({ error: 'Take over the run from your phone first.' }, 409);
    if (route === '/api/computer/input') return st.held ? json({ ok: true, app: 'Notepad' }) : json({ error: 'Take over the run from your phone first.' }, 409);
    if (route === '/api/drive/resume') { st.held = false; st.drive.state = 'running'; return json({ ok: true, drive: st.drive }); }
    return nativeFetch(input, init);
  };
  return true;
})()`;

// A pointer press at one point and a release at another, given as fractions of the element's box (the picture's left and top are 0).
const pointerJs = (sel, [fx0, fy0], [fx1, fy1]) => `(() => {
  const s = document.querySelector(${JSON.stringify(sel)});
  const r = s.getBoundingClientRect();
  const at = (type, fx, fy) => s.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, button: 0, pointerType: 'touch', pointerId: 41, isPrimary: true }));
  at('pointerdown', ${fx0}, ${fy0});
  at('pointerup', ${fx1}, ${fy1});
  return true;
})()`;

const countPosts = route => js(`window.__tb.posts.filter(p => p.route === ${JSON.stringify(route)}).length`);
const lastBody = route => js(`(() => { const list = window.__tb.posts.filter(p => p.route === ${JSON.stringify(route)}); return list.length ? list[list.length - 1].body : null; })()`);
const pictureShown = sel => js(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); return !!s && !s.hidden && (s.getAttribute('src') || '').startsWith('data:image/'); })()`);
const visibleIn = sel => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); return !!b && !b.hidden && b.getClientRects().length > 0; })()`);
// The shots of the controls are taken at these sizes (zoom 1, both themes): the phone, the small phone and the landscape phone.
const SHOT_VIEWS = ['390x844', '360x780', '844x390'];
// Brings a control area (its typing box and keys) into view before a shot, so the keys are in the picture.
const scrollRowsIntoView = sel => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}); if (r) r.scrollIntoView({ block: 'center' }); return !!r; })()`);

// A phone at this size with the computer's control capabilities, a Full tier and a LAN carrier, the Browser pane open on its picture.
async function remoteReady(v, theme, { caps = REMOTE_CAPS, carrier = 'lan', tier = 'full' } = {}) {
  await openPhone(v, theme);
  await h.eval(TB_PAGE);
  await js(`plenumPhoneDebug.connection("connected", "Studio PC", ${JSON.stringify({ caps, carrier, tier })})`);
}
async function openBrowserPicture() {
  await js('MuseUI.pane.open("browser")');
  const shown = await waitFor(() => pictureShown('.ext-brw .ext-brw-shot'), 20000);
  if (!shown) throw new Error('the Browser picture did not arrive');
  return waitFor(() => visibleIn('.ext-brw .ph-rc-browser'), 6000);
}
// The checks on one control area: no horizontal scroll, every target 44 px or more, every target named, inputs 16 px or more, and Stop inside
// the screen and hittable.
async function checkRemote(cfg, scopeSel) {
  const r = await js(`(() => {
    const blk = document.querySelector(${JSON.stringify(scopeSel)});
    if (!blk) return null;
    return {
      small: __ph.small(blk), unnamed: __ph.unnamed(blk),
      inputs: [...blk.querySelectorAll('input')].map(i => parseFloat(getComputedStyle(i).fontSize)).filter(v => v < 16).length,
      wide: __ph.hOverflow(), stop: __ph.stopState(),
    };
  })()`);
  if (!r) {
    log(cfg, `${scopeSel} is not drawn`);
    return;
  }
  if (r.small.length) log(cfg, `P-02 small controls: ${r.small.slice(0, 4).join(' | ')}`);
  if (r.unnamed.length) log(cfg, `P-16 unnamed: ${r.unnamed.slice(0, 4).join(' | ')}`);
  if (r.inputs) log(cfg, `P-03 ${r.inputs} inputs below 16 px`);
  if (r.wide) log(cfg, 'P-01 horizontal scroll');
  if (!r.stop.inside || !r.stop.hit) log(cfg, `P-04 Stop not inside (${r.stop.inside}) or not hittable (${r.stop.hit}) with the controls shown`);
}

// Track B runs with part 2 (MOB11_PART=p2) and on its own (MOB11_PART=rc); a full run (no MOB11_PART) runs it too.
const RC_SKIP = SKIP || (PART === '' || PART === 'p2' || PART === 'rc' ? false : `MOB11_PART=${PART}`);
describe('phone layer, track B (mob-11, wave 121): taps, drags, typing and keys on the picture; take over from phone', { skip: RC_SKIP, timeout: 1_500_000 }, () => {
  let startFails = 0;
  before(async () => {
    if (SKIP) return;
    startFails = fails.length;
    h = await startPhoneHarness({ name: 'mob11-trackb' });
  });

  after(async () => {
    if (!h) return;
    const left = await h.close();
    h = null;
    assert.deepEqual(left.leftover, [], 'processes left behind');
  });

  test('RC-0: without the computer\'s control capabilities the picture takes no input: a tap says what it is once and sends nothing', { skip: RC_SKIP }, async () => {
    await openPhone(VIEWS[1], 'light');
    await h.eval(TB_PAGE);
    await js(`(() => { const img = document.createElement('img'); img.className = 'ext-brw-shot'; img.alt = ''; img.dataset.phTest = 'rc0'; document.getElementById('chat').append(img); return true; })()`);
    await js(`(() => { document.querySelector('[data-ph-test="rc0"]').click(); return true; })()`);
    const told = await waitFor(() => js('Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("This is a picture of the page on"))'), 3000);
    assert.ok(told, 'the picture tap did not say what it is');
    assert.equal(await countPosts('/api/browser/input'), 0, 'a tap was sent without the control capability');
    await js(`(() => { document.querySelector('[data-ph-test="rc0"]').remove(); return true; })()`);
  });

  test('RC-1: the strip shows only for the Full tier with the control capabilities over a connected carrier, and on the iOS app only over the LAN', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    assert.ok(await openBrowserPicture(), 'with Full, the capabilities and LAN the strip did not show');
    const changed = async (label, extra, expect) => {
      await js(`plenumPhoneDebug.connection("connected", "Studio PC", ${JSON.stringify(extra)})`);
      const got = await waitFor(async () => (await visibleIn('.ext-brw .ph-rc-browser')) === expect, 3000);
      if (!got) log('RC-1', `${label}: the strip is ${expect ? 'missing' : 'still shown'}`);
    };
    await changed('tier approve', { caps: REMOTE_CAPS, carrier: 'lan', tier: 'approve' }, false);
    await changed('tier read', { caps: REMOTE_CAPS, carrier: 'lan', tier: 'read' }, false);
    await changed('no control capability', { caps: ['browser-picture'], carrier: 'lan', tier: 'full' }, false);
    await changed('Full again', { caps: REMOTE_CAPS, carrier: 'lan', tier: 'full' }, true);
    await js('plenumPhoneDebug.shell({ app: "ios" })');
    await changed('iOS over a tailnet', { caps: REMOTE_CAPS, carrier: 'tailscale', tier: 'full' }, false);
    await changed('iOS over the LAN', { caps: REMOTE_CAPS, carrier: 'lan', tier: 'full' }, true);
    await js('plenumPhoneDebug.shell({ app: undefined })');
  });

  test('RC-2: a tap on the picture is sent as a tap at that point of the picture; a drag up is sent as a scroll down the page', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    assert.ok(await openBrowserPicture(), 'the strip did not show');
    const geo = await js('(() => { const s = document.querySelector(".ext-brw .ext-brw-shot"); const r = s.getBoundingClientRect(); return { w: r.width, h: r.height }; })()');
    const scale = Math.min(geo.w / 960, geo.h / 540);
    const before = await countPosts('/api/browser/input');
    await js(pointerJs('.ext-brw .ext-brw-shot', [0.25, 0.4], [0.25, 0.4]));
    assert.ok(await waitFor(async () => (await countPosts('/api/browser/input')) > before, 3000), 'the tap was not sent');
    const tap = await lastBody('/api/browser/input');
    assert.equal(tap.kind, 'tap');
    assert.ok(Math.abs(tap.x - Math.round(0.25 * 960)) <= 1 && Math.abs(tap.y - Math.round(0.4 * 540)) <= 1, `the tap point ${tap.x},${tap.y}`);
    assert.equal(tap.width, 960);
    assert.equal(tap.height, 540);
    await js('document.querySelector(".ext-brw .ext-brw-shot").click()');
    const told = await js('Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("This is a picture of the page on"))');
    assert.equal(told, false, 'a tap that was sent still said the picture is not input');
    // A drag from 80% of the height up to 50%: the page scrolls down, so dy is positive by the same amount the finger moved.
    const sc = await countPosts('/api/browser/input');
    await js(pointerJs('.ext-brw .ext-brw-shot', [0.5, 0.8], [0.5, 0.5]));
    assert.ok(await waitFor(async () => (await countPosts('/api/browser/input')) > sc, 3000), 'the drag was not sent');
    const drag = await lastBody('/api/browser/input');
    assert.equal(drag.kind, 'scroll');
    assert.ok(drag.dy > 0, `dy ${drag.dy} should move the page down`);
    assert.ok(Math.abs(drag.dy - Math.round(0.3 * geo.h / scale)) <= 2, `dy ${drag.dy} is not the finger's move`);
    assert.equal(drag.dx, 0);
  });

  test('RC-3: typing sends the text and clears the box; each key is sent once; a refusal keeps the text and says why', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    assert.ok(await openBrowserPicture(), 'the strip did not show');
    await js(`(() => { const i = document.querySelector('.ext-brw .ph-rc-browser .ph-rc-text'); i.value = 'hello page'; return true; })()`);
    const typed = await countPosts('/api/browser/input');
    await js(`(() => { document.querySelector('.ext-brw .ph-rc-browser .ph-rc-send').click(); return true; })()`);
    assert.ok(await waitFor(async () => (await countPosts('/api/browser/input')) > typed, 3000), 'the text was not sent');
    assert.deepEqual(await lastBody('/api/browser/input'), { kind: 'type', text: 'hello page' });
    assert.ok(await waitFor(() => js('document.querySelector(".ext-brw .ph-rc-browser .ph-rc-text").value === ""'), 2000), 'the box was not cleared');
    for (const name of ['Enter', 'Tab', 'Backspace', 'Escape']) {
      const n = await countPosts('/api/browser/input');
      await js(`(() => { [...document.querySelectorAll('.ext-brw .ph-rc-browser .ph-rc-key')].find(b => b.textContent === ${JSON.stringify(name)}).click(); return true; })()`);
      assert.ok(await waitFor(async () => (await countPosts('/api/browser/input')) === n + 1, 3000), `${name} was not sent once`);
      assert.deepEqual(await lastBody('/api/browser/input'), { kind: 'key', key: name });
    }
    await js('window.__tb.inputStatus = 409');
    await js(`(() => { document.querySelector('.ext-brw .ph-rc-browser .ph-rc-text').value = 'kept'; document.querySelector('.ext-brw .ph-rc-browser .ph-rc-send').click(); return true; })()`);
    const said = await waitFor(() => js('Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("The model is using the browser. Pause it first."))'), 3000);
    assert.ok(said, 'the refusal was not said');
    assert.equal(await js('document.querySelector(".ext-brw .ph-rc-browser .ph-rc-text").value'), 'kept', 'a refused text was cleared');
    await js('window.__tb.inputStatus = 200');
  });

  test('RC-4: Take over from phone pauses the run and shows its picture; a tap, text and a key on it go to the run; a lost hold says so and goes back', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    await js('MuseUI.openComputerRuns("drv-1")');
    const seen = await waitFor(() => visibleIn('#drawerBody .ph-rc-run'), 15000);
    assert.ok(seen, 'the run view did not show the remote block');
    assert.equal(await js('document.querySelector("#drawerBody .ph-rc-takeover").textContent'), 'Take over from phone');
    const notice = await waitFor(() => js('!!document.querySelector("#drawerBody .ph-rc-run [data-notice=\\"phone-remote-control\\"]")'), 6000);
    if (!notice) log('RC-4', 'the phone-remote-control notice did not draw at the top of the run view');
    const taken = await countPosts('/api/computer/takeover');
    await js('document.querySelector("#drawerBody .ph-rc-takeover").click()');
    assert.ok(await waitFor(async () => (await countPosts('/api/computer/takeover')) === taken + 1, 3000), 'Take over was not sent');
    assert.deepEqual(await lastBody('/api/computer/takeover'), { id: 'drv-1' });
    assert.ok(await waitFor(() => pictureShown('#drawerBody .ph-rc-pic'), 6000), 'the run picture did not arrive');
    assert.equal(await js('document.querySelector("#drawerBody .ph-rc-takeover").hidden'), true, 'Take over stays after the hold');
    assert.equal(await js('document.querySelector("#drawerBody .ph-rc-rows").hidden'), false, 'the typing box and keys did not show');
    const tapped = await countPosts('/api/computer/input');
    await js(pointerJs('#drawerBody .ph-rc-pic', [0.25, 0.4], [0.25, 0.4]));
    assert.ok(await waitFor(async () => (await countPosts('/api/computer/input')) > tapped, 3000), 'the tap on the run was not sent');
    const tap = await lastBody('/api/computer/input');
    assert.equal(tap.id, 'drv-1');
    assert.equal(tap.kind, 'tap');
    assert.ok(Math.abs(tap.x - Math.round(0.25 * 960)) <= 1 && Math.abs(tap.y - Math.round(0.4 * 540)) <= 1, `the run tap point ${tap.x},${tap.y}`);
    const keyed = await countPosts('/api/computer/input');
    await js(`(() => { [...document.querySelectorAll('#drawerBody .ph-rc-key')].find(b => b.textContent === 'Escape').click(); return true; })()`);
    assert.ok(await waitFor(async () => (await countPosts('/api/computer/input')) === keyed + 1, 3000), 'the key was not sent once');
    assert.deepEqual(await lastBody('/api/computer/input'), { id: 'drv-1', kind: 'key', key: 'Escape' });
    // The desktop ends the hold (the run resumed elsewhere): the next picture is refused, and the view goes back to Take over.
    await js('window.__tb.held = false');
    const back = await waitFor(() => visibleIn('#drawerBody .ph-rc-takeover'), 6000);
    assert.ok(back, 'a lost hold did not bring Take over back');
    assert.equal(await js('document.querySelector("#drawerBody .ph-rc-pic").hidden'), true, 'the picture stayed after the hold ended');
    const said = await js('Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("Take over the run from your phone first."))');
    assert.equal(said, true, 'a lost hold was not said');
  });

  test('RC-5: Resume sends the resume for the run and ends the hold', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    await js('MuseUI.openComputerRuns("drv-1")');
    assert.ok(await waitFor(() => visibleIn('#drawerBody .ph-rc-takeover'), 15000), 'the run view did not show Take over');
    await js('document.querySelector("#drawerBody .ph-rc-takeover").click()');
    assert.ok(await waitFor(() => visibleIn('#drawerBody .ph-rc-resume'), 6000), 'Resume did not show with the hold');
    await js('document.querySelector("#drawerBody .ph-rc-resume").click()');
    assert.ok(await waitFor(() => visibleIn('#drawerBody .ph-rc-takeover'), 6000), 'Take over did not come back after Resume');
    assert.deepEqual(await lastBody('/api/drive/resume'), { id: 'drv-1' });
  });

  test('RC-6: the run view before Take over draws its remote-control notice (a fresh page, 390 x 844 shot)', { skip: RC_SKIP }, async () => {
    await remoteReady(VIEWS[1], 'light');
    await js('MuseUI.openComputerRuns("drv-1")');
    assert.ok(await waitFor(() => visibleIn('#drawerBody .ph-rc-takeover'), 15000), 'the run view did not show Take over');
    const notice = await waitFor(() => js('!!document.querySelector("#drawerBody .ph-rc-run [data-notice=\\"phone-remote-control\\"]")'), 6000);
    assert.ok(notice, 'the phone-remote-control notice did not draw at the top of the run view before Take over');
    await js('__ph.stand()');
    assert.equal((await js('__ph.stopState()')).hit, true, 'Stop is not hittable in the run view before Take over');
    await shotTo('rc-run-before-takeover-390x844-light');
  });

  // wave 121 (Fable review): the other tests give the page its capabilities through plenumPhoneDebug.connection, a debug-only override. In
  // production the page reads the connection the shell builds from the computer's HELLO (boot.js connectionView), which once left the caps out,
  // so no control ever drew. Here the connection comes out of the real boot.js over a HELLO snapshot, and the page gets it as the shell's own
  // connection(); the debug override is never set.
  test('RC-6: the production path: boot.js builds the connection from a HELLO that carries the two caps, and the strip and the run view draw from it', { skip: RC_SKIP }, async () => {
    const { installShim } = await import('../shell/boot.js');
    const viewFor = hello => {
      const snapshot = {
        connection: { status: 'connected', carrier: 'lan', desktopName: 'Studio PC' },
        hello: { deviceId: 'dev-rc6-0001', tier: 'full', desktopName: 'Studio PC', pending: {}, ...hello },
        lock: { mode: 'off' },
      };
      const core = { state: () => snapshot, subscribe(fn) { fn(snapshot); return () => {}; }, request: async () => { throw new Error('offline'); } };
      const win = { location: new URL(`http://127.0.0.1:7300/p/${'a'.repeat(32)}/`), Response, ReadableStream, fetch: async () => { throw new Error('no network'); }, setTimeout, clearTimeout, navigator: {} };
      installShim({ win, doc: null, origFetch: async () => new Response(''), core });
      return win.plenumShell.connection();
    };
    const give = view => js(`plenumPhoneDebug.shell({ connection: () => (${JSON.stringify(view)}) })`);
    const withCaps = viewFor({ caps: ['events', 'browser-picture', 'browser-control', 'computer-control'] });
    assert.deepEqual(withCaps.caps, ['events', 'browser-picture', 'browser-control', 'computer-control'], 'boot.js keeps the HELLO caps in the connection');
    await openPhone(VIEWS[1], 'light');
    await h.eval(TB_PAGE);
    await give(withCaps);
    assert.ok(await openBrowserPicture(), 'the strip did not draw from the shell\'s own connection');
    // A computer whose HELLO names no control capability (an older one) draws no strip.
    await give(viewFor({ caps: ['events', 'browser-picture'] }));
    assert.ok(await waitFor(async () => !(await visibleIn('.ext-brw .ph-rc-browser')), 4000), 'the strip drew for a computer that did not say it can be steered');
    await give(withCaps);
    assert.ok(await waitFor(() => visibleIn('.ext-brw .ph-rc-browser'), 4000), 'the strip did not come back with the caps');
    await js('MuseUI.openComputerRuns("drv-1")');
    assert.ok(await waitFor(() => visibleIn('#drawerBody .ph-rc-takeover'), 15000), 'Take over from phone did not draw from the shell\'s own connection');
    assert.equal(await js('document.querySelector("#drawerBody .ph-rc-takeover").textContent'), 'Take over from phone');
  });

  // The layout at every size, both themes and all three text zooms: the strip and the run view keep the screen clear of overflow, every control is
  // 44 px or more and named, and Stop stays inside the screen and hittable. The 390 x 844 screenshots of the controls are taken here.
  for (const v of RC_VIEWS) {
    for (const theme of THEMES) {
      for (const zoom of ZOOMS) {
        const cfg = `${v.name} ${theme} z${zoom} remote`;
        test(`${cfg}: the strip and the run view fit, their controls are 44 px or more and named, and Stop stays hittable`, { skip: RC_SKIP, timeout: 300_000 }, async () => {
          await remoteReady(v, theme);
          if (zoom !== 1) await js(`plenumPhoneDebug.textZoom(${zoom})`);
          await settle(60);
          const picked = await openBrowserPicture();
          if (!picked) log(cfg, 'the strip did not show on the Browser pane');
          await checkRemote(`${cfg} browser`, '.ext-brw .ph-rc-browser');
          // The shots at zoom 1 are of the browser's picture with its typing box and keys in view, then of the held run.
          const shotSize = zoom === 1 && SHOT_VIEWS.includes(v.name);
          if (shotSize) await scrollRowsIntoView('.ext-brw .ph-rc-browser .ph-rc-rows');
          if (shotSize) await shotTo(`rc-browser-${v.name}-${theme}`);
          await js('MuseUI.openComputerRuns("drv-1")');
          if (!(await waitFor(() => visibleIn('#drawerBody .ph-rc-run'), 15000))) log(cfg, 'the run view did not show');
          await checkRemote(`${cfg} run`, '#drawerBody .ph-rc-run');
          await js('document.querySelector("#drawerBody .ph-rc-takeover").click()');
          if (!(await waitFor(() => pictureShown('#drawerBody .ph-rc-pic'), 8000))) log(cfg, 'the held run picture did not arrive');
          await checkRemote(`${cfg} held`, '#drawerBody .ph-rc-run');
          if (shotSize) await scrollRowsIntoView('#drawerBody .ph-rc-run .ph-rc-rows');
          if (shotSize) await shotTo(`rc-run-${v.name}-${theme}`);
          await js('window.__tb.held = false');
        });
      }
    }
  }

  test('the suite leaves no failure behind (track B)', () => {
    assert.deepEqual(fails.slice(startFails), [], `${fails.length - startFails} track B check(s) failed:\n${fails.slice(startFails).join('\n')}`);
  });
});

// A screenshot of the page into the shots folder, named as the review expects (the harness writes its own copy first).
async function shotTo(name) {
  const r = await h.shot(name);
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(r.path, path.join(SHOTS, `${name}.png`));
}
