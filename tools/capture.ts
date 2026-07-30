/**
 * in-line MIDI monitor for protocol capture. Sits between EliteControl and the pedal
 * (via the MD1), forwarding both directions and logging every message as JSONL with a
 * live decode. See docs/CAPTURE-PLAYBOOK.md.
 *
 *   npm run capture -- [captures/my-session.jsonl]
 *   ELITE_PORT="USB MIDI Driver" npm run capture
 *
 * In EliteControl → MIDI Device Settings, select the two "sansApp Probe" virtual ports.
 * If the real pedal isn't found, runs PASSIVE (virtual ports + logging, no forwarding).
 */
import { createInterface } from "node:readline";
import { Input, Output } from "@julusian/midi";
import { findPortByName, JsonlLog, listPorts } from "./lib";

const REAL_PORT = process.env.ELITE_PORT ?? "USB MIDI Driver";
const outFile =
  process.argv[2] ?? `captures/session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const log = new JsonlLog(outFile);

// Guard: refuse to start if a "sansApp Probe" port already exists — another capture is running.
// Two instances create duplicate same-named virtual ports, so EliteControl can read through the
// wrong one and get stale bytes. That corrupted an entire amp-bundle capture once; one at a time.
{
  const probe = new Output();
  if (findPortByName(probe, "sansApp Probe") !== null) {
    console.error(
      "\n✗ A 'sansApp Probe' port already exists — another capture is running.\n" +
        "  Duplicate virtual ports corrupt captures (stale reads). Stop it first:\n" +
        "    pkill -f capture.ts\n",
    );
    process.exit(1);
  }
}

// Virtual ports EliteControl connects to:
//   Input.openVirtualPort  -> a DESTINATION (app's MIDI OUT sends here)
//   Output.openVirtualPort -> a SOURCE      (app's MIDI IN reads here)
const appToPedal = new Input();
const pedalToApp = new Output();
appToPedal.ignoreTypes(false, false, false); // receive SysEx
appToPedal.setBufferSize(1 << 16, 64); // room for bulk SysEx dumps
appToPedal.openVirtualPort("sansApp Probe → Pedal");
pedalToApp.openVirtualPort("sansApp Probe ← Pedal");

// Real pedal via the MD1.
const realOut = new Output();
const realIn = new Input();
realIn.ignoreTypes(false, false, false);
realIn.setBufferSize(1 << 16, 64);
listPorts(realOut, "real output");
const outIdx = findPortByName(realOut, REAL_PORT);
const inIdx = findPortByName(realIn, REAL_PORT);
const bridged = outIdx !== null && inIdx !== null;
if (bridged) {
  realOut.openPort(outIdx);
  realIn.openPort(inIdx);
  console.log(`bridged to real port "${REAL_PORT}"`);
} else {
  console.warn(
    `\n⚠  No real port matching "${REAL_PORT}" — running PASSIVE (virtual ports only).` +
      ` Connect the MD1 and rerun for a full capture.\n`,
  );
}

appToPedal.on("message", (_dt, m) => {
  log.event("app->pedal", m);
  if (bridged) realOut.sendMessage(m);
});
realIn.on("message", (_dt, m) => {
  log.event("pedal->app", m);
  pedalToApp.sendMessage(m);
});

console.log("\nsniffing… type text + Enter to drop a marker, Ctrl+C to stop.\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim()) log.marker(line.trim());
});
process.on("SIGINT", () => {
  console.log("\nstopping…");
  log.close();
  appToPedal.destroy();
  pedalToApp.destroy();
  realOut.destroy();
  realIn.destroy();
  process.exit(0);
});
