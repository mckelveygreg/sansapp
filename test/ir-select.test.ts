/**
 * The shared IR display selector (src/protocol/irSelect.ts): which record each of the eight IR-select
 * positions plays for a given preset, and the curve lookup both the IR page and the Tone Shaper feed
 * into `cabResponseAt`.
 *
 * The headline case is sansapp#68 — the cross-preset custom-IR leak. The old model gated on the IR Mode
 * byte and then read a POSITION-keyed cache, so whatever was last pulled into position 7 rendered on
 * every preset whose Mode 7 was on. `#68 is pinned below` marks the tests that fail under that model.
 *
 * The truth this encodes is lab #55's firmware truth table (docs/research/ir-display-truth-table.md):
 * mode OFF → the pointer is never loaded and the pedal plays an unreadable factory-region record, whose
 * only honest curve is the library's byte-identical copy at 256 + (pos − 1); mode ON → the pedal plays
 * whatever record the pointer names, library or private. The pointer's MSB carries no display meaning.
 */
import { describe, expect, it } from "vitest";
import { cabResponseAt } from "../src/dsp/tone";
import {
  LIBRARY_RECORD_BASE,
  type UserIrModes,
  irCurveAt,
  irSourceAt,
  libraryRecordAt,
} from "../src/protocol/irSelect";

/** A 256-byte preset blob carrying slot 7's pointer pair at 0x57/0x58 and slot 8's at 0x59/0x5A. */
function blobWithPairs(p7: [number, number], p8: [number, number] = [64, 64]): Uint8Array {
  const b = new Uint8Array(256);
  [b[0x57], b[0x58]] = p7;
  [b[0x59], b[0x5a]] = p8;
  return b;
}

const BOTH_ON: UserIrModes = { 7: true, 8: true };
const BOTH_OFF: UserIrModes = { 7: false, 8: false };

describe("irSourceAt: position → record", () => {
  it("maps the library positions onto records 256-263, the vendor's NN- numbering minus one", () => {
    expect(libraryRecordAt(1)).toBe(LIBRARY_RECORD_BASE); // 256 = SansAmp = the '01-' cab
    expect(libraryRecordAt(7)).toBe(262); // Voice 12L
    expect(libraryRecordAt(8)).toBe(263); // Brit V30
  });

  it("has no mode byte for positions 1-6: always the library copy of the factory cab", () => {
    const blob = blobWithPairs([2, 4]); // a slot-7 pointer that must not reach positions 1-6
    for (let pos = 1; pos <= 6; pos++) {
      for (const modes of [BOTH_ON, BOTH_OFF]) {
        expect(irSourceAt(blob, pos, modes)).toEqual({
          record: libraryRecordAt(pos),
          kind: "proxy",
        });
      }
    }
  });

  it("follows the pointer on a user slot whose mode is ON — library or private alike", () => {
    const blob = blobWithPairs([2, 4], [1, 4]);
    expect(irSourceAt(blob, 7, BOTH_ON)).toEqual({ record: 260, kind: "played" });
    expect(irSourceAt(blob, 8, BOTH_ON)).toEqual({ record: 132, kind: "played" });
  });

  it("#68 is pinned: a mode-ON row NEVER resolves to its position's library record", () => {
    // 88 of the 128 factory presets point slot 7 at record 260 (Concert 2x15) while the app drew 262
    // (Voice 12L) — the wider mislabelling this ticket fixes alongside the leak.
    const src = irSourceAt(blobWithPairs([2, 4]), 7, BOTH_ON);
    expect(src?.record).toBe(260);
    expect(src?.record).not.toBe(libraryRecordAt(7));
  });

  it("ignores the pointer entirely when the mode is OFF, and proxies from the library instead", () => {
    // The preset carries a private record (5) but its mode is off, so the pedal plays the factory cab
    // at that position — the custom IR is dormant and must not be drawn or named.
    const blob = blobWithPairs([0, 5], [1, 5]);
    expect(irSourceAt(blob, 7, BOTH_OFF)).toEqual({ record: 262, kind: "proxy" });
    expect(irSourceAt(blob, 8, BOTH_OFF)).toEqual({ record: 263, kind: "proxy" });
  });

  it("gates each user slot on its OWN mode byte", () => {
    const blob = blobWithPairs([0, 5], [1, 5]);
    const only7: UserIrModes = { 7: true, 8: false };
    expect(irSourceAt(blob, 7, only7)).toEqual({ record: 5, kind: "played" });
    expect(irSourceAt(blob, 8, only7)).toEqual({ record: 263, kind: "proxy" });
  });

  it("offers nothing at all for a mode-ON slot whose pointer names no real record", () => {
    // The (64,64) sentinel 27 factory presets ship: record 8256, arbitrary flash. The library copy is
    // NOT a fallback here — with the mode on, the factory cab is not what the pedal would play.
    expect(irSourceAt(blobWithPairs([64, 64]), 7, BOTH_ON)).toBeNull();
    // Same for an unrecalled preset: no blob, no pointer, nothing honest to show.
    expect(irSourceAt(null, 7, BOTH_ON)).toBeNull();
    expect(irSourceAt(undefined, 8, BOTH_ON)).toBeNull();
    // …but a mode-OFF row still proxies, because it never needed the pointer.
    expect(irSourceAt(null, 7, BOTH_OFF)).toEqual({ record: 262, kind: "proxy" });
  });

  it("rejects positions outside 1-8 (0 is Off/flat, which has no record)", () => {
    for (const pos of [-1, 0, 9, 1.5, Number.NaN]) {
      expect(irSourceAt(blobWithPairs([2, 0]), pos, BOTH_ON)).toBeNull();
    }
  });
});

