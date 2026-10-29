// Suite for the desktop wiring of the phones (mob-20, track B): the server starts the Bridge with its running map, a phone's answer to an
// approval carries the device that gave it, a repeated x-plenum-client-id on POST /api/chat is refused, stop.mjs aborts in process, and the
// tray shows the phones. Run it through the sealed runner: node build/mobile/run.mjs --id mob20 track-b.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { freePort, startMockModel, startSealedServer, until } from './helpers/sealed-server.mjs';

const APP = path.resolve(import.meta.dirname, '..', '..');
const read = rel => readFileSync(path.join(APP, rel), 'utf8');
const { stopEverything, noticeText } = await import(pathToFileURL(path.join(APP, 'lib', 'remote', 'stop.mjs')).href);

const PHONE = 'a1b2c3d4e5f60718';

const canConnect = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => resolve(false));
});

// One POST /api/chat. The stream is read to its end, so a finished send is known to be finished.
async function chat(server, body, headers = {}) {
  const res = await fetch(`${server.url}/api/chat`, {
    method: 'POST',
    headers: { ...server.headers, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A stream, not JSON.
  }
  return { status: res.status, text, json };
}

// The events channel (GET /api/events) read as a list of parsed events, with a way to wait for one.
async function subscribe(server) {
  const res = await fetch(`${server.url}/api/events`, { headers: server.headers, signal: AbortSignal.timeout(120_000) });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = block.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            seen.push(JSON.parse(line.slice(5)));
          } catch {
            // Not an event.
          }
        }
      }
    } catch {
      // The stream ends with the server or the test.
    }
  })();
  return {
    find: (pred, ms = 15_000) => until(() => seen.find(pred), 'an event on the channel', ms, 20),
    close: () => reader.cancel().catch(() => {}),
  };
}

// The approval events inside a chat stream.
const cardsOf = text => text.split('\n').filter(l => l.startsWith('data:')).map(l => {
  try {
    return JSON.parse(l.slice(5));
  } catch {
    return null;
  }
}).filter(e => e?.type === 'approval');

describe('the Bridge starts with the server, from the saved settings', () => {
  test('phones that are on accept connections without any phone request', async () => {
    const port = await freePort();
    const server = await startSealedServer({ name: 'tb-start', phones: { enabled: true, port } });
    try {
      await until(() => canConnect(port), 'the Bridge port to listen', 8000, 50);
    } finally {
      await server.stop();
    }
  });

  test('phones that are off bind nothing at start', async () => {
    const server = await startSealedServer({ name: 'tb-off' });
    try {
      await new Promise(resolve => setTimeout(resolve, 300));
      const view = (await server.get('/api/phones')).body;
      assert.equal(view.running, false);
    } finally {
      await server.stop();
    }
  });
});

