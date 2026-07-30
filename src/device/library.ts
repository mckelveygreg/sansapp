/**
 * Preset librarian — bulk operations over the 128 slots, built on DeviceSession.
 * Reads are sequential (one slot at a time) so a full sync stays reliable over BLE,
 * where a burst of large SysEx dumps can otherwise drop.
 *
 * Framework-free: no React/React Native imports.
 */

import { PRESET_SLOT_COUNT } from "../protocol/constants";
import type { Preset } from "../protocol/preset";
import type { DeviceSession } from "./session";

export interface SlotPreset {
  slot: number;
  preset: Preset;
}

/** Attempts per slot, and the backoff before a retry — one dropped BLE reply mustn't abort a sync. */
const SLOT_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read one slot, retrying a transient failure — a single 4 s timeout must not abort a ~35 s sync. */
async function readSlotResilient(session: DeviceSession, slot: number): Promise<Preset> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
    try {
      return await session.readPreset(slot);
    } catch (e) {
      lastErr = e;
      if (attempt < SLOT_ATTEMPTS - 1) await delay(RETRY_BACKOFF_MS);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Read every stored slot, reporting progress. Sequential + resilient (per-slot retry). */
export async function readAllPresets(
  session: DeviceSession,
  onProgress?: (done: number, total: number) => void,
): Promise<SlotPreset[]> {
  const out: SlotPreset[] = [];
  for (let slot = 0; slot < PRESET_SLOT_COUNT; slot++) {
    out.push({ slot, preset: await readSlotResilient(session, slot) });
    onProgress?.(slot + 1, PRESET_SLOT_COUNT);
  }
  return out;
}
