# Orpheus Guitar Studio — Verified Distribution / App Store Plan

**Status:** planning document, written at the v3.0 checkpoint. This is
the *distribution* track — deliberately separate from the v4 feature
release ([release-v4-spec.md](research/release-v4-spec.md)) so neither blocks the
other. Nothing here is committed until a phase is selected.

**The short answer to "does it need a Swift rewrite?":** No for the Mac —
a thin Swift shell (hundreds of lines) around the existing app gets us
all the way to the Mac App Store; the Python engine and the entire JS
front end survive intact. **Yes, mostly, for iPhone/iPad** — iOS forbids
the two things our architecture stands on (a spawned Python process and
a local server), so an iOS version is a new product that reuses our
designs and C++/WASM audio code, not our Python or server. Details and
evidence below.

---

## 1. What "verified" can mean — three distinct targets

**Tier A — Notarized Developer ID app (Mac, outside the App Store).**
Gatekeeper-verified: users download a DMG, it opens with no warnings,
macOS has scanned it for malware. This is how most audio software ships
(Reaper, all the amp-sim vendors). Requires an Apple Developer account
($99/yr), code signing, and notarization — **no code rewrite at all.**

**Tier B — Mac App Store.**
Everything in Tier A, plus the App Sandbox and review guidelines.
Requires a native shell app and some plumbing changes, but not a
rewrite.

**Tier C — iOS/iPadOS App Store.**
A different platform with different rules. Genuine rewrite of the
engine and audio path.

Recommendation: **A → B in order; treat C as a separate future product
decision.** Tier A alone already answers "can I give this to a friend
without scary warnings," which is the actual unmet need today.

## 2. Tier A — Notarized app (effort: S/M, weeks not months)

The current `Guitar Studio.app` (built by `scripts/build_app.sh`) plus:

- **Bundle a Python runtime** instead of depending on the system one:
  `python-build-standalone` (or PyInstaller) + the pip deps. The heavy
  part is torch/demucs/audio-separator — expect a 2–4 GB bundle, or
  keep the app slim and first-run-download models the way the
  `bs_roformer_sw` checkpoint already works (~700 MB on demand). The
  on-demand pattern is already proven in this codebase; extend it to
  the Python wheels is NOT possible — the runtime must ship, only model
  weights can be fetched later.
- **Sign everything, then notarize.** Torch ships hundreds of dylibs;
  they all need `codesign` with the hardened runtime (a script walks the
  bundle — standard practice, tedious, well-documented). Notarization is
  an upload + staple (`notarytool`).
- **Hardened-runtime entitlements needed:** `audio-input` (mic/interface
  for the rig), possibly `camera` (video takes),
  `allow-unsigned-executable-memory` is NOT needed (CPython + torch CPU/
  MPS don't JIT executable pages in ways notarization blocks; verify
  empirically on first signed build — this is the one known unknown).
- No sandbox, so the current free filesystem behaviour (`input/`,
  `output/`, Finder reveal, folder-scanned NAM/IR libraries) all keeps
  working unchanged.

**Gate before shipping Tier A: licensing audit.** Demucs and NAM core
are MIT; `audio-separator` is MIT; but the **BS-RoFormer checkpoint's
weight license must be verified** before any public distribution (some
community separation checkpoints are research/non-commercial). If it
fails the check, ship with Demucs as the bundled default and make
bs_roformer_sw a user-initiated download with the license shown. ffmpeg
(LGPL) is fine for Tier A as a separate spawned binary.

## 3. Tier B — Mac App Store (effort: L, months)

Adds three real constraints on top of Tier A:

- **A native shell becomes mandatory.** This is backlog item **XC-05**,
  scoped down: a SwiftUI/AppKit window hosting a `WKWebView` pointed at
  the loopback server, launching the bundled Python engine as a child
  process (allowed — children inherit the sandbox). AudioWorklets, WASM,
  and `getUserMedia` all work in modern WKWebView, so `app.js`,
  `playalong.js`, the NAM WASM kernel, and the worklets ship as-is.
  The Swift code is a shell, not a port — window, menu bar, process
  lifecycle, file-access brokering. Estimate low hundreds of lines.
- **App Sandbox changes the file story.** No more free scanning of
  arbitrary folders: `input/`, the NAM capture and IR libraries, and
  export destinations become **user-granted folders** via security-scoped
  bookmarks (user picks their NAM folder once; the shell persists
  access). Server and engine keep working on paths the shell brokers.
  This is the single biggest chunk of real work in Tier B, and it
  touches UX, not just plumbing.
- **Review-guideline hygiene.** Loopback-only server is fine; outbound
  model downloads need the network-client entitlement and a clear UI.
  **ffmpeg/LGPL is a known MAS friction point** (relinking requirement
  vs. App Store packaging) — the clean fix is replacing our ffmpeg uses
  (remux, faststart, lossless trim, MP3 encode) with AVFoundation via
  the Swift shell, which handles all of them natively (AAC/ALAC instead
  of MP3 for export, or keep MP3 out of the MAS build). Plan for this
  swap rather than litigating LGPL with review.

Also honest: MAS takes 15–30% of revenue if we ever charge, and audio
users largely expect direct download. Tier B is worth it for
discoverability and the "it's a real verified app" signal — decide with
eyes open.

## 4. Tier C — iOS/iPadOS (effort: XL, a separate product)

What breaks, structurally: iOS apps cannot spawn processes, cannot ship
a Python interpreter running our engine as a service, and WKWebView audio
capture has tighter limits; real-time guitar monitoring at usable latency
means the native audio stack.

What a real iOS Orpheus looks like:

- **Rig:** rewrite on AVAudioEngine/CoreAudio. The NAM inference core
  (`NeuralAmpModelerCore`, C++) compiles for iOS — several shipping iOS
  NAM players prove the path — and our WASM kernel's Zig source is
  portable too. Convolution IRs, EQ, comp, delay/reverb all map to
  AVAudioEngine nodes. This is the genuinely valuable rewrite: native
  CoreAudio gets guitar monitoring to <10 ms, better than the browser
  version will ever be (the same argument as XC-05's original pitch).
- **Separation:** the hard problem. Options, in preference order:
  (1) run separation on the user's Mac and sync stems to the phone
  (companion-app model — keeps the local-only ethos, smallest ML risk);
  (2) CoreML conversion of a separation model (Demucs has been converted
  by others; BS-RoFormer conversion + phone memory ceilings = real R&D);
  (3) a hosted separation service (violates the privacy ethos — last
  resort, opt-in only).
- **UI:** SwiftUI. The JS front end doesn't meaningfully survive; the
  designs, USER-MANUAL, and test plans do.

Verdict: don't start C until B exists and demand is proven. If C
happens, the companion-app model (Mac does the heavy ML, iPhone is the
practice rig) is the version that stays true to what this app is.

## 5. Suggested sequencing

1. **Now / with v4 M1:** Apple Developer account; licensing audit
   (checkpoint weights, ffmpeg inventory); first signed+notarized build
   of the existing app (Tier A alpha) — this also flushes out the
   entitlement unknowns early and cheaply.
2. **Tier A release** alongside or just after v4: DMG on a simple
   landing page. "Verified" achieved for the Mac.
3. **Tier B decision point** after v4 ships: build XC-05 shell +
   sandbox file brokering + AVFoundation swap only if App Store
   presence is still wanted once Tier A exists.
4. **Tier C:** revisit after B; companion-app architecture preferred.
