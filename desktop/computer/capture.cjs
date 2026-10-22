'use strict';
// Screen capture for the computer-use backend, on top of Electron's desktopCapturer (main process only). Everything that can be
// pure is exported as a pure function so it runs under test without Electron.
//
//   createSpace({ screen, platform })        the displays and the two unit conversions (physical pixels <-> device-independent pixels)
//   createCapture({ electron, space, native, overlay, platform })
//     .capture({ scope: 'display'|'window', target, maxEdge }) -> { png, width, height, physical, scale } | { ok: false, reason, message }
//
// Units: every rectangle that crosses the backend's interface is in PHYSICAL screen pixels (what the monitors really have). Electron
// positions windows in device-independent pixels (DIP); createSpace converts between the two with each display's scale factor, one
// display at a time, which is how Windows lays out a mixed-DPI desktop.
//
// Display scope takes desktopCapturer's screen source for the display (thumbnailSize = its physical size) and scales the long edge
// down to maxEdge. Window scope on Windows and macOS takes the same display capture and crops it to the window, so the menus,
// drop-downs, dialogs and tooltips the app opens over its window are in the picture (a window-only capture leaves those out and the
// model would click menus it cannot see); the parts of the crop that other programs' windows cover are then painted flat grey
// (#808080) from geometry.maskRects, so the model sees only the allowed app. On Linux X11 there is no stacking order to mask with,
// so window scope uses the window source for that window instead. A source list that is empty (PipeWire trouble,
// electron/electron#37463) is { ok: false, reason: 'unsupported' } and never a crash.
const geometry = require('./geometry.cjs');

const GREY_BGRA = [128, 128, 128, 255];
const DEFAULT_EDGE = 1280;
const MIN_EDGE = 256;
const MAX_EDGE = 4000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- pure helpers ----------

function clampEdge(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_EDGE, Math.max(MIN_EDGE, n)) : DEFAULT_EDGE;
}

// Paints rectangles (in the bitmap's own coordinates, clipped) with a BGRA colour. `bitmap` is a Buffer of width*height*4 bytes.
function paintBitmap(bitmap, width, height, rects, color = GREY_BGRA) {
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        bitmap[i] = color[0];
        bitmap[i + 1] = color[1];
        bitmap[i + 2] = color[2];
        bitmap[i + 3] = color[3];
      }
    }
  }
  return bitmap;
}

// Whether the pixel at (x, y) of a BGRA bitmap is the overlay's magenta marker (#ff00ff).
function isMagentaAt(bitmap, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  return bitmap[i + 2] > 200 && bitmap[i + 1] < 70 && bitmap[i] > 200;
}

