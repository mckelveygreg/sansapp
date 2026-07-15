/**
 * Minimal 16-bit PCM WAV read/write — enough to export a generated IR (matching the factory
 * format: mono, 44.1 kHz, 16-bit) and to read a user's WAV back in for blending/tweaking.
 * Stereo input is down-mixed to mono. Framework-free.
 */

export interface WavData {
  samples: Int16Array;
  sampleRate: number;
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Encode mono 16-bit PCM as a WAV byte stream. */
export function encodeWav(samples: Int16Array, sampleRate = 44100): Uint8Array {
  const dataLen = samples.length * 2;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  buf.set(ascii("RIFF"), 0);
  dv.setUint32(4, 36 + dataLen, true);
  buf.set(ascii("WAVE"), 8);
  buf.set(ascii("fmt "), 12);
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  buf.set(ascii("data"), 36);
  dv.setUint32(40, dataLen, true);
  const out = new DataView(buf.buffer, 44);
  for (let i = 0; i < samples.length; i++) out.setInt16(i * 2, samples[i]!, true);
  return buf;
}

const tag = (dv: DataView, off: number): string =>
  String.fromCharCode(
    dv.getUint8(off),
    dv.getUint8(off + 1),
    dv.getUint8(off + 2),
    dv.getUint8(off + 3),
  );

/** Decode a 16-bit PCM WAV (mono, or stereo down-mixed to mono). */
export function decodeWav(bytes: Uint8Array): WavData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(dv, 0) !== "RIFF" || tag(dv, 8) !== "WAVE") throw new Error("not a WAV file");
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  let format = 1; // 1 = PCM int, 3 = IEEE float
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = tag(dv, p);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === "fmt ") {
      format = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOff = body;
      dataLen = size;
    }
    p = body + size + (size & 1); // chunks are word-aligned
  }
  if (dataOff < 0) throw new Error("WAV has no data chunk");
  if (![16, 24, 32].includes(bits)) throw new Error(`unsupported PCM depth ${bits}-bit`);
  const bps = bits / 8;
  const clamp16 = (v: number) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
  const d = new DataView(bytes.buffer, bytes.byteOffset + dataOff);
  // Read one sample at byte `off`, scaled to 16-bit range.
  const read = (off: number): number => {
    if (bits === 16) return d.getInt16(off, true);
    if (bits === 24) {
      const u = d.getUint8(off) | (d.getUint8(off + 1) << 8) | (d.getUint8(off + 2) << 16);
      return (u & 0x800000 ? u - 0x1000000 : u) >> 8; // sign-extend, 24→16
    }
    return format === 3
      ? clamp16(Math.round(d.getFloat32(off, true) * 32767)) // float32 → 16-bit
      : d.getInt32(off, true) >> 16; // int32 → 16
  };
  const frames = Math.floor(dataLen / bps / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    if (channels === 1) out[i] = read(i * bps);
    else {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += read((i * channels + c) * bps);
      out[i] = Math.round(sum / channels);
    }
  }
  return { samples: out, sampleRate };
}

/** Quantize a float signal ([-1, 1], peak-normalized to `peak`) to 16-bit PCM for WAV export. */
export function floatToPcm(samples: ArrayLike<number>, peak = 0.98): Int16Array {
  let max = 0;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]!));
  const scale = (max > 0 ? peak / max : 1) * 32767;
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * scale)));
  }
  return out;
}
