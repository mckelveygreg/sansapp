/**
 * Help — a scroll-only user guide: how to connect the pedal and what each part of the app does.
 * Pure reference content (no pedal needed to read it). RN app surface.
 */
import { ScrollView, Text, View } from "react-native";
import { radius, theme } from "../src/components/theme";

/** A guide section. Lines beginning with "- " render as bullets; others as paragraphs. */
interface Section {
  title: string;
  lines: string[];
}

const GUIDE: Section[] = [
  {
    title: "1 · Connect your pedal",
    lines: [
      "SansApp talks to the pedal over MIDI — either Bluetooth (a CME WIDI Jack) or a wire (the pedal's included MD1 USB adapter). Pick whichever you have, then tap Connect.",
      "- iPhone + Bluetooth: pair the WIDI Jack once in the free CME WIDI app (or GarageBand's Bluetooth-MIDI sheet), then open SansApp and tap Connect.",
      "- iPhone + USB: USB-C (or Lightning + camera adapter) → MD1 → pedal, then tap Connect.",
      "- Android + USB: USB-C → MD1 → pedal, allow the USB prompt, then tap Connect. This is the most reliable path on Android.",
      "- Android + Bluetooth: just tap Connect and allow the Nearby-devices permission — the app finds and opens the WIDI itself (no separate pairing step).",
      "The colored dot by the preset name shows the link. If it goes stale, reconnect from the Connect screen.",
    ],
  },
  {
    title: "2 · Edit your tone",
    lines: [
      "The Editor is the pedal's front panel on your phone: drag a knob up/down to change it. The deep pages (Amp, EQ, Comp, Gate, Auto Filter, Ambience, Chorus) hold the rest.",
      "Edits are live — they change the pedal's current sound (its edit buffer), not any saved preset, until you Save. So tweak freely; nothing is overwritten until you choose a slot.",
    ],
  },
  {
    title: "3 · Cabs & IRs",
    lines: [
      "The pedal has 8 cab/impulse-response slots. Slots 1-6 are the factory cabs; slots 7 and 8 are yours to overwrite — and they're a shared library, so a cab you upload to slot 7 is the same slot 7 for every preset.",
      "In IR Studio you can build a high-pass cab or import a .wav, set that slot's gain, and upload it to slot 7 or 8.",
      "Each preset has a per-slot toggle: off = the preset uses its own cab; on = it uses your custom slot 7/8.",
      "- Custom cab sounds quiet? Raise its per-slot gain in IR Studio.",
    ],
  },
  {
    title: "4 · Presets & backup",
    lines: [
      "The Presets tab browses all 128 presets — rename, copy, or swap them, and save the current sound into any slot.",
      "Backup & Restore exports every preset to a single file you can keep or share with another player; restoring writes them back to the pedal.",
    ],
  },
  {
    title: "5 · Recipes",
    lines: [
      "The Recipes page has curated starting points for specific songs and sounds, mapped to this pedal's controls. Tap Apply to load one into the live edit buffer, then tune by ear and Save it if you like it.",
    ],
  },
  {
    title: "Troubleshooting",
    lines: [
      '- "Pedal not found": make sure the WIDI is paired (iPhone) or the Bluetooth/USB permission is granted (Android), or the MD1 is plugged in. If MIDI won\'t pass over the WIDI, flip its A/B switch — the pedal is Type A.',
      "- A knob does nothing: the link may have dropped. Reconnect on the Connect screen.",
      "- Bulk actions (reading all presets, backup) take ~30 s over Bluetooth — that's normal; there's a progress bar.",
    ],
  },
];

const card = {
  backgroundColor: theme.panel,
  borderColor: theme.panelEdge,
  borderWidth: 1,
  borderRadius: radius,
  padding: 16,
  gap: 8,
} as const;

export default function Help() {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
        A quick guide to connecting your pedal and getting around SansApp.
      </Text>

      {GUIDE.map((section) => (
        <View key={section.title} style={card}>
          <Text style={{ color: theme.text, fontSize: 17, fontWeight: "800" }}>
            {section.title}
          </Text>
          {section.lines.map((line) =>
            line.startsWith("- ") ? (
              <View key={line} style={{ flexDirection: "row", gap: 8 }}>
                <Text style={{ color: theme.accent, fontSize: 13, lineHeight: 19 }}>•</Text>
                <Text style={{ color: theme.textDim, fontSize: 13, lineHeight: 19, flex: 1 }}>
                  {line.slice(2)}
                </Text>
              </View>
            ) : (
              <Text key={line} style={{ color: theme.textDim, fontSize: 13, lineHeight: 19 }}>
                {line}
              </Text>
            ),
          )}
        </View>
      ))}

      <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18, textAlign: "center" }}>
        SansApp is an unofficial, community project — not affiliated with Tech 21.
      </Text>
    </ScrollView>
  );
}
