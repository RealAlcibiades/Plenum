// Isolated copies of a project for its threads (pro-02). Loaded by ext.js after ext-threads.js, and adds itself through window.MuseUI.
//
// A thread can work in an isolated copy: a git worktree on its own branch, in a folder outside the project, so several threads can change the
// same repository without overwriting each other. The server does the git work (lib/worktree.mjs, lib/routes/worktrees.mjs) and this file shows
// it. Three parts:
//   1. The New thread drawer (window.MuseThreadDialogExtras, through the threadDialogExtras slot): the checkbox "Work in an isolated copy (git
//      worktree)", shown only for a git repository, and a details section "Copy settings" (setup command, its time limit, files to copy).
//      The same copy settings are a section of Settings > This project (MuseUI.settings, "Isolated copies").
//   2. The thread header row (MuseUI.threads.header): for the thread on screen, a chip "plenum/fix-login · 3 files changed" with Review diff,
//      Keep branch, Discard and Merge into <base>. While the copy is being made it shows the progress; when it failed, Try again and Use the
//      project folder (read-only); when the folder is gone, Discard. Keep branch opens a drawer for the commit message. Discard asks first, with
//      a box for the branch. Merge into <base> is a drawer that streams the merge and shows the server's click-only approval card.
//   3. Closing a thread that has a ready copy (its "..." menu) opens a choice of Keep branch or Discard instead of closing.
// Every piece of text from the server or the user is set with textContent. Nothing here sets an inline style or a style attribute.
(function () {
  const MU = window.MuseUI;
  // app.js defines MuseUI, and ext-threads.js adds the thread header row. Without them there is nothing to attach to.
  if (!MU || !MU.threads || !MU.threads.header || !MU.threads.onRender || typeof MU.api !== 'function' || typeof MU.request !== 'function') return;
  const T = MU.threads;

  const enc = encodeURIComponent;
  const POLL_MS = 30_000;
  const STATUS_MIN_MS = 1500;
  const WANT_MS = 60_000;
  const MESSAGE_MAX = 200;
  const SETUP_MAX = 300;
  const TIMEOUT = { min: 5, max: 900, default: 120 };
  const COPY_MAX = 20;
  const TEXT_PLAN_OFF = 'Turn plan mode off first';
  const TEXT_RUNNING = 'Stop the run first';

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function btn(cls, text, title, onClick) {
    const b = make('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  const state = () => MU.state;
  const activeProject = () => state().activeProject ?? null;
  const threadList = () => (Array.isArray(state().threads) ? state().threads : []);
  const threadById = id => threadList().find(t => t.id === id) ?? null;
  const activeThread = () => threadById(state().activeThread);
  const projectRecord = () => (state().projects ?? []).find(p => p.id === activeProject()) ?? null;
  const planOn = t => projectRecord()?.chatMode === 'plan' || t?.chatMode === 'plan';
  // The server's message without a full stop at the end, so a sentence made of it ends with exactly one.
  const bare = text => String(text ?? '').trim().replace(/\.+$/, '');

  // What this window knows about each thread's copy besides the page state: the file count, the log of the last create, a live line.
  const known = new Map();
  function info(id) {
    let u = known.get(id);
    if (!u) {
      u = { files: null, clean: null, statusAt: 0, seq: 0, working: false, text: '', log: [], merged: false, wasRunning: false };
      known.set(id, u);
    }
    return u;
  }

  // ---------- reading a server-sent stream ----------

  async function readEvents(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.indexOf('\n\n');
      while (cut >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev = null;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            ev = null;
          }
          if (!ev) continue;
          // The run of this window's own request: the events channel must not draw it again as a run of another window.
          if (typeof ev.runId === 'string') MU.claimRun?.(ev.runId);
          onEvent(ev);
        }
        cut = buf.indexOf('\n\n');
      }
    }
  }

  async function refusalOf(res) {
    const data = await res.json().catch(() => ({}));
    return data.error || `Request failed (${res.status})`;
  }

  // ---------- the copy settings (the New thread drawer and Settings > This project) ----------

  const NOTE_SETTINGS = 'These settings belong to the project. Every new isolated copy gets them: the setup command runs in the copy through the blocked-commands list, and the listed files are copied in.';

  // Builds the form for one project into `host`. `saved` is what the server holds. Resolves nothing; it saves with its own button.
  function settingsForm(host, pid, saved) {
    const setup = make('input', 'ext-wt-input');
    setup.type = 'text';
    setup.maxLength = SETUP_MAX;
    setup.autocomplete = 'off';
    setup.spellcheck = false;
    setup.placeholder = 'npm ci';
    setup.value = saved.setup ?? '';
    setup.setAttribute('aria-label', 'Setup command');
    const limit = make('input', 'ext-wt-input ext-wt-number');
    limit.type = 'number';
    limit.min = String(TIMEOUT.min);
    limit.max = String(TIMEOUT.max);
    limit.step = '1';
    limit.value = String(saved.setupTimeoutSec ?? TIMEOUT.default);
    limit.setAttribute('aria-label', 'Time limit (seconds)');
    const files = make('textarea', 'ext-wt-input ext-wt-files');
    files.rows = 4;
    files.spellcheck = false;
    files.placeholder = '.env';
    files.value = (Array.isArray(saved.copy) ? saved.copy : []).join('\n');
    files.setAttribute('aria-label', 'Files to copy into each copy');
    const status = make('span', 'field-note ext-wt-status-line');
    status.setAttribute('role', 'status');
    const save = btn('primary small', 'Save copy settings', 'Save the setup command, its time limit and the files to copy');

    const field = (label, control, note) => {
      const row = make('label', 'ext-wt-field');
      row.append(make('span', 'field-label', label), control);
      if (note) row.append(make('span', 'field-note', note));
      return row;
    };
    host.append(
      make('p', 'ext-thread-note', NOTE_SETTINGS),
      field('Setup command', setup, `Runs once in each new copy, for example to install dependencies. At most ${SETUP_MAX} characters.`),
      field('Time limit (seconds)', limit, `From ${TIMEOUT.min} to ${TIMEOUT.max}. A setup that runs longer is stopped.`),
      field('Files to copy into each copy', files, `Untracked files the copy needs, such as .env. Credential folders are never copied. One project-relative path per line, at most ${COPY_MAX}, each at most 1 MB.`),
    );
    const actions = make('div', 'ext-wt-actions-row');
    actions.append(save, status);
    host.append(actions);

    save.addEventListener('click', async () => {
      save.disabled = true;
      status.textContent = 'Saving…';
      status.classList.remove('bad');
      try {
        const data = await MU.api('/api/worktree-settings', {
          project: pid,
          setup: setup.value,
          setupTimeoutSec: limit.value === '' ? TIMEOUT.default : Number(limit.value),
          copy: files.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean),
        });
        setup.value = data.setup ?? '';
        limit.value = String(data.setupTimeoutSec ?? TIMEOUT.default);
        files.value = (data.copy ?? []).join('\n');
        status.textContent = 'Saved';
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('bad');
      } finally {
        save.disabled = false;
      }
    });
  }

  // The Settings > This project section "Isolated copies".
  function renderSettingsSection(card) {
    const pid = activeProject();
    if (!pid) {
      card.append(MU.para('Add a project folder first. Each project keeps its own copy settings.'));
      return;
    }
    const body = make('div', 'ext-wt-form');
    card.append(body);
    body.append(MU.para('Loading the copy settings…'));
    MU.api(`/api/worktrees/info?project=${enc(pid)}`)
      .then(data => {
        if (!body.isConnected) return;
        body.replaceChildren();
        if (!data.repo) {
          body.append(MU.para(data.noGit ? 'git is not installed, so threads cannot work in isolated copies.' : 'This folder is not a git repository, so threads share the folder and one of them is the writer.'));
          return;
        }
        body.append(make('p', 'ext-thread-note', `Copies are kept in ${data.root}, outside the project and outside OneDrive. Tick "Work in an isolated copy" in the New thread panel to give a thread one.`));
        settingsForm(body, pid, data.settings);
      })
      .catch(err => {
        if (body.isConnected) body.replaceChildren(MU.para(err.message));
      });
  }

  // ---------- the New thread drawer ----------

  // Set when the person submits the New thread panel with the box ticked: this window then makes the copy of the thread that comes back.
  let wantAt = 0;

  function dialogExtra(container, ctx) {
    const wrap = make('div', 'ext-wt-dialog');
    wrap.hidden = true;
    const box = make('input', 'ext-wt-toggle');
    box.type = 'checkbox';
    const row = make('label', 'ext-thread-check');
    row.append(box, make('span', '', 'Work in an isolated copy (git worktree)'));
    const help = make('p', 'ext-thread-note', 'The thread works on its own branch in a folder outside this project, so it cannot overwrite another thread\'s edits.');
    const details = make('details', 'ext-wt-details');
    details.append(make('summary', '', 'Copy settings'));
    const form = make('div', 'ext-wt-form');
    details.append(form);
    wrap.append(row, help, details);
    container.append(wrap);

    // The plan box says the new thread is read-only while another thread is the writer. A thread with its own copy is not, so the box is
    // freed while this one is ticked and put back as it was when it is not.
    let saved = null;
    box.addEventListener('change', () => {
      const plan = ctx?.plan;
      if (!plan) return;
      const note = plan.closest('form')?.querySelector('.ext-thread-note');
      if (box.checked) {
        saved = { disabled: plan.disabled, checked: plan.checked, noteHidden: note ? note.hidden : false };
        plan.disabled = false;
        plan.checked = false;
        if (note) note.hidden = true;
      } else if (saved) {
        plan.disabled = saved.disabled;
        plan.checked = saved.checked;
        if (note) note.hidden = saved.noteHidden;
        saved = null;
      }
    });

    const pid = ctx?.project?.id;
    if (pid) {
      MU.api(`/api/worktrees/info?project=${enc(pid)}`)
        .then(data => {
          // A folder that is not a repository, or no git, shows no toggle at all.
          if (!container.isConnected || !data.repo) return;
          wrap.hidden = false;
          settingsForm(form, pid, data.settings);
        })
        .catch(() => {
          // Without the answer the box stays hidden, and threads share the folder as before.
        });
    }
    return {
      fields() {
        if (!box.checked) return {};
        wantAt = Date.now();
        return { worktree: true };
      },
    };
  }

  try {
    MU.slots.add('threadDialogExtras', 'worktree', dialogExtra, 20);
  } catch {
    window.MuseThreadDialogExtras = Array.isArray(window.MuseThreadDialogExtras) ? window.MuseThreadDialogExtras : [];
    window.MuseThreadDialogExtras.push(dialogExtra);
  }
  if (MU.settings && typeof MU.settings.register === 'function') {
    MU.settings.register({ id: 'worktrees', scope: 'project', title: 'Isolated copies', order: 55, render: renderSettingsSection });
  }

  // ---------- making a copy ----------

  const making = new Set();

  async function startCreate(id) {
    if (making.has(id)) return;
    making.add(id);
    const u = info(id);
    u.working = true;
    u.text = 'Creating an isolated copy…';
    u.log = [];
    paintBar();
    try {
      const res = await MU.request('/api/worktrees/create', { method: 'POST', body: { project: activeProject(), thread: id } });
      if (!res.ok) throw new Error(await refusalOf(res));
      await readEvents(res, ev => {
        if (ev.type === 'notice' && typeof ev.text === 'string') {
          u.text = ev.text;
          u.log.push({ text: ev.text, output: typeof ev.output === 'string' ? ev.output : '', bad: ev.kind === 'worktree-failed' || ev.kind === 'worktree-setup-failed', failure: ev.kind === 'worktree-failed' });
          paintBar();
        } else if (ev.type === 'error') {
          u.log.push({ text: String(ev.message ?? 'The copy could not be made.'), output: '', bad: true, failure: false });
        }
      });
    } catch (err) {
      MU.toast(err.message, 'bad');
    } finally {
      making.delete(id);
      u.working = false;
      u.text = '';
      try {
        await MU.refresh();
      } catch {
        // The events channel brings the state anyway.
      }
      refreshStatus(id, true);
      paintBar();
    }
  }

  // ---------- the file count in the chip ----------

  async function refreshStatus(id, force = false) {
    const t = threadById(id);
    if (!t?.worktree || t.worktree.state !== 'ready') return;
    const u = info(id);
    const now = Date.now();
    if (!force && now - u.statusAt < STATUS_MIN_MS) return;
    u.statusAt = now;
    const seq = ++u.seq;
    try {
      const data = await MU.api(`/api/worktrees/status?project=${enc(activeProject())}&thread=${enc(id)}`);
      if (seq !== u.seq) return;
      u.files = Number.isInteger(data.files) ? data.files : null;
      u.clean = data.clean === true;
      paintBar();
    } catch {
      // The chip keeps its last count; a closed thread or a lost connection is not worth a message.
    }
  }

  // ---------- the bar in the thread header row ----------

  const bar = make('div', 'ext-wt-bar');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Isolated copy');
  let barSig = '';
  let attached = false;

  function attach(on) {
    if (on && !attached) {
      T.header.append(bar);
      attached = true;
      T.repaint?.();
    } else if (!on && attached) {
      bar.remove();
      attached = false;
      barSig = '';
      bar.replaceChildren();
      T.repaint?.();
    }
  }

  const filesText = n => `${n} ${n === 1 ? 'file' : 'files'} changed`;

  function paintBar() {
    const t = activeThread();
    const wt = t?.worktree;
    if (!t || !wt) {
      attach(false);
      return;
    }
    const u = info(t.id);
    const busy = Boolean(t.running) || making.has(t.id);
    const plan = planOn(t);
    const sig = JSON.stringify([t.id, t.name, wt.state, wt.branch, wt.base, wt.baseKind, wt.error, u.files, u.working, u.text, u.log, busy, plan, u.merged]);
    if (sig === barSig && attached) return;
    barSig = sig;
    const parts = [];
    const lock = why => (busy ? TEXT_RUNNING : plan ? TEXT_PLAN_OFF : why);

    if (wt.state === 'ready') {
      const label = u.files === null ? wt.branch : `${wt.branch} · ${filesText(u.files)}`;
      const chip = make('span', 'ext-wt-chip', label);
      chip.title = `An isolated copy of ${wt.base}${wt.path ? ` in ${wt.path}` : ''}`;
      const review = btn('ghost small', 'Review diff', 'Show what this copy changed in the Review pane', () => MU.pane?.open?.('review'));
      const keep = btn('ghost small', 'Keep branch', lock('Commit the changes on the branch and remove the folder'), () => openKeep(t.id));
      const discard = btn('ghost small danger', 'Discard', lock('Remove the folder and the changes in it'), () => discardCopy(t.id));
      keep.disabled = busy || plan;
      discard.disabled = busy || plan;
      parts.push(chip, review, keep, discard);
      if (u.merged) {
        const remove = btn('ghost small', 'Remove the isolated copy', lock('Remove the folder; the branch stays'), () => removeMerged(t.id));
        remove.disabled = busy || plan;
        parts.push(remove);
      } else if (wt.baseKind === 'branch' && wt.base) {
        const merge = btn('ghost small', `Merge into ${wt.base}`, lock(`Merge ${wt.branch} into ${wt.base} after you have seen the whole diff`), () => openMerge(t.id));
        merge.disabled = busy || plan;
        parts.push(merge);
      }
    } else if (wt.state === 'creating') {
      const line = make('span', 'ext-wt-text ext-wt-working', u.text || 'Creating an isolated copy…');
      line.setAttribute('role', 'status');
      parts.push(line);
    } else if (wt.state === 'failed') {
      parts.push(make('span', 'ext-wt-text bad', `The isolated copy could not be made: ${bare(wt.error) || 'it was not made'}.`));
      const again = btn('primary small', 'Try again', 'Make the copy again', () => startCreate(t.id));
      again.disabled = busy;
      const use = btn('ghost small', 'Use the project folder (read-only)', 'Give up the copy; this thread then reads the project folder and cannot change it', () => useProject(t.id));
      use.disabled = busy;
      parts.push(again, use);
    } else if (wt.state === 'missing') {
      parts.push(make('span', 'ext-wt-text bad', 'This thread\'s isolated copy is missing. Discard it, or close the thread.'));
      const discard = btn('ghost small danger', 'Discard', lock('Forget the copy and close the thread'), () => discardCopy(t.id));
      discard.disabled = busy || plan;
      parts.push(discard);
    } else {
      parts.push(make('span', 'ext-wt-text ext-wt-working', 'Updating the isolated copy…'));
    }
    const row = make('div', 'ext-wt-row');
    row.append(...parts);
    const out = [row];
    // A failed copy already says why in the row above, so its log keeps only what else was said (the files copied, the setup).
    const lines = wt.state === 'failed' ? u.log.filter(l => !l.failure) : u.log;
    if (lines.length && wt.state !== 'creating') out.push(logEl(u, lines));
    bar.replaceChildren(...out);
    attach(true);
  }

  function logEl(u, lines) {
    const d = make('details', 'ext-wt-log');
    const failed = lines.some(l => l.bad);
    d.open = failed;
    d.append(make('summary', failed ? 'bad' : '', 'Copy log'));
    for (const line of lines) {
      d.append(make('div', line.bad ? 'ext-wt-log-line bad' : 'ext-wt-log-line', line.text));
      if (line.output) d.append(make('pre', 'ext-wt-log-output', line.output));
    }
    d.append(btn('ghost small', 'Dismiss', 'Hide this log', () => {
      u.log = [];
      paintBar();
    }));
    return d;
  }

  // ---------- Keep branch ----------

  function nameOf(id) {
    return threadById(id)?.name ?? 'thread';
  }

  function openKeep(id) {
    const t = threadById(id);
    if (!t?.worktree) return;
    MU.openDrawer('Keep branch', body => {
      const wt = threadById(id)?.worktree ?? t.worktree;
      body.append(make('p', 'ext-thread-intro', `Commits the changes in this isolated copy on ${wt.branch} and removes the folder. The branch stays in your repository, and this thread is closed with its chat kept.`));
      const form = make('form', 'ext-wt-form');
      const input = make('input', 'ext-wt-input');
      input.type = 'text';
      input.maxLength = MESSAGE_MAX;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = `Plenum thread: ${nameOf(id)}`.slice(0, MESSAGE_MAX);
      input.setAttribute('aria-label', 'Commit message');
      const label = make('label', 'ext-wt-field');
      label.append(make('span', 'field-label', 'Commit message'), input, make('span', 'field-note', 'One line, at most 200 characters.'));
      const problem = make('p', 'ext-thread-note bad');
      problem.hidden = true;
      problem.setAttribute('role', 'alert');
      const go = make('button', 'primary', 'Commit and keep branch');
      go.type = 'submit';
      form.append(label, go, problem);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        go.disabled = true;
        problem.hidden = true;
        try {
          const data = await MU.api('/api/worktrees/keep', { project: activeProject(), thread: id, message: input.value });
          known.delete(id);
          T.adopt(data);
          MU.closeDrawer();
          MU.toast(`Kept branch ${wt.branch}. The isolated copy was removed.`);
          if (data.kept?.note) MU.toast(data.kept.note, 'ok', 6000);
        } catch (err) {
          problem.textContent = err.message;
          problem.hidden = false;
          go.disabled = false;
        }
      });
      body.append(form);
      queueMicrotask(() => input.focus());
    });
  }

  // ---------- Discard ----------

  async function discardCopy(id) {
    const t = threadById(id);
    if (!t?.worktree) return;
    const branch = t.worktree.branch;
    const check = { label: 'Also delete the branch', checked: false };
    const sure = await MU.confirm({
      title: 'Discard the isolated copy',
      body: `Discard this thread's isolated copy? Changes that were not committed in it are lost. The branch ${branch ?? ''} is kept unless you tick the box.`,
      action: 'Discard',
      tone: 'danger',
      check,
    });
    if (!sure) return;
    try {
      const data = await MU.api('/api/worktrees/discard', { project: activeProject(), thread: id, deleteBranch: check.checked === true });
      known.delete(id);
      T.adopt(data);
      const gone = data.discarded?.branchDeleted === true;
      MU.toast(gone ? `Discarded the isolated copy and deleted ${branch}.` : `Discarded the isolated copy. The branch ${branch} is kept.`);
      if (data.discarded?.warning) MU.toast(data.discarded.warning, 'bad');
    } catch (err) {
      MU.toast(err.message, 'bad');
    }
  }

  async function useProject(id) {
    try {
      const data = await MU.api('/api/worktrees/use-project', { project: activeProject(), thread: id });
      known.delete(id);
      T.adopt(data);
      MU.toast('This thread now reads the project folder and cannot change it.');
    } catch (err) {
      MU.toast(err.message, 'bad');
    }
  }

  // After a merge, the copy can go; the branch is already in the base, and it stays.
  async function removeMerged(id) {
    const t = threadById(id);
    const branch = t?.worktree?.branch ?? '';
    try {
      const data = await MU.api('/api/worktrees/keep', { project: activeProject(), thread: id });
      known.delete(id);
      T.adopt(data);
      MU.toast(`Removed the isolated copy. The branch ${branch} is kept.`);
    } catch (err) {
      MU.toast(err.message, 'bad');
    }
  }

  // ---------- Merge into the base (Phase 2) ----------

  function openMerge(id) {
    const t = threadById(id);
    if (!t?.worktree) return;
    const wt = t.worktree;
    MU.openDrawer(`Merge into ${wt.base}`, body => {
      body.append(make('p', 'ext-thread-intro', `Merges ${wt.branch} into ${wt.base} in the project folder. The copy's changes are committed on its branch first. You see the whole diff on a card and decide; nothing is forced, and if files conflict Plenum lists them, stops the merge and changes nothing.`));
      const status = make('p', 'ext-wt-merge-status');
      status.setAttribute('role', 'status');
      const cards = make('div', 'ext-wt-cards');
      const go = make('button', 'primary', 'Show the diff and merge');
      go.type = 'button';
      body.append(go, status, cards);
      const say = (text, tone) => {
        status.textContent = text;
        status.classList.toggle('bad', tone === 'bad');
      };
      go.addEventListener('click', async () => {
        go.disabled = true;
        say('Committing the copy and reading the diff…');
        const ctl = new AbortController();
        // Closing the drawer cancels the merge: the card is denied and nothing is merged.
        const watch = setInterval(() => {
          if (!body.isConnected || MU.el.drawer?.hidden) {
            clearInterval(watch);
            ctl.abort();
          }
        }, 500);
        let finished = false;
        try {
          const res = await MU.request('/api/worktrees/merge', { method: 'POST', body: { project: activeProject(), thread: id }, signal: ctl.signal });
          if (!res.ok) throw new Error(await refusalOf(res));
          await readEvents(res, ev => {
            if (ev.type === 'notice' && typeof ev.text === 'string') say(ev.text);
            else if (ev.type === 'approval') {
              say('Waiting for you. Read the diff, then Approve or Deny.');
              cards.replaceChildren(MU.approvalEl(ev, { reason: false }));
            } else if (ev.type === 'approval-closed') {
              cards.replaceChildren();
            } else if (ev.type === 'merged') {
              finished = true;
              cards.replaceChildren();
              info(id).merged = true;
              say(ev.text ?? `Merged ${wt.branch} into ${wt.base}.`);
              MU.toast(`Merged ${wt.branch} into ${wt.base}.`);
            } else if (ev.type === 'conflict') {
              finished = true;
              cards.replaceChildren();
              say(ev.text ?? 'Merge stopped: files conflict. Nothing was merged.', 'bad');
            } else if (ev.type === 'declined') {
              finished = true;
              cards.replaceChildren();
              say(ev.nothing ? 'There is nothing to merge: the branch has no commits beyond the base.' : 'Nothing was merged.');
            } else if (ev.type === 'error') {
              finished = true;
              cards.replaceChildren();
              say(String(ev.message ?? 'The merge did not finish. Nothing was merged.'), 'bad');
            }
          });
          if (!finished) say('The merge stopped before it finished. Nothing was merged.');
        } catch (err) {
          if (err.name === 'AbortError') MU.toast('The merge was cancelled. Nothing was merged.');
          else say(err.message, 'bad');
        } finally {
          clearInterval(watch);
          go.disabled = false;
          try {
            await MU.refresh();
          } catch {
            // The events channel brings the state anyway.
          }
          refreshStatus(id, true);
          paintBar();
        }
      });
    });
  }

  // ---------- closing a thread that has a ready copy ----------

  function closeChoice(id) {
    const t = threadById(id);
    if (!t?.worktree) return;
    MU.openDrawer('Close this thread', body => {
      body.append(make('p', 'ext-thread-intro', `${t.name} has an isolated copy on ${t.worktree.branch}. Keep the branch or discard the copy before the thread closes. The chat is kept either way.`));
      const row = make('div', 'ext-wt-actions-row');
      row.append(
        btn('primary', 'Keep branch…', 'Commit the changes on the branch and remove the folder', () => openKeep(id)),
        btn('ghost danger', 'Discard…', 'Remove the folder and the changes in it', () => {
          MU.closeDrawer();
          discardCopy(id);
        }),
      );
      body.append(row);
    });
  }

  // The "..." menu of a tab closes a thread through POST /api/threads/close. For a thread with a ready copy the server refuses (409), and this
  // shows the choice the refusal asks for, instead of only a message.
  const original = MU.api;
  if (!original.worktreeAware) {
    const wrapped = function (path, body, ...rest) {
      if (path === '/api/threads/close' && body && typeof body.thread === 'string') {
        const t = threadById(body.thread);
        if (t?.worktree && (t.worktree.state === 'ready' || t.worktree.state === 'closing')) {
          closeChoice(t.id);
          return Promise.reject(new Error('Choose Keep branch or Discard for the isolated copy first.'));
        }
      }
      return original.call(this, path, body, ...rest);
    };
    wrapped.worktreeAware = true;
    MU.api = wrapped;
  }

  // ---------- keeping the bar up to date ----------

  function onRender() {
    // The thread this window just asked a copy for starts making it.
    if (wantAt && Date.now() - wantAt < WANT_MS) {
      const fresh = threadList().find(t => t.worktree?.state === 'creating' && !making.has(t.id));
      if (fresh) {
        wantAt = 0;
        startCreate(fresh.id);
      }
    }
    const t = activeThread();
    for (const x of threadList()) {
      const u = info(x.id);
      // A run that just ended may have changed files.
      if (u.wasRunning && !x.running && x.worktree?.state === 'ready' && x.id === t?.id) refreshStatus(x.id, true);
      u.wasRunning = Boolean(x.running);
    }
    if (t?.worktree?.state === 'ready' && info(t.id).statusAt === 0) refreshStatus(t.id);
    paintBar();
  }

  T.onRender(onRender);
  setInterval(() => {
    if (document.hidden) return;
    const t = activeThread();
    if (t?.worktree?.state === 'ready') refreshStatus(t.id, true);
  }, POLL_MS);
  window.addEventListener('plenum:thread-waiting', () => paintBar());
  onRender();
})();
