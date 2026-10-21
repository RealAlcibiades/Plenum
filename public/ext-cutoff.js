// Marks a reply that stopped at the model's output limit. Loaded by ext.js and adds itself through window.MuseUI.
// The server stores stop: 'length' on a reply that was cut, and on no other (runTurn in server.mjs). When the page is idle and
// that reply is the last chat message, a note goes under it with a Continue button. Continue sends an ordinary chat message
// that asks the model to carry on, so it goes through the normal path with its approval cards and every other rule.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to.
  if (!MuseUI) return;

  const NOTE = 'This reply was cut off at the model\'s output limit. If it keeps happening, lower the Effort.';
  const PROMPT = 'Continue exactly where you left off. Do not repeat what you already wrote.';

  // True while a check is waiting for the next frame, so a burst of redraws is looked at once.
  let queued = false;

  // A run in progress shows Stop on the send button, and then no note is shown.
  const idle = () => !MuseUI.el.send.classList.contains('stop');

  // The last message of the chat itself. Advisor, council and build turns are skipped, so a review that follows a cut
  // reply does not hide the note.
  function lastChat() {
    const list = MuseUI.state.messages ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if ((m.role === 'user' || m.role === 'assistant') && (!m.kind || m.kind === 'chat')) return m;
    }
    return null;
  }

  // Keeps one note under the last assistant turn when its reply was cut, and removes every other note. Idempotent, so the
  // redraw that adding a note causes changes nothing.
  function sync() {
    queued = false;
    const chat = MuseUI.el.chat;
    const last = idle() ? lastChat() : null;
    const cut = last?.role === 'assistant' && last.stop === 'length' && (last.content ?? '').trim();
    const target = cut ? [...chat.querySelectorAll('.turn.assistant')].at(-1) ?? null : null;
    let kept = null;
    for (const note of chat.querySelectorAll('.ext-cutoff')) {
      if (target && !kept && note.parentElement === target) kept = note;
      else note.remove();
    }
    if (target && !kept) target.append(noteEl());
  }

  function noteEl() {
    const note = document.createElement('div');
    note.className = 'ext-cutoff';
    const text = document.createElement('span');
    text.className = 'ext-cutoff-text';
    text.textContent = NOTE;
    const go = MuseUI.button('ghost small ext-cutoff-go', 'Continue');
    go.title = 'Ask the model to carry on from where this reply stopped';
    go.addEventListener('click', continueReply);
    note.append(text, go);
    return note;
  }

  // Puts the Continue message in the composer and sends it like a typed message. Nothing is sent over a run in progress (Send
  // would stop it), over a draft or pictures in the composer (they would be replaced or sent along), or in council mode (Send
  // would ask every seat).
  function continueReply() {
    if (!idle()) return;
    const mode = document.querySelector('.seg-btn[data-mode][aria-pressed="true"]')?.dataset.mode;
    if (mode === 'council') return MuseUI.toast('Switch to Chat to continue this reply.', 'bad');
    const pictures = window.MuseImages?.list?.() ?? [];
    if (MuseUI.el.input.value.trim() || pictures.length) {
      return MuseUI.toast('Clear the composer first, its text and pictures, then press Continue.', 'bad');
    }
    MuseUI.el.input.value = PROMPT;
    MuseUI.el.input.dispatchEvent(new Event('input', { bubbles: true }));
    MuseUI.el.form.requestSubmit();
  }

  // A redraw of the chat, or the send button changing between Send and Stop, is looked at on the next frame, once.
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  }
  new MutationObserver(schedule).observe(MuseUI.el.chat, { childList: true, subtree: true });
  new MutationObserver(schedule).observe(MuseUI.el.send, { attributes: true, attributeFilter: ['class'] });
  schedule();
})();
