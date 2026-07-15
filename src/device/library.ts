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

/** Read every stored slot, reporting progress. Sequential + resilient. */
export async function readAllPresets(
  session: DeviceSession,
  onProgress?: (done: number, total: number) => void,
): Promise<SlotPreset[]> {
  const out: SlotPreset[] = [];
  for (let slot = 0; slot < PRESET_SLOT_COUNT; slot++) {
    out.push({ slot, preset: await session.readPreset(slot) });
    onProgress?.(slot + 1, PRESET_SLOT_COUNT);
  }
  return out;
}
