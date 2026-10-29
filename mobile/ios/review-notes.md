# Plenum for iPhone: review notes

Status: draft for the first TestFlight and App Store submission. Built from `mobile/ios/` (Capacitor 8.5.3, Swift Package Manager, no CocoaPods). Not yet built on a Mac; the simulator build and selftest run in `.github/workflows/mobile.yml` (ios-sim job).

Placeholders in square brackets are the owner's to fill: [LICENSOR NAME], [CONTACT EMAIL], [GOVERNING LAW], [PRIVACY NOTICE URL], [DEMO VIDEO URL]. Nothing here names a person or a company that the owner has not supplied.

## 1. Notes for App Review (paste into App Store Connect "Notes")

Plenum is a client for software the user runs on their own computer. The iPhone app pairs with the Plenum app on the person's Mac or Windows PC and shows and controls the AI coding agents running there. It is not a remote desktop, not a cloud service and not a thin client for a server that we run. All of the app's code and its interface are in the binary, as the release snapshot of the same version. Pages and files generated on the computer are shown as pictures; the app downloads and runs no code.

Demo mode needs no computer, account or network:

1. Open Plenum and tap "Try the demo".
2. The strip under the title says "Demo: nothing here reaches a computer." The replay shows runs, a waiting approval (Approve or Deny answers from the replay), a computer run with screenshots, a diff, and an artifact picture.
3. Tap Stop; it answers from the replay.
4. Tap "Exit demo" to return to the first screen.

A full pairing needs Plenum running on the person's computer. [DEMO VIDEO URL] shows pairing and a live run.

## 2. Permissions (each is asked only when its feature is used)

| Permission | Why | When it is asked |
| --- | --- | --- |
| Camera (NSCameraUsageDescription) | Scan the pairing code on the computer's screen | When the person taps Scan. Paste is the alternative. |
| Face ID (NSFaceIDUsageDescription) | Optional app lock. On by default on iPhone; can be turned off in Settings | After pairing, and before the app connects when locked. |
| Local network (NSLocalNetworkUsageDescription) | Reach the person's computer on the same Wi-Fi | Before the first local-network attempt. If refused, the app offers Tailscale or the person's own relay. |
| Microphone and speech (NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription) | Dictate a message into the message box | Only when the person taps the dictation button. Recognition runs on the device first. |

The app asks for no location, contacts, tracking or photo-library access (photos use the system picker). It declares no background modes and no push entitlement in this build.

## 3. Network, data and consent

- The app talks only to the person's own computer: over the local network (App Transport Security allows local networking only), through the person's own Tailscale (https to their own name), or through a relay the person deploys in their own Cloudflare account. The developer runs no server that the app contacts. There are no accounts, analytics or crash-reporting SDKs.
- Messages are encrypted end to end between the phone and the computer (X25519 key agreement and ChaCha20-Poly1305, implemented in the app with MIT-licensed libraries). The computer then sends them to the AI providers the person set up there.
- **5.1.2(i) consent** (shown before pairing; Allow and Not now; links to the Privacy Notice and Third-party services). Text as written in MOBILE.json (legal), for counsel to confirm (LEGAL.json question 5):

  > Messages you send from this app go to your computer. Plenum on your computer sends them, with files from your projects, to the AI providers you set up there, which may include Anthropic, OpenAI, Google, Meta (Muse Code), xAI, DeepSeek, Mistral AI and OpenRouter. Each provider handles them under its own privacy policy. Plenum's developer receives nothing.

- Pairing is confirmed on the computer by a person, with a six-digit code compared on both screens. A phone cannot pair itself.

## 4. Computer and browser control

- Controlling the computer's browser or screen from the phone is available only on the local network. The design reports that capability only when the connection is local (shell item in section 9; not yet wired).
- Stop is always one tap on every screen. It ends the run on the computer.
- Every action sent from a phone is labelled "via" the phone's name in the computer's activity list.

## 5. Export compliance

- `ITSAppUsesNonExemptEncryption` is `true`.
- Encryption: standard TLS from iOS; the phone link's own key agreement and AEAD cipher as in section 3.
- Counsel confirms the self-classification and the France declaration (LEGAL.json, export question). The answers are not yet filed. Do not answer "no" to the export question until counsel has signed off.

## 6. Privacy

- Privacy Notice: [PRIVACY NOTICE URL] (the GitHub Pages copy of `legal/PRIVACY.md`); the same link is in the app's Legal tab.
- App Privacy label: "Data Not Collected" while no developer service runs. Counsel confirms.
- What the phone keeps: device keys in the Keychain, the list of computers, cached interface files, notification settings. No transcripts. Uninstalling deletes the app's storage but not the pairing on the computer; remove a phone under Settings > Phones on the computer.
- App switcher: the system snapshot shows only the Plenum mark on the page background (`SceneDelegate.swift`, sceneWillResignActive), so no prompt, reply or file name is captured when the app is switched away from.
- The welcome line "Nothing goes through us." is true only while no developer service runs. With the phase 3b push forwarder it changes at build time.

