// Stop everything (MOBILE.json decision.floor.additions, "Stop from the phone always works"). Owned by mob-03.
//
// stopEverything({ project? }) ends what a person would end with every Stop on the desktop at once:
//   1. every live drive (lib/drive.mjs stopAll('user'), or the project's own drive),
//   2. every agent of every project (lib/agent-run.mjs stopAll(projectId)),
//   3. every running reply: aborted in this process through the server's running map (when the caller has it), then POST /api/cancel for
//      each running project through the server's own loopback route with the real token, which aborts what is still running and denies
//      its waiting cards through approvalRequester's abort handler,
//   4. a notice on the events channel saying what was stopped and from where.
// It answers { cancelled, drivesStopped, agentsStopped, cardsDenied }: the same four counts a STOP_ACK frame carries.
//
// The in-process steps run first and synchronously, so the person's Stop takes effect before the first byte goes out on loopback.
// cardsDenied is the drop in the number of approval cards waiting, read before and after (the abort handler answers the cards in the
// same tick the cancel route aborts the run). The in-process abort of a reply does not wait for the loopback route; if the route cannot
// be reached, the run is still aborted through the server's `running` map.
//
// This module has no dependency outside node: and the existing lib files, so POST /api/stop-all works on a build that has no
// phone support. Nothing here logs, and nothing puts the token, a project path or a card's text in a notice.
import http from 'node:http';

const DEFAULT_TIMEOUT_MS = 3000;
const NOTICE_MAX = 300;

