package com.realalcibiades.plenum.unifiedpush

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONException
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Closed-app notifications for the desktop's events (MOBILE-UI section 10). The payload is the desktop's own JSON,
 * built by lib/remote/push.mjs: { v, kind, title, body, tag, tap, actions: [{ action, title, route }], ids, firstLine? }.
 * Only the generic title and body are shown. A tap or an action opens Plenum at the route, and the shell unlocks and
 * does the action. Every action has setAuthenticationRequired(true), so device authentication comes first.
 *
 * The rules here mirror mobile/plugins/unifiedpush/src/core.js (parsePushPayload, routeForAction, channelForKind).
 */
internal object PlenumNotifier {
    const val CHANNEL_APPROVALS = "plenum-approvals"
    const val CHANNEL_FINISHED = "plenum-finished"
    const val CHANNEL_LIMITS = "plenum-limits"

    private const val NOTIFICATION_ID = 1
    private const val MAX_ACTIONS = 3
    private val KINDS = setOf("approval", "handover", "finished", "failed", "limit", "test")
    private val ACTIONS = setOf("deny", "stop", "approve")
    private val TAG_PATTERN = Regex("^plenum-[0-9a-f]{32}$")
    private val ROUTE_PATTERN = Regex("^/#[\\x21-\\x7e]{1,200}$")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

    internal class RouteAction(val action: String, val title: String, val route: String)

    internal class Payload(
        val kind: String,
        val title: String,
        val body: String,
        val tag: String,
        val tap: String,
        val actions: List<RouteAction>,
        val firstLine: String?,
    )

    /** Creates the three channels. Safe to call often: Android updates an existing channel. */
    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, context.getString(R.string.plenum_channel_approvals), NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_FINISHED, context.getString(R.string.plenum_channel_finished), NotificationManager.IMPORTANCE_DEFAULT),
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_LIMITS, context.getString(R.string.plenum_channel_limits), NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    fun channelFor(kind: String): String =
        when (kind) {
            "approval", "handover" -> CHANNEL_APPROVALS
            "limit" -> CHANNEL_LIMITS
            else -> CHANNEL_FINISHED
        }

    /** Parses a decrypted payload. Returns null for anything that is not a version 1 Plenum payload. */
    fun parse(content: ByteArray): Payload? {
        val text = String(content, Charsets.UTF_8)
        val json = try {
            JSONObject(text)
        } catch (e: JSONException) {
            return null
        }
        if (json.optInt("v", 0) != 1) return null
        val kind = json.optString("kind")
        if (kind !in KINDS) return null
        val actions = mutableListOf<RouteAction>()
        val list = json.optJSONArray("actions")
        if (list != null) {
            // The first three valid actions count, as in core.js parsePushPayload.
            for (i in 0 until list.length()) {
                if (actions.size >= MAX_ACTIONS) break
                val entry = list.optJSONObject(i) ?: continue
                val name = entry.optString("action")
                val route = entry.optString("route")
                if (name in ACTIONS && ROUTE_PATTERN.matches(route)) {
                    actions.add(RouteAction(name, clean(entry.optString("title"), 40).ifEmpty { name }, route))
                }
            }
        }
        val tap = json.optString("tap")
        val tag = json.optString("tag")
        return Payload(
            kind = kind,
            title = clean(json.optString("title"), 120).ifEmpty { "Plenum" },
            body = clean(json.optString("body"), 240).ifEmpty { "Plenum has an update." },
            tag = if (TAG_PATTERN.matches(tag)) tag else "plenum",
            tap = if (ROUTE_PATTERN.matches(tap)) tap else "/#home",
            actions = actions,
            firstLine = clean(json.optString("firstLine"), 200).ifEmpty { null },
        )
    }

    /** Shows the closed-app notification for one decrypted payload. Does nothing when notifications are not allowed. */
    fun showFromPayload(context: Context, content: ByteArray) {
        val payload = parse(content) ?: return
        show(context, payload)
    }

    fun show(context: Context, payload: Payload) {
        ensureChannels(context)
        val urgent = payload.kind == "approval" || payload.kind == "handover"
        val builder = NotificationCompat.Builder(context, channelFor(payload.kind))
            .setSmallIcon(R.drawable.ic_stat_plenum)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(intentFor(context, payload.tap, payload.tap))
        for (action in payload.actions) {
            val route = routeFor(action, payload.firstLine)
            val pending = intentFor(context, route, "action:" + action.action + ":" + route)
            builder.addAction(
                NotificationCompat.Action.Builder(null, action.title, pending)
                    .setAuthenticationRequired(true)
                    .build(),
            )
        }
        try {
            NotificationManagerCompat.from(context).notify(payload.tag, NOTIFICATION_ID, builder.build())
        } catch (e: SecurityException) {
            // Notifications were refused at this moment. The shell asks for them again after a tap.
        }
    }

    // An approve route carries the first line the notification showed (core.js routeForAction).
    private fun routeFor(action: RouteAction, firstLine: String?): String =
        if (action.action == "approve" && firstLine != null) {
            action.route + "&line=" + URLEncoder.encode(firstLine, "UTF-8").replace("+", "%20")
        } else {
            action.route
        }

    // plenum://app plus the route, for example plenum://app/#deny=<id>. The app's manifest filter for the plenum scheme
    // receives it; Capacitor's App plugin passes it to the shell as appUrlOpen.
    private fun intentFor(context: Context, route: String, key: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("plenum://app$route"))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context,
            key.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun clean(value: String, max: Int): String = value.replace(CONTROL, " ").trim().take(max)
}
