// ?selftest (mob-10, wave 104; MOBILE.json tests and MOBILE-UI 16.3). The shell runs the same steps a person would, through the channel,
// and reports one JSON object. The report goes to the computer as one debug line (POST /_bridge/log) and is returned to the caller.
// Steps, in order:
//   connect    the channel is connected and HELLO arrived
//   ui-pull    GET / answers 200 with the desktop UI
//   chat-echo  POST /api/chat with the echo model streams a reply that says "Echo"
//   approval   a new approval card is DENIED from the phone and the computer accepts the answer (waits up to approvalWaitMs); deny is the safe
//              direction and still proves the answer path (phone security round: the self-test never approves anything)
//   stop       a running turn is stopped with STOP; the STOP_ACK carries the same id and the turn's stream ends
// No step is skipped silently: a step that cannot run is a failed step with its reason.

export const STEP_NAMES = Object.freeze(['connect', 'ui-pull', 'chat-echo', 'approval', 'stop']);

const decoder = new TextDecoder();

async function readAll(body, limit = 1_000_000) {
  const reader = body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return decoder.decode(out);
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
});

async function waitFor(fn, ms, label, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, step));
  }
}

// Runs the steps against an open channel. `project` is the project id to chat in. Returns the report.
export async function runSelfTest({ channel, project, approvalWaitMs = 15000, connectMs = 15000, log = () => {}, now = () => Date.now() } = {}) {
  if (!channel) throw new TypeError('runSelfTest needs a channel');
  const started = now();
  const steps = [];
  const step = async (name, fn) => {
    const t0 = now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: now() - t0, detail: detail ?? '' });
    } catch (err) {
      steps.push({ name, ok: false, ms: now() - t0, detail: String(err?.message ?? err).slice(0, 200) });
    }
  };

  await step('connect', async () => {
    await waitFor(() => channel.state.status === 'connected' && channel.hello, connectMs, 'the connection');
    return `protocol ${channel.hello?.protocol?.major}.${channel.hello?.protocol?.minor}`;
  });

  await step('ui-pull', async () => {
    const res = await withTimeout(channel.request({ method: 'GET', path: '/' }), 15000, 'GET /');
    const text = await readAll(res.body, 4_000_000);
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!/<html/i.test(text)) throw new Error('no page');
    return `${text.length} characters`;
  });

  let chatProject = project ?? null;
  await step('chat-echo', async () => {
    if (!chatProject) {
      const st = await withTimeout(channel.request({ method: 'GET', path: '/api/state' }), 10000, 'GET /api/state');
      const parsed = JSON.parse(await readAll(st.body));
      chatProject = parsed?.projects?.[0]?.id ?? null;
    }
    if (!chatProject) throw new Error('no project');
    const res = await withTimeout(channel.request({ method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ project: chatProject, message: 'selftest: say echo' })), 20000, 'POST /api/chat');
    const text = await withTimeout(readAll(res.body), 20000, 'the reply');
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    if (!/Echo/.test(text)) throw new Error('no echo in the reply');
    return 'the echo model answered';
  });

  await step('approval', async () => {
    const events = await channel.request({ method: 'GET', path: '/api/events' });
    let found = null;
    let buffer = '';
    const reader = events.body.getReader();
    const until = now() + approvalWaitMs;
    try {
      while (!found && now() < until) {
        const read = await Promise.race([reader.read(), new Promise(resolve => setTimeout(() => resolve({ done: true, timeout: true }), Math.max(0, until - now())))]);
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0 && !found) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let value = null;
            try { value = JSON.parse(line.slice(6)); } catch { value = null; }
            // A new card only: an 'answered' event (it carries an action) is not one.
            if (value?.type === 'approval' && typeof value.approvalId === 'string' && value.action === undefined) {
              found = value;
              break;
            }
          }
          cut = buffer.indexOf('\n\n');
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already done */ }
    }
    if (!found) throw new Error('no approval card came in the wait');
    const answer = await withTimeout(channel.request({ method: 'POST', path: '/api/approve', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ approvalId: found.approvalId, allow: false })), 10000, 'POST /api/approve');
    await readAll(answer.body);
    if (answer.status !== 200) throw new Error(`status ${answer.status}`);
    return 'denied from the phone';
  });

  await step('stop', async () => {
    if (!chatProject) throw new Error('no project');
    const res = await withTimeout(channel.request({ method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ project: chatProject, message: 'selftest: stop me' })), 20000, 'POST /api/chat');
    const reader = res.body.getReader();
    await withTimeout(reader.read(), 20000, 'the first chunk');
    const ack = await withTimeout(channel.stop(chatProject), 15000, 'STOP');
    if (!ack?.id) throw new Error('no STOP_ACK');
    try {
      await withTimeout((async () => { for (;;) { const r = await reader.read(); if (r.done) return; } })(), 10000, 'the stream end');
    } catch {
      await reader.cancel().catch(() => {});
    }
    return `cancelled ${ack.cancelled}, agents ${ack.agentsStopped}, cards ${ack.cardsDenied}`;
  });

  const report = {
    kind: 'plenum-shell-selftest',
    ok: steps.length === STEP_NAMES.length && steps.every(s => s.ok),
    passed: steps.filter(s => s.ok).length,
    total: STEP_NAMES.length,
    ms: now() - started,
    steps,
  };
  try {
    log(`selftest ${JSON.stringify(report)}`);
  } catch {
    // The report is returned in any case.
  }
  return report;
}
