/**
 * Turn JSONL captures into test fixtures and report decode coverage.
 *
 *   npm run replay -- --coverage captures/00-launch-connect.jsonl
 *   npm run replay -- --extract captures/02-knob-sweeps.jsonl \
 *                     --between "drive sweep start" "drive sweep end" \
 *                     --out src/protocol/fixtures/drive-sweep.jsonl
 *   npm run replay -- --summary  captures/selectors.jsonl   # app→pedal setParams per marker window
 *   npm run replay -- --blobdiff captures/sweeps.jsonl      # changed blob offsets between writes
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hexToBytes } from "../src/protocol/hex";
import { decode } from "../src/protocol/messages";

interface Rec {
  t?: number;
  dir?: string;
  bytes?: string;
  decoded?: string;
  marker?: string;
}

function readJsonl(path: string): Rec[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Rec);
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const coverageFile = arg("--coverage");
const extractFile = arg("--extract");
const summaryFile = arg("--summary");
const blobdiffFile = arg("--blobdiff");

const hex2 = (n: number): string => `0x${n.toString(16).padStart(2, "0")}`;

if (coverageFile) {
  const recs = readJsonl(coverageFile).filter((r) => r.bytes);
  const known = recs.filter((r) => decode(hexToBytes(r.bytes!)).kind !== "unknown").length;
  const pct = recs.length ? ((known / recs.length) * 100).toFixed(1) : "0";
  console.log(`decode coverage: ${known}/${recs.length} (${pct}%)`);
} else if (extractFile) {
  const between = process.argv.indexOf("--between");
  const from = process.argv[between + 1];
  const to = process.argv[between + 2];
  const outPath = arg("--out");
  if (between < 0 || !from || !to || !outPath) {
    console.error('need: --between "<marker A>" "<marker B>" --out <fixture.jsonl>');
    process.exit(1);
  }
  let on = false;
  const slice: Rec[] = [];
  for (const r of readJsonl(extractFile)) {
    if (r.marker === from) on = true;
    else if (r.marker === to) on = false;
    else if (on && r.bytes) slice.push(r);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${slice.map((r) => JSON.stringify(r)).join("\n")}\n`);
  console.log(`extracted ${slice.length} messages → ${outPath}`);
} else if (summaryFile) {
  // Per marker window, show what the APP sent to the pedal: setParam (param → distinct values in
  // order) + counts of any other message kinds. The selector is the param that steps through the
  // options as you click them (e.g. ambience Room→…→Echo Verb ⇒ one param going 0,1,…,6).
  interface Win {
    marker: string;
    params: Map<number, number[]>;
    other: Map<string, number>;
  }
  const newWin = (marker: string): Win => ({ marker, params: new Map(), other: new Map() });
  const wins: Win[] = [newWin("(start)")];
  for (const r of readJsonl(summaryFile)) {
    if (r.marker != null) {
      wins.push(newWin(r.marker));
      continue;
    }
    if (r.dir !== "app->pedal" || !r.bytes) continue;
    const w = wins[wins.length - 1]!;
    const msg = decode(hexToBytes(r.bytes));
    if (msg.kind === "setParam") {
      const seen = w.params.get(msg.param) ?? [];
      if (seen[seen.length - 1] !== msg.value) seen.push(msg.value);
      w.params.set(msg.param, seen);
    } else {
      w.other.set(msg.kind, (w.other.get(msg.kind) ?? 0) + 1);
    }
  }
  for (const w of wins) {
    if (w.params.size === 0 && w.other.size === 0) continue;
    console.log(`\n■ ${w.marker}`);
    for (const [p, vals] of [...w.params.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`   ${hex2(p)} → ${vals.length === 1 ? vals[0] : `[${vals.join(", ")}]`}`);
    }
    for (const [k, n] of w.other) console.log(`   ${k} ×${n}`);
  }
} else if (blobdiffFile) {
  // Diff each 256-byte blob (writePreset / presetDump) against the previous one, labelled by the
  // marker in effect — turns a "drag one control, watch the edit-buffer write" capture into an
  // offset map. Complements --summary for controls that write the blob instead of a live setParam.
  let prev: Uint8Array | null = null;
  let marker = "(start)";
  for (const r of readJsonl(blobdiffFile)) {
    if (r.marker != null) {
      marker = r.marker;
      continue;
    }
    if (!r.bytes) continue;
    const msg = decode(hexToBytes(r.bytes));
    const blob = msg.kind === "writePreset" || msg.kind === "presetDump" ? msg.blob : null;
    if (!blob) continue;
    if (prev) {
      const diffs: string[] = [];
      for (let i = 0; i < blob.length; i++) {
        if (blob[i] !== prev[i]) diffs.push(`${hex2(i)}: ${prev[i]}→${blob[i]}`);
      }
      console.log(`■ ${marker}: ${diffs.length ? diffs.join(", ") : "(no change)"}`);
    }
    prev = blob;
  }
} else {
  console.log(
    "usage:\n" +
      "  npm run replay -- --coverage <capture.jsonl>\n" +
      '  npm run replay -- --extract <capture.jsonl> --between "<A>" "<B>" --out <fixture.jsonl>\n' +
      "  npm run replay -- --summary  <capture.jsonl>   # app→pedal setParams per marker window\n" +
      "  npm run replay -- --blobdiff <capture.jsonl>   # changed blob offsets between writes",
  );
}
