/**
 * Persistent slot→name cache. Preset names live in each preset's blob, so reading all 128 off the
 * pedal is a ~35s Bluetooth pull. We cache the map to disk so the Presets list is populated instantly
 * on launch (and offline), surviving restarts — a live read always wins over the cache, and Refresh
 * re-pulls. Mirrors irCache. RN app surface (expo-file-system); no-op on web.
 */
import { Platform } from "react-native";

const FILE = "preset-names.json";
const VERSION = 1;

interface NameFile {
  version: number;
  names: Record<number, string>;
}

/** Load the cached slot→name map (empty if none / unreadable / web). */
export async function loadNameCache(): Promise<Record<number, string>> {
  if (Platform.OS === "web") return {};
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as NameFile;
    if (parsed.version !== VERSION || typeof parsed.names !== "object" || !parsed.names) return {};
    return parsed.names;
  } catch {
    return {};
  }
}

/** Persist the slot→name map. Best-effort; no-op on web. */
export async function saveNameCache(names: Record<number, string>): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(
      new TextEncoder().encode(JSON.stringify({ version: VERSION, names } satisfies NameFile)),
    );
  } catch {
    // a write failure just means the names aren't cached this time
  }
}
