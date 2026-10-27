# plenum-dictation (Android and iOS)

Dictation with the phone's own speech recognition first (MOBILE-UI 8.5.4 and 15.6). Replaces @capgo/capacitor-speech-recognition,
which is MPL-2.0 and outside ALLOWED_LICENCES.

- Android: `SpeechRecognizer.createOnDeviceSpeechRecognizer` (Android 12 and later). Server recognition only when `allowServer`
  is true (the "Allow that" switch in Phone settings).
- iOS: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. Package.swift at the plugin root for Swift Package Manager.
- Methods: `available()`, `requestPermission()`, `start({ locale?, allowServer?, silenceMs? })`, `stop()`, `cancel()`.
- Events: `partial`, `final`, `level` (0..1), `end` (reason), `error` (code, message). Text is never sent anywhere by this plugin.
- Permissions: RECORD_AUDIO on Android; the iOS usage strings (NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription)
  live in mobile/ios/App/App/Info.plist (mob-14).
