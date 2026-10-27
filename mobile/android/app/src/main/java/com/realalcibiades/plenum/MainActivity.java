package com.realalcibiades.plenum;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins are registered before the bridge starts (Capacitor's BridgeActivity contract).
        registerPlugin(PlenumPrivacyPlugin.class);
        super.onCreate(savedInstanceState);
        // "Hide content in the app switcher" applies from the first frame, before the shell has loaded (MOBILE-UI 15.6).
        PlenumPrivacyPlugin.applyTo(getWindow(), PlenumPrivacyPlugin.hideInSwitcher(this));
    }
}
