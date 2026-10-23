// ext-accounts-cli. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The Cursor card in the Coding agents group of Settings > Accounts (UI-ARCH section 10.9). The card reads GET /api/accounts/cli,
// which reports whether the Cursor CLI is installed and signed in (lib/cursor.mjs cursorStatus). Sign in opens a terminal running
// the CLI's own login (POST /api/accounts/cursor/login), and the sign-in stays with Cursor, never with Plenum. Text is set with
// textContent only, and nothing here stores a sign-in or a key.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI, and its codingAgents group, before the extra panels load. Without them there is nothing to attach to.
  if (!MuseUI || !MuseUI.codingAgents) return;

  // The install commands, the same ones lib/cursor.mjs CURSOR_HINT gives.
  const INSTALL_WINDOWS = "irm 'https://cursor.com/install?win32=true' | iex";
  const INSTALL_POSIX = 'curl https://cursor.com/install -fsS | bash';
  // The order of the card in the group: after Claude Code, Codex, Gemini CLI and Muse Code (app.js BUILT_IN_AGENTS), before Grok Build.
  const ORDER = 50;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The pill and its tone for the state. cli is GET /api/accounts/cli, or null when that read failed.
  function pillOf(c) {
    if (!c) return { text: 'Sign-in unknown', ok: false };
    if (!c.installed) return { text: 'Not installed', ok: false };
    if (c.signedIn === true) return { text: 'Signed in', ok: true };
    if (c.signedIn === false) return { text: 'Not signed in', ok: false };
    return { text: 'Sign-in unknown', ok: false };
  }

  // The two install commands, one for each system, each set as code so it can be copied.
  function installBlock() {
    const block = make('div', 'cli-cmds');
    block.append(
      make('p', 'cli-cmd-label', 'Windows, in PowerShell'),
      make('code', 'cli-cmd', INSTALL_WINDOWS),
      make('p', 'cli-cmd-label', 'macOS or Linux, in a terminal'),
      make('code', 'cli-cmd', INSTALL_POSIX),
    );
    return block;
  }

  // The card's text for the state. Every line says what happens, then the way back.
  function describe(card, c) {
    if (!c) {
      card.append(MuseUI.para('Cursor status is not available yet. Press Refresh.'));
      return;
    }
    if (!c.installed) {
      // The server may name why the `agent` on PATH is not Cursor's CLI. That text is shown as it is sent.
      if (typeof c.note === 'string' && c.note) card.append(MuseUI.para(c.note));
      card.append(MuseUI.para('Install the Cursor CLI first, then press Refresh. Run the command for your system in a terminal:'));
      card.append(installBlock());
      return;
    }
    if (c.signedIn === true) {
      const email = typeof c.email === 'string' && c.email ? ` for ${c.email}` : '';
      card.append(MuseUI.para(`Cursor has a saved sign-in on this computer${email}.`));
      return;
    }
    if (c.signedIn === false) {
      card.append(MuseUI.para('Sign in to your Cursor account. A terminal opens and your browser completes the sign-in; then press Refresh.'));
      return;
    }
    card.append(MuseUI.para('Plenum could not tell whether Cursor is signed in. If it is not, sign in to your Cursor account: a terminal opens and your browser completes the sign-in. Then press Refresh.'));
  }

  // The Cursor card. ctx is { accounts, cli } from app.js renderAccounts; only cli is used here.
  function cursorCard(ctx) {
    const c = ctx?.cli?.cursor ?? null;
    const state = pillOf(c);
    const card = MuseUI.cardShell('U', 'cursor', 'Cursor', 'Cursor account', state.text, state.ok);
    describe(card, c);
    card.append(MuseUI.para('Cursor asks Plenum before it edits or runs commands, so Ask first works. Its tools are its own.'));

    const actions = document.createElement('div');
    actions.className = 'actions';
    // The button names the product, as the other coding agents' buttons do. It is off until the CLI is installed.
    const signIn = MuseUI.button('primary small', 'Sign in to Cursor');
    signIn.disabled = !c?.installed;
    signIn.addEventListener('click', async () => {
      try {
        await MuseUI.api('/api/accounts/cursor/login', {});
        MuseUI.toast('Sign-in window opened. Finish in your browser, then press Refresh.');
      } catch (err) {
        MuseUI.toast(err.message, 'bad');
      }
    });
    const refresh = MuseUI.button('ghost small', 'Refresh');
    refresh.addEventListener('click', () => MuseUI.refreshDrawer());
    actions.append(signIn, refresh);
    card.append(actions);
    // The provider-terms strip sits above the Sign in row, as on the other coding agents' cards. It informs; the sign-in still runs on the button.
    MuseUI.notice?.('provider-terms', { before: actions });
    return card;
  }

  MuseUI.codingAgents.add({ id: 'cursor', order: ORDER, card: cursorCard });
})();
