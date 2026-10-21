import { apiProvider } from './api-providers.mjs';
import { IMAGE_REFUSAL } from './images.mjs';
import { pdfRefusal } from './attachments.mjs';
import { reportUsage, tokensFromChat } from './pricing.mjs';
import { clip, describeCall, loadTools, runTool, toolsFor } from './tools.mjs';

// Adapter for the OpenAI-compatible providers in lib/api-providers.mjs (xAI, OpenAI, DeepSeek, Mistral and
// Google AI). Each one takes POST {baseUrl}/chat/completions with stream: true and answers with server-sent
// events. Its events and ctx.out bookkeeping match streamClaude in lib/providers.mjs, so the chat view treats
// the two alike.
// Token counts: the request asks for them with stream_options.include_usage, and the provider sends them in the last
// chunk before [DONE] (a chunk with no choices). Each round reports { at, input, cached, output } through onUsage.

// reasoning_effort goes out only to the providers and model ids listed here. UNVERIFIED: this table is written
// from the providers' docs as last known, not from a real call. Until a real call shows the field accepted and
// the mapping right, treat it as a guess. Anything not listed gets no reasoning_effort field, because a model
// that does not take the field answers with an error. xhigh and max fold into high, which these providers do
// not name.
const REASONING_EFFORT = {
  openai: { models: /^(o\d|gpt-5)/, levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } },
  googleai: { models: /^gemini-(2\.5|3)/, levels: { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' } },
};

// Same limit as MAX_STEPS in providers.mjs: at most this many model requests that ask for tools.
const MAX_ROUNDS = 30;
const MAX_RESULT = 24_000;
const MAX_NOTE = 300;
const DONE = Symbol('done');

// The reasoning_effort value for a provider, model and effort, or null when the field should be left out.
export function reasoningEffortFor(provider, id, effort) {
  if (!Object.hasOwn(REASONING_EFFORT, provider)) return null;
  const entry = REASONING_EFFORT[provider];
  if (!entry.models.test(String(id ?? ''))) return null;
  const level = String(effort ?? '').trim().toLowerCase();
  return Object.hasOwn(entry.levels, level) ? entry.levels[level] : null;
}

// The conversation as plain role and content strings, with the system prompt first. Claude-style content
// blocks are reduced to their text, because tool blocks from another provider mean nothing to this one.
const plainText = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  }
  return '';
};

function chatMessages(system, messages) {
  const out = [];
  if (String(system ?? '').trim()) out.push({ role: 'system', content: String(system) });
  for (const m of messages) {
    const text = plainText(m?.content);
    if (!text.trim()) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  return out;
}

// One tool definition in the chat-completions function format.
const chatTool = t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } });

// Tool arguments arrive as a JSON string. An empty string means no arguments.
function parseArguments(raw) {
  if (!String(raw ?? '').trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.');
  return value;
}

// Which call a streamed tool_calls piece belongs to. Most providers send an index. Some send the id only on a
// call's first piece, and then later pieces with neither id nor index continue the call before them.
function slotFor(pending, piece) {
  if (Number.isInteger(piece.index)) return piece.index;
  if (piece.id) {
    const seen = pending.findIndex(p => p?.id === piece.id);
    return seen >= 0 ? seen : pending.length;
  }
  return Math.max(0, pending.length - 1);
}

// Reads one line of the event stream. Returns null for lines that carry no data (comments, event names, blank
// separators), DONE for the end marker, and otherwise the parsed chunk. The payload is never echoed in an error.
function readSseLine(line, label) {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.startsWith('data:')) return null;
  const payload = text.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return DONE;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    throw new Error(`${label} sent a reply this app could not read.`);
  }
  return chunk && typeof chunk === 'object' ? chunk : null;
}

// The finish_reason a chunk carries ('stop', 'length', 'tool_calls' and so on), or null when it carries none.
// 'length' means the reply hit the output limit (see streamOpenAICompat).
export function finishOf(chunk) {
  const reason = chunk?.choices?.[0]?.finish_reason;
  return typeof reason === 'string' && reason ? reason : null;
}

// The key never appears in an error, even when a provider echoes it back.
const redact = (text, apiKey) => (apiKey ? String(text).split(apiKey).join('[key]') : String(text));
const errorText = v => (typeof v === 'string' ? v : String(v?.message ?? ''));
const reasonOf = err => err?.cause?.code ?? err?.message ?? 'unknown error';

