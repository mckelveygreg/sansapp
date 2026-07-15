// Expo config plugin: Android MIDI connectivity for the pedal.
//
//   BLE (CME WIDI Jack): BLUETOOTH_SCAN + BLUETOOTH_CONNECT (API 31+). `neverForLocation` on SCAN
//     declares we don't derive location from BLE, so Android 12+ won't force the location permission.
//     Legacy (API <=30): BLUETOOTH/BLUETOOTH_ADMIN + ACCESS_FINE_LOCATION (old BLE scan needed it).
//   USB (the pedal's MD1 interface): android.hardware.usb.host declared optional — android.media.midi
//     enumerates a class-compliant USB-MIDI interface through the MIDI service (no raw-USB intent
//     filter required). Both features are `required=false` so neither excludes devices on the Play
//     Store (a phone can connect over whichever transport it supports).
const { withAndroidManifest } = require("expo/config-plugins");

const PERMISSIONS = [
  { name: "android.permission.BLUETOOTH_SCAN", flags: "neverForLocation" },
  { name: "android.permission.BLUETOOTH_CONNECT" },
  { name: "android.permission.BLUETOOTH", maxSdkVersion: "30" },
  { name: "android.permission.BLUETOOTH_ADMIN", maxSdkVersion: "30" },
  { name: "android.permission.ACCESS_FINE_LOCATION", maxSdkVersion: "30" },
];

const FEATURES = [
  { name: "android.hardware.usb.host", required: false },
  { name: "android.hardware.bluetooth_le", required: false },
];

function ensurePermissions(manifest) {
  manifest["uses-permission"] = manifest["uses-permission"] || [];
  const list = manifest["uses-permission"];
  for (const perm of PERMISSIONS) {
    const attrs = { "android:name": perm.name };
    if (perm.flags) attrs["android:usesPermissionFlags"] = perm.flags;
    if (perm.maxSdkVersion) attrs["android:maxSdkVersion"] = perm.maxSdkVersion;
    const existing = list.find((p) => p.$ && p.$["android:name"] === perm.name);
    if (existing) existing.$ = { ...existing.$, ...attrs };
    else list.push({ $: attrs });
  }
}

function ensureFeatures(manifest) {
  manifest["uses-feature"] = manifest["uses-feature"] || [];
  const list = manifest["uses-feature"];
  for (const feat of FEATURES) {
    if (list.find((f) => f.$ && f.$["android:name"] === feat.name)) continue;
    list.push({ $: { "android:name": feat.name, "android:required": String(feat.required) } });
  }
}

module.exports = function withAndroidMidi(config) {
  return withAndroidManifest(config, (cfg) => {
    const { manifest } = cfg.modResults;
    ensurePermissions(manifest);
    ensureFeatures(manifest);
    return cfg;
  });
};
