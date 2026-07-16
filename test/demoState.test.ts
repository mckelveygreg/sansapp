import { describe, expect, it } from "vitest";
import { detectAmpModel } from "../src/protocol/amp";
import { PARAMS, type ParamId } from "../src/protocol/params";
import { DEMO_NAMES, DEMO_SLOT, DEMO_VALUES } from "../src/state/demoState";

describe("demo screenshot state", () => {
  it("defines a value for every parameter, all within the wire range", () => {
    for (const id of Object.keys(PARAMS) as ParamId[]) {
      const v = DEMO_VALUES[id];
      expect(v, id).toBeTypeOf("number");
      expect(v, id).toBeGreaterThanOrEqual(PARAMS[id].min);
      expect(v, id).toBeLessThanOrEqual(PARAMS[id].max);
    }
  });

  it("is voiced so the Amp page fingerprints a factory model", () => {
    // The Amp page rebuilds a blob from values[id] at each param's blobOffset, then detectAmpModel().
    const blob = new Uint8Array(0x63);
    for (const id of Object.keys(PARAMS) as ParamId[]) {
      blob[PARAMS[id].blobOffset] = DEMO_VALUES[id] & 0x7f;
    }
    expect(detectAmpModel(blob)).toBe("VT Bass");
  });

  it("names the active demo slot", () => {
    expect(DEMO_NAMES[DEMO_SLOT]).toBeTruthy();
  });
});
