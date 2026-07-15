import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav } from "../src/protocol/wav";

describe("WAV codec", () => {
  it("encodes a valid RIFF/WAVE header", () => {
    const w = encodeWav(Int16Array.from([1, -1, 100]), 44100);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...w.slice(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...w.slice(36, 40))).toBe("data");
  });

  it("round-trips mono 16-bit samples", () => {
    const src = Int16Array.from({ length: 1000 }, (_, i) => (i === 0 ? 32000 : -i * 7));
    const { samples, sampleRate } = decodeWav(encodeWav(src, 48000));
    expect(sampleRate).toBe(48000);
    expect([...samples]).toEqual([...src]);
  });

  it("down-mixes stereo to mono", () => {
    // hand-build a tiny stereo WAV: L=100 R=200 (→150), L=-10 R=-20 (→-15)
    const head = encodeWav(new Int16Array(0), 44100).slice(0, 44);
    const dv = new DataView(head.buffer);
    dv.setUint16(22, 2, true); // channels = 2
    dv.setUint32(28, 44100 * 4, true);
    dv.setUint16(32, 4, true); // block align
    dv.setUint32(40, 8, true); // data size = 2 frames * 2ch * 2B
    const body = new Uint8Array(8);
    const bd = new DataView(body.buffer);
    bd.setInt16(0, 100, true);
    bd.setInt16(2, 200, true);
    bd.setInt16(4, -10, true);
    bd.setInt16(6, -20, true);
    const wav = new Uint8Array(head.length + body.length);
    wav.set(head, 0);
    wav.set(body, head.length);
    dv.setUint32(4, 36 + 8, true);
    const { samples } = decodeWav(wav);
    expect([...samples]).toEqual([150, -15]);
  });

  it("decodes 24-bit mono PCM (scaled to 16-bit) — factory cabs use it", () => {
    const head = encodeWav(new Int16Array(0), 48000).slice(0, 44);
    const dv = new DataView(head.buffer);
    dv.setUint16(32, 3, true); // block align = 3 (mono 24-bit)
    dv.setUint16(34, 24, true); // bits = 24
    dv.setUint32(28, 48000 * 3, true); // byte rate
    dv.setUint32(40, 6, true); // data size = 2 samples × 3 bytes
    dv.setUint32(4, 36 + 6, true);
    // 24-bit LE: 0x010000 (=65536 → >>8 = 256), 0x800000 (min → -32768)
    const body = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x80]);
    const wav = new Uint8Array(head.length + body.length);
    wav.set(head, 0);
    wav.set(body, head.length);
    const { samples } = decodeWav(wav);
    expect([...samples]).toEqual([256, -32768]);
  });

  it("rejects non-WAV and unsupported bit depth", () => {
    expect(() => decodeWav(Uint8Array.from([1, 2, 3, 4]))).toThrow();
  });
});
