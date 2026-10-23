import { killTree, resolveLaunch, startChild, stripAnsi } from './proc.mjs';

// The client side of the Agent Client Protocol over stdio: newline-delimited JSON-RPC 2.0 on the agent's stdin and stdout.
// lib/cursor.mjs runs `agent acp` through it (Grok Build will use it as well). The run goes: initialize, session/new,
// session/prompt, with session/update notifications read on the way. The agent asks for permission with
// session/request_permission, and onPermission decides; the answer is one of the options the agent offered. Plenum offers no
// file access (the fs capabilities are false), so any other request from the agent gets a "method not found" error.
// The field shapes come from the ACP specification (https://agentclientprotocol.com), not from a signed-in Cursor run, so every
// field is read defensively and an unknown line is skipped. A line longer than 8 MB is dropped.
// Ending a run: a stop (the abort signal) sends session/cancel and then ends the process, within about a second.

export const ACP_VERSION = 1;
export const HANDSHAKE_MS = 30_000;
const MAX_LINE = 8 * 1024 * 1024;
const CANCEL_GRACE_MS = 1000;
// How long a run keeps reading after the agent has exited, so output that is still in the pipe is not lost (proc.mjs EXIT_GRACE_MS).
const EXIT_GRACE_MS = 300;
// The longest a finished run waits for its agent to exit after it was ended (see the end of runAcp).
const EXIT_WAIT_MS = 2000;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const CLIENT_CAPABILITIES = Object.freeze({ fs: Object.freeze({ readTextFile: false, writeTextFile: false }) });

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textString = v => (typeof v === 'string' ? v : '');

// The fields of a tool call that an update carries when it has them: its raw input, the locations it touches and its content (diffs
// name their path there). Nothing is added for a field the update does not send.
const callFields = update => {
  const fields = {};
  if (update.rawInput !== undefined) fields.rawInput = update.rawInput;
  if (Array.isArray(update.locations)) fields.locations = update.locations;
  if (Array.isArray(update.content)) fields.content = update.content;
  return fields;
};

