/**
 * User-saved custom amp voicings: a name + the amp-bundle bytes (AMP_BUNDLE_OFFSETS). Persisted as
 * JSON in the app's document directory, so your own amps survive restarts and sit alongside the
 * factory models on the Amp page. RN app surface (expo-file-system). No-op on web.
 */
import { Platform } from "react-native";

const FILE = "amp-presets.json";
const VERSION = 1;

export interface AmpPreset {
  name: string;
  /** Bytes at AMP_BUNDLE_OFFSETS, in that order. */
  bytes: number[];
}

interface PresetFile {
  version: number;
  presets: AmpPreset[];
}

/** Load saved custom amps (empty array if none / unreadable / web). */
export async function loadAmpPresets(): Promise<AmpPreset[]> {
  if (Platform.OS === "web") return [];
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as PresetFile;
    if (parsed.version !== VERSION || !Array.isArray(parsed.presets)) return [];
    return parsed.presets.filter((p) => typeof p.name === "string" && Array.isArray(p.bytes));
  } catch {
    return [];
  }
}

/** Persist the full list of custom amps. Best-effort; no-op on web. */
export async function saveAmpPresets(presets: AmpPreset[]): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    const data: PresetFile = { version: VERSION, presets };
    file.write(new TextEncoder().encode(JSON.stringify(data)));
  } catch {
    // a write failure just means the custom isn't persisted
  }
}
