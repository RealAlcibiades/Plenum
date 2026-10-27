// Isolated artifact preview for the Plenum Android app (mob-13). The page opens in a separate Android activity with no
// bridge to the app, so it cannot read the keys, the channel or the shell. iOS and the browser do not use this plugin.
import { registerPlugin } from '@capacitor/core';

const IsolatedPreview = registerPlugin('IsolatedPreview', {
  web: () => import('./web.js').then(module => new module.IsolatedPreviewWeb()),
});

export * from './core.js';
export { IsolatedPreview };
export default IsolatedPreview;
