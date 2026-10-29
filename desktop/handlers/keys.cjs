'use strict';
// The server's key messages (lib/keys.mjs). keys-hello is sent once when the server starts; it gets the saved keys and this
// launch's token. save-key stores one key through the key vault (desktop/keyvault.cjs), and delete-key removes one. Nothing here
// is logged, and a key appears only in a reply.
module.exports = {
  name: 'keys',
  messages: {
    // -> { type: 'keys', storage, note, keys, token }. A store that cannot be read is answered as unavailable, with no keys.
    'keys-hello': async (message, shell) => {
      let loaded;
      try {
        loaded = await shell.vault.load();
      } catch {
        loaded = { storage: 'unavailable', note: 'The saved keys could not be read.', keys: {} };
      }
      return { type: 'keys', ...loaded, token: shell.token };
    },
    // -> { type: 'save-key-result', id, ok, ... } with the vault's answer for the key.
    'save-key': async (message, shell) => ({ type: 'save-key-result', id: message.id, ...(await shell.vault.save(message.name, message.key)) }),
    // -> { type: 'save-key-result', id, ok, ... } with the vault's answer. It is the same reply type as a save, which is what
    // lib/keys.mjs waits for, so a removal and a save are answered the same way.
    'delete-key': async (message, shell) => ({ type: 'save-key-result', id: message.id, ...(await shell.vault.remove(message.name)) }),
  },
};
