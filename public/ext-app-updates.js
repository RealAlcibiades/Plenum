// ext-app-updates. Settings > Updates: the version this person runs, whether a newer one exists and what changed in it, Check now,
// Restart to update (or Get <version> and Release page on a build that cannot install itself), the check switch and the channel,
// a dot on the Settings link and on the menu button, and one toast per version. Adds itself through window.MuseUI (app.js).
// Layout and colour are in ext-app-updates.css; every colour is a shared token.
//
// The server (lib/routes/app-updates.mjs) and the desktop app (desktop/handlers/app-update.cjs) own the facts; this panel shows them.
//  - GET /api/app-updates -> { desktop, version, releasesUrl, settings, status }. Read at start and on 'hello' (a reconnect).
//  - Event 'app-update': the status as fields of the event (type, status, version, canInstall, ...). Each one redraws the status block.
//  - Event 'state': the run and approval state. It re-checks the Restart button and shows a toast that waited for the run to end.
//  - POST /api/app-updates/check (Check now), /install (Restart to update) and /settings (the switch, the channel and the markers).
// The markers, each once per version and kept on the server (never in browser storage, whose first read stalls start-up in Electron):
//  noticed (the first-check toast), toldVersion (the new-version toast), seenVersion (the dot on a build that cannot install itself),
//  toldUpdatedTo (the updated toast; the next render of this card then opens What changed).
// Text reaches the page through textContent only, and no key or token is read or shown here.
(function () {
  const MuseUI = window.MuseUI;
  // app.js defines MuseUI before the extra panels load. Without it, or without the Settings page, there is nothing to attach to.
  if (!MuseUI || !MuseUI.settings || typeof MuseUI.settings.register !== 'function') return;

  const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const NOTICE_ID = 'update-checks';
  const FIRST_TOAST_MS = 8000;
  const SAVED_MS = 2000;
  // Check now waits while a check or a download is going.
  const BUSY = ['checking', 'downloading'];
  // The line for a build that cannot install itself (the build names the desktop handler reports).
  const CANNOT_INSTALL = {
    portable: 'This portable build cannot install updates itself. Get the new version and replace the file.',
    zip: 'This zip build cannot install updates itself. Get the new version and replace the folder.',
    'mac-unsigned': 'This macOS build is not signed, so it cannot install updates itself. Get the new version and move it to Applications.',
    deb: 'This deb build cannot install updates itself. Get the new .deb and install it.',
  };
  const SWITCH_TEXT = "Plenum asks GitHub at start and every four hours. GitHub sees your IP address, Plenum version, system and a random rollout ID. Nothing about you goes to Plenum's developer.";
  const CHANNEL_NOTE = 'Beta gets pre-release versions first. Switching back to Stable keeps this version until a newer stable release ships.';
  const FOOT = 'Changes a model proposes to Plenum are in the Updates panel (/updates).';
  const RESTART_NOTE = 'It also installs when you quit Plenum.';
  const LOST = 'The message you have not sent will be lost.';
  const RUN_WAIT = 'A run is in progress. You can restart when it ends.';
  const APPROVAL_WAIT = 'An approval card is waiting. Answer it, then restart.';

  // ---------- small helpers (text only, no markup from the server) ----------

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (className, label, onClick) => {
    const b = make('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isVersion = v => typeof v === 'string' && SEMVER.test(v);
  const isHttps = u => typeof u === 'string' && /^https:\/\//.test(u);

  // '14 Oct 2026', or '14 Oct 2026, 10:12 AM' with the time. A value that is not a time gives ''.
  function dateOf(ms, withTime) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const day = `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    return withTime ? `${day}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : day;
  }

  // ---------- state kept by this panel ----------

  let data = null;            // the last GET answer, or null before the first one
  let status = null;          // the latest status: the event's fields, or the status in the GET answer
  let settings = null;        // the server's switches and markers, kept in step with each save
  let loading = false;
  let loadError = '';
  let refs = null;            // the card's parts, built once and put back on each render
  let openNotesNext = false;  // the next render opens What changed (set by the updated toast)
  let checkBusy = false;
  let checkError = '';
  let restartBusy = false;
  let restarting = false;     // the server accepted Restart to update
  let restartError = '';
  let confirmLost = false;    // the first click found an unsent message in the composer
  let noticeDrawn = false;
  let firstToastShown = false;
  let linkTitle = null;       // the Settings link's own title, put back when the dot goes
  let linkSr = null;          // the .sr text added to the Settings link while the dot shows
  const saveTimers = new Map();

  // The version running now: the status says it (current), else the GET answer does.
  const runningVersion = () => status?.current ?? data?.version ?? '';

  // The release page for the offered version, or the releases page; null when neither is a https link.
  function releaseHref() {
    const url = status?.downloadUrl ?? data?.releasesUrl ?? null;
    return isHttps(url) ? url : null;
  }

  function openLink(url) {
    if (isHttps(url)) window.open(url);
  }

  // The sentence, the muted detail and the one action of each status (UI-ARCH section 7 states, and the spec's wording).
  function describe(st) {
    const v = st.version;
    const when = st.checkedAt;
    switch (st.status) {
      case 'unavailable':
        return { sentence: st.message || 'Update checks are not available in this build.' };
      case 'off':
        return { sentence: 'Update checks are off.', detail: 'New versions are listed on the release page.', action: 'release' };
      case 'checking':
        return { spinner: true, sentence: 'Checking for a new version…' };
      case 'none':
        return { sentence: 'Up to date.', detail: when ? `Checked ${dateOf(when, true)}` : '' };
      case 'available': {
        if (st.skipped === true) {
          const day = dateOf(st.failedStart?.at, false);
          return {
            sentence: `Plenum ${v} is not offered again: it did not start on this computer${day ? ` on ${day}` : ''}.`,
            detail: 'A newer version is offered as soon as it is published.',
            action: 'release',
          };
        }
        if (st.canInstall === false) return { sentence: `Plenum ${v} is available.`, action: 'get', quiet: 'Opens the release page in your browser.' };
        return { sentence: `Plenum ${v} is available. It downloads in the background.` };
      }
      case 'downloading':
        return { sentence: `Downloading Plenum ${v} in the background.`, meter: true };
      case 'downloaded':
        return { sentence: `Plenum ${v} is ready to install.`, action: 'restart', quiet: RESTART_NOTE };
      case 'error': {
        const parts = [st.message, when ? dateOf(when, true) : ''].filter(Boolean);
        return { sentence: 'The last check did not finish. Plenum tries again later.', detail: parts.join(' · ') };
      }
      default:
        return { sentence: 'Not checked yet.' };
    }
  }

  // The notes to show: the offered version's while one is known, else the running version's (kept as installed). Null when none.
  function notesPick() {
    if (!status) return null;
    if (isVersion(status.version) && status.notes) return { version: status.version, text: status.notes };
    if (status.installed && status.installed.notes) return { version: status.installed.version, text: status.installed.notes };
    return null;
  }

  // ---------- the card ----------

  function build() {
    const root = make('div', 'au-root');

    const versionRow = make('div', 'au-version');
    const name = make('div', 'au-name');
    const nameMain = make('span', 'au-name-main', 'Plenum');
    const channelTag = make('span', 'au-channel');
    name.append(nameMain, channelTag);
    const check = button('ghost small au-check', 'Check now', () => checkNow());
    versionRow.append(name, check);
    const checkMsg = make('p', 'au-check-msg');
    checkMsg.hidden = true;
    root.append(versionRow, checkMsg);

    // The status block: the sentence, its detail, the one action with its quiet line, the download bar and What changed.
    const sentenceLine = make('div', 'au-sentence-line');
    const spinner = make('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    const sentence = make('span', 'au-sentence');
    sentence.setAttribute('aria-live', 'polite');
    sentenceLine.append(spinner, sentence);
    const detail = make('div', 'au-detail');
    const actions = make('div', 'actions au-actions');
    const restart = button('primary small', 'Restart to update', () => restartNow());
    const get = button('primary small', 'Get', () => openLink(releaseHref()));
    const release = button('ghost small', 'Release page', () => openLink(releaseHref()));
    const retry = button('ghost small', 'Try again', () => load());
    actions.append(restart, get, release, retry);
    const quiet = make('p', 'au-quiet');
    const statusBlock = make('div', 'au-status');
    statusBlock.append(sentenceLine, detail, actions, quiet);
    root.append(statusBlock);

    const meter = make('div', 'meter au-meter');
    const progress = make('progress');
    progress.max = 100;
    progress.setAttribute('aria-label', 'Download progress');
    meter.append(progress);
    root.append(meter);

    const notes = make('details', 'au-notes');
    const notesSummary = make('summary', null, 'What changed');
    const notesBody = make('div', 'au-notes-body');
    const installed = make('div', 'au-installed');
    const installedText = make('span', 'au-installed-text');
    const installedRelease = button('ghost small', 'Release page', () => openLink(releaseHref()));
    installed.append(installedText, installedRelease);
    notes.append(notesSummary, notesBody, installed);
    root.append(notes);

    const buildLine = make('p', 'au-build');
    buildLine.hidden = true;
    root.append(buildLine);

    root.append(make('div', 'au-rule'));

    // The check switch, as ext-projects.js builds its switch rows.
    const switchRow = make('label', 'switch-row');
    const switchInput = make('input');
    switchInput.type = 'checkbox';
    const track = make('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    const switchText = make('span');
    switchText.append('Check for new versions', make('small', null, SWITCH_TEXT));
    switchRow.append(switchInput, track, switchText);
    const switchSave = make('span', 'au-save');
    switchSave.setAttribute('role', 'status');
    root.append(switchRow, switchSave);

    // The channel field.
    const field = make('div', 'field');
    const channelLabel = make('label', 'field-label', 'Channel');
    channelLabel.htmlFor = 'au-channel';
    const channelSel = make('select');
    channelSel.id = 'au-channel';
    const stable = make('option', null, 'Stable');
    stable.value = 'stable';
    const beta = make('option', null, 'Beta');
    beta.value = 'beta';
    channelSel.append(stable, beta);
    const channelNote = make('span', 'field-note', CHANNEL_NOTE);
    const channelSave = make('span', 'au-save');
    channelSave.setAttribute('role', 'status');
    field.append(channelLabel, channelSel, channelNote, channelSave);
    root.append(field);

    root.append(make('p', 'au-foot', FOOT));

    refs = {
      root, versionRow, name: nameMain, channelTag, check, checkMsg, spinner, sentence, detail, actions, restart, get, release, retry,
      quiet, meter, progress, notes, notesSummary, notesBody, installed, installedText, installedRelease, build: buildLine,
      switchInput, switchSave, channelSel, channelSave,
    };

    switchInput.addEventListener('change', () => {
      const want = switchInput.checked;
      changeSetting({ check: want }, refs.switchSave, () => { switchInput.checked = !want; });
    });
    channelSel.addEventListener('change', () => {
      const want = channelSel.value === 'beta' ? 'beta' : 'stable';
      const before = settings?.channel === 'beta' ? 'beta' : 'stable';
      changeSetting({ channel: want }, refs.channelSave, () => { channelSel.value = before; });
    });
  }

  // Draws the status block, the version line and the controls' enabled state from the latest data. Only the text and the state of
  // existing elements change, so a focused control keeps its focus and What changed keeps its open state.
  function redraw() {
    if (!refs) return;
    const r = refs;
    const desktop = data?.desktop === true;
    const st = status ?? {};
    const s = st.status ?? '';

    r.name.textContent = data?.version ? `Plenum ${data.version}` : 'Plenum';
    r.channelTag.textContent = settings ? (settings.channel === 'beta' ? ' · Beta' : ' · Stable') : '';

    r.check.hidden = !desktop || !status || s === 'off' || s === 'unavailable';
    r.check.disabled = checkBusy || BUSY.includes(s);
    r.checkMsg.textContent = checkError;
    r.checkMsg.hidden = !checkError;

    r.switchInput.disabled = !desktop || !settings;
    r.channelSel.disabled = !desktop || !settings;

    const view = !data
      ? (loadError
        ? { sentence: `The update status could not be read: ${loadError}`, retry: true }
        : { spinner: true, sentence: 'Reading the update status…' })
      : describe(st);
    const running = MuseUI.state?.running === true;
    const waiting = (MuseUI.state?.approvalsWaiting ?? 0) > 0;
    const action = restarting ? 'restart' : (view.action ?? null);

    r.spinner.hidden = !view.spinner;
    r.sentence.textContent = restarting ? 'Restarting Plenum…' : view.sentence;
    r.detail.textContent = view.detail ?? '';
    r.detail.hidden = !view.detail;

    r.restart.hidden = action !== 'restart';
    r.restart.disabled = restarting || restartBusy || running || waiting;
    r.restart.textContent = confirmLost && !restarting ? 'Restart anyway' : 'Restart to update';
    r.get.hidden = action !== 'get';
    if (action === 'get') r.get.textContent = `Get ${st.version}`;
    r.release.hidden = action !== 'release' || !releaseHref();
    r.retry.hidden = !view.retry;
    r.actions.hidden = r.restart.hidden && r.get.hidden && r.release.hidden && r.retry.hidden;

    let quiet = view.quiet ?? '';
    let plain = false;
    if (action === 'restart' && !restarting) {
      if (running) quiet = RUN_WAIT;
      else if (waiting) quiet = APPROVAL_WAIT;
      else if (restartError) {
        quiet = restartError;
        plain = true;
      } else if (confirmLost) quiet = LOST;
      else quiet = RESTART_NOTE;
    }
    if (restarting) quiet = '';
    r.quiet.textContent = quiet;
    r.quiet.hidden = !quiet;
    r.quiet.classList.toggle('au-plain', plain);

    r.meter.hidden = !view.meter;
    if (view.meter) r.progress.value = Number.isFinite(st.percent) ? st.percent : 0;

    const pick = notesPick();
    r.notes.hidden = !pick;
    if (pick) {
      r.notesSummary.textContent = `What changed in ${pick.version}`;
      r.notesBody.textContent = pick.text;
      const inst = st.installed;
      const showInstalled = Boolean(inst && inst.version === pick.version);
      r.installed.hidden = !showInstalled;
      if (showInstalled) r.installedText.textContent = `Updated from ${inst.from} on ${dateOf(inst.at, false)}.`;
      r.installedRelease.hidden = !showInstalled || !releaseHref();
    }

    const cannot = desktop && st.canInstall === false && Object.hasOwn(CANNOT_INSTALL, st.build) ? CANNOT_INSTALL[st.build] : '';
    r.build.textContent = cannot;
    r.build.hidden = !cannot;

    if (!noticeDrawn && desktop && typeof MuseUI.notice === 'function') {
      // The strip draws once per launch (ext-notices.js); until the registry is there, a later redraw asks again.
      noticeDrawn = MuseUI.notice(NOTICE_ID, { before: r.versionRow }) === true;
    }
  }

  // The card is on screen: it is in the page and has a box (the Settings page is open and shows this section).
  function cardOnScreen() {
    return Boolean(refs && refs.root.isConnected && refs.root.getClientRects().length > 0);
  }

  // Puts the card into the section body, draws it, and marks the version as seen when a build that cannot install itself offers one.
  function render(body) {
    if (!refs) build();
    body.append(refs.root);
    if (openNotesNext) {
      refs.notes.open = true;
      openNotesNext = false;
    }
    syncControls();
    redraw();
    markSeenIfOffered();
    signals();
  }

  // ---------- data ----------

  // Reads the status, the settings and the release page. The first read shows the spinner; a failed read shows the message and Try again.
  async function load() {
    if (loading) return;
    loading = true;
    loadError = '';
    redraw();
    try {
      const got = await MuseUI.api('/api/app-updates');
      data = got;
      settings = isObj(got.settings) ? { ...got.settings } : { check: true, channel: 'stable', noticed: false };
      status = isObj(got.status) ? got.status : { status: 'idle' };
      syncControls();
    } catch (err) {
      loadError = err?.message || 'Unknown error';
    } finally {
      loading = false;
    }
    redraw();
    signals();
  }

  // Puts the switch and the channel back to the saved values (after a load, and after a save has been answered).
  function syncControls() {
    if (!refs || !settings) return;
    refs.switchInput.checked = settings.check !== false;
    refs.channelSel.value = settings.channel === 'beta' ? 'beta' : 'stable';
  }

  function applyStatus(next) {
    if (!isObj(next) || typeof next.status !== 'string') return;
    status = next;
    redraw();
    signals();
  }

  // Saves one switch or channel. 'Saved' shows on the row only after the server answers; a refusal puts the control back and shows
  // the server's message on the row in red until the next change. No toast.
  function changeSetting(patch, save, undo) {
    clearTimeout(saveTimers.get(save));
    saveTimers.delete(save);
    save.textContent = '';
    save.classList.remove('au-bad');
    MuseUI.api('/api/app-updates/settings', patch).then(() => {
      settings = { ...settings, ...patch };
      save.textContent = 'Saved';
      saveTimers.set(save, setTimeout(() => {
        save.textContent = '';
        saveTimers.delete(save);
      }, SAVED_MS));
      redraw();
    }).catch(err => {
      undo();
      save.textContent = err?.message || 'The change was not saved.';
      save.classList.add('au-bad');
    });
  }

  // A once-only marker: the value is set here at once (so nothing shows twice in this page session), and the server keeps it.
  // A failed save is not shown: the marker is then remembered for this session only.
  function tell(key, value) {
    if (!settings) return;
    settings[key] = value;
    MuseUI.api('/api/app-updates/settings', { [key]: value }).catch(() => {});
  }

  function markSeenIfOffered() {
    if (!data || !settings || !status) return;
    const offered = status.status === 'available' && status.canInstall === false && status.skipped !== true && isVersion(status.version);
    if (offered && settings.seenVersion !== status.version) tell('seenVersion', status.version);
  }

  // ---------- actions ----------

  async function checkNow() {
    if (checkBusy) return;
    checkBusy = true;
    checkError = '';
    redraw();
    try {
      const got = await MuseUI.api('/api/app-updates/check', {});
      if (isObj(got.status) && typeof got.status.status === 'string') status = got.status;
    } catch (err) {
      checkError = err?.message || 'The check did not start.';
    } finally {
      checkBusy = false;
    }
    redraw();
    signals();
  }

  // Restart to update. With an unsent message in the composer, the first click only warns; the second restarts. The server refuses
  // while a run goes or an approval waits, and its message is shown in the line under the button.
  async function restartNow() {
    if (restartBusy || restarting) return;
    const composer = MuseUI.el?.input;
    const typed = Boolean(composer && typeof composer.value === 'string' && composer.value.trim());
    if (typed && !confirmLost) {
      confirmLost = true;
      restartError = '';
      redraw();
      return;
    }
    restartBusy = true;
    restartError = '';
    redraw();
    try {
      await MuseUI.api('/api/app-updates/install', {});
      restarting = true;
      confirmLost = false;
      MuseUI.toast('Restarting Plenum to update…', 'ok');
    } catch (err) {
      restartError = err?.message || 'Plenum could not restart.';
      confirmLost = false;
    } finally {
      restartBusy = false;
      redraw();
    }
  }

  // ---------- signals: the dot, the Settings link, and the toasts (each at most once per version) ----------

  // The Settings link gets the title and a .sr note while the dot shows; both go when it does not.
  function setLinkDot(on, st) {
    document.body.classList.toggle('au-has-update', on);
    const link = MuseUI.el?.settingsBtn ?? document.getElementById('settingsBtn');
    if (!link) return;
    if (linkTitle === null) linkTitle = link.title;
    if (on) {
      link.title = st.status === 'downloaded' ? `Plenum ${st.version} is ready to install` : `Plenum ${st.version} is available`;
      if (!linkSr) {
        linkSr = make('span', 'sr', ' (new version)');
        link.append(linkSr);
      }
    } else {
      link.title = linkTitle;
      linkSr?.remove();
      linkSr = null;
    }
  }

  function signals() {
    if (!data || !status || !settings) return;
    const st = status;
    const running = runningVersion();
    const offered = st.status === 'available' && st.canInstall === false && st.skipped !== true;
    const readyToShow = st.status === 'downloaded' || offered;

    if (offered && cardOnScreen()) markSeenIfOffered();
    // The dot: a downloaded update keeps it until it installs; a build that cannot install itself keeps it until the card is opened.
    const dot = st.status === 'downloaded' || (offered && isVersion(st.version) && settings.seenVersion !== st.version);
    setLinkDot(dot, st);

    // (a) The new-version toast. The card on screen already says it, so the toast is skipped there. It waits while a run goes; the
    // next state event that finds the page idle comes back here.
    if (readyToShow && isVersion(st.version) && settings.toldVersion !== st.version) {
      if (cardOnScreen()) {
        tell('toldVersion', st.version);
      } else if (MuseUI.state?.running !== true) {
        MuseUI.toast(
          st.status === 'downloaded'
            ? `Plenum ${st.version} is ready. It installs when you quit, or now from Settings › Updates.`
            : `Plenum ${st.version} is available. Get it from Settings › Updates.`,
          'ok',
        );
        tell('toldVersion', st.version);
      }
    }

    // (b) The updated toast, once per installed version. The next render of the card opens What changed.
    const inst = st.installed;
    if (inst && isVersion(inst.version) && inst.version === running && settings.toldUpdatedTo !== inst.version) {
      MuseUI.toast(`Updated to Plenum ${inst.version}. See what changed in Settings › Updates.`, 'ok');
      openNotesNext = true;
      tell('toldUpdatedTo', inst.version);
    }

    // (c) The first-check toast: eight seconds, then the marker is kept so it never shows again.
    if (st.firstCheck === true && settings.noticed !== true && !firstToastShown) {
      firstToastShown = true;
      MuseUI.toast('Plenum checks GitHub for new versions. Turn this off in Settings › Updates.', 'ok', FIRST_TOAST_MS);
      setTimeout(() => tell('noticed', true), FIRST_TOAST_MS);
    }
  }

  // ---------- start ----------

  (async function start() {
    await (MuseUI.ready ?? Promise.resolve());
    MuseUI.settings.register({ id: 'updates', scope: 'app', title: 'Updates', order: 60, render });
    MuseUI.events.on('app-update', ev => {
      if (!isObj(ev)) return;
      const { type, ...rest } = ev;
      void type;
      applyStatus(rest);
    });
    // A reconnect after a restart reads the status again.
    MuseUI.events.on('hello', () => { load(); });
    // Run and approval state: the Restart button re-checks, and a toast that waited for the run to end may show now.
    MuseUI.events.on('state', () => {
      redraw();
      signals();
    });
    load();
  })();
})();
