/**
 * ToneShaper — the combined tone view: every filter in the pedal's tone path on one log-frequency
 * axis, replacing the editor's old EQ-only glance graph. The master line is the summed drive + EQ
 * response from the pedal's own filter model (src/dsp/tone.ts) — exact, absolute dB; each stage is
 * a toggleable overlay in its shared tone color (theme.toneColors). Two stages overlay without
 * being summed, each for its own reason: the cab's curve is relative dB on a nominal rate (unlike
 * the exact model curves), and Soft Clip's HF smoother is level-gated — in the path only while you
 * play — so it draws dashed, and only when Soft Clip is on. Editing stays on the per-effect pages —
 * this is the glance/compare view. The envelope-driven auto-filter and the Comp/Gate dynamics
 * aren't tone filters and aren't drawn. RN app surface.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { logGrid } from "../dsp/ir";
import { cabCurveDb, cabResponseAt, softClipShelfDb, toneResponse } from "../dsp/tone";
import { loadIrCache } from "../midi/irCache";
import { irCurveAt } from "../protocol/irSelect";
import type { ParamId } from "../protocol/params";
import { fitDbWindow } from "../ui/graphWindow";
import type { IrCurve } from "./IrGraph";
import { IrGraph } from "./IrGraph";
import { mixHex, radius, theme, toneColors } from "./theme";

const GRID = logGrid(30, 18000, 140);
const FLAT_DB: readonly number[] = GRID.map(() => 0);
// Soft Clip's shelf is a fixed filter — no knob moves it, so it's computed once.
const CLIP_SHELF_DB: readonly number[] = softClipShelfDb(GRID);
const PAD = 8;

function LegendChip({
  label,
  color,
  on,
  onPress,
}: {
  label: string;
  color: string;
  on: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? color : theme.panelEdge,
        opacity: on ? 1 : 0.55,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color: on ? theme.text : theme.textDim, fontSize: 11 }}>{label}</Text>
    </Pressable>
  );
}

/** `raw` is the loaded preset's 256-byte blob (`pedalStore.raw`) — the cab overlay needs it to know
 * which IR record THIS preset's slot 7/8 plays. Null (nothing recalled) just means no user-slot cab. */
