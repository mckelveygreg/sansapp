/**
 * Send a raw live parameter edit (`05 50`) to the pedal, or no-op if not connected. Shared by the
 * deep-effect pages (Compressor, Auto Filter, Ambience) so each doesn't reinvent it. RN surface.
 */
import { encode } from "../protocol/messages";
import { getSession } from "./pedal";

const clampByte = (v: number): number => Math.max(0, Math.min(127, v));

/** Percentage (0–100) for a raw 0–127 value. */
export const rawToPct = (r: number): number => Math.round((r / 127) * 100);

export function sendParam(param: number, value: number): void {
  getSession()?.sendRaw(encode({ kind: "setParam", param, value: clampByte(value) }));
}
