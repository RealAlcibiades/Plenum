# Decisions

The defaults Plenum ships with, each with its reason and source. A default marked **Tentative** rests on a claim that was not confirmed against a source this round, so check it before relying on it.

Sources checked for items 1 to 11 (an earlier round):

- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage (read)
- Microsoft Defender SmartScreen: https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ (read)
- Apple, opening apps that are not notarised: https://support.apple.com/en-us/102445 (read)
- Apple notarisation: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution (page did not load; not confirmed)
- electron-builder: https://www.electron.build (the configuration pages returned 404 this round; the installed package's schema and types were read instead)

## 1. API keys sit in the OS-encrypted store; the server holds them in memory only

**Decision.** The desktop app encrypts each key with Electron safeStorage and writes the ciphertext to one file in the app's user-data folder. The server receives the keys from the desktop app over its channel and holds them in memory while Plenum runs. The desktop app does not read these keys from environment variables. Plain Node (`npm start`) reads keys from environment variables and cannot save them.

**Reason.** safeStorage uses the operating system's own protection: Windows data protection (DPAPI), the macOS Keychain, or a Linux secret service. Keys are then not plain text on disk. Keeping them only in server memory means the server never reads the file, and keys stay out of the state file, the logs and the browser.

**Source.** Electron safeStorage docs (DPAPI on Windows, Keychain on macOS, kwallet and gnome-libsecret on Linux); `desktop/keyvault.cjs`; `lib/keys.mjs` (`lookup`); `lib/api-providers.mjs`.

**Status.** Confirmed.

## 2. Linux with no keyring (basic_text) keeps keys for the session only

**Decision.** When safeStorage reports the `basic_text` backend, Plenum keeps keys in memory for the session and does not write them to disk. The Accounts panel says so, and the keys are forgotten when Plenum closes.

**Reason.** The Electron docs say `basic_text` encrypts with a hardcoded password, so it gives effectively no protection. Keeping keys in memory avoids writing them to disk in a form anyone can read.

**Source.** Electron safeStorage docs (`getSelectedStorageBackend`, `basic_text`); `desktop/keyvault.cjs` (`REAL_BACKENDS`).

**Status.** Confirmed.

## 3. Windows targets: nsis, portable and zip

**Decision.** `build.win` in `package.json` lists `nsis`, `portable` and `zip`, all for x64. `npm run dist` builds all three.

**Reason.** NSIS installs per user, with no admin rights needed. The installed electron-builder schema gives `nsis.perMachine` a default of `false`, which matches that. Portable runs without an installer. Zip is a plain archive.

**Source.** `package.json`; `node_modules/app-builder-lib/scheme.json` (`perMachine` default `false`). The electron-builder Windows page could not be read this round.

**Status.** Config confirmed. The reasons for portable and zip rest on the target names, not on the docs. Tentative for the docs citation.

## 4. macOS targets: dmg and zip

**Decision.** `dist:mac` builds dmg and zip for arm64 and x64. `dist:mac:arm64` and `dist:mac:x64` build one architecture each. The release workflow builds arm64 on `macos-latest` and x64 on `macos-15-intel`.

**Reason.** dmg is the usual drag-to-Applications install. Zip is a plain archive. Plenum does not use an auto-updater (its only runtime dependency is the Anthropic SDK); updates go through the Updates panel.

**Source.** `package.json` (dependencies, scripts, `build.mac`); README, Updates section.

**Status.** Tentative. The electron-builder mac docs could not be read, so the reason for dmg and zip is general knowledge.

## 5. Linux targets: AppImage and deb (x64)

**Decision.** `dist:linux` builds AppImage and deb for x64.

**Reason.** AppImage runs on many distributions without installing. deb installs on Debian and Ubuntu family systems.

**Source.** `package.json`. The electron-builder Linux page could not be read this round.

**Status.** Tentative. The reason is general knowledge, not checked against the docs.

## 6. Release builds run in GitHub Actions on Windows, macOS (arm64 and x64) and Linux

**Decision.** `.github/workflows/release.yml` runs on version tags (`v*`) with four jobs, each uploading a `release-<runner>` artifact and publishing nothing (`--publish never`):

- `windows-latest`: `npm run dist`
- `macos-latest`: arm64 only, `npm run dist:mac:arm64`
- `macos-15-intel`: x64 only, `npm run dist:mac:x64`
- `ubuntu-latest`: `npm run dist:linux`

