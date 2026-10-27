# Plenum on your phone

The phone apps (Android and iPhone) are a window onto Plenum running on your computer. Your computer does the work, keeps the
keys to its providers and runs every model, computer-use action and approval. The phone talks to it over an encrypted channel
that only the two devices can read. Plenum runs no cloud service for this: the only servers involved are the ones you choose
(your own computer, Tailscale on your own account, or a relay you deploy yourself).

This folder holds the phone shell (`mobile/shell/`), the Capacitor projects for Android (`mobile/android/`) and iPhone
(`mobile/ios/`), and the tests (`mobile/test/`). `scripts/build-mobile.mjs` builds the shell into `mobile/www/` and
`relay/public/`. None of the generated folders is committed.

Contents:

1. Install paths
2. Ways to reach your computer (carriers)
3. Pairing and the desktop side
4. The owner's device checklist
5. Debugging without a Mac
6. Building and testing
7. What the CI workflow does

## 1. Install paths

| Phone | Now (phase 1) | Next |
|---|---|---|
| iPhone | Over Tailscale or your relay (the page must be https), open the Plenum page in Safari, tap Share, then Add to Home Screen. Open Plenum from the Home Screen and pair there. Notifications need the Home Screen app. | An iPhone app on TestFlight first (phase 3), then the App Store. It needs the Apple Developer Program enrolment, and the owner runs the first TestFlight build on their own phone. |
| Android | Over Tailscale or your relay (https), Chrome offers Install. Pair from the installed app. | An APK attached to the GitHub release of each tag (phase 2), signed with the upload key kept in the repository secrets. Google's developer verification for sideloaded apps applies; until the developer account is verified, Android may show a warning or make you wait before the install (MOBILE.json distribution.phase2). |
| Either | The LAN page (`http://<computer address>:<port>/p/<key>`) works in any phone browser with no install. It cannot send notifications or use the camera, and it says so at the top of the screen. | The Capacitor apps (phase 2 Android, phase 3 iPhone). No store listing exists yet, and no job publishes to a store or submits for review. |

There is no store listing, no review submission and no TestFlight upload unless you start one yourself (see section 7 for the
manual input of the CI workflow).

## 2. Ways to reach your computer (carriers)

Turn these on in Settings > Phones on the computer. Each one is off until you switch it on.

- **Same network (A).** No accounts. Turn on "Allow phones on this network". The phone talks to the computer's address on your
  Wi-Fi. Windows asks for firewall permission the first time Plenum listens. Allow it on the network profile your Wi-Fi uses
  (Private for a home network); the phone cannot reach the computer until you do. Guest Wi-Fi and networks with client isolation block this carrier, and
  Plenum then says so and offers the others. On iPhone the first LAN attempt shows the Local Network permission; if you refuse
  it, turn it on in Settings > Privacy & Security > Local Network.
- **Tailscale (B).** Install Tailscale on the computer and on the phone, using your own account (the free Personal plan is for
  non-commercial use). Plenum asks before it runs your Tailscale command to publish the computer at
  `https://<computer>.<tailnet>.ts.net`. The phone gets a real certificate, so the PWA can install and use Web Push. Tailscale
  puts the machine name in public certificate logs, and phones allow one VPN at a time. Plenum never bundles Tailscale.
- **Your relay (C).** The folder `relay/` is a Cloudflare Worker you deploy into your own free Cloudflare account. Settings >
  Phones > Relay opens the Deploy button, then you paste the Worker URL. The relay forwards encrypted frames only. It sees IP
  addresses, timing, message sizes and counts, the room id and a hash of the computer's secret, and the shell files it serves.
  It never sees message content. Its limits: 8 phones per room, 200 messages a second per connection, 2 MB a second per room,
  nothing buffered while the computer is offline, and a room idle for 30 days is deleted. Workers logs are off in
  `relay/wrangler.jsonc`. The project runs no production relay.

## 3. Pairing and the desktop side

