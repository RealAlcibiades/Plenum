// The danger notices: one entry for each risk that Plenum explains once, where the risk starts. A notice explains; it never replaces,
// weakens or skips a safety control (approval cards, the Deny-first card, checkAccess, plan mode and the floor work the same whatever
// a person chooses here). The page draws them (public/ext-notices.js: MuseUI.risk for a dialog, MuseUI.notice for a strip); this file
// is the one place that holds their words and what each person has hidden. It cannot be changed by an applied update (lib/updates.mjs).
//
// An entry is { id, rev, kind, status, feature, where, title, text, unguarded?, action?, tone, aliases? }:
//   kind     'confirm' is a dialog that asks (Cancel focused); 'inline' is a strip that never blocks the action under it. UI-ARCH 7 and
//            10.7: only Approve all and Apply update ask in a dialog, so those two are 'confirm' and every other notice is a strip.
//   status   'live' once the feature is in the app; 'planned' for a notice that is registered before its feature ships. A feature that
//            ships flips its notice to 'live' in the same change.
//   unguarded  words added to text on a system where Plenum cannot check for a password field (every platform but Windows, see
//            hasPasswordGuard in lib/computer/policy.mjs, which this file does not import). noticeState adds them and drops the field.
//   action   the label of the dialog's action button (confirm notices only).
//   tone     'info', 'warn' or 'danger': the colour of the strip's edge and of the dialog's action.
//   aliases  other ids that name the same notice (the page may call risk('apply-update')); hide and show accept them.
// `rev` goes up when the words change in a way people should see again: a hidden notice with an older rev shows once more and the Legal
// page marks it Updated. Title is at most 60 characters and text at most 450.
//
// What is stored: st.notices[id] = { rev, at } for a notice the person chose "Don't show again" on. Nothing else is kept; "once per launch"
// is the page's own memory.
//
// Exports: NOTICES, noticeState, hideNotice, showNotice, showAllNotices, findNotice.

const notice = fields => Object.freeze({ rev: 1, kind: 'inline', status: 'live', tone: 'warn', ...fields });

