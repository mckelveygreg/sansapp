/**
 * App Store screenshot harness — no UITest target, no fastlane snapshot, no hardware.
 *
 * Builds the app for the 6.9" simulator, launches it standalone (the embedded Release bundle, which
 * bypasses the expo-dev-client launcher and its deep-link confirmation prompt), loads synthetic demo
 * state via `sansapp://connect?demo=1`, deep-links through the key screens, and captures each with
 * `simctl io screenshot` into fastlane/screenshots/en-US/ at App Store resolution.
 *
 *   npm run screenshots            # app already installed on the simulator
 *   npm run screenshots -- --build # build + install first (expo run:ios, slow)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DEVICE = "iPhone 16 Pro Max"; // 1320×2868 — ASC's required 6.9" size
const BUNDLE_ID = "com.mckelveygreg.sansapp";
const SCHEME = "sansapp";
const OUT_DIR = resolve("fastlane", "screenshots", "en-US");
const DEMO_WAIT_MS = 3500; // demo hydrate + first render
const SCREEN_WAIT_MS = 2500; // navigation + graph render
// route "" is the editor tab (index); the rest are pushed/tab routes.
const SCREENS: { route: string; file: string }[] = [
  { route: "", file: "01_editor" },
  { route: "presets", file: "02_presets" },
  { route: "ir", file: "03_ir" },
  { route: "amp", file: "04_amp" },
  { route: "backup", file: "05_backup" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const simctl = (...args: string[]) =>
  execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

function findUdid(): string {
  const list = JSON.parse(simctl("list", "devices", "--json")) as {
    devices: Record<string, { name: string; udid: string; isAvailable: boolean }[]>;
  };
  const device = Object.values(list.devices)
    .flat()
    .find((d) => d.isAvailable && d.name === DEVICE);
  if (!device) throw new Error(`Simulator "${DEVICE}" not found — install it via Xcode.`);
  return device.udid;
}

async function main() {
  const udid = findUdid();
  console.log(`Simulator: ${DEVICE} (${udid})`);
  try {
    simctl("boot", udid);
  } catch {
    // already booted
  }
  simctl("bootstatus", udid, "-b");
  execFileSync("open", ["-a", "Simulator"]);

  if (process.argv.includes("--build")) {
    console.log("Building Release app for the simulator (slow)…");
    // Builds + installs, then returns. --no-bundler is essential: a Release build embeds the JS
    // bundle, so Metro isn't needed — and without this flag `expo run:ios` starts Metro and blocks
    // forever streaming logs instead of returning. We relaunch standalone below regardless.
    execFileSync(
      "npx",
      ["expo", "run:ios", "--configuration", "Release", "--no-bundler", "--device", DEVICE],
      { stdio: "inherit" },
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // Relaunch standalone: the embedded Release bundle loads without Metro and without the dev-client
  // deep-link confirmation dialog, so `openurl` navigation is unattended.
  try {
    simctl("terminate", udid, BUNDLE_ID);
  } catch {
    // not running
  }
  simctl("launch", udid, BUNDLE_ID);
  await sleep(2000);

  try {
    // The classic pristine status bar (9:41, full battery/signal). Cleared in the finally block.
    const statusBar = [
      "--time",
      "9:41",
      "--batteryLevel",
      "100",
      "--batteryState",
      "charged",
      "--wifiBars",
      "3",
      "--cellularBars",
      "4",
    ];
    simctl("status_bar", udid, "override", ...statusBar);

    // Terminate before capturing so the run starts from a COLD launch on the editor tab.
    //
    // `SCREENS[0]` is `route: ""`, which is not a navigation — deep-linking the bare scheme leaves an
    // already-running app exactly where it was. That is invisible on a clean run (a fresh launch lands
    // on the editor anyway) and silently wrong on any run where the app was already open on another
    // screen: every capture shifts and `01_editor.png` gets whatever was on screen. Reproduced
    // 2026-08-17 after an interrupted run left the app on the amp page, which then shipped as the
    // editor screenshot. Terminating makes the first capture deterministic instead of incidental.
    try {
      simctl("terminate", udid, BUNDLE_ID);
    } catch {
      /* not running — nothing to terminate, which is the state we want anyway */
    }
    await sleep(500);
    // Then LAUNCH it normally before any deep link. Cold-starting via `openurl` instead makes iOS
    // open the app to handle the URL, and the linked route comes up as a sheet over an empty root —
    // every screenshot then carries a rounded card inset below the status bar, which reads as a
    // rendering fault on the App Store listing. Launching first gives the normal full-screen root,
    // and the deep links navigate inside it.
    simctl("launch", udid, BUNDLE_ID);
    await sleep(2000);

    console.log("Loading demo state…");
    simctl("openurl", udid, `${SCHEME}://connect?demo=1`);
    await sleep(DEMO_WAIT_MS);

    for (const { route, file } of SCREENS) {
      simctl("openurl", udid, `${SCHEME}://${route}`);
      await sleep(SCREEN_WAIT_MS);
      const path = join(OUT_DIR, `${file}.png`);
      simctl("io", udid, "screenshot", "--type=png", path);
      console.log(`  captured ${file}.png`);
    }
  } finally {
    simctl("status_bar", udid, "clear");
  }
  console.log(`\nDone — ${SCREENS.length} screenshots in ${OUT_DIR}/ (deliver uploads them).`);
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
