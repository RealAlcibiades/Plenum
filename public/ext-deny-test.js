// Dry-run tester for blocked commands. Loaded by ext.js and adds itself through window.MuseUI.
// In the Project settings drawer, under the project's own blocked-command patterns, a box takes a command and asks the
// server (POST /api/deny/test) whether a built-in rule or one of the saved patterns would block it. The server only checks
// the text. Nothing is run, and no pattern is saved or changed. Every piece of text here is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Project settings';
  const MAX_CHARS = 2000;
  const NOTE = 'Checks the built-in rules and the patterns saved above. Nothing is run.';

  // One test box. The drawer redraws from scratch each time it opens, so a box is built per drawer and holds its own state.
  function buildBox() {
    const box = document.createElement('div');
    box.className = 'ext-deny-test';

    const label = MuseUI.span('field-label', 'Test a command');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ext-deny-input';
    input.maxLength = MAX_CHARS;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'for example: rm -rf build';
    input.setAttribute('aria-label', 'Command to test');
    const go = MuseUI.button('ghost small', 'Test');
    const row = document.createElement('div');
    row.className = 'ext-deny-row';
    row.append(input, go);

    const result = document.createElement('div');
    result.className = 'ext-deny-result';
    result.setAttribute('role', 'status');
    const note = MuseUI.span('field-note ext-deny-note', NOTE);
    box.append(label, row, result, note);

    // A later test, or a change to the text, makes an earlier answer stale. The number tells a late reply to stay silent.
    let seq = 0;
    let busy = false;

    function show(text, kind) {
      result.textContent = text;
      result.classList.toggle('ok', kind === 'ok');
      result.classList.toggle('bad', kind === 'bad');
    }

    function wording(r) {
      if (r.blocked && r.source === 'built-in') return { text: `Blocked by a built-in rule: ${r.rule}`, kind: 'bad' };
      if (r.blocked) return { text: `Blocked by your pattern "${r.rule}"`, kind: 'bad' };
      return { text: 'Allowed: this command would run (after your approval in Ask-first mode).', kind: 'ok' };
    }

    async function run() {
      if (busy) return;
      const command = input.value;
      const project = MuseUI.state.activeProject;
      if (!command.trim()) return show('Type a command first.', 'bad');
      if (!project) return show('Choose a project first.', 'bad');
      const mine = ++seq;
      busy = true;
      go.disabled = true;
      show('Checking…', null);
      try {
        const r = await MuseUI.api('/api/deny/test', { project, command });
        if (mine !== seq) return;
        const w = wording(r);
        show(w.text, w.kind);
      } catch (err) {
        if (mine === seq) show(err.message, 'bad');
      } finally {
        busy = false;
        go.disabled = false;
      }
    }

    go.addEventListener('click', run);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      run();
    });
    input.addEventListener('input', () => {
      seq += 1;
      show('', null);
    });
    return box;
  }

  // Puts one box right after the patterns field of the Project settings drawer, and drops any box left without it.
  function sync() {
    const { drawerTitle, drawerBody } = MuseUI.el;
    for (const box of drawerBody.querySelectorAll('.ext-deny-test')) {
      if (!box.previousElementSibling?.classList.contains('ps-deny')) box.remove();
    }
    if (drawerTitle.textContent !== TITLE) return;
    for (const deny of drawerBody.querySelectorAll('.ps-deny')) {
      if (!deny.nextElementSibling?.classList.contains('ext-deny-test')) deny.after(buildBox());
    }
  }

  // The drawer body is cleared and filled again on every open, and the settings arrive after a short load, so the box is
  // added whenever the patterns field shows up. The box is not a .ps-deny, so adding it settles the observer.
  new MutationObserver(sync).observe(MuseUI.el.drawerBody, { childList: true, subtree: true });
  sync();
})();
