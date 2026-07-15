/**
 * SevenSegment — an LED-style numeric display drawn with plain Views (no font), echoing
 * the pedal's 3-digit readout. Shows digits and "-". RN app surface (tsconfig.json).
 */
import { View } from "react-native";
import { theme } from "./theme";

// segments a,b,c,d,e,f,g per glyph
const GLYPHS: Record<string, [boolean, boolean, boolean, boolean, boolean, boolean, boolean]> = {
  "0": [true, true, true, true, true, true, false],
  "1": [false, true, true, false, false, false, false],
  "2": [true, true, false, true, true, false, true],
  "3": [true, true, true, true, false, false, true],
  "4": [false, true, true, false, false, true, true],
  "5": [true, false, true, true, false, true, true],
  "6": [true, false, true, true, true, true, true],
  "7": [true, true, true, false, false, false, false],
  "8": [true, true, true, true, true, true, true],
  "9": [true, true, true, true, false, true, true],
  "-": [false, false, false, false, false, false, true],
  " ": [false, false, false, false, false, false, false],
};

const ON = theme.accent;
const OFF = "#3a1a17"; // dim red, like an unlit LED segment

function Digit({ char, h }: { char: string; h: number }) {
  const w = h * 0.58;
  const t = Math.max(2, h * 0.1); // segment thickness
  const seg = GLYPHS[char] ?? GLYPHS[" "]!;
  const vH = h / 2 - t * 1.5;
  const s = (on: boolean) => (on ? ON : OFF);
  const bar = { position: "absolute" as const, borderRadius: t / 2 };
  const hor = { ...bar, left: t, width: w - 2 * t, height: t };
  const ver = { ...bar, width: t, height: vH };
  return (
    <View style={{ width: w, height: h, marginHorizontal: h * 0.06 }}>
      <View style={[hor, { top: 0, backgroundColor: s(seg[0]) }]} />
      <View style={[ver, { top: t, right: 0, backgroundColor: s(seg[1]) }]} />
      <View style={[ver, { top: h / 2 + t / 2, right: 0, backgroundColor: s(seg[2]) }]} />
      <View style={[hor, { top: h - t, backgroundColor: s(seg[3]) }]} />
      <View style={[ver, { top: h / 2 + t / 2, left: 0, backgroundColor: s(seg[4]) }]} />
      <View style={[ver, { top: t, left: 0, backgroundColor: s(seg[5]) }]} />
      <View style={[hor, { top: h / 2 - t / 2, backgroundColor: s(seg[6]) }]} />
    </View>
  );
}

export function SevenSegment({ text, height = 30 }: { text: string; height?: number }) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: "#160b0a",
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: 6,
        paddingHorizontal: height * 0.2,
        paddingVertical: height * 0.18,
      }}
    >
      {[...text].map((char, i) => (
        <Digit key={`${i}-${char}`} char={char} h={height} />
      ))}
    </View>
  );
}
