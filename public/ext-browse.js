// "Browse…" beside the add-project form and beside the welcome screen's "Add a project folder" button. Loaded by ext.js and adds
// itself through window.MuseUI. In the desktop app the button opens the system's folder dialog, and the chosen folder goes
// through the same Add folder path as a typed one. Under plain Node there is no dialog, and the button says so; the text box
// still works.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const NOT_DESKTOP = 'The folder picker works in the desktop app. Paste the folder path instead.';
  const NO_ANSWER = 'The folder dialog did not answer. Try again, or paste the folder path.';

  // Asks the server for a folder and adds it through the form. The button is disabled while the dialog is open.
  // openForm opens the add-project form first, for the welcome screen's button, which does not open it by itself.
  async function browse(btn, openForm) {
    btn.disabled = true;
    try {
      if (openForm) MuseUI.el.addForm.hidden = false;
      const r = await MuseUI.api('/api/pick-folder', {});
      if (!r.available) {
        MuseUI.toast(NOT_DESKTOP);
      } else if (!r.path) {
        if (r.timedOut) MuseUI.toast(NO_ANSWER, 'bad');
      } else {
        MuseUI.el.addPath.value = r.path;
        MuseUI.el.addForm.requestSubmit();
      }
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  }

  function makeButton(cls, openForm) {
    const b = MuseUI.button(cls, 'Browse…');
    b.title = 'Choose the project folder in a dialog';
    b.addEventListener('click', () => browse(b, openForm));
    return b;
  }

  // The add-project form is part of the page, so its button is added once, in its row, before Cancel.
  const formRow = MuseUI.el.addForm.querySelector('.row');
  const cancel = MuseUI.el.addCancel;
  if (formRow && cancel && cancel.parentNode === formRow && !formRow.querySelector('.ext-browse')) {
    formRow.insertBefore(makeButton('ghost small ext-browse', false), cancel);
  }

  // The welcome screen is redrawn with the chat, so after each change its button is looked for and added once.
  function syncWelcome() {
    const welcome = MuseUI.el.chat.querySelector('.welcome');
    if (!welcome || welcome.querySelector('.ext-browse-welcome')) return;
    const add = [...welcome.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a project folder');
    if (add) add.after(makeButton('ghost small ext-browse ext-browse-welcome', true));
  }
  syncWelcome();
  new MutationObserver(syncWelcome).observe(MuseUI.el.chat, { childList: true, subtree: true });
})();
