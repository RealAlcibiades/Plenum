// ext-accounts-cli. Owned by its panel builder. Builds on window.MuseUI (see app.js).
// The Cursor and Grok Build cards in the Coding agents group of Settings > Accounts (UI-ARCH sections 5 and 10.9). The cards read GET
// /api/accounts/cli, which reports whether each CLI is installed and signed in (lib/cursor.mjs cursorStatus, lib/grok.mjs grokStatus).
// Sign in opens a terminal running the CLI's own login (POST /api/accounts/cursor/login and POST /api/accounts/grok/login), and the
// sign-in stays with that CLI, never with Plenum. Text is set with textContent only, and nothing here stores a sign-in or a key.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI, and its codingAgents group, before the extra panels load. Without them there is nothing to attach to.
  if (!MuseUI || !MuseUI.codingAgents) return;

  // The install commands, the same ones lib/cursor.mjs CURSOR_HINT gives.
  const CURSOR_WINDOWS = "irm 'https://cursor.com/install?win32=true' | iex";
  const CURSOR_POSIX = 'curl https://cursor.com/install -fsS | bash';
  // The install commands, the same ones lib/grok.mjs GROK_HINT gives.
  const GROK_WINDOWS = 'irm https://x.ai/cli/install.ps1 | iex';
  const GROK_POSIX = 'curl -fsSL https://x.ai/cli/install.sh | bash';
  // The order of the cards in the group: Claude Code, Codex, Gemini CLI and Muse Code are 10 to 40 (app.js BUILT_IN_AGENTS), then Cursor, then Grok Build.
  const CURSOR_ORDER = 50;
  const GROK_ORDER = 60;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The pill and its tone for the state. c is the CLI's status from GET /api/accounts/cli, or null when that read failed.
  function pillOf(c) {
    if (!c) return { text: 'Sign-in unknown', ok: false };
    if (!c.installed) return { text: 'Not installed', ok: false };
    if (c.signedIn === true) return { text: 'Signed in', ok: true };
    if (c.signedIn === false) return { text: 'Not signed in', ok: false };
    return { text: 'Sign-in unknown', ok: false };
  }

  // The two install commands, one for each system, each set as code so it can be copied.
  function installBlock(windows, posix) {
    const block = make('div', 'cli-cmds');
    block.append(
      make('p', 'cli-cmd-label', 'Windows, in PowerShell'),
      make('code', 'cli-cmd', windows),
      make('p', 'cli-cmd-label', 'macOS or Linux, in a terminal'),
      make('code', 'cli-cmd', posix),
    );
    return block;
  }

  // Cursor's card text for the state. Every line says what happens, then the way back.
  function describeCursor(card, c) {
    if (!c) {
      card.append(MuseUI.para('Cursor status is not available yet. Press Refresh.'));
      return;
    }
    if (!c.installed) {
      // The server may name why the `agent` on PATH is not Cursor's CLI. That text is shown as it is sent.
      if (typeof c.note === 'string' && c.note) card.append(MuseUI.para(c.note));
      card.append(MuseUI.para('Install the Cursor CLI first, then press Refresh. Run the command for your system in a terminal:'));
      card.append(installBlock(CURSOR_WINDOWS, CURSOR_POSIX));
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
    describeCursor(card, c);
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

  // Grok Build's card text for the state. The unknown state says what Plenum can and cannot tell (lib/grok.mjs grokStatus).
  function describeGrok(card, g) {
    if (!g) {
      card.append(MuseUI.para('Grok Build status is not available yet. Press Refresh.'));
      return;
    }
    if (!g.installed) {
      card.append(MuseUI.para('Install Grok Build first, then press Refresh. Run the command for your system in a terminal:'));
      card.append(installBlock(GROK_WINDOWS, GROK_POSIX));
      return;
    }
    if (g.signedIn === true) {
      card.append(MuseUI.para('Grok Build has a saved sign-in on this computer.'));
      return;
    }
    if (g.signedIn === false) {
      card.append(MuseUI.para('Sign in to your SuperGrok or X Premium Plus account. A terminal opens and your browser completes the sign-in; then press Refresh.'));
      return;
    }
    card.append(MuseUI.para('Plenum cannot tell whether Grok Build is signed in; the first reply says if sign-in is needed. Sign in to Grok Build opens a terminal, and your browser completes the sign-in there. Then press Refresh.'));
  }

  // The Grok Build card. The same ctx as Cursor's. Its sign-in is the CLI's own `grok login`, and the API key for Grok stays on the xAI card.
  function grokCard(ctx) {
    const g = ctx?.cli?.grok ?? null;
    const state = pillOf(g);
    const card = MuseUI.cardShell('K', 'grok', 'Grok Build', 'SuperGrok or X Premium Plus', state.text, state.ok);
    describeGrok(card, g);
    card.append(MuseUI.para('Grok Build asks Plenum before it edits or runs commands. By API key, use the xAI card below.'));

    const actions = document.createElement('div');
    actions.className = 'actions';
    // The button names the product, as the other coding agents' buttons do. It is off until the CLI is installed.
    const signIn = MuseUI.button('primary small', 'Sign in to Grok Build');
    signIn.disabled = !g?.installed;
    signIn.addEventListener('click', async () => {
      try {
        await MuseUI.api('/api/accounts/grok/login', {});
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

  MuseUI.codingAgents.add({ id: 'cursor', order: CURSOR_ORDER, card: cursorCard });
  MuseUI.codingAgents.add({ id: 'grok', order: GROK_ORDER, card: grokCard });
})();
