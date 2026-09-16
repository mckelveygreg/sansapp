# What the app can truthfully claim about the link

Research findings for [#119](https://github.com/mckelveygreg/sansapp/issues/119). Establishes what
the app is _able_ to know about the Bluetooth link to the pedal, and how fast a drop becomes
detectable. It decides nothing about what a stage screen should show — that is a separate ticket.

Sources are cited inline. Every external URL below was fetched while writing this; code claims cite
file and line in this repo at the commit that added this document.

---

## The headline

**The app can never truthfully claim "connected". It can only truthfully claim "the pedal answered
_N_ seconds ago."**

That is not pedantry, it is the shape of the evidence available. Three findings force it:

1. **There is no BLE link to the pedal.** The pedal has no radio. The BLE peer is a CME WIDI Jack
   adapter, cabled to the pedal's TRS MIDI jacks ([`docs/HARDWARE.md`](../HARDWARE.md)). Any
   BLE-level liveness signal describes the phone↔adapter hop only, and says nothing about whether
   the pedal is still on the other end of the adapter's cables.
2. **The app does not own the BLE connection and cannot observe it.** It has no CoreBluetooth
   central. The link is established and owned by iOS's MIDI server; the app sees only a CoreMIDI
   port appearing and disappearing. `react-native-ble-plx` is not a dependency and its disconnect,
   `isConnected` and RSSI APIs are not reachable from this architecture.
3. **A SysEx round-trip is the only end-to-end evidence, and the app already collects it.** A
   heartbeat is not a proposal here — it shipped. `DeviceSession` probes the pedal every 5 s and
   drops to `disconnected` after two consecutive misses
   ([`src/device/session.ts:873`](../../src/device/session.ts)).

Consequently the strongest honest claim is a **timestamp**, not a state. Everything below is the
evidence for that, plus the latency numbers.

---

## 1. What the link physically is

Two hops, not one:

```
iPhone  ──BLE MIDI──▶  CME WIDI Jack  ──2× 3.5 mm TRS──▶  PBDR Elite
        (owned by iOS CoreMIDI)        (▲ = pedal MIDI OUT, also powers the WIDI
                                        ▼ = pedal MIDI IN)
```

From [`docs/HARDWARE.md`](../HARDWARE.md):

- the Elite exposes **3.5 mm TRS Type A** MIDI IN and OUT; it has no Bluetooth of its own;
- the WIDI Jack is **parasitically powered from the pedal's MIDI OUT** (3.3–5 V);
- the full protocol was confirmed over this path on 2026-07-05 — handshake ~700 ms, all 128 preset
  reads checksum-valid, **267-byte preset read round-trip ~250 ms** (min 237 / max 269, measured by
  `npm run ble-check`).

This geometry decides which faults are visible where:

| Fault                                                         | Visible at the BLE layer?                                            | Visible to a SysEx round-trip?                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| Phone walks out of range                                      | Yes                                                                  | Yes                                                |
| Phone Bluetooth off / airplane mode                           | Yes                                                                  | Yes                                                |
| **Pedal loses power**                                         | Yes — the WIDI is parasitically powered by the pedal, so it dies too | Yes                                                |
| **▲ cable (pedal MIDI OUT) pulled**                           | Yes — the WIDI loses power                                           | Yes                                                |
| **▼ cable (pedal MIDI IN) pulled**                            | **No** — BLE stays up, WIDI stays powered                            | **Yes** — requests never reach the pedal, no reply |
| WIDI firmware wedged / MIDI not passing                       | **No**                                                               | Yes                                                |
| Pedal SysEx parser wedged (e.g. after an aborted IR transfer) | **No**                                                               | Yes                                                |

The wired fallback (MD1 over USB) is a single hop and removes the BLE questions, but the same
"only a round-trip proves the pedal" logic applies.

**A BLE-level liveness signal is strictly weaker than the round-trip probe the app already runs.**
That is the central result of this research, and it inverts the premise of question 1 in the ticket.

---

## 2. What `react-native-ble-plx` exposes — and why none of it is reachable here

### It is not installed, and could not be used for this link as built

`package.json` has no `react-native-ble-plx`. The MIDI stack is
[`@motiz88/react-native-midi`](https://www.npmjs.com/package/@motiz88/react-native-midi) — a Web MIDI
API polyfill over CoreMIDI on iOS and `android.media.midi` on Android
([`src/midi/webMidiAdapter.ts`](../../src/midi/webMidiAdapter.ts)).

On iOS the app never scans, connects, or discovers a peripheral. Per Apple's
[QA1831 "Adding Bluetooth LE MIDI Support"](https://developer.apple.com/library/archive/qa/qa1831/_index.html),
BLE MIDI pairing happens through `CABTMIDICentralViewController` (CoreAudioKit) or, on the Mac,
Audio MIDI Setup, after which "a new MIDI device will appear in the setup and **any application**
making use of MIDI devices will be able to see the device and communicate with it". Apple's
[MIDI Bluetooth](https://developer.apple.com/documentation/coremidi/midi-bluetooth) collection adds
that "In macOS 13 or later and iOS 16 or later, **the system** automatically reconnects Bluetooth Low
Energy (BLE) MIDI peripherals when powered on, if the device supports pairing."

So the connection is a system-owned resource shared between apps. A `BleManager` in this app would be
a **second, independent** CoreBluetooth central. It could not observe, and must not interfere with,
the midiserver-owned link that actually carries the MIDI. (Apple does document a CoreBluetooth route
— `MIDIBluetoothDriverActivateAllConnections()`, iOS 16+ — but that exists for peripherals that
_don't support pairing_, and the WIDI Jack pairs normally through the system sheet.)

### What the APIs would give, for the record

Fetched via `ctx7` from `/dotintent/react-native-ble-plx` (v3.5.0), which sources the upstream docs
and wiki:

| API                                                                 | What it does                                                                                                                                                                                 | Latency / reliability on iOS                                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onDeviceDisconnected(id, listener)` / `monitorDeviceDisconnection` | "Monitors if a Device was disconnected due to any errors or connection problems." Listener gets `(error, device)`; `error === null` means the disconnect came from `cancelDeviceConnection`. | Event-driven, but not instant — fires when **CoreBluetooth** decides the link is gone (see the supervision-timeout floor below).                                                                           |
| `isDeviceConnected(id)` / `device.isConnected()`                    | `Promise<boolean>` — "Checks the connection state of a device."                                                                                                                              | A query of the _same_ CoreBluetooth state the disconnect callback reports. Polling it adds no information and cannot beat the callback; it only turns an event into a poll.                                |
| `device.readRSSI()`                                                 | Reads signal strength into `device.rssi`.                                                                                                                                                    | Requires an already-live GATT link; it is a _quality_ signal, not a liveness one. A dead link makes `readRSSI` fail — but no faster than the disconnect callback, because both wait on the same detection. |
| `monitorCharacteristicForService(...)`                              | Notification subscription.                                                                                                                                                                   | Inbound-traffic liveness. Proves the peer is transmitting; proves nothing when the peer is legitimately idle. Exactly the same epistemic shape as the app's existing `lastReceiveAt`.                      |

None of these is faster than CoreBluetooth's own detection, because all of them **are**
CoreBluetooth's own detection, surfaced differently.

### The floor on any BLE-level detection: the supervision timeout

A BLE link is declared dead when no valid packet is exchanged for `connSupervisionTimeout`. Apple's
[Technical Q&A QA1931](https://developer.apple.com/library/archive/qa/qa1931/_index.html) sets the
parameters an accessory must request of an Apple host:

> - Interval Min ≥ 15 ms (multiples of 15 ms)
> - Interval Min + 15 ms ≤ Interval Max
> - Interval Max \* (Slave Latency + 1) ≤ 2 seconds
> - Interval Max \* (Slave Latency + 1) \* 3 < connSupervisionTimeout
> - Slave Latency ≤ 30
> - **2 seconds ≤ connSupervisionTimeout ≤ 6 seconds**
>
> "If the parameters do not comply with all of these rules, the parameter request may be rejected, or
> the stability and the performance of the connection may be compromised."

So for a compliant accessory, a clean out-of-range drop surfaces to iOS somewhere in
**2–6 seconds**, and an app-visible disconnect event cannot beat that. On top of that sits CoreMIDI's
own lag in marking the endpoint offline — the sansApp patch to the MIDI module records this from
observation: _"the CoreMIDI destination for a BLE peripheral vanishes the instant the link drops, and
iOS reports it to us with a lag"_
([`patches/@motiz88+react-native-midi+0.0.6.patch`](../../patches/@motiz88+react-native-midi+0.0.6.patch)).

**The WIDI Jack's actual negotiated connection parameters are unknown** — see
[Open questions](#open-questions-only-hardware-can-settle-these).

### There _is_ an unused event-driven signal, and it is free

The MIDI polyfill already implements `MIDIAccess.onstatechange`. The native iOS module watches
CoreMIDI notifications and fires `onMidiDeviceRemoved` when a device's `offline` property flips:

```swift
case let .propertyChanged(device as MIDIDevice, MIDIObject.Property.offline):
    if (!device.isOffline) { addDevice(device: device) } else { removeDevice(device: device) }
```

(`node_modules/@motiz88/react-native-midi/ios/ReactNativeMidiModule.swift`), which
`MIDIAccessImpl.removeDevice` turns into a `MIDIConnectionEvent("statechange")`.

**The app subscribes to none of it** — `grep -rn "onstatechange\|statechange" src/ app/` returns
nothing. This is the cheapest available improvement: an event-driven signal, bounded below by the
supervision timeout plus CoreMIDI's offline lag, that would collapse the detection window for the
phone↔WIDI hop specifically. It is strictly a _complement_ to the round-trip probe, never a
replacement — re-read the fault table in §1 for why.

---

## 3. What the protocol permits as a heartbeat — and what already ships

### There is exactly one cheap, safe, reply-bearing read, and it is already the probe

From [`docs/PROTOCOL.md`](../PROTOCOL.md):

- Every read path resolves to **flash**. `05 55 <idx>` reads flash page `0x3f0 + idx`;
  `05 40 <slot>` reads flash page `slot + 1024`. Neither writes anything.
- **Live state is not readable by any read** (§"Live state is write-only"). The only live byte
  anywhere in the read surface is **settings block 0, byte 0** — the active program number,
  hand-patched from RAM.
- Every reply-bearing message carries a 256-byte body plus a 2-byte 14-bit checksum. There is **no
  small-reply command** in the observed vocabulary: `hello` (`05 5A`-class controls, `05 5B`) draws
  _no reply at all_ — the connect handshake has to pair `hello` with a block read to get one
  ([`src/device/session.ts:352`](../../src/device/session.ts)).

So the cheapest safe round-trip available is a 256-byte block read, and the heartbeat uses the single
best one:

```ts
const settings = await this.readBlock(0x55, 0);
```

([`src/device/session.ts:881`](../../src/device/session.ts))

`05 55 00` is ideal on three counts: it is a pure flash read with no side effects; it is the
_smallest-consequence_ read in the vocabulary; and its byte 0 is the one live byte the pedal exposes,
so the probe doubles as a backstop that notices a footswitch preset change whose unsolicited push got
dropped over BLE.

**Cost on the wire:** ~267 bytes inbound per probe (HARDWARE.md's measured dump size) every 5 s
≈ **53 bytes/s**, with a ~250 ms round-trip. Negligible against BLE MIDI's capacity, and far cheaper
than the cost of _not_ probing (see §4 — an idle BLE MIDI link is torn down by iOS).

### The read-pacing hazard is handled, twice

The known hazard: over BLE the pedal drops a reply-expecting read that lands in the same connection
interval as a preceding fire-and-forget send (verified on hardware 2026-07-14) — producing
`timeout awaiting reply to <kind>`. The probe rides along safely because two independent mechanisms
guard it:

1. **Queue + send-gap pacing in `request()`** ([`src/device/session.ts:790`](../../src/device/session.ts)).
   Every reply-expecting request is serialized onto one queue, and before sending it waits out the
   remainder of `sendGapMs` (150 ms in the app) since the last outbound byte, whoever sent it.
2. **A quiet window in the probe itself** ([`src/device/session.ts:879`](../../src/device/session.ts)):

   ```ts
   if (Date.now() - Math.max(this.lastSendAt, this.lastReceiveAt) < HEARTBEAT_QUIET_MS) return;
   ```

   `HEARTBEAT_QUIET_MS = 2500`. The probe simply does not fire within 2.5 s of _any_ traffic in
   either direction.

It also stands down entirely for bulk operations: `heartbeat()` returns early when
`pending.size > 0` or `linkBusy` is set, and `withExclusive` / `withBusy`
([`src/device/session.ts:649`, `:677`](../../src/device/session.ts)) hold `linkBusy` across IR
uploads/reads and Read-from-Pedal. A probe fired into a multi-second raw IR stream garbles it, and
crowding the pedal's IR flash write is the historical brick vector.

**Nothing further is needed to make a periodic probe safe. It is already safe, and already running.**

### Nothing here reads or disturbs live state

Worth stating explicitly because the ticket asks: the probe is a flash read. It cannot disturb the
sounding parameters, and it cannot report them either. The only way to observe live state is the
laundering trick in
[`docs/adr/0001-read-live-state-by-laundering-through-flash.md`](../adr/0001-read-live-state-by-laundering-through-flash.md)
— a bare `05 50 … 12 <slot>` commit that makes the pedal write its live array to flash and echo it.
That is a **flash write**, takes seconds, and perturbs the rig. It must never be used as a heartbeat.

---

## 4. Detectability: the actual numbers

### Configuration as shipped

```ts
const newSession = new DeviceSession(found.io, 4000, 5000, 150);
//                                              ^ timeoutMs  ^ heartbeatMs  ^ sendGapMs
```

([`src/midi/pedal.ts:185`](../../src/midi/pedal.ts))

- probe interval: **5 s**
- per-request timeout: **4 s**
- consecutive misses required to declare the link dead: **2**
  ([`src/device/session.ts:888`](../../src/device/session.ts))

### Worked timing, idle link

Take a probe that succeeds at _T_ and the link dying at _T+ε_:

| Time   | Event                                                            |
| ------ | ---------------------------------------------------------------- |
| _T_    | probe sent, reply at ~_T_+0.25 s — link proven alive             |
| _T_+ε  | link dies                                                        |
| _T_+5  | tick; quiet check passes (4.75 s since last traffic); probe sent |
| _T_+9  | probe times out — `hbFails = 1`                                  |
| _T_+10 | tick; probe sent                                                 |
| _T_+14 | probe times out — `hbFails = 2` → `setState("disconnected")`     |

**Worst case ≈ 14 s. Best case ≈ 9 s** (link dies just before a tick). Call it
**9–14 seconds on an idle link**, i.e. _two consecutive missed probes_.

### The faster path, and its caveat

`onSendFailure()` ([`src/device/session.ts:859`](../../src/device/session.ts)) declares the link dead
immediately when a send throws _and_ nothing has been received for `LINK_SILENCE_MS` (2500 ms):

```ts
if (Date.now() - this.lastReceiveAt >= LINK_SILENCE_MS) this.setState("disconnected");
```

The deliberate asymmetry: a lone throw during active traffic is often a transient CoreMIDI
destination drop under a heavy read burst, and tearing the session down mid-IR-refresh killed the
link and blanked slots. So a throw only counts when the link has _also_ gone silent.

When it fires, it can cut detection to roughly **one probe interval (~5 s)** plus CoreMIDI's offline
lag — the probe's own send is the send that throws. Two caveats, both flagged in the code as
**"On-device verification pending"**: it depends on CoreMIDI having already removed the destination,
and the async half of it (the patched `__midiSendError` hook for a swallowed native rejection) has
never been confirmed on hardware.

### The cases where detection is suspended, not slow

These matter more than the 9–14 s number, because they are the live-performance cases.

| Situation                                 | Effect on detection                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continuous knob drag**                  | `setLiveParam` coalesces to one wire message per param per `LIVE_THROTTLE_MS` = 40 ms ([`src/device/session.ts:66`](../../src/device/session.ts)). Each stamps `lastSendAt`, so the 2.5 s quiet window never opens and **no probe fires for the whole drag**. These sends are fire-and-forget: a dead link and a live one look identical. Detection resumes 2.5 s after the drag ends, then takes the usual 9–14 s. |
| **IR upload / IR read / Read from Pedal** | `linkBusy` suspends the probe for the entire operation ([`src/device/session.ts:649`](../../src/device/session.ts)). Correct — a probe would corrupt the transfer — but detection is off for seconds to minutes.                                                                                                                                                                                                    |
| **A user-initiated read fails**           | `request()` rejects to the caller. It does **not** touch `hbFails` and does **not** change connection state. The user sees an error toast while the pill stays green.                                                                                                                                                                                                                                               |
| **App backgrounded / screen locked**      | No JS timers run at all — see §5. Detection stops completely.                                                                                                                                                                                                                                                                                                                                                       |

---

## 5. Background and screen lock — the music-stand case

### The app declares no background modes

[`app.config.ts:48–56`](../../app.config.ts) sets only `NSBluetoothAlwaysUsageDescription`,
`NSBluetoothPeripheralUsageDescription` and `ITSAppUsesNonExemptEncryption`. There is **no
`UIBackgroundModes` key anywhere** in the config or the Android plugin. Apple's
[`UIBackgroundModes`](https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes)
lists the available values (`audio`, `bluetooth-central`, `bluetooth-peripheral`,
`external-accessory`, `location`, `voip`, …); SansApp claims none of them.

### So the app is suspended, and the heartbeat stops

Apple's
[Preparing your UI to run in the background](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background):

> "When the user exits a foreground app, that app moves to the background state briefly before UIKit
> suspends it." … "Invalidate any active timers."

A suspended process runs no JavaScript, so the `setInterval` driving `heartbeat()` does not fire.
Detection is not slow while backgrounded — it is **absent**. On return to the foreground the pill
shows whatever it last showed, and needs up to another ~14 s (longer if the user immediately grabs a
knob) to correct itself. Screen lock is the same transition.

### And iOS may tear the link down _because_ the app went quiet

From [QA1831](https://developer.apple.com/library/archive/qa/qa1831/_index.html):

> "When two devices are **not** communicating for a while over an established Bluetooth MIDI
> connection and the connection is unused by the application, the Bluetooth connection will
> automatically terminate after several minutes to save power."

This is the sting in the music-stand scenario. Foregrounded, the 5 s heartbeat is itself the traffic
that keeps the BLE MIDI link from idling out. Backgrounded, the heartbeat stops, the link goes idle,
and iOS is documented to terminate it after several minutes — while the app, suspended, learns
nothing. The user picks the phone up to a green dot and a dead link.

### What a background mode would and would not buy

- **`bluetooth-central`** governs _the app's own_ `CBCentralManager`. Per Apple's
  [Core Bluetooth Background Execution](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html),
  a foreground-only central "won't be aware of the disconnection until it resumes", while a declared
  `bluetooth-central` app is woken when its `CBCentralManagerDelegate` methods are invoked (with
  ~10 seconds to finish work before being suspended again). But this app has no central; the link
  belongs to midiserver. Declaring the mode would not, on the documented behaviour, revive the JS
  heartbeat or deliver CoreMIDI events to a suspended app. **Unverified — see open questions.**
- **`audio`** is the mode that plausibly keeps a MIDI-driven app alive in the background, and it is
  what audio apps that respond to BLE foot controllers use. SansApp produces no audio, and App Review
  guideline **2.5.4** is explicit: _"Multitasking apps may only use background services for their
  intended purposes: VoIP, audio playback, location, task completion, local notifications, etc."_
  ([App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)). Given
  this app's review history, declaring `audio` purely to keep a timer running is a real rejection
  risk and should not be done casually.

**Practical conclusion for a stage screen: the honest answer to "is the link up while the phone is
locked in your gig bag?" is "unknown, and probably not for long."** Anything the screen asserts must
survive the app having been asleep.

---

## 6. Why the indicator goes stale today

The chain is short. `DeviceSession.state` → `onState` → `store.setConnection`
([`src/state/store.ts:377`](../../src/state/store.ts)) → `ConnectionPill`
([`src/components/ConnectionPill.tsx`](../../src/components/ConnectionPill.tsx)), which maps the
three states to fixed labels:

```ts
const LABEL = { disconnected: "Disconnected", connecting: "Connecting…", ready: "Connected" };
```

The pill renders a **state**, and that state is **latched**. It says "Connected" from the moment the
handshake completes until something actively proves otherwise. It carries no time information, so it
cannot distinguish "the pedal answered 250 ms ago" from "the pedal last answered eleven minutes ago,
while the phone was in your pocket".

Concretely, it is stale-but-green in all of these:

1. **The 9–14 s detection window** after a real drop on an idle link (§4).
2. **The whole of any knob drag**, because fire-and-forget sends suppress the probe and carry no
   acknowledgement (§4).
3. **The whole of any IR transfer or Read-from-Pedal**, because `linkBusy` suspends the probe (§4).
4. **The entire time the app is backgrounded or the screen is locked**, because no timer runs — and
   this is also exactly when iOS is documented to tear the link down (§5).
5. **After a user-initiated read fails**, which errors to the caller without touching connection
   state (§4).

Note the app already has the right vocabulary for this elsewhere: `Freshness = "known" | "stale"`
([`src/state/store.ts:46`](../../src/state/store.ts)) is precisely a "we cannot claim this is current"
marker for parameter values, and the disconnect handler sets it to `"stale"` because "a missed notify
is undetectable, so anything the pedal did while we were away is unknown". The connection indicator
has no equivalent.

---

## 7. What the app can truthfully claim

Ranked by strength of evidence:

| Claim                                                         | Truthful?                                                                                                                                                                                 | Evidence                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| "The pedal answered _N_ seconds ago."                         | **Yes**                                                                                                                                                                                   | `lastReceiveAt`, and the probe that produces it — an end-to-end SysEx round-trip through both hops.                                    |
| "Nothing has proved the link dead."                           | Yes, but weak                                                                                                                                                                             | Absence of evidence. True of a pedal that was unplugged 0.2 s ago.                                                                     |
| "The link is up **right now**."                               | **No**                                                                                                                                                                                    | Nothing on this stack can establish it. Between probes the app is inferring, not observing.                                            |
| "The phone↔WIDI radio link is up."                            | Would become _yes-ish_ if `MIDIAccess.onstatechange` were wired up — bounded by the supervision timeout plus CoreMIDI's offline lag. Still says nothing about the pedal (§1 fault table). | Currently unobserved.                                                                                                                  |
| "The pedal is playing what the app shows."                    | **No**                                                                                                                                                                                    | Live state is unreadable; this is what `Freshness` already admits. Orthogonal to link liveness but easily conflated on a stage screen. |
| "The link was up while you were away / the phone was locked." | **No**                                                                                                                                                                                    | The app was suspended and observed nothing; iOS may have torn the link down in the meantime (§5).                                      |

**Detectability, summarised:**

| Path                                           | Latency                                                                          | Confidence                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Heartbeat, idle link                           | **9–14 s** (two missed 4 s probes on a 5 s interval)                             | High — derived from shipped constants; consistent with the measured ~250 ms round-trip |
| Send-failure fast path                         | ~5 s + CoreMIDI lag, opportunistic                                               | Low — marked "on-device verification pending" twice in the source                      |
| `MIDIAccess.onstatechange` (available, unused) | supervision timeout (**2–6 s** for a compliant accessory) + CoreMIDI offline lag | Medium — Apple's QA1931 bounds it; the WIDI's real parameters are unmeasured           |
| During a knob drag                             | **suspended** for the drag, then 9–14 s                                          | High                                                                                   |
| During an IR transfer / Read from Pedal        | **suspended** for the operation                                                  | High                                                                                   |
| Backgrounded / screen locked                   | **never**                                                                        | High                                                                                   |

---

## 8. Is a heartbeat feasible, and what does it cost?

**It is feasible, it is safe, and it already ships.** The question for #119 is therefore not "should
we add one" but "is the one we have good enough to underwrite a stage screen", and what the
improvements would cost.

**What it costs today:** ~267 bytes inbound per 5 s (~53 B/s), one 256-byte flash read on the pedal,
zero risk to live state, and no collision risk given the queue pacing plus the 2.5 s quiet window
(§3). This is cheap and should stay.

Options, cheapest first. All are _recommendations about knowability_; the UI question is #113/#120's.

1. **Expose the timestamp, not just the state.** The session already tracks `lastReceiveAt`; it is
   private. Surfacing it (or an `onState`-style "last heard from" subscription) costs nothing on the
   wire and is the single change that would let anything downstream make a claim that is actually
   true. **Recommended.**
2. **Subscribe to `MIDIAccess.onstatechange`.** Free, event-driven, already implemented end-to-end in
   the dependency and completely unused (§2). Collapses detection for the phone↔WIDI hop toward the
   supervision-timeout floor. Must be treated as a _hint_ — it cannot see the pedal. **Recommended.**
3. **Handle `AppState` transitions.** On background, stop claiming anything; on foreground, probe
   immediately rather than waiting up to 5 s for the next tick, and bypass the quiet window for that
   one probe. The precedent exists — `app/ir.tsx:816` already refuses to start an IR upload unless
   `AppState.currentState === "active"`. **Recommended.**
4. **Shorten the probe interval or require only one miss.** Cuts the 9–14 s window, at the cost of
   false disconnects on a marginal link — the exact failure the two-miss rule and the quiet window
   were added to stop. **Not recommended without hardware measurement first.**
5. **Declare a background mode to keep probing while locked.** `bluetooth-central` is probably
   inapplicable (§5) and `audio` is an App Review risk under guideline 2.5.4. **Not recommended.**

What no amount of engineering can buy: a claim that the link is up _at this instant_. The
transport is a round-trip with ~250 ms of latency and no unsolicited keep-alive from the pedal. The
best obtainable claim remains a timestamp.

---

## Open questions — only hardware can settle these

1. **The WIDI Jack's negotiated BLE connection parameters**, and therefore the real
   `connSupervisionTimeout`. QA1931 bounds a _compliant_ accessory to 2–6 s; the WIDI's actual value
   is unmeasured. Determines the true floor for any BLE-level signal. Observable on a Mac via
   PacketLogger, or inferred by timing repeated out-of-range drops.
2. **CoreMIDI's offline lag for a BLE MIDI endpoint** — how long after the radio link dies does the
   device's `offline` property flip and `onMidiDeviceRemoved` fire? This is the number that decides
   whether recommendation 2 is worth much. Measurable by logging `onstatechange` against a
   stopwatched power-off of the pedal.
3. **Whether the send-failure fast path fires at all**, and how quickly. Marked "On-device
   verification pending" in both `src/device/session.ts` and the MIDI patch. Test: pull pedal power
   mid-session and time the transition to `disconnected`.
4. **The measured 9–14 s window in practice.** Derived here from constants, not observed. Worth one
   stopwatched pull-the-plug run to confirm the model, especially that the second probe is not
   further delayed by the quiet window.
5. **How long an idle BLE MIDI link actually survives backgrounding** before iOS's documented
   several-minute idle teardown (QA1831) kicks in — and whether the system's iOS 16+ auto-reconnect
   brings it back on foregrounding without user action.
6. **Whether `bluetooth-central` has any effect on a midiserver-owned BLE MIDI link.** The
   documentation implies not, and this document asserts nothing stronger. A single build with the
   mode declared, backgrounded with a probe running, would settle it.
7. **Whether the ▼-cable-pulled fault behaves as predicted** (BLE stays up, heartbeat fails). The
   fault table in §1 is reasoned from the WIDI's documented parasitic powering, not observed.

---

## Sources

Fetched and verified 2026-09-15.

**Apple (primary)**

- [Core Bluetooth Background Execution for iOS Apps](https://developer.apple.com/library/archive/documentation/NetworkingInternetWeb/Conceptual/CoreBluetooth_concepts/CoreBluetoothBackgroundProcessingForIOSApps/PerformingTasksWhileYourAppIsInTheBackground.html)
  — foreground-only centrals learn of a disconnect only on resume; `bluetooth-central` wake-ups get
  ~10 s.
- [Technical Q&A QA1931 — Using the correct Bluetooth LE Advertising and Connection Parameters](https://developer.apple.com/library/archive/qa/qa1931/_index.html)
  — `2 s ≤ connSupervisionTimeout ≤ 6 s` and the rest of the parameter rules.
- [Technical Q&A QA1831 — Adding Bluetooth LE MIDI Support](https://developer.apple.com/library/archive/qa/qa1831/_index.html)
  — BLE MIDI pairing is system-mediated and shared across apps; an idle BLE MIDI connection
  auto-terminates after several minutes.
- [Core MIDI — MIDI Bluetooth](https://developer.apple.com/documentation/coremidi/midi-bluetooth) and
  [`MIDIBluetoothDriverActivateAllConnections()`](<https://developer.apple.com/documentation/coremidi/midibluetoothdriveractivateallconnections()>)
  — system auto-reconnect on iOS 16+/macOS 13+; the CoreBluetooth route is for non-pairing devices.
- [`UIBackgroundModes`](https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes)
  — the set of declarable modes.
- [Preparing your UI to run in the background](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background)
  — the app is suspended shortly after backgrounding; invalidate timers.
- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — 2.5.4,
  background services may only be used for their intended purposes.

**Library docs**

- `react-native-ble-plx` v3.5.0 via `ctx7` (`/dotintent/react-native-ble-plx`), sourcing
  [the API docs](https://github.com/dotintent/react-native-ble-plx/blob/master/docs/index.html) and
  [the Background mode (iOS) wiki](<https://github.com/dotintent/react-native-ble-plx/wiki/Background-mode-(iOS)>).
- `@motiz88/react-native-midi` 0.0.6 — `ios/ReactNativeMidiModule.swift`, `src/MIDIAccessImpl.ts`
  (read from the installed package).

**This repo**

- [`docs/PROTOCOL.md`](../PROTOCOL.md) — transport, read surface, live state is write-only, settings
  block 0 byte map.
- [`docs/HARDWARE.md`](../HARDWARE.md) — the WIDI Jack topology, parasitic power, measured BLE
  latency.
- [`docs/adr/0001-read-live-state-by-laundering-through-flash.md`](../adr/0001-read-live-state-by-laundering-through-flash.md)
  — why live state cannot be polled.
- [`src/device/session.ts`](../../src/device/session.ts), [`src/midi/pedal.ts`](../../src/midi/pedal.ts),
  [`src/state/store.ts`](../../src/state/store.ts),
  [`src/components/ConnectionPill.tsx`](../../src/components/ConnectionPill.tsx),
  [`app.config.ts`](../../app.config.ts),
  [`patches/@motiz88+react-native-midi+0.0.6.patch`](../../patches/@motiz88+react-native-midi+0.0.6.patch).