const clipText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The keys of the running map that a project id covers: its Main run, and its threads (lib/scope.mjs runningScopes, kept here so this
// module needs nothing from the app).
const runningKeysOf = (running, id) => (typeof running.keys === 'function' ? [...running.keys()].filter(key => key === id || (typeof key === 'string' && key.startsWith(`${id}-t`))) : []);

// One JSON POST to the server's own loopback address. Resolves { status, json }; rejects on a refused connection or a timeout.
export function loopbackPost({ host = '127.0.0.1', port, token, path, body = {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({
      host,
      port,
      method: 'POST',
      path,
      agent: false,
      headers: {
        host: `${host}:${port}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        'x-plenum-token': token,
        connection: 'close',
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(text);
  });
}

// The parts of the app stopEverything needs, looked up only when the caller did not hand its own (tests do).
async function defaults(options) {
  const out = {};
  if (!options.drives) {
    const drive = await import('../drive.mjs');
    out.drives = { stopAll: reason => drive.stopAll(reason), stopProject: (id, reason) => {
      const d = drive.driveFor(id);
      if (!d) return 0;
      try {
        d.stop(reason);
        return 1;
      } catch {
        return 0;
      }
    } };
  }
  if (!options.agents) {
    const agentRun = await import('../agent-run.mjs');
    out.agents = { stopAll: projectId => agentRun.stopAll(projectId) };
  }
  if (!options.projectIds) {
    const store = await import('../store.mjs');
    out.projectIds = () => (store.get()?.projects ?? []).map(p => p.id);
  }
  if (!options.token) {
    const auth = await import('../auth.mjs');
    out.token = auth.token;
  }
  if (!options.publish) {
    const events = await import('../events.mjs');
    out.publish = ev => {
      events.publish(ev);
      events.publishState('stop');
    };
  }
  return out;
}

// The notice text: what was stopped and where from. `by` is the phone's own label (already cleaned by the registry), or empty.
export function noticeText({ by = '', cancelled = 0, drivesStopped = 0, agentsStopped = 0, cardsDenied = 0 }) {
  const parts = [];
  if (cancelled) parts.push(plural(cancelled, 'reply', 'replies'));
  if (drivesStopped) parts.push(`${drivesStopped} computer or browser ${drivesStopped === 1 ? 'run' : 'runs'}`);
  if (agentsStopped) parts.push(plural(agentsStopped, 'agent'));
  if (cardsDenied) parts.push(`${plural(cardsDenied, 'card')} denied`);
  const label = clipText(by, 60);
  const head = label ? `Stop pressed on ${label}` : 'Stop pressed';
  return clipText(`${head}: ${parts.length ? parts.join(', ') : 'nothing was running'}.`, NOTICE_MAX);
}

/**
 * @param {object} [options]
 * @param {string} [options.project]       stop only this project (its reply, its agents, its drive); every project when absent
 * @param {Map}    [options.running]       the server's running map (project id -> AbortController); used to find what runs and as a fallback abort
 * @param {number} [options.port]          the server's real listen port (required unless `request` is given)
 * @param {string} [options.host]          default 127.0.0.1
 * @param {() => string} [options.token]   the per-launch token (default lib/auth.mjs token)
 * @param {(path: string, body: object) => Promise<{status:number,json:any}>} [options.request]   replaces the loopback POST (tests)
 * @param {{stopAll(reason: string): number, stopProject?(id: string, reason: string): number}} [options.drives]
 * @param {{stopAll(projectId: string): number}} [options.agents]
 * @param {() => string[]} [options.projectIds]  every project id (default: the store's projects)
 * @param {() => (number|Promise<number>)} [options.countCards]  how many approval cards wait now
 * @param {(event: object) => void} [options.publish]   publishes the notice (default lib/events.mjs publish)
 * @param {string} [options.by]            the phone's label, for the notice
 * @param {number} [options.timeoutMs]
 * @param {number} [options.waitMs]        wait up to this long for the aborted runs to leave `running` (default 0: answer at once)
 */
export async function stopEverything(options = {}) {
  const given = options;
  const filled = { ...given, ...(await defaults(given)) };
  const { project = null, running = null, host = '127.0.0.1', port, request = null, by = '', timeoutMs = DEFAULT_TIMEOUT_MS, waitMs = 0 } = given;
  const { drives, agents, projectIds, token, publish } = filled;
  const countCards = typeof given.countCards === 'function' ? given.countCards : null;
  const only = typeof project === 'string' && project.length > 0 ? project : null;
  if (!request && !Number.isInteger(port)) throw new TypeError('stopEverything needs the server port or a request function.');

  let before = 0;
  if (countCards) {
    try {
      before = Number(await countCards()) || 0;
    } catch {
      before = 0;
    }
  }

  // The projects to look at. A reply can only be running for a project in the running map; agents are found by project id.
  const known = new Set();
  try {
    for (const id of projectIds()) if (typeof id === 'string') known.add(id);
  } catch {
    // An unreadable store leaves only the running map.
  }
  const runningIds = running ? [...running.keys()] : [];
  for (const id of runningIds) known.add(id);
  const targets = only ? [only] : [...known];
  // A Stop for one project names the runs of that project that are running (its own and its thread runs, each once). A project with
  // none running is asked by its id, as before.
  const projectRuns = only && running ? runningKeysOf(running, only) : [];
  const toCancel = only ? (projectRuns.length ? projectRuns : [only]) : (running ? runningIds : [...known]);

  // 1 and 2: in-process, synchronous.
  let drivesStopped = 0;
  try {
    drivesStopped = only ? (drives.stopProject?.(only, 'user') ?? 0) : drives.stopAll('user');
  } catch {
    drivesStopped = 0;
  }
  let agentsStopped = 0;
  for (const id of targets) {
    try {
      agentsStopped += Number(agents.stopAll(id)) || 0;
    } catch {
      // One project's agents failing to stop does not stop the others from being stopped.
    }
  }

  // 3: the replies. The runs this process holds are aborted first, through the server's running map: the signal the tools and the CLI
  // adapters were given, the same one the cancel route sends, and it takes effect before any loopback request. Then the server's own
  // cancel route is asked, all at once, for whatever it still finds running. A run counts once, however many of the two stopped it.
  const aborted = new Set();
  if (running) {
    for (const id of toCancel) {
      for (const key of runningKeysOf(running, id)) {
        const ac = running.get(key);
        if (ac && typeof ac.abort === 'function' && ac.signal?.aborted !== true) {
          ac.abort();
          aborted.add(id);
          // The thread run itself is recorded too, so the count below sees it stopped when its own id comes up in toCancel.
          aborted.add(key);
        }
      }
    }
  }
  const post = request ?? ((path, body) => loopbackPost({ host, port, token: token(), path, body, timeoutMs }));
  const results = await Promise.all(toCancel.map(async id => {
    let stopped = aborted.has(id);
    let answered = false;
    try {
      const answer = await post('/api/cancel', { project: id });
      if (answer?.status >= 200 && answer.status < 300) {
        answered = true;
        if (answer.json?.cancelled === true) stopped = true;
      }
    } catch {
      // Fall through to the direct abort below.
    }
    // The route did not answer: a run the caller holds is aborted directly, as before.
    const ac = running?.get(id);
    if (!answered && !stopped && ac && typeof ac.abort === 'function') {
      ac.abort();
      stopped = true;
    }
    return stopped;
  }));
  const cancelled = results.filter(Boolean).length;
  // A caller that can afford it waits until the aborted runs have left the running map, so a new run can start at once.
  if (waitMs > 0 && running) {
    const until = Date.now() + waitMs;
    while (toCancel.some(id => running.has(id)) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  }

  let after = 0;
  if (countCards) {
    try {
      after = Number(await countCards()) || 0;
    } catch {
      after = before;
    }
  }
  const cardsDenied = Math.max(0, before - after);

  const counts = { cancelled, drivesStopped, agentsStopped, cardsDenied };
  if (cancelled || drivesStopped || agentsStopped || cardsDenied) {
    try {
      publish({ type: 'notice', text: noticeText({ by, ...counts }), ...(only ? { project: only } : {}) });
    } catch {
      // The notice is a courtesy; the stop already happened.
    }
  }
  return counts;
}
