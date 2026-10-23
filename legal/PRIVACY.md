# Plenum Privacy Notice

Version 4 · Effective [EFFECTIVE DATE]

This notice explains what happens to your information when you use the Plenum desktop app. "We" means [LICENSOR NAME], the maker of Plenum.

## The short version

- **We collect nothing.** Plenum has no telemetry, analytics, crash reporting or ads, no account with us, and no server of ours. The desktop app checks GitHub for new versions unless you turn that off; that request goes to GitHub, not to us. By default it is made every 4 hours, and it carries your IP address, your Plenum version, operating system and architecture, and a random rollout ID. You can turn it off under Settings > Updates (see section 6). We do not sell or share personal information, because we never receive any.
- **Plenum keeps its data in folders on your computer.** That includes your chat history and copies of your project's files taken around each chat turn, so that Rewind can put them back. It is yours to read, export or delete.
- **When you use an AI model, your message and the context it needs go straight from your computer to the provider you chose.** That provider handles it under its own privacy policy.
- **API keys are encrypted by your operating system.** Plenum sends each key only to the provider it belongs to.

## 1. What we receive

Nothing from the app. Update checks go to GitHub, not to us (section 6). Plenum never sends us your messages, files, keys, settings, usage or any identifier. If you email us, we receive what you send and use it only to reply to you; we keep it no longer than needed for that, and at most a year. The website or store you downloaded Plenum from may collect data under its own policy.

## 2. What Plenum keeps on your computer