// The display that holds the middle of a rectangle, else the nearest one. `key` names the display's rectangle to compare with:
// 'bounds' (physical pixels) or 'dipBounds' (device-independent pixels).
function displayAt(displays, rect, key = 'bounds') {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const d of displays) {
    const b = d[key];
    if (geometry.pointInRect({ x: cx, y: cy }, b)) return d;
    const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width));
    const dy = Math.max(b.y - cy, 0, cy - (b.y + b.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------- displays and units ----------

// The monitor (from the operating system's own list, in physical pixels) that is the same display as an Electron one, or null. Electron
// works out a display's physical rectangle from device-independent pixels that Chromium has rounded, so a 3840x2160 monitor at 175 %
// comes out 3841x2161; the system's rectangle is exact. Two rectangles are the same display when every edge agrees within 4 pixels.
function matchMonitor(approx, monitors) {
  let best = null;
  let bestDistance = Infinity;
  for (const m of monitors ?? []) {
    const d = Math.max(Math.abs(m.x - approx.x), Math.abs(m.y - approx.y), Math.abs(m.width - approx.width), Math.abs(m.height - approx.height));
    if (d <= 4 && d < bestDistance) {
      best = m;
      bestDistance = d;
    }
  }
  return best;
}

// `monitors` (optional) is a function that answers the exact physical rectangles of the monitors ([{ x, y, width, height }]) or null.
function createSpace({ screen, platform = process.platform, monitors = null } = {}) {
  function physicalOrigin(d) {
    const scale = d.scaleFactor || 1;
    try {
      if (platform !== 'darwin' && typeof screen.dipToScreenPoint === 'function') {
        const p = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: Math.round(p.x), y: Math.round(p.y) };
      }
    } catch {
      // Fall through to the plain scale below.
    }
    return { x: Math.round(d.bounds.x * scale), y: Math.round(d.bounds.y * scale) };
  }

  // [{ id, label, bounds (physical), dipBounds, scaleFactor, physical: { width, height }, primary }]
  function displays() {
    let list = [];
    let primaryId = null;
    try {
      list = screen.getAllDisplays();
      primaryId = screen.getPrimaryDisplay()?.id ?? null;
    } catch {
      return [];
    }
    let exact = null;
    try {
      exact = typeof monitors === 'function' ? monitors() : null;
    } catch {
      exact = null;
    }
    return list.map((d, i) => {
      const scale = d.scaleFactor || 1;
      const origin = physicalOrigin(d);
      let rect = { x: origin.x, y: origin.y, width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale) };
      const real = matchMonitor(rect, exact);
      if (real) rect = { x: real.x, y: real.y, width: real.width, height: real.height };
      const physical = { width: rect.width, height: rect.height };
      return {
        id: String(d.id),
        label: typeof d.label === 'string' && d.label ? d.label : `Display ${i + 1}`,
        bounds: rect,
        dipBounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
        scaleFactor: scale,
        physical,
        primary: d.id === primaryId,
      };
    });
  }

  // Physical rectangle -> DIP rectangle, using the display that holds the rectangle's middle.
  function toDipRect(rect) {
    const all = displays();
    const d = all.length ? displayAt(all, rect) : null;
    if (!d) return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const s = d.scaleFactor;
    return {
      x: Math.round(d.dipBounds.x + (rect.x - d.bounds.x) / s),
      y: Math.round(d.dipBounds.y + (rect.y - d.bounds.y) / s),
      width: Math.max(1, Math.round(rect.width / s)),
      height: Math.max(1, Math.round(rect.height / s)),
    };
  }

  // DIP rectangle -> physical rectangle, using the display that holds the rectangle's middle.
  function toPhysicalRect(rect) {
    const all = displays();
    const d = all.length ? displayAt(all, rect, 'dipBounds') : null;
    if (!d) return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    const s = d.scaleFactor;
    return {
      x: Math.round(d.bounds.x + (rect.x - d.dipBounds.x) * s),
      y: Math.round(d.bounds.y + (rect.y - d.dipBounds.y) * s),
      width: Math.max(1, Math.round(rect.width * s)),
      height: Math.max(1, Math.round(rect.height * s)),
    };
  }

  // The same conversions for a point, without rounding (macOS posts events at fractional points).
  function toDipPoint(p) {
    const all = displays();
    const d = all.length ? displayAt(all, { x: p.x, y: p.y, width: 1, height: 1 }) : null;
    if (!d) return { x: p.x, y: p.y };
    return { x: d.dipBounds.x + (p.x - d.bounds.x) / d.scaleFactor, y: d.dipBounds.y + (p.y - d.bounds.y) / d.scaleFactor };
  }

  function toPhysicalPoint(p) {
    const all = displays();
    const d = all.length ? displayAt(all, { x: p.x, y: p.y, width: 0.01, height: 0.01 }, 'dipBounds') : null;
    if (!d) return { x: p.x, y: p.y };
    return { x: Math.round(d.bounds.x + (p.x - d.dipBounds.x) * d.scaleFactor), y: Math.round(d.bounds.y + (p.y - d.dipBounds.y) * d.scaleFactor) };
  }

  return { displays, toDipRect, toPhysicalRect, toDipPoint, toPhysicalPoint };
}

// The screen source for a display: the one whose display_id matches; else, when there is one source per display, the source at
// the display's position in the list; else the first when there is a single display.
function pickScreenSource(sources, display, displays) {
  const byId = sources.find(s => s.display_id && String(s.display_id) === String(display.id));
  if (byId) return byId;
  if (sources.length === displays.length) {
    const i = displays.findIndex(d => d.id === display.id);
    if (i >= 0 && sources[i]) return sources[i];
  }
  return displays.length === 1 ? sources[0] ?? null : null;
}

