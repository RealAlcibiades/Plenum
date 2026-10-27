// The part 2 shell screens (mob-10, wave 107; MOBILE-UI 6.11, 6.12, 6.17, 6.18 and 10). Each builder takes the render context (main.js
// ctx, with ctx.vm, the view model the router builds from the shell state) and `io`, the only way a screen reaches the shell:
//   io.act.*    actions (main.js): connect, rename, forget, moveWay, testWays, setPush, setApprove, testPush, enableNotifications,
//               lockOn, lockOff, lockNow, setPin, afterPin, setPref, installApp, dismissLan, debugCopy, debugSend, debugClear,
//               openLegal, demoDecide, demoStop, demoReset, exitDemo, stop, chooseComputer
//   io.local    what the screen keeps while open (renameName, debugNote, legalNote, pinEntry, ...)
//   io.go(id), io.back(), io.later(fn, ms), io.repaint()
// A screen never touches the channel, the store or the keys. Text goes in with textContent only; every control is 44 px or taller.

import { button, el } from './dom.js';
import * as C from './copy.js';
import * as C2 from './copy2.js';
import * as S from './settings.js';
import { clock, fill } from './copy.js';
import { frame, mark, para } from './views.js';

const section = label => el('p', { class: 'sh-section', text: label });

// A row that opens another screen or runs an action: label, a value on the right, and a chevron.
function row(label, value, onClick, extra = {}) {
  return el('button', { type: 'button', class: 'sh-row', ...extra, on: { click: onClick } },
    el('span', { class: 'sh-row-label', text: label }),
    value ? el('span', { class: 'sh-row-value', text: value }) : null,
    el('span', { class: 'sh-row-chev', 'aria-hidden': 'true', text: '›' }));
}

// An on/off switch (role=switch). A disabled switch keeps focus and says why in its note.
function switchRow({ label, checked, disabled = false, note = null, onChange, id = null }) {
  const noteId = note && id ? `${id}-note` : null;
  return el('div', { class: `sh-switch-wrap${disabled ? ' sh-switch-off' : ''}` },
    el('button', {
      type: 'button',
      class: 'sh-switch',
      role: 'switch',
      id,
      'aria-checked': checked ? 'true' : 'false',
      'aria-disabled': disabled ? 'true' : null,
      'aria-describedby': noteId,
      on: { click: () => { if (!disabled && onChange) onChange(!checked); } },
    },
    el('span', { class: 'sh-switch-label', text: label }),
    el('span', { class: 'sh-switch-knob', 'aria-hidden': 'true' })),
    note ? el('p', { class: 'sh-help', id: noteId, text: note }) : null);
}

// A group of choices (role=radiogroup, each role=radio, 44 px). The chosen one has aria-checked true.
function radioGroup(label, options, value, onPick) {
  return el('div', { class: 'sh-radios', role: 'radiogroup', 'aria-label': label },
    options.map(opt => el('button', {
      type: 'button',
      class: 'sh-radio',
      role: 'radio',
      'aria-checked': opt.id === value ? 'true' : 'false',
      on: { click: () => onPick(opt.id) },
    }, el('span', { class: 'sh-radio-dot', 'aria-hidden': 'true' }), el('span', { text: opt.label }))));
}

const msgNode = text => (text ? el('p', { class: 'sh-msg', role: 'status', text }) : null);

// ---- pair-review (C6e, D5): a pairing link opened from outside the app. Pair starts it; Cancel drops it. Nothing is stored before Pair. ----
function pairReview(ctx, io) {
  const hosts = Array.isArray(ctx.review?.hosts) ? ctx.review.hosts : [];
  return frame(ctx, io, {
    title: C2.PAIR_REVIEW_TITLE(ctx.review?.name || 'Plenum computer'),
    body: [
      para(C2.PAIR_REVIEW_LEAD, 'sh-note'),
      para(C2.PAIR_REVIEW_HOSTS, 'sh-label'),
      ...hosts.map(h => para(`${C.CARRIER_LABEL[h.kind]}: ${h.host}`, 'sh-note')),
      para(C2.PAIR_REVIEW_NOTE, 'sh-help'),
    ],
    actions: [
      button(C2.PAIR_REVIEW_CANCEL, { kind: 'ghost', onClick: () => io.act.cancelPair() }),
      button(C2.PAIR_REVIEW_PAIR, { kind: 'primary', onClick: () => io.act.confirmPair() }),
    ],
  });
}

