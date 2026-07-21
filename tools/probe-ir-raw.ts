/**
 * READ-ONLY raw disambiguation: does the pedal respond to `05 69` IR reads at all over this MIDI link?
 * Logs every raw incoming MIDI chunk for a few targeted reads. SAFE: hello + block reads (handshake)
 * + 05 69 reads only. No writes.
 *   ELITE_PORT="WIDI" npx tsx tools/probe-ir-raw.ts
 */
import { SYSEX_PREFIX } from "../src/protocol/constants";
import { DeviceSession } from "../src/device/session";
import { bytesToHex } from "../src/protocol/hex";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const io = openMidi(PORT);
  let rx = 0;
  io.onMessage((b) => {
    rx++;
    console.log(`  RX [${b.length}b]: ${bytesToHex(b).slice(0, 80)}${b.length > 27 ? "…" : ""}`);
  });
  const session = new DeviceSession(io, 4000);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(`✓ ready — handshake works, single-message reads work.\n`);

  const targets: [number, number, string][] = [
    [0x02, 0x00, "slot 1 (factory / prior-captured stream)"],
    [0x02, 0x06, "slot 7 user"],
    [0x02, 0x07, "slot 8 user"],
    [0x02, 0x01, "slot 2"],
  ];
  for (const [a, b, label] of targets) {
    console.log(`--- 05 69 0A ${a.toString(16)} ${b.toString(16)}  (${label}) ---`);
    rx = 0;
    io.send(Uint8Array.of(...SYSEX_PREFIX, 0x05, 0x69, 0x0a, a, b, 0xf7));
    await delay(3500);
    console.log(`  → ${rx} raw chunk(s) received\n`);
  }
  session.disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error("raw probe failed:", (e as Error).message);
  process.exit(1);
});
