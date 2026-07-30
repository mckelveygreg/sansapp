import { describe, expect, it } from "vitest";
import {
  BLOCK_SIZE,
  CC_MAP_BLOCK,
  DISENGAGE_POTS_INVERSE_OFFSET,
  isSettingOn,
  parsePcMap,
  SETTINGS_MARKER,
  SPECIAL_FN_OFFSETS,
  SPECIAL_FUNCTIONS,
  TUNER_DETUNE,
  TUNER_HZ_BASE,
  tunerHz,
  tunerHzToByte,
  withDisengagePots,
  withPcMap,
  withSetting,
} from "../src/protocol/settings";

// The live settings block read from the pedal (data block 0), final state from the capture.
const BLOCK0 = (() => {
  const b = new Uint8Array(256);
  b.set([0x7f, 0x01, 0x01, 0x00, 0x01, 0x02, 0x02, 0x01, 0x11, 0x01, 0x02, 0x40, 0x40, 0x40]);
  return b;
})();

describe("settings block", () => {
  it("reads flags at their offsets", () => {
    expect(BLOCK0[0]).toBe(SETTINGS_MARKER);
    expect(isSettingOn(BLOCK0, 7)).toBe(true); // disengage pots (byte 7, confirmed 2026-07-06)
    expect(isSettingOn(BLOCK0, 3)).toBe(false);
  });

  it("withSetting sets one byte without mutating the source", () => {
    const on = withSetting(BLOCK0, 3, 1);
    expect(isSettingOn(on, 3)).toBe(true);
    expect(isSettingOn(BLOCK0, 3)).toBe(false);
    expect(withSetting(BLOCK0, 5, 7)[5]).toBe(7); // MIDI channel 7
    expect(on).toHaveLength(BLOCK_SIZE);
  });

  it("withDisengagePots sets byte 7 and its inverse byte 15 together", () => {
    const dis = withDisengagePots(BLOCK0, true);
    expect(dis[7]).toBe(1);
    expect(dis[DISENGAGE_POTS_INVERSE_OFFSET]).toBe(0);
    const eng = withDisengagePots(BLOCK0, false);
    expect(eng[7]).toBe(0);
    expect(eng[DISENGAGE_POTS_INVERSE_OFFSET]).toBe(1);
  });

  it("all special-function offsets are within the block", () => {
    for (const off of SPECIAL_FN_OFFSETS) {
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(BLOCK_SIZE);
    }
  });
});

describe("special functions decode the captured block", () => {
  const byId = (id: string) => SPECIAL_FUNCTIONS.find((f) => f.id === id)!;

  it("tuner frequency: byte 0x11 → 445 Hz (base 428)", () => {
    expect(TUNER_HZ_BASE).toBe(428);
    expect(tunerHz(BLOCK0[byId("tunerFreq").offset]!)).toBe(445);
    expect(tunerHz(12)).toBe(440); // the standard reference is the baseline
    expect(tunerHzToByte(445)).toBe(0x11);
  });

  it("tuner detune: byte 2 → 'bb'", () => {
    expect(TUNER_DETUNE[BLOCK0[byId("tunerDetune").offset]!]).toBe("bb");
  });

  it("MIDI channel reads the raw channel number (Channel 2)", () => {
    expect(BLOCK0[byId("midiChannel").offset]).toBe(2);
  });

  it("confirmed 2026-07-07 offsets read from the block", () => {
    // MIDI Thru is offset 2 and Preset Protection offset 9 (confirmed by a clean single-toggle
    // capture, 2026-07-07).
    expect(byId("midiThru").offset).toBe(2);
    expect(isSettingOn(BLOCK0, byId("midiThru").offset)).toBe(true);
    expect(byId("presetProtection").offset).toBe(9);
    expect(isSettingOn(BLOCK0, byId("presetProtection").offset)).toBe(true);
    expect(byId("cabinetBypass").offset).toBe(16);
    expect(CC_MAP_BLOCK).toBe(1); // the CC map is still a distinct data block from settings (block 0)
  });

  it("Safe Level / MIDI CC / MIDI Mapping offsets confirmed 2026-07-07", () => {
    // Two clean single-toggle captures: Safe Level Mode = offset 17, MIDI CC Mode = offset 4
    // (writing block 1 = the CC map when on). MIDI Mapping = offset 3 by elimination.
    expect(byId("safeLevelMode").offset).toBe(17);
    expect(byId("safeLevelMode").confidence).toBe("strong");
    expect(byId("midiCcMode").offset).toBe(4);
    expect(byId("midiCcMode").confidence).toBe("strong");
    expect(byId("midiMapping").offset).toBe(3);
  });
});

describe("PC → preset map (block 2)", () => {
  it("round-trips an identity map", () => {
    const identity = Array.from({ length: 128 }, (_, i) => i);
    expect(parsePcMap(withPcMap(new Uint8Array(256), identity))).toEqual(identity);
  });

  it("remaps a single program", () => {
    const block = withPcMap(
      new Uint8Array(256),
      Array.from({ length: 128 }, (_, i) => i),
    );
    const remapped = withPcMap(
      block,
      parsePcMap(block).map((v, i) => (i === 5 ? 42 : v)),
    );
    expect(parsePcMap(remapped)[5]).toBe(42);
    expect(parsePcMap(remapped)[6]).toBe(6);
  });
});
