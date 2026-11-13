// The auto-compact limit of each model (lib/compact-limits.mjs, DECISIONS item 86), for the Auto-compact section of Settings > Roles.
//   GET  /api/compact-limits                      -> the limits, the models in use and what a limit means for each
//   GET  /api/compact-limits?ref=<model>          -> the same description of one model, in use or not ("Add another model")
//   POST /api/compact-limits { ref, value }       -> sets one model's limit (whole tokens from 10,000 to the model's window, 'off', or
//                                                    null to take it off); answers as the first GET does
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { COMPACT_RANGE, UNPUBLISHED_MAX, cleanLimits, cliKnob, limitOf, maxOf, roomOf, suggestedOf, windowOf, withLimit } from '../compact-limits.mjs';
import { labelFor, parseRef } from '../providers.mjs';
import { claudeRoute } from '../claude-cli.mjs';
import { sessionEnabled } from '../sessions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLI_PROVIDERS = new Set(['muse', 'codex', 'gemini', 'cursor', 'grok', 'antigravity', 'echo']);
const HAIKU = 'anthropic:claude-haiku-5-5';

// Every model the app or a project uses now, in a stable order: the chat models, the advisor, the council seats and moderators, the agent
// types' models, and any model that already has a limit. Values that are not model refs are skipped.
function modelsInUse(st) {
  const seen = new Set();
  const add = ref => {
    if (typeof ref === 'string' && ref.includes(':') && !seen.has(ref)) seen.add(ref);
  };
  const council = c => {
    for (const s of Array.isArray(c?.seats) ? c.seats : []) add(s?.ref);
    add(c?.moderator?.ref);
  };
  const agents = a => {
    for (const t of Array.isArray(a?.types) ? a.types : []) add(t?.model);
  };
  add(st.model);
  add(st.advisor);
  council(st.council);
  agents(st.agents);
  for (const p of Array.isArray(st.projects) ? st.projects : []) {
    add(p?.settings?.model);
    council(p?.settings?.council);
    agents(p?.settings?.agents);
  }
  for (const entry of Object.values(isObject(st.threads) ? st.threads : {})) {
    for (const t of Array.isArray(entry?.list) ? entry.list : []) add(t?.model);
  }
  // The shipped agent types run on Claude Haiku 5.5 unless they were given another model.
  add(HAIKU);
  for (const ref of Object.keys(cleanLimits(st.compactAt))) add(ref);
  return [...seen];
}

// What one model's limit is and means: its value, its window (and whether it is published), the top of its dial, the value a new limit
// starts from, what a chat turn of it is sent (lib/compact-limits.mjs roomOf), and which CLI is told the limit itself.
function describeModel(ref, st, route) {
  const provider = ref.split(':')[0];
  const cli = CLI_PROVIDERS.has(provider) || (provider === 'anthropic' && route !== 'api');
  const native = cli && sessionEnabled(ref, st);
  const win = windowOf(ref);
  // Claude Code is told the limit only when Claude runs through its CLI; through an API key there is no Claude Code process.
  const knob = cliKnob(ref) === 'claude' && provider === 'anthropic' && route === 'api' ? null : cliKnob(ref);
  let label = ref;
  try {
    label = labelFor(ref);
  } catch {
    // The ref itself is shown.
  }
  const max = maxOf(ref);
  return {
    ref,
    label,
    value: limitOf(ref, st),
    window: win.tokens,
    published: win.published,
    max,
    // Where Limit starts when the model had none (lib/compact-limits.mjs suggestedOf).
    suggested: suggestedOf(ref),
    room: roomOf(ref, { cli, native }),
    knob,
  };
}

async function describe(st) {
  const route = await claudeRoute().catch(() => 'cli');
  const limits = cleanLimits(st.compactAt);
  const models = modelsInUse(st).map(ref => describeModel(ref, st, route));
  return { range: COMPACT_RANGE, unpublishedMax: UNPUBLISHED_MAX, claudeRoute: route, limits, models };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/compact-limits',
    handler: async ({ req, res, url, json, httpError, store }) => {
      requireToken(req, httpError);
      const asked = url?.searchParams?.get('ref');
      if (asked !== null && asked !== undefined) {
        let ref;
        try {
          ref = parseRef(asked);
        } catch (err) {
          throw httpError(400, err.message);
        }
        const route = await claudeRoute().catch(() => 'cli');
        return json(res, 200, { range: COMPACT_RANGE, model: describeModel(ref, store.get(), route) });
      }
      return json(res, 200, await describe(store.get()));
    },
  },
  {
    method: 'POST',
    path: '/api/compact-limits',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the model and its limit, for example {"ref": "anthropic:claude-opus-5-5", "value": 150000}.');
      if (!Object.hasOwn(body, 'value')) throw httpError(400, 'Send value: whole tokens from 10,000 to the model\'s window, "off", or null to use the model\'s own default.');
      const st = store.get();
      let next;
      try {
        next = withLimit(st.compactAt, { ref: body.ref, value: body.value }, ref => parseRef(ref));
      } catch (err) {
        throw httpError(400, err.message);
      }
      // Checked first and changed only when the value passed, so a refused save leaves the limits as they were.
      st.compactAt = next;
      await store.saveOrFail();
      return json(res, 200, await describe(st));
    },
  },
];
