/**
 * Small persisted app preferences — things the app must remember about the *user*, not about a pedal
 * (those live in deviceCache.ts, keyed by serial). One JSON file in the document directory.
 *
 * RN app surface (expo-file-system). No-op on web, where the defaults apply every launch.
 */
import { Platform } from "react-native";

const FILE = "prefs.json";
const VERSION = 1;

export interface Prefs {
  /**
   * The user has been shown, and accepted, what Read from Pedal does — that it briefly writes to the
   * preset they are on. Asked once; the action's own subtitle discloses it permanently after that.
   */
  readFromPedalConfirmed: boolean;
}

const DEFAULTS: Prefs = { readFromPedalConfirmed: false };

interface PrefsFile extends Partial<Prefs> {
  version: number;
}

/** Read the saved prefs, falling back to defaults for anything missing / unreadable / on web. */
export async function loadPrefs(): Promise<Prefs> {
  if (Platform.OS === "web") return { ...DEFAULTS };
  try {
    const { File, Paths } = await import("expo-file-system");
    const buf = await new File(Paths.document, FILE).arrayBuffer(); // throws if missing
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as PrefsFile;
    if (parsed.version !== VERSION) return { ...DEFAULTS };
    return {
      readFromPedalConfirmed: parsed.readFromPedalConfirmed === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge `patch` into the saved prefs. Best-effort; no-op on web. */
export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const { File, Paths } = await import("expo-file-system");
    const merged: PrefsFile = { ...(await loadPrefs()), ...patch, version: VERSION };
    const file = new File(Paths.document, FILE);
    try {
      file.create({ overwrite: true });
    } catch {
      // already exists — write() overwrites
    }
    file.write(new TextEncoder().encode(JSON.stringify(merged)));
  } catch {
    // a write failure just means the preference isn't remembered next launch
  }
}
