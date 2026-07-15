/**
 * Byte/hex helpers and MIDI 7-bit packing.
 *
 * Framework-free: no React/React Native imports (see .oxlintrc.json boundary rule).
 */

/** Format bytes as uppercase hex, space-separated by default (e.g. "F0 00 51 21 F7"). */
export function bytesToHex(bytes: Uint8Array | readonly number[], sep = " "): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

/** Parse hex ("F0 00 51 21", "f0,00", or "F00051") into bytes. Throws on invalid input. */
export function hexToBytes(hex: string): Uint8Array {
  const tokens = hex
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const parts =
    tokens.length > 1 ? tokens : (hex.replace(/[^0-9a-fA-F]/g, "").match(/.{1,2}/g) ?? []);
  return Uint8Array.from(
    parts.map((t) => {
      const n = Number.parseInt(t, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xff) throw new RangeError(`invalid hex byte: "${t}"`);
      return n;
    }),
  );
}

/**
 * MIDI Association 7-bit packing: every group of 7 data bytes becomes 8 bytes —
 * a leading byte holding the seven high bits, followed by the seven low-7-bit values.
 * Used to carry arbitrary 8-bit payloads (e.g. IR data) inside SysEx, where data
 * bytes must stay <= 0x7F. Round-trips exactly: unpack7bit(pack7bit(x)) deep-equals x.
 */
export function pack7bit(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 7) {
    const chunk = data.subarray(i, i + 7);
    let msb = 0;
    for (let j = 0; j < chunk.length; j++) if (chunk[j]! & 0x80) msb |= 1 << j;
    out.push(msb);
    for (let j = 0; j < chunk.length; j++) out.push(chunk[j]! & 0x7f);
  }
  return Uint8Array.from(out);
}

/** Inverse of {@link pack7bit}. */
export function unpack7bit(packed: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < packed.length; i += 8) {
    const msb = packed[i]!;
    const chunk = packed.subarray(i + 1, i + 8);
    for (let j = 0; j < chunk.length; j++) out.push(chunk[j]! | ((msb >> j) & 1 ? 0x80 : 0));
  }
  return Uint8Array.from(out);
}
