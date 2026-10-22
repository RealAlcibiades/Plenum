// ext-approvals. The Mode menu under the message box and the app's default approval mode in Settings. Loaded by ext.js and adds
// itself through window.MuseUI.
// The button (#modeBtn in index.html) shows what sending allows in the active project: Plan, Ask first, Auto-approve or Approve all,
// with "· Focus" when Build focus is on. Its colour follows the mode (ext-approvals.css). The menu changes the active project's
// setting through MuseUI.setProjectApprovals (POST /api/project-approvals). Plan goes through POST /api/project-mode, as the Plan
// button does, and Build focus through MuseUI.toggleFocus, as the Focus button does. Approve all is asked through
// MuseUI.askApproveAll before it turns on, from here and from every other control. The app-wide default is the Approvals section
// of Settings. Every piece of text is set with textContent, and nothing is styled inline.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the button, there is nothing to attach to.
  if (!MuseUI || !MuseUI.el?.modeBtn) return;

  const btn = MuseUI.el.modeBtn;
  const wrap = btn.parentElement;
  const NAMES = MuseUI.approvalNames;   // { ask: 'Ask first', auto: 'Auto-approve', all: 'Approve all' }
  const MODES = MuseUI.approvalModes;   // ['ask', 'auto', 'all']
  // Each line says what happens, as UI-ARCH section 6 words it.
  const HELP = {
    ask: 'Every edit and command waits for you.',
    auto: 'Edits and commands run; guards still ask.',
    all: 'Every card is answered for you, including Gemini’s and Muse Code’s own; guards still ask.',
  };
  const PLAN_HELP = 'Plenum answers and plans, but edits no files and runs no commands in this project.';
  const FOCUS_HELP = 'Get the code working and run only the checks that are strictly needed. It applies from the next message.';

  // True while a change is on its way to the server, so a second click cannot send a second one.
  let busy = false;

  const activeProject = () => MuseUI.state.projects?.find(p => p.id === MuseUI.state.activeProject) ?? null;
  const focusKnown = id => (typeof MuseUI.focusOf === 'function' ? MuseUI.focusOf(id) : undefined);

  // The approval choices, one radio button with a line each. onPick(mode) runs when the user picks one. The caller decides and
  // repaints, so a refused choice goes back to the one in force.
  function choiceGroup(name, label, onPick) {
    const group = document.createElement('div');
    group.className = 'mode-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', label);
    const radios = MODES.map(mode => {
      const row = document.createElement('label');
      row.className = 'mode-choice';
      row.dataset.tone = mode;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = mode;
      input.addEventListener('change', () => { if (input.checked) onPick(mode); });
      const text = document.createElement('span');
      text.className = 'mode-choice-text';
      const title = document.createElement('strong');
      title.textContent = NAMES[mode];
      const help = document.createElement('small');
      help.textContent = HELP[mode];
      text.append(title, help);
      row.append(input, text);
      group.append(row);
      return input;
    });
    return { group, radios };
  }

  // A checkbox with a label and a line under it. onChange(checked) runs when the user changes it.
  function checkRow(label, help, onChange) {
    const row = document.createElement('label');
    row.className = 'mode-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const text = document.createElement('span');
    text.className = 'mode-choice-text';
    const title = document.createElement('strong');
    title.textContent = label;
    const small = document.createElement('small');
    small.textContent = help;
    text.append(title, small);
    row.append(input, text);
    return { row, input };
  }

  // A notice strip above the message box when Auto-approve turns on. The notices module draws it (and draws nothing until it loads).
  function noticeAuto() {
    try {
      MuseUI.notice?.('auto-approve', { before: MuseUI.el.form });
    } catch {
      // A notice is an extra. A failure here must not undo the change that was just saved.
    }
  }

  // ---------- the Mode menu ----------

  const menu = document.createElement('div');
  menu.className = 'mode-menu';
  menu.id = 'modeMenu';
  menu.hidden = true;
  menu.tabIndex = -1;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Edits and commands for this project');
  btn.setAttribute('aria-controls', 'modeMenu');

  const head = document.createElement('p');
  head.className = 'mode-head';
  const note = document.createElement('p');
  note.className = 'mode-note';

  const choices = choiceGroup('plenum-mode-menu', 'Approval mode for this project', pickMode);
  const planRow = checkRow('Plan (read-only)', PLAN_HELP, on => setPlan(on));
  const focusRow = checkRow('Build focus', FOCUS_HELP, on => setFocus(on));
  const sep = document.createElement('hr');
  sep.className = 'mode-sep';
  const sep2 = document.createElement('hr');
  sep2.className = 'mode-sep';

  const useDefault = MuseUI.button('ghost small mode-link', 'Use app default');
  useDefault.title = 'Follow the app default again for this project';
  const safety = MuseUI.button('ghost small mode-link', 'Safety settings…');
  safety.title = 'The app-wide default and the notices, in Settings';
  const foot = document.createElement('div');
  foot.className = 'mode-foot';
  foot.append(useDefault, safety);

  menu.append(head, note, choices.group, sep, planRow.row, focusRow.row, sep2, foot);
  wrap.append(menu);

  // Paints the button and the menu from the active project and the focus state. It runs after every change and whenever the
  // page redraws its top bar (the project name changes) or the focus flag changes.
  function paint() {
    const p = activeProject();
    const appMode = MODES.includes(MuseUI.state.approvals) ? MuseUI.state.approvals : 'ask';
    const mode = p && MODES.includes(p.approvals) ? p.approvals : 'ask';
    const plan = p?.chatMode === 'plan';
    const focus = p ? focusKnown(p.id) === true : false;
    const off = !p || busy;

    btn.dataset.tone = plan ? 'plan' : mode;
    btn.textContent = `${plan ? 'Plan' : NAMES[mode]}${focus ? ' · Focus' : ''}`;
    btn.disabled = !p || busy;

    head.textContent = p ? `Edits and commands in ${p.name}` : 'No project';
    if (!p) note.textContent = 'Add a project folder first. Each project keeps its own setting.';
    else if (p.ownApprovals) note.textContent = `This project sets ${NAMES[mode]}. App default: ${NAMES[appMode]}.`;
    else note.textContent = `This project follows the app default: ${NAMES[appMode]}.`;

    for (const radio of choices.radios) {
      radio.checked = radio.value === mode;
      radio.disabled = off;
    }
    planRow.input.checked = plan;
    planRow.input.disabled = off;
    focusRow.input.checked = focus;
    focusRow.input.disabled = off || focusKnown(p?.id) === undefined;
    useDefault.hidden = !(p && p.ownApprovals);
    useDefault.disabled = off;
    safety.disabled = false;
  }

  // Picks an approval mode for the active project. Approve all is asked first; Cancel leaves the mode in force.
  async function pickMode(mode) {
    const p = activeProject();
    if (!p || busy || mode === (p.approvals ?? 'ask')) return paint();
    busy = true;
    paint();
    try {
      if (mode === 'all' && !(await MuseUI.askApproveAll())) return;
      await MuseUI.setProjectApprovals({ approvals: mode }, p.id);
      if (mode === 'all') MuseUI.toast(`Approve all is on for ${p.name}. Edits and commands run without asking; credential and system folders stay blocked.`);
      else if (mode === 'auto') {
        MuseUI.toast('Edits and commands run without asking.');
        noticeAuto();
      } else MuseUI.toast('Edits and commands wait for your approval.');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  }

  // Plan is the project's chat mode, saved by the server (POST /api/project-mode). It is the same request the Plan button sends.
  async function setPlan(on) {
    const p = activeProject();
    if (!p || busy) return paint();
    busy = true;
    paint();
    try {
      const r = await MuseUI.api('/api/project-mode', { project: p.id, mode: on ? 'plan' : 'normal' });
      const current = MuseUI.state.projects?.find(x => x.id === r.project);
      if (current) current.chatMode = r.mode;
      const when = MuseUI.state.running ? ' It applies from the next message.' : '';
      MuseUI.toast(r.mode === 'plan'
        ? `Plan mode is on for ${p.name}. Plenum will not edit files or run commands there.${when}`
        : `Plan mode is off for ${p.name}.${when}`);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  }

  // Build focus is the same switch as the Focus button and /focus: MuseUI.toggleFocus (ext-focus.js).
  async function setFocus(on) {
    const p = activeProject();
    if (!p || busy || typeof MuseUI.toggleFocus !== 'function') return paint();
    busy = true;
    paint();
    try {
      await MuseUI.toggleFocus(on ? 'on' : 'off');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  }

  useDefault.addEventListener('click', async () => {
    const p = activeProject();
    if (!p || busy) return;
    busy = true;
    paint();
    try {
      await MuseUI.setProjectApprovals({ approvals: null }, p.id);
      MuseUI.toast(`${p.name} follows the app default now.`);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      busy = false;
      paint();
    }
  });

  safety.addEventListener('click', () => {
    closeMenu(false);
    MuseUI.settings?.open?.('app');
  });

  function openMenu() {
    if (btn.disabled) return;
    paint();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const current = choices.radios.find(r => r.checked) ?? choices.radios[0];
    (current ?? menu).focus();
  }

  function closeMenu(returnFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
  }

  btn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu(true)));
  // Escape closes the menu first, and stops there, so the drawer or a run under it is not touched.
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    }
  });
  // A click outside closes it. Moving focus out with Tab closes it too; a focus move to nothing (a click on the menu's own empty
  // space) does not, because there is no element to move to.
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !wrap.contains(e.target)) closeMenu(false); });
  menu.addEventListener('focusout', e => { if (!menu.hidden && e.relatedTarget && !wrap.contains(e.relatedTarget)) closeMenu(false); });

  // The page redraws its top bar, and so changes the project name, whenever its state is read again. The button is not inside the
  // project name, so painting cannot trigger the observer. Focus and approval changes are announced on window.
  new MutationObserver(paint).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });
  window.addEventListener('plenum:focus', paint);
  window.addEventListener('plenum:approvals', paint);
  paint();

  // ---------- Settings: the app-wide default ----------

  if (typeof MuseUI.settings?.register === 'function') {
    MuseUI.settings.register({
      id: 'approvals',
      scope: 'app',
      title: 'Approvals',
      order: 60,
      render(body, ctx) {
        const status = document.createElement('p');
        status.className = 'setting-status';
        status.setAttribute('role', 'status');
        const show = (text, bad) => {
          status.textContent = text;
          status.classList.toggle('bad', Boolean(bad));
        };
        const intro = MuseUI.para('The default for every project. A project that sets its own mode keeps it. The Mode menu under the message box changes the active project, and Project settings shows each project’s own choice.');
        const choiceRadios = choiceGroup('plenum-app-approvals', 'Default approval mode', pickAppMode);
        const covers = [
          ['computer', 'Approve all also answers computer-use cards', 'Sending, buying, deleting, signing in and new apps go ahead without asking while Approve all is on. The model still never types passwords.'],
          ['browser', 'Approve all also answers browser cards', 'Navigation, downloads and new sites go ahead without asking while Approve all is on. Stop ends the model’s control at once.'],
        ].map(([key, label, help]) => {
          const made = checkRow(label, help, on => saveCover(key, on, made.row));
          return { key, ...made };
        });
        body.append(intro, choiceRadios.group, ...covers.map(c => c.row), status);

        function paintApp() {
          const mode = MODES.includes(ctx.state.approvals) ? ctx.state.approvals : 'ask';
          for (const radio of choiceRadios.radios) radio.checked = radio.value === mode;
          for (const c of covers) c.input.checked = ctx.state.approveAllCovers?.[c.key] !== false;
        }

        async function pickAppMode(mode) {
          if (mode === (ctx.state.approvals ?? 'ask')) return paintApp();
          try {
            if (mode === 'all' && !(await MuseUI.askApproveAll())) return;
            await ctx.update({ approvals: mode });
            show('Saved');
          } catch (err) {
            show(err.message, true);
          } finally {
            paintApp();
          }
        }

        async function saveCover(key, on, row) {
          if (on) {
            try {
              MuseUI.notice?.('approve-all-covers', { before: row });
            } catch {
              // A notice is an extra, as above.
            }
          }
          try {
            await ctx.update({ approveAllCovers: { [key]: on } });
            show('Saved');
          } catch (err) {
            show(err.message, true);
          } finally {
            paintApp();
          }
        }

        paintApp();
      },
    });
  }
})();
