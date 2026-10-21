// Undo for /clear, /compact and Edit. Before a chat is cleared or compacted, or cut back by an Edit, the server keeps the
// messages it is about to remove, one entry per project, so POST /api/chat/restore can put them back. The entry lives in
// state.json (through store.persist), so it survives a restart. It is never sent to a provider, and the page sees only the
// summary from peekArchive.
import { createHash } from 'node:crypto';
import * as store from './store.mjs';

const MAX_ARCHIVED = 300;
const REASONS = new Set(['clear', 'compact', 'rewind']);

// Keeps the messages a clear, compact or Edit is about to remove. The newest entry replaces the older one for the project.
// An empty chat keeps nothing, so an earlier entry is not replaced by an empty one. An Edit also passes the messages that
// stayed, so Undo can tell whether the chat has moved on since the cut.
export function keepArchive(projectId, messages, reason, stayed = []) {
  if (!REASONS.has(reason)) throw new Error(`Unknown archive reason: ${reason}`);
  if (!messages.length) return;
  const archives = (store.get().archives ??= {});
  const entry = { at: Date.now(), reason, messages: messages.slice(-MAX_ARCHIVED) };
  // An Edit keeps how many messages stayed and a fingerprint of them. The messages that stayed are already in the chat.
  if (reason === 'rewind') Object.assign(entry, { stayed: stayed.length, stayedHash: fingerprint(stayed) });
  archives[projectId] = entry;
}

// What the page needs to show the Undo line: when, why and how many messages. The messages themselves are not included.
// After an Edit it also says how many messages stayed: the line shows only while the chat still has exactly those.
export function peekArchive(projectId) {
  const entry = validEntry(projectId);
  if (!entry) return null;
  const peek = { at: entry.at, reason: entry.reason, count: entry.messages.length };
  if (entry.reason === 'rewind') peek.stayed = entry.stayed;
  return peek;
}

// Returns the kept entry and removes it from the store, or null when there is none.
export function takeArchive(projectId) {
  const entry = validEntry(projectId);
  if (entry) delete store.get().archives[projectId];
  return entry;
}

// Drops the kept entry for a project, if there is one.
export function clearArchive(projectId) {
  const archives = store.get().archives;
  if (archives) delete archives[projectId];
}

// True when the live chat is still the one an Edit left: the same messages that stayed, in the same order. Undo puts the
// removed messages back only then, so a chat that was sent to since is never joined to the old ones.
export function rewindFits(projectId, live) {
  const entry = validEntry(projectId);
  return entry?.reason === 'rewind' && live.length === entry.stayed && fingerprint(live) === entry.stayedHash;
}

// The stored entry for a project, when it has the shape keepArchive writes. A hand-edited state.json with anything else
// is treated as no entry, so a bad record cannot crash the page or the restore.
function validEntry(projectId) {
  const entry = store.get().archives?.[projectId];
  if (!entry || !Array.isArray(entry.messages)) return null;
  if (entry.reason === 'rewind' && (!Number.isInteger(entry.stayed) || typeof entry.stayedHash !== 'string')) return null;
  return entry;
}

// A SHA-256 of the messages as state.json saves them. Undo checks the chat against it after an Edit; it is never shown.
function fingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}
