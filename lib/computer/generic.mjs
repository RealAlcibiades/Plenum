// The generic computer driver (DRIVERS.generic in lib/computer/drivers.mjs): a screenshot-and-act loop for any API model that takes
// images, so computer use is not limited to the models with a native computer tool. The model is offered function tools that mirror
// the canonical actions (computer_screenshot, computer_click, computer_drag, ...), next to the run's confirm_with_user and hand_over
// (lib/tools/70-computer.mjs). Every action goes through the run: ctx.computer.step() for the actions and looks, and runTool for the two
// questions, which the run answers. The checks, cards, limits, log and step rows are the run's, so a generic model is held to the same
// rules as Claude, OpenAI and Gemini. This file only translates between the chat-completions format and those canonical actions.
//
//   streamComputer({ provider, id, baseUrl, apiKey, system, messages, ctx, signal, effort, onUsage, onStop, images, documents })
//     an async generator of the reply's text. lib/providers.mjs passes it the arguments it gives the OpenAI-compatible adapter, with
//     the run in ctx.computer. The key is used in the Authorization header only.
//   GENERIC_TOOLS                 the computer_* function tools this driver adds, in the { name, description, input_schema } shape
//   canonicalFor(name, input)     -> { member, canonical }: the Claude toolset member name and the canonical action of one tool call
//                                    (throws an Error with a plain message for a call that is not valid)
//   imagePart(shape, mime, data)  -> one image part of a chat-completions message ('object' takes { url }, 'string' a plain URL)
//   imageShapeOf(ref)             -> the shape the capability table (lib/capabilities.mjs) gives this model for an image part, or null
//                                    for a model that takes no images
//   genericNotice(keyLabel)       -> the notice the chat shows when a generic model starts a run
//   genericSupportDetail(ref, deps) -> { level: 'generic' | 'no', message, note } for an API model that has no driver of its own, or
//                                    null for a model that does (Claude, OpenAI, Google AI) and for the CLIs. server.mjs asks it when
//                                    lib/computer/support.mjs answers 'no'. A model the capability table does not list as taking images is
//                                    'no' with the note 'cannot see images', with or without a saved key.
//
// Transport: one chat-completions request per model request, not streamed, posted to {baseUrl}/chat/completions. lib/openai-compat.mjs
// cannot yet carry images or route computer tools, so this file posts its own request and takes reasoningEffortFor and finishOf from it.
// Older screenshots are replaced by a short note before each request, so a long run keeps only its latest picture in the request.
import { imageSupport } from '../capabilities.mjs';
import { apiProvider } from '../api-providers.mjs';
import { keyFor } from '../keys.mjs';
import { pdfRefusal } from '../attachments.mjs';
import { finishOf, reasoningEffortFor } from '../openai-compat.mjs';
import { reportUsage, tokensFromChat } from '../pricing.mjs';
import { describeCall, loadTools, runTool, toolsFor } from '../tools.mjs';
import { stopAccelerator, stopKeyLabel } from '../platform/computer.mjs';
import * as store from '../store.mjs';
import { NOT_EXECUTED, changesScreen, toCanonical } from './claude.mjs';
import { driverInstalled } from './drivers.mjs';

const MAX_RESULT = 24_000;
const MAX_NOTE = 300;
const OUT_TOOLS_MAX = 400;
const REQUEST_MS = 180_000;
const PICTURE_TEXT = 'OK. The picture follows in the next message.';
const REMOVED_PICTURE = '[An earlier screenshot, removed to keep the request short.]';

// The shape a model takes for an image part, from its row in the capability table: 'object' is image_url { url }, 'string' is image_url as
// a plain URL (Mistral's page). null for a model that takes no images. The driver keeps no table of its own.
export const imageShapeOf = ref => imageSupport(ref).shape;

export function imagePart(shape, mime, data) {
  const url = `data:${mime || 'image/png'};base64,${data}`;
  return { type: 'image_url', image_url: shape === 'string' ? url : { url } };
}

// The providers whose computer runs have a driver of their own (Claude inside streamClaude, OpenAI and Google AI in lib/computer).
// lib/computer/support.mjs decides for those; this loop is for every other API model.
const OWN_DRIVER = new Set(['anthropic', 'openai', 'googleai']);

