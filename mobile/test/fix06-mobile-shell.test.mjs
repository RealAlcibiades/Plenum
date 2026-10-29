// Bug hunt 0.6, the phone shell (fix06 mobile-shell): the parts that need the real Bridge (lib/remote/index.mjs) behind a phone. The shell, worker
// and screen parts are in shell-core.test.mjs, frames.test.mjs, shim.test.mjs, shell-screens.test.mjs and plugins.test.mjs.
//   B-125  the server's hello and state events list the live drives, so HELLO stops saying a model is driving once it is not.
//   B-125  a tier event carries the caps of the new tier.
// Run it in the sealed environment like the other phone suites (node --test mobile/test/fix06-mobile-shell.test.mjs).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhone } from './helpers/phone-sim.mjs';
import { makeBridge, startFakeUpstream } from './helpers/sealed-server.mjs';
import { capsForTier } from '../../lib/remote/tiers.mjs';

async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('the Bridge follows the server\'s drives and tells the phone its caps (B-125)', () => {
  let up;
  let bridge;
  let phone;
  let session;

  before(async () => {
    up = await startFakeUpstream();
    bridge = await makeBridge({
      upstream: up,
      createPusher: () => ({ sendEvent: async () => [], vapidPublicKey: () => 'k' }),
      remoteOptions: { hostname: 'Home PC' },
    });
    phone = createPhone({ name: "Will's iPhone" });
    ({ session } = await bridge.pairPhone(phone));
  });
  after(async () => {
    session?.close();
    await bridge.close();
    await up.close();
  });

  const helloNow = async () => {
    const s = await phone.connect(bridge.desktopPublic, bridge.url);
    const hello = s.hello;
    s.close();
    return hello;
  };
  const drive = (id, kind, label, steps, over = {}) => ({ id, kind, projectId: 'p1', label, state: 'running', steps, limits: { steps: 80 }, ...over });

  test('the server\'s hello event drops a drive whose stop the Bridge never saw, and its state events add one that started before the Bridge followed the stream', async () => {
    bridge.remote.handleEvent({ type: 'drive', drive: drive('d9', 'computer', 'Notepad', 3) });
    assert.deepEqual((await helloNow()).pending.driving, { kind: 'computer', app: 'Notepad', step: 3, of: 80 });
    // The server restarted (or the stream dropped) and its hello lists no drive: nothing is driving.
    bridge.remote.handleEvent({ type: 'hello', pid: 2, startedAt: 2, version: '0.6.1', generation: 2, state: { projects: [], approvalsWaiting: 0, drives: [] } });
    assert.equal('driving' in (await helloNow()).pending, false, 'HELLO no longer says a model is driving');
    // A state event lists a drive that started before the Bridge followed the stream.
    bridge.remote.handleEvent({ type: 'state', state: { projects: [], approvalsWaiting: 0, drives: [drive('d10', 'browser', 'Plenum browser', 1, { limits: { steps: null } })] } });
    assert.deepEqual((await helloNow()).pending.driving, { kind: 'browser', app: 'Plenum browser', step: 1, of: null });
    // A state event with no list leaves the drives as they are; a list without the drive ends it.
    bridge.remote.handleEvent({ type: 'state', state: { projects: [], approvalsWaiting: 0 } });
    assert.ok((await helloNow()).pending.driving, 'a state event without drives changes nothing');
    bridge.remote.handleEvent({ type: 'state', state: { projects: [], approvalsWaiting: 0, drives: [] } });
    assert.equal('driving' in (await helloNow()).pending, false);
  });

  test('a tier event carries the caps of the new tier, the same list HELLO carries', async () => {
    await bridge.remote.setTier(phone.id, 'read');
    await until(() => session.events.some(e => e.kind === 'tier' && e.tier === 'read'), 'the read tier event');
    const event = session.events.find(e => e.kind === 'tier' && e.tier === 'read');
    assert.deepEqual(event.caps, capsForTier('read'));
    assert.deepEqual((await helloNow()).caps, event.caps, 'HELLO says the same');
    assert.ok(!event.caps.includes('browser-control'), 'a Read-only phone is not given the control caps');
  });
});
