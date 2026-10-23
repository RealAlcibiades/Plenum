// The records and the gate for the project tools of API models (pro-08, wave 9).
// A model whose provider is marked verified in lib/api-providers.mjs (toolsVerified: true) has the tools. Any other API model
// (Grok, every OpenRouter model, and a future provider) gets them only when the switch "Allow tools" in Settings › Accounts is
// on for that exact model id. The switch is backed by a record in state.json (key toolTrust, one record per ref, written by
// the tool test in lib/tool-test.mjs):
//   { ref, result: 'pass'|'fail'|'stale'|'untested', testVersion: 1, checkedOn: 'YYYY-MM-DD' (UTC) or null, at, servedModel,
//     staleModel?, failedStep, steps: [{ n, name, ok, note }], tokens: { input, output } or null, costUsd, allowed }
// A record holds no key, no prompt and no file content. The notes are fixed sentences written by the test.
// Amendment 28: a pass turns allowed on at once; allowed can be turned on without a test (result 'untested') and then the page
// shows an Unverified notice; a fail or a stale record turns allowed off. The gate reads allowed, so the switch is the grant.
// Writes go through the store: saveRecord (awaited, and the failure is thrown) and markStale and forget (persist, not awaited).
import { apiProvider } from './api-providers.mjs';
import * as store from './store.mjs';

export const TEST_VERSION = 1;
const MAX_NOTE = 200;
const MAX_MODEL = 120;

// A model name as a provider sent it, kept to a fixed length: it is provider-controlled text that is written to state.json and shown on
// the page. The record and the comparison in openai-compat.mjs both use this, so a long name still matches itself.
export const clipModel = name => String(name ?? '').slice(0, MAX_MODEL);

// The provider part of a ref ("xai:grok-4.7" gives "xai"). Written here so this module does not import providers.mjs, which imports it.
const providerOf = ref => {
  const s = String(ref ?? '');
  const i = s.indexOf(':');
  return i < 0 ? s : s.slice(0, i);
};

// The map of records in the state, read without changing the state.
function recordsMap() {
  const m = store.get().toolTrust;
  return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
}

// The record kept for a ref, whatever its result, or null. A record is kept only under the ref it names.
export function anyRecord(ref) {
  const key = String(ref ?? '');
  const map = recordsMap();
  if (!Object.hasOwn(map, key)) return null;
  const rec = map[key];
  return rec && typeof rec === 'object' && rec.ref === key ? rec : null;
}

// The record only when it is a pass of the current test version, else null.
export function recordFor(ref) {
  const rec = anyRecord(ref);
  return rec && rec.testVersion === TEST_VERSION && rec.result === 'pass' ? rec : null;
}

// True when the record for this ref has the switch on, for the current test version.
export function recordAllows(ref) {
  const rec = anyRecord(ref);
  return rec?.allowed === true && rec.testVersion === TEST_VERSION;
}

// Whether a model gets the project tools. Claude always does. A provider that is not an API provider (the CLIs and the echo
// model) is false here, since the CLIs bring their own tools. Otherwise a verified provider has them, and any other model has them
// when its record allows them. A failed record never takes tools away from a verified provider.
export function toolsAllowed(ref) {
  const provider = providerOf(ref);
  if (provider === 'anthropic') return true;
  const api = apiProvider(provider);
  if (!api) return false;
  if (api.toolsVerified === true) return true;
  return recordAllows(ref);
}

// The trust a record gives a request: { ref, servedModel } when the record (not the provider's flag) is what allows the tools,
// else null. openai-compat.mjs compares servedModel with the model a reply names, and turns the tools off on a change.
// servedModel is the model that passed the test, so only a pass has one: a switch that was turned on without a test (or after a
// fail or a stale mark) has nothing to compare with and is not turned off again in the middle of a reply.
export function trustFor(ref) {
  const api = apiProvider(providerOf(ref));
  if (!api || api.toolsVerified === true || !recordAllows(ref)) return null;
  const rec = anyRecord(ref);
  const served = rec.result === 'pass' && typeof rec.servedModel === 'string' && rec.servedModel ? rec.servedModel : null;
  return { ref: String(ref), servedModel: served };
}

