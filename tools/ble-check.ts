/**
 * Bluetooth link check for the CME WIDI Jack (or any endpoint). Beyond the read-only `probe`, this
 * measures round-trip latency and exercises the WRITE path — safely: it reads the edit buffer
 * (slot 0x7F, the non-persistent scratch buffer), writes the SAME bytes back, confirms the pedal
 * acks, and re-reads to prove the round-trip. Nothing is written to a stored preset (1–128).
 *
 *   npm run ble-check                       # defaults to the WIDI Jack Bluetooth endpoint
 *   ELITE_PORT="USB MIDI Driver" npm run ble-check   # compare against wired
 *
 * SAFE: touches only the edit buffer; never writes/recalls a stored slot.
 */
import { performance } from "node:perf_hooks";
import { DeviceSession } from "../src/device/session";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI Jack Bluetooth";
const EDIT = 0x7f;
const SAMPLES = 20;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { min: s[0]!, max: s.at(-1)!, avg: sum / s.length, med: s[s.length >> 1]! };
};

async function main(): Promise<void> {
  const io = openMidi(PORT);
  const session = new DeviceSession(io, 5000);

  console.log(`connecting to "${PORT}"…`);
  const t0 = performance.now();
  await session.connect();
  console.log(`✓ handshake: ${(performance.now() - t0).toFixed(0)} ms — state = ${session.state}`);

  // Latency: time N edit-buffer read round-trips (request → 267-byte reply).
  const lat: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    await session.readEditBuffer();
    lat.push(performance.now() - t);
  }
  const l = stats(lat);
  console.log(
    `✓ read RTT over ${SAMPLES}×267-byte SysEx: min ${l.min.toFixed(0)} / med ${l.med.toFixed(0)} / avg ${l.avg.toFixed(0)} / max ${l.max.toFixed(0)} ms`,
  );

  // Write path (non-destructive): read edit buffer, write the same bytes back, confirm + re-read.
  const before = await session.readEditBuffer();
  const tw = performance.now();
  await session.writePreset(EDIT, before.raw); // resolves only on the pedal's 05 21 ack
  console.log(`✓ write+ack round-trip (edit buffer): ${(performance.now() - tw).toFixed(0)} ms`);
  const after = await session.readEditBuffer();
  const identical =
    before.raw.length === after.raw.length && before.raw.every((v, i) => v === after.raw[i]);
  console.log(
    `✓ read-back after write: ${identical ? "byte-identical (write path OK)" : "DIFFERS ⚠"}`,
  );

  session.disconnect();
  console.log("\ndone — Bluetooth carries our protocol both ways.");
}

main().catch((e) => {
  console.error("ble-check failed:", (e as Error).message);
  process.exit(1);
});
