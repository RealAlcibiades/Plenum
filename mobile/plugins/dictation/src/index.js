// On-device dictation for the Plenum Android and iPhone apps (mob-13). The native code recognises speech on the phone
// first. In a browser the plugin is unavailable: the PWA relies on the keyboard's own dictation key.
import { registerPlugin } from '@capacitor/core';

const Dictation = registerPlugin('Dictation', {
  web: () => import('./web.js').then(module => new module.DictationWeb()),
});

export * from './core.js';
export { Dictation };
export default Dictation;