**Reason.** A Windows, macOS or Linux installer has to be built on that OS. Two macOS runners give arm64 and x64 without building x64 twice. `dist:mac` passes both `--x64` and `--arm64`, and electron-builder builds every flagged arch, so the arm64 job uses `dist:mac:arm64`, which passes only `--arm64`.

**Source.** `.github/workflows/release.yml`; `package.json` scripts; `node_modules/electron-builder/out/builder.js` (arch flags are added, not replaced).

**Status.** Workflow and scripts confirmed. The runner architectures (`macos-latest` as arm64, `macos-15-intel` as x64) are **Tentative**: they were not checked against GitHub's runner list this round.

## 7. Builds are unsigned until certificates are added; signing is forced only when its secret is set

**Decision.** The repository holds no certificates, so the first builds are unsigned. Windows signs only when `WIN_CSC_LINK` is set. macOS signs when `CSC_LINK` is set and notarises only when all three App Store Connect secrets are set. `forceCodeSigning` is passed only when that platform's certificate secret is present, so a broken certificate fails the build rather than shipping unsigned. Linux has no signing step.

**Reason.** Microsoft Defender SmartScreen judges a downloaded app by its reputation and signature. An app with neither gets a warning. Apple asks the person to allow an unsigned or un-notarised app in System Settings under Privacy & Security. Forcing signing only when a secret is present keeps a broken secret from quietly producing an unsigned build.

**Source.** Microsoft SmartScreen overview (reputation and signature checks, warning when there is none); Apple support page 102445 (allowing an app that is not notarised); `.github/workflows/release.yml` (secret handling); `node_modules/app-builder-lib/out/options/PlatformSpecificBuildOptions.d.ts` (`forceCodeSigning`).

**Status.** SmartScreen and Apple warnings confirmed. **Tentative** for the notarisation requirements (Developer ID signing, hardened runtime, a secure timestamp): the Apple notarisation page did not load, so those points rest on general knowledge.

## 8. The CLIs sign in through their own login in a terminal window

**Decision.** Accounts opens a terminal that runs `claude auth login`, `muse login` or `codex login`. Gemini opens its own CLI for the Google sign-in. Plenum does not store or copy those sign-ins; it only checks whether one exists. Each CLI's child process drops the per-token provider keys (xAI, OpenAI, DeepSeek, Mistral, Google AI, OpenRouter, and the Gemini and Google API key variables) and the Anthropic and Claude settings (`ANTHROPIC_`, `CLAUDE_`, `CLAUDECODE`). Codex and Muse Code also drop every `OPENAI_` variable. The shell drops the provider keys, `ANTHROPIC_` and `CLAUDE_CODE_`. Each CLI therefore uses its subscription login.

**Reason.** The CLI owns its credentials. A key left in a child's environment would bill per token instead of the subscription.

**Source.** `lib/accounts.mjs` (calls `openLoginTerminal`); `lib/platform/terminal.mjs` (`openLoginTerminal`); `lib/proc.mjs` (`childEnv`, the rules per command).

**Status.** Confirmed (code).

## 9. run_command uses cmd.exe on Windows and /bin/sh elsewhere

**Decision.** On Windows, `run_command` runs `cmd.exe` (`WINDOWS_SHELL = 'cmd'` in `lib/platform/index.mjs`). On macOS and Linux it runs `/bin/sh -c`. The PowerShell 5.1 shell is still built by `shellFor` when it is asked for with `windows: 'powershell'`, but it is not the default.

**Reason.** `cmd.exe` is the shell `run_command` used before the platform work, and it ships with every Windows install. The denylist and the `-EncodedCommand` check are written for PowerShell as well as cmd.

**Source.** `lib/platform/index.mjs` (`shellFor`, `WINDOWS_SHELL`); `lib/denylist.mjs` (`ENCODED_FLAGS`).

**Status.** Confirmed (code). Recorded as the code has it.

## 10. Gemini uses its own sign-in, and no provider key reaches it

**Decision.** Gemini runs through the Gemini CLI, signed in with a Google account. The Gemini child's environment drops the per-token provider keys (`XAI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENROUTER_API_KEY`), `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and the settings that switch Gemini to a key, Vertex AI or Code Assist (`GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_GCA`).

