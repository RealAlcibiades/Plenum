package com.realalcibiades.plenum.unifiedpush

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.UnifiedPush
import java.lang.ref.WeakReference

/**
 * The shell's view of UnifiedPush: choose a distributor, register and unregister registration names, read the state
 * and receive events (endpoint, message, registrationFailed, unregistered, tempUnavailable). Events are sent from
 * UnifiedPushService and only while the bridge is alive; the state is kept in UnifiedPushStore for the next start.
 *
 * Methods take and return the shapes in mobile/plugins/unifiedpush/src/index.d.ts.
 */
@CapacitorPlugin(
    name = "UnifiedPush",
    permissions = [Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications")],
)
class UnifiedPushPlugin : Plugin() {

    override fun load() {
        live = WeakReference(this)
    }

    override fun handleOnStart() {
        UnifiedPushStore.visible = true
    }

    override fun handleOnStop() {
        UnifiedPushStore.visible = false
    }

    override fun handleOnDestroy() {
        if (live?.get() === this) live = null
    }

    /** Sends one event to the shell. Called on the UI thread. */
    fun emit(event: String, data: JSObject, retain: Boolean) {
        notifyListeners(event, data, retain)
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val ctx = context
        val out = JSObject()
        out.put("supported", true)
        out.put("distributor", UnifiedPush.getSavedDistributor(ctx) ?: JSONObject.NULL)
        out.put("endpoints", UnifiedPushStore.endpoints(ctx))
        out.put("failures", UnifiedPushStore.failures(ctx))
        out.put("registrations", JSONArray(UnifiedPushStore.registrations(ctx)))
        out.put("visible", UnifiedPushStore.visible)
        call.resolve(out)
    }

    @PluginMethod
    fun getDistributors(call: PluginCall) {
        val ctx = context
        val out = JSObject()
        out.put("distributors", JSONArray(UnifiedPush.getDistributors(ctx).filter { it != ctx.packageName }))
        out.put("saved", UnifiedPush.getSavedDistributor(ctx) ?: JSONObject.NULL)
        call.resolve(out)
    }

    @PluginMethod
    fun chooseDistributor(call: PluginCall) {
        val packageName = call.getString("packageName")
        if (packageName == null || !PACKAGE_PATTERN.matches(packageName) || packageName == context.packageName) {
            call.reject("Name the push app by its package name, for example io.heckel.ntfy.", "bad-package")
            return
        }
        UnifiedPush.saveDistributor(context, packageName)
        val out = JSObject()
        out.put("saved", packageName)
        call.resolve(out)
    }

    @PluginMethod
    fun pickDistributor(call: PluginCall) {
        val current = activity
        if (current == null) {
            call.reject("There is no screen to show the list of push apps.", "no-activity")
            return
        }
        UnifiedPush.tryPickDistributor(current) { ok ->
            val out = JSObject()
            out.put("ok", ok)
            call.resolve(out)
        }
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val ctx = context
        if (UnifiedPush.getSavedDistributor(ctx) == null) {
            call.reject("Install a push app such as ntfy, then choose it.", "no-distributor")
            return
        }
        val instance = call.getString("instance")?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTANCE
        if (!INSTANCE_PATTERN.matches(instance)) {
            call.reject("A registration name is 1 to 64 letters, digits, dots, dashes or underscores.", "bad-instance")
            return
        }
        val label = (call.getString("messageForDistributor") ?: "")
            .replace(CONTROL, " ").trim().take(120).ifEmpty { DEFAULT_LABEL }
        val vapid = call.getString("vapid")?.takeIf { it.isNotEmpty() }
        if (vapid != null && !VAPID_PATTERN.matches(vapid)) {
            call.reject("The VAPID key is the 87-character base64url public key.", "bad-vapid")
            return
        }
        try {
            UnifiedPush.register(ctx, instance, label, vapid)
        } catch (e: UnifiedPush.VapidNotValidException) {
            call.reject("The VAPID key is the 87-character base64url public key.", "bad-vapid")
            return
        }
        UnifiedPushStore.addRegistration(ctx, instance)
        call.resolve()
    }

    @PluginMethod
    fun unregister(call: PluginCall) {
        val ctx = context
        val instance = call.getString("instance")?.takeIf { it.isNotEmpty() } ?: DEFAULT_INSTANCE
        if (!INSTANCE_PATTERN.matches(instance)) {
            call.reject("A registration name is 1 to 64 letters, digits, dots, dashes or underscores.", "bad-instance")
            return
        }
        UnifiedPush.unregister(ctx, instance)
        UnifiedPushStore.removeRegistration(ctx, instance)
        UnifiedPushStore.removeEndpoint(ctx, instance)
        call.resolve()
    }

    @PluginMethod
    fun getNotificationPermission(call: PluginCall) {
        resolveGranted(call)
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (notificationsGranted()) {
            resolveGranted(call)
            return
        }
        requestPermissionForAlias(NOTIFICATIONS_ALIAS, call, "notificationPermissionCallback")
    }

    @PermissionCallback
    fun notificationPermissionCallback(call: PluginCall) {
        resolveGranted(call)
    }

    // Before Android 13 there is no runtime permission for notifications.
    private fun notificationsGranted(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            getPermissionState(NOTIFICATIONS_ALIAS) == PermissionState.GRANTED

    private fun resolveGranted(call: PluginCall) {
        val out = JSObject()
        out.put("granted", notificationsGranted())
        call.resolve(out)
    }

    companion object {
        private const val NOTIFICATIONS_ALIAS = "notifications"
        private const val DEFAULT_INSTANCE = "default"
        private const val DEFAULT_LABEL = "Plenum"
        private val INSTANCE_PATTERN = Regex("^[A-Za-z0-9._-]{1,64}$")
        private val VAPID_PATTERN = Regex("^[A-Za-z0-9_-]{87}$")
        private val PACKAGE_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

        @Volatile
        private var live: WeakReference<UnifiedPushPlugin>? = null

        /**
         * Delivers an event from the push service. Does nothing when the bridge is not alive; the endpoint and the
         * failures are also kept in UnifiedPushStore, so the shell reads them with getState() on its next start.
         */
        internal fun deliver(event: String, data: JSObject, retain: Boolean) {
            val plugin = live?.get() ?: return
            val screen = plugin.activity ?: return
            screen.runOnUiThread { plugin.emit(event, data, retain) }
        }
    }
}
