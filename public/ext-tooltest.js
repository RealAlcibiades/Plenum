// ext-tooltest. Builds on window.MuseUI (see app.js).
// "Tools for API models" in Settings › Accounts (pro-08, wave 9; UI-ARCH section 5 places it under Accounts). Each model that is not
// verified (xAI's catalog, an OpenRouter model, any model with a record) has a row: its status, the price estimate for one test, Test
// tools (an inline confirm, then the steps as they come in, and Stop), Details, and the Allow tools switch. A pass turns the switch on
// (amendment 28); the switch can also be turned on without a test, and then the Unverified notice shows. Every piece of text is set
// with textContent, and no style attribute or inline style is used. No key is handled here: the server reads the saved one.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without the settings registry there is nothing to attach to.
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SECTION_ID = 'tool-test';
  const TITLE = 'Tools for API models';
  const ORDER = 30;
  const INTRO = "Grok and OpenRouter models answer in text only until a model passes this test. The test runs Plenum's own file tools in a temporary folder, never your project, and costs a little through that model's API key. A pass turns Allow tools on for that model. You can also turn it on without a test. Ask first, the deny list and plan mode still apply.";
  const UNVERIFIED = 'Unverified: Plenum has not seen this model complete a tool call. Its calls may fail or come out malformed; every write and command still shows a card in Ask first.';
  const LOADING = 'Checking the models…';
  const ADDED_KEY = 'plenum.toolTest.added';
  const ID_SHAPE = /^[A-Za-z0-9._/:-]{1,120}$/;

  // Reads the ids the person added by hand, kept in this browser only. A browser that refuses storage just shows the server's list.
  function addedRefs() {
    try {
      const list = JSON.parse(window.localStorage.getItem(ADDED_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter(r => typeof r === 'string' && r.length <= 130) : [];
    } catch {
      return [];
    }
  }
  function rememberAdded(ref) {
    try {
      const list = addedRefs();
      if (!list.includes(ref)) window.localStorage.setItem(ADDED_KEY, JSON.stringify([...list, ref].slice(-20)));
    } catch {
      // Without storage the id is shown until the drawer is left.
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The day as the server writes it (UTC yyyy-mm-dd).
  const dayOf = record => (record && record.checkedOn ? record.checkedOn : '');

  // The one-line status for a record. A record of an older test version is not a pass, so it reads as not tested.
  function statusOf(record) {
    if (!record || record.result === 'untested') return { text: 'Not tested', tone: '' };
    if (record.result === 'pass') return { text: `Passed on ${dayOf(record)}`, tone: 'ok' };
    if (record.result === 'fail') {
      const step = (record.steps ?? []).find(s => s.n === record.failedStep);
      const name = step ? step.name : `step ${record.failedStep}`;
      return { text: `Failed on ${dayOf(record)} at step ${record.failedStep}: ${name}`, tone: 'bad' };
    }
    if (record.result === 'stale') return { text: 'Out of date: the model behind the name changed', tone: 'warn' };
    return { text: 'Not tested', tone: '' };
  }

  // One row of steps, from a record or from the live stream: "1. List the folder: Passed. Listed the folder."
  function stepItem(step) {
    const li = el('li', `tt-step ${step.ok ? 'ok' : 'bad'}`);
    li.append(el('span', 'tt-step-name', `${step.n}. ${step.name}: ${step.ok ? 'Passed' : 'Failed'}`));
    if (step.note) li.append(el('span', 'tt-step-note', ` ${step.note}`));
    return li;
  }

  // Reads the server's answer. A failed request says what the server said; the tokens are never shown.
  async function call(path, body, signal) {
    if (body !== undefined) return MuseUI.api(path, body);
    const res = await MuseUI.request(path, signal ? { signal } : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Reads the Server-Sent Events of the test. onEvent gets each parsed event. Lines that are not data are skipped.
  async function readEvents(body, onEvent) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            // A line that is not JSON is not an event.
          }
        }
      }
    }
  }

  // The section. Its rows are kept in a map by ref, and one test runs at a time for the whole section.
  function renderSection(body) {
    const state = { testing: false, rows: new Map(), list: el('div', 'tt-list'), addStatus: el('p', 'tt-status', '') };
    const section = el('div', 'tt-section');
    section.append(MuseUI.para(INTRO));
    section.append(state.list);
    section.append(addBox(state));
    body.replaceChildren(section);
    state.list.append(el('p', 'tt-status', LOADING));
    loadRows(state);
  }

  // Every row the server lists, then the ids the person added in this browser.
  async function loadRows(state) {
    let data;
    try {
      data = await call('/api/tool-test');
    } catch (err) {
      state.list.replaceChildren(errorLine(err.message, () => loadRows(state)));
      return;
    }
    state.list.replaceChildren();
    state.rows.clear();
    for (const row of data.rows ?? []) addRow(state, row);
    for (const ref of addedRefs()) {
      if (state.rows.has(ref)) continue;
      try {
        addRow(state, await call(`/api/tool-test?ref=${encodeURIComponent(ref)}`));
      } catch {
        // An id that no longer parses is left out.
      }
    }
    if (!state.rows.size) state.list.append(el('p', 'tt-status', 'No model needs a tool test right now. Add an OpenRouter model id below to test it.'));
  }

  function errorLine(message, retry) {
    const box = el('div', 'tt-error');
    box.append(el('p', 'tt-status bad', message));
    const again = MuseUI.button('ghost small', 'Try again');
    again.addEventListener('click', retry);
    box.append(again);
    return box;
  }

  // The box that adds an OpenRouter model id. The server checks the id (parseRef) before the row appears.
  function addBox(state) {
    const box = el('div', 'tt-add');
    const label = el('label', 'tt-add-label', 'OpenRouter model id');
    const input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'openrouter:vendor/model';
    input.setAttribute('aria-label', 'OpenRouter model id');
    label.append(input);
    const add = MuseUI.button('ghost small', 'Add');
    const go = async () => {
      const typed = input.value.trim();
      if (!typed) return;
      const id = typed.replace(/^openrouter:/i, '');
      if (!ID_SHAPE.test(id)) {
        state.addStatus.textContent = 'An OpenRouter model id is 1 to 120 characters: letters, digits and . / : _ - (written openrouter:<id>).';
        state.addStatus.className = 'tt-status bad';
        return;
      }
      const ref = `openrouter:${id}`;
      add.disabled = true;
      try {
        const data = await call(`/api/tool-test?ref=${encodeURIComponent(ref)}`);
        if (!state.rows.has(ref)) {
          const empty = state.list.querySelector('.tt-status');
          if (empty && !state.rows.size) empty.remove();
          addRow(state, data);
        }
        rememberAdded(ref);
        input.value = '';
        state.addStatus.textContent = '';
      } catch (err) {
        state.addStatus.textContent = err.message;
        state.addStatus.className = 'tt-status bad';
      } finally {
        add.disabled = false;
      }
    };
    add.addEventListener('click', go);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') go();
    });
    box.append(label, add, state.addStatus);
    return box;
  }

  // One model's row. data is the server's status for it (see statusOf in lib/routes/tool-test.mjs).
  function addRow(state, data) {
    const row = { ref: data.ref, data, state, dismissed: false };
    const root = el('div', 'tt-row');
    root.dataset.ref = data.ref;
    const head = el('div', 'tt-head');
    row.name = el('span', 'tt-name', data.label);
    row.pill = el('span', 'tt-pill', '');
    head.append(row.name, row.pill);
    row.estimate = el('p', 'tt-estimate', '');
    row.notice = el('div', 'tt-notice');
    row.noticeText = el('p', 'tt-notice-text', UNVERIFIED);
    row.noticeOk = MuseUI.button('ghost small', 'OK');
    row.noticeOk.addEventListener('click', () => {
      row.dismissed = true;
      row.notice.hidden = true;
    });
    row.notice.append(row.noticeText, row.noticeOk);

    row.test = MuseUI.button('ghost small', 'Test tools');
    row.test.addEventListener('click', () => showConfirm(row));
    row.details = MuseUI.button('ghost small', 'Details');
    row.details.setAttribute('aria-expanded', 'false');
    row.details.addEventListener('click', () => toggleDetails(row));
    row.switchInput = document.createElement('input');
    row.switchInput.type = 'checkbox';
    row.switchInput.addEventListener('change', () => setAllowed(row, row.switchInput.checked));
    const sw = el('label', 'switch tt-switch');
    const track = el('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    sw.append(row.switchInput, track, el('span', 'tt-switch-text', 'Allow tools'));
    row.actions = el('div', 'tt-actions');
    row.actions.append(row.test, row.details, sw);

    row.confirm = el('div', 'tt-confirm');
    row.confirm.hidden = true;

    row.live = el('div', 'tt-live');
    row.live.hidden = true;
    row.liveList = el('ol', 'tt-steps');
    row.progress = el('p', 'tt-progress', '');
    row.stop = MuseUI.button('ghost small', 'Stop');
    row.stop.addEventListener('click', () => row.ctrl?.abort());
    row.live.append(row.progress, row.liveList, row.stop);

    row.detailList = el('ol', 'tt-steps');
    row.detailList.hidden = true;
    row.result = el('p', 'tt-status tt-result', '');
    row.result.setAttribute('role', 'status');

    root.append(head, row.estimate, row.notice, row.actions, row.confirm, row.live, row.detailList, row.result);
    row.root = root;
    state.rows.set(data.ref, row);
    state.list.append(root);
    paint(row);
  }

  // Shows the row from its data: status, price line, the switch, the notice and the buttons.
  function paint(row) {
    const { data, state } = row;
    const record = data.record ?? null;
    const status = statusOf(record);
    row.pill.textContent = status.text;
    row.pill.className = status.tone ? `tt-pill ${status.tone}` : 'tt-pill';
    row.estimate.textContent = data.estimate?.text ?? '';
    row.switchInput.checked = data.allowed === true;
    row.switchInput.disabled = state.testing;
    const verified = record !== null && record.result === 'pass';
    const unverified = data.allowed === true && !verified;
    if (!unverified) row.dismissed = false;
    row.notice.hidden = !unverified || row.dismissed;
    row.test.disabled = state.testing || !data.keySaved;
    row.test.title = data.keySaved ? '' : `Save a key for ${data.providerLabel} first`;
    if (!row.detailList.hidden) fillDetails(row);
  }

  function fillDetails(row) {
    const steps = row.data.record?.steps ?? [];
    row.detailList.replaceChildren(...(steps.length ? steps.map(stepItem) : [el('li', 'tt-step', 'No test has run for this model yet.')]));
  }

  function toggleDetails(row) {
    row.detailList.hidden = !row.detailList.hidden;
    row.details.setAttribute('aria-expanded', String(!row.detailList.hidden));
    if (!row.detailList.hidden) fillDetails(row);
  }

  // Test tools first asks, with the price estimate, and only "Run test" starts the run.
  function showConfirm(row) {
    const { data } = row;
    row.confirm.replaceChildren();
    row.confirm.append(MuseUI.para(`Run the tool test on ${data.label}? ${data.estimate?.text ?? ''}.`));
    const run = MuseUI.button('primary small', 'Run test');
    const cancel = MuseUI.button('ghost small', 'Cancel');
    run.addEventListener('click', () => {
      row.confirm.hidden = true;
      runTest(row);
    });
    cancel.addEventListener('click', () => {
      row.confirm.hidden = true;
    });
    const actions = el('div', 'tt-confirm-actions');
    actions.append(run, cancel);
    row.confirm.append(actions);
    row.confirm.hidden = false;
    run.focus({ preventScroll: true });
  }

  // The run: the steps appear as the server judges them. Stop closes the request, and the server then stops the test and keeps nothing.
  async function runTest(row) {
    const { state } = row;
    state.testing = true;
    for (const r of state.rows.values()) paint(r);
    row.ctrl = new AbortController();
    row.live.hidden = false;
    row.liveList.replaceChildren();
    row.progress.textContent = 'Starting the test…';
    row.result.textContent = '';
    row.result.className = 'tt-status tt-result';
    let calls = 0;
    try {
      const res = await MuseUI.request('/api/tool-test', { method: 'POST', body: { ref: row.ref }, signal: row.ctrl.signal });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      await readEvents(res.body, ev => {
        if (ev.type === 'call') {
          calls += 1;
          row.progress.textContent = `Working: ${calls} tool ${calls === 1 ? 'call' : 'calls'} so far`;
        } else if (ev.type === 'step') {
          row.liveList.append(stepItem(ev));
        } else if (ev.type === 'result') {
          row.data.record = ev.record;
          row.data.allowed = ev.record?.allowed === true;
          if (ev.record?.result === 'pass') {
            row.result.textContent = `Passed. Allow tools is on for ${row.data.label}.`;
            row.result.className = 'tt-status tt-result ok';
            MuseUI.toast(`${row.data.label} passed the tool test. Allow tools is on.`);
          } else {
            const failed = (ev.record?.steps ?? []).find(s => s.n === ev.record?.failedStep);
            row.result.textContent = `Failed at step ${ev.record?.failedStep ?? '?'}${failed ? `: ${failed.name}` : ''}. Allow tools is off.`;
            row.result.className = 'tt-status tt-result bad';
          }
        } else if (ev.type === 'error') {
          row.result.textContent = ev.message || 'The tool test could not run.';
          row.result.className = 'tt-status tt-result bad';
        }
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        row.result.textContent = 'Stopped. Nothing was saved.';
        row.result.className = 'tt-status tt-result';
      } else {
        row.result.textContent = err.message;
        row.result.className = 'tt-status tt-result bad';
      }
    } finally {
      row.ctrl = null;
      row.live.hidden = true;
      state.testing = false;
      // The row is read again from the server, so the status and the switch are what the server holds.
      try {
        const fresh = await call(`/api/tool-test?ref=${encodeURIComponent(row.ref)}`);
        row.data = fresh;
      } catch {
        // The row keeps the answer the test gave.
      }
      if (row.data.record) fillDetails(row);
      for (const r of state.rows.values()) paint(r);
    }
  }

  // The switch. A change is saved at once; a refused change puts the switch back and says why.
  async function setAllowed(row, on) {
    row.switchInput.disabled = true;
    try {
      const data = await MuseUI.api('/api/tool-test/allow', { ref: row.ref, allowed: on });
      row.data.record = data.record ?? null;
      row.data.allowed = data.allowed === true;
    } catch (err) {
      row.data.allowed = !on;
      row.result.textContent = err.message;
      row.result.className = 'tt-status tt-result bad';
    } finally {
      for (const r of row.state.rows.values()) paint(r);
    }
  }

  MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: TITLE, group: 'accounts', order: ORDER, render: renderSection });
})();
