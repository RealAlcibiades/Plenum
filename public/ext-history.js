// Chat history panel: search this project's chat, or every project's chat, and export this chat as Markdown. Owned by
// this panel. Builds on window.MuseUI (see app.js). The search runs on the server (/api/history/search, or
// /api/history/search-all while "All projects" is on), and the panel shows only the matches it returns. The export is
// a download from /api/history/export, so the chat is not read into the page for it.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TITLE = 'Chat history';
  const BUTTON_ID = 'historyBtn';
  const SEARCH_DELAY_MS = 250;
  const MAX_QUERY = 200;
  // The server returns this many at most, so a full list means there may be older matches it did not send.
  const MAX_RESULTS = 50;
  const FLASH_CLASS = 'ext-history-hit';
  const FLASH_MS = 1600;
  const IDLE = 'Type a word or phrase. Matches in this project’s chat show here, newest first.';
  const IDLE_ALL = 'Type a word or phrase. Matches in every project\'s chat show here, newest first.';
  // Switching to another project from a result waits this long at most, checking every SWITCH_POLL_MS.
  const SWITCH_WAIT_MS = 3000;
  const SWITCH_POLL_MS = 100;

  function currentProject() {
    const S = MuseUI.state;
    return (S.projects ?? []).find(p => p.id === S.activeProject) ?? null;
  }

  // The project the chat shows now. A search or an export asks for it when it runs, so it follows a switch made from a
  // result.
  const activeId = () => MuseUI.state.activeProject;

  // The turn class the chat gives a message, or null when the message draws no single turn: a build note, a council,
  // or a reply made only of tool steps. This mirrors messageNodes in app.js. If the two ever disagree, the counts in
  // chatTurnFor stop matching, and the result shows its snippet instead of jumping to the wrong turn.
  function turnKind(m) {
    if (m.compact) return 'summary';
    if (m.role === 'user') return m.kind === 'build' ? null : 'user';
    if (m.kind === 'advisor') return 'advisor';
    if (m.kind === 'council' || m.kind === 'build') return null;
    const hasText = String(m.content ?? '').trim() !== '';
    // A failed or stopped reply with no text draws an error line or a quiet note, not an assistant turn (app.js, B-49).
    if (!hasText && (m.error || m.aborted)) return null;
    return hasText || !(m.tools ?? []).length ? 'assistant' : null;
  }

  // The chat element for a search result, or null. The chat has no index on its turns, so the turn is found by its
  // place among the turns of the same kind. The count of those turns must agree with the transcript first.
  function chatTurnFor(hit, q) {
    const messages = MuseUI.state.messages ?? [];
    const msg = messages[hit.index];
    if (!msg || !String(msg.content ?? '').toLowerCase().includes(q.toLowerCase())) return null;
    const kind = turnKind(msg);
    if (!kind) return null;
    const sameKind = messages.filter(m => turnKind(m) === kind);
    const turns = [...MuseUI.el.chat.querySelectorAll(`.turn.${kind}`)];
    if (turns.length !== sameKind.length) return null;
    return turns[sameKind.indexOf(msg)] ?? null;
  }

  // The sidebar link sits just above Commands. It opens the drawer, which is built fresh on each open.
  function sideLink() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'side-link';
    b.id = BUTTON_ID;
    b.append(MuseUI.icon('search'), TITLE);
    b.addEventListener('click', () => MuseUI.openDrawer(TITLE, renderPanel));
    return b;
  }

  // The snippet with the query marked. The match is found in this text itself, with the same case-insensitive plain-text
  // pattern the server uses (lib/routes/history.mjs), so the index is into this text and not into a lowercased copy, whose
  // length can differ. The text is set node by node, so nothing in it is read as markup.
  function snippetNode(text, q) {
    const node = MuseUI.span('ext-history-snippet', '');
    const hit = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text) : null;
    if (!hit) {
      node.textContent = text;
      return node;
    }
    const mark = document.createElement('mark');
    mark.textContent = hit[0];
    node.append(text.slice(0, hit.index), mark, text.slice(hit.index + hit[0].length));
    return node;
  }

  // The drawer's content: a search box with the export button, a line of counts, a status line and the results.
  function renderPanel(body) {
    const project = currentProject();
    if (!project) {
      body.append(MuseUI.para('Choose a project first. Its chat can then be searched and exported here.'));
      return;
    }

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'ext-history-input';
    input.maxLength = MAX_QUERY;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Search this chat';
    input.setAttribute('aria-label', 'Search this chat');

    // Off, the search covers this chat. On, it covers every project's chat and each result names its project.
    const scope = document.createElement('input');
    scope.type = 'checkbox';
    const scopeText = document.createElement('span');
    scopeText.textContent = 'All projects';
    const scopeLabel = document.createElement('label');
    scopeLabel.className = 'ext-history-scope';
    scopeLabel.append(scope, scopeText);

    const exportBtn = MuseUI.button('ghost small', 'Export as Markdown');
    exportBtn.title = 'Download this chat as a Markdown file';
    const bar = document.createElement('div');
    bar.className = 'ext-history-bar';
    bar.append(input, scopeLabel, exportBtn);

    const note = MuseUI.para(IDLE);
    note.className = 'ext-history-note';
    // Says why a result cannot be shown in the chat, and shows its text.
    const status = document.createElement('div');
    status.className = 'ext-history-status';
    status.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.className = 'ext-history-list';
    body.append(bar, note, status, list);

    let timer = 0;
    // Each search takes a number. An answer that comes back after a newer search has started is dropped.
    let latest = 0;

    async function search() {
      clearTimeout(timer);
      const q = input.value.trim();
      const mine = ++latest;
      status.replaceChildren();
      if (!q) {
        list.replaceChildren();
        note.textContent = scope.checked ? IDLE_ALL : IDLE;
        return;
      }
      note.textContent = 'Searching…';
      const url = scope.checked
        ? `/api/history/search-all?q=${encodeURIComponent(q)}`
        : `/api/history/search?project=${encodeURIComponent(activeId() ?? '')}&q=${encodeURIComponent(q)}`;
      try {
        const data = await MuseUI.api(url);
        if (mine !== latest) return;
        showResults(q, Array.isArray(data?.results) ? data.results : [], scope.checked);
      } catch (err) {
        if (mine !== latest) return;
        list.replaceChildren();
        note.textContent = '';
        status.textContent = err.message;
      }
    }

    function showResults(q, results, everywhere) {
      list.replaceChildren(...results.map(hit => resultRow(hit, q)));
      if (!results.length) note.textContent = everywhere ? `No message in any project contains “${q}”.` : `No message in this chat contains “${q}”.`;
      else if (results.length >= MAX_RESULTS) note.textContent = `Showing the ${MAX_RESULTS} most recent matches.`;
      else note.textContent = `${results.length} ${results.length === 1 ? 'match' : 'matches'}.`;
    }

    // One match: its project when it is from another project, who wrote it, then the text around the match. A click
    // opens it in the chat.
    function resultRow(hit, q) {
      const row = MuseUI.button('ext-history-result', '');
      // Only this chat's messages are in the page, so a reply from another project is labelled without its model.
      const here = !hit.project || hit.project.id === activeId();
      const msg = here ? (MuseUI.state.messages ?? [])[hit.index] : null;
      const who = hit.role === 'user' ? 'You' : ((msg?.model ? MuseUI.modelName(msg.model) : '') || 'Assistant');
      if (hit.project?.name) row.append(MuseUI.span('ext-history-project', hit.project.name));
      row.append(MuseUI.span('ext-history-who', who), snippetNode(hit.snippet, q));
      row.addEventListener('click', () => openHit(hit, q));
      return row;
    }

    // A hit from another project switches to that project first, through the page's own sidebar row, and then opens
    // as usual. The wait ends when that project is active and its chat has been drawn again.
    let switching = false;
    async function openElsewhere(hit, q) {
      if (switching) return;
      const id = hit.project.id;
      const index = (MuseUI.state.projects ?? []).findIndex(p => p.id === id);
      const row = index < 0 ? null : [...MuseUI.el.projects.querySelectorAll('.proj-item')][index];
      if (!row) {
        status.textContent = 'That project is no longer in the list.';
        return;
      }
      switching = true;
      try {
        const drawn = MuseUI.stream();
        row.click();
        const until = Date.now() + SWITCH_WAIT_MS;
        while (!(MuseUI.state.activeProject === id && MuseUI.stream() !== drawn) && Date.now() < until) {
          await new Promise(done => setTimeout(done, SWITCH_POLL_MS));
        }
      } finally {
        switching = false;
      }
      if (MuseUI.state.activeProject !== id) {
        status.textContent = 'Plenum could not switch to that project.';
        return;
      }
      openHit(hit, q);
    }

    // The drawer closes and the message scrolls into view, with a brief outline. When the chat does not draw that
    // message, its text is shown in the status line instead.
    function openHit(hit, q) {
      if (hit.project && hit.project.id !== activeId()) {
        openElsewhere(hit, q);
        return;
      }
      const turn = chatTurnFor(hit, q);
      if (turn) {
        MuseUI.closeDrawer();
        turn.scrollIntoView({ block: 'center' });
        turn.classList.add(FLASH_CLASS);
        setTimeout(() => turn.classList.remove(FLASH_CLASS), FLASH_MS);
        return;
      }
      const full = document.createElement('div');
      full.className = 'ext-history-full';
      full.textContent = hit.snippet;
      status.replaceChildren(MuseUI.para('The chat does not show that message right now, so its text is shown here.'), full);
    }

    // The export is a download link, clicked from the page. The server names the file.
    exportBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = `/api/history/export?project=${encodeURIComponent(activeId() ?? '')}`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    });

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, SEARCH_DELAY_MS);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') search();
    });
    // Turning the scope on or off searches again with the same words, when there are any.
    scope.addEventListener('change', () => search());
    input.focus();
  }

  // Attach. The link goes in before Commands, the last link in the sidebar footer.
  if (!document.getElementById(BUTTON_ID)) MuseUI.el.helpBtn.before(sideLink());
})();
