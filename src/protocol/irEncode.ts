/**
 * User-IR encoder — generate a custom IR upload for the pedal from float samples.
 *
 * The on-wire format is a simple, lossless, time-domain encoding, verified byte-exact against real
 * hardware uploads:
 *
 *   1. IR samples → 2400 × int8, `s = clamp(round(x · 127), -128, 127)` (time-domain, `IR_SAMPLES`).
 *   2. gain (RMS makeup) = `min(1, 1.2 / (√2 · √energy))`, `energy = Σ (s/127)²`; stored ×32768 (u16 LE).
 *   3. `.dat` (2436 B): `01 00` · gain(u16) · name(32 B ASCII, space-padded) · the 2400 int8 samples.
 *   4. wire = 5-byte header (`<a> <b> 00 15 61`, the slot address) + **7-bit bitstream pack** of the
 *      `.dat` (8→7 bits, MSB-first) + a **3-byte trailer** `00`·`(Σpacked>>7)&0x7f`·`Σpacked&0x7f`
 *      (a checksum the pedal validates — see {@link irWireTrailer}).
 *   5. framed as `05 60` begin (5-byte header + first 256 packed) · nine `05 65` chunks (256) · `05 66`.
 *
 * Verified byte-exact (8/8) against captured real uploads, including the trailer checksum. NOTE on
 * level: the makeup `gain` (step 2) is derived from the int8 samples, which can differ from the
 * desktop editor's level for a real cab (it computes energy on the raw pre-normalized samples) — this
 * affects playback LEVEL only, not whether the upload is accepted; the pedal's per-slot IR gain
 * compensates. Feed {@link buildIrUpload} frames to {@link uploadIr}. Framework-free.
 */
import { SYSEX_PREFIX } from "./constants";

export const IR_SAMPLES = 2400; // int8 time-domain samples in a user IR
export const IR_DAT_SIZE = 2436; // 01 00 + gain(2) + name(32) + 2400 samples
const NAME_OFFSET = 4;
const NAME_LEN = 32;
const DATA_OFFSET = 36;

/** Quantize float IR samples ([-1,1]) to the pedal's 2400 × int8 (pad/truncate to IR_SAMPLES). */
export function toInt8Samples(samples: ArrayLike<number>): Int8Array {
  const out = new Int8Array(IR_SAMPLES);
  const n = Math.min(samples.length, IR_SAMPLES);
  for (let i = 0; i < n; i++) {
    out[i] = Math.max(-128, Math.min(127, Math.round(samples[i]! * 127)));
  }
  return out;
}

/** RMS makeup gain EliteControl stores: min(1, 1.2/(√2·√energy)), energy = Σ(s/127)². */
export function irGain(int8: Int8Array): number {
  let energy = 0;
  for (const s of int8) {
    const x = s / 127;
    energy += x * x;
  }
  if (energy <= 0) return 1;
  return Math.min(1, 1.2 / (Math.SQRT2 * Math.sqrt(energy)));
}

/** Build the 2436-byte user-IR `.dat` (the local file / pre-pack payload). */
export function encodeIrDat(int8: Int8Array, name: string): Uint8Array {
  const dat = new Uint8Array(IR_DAT_SIZE);
  dat[0] = 0x01;
  dat[1] = 0x00;
  const g = Math.round(irGain(int8) * 32768);
  dat[2] = g & 0xff;
  dat[3] = (g >> 8) & 0xff;
  dat.fill(0x20, NAME_OFFSET, NAME_OFFSET + NAME_LEN); // space-padded name field
  for (let i = 0; i < Math.min(name.length, NAME_LEN); i++)
    dat[NAME_OFFSET + i] = name.charCodeAt(i) & 0x7f;
  for (let i = 0; i < IR_SAMPLES; i++) dat[DATA_OFFSET + i] = int8[i]! & 0xff;
  return dat;
}

/** Pack 8-bit bytes into a 7-bit MIDI-safe bitstream (MSB-first). Inverse of {@link unpackIrStream}. */
export function pack7Stream(bytes: Uint8Array): Uint8Array {
  const totalBits = bytes.length * 8;
  const out = new Uint8Array(Math.ceil(totalBits / 7));
  for (let bit = 0; bit < totalBits; bit++) {
    if ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1) out[(bit / 7) | 0]! |= 1 << (6 - (bit % 7));
  }
  return out;
}

