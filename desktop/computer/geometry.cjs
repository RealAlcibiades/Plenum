'use strict';
// Rectangle arithmetic for the computer-use backend: pure functions on { x, y, width, height } (numbers in one unit; the callers
// use physical pixels or device-independent pixels but never mix them in one call). No Electron, no native code.
//  - cropRect(bounds, area)           the part of bounds that lies inside area, or null when none does
//  - maskRects(bounds, windows, target) the parts of bounds to paint grey: visible windows of OTHER programs above the target
//  - barPlacement({ target, display, size, gap }) where the 560x44 overlay bar goes
//  - frameStrips(rect, thickness, within) the four strips of the amber frame
//  - pointInRect(point, rect)         left and top edges are inside, right and bottom edges are outside
//  - subtractRects(rect, holes)       rect minus the holes, as a list of rectangles

const BAR_SIZE = Object.freeze({ width: 560, height: 44 });

function rectOk(r) {
  return !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height);
}

function plain(r) {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// The overlap of two rectangles, or null when they share no area.
function intersect(a, b) {
  if (!rectOk(a) || !rectOk(b)) return null;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

// A window can hang off its display (half moved off the edge, or larger than the screen). The capture takes the part inside the
// display it is cropped from; the rectangle is in the same coordinates as the inputs.
function cropRect(bounds, area) {
  return intersect(bounds, area);
}

function pointInRect(point, rect) {
  if (!point || !rectOk(rect) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

// rect minus the holes: a list of rectangles that together cover what is left (empty when the holes cover all of it).
function subtractRects(rect, holes) {
  let pieces = [plain(rect)];
  for (const hole of holes) {
    const next = [];
    for (const piece of pieces) {
      const cut = intersect(piece, hole);
      if (!cut) {
        next.push(piece);
        continue;
      }
      if (cut.y > piece.y) next.push({ x: piece.x, y: piece.y, width: piece.width, height: cut.y - piece.y });
      if (cut.y + cut.height < piece.y + piece.height) {
        next.push({ x: piece.x, y: cut.y + cut.height, width: piece.width, height: piece.y + piece.height - (cut.y + cut.height) });
      }
      if (cut.x > piece.x) next.push({ x: piece.x, y: cut.y, width: cut.x - piece.x, height: cut.height });
      if (cut.x + cut.width < piece.x + piece.width) {
        next.push({ x: cut.x + cut.width, y: cut.y, width: piece.x + piece.width - (cut.x + cut.width), height: cut.height });
      }
    }
    pieces = next;
  }
  return pieces;
}

const sameProgram = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

// The parts of `bounds` (the rectangle a window-scope capture keeps) that a screenshot must show as flat grey: the visible parts of
// windows that belong to another program and sit above the target in the stacking order. `windows` is the list of every visible
// top-level window, topmost first ({ id, exe, bounds, ... }); `target` is { id, exe } of the window the model may see.
//  - A window of the target's own program (its menus, drop-downs, dialogs and tooltips) is never masked, and it hides the part of
//    another program's window that it covers, so the app's own popups stay visible.
//  - Windows below the target are covered by it and never listed.
//  - A target that is not in the list cannot be placed in the stacking order, so the whole rectangle is returned: showing nothing
//    is the safe answer when it is not known what is on top.
function maskRects(bounds, windows, target) {
  if (!rectOk(bounds)) return [];
  if (!target || !Array.isArray(windows)) return [plain(bounds)];
  const index = windows.findIndex(w => w && String(w.id) === String(target.id));
  if (index < 0) return [plain(bounds)];
  const own = [];
  const masked = [];
  for (let i = 0; i < index; i++) {
    const w = windows[i];
    if (!w || !rectOk(w.bounds)) continue;
    const overlap = intersect(w.bounds, bounds);
    if (!overlap) continue;
    if (sameProgram(w.exe, target.exe)) {
      own.push(overlap);
    } else {
      masked.push(...subtractRects(overlap, own));
    }
  }
  return masked;
}

// Where the overlay bar goes. `target` is the rectangle the model sees (the window in window scope), or null in display scope.
// The bar sits just above the target when there is room on its display, else just below it, else at the top centre of the display;
// display scope always uses the top centre. `clearance` keeps the bar off the amber frame that surrounds the target. Returns
// { x, y, width, height, where: 'above'|'below'|'top' }.
function barPlacement({ target = null, display, size = BAR_SIZE, gap = 8, clearance = 0 } = {}) {
  const { width, height } = size;
  const top = () => ({ x: Math.round(display.x + (display.width - width) / 2), y: Math.round(display.y + gap), width, height, where: 'top' });
  if (!rectOk(display) || !rectOk(target)) return top();
  const x = Math.round(Math.min(Math.max(target.x + (target.width - width) / 2, display.x), display.x + Math.max(0, display.width - width)));
  const above = target.y - clearance - gap - height;
  if (above >= display.y) return { x, y: Math.round(above), width, height, where: 'above' };
  const below = target.y + target.height + clearance + gap;
  if (below + height <= display.y + display.height) return { x, y: Math.round(below), width, height, where: 'below' };
  return top();
}

// The four strips of the frame around `rect`, `thickness` wide, as { top, bottom, left, right }. A strip goes just outside the
// rectangle; when that would leave `within` (the display, where the window touches its edge), it goes just inside instead, so the
// frame is always on screen.
function frameStrips(rect, thickness, within = null) {
  const t = thickness;
  const fits = r => !within || (r.x >= within.x && r.y >= within.y && r.x + r.width <= within.x + within.width && r.y + r.height <= within.y + within.height);
  const pick = (outside, inside) => (fits(outside) ? outside : inside);
  return {
    top: pick({ x: rect.x - t, y: rect.y - t, width: rect.width + 2 * t, height: t }, { x: rect.x, y: rect.y, width: rect.width, height: t }),
    bottom: pick({ x: rect.x - t, y: rect.y + rect.height, width: rect.width + 2 * t, height: t }, { x: rect.x, y: rect.y + rect.height - t, width: rect.width, height: t }),
    left: pick({ x: rect.x - t, y: rect.y, width: t, height: rect.height }, { x: rect.x, y: rect.y + t, width: t, height: Math.max(1, rect.height - 2 * t) }),
    right: pick({ x: rect.x + rect.width, y: rect.y, width: t, height: rect.height }, { x: rect.x + rect.width - t, y: rect.y + t, width: t, height: Math.max(1, rect.height - 2 * t) }),
  };
}

// The display (from a list of { id, bounds }) that holds most of a rectangle, or null when it touches none.
function displayHolding(rect, displays) {
  let best = null;
  let bestArea = 0;
  for (const d of displays ?? []) {
    const overlap = intersect(rect, d.bounds);
    const area = overlap ? overlap.width * overlap.height : 0;
    if (area > bestArea) {
      best = d;
      bestArea = area;
    }
  }
  return best;
}

// The size the capture is sent at: the long edge is at most maxEdge, the aspect ratio is kept, and a picture that is already small
// enough is not enlarged. -> { width, height }
function fitEdge(width, height, maxEdge) {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

module.exports = { BAR_SIZE, intersect, cropRect, maskRects, barPlacement, frameStrips, pointInRect, subtractRects, displayHolding, fitEdge, rectOk };