export const NOTICES = Object.freeze([
  notice({
    id: 'auto-approve',
    feature: 'Auto-approve',
    where: 'Above the message box when the approval mode changes from Ask first to Auto-approve: the Mode menu, /approvals auto and Project settings.',
    title: 'Auto-approve runs changes without asking',
    text: 'Edits, new files and commands from the model will run without a card, with your user rights. They can change or delete files, including outside the project. Credential and system folders stay blocked, and blocked commands still ask. Use it in a folder you have backed up or committed to git.',
  }),
  notice({
    id: 'approve-all',
    kind: 'confirm',
    tone: 'danger',
    feature: 'Approve all',
    where: 'A dialog before Approve all turns on: the Mode menu, /approvals all and Project settings. After Don\'t show again it is one click; the red button and the line above the message box stay as the reminders.',
    title: 'Approve all answers every card for you',
    text: 'Edits and commands run at once, inside and outside the project. Gemini runs in its yolo mode and Muse Code with its own prompts off, so Plenum cannot check what they run. Credential folders, system folders and Plenum\'s own source stay off limits, and a command that a built-in rule blocks still shows its card. You are responsible for everything that runs while it is on.',
    action: 'Turn on Approve all',
  }),
  notice({
    id: 'approve-all-covers',
    feature: 'Approve all for computer use and the browser',
    where: 'Beside the switch that lets Approve all answer computer-use and browser cards, in Project settings and in the app settings.',
    title: 'Approve all also answers computer-use and browser cards',
    text: 'Approve all also answers the computer-use and browser cards: sending, buying, deleting, signing in and new apps or sites go ahead without asking. The model still never types passwords, and Stop or Ctrl+Alt+Esc ends its control at once.',
  }),
  notice({
    id: 'approve-all-blocked',
    tone: 'danger',
    feature: 'Approve all for blocked commands',
    where: 'Beside the switch "Approve all also answers blocked-command cards" in Project settings.',
    title: 'Approve all also runs blocked commands',
    text: 'With this on, Approve all also runs the commands Plenum\'s rules block: wiping a drive or the project, format, diskpart, reg delete, shutdown, force-push, piped installs. Nothing stops them but you. Credential folders and Plenum\'s own files stay off limits.',
  }),
  notice({
    id: 'cli-no-ask',
    feature: 'Agents that cannot ask first',
    where: 'A strip above the message box when Gemini\'s approval mode is set to Auto-approve edits (before it is saved), when a Codex or Gemini coder that cannot ask starts, and while Approve all is on and Gemini or Muse Code is the model or a coder.',
    title: 'Some agents will act without asking',
    text: 'With this setting, Gemini changes files without asking, and Codex and Gemini coders edit on their own. In Approve all, Gemini and Muse Code also run commands without asking. Plenum cannot see or stop those steps: its approval cards, blocked-command rules and checkpoints do not cover them. Their own settings files still apply. Commit your work first.',
  }),
  notice({
    id: 'untrusted-commands',
    feature: 'Running untrusted commands and folders',
    where: 'Inside the first approval card for a command in a launch (run_command, or a Bash or PowerShell request from Claude Code), above Approve and Deny; and in the Add folder form when it opens.',
    title: 'Only run commands you trust',
    text: 'A command runs on your computer with your user rights and your environment, as if you had typed it. A model can be tricked by text in a file, web page or tool output into proposing a harmful one, and a downloaded project can carry settings and scripts that its tools run. Read each command before you approve it, and add only folders you trust.',
  }),
  notice({
    id: 'delegation',
    feature: 'Delegation with editing agents',
    where: 'A strip above Run on a /build plan, and the first time in a launch that the chat\'s delegate tool starts a coder.',
    title: 'Coders will edit files on their own',
    text: 'Each coder changes files in the project by itself, and several may work at once. Codex, Gemini and Muse Code write without Plenum\'s cards or checkpoints. The reviewer reads the result but can miss problems. Commit your work first, and check the changes before you keep them.',
  }),
  notice({
    id: 'api-keys-spend',
    tone: 'info',
    feature: 'API keys and spend',
    where: 'A strip above the key rows in Accounts › Model providers (per token), and in step 3 (Add API keys) of the setup wizard.',
    title: 'API keys bill your account',
    text: 'Every request made with your key is charged to your provider account. That includes council seats, reviews, retries, long agent runs and the one small request that checks a key when you save it. Plenum\'s cost figures come from published prices and can be wrong, and its spend limit does not cover every kind of run. Your provider\'s bill is the real cost. Set a spending limit with each provider, and never share your keys.',
  }),
  notice({
    id: 'provider-terms',
    tone: 'info',
    feature: 'Provider sign-in and provider terms',
    where: 'A strip above a Sign in button, in Accounts and in step 2 of the setup wizard. It covers Claude Code, Codex, Gemini CLI and Muse Code, and later Cursor and Grok Build.',
    title: 'Your provider\'s terms apply',
    text: 'You sign in with the provider\'s own tool, and the sign-in stays with that tool, not with Plenum. Each provider sets its own rules on using its subscription through other apps, and some restrict it; Anthropic and Google publish such rules, linked under Legal › Third parties. Read your provider\'s terms before you use it with Plenum. An API key is the route most providers document for apps like this one.',
  }),
  notice({
    id: 'multi-provider',
    tone: 'info',
    feature: 'Several providers at once',
    where: 'A strip above the council board the first time Council is chosen in a launch, and at the top of the Quick compare, Pipelines and Relay panels.',
    title: 'Your message goes to several companies',
    text: 'Council, quick compare, pipelines and relay send your message, and the other seats\' replies, to every provider in the run. Each provider keeps and uses it under its own terms and bills you for it. Leave out secrets and anything you are not allowed to share.',
  }),
  notice({
    id: 'self-update',
    kind: 'confirm',
    feature: 'Plenum changes its own code',
    where: 'A dialog when Apply and restart is pressed in the Updates panel, before anything is written.',
    title: 'This changes Plenum\'s own code',
    text: 'These files were written by a model, not by Plenum\'s developer. Applying them changes how Plenum itself runs, and they can change how it protects you, including approvals and blocked folders. Read every file before you apply. Plenum keeps the files it came with and goes back to the version before if the update does not start.',
    action: 'Apply and restart',
    aliases: Object.freeze(['apply-update']),
  }),
  notice({
    id: 'browser-agent',
    feature: 'A model uses the browser',
    where: 'The top of the Browser pane, the first time it opens with model control on.',
    title: 'A model can use this browser for you',
    text: 'A model can use this browser for you: open pages, click, type and send forms as you, on any site you are signed in to here. It asks before new sites and before anything that buys, sends, signs in or deletes. Watch the pane while it drives.',
  }),
  notice({
    id: 'browser-any-site',
    feature: 'Browser: any site without asking',
    where: 'Under the "Any site without asking" switch in the Browser pane when it is turned on.',
    title: 'Any site without asking',
    text: 'Any site: the model opens pages without asking, as you, on every site you are signed in to here. Keep this off unless you are watching the pane.',
  }),
  notice({
    id: 'browser-check-off',
    feature: 'Browser: a check switched off',
    where: 'Under the Checks in the Browser pane when one of them is switched off.',
    title: 'A browser check is switched off',
    text: 'Without this check the model will do this on the page by itself when it thinks the task needs it. Every action is still listed under Actions, and Stop ends the run.',
  }),
  notice({
    id: 'browser-screenshot',
    tone: 'info',
    feature: 'Browser: screenshots',
    where: 'In the Browser pane header when the model takes its first screenshot, and as a note under the page size.',
    title: 'Screenshots go to the model\'s provider',
    text: 'Screenshots of this browser go to the model\'s provider. Close tabs it should not see.',
  }),
  notice({
    id: 'browser-download',
    feature: 'Browser: downloads',
    where: 'In the Browser pane\'s "Save <name> to Downloads?" question, under the Save and Cancel buttons.',
    title: 'Downloaded files are untrusted',
    text: 'A downloaded file is untrusted until you have looked at it. Plenum saves it and never opens or runs it; open it yourself when you are sure.',
  }),
  notice({
    id: 'browser-permission',
    feature: 'Browser: site permissions',
    where: 'In the Browser pane\'s Allow / Deny question for a camera, microphone, location, notifications or clipboard request.',
    title: 'A site asks for a permission',
    text: 'This site asks for a permission. Allow it only for sites you trust; a model driving the browser never gets it.',
  }),
  notice({
    id: 'computer-use',
    status: 'planned',
    tone: 'danger',
    feature: 'Computer use',
    where: 'A strip in the computer-use drawer, above Start. Pressing Start is the consent.',
    title: 'A model will control your mouse and keyboard',
    text: 'It sees your screen and can use any app you can, with your user rights, including email, files and payment pages. Anything on screen can mislead it. Close what it should not see, stay at the computer, and press Stop to take over at once. A separate user account or a virtual machine is safer.',
    unguarded: ' Plenum cannot check for a password field on this system, so only the model\'s care keeps it from typing into one. Keep password fields out of its way.',
  }),
  notice({
    id: 'artifacts',
    tone: 'info',
    feature: 'Artifacts',
    where: 'A strip above the first artifact opened in a launch.',
    title: 'This was made by a model',
    text: 'An artifact is a page or small app that a model wrote. It runs apart from Plenum, without access to your files or keys, but it can still be wrong, misleading or broken. Do not type passwords or personal details into it, and read its code before you use it anywhere else.',
  }),
  notice({
    id: 'artifact-web-access',
    feature: 'Artifacts: web access',
    where: 'Under the "Allow web access" switch of an open artifact when it is turned on.',
    title: 'Web access is on for this artifact',
    text: 'This page may now load scripts from and send requests to any https site, including whatever the model wrote into it. It still cannot read your files, keys or Plenum.',
  }),
  notice({
    id: 'api-finder-prices',
    tone: 'info',
    feature: 'API finder prices',
    where: 'A strip at the top of the API finder page, above the price table.',
    title: 'Prices come from other sites',
    text: 'Prices and model details here come from router and provider listings and can be out of date or wrong. Plenum earns nothing from these links and does not endorse any provider. Check the price and terms on the provider\'s own site before you sign up or pay.',
  }),
]);

