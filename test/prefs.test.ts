import { describe, expect, it } from "vitest";
import { DEFAULTS, parsePrefs, PREFS_VERSION, serializePrefs } from "../src/state/prefs";

/** A prefs.json as 1.2.1 wrote it: version 1, and no `unsavedGuard` field at all. */
const V121 = JSON.stringify({ version: 1, readFromPedalConfirmed: true });

describe("parsePrefs", () => {
  it("defaults an absent unsavedGuard to ON, not off", () => {
    // The regression this whole split exists to catch. Read with the `=== true` coercion the other
    // fields use, an absent field is false — silently disabling the guard for every install that
    // upgrades from 1.2.1, which is exactly the silent data loss the guard prevents.
    expect(parsePrefs(V121).unsavedGuard).toBe(true);
    expect(parsePrefs(V121).readFromPedalConfirmed).toBe(true);
  });

  it("honours an explicit unsavedGuard either way", () => {
    expect(parsePrefs(JSON.stringify({ version: 1, unsavedGuard: false })).unsavedGuard).toBe(
      false,
    );
    expect(parsePrefs(JSON.stringify({ version: 1, unsavedGuard: true })).unsavedGuard).toBe(true);
  });

  it("defaults an absent readFromPedalConfirmed to false", () => {
    expect(parsePrefs(JSON.stringify({ version: 1 }))).toEqual(DEFAULTS);
  });

  it("falls back to defaults on an unknown version", () => {
    // A file from a future build: its fields may mean something else entirely, so trust none of them.
    const future = JSON.stringify({
      version: 99,
      unsavedGuard: false,
      readFromPedalConfirmed: true,
    });
    expect(parsePrefs(future)).toEqual(DEFAULTS);
    expect(parsePrefs(JSON.stringify({ unsavedGuard: false }))).toEqual(DEFAULTS);
  });

  it("falls back to defaults on anything that isn't a prefs object", () => {
    for (const junk of ["", "not json", "null", "[]", '"a string"', "42"]) {
      expect(parsePrefs(junk)).toEqual(DEFAULTS);
    }
  });

  it("treats a non-boolean field as unset, each in its own safe direction", () => {
    // Guarded for the guard, unconfirmed for the disclosure: both err toward asking the user.
    const junk = JSON.stringify({ version: 1, unsavedGuard: "no", readFromPedalConfirmed: "yes" });
    expect(parsePrefs(junk)).toEqual(DEFAULTS);
  });
});

describe("serializePrefs", () => {
  it("merges the patch over the current prefs and stamps the version", () => {
    const written = serializePrefs(DEFAULTS, { unsavedGuard: false });
    expect(JSON.parse(written)).toEqual({
      version: PREFS_VERSION,
      readFromPedalConfirmed: false,
      unsavedGuard: false,
    });
  });

  it("round-trips through parsePrefs", () => {
    const prefs = { readFromPedalConfirmed: true, unsavedGuard: false };
    expect(parsePrefs(serializePrefs(DEFAULTS, prefs))).toEqual(prefs);
  });

  it("keeps fields the patch doesn't mention", () => {
    const current = { readFromPedalConfirmed: true, unsavedGuard: false };
    expect(parsePrefs(serializePrefs(current, {}))).toEqual(current);
  });
});
