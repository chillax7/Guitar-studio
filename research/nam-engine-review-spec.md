# NAM Engine Review — replace, or boost what we have?

**Status:** research + recommendation, written 2026-07-29 at the user's
request. Two concrete complaints drove it: **(1) tone quality isn't where
it should be**, and **(2) too many public captures are refused as too
heavy to run live.**

**Conclusion up front:** the reason we built our own engine was real and
correctly reasoned *at the time*, but **it has since expired**. A headless,
MIT-licensed WASM build of the *official* NAM inference core — callable
from inside our own AudioWorklet, with no separate AudioContext — now
exists on npm. Adopting it as a drop-in replacement for our inference
kernel (keeping every layer we built around it) addresses both complaints
at once and is the recommended path. §6 is the plan; §7 is the honest risk
list.

**Companion docs:** [archive/neural-engine-audit.md](archive/neural-engine-audit.md)
(the prior "is the engine broken?" audit — its §4 explicitly parks
oversampling until "a WASM inference path" exists, which is now the case),
[archive/free-distribution-license-audit.md](archive/free-distribution-license-audit.md)
(licensing posture for vendored third-party assets),
[tone3000-unblock-spec.md](tone3000-unblock-spec.md) (the model-sourcing
side, unaffected by this).

---

## 1. Why we didn't use an existing engine — the actual recorded reason

