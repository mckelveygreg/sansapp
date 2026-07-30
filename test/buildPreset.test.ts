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

const DYN = {
  gateThreshold: 10,
  gateRatio: 20,
  gateRelease: 30,
  compOutput: 40,
  compAttack: 50,
  compRelease: 60,
  autoGain: true,
  lookahead: false,
};

describe("buildPresetBlob", () => {
  it("overlays modeled param edits at their blob offsets", () => {
    const blob = buildPresetBlob(makeBase(), { drive: 100, level: 50 }, "TEST", DYN, {
      type: -1,
      decay: 0,
      time: 0,
    });
    expect(blob).toHaveLength(PRESET_SIZE);
    expect(blob[PARAMS.drive.blobOffset]).toBe(100);
    expect(blob[PARAMS.level.blobOffset]).toBe(50);
  });

  it("writes the name and preserves unmodeled bytes from the base", () => {
    const blob = buildPresetBlob(makeBase(), {}, "MY TONE", DYN, { type: -1, decay: 0, time: 0 });
    expect(String.fromCharCode(...blob.slice(NAME_OFFSET, NAME_OFFSET + 7))).toBe("MY TONE");
    expect(blob[0xe5]).toBe(0xab); // opaque IR-tail byte untouched
    expect(blob[0]).toBe(0x01); // header untouched
  });

  it("takes deep params from the dynamics snapshot, not pedalStore.values", () => {
    // pedalStore.values is stale for these after an edit — the snapshot must win.
    const blob = buildPresetBlob(makeBase(), { gateThreshold: 99, autoGain: 0 }, "X", DYN, {
      type: -1,
      decay: 0,
      time: 0,
    });
    expect(blob[PARAMS.gateThreshold.blobOffset]).toBe(10); // from DYN, not the stale 99
    expect(blob[PARAMS.autoGain.blobOffset]).toBe(1); // DYN.autoGain true → 1
    expect(blob[PARAMS.lookahead.blobOffset]).toBe(0); // DYN.lookahead false → 0
  });

  it("bakes the ambience type profile, then overlays decay/time on top", () => {
    const hall = AMBIENCE_BUNDLES[1]!; // [64, 8, 2, 64, 127, 64, 64, 20, 4, 127]
    const blob = buildPresetBlob(makeBase(), {}, "X", DYN, { type: 1, decay: 42, time: 77 });
    // A profile byte that ISN'T decay/time comes straight from the Hall bundle (0x34 = bundle[1]).
    expect(blob[0x34]).toBe(hall[1]);
    expect(blob[0x5d]).toBe(hall[9]);
    // ambienceTime (0x32 = Room Size) and ambienceDecay (0x33 = Decay Time) override with store values.
    expect(blob[PARAMS.ambienceTime.blobOffset]).toBe(77);
    expect(blob[PARAMS.ambienceDecay.blobOffset]).toBe(42);
  });

  it("leaves the base ambience profile alone for a custom type (-1)", () => {
    const base = makeBase();
    base[0x34] = 111; // a custom profile byte (0x34 isn't overlaid by decay/time)
    const blob = buildPresetBlob(base, {}, "X", DYN, { type: -1, decay: 5, time: 6 });
    expect(blob[0x34]).toBe(111); // not baked over
  });

  it("round-trips: decoding the built blob yields the edited values", () => {
    const blob = buildPresetBlob(makeBase(), { drive: 77 }, "RT", DYN, {
      type: -1,
      decay: 0,
      time: 0,
    });
    const p = decodePreset(blob);
    expect(p.name).toBe("RT");
    expect(p.values.drive).toBe(77);
    expect(p.values.gateThreshold).toBe(10);
  });
});
