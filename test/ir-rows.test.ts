/**
 * The IR page's row and caption model (lab #62 → lab #75): seven states a user slot can be in, named
 * by the record, tagged only when something is wrong, with the caption carrying the provenance.
 */
import { describe, expect, it } from "vitest";
import type { IrSource } from "../src/protocol/irSelect";
import { type IrReadOutcomes, captionRowAt, irCaption, irRow } from "../src/ui/irRows";

const NAMES: Record<number, string> = { 262: "Voice 12L", 260: "Concert 2x15", 5: "My HP cab" };
const row = (
  pos: number,
  source: IrSource | null,
  read: readonly number[] = [],
  outcomes: IrReadOutcomes = {},
) =>
  irRow(
    pos,
    source,
    (r) => read.includes(r),
    (r) => NAMES[r],
    outcomes,
  );

const proxy = (record: number): IrSource => ({ record, kind: "proxy" });
const played = (record: number): IrSource => ({ record, kind: "played" });

describe("irRow — every state a row can be in", () => {
  it("names a read row by its record, and tags nothing", () => {
    expect(row(7, played(5), [5])).toMatchObject({ label: "My HP cab", avail: "read", tag: null });
    expect(row(7, played(260), [260])).toMatchObject({ label: "Concert 2x15", tag: null });
    expect(row(7, proxy(262), [262])).toMatchObject({ label: "Voice 12L", tag: null });
  });

  it("says what is there before a read, never `IR n`", () => {
    expect(row(3, proxy(258)).label).toBe("Factory cab 3");
    expect(row(7, proxy(262)).label).toBe("Factory cab 7"); // switch off
    expect(row(7, played(5)).label).toBe("Your cab"); // switch on
    expect(row(7, played(5)).avail).toBe("unread");
  });

  it("falls back on an empty stored name rather than rendering a blank row", () => {
    const r = irRow(
      4,
      proxy(259),
      () => true,
      () => "",
      {},
    );
    expect(r.label).toBe("Factory cab 4");
  });

  it("tags EMPTY when the probe found nothing stored, and renames the row", () => {
    const r = row(8, played(132), [], { 132: "unwritten" });
    expect(r).toMatchObject({ label: "No cab stored", avail: "unwritten", tag: "EMPTY" });
  });

  it("tags EMPTY for a switched-on slot whose pointer names no real record", () => {
    expect(row(7, null)).toMatchObject({ label: "No cab stored", avail: "none", tag: "EMPTY" });
  });

  it("tags READ FAILED, keeping the row's name", () => {
    expect(row(7, played(5), [], { 5: "failed" })).toMatchObject({
      label: "Your cab",
      tag: "READ FAILED",
    });
  });

  it("never tags rows 1–6 or a switched-off user slot, whatever their read did", () => {
    expect(row(3, proxy(258), [], { 258: "failed" }).tag).toBeNull();
    expect(row(7, proxy(262), [], { 262: "failed" }).tag).toBeNull();
  });

  it("lets a drawn curve outrank a stale outcome — the row describes what is on the graph", () => {
    expect(row(7, played(5), [5], { 5: "reading" }).avail).toBe("read");
  });
});

describe("irCaption", () => {
  it("marks a proxy as approximate, and only in the caption", () => {
    const c = irCaption(row(7, proxy(262), [262]));
    expect(c.title).toBe("7 · Voice 12L · approximate");
    expect(c).toMatchObject({ problem: false, empty: false });
  });

  it("says where a real reading came from", () => {
    expect(irCaption(row(7, played(5), [5])).body).toBe("Your cab, read off the pedal.");
    expect(irCaption(row(7, played(260), [260])).body).toBe("Library cab, read off the pedal.");
  });

  it("turns into an empty-state panel, amber only for a problem", () => {
    expect(irCaption(row(7, played(5)))).toMatchObject({ empty: true, problem: false });
    expect(irCaption(row(7, played(5), [], { 5: "reading" }))).toMatchObject({
      empty: true,
      problem: false,
    });
    for (const o of ["unwritten", "failed"] as const) {
      expect(irCaption(row(7, played(5), [], { 5: o }))).toMatchObject({
        empty: true,
        problem: true,
      });
    }
    expect(irCaption(row(8, null))).toMatchObject({ empty: true, problem: true });
  });
});

describe("captionRowAt", () => {
  const has =
    (...pos: number[]) =>
    (p: number) =>
      pos.includes(p);

  it("is null on Off and describes the nearest row otherwise", () => {
    expect(captionRowAt(0, has(), true)).toBeNull();
    expect(captionRowAt(6, has(), true)).toBeNull(); // nearer Off than row 1
    expect(captionRowAt(112, has(7), true)).toBe(7);
    expect(captionRowAt(127, has(8), true)).toBe(8);
  });

  it("describes the missing endpoint when that is what left the graph empty", () => {
    // Mic between 7 (drawn) and 8 (unread), nearer 7: the caption explains row 8.
    expect(captionRowAt(118, has(7), false)).toBe(8);
    // Both missing: the nearest row is the one to explain.
    expect(captionRowAt(118, has(), false)).toBe(7);
  });
});
