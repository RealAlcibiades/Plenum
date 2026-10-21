// Per-project settings: the model, effort, approvals, council, relay and CLI tool options a project sets for itself.
// Each one is null when the project inherits the app's value, so changing the app later still reaches the project.
// The exceptions are denyPatterns (extra command patterns the project adds to the built-in deny list), chatMode
// ('normal' or 'plan', where plan makes the project's chat read-only) and budget (the spend warning and cap for API-key
// models, lib/budget.mjs). None of them has an inherited value.
// Owned by the projects builder. The routes are in lib/routes/projects.mjs.
import { CATALOG, ALIASES, EFFORTS } from './providers.mjs';
import { normalizeCouncil } from './council.mjs';
import { MAX_DENY_PATTERNS, MAX_DENY_PATTERN_LENGTH, normalizeDenyPatterns } from './denylist.mjs';
import { claude, codex, gemini, muse } from './cli-options/index.mjs';
import { normalize as normalizeClaude } from './cli-options/claude.mjs';
import { normalize as normalizeCodex } from './cli-options/codex.mjs';
import { normalize as normalizeGemini } from './cli-options/gemini.mjs';
import { normalize as normalizeMuse } from './cli-options/muse.mjs';

// Same values as RELAY_DEFAULT in server.mjs and in lib/store.mjs. Keep them in step.
const RELAY_DEFAULT = { autoRoute: false, countdownSec: 3, hops: null, stopOnError: true, dedupe: false };
// What the app uses when it has no value of its own: the Effort selector shows high, and normalizeEffort falls back to high.
const DEFAULT_EFFORT = 'high';
const DEFAULT_APPROVALS = 'ask';
const EFFORT_HELP = `Effort must be one of: ${EFFORTS.join(', ')}, or empty to use the app's effort.`;
const APPROVALS_HELP = 'Approvals must be ask or auto, or empty to use the app\'s setting.';
const MODEL_HELP = 'Use a model name from /models, such as opus, muse-spark-1.3 or codex:default, or leave it empty to use the app\'s model.';
const RELAY_FLAGS = ['autoRoute', 'stopOnError', 'dedupe'];
// A project's chat mode. In 'plan' every chat turn is read-only: server.mjs gives streamChat readOnly and no tool context.
const CHAT_MODES = ['normal', 'plan'];
const CHAT_MODE_HELP = `Chat mode must be one of: ${CHAT_MODES.join(', ')}.`;
// The spend limit in dollars: a warning and a cap for API-key models, each at most this much and kept to cents.
const BUDGET_MAX_USD = 10000;

// One entry per CLI: `normalize` is from lib/cli-options/<cli>.mjs, and `options` is what the settings panel shows.
const TOOL_CLIS = [
  { key: 'claude', label: 'Claude Code', normalize: normalizeClaude, options: claude },
  { key: 'codex', label: 'Codex', normalize: normalizeCodex, options: codex },
  { key: 'gemini', label: 'Gemini', normalize: normalizeGemini, options: gemini },
  { key: 'muse', label: 'Muse Code', normalize: normalizeMuse, options: muse },
];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// A value the project has not set. An empty string from a form counts as unset too.
const isUnset = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// The option lists for the settings panels, grouped per CLI with the label each panel heading uses.
export function TOOL_OPTIONS() {
  const out = {};
  for (const cli of TOOL_CLIS) out[cli.key] = { label: cli.label, options: cli.options };
  return out;
}

// Turns a model name into a provider:id ref that is in CATALOG. Accepts the full ref, an alias or a bare id.
function modelRef(raw) {
  const text = raw.trim().toLowerCase();
  const exact = CATALOG.find(c => `${c.provider}:${c.id}` === text);
  if (exact) return `${exact.provider}:${exact.id}`;
  // Object.hasOwn: a plain lookup would find "constructor" or "toString" on Object.prototype and accept them.
  if (Object.hasOwn(ALIASES, text)) return ALIASES[text];
  // A bare id is taken only when one catalog entry has it. "default" is shared by Codex and Gemini, so it must be written with its provider.
  const bare = CATALOG.filter(c => c.id === text);
  if (bare.length > 1) {
    throw new Error(`"${raw.trim()}" is in more than one provider. Write the provider too: ${bare.map(c => `${c.provider}:${c.id}`).join(' or ')}.`);
  }
  if (bare.length === 1) return `${bare[0].provider}:${bare[0].id}`;
  throw new Error(`"${raw.trim()}" is not a model Plenum knows. ${MODEL_HELP}`);
}

function checkModel(raw) {
  if (isUnset(raw)) return null;
  if (typeof raw !== 'string') throw new Error(MODEL_HELP);
  return modelRef(raw);
}

