# Plenum Privacy Notice

Version 3 · Effective [EFFECTIVE DATE]

This notice explains what happens to your information when you use the Plenum desktop app. "We" means [LICENSOR NAME], the maker of Plenum.

## The short version

- **We collect nothing.** Plenum has no telemetry, analytics, crash reporting or ads, no account with us, and no server of ours. The installed app does check GitHub for new versions, by default every 4 hours. That request goes to GitHub, not to us, and carries nothing beyond what any web request shows. You can turn it off under Settings > Updates (see section 6). We do not sell or share personal information, because we never receive any.
- **Plenum keeps its data in folders on your computer.** It is yours to read, export or delete.
- **When you use an AI model, your message and the context it needs go straight from your computer to the provider you chose.** That provider handles it under its own privacy policy.
- **API keys are encrypted by your operating system.** Plenum sends each key only to the provider it belongs to.

## 1. What we receive

Nothing from the app. Plenum never sends us your messages, files, keys, settings, usage or any identifier. If you email us, we receive what you send and use it only to reply to you; we keep it no longer than needed for that, and at most a year. The website or store you downloaded Plenum from may collect data under its own policy.

## 2. What Plenum keeps on your computer

| What | Where | Notes |
|---|---|---|
| Projects (folder paths and names) and their settings; chat history, kept to the last 300 messages per project (your messages, model replies, tool steps, token and cost figures, and the names and sizes of files you attached); the chat kept for Undo; spend totals; your acceptance of these terms and your notice choices | `state.json`, with a `state.json.bak` copy, in Plenum's state folder: `%USERPROFILE%\.muse-console` on Windows, `~/.muse-console` on macOS and Linux, or the folder set in `MUSE_CONSOLE_HOME` | Plain JSON. **Not encrypted.** Attached files are not saved, only their names and sizes. When Claude runs through an API key, the tool results in its replies are saved, and those can include the contents of files it read. |
| Saved prompts and pipelines | `prompts.json` and `pipelines.json` in the state folder | Plain text |
| Checkpoints: copies of files from before Plenum, or Claude Code through Plenum, wrote to them | `checkpoints` in the state folder | Files over 5 MB are not kept; the oldest are removed past 200 MB per project |
| Changes to Plenum that a model proposed, and backups of Plenum's own files made before an update is applied | `outbox`, `applied`, `discarded`, `tmp` and `backups` in the state folder | |
| Provider tools you choose to install with the command shown in Accounts | `tools` in the state folder | Installed by you, not by Plenum |
| Computer-use run logs: every screenshot the model was shown, and the list of its actions, cards and pauses | `computer/runs` in the state folder: a folder for each run, with `run.json` and a `frame-NNNN.png` for each screenshot | Kept for 7 days and up to 200 MB by default (the settings `computerLogDays` and `computerLogMB` in `state.json` change this). Older runs are removed when the next run starts. Delete one run or all of them in the **Computer runs** drawer. **Not encrypted.** The screenshots show whatever was on your screen. The text the model typed is shortened and long runs of digits are masked; the text you type with Type it for me is not kept. |
| The in-app browser's profile: cookies, sign-ins, site storage, cache and history of the sites opened in the Browser pane | `Partitions/plenum-browser` in the desktop app's user-data folder (the one named for `keys.json` below) | Kept between runs of Plenum, so the sites you signed in to stay signed in. Clear it with **Clear browsing data** in the Browser pane's settings, or delete that folder while Plenum is closed. |
| Files downloaded in the Browser pane | The system Downloads folder, or a folder you choose in the pane | Saved only after you answer the question Plenum shows for each download. Until then the file waits in a private temporary folder, which is emptied if you cancel. Plenum never opens or runs a downloaded file, and never deletes one it saved. |
| API keys | `keys.json` in the desktop app's user-data folder: `%APPDATA%\Plenum`, `~/Library/Application Support/Plenum` or `~/.config/Plenum` | Encrypted by the operating system (see section 3) |
| Server log | `server.log` in the same user-data folder (desktop app only) | Start-up, status and error messages. It can include file paths, project names and error text from providers. It never includes keys. |
| Update bookkeeping and installers (desktop app only) | `update-state.json` and `updates` in the same user-data folder | Which versions were offered, installed or skipped. On Windows, `updates` holds the installer of the version that is running and the one waiting to be installed. The updater also keeps a downloaded installer in its own cache folder until it is installed. |
| Small display choices | The app window's local storage | For example, whether the setup wizard was closed |

The relay log (times, seat names, lengths and fingerprints of relayed replies, never their text) is kept in memory only while Plenum runs.

This data stays until you delete it. **Uninstalling Plenum does not delete it.** Delete these folders to remove it. The Browser pane can also clear its own profile, and the Computer runs drawer can delete run logs. Other programs running under your user account can read these files, so keep your computer and user account secure.

**Provider tools keep their own files.** Claude Code, Codex, Gemini CLI and Muse Code keep their own sign-ins, settings, session logs and, depending on their settings, copies of your conversations in their own folders (for example `~/.claude`, `~/.codex`, `~/.gemini` and `~/.config/muse`). Plenum never reads those sign-ins. In Native session mode, Claude Code and Codex keep the chat as a session of their own. Check each tool's own documentation.

## 3. API keys

