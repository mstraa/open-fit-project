package org.openfit.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the native BLE plugin (direct-device port — see docs/NATIVE-BLE-PORT.md)
        // BEFORE the bridge initializes.
        registerPlugin(OpenFitBlePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
