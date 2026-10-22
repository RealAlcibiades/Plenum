// The registry of computer-use drivers for providers that run their own loop (Claude runs inside streamClaude and needs no entry here).
// A driver is a module next to this file that exports `streamComputer(args)`; providers.mjs asks for it when a chat turn has a
// computer run and the provider has one:
//   if (ctx?.computer && driverInstalled(provider)) yield* (await driverFor(provider)).streamComputer({ ...args });
// The modules are written by their own features (openai.mjs, gemini.mjs, generic.mjs); until one is installed its entry says so, and
// lib/computer/support.mjs reports the provider as unable to control the computer.
import { CODE_ROOT, listFiles } from '../overlay.mjs';

// provider id -> the file that drives it.
export const DRIVER_FILES = Object.freeze({ openai: 'openai.mjs', googleai: 'gemini.mjs', generic: 'generic.mjs' });

// provider id -> () => import of its module. A module that is not installed rejects with the loader's own error.
export const DRIVERS = Object.freeze({
  openai: () => import('./openai.mjs'),
  googleai: () => import('./gemini.mjs'),
  generic: () => import('./generic.mjs'),
});

// True when the driver's file is in the install folder, or in the active update generation (lib/overlay.mjs).
export function driverInstalled(provider, { list = listFiles } = {}) {
  const file = Object.hasOwn(DRIVER_FILES, provider) ? DRIVER_FILES[provider] : null;
  if (!file) return false;
  try {
    return list('lib/computer', name => name === file, CODE_ROOT).includes(file);
  } catch {
    return false;
  }
}

// The driver module for a provider, or null when none is installed or it does not load.
export async function driverFor(provider) {
  if (!driverInstalled(provider)) return null;
  try {
    const mod = await DRIVERS[provider]();
    return typeof mod?.streamComputer === 'function' ? mod : null;
  } catch {
    return null;
  }
}
