// Types for the Dictation plugin (mob-13). Runtime code is in index.js and core.js.
import type { PluginListenerHandle } from '@capacitor/core';

export type DictationEventName = 'partial' | 'final' | 'level' | 'end' | 'error';
export type DictationEndReason = 'done' | 'silence' | 'no-speech' | 'cancelled' | 'error';
export type DictationErrorCode =
  | 'permission-denied'
  | 'on-device-unavailable'
  | 'locale-unavailable'
  | 'busy'
  | 'network'
  | 'no-speech'
  | 'unknown';

export interface DictationAvailability {
  available: boolean;
  onDevice: boolean;
  serverAvailable?: boolean;
  permission: 'granted' | 'denied' | 'prompt';
  platform: 'android' | 'ios' | 'web';
}

export interface DictationPlugin {
  available(): Promise<DictationAvailability>;
  requestPermission(): Promise<{ permission: 'granted' | 'denied' | 'prompt' }>;
  start(options?: { locale?: string; allowServer?: boolean; silenceMs?: number }): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  addListener(event: DictationEventName, handler: (data: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

export declare const Dictation: DictationPlugin;
export default Dictation;
export * from './core';