// The answer for a model that cannot take the screenshots a run sends it. why is the capability table's reason (lib/capabilities.mjs).
const noPicturesDetail = (label, id, why) => ({
  level: 'no',
  message: `${[label, id].filter(Boolean).join(' ')} cannot see images, so it cannot control the computer: ${why}.`,
  note: 'cannot see images',
});

// Whether the generic loop can drive this model: an API provider without a driver of its own, with this driver installed, a model the
// capability table lists as taking images, and a key saved. deps { installed, hasKey } are for the tests. The key is only looked up,
// never returned.
export async function genericSupportDetail(ref, deps = {}) {
  const text = String(ref ?? '');
  const at = text.indexOf(':');
  const provider = at < 0 ? '' : text.slice(0, at);
  if (OWN_DRIVER.has(provider)) return null;
  const api = apiProvider(provider);
  if (!api) return null;
  if (!(deps.installed ?? driverInstalled)('generic')) return null;
  // Checked before the key: a model that cannot see images is never ready, so no key is asked for it.
  const picture = imageSupport(text);
  if (!picture.ok) return noPicturesDetail(api.label, text.slice(at + 1), picture.why);
  const hasKey = deps.hasKey ?? (async p => Boolean(await keyFor(p)));
  if (!(await hasKey(provider))) {
    return { level: 'no', message: `Computer use with ${api.label} models needs a saved ${api.label} key. Add one in Accounts.`, note: `needs a ${api.label} key` };
  }
  return { level: 'generic', message: '', note: 'generic loop' };
}

export const genericNotice = keyLabel =>
  `This model was not trained for computer use. Plenum sends it screenshots and runs its clicks through the same checks, but expect misclicks and retries. Stop on the bar or ${keyLabel} ends it at any moment.`;

// ---------- the function tools ----------

const HELD = { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'super'] }, description: 'Keys held during the action, for example ["ctrl"].' };
const POINT_ITEMS = { type: 'integer' };
const point = description => ({ type: 'array', items: POINT_ITEMS, minItems: 2, maxItems: 2, description });
const tool = (name, description, properties = {}, required = []) => ({ name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });

export const GENERIC_TOOLS = Object.freeze([
  tool('computer_screenshot', 'Take a new screenshot of what the run can see. Use it first, and again after a pause or after any step that may have changed the screen.'),
  tool('computer_zoom', 'Show one part of the last screenshot larger. region is [x0, y0, x1, y1] in the pixels of that screenshot.', {
    region: { type: 'array', items: POINT_ITEMS, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in the pixels of the last screenshot.' },
  }, ['region']),
  tool('computer_click', 'Click at a point of the last screenshot. button: left (default), right or middle. count: 1 (default), 2 for a double click or 3 for a triple click, left button only. Leave coordinate out to click where the pointer is.', {
    coordinate: point('[x, y] in the pixels of the last screenshot.'),
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    count: { type: 'integer', enum: [1, 2, 3] },
    modifiers: HELD,
  }),
  tool('computer_move', 'Move the pointer to a point without clicking, for example to open a menu that appears on hover.', {
    coordinate: point('[x, y] in the pixels of the last screenshot.'),
  }, ['coordinate']),
  tool('computer_drag', 'Press the left button at from, drag to to, and let go.', {
    from: point('[x, y] where the drag starts.'),
    to: point('[x, y] where the drag ends.'),
    modifiers: HELD,
  }, ['from', 'to']),
  tool('computer_scroll', 'Scroll with the mouse wheel. direction: up, down, left or right. amount: notches, 1 to 20 (default 3). Leave coordinate out to scroll where the pointer is.', {
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'integer', minimum: 1, maximum: 20 },
    coordinate: point('[x, y] to scroll over.'),
  }, ['direction']),
  tool('computer_type', 'Type text into the field that has the focus. Never type a password, a code, or card or bank details: call hand_over instead.', {
    text: { type: 'string', description: 'The text to type.' },
  }, ['text']),
  tool('computer_key', 'Press one key or a combination, written as a name such as "Return", "Tab", "Escape", "BackSpace" or "ctrl+s". repeat: how many times, 1 to 20 (default 1).', {
    keys: { type: 'string', description: 'A key name or a chord joined with +.' },
    repeat: { type: 'integer', minimum: 1, maximum: 20 },
  }, ['keys']),
  tool('computer_hold', 'Hold a key or a combination down for a number of seconds (up to 5), then let go.', {
    keys: { type: 'string', description: 'A key name or a chord joined with +.' },
    seconds: { type: 'number', minimum: 0, maximum: 5 },
  }, ['keys', 'seconds']),
  tool('computer_wait', 'Wait for a number of seconds (up to 30), for example while a page loads. Take a screenshot afterwards.', {
    seconds: { type: 'number', minimum: 0, maximum: 30 },
  }, ['seconds']),
]);

