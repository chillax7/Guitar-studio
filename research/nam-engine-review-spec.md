# NAM Engine Review — replace, or boost what we have?

**Status:** research + recommendation, written 2026-07-29 at the user's
request; **updated the same day with real bake-off measurements (§8) that
reverse the headline recommendation.** Two concrete complaints drove the
original review: **(1) tone quality isn't where it should be**, and **(2)
too many public captures are refused as too heavy to run live.**

**Revised conclusion (§8 supersedes this):** the bake-off this spec's own
§6 called for was run against `@opendaw/nam-wasm`, gated exactly as
written. It **passed decisively on correctness** (relative RMSE 0.05% vs.
our own engine's 2.62% against the same PyTorch ground truth — the
official core is essentially bit-accurate, ours is not) but **failed
decisively on speed** (real-time factor ≈0.83 vs. our own engine's ≈0.44 —
the official Eigen-based core measured **~1.9x slower**, on the identical
model and input, confirmed twice with two benchmark methodologies). §6's
own gate says explicitly: *"proceed only on a materially better real-time
factor. A marginal win does not justify +350KB and a new dependency."*
This is not a marginal win — it's a regression, and on exactly the axis
complaint #2 is about. **Adopting this engine wholesale would make
complaint #2 (refusals) worse, not better.** §8 lays out the revised,
narrower recommendation: fix the *specific, now-quantified* source of our
own engine's inaccuracy (§8.3) instead of replacing the engine.

---

*(Original §1-§7 below, preserved as written before the bake-off ran —
the reasoning in §1-§4 about why we built our own engine and what exists
now is unchanged and still correct; only the recommendation coming out of
it changes, per §8.)*

**Original conclusion up front:** the reason we built our own engine was
real and correctly reasoned *at the time*, but **it has since expired**. A
headless, MIT-licensed WASM build of the *official* NAM inference core — callable
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

---

## 8. Bake-off results (M0/M1, run 2026-07-29) — the gate fails on speed

M0 and M1 from §6 were executed. Full methodology, then the numbers, then
what they mean for the recommendation.

### 8.0 Test setup

No real community `.nam` capture was available in this environment (no
general internet access beyond the npm/PyPI registries — the same
constraint that already shaped how alphaTab's soundfont was sourced this
session), and the two `.nam` files previously in this repo were already
removed per the free-distribution license audit's own recommendation.
Rather than risk a hand-rolled test file silently encoding the same
misunderstanding on both sides of a comparison, the **official
`neural-amp-modeler` Python package (pip install, v0.13.0)** was installed
and used to build and export a real model through its own genuine
`BaseNet.export()` code path — the same path every real capture's creator
uses — guaranteeing schema/weight-order correctness by construction
rather than by manual reverse-engineering:

- **Architecture:** NAM's well-known "standard" WaveNet config (matches
  its own `standard.json` training preset most public guitar/amp captures
  use) — one layer array, 16 channels, gated, dilation doubling 1→512 (10
  layers), kernel size 3. Not a toy: 18,754 weights, comparable to this
  file's own header note that a real downloaded capture (TONE3000's
  `deluxe.nam`) has 13,801.
- **Ground truth:** the same PyTorch model's own forward pass, on a
  4096-sample deterministic test signal (two summed sine tones), run
  directly in Python — the actual reference implementation's actual
  output, not a re-derivation of it.
- **Compared:** our engine (both `nam-processor.js`'s hand-written JS path
  and `nam.wasm`'s Zig/SIMD path — confirmed numerically identical to each
  other, as documented) and `@opendaw/nam-wasm` 1.2.0 (chosen over
  `@happysoftware/nam-web` as the primary candidate — its plain
  buffer-in/buffer-out C ABI needed no protocol reverse-engineering to
  drive standalone; `nam-web`'s bundled worklet-only interface would have
  needed a real `AudioWorkletProcessor.process()` audio-graph harness to
  drive fairly, out of proportion to what the gate needed to answer).

### 8.1 M1 item 1 — does it instantiate in `AudioWorkletGlobalScope`? Yes, after one fix

It does **not** work out of the box. `@opendaw/nam-wasm`'s Emscripten glue
executes `new URL("nam.wasm", import.meta.url)` unconditionally at
module-init time whenever no `locateFile` option is supplied — and
**`URL` is not a global in `AudioWorkletGlobalScope`** (confirmed directly:
`typeof URL === "undefined"` inside a real worklet in this session's
headless Chromium). This threw synchronously on every attempt, with no
error ever reaching our own `.catch()` — the module simply never
initialized, silently.