function checkEffort(raw) {
  if (isUnset(raw)) return null;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!EFFORTS.includes(v)) throw new Error(EFFORT_HELP);
  return v;
}

function checkApprovals(raw) {
  if (isUnset(raw)) return null;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v !== 'ask' && v !== 'auto') throw new Error(APPROVALS_HELP);
  return v;
}

// A council is checked by the council's own normalizer, so its messages and rules are the same everywhere.
function checkCouncil(raw) {
  if (isUnset(raw)) return null;
  return normalizeCouncil(raw);
}

// Same rules and messages as normalizeRelay in server.mjs. A missing key takes the default, not the app's
// current relay: a project keeps the values it was given, so a later change to the app still reaches it.
function checkRelay(raw) {
  if (isUnset(raw)) return null;
  if (!isObject(raw)) throw new Error('The relay settings must be an object with autoRoute, countdownSec, hops, stopOnError and dedupe.');
  const r = { ...RELAY_DEFAULT };
  for (const key of Object.keys(RELAY_DEFAULT)) {
    if (raw[key] !== undefined) r[key] = raw[key];
  }
  // A numeric string is accepted for the countdown, as the server accepts it. An empty string or null is refused here,
  // where the server would read them as 0.
  const countdownSec = typeof r.countdownSec === 'string' && r.countdownSec.trim() !== '' ? Number(r.countdownSec) : r.countdownSec;
  if (!Number.isInteger(countdownSec) || countdownSec < 0 || countdownSec > 10) {
    throw new Error('The countdown must be a whole number from 0 to 10 seconds.');
  }
  if (r.hops !== null && (!Number.isInteger(r.hops) || r.hops < 1 || r.hops > 50)) {
    throw new Error('The hop limit must be empty (no limit) or a whole number from 1 to 50.');
  }
  for (const key of RELAY_FLAGS) {
    if (typeof r[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
  }
  return { autoRoute: r.autoRoute, countdownSec, hops: r.hops, stopOnError: r.stopOnError, dedupe: r.dedupe };
}

// One dollar amount of the spend limit. Empty is no limit (null). Anything else must be a number above 0 and at most
// BUDGET_MAX_USD, rounded to cents, or the save is refused with a plain message.
function checkDollars(raw, label) {
  if (isUnset(raw)) return null;
  const cents = typeof raw === 'number' ? Math.round(raw * 100) / 100 : NaN;
  if (!(cents > 0 && cents <= BUDGET_MAX_USD)) {
    throw new Error(`The ${label} must be an amount in dollars above 0 and at most ${BUDGET_MAX_USD.toLocaleString('en-US')}.`);
  }
  return cents;
}

// The spend limit a project saves: { warnUsd, capUsd }, each a number or null. Both empty means no limit, and the key is
// then left out (as denyPatterns is), so settings saved before it existed keep their shape.
function checkSpendLimit(raw) {
  if (isUnset(raw)) return null;
  if (!isObject(raw)) throw new Error('The spend limit must be an object with warnUsd and capUsd.');
  const warnUsd = checkDollars(raw.warnUsd, 'warning');
  const capUsd = checkDollars(raw.capUsd, 'cap');
  if (warnUsd === null && capUsd === null) return null;
  if (warnUsd !== null && capUsd !== null && warnUsd > capUsd) throw new Error('The warning must be at or below the cap.');
  return { warnUsd, capUsd };
}

// 'normal' or 'plan'. A value left out (or null or empty) is 'normal'; anything else is refused with a plain message.
// The POST /api/project-mode route uses this too, after it has checked that a mode was sent at all.
export function normalizeChatMode(raw) {
  if (isUnset(raw)) return 'normal';
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!CHAT_MODES.includes(v)) throw new Error(CHAT_MODE_HELP);
  return v;
}

// Each CLI's own normalize checks its options. Unknown CLI keys are dropped. A CLI's error gets its name in front,
// because "Sandbox must be..." alone does not say which CLI it is about.
function checkTools(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObject(raw)) throw new Error('Tool settings must be an object with one entry for each CLI: claude, codex, gemini and muse.');
  const out = {};
  for (const cli of TOOL_CLIS) {
    const mine = raw[cli.key] ?? {};
    if (!isObject(mine)) throw new Error(`${cli.label} settings must be an object.`);
    try {
      out[cli.key] = cli.normalize(mine);
    } catch (err) {
      throw new Error(`${cli.label}: ${err.message}`);
    }
  }
  return out;
}

