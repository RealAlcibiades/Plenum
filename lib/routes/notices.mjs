// The danger notices: the list with what this person has hidden, and the three ways to change that. The words and the rules are in
// lib/notices.mjs and the strips and dialogs are drawn by public/ext-notices.js. A notice never turns a safety check off, so nothing
// here touches an approval, a block or a mode. Each POST saves the state and answers the new list.
//
//   GET  /api/notices            -> { notices: [{ id, rev, kind, status, feature, where, title, text, action?, tone, aliases?,
//                                                 hidden, hiddenAt, updated }] }
//   POST /api/notices/hide       { id }  -> the same list (Don't show again; 400 'Unknown notice.' for an id that is not in it)
//   POST /api/notices/show       { id }  -> the same list (Show again)
//   POST /api/notices/show-all   {}      -> the same list (Show all again)
// An alias (for example 'apply-update' for 'self-update') is accepted in place of the id.
import { hideNotice, noticeState, showAllNotices, showNotice } from '../notices.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const routes = [
  { method: 'GET', path: '/api/notices', handler: listRoute },
  { method: 'POST', path: '/api/notices/hide', handler: hideRoute },
  { method: 'POST', path: '/api/notices/show', handler: showRoute },
  { method: 'POST', path: '/api/notices/show-all', handler: showAllRoute },
];

async function listRoute({ res, json, store }) {
  return json(res, 200, { notices: noticeState(store.get()) });
}

// Applies `change` to the state, saves it, and answers the list. A save that fails puts the old record back, so the screen and the
// file agree.
async function change({ res, json, store }, apply) {
  const st = store.get();
  const before = st.notices;
  const copy = isObject(before) ? { ...before } : undefined;
  apply(st);
  try {
    await store.saveOrFail();
  } catch (err) {
    if (copy === undefined) delete st.notices;
    else st.notices = copy;
    throw err;
  }
  return json(res, 200, { notices: noticeState(st) });
}

async function idOf({ req, readBody, httpError }) {
  const body = await readBody(req);
  if (!isObject(body)) throw httpError(400, 'Send the id of the notice.');
  return body.id;
}

async function hideRoute(ctx) {
  const id = await idOf(ctx);
  return change(ctx, st => hideNotice(st, id));
}

async function showRoute(ctx) {
  const id = await idOf(ctx);
  return change(ctx, st => showNotice(st, id));
}

async function showAllRoute(ctx) {
  await ctx.readBody(ctx.req);
  return change(ctx, st => showAllNotices(st));
}