**Reason.** A key would bill per token and bypass the signed-in account.

**Source.** `lib/proc.mjs` (`childEnv`, gemini rule); `lib/gemini.mjs` (signed-in check).

**Status.** Confirmed (code).

## 11. A deb maintainer address must be set before release

**Decision.** `build.deb.maintainer` in `package.json` is a placeholder, `[LICENSOR NAME] <[CONTACT EMAIL]>` (it was `Plenum <plenum@example.com>` before 0.6), and it must be replaced with a real maintainer address before release.

**Reason.** A deb package carries a maintainer field, and a placeholder would ship in the package's metadata.

**Source.** `package.json`. The electron-builder Linux page could not be read this round.

**Status.** Placeholder confirmed. **Tentative** for the requirement itself (general Debian packaging convention).

## 12. Muse Code, Codex and Gemini take part in every multi-model role

**Decision.** Muse Code, Codex and Gemini take part in every multi-model role, in their read-only setting, because running them together is the purpose of the app. The residual risk is the Known limits entry in `README.md`.

**Reason.** Running them together is the purpose of the app. Their read-only settings do not stop them from reading files or running commands that only read.

**Source.** The owner's direction: running Muse Code, Codex and Gemini together is the point of Plenum. An earlier change that refused them in these roles was reverted. Code: `COUNCIL_PROVIDERS` in `lib/council.mjs`, and the seat checks in `lib/relay.mjs`, `lib/routes/compare.mjs` and `lib/pipelines.mjs`.

**Status.** Confirmed in the code on 2026-10-16.

## 13. The default council is the one in lib/council.mjs

**Decision.** With no council set, the council is `DEFAULT_COUNCIL` in `lib/council.mjs`: Claude Opus 5.5 as Architect, Muse Code Wonder Full as Skeptic and Codex as Engineer. Claude Fable 5.1 is the moderator. There are two rounds.

**Reason.** Each seat has a different role, so the seats are not three copies of one brief. Muse Code and Codex run in their read-only settings (item 12).

**Source.** `DEFAULT_COUNCIL` in `lib/council.mjs`, and the matching fallback in `public/app.js`.

**Status.** Confirmed in the code on 2026-10-16.

## 14. Claude settings load from user settings only by default

**Decision.** The Claude CLI's `settingSources` option defaults to `user`, so only your own global Claude settings load. Project and local settings files are read only when the project's tool options choose them.

**Reason.** Project and local Claude settings can auto-approve tools and run hooks that come from the repository, so loading them is a trust decision. The option's own help text says so.

**Source.** `lib/cli-options/claude.mjs` (`settingSources`, default `'user'`); `lib/claude-cli.mjs` (`--setting-sources` argument).

**Status.** Confirmed (code).

## 15. A blocked command card defaults to Deny, and auto-approve does not skip it

**Decision.** A command that the built-in deny list or a project pattern matches shows a card that says it is blocked. **Deny** is the primary, focused button, and Approve steps back. Auto-approve still shows that card.

**Reason.** A deny-list match is where the app is least sure a command is safe, so the safe answer is the default. A change of approval mode should not remove that check.

**Source.** `lib/denylist.mjs` (`checkCommand`, built-in rules); `lib/tools.mjs` (`denyListHit` with `defaultDeny: true`; `runTool` asks in auto mode when a command is blocked); `public/app.js` (the `defaultDeny` card, Deny focused); `lib/claude-cli.mjs` (`answer`, deny-list check before approval).

**Status.** Confirmed (code).

## 16. Plan mode refuses builds, restores and writes

**Decision.** A project in plan mode keeps its chat read-only: no tools, no edits, no commands, and each model in its read-only setting. A build (`/build`) and a checkpoint restore are refused with a plain message. Plan mode is saved with the project. A value that is not recognised reads as plan mode on.

**Reason.** Plan mode is a safety setting the person turns on for a project. It has to stop every path that changes files, not only chat turns. A value that cannot be read is treated as the read-only side, since that is the safe choice.

**Source.** `server.mjs` (`handleTurn`: no tool loop and `readOnly` when plan mode is on; the build refusal); `lib/routes/checkpoints.mjs` (restore refusal); `lib/projects.mjs` (`chatModeOf`).

**Status.** Confirmed (code).

