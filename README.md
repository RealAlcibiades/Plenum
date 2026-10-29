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

Pushing a version tag (`v*`) runs `.github/workflows/release.yml`. It builds Windows on `windows-latest` (`npm run dist`), macOS arm64 on `macos-latest` (`npm run dist:mac:arm64`), macOS x64 on `macos-15-intel` (`npm run dist:mac:x64`), and Linux x64 on `ubuntu-latest` (`npm run dist:linux`). Each build is uploaded as a workflow artifact, and the build's installers and update files are attached to a draft release on this repository (see [New versions](#new-versions)). The workflow's own token makes the draft, so no secret is needed for that. A draft is invisible to installed apps until you publish it.

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

## Legal

The first time Plenum opens, and again when its terms change, it shows the License Agreement and asks you to agree before it can reach any provider. You tick the box and press **I agree**; the terms are on the same screen, and the version you accepted is recorded on this computer. **Settings › Legal** (or `/legal`) shows the agreement you accepted, the Privacy Notice, the third-party services notice, the open-source licences and the safety notices. Each safety notice appears once where its risk starts. It has **Don't show again**, and **Settings › Safety** can show it again. A notice never turns off a safety check: approval cards, blocked commands and folders, and plan mode work the same whatever you choose. Plenum sends no telemetry and has no server.

The Windows installer's own licence page covers only that installer. The portable exe, the zip, the macOS and Linux builds and `npm start` have no licence page, so the in-app step is the one every user passes. `LICENSE.txt` in the app folder is the licence of the source. The placeholders in the legal texts (`[LICENSOR NAME]`, `[CONTACT EMAIL]`, `[GOVERNING LAW]`) stay until the owner fills them in.

## Accounts

Open **Accounts** in the sidebar (or click any status item at the bottom of the window):

- **Claude:** Claude runs through the Claude CLI (`claude`), signed in with your Claude account, so it uses your Claude plan rather than an API key. **Sign in to Claude Code** opens a terminal running `claude auth login`; finish in your browser, then press **Refresh**. Plenum looks for the Claude, Codex and Gemini CLIs on PATH first, then in its own tools folder. Install or update them with `npm install --prefix "%USERPROFILE%\.muse-console\tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on Windows, or `npm install --prefix "$HOME/.muse-console/tools" @anthropic-ai/claude-code @openai/codex @google/gemini-cli` on macOS and Linux. You sign in once. The CLI keeps the sign-in, not Plenum. If the CLI is not installed, the card asks for an Anthropic API key instead and Claude uses the API.
- **Muse Code:** **Sign in to Muse Code** opens a terminal running `muse login`. Approve the code in your browser, then press **Refresh**. `META_API_KEY`, if set on the computer, is passed to Muse Code. Muse Code is installed with its own installer; Plenum gives no install command for it.
- **Codex:** **Sign in to Codex** opens a terminal running `codex login`.
- **Gemini:** **Sign in to Gemini CLI** opens the Gemini CLI's own sign-in, which uses a Google account.
- **Grok Build:** **Sign in to Grok Build** opens a terminal running `grok login` (SuperGrok or X Premium Plus). Install it with `irm https://x.ai/cli/install.ps1 | iex` (Windows PowerShell) or `curl -fsSL https://x.ai/cli/install.sh | bash` (macOS, Linux). In Ask first, Grok Build asks Plenum before it edits or runs a command, and it joins every multi-model role. Plenum cannot see whether it is signed in until it runs.

The buttons read "Sign in to" followed by the product's name, never "Sign in with", so no button copies a provider's own sign-in label. Product names appear in plain text only, with no logos.

