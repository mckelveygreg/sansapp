/**
 * Software pedal emulator — implements the captured connect handshake so the app can talk to it with
 * no hardware. Presents virtual MIDI in/out named "sansApp Emulated Elite".
 *
 *   npm run emulate
 *
 * The request/reply behavior is the shared PedalModel (src/device/pedalModel) so the emulator and the
 * integration tests can't drift. Presets come from the local EliteControl `.dat` files when present
 * (else synthetic), and the pedal's data/config blocks captured in captures/m1-live.jsonl seed the
 * model so the connect sequence (hello → blocks → preset read) completes with realistic data.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Input, Output } from "@julusian/midi";
import { PedalModel } from "../src/device/pedalModel";
import { PRESET_SIZE } from "../src/protocol/constants";
import { decode, encode } from "../src/protocol/messages";

const PRESET_DIR = join(
  homedir(),
  "Library/Containers/com.Tech21USA.app.EliteControl/Data/Library/Application Support/EliteControl/Presets",
);

function loadPresets(): Uint8Array[] {
  if (existsSync(PRESET_DIR)) {
    return readdirSync(PRESET_DIR)
      .filter((f) => f.endsWith(".dat"))
      .toSorted()
      .map((f) => new Uint8Array(readFileSync(join(PRESET_DIR, f))));
  }
  return Array.from({ length: 128 }, (_, i) => {
    const b = new Uint8Array(PRESET_SIZE);
    b[0] = 0x01;
    b[2] = 0x41 + (i % 26); // 'A'..'Z' name
    return b;
  });
}

/** Feed the pedal→app config/data blocks captured in m1-live.jsonl into the model, so the connect
 * handshake's block reads reply with realistic data (an unseeded block reads back as zeros). */
function seedBlocksFromCapture(model: PedalModel): number {
  const cap = "captures/m1-live.jsonl";
  if (!existsSync(cap)) return 0;
  let n = 0;
  for (const line of readFileSync(cap, "utf8").split("\n")) {
    if (!line.startsWith('{"')) continue;
    const rec = JSON.parse(line) as { bytes?: string };
    if (!rec.bytes?.startsWith("F0 00 51 21")) continue;
    const m = decode(Uint8Array.from(rec.bytes.split(" ").map((h) => Number.parseInt(h, 16))));
    if (m.kind === "block") {
      model.handle(m); // stores the block so a later requestBlock replies with it
      n++;
    }
  }
  return n;
}

const presets = loadPresets();
const model = new PedalModel(presets);
const seeded = seedBlocksFromCapture(model);

const midiIn = new Input();
const midiOut = new Output();
midiIn.ignoreTypes(false, false, false);
midiIn.setBufferSize(1 << 16, 64);
midiIn.openVirtualPort("sansApp Emulated Elite");
midiOut.openVirtualPort("sansApp Emulated Elite");

const send = (bytes: Uint8Array) => midiOut.sendMessage([...bytes]);

// Dev capture: when IRWIRE_DIR is set, save each received IR upload (reassembled + 7-bit-unpacked to
// the clean payload) so we get exact input->wire pairs. The begin frame has a 5-byte header before
// the packed data; chunks/end are packed data after `05 6x 0A`.
const IRWIRE_DIR = process.env.IRWIRE_DIR;
let irPacked: number[] = [];
let irSeq = 0;
function unpack7(p: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; ) {
    const msb = p[i++]!;
    for (let k = 0; k < 7 && i < p.length; k++, i++)
      out.push((p[i]! & 0x7f) | (((msb >> k) & 1) << 7));
  }
  return out;
}
function saveWire() {
  if (!IRWIRE_DIR) return;
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(IRWIRE_DIR, { recursive: true });
  const dat = Buffer.from(unpack7(irPacked));
  irSeq += 1;
  writeFileSync(join(IRWIRE_DIR, `wire_${String(irSeq).padStart(3, "0")}.bin`), dat);
  console.log(`  saved wire #${irSeq}: ${dat.length}B -> ${IRWIRE_DIR}`);
}

console.log(
  `Emulated Elite up: ${presets.length} presets, ${seeded} seeded blocks.` +
    ` Virtual MIDI "sansApp Emulated Elite". Ctrl+C to stop.\n`,
);

midiIn.on("message", (_dt, raw) => {
  const b = Uint8Array.from(raw);
  // User-IR upload framing decodes as "unknown"; ack it so an IR import completes:
  // 05 60 begin -> 05 63 00 F7, 05 66 end -> 05 61 F7, 05 65 chunks -> no ack.
  if (b[4] === 0x05 && b[5] === 0x60) {
    console.log("recv IR-upload begin (05 60) -> ack 05 63");
    irPacked = Array.from(b.slice(12, -1)); // skip 05 60 0A + 5-byte begin header (00 00 00 15 61)
    return send(Uint8Array.of(0xf0, 0x00, 0x51, 0x21, 0x05, 0x63, 0x00, 0xf7));
  }
  if (b[4] === 0x05 && b[5] === 0x66) {
    console.log("recv IR-upload end (05 66) -> ack 05 61");
    irPacked.push(...b.slice(7, -1));
    saveWire();
    return send(Uint8Array.of(0xf0, 0x00, 0x51, 0x21, 0x05, 0x61, 0xf7));
  }
  if (b[4] === 0x05 && b[5] === 0x65) {
    irPacked.push(...b.slice(7, -1)); // IR chunk, accumulate; no ack
    return;
  }
  const m = decode(b);
  console.log(`recv ${m.kind}`);
  // Everything else: delegate to the shared PedalModel so the emulator matches the pedal's behavior
  // (0x12 save-echo, block-write 05 53 ack, discarded 0x7F edit-buffer stage) exactly as the tests do.
  for (const reply of model.handle(m)) send(encode(reply));
});

process.on("SIGINT", () => {
  midiIn.destroy();
  midiOut.destroy();
  process.exit(0);
});