const CLICK_MEMBER = Object.freeze({
  'left:1': 'left_click',
  'left:2': 'double_click',
  'left:3': 'triple_click',
  'right:1': 'right_click',
  'middle:1': 'middle_click',
});

// A numeric text ("120", "1.5") becomes a number; anything else is returned as it came, for toCanonical to refuse with its own message.
const numeric = v => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v);

// [x, y] or {x, y} as [x, y], numbers converted where they are text. Absent is undefined; a value of another shape is refused.
function pointOf(value, what) {
  if (value === undefined || value === null) return undefined;
  const p = value && typeof value === 'object' && !Array.isArray(value) ? [value.x, value.y] : value;
  if (!Array.isArray(p)) throw new Error(`The ${what} must be [x, y] in the pixels of the last screenshot.`);
  return p.map(numeric);
}

function requiredPoint(value, what) {
  const p = pointOf(value, what);
  if (p === undefined) throw new Error(`The ${what} is needed: give it as [x, y] in the pixels of the last screenshot.`);
  return p;
}

// Keys or modifiers as the text toCanonical reads: a name, a '+'-joined chord, or a list such as ["ctrl", "s"] joined the same way.
function keysText(value, what) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean).join('+');
  if (typeof value === 'string') return value.trim();
  throw new Error(`The ${what} must be text such as "ctrl+s", or a list such as ["ctrl"].`);
}

// One tool call as the Claude toolset member it is (lib/computer/claude.mjs), with the input that member takes. Throws for a name that is
// not a computer action, or for a click the buttons cannot make.
export function memberOf(name, input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  switch (name) {
    case 'computer_screenshot': return { member: 'screenshot', input: {} };
    case 'computer_zoom': return { member: 'zoom', input: { region: Array.isArray(i.region) ? i.region.map(numeric) : i.region } };
    case 'computer_click': {
      const button = i.button ?? 'left';
      const count = numeric(i.count ?? 1);
      if (!['left', 'right', 'middle'].includes(button)) throw new Error('The button must be left, right or middle.');
      if (![1, 2, 3].includes(count)) throw new Error('The count must be 1, 2 or 3.');
      const member = CLICK_MEMBER[`${button}:${count}`];
      if (!member) throw new Error('Only the left button can be double or triple clicked. Use count 1 for the right or middle button.');
      return { member, input: { coordinate: pointOf(i.coordinate, 'coordinate'), text: keysText(i.modifiers, 'modifiers') } };
    }
    case 'computer_move': return { member: 'mouse_move', input: { coordinate: requiredPoint(i.coordinate, 'coordinate') } };
    case 'computer_drag': {
      return {
        member: 'left_click_drag',
        input: { start_coordinate: requiredPoint(i.from, 'from point'), coordinate: requiredPoint(i.to, 'to point'), text: keysText(i.modifiers, 'modifiers') },
      };
    }
    case 'computer_scroll':
      return { member: 'scroll', input: { scroll_direction: i.direction, scroll_amount: numeric(i.amount ?? 3), coordinate: pointOf(i.coordinate, 'coordinate') } };
    case 'computer_type': return { member: 'type', input: { text: i.text } };
    case 'computer_key': return { member: 'key', input: { text: keysText(i.keys, 'keys'), repeat: numeric(i.repeat ?? 1) } };
    case 'computer_hold': return { member: 'hold_key', input: { text: keysText(i.keys, 'keys'), duration: numeric(i.seconds) } };
    case 'computer_wait': return { member: 'wait', input: { duration: numeric(i.seconds) } };
    default: throw new Error(`"${String(name).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 40)}" is not a computer action.`);
  }
}

