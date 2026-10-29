// ext-setup. The first-run setup wizard. It opens in the drawer by itself the first time Plenum is used with no saved key and
// no CLI signed in, the way the other panels open. Four steps: what Plenum is, the CLI sign-ins, the API keys and a summary.
// It uses only routes the Accounts panel already has (GET /api/keys, POST /api/keys, POST /api/keys/test, GET /api/accounts and
// the sign-in routes). POST /api/keys takes only the providers in lib/api-providers.mjs, so Anthropic's key goes through the
// Claude key routes. A key is typed into a password box, sent once and cleared; the wizard keeps no copy of it. Text is set
// with textContent only.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Set up Plenum';
  // Written when the wizard is finished or closed, so it stays away on later visits. Skip for now does not write it.
  const DISMISSED = 'plenum-setup-dismissed';
  // The id of the Setup entry in the side menu.
  const BUTTON_ID = 'setupBtn';
  const STEPS = ['Welcome', 'Sign-ins', 'API keys', 'Done'];
  // Sign-in states. A CLI that is not installed cannot be signed in to, so its button stays off.
  const IN = 'in';
  const OUT = 'out';
  const NONE = 'none';
  // The CLI is installed, but its sign-in could not be read (Cursor's status command timed out or was not read).
  const UNKNOWN = 'unknown';
  const STATE_TEXT = { in: 'Signed in', out: 'Not signed in', none: 'Not installed', unknown: 'Sign-in unknown' };
  const MISSING = 'Not installed. Install it, then press Check again.';

  // Step 3, in order. Each label and variable name matches lib/api-providers.mjs (Anthropic: lib/keys.mjs). GET /api/keys
  // gives each provider's key page; a provider that list leaves out is hidden.
  const KEYS = [
    { id: 'anthropic', label: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', mark: 'C' },
    { id: 'xai', label: 'xAI (Grok)', envVar: 'XAI_API_KEY', mark: 'X' },
    { id: 'openai', label: 'OpenAI API', envVar: 'OPENAI_API_KEY', mark: 'O' },
    { id: 'deepseek', label: 'DeepSeek', envVar: 'DEEPSEEK_API_KEY', mark: 'D' },
    { id: 'mistral', label: 'Mistral', envVar: 'MISTRAL_API_KEY', mark: 'M' },
    { id: 'googleai', label: 'Google AI (Gemini API)', envVar: 'GOOGLE_AI_API_KEY', mark: 'G' },
    { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', mark: 'R' },
  ];

  // Claude's key is in use only when Claude runs through the API, which is when the Claude CLI is not installed.
  const claudeUsesKey = a => a?.claude?.route === 'api';
  const cliState = (c, signedInKey) => (!c?.installed ? NONE : c[signedInKey] ? IN : OUT);
  // Cursor's status comes from GET /api/accounts/cli (see withCli). It is null when that read failed, and its sign-in may be unknown.
  const cursorState = c => (!c ? UNKNOWN : !c.installed ? NONE : c.signedIn === true ? IN : c.signedIn === false ? OUT : UNKNOWN);
  // Grok Build reads the same way: its status comes from GET /api/accounts/cli as accounts.grok (lib/grok.mjs grokStatus).
  const grokState = g => (!g ? UNKNOWN : !g.installed ? NONE : g.signedIn === true ? IN : g.signedIn === false ? OUT : UNKNOWN);

  // Step 2, in order. Each row reads its state from GET /api/accounts (Cursor's from GET /api/accounts/cli) and signs in through its own route.
  const CLIS = [
    {
      id: 'claude', name: 'Claude Code', account: 'Claude account', mark: 'C', path: '/api/accounts/claude/login',
      // Claude runs through the Claude CLI only when the CLI is installed; otherwise it uses the Anthropic key from step 3.
      state: a => (a?.claude?.route === 'cli' ? (a.claude.connected ? IN : OUT) : NONE),
      missing: 'Not installed. Claude runs on an Anthropic API key instead, which step 3 sets up.',
    },
    { id: 'codex', name: 'Codex', account: 'ChatGPT account', mark: 'X', path: '/api/accounts/codex/login', state: a => cliState(a?.codex, 'loggedIn'), missing: MISSING },
    { id: 'gemini', name: 'Gemini CLI', account: 'Google account', mark: 'G', path: '/api/accounts/gemini/login', state: a => cliState(a?.gemini, 'signedIn'), missing: MISSING },
    { id: 'muse', name: 'Muse Code', account: 'Meta account', mark: 'M', path: '/api/accounts/muse/login', state: a => cliState(a?.muse, 'signedIn'), missing: MISSING },
    { id: 'cursor', name: 'Cursor', account: 'Cursor account', mark: 'U', path: '/api/accounts/cursor/login', state: a => cursorState(a?.cursor), missing: MISSING },
    { id: 'grok', name: 'Grok Build', account: 'xAI account', mark: 'K', path: '/api/accounts/grok/login', state: a => grokState(a?.grok), missing: MISSING },
  ];

  // GET /api/accounts/cli: the coding agents added after the first four (Cursor and Grok Build). A failed read is null, and its row says it is unknown.
  const cliStatus = () => MuseUI.api('/api/accounts/cli').catch(() => null);
  // The sign-ins the rows read: GET /api/accounts, with Cursor's and Grok Build's status from GET /api/accounts/cli added as accounts.cursor and accounts.grok.
  const withCli = (accounts, cli) => ({ ...accounts, cursor: cli?.cursor ?? null, grok: cli?.grok ?? null });

  // Whether a key is saved for a provider: Anthropic's through the Claude route, the others through GET /api/keys.
  function keyConfigured(s, id) {
    if (id === 'anthropic') return claudeUsesKey(s.accounts) && s.accounts.claude.connected === true;
    return s.keys.providers.some(p => p.id === id && p.configured === true);
  }
  // Only https addresses become links, so a key page from the server cannot point the wizard anywhere else.
  const isHttps = url => typeof url === 'string' && /^https:\/\//.test(url);
  // The server does not echo a key, but a message goes on screen, so the key is removed from it as well.
  const scrub = (text, key) => (key ? String(text ?? '').split(key).join('') : String(text ?? ''));

  // ---------- remembering the dismissal ----------

  // Storage can be blocked, so every access is guarded. A blocked read means the wizard may open again, which is harmless.
  function dismissed() {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  }

  function remember() {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // Blocked storage: the wizard may come back on a later visit. The page works the same without it.
    }
  }

  // Clears the dismissal. Only the Setup entry calls this, so a click on it opens the wizard even after a dismissal.
  function forget() {
    try {
      localStorage.removeItem(DISMISSED);
    } catch {
      // Blocked storage: the flag cannot be cleared, but the Setup click still opens the wizard for this visit.
    }
  }

  // ---------- state ----------

  let status = null;   // { keys, accounts }, as the server last sent them
  let ui = null;       // the wizard's elements from the last draw
  let step = 1;
  let current = false; // true while the wizard is the drawer's content

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The heading of each step takes focus when its step opens, so a screen reader announces the step.
  function stepHeading(text) {
    const h = make('h3', 'setup-heading', text);
    h.tabIndex = -1;
    return h;
  }

  // ---------- the drawer ----------

  // Builds the wizard into the drawer. Each draw builds the elements again; the step and the status survive a redraw.
  function draw(body) {
    body.append(build());
    showStep(false);
    if (status) paintAll();
    else loadStatus();
  }

  function build() {
    ui = { clis: [], keys: [], panes: [], heads: [] };
    const root = make('div', 'setup');
    ui.count = make('p', 'setup-count');
    ui.line = make('p', 'setup-status');
    ui.line.setAttribute('role', 'status');
    const parts = [welcomePane(), signInPane(), keyPane(), donePane()];
    ui.panes = parts.map(p => p.pane);
    ui.heads = parts.map(p => p.heading);
    root.append(ui.count, ...ui.panes, ui.line, navFooter());
    return root;
  }

  // Opens the wizard in the drawer, as the other panels open, so the drawer's close button, the scrim and Escape all close it.
  function openWizard() {
    current = true;
    step = 1;
    MuseUI.openDrawer(TITLE, draw);
    showStep(true);
  }

  // Closes the wizard without remembering it, so it can come back on a later visit (Skip for now).
  function closeWizard() {
    current = false;
    MuseUI.closeDrawer();
  }

  function finishSetup() {
    remember();
    closeWizard();
  }

  function goTo(delta) {
    step = Math.min(STEPS.length, Math.max(1, step + delta));
    showStep(true);
  }

  // Shows one step, sets the counter and the buttons, and moves focus to the step heading when asked.
  function showStep(focus) {
    if (!ui) return;
    ui.panes.forEach((pane, i) => { pane.hidden = i !== step - 1; });
    ui.count.textContent = `Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}`;
    ui.back.disabled = step === 1;
    ui.next.hidden = step === STEPS.length;
    ui.finish.hidden = step !== STEPS.length;
    if (step === STEPS.length) paintSummary();
    if (focus) ui.heads[step - 1].focus();
  }

  function navFooter() {
    const foot = make('div', 'setup-foot');
    const skip = MuseUI.button('ghost small', 'Skip for now');
    skip.addEventListener('click', () => closeWizard());
    const nav = make('div', 'setup-nav');
    ui.back = MuseUI.button('ghost small', 'Back');
    ui.back.addEventListener('click', () => goTo(-1));
    ui.next = MuseUI.button('primary small', 'Next');
    ui.next.addEventListener('click', () => goTo(1));
    ui.finish = MuseUI.button('primary small', 'Finish');
    ui.finish.addEventListener('click', () => finishSetup());
    nav.append(ui.back, ui.next, ui.finish);
    foot.append(skip, nav);
    return foot;
  }

  // ---------- step 1: welcome ----------

  function welcomePane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Welcome to Plenum');
    const facts = make('ul', 'setup-list');
    facts.append(
      make('li', '', 'Keys are kept in the operating system’s encrypted store on the desktop app.'),
      make('li', '', 'The network is used for the providers you set up, a check of GitHub for new versions (at start and every four hours; turn it off in Settings › Updates), and public price lists when you open the API finder.'),
      make('li', '', 'Nothing goes to Plenum’s developer.'),
      make('li', '', 'The license agreement and privacy notice are under Legal in Settings.'),
    );
    const lead = make('p', 'setup-lead', 'Plenum is a local console for working with Claude, Codex, Gemini, Muse Code, Cursor, Grok Build and per-token API models in your own project folders.');
    // Opens the Legal section. The wizard is the drawer's content, so the Legal page takes its place; Setup in the menu brings it back.
    const terms = make('button', 'ghost small', 'Read the terms');
    terms.type = 'button';
    terms.addEventListener('click', () => MuseUI.openLegal?.());
    pane.append(heading, lead, facts, terms);
    return { pane, heading };
  }

  // ---------- step 2: sign-ins ----------

  function signInPane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Sign in to your CLIs');
    const lead = make('p', 'setup-lead', 'Sign in opens a window. You finish the sign-in in that window, and the credentials stay with that tool. Then press Check again here.');
    ui.clis = CLIS.map(c => cliRow(c));
    const rows = make('div', 'setup-rows');
    rows.append(...ui.clis.map(r => r.card));
    const again = MuseUI.button('ghost small', 'Check again');
    again.addEventListener('click', () => loadStatus());
    const actions = make('div', 'actions');
    actions.append(again);
    pane.append(heading, lead, rows, actions);
    // The provider-terms strip sits above the sign-in rows (step 2, as in Accounts).
    MuseUI.notice?.('provider-terms', { before: rows });
    return { pane, heading };
  }

  function cliRow(c) {
    const card = MuseUI.cardShell(c.mark, c.id, c.name, c.account, 'Checking…', false);
    const row = { c, card, pill: card.querySelector('.pill'), note: make('p', '', 'Checking your accounts…'), button: MuseUI.button('primary small', 'Sign in'), busy: false };
    row.button.disabled = true;
    row.button.addEventListener('click', () => signIn(row));
    const actions = make('div', 'actions');
    actions.append(row.button);
    card.append(row.note, actions);
    return row;
  }

  // Starts the CLI's own sign-in window through its route, then reads the status again. The person finishes the sign-in there.
  async function signIn(row) {
    row.busy = true;
    paintCli(row);
    try {
      await MuseUI.api(row.c.path, {});
      MuseUI.toast('Sign-in window opened. Finish it there, then press Check again.');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
    } finally {
      row.busy = false;
    }
    await loadStatus();
    paintCli(row);
  }

  function paintCli(row) {
    const state = status ? row.c.state(status.accounts) : null;
    row.pill.textContent = state ? STATE_TEXT[state] : 'Checking…';
    row.pill.className = state === IN ? 'pill ok' : 'pill';
    row.note.textContent = !state ? 'Checking your accounts…'
      : state === IN ? 'Signed in on this computer.'
        : state === NONE ? row.c.missing
          : state === UNKNOWN ? 'Plenum could not read this sign-in. Sign in opens a window that you complete there, or press Check again.'
            : 'Not signed in. Sign in opens a window that you complete there.';
    row.button.textContent = state === IN ? 'Sign in again' : 'Sign in';
    row.button.disabled = row.busy || state === null || state === NONE;
  }

  // ---------- step 3: API keys ----------

  function keyPane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Add API keys');
    const lead = make('p', 'setup-lead', 'Keys are for providers that bill per token. Save checks a key with its provider, then keeps it. Test sends one small request to the provider to check the saved key.');
    ui.notice = make('p', 'setup-notice');
    ui.notice.hidden = true;
    ui.keys = KEYS.map(k => keyRow(k));
    const rows = make('div', 'setup-rows');
    rows.append(...ui.keys.map(r => r.card));
    pane.append(heading, lead, ui.notice, rows);
    // The per-token billing strip sits above the key rows (step 3, as in Accounts).
    MuseUI.notice?.('api-keys-spend', { before: rows });
    return { pane, heading };
  }

  function keyRow(k) {
    const card = MuseUI.cardShell(k.mark, k.id === 'anthropic' ? 'claude' : k.id, k.label, `API key · ${k.envVar}`, 'Checking…', false);
    const row = {
      id: k.id,
      label: k.label,
      card,
      pill: card.querySelector('.pill'),
      billing: `Billed per token by ${k.label}. Plenum sends this key only to ${k.label}.`,
      note: make('p', '', `Billed per token by ${k.label}. Plenum sends this key only to ${k.label}.`),
      input: document.createElement('input'),
      save: MuseUI.button('primary small', 'Save key'),
      test: MuseUI.button('ghost small', 'Test saved key'),
      link: make('a', 'setup-link'),
      result: make('div', 'result'),
      busy: false,
    };
    row.input.type = 'password';
    row.input.autocomplete = 'off';
    row.input.spellcheck = false;
    row.input.placeholder = `Paste your ${k.label} key`;
    row.input.setAttribute('aria-label', `${k.label} API key`);
    row.result.setAttribute('role', 'status');
    row.link.target = '_blank';
    row.link.rel = 'noopener noreferrer';
    row.link.hidden = true;
    row.save.addEventListener('click', () => saveKey(row));
    row.test.addEventListener('click', () => testKey(row));
    // Enter in the box saves, the same as the button. A disabled button ignores the click.
    row.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') row.save.click();
    });
    const actions = make('div', 'actions');
    actions.append(row.save, row.test, row.link);
    card.append(row.note, row.input, actions, row.result);
    paintKey(row);
    return row;
  }

  // Sends the typed key once, to the route for its provider. The box is cleared after every attempt, so the key is not shown again.
  async function saveKey(row) {
    const key = row.input.value.trim();
    if (!key) return show(row, 'Paste a key first.', false);
    row.busy = true;
    paintKey(row);
    show(row, 'Checking the key…', null);
    try {
      const r = row.id === 'anthropic'
        ? await MuseUI.api('/api/accounts/claude/key', { key })
        : await MuseUI.api('/api/keys', { provider: row.id, key });
      show(row, scrub(r.message || (r.saved ? 'Saved.' : 'The key was not saved.'), key), r.saved === true);
      if (r.saved === true) {
        MuseUI.toast(`${row.label} key saved`);
        await loadStatus();
      }
    } catch (err) {
      show(row, scrub(err.message, key), false);
    } finally {
      row.input.value = '';
      row.busy = false;
      paintKey(row);
    }
  }

  // Asks the provider whether the saved key is accepted. Test is only offered once a key is saved.
  async function testKey(row) {
    row.busy = true;
    paintKey(row);
    show(row, 'Checking the saved key…', null);
    try {
      const r = row.id === 'anthropic'
        ? await MuseUI.api('/api/accounts/claude/test', {})
        : await MuseUI.api('/api/keys/test', { provider: row.id });
      show(row, `${r.ok ? 'Accepted.' : 'Refused.'} ${r.message ?? ''}`.trim(), r.ok === true);
    } catch (err) {
      show(row, err.message, false);
    } finally {
      row.busy = false;
      paintKey(row);
    }
  }

  function show(row, text, ok) {
    row.result.textContent = text;
    row.result.className = ok === true ? 'result ok' : ok === false ? 'result bad' : 'result';
  }

  // Paints one key row: its status, whether Test can run, whether Save is allowed, and the key page link.
  function paintKey(row) {
    const s = status;
    const listed = !s || row.id === 'anthropic' || s.keys.providers.some(p => p.id === row.id);
    row.card.hidden = !listed;
    const configured = s ? keyConfigured(s, row.id) : false;
    const unused = Boolean(s) && row.id === 'anthropic' && !claudeUsesKey(s.accounts);
    row.pill.textContent = !s ? 'Checking…' : unused ? 'Not used' : configured ? 'Saved' : 'Not set';
    row.pill.className = configured ? 'pill ok' : 'pill';
    row.note.textContent = unused
      ? 'Claude Code runs through the Claude CLI here, so this key is not used while the CLI is installed.'
      : row.billing;
    row.test.disabled = row.busy || !configured;
    row.save.disabled = row.busy || s?.keys?.storage?.canSave === false;
    const page = s?.keys?.providers?.find(p => p.id === row.id)?.keyUrl;
    row.link.hidden = !isHttps(page);
    if (isHttps(page)) {
      row.link.href = page;
      row.link.textContent = `Open the ${row.label} key page`;
    }
  }

  // ---------- step 4: summary ----------

  function donePane() {
    const pane = make('section', 'setup-pane');
    const heading = stepHeading('Here is what is set up');
    const lead = make('p', 'setup-lead', 'You can change any of this later in Accounts.');
    ui.summary = make('ul', 'setup-list');
    ui.summaryNone = make('p', 'setup-lead', 'Nothing is set up yet. You can sign in or add a key later from Accounts.');
    pane.append(heading, lead, ui.summary, ui.summaryNone);
    return { pane, heading };
  }

  function paintSummary() {
    if (!ui || !ui.summary || !status) return;
    const signed = CLIS.filter(c => c.state(status.accounts) === IN).map(c => c.name);
    const saved = ui.keys.filter(r => keyConfigured(status, r.id)).map(r => r.label);
    const lines = [];
    if (signed.length) lines.push(`Signed in: ${signed.join(', ')}.`);
    if (saved.length) lines.push(`Keys saved: ${saved.join(', ')}.`);
    ui.summary.replaceChildren(...lines.map(text => make('li', '', text)));
    ui.summaryNone.hidden = lines.length > 0;
  }

  // ---------- painting and reading the status ----------

  function paintAll() {
    if (!ui || !status) return;
    const storage = status.keys.storage;
    // Session-only keys, or a store that refuses saves, are said plainly above the key boxes.
    ui.notice.textContent = storage?.message ?? '';
    ui.notice.hidden = !storage || storage.mode === 'keychain';
    ui.clis.forEach(paintCli);
    ui.keys.forEach(paintKey);
    paintSummary();
  }

  // Reads the keys and the sign-ins again and paints them. A failed read leaves the last status on screen and says so.
  async function loadStatus() {
    try {
      const [keys, accounts, cli] = await Promise.all([MuseUI.api('/api/keys'), MuseUI.api('/api/accounts'), cliStatus()]);
      if (!Array.isArray(keys?.providers) || !accounts?.claude) {
        showLine('The status did not come back. Try again.', true);
        return;
      }
      status = { keys, accounts: withCli(accounts, cli) };
    } catch (err) {
      showLine(err.message, true);
      return;
    }
    showLine('', false);
    paintAll();
  }

  function showLine(text, bad) {
    if (!ui) return;
    ui.line.textContent = text;
    ui.line.className = bad ? 'setup-status bad' : 'setup-status';
  }

  // ---------- opening on the first run ----------

  // Runs once when the page loads. It reads the keys and the sign-ins, and opens the wizard only when nothing is set up yet.
  async function firstRun() {
    // The agreement card comes first. Nothing about setup is read until the terms are accepted (ext-legal.js resolves this).
    await (MuseUI.legalReady ?? Promise.resolve());
    if (dismissed()) return;
    let keys;
    let accounts;
    let cli;
    try {
      [keys, accounts, cli] = await Promise.all([MuseUI.api('/api/keys'), MuseUI.api('/api/accounts'), cliStatus()]);
    } catch {
      // The server has not answered, so nothing is opened. The next visit checks again.
      return;
    }
    if (!Array.isArray(keys?.providers) || !accounts?.claude) return;
    status = { keys, accounts: withCli(accounts, cli) };
    if (KEYS.some(k => keyConfigured(status, k.id)) || CLIS.some(c => c.state(status.accounts) === IN)) return;
    // The person may have opened another panel while the check ran. The wizard waits for an empty drawer and never replaces one.
    if (!MuseUI.el.drawer.hidden) return;
    openWizard();
  }

  // ---------- closing ----------

  // A close of the drawer while the wizard is on screen counts as a dismissal, whichever control closed it: the close button,
  // the scrim, Escape or Finish. Skip for now clears current first, so it is not remembered.
  function onScreen() {
    return current && !MuseUI.el.drawer.hidden && MuseUI.el.drawerTitle.textContent === TITLE;
  }

  // Only a close the person makes is a dismissal: the close button, the scrim or Escape (README: Setup wizard). Settings (Ctrl+,), Read the
  // terms and other panels close the drawer themselves, and that is not a dismissal, so the wizard comes back next time (B-58). The
  // capture phase runs before the drawer closes, so the flag is set first.
  function personalClose(e) {
    if (!onScreen()) return;
    const byClick = e.type === 'click' && e.target.closest?.('#drawerClose, #scrim');
    const byEscape = e.type === 'keydown' && e.key === 'Escape' && !MuseUI.dialogOpen?.();
    if (byClick || byEscape) remember();
  }
  document.addEventListener('click', personalClose, true);
  document.addEventListener('keydown', personalClose, true);
  // Whatever closes the drawer, the wizard is no longer its content once it is hidden.
  new MutationObserver(() => {
    if (current && MuseUI.el.drawer.hidden) current = false;
  }).observe(MuseUI.el.drawer, { attributes: true, attributeFilter: ['hidden'] });

  document.addEventListener('keydown', e => {
    // A confirm dialog opened over the wizard (Decline and quit, for one) takes Escape for itself; the wizard stays open.
    if (e.key === 'Escape' && onScreen() && !MuseUI.dialogOpen?.()) MuseUI.closeDrawer();
  });

  // ---------- the side menu entry ----------

  // The entry sits above Accounts, after Pipelines. It only opens the wizard, so the same panel opens again after a dismissal.
  function sideButton() {
    const b = make('button', 'side-link');
    b.type = 'button';
    b.id = BUTTON_ID;
    b.title = 'Set up Plenum: sign-ins and API keys';
    b.append(MuseUI.icon('sparkle'), 'Setup');
    b.addEventListener('click', openSetup);
    return b;
  }

  // The click clears the dismissal and opens the wizard at its first step. The first-run check never clears it.
  function openSetup() {
    forget();
    openWizard();
  }

  // Attach. The entry is added once, above Accounts, when the panel script loads.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.accountsBtn.before(sideButton());

  firstRun().catch(() => {});
})();
