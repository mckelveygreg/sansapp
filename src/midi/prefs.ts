/**
 * Small persisted app preferences — the RN file surface: one JSON file in the document directory.
 * What a preference *means* (defaults, versioning, how an absent field reads) lives in
 * `src/state/prefs.ts`, where the gate can test it; this module only moves the bytes.
 *
 * It also keeps the loaded value in memory, so a preference can be read from a *synchronous* code
 * path — the unsaved-edits guard runs on the preset-step button, where awaiting a file read per
 * press would both cost IO and let two quick presses resolve out of order.
 *
 * RN app surface (expo-file-system). No-op on web, where the defaults apply every launch.
 */
import { Platform } from "react-native";
import { DEFAULTS, parsePrefs, type Prefs, serializePrefs } from "../state/prefs";

const FILE = "prefs.json";

/** Last known prefs. Defaults until the first load lands — i.e. guarded, the safe direction. */
let cache: Prefs = { ...DEFAULTS };

/**
 * The prefs as last loaded, with no waiting. For code that cannot await — see the note above. Before
 * hydration (the first few hundred ms of a launch) this is the defaults.
 */
export function getPrefs(): Prefs {
  return cache;
}

/** Read the saved prefs, falling back to defaults for anything missing / unreadable / on web. */
export async function loadPrefs(): Promise<Prefs> {
  if (Platform.OS === "web") return cache;
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    cache = parsePrefs(new TextDecoder().decode(buf));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

/**
 * Merge `patch` into the saved prefs. The in-memory value updates immediately — so the change takes
 * effect on the very next read, and on web (where nothing is written) it still holds for the
 * session. Best-effort on disk.
 */
export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const merged = serializePrefs(cache, patch);
  cache = parsePrefs(merged);
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(new TextEncoder().encode(merged));
  } catch {
    // a write failure just means the preference isn't remembered next launch
  }
}

// Hydrate on import. The first preference read that matters is many seconds away — you have to
// connect to a pedal before you can change preset — so nothing needs to await this.
void loadPrefs();
