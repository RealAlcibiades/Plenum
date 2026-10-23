// The tool test for API models (pro-08, wave 9). The page's Settings › Accounts section "Tools for API models" uses these routes.
// GET /api/tool-test?ref=<ref>  one model: { ref, label, providerLabel, providerVerified, keySaved, record, allowed, toolsAllowed, grantFrom, estimate }
//                               allowed and toolsAllowed are the grant the model really gets (the gates' reading: toolsAllowed or toolsOnFor),
//                               so a model with no record shows On when the provider-wide check passed; grantFrom is 'record' or 'provider' for an On, else null
// GET /api/tool-test            every model the section lists (xAI's catalog, the main model when it is an OpenRouter id, and any model
//                               with a record): { rows: [ the same shape ], testing }
// POST /api/tool-test { ref }   runs the test; the answer is a server-sent stream of { type: 'call', name } while it runs,
//                               { type: 'step', n, name, ok, note } for each judged step, then { type: 'result', record } or
//                               { type: 'error', message }. One test at a time (409). Closing the request stops the test.
// POST /api/tool-test/allow { ref, allowed }   the switch: on needs no test (the page shows Unverified), off keeps the record (an Off with
//                                              no record is saved too). The answer's allowed is the grant the model gets now.
// POST /api/tool-test/forget { ref }           removes the record for a model. Its tools are then what the provider-wide check gives
//                                              (off for an OpenRouter model, or for a provider whose check has not passed).
// No project is read or written. A key is read only to check that one is saved; it is never returned, stored or logged.
import { apiProvider } from '../api-providers.mjs';
import { CATALOG, labelFor, parseRef } from '../providers.mjs';
import { keyStatus } from '../keys.mjs';
import { infoFor } from '../model-info.mjs';
import { anyRecord, forget, saveRecord, setAllowed, toolsAllowed } from '../tool-trust.mjs';
import { toolsOnFor } from '../tool-verify.mjs';
import { estimateFor, runToolTest, toolTestRunning } from '../tool-test.mjs';

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' };
const NOT_API = 'Only API models take the tool test. Claude and the CLIs bring their own tools.';

export const routes = [
  { method: 'GET', path: '/api/tool-test', handler: getRoute },
  { method: 'POST', path: '/api/tool-test', handler: testRoute },
  { method: 'POST', path: '/api/tool-test/allow', handler: allowRoute },
  { method: 'POST', path: '/api/tool-test/forget', handler: forgetRoute },
];

const providerOf = ref => String(ref).slice(0, String(ref).indexOf(':'));
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A ref as the server reads it (parseRef), which must be an API model. Anything else is a 400 the page shows.
function refOf(input, httpError) {
  let ref;
  try {
    ref = parseRef(input);
  } catch (err) {
    throw httpError(400, err.message);
  }
  if (!apiProvider(providerOf(ref))) throw httpError(400, NOT_API);
  return ref;
}

// The grant a model really has: the reading the gates use (reachesTools in lib/providers.mjs, the chat gate in server.mjs, the picker in
// lib/model-info.mjs): a verified provider, a record whose switch is on, or, for a model with no record of its own, the provider-wide
// check (toolsOnFor). An explicit Off on the model keeps it off. grantFrom says where an On comes from: 'record' or 'provider'.
function grantOf(ref) {
  const on = toolsAllowed(ref) || toolsOnFor(ref);
  if (!on) return { on, grantFrom: null };
  return { on, grantFrom: anyRecord(ref)?.allowed === true ? 'record' : 'provider' };
}

// What the section shows for one model. The record is the one kept in the state (no key, prompt or file content is in it).
async function statusOf(ref) {
  const api = apiProvider(providerOf(ref));
  const record = anyRecord(ref);
  const { configured } = await keyStatus(api.id);
  const grant = grantOf(ref);
  return {
    ref,
    label: labelFor(ref),
    providerLabel: api.label,
    providerVerified: api.toolsVerified === true,
    keySaved: configured,
    record,
    allowed: grant.on,
    toolsAllowed: grant.on,
    grantFrom: grant.grantFrom,
    estimate: estimateFor(infoFor(ref).price),
  };
}

