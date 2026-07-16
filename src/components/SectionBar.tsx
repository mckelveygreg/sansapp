/**
 * SectionBar — a horizontal row of chips near the top of the editor that jump straight to each deep
 * tone/effect page. Makes the deep controls one obvious tap from where you edit, instead of buried
 * in Settings. RN app surface.
 */
import { Link } from "expo-router";
import { Pressable, ScrollView, Text } from "react-native";
import { radius, theme } from "./theme";

const SECTIONS = [
  { href: "/amp", label: "Amp" },
  { href: "/eq", label: "EQ" },
  { href: "/comp", label: "Dynamics" },
  { href: "/filter", label: "Filter" },
  { href: "/ambience", label: "Ambience" },
  { href: "/chorus", label: "Chorus" },
  { href: "/ir", label: "IR Studio" },
  { href: "/recipes", label: "Recipes" },
] as const;

export function SectionBar() {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {SECTIONS.map((s) => (
        <Link key={s.href} href={s.href} asChild>
          <Pressable
            style={{
              backgroundColor: theme.panel,
              borderColor: theme.panelEdge,
              borderWidth: 1,
              borderRadius: radius,
              paddingHorizontal: 14,
              paddingVertical: 8,
            }}
          >
            <Text
              style={{ color: theme.text, fontWeight: "600", fontSize: 13, letterSpacing: 0.3 }}
            >
              {s.label}
            </Text>
          </Pressable>
        </Link>
      ))}
    </ScrollView>
  );
}
