"use strict";

// Neural amp modeler (NAM) inference, from scratch, running in our own
// AudioContext with zero bridging latency.
//
// Why from scratch instead of the vendored neural-amp-modeler-wasm: that
// library (MIT, TONE3000's fork of the official NeuralAmpModelerCore) is a
// real, well-built WASM port — but it creates and owns its own private
// AudioContext internally (Emscripten's Web Audio Worklets API is designed
// around the module owning the audio thread), so getting its output into
// our existing mixer graph would require a MediaStream bridge between two
// separate contexts, typically adding 100ms+ of latency on top of the
// existing input path. That directly conflicts with this app's single-graph,
// low-latency requirement for live monitoring, so this is a hand-written
// reimplementation of the standard NAM "WaveNet" architecture's forward
// pass instead — reading .nam JSON files directly, no WASM involved.
//
// The math here is not guessed: it's reverse-engineered directly from the
// official sdatkinson/NeuralAmpModelerCore C++ source (NAM/conv1d.cpp,
// NAM/dsp.cpp, NAM/wavenet/model.cpp, NAM/gating_activations.h) to get the
// weight layout and layer topology exactly right — verified by computing
// the expected weight count for a real downloaded sample model (TONE3000's
// deluxe.nam) by hand from this same logic and confirming it matches the
// file's actual weight array length exactly (13801 architecture weights +
// 1 trailing head_scale = 13802).
//
// Scope: supports the standard (legacy-schema) non-parametric WaveNet
// architecture every ordinary guitar/amp .nam capture uses — gated or
// ungated, any channel/dilation/kernel-size config, single-condition
// (raw-audio-conditioned) layers. Does not support FiLM conditioning,
// grouped/depthwise convs, blended gating, or the LSTM architecture — those
// only appear in the newer parametric "A2"/slimmable model family, not in
// ordinary shared captures.

// ---------------------------------------------------------------------------
// Activations
// ---------------------------------------------------------------------------

// Rational (Padé) tanh approximation instead of Math.tanh: the activation
// runs ~240x per sample ≈ 11M calls/sec for a standard-architecture
// capture, and Math.tanh was one of the three big reasons inference
// measured 1.4-1.5x SLOWER than real time for standard models (see the
// realtime-factor probe in playalong.js).
//
// This is the ORDER-7/9 Padé form. It replaced the order-3/2 one
// ((x*(27+x²))/(27+9x²), clamped at |x|>3) this file used originally,
// whose accuracy claim — "max error vs true tanh ~5e-3" — was measured
// and found to be wrong by ~5x: its real max error is 2.35e-2, at
// x≈±1.57, i.e. in the middle of the active range rather than "near the
// clamp boundary", plus a permanent ~0.5% error everywhere past the clamp
// (it returned exactly 1.0 where tanh(3)=0.9950).
//
// That mattered: measured against the official NAM PyTorch reference on a
// standard-architecture model (16ch, gated, dilations 1..512), the old
// form put our steady-state output 1.157% off the reference; this one puts
// it 0.00001% off — i.e. bit-exact to within f32 rounding, indistinguishable
// from calling real tanh. It is also NOT slower: measured marginally
// FASTER than the old 3/2 form (more multiplies, but no extra branches and
// a wider clamp that's hit less often), and clearly faster than Math.tanh.
// See research/nam-engine-review-spec.md §9 for the full measurements.
//
// Clamp at 4.972 is exactly where the unclamped rational crosses 1.0, so
// there's no discontinuity at the boundary; every coefficient below is
// exactly representable in f32. Max error vs true tanh: 9.6e-5.
//
// nam.zig's fastTanh() is the bit-for-bit twin of this — change both
// together or the WASM and JS paths stop agreeing (there's a regression
// test for exactly that: see the spec's §9 harness).
function fastTanh(x) {
  if (x > 4.972) return 1;
  if (x < -4.972) return -1;
  const x2 = x * x;
  const num = x * (135135 + x2 * (17325 + x2 * (378 + x2)));
  const den = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28));
  return num / den;
}

// Mathematically exact given an exact tanh: 0.5*(tanh(x/2)+1) === 1/(1+e⁻ˣ).
// So this inherits fastTanh's accuracy rather than adding error of its own —
// which is why fixing tanh above was the whole fix; swapping THIS for a
// "real" sigmoid on its own moved the error only 1.157% -> 1.129%.
function sigmoid(x) { return 0.5 * (fastTanh(0.5 * x) + 1); }

function makeActivation(name) {
  switch ((name || "").toLowerCase()) {
    case "tanh":
    case "fasttanh":
      return fastTanh;
    case "sigmoid":
      return sigmoid;
    case "softsign":
      return (x) => x / (1 + Math.abs(x));
    case "relu":
      return (x) => (x > 0 ? x : 0);
    case "identity":
    case "":
      return (x) => x;
    default:
      return fastTanh; // the overwhelming majority of public captures use Tanh
  }
}

// ---------------------------------------------------------------------------
// Weight stream — mirrors the exact consumption order of the C++ classes
// (Conv1D::set_weights_, Conv1x1::set_weights_ in NAM/conv1d.cpp, NAM/dsp.cpp)
// ---------------------------------------------------------------------------

class WeightReader {
  constructor(weights) { this.w = weights; this.i = 0; }
  next() { return this.w[this.i++]; }
  remaining() { return this.w.length - this.i; }

  // Conv1x1 / pointwise layer: row-major (out, in), no interleaving.
  takeMatrix(outCh, inCh) {
    const m = new Float32Array(outCh * inCh);
    for (let i = 0; i < outCh; i++) {
      for (let j = 0; j < inCh; j++) m[i * inCh + j] = this.next();
    }
    return m;
  }

  // Dilated Conv1D: for each (out,in) pair, all K kernel taps are
  // contiguous — NOT K separate sequential matrices. Returns K matrices,
  // each (outCh x inCh), reassembled from that interleaving.
  takeConv1DWeights(outCh, inCh, kernelSize) {
    const mats = [];
    for (let k = 0; k < kernelSize; k++) mats.push(new Float32Array(outCh * inCh));
    for (let i = 0; i < outCh; i++) {
      for (let j = 0; j < inCh; j++) {
        for (let k = 0; k < kernelSize; k++) mats[k][i * inCh + j] = this.next();
      }
    }
    return mats;
  }

  takeVector(n) {
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = this.next();
    return v;
  }
}

// ---------------------------------------------------------------------------
// Per-layer causal history ring buffer (channels x lookback)
// ---------------------------------------------------------------------------

// Sized to hold a full processing block PLUS the layer's dilation span, so
// a whole block can be pushed up front and every tap for every sample in
// the block is still present (a bare dilation-span ring would overwrite
// in-block samples that later samples' taps still need).
const MAX_BLOCK = 128; // render quantum size; process() chunks anything larger

class RingHistory {
  constructor(channels, dilationSpan) {
    this.channels = channels;
    this.length = MAX_BLOCK + dilationSpan;
    this.buf = new Float32Array(this.channels * this.length);
    this.pos = 0; // next write slot
  }

  // Copies n samples (sample-major, [t*channels + c]) into the ring.
  // Returns the ring index of the block's first sample.
  pushBlock(block, n) {
    const ch = this.channels, len = this.length;
    const start = this.pos;
    const firstChunk = Math.min(n, len - start);
    this.buf.set(block.subarray(0, firstChunk * ch), start * ch);
    if (firstChunk < n) {
      this.buf.set(block.subarray(firstChunk * ch, n * ch), 0);
    }
    this.pos = (start + n) % len;
    return start;
  }
}

// ---------------------------------------------------------------------------
// Model construction from parsed .nam JSON
// ---------------------------------------------------------------------------

function buildLayer(reader, channels, bottleneck, conditionSize, dilation, kernelSize, gated) {
  const convOutCh = gated ? 2 * bottleneck : bottleneck;
  const convMats = reader.takeConv1DWeights(convOutCh, channels, kernelSize);
  const convBias = reader.takeVector(convOutCh);
  const mixinW = reader.takeMatrix(convOutCh, conditionSize);
  const layer1x1W = reader.takeMatrix(channels, bottleneck);
  const layer1x1Bias = reader.takeVector(channels);

  return {
    dilation, kernelSize, convMats, convBias, mixinW, layer1x1W, layer1x1Bias,
    history: new RingHistory(channels, dilation * (kernelSize - 1)),
    // Preallocated block scratch (reused every call — zero per-block GC
    // pressure), sample-major [t*width + i].
    _z: new Float32Array(MAX_BLOCK * convOutCh),
    _activated: new Float32Array(MAX_BLOCK * bottleneck),
  };
}

