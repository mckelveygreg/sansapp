/**
 * Read-only block dumper. Connects to the pedal, then requests every config block (0x6A→0x6B)
 * and data block (0x55→0x52) across a range of indices, saving each raw payload and printing a
 * quick structural read (ASCII ratio, non-zero count, head bytes). Used to map the settings
 * blocks and identify the unknown binary block. SAFE: reads only.
 *
 *   npx tsx tools/dump-blocks.ts     # EliteControl + capture tool CLOSED, pedal on the MD1
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceSession } from "../src/device/session";
import type { PedalMessage } from "../src/protocol/messages";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "USB MIDI Driver";
const OUT_DIR = join(process.cwd(), "captures", "blocks");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(data: Uint8Array): string {
  let ascii = 0;
  let nonzero = 0;
  for (const b of data) {
    if (b >= 0x20 && b < 0x7f) ascii++;
    if (b !== 0) nonzero++;
  }
  const head = Array.from(data.subarray(0, 24))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join(" ");
  const kind =
    nonzero === 0
      ? "all-zero"
      : ascii / data.length > 0.6
        ? "TEXT"
        : nonzero < 40
          ? "sparse"
          : "binary";
  return `nz=${String(nonzero).padStart(3)} ascii=${String(Math.round((ascii / data.length) * 100)).padStart(3)}% ${kind.padEnd(8)} ${head}…`;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const io = openMidi(PORT);
  const session = new DeviceSession(io, 6000);
  const blocks = new Map<string, { code: number; index: number; data: Uint8Array; ok: boolean }>();
  session.onMessage((m: PedalMessage) => {
    if (m.kind === "block")
      blocks.set(`${m.blockCode}:${m.index}`, {
        code: m.blockCode,
        index: m.index,
        data: m.data,
        ok: m.checksumOk,
      });
  });

  await session.connect();
  console.log("handshake ok — requesting blocks…\n");

  const version = session.protocolVersion; // negotiated by connect() — 0x0A on fw 1.0, 0x0B on 1.1
  for (let i = 0; i <= 3; i++) {
    io.send(encodeRequest(0x6a, i, version));
    await sleep(120);
  }
  for (let i = 0; i <= 16; i++) {
    io.send(encodeRequest(0x55, i, version));
    await sleep(120);
  }
  await sleep(300);

  const keys = [...blocks.keys()].toSorted((a, b) => {
    const [ca, ia] = a.split(":").map(Number);
    const [cb, ib] = b.split(":").map(Number);
    return ca! - cb! || ia! - ib!;
  });
  for (const k of keys) {
    const b = blocks.get(k)!;
    const label = b.code === 0x6b ? "config" : "data";
    console.log(
      `  ${label} 0x${b.code.toString(16)} idx ${String(b.index).padStart(2)} ck=${b.ok ? "ok" : "BAD"}  ${describe(b.data)}`,
    );
    writeFileSync(join(OUT_DIR, `${label}_${b.code.toString(16)}_${b.index}.bin`), b.data);
  }
  console.log(`\nsaved ${keys.length} blocks → ${OUT_DIR}`);
  session.disconnect();
}

function encodeRequest(reqCode: number, index: number, version: number): Uint8Array {
  return Uint8Array.of(0xf0, 0x00, 0x51, 0x21, 0x05, reqCode, version & 0x7f, index & 0x7f, 0xf7);
}

main().catch((e) => {
  console.error("dump failed:", (e as Error).message);
  process.exit(1);
});