**Fix:** pass a `locateFile: (path) => path` option, which routes the glue
down its *other* branch (`if (Module["locateFile"]) {...}`) and skips the
`new URL(...)` call entirely. Confirmed working after that one line —
tested end to end in a real `AudioWorkletProcessor`, in a real headless
browser, with `instantiateWasm` wired to `WebAssembly.instantiate()`
directly for good measure. Independent corroboration this is a real,
known class of issue and not an artifact of this test rig:
`@happysoftware/nam-web`'s own shipped `worklet.js` opens with a
hand-rolled `URL` polyfill (`if(typeof URL==='undefined'){globalThis.URL=
class{...}}`) — its author hit and worked around the exact same gap.

**Verdict:** passes, with a one-line, well-understood fix. Not a blocker.

### 8.2 M1 item 3 — null test: decisive win for the official core

| | vs. PyTorch ground truth (relative RMSE) |
|---|---|
| Our engine (JS and WASM — identical to each other) | **2.62%** |
| `@opendaw/nam-wasm` (official core) | **0.05%** |

0.05% is essentially f32-vs-f64 rounding noise — the official core is
bit-accurate to the reference. Our own reimplementation's 2.62% is a real,
now-precisely-quantified gap, not noise (max instantaneous error ≈17% of
the reference's RMS level at points). The most likely single cause: the
prior audit's own honestly-flagged `fastTanh` approximation error (~5e-3
per call) compounding across 10 sequentially-connected dilation layers —
consistent with a bounded, non-exploding several-percent output error
rather than a structural bug, but not confirmed further within this pass.

**This is a real, previously-unmeasured answer to complaint #1** — some
of "the tone isn't right" is genuinely us, independent of the cab-IR
question in §3.

### 8.3 M1 item 2 — real-time factor: the official core is ~1.9x *slower*

| | Real-time factor (lower is better) | Headroom under `NAM_REFUSE_RT_FACTOR` (0.9) |
|---|---|---|
| Our engine (`nam.wasm`, Zig/SIMD) | **≈0.44** | wide (0.46) |
| `@opendaw/nam-wasm` (official core) | **≈0.83** | thin (0.07) |

Measured twice, independently: the first pass, then again after fixing a
benchmark-methodology asymmetry (the official core's loop was recreating
a `Float32Array` heap view every block where ours reused one — the same
optimization our own `forwardBlockWasm` already documents under its own
"V3-E5" comment). Both runs agree closely (RTF ≈0.41-0.43 vs. ≈0.82-0.83).
This is not measurement noise; **the official Eigen-backed core is
consistently, substantially slower than our hand-tuned SIMD Zig kernel on
identical input.**

