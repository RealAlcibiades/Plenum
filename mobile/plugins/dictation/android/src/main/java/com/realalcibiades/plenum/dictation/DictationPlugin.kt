package com.realalcibiades.plenum.dictation

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.Locale

/**
 * Dictation for the Plenum Android app (mob-13, MOBILE-UI 8.5.4 and 15.6). Recognition runs on the phone first:
 * SpeechRecognizer.createOnDeviceSpeechRecognizer on Android 12 and later. The system's server recognition is used only
 * when the person has turned on "Allow that" in Phone settings, which arrives as allowServer. The text goes to the
 * shell as partial and final events; nothing is sent to the computer until the person presses Send.
 *
 * Events: partial { text }, final { text }, level { value 0..1 }, end { reason }, error { code, message }.
 */
@CapacitorPlugin(
    name = "Dictation",
    permissions = [Permission(strings = ["android.permission.RECORD_AUDIO"], alias = "microphone")],
)
class DictationPlugin : Plugin() {

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    override fun handleOnPause() {
        if (listening) {
            recognizer?.cancel()
            finish("cancelled")
        }
    }

    override fun handleOnDestroy() {
        recognizer?.destroy()
        recognizer = null
        listening = false
    }

    @PluginMethod
    fun available(call: PluginCall) {
        val out = JSObject()
        out.put("available", SpeechRecognizer.isRecognitionAvailable(context) || onDeviceSupported())
        out.put("onDevice", onDeviceSupported())
        out.put("serverAvailable", SpeechRecognizer.isRecognitionAvailable(context))
        out.put("permission", permissionName())
        out.put("platform", "android")
        call.resolve(out)
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (permissionName() == "granted") {
            resolvePermission(call)
            return
        }
        requestPermissionForAlias("microphone", call, "microphonePermissionCallback")
    }

    @PermissionCallback
    fun microphonePermissionCallback(call: PluginCall) {
        resolvePermission(call)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val locale = call.getString("locale")?.takeIf { it.isNotEmpty() }
        if (locale != null && !LOCALE_PATTERN.matches(locale)) {
            call.reject("That language tag is not valid.", "bad-locale")
            return
        }
        val allowServer = call.getBoolean("allowServer", false) ?: false
        val silenceMs = (call.getInt("silenceMs", DEFAULT_SILENCE_MS) ?: DEFAULT_SILENCE_MS).coerceIn(MIN_SILENCE_MS, MAX_SILENCE_MS)
        if (permissionName() != "granted") {
            call.reject("Plenum cannot use the microphone. Allow it in Settings › Plenum.", "permission-denied")
            return
        }
        if (listening) {
            call.reject("Dictation is already listening.", "busy")
            return
        }
        val screen = activity
        if (screen == null) {
            call.reject("Dictation needs Plenum on screen.", "no-activity")
            return
        }
        screen.runOnUiThread { begin(call, locale, allowServer, silenceMs) }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        activity?.runOnUiThread { recognizer?.stopListening() }
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        activity?.runOnUiThread {
            recognizer?.cancel()
            finish("cancelled")
        }
        call.resolve()
    }

    private fun begin(call: PluginCall, locale: String?, allowServer: Boolean, silenceMs: Int) {
        val created: SpeechRecognizer? = try {
            when {
                !allowServer && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ->
                    SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                !allowServer -> null
                else -> SpeechRecognizer.createSpeechRecognizer(context)
            }
        } catch (e: RuntimeException) {
            null
        }
        if (created == null) {
            emit("error", JSObject().put("code", "on-device-unavailable").put("message", "On-device recognition is not on this phone."), true)
            call.reject("On-device recognition is not on this phone.", "on-device-unavailable")
            return
        }
        recognizer = created
        listening = true
        created.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}

            override fun onBeginningOfSpeech() {}

            override fun onRmsChanged(rmsdB: Float) {
                // Typical speech sits between about -2 and 10 dB; scale that to 0..1 for the level meter.
                val value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                emit("level", JSObject().put("value", value.toDouble()), false)
            }

            override fun onBufferReceived(buffer: ByteArray?) {}

            override fun onEndOfSpeech() {}

            override fun onError(error: Int) {
                onRecognitionError(error)
            }

            override fun onResults(results: Bundle?) {
                val text = firstResult(results)
                if (text.isEmpty()) {
                    finish("no-speech")
                } else {
                    emit("final", JSObject().put("text", text), false)
                    finish("done")
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {
                val text = firstResult(partialResults)
                if (text.isNotEmpty()) emit("partial", JSObject().put("text", text), false)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        created.startListening(intentFor(locale, allowServer, silenceMs))
        call.resolve()
    }

    private fun onRecognitionError(error: Int) {
        when (error) {
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> finish("no-speech")
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> fail("busy", "Dictation is already listening.")
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("permission-denied", "The microphone permission is off.")
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                fail("network", "The speech service could not be reached.")
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                fail("on-device-unavailable", "This language is not on the phone.")
            else -> fail("unknown", "Dictation stopped (recognizer error $error).")
        }
    }

    private fun fail(code: String, message: String) {
        emit("error", JSObject().put("code", code).put("message", message), true)
        finish("error")
    }

    private fun finish(reason: String) {
        if (!listening) return
        listening = false
        recognizer?.setRecognitionListener(null)
        recognizer?.destroy()
        recognizer = null
        emit("end", JSObject().put("reason", reason), true)
    }

    private fun emit(event: String, data: JSObject, retain: Boolean) {
        notifyListeners(event, data, retain)
    }

    private fun intentFor(locale: String?, allowServer: Boolean, silenceMs: Int): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale ?: Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, !allowServer)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs.toLong())
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs.toLong())
        }

    // On-device recognition is always reported as available from Android 12 (API 31). From Android 13 the system can
    // say whether the on-device recogniser is installed; on 12 the attempt in begin() decides.
    private fun onDeviceSupported(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        } else {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        }

    private fun permissionName(): String =
        when (getPermissionState("microphone")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }

    private fun resolvePermission(call: PluginCall) {
        val out = JSObject()
        out.put("permission", permissionName())
        call.resolve(out)
    }

    private fun firstResult(bundle: Bundle?): String {
        val first = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return ""
        return first.replace(CONTROL, " ").take(MAX_TEXT_CHARS)
    }

    companion object {
        private const val DEFAULT_SILENCE_MS = 2000
        private const val MIN_SILENCE_MS = 500
        private const val MAX_SILENCE_MS = 5000
        private const val MAX_TEXT_CHARS = 4000
        private val LOCALE_PATTERN = Regex("^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
    }
}
