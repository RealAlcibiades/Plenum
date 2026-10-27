// Web implementation of the Dictation plugin. The browser has no plugin; the composer shows no microphone button there.
import { WebPlugin } from '@capacitor/core';

const NOT_ON_WEB = 'Dictation is in the Android and iPhone apps. The browser keyboard has its own dictation key.';

export class DictationWeb extends WebPlugin {
  async available() {
    return { available: false, onDevice: false, serverAvailable: false, permission: 'denied', platform: 'web' };
  }

  async requestPermission() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async start() {
    throw this.unavailable(NOT_ON_WEB);
  }

  async stop() {}

  async cancel() {}
}
