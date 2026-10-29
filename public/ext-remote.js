// ext-remote. Settings > Phones (MuseUI.settings, group Safety): the switch that lets phones connect and its port, the three ways a
// phone can reach this computer (Same network, Tailscale and your relay), Add phone, the paired phones with their control (Full
// control, Approve and watch, Read only), Remove and Remove all, auto-expiry, the notification switches with a test, Stop all and
// the activity list. It also owns the title-bar chip 'Phone connected: <name>' (the titlebar slot), its toasts on connect and
// disconnect, and the notices that sit where each switch starts. Adds itself through window.MuseUI (app.js). Layout and colour are
// in ext-remote.css; every colour is a shared token.
//
// The server owns every fact (lib/routes/remote.mjs, lib/routes/stop-all.mjs):
//   GET  /api/phones                        the state; a 503 means this build has no phone support
//   GET  /api/phones/activity               the last entries, 'via <device>: <what it did>'
//   POST /api/phones/settings, lan, tailscale, relay, pair/start, pair/cancel, remove, remove-all, tier, push, test-push
//   POST /api/stop-all                      Stop everything, the same as Stop on a phone
// and sends { type: 'phone', kind: 'presence' | 'pairing' | 'activity' | 'revoked' | 'tier' } on the events channel, which this panel
// reads through 'plenum:event'. Pairing is human-only: Add phone is hidden on a phone (data-surface="phone"), and the server refuses
// pairing and tier changes that come from a phone. Text reaches the page through textContent only. No key, token or secret is read,
// kept or shown here, except the pairing link that a plain-node server returns to this same page, which only the Copy link button uses.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it there is nothing to attach to. The Settings page is optional:
  // the title-bar chip works without it.
  if (!MuseUI) return;

  const SECTION_ID = 'phones';
  const SECTION_TITLE = 'Phones';
  // In the Safety group, after its own sections (approvals and computer use are at order 60).
  const SECTION_GROUP = 'safety';
  const SECTION_ORDER = 70;
  const CHIP_ID = 'phones';
  const CHIP_ORDER = 40;
  const NOT_BUILT = 'Phones need a newer Plenum build.';
  const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/RealAlcibiades/Plenum/tree/main/relay';
  const TIER_LABELS = [['full', 'Full control'], ['approve', 'Approve and watch'], ['read', 'Read only']];
  const TIER_WORDS = { full: 'Full control', approve: 'Approve and watch', read: 'Read only' };
  const CARRIER_WORDS = { lan: 'Same network', tailscale: 'Tailscale', relay: 'your relay' };
  const PLATFORM_WORDS = { ios: 'iPhone', android: 'Android phone', web: 'Web browser' };
  const PUSH_WORDS = { webpush: 'Web Push', unifiedpush: 'UnifiedPush', apns: 'Apple Push' };
  // What a relay reason means on this page. An unknown reason uses the '' entry.
  const RELAY_WORDS = {
    '': 'Not connected to your relay yet.',
    connecting: 'Connecting to your relay.',
    refused: 'Your relay turned this computer away. Someone else may have claimed this room. Start a new room to use the relay again.',
    unreachable: 'Cannot reach your relay. Check the address and your connection.',
    offline: 'The relay connection dropped. Plenum keeps trying.',
    dropped: 'The relay connection dropped. Plenum keeps trying.',
    replaced: 'Another copy of Plenum connected to this room in its place.',
    'bad-address': 'The relay address is not valid. Save an https address.',
    'no-room': 'No room yet. Save the relay address first.',
    off: '',
  };
  const relayWord = reason => (Object.prototype.hasOwnProperty.call(RELAY_WORDS, reason) ? RELAY_WORDS[reason] : RELAY_WORDS['']);
  const EXPIRY_OPTIONS = [[0, 'Never'], [7, 'After 7 days'], [30, 'After 30 days'], [90, 'After 90 days'], [365, 'After a year']];
  const PUSH_SWITCHES = [
    ['approvals', 'Approvals waiting', 'A card waits for your answer.'],
    ['finished', 'Finished runs', 'A run ends, with its project name.'],
    ['limits', 'Limits reached', 'A usage or spend limit stops a run.'],
    ['onlyWhenAway', 'Only when I am away', 'Sends only when you are away from this computer.'],
    ['firstLine', 'Include the first line', 'Adds the first line of the card, which can name files and commands.'],
  ];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const TERMINAL = ['allowed', 'denied', 'expired', 'failed3'];
  // The notices' texts, copied from MOBILE.json notices. The notices module draws them once it knows the ids (lib/notices.mjs, wave 119).
  // Until then this panel draws them, with an OK that dismisses them for this page only.
  const NOTES = {
    "phone-pairing": { tone: "danger", title: "A paired phone is as powerful as this window",
      text: "A paired phone can do everything this window can: run models that edit files and run commands, use the browser and the computer, spend on your keys and change settings. Keep the phone locked. Remove a lost phone here at once; Stop on the bar or on the phone ends every run." },
    "phone-lan": { tone: "warn", title: "Phones on this network can reach Plenum",
      text: "Plenum now listens on a port on this computer. Anyone on this network can see that it is listening, and Windows may ask you to allow it through the firewall. The Plenum app's link is encrypted, but the web page a phone opens from this network is sent as plain http: someone on the same network could change it and use the access you give that phone. On a network you do not trust, use the Plenum app, Tailscale or your relay instead." },
    "phone-tailscale": { tone: "info", title: "Plenum will run your Tailscale",
      text: "Plenum runs your own Tailscale (tailscale serve) so a phone can reach this computer at https://name.ts.net. Tailscale sees when your devices connect, and your computer and tailnet names go into a public certificate log. Tailscale's Personal plan is for non-commercial use. Plenum does not include Tailscale." },
    "phone-relay": { tone: "info", title: "Your relay sees when, not what",
      text: "The relay runs in your own Cloudflare account. It sees when your devices connect, from which addresses and how much data passes, never what is said: everything between phone and computer is encrypted with keys only your devices hold. Keep that account secure; anyone with it can take the relay down." },
    "phone-push": { tone: "warn", title: "Notification text shows on the lock screen",
      text: "Plenum sends your phone only the project name and a status, such as an approval is waiting. Anyone holding the phone can read that on the lock screen. Turning on Include the first line adds the first line of the card, which can name files and commands." },
    "phone-plain-node": { tone: "warn", title: "Phone keys are not encrypted under node",
      text: "Started with node instead of the desktop app, Plenum keeps the phone link's keys as plain files in its state folder. Anyone with your user account can read them. Use the desktop app to keep them encrypted." },
  };

  // ---------- small helpers (text only) ----------

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const textOf = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const button = (cls, label, onClick) => {
    const b = make('button', cls, label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // True on the phone's own copy of this page (the shell marks the document, data-surface="phone").
  const onPhone = () => document.documentElement.dataset.surface === 'phone';
  // The id of the phone this page runs on, when it is one (the shell's device), else ''.
  const ownId = () => textOf(window.plenumShell?.device?.id);

  // '14 Oct 2026, 10:12 AM' for a time in milliseconds, or '' when there is no such time.
  function when(ms) {
    const n = Number(ms);
    const d = new Date(n);
    if (!Number.isFinite(d.getTime()) || n <= 0) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  function showStatus(el, text, bad) {
    if (!el) return;
    el.textContent = text ?? '';
    el.classList.toggle('bad', Boolean(bad));
  }

  // The line under a control: "Saved" once the server has stored the change, or the server's sentence in red.
  function statusEl() {
    const s = make('p', 'setting-status remote-status');
    s.setAttribute('role', 'status');
    return s;
  }

  // ---------- state kept by this panel (the server's facts, as last read) ----------

  let view = null;             // the last state from GET /api/phones (or a change's answer)
  let unbuilt = false;         // this build has no phone support: the section shows one row
  let loadError = '';          // why the state could not be read, shown in red
  let offer = null;            // the pairing offer { state, expiresAt, code, link } or null
  let offerError = '';         // a refusal from Add phone
  let answerShown = false;     // the plain-node Allow row is on screen (its Deny takes the focus once, when it appears)
  let activity = [];           // the last activity entries, newest first
  let live = new Map();        // id -> { id, name, carrier } of the phones connected now
  let liveKnown = false;       // true once the phones connected are known; toasts start after that
  let chipEl = null;           // the title-bar chip while it is shown
  let page = null;             // the open section's parts, or null before it has been drawn
  let countTimer = null;       // the pairing countdown while an offer waits
  let uid = 0;
  const dismissed = new Set(); // local notices the person dismissed with OK (this page only)

  // ---------- reading the state ----------

  // The phones connected now, from a state answer. Each one is { id, name, carrier }.
  function connectedOf(data) {
    return (Array.isArray(data.devices) ? data.devices : [])
      .filter(d => isObj(d) && d.connected === true && textOf(d.id))
      .map(d => ({ id: textOf(d.id), name: textOf(d.name, 'Phone'), carrier: textOf(d.lastCarrier) }));
  }

  // The phone's name from the offer. Under plain node the server sends the phone as { name, ... } (a string is taken as the name too).
  const phoneNameOf = v => (typeof v === 'string' ? textOf(v) : isObj(v) ? textOf(v.name) : '');

  // Sets the pairing offer from the server's offer fields. A link a plain-node Add phone gave is kept while the offer is open.
  // flags holds the server's tried and left (true once a device failed the code; true when the phone waiting went away).
  function setOffer(state, expiresInS, code, device, flags = {}) {
    const s = textOf(state, 'idle');
    if (s === 'offer' || s === 'confirm') {
      const keep = offer?.link ?? '';
      offer = { state: s, expiresAt: Date.now() + Math.max(0, Number(expiresInS) || 0) * 1000, code: textOf(code), link: keep, device: phoneNameOf(device), tried: flags?.tried === true, left: flags?.left === true };
    } else if (TERMINAL.includes(s)) {
      offer = { state: s, expiresAt: 0, code: '', link: '', device: phoneNameOf(device) };
    } else {
      offer = null;
    }
  }

  // Takes a state the server sent (GET /api/phones, or the state a change answered with).
  function applyState(data) {
    if (!isObj(data)) return;
    unbuilt = data.available === false;
    view = data;
    loadError = textOf(data.error);
    const o = isObj(data.offer) ? data.offer : {};
    if (o.state === 'offer' || o.state === 'confirm' || TERMINAL.includes(o.state)) setOffer(o.state, o.expiresInS, o.code, o.device, o);
    else if (!(offer && TERMINAL.includes(offer.state))) offer = null; // a finished message stays until the person closes it
    setLive(connectedOf(data));
  }

  // The state from GET /api/phones. A 503 means this build has no phone support, and the section says so in one row.
  async function refreshState() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const res = await MuseUI.request('/api/phones');
      if (res.status === 503) {
        unbuilt = true;
        view = null;
        loadError = '';
        setLive([]);
      } else {
        const data = await res.json().catch(() => ({}));
        if (res.ok) applyState(data);
        else loadError = textOf(data.error, `Phones could not be read (${res.status}).`);
      }
    } catch (err) {
      loadError = textOf(err?.message, 'Phones could not be read.');
    }
    paintAll();
  }

  // The activity list (GET /api/phones/activity). A list that cannot be read keeps what it had.
  async function refreshActivity() {
    try {
      await (MuseUI.ready ?? Promise.resolve());
      const res = await MuseUI.request('/api/phones/activity');
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const rows = Array.isArray(data.activity) ? data.activity : [];
      activity = rows.filter(isObj).slice(0, 50).map(e => ({ at: Number(e.at) || 0, device: textOf(e.device, 'Phone'), text: textOf(e.text) }));
      paintActivity();
    } catch {
      // The list stays as it was.
    }
  }

  // The phones connected now. After the first reading a change says so in a toast; the first reading only sets the baseline.
  function setLive(list) {
    const next = new Map();
    for (const p of list) {
      if (!isObj(p)) continue;
      const id = textOf(p.id);
      if (!id) continue;
      next.set(id, { id, name: textOf(p.name, 'Phone'), carrier: textOf(p.carrier) });
    }
    if (liveKnown) {
      for (const [id, p] of next) if (!live.has(id)) MuseUI.toast(`${p.name} connected.`, 'ok');
      for (const [id, p] of live) if (!next.has(id)) MuseUI.toast(`${p.name} disconnected.`, 'ok');
    }
    live = next;
    liveKnown = true;
    paintChip();
    paintDevices();
  }

  // ---------- the title-bar chip ----------

  // 'Phone connected: <name>', or 'N phones connected' with the names in its tooltip. It is in the titlebar slot on the desktop surface,
  // has no close control, and no setting hides it. On the phone surface (data-surface="phone") ext-phone.css hides it: the phone shows
  // its own connection chip there. Its click opens this section.
  // Under 620 px the chip keeps to 'Phone' or 'N phones' so it stays inside the title bar; the full words stay in its tooltip.
  const narrowQuery = window.matchMedia ? window.matchMedia('(max-width: 620px)') : null;
  if (narrowQuery) {
    if (typeof narrowQuery.addEventListener === 'function') narrowQuery.addEventListener('change', () => paintChip());
    else if (typeof narrowQuery.addListener === 'function') narrowQuery.addListener(() => paintChip());
  }

  function paintChip() {
    // Without the chip API (a page that has no title bar slots) there is nothing to draw.
    if (!MuseUI.ui?.chip || !MuseUI.slots?.add) return;
    const list = [...live.values()];
    if (!list.length) {
      chipEl = null;
      MuseUI.slots.remove('titlebar', CHIP_ID);
      return;
    }
    const names = list.map(p => p.name);
    const full = list.length === 1 ? `Phone connected: ${names[0]}` : `${list.length} phones connected`;
    const short = list.length === 1 ? 'Phone' : `${list.length} phones`;
    const label = narrowQuery?.matches ? short : full;
    const tip = `Connected: ${names.join(', ')}. Open Settings › Phones.`;
    // The accessible name keeps the full words even where the bar shows the short label (the fit ladder in style.css, step 4).
    const aria = list.length === 1 ? `${full}. Open Settings › Phones.` : `${full}: ${names.join(', ')}. Open Settings › Phones.`;
    if (!chipEl || !chipEl.isConnected) {
      chipEl = MuseUI.ui.chip({ label, title: tip, tone: 'green', onClick: () => MuseUI.openSettings(SECTION_ID) });
      chipEl.classList.add('remote-chip');
      chipEl.dataset.short = short;
      chipEl.setAttribute('aria-label', aria);
      MuseUI.slots.add('titlebar', CHIP_ID, chipEl, CHIP_ORDER);
    } else {
      chipEl.textContent = label;
      chipEl.dataset.short = short;
      chipEl.title = tip;
      chipEl.setAttribute('aria-label', aria);
    }
  }

  // ---------- events ----------

  function onEvent(ev) {
    if (!isObj(ev) || ev.type !== 'phone') return;
    switch (ev.kind) {
      case 'presence':
        if (Array.isArray(ev.connected)) setLive(ev.connected);
        break;
      case 'pairing':
        // The code, the phone's name and the tried and left flags are in the state, not in the event: read the state for them.
        // (A paired phone is in the list now too.)
        refreshState();
        break;
      case 'activity':
        activity.unshift({ at: Date.now(), device: textOf(ev.device, 'Phone'), text: textOf(ev.text) });
        activity.length = Math.min(activity.length, 50);
        paintActivity();
        break;
      case 'revoked':
      case 'tier':
        refreshState();
        break;
      default:
        break;
    }
  }

  window.addEventListener('plenum:event', e => {
    try {
      onEvent(e.detail);
    } catch (err) {
      console.error(err);
    }
  });
  // A reconnect after a restart or a lost stream reads the state again.
  window.addEventListener('plenum:connection', e => {
    if (e.detail?.connected === true) refreshState();
  });

  // ---------- notices ----------

  // A notice with its text here. It is drawn into a wrapper that stays hidden until its switch is on, so a notice that is
  // drawn by the notices module (once per launch, with its own Don't show again) and one drawn here both follow the switch.
  function localNote(id) {
    const n = NOTES[id];
    const box = make('div', 'remote-note');
    box.dataset.tone = n.tone;
    box.dataset.notice = id;
    box.setAttribute('role', 'note');
    const ok = button('ghost small remote-note-ok', 'OK', () => {
      dismissed.add(id);
      box.remove();
    });
    box.append(make('strong', 'remote-note-title', n.title), make('p', 'remote-note-text', n.text), ok);
    return box;
  }

  function showNote(id, wrap) {
    if (!wrap || !NOTES[id]) return;
    wrap.hidden = false;
    if (wrap.childElementCount || dismissed.has(id)) return;
    let drawn = false;
    try {
      drawn = MuseUI.notice?.(id, { into: wrap }) === true;
    } catch {
      drawn = false;
    }
    if (drawn || wrap.childElementCount) return;
    // The notices module knows this id and drew nothing: it was shown this launch, or the person chose Don't show again.
    if (MuseUI.notices?.list?.().some(n => n.id === id)) return;
    wrap.append(localNote(id));
  }

  // ---------- changes ----------

  // Sends one change. Its controls are off while the server answers. "Saved" shows once the server has stored it; a refusal shows the
  // server's sentence in red and puts the old value back. Resolves to the answer, or null when it was refused.
  async function save({ controls = [], status, path, body, revert }) {
    const list = controls.filter(Boolean);
    const was = list.map(c => c.disabled);
    list.forEach(c => {
      c.disabled = true;
    });
    showStatus(status, '', false);
    try {
      const data = await MuseUI.api(path, body);
      showStatus(status, 'Saved', false);
      return data;
    } catch (err) {
      if (typeof revert === 'function') revert();
      showStatus(status, textOf(err?.message, 'That did not save.'), true);
      return null;
    } finally {
      list.forEach((c, i) => {
        c.disabled = was[i];
      });
    }
  }

  // A phone may change the phones and the desktop-wide switches only at Full control. The computer itself always may.
  function mayManage() {
    if (!onPhone()) return true;
    const me = (view?.devices ?? []).find(d => isObj(d) && d.id === ownId());
    return me?.tier === 'full';
  }

  async function togglePhones(input, status) {
    const want = input.checked;
    const data = await save({ controls: [input], status, path: '/api/phones/settings', body: { enabled: want }, revert: () => { input.checked = !want; } });
    if (data) applyState(data);
    paintAll();
  }

  async function changePort(btn, status) {
    const data = await save({ controls: [btn], status, path: '/api/phones/settings', body: { rerollPort: true } });
    if (data) applyState(data);
    paintAll();
  }

  async function changeTier(row, value) {
    const before = (view?.devices ?? []).find(d => isObj(d) && d.id === row.id)?.tier ?? 'full';
    const data = await save({ controls: [row.tierSel], status: row.status, path: '/api/phones/tier', body: { id: row.id, tier: value }, revert: () => { row.tierSel.value = before; } });
    if (data) {
      const d = (view?.devices ?? []).find(x => isObj(x) && x.id === row.id);
      if (d) d.tier = value;
    }
    paintDevices();
  }

  // A raise of a phone's control asks first, with what the tier allows. Cancel puts the choice back and sends nothing. A lowering does not ask.
  async function confirmTier(row, value) {
    const RANK = { read: 0, approve: 1, full: 2 };
    const d = (view?.devices ?? []).find(x => isObj(x) && x.id === row.id);
    const before = d?.tier ?? 'full';
    if ((RANK[value] ?? 0) <= (RANK[before] ?? 0)) return changeTier(row, value);      // lowering: no confirm
    const name = textOf(d?.name, 'this phone');
    const plainHttp = d?.app === 'lan-web' ? ' It pairs through a web page sent without encryption, so someone on that network could have changed it.' : '';
    const ok = await MuseUI.confirm(value === 'full' ? {
      title: `Give ${name} Full control?`,
      body: `With Full control this phone can do everything this window can: start runs that edit files and run commands, use the browser and the computer, and change settings.${plainHttp}`,
      action: 'Give Full control', tone: 'danger', focusCancel: true,
    } : {
      title: `Give ${name} Approve and watch?`,
      body: `With Approve and watch this phone can approve or deny waiting cards, which lets runs go ahead, as well as watch and stop.${plainHttp}`,
      action: 'Give Approve and watch', tone: 'danger', focusCancel: true,
    });
    if (!ok) { row.tierSel.value = before; return; }
    return changeTier(row, value);
  }

  async function removeDevice(row) {
    const d = (view?.devices ?? []).find(x => isObj(x) && x.id === row.id);
    const mine = onPhone() && row.id === ownId();
    const ok = await MuseUI.confirm({
      title: mine ? 'Remove this phone?' : `Remove ${textOf(d?.name, 'this phone')}?`,
      body: 'It can no longer reach this computer, and its connection closes at once. To use Plenum on it again, pair it again.',
      action: 'Remove',
      tone: 'danger',
      focusCancel: true,
    });
    if (!ok) return;
    row.remove.disabled = true;
    try {
      await MuseUI.api('/api/phones/remove', { id: row.id });
      await refreshState();
    } catch (err) {
      showStatus(row.status, textOf(err?.message, 'That phone was not removed.'), true);
      row.remove.disabled = false;
    }
  }

  async function removeAll() {
    const p = page;
    const ok = await MuseUI.confirm({
      title: 'Remove all phones?',
      body: 'Every paired phone is removed and this computer gets a new key, so no phone can reach it until each one is paired again.',
      action: 'Remove all',
      tone: 'danger',
      focusCancel: true,
    });
    if (!ok) return;
    try {
      const data = await MuseUI.api('/api/phones/remove-all', {});
      showStatus(p?.removeAllStatus, `Removed ${plural(Number(data.removed) || 0, 'phone', 'phones')}. Pair each one again to use it.`, false);
    } catch (err) {
      showStatus(p?.removeAllStatus, textOf(err?.message, 'The phones were not removed.'), true);
    }
    await refreshState();
  }

  // Moves this computer to a new room on the relay (the computer only). Phones paired before reach it through the relay after they pair again.
  async function newRoom() {
    const p = page;
    const ok = await MuseUI.confirm({
      title: 'Start a new room?',
      body: 'This computer moves to a new room on your relay. Phones paired before this reach it through the relay again only after you pair them again; the same network and Tailscale keep working.',
      action: 'New room', tone: 'danger', focusCancel: true,
    });
    if (!ok) return;
    const data = await save({ controls: [p?.newRoomBtn], status: p?.relayStatus ?? statusEl(), path: '/api/phones/relay/new-room', body: {} });
    if (!data) return;
    applyState(data);
    paintAll();
    MuseUI.toast('New room ready. Pair your phones again to use the relay.', 'ok');
  }

  async function savePush(key, input, status) {
    const want = input.checked;
    const data = await save({ controls: [input], status, path: '/api/phones/push', body: { [key]: want }, revert: () => { input.checked = !want; } });
    if (data && isObj(data.push) && view) view.push = { ...(view.push ?? {}), ...data.push };
    paintAll();
  }

  async function testPush(btn, status) {
    btn.disabled = true;
    try {
      const data = await MuseUI.api('/api/phones/test-push', {});
      const sent = (Array.isArray(data.results) ? data.results : []).filter(r => isObj(r) && r.outcome === 'sent').length;
      showStatus(status, sent ? `Sent a test to ${plural(sent, 'phone', 'phones')}.` : 'No phone got the test. Check that a phone is paired and has notifications set up.', !sent);
    } catch (err) {
      showStatus(status, textOf(err?.message, 'The test did not send.'), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function stopAll(btn, status) {
    btn.disabled = true;
    try {
      const d = await MuseUI.api('/api/stop-all', {});
      showStatus(status, `Stopped. ${plural(Number(d.cancelled) || 0, 'reply', 'replies')}, ${plural(Number(d.drivesStopped) || 0, 'computer or browser run', 'computer or browser runs')}, ${plural(Number(d.agentsStopped) || 0, 'agent', 'agents')}. ${plural(Number(d.cardsDenied) || 0, 'waiting card', 'waiting cards')} denied.`, false);
    } catch (err) {
      showStatus(status, textOf(err?.message, 'Stop did not answer. Use Stop on this computer.'), true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- pairing (Add phone, human-only: the server refuses it from a phone) ----------

  async function addPhone() {
    offerError = '';
    try {
      const data = await MuseUI.api('/api/phones/pair/start', {});
      setOffer(textOf(data.state, 'offer'), data.expiresInS, '');
      if (offer && textOf(data.link)) offer.link = textOf(data.link);
    } catch (err) {
      offerError = textOf(err?.message, 'A new code could not be made.');
    }
    paintOffer();
  }

  async function cancelPhone() {
    try {
      await MuseUI.api('/api/phones/pair/cancel', {});
      offer = null;
      offerError = '';
    } catch (err) {
      offerError = textOf(err?.message, 'The code could not be cancelled.');
    }
    paintOffer();
  }

  // The words for each pairing state (MOBILE-UI 7.2). Under plain node there is no window: the link is copied and the Allow row answers.
  function offerWords(o, plain) {
    switch (o.state) {
      case 'offer':
        if (plain) return { title: 'Open the link on your phone', detail: 'Copy the link and open it on your phone. The code for it appears here.' };
        return { title: 'Look at the window on your computer', detail: 'A window with the code opened on this computer. Scan it with your phone.' };
      case 'confirm':
        if (plain) return { title: o.device ? `A phone is waiting: ${o.device}` : 'A phone is waiting', detail: 'Compare the code shown here with the code on the phone. Allow here only if they match.' };
        return { title: 'A phone is waiting', detail: 'Compare the code in the window on this computer with the code on the phone. Allow there only if they match.' };
      case 'allowed':
        return { title: 'A phone is paired.', detail: 'It can do everything this window can. Remove it any time in the list below.' };
      case 'denied':
        return { title: 'No phone was paired.', detail: '' };
      case 'expired':
        return { title: 'The code expired. No phone was paired.', detail: '' };
      case 'failed3':
        return { title: 'Three tries with this code failed, so it was stopped. No phone was paired.', detail: '' };
      default:
        return { title: '', detail: '' };
    }
  }

  function countText() {
    const left = Math.max(0, Math.ceil(((offer?.expiresAt ?? 0) - Date.now()) / 1000));
    return `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function stopCount() {
    if (countTimer) clearInterval(countTimer);
    countTimer = null;
  }

  function startCount() {
    if (countTimer || !page) return;
    countTimer = setInterval(() => {
      if (!page || !offer || !(offer.state === 'offer' || offer.state === 'confirm')) return stopCount();
      page.offerCount.textContent = countText();
      if (offer.expiresAt <= Date.now()) stopCount();
    }, 1000);
  }

  // Plain node only: Allow or Deny for the phone that waits (POST /api/phones/pair/confirm). The desktop app answers in its own window.
  async function answerPhone(allow) {
    offerError = '';
    try {
      await MuseUI.api('/api/phones/pair/confirm', { allow });
    } catch (err) {
      offerError = textOf(err?.message, 'The answer could not be sent.');
      paintOffer();
      return;
    }
    await refreshState();
  }

  function paintOffer() {
    const p = page;
    if (!p) return;
    const o = offer;
    const active = Boolean(o) && (o.state === 'offer' || o.state === 'confirm');
    const plain = view?.plainNode === true;
    const words = o ? offerWords(o, plain) : { title: '', detail: '' };
    const answering = Boolean(o) && o.state === 'confirm' && plain && !onPhone();   // pairing is answered at the computer only
    p.offerAnswer.hidden = !answering;
    if (answering && !answerShown) p.offerDeny.focus();   // Deny has the focus, so an Enter does not allow by accident
    answerShown = answering;
    p.offer.hidden = !o && !offerError;
    p.offerTitle.textContent = o ? words.title : '';
    p.offerTitle.hidden = !o;
    p.offerDetail.textContent = o ? words.detail : '';
    p.offerDetail.hidden = !o || !words.detail;
    const tried = Boolean(o) && (o.state === 'offer' || o.state === 'confirm') && o.tried === true;
    const left = Boolean(o) && o.state === 'offer' && o.left === true;
    p.offerTried.textContent = tried ? 'Another device tried to pair with this computer and was turned away. Only a phone that has this code can pair.' : '';
    p.offerTried.hidden = !tried;
    p.offerLeft.textContent = left ? 'The phone that was waiting left before you answered. Scan the code again.' : '';
    p.offerLeft.hidden = !left;
    // A code and a link come from the server only under plain node, where this page answers the pairing (B-L11).
    p.offerCode.textContent = plain && o && o.state === 'confirm' && o.code ? `Code on the phone: ${o.code.replace(/^(\d{3})(\d{3})$/, '$1 $2')}` : '';
    p.offerCode.hidden = !p.offerCode.textContent;
    p.offerCount.textContent = active ? countText() : '';
    p.offerCount.hidden = !active;
    p.offerCancel.hidden = !active;
    p.offerCopy.hidden = !(plain && active && o.link);
    p.offerNew.hidden = !(o && (o.state === 'expired' || o.state === 'failed3'));
    p.offerDone.hidden = !(o && (o.state === 'allowed' || o.state === 'denied'));
    p.offerError.textContent = offerError;
    p.offerError.hidden = !offerError;
    p.addBtn.disabled = active;
    p.addBtn.hidden = onPhone();
    p.pairNotes.hidden = onPhone();
    if (!onPhone()) showNote('phone-pairing', p.pairNotes);
    if (active) startCount();
    else stopCount();
  }

  // ---------- the paired phones ----------

  function deviceRow(id) {
    const li = make('li', 'remote-device');
    const head = make('div', 'remote-device-head');
    const dot = make('span', 'remote-dot');
    dot.setAttribute('aria-hidden', 'true');
    const name = make('strong', 'remote-name');
    head.append(dot, name);
    const meta = make('p', 'remote-meta');
    const actions = make('div', 'remote-device-actions');
    const tierId = `remote-tier-${++uid}`;
    const field = make('div', 'field remote-tier');
    const tierLabel = make('label', 'field-label', 'Control');
    tierLabel.htmlFor = tierId;
    const tierSel = make('select');
    tierSel.id = tierId;
    for (const [value, label] of TIER_LABELS) {
      const option = make('option', null, label);
      option.value = value;
      tierSel.append(option);
    }
    field.append(tierLabel, tierSel);
    const tierText = make('span', 'remote-tier-text');
    const remove = button('ghost small', 'Remove');
    actions.append(field, tierText, remove);
    const status = statusEl();
    li.append(head, meta, actions, status);
    const row = { id, li, dot, name, meta, field, tierSel, tierText, remove, status };
    tierSel.addEventListener('change', () => confirmTier(row, tierSel.value));
    remove.addEventListener('click', () => removeDevice(row));
    return row;
  }

  function paintDeviceRow(row, d) {
    const phone = onPhone();
    const mine = phone && row.id === ownId();
    const on = live.get(row.id);
    row.name.textContent = textOf(d.name, 'Phone');
    row.dot.dataset.on = on ? 'true' : 'false';
    const where = on ? `Connected over ${CARRIER_WORDS[on.carrier] ?? 'a way to this computer'}.` : (Number(d.lastSeen) > 0 ? `Last seen ${when(d.lastSeen)}.` : 'Not connected yet.');
    const kind = d.app === 'lan-web' ? 'Web page (plain http)' : (PLATFORM_WORDS[d.platform] ?? 'Phone');
    const push = PUSH_WORDS[d.push] ? `Notifications: ${PUSH_WORDS[d.push]}.` : 'Notifications are off for this phone.';
    row.meta.textContent = `${kind}. ${d.created ? `Paired ${when(d.created)}. ` : ''}${where} ${push}`;
    row.field.hidden = phone;
    row.tierText.hidden = !phone;
    row.tierText.textContent = TIER_WORDS[d.tier] ?? '';
    if (TIER_LABELS.some(([v]) => v === d.tier)) row.tierSel.value = d.tier;
    row.tierSel.disabled = !mayManage();
    row.remove.hidden = !(!phone || mine || mayManage());
    row.remove.textContent = mine ? 'Remove this phone' : 'Remove';
  }

  function paintDevices() {
    const p = page;
    if (!p) return;
    const list = (Array.isArray(view?.devices) ? view.devices : []).filter(isObj).filter(d => textOf(d.id));
    p.empty.hidden = list.length > 0;
    // Only the computer changes how phones reach it, and removes all of them (D7): a phone sees these only as text.
    p.removeAll.hidden = list.length === 0 || !mayManage() || onPhone();
    p.expirySel.disabled = onPhone() || !mayManage();
    const seen = new Set();
    for (const d of list) {
      const id = textOf(d.id);
      seen.add(id);
      let row = p.rows.get(id);
      if (!row) {
        row = deviceRow(id);
        p.rows.set(id, row);
        p.devices.append(row.li);
      }
      paintDeviceRow(row, d);
    }
    for (const [id, row] of p.rows) {
      if (seen.has(id)) continue;
      row.li.remove();
      p.rows.delete(id);
    }
  }

  function paintActivity() {
    const p = page;
    if (!p) return;
    p.activityList.replaceChildren(...activity.slice(0, 50).map(entry => {
      const li = make('li', 'remote-activity-item');
      li.append(make('span', 'remote-activity-text', `via ${entry.device}: ${entry.text}`), make('time', 'remote-activity-time', when(entry.at)));
      return li;
    }));
    p.activityEmpty.hidden = activity.length > 0;
  }

  // ---------- painting the section from the last state ----------

  function paintAll() {
    const p = page;
    if (!p) return;
    p.plain.textContent = NOT_BUILT;
    p.plain.hidden = !unbuilt;
    p.main.hidden = unbuilt;
    p.error.textContent = loadError;
    p.error.hidden = !loadError || unbuilt;
    if (unbuilt) return;
    const v = view ?? {};
    const phone = onPhone();
    const manage = mayManage();

    // Turn phones on, and the port.
    p.enabled.checked = v.enabled === true;
    p.enabled.disabled = phone;
    p.portText.textContent = v.port ? `Port ${v.port}` : '';
    p.portBtn.hidden = v.enabled !== true || phone;
    p.portHelp.hidden = v.enabled !== true;
    p.storageNote.textContent = textOf(v.storageNote);
    p.storageNote.hidden = !p.storageNote.textContent;
    if (v.plainNode === true) showNote('phone-plain-node', p.plainNotes);
    else p.plainNotes.hidden = true;

    // The ways a phone can reach this computer.
    const lan = v.carriers?.lan ?? {};
    p.lan.checked = lan.on === true;
    p.lan.disabled = phone;
    p.lanAny.checked = lan.anyAddress === true;
    p.lanAny.disabled = phone || lan.on !== true;
    const addresses = Array.isArray(lan.addresses) ? lan.addresses.map(a => textOf(a)).filter(Boolean) : [];
    p.lanText.textContent = lan.on === true ? (addresses.length ? `Phones can reach this computer at ${addresses.join(', ')}.` : 'No network address for this computer yet.') : '';
    p.lanError.textContent = textOf(lan.error);
    p.lanError.hidden = !p.lanError.textContent;
    p.lanFirewall.textContent = lan.on === true ? textOf(lan.firewall) : "";
    p.lanFirewall.hidden = !p.lanFirewall.textContent;
    if (lan.on === true) showNote('phone-lan', p.lanNotes);
    else p.lanNotes.hidden = true;
    showNote('phone-tailscale', p.tsNotes);
    const ts = v.carriers?.tailscale ?? {};
    p.ts.checked = ts.on === true;
    p.ts.disabled = phone;
    const tsHost = textOf(ts.name).replace(/^https?:\/\//, '').replace(/\.$/, '');
    p.tsText.textContent = ts.on === true && tsHost ? `Reaches this computer at https://${tsHost}.` : textOf(ts.message);
    showNote('phone-relay', p.relayNotes);
    const rl = v.carriers?.relay ?? {};
    p.relay.checked = rl.on === true;
    p.relay.disabled = phone;
    p.relayUrl.disabled = phone;
    p.relaySave.disabled = phone;
    if (document.activeElement !== p.relayUrl) p.relayUrl.value = textOf(rl.url);
    p.relayText.textContent = rl.on === true ? (rl.connected === true ? 'Connected to your relay.' : relayWord(textOf(rl.reason))) : '';
    // New room starts only when the relay refused this computer, and only the computer may start it (D9, D7).
    const newRoomShown = rl.on === true && rl.reason === 'refused' && !phone;
    p.newRoomLine.hidden = !newRoomShown;
    p.newRoomBtn.hidden = !newRoomShown;
    // Only the computer changes how phones reach it (D7): a phone sees the line that says so.
    p.computerOnly.hidden = !phone;

    // Notifications: the switches are desktop-wide, so only a Full phone may change them.
    for (const [key] of PUSH_SWITCHES) {
      p.push[key].checked = v.push?.[key] === true;
      p.push[key].disabled = !manage;
    }
    showNote('phone-push', p.pushNotes);

    // Auto-expiry.
    const days = Number.isInteger(v.autoExpireDays) ? v.autoExpireDays : 0;
    if (![...p.expirySel.options].some(o => o.value === String(days))) {
      const option = make('option', null, `After ${plural(days, 'day', 'days')}`);
      option.value = String(days);
      p.expirySel.append(option);
    }
    p.expirySel.value = String(days);

    paintOffer();
    paintDevices();
    paintActivity();
    paintChip();
  }

  // ---------- drawing the section ----------

  function switchRow(title, help) {
    const label = make('label', 'switch-row remote-switch');
    const input = document.createElement('input');
    input.type = 'checkbox';
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const text = make('span', 'remote-switch-text', title);
    if (help) text.append(make('small', null, help));
    label.append(input, track, text);
    return { label, input };
  }

  const line = (...parts) => {
    const d = make('div', 'remote-line');
    d.append(...parts);
    return d;
  };
  const notesWrap = () => {
    const w = make('div', 'remote-notes');
    w.hidden = true;
    return w;
  };

  function build() {
    const p = { rows: new Map(), push: {} };
    const root = make('div', 'remote-root');
    p.root = root;
    p.plain = make('p', 'remote-plain');
    p.error = make('p', 'remote-error');
    p.main = make('div', 'remote-main');
    p.plainNotes = notesWrap();
    p.storageNote = make('p', 'remote-quiet');
    p.intro = make('p', 'remote-intro', 'Phones reach this computer through the ways below. A paired phone can do everything this window can, so pair only phones you hold, and remove a lost one here at once. Pairing starts here and is finished in the window on this computer.');

    // Turn phones on.
    const powerBlock = make('div', 'remote-block');
    const enabled = switchRow('Let phones connect', 'Off until you turn it on. Plenum then listens on this computer only, and a way below lets phones in.');
    p.enabled = enabled.input;
    p.powerStatus = statusEl();
    p.portText = make('span', 'remote-port');
    p.portBtn = button('ghost small', 'Change port', () => changePort(p.portBtn, p.powerStatus));
    p.portHelp = make('p', 'remote-help', 'Changing the port closes the phones connected now.');
    powerBlock.append(p.intro, p.storageNote, p.plainNotes, enabled.label, p.powerStatus, line(p.portText, p.portBtn), p.portHelp);
    enabled.input.addEventListener('change', () => togglePhones(enabled.input, p.powerStatus));

    // Ways to reach this computer.
    const waysHead = make('h5', 'remote-sub', 'Ways to reach this computer');
    p.computerOnly = make('p', 'remote-help', 'Only the computer can change how phones reach it. Use Settings › Phones there.');
    const lanBlock = make('div', 'remote-block');
    const lan = switchRow('Same network', 'Phones on the same Wi-Fi or wired network reach this computer directly.');
    p.lan = lan.input;
    p.lanNotes = notesWrap();
    const any = switchRow('Any address', 'Accepts phones from any address, not only the private networks. Leave this off unless you need it.');
    p.lanAny = any.input;
    p.lanText = make('p', 'remote-help');
    p.lanError = make('p', 'remote-error');
    p.lanFirewall = make('p', 'remote-help');
    p.lanStatus = statusEl();
    lanBlock.append(lan.label, p.lanNotes, p.lanText, p.lanError, p.lanFirewall, any.label, p.lanStatus);
    lan.input.addEventListener('change', async () => {
      const want = lan.input.checked;
      const data = await save({ controls: [lan.input], status: p.lanStatus, path: '/api/phones/lan', body: { enabled: want }, revert: () => { lan.input.checked = !want; } });
      if (data) applyState(data);
      paintAll();
    });
    any.input.addEventListener('change', async () => {
      const want = any.input.checked;
      const data = await save({ controls: [any.input], status: p.lanStatus, path: '/api/phones/lan', body: { anyAddress: want }, revert: () => { any.input.checked = !want; } });
      if (data) applyState(data);
      paintAll();
    });

    const tsBlock = make('div', 'remote-block');
    p.tsNotes = notesWrap();
    const ts = switchRow('Tailscale', 'Reaches this computer through your own Tailscale account, from anywhere. Turning this on is your consent for Plenum to run tailscale serve.');
    p.ts = ts.input;
    p.tsText = make('p', 'remote-help');
    p.tsStatus = statusEl();
    tsBlock.append(p.tsNotes, ts.label, p.tsText, p.tsStatus);
    ts.input.addEventListener('change', async () => {
      const want = ts.input.checked;
      const data = await save({ controls: [ts.input], status: p.tsStatus, path: '/api/phones/tailscale', body: { enabled: want }, revert: () => { ts.input.checked = !want; } });
      if (data) applyState(data);
      paintAll();
    });

    const relayBlock = make('div', 'remote-block');
    p.relayNotes = notesWrap();
    const relay = switchRow('Your relay', 'Reaches this computer through a relay you deploy in your own Cloudflare account. Save its address first.');
    p.relay = relay.input;
    const urlId = `remote-relay-${++uid}`;
    const urlField = make('div', 'field');
    const urlLabel = make('label', 'field-label', 'Relay address');
    urlLabel.htmlFor = urlId;
    p.relayUrl = document.createElement('input');
    p.relayUrl.type = 'url';
    p.relayUrl.id = urlId;
    p.relayUrl.autocomplete = 'off';
    p.relayUrl.spellcheck = false;
    p.relayUrl.placeholder = 'https://your-relay.your-account.workers.dev';
    p.relaySave = button('ghost small', 'Save address', null);
    p.relayStatus = statusEl();
    urlField.append(urlLabel, p.relayUrl);
    p.relayUrl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        p.relaySave.click();
      }
    });
    p.relaySave.addEventListener('click', async () => {
      const data = await save({ controls: [p.relaySave], status: p.relayStatus, path: '/api/phones/relay', body: { url: p.relayUrl.value.trim() } });
      if (data) applyState(data);
      paintAll();
    });
    p.deploy = button('ghost small', 'Deploy to Cloudflare', () => {
      if (!/^https:\/\//.test(DEPLOY_URL)) return;
      if (typeof window.plenumShell?.openExternal === 'function') window.plenumShell.openExternal(DEPLOY_URL);
      else window.open(DEPLOY_URL, '_blank', 'noopener');
    });
    const deployNote = make('p', 'remote-help', 'Opens Cloudflare in your browser. You need free Cloudflare and GitHub accounts, and the relay runs in your account, not ours.');
    p.relayText = make('p', 'remote-help');
    p.newRoomBtn = button('ghost small', 'New room', newRoom);
    p.newRoomLine = line(p.newRoomBtn);
    p.newRoomLine.hidden = true;
    relay.input.addEventListener('change', async () => {
      const want = relay.input.checked;
      const data = await save({ controls: [relay.input], status: p.relayStatus, path: '/api/phones/relay', body: { enabled: want }, revert: () => { relay.input.checked = !want; } });
      if (data) applyState(data);
      paintAll();
    });
    relayBlock.append(p.relayNotes, relay.label, urlField, line(p.relaySave, p.deploy), deployNote, p.relayText, p.newRoomLine, p.relayStatus);

    // Paired phones.
    const pairBlock = make('div', 'remote-block');
    p.pairNotes = notesWrap();
    p.addBtn = button('primary', 'Add phone', addPhone);
    p.offer = make('div', 'remote-offer');
    p.offerTitle = make('p', 'remote-offer-title');
    p.offerDetail = make('p', 'remote-offer-text');
    p.offerTried = make('p', 'remote-offer-text');
    p.offerLeft = make('p', 'remote-offer-text');
    p.offerCode = make('p', 'remote-offer-code');
    p.offerCount = make('p', 'remote-offer-text');
    p.offerError = make('p', 'remote-error');
    p.offerError.setAttribute('role', 'status');
    p.offerDeny = button('ghost', 'Deny', () => answerPhone(false));
    p.offerAllow = button('primary', 'Allow', () => answerPhone(true));
    p.offerAnswer = line(p.offerDeny, p.offerAllow);
    p.offerAnswer.classList.add('remote-answer');
    p.offerAnswer.hidden = true;
    p.offerCancel = button('ghost small', 'Cancel', cancelPhone);
    p.offerNew = button('ghost small', 'New code', addPhone);
    p.offerCopy = button('ghost small', 'Copy link', async () => {
      const link = offer?.link ?? '';
      if (!link) return;
      const ok = await MuseUI.copyText?.(link);
      MuseUI.toast(ok ? 'Link copied.' : 'The link could not be copied.', ok ? 'ok' : 'bad');
    });
    p.offerDone = button('ghost small', 'Done', () => {
      offer = null;
      paintOffer();
    });
    p.offer.append(p.offerTitle, p.offerDetail, p.offerTried, p.offerLeft, p.offerCode, p.offerCount, p.offerAnswer, p.offerError, line(p.offerCancel, p.offerNew, p.offerCopy, p.offerDone));
    p.empty = make('p', 'remote-quiet', 'No phone is paired yet. Add phone starts the pairing, and the code appears in the window on this computer.');
    p.devices = make('ul', 'remote-devices');
    const expiryId = `remote-expiry-${++uid}`;
    const expiryField = make('div', 'field');
    const expiryLabel = make('label', 'field-label', 'Remove a phone that has not connected for');
    expiryLabel.htmlFor = expiryId;
    p.expirySel = make('select');
    p.expirySel.id = expiryId;
    for (const [days, label] of EXPIRY_OPTIONS) {
      const option = make('option', null, label);
      option.value = String(days);
      p.expirySel.append(option);
    }
    expiryField.append(expiryLabel, p.expirySel);
    p.expiryStatus = statusEl();
    p.expirySel.addEventListener('change', async () => {
      const data = await save({ controls: [p.expirySel], status: p.expiryStatus, path: '/api/phones/settings', body: { autoExpireDays: Number(p.expirySel.value) } });
      if (data) applyState(data);
      paintAll();
    });
    p.removeAll = button('ghost small', 'Remove all', removeAll);
    p.removeAllHelp = make('p', 'remote-help', 'Also gives this computer a new key, so every phone must pair again.');
    p.removeAllStatus = statusEl();
    pairBlock.append(p.pairNotes, line(p.addBtn), p.offer, p.empty, p.devices, expiryField, p.expiryStatus, line(p.removeAll), p.removeAllHelp, p.removeAllStatus);

    // Notifications.
    const pushBlock = make('div', 'remote-block');
    for (const [key, title, help] of PUSH_SWITCHES) {
      const row = switchRow(title, help);
      p.push[key] = row.input;
      pushBlock.append(row.label);
      row.input.addEventListener('change', () => savePush(key, row.input, p.pushStatus));
    }
    p.pushNotes = notesWrap();
    p.pushStatus = statusEl();
    p.testBtn = button('ghost small', 'Test', null);
    p.testStatus = statusEl();
    p.testBtn.addEventListener('click', () => testPush(p.testBtn, p.testStatus));
    pushBlock.append(p.pushNotes, p.pushStatus, line(p.testBtn), p.testStatus);

    // Stop and activity.
    const stopBlock = make('div', 'remote-block');
    p.stopBtn = button('ghost', 'Stop all', null);
    p.stopBtn.addEventListener('click', () => stopAll(p.stopBtn, p.stopStatus));
    p.stopHelp = make('p', 'remote-help', 'Ends every reply, computer and browser run and agent on this computer, and denies the cards waiting for an answer. The same as Stop on a phone.');
    p.stopStatus = statusEl();
    p.activityHead = make('h5', 'remote-sub', 'Activity from phones');
    p.activityList = make('ul', 'remote-activity');
    p.activityEmpty = make('p', 'remote-quiet', 'Nothing from a phone yet. What a phone does here is listed with its name.');
    stopBlock.append(line(p.stopBtn), p.stopHelp, p.stopStatus, p.activityHead, p.activityEmpty, p.activityList);

    p.main.append(
      powerBlock,
      waysHead, p.computerOnly, lanBlock, tsBlock, relayBlock,
      make('h5', 'remote-sub', 'Paired phones'), pairBlock,
      make('h5', 'remote-sub', 'Notifications'), pushBlock,
      make('h5', 'remote-sub', 'Stop'), stopBlock,
    );
    root.append(p.plain, p.error, p.main);
    return p;
  }

  // The section's render, run each time the Settings page draws it. It builds the parts once and reads the server's state.
  function render(body) {
    page = build();
    body.append(page.root);
    paintAll();
    refreshState();
    refreshActivity();
  }

  // The Settings section is optional: without the Settings page the title-bar chip still draws, from the state read below.
  if (MuseUI.settings && typeof MuseUI.settings.register === 'function') {
    MuseUI.settings.register({ id: SECTION_ID, scope: 'app', title: SECTION_TITLE, group: SECTION_GROUP, order: SECTION_ORDER, render });
  }

  // Read at start, so the title-bar chip is right before the Settings page is ever opened.
  refreshState();
})();