function buildLayerArray(cfg, reader) {
  const channels = cfg.channels;
  const bottleneck = cfg.bottleneck ?? channels;
  const conditionSize = cfg.condition_size;
  const inputSize = cfg.input_size;
  const kernelSize = cfg.kernel_size;
  const dilations = cfg.dilations;
  const gated = !!cfg.gated;
  const headSize = cfg.head_size;
  const headBias = !!cfg.head_bias;
  const activationName = Array.isArray(cfg.activation) ? cfg.activation[0] : cfg.activation;
  const activationFn = makeActivation(activationName);

  const rechannelW = reader.takeMatrix(channels, inputSize);
  const layers = dilations.map((d) =>
    buildLayer(reader, channels, bottleneck, conditionSize, d, kernelSize, gated));

  const headOutSize = bottleneck; // head1x1 not supported (see file header) — always the bottleneck path
  const headRechannelMats = reader.takeConv1DWeights(headSize, headOutSize, 1);
  const headRechannelBias = headBias ? reader.takeVector(headSize) : new Float32Array(headSize);

  // The activation is fastTanh for virtually every capture — flag it so the
  // hot loops can call it directly instead of through a closure indirection.
  const actIsTanh = activationFn === fastTanh;

  return {
    channels, bottleneck, conditionSize, inputSize, headSize, gated, activationFn, actIsTanh, headOutSize,
    rechannelW, layers, headRechannelMats, headRechannelBias,
    // Block buffers, sample-major [t*width + i]. _blkA/_blkB ping-pong as
    // layer input/output down the stack.
    _blkA: new Float32Array(MAX_BLOCK * channels),
    _blkB: new Float32Array(MAX_BLOCK * channels),
    _headAccum: new Float32Array(MAX_BLOCK * headOutSize),
    _headOut: new Float32Array(MAX_BLOCK * headSize),
  };
}

// ---------------------------------------------------------------------------
// Config normalization + capability gate (NAM "A1" only)
// ---------------------------------------------------------------------------
//
// Two jobs, and the second one matters more than the first:
//
// 1. ACCEPT BOTH SCHEMAS. The official .nam config layout changed (legacy
//    files, ~v0.5.x, are still the bulk of what's circulating; current
//    exporters write v0.6/v0.7). Renamed/reshaped fields:
//        kernel_size: 3          -> kernel_sizes: [3,3,...]
//        activation: "Tanh"      -> activation: [{"type":"Tanh"}, ...]
//        gated: true             -> gating_mode: ["gated", ...]
//        head_size / head_bias   -> head: {out_channels, kernel_size, bias}
//    NAM's own loader (nam/models/_from_nam.py) reads both; so do we now.
//    Before this, a current-format file died with the raw internal error
//    `(name || "").toLowerCase is not a function`.
//
// 2. REFUSE WHAT WE'D OTHERWISE GET WRONG. This is the important half. The
//    newer format can express architectural features this engine does not
//    implement — and, verified by rendering against the official PyTorch
//    reference, feeding them in did NOT throw: it silently produced wrong
//    audio (measured: blended gating ~1060% off, head1x1 ~173% off,
//    per-layer kernel sizes ~110% off, per-layer activations ~76% off,
//    grouped convs and layer1x1-disabled produced NaN). Silently wrong
//    audio is far worse than a refusal, so every one of those is an
//    explicit throw now.
//
//    Callers treat a throw here as "our engine can't do this one" and route
//    the model to the official-core engine instead (see buildModelAny) —
//    which is exactly why these checks must be exhaustive rather than
//    best-effort. Anything newly supported here must be REMOVED from the
//    refusal list, never left to fall through.
//
// Returns a normalized shallow copy in the legacy shape the readers below
// expect. Throws Error on anything unsupported.
const NAM_SUPPORTED_ACTIVATIONS = new Set(["tanh", "fasttanh", "sigmoid", "softsign", "relu", "identity", ""]);

function normalizeNamConfig(namJson) {
  if (namJson.architecture !== "WaveNet") {
    // Covers LSTM/Linear/ConvNet, and A2's "SlimmableContainer" wrapper.
    throw new Error(`unsupported architecture '${namJson.architecture}' (this engine handles standard WaveNet only)`);
  }
  const config = namJson.config || {};
  if (config.condition_dsp) {
    // A2 conditions the network with a whole nested WaveNet; we have no
    // machinery for a second network feeding the condition input.
    throw new Error("model uses condition_dsp (a nested conditioning network) — not supported");
  }
  if (!Array.isArray(config.layers) || !config.layers.length) {
    throw new Error("model has no layer arrays");
  }

  // All-equal helper: the new format allows PER-LAYER variation of these,
  // but this engine applies one value across a whole layer array (see
  // buildLayerArray). Reading element [0] and applying it to every layer
  // would silently mis-render a file that actually varies them, so a
  // varying file is refused rather than approximated.
  const uniform = (arr, label) => {
    const first = JSON.stringify(arr[0]);
    for (let i = 1; i < arr.length; i++) {
      if (JSON.stringify(arr[i]) !== first) {
        throw new Error(`model varies ${label} per layer — not supported`);
      }
    }
    return arr[0];
  };

  const layers = config.layers.map((lc, li) => {
    const where = `layer array ${li}`;

    // --- A2 / advanced features we do not implement ---
    const filmKeys = ["conv_pre_film", "conv_post_film", "input_mixin_pre_film", "input_mixin_post_film",
                      "activation_pre_film", "activation_post_film", "layer1x1_post_film", "head1x1_post_film"];
    for (const k of filmKeys) {
      const v = lc[k];
      if (v && (v.active === undefined ? Object.keys(v).length > 0 : v.active)) {
        throw new Error(`${where} uses FiLM conditioning (${k}) — not supported`);
      }
    }
    if (lc.head1x1 && lc.head1x1.active) throw new Error(`${where} uses head1x1 — not supported`);
    // layer1x1 is read unconditionally by buildLayer, so a file that turns
    // it OFF has fewer weights than we'd consume — misreads everything
    // after it (measured: NaN output).
    if (lc.layer1x1 && lc.layer1x1.active === false) throw new Error(`${where} disables layer1x1 — not supported`);
    if (lc.layer1x1 && lc.layer1x1.groups && lc.layer1x1.groups !== 1) throw new Error(`${where} uses grouped layer1x1 — not supported`);
    if ((lc.groups_input ?? 1) !== 1 || (lc.groups_input_mixin ?? 1) !== 1) {
      throw new Error(`${where} uses grouped convolutions — not supported`);
    }
    if (lc.slimmable) throw new Error(`${where} is slimmable — not supported`);
    if (lc.packing) throw new Error(`${where} uses packed convolutions — not supported`);

    // --- gating ---
    let gated;
    if (lc.gating_mode !== undefined && lc.gating_mode !== null) {
      const modes = Array.isArray(lc.gating_mode) ? lc.gating_mode : [lc.gating_mode];
      const mode = uniform(modes, "gating mode");
      if (mode === "blended") throw new Error(`${where} uses blended gating — not supported`);
      if (mode !== "gated" && mode !== "none") throw new Error(`${where} uses unknown gating mode '${mode}'`);
      gated = mode === "gated";
    } else {
      gated = !!lc.gated; // legacy
    }

    // --- kernel size ---
    let kernelSize;
    if (Array.isArray(lc.kernel_sizes)) kernelSize = uniform(lc.kernel_sizes, "kernel size");
    else if (Array.isArray(lc.kernel_size)) kernelSize = uniform(lc.kernel_size, "kernel size");
    else kernelSize = lc.kernel_sizes ?? lc.kernel_size;
    if (!Number.isFinite(kernelSize)) throw new Error(`${where} has no usable kernel size`);

    // --- activation ---
    let act = lc.activation;
    if (Array.isArray(act)) act = uniform(act, "activation");
    if (act && typeof act === "object") {
      // New format: {"type":"Tanh"} — and a PairMultiply/PairBlend object
      // here would mean gating expressed activation-side rather than via
      // gating_mode, which we'd otherwise silently read as its bare name.
      if (act.primary !== undefined || act.secondary !== undefined || act.name !== undefined) {
        throw new Error(`${where} uses a paired/gating activation object — not supported`);
      }
      act = act.type;
    }
    const actName = String(act || "").toLowerCase();
    if (!NAM_SUPPORTED_ACTIVATIONS.has(actName)) throw new Error(`${where} uses unsupported activation '${act}'`);

    // --- head ---
    let headSize, headBias;
    if (lc.head && typeof lc.head === "object") {
      if (lc.head.kernel_size !== undefined && lc.head.kernel_size !== 1) {
        throw new Error(`${where} head rechannel kernel_size ${lc.head.kernel_size} — only 1 supported`);
      }
      headSize = lc.head.out_channels;
      headBias = !!lc.head.bias;
    } else {
      headSize = lc.head_size;
      headBias = !!lc.head_bias;
    }
    if (!Number.isFinite(headSize)) throw new Error(`${where} has no usable head size`);

    return { ...lc, kernel_size: kernelSize, activation: act, gated, head_size: headSize, head_bias: headBias };
  });

  return { ...namJson, config: { ...config, layers } };
}

