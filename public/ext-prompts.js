// ext-prompts. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// Saved prompts. A message that starts with /name, where name is a saved prompt, is sent as that prompt's text.
// $ARGUMENTS in the text takes whatever is typed after the name. The list and the editor are in the Saved prompts
// drawer, which the Commands drawer links to. The storage and the routes are in lib/prompts.mjs and lib/routes/prompts.mjs.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const DRAWER = 'Saved prompts';
  const COMMANDS = 'Commands';
  const SECTION = 'ext-prompts-entry';
  const ARGUMENTS = '$ARGUMENTS';
  // The same limits as lib/prompts.mjs. The server checks everything again. These checks only answer sooner.
  const NAME_PATTERN = /^[a-z0-9-]{1,32}$/;
  const NAME_MAX = 32;
  const TEMPLATE_MAX = 4000;
  const DESCRIPTION_MAX = 200;
  const LOADING = 'Loading saved prompts…';

  // The editor's draft, or null when no editor is open. It is kept in memory only, so a redraw keeps it and a reload does not.
  let editor = null;
  // The list on screen: { root, projectId, prompts }. Changes that stay on screen repaint from here, without a request.
  let shown = null;
  // The line under the editor that reports a check or a save. It is set each time the editor is drawn.
  let resultLine = null;
  // Counts the loads, so a late reply never paints over a newer drawer.
  let loadSeq = 0;
  // True while a slash message waits for its saved prompt to be looked up. Enter does nothing until the lookup returns.
  let lookingUp = false;
  // True only while this script sends a message it has already expanded, so the listener lets that one through.
  let passing = false;

  // ---------- sending a saved prompt ----------

  // The text a saved prompt sends. The same rule as expandPrompt in lib/prompts.mjs.
  function expandTemplate(template, typed) {
    if (!template.includes(ARGUMENTS)) return typed ? `${template}\n\n${typed}` : template;
    return template.split(ARGUMENTS).join(typed);
  }

  // Runs before the page's own submit handler (a capture listener on the document). A message that starts with / is held
  // while its saved prompt is looked up. A name that is not saved is sent as it was typed. While a run is going the Send
  // button shows Stop, and the page treats that press as a stop, so nothing is held then.
  document.addEventListener('submit', e => {
    if (passing || e.target !== MuseUI.el.form) return;
    // Enter during a lookup does nothing. The text stays in the composer, so it can be sent again afterwards.
    if (lookingUp) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const text = MuseUI.el.input.value.trim();
    const hit = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    const projectId = MuseUI.state.activeProject;
    if (!hit || !projectId || MuseUI.el.send.classList.contains('stop')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    lookingUp = true;
    sendWithSaved(text, hit, projectId);
  }, true);

  // Looks up the project's saved prompts, then sends the message through the page's own submit path. The composer is only
  // changed when the name is saved, and only if it still holds the text that was submitted.
  async function sendWithSaved(text, hit, projectId) {
    try {
      let saved = [];
      try {
        const data = await MuseUI.api(`/api/prompts?project=${encodeURIComponent(projectId)}`);
        saved = Array.isArray(data?.prompts) ? data.prompts : [];
      } catch {
        // Without the list the message goes as typed, and the page reports any problem with it.
      }
      const input = MuseUI.el.input;
      // The composer changed while the list loaded. Leave the new text alone, so the user can send it with Enter.
      if (input.value.trim() !== text) return;
      const found = saved.find(p => p.name === hit[1].toLowerCase());
      if (found) input.value = expandTemplate(found.template, hit[2].trim());
      passing = true;
      try {
        MuseUI.el.form.requestSubmit();
      } finally {
        passing = false;
      }
    } finally {
      lookingUp = false;
    }
  }

  // ---------- the entry in the Commands drawer ----------

  function commandsOpen() {
    const { drawer, drawerTitle } = MuseUI.el;
    return !drawer.hidden && drawerTitle.textContent === COMMANDS;
  }

  // Runs on every change to the drawer body. The entry is added once per render. Adding it triggers this again, but the
  // entry is already there by then, so nothing loops.
  function syncEntry() {
    const body = MuseUI.el.drawerBody;
    if (!commandsOpen() || body.children.length === 0) return;
    if (body.querySelector(`:scope > .${SECTION}`)) return;
    body.append(entrySection());
  }

  function entrySection() {
    const section = document.createElement('section');
    section.className = SECTION;
    section.setAttribute('aria-label', DRAWER);
    const heading = document.createElement('h3');
    heading.className = 'ext-prompts-title';
    heading.textContent = DRAWER;
    const note = MuseUI.para('Type /name to send a saved prompt. $ARGUMENTS in its text takes whatever you type after the name.');
    note.className = 'ext-prompts-note';
    const manage = MuseUI.button('ghost small', 'Manage saved prompts');
    manage.addEventListener('click', () => {
      editor = null;
      MuseUI.openDrawer(DRAWER, renderDrawer);
    });
    section.append(heading, note, manage);
    return section;
  }

  new MutationObserver(syncEntry).observe(MuseUI.el.drawerBody, { childList: true });
  syncEntry();

  // ---------- the Saved prompts drawer ----------

  // The drawer body. The project is read on each draw, so the list is always the active project's.
  function renderDrawer(body) {
    const projectId = MuseUI.state.activeProject;
    const root = document.createElement('div');
    root.className = 'ext-prompts';
    // The export and import row sits above the list. It is kept out of root, which paint() redraws.
    if (projectId) body.append(transferRow(projectId));
    body.append(root);
    if (!projectId) {
      root.append(statusLine('Add a project folder first. Saved prompts belong to a project.'));
      return;
    }
    const seq = ++loadSeq;
    root.append(statusLine(LOADING));
    loadList(projectId).then(prompts => {
      if (seq !== loadSeq) return;
      shown = { root, projectId, prompts };
      paint();
    }, err => {
      if (seq !== loadSeq) return;
      root.replaceChildren(loadFailed(err.message));
    });
  }

  async function loadList(projectId) {
    const data = await MuseUI.api(`/api/prompts?project=${encodeURIComponent(projectId)}`);
    if (!Array.isArray(data?.prompts)) throw new Error('The saved prompts did not come back. Try again.');
    return data.prompts;
  }

  // ---------- export and import ----------

  // The row above the list. Export downloads every saved prompt of the project as one file. Import picks such a file and
  // adds its prompts; a prompt with the same name is replaced. The routes are in lib/routes/transfer.mjs.
  function transferRow(projectId) {
    const row = document.createElement('div');
    row.className = 'ext-prompts-transfer';
    const exportBtn = MuseUI.button('ghost small', 'Export');
    exportBtn.addEventListener('click', () => {
      // The export is a download link, clicked from the page. The server names the file.
      const a = document.createElement('a');
      a.href = `/api/prompts/export?project=${encodeURIComponent(projectId)}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });
    const importBtn = MuseUI.button('ghost small', 'Import…');
    // The file picker is hidden. The Import button opens it.
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.hidden = true;
    importBtn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      const chosen = picker.files?.[0];
      picker.value = '';
      if (chosen) importFile(chosen, projectId);
    });
    const note = MuseUI.para('Export saves every saved prompt in one file. Import adds the prompts in such a file. Nothing runs.');
    note.className = 'ext-prompts-note';
    row.append(exportBtn, importBtn, picker, note);
    return row;
  }

  // Reads the chosen file, then sends its prompts to the server, which checks every one before it saves any. A file that is
  // not a Plenum prompts export is refused here with a plain message.
  // The import toast, e.g. "Imported 2 prompts: 2 replaced, 0 new." The server counts the new and the replaced ones apart.
  function importedText(added, replaced) {
    const total = added + replaced;
    if (total === 0) return 'No prompts were imported.';
    return `Imported ${total} ${total === 1 ? 'prompt' : 'prompts'}: ${replaced} replaced, ${added} new.`;
  }

  async function importFile(chosen, projectId) {
    let text;
    try {
      text = await readText(chosen);
    } catch {
      MuseUI.toast('That file could not be read.', 'bad');
      return;
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      MuseUI.toast('That file is not JSON.', 'bad');
      return;
    }
    if (!data || typeof data !== 'object' || data.kind !== 'plenum-prompts' || !Array.isArray(data.prompts)) {
      MuseUI.toast('That file is not a Plenum prompts export.', 'bad');
      return;
    }
    try {
      const result = await MuseUI.api('/api/prompts/import', { project: projectId, prompts: data.prompts });
      MuseUI.toast(importedText(result.added, result.replaced));
      MuseUI.refreshDrawer();
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    }
  }

  // The file as text. Resolves with the text, or rejects when the browser cannot read the file.
  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // Draws the toolbar, the editor when one is open, and the list. Changes that stay on screen call this too.
  function paint() {
    if (!shown) return;
    const { root, projectId, prompts } = shown;
    root.replaceChildren(toolbar());
    if (editor) root.append(editorForm(projectId));
    if (prompts.length === 0) root.append(statusLine('No saved prompts yet. Add one, then type its name in the composer.'));
    else root.append(...prompts.map(p => promptCard(p, projectId)));
  }

  function toolbar() {
    const bar = document.createElement('div');
    bar.className = 'ext-prompts-bar';
    const add = MuseUI.button('primary small', 'Add a prompt');
    add.disabled = editor?.mode === 'new';
    add.addEventListener('click', () => {
      editor = { mode: 'new', name: '', description: '', template: '' };
      paint();
      shown.root.querySelector('.ext-prompts-form input')?.focus();
    });
    bar.append(statusLine('Names are lowercase letters, digits and hyphens.'), add);
    return bar;
  }

  // One saved prompt: its name and description, the text it sends, and Edit and Delete.
  function promptCard(p, projectId) {
    const card = document.createElement('section');
    card.className = 'card ext-prompts-card';
    const head = document.createElement('div');
    head.className = 'ext-prompts-head';
    head.append(MuseUI.span('ext-prompts-name', `/${p.name}`));
    if (p.description) head.append(MuseUI.span('ext-prompts-desc', p.description));
    const text = document.createElement('div');
    text.className = 'ext-prompts-text';
    text.textContent = p.template;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = MuseUI.button('ghost small', 'Edit');
    edit.addEventListener('click', () => {
      editor = { mode: 'edit', name: p.name, description: p.description ?? '', template: p.template };
      paint();
      shown.root.querySelector('.ext-prompts-form textarea')?.focus();
    });
    const remove = MuseUI.button('ghost small', 'Delete');
    remove.addEventListener('click', () => removePrompt(p, projectId, remove));
    actions.append(edit, remove);
    card.append(head, text, actions);
    return card;
  }

  // Asks first, then deletes, and redraws the drawer from the server's list.
  async function removePrompt(p, projectId, button) {
    if (!confirm(`Delete /${p.name}? This cannot be undone.`)) return;
    button.disabled = true;
    try {
      await MuseUI.api('/api/prompts/delete', { project: projectId, name: p.name });
      if (editor?.name === p.name) editor = null;
      MuseUI.toast(`Deleted /${p.name}`);
      MuseUI.refreshDrawer();
    } catch (err) {
      button.disabled = false;
      MuseUI.toast(err.message, 'bad');
    }
  }

  // The editor: a name, a description and the text, with Save and Cancel. It is built from plain fields and buttons,
  // not a <form>, so nothing in it can submit the composer.
  function editorForm(projectId) {
    const isNew = editor.mode === 'new';
    const box = document.createElement('section');
    box.className = 'card ext-prompts-form';
    box.append(MuseUI.span('ext-prompts-heading', isNew ? 'New prompt' : `Edit /${editor.name}`));

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = NAME_MAX;
    nameInput.placeholder = 'pr-review';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.value = editor.name;
    // A saved prompt is found by its name, so the name stays put while the prompt is edited.
    nameInput.disabled = !isNew;
    nameInput.addEventListener('input', () => { editor.name = nameInput.value; });
    // The rules for a name are shown under the field, and an edit says why the name cannot change.
    const nameHint = MuseUI.span('ext-prompts-note', isNew
      ? 'Lowercase letters, digits and hyphens, up to 32 characters.'
      : 'The name stays the same. Delete the prompt to use another name.');
    const nameField = labelled('Name', nameInput, nameHint);

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.maxLength = DESCRIPTION_MAX;
    descInput.placeholder = 'What it is for (optional)';
    descInput.autocomplete = 'off';
    descInput.value = editor.description;
    descInput.addEventListener('input', () => { editor.description = descInput.value; });
    const descField = labelled('Description', descInput);

    const area = document.createElement('textarea');
    area.rows = 6;
    area.maxLength = TEMPLATE_MAX;
    area.spellcheck = false;
    area.placeholder = 'The text to send. Use $ARGUMENTS where the text typed after the name goes.';
    area.value = editor.template;
    const count = MuseUI.span('ext-prompts-count', `${editor.template.length} / ${TEMPLATE_MAX}`);
    area.addEventListener('input', () => {
      editor.template = area.value;
      count.textContent = `${area.value.length} / ${TEMPLATE_MAX}`;
    });
    const argHint = MuseUI.span('ext-prompts-note', '$ARGUMENTS is replaced by the text typed after the name. A text without it gets that text added after it.');
    const templateField = labelled('Text to send', area, count, argHint);

    resultLine = statusLine('');
    resultLine.setAttribute('role', 'status');
    const save = MuseUI.button('primary small', 'Save prompt');
    save.addEventListener('click', () => saveEditor(projectId, save));
    const cancel = MuseUI.button('ghost small', 'Cancel');
    cancel.addEventListener('click', () => {
      editor = null;
      paint();
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(save, cancel);

    box.append(nameField, descField, templateField, resultLine, actions);
    return box;
  }

  // Checks the draft, then saves it. A success closes the editor and redraws the list from the server.
  async function saveEditor(projectId, button) {
    const name = editor.name.trim();
    const problem = draftProblem(name, editor.template);
    if (problem) return report(problem, 'bad');
    button.disabled = true;
    report('Saving…', '');
    try {
      await MuseUI.api('/api/prompts', {
        project: projectId,
        prompt: { name, template: editor.template, description: editor.description.trim() },
      });
      editor = null;
      MuseUI.toast(`Saved /${name}`);
      MuseUI.refreshDrawer();
    } catch (err) {
      button.disabled = false;
      report(err.message, 'bad');
    }
  }

  // The same rules as lib/prompts.mjs, checked here so the answer comes at once. The server still decides.
  function draftProblem(name, template) {
    if (!NAME_PATTERN.test(name)) return 'Use 1 to 32 lowercase letters, digits or hyphens for the name.';
    if (template.trim() === '') return 'Write the text to send.';
    return '';
  }

  // Shows a line under the editor. The editor is not redrawn, so typed text and focus stay where they are.
  function report(text, tone) {
    if (!resultLine) return;
    resultLine.textContent = text;
    resultLine.className = tone ? `ext-prompts-status ${tone}` : 'ext-prompts-status';
  }

  // A load that failed: the server's message and a button that asks again.
  function loadFailed(message) {
    const box = document.createElement('div');
    box.className = 'ext-prompts-error';
    const again = MuseUI.button('ghost small', 'Try again');
    again.addEventListener('click', () => MuseUI.refreshDrawer());
    box.append(statusLine(message, 'bad'), again);
    return box;
  }

  // A field with its title. The label wraps the control, so a click on the title puts the cursor in the field.
  function labelled(title, control, ...extra) {
    const label = document.createElement('label');
    label.className = 'ext-prompts-field';
    label.append(MuseUI.span('field-label', title), control, ...extra);
    return label;
  }

  function statusLine(text, tone = '') {
    const p = MuseUI.para(text);
    p.className = tone ? `ext-prompts-status ${tone}` : 'ext-prompts-status';
    return p;
  }
})();