export function ToneShaper({
  values,
  raw,
}: {
  values: Readonly<Partial<Record<ParamId, number>>>;
  raw: Uint8Array | null;
}) {
  const [boxW, setBoxW] = useState(0);
  const [show, setShow] = useState({ eq: true, drive: true, cab: true, clip: true });
  /** IR **record** → its display curve. Record-keyed, like the cache it comes from — a position key
   * is what leaked one preset's cab onto every other (sansapp#68). */
  const [cabDb, setCabDb] = useState<Record<number, number[]>>({});

  // The cab curves come from the IR page's persisted pull cache — nothing is read off the pedal
  // here. No cache yet (or web) just means the cab overlay reads "not pulled".
  useEffect(() => {
    void loadIrCache().then((cached) => {
      if (!cached) return;
      const next: Record<number, number[]> = {};
      for (const [record, s] of Object.entries(cached)) {
        next[Number(record)] = cabCurveDb(s.samples, GRID);
      }
      setCabDb(next);
    });
  }, []);

  const v = (id: ParamId) => values[id] ?? 64;
  const { eq, drive, master } = useMemo(
    () =>
      toneResponse(
        {
          low: v("low"),
          mid: v("mid"),
          high: v("high"),
          freq: v("freq"),
          q: v("q"),
          lowFreq: v("lowFreq"),
          lowQ: v("lowQ"),
          highFreq: v("highFreq"),
          highQ: v("highQ"),
          buzz: v("buzz"),
          buzzQ: v("buzzQ"),
          punch: v("punch"),
          punchFreq: v("punchFreq"),
          punchQ: v("punchQ"),
          presence: v("presence"),
          crunchQ: v("crunchQ"),
        },
        GRID,
      ),
    [values],
  );

  // The active cab at the preset's IR position — resolved through the SHARED selector (irSelect), the
  // same one the IR page uses, so the two views can't drift apart again. It turns each position into
  // the record this preset actually plays and looks that up by record.
  const morph = values.irBlend ?? 0;
  const mode7 = (values.irMode7 ?? 0) > 0;
  const mode8 = (values.irMode8 ?? 0) > 0;
  const cab = useMemo(
    () =>
      cabResponseAt(
        morph,
        irCurveAt(raw, { 7: mode7, 8: mode8 }, (r) => cabDb[r]),
        FLAT_DB,
      ),
    [morph, cabDb, raw, mode7, mode8],
  );

  // Soft Clip's HF smoother is in the path only while the level gate holds it in — and only when
  // Soft Clip is on at all, so with it off (or unknown) the stage isn't drawn or listed.
  const clipOn = (values.softClip ?? 0) > 0;

  // The dB window fits the exact model curves only. The cab and Soft Clip overlays are excluded
  // on purpose — a cab's HF rolloff and the shelf's −24 dB floor would blow out any useful scale
  // (they clamp at the floor, like on the IR page).
  const { dbTop, dbBot } = fitDbWindow([master, eq, drive], 15, -15);

  const driveColor = mixHex(toneColors.drive.from, toneColors.drive.to, v("presence") / 127);
  const curves: IrCurve[] = [
    ...(show.cab && cab ? [{ db: cab, color: toneColors.cab, width: 1.6, opacity: 0.7 }] : []),
    ...(clipOn && show.clip
      ? [{ db: CLIP_SHELF_DB, color: toneColors.softClip, width: 1.6, opacity: 0.8, dash: "6 4" }]
      : []),
    ...(show.eq ? [{ db: eq, color: toneColors.eq, width: 1.6, opacity: 0.7 }] : []),
    ...(show.drive ? [{ db: drive, color: driveColor, width: 1.6, opacity: 0.7 }] : []),
    { db: master, color: theme.text, width: 2.6 },
  ];

  const cabUnknown = morph > 0 && !cab;
  const toggle = (key: "eq" | "drive" | "cab" | "clip") => () =>
    setShow((s) => ({ ...s, [key]: !s[key] }));

  return (
    <View style={{ gap: 10 }}>
      <View
        onLayout={(e) => setBoxW(e.nativeEvent.layout.width)}
        style={{
          backgroundColor: theme.bg,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: PAD,
        }}
      >
        {boxW > 0 ? (
          <IrGraph
            grid={GRID}
            curves={curves}
            width={boxW - PAD * 2 - 2}
            height={150}
            dbTop={dbTop}
            dbBot={dbBot}
          />
        ) : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <LegendChip label="Master" color={theme.text} on />
        <LegendChip label="EQ" color={toneColors.eq} on={show.eq} onPress={toggle("eq")} />
        <LegendChip label="Drive" color={driveColor} on={show.drive} onPress={toggle("drive")} />
        <LegendChip label="Cab" color={toneColors.cab} on={show.cab} onPress={toggle("cab")} />
        {clipOn ? (
          <LegendChip
            label="Soft Clip"
            color={toneColors.softClip}
            on={show.clip}
            onPress={toggle("clip")}
          />
        ) : null}
      </View>
      <Text style={{ color: theme.textDim, fontSize: 11, lineHeight: 16 }}>
        {cabUnknown
          ? "The active cab's curve isn't pulled yet — open the IR Studio and Pull from pedal to see its shape here. "
          : ""}
        Master sums the drive voicing + EQ — the pedal's static tone stages, from its own filter
        model. The cab overlays its own relative shape (not summed).
        {clipOn
          ? " Soft Clip's dashed shelf smooths the top octave only while you play — it lifts off in silence, so it overlays rather than sums."
          : ""}{" "}
        The envelope-driven filter and dynamics aren&apos;t tone filters, so they aren&apos;t drawn.
      </Text>
    </View>
  );
}
