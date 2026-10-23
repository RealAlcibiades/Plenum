// Which models take images and PDFs in Plenum, and in what form. Pure code, written like lib/pricing.mjs: a table read from
// each provider's own pages on a stated date (CAPABILITIES.checkedOn, sources). A model a page does not list takes text only,
// and its reason names the page it was not listed on. Nothing is inferred from another model's row.
//
//   imageSupport(ref)        -> { ok, why, mimes, shape, tentative, note }
//                              ok: Plenum may send an image to this model. mimes: the types it takes (empty when not ok).
//                              shape: how an image goes in a chat message ('block', 'object' for image_url {url}, 'string' for
//                              image_url as a string, '@file' for the Gemini CLI). tentative: true when the row rests on something
//                              the page does not state (see note). why: the plain reason when not ok.
//   pdfSupport(ref, route)   -> 'native' | 'text'. A PDF goes as a document block only to Claude through an API key (route 'api').
//                              Every other model gets the PDF's text, read by Plenum (lib/pdf-text.mjs).
//   providerTakesImages(p)   -> true when some model of the provider can take an image (the early check in lib/images.mjs).
//
// OpenRouter is not in the table: whether a model takes images comes from the input modalities OpenRouter lists, kept by
// lib/openrouter.mjs for ten minutes (openRouterImageInput). A model not in that list is text only.

import { openRouterImageInput } from './openrouter.mjs';

const PNG = 'image/png';
const JPEG = 'image/jpeg';
const GIF = 'image/gif';
const WEBP = 'image/webp';
const FOUR = [PNG, JPEG, GIF, WEBP];

export const CAPABILITIES = {
  // The day the provider pages below were read. Rows that rest on something a page does not state carry tentative: true.
  checkedOn: '2026-10-22',
  sources: {
    anthropic: 'https://platform.claude.com/docs/en/build-with-claude/pdf-support (read 2026-10-14); images as recorded in build/ATTACHMENTS.md',
    codex: 'https://learn.chatgpt.com/docs/cli/reference (the -i flag, read 2026-10-14)',
    gemini: 'https://geminicli.com/docs/cli/tutorials/file-management/ (read 2026-10-22: the @ syntax is described for text files only)',
    xai: 'https://docs.x.ai/docs/guides/image-understanding (read 2026-10-22)',
    openai: 'https://developers.openai.com/api/docs/guides/images-vision (read 2026-10-22)',
    googleai: 'https://ai.google.dev/gemini-api/docs/openai (read 2026-10-22)',
    mistral: 'https://docs.mistral.ai/capabilities/vision/ (read 2026-10-22)',
  },
};

// The rows. all: every model of the provider takes images. ids: the only model ids the provider's page lists as taking images.
// none: why no model of the provider takes images in Plenum.
const ROWS = {
  anthropic: {
    all: true, mimes: FOUR, shape: 'block', tentative: false,
    note: 'Image blocks in the newest user message, through the API key or the Claude CLI.',
  },
  codex: {
    all: true, mimes: FOUR, shape: null, tentative: false,
    note: 'Passed to the CLI with -i.',
  },
  gemini: {
    all: true, mimes: [PNG, JPEG, WEBP], shape: '@file', tentative: true,
    note: 'Staged in a temporary folder and named with @file in the prompt. The Gemini CLI documentation does not confirm @ image files in non-interactive -p mode.',
  },
  xai: {
    ids: ['grok-4.7'], mimes: [PNG, JPEG], shape: 'object', tentative: true,
    note: 'The page lists JPG/JPEG and PNG, 20 MiB per image, and names only grok-4.7 in its examples. Its examples show the Responses API; the chat-completions shape is unconfirmed.',
  },
  openai: {
    ids: ['gpt-6-astra'], mimes: FOUR, shape: 'object', tentative: true,
    note: 'The page lists PNG, JPEG, WEBP and non-animated GIF. Its image examples use the Responses API, so the chat-completions shape is unconfirmed.',
  },
  googleai: {
    ids: ['gemini-3.8-flash'], mimes: [PNG, JPEG, WEBP], shape: 'object', tentative: true,
    note: 'The page shows a content array with an image_url object holding a data URI. Its example uses image/jpeg only; the other formats are not stated.',
  },
  mistral: {
    ids: ['mistral-large-2512', 'mistral-medium-2508', 'mistral-small-2506', 'ministral-14b-2512', 'ministral-8b-2512', 'ministral-3b-2512'],
    mimes: [PNG, JPEG], shape: 'string', tentative: true,
    note: 'The page lists the vision models and shows image_url as a string. Its examples are URLs; the base64 form and the formats are not stated.',
  },
  muse: { none: 'muse exec 1.4.7 lists no image flag' },
  deepseek: { none: 'no image input is listed for DeepSeek models in Plenum' },
  cursor: { none: 'the Cursor CLI takes no image input in Plenum' },
  echo: { none: 'the offline echo model takes text only' },
};

// The reason and status for a provider that is not in ROWS.
const UNKNOWN = 'Plenum has no image input for this provider';

const NONE = (why) => ({ ok: false, why, mimes: [], shape: null, tentative: false, note: '' });

// The provider and id of a ref ("anthropic:claude-opus-5-5"). Kept local, because lib/providers.mjs imports this file.
const splitRef = ref => {
  const text = String(ref ?? '');
  const i = text.indexOf(':');
  return i < 0 ? { provider: text, id: '' } : { provider: text.slice(0, i), id: text.slice(i + 1) };
};

// The answer for an OpenRouter model from the list kept in memory (openRouterImageInput: true, false, or null when the model is
// not in a list kept within the last ten minutes).
function fromOpenRouter(seen) {
  if (seen === true) {
    return {
      ok: true, why: null, mimes: [PNG, JPEG], shape: 'object', tentative: true,
      note: 'OpenRouter lists image input for this model. It does not list the formats, so PNG and JPEG only.',
    };
  }
  if (seen === false) return NONE('OpenRouter lists no image input for this model');
  return NONE('open the OpenRouter list in Accounts to check');
}

// Whether a ref takes images, from the table. Synchronous and makes no request: an OpenRouter ref reads the list kept in memory.
export function imageSupport(ref) {
  const { provider, id } = splitRef(ref);
  if (provider === 'openrouter') return fromOpenRouter(openRouterImageInput(id));
  const row = ROWS[provider];
  if (!row) return NONE(UNKNOWN);
  if (row.none) return NONE(row.none);
  const listed = row.all === true || (Array.isArray(row.ids) && row.ids.includes(id));
  if (!listed) return NONE(`not listed as taking images on ${CAPABILITIES.sources[provider]}`);
  return { ok: true, why: null, mimes: [...row.mimes], shape: row.shape, tentative: row.tentative, note: row.note };
}

// Whether a PDF reaches the model as a document block (native) or as text Plenum reads out of it (text).
export function pdfSupport(ref, route) {
  const { provider } = splitRef(ref);
  return provider === 'anthropic' && route === 'api' ? 'native' : 'text';
}

// True when some model of the provider takes images. OpenRouter is a router: some of its models do, so it counts.
export function providerTakesImages(provider) {
  if (provider === 'openrouter') return true;
  const row = ROWS[provider];
  return Boolean(row && (row.all === true || (Array.isArray(row.ids) && row.ids.length > 0)));
}

// Plain words for a list of mime types, for refusals: ['image/png', 'image/jpeg'] -> 'PNG and JPEG'.
const WORD = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };
export function mimeWords(mimes) {
  const names = mimes.map(m => WORD[m] ?? m);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
