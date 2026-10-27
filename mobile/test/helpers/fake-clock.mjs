// Fake clock for the mobile suites. Shared by every later suite (mob-03 onward).
// Timers fire only when a test moves the clock with advance(ms). It has the same shape as the clock option of
// lib/remote/frames.mjs: now(), setTimeout, clearTimeout, setInterval and clearInterval. Handles are numbers from 1.
// Timers due at the same instant fire in the order they were set. A timer scheduled inside a callback that is already
// due in the same advance() window fires in that window too, so a loop that re-arms at zero delay never ends; advance()
// stops after MAX_FIRES callbacks in one call and throws, so such a loop fails the test instead of hanging it.

const MAX_FIRES = 1_000_000;

export function createFakeClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers = new Map(); // handle -> { at, fn, every, order }

  const pick = target => {
    let best = null;
    for (const [handle, timer] of timers) {
      if (timer.at > target) continue;
      if (!best || timer.at < best.timer.at || (timer.at === best.timer.at && timer.order < best.timer.order)) {
        best = { handle, timer };
      }
    }
    return best;
  };

  const clock = {
    now: () => now,

    setTimeout(fn, ms = 0) {
      const handle = ++seq;
      timers.set(handle, { at: now + Math.max(0, Number(ms) || 0), fn, every: null, order: handle });
      return handle;
    },

    clearTimeout(handle) {
      timers.delete(handle);
    },

    setInterval(fn, ms) {
      const every = Math.max(1, Number(ms) || 1);
      const handle = ++seq;
      timers.set(handle, { at: now + every, fn, every, order: handle });
      return handle;
    },

    clearInterval(handle) {
      timers.delete(handle);
    },

    // Moves time forward by ms, firing every timer that comes due on the way, in time order.
    advance(ms) {
      const target = now + Math.max(0, Number(ms) || 0);
      let fires = 0;
      for (let next = pick(target); next; next = pick(target)) {
        if (++fires > MAX_FIRES) throw new Error('fake clock: too many timer callbacks in one advance()');
        now = next.timer.at;
        if (next.timer.every !== null) next.timer.at += next.timer.every;
        else timers.delete(next.handle);
        next.timer.fn();
      }
      now = target;
      return now;
    },

    // Number of timers still armed. A closed session should leave none behind.
    get pending() {
      return timers.size;
    },

    // The time of the next armed timer, or null.
    get nextAt() {
      let at = null;
      for (const timer of timers.values()) if (at === null || timer.at < at) at = timer.at;
      return at;
    },
  };
  return clock;
}
