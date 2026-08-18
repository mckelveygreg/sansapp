import type { ExpoConfig } from "expo/config";

import { version } from "./package.json";

// The marketing version has ONE home: package.json. `npm version <x.y.z>` bumps it and everything
// else derives from here — CFBundleShortVersionString, Android's versionName, the versionCode below,
// and the string on the Settings page. Nothing publishes this package to npm; package.json is simply
// the one version field an npm-shaped toolchain already knows how to edit.
//
// The two BUILD counters are deliberately NOT tracked in git:
//   iOS CFBundleVersion — `fastlane ios beta` sets it to TestFlight's highest + 1 at build time, and
//     ios/ is git-ignored, so App Store Connect is the authority (buildNumber below is a seed only).
//   Android versionCode — Play offers no equivalent query in this setup, so it is derived from the
//     version instead: 1.2.0 -> 10200. Play requires a strictly higher integer on every upload, so
//     set ANDROID_VERSION_CODE to re-upload a build of the SAME marketing version.
const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
if (
  ![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0) ||
  minor > 99 ||
  patch > 99
) {
  // Over 99 would carry into the next field and break Play's monotonicity requirement.
  throw new Error(`Cannot derive an Android versionCode from package.json version "${version}"`);
}
const versionCode = Number(process.env.ANDROID_VERSION_CODE) || major * 10000 + minor * 100 + patch;

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
  version,
  orientation: "portrait",
  userInterfaceStyle: "dark",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "com.mckelveygreg.sansapp",
    // Seed only — `fastlane ios beta` overwrites this with TestFlight's next build number.
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
    versionCode,
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
