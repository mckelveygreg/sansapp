/** Dark, pedal-inspired theme tokens (original — evokes the hardware, copies nothing). */
export const theme = {
  bg: "#0e0e10",
  panel: "#1a1a1d",
  panelEdge: "#2c2c30",
  text: "#f0f0f2",
  textDim: "#9a9a9e",
  accent: "#e0483d", // "Red Zone" red
  green: "#2a8a3e",
  amber: "#d0a03a",
  knob: "#1c1c1e",
  knobEdge: "#3a3a3c",
} as const;

/**
 * Tone-domain color language — one stable hue per tone domain, shared by every response graph
 * (the home Tone Shaper, the EQ page, the Amp Voice Print, the auto-filter page, the IR/cab page) and by
 * any combined view that overlays them. This map is the single source of truth: graphs read their
 * curve colors from here, never from a local literal, so a hue means the same domain on every page.
 * Hues are CVD-checked as a set against `theme.bg` (all pairs ΔE ≥ 8 under protan/deutan
 * simulation, ≥ 3:1 contrast) — re-check before adding or changing one.
 */
export const toneColors = {
  /** Parametric EQ (Low/Mid/High) — the app's historical amber. */
  eq: theme.amber,
  /** Drive / Presence voicing — the Voice Print's warm gradient, amber (low) → hot near-white. */
  drive: { from: theme.amber, to: "#fffceb" },
  /** Cab / IR response curves — a cool teal, so a cab never reads as EQ. */
  cab: "#2ba59a",
  /** Auto-filter sweep — its own violet, distinct from the EQ's amber. */
  autoFilter: "#8d7ce6",
  /** Soft Clip's level-gated HF smoother — a dark magenta: warm like the "hot signal" that engages
   * it, but well clear of the accent red (an interaction/status color, never a curve). */
  softClip: "#993f94",
} as const;

/** Linear mix of two #rrggbb colors, t in 0..1 (e.g. the drive gradient's Presence tint). */
export function mixHex(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const ch = (i: number) => {
    const av = parseInt(a.slice(i, i + 2), 16);
    const bv = parseInt(b.slice(i, i + 2), 16);
    return Math.round(av + (bv - av) * k);
  };
  return `rgb(${ch(1)},${ch(3)},${ch(5)})`;
}

export const radius = 12;
export const gap = 14;
