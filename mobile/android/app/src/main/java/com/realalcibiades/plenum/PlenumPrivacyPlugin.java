package com.realalcibiades.plenum;

import android.app.Activity;
import android.content.Context;
import android.view.Window;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Hide content in the app switcher" (MOBILE-UI 6.17 and 15.6). While the setting is on, the window is FLAG_SECURE: the
 * app switcher shows no content and screenshots are refused. While it is off, screenshots work. The setting is kept
 * natively, so the flag applies from the first frame (MainActivity), before the shell has loaded.
 *
 * JavaScript: PlenumPrivacy.getHideInSwitcher() -> { enabled }, PlenumPrivacy.setHideInSwitcher({ enabled }) -> { enabled }.
 * The default is on, as the Settings row shows it.
 */
@CapacitorPlugin(name = "PlenumPrivacy")
public class PlenumPrivacyPlugin extends Plugin {
    private static final String PREFS = "plenum-privacy";
    private static final String KEY_HIDE = "hideInSwitcher";

    static boolean hideInSwitcher(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_HIDE, true);
    }

    static void applyTo(Window window, boolean hide) {
        if (hide) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    @PluginMethod
    public void getHideInSwitcher(PluginCall call) {
        JSObject out = new JSObject();
        out.put("enabled", hideInSwitcher(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void setHideInSwitcher(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) {
            call.reject("enabled must be true or false.", "bad-value");
            return;
        }
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_HIDE, enabled).apply();
        Activity activity = getActivity();
        if (activity != null) {
            final boolean hide = enabled;
            activity.runOnUiThread(() -> applyTo(activity.getWindow(), hide));
        }
        JSObject out = new JSObject();
        out.put("enabled", enabled);
        call.resolve(out);
    }
}
