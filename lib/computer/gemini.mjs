// The Google AI (Gemini API) adapter for computer use: the driver lib/computer/drivers.mjs registers as `googleai`. Plenum's Google AI
// provider speaks the OpenAI-compatible endpoint, which has no computer_use tool, so this driver calls the native Gemini API's
// Interactions endpoint with the computer_use tool in the desktop environment, through the saved Google AI key.
//
// It only translates and sequences. Every action goes through lib/computer/run.mjs (the checks, the cards, the limits, the log and the
// step rows), so a run behaves the same whichever model drives it. The provider's own safety decisions become cards marked as Google's,
// and the switches of "Limits and checks" (lib/computer/policy.mjs CONFIRM_CATEGORIES) decide which ones are acknowledged without a card.
//
//   streamComputer(args)            the driver contract (providers.mjs passes { id, system, messages, signal, ctx, effort, onUsage, ... })
//   runGeminiLoop(args, deps)       the loop itself; deps { fetch, keyFor } are injected by the tests
//   resolveGeminiComputerModel(id, deps?)  the first model of GEMINI_COMPUTER_MODELS that answers GET /models/<id> with 200, or null
//   canonicalsFor(name, args, size)        the canonical actions of one predefined function (throws for a bad or unknown call)
//   toolsFor(disabledPolicies)             the tools array sent with each request
//
// Wire format (the page https://ai.google.dev/gemini-api/docs/computer-use, read at build time): POST {base}/interactions with the
// body { model, input, tools, system_instruction, previous_interaction_id }; the reply has `id` and a `steps` array whose
// function_call items are { type, id, name, arguments }; a result is { type: 'function_result', name, call_id, result: [parts] } with
// text and image parts; a safety decision sits in arguments.safety_decision { explanation, decision }; the acknowledgement is
// safety_acknowledgement on the function_result. The model ids are the ones the page names, plus the 2025 preview id.
//
// The key goes in the x-goog-api-key header, read from the key store for each request. It is never in a URL, a log, an event or an
// error, and only generativelanguage.googleapis.com is called: a redirect is refused (fetch redirect: 'error'), not followed.
import { NOT_EXECUTED, toCanonical } from './claude.mjs';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// The computer-use model ids tried in order at run start. The page's examples use gemini-3.8-flash; the last one is the preview id that
// the 2025 announcement named. A model id the chat asks for is tried first when it is in this list.
export const GEMINI_COMPUTER_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-4-argon',
  'gemini-2.5-computer-use-preview-10-2025',
]);

export const NO_MODEL = 'No Gemini computer-use model answered for this key.';
const NO_KEY = 'No Google AI key is saved. Open Accounts, paste the key and save it.';
const REQUEST_MS = 180_000;
const PROBE_MS = 15_000;
const SCREEN_FRAME = 1000; // the model's coordinates are whole numbers from 0 to 999 on this scale
// The result for a flagged step the person approved on a card: it is not run on the frame they approved (the screen may have changed
// while the card waited), so the model takes a screenshot and does it once.
const REFRAME = 'You confirmed this step, but it was not run: the screen may have changed while the card waited. Take a screenshot, then do exactly this step once.';

// Google's documented policy names (the tool's disabled_safety_policies) for each switchable category. The page lists the names as
// FINANCIAL_TRANSACTIONS, COMMUNICATION_TOOL, DATA_MODIFICATION and LEGAL_TERMS_AND_AGREEMENTS. Sign-in has no name the page documents,
// so a Google block on it cannot be overridden and it stops the run.
export const GOOGLE_POLICIES = Object.freeze({
  send: Object.freeze(['COMMUNICATION_TOOL']),
  buy: Object.freeze(['FINANCIAL_TRANSACTIONS']),
  delete: Object.freeze(['DATA_MODIFICATION']), // shared with submit: sent only when both switches are off
  submit: Object.freeze(['DATA_MODIFICATION']),
  terms: Object.freeze(['LEGAL_TERMS_AND_AGREEMENTS']),
  signin: Object.freeze([]),
});

// The predefined functions the desktop environment has, that have a canonical action here. key_down and key_up are excluded from the
// tool: a canonical action cannot hold a key down without a set length, so the model is not offered them.
const EXCLUDED = Object.freeze(['key_down', 'key_up']);

