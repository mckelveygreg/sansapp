/**
 * Shared helpers for the Node protocol-capture tools. Dev-only (not bundled into
 * the app). Imports the framework-free protocol codec directly.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { Input, Output } from "@julusian/midi";
import type { MidiIO } from "../src/device/transport";
import { bytesToHex } from "../src/protocol/hex";
import { decode, type PedalMessage } from "../src/protocol/messages";

export type Direction = "app->pedal" | "pedal->app" | "in" | "out";

const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, "0")}`;

/** A short, human-readable one-liner for the live console (param id/value, slot, index). */
export function annotate(msg: PedalMessage): string {
  switch (msg.kind) {
    case "setParam":
      return `setParam    ${hex2(msg.param)}=${msg.value}`;
    case "paramNotify":
      return `paramNotify ${hex2(msg.param)}=${msg.value}`;
    case "writePreset":
      return `writePreset slot ${msg.slot}${msg.checksumOk ? "" : " ⚠ck"}`;
    case "presetDump":
      return `presetDump  slot ${msg.slot}${msg.checksumOk ? "" : " ⚠ck"}`;
    case "block":
      return `block ${hex2(msg.blockCode)}[${msg.index}]`;
    case "recallPreset":
      return `recall slot ${msg.slot}`;
    case "requestPreset":
      return `readPreset slot ${msg.slot}`;
    case "requestBlock":
      return `reqBlock ${hex2(msg.reqCode)}[${msg.index}]`;
    default:
      return msg.kind;
  }
}

/** First port whose name contains `substr` (case-insensitive), or null. */
export function findPortByName(io: Input | Output, substr: string): number | null {
  const want = substr.toLowerCase();
  for (let i = 0; i < io.getPortCount(); i++) {
    if (io.getPortName(i).toLowerCase().includes(want)) return i;
  }
  return null;
}

/**
 * Open a bidirectional {@link MidiIO} on the first CoreMIDI port matching `portSubstr` (works for
 * the MD1 "USB MIDI Driver" or the "WIDI Jack Bluetooth" endpoint alike). Throws if not found.
 */
export function openMidi(portSubstr: string): MidiIO {
  const input = new Input();
  const output = new Output();
  input.ignoreTypes(false, false, false); // deliver SysEx
  input.setBufferSize(1 << 16, 64);
  const inIdx = findPortByName(input, portSubstr);
  const outIdx = findPortByName(output, portSubstr);
  if (inIdx === null || outIdx === null) {
    throw new Error(
      `MIDI port "${portSubstr}" not found — close EliteControl and the capture tool`,
    );
  }
  input.openPort(inIdx);
  output.openPort(outIdx);
  const listeners = new Set<(b: Uint8Array) => void>();
  input.on("message", (_dt, msg) => {
    const b = Uint8Array.from(msg);
    for (const cb of listeners) cb(b);
  });
  return {
    send: (bytes) => output.sendMessage([...bytes]),
    onMessage: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => {
      input.closePort();
      output.closePort();
    },
  };
}

export function listPorts(io: Input | Output, label: string): void {
  const n = io.getPortCount();
  console.log(`${label} ports (${n}):`);
  for (let i = 0; i < n; i++) console.log(`  [${i}] ${io.getPortName(i)}`);
}

/** Append-only JSONL capture logger with a live console echo + decode annotation. */
export class JsonlLog {
  private readonly stream: WriteStream;
  private readonly start = Date.now();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
    console.log(`logging → ${path}`);
  }

  event(dir: Direction, message: number[]): void {
    const bytes = Uint8Array.from(message);
    const msg = decode(bytes);
    // JSONL keeps the bare `kind` (so replay/coverage stay stable); the console gets the rich form.
    const rec = { t: Date.now() - this.start, dir, bytes: bytesToHex(bytes), decoded: msg.kind };
    this.stream.write(`${JSON.stringify(rec)}\n`);
    console.log(`${dir.padEnd(10)} ${annotate(msg).padEnd(22)} ${rec.bytes}`);
  }

  marker(text: string): void {
    this.stream.write(`${JSON.stringify({ t: Date.now() - this.start, marker: text })}\n`);
    console.log(`--- marker: ${text} ---`);
  }

  close(): void {
    this.stream.end();
  }
}
