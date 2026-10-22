// Which models can control the computer, and what a model needs for it. The chat route asks before a run starts (a model that cannot
// is refused with a plain 400), and the Computer panel lists the models with a note on each.
//
//  - Claude runs the computer toolset through the Anthropic API: it needs a saved Anthropic API key (the Claude CLI route cannot do
//    it, so a key is needed even when Claude normally runs through the CLI) and a model in COMPUTER_MODELS. 'toolset' models are
//    confirmed; 'unverified' ones are offered and a 400 from the API is shown plainly.
//  - OpenAI and Google AI run through their own drivers (lib/computer/drivers.mjs): the driver module must be installed and the
//    provider's key saved.
//  - Every other provider cannot control the computer yet.
// computerSupport(ref) -> 'toolset' | 'unverified' | 'native' | 'no'. computerSupportDetail(ref) adds the message for a 'no'.
// The key itself is never read into a result here: only whether one is saved.
import { driverInstalled } from './drivers.mjs';

export const COMPUTER_MODELS = Object.freeze({
  'claude-opus-5-5': 'toolset',
  'claude-sonnet-5-5': 'toolset',
  'claude-haiku-5-5': 'toolset',
  'claude-opus-5': 'toolset',
  'claude-fable-5-1': 'unverified',
});

const NAMES = Object.freeze({
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-fable-5-1': 'Claude Fable 5.1',
});

// The refs the Computer panel lists besides the Claude models: one entry each for the OpenAI and Google AI drivers.
export const OPENAI_REF = 'openai:gpt-6.1-sol';
export const GOOGLE_REF = 'googleai:gemini-3.8-flash';

const KEYS = { openai: 'OpenAI', googleai: 'Google AI' };

export const unsupportedMessage = name =>
  `${name} cannot control the computer. Pick Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 or Opus 5 through the Anthropic API, or an OpenAI or Gemini computer-use model.`;

const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return { provider: i < 0 ? '' : text.slice(0, i), id: i < 0 ? text : text.slice(i + 1) };
};

// The parts that need the rest of the app are looked up when they are first needed, so this module loads on its own in a test.
async function defaults() {
  const providers = await import('../providers.mjs');
  const keys = await import('../keys.mjs');
  return {
    hasAnthropicKey: async () => Boolean((await providers.anthropicKey()).key),
    hasKey: async provider => Boolean(await keys.keyFor(provider)),
    labelFor: providers.labelFor,
    installed: driverInstalled,
  };
}

export async function computerSupportDetail(ref, deps) {
  const d = { ...(await defaults()), ...(deps ?? {}) };
  const { provider, id } = splitRef(ref);
  const name = () => {
    try {
      return d.labelFor(ref);
    } catch {
      return String(ref);
    }
  };
  if (provider === 'anthropic') {
    const level = Object.hasOwn(COMPUTER_MODELS, id) ? COMPUTER_MODELS[id] : 'no';
    if (level === 'no') return { level, message: unsupportedMessage(name()), note: 'cannot use the computer' };
    if (!(await d.hasAnthropicKey())) {
      return { level: 'no', message: 'Computer use needs a saved Anthropic API key, even when Claude normally runs through the Claude CLI. Add one in Accounts.', note: 'needs an Anthropic API key' };
    }
    return { level, message: '', note: level === 'unverified' ? 'untested' : '' };
  }
  if (provider === 'openai' || provider === 'googleai') {
    if (!d.installed(provider)) return { level: 'no', message: unsupportedMessage(name()), note: 'driver not installed' };
    if (!(await d.hasKey(provider))) {
      return { level: 'no', message: `Computer use with ${KEYS[provider]} models needs a saved ${KEYS[provider]} key. Add one in Accounts.`, note: `needs ${provider === 'openai' ? 'an' : 'a'} ${KEYS[provider]} key` };
    }
    return { level: 'native', message: '', note: '' };
  }
  return { level: 'no', message: unsupportedMessage(name()), note: 'cannot use the computer' };
}

export async function computerSupport(ref, deps) {
  return (await computerSupportDetail(ref, deps)).level;
}

// The Computer panel's model list: every model that can ever fill the role, with whether it is ready now and a note when it is not.
export async function computerModels(deps) {
  const refs = [...Object.keys(COMPUTER_MODELS).map(id => `anthropic:${id}`), OPENAI_REF, GOOGLE_REF];
  const out = [];
  for (const ref of refs) {
    const detail = await computerSupportDetail(ref, deps);
    const { provider, id } = splitRef(ref);
    out.push({ ref, name: provider === 'anthropic' ? NAMES[id] : ref, ready: detail.level !== 'no', level: detail.level, note: detail.note });
  }
  return out;
}
