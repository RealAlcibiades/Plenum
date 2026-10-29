// ext-openrouter. Builds on window.MuseUI (see app.js).
// The OpenRouter model picker, a section of Settings > Accounts right after the model-provider keys (MuseUI.settings.register, scope
// 'app', group 'accounts'). OpenRouter has no fixed list in Plenum: any
// model id it lists works, written openrouter:<id>. The server fetches the list with the saved key and keeps it ten minutes
// (GET /api/openrouter/models). This card lists it, narrows it as you type, and takes any other id typed into the same field.
// Using a model goes through the existing model setting (MuseUI.update). The panel never handles a key, and every piece of
// text is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SECTION = 'ext-openrouter';
  // The Settings section: its id, its title and where it sorts. The keys section (ext-accounts-api) is order 20 and the tool test is
  // order 30, so the picker comes between them (UI-ARCH section 5: API keys, OpenRouter, tools for API models).
  const SECTION_ID = 'openrouter';
  const SECTION_TITLE = 'OpenRouter';
  const SECTION_ORDER = 25;
  const TITLE = 'OpenRouter model';
  const LOADING = 'Loading the OpenRouter models…';
  const PREFIX = 'openrouter:';
  // The same shape the server accepts for an id (parseRef in lib/providers.mjs), which checks it again.
  const ID_SHAPE = /^[A-Za-z0-9._/:-]{1,120}$/;
  const ID_RULE = 'A model id is 1 to 120 characters: letters, digits and . / : _ -';
  // A list of hundreds of models is narrowed by typing, so only this many rows are drawn at once.
  const SHOWN = 40;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // GET and POST both carry the Plenum token (MuseUI.request adds it), which the OpenRouter routes ask for.
  async function call(path, body) {
    const res = await MuseUI.request(path, body === undefined ? {} : { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // "128K context", "1M context". A model that reports no length shows none.
  function contextText(length) {
    if (!Number.isFinite(length) || length <= 0) return '';
    if (length >= 1_000_000) return `${String(Math.round(length / 100_000) / 10)}M context`;
    if (length >= 1000) return `${Math.round(length / 1000)}K context`;
    return `${length} context`;
  }

  // A leading "openrouter:" typed by hand is dropped, so the id is not written twice.
  const idOf = text => String(text ?? '').trim().replace(/^openrouter:/i, '');

  // ---------- the model menu ----------

  // The header's model menu lists the catalog, and an OpenRouter id is not in it, so a menu set to one would go blank. The id is
  // added as an option, the way app.js does for a saved model, and picked.
  function showModel(ref) {
    const select = MuseUI.el.model;
    // An empty menu is not filled yet, and app.js fills it only while it is empty, so nothing is added to it then.
    if (!select || !select.options.length || typeof ref !== 'string' || !ref.startsWith(PREFIX)) return;
    if (![...select.options].some(o => o.value === ref)) select.append(new Option(`OpenRouter · ${ref.slice(PREFIX.length)}`, ref));
    select.value = ref;
  }

  // ---------- the card ----------

  // Settings draws every section each time it opens, but a model list is a request to OpenRouter, so the list is read once the card is
  // on screen (IntersectionObserver) and not when the page opens at some other group. Without the observer it is read at once.
  function whenShown(node, fn) {
    if (typeof IntersectionObserver !== 'function') {
      fn();
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      observer.disconnect();
      fn();
    });
    observer.observe(node);
  }

  function buildSection() {
    const section = make('section', SECTION);
    section.setAttribute('aria-label', TITLE);
    const card = MuseUI.cardShell('R', 'openrouter', TITLE, 'Any model OpenRouter lists', 'Not in use', false);
    const pill = card.querySelector('.pill');
    card.append(MuseUI.para('Pick a model from the list OpenRouter gives your key, or type any model id. Replies are billed per token by OpenRouter. They are text only, and Plenum shows no price for them.'));

    const input = make('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.maxLength = 120;
    input.placeholder = 'Search the list, or type a model id';
    input.setAttribute('aria-label', 'OpenRouter model id');

    const list = make('div', 'ext-openrouter-list');
    list.hidden = true;
    const count = make('p', 'ext-openrouter-count', LOADING);
    const use = MuseUI.button('primary small', 'Use this model');
    const check = MuseUI.button('ghost small', 'Check key');
    const result = make('div', 'result');
    result.setAttribute('role', 'status');
    // tone is 'ok', 'bad' or '' for a neutral line while work is running.
    const show = (text, tone) => {
      result.textContent = text;
      result.className = tone ? `result ${tone}` : 'result';
    };

    // What the server last listed, and the sentence to show when it listed nothing.
    let models = [];
    let why = LOADING;
    let busy = false;

    const paintPill = () => {
      const on = String(MuseUI.threads?.info?.()?.model || MuseUI.state.model || '').startsWith(PREFIX);
      pill.textContent = on ? 'In use' : 'Not in use';
      pill.className = on ? 'pill ok' : 'pill';
    };
    const paintButtons = () => {
      use.disabled = busy || !ID_SHAPE.test(idOf(input.value));
      check.disabled = busy;
    };
    const paintPressed = () => {
      const id = idOf(input.value);
      for (const row of list.children) row.setAttribute('aria-pressed', String(row.dataset.id === id));
    };

    function row(m) {
      const b = make('button', 'ext-openrouter-row');
      b.type = 'button';
      b.dataset.id = m.id;
      b.title = m.id;
      b.append(make('span', 'ext-openrouter-name', m.name), make('span', 'ext-openrouter-ctx', contextText(m.contextLength)), make('span', 'ext-openrouter-id', m.id));
      b.addEventListener('click', () => {
        input.value = m.id;
        paintPressed();
        paintButtons();
      });
      return b;
    }

    // Draws the rows that match the field. The field is also where a typed id goes, so no match is not an error.
    function paintList() {
      const q = input.value.trim().toLowerCase();
      const hits = q ? models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
      list.replaceChildren(...hits.slice(0, SHOWN).map(row));
      list.hidden = hits.length === 0;
      if (!models.length) count.textContent = why;
      else if (!hits.length) count.textContent = 'No listed model matches. What you typed is used as the model id.';
      else if (hits.length > SHOWN) count.textContent = `Showing ${SHOWN} of ${hits.length} models. Type to narrow the list.`;
      else count.textContent = `${hits.length} ${hits.length === 1 ? 'model' : 'models'}.`;
      paintPressed();
    }

    async function load() {
      try {
        const data = await call('/api/openrouter/models');
        const listed = data.ok && Array.isArray(data.models) ? data.models.filter(m => m && typeof m.id === 'string' && typeof m.name === 'string') : [];
        models = listed;
        why = listed.length ? '' : String(data.message || 'The model list did not come back.');
      } catch (err) {
        models = [];
        why = err.message;
      }
      paintList();
    }

    input.addEventListener('input', () => {
      paintList();
      paintButtons();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') use.click();
    });

    use.addEventListener('click', async () => {
      const id = idOf(input.value);
      if (!ID_SHAPE.test(id)) return show(ID_RULE, 'bad');
      busy = true;
      paintButtons();
      show('Setting the model…', '');
      try {
        showModel(PREFIX + id);
        await MuseUI.setThreadModel(PREFIX + id);
        // The model goes to the thread on screen, and the toast names it when that is not Main (B-98).
        const t = MuseUI.threads?.info?.();
        const where = t && !t.main && t.name ? ` for ${t.name}` : '';
        show(`The model is now ${id}${where}.`, 'ok');
        MuseUI.toast(`Model set to ${id}${where}`);
      } catch (err) {
        show(err.message, 'bad');
      } finally {
        busy = false;
        paintPill();
        paintButtons();
      }
    });

    check.addEventListener('click', async () => {
      busy = true;
      paintButtons();
      show('Checking the saved key…', '');
      try {
        const r = await call('/api/openrouter/check', {});
        show(r.message || (r.ok ? 'OpenRouter accepted the saved key.' : 'OpenRouter did not accept the saved key.'), r.ok ? 'ok' : 'bad');
        // A key saved after Settings opened is picked up here: the list is asked for again when it came back empty.
        if (r.ok && !models.length) await load();
      } catch (err) {
        show(err.message, 'bad');
      } finally {
        busy = false;
        paintButtons();
      }
    });

    const actions = make('div', 'actions');
    actions.append(use, check);
    card.append(input, list, count, actions, result);
    section.append(card);
    paintPill();
    paintButtons();
    whenShown(section, load);
    return section;
  }

  // Attach. Settings draws the section fresh each time it opens, so nothing is watched. A page without the Settings registry has
  // nowhere to show the card.
  if (typeof MuseUI.settings?.register === 'function') {
    MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: SECTION_TITLE, group: 'accounts', order: SECTION_ORDER, render: body => body.append(buildSection()) });
  }

  // A saved OpenRouter model has to be named in the model menu when the page opens. app.js sets the menu's value on every render
  // and redraws the project list on every render too, so a change to either one means the value was just set. The menu is
  // also filled once the catalog has loaded, which is the other change watched. It is checked now as well, in case a render
  // ran before this file did. Nothing is added to the menu before it is filled, because app.js fills it only while it is empty.
  const syncModel = () => showModel(MuseUI.threads?.info?.()?.model || MuseUI.state.model);
  for (const node of [MuseUI.el.model, MuseUI.el.projects]) {
    if (node) new MutationObserver(syncModel).observe(node, { childList: true });
  }
  syncModel();
})();
