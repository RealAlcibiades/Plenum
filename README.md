# Plenum

A local console that runs Claude Code, Codex, Gemini CLI and Muse Code, and API models. It runs on your machine, serves a browser UI at
http://127.0.0.1:4317, and talks to:

- **Claude** through the Claude CLI (`claude`), signed in with your Claude account. It reads and searches the project, creates and edits files, runs commands, and can propose changes to Plenum itself. Without the CLI it falls back to the Anthropic API and a saved key.
- **Muse Code** (Meta) through `muse exec`, run in the project folder. Sign in with `muse login`, or set `META_API_KEY`.
- **Codex** through `codex exec`, run in the project folder. By default it may change files in the project folder only.
- **Gemini** through the Gemini CLI (`gemini`), signed in with a Google account and run in the project folder.
- **Grok (xAI), OpenAI, DeepSeek, Mistral and Google AI** through their APIs, and **OpenRouter** for any model it lists. These are billed per token with a key you save in the Accounts panel. See [API model providers](#api-model-providers).
- **Echo**, an offline test provider that calls nothing.

## Platforms

Plenum runs on Windows, macOS and Linux. Build the desktop app from this folder. The first build downloads Electron (and, on Windows, the NSIS installer tools):

```bash
npm install
npm run dist           # Windows: NSIS installer, portable .exe and zip (x64)
npm run dist:mac       # macOS: dmg and zip for arm64 and x64
npm run dist:mac:arm64 # macOS: dmg and zip for arm64 only
npm run dist:mac:x64   # macOS: dmg and zip for x64 only
npm run dist:linux     # Linux: AppImage and deb (x64)
```

Installers are written to `release/`.

Pushing a version tag (`v*`) runs `.github/workflows/release.yml`. It builds Windows on `windows-latest` (`npm run dist`), macOS arm64 on `macos-latest` (`npm run dist:mac:arm64`), macOS x64 on `macos-15-intel` (`npm run dist:mac:x64`), and Linux x64 on `ubuntu-latest` (`npm run dist:linux`). Each build is uploaded as a workflow artifact. Nothing is published.

The macOS builds from the release workflow are unsigned until signing certificates are added, and the Linux builds are not signed. The Windows and macOS jobs sign only when their certificate secret is set (`WIN_CSC_LINK`, `CSC_LINK`), and a broken certificate fails the build instead of shipping unsigned. The macOS job notarises only when all three App Store Connect secrets are set (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`). Until a build is signed, Windows SmartScreen may warn about the installer, and macOS asks you to allow the app in System Settings under Privacy & Security.

## Windows app

The installer is written to `release/` as `Plenum Setup 0.4.1.exe`. It shows the licence page first, which you accept before anything is installed. It installs per user (no admin rights needed) to the default per-user folder, without asking for a folder, and adds a Desktop shortcut and a Start menu entry. It opens Plenum in its own window. Closing the window stops the server, unless **Keep in tray on close** is on (see [Portable and tray mode](#portable-and-tray-mode)).

`npm run pack` builds an unpacked folder at `release/win-unpacked/` for quick testing: run `Plenum.exe` in it. `start.bat` opens that build.

To keep it on the taskbar, open Plenum, right-click its taskbar icon and choose **Pin to taskbar**.

The look follows the system (light or dark). The **Theme** button in the sidebar, or `/theme dark`, overrides that.

Applied updates are kept in Plenum's state folder, never in the install folder, so the install location does not need to be writable for them. See [Updates to Plenum](#updates-to-plenum).

## Run without the app window

In a terminal, in this folder:

```bash
npm install
npm start
```

`npm start` runs `plenum.mjs`, which settles any applied update first and then starts the server. The terminal prints a link such as `http://127.0.0.1:4317/#token=...`. Open that link in a browser. The token in it is new for each start, and it is what lets the page talk to the server, so keep the link to yourself. It is the same app with the same state. Keys saved in the desktop app are not available here; see [Where keys are kept](#where-keys-are-kept).

`node server.mjs` runs the same server with the shipped files and no applied updates.

## Setup wizard

The first time Plenum opens with no saved key and no CLI signed in, the setup wizard opens by itself. It has four steps: a welcome, the CLI sign-ins (Claude Code, Codex, Gemini CLI and Muse Code), the API keys, and a summary. Each sign-in button opens that CLI's own sign-in window. A key is typed into a password box, sent once and cleared.

**Skip for now** closes the wizard, and it may open again on a later visit. Any other way of closing it (Finish, Escape, the close button, or a click on the dimmed background) means it stays closed. The **Setup** entry in the side menu, above Accounts, always reopens it. The wizard is in `public/ext-setup.js`.

## Accounts

Open **Accounts** in the sidebar (or click any status item at the bottom of the window):

- **Claude:** Claude runs through the Claude CLI (`claude`), signed in with your Claude account, so it uses your Claude plan rather than an API key. **Sign in with Claude** opens a terminal running `claude auth login`; finish in your browser, then press **Refresh**. Plenum looks for the Claude, Codex and Gemini CLIs on PATH first, then in its own tools folder. Install or update them with `npm install --prefix "%USERPROFILE%\.muse-console\tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on Windows, or `npm install --prefix "$HOME/.muse-console/tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on macOS and Linux. You sign in once. The CLI keeps the sign-in, not Plenum. If the CLI is not installed, the card asks for an Anthropic API key instead and Claude uses the API.
- **Muse Code:** **Sign in with Meta account** opens a terminal running `muse login`. Approve the code in your browser, then press **Refresh**. `META_API_KEY`, if set on the computer, is passed to Muse Code. Muse Code is installed with its own installer; Plenum gives no install command for it.
- **Codex:** **Sign in with ChatGPT** opens a terminal running `codex login`.
- **Gemini:** **Sign in with Gemini** opens the Gemini CLI's own sign-in, which uses a Google account.

Keys are never written to the state file. Where they are kept is described in [Where keys are kept](#where-keys-are-kept).

## Where keys are kept

These are the keys for the per-token providers (xAI, OpenAI, DeepSeek, Mistral, Google AI and OpenRouter) and the Anthropic API key. Where a key lives depends on how Plenum was started (`lib/keys.mjs`):

- **Desktop app.** Saving a key encrypts it with the operating system through Electron safeStorage (`desktop/keyvault.cjs`): Windows data protection on Windows, the Keychain on macOS, and the secret service (GNOME Keyring or KDE Wallet) on Linux. The encrypted file is written to one file in the app's user-data folder. The server gets the keys from the desktop app and holds them in memory only, while Plenum runs. The desktop app does not read these keys from environment variables. Keys are never logged and never sent back to the browser.
- **Linux without a secret service.** If safeStorage can only use its `basic_text` backend, Plenum keeps keys for this session only, and they are forgotten when Plenum closes. A notice says so. That backend protects keys with a password built into Chromium, so it gives no real protection. Install and unlock GNOME Keyring or KDE Wallet to keep keys between sessions.
- **Plain Node** (`npm start` or `node server.mjs`). There is no desktop app, so keys come only from environment variables: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_AI_API_KEY` and `OPENROUTER_API_KEY`. They cannot be saved from the window. In any mode, `ANTHROPIC_AUTH_TOKEN` is read as a fallback for Claude.

On Windows, older versions saved keys to the Windows user environment. Accounts can copy those keys into the store, but only when you choose to. The copies in the environment are left in place. Remove them in Windows settings (environment variables for your account) if you no longer want them there.

## Edits and approvals

The **Ask first / Auto-approve** switch under the message box sets the approval mode:

- **Ask first** (default): every write, edit and command shows an Approve / Deny card with the exact change or command. Changes to existing files show a diff. Reads inside the project never ask.
- **Auto-approve**: writes and commands run without asking. Use `/approvals ask` to switch back.

A built-in deny list checks every shell command, in both modes. A command it matches shows a card that says it was blocked, with **Deny** as the default button; Approve runs it anyway. The built-in rules cover a recursive delete of a drive root, home folder or project root, `format`, `diskpart`, `reg delete`, `schtasks /create`, `bcdedit`, `shutdown`, `cipher /w`, a download piped into a shell, `git push --force`, and a write to a system folder. Auto-approve does not skip these cards. A project can add its own patterns in **Project settings** (up to 50, each up to 120 characters); a command that matches one is checked the same way.

Denied actions, and actions left unanswered for five minutes, are reported back to Claude, which is told not to retry them.

On a card:

- **Deny with a reason.** Type in the box under the buttons before you press Deny. The reason (up to 300 characters) goes to the model with the denial and shows on the step in the chat. Approve ignores the box.
- **Keys.** Click the card, then **Y** approves and **N** denies. A new card takes focus only when you are not typing somewhere else and no drawer is open, and keys pressed in its first 400 ms are ignored, so a stray keystroke cannot answer it. Y does nothing on a blocked-command card or a checkpoint restore card; click those.
- **Countdown.** The card shows how long is left of its five minutes. When time runs out, the action is denied and the card says so.
- **Show all.** A long diff is cut on the card. **Show all** loads the whole change (up to 2,000,000 characters) before you decide. The full text is held only while the card waits.

## Files outside the project

Claude can work with any file on your computer. Give it a path in your message (for example `C:\Users\name\Documents\notes.txt` on Windows, or `/Users/name/Documents/notes.txt` on macOS), or type `@` followed by the path to attach a file's contents straight away. Paths outside the project folder always show an approval card first, even for reading. In auto-approve mode, reads run without asking and writes still go through the same card rules as before.

Some places are never touched:

- the credential folders in your home folder: `~/.codex`, `~/.config/muse`, `~/.claude`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.gemini`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, and Plenum's own data folder, `~/.muse-console`. The desktop app's own data folder is also kept off limits: `%APPDATA%\Plenum` on Windows, `~/Library/Application Support/Plenum` on macOS, and `~/.config/Plenum` on Linux. On Windows the home folder ones are the same folders under `%USERPROFILE%`;
- the operating system's folders, for writes: `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)` and `C:\ProgramData` on Windows, and `/etc`, `/usr`, `/System` and similar folders on macOS and Linux;
- Plenum's own source (use the Updates panel for that).

Muse Code and Codex work inside the project folder they are given. To work on a file elsewhere with them, add its folder as a project.

## Updates to Plenum

Claude can propose a change to Plenum itself with the `propose_update` tool. The change is queued in the **Updates** panel, which shows each file's status and its new contents. Nothing changes on disk until you click **Apply and restart**. Applying:

1. Runs a syntax check on every JavaScript file in the bundle, and checks that each relative import in a changed file exists, either in the bundle or in the version it replaces.
2. Writes the whole new version as a **generation** under Plenum's state folder, in `overlay/gen-<n>/` (`~/.muse-console/overlay/` on macOS and Linux, `%USERPROFILE%\.muse-console\overlay\` on Windows). A generation holds every file of the version it replaces that the bundle does not change, so it is complete on its own. The install folder is never written.
3. Switches to the new generation with one change to `overlay/manifest.json`, and restarts the server.

The Updates panel lists the generations. **Roll back** goes back to the generation before the active one. **Remove all applied updates** deletes every applied generation and restarts with the shipped files. Plenum keeps the last three generations. If a new generation does not start and become healthy, the next start goes back to the generation before it, and the page shows a notice that says so. A failure before the switch removes the half-made generation and changes nothing.

What can be updated: `server.mjs`, the `.mjs` files in `lib/`, `lib/routes/`, `lib/tools/` and `lib/prompt-parts/`, and the `.html`, `.js` and `.css` files in `public/`. What never can be updated from the app: the update loader (`plenum.mjs`, `lib/overlay.mjs` and `lib/overlay/`), the request token check (`lib/auth.mjs`), the desktop app (`desktop/`), and `package.json`, `README.md` and `start.bat`, which belong to the install. A new release changes those. **Discard** drops a bundle without applying it. Applying is refused while a run is in progress. A new `public/ext-*.js` file is listed as "new panel: loads on every page", because Plenum loads every panel file it finds.

## API model providers

Grok (xAI), OpenAI, DeepSeek, Mistral and Google AI are billed per token, separately from your subscriptions. OpenRouter is too. Its model ids are free text: type `openrouter:<id>` with any id OpenRouter lists, or pick one from the OpenRouter card in Accounts, which keeps the list for ten minutes (`lib/openrouter.mjs`).

Open **Accounts**, find **Model providers (per token)**, and paste the key for a provider. Plenum checks the key with that provider and saves it to the encrypted key store (see [Where keys are kept](#where-keys-are-kept)) only if the check works. In the desktop app the saved key is used. A plain Node run uses the provider's environment variable instead (for example `XAI_API_KEY`). The panel never shows a saved key. Their models appear in the model menus under their own names.

OpenAI, DeepSeek, Mistral and Google AI can use the project tools. Grok and OpenRouter run without tools, because their tool calls are not verified in Plenum (`lib/api-providers.mjs`).

## Council, quick compare and pipelines

- **Council** (`/council <question>`, or the council board above the message box). Two to four seats each take a role, such as Architect, Skeptic or Engineer, and answer. Seats critique each other over one to three rounds (two by default), then a moderator writes the verdict. Seats, roles and effort can be changed on the board. The default council is `DEFAULT_COUNCIL` in `lib/council.mjs`: Claude Opus 5.5 as Architect, Muse Code (Wonder Full) as Skeptic and Codex as Engineer, all at high effort, with Claude Fable 5.1 as moderator at high effort and two rounds.
- **Quick compare** sends one prompt to two to four models at once. Each answer streams into its own column, and **Keep this reply** puts the one you choose into the chat.
- **Pipelines** are saved sequences of one to eight steps. Each step's prompt can use `{input}` (the run's input) and `{previous}` (the reply from the step before). **Keep in chat** puts a result into the chat.

Council seats and the moderator, relay hops, quick-compare seats and pipeline steps can use Claude, Muse Code, Codex, Gemini or an API model. Each CLI seat runs in its read-only setting in these roles (Codex in its read-only sandbox, Gemini in plan mode, Muse Code in an empty scratch folder, Claude with no tools), and no seat, hop or step is given the project's tools.

## Relay

A relay passes a finished reply from one seat to another. Start one with **Relay…** on the council board, or with `/relay`. Auto relay is off by default. When it is on, each hop waits for a countdown (3 seconds by default). A route stops at its hop limit (no limit by default), at the first error (by default), or when you press **Stop** on the relay bar. **Pause** and **Stop** control a running route, and **Relay log** lists the last hops.

## Plan mode and queued follow-ups

The **Plan on / Plan off** button next to Send turns plan mode on or off for the project. It is saved with the project and applies from the next message. In plan mode the chat is read-only: Plenum answers and makes plans, but does not edit files, run commands or use tools, and each model runs in its read-only setting. Builds (`/build`) and checkpoint restores are refused while plan mode is on. `/plan <task>` asks for a plan first, with no file edits.

While a reply is running, Enter queues what you type, up to five messages. Each queued message starts when the run before it ends, Stop included. Each queued message has **Edit** (moves it back into an empty message box) and **Remove**. Esc stops the run.

## Working in the chat

- **Copy, Insert, Edit and Regenerate.** Hover a message to see them. **Copy** copies the Markdown. **Insert** puts a reply in the message box (Append or Replace if the box has text). **Edit** on your own message removes it and everything after it and puts its text back in the box. **Regenerate** replaces the last reply, with the same model or another one you pick.
- **Undo.** `/clear`, `/compact` and Edit keep the chat they replaced. An **Undo** line above the message box puts it back until you send the next message, and it survives a restart. `/clear` on a chat of four or more messages asks first.
- **Cut-off replies.** When an API model stops at its output limit, the reply gets a note and a **Continue** button, which asks it to carry on. The Claude, Codex, Gemini and Muse Code CLIs report no such stop.
- **Lost connection.** If the page cannot reach Plenum's server, a banner says so and clears when the server is back. A failed message gets **Retry** (puts it back in the message box) and **Copy error**.
- **Model menu.** Each model shows whether it is ready (signed in, or a key is set), its price per million tokens, its context window and whether it can use tools. Choosing a model that is not ready shows a banner that says what to do.
- **Command palette.** Typing `/` lists matching commands with a hint for their arguments. Some have a second name: `/stop` runs `/cancel`, `/reset` runs `/clear`, `/switch` runs `/project`, `/forget` runs `/remove`, `/limits` runs `/usage`, and `/keys` and `/login` open Accounts. The Commands panel has a filter box.
- **Narrow windows.** Below 860 px the sidebar folds into a menu button at the top left. The desktop window can be as narrow as 480 px.

## Settings

**Settings** in the sidebar, or `/settings`, opens a drawer with one card per section:

- **Appearance:** the same choice as the **Theme** button (system, dark or light).
- **Desktop:** the four switches described in [Finished alerts and keep-awake](#finished-alerts-and-keep-awake). They take effect in the desktop app only, and the section says so when the page is not running there.
- **Sessions:** the session mode, Transcript or Native, as described in [Session modes](#session-modes).

Each change saves at once, and the line under it says **Saved** or why the change was refused. Panels can add their own sections; see [Extending Plenum](#extending-plenum).

## Side panes

The side pane is the column to the right of the chat. Panels put their tabs into it, such as Artifacts, the Browser, Review and Agents, and only one tab shows at a time. **Back to the chat** hides the column and keeps the tabs. **Close pane** closes the tab that is showing. Drag the pane's left edge to resize it, double-click the edge to reset it, or focus the edge and use the arrow keys. The pane starts at 440 px. It is never narrower than 380 px, and never wider than the smaller of 60% of the window and the window less 480 px, so the chat keeps room. Below 860 px the pane covers the window below the title bar, and **Back to the chat** returns to the chat. The width is kept only for the life of the page.

## Keyboard shortcuts

Press **Ctrl+/** (**Cmd+/** on a Mac) for the full list. The main ones: **Enter** sends (or queues during a run), **Shift+Enter** adds a line, **Esc** closes a list and then stops the run, **/** focuses the message box, **Up** in an empty box recalls your last message, **Ctrl+K** switches project, **Ctrl+Shift+P** turns plan mode on or off, **Ctrl+Shift+C** turns council mode on or off, **Ctrl+Shift+A** opens Accounts, and **Ctrl+Enter** starts a quick compare or a pipeline. Shortcuts with letters do nothing while you type in a text field, except Ctrl+K. Ask first and Auto-approve have no shortcut on purpose.

## Checkpoints

Before a write that Plenum allows, the write and edit tools and the Claude CLI's own writes keep the file's previous contents in the state folder, under `checkpoints/<project id>`. Files over 5 MB are not kept. Open **Checkpoints** to see the list and restore a checkpoint. **Show changes** shows what a restore would change, as a diff from the file as it is now, and **Group by file** lists the changed files in this chat. The restore card shows the same diff. Restores are refused in plan mode. Codex, Gemini and Muse Code write files on their own, and Plenum does not checkpoint those writes.

## Attachments

Attach a file with the attach button, by dropping it on the message box, by pasting it, or by typing `@` and its path. Up to 10 files and 25 MB in total can go with one message.

- **Images** (PNG, JPEG, GIF, WebP; up to 4 per message, 5 MB each) go to Claude (through the CLI or an API key) and Codex. Other models refuse them.
- **PDFs** go only to Claude through an API key (up to 100 pages). Other models refuse them.
- **Text and code** from the attach button, drag and drop, or paste go into the prompt for every model (up to 200 KB a file, 600 KB of text in all). A `@path` file goes into the prompt for the API models only, and only if it is 100 KB or less. Claude through the CLI, Codex, Gemini and Muse Code read a `@path` file with their own tools.

## Tokens and cost

Each reply records the tokens its provider reported. Dollar figures come from `lib/pricing.mjs`, which has per-token prices for the API models, read from the providers' pricing pages on 2026-10-14 (`PRICES.checkedOn`). Check the prices again before relying on a cost figure. A model with no published price shows "price not published", and a reply whose usage was not reported shows "usage not reported". Tokens are never estimated. A subscription CLI (Claude Code, Codex, Gemini CLI, Muse Code) is billed to your plan, so its replies show plan use: tokens only, never a dollar amount. The top bar shows the project's running total, and its tooltip gives the breakdown.

### Spend limits

The spend chip in the project header opens **Spend limit**, where a project can have a warning amount and a cap in dollars for models billed through an API key. The total keeps counting across `/clear`, `/compact`, Edit and Undo, from the date shown, until you press **Reset spend**. Crossing the warning shows one notice. At the cap, messages, `/review` and `/compact` that would bill an API key are refused with a plain message, and the automatic advisor review is skipped with a notice. The Claude, Codex, Gemini and Muse Code CLIs on your plans are never refused. Council, quick compare, pipeline, relay and build runs are not counted, because their cost is not worked out on the server.

## History search and export

The **Chat history** panel searches the current project's chat, case-insensitively, newest first, up to 50 matches. Tick **All projects** to search every project's chat; each match names its project, and clicking it switches there and outlines the message. The panel also exports the chat as a Markdown file. Search and export read the chat and change nothing. Each project keeps its last 300 messages.

## Saved prompts

A saved prompt is a named template for one project. Its name is up to 32 lowercase letters, digits or hyphens, and it cannot be the name of a built-in command. Its text is up to 4,000 characters. `$ARGUMENTS` in the text is replaced by whatever you type after the name. Type `/name` in the message box to send it. Saved prompts are kept in `prompts.json` in the Plenum state folder.

**Export** saves a project's prompts as a JSON file, and **Import** adds the prompts from such a file; a prompt with the same name is replaced. Pipelines export and import the same way in their panel. Every entry is checked before anything is saved, and a file with one bad entry is refused with the entry's number. Importing never runs anything.

## AGENTS.md project rules

If the project folder has an `AGENTS.md`, Plenum adds its text to the instructions for each chat message, so an edit shows on the next message. Plenum says in the chat when it uses one. The file is treated as the project owner's instructions, but it cannot approve an action, widen the project folder or turn a tool on.

## Finished alerts and keep-awake

In the desktop app, Plenum shows a "Plenum finished" notification when a run in the active project ends while the window is not focused. Clicking it brings the window back. While a run is in progress, Plenum keeps the PC from suspending. When an approval card is waiting and the window is not focused, Plenum shows "Plenum needs your approval" with the project's name; clicking it brings the window back. The tray icon's tooltip and menu show how many approvals are waiting. The four switches are under **Settings** in the sidebar, in the **Desktop** section: **Finished alerts**, **Approval alerts**, **Keep awake** and **Keep in tray on close**. They are also kept in the state file as `finishedAlerts`, `approvalAlerts`, `keepAwake` and `trayOnClose`, and a change made in the window applies at once, with no restart. Finished alerts, approval alerts and keep awake are on by default. Keep in tray on close is off by default. None of them runs under `npm start`.

## Project settings and tools

Each project folder can have its own model, effort, approvals, relay settings, plan mode, deny patterns and tool options. Open **Project settings** with the gear beside the project name. Each setting follows the app default until you change it, and **Use app default** goes back to it. The **Tools** section covers Claude Code, Codex, Gemini and Muse Code. For example, it sets Claude Code's permission mode and tool lists, Codex's sandbox (read only, or project folder only), and Muse Code's approval mode and sandbox network. Council seats and the moderator are not given the project's tools; a CLI seat runs in its own read-only setting.

Under the deny patterns, **Test a command** says whether a built-in rule or one of the project's patterns would block a command you type. It only checks; nothing runs.

**Browse…** in the add-project form opens the system's folder chooser in the desktop app. Under `npm start` it says to paste the path instead.

For a project in a git repository, the header shows the branch, how far it is ahead or behind, and how many files are changed or untracked. Click it for the list of files. It refreshes every 30 seconds and after each run, and it runs one fixed, read-only `git status` command, with git's `core.fsmonitor` program turned off (see `DECISIONS.md`, item 18).

## Session modes

Each council seat shows **Sessions: Native** or **Sessions: Transcript**. Transcript, the default, sends the chat again with each message. Native resumes the session that Claude or Codex keeps for the chat. Other providers, and Muse Code, always send the transcript. The mode is saved as `sessionMode` in the app's state file.

## Portable and tray mode

On Windows, `npm run dist:portable` builds one portable `.exe` in `release/` that runs without an installer. To keep the window in the tray, turn on **Keep in tray on close** under **Settings** › **Desktop** (or set `"trayOnClose": true` in the state file: `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux). Closing the window then hides Plenum to the tray and the server keeps running. Click the tray icon to show the window again, or choose **Quit** from the tray menu to stop everything.

## Commands

| Command | What it does |
|---|---|
| `/add <folder>` | Add a project folder (absolute path) |
| `/project [name]` | Show or switch projects |
| `/remove <name>` | Forget a project (files are kept) |
| `/model [name]` | Show or set the main model: `opus`, `sonnet`, `haiku`, `fable`, `wonder`, `wonder-full`, `muse`, `codex`, `gemini`, `grok`, `gpt`, `deepseek`, `mistral`, `google-ai`, `echo`, or a full id such as `openrouter:<id>` |
| `/models` | List models and aliases |
| `/advisor [name\|off\|auto]` | Set the advisor (default opus). `auto` reviews every reply |
| `/review` | Advisor reviews the last answer plus the working-tree diff |
| `/council <question>`, `/council off` | Ask every council seat, then a moderator sums up. `off` returns to Chat |
| `/build` | Turn the last council recommendation into tasks, then run them |
| `/relay` | Pass a finished reply from one seat to another, once or as a route |
| `/approvals [ask\|auto]` | Show or set the approval mode |
| `/effort [low\|medium\|high\|xhigh\|max]` | Show or set how hard the main model thinks. The **Effort** menu under the message box does the same. Claude, Muse Code and Codex all take it |
| `/theme [system\|dark\|light]` | Follow the system, or always use the dark or light look |
| `/updates` | Show or hide the Updates panel |
| `/settings` | Open Settings: Appearance, the Desktop switches and Sessions |
| `/ask <model> <message>` | Send one message to a model without switching |
| `/plan <task>` | Ask for a plan only, with no file edits |
| `/usage` | Show your limits: Muse Code's 5-hour and weekly use, Codex's weekly use and credits, and the Claude key's per-minute rate limits. Reading Muse Code or Claude can send one very small request |
| `/compact` | Have the main model summarise this project's chat, then replace the chat with that summary |
| `/clear`, `/reset` | Clear this project's transcript. A chat of four or more messages asks first, and Undo can bring it back |
| `/cancel`, `/stop` | Stop the running request (Esc also works) |
| `/status`, `/login` | Provider status, and how to sign in |

`@path/to/file` attaches a file (see [Attachments](#attachments)).

## Known limits

- Through the Claude CLI, Plenum sees only the requests the CLI asks permission for. Reads and harmless commands that the CLI allows on its own produce no card. Everything else asks first unless auto-approve is on. Credential folders and Plenum's own source stay off limits either way.
- `run_command` runs with your user rights, in the project folder, with a 120 second default timeout (900 maximum). It uses cmd.exe on Windows and `/bin/sh -c` on macOS and Linux. Output is capped.
- Muse Code's approval and sandbox settings come from its tool options in project settings, not from the Ask first / Auto-approve switch. The default is on-request approval. Muse's own approval prompts cannot be answered from this window; verify how a headless run behaves after you sign in.
- Checkpoints and the deny list cover the write and edit tools, `run_command` and the Claude CLI. They do not cover writes that Codex, Gemini or Muse Code make on their own. Those three also still read the project as advisor, planner or reviewer.
- Muse Code runs one-shot per message, with the chat resent. Codex resumes its own session only in Native session mode. Neither shares its session memory with Claude's history.
- Prompts for the CLIs go in a file or on stdin, so long histories fit.
- Plenum keeps projects and chat history in `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux (override with `MUSE_CONSOLE_HOME`). It does not write API keys to that file. Where keys are kept is described in [Where keys are kept](#where-keys-are-kept). Before each save, the previous file is copied to `state.json.bak`. If `state.json` cannot be read as JSON at start, it is renamed to `state.json.corrupt-<time>` (never deleted), the backup is loaded, and a banner says what happened. If it cannot be opened at all (another program holding it), Plenum tries three more times, then loads the backup and leaves the file alone; before the next save replaces it, it is copied to `state.json.unread-<time>`.
- The server binds to 127.0.0.1 only. Every request to `/api/` must carry the per-launch token (the desktop app passes it to its window; a plain node run prints a link that carries it) and POSTs must come from the same origin.
- `MUSE_CONSOLE_NO_FALLBACK=1` turns off the server-side refusal fallback that the Claude Opus, Sonnet and Fable models request by default.
- macOS and Linux have not been run. They were only tested with the platform forced. Every build is unsigned until certificates are added, including the Windows installer and portable exe built here (Windows SmartScreen warns on first run), and the Linux builds are never signed.
- The desktop app itself (the Electron window, the OS-encrypted key store, and the utility process that runs the server) has been tested only against stand-ins, not by launching the app. That includes the approval alert, the tray count, the folder chooser behind **Browse…** and the 480 px minimum width.
- Cut-off replies (**Continue**) and the spend cap's refusal were checked against mock providers, not live API models. Approval cards from a live model, with their keys, reason box and **Show all**, were checked with cards made by a checkpoint restore and with page tests.
- The deb maintainer (`build.deb.maintainer` in `package.json`) is a placeholder, `[LICENSOR NAME] <[CONTACT EMAIL]>`, and must be replaced before release. The author name and email in `package.json` are placeholders too, and they set the Windows company name.
- In their read-only settings, Codex, Gemini and Muse Code can still read files on the machine and run commands that only read, so do not paste untrusted text into a council, relay, compare or pipeline run that includes them.

## Tests

The test scripts live outside this folder. They cover the security gate, projects and settings, streaming, file mentions, the Claude request shape and tool loop against a mock endpoint, path containment, approvals, the update outbox (including apply with backup), and the Muse and Codex process handling.

## Extending Plenum

For builders. A feature is a file in the folder that Plenum reads for it, so it needs no edit to a central list. Each shape below is the one the code checks when it loads the file. Applied updates can add files to these folders too (see [Updates to Plenum](#updates-to-plenum)).

**Route modules** are `lib/routes/*.mjs`. Each exports `routes`. The server checks the token before a handler runs, and the handler answers the response itself. A handler receives `{ req, res, url, json, readBody, httpError, store, events, ... }`, and `events` is `lib/events.mjs`.

```js
export const routes = [
  { method: 'GET', path: '/api/example', handler: ({ res, json }) => json(res, 200, { ok: true }) },
];
```

**Model tools** are `lib/tools/NN-name.mjs`. Each exports `tools`, a list of entries with `name`, `description`, `input_schema` and `run(input, ctx, stamp)`, which returns `{ ok, summary, output, denied? }`. Optional fields: `plan`, `describe`, `command`, `stamped`, `scoped`, `refusal` and `when(ctx)`. A raw entry `{ raw, when }` is sent to the model exactly as given. `lib/tools.mjs` applies the approval, scope and deny-list rules, not the tool file.

```js
export const tools = [
  { name: 'example_tool', description: 'What it does.', input_schema: { type: 'object', properties: {} },
    run: async (input, ctx) => ({ ok: true, summary: 'Done', output: 'Text for the model.' }) },
];
```

**Prompt parts** are `lib/prompt-parts/NN-name.mjs`. Each exports `parts`, a list of `{ id, order, contexts, text }`. `contexts` is `'*'` or a list of names from `CONTEXTS` in `lib/prompt.mjs`. `text(ctx)` returns a string, or `null` for none. A part adds text only.

```js
export const parts = [
  { id: 'example', order: 60, contexts: ['chat'], text: async ctx => `Project folder: ${ctx.root}.` },
];
```

**Desktop handlers** are `desktop/handlers/name.cjs`. Each exports `{ name, messages, hooks }`. `messages[type](message, shell)` answers a message from the server: a reply with a `type` is sent as it is, and any other object is sent as `${type}-result` with the message's `id`. The hooks are `ready`, `windowCreated`, `serverStarted`, `serverExited`, `state` and `beforeQuit`. Server code reaches the shell through `lib/shell.mjs`: `shellRequest(type, payload, { timeoutMs })`, `onShellMessage(type, fn)` and `shellPost(message)`.

```js
module.exports = {
  name: 'example',
  messages: { 'example-ask': async (message, shell) => ({ answer: true }) },
  hooks: { state(shell, st) {} },
};
```

**Side panes** register in a `public/ext-*.js` file. `id` is 1 to 32 lower-case letters, digits or hyphens. `render(body, api)` draws into `body`, and `api` has `params`, `close()`, `setTitle()`, `badge(n)` and `isActive()`.

```js
MuseUI.pane.register({ id: 'example', title: 'Example', icon: 'chart', order: 50,
  render(body, api) {}, onShow() {}, onHide() {}, onClose() {} });
MuseUI.pane.open('example', { /* params for api.params */ });
```

`MuseUI.pane` also has `close(id)`, `toggle(id)`, `select(id)`, `show()`, `hide()`, `active()`, `isOpen(id)`, `list()` and `width(px)`.

**Settings sections** register with `MuseUI.settings.register`. Scope `'app'` puts the section in the Settings drawer, and `'project'` in the project settings drawer. `render(body, ctx)` gets `ctx.state`, `ctx.update(body)` (which saves a change), `ctx.refresh()` and `ctx.toast(message, kind)`.

```js
MuseUI.settings.register({ id: 'example', scope: 'app', title: 'Example', order: 40,
  render(body, ctx) {} });
```

**Notices and risk prompts** are `MuseUI.notice(id, { before, after })` and `await MuseUI.risk(id, { action })`, which resolves to true or false. Until a notices panel assigns the real ones, the stubs in `public/app.js` are used: `notice` draws nothing and `risk` resolves to true.

**Events** come from `GET /api/events`, one server-sent stream per window. Its types are `hello`, `state`, `run`, `approval`, `notice` and `agent`, and each has `type` and `at`. A route module publishes with `events.publish({ type, ... })`, `events.publishState(reason)` for the state, or `events.tag(runId, project, kind)` for a run's events. In the page:

```js
MuseUI.events.on('run', ev => {});                  // also off(type, fn) and the connected flag
window.addEventListener('plenum:event', e => {});   // every event, as e.detail
window.addEventListener('plenum:connection', e => {}); // e.detail.connected
```

**Page requests** always carry the token. `MuseUI.api(path, body)` returns the parsed JSON, sending a POST when a body is given, and throws the server's error message on failure. `MuseUI.request(path, { method, body, signal, headers })` returns the `Response`. `MuseUI.headers(extra)` returns the headers with `x-plenum-token`, for a request made any other way.

```js
const data = await MuseUI.api('/api/example', { name: 'x' });
const res = await MuseUI.request('/api/example', { method: 'GET' });
```
