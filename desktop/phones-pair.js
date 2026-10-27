// The pairing window's page (desktop/phones-pair.html). The desktop sends one payload at a time through window.plenumPair.onOffer;
// this script draws the state it names and sends one answer back. It builds every element with createElement and textContent: no
// markup strings, no inline code, no network. The payload's text is the server's and the phone's, so it is only ever shown as text.
// States (desktop/handlers/phones.cjs): loading, offer, no-carrier, needs-build, confirm, allowed, denied, expired, failed3.
(() => {
  'use strict';

  const api = window.plenumPair;
  const body = document.getElementById('body');
  const actions = document.getElementById('actions');
  const sub = document.getElementById('sub');
  const pair = document.getElementById('pair');

  // The countdown on the offer. The deadline is set once per offer (its seq), so a re-draw of the same offer (for example after
  // "Link copied") keeps the time that is left.
  let countdownSeq = null;
  let deadline = 0;
  let countdownTimer = null;
  let expiresEl = null;
  // The timer that closes the window on its own after a final state: five seconds after "allowed", two minutes otherwise.
  let autoTimer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Sends one action to the desktop. Allow and Deny are sent once: the buttons are disabled as soon as one is pressed.
  function send(action, control) {
    if (!api) return;
    if (action === 'allow' || action === 'deny') {
      for (const button of actions.querySelectorAll('button')) button.disabled = true;
      body.setAttribute('aria-busy', 'true');
      if (control) control.textContent = action === 'allow' ? 'Allowing' : 'Denying';
    }
    api.answer(action);
  }

  function button(label, action, kind) {
    const node = el('button', `btn${kind ? ` ${kind}` : ''}`, label);
    node.type = 'button';
    node.addEventListener('click', () => send(action, node));
    return node;
  }

  function stopCountdown() {
    if (countdownTimer !== null) clearInterval(countdownTimer);
    countdownTimer = null;
    expiresEl = null;
  }

  function tick() {
    if (!expiresEl) return;
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    expiresEl.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  // Counts down the time left on the offer, shown after the computer's name in the subtitle.
  function startCountdown(seq, seconds, holder) {
    stopCountdown();
    if (seq !== countdownSeq) {
      countdownSeq = seq;
      deadline = Date.now() + seconds * 1000;
    }
    expiresEl = holder;
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function scheduleClose(ms) {
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => send('done'), ms);
  }

  // The device's name for a sentence: "Will's iPhone", or "The phone" when the phone sent none.
  function deviceName(offer) {
    const name = offer.device && typeof offer.device.name === 'string' ? offer.device.name.trim() : '';
    return name || 'The phone';
  }

  // The tier the phone gets if allowed: full, approve or read. Anything else is Full control, as the handler sends it.
  function tierOf(offer) {
    return ['full', 'approve', 'read'].includes(offer.tier) ? offer.tier : 'full';
  }

  // The words under the code for a phone's tier (the phone is given it when it is allowed).
  const TIER_NOTE = {
    full: 'It will have Full control. You can lower that any time under Settings › Phones.',
    approve: 'It will have Approve and watch. You can change that under Settings › Phones.',
    read: 'It will have Read only. You can change that under Settings › Phones.',
  };

  // Shown when a web page is the way a phone pairs: that page is sent without encryption.
  const isWebPage = offer => Boolean(offer.device) && offer.device.app === 'lan-web';

  function subtitle(offer) {
    sub.textContent = `Plenum on ${offer.name || 'this computer'}`;
  }

  function renderOffer(offer) {
    subtitle(offer);
    const hold = el('span', 'expires');
    sub.append(' · ', hold);
    const strip = el('div', 'strip danger');
    strip.setAttribute('role', 'note');
    strip.append(
      el('p', 'strip-title', 'A paired phone is as powerful as this window.'),
      el('p', 'strip-text', 'A paired phone can do everything this window can. Stop on the bar or on the phone ends every run.'),
    );
    body.append(strip);

    if (offer.captureVisible) {
      body.append(el('div', 'qr-hidden', 'Screen capture can see this window on this computer, so the code is hidden. Use Copy link and open the link on your phone.'));
    } else if (offer.qrPng) {
      const frame = el('div', 'qr-frame');
      const image = document.createElement('img');
      image.className = 'qr';
      image.alt = 'Pairing code. Scan it with the Plenum app, or with your phone camera to open the web app.';
      image.src = offer.qrPng;
      frame.append(image);
      body.append(frame);
    } else {
      body.append(el('div', 'qr-hidden', 'The code is not ready. Try a new code.'));
    }

    body.append(el('p', 'lede', "Scan with the Plenum app, or with your phone's camera to open the web app."));
    if (offer.qrKind === 'lan') {
      body.append(el('p', 'note', 'The web page this code opens is sent without encryption on this network. On a network you do not trust, scan the code with the Plenum app instead.'));
    }
    if (offer.tried === true) {
      body.append(el('p', 'warn', 'Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.'));
    }
    if (offer.left === true) {
      body.append(el('p', 'warn', 'The phone that was waiting left before you answered. Scan the code again.'));
    }

    if (Array.isArray(offer.hints) && offer.hints.length > 0) {
      body.append(el('p', 'hints-title', 'Your phone can reach this computer through:'));
      const list = el('ul', 'hints');
      for (const hint of offer.hints) {
        const item = el('li', hint.on ? 'on' : 'off');
        item.append(el('span', 'dot', hint.on ? '●' : '○'), el('span', 'hint-text', String(hint.label)));
        list.append(item);
      }
      body.append(list);
    }
    body.append(el('p', 'note', 'The link works like the code and leaves the clipboard when the code expires.'));

    const status = el('p', 'status', offer.copied === true ? 'Link copied.' : '');
    status.setAttribute('role', 'status');
    const copy = button('Copy link', 'copy', 'primary');
    actions.append(status, copy, button('Cancel', 'cancel'));
    startCountdown(offer.seq, Number(offer.expiresInS) || 0, hold);
    copy.focus();
  }

  function renderConfirm(offer) {
    subtitle(offer);
    const device = deviceName(offer);
    const platform = isWebPage(offer) ? 'Web page (plain http)' : offer.device?.platform;
    const kind = offer.device ? [platform, offer.device.carrier].filter(Boolean).join(' · ') : '';
    body.append(el('p', 'device-name', `${device} wants to pair`));
    if (kind) body.append(el('p', 'device-kind', kind));
    body.append(el('p', 'code-label', 'Code on the phone'));
    const code = typeof offer.code === 'string' && /^\d{6}$/.test(offer.code) ? offer.code : '';
    body.append(el('p', 'code', code ? `${code.slice(0, 3)} ${code.slice(3)}` : '--- ---'));
    body.append(el('p', 'lede', 'Allow only if the phone shows the same code.'));
    const tier = tierOf(offer);
    body.append(el('p', 'note', `${TIER_NOTE[tier]}${isWebPage(offer) ? ' It came from a web page sent without encryption, so on a network you do not trust, set it to Approve and watch after pairing.' : ''}`));
    if (offer.second === true) {
      body.append(el('p', 'warn', 'Another device also used this code. If you did not expect that, click Deny and start again.'));
    }
    if (offer.tried === true) {
      body.append(el('p', 'warn', 'Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.'));
    }
    const deny = button('Deny', 'deny');
    const allow = button('Allow', 'allow', 'primary');
    actions.append(deny, allow);
    // Deny has the first focus, so Enter denies.
    deny.focus();
  }

  function renderFinal(offer, text, buttons) {
    subtitle(offer);
    body.append(el('p', 'lede', text));
    for (const [label, action, kind] of buttons) actions.append(button(label, action, kind));
    const first = actions.querySelector('button');
    if (first) first.focus();
  }

  // Draws one payload. Every state starts from an empty window, so nothing from the last state is left behind.
  function render(offer) {
    if (!offer || typeof offer !== 'object') return;
    stopCountdown();
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = null;
    body.replaceChildren();
    actions.replaceChildren();
    body.removeAttribute('aria-busy');
    pair.dataset.state = typeof offer.state === 'string' ? offer.state : 'loading';

    switch (offer.state) {
      case 'offer':
        renderOffer(offer);
        break;
      case 'no-carrier':
        renderFinal(offer, 'Turn on at least one way first in Settings › Phones: Same network, Tailscale or a relay.', [['Close', 'done']]);
        break;
      case 'needs-build':
        renderFinal(offer, 'Pairing needs a newer build of Plenum. Update Plenum, then try again.', [['Close', 'done']]);
        break;
      case 'confirm':
        renderConfirm(offer);
        break;
      case 'allowed': {
        const tier = tierOf(offer);
        const text = tier === 'full'
          ? `${deviceName(offer)} is paired. It can now do everything this window can. Remove it any time under Settings › Phones.`
          : `${deviceName(offer)} is paired with ${tier === 'approve' ? 'Approve and watch' : 'Read only'}. Change it any time under Settings › Phones.`;
        renderFinal(offer, text, [['Done', 'done', 'primary']]);
        scheduleClose(5000);
        break;
      }
      case 'denied':
        renderFinal(offer, `${deviceName(offer)} was not paired.`, [['Close', 'done']]);
        scheduleClose(120000);
        break;
      case 'expired':
        renderFinal(offer, 'The code expired. No phone was paired.', [['New code', 'new-code', 'primary'], ['Close', 'done']]);
        scheduleClose(120000);
        break;
      case 'failed3':
        renderFinal(offer, 'Three tries with this code failed, so it was stopped. No phone was paired.', [['New code', 'new-code', 'primary']]);
        scheduleClose(120000);
        break;
      default:
        subtitle(offer);
        body.append(el('p', 'lede', 'Getting the code ready.'));
    }
  }

  if (!api || typeof api.onOffer !== 'function') {
    sub.textContent = '';
    body.append(el('p', 'lede', 'This window could not start. Close it and try again.'));
    return;
  }
  api.onOffer(render);
})();