function buildModel(namJson) {
  namJson = normalizeNamConfig(namJson);
  const config = namJson.config;
  const reader = new WeightReader(Float32Array.from(namJson.weights));
  const layerArrays = config.layers.map((lc) => buildLayerArray(lc, reader));

  // Trailing weight is head_scale (see file header — confirmed against a
  // real downloaded model's exact weight count). Falls back to the config's
  // own head_scale field if the array is exactly consumed without one
  // (shouldn't happen for a real exported .nam, but fail soft rather than
  // throw on an unexpected but harmless file).
  const headScale = reader.remaining() >= 1 ? reader.next() : (config.head_scale ?? 1.0);

  let outputGainDb = 0;
  if (namJson.metadata && typeof namJson.metadata.loudness === "number") {
    // Match the reference wrapper's behavior (t3k-wasm-module.cpp): normalize
    // toward a -18dB LUFS-ish reference so different amp captures don't come
    // out at wildly different volumes.
    outputGainDb = -18 - namJson.metadata.loudness;
  }

  return {
    layerArrays, headScale, outputGainDb,
    _in1: new Float32Array(1), _out1: new Float32Array(1), // forwardSample's 1-sample block
  };
}

// Hot path — processes a whole block (≤ MAX_BLOCK samples) through one
// layer array, one LAYER at a time across the full block rather than one
// sample at a time through the whole stack. That's legal because WaveNet
// layers have no within-sample recurrence between each other — each layer
// only recurses on its own input history — and it's what finally made
// standard-architecture captures realtime in plain JS: each weight matrix
// stays hot in cache for 128 consecutive samples instead of being
// re-walked per sample, and the inner loops get long enough for the JIT
// to earn its keep. Additional rules: zero allocations (all buffers are
// preallocated at build time — a single `new Float32Array` per layer per
// sample was ~1M allocations/sec of GC pressure), history taps read in
// place from the ring (increment + wrap check, no modulo, no copy-out),
// and transcendentals are the fast rational approximations above.
//
// Layouts are all sample-major: block[t*width + i]. inputBlock has width
// la.inputSize; condBlock is the raw network input (width 1 — the
// condition for every ordinary capture); headCarry is the previous layer
// array's _headOut (width prevHeadSize) or null. Returns the layer output
// block (width la.channels); the head output lands in la._headOut.
function processLayerArrayBlock(la, inputBlock, inputWidth, condBlock, headCarry, prevHeadSize, n) {
  const channels = la.channels;

  // Rechannel input → _blkA
  const rechannelW = la.rechannelW;
  let cur = la._blkA;
  if (inputWidth === 1) {
    for (let t = 0; t < n; t++) {
      const x = inputBlock[t], base = t * channels;
      for (let c = 0; c < channels; c++) cur[base + c] = rechannelW[c] * x;
    }
  } else {
    for (let t = 0; t < n; t++) {
      const inBase = t * inputWidth, outBase = t * channels;
      for (let c = 0; c < channels; c++) {
        let acc = 0;
        const mBase = c * inputWidth;
        for (let j = 0; j < inputWidth; j++) acc += rechannelW[mBase + j] * inputBlock[inBase + j];
        cur[outBase + c] = acc;
      }
    }
  }

  // Head accumulator ← previous array's head output (or zero)
  const headOutSize = la.headOutSize;
  const headAccum = la._headAccum;
  if (headCarry) {
    const copyW = Math.min(prevHeadSize, headOutSize);
    for (let t = 0; t < n; t++) {
      const src = t * prevHeadSize, dst = t * headOutSize;
      for (let i = 0; i < copyW; i++) headAccum[dst + i] = headCarry[src + i];
      for (let i = copyW; i < headOutSize; i++) headAccum[dst + i] = 0;
    }
  } else {
    headAccum.fill(0, 0, n * headOutSize);
  }

  const condIsScalar = la.conditionSize === 1;
  const bottleneck = la.bottleneck;
  const gated = la.gated;
  const actIsTanh = la.actIsTanh;
  const activationFn = la.activationFn;
  let out = la._blkB;

  for (const layer of la.layers) {
    const hist = layer.history;
    const histBuf = hist.buf;
    const histLen = hist.length;
    const startIdx = hist.pushBlock(cur, n);
    const convOutCh = layer.convBias.length;
    const K = layer.kernelSize;
    const z = layer._z;
    const convBias = layer.convBias;
    const mixinW = layer.mixinW;

    // z ← bias + conditioning mix-in (conditionSize is 1 for every ordinary
    // capture — the raw input sample is the condition — so the mix-in
    // collapses to one multiply per output channel).
    if (condIsScalar) {
      for (let t = 0; t < n; t++) {
        const c0 = condBlock[t], base = t * convOutCh;
        for (let i = 0; i < convOutCh; i++) z[base + i] = convBias[i] + mixinW[i] * c0;
      }
    } else {
      const condW = la.conditionSize;
      for (let t = 0; t < n; t++) {
        const cBase = t * condW, base = t * convOutCh;
        for (let i = 0; i < convOutCh; i++) {
          let acc = convBias[i];
          const mBase = i * condW;
          for (let j = 0; j < condW; j++) acc += mixinW[mBase + j] * condBlock[cBase + j];
          z[base + i] = acc;
        }
      }
    }

    // Dilated conv: k outermost so each tap matrix stays hot across the block.
    for (let k = 0; k < K; k++) {
      const mat = layer.convMats[k];
      let idx = startIdx - layer.dilation * (K - 1 - k);
      if (idx < 0) idx += histLen;
      for (let t = 0; t < n; t++) {
        const hBase = idx * channels, zBase = t * convOutCh;
        for (let i = 0; i < convOutCh; i++) {
          let acc = 0;
          const mBase = i * channels;
          for (let j = 0; j < channels; j++) acc += mat[mBase + j] * histBuf[hBase + j];
          z[zBase + i] += acc;
        }
        idx++;
        if (idx === histLen) idx = 0;
      }
    }

    // Activation (+ gate), head accumulation, 1x1 + residual — fused per block.
    const activated = layer._activated;
    if (gated) {
      for (let t = 0; t < n; t++) {
        const zBase = t * convOutCh, aBase = t * bottleneck;
        if (actIsTanh) {
          for (let i = 0; i < bottleneck; i++) activated[aBase + i] = fastTanh(z[zBase + i]) * sigmoid(z[zBase + bottleneck + i]);
        } else {
          for (let i = 0; i < bottleneck; i++) activated[aBase + i] = activationFn(z[zBase + i]) * sigmoid(z[zBase + bottleneck + i]);
        }
      }
    } else if (actIsTanh) {
      for (let t = 0; t < n; t++) {
        const zBase = t * convOutCh, aBase = t * bottleneck;
        for (let i = 0; i < bottleneck; i++) activated[aBase + i] = fastTanh(z[zBase + i]);
      }
    } else {
      for (let t = 0; t < n; t++) {
        const zBase = t * convOutCh, aBase = t * bottleneck;
        for (let i = 0; i < bottleneck; i++) activated[aBase + i] = activationFn(z[zBase + i]);
      }
    }

    for (let t = 0; t < n; t++) {
      const aBase = t * bottleneck, hBase = t * headOutSize;
      for (let i = 0; i < headOutSize; i++) headAccum[hBase + i] += activated[aBase + i];
    }

    const w1x1 = layer.layer1x1W;
    const b1x1 = layer.layer1x1Bias;
    for (let t = 0; t < n; t++) {
      const aBase = t * bottleneck, ioBase = t * channels;
      for (let c = 0; c < channels; c++) {
        let acc = b1x1[c];
        const mBase = c * bottleneck;
        for (let j = 0; j < bottleneck; j++) acc += w1x1[mBase + j] * activated[aBase + j];
        out[ioBase + c] = cur[ioBase + c] + acc;
      }
    }

    // Ping-pong: this layer's output is the next layer's input. Safe —
    // pushBlock copies the input into the history before it's overwritten.
    const tmp = cur; cur = out; out = tmp;
  }

  // Head rechannel
  const headMat = la.headRechannelMats[0];
  const headBias = la.headRechannelBias;
  const headSize = la.headSize;
  const headOut = la._headOut;
  for (let t = 0; t < n; t++) {
    const hBase = t * headOutSize, oBase = t * headSize;
    for (let i = 0; i < headSize; i++) {
      let acc = headBias[i];
      const mBase = i * headOutSize;
      for (let j = 0; j < headOutSize; j++) acc += headMat[mBase + j] * headAccum[hBase + j];
      headOut[oBase + i] = acc;
    }
  }

  return cur;
}

