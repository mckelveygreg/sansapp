/**
 * Build-time feature flags, inlined by Metro from `EXPO_PUBLIC_*` env vars (undefined when unset, so
 * the disabled branch is dead-code-eliminated in production).
 *
 * `recipes` is an in-progress, personal feature that isn't part of the public app. Set
 * `EXPO_PUBLIC_ENABLE_RECIPES=1` in `.env.local` before building to include it; unset — the default,
 * and every TestFlight / App Store build — hides its entry point and turns the route into a redirect.
 *
 * Framework-free: no React / React Native / Expo imports.
 */
export const FEATURES = {
  recipes: process.env.EXPO_PUBLIC_ENABLE_RECIPES === "1",
} as const;
