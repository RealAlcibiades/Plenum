// The live check that an API provider really completes a tool call (grok-05), for the providers whose tools are not verified in
// lib/api-providers.mjs (xAI). It sends one tiny request with the saved key: a ping function offered, which the reply must call with
// value 7; then the tool result "pong" goes back, and a text reply must come. Only the result is stored, in state.json under
// toolsVerified[providerId] = { ok, model, at, reason }. The key is never stored, logged or returned, and the reason is the provider's own
// error text with the key taken out, at most 300 characters.
// toolsOn(providerId) is what the gates read: true for a provider whose flag is set (OpenAI, DeepSeek, Mistral, Google AI), or whose
// stored check passed. The check costs one small paid request, and the page says so. A redirect is refused (the key is never sent on).
// The check is provider-wide: it runs against the model Plenum lists first for the provider (lib/providers.mjs CATALOG), and the chat
// gate in lib/tool-trust.mjs (the per-model Allow tools switch) still works alongside it.
// toolsOnFor(ref) is the per-model reading of the same check: toolsOn for the model's provider, unless that model's own switch is Off
// (an explicit Off wins). forgetTools removes the stored check (the route POST /api/keys/verify-tools with forget: true).
import { apiProvider } from './api-providers.mjs';
import { keyFor } from './keys.mjs';
import { anyRecord } from './tool-trust.mjs';
import * as store from './store.mjs';

export const PING_TIMEOUT_MS = 20_000;
export const PING_NAME = 'ping';
export const PING_VALUE = 7;
const PING_TOOL = {
  type: 'function',
  function: {
    name: PING_NAME,
    description: 'Test function.',
    parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false },
  },
};
const FIRST_PROMPT = `Call the ${PING_NAME} function with value ${PING_VALUE} and nothing else.`;
const REASON_MAX = 300;
const REFUSED_REDIRECT = 'The provider tried to redirect the check, so it was stopped. The key was not sent on.';
const NO_CALL = 'The reply carried no tool call.';
const WRONG_CALL = `The reply did not call ${PING_NAME} with value ${PING_VALUE}.`;
const ROUND_REFUSED = 'The tool result round was refused.';
const TIMED_OUT = `The check did not answer within ${PING_TIMEOUT_MS / 1000} seconds.`;

// Providers whose check is running now. A second check for the same provider is refused while one is in flight.
const running = new Set();
export const toolCheckRunning = providerId => running.has(String(providerId));

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The stored record for a provider, or null. Only the four fields are kept; nothing else is ever written here.
function recordOf(providerId) {
  const map = store.get().toolsVerified;
  if (!isObject(map) || !Object.hasOwn(map, providerId)) return null;
  const rec = map[providerId];
  return isObject(rec) ? { ok: rec.ok === true, model: typeof rec.model === 'string' ? rec.model : null, at: typeof rec.at === 'string' ? rec.at : null, reason: typeof rec.reason === 'string' ? rec.reason : null } : null;
}

// Whether the project tools reach this provider's models: its flag is set, or its stored check passed. Makes no request.
export function toolsOn(providerId) {
  const id = String(providerId ?? '');
  if (apiProvider(id)?.toolsVerified === true) return true;
  return recordOf(id)?.ok === true;
}

// The same reading for one model ref ("provider:id"): toolsOn for its provider, unless the model's own Allow tools switch is Off. A record
// with allowed false is an explicit Off (or a failed or stale test, which turns the switch off), and it wins over the provider's check.
// A model with no record, or a record with the switch on, gets what toolsOn says. Makes no request.
export function toolsOnFor(ref) {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  const provider = i < 0 ? text : text.slice(0, i);
  return toolsOn(provider) && anyRecord(text)?.allowed !== false;
}

// Every stored check, keyed by provider id. No key is in it. Read-only.
export function toolChecks() {
  const out = {};
  const map = store.get().toolsVerified;
  if (!isObject(map)) return out;
  for (const id of Object.keys(map)) {
    if (apiProvider(id)) out[id] = recordOf(id);
  }
  return out;
}

// Takes the saved key out of a text, so no error or reason carries it.
const redact = (text, key) => (key ? String(text ?? '').split(key).join('[key]') : String(text ?? ''));
const clipReason = text => (text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text);

// The provider's error text from a failed reply: its error.message, or its error string, or the start of its body. Redacted.
async function providerReason(res, key) {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  let message = '';
  try {
    const body = JSON.parse(raw);
    message = typeof body?.error?.message === 'string' ? body.error.message : typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  } catch {
    message = '';
  }
  const text = (message || raw || `The provider answered ${res.status}.`).replace(/\s+/g, ' ').trim();
  return clipReason(redact(text, key));
}