- **Desktop app.** When you save a key, Plenum first sends one check request to that provider. For most providers that is a request for the model list; for an Anthropic key it is one very small model request, which the provider bills to that key. If the check passes, Plenum encrypts the key with your operating system: Windows data protection, the macOS Keychain, or the Linux secret service (GNOME Keyring or KDE Wallet). If Linux has no secret service, Plenum keeps keys in memory for that session only. A program running under your user account could ask the operating system to decrypt the file, so keep your account secure.
- Keys are sent only to their own provider's API address, over HTTPS, except that an `ANTHROPIC_BASE_URL` you set yourself sends your Anthropic key and your prompts to that address instead. Keys are never written to the state file or the log, never shown in the window after you save them, and never sent to us.
- **Run from the command line** (`node server.mjs`), Plenum reads keys from environment variables and does not save them.
- **On Windows**, Plenum looks for keys that older versions saved to your user environment and offers to move them into the encrypted store.
- `META_API_KEY`, if set on your computer, is passed to Muse Code.

## 4. Sign-ins to provider tools

Claude Code, Codex, Gemini CLI and Muse Code (and Cursor and Grok when they are added) sign in through their own windows. Plenum never sees your password and does not copy or store their sign-ins. To show whether you are signed in, Plenum asks the tool (`claude auth status`, `codex login status`) or checks that its sign-in file exists. It may show the account email and plan that the tool reports; for Gemini it reads the account email that the Gemini CLI caches in `google_accounts.json`, which holds no token. That information stays in the window.

## 5. What goes to AI providers

Plenum sends data to a provider only when you use a feature that needs a model, and only to the providers you choose. Depending on the feature, this can include:

- your message, and the recent chat (by default the chat so far is sent again with each message, up to the last 60 messages, or less when it is very long);
- instructions Plenum adds: the project folder's path, your operating system and shell, a partial list of the file names in the project, the project's AGENTS.md, and any extra instructions you set in Project settings;
- files you attach or mention, pictures and PDFs (for the models that take them), and file contents, search results and command output that the model reads through Plenum's tools;
- the reason you give when you deny an action;
- screenshots of your screen when you start a computer-use run, and page content and screenshots from the in-app browser when a model uses it. Plenum also keeps each computer-use screenshot on your computer, in the run log (section 2).

**Several providers at once.** Council, quick compare, pipelines, relay, the advisor and builds send this data to every provider taking part in the run.

**Provider tools act on their own.** When Plenum runs a provider's own tool (Claude Code, Codex, Gemini CLI or Muse Code), that tool also reads files, runs commands and talks to its provider by itself. It may also send its own usage data to its provider. Plenum does not control what these tools send. Check each tool's own settings.

**Providers' use of your data.** Providers handle what they receive under their own terms and privacy policies. Depending on your plan and settings, those may let them store it, review it for safety, or use it to improve their models. For example, Plenum's model list marks the Muse Code contributor model as one whose data is used to improve Meta's models; published reports say that tier lets Meta train on prompts and replies. Check each provider's data settings.

| Provider | Used for | Where your data goes |
|---|---|---|
| Anthropic | Claude Code; Anthropic API | Claude Code sends it itself; API: `api.anthropic.com` (or the `ANTHROPIC_BASE_URL` you set) |
| OpenAI | Codex; OpenAI API | Codex sends it itself; API: `api.openai.com` |
| Google | Gemini CLI; Google AI (Gemini API) | Gemini CLI sends it itself; API: `generativelanguage.googleapis.com` |
| Meta | Muse Code | Muse Code sends it itself |
| xAI | Grok API | `api.x.ai` |
| DeepSeek | DeepSeek API | `api.deepseek.com` |
| Mistral AI | Mistral API | `api.mistral.ai` |
| OpenRouter | Models from many providers | `openrouter.ai`, which passes the request on to the provider of the model you picked |

## 6. Other network requests

- Saving or testing a key sends one check request to that key's provider (section 3).
- Opening Accounts asks each installed tool for its sign-in status; a tool may contact its provider to answer.
- `/usage` may send one very small request through Muse Code or Claude, and may start Codex's app server to read your limits, which can contact OpenAI.
- The OpenRouter model list is fetched from OpenRouter with your key and kept in memory for ten minutes.
- The API finder reads public price lists with no key: those of OpenRouter, Vercel AI Gateway, DeepInfra and Martian and, for a model you pick, the providers OpenRouter routes it to. It asks only while its panel is open and keeps each list in memory for ten minutes. Those requests carry nothing about you beyond what any web request shows, such as your IP address.
- **Update checks.** In the installed app, unless you turn them off under Settings > Updates, Plenum asks GitHub (where Plenum's releases are published) for the list of releases and the small file that describes the newest one. It does this about 20 seconds after it starts and then every 4 hours, and not before you have accepted the License Agreement. These requests carry nothing about you beyond what any web request shows, such as your IP address, and GitHub handles them under its own privacy statement. If a newer version is out and your build can install itself (the Windows installer, a signed macOS build or a Linux AppImage), Plenum downloads the installer from GitHub. It installs it only when you choose Restart to update or when you quit Plenum, and it never restarts by itself. Other builds show the new version and a link to its release page. With checks off, Plenum fetches and installs nothing. Runs from the command line or from source make no update checks.
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

Plenum's local server listens only on your own computer (127.0.0.1) and answers only requests from Plenum's own page. Chat history, settings and computer-use run logs are stored without encryption. Anyone or anything that can use your computer account can read them. Commands and provider tools that a model runs get your user rights and your environment variables, except the keys Plenum removes, so secrets in your environment are visible to them.

## 11. Changes to this notice

The version and effective date are at the top. When this notice changes in a way that matters, Plenum shows the new version and asks you to review it before you continue.

## 12. Contact

[LICENSOR NAME] · [CONTACT EMAIL]