describe("irCurveAt: the record-keyed curve lookup both pages share", () => {
  const CURVE = (v: number) => [v, v, v];
  /** A record-keyed cache, exactly the shape irCache.ts persists. */
  const cache: Record<number, number[]> = {
    260: CURVE(-6), // library: Concert 2x15
    262: CURVE(-3), // library: Voice 12L
    5: CURVE(9), // preset 5's private custom IR
    6: CURVE(12), // preset 6's private custom IR
  };
  const dbOf = (r: number) => cache[r];

  it("resolves a mode-ON row through the pointer, not the position", () => {
    const dbAt = irCurveAt(blobWithPairs([2, 4]), BOTH_ON, dbOf);
    expect(dbAt(7)).toEqual(CURVE(-6)); // record 260, what the preset really plays
    expect(dbAt(7)).not.toEqual(CURVE(-3)); // NOT record 262, the position's library cab
  });

  it("answers null for a record that hasn't been read, rather than something else's curve", () => {
    const dbAt = irCurveAt(blobWithPairs([0, 99]), BOTH_ON, dbOf);
    expect(dbAt(7)).toBeNull();
  });

  it("answers null for an unplayable pointer and proxies a mode-OFF row", () => {
    expect(irCurveAt(blobWithPairs([64, 64]), BOTH_ON, dbOf)(7)).toBeNull();
    expect(irCurveAt(blobWithPairs([64, 64]), BOTH_OFF, dbOf)(7)).toEqual(CURVE(-3)); // 262
  });

  it("#68 is pinned: two presets on the same cache render their OWN cabs, never each other's", () => {
    // The exact repro. Both presets have IR Mode 7 on and sit at position 7 (0x0E = 112, where only
    // the lower endpoint sounds); they point at different private records. Under the old
    // position-keyed model both read cache[7] and the second preset showed the first one's upload.
    const flat = CURVE(0);
    const presetFive = blobWithPairs([0, 5]);
    const presetSix = blobWithPairs([0, 6]);
    expect(cabResponseAt(112, irCurveAt(presetFive, BOTH_ON, dbOf), flat)).toEqual(CURVE(9));
    expect(cabResponseAt(112, irCurveAt(presetSix, BOTH_ON, dbOf), flat)).toEqual(CURVE(12));

    // And the sharper half of the same bug: a preset whose own record is UNREAD must draw nothing,
    // not the record that happens to be cached for its neighbour.
    const presetSeven = blobWithPairs([0, 7]);
    expect(cabResponseAt(112, irCurveAt(presetSeven, BOTH_ON, dbOf), flat)).toBeNull();
  });

  it("blends the two endpoints the pedal blends, each resolved on its own row's terms", () => {
    // 0x0E = 120 sits midway between rows 7 and 8. Row 7 is mode-ON (private record 5, +9 dB), row 8
    // is mode-OFF (library proxy 263, unread → null), so the blend falls back to the known side.
    const blob = blobWithPairs([0, 5]);
    const modes: UserIrModes = { 7: true, 8: false };
    expect(cabResponseAt(120, irCurveAt(blob, modes, dbOf), CURVE(0))).toEqual(CURVE(9));

    // With row 8's proxy read, the same position blends 50/50 — the row-8 mode byte never enters it.
    const withProxy = (r: number) => (r === 263 ? CURVE(-1) : cache[r]);
    expect(cabResponseAt(120, irCurveAt(blob, modes, withProxy), CURVE(0))).toEqual(CURVE(4));
  });
});
