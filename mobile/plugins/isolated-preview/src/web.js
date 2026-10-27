// Web implementation of the isolated preview. There is no separate process in a browser, so the shell shows artifacts
// as pictures there instead (the same as iOS).
import { WebPlugin } from '@capacitor/core';

export class IsolatedPreviewWeb extends WebPlugin {
  async show() {
    throw this.unimplemented('The isolated preview is Android only. Artifacts are shown as pictures here.');
  }
}
