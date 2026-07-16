# Releasing SansApp (App Store + Google Play)

Roll-your-own [fastlane](https://fastlane.tools) — no EAS, no paid Expo service. Everything runs on
your Mac against the `ios/` project that `expo prebuild` generates. Signing uses **`match`**, which
keeps the signing certs and profiles encrypted in a private git repo — no manual `.p12` juggling.

## What's already set up in the repo

- `app.config.ts` — bundle id `com.mckelveygreg.sansapp`, version `1.0.0`, build `1`, the Bluetooth
  usage strings, and `ITSAppUsesNonExemptEncryption=false` (skips the export-compliance prompt).
- No `Gemfile`/bundler — install fastlane with Homebrew (`brew install fastlane`); it bundles its own Ruby.
- `fastlane/` — `Fastfile` (iOS lanes `certs`/`beta`/`release` + Android lanes `beta`/`release`),
  `Appfile`, `Matchfile`, `Gymfile`,
  `Deliverfile`, `Snapfile`, and `metadata/` (App Store name, subtitle, description, keywords,
  release notes, URLs, category, and App Review notes).
- `PRIVACY.md` — the privacy policy (App Store requires a reachable URL; the metadata points at the
  GitHub copy).

## One-time prerequisites (needs your Apple login — I couldn't do these for you)

1. **Apple Developer Program** membership ($99/yr) and an **App Store Connect** account.
2. A **private git repo** to hold the signing material, e.g. `mckelveygreg/sansapp-certs` (empty is
   fine). This is what `match` writes to.
3. Install fastlane: `brew install fastlane` (bundles its own Ruby). Also `brew install cocoapods` if you don't have it, plus Xcode command-line tools.
4. Copy **`.env.example` → `.env.local`** (git-ignored) and fill it in. The Fastfile loads it, so
   there's no `source` step — just run the lanes from the project directory. (It must be
   `.env.local`, not `.env`: Expo CLI refuses to load personal secrets — like the Apple
   app-specific password — from a non-`.local` env file, and the lanes shell out to
   `expo prebuild`.)
   ```sh
   FASTLANE_APPLE_ID                             # email on your Apple Developer account
   FASTLANE_TEAM_ID                              # Apple Developer team id (portal → Membership)
   MATCH_GIT_URL                                 # the private certs repo from step 2
   MATCH_PASSWORD                                # a strong passphrase that encrypts that repo
   FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD  # account.apple.com → App-Specific Passwords (binary upload)
   ```
5. **Register the app once** — creates the App ID on the Developer Portal _and_ the App Store
   Connect record (match needs the App ID before it can make a profile): `fastlane ios register`.
   App Store _display names_ must be globally unique — if "SansApp" is taken, change `app_name` in
   the `register` lane (the bundle id stays the same).

## Create the signing certs (once, interactive — Apple 2FA)

```sh
MATCH_READONLY=false fastlane ios certs
```

This creates the distribution certificate + App Store provisioning profile and stores them
(encrypted) in your `sansapp-certs` repo. After this, `beta`/`release` fetch them read-only, so it
works unattended. No Xcode signing setup is needed: `expo prebuild` regenerates `ios/` with no
team or profile, so the `sync_signing` lane re-applies manual signing (team, `Apple Distribution`,
the match profile) to the fresh project on every build.

## Screenshots

App Store requires one **6.9"** iPhone screenshot set (1320×2868; iPhone-only app, so no iPad set).
Automated — no UITest target:

```sh
fastlane ios screenshots    # or: npm run screenshots -- --build
```

This boots the iPhone 16 Pro Max simulator, builds the app, starts the pedal emulator
(`tools/emulate.ts` — the simulator shares the Mac's CoreMIDI, so the app genuinely connects),
deep-links through the key screens (`sansapp://connect?auto=1` connects without a tap), and
captures Editor, Presets, IR, Amp, and Backup into `fastlane/screenshots/en-US/`. `deliver`
uploads whatever is in that directory. Re-run it whenever the UI changes.

(If you later add a UITest target, `fastlane snapshot` via `Snapfile` is the heavier alternative.)

## Ship it

```sh
fastlane ios beta       # build + upload to TestFlight
fastlane ios release    # build + upload binary & metadata to App Store Connect
```

Neither lane auto-submits — you review and press **Submit for Review** in App Store Connect. Bump
`ios.buildNumber` (or let `beta` auto-increment against TestFlight) and `version` in `app.config.ts`
for later releases.

To tweak store listing text or screenshots for a build that's **already uploaded**, skip the
rebuild:

```sh
fastlane ios metadata            # push text metadata only (keywords, description, notes)
fastlane ios screenshots_upload  # push screenshots only
```

Splitting them means a flaky screenshot upload (App Store Connect's API sometimes 500s and retries
forever) can't block a text-only change.

## Google Play (Android)

Android ships the same way — local fastlane, no cloud — but with Gradle + `supply` instead of Xcode.
`android/` is regenerated by `expo prebuild`, so signing is injected at build time via Gradle
properties (nothing sensitive is committed). Android is at the community-testing stage; a TestFlight
equivalent (the internal track) is the right place to start.

**One-time:**

1. A **Google Play Developer** account ($25 once) with an app created for package
   `com.mckelveygreg.sansapp`.
2. An **upload keystore** — and back it up, because losing it means you can't update the app:
   ```sh
   keytool -genkeypair -v -keystore sansapp-upload.keystore -alias sansapp \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
3. A **Play service-account JSON** with the "Release" permission (Play Console → Setup → API access),
   for unattended uploads.
4. Environment variables (in the same git-ignored `.env.local`):
   ```sh
   export ANDROID_KEYSTORE_PATH="/abs/path/sansapp-upload.keystore"
   export ANDROID_KEYSTORE_PASSWORD="…"
   export ANDROID_KEY_ALIAS="sansapp"
   export ANDROID_KEY_PASSWORD="…"
   export ANDROID_PLAY_JSON_KEY="/abs/path/play-service-account.json"
   ```

**Ship it:**

```sh
fastlane android beta      # signed AAB → Play internal testing track
fastlane android release   # signed AAB → production (staged as a draft)
```

Google requires the **very first** AAB to be uploaded by hand in the Play Console (the API can't
create the initial release); after that the lanes run unattended. Bump `android.versionCode` (and
`version`) in `app.config.ts` for each release.

## Gotchas

- **App Review needs the hardware.** SansApp's editing needs the physical pedal + a MIDI adapter,
  which the reviewer won't have. `fastlane/metadata/review_information/notes.txt` explains that every
  screen is browsable without a pedal and no account/data is involved — keep that note current.
- **Icon alpha.** `assets/icon.png` has an alpha channel; Expo flattens the App Store icon on
  prebuild. If ASC ever rejects the 1024² icon for transparency, flatten it:
  `sips -s format png assets/icon.png --out /tmp/i.png` then composite onto an opaque background.
- **Bundle id** must match everywhere (`app.config.ts`, `Appfile`, `Matchfile`, ASC).
