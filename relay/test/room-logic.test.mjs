// The same scenarios, run in-process against the same Worker and Room class
// with a stand-in for the Cloudflare runtime. Runs on any machine with Node 22+.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios } from './support/scenarios.mjs';
import { createFakeDriver } from './support/fake-driver.mjs';
import { connIdOf, hexRoom, hostHeaders, newSecret } from './support/frames.mjs';

// Filled in by the before hook; the scenarios read its methods when they run.
const driver = {};
before(async () => {
  Object.assign(driver, await createFakeDriver());
});
after(() => driver.stop());
scenarios(driver, 'fake');

// The address of a joining phone (Fable's re-check): the Worker passes cf-connecting-ip to the Room, and the Room tells the host in a control
// frame before the phone's first frame, so the desktop can keep one handshake allowance per address instead of one for every relay phone.
// These go to the Room object directly (the headers the Worker forwards), so they run on the in-process runtime only.
const controlOf = (message) => JSON.parse(Buffer.from(message).subarray(4).toString());
const phoneHeaders = (extra = {}) => ({ 'x-relay-role': 'phone', ...extra });

test('fake: a joining phone with cf-connecting-ip is announced to the host as an open control frame with its address, before its first frame', async () => {
  const d = driver;
  const room = hexRoom();
  const host = await d.connect(room, hostHeaders(newSecret()));
  const a = await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': '203.0.113.7' }));
  const b = await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': '2001:DB8::1' }));
  const noteA = await host.next();
  assert.equal(connIdOf(noteA), 0, 'the announcement is control (conn 0)');
  const openA = controlOf(noteA);
  assert.deepEqual(Object.keys(openA).sort(), ['conn', 'ip', 'op']);
  assert.equal(openA.op, 'open');
  assert.equal(openA.ip, '203.0.113.7');
  assert.ok(Number.isInteger(openA.conn) && openA.conn > 0);
  const openB = controlOf(await host.next());
  assert.deepEqual({ op: openB.op, ip: openB.ip }, { op: 'open', ip: '2001:db8::1' }, 'the address is written in lower case');
  assert.notEqual(openA.conn, openB.conn);
  // The id in the announcement is the one the phone's frames carry.
  a.send(Buffer.from('from-a'));
  const frame = await host.next();
  assert.equal(connIdOf(frame), openA.conn);
  assert.equal(Buffer.from(frame).subarray(4).toString(), 'from-a');
  b.send(Buffer.from('from-b'));
  assert.equal(connIdOf(await host.next()), openB.conn);
  host.close();
  a.close();
  b.close();
});

test('fake: with no cf-connecting-ip, or one that is not an address, nothing extra goes to the host; a phone closing is still reported', async () => {
  const d = driver;
  const room = hexRoom();
  const host = await d.connect(room, hostHeaders(newSecret()));
  const none = await d.connectRoom(room, phoneHeaders());
  assert.equal(await host.quiet(200), true, 'no address, no announcement');
  for (const bad of ['', 'not an address', '203.0.113.7; drop', '1'.repeat(46), '<script>']) {
    const phone = await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': bad }));
    assert.equal(await host.quiet(100), true, `${JSON.stringify(bad)} is not passed on`);
    phone.close();
    controlOf(await host.next()); // each phone that hangs up is reported as closed
  }
  none.send(Buffer.from('hi'));
  const frame = await host.next();
  assert.equal(Buffer.from(frame).subarray(4).toString(), 'hi');
  none.close();
  assert.equal(controlOf(await host.next()).op, 'closed');
  host.close();
});

test('fake: a phone refused for a full room or a missing host is not announced', async () => {
  const d = driver;
  const room = hexRoom();
  const nobody = await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': '203.0.113.7' }));
  assert.deepEqual(await nobody.closed(), { code: 4001, reason: 'host-offline' });
  const host = await d.connect(room, hostHeaders(newSecret()));
  const phones = [];
  for (let i = 0; i < 8; i += 1) phones.push(await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': `203.0.113.${i + 1}` })));
  for (let i = 0; i < 8; i += 1) assert.equal(controlOf(await host.next()).op, 'open');
  const ninth = await d.connectRoom(room, phoneHeaders({ 'cf-connecting-ip': '203.0.113.99' }));
  assert.deepEqual(await ninth.closed(), { code: 1008, reason: 'room-full' });
  assert.equal(await host.quiet(200), true, 'the refused ninth phone was not announced');
  host.close();
  for (const phone of phones) phone.close();
});