// n ≤ MAX_BLOCK samples: inBlock (raw input) → outBlock (amp output).
function forwardBlock(model, inBlock, outBlock, n) {
  let block = inBlock;
  let width = 1;
  let headCarry = null;
  let prevHeadSize = 0;
  let lastHeadSize = 1;
  for (const la of model.layerArrays) {
    block = processLayerArrayBlock(la, block, width, inBlock, headCarry, prevHeadSize, n);
    width = la.channels;
    headCarry = la._headOut;
    prevHeadSize = la.headSize;
    lastHeadSize = la.headSize;
  }
  const headScale = model.headScale;
  for (let t = 0; t < n; t++) outBlock[t] = headScale * headCarry[t * lastHeadSize];
}

// Single-sample convenience wrapper (calibration uses it; live audio goes
// through forwardBlock directly).
function forwardSample(model, rawInputSample) {
  model._in1[0] = rawInputSample;
  forwardBlock(model, model._in1, model._out1, 1);
  return model._out1[0];
}

// Real-world .nam captures overwhelmingly lack the metadata.loudness field
// the reference-wrapper normalization above depends on (measured: 260/261
// in one real community NAM library) — leaving them at raw, uncalibrated
// output level, which for some captures is 20+ dB quieter than others. Amp
// mode selection consequently barely seemed to do anything: not because
// inference was broken, but because the quiet captures were nearly
// inaudible next to whatever was played before them. Auto-calibrate against
// a fixed test tone the same way GP-10 auto-calibrates input level from a
// played chord, just with a synthesized signal instead of a live one (no
// take-back-able "play your loudest chord" step makes sense for a file
// that loads instantly). Runs on a disposable second model build so the
// real model's causal-conv history stays untouched (zeroed) for actual
// playback, not polluted by the calibration tone.
// Calibration must NOT run as one synchronous block in the message
// handler: that handler shares the real-time render thread with every
// process() call in the context, and one blocking pass over the test tone
// (~90-240ms measured) overruns the 128-sample quantum budget ~35-80x.
// With a fresh, idle context that's survivable — which is exactly why
// "load a model first, then play" seemed to work — but stalling a render
// thread that's actively serving audio (mixer playing, or an
// already-loaded model doing per-sample inference) makes macOS kill the
// whole audio stream: every node in the context goes permanently silent
// until a page reload builds a new context. So calibration is spread
// across process() calls instead, CALIBRATION_SAMPLES_PER_QUANTUM probe
// samples per quantum, passing the dry signal through until done. The
// slice is HALF a normal quantum's inference (the model is inactive while
// calibrating, so total load stays below the model-loaded steady state the
// machine demonstrably sustains — a first cut at 256/quantum was 3x that
// and caused 12 consecutive deadline overruns on a real USB audio stream,
// killing it just like the original blocking version). This in-process()
// path is a fallback only: the primary caller (playalong.js) pre-computes
// the gain in a throwaway OfflineAudioContext, where blocking is free, and
// the live node then activates instantly with zero measurement work.
// At 110Hz, 2048 measured samples is still ~5 full cycles.
const CALIBRATION_TEST_FREQ = 110; // Hz — roughly guitar A2
const CALIBRATION_TEST_AMPLITUDE = 0.3; // typical DI/pickup level pre-amp
const CALIBRATION_WARMUP_SAMPLES = 1024; // let dilated-conv history settle before measuring
const CALIBRATION_MEASURE_SAMPLES = 2048;
const CALIBRATION_SAMPLES = CALIBRATION_WARMUP_SAMPLES + CALIBRATION_MEASURE_SAMPLES;
const CALIBRATION_TARGET_RMS = 0.2; // comfortable reference level, well under clipping
const CALIBRATION_SAMPLES_PER_QUANTUM = 64;

// ---------------------------------------------------------------------------
// WASM/SIMD engine — same math as buildModel/forwardBlock above (the JS
// engine stays as the correctness reference AND the fallback path), ported
// to a standalone WebAssembly module (GuitarStudio/static/nam-wasm-src/
// nam.zig, compiled to nam.wasm) so the hot per-(out,in) matVec loops run
// as SIMD v128/f32x4 dot products instead of scalar JS. Measured ~11x
// faster than the block-processed JS engine on real standard-architecture
// captures (see the commit message for numbers) — the point isn't shaving
// the JS engine's ~1x-of-realtime down further, it's putting real headroom
// under NAM_REFUSE_RT_FACTOR instead of sitting right at its edge.
//
// This module does NOT fetch its own .wasm bytes — AudioWorkletGlobalScope
// has no reliable fetch/streaming-compile in every browser, so
// playalong.js compiles nam.wasm on the main thread and posts the
// resulting WebAssembly.Module over to this processor's port (a Module is
// structured-clone-transferable). If that never arrives, fails to compile,
// or fails to instantiate (e.g. no wasm SIMD support), this processor
// falls back to the JS engine above — the WASM path is strictly additive,
// never a hard requirement, per every model-load call site's own
// try/catch.
//
// Memory layout: a bump-allocated arena inside the WASM module's own
// linear memory (self-locating heap base — see nam.zig's resetArena()/
// allocBytes(), no hardcoded offsets). buildModelWasm() below mirrors
// buildModel/buildLayerArray/buildLayer's weight-consumption order exactly
// (WeightReader's interleaved Conv1D-tap order in particular) but writes
// straight into that WASM memory instead of separate JS Float32Arrays, and
// emits a compact "layout table" (a flat run of i32 fields — channel
// counts, gated/activation flags, byte-offset pointers to every weight
// matrix/bias/history-ring/scratch buffer) that nam.zig's forward() walks
// each block. Field order is duplicated by hand in both nam.zig and here;
// LA_*/LY_* below must stay in sync with nam.zig's LA_*/LY_* constants.
const NAM_WASM_MAX_BLOCK = 128;
const LA_STRIDE = 18; // words per layer-array record
const LY_STRIDE = 11; // words per per-dilation-layer record
const WASM_ACT_CODE = { tanh: 0, fasttanh: 0, sigmoid: 1, softsign: 2, relu: 3, identity: 4, "": 4 };

class WasmArena {
  constructor(exports) {
    this.exports = exports;
    this.exports.resetArena();
    this._refresh();
  }
  _refresh() {
    this.i32 = new Int32Array(this.exports.memory.buffer);
    this.f32 = new Float32Array(this.exports.memory.buffer);
  }
  // allocBytes() may grow WASM memory, which detaches the previous
  // ArrayBuffer — refresh the typed-array views after every call before
  // writing through them again.
  allocBytes(n) {
    const off = this.exports.allocBytes(n >>> 0);
    this._refresh();
    return off;
  }
  allocF32(nFloats) { return this.allocBytes(nFloats * 4); }
  writeF32(off, arr) { this.f32.set(arr, off / 4); }
  writeI32(off, idx, val) { this.i32[off / 4 + idx] = val; }
}

