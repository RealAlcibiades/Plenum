// The parts of computer use that differ between Windows, macOS and Linux: the key that stops a run, and the sentences the Computer
// panel shows when the computer cannot be controlled yet. Every function takes the platform as a parameter that defaults to
// process.platform, so the tests can ask what a Mac or a Linux desktop would say. (The rest of the app never tests the platform.)
//
//  - stopAccelerator(platform, override) and stopKeyLabel(platform, accelerator) are the drive's (lib/drive.mjs): Ctrl+Alt+Escape by
//    default, Control+Option+Esc on a Mac, or a valid override saved as driveStopKey.
//  - permissionHelp(platform, probe) -> the sentences to show with a probe that says computer use is not ready (empty when nothing helps).
//  - supportNote(platform) -> one sentence about how far computer use is tested on this platform.
//  - hasPasswordGuard(platform) -> whether Plenum can tell a password field from the others there (true only on Windows). Where it is
//    false the start card, the computer-use notice and the system text say that the rule rests on the model (lib/computer/policy.mjs).
export { stopAccelerator, stopKeyLabel } from '../drive.mjs';
export { hasPasswordGuard } from '../computer/policy.mjs';

const MAC_HELP = 'Grant Screen Recording and Accessibility to Plenum in System Settings > Privacy & Security, then restart Plenum.';
const WAYLAND_HELP = 'Computer use on Linux needs an X11 session; under Wayland the screen cannot be captured and the keyboard and mouse cannot be driven. Log in with an X11 ("Xorg") session and restart Plenum.';
const XDOTOOL_HELP = 'Computer use on Linux needs xdotool. Install it with your package manager (for example: sudo apt install xdotool), then restart Plenum.';

export function permissionHelp(platform = process.platform, probe = null) {
  if (platform === 'darwin') {
    const p = probe?.permissions ?? {};
    // A probe that says both are granted needs no help; one that does not say gets the sentence.
    if (probe && probe.supported && p.screen === 'granted' && p.input === 'granted') return '';
    return MAC_HELP;
  }
  if (platform === 'linux') {
    if (probe?.wayland) return WAYLAND_HELP;
    if (probe && probe.tools && probe.tools.xdotool === null) return XDOTOOL_HELP;
    return '';
  }
  return '';
}

export function supportNote(platform = process.platform) {
  if (platform === 'win32') return 'Computer use is built and tested on Windows.';
  if (platform === 'darwin') return 'Computer use on macOS is written from Apple\'s documentation and has not been tested on a Mac yet.';
  return 'Computer use on Linux works on X11 with xdotool and has not been tested on a real desktop yet.';
}
