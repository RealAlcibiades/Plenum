// ext-agents-settings. Owned by the agent-types builder. Builds on window.MuseUI (see app.js).
// Two Settings sections share one editor (lib/agents.mjs, GET and POST /api/agents):
//   - Settings > Agents: the app's agent types and limits, the defaults a project without its own copy uses;
//   - Project settings > Agents: the project's own copy, given by "Give this project its own agent settings", or its summary.
// Every change is one POST /api/agents with the whole block. The server checks it, refuses a bad one with a plain message, and
// answers the block it stored; "Saved" is shown only after that answer. Text is set with textContent only: no HTML, no inline
// styles, and nothing is kept in browser storage. Keys never reach this page.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load, and the settings registry is part of it.
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const APP_SECTION = 'agents';
  const PROJECT_SECTION = 'project-agents';
  const ROLE_ORDER = ['chat', 'build', 'council', 'moderator', 'relay', 'compare', 'pipeline'];
  const GROUP_ROLES = ['council', 'moderator', 'relay', 'compare', 'pipeline'];
  const GROUP_NAMES = { muse: 'Muse Code', anthropic: 'Claude', codex: 'Codex', gemini: 'Gemini', xai: 'Grok', openai: 'OpenAI', deepseek: 'DeepSeek', mistral: 'Mistral', googleai: 'Google AI', openrouter: 'OpenRouter', echo: 'Test' };
  const EFFORT_CHOICES = [['', 'Same as the asking model'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const RETURN_CHOICES = [['summary', 'A short summary'], ['findings', 'A list of findings'], ['verdict', 'A verdict with issues']];
  const RESERVED = ['researcher', 'coder', 'tester', 'reviewer', 'planner', 'agent', 'agents', 'all', 'none', 'default', 'inherit', 'explore', 'plan', 'general-purpose', 'claude-code-guide'];
  // The limits the server checks too (lib/agents.mjs CEILINGS). The page checks the same ones so a refusal is rare.
  const LIMITS = { types: 24, folders: 10, description: 300, label: 40, brief: 2000, overrides: 20, concurrent: 16, total: 64, perRun: 64, maxSteps: 500, timeoutMin: 480, idleMin: 180, nestDepth: 3 };
  // The range the research behind agent runs supports (above it a note, never a refusal).
  const RESEARCH = { concurrent: 5, maxSteps: 30, timeoutMin: 10 };
  const MANY_NOTICE = 'Many agents at once multiply cost and quota use. Agents on API models count toward the spend limit; CLI agents draw on your plans.';
  const CLI_NOTE = 'Codex and Gemini do not report their tool steps to Plenum, so only the time limits apply to them.';
  const GEMINI_EDIT = 'Gemini edits files only when Auto-approve is on. Headless Gemini cannot ask first.';
  const CODEX_EDIT = 'Codex and Gemini edit files only when Auto-approve is on: they cannot ask first.';
  const GEMINI_EFFORT = 'The Gemini CLI sets its own thinking depth';
  const MUSE_READ_NOTE = 'Muse Code has no read-only setting, so a read-only agent on it runs in an empty folder and cannot open the project\'s files.';
  const BUILD_DEFAULT_NOTE = 'In /build this is the reviewer or planner you chose (the council moderator by default).';
  const RESEARCH_TEXT = 'More than 30 steps or 10 minutes is above what the research behind agent runs supports. It still works, but a run costs more and can stall for longer.';
  const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
  const SAVED_MS = 1500;

  // The last answer from the server and the project it is for. Both editors paint from it.
  let snap = null;
  // The Show view (types or limits), kept for the session.
  let view = 'types';
  // The open type form: { mode: 'edit' | 'new', name, draft, error, moreOpen }. Its values live in draft, so a repaint keeps them.
  let editing = null;
  // The editor on screen. A load or save that finishes after its editor has gone is dropped.
  let mounted = null;
  // Saves run one at a time, each from the block the last one stored, so two quick changes never overwrite each other.
  let queue = Promise.resolve();
  let pending = 0;
  let seq = 0;
  // The "Saved" line: its text and when it stops showing.
  let flashText = '';
  let flashUntil = 0;
  let groupOpen = false;

  // ---------- small builders (text only) ----------

  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const para = (cls, value) => make('p', cls, value);
  const note = value => make('p', 'ext-ag-note', value);
  const pill = (value, warn) => {
    const p = make('span', 'pill', value);
    if (warn) p.dataset.tone = 'amber';
    return p;
  };
  const button = (cls, value, onClick, key) => {
    const b = MuseUI.button(cls, value);
    b.type = 'button';
    if (key) b.dataset.agKey = key;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  const chipEl = (value, onRemove) => {
    const chip = make('span', 'chip', value);
    const x = make('button', 'chip-x');
    x.type = 'button';
    x.append(MuseUI.icon('x'));
    x.title = `Remove ${value}`;
    x.setAttribute('aria-label', `Remove ${value}`);
    x.addEventListener('click', onRemove);
    chip.append(x);
    return chip;
  };
  const switchRow = (label, desc, checked, disabled, onChange, key) => {
    const row = make('label', 'switch-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    input.disabled = Boolean(disabled);
    input.dataset.agKey = key;
    input.addEventListener('change', () => onChange(input.checked));
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const body = make('span', '');
    body.append(label);
    if (desc) body.append(make('small', '', desc));
    row.append(input, track, body);
    return row;
  };
  // A whole-number box, sent on blur or Enter, never per keystroke. With `blank`, an empty box sends null (the override is cleared).
  const numberBox = (label, value, min, max, onCommit, key, opts = {}) => {
    const wrap = make('label', 'ext-ag-num');
    wrap.append(make('span', 'field-note', label));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = value === null || value === undefined ? '' : String(value);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.dataset.agKey = key;
    input.setAttribute('aria-label', label);
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      input.blur();
    });
    const shown = () => (value === null || value === undefined ? '' : String(value));
    input.addEventListener('change', () => {
      const trimmed = input.value.trim();
      if (trimmed === '' && opts.blank) return onCommit(null);
      const n = trimmed === '' ? NaN : Number(trimmed);
      if (!Number.isInteger(n)) {
        MuseUI.toast('Enter a whole number.', 'bad');
        input.value = shown();
        return undefined;
      }
      return onCommit(n);
    });
    wrap.append(input);
    return wrap;
  };
  const selectEl = (choices, value, onChange, key, label) => {
    const select = document.createElement('select');
    select.className = 'plain-select';
    if (label) select.setAttribute('aria-label', label);
    select.dataset.agKey = key;
    for (const [v, value2, disabled] of choices) {
      const o = new Option(value2, v);
      if (disabled) o.disabled = true;
      select.append(o);
    }
    select.value = value;
    if (onChange) select.addEventListener('change', () => onChange(select.value));
    return select;
  };
  const field = (label, control, extra) => {
    const box = make('div', 'field ext-ag-field');
    box.append(make('span', 'field-label', label), control);
    if (extra) box.append(extra);
    return box;
  };

  // ---------- data helpers ----------

  const clone = v => JSON.parse(JSON.stringify(v));
  // Two type objects are the same when their values are (key order does not count).
  const sameType = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  function canon(o) {
    return Object.keys(o).sort().reduce((acc, k) => { acc[k] = o[k]; return acc; }, {});
  }
  const modelLabel = (data, ref) => {
    if (!ref) return '';
    const hit = (data?.catalog ?? []).find(c => c.ref === ref);
    return hit ? hit.label : ref;
  };
  const providerOf = ref => (ref ? ref.slice(0, ref.indexOf(':')) : '');
  const blockOf = (scope, data) => (scope === 'project' ? data?.project?.agents ?? null : data?.app ?? null);
  const roleLabel = (data, r) => data?.roles?.[r]?.label ?? r;
  const isBuiltIn = (data, name) => (data?.builtIn ?? []).includes(name);
  const takenNames = block => new Set(block.types.map(t => t.name));
  const accessOf = t => (!t.files ? 'none' : t.kind === 'edit' ? 'edit' : 'read');
  const accessText = t => (!t.files ? 'No file access' : t.kind === 'edit' ? 'Edits files' : 'Reads files');
  const returnText = d => (d === 'json' ? 'JSON for /build' : (RETURN_CHOICES.find(c => c[0] === d)?.[1] ?? d));
  const summaryOf = block => {
    const chat = block.limits.roles.chat;
    const depth = block.limits.depth >= 2 ? 'agents may start read-only agents' : 'agents cannot start agents';
    return `${block.types.length} types · Chat: ${chat.concurrent} at once, ${chat.total} per reply · ${depth}`;
  };

  // A name from a label: lowercase, spaces to hyphens, other characters dropped, a leading non-letter dropped, cut at 24.
  function slugOf(label) {
    return String(label).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^[^a-z]+/, '').slice(0, 24).replace(/-+$/, '');
  }
  // The same name with -2, -3 and so on added while it is taken or reserved.
  function uniqueName(base, taken) {
    if (!base) return '';
    let name = base;
    let n = 2;
    while (taken.has(name) || RESERVED.includes(name)) {
      const suffix = `-${n++}`;
      name = base.slice(0, 24 - suffix.length).replace(/-+$/, '') + suffix;
    }
    return name;
  }

  // Asks before a destructive or reset action. The shell's confirm is used when it is there; the browser's question otherwise.
  async function ask(title, body, action) {
    if (typeof MuseUI.confirm === 'function') return (await MuseUI.confirm({ title, body, action, tone: 'danger' })) === true;
    return window.confirm(`${title} ${body}`);
  }

  // ---------- loading and saving ----------

  const alive = m => mounted === m && m.body.isConnected;

  function load(pid) {
    return MuseUI.api(`/api/agents${pid ? `?project=${encodeURIComponent(pid)}` : ''}`);
  }

  // Queues one change to the scope's block. The change edits a copy of the last stored block. Resolves true when the server stored it.
  function save(m, change, onRefused) {
    pending += 1;
    const run = queue.then(async () => {
      let ok = false;
      try {
        const current = blockOf(m.scope, snap?.data);
        if (!current) throw new Error('There is no copy to change.');
        const next = clone(current);
        change(next);
        const data = await MuseUI.api('/api/agents', { scope: m.scope, project: m.pid ?? undefined, agents: next });
        snap = { pid: m.pid, data };
        flash('Saved');
        ok = true;
      } catch (err) {
        if (onRefused) onRefused(err.message);
        else MuseUI.toast(err.message, 'bad');
      } finally {
        pending -= 1;
      }
      if (pending === 0 && alive(m)) draw(m);
      return ok;
    });
    queue = run.catch(() => false);
    return run;
  }

  // Shows "Saved" for a moment. Every draw paints the status line from flashText while it lasts.
  function flash(value) {
    flashText = value;
    flashUntil = Date.now() + SAVED_MS;
    setTimeout(() => {
      if (Date.now() < flashUntil) return;
      for (const node of document.querySelectorAll('.ext-ag-status')) node.textContent = '';
    }, SAVED_MS + 50);
  }

  // ---------- mounting and painting ----------

  // Called by the settings registry each time its section is drawn. The last answer is painted at once, then the server is asked again.
  function mountSection(body, scope) {
    const pid = MuseUI.state.activeProject ?? null;
    // The editor paints into its own box inside the section's body. Project settings passes its card as the body, and that card
    // keeps its own title, so only the box is ever replaced.
    for (const old of body.querySelectorAll(':scope > .ext-ag-host')) old.remove();
    const host = make('div', 'ext-ag-host');
    body.append(host);
    const m = { body: host, scope, pid, id: ++seq };
    mounted = m;
    if (snap && snap.pid === pid) draw(m);
    else host.replaceChildren(para('ext-ag-loading', 'Loading the agent settings…'));
    load(pid)
      .then(data => {
        if (!alive(m)) return;
        snap = { pid, data };
        draw(m);
      })
      .catch(err => {
        if (!alive(m)) return;
        const wrap = make('div', 'ext-ag');
        wrap.append(para('ext-ag-error', err?.message || 'The agent settings could not be loaded.'));
        wrap.append(button('ghost small', 'Try again', () => mountSection(body, scope)));
        host.replaceChildren(wrap);
      });
  }

  // Paints the editor from the last answer. Focus returns to the control that had it, by its key.
  function draw(m) {
    const data = snap?.data;
    if (!data || !alive(m)) return;
    const focusKey = m.body.contains(document.activeElement) ? document.activeElement.dataset?.agKey : null;
    const root = make('div', 'ext-ag');
    if (m.scope === 'project') {
      root.append(projectHead(m, data));
      if (!data.project?.customised) {
        m.body.replaceChildren(root);
        return;
      }
    } else {
      root.append(appHead(m, data));
    }
    const block = blockOf(m.scope, data);
    const status = make('p', 'ext-ag-status');
    status.setAttribute('role', 'status');
    status.textContent = Date.now() < flashUntil ? flashText : '';
    root.append(viewSwitch(m), status);
    root.append(view === 'limits' ? limitsView(m, block, data) : typesView(m, block, data));
    m.body.replaceChildren(root);
    if (focusKey) {
      const again = [...m.body.querySelectorAll('[data-ag-key]')].find(n => n.dataset.agKey === focusKey);
      if (again) again.focus();
    }
  }

  // ---------- heads ----------

  function appHead(m, data) {
    const wrap = make('div', 'ext-ag-head');
    let text = 'Used by every project that has no agent settings of its own.';
    if (data.project?.customised) text += ` ${data.project.name} has its own, so changes here do not reach it.`;
    wrap.append(para('ext-ag-scope-note', text));
    if (data.appSaved) {
      wrap.append(button('ghost small', 'Reset to Plenum defaults', async () => {
        const yes = await ask('Reset to Plenum defaults?', 'Put every agent type and limit back to Plenum\'s defaults? Your own types are deleted.', 'Reset');
        if (yes) resetRequest(m, { scope: 'app', project: m.pid ?? undefined });
      }, 'reset-app'));
    }
    return wrap;
  }

  function projectHead(m, data) {
    const wrap = make('div', 'ext-ag-head');
    const project = data.project;
    if (!project?.customised) {
      wrap.append(para('ext-ag-scope-note', `This project uses the app defaults: ${summaryOf(data.app)}`));
      if (project?.damaged) wrap.append(note('Its saved agent settings no longer check out, so they are not in force. Giving it its own settings replaces them.'));
      wrap.append(button('primary small', 'Give this project its own agent settings', () => customiseRequest(m), 'customise'));
      wrap.append(note('It starts as a copy of the app defaults. Later changes to the app defaults do not reach it.'));
      return wrap;
    }
    wrap.append(para('ext-ag-scope-note', 'This project keeps its own agent settings.'));
    wrap.append(button('ghost small', 'Use the app defaults again', async () => {
      const yes = await ask('Use the app defaults again?', 'Drop this project\'s own agent settings? It follows the app defaults again, and types made only for it are deleted.', 'Use the app defaults');
      if (yes) resetRequest(m, { scope: 'project', project: m.pid ?? undefined });
    }, 'reset-project'));
    return wrap;
  }

  async function customiseRequest(m) {
    try {
      const data = await MuseUI.api('/api/agents/customise', { project: m.pid });
      snap = { pid: m.pid, data };
      flash('Saved');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    }
    if (alive(m)) draw(m);
  }

  async function resetRequest(m, body) {
    try {
      const data = await MuseUI.api('/api/agents/reset', body);
      snap = { pid: m.pid, data };
      editing = null;
      flash('Saved');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    }
    if (alive(m)) draw(m);
  }

  // The Agent types | Limits switch: a segmented control with aria-pressed buttons.
  function viewSwitch(m) {
    const seg = make('div', 'seg ext-ag-view');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    for (const [key, value] of [['types', 'Agent types'], ['limits', 'Limits']]) {
      const b = button('seg-btn', value, () => {
        view = key;
        draw(m);
      }, `view-${key}`);
      b.setAttribute('aria-pressed', String(view === key));
      seg.append(b);
    }
    return seg;
  }

  // ---------- agent types ----------

  function typesView(m, block, data) {
    const wrap = make('div', 'ext-ag-types');
    wrap.append(para('ext-ag-intro', 'An agent is a model that does one task for another model and reports back. A model starts one with its delegate tool, and /build gives one to each task.'));
    for (const t of block.types) {
      if (editing && editing.mode === 'edit' && editing.name === t.name) wrap.append(typeForm(m, block, data));
      else wrap.append(typeCard(m, block, t, data));
    }
    if (editing && editing.mode === 'new') {
      wrap.append(typeForm(m, block, data));
      return wrap;
    }
    const full = block.types.length >= LIMITS.types;
    const add = button('primary small', 'Add a type', () => {
      editing = { mode: 'new', name: '', draft: blankDraft(block), error: '' };
      draw(m);
    }, 'add-type');
    add.disabled = full;
    wrap.append(add);
    if (full) wrap.append(note('At most 24 types'));
    return wrap;
  }

  function typeCard(m, block, t, data) {
    const card = make('section', 'card ext-ag-type');
    card.dataset.name = t.name;
    const head = make('div', 'ext-ag-type-head');
    head.append(make('strong', '', t.label), pill(accessText(t), t.files && t.kind === 'edit'), make('span', 'ext-ag-tag', isBuiltIn(data, t.name) ? 'Built in' : 'Custom'));
    card.append(head, make('p', 'ext-ag-meta', metaLine(t, data)));
    const tags = make('div', 'ext-ag-tags');
    if (t.commands) tags.append(pill('Runs commands', true));
    if (t.web) tags.append(pill('Web'));
    if (t.kind === 'edit' && t.folders.length) tags.append(pill(`Writes only in: ${t.folders.join(', ')}`));
    if (t.buildOnly) tags.append(pill('Build only'));
    if (tags.childElementCount) card.append(tags);
    card.append(make('p', 'ext-ag-desc', t.description), make('p', 'ext-ag-used', usedLine(block, t, data)));

    const actions = make('div', 'ext-ag-actions');
    actions.append(button('ghost small', 'Edit', () => {
      editing = { mode: 'edit', name: t.name, draft: draftOf(t), error: '' };
      draw(m);
    }, `edit-${t.name}`));
    if (!t.buildOnly) {
      actions.append(button('ghost small', 'Copy', () => {
        editing = { mode: 'new', name: '', draft: copyDraft(t, block), error: '' };
        view = 'types';
        draw(m);
      }, `copy-${t.name}`));
    }
    if (isBuiltIn(data, t.name)) {
      const restore = data.resets?.[t.name] ?? null;
      const reset = button('ghost small', 'Reset', () => {
        if (restore) save(m, next => { next.types = next.types.map(x => (x.name === t.name ? clone(restore) : x)); });
      }, `reset-${t.name}`);
      reset.title = 'Put back Plenum\'s settings for this type';
      reset.disabled = !restore || sameType(t, restore);
      actions.append(reset);
    } else {
      actions.append(button('ghost small', 'Delete', async () => {
        const yes = await ask(`Delete the ${t.label} type?`, `Delete the ${t.label} type? It is also taken out of every limit that names it.`, 'Delete');
        if (!yes) return;
        save(m, next => {
          next.types = next.types.filter(x => x.name !== t.name);
          removeNameEverywhere(next, t.name);
        });
      }, `delete-${t.name}`));
    }
    card.append(actions);
    return card;
  }

  function metaLine(t, data) {
    const model = t.model ? modelLabel(data, t.model) : 'Asking model';
    const effort = t.effort ? `${EFFORT_LABEL[t.effort] ?? t.effort} effort` : 'asking model\'s effort';
    const steps = t.files ? ` · ${t.maxSteps} tool steps` : '';
    return `${model} · ${effort}${steps} · ${t.timeoutMin} min`;
  }

  // Which rows and overrides name this type, in words. Planner is used by /build alone.
  function usedLine(block, t, data) {
    if (t.buildOnly) return 'Used by /build for its plan';
    const labels = ROLE_ORDER.filter(r => block.limits.roles[r].types.includes(t.name)).map(r => roleLabel(data, r));
    const n = block.limits.models.filter(o => Array.isArray(o.types) && o.types.includes(t.name)).length;
    let text = labels.join(', ');
    if (n) {
      const tail = `${n} per-model override${n === 1 ? '' : 's'}`;
      text = text ? `${text} and ${tail}` : tail;
    }
    return text ? `Used by: ${text}` : 'Not used yet. Allow it in Limits.';
  }

  function removeNameEverywhere(next, name) {
    for (const r of ROLE_ORDER) next.limits.roles[r].types = next.limits.roles[r].types.filter(n => n !== name);
    next.limits.models = next.limits.models.map(o => renamedOverride(o, types => types.filter(n => n !== name)));
  }
  function renameEverywhere(next, from, to) {
    for (const r of ROLE_ORDER) next.limits.roles[r].types = next.limits.roles[r].types.map(n => (n === from ? to : n));
    next.limits.models = next.limits.models.map(o => renamedOverride(o, types => types.map(n => (n === from ? to : n))));
  }
  // An override with its types changed; with none left, the key goes, so the override takes its role's types.
  function renamedOverride(o, change) {
    if (!Array.isArray(o.types)) return o;
    const types = change(o.types);
    const copy = { ...o, types };
    if (!types.length) delete copy.types;
    return copy;
  }

  // ---------- the type form ----------

  function blankDraft(block) {
    const base = block.types.find(t => t.name === 'researcher') ?? block.types[0];
    return { ...draftOf(base), label: '', description: '', name: '', nameTouched: false, who: { chat: true, build: true }, returns: 'summary', brief: '', moreOpen: false };
  }

  // A copy starts from the type's values with "<label> copy"; its name is made from that label.
  function copyDraft(t, block) {
    const label = `${t.label} copy`;
    return { ...draftOf(t), label, name: uniqueName(slugOf(label), takenNames(block)), nameTouched: false, who: { chat: true, build: true } };
  }

  function draftOf(t) {
    return {
      label: t.label,
      description: t.description,
      name: t.name,
      nameTouched: true,
      model: t.model ?? '',
      effort: t.effort ?? '',
      access: accessOf(t),
      folders: [...t.folders],
      commands: t.commands,
      web: t.web,
      maxSteps: t.maxSteps,
      timeoutMin: t.timeoutMin,
      idleMin: t.idleMin,
      returns: t.returns,
      brief: t.brief ?? '',
      who: { chat: true, build: true },
      moreOpen: false,
    };
  }

  // The form. Built-in types keep their label, kind and reply layout. A new type's name follows its label until its Name box is edited.
  function typeForm(m, block, data) {
    const d = editing.draft;
    const isNew = editing.mode === 'new';
    const builtIn = !isNew && isBuiltIn(data, editing.name);
    const current = builtIn ? block.types.find(t => t.name === editing.name) : null;
    const form = make('form', 'ext-ag-form');
    form.addEventListener('submit', e => e.preventDefault());
    const err = make('p', 'ext-ag-err');
    err.setAttribute('role', 'status');
    err.textContent = editing.error || '';

    // Label, and the name the asking model will use.
    const labelNote = note('');
    const showName = () => { labelNote.textContent = `The asking model calls it ${d.name || 'something'}.`; };
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = LIMITS.label;
    label.value = d.label;
    label.disabled = builtIn;
    if (builtIn) label.title = 'Built-in types keep their label';
    label.dataset.agKey = 'form-label';
    label.setAttribute('aria-label', 'Label');
    showName();
    form.append(field('Label', label, labelNote));

    // Description
    const desc = document.createElement('input');
    desc.type = 'text';
    desc.maxLength = LIMITS.description;
    desc.value = d.description;
    desc.placeholder = 'What this agent does, in one or two sentences';
    desc.dataset.agKey = 'form-desc';
    desc.setAttribute('aria-label', 'Description');
    desc.addEventListener('input', () => { d.description = desc.value; });
    form.append(field('Description', desc, note('The asking model reads this to choose a type.')));

    // Model: any provider, the models without tool calls marked, and notes for the ones that need them.
    const byProvider = new Map();
    for (const c of data.catalog ?? []) {
      if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
      byProvider.get(c.provider).push(c);
    }
    const modelSelect = document.createElement('select');
    modelSelect.className = 'plain-select';
    modelSelect.dataset.agKey = 'form-model';
    modelSelect.setAttribute('aria-label', 'Model');
    modelSelect.append(new Option('Same as the asking model', ''));
    for (const [prov, items] of byProvider) {
      const group = document.createElement('optgroup');
      group.label = GROUP_NAMES[prov] ?? prov;
      for (const c of items) {
        const o = new Option(c.tools === 'no' ? `${c.label} (text only)` : c.label, c.ref);
        o.disabled = d.access === 'edit' && c.tools === 'no';
        group.append(o);
      }
      modelSelect.append(group);
    }
    modelSelect.value = d.model;
    const modelNotes = make('div', 'ext-ag-notes');
    const effortNote = note(GEMINI_EFFORT);
    const drawNotes = () => {
      const prov = providerOf(d.model);
      modelNotes.replaceChildren();
      if (!d.model) modelNotes.append(note(BUILD_DEFAULT_NOTE));
      if (prov === 'muse' && d.access === 'read') modelNotes.append(note(MUSE_READ_NOTE));
      if (prov === 'gemini' && d.access === 'edit') modelNotes.append(note(GEMINI_EDIT));
      else if (prov === 'codex' && d.access === 'edit') modelNotes.append(note(CODEX_EDIT));
      if (prov === 'codex' || prov === 'gemini') modelNotes.append(note(CLI_NOTE));
      effortNote.hidden = prov !== 'gemini';
    };
    modelSelect.addEventListener('change', () => {
      d.model = modelSelect.value;
      drawNotes();
    });
    drawNotes();
    form.append(field('Model', modelSelect, modelNotes));

    // Effort
    const effort = selectEl(EFFORT_CHOICES, d.effort, v => { d.effort = v; }, 'form-effort', 'Effort');
    form.append(field('Effort', effort, effortNote));

    // Project files: one control sets the kind and the file access together.
    const access = make('div', 'seg ext-ag-access');
    access.setAttribute('role', 'group');
    access.setAttribute('aria-label', 'Project files');
    const builtKind = current ? accessOf(current) : null;
    const accessNote = note(d.access === 'none' ? 'It answers from its instructions alone, as the /build planner and reviewer do.' : '');
    for (const [key, value] of [['none', 'No access'], ['read', 'Read'], ['edit', 'Read and edit']]) {
      const b = button('seg-btn', value, () => {
        if (builtKind && key !== builtKind) return;
        d.access = key;
        if (key === 'none') { d.commands = false; d.web = false; }
        draw(m);
      }, `access-${key}`);
      b.setAttribute('aria-pressed', String(d.access === key));
      if (builtKind && key !== builtKind) {
        b.disabled = true;
        b.title = 'Built-in types keep their kind';
      }
      access.append(b);
    }
    form.append(field('Project files', access, accessNote));

    // Writes only in: folders the type may write in (read and edit only).
    if (d.access === 'edit') {
      const chips = make('div', 'chips ext-ag-chips');
      if (!d.folders.length) chips.append(make('span', 'note-quiet', 'Anywhere the scope allows'));
      for (const [i, f] of d.folders.entries()) {
        chips.append(chipEl(f, () => {
          d.folders.splice(i, 1);
          draw(m);
        }));
      }
      const folderInput = document.createElement('input');
      folderInput.type = 'text';
      folderInput.placeholder = 'Add a folder, then press Enter';
      folderInput.spellcheck = false;
      folderInput.dataset.agKey = 'form-folder';
      folderInput.setAttribute('aria-label', 'Add a folder');
      folderInput.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const folder = folderInput.value.trim();
        if (!folder) return;
        if (d.folders.length >= LIMITS.folders) {
          MuseUI.toast(`A type can list at most ${LIMITS.folders} folders.`, 'bad');
          return;
        }
        if (!d.folders.includes(folder)) d.folders.push(folder);
        draw(m);
      });
      form.append(field('Writes only in', chips, note('Its writes must stay inside these folders as well as inside the task\'s scope. Empty: anywhere the scope allows.')), folderInput);
    }

    // Commands and the web: both off while there is no file access.
    const off = d.access === 'none';
    form.append(switchRow('May run commands', 'Each command goes through your blocked commands and the Edits and commands setting, as in the chat. A command can change files outside the scope; Plenum lists what changed when the agent finishes.', d.commands && !off, off, v => { d.commands = v; }, 'form-commands'));
    form.append(switchRow('May use the web', 'Claude Code and Muse Code only. The other models have no web tool here.', d.web && !off, off, v => { d.web = v; }, 'form-web'));

    // Limits: tool steps (not with no access), minutes and idle minutes.
    const numbers = make('div', 'ext-ag-numbers');
    if (!off) numbers.append(numberBox('Tool steps', d.maxSteps, 1, LIMITS.maxSteps, v => { d.maxSteps = v; draw(m); }, 'form-steps'));
    numbers.append(numberBox('Minutes', d.timeoutMin, 1, LIMITS.timeoutMin, v => { d.timeoutMin = v; draw(m); }, 'form-minutes'));
    numbers.append(numberBox('Idle minutes', d.idleMin, 1, LIMITS.idleMin, v => { d.idleMin = v; draw(m); }, 'form-idle'));
    const limitNotes = make('div', 'ext-ag-notes');
    limitNotes.append(note('A tool step is one file read, search, edit or command. Idle: stopped when it produces nothing for this long; waiting for your approval does not count.'));
    if (!off && (d.maxSteps > RESEARCH.maxSteps || d.timeoutMin > RESEARCH.timeoutMin)) limitNotes.append(note(RESEARCH_TEXT));
    form.append(field('Limits', numbers, limitNotes));

    // Who may start it: new types only. Existing types are allowed in Limits.
    if (isNew) {
      const who = make('div', 'ext-ag-who');
      for (const [key, value] of [['chat', 'Chat'], ['build', 'Build tasks']]) {
        who.append(switchRow(value, '', d.who[key], false, v => { d.who[key] = v; }, `who-${key}`));
      }
      form.append(field('Who may start it', who, note('Council seats and the other group roles are set in Limits.')));
    }

    // More options: the name (custom types), the reply layout and the instructions.
    const more = document.createElement('details');
    more.className = 'ext-ag-more';
    more.open = Boolean(d.moreOpen);
    more.addEventListener('toggle', () => { d.moreOpen = more.open; });
    const moreTitle = document.createElement('summary');
    moreTitle.textContent = 'More options';
    more.append(moreTitle);
    if (!builtIn) {
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.maxLength = 24;
      nameInput.value = d.name;
      nameInput.spellcheck = false;
      nameInput.dataset.agKey = 'form-name';
      nameInput.setAttribute('aria-label', 'Name');
      nameInput.addEventListener('input', () => {
        d.name = nameInput.value.trim();
        d.nameTouched = true;
        showName();
      });
      label.addEventListener('input', () => {
        d.label = label.value;
        if (!d.nameTouched) {
          d.name = uniqueName(slugOf(d.label), takenNames(block));
          nameInput.value = d.name;
        }
        showName();
      });
      more.append(field('Name', nameInput, note('Lowercase letters, digits and hyphens, starting with a letter. The asking model uses this name.')));
    }
    const returns = selectEl(builtIn ? [[d.returns, returnText(d.returns), true]] : RETURN_CHOICES, d.returns, v => { d.returns = v; }, 'form-returns', 'Reports back');
    returns.disabled = builtIn;
    more.append(field('Reports back', returns, builtIn ? note('Built-in types keep their reply layout.') : null));
    const brief = document.createElement('textarea');
    brief.rows = 4;
    brief.maxLength = LIMITS.brief;
    brief.value = d.brief;
    brief.dataset.agKey = 'form-brief';
    brief.setAttribute('aria-label', 'Instructions');
    brief.addEventListener('input', () => { d.brief = brief.value; });
    more.append(field('Instructions', brief, note('Added to the agent\'s prompt after Plenum\'s own rules. They cannot widen what the type may do.')));
    form.append(more, err);

    // Save and Cancel.
    const actions = make('div', 'ext-ag-form-actions');
    actions.append(
      button('primary small', 'Save', () => submitType(m, block, data, builtIn, message => {
        // The server's refusal shows on the form's error line and in a toast.
        if (editing) editing.error = message;
        MuseUI.toast(message, 'bad');
      }), 'form-save'),
      button('ghost small', 'Cancel', () => {
        editing = null;
        draw(m);
      }, 'form-cancel'),
    );
    form.append(actions);
    return form;
  }

  // Checks the draft the way the server does, then saves the type and, for a new type, its rows, in one request.
  function submitType(m, block, data, builtIn, onRefused) {
    const d = editing.draft;
    const isNew = editing.mode === 'new';
    editing.error = '';
    // A check the page makes before anything is sent: the message goes on the form's error line, and nothing is saved.
    const refuse = text => {
      editing.error = text;
      draw(m);
      return Promise.resolve(false);
    };
    const label = d.label.trim();
    if (!label || label.length > LIMITS.label) return refuse('A type label is 1 to 40 characters.');
    if (!builtIn && !d.description.trim()) return refuse('Give the type a short description: the asking model reads it to choose a type.');
    if (!builtIn && !NAME_RE.test(d.name)) return refuse('A type name is 1 to 24 lowercase letters, digits or hyphens, starts with a letter, and cannot be a built-in or reserved name.');
    if (d.idleMin > d.timeoutMin) return refuse('The idle limit cannot be longer than the time limit.');

    const name = builtIn ? editing.name : d.name;
    const existing = builtIn ? block.types.find(t => t.name === name) : null;
    const type = builtIn
      ? { ...clone(existing), description: d.description.trim(), model: d.model || null, effort: d.effort || null, maxSteps: d.maxSteps, timeoutMin: d.timeoutMin, idleMin: d.idleMin, files: d.access !== 'none', commands: d.access === 'none' ? false : d.commands, web: d.access === 'none' ? false : d.web, folders: d.access === 'edit' ? d.folders.slice() : [], brief: d.brief }
      : {
        name,
        label,
        kind: d.access === 'edit' ? 'edit' : 'read',
        description: d.description.trim(),
        model: d.model || null,
        effort: d.effort || null,
        maxSteps: d.maxSteps,
        timeoutMin: d.timeoutMin,
        idleMin: d.idleMin,
        files: d.access !== 'none',
        commands: d.access === 'none' ? false : d.commands,
        web: d.access === 'none' ? false : d.web,
        folders: d.access === 'edit' ? d.folders.slice() : [],
        returns: d.returns,
        buildOnly: false,
        brief: d.brief,
      };
    if (builtIn) type.label = existing.label;

    return save(m, next => {
      if (isNew) {
        next.types.push(type);
        for (const r of ['chat', 'build']) {
          if (!d.who[r]) continue;
          const row = next.limits.roles[r];
          if (!row.types.includes(name)) row.types.push(name);
          if (row.concurrent === 0 && row.total === 0) {
            row.concurrent = 1;
            row.total = 2;
          }
        }
      } else {
        const from = editing.name;
        next.types = next.types.map(t => (t.name === from ? type : t));
        if (from !== name) renameEverywhere(next, from, name);
      }
    }, onRefused).then(ok => {
      if (ok) {
        editing = null;
        view = 'types';
      }
      if (alive(m)) draw(m);
      return ok;
    });
  }

  // ---------- limits ----------

  function limitsView(m, block, data) {
    const wrap = make('div', 'ext-ag-limits');
    wrap.append(para('ext-ag-intro', 'Who may start agents, which types, and how many. A run is one chat reply, one build, or one council, relay, quick compare or pipeline run. A change saves as you make it.'));
    wrap.append(callerRow(m, block, data, 'chat', false), callerRow(m, block, data, 'build', false));
    wrap.append(groupCard(m, block, data));
    wrap.append(runCard(m, block));
    wrap.append(modelsCard(m, block, data));
    return wrap;
  }

  // The types a role may take: the server's rule. Chat and builds may take read and edit types (no Planner); the others read types that run no commands.
  function typesAllowedFor(block, roleName) {
    const cards = roleName === 'chat' || roleName === 'build';
    return block.types.filter(t => (cards ? true : t.kind === 'read' && !t.commands) && !t.buildOnly);
  }

  // One role's row: its types (chips and an add menu), At once and the per-run number, and the role's switches.
  function callerRow(m, block, data, roleName, compact) {
    const lim = block.limits.roles[roleName];
    const meta = data.roles[roleName];
    const row = make('div', compact ? 'ext-ag-row' : 'card ext-ag-caller');
    row.dataset.role = roleName;
    row.append(make('strong', 'ext-ag-caller-name', meta.label));

    const chips = make('div', 'chips ext-ag-chips');
    if (!lim.types.length) chips.append(make('span', 'chip', 'None'));
    for (const name of lim.types) {
      const t = block.types.find(x => x.name === name);
      chips.append(chipEl(t ? t.label : name, () => save(m, next => {
        next.limits.roles[roleName].types = next.limits.roles[roleName].types.filter(n => n !== name);
      })));
    }
    row.append(chips);

    const allowed = typesAllowedFor(block, roleName).filter(t => !lim.types.includes(t.name));
    const choices = [['', allowed.length ? 'Add a type…' : 'None left', !allowed.length], ...allowed.map(t => [t.name, t.label, false])];
    const add = selectEl(choices, '', v => {
      if (!v) return;
      save(m, next => {
        const r = next.limits.roles[roleName];
        if (!r.types.includes(v)) r.types.push(v);
        if (r.concurrent === 0 && r.total === 0) {
          r.concurrent = 1;
          r.total = 2;
        }
      });
    }, `add-${roleName}`, `Add a type to ${meta.label}`);
    add.disabled = !allowed.length;
    row.append(add);

    const nums = make('div', 'ext-ag-numbers');
    nums.append(numberBox('At once', lim.concurrent, 0, LIMITS.concurrent, v => save(m, next => {
      const r = next.limits.roles[roleName];
      r.concurrent = v;
      if (v > r.total) r.total = v;
    }), `${roleName}-at-once`));
    nums.append(numberBox(meta.per, lim.total, 0, LIMITS.total, v => save(m, next => {
      next.limits.roles[roleName].total = v;
    }), `${roleName}-per-run`));
    row.append(nums);
    if (lim.concurrent > RESEARCH.concurrent) row.append(note(MANY_NOTICE));

    if (meta.cards) {
      row.append(switchRow('Ask before each start', 'A card shows the type, model and task, and the agent starts only if you approve.', lim.askToStart, false, v => save(m, next => {
        next.limits.roles[roleName].askToStart = v;
      }), `${roleName}-ask`));
    }
    if (roleName === 'chat') {
      row.append(switchRow('Claude Code\'s own subagents', 'Explore, Plan and general-purpose, which Claude Code starts on its own in the chat. Each one counts toward this row.', block.limits.cliSubagents, false, v => save(m, next => {
        next.limits.cliSubagents = v;
      }), 'cli-subagents'));
    }
    return row;
  }

  // The council, relay, quick compare and pipeline rows, closed by default, with the state on the summary line.
  function groupCard(m, block, data) {
    const details = document.createElement('details');
    details.className = 'card ext-ag-group';
    details.open = groupOpen;
    details.addEventListener('toggle', () => { groupOpen = details.open; });
    const summary = document.createElement('summary');
    const labels = GROUP_ROLES.filter(r => block.limits.roles[r].types.length > 0).map(r => roleLabel(data, r));
    summary.append(make('span', '', 'Council, relay, quick compare and pipelines'), make('span', 'ext-ag-state', labels.length ? `On for ${labels.join(', ')}` : 'Off'));
    details.append(summary, para('ext-ag-intro', 'These roles have no approval cards, so they can start only types that read files and run no commands. The seat itself still cannot open files.'));
    for (const r of GROUP_ROLES) details.append(callerRow(m, block, data, r, true));
    return details;
  }

  function runCard(m, block) {
    const card = make('section', 'card ext-ag-run');
    card.append(make('span', 'kicker', 'Every run'));
    card.append(switchRow('Agents may start read-only agents', 'Off: agents cannot start agents. On: an agent may start read-only agents one level down, within the same limits.', block.limits.depth >= 2, false, v => save(m, next => {
      next.limits.depth = v ? 2 : 1;
    }), 'depth'));
    card.append(numberBox('Most agents in one run', block.limits.perRun, 1, LIMITS.perRun, v => save(m, next => {
      next.limits.perRun = v;
    }), 'per-run'));
    card.append(note('All callers together. No row above can go past it.'));
    return card;
  }

  // One override per model: its model, where it applies, its types, and its own At once and per-run numbers (blank: the role's).
  function modelsCard(m, block, data) {
    const card = make('section', 'card ext-ag-models');
    card.append(make('span', 'kicker', 'Per model'));
    card.append(para('ext-ag-intro', 'Give one model its own numbers, and if you like its own types, in every role or in one. Read-only roles still start only types that read and run no commands.'));
    const list = block.limits.models;
    if (!list.length) card.append(note('No overrides. Every model uses its role\'s limits.'));
    list.forEach((o, i) => card.append(overrideBox(m, block, data, o, i)));
    const add = button('ghost small', 'Add a model override', () => {
      const ref = MuseUI.state.model || (data.catalog?.[0]?.ref ?? '');
      save(m, next => { next.limits.models.push({ ref, role: 'all' }); });
    }, 'add-override');
    add.disabled = list.length >= LIMITS.overrides;
    card.append(add);
    if (list.length >= LIMITS.overrides) card.append(note('At most 20 overrides'));
    return card;
  }

  function overrideBox(m, block, data, o, i) {
    const box = make('div', 'ext-ag-override');
    const top = make('div', 'ext-ag-override-top');
    const choices = (data.catalog ?? []).map(c => [c.ref, c.label, false]);
    if (!choices.some(c => c[0] === o.ref)) choices.unshift([o.ref, o.ref, false]);
    top.append(
      selectEl(choices, o.ref, v => save(m, next => { next.limits.models[i].ref = v; }), `override-${i}-model`, 'Model for this override'),
      button('ghost small', 'Remove', () => save(m, next => { next.limits.models.splice(i, 1); }), `override-${i}-remove`),
    );
    box.append(top);

    const where = [['all', 'Every role'], ...ROLE_ORDER.map(r => [r, roleLabel(data, r), false])];
    box.append(field('Where', selectEl(where, o.role, v => save(m, next => { next.limits.models[i].role = v; }), `override-${i}-where`, 'Where this override applies')));

    const roleTypes = o.role === 'all' ? [] : (block.limits.roles[o.role]?.types ?? []);
    const names = Array.isArray(o.types) ? o.types : [];
    const chips = make('div', 'chips ext-ag-chips');
    if (names.length) {
      for (const n of names) {
        const t = block.types.find(x => x.name === n);
        chips.append(chipEl(t ? t.label : n, () => save(m, next => {
          next.limits.models[i] = renamedOverride(next.limits.models[i], types => types.filter(x => x !== n));
        })));
      }
    } else {
      const labels = roleTypes.map(n => block.types.find(x => x.name === n)?.label ?? n).join(', ');
      chips.append(make('span', 'note-quiet', o.role === 'all' ? 'Same types as each role' : `Same types as the role: ${labels || 'none'}`));
    }
    box.append(field('Types', chips));

    const allowed = block.types.filter(t => !names.includes(t.name) && !t.buildOnly && (o.role === 'all' || ROLE_ORDER.slice(0, 2).includes(o.role) || (t.kind === 'read' && !t.commands)));
    const addChoices = [['', allowed.length ? 'Add a type…' : 'None left', !allowed.length], ...allowed.map(t => [t.name, t.label, false])];
    const addType = selectEl(addChoices, '', v => {
      if (!v) return;
      save(m, next => {
        const row = next.limits.models[i];
        row.types = [...(Array.isArray(row.types) ? row.types : []), v];
      });
    }, `override-${i}-add`, 'Add a type to this override');
    addType.disabled = !allowed.length;
    box.append(addType);

    const roleRow = o.role === 'all' ? null : block.limits.roles[o.role];
    const nums = make('div', 'ext-ag-numbers');
    nums.append(numberBox('At once', o.concurrent ?? null, 0, LIMITS.concurrent, v => save(m, next => {
      if (v === null) delete next.limits.models[i].concurrent;
      else next.limits.models[i].concurrent = v;
    }), `override-${i}-at-once`, { blank: true, placeholder: roleRow ? String(roleRow.concurrent) : '' }));
    nums.append(numberBox(o.role === 'all' ? 'Per run' : data.roles[o.role].per, o.total ?? null, 0, LIMITS.total, v => save(m, next => {
      if (v === null) delete next.limits.models[i].total;
      else next.limits.models[i].total = v;
    }), `override-${i}-per-run`, { blank: true, placeholder: roleRow ? String(roleRow.total) : '' }));
    box.append(nums);
    return box;
  }

  // ---------- registration ----------

  MuseUI.settings.register({
    id: APP_SECTION,
    scope: 'app',
    title: 'Agents',
    order: 40,
    render: body => mountSection(body, 'app'),
  });
  MuseUI.settings.register({
    id: PROJECT_SECTION,
    scope: 'project',
    title: 'Agents',
    order: 10,
    render: body => mountSection(body, 'project'),
  });

  // Opens Settings at its Agents section (scope 'app'), or Project settings at its Agents section (scope 'project').
  MuseUI.openAgents = scope => {
    const project = scope === 'project';
    MuseUI.settings.open(project ? 'project' : 'app');
    requestAnimationFrame(() => {
      document.querySelector(`[data-section="${project ? PROJECT_SECTION : APP_SECTION}"]`)?.scrollIntoView({ block: 'start' });
    });
  };
})();
