// ext-pipelines. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// Pipelines: an ordered chain of models. Each step has a model, an effort and a prompt, and the reply of one step goes to the
// next. The prompt may use {input} (your message) and {previous} (the reply of the step before). The list, the editor and the
// run are in the Pipelines drawer. Everything typed or received is set with textContent. A run is read-only on the server: no
// step can write a file or run a command. Only Keep writes to the chat. See lib/pipelines.mjs and lib/routes/pipelines.mjs.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Pipelines';
  const BUTTON_ID = 'pipelinesBtn';
  // The same limits as lib/pipelines.mjs. The server checks everything again. These checks only answer sooner.
  const NAME_MAX = 40;
  const MIN_STEPS = 1;
  const MAX_STEPS = 8;
  const TEMPLATE_MAX = 4000;
  const MESSAGE_MAX = 150000;
  // openrouter:<id> is the longest form a model can be written in.
  const REF_MAX = 140;
  const GROUPS = [['muse', 'Muse Code'], ['anthropic', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], ['xai', 'Grok'], ['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['mistral', 'Mistral'], ['googleai', 'Google AI'], ['openrouter', 'OpenRouter'], ['echo', 'Test']];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const STATUS_TEXT = { waiting: 'Waiting', writing: 'Writing', done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Not run' };
  const INTRO = 'A pipeline sends your message through a chain of models, one after another. The reply of each step goes to the next. Steps never open files or run commands, and nothing reaches the chat until you keep the final reply.';
  const EDIT_HINT = 'In a prompt, {input} is your message and {previous} is the reply of the step before it (empty in the first step).';
  const HINT = 'Ctrl+Enter to run';

  // The project's pipelines: { project, list }. Null until the first load for that project has come back.
  let items = null;
  let loadError = '';
  // Counts the loads, so a late reply never paints over a newer drawer.
  let loadSeq = 0;
  // What the drawer shows: 'list', 'edit' or 'run'.
  let mode = 'list';
  // The editor's draft: { project, isNew, name, steps: [{ ref, effort, template }] }. It lives in memory, so a redraw keeps it.
  let editor = null;
  // The pipeline on screen and its latest run: { project, name, steps: [{ ref, label, effort, status, text, error }], active, started, kept, error }.
  let run = null;
  let draftMessage = '';
  // A message about the controls (for example "Write a message first."), shown until the next change.
  let flash = null;
  // The drawer's elements. Each draw builds them again, so a stale reference is never painted.
  let view = null;
  let controller = null;
  let userStopped = false;
  let painting = false;

  // "Claude Opus 5.5", not "Muse Wonder Full (Muse Code subscribers)": the bracketed part is menu help.
  const refOf = c => `${c.provider}:${c.id}`;
  const shortLabel = c => c.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  function labelFor(ref) {
    const hit = MuseUI.catalog.find(c => refOf(c) === ref);
    return hit ? shortLabel(hit) : ref;
  }
  const effortLabel = effort => EFFORT_LABELS[effort] ?? String(effort);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // An element with a class and text. Text goes in with textContent, so nothing is read as HTML.
  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // A field with its title. The label wraps the control, so a click on the title puts the cursor in the field.
  function labelled(title, control, ...extra) {
    const label = make('label', 'pl-field');
    label.append(MuseUI.span('field-label', title), control, ...extra);
    return label;
  }

  // The saved list can be edited by hand, so a card only reads what it can show.
  const stepsOf = p => (Array.isArray(p?.steps) ? p.steps.filter(s => s && typeof s === 'object') : []);

  // ---------- the side menu entry and the drawer ----------

  // The entry sits above Accounts in the side menu. It only opens the drawer.
  function sideButton() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = BUTTON_ID;
    b.title = 'Chain models: the reply of each step goes to the next';
    b.append(MuseUI.icon('relay'), TITLE);
    b.addEventListener('click', openPipelines);
    return b;
  }

  function openPipelines() {
    MuseUI.openDrawer(TITLE, draw);
  }

  // Builds the panel from the module state. openDrawer and refreshDrawer both call it.
  function draw(body) {
    view = { root: make('div', 'pl-panel'), outs: null };
    body.append(view.root);
    // Pipelines send the message to several companies, so the multi-provider strip sits above the panel (LEGAL multi-provider).
    MuseUI.notice?.('multi-provider', { before: view.root });
    const project = MuseUI.state.activeProject;
    if (!project) {
      view.root.append(make('p', 'pl-note', 'Add a project folder first. Pipelines belong to a project.'));
      return;
    }
    // An editor or a finished run belongs to one project. A run that is still going stays on screen.
    if (mode === 'edit' && editor?.project !== project) editor = null;
    if (mode === 'run' && run?.project !== project && !run?.active) mode = 'list';
    // The list is read again each time the drawer opens, so a change made elsewhere shows. The list already in memory is drawn meanwhile.
    if (items?.project !== project) items = null;
    loadError = '';
    load(project);
    show();
  }

  // Reads the project's list. The list screen is redrawn when it arrives; the editor and the run screen are left alone, so nothing typed is disturbed.
  async function load(project) {
    const seq = ++loadSeq;
    try {
      const data = await MuseUI.api(`/api/pipelines?project=${encodeURIComponent(project)}`);
      if (seq !== loadSeq) return;
      if (!Array.isArray(data?.pipelines)) throw new Error('The pipelines did not come back. Try again.');
      items = { project, list: data.pipelines };
      loadError = '';
    } catch (err) {
      if (seq !== loadSeq) return;
      loadError = err.message;
    }
    if (mode === 'list') show();
  }

  // Draws the screen the mode asks for.
  function show() {
    if (!view?.root.isConnected) return;
    view.outs = null;
    if (mode === 'edit' && editor) drawEditor();
    else if (mode === 'run' && run) drawRun();
    else {
      mode = 'list';
      drawList();
    }
  }

  // ---------- the list ----------

  function drawList() {
    const root = view.root;
    root.replaceChildren(make('p', 'pl-intro', INTRO));
    const add = MuseUI.button('primary small', 'New pipeline');
    add.addEventListener('click', () => openEditor(null));
    const bar = make('div', 'pl-bar');
    bar.append(make('p', 'pl-note', 'Up to 8 steps in a pipeline. Each project keeps its own.'), add);
    root.append(bar);
    if (MuseUI.state.activeProject) root.append(transferRow(MuseUI.state.activeProject));

    if (run?.active) root.append(runningCard());
    if (!items) {
      if (loadError) {
        const again = MuseUI.button('ghost small', 'Try again');
        again.addEventListener('click', () => MuseUI.refreshDrawer());
        const box = make('div', 'pl-error');
        box.append(make('p', 'pl-status bad', loadError), again);
        root.append(box);
      } else {
        root.append(make('p', 'pl-note', 'Loading pipelines…'));
      }
      return;
    }
    if (!items.list.length) root.append(make('p', 'pl-note', 'No pipelines yet. Add one to chain two or more models.'));
    else root.append(...items.list.filter(p => p && typeof p.name === 'string').map(pipelineCard));
  }

  // ---------- export and import ----------

  // The row under the list's bar. Export downloads every pipeline of the project as one file. Import picks such a file and
  // adds its pipelines; one with the same name is replaced. Nothing in the file runs. The routes are in lib/routes/transfer.mjs.
  function transferRow(project) {
    const row = make('div', 'pl-transfer');
    const exportBtn = MuseUI.button('ghost small', 'Export');
    exportBtn.addEventListener('click', () => {
      // The export is a download link, clicked from the page. The server names the file.
      const a = document.createElement('a');
      a.href = `/api/pipelines/export?project=${encodeURIComponent(project)}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });
    const importBtn = MuseUI.button('ghost small', 'Import…');
    // The file picker is hidden. The Import button opens it.
    const picker = make('input');
    picker.type = 'file';
    picker.accept = 'application/json,.json';
    picker.hidden = true;
    importBtn.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      const chosen = picker.files?.[0];
      picker.value = '';
      if (chosen) importFile(chosen, project);
    });
    row.append(exportBtn, importBtn, picker, make('p', 'pl-note', 'Export saves every pipeline in one file. Import adds the pipelines in such a file. Nothing runs.'));
    return row;
  }

  // Reads the chosen file, then sends its pipelines to the server, which checks every one before it saves any. A file that is
  // not a Plenum pipelines export is refused here with a plain message.
  // The import toast, e.g. "Imported 2 pipelines: 2 replaced, 0 new." The server counts the new and the replaced ones apart.
  function importedText(added, replaced) {
    const total = added + replaced;
    if (total === 0) return 'No pipelines were imported.';
    return `Imported ${total} ${total === 1 ? 'pipeline' : 'pipelines'}: ${replaced} replaced, ${added} new.`;
  }

  async function importFile(chosen, project) {
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
    if (!data || typeof data !== 'object' || data.kind !== 'plenum-pipelines' || !Array.isArray(data.pipelines)) {
      MuseUI.toast('That file is not a Plenum pipelines export.', 'bad');
      return;
    }
    try {
      const result = await MuseUI.api('/api/pipelines/import', { project, pipelines: data.pipelines });
      // The answer is the newest list, so a load still on its way must not paint over it.
      loadSeq++;
      items = { project, list: Array.isArray(result?.pipelines) ? result.pipelines : [] };
      MuseUI.toast(importedText(result.added, result.replaced));
      if (mode === 'list') show();
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

  // Shown on the list while a run is going, so a second one is not started from here.
  function runningCard() {
    const card = make('section', 'card pl-card');
    const open = MuseUI.button('ghost small', 'Show the run');
    open.addEventListener('click', () => {
      mode = 'run';
      show();
    });
    card.append(make('p', 'pl-note', `The pipeline "${run.name}" is running. Wait for it to finish, or stop it.`), open);
    return card;
  }

  // One pipeline: its name, the chain of its steps, and Run, Edit and Delete.
  function pipelineCard(p) {
    const steps = stepsOf(p);
    const card = make('section', 'card pl-card');
    const head = make('div', 'pl-head');
    head.append(make('span', 'pl-name', p.name), make('span', 'pl-count', plural(steps.length, 'step')));
    const chain = make('ol', 'pl-chain');
    for (const s of steps) chain.append(make('li', 'pl-chip', `${labelFor(String(s.model))} · ${effortLabel(s.effort)}`));
    const actions = make('div', 'pl-actions');
    const go = MuseUI.button('primary small', 'Run');
    go.disabled = Boolean(run?.active) || !steps.length;
    go.addEventListener('click', () => openRun(p));
    const edit = MuseUI.button('ghost small', 'Edit');
    edit.addEventListener('click', () => openEditor(p));
    const remove = MuseUI.button('ghost small', 'Delete');
    remove.addEventListener('click', () => removePipeline(p, remove));
    actions.append(go, edit, remove);
    card.append(head, chain, actions);
    return card;
  }

  // Asks first, then deletes, and shows the server's list.
  async function removePipeline(p, button) {
    if (!confirm(`Delete the pipeline "${p.name}"? This cannot be undone.`)) return;
    const project = MuseUI.state.activeProject;
    button.disabled = true;
    try {
      const data = await MuseUI.api('/api/pipelines/delete', { project, name: p.name });
      // The answer is the newest list, so a load still on its way must not paint over it.
      loadSeq++;
      items = { project, list: Array.isArray(data?.pipelines) ? data.pipelines : [] };
      if (run && !run.active && run.project === project && run.name === p.name) run = null;
      MuseUI.toast(`Deleted the pipeline "${p.name}"`);
      show();
    } catch (err) {
      button.disabled = false;
      MuseUI.toast(err.message, 'bad');
    }
  }

  // ---------- the editor ----------

  const newStep = template => ({ ref: '', effort: EFFORTS.includes(MuseUI.state.effort) ? MuseUI.state.effort : 'high', template });

  function openEditor(p) {
    const project = MuseUI.state.activeProject;
    editor = p
      ? { project, isNew: false, name: p.name, steps: stepsOf(p).map(s => ({ ref: String(s.model ?? ''), effort: EFFORTS.includes(s.effort) ? s.effort : 'high', template: String(s.template ?? '') })) }
      : { project, isNew: true, name: '', steps: [newStep('{input}')] };
    if (!editor.steps.length) editor.steps.push(newStep('{input}'));
    mode = 'edit';
    show();
    view.root.querySelector(p ? '.pl-step textarea' : '.pl-name-input')?.focus();
  }

  function drawEditor() {
    const root = view.root;
    root.replaceChildren(make('p', 'pl-intro', EDIT_HINT));

    const nameInput = make('input', 'pl-input pl-name-input');
    nameInput.type = 'text';
    nameInput.maxLength = NAME_MAX;
    nameInput.placeholder = 'Draft and review';
    nameInput.autocomplete = 'off';
    nameInput.spellcheck = false;
    nameInput.value = editor.name;
    // A saved pipeline is found by its name, so the name stays put while the pipeline is edited.
    nameInput.disabled = !editor.isNew;
    nameInput.addEventListener('input', () => { editor.name = nameInput.value; });
    const nameHint = make('span', 'pl-hint', editor.isNew ? `1 to ${NAME_MAX} characters.` : 'The name stays the same. Delete the pipeline to use another name.');
    const nameCard = make('section', 'card pl-card');
    nameCard.append(labelled('Name', nameInput, nameHint));
    root.append(nameCard);

    editor.steps.forEach((s, i) => root.append(stepCard(s, i)));

    const add = MuseUI.button('ghost small', 'Add a step');
    add.disabled = editor.steps.length >= MAX_STEPS;
    add.addEventListener('click', addStep);
    const addRow = make('div', 'pl-bar');
    addRow.append(make('p', 'pl-note', `${editor.steps.length} of ${MAX_STEPS} steps.`), add);
    root.append(addRow);

    view.result = make('p', 'pl-status');
    view.result.setAttribute('role', 'status');
    const save = MuseUI.button('primary small', 'Save pipeline');
    save.addEventListener('click', () => saveEditor(save));
    const cancel = MuseUI.button('ghost small', 'Cancel');
    cancel.addEventListener('click', () => {
      editor = null;
      mode = 'list';
      show();
    });
    const actions = make('div', 'pl-actions');
    actions.append(save, cancel);
    root.append(view.result, actions);
  }

  // One step of the draft: a model (a menu and a text field), an effort and the prompt.
  function stepCard(s, i) {
    const n = i + 1;
    const card = make('section', 'card pl-step');
    const head = make('div', 'pl-step-head');
    const tools = make('div', 'pl-step-tools');
    const up = MuseUI.button('ghost small', 'Up');
    up.disabled = i === 0;
    up.setAttribute('aria-label', `Move step ${n} up`);
    up.addEventListener('click', () => moveStep(i, -1));
    const down = MuseUI.button('ghost small', 'Down');
    down.disabled = i === editor.steps.length - 1;
    down.setAttribute('aria-label', `Move step ${n} down`);
    down.addEventListener('click', () => moveStep(i, 1));
    const remove = MuseUI.button('ghost small', 'Remove');
    remove.disabled = editor.steps.length <= MIN_STEPS;
    remove.setAttribute('aria-label', `Remove step ${n}`);
    remove.addEventListener('click', () => removeStep(i));
    tools.append(up, down, remove);
    head.append(make('span', 'pl-step-title', `Step ${n}`), tools);

    // The menu lists the models Plenum knows. The text field is what is saved, so it also takes a model that is not in the menu.
    const pick = make('select', 'pl-select');
    pick.setAttribute('aria-label', `Model for step ${n}`);
    fillModels(pick);
    const ref = make('input', 'pl-input');
    ref.type = 'text';
    ref.maxLength = REF_MAX;
    ref.autocomplete = 'off';
    ref.spellcheck = false;
    ref.placeholder = 'Or type a model, for example codex:default';
    ref.setAttribute('aria-label', `Model name for step ${n}`);
    ref.value = s.ref;
    const syncPick = () => {
      const typed = ref.value.trim().toLowerCase();
      pick.value = MuseUI.catalog.some(c => refOf(c) === typed) ? typed : '';
    };
    syncPick();
    pick.addEventListener('change', () => {
      if (!pick.value) return;
      s.ref = pick.value;
      ref.value = pick.value;
    });
    ref.addEventListener('input', () => {
      s.ref = ref.value;
      syncPick();
    });

    const effort = make('select', 'pl-select');
    effort.setAttribute('aria-label', `Effort for step ${n}`);
    for (const e of EFFORTS) effort.append(new Option(effortLabel(e), e));
    effort.value = s.effort;
    effort.addEventListener('change', () => { s.effort = effort.value; });

    const row = make('div', 'pl-row');
    row.append(labelled('Model', pick), labelled('Effort', effort));

    const area = make('textarea', 'pl-text');
    area.rows = 5;
    area.maxLength = TEMPLATE_MAX;
    area.spellcheck = false;
    area.placeholder = i === 0 ? 'The text this step sends. Use {input} for your message.' : 'The text this step sends. Use {previous} for the reply of the step before.';
    area.setAttribute('aria-label', `Prompt for step ${n}`);
    area.value = s.template;
    const count = make('span', 'pl-counter', `${s.template.length} / ${TEMPLATE_MAX}`);
    area.addEventListener('input', () => {
      s.template = area.value;
      count.textContent = `${area.value.length} / ${TEMPLATE_MAX}`;
    });

    card.append(head, row, ref, labelled('Prompt', area, count));
    return card;
  }

  // The menu of models, grouped by provider as the model menu in the top bar is.
  function fillModels(select) {
    select.append(new Option('Pick a model…', ''));
    const names = new Map(GROUPS);
    const providers = [...new Set([...GROUPS.map(g => g[0]), ...MuseUI.catalog.map(c => c.provider)])];
    for (const provider of providers) {
      const models = MuseUI.catalog.filter(c => c.provider === provider);
      if (!models.length) continue;
      const group = document.createElement('optgroup');
      group.label = names.get(provider) ?? provider;
      for (const c of models) group.append(new Option(shortLabel(c), refOf(c)));
      select.append(group);
    }
  }

  function moveStep(i, by) {
    const j = i + by;
    if (j < 0 || j >= editor.steps.length) return;
    [editor.steps[i], editor.steps[j]] = [editor.steps[j], editor.steps[i]];
    drawEditor();
  }

  function removeStep(i) {
    if (editor.steps.length <= MIN_STEPS) return;
    editor.steps.splice(i, 1);
    drawEditor();
  }

  function addStep() {
    if (editor.steps.length >= MAX_STEPS) return;
    editor.steps.push(newStep('{previous}'));
    drawEditor();
    view.root.querySelector('.pl-step:last-of-type select')?.focus();
  }

  // Shows a line under the steps. The editor is not redrawn, so typed text and focus stay where they are.
  function report(text, bad) {
    if (!view?.result) return;
    view.result.textContent = text;
    view.result.className = bad ? 'pl-status bad' : 'pl-status';
  }

  // The same rules as lib/pipelines.mjs, checked here so the answer comes at once. The server still decides.
  function editorProblem() {
    const name = editor.name.trim();
    if (name.length < 1 || name.length > NAME_MAX) return `Give the pipeline a name of 1 to ${NAME_MAX} characters.`;
    for (let i = 0; i < editor.steps.length; i++) {
      const s = editor.steps[i];
      if (!s.ref.trim()) return `Step ${i + 1}: pick a model or type one.`;
      if (!s.template.trim()) return `Step ${i + 1}: write the prompt.`;
    }
    return '';
  }

  // Checks the draft, then saves it. A success goes back to the list, drawn from the server's answer.
  async function saveEditor(button) {
    const problem = editorProblem();
    if (problem) return report(problem, true);
    const { project } = editor;
    const name = editor.name.trim();
    // A pipeline opened with Edit keeps its name (the name field is locked), so its save may replace it. A new pipeline never
    // replaces: a name that is already saved comes back as 409 and is shown under the editor (B-14).
    const replace = !editor.isNew;
    button.disabled = true;
    report('Saving…', false);
    try {
      const data = await MuseUI.api('/api/pipelines', {
        project,
        pipeline: { name, steps: editor.steps.map(s => ({ model: s.ref.trim(), effort: s.effort, template: s.template })) },
        replace,
      });
      // The answer is the newest list, so a load still on its way must not paint over it.
      loadSeq++;
      items = { project, list: Array.isArray(data?.pipelines) ? data.pipelines : [] };
      editor = null;
      mode = 'list';
      MuseUI.toast(`Saved the pipeline "${name}"`);
      show();
    } catch (err) {
      button.disabled = false;
      report(err.message, true);
    }
  }

  // ---------- the run screen ----------

  function openRun(p) {
    const project = MuseUI.state.activeProject;
    if (run?.active) {
      mode = 'run';
      return show();
    }
    run = {
      project,
      name: p.name,
      steps: stepsOf(p).map(s => ({ ref: String(s.model), label: labelFor(String(s.model)), effort: s.effort, status: 'waiting', text: '', error: '' })),
      active: false,
      started: false,
      kept: false,
      error: '',
    };
    flash = null;
    mode = 'run';
    show();
    view.message?.focus();
  }

  function drawRun() {
    const root = view.root;
    const back = MuseUI.button('ghost small', 'All pipelines');
    back.addEventListener('click', () => {
      mode = 'list';
      show();
    });
    const bar = make('div', 'pl-bar');
    bar.append(make('span', 'pl-title', run.name), back);
    root.replaceChildren(bar);

    const ask = make('section', 'card pl-card');
    ask.append(MuseUI.span('kicker', 'Message'));
    view.message = make('textarea', 'pl-text');
    view.message.rows = 4;
    view.message.maxLength = MESSAGE_MAX;
    view.message.spellcheck = false;
    view.message.placeholder = 'The message the first step starts from. In a prompt it is {input}.';
    view.message.setAttribute('aria-label', 'Message');
    view.message.value = draftMessage;
    view.message.addEventListener('input', () => {
      draftMessage = view.message.value;
      flash = null;
      paintRun();
    });
    view.message.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        startRun();
      }
    });
    view.go = MuseUI.button('primary small', 'Run');
    view.go.addEventListener('click', startRun);
    view.stop = MuseUI.button('ghost small', 'Stop');
    view.stop.addEventListener('click', stopRun);
    const actions = make('div', 'pl-actions');
    actions.append(view.go, view.stop, make('span', 'pl-keys', HINT));
    view.status = make('p', 'pl-status');
    view.status.setAttribute('role', 'status');
    ask.append(view.message, actions, view.status);

    // The final reply: shown once the last step is done, with the button that keeps it in the chat.
    view.final = make('section', 'card pl-final');
    view.final.hidden = true;
    view.finalText = make('div', 'pl-final-text');
    view.keep = MuseUI.button('primary small', 'Keep in chat');
    view.keep.addEventListener('click', keepReply);
    const finalActions = make('div', 'pl-actions');
    finalActions.append(view.keep);
    view.final.append(MuseUI.span('kicker', 'Final reply'), view.finalText, finalActions);

    view.outs = run.steps.map(makeOut);
    const list = make('div', 'pl-outs');
    list.append(...view.outs.map(o => o.root));
    root.append(ask, view.final, list);
    paintRun();
  }

  // One step's output: its model, its state and its text.
  function makeOut(s, i) {
    const root = make('section', 'pl-out');
    root.setAttribute('aria-label', `Step ${i + 1}`);
    const pill = make('span', 'pill');
    const head = make('div', 'pl-out-head');
    head.append(make('span', 'pl-out-step', `Step ${i + 1}`), make('span', 'pl-out-name', `${s.label} · ${effortLabel(s.effort)}`), pill);
    const text = make('div', 'pl-out-text');
    const error = make('p', 'pl-out-error');
    error.hidden = true;
    root.append(head, text, error);
    return { root, pill, text, error };
  }

  // Brings the controls, the status line, the final reply and the step outputs up to date with the run.
  function paintRun() {
    if (!view?.outs || !run) return;
    const busy = run.active;
    view.message.readOnly = busy;
    view.go.hidden = busy;
    view.go.disabled = !MuseUI.state.activeProject;
    view.stop.hidden = !busy;
    paintStatus();
    run.steps.forEach((s, i) => {
      const out = view.outs[i];
      out.pill.textContent = STATUS_TEXT[s.status];
      out.pill.className = s.status === 'done' ? 'pill ok' : s.status === 'failed' ? 'pill bad' : 'pill';
      // The reply follows its newest words, unless the reader has scrolled up to read earlier ones.
      const near = out.text.scrollHeight - out.text.scrollTop - out.text.clientHeight < 40;
      if (out.text.textContent !== s.text) out.text.textContent = s.text;
      out.text.dataset.empty = s.status === 'waiting' ? 'Waiting for the steps before it…' : s.status === 'skipped' ? 'This step did not run.' : s.status === 'writing' ? 'Waiting for the first words…' : '';
      if (near) out.text.scrollTop = out.text.scrollHeight;
      out.error.hidden = !s.error;
      out.error.textContent = s.error;
    });
    const last = run.steps.at(-1);
    const finalText = last?.status === 'done' ? last.text : '';
    view.final.hidden = !finalText;
    if (finalText && view.finalText.textContent !== finalText) view.finalText.textContent = finalText;
    view.keep.disabled = busy || run.kept || !finalText;
    view.keep.textContent = run.kept ? 'Kept in the chat' : 'Keep in chat';
  }

  // The line under the controls: what to do next, what a run is doing, or how the last one ended.
  function paintStatus() {
    let text = 'Write a message, then press Run.';
    let bad = false;
    const failed = run.steps.findIndex(s => s.status === 'failed');
    if (!MuseUI.state.activeProject) {
      text = 'Add a project folder first.';
      bad = true;
    } else if (flash) {
      text = flash.text;
      bad = flash.bad;
    } else if (run.active) {
      const at = Math.max(0, run.steps.findIndex(s => s.status === 'writing'));
      text = `Step ${at + 1} of ${run.steps.length}: ${run.steps[at].label}.`;
    } else if (run.error) {
      text = run.error;
      bad = true;
    } else if (failed >= 0) {
      text = `Step ${failed + 1} failed, so the steps after it did not run.`;
      bad = true;
    } else if (run.steps.some(s => s.status === 'stopped')) {
      text = 'Stopped.';
    } else if (run.started && run.steps.every(s => s.status === 'done')) {
      text = 'Done. Keep the final reply to add it to the chat.';
    }
    view.status.textContent = text;
    view.status.className = bad ? 'pl-status bad' : 'pl-status';
  }

  // Text arrives in many small pieces, so the page is redrawn at most once per frame.
  function schedule() {
    if (painting) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      paintRun();
    });
  }

  // ---------- running ----------

  async function startRun() {
    if (!run || run.active) return;
    const project = MuseUI.state.activeProject;
    const message = draftMessage.trim();
    flash = null;
    if (!project) flash = { text: 'Add a project folder first.', bad: true };
    else if (!message) flash = { text: 'Write a message first.', bad: true };
    if (flash) return paintRun();

    const current = run;
    current.project = project;
    current.message = message;
    current.steps = current.steps.map(s => ({ ...s, status: 'waiting', text: '', error: '' }));
    current.active = true;
    current.started = true;
    current.kept = false;
    current.error = '';
    userStopped = false;
    controller = new AbortController();
    // The steps are new, so the screen is built again from them.
    show();
    try {
      const res = await MuseUI.request('/api/pipelines/run', {
        method: 'POST',
        body: { project, name: current.name, message },
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      // The run's id is claimed from its first event, so the events channel does not draw this run as one started in another window.
      await readSSE(res, ev => {
        MuseUI.claimRun?.(ev.runId);
        onEvent(current, ev);
      });
    } catch (err) {
      if (err.name !== 'AbortError') current.error = err.message;
    } finally {
      controller = null;
      current.active = false;
      // A step that never finished is stopped when the user stopped the run, and failed otherwise. A step that never started did not run.
      for (const s of current.steps) {
        if (s.status === 'writing') {
          s.status = userStopped ? 'stopped' : 'failed';
          s.error = userStopped ? '' : (current.error || 'The connection ended before this reply finished.');
        } else if (s.status === 'waiting') {
          s.status = 'skipped';
        }
      }
      paintRun();
    }
  }

  // Stop asks the server to cancel, the same way the chat's Stop does, and closes the stream.
  function stopRun() {
    if (!controller || !run) return;
    userStopped = true;
    MuseUI.api('/api/cancel', { project: run.project }).catch(() => {});
    controller.abort();
  }

  // Folds one server event into the run: a delta extends its step's text, and step-done ends that step.
  function onEvent(current, ev) {
    const s = Number.isInteger(ev.step) ? current.steps[ev.step] : null;
    if (ev.type === 'step-start' && s) {
      s.status = 'writing';
    } else if (ev.type === 'delta' && s) {
      s.status = 'writing';
      s.text += ev.text;
    } else if (ev.type === 'step-done' && s) {
      s.text = typeof ev.text === 'string' ? ev.text : s.text;
      if (ev.ok) {
        s.status = 'done';
        s.error = '';
      } else if (ev.error === 'Stopped.') {
        s.status = 'stopped';
        s.error = '';
      } else {
        s.status = 'failed';
        s.error = ev.error || 'No reply came back.';
      }
    } else if (ev.type === 'error') {
      current.error = ev.message || 'The run failed.';
    }
    schedule();
  }

  // Reads a server-sent stream and hands each JSON event to handle. The framing is the same one app.js reads.
  async function readSSE(res, handle) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (data) handle(JSON.parse(data));
      }
    }
  }

  // ---------- keeping the final reply ----------

  // Keep writes the message and the final reply into the chat, then closes the drawer so the chat shows them.
  async function keepReply() {
    const current = run;
    const last = current?.steps.at(-1);
    if (!current || current.active || current.kept || last?.status !== 'done') return;
    if (current.project !== MuseUI.state.activeProject) {
      flash = { text: 'Switch back to the project this pipeline ran in, then keep the reply.', bad: true };
      return paintRun();
    }
    current.kept = true;
    flash = null;
    paintRun();
    try {
      await MuseUI.api('/api/pipelines/keep', { project: current.project, prompt: current.message, model: last.ref, text: last.text });
      MuseUI.toast('Kept the final reply. It is in the chat.');
      draftMessage = '';
      MuseUI.closeDrawer();
      MuseUI.refresh();
    } catch (err) {
      current.kept = false;
      flash = { text: err.message, bad: true };
      paintRun();
    }
  }

  // Attach. The entry is added once, above Accounts, when the panel script loads.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.accountsBtn.before(sideButton());
})();
