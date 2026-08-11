import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Forks (the default pool) hang on macOS when preset.test.ts's local-only block probes the
    // desktop editor's sandboxed app-container path — see #46. Threads don't hit that TCC wall,
    // and nothing here depends on process isolation.
    pool: "threads",
  },
});