| What | Where | Notes |
|---|---|---|
| Projects (folder paths and names) and their settings; chat history, kept to the last 300 messages per project (your messages, model replies, tool steps, token and cost figures, and the names and sizes of files you attached); the chat kept for Undo; spend totals; your acceptance of these terms and your notice choices | `state.json`, with a `state.json.bak` copy, in Plenum's state folder: `%USERPROFILE%\.muse-console` on Windows, `~/.muse-console` on macOS and Linux, or the folder set in `MUSE_CONSOLE_HOME` | Plain JSON. **Not encrypted.** Attached files are not saved, only their names and sizes. When Claude runs through an API key, the tool results in its replies are saved, and those can include the contents of files it read. |
| Saved prompts and pipelines | `prompts.json` and `pipelines.json` in the state folder | Plain text |
| Checkpoints: copies of files from before Plenum, or Claude Code through Plenum, wrote to them | `checkpoints` in the state folder | Files over 5 MB are not kept; the oldest are removed past 200 MB per project |
| Turn snapshots: copies of your project's files taken before and after each chat turn and each build, so that Rewind can put the files back, whichever program wrote them (Plenum, Claude Code, Codex, Gemini CLI, Cursor, Grok Build, Muse Code or a shell command). The turn records in `state.json` hold each snapshot's id, the paths of up to 50 files that the turn changed and, after a code rewind, the id of the snapshot taken just before it | `shadow` in the state folder: one private git repository for each project folder, in a folder with a short code for its name, whose `folder.txt` says which project folder it holds | Plain git objects. **Not encrypted.** A snapshot holds every file in the folder except: the folders `.git`, `node_modules`, `.venv`, `venv`, `__pycache__` and `.next`; files that your `.gitignore` files list; files over 5 MB; and links that lead outside the project folder, into a credential folder, into Plenum's own folders or into a `.git` folder. **Files whose names mark them as holding secrets are left out, whatever `.gitignore` says: `.env` files (but not `.env.example`, `.env.sample` or `.env.template`), private keys and certificates (such as `.pem`, `.key`, `.p12` and `id_rsa`), key stores (`.jks`, `.keystore`, `.kdbx`), and files such as `.npmrc`, `.netrc`, `credentials.json` and `.tfstate`. Rewind does not restore them. A secret kept in a file with any other name is still copied.** A folder with more than 20,000 files, or more than 1 GB of files to keep, is not snapshotted, and the chat says so. The newest 100 snapshots of each project are kept (a chat turn makes two). Plenum removes older ones after a turn, and git frees their disk space in the background after 20 removals or a day. Snapshots stay on your computer: their contents reach a model only as a list of changes that a feature you use puts in a message, such as `@diff` or `@checkpoint`. Forgetting a project or clearing its chat does not remove them. Delete the `shadow` folder, or only the folder in it whose `folder.txt` names your project, to remove them; Rewind then has nothing to go back to. Undo code rewind uses the id kept in `state.json`, which it removes when it finishes. |
| The output of your check command, kept on the reply that was checked (its last 8,000 characters) with the command, its result and its time; and the records of the tool test for API models | `state.json`: in the chat history for check output, and under `toolTrust` for tool-test records | Plain JSON. **Not encrypted.** Check output is whatever your command printed, so it can include file contents, paths and secrets. It stays with its reply and is removed with it. A tool-test record holds the model's name as its provider reported it, the date, whether each step passed with a fixed sentence about it, the token count and cost, and whether tools are allowed for that model. It holds no key, prompt or file content. Turning **Allow tools** off keeps the record. Delete the `toolTrust` entry in `state.json` while Plenum is closed, or delete `state.json`, to remove it. |
| Threads: the other chats of a project, kept like its first chat; and a dated copy of the state file from before threads, made once, the first time a version with threads starts | `state.json`, and `state.json.pre-threads-<date>` in the state folder | Plain JSON. **Not encrypted.** A closed thread is kept with its chat until you delete it. Plenum never removes the dated copy; delete it when you no longer need to open the same state file with an earlier version. |
| Isolated copies of a project (git worktrees), for a thread you start with **Work in an isolated copy** | `%LOCALAPPDATA%PlenumWT` on Windows, `~/.plenum-wt` on macOS and Linux: one folder with a short code for its name for each copy, on a branch `plenum/<name>-<code>` of the project's own repository | A checkout of the project's tracked files, up to 20 files of up to 1 MB each that you choose to copy in (which can include files such as `.env`), the output of the setup command you set, and whatever the thread's agent writes there. **Not encrypted.** **Keep** commits the copy's changes on its branch and removes the folder; **Discard** removes the folder and keeps the branch unless you choose to delete it. Removing a project does not remove its copies. Delete a folder there, or the branch with git, to remove them. |
| Changes to Plenum that a model proposed, and the applied updates kept as generations so you can roll back | `outbox`, `applied`, `discarded` and `tmp` in the state folder, and `overlay` for the applied generations | The last three generations are kept. The Updates panel removes them with **Remove all applied updates**. When Plenum itself updates to a new version, the generation in use is set aside, not deleted, until you remove it. |
| Provider tools you choose to install with the command shown in Accounts | `tools` in the state folder | Installed by you, not by Plenum |
| Computer-use run logs: every screenshot the model was shown, and the list of its actions, cards and pauses | `computer/runs` in the state folder: a folder for each run, with `run.json` and a `frame-NNNN.png` for each screenshot | Kept for 7 days and up to 200 MB by default (the settings `computerLogDays` and `computerLogMB` in `state.json` change this). Older runs are removed when the next run starts. Delete one run or all of them in the **Computer runs** drawer. **Not encrypted.** The screenshots show whatever was on your screen. The text the model typed is shortened and long runs of digits are masked; the text you type with Type it for me is not kept. |
| The in-app browser's profile: cookies, sign-ins, site storage, cache and history of the sites opened in the Browser pane | `Partitions/plenum-browser` in the desktop app's user-data folder (the one named for `keys.json` below) | Kept between runs of Plenum, so the sites you signed in to stay signed in. Clear it with **Clear browsing data** in the Browser pane's settings, or delete that folder while Plenum is closed. |
| Files downloaded in the Browser pane | The system Downloads folder, or a folder you choose in the pane | Saved only after you answer the question Plenum shows for each download. Until then the file waits in a private temporary folder, which is emptied if you cancel. Plenum never opens or runs a downloaded file, and never deletes one it saved. |
| API keys | `keys.json` in the desktop app's user-data folder: `%APPDATA%\Plenum`, `~/Library/Application Support/Plenum` or `~/.config/Plenum` | Encrypted by the operating system (see section 3) |
| Server log | `server.log` in the same user-data folder (desktop app only) | Start-up, status and error messages. It can include file paths, project names and error text from providers. It never includes keys. |
| A random rollout ID (desktop app only) | `.updaterId` in the desktop app's user-data folder (`%APPDATA%\Plenum` on Windows, `~/Library/Application Support/Plenum` on macOS, `~/.config/Plenum` on Linux) | Sent with each update check so a release can reach a share of installs first. It identifies the install, not you. We never receive it. Delete the file to remove it; the next check makes a new one. |
| Update bookkeeping and installers (desktop app only) | `update-state.json` and `updates` in the same user-data folder | Which versions were offered, installed or skipped. On Windows, `updates` holds the installer of the version that is running, kept so a version that does not start can be put back, and the one waiting to be installed. The updater also keeps a downloaded installer in its own cache folder, `muse-console-updater` under your local app-data folder (`%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, `~/.cache` on Linux), until it is installed. Delete these folders to remove them. |
| Small display choices | The app window's local storage | For example, whether the setup wizard was closed |
| Short-lived working files: the prompt that Muse Code reads from a file, attached pictures that Codex and Gemini CLI read as files, empty folders for read-only runs, the tool test's sample folder, and the start file of the Plenum bridge (section 5) | Your system's temporary folder | Plenum removes each one when its run or message ends. After an abrupt stop one can stay until you delete it. Bridge folders (`plenum-mcp-` and six characters) older than 12 hours are removed the next time a bridge opens. |

The relay log (times, seat names, lengths and fingerprints of relayed replies, never their text) is kept in memory only while Plenum runs.

This data stays until you delete it. **Uninstalling Plenum does not delete it.** Delete these folders to remove it. The Browser pane can also clear its own profile, and the Computer runs drawer can delete run logs. Other programs running under your user account can read these files, so keep your computer and user account secure.

**Provider tools keep their own files.** Claude Code, Codex, Gemini CLI, Cursor, Grok Build and Muse Code keep their own sign-ins, settings, session logs and, depending on their settings, copies of your conversations in their own folders (for example `~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`, `~/.grok` and `~/.config/muse`). Plenum never reads those sign-ins. In Native session mode, Claude Code and Codex keep the chat as a session of their own. Check each tool's own documentation.

## 3. API keys

- **Desktop app.** When you save a key, Plenum first sends one check request to that provider. For most providers that is a request for the model list; for an Anthropic key it is one very small model request, which the provider bills to that key. If the check passes, Plenum encrypts the key with your operating system: Windows data protection, the macOS Keychain, or the Linux secret service (GNOME Keyring or KDE Wallet). If Linux has no secret service, Plenum keeps keys in memory for that session only. A program running under your user account could ask the operating system to decrypt the file, so keep your account secure.
- Keys are sent only to their own provider's API address, over HTTPS, except that an `ANTHROPIC_BASE_URL` you set yourself sends your Anthropic key and your prompts to that address instead. Keys are never written to the state file or the log, never shown in the window after you save them, and never sent to us.
- **Run from the command line** (`node server.mjs`), Plenum reads keys from environment variables and does not save them.
- **On Windows**, Plenum looks for keys that older versions saved to your user environment and offers to move them into the encrypted store.
- `META_API_KEY`, if set on your computer, is passed to Muse Code.
- Plenum does not use a Cursor API key. It removes `CURSOR_API_KEY` and every other `CURSOR_` setting from the environment it gives Cursor's program, so a run uses your Cursor sign-in (section 4) and never a key from your environment.
- Plenum does not give Grok Build an xAI key. It removes every `XAI_` and `GROK_` setting from the environment it gives Grok Build's program, so a run uses your Grok Build sign-in (section 4). An xAI key you save is used only for Grok models through the xAI API.

## 4. Sign-ins to provider tools

Claude Code, Codex, Gemini CLI, Cursor, Grok Build and Muse Code sign in through their own windows. For Cursor and Grok Build, Plenum opens a terminal window that runs the program's own `login` command, which opens your browser for its sign-in. Plenum never sees your password and does not copy or store their sign-ins. To show whether you are signed in, Plenum asks the tool (`claude auth status`, `codex login status`, and for Cursor `agent status`, which reaches Cursor's service) or checks that its sign-in file exists (for Grok Build, Plenum reads only the names of the files in `~/.grok`, never their contents). It may show the account email and plan that the tool reports; for Gemini it reads the account email that the Gemini CLI caches in `google_accounts.json`, which holds no token. That information stays in the window.

## 5. What goes to AI providers

Plenum sends data to a provider only when you use a feature that needs a model, and only to the providers you choose. Depending on the feature, this can include:

- your message, and the recent chat (by default the chat so far is sent again with each message, up to the last 60 messages, or less when it is very long);
- instructions Plenum adds: the project folder's path, your operating system and shell, a partial list of the file names in the project, the project's AGENTS.md, and any extra instructions you set in Project settings;
- files you attach or mention, pictures (for the models that take them), PDFs (Claude through an API key gets the PDF itself; every other model gets only the text that Plenum reads out of it on your computer, up to 100 pages), and file contents, search results and command output that the model reads through Plenum's tools;
- the changes in your folder or in your last turn, when you put `@diff` or `@checkpoint` in a message, and the output of your check command (the end of it, up to 12,000 characters), when you put `@checks` in a message, press **Send failures** or turn on auto-fix;
- the reason you give when you deny an action;
- screenshots of your screen, or of the one window you chose, when you start a computer-use run, and page content and screenshots from the in-app browser when a model uses it. They go to the provider of the model that drives the run: Anthropic for Claude; OpenAI or Google for the models that have a computer-use tool of their own; the provider of any other API model that takes pictures. When Claude Code, Codex, Gemini CLI, Cursor or Grok Build drives it through the Plenum bridge (below), they go to that tool's provider. Plenum also keeps each computer-use screenshot on your computer, in the run log (section 2).

**Several providers at once.** Council, quick compare, pipelines, relay, the advisor and builds send this data to every provider taking part in the run. An agent, whether you or a model start it, runs on the model its type uses, which can belong to another provider than your chat, and sends that provider its task and what it reads and runs.

**Provider tools act on their own.** When Plenum runs a provider's own tool (Claude Code, Codex, Gemini CLI, Cursor, Grok Build or Muse Code), that tool also reads files, runs commands and talks to its provider by itself. It may also send its own usage data to its provider. Plenum does not control what these tools send. Check each tool's own settings. Plenum gives Cursor's and Grok Build's programs the whole prompt over their standard input and output. In their print modes, which you turn on with `MUSE_CONSOLE_CURSOR_TRANSPORT=print` or `MUSE_CONSOLE_GROK_TRANSPORT=print`, the prompt is instead part of the program's command line, which other programs under your account can read while it runs.

**The Plenum bridge.** Claude Code, Codex, Gemini CLI, Cursor and Grok Build (on its default transport, not in print mode) can use Plenum's browser pane, a computer-use run that you started and Plenum's agents. For each chat message Plenum starts a small program for the tool on your computer. It reaches Plenum only over your own computer (127.0.0.1), with a secret made for that message alone. Plenum puts that secret in a private temporary file, and the program deletes the file as soon as it has read it. Each call runs through Plenum's approval cards, site list, limits and Stop. Plenum gives the tool no API key and no sign-in. What a call returns, such as page text or a screenshot, goes to the tool, which sends it to its own provider like anything else it reads. Muse Code, read-only seats, council seats and plan mode get no bridge.

**Providers' use of your data.** Providers handle what they receive under their own terms and privacy policies. Depending on your plan and settings, those may let them store it, review it for safety, or use it to improve their models. For example, Plenum's model list marks the Muse Code contributor model as one whose data is used to improve Meta's models; published reports say that tier lets Meta train on prompts and replies. Check each provider's data settings.

| Provider | Used for | Where your data goes |
|---|---|---|
| Anthropic | Claude Code; Anthropic API | Claude Code sends it itself; API: `api.anthropic.com` (or the `ANTHROPIC_BASE_URL` you set) |
| OpenAI | Codex; OpenAI API | Codex sends it itself; API: `api.openai.com` |
| Google | Gemini CLI; Google AI (Gemini API) | Gemini CLI sends it itself; API: `generativelanguage.googleapis.com` |
| Meta | Muse Code | Muse Code sends it itself |
| Cursor | Cursor CLI | Cursor's program sends it itself |
| xAI | Grok Build; Grok API | Grok Build's program sends it itself; API: `api.x.ai` |
| DeepSeek | DeepSeek API | `api.deepseek.com` |
| Mistral AI | Mistral API | `api.mistral.ai` |
| OpenRouter | Models from many providers | `openrouter.ai`, which passes the request on to the provider of the model you picked |

## 6. Other network requests

- Saving or testing a key sends one check request to that key's provider (section 3). **Check tool calls** on the xAI card sends one small request with your xAI key to `api.x.ai`, which xAI bills like any other request.
- Opening Accounts asks each installed tool for its sign-in status; a tool may contact its provider to answer.
- `/usage` may send one very small request through Muse Code or Claude, and may start Codex's app server to read your limits, which can contact OpenAI. The plan-use meter in the model picker reads Codex's limits the same way, about every 10 minutes while the window is showing, and a refresh that you ask for can send one very small request through Muse Code or Claude Code, at most once an hour.
- Running the tool test on an API model sends it a series of small requests, about 15,000 tokens in all, through that model's key. It reads no project: it works in a temporary folder that Plenum deletes afterwards.
- A page in the Artifacts pane runs apart from Plenum, without access to your files, your keys or the network. If you turn on **Allow web access** for a page, it can load scripts from and send requests to any https site, with whatever the page holds.
- The OpenRouter model list is fetched from OpenRouter with your key and kept in memory for ten minutes.
- The API finder reads public price lists with no key: those of OpenRouter, Vercel AI Gateway, DeepInfra and Martian and, for a model you pick, the providers OpenRouter routes it to. It asks only while its panel is open and keeps each list in memory for ten minutes. Those requests carry nothing about you beyond what any web request shows, such as your IP address.
- **Update check.** At start and every four hours, the desktop app asks GitHub (`github.com` and its download host) whether a newer Plenum is published. The first check comes about 20 seconds after start, and none happens before you have accepted the License Agreement. The request carries your IP address, your Plenum version, operating system and architecture, and the random rollout ID. If this build can install updates itself (the Windows installer, a signed macOS build or a Linux AppImage), the app downloads the new version in the background and installs it only when you choose Restart to update or when you quit Plenum; it never restarts by itself. Other builds show the new version and a link to its release page. GitHub handles these requests under its own privacy statement and shows us only how many times each file was downloaded. Turn the check off in Settings > Updates. Plenum then makes no update request and installs nothing by itself, and you update by downloading a new version yourself. Runs from the command line or from source make no update checks.
- Links you click open in your own web browser.
- The in-app browser loads the sites that you or a model open. Those sites see what any browser visit shows them.
- Plenum turns off the online spell-check dictionary download that Electron would otherwise make on Linux.

Plenum makes no other network requests of its own.

## 7. Notifications

Desktop notifications show only the project name and a short status. They never include a prompt or a reply.

## 8. Your choices

You control Plenum's data. You can read it, export a chat from **Chat history**, or delete the folders listed in section 2. We hold no data about you, so there is nothing for us to access, correct or delete. Send requests about data a provider holds to that provider. If you use Plenum for an organization, your organization decides how the data is used and is responsible for it.

## 9. Children

Plenum is not meant for children. You must be 18 or older to use it. We do not knowingly collect information from anyone, including children.

## 10. Security

Plenum's local server listens only on your own computer (127.0.0.1) and answers only requests from Plenum's own page. Chat history, settings, check output, turn snapshots and computer-use run logs are stored without encryption. Anyone or anything that can use your computer account can read them. Commands and provider tools that a model runs get your user rights and your environment variables, except the keys Plenum removes, so secrets in your environment are visible to them. The check command you set for a project runs the same way after a turn that changed files.

## 11. Changes to this notice

The version and effective date are at the top. When this notice changes in a way that matters, Plenum shows the new version and asks you to review it before you continue.

## 12. Contact

[LICENSOR NAME] · [CONTACT EMAIL]
