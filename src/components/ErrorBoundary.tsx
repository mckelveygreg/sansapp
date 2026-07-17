/**
 * Last-resort backstop: catches errors thrown during React render/lifecycle so an unexpected failure
 * shows a recoverable screen instead of a blank white crash. It does NOT catch async or event-handler
 * errors (React error boundaries never do) — those are handled at their source in the MIDI session
 * (fire-and-forget sends swallow a dead-port throw; recalls are `.catch`-ed).
 */
import { Component, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { theme } from "./theme";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  private dismiss = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.bg,
          padding: 24,
          justifyContent: "center",
          gap: 16,
        }}
      >
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>
          Something went wrong
        </Text>
        <Text style={{ color: theme.textDim }}>
          The screen hit an unexpected error. Dismiss to try again — if it persists, disconnect and
          reconnect the pedal.
        </Text>
        <ScrollView
          style={{ maxHeight: 180, backgroundColor: theme.panel, borderRadius: 10 }}
          contentContainerStyle={{ padding: 12 }}
        >
          <Text style={{ color: theme.textDim, fontSize: 12 }}>{error.message}</Text>
        </ScrollView>
        <Pressable
          onPress={this.dismiss}
          style={{
            backgroundColor: theme.accent,
            padding: 14,
            borderRadius: 10,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.text, fontWeight: "800" }}>Dismiss</Text>
        </Pressable>
      </View>
    );
  }
}
