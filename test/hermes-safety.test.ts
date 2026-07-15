import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hermes (React Native's JS engine) lacks several ES2023 Array methods that Node/JSC have. Using
 * them passes every Node test but throws "undefined is not a function" in the on-device build — this
 * is exactly what crashed IR Studio + Auto Filter (frequencyResponse used `.toSorted`). Guard the
 * shipped code (app/ + src/); tools/ is exempt because it only runs under Node.
 */
const BANNED = [".toSorted(", ".toReversed(", ".toSpliced("];
const ROOTS = ["app", "src"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("Hermes compatibility", () => {
  it("ships no ES2023 array methods Hermes lacks (they crash on-device, not in tests)", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        for (const m of BANNED) if (src.includes(m)) offenders.push(`${file} → ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
