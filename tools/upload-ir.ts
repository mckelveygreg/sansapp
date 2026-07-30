/**
 * Upload a captured user-IR to the pedal by replaying its 05 60/65/66 sequence — proving the app
 * can push an IR (e.g. an HPF'd factory cab) to the pedal from our own code, no EliteControl.
 * Reads captures/hpf-cab-uploads.json (Tech21-derived, gitignored — local only).
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/upload-ir.ts [index] [--allow-bank-write]
 *
 * Protocol (observed): 05 60 begin → pedal ack 05 63; nine 05 65 chunks; 05 66 end → ack 05 61.
 * The frames are replayed verbatim, so a pre-flight refuses any begin frame that targets a library
 * bank instead of the edit-buffer import (see the guard below) unless --allow-bank-write is passed.
 */
import { readFileSync } from "node:fs";
import { DeviceSession } from "../src/device/session";
import { uploadIr } from "../src/midi/irUpload";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI Jack Bluetooth";
const args = process.argv.slice(2);
const allowBankWrite = args.includes("--allow-bank-write");
const which = Number(args.find((a) => !a.startsWith("--")) ?? 7); // default: Brit V30 (index 7)

const hexToBytes = (s: string) => Uint8Array.from(s.split(" ").map((h) => parseInt(h, 16)));

/**
 * Pre-flight: the edit-buffer import targets begin-frame header `[0x00, 0x7F]`. A begin frame with any
 * other bank header (e.g. `[0x02, N]`) is a DIRECT library-bank IR write — the documented #37 brick
 * vector. Refuse unless the caller explicitly accepts the risk with --allow-bank-write.
 */
function assertEditBufferImport(frames: Uint8Array[]): void {
  for (const f of frames) {
    if (f[4] !== 0x05 || f[5] !== 0x60) continue; // only the 05 60 begin frame carries the header
    const a = f[7];
    const b = f[8];
    if ((a === 0x00 && b === 0x7f) || allowBankWrite) continue;
    throw new Error(
      `refusing to replay: an IR begin frame targets bank header [0x${(a ?? 0).toString(16)}, 0x${(b ?? 0).toString(16)}], not the edit-buffer import [0x00, 0x7F].\n` +
        `  A direct library-bank write is the #37 brick vector — pass --allow-bank-write to override (you accept the risk).`,
    );
  }
}

async function main() {
  const packs: { name: string; frames: string[] }[] = JSON.parse(
    readFileSync("captures/hpf-cab-uploads.json", "utf8"),
  );
  const pack = packs[which]!;
  const frames = pack.frames.map(hexToBytes);
  assertEditBufferImport(frames);
  console.log(`uploading "${pack.name}" (${pack.frames.length} frames) via ${PORT}`);

  const io = openMidi(PORT);
  // WIDI/BLE default: 150 ms send pacing (0 disables it) + a generous read timeout for the handshake.
  const session = new DeviceSession(io, 6000, 0, 150);
  await session.connect();
  console.log(`connected — state ${session.state}`);

  await uploadIr(session, frames, {
    presetAddress: null, // the captured frames are self-contained; don't inject address bytes
    save: true, // persist to non-volatile (EliteControl's SAVE)
    onProgress: (d, t) => process.stdout.write(`\r  frame ${d}/${t}`),
  });

  await new Promise((r) => setTimeout(r, 300));
  io.close();
  console.log(`\n✓ "${pack.name}" uploaded — the pedal accepted it.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