// The two functions Plenum adds, with the schemas of lib/tools.mjs (confirm_with_user, hand_over).
const CONFIRM_DECL = Object.freeze({
  type: 'function',
  name: 'confirm_with_user',
  description: 'Ask the user to confirm one consequential action before you do it on the computer: sending a message or email, buying or paying, deleting or discarding, submitting a form, agreeing to terms, signing in. Say exactly what will happen. Do not use it for ordinary steps.',
  parameters: { type: 'object', properties: { action: { type: 'string' }, why: { type: 'string' } }, required: ['action'] },
});
const HAND_OVER_DECL = Object.freeze({
  type: 'function',
  name: 'hand_over',
  description: 'Hand the mouse and keyboard to the user for a step you must not do: entering a password, a code, card or bank details, or anything they must do themselves. Say in one short sentence what they should do. Returns when they press Resume.',
  parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
});

const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clip = (text, n) => {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const redact = (text, key) => (key ? String(text).split(key).join('[key]') : String(text));
const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);

// The tools sent with each request: the computer tool in the desktop environment (prompt-injection detection on, as the page
// recommends), the two Plenum functions, and disabled_safety_policies when the person has switched a kind off.
export function toolsFor(disabledPolicies = []) {
  const computer = {
    type: 'computer_use',
    environment: 'desktop',
    enable_prompt_injection_detection: true,
    excluded_predefined_functions: [...EXCLUDED],
  };
  const policies = [...new Set(disabledPolicies)];
  if (policies.length) computer.disabled_safety_policies = policies;
  return [computer, CONFIRM_DECL, HAND_OVER_DECL];
}

// The policy names for a list of switched-off category ids, without repeats. A policy name can cover more than one switch (Google's
// DATA_MODIFICATION covers both Deleting and Submitting), and it goes in the request only when every switch it covers is off:
// sending it for one of them would also silence Google's own checks on the other, which the person left on (amend-04).
export function policiesFor(categories = []) {
  const off = new Set(categories);
  const names = new Set();
  for (const category of off) {
    for (const name of GOOGLE_POLICIES[category] ?? []) {
      if (Object.entries(GOOGLE_POLICIES).every(([other, list]) => !list.includes(name) || off.has(other))) names.add(name);
    }
  }
  return [...names];
}

// Whether a Google block in this category can be lifted: the category has policy names and the request sends all of them (see
// policiesFor). Sign-in has no name, and Deleting or Submitting alone shares one with the other switch.
const liftable = (id, run) => {
  const names = GOOGLE_POLICIES[id] ?? [];
  const sent = policiesFor(run.switchedOff?.() ?? []);
  return names.length > 0 && names.every(name => sent.includes(name));
};

// One model coordinate (0 to 999, a whole number) on the sent frame: Math.floor(x / 1000 * size).
function scaled(value, name, span) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > SCREEN_FRAME - 1) {
    throw new Error(`The ${name} must be a whole number from 0 to ${SCREEN_FRAME - 1}.`);
  }
  return Math.floor((value / SCREEN_FRAME) * span);
}

// The point [x, y] in sent pixels for the pair named xKey and yKey. Absent when both are absent and it is optional.
function pointOf(args, xKey, yKey, size, required) {
  if (!required && args[xKey] === undefined && args[yKey] === undefined) return undefined;
  return [scaled(args[xKey], xKey, size.width), scaled(args[yKey], yKey, size.height)];
}

