// Store health notice. Loaded by ext.js and adds itself through window.MuseUI.
// When Plenum could not read its saved state file at start, it loaded the last backup (or started fresh) and says so here once.
// The server keeps that outcome (GET /api/store/health) until Dismiss acknowledges it (POST /api/store/health/ack), so a reload
// does not bring the notice back. This file keeps no copy of it. Every string is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  // The last part of a path, whichever separator the system uses. Only the file name is shown, never the folder it is in.
  const fileName = p => String(p ?? '').split(/[\\/]/).pop();

  function show(health) {
    const box = document.createElement('div');
    box.className = 'ext-store-banner';
    box.setAttribute('role', 'alert');

    const copy = document.createElement('div');
    copy.className = 'ext-store-copy';
    const head = document.createElement('p');
    head.className = 'ext-store-head';
    head.textContent = health.recovered === 'backup' || health.recovered === 'backup-readonly'
      ? 'Plenum could not read its saved state file, so it loaded the last backup.'
      : 'Plenum could not read its saved state file, so it started fresh.';
    const note = document.createElement('p');
    note.className = 'ext-store-note';
    // unread: the file could not be opened (another program may have held it), so it is not known to be damaged.
    note.textContent = health.unread
      ? `The file may have been in use by another program. It was left as it was, and before Plenum next saves, it is copied to state.json.unread-<time> in ${health.home}.`
      : health.corruptFile
        ? `The damaged file was kept as ${fileName(health.corruptFile)} in ${health.home}.`
        : 'The damaged file could not be moved aside.';
    copy.append(head, note);

    const dismiss = MuseUI.button('ghost small ext-store-dismiss', 'Dismiss');
    dismiss.addEventListener('click', async () => {
      dismiss.disabled = true;
      try {
        await MuseUI.api('/api/store/health/ack', {});
        box.remove();
      } catch (err) {
        dismiss.disabled = false;
        MuseUI.toast(err.message, 'bad');
      }
    });

    box.append(copy, dismiss);
    // Above the chat, so the notice is the first thing read after a start that recovered.
    MuseUI.el.chat.before(box);
  }

  // Asked once at load. A server that cannot be reached, or one without this route, shows nothing.
  MuseUI.api('/api/store/health').then(data => {
    if (data && data.health) show(data.health);
  }).catch(() => {});
})();
