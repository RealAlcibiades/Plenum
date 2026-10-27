package com.realalcibiades.plenum.unifiedpush

import android.content.Context
import org.json.JSONException
import org.json.JSONObject

/**
 * What the plugin keeps between launches: the registration names, the last endpoint of each and the last failure.
 * Endpoints are push addresses. The key set (P-256 public key and auth secret) is never stored here: it reaches the
 * shell once, in the endpoint event, and the shell keeps it in its own store. Nothing in this file logs.
 */
internal object UnifiedPushStore {
    private const val PREFS = "plenum-unifiedpush"
    private const val KEY_REGISTRATIONS = "registrations"
    private const val KEY_ENDPOINTS = "endpoints"
    private const val KEY_FAILURES = "failures"

    /** True while an activity of Plenum is started. The closed-app path shows notifications only when this is false. */
    @Volatile
    var visible: Boolean = false

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun registrations(context: Context): List<String> =
        prefs(context).getStringSet(KEY_REGISTRATIONS, emptySet()).orEmpty().sorted()

    fun addRegistration(context: Context, instance: String) {
        val set = prefs(context).getStringSet(KEY_REGISTRATIONS, emptySet()).orEmpty().toMutableSet()
        set.add(instance)
        prefs(context).edit().putStringSet(KEY_REGISTRATIONS, set).apply()
    }

    fun removeRegistration(context: Context, instance: String) {
        val set = prefs(context).getStringSet(KEY_REGISTRATIONS, emptySet()).orEmpty().toMutableSet()
        set.remove(instance)
        prefs(context).edit().putStringSet(KEY_REGISTRATIONS, set).apply()
    }

    fun endpoints(context: Context): JSONObject = readMap(context, KEY_ENDPOINTS)

    fun failures(context: Context): JSONObject = readMap(context, KEY_FAILURES)

    fun saveEndpoint(context: Context, instance: String, url: String, temporary: Boolean) {
        val map = endpoints(context)
        map.put(instance, JSONObject().put("url", url).put("temporary", temporary))
        writeMap(context, KEY_ENDPOINTS, map)
        val failures = failures(context)
        failures.remove(instance)
        writeMap(context, KEY_FAILURES, failures)
    }

    fun removeEndpoint(context: Context, instance: String) {
        val map = endpoints(context)
        map.remove(instance)
        writeMap(context, KEY_ENDPOINTS, map)
    }

    fun saveFailure(context: Context, instance: String, reason: String) {
        val map = failures(context)
        map.put(instance, reason)
        writeMap(context, KEY_FAILURES, map)
    }

    private fun readMap(context: Context, key: String): JSONObject =
        try {
            JSONObject(prefs(context).getString(key, "{}") ?: "{}")
        } catch (e: JSONException) {
            JSONObject()
        }

    private fun writeMap(context: Context, key: String, map: JSONObject) {
        prefs(context).edit().putString(key, map.toString()).apply()
    }
}