Plausible reasons (not confirmed further — out of scope to chase without
the package's own build pipeline): Eigen's dynamic-size matrix ops may not
autovectorize as tightly under Emscripten as a hand-written
`@Vector(4,f32)` dot product tuned specifically for this shape; the
general-purpose multi-instance C++ core likely carries overhead our
single-purpose arena-based module doesn't.

**§6's own gate, verbatim: "proceed only on a materially better real-time
factor. A marginal win does not justify +350KB and a new dependency."**
This is not a marginal win — it is a clear loss, and specifically on the
axis complaint #2 is about. Adopting `@opendaw/nam-wasm` as the live
kernel would **shrink the refuse-threshold's headroom from 0.46 to 0.07**,
meaning **more** captures would cross `NAM_REFUSE_RT_FACTOR` and get
refused, not fewer — the direct opposite of what complaint #2 is asking
for.

### 8.4 Revised recommendation: fix the real bug, don't adopt the engine

**§6's Path B is rejected — the bake-off it was gated on failed.** Do not
swap the inference kernel.

Both original complaints are still worth addressing, and §8.2 just
supplied a concrete, targeted answer for the tone one:

- **Complaint 1 (quality):** our engine's own `nam.wasm` currently spends
  only 44% of the real-time budget (0.44 RTF) — **56% headroom is sitting
  unused.** The most direct next step, cheap and low-risk compared to a
  wholesale swap: spend some of that headroom on accuracy specifically
  where §8.2 points — replace `fastTanh`'s rational Padé approximation
  with a more accurate one (or real `tanh`) in the WASM path only (the JS
  path's own `Math.tanh` cost was already the documented reason
  `fastTanh` was adopted there — the WASM path, with SIMD and 56%
  headroom to spare, is a different cost/accuracy trade-off than the one
  that motivated the original choice). Re-run this exact null test after
  the change — a real, checkable pass/fail on whether it closes the 2.62%
  gap without pushing RTF materially closer to 0.9.
- **Complaint 2 (refusals):** unaffected by anything above — our own
  engine is already the faster of the two measured, so improving its
  accuracy without touching its speed (or improving both, if the
  `fastTanh` swap turns out cheap) is strictly better for the refusal
  problem than adopting a slower kernel would have been. If accuracy
  headroom-spending pushes the standard-architecture RTF up
  meaningfully, that trade needs to be weighed explicitly against how
  many currently-marginal captures it would newly refuse — measure both
  before deciding, the same discipline this bake-off just modeled.

**Not pursued, and why:**
- **@happysoftware/nam-web speed wasn't measured.** Its bundled
  worklet-only interface has no plain buffer-in/buffer-out entry point
  to drive fairly outside a real audio graph without materially more
  harness work than the gate needed. Given @opendaw/nam-wasm already
  supplied a clear, decisive answer (both packages wrap the same
  official C++ core, so a similar performance profile is the reasonable
  prior), this wasn't chased further. Worth a quick check if the
  `fastTanh` fix in Path A turns out insufficient and Path B needs
  reopening.
- **Path C (native helper)** — unaffected by this data; already rejected
  in §5 on the latency/zero-install grounds, which nothing here changes.

### 8.5 What to do with §6's plan (M2-M4)

M2 (swap the kernel behind a flag) and M3 (A2 support, oversampling) as
written both assumed Path B. **Do not execute them as written.** A2
support in particular was one of Path B's most attractive properties (a
direct architecture-level answer to the aliasing/quality complaint) and
is now off the table unless a future, faster official-core build changes
the speed verdict — worth re-testing this gate again if one appears,
rather than assuming today's result is permanent. M4 (docs) still applies
in spirit: whatever comes out of the `fastTanh` experiment belongs in
USER-MANUAL.md §4.9 either way.

---

## 9. §8.4's fix, built and measured — our engine is now effectively exact

§8.4 proposed spending some of our engine's unused real-time headroom on
accuracy, targeting `fastTanh`. That was built and measured. **It worked,
and it cost essentially nothing** — but the diagnosis got materially more
precise on the way, and one of §8's own numbers turned out to be
misleading. Both corrections are recorded below.

### 9.1 Correction to §8.2: most of the "2.62% error" was a test artifact

§8.2 reported our engine at 2.62% relative RMSE against the PyTorch
reference. That number is real but **it is not an ongoing tone error** —
it is dominated by a warm-up transient that the test signal was half made
of.

The model's receptive field (dilations 1..512, kernel 3) is
`1 + 2*(1+2+...+512)` = **2047 samples**. The §8 test signal was 4096
samples, so **half of it was inside the warm-up region**. Breaking the
error down by position, with activations made exact so only structural
differences remain:

| sample window | rel. RMSE (exact activations) |
|---|---|
| 0–256 | 7.44% |
| 256–512 | 3.33% |
| 512–1024 | 1.55% |
| 1024–2047 | 0.51% |
| **2047–3072** | **0.0000%** |
| **3072–4096** | **0.0000%** |

Past the receptive field the error is **exactly zero**. Our engine's
steady-state math — weight layout, conv ordering, gating split, head
path — is *bit-exact* to the official reference. There was never a
structural bug; §8.2's implication that ours was "not accurate" was an
artifact of measuring across an unconverged window.

What *is* real: the first ~2047 samples (**~43ms at 48kHz**) don't match
the reference, because our streaming engine's initial ring-buffer state
and PyTorch's `pad_start` zero-padding prime the network differently.
That's a one-time transient when a model loads, long before anyone plays
a note. Not chased further; recorded here so it isn't rediscovered as a
mystery later.

**Measure steady-state only.** The correct comparison, past sample 2047:

| variant | steady-state rel. RMSE |
|---|---|
| old `fastTanh` (order-3/2 Padé) | **1.157%** |
| exact `Math.tanh` | 0.00001% |

