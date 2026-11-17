/**
 * Turn a failed connect into what the user (and the MIDI log) should see. Framework-free.
 *
 * The session's {@link HandshakeError} says where the handshake stalled; this adds what to DO about
 * it. A pedal that never replied means nothing came back over the link at all — almost always the
 * WIDI Jack ↔ pedal cabling (the pedal is TRS Type A; CME's cable is wired Type B) or the wrong
 * MIDI port, NOT the app — so say that instead of a bare timeout. See docs/HARDWARE.md.
 */
import { HandshakeError } from "../device/session";

export const SILENT_LINK_HINT =
  "Check the WIDI Jack's A/B switch (the pedal is Type A) and that ▲ goes to the pedal's MIDI OUT, ▼ to MIDI IN.";

export function describeConnectFailure(err: unknown, portName: string): string {
  const base = err instanceof Error ? err.message : String(err);
  const via = `${base} — via ${portName}.`;
  if (err instanceof HandshakeError && err.stage === "hello" && !err.pedalReplied) {
    return `${via} ${SILENT_LINK_HINT}`;
  }
  return via;
}
