// fixture.js (mob-18). Stands in for the shell's screens until mobile/www holds the real shell. Plain text only (textContent), no
// storage, no network, no inline script. plenumFixture.show(screen, data) draws one state; data keys: code, device, desktop, carrier,
// lastSeen, command, ack. The pairing fragment (#pair=...) is read once and removed from the address bar at once: it holds the secret.
(function () {
  'use strict';

  const TEXT = {
    pairing: { title: 'Pairing', chip: 'Pairing', head: 'Connecting to your computer', body: 'Checking the link with this computer.' },
    code: { title: 'Pairing', chip: 'Pairing', head: 'Does this match your computer?', body: 'Compare these six digits with the ones on your computer, then wait for Allow there.' },
    connected: { title: 'Connected', chip: 'Connected', head: 'Connected', body: 'The UI loads here, and the Stop bar stays at the bottom.' },
    offline: { title: 'Offline', chip: 'Computer offline', head: 'Your computer is not answering', body: 'Last seen {lastSeen}. Plenum reconnects when the computer answers.' },
    reconnecting: { title: 'Reconnecting', chip: 'Reconnecting', head: 'Reconnecting', body: 'Trying the next way to reach your computer.' },
    approval: { title: 'Approval', chip: 'Waiting for approval', head: 'Approve this run?', body: 'Plenum wants to run a command on your computer.' },
    'stop-pressed': { title: 'Stopping', chip: 'Stopping', head: 'Stop sent', body: 'Waiting for your computer to confirm the stop.' },
  };

  const $ = id => document.getElementById(id);

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }

  function show(screen, data = {}) {
    if (!Object.prototype.hasOwnProperty.call(TEXT, screen)) throw new Error(`unknown screen ${String(screen)}`);
    const t = TEXT[screen];
    document.body.dataset.screen = screen;
    $('fx-title').textContent = t.title;
    $('fx-chip').textContent = screen === 'connected' && data.carrier ? `${data.carrier}: ${data.desktop ?? 'Computer'}` : t.chip;
    const box = $('fx-screen');
    box.replaceChildren();
    box.append(element('h1', 'fx-head', t.head));
    const bodyText = t.body.replace('{lastSeen}', data.lastSeen ?? 'a few minutes ago');
    box.append(element('p', 'fx-text', bodyText));

    if (screen === 'code') {
      box.append(element('p', 'fx-code', String(data.code ?? '000000')));
    }
    if (screen === 'connected') {
      const list = element('dl', 'fx-list');
      list.append(element('dt', '', 'Phone'), element('dd', '', data.device ?? 'Phone'));
      list.append(element('dt', '', 'Computer'), element('dd', '', data.desktop ?? 'Computer'));
      list.append(element('dt', '', 'Way'), element('dd', '', data.carrier ?? 'Same network'));
      box.append(list);
    }
    if (screen === 'approval') {
      const card = element('div', 'fx-card');
      card.append(element('p', '', data.command ?? 'git status'));
      const row = element('div', 'fx-buttons');
      row.append(element('button', 'fx-button', 'Deny'), element('button', 'fx-button primary', 'Approve'));
      card.append(row);
      box.append(card);
    }
    if (screen === 'stop-pressed') {
      box.append(element('p', 'fx-note', data.ack ? `Computer answered: ${data.ack}` : 'No answer yet. Plenum keeps retrying for 60 seconds.'));
    }
    return screen;
  }

  const pair = /[#&]pair=([A-Za-z0-9_-]{8,})/.exec(location.hash);
  if (pair) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // The address bar keeps the fragment; the screen still works.
    }
  }
  const requested = new URLSearchParams(location.search).get('screen');
  const first = requested && Object.prototype.hasOwnProperty.call(TEXT, requested) ? requested : pair ? 'pairing' : 'connected';

  window.plenumFixture = { show, screens: Object.keys(TEXT), pairFragmentSeen: !!pair };
  show(first, {});
})();
