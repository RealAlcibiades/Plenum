// Sticky plan mode in the composer. Loaded by ext.js and adds itself through window.MuseUI.
// A toggle beside the Send button turns plan mode on or off for the active project. In plan mode a chat turn is read-only:
// no file changes, no commands, no tools. The mode is a project setting kept by the server (POST /api/project-mode), so it
// survives a reload and a restart. This file keeps no copy of it: the project list in MuseUI.state carries chatMode.
// Threads (pro-01): the toggle belongs to the thread on screen. Main's is the project's plan mode, as before; any other thread has a plan
// mode of its own (the server sets it when the request names the thread). A thread that is not the project's writer is read-only whatever
// this says, so its toggle reads "Plan on" and explains why instead of changing anything.
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

  // The thread on screen, when the project has threads: { id, name, main, writer, chatMode }. Null for a page without them.
  function activeThread() {
    const st = MuseUI.state;
    return (st.threads ?? []).find(t => t.id === st.activeThread) ?? null;
  }

  // A thread that is not the writer is read-only by the one-writer rule (lib/scope.mjs planModeOf), so plan mode is on for it.
  function readOnlyByRule(thread) {
    return Boolean(thread) && thread.writer === false && MuseUI.state.multiWriter !== true;
  }

  // The plan mode of what is on screen: the project's, or this thread's own (Main's is the project's).
  function planOn(project, thread) {
    if (project?.chatMode === 'plan') return true;
    return Boolean(thread) && !thread.main && thread.chatMode === 'plan';
  }

  function paint() {
    const project = activeProject();
    const thread = activeThread();
    const locked = readOnlyByRule(thread);
    const on = planOn(project, thread) || locked;
    btn.textContent = on ? 'Plan on' : 'Plan off';
    btn.dataset.on = String(on);
    if (locked) btn.dataset.locked = 'true';
    else delete btn.dataset.locked;
    btn.title = locked ? `This thread is read-only because another thread is the project's writer. Make it the writer to change files.` : TIP;
    btn.disabled = !project || busy;
  }

  btn.addEventListener('click', async () => {
    const project = activeProject();
    const thread = activeThread();
    if (!project || busy) return;
    if (readOnlyByRule(thread)) {
      MuseUI.toast(`${thread.name} is read-only because another thread is this project's writer. Make it the writer from the thread's menu to let it change files.`);
      return;
    }
    const next = planOn(project, thread) ? 'normal' : 'plan';
    // Only a thread other than Main sends its id: the server then sets that thread's own mode. Main sets the project's, as before.
    const named = thread && !thread.main ? { thread: thread.id } : {};
    busy = true;
    paint();
    try {
      const r = await MuseUI.api('/api/project-mode', { project: project.id, ...named, mode: next });
      // Set on the project or the thread as it is in the page state now. The state may have been replaced while the request ran.
      // The page is not redrawn from the server here, because a redraw during a run would cut the reply off the screen.
      let who = project.name;
      if (r.thread) {
        const current = (MuseUI.state.threads ?? []).find(t => t.id === r.thread);
        if (current) {
          current.chatMode = r.mode === 'plan' ? 'plan' : null;
          who = `${project.name} · ${current.name}`;
        }
      } else {
        const current = MuseUI.state.projects?.find(p => p.id === r.project);
        if (current) current.chatMode = r.mode;
      }
      const when = MuseUI.state.running ? ' It applies from the next message.' : '';
      MuseUI.toast(r.mode === 'plan'
        ? `Plan mode is on for ${who}. Plenum will not edit files or run commands there.${when}`
        : `Plan mode is off for ${who}.${when}`);
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
  // A change of thread or of the writer redraws the page's shell without changing the title, so the toggle follows that too.
  MuseUI.threads?.onRender?.(paint);
  paint();
})();
