/**
 * Small persisted app preferences — the pure half: what each preference means, and what an absent,
 * malformed, or unrecognised one falls back to. Framework-free so the gate can test the *upgrade*
 * path, which is where a preference file can actually hurt someone. The file IO that reads and
 * writes them lives in `src/midi/prefs.ts`.
 *
 * These are things the app must remember about the *user*, not about a pedal (those live in
 * `src/midi/deviceCache.ts`, keyed by serial).
 */

export interface Prefs {
  /**
   * The user has been shown, and accepted, what Read from Pedal does — that it briefly writes to the
   * preset they are on. Asked once; the action's own subtitle discloses it permanently after that.
   */
  readFromPedalConfirmed: boolean;
  /**
   * Raise the unsaved-edits guard before a preset change: ask whether to save, discard, or stay.
   * Off, a preset change discards the app's unsaved edits without asking — which is what a player
   * deliberately experimenting wants, and what nobody else does. Hence: on unless turned off.
   */
  unsavedEditsGuard: boolean;
}

/** Bumped only when a field's *meaning* changes. Adding a field doesn't qualify — see `parsePrefs`. */
export const PREFS_VERSION = 1;

export const DEFAULTS: Prefs = { readFromPedalConfirmed: false, unsavedEditsGuard: true };

/** The saved prefs in `text`, with defaults for anything missing, malformed, or from another version. */
export function parsePrefs(text: string): Prefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ...DEFAULTS };
  const file = parsed as Partial<Record<keyof Prefs | "version", unknown>>;
  // A file from another build may use the same field names to mean something else, so trust none of
  // them. An *absent* field is not that: it's an older build that simply never had this preference,
  // which is why adding one doesn't bump the version — bumping would throw away the prefs it does
  // have (a 1.2.1 file's `readFromPedalConfirmed`) to gain nothing.
  if (file.version !== PREFS_VERSION) return { ...DEFAULTS };
  return {
    readFromPedalConfirmed: file.readFromPedalConfirmed === true,
    // ⚠️ `!== false`, NOT the `=== true` above. This preference defaults to ON, so an absent field —
    // every prefs.json written before it existed — must read as ON. Coerced the other way, upgrading
    // from 1.2.1 would silently drop the guard for everyone who ever accepted the Read from Pedal
    // disclosure. Anything that isn't literally `false` therefore means guarded: the safe direction.
    unsavedEditsGuard: file.unsavedEditsGuard !== false,
  };
}

/** `patch` applied over `current`. */
export function mergePrefs(current: Prefs, patch: Partial<Prefs>): Prefs {
  return { ...current, ...patch };
}

/** `prefs` stamped with the version and serialised for writing. */
export function serializePrefs(prefs: Prefs): string {
  return JSON.stringify({ ...prefs, version: PREFS_VERSION });
}