This is worth stating precisely, because the premise in the request ("open
source issues?") turns out **not** to be what happened. `nam-processor.js`'s
own header records the real reason, verbatim:

> Why from scratch instead of the vendored neural-amp-modeler-wasm: that
> library (MIT, TONE3000's fork of the official NeuralAmpModelerCore) is a
> real, well-built WASM port — but it creates and owns its own private
> AudioContext internally (Emscripten's Web Audio Worklets API is designed
> around the module owning the audio thread), so getting its output into
> our existing mixer graph would require a MediaStream bridge between two
> separate contexts, typically adding 100ms+ of latency on top of the
> existing input path.

So: **not a licensing problem** (it was MIT then and is MIT now), and not a
quality judgement about the port. It was a single hard **architectural**
blocker — the only browser NAM engine available at the time insisted on
owning the audio thread, and this app's whole design premise is one shared
AudioContext with the guitar path kept at minimum latency. A 100ms+
MediaStream bridge is disqualifying for live monitoring, so a from-scratch
reimplementation was the correct call given the options *available then*.

That decision has been well-executed since: the math was reverse-engineered
from the official C++ (not guessed) and structurally verified against a real
capture's weight count, and a WASM/SIMD core (`nam-wasm-src/nam.zig`,
30KB) was later added for speed. None of that is wasted — see §6.

**What changed:** the "no headless option exists" premise is now false.

## 2. What exists now (surveyed 2026-07-29, npm registry)

| Package | License | Version / age | WASM size | Shape |
|---|---|---|---|---|
| `neural-amp-modeler-wasm` (TONE3000) | ISC | 1.0.74, mature | ~1.9MB pkg | **React component**; owns its own AudioContext — the original blocker, unchanged |
| `@happysoftware/nam-web` | MIT | 0.2.0, ~1 week old | 602KB | Headless `AudioWorkletNode`; **takes your `ctx`**; upstream NAMCore unmodified |
| `@opendaw/nam-wasm` | MIT | 1.2.0, 4 releases | ~350KB | **Raw multi-instance core**, designed to be driven from *your own* worklet; A2 fast path |

Both new options wrap **the official `sdatkinson/NeuralAmpModelerCore`**
(nam-web uses it unmodified; opendaw tracks v0.5.3 + the TONE3000 port),
so both are bit-accurate to the reference plugin's math rather than a
reimplementation of it. Both are MIT. Both explicitly target AudioWorklet
use without `SharedArrayBuffer`/COOP-COEP headers.

`@opendaw/nam-wasm`'s exported surface is the decisive detail — it is a
plain buffer-in/buffer-out kernel:

```ts
_nam_loadModel(id, jsonPtr): boolean
_nam_process(id, inputPtr, outputPtr, numFrames): void
_nam_setSampleRate(rate) / _nam_setMaxBufferSize(size)
_nam_getModelLoudness(id) / _nam_reset(id)
```

That is **the same shape as our own** `forward(modelPtr, condPtr, outPtr, n)`
in `nam.zig`. It is a like-for-like swap of the inference kernel, not an
architecture change — which is exactly what makes this low-risk.

## 3. Complaint 1 — sound quality

Three separate contributors, worth keeping distinct:

**(a) Most likely still the cab-IR problem, not the engine.** The prior
audit ([archive/neural-engine-audit.md](archive/neural-engine-audit.md) §2)
concluded the "fizzy/harsh" complaint most likely came from running an
amp-only capture with no cab IR — the single most common NAM user error,
and independent of which engine renders it. **Nothing in this spec
supersedes that.** Before attributing tone to the engine, confirm a cab IR
is loaded. That check is free and is the highest-probability fix.

**(b) No oversampling — a real, known gap.** Standard (A1) WaveNet NAM
models are documented to alias more than the newer A2 architecture. The
prior audit measured this as unfixable *at the time* because adding 2-4x
oversampling to an already CPU-tight hot path would blow the real-time
budget — and explicitly deferred it: *"Worth revisiting if a future
architecture change (A2 support, or a WASM inference path) is ever
undertaken for other reasons."* Both preconditions are now met.

**(c) No A2 support at all.** Our engine handles only the legacy
non-parametric WaveNet schema (its header says so). A2 is the newer
architecture with *better* aliasing behavior — i.e. the single most direct
answer to the quality complaint — and `@opendaw/nam-wasm` ships it with a
hand-optimized fast path. We currently cannot load these models at all.

**Net:** (a) is a user-side check, (b) becomes affordable once inference is
cheaper, (c) is free on adoption.

## 4. Complaint 2 — too many models refused

The refusal is ours, deliberate, and correctly motivated. `playalong.js`:

```js
const NAM_REFUSE_RT_FACTOR = 0.9; // near-certain stream death — don't load
const NAM_WARN_RT_FACTOR  = 0.7; // loads, but little headroom for IR/effects
```

An offline probe renders a capture and measures its real-time factor; ≥0.9
is refused outright (with the "look for a Lite or Feather version" message),
0.7-0.9 loads with a warning. A live backstop re-checks on the real render
thread and rolls back if the machine can't keep up.

This logic is sound and should be **kept as-is**. The problem isn't the
threshold, it's what sits underneath it: **every model that gets refused is
refused because our kernel is too slow to run it.** The refusal rate is a
direct function of inference speed. Anything that makes inference
materially faster converts a band of currently-refused captures into
usable ones, with no policy change and no loss of the safety net.

Our kernel's realistic headroom vs. the official core:

- Ours: hand-written 4-wide `@Vector(4, f32)` dot product, single-threaded,
  one generic path for all architectures.
- Official core: Eigen-backed (mature vectorized linear algebra, blocked
  matrix-vector kernels), plus opendaw's **hand-optimized A2 fast path**.

A meaningful speedup is likely but **must be measured, not assumed** — see
§6/M1. That measurement is the gate for the whole decision.

## 5. The two paths, side by side

The user asked for both explored. Path C is included because it's the
honest ceiling case.

### Path A — boost our own engine, stay 100% in-browser

*Keep everything; make `nam.zig` faster and better-sounding.*

- **Wins:** no new dependency, no bundle growth (currently 30KB), full
  control, zero adoption risk.
- **Costs:** every gain is bespoke work we own forever. Realistic items:
  widen SIMD to 8/16-wide, block the matVec loops for cache reuse, add an
  A2 code path *from scratch* (a substantial reverse-engineering project on
  its own — the header notes A2 is a real architecture change, not a
  tweak), then add oversampling on top.
- **Verdict:** viable but poor value. We'd be re-deriving, at
  hobbyist scale, work the upstream project has already done and validated
  — and A2 support alone is a multi-week reverse-engineering effort with
  ongoing maintenance as the format evolves.

### Path B — adopt the official core as our inference kernel *(recommended)*

*Replace only the math; keep our worklet, graph, and every feature layer.*

Specifically **keep**: our `AudioWorkletProcessor`, our single shared
AudioContext and low-latency graph, gain staging, DC blocker, bypass,
model browser/import, the offline probe, the refusal thresholds, and the
live-overrun rollback. **Replace**: `nam.zig`/`nam.wasm`'s `forward()` with
`@opendaw/nam-wasm`'s `_nam_process()`.

- **Wins:** official reference math (bit-accurate to the real plugin, so
  "does it sound right" stops being our question to answer); **A2 support
  for free**, which is the most direct fix for the aliasing/quality
  complaint; likely faster → fewer refusals; multi-instance if we ever
  want two amps; the whole class of "did we reimplement this correctly?"
  risk disappears.
- **Costs:** +350KB WASM (vs 30KB); a new vendored dependency to track;
  Emscripten glue must be proven to instantiate inside
  `AudioWorkletGlobalScope` (§7).
- **Preserves the zero-install promise completely** — still pure browser.

### Path C — native helper binary

*Ship a local binary wrapping NAMCore C++, driven by the Python server.*

- **Wins:** highest possible ceiling — full native SIMD/threads, trivially
  affords 4x oversampling, no browser sandbox limits.
- **Costs:** **breaks the app's central promise.** It needs per-platform
  build + notarization + install, and — fatally — audio would have to
  cross a process boundary in the *live monitoring* path, reintroducing
  exactly the latency problem that ruled out the TONE3000 component in the
  first place. A helper only makes sense for offline rendering, which is
  not where the complaint is.
- **Verdict:** **rejected.** It trades the app's defining constraint for a
  ceiling we don't need, and doesn't even solve the live-latency case well.

## 6. Recommendation and plan

**Adopt Path B, gated on a measurement.** Do not rip anything out before
M1 answers the only question that matters.

- **M0 — Rule out the free fix first (S).** Confirm on a real capture,
  with a cab IR loaded, whether the tone complaint survives at all
  (archive/neural-engine-audit.md §2). If it doesn't, quality drops out of
  scope and this becomes purely a performance exercise. Cheapest possible
  first step; do it before writing any code.

- **M1 — Bake-off, the decision gate (M).** Stand up
  `@opendaw/nam-wasm` beside the current engine and measure, on the same
  machine, same captures, same block size:
  1. **Does it instantiate in `AudioWorkletGlobalScope` at all?** (§7 — the
     single highest risk; if this fails, Path B dies here and we fall back
     to Path A.)
  2. **Real-time factor**, ours vs. theirs, across a spread of captures
     including several currently refused at ≥0.9.
  3. **Null test:** render the same input through both and difference the
     output. Large divergence = a real bug in our reimplementation worth
     knowing about regardless of which path wins.
  - **Gate:** proceed only on a materially better real-time factor. A
    marginal win does not justify +350KB and a new dependency.

- **M2 — Swap the kernel (M).** Behind a flag, with the JS engine still
  present as fallback (the existing WASM path is already "strictly
  additive" — reuse that structure exactly). Re-run the probe/refusal path
  end-to-end and confirm previously-refused captures now load and stay
  stable under the live-overrun backstop.

- **M3 — Bank the wins (M).** Enable **A2** model loading (new capability —
  needs picker/validation/UX for a second architecture) and **re-evaluate
  oversampling** now that headroom exists, per the prior audit's own
  deferral. Treat oversampling as opt-in and measured, not automatic.

- **M4 — Docs + licensing (S).** Vendor per the local-first policy already
  used for alphaTab (npm registry, never a CDN; NOTICE/LICENSE carried
  across — both packages are MIT and both carry upstream attribution).
  Update USER-MANUAL §4.9 ("why some captures won't load"), which will be
  materially less pessimistic afterward.

**Explicitly not doing:** Path C; rewriting our engine's math by hand
(Path A) unless M1 fails; changing the refusal thresholds (they're correct
— we're changing what sits under them).

## 7. Risks, honestly

- **Emscripten glue in AudioWorkletGlobalScope — the big one.** Our current
  module is deliberately freestanding Zig with *no* Emscripten glue,
  precisely because that scope has no `fetch`, `document`, or filesystem.
  Emscripten output often assumes those. Both packages claim AudioWorklet
  support (opendaw: "Designed for use in Web Audio AudioWorklets";
  nam-web ships a `worklet.js` and advertises no COOP/COEP need), but
  **this is a claim, not yet a verified fact on our setup.** M1 item 1
  exists solely to settle it early, before any teardown.
- **Package immaturity.** `@opendaw/nam-wasm` has 4 releases;
  `@happysoftware/nam-web` is a week old at 0.2.0 with a single maintainer.
  Mitigation: we vendor the built artifact (as with alphaTab) rather than
  tracking a moving dependency, so upstream going quiet doesn't break us —
  and our own engine stays in-tree as fallback.
- **Bundle size.** 30KB → ~350KB. Acceptable for a local-first desktop-ish
  app that already ships a 14MB soundfont and multi-GB models, but it is a
  real regression on first load; worth lazy-loading with the rest of the
  rig rather than on page load.
- **The speedup might not materialize.** Eigen is strong, but WASM SIMD
  caps what any implementation can do, and our kernel is already SIMD.
  M1's gate exists to catch this honestly rather than sunk-cost into a
  swap that buys nothing.
- **Sample-rate handling stays a format-level limitation.** Per the prior
  audit, `.nam` has no sample-rate field and no implementation corrects for
  it. Adopting the official core doesn't change this — but the new API's
  explicit `_nam_setSampleRate()` at least makes our handling of it
  deliberate rather than implicit.
