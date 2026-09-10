import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  mergePrefs,
  parsePrefs,
  PREFS_VERSION,
  serializePrefs,
} from "../src/state/prefs";

/** A prefs.json as 1.2.1 wrote it: version 1, and no `unsavedEditsGuard` field at all. */
const V121 = JSON.stringify({ version: 1, readFromPedalConfirmed: true });

describe("parsePrefs", () => {
  it("defaults an absent unsavedEditsGuard to ON, not off", () => {
    // The regression this whole split exists to catch. Read with the `=== true` coercion the other
    // fields use, an absent field is false — silently disabling the guard for every install that
    // upgrades from 1.2.1, which is exactly the silent data loss the guard prevents.
    expect(parsePrefs(V121).unsavedEditsGuard).toBe(true);
    expect(parsePrefs(V121).readFromPedalConfirmed).toBe(true);
  });

  it("honours an explicit unsavedEditsGuard either way", () => {
    expect(
      parsePrefs(JSON.stringify({ version: 1, unsavedEditsGuard: false })).unsavedEditsGuard,
    ).toBe(false);
    expect(
      parsePrefs(JSON.stringify({ version: 1, unsavedEditsGuard: true })).unsavedEditsGuard,
    ).toBe(true);
  });

  it("defaults an absent readFromPedalConfirmed to false", () => {
    expect(parsePrefs(JSON.stringify({ version: 1 }))).toEqual(DEFAULTS);
  });

  it("falls back to defaults on an unknown version", () => {
    // A file from a future build: its fields may mean something else entirely, so trust none of them.
    const future = JSON.stringify({
      version: 99,
      unsavedEditsGuard: false,
      readFromPedalConfirmed: true,
    });
    expect(parsePrefs(future)).toEqual(DEFAULTS);
    expect(parsePrefs(JSON.stringify({ unsavedEditsGuard: false }))).toEqual(DEFAULTS);
  });

  it("falls back to defaults on anything that isn't a prefs object", () => {
    for (const junk of ["", "not json", "null", "[]", '"a string"', "42"]) {
      expect(parsePrefs(junk)).toEqual(DEFAULTS);
    }
  });

  it("treats a non-boolean field as unset, each in its own safe direction", () => {
    // Guarded for the guard, unconfirmed for the disclosure: both err toward asking the user.
    const junk = JSON.stringify({
      version: 1,
      unsavedEditsGuard: "no",
      readFromPedalConfirmed: "yes",
    });
    expect(parsePrefs(junk)).toEqual(DEFAULTS);
  });
});

describe("mergePrefs + serializePrefs", () => {
  it("merges the patch over the current prefs and stamps the version", () => {
    const written = serializePrefs(mergePrefs(DEFAULTS, { unsavedEditsGuard: false }));
    expect(JSON.parse(written)).toEqual({
      version: PREFS_VERSION,
      readFromPedalConfirmed: false,
      unsavedEditsGuard: false,
    });
  });

  it("round-trips through parsePrefs", () => {
    const prefs = { readFromPedalConfirmed: true, unsavedEditsGuard: false };
    expect(parsePrefs(serializePrefs(mergePrefs(DEFAULTS, prefs)))).toEqual(prefs);
  });

  it("keeps fields the patch doesn't mention", () => {
    const current = { readFromPedalConfirmed: true, unsavedEditsGuard: false };
    expect(parsePrefs(serializePrefs(mergePrefs(current, {})))).toEqual(current);
  });
});
