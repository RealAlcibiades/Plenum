// Pure logic for the Dictation plugin's JavaScript side (mob-13; MOBILE-UI 8.5.4, 14.1, 15.6). No imports, so the same
// file runs in the Node tests, in the shell and in the browser.
//
// Dictation is the phone's own speech recognition, on the device first. Server recognition is used only when the
// person has turned on "Allow that" in Phone settings, which the shell passes as allowServer. The text lands in the
// message box; it is never sent automatically.

export const DICTATION_EVENTS = Object.freeze(['partial', 'final', 'level', 'end', 'error']);
export const END_REASONS = Object.freeze(['done', 'silence', 'no-speech', 'cancelled', 'error']);
export const ERROR_CODES = Object.freeze([
  'permission-denied',
  'on-device-unavailable',
  'locale-unavailable',
  'busy',
  'network',
  'no-speech',
  'unknown',
]);
export const DEFAULT_SILENCE_MS = 2000;
export const MIN_SILENCE_MS = 500;
export const MAX_SILENCE_MS = 5000;
export const MAX_TEXT_CHARS = 4000;

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export class DictationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DictationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanSpeech(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_TEXT_CHARS);
}

export function normaliseLocale(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 35 || !LOCALE_RE.test(value)) {
    throw new DictationError('bad-locale', 'That language tag is not valid.');
  }
  return value;
}

export function normaliseStartOptions(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const silence = opts.silenceMs === undefined ? DEFAULT_SILENCE_MS : Number(opts.silenceMs);
  if (!Number.isFinite(silence)) {
    throw new DictationError('bad-silence', 'The silence time must be a number of milliseconds.');
  }
  return {
    locale: normaliseLocale(opts.locale),
    allowServer: opts.allowServer === true,
    silenceMs: Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(silence))),
  };
}

// The language name in the copy ("British English"). Falls back to the tag when the platform has no name for it.
export function languageName(locale, displayLocale = 'en') {
  if (!locale) return 'this language';
  try {
    const name = new Intl.DisplayNames([displayLocale], { type: 'language' }).of(locale);
    return name && name !== locale ? name : locale;
  } catch {
    return locale;
  }
}

// The person-facing text for each error, in the copy of MOBILE-UI 8.5.4 and 14.1.
export function dictationMessage(code, { locale, platform = 'android' } = {}) {
  const language = languageName(locale);
  const service = platform === 'ios' ? "Apple's" : "Google's";
  switch (code) {
    case 'on-device-unavailable':
      return `Dictation is not available for ${language} on this phone. Turn on 'Allow that' in Phone settings › Dictation to use ${service} speech service.`;
    case 'locale-unavailable':
      return `Dictation is not available for ${language} on this phone.`;
    case 'permission-denied':
      return 'Plenum cannot use the microphone. Allow it in Settings › Plenum.';
    case 'busy':
      return 'Dictation is already listening.';
    case 'no-speech':
      return 'No speech was heard. Tap the microphone to try again.';
    case 'network':
      return 'Dictation could not reach the speech service. Try again.';
    default:
      return 'Dictation stopped. Try again.';
  }
}

// Turns what the native side reports into the one state the composer shows.
export function dictationStatus({ available = false, onDevice = false, permission = 'prompt', allowServer = false } = {}) {
  if (!available) return { state: 'unavailable', canStart: false };
  if (permission === 'denied') return { state: 'denied', canStart: false };
  if (permission !== 'granted') return { state: 'needs-permission', canStart: false };
  if (!onDevice && allowServer !== true) return { state: 'needs-server-switch', canStart: false };
  return { state: 'ready', canStart: true };
}

// Validates one native event. Unknown reasons and codes are replaced by safe defaults rather than trusted.
export function parseDictationEvent(name, data) {
  if (!DICTATION_EVENTS.includes(name)) {
    throw new DictationError('bad-event', 'Unknown dictation event.');
  }
  const payload = isPlainObject(data) ? data : {};
  switch (name) {
    case 'partial':
    case 'final':
      return { type: name, text: cleanSpeech(payload.text) };
    case 'level': {
      const value = Number(payload.value);
      return { type: 'level', value: Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0 };
    }
    case 'end':
      return { type: 'end', reason: END_REASONS.includes(payload.reason) ? payload.reason : 'done' };
    default: {
      const code = ERROR_CODES.includes(payload.code) ? payload.code : 'unknown';
      return { type: 'error', code, message: cleanSpeech(payload.message) };
    }
  }
}
