'use strict';
// Loads the desktop handler modules from desktop/handlers/ and routes the server's messages and the shell's events to them.
// This file imports nothing from Electron, so its tests run without the app. desktop/main.cjs is its only caller.
//
// A handler module is a file in desktop/handlers/ whose name matches /^[a-z0-9-]+\.cjs$/. It exports:
//   { name?, messages?: { [type]: async (message, shell) => reply | undefined },
//     hooks?: { ready?(shell), windowCreated?(shell, win), serverStarted?(shell, child), serverExited?(shell, code),
//               state?(shell, st), beforeQuit?(shell) } }
// A reply with a string `type` is posted as it is. Any other object is posted as { type: `${message.type}-result`, id, ...reply },
// so a handler can answer with just its fields. A message with no reply is answered with nothing.
// Nothing here logs a message body: keys travel in the messages, so a log line names a type and a file, and no more.

const fs = require('node:fs');
const path = require('node:path');

const MODULE_NAME = /^[a-z0-9-]+\.cjs$/;
// The hooks a handler may export, in the order the shell calls them.
const HOOKS = ['ready', 'windowCreated', 'serverStarted', 'serverExited', 'state', 'beforeQuit'];
// The answer to a request whose handler threw. It says nothing about why.
const FAILED = 'The desktop app could not handle this request.';

// A text that fits on one log line.
function oneLine(text, max = 300) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
}

// The text of an error, with every string value of the message removed from it (except its type and id), so a key that an error
// happens to quote never reaches the log.
function errorText(err, message) {
  let text = oneLine(err?.message ?? err);
  if (message && typeof message === 'object') {
    for (const [name, value] of Object.entries(message)) {
      if (name === 'type' || name === 'id' || typeof value !== 'string' || value.length < 4) continue;
      text = text.split(value).join('[removed]');
    }
  }
  return text;
}

// An empty registry: no messages, no hooks, and no unknown type reported yet.
function emptyRegistry() {
  return { messages: new Map(), hooks: [], reported: new Set() };
}

// Reads the handler modules in dir, in file name order. A module that throws while it loads is logged ('handler <file> failed to
// load: <message>') and skipped; nothing else stops. When two modules handle one type, the first in file order is kept.
// `load` defaults to require, and tests pass their own.
function loadHandlers({ dir, log = () => {}, load = file => require(file) } = {}) {
  const registry = emptyRegistry();
  let files;
  try {
    files = fs.readdirSync(dir).filter(name => MODULE_NAME.test(name)).sort();
  } catch (err) {
    log(`desktop handlers folder could not be read: ${errorText(err)}`);
    return registry;
  }
  for (const file of files) {
    let mod;
    try {
      mod = load(path.join(dir, file));
    } catch (err) {
      log(`handler ${file} failed to load: ${errorText(err)}`);
      continue;
    }
    if (!mod || typeof mod !== 'object') {
      log(`handler ${file} failed to load: it exports no object`);
      continue;
    }
    const messages = mod.messages && typeof mod.messages === 'object' ? mod.messages : {};
    for (const [type, fn] of Object.entries(messages)) {
      if (typeof fn !== 'function') {
        log(`handler ${file} has no function for ${oneLine(type, 60)}`);
        continue;
      }
      if (registry.messages.has(type)) {
        log(`handler ${file} also handles ${oneLine(type, 60)}; the earlier handler is kept`);
        continue;
      }
      registry.messages.set(type, fn);
    }
    const hooks = mod.hooks && typeof mod.hooks === 'object' ? mod.hooks : {};
    for (const hook of HOOKS) {
      if (typeof hooks[hook] === 'function') registry.hooks.push({ file, hook, fn: hooks[hook] });
    }
  }
  return registry;
}

// Calls every hook with this name, in file order, with the given arguments. A hook that throws, or whose promise rejects, is logged
// ('hook <name> in <file> failed: <message>') and skipped; the rest still run.
function runHooks(registry, hook, args, { log = () => {} } = {}) {
  for (const entry of registry.hooks) {
    if (entry.hook !== hook) continue;
    const failed = err => log(`hook ${hook} in ${entry.file} failed: ${errorText(err)}`);
    try {
      const out = entry.fn(...args);
      if (out && typeof out.then === 'function') out.then(undefined, failed);
    } catch (err) {
      failed(err);
    }
  }
}

// Answers one message from the server. The handler is found by type. A type with no handler is logged once and answered with nothing.
// `post` sends a reply to the server. A handler that throws is answered with a refusal, and its error is logged without the message.
async function handleMessage(registry, message, shell, { post, log = () => {} } = {}) {
  const type = message.type;
  const fn = registry.messages.get(type);
  if (!fn) {
    if (!registry.reported.has(type)) {
      registry.reported.add(type);
      log(`no desktop handler for ${oneLine(type, 60)}`);
    }
    return;
  }
  let reply;
  try {
    reply = await fn(message, shell);
  } catch (err) {
    log(`handler for ${oneLine(type, 60)} failed: ${errorText(err, message)}`);
    post({ type: `${type}-result`, id: message.id, ok: false, message: FAILED });
    return;
  }
  if (!reply || typeof reply !== 'object') return;
  if (typeof reply.type === 'string') post(reply);
  else post({ type: `${type}-result`, id: message.id, ...reply });
}

module.exports = { loadHandlers, runHooks, handleMessage, errorText, emptyRegistry, HOOKS, FAILED };