- Pairing is done at the computer. Settings > Phones > Add phone opens a pairing window that screen capture cannot see. It shows
  a code and a QR. Scan the QR on the phone (or paste the link), then compare the six digits on both screens and press Allow on
  the computer. A model, a script or a phone cannot press Allow.
- Each phone has a tier, set at the computer in Settings > Phones. Full does everything the desktop UI does, including chat,
  computer use and settings. Approve watches the work, answers approvals, and pauses or stops runs, but starts no new work.
  Read only watches and can press Stop. Nothing else. Changing a tier is always done at the computer.
- While any phone is connected, a status chip "Phone connected: <name>" stays in the title bar. No setting hides it. The first
  connection of each launch also sends a notification, and every action a phone takes is labelled "via <phone>".
- Stop is on the phone's screen at all times, in every tier. On the computer, Stop is on the bar and Ctrl+Alt+Esc stops every
  run. A Stop sent from the phone goes ahead of queued requests, and it is retried for 60 seconds if the computer is away.
- Forget a phone with Remove on its row. Remove all makes a new key for the computer and disconnects every phone.

## 4. The owner's device checklist

Only the owner can run these, on the owner's own devices. Builders have no phone, and the simulator and emulator cannot show
the items marked (device). Settings > Phones > Test this phone prints the on-device checks as well.

Phone checks (phase 1, PWA and app):

- [ ] iPhone, PWA: install from Safari over Tailscale. Tap once, grant Web Push, pair with the QR and compare the six digits.
- [ ] iPhone: an approval push arrives with the app closed (device).
- [ ] iPhone: repeat on an EU-region iPhone if you can borrow one (device).
- [ ] Android, PWA: Chrome install, pair, and Web Push after a tap (device).
- [ ] Android: the GitHub APK install flow, from the release page, with the install-unknown-apps setting for the app you open the APK with (device).
- [ ] LAN: the app reaches the computer over ws:// on your Wi-Fi, with and without the Local Network permission (device).
- [ ] Android: UnifiedPush through the ntfy app, when that connector is built (device).
- [ ] Windows: the firewall prompt appears on the Private and Public profiles, and the pairing window is missing from a
      computer-use screenshot.
- [ ] Settings > Phones > Test this phone: copy the on-device report and note which fallback, if any, is needed.

Shell and app checks (native, after the Capacitor shells exist):

- [ ] `window.isSecureContext` inside `capacitor://localhost`.
- [ ] ws:// to a LAN address with and without NSAllowsLocalNetworking. Whether the Local Network prompt appears (device).
- [ ] Mixed content on Android (device).
- [ ] iOS web push actions: none expected.
- [ ] Dynamic Type on the iOS app at the accessibility sizes (device).
- [ ] HEIC to JPEG when a photo is picked (device).
- [ ] The Local Network pre-prompt card on iOS (device).
- [ ] The iOS 26 keyboard measurement.
- [ ] Android predictive back with target SDK 36: the back gesture still reaches the app (the backButton listener fires, or
      enableOnBackInvokedCallback is set as needed).
- [ ] Privacy-screen snapshots: the app switcher shows the hidden screen when the setting is on.
- [ ] Face ID and fingerprint on hardware (device). The simulator has no Keychain biometrics.
- [ ] Real camera scanning of the QR (device).

Not covered by any test here: real APNs, FCM and UnifiedPush delivery, the iOS Local Network prompt (absent in the simulator),
Android 17's local-network permission, EU-region Web Push, the Windows firewall prompt and capture exclusion on macOS
ScreenCaptureKit. Each of these is on the checklist above.

## 5. Debugging without a Mac

A Mac is needed for Safari's Web Inspector and for Xcode's device logs. Without one, use these:

- **The phone's debug console.** Settings on the phone > Help > Debug console keeps the last 500 lines in memory. "Send to
  computer" posts up to 100 of them to the computer, where the Phones panel shows them. Every line is redacted first: tokens,
  keys, pre-shared keys and nonces never reach the screen, the log or the computer.
