import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRESET_SIZE } from "../src/protocol/constants";
import { PARAMS } from "../src/protocol/params";
import { decodePreset, encodePreset, withName, withValue } from "../src/protocol/preset";

/** Build a structurally-valid 256-byte preset blob (not real Tech 21 data). */
function synthetic(name: string, seed: number): Uint8Array {
  const b = new Uint8Array(PRESET_SIZE);
  b[0] = 0x01;
  b[1] = 0x00;
  for (let i = 0; i < 32; i++) b[0x02 + i] = i < name.length ? name.charCodeAt(i) : 0x20;
  for (let o = 0x22; o < 0x6c; o++) b[o] = (o * 7 + seed) & 0x7f; // param region
  const ir = "TEST_SPKR";
  for (let i = 0; i < 32; i++) b[0xc0 + i] = i < ir.length ? ir.charCodeAt(i) : 0x20;
  for (let o = 0xe0; o < 0x100; o++) b[o] = (o + seed) & 0x7f; // ir tail
  return b;
}

describe("preset codec", () => {
  it("round-trips synthetic blobs byte-for-byte", () => {
    for (let s = 0; s < 20; s++) {
      const blob = synthetic(`Preset ${s}`, s);
      expect(encodePreset(decodePreset(blob))).toEqual(blob);
    }
  });

  it("reads header, name and IR name", () => {
    const p = decodePreset(synthetic("My Tone", 3));
    expect(p.name).toBe("My Tone");
    expect(p.irName).toBe("TEST_SPKR");
    expect(p.raw[0]).toBe(0x01);
  });

  it("rejects wrong-size blobs", () => {
    expect(() => decodePreset(new Uint8Array(255))).toThrow();
  });

  it("editing one param changes only that byte", () => {
    const off = PARAMS.drive.blobOffset;
    const blob = synthetic("Edit", 1);
    const edited = encodePreset(withValue(decodePreset(blob), "drive", 100));
    const diff = [...blob].flatMap((b, i) => (b !== edited[i] ? [i] : []));
    expect(diff).toEqual([off]);
    expect(edited[off]).toBe(100);
  });

  it("renaming changes only the name region", () => {
    const blob = synthetic("Old", 5);
    const edited = encodePreset(withName(decodePreset(blob), "New Name"));
    for (let i = 0x22; i < PRESET_SIZE; i++) expect(edited[i]).toBe(blob[i]); // params + IR untouched
    expect(edited[0]).toBe(0x01);
  });
});

// Real factory presets live only on a Mac that has run EliteControl; skipped in CI.
const REAL_DIR = join(
  homedir(),
  "Library/Containers/com.Tech21USA.app.EliteControl/Data/Library/Application Support/EliteControl/Presets",
);

describe.skipIf(!existsSync(REAL_DIR))("real factory presets (local only)", () => {
  it("round-trips all factory .dat files byte-for-byte", () => {
    const files = readdirSync(REAL_DIR).filter((f) => f.endsWith(".dat"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const blob = new Uint8Array(readFileSync(join(REAL_DIR, f)));
      expect(encodePreset(decodePreset(blob)), `round-trip ${f}`).toEqual(blob);
    }
  }, 30_000); // reads 128 files; generous timeout so it's not flaky under load
});
