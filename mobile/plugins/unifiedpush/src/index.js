// UnifiedPush for the Plenum Android app. The native side (android/) talks to the user's distributor app, such as ntfy,
// through the UnifiedPush connector. On the web and on iOS the plugin is unavailable and the shell uses Web Push or nothing.
import { registerPlugin } from '@capacitor/core';

const UnifiedPush = registerPlugin('UnifiedPush', {
  web: () => import('./web.js').then(module => new module.UnifiedPushWeb()),
});

export * from './core.js';
export { UnifiedPush };
export default UnifiedPush;
