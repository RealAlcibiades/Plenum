// Edit, Rewind, regenerate and copy on every turn. Loaded by ext.js and adds itself through window.MuseUI.
// Under each turn sits a small row of ghost buttons. A question gets Edit: it and the messages after it leave the chat
// (POST /api/chat/rewind), and its text goes back into the composer. A question of the chat also gets Rewind (pro-05): the
// choices are Code and chat, Code only and Chat only. Code is the files of the project: the turn snapshot taken before that question
// (lib/hooks/10-snapshot.mjs) puts them back after an approval card (window.MuseRestore, public/ext-checkpoints.js). Chat only cuts the
// chat like Edit, without filling the composer. A reply gets Copy (its Markdown, to the clipboard) and Insert (into the composer). The
// last reply of the chat also gets Regenerate: the chat is cut back to the question before it, and that question is sent again, to the
// chat's model or to the one chosen in the row. A panel may add its own buttons to a turn's row: every function in window.MuseTurnExtras
// is called with { kind, message, index, messages, article } and the nodes it returns go into the row.
// The rows are drawn and used only while the page is idle. The server does the cutting; this file only draws the rows and sends the text back.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const BAR = 'ext-turns-bar';
  const COPIED_MS = 1400;
  // True while an Edit or a Regenerate request is on its way, so the rows wait and a second request cannot start.
  let working = false;
  // Set while a redraw of the rows is queued for the next frame, so a burst of changes is drawn once.
  let frame = 0;

  // app.js puts Stop on the send button while a reply streams. The rows are drawn and used only when this is false.
  const runGoing = () => MuseUI.el.send.classList.contains('stop');
  const composerHasText = () => MuseUI.el.input.value.trim() !== '';

  // The messages that draw a question turn, in order, each with its place in the transcript. This mirrors messageNodes in
  // app.js: a compact summary and a build's own note draw no question turn, and every other user message does. A council
  // question draws one too, and it gets no row, because the server edits only plain questions.
  function questionsOf(messages) {
    const out = [];
    messages.forEach((m, index) => {
      if (m.role === 'user' && !m.compact && m.kind !== 'build') out.push({ m, index });
    });
    return out;
  }

  // The messages that draw a reply turn, in order, with their place. This mirrors messageNodes as well: a reply made only of
  // tool steps draws no turn, and council, build and advisor messages draw their own cards. A reply that failed or was stopped, with no text and
  // no steps, draws an error line or a quiet note instead of a reply turn (app.js, B-49).
  function repliesOf(messages) {
    const out = [];
    messages.forEach((m, index) => {
      if (m.role === 'user' || m.compact) return;
      if (m.kind === 'council' || m.kind === 'build' || m.kind === 'advisor') return;
      const hasText = String(m.content ?? '').trim() !== '';
      if (!hasText && (m.error || m.aborted)) return;
      if (hasText || !(m.tools ?? []).length) out.push({ m, index });
    });
    return out;
  }

  // The place of the plain question that a reply answers: the last one before the reply, or -1 when there is none.
  function questionBefore(messages, at) {
    for (let i = at - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && m.kind === 'chat' && !m.compact) return i;
    }
    return -1;
  }

  // Puts text in the composer the way a reply is put there: the box resizes (app.js listens for input) and takes focus.
  function setComposer(text) {
    const input = MuseUI.el.input;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function rowOf(controls) {
    const row = document.createElement('div');
    row.className = BAR;
    row.append(...controls);
    return row;
  }

  // The nodes the panels that registered in window.MuseTurnExtras add for one turn. A function that fails is logged and skipped.
  // The reply element is also reachable as classList, because the Review button (ext-review.js) reads the element it is given.
  function extrasFor(kind, message, index, messages, article) {
    const out = [];
    const extras = Array.isArray(window.MuseTurnExtras) ? window.MuseTurnExtras : [];
    for (const fn of extras) {
      if (typeof fn !== 'function') continue;
      try {
        const ctx = { kind, message, index, messages, article };
        Object.defineProperty(ctx, 'classList', { get: () => article.classList });
        const got = fn(ctx);
        for (const node of Array.isArray(got) ? got : [got]) {
          if (node instanceof Node) out.push(node);
        }
      } catch (err) {
        console.error('A turn extra could not draw its button:', err);
      }
    }
    return out;
  }

  // Puts text on the clipboard. The clipboard API is missing, or refuses (no permission, or a page that is not secure). Then a
  // hidden text box holds the text, the page's copy command takes it, and the box is removed. False only when both fail.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The copy command below is the fallback.
    }
    const was = document.activeElement;
    const box = document.createElement('textarea');
    box.className = 'ext-turns-copy';
    box.readOnly = true;
    box.value = text;
    document.body.append(box);
    let ok = false;
    try {
      box.select();
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    } finally {
      box.remove();
      if (was instanceof HTMLElement) was.focus();
    }
    return ok;
  }

  // Copy: the reply's Markdown, as it was written, and the button reads Copied for a moment.
  function copyButton(m) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Copy');
    b.title = 'Copy this reply as Markdown';
    let timer = 0;
    b.addEventListener('click', async () => {
      if (!(await copyText(String(m.content ?? '')))) {
        MuseUI.toast('The reply could not be copied. Select the text and copy it instead.', 'bad');
        return;
      }
      clearTimeout(timer);
      b.textContent = 'Copied';
      timer = setTimeout(() => { b.textContent = 'Copy'; }, COPIED_MS);
    });
    return b;
  }

  // Insert: into an empty composer at once. With text in the composer, Append and Replace take the button's place, so
  // nothing that was typed is lost without a choice.
  function insertButton(text) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Insert');
    b.title = 'Put this reply in the composer to edit';
    b.addEventListener('click', () => {
      if (!composerHasText()) {
        setComposer(text);
        MuseUI.toast('Reply inserted. Edit it, then send.');
        return;
      }
      const append = MuseUI.button('ghost small ext-turns-btn', 'Append');
      append.title = 'Add this reply after the text in the composer';
      const replace = MuseUI.button('ghost small ext-turns-btn', 'Replace');
      replace.title = 'Replace the text in the composer with this reply';
      // Either choice puts Insert back in the row, for the next reply.
      const done = () => {
        append.replaceWith(insertButton(text));
        replace.remove();
      };
      append.addEventListener('click', () => {
        const current = MuseUI.el.input.value;
        setComposer(`${current}${current.endsWith('\n') ? '\n' : '\n\n'}${text}`);
        done();
      });
      replace.addEventListener('click', () => {
        setComposer(text);
        done();
      });
      b.replaceWith(append, replace);
      append.focus();
    });
    return b;
  }

  // Council mode is the mode button that is pressed. Sent as plain text there, a question would ask every seat.
  const councilOn = () => document.querySelector('.seg-btn[data-mode][aria-pressed="true"]')?.dataset.mode === 'council';

  // The text that sends a question again. With a model chosen it goes through /ask. Without one, a question that starts with
  // a slash would run as a command, and in Council mode a plain send would ask every seat. Both go through /ask with the
  // chat's own model, which is what a plain send uses in Chat mode.
  function sendText(text, ref) {
    if (ref) return `/ask ${ref} ${text}`;
    if ((text.startsWith('/') || councilOn()) && MuseUI.state.model) return `/ask ${MuseUI.state.model} ${text}`;
    return text;
  }

  // Cuts the chat back to the message at index on the server, then draws the chat again. Resolves to the text of the
  // question that was cut, or to null when the server refused (the reason is shown).
  async function cutBack(index) {
    working = true;
    decorate();
    try {
      const data = await MuseUI.api('/api/chat/rewind', { project: MuseUI.state.activeProject, index });
      await MuseUI.refresh();
      return String(data.text ?? '');
    } catch (err) {
      MuseUI.toast(err.message, 'bad');
      return null;
    } finally {
      working = false;
      schedule();
    }
  }

  // What the Edit confirm says goes: the question, the messages after it (n of them), and where its text goes.
  function editGoes(n) {
    if (n === 0) return 'It is removed from the chat and its text goes back to the composer.';
    const which = n === 1 ? 'It and the message after it' : `It and the ${n} messages after it`;
    return `${which} are removed from the chat, and the text goes back to the composer.`;
  }

  // Edit: the question and everything after it go, and the question goes back into the composer to be changed and sent.
  async function editQuestion(index) {
    if (working || runGoing()) return;
    if (composerHasText()) return MuseUI.toast('The composer already has text. Clear it first, then edit the message.', 'bad');
    const n = (MuseUI.state.messages ?? []).length - index - 1;
    if (!window.confirm(`Edit this message? ${editGoes(n)} Undo stays above the composer until you send a message.`)) return;
    const text = await cutBack(index);
    if (text === null) return;
    setComposer(text);
  }

  function editButton(index) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Edit');
    b.title = 'Edit this message. It and the replies after it are removed, and the text goes into the composer';
    b.addEventListener('click', () => editQuestion(index));
    return b;
  }

  // ---------- Rewind (pro-05) ----------

  const enc = encodeURIComponent;
  // Said in the Rewind tooltips: what a turn snapshot leaves out (lib/shadow.mjs), so a person does not expect those files back.
  const SECRETS_NOTE = 'Secret files such as .env and private keys are not kept and are not restored.';
  // The project the chat is on, for every rewind request.
  const activeProject = () => MuseUI.state.activeProject;

  // Why a question has no code snapshot, for the disabled choices. The server says it in record.snap.skipped.
  function noSnapshotReason(m) {
    if (m.snap?.expired === true) return 'it is older than the last 50 turns, so its code is no longer kept';
    if (typeof m.snap?.skipped === 'string' && m.snap.skipped) return m.snap.skipped;
    return 'it was sent before turn snapshots were kept';
  }

  // The chat-only confirm: how many messages go, and the Undo line that stays above the composer.
  function chatGoes(n) {
    if (n === 0) return 'It is removed from the chat.';
    return n === 1 ? 'It and the message after it are removed.' : `It and the ${n} messages after it are removed.`;
  }

  // Chat only: the chat is cut back to the question, as Edit does, and the composer is left as it is.
  async function rewindChat(index) {
    if (working || runGoing()) return;
    const n = (MuseUI.state.messages ?? []).length - index - 1;
    const ok = await MuseUI.confirm({
      title: 'Rewind the chat to before this message?',
      body: `${chatGoes(n)} Undo stays above the composer until you send a message.`,
      action: 'Rewind chat',
      tone: 'danger',
      focusCancel: true,
    });
    if (!ok) return;
    await cutBack(index);
  }

  // The button in the drawer that undoes the code rewind (the server keeps the files as they were before it, for this scope).
  function undoButton() {
    const b = MuseUI.button('ghost', 'Undo code rewind');
    b.title = 'Put back the files this rewind changed';
    b.addEventListener('click', () => {
      window.MuseRestore?.run({
        title: 'Undo code rewind',
        url: '/api/snapshots/rewind',
        payload: { project: activeProject(), undo: true },
        diffUrl: `/api/snapshots/diff?project=${enc(activeProject())}&undo=1`,
        approveText: 'Approve undo',
        restoredText: ev => `Undo done: put back ${(ev.files ?? []).length} files and removed ${(ev.removed ?? []).length}.`,
      });
    });
    return b;
  }

  // Code only: the files go back to before this question. The card lists them, and the drawer offers Undo once they are back.
  function rewindCode(index, after) {
    return window.MuseRestore?.run({
      title: 'Rewind code',
      url: '/api/snapshots/rewind',
      payload: { project: activeProject(), index },
      diffUrl: `/api/snapshots/diff?project=${enc(activeProject())}&index=${index}`,
      approveText: 'Approve rewind',
      onEnd: (ev, view) => {
        // A rewind that stopped part way keeps its record (the server says so with undo set), so Undo is offered for it as well. The chat is
        // cut back only when the rewind finished.
        const kept = ev.type === 'error' && ev.undo === true;
        if (ev.type !== 'restored' && !kept) return;
        view.actions.append(undoButton());
        if (ev.type === 'restored' && after) after();
      },
    });
  }

  // The three choices that take the Rewind button's place. The two code choices need the snapshot the turn kept before it.
  function choiceButtons(m, index) {
    const hasSnap = typeof m.snap?.before?.tree === 'string' && m.snap.expired !== true;
    const reason = noSnapshotReason(m);
    const disabledTitle = `No snapshot before this turn: ${reason}`;
    const both = MuseUI.button('ghost small ext-turns-btn', 'Code and chat');
    both.title = hasSnap ? `Put the files back, then cut the chat back to before this message. ${SECRETS_NOTE}` : disabledTitle;
    both.disabled = !hasSnap;
    both.addEventListener('click', () => rewindCode(index, () => cutBack(index)));
    const code = MuseUI.button('ghost small ext-turns-btn', 'Code only');
    code.title = hasSnap ? `Put the files back to before this message; the chat stays. ${SECRETS_NOTE}` : disabledTitle;
    code.disabled = !hasSnap;
    code.addEventListener('click', () => rewindCode(index));
    const chat = MuseUI.button('ghost small ext-turns-btn', 'Chat only');
    chat.title = 'Cut the chat back to before this message, as Edit does; the files stay';
    chat.addEventListener('click', () => rewindChat(index));
    const cancel = MuseUI.button('ghost small ext-turns-btn', 'Cancel');
    cancel.title = 'Keep the chat and the files as they are';
    // Cancel puts the Rewind button back in the choices' place.
    cancel.addEventListener('click', () => {
      both.replaceWith(rewindGhost(m, index));
      code.remove();
      chat.remove();
      cancel.remove();
    });
    return [both, code, chat, cancel];
  }

  // The Rewind ghost button. Its click swaps in the choices, and Cancel swaps the button back.
  function rewindGhost(m, index) {
    const b = MuseUI.button('ghost small ext-turns-btn', 'Rewind');
    b.title = `Rewind code, chat or both to before this message. ${SECRETS_NOTE}`;
    b.addEventListener('click', () => {
      if (working || runGoing()) return;
      b.replaceWith(...choiceButtons(m, index));
    });
    return b;
  }

  // Regenerate: the chat is cut back to the question, and the question is sent again. The reply it gets replaces this one.
  async function regenerate(questionIndex, ref) {
    if (working || runGoing()) return;
    if (composerHasText()) return MuseUI.toast('The composer already has text. Clear it first, then regenerate the reply.', 'bad');
    // Without a chat model there is nothing to send the question to, so nothing is cut.
    if (!ref && councilOn() && !MuseUI.state.model) return MuseUI.toast('Choose a model first, then regenerate the reply.', 'bad');
    const text = await cutBack(questionIndex);
    if (text === null) return;
    setComposer(sendText(text, ref));
    MuseUI.el.form.requestSubmit();
  }

  // The model choice and the Regenerate button. The first choice is the chat's own model; then every model in the catalog.
  function regenerateControls(questionIndex) {
    const select = document.createElement('select');
    select.className = 'ext-turns-model';
    select.title = 'The model that writes the new reply';
    select.setAttribute('aria-label', 'Model for the new reply');
    select.append(new Option('Same model', ''));
    for (const c of MuseUI.catalog ?? []) {
      const ref = `${c.provider}:${c.id}`;
      select.append(new Option(MuseUI.modelName(ref), ref));
    }
    const b = MuseUI.button('ghost small ext-turns-btn', 'Regenerate');
    b.title = 'Ask the question again, and replace this reply with the new one';
    b.addEventListener('click', () => regenerate(questionIndex, select.value));
    return [select, b];
  }

  // Draws the rows. Only while idle; the rows already on the page are kept, but none of their controls can be pressed.
  function decorate() {
    const idle = !working && !runGoing();
    for (const control of MuseUI.el.chat.querySelectorAll(`.${BAR} button, .${BAR} select`)) control.disabled = !idle;
    if (!idle) return;
    const messages = MuseUI.state.messages ?? [];
    const questions = questionsOf(messages);
    const replies = repliesOf(messages);
    const questionEls = [...MuseUI.el.chat.querySelectorAll('.turn.user')];
    const replyEls = [...MuseUI.el.chat.querySelectorAll('.turn.assistant')];
    // Each turn on the page must match a message, one for one, or a row would land on the wrong turn. A difference means the
    // page is still being drawn, so nothing is decorated until it is.
    if (questionEls.length !== questions.length || replyEls.length !== replies.length) return;

    questions.forEach(({ m, index }, i) => {
      const article = questionEls[i];
      if (m.kind !== 'chat' || article.querySelector(`:scope > .${BAR}`)) return;
      article.append(rowOf([editButton(index), rewindGhost(m, index), ...extrasFor('question', m, index, messages, article)]));
    });

    // Only the last reply of the chat itself is regenerated, so the row is added for that one reply.
    const chatReplies = replies.filter(r => r.m.kind === 'chat');
    const lastChat = chatReplies[chatReplies.length - 1];
    replies.forEach((r, i) => {
      const article = replyEls[i];
      if (article.querySelector(`:scope > .${BAR}`)) return;
      const controls = [copyButton(r.m), insertButton(String(r.m.content ?? ''))];
      const question = r === lastChat ? questionBefore(messages, r.index) : -1;
      if (question >= 0) controls.push(...regenerateControls(question));
      controls.push(...extrasFor('reply', r.m, r.index, messages, article));
      article.append(rowOf(controls));
    });
  }

  // The rows are drawn in the next frame, once the changes of a redraw are all in.
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      decorate();
    });
  }

  // The page redraws the chat by replacing its children, and the send button changes class when a run starts or ends.
  new MutationObserver(schedule).observe(MuseUI.el.chat, { childList: true, subtree: true });
  new MutationObserver(schedule).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });
  schedule();
})();