const BY_ID = new Map();
for (const n of NOTICES) {
  BY_ID.set(n.id, n);
  for (const alias of n.aliases ?? []) BY_ID.set(alias, n);
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const badId = () => Object.assign(new Error('Unknown notice.'), { status: 400 });
const stamp = now => (now instanceof Date ? now : new Date(now)).toISOString();

// The registry entry for an id or an alias, or null.
export function findNotice(id) {
  return typeof id === 'string' ? (BY_ID.get(id) ?? null) : null;
}

// Every notice with what this person has done with it: hidden (they chose Don't show again on this rev), hiddenAt (when), and updated
// (they hid an older rev, so it shows once more). A notice with an `unguarded` sentence carries it in its text on every platform but
// Windows, where the password-field guard cannot run (platform defaults to this computer's; the tests pass the others).
export function noticeState(st, platform = process.platform) {
  const stored = isObject(st?.notices) ? st.notices : {};
  return NOTICES.map(({ unguarded, ...n }) => {
    const rec = Object.hasOwn(stored, n.id) && isObject(stored[n.id]) ? stored[n.id] : null;
    const hidden = rec !== null && rec.rev === n.rev;
    return {
      ...n,
      text: typeof unguarded === 'string' && platform !== 'win32' ? n.text + unguarded : n.text,
      hidden,
      hiddenAt: hidden && typeof rec.at === 'string' ? rec.at : null,
      updated: rec !== null && Number.isInteger(rec.rev) && rec.rev < n.rev,
    };
  });
}

// Don't show again. Throws 400 'Unknown notice.' for an id that is not in the registry. The caller saves the state.
export function hideNotice(st, id, now = Date.now()) {
  const n = findNotice(id);
  if (!n) throw badId();
  if (!isObject(st.notices)) st.notices = {};
  st.notices[n.id] = { rev: n.rev, at: stamp(now) };
  return n;
}

// Show again: forgets that this notice was hidden.
export function showNotice(st, id) {
  const n = findNotice(id);
  if (!n) throw badId();
  if (isObject(st.notices)) delete st.notices[n.id];
  return n;
}

// Show every notice again.
export function showAllNotices(st) {
  st.notices = {};
}