## 7. Generated content and reports (1.2)

- Replies come from the AI models the person chose. Each reply has "Report this reply": a local report, a send-by-e-mail to [CONTACT EMAIL], or an issue link. Counsel checks that this meets the rule (LEGAL.json).

## 8. Build facts

- Bundle identifier `com.realalcibiades.plenum` (owner to confirm). Display name Plenum.
- iOS 16.0 deployment target; iPhone only (`TARGETED_DEVICE_FAMILY = 1`).
- Capacitor 8.5.3 with Swift Package Manager. `App/App.xcodeproj` is the project; there is no Podfile. Capacitor's SPM core is pinned exactly to 8.5.3.
- Plugins (all MIT), as listed in `mobile/package.json`: @capacitor/app 8.1.2, @capacitor/barcode-scanner 3.1.3, @capacitor/browser 8.0.5, @capacitor/filesystem 8.1.5, @capacitor/haptics 8.0.2, @capacitor/local-notifications 8.3.1, @capacitor/network 8.0.1, @capacitor/share 8.0.3, @capacitor/text-zoom 8.0.1, @aparajita/capacitor-biometric-auth 10.0.0, @aparajita/capacitor-secure-storage 8.0.1. Each ships a `Package.swift` (checked in `check/ios-project.test.mjs`).
- URL scheme `plenum` is registered only for the pairing link (`plenum://pair#...`).
- Launch screen and icons are generated from the Plenum icon (`public/icon.png`): an opaque 1024 px App Store icon and a transparent launch mark over the system background.

## 9. Open items

Owner and counsel:

- Fill the placeholders in brackets above; counsel answers LEGAL.json questions 1 to 8 (export, the 4.2.7 position for a client without a live mirror, Tailscale's non-commercial label, push and relay duties, the 5.1.2(i) wording, Play's AI-content rule, the standard EULA choice, the relay grant).
- Confirm the bundle identifier and the App Privacy label answers.
- The Face ID usage string (`NSFaceIDUsageDescription`) is builder wording, and so are the camera and local-network strings. They need copy approval.
- The app icon is a generated square from `public/icon.png` (a 512 px tile). A 1024 px master from the design source is better before the store listing.

Engineering:

- `NSExceptionDomains` lists `100.64.0.0/10` as the spec says. App Transport Security matches host names only, so this key has no effect; the Tailscale path uses https to the person's own name and needs no exception. Remove it if counsel and the owner agree.
- `@capacitor/push-notifications` is not in `mobile/package.json` (mob-13 owns that file). The iOS project carries no push plugin until it is added and `npx cap sync ios` runs. Push stays inactive until phase 3b either way.
- `mobile/plugins/dictation` (mob-13) must ship a `Package.swift` before it is listed in `mobile/package.json`; `check/ios-project.test.mjs` fails if it does not.
- The shell (`mobile/shell/app.js`, mob-10) reports `lan-control` for every native connection; it must report it only when the carrier is LAN, and the iOS build must refuse UI files from the computer (bundled UI only).
- The Privacy screen always applies on iOS. The Android-only "Hide content in the app switcher" setting has no iOS effect until the shell can pass it to native code.
- CI: `mobile.yml` must run `npm run build` and `npx cap sync ios` in `mobile/` before `xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`. Those two steps create `App/App/public`, `capacitor.config.json`, `config.xml`, and the SwiftPM package `App/CapApp-SPM` (`Package.swift`, `Sources/CapApp-SPM/CapApp-SPM.swift`, `README.md`, `.gitignore`). The SPM package is generated too and must be committed: `cap sync ios` picks SPM only when that folder exists, and the ios-sim job fails on a clean checkout without it. `mobile/.gitignore` does not ignore it (the earlier rule for `ios/App/CapApp-SPM/` is removed), and the package's own `.gitignore` keeps `.build`, `Packages`, `xcuserdata` and `DerivedData` out of git. The CapApp-SPM manifest lists the dictation plugin as `PlenumDictation` (the CLI name for `plenum-dictation`). The MOBILE.json ios-sim text (workspace, `pod install`) is out of date; mob-17 already uses the SPM project.
- Version numbers in the project (`MARKETING_VERSION` 1.0, build 1) are only the defaults. The release workflows set them on each archive: `MARKETING_VERSION` from package.json (without any -beta suffix) and `CURRENT_PROJECT_VERSION` from the workflow run number, both passed to `xcodebuild archive` (release.yml and mobile.yml, `ios-archive`).