describe('POST /api/chat honours x-plenum-client-id', () => {
  let server;
  before(async () => {
    server = await startSealedServer({ name: 'tb-chat', projects: ['p1'] });
  });
  after(async () => {
    await server?.stop();
  });

  test('a repeat of a sent message within a minute is refused with the 409 shape', async () => {
    const first = await chat(server, { project: 'p1', message: 'hello once' }, { 'x-plenum-client-id': 'send-one' });
    assert.equal(first.status, 200, first.text.slice(0, 300));
    const again = await chat(server, { project: 'p1', message: 'hello once' }, { 'x-plenum-client-id': 'send-one' });
    assert.equal(again.status, 409);
    assert.deepEqual(again.json, { error: 'That message was already sent.' });
  });

  test('another client id is sent, and a send without the header is never refused for it', async () => {
    const other = await chat(server, { project: 'p1', message: 'hello two' }, { 'x-plenum-client-id': 'send-two' });
    assert.equal(other.status, 200);
    const plainA = await chat(server, { project: 'p1', message: 'plain one' });
    const plainB = await chat(server, { project: 'p1', message: 'plain two' });
    assert.equal(plainA.status, 200);
    assert.equal(plainB.status, 200);
  });

  test('an id that is not a plain token is ignored, not refused', async () => {
    const a = await chat(server, { project: 'p1', message: 'odd id one' }, { 'x-plenum-client-id': 'has space' });
    const b = await chat(server, { project: 'p1', message: 'odd id two' }, { 'x-plenum-client-id': 'has space' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });
});

describe('an approval answered from a phone carries the device', () => {
  let server;
  let mock;
  before(async () => {
    mock = await startMockModel();
    // Each run that asks for a file has a project of its own: the mock writes only while the history holds no tool result yet.
    server = await startSealedServer({ name: 'tb-approve', mock, projects: ['p1', 'p2', 'p3'] });
  });
  after(async () => {
    await server?.stop();
    await mock?.close();
  });

  // Starts a run that asks to write a file (so a card waits), and returns the run and the card's id.
  async function startAsk(project, text) {
    const run = chat(server, { project, message: `WRITE a file please ${text}` });
    await until(async () => (await server.state()).approvalsWaiting >= 1, 'a card to wait', 30_000);
    const snapshot = (await server.get('/api/activity')).body;
    const card = snapshot.approvals.at(-1);
    assert.ok(card?.approvalId, 'the card is on the Agents board');
    return { run, approvalId: card.approvalId };
  }

  test('the answered event says which phone answered, and the card names the model', async () => {
    const events = await subscribe(server);
    try {
      const { run, approvalId } = await startAsk('p1', 'one');
      const answer = await server.post('/api/approve', { approvalId, allow: true, via: 'forged-in-body' }, { 'x-plenum-device': PHONE });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const event = await events.find(e => e.type === 'approval' && e.approvalId === approvalId && e.action === 'answered');
      assert.equal(event.allow, true);
      assert.equal(event.via, PHONE, 'the device comes from the header the Bridge sets, not from the body');
      const done = await run;
      assert.equal(done.status, 200);
      const card = cardsOf(done.text).find(c => c.approvalId === approvalId);
      assert.ok(card, 'the chat stream carried the card');
      assert.equal(typeof card.who, 'string');
      assert.ok(card.who.length > 0, 'the card says which model asks');
    } finally {
      events.close();
    }
  });

  test('an answer at the computer, or with a header that is not a device id, carries no device', async () => {
    const events = await subscribe(server);
    try {
      const first = await startAsk('p2', 'two');
      const desktop = await server.post('/api/approve', { approvalId: first.approvalId, allow: false, via: PHONE });
      assert.equal(desktop.status, 200);
      const ev1 = await events.find(e => e.type === 'approval' && e.approvalId === first.approvalId && e.action === 'answered');
      assert.equal(ev1.via, undefined, 'a body cannot name a device');
      await first.run;

      const second = await startAsk('p3', 'three');
      const junk = await server.post('/api/approve', { approvalId: second.approvalId, allow: true }, { 'x-plenum-device': 'not a device id!' });
      assert.equal(junk.status, 200);
      const ev2 = await events.find(e => e.type === 'approval' && e.approvalId === second.approvalId && e.action === 'answered');
      assert.equal(ev2.via, undefined, 'a header that is not a device id is ignored');
      await second.run;
    } finally {
      events.close();
    }
  });
});

describe('stop.mjs aborts the replies it holds, in process', () => {
  const runFor = () => {
    const ac = new AbortController();
    return { ac, signal: ac.signal, abort: () => ac.abort() };
  };
  const quiet = {
    drives: { stopAll: () => 0, stopProject: () => 0 },
    agents: { stopAll: () => 0 },
    projectIds: () => [],
    token: () => 'x'.repeat(64),
    publish: () => {},
  };
  const ok = cancelled => async () => ({ status: 200, json: { cancelled } });

  test('a run of the project is aborted before the loopback answers, and counted once', async () => {
    const running = new Map();
    const run = runFor();
    running.set('p1', run.ac);
    let seenAborted = null;
    const counts = await stopEverything({
      ...quiet, running, project: 'p1', port: 1,
      request: async (path, body) => {
        seenAborted = run.signal.aborted;
        assert.equal(path, '/api/cancel');
        assert.deepEqual(body, { project: 'p1' });
        return { status: 200, json: { cancelled: true } };
      },
    });
    assert.equal(seenAborted, true, 'the abort came before the cancel route was asked');
    assert.equal(counts.cancelled, 1);
  });

  test('a thread run of the project is found too', async () => {
    const running = new Map();
    const run = runFor();
    running.set('p1-t9f8e7d', run.ac);
    const counts = await stopEverything({ ...quiet, running, project: 'p1', port: 1, request: ok(false) });
    assert.equal(run.signal.aborted, true);
    assert.equal(counts.cancelled, 1);
  });

  test('a project run and its thread run are both stopped, and both are counted (two replies, not one)', async () => {
    const running = new Map();
    const main = runFor();
    const thread = runFor();
    running.set('p5', main.ac);
    running.set('p5-t9f8e7d', thread.ac);
    const published = [];
    const counts = await stopEverything({ ...quiet, publish: ev => published.push(ev), running, port: 1, request: ok(false) });
    assert.equal(main.signal.aborted, true);
    assert.equal(thread.signal.aborted, true);
    assert.equal(counts.cancelled, 2, 'the thread run was stopped, so it is counted');
    assert.equal(published.length, 1);
    assert.equal(published[0].text, 'Stop pressed: 2 replies.');
  });

  test('a Stop for one project counts its thread run too, each run once, and leaves another project running', async () => {
    const running = new Map();
    const main = runFor();
    const thread = runFor();
    const other = runFor();
    running.set('p5', main.ac);
    running.set('p5-t9f8e7d', thread.ac);
    running.set('p6', other.ac);
    const posted = [];
    const counts = await stopEverything({
      ...quiet, running, project: 'p5', port: 1,
      request: async (path, body) => {
        posted.push(body.project);
        return { status: 200, json: { cancelled: false } };
      },
    });
    assert.equal(main.signal.aborted, true);
    assert.equal(thread.signal.aborted, true);
    assert.equal(other.signal.aborted, false, 'another project is not stopped');
    assert.equal(counts.cancelled, 2, 'the project run and its thread run are two replies');
    assert.deepEqual(posted.sort(), ['p5', 'p5-t9f8e7d'], 'each run is asked once');
  });

  test('when the loopback route cannot be reached the run is still stopped, once', async () => {
    const running = new Map();
    const run = runFor();
    running.set('p2', run.ac);
    const counts = await stopEverything({ ...quiet, running, port: 1, request: async () => { throw new Error('refused'); } });
    assert.equal(run.signal.aborted, true);
    assert.equal(counts.cancelled, 1);
  });

  test('a route that answers an error does not stop the count from being right', async () => {
    const running = new Map();
    const run = runFor();
    running.set('p3', run.ac);
    const counts = await stopEverything({ ...quiet, running, port: 1, request: async () => ({ status: 500, json: null }) });
    assert.equal(run.signal.aborted, true);
    assert.equal(counts.cancelled, 1);
  });

  test('a run that is already aborted is not counted again, and nothing is invented', async () => {
    const running = new Map();
    const run = runFor();
    run.abort();
    running.set('p4', run.ac);
    const counts = await stopEverything({ ...quiet, running, port: 1, request: ok(false) });
    assert.equal(counts.cancelled, 0);
  });

  test('the notice says what was stopped and from where', () => {
    assert.equal(noticeText({ by: "Will's iPhone", cancelled: 1 }), "Stop pressed on Will's iPhone: 1 reply.");
    assert.equal(noticeText({}), 'Stop pressed: nothing was running.');
  });
});

describe('the wiring in the files (source checks)', () => {
  test('lib/routes/remote.mjs no longer starts the Bridge on a timer', () => {
    const text = read('lib/routes/remote.mjs');
    assert.doesNotMatch(text, /scheduleStart|START_DELAY_MS/);
  });

  test('server.mjs starts the Bridge after listen, with the running map and publicState, through import()', () => {
    const text = read('server.mjs');
    assert.match(text, /await listen\(\);\nawait startPhones\(\);/);
    assert.match(text, /import\('\.\/lib\/remote\/index\.mjs'\)/);
    assert.match(text, /startRemote\(\{ running, publicState, port: PORT/);
  });

  test('desktop/main.cjs has the tray item for the phones and a generic setItem', () => {
    const text = read('desktop/main.cjs');
    assert.match(text, /setItem: \(name, item\) => setTrayItem\(name, item\)/);
    assert.match(text, /setUpdateItem: item => setTrayItem\('update', item\)/);
    assert.match(text, /Phones \(\$\{count\} connected\)/);
    assert.match(text, /message\.type === 'phones-indicator'/);
    assert.doesNotMatch(text, /\bupdateItem\b/);
    execFileSync(process.execPath, ['--check', path.join(APP, 'desktop', 'main.cjs')]);
  });
});