/** Inverse of {@link pack7Stream}: 7-bit bitstream → 8-bit bytes (for decoding a captured upload). */
export function unpackIrStream(packed: Uint8Array): Uint8Array {
  const totalBits = packed.length * 7;
  const out = new Uint8Array(Math.floor(totalBits / 8));
  for (let bit = 0; bit < out.length * 8; bit++) {
    if ((packed[(bit / 7) | 0]! >> (6 - (bit % 7))) & 1) out[bit >> 3]! |= 1 << (7 - (bit & 7));
  }
  return out;
}

/** Decoded user/factory IR: name, RMS makeup gain (0..1), and the 2400 time-domain samples ([-1,1]). */
export interface DecodedIr {
  name: string;
  gain: number;
  samples: Float32Array;
}

/** Parse a 2436-byte IR `.dat` (inverse of {@link encodeIrDat}) — e.g. after decoding a pedal read. */
export function decodeIrDat(dat: Uint8Array): DecodedIr {
  const gain = (dat[2]! | (dat[3]! << 8)) / 32768;
  const name = String.fromCharCode(...dat.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LEN)).trimEnd();
  const samples = new Float32Array(IR_SAMPLES);
  for (let i = 0; i < IR_SAMPLES; i++)
    samples[i] = (((dat[DATA_OFFSET + i]! << 24) >> 24) as number) / 127;
  return { name, gain, samples };
}

/**
 * Reassemble + decode a captured/read IR upload stream (the concatenated `05 60`/`05 65`/`05 66`
 * packed bodies, WITH the 5-byte header — `00 00 00 15 61` for a write, `<a> <b> 00 15 61` for a
 * `05 69` read reply). Returns the IR, or null if it doesn't unpack to a valid `01 00` `.dat`.
 */
export function decodeIrStream(packedWithHeader: Uint8Array): DecodedIr | null {
  const dat = unpackIrStream(packedWithHeader.subarray(5)); // skip the 5-byte upload header
  if (dat.length < IR_DAT_SIZE || dat[0] !== 0x01 || dat[1] !== 0x00) return null;
  return decodeIrDat(dat.subarray(0, IR_DAT_SIZE));
}

const sysex = (sub: number, body: Uint8Array): Uint8Array =>
  Uint8Array.of(...SYSEX_PREFIX, 0x05, sub, 0x0a, ...body, 0xf7);

/**
 * Wire trailer appended after the packed `.dat`: `00`, then a 14-bit sum of the packed bytes split
 * MSB-first into two 7-bit bytes (`(sum>>7)&0x7f`, `sum&0x7f`). Verified 8/8 against captured real
 * uploads. The pedal validates this — without it the upload's end frame is never acked and nothing
 * is written.
 */
export function irWireTrailer(packed: Uint8Array): Uint8Array {
  let sum = 0;
  for (const b of packed) sum += b;
  return Uint8Array.of(0x00, (sum >> 7) & 0x7f, sum & 0x7f);
}

/**
 * Build the `[begin, ...chunks, end]` SysEx frames for a user IR from float samples. Pass to
 * {@link uploadIr}. `name` is stored in the IR (≤32 chars). The wire is
 * `header(5) + pack7Stream(.dat) + trailer(3)` (see {@link irWireTrailer}).
 *
 * `target` = the `[a, b]` address in the 5-byte header (`a b 00 15 61`), same scheme as the `05 69`
 * read selector: `[0x02, slot]` writes IR library slot `slot` (0-based), `[0x00, 0x7f]` = the live
 * edit-buffer IR (EliteControl's Import path). Default `[0x00, 0x00]`.
 */
export function buildIrUpload(
  samples: ArrayLike<number>,
  name: string,
  target: readonly [number, number] = [0x00, 0x00],
): Uint8Array[] {
  const dat = encodeIrDat(toInt8Samples(samples), name);
  const packed = pack7Stream(dat);
  const header = [target[0] & 0x7f, target[1] & 0x7f, 0x00, 0x15, 0x61];
  const stream = new Uint8Array([...header, ...packed, ...irWireTrailer(packed)]);
  const frames: Uint8Array[] = [];
  frames.push(sysex(0x60, stream.subarray(0, 261))); // begin: 5-byte header + first 256 packed
  for (let off = 261; off < stream.length; off += 256) {
    const slice = stream.subarray(off, Math.min(off + 256, stream.length));
    frames.push(sysex(off + 256 < stream.length ? 0x65 : 0x66, slice)); // chunks, last = end
  }
  return frames;
}
