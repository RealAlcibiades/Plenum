// Miniflare entry for the suites. It re-exports the production Worker and a
// Room subclass that adds /__test/ hooks: a movable clock, a forced alarm, a
// storage dump and a simulated eviction. The hooks are reached only through a
// Durable Object stub from the suite, because the Worker forwards nothing else
// to the room, so production code carries no test paths.
import worker from '../../src/index.mjs';
import { Room as BaseRoom } from '../../src/room.mjs';

export default worker;

function json(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

export class Room extends BaseRoom {
  testOffset = 0;
  frozenAt = null;

  now() {
    return this.frozenAt ?? Date.now() + this.testOffset;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/__test/')) return super.fetch(request);
    switch (url.pathname) {
      case '/__test/offset':
        this.testOffset = Number(url.searchParams.get('ms'));
        return json({ ok: true });
      case '/__test/freeze':
        this.frozenAt = Date.now() + this.testOffset;
        return json({ ok: true });
      case '/__test/unfreeze':
        this.frozenAt = null;
        return json({ ok: true });
      case '/__test/alarm':
        await this.alarm();
        return json({ ok: true });
      case '/__test/alarm-time':
        return json({ alarm: await this.ctx.storage.getAlarm() });
      case '/__test/storage':
        return json(Object.fromEntries(await this.ctx.storage.list()));
      case '/__test/abort':
        // Resets the object like an eviction. Sockets accepted with the
        // Hibernation API survive it and their attachments are read back.
        this.ctx.abort('test: simulated eviction');
        return json({ ok: true });
      default:
        return new Response('no such test hook', { status: 404 });
    }
  }
}