## 17. The version is 0.5.0

**Decision.** `package.json` sets the version to 0.5.0, the release with the 20 usability improvements. The Windows installer is named `Plenum Setup 0.5.0.exe`. Version 0.4.0 was built without Muse Code, Codex and Gemini in the multi-model roles, and should not be used.

**Reason.** The installer name comes from the product name and version through electron-builder's default pattern, since no `artifactName` is set.

**Source.** `package.json` (`version`; no `artifactName` set); `node_modules/app-builder-lib/out/targets/nsis/nsisOptions.d.ts` (default `${productName} Setup ${version}.${ext}`).

**Status.** Confirmed (code).

## 18. The header's git status turns off repository-set programs

**Decision.** The git chip in the project header runs one fixed command, `git -c core.fsmonitor= status --porcelain=v2 --branch --untracked-files=normal`, in the project folder, with a trimmed environment (no keys, no `GIT_DIR`), `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`. It runs only for folders you added as projects.

**Reason.** A repository's own `.git/config` can name a program for `core.fsmonitor`, and git runs it on every `status`. The header asks every 30 seconds, so a folder unpacked from an archive with its `.git` folder could run code just by being opened. On git 2.55 a repository with that setting ran its program on a plain `git status`, and ran nothing with `-c core.fsmonitor=`. Clean and smudge filters set in the same config can still run when git re-reads a changed file. The CLIs in the seats run git in the same folder anyway, so adding a folder already means trusting it.

**Source.** `lib/git-status.mjs` (`GIT_ARGS`, `gitEnv`); `lib/routes/git.mjs` (5-second cache, one git process per project at a time).

**Status.** Confirmed (code and a local check on git 2.55).

## 19. The desktop window can be as narrow as 480 px

**Decision.** The window's minimum size is 480 × 480 (it was 900 × 600). Below 860 px the sidebar folds into a menu button at the top left.

**Reason.** At 175% scaling, a window snapped to half of a 1920 px screen is about 550 px wide, so the old minimum stopped people from putting Plenum beside an editor. The folded sidebar exists for exactly that width.

**Source.** `desktop/main.cjs` (`minWidth`, `minHeight`); `public/ext-sidebar.js` and `public/ext-sidebar.css` (`@media (max-width: 860px)`).

**Status.** Confirmed (code). Not yet seen in a running desktop window.

## 20. Spend limits count a running total per project, for API-key billing only

**Decision.** Each project keeps `spend: { usd, since }` in the state file. The cost of each reply billed through an API key is added once, when the reply is stored. `/clear`, `/compact`, Edit and Undo do not change it; **Reset spend** does. A project that had no total starts from its current chat's total. At the cap, chat messages, `/review` and `/compact` that would bill a key are refused, and the automatic advisor is skipped. Subscription CLIs are never refused or counted. Council, compare, pipeline, relay and build runs are not counted.

**Reason.** A cap that resets when the chat is cleared does not cap anything. The runs that are not counted have no cost worked out on the server, and guessing a price would make the cap wrong in both directions. The panel says which runs are left out.

**Source.** `lib/budget.mjs` (`spendOf`, `accrueReply`, `resetSpend`, `budgetState`); `server.mjs` (`runTurn` accrual, `refuseAtCap`, the advisor check); `lib/routes/budget.mjs`; `public/ext-budget.js`.

**Status.** Confirmed (code and tests). The refusal was checked against mock providers only.

## 21. Panels and routes are found by reading their folders

**Decision.** Every `lib/routes/*.mjs` loads as a route module and every `public/ext-*.js` loads as a panel, so a new feature needs no edit to a registry file. The panels listed in `public/ext.js` load first, in their fixed order; the rest load in name order.

**Reason.** Every improvement in this release added a route or a panel. With one registry file, they could not be built side by side. A Plenum update that adds a panel is labelled as a new panel in the Updates panel, since it loads on every page once applied.

**Source.** `lib/routes/index.mjs`; `lib/routes/ext-modules.mjs` (names must match `^ext-[a-z0-9-]{1,40}$`); `public/ext.js`; `lib/updates.mjs`.

**Status.** Confirmed (code and tests).

## 22. Plenum stays on Electron

**Decision.** Plenum keeps its Electron shell around the Node server and web page. It is not rebuilt on Tauri or as a native app per system. Asked on 2026-10-20 whether a ground-up build would be better; Opus and Fable judged it independently, and both recommended staying, with high confidence.

