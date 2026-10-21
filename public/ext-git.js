// Git status chip in the top bar. Loaded by ext.js and adds itself through window.MuseUI.
// A small button beside the project name shows the branch and how many files are changed or untracked, so you know what state
// the project is in before and after a run. The server reads git (GET /api/git, lib/git-status.mjs) and this file only words
// what it sends. Clicking the chip opens a drawer that lists the changed and untracked paths. It refreshes when the project
// changes, when a run ends, and every 30 seconds while the page is visible. Every piece of text is set with textContent.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Working tree';
  const REVIEW_NOTE = 'Review the diff with /review.';
  const POLL_MS = 30_000;
  // How many paths the hover text lists.
  const HOVER_PATHS = 30;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'ext-git-chip';
  chip.hidden = true;
  chip.dataset.state = 'clean';

  // The last answer from the server, and the project it is for. The chip shows it only while that project is the active one.
  let status = null;
  let statusFor = null;
  // Counts the requests, so a late answer never paints over a newer one.
  let seq = 0;
  // The list inside the open drawer, or null. It is redrawn whenever a new answer arrives.
  let drawerRoot = null;

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function projectId() {
    return MuseUI.state.activeProject ?? null;
  }

  // The chip goes after the cost line or the budget chip when the page has one, else straight after the project name. It is
  // checked on every paint, so a chip another panel adds later is still ahead of this one.
  function place() {
    const anchor = document.querySelector('.ext-budget-chip') ?? document.querySelector('.cost-line') ?? MuseUI.el.projName;
    if (chip.previousElementSibling !== anchor) anchor.after(chip);
  }

  // " ↑2 ↓1" when the branch is ahead of or behind its upstream, else nothing.
  function syncText(s) {
    return s.ahead || s.behind ? ` ↑${s.ahead} ↓${s.behind}` : '';
  }

  function branchOf(s) {
    return s.branch || '(unknown)';
  }

  // The text on the chip.
  function chipText(s) {
    if (!s.repo) return s.error ? 'git: no answer' : 'No git';
    if (s.clean) return `git: clean on ${branchOf(s)}${syncText(s)}`;
    const unmerged = s.unmerged ? ` · ${s.unmerged} unmerged` : '';
    return `git ${branchOf(s)}${syncText(s)} · ${s.changedCount} changed · ${s.untrackedCount} untracked${unmerged}`;
  }

  // The words a phone-width window shows: the branch name only (ext-git.css picks one of the two spans).
  function shortText(s) {
    return s.repo ? branchOf(s) : chipText(s);
  }

  // The hover text: a short summary and the first paths.
  function hoverText(s) {
    if (!s.repo) return s.error ? 'git did not answer for this folder. Plenum tries again in a moment.' : 'This project folder is not a git repository.';
    const lines = [s.clean ? `The working tree is clean on ${branchOf(s)}.` : `Working tree on ${branchOf(s)}.`];
    if (s.ahead || s.behind) lines.push(`${s.ahead} ahead, ${s.behind} behind the upstream branch.`);
    let left = HOVER_PATHS;
    const total = s.changedCount + s.untrackedCount;
    for (const [label, list] of [['Changed', s.changed], ['Untracked', s.untracked]]) {
      if (!list.length || left <= 0) continue;
      const shown = list.slice(0, left);
      left -= shown.length;
      lines.push('', `${label}:`, ...shown);
    }
    const listed = Math.min(total, HOVER_PATHS);
    if (total > listed) lines.push(`…and ${total - listed} more`);
    if (s.unmerged) lines.push('', `${s.unmerged} with an unresolved merge conflict.`);
    lines.push('', 'Click to see the list.');
    return lines.join('\n');
  }

  // ---------- the chip ----------

  function paint() {
    place();
    const id = projectId();
    // Hidden with no project, before the first answer, when git is not installed, and when the server could not be reached.
    if (!id || !status || statusFor !== id || status.noGit || status.unreachable) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      chip.replaceChildren(make('span', 'ext-git-long', chipText(status)), make('span', 'ext-git-short', shortText(status)));
      chip.title = hoverText(status);
      chip.dataset.state = !status.repo ? 'none' : status.clean ? 'clean' : 'dirty';
      chip.setAttribute('aria-label', `${chipText(status)}. Opens the working tree.`);
    }
    // Closing a drawer only hides it, so a list that is still in the page but hidden is left alone.
    if (drawerRoot) {
      if (!drawerRoot.isConnected) drawerRoot = null;
      else if (!MuseUI.el.drawer.hidden) fillDrawer(drawerRoot);
    }
  }

  // Reads the status of the active project. fresh asks the server to look again unless it looked within the last second.
  async function refresh(fresh = false) {
    const id = projectId();
    const mine = ++seq;
    if (!id) {
      status = null;
      statusFor = null;
      paint();
      return;
    }
    let answer;
    try {
      answer = await MuseUI.api(`/api/git?project=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`);
    } catch {
      answer = { repo: false, unreachable: true };
    }
    // A newer request, or another project, has taken over since this one was sent.
    if (mine !== seq || projectId() !== id) return;
    status = answer && typeof answer === 'object' ? answer : null;
    statusFor = id;
    paint();
  }

  // ---------- the drawer ----------

  function group(root, caption, list, count) {
    const box = make('section', 'ext-git-group');
    box.append(make('h4', 'ext-git-cap', `${caption} (${count})`));
    const rows = make('div', 'ext-git-list');
    for (const p of list) rows.append(make('div', 'ext-git-row', p));
    box.append(rows);
    if (count > list.length) box.append(make('p', 'ext-git-note', `Showing the first ${list.length}.`));
    root.append(box);
  }

  // Fills the drawer from the last answer. openDrawer and every new answer call it.
  function fillDrawer(root) {
    root.replaceChildren();
    const s = statusFor === projectId() ? status : null;
    if (!s) {
      root.append(make('p', 'ext-git-note', 'Reading the working tree…'));
      return;
    }
    if (!s.repo) {
      const why = s.noGit ? 'git is not installed on this computer, so Plenum cannot show the working tree.'
        : s.unreachable ? 'Plenum could not reach its server to read the working tree. Try again.'
        : s.error ? 'git did not answer. Try again in a moment.'
        : 'This project folder is not a git repository.';
      root.append(make('p', 'ext-git-note', why));
    } else {
      root.append(make('p', 'ext-git-head', `On branch ${branchOf(s)}${syncText(s)}`));
      if (s.clean) root.append(make('p', 'ext-git-note', 'The working tree is clean: no changed or untracked files.'));
      if (s.changedCount) group(root, 'Changed', s.changed, s.changedCount);
      if (s.untrackedCount) group(root, 'Untracked', s.untracked, s.untrackedCount);
      if (s.unmerged) root.append(make('p', 'ext-git-note', `${s.unmerged} with an unresolved merge conflict. Resolve ${s.unmerged === 1 ? 'it' : 'them'} in git.`));
      if (!s.clean) root.append(make('p', 'ext-git-note', REVIEW_NOTE));
    }
    const again = MuseUI.button('ghost small', 'Refresh');
    again.addEventListener('click', () => refresh(true));
    root.append(again);
  }

  function renderDrawer(body) {
    const root = make('div', 'ext-git');
    body.append(root);
    drawerRoot = root;
    fillDrawer(root);
    refresh(true);
  }

  chip.addEventListener('click', () => MuseUI.openDrawer(TITLE, renderDrawer));
  place();

  // ---------- when to refresh ----------

  // A project switch redraws the project name. A different project clears the chip until its own answer arrives, so the old
  // project’s branch is never shown under the new name. A redraw for the same project changes nothing.
  let seen = projectId();
  new MutationObserver(() => {
    const id = projectId();
    if (id === seen) return;
    seen = id;
    status = null;
    statusFor = null;
    paint();
    refresh();
  }).observe(MuseUI.el.projName, { childList: true, characterData: true, subtree: true });

  // The send button carries the class "stop" while a run is on. When the class goes, the run has ended and files may have changed.
  let wasRunning = MuseUI.el.send.classList.contains('stop');
  new MutationObserver(() => {
    const running = MuseUI.el.send.classList.contains('stop');
    if (wasRunning && !running) refresh(true);
    wasRunning = running;
  }).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });

  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  refresh();
})();
