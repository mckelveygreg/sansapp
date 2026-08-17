/**
 * READ-ONLY IR record inspector. Reads one or more IR records over `05 69` and reports what is
 * actually IN them — name, makeup-gain field, and sample statistics — rather than the first few bytes
 * of raw hex.
 *
 *   ELITE_PORT="WIDI Jack Bluetooth" npx tsx tools/probe-ir-record.ts 0,10 1,4
 *
 * Each argument is one `A,B` record address; `record = (A << 7) | B`. This exists because the
 * question lab #60 asks — is a PRIVATE user-IR record (address MSB 0/1) readable, and does it hold
 * anything — cannot be answered from a truncated hex dump. An erased NOR record and a written one
 * produce the same 11-frame envelope on the wire; only the decoded payload tells them apart.
 *
 * SAFE: sends the connect handshake and `05 69` reads only. No writes, no recalls, no param sets.
 * As with probe-ir-raw, the sub-command is fixed — nothing here can emit the 0x77/0x78/0x79 transport
 * that reaches the flash erase/program primitives (lab #29).
 */
import { DeviceSession } from "../src/device/session";
import { decodeIrDat, unpackIrStream } from "../src/protocol/irEncode";
import { readIrDat, readIrPacked } from "../src/midi/irRead";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";

function targets(): [number, number][] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (args.length === 0)
    throw new Error('usage: probe-ir-record.ts 0,10 1,4   (each arg is "A,B")');
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
    return [a, b];
  });
}

/** Printable summary of a decoded record — enough to tell erased flash from a real IR. */
function describe(dat: Uint8Array): string {
  const { name, gain, samples } = decodeIrDat(dat);
  const uniq = new Set<number>();
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (const s of samples) {
    uniq.add(s);
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const printableName = /^[\x20-\x7e]*$/.test(name) ? JSON.stringify(name) : "<non-ASCII>";
  const lines = [
    `    name         : ${printableName}`,
    `    gain field   : ${gain.toFixed(4)}  (raw 0x${dat[3]!.toString(16).padStart(2, "0")}${dat[2]!.toString(16).padStart(2, "0")})`,
    `    samples      : ${samples.length}, ${uniq.size} distinct value(s)`,
    `    min/max/mean : ${min.toFixed(4)} / ${max.toFixed(4)} / ${(sum / samples.length).toFixed(4)}`,
    `    rms          : ${rms.toFixed(4)}`,
  ];
  // Erased NOR reads 0xFF everywhere, which is int8 −1 after sign extension: one distinct value,
  // pinned at −1, with a DC mean to match. That is the signature lab #55 predicted for a record that
  // was never written, and it is the thing worth calling out by name.
  if (uniq.size === 1 && min === max) {
    lines.push(
      `    ⚠️  every sample is identical (${min.toFixed(4)}) — this is NOT an impulse response.` +
        (min < -0.99 ? " All −1: the signature of ERASED flash, never written." : ""),
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const list = targets();
  const io = openMidi(PORT);
  // WIDI/BLE: generous read timeout — a full record stream is ~3 s and a short timeout produces a
  // FALSE EMPTY, which would read as "not readable" and answer lab #60 exactly backwards.
  const session = new DeviceSession(io, 8000, 0, 150);
  console.log(`connecting to "${PORT}"…`);
  await session.connect();
  console.log(
    `✓ ready — firmware ${(session.protocolVersion / 10).toFixed(1)} (byte 0x${session.protocolVersion.toString(16)})\n`,
  );

  for (const [a, b] of list) {
    const record = (a << 7) | b;
    const kind = a === 2 ? "library" : a <= 1 ? "private" : "out-of-range";
    console.log(`--- 05 69 [${a}, ${b}] → record ${record} (${kind}) ---`);
    const dat = await readIrDat(session, a, b);
    if (!dat) {
      // "No valid .dat" has two very different causes and they must not be conflated: the pedal
      // ignored the read (nothing on the wire), or it answered with bytes that aren't a `.dat`. The
      // second is the interesting one — an unwritten record returns erased NOR — so unpack whatever
      // did arrive and show its head rather than reporting a bare failure.
      // Strip the 5-byte stream header BEFORE unpacking, exactly as irStreamToDat does — unpacking
      // it as payload turns those septets into meaningless bytes and makes an all-0xFF record look
      // like it has structure at the front.
      const packed = await readIrPacked(session, a, b, 8000);
      const raw = packed ? unpackIrStream(packed.subarray(5)) : null;
      if (!raw) {
        console.log("    NO REPLY — the pedal did not answer this read at all\n");
      } else {
        const head = Array.from(raw.slice(0, 12))
          .map((v) => v.toString(16).padStart(2, "0"))
          .join(" ");
        let notFf = 0;
        for (const v of raw) if (v !== 0xff) notFf++;
        console.log(`    replied ${raw.length} B, but it is not a valid .dat (needs 01 00 magic)`);
        console.log(`    unpacked head: ${head}`);
        console.log(`    bytes not 0xFF: ${notFf} of ${raw.length}`);
        console.log(
          notFf === 0
            ? "    ⚠️  EVERY byte is 0xFF — erased flash. This record was never written."
            : "    (mixed bytes — not erased, but not a .dat either)",
        );
        console.log();
      }
      continue;
    }
    console.log(describe(dat));
    console.log();
  }
  session.disconnect();
  console.log("done.");
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exit(1);
});