// Every ref whose record allows tools and that is an API model. delegate.mjs adds these to the coders.
export function allowedRefs() {
  return Object.values(recordsMap())
    .filter(r => r && typeof r === 'object' && typeof r.ref === 'string' && apiProvider(providerOf(r.ref)) && recordAllows(r.ref))
    .map(r => r.ref);
}

// A record with no test behind it: the switch was turned on or off before any test ran.
function blankRecord(ref, result) {
  return {
    ref: String(ref),
    result,
    testVersion: TEST_VERSION,
    checkedOn: null,
    at: null,
    servedModel: null,
    failedStep: null,
    steps: [],
    tokens: null,
    costUsd: null,
    allowed: false,
  };
}

// The state's map, created when it is missing, with the record set under its ref. Writes go through persist (store.mjs).
function putRecord(rec) {
  const st = store.get();
  if (!st.toolTrust || typeof st.toolTrust !== 'object' || Array.isArray(st.toolTrust)) st.toolTrust = {};
  st.toolTrust[rec.ref] = rec;
  return rec;
}

// Saves a record from the tool test. It resolves when the state file holds it, and throws (status 500) when the save failed.
export async function saveRecord(rec) {
  if (!rec || typeof rec.ref !== 'string' || !apiProvider(providerOf(rec.ref))) throw new Error('A tool test result needs an API model.');
  const clean = {
    ...rec,
    ...(typeof rec.servedModel === 'string' ? { servedModel: clipModel(rec.servedModel) } : {}),
    ...(typeof rec.staleModel === 'string' ? { staleModel: clipModel(rec.staleModel) } : {}),
    steps: (Array.isArray(rec.steps) ? rec.steps : []).map(s => ({
      n: Number(s.n),
      name: String(s.name ?? '').slice(0, MAX_NOTE),
      ok: s.ok === true,
      note: String(s.note ?? '').slice(0, MAX_NOTE),
    })),
  };
  putRecord(clean);
  await store.saveOrFail();
  return clean;
}

// Turns the switch on or off for a model. On needs no test: a pass turns it on by itself (saveRecord), and a model that was never
// tested gets an 'untested' record that is allowed. Turning it on over a record that is not a pass (a fail, or one marked stale
// because the model behind the name changed) starts a new 'untested' record: the old test says nothing about the model that answers
// now, and its servedModel would turn the tools off again on the next reply. Off keeps the record and its result.
// Throws for a ref that is not an API model.
export async function setAllowed(ref, on) {
  const key = String(ref ?? '');
  if (!apiProvider(providerOf(key))) throw new Error('Only API models take tool settings. Claude and the CLIs bring their own tools.');
  let rec = anyRecord(key);
  if (!rec) {
    if (!on) return null;
    rec = blankRecord(key, 'untested');
  } else if (on === true && !(rec.result === 'pass' && rec.testVersion === TEST_VERSION)) {
    rec = blankRecord(key, 'untested');
  }
  const next = { ...rec, allowed: on === true };
  return saveRecord(next);
}

// A stale record: the model that answered under this name changed since its test. Tools are off until a new test or a switch.
// Called from openai-compat.mjs in the middle of a reply, so it does not wait for the save.
export function markStale(ref, servedNow) {
  const key = String(ref ?? '');
  const rec = anyRecord(key) ?? blankRecord(key, 'stale');
  putRecord({
    ...rec,
    result: 'stale',
    allowed: false,
    staleModel: clipModel(servedNow),
    at: new Date().toISOString(),
  });
  store.persist();
}

// Removes the record for a ref. The tools are then off for it, unless its provider is verified.
export async function forget(ref) {
  const key = String(ref ?? '');
  const st = store.get();
  if (st.toolTrust && typeof st.toolTrust === 'object' && Object.hasOwn(st.toolTrust, key)) delete st.toolTrust[key];
  await store.saveOrFail();
  return null;
}
