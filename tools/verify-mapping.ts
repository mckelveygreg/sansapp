/**
 * verify-mapping — hardware verification for the parameter map + the physical-knob→app path.
 *
 * Two jobs:
 *  1. LISTEN (default): connect and print every incoming message, naming each paramNotify. Turn a
 *     physical knob (or a deep control on the pedal): if `05 51 <id> <val>` prints, the pedal DOES
 *     reach this app (answers "the app doesn't update when I turn a knob"), and the `<id>` it reports
 *     is the pedal's own ground-truth wire id for that control.
 *  2. SEND / SWEEP: push a setParam for a NAMED control using the (corrected) wire id in params.ts,
 *     so you can confirm by ear that the id actually moves that parameter. This is how to verify the
 *     +4 wire-id correction and the flagged comp/gate ids.
 *
 * Usage (free the port first — quit EliteControl and any capture tool):
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify                 # listen
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify -- send lowFreq 100
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify -- sweep chorus
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify -- ir scan       # read every slot in IR_READ_AB
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify -- ir slot 3     # read one slot (1..6)
 *   ELITE_PORT="WIDI Jack Bluetooth" npm run verify -- ir ab 2 4     # read a raw (a,b) selector
 *   npm run verify -- names                                          # print the id→name table
 *
 * `ir scan` is the tool for the pending job: confirm the slot→(a,b) map in irRead.ts by checking that
 * each printed name matches the cab in that pedal position (use `ir ab` to probe unknown selectors).
 */
import { DeviceSession } from "../src/device/session";
import {
  AMBIENCE_PARAMS,
  AUTO_FILTER_PARAMS,
  CHORUS_PARAMS,
  COMP_PARAMS,
  GATE_PARAMS,
  KNOB_LAYER_NOTIFY_PARAM,
  PARAMETRIC_EQ,
  PARAMS,
  PARAM_IDS,
  type ParamId,
} from "../src/protocol/params";
import { IR_READ_AB, readIr, readIrSlot } from "../src/midi/irRead";
import type { DecodedIr } from "../src/protocol/irEncode";
import { bytesToHex } from "../src/protocol/hex";
import { openMidi } from "./lib";

const PORT = process.env.ELITE_PORT ?? "WIDI";

/** raw wire id → human label, assembled from every mapping table so listen-mode can name any id. */
const LABEL = new Map<number, string>();
const add = (id: number | undefined, label: string) => {
  if (id === undefined) return;
  LABEL.set(id, LABEL.has(id) ? `${LABEL.get(id)} / ${label}` : label);
};
for (const id of PARAM_IDS) add(PARAMS[id].paramId, PARAMS[id].label);
for (const [k, v] of Object.entries(COMP_PARAMS)) add(v, `comp.${k}`);
for (const [k, v] of Object.entries(AUTO_FILTER_PARAMS)) add(v, `filter.${k}`);
for (const [k, v] of Object.entries(CHORUS_PARAMS)) add(v, `chorus.${k}`);
for (const [k, v] of Object.entries(GATE_PARAMS)) add(v, `gate.${k}`);
for (const [k, v] of Object.entries(AMBIENCE_PARAMS)) add(v, `ambience.${k}`);
for (const band of ["low", "mid", "high"] as const)
  for (const [k, v] of Object.entries(PARAMETRIC_EQ[band])) add(v, `eq.${band}.${k}`);
add(0x12, "SAVE/commit");
add(0x13, "reverb extension factor (per PROTOCOL.md; unconfirmed)");
add(0x4d, "RED SHIFT footswitch (layer)");

const name = (id: number) => LABEL.get(id) ?? "(unmapped)";

/** Resolve a control name to its wire id: a ParamId, or "table.key" (e.g. comp.attack, eq.low.q). */
function resolveId(arg: string): number | undefined {
  if (arg === "layer") return KNOB_LAYER_NOTIFY_PARAM; // red-zone toggle (send 1=red, 0=primary)
  if (arg in PARAMS) return PARAMS[arg as ParamId].paramId;
  const tables: Record<string, Record<string, number>> = {
    comp: COMP_PARAMS,
    filter: AUTO_FILTER_PARAMS,
    chorus: CHORUS_PARAMS,
    gate: GATE_PARAMS,
    ambience: AMBIENCE_PARAMS,
  };
  const [t, k, k2] = arg.split(".");
  if (t === "eq" && k && k2) return (PARAMETRIC_EQ as any)[k]?.[k2];
  if (t && k && tables[t]) return tables[t][k];
  return undefined;
}

