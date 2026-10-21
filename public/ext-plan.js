// Sticky plan mode in the composer. Loaded by ext.js and adds itself through window.MuseUI.
// A toggle beside the Send button turns plan mode on or off for the active project. In plan mode a chat turn is read-only:
// no file changes, no commands, no tools. The mode is a project setting kept by the server (POST /api/project-mode), so it
// survives a reload and a restart. This file keeps no copy of it: the project list in MuseUI.state carries chatMode.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TIP = 'Plan mode keeps this project’s chat read-only. Plenum answers and makes plans, but does not edit files, run commands or use tools, and the model runs in its read-only setting. The mode is saved with the project and stays on until you turn it off. It applies from the next message.';

  const wrap = document.createElement('div');
  wrap.className = 'seg plan-seg';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Plan mode');
  wrap.title = TIP;
  const btn = MuseUI.button('seg-btn plan-btn', 'Plan off');
  btn.dataset.on = 'false';
  wrap.append(btn);
  // Next to the Send button, inside the composer bar.
  MuseUI.el.send.before(wrap);

  // True while a change is on its way to the server, so a second click cannot send a second one.
  let busy = false;

  function activeProject() {
    const st = MuseUI.state;
    return st.projects?.find(p => p.id === st.activeProject) ?? null;
  }

  function paint() {
    const project = activeProject();
    const on = project?.chatMode === 'plan';
    btn.textContent = on ? 'Plan on' : 'Plan off';
    btn.dataset.on = String(on);
    btn.disabled = !project || busy;
  }

  btn.addEventListener('click', async () => {
    const project = activeProject();
    if (!project || busy) return;
    const next = project.chatMode === 'plan' ? 'normal' : 'plan';
    busy = true;
    paint();
    try {
      const r = await MuseUI.api('/api/project-mode', { project: project.id, mode: next });
      // Set on the project as it is in the page state now. The state may have been replaced while the request ran.
      // The page is not redrawn from the server here, because a redraw during a run would cut the reply off the screen.
      const current = MuseUI.state.projects?.find(p => p.id === r.project);
      if (current) current.chatMode = r.mode;
      const when = MuseUI.state.running ? ' It applies from the next message.' : '';
      MuseUI.toast(r.mode === 'plan'
        ? `Plan mode is on for ${project.name}. Plenum will not edit files or run commands there.${when}`
        : `Plan mode is off for ${project.name}.${when}`);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  });

  // The page redraws its top bar whenever it reads the state again (a reload, a project switch, the end of a run), so the
  // button follows the same changes. The button is not inside the project name, so painting cannot trigger the observer.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  paint();
})();
