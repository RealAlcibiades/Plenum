// Stop on the phone (mob-10, wave 104; MOBILE.json decision.floor.additions; MOBILE-UI 9.1 and 6.x result copy).
// Stop stops everything on the computer: runs, agents, drives and pending cards. One tap, no confirm. The request goes through the
// channel's priority lane, is queued while the phone is not connected and is sent again on every reconnect for 60 s. The controller
// here only tracks what the Stop control shows; the worker does the sending and the retrying.
//
// States (MOBILE-UI 9.1): idle | sending | queued | done | failed. 'done' holds for 1.6 s, then idle.
// A press that gets no answer at all fails after STOP_WATCHDOG_MS (the worker gives up at 60 s; this is the page's own backstop).

export const STOP_DONE_MS = 1600;
export const STOP_WATCHDOG_MS = 65000;
export const STOP_STATES = Object.freeze(['idle', 'sending', 'queued', 'done', 'failed']);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The result toast and sheet copy (MOBILE-UI 9.1): "Stopped everything on Home PC: 2 replies, 1 computer run, 3 agents. 1 card denied."
export function stopResultText(ack, computerName = 'this computer') {
  const replies = Number(ack?.cancelled) || 0;
  const runs = Number(ack?.drivesStopped) || 0;
  const agents = Number(ack?.agentsStopped) || 0;
  const cards = Number(ack?.cardsDenied) || 0;
  if (!replies && !runs && !agents && !cards) return `Nothing was running on ${computerName}.`;
  const parts = [];
  if (replies) parts.push(plural(replies, 'reply', 'replies'));
  if (runs) parts.push(plural(runs, 'computer run', 'computer runs'));
  if (agents) parts.push(plural(agents, 'agent', 'agents'));
  const tail = cards ? ` ${plural(cards, 'card', 'cards')} denied.` : '';
  return `Stopped everything on ${computerName}: ${parts.join(', ')}.${tail}`;
}

export const STOP_FAILURE_TEXT = Object.freeze({
  title: 'Could not reach the computer',
  body: 'The phone tried for 60 seconds. At the computer, press Stop on the bar or Ctrl+Alt+Esc. Moving the mouse also pauses a computer run.',
});

export const STOP_QUEUED_TEXT = 'Stop will be sent when the computer is reachable. Trying for 60 seconds.';

// The computer closed a Stop sent without unlocking: it does not know this phone's Stop key (the phone was removed there).
export const STOP_NOT_ACCEPTED = computer => `${computer} did not accept this Stop. This phone may have been removed there. At the computer, press Stop on the bar or Ctrl+Alt+Esc.`;

export const STOP_NEEDS_UNLOCK = 'Unlock Plenum to send this Stop. It goes out as soon as Plenum unlocks.';

// The controller. `channel` is openChannel's object; `clock` gives setTimeout/clearTimeout (tests inject a fake one).
export function createStopController({ channel, clock = globalThis, computerName = '' } = {}) {
  if (!channel || typeof channel.stop !== 'function') throw new TypeError('createStopController needs a channel');
  let state = 'idle';
  let lastAck = null;
  let lastError = null;
  let timer = null;
  const subs = new Set();

  const set = (next, extra = {}) => {
    state = next;
    if (extra.ack !== undefined) lastAck = extra.ack;
    if (extra.error !== undefined) lastError = extra.error;
    const view = { state, ack: lastAck, error: lastError, text: textFor(next, lastAck, lastError) };
    for (const fn of Array.from(subs)) {
      try { fn(view); } catch { /* a listener error must not stop the others */ }
    }
  };

  const textFor = (s, ack, error) => {
    if (s === 'done') return stopResultText(ack, computerName || 'this computer');
    if (s === 'queued') return STOP_QUEUED_TEXT;
    if (s === 'failed' && error === 'unknown') return STOP_NOT_ACCEPTED(computerName || 'this computer');
    if (s === 'failed') return `${STOP_FAILURE_TEXT.title}. ${STOP_FAILURE_TEXT.body}`;
    if (s === 'sending') return 'Stopping everything on the computer';
    return error ? String(error) : '';
  };

  // The channel reports 'queued' while the phone is not connected; a 'sent' state means the request is on the wire.
  const unsubscribe = channel.onStopState?.(view => {
    if (state === 'sending' && view.state === 'queued') set('queued');
    if (state === 'queued' && view.state === 'sent') set('sending');
  });

  return {
    get state() { return state; },
    get view() { return { state, ack: lastAck, error: lastError, text: textFor(state, lastAck, lastError) }; },
    subscribe(fn) {
      subs.add(fn);
      try { fn(this.view); } catch { /* listener error */ }
      return () => subs.delete(fn);
    },
    // Presses Stop. Resolves with the view that ended the press ('done' or 'failed'). `project` limits the stop to one project.
    async press(project = null) {
      if (state === 'sending' || state === 'queued') return this.view;
      clock.clearTimeout(timer);
      timer = null;
      set('sending', { error: null });
      // The worker answers or gives up inside 60 s; a channel that never answers (a worker that died) still ends the press here.
      let watchdog = null;
      const silent = new Promise((_, reject) => {
        watchdog = clock.setTimeout(() => reject(Object.assign(new Error('unreachable'), { code: 'unreachable' })), STOP_WATCHDOG_MS);
      });
      try {
        const ack = await Promise.race([channel.stop(project), silent]);
        clock.clearTimeout(watchdog);
        set('done', { ack, error: null });
        timer = clock.setTimeout(() => {
          timer = null;
          if (state === 'done') set('idle');
        }, STOP_DONE_MS);
      } catch (err) {
        clock.clearTimeout(watchdog);
        set('failed', { error: err?.code ?? 'unreachable' });
      }
      return this.view;
    },
    dispose() {
      clock.clearTimeout(timer);
      timer = null;
      unsubscribe?.();
      subs.clear();
    },
  };
}