**Reason.** The planned browser that a model drives needs a scriptable Chromium. Electron ships one with the DevTools protocol (`webContents.debugger`) on Windows, macOS and Linux alike. Tauri uses each system's own engine; WKWebView and WebKitGTK have no such protocol, and its multi-webview API is marked unstable. Sandboxed views for artifacts are a documented Electron pattern. The server is already Node, which Electron runs as is; a Tauri sidecar would need it repackaged. A rewrite of about 30,000 lines would stop new work for months and does not touch what blocks a release: signing and running the app on macOS and Linux. The costs of Electron are size (114 MB installer) and memory (about 630 MB working set at idle, which overcounts shared pages); both can be trimmed. Electron is used by VS Code, Slack, Discord, Obsidian and Claude's desktop app.

**Sources.** Electron security tutorial and `webContents` docs (electronjs.org); Tauri webview versions, multiwebview API and Node sidecar guide (v2.tauri.app); WebKitGTK NVIDIA issues (v2.tauri.app/develop/debug/linux-graphics); Microsoft WebView2 CDP docs; Chromium memory-usage backgrounder; Better Stack's Tauri vs Electron comparison.

**Follow-ups.** Measure memory with `process.getProcessMemoryInfo()` (private and shared apart). Move applied Plenum updates out of the install folder into the user-data folder, so a signed bundle stays intact and the portable exe keeps them. Then turn on asar with integrity checks and set Electron fuses (no NODE_OPTIONS, no inspect arguments). Replace the fixed `X-Muse-Console: 1` header with a random token made at each launch, before any artifact or web page can run near the app. Never serve artifacts from the app's own origin. Lazy-load panels, limit `electronLanguages`, and keep Electron on a monthly patch schedule.

**Status of the follow-ups (0.6).** Done: the per-launch token (item 24); applied updates moved out of the install folder (item 27); the Electron fuses and `electronLanguages` set to en-US (item 28); the spellcheck download turned off (`webPreferences.spellcheck: false` in `desktop/main.cjs`). Still open: asar with integrity checks, lazy-loading panels, memory measurement, and the monthly Electron patch. Keeping artifacts off the app's origin comes with art-01, which is not built yet.

**Status.** Decided (Opus and Fable, with research). Some follow-ups are done; the status line above says which.

## 23. The source is public, and all rights are reserved

**Decision.** The code lives in the public repository https://github.com/RealAlcibiades/Plenum. Its licence is "all rights reserved" (`LICENSE.txt`): people may read the source, but may not copy, modify, redistribute or sell it without written permission. Using the app is governed by the end-user licence agreement shown before first use. Commits use the owner's GitHub noreply address.

**Reason.** The owner chose this on 2026-10-21. It keeps the option to charge for Plenum later, and it can be relaxed later, while code released under an open-source licence can never be taken back. The end-user licence already drafted assumes proprietary software. A public repository also lets releases and automatic updates be hosted in the same place.

**Source.** `LICENSE.txt`; the owner's answer in the build session; the legal drafts in the build notes.

**Status.** Decided. Every builder keeps `LICENSE.txt` as it is; the legal work adds the end-user licence and third-party notices beside it.

_Items 24 to 29 come from the 0.6 groundwork. Item 23 keeps its number (the licence decision above), so the groundwork's own numbers 23 to 28 are 24 to 29 here. Later feature docs take the next free numbers from 30._

## 24. Every API request carries a per-launch token