- **The self-test.** The shell's self-test (the `?selftest` page mode) runs five steps the same way a person would: connect, UI
  pull, chat echo, approval, stop. It writes one JSON report to the debug console and sends that line to the computer. A step
  that cannot run is reported as failed with its reason.
- **Android, from Windows.** Install Android platform-tools and run `adb logcat`. In Chrome on the computer, open
  `chrome://inspect` to inspect the installed PWA or the app's WebView when the app is a debug build.
- **CI screenshots.** The `Mobile` workflow uploads the screenshots and a pairing status file (`status.txt`, one status per
  line) from each run of the smoke jobs. The status file and the driver log never contain a pairing link or a key.
- **The computer's side.** The Phones panel's activity list shows what each phone asked for and with which carrier.
- **Relay.** The relay keeps no payload logs and its Workers logs are off. Diagnose a relay by its `/version.json` and by
  the connection state the Phones panel shows.

If something fails on the phone, send the debug console's last lines to the computer first, then describe the step that failed.

## 6. Building and testing

Developer commands, run from the repository root unless noted:

    npm ci                                  # the desktop app and the server
    npm ci --prefix mobile                  # the shell and Capacitor
    node scripts/build-mobile.mjs           # writes mobile/www and relay/public
    node scripts/build-mobile.mjs --check   # confirms they are complete
    node --test mobile/test/noise.test.mjs  # any one suite (the Electron ones need a display: regression and ui-remote)
    cd relay && npm test && npx wrangler deploy --dry-run

The Android project (after `npx cap sync android` in `mobile/`) builds with `./gradlew assembleDebug` in `mobile/android/`,
using JDK 21 and the Android SDK for API 36 with build-tools 36.0.0. A signed release needs the environment variables
ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Keep the keystore out of the
repository: it belongs in the Actions secrets, and a lost key means a new package name.

The iPhone project is built on a Mac with Xcode 26 and the Swift Package Manager (there is no CocoaPods step):

    xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build

Never commit signing material (`.p8`, `.p12`, `.mobileprovision`, `.cer`, keystores); `mobile/.gitignore` already refuses them.

## 7. What the CI workflow does

`.github/workflows/mobile.yml` runs on pushes to main, on pull requests, on tags `v*`, every Monday at 06:00 UTC, and on a
manual run.

- `test` (Ubuntu, no secrets): the node suites under the sealed environment (the two Electron suites are skipped), the shell
  build check, the relay suites and the relay dry-run deploy. It also writes the pairing tools the smoke jobs use.
- `android-debug` (Ubuntu, no secrets): builds `app-debug.apk` and uploads it. `android-emulator` then pairs the app on an
  API 36 emulator through a throwaway server on the runner. It is continue-on-error until the first green runs.
- `ios-sim` (macOS 26, no secrets): builds the App scheme for the simulator without signing, boots a simulator picked by name,
  installs the app and pairs it the same way. Build and install are required; the pairing step is continue-on-error at first.
- `android-release` (tags only): when the four Android secrets are set, builds and verifies a signed APK and AAB and attaches
  them to the draft release that `release.yml` creates for the tag. Without the secrets it prints "No Android signing secrets:
  unsigned debug build only" and attaches nothing signed.
- `apple-secrets` and `ios-archive`: with none of the six Apple secrets set, the archive job is skipped; with some but not all,
  it fails. With all six, a tag archives the app and attaches the IPA to the draft release. TestFlight upload happens only when
  you start a manual run with `upload_testflight` set to true. Nothing is submitted for review.

The secrets, by group (each group is all or none):

- Android: `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
- Apple (the `APPLE_API_*` names are shared with `release.yml`): `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
  `MATCH_PASSWORD`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_GIT_URL`

The pairing link in the smoke jobs is written to a file and is never printed. The pairing is allowed through the plain-node test
route, which the desktop app does not expose, and the six-digit comparison a person makes is skipped on the runner. The server,
its state folder and the runner are discarded when the job ends.

The simulator and emulator cannot show Local Network prompts, real push, Keychain biometrics or the camera. Those are on the
checklist in section 4.
