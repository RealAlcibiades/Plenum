// Store health notices. Loaded by ext.js and adds itself through window.MuseUI.
// 1. When Plenum could not read or find its saved state file at start, it loaded the last backup (or started fresh) and says so
//    here once. The server keeps that outcome (GET /api/store/health) until Dismiss acknowledges it (POST /api/store/health/ack),
//    so a reload does not bring the notice back. This file keeps no copy of it.
// 2. When a save fails (a folder that cannot be written, a full disk, a locked file), the change on screen is not in the file and
//    is lost on restart. The server puts the message in the state it sends (saveFailure, lib/store.mjs), at start and after every
//    change, and this notice follows it: it is there while the failure is, and gone once a save works.
// Every string is set with textContent.
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
    // missing: the file was not there at start, but a backup was (it was deleted or moved while Plenum was not running).
    head.textContent = health.missing
      ? 'Plenum could not find its saved state file, so it loaded the last backup.'
      : health.recovered === 'backup' || health.recovered === 'backup-readonly'
        ? 'Plenum could not read its saved state file, so it loaded the last backup.'
        : 'Plenum could not read its saved state file, so it started fresh.';
    const note = document.createElement('p');
    note.className = 'ext-store-note';
    // unread: the file could not be opened (another program may have held it), so it is not known to be damaged.
    note.textContent = health.missing
      ? `The file may have been deleted or moved while Plenum was not running. The next save writes a new one in ${health.home}.`
      : health.unread
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

  // The notice for a save that failed. One box at most, kept while the server reports the failure. Dismiss hides it until the failure
  // has cleared and comes back, so a notice that was dismissed is not shown again for the same run of failures.
  let failBox = null;
  let failText = '';
  let failDismissed = false;

  function showSaveFailure(message) {
    if (typeof message !== 'string' || !message) {
      failBox?.remove();
      failBox = null;
      failText = '';
      failDismissed = false;
      return;
    }
    if (failDismissed || (failBox && failText === message)) return;
    failBox?.remove();
    failText = message;
    const box = document.createElement('div');
    box.className = 'ext-store-banner ext-store-save';
    box.setAttribute('role', 'alert');
    const copy = document.createElement('div');
    copy.className = 'ext-store-copy';
    const head = document.createElement('p');
    head.className = 'ext-store-head';
    head.textContent = message;
    const note = document.createElement('p');
    note.className = 'ext-store-note';
    note.textContent = 'What you changed is shown, but it is not saved and is lost when Plenum closes. Check that the Plenum folder can be written to and the disk has room. This goes away when a save works.';
    copy.append(head, note);
    const dismiss = MuseUI.button('ghost small ext-store-dismiss', 'Dismiss');
    dismiss.addEventListener('click', () => {
      failDismissed = true;
      box.remove();
      failBox = null;
    });
    box.append(copy, dismiss);
    MuseUI.el.chat.before(box);
    failBox = box;
  }

  // The state the server sends at connect (hello) and after every change carries saveFailure: a message, or null.
  window.addEventListener('plenum:event', e => {
    const ev = e.detail;
    if (ev && (ev.type === 'hello' || ev.type === 'state') && ev.state && typeof ev.state === 'object') showSaveFailure(ev.state.saveFailure ?? null);
  });
  showSaveFailure(MuseUI.state?.saveFailure ?? null);

  // Asked once at load. A server that cannot be reached, or one without this route, shows nothing.
  MuseUI.api('/api/store/health').then(data => {
    if (data && data.health) show(data.health);
  }).catch(() => {});
})();
