// Undo for /clear, /compact and Edit: put the kept chat back, or drop it. Before a chat is cleared or compacted, or cut back by an
// Edit, the server keeps the messages it is about to remove, so POST /api/chat/restore can put them back. The entry lives in
// state.json (through store.persist), so it survives a restart. It is never sent to a provider, and the page sees only the
// summary from peekArchive.
//
// Each project has the entry on offer, the newest one. A newer cut does not discard it: when an Edit is followed by a /clear
// before Undo, the Edit's entry waits behind the /clear's in the `older` list (up to MAX_KEPT in all). Undo puts the newest
// back, and once the chat is the one the older entry was cut from, that entry is on offer again. Nothing is dropped silently
// until MAX_KEPT cuts have piled up without an Undo.
import { createHash } from 'node:crypto';
import * as store from './store.mjs';

const MAX_ARCHIVED = 300;
// The entry on offer and up to four older ones behind it.
const MAX_KEPT = 5;
const REASONS = new Set(['clear', 'compact', 'rewind']);

// Keeps the messages a clear, compact or Edit is about to remove. The new entry goes on offer, and the entry that was on offer
// before it waits behind it. An empty chat keeps nothing, so an earlier entry is not pushed back by an empty one. An Edit also
// passes the messages that stayed, so Undo can tell whether the chat has moved on since the cut.
export function keepArchive(projectId, messages, reason, stayed = []) {
  if (!REASONS.has(reason)) throw new Error(`Unknown archive reason: ${reason}`);
  if (!messages.length) return;
  const archives = (store.get().archives ??= {});
  const entry = { at: Date.now(), reason, messages: messages.slice(-MAX_ARCHIVED) };
  // An Edit keeps how many messages stayed and a fingerprint of them. The messages that stayed are already in the chat.
  if (reason === 'rewind') Object.assign(entry, { stayed: stayed.length, stayedHash: fingerprint(stayed) });
  const onOffer = validEntry(projectId);
  const older = onOffer ? [plain(onOffer), ...onOffer.older].slice(0, MAX_KEPT - 1) : [];
  if (older.length) entry.older = older;
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

// Returns the entry on offer and removes it from the store, or null when there is none. The entry behind it, if any, is on
// offer from then on.
export function takeArchive(projectId) {
  const entry = validEntry(projectId);
  if (!entry) return null;
  const { older, ...top } = entry;
  const archives = store.get().archives;
  const [next, ...rest] = older;
  if (next) archives[projectId] = rest.length ? { ...next, older: rest } : next;
  else delete archives[projectId];
  return top;
}

// Drops every kept entry for a project: the one on offer and the ones behind it. Harmless when there is none.
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

// The stored entry on offer for a project, with its older entries checked as well, or null. A hand-edited state.json with
// anything else is treated as no entry, so a bad record cannot crash the page or the restore.
function validEntry(projectId) {
  const raw = store.get().archives?.[projectId];
  if (!shapeOk(raw)) return null;
  const older = Array.isArray(raw.older) ? raw.older.filter(shapeOk).map(plain).slice(0, MAX_KEPT - 1) : [];
  return { ...raw, older };
}

// Whether a stored entry has the shape keepArchive writes.
function shapeOk(entry) {
  if (!entry || typeof entry !== 'object' || !REASONS.has(entry.reason) || !Array.isArray(entry.messages)) return false;
  if (entry.reason === 'rewind' && (!Number.isInteger(entry.stayed) || typeof entry.stayedHash !== 'string')) return false;
  return true;
}

// An entry without the list of older entries behind it.
function plain({ older, ...entry }) {
  return entry;
}

// A SHA-256 of the messages as state.json saves them. Undo checks the chat against it after an Edit; it is never shown.
function fingerprint(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}