// Interleaved Conv1D taps (see WeightReader.takeConv1DWeights above) ->
// K separate (outCh x inCh) matrices written CONTIGUOUSLY (matches
// nam.zig's `convMatsBase + k*convOutCh*channels*4` addressing).
function wasmWriteConv1DWeights(arena, reader, outCh, inCh, kernelSize) {
  const base = arena.allocF32(kernelSize * outCh * inCh);
  const tmp = new Float32Array(kernelSize * outCh * inCh);
  for (let i = 0; i < outCh; i++) {
    for (let j = 0; j < inCh; j++) {
      for (let k = 0; k < kernelSize; k++) tmp[k * outCh * inCh + i * inCh + j] = reader.next();
    }
  }
  arena.writeF32(base, tmp);
  return base;
}
function wasmWriteMatrix(arena, reader, outCh, inCh) {
  const base = arena.allocF32(outCh * inCh);
  const tmp = new Float32Array(outCh * inCh);
  for (let i = 0; i < outCh; i++) for (let j = 0; j < inCh; j++) tmp[i * inCh + j] = reader.next();
  arena.writeF32(base, tmp);
  return base;
}
function wasmWriteVector(arena, reader, n) {
  const base = arena.allocF32(n);
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) tmp[i] = reader.next();
  arena.writeF32(base, tmp);
  return base;
}
function wasmWriteZeroVector(arena, n) {
  const base = arena.allocF32(n);
  arena.writeF32(base, new Float32Array(n));
  return base;
}

// Builds a model's full WASM-memory layout. Throws on the same conditions
// buildModel() would (unsupported architecture etc.) — callers must catch
// and fall back to buildModel() exactly like they already catch buildModel
// itself failing.
function buildModelWasm(namJson, exports) {
  // Same schema normalization + capability gate as the JS path — the two
  // engines must accept and refuse exactly the same set of files, or
  // buildModelAny's "WASM first, JS second, official core last" ladder
  // would change which engine renders a model depending on which one
  // happened to be available.
  namJson = normalizeNamConfig(namJson);
  const arena = new WasmArena(exports);
  const config = namJson.config;
  const reader = new WeightReader(Float32Array.from(namJson.weights));

  const numLA = config.layers.length;
  const headerPtr = arena.allocBytes(4 + numLA * LA_STRIDE * 4);
  arena.writeI32(headerPtr, 0, numLA);

  for (let li = 0; li < numLA; li++) {
    const cfg = config.layers[li];
    const channels = cfg.channels;
    const bottleneck = cfg.bottleneck ?? channels;
    const conditionSize = cfg.condition_size;
    const inputSize = cfg.input_size;
    const kernelSize = cfg.kernel_size;
    const dilations = cfg.dilations;
    const gated = !!cfg.gated;
    const headSize = cfg.head_size;
    const headBias = !!cfg.head_bias;
    const activationName = (Array.isArray(cfg.activation) ? cfg.activation[0] : cfg.activation || "").toLowerCase();
    const actCode = WASM_ACT_CODE[activationName] ?? 0;
    const headOutSize = bottleneck; // head1x1 not supported — see file header

    const rechannelW = wasmWriteMatrix(arena, reader, channels, inputSize);

    // Reserve the whole contiguous per-layer record run up front (nam.zig
    // walks layersPtr + i*LY_STRIDE*4), then fill each slot's weight data
    // (which itself bump-allocates elsewhere in the arena) before patching
    // that slot's int fields.
    const layersPtr = arena.allocBytes(dilations.length * LY_STRIDE * 4);
    for (let k = 0; k < dilations.length; k++) {
      const dilation = dilations[k];
      const convOutCh = gated ? 2 * bottleneck : bottleneck;
      const convMatsBase = wasmWriteConv1DWeights(arena, reader, convOutCh, channels, kernelSize);
      const convBias = wasmWriteVector(arena, reader, convOutCh);
      const mixinW = wasmWriteMatrix(arena, reader, convOutCh, conditionSize);
      const layer1x1W = wasmWriteMatrix(arena, reader, channels, bottleneck);
      const layer1x1Bias = wasmWriteVector(arena, reader, channels);
      const histLen = NAM_WASM_MAX_BLOCK + dilation * (kernelSize - 1);
      const histBuf = arena.allocF32(channels * histLen);
      arena.writeF32(histBuf, new Float32Array(channels * histLen));

      const recOff = layersPtr + k * LY_STRIDE * 4;
      arena.writeI32(recOff, 0, dilation);
      arena.writeI32(recOff, 1, kernelSize);
      arena.writeI32(recOff, 2, convOutCh);
      arena.writeI32(recOff, 3, convMatsBase);
      arena.writeI32(recOff, 4, convBias);
      arena.writeI32(recOff, 5, mixinW);
      arena.writeI32(recOff, 6, layer1x1W);
      arena.writeI32(recOff, 7, layer1x1Bias);
      arena.writeI32(recOff, 8, histBuf);
      arena.writeI32(recOff, 9, histLen);
      arena.writeI32(recOff, 10, 0); // histPos
    }

    const headRechannelMatBase = wasmWriteConv1DWeights(arena, reader, headSize, headOutSize, 1); // K=1
    const headRechannelBias = headBias ? wasmWriteVector(arena, reader, headSize) : wasmWriteZeroVector(arena, headSize);

    const blkA = arena.allocF32(NAM_WASM_MAX_BLOCK * channels);
    const blkB = arena.allocF32(NAM_WASM_MAX_BLOCK * channels);
    const headAccum = arena.allocF32(NAM_WASM_MAX_BLOCK * headOutSize);
    const headOut = arena.allocF32(NAM_WASM_MAX_BLOCK * headSize);

    const laOff = headerPtr + 4 + li * LA_STRIDE * 4;
    arena.writeI32(laOff, 0, channels);
    arena.writeI32(laOff, 1, bottleneck);
    arena.writeI32(laOff, 2, conditionSize);
    arena.writeI32(laOff, 3, inputSize);
    arena.writeI32(laOff, 4, headSize);
    arena.writeI32(laOff, 5, gated ? 1 : 0);
    arena.writeI32(laOff, 6, actCode);
    arena.writeI32(laOff, 7, dilations.length);
    arena.writeI32(laOff, 8, headOutSize);
    arena.writeI32(laOff, 9, rechannelW);
    arena.writeI32(laOff, 10, headRechannelMatBase);
    arena.writeI32(laOff, 11, headRechannelBias);
    arena.writeI32(laOff, 12, layersPtr);
    arena.writeI32(laOff, 13, blkA);
    arena.writeI32(laOff, 14, blkB);
    arena.writeI32(laOff, 15, headAccum);
    arena.writeI32(laOff, 16, headOut);
    arena.writeI32(laOff, 17, 0);
  }

  const headScale = reader.remaining() >= 1 ? reader.next() : (config.head_scale ?? 1.0);

  let outputGainDb = 0;
  if (namJson.metadata && typeof namJson.metadata.loudness === "number") {
    outputGainDb = -18 - namJson.metadata.loudness;
  }

  const condPtr = arena.allocF32(NAM_WASM_MAX_BLOCK);
  const outPtr = arena.allocF32(NAM_WASM_MAX_BLOCK);

  return {
    isWasm: true, exports, headerPtr, headScale, outputGainDb, condPtr, outPtr,
    _in1: new Float32Array(1), _out1: new Float32Array(1),
    _wasmF32: null, // V3-E5: cached memory view, see forwardBlockWasm
  };
}

// n <= MAX_BLOCK. Mirrors forwardBlock()'s signature/semantics exactly.
function forwardBlockWasm(model, inBlock, outBlock, n) {
  const exports = model.exports;
  // V3-E5: WASM memory only grows during buildModelWasm's arena allocation
  // (model-construction time, off the render thread) — forward() itself
  // never allocates, so the buffer never detaches during live playback.
  // Cache the view per model instead of `new Float32Array(...)` twice every
  // single quantum; only rebuild it if the buffer ever turns out to have
  // changed underneath us (defensive — not expected to actually trigger).
  let f32 = model._wasmF32;
  if (!f32 || f32.buffer !== exports.memory.buffer) {
    f32 = model._wasmF32 = new Float32Array(exports.memory.buffer);
  }
  f32.set(n === inBlock.length ? inBlock : inBlock.subarray(0, n), model.condPtr / 4);
  exports.forward(model.headerPtr, model.condPtr, model.outPtr, n);
  const headScale = model.headScale;
  const base = model.outPtr / 4;
  for (let i = 0; i < n; i++) outBlock[i] = headScale * f32[base + i];
}

function forwardSampleWasm(model, rawInputSample) {
  model._in1[0] = rawInputSample;
  forwardBlockWasm(model, model._in1, model._out1, 1);
  return model._out1[0];
}

