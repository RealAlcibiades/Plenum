// Suite for the tier policy (mob-03): the rule-based classification of every request a phone can make, and a walk of the real route table
// and the server's own switch that fails when a route has no tier. No network and no server process; the route table is loaded in this
// process the way the server loads it. Run it through the sealed runner: node build/mobile/run.mjs --id mob-03 tiers.test.mjs
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  READ_POSTS, REFUSAL_TEXT, SELF_POSTS, TIERS, WATCH_POSTS, WATCH_PREFIXES, allows, capsForTier, classify, classifyDetailed, isTier, pathnameOf,
  phonesShape, tierRank,
} from '../../lib/remote/tiers.mjs';
import { GATED_GETS } from '../../lib/legal.mjs';

const { allRoutes } = await import('../../lib/routes/index.mjs');
const SERVER = readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');

describe('classify', () => {
  test('reads that reach no provider need read; the answers and stops need approve; Stop all needs read; everything else needs full', () => {
    const cases = [
      ['GET', '/api/state', 'read'], ['GET', '/api/events', 'read'], ['GET', '/api/phones', 'read'], ['GET', '/api/agents/live?project=p1', 'read'],
      ['GET', '/api/artifacts/view?id=1', 'read'], ['GET', '/', 'read'], ['GET', '/app.js', 'read'], ['GET', '/ext-remote.js', 'read'], ['GET', '/_bridge/ui-manifest', 'read'],
      ['HEAD', '/api/state', 'read'], ['get', '/api/state', 'read'],
      ['POST', '/api/stop-all', 'read'], ['POST', '/api/phones/push', 'read'], ['POST', '/_bridge/log', 'read'],
      ['POST', '/api/approve', 'approve'], ['POST', '/api/cancel', 'approve'], ['POST', '/api/drive/pause', 'approve'], ['POST', '/api/drive/resume', 'approve'],
      ['POST', '/api/drive/stop', 'approve'], ['POST', '/api/agents/stop', 'approve'], ['POST', '/api/phones/remove', 'approve'],
      ['POST', '/api/notices/hide', 'approve'], ['POST', '/api/notices/show-all', 'approve'], ['POST', '/api/cancel?project=p1', 'approve'],
      ['POST', '/api/chat', 'full'], ['POST', '/api/review', 'full'], ['POST', '/api/settings', 'full'], ['POST', '/api/keys', 'full'], ['POST', '/api/updates/apply', 'full'],
      ['POST', '/api/phones/settings', 'full'], ['POST', '/api/phones/pair/start', 'full'], ['POST', '/api/phones/tier', 'full'], ['POST', '/api/phones/remove-all', 'full'],
      ['POST', '/api/phones/lan', 'full'], ['POST', '/api/phones/tailscale', 'full'], ['POST', '/api/phones/relay', 'full'], ['POST', '/api/phones/relay/new-room', 'full'],
      ['POST', '/api/computer/type', 'full'], ['POST', '/api/browser/navigate', 'full'], ['POST', '/api/a-route-that-does-not-exist-yet', 'full'],
      ['POST', '/api/notices/', 'full'], ['POST', '/api/approve/', 'full'], ['POST', '/api/approve/detail', 'full'], ['POST', '/api/stop-all/now', 'full'],
      ['DELETE', '/api/state', 'full'], ['PUT', '/api/state', 'full'], ['PATCH', '/api/state', 'full'],
    ];
    for (const [method, target, tier] of cases) assert.equal(classify(method, target), tier, `${method} ${target}`);
  });

  test('a GET that reaches a provider needs full, whether the route table or the static list says so', () => {
    for (const p of GATED_GETS) assert.equal(classify('GET', p), 'full', p);
    assert.equal(classify('GET', '/api/a-new-provider-read', true), 'full');
    assert.equal(classify('GET', '/api/a-new-provider-read', false), 'read');
    assert.equal(classifyDetailed('GET', '/api/usage').rule, 'gated-get');
  });

  test('the path is judged the way the server will read it', () => {
    assert.equal(classify('POST', '/api/state/../chat'), 'full');
    assert.equal(classify('POST', '/api/state/%2e%2e/chat'), 'full');
    assert.equal(classify('POST', '/api/x/../cancel'), 'approve', 'a dot segment that lands on an approve route is that route');
    assert.equal(classify('POST', '/api/%63ancel'), 'full', 'a percent-encoded letter is a different path to the server, and to the policy');
    assert.equal(classify('GET', '/api/x/../usage'), 'full');
    assert.deepEqual(pathnameOf('/api/a/./b/../c?x=1#f'), { pathname: '/api/a/c', search: '?x=1' });
    for (const bad of ['', 'api/state', '//evil', 'http://evil/', '/a b', '/a\\b', '/a\nb', 5, null, undefined, `/${'a'.repeat(9000)}`]) {
      assert.equal(pathnameOf(bad), null, JSON.stringify(bad)?.slice(0, 40));
      assert.equal(classify('GET', bad), 'full', 'an unparseable target is never read-only');
    }
  });

  test('the tiers compare as read < approve < full, and an unknown tier allows nothing', () => {
    assert.deepEqual(TIERS, ['full', 'approve', 'read']);
    assert.ok(tierRank('read') < tierRank('approve') && tierRank('approve') < tierRank('full'));
    assert.equal(allows('full', 'full') && allows('full', 'approve') && allows('full', 'read'), true);
    assert.equal(allows('approve', 'read') && allows('approve', 'approve'), true);
    assert.equal(allows('approve', 'full'), false);
    assert.equal(allows('read', 'read'), true);
    assert.equal(allows('read', 'approve') || allows('read', 'full'), false);
    for (const odd of [null, undefined, '', 'admin', 'FULL', 3, {}]) {
      assert.equal(allows(odd, 'read'), false, String(odd));
      assert.equal(allows('full', odd), false, String(odd));
      assert.equal(isTier(odd), false);
    }
  });

  test('the capability names HELLO sends grow with the tier', () => {
    const read = capsForTier('read');
    const approve = capsForTier('approve');
    const full = capsForTier('full');
    for (const cap of read) assert.ok(approve.includes(cap), cap);
    for (const cap of approve) assert.ok(full.includes(cap), cap);
    assert.ok(read.includes('stop-all') && read.includes('events'));
    assert.equal(read.includes('chat') || read.includes('approvals'), false);
    assert.ok(approve.includes('approvals') && !approve.includes('chat'));
    assert.ok(full.includes('chat') && full.includes('computer'));
    assert.deepEqual(capsForTier('nonsense'), []);
  });

  test('the refusal sentence is the one the phone shows', () => {
    assert.match(REFUSAL_TEXT, /^This phone can.t do that\. Change what it can do at the computer under Settings . Phones\.$/);
  });

  test('state.phones is given its defaults in place and bad values are replaced', () => {
    const empty = phonesShape(undefined);
    assert.deepEqual(empty, {
      enabled: false, port: null, lan: { enabled: false, anyAddress: false }, tailscale: { enabled: false, name: '' }, relay: { enabled: false, url: '' },
      push: { approvals: true, finished: true, limits: true, onlyWhenAway: true, firstLine: false }, autoExpireDays: 0, activity: [],
    });
    const given = { enabled: true, port: 99, lan: { enabled: 1 }, push: { firstLine: true, approvals: false }, autoExpireDays: -5, activity: [1, { at: 1 }, null] };
    const shaped = phonesShape(given);
    assert.equal(shaped, given, 'filled in place');
    assert.equal(shaped.port, null, 'a port under 1024 is dropped');
    assert.equal(shaped.lan.enabled, false, 'only true counts');
    assert.equal(shaped.push.firstLine, true);
    assert.equal(shaped.push.approvals, false);
    assert.equal(shaped.autoExpireDays, 0);
    assert.deepEqual(shaped.activity, [{ at: 1 }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Every route

// The routes the server's own switch and its two direct branches name.
function serverRoutes() {
  const out = new Map();
  for (const m of SERVER.matchAll(/case '(GET|POST|PUT|DELETE|PATCH) (\/[^']*)'/g)) out.set(`${m[1]} ${m[2]}`, { method: m[1], path: m[2], gated: false, source: 'server.mjs switch' });
  for (const m of SERVER.matchAll(/req\.method === '(GET|POST)' && url\.pathname === '(\/[^']*)'/g)) out.set(`${m[1]} ${m[2]}`, { method: m[1], path: m[2], gated: false, source: 'server.mjs branch' });
  return [...out.values()];
}

describe('every route has a tier', () => {
  const modules = allRoutes();
  const server = serverRoutes();
  const gatedGets = new Set(GATED_GETS);
  const all = [
    ...modules.map(r => ({ ...r, source: 'route module' })),
    ...server.map(r => ({ ...r, gated: r.method === 'GET' && gatedGets.has(r.path) })),
  ];

  test('the walk sees the routes of the modules and of the server\'s switch', () => {
    assert.ok(modules.length > 60, `${modules.length} module routes`);
    assert.ok(server.length > 30, `${server.length} switch routes`);
    for (const key of ['GET /api/events', 'GET /api/state', 'POST /api/cancel', 'POST /api/approve', 'POST /api/chat', 'POST /api/review']) {
      assert.ok(server.some(r => `${r.method} ${r.path}` === key), `the server switch has ${key}`);
    }
  });

  test('every route classifies to a tier by a named rule, and the rules hold', () => {
    const unclassified = [];
    const byRule = new Map();
    for (const r of all) {
      if (typeof r.method !== 'string' || typeof r.path !== 'string' || !r.path.startsWith('/')) {
        unclassified.push(`${r.source}: ${r.method} ${r.path}`);
        continue;
      }
      const { tier, rule } = classifyDetailed(r.method, r.path, r.gated);
      if (!TIERS.includes(tier) || typeof rule !== 'string' || rule === 'bad-path') {
        unclassified.push(`${r.method} ${r.path}`);
        continue;
      }
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      if (r.method === 'GET') {
        assert.equal(tier, r.gated || gatedGets.has(r.path) ? 'full' : 'read', `GET ${r.path} (${r.source})`);
      } else {
        assert.equal(r.method, 'POST', `${r.path}: only GET and POST exist`);
        const listed = WATCH_POSTS.includes(r.path) || READ_POSTS.includes(r.path) || SELF_POSTS.includes(r.path) || WATCH_PREFIXES.some(p => r.path.startsWith(p));
        if (!listed) assert.equal(tier, 'full', `POST ${r.path} has no rule of its own, so it needs full`);
      }
    }
    assert.deepEqual(unclassified, [], 'routes with no tier');
    for (const rule of ['get', 'default', 'watch', 'stop', 'self']) assert.ok(byRule.get(rule) > 0, `the ${rule} rule decides at least one real route`);
  });

  test('no route below full can start work, change settings or reach a key, a file or the shell', () => {
    assert.deepEqual([...WATCH_POSTS].sort(), ['/api/agents/stop', '/api/approve', '/api/cancel', '/api/drive/pause', '/api/drive/resume', '/api/drive/stop', '/api/phones/remove', '/api/stop-all'].sort());
    assert.deepEqual([...READ_POSTS], ['/api/stop-all']);
    assert.deepEqual([...SELF_POSTS], ['/api/phones/push']);
    assert.deepEqual([...WATCH_PREFIXES], ['/api/notices/']);
    const allowed = new Set([...WATCH_POSTS, ...READ_POSTS, ...SELF_POSTS]);
    const below = all.filter(r => r.method === 'POST' && classify(r.method, r.path, r.gated) !== 'full').map(r => r.path);
    for (const p of below) assert.ok(allowed.has(p) || WATCH_PREFIXES.some(prefix => p.startsWith(prefix)), `POST ${p} is below full without being on the decided list`);
    for (const p of ['/api/chat', '/api/keys', '/api/settings', '/api/updates/apply', '/api/phones/pair/start', '/api/phones/tier', '/api/phones/relay/new-room', '/api/browser/navigate']) {
      if (all.some(r => r.method === 'POST' && r.path === p)) assert.equal(classify('POST', p), 'full', p);
    }
  });

  test('the listed routes exist (a renamed route would otherwise drop out of its tier unseen)', () => {
    const posts = new Set(all.filter(r => r.method === 'POST').map(r => r.path));
    for (const p of [...WATCH_POSTS, ...READ_POSTS, ...SELF_POSTS]) assert.ok(posts.has(p), `POST ${p} exists`);
    for (const prefix of WATCH_PREFIXES) assert.ok([...posts].some(p => p.startsWith(prefix)), `a route under ${prefix} exists`);
    for (const p of GATED_GETS) assert.ok(all.some(r => r.method === 'GET' && r.path === p), `GET ${p} (a gated read) exists`);
  });

  test('the phone routes of mob-05 are in the table', () => {
    const have = new Set(modules.map(r => `${r.method} ${r.path}`));
    for (const key of [
      'GET /api/phones', 'POST /api/phones/settings', 'POST /api/phones/lan', 'POST /api/phones/tailscale', 'POST /api/phones/relay', 'POST /api/phones/relay/new-room',
      'POST /api/phones/pair/start', 'POST /api/phones/pair/cancel', 'POST /api/phones/pair/confirm', 'POST /api/phones/remove', 'POST /api/phones/remove-all',
      'POST /api/phones/tier', 'POST /api/phones/push', 'POST /api/phones/test-push', 'GET /api/phones/activity', 'POST /api/artifacts/picture', 'POST /api/stop-all',
    ]) assert.ok(have.has(key), key);
    for (const r of modules.filter(x => x.path.startsWith('/api/phones') && x.method === 'GET')) assert.equal(r.gated, false, `${r.path} reaches no provider`);
  });
});
