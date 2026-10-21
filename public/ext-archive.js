// Undo for /clear, /compact or an Edit. Loaded by ext.js and adds itself through window.MuseUI.
// After /clear, /compact or an Edit the server keeps the messages it removed (lib/archive.mjs), and MuseUI.state.archive says
// what was kept. A line above the composer offers to put them back. It stays only until the next message is sent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const LABELS = { clear: 'Chat cleared', compact: 'Chat compacted' };

  const line = document.createElement('div');
  line.className = 'ext-archive-line';
  line.setAttribute('role', 'status');
  line.hidden = true;
  const text = MuseUI.span('ext-archive-text', '');
  const undo = MuseUI.button('ghost small ext-archive-undo', 'Undo');
  undo.title = 'Put the chat back as it was';
  const dismiss = MuseUI.button('ghost small ext-archive-dismiss', 'Dismiss');
  dismiss.title = 'Forget the earlier chat for good';
  line.append(text, undo, dismiss);
  // Above the composer, where the queue line sits.
  MuseUI.el.form.before(line);

  // True while a request is on its way, so a second click cannot send a second one.
  let busy = false;

  // How long ago, in words: 'just now', 'N seconds ago', 'N minutes ago' or 'N hours ago'.
  function ageText(at) {
    const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (secs < 10) return 'just now';
    if (secs < 60) return `${secs} seconds ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
    const hours = Math.floor(mins / 60);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  // The line shows while the live chat is still the one that /clear, /compact or an Edit left: no messages, or only the summary
  // after a compact, or exactly the messages that stayed after an Edit. A newer message hides it. The server refuses the
  // restore after that as well.
  function paint() {
    const a = MuseUI.state.archive;
    const live = (MuseUI.state.messages ?? []).length;
    const show = Boolean(a) && (a.reason === 'rewind' ? live === a.stayed : live <= (a.reason === 'compact' ? 1 : 0));
    line.hidden = !show;
    if (!show) return;
    const label = LABELS[a.reason] ?? 'Messages removed';
    text.textContent = `${label} ${ageText(a.at)} (${a.count} ${a.count === 1 ? 'message' : 'messages'}).`;
  }

  function setBusy(on) {
    busy = on;
    undo.disabled = on;
    dismiss.disabled = on;
  }

  undo.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    // After an Edit the composer keeps the text that Edit put there, so the toast only says what came back.
    const edit = MuseUI.state.archive?.reason === 'rewind';
    try {
      await MuseUI.api('/api/chat/restore', { project: MuseUI.state.activeProject });
      await MuseUI.refresh();
      MuseUI.toast(edit ? 'Earlier messages are back. The composer was left as it is.' : 'Chat restored.');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      setBusy(false);
      paint();
    }
  });

  dismiss.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    try {
      await MuseUI.api('/api/chat/archive/discard', { project: MuseUI.state.activeProject });
      await MuseUI.refresh();
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      setBusy(false);
      paint();
    }
  });

  // The top bar is redrawn on a project switch, a reload and the end of a run; the chat is redrawn when a message is sent
  // and after a restore. Either can change what the line shows. The timer keeps the age text current.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  new MutationObserver(paint).observe(MuseUI.el.chat, { childList: true });
  setInterval(paint, 30000);
  paint();
})();