// The canonical action of one tool call: the same validation and caps as the Claude toolset (lib/computer/claude.mjs toCanonical).
export function canonicalFor(name, input) {
  const { member, input: args } = memberOf(name, input);
  return { member, canonical: toCanonical(member, args) };
}

// ---------- the chat-completions transport ----------

const redact = (text, apiKey) => (apiKey ? String(text).split(apiKey).join('[key]') : String(text));
const cut = (text, n) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const reasonOf = err => err?.cause?.code ?? err?.message ?? 'unknown error';

// The error for a non-2xx answer: the provider's own message, redacted, never the request.
async function failureOf(res, label, apiKey) {
  const raw = await res.text().catch(() => '');
  let detail = '';
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error ?? parsed?.message ?? '';
    detail = typeof err === 'string' ? err : String(err?.message ?? '');
  } catch {
    detail = raw.replace(/<[^>]*>/g, ' ');
  }
  detail = cut(redact(detail.replace(/\s+/g, ' ').trim(), apiKey), MAX_NOTE);
  const said = detail ? ` The provider said: ${detail}` : '';
  if (res.status === 401) return new Error(`${label} rejected the key (401). Open Accounts and save a valid key.${said}`);
  return new Error(`${label} returned an error (${res.status}).${said}`);
}

const argumentsText = raw => {
  if (typeof raw === 'string') return raw;
  return raw === undefined || raw === null ? '{}' : JSON.stringify(raw);
};

// The parts of one reply that the loop needs: its text, its tool calls, why it stopped and its usage.
function replyOf(json) {
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  let text = '';
  if (typeof message.content === 'string') text = message.content;
  else if (Array.isArray(message.content)) text = message.content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('');
  const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
    .filter(c => c && typeof c === 'object')
    .map(c => ({ id: String(c.id ?? ''), name: String(c.function?.name ?? ''), args: argumentsText(c.function?.arguments) }))
    .filter(c => c.name);
  return { text, calls, finish: finishOf(json), usage: json?.usage ?? null };
}

function requestSignal(signal) {
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_MS) : null;
  if (!signal) return timeout ?? undefined;
  if (!timeout || typeof AbortSignal.any !== 'function') return signal;
  return AbortSignal.any([signal, timeout]);
}

// One chat-completions request. -> the parsed reply, or null when the caller's signal stopped it.
async function post({ url, apiKey, label, body, signal }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: requestSignal(signal),
      // A redirect is refused rather than followed, so the key and the screenshots are never sent to another host.
      redirect: 'error',
    });
  } catch (err) {
    if (signal?.aborted) return null;
    if (err?.name === 'TimeoutError') throw new Error(`${label} did not answer within ${REQUEST_MS / 1000} seconds. Send again to retry.`);
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) throw new Error(`${label} tried to redirect the request, so it was stopped. The key was not sent on.`);
    throw new Error(`${label} could not be reached (${reasonOf(err)}). Check the connection, then send again.`);
  }
  if (!res.ok) {
    if (signal?.aborted) return null;
    throw await failureOf(res, label, apiKey);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    if (signal?.aborted) return null;
    throw new Error(`${label} sent a reply this app could not read.`);
  }
  if (json?.error) throw new Error(`${label} stopped with an error: ${cut(redact(typeof json.error === 'string' ? json.error : String(json.error?.message ?? 'no reason given'), apiKey), MAX_NOTE)}`);
  return replyOf(json);
}

// ---------- messages ----------

// Chat history as plain text, the way lib/openai-compat.mjs reads it: Claude-style blocks are reduced to their text.
const plainText = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  return '';
};

// The run's rules follow the system text when the caller has not already added them.
function systemTextOf(system, extra) {
  const base = String(system ?? '').trim();
  const add = String(extra ?? '').trim();
  if (!add || base.includes(add)) return base;
  return base ? `${base}\n\n${add}` : add;
}

// Image parts of a run's result: its blocks are Claude-style image blocks, from lib/computer/run.mjs.
function pictureParts(blocks, shape) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter(b => b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string')
    .map(b => imagePart(shape, b.source.media_type, b.source.data));
}

// Replaces every picture already in the conversation by a short note: only the newest screenshots reach the model.
function dropOldPictures(convo) {
  for (const m of convo) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.map(part => (part?.type === 'image_url' ? { type: 'text', text: REMOVED_PICTURE } : part));
  }
}

