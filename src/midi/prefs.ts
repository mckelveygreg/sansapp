/**
 * Small persisted app preferences — the RN surface: one JSON file in the document directory, and the
 * in-memory copy of it. What a preference *means* (defaults, versioning, how an absent field reads)
 * lives in `src/state/prefs.ts`, where the gate can test it; this module owns only the reading, the
 * writing, and the copy in between.
 *
 * That copy is what lets a preference be read from a *synchronous* code path: the unsaved-edits
 * guard runs on the preset-step button, where awaiting a file read per press would both cost IO and
 * let two quick presses resolve out of order, leaving the pedal on the wrong slot.
 *
 * RN app surface (expo-file-system). No-op on web, where the defaults apply every launch.
 */
import { Platform } from "react-native";
import { DEFAULTS, mergePrefs, parsePrefs, type Prefs, serializePrefs } from "../state/prefs";

const FILE = "prefs.json";

/** Last known prefs. Defaults until the first read lands — i.e. guarded, the safe direction. */
let cache: Prefs = { ...DEFAULTS };

/** The first (and only) read of the file. See `loadPrefs`. */
let hydration: Promise<void> | null = null;

/**
 * The prefs as last read, with no waiting. For code that cannot await — see the note above. Before
 * hydration (the first moments of a launch) this is the defaults.
 */
export function getPrefs(): Prefs {
  return cache;
}

/**
 * The saved prefs, waiting for the first read if it hasn't landed yet.
 *
 * The file is read **once**. This app is its only writer, so once the cache exists it *is* the saved
 * state, and a second read could only lose a write still on its way to disk — which is exactly how a
 * toggle made during a slow launch would get silently reverted.
 */
export function loadPrefs(): Promise<Prefs> {
  hydration ??= read();
  return hydration.then(getPrefs);
}

async function read(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    cache = parsePrefs(new TextDecoder().decode(buf));
  } catch {
    cache = { ...DEFAULTS }; // no file yet, or unreadable
  }
}

/**
 * Merge `patch` into the saved prefs. Best-effort on disk; the in-memory copy updates either way, so
 * the change takes effect on the next read and still holds for the session on web.
 */
export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  // Merge onto what was SAVED, never onto the defaults. A write that beat hydration — the Read from
  // Pedal disclosure accepted during a slow launch, say — would otherwise stamp a default over a
  // preference the user had already set, silently restoring a guard they had turned off.
  await loadPrefs();
  cache = mergePrefs(cache, patch);
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(new TextEncoder().encode(serializePrefs(cache)));
  } catch {
    // a write failure just means the preference isn't remembered next launch
  }
}

// Start the read at import. Nothing needs to await it: the first preference that matters is many
// seconds away — you have to connect to a pedal before you can change preset.
void loadPrefs();
