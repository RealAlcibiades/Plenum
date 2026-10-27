# Phone-size harness (mob-18)

Runs the desktop UI at phone size, and the pairing flow against the Bridge, in one hidden Electron window on this Windows machine.
Nothing shows on the owner's screen: the window is opacity 0, focusable false, skipTaskbar, shown with showInactive().

It runs only inside a sealed copy of the project (`build/mobile/src-<id>`, made by `build/mobile/run.mjs`). It refuses to start
anywhere else, and it refuses unless `MOBILE_SEALED=1`.

## Run it

    node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id mob-18-phone-size-harness regression.test.mjs

The regression takes about 10 s here. Screenshots go to `C:/t/mob/` (short paths; Windows path limits otherwise).
Read them back with the Read tool. Set `MOB18_TRACE=1` to append timed steps to `C:/t/mob/mob18-trace.log` when a run hangs.

## Files

| File | What it is |
|---|---|
| `phone-window.mjs` | The Node side: `startPhoneHarness()`, the window and the Bridge helpers. Import this. |
| `electron-main.cjs` | The Electron main process. Started only by `phone-window.mjs`, never by hand. |
| `preload.cjs` | Sets `data-surface="phone"` on the phone surface, and exposes `window.plenumShell` (`desktop: true`, `token()`) like the desktop preload. The token goes only to the server origin. |
| `capacitor-stub.js` | Injected before any page script: `window.Capacitor` with in-memory `SecureStorage`, a `BarcodeScanner` that returns `plenumHarness.scanLink`, recorded `PushNotifications.register`, `App` pause and resume (emit with `plenumHarness.emit('pause')`), and `Browser.open` recorded. |
| `fixture/` | A stand-in for the shell at `/p/<pathKey>/` until `mobile/www` holds the real shell. Screens: pairing, code, connected, offline, reconnecting, approval, stop-pressed. Plain text only, no inline script or style. |
| `../helpers/phone-checks.js` | The section 16.1 in-page helpers. `h.evalFile(path)` installs them; `plenumPhoneChecks.audit()` summarises. |
| `../regression.test.mjs` | The suite: phone surface, desktop surface, bridge fixture, cleanup. |

## The API (phone-window.mjs)

    const app = await makeAppCopy('my-suite');                // helpers/sealed-server.mjs: a private app folder (see "Own app folder" below)
    const h = await startPhoneHarness({ name: 'my-suite', appRoot: app, mock: true, projects: ['p1', 'p2'] });
                                                              // sealed server + hidden window; name only labels the temp folders;
                                                              // appRoot, mock and projects are optional (see below)
    await h.openApp({ view: PHONE_VIEW, surface: 'phone', theme: 'light' });   // the desktop UI from the sealed server
    await h.openApp({ view: DESKTOP_VIEW, surface: 'desktop' });              // same UI, no marker
    await h.openFixture(url, { theme: 'dark' });                              // any page; no token goes to it
    await h.eval('document.title');            // runs in the page; the result must be JSON-friendly
    await h.evalFile('/abs/path/to/script.js'); // classic script; must not return a value (ends with void 0)
    await h.shot('name');                      // C:/t/mob/name.png -> { path, bytes, width, height } in device pixels
    await h.theme('dark');                     // prefers-color-scheme for the window
    await h.tap(x, y);                         // one touch at CSS pixels (touch emulation is on for the phone view)
    await h.logs();                            // { errors, warnings, pageErrors } since the last open
    await h.panels();                          // every public/ext-*.js, which loaded, and /api/ext-modules agreement
    const b = await h.enableBridge();          // Bridge in loopback LAN mode; b.link, b.pageUrl, b.wsUrl, b.desktopPub, b.pathKey
    await h.openFixture(b.link);               // the fragment carries the pairing code; the page clears it from the address bar
    const p = await h.phonePair({ name });     // phone-sim IKpsk2 to the loopback socket; p.code, p.hello, p.session
    await h.confirmPairing();                  // the computer's Allow (POST /api/phones/pair/confirm), retried until the phone is ready
    await h.dismissSetup({ view, theme });     // marks the first-run "Set up Plenum" wizard finished for the server's origin (openApp does it)
    const r = await h.raiseApproval({ project: 'p1' });   // mock: true only. A model turn that asks to write a file; { approvals, turn }
    await h.restartServer();                   // stops the server process and starts it again on the same port, token and state folder
    await h.fixture('connected', { device, desktop, carrier });  // draw a fixture screen (text only)
    const left = await h.close();              // { leftover: [] } when no process of the run is still alive

Every window call has a time limit (30 to 60 s). A stalled debugger command is an error, not a hang.

## Options of startPhoneHarness