function textOf(value, what) {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`);
  return value;
}

// The canonical actions of one predefined function call, in sent coordinates. Throws an Error with the reason for a call it cannot
// translate, so the batch reports it instead of running anything.
export function canonicalsFor(name, args = {}, size = { width: SCREEN_FRAME, height: SCREEN_FRAME }) {
  const a = isObj(args) ? args : {};
  const at = (xKey = 'x', yKey = 'y', required = true) => pointOf(a, xKey, yKey, size, required);
  switch (name) {
    case 'click':
      return [toCanonical('left_click', { coordinate: at() })];
    case 'double_click':
      return [toCanonical('double_click', { coordinate: at() })];
    case 'triple_click':
      return [toCanonical('triple_click', { coordinate: at() })];
    case 'right_click':
      return [toCanonical('right_click', { coordinate: at() })];
    case 'middle_click':
      return [toCanonical('middle_click', { coordinate: at() })];
    case 'move':
      return [toCanonical('mouse_move', { coordinate: at() })];
    case 'mouse_down':
    case 'mouse_up': {
      const out = [];
      const point = at('x', 'y', false);
      if (point) out.push(toCanonical('mouse_move', { coordinate: point }));
      out.push(toCanonical(name === 'mouse_down' ? 'left_mouse_down' : 'left_mouse_up', {}));
      return out;
    }
    case 'type': {
      const out = [toCanonical('type', { text: textOf(a.text, 'The text to type') })];
      if (a.press_enter === true) out.push(toCanonical('key', { text: 'Return' }));
      return out;
    }
    case 'press_key':
      return [toCanonical('key', { text: textOf(a.key, 'The key'), repeat: 1 })];
    case 'hotkey': {
      const keys = Array.isArray(a.keys) ? a.keys.map(k => textOf(k, 'A key')).join('+') : textOf(a.keys, 'The keys');
      return [toCanonical('key', { text: keys, repeat: 1 })];
    }
    case 'wait': {
      const seconds = a.seconds === undefined ? 1 : a.seconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) throw new Error('A wait needs a number of seconds.');
      return [toCanonical('wait', { duration: seconds })];
    }
    case 'take_screenshot':
      return [{ kind: 'screenshot' }];
    case 'drag_and_drop':
      return [toCanonical('left_click_drag', { start_coordinate: at('start_x', 'start_y'), coordinate: at('end_x', 'end_y') })];
    case 'scroll': {
      const pixels = a.magnitude_in_pixels === undefined ? 300 : a.magnitude_in_pixels;
      if (typeof pixels !== 'number' || !Number.isFinite(pixels)) throw new Error('A scroll needs magnitude_in_pixels as a number.');
      return [toCanonical('scroll', { scroll_direction: a.direction, scroll_amount: Math.max(1, Math.round(pixels / 100)), coordinate: at('x', 'y', false) })];
    }
    default:
      throw new Error(`"${String(name).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 40)}" is not a computer action in this run.`);
  }
}

// The Google AI key, read for one request. Never logged; a missing key is the error.
async function readKey(d) {
  const key = await d.keyFor();
  if (!key) throw new Error(NO_KEY);
  return String(key);
}

// The request's abort signal: the turn's cancel and the time limit together. Runtimes older than AbortSignal.any (Node 20.0 to 20.2) keep
// the cancel only.
function signalFor(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

// A GET or POST to the Gemini API. The key is in the header only. A failed answer becomes an Error with the status and Google's message,
// with the key removed from it. A redirect is refused rather than followed, so the key and the screenshots never go to another host.
async function callGoogle(d, { method, path, body, key, signal, timeoutMs }) {
  let res;
  try {
    res = await d.fetch(`${GEMINI_BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signalFor(signal, timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    if (!signal?.aborted && /redirect/i.test(String(err?.cause?.message ?? ''))) {
      throw Object.assign(new Error('Google AI tried to redirect the request, so it was stopped. The key was not sent on.'), { redirected: true });
    }
    throw err;
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.parse(text)?.error?.message ?? '';
    } catch {
      detail = text;
    }
    const message = redact(clip(detail || `HTTP ${res.status}`, 400), key);
    throw Object.assign(new Error(`Google AI computer use: ${message}`), { status: res.status });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Google AI computer use: the reply was not JSON.');
  }
}

// The models that answered 200 in this server's life. A model is probed again only when it has not answered yet.
const answered = new Set();

// The first computer-use model that answers, probing in order. A model the chat named is tried first when it is in the list.
export async function resolveGeminiComputerModel(preferred, deps = {}) {
  const d = withDefaults(deps);
  const key = await readKey(d);
  const order = [...new Set([...(GEMINI_COMPUTER_MODELS.includes(preferred) ? [preferred] : []), ...GEMINI_COMPUTER_MODELS])];
  for (const model of order) {
    if (answered.has(model)) return model;
    try {
      await callGoogle(d, { method: 'GET', path: `/models/${encodeURIComponent(model)}`, key, timeoutMs: PROBE_MS });
      answered.add(model);
      return model;
    } catch (err) {
      // A refused redirect stops the probe (every id would meet the same answer); any other failure means not this one, and the next id is tried.
      if (err?.redirected) throw err;
    }
  }
  return null;
}