// Validates what a project saves and returns the full shape, with nulls for what the project inherits.
// Unknown keys are dropped. A bad value throws an Error with a plain message.
export function normalizeProjectSettings(input) {
  if (input === undefined || input === null) input = {};
  if (!isObject(input)) throw new Error('Project settings must be an object with model, effort, approvals, council, relay and tools.');
  const out = {
    model: checkModel(input.model),
    effort: checkEffort(input.effort),
    approvals: checkApprovals(input.approvals),
    council: checkCouncil(input.council),
    relay: checkRelay(input.relay),
    tools: checkTools(input.tools),
  };
  // Optional deny patterns: a list of at most 50 plain patterns of at most 120 characters, with no control characters,
  // checked by the deny list's own normalizer so its limits and messages are the same everywhere. They only add to the
  // built-in rules in lib/denylist.mjs. Only a project that has patterns carries the key, so settings saved before it
  // existed keep their shape.
  const denyPatterns = normalizeDenyPatterns(input.denyPatterns);
  if (denyPatterns.length > 0) out.denyPatterns = denyPatterns;
  // The spend limit for API-key models (lib/budget.mjs). Only a project that has one carries the key, as with denyPatterns.
  const budget = checkSpendLimit(input.budget);
  if (budget) out.budget = budget;
  // chatMode follows the same rule: only a project in plan mode carries the key, so normal settings keep their shape.
  if (normalizeChatMode(input.chatMode) === 'plan') out.chatMode = 'plan';
  return out;
}

// The chat mode a project runs in now: 'normal' or 'plan'. Read on its own, like denyPatternsOf, because plan mode is a
// protection: settings that no longer validate as a whole (read as unset everywhere else) must not turn it off. A value
// that is not recognised reads as 'plan', since the read-only side is the safe one.
export function chatModeOf(project) {
  const raw = project?.settings?.chatMode;
  if (isUnset(raw)) return 'normal';
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'normal' ? 'normal' : 'plan';
}

// The custom deny patterns a project saved, for checkCommand(commandLine, denyPatternsOf(project)). They are read on
// their own: settings that no longer validate as a whole (an option removed in a later version, say) read as unset
// everywhere else, but must not drop a project's protections. A list that fails its own check is kept as far as it can
// be (strings only, cut to the length limit), since a shorter pattern blocks more, never less.
export function denyPatternsOf(project) {
  const raw = project?.settings?.denyPatterns;
  try {
    return normalizeDenyPatterns(raw);
  } catch {
    if (!Array.isArray(raw)) return [];
    return raw.filter(p => typeof p === 'string' && p.trim() !== '').slice(0, MAX_DENY_PATTERNS).map(p => p.trim().slice(0, MAX_DENY_PATTERN_LENGTH));
  }
}

// The spend limit a project set, { warnUsd, capUsd }, read on its own like denyPatternsOf. Anything that is not a valid
// limit reads as no limit on both, so a bad stored value never changes what the other settings mean.
export function budgetOf(project) {
  try {
    return checkSpendLimit(project?.settings?.budget) ?? { warnUsd: null, capUsd: null };
  } catch {
    return { warnUsd: null, capUsd: null };
  }
}

// The app's own settings, with the defaults filled in where the app has no value yet, so the settings panel
// always shows what is actually in force.
export function globalSettings(appState) {
  const st = appState ?? {};
  return {
    model: st.model ?? null,
    effort: st.effort ?? DEFAULT_EFFORT,
    approvals: st.approvals ?? DEFAULT_APPROVALS,
    // normalizeCouncil(null) is the default council, with the seat ids and labels that the saved ones carry.
    council: st.council ?? normalizeCouncil(null),
    relay: st.relay ?? { ...RELAY_DEFAULT },
  };
}

// A project's saved settings, normalised, or null when it has none. A saved value that no longer validates
// (an option removed in a later version, say) is read as unset: the project then inherits the app's values, and
// the settings panel can still open and be saved again. Failing here would break every run in that project.
export function storedSettings(project) {
  if (!project || project.settings === undefined || project.settings === null) return null;
  try {
    return normalizeProjectSettings(project.settings);
  } catch {
    return null;
  }
}

// What a project uses right now: its own value wherever it has one, the app's value otherwise. A project with no
// settings gets empty tool objects; each CLI's argsFor runs normalize first, so an empty object means its defaults.
export function effectiveSettings(appState, project) {
  const app = globalSettings(appState);
  const own = storedSettings(project);
  return {
    model: own?.model ?? app.model,
    effort: own?.effort ?? app.effort,
    approvals: own?.approvals ?? app.approvals,
    council: own?.council ?? app.council,
    relay: own?.relay ?? app.relay,
    tools: own?.tools ?? { claude: {}, codex: {}, gemini: {}, muse: {} },
  };
}