Keys are never written to the state file. Where they are kept is described in [Where keys are kept](#where-keys-are-kept).

## Where keys are kept

These are the keys for the per-token providers (xAI, OpenAI, DeepSeek, Mistral, Google AI and OpenRouter) and the Anthropic API key. Where a key lives depends on how Plenum was started (`lib/keys.mjs`):

- **Desktop app.** Saving a key encrypts it with the operating system through Electron safeStorage (`desktop/keyvault.cjs`): Windows data protection on Windows, the Keychain on macOS, and the secret service (GNOME Keyring or KDE Wallet) on Linux. The encrypted file is written to one file in the app's user-data folder. The server gets the keys from the desktop app and holds them in memory only, while Plenum runs. The desktop app does not read these keys from environment variables. Keys are never logged and never sent back to the browser.
- **Linux without a secret service.** If safeStorage can only use its `basic_text` backend, Plenum keeps keys for this session only, and they are forgotten when Plenum closes. A notice says so. That backend protects keys with a password built into Chromium, so it gives no real protection. Install and unlock GNOME Keyring or KDE Wallet to keep keys between sessions.
- **Plain Node** (`npm start` or `node server.mjs`). There is no desktop app, so keys come only from environment variables: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_AI_API_KEY` and `OPENROUTER_API_KEY`. They cannot be saved from the window. In any mode, `ANTHROPIC_AUTH_TOKEN` is read as a fallback for Claude.

On Windows, older versions saved keys to the Windows user environment. Accounts can copy those keys into the store, but only when you choose to. The copies in the environment are left in place. Remove them in Windows settings (environment variables for your account) if you no longer want them there.

## Edits and approvals

The **Mode** menu under the message box sets the approval mode for the active project. Its button shows what sending will allow, in the mode's colour: Plan, Ask first, Auto-approve or Approve all, with "· Focus" added when build focus is on. The menu also holds the **Plan** and **Build focus** checkboxes and **Safety settings…**. The app-wide default is in **Settings › Safety**; each project keeps its own unless you choose **Use app default**.

- **Ask first** (default): every edit and command waits for you. Each write, edit and command shows an Approve / Deny card with the exact change or command. Changes to existing files show a diff. Reads inside the project never ask.
- **Auto-approve**: edits and commands run without asking; guards still ask. A command that a built-in rule or a project pattern blocks, and a write outside the project folder, still show a card. Auto-approve has no card for ordinary edits and commands. `/approvals ask` switches back.
- **Approve all**: every approval card is answered for you, in the project and outside it, including the cards that Gemini and Muse Code show for themselves. Gemini runs in its yolo mode and Muse Code with its own approval prompts off, so both can run commands headlessly. Codex and Claude Code get no new flags: Codex already runs in its project-folder sandbox without asking, and Plenum keeps answering Claude Code's permission prompts itself. Approve all also answers the computer-use and browser cards, so sending, buying, deleting, signing in and new apps or sites go ahead without asking. Two project switches in **Project settings** turn that off: **Approve all also answers computer-use cards** and **Approve all also answers browser cards**.

Credential folders, system folders, Plenum's own source and Plenum's own data stay off limits in every mode. In every mode the model never types into a password, one-time-code, 2FA or CVV field; you type those yourself. Stop, and Ctrl+Alt+Esc, end a computer or browser run at once.

A built-in deny list checks every shell command, in every mode. A command it matches shows a card that says it was blocked, with **Deny** as the default button; Approve runs it anyway. The built-in rules cover a recursive delete of a drive root, home folder or project root, `format`, `diskpart`, `reg delete`, `schtasks /create`, `bcdedit`, `shutdown`, `cipher /w`, a download piped into a shell, `git push --force`, and a write to a system folder. In Approve all these cards look the same, unless the project turns on **Approve all also answers blocked-command cards** (off by default). With that switch on, Approve all runs the commands that the rules block, including the ones that can wipe a drive or the system, and nothing stops them but you. A project can add its own patterns in **Project settings** (up to 50, each up to 120 characters); a command that matches one is checked the same way.

Turning Approve all on asks you to confirm. The confirmation has a **Don't show again** box like every other notice; with it ticked, turning Approve all on takes one click, and the red button, the line above the message box and a line in the chat remind you that it is on. It is saved like the other modes and survives a restart. When Approve all answers a card for you, the chat shows a line saying so instead of the card.

Denied actions, and actions left unanswered for five minutes, are reported back to Claude, which is told not to retry them.

On a card:

- **Deny with a reason.** Type in the box under the buttons before you press Deny. The reason (up to 300 characters) goes to the model with the denial and shows on the step in the chat. Approve ignores the box.
- **Keys.** Click the card, then **Y** approves and **N** denies. A new card takes focus only when you are not typing somewhere else and no drawer is open, and keys pressed in its first 400 ms are ignored, so a stray keystroke cannot answer it. Y does nothing on a blocked-command card or a checkpoint restore card; click those.
- **Countdown.** The card shows how long is left of its five minutes. When time runs out, the action is denied and the card says so.
- **Show all.** A long diff is cut on the card. **Show all** loads the whole change (up to 2,000,000 characters) before you decide. The full text is held only while the card waits.

## Files outside the project

Claude can work with any file on your computer. Give it a path in your message (for example `C:\Users\name\Documents\notes.txt` on Windows, or `/Users/name/Documents/notes.txt` on macOS), or type `@` followed by the path to attach a file's contents straight away. A write to a path outside the project folder shows an approval card first. In auto-approve mode that card still shows; in Approve all it is answered for you. Credential and system folders are refused in every mode.

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

Applied changes are tied to the Plenum version they were applied under. After Plenum updates to a new version, they are set aside so the shipped files run, and the Updates panel says so (see [New versions](#new-versions)).

## New versions

The desktop app checks for a new version 20 seconds after it starts and every four hours after that, unless **Check for new versions** is off in **Settings › Updates**. The check asks the Plenum release repository on GitHub (`https://github.com/RealAlcibiades/Plenum`) for the newest published release. It carries your Plenum version, operating system and architecture, your IP address, and a random rollout ID that Plenum keeps in its user-data folder. Apart from the download of an update itself, nothing else leaves your computer for this, and nothing about you goes to Plenum's developer: GitHub shows the developer only how many times each file was downloaded.

What happens when a new version is found depends on the build:

| Build | What happens |
|---|---|
| Windows installer (`Plenum Setup x.y.z.exe`) | Downloads the new version in the background. **Restart to update** installs it, or it installs when you quit Plenum. |
| Windows portable `.exe` and zip | Shows "Plenum x.y.z is available" and **Get x.y.z**, which opens the release page. Replace the file or folder yourself. |
| macOS dmg and zip | Installs itself only when the build is signed. Until then it shows the notice and **Get x.y.z**. |
| Linux AppImage | Downloads in the background. **Restart to update** replaces the AppImage file, or it is replaced when you quit Plenum. |
| Linux deb | Shows the notice and **Get x.y.z**. |

**Restart to update** never restarts while a run is in progress or an approval card is waiting. Plenum says why, and you restart when the run has ended. If the message box holds text you have not sent, Plenum asks once before it restarts. The new version's release notes are in **Settings › Updates** before you restart, and after the update under **What changed in x.y.z**.

**Channels.** Stable (the default) gets numbered releases. Beta also gets pre-release versions (`x.y.z-beta.n`) as soon as they are published. Switching from Beta back to Stable keeps the beta you have until a newer stable release ships.

**If a new version does not start.** The first start after an update is watched. If Plenum does not come up, it shows "Plenum x.y.z did not start" with the log path. On Windows, when the previous installer is still in Plenum's user-data folder (`%APPDATA%\Plenum\updates`), the dialog offers **Reinstall x.y.z** for the version before; otherwise it offers **Get x.y.z**, which opens that release's page. Plenum then does not offer that version again; the next newer version is offered as usual. Changes applied from the Updates panel are made for one version: after Plenum updates, they are set aside so the shipped files run, and the Updates panel says so.

**Turning it off.** Switch off **Check for new versions**. Plenum then makes no update request at all and installs nothing by itself. That includes the install at quit, even of an update it had already downloaded. New versions are listed on the release repository.

**Until the builds are signed**, a Windows update is checked against the sha512 in the release feed but not against a publisher certificate, so the release repository's GitHub account is what you trust.

### Publishing a release

1. Raise `version` in `package.json` and push a tag: `git tag -a v0.6.0 -m "What changed" && git push origin v0.6.0`. Betas use a tag such as `v0.6.0-beta.1`. The tag message seeds the notes.
2. The workflow creates a draft release on the release repository, builds every platform and attaches the installers, the `latest*.yml` and `beta*.yml` files and the blockmaps.
3. Review the draft, write the notes, and publish it. The notes are what the app shows under **What changed in x.y.z**, as plain text: short lines or a bullet list read best, and links and images are dropped. A draft is invisible to the app.
4. Stage the rollout: `node scripts/stage-release.mjs v0.6.0 10`, then `50` or `100` to widen it.
5. To pull a bad release, publish a higher version. Publishing the same version number again leaves the people who took it on it.
6. Keep `electron-updater` current, because it verifies the downloads.

## API model providers

Grok (xAI), OpenAI, DeepSeek, Mistral and Google AI are billed per token, separately from your subscriptions. OpenRouter is too. Its model ids are free text: type `openrouter:<id>` with any id OpenRouter lists, or pick one from the OpenRouter card in Accounts, which keeps the list for ten minutes (`lib/openrouter.mjs`).

Open **Accounts**, find **Model providers (per token)**, and paste the key for a provider. Plenum checks the key with that provider and saves it to the encrypted key store (see [Where keys are kept](#where-keys-are-kept)) only if the check works. In the desktop app the saved key is used. A plain Node run uses the provider's environment variable instead (for example `XAI_API_KEY`). The panel never shows a saved key. Their models appear in the model menus under their own names.

### Tools for API models

OpenAI, DeepSeek, Mistral and Google AI can use the project tools. Grok by API key answers in text only until you press **Check tool calls** on the xAI card in **Accounts**. That sends one tiny request with your key, which xAI bills like any other request; if xAI completes the tool call, Grok gets the project tools (and the browser tools, when the pane's switch is on) like OpenAI. OpenRouter models answer in text only until a model passes Plenum's tool test: open **Accounts**, find **Tools for API models**, and press **Test tools** next to the model. The test runs Plenum's own file tools (list, read, write and edit, nothing else) in a temporary folder that is deleted afterwards, never your project. It checks an exact edit, an exact new file, and that a path in a credential folder is refused and not tried again. It sends about 15,000 tokens through that model's key; this is not counted in any project's spend. A model that passes shows **Passed on <date>**. Turn on **Allow tools** to give it the project tools; Ask first, the deny list, plan mode and the off-limits folders apply as for any model, and it can then be picked as a /build coder. The result belongs to that exact model id: if the provider later answers under a different model name, tools turn off for it and the row says **Out of date** until it is tested again. Results are kept in the state file with their date; no key or file content is kept.

## API finder

**API finder** (Settings › API finder, or the link in Accounts) compares what model routers and providers charge for the same model. Each model shows its lowest price per million input and output tokens, its context window, whether it takes tools or images, and which source is cheapest for a typical chat (three input tokens for each output token, before fees). Expand a model to see every source side by side, with its fee note and a link to its page; for an OpenRouter model you can also see the providers OpenRouter routes to. Search and filter by name, provider, price, context, tools, vision, or "Works in Plenum". **Use in Plenum** sets an OpenRouter model as your model (`openrouter:<id>`, text only, without project tools), **Try once with /ask** sends just the next message to it, and a model Plenum supports directly offers **Use … direct**, or **Open Accounts** to add its key. Prices come from four public lists read without a key (OpenRouter, Vercel AI Gateway, DeepInfra and Martian), read only while the finder is open and each kept for ten minutes; **Refresh** reads them again at most once a minute. Direct prices come from `lib/pricing.mjs` (checked 2026-10-14) and are marked as table prices wherever they appear. The **Routers** tab lists every router with its fees, base URL and links; routers without a public price list come from a table checked by hand on 2026-10-20 (`lib/router-directory.mjs`), so check their pages before relying on it. Links open in your browser. A model that two routers name differently appears as two rows.

The API finder earns Plenum no commission, and it stores no prices on disk.

## Council, quick compare and pipelines

- **Council** (`/council <question>`, or the council board above the message box). Two to four seats each take a role, such as Architect, Skeptic or Engineer, and answer. Seats critique each other over one to three rounds (two by default), then a moderator writes the verdict. Seats, roles and effort can be changed on the board. The default council is `DEFAULT_COUNCIL` in `lib/council.mjs`: Claude Opus 5.5 as Architect, Muse Code (Wonder Full) as Skeptic and Codex as Engineer, all at high effort, with Claude Fable 5.1 as moderator at high effort and two rounds. Every seat is told who the other seats are and what each role covers, which round it is and who reads its reply, so a seat goes deep on its own role and leaves the others theirs; the moderator knows that a seat's silence outside its role is not agreement.
- **Quick compare** sends one prompt to two to four models at once. Each answer streams into its own column, and **Keep this reply** puts the one you choose into the chat. Each model is told that it is one of several answering independently and that none sees another's reply, so it gives a complete answer on its own.
- **Pipelines** are saved sequences of one to eight steps. Each step's prompt can use `{input}` (the run's input) and `{previous}` (the reply from the step before). **Keep in chat** puts a result into the chat. Every step is told its place in the pipeline, what each step does, who reads its reply and what that step needs; it always sees the original message and the previous reply (quoted between BEGIN and END as material, not instructions), even when the template leaves `{input}` or `{previous}` out.

Council seats and the moderator, relay hops, quick-compare seats and pipeline steps can use Claude, Muse Code, Codex, Gemini or an API model. Each CLI seat runs in its read-only setting in these roles (Codex in its read-only sandbox, Gemini in plan mode, Muse Code in an empty scratch folder, Claude with no tools), and no seat, hop or step is given the project's tools, unless you allow it in Agents > Limits: a seat, the moderator, a hop, a column or a step can then start read-only agents (Researcher, for example) that read the project and report back, within the numbers you set; the seat itself stays text-only, and Codex, Gemini and Muse Code seats cannot start agents.

## Relay

A relay passes a finished reply from one seat to another. Start one with **Relay…** on the council board, or with `/relay`. Auto relay is off by default. When it is on, each hop waits for a countdown (3 seconds by default). A route stops at its hop limit (no limit by default), at the first error (by default), or when you press **Stop** on the relay bar. **Pause** and **Stop** control a running route, and **Relay log** lists the last hops. Each hop is told that it is one of several models working for one person, the order of the relay and its own place in it, who reads its reply next, and the person's original request; it builds on the reply it receives, names any claim it rejects, and starts with one line saying what it kept, changed or added.

## Plan mode and queued follow-ups

The **Plan** checkbox in the **Mode** menu, or Ctrl+Shift+P, turns plan mode on or off for the project. It is saved with the project and applies from the next message. In plan mode the chat is read-only: Plenum answers and makes plans, but does not edit files, run commands or use tools, and each model runs in its read-only setting. Builds (`/build`) are refused while plan mode is on. A checkpoint restore, a rules save or an artifact save that you click is your own change, so plan mode allows it with the same checkpoint and confirmation it has outside plan mode. `/plan <task>` asks for a plan first, with no file edits.

## Threads

A project can have several chats at once, called threads, shown as tabs above the chat. The first is **Main**, which is the project's chat from before. **+ Thread** (or **Ctrl+T** in the desktop app) starts a new one with its own name, model, chat, queue, plan mode and CLI sessions; up to 8 can be open per project. Threads run at the same time: a reply in one does not block another, and each tab shows whether it is running, waiting for your approval, or has a reply you have not read. Only one thread at a time may change files in the project folder, the **writer** (Main by default); the others are read-only until you choose **Make this thread the writer**, or until they get an isolated copy (see [Isolated copies](#isolated-copies-git-worktrees)). Builds, checkpoint restores and rewinds wait until every thread of the project is idle. **Close thread** keeps its chat under **Closed threads** in the New thread panel, where it can be reopened or removed; up to 20 closed threads are kept.

The switch **Several threads may write in this folder**, in the New thread panel under **This project**, is off by default. On, every thread writes in the project folder, the read-only rule and the writer go away for that project, and each turn keeps a snapshot for Rewind. Its notice says: "Two agents editing one folder can overwrite each other's uncommitted work. Use an isolated copy for the second thread, or commit first." Builds and restores still wait until every thread is idle.

The first start of this version copies the state file to `state.json.pre-threads-<date>` before adding threads. Main keeps the project's chat where earlier versions read it, so an earlier version opened on the same state file still shows Main's chat (the other threads are kept but not shown).

**Split view** shows two threads of the project side by side. Ctrl-click a thread's tab (Cmd-click on a Mac), choose **Open beside** in its **…** menu (or right-click the tab), or press **Ctrl+Shift+\\**. The left pane is the thread you chose last, with the full message box (model, effort, Mode, Council, attachments and / commands). The right pane has its own message box with Send and Stop, its own queue and its own approval cards. Runs stream in both at once, and Stop and Esc stop only the thread of their pane. **Swap sides** puts the right thread on the left; the **×** in a pane's head closes that pane and keeps the thread as a tab. Drag the line between the panes, or use the arrow keys on it, to change the widths. Under 1100 px, or while the side pane is open, one pane shows at a time, with a **Show …** button in its head; while a model drives the computer or the browser, that is the left pane, which holds the drive bar. In the desktop app, **Ctrl+1** and **Ctrl+2** go to the left and the right message box, and F6 reaches both panes. Plenum remembers each project's right thread and the widths in this window. In the desktop app, Ctrl+Tab and Ctrl+Shift+Tab go to the next and the previous thread on the left.

## Isolated copies (git worktrees)

In a git repository, the New thread panel offers **Work in an isolated copy (git worktree)**. The thread then works on its own branch, `plenum/<name>-<code>`, in a folder outside the project (`%LOCALAPPDATA%\PlenumWT` on Windows, `~/.plenum-wt` on macOS and Linux), so several threads can change the same repository without overwriting each other, and a OneDrive project is not synced while an agent writes. Every agent in that thread, Claude Code, Codex, Gemini CLI, Muse Code and the API models, works only in its copy. **Copy settings** can name a setup command such as `npm ci` (run through the deny list with a time limit) and untracked files such as `.env` to copy in; credential folders are never copied. The thread's header row above the chat shows the branch and how many files changed, with **Review diff**, **Keep branch** (commits the changes to the branch and removes the folder) and **Discard** (removes the folder; the branch is kept unless you tick **Also delete the branch**). **Merge into <base>** shows the whole diff on an approval card and merges without forcing; if files conflict, Plenum lists them, stops the merge and changes nothing. Plenum runs git with the repository's hooks and fsmonitor turned off. In a folder that is not a git repository, threads share the folder and one of them is the writer.

## Build focus

Build focus is a per-project setting: the **Build focus** checkbox in the **Mode** menu, or `/focus [on|off]`, turns it on or off, and `/focus` by itself switches it. It is saved with the project and applies from the next message. With it on, every model in the project (Claude, Muse Code, Codex, Gemini and the API models) is told to get the code working and run only the checks that are strictly needed: one test file or one test name instead of the whole suite, no linters, type checks or production builds unless you ask for them in your message, no new tests or refactors you did not ask for, and a short line at the end naming the checks it skipped so you can run them. In a build, the planner adds no test-only tasks, the coders get the same instruction, and the reviewer still runs once but does not fail a build for missing tests. The build card and the plan show a **Build focus** pill while it is on; a build card that is redrawn from the chat after a reload does not show the pill.

It is an instruction, not a block: a model that decides a check is the only way to verify a change may still run it, and Ask first still shows the command on a card. Plan mode wins when both are on.

While a reply is running, Enter queues what you type, up to five messages. Each queued message starts when the run before it ends, Stop included. Each queued message has **Edit** (moves it back into an empty message box) and **Remove**. Esc stops the run.

## Model-driven runs: pause and stop

When a model drives the screen or the in-app browser, a bar sits above the message box and a pill in the title bar shows the same run. The bar says what the model is doing and what state the run is in (running, paused, waiting for a card, or waiting for you to do a step). It has two controls, with the same names everywhere: **Pause**, which becomes **Resume** once the run is paused, and **Stop**. During a computer run an overlay bar on the screen has the same two controls.

- **Pause** holds the model before its next action, and **Resume** lets it go on. A run also pauses when you move the mouse, when you type where Plenum can see your keys (see [Known limits](#known-limits)), and when the model asks you to do a step, such as entering a password. While an approval card of the run waits, the bar says the card is waiting: answer the card in the chat, or press Stop.
- **Stop** ends the model's control at once and rejects every action it is still waiting to take. The model then writes a short report of what it did. Esc in the message box stops the reply as well.
- **The stop key** is **Ctrl+Alt+Esc** (**Control+Option+Esc** on a Mac). It works from any app, but only while a run is driving something: Plenum registers it when a run starts and releases it when the run ends. On Linux a desktop may already use that key, so `driveStopKey` in the state file can name another key with at least two modifiers, such as `Ctrl+Shift+F12`.
- **Time limits count only the time the model is driving.** The bar turns amber when 5 actions or 60 seconds are left. A run left paused for the pause limit ends by itself. The limit is 60 minutes by default, and **Settings › Safety › Computer use** sets it from 5 minutes to 8 hours.

The in-app browser uses the same bar and controls.

## Computer use

Computer use lets a model see the screen and act with the mouse and keyboard, in the apps you allow, for one task you give it. It runs only in the desktop app. One run belongs to one chat message, and every action it takes passes the same checks, cards, limits and run log.

### Starting a run

Type **/computer** (with the task after it, if you like), press the **Computer…** button in the composer, or choose **Use the computer…** from the **+** menu. The dialog opens with the choices you last made for this project. It has:

- **Task.** Say what the model should do, as you would to a person.
- **What the model sees.** One window, or a whole display. A window run sees that window with the menus and dialogs its app opens, and acts only in that app. A display run sees every window on the display.
- **Apps the model may use.** For a display run, pick up to 32 of the open windows. Password managers are never offered. **Any app, no asking** lets the model act in any app except the never-allowed ones.
- **Model.** Models that cannot use the computer are listed disabled, with the reason.
- **Limits and checks.** Closed by default; its summary shows the values in use. See Limits and pacing and the switches below.
- **Start**, **Cancel** and **Past runs**.

**Start is the consent.** The run begins as soon as you press Start, and the model sees what you chose at once. No start card asks again. A run that the model starts itself is different: with the project's switch **The model may start computer use itself** on (off by default, in Project settings), it shows a start card first, and Approve all answers that card only where it covers computer cards. The model can start one run per message, and only when no run is going.

The chat shows a Computer use line under the message with the apps the model may use. Each step appears in the chat as it happens, with the model's notes between steps, and a finished run keeps its summary.

### What never happens

These hold in every mode, and no switch changes them.

- The model never types into a password, one-time-code, 2FA or CVV field. On Windows Plenum asks UI Automation whether the focused field is one, and refuses to type when it cannot tell (for example in a program that hides its fields from Windows). The model then clicks the field once more or hands the step over. When it hands over, the chat shows a **Your turn** card: type the value into its box and press **Type it for me**. Plenum types it into the program the run was using and presses nothing else. The value is not kept, is not written to the transcript or the run log, and is not sent to any model.
- It never acts in a password manager, a credential or consent dialog, or a window that runs as administrator (an elevated window). Plenum's own windows are never a target.
- After any pause, it takes a fresh screenshot before its next action.
- Plan mode refuses computer use. Delegated coders, /build, council, relay, quick compare and pipelines never get it.

Card, bank and id numbers are blocked by default by the **Block card, bank and id numbers** switch under Limits and checks. Switch it off and the model may type numbers that it reads in your chat or on the screen, and the run log notes that the guard was off for that run. Everything it types goes to the model's provider. Use that only for test cards in your own app.

**Always asks first**, unless Approve all covers it. These switches are under Limits and checks, and all are on by default:

- Sending messages or email
- Buying or paying
- Deleting or discarding
- Submitting forms
- Agreeing to terms
- Signing in

A switch that is off leaves that item out of the instructions the model gets for the run. A question the model still raises is asked. In a window run, an action that lands in another app asks **Allow <App> for this run?**, and Approve adds that app for the run. In a display run, an app that is not on the list asks first, unless the choice for other apps is **Any app, no asking** (or **Refuse**, which never lets the model act there). **Ask before every action**, off by default, adds a card before each click, key press and typing step.

### Approval modes

The three approval modes treat these cards differently:

- **Ask first** shows every card above.
- **Auto-approve** does not answer any computer card. The cards still show.
- **Approve all** answers them for you while the project's switch **Approve all also answers computer-use cards** is on. The switch is on by default and is in Project settings. Each answer is logged as approved by Approve all and shown as a line in the chat. The floor is not a card, so Approve all does not change it: passwords, codes, never-allowed apps, elevated windows and Stop stay as described above.

### Limits and pacing

- **Limits and checks** are set for each project and remembered. They are up to 200 actions (10 to 2,000, or **No limit on actions**), 30 minutes of activity (1 to 480; paused time does not count), and a screenshot long edge of 1280 px (1600, 2000 or 2576 px are also offered). A click, a key press, a typing step and a scroll are one action each. Long runs cost more and give the model more room to wander.
- **Settings › Safety › Computer use** sets the values for every project: the pause limit (60 minutes; 5 minutes to 8 hours), the pause between two actions (300 ms; 100 to 2,000 ms), how many days run screenshots are kept (7; 1 to 90) and how many megabytes of them are kept (200; 50 to 5,000).
- Each action waits for the pause since the last one. After a Resume, the mouse must rest for about a second before the model acts.

### Pausing

Moving the mouse pauses the run, and **Resume** goes on. Typing pauses it where Plenum can see the keyboard (see Known limits). Paused time is not counted in the minutes of activity, and after any pause the model looks again before it acts. After an approval card, Plenum waits for the mouse to rest and brings back the window that was in front. If that window is not in front again, the action is refused. A run left paused for the pause limit ends.

### On screen

While a model acts, the drive bar above the composer shows what it is doing, with Pause and Stop. The title-bar pill shows the run with Stop. An overlay bar on the screen shows the run's state and the stop key. An **amber frame** goes around exactly what the model sees: the window in a window run, or the edges of the display in a display run. The frame shows only while the model is acting, and the overlay bar is kept out of the screenshots. In a window run on Windows and macOS, parts of the window that another program covers show grey to the model.

### Models

- **Claude.** Opus 5.5, Sonnet 5.5, Haiku 5.5 and Opus 5 use Claude's computer tools through the Anthropic API, so an Anthropic API key must be saved. The key is needed even when chat runs through the Claude CLI; with no key, Claude Code reaches the computer through the bridge instead. Claude Fable 5.1 is listed as untested.
- **OpenAI and Google AI.** Their computer-use tools run through the OpenAI and Gemini APIs, with that provider's key saved. A safety check the provider asks for appears as a card marked as OpenAI's or Google's. The switches under Limits and checks decide which checks are acknowledged without a card.
- **Other API models that take pictures.** Plenum's generic screenshot-and-act loop runs them, and the dialog marks them **generic loop**. The notice in the chat says the model was not trained for computer use, so expect misclicks and retries.
- **CLI agents.** Claude Code, Codex, Gemini CLI, Cursor and Grok Build reach the computer through the Plenum bridge while a run you started is live, through the same cards and Stop (see [CLI agents](#cli-agents)). Muse Code has no bridge.

Every model goes through the same checks, cards, limits and run log. Text-only models are listed disabled, with the reason.

### Platforms

- **Windows** works out of the box. A window that runs as administrator cannot be controlled, and Plenum refuses each action on it.
- **macOS** needs **Screen Recording** and **Accessibility** for Plenum, in System Settings › Privacy & Security. Grant both, then restart Plenum. The dialog's **Request permissions** button asks for them. Computer use has not been run on a Mac yet.
- **Linux** works on X11 only, with `xdotool` installed. Wayland is refused: the screen cannot be captured there, and the keyboard and mouse cannot be driven. It has not been run on a real Linux desktop yet.
- **Plain Node** (`npm start` and `node server.mjs`) has no computer use. It needs the desktop app.

### Run log

Each run is kept in the state folder, under `computer/runs`. It holds every screenshot the model was given, the actions it asked for, the card answers and the pauses. Typed text is clipped to 60 characters in the log, and the text typed into the **Type it for me** box is never written there. The files are not encrypted, and the Privacy Notice lists them. Runs are kept for 7 days and up to 200 MB by default; the oldest go first, and a run that is still going is never removed.

**Past runs** in the dialog, or `/computer runs`, lists the runs, newest first. Open one to see its steps and screenshots. **Delete this run** removes it, and **Delete all runs** removes every run that has ended. A run still going cannot be deleted; stop it first.

## Working in the chat

- **Copy, Insert, Edit and Regenerate.** Hover a message to see them. **Copy** copies the Markdown. **Insert** puts a reply in the message box (Append or Replace if the box has text). **Edit** on your own message removes it and everything after it and puts its text back in the box. **Regenerate** replaces the last reply, with the same model or another one you pick.
- **Undo.** `/clear`, `/compact` and Edit keep the chat they replaced. An **Undo** line above the message box puts it back until you send the next message, and it survives a restart. `/clear` on a chat of four or more messages asks first.
- **Cut-off replies.** When an API model stops at its output limit, the reply gets a note and a **Continue** button, which asks it to carry on. The Claude, Codex, Gemini and Muse Code CLIs report no such stop.
- **Lost connection.** If the page cannot reach Plenum's server, a banner says so and clears when the server is back. A failed message gets **Retry** (puts it back in the message box) and **Copy error**.
- **Model menu.** Each model shows whether it is ready (signed in, or a key is set), its price per million tokens, its context window and whether it can use tools. Choosing a model that is not ready shows a banner that says what to do.
- **Command palette.** Typing `/` lists matching commands with a hint for their arguments. Some have a second name: `/stop` runs `/cancel`, `/reset` runs `/clear`, `/switch` runs `/project`, `/forget` runs `/remove`, `/limits` runs `/usage`, and `/keys` and `/login` open Accounts. The Commands panel has a filter box.
- **Narrow windows.** Below 860 px the sidebar folds into a menu button at the top left. The desktop window can be as narrow as 480 px.

## Settings

**Settings** in the sidebar, Ctrl+Comma or `/settings` opens one page over the chat. It keeps the title bar, so the drive pill and Stop stay visible. A list on the left, with a search box, holds the groups **This project**, **Rules**, **Accounts**, **API finder**, **Roles**, **Agents**, **Safety**, **General**, **Updates** and **Legal**, and each group's sections stack on the right. The sections this README describes are:

- **Appearance:** the same choice as the **Theme** button (system, dark or light).
- **Desktop:** the four switches described in [Finished alerts and keep-awake](#finished-alerts-and-keep-awake). They take effect in the desktop app only, and the section says so when the page is not running there.
- **Sessions:** the session mode, Transcript or Native, as described in [Session modes](#session-modes).
- **Updates:** the installed version, **Check now**, **Restart to update**, the **Check for new versions** switch and the channel, as described in [New versions](#new-versions). Checks run only in the desktop app; a plain `npm start` run says that update checks are not available.

Each change saves at once, and the line under it says **Saved** or why the change was refused. Panels can add their own sections; see [Extending Plenum](#extending-plenum).

## Phones

A phone can show the same Plenum as this window: chat, models, approvals, agents, review and Stop. You pair a phone once, from **Settings › Phones › Add phone**. Pairing happens only at this computer: a window that screen capture does not show asks you to check a six-digit code against the phone and press **Allow**. No model, tool or other program can pair a phone, press Allow or raise a phone's tier.

- **Ways to reach this computer.** The same network (off until you turn on **Allow phones on this network**; Windows may ask before Plenum can listen), your own Tailscale (after you agree in Settings › Phones, Plenum runs `tailscale serve` with your Tailscale), or a relay you deploy to your own Cloudflare account from the `relay/` folder. Plenum runs no server for phones, and its developer receives nothing from them.
- **Encryption.** Each phone link is encrypted end to end with X25519 key exchange and ChaCha20-Poly1305 (the Noise protocol). The web page a phone opens on the same network is plain http, so an active attacker on that network can alter it. Use Tailscale or the relay on networks you do not trust.
- **What a phone can do.** At the **Full** tier a phone can do what this window can. Actions a phone starts, approves or stops are your actions, as the License Agreement says. **Approve and watch** lets a phone watch, approve and stop, and **Read only** lets it watch and stop. Tiers are set here, at the computer.
- **Indicator.** While a phone is connected, the title bar shows **Phone connected** and the tray shows how many. No setting hides it. Every action a phone takes is labelled with that phone's name in the activity list, the approvals and the history.
- **Stop.** Stop works from a phone in every tier, and from a notification. It ends every run on this computer.
- **Notifications.** Off until you turn them on, and each kind has its own switch. They show the project name and a short status. **Include the first line** adds the first line of a card, which can name files and commands. A phone browser gets them from its own push service (Google, Apple or Mozilla); an Android phone can use UnifiedPush through the app you choose, such as ntfy.
- **Keys and removal.** The phone link's keys are in `phones.json` in the desktop app's user-data folder, encrypted by the operating system. Under plain `node` they are plain files in the state folder, and Settings › Phones says so. Remove a phone under Settings › Phones: its connection closes at once and its key is deleted here. Keep phones locked, and remove a lost one.
- **Stop from a locked phone.** The lock screen's Stop everything and a notification's Stop all reach the computer without unlocking the phone. They use a Stop key that can only stop runs on that computer, and Remove revokes it with the phone.
- **Changing how phones connect.** Only the computer can turn phones on or off, change the ways phones reach it or use Remove all. A phone with Full control can still remove a single phone.
- **Relay room.** If your relay turns this computer away, Settings › Phones offers New room. Phones paired before then use the relay again after you pair them again.
- **Phone apps.** The phone code is in `mobile/`. The phone web app loads from this computer, or from your relay. The iPhone and Android apps update through their stores or the release page, not through this computer.
- **Steering this computer from a phone.** A phone at **Full** control can tap, drag and type on the Browser pane's picture, and on a computer run's live picture after **Take over from phone**. The input is yours, not the model's: it goes straight to the browser or the screen, and no model run sees it or what you typed. Take over from phone pauses the model, waits for any step already on its way, and **Resume** hands the run back. Stop works throughout. Pictures are sent only while a phone is looking, at most five a second. A notice explains this the first time the controls appear. The iPhone app can steer only over the same network.

## Side panes

The side pane is the column to the right of the chat. Panels put their tabs into it, such as Artifacts, the Browser, Review and Agents, and only one tab shows at a time. **Back to the chat** hides the column and keeps the tabs. **Close pane** closes the tab that is showing. Drag the pane's left edge to resize it, double-click the edge to reset it, or focus the edge and use the arrow keys. The pane starts at 440 px. It is never narrower than 380 px, and never wider than the smaller of 60% of the window and the window less 480 px, so the chat keeps room. Below 860 px the pane covers the window below the title bar, and **Back to the chat** returns to the chat. The width is kept only for the life of the page.

## Keyboard shortcuts

Press **Ctrl+/** (**Cmd+/** on a Mac) for the full list. The main ones: **Enter** sends (or queues during a run), **Shift+Enter** adds a line, **Esc** closes a list and then stops the run, **/** focuses the message box, **Up** in an empty box recalls your last message, **Ctrl+K** switches project, **Ctrl+Shift+P** turns plan mode on or off, **Ctrl+Shift+C** turns council mode on or off, **Ctrl+Shift+A** opens Accounts, **Ctrl+Shift+B** opens the Agents tab, **Ctrl+Shift+\\** turns split view on or off (**Ctrl+1** and **Ctrl+2** go to its two message boxes in the desktop app), and **Ctrl+Enter** starts a quick compare or a pipeline. Ctrl+K and Ctrl+/ work even in a text field. Ctrl+Shift letters work from the message box but not from other text fields. The approval modes (Ask first, Auto-approve and Approve all) have no shortcut on purpose. **Ctrl+Alt+Esc** (**Control+Option+Esc** on a Mac) stops a computer or browser run from any app while a run is driving something; see [Model-driven runs: pause and stop](#model-driven-runs-pause-and-stop).

## Checkpoints

Before a write that Plenum allows, the write and edit tools and the Claude CLI's own writes keep the file's previous contents in the state folder, under `checkpoints/<project id>`. Files over 5 MB are not kept. Open **Checkpoints** to see the list and restore a checkpoint. **Show changes** shows what a restore would change, as a diff from the file as it is now, and **Group by file** lists the changed files in this chat. The restore card shows the same diff. A restore that you click is allowed in plan mode, with the same checkpoint and confirmation; the model itself still cannot write in plan mode. Codex, Gemini and Muse Code write files on their own; the turn snapshots below cover those writes.

### Turn snapshots and Rewind

Before each chat turn and each build, Plenum records the project folder in a private git repository under `~/.muse-console/shadow`, separate from the project's own `.git`, and again after the turn. This covers files written by Claude Code, Codex, Gemini CLI, Muse Code and shell commands. Folders such as node_modules and .git, files listed in .gitignore, and files over 5 MB are left out; a folder with more than 20,000 files or 1 GB is not snapshotted, and the chat says so. Snapshots need git. **Rewind** under a message offers **Code and chat**, **Code only** or **Chat only**. Rewinding code shows a card with every file it will restore or remove and the diff; it is refused in plan mode and while the project runs, and **Undo code rewind** puts the files back. Chat only works like Edit without filling the message box. The last 50 turns of each chat keep their snapshots. The copies are plain git objects, not encrypted. Secret files are left out whatever `.gitignore` says (`.env` and `.env.*` other than the example ones, private keys such as `id_ed25519` and `*.pem`, `.npmrc`, `.netrc`, cloud credential files and the like), and a rewind never writes over or removes them. Forgetting a project or clearing its chat does not remove them; delete the `shadow` folder in the state folder to remove them all (the Privacy Notice says the same).

## Attachments

Attach a file with the attach button, by dropping it on the message box, or by pasting it. Type `@` in the message box to pick a file or folder by a few letters of its name; the list leaves out ignored files, credential folders and Plenum's own source, and marks files that may hold secrets. It also offers live context: `@diff` (the working-tree diff), `@checkpoint` (what the last turn changed), `@checks` (the last check output) and `@thread:<name>` (another thread's last reply). Each goes to the model as a block marked as data from another source, up to 100 KB each and 200 KB per message; all models get them, the CLIs included. A file literally named `diff` is written `@./diff`. Paths with spaces cannot be @-mentioned; use the attach button. Up to 10 files and 25 MB in total can go with one message.

- **Images** (PNG, JPEG, GIF, WebP; up to 4 per message, 5 MB each) go to Claude (through the CLI or an API key), Codex, Gemini CLI, and the API models whose providers document image input (Grok takes PNG and JPEG only). Which models take images is in `lib/capabilities.mjs`, read from each provider's pages on the date it shows. Muse Code and DeepSeek take text only. Before you send, a line under the attachments says what the selected model will receive, for example 'Gemini CLI: image ok · PDF as text'. Gemini CLI gets the images from a temporary folder that is deleted after the reply.
- **PDFs** (up to 20 MB) go to Claude by API key as documents (up to 100 pages). Every other model gets the PDF's text, read by Plenum (up to 100 pages and 200 KB of text; never part of a file). A scanned PDF has no text, and Plenum says so instead of sending it.

Council seats, the moderator and quick-compare seats get the images when their model takes them; the others get a note that an image was attached.
- **Text and code** from the attach button, drag and drop, or paste go into the prompt for every model (up to 200 KB a file, 600 KB of text in all). A `@path` file goes into the prompt for the API models only, and only if it is 100 KB or less. Claude through the CLI, Codex, Gemini and Muse Code read a `@path` file with their own tools.

## Tokens and cost

Each reply records the tokens its provider reported. Dollar figures come from `lib/pricing.mjs`, which has per-token prices for the API models, read from the providers' pricing pages on 2026-10-14 (`PRICES.checkedOn`). Check the prices again before relying on a cost figure. A model with no published price shows "price not published", and a reply whose usage was not reported shows "usage not reported". Tokens are never estimated. A subscription CLI (Claude Code, Codex, Gemini CLI, Muse Code) is billed to your plan, so its replies show plan use: tokens only, never a dollar amount. The top bar shows the project's running total, and its tooltip gives the breakdown.

### Spend limits

The spend chip in the project header opens **Spend limit**, where a project can have a warning amount and a cap in dollars for models billed through an API key. The total keeps counting across `/clear`, `/compact`, Edit and Undo, from the date shown, until you press **Reset spend**. Crossing the warning shows one notice. At the cap, messages, `/review` and `/compact` that would bill an API key are refused with a plain message, and the automatic advisor review is skipped with a notice. The Claude, Codex, Gemini and Muse Code CLIs on your plans are never refused. Agents on API-key models count toward the cap, `/build` tasks included: an agent that would bill an API key is refused at the cap like a reply, and its cost adds to the running total (see [Agents](#agents)). Council, quick compare, pipeline and relay replies themselves are not counted yet, because their cost is not worked out on the server.

## History search and export

The **Chat history** panel searches the current project's chat, case-insensitively, newest first, up to 50 matches. Tick **All projects** to search every project's chat; each match names its project, and clicking it switches there and outlines the message. The panel also exports the chat as a Markdown file. Search and export read the chat and change nothing. Each project keeps its last 300 messages.

## Saved prompts

A saved prompt is a named template for one project. Its name is up to 32 lowercase letters, digits or hyphens, and it cannot be the name of a built-in command. Its text is up to 4,000 characters. `$ARGUMENTS` in the text is replaced by whatever you type after the name. Type `/name` in the message box to send it. Saved prompts are kept in `prompts.json` in the Plenum state folder.

**Export** saves a project's prompts as a JSON file, and **Import** adds the prompts from such a file; a prompt with the same name is replaced. Pipelines export and import the same way in their panel. Every entry is checked before anything is saved, and a file with one bad entry is refused with the entry's number. Importing never runs anything.

If `prompts.json` is damaged (it cannot be read as a JSON object), Plenum renames it to `prompts.json.corrupt-<time>`, never deletes it, and starts with an empty list. An entry that was broken by hand is left out of the list, so it cannot be sent.

## Rules

Open **Rules** in Settings (or type `/rules`) to edit the project's rules files and your global rules without leaving Plenum.

- **AGENTS.md** in the project folder is the project owner's instructions. Plenum adds its text (up to 32,000 characters) to the instructions for every chat message and for the build's planner, coders and reviewer, and says in the chat when it uses one. Codex also reads it from the folder on its own. It is treated as data: it cannot approve an action, widen the project folder or turn a tool on. The panel creates it when there is none.
- **CLAUDE.md** and **GEMINI.md** are read by Claude Code and the Gemini CLI from the project folder on their own; Plenum edits them but never adds them to a prompt. The panel shows them when they exist and can create them.
- **Global rules** apply to every project, after the project's AGENTS.md. They are kept in `rules.md` in the Plenum state folder (up to 16,000 characters) and are never written to the CLIs' own global files.
- **Blocked commands** are still edited in Project settings; the panel links there.

Before the panel overwrites a project file it keeps a checkpoint, so **Checkpoints** can put the old text back. A file that changed on disk while the panel was open is reloaded if you had not edited it, and otherwise your save is refused until you reload. Saves are refused while the project is running. Plan mode does not refuse your own save: plan mode binds the model, not you, so a save from this panel is written with the same checkpoint as outside plan mode. The model still cannot write files in plan mode. A change applies from the next message; a Native session is started again so the model sees it. Council, quick compare, pipeline and relay seats do not get the rules.

## Finished alerts and keep-awake

In the desktop app, Plenum shows a "Plenum finished" notification when a run in the active project ends while the window is not focused. Clicking it brings the window back. While a run is in progress, Plenum keeps the PC from suspending. When an approval card is waiting and the window is not focused, Plenum shows "Plenum needs your approval" with the project's name; clicking it brings the window back. The tray icon's tooltip and menu show how many approvals are waiting. The four switches are under **Settings** in the sidebar, in the **Desktop** section: **Finished alerts**, **Approval alerts**, **Keep awake** and **Keep in tray on close**. They are also kept in the state file as `finishedAlerts`, `approvalAlerts`, `keepAwake` and `trayOnClose`, and a change made in the window applies at once, with no restart. Finished alerts, approval alerts and keep awake are on by default. Keep in tray on close is off by default. None of them runs under `npm start`.

## Project settings and tools

Each project folder can have its own model, effort, approvals, relay settings, plan mode, deny patterns, tool options and agent types and limits. Open **Project settings** with the gear beside the project name. Each setting follows the app default until you change it, and **Use app default** goes back to it. The **Tools** section covers Claude Code, Codex, Gemini and Muse Code. For example, it sets Claude Code's permission mode and tool lists, Codex's sandbox (read only, or project folder only), and Muse Code's approval mode and sandbox network. Council seats and the moderator are not given the project's tools unless you allow read-only agents for them in **Agents > Limits** (see [Agents](#agents)); a CLI seat runs in its own read-only setting. The **Agents** section gives the project its own copy of the agent types and limits, or uses the app's.

Under the deny patterns, **Test a command** says whether a built-in rule or one of the project's patterns would block a command you type. It only checks; nothing runs.

The project's **Approvals** setting takes Ask first, Auto-approve or Approve all, and a project's value is what its runs use. The same setting is the **Mode** menu's choice.

**Browse…** in the add-project form opens the system's folder chooser in the desktop app. Under `npm start` it says to paste the path instead.

For a project in a git repository, the header shows the branch, how far it is ahead or behind, and how many files are changed or untracked. Click it for the list of files. It refreshes every 30 seconds and after each run, and it runs one fixed, read-only `git status` command, with git's `core.fsmonitor` program, hooks and filter drivers turned off (see `DECISIONS.md`, items 18 and 30).

### Check after each turn

In **Project settings**, **Check after each turn** takes a command such as `npm test`, `pytest -q` or `cargo check`. After a chat turn that changed files, Plenum runs it in the project folder (or the thread's own copy) and the reply gets a badge: **Checks passed · 12 s** or **Checks failed · exit 1**, with the output one click away. **Send failures to <model>** puts the failure output in a message for the agent. **Auto-fix up to 2 times** (off by default) sends the failures back by itself and runs the check again, at most twice; each round is a normal reply that counts toward the spend limit and asks for approval as usual. The check runs like run_command: with your user rights, through the deny list, with a time limit (120 seconds by default) and a cap on its output. It never changes Ask first or Auto-approve. A safety notice under the switch says the check runs with your rights and no approval card, and that Auto-fix sends its output to the model. When a turn changed a file that decides what the check runs, such as package.json or a Makefile, Plenum does not run it by itself; look at the change, then press **Run checks**. No check runs in plan mode.

## Session modes

The **Sessions** choice in **Settings** is either Native or Transcript (saved as `sessionMode` in the app's state file). Transcript, the default, sends the chat again with each message. Native resumes the session that Claude or Codex keeps for the main chat. Other providers, and Muse Code, always send the transcript. Council seats always send the transcript, and each shows **Sessions: Transcript**, because their turns are read-only and never open a native session. A change to AGENTS.md or the global rules starts the Native session again on the next message, with a notice, so the model sees the new rules.

## Portable and tray mode

On Windows, `npm run dist:portable` builds one portable `.exe` in `release/` that runs without an installer. To keep the window in the tray, turn on **Keep in tray on close** under **Settings** › **Desktop** (or set `"trayOnClose": true` in the state file: `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux). Closing the window then hides Plenum to the tray and the server keeps running. Click the tray icon to show the window again, or choose **Quit** from the tray menu to stop everything.

## CLI agents

Claude Code, Codex, Gemini CLI, Cursor and Grok Build run as their own command-line programs with their own sign-ins; Plenum never gives them a key.

Claude Code, Codex, Gemini CLI, Cursor and Grok Build can use the Plenum browser pane, a computer-use run you started and Plenum's agents. Plenum starts a small local MCP server for the CLI for each chat message (never for read-only seats, council seats or Plan mode); each call goes through the same cards, site list, limits and Stop as in Plenum's own chat. Plenum passes the CLI only the address of this app on your computer and a one-time token, never a key or a sign-in. Muse Code does not get the bridge.

Cursor runs through the Cursor CLI (`agent`, or `cursor-agent`), signed in with your Cursor account through Cursor's own sign-in. Plenum does not use a Cursor API key: it removes `CURSOR_API_KEY` and every other `CURSOR_` setting from the program's environment. Its default transport is ACP, so Ask first works: its edits and commands come to Plenum as approval cards. `MUSE_CONSOLE_CURSOR_TRANSPORT=print` uses Cursor's print mode instead, which cannot ask: in Ask first Cursor only proposes its edits in its reply, and in Auto-approve or Approve all it runs with its own prompts off (`--force`), so Plenum's deny list and credential floor do not reach those steps, and a notice says so. A read-only Cursor run (a council seat, a compare column, plan mode) runs in an empty folder and refuses every request.

Grok Build runs through its own CLI (`grok`, installed with x.ai's installer), signed in with your SuperGrok or X Premium Plus account through `grok login` in Accounts. Plenum removes every `XAI_` and `GROK_` setting from the program's environment, so no API key reaches it. Its default transport is ACP (`grok agent stdio`), so Ask first works: its edits and commands come to Plenum as approval cards. `MUSE_CONSOLE_GROK_TRANSPORT=print` uses `grok -p` instead, which cannot ask, so an action that needs approval fails. In Approve all, that transport runs with Grok Build's prompts off (`--always-approve`); Plenum cannot see or stop those steps, and a notice says so. A read-only Grok Build run (a council seat, a relay hop, a compare or pipeline step, plan mode) runs in an empty folder and refuses every request.

## Agents

An agent is a model that does one task for another model and reports back. Open **Settings**, then **Agents** (or type `/agents`), to see the agent types and the limits. Five built-in types come with Plenum: **Researcher** (reads the project and reports what it finds; never edits), **Coder** (makes one change inside the folders it is given and reports what it changed; this is the coder that the delegate tool and /build have always used), **Tester** (runs the checks the task names, such as one test file, a lint or a build, and reports pass or fail with the failing output; it does not edit), **Reviewer** (reviews the change it is given, opens the files it needs and gives a verdict; it does not edit; /build's review step uses it) and **Planner** (splits a goal into build tasks; /build uses it alone). You can add your own, most quickly with **Copy** on an existing type. Each type sets its model (any provider, or the same model as the one that asked), effort, a tool-step limit, a time limit, an idle limit, its access to the project files (none, read, or read and edit), whether it may run commands or use the web, which folders it may write in, and what it reports back. Built-in types keep their name, kind and reply layout. **Reset** on a built-in type restores its shipped settings; on the Reviewer it restores the older version that cannot open files. **Limits** say, per caller (the chat model, a build, each council seat, the moderator, relay hops, quick compare columns and pipeline steps), which types it may start, how many at once, how many per reply, build or run, and whether to ask before each start. A per-model override gives one model its own numbers, in every role or in one. Below them, **Every run** says whether agents may start agents (off by default, read-only agents only, or any type they may start) and the most agents in one run. The council seats, the moderator, relay hops, quick compare columns and pipeline steps start nothing until you give them types. Once you do, their cards show on the Agents board and in the chat under the seat's name, and the types they may be given can edit files or run commands; the add menu lists the read-only types first, marked suggested. The settings are app-wide, and a project can keep its own copy with **Give this project its own agent settings** in **Project settings**. The defaults are: the chat may start Researcher, Coder, Tester and Reviewer, 8 at once and 32 per reply; /build may start Coder, Researcher and Tester, 4 at once and 8 per build; agents cannot start agents; the other roles start nothing. A call beyond the number at once waits for a place, and a call beyond the number per reply is refused. An agent that a seat, hop, column or step starts is told which model started it and that its report goes back to that model, not to the person.

Limits are enforced while an agent runs: it is stopped at its tool-step limit, its time limit or its idle limit, and the model that asked is told why. Every agent follows the approval mode (Ask first shows its cards, named after the type and the task), plan mode (no agent runs), the blocked commands, checkpoints and the project spend cap (an agent on an API-key model is refused at the cap, and its cost counts toward the running total). Through the Claude CLI, the chat can start only agent types on Claude models, because they run as Claude Code subagents; Claude Code's own subagents count against the Chat row and can be turned off in Limits.

**Running agents** are listed in the **Agents** tab of the side pane, which `/agents running` and Ctrl+Shift+B open. Its button shows how many agents are waiting for you (in amber), or else how many are running. The tab has three parts. **Waiting for you** holds the approval cards, one open at a time. **Running** is a tree, with each agent under the agent that started it, showing its type, its title, its model, its elapsed time, its steps and its state (waiting for a free slot, waiting for your approval, running, or running inside Claude Code). Each agent has **Stop**. The tab's **Stop all** asks first, then stops every reply, agent and computer or browser run in every project and denies the cards they wait on, like Stop on a phone. **Finished** lists the last 30 agents with how each one ended, such as stopped at its time limit, stopped by you or failed. An agent that runs inside Claude Code has no Stop, because Plenum cannot stop it; Esc stops the whole reply. The list is the table the limits count, so what it shows is what the limits count. `/agents stop` stops every running agent in the active project. The sidebar's **Running now** list shows every run in every project, with the approval cards that wait pinned at the top as **Waiting for you**; **Show all (Ctrl+Shift+B)** opens this tab. In `/build`, each task row shows its agent type and model, its elapsed time while it runs and its steps once it is done, and the plan panel lets you change each task's agent, model and effort before it runs.

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
| `/build` | Turn the last council recommendation into tasks, then run them. Each task runs as an agent type (Coder by default). |
| `/agents [running\|stop]` | Agent types and limits; `running` shows the agents at work, `stop` ends them all |
| `/relay` | Pass a finished reply from one seat to another, once or as a route |
| `/approvals [ask\|auto\|all]` | Show or set the approval mode. `all` asks you to confirm |
| `/focus [on\|off]` | Build focus on or off for this project. With no word it switches |
| `/computer [task\|runs]` | Open the Computer use dialog, with the text after it as the task; `runs` lists the past computer runs |
| `/rules` | Open the Rules panel: AGENTS.md, CLAUDE.md, GEMINI.md and the global rules |
| `/legal` | Open the Legal page: the License Agreement, Privacy Notice, third-party notices and safety notices |
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
- Muse Code's approval and sandbox settings come from its tool options in project settings, not from the Mode menu. The default is on-request approval. Muse's own approval prompts cannot be answered from this window, so in Approve all they are turned off instead (`--disable-approval`); verify how a headless run behaves after you sign in.
- In Approve all, commands that Gemini runs in its yolo mode and that Muse Code runs with its prompts off are not checked by Plenum's deny list, which covers only the write and edit tools, `run_command` and the Claude CLI. Their own settings files (`~/.gemini/settings.json`, `security.disableYoloMode`; Muse Code's own config) still apply.
- The API finder matches models across routers by exact id, after spelling fixes for a few makers (x-ai, mistralai, z-ai, deepseek-ai). It does not include fees in its comparison, drops router entries marked deprecated, and its hand-checked router table is dated 2026-10-20.
- Checkpoints and the deny list cover the write and edit tools, `run_command` and the Claude CLI. They do not cover writes that Codex, Gemini or Muse Code make on their own. Those three also still read the project as advisor, planner or reviewer.
- Muse Code runs one-shot per message, with the chat resent. Codex resumes its own session only in Native session mode. Neither shares its session memory with Claude's history.
- Prompts for the CLIs go in a file or on stdin, so long histories fit.
- Plenum keeps projects and chat history in `%USERPROFILE%\.muse-console\state.json` on Windows, or `~/.muse-console/state.json` on macOS and Linux (override with `MUSE_CONSOLE_HOME`). It does not write API keys to that file. Where keys are kept is described in [Where keys are kept](#where-keys-are-kept). Before each save, the previous file is copied to `state.json.bak`. If `state.json` cannot be read as JSON at start, it is renamed to `state.json.corrupt-<time>` (never deleted), the backup is loaded, and a banner says what happened. If it cannot be opened at all (another program holding it), Plenum tries three more times, then loads the backup and leaves the file alone; before the next save replaces it, it is copied to `state.json.unread-<time>`.
- The server binds to 127.0.0.1 only. Every request to `/api/` must carry the per-launch token (the desktop app passes it to its window; a plain node run prints a link that carries it) and POSTs must come from the same origin.
- `MUSE_CONSOLE_NO_FALLBACK=1` turns off the server-side refusal fallback that the Claude Opus, Sonnet and Fable models request by default.
- macOS and Linux have not been run. They were only tested with the platform forced. Every build is unsigned until certificates are added, including the Windows installer and portable exe built here (Windows SmartScreen warns on first run), and the Linux builds are never signed. Unsigned macOS builds cannot install updates.
- The desktop app itself (the Electron window, the OS-encrypted key store, and the utility process that runs the server) has been tested only against stand-ins, not by launching the app. That includes the approval alert, the tray count, the folder chooser behind **Browse…** and the 480 px minimum width.
- Automatic updates were tested against a stand-in updater and a local pack, not against a published release. The first real release should be tried on a Windows install, a portable exe and a Mac before it is widened.
- Cut-off replies (**Continue**) and the spend cap's refusal were checked against mock providers, not live API models. Approval cards from a live model, with their keys, reason box and **Show all**, were checked with cards made by a checkpoint restore and with page tests.
- The deb maintainer (`build.deb.maintainer` in `package.json`) is a placeholder, `[LICENSOR NAME] <[CONTACT EMAIL]>`, and must be replaced before release. The author name and email in `package.json` are placeholders too, and they set the Windows company name.
- In their read-only settings, Codex, Gemini and Muse Code can still read files on the machine and run commands that only read, so do not paste untrusted text into a council, relay, compare or pipeline run that includes them.
- Plenum cannot stop or time a subagent that runs inside Claude Code on its own; Esc stops the whole reply. Codex, Gemini and Muse Code agents are timed and stopped by Plenum, but Codex and Gemini report no tool steps headlessly, so only the time and idle limits apply to them (Muse Code is capped through its own step setting, at most 200).
- A council seat allowed to start agents can learn what is in the project through them, so the earlier sentence about untrusted text applies to those runs as well.
- Passing the tool test shows that a model calls Plenum's tools correctly in a small sealed folder. It does not show that the model behaves safely; approvals, the deny list and plan mode are what protect a project.
- The deny list covers run_command and the Claude CLI, not commands that Codex, Gemini or Muse Code run on their own. Turn snapshots cover files any agent writes, but not files over 5 MB, ignored files, or folders over 20,000 files.
- Cursor's print transport cannot ask before it writes, and a long prompt is limited by the command line (about 7,000 characters through a .cmd shim on Windows): the newest message is kept, and a message too long to send is refused with a plain error.
- Grok Build and Cursor are read through the Agent Client Protocol (ACP), which is new in both. Their print transports are the fallback and cannot ask for approval. Headless Grok Build billing (subscription or API credits, when both exist) is not documented by xAI.
- Plenum reads a PDF's text only, not its pictures or layout. Gemini CLI image support rests on its @file syntax in non-interactive mode.
- Password fields. Windows asks UI Automation and refuses to type where it cannot tell. macOS and Linux check the programs that show their fields to the system (the accessibility API on macOS, AT-SPI on Linux), and those two checks have not been run on those systems yet. Where a check cannot tell, the model's own rule is the protection, so do a password step yourself: press Pause, type it, then Resume, or let the model hand the step over and use **Type it for me**.
- Screenshots of a whole display include every window on it, allowed or not. Choose one window when the task allows it. In one-window mode on Windows and macOS, parts of the window covered by another program show grey to the model.
- On Linux, one-window mode shows the window alone, so menus and dialogs that open as separate windows may not be visible to the model.
- Pausing when you type works on Windows. The macOS check has not been run on a Mac, and Linux cannot see the keyboard. Moving the mouse pauses on all three.
- Fable 5.1 is untested for the computer toolset.
- In split view the right pane has no attachments, / commands, Council, Rewind, Regenerate, Send to, Build this or artifact buttons; Swap sides gives its thread the full message box. Notices raised by a right-pane run appear above the left message box, and a run of the right thread started in another window shows when it ends.

## Tests

The test scripts live outside this folder. They cover the security gate, projects and settings, streaming, file mentions, the Claude request shape and tool loop against a mock endpoint, path containment, approvals, the approve-all floor, the rules files and panel, build focus, the prompt wiring, the agent types and limits, the agent runner, read-only role delegation, the update outbox (including apply with backup), the Muse and Codex process handling, computer use (policy, run controller, log, the adapters for Claude, OpenAI and Gemini and the generic loop against fixtures, and the desktop backend's fake and geometry), and the smoke test. `npm run computer:smoke` (with PLENUM_SMOKE=1) checks capture and input against a throwaway window of its own.

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
