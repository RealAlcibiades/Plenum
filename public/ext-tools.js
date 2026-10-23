// ext-tools. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The CLI tool option panels: one card per CLI, one control per option, read from GET /api/tool-options.
// Each change goes to the caller's onChange(cli, settings), and the caller saves it. Only the options that
// differ from their default are passed back, so an option left alone keeps following the tool's default.
(function () {
  'use strict';

  // The order the CLIs appear in, and the name used when the server sends no label.
  // Claude Code, Codex, Gemini CLI, Muse Code, Cursor (UI-ARCH section 5: six CLIs; Grok Build joins after Cursor).
  const CLI_ORDER = ['claude', 'codex', 'gemini', 'muse', 'cursor'];
  const CLI_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', muse: 'Muse Code', cursor: 'Cursor' };
  // The letter on each card's mark, the same letters the Accounts group uses.
  const MARKS = { claude: 'C', codex: 'X', gemini: 'G', muse: 'M', cursor: 'U' };
  // Limits from the wave contract. The server checks them too; checking here says why at once.
  const LIST_MAX_ITEMS = 20;
  const LIST_MAX_CHARS = 120;
  const TEXT_MAX_CHARS = 300;

  // The panel each container shows now. A slow render that finishes after a newer one finds its panel replaced.
  const panels = new WeakMap();
  // The option list is fetched once per page. A failure or an empty list clears it, so the next open asks again
  // (the option modules may not be written yet).
  let optionsPromise = null;
  let uid = 0;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const nextId = () => `ext-tool-${++uid}`;
  const copy = v => (Array.isArray(v) ? v.slice() : v);

  function copyAll(obj) {
    const out = {};
    for (const key of Object.keys(obj)) out[key] = copy(obj[key]);
    return out;
  }

  function sameValue(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => item === b[i]);
    return a === b;
  }

  function loadOptions() {
    if (!optionsPromise) {
      optionsPromise = window.MuseUI.api('/api/tool-options')
        .then(data => {
          if (!data || typeof data !== 'object') throw new Error('the server sent no option list');
          if (!hasAnyOption(data)) optionsPromise = null;
          return data;
        })
        .catch(err => {
          optionsPromise = null;
          throw err;
        });
    }
    return optionsPromise;
  }

  function optionsFor(data, cli) {
    const entry = data[cli];
    const list = entry && Array.isArray(entry.options) ? entry.options : [];
    // An option without a key or a label cannot be drawn or saved, so it is skipped.
    return list.filter(opt => opt && typeof opt.key === 'string' && opt.key !== '' && typeof opt.label === 'string');
  }

  function hasAnyOption(data) {
    return CLI_ORDER.some(cli => optionsFor(data, cli).length > 0);
  }

  function labelFor(data, cli) {
    const entry = data[cli];
    return entry && typeof entry.label === 'string' && entry.label ? entry.label : CLI_NAMES[cli];
  }

  // The option's own max when it is a sane number, never above the contract's caps.
  const listMax = opt => (Number.isInteger(opt.max) && opt.max >= 1 ? Math.min(opt.max, LIST_MAX_ITEMS) : LIST_MAX_ITEMS);
  const textMax = opt => (Number.isInteger(opt.max) && opt.max >= 0 ? Math.min(opt.max, TEXT_MAX_CHARS) : TEXT_MAX_CHARS);

  function isValid(opt, v) {
    switch (opt.type) {
      case 'select': return Array.isArray(opt.choices) && opt.choices.some(c => c && c.value === v);
      case 'boolean': return typeof v === 'boolean';
      case 'list': return Array.isArray(v) && v.length <= listMax(opt) && v.every(item => typeof item === 'string');
      case 'text': return typeof v === 'string' && v.length <= textMax(opt);
      default: return false;
    }
  }

  // What an option is when nothing is saved: its own default when that is valid, otherwise a neutral value.
  function defaultOf(opt) {
    if (isValid(opt, opt.default)) return copy(opt.default);
    switch (opt.type) {
      case 'select': {
        const first = Array.isArray(opt.choices) ? opt.choices.find(c => c && typeof c === 'object') : null;
        return first ? first.value : undefined;
      }
      case 'boolean': return false;
      case 'list': return [];
      case 'text': return '';
      default: return undefined;
    }
  }

  // The value in force: the saved one when there is one, otherwise the default.
  const valueOf = (opt, explicit) => (Object.hasOwn(explicit, opt.key) ? explicit[opt.key] : defaultOf(opt));

  // Keeps the saved values that are valid and differ from the default. Anything else is dropped, as the server would drop it.
  function explicitFrom(options, saved) {
    const out = {};
    if (!saved || typeof saved !== 'object') return out;
    for (const opt of options) {
      if (!Object.hasOwn(saved, opt.key)) continue;
      const v = saved[opt.key];
      if (isValid(opt, v) && !sameValue(v, defaultOf(opt))) out[opt.key] = copy(v);
    }
    return out;
  }

  // The default, written for a person to read under the option.
  function describe(opt, value) {
    if (opt.type === 'select') {
      const hit = (Array.isArray(opt.choices) ? opt.choices : []).find(c => c && c.value === value);
      return hit ? String(hit.label ?? hit.value) : String(value ?? 'none');
    }
    if (opt.type === 'boolean') return value ? 'On' : 'Off';
    if (opt.type === 'list') return value.length ? value.join(', ') : 'none';
    if (opt.type === 'text') return value ? value : 'blank';
    return String(value);
  }

  // Options grouped under their section names, in the order each group first appears.
  function groupsOf(options) {
    const groups = new Map();
    for (const opt of options) {
      const name = typeof opt.group === 'string' ? opt.group.trim() : '';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(opt);
    }
    return groups;
  }

  function stateBlock(message, action, isError) {
    const box = make('div', 'ext-tools-state');
    box.append(make('p', isError ? 'ext-tools-err' : 'ext-tools-note', message));
    if (action) {
      const btn = window.MuseUI.button('ghost small', action.label);
      btn.addEventListener('click', action.run);
      box.append(btn);
    }
    return box;
  }

  // The default line and the "Use default" button under each option. The button only shows when a value is saved.
  function footFor(s, opt, commit, focusControl) {
    const foot = make('div', 'ext-tools-foot');
    const dflt = make('span', 'ext-tools-default');
    const reset = window.MuseUI.button('ghost small', 'Use default');
    reset.addEventListener('click', () => {
      commit(s.cli, opt, undefined);
      focusControl();
    });
    foot.append(dflt, reset);
    return {
      node: foot,
      sync() {
        dflt.textContent = `Default: ${describe(opt, defaultOf(opt))}`;
        reset.hidden = !Object.hasOwn(s.explicit, opt.key);
      },
    };
  }

  function selectControl(s, opt, commit) {
    const id = nextId();
    const node = make('div', 'field ext-tools-opt');
    const label = make('label', 'field-label', opt.label);
    label.htmlFor = id;
    const select = document.createElement('select');
    select.id = id;
    select.className = 'ext-tools-select';
    const choices = Array.isArray(opt.choices) ? opt.choices.filter(c => c && typeof c === 'object') : [];
    choices.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = String(c.label ?? c.value);
      select.append(o);
    });
    select.addEventListener('change', () => {
      const c = choices[Number(select.value)];
      if (c) commit(s.cli, opt, c.value);
    });
    const help = make('p', 'ext-tools-help', opt.help || '');
    const foot = footFor(s, opt, commit, () => select.focus());
    node.append(label, select, help, foot.node);
    return {
      node,
      sync() {
        const current = valueOf(opt, s.explicit);
        const index = choices.findIndex(c => c.value === current);
        select.value = index >= 0 ? String(index) : '';
        foot.sync();
      },
    };
  }

  function booleanControl(s, opt, commit) {
    const node = make('div', 'ext-tools-opt');
    const row = make('label', 'switch-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    const text = make('span', 'ext-tools-switch-text', opt.label);
    if (opt.help) text.append(make('small', '', opt.help));
    row.append(input, make('span', 'switch-track'), text);
    input.addEventListener('change', () => commit(s.cli, opt, input.checked));
    const foot = footFor(s, opt, commit, () => input.focus());
    node.append(row, foot.node);
    return {
      node,
      sync() {
        input.checked = valueOf(opt, s.explicit) === true;
        foot.sync();
      },
    };
  }

  function textControl(s, opt, commit) {
    const id = nextId();
    const node = make('div', 'field ext-tools-opt');
    const label = make('label', 'field-label', opt.label);
    label.htmlFor = id;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = 'ext-tools-input';
    input.maxLength = textMax(opt);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('change', () => {
      const v = input.value.trim();
      input.value = v;
      commit(s.cli, opt, v);
    });
    const help = make('p', 'ext-tools-help', opt.help || '');
    const foot = footFor(s, opt, commit, () => input.focus());
    node.append(label, input, help, foot.node);
    return {
      node,
      sync() {
        // Do not overwrite a value the person is typing right now.
        if (document.activeElement !== input) input.value = valueOf(opt, s.explicit);
        foot.sync();
      },
    };
  }

  function listControl(s, opt, commit) {
    const UI = window.MuseUI;
    const id = nextId();
    const max = listMax(opt);
    const items = () => valueOf(opt, s.explicit).slice();
    const node = make('div', 'field ext-tools-opt');
    const label = make('label', 'field-label', opt.label);
    label.htmlFor = id;
    const chips = make('div', 'chips ext-tools-chips');
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = 'ext-tools-input';
    input.maxLength = LIST_MAX_CHARS;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Type an item and press Enter';
    const add = UI.button('ghost small', 'Add');
    const row = make('div', 'ext-tools-add');
    row.append(input, add);
    const err = make('p', 'ext-tools-err');
    err.setAttribute('aria-live', 'polite');
    const count = make('p', 'ext-tools-count');
    const help = make('p', 'ext-tools-help', opt.help || '');
    const foot = footFor(s, opt, commit, () => input.focus());

    const complain = msg => { err.textContent = msg; };

    const chipFor = (item, index) => {
      const chip = make('span', 'chip', item);
      const remove = UI.button('chip-x', '');
      remove.setAttribute('aria-label', `Remove ${item}`);
      remove.append(UI.icon('x'));
      remove.addEventListener('click', () => {
        commit(s.cli, opt, items().filter((_, j) => j !== index));
        input.focus();
      });
      chip.append(remove);
      return chip;
    };

    const tryAdd = () => {
      const text = input.value.trim();
      const list = items();
      if (!text) complain('Type an item first.');
      else if (text.length > LIST_MAX_CHARS) complain(`Keep each item to ${LIST_MAX_CHARS} characters or fewer.`);
      else if (list.length >= max) complain(`A list holds at most ${max} ${max === 1 ? 'item' : 'items'}.`);
      else if (list.includes(text)) complain('That item is already in the list.');
      else {
        complain('');
        input.value = '';
        commit(s.cli, opt, [...list, text]);
      }
      input.focus();
    };
    add.addEventListener('click', tryAdd);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryAdd();
      }
    });
    input.addEventListener('input', () => complain(''));

    node.append(label, chips, row, err, count, help, foot.node);
    return {
      node,
      sync() {
        const list = items();
        chips.replaceChildren(...(list.length ? list.map(chipFor) : [make('span', 'note-quiet', 'None yet')]));
        count.textContent = `${list.length} of ${max} ${max === 1 ? 'item' : 'items'}`;
        foot.sync();
      },
    };
  }

  // An option of a type this panel does not draw yet is named rather than hidden, so nothing silently goes missing.
  function unsupportedControl(opt) {
    const node = make('div', 'ext-tools-opt');
    node.append(make('p', 'ext-tools-help', `${opt.label}: this kind of setting (${String(opt.type)}) is not shown yet.`));
    return { node, sync() {} };
  }

  function buildControl(s, opt, commit) {
    switch (opt.type) {
      case 'select': return selectControl(s, opt, commit);
      case 'boolean': return booleanControl(s, opt, commit);
      case 'list': return listControl(s, opt, commit);
      case 'text': return textControl(s, opt, commit);
      default: return unsupportedControl(opt);
    }
  }

  function buildCard(s, commit, editable) {
    const UI = window.MuseUI;
    const count = s.options.length;
    const sub = count ? `${count} ${count === 1 ? 'option' : 'options'}` : 'No options yet';
    const card = UI.cardShell(MARKS[s.cli] || s.cli.charAt(0).toUpperCase(), s.cli, s.label, sub, 'Defaults', false);
    s.pill = card.querySelector('.pill');
    if (!count) card.append(UI.para('Settings for this tool appear here once it lists them.'));
    for (const [name, opts] of groupsOf(s.options)) {
      const group = make('div', 'ext-tools-group');
      if (name) group.append(make('h5', 'cons-cap', name));
      for (const opt of opts) {
        const control = buildControl(s, opt, commit);
        s.controls.push(control);
        group.append(control.node);
      }
      card.append(group);
    }
    // Without an onChange the panel only shows the settings, so nothing can be changed from it.
    if (!editable) {
      for (const node of card.querySelectorAll('input, select, button')) node.disabled = true;
    }
    return card;
  }

  // Builds the panel for the loaded options. The saved settings come in as options.tools, one object per CLI.
  function buildPanel(data, options) {
    const saved = options.tools && typeof options.tools === 'object' ? options.tools : {};
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const clis = {};
    for (const cli of CLI_ORDER) {
      const list = optionsFor(data, cli);
      clis[cli] = {
        cli,
        label: labelFor(data, cli),
        options: list,
        explicit: explicitFrom(list, saved[cli]),
        controls: [],
        pill: null,
        seq: 0,
      };
    }

    // Shows the value in force for every control of one CLI, and how many differ from the default.
    function syncCli(cli) {
      const s = clis[cli];
      for (const control of s.controls) control.sync();
      const n = Object.keys(s.explicit).length;
      if (s.pill) s.pill.textContent = n ? `${n} changed` : 'Defaults';
    }

    // Records one change, shows it at once, and passes the CLI's settings to the caller. A save that fails
    // puts the previous value back and says why, unless a newer change has already been made.
    function commit(cli, opt, value) {
      const s = clis[cli];
      const before = s.explicit;
      const next = { ...before };
      if (value === undefined || sameValue(value, defaultOf(opt))) delete next[opt.key];
      else next[opt.key] = copy(value);
      const unchanged = Object.hasOwn(before, opt.key) === Object.hasOwn(next, opt.key)
        && (!Object.hasOwn(next, opt.key) || sameValue(before[opt.key], next[opt.key]));
      if (unchanged) return;
      const seq = ++s.seq;
      s.explicit = next;
      syncCli(cli);
      if (!onChange) return;
      const fail = err => {
        if (s.seq === seq) {
          s.explicit = before;
          syncCli(cli);
        }
        window.MuseUI.toast(err && err.message ? err.message : 'That change was not saved.', 'bad');
      };
      try {
        Promise.resolve(onChange(cli, copyAll(s.explicit))).catch(fail);
      } catch (err) {
        fail(err);
      }
    }

    const cards = make('div', 'ext-tools-cards');
    for (const cli of CLI_ORDER) cards.append(buildCard(clis[cli], commit, Boolean(onChange)));
    for (const cli of CLI_ORDER) syncCli(cli);
    const intro = make('p', 'ext-tools-intro', 'Options for each tool, set for this project. An option you have not changed uses the default shown under it.');
    return [intro, cards];
  }

  // Draws the CLI tool options into container. options: { projectId, tools, onChange }.
  // Calling it again for the same container replaces what it drew before.
  function renderSection(container, opts) {
    if (!container) return;
    const options = opts && typeof opts === 'object' ? opts : {};
    const root = make('div', 'ext-tools');
    root.dataset.project = options.projectId == null ? '' : String(options.projectId);
    const previous = panels.get(container);
    if (previous && previous.parentNode === container) previous.replaceWith(root);
    else container.append(root);
    panels.set(container, root);
    const current = () => panels.get(container) === root;
    const retry = () => renderSection(container, options);

    if (!window.MuseUI) {
      root.append(make('p', 'ext-tools-note', 'The tool options need the Plenum page. Open this panel again once the page has loaded.'));
      return;
    }
    root.append(stateBlock('Loading tool options…'));
    loadOptions()
      .then(data => {
        if (!current()) return;
        if (!hasAnyOption(data)) {
          root.replaceChildren(stateBlock('No tool options are available yet. Claude Code, Codex, Gemini, Muse Code and Cursor will list their settings here.', { label: 'Check again', run: retry }));
          return;
        }
        root.replaceChildren(...buildPanel(data, options));
      })
      .catch(err => {
        if (!current()) return;
        const reason = err && err.message ? err.message : 'unknown error';
        root.replaceChildren(stateBlock(`Could not load the tool options (${reason}).`, { label: 'Try again', run: retry }, true));
      });
  }

  window.MuseTools = Object.freeze({ renderSection });
})();
