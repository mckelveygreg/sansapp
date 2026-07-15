/**
 * Ad-hoc SysEx/MIDI sender for probing.
 *
 *   npm run send -- "USB MIDI Driver" "F0 00 51 21 04 10 F7"
 *   npm run send -- "Emulated Elite"  "C0 05"   # program change to slot 5
 */
import { Output } from "@julusian/midi";
import { hexToBytes } from "../src/protocol/hex";
import { findPortByName, listPorts } from "./lib";

const [, , portArg, ...hexParts] = process.argv;
const out = new Output();

if (!portArg || hexParts.length === 0) {
  console.log('usage: npm run send -- "<port name substring>" "F0 00 51 21 04 10 F7"');
  listPorts(out, "output");
  out.destroy();
  process.exit(1);
}

const idx = findPortByName(out, portArg);
if (idx === null) {
  console.error(`no output port matching "${portArg}"`);
  listPorts(out, "output");
  out.destroy();
  process.exit(1);
}

out.openPort(idx);
const bytes = hexToBytes(hexParts.join(" "));
out.sendMessage([...bytes]);
console.log(`sent [${hexParts.join(" ")}] → "${out.getPortName(idx)}"`);
out.closePort();
out.destroy();