function withDefaults(deps = {}) {
  return {
    fetch: deps.fetch ?? ((...args) => globalThis.fetch(...args)),
    keyFor: deps.keyFor ?? (async () => (await import('../keys.mjs')).keyFor('googleai')),
  };
}

// The chat as the first turn's text: the newest user message is the task, the few before it are the context.
function plainText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  return '';
}
function taskText(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .map(m => ({ role: m?.role === 'assistant' ? 'Assistant' : 'User', text: plainText(m?.content).trim() }))
    .filter(t => t.text);
  if (!turns.length) return 'Do the computer task the user asked for.';
  const task = turns.at(-1);
  const earlier = turns.slice(0, -1).slice(-6).map(t => `${t.role}: ${clip(t.text, 600)}`).join('\n');
  return [earlier ? `Earlier in this chat:\n${earlier}` : '', `Task: ${clip(task.text, 4000)}`].filter(Boolean).join('\n\n');
}

// Token counts from the reply's usage block (field names as the page uses them; UNVERIFIED against a live reply).
function usageOf(usage, at) {
  if (!isObj(usage)) return null;
  const input = num(usage.total_input_tokens ?? usage.input_tokens ?? usage.promptTokenCount);
  const cached = num(usage.total_cached_tokens ?? usage.cached_tokens ?? usage.cachedContentTokenCount) ?? 0;
  const output = (num(usage.total_output_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount) ?? 0)
    + (num(usage.total_thought_tokens ?? usage.thoughtsTokenCount) ?? 0);
  if (input === null && output === 0) return null;
  return { at, input: input ?? 0, cached: Math.min(cached, input ?? 0), output };
}

// The text a model-output step carries (never a thought).
function replyText(item) {
  if (!isObj(item) || (item.type !== 'model_output' && item.type !== 'text')) return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) return item.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
  return '';
}

function emitNotice(ctx, text) {
  try {
    ctx?.emit?.({ type: 'notice', kind: 'computer', text });
  } catch {
    // A stream that is gone changes nothing for the run.
  }
}

// The function_result for one call: its text part is {"ok":true} or the failure, its image part (when there is one) is the fresh
// screenshot the batch ends with. safety_acknowledgement is set only when the person approved Google's flagged step.
function resultOf(call, res, png, ack) {
  const body = res.ok
    ? (res.output && res.output !== 'OK' ? { ok: true, note: clip(res.output, 2000) } : { ok: true })
    : { ok: false, error: clip(res.output ?? 'The step failed.', 2000) };
  const parts = [{ type: 'text', text: JSON.stringify(body) }];
  if (png) parts.push({ type: 'image', data: png, mime_type: 'image/png' });
  return {
    type: 'function_result',
    name: call.name,
    call_id: call.id,
    result: parts,
    ...(ack ? { safety_acknowledgement: true } : {}),
  };
}