async function main() {
  const [mode = "listen", arg, valStr, valStr2] = process.argv.slice(2);

  if (mode === "names") {
    console.log("wire id → control");
    for (const id of [...LABEL.keys()].sort((a, b) => a - b)) {
      console.log(`  0x${id.toString(16).padStart(2, "0")}  ${name(id)}`);
    }
    return;
  }

  console.log(`opening MIDI port matching "${PORT}" …`);
  const io = openMidi(PORT);
  // 8 s timeout + 150 ms handshake pacing: BLE drops back-to-back sends (verified 2026-07-14).
  const session = new DeviceSession(io, 8000, 0, 150);
  await new Promise((r) => setTimeout(r, 800)); // let the BLE link settle after opening the port
  console.log("connecting (handshake) …");
  await session.connect();
  console.log("✅ connected.\n");

  if (mode === "listen") {
    console.log("LISTENING (de-duped: one line per distinct control). Turn a physical knob or");
    console.log(
      "adjust a control on the pedal. UNMAPPED ids are flagged — those are things to add.\n",
    );
    let count = 0;
    let lastId = -1;
    session.onMessage((m) => {
      if (m.kind !== "paramNotify") return;
      count++;
      if (m.param === lastId) return; // collapse a sweep of one control to a single line
      lastId = m.param;
      const known = LABEL.has(m.param);
      const hex = `0x${m.param.toString(16).padStart(2, "0")}`;
      console.log(
        known
          ? `↩ ${hex}  ${name(m.param)}  (val ${m.value})`
          : `⚠ ${hex}  UNMAPPED — val ${m.value}  ← candidate to add`,
      );
    });
    setInterval(() => {
      if (count === 0) console.log("… still listening (no activity received yet)");
    }, 8000);
    return; // keep process alive on the MIDI callback
  }

  if (mode === "send" || mode === "sweep") {
    if (!arg) throw new Error(`usage: ${mode} <control> [value]  (e.g. ${mode} lowFreq 100)`);
    const id = resolveId(arg);
    if (id === undefined)
      throw new Error(`unknown control "${arg}" — try: npm run verify -- names`);
    console.log(`control "${arg}" → wire id 0x${id.toString(16)}  (${name(id)})`);
    const sendParam = (v: number) => {
      const bytes = Uint8Array.from([0xf0, 0x00, 0x51, 0x21, 0x05, 0x50, 0x0a, id, v & 0x7f, 0xf7]);
      io.send(bytes);
      console.log(`→ setParam 0x${id.toString(16)} = ${v}   ${bytesToHex(bytes)}`);
    };
    if (mode === "send") {
      sendParam(Number(valStr ?? 100));
      console.log("Listen to the pedal: did this control move? If yes, the wire id is correct.");
    } else {
      console.log("Sweeping 0→127→64 slowly — listen for the parameter moving …");
      const seq = [...Array(13).keys()].map((i) => i * 10).concat([127, 64]);
      for (const v of seq) {
        sendParam(v);
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    session.disconnect();
    return;
  }

  if (mode === "ir") {
    const describe = (label: string, ir: DecodedIr | null) => {
      if (!ir) {
        console.log(`  ${label}: (no reply — slot empty or wrong selector)`);
        return;
      }
      let peak = 0;
      for (const s of ir.samples) peak = Math.max(peak, Math.abs(s));
      console.log(`  ${label}: "${ir.name}"  gain ${ir.gain.toFixed(3)}  peak ${peak.toFixed(3)}`);
    };
    if (arg === "scan") {
      console.log(
        "Reading every slot in IR_READ_AB — the name should match that pedal position:\n",
      );
      for (const slot of Object.keys(IR_READ_AB)
        .map(Number)
        .sort((a, b) => a - b)) {
        const [a, b] = IR_READ_AB[slot]!;
        describe(
          `slot ${slot}  (a=0x${a.toString(16)} b=0x${b.toString(16)})`,
          await readIrSlot(session, slot),
        );
      }
    } else if (arg === "slot") {
      const slot = Number(valStr);
      if (!Number.isInteger(slot)) throw new Error("usage: ir slot <1..8>");
      describe(`slot ${slot}`, await readIrSlot(session, slot));
    } else if (arg === "ab") {
      const a = Number(valStr);
      const b = Number(valStr2);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error("usage: ir ab <a> <b>");
      describe(`a=0x${a.toString(16)} b=0x${b.toString(16)}`, await readIr(session, a, b));
    } else {
      throw new Error("usage: ir scan | ir slot <n> | ir ab <a> <b>");
    }
    session.disconnect();
    return;
  }

  throw new Error(`unknown mode "${mode}" — use: listen | send | sweep | ir | names`);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