// ---- computers (6.11) ----
// Rows of paired computers. "⋯" opens the row's own actions: Connect, Ways to reach it, Rename on this phone, Forget this computer.
function computers(ctx, io) {
  const vm = ctx.vm;
  const menuOpen = io.local.rowMenu ?? null;
  const rows = vm.computers.map(c => {
    const status = C2.rowStatus({ active: c.active, connected: c.connected, status: c.status, lastSeen: c.lastSeen, dateText: c.dateText });
    const meta = [c.active && c.connected ? c.carrierLabel : (c.lastCarrierLabel ? `Last by ${c.lastCarrierLabel}` : null), c.version ? `Plenum ${c.version}` : null]
      .filter(Boolean).join(' · ');
    const menu = menuOpen === c.id
      ? el('div', { class: 'sh-rowmenu' },
        button(C2.ROW_MENU.connect, { kind: 'ghost', onClick: () => io.act.connect(c.id) }),
        button(C2.ROW_MENU.ways, { kind: 'ghost', onClick: () => { io.local.waysFor = c.id; io.go('settings-connection'); } }),
        button(C2.ROW_MENU.rename, { kind: 'ghost', onClick: () => { io.local.renameId = c.id; io.go('rename'); } }),
        button(C2.ROW_MENU.forget, { kind: 'danger', onClick: () => { io.local.forgetId = c.id; io.go('forget'); } }))
      : null;
    return el('li', { class: 'sh-computer' },
      el('div', { class: 'sh-computer-main' },
        el('button', { type: 'button', class: 'sh-computer-open', on: { click: () => io.act.connect(c.id) } },
          el('span', { class: 'sh-computer-name', text: c.name }),
          status ? el('span', { class: 'sh-computer-status', text: status }) : null,
          meta ? el('span', { class: 'sh-computer-meta', text: meta }) : null),
        el('button', {
          type: 'button',
          class: 'sh-icon sh-computer-more',
          'aria-label': `More for ${c.name}`,
          'aria-expanded': menuOpen === c.id ? 'true' : 'false',
          on: { click: () => { io.local.rowMenu = menuOpen === c.id ? null : c.id; io.repaint(); } },
        }, '⋯')),
      menu);
  });
  const gear = el('button', { type: 'button', class: 'sh-icon', 'aria-label': C2.SETTINGS_TITLE, on: { click: () => io.go('settings') } }, '⚙');
  return frame(ctx, io, {
    title: C2.COMPUTERS_TITLE,
    trailing: gear,
    body: [
      section(C2.COMPUTERS_LABEL),
      rows.length ? el('ul', { class: 'sh-computers' }, rows) : para(C2.SETTINGS_NONE, 'sh-note'),
    ],
    actions: [button(C2.PAIR_ANOTHER, { kind: 'primary', onClick: () => io.go('how') })],
  });
}

// ---- install-ios, install-android, lan-web (6.12) ----
function installIos(ctx, io) {
  return frame(ctx, io, {
    title: 'Add Plenum to your Home Screen',
    back: true,
    body: [
      para(C2.INSTALL_IOS_BODY, 'sh-note'),
      el('ol', { class: 'sh-steps sh-install-steps' }, C2.INSTALL_IOS_STEPS.map((text, i) => el('li', { class: 'sh-install-step', 'data-step': String(i + 1) }, text))),
    ],
    actions: [button(C2.INSTALL_IOS_PAIR_HERE, { kind: 'primary', onClick: () => io.go('how') })],
  });
}

function installAndroid(ctx, io) {
  return frame(ctx, io, {
    title: 'Install Plenum',
    back: true,
    body: [
      para(C2.INSTALL_ANDROID_BODY, 'sh-note'),
      msgNode(io.local.installNote ?? null),
    ],
    actions: [
      button(C2.NOT_NOW, { kind: 'ghost', onClick: () => io.go('how') }),
      button('Install', { kind: 'primary', onClick: () => io.act.installApp() }),
    ],
  });
}

function lanWeb(ctx, io) {
  return frame(ctx, io, {
    title: 'Plenum on this page',
    back: true,
    body: [para(fill(C2.LAN_WEB_STRIP, ctx.computer), 'sh-note')],
    actions: [button('Got it', { kind: 'primary', onClick: () => { io.act.dismissLan(); io.back(); } })],
  });
}

// ---- connected (the shell's own page while the phone is connected: /?shell, a phone with no UI to hand over to, and a reconnect; MOBILE-UI 6.7 and 8) ----
function connected(ctx, io) {
  const vm = ctx.vm;
  const pending = C.pendingLine(ctx.computer, ctx.pending);
  const actions = [
    // The computer's UI is the phone's home (ui-host.js hands the page to it after HELLO). This page is the shell's own screens (/?shell), so
    // the way back to the UI is a button.
    ctx.uiAvailable && !ctx.reconnecting ? button('Open Plenum', { kind: 'primary', onClick: () => io.act.openUi() }) : null,
    vm.computers.length > 1 ? button('Computers', { kind: 'ghost', onClick: () => io.go('computers') }) : null,
    button('Ways to reach', { kind: 'ghost', onClick: () => io.go('settings-connection') }),
    button('Phone settings', { kind: ctx.uiAvailable && !ctx.reconnecting ? 'ghost' : 'primary', onClick: () => io.go('settings') }),
  ];
  if (ctx.reconnecting) {
    return frame(ctx, io, {
      kicker: C2.RECONNECTING_TITLE,
      kickerClass: 'sh-status',
      title: ctx.computer,
      body: [para(C2.RECONNECTING_BODY(ctx.computer), 'sh-note')],
      actions,
    });
  }
  return frame(ctx, io, {
    kicker: `✓ ${C2.CONNECTED_TITLE}`,
    kickerClass: 'sh-status',
    title: ctx.computer,
    body: [
      para(C2.CONNECTED_SINCE(ctx.computer, vm.connected.since), 'sh-note'),
      para(`${vm.connected.carrierLabel ?? 'No carrier named'}${ctx.desktopVersion ? ` · Plenum ${ctx.desktopVersion}` : ''}`, 'sh-help'),
      pending ? para(pending, 'sh-note') : null,
    ],
    actions,
  });
}

