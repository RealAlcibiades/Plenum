package com.realalcibiades.plenum.unifiedpush

import android.util.Base64
import com.getcapacitor.JSObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * Receives the distributor's events: the endpoint, messages, failures and unregistrations. Declared in the plugin's
 * manifest with the connector's PUSH_EVENT action and not exported. It runs only when a distributor delivers, so there
 * is no socket and no foreground service.
 *
 * A message reaches the shell as an event whenever the bridge is alive. When Plenum is not in front, the service also
 * shows the closed-app notification itself, so the shell must not add a second one for a message that arrives in the
 * background (the shell handles the event; it shows nothing for it).
 */
class UnifiedPushService : PushService() {

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        UnifiedPushStore.saveEndpoint(this, instance, endpoint.url, endpoint.temporary)
        val data = JSObject()
        data.put("instance", instance)
        data.put("url", endpoint.url)
        data.put("temporary", endpoint.temporary)
        endpoint.pubKeySet?.let { keys ->
            val pair = JSObject()
            pair.put("pubKey", keys.pubKey)
            pair.put("auth", keys.auth)
            data.put("pubKeySet", pair)
        }
        UnifiedPushPlugin.deliver("endpoint", data, retain = true)
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val data = JSObject()
        data.put("instance", instance)
        data.put("content", Base64.encodeToString(message.content, Base64.NO_WRAP))
        data.put("decrypted", message.decrypted)
        UnifiedPushPlugin.deliver("message", data, retain = true)
        if (message.decrypted && !UnifiedPushStore.visible) {
            PlenumNotifier.showFromPayload(this, message.content)
        }
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        UnifiedPushStore.saveFailure(this, instance, reason.name)
        val data = JSObject()
        data.put("instance", instance)
        data.put("reason", reason.name)
        UnifiedPushPlugin.deliver("registrationFailed", data, retain = true)
    }

    override fun onUnregistered(instance: String) {
        UnifiedPushStore.removeEndpoint(this, instance)
        val data = JSObject()
        data.put("instance", instance)
        UnifiedPushPlugin.deliver("unregistered", data, retain = true)
    }

    override fun onTempUnavailable(instance: String) {
        val data = JSObject()
        data.put("instance", instance)
        UnifiedPushPlugin.deliver("tempUnavailable", data, retain = false)
    }
}
