/**
 * List every CoreMIDI input/output the Mac can see. Use it to find the exact endpoint name for a
 * new interface — e.g. the CME WIDI Jack once it's paired over Bluetooth (Audio MIDI Setup →
 * Bluetooth) — then pass that name to probe/capture via ELITE_PORT. Read-only; opens nothing.
 *
 *   npm run ports
 */
import { Input, Output } from "@julusian/midi";

const input = new Input();
const output = new Output();

console.log("── MIDI INPUTS (pedal → Mac) ──");
for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
console.log("── MIDI OUTPUTS (Mac → pedal) ──");
for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);

process.exit(0);
