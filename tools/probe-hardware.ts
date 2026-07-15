/**
 * Real-hardware validation (READ-ONLY). Connects to the pedal over the MD1, runs the
 * real {@link DeviceSession} handshake, reads every stored preset + the edit buffer,
 * verifies each 256-byte 14-bit checksum, byte-compares each blob against EliteControl's
 * `.dat` mirror on disk, and dumps the config/data blocks captured during the handshake.
 *
 *   npx tsx tools/probe-hardware.ts     # EliteControl + capture tool CLOSED, pedal on the MD1
 *
 * SAFE: only sends hello, block requests, and 05 40 reads. Never writes, recalls, or edits.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceSession } from "../src/device/session";
import type { PedalMessage } from "../src/protocol/messages";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "USB MIDI Driver";
const DAT_DIR = join(
  homedir(),
  "Library/Containers/com.Tech21USA.app.EliteControl/Data/Library/Application Support/EliteControl/Presets",
);

function datPath(slot: number): string {
  return join(DAT_DIR, `${String(slot + 1).padStart(3, "0")}.dat`);
}

async function main(): Promise<void> {
  const io = openMidi(PORT);
  const session = new DeviceSession(io, 3000);

  // Capture raw dumps (for checksum) and handshake blocks via the message tap.
  const dumpChecksum = new Map<number, boolean>();
  const dumpBlob = new Map<number, Uint8Array>();
  const blocks: { code: number; index: number; data: Uint8Array; ok: boolean }[] = [];
  session.onMessage((m: PedalMessage) => {
    if (m.kind === "presetDump") {
      dumpChecksum.set(m.slot, m.checksumOk);
      dumpBlob.set(m.slot, m.blob);
    } else if (m.kind === "block") {
      blocks.push({ code: m.blockCode, index: m.index, data: m.data, ok: m.checksumOk });
    }
  });

  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(`✓ handshake complete — state = ${session.state}`);
  console.log(`✓ received ${blocks.length} config/data blocks during handshake:`);
  for (const b of blocks) {
    const head = b.data
      .slice(0, 16)
      .reduce((s, v) => `${s}${v.toString(16).padStart(2, "0")} `, "");
    console.log(
      `    block 0x${b.code.toString(16)} idx ${b.index} ck=${b.ok ? "ok" : "BAD"}: ${head}…`,
    );
  }

  console.log("\nreading all 128 stored presets…");
  let ckOk = 0;
  let ckBad = 0;
  let datMatch = 0;
  let datMiss = 0;
  let datAbsent = 0;
  const mismatches: number[] = [];
  for (let slot = 0; slot < 128; slot++) {
    try {
      await session.readPreset(slot);
    } catch (e) {
      console.log(`  slot ${slot}: read FAILED — ${(e as Error).message}`);
      continue;
    }
    const cs = dumpChecksum.get(slot);
    if (cs === true) ckOk++;
    else if (cs === false) ckBad++;
    // byte-compare against the .dat mirror
    const p = datPath(slot);
    const blob = dumpBlob.get(slot);
    if (blob && existsSync(p)) {
      const dat = new Uint8Array(readFileSync(p));
      if (dat.length === blob.length && dat.every((v, i) => v === blob[i])) datMatch++;
      else {
        datMiss++;
        mismatches.push(slot);
      }
    } else datAbsent++;
  }
  console.log(`✓ checksums: ${ckOk} ok, ${ckBad} bad`);
  console.log(
    `✓ vs .dat mirror: ${datMatch} byte-identical, ${datMiss} differ, ${datAbsent} no file`,
  );
  if (mismatches.length)
    console.log(
      `    differing slots (0-based): ${mismatches.join(", ")} (slot 127 = our test slot 128.dat, expected)`,
    );

  const edit = await session.readEditBuffer();
  console.log(`✓ edit buffer (0x7F) reads: "${edit.name.trim()}"`);

  session.disconnect();
  console.log("\ndone — real hardware speaks our protocol.");
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exit(1);
});
