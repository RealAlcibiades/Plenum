// The models the Codex CLI offers this account, so the model menu lists them beside "Codex (CLI default model)".
//
// They are read from Codex's own app server with model/list, the request Codex's own picker uses. It returns the account's model
// list (including any model_catalog_json in ~/.codex/config.toml) and runs no model, so it costs nothing. Plenum starts the app
// server only after the License Agreement is accepted (the caller checks), at most once every 30 minutes, and never while another
// read is in flight. A failed read keeps the last good list and is tried again after 2 minutes. Models Codex marks hidden are left
// out, as its own picker leaves them out; any of them can still be named with /model codex:<id>.
import { codexRpc } from './usage.mjs';
import { setCodexModels } from './providers.mjs';

export const FRESH_MS = 30 * 60_000;
export const RETRY_MS = 2 * 60_000;
const MAX_PAGES = 5;
const MAX_MODELS = 60;
const ID = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,119}$/;
// Control characters and the marks the menu splits a label on are left out of a name Codex sent.
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

let last = { at: 0, ok: false, count: 0, error: null };
let inflight = null;

// model/list items to catalog entries: { id, label }. The id is the model the CLI's -m takes (item.model, else item.id).
export function toEntries(items) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || item.hidden === true) continue;
    const id = typeof item.model === 'string' && item.model ? item.model : item.id;
    if (typeof id !== 'string' || !ID.test(id) || id.toLowerCase() === 'default' || seen.has(id)) continue;
    seen.add(id);
    const name = cleanName(item.displayName) || id;
    out.push({ id, label: `${name} (Codex${item.isDefault === true ? ', your CLI default' : ''})` });
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

async function readAll(rpc) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc('model/list', 20_000, cursor ? { cursor, includeHidden: false } : { includeHidden: false });
    if (!result || !Array.isArray(result.data)) throw new Error('Codex sent no model list.');
    items.push(...result.data);
    cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    if (!cursor) break;
  }
  return items;
}

// Reads the list again when it is stale (or when force is set) and puts it into the catalog. Resolves to the state below, never throws.
export function refreshCodexModels({ force = false, rpc = codexRpc, now = Date.now } = {}) {
  if (inflight) return inflight;
  const age = now() - last.at;
  if (!force && last.at && age < (last.ok ? FRESH_MS : RETRY_MS)) return Promise.resolve(codexModelsState());
  inflight = (async () => {
    try {
      const entries = toEntries(await readAll(rpc));
      // An empty answer keeps the last good list: Codex answering with nothing is more likely a hiccup than an account with no models.
      if (entries.length) setCodexModels(entries);
      last = { at: now(), ok: true, count: entries.length || last.count, error: null };
    } catch (err) {
      last = { at: now(), ok: false, count: last.count, error: String(err?.message ?? err).split('\n')[0].slice(0, 200) };
    } finally {
      inflight = null;
    }
    return codexModelsState();
  })();
  return inflight;
}

// Waits for a read in flight (or starts one when stale) for at most waitMs, so the first menu can include the list without a slow
// Codex holding it up.
export async function codexModelsWithin(waitMs, opts) {
  const run = refreshCodexModels(opts);
  let timer;
  await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  return codexModelsState();
}

export const codexModelsState = () => ({ ...last, reading: !!inflight });

// For tests: forget the last read and take the discovered models out of the catalog.
export function resetCodexModels() {
  last = { at: 0, ok: false, count: 0, error: null };
  inflight = null;
  setCodexModels([]);
}