**Decision.** Every request to `/api/` must carry the header `x-plenum-token`, or the server answers 401 before any route runs. The token is 32 random bytes in hex, made at each start (`ensureToken` in `lib/auth.mjs`). The desktop app's main process makes it, hands it to the server over the channel that carries the keys (`lib/keys.mjs`), and gives it only to the app's own window, through the preload bridge (`desktop/preload.cjs`, answered only to the app's own frame). Started with plain Node, the server prints a link with the token in the URL fragment, which a browser never sends to the server; the page keeps it in session storage for that tab. A token given in `PLENUM_TOKEN` is read once and removed from the environment, so no child process inherits it. The token is not written to the state file, the logs or any child environment. Each POST must also come from the app's own origin, and that check runs before the token is looked at.

**Reason.** A fixed header such as `X-Muse-Console: 1` is not a secret: any program on the computer can send it. The owner's follow-up list asked for a random token made at each launch, before any artifact or web page can run near the app.

**Source.** `lib/auth.mjs`; `lib/keys.mjs` (`setToken` on the keys message); `desktop/preload.cjs`; `desktop/main.cjs` (`plenum:token`); `public/app.js` (`loadToken`, `request`); `server.mjs` (the `/api/` check); DECISIONS item 22, follow-ups.

**Status.** Built (groundwork gw-01). Not yet seen in a running desktop window; plain Node was checked by `server-start.test.mjs` in the 0.6 wave (a request with no token, or a wrong one, gets 401).

## 25. State and run events are pushed to every window over GET /api/events

**Decision.** `GET /api/events` keeps one server-sent stream open per window (`lib/events.mjs`). Each event has `type` and `at`. The types are `hello`, `state` (the state without messages), `run`, `approval`, `notice` and `agent`. The page reads the stream with `fetch`, not `EventSource`, and reconnects with a wait of 1 to 10 seconds between tries. Panels read events through `MuseUI.events`, and a route module publishes with `events.publish`.

**Reason.** Panels that polled the server could not show a change at once, and each poll was another request to answer. One stream per window sends each change once. `EventSource` cannot send a header, and every `/api/` request must carry the token.

**Source.** `lib/events.mjs` (the catalogue in its header); `server.mjs` (`GET /api/events`); `public/app.js` (`events`, `fanOut`, `request`); `desktop/sse.cjs` (the parser the desktop reads the stream with). Groundwork defaults in `GROUNDWORK.json`.

**Status.** Built (groundwork gw-01). The `agent` type is reserved for the delegation work; nothing publishes it yet.

## 26. Tools, prompt parts, desktop handlers, panes and settings sections are found in folders and registries, not in central files

**Decision.** A model tool is one file in `lib/tools/` (`NN-name.mjs`). A prompt part is one file in `lib/prompt-parts/`. A desktop handler is one file in `desktop/handlers/`. A side pane is registered with `MuseUI.pane.register`, and a settings section with `MuseUI.settings.register`. The engines (`lib/tools.mjs`, `lib/prompt.mjs`, `desktop/handler-loader.cjs`, `public/app.js`) apply the shared rules, and a feature does not edit them. Item 21 already did this for route modules and panels. The shapes are in README.md, under Extending Plenum.

**Reason.** Parallel features were colliding in the same files: the tool list, the prompt builder and `desktop/main.cjs`. With one file per feature, a feature adds files and changes no shared list.

**Source.** `lib/tools/10-files.mjs` (the entry shape, in its header); `lib/tools.mjs` (`loadTools`, `REGISTRY`, `runTool`); `lib/prompt.mjs` (`CONTEXTS`, `loadParts`); `lib/prompt-parts/10-core.mjs`; `desktop/handler-loader.cjs`; `desktop/main.cjs` (`loadHandlers`); `public/app.js` (`paneRegister`, `settingsRegister`).

**Status.** Built (groundwork gw-02 to gw-05).

## 27. Applied updates live in an overlay under the state folder, with atomic generations and automatic rollback

**Decision.** An applied update is a generation in `<state folder>/overlay/gen-<n>/`, and `overlay/manifest.json` names the active one. Applying writes the whole generation, checks it, and switches with one rename of the manifest. The last three generations are kept. `plenum.mjs` runs a bootstrap (`lib/overlay/register.cjs`) before any module loads, and a module hook (`lib/overlay/hooks.mjs`) serves the active generation's files in place of the shipped ones. A generation that does not start and become healthy is set aside on the next start, and the page says so. The install folder is never written. The loader (`plenum.mjs`, `lib/overlay.mjs`, `lib/overlay/`) and the token check (`lib/auth.mjs`) can never be updated from the app. Each generation records the Plenum version it was applied under.

**Reason.** The old update rewrote files in the install folder. That needed a writable install folder and changed files a signed or per-machine install should not change, and a bad update could leave Plenum unable to start with no way back. A complete generation switched by one rename is either the old version or the new one, never a mix. Fixes B-3 (a bundle that starts but cannot load, with no rollback; the import check now refuses a bundle that imports a file that is not there) and B-26 (a write failure during apply left a half-updated install; a failed apply now removes its half-made generation and changes nothing).

**Source.** `lib/overlay.mjs`; `lib/overlay/register.cjs` (its header); `lib/overlay/hooks.mjs`; `lib/updates.mjs` (`applyNow`, `checkImports`, `rollbackNow`, `ALLOWED`, `BLOCKED`); `plenum.mjs`. Groundwork defaults in `GROUNDWORK.json`.

**Status.** Built (groundwork gw-06). The rules are in `lib/updates.mjs`. The start of a packed app that has an applied generation was not checked in this wave.

## 28. The installer shows a licence page, installs to the per-user folder, ships English locales only, and the app has NODE_OPTIONS and inspect arguments fused off while RunAsNode stays on

**Decision.** `package.json` makes the Windows installer show the licence page (`nsis.license`, with `oneClick` false), install to the default per-user folder with no folder page (`allowToChangeInstallationDirectory` false), and copy `LICENSE.txt` to the top of the app folder (`extraFiles`). The author is `[LICENSOR NAME]` and `[CONTACT EMAIL]`, placeholders until the owner supplies the names; electron-builder takes the Windows company name from `author` (B-109). Electron keeps only `en-US` (`build.electronLanguages`). The Electron fuses (`build.electronFuses`) turn off `NODE_OPTIONS` (`enableNodeOptionsEnvironmentVariable`), the inspect arguments (`enableNodeCliInspectArguments`), the asar integrity and only-load-from-asar checks, and the V8 snapshot, and keep `runAsNode` and cookie encryption on. `grantFileProtocolExtraPrivileges` is left out, so Electron's default applies: nothing in this wave confirmed that the packed page still loads with that fuse off.

**Reason.** `NODE_OPTIONS` and the inspect arguments are two ways to run code or attach a debugger when the app starts. `runAsNode` stays on because the server checks updates by running `process.execPath --check` in node mode. Asar stays off until it is turned on with its checks (item 22). A user can no longer choose a folder, so an install outside the per-user folder cannot happen, and updates never write the install folder anyway (item 27). The other Electron locale files were unused.

**Source.** `package.json`; `node_modules/app-builder-lib/scheme.json` (`FuseOptionsV1`, `electronLanguages`, the licence options); `node_modules/app-builder-lib/out/platformPackager.js` (fuses set after packing); `node_modules/@electron/fuses` (the fuse wire, read back by `package.test.mjs`); `lib/updates.mjs` (`syntaxCheck`); `server.mjs` (`ELECTRON_RUN_AS_NODE` in the utility process).

**Status.** Built and checked in the 0.6 wave. `npm run pack` succeeded. The packed `Plenum.exe` reads back the fuses as set. The packed folder has `LICENSE.txt` at its top, `plenum.mjs` and `lib/overlay/` under `resources/app`, and only `en-US.pak`. The update syntax check runs under the exe in node mode. The exe's company name is `[LICENSOR NAME]`. Not checked: the installer's licence page and install folder on screen, and the packed app's window. INSTALLER_STATUS

## 29. Desktop alert and tray switches are set in the window

**Decision.** Settings, in the Desktop section, has four switches: Finished alerts, Approval alerts, Keep awake and Keep in tray on close. They are read and written through `GET` and `POST /api/desktop-settings` (`lib/routes/desktop-settings.mjs`), and they are the same keys in the state file (`finishedAlerts`, `approvalAlerts`, `keepAwake`, `trayOnClose`). A POST takes any of the four as a boolean, and any other value refuses the whole request. The desktop app reads the state file when it needs a value, so a change needs no restart.

**Reason.** The four switches were in the state file only, so a person had to know the key names to turn one off. The window is where a person looks for them.

**Source.** `lib/routes/desktop-settings.mjs`; `public/app.js` (`DESKTOP_SWITCHES` and the `desktop` settings section); `desktop/main.cjs` (reads the keys when it needs them).

**Status.** Built (groundwork). Not seen in a running desktop window.

## Open items

- The Muse Code install command for every system is not in the repository or the research. `lib/providers.mjs` shows a plain "not installed" sentence with no URL or command until the exact command is confirmed.
- The electron-builder and Apple notarisation pages were not read this round (see Sources).
- Runner architectures in item 6 need checking against GitHub's runner list.