// ---------- capture ----------

function createCapture({ electron, space, native, overlay = null, platform = process.platform, wait = sleep } = {}) {
  const { desktopCapturer, nativeImage } = electron;

  const fail = (reason, message) => ({ ok: false, reason, message });

  // Every visible top-level window, topmost first, without the overlay's own windows; null where the platform cannot say.
  async function windowStack() {
    const all = await native.windows({ all: true });
    return Array.isArray(all) ? all.filter(w => !(overlay && overlay.isOverlayWindow(w))) : null;
  }

  // A screen capture of one display, scaled to the display's physical size when the capturer returned another size.
  async function grabDisplay(display) {
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.physical.width, height: display.physical.height }, fetchWindowIcons: false });
    } catch {
      return fail('unsupported', 'The screen could not be captured.');
    }
    if (!Array.isArray(sources) || sources.length === 0) return fail('unsupported', 'The system gave no screen to capture. On Linux this happens under Wayland or when PipeWire is not working.');
    const source = pickScreenSource(sources, display, space.displays());
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) return fail('failed', 'The screen capture came back empty.');
    let image = source.thumbnail;
    let size = image.getSize();
    if (Math.abs(size.width - display.physical.width) > 2 || Math.abs(size.height - display.physical.height) > 2) {
      image = image.resize({ width: display.physical.width, height: display.physical.height, quality: 'best' });
      size = image.getSize();
    }
    return { image, rect: { x: display.bounds.x, y: display.bounds.y, width: size.width, height: size.height } };
  }

  // Looks for the overlay bar's magenta marker, once: when the bar is showing, its page has loaded and the status is not known yet.
  // It takes a screen capture of its own with the overlay windows showing and throws the picture away, so the first picture a model
  // gets is already clean. If the marker is there, content protection did not keep the bar out of the capture and the status
  // becomes 'hidden-during-capture'; if not, 'protected'. A marker that cannot be read leaves the status unknown, and a capture
  // hides the overlay windows while it is unknown.
  async function sampleMarker() {
    if (!overlay || !overlay.needsMarkerCheck()) return;
    const point = overlay.markerPoint();
    if (!point) return;
    const display = displayAt(space.displays(), { x: point.x, y: point.y, width: 1, height: 1 });
    if (!display) return;
    const grabbed = await grabDisplay(display);
    if (grabbed.ok === false || !geometry.pointInRect(point, grabbed.rect)) return;
    try {
      const probe = grabbed.image.crop({ x: point.x - grabbed.rect.x, y: point.y - grabbed.rect.y, width: 1, height: 1 }).toBitmap();
      overlay.recordMarker(isMagentaAt(probe, 1, 1, 0, 0));
    } catch {
      // The marker could not be read; a later capture tries again.
    }
  }

  function encode(image, physical, fitted) {
    const sentSize = geometry.fitEdge(fitted.width, fitted.height, fitted.maxEdge);
    const out = sentSize.width === fitted.width && sentSize.height === fitted.height ? image : image.resize({ width: sentSize.width, height: sentSize.height, quality: 'best' });
    const bytes = out.toPNG();
    // A copy with its own memory: a Buffer from the pool would be cloned along with the whole pool when it crosses the channel.
    const png = new Uint8Array(bytes.length);
    png.set(bytes);
    return { png, width: sentSize.width, height: sentSize.height, physical, scale: { x: physical.width / sentSize.width, y: physical.height / sentSize.height } };
  }

  // The stacking order is read before and after the grab and the grey parts of both are painted, so a window that opened or closed
  // while the picture was taken cannot leak into it.
  async function captureWindowViaDisplay(win, maxEdge, before) {
    const all = space.displays();
    const holder = displayAt(all, win.bounds);
    if (!holder) return fail('no-window', 'That window is not on any display.');
    const crop = geometry.cropRect(win.bounds, holder.bounds);
    if (!crop) return fail('no-window', 'That window is not on screen.');
    const grabbed = await grabDisplay(holder);
    if (grabbed.ok === false) return grabbed;
    const after = (await windowStack()) ?? before;
    const target = { id: win.id, exe: win.exe };
    const masks = [...geometry.maskRects(crop, before, target), ...geometry.maskRects(crop, after, target)];
    let image = grabbed.image.crop({ x: crop.x - grabbed.rect.x, y: crop.y - grabbed.rect.y, width: crop.width, height: crop.height });
    if (masks.length) {
      const bitmap = image.toBitmap();
      const local = masks.map(m => ({ x: m.x - crop.x, y: m.y - crop.y, width: m.width, height: m.height }));
      paintBitmap(bitmap, crop.width, crop.height, local);
      image = nativeImage.createFromBitmap(bitmap, { width: crop.width, height: crop.height, scaleFactor: 1 });
    }
    return encode(image, crop, { width: crop.width, height: crop.height, maxEdge });
  }

  // Linux X11: the window source for one window.
  async function captureWindowViaSource(win, maxEdge) {
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: win.bounds.width, height: win.bounds.height }, fetchWindowIcons: false });
    } catch {
      return fail('unsupported', 'The window could not be captured.');
    }
    if (!Array.isArray(sources) || sources.length === 0) return fail('unsupported', 'The system gave no window to capture. On Linux this happens under Wayland or when PipeWire is not working.');
    const source = sources.find(s => typeof s.id === 'string' && s.id.split(':')[1] === String(win.id));
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) return fail('no-window', 'That window could not be captured.');
    const size = source.thumbnail.getSize();
    const physical = { x: win.bounds.x, y: win.bounds.y, width: size.width, height: size.height };
    return encode(source.thumbnail, physical, { width: size.width, height: size.height, maxEdge });
  }

  async function capture({ scope = 'display', target = null, maxEdge = DEFAULT_EDGE } = {}) {
    if (scope !== 'display' && scope !== 'window') return fail('unsupported', 'The scope must be display or window.');
    const edge = clampEdge(maxEdge);
    try {
      await sampleMarker();
    } catch {
      // The status stays unknown and the overlay windows are hidden for this capture.
    }
    // The overlay's windows are hidden for the capture when they cannot be kept out of it; restore() brings them back.
    const restore = overlay ? await overlay.prepareCapture() : async () => {};
    try {
      if (scope === 'display') {
        const all = space.displays();
        const id = target && typeof target === 'object' ? target.displayId ?? target.id : target;
        const display = (id !== null && id !== undefined && id !== '' ? all.find(d => d.id === String(id)) : null) ?? all.find(d => d.primary) ?? all[0];
        if (!display) return fail('unsupported', 'There is no display to capture.');
        const grabbed = await grabDisplay(display);
        if (grabbed.ok === false) return grabbed;
        return encode(grabbed.image, grabbed.rect, { width: grabbed.rect.width, height: grabbed.rect.height, maxEdge: edge });
      }
      const windowId = target && typeof target === 'object' ? target.windowId ?? target.id : target;
      if (windowId === null || windowId === undefined || windowId === '') return fail('no-window', 'Name the window to capture.');
      const list = await native.windows({ all: false });
      const win = Array.isArray(list) ? list.find(w => String(w.id) === String(windowId)) : null;
      if (!win) return fail('no-window', 'That window is gone.');
      if (win.minimized) return fail('no-window', 'That window is minimised.');
      const stack = await windowStack();
      return stack ? await captureWindowViaDisplay(win, edge, stack) : await captureWindowViaSource(win, edge);
    } catch (err) {
      return fail('failed', `The capture failed: ${String(err?.message ?? err).slice(0, 160)}`);
    } finally {
      try {
        await restore();
      } catch {
        // The overlay windows are brought back by the next overlay() call.
      }
    }
  }

  return { capture, wait };
}

module.exports = { createSpace, matchMonitor, createCapture, paintBitmap, isMagentaAt, displayAt, pickScreenSource, clampEdge, GREY_BGRA, DEFAULT_EDGE };