// ---- rename and forget (6.17) ----
function rename(ctx, io) {
  const target = vm => vm.computers.find(c => c.id === io.local.renameId) ?? vm.computers.find(c => c.active) ?? null;
  const current = target(ctx.vm);
  const input = el('input', { class: 'sh-input', id: 'sh-rename', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '60', 'aria-describedby': 'sh-rename-help' });
  input.value = io.local.renameValue ?? current?.name ?? '';
  input.addEventListener('input', () => { io.local.renameValue = input.value; });
  return frame(ctx, io, {
    title: C2.RENAME_TITLE,
    back: true,
    body: [
      el('div', { class: 'sh-field' },
        el('label', { class: 'sh-label', for: 'sh-rename', text: 'Name' }),
        input,
        para(C2.RENAME_HELP, 'sh-help')),
      msgNode(io.local.renameNote ?? null),
    ],
    actions: [
      button(C2.CANCEL, { kind: 'ghost', onClick: () => io.back() }),
      button(C2.SAVE, { kind: 'primary', onClick: async () => {
        const result = await io.act.rename(current?.id ?? null, String(input.value ?? ''));
        if (result?.ok) { io.local.renameNote = null; io.back(); return; }
        io.local.renameNote = 'The name could not be saved. Try again.';
        io.repaint();
      } }),
    ],
  });
}

function forget(ctx, io) {
  const id = io.local.forgetId ?? ctx.vm.computers.find(c => c.active)?.id ?? null;
  const name = ctx.vm.computers.find(c => c.id === id)?.name ?? ctx.computer;
  let cancel = null;
  const root = frame(ctx, io, {
    title: C2.fillName(C2.FORGET_TITLE, name),
    back: true,
    body: [para(C2.fillName(C2.FORGET_BODY, name), 'sh-note'), msgNode(io.local.forgetNote ?? null)],
    actions: [
      cancel = button(C2.CANCEL, { kind: 'ghost', onClick: () => io.back() }),
      button(C2.FORGET_CONFIRM, {
        kind: 'danger',
        onClick: async () => {
          const result = await io.act.forget(id);
          if (result?.ok) { io.local.forgetId = null; io.go('computers'); return; }
          io.local.forgetNote = 'Plenum could not forget this computer. Try again.';
          io.repaint();
        },
      }),
    ],
  });
  // Cancel has the initial focus (MOBILE-UI 6.17, D-03 for the desktop window): a stray Enter does not forget the computer.
  io.later(() => { cancel?.focus?.({ preventScroll: true }); }, 0);
  return root;
}

// ---- Phone settings (6.17) ----
function settings(ctx, io) {
  const vm = ctx.vm;
  const computerRows = vm.computers.map(c => row(c.name, c.active && c.connected ? 'Connected' : null, () => {
    io.local.waysFor = c.id;
    io.go('settings-connection');
  }));
  const lockValue = vm.lock.mode === 'off' ? 'Off' : `${vm.lock.label} · ${S.lockAfter(vm.prefs.lockAfter).label}`;
  return frame(ctx, io, {
    title: C2.SETTINGS_TITLE,
    back: true,
    body: [
      section(C2.SETTINGS_COMPUTERS),
      el('div', { class: 'sh-rows' }, computerRows, row(C2.PAIR_ANOTHER_SHORT, null, () => io.go('how'))),
      section(C2.SETTINGS_THIS_PHONE),
      el('div', { class: 'sh-rows' },
        row(C2.NOTIFY_TITLE, vm.notify.label, () => io.go('settings-notify')),
        row(C2.LOCK_TITLE, lockValue, () => io.go('settings-lock')),
        row(C2.APPEARANCE_TITLE, S.THEME_LABEL[vm.prefs.theme], () => io.go('settings-appearance')),
        vm.native ? row(C2.DICTATION_TITLE, 'On this phone', () => io.go('settings-dictation')) : null),
      section(C2.SETTINGS_HELP),
      el('div', { class: 'sh-rows' },
        row('Debug console', null, () => io.go('debug')),
        row('About', vm.about.appVersion ? vm.about.appVersion : null, () => io.go('about')),
        row(C2.LEGAL_TITLE, null, () => io.go('legal')),
        row('Report a problem', null, () => io.go('debug'))),
    ],
  });
}

