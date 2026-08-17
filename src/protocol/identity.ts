/**
 * Device identity + preset-bank freshness — the two data blocks the connect handshake already reads
 * and used to throw away (`docs/PROTOCOL.md` → "Config / data blocks"):
 *
 *   data block 0x0F  the pedal's SERIAL NUMBER, space-padded ASCII at bytes 0xE0–0xFF
 *   data block 0x03  a 128-entry PER-PRESET CHECKSUM table, one 14-bit sum per slot
 *
 * Together they make a local cache of the preset bank both attributable ("these names came from THIS
 * pedal") and verifiable ("slots 12 and 49 changed since we cached them") — turning the ~35 s
 * 128-preset Bluetooth walk into one 256-byte read plus the slots that actually moved.
 *
 * Framework-free.
 */

import { checksum14 } from "./messages";
import { PRESET_SLOT_COUNT } from "./constants";

/** Data block holding the serial number (read during the connect handshake). */
export const SERIAL_BLOCK = 0x0f;
/** The serial lives in the last 32 bytes of the block, space-padded ASCII. */
export const SERIAL_OFFSET = 0xe0;
const SERIAL_FIELD_LEN = 32;

/** Data block holding the per-preset checksum table (also read during the handshake). */
export const CHECKSUM_TABLE_BLOCK = 0x03;

/**
 * The pedal's serial number — `ELITE-PDL-MMDDYYYY-NNNNNN` — or null if the field is blank or not
 * printable ASCII. The `ELITE-PDL` prefix is a string constant in the firmware image; the tail is
 * per-unit data in flash. Only one pedal has been observed, so per-unit uniqueness is inferred from
 * that structure (and from the official editor formatting the same value as `SERIAL: %s`) rather than
 * proved — treat it as a cache key, not as an identity claim.
 */
export function parseSerial(block: Uint8Array): string | null {
  const field = block.subarray(SERIAL_OFFSET, SERIAL_OFFSET + SERIAL_FIELD_LEN);
  let out = "";
  for (const b of field) {
    if (b === 0x00) break; // NUL-terminated as well as space-padded, defensively
    if (b < 0x20 || b > 0x7e) return null; // not the text field we're looking for
    out += String.fromCharCode(b);
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The 128 per-preset checksums from block 0x03, in slot order — each the same 14-bit sum the preset's
 * own dump carries in its two-byte trailer, stored as a (MSB, LSB) 7-bit pair.
 *
 * Verified 2026-08-17 against a 128-preset `.p3b` export: 126/128 entries equalled the matching
 * dump's trailer exactly, and the two that differed were the presets edited between the two
 * captures — so the table tracks edits rather than being a static factory artifact.
 */
export function parseChecksumTable(block: Uint8Array): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < PRESET_SLOT_COUNT; slot++) {
    out.push(((block[slot * 2] ?? 0) << 7) | (block[slot * 2 + 1] ?? 0));
  }
  return out;
}

/** The 14-bit checksum a preset blob would carry — comparable against a {@link parseChecksumTable} entry. */
export function presetChecksum(blob: Uint8Array): number {
  const [hi, lo] = checksum14(blob);
  return (hi << 7) | lo;
}

/**
 * Slots whose cached checksum doesn't match the pedal's table — the only ones a sync has to re-read.
 * A slot with no cached checksum is always stale.
 *
 * The table is a plain byte sum, so treat a match as "unchanged" for list/librarian purposes, not as
 * integrity proof: a byte swap, or an offsetting ±1 in two params, sums the same. Anything being
 * opened for editing should still be read from the pedal.
 */
export function staleSlots(
  table: readonly number[],
  cached: Readonly<Record<number, number>>,
): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < table.length; slot++) {
    if (cached[slot] !== table[slot]) out.push(slot);
  }
  return out;
}
