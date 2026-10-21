'use strict';
// The desktop alerts, driven by the server's state (the state hook): the finished alert when a run ends while the window is not
// focused, the approval alert when a card arrives while it is not focused, the tray count, and keep-awake while a run is going.
// The notifications name the project only; they never carry a prompt, a reply, a command or a path. Behaviour is the same as the
// alerts that desktop/main.cjs held before the handlers were split out (desktop/alerts.cjs holds the plain rules).
const { shouldAnnounce } = require('../alerts.cjs');

// The run being watched ({ projectId, name }) while the server reports it in progress.
let watchedRun = null;
// The notifications, kept in variables so one is not collected before a click on it can be handled.
let finishedNote = null;
let approvalNote = null;
// The number of approval cards the last state counted.
let lastWaiting = 0;
// The keep-awake blocker id. Only one blocker is held at a time.
let keepAwakeId = null;

// Holds the PC awake while a run is in progress. Only one blocker is held at a time.
function setKeepAwake(shell, on) {
  if (on && keepAwakeId === null) {
    keepAwakeId = shell.powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && keepAwakeId !== null) {
    shell.powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

// The finished alert: the project name and a short status only.
function notifyFinished(shell, name) {
  if (!shell.Notification.isSupported()) return;
  finishedNote = new shell.Notification({ title: 'Plenum finished', body: `${name || 'Project'}: run finished.` });
  finishedNote.on('click', () => shell.showWindow());
  finishedNote.show();
}

// Takes the state. A run is followed only while its project stays active: the server reports a run only for the active project.
// A card that has just arrived while the window is not focused raises the approval alert; the tray count follows every change.
function onState(shell, st) {
  const { finishedAlerts, keepAwake, approvalAlerts } = shell.settings();
  const win = shell.win();
  const active = (st.projects ?? []).find(p => p.id === st.activeProject);
  if (st.running && active) {
    watchedRun = { projectId: active.id, name: active.name };
  } else if (watchedRun && st.activeProject === watchedRun.projectId) {
    const ended = watchedRun;
    watchedRun = null;
    if (finishedAlerts && (!win || !win.isFocused())) notifyFinished(shell, ended.name);
  } else {
    // The user moved to another project, so the run in progress can no longer be followed.
    watchedRun = null;
  }
  // The approval alert is for a card that has just arrived while the window is not focused. The tray text follows the
  // count whether or not the alert shows, so it is right when the window comes back.
  const waiting = Number(st.approvalsWaiting) || 0;
  if (shouldAnnounce(lastWaiting, waiting, Boolean(win && win.isFocused()), approvalAlerts)) {
    if (shell.Notification.isSupported()) {
      approvalNote = new shell.Notification({ title: 'Plenum needs your approval', body: `${active?.name ?? 'Project'}: an action is waiting for Approve or Deny.` });
      approvalNote.on('click', () => shell.showWindow());
      approvalNote.show();
    }
  }
  if (waiting !== lastWaiting) shell.tray.count(waiting);
  lastWaiting = waiting;
  setKeepAwake(shell, keepAwake && st.running === true);
}

module.exports = {
  name: 'alerts',
  hooks: {
    state: onState,
    // Releases the keep-awake blocker when the app quits, so a quit never leaves the PC awake.
    beforeQuit: shell => setKeepAwake(shell, false),
  },
};
