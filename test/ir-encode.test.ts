import { describe, expect, it } from "vitest";
import {
  IR_DAT_SIZE,
  IR_SAMPLES,
  buildIrUpload,
  decodeIrDat,
  decodeIrStream,
  encodeIrDat,
  irGain,
  irWireTrailer,
  pack7Stream,
  peakNormalize,
  toInt8Samples,
  unpackIrStream,
} from "../src/protocol/irEncode";

// Verified 2026-07-14: the user-IR wire is the time-domain .dat, 7-bit packed.
// Verified byte-exact vs real hardware for the amplitude-ladder probes; these tests lock the codec.
describe("user-IR encoder", () => {
  it("7-bit pack/unpack is a lossless bijection (the wire codec)", () => {
    for (const seed of [0, 1, 42, 255]) {
      const bytes = new Uint8Array(IR_DAT_SIZE);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
      const packed = pack7Stream(bytes);
      expect(packed.every((b) => b < 0x80)).toBe(true); // MIDI 7-bit-clean
      expect([...unpackIrStream(packed).subarray(0, bytes.length)]).toEqual([...bytes]);
    }
  });

  it("encodeIrDat has the verified layout: 01 00 · gain(u16) · name(32) · 2400 int8", () => {
    const int8 = toInt8Samples([1, 0.5, -0.25]);
    const dat = encodeIrDat(int8, "MyHPF Cab");
    expect(dat.length).toBe(IR_DAT_SIZE);
    expect([dat[0], dat[1]]).toEqual([0x01, 0x00]);
    expect(String.fromCharCode(...dat.subarray(4, 13))).toBe("MyHPF Cab");
    expect(dat[13]).toBe(0x20); // space-padded name
    expect(dat[36]).toBe(127); // first sample: round(1 * 127)
    expect(dat[37]).toBe(64); // round(0.5 * 127) = 64 (as unsigned byte)
    expect((dat[38]! << 24) >> 24).toBe(-32); // round(-0.25 * 127), signed
  });

  it("gain field targets factory loudness: gainField × RMS ≈ 0.18, clamped ≤ 1", () => {
    // A dense signal (RMS 0.3) is attenuated to hit the factory target ≈0.18.
    const dense = toInt8Samples(Array.from({ length: IR_SAMPLES }, () => 0.3)); // int8 38 → RMS ≈ 0.299
    const g = irGain(dense);
    const rms = Math.sqrt([...dense].reduce((a, s) => a + (s / 127) ** 2, 0) / dense.length);
    expect(g).toBeCloseTo(0.18 / rms, 3); // = FACTORY_IR_LOUDNESS / RMS
    expect(g * rms).toBeCloseTo(0.18, 3); // the effective playback loudness we match
    // A near-delta source (tiny RMS over 2400 taps) can't be boosted past 1.0 — clamps.
    expect(irGain(toInt8Samples([1]))).toBe(1);
    expect(irGain(toInt8Samples([0.25]))).toBe(1);
  });

  it("buildIrUpload frames match the pedal's structure (05 60 + 9×05 65 + 05 66)", () => {
    const frames = buildIrUpload(
      Array.from({ length: IR_SAMPLES }, (_, i) => Math.sin(i / 4)),
      "sweep",
    );
    expect(frames.length).toBe(11);
    const sub = (f: Uint8Array) => f[5];
    expect(sub(frames[0]!)).toBe(0x60);
    expect(frames.slice(1, -1).every((f) => sub(f) === 0x65)).toBe(true);
    expect(sub(frames.at(-1)!)).toBe(0x66);
    // every frame is F0 00 51 21 05 <sub> 0A … F7 and 7-bit-clean between header and F7
    for (const f of frames) {
      expect([f[0], f[1], f[2], f[3], f[4], f[6]]).toEqual([0xf0, 0x00, 0x51, 0x21, 0x05, 0x0a]);
      expect(f.at(-1)).toBe(0xf7);
      expect(f.subarray(7, -1).every((b) => b < 0x80)).toBe(true);
    }
    // begin carries the 5-byte upload header 00 00 00 15 61
    expect([...frames[0]!.subarray(7, 12)]).toEqual([0x00, 0x00, 0x00, 0x15, 0x61]);
  });

  it("uses EliteControl's edit-buffer import header [0x00, 0x7F] (issue #37, captures/ir-save.jsonl)", () => {
    // The app's custom-IR import targets the edit-buffer IR exactly as EliteControl does — NOT the
    // raw library bank [0x02, slot-1], which could brick the connect handshake.
    const frames = buildIrUpload(
      Array.from({ length: IR_SAMPLES }, () => 0.05),
      "editbuf",
      [0x00, 0x7f],
    );
    expect([...frames[0]!.subarray(7, 12)]).toEqual([0x00, 0x7f, 0x00, 0x15, 0x61]);
  });

  it("targets a slot in the header and appends the 14-bit packed-sum checksum (hardware-verified)", () => {
    // target library slot 3 (0-based 2) → header [0x02, 0x02, 00 15 61]
    const frames = buildIrUpload(
      Array.from({ length: IR_SAMPLES }, () => 0.1),
      "cab",
      [0x02, 0x02],
    );
    expect([...frames[0]!.subarray(7, 12)]).toEqual([0x02, 0x02, 0x00, 0x15, 0x61]);
    // reassemble the wire body (drop each frame's F0 00 51 21 05 <sub> 0A prefix and trailing F7)
    const wire: number[] = [];
    for (const f of frames) wire.push(...f.subarray(7, -1));
    const packed = wire.slice(5, -3); // between the 5-byte header and the 3-byte trailer
    // trailer = 00 · (Σpacked>>7)&0x7f · Σpacked&0x7f — the checksum the pedal validates
    expect(wire.slice(-3)).toEqual([...irWireTrailer(Uint8Array.from(packed))]);
    const sum = packed.reduce((a, b) => a + b, 0);
    expect(wire.slice(-2)).toEqual([(sum >> 7) & 0x7f, sum & 0x7f]);
  });

  it("decodeIrDat / decodeIrStream recover the name, gain, and samples (for pedal reads)", () => {
    const src = Array.from({ length: IR_SAMPLES }, (_, i) => Math.cos(i / 5) * 0.4);
    const int8 = toInt8Samples(src);
    const dat = encodeIrDat(int8, "PulledCab");
    const d = decodeIrDat(dat);
    expect(d.name).toBe("PulledCab");
    expect(d.gain).toBeCloseTo(irGain(int8), 4); // decoded gain matches what was encoded
    expect(Math.round(d.samples[0]! * 127)).toBe(int8[0]);
    // decodeIrStream: prepend the 5-byte header, pack, then decode (mirrors a 05 69 read reply)
    const stream = new Uint8Array([0x02, 0x04, 0x00, 0x15, 0x61, ...pack7Stream(dat)]);
    const back = decodeIrStream(stream);
    expect(back?.name).toBe("PulledCab");
    expect([...toInt8Samples(back!.samples)]).toEqual([...int8]);
  });

  it("peakNormalize scales to unit peak, preserving shape (and no-ops on silence)", () => {
    const scaled = peakNormalize([0.1, -0.05, 0.02]);
    expect(Math.max(...[...scaled].map(Math.abs))).toBeCloseTo(1, 6);
    expect(scaled[1]! / scaled[0]!).toBeCloseTo(-0.5, 6); // ratios (shape) unchanged
    expect([...peakNormalize([0, 0, 0])]).toEqual([0, 0, 0]); // silence stays silence
  });

  it("a built upload plays at factory loudness: gainField × RMS ≈ 0.18 for a real cab", () => {
    // A dense cab-like source at a QUIET level (peak 0.1) — the exact case the old formula left ~10×
    // too quiet. buildIrUpload peak-normalizes then sets the makeup gain, so the decoded IR lands on
    // the factory target.
    const cab = Array.from({ length: IR_SAMPLES }, (_, i) => Math.sin(i / 3) * 0.1);
    const frames = buildIrUpload(cab, "cab", [0x00, 0x7f]);
    // reassemble the packed bodies (skip the 7-byte SysEx head F0..0A and the F7 tail) and decode
    const packed = frames.flatMap((f) => [...f.subarray(7, -1)]);
    const ir = decodeIrStream(Uint8Array.from(packed))!;
    const rms = Math.sqrt([...ir.samples].reduce((a, x) => a + x * x, 0) / ir.samples.length);
    expect(ir.gain * rms).toBeCloseTo(0.18, 2); // matches the measured factory-cab cluster
  });

  it("round-trips a designed IR back to its samples (decode(encode) == input int8)", () => {
    const src = Array.from({ length: IR_SAMPLES }, (_, i) => (i === 3 ? 1 : Math.cos(i / 8) * 0.3));
    const int8 = toInt8Samples(src);
    const dat = encodeIrDat(int8, "rt");
    const back = unpackIrStream(pack7Stream(dat)).subarray(36, 36 + IR_SAMPLES);
    expect([...back].map((b) => (b << 24) >> 24)).toEqual([...int8]);
  });
});