// ---------------------------------------------------------------------------
// Official-core engine (NAM "A2" and friends)
// ---------------------------------------------------------------------------
//
// Everything above implements NAM "A1" — the standard/lite/feather/nano
// WaveNet family — and is ~1.9x faster than the official core on those, so
// it stays the primary path. But A1 is now only part of the format: "A2"
// adds FiLM conditioning at eight insertion points, grouped convolutions,
// grouped head1x1/layer1x1, a nested condition_dsp network and blended
// gating, and ships inside a SlimmableContainer wrapper. normalizeNamConfig
// refuses every one of those (deliberately — we render them wrong), which
// would otherwise just mean "can't load this model".
//
// So models our own engine refuses get handed to a vendored WASM build of
// the OFFICIAL NeuralAmpModelerCore instead, which handles all of them.
// A2 models are ~17x smaller than A1 standard by design, so this core
// being slower per weight doesn't matter there (measured RTF 0.157 for
// A2-max vs ~0.30 for our own engine on A1 standard).
//
// See vendor/nam-official/README.txt for the full rationale, and
// research/nam-engine-review-spec.md §12.
//
// The import is STATIC because dynamic import() is disallowed in
// WorkletGlobalScope ("import() is disallowed on WorkletGlobalScope").
// Measured cost of carrying it: +4.3ms per addModule(), at worklet-creation
// time only, never on the render path.
import createNamOfficialModule from "./vendor/nam-official/nam.js";

let namOfficialModulePromise = null;
// bytes: ArrayBuffer of vendor/nam-official/nam.wasm, posted from the main
// thread (AudioWorkletGlobalScope has no fetch). Instantiated at most once
// per worklet; the promise is cached so repeated loads reuse it.
function ensureNamOfficialModule(bytes) {
  if (!namOfficialModulePromise) {
    namOfficialModulePromise = createNamOfficialModule({
      wasmBinary: bytes,
      // REQUIRED. Without it the glue evaluates
      // `new URL("nam.wasm", import.meta.url)` at init, and `URL` is not a
      // global in AudioWorkletGlobalScope — it throws before anything runs.
      locateFile: (p) => p,
    });
  }
  return namOfficialModulePromise;
}

function buildModelOfficial(namJson, mod) {
  const id = mod._nam_createInstance();
  const json = JSON.stringify(namJson);
  const len = mod.lengthBytesUTF8(json) + 1;
  const ptr = mod._malloc(len);
  mod.stringToUTF8(json, ptr, len);
  // Both of these are module-global in this core, not per-instance.
  mod._nam_setSampleRate(sampleRate);
  mod._nam_setMaxBufferSize(MAX_BLOCK);
  const ok = mod._nam_loadModel(id, ptr);
  mod._free(ptr);
  if (!ok) throw new Error("the official NAM core could not load this model either");

  // Same loudness normalization the JS/WASM paths apply, computed from the
  // same field, so switching engines doesn't change a capture's level.
  let outputGainDb = 0;
  if (namJson.metadata && typeof namJson.metadata.loudness === "number") {
    outputGainDb = -18 - namJson.metadata.loudness;
  }
  return {
    isOfficial: true, mod, id, outputGainDb,
    inPtr: mod._malloc(MAX_BLOCK * 4),
    outPtr: mod._malloc(MAX_BLOCK * 4),
    _in1: new Float32Array(1), _out1: new Float32Array(1),
  };
}

function forwardBlockOfficial(model, inBlock, outBlock, n) {
  const mod = model.mod;
  // Re-read HEAPF32 each call: this core is built with memory growth, which
  // detaches the previous view. Same discipline as forwardBlockWasm's
  // cached-view invalidation check.
  let heap = mod.HEAPF32;
  const inBase = model.inPtr >>> 2;
  for (let i = 0; i < n; i++) heap[inBase + i] = inBlock[i];
  mod._nam_process(model.id, model.inPtr, model.outPtr, n);
  heap = mod.HEAPF32;
  const outBase = model.outPtr >>> 2;
  for (let i = 0; i < n; i++) outBlock[i] = heap[outBase + i];
}

// The official core's instances live in ITS OWN wasm heap, which is built
// with memory growth and never shrinks — unlike our own WASM engine (whose
// arena is reset, not grown, on every buildModelWasm() — see WasmArena) or
// the JS engine (plain objects, GC'd normally), a model built by
// buildModelOfficial() holds a live instance (mod._nam_createInstance())
// plus two malloc'd scratch buffers that nobody frees automatically. Every
// caller that drops a reference to an official-engine model MUST call this
// first, or the old instance's weights (a whole SlimmableContainer's worth
// per switch) simply pile up in the module's linear memory forever. This
// was the root cause of "switching between several A2/NAM2 captures gets
// slower and eventually silent for ~15s": each switch grew the wasm heap a
// little more, until a growth step big enough to require a slow copy of
// the whole (by-then large) ArrayBuffer landed on the render thread.
function disposeModel(model) {
  if (!model || !model.isOfficial) return;
  try {
    model.mod._free(model.inPtr);
    model.mod._free(model.outPtr);
    model.mod._nam_destroyInstance(model.id);
  } catch (e) { /* best-effort cleanup; a throw here must not crash the caller */ }
}

// calib holds up to two official-engine instances at once (the pending
// model going live, and a disposable probe used only to measure loudness) —
// see the "load" handler and _calibrationSlice(). Both must be released
// together whenever a calibration is abandoned or completes.
function disposeCalib(calib) {
  if (!calib) return;
  disposeModel(calib.pending);
  disposeModel(calib.probe);
}

// Dispatch helpers used by NAMProcessor so its call sites don't need to
// branch on which engine built a model.
//
// Ladder: our WASM/SIMD engine (fastest) -> our JS engine (same math, no
// wasm available) -> the official core (models ours refuses). The first two
// share normalizeNamConfig, so they accept and refuse exactly the same
// files; a model reaching the third rung is one we deliberately declined,
// not one that failed by accident.
function buildModelAny(namJson, wasmExports, officialMod) {
  let firstErr = null;
  if (wasmExports) {
    try { return buildModelWasm(namJson, wasmExports); } catch (e) { firstErr = e; }
  }
  try { return buildModel(namJson); } catch (e) { firstErr = firstErr || e; }
  if (officialMod) return buildModelOfficial(namJson, officialMod);
  throw firstErr || new Error("no engine could load this model");
}
function forwardBlockAny(model, inBlock, outBlock, n) {
  if (model.isOfficial) forwardBlockOfficial(model, inBlock, outBlock, n);
  else if (model.isWasm) forwardBlockWasm(model, inBlock, outBlock, n);
  else forwardBlock(model, inBlock, outBlock, n);
}

// Single-sample convenience (calibration path) — mirrors forwardSample/
// forwardSampleWasm for whichever engine built this model.
function forwardSampleAny(model, rawInputSample) {
  model._in1[0] = rawInputSample;
  forwardBlockAny(model, model._in1, model._out1, 1);
  return model._out1[0];
}

// ---------------------------------------------------------------------------
// Worklet processor: input/output trim (dB), model-loudness auto-normalize,
// DC blocker — matching the reference wrapper's simple wrapper DSP
// (t3k-wasm-module.cpp) around the core inference.
// ---------------------------------------------------------------------------

// V3-E3: the offline realtime-budget probe (paProbeNamModel in playalong.js)
// is an estimate — it runs on a different thread (OfflineAudioContext,
// normal priority) than the one that actually renders live audio (the
// real-time AudioContext thread, typically a higher-priority/performance
// core), so it can still be wrong for a given machine. This is the safety
// net behind that estimate: time the first LIVE_CHECK_WINDOW_MS of actual
// process() calls after a model goes live and, if this specific machine's
// real render thread isn't keeping up, roll back to whatever was active
// before it — automatically, before enough consecutive overruns pile up to
// take down the whole audio stream (the original "picking a NAM kills all
// audio" failure mode).
const LIVE_CHECK_WINDOW_MS = 100;
const LIVE_CHECK_REFUSE_RT_FACTOR = 0.95; // wall-time/audio-time over this window means it's not keeping up

class NAMProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // V3-T1: widened upper bound — this is "Drive" in the Tweaker UI now
      // (how hard you push the captured amp, like a boost pedal in front),
      // and the whole point is pushing harder than a plain input-trim
      // range needed to. Lower bound unchanged (taming a hot capture never
      // needed more headroom than this).
      { name: "inputGainDb", defaultValue: 0, minValue: -24, maxValue: 48 },
      { name: "outputGainDb", defaultValue: 0, minValue: -24, maxValue: 24 },
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.model = null;
    this.modelOutputGainDb = 0;
    this.calib = null; // in-flight incremental calibration state, see process()
    this.framesProcessed = 0; // diagnostics: proves process() is being pulled
    this.dcPrevIn = 0;
    this.dcPrevOut = 0;
    this.dcCoeff = 0.995;
    this._inBlock = new Float32Array(MAX_BLOCK); // gain-applied input for forwardBlock
    this._outBlock = new Float32Array(MAX_BLOCK);
    this.wasmExports = null; // set once nam.wasm is instantiated, see "wasm-bytes" below
    this.wasmInstantiating = null; // Promise while instantiation is in flight
    this.officialMod = null; // official NeuralAmpModelerCore (A2 etc) — see "official-wasm-bytes"
    this.officialInstantiating = null;
    this.port.onmessage = (e) => this._onMessage(e.data);
    // V3-E3 live-overrun rollback (see LIVE_CHECK_WINDOW_MS above).
    this.rollbackModel = null;
    this.rollbackOutputGainDb = 0;
    this.liveCheckActive = false;
    this.liveCheckWallMs = 0;
    this.liveCheckAudioMs = 0;
    this._hasPerfNow = typeof performance !== "undefined" && typeof performance.now === "function";
  }

  // Called at every point a new model actually goes live (immediately for a
  // pre-calibrated/metadata-known load, or once deferred calibration lands).
  // prevModel/prevGainDb are whatever was active right before this swap —
  // captured by the caller before this.model was reassigned — so a bad
  // overrun reading can restore exactly that state.
  _startLiveCheck(prevModel, prevGainDb) {
    // Whatever was sitting in rollbackModel from the PREVIOUS swap is being
    // replaced now. Its own check window is over by construction (this swap
    // already completed, which only happens after that one settled) unless a
    // check is still actively in flight for it — in that rare race, leave it
    // alone rather than free something process() might still read.
    if (this.rollbackModel && this.rollbackModel !== prevModel && !this.liveCheckActive) {
      disposeModel(this.rollbackModel);
    }
    this.rollbackModel = prevModel;
    this.rollbackOutputGainDb = prevGainDb;
    this.liveCheckActive = this._hasPerfNow;
    this.liveCheckWallMs = 0;
    this.liveCheckAudioMs = 0;
  }

  // playalong.js fetches nam.wasm on the main thread (AudioWorkletGlobalScope
  // has no fetch) and posts the raw BYTES here; we compile + instantiate them
  // ourselves. Compiling a ~31KB standalone module with no imports is
  // sub-millisecond and happens at load time, never on the render path.
  //
  // This used to receive a pre-compiled `WebAssembly.Module` instead. That
  // never worked: a Module posted to an AudioWorklet is SILENTLY DROPPED by
  // Chrome — no throw at the sender, no `messageerror`, this handler simply
  // never ran — so `wasmExports` stayed null forever and every model
  // silently fell back to the JS engine. See playalong.js's
  // paGetNamWasmBytes() for the full write-up. Keep this on bytes.
  //
  // NOTE the shape difference that made the old bug easy to miss:
  // `WebAssembly.instantiate(Module)` resolves to an Instance, but
  // `WebAssembly.instantiate(BufferSource)` resolves to `{module, instance}`.
  // Read `.instance.exports`, not `.exports`.
  //
  // "load" awaits this promise first (see below) so a "wasm-bytes" message
  // sent immediately before a "load" message for the same model still lands
  // before that load decides which engine to use.
  _onWasmBytes(bytes) {
    this.wasmInstantiating = WebAssembly.instantiate(bytes, {})
      .then((result) => { this.wasmExports = result.instance.exports; })
      .catch((err) => {
        this.wasmExports = null;
        this.port.postMessage({ type: "wasm-instantiate-failed", error: String(err && err.message || err) });
      });
  }

  // Bytes of vendor/nam-official/nam.wasm, for the A2/official-core path.
  // Sent separately from (and usually alongside) our own engine's bytes,
  // because most models never need it — see buildModelAny's ladder.
  _onOfficialWasmBytes(bytes) {
    this.officialInstantiating = ensureNamOfficialModule(bytes)
      .then((mod) => { this.officialMod = mod; })
      .catch((err) => {
        this.officialMod = null;
        this.port.postMessage({ type: "official-instantiate-failed", error: String(err && err.message || err) });
      });
  }

  async _onMessage(msg) {
    if (msg.type === "wasm-bytes") {
      this._onWasmBytes(msg.bytes);
      return;
    }
    if (msg.type === "official-wasm-bytes") {
      this._onOfficialWasmBytes(msg.bytes);
      return;
    }
    if (msg.type === "load") {
      if (this.wasmInstantiating) { try { await this.wasmInstantiating; } catch (e) { /* already logged */ } }
      if (this.officialInstantiating) { try { await this.officialInstantiating; } catch (e) { /* already logged */ } }
      // V3-E3: whatever is active right now is what a bad live-overrun
      // reading rolls back to — capture it before any reassignment below.
      const prevModel = this.model;
      const prevGainDb = this.modelOutputGainDb;
      try {
        const model = buildModelAny(msg.nam, this.wasmExports, this.officialMod);
        const cutoffHz = 10.0;
        const omega = (2 * Math.PI * cutoffHz) / sampleRate;
        this.dcCoeff = 1.0 - omega;
        // A previous "load" may still have a calibration in flight (its own
        // pending model + disposable probe) — this one is superseding it,
        // so free both before dropping the reference.
        disposeCalib(this.calib);
        this.calib = null;
        if (Number.isFinite(msg.outputGainDb)) {
          // Pre-calibrated by the caller (playalong.js measures the model
          // in a throwaway OfflineAudioContext first — see
          // paCalibrateNamOffline) — nothing to measure on the real-time
          // thread, activate immediately.
          model.outputGainDb = msg.outputGainDb;
          this.model = model;
          this.modelOutputGainDb = msg.outputGainDb;
          this._startLiveCheck(prevModel, prevGainDb);
        } else if (msg.nam.metadata && typeof msg.nam.metadata.loudness === "number") {
          // Known loudness — activate immediately, nothing to measure.
          this.model = model;
          this.modelOutputGainDb = model.outputGainDb;
          this._startLiveCheck(prevModel, prevGainDb);
        } else {
          // No loudness metadata — measure output level incrementally in
          // process() before going live. The probe is a second disposable
          // build so the real model's causal-conv history stays clean
          // (zeroed) for actual playback, not polluted by the test tone.
          // The current model (if any) is dropped now: the dry signal
          // passes through for the ~30ms the calibration takes.
          this.model = null;
          let probe;
          try {
            probe = buildModelAny(msg.nam, this.wasmExports, this.officialMod);
          } catch (probeErr) {
            // `model` (the pending one) already built successfully and has
            // nowhere else to go now — free it before propagating.
            disposeModel(model);
            throw probeErr;
          }
          this.calib = {
            pending: model,
            probe,
            i: 0, sumSq: 0, measured: 0,
            prevModel, prevGainDb, // V3-E3: for _startLiveCheck once calibration lands
          };
          // sync: offline-render callers (the Suggest feature) ask for
          // blocking calibration — an OfflineAudioContext's render thread
          // has no real-time budget to blow, and deferring would leave the
          // first CALIBRATION_SAMPLES of their short (0.15s) test render
          // as dry passthrough, contaminating the measurement.
          if (msg.sync) {
            while (this.calib) this._calibrationSlice();
          }
        }
        // Ack now, not when calibration lands: in non-neural amp modes the
        // node is disconnected and process() is never pulled, so an ack
        // deferred to calibration completion would leave the loader's
        // promise hanging forever. The parse succeeding is what "loaded"
        // means; the amp goes live a few quanta later. outputGainDb is the
        // calibrated gain when known at ack time (sync/pre-calibrated/
        // metadata loads) — paCalibrateNamOffline reads it back — and null
        // for a still-pending deferred calibration.
        this.port.postMessage({
          type: "loaded", ok: true,
          outputGainDb: this.model ? this.modelOutputGainDb : null,
        });
      } catch (err) {
        // By the time any throw above can reach here, this.model is either
        // still prevModel untouched (buildModelAny for the pending model
        // failed) or already null (the probe-build path above disposes its
        // own orphans and rethrows) — either way prevModel is the one still
        // needing disposal, never a double-free of the same object.
        disposeModel(prevModel);
        this.model = null;
        this.calib = null;
        this.port.postMessage({ type: "loaded", ok: false, error: String(err && err.message || err) });
      }
    } else if (msg.type === "unload") {
      disposeModel(this.model);
      disposeCalib(this.calib);
      disposeModel(this.rollbackModel);
      this.model = null;
      this.calib = null;
      this.rollbackModel = null;
      this.liveCheckActive = false;
    } else if (msg.type === "ping") {
      // Diagnostics: port messages are serviced on the render thread, so a
      // pong proves that thread is alive; its payload says whether a model
      // is actually active and with what gain. If the render thread is
      // wedged or the stream is dead, this never answers — which is itself
      // the diagnostic (see gsDiag in playalong.js).
      this.port.postMessage({
        type: "pong",
        modelActive: !!this.model,
        calibInFlight: !!this.calib,
        modelOutputGainDb: this.modelOutputGainDb,
        framesProcessed: this.framesProcessed || 0,
      });
    }
  }

  // One slice of the deferred output-level calibration per render quantum —
  // bounded work on the render thread instead of one giant blocking pass in
  // the message handler (see the CALIBRATION_* comment block above).
  _calibrationSlice() {
    const c = this.calib;
    const omega = (2 * Math.PI * CALIBRATION_TEST_FREQ) / sampleRate;
    try {
      const n = Math.min(CALIBRATION_SAMPLES_PER_QUANTUM, CALIBRATION_SAMPLES - c.i);
      const inBlock = this._inBlock;
      const outBlock = this._outBlock;
      for (let i = 0; i < n; i++) inBlock[i] = CALIBRATION_TEST_AMPLITUDE * Math.sin(omega * (c.i + i));
      forwardBlockAny(c.probe, inBlock, outBlock, n);
      for (let i = 0; i < n; i++) {
        if (c.i + i >= CALIBRATION_WARMUP_SAMPLES) { c.sumSq += outBlock[i] * outBlock[i]; c.measured++; }
      }
      c.i += n;
      if (c.i >= CALIBRATION_SAMPLES) {
        const rms = Math.sqrt(c.sumSq / Math.max(1, c.measured));
        // Silent capture (rms ~ 0) or NaN-producing inference: nothing
        // sensible to compute, leave 0 dB. Without the isFinite check a
        // NaN rms sails through the <= comparison (false) into log10 →
        // NaN gain → every output sample NaN → the isFinite output guard
        // turns it all into pure silence with no error anywhere.
        const gainDb = 20 * Math.log10(CALIBRATION_TARGET_RMS / rms);
        c.pending.outputGainDb = (rms <= 1e-6 || !Number.isFinite(gainDb)) ? 0
          : Math.max(-24, Math.min(24, gainDb));
        this.model = c.pending;
        this.modelOutputGainDb = c.pending.outputGainDb;
        this._startLiveCheck(c.prevModel, c.prevGainDb);
        // c.pending is now live as this.model (kept); c.probe was only ever
        // needed to measure loudness and has no other owner — free it now.
        disposeModel(c.probe);
        this.calib = null;
      }
    } catch (err) {
      // Calibration itself is being abandoned here — both halves of it are
      // orphaned (this.model is untouched, still whatever was active before
      // this "load", tracked separately and unaffected by this failure).
      disposeCalib(c);
      this.calib = null;
      this.port.postMessage({ type: "runtime-error", error: String(err && err.message || err) });
    }
  }

  process(inputs, outputs, parameters) {
    this.framesProcessed++;
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outCh = output[0];
    const inCh = input && input[0] ? input[0] : null;

    if (this.calib) this._calibrationSlice();

    const bypass = parameters.bypass[0] >= 0.5;
    if (!this.model || bypass) {
      if (inCh) outCh.set(inCh);
      else outCh.fill(0);
      return true;
    }

    const paramInGain = parameters.inputGainDb;
    const paramOutGain = parameters.outputGainDb;
    const frames = outCh.length;
    // process() has no caller-side try/catch (it can't — the browser calls
    // it directly on the real-time render thread), so an uncaught throw
    // here is undefined behavior for however many other nodes share this
    // audio context, not just this one. 261 real-world .nam captures each
    // have their own weights, and only a handful were exercised in testing
    // — fail safe (silence + disable this model, not a live crash on
    // someone's actual playing) rather than assume every possible real
    // file is covered.
    // Gain params are k-rate in practice (length 1) — hoist the dB→linear
    // conversion out of the loop instead of two Math.pow calls per sample.
    const inGainIsKRate = paramInGain.length === 1;
    const outGainIsKRate = paramOutGain.length === 1;
    const inLinK = inGainIsKRate ? Math.pow(10, paramInGain[0] / 20) : 0;
    const outLinK = outGainIsKRate ? Math.pow(10, (paramOutGain[0] + this.modelOutputGainDb) / 20) : 0;
    // V3-E3: wall-clock time this call actually takes, only while a live
    // check is running (see _startLiveCheck) — near-zero cost otherwise.
    const checkingLive = this.liveCheckActive;
    const t0 = checkingLive ? performance.now() : 0;
    try {
      // Render-quantum frames is 128 (== MAX_BLOCK) today; chunk defensively
      // in case a future spec revision hands us more.
      for (let off = 0; off < frames; off += MAX_BLOCK) {
        const n = Math.min(MAX_BLOCK, frames - off);
        const inBlock = this._inBlock;
        const outBlock = this._outBlock;
        for (let i = 0; i < n; i++) {
          const inLin = inGainIsKRate ? inLinK : Math.pow(10, paramInGain[off + i] / 20);
          inBlock[i] = (inCh ? inCh[off + i] : 0) * inLin;
        }
        forwardBlockAny(this.model, inBlock, outBlock, n);
        for (let i = 0; i < n; i++) {
          const outLin = outGainIsKRate ? outLinK : Math.pow(10, (paramOutGain[off + i] + this.modelOutputGainDb) / 20);
          let sample = outBlock[i] * outLin;

          // One-pole DC blocker (matches the reference wrapper's 10Hz high-pass)
          const dcIn = sample;
          sample = sample - this.dcPrevIn + this.dcCoeff * this.dcPrevOut;
          this.dcPrevIn = dcIn;
          this.dcPrevOut = sample;
          // Recursive filter state can decay into denormal range during quiet
          // passages/silence between notes — on some engines/CPUs that's a
          // 100x+ per-op slowdown, which on a shared single-threaded audio
          // render callback can starve every other node in the context, not
          // just this one. Flush-to-zero well below audibility.
          if (Math.abs(this.dcPrevOut) < 1e-15) this.dcPrevOut = 0;

          outCh[off + i] = Number.isFinite(sample) ? sample : 0;
        }
      }
    } catch (err) {
      // this.model here is never the same object as this.rollbackModel (that
      // slot only ever holds a PREVIOUS model, replaced by _startLiveCheck
      // before this one went active), so freeing it can't double-free
      // something a live-overrun rollback still needs.
      disposeModel(this.model);
      this.model = null;
      this.dcPrevIn = 0;
      this.dcPrevOut = 0;
      if (inCh) outCh.set(inCh); else outCh.fill(0);
      this.liveCheckActive = false;
      this.port.postMessage({ type: "runtime-error", error: String(err && err.message || err) });
    }

    if (checkingLive) {
      this.liveCheckWallMs += performance.now() - t0;
      this.liveCheckAudioMs += (frames / sampleRate) * 1000;
      if (this.liveCheckAudioMs >= LIVE_CHECK_WINDOW_MS) {
        const rtFactor = this.liveCheckWallMs / this.liveCheckAudioMs;
        this.liveCheckActive = false;
        if (rtFactor >= LIVE_CHECK_REFUSE_RT_FACTOR) {
          // This machine's live render thread isn't keeping up with the
          // model that just went active, for real — not the offline probe's
          // estimate. Roll back to whatever was active before it rather than
          // let consecutive overruns take the whole stream down. The model
          // being rolled back OUT OF is being dropped for good — free it.
          disposeModel(this.model);
          this.model = this.rollbackModel;
          this.modelOutputGainDb = this.rollbackOutputGainDb;
          this.rollbackModel = null;
          this.port.postMessage({ type: "live-overrun-rollback", rtFactor });
        }
      }
    }
    return true;
  }
}

registerProcessor("nam-processor", NAMProcessor);
