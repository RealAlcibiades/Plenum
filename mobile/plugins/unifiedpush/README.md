# plenum-unifiedpush (Android)

UnifiedPush for the Plenum Android app (MOBILE.json push.phase2_android; MOBILE-UI section 10). The person chooses a push
app such as ntfy; the connector (org.unifiedpush.android:connector 3.3.5, Apache-2.0) registers with it, and the desktop's
encrypted Web Push messages reach the phone through it.

- `UnifiedPush.getDistributors()`, `chooseDistributor({ packageName })`, `pickDistributor()`
- `UnifiedPush.register({ instance?, messageForDistributor?, vapid? })`, `unregister({ instance? })`
- `getState()`: distributor, endpoints (url and temporary only), failures, registrations, visible
- Events: `endpoint` (url, temporary, pubKeySet once), `message` (base64 content, decrypted), `registrationFailed`,
  `unregistered`, `tempUnavailable`
- `requestNotificationPermission()` (Android 13 and later; asked after a tap)

Closed-app notifications: when Plenum is not in front, `UnifiedPushService` shows the desktop's notification itself
(channels plenum-approvals, plenum-finished, plenum-limits; Deny, Stop all and an opt-in Approve with
setAuthenticationRequired). The shell must not show a second notification for a message that arrives in the background.

Keys: the endpoint's key set is handed to the shell once and never stored or logged by this plugin.