// Builds the error for a non-2xx answer. It carries the provider's own message, never the request headers.
async function failure(res, label, apiKey) {
  const raw = await res.text().catch(() => '');
  let detail;
  try {
    const parsed = JSON.parse(raw);
    detail = errorText(parsed?.error ?? parsed?.message ?? '');
  } catch {
    detail = raw.replace(/<[^>]*>/g, ' ');
  }
  detail = clip(redact(String(detail).replace(/\s+/g, ' ').trim(), apiKey), MAX_NOTE);
  const said = detail ? ` The provider said: ${detail}` : '';
  if (res.status === 401) return new Error(`${label} rejected the key (401). Open Accounts and save a valid key.${said}`);
  return new Error(`${label} returned an error (${res.status}).${said}`);
}

// One request and its streamed reply. It yields the text deltas and returns what the model asked for:
// { text, calls: [{ id, name, args }], aborted, usage, at, finish }, where args is the raw JSON text as it arrived, usage is the
// provider's usage object (null when it sent none), at is when the request was sent and finish is the last finish_reason
// the stream gave (null when none).
async function* streamRound({ url, apiKey, label, body, signal }) {
  const at = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
      // A redirect is refused rather than followed, so the key and the conversation are never sent to another host.
      redirect: 'error',
    });
  } catch (err) {
    if (signal?.aborted) return { text: '', calls: [], aborted: true };
    if (/redirect/i.test(String(err?.cause?.message ?? ''))) {
      throw new Error(`${label} tried to redirect the request, so it was stopped. The key was not sent on.`);
    }
    throw new Error(`${label} could not be reached (${reasonOf(err)}). Check the connection, then send again.`);
  }
  if (!res.ok) {
    if (signal?.aborted) return { text: '', calls: [], aborted: true };
    throw await failure(res, label, apiKey);
  }
  if (!res.body) throw new Error(`${label} sent an empty reply.`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let usage = null;
  let finish = null;
  const pending = [];
  try {
    for (;;) {
      let got;
      try {
        got = await reader.read();
      } catch (err) {
        if (signal?.aborted) return { text, calls: [], aborted: true };
        throw new Error(`${label} stopped sending the reply (${reasonOf(err)}).`);
      }
      const eof = got.done;
      // A network read can end in the middle of a line, so the bytes wait in buf until the newline arrives.
      buf += eof ? decoder.decode() : decoder.decode(got.value, { stream: true });
      if (eof && buf && !buf.endsWith('\n')) buf += '\n';
      let stop = false;
      let nl;
      while (!stop && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const chunk = readSseLine(line, label);
        if (chunk === DONE) {
          stop = true;
          break;
        }
        if (!chunk) continue;
        if (chunk.error) {
          throw new Error(`${label} stopped with an error: ${clip(redact(errorText(chunk.error) || 'no reason given', apiKey), MAX_NOTE)}`);
        }
        // Providers that count tokens send a usage object, either null on every chunk but the last or only on the last.
        if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
        finish = finishOf(chunk) ?? finish;
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          text += delta.content;
          yield delta.content;
        }
        for (const piece of delta?.tool_calls ?? []) {
          if (!piece || typeof piece !== 'object') continue;
          const i = slotFor(pending, piece);
          pending[i] ??= { id: '', name: '', args: '' };
          if (piece.id) pending[i].id = String(piece.id);
          if (piece.function?.name) pending[i].name = String(piece.function.name);
          if (typeof piece.function?.arguments === 'string') pending[i].args += piece.function.arguments;
        }
      }
      if (stop || eof) break;
    }
  } finally {
    // The body is closed even when the caller stops reading early, so no connection is left open.
    reader.cancel().catch(() => {});
  }
  return { text, calls: pending.filter(Boolean), aborted: false, usage, at, finish };
}

// Runs one round's tool calls. Each call is announced first, then run; several delegate calls in one reply run
// in parallel, as they do in the Claude adapter, and the other calls keep their order.
async function runCalls(calls, ctx) {
  const items = calls.map(call => {
    let input = null;
    try {
      input = parseArguments(call.args);
    } catch {
      input = null;
    }
    return { ...call, input, argsText: input ? JSON.stringify(input) : '{}', summary: describeCall(call.name, input ?? {}) };
  });
  for (const it of items) ctx.emit?.({ type: 'tool', id: it.id, name: it.name, summary: it.summary });
  const runOne = async it => {
    let res;
    if (!it.input) {
      res = {
        ok: false,
        summary: 'The arguments were not valid JSON.',
        output: 'Error: the arguments for this tool call were not a JSON object, so the tool did not run. Send the call again with valid JSON arguments.',
      };
    } else {
      try {
        res = await runTool(it.name, it.input, { ...ctx, parent: it.id });
      } catch (err) {
        res = { ok: false, summary: err.message, output: `Error: ${err.message}` };
      }
    }
    const note = clip(res.summary ?? '', MAX_NOTE);
    ctx.emit?.({ type: 'tool_result', id: it.id, ok: res.ok, summary: note });
    ctx.out?.tools.push({ name: it.name, summary: it.summary, ok: res.ok, result: note });
    return { id: it.id, name: it.name, argsText: it.argsText, content: clip(res.output ?? '', MAX_RESULT) };
  };
  const parallel = new Map(items.filter(it => it.name === 'delegate').map(it => [it.id, runOne(it)]));
  const results = [];
  for (const it of items) results.push(await (parallel.get(it.id) ?? runOne(it)));
  return results;
}

