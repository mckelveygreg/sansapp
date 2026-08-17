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

/**
 * Read `A,B` record addresses off the command line, so a probe of a specific record doesn't need a
 * source edit. Each argument is one `05 69` target:
 *
 *   npx tsx tools/probe-ir-raw.ts 0,10 1,4
 *
 * Only the two address bytes are configurable — the command stays `05 69` (an IR READ) and the
 * version byte is whatever `connect()` negotiated. There is deliberately no way to make this tool
 * send any other sub-command: the neighbouring 0x77/0x78/0x79 transport reaches the flash
 * erase/program primitives and has no known recovery path (lab #29).
 */
function argvTargets(): [number, number, string][] | null {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length === 0) return null;
  return args.map((arg) => {
    const parts = arg.split(",");
    if (parts.length !== 2) throw new Error(`bad target "${arg}" — expected A,B (e.g. 0,10)`);
    const [a, b] = parts.map((p) => {
      const n = Number(p.trim());
      if (!Number.isInteger(n) || n < 0 || n > 0x7f) {
        throw new Error(`bad address byte "${p}" in "${arg}" — must be 0…127`);
      }
      return n;
    }) as [number, number];
    return [a, b, `record ${(a << 7) | b}`];
  });
}

async function main(): Promise<void> {
  const io = openMidi(PORT);
  let rx = 0;
  io.onMessage((b) => {
    rx++;
    console.log(`  RX [${b.length}b]: ${bytesToHex(b).slice(0, 80)}${b.length > 27 ? "…" : ""}`);
  });
  // WIDI/BLE default: 150 ms send pacing (0 disables it) + a generous read timeout.
  const session = new DeviceSession(io, 6000, 0, 150);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(`✓ ready — handshake works, single-message reads work.\n`);

  const targets: [number, number, string][] = argvTargets() ?? [
    [0x02, 0x00, "slot 1 (factory / prior-captured stream)"],
    [0x02, 0x06, "slot 7 user"],
    [0x02, 0x07, "slot 8 user"],
    [0x02, 0x01, "slot 2"],
  ];
  const ver = session.protocolVersion; // negotiated by connect() — 0x0A on fw 1.0, 0x0B on 1.1
  for (const [a, b, label] of targets) {
    console.log(
      `--- 05 69 ${ver.toString(16).toUpperCase()} ${a.toString(16)} ${b.toString(16)}  (${label}) ---`,
    );
    rx = 0;
    io.send(Uint8Array.of(...SYSEX_PREFIX, 0x05, 0x69, ver, a, b, 0xf7));
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