// The newest user message carries the pictures that came with this turn.
function attachToNewestUser(convo, parts) {
  for (let i = convo.length - 1; i >= 0; i--) {
    if (convo[i].role !== 'user') continue;
    const text = typeof convo[i].content === 'string' ? convo[i].content : plainText(convo[i].content);
    convo[i] = { role: 'user', content: [{ type: 'text', text }, ...parts] };
    return;
  }
  convo.push({ role: 'user', content: parts });
}

const argumentsOf = raw => {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? null : raw;
  const text = String(raw ?? '').trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};

// One tool call of a reply. A computer action goes through the run (its step rows, checks and log are the run's); confirm_with_user and
// hand_over, and the ordinary tools this turn offers, go through runTool as they do in the OpenAI-compatible adapter.
async function runCall(call, { run, ctx, shape }) {
  const computer = call.name.startsWith('computer_');
  const input = argumentsOf(call.args);
  if (!input) {
    return { ok: false, computer, text: 'Error: the arguments for this tool call were not a JSON object, so the tool did not run. Send the call again with valid JSON arguments.', pictures: [] };
  }
  if (computer) {
    let picked;
    try {
      picked = canonicalFor(call.name, input);
    } catch (err) {
      return { ok: false, computer: true, text: `Error: ${err.message}`, pictures: [] };
    }
    const res = await run.step(picked.canonical);
    const ok = res.ok === true;
    return {
      ok,
      computer: true,
      changed: ok && changesScreen(picked.member),
      over: res.over === true,
      text: ok ? (res.blocks ? PICTURE_TEXT : res.output ?? 'OK') : res.output ?? 'The step did not run.',
      pictures: ok ? pictureParts(res.blocks, shape) : [],
    };
  }
  const summary = describeCall(call.name, input);
  ctx.emit?.({ type: 'tool', id: call.id, name: call.name, summary });
  let res;
  try {
    res = await runTool(call.name, input, { ...ctx, parent: call.id });
  } catch (err) {
    res = { ok: false, summary: err.message, output: `Error: ${err.message}` };
  }
  const note = cut(res.summary ?? '', MAX_NOTE);
  ctx.emit?.({ type: 'tool_result', id: call.id, ok: res.ok, summary: note });
  if (ctx.out?.tools && ctx.out.tools.length < OUT_TOOLS_MAX) ctx.out.tools.push({ name: call.name, summary, ok: res.ok, result: note });
  return { ok: Boolean(res.ok), computer: false, text: cut(res.output ?? '', MAX_RESULT), pictures: [] };
}

// The keys the run's stop key is named by, as the person sees it on this platform (a Stop override in state.json is honoured).
function stopKeyText() {
  let override = null;
  try {
    override = store.get()?.driveStopKey ?? null;
  } catch {
    override = null;
  }
  return stopKeyLabel(process.platform, stopAccelerator(process.platform, override));
}