// ctx (optional) turns on tools: { root, mode, signal, emit, approve, queueUpdate, out }, the same ctx the Claude
// adapter takes. Without ctx this is a plain reply. ctx.out.api is left alone on purpose: historyFor in
// providers.mjs replays it to Claude only, and these tool turns are not in Claude's format, so they stay out of it.
// A stop (signal) ends the stream quietly, the way the caller expects: it is not thrown as an error.
// onUsage (optional) gets { at, input, cached, output } after each round whose provider sent token counts.
// onStop (optional) gets 'length' when the last round hit the output limit with text and no tool call. It is called once,
// at the end of the reply, and never for any other finish reason.
// images and PDFs (documents) are not sent to these providers in Plenum yet: a call that arrives with any is refused before a
// request is made. Text files are in the messages already.
export async function* streamOpenAICompat({ provider, id, baseUrl, apiKey, system, messages = [], ctx, signal, effort, onUsage, onStop, images, documents } = {}) {
  if (images?.length) throw new Error(IMAGE_REFUSAL);
  if (documents?.length) throw new Error(pdfRefusal(documents.length === 1 ? documents[0].name : ''));
  const label = apiProvider(provider)?.label ?? provider ?? 'The provider';
  if (!apiKey) throw new Error(`No ${label} key is saved. Open Accounts, paste the key and save it.`);
  const base = String(baseUrl ?? apiProvider(provider)?.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error(`${label} has no base URL.`);
  const url = `${base}/chat/completions`;
  const convo = chatMessages(system, messages);
  // A raw entry (a toolset for another API) has no input_schema, so it is not sent in this format.
  if (ctx) await loadTools();
  const tools = ctx ? toolsFor(ctx).filter(t => t.input_schema).map(chatTool) : null;
  const reasoning = reasoningEffortFor(provider, id, effort);
  // Only a provider listed with streamUsage: false is left out (see lib/api-providers.mjs). A caller that names no known
  // provider still asks, since the field is part of the OpenAI format.
  const askUsage = apiProvider(provider)?.streamUsage !== false;

  for (let round = 0; ; round++) {
    if (round >= MAX_ROUNDS) {
      yield `\n\n[Stopped after ${MAX_ROUNDS} tool steps. Send a follow-up to continue.]`;
      return;
    }
    const body = {
      model: id,
      stream: true,
      ...(askUsage ? { stream_options: { include_usage: true } } : {}),
      messages: convo,
      ...(tools ? { tools } : {}),
      ...(reasoning ? { reasoning_effort: reasoning } : {}),
    };
    const turn = yield* streamRound({ url, apiKey, label, body, signal });
    // Reported even when the request was stopped or is the last one, so the tokens it used are counted.
    const tokens = tokensFromChat(turn.usage);
    if (tokens) reportUsage(onUsage, { at: turn.at, ...tokens });
    if (turn.aborted || signal?.aborted) return;
    // A reply cut at the output limit with no tool call is the last round, so the caller hears about it here.
    if (turn.finish === 'length' && turn.text && !turn.calls.some(c => c.name)) onStop?.('length');
    if (!tools) return;
    // Calls without a name cannot be run or answered, so they are dropped. A call with no id gets one here,
    // since the tool message has to name the call it answers.
    const calls = turn.calls
      .filter(c => c.name)
      .map((c, i) => ({ id: c.id || `call_${round}_${i}`, name: c.name, args: c.args }));
    // Tool calls are run whenever the reply carries them, not only when finish_reason says so, since some
    // providers report "stop" with calls attached.
    if (!calls.length) return;
    const results = await runCalls(calls, ctx);
    if (signal?.aborted) return;
    convo.push({
      role: 'assistant',
      content: turn.text,
      tool_calls: results.map(r => ({ id: r.id, type: 'function', function: { name: r.name, arguments: r.argsText } })),
    });
    for (const r of results) convo.push({ role: 'tool', tool_call_id: r.id, content: r.content });
  }
}