So the genuine, ongoing accuracy cost of the activation approximation was
**1.157%** — about **−38.7 dB** relative to the amp signal. Audible as a
broad low-level error layer, and a real answer to complaint #1, just a
smaller one than §8.2 implied.

### 9.2 The old `fastTanh`'s accuracy claim was wrong by ~5x

`nam-processor.js` documented the old approximation as "max error vs true
tanh ~5e-3 near the clamp boundary." Measured directly, both halves of
that are wrong:

- **Real max error: 2.35e-2** — ~5x worse than claimed.
- **It peaks at x≈±1.57**, in the *middle of the active range*, not near
  the clamp.
- Plus a permanent error past the clamp: it returned exactly `1.0` for
  all |x|>3, where `tanh(3)=0.9950` — a standing ~0.5% error on every
  hard-driven sample, exactly where a cranked amp capture spends its time.

The sigmoid was not a separate problem: `0.5*(tanh(x/2)+1)` is
*mathematically identical* to `1/(1+e⁻ˣ)`, so it simply inherited tanh's
error. Confirmed by ablation — swapping only the sigmoid for a "real" one
moved the error 1.157% → 1.129%, i.e. barely at all. **Fixing tanh was
the entire fix.**

### 9.3 The fix: order-7/9 Padé — exact, and not slower

Replaced with the order-7/9 Padé form, clamped at **4.972** (exactly where
the unclamped rational crosses 1.0, so there's no boundary discontinuity).
All six coefficients (135135, 17325, 378, 62370, 3150, 28) are exactly
representable in f32.

| | max err vs true tanh | steady-state rel. RMSE | scalar cost (10M calls) |
|---|---|---|---|
| old order-3/2 Padé | 2.35e-2 | 1.157% | 128 ms |
| **new order-7/9 Padé** | **9.6e-5** | **0.00001%** | **146 ms** |
| `Math.tanh` | 0 | 0.00001% | 233 ms |

It reaches the same accuracy as calling real `tanh` (3.7e-9 max
difference — f32 rounding noise), while remaining substantially cheaper
than `Math.tanh`. The extra multiplies are offset by having no extra
branches and a wider clamp that's hit far less often.

**End-to-end, in the real engine** (standard-architecture model, measured
in Node):

| path | steady-state rel. RMSE | RTF |
|---|---|---|
| WASM, old `fastTanh` | 1.15664% (−38.7 dB) | 0.2803 |
| **WASM, new Padé 7/9** | **0.00001%** (−140 dB) | **0.2867** |
| JS, new Padé 7/9 | 0.00001% | 1.6423 |

**Accuracy improved ~100,000x for a 2.3% RTF cost.** Refuse-threshold
headroom is essentially untouched (0.62 → 0.61 under
`NAM_REFUSE_RT_FACTOR` 0.9), so complaint #2 is not made worse — which
was the whole reason §8 rejected the engine swap.

### 9.4 Toolchain note — rebuilding `nam.wasm` is reproducible

`nam.wasm` was rebuilt from `nam-wasm-src/nam.zig` with **Zig 0.16.0**,
the version `build.sh` names (installed via the `ziglang` PyPI wheel,
since no system package was available). Verified before changing anything:
a 0.16.0 rebuild of the *unmodified* source is **byte-for-byte identical
in output** to the committed artifact (max abs diff 0.000e+0 across the
full test signal). **Zig 0.13.0 is not a valid substitute** — it compiles,
but the resulting module traps with "memory access out of bounds" on the
first `forward()` call, presumably an arena/heap-base layout difference.
Pin 0.16.x when rebuilding.

Post-change verification: the JS and WASM paths still agree to 3.7e-9
(f32 noise — they were never bit-identical, since scalar JS carries f64
intermediates where the SIMD kernel is pure f32), and the rebuilt module
compiles, instantiates, and drives the live rig in a real headless browser
with no errors.

### 9.5 What's left

- **Warm-up transient (§9.1)** — ~43ms of non-reference-matching output
  when a model first loads. Bounded, inaudible in practice, not chased.
  Worth a look only if someone reports a click/thump on preset switching.
- **Complaint #2 (refusals)** is untouched by this work and remains open.
  Our engine is still the fastest measured option, so the headroom to
  attack it with is intact — but nothing here reduces refusals.
- **The A2 architecture family** remains unsupported, per §8.5.