// Google's own safety decision on one call. Returns { ack } (go on, acknowledged when ack), { skip, note } (this call is not run, the
// rest of the batch is not either, and the setting is sent with the next request), or { stop: { reason, notice } } (the run ends).
async function safetyGate(call, args, run, ctx) {
  const decision = isObj(args.safety_decision) ? args.safety_decision : isObj(call.safety_decision) ? call.safety_decision : null;
  const kind = String(decision?.decision ?? '');
  if (kind !== 'blocked' && kind !== 'require_confirmation') return { ack: false };
  const explanation = clip(decision.explanation ?? '', 600);
  const intent = clip(args.intent ?? '', 200);
  const action = `the step Google flagged (${String(call.name)}${intent ? ` ${intent}` : ''})`;
  const info = run.safety({ code: String(call.name), text: `${intent} ${explanation}` });
  if (kind === 'blocked') {
    if (info.id && info.off && liftable(info.id, run)) {
      // The person switched this kind off: it is logged as acknowledged, and sent as a disabled policy with the next request.
      await run.confirm({ action, why: explanation, from: 'google', code: String(call.name), text: `${intent} ${explanation}` });
      return { skip: true, note: 'Google blocked this step under a setting you turned off. That setting is sent with the next request. Take a screenshot, then try this step again.' };
    }
    // The category is switched off here but Google's policy for it is shared with a switch that is on, so it cannot be lifted alone.
    const shared = info.id && info.off && (GOOGLE_POLICIES[info.id] ?? []).length > 0
      ? ' Google counts Deleting and Submitting as one policy, so it is lifted only when both of those switches are off.'
      : '';
    return { stop: { reason: 'error', notice: `Google blocked this step: ${explanation.replace(/[.!?]+$/, '')}. Computer use stopped.${shared}` } };
  }
  // A card pauses and resumes the drive, which makes the last screenshot stale (run.mjs refuses an act after a resume until a new
  // screenshot is taken). The person approved the step on the frame they saw, so an approved card's step is not run on that frame.
  const resumesBefore = run.drive?.resumes;
  const answer = await run.confirm({ action, why: explanation, from: 'google', code: String(call.name), text: `${intent} ${explanation}` });
  if (answer.approved) return { ack: true, reframe: run.drive?.resumes !== resumesBefore };
  if (answer.denied) return { stop: { reason: 'user', notice: 'Computer use stopped: you declined Google\'s safety check.' } };
  return { stop: { reason: 'user' } };
}

// The person's answer to confirm_with_user or hand_over, shown as a step row like any other tool.
async function askTool(call, args, run, ctx) {
  const name = call.name;
  const summary = name === 'confirm_with_user' ? `Confirm: ${clip(args.action, 80)}` : `Hand over: ${clip(args.reason, 80)}`;
  ctx?.emit?.({ type: 'tool', id: call.id, name, summary });
  let res;
  if (name === 'confirm_with_user') {
    res = typeof args.action === 'string' && args.action.trim()
      ? await run.confirm({ action: args.action, why: typeof args.why === 'string' ? args.why : '', from: 'model' })
      : { ok: false, output: 'confirm_with_user needs an action.' };
  } else {
    res = typeof args.reason === 'string' && args.reason.trim()
      ? await run.handOver({ reason: args.reason })
      : { ok: false, output: 'hand_over needs a reason.' };
  }
  const note = clip(res.summary ?? (res.ok ? 'OK' : res.output), 300);
  ctx?.emit?.({ type: 'tool_result', id: call.id, ok: Boolean(res.ok), summary: note });
  ctx?.out?.tools?.push({ name, summary, ok: Boolean(res.ok), result: note });
  return res;
}

// One batch of function calls, in order. A failure stops the rest of the batch (they get NOT_EXECUTED). Afterwards one fresh screenshot
// is shared by every result of the batch.
async function runBatch(calls, run, ctx) {
  const size = run.frame ? { width: run.frame.width, height: run.frame.height } : { width: SCREEN_FRAME, height: SCREEN_FRAME };
  const pending = [];
  let failed = false;
  let computer = 0;
  for (const call of calls) {
    if (!call.id) throw new Error('Google did not give a call id for a step, so the step cannot be answered.');
    const args = isObj(call.arguments) ? call.arguments : isObj(call.args) ? call.args : {};
    // A call after a failure is not run, so it gets no safety card either.
    if (failed) {
      pending.push({ call, res: { ok: false, output: NOT_EXECUTED }, ack: false });
      continue;
    }
    const gate = await safetyGate(call, args, run, ctx);
    if (gate.stop) return { pending, stop: gate.stop };
    if (gate.skip) {
      failed = true;
      pending.push({ call, res: { ok: false, output: gate.note }, ack: false });
      continue;
    }
    if (gate.reframe) {
      failed = true;
      pending.push({ call, res: { ok: false, output: REFRAME }, ack: true });
      continue;
    }
    let res;
    if (call.name === 'confirm_with_user' || call.name === 'hand_over') {
      res = await askTool(call, args, run, ctx);
    } else {
      computer += 1;
      try {
        res = { ok: true, output: 'OK' };
        for (const action of canonicalsFor(call.name, args, size)) {
          res = await run.step(action);
          if (!res.ok) break;
        }
        res = res.ok ? { ok: true, output: 'OK' } : res;
      } catch (err) {
        res = { ok: false, output: err.message };
      }
    }
    if (!res.ok) failed = true;
    pending.push({ call, res, ack: gate.ack });
  }
  let png = null;
  if (computer > 0 && !run.over && run.drive?.state !== 'stopped') {
    const shot = await run.step({ kind: 'screenshot' });
    png = shot.ok ? shot.blocks?.[0]?.source?.data ?? null : null;
  }
  return { results: pending.map(p => resultOf(p.call, p.res, png, p.ack)) };
}

