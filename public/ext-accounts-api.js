// ext-accounts-api. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The model-provider key panel in the Accounts drawer. A key goes to the server in one request, which
// tests it and then saves it. This file keeps no copy of a key: the input is cleared after a save, and the
// panel shows only a provider's status and the server's plain messages.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const SECTION = 'ext-apikeys';
  const DRAWER = 'Accounts';
  const TITLE = 'Model providers (per token)';
  const LOADING = 'Checking the provider keys…';
  // app.js shows this line while the Accounts drawer waits for its own request. The panel waits for it to go.
  const ACCOUNTS_LOADING = 'Checking your accounts';
  // The badge letter for each provider. A provider this table does not name gets the first letter of its label.
  const MARKS = { xai: 'X', openai: 'O', deepseek: 'D', mistral: 'M', googleai: 'G', openrouter: 'R' };

  // Only https addresses become links, so a key page from the server cannot point the panel anywhere else.
  function isHttps(url) {
    return typeof url === 'string' && /^https:\/\//.test(url);
  }

  // The server does not echo a key, but a message goes on screen, so the key is removed from it as well.
  function scrub(text, key) {
    const msg = String(text ?? '');
    return key ? msg.split(key).join('') : msg;
  }

  function accountsOpen() {
    const { drawer, drawerTitle } = MuseUI.el;
    return !drawer.hidden && drawerTitle.textContent === DRAWER;
  }

  // An empty body is between renders. The loading line is the Accounts drawer's own placeholder, so the
  // panel waits until the real content has replaced it.
  function settled(body) {
    if (body.children.length === 0) return false;
    return !(body.children.length === 1 && body.textContent.startsWith(ACCOUNTS_LOADING));
  }

  // Runs on every change to the drawer body. It adds the section once. Adding the section triggers this
  // again, but the section is already there by then, so the call returns and nothing loops.
  function sync() {
    const body = MuseUI.el.drawerBody;
    if (!accountsOpen() || !settled(body)) return;
    if (body.querySelector(`:scope > .${SECTION}`)) return;
    body.append(buildSection());
  }

  function statusLine(text) {
    const p = MuseUI.para(text);
    p.className = 'ext-apikeys-status';
    return p;
  }

  // The section is a heading, the route choices and a list. Its own updates stay inside it, so the observer on the drawer body
  // does not see them.
  function buildSection() {
    const section = document.createElement('section');
    section.className = SECTION;
    section.setAttribute('aria-label', TITLE);
    const heading = document.createElement('h3');
    heading.className = 'ext-apikeys-title';
    heading.textContent = TITLE;
    const routes = document.createElement('div');
    routes.className = 'ext-apikeys-routes';
    const list = document.createElement('div');
    list.className = 'ext-apikeys-list';
    section.append(heading, routes, list);
    // The per-token billing strip sits above the key rows (LEGAL api-keys-spend). It informs and never blocks a key.
    MuseUI.notice?.('api-keys-spend', { before: list });
    const panel = { list, routes, cards: new Map(), ui: null, routeSeq: 0 };
    list.append(statusLine(LOADING));
    loadKeys(panel);
    return section;
  }

  async function loadKeys(panel) {
    let data;
    try {
      data = await MuseUI.api('/api/keys');
    } catch (err) {
      return showError(panel, err.message);
    }
    if (!Array.isArray(data?.providers)) return showError(panel, 'The provider list did not come back. Try again.');
    if (data.routes) paintRoutes(panel, data.routes);
    panel.cards.clear();
    if (data.providers.length === 0) {
      panel.list.replaceChildren(statusLine('No model providers are listed.'));
      return;
    }
    panel.list.replaceChildren(...data.providers.map(p => {
      const card = providerCard(p, panel);
      panel.cards.set(p.id, card);
      return card.root;
    }));
  }

  function showError(panel, message) {
    const box = document.createElement('div');
    box.className = 'ext-apikeys-error';
    box.append(statusLine(message));
    const again = MuseUI.button('ghost small', 'Try again');
    again.addEventListener('click', () => {
      panel.list.replaceChildren(statusLine(LOADING));
      loadKeys(panel);
    });
    box.append(again);
    panel.list.replaceChildren(box);
  }

  // Reads every provider's status again and updates the cards in place. Typed text and messages stay as they are.
  async function refreshStatus(panel) {
    try {
      const data = await MuseUI.api('/api/keys');
      for (const p of data?.providers ?? []) panel.cards.get(p.id)?.apply(p);
      if (data?.routes) paintRoutes(panel, data.routes);
    } catch {
      // The cards keep their last status. Opening the drawer again reads the saved state.
    }
  }

  // A plain link to the provider's key page. It has target _blank because desktop/main.cjs cancels any
  // navigation away from the app, so a link without it would do nothing in the desktop window. The
  // main process hands such a link to the browser.
  function keyPageLink(p) {
    if (!isHttps(p.keyUrl)) return null;
    const a = document.createElement('a');
    a.className = 'ext-apikeys-link';
    a.href = p.keyUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `Open the ${p.label} key page`;
    return a;
  }

  // ---------- route choices ----------
  // Each coding agent runs on its plan sign-in or on an API key, and the person picks which (lib/proc.mjs keyRoutesFrom). The
  // server keeps the choice and the answer says what a run does now. The wording is LEGAL's: GEMINI_DESC is the notice text of
  // amend-26, and the links go to the providers' own pages, which open in a new window.
  const ROUTES_INTRO = 'Each coding agent runs on either its plan sign-in or an API key. Your choice is saved as soon as you make it.';
  const CLAUDE_DESC = 'Your Claude subscription and an Anthropic API key bill differently. Plenum never sends a subscription token to the Anthropic API.';
  const CLAUDE_CHOICES = [['cli', 'Claude Code with my subscription'], ['api', 'Anthropic API key']];
  const CLAUDE_TERMS = { label: "Anthropic's rule for Claude Code", url: 'https://code.claude.com/docs/en/legal-and-compliance' };
  const GEMINI_LABEL = 'Use my Google AI key with Gemini CLI';
  const GEMINI_DESC = "Google's terms allow Gemini CLI through an API key but restrict its account sign-in from other apps. Plenum uses your Google AI key for Gemini unless you switch this off; those requests are billed per token.";
  const GEMINI_TERMS = { label: "Google's Gemini CLI terms", url: 'https://www.geminicli.com/docs/resources/tos-privacy' };
  const CODEX_LABEL = 'Use my OpenAI API key with Codex';
  const CODEX_DESC = 'Codex normally uses your ChatGPT sign-in. Turn this on to bill your OpenAI API key per token instead.';
  const CODEX_TERMS = { label: "ChatGPT's Terms of Use", url: 'https://openai.com/policies/terms-of-use/' };

  // A switch with its label and a plain line under it (the same switch row the rest of the app uses).
  function routeSwitch(label, desc, onChange) {
    const row = document.createElement('label');
    row.className = 'switch-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.append(label);
    const small = document.createElement('small');
    small.textContent = desc;
    text.append(small);
    row.append(input, track, text);
    return { row, input };
  }

  // A link to a provider's own page. Only https addresses become links.
  function routeLink({ label, url }) {
    const a = document.createElement('a');
    a.className = 'ext-apikeys-link';
    a.textContent = label;
    if (isHttps(url)) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  // The three choices are built once and painted from the server's answer, so a change keeps the focus where it was.
  function buildRoutes(panel) {
    const controls = [];
    const gemini = routeSwitch(GEMINI_LABEL, GEMINI_DESC, on => saveRoute(panel, { gemini: on }));
    const geminiStatusLine = statusLine('');
    controls.push(gemini.input);

    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Claude route');
    const buttons = new Map();
    for (const [value, label] of CLAUDE_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => saveRoute(panel, { claude: value }));
      buttons.set(value, b);
      controls.push(b);
      seg.append(b);
    }
    const claudeStatusLine = statusLine('');

    const codex = routeSwitch(CODEX_LABEL, CODEX_DESC, on => saveRoute(panel, { codex: on }));
    const codexStatusLine = statusLine('');
    controls.push(codex.input);

    const claudeBlock = document.createElement('div');
    claudeBlock.className = 'ext-apikeys-route';
    claudeBlock.append(statusLine(CLAUDE_DESC), seg, claudeStatusLine, routeLink(CLAUDE_TERMS));
    const geminiBlock = document.createElement('div');
    geminiBlock.className = 'ext-apikeys-route';
    geminiBlock.append(gemini.row, geminiStatusLine, routeLink(GEMINI_TERMS));
    const codexBlock = document.createElement('div');
    codexBlock.className = 'ext-apikeys-route';
    codexBlock.append(codex.row, codexStatusLine, routeLink(CODEX_TERMS));
    controls.push(...buttons.values());
    panel.routes.replaceChildren(statusLine(ROUTES_INTRO), claudeBlock, geminiBlock, codexBlock);
    return {
      controls,
      gemini: { input: gemini.input, status: geminiStatusLine },
      codex: { input: codex.input, status: codexStatusLine },
      claude: { buttons, status: claudeStatusLine },
    };
  }

  // Shows the server's route status. What a run does now is said in words, with the Claude choice and the switches as they are.
  function paintRoutes(panel, routes) {
    if (!panel.ui) panel.ui = buildRoutes(panel);
    const ui = panel.ui;
    const g = routes.gemini ?? {};
    ui.gemini.input.checked = g.on === true;
    // route is what a run does now. keyBlocked: the key is on and saved, but the Gemini CLI is set to its own sign-in, so it is not used.
    ui.gemini.status.textContent = g.route === 'key'
      ? 'Gemini uses your Google AI key. Those requests are billed per token.'
      : g.keyBlocked
        ? 'Gemini CLI is set to its Google sign-in, so your Google AI key is not used. Run gemini, type /auth and pick "Gemini API key" so your key is used.'
        : !g.on
          ? 'Gemini uses its Google sign-in.'
          : 'No Google AI key is saved, so Gemini uses its Google sign-in.';
    const c = routes.claude ?? {};
    for (const [value, button] of ui.claude.buttons) button.setAttribute('aria-pressed', String(c.route === value));
    const automatic = c.choice === null || c.choice === undefined ? ' Chosen automatically. Pick one to keep it.' : '';
    ui.claude.status.textContent = c.route === 'api'
      ? `Claude runs through your Anthropic API key, billed per token.${automatic}`
      : c.cli?.installed === false
        ? `Claude Code is not installed, so Claude cannot run through your subscription yet. Install Claude Code, or choose the Anthropic API key.${automatic}`
        : `Claude runs through Claude Code with your Claude subscription.${automatic}`;
    const x = routes.codex ?? {};
    ui.codex.input.checked = x.on === true;
    ui.codex.status.textContent = !x.on
      ? 'Codex uses its ChatGPT sign-in.'
      : x.saved
        ? 'Codex uses your OpenAI API key, billed per token.'
        : 'No OpenAI API key is saved, so Codex uses its ChatGPT sign-in.';
  }

  // One change is one request. The controls wait for the answer, and only the answer to the latest change is shown. A refused
  // change is reported, and the saved state is read again so the controls show what the server has.
  async function saveRoute(panel, patch) {
    const seq = ++panel.routeSeq;
    setRoutesBusy(panel, true);
    try {
      const data = await MuseUI.api('/api/key-routes', patch);
      if (seq === panel.routeSeq && data?.routes) paintRoutes(panel, data.routes);
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      await refreshStatus(panel);
    } finally {
      if (seq === panel.routeSeq) setRoutesBusy(panel, false);
    }
  }

  function setRoutesBusy(panel, busy) {
    if (!panel.ui) return;
    for (const control of panel.ui.controls) control.disabled = busy;
  }

  // One provider: its status pill, a password input, Save and Test buttons, and the key page link.
  function providerCard(p, panel) {
    const mark = MARKS[p.id] ?? String(p.label ?? p.id).charAt(0).toUpperCase();
    const sub = p.envVar ? `API key · ${p.envVar}` : 'API key';
    const card = MuseUI.cardShell(mark, p.id, p.label, sub, 'Not set', false);
    const pill = card.querySelector('.pill');
    card.append(MuseUI.para(`Billed per token by ${p.label}. Separate from your subscriptions; Plenum never sends this key to any other provider.`));

    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = `Paste your ${p.label} key`;
    input.setAttribute('aria-label', `${p.label} API key`);

    const result = document.createElement('div');
    result.className = 'result';
    result.setAttribute('role', 'status');
    // tone is 'ok', 'bad' or '' for a neutral line while work is running.
    const show = (text, tone) => {
      result.textContent = text;
      result.className = tone ? `result ${tone}` : 'result';
    };

    const save = MuseUI.button('primary small', 'Save key');
    const test = MuseUI.button('ghost small', 'Test saved key');
    let configured = false;
    let busy = false;
    const paint = () => {
      save.disabled = busy;
      // Testing needs a saved key, so the button waits until one exists.
      test.disabled = busy || !configured;
    };
    const apply = status => {
      configured = Boolean(status.configured);
      pill.textContent = configured ? `Saved from ${status.source || 'this computer'}` : 'Not set';
      pill.className = configured ? 'pill ok' : 'pill';
      paint();
    };

    save.addEventListener('click', async () => {
      const key = input.value.trim();
      if (!key) return show('Paste a key first.', 'bad');
      busy = true;
      paint();
      show('Checking the key…', '');
      try {
        const r = await MuseUI.api('/api/keys', { provider: p.id, key });
        const text = scrub(r.message || (r.saved ? 'Saved.' : 'The key was not saved.'), key);
        show(text, r.saved ? 'ok' : 'bad');
        if (r.saved) {
          // The key is in the server now. Clearing the box means it is no longer on this screen.
          input.value = '';
          MuseUI.toast(`${p.label} key saved`);
          await refreshStatus(panel);
        }
      } catch (err) {
        show(scrub(err.message, key), 'bad');
      } finally {
        busy = false;
        paint();
      }
    });
    // Enter in the box saves, the same as the button. A disabled button ignores the click.
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') save.click();
    });

    test.addEventListener('click', async () => {
      busy = true;
      paint();
      show('Checking the saved key…', '');
      try {
        const r = await MuseUI.api('/api/keys/test', { provider: p.id });
        show(r.message || (r.ok ? 'The saved key works.' : 'The saved key did not work.'), r.ok ? 'ok' : 'bad');
      } catch (err) {
        show(err.message, 'bad');
      } finally {
        busy = false;
        paint();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(save, test);
    const link = keyPageLink(p);
    if (link) actions.append(link);
    card.append(input, actions, result);

    apply(p);
    return { root: card, apply };
  }

  // Attach. Only the drawer body is watched. The section is one child of it, so the observer sees the
  // section come and go, but not what is inside it.
  new MutationObserver(sync).observe(MuseUI.el.drawerBody, { childList: true });
  sync();
})();
