// Types for the UnifiedPush plugin (mob-13). Runtime code is in index.js and core.js.
import type { PluginListenerHandle } from '@capacitor/core';

export type UnifiedPushEventName = 'endpoint' | 'registrationFailed' | 'unregistered' | 'tempUnavailable' | 'message';
export type FailedReason = 'INTERNAL_ERROR' | 'NETWORK' | 'ACTION_REQUIRED' | 'VAPID_REQUIRED';

export interface EndpointRecord {
  url: string;
  temporary: boolean;
}

export interface UnifiedPushState {
  supported: boolean;
  distributor: string | null;
  endpoints: Record<string, EndpointRecord>;
  failures: Record<string, FailedReason>;
  registrations: string[];
  visible: boolean;
}

export interface UnifiedPushPlugin {
  getState(): Promise<UnifiedPushState>;
  getDistributors(): Promise<{ distributors: string[]; saved: string | null }>;
  chooseDistributor(options: { packageName: string }): Promise<{ saved: string }>;
  pickDistributor(): Promise<{ ok: boolean }>;
  register(options?: { instance?: string; messageForDistributor?: string; vapid?: string }): Promise<void>;
  unregister(options?: { instance?: string }): Promise<void>;
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  getNotificationPermission(): Promise<{ granted: boolean }>;
  addListener(event: UnifiedPushEventName, handler: (data: Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}

export declare const UnifiedPush: UnifiedPushPlugin;
export default UnifiedPush;
export * from './core';