// Plenum's switched-off kinds, as Google policy names, for the request.
const disabledFor = run => policiesFor(run.switchedOff?.() ?? []);

// The loop. Each request sends the task (first) or the function results (later) with previous_interaction_id. It ends when a reply has
// no function call, when the run is stopped or over (one more reply is asked for, so the model can report), at the run's request cap,
// or when the spend cap stops the run.
export async function* runGeminiLoop(args = {}, deps = {}) {
  const { id, system, messages, signal, ctx, onUsage } = args;
  const run = ctx?.computer;
  if (!run) throw new Error('No computer run is on.');
  const d = withDefaults(deps);
  const model = await resolveGeminiComputerModel(id, d);
  if (!model) throw Object.assign(new Error(NO_MODEL), { status: 400 });

  const typed = String(system ?? '').trim();
  const extra = String(run.systemText ?? '');
  const systemInstruction = extra && !typed.includes(extra) ? (typed ? `${typed}\n\n${extra}` : extra) : typed;

  // The first turn: the task and a screenshot of the screen as it is now.
  const first = await run.step({ kind: 'screenshot' });
  const firstPng = first.ok ? first.blocks?.[0]?.source?.data ?? null : null;
  if (!firstPng) throw new Error(first.output || 'The screenshot for the first turn could not be taken.');
  let input = [
    { type: 'text', text: `${taskText(messages)}\n\nThe first screenshot follows.` },
    { type: 'image', data: firstPng, mime_type: 'image/png' },
  ];

  const reports = [];
  let previousId = null;
  let reported = false;
  try {
    for (let step = 0; ; step++) {
      const limit = run.maxRequests;
      if (step >= limit) {
        yield `\n\n[Stopped after ${limit} tool steps. Send a follow-up to continue.]`;
        break;
      }
      const key = await readKey(d);
      const body = { model, input, tools: toolsFor(disabledFor(run)), system_instruction: systemInstruction };
      if (previousId) body.previous_interaction_id = previousId;
      const sentAt = Date.now();
      const response = await callGoogle(d, { method: 'POST', path: '/interactions', body, key, signal, timeoutMs: REQUEST_MS });
      const usage = usageOf(response.usage, sentAt);
      if (usage) {
        reports.push(usage);
        try {
          onUsage?.(usage);
        } catch {
          // The reply matters more than its bookkeeping.
        }
      }
      previousId = response.id ?? null;
      const calls = [];
      for (const item of Array.isArray(response.steps) ? response.steps : []) {
        if (isObj(item) && item.type === 'function_call') calls.push(item);
        else {
          const text = replyText(item);
          if (text) yield text;
        }
      }
      if (!calls.length) break;
      if (!previousId) throw new Error('Google did not return an interaction id, so the run cannot go on.');
      if (signal?.aborted || reported) break;
      if ((step + 1) % 5 === 0 && run.budgetCheck(reports)?.over) break;

      const outcome = await runBatch(calls, run, ctx);
      if (outcome.stop) {
        if (outcome.stop.notice) emitNotice(ctx, outcome.stop.notice);
        await run.finish(outcome.stop.reason);
        break;
      }
      if (run.drive?.state === 'stopped') break;
      input = outcome.results;
      if (run.over) reported = true;
    }
  } catch (err) {
    // A run that was stopped, or whose turn was cancelled, ends quietly like a cancel: the run has already said why in the chat.
    if (err?.name === 'DriveStopped' || signal?.aborted) return;
    throw err;
  } finally {
    // The blocks of a computer run are never kept in the transcript (the run log holds its frames).
    if (ctx?.out) ctx.out.api = [];
  }
}

// The driver contract: lib/computer/drivers.mjs calls this through providers.mjs for a chat turn with a computer run.
export async function* streamComputer(args = {}) {
  yield* runGeminiLoop(args, {});
}