// Ways to reach (6.17): the carriers in the order this phone tries them, with Move up and Move down as 44 px buttons.
function settingsConnection(ctx, io) {
  const vm = ctx.vm;
  const id = io.local.waysFor ?? vm.computers.find(c => c.active)?.id ?? vm.computers[0]?.id ?? null;
  const target = vm.computers.find(c => c.id === id) ?? null;
  const name = target?.name ?? ctx.computer;
  const order = S.orderedWays(target?.carrierOrder ?? []);
  const present = new Set(target?.ways ?? []);
  const ways = order.map((kind, i) => {
    const on = present.has(kind);
    const web = ctx.platform === 'web' && !ctx.lan && kind === 'lan';
    const label = C.CARRIER_LABEL[kind];
    const note = web ? C2.WAY_LAN_WEB : on ? (target?.waysDetail?.[kind] ?? null) : C2.WAY_NO_ADDRESS;
    const probe = io.local.wayProbe?.[kind] ?? null;
    return el('li', { class: `sh-way${on ? '' : ' sh-way-off'}` },
      el('div', { class: 'sh-way-main' },
        el('p', { class: 'sh-way-title' },
          el('span', { class: 'sh-way-state', 'aria-hidden': 'true', text: on ? '[x]' : '[ ]' }),
          el('span', { text: label }),
          el('span', { class: 'sh-way-probe', text: web ? C2.WAY_NOT_AVAILABLE : (probe ?? (on ? '' : C2.WAY_NOT_REACHABLE)) })),
        note ? el('p', { class: 'sh-help', text: note }) : null),
      el('div', { class: 'sh-way-move' },
        el('button', {
          type: 'button',
          class: 'sh-move',
          'aria-label': `${C2.WAY_MOVE_UP}: ${label}`,
          'aria-disabled': i === 0 ? 'true' : null,
          on: { click: () => { if (i > 0) io.act.moveWay(id, kind, 'up'); } },
        }, '↑'),
        el('button', {
          type: 'button',
          class: 'sh-move',
          'aria-label': `${C2.WAY_MOVE_DOWN}: ${label}`,
          'aria-disabled': i === order.length - 1 ? 'true' : null,
          on: { click: () => { if (i < order.length - 1) io.act.moveWay(id, kind, 'down'); } },
        }, '↓')));
  });
  return frame(ctx, io, {
    title: fill(C2.WAYS_TITLE, name),
    back: true,
    body: [
      para(C2.WAYS_LEAD, 'sh-note'),
      el('ul', { class: 'sh-ways' }, ways),
      button(C2.WAYS_TEST, { kind: 'ghost', onClick: () => io.act.testWays(id) }),
      msgNode(io.local.waysNote ?? null),
      para(C2.WAYS_NEW, 'sh-help'),
      el('div', { class: 'sh-links' },
        button('Rename on this phone', { kind: 'link', onClick: () => { io.local.renameId = id; io.go('rename'); } }),
        button(C2.ROW_MENU.forget, { kind: 'link', onClick: () => { io.local.forgetId = id; io.go('forget'); } })),
    ],
  });
}

// Notifications (6.17, 10, 14.1). The kept-on-computer switches call POST /api/phones/push; Approve from notifications depends on the
// first line and the app lock, and says which one is missing.
function settingsNotify(ctx, io) {
  const vm = ctx.vm;
  const push = vm.push;
  const approve = vm.approve;
  const pushRows = S.PUSH_SWITCHES.map(sw => {
    const key = sw.key;
    const label = sw.key === 'onlyWhenAway' ? fill(sw.label, ctx.computer) : sw.label;
    const note = key === 'firstLine' ? C2.PHONE_PUSH_TEXT : null;
    return switchRow({
      label,
      checked: push[key] === true,
      note,
      id: `sh-push-${key}`,
      onChange: value => io.act.setPush(key, value),
    });
  });
  const approveRow = approve.visible
    ? switchRow({
      label: C2.NOTIFY_APPROVE_ROW,
      checked: approve.checked,
      disabled: !approve.enabled,
      note: approve.enabled ? null : S.APPROVE_MISSING_TEXT[approve.missing] ?? null,
      id: 'sh-approve',
      onChange: value => io.act.setApprove(value),
    })
    : null;
  const notes = [
    para(fill(C2.APPROVE_NOTIFY_TEXT, ctx.computer), 'sh-note'),
    para(C2.APPROVE_BLOCKED_TEXT, 'sh-help'),
  ];
  // Android (M15): the push app UnifiedPush goes through, and a way to choose it. The line says what the phone has now.
  const up = vm.unifiedPush;
  const androidLine = up ? para(S.unifiedPushLine(up.distributor ?? null), 'sh-note') : null;
  const chooseApp = up?.supported
    ? button('Choose app', { kind: 'ghost', onClick: () => io.act.chooseDistributor() })
    : null;
  return frame(ctx, io, {
    title: C2.NOTIFY_TITLE,
    back: true,
    body: [
      section(C2.NOTIFY_ON_PHONE),
      el('div', { class: 'sh-rows' }, row(C2.NOTIFY_ON_PHONE, vm.notify.label, () => io.act.enableNotifications())),
      vm.notify.hint ? para(vm.notify.hint, 'sh-help') : null,
      section(fill(C2.NOTIFY_KEPT, ctx.computer)),
      el('div', { class: 'sh-switches' }, pushRows, approveRow, approve.visible ? el('div', { class: 'sh-notes' }, notes) : null),
      androidLine,
      chooseApp,
      button(C2.NOTIFY_TEST, { kind: 'ghost', onClick: () => io.act.testPush() }),
      msgNode(io.local.notifyNote ?? null),
      para(ctx.platform === 'android' ? C2.NOTIFY_NOT_ARRIVING_ANDROID : C2.NOTIFY_NOT_ARRIVING, 'sh-help'),
    ],
  });
}

