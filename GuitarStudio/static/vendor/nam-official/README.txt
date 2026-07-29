@opendaw/nam-wasm 1.2.0 — a headless WebAssembly build of the OFFICIAL
Neural Amp Modeler inference core (sdatkinson/NeuralAmpModelerCore), MIT.
Vendored rather than loaded from a CDN, matching this app's local-first
design — see ../alphatab/README.txt for the same policy.

  nam.js     70KB  Emscripten glue (ES module; statically imported by
                   ../../nam-processor.js — dynamic import() is disallowed
                   in WorkletGlobalScope, so it must be static).
  nam.wasm  357KB  The core itself. NOT fetched by the worklet (no fetch in
                   AudioWorkletGlobalScope) — playalong.js fetches the bytes
                   on the main thread and posts them over.
  LICENSE          MIT (upstream package's own).

WHY THIS EXISTS, given we already have our own engine:
Our hand-written engine (../../nam-processor.js + nam-wasm-src/nam.zig)
handles NAM "A1" — the standard/lite/feather/nano WaveNet family — and is
measurably ~1.9x FASTER than this core on those models, so it stays the
primary path. What it cannot do is NAM "A2" and the newer variants:
FiLM conditioning at eight insertion points, grouped convolutions, grouped
head1x1/layer1x1, a nested condition_dsp network, blended gating, and the
SlimmableContainer wrapper. Implementing all of that ourselves would be a
large build with a lot of surface for silently-wrong audio.

This core loads and renders every one of them (verified against the
upstream example_models: A1 standard, A2 max, A2/SlimmableContainer,
slimmable_wavenet, condition_dsp, LSTM). A2 models are also ~17x smaller
than A1 standard by design (818 vs 13802 weights — they target $3 ARM
chips), so this core's per-weight speed disadvantage is irrelevant there:
measured RTF 0.157 for A2-max vs ~0.30 for our own engine on A1 standard.

So: ours for A1 (faster), this for everything else (correct). The routing
lives in nam-processor.js's buildModelAny().

GOTCHA worth keeping: this glue calls `new URL("nam.wasm", import.meta.url)`
unless a `locateFile` option is supplied — and `URL` is not a global in
AudioWorkletGlobalScope, so it throws at module-init. Always pass
`locateFile: (p) => p`. (@happysoftware/nam-web's own worklet build ships a
hand-rolled URL polyfill for exactly this.)
