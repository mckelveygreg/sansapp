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

## Cutting a release, step by step

1. Bump `version` (and `ios.buildNumber`/`android.versionCode` if needed) in `app.config.ts`.
2. Write the changelog: edit `fastlane/metadata/en-US/release_notes.txt` to describe what's new
   since the last version — this is what ships to `fastlane ios metadata` / `release` below.
3. If the UI changed, regenerate screenshots: `fastlane ios screenshots` (see below).
4. `fastlane ios beta` — builds and uploads to TestFlight.
5. `fastlane ios metadata` and `fastlane ios screenshots_upload` — push the changelog + screenshots
   to the App Store Connect version you're preparing (safe to re-run; see Gotchas for why
   `overwrite_screenshots` matters here).
6. In App Store Connect: attach the TestFlight build from step 4 to the version, then press
   **Submit for Review** yourself. Nothing in this repo's fastlane setup submits automatically.
7. Once Apple approves it, **you must still act while it's in a pre-live state** — see the
   "screenshots are frozen once live" gotcha below. There is no fixing metadata/screenshots after
   the version reaches `READY_FOR_SALE`; if you spot a problem, fix it before then, or plan on a
   follow-up version.

## Screenshots

App Store requires one **6.9"** iPhone screenshot set (1320×2868; iPhone-only app, so no iPad set).
Automated — no UITest target:

```sh
fastlane ios screenshots    # or: npm run screenshots -- --build
```

This boots the iPhone 16 Pro Max simulator, builds the app, launches it standalone, and loads
synthetic demo state via `sansapp://connect?demo=1`. (The iOS Simulator can't reach the Mac's
CoreMIDI, so there's no live pedal in the sim — demo mode paints a populated, connected-looking UI
instead, with no hardware.) It then deep-links through Editor, Presets, IR, Amp, and Backup and
captures them into `fastlane/screenshots/en-US/`. `deliver` uploads whatever is in that directory.
Re-run it whenever the UI changes.

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

- **A Ruby upgrade can break `pod install` inside the `beta`/`release` lanes.** Hit on 2026-08-12 with
  Ruby 4.0.6: step 4 (`cocoapods`) died before doing anything, with
  `Could not find 'httpclient' (~> 2.8, >= 2.8.3)` — the CocoaPods vendored under fastlane's own gem
  path had an incomplete dependency tree (`httpclient` comes in via `algoliasearch`, which CocoaPods
  uses for spec-repo search). Nothing about the app or the signing setup was wrong. Fix:

      GEM_HOME=~/.local/share/fastlane/<ruby-abi>/ gem install httpclient --no-document

  Confirm with `pod --version` (should answer, not backtrace) before re-running the lane. Expect the
  same class of failure — a missing transitive gem in fastlane's bundle — after any future Ruby bump;
  the error names the gem, so install that one into the same `GEM_HOME`.
- **`fastlane ios beta`'s shell exit code is not its outcome if you pipe it.** `fastlane ... | tail`
  reports `tail`'s status, so a lane that ends in `fastlane finished with errors` still exits 0 through
  the pipe. Check for the literal `fastlane.tools finished successfully 🎉` line, or the step table's
  💥 marker — don't trust `$?` through a pipe.
- **`MARKETING_VERSION` in `ios/SansApp.xcodeproj/project.pbxproj` stays stale, and that's fine.**
  `expo prebuild` writes the version into the generated `Info.plist` rather than syncing
  `MARKETING_VERSION`, so the pbxproj can read `1.0` while the shipped build is correct. Verify the
  real numbers from the built artifact, not the project file:

      unzip -p build/SansApp.ipa Payload/SansApp.app/Info.plist > /tmp/i.plist
      plutil -extract CFBundleShortVersionString raw /tmp/i.plist   # version
      plutil -extract CFBundleVersion raw /tmp/i.plist              # build number

- **Screenshots (and other version metadata) freeze once the version goes live.** `deliver` can only
  edit a version while App Store Connect reports it as `PREPARE_FOR_SUBMISSION`,
  `*_REJECTED`, or `WAITING_FOR_REVIEW` (that's the exact filter `get_edit_app_store_version` uses).
  Once Apple moves it to `IN_REVIEW` or later — including after release, `READY_FOR_SALE` — every
  `deliver` lane fails with "Could not find a version to edit", and there's no override: even
  `edit_live` (meant for tweaking a live version) explicitly disables screenshot upload. **The only
  fix is a new version** — bump `version`/build number and go through steps 1–6 above again, even
  for a screenshot-only correction.
- **Screenshot uploads can silently duplicate.** `deliver` uploads, waits for App Store Connect to
  finish processing, then re-verifies by re-reading each screenshot's checksum from ASC. That read
  can lag behind ASC's own processing state — so `deliver` sees "missing" for screenshots that
  actually succeeded, and retries. The retry doesn't detect the earlier batch as already present
  (same lagging checksum lookup), so both batches land, doubling every screenshot. Mitigated by
  `overwrite_screenshots(true)` in `Deliverfile` (added 2026-08-11): it clears the existing
  screenshot set before every upload, so a rerun converges on exactly the local
  `fastlane/screenshots/en-US/` files instead of accumulating copies. This does mean
  `screenshots_upload` is destructive to whatever's already on ASC for that locale/device — that's
  intentional here since the local files are always the source of truth.
- **App Review needs the hardware.** SansApp's editing needs the physical pedal + a MIDI adapter,
  which the reviewer won't have. `fastlane/metadata/review_information/notes.txt` explains that every
  screen is browsable without a pedal and no account/data is involved — keep that note current.
- **App Review contact info is PII, kept in `.env.local`.** ASC requires a contact first/last name,
  email, and phone for review. Rather than commit them, the lanes read `APP_REVIEW_FIRST_NAME`,
  `APP_REVIEW_LAST_NAME`, `APP_REVIEW_EMAIL`, and `APP_REVIEW_PHONE` from `.env.local` (git-ignored)
  and hand them to `deliver` (the review _notes_ stay in `review_information/notes.txt`). The phone
  must be `+`-prefixed with a country code. Missing vars fail fast with a clear message.
- **Icon alpha.** `assets/icon.png` has an alpha channel; Expo flattens the App Store icon on
  prebuild. If ASC ever rejects the 1024² icon for transparency, flatten it:
  `sips -s format png assets/icon.png --out /tmp/i.png` then composite onto an opaque background.
- **Bundle id** must match everywhere (`app.config.ts`, `Appfile`, `Matchfile`, ASC).