// The text of a content value: one block or a list of blocks, read as text parts only.
export function textOf(content) {
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(p => (isObject(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}

// The text of a tool call's content: its items are { type: 'content', content: block } or other kinds (a diff, say), of which only
// the text is kept.
export function toolText(content) {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (!isObject(item)) return '';
    if (item.type === 'content') return textOf(item.content);
    return textOf(item);
  }).join('');
}

// Runs one ACP turn and resolves with { stopReason }. Rejects with a plain Error when the handshake times out, the agent answers
// with an error, or it exits before it answers the prompt (the message carries the end of its stderr, which the caller may read
// for a sign-in failure).
// onText(piece) gets each agent message text; onTool({ id, title, kind, status, rawInput, locations, content }) gets a call when it
// starts and the same fields (those the update carries) plus text when it is updated; onPermission(toolCall) resolves true to allow
// the call, false to refuse it. The permission's toolCall may carry only its id, so the caller joins it with the earlier call (lib/cursor.mjs).
// handshakeMs is the time the initialize and session/new replies may take together (30 seconds by default).
export async function runAcp({ command, args = [], cwd, prompt, signal, onText, onTool, onPermission, label = command, handshakeMs = HANDSHAKE_MS, platform, source, spawner, mcpServers = [] }) {
  if (signal?.aborted) return { stopReason: 'cancelled' };
  const launch = await resolveLaunch(command, args, platform);
  if (!launch) throw new Error(`${label} is not on PATH.`);
  const child = startChild(command, launch, { cwd, stdio: ['pipe', 'pipe', 'pipe'], platform, source, spawner });
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const tail = () => stripAnsi(stderr).trim().slice(-1500);

  const pending = new Map(); // our request id -> { resolve, reject }
  let nextId = 1;
  let sessionId = null;
  let aborted = false;
  let cancelTimer = null;
  let exitTimer = null;
  let exited = null; // { code } once the agent has exited

  const send = msg => { try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* the agent has gone; its exit ends the run */ } };
  const exitedError = code => new Error(`${label} stopped before it replied${code == null ? '' : ` (exit code ${code})`}${tail() ? `:\n${tail()}` : '.'}`);
  const request = (method, params) => new Promise((resolve, reject) => {
    // A request sent after the agent has exited would wait for an exit that has already come, so it is refused here.
    if (exited) return reject(exitedError(exited.code));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const rejectAll = err => {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.reject(err);
    }
  };

  // session/update notifications. Anything else in them is ignored.
  const onUpdate = params => {
    const update = isObject(params) ? params.update : null;
    if (!isObject(update)) return;
    const id = textString(update.toolCallId);
    if (update.sessionUpdate === 'agent_message_chunk') {
      const piece = textOf(update.content);
      if (piece) onText?.(piece);
    } else if (update.sessionUpdate === 'tool_call' && id) {
      onTool?.({ id, title: textString(update.title), kind: textString(update.kind), status: 'running', ...callFields(update) });
    } else if (update.sessionUpdate === 'tool_call_update' && id) {
      onTool?.({ id, status: textString(update.status), text: toolText(update.content), ...callFields(update) });
    }
  };

  // session/request_permission: the first option of the kind asked for, or a refusal. Only a refusal is sent when no option of
  // the wanted kind exists, and cancelled when there is no refusal option either.
  const answerPermission = async msg => {
    const params = isObject(msg.params) ? msg.params : {};
    const toolCall = isObject(params.toolCall) ? params.toolCall : isObject(params.tool_call) ? params.tool_call : {};
    const options = Array.isArray(params.options) ? params.options.filter(o => isObject(o) && typeof o.optionId === 'string') : [];
    let allowed = false;
    try {
      allowed = onPermission ? (await onPermission(toolCall)) === true : false;
    } catch {
      allowed = false;
    }
    const pick = prefix => options.find(o => textString(o.kind).startsWith(prefix));
    const chosen = (allowed ? pick('allow') : null) ?? pick('reject');
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } },
    });
  };

  const handle = line => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON: skipped
    }
    if (!isObject(msg)) return;
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === 'string') {
      if (!hasId) {
        if (msg.method === 'session/update') {
          try {
            onUpdate(msg.params);
          } catch {
            // A shape that is not read is skipped.
          }
        }
        return;
      }
      if (msg.method === 'session/request_permission') {
        answerPermission(msg).catch(() => send({ jsonrpc: '2.0', id: msg.id, error: { code: INTERNAL_ERROR, message: 'Plenum could not answer this request.' } }));
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: `Plenum does not offer ${msg.method}.` } });
      }
      return;
    }
    if (!hasId || !pending.has(msg.id)) return;
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (isObject(msg.error)) {
      waiter.reject(new Error(`${label} stopped with an error: ${clip(textString(msg.error.message) || 'unknown error', 400)}`));
    } else {
      waiter.resolve(isObject(msg.result) ? msg.result : {});
    }
  };

  // A callback of the caller that throws must not end the process that reads this stream, so its error is contained here.
  const handleSafely = line => {
    try {
      handle(line);
    } catch {
      // The line is left as it is; the run goes on.
    }
  };

  // Output lines. A line over MAX_LINE is dropped, and so is the rest of it up to its end.
  let buf = '';
  let dropping = false;
  child.stdout.on('data', chunk => {
    let rest = chunk;
    for (;;) {
      const nl = rest.indexOf('\n');
      if (nl < 0) break;
      const head = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (dropping) {
        dropping = false;
        buf = '';
        continue;
      }
      const line = buf + head;
      buf = '';
      if (line.length <= MAX_LINE) handleSafely(line);
    }
    if (dropping) return;
    buf += rest;
    if (buf.length > MAX_LINE) {
      buf = '';
      dropping = true;
    }
  });
  child.stdout.on('end', () => {
    if (!dropping && buf.length && buf.length <= MAX_LINE) handleSafely(buf);
    buf = '';
  });

  // The agent's exit ends every request still waiting, after a short grace for output still in the pipe.
  child.once('exit', code => {
    exited = { code };
    exitTimer = setTimeout(() => rejectAll(exitedError(code)), EXIT_GRACE_MS);
  });
  child.once('error', err => rejectAll(err));

  const onAbort = () => {
    aborted = true;
    if (!sessionId) {
      killTree(child);
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    // The agent should answer the prompt with a cancelled stop reason. If it does not end soon, its process is ended.
    cancelTimer = setTimeout(() => killTree(child), CANCEL_GRACE_MS);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const within = (promise, ms, message) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
      .finally(() => clearTimeout(timer));
  };

  try {
    const handshake = (async () => {
      await request('initialize', { protocolVersion: ACP_VERSION, clientCapabilities: CLIENT_CAPABILITIES });
      const created = await request('session/new', { cwd, mcpServers });
      if (!isObject(created) || typeof created.sessionId !== 'string' || !created.sessionId) {
        throw new Error(`${label} did not start a session.`);
      }
      sessionId = created.sessionId;
    })();
    await within(handshake, handshakeMs, `${label} did not start a session within ${Math.round(handshakeMs / 1000)} seconds, so the run was stopped.`);
    if (aborted) return { stopReason: 'cancelled' };
    const reply = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
    return { stopReason: textString(reply.stopReason) || 'end_turn' };
  } catch (err) {
    if (aborted) return { stopReason: 'cancelled' };
    throw err;
  } finally {
    clearTimeout(cancelTimer);
    clearTimeout(exitTimer);
    signal?.removeEventListener('abort', onAbort);
    child.stdout.destroy();
    child.stderr.destroy();
    killTree(child);
    // The run returns only once the agent has gone, so its working folder (a read-only run's scratch folder) can be removed.
    await exitWithin(child, EXIT_WAIT_MS);
  }
}

// Resolves when the child has exited, or after ms, whichever comes first.
function exitWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