- `appRoot`: a private app folder from `makeAppCopy()` (helpers/sealed-server.mjs). The server runs from it, and the fixture or the built
  shell is served from its `mobile/www`. Without it the harness uses the sealed copy itself, which other suites share.
- `mock: true`: starts the Anthropic mock (`startMockModel()`) and runs the server's model against it. `h.mock.gate('name')` holds a
  request marked `HOLD:name`; a message with `WRITE` makes the model ask to write a file (an approval card in Ask first mode, once per
  thread: a thread that already has a tool result is answered with text, so a second card needs another project); `AGENT:name` makes it
  delegate to a researcher agent held on the same gate. `h.raiseApproval()` sends such a turn.
- `projects`: the project ids the server starts with (default `['p1']`; the project's name is its id).

## Running ui-phone.test.mjs by part and by viewport

Three environment variables, three jobs. Do not reuse one for another:

- `MOB11_PART=p1|p2|p3`: runs one part of ui-phone.test.mjs (part 1 phone surface, part 2 rest of the phone checks, part 3 stabilization). Unset runs all three.
- `MOB11_ONLY=360x780,390x844,...`: part 1's viewport loop only (360x780, 390x844, 412x915, 844x390). Unset runs all four. Part 1's
  non-viewport tests (P-21 and the rest) still run.
- `MOB11_P2_ONLY=...`: the same viewport filter for part 2.

Split a long run so each call ends within the 10-minute Bash limit:

    MOB11_PART=p1 MOB11_ONLY=360x780 node C:/Users/willi/AppData/Local/Temp/claude/mcshots/build/mobile/run.mjs --id g4 --timeout 540000 ui-phone.test.mjs

## Own app folder (M3)

The suites that build or serve the phone shell (shell-core, shell-screens, shell.e2e, regression, ui-phone) each make their own app folder,
run `scripts/build-mobile.mjs --root <folder>` in it, and pass it as `appRoot`. They used to write the same copy's `mobile/www` (the build
removes the folder first), so one suite's build could pull the page from under another's. The folder lives in `.apps` inside the sealed
copy, which the runner clears at the start of every run. `ensureFixture()` and `startPhoneHarness()` both refuse anything that is not the
sealed copy or such a folder.

## The first-run wizard (L9)

A fresh browser profile gets the "Set up Plenum" wizard (`public/ext-setup.js`, key `plenum-setup-dismissed` in localStorage) over every
screenshot, and `plenumPhoneChecks.audit()` would measure the wizard. `h.openApp()` and `openPhone()` in ui-phone.test.mjs call
`h.dismissSetup()` first: it loads a small static file of the server's origin (localStorage is per origin and the page's own scripts read
the key at load) and sets the key. Pass `setup: true` to `openApp()` to keep the wizard. Screenshots taken before this change show the
wizard; the ones written by the current suites do not.

## Things to know

- Sealed runs listen on 127.0.0.1 only. The server's pairing link names the Same-network address, which nothing listens on
  here; `enableBridge()` rebuilds the loopback page link from the same fragment and listener port. `phonePair()` dials the
  loopback socket for the same reason.
- `window.plenumShell` is the only shim the page gets in a page that does not load the shell's own boot.js. The UI reads no web storage on startup (the token comes through the
  preload), so nothing here relies on localStorage.
- Keys, the per-launch token and Noise private keys never go into argv, the environment, a file or a page. The command pipe
  name is random per run.
- The Electron process gets no environment from the Bridge and no stdin (stdin ends at once in the Electron main process).
- `close()` ends the phone sessions, asks Electron to exit, kills what is left of its process tree and stops the server.
  It returns the pids still alive. A run that ends early must still call `close()` (the regression does it in `after`).
- The fixture is copied into this copy's `mobile/www` only when there is no real shell there (no `index.html`, or the
  marker `mob18-fixture.txt` is present). A real shell is never overwritten.
- Desktop UI at phone size is not yet a phone layer: the harness measures panels and errors, not layout. `plenumPhoneChecks.audit()`
  reports small targets and horizontal overflow for the phone-layer builders; the regression does not fail on them.

## For later builders

- Add a suite under `mobile/test/` (or `mobile/test/harness/`) and call the API above. Do not add your own Electron process.
- Use `h.openApp` for the desktop UI and `h.enableBridge()` for pairing. Keep names short for the screenshot folder.
- When the real shell lands in `mobile/www`, the fixture steps out of the way automatically; update the fixture-driven
  assertions in `regression.test.mjs` to the shell's own screens and ids (`#plenum-stop`, `plenum-conn-strip`, `plenum-lock`).
- Never call `dialog.*`, never bind an address other than 127.0.0.1 or ::1, and never print a token or key from a test.