// The generator. It ends when the model stops calling tools, when the run is over (after one more request, so the model can say what it
// did), when the spend cap is reached, when the model has used its requests, or when the caller stops it.
export async function* streamComputer({ provider, id, baseUrl, apiKey, system, messages = [], ctx, signal, effort, onUsage, onStop, images = [], documents = [] } = {}) {
  const run = ctx?.computer;
  if (!run) throw new Error('No computer run is on for this reply.');
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const label = apiProvider(provider)?.label ?? provider ?? 'The provider';
  // The same check as genericSupportDetail, for a caller that starts the run without asking it: a model that cannot see images gets no
  // request and no screenshot.
  const picture = imageSupport(`${provider}:${id}`);
  if (!picture.ok) throw new Error(noPicturesDetail(label, id, picture.why).message);
  if (!apiKey) throw new Error(`No ${label} key is saved. Open Accounts, paste the key and save it.`);
  const base = String(baseUrl ?? apiProvider(provider)?.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error(`${label} has no base URL.`);
  if (run.declined) return;
  const url = `${base}/chat/completions`;
  const shape = picture.shape;
  const reasoning = reasoningEffortFor(provider, id, effort);
  const emit = event => {
    try {
      ctx.emit?.(event);
    } catch {
      // A stream that is gone changes nothing for the run.
    }
  };

  try {
    emit({ type: 'notice', kind: 'computer', text: genericNotice(stopKeyText()) });
    await loadTools();
    const offered = (toolsFor(ctx) ?? [])
      .filter(t => typeof t?.name === 'string' && t.input_schema && !t.name.startsWith('computer_'))
      .map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const tools = [...GENERIC_TOOLS, ...offered].map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

    const convo = [];
    const sysText = systemTextOf(system, run.systemText);
    if (sysText) convo.push({ role: 'system', content: sysText });
    for (const m of messages) {
      const text = plainText(m?.content);
      if (!text.trim()) continue;
      convo.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
    if (images?.length) attachToNewestUser(convo, images.map(image => imagePart(shape, image.mime, image.data)));

    // The model sees the screen before it acts; a run that has no picture yet refuses every action.
    const first = await run.step({ kind: 'screenshot' });
    if (first.over) return;
    convo.push({ role: 'user', content: [{ type: 'text', text: first.ok ? 'This is the screen now. Do the task above.' : `The first screenshot failed: ${first.output}` }, ...pictureParts(first.blocks, shape)] });

    const reports = [];
    let finalRound = false;
    for (let round = 0; ; round++) {
      if (signal?.aborted) return;
      if (!finalRound && round >= run.maxRequests) {
        yield `\n\n[Computer use stopped after ${round} model requests. The run is over.]`;
        return;
      }
      const at = Date.now();
      const body = {
        model: id,
        stream: false,
        messages: convo,
        tools,
        ...(finalRound ? { tool_choice: 'none' } : {}),
        ...(reasoning ? { reasoning_effort: reasoning } : {}),
      };
      const reply = await post({ url, apiKey, label, body, signal });
      if (!reply || signal?.aborted) return;
      const tokens = tokensFromChat(reply.usage);
      if (tokens) {
        const record = { at, ...tokens };
        reports.push(record);
        reportUsage(onUsage, record);
      }
      if (reply.text) yield reply.text;
      if (reply.finish === 'length' && reply.text && !reply.calls.length) onStop?.('length');
      if (finalRound || !reply.calls.length) return;
      // A spend cap that the run has reached ends the run before the model's next actions, and the run says so in the chat.
      if ((round + 1) % 5 === 0 && run.budgetCheck(reports)?.over) return;

      const calls = reply.calls.map((c, i) => ({ id: c.id || `call_${round}_${i}`, name: c.name, args: c.args }));
      convo.push({
        role: 'assistant',
        content: reply.text,
        tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })),
      });

      // The calls run strictly in order. Once a computer action fails, every later call of the reply is not run (NOT_EXECUTED), as the
      // Claude adapter does.
      const results = [];
      const pictures = [];
      let failed = false;
      let over = false;
      let acted = false;
      let last = null;
      for (const call of calls) {
        if (signal?.aborted) return;
        const r = failed ? { ok: false, computer: call.name.startsWith('computer_'), text: NOT_EXECUTED, pictures: [] } : await runCall(call, { run, ctx, shape });
        if (r.computer && !r.ok) failed = true;
        if (r.over) over = true;
        if (r.changed) acted = true;
        pictures.push(...r.pictures);
        results.push({ id: call.id, text: r.text });
        last = { ...r, name: call.name };
      }
      for (const r of results) convo.push({ role: 'tool', tool_call_id: r.id, content: r.text });

      // When the reply changed the screen and did not end with a screenshot, the outcome is shown to the model in the same round.
      if (!over && acted && last?.ok && last.name !== 'computer_screenshot') {
        const shot = await run.step({ kind: 'screenshot' });
        if (shot.over) over = true;
        else if (shot.ok) pictures.push(...pictureParts(shot.blocks, shape));
      }
      if (pictures.length) {
        dropOldPictures(convo);
        convo.push({ role: 'user', content: [{ type: 'text', text: pictures.length > 1 ? 'Screenshots from the steps above:' : 'Screenshot from the steps above:' }, ...pictures] });
      }
      if (over || run.over) finalRound = true;
    }
  } catch (err) {
    // A stop that reaches the loop as an error ends the reply quietly, the way a cancel does; the run has already said why.
    if (err?.name === 'DriveStopped') return;
    throw err;
  }
}
