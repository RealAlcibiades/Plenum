'use strict';
// The approval alerts of the desktop app: the notification and the tray text that say a card is waiting for Approve or Deny.
// These are plain functions with no Electron import, so they can be tested without starting the app (main.cjs uses them).
// Nothing here sees the command, the path or the diff. They only count the waiting approvals.

// Whether a notification should show. It shows only when the alert is on, the window is not focused, and the count went up.
// An answered card, or one that was already waiting, never shows it again.
function shouldAnnounce(prevCount, nextCount, focused, enabled) {
  return Boolean(enabled && !focused && nextCount > prevCount);
}

// The tray tooltip for a count of waiting approvals. A count of zero (or anything that is not a positive number) reads as plain "Plenum".
function tooltipFor(count) {
  if (!(count > 0)) return 'Plenum';
  return count === 1 ? 'Plenum: 1 approval waiting' : `Plenum: ${count} approvals waiting`;
}

module.exports = { shouldAnnounce, tooltipFor };
