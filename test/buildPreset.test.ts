import { describe, expect, it } from "vitest";
import { AMBIENCE_BUNDLES } from "../src/protocol/ambience";
import { buildPresetBlob } from "../src/protocol/buildPreset";
import { NAME_OFFSET, PRESET_SIZE } from "../src/protocol/constants";
import { PARAMS } from "../src/protocol/params";
import { decodePreset } from "../src/protocol/preset";

function makeBase(): Uint8Array {
  const b = new Uint8Array(PRESET_SIZE);
  b[0] = 0x01; // header
  b[0xe5] = 0xab; // sentinel in the opaque IR tail (unmodeled) — must survive
  return b;
}

describe("buildPresetBlob", () => {
  it("overlays modeled param edits at their blob offsets", () => {
    const blob = buildPresetBlob(makeBase(), { drive: 100, level: 50 }, "TEST", null);
    expect(blob).toHaveLength(PRESET_SIZE);
    expect(blob[PARAMS.drive.blobOffset]).toBe(100);
    expect(blob[PARAMS.level.blobOffset]).toBe(50);
  });

  it("writes the name and preserves unmodeled bytes from the base", () => {
    const blob = buildPresetBlob(makeBase(), {}, "MY TONE", null);
    expect(String.fromCharCode(...blob.slice(NAME_OFFSET, NAME_OFFSET + 7))).toBe("MY TONE");
    expect(blob[0xe5]).toBe(0xab); // opaque IR-tail byte untouched
    expect(blob[0]).toBe(0x01); // header untouched
  });

  it("takes gate/comp params straight from the values map (no separate snapshot)", () => {
    // The gate/comp block is store-backed now — the values map is the single source of truth, so the
    // exact bytes it carries land in the blob (no dynamics-store override to overwrite live edits).
    const blob = buildPresetBlob(
      makeBase(),
      { gateThreshold: 10, gateRelease: 30, compOutput: 40, autoGain: 1, lookahead: 0 },
      "X",
      null,
    );
    expect(blob[PARAMS.gateThreshold.blobOffset]).toBe(10);
    expect(blob[PARAMS.gateRelease.blobOffset]).toBe(30);
    expect(blob[PARAMS.compOutput.blobOffset]).toBe(40);
    expect(blob[PARAMS.autoGain.blobOffset]).toBe(1);
    expect(blob[PARAMS.lookahead.blobOffset]).toBe(0);
  });

  it("bakes the ambience type profile when a type is applied; decay/time from values win on top", () => {
    const hall = AMBIENCE_BUNDLES[1]!; // [64, 8, 2, 64, 127, 64, 64, 20, 4, 127]
    const blob = buildPresetBlob(makeBase(), { ambienceDecay: 42, ambienceTime: 77 }, "X", 1);
    // A profile byte that ISN'T decay/time comes straight from the Hall bundle (0x34 = bundle[1]).
    expect(blob[0x34]).toBe(hall[1]);
    expect(blob[0x5d]).toBe(hall[9]);
    // ambienceTime (0x32 = Room Size, a profile offset) + ambienceDecay (0x33) override with the
    // values-map bytes (the Time knob value must win over the type default).
    expect(blob[PARAMS.ambienceTime.blobOffset]).toBe(77);
    expect(blob[PARAMS.ambienceDecay.blobOffset]).toBe(42);
  });

  it("preserves the base ambience profile when no type was applied (null)", () => {
    const base = makeBase();
    base[0x34] = 111; // a hand-tuned profile byte (0x34 isn't overlaid by decay/time)
    const blob = buildPresetBlob(base, { ambienceDecay: 5, ambienceTime: 6 }, "X", null);
    expect(blob[0x34]).toBe(111); // NOT normalized back to a canonical default
    // decay/time still come from the values map even with the profile preserved.
    expect(blob[PARAMS.ambienceTime.blobOffset]).toBe(6);
    expect(blob[PARAMS.ambienceDecay.blobOffset]).toBe(5);
  });

  it("captures the newly-modeled IR mode + Preset Level; absent leaves the base byte intact", () => {
    const base = makeBase();
    base[PARAMS.irMode7.blobOffset] = 0; // 0x4a — IR mode 7 off in the base
    base[PARAMS.presetLevel.blobOffset] = 100; // 0x62 — base preset level
    const blob = buildPresetBlob(base, { irMode7: 1, presetLevel: 14 }, "X", null);
    expect(blob[PARAMS.irMode7.blobOffset]).toBe(1);
    expect(blob[PARAMS.presetLevel.blobOffset]).toBe(14);
    // With no values for them, the base bytes survive (silent-revert bug fixed by modeling them).
    const untouched = buildPresetBlob(base, {}, "X", null);
    expect(untouched[PARAMS.presetLevel.blobOffset]).toBe(100);
    expect(untouched[PARAMS.irMode7.blobOffset]).toBe(0);
  });

  it("writes the Red Zone enables straight from `values` — a stale mirror reaches the blob", () => {
    // Characterization of a KNOWN, deliberate exposure (lab #52). The red footswitch's long-hold runs
    // the Red-Zone toggle twice, announcing only the first half, so pedalStore.values can hold effect
    // enables the pedal has already reverted. Nothing distinguishes that from a genuine stomp and
    // there is no live-param read-back, so a save taken before the next preset change persists the
    // announced half — which is what the shipped mirror was chosen to do ("save what the pedal is
    // doing"). If that trade is ever reversed (source these two from the base blob unless the user
    // touched them in the app), THIS is the assertion that must flip.
    const base = makeBase();
    base[PARAMS.autoFilterOn.blobOffset] = 0; // the loaded preset had both effects off…
    base[PARAMS.chorusOn.blobOffset] = 0;
    const blob = buildPresetBlob(base, { autoFilterOn: 1, chorusOn: 1 }, "X", null);
    expect(blob[PARAMS.autoFilterOn.blobOffset]).toBe(1); // …the mirror wins
    expect(blob[PARAMS.chorusOn.blobOffset]).toBe(1);
  });

  it("round-trips: decoding the built blob yields the edited values", () => {
    const blob = buildPresetBlob(makeBase(), { drive: 77, gateThreshold: 10 }, "RT", null);
    const p = decodePreset(blob);
    expect(p.name).toBe("RT");
    expect(p.values.drive).toBe(77);
    expect(p.values.gateThreshold).toBe(10);
  });
});
