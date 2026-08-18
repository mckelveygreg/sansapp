/**
 * READ-ONLY census of one parameter across all 128 stored presets, read fresh off the pedal.
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/preset-census.ts softClip
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/preset-census.ts softClip drive level
 *
 * Answers "does any preset actually use this control, and at what values?" — the question that keeps
 * coming up when deciding whether a parameter deserves UI, or whether a control is effectively fixed.
 *
 * Why it reads the pedal rather than a `.p3b`: a saved bundle describes the pedal on the day it was
 * exported. Answering a question about what the pedal holds *now* from a month-old file is how you get
 * a confident wrong answer, and this tool exists because that happened.
 *
 * SAFE: handshake and `05 40` preset reads only. No writes, no recalls, no param sets.
 */
import { DeviceSession } from "../src/device/session";
import { PARAMS, type ParamId } from "../src/protocol/params";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";

function chosen(): ParamId[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-")) as ParamId[];
  if (args.length === 0) throw new Error("usage: preset-census.ts <paramId> [paramId…]");
  for (const id of args) {
    if (!(id in PARAMS)) throw new Error(`unknown param "${id}" — see src/protocol/params.ts`);
  }
  return args;
}

async function main(): Promise<void> {
  const ids = chosen();
  const io = openMidi(PORT);
  const session = new DeviceSession(io, 8000, 0, 150);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(`✓ ready — firmware ${(session.protocolVersion / 10).toFixed(1)}\n`);

  console.log("reading all 128 presets…");
  const blobs: { program: number; raw: Uint8Array }[] = [];
  for (let program = 0; program < 128; program++) {
    try {
      blobs.push({ program, raw: (await session.readPreset(program)).raw });
    } catch (e) {
      console.log(`  program ${program}: read FAILED — ${(e as Error).message}`);
    }
  }
  console.log(`  read ${blobs.length}/128\n`);

  for (const id of ids) {
    const def = PARAMS[id];
    const counts = new Map<number, number[]>();
    for (const { program, raw } of blobs) {
      const v = raw[def.blobOffset]!;
      if (!counts.has(v)) counts.set(v, []);
      counts.get(v)!.push(program + 1);
    }
    console.log(
      `${def.label} (${id}) — blob 0x${def.blobOffset.toString(16)}, ${counts.size} distinct value(s):`,
    );
    for (const [v, presets] of [...counts].sort((a, b) => b[1].length - a[1].length)) {
      const list = presets.length <= 16 ? `: ${presets.join(", ")}` : "";
      console.log(
        `  ${String(v).padStart(3)} → ${String(presets.length).padStart(3)} preset(s)${list}`,
      );
    }
    console.log();
  }
  session.disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error("census failed:", (e as Error).message);
  process.exit(1);
});
