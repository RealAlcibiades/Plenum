// Build focus: the Focus toggle beside Send, for the active project. Loaded by ext.js and adds itself through window.MuseUI.
// The flag is saved on the project by the server (GET and POST /api/project-focus, lib/routes/focus.mjs), so it survives a reload
// and a restart. This file keeps only what the server said, per project, in a Map, and repaints from it.
// MuseUI.toggleFocus(word) is the same switch for the /focus command and the Mode menu: 'on', 'off' or '' (toggle). It resolves to
// the new state. MuseUI.focusOf(projectId) answers the last state the server gave (undefined until it has answered).
// Each change also fires a 'plenum:focus' event on window, with detail { project, on }, so another control can repaint.
// Every piece of text here is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TIP = 'Build focus tells every model in this project to get the code working and run only the checks that are strictly needed: one test file instead of the whole suite, no linters or builds unless asked, and a line naming the checks it skipped. It is saved with the project and applies from the next message. Plan mode still wins: with both on, nothing is written.';

  const wrap = document.createElement('div');
  wrap.className = 'seg focus-seg';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Build focus');
  wrap.title = TIP;
  const btn = MuseUI.button('seg-btn focus-btn', 'Focus off');
  btn.dataset.on = 'false';
  wrap.append(btn);
  // Between the Plan toggle and Send, inside the composer bar.
  if (MuseUI.el.send) MuseUI.el.send.before(wrap);

  // The flag per project id, as the server last said it. A project that is not in the map has not answered yet.
  const known = new Map();
  // Counts the changes made to each project, so a read that started before a change cannot overwrite it when it answers.
  const changes = new Map();
  // Projects with a read in flight, so switching back and forth does not start a read per switch.
  const reading = new Set();
  // True while a change is on its way to the server, so a second click cannot send a second one.
  let busy = false;
  // The project id the page showed last, so a switch is noticed and read again.
  let shown = null;

  const activeProject = () => {
    const st = MuseUI.state;
    return st.projects?.find(p => p.id === st.activeProject) ?? null;
  };

  function remember(id, on) {
    const before = known.get(id);
    known.set(id, on);
    if (before !== on) window.dispatchEvent(new CustomEvent('plenum:focus', { detail: { project: id, on } }));
  }

  // Reads the flag from the server and keeps it, unless a change to this project happened while the read was on its way.
  async function read(id) {
    const started = changes.get(id) ?? 0;
    const data = await MuseUI.api('/api/project-focus?project=' + encodeURIComponent(id));
    if ((changes.get(id) ?? 0) === started) remember(id, data.on === true);
    return known.get(id) ?? data.on === true;
  }

  // The flag for a project, read from the server first when the page has not asked for it yet.
  async function flagOf(project) {
    if (known.has(project.id)) return known.get(project.id) === true;
    return read(project.id);
  }

  // Starts a read for the project in the background. A failed read leaves the button as it is; the next switch tries again.
  function refresh(project) {
    if (reading.has(project.id)) return;
    reading.add(project.id);
    read(project.id)
      .catch(() => {})
      .finally(() => {
        reading.delete(project.id);
        paint();
      });
  }

  function paint() {
    const project = activeProject();
    const on = project ? known.get(project.id) === true : false;
    btn.textContent = on ? 'Focus on' : 'Focus off';
    btn.dataset.on = String(on);
    btn.disabled = !project || busy;
  }

  // What the page says once a change is saved. The run note only applies while a run is going.
  function announce(project, on) {
    if (on) {
      const when = MuseUI.state.running ? ' It applies from the next message.' : '';
      MuseUI.toast(`Build focus is on for ${project.name}: Plenum runs only the checks that are strictly needed and names the ones it skipped.${when}`);
    } else {
      MuseUI.toast(`Build focus is off for ${project.name}.`);
    }
  }

  // The one change: the flag is sent, the answer is kept, and the page says so. Resolves to the flag the server now holds.
  async function setFocus(project, on) {
    changes.set(project.id, (changes.get(project.id) ?? 0) + 1);
    const data = await MuseUI.api('/api/project-focus', { project: project.id, on });
    remember(project.id, data.on === true);
    return data.on === true;
  }

  btn.addEventListener('click', async () => {
    const project = activeProject();
    if (!project || busy) return;
    busy = true;
    paint();
    try {
      const current = await flagOf(project);
      const on = await setFocus(project, !current);
      announce(project, on);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  });

  // The /focus command and the Mode menu. Word: 'on', 'off' or '' to flip the current state.
  MuseUI.toggleFocus = async word => {
    const want = typeof word === 'string' ? word.trim().toLowerCase() : '';
    if (want !== '' && want !== 'on' && want !== 'off') throw new Error('Use /focus on, /focus off, or /focus by itself to switch it.');
    const project = activeProject();
    if (!project) throw new Error('Choose a project first.');
    if (busy) throw new Error('Build focus is already changing. Try again in a moment.');
    busy = true;
    paint();
    try {
      const current = await flagOf(project);
      const on = await setFocus(project, want === '' ? !current : want === 'on');
      announce(project, on);
      return on;
    } finally {
      busy = false;
      paint();
    }
  };

  MuseUI.focusOf = projectId => known.get(projectId);

  // Runs when the page shows a different project: the button repaints from what the map holds, and the flag is read again.
  function follow() {
    const project = activeProject();
    const id = project?.id ?? null;
    if (id !== shown) {
      shown = id;
      if (project) refresh(project);
    }
    paint();
  }

  // The page redraws the project name whenever it reads the state again (a reload, a project switch), so the button follows it.
  // The button is not inside the project name, so painting cannot trigger the observer.
  new MutationObserver(follow).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  follow();
})();
