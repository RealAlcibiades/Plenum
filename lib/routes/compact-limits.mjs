// The auto-compact limit of each model (lib/compact-limits.mjs, DECISIONS item 86), for the Auto-compact section of Settings > Roles.
//   GET  /api/compact-limits                      -> the limits, the models in use and what a limit means for each
//   POST /api/compact-limits { ref, value }       -> sets one model's limit (a percent from 20 to 95, 'off', or null to take it off);
//                                                    answers as GET does
// The server checks the Plenum token on every /api/ request before a route runs; requireToken checks it here as well.
import { requireToken } from '../auth.mjs';
import { COMPACT_RANGE, FALLBACK_WINDOW, cleanLimits, cliKnob, codexCompactTokens, limitOf, roomOf, windowOf, withLimit } from '../compact-limits.mjs';
import { labelFor, parseRef } from '../providers.mjs';
import { claudeRoute } from '../claude-cli.mjs';
import { sessionEnabled } from '../sessions.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const CLI_PROVIDERS = new Set(['muse', 'codex', 'gemini', 'cursor', 'grok', 'echo']);
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

async function describe(st) {
  const route = await claudeRoute().catch(() => 'cli');
  const limits = cleanLimits(st.compactAt);
  const models = modelsInUse(st).map(ref => {
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
    return {
      ref,
      label,
      value: limitOf(ref, st),
      window: win.tokens,
      published: win.published,
      room: roomOf(ref, { cli, native }),
      knob,
      // The token count Codex is told, when it is told one.
      codexTokens: knob === 'codex' ? codexCompactTokens(ref, st) : null,
    };
  });
  return { range: COMPACT_RANGE, fallbackWindow: FALLBACK_WINDOW, claudeRoute: route, limits, models };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/compact-limits',
    handler: async ({ req, res, json, httpError, store }) => {
      requireToken(req, httpError);
      return json(res, 200, await describe(store.get()));
    },
  },
  {
    method: 'POST',
    path: '/api/compact-limits',
    handler: async ({ req, res, json, readBody, httpError, store }) => {
      requireToken(req, httpError);
      const body = await readBody(req);
      if (!isObject(body)) throw httpError(400, 'Send an object with the model and its limit, for example {"ref": "anthropic:claude-opus-5-5", "value": 80}.');
      if (!Object.hasOwn(body, 'value')) throw httpError(400, 'Send value: a percent from 20 to 95, "off", or null to use the model\'s own default.');
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