// The models the section lists: every xAI catalog model, the main model when it is an OpenRouter id, and any model with a record.
// A verified provider is not listed, since its tools need no test.
function listedRefs(st) {
  const refs = new Set();
  for (const c of CATALOG) if (c.provider === 'xai') refs.add(`xai:${c.id}`);
  if (typeof st.model === 'string' && st.model.startsWith('openrouter:')) refs.add(st.model);
  for (const rec of Object.values(st.toolTrust && isObject(st.toolTrust) ? st.toolTrust : {})) {
    if (isObject(rec) && typeof rec.ref === 'string') refs.add(rec.ref);
  }
  return [...refs].filter(ref => {
    const api = apiProvider(providerOf(ref));
    return api && api.toolsVerified !== true;
  }).sort();
}

async function getRoute({ url, res, json, httpError, store }) {
  const raw = url.searchParams.get('ref');
  if (raw === null) {
    const rows = await Promise.all(listedRefs(store.get()).map(statusOf));
    return json(res, 200, { rows, testing: toolTestRunning() });
  }
  return json(res, 200, await statusOf(refOf(raw, httpError)));
}

// The test. Its checks come first, so a refused request is an ordinary JSON answer; the stream starts only once the test has begun.
async function testRoute({ req, res, readBody, httpError, store }) {
  const body = (await readBody(req)) ?? {};
  if (!isObject(body)) throw httpError(400, 'Send the model as { "ref": "provider:id" }.');
  const ref = refOf(body.ref, httpError);
  const api = apiProvider(providerOf(ref));
  if (!(await keyStatus(api.id)).configured) throw httpError(400, `Save a key for ${api.label} in Accounts first.`);
  if (toolTestRunning()) throw httpError(409, 'A tool test is already running.');
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  const send = obj => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  // runToolTest marks the test as running before its first await, so it is started here, with no other test able to start between.
  const run = runToolTest({
    ref,
    signal: ac.signal,
    onStep: s => send({ type: 'step', n: s.n, name: s.name, ok: s.ok, note: s.note }),
    onCall: c => send({ type: 'call', name: c.name }),
    baseUrlOverride: process.env.MUSE_CONSOLE_TEST === '1' ? process.env.MUSE_CONSOLE_TOOLTEST_BASE_URL : undefined,
  });
  res.writeHead(200, SSE_HEADERS);
  try {
    const record = await run;
    const saved = await saveRecord(record);
    send({ type: 'result', record: saved });
  } catch (err) {
    // A stop (the client closed the request) is not an error to show; nothing was saved.
    if (!ac.signal.aborted) send({ type: 'error', message: err.message || 'The tool test could not run.' });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// The switch. A value that is not true or false is refused before anything changes.
async function allowRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  if (!isObject(body)) throw httpError(400, 'Send the model as { "ref": "provider:id", "allowed": true or false }.');
  const ref = refOf(body.ref, httpError);
  if (typeof body.allowed !== 'boolean') throw httpError(400, 'Send allowed as true or false.');
  let record;
  try {
    record = await setAllowed(ref, body.allowed);
  } catch (err) {
    // A save that failed keeps its own status (500); any other refusal is a 400 with its message.
    if (err.status) throw err;
    throw httpError(400, err.message);
  }
  const grant = grantOf(ref);
  return json(res, 200, { record: record ?? null, allowed: grant.on, grantFrom: grant.grantFrom });
}

async function forgetRoute({ req, res, readBody, httpError, json }) {
  const body = (await readBody(req)) ?? {};
  if (!isObject(body)) throw httpError(400, 'Send the model as { "ref": "provider:id" }.');
  const ref = refOf(body.ref, httpError);
  await forget(ref);
  const grant = grantOf(ref);
  return json(res, 200, { record: null, allowed: grant.on, grantFrom: grant.grantFrom });
}
