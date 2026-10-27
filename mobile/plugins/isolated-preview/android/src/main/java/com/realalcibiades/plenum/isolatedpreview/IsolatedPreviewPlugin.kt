package com.realalcibiades.plenum.isolatedpreview

import android.content.Context
import android.content.Intent
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Shows an artifact's HTML in IsolatedPreviewActivity (mob-13, MOBILE-UI 8.9). The HTML is written to the app's cache
 * folder and the activity, in its own process, reads it once and deletes it. Nothing is passed through the intent, so
 * the size is limited only by the 8 MB check here and in core.js.
 */
@CapacitorPlugin(name = "IsolatedPreview")
class IsolatedPreviewPlugin : Plugin() {

    @PluginMethod
    fun show(call: PluginCall) {
        val html = call.getString("html")
        if (html.isNullOrEmpty()) {
            call.reject("There is nothing to preview.", "empty")
            return
        }
        val bytes = html.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_HTML_BYTES) {
            call.reject("The artifact is larger than 8 MB. Open it on the computer instead.", "too-large")
            return
        }
        val title = (call.getString("title") ?: "").replace(CONTROL, " ").trim().take(MAX_TITLE_CHARS)

        val directory = previewDirectory(context)
        directory.mkdirs()
        removeStale(directory)
        val file = File.createTempFile("preview-", ".html", directory)
        file.writeBytes(bytes)

        val intent = Intent(context, IsolatedPreviewActivity::class.java)
            .putExtra(IsolatedPreviewActivity.EXTRA_PATH, file.absolutePath)
            .putExtra(IsolatedPreviewActivity.EXTRA_TITLE, title)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    private fun removeStale(directory: File) {
        val cutoff = System.currentTimeMillis() - MAX_AGE_MS
        directory.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }

    companion object {
        const val MAX_HTML_BYTES = 8 * 1024 * 1024
        const val MAX_TITLE_CHARS = 120
        private const val MAX_AGE_MS = 60L * 60L * 1000L
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")
    }
}

/** The folder the preview files live in. Both the plugin and the activity use this one function. */
internal fun previewDirectory(context: Context): File = File(context.cacheDir, "isolated-preview")
