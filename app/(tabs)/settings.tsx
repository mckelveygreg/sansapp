/** Settings / about. RN app surface. */
import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Link } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Switch, Text, View } from "react-native";
import { radius, theme } from "../../src/components/theme";
import { getPrefs, loadPrefs, savePrefs } from "../../src/midi/prefs";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: theme.panel,
        borderColor: theme.panelEdge,
        borderWidth: 1,
        borderRadius: radius,
        padding: 14,
        gap: 6,
      }}
    >
      <Text style={{ color: theme.text, fontWeight: "600" }}>{title}</Text>
      {children}
    </View>
  );
}

function LinkRow({
  href,
  icon,
  label,
}: {
  href: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <Link href={href} asChild>
      <Pressable
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          backgroundColor: theme.panel,
          borderColor: theme.panelEdge,
          borderWidth: 1,
          borderRadius: radius,
          padding: 14,
        }}
      >
        <Ionicons name={icon} color={theme.textDim} size={20} />
        <Text style={{ color: theme.text, flex: 1 }}>{label}</Text>
        <Ionicons name="chevron-forward" color={theme.textDim} size={18} />
      </Pressable>
    </Link>
  );
}

/**
 * App behaviour the player can change. Distinct from Device Settings, which writes to the pedal —
 * nothing here leaves the phone.
 */
function BehaviourCard() {
  // The cache is already warm by the time anyone taps this tab; the load is for the cold start that
  // lands here directly. `touched` keeps that late answer from overwriting a toggle made meanwhile.
  const [guard, setGuard] = useState(() => getPrefs().unsavedGuard);
  const touched = useRef(false);
  useEffect(() => {
    void loadPrefs().then((p) => {
      if (!touched.current) setGuard(p.unsavedGuard);
    });
  }, []);

  const onChange = (v: boolean) => {
    touched.current = true;
    setGuard(v);
    void savePrefs({ unsavedGuard: v });
  };

  return (
    <Card title="Behaviour">
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text }}>Confirm before switching presets</Text>
          <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 2, lineHeight: 17 }}>
            Ask what to do with unsaved edits when you change preset. Off: edits are discarded.
          </Text>
        </View>
        <Switch
          value={guard}
          onValueChange={onChange}
          trackColor={{ false: theme.panelEdge, true: theme.accent }}
          thumbColor="#ffffff"
        />
      </View>
    </Card>
  );
}

export default function Settings() {
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      {/* Tone/effect pages now live in the editor's section bar. Settings keeps device + data. */}
      <LinkRow href="/connect" icon="bluetooth-outline" label="Connection" />
      <LinkRow href="/device" icon="construct-outline" label="Device Settings" />
      <LinkRow href="/backup" icon="save-outline" label="Backup & Restore" />
      <LinkRow href="/diagnostics" icon="pulse-outline" label="MIDI Log" />
      <LinkRow href="/help" icon="help-circle-outline" label="Help & Guide" />
      <BehaviourCard />
      <Card title="SansApp">
        <Text style={{ color: theme.textDim, lineHeight: 20 }}>
          A free, open-source editor for the SansAmp Programmable Bass Driver DI Elite. Tweak your
          tone from your phone. GPL-3.0.
        </Text>
      </Card>
      <Card title="Unofficial">
        <Text style={{ color: theme.textDim, lineHeight: 20 }}>
          Not affiliated with, authorized, or endorsed by Tech 21 USA, Inc. "SansAmp", "Bass
          Driver", and "Tech 21" are trademarks of their owner, used only to describe compatibility.
        </Text>
      </Card>
      <Card title="Version">
        <Text style={{ color: theme.textDim }}>
          {Constants.expoConfig?.version ?? "unknown"}
          {Application.nativeBuildVersion ? ` (${Application.nativeBuildVersion})` : ""} · edit live
          over MIDI (USB or Bluetooth)
        </Text>
      </Card>
    </ScrollView>
  );
}
