/**
 * What the IR page says about each of its eight rows, and the caption under its graph — the design
 * agreed in lab #62 (layout C plus problem-only tags), kept framework-free so every state is testable.
 *
 * ## The rules
 *
 * - **A row is one line, named by the record.** A read row shows the record's own name (never the
 *   blob's `0xC0` build string, which lies). Before a read, the row says what is there instead of a
 *   generic `IR n`: `Factory cab N` with the switch off, `Your cab` with it on, `No cab stored` once a
 *   read has found the record empty.
 * - **Tags only for problems, only on rows 7 and 8.** `EMPTY` or `READ FAILED`, and only on a user
 *   slot that is switched on, since that is the only place the pedal plays a record a user can lose.
 *   No tag marks a normal state, and rows 1–6 never carry `≈ COPY`: the library copies match the
 *   vendor's cabs within ±1 on every sample, so a tag there would warn about a curve that is right.
 * - **The caption carries the truth.** It explains the cab under the mic: what it is, where its curve
 *   came from (`approximate` for a library-copy proxy), or why there is none. With nothing to draw it
 *   becomes an empty-state panel, amber when something is wrong.
 *
 * ## Where a read's outcome lives
 *
 * {@link IrReadOutcomes} is page state, keyed by record like the curve cache, and never a `PARAMS`
 * entry (the lab #57 rule: an addressing fact with no control of its own is not modelled as a param).
 * A record with a cached curve has been read; one without a curve but with an outcome here is
 * mid-read, came back empty, or failed; one in neither has not been read yet. That third state is what a null-only cache could
 * not tell apart from "nothing stored".
 */
import { type IrSource, LIBRARY_RECORD_BASE } from "../protocol/irSelect";

/** A read that didn't leave a curve: still running, came back empty (erased flash), or never came back. */
export type IrReadOutcome = "reading" | "unwritten" | "failed";

/** Record → the outcome of its last read that left no curve. */
export type IrReadOutcomes = Readonly<Record<number, IrReadOutcome>>;

/** Everything a row can be. `none` is a switched-on user slot whose pointer names no real record. */
export type IrRowAvail = "read" | "unread" | IrReadOutcome | "none";

export type IrRowTag = "EMPTY" | "READ FAILED";

export interface IrRow {
  readonly pos: number;
  readonly source: IrSource | null;
  readonly avail: IrRowAvail;
  readonly label: string;
  /** Set only on rows 7/8 when the slot is switched on and something is wrong. */
  readonly tag: IrRowTag | null;
}

/** What a read of `record` has left behind, given the curve cache and the outcome map. */
function availOf(
  source: IrSource | null,
  hasCurve: (record: number) => boolean,
  outcomes: IrReadOutcomes,
): IrRowAvail {
  if (!source) return "none";
  // A cached curve wins: it is drawn, so the row must describe it. A re-read that is still running
  // leaves the old curve up, and one that comes back empty or broken is the caller's cue to drop it.
  if (hasCurve(source.record)) return "read";
  return outcomes[source.record] ?? "unread";
}

/**
 * Row `pos` (1–8). `nameOf` answers a read record's stored name; a stored name can be an empty string,
 * so the fallback is deliberately on falsiness.
 */
export function irRow(
  pos: number,
  source: IrSource | null,
  hasCurve: (record: number) => boolean,
  nameOf: (record: number) => string | undefined,
  outcomes: IrReadOutcomes,
): IrRow {
  const avail = availOf(source, hasCurve, outcomes);
  const read = avail === "read" && source ? nameOf(source.record) : undefined;
  const label =
    read ||
    (avail === "none" || avail === "unwritten"
      ? "No cab stored"
      : source?.kind === "proxy"
        ? `Factory cab ${pos}`
        : "Your cab");
  // A null source on rows 1–8 can only be a switched-on user slot (see irSourceAt), so it is "played".
  const playedUserSlot = (pos === 7 || pos === 8) && source?.kind !== "proxy";
  const tag: IrRowTag | null = !playedUserSlot
    ? null
    : avail === "unwritten" || avail === "none"
      ? "EMPTY"
      : avail === "failed"
        ? "READ FAILED"
        : null;
  return { pos, source, avail, label, tag };
}

export interface IrCaption {
  readonly title: string;
  readonly body: string;
  /** Amber: something is wrong with what the pedal is (or would be) playing. */
  readonly problem: boolean;
  /** Nothing is drawn for this row, so the caption stands in for the curve as an empty-state panel. */
  readonly empty: boolean;
}

/** The caption for one row. */
export function irCaption(row: IrRow): IrCaption {
  const { pos, label, source } = row;
  switch (row.avail) {
    case "none":
      return {
        title: `${pos} · No cab stored`,
        body: `This preset doesn't point slot ${pos} at a stored cab, so there is nothing to draw.`,
        problem: true,
        empty: true,
      };
    case "unwritten":
      return {
        title: `${pos} · No cab stored`,
        body:
          `This preset points slot ${pos} at one of your own cab records, but nothing was ever ` +
          `stored there.`,
        problem: true,
        empty: true,
      };
    case "failed":
      return {
        title: `${pos} · Couldn't read this cab`,
        body: "The read didn't come back. Pull to try again.",
        problem: true,
        empty: true,
      };
    case "reading":
      return {
        title: `${pos} · ${label} · reading…`,
        body: "Reading this cab off the pedal, about 3 s.",
        problem: false,
        empty: true,
      };
    case "unread":
      return {
        title: `${pos} · ${label} · not read yet`,
        body: "Pull to read this cab off the pedal.",
        problem: false,
        empty: true,
      };
    case "read":
      if (source?.kind === "proxy") {
        return {
          title: `${pos} · ${label} · approximate`,
          body:
            "The pedal plays its factory copy of this cab, which it can't send. The curve is " +
            "drawn from the library copy.",
          problem: false,
          empty: false,
        };
      }
      return {
        title: `${pos} · ${label}`,
        body:
          source && source.record >= LIBRARY_RECORD_BASE
            ? "Library cab, read off the pedal."
            : "Your cab, read off the pedal.",
        problem: false,
        empty: false,
      };
  }
}

/**
 * Which row the caption should describe for IR-select value `morph` (0x0E, slot n at n·16), or null on
 * Off. Normally the row nearest the mic. But when the blend is undrawable because the *other*
 * endpoint has no curve, describe that one instead: it's the reason the graph is empty, and the
 * nearest row's own caption would claim a curve that isn't drawn.
 */
export function captionRowAt(
  morph: number,
  hasCurveAt: (pos: number) => boolean,
  blendDrawn: boolean,
): number | null {
  const rf = morph / 16;
  const nearest = Math.round(rf);
  if (nearest <= 0) return null;
  if (blendDrawn || !hasCurveAt(nearest)) return Math.min(8, nearest);
  const lo = Math.floor(rf);
  const hi = Math.min(8, Math.ceil(rf));
  const other = nearest === lo ? hi : lo;
  return other > 0 && !hasCurveAt(other) ? other : Math.min(8, nearest);
}
