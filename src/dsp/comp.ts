/**
 * Compressor static transfer curve (input dB → output dB) for the Compressor page's graph.
 * Soft-knee gain computer — the standard model. Attack/release/lookahead are time-domain and
 * don't change this static curve; ratio, threshold, knee and make-up (output gain) do.
 * Framework-free.
 */

export interface CompParams {
  thresholdDb: number;
  ratio: number;
  /** Soft-knee width in dB (0 = hard knee). */
  kneeDb?: number;
  /** Output / make-up gain in dB, applied after compression. */
  makeupDb?: number;
}

/** Output level (dB) for one input level (dB). */
export function compressorOutDb(inDb: number, p: CompParams): number {
  const ratio = Math.max(1, p.ratio);
  const knee = Math.max(0, p.kneeDb ?? 6);
  const makeup = p.makeupDb ?? 0;
  const over = inDb - p.thresholdDb;
  let out: number;
  if (knee > 0 && 2 * over > -knee && 2 * over < knee) {
    // quadratic soft knee
    const x = over + knee / 2;
    out = inDb + (1 / ratio - 1) * ((x * x) / (2 * knee));
  } else if (over <= 0) {
    out = inDb; // below threshold: unity
  } else {
    out = p.thresholdDb + over / ratio; // above threshold: compressed
  }
  return out + makeup;
}

/** Noise-gate (downward expander) below its threshold: ratio 1 = off (unity), higher = steeper. */
export interface GateParams {
  thresholdDb: number;
  ratio: number;
}

/**
 * Combined dynamics transfer curve, matching EliteControl's graph: the GATE expands steeply below
 * its (lower) threshold — left dot + left segment (angle = gate ratio) — the signal passes at unity
 * between the two thresholds, and the COMPRESSOR compresses above its (higher) threshold — right dot
 * + right segment (angle = comp ratio). The gate is skipped when omitted or its ratio is ≤ 1.
 */
export function dynamicsOutDb(inDb: number, comp: CompParams, gate?: GateParams): number {
  if (gate && gate.ratio > 1 && inDb < gate.thresholdDb) {
    return gate.thresholdDb + (inDb - gate.thresholdDb) * gate.ratio + (comp.makeupDb ?? 0);
  }
  return compressorOutDb(inDb, comp);
}

/** Sample the transfer curve across `inputDb`. */
export function compressorCurve(inputDb: readonly number[], p: CompParams): number[] {
  return inputDb.map((i) => compressorOutDb(i, p));
}

/** Gain reduction (dB, ≤ 0) applied at a given input level — useful for a meter. */
export function gainReductionDb(inDb: number, p: CompParams): number {
  return compressorOutDb(inDb, { ...p, makeupDb: 0 }) - inDb;
}
