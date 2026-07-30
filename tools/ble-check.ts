/**
 * Bluetooth link check for the CME WIDI Jack (or any endpoint). Beyond the read-only `probe`, this
 * measures round-trip latency and exercises the send direction WITHOUT changing pedal state:
 *   - runs the connect handshake (hello → blocks → control) and times it,
 *   - times N preset-read round-trips (05 40 → the 267-byte 05 41 reply),
 *   - reads data block 0 (active-slot settings) and the active preset,
 *   - fires ONE paced live-set of a single param to its CURRENT value — a benign no-op that puts a
 *     05 50 on the wire so the send direction is proven without editing anything.
 * A live-set gets no echo, so the send path is exercised, not round-trip-confirmed. Nothing is written
 * to any stored preset, to a program slot, or to the pedal's settings.
 *
 *   npm run ble-check                       # defaults to the WIDI Jack Bluetooth endpoint
 *   ELITE_PORT="USB MIDI Driver" npm run ble-check   # compare against wired
 */
import { performance } from "node:perf_hooks";
import { DeviceSession } from "../src/device/session";
import { PARAMS, liveSetId } from "../src/protocol/params";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI Jack Bluetooth";
const SAMPLES = 20;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { min: s[0]!, max: s.at(-1)!, avg: sum / s.length, med: s[s.length >> 1]! };
};

async function main(): Promise<void> {
  const io = openMidi(PORT);
  // 150 ms send pacing + a generous read timeout: over WIDI/BLE the pedal drops back-to-back
  // fire-and-forget sends and the 267-byte reply round-trip is slow (session pacing is off at gap 0).
  const session = new DeviceSession(io, 6000, 0, 150);

  console.log(`connecting to "${PORT}"…`);
  const t0 = performance.now();
  await session.connect();
  console.log(`✓ handshake: ${(performance.now() - t0).toFixed(0)} ms — state = ${session.state}`);

  // Active slot from data block 0, then a preset read (both read-only).
  const block0 = await session.readBlock(0x55, 0);
  const b0 = block0[0];
  const activeSlot = b0 !== undefined && b0 < 128 ? b0 : 0;
  const active = await session.readPreset(activeSlot);
  console.log(`✓ active slot ${activeSlot + 1}: "${active.name.trim()}"`);

  // Latency: time N preset-read round-trips (request → 267-byte reply).
  const lat: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    await session.readPreset(activeSlot);
    lat.push(performance.now() - t);
  }
  const l = stats(lat);
  console.log(
    `✓ read RTT over ${SAMPLES}×267-byte SysEx: min ${l.min.toFixed(0)} / med ${l.med.toFixed(0)} / avg ${l.avg.toFixed(0)} / max ${l.max.toFixed(0)} ms`,
  );

  // Send-path probe (benign): live-set Level to its CURRENT value — a no-op edit that puts one paced
  // 05 50 on the wire. A live-set has no echo, so this proves the send direction, not a round-trip.
  const level = active.values.level;
  await session.setParamsPaced([{ param: liveSetId(PARAMS.level.paramId!), value: level }]);
  console.log(
    `✓ send-path probe: live-set Level = ${level} (its current value — no audible change)`,
  );

  session.disconnect();
  console.log("\ndone — Bluetooth carries our protocol both ways.");
}

main().catch((e) => {
  console.error("ble-check failed:", (e as Error).message);
  process.exit(1);
});
