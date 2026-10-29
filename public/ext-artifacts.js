// Artifacts in the side pane. A code block the model wrote as an HTML page, an SVG drawing, a Markdown document (or any block longer
// than 15 lines) gets an Open button. Open shows it in the Artifacts tab of the side pane: Preview or Code, with Copy, Save to project
// and, for a page or a drawing, a web access switch that is off by default. What an artifact may load is decided by the server
// (lib/routes/artifacts.mjs), and the preview frame is sandboxed; this file only asks for previews and saves. Loaded by ext.js and
// adds itself through window.MuseUI. Model text is placed with textContent, except the Markdown preview, which uses the md() the chat
// uses: its output escapes every character of the reply.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const TAB = 'artifacts';
  // A block longer than this opens as source, whatever its language.
  const CODE_LINES = 15;
  const COPY_MS = 1400;
  // Marks a code block that already has its Open button.
  const SEEN = 'ext-art-seen';
  const KIND_LABEL = { html: 'HTML', svg: 'SVG', md: 'Markdown', code: 'Code' };
  const EXT = { html: '.html', svg: '.svg', md: '.md' };
  const WEB_NOTICE = 'artifact-web-access';
  const MADE_NOTICE = 'artifacts';
  const WEB_TEXT = 'This page may now load scripts from and send requests to any https site, including whatever the model wrote into it. It still cannot read your files, keys or Plenum.';
  const MADE_TEXT = 'An artifact is a page or small app that a model wrote. It runs apart from Plenum, without access to your files or keys, but it can still be wrong, misleading or broken. Do not type passwords or personal details into it, and read its code before you use it anywhere else.';
  const SANDBOX_TEXT = 'Previews run in a sandbox: no network, no cookies, no popups, no access to Plenum.';

  // The code blocks in the chat as of the last pass, in chat order: { el, kind, lang, code, lines, title }.
  let records = [];
  // The pass waiting to run ({ frame, timer }), or null.
  let queued = null;
  // Web access per artifact for this page's life: artifact key -> true. Off unless the person turned it on.
  const webOn = new Map();
  // The artifact pane's view for each open tab (api -> ui), and the one that is shown now (live).
  const views = new WeakMap();
  let live = null;
  // The first artifact in this page's life shows the "made by a model" notice once.
  let madeShown = false;

  // ---------- helpers ----------

  const mk = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const countLines = code => (code === '' ? 0 : code.replace(/\n$/, '').split('\n').length);

  // The kind of artifact a block is, or null when the block is not one.
  function kindOf(lang, lines) {
    if (lang === 'html' || lang === 'htm') return 'html';
    if (lang === 'svg') return 'svg';
    if (lang === 'markdown' || lang === 'md') return 'md';
    return lines > CODE_LINES ? 'code' : null;
  }

  // The title shown in the list: the page's <title>, the first heading of a Markdown document, or the language and the line count.
  function titleOf(kind, lang, code, lines) {
    let title = '';
    if (kind === 'html') {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(code);
      title = m ? m[1] : '';
    } else if (kind === 'md') {
      const m = /^ {0,3}#{1,6}[ \t]+(.+)$/m.exec(code);
      title = m ? m[1].replace(/[ \t]+#+[ \t]*$/, '') : '';
    }
    title = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    return title || `${lang || kind} · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
  }

  // What a code block holds, or null when it is not an artifact. Reads the block's own text, so it is correct for any block.
  function describe(block) {
    const lang = (block.querySelector('.cb-head span')?.textContent ?? '').trim().toLowerCase();
    const code = block.querySelector('code')?.textContent ?? '';
    const lines = countLines(code);
    const kind = kindOf(lang, lines);
    if (!kind) return null;
    return { el: block, kind, lang, code, lines, title: titleOf(kind, lang, code, lines) };
  }

  // A stable key for an artifact's content, used to remember its web access switch for this page's life.
  function keyOf(kind, code) {
    let h = 2166136261;
    for (let i = 0; i < code.length; i++) {
      h ^= code.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${kind}:${code.length}:${(h >>> 0).toString(36)}`;
  }

  // The snapshot the pane shows. It keeps the code it was opened with, so a later change in the chat does not change the pane under the person.
  function artifactOf(rec) {
    return { el: rec.el, kind: rec.kind, lang: rec.lang, code: rec.code, title: rec.title, key: keyOf(rec.kind, rec.code) };
  }

  const activeProject = () => {
    const st = MuseUI.state;
    return st.projects?.find(p => p.id === st.activeProject) ?? null;
  };

  // A file name for Save: the title as a slug, with the extension of the kind (or of the language for a code block).
  function suggestedName(art) {
    const base = (art.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'artifact';
    let ext = EXT[art.kind];
    if (!ext) ext = /^[a-z0-9]{1,8}$/.test(art.lang) && art.lang !== 'text' ? `.${art.lang}` : '.txt';
    return `${base}${ext}`;
  }

  // ---------- notices ----------

  // MuseUI.notice draws the registered notice when the notices module is loaded. When it draws nothing, this file draws the strip
  // itself with the same words. OK and Don't show again dismiss it (the second one is kept on this computer only); More opens Settings.
  const hiddenKey = id => `plenum-notice-hidden:${id}`;
  function noticeHidden(id) {
    try {
      return localStorage.getItem(hiddenKey(id)) === '1';
    } catch {
      return false;
    }
  }
  function forgetNotice(id) {
    try {
      localStorage.setItem(hiddenKey(id), '1');
    } catch {
      // Without storage the strip shows again next time, which is the safe side.
    }
  }
  function notice(ui, id, { title, text, anchor }) {
    if (typeof MuseUI.notice === 'function') {
      if (MuseUI.notice(id, { before: anchor ?? undefined })) return;
    }
    if (noticeHidden(id)) return;
    const strip = mk('div', 'ext-art-notice');
    strip.setAttribute('role', 'note');
    const actions = mk('div', 'ext-art-notice-actions');
    const ok = MuseUI.button('ghost small', 'OK');
    const never = MuseUI.button('ghost small', 'Don’t show again');
    const more = MuseUI.button('ghost small', 'More');
    ok.addEventListener('click', () => strip.remove());
    never.addEventListener('click', () => {
      forgetNotice(id);
      strip.remove();
    });
    more.addEventListener('click', () => {
      if (typeof MuseUI.settings?.open === 'function') MuseUI.settings.open('app');
    });
    actions.append(ok, never, more);
    strip.append(mk('strong', 'ext-art-notice-title', title), mk('p', 'ext-art-notice-text', text), actions);
    ui.notes.append(strip);
  }

  // ---------- scanning the chat ----------

  // Gives each artifact block its Open button, once, before the Copy button. The list of artifacts is rebuilt on every pass.
  function attach(block) {
    const head = block.querySelector('.cb-head');
    if (!head || block.classList.contains(SEEN)) return;
    block.classList.add(SEEN);
    const open = MuseUI.button('ext-art-open', 'Open');
    open.title = 'Open in the artifact pane';
    const copy = head.querySelector('.copy');
    if (copy) copy.before(open);
    else head.append(open);
  }

  function scan() {
    const found = [];
    for (const block of MuseUI.el.chat.querySelectorAll('.codeblock')) {
      const rec = describe(block);
      if (!rec) continue;
      attach(block);
      found.push(rec);
    }
    records = found;
    if (live) refreshLive(live);
  }

  // A pass runs at most once per frame, however many changes the chat made. A frame does not come while the window is hidden
  // (in the tray, or in a pane that is not on screen), so a timer of 250 ms runs the pass instead; whichever comes first wins.
  function queue() {
    if (queued) return;
    const frame = requestAnimationFrame(() => run());
    const timer = setTimeout(() => run(), 250);
    queued = { frame, timer };
  }
  function run() {
    if (!queued) return;
    cancelAnimationFrame(queued.frame);
    clearTimeout(queued.timer);
    queued = null;
    scan();
  }

  // The open artifact follows the chat: when its block is still there with the same code it stays; when the block is gone or
  // the reply changed, the pane keeps its copy and says so.
  function refreshLive(view) {
    const { ui } = view;
    const art = ui.art;
    if (!art) return;
    const same = records.find(r => r.kind === art.kind && r.code === art.code);
    if (same) {
      art.el = same.el;
      ui.stale.hidden = true;
    } else {
      ui.stale.hidden = false;
      ui.stale.textContent = 'The reply changed after you opened this, so the code shown here is kept. Open it again for the current code.';
    }
    syncList(ui);
  }

  // Rebuilds the list only when its entries change, so the menu does not flicker while a reply streams.
  function syncList(ui) {
    const art = ui.art;
    const selected = records.findIndex(r => r.kind === art.kind && r.code === art.code);
    const items = records.map((r, i) => ({ value: String(i), text: r.title }));
    // The open artifact stays in the list even when its block has left the chat.
    if (selected < 0) items.unshift({ value: 'current', text: art.title });
    const sig = items.map(o => `${o.value}\u0000${o.text}`).join('\n');
    if (sig !== ui.listSig) {
      ui.listSig = sig;
      ui.list.replaceChildren(...items.map(o => {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        return opt;
      }));
    }
    ui.list.value = selected >= 0 ? String(selected) : 'current';
  }

  // Open, on a block's button. The click is handled here once for every block, including blocks added later.
  MuseUI.el.chat.addEventListener('click', e => {
    const btn = e.target instanceof Element ? e.target.closest('.ext-art-open') : null;
    if (!btn) return;
    const block = btn.closest('.codeblock');
    const rec = block ? describe(block) : null;
    if (!rec) return;
    MuseUI.pane.open(TAB, { artifact: artifactOf(rec) });
  });

  // ---------- the pane ----------

  // Builds the tab's view once. onShow shows the artifact it was opened with.
  function build(body, api) {
    const ui = {
      art: null,
      mode: 'preview',
      stageSeq: 0,
      busy: false,
      stage: null,
      listSig: '',
      notes: null,
    };
    const root = mk('div', 'ext-art');

    const head = mk('div', 'ext-art-head');
    ui.list = mk('select', 'ext-art-list');
    ui.list.setAttribute('aria-label', 'Artifact');
    ui.close = MuseUI.button('icon-btn', '');
    ui.close.title = 'Close the artifact pane';
    ui.close.setAttribute('aria-label', 'Close the artifact pane');
    ui.close.append(MuseUI.icon('x'));
    head.append(ui.list, ui.close);

    const bar = mk('div', 'ext-art-bar');
    ui.kind = mk('span', 'pill ext-art-kind', '');
    const seg = mk('div', 'seg ext-art-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    ui.previewBtn = MuseUI.button('seg-btn', 'Preview');
    ui.codeBtn = MuseUI.button('seg-btn', 'Code');
    seg.append(ui.previewBtn, ui.codeBtn);
    ui.copy = MuseUI.button('ghost small', 'Copy');
    ui.saveBtn = MuseUI.button('ghost small', 'Save to project…');
    bar.append(ui.kind, seg, ui.copy, ui.saveBtn);

    ui.webRow = mk('label', 'ext-art-web');
    ui.web = document.createElement('input');
    ui.web.type = 'checkbox';
    ui.web.setAttribute('aria-label', 'Allow web access');
    ui.webRow.append(ui.web, mk('span', '', 'Allow web access'));
    ui.webRow.title = 'Off by default. On, the page may load scripts and send requests to https sites.';

    ui.notes = mk('div', 'ext-art-notes');
    ui.stale = mk('p', 'note-quiet ext-art-stale');
    ui.stale.hidden = true;

    // The inline path field that replaces a prompt. It sits under the bar and shows what Save will write.
    ui.save = mk('form', 'ext-art-save');
    ui.save.hidden = true;
    const label = mk('label', 'ext-art-label', 'Save as (relative to the project folder)');
    ui.path = document.createElement('input');
    ui.path.type = 'text';
    ui.path.className = 'ext-art-path';
    ui.path.spellcheck = false;
    ui.path.autocomplete = 'off';
    ui.path.setAttribute('aria-label', 'Save as (relative to the project folder)');
    label.append(ui.path);
    ui.saveProject = mk('p', 'note-quiet ext-art-project');
    ui.planNote = mk('p', 'ext-art-plan', 'Plan mode is on: the model will not write files, but your own change here is saved.');
    ui.planNote.hidden = true;
    ui.saveError = mk('p', 'ext-art-error');
    ui.saveError.setAttribute('role', 'alert');
    ui.saveError.hidden = true;
    ui.replace = mk('div', 'ext-art-replace');
    ui.replace.hidden = true;
    ui.replaceText = mk('p', 'note-quiet ext-art-replace-text');
    const replaceActions = mk('div', 'ext-art-actions');
    ui.replaceCancel = MuseUI.button('ghost small', 'Cancel');
    ui.replaceGo = MuseUI.button('ghost small ext-art-danger', 'Replace');
    replaceActions.append(ui.replaceCancel, ui.replaceGo);
    ui.replace.append(ui.replaceText, replaceActions);
    const actions = mk('div', 'ext-art-actions');
    ui.saveGo = MuseUI.button('primary small', 'Save');
    ui.saveGo.type = 'submit';
    ui.saveCancel = MuseUI.button('ghost small', 'Cancel');
    actions.append(ui.saveGo, ui.saveCancel);
    ui.save.append(label, ui.saveProject, ui.planNote, ui.saveError, ui.replace, actions);

    ui.body = mk('div', 'ext-art-body');

    root.append(head, bar, ui.webRow, ui.notes, ui.stale, ui.save, ui.body);
    body.replaceChildren(root);
    views.set(api, ui);

    ui.list.addEventListener('change', () => {
      if (ui.list.value === 'current') return;
      const rec = records[Number(ui.list.value)];
      if (rec) MuseUI.pane.open(TAB, { artifact: artifactOf(rec) });
    });
    ui.close.addEventListener('click', () => api.close());
    ui.previewBtn.addEventListener('click', () => {
      if (!ui.art || ui.art.kind === 'code' || ui.mode === 'preview') return;
      ui.mode = 'preview';
      paint(ui);
    });
    ui.codeBtn.addEventListener('click', () => {
      if (!ui.art || ui.mode === 'code') return;
      ui.mode = 'code';
      paint(ui);
    });
    ui.copy.addEventListener('click', async () => {
      if (!ui.art) return;
      const ok = await MuseUI.copyText(ui.art.code);
      if (!ok) {
        MuseUI.toast('The code could not be copied.', 'bad');
        return;
      }
      ui.copy.textContent = 'Copied';
      setTimeout(() => {
        ui.copy.textContent = 'Copy';
      }, COPY_MS);
    });
    ui.web.addEventListener('change', () => {
      const art = ui.art;
      if (!art) return;
      webOn.set(art.key, ui.web.checked);
      if (ui.web.checked) {
        notice(ui, WEB_NOTICE, { title: 'Web access is on for this artifact', text: WEB_TEXT, anchor: ui.webRow });
      }
      if (ui.mode === 'preview') paint(ui);
    });
    ui.saveBtn.addEventListener('click', () => {
      if (!ui.art) return;
      if (!ui.save.hidden) closeSave(ui);
      else openSave(ui);
    });
    ui.saveCancel.addEventListener('click', () => closeSave(ui));
    ui.replaceCancel.addEventListener('click', () => {
      ui.replace.hidden = true;
      ui.path.focus();
    });
    ui.replaceGo.addEventListener('click', () => saveFile(ui, true));
    ui.save.addEventListener('submit', e => {
      e.preventDefault();
      saveFile(ui, false);
    });
    return ui;
  }

  // Shows an artifact in the view: its title, its kind, the switches, and the body in the mode it opens in.
  function show(api, art) {
    const ui = views.get(api);
    if (!ui || ui.art === art) return;
    ui.art = art;
    ui.kind.textContent = KIND_LABEL[art.kind] ?? 'Code';
    ui.mode = art.kind === 'code' ? 'code' : 'preview';
    ui.previewBtn.hidden = art.kind === 'code';
    const pageLike = art.kind === 'html' || art.kind === 'svg';
    ui.webRow.hidden = !pageLike;
    ui.web.checked = pageLike && webOn.get(art.key) === true;
    ui.stale.hidden = true;
    closeSave(ui);
    if (!madeShown) {
      madeShown = true;
      notice(ui, MADE_NOTICE, { title: 'This was made by a model', text: MADE_TEXT });
    }
    syncList(ui);
    live = { api, ui };
    paint(ui);
  }

  // Draws the body for the current mode. A page or drawing gets a fresh sandboxed frame each time it is drawn.
  function paint(ui) {
    const art = ui.art;
    const code = ui.mode === 'code';
    ui.previewBtn.setAttribute('aria-pressed', String(!code));
    ui.codeBtn.setAttribute('aria-pressed', String(code));
    ui.body.replaceChildren();
    if (code) {
      ui.body.append(mk('pre', 'ext-art-code', art.code));
      return;
    }
    if (art.kind === 'md') {
      const paper = mk('div', 'ext-art-md turn-body ext-art-paper');
      if (typeof md === 'function') paper.innerHTML = md(art.code);
      else paper.textContent = art.code;
      ui.body.append(paper);
      return;
    }
    ui.stage = mk('div', 'ext-art-stage');
    ui.stage.append(mk('p', 'note-quiet ext-art-wait', 'Preparing the preview…'));
    ui.body.append(ui.stage);
    stageNow(ui);
  }

  // Stages the content on the server and puts its frame in the stage. A reply that arrives after the artifact changed is dropped.
  async function stageNow(ui) {
    const art = ui.art;
    const seq = ++ui.stageSeq;
    const stage = ui.stage;
    try {
      const data = await MuseUI.api('/api/artifacts/stage', { kind: art.kind, content: art.code, web: ui.web.checked });
      if (seq !== ui.stageSeq || ui.art !== art || !stage.isConnected) return;
      const frame = document.createElement('iframe');
      frame.className = 'ext-art-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = 'Artifact preview';
      frame.src = `/api/artifacts/view?id=${encodeURIComponent(data.id)}`;
      stage.replaceChildren(frame, mk('p', 'note-quiet ext-art-sandbox', SANDBOX_TEXT));
    } catch (err) {
      if (seq !== ui.stageSeq || ui.art !== art || !stage.isConnected) return;
      stage.replaceChildren(
        mk('p', 'ext-art-error', err?.message || 'The preview could not be made.'),
        mk('p', 'note-quiet', 'The code is still available under Code.'),
      );
    }
  }

  // ---------- Save to project ----------

  function openSave(ui) {
    const project = activeProject();
    // The project the form names is the one the file goes to, even if another is made active before Save is clicked (B-92).
    ui.saveProjectId = project?.id ?? null;
    ui.save.hidden = false;
    ui.saveProject.textContent = project ? `Project: ${project.name}` : 'Open a project first. Save writes into the active project.';
    ui.planNote.hidden = !(project && project.chatMode === 'plan');
    ui.saveError.hidden = true;
    ui.replace.hidden = true;
    ui.path.value = suggestedName(ui.art);
    ui.path.focus();
  }

  function closeSave(ui) {
    ui.save.hidden = true;
    ui.replace.hidden = true;
    ui.saveError.hidden = true;
    ui.saveProjectId = null;
  }

  function showSaveError(ui, message) {
    ui.saveError.textContent = message;
    ui.saveError.hidden = false;
  }

  function setBusy(ui, busy) {
    for (const node of [ui.saveGo, ui.saveCancel, ui.replaceGo, ui.replaceCancel]) node.disabled = busy;
  }

  // Writes the artifact into the active project. A file that exists comes back as { exists: true }; the replace row asks, with
  // Cancel focused, and a second request with overwrite replaces it (the server keeps the old copy as a checkpoint).
  async function saveFile(ui, overwrite) {
    const art = ui.art;
    const project = ui.saveProjectId ? (MuseUI.state.projects?.find(p => p.id === ui.saveProjectId) ?? null) : null;
    const path = ui.path.value.trim();
    if (!art) return;
    if (!project) {
      showSaveError(ui, 'Open a project first. Save writes into the active project.');
      return;
    }
    if (!path) {
      showSaveError(ui, 'Type a path inside the project folder, such as docs/page.html.');
      return;
    }
    if (ui.busy) return;
    ui.busy = true;
    setBusy(ui, true);
    ui.saveError.hidden = true;
    let asksReplace = false;
    try {
      const data = await MuseUI.api('/api/artifacts/save', { project: project.id, path, content: art.code, overwrite });
      if (data.exists) {
        asksReplace = true;
        ui.replaceText.textContent = `${path} already exists. Replace it? The old copy is kept as a checkpoint.`;
        ui.replace.hidden = false;
      } else {
        ui.replace.hidden = true;
        closeSave(ui);
        MuseUI.toast(`Saved ${data.path}`);
      }
    } catch (err) {
      const message = err?.message || 'The file could not be saved.';
      showSaveError(ui, message);
      MuseUI.toast(message, 'bad');
    } finally {
      ui.busy = false;
      setBusy(ui, false);
      // Cancel takes the focus only once its buttons are enabled again (a disabled button cannot take it).
      if (asksReplace) ui.replaceCancel.focus();
    }
  }

  // ---------- registration ----------

  MuseUI.pane.register({
    id: TAB,
    title: 'Artifacts',
    icon: 'file',
    order: 10,
    render: (body, api) => build(body, api),
    onShow: api => {
      const art = api.params?.artifact;
      if (art) show(api, art);
      else if (views.get(api)?.art) live = { api, ui: views.get(api) };
    },
    onClose: api => {
      const ui = views.get(api);
      if (live && live.ui === ui) live = null;
      if (ui) ui.stageSeq++;
      views.delete(api);
    },
  });

  // The chat changes whenever a reply streams, a thread opens or a block is added. One observer keeps every block's button and the list.
  new MutationObserver(queue).observe(MuseUI.el.chat, { childList: true, subtree: true });
  queue();
})();
