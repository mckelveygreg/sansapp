/**
 * Send a raw live parameter edit (`05 50`) to the pedal, or no-op if not connected. Shared by the
 * deep-effect pages (Compressor, Auto Filter, Ambience) so each doesn't reinvent it. RN surface.
 */
import { liveSetId } from "../protocol/params";
import { getSession } from "./pedal";

const clampByte = (v: number): number => Math.max(0, Math.min(127, v));

/** Percentage (0–100) for a raw 0–127 value. */
export const rawToPct = (r: number): number => Math.round((r / 127) * 100);

/**
 * Send a live parameter edit. Callers pass the parameter's INDEX (its notify/`paramId`); we map it
 * to the pedal's live-set wire id (see {@link liveSetId} — deep params set on index+4). Deep params
 * previously wrote to the wrong id and silently did nothing (or nudged a neighbour). Routed through
 * the session's per-param coalescer so a fast drag can't drop its final value on the wire.
 */
export function sendParam(param: number, value: number): void {
  getSession()?.setLiveParam(liveSetId(param), clampByte(value));
}
