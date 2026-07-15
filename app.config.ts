import type { ExpoConfig } from "expo/config";

// React Native is built from source ONLY for the dev client: its DEBUG dylib needs symbols the
// precompiled RN xcframework's debug variant lacks (RCTPackagerConnection etc.). Release builds work
// with the precompiled frameworks — far faster — so from-source stays OFF unless EXPO_RN_FROM_SOURCE
// is set (the `ios`/`ios:device` dev-build scripts set it; `ios:release` does not). Toggling this
// changes the Podfile, so the first build after a flip runs `pod install` (add `--clean` if it errors).
const rnFromSource = process.env.EXPO_RN_FROM_SOURCE === "1";

/** Expo app config. Requires `npx expo install` (see README "Running the app"). */
const config: ExpoConfig = {
  name: "SansApp",
  slug: "sansapp",
  scheme: "sansapp",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "com.mckelveygreg.sansapp",
    buildNumber: "1",
    supportsTablet: false,
    infoPlist: {
      // Bluetooth MIDI (WIDI Jack) pairing sheet. Both keys so older iOS is covered.
      NSBluetoothAlwaysUsageDescription:
        "SansApp uses Bluetooth to connect to your pedal over Bluetooth MIDI.",
      NSBluetoothPeripheralUsageDescription:
        "SansApp uses Bluetooth to connect to your pedal over Bluetooth MIDI.",
      // No non-exempt encryption — skips the export-compliance prompt on every TestFlight upload.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "com.mckelveygreg.sansapp",
    versionCode: 1,
    adaptiveIcon: { foregroundImage: "./assets/icon.png", backgroundColor: "#0e0e10" },
  },
  plugins: [
    "expo-router",
    "expo-sharing",
    [
      "expo-splash-screen",
      { image: "./assets/icon.png", imageWidth: 180, backgroundColor: "#0e0e10" },
    ],
    // From-source only for the dev client (see rnFromSource above). ccache caches C++ compilation
    // across builds (survives a clean) — speeds up the dev-client builds that still build from source.
    [
      "expo-build-properties",
      { ios: { buildReactNativeFromSource: rnFromSource, ccacheEnabled: true } },
    ],
    // Android MIDI permissions + USB-host/BLE features (see plugins/withAndroidMidi.js).
    "./plugins/withAndroidMidi",
  ],
  web: { bundler: "metro", output: "single", favicon: "./assets/icon.png" },
  experiments: { typedRoutes: false },
};

export default config;