// App lock (6.13, 6.17, 14.1 phone-lock-off and phone-web-storage).
function settingsLock(ctx, io) {
  const vm = ctx.vm;
  const on = vm.lock.mode !== 'off';
  const web = ctx.platform === 'web';
  return frame(ctx, io, {
    title: C2.LOCK_TITLE,
    back: true,
    body: [
      switchRow({
        label: C2.LOCK_ROW,
        checked: on,
        id: 'sh-lock-switch',
        onChange: async value => {
          if (!value) { io.go('phone-lock-off'); return; }
          if (web) { io.go('pin-set'); return; }
          const result = await io.act.lockOn('biometric');
          io.local.lockNote = result?.ok ? null : 'Plenum did not turn the app lock on. Try again.';
          io.repaint();
        },
      }),
      on ? null : para(C2.LOCK_OFF_HINT, 'sh-note'),
      on ? para(`${C2.LOCK_AFTER_LABEL}`, 'sh-section') : null,
      on ? radioGroup(C2.LOCK_AFTER_LABEL, S.LOCK_AFTER, vm.prefs.lockAfter, id => io.act.setPref({ lockAfter: id })) : null,
      switchRow({
        label: C2.LOCK_SWITCHER,
        checked: vm.prefs.hideSwitcher,
        id: 'sh-switcher',
        onChange: value => io.act.setPref({ hideSwitcher: value }),
      }),
      web ? para(C2.LOCK_WEB_KEY, 'sh-note') : null,
      msgNode(io.local.lockNote ?? null),
    ],
    actions: [
      on ? button(C2.LOCK_NOW, { kind: 'primary', onClick: () => io.act.lockNow() }) : null,
      !on && web && ctx.passkeyAvailable ? button('Use a passkey', { kind: 'ghost', onClick: async () => { const r = await io.act.lockOn('passkey'); io.local.lockNote = r?.ok ? null : 'A passkey could not be set up here.'; io.repaint(); } }) : null,
    ],
  });
}