// One POST to the provider's chat-completions route. Returns { res, body } where body is the parsed JSON (or null).
async function post(api, key, body, signal) {
  const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    // A redirect is refused rather than followed, so the key and the request are never sent on to another host.
    redirect: 'error',
    signal,
  });
  return res;
}

// Runs the check for one provider with the model it names, stores the result and returns the record { ok, model, at, reason }.
// Throws only when the provider is not an API provider or has no saved key (the route checks both first).
export async function verifyTools(providerId, { model } = {}) {
  const id = String(providerId ?? '');
  const api = apiProvider(id);
  if (!api) throw new Error('Only API providers take the tool check.');
  const key = await keyFor(id);
  if (!key) throw new Error(`Save a key for ${api.label} in Accounts first.`);
  if (typeof model !== 'string' || !model) throw new Error(`Plenum has no model to check for ${api.label}.`);
  running.add(id);
  let rec;
  try {
    rec = await runCheck(api, key, model);
  } finally {
    running.delete(id);
  }
  await save(id, rec);
  return rec;
}

// The two rounds. Round one offers the ping function and must get the call back; round two sends the result and must get text.
async function runCheck(api, key, model) {
  const at = new Date().toISOString();
  const fail = reason => ({ ok: false, model, at, reason: clipReason(redact(reason, key)) });
  const signal = AbortSignal.timeout(PING_TIMEOUT_MS);
  let res;
  let body;
  try {
    res = await post(api, key, { model, messages: [{ role: 'user', content: FIRST_PROMPT }], tools: [PING_TOOL], tool_choice: 'required', stream: false }, signal);
    if (!res.ok) return fail(await providerReason(res, key));
    body = await res.json().catch(() => null);
  } catch (err) {
    return fail(transportReason(err, key));
  }
  const message = body?.choices?.[0]?.message;
  const call = Array.isArray(message?.tool_calls) ? message.tool_calls[0] : null;
  if (!call) return fail(NO_CALL);
  if (call?.function?.name !== PING_NAME || !pingValueOk(call.function.arguments)) return fail(WRONG_CALL);
  const callId = typeof call.id === 'string' && call.id ? call.id : 'call_ping_1';
  try {
    res = await post(api, key, {
      model,
      messages: [
        { role: 'user', content: FIRST_PROMPT },
        { role: 'assistant', content: message.content ?? null, tool_calls: [{ id: callId, type: 'function', function: { name: PING_NAME, arguments: call.function.arguments } }] },
        { role: 'tool', tool_call_id: callId, content: 'pong' },
      ],
      tools: [PING_TOOL],
      stream: false,
    }, signal);
    if (!res.ok) return fail(await providerReason(res, key));
    body = await res.json().catch(() => null);
  } catch (err) {
    return fail(transportReason(err, key));
  }
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return fail(ROUND_REFUSED);
  return { ok: true, model, at, reason: null };
}

// True when the arguments text is {"value":7} (the arguments of a tool call are a JSON text).
function pingValueOk(text) {
  try {
    const args = typeof text === 'string' ? JSON.parse(text) : text;
    return isObject(args) && args.value === PING_VALUE;
  } catch {
    return false;
  }
}

// The reason for a request that did not reach an answer: a redirect, a time limit, or the network's own message (redacted).
function transportReason(err, key) {
  if (/redirect/i.test(String(err?.cause?.message ?? '')) || /redirect/i.test(String(err?.message ?? ''))) return REFUSED_REDIRECT;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return TIMED_OUT;
  return `The check could not reach the provider: ${redact(String(err?.message ?? 'unknown error'), key)}`;
}

// Writes the record through the store, so it reaches state.json. The key is not part of it.
async function save(providerId, rec) {
  const st = store.get();
  if (!isObject(st.toolsVerified)) st.toolsVerified = {};
  st.toolsVerified[providerId] = { ok: rec.ok === true, model: rec.model, at: rec.at, reason: rec.reason };
  await store.saveOrFail();
}

// Removes the stored check for a provider, so its tools go back off (a provider whose flag is set keeps them on). The per-model switches
// and records are not touched. Returns true when a check was removed; the write goes through the store, as save does.
export async function forgetTools(providerId) {
  const id = String(providerId ?? '');
  const st = store.get();
  if (!isObject(st.toolsVerified) || !Object.hasOwn(st.toolsVerified, id)) return false;
  delete st.toolsVerified[id];
  await store.saveOrFail();
  return true;
}
