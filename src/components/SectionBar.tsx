/**
 * SectionBar — a horizontal row of chips near the top of the editor that jump straight to each deep
 * tone/effect page. Makes the deep controls one obvious tap from where you edit, instead of buried
 * in Settings. RN app surface.
 */
import { Link } from "expo-router";
import { Pressable, ScrollView, Text } from "react-native";
import { FEATURES } from "../config/features";
import { radius, theme } from "./theme";

// Alphabetical by label. Recipes stays last (its natural alphabetical slot) and is hidden unless the
// EXPO_PUBLIC_ENABLE_RECIPES flag is on — it's a personal, in-progress feature (see config/features).
const SECTIONS = [
  { href: "/ambience", label: "Ambience" },
  { href: "/amp", label: "Amp" },
  { href: "/chorus", label: "Chorus" },
  { href: "/comp", label: "Dynamics" },
  { href: "/eq", label: "EQ" },
  { href: "/filter", label: "Filter" },
  { href: "/ir", label: "IR Studio" },
  { href: "/recipes", label: "Recipes" },
] as const;

const visibleSections = SECTIONS.filter((s) => s.href !== "/recipes" || FEATURES.recipes);

export function SectionBar() {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {visibleSections.map((s) => (
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