// Turning the lock off (14.1 phone-lock-off). With a PIN the PIN is typed here; the lock is turned off only when it checks.
function phoneLockOff(ctx, io) {
  const pinMode = ctx.vm.lock.mode === 'pin';
  const input = pinMode
    ? el('input', { class: 'sh-input', id: 'sh-pin-off', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', 'aria-label': 'PIN' })
    : null;
  return frame(ctx, io, {
    title: C2.LOCK_OFF_TITLE,
    back: true,
    body: [
      el('p', { class: 'sh-msg sh-warn', role: 'note', text: C2.LOCK_OFF_TEXT }),
      input ? el('div', { class: 'sh-field' }, el('label', { class: 'sh-label', for: 'sh-pin-off', text: 'Enter your PIN' }), input) : null,
      msgNode(io.local.lockNote ?? null),
    ],
    actions: [
      button(C2.LOCK_OFF_KEEP, { kind: 'primary', onClick: () => io.back() }),
      button(C2.LOCK_OFF_TURN, {
        kind: 'danger',
        onClick: async () => {
          const result = await io.act.lockOff(input ? String(input.value ?? '') : null);
          if (result?.ok) { io.local.lockNote = null; io.go('settings-lock'); return; }
          io.local.lockNote = result?.reason === 'pin' ? 'That PIN is not right.' : 'Plenum did not turn the lock off. Try again.';
          io.repaint();
        },
      }),
    ],
  });
}

// PIN setup (6.9 "Set a PIN", the PWA). Six digits, entered twice. Done sets the PIN and moves on (the onboarding goes on when it came from
// there). The keypad is the one the lock uses, so the digits are never shown.
function pinSet(ctx, io) {
  const state = io.local.pinSet ?? (io.local.pinSet = { first: null, digits: '', note: null });
  const dots = Array.from({ length: 6 }, () => el('span', { class: 'sh-dot', 'aria-hidden': 'true' }));
  const counter = el('span', { class: 'sh-sr', 'aria-live': 'polite' }, '0 of 6 digits entered');
  const message = el('p', { class: 'sh-msg', role: 'alert', id: 'sh-pin-set-msg' }, state.note ?? null);
  const draw = () => {
    dots.forEach((dot, i) => { if (i < state.digits.length) dot.setAttribute('data-on', ''); else dot.removeAttribute('data-on'); });
    counter.textContent = `${state.digits.length} of 6 digits entered`;
  };
  const press = async key => {
    if (key === 'Delete') { state.digits = state.digits.slice(0, -1); draw(); return; }
    if (state.digits.length >= 6) return;
    state.digits += key;
    draw();
    if (state.digits.length < 6) return;
    const entered = state.digits;
    state.digits = '';
    draw();
    if (state.first === null) {
      state.first = entered;
      state.note = 'Enter the same PIN again.';
      io.repaint();
      return;
    }
    if (entered !== state.first) {
      state.first = null;
      state.note = 'The two PINs did not match. Start again.';
      io.repaint();
      return;
    }
    const result = await io.act.setPin(entered);
    state.first = null;
    if (result?.ok) {
      state.note = null;
      io.afterPin();
      return;
    }
    state.note = result?.reason === 'mode' ? 'The lock is already on.' : 'That PIN is not valid. Use six digits.';
    io.repaint();
  };
  const keyNames = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'Delete'];
  const pad = el('div', { class: 'sh-pad', role: 'group', 'aria-label': 'PIN' },
    keyNames.map(key => key === null
      ? el('span', { class: 'sh-key-gap', 'aria-hidden': 'true' })
      : el('button', {
        type: 'button',
        class: key === 'Delete' ? 'sh-key sh-key-del' : 'sh-key',
        'aria-label': key === 'Delete' ? 'Delete' : key,
        on: { click: () => { press(key); } },
      }, key === 'Delete' ? 'Delete' : key)));
  draw();
  return frame(ctx, io, {
    title: state.first === null ? 'Set a PIN' : 'Enter the PIN again',
    back: true,
    body: [
      para('Plenum asks for this PIN before it connects, and again after the lock time you choose. Six digits.', 'sh-note'),
      el('div', { class: 'sh-dots' }, dots),
      counter,
      pad,
      message,
    ],
  });
}

// Appearance (6.17, 8.12). The theme, text size, Stop side and haptics are kept on this phone.
function settingsAppearance(ctx, io) {
  const vm = ctx.vm;
  const prefs = vm.prefs;
  const following = prefs.textSize == null;
  const slider = el('input', {
    class: 'sh-range',
    type: 'range',
    min: String(S.TEXT_MIN),
    max: String(S.TEXT_MAX),
    step: String(S.TEXT_STEP),
    value: String(prefs.textSize ?? S.TEXT_DEFAULT),
    'aria-label': 'Text size',
    'aria-valuetext': `${prefs.textSize ?? S.TEXT_DEFAULT} percent`,
    on: { input: event => { io.act.setPref({ textSize: Number(event.target.value) }, { quiet: true }); } },
  });
  return frame(ctx, io, {
    title: C2.APPEARANCE_TITLE,
    back: true,
    body: [
      section(C2.APPEARANCE_THEME),
      radioGroup(C2.APPEARANCE_THEME, S.THEMES.map(id => ({ id, label: S.THEME_LABEL[id] })), prefs.theme, id => io.act.setPref({ theme: id })),
      section(C2.APPEARANCE_TEXT),
      switchRow({
        label: C2.APPEARANCE_FOLLOW_TEXT,
        checked: following,
        id: 'sh-text-follow',
        onChange: value => io.act.setPref({ textSize: value ? null : S.TEXT_DEFAULT }),
      }),
      following ? null : el('div', { class: 'sh-field' },
        slider,
        el('p', { class: 'sh-sample', text: C2.APPEARANCE_SAMPLE })),
      section(C2.APPEARANCE_STOP),
      radioGroup(C2.APPEARANCE_STOP, [{ id: 'right', label: C2.APPEARANCE_STOP_RIGHT }, { id: 'left', label: C2.APPEARANCE_STOP_LEFT }], prefs.stopSide, id => io.act.setPref({ stopSide: id })),
      vm.haptics.visible
        ? switchRow({ label: C2.APPEARANCE_HAPTICS, checked: prefs.haptics, id: 'sh-haptics', onChange: value => io.act.setPref({ haptics: value }) })
        : null,
      vm.haptics.visible ? null : para(C2.APPEARANCE_HAPTICS_IOS, 'sh-help'),
      para(fill(C2.APPEARANCE_NOTE, ctx.computer), 'sh-help'),
    ],
  });
}

// Dictation (native, 6.17 and 14.1 phone-voice).
// What the phone's dictation can do now (the plugin's available()): the line the settings screen shows above its switches.
function dictationStatus(dictation) {
  if (!dictation?.known) return 'Checking what this phone can do…';
  if (!dictation.available) return 'Dictation is not available on this phone.';
  const where = dictation.onDevice ? 'on this phone' : 'through the phone\'s speech service';
  const mic = dictation.permission === 'denied' ? ' The microphone is off for Plenum: allow it in the phone\'s Settings.' : '';
  return `Dictation is available ${where}.${mic}`;
}

function settingsDictation(ctx, io) {
  const prefs = ctx.vm.prefs;
  const native = ctx.vm.native;
  return frame(ctx, io, {
    title: C2.DICTATION_TITLE,
    back: true,
    body: native
      ? [
        el('p', { class: 'sh-note', id: 'sh-dict-status', role: 'status', text: dictationStatus(ctx.vm.dictation) }),
        switchRow({ label: C2.DICTATION_PREFER, checked: prefs.dictationOnDevice, id: 'sh-dict-device', onChange: value => io.act.setPref({ dictationOnDevice: value }) }),
        switchRow({ label: C2.DICTATION_ALLOW, checked: prefs.dictationAllowService, id: 'sh-dict-service', note: C2.DICTATION_ALLOW_TEXT, onChange: value => io.act.setPref({ dictationAllowService: value }) }),
        el('p', { class: 'sh-msg sh-info', role: 'note', text: C2.PHONE_VOICE }),
      ]
      : [para(C2.DICTATION_WEB, 'sh-note')],
  });
}

// Debug console (6.17): the last 500 lines, newest last. Copy, Send to the computer and Clear.
function debug(ctx, io) {
  const lines = ctx.vm.debug.lines;
  const rows = lines.map(line => el('li', { class: `sh-log sh-log-${line.level}` },
    el('span', { class: 'sh-log-time', text: line.time }),
    el('span', { class: 'sh-log-text', text: line.text })));
  return frame(ctx, io, {
    title: C2.DEBUG_TITLE,
    back: true,
    body: [
      para(C2.DEBUG_LEAD, 'sh-help'),
      lines.length ? el('ol', { class: 'sh-logs', role: 'log', 'aria-label': C2.DEBUG_TITLE, 'aria-live': 'off' }, rows) : para(C2.DEBUG_EMPTY, 'sh-note'),
      msgNode(io.local.debugNote ?? null),
    ],
    actions: [
      button(C2.DEBUG_CLEAR, { kind: 'ghost', onClick: () => { io.act.debugClear(); io.local.debugNote = null; } }),
      button(C2.DEBUG_COPY, { kind: 'ghost', onClick: () => io.act.debugCopy(lines.map(l => `${l.time} ${l.text}`).join('\n')) }),
      button(fill(C2.DEBUG_SEND, ctx.computer), { kind: 'primary', onClick: () => io.act.debugSend() }),
    ],
  });
}

// About (6.17).
function about(ctx, io) {
  const a = ctx.vm.about;
  const lines = [
    C2.fillMany(C2.ABOUT_APP, { version: a.appVersion || '0.0.0' }),
    a.desktopVersion ? C2.fillMany(C2.ABOUT_COMPUTER, { computer: ctx.computer, version: a.desktopVersion }) : C2.ABOUT_NOT_CONNECTED,
    C2.fillMany(C2.ABOUT_LINK, { version: a.protocol || '1.0' }),
    a.screensLoaded ? C2.fillMany(C2.ABOUT_SCREENS_LOADED, { computer: ctx.computer, n: a.screensLoaded }) : C2.ABOUT_SCREENS_BUILT,
    a.since ? C2.fillMany(C2.ABOUT_CONNECTED, { carrier: a.carrierLabel ?? 'this network', when: a.since }) : null,
    a.newerUi ? fill(C2.ABOUT_NEWER_UI, ctx.computer) : null,
  ];
  return frame(ctx, io, {
    title: C2.ABOUT_TITLE,
    back: true,
    body: [el('ul', { class: 'sh-about' }, lines.filter(Boolean).map(text => el('li', { text })))],
  });
}

// Legal (6.17): bundled copies in this build do not exist yet, so each row says so (nothing is made up).
function legal(ctx, io) {
  const rows = Object.entries(C2.LEGAL_ROWS).map(([name, label]) => row(label, null, () => io.act.openLegal(name)));
  return frame(ctx, io, {
    title: C2.LEGAL_TITLE,
    back: true,
    body: [
      el('div', { class: 'sh-rows' }, rows),
      msgNode(io.local.legalNote ?? null),
      ctx.vm.connected.id ? para(fill(C2.LEGAL_VERSIONS, ctx.computer), 'sh-help') : null,
    ],
  });
}

// ---- demo (6.18): the replay home, the computer run, the diff and the artifact pictures ----
function demoHome(ctx, io) {
  const d = ctx.vm.demo;
  const waiting = d.approvals.filter(a => a.state === 'waiting');
  const runRows = d.runs.map(r => el('li', { class: `sh-run sh-run-${r.state}` },
    el('span', { class: 'sh-run-title', text: r.title }),
    el('span', { class: 'sh-run-meta', text: `${r.project} · ${RUN_WORD[r.state] ?? r.state}${r.waitingFor === 'approval' ? ' · waiting for you' : ''}` })));
  const cards = waiting.map(card => el('div', { class: 'sh-card', role: 'group', 'aria-label': C2.DEMO_APPROVAL },
    el('p', { class: 'sh-status', text: C2.DEMO_APPROVAL }),
    el('p', { class: 'sh-code-line', text: card.firstLine }),
    el('p', { class: 'sh-help', text: card.detail ?? '' }),
    el('div', { class: 'sh-card-actions' },
      button(C2.DEMO_DENY, { kind: 'ghost', onClick: () => io.act.demoDecide(card.id, 'deny') }),
      button(C2.DEMO_APPROVE, { kind: 'primary', onClick: () => io.act.demoDecide(card.id, 'approve') }))));
  const agents = d.agents.map(a => el('p', { class: 'sh-help', text: `${a.name}: ${a.state}` }));
  return frame(ctx, io, {
    title: C2.DEMO_TITLE,
    body: [
      section(C2.DEMO_RUNS),
      el('ul', { class: 'sh-runs' }, runRows),
      cards.length ? el('div', { class: 'sh-cards' }, cards) : null,
      agents.length ? el('div', { class: 'sh-agents' }, agents) : null,
      el('div', { class: 'sh-rows' },
        row(C2.DEMO_RUN_LABEL, d.drive ? `${d.drive.app}, step ${d.drive.step} of ${d.drive.of}` : null, () => io.go('demo-run')),
        row(C2.DEMO_DIFF_LABEL, d.diff ? `${d.diff.file} · +${d.diff.added} −${d.diff.removed}` : null, () => io.go('demo-diff')),
        row(C2.DEMO_ARTIFACT_LABEL, d.artifacts.length ? `${d.artifacts.length} picture${d.artifacts.length === 1 ? '' : 's'}` : null, () => io.go('demo-artifact')),
        row('Phone settings', null, () => io.go('settings'))),
      button(C2.DEMO_RESET, { kind: 'link', onClick: () => io.act.demoReset() }),
    ],
  });
}

const RUN_WORD = Object.freeze({ running: 'Running', finished: 'Finished', failed: 'Failed', stopped: 'Stopped' });

function demoRun(ctx, io) {
  const drive = ctx.vm.demo.drive;
  if (!drive) return frame(ctx, io, { title: C2.DEMO_RUN_LABEL, back: true, body: [para(C2.DEMO_EMPTY, 'sh-note')] });
  const frames = (drive.frames ?? []).map((f, i) => el('figure', { class: 'sh-frame' },
    f.src ? el('img', { class: 'sh-picture', src: f.src, alt: f.caption, width: '360', height: '220' }) : null,
    el('figcaption', { class: 'sh-help', text: `${i + 1}. ${f.caption}` })));
  const stateWord = drive.state === 'driving' ? 'A model is driving' : 'Stopped';
  return frame(ctx, io, {
    title: C2.DEMO_RUN_LABEL,
    back: true,
    body: [
      para(`${stateWord} ${ctx.computer}: ${drive.app}, step ${drive.step} of ${drive.of}.`, 'sh-note'),
      el('div', { class: 'sh-frames' }, frames),
    ],
  });
}

function demoDiff(ctx, io) {
  const diff = ctx.vm.demo.diff;
  if (!diff) return frame(ctx, io, { title: C2.DEMO_DIFF_LABEL, back: true, body: [para(C2.DEMO_EMPTY, 'sh-note')] });
  const hunks = (diff.hunks ?? []).map(h => el('div', { class: 'sh-hunk' },
    el('p', { class: 'sh-hunk-head', text: h.header }),
    el('ol', { class: 'sh-diff' }, (h.lines ?? []).map(line => el('li', { class: `sh-diff-${line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'ctx'}` },
      el('span', { class: 'sh-diff-mark', 'aria-hidden': 'true', text: line.t === ' ' ? ' ' : line.t }),
      el('span', { text: line.s }))))));
  return frame(ctx, io, {
    title: C2.DEMO_DIFF_LABEL,
    back: true,
    body: [
      el('p', { class: 'sh-note', text: `${diff.file} · +${diff.added} −${diff.removed}` }),
      hunks,
    ],
  });
}

function demoArtifact(ctx, io) {
  const list = ctx.vm.demo.artifacts;
  return frame(ctx, io, {
    title: C2.DEMO_ARTIFACT_LABEL,
    back: true,
    body: list.length
      ? list.map(a => el('figure', { class: 'sh-frame' },
        a.src ? el('img', { class: 'sh-picture', src: a.src, alt: a.caption || a.name, width: '360', height: '160' }) : null,
        el('figcaption', { class: 'sh-help', text: `${a.name}. ${a.caption}` })))
      : [para(C2.DEMO_EMPTY, 'sh-note')],
    lead: null,
  });
}

// The part 2 builders. (The 22 part 1 screens are in views.js.)
const PART2_BUILDERS = Object.freeze({
  'pair-review': pairReview,
  computers,
  'install-ios': installIos,
  'install-android': installAndroid,
  'lan-web': lanWeb,
  connected,
  rename,
  forget,
  settings,
  'settings-connection': settingsConnection,
  'settings-notify': settingsNotify,
  'settings-lock': settingsLock,
  'phone-lock-off': phoneLockOff,
  'settings-appearance': settingsAppearance,
  'settings-dictation': settingsDictation,
  debug,
  about,
  legal,
  'demo-home': demoHome,
  'demo-run': demoRun,
  'demo-diff': demoDiff,
  'demo-artifact': demoArtifact,
  'pin-set': pinSet,
});

export const PART2_SCREEN_BUILDERS = PART2_BUILDERS;

export function renderPart2(id, ctx, io) {
  const build = PART2_BUILDERS[id];
  if (!build) return null;
  return build({ ...ctx, id }, io);
}

export { mark };
