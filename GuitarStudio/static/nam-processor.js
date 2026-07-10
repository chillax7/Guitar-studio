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

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function makeActivation(name) {
  switch ((name || "").toLowerCase()) {
    case "tanh":
    case "fasttanh":
      return Math.tanh;
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
      return Math.tanh; // the overwhelming majority of public captures use Tanh
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

class RingHistory {
  constructor(channels, length) {
    this.channels = channels;
    this.length = length;
    this.buf = new Float32Array(channels * length);
    this.pos = 0;
  }

  push(vec) {
    const base = this.pos * this.channels;
    for (let c = 0; c < this.channels; c++) this.buf[base + c] = vec[c];
    this.pos = (this.pos + 1) % this.length;
  }

  // Writes the channel vector from `stepsBack` samples ago into `out`.
  at(stepsBack, out) {
    const idx = (((this.pos - 1 - stepsBack) % this.length) + this.length) % this.length;
    const base = idx * this.channels;
    for (let c = 0; c < this.channels; c++) out[c] = this.buf[base + c];
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
    history: new RingHistory(channels, dilation * (kernelSize - 1) + 1),
    // Preallocated per-sample scratch (reused every call — no per-sample GC pressure)
    _tap: new Float32Array(channels),
    _z: new Float32Array(convOutCh),
    _mixinOut: new Float32Array(convOutCh),
    _activated: new Float32Array(bottleneck),
    _layer1x1Out: new Float32Array(channels),
    _nextInput: new Float32Array(channels),
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

  return {
    channels, bottleneck, conditionSize, inputSize, headSize, gated, activationFn, headOutSize,
    rechannelW, layers, headRechannelMats, headRechannelBias,
    _rechanneled: new Float32Array(channels),
    _headAccum: new Float32Array(headOutSize),
    _headOut: new Float32Array(headSize),
  };
}

function buildModel(namJson) {
  if (namJson.architecture !== "WaveNet") {
    throw new Error(`Unsupported architecture '${namJson.architecture}' — only WaveNet .nam files are supported`);
  }
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

  return { layerArrays, headScale, outputGainDb, conditionVec: new Float32Array(1) };
}

function matVecInto(mat, outCh, inCh, vecIn, vecOut, bias) {
  for (let i = 0; i < outCh; i++) {
    let acc = bias ? bias[i] : 0;
    const base = i * inCh;
    for (let j = 0; j < inCh; j++) acc += mat[base + j] * vecIn[j];
    vecOut[i] = acc;
  }
}

function processLayerArraySample(la, inputVec, conditionVec, headCarry) {
  matVecInto(la.rechannelW, la.channels, la.inputSize, inputVec, la._rechanneled, null);

  if (headCarry) la._headAccum.set(headCarry);
  else la._headAccum.fill(0);

  let layerInput = la._rechanneled;

  for (const layer of la.layers) {
    layer.history.push(layerInput);
    const convOutCh = layer.convBias.length;
    const K = layer.kernelSize;
    layer._z.fill(0);
    for (let k = 0; k < K; k++) {
      const stepsBack = layer.dilation * (K - 1 - k);
      layer.history.at(stepsBack, layer._tap);
      const mat = layer.convMats[k];
      for (let i = 0; i < convOutCh; i++) {
        let acc = 0;
        const base = i * la.channels;
        for (let j = 0; j < la.channels; j++) acc += mat[base + j] * layer._tap[j];
        layer._z[i] += acc;
      }
    }
    for (let i = 0; i < convOutCh; i++) layer._z[i] += layer.convBias[i];

    matVecInto(layer.mixinW, convOutCh, la.conditionSize, conditionVec, layer._mixinOut, null);
    for (let i = 0; i < convOutCh; i++) layer._z[i] += layer._mixinOut[i];

    const bottleneck = la.bottleneck;
    if (la.gated) {
      for (let i = 0; i < bottleneck; i++) {
        layer._activated[i] = la.activationFn(layer._z[i]) * sigmoid(layer._z[bottleneck + i]);
      }
    } else {
      for (let i = 0; i < bottleneck; i++) layer._activated[i] = la.activationFn(layer._z[i]);
    }

    for (let i = 0; i < la.headOutSize; i++) la._headAccum[i] += layer._activated[i];

    matVecInto(layer.layer1x1W, la.channels, bottleneck, layer._activated, layer._layer1x1Out, layer.layer1x1Bias);
    for (let i = 0; i < la.channels; i++) layer._nextInput[i] = layerInput[i] + layer._layer1x1Out[i];

    // Swap buffers (avoid aliasing layerInput with the layer we just wrote)
    const tmp = layer._nextInput;
    layer._nextInput = layerInput === la._rechanneled ? new Float32Array(la.channels) : layerInput;
    layerInput = tmp;
  }

  matVecInto(la.headRechannelMats[0], la.headSize, la.headOutSize, la._headAccum, la._headOut, la.headRechannelBias);
  return { layerOutput: layerInput, headOutput: la._headOut };
}

function forwardSample(model, rawInputSample) {
  model.conditionVec[0] = rawInputSample;
  let layerInputs = model.conditionVec; // inputSize=1 for the first layer array
  let headCarry = null;
  let headOut = null;
  for (const la of model.layerArrays) {
    const result = processLayerArraySample(la, layerInputs, model.conditionVec, headCarry);
    layerInputs = result.layerOutput;
    headCarry = result.headOutput;
    headOut = result.headOutput;
  }
  return model.headScale * headOut[0];
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
// Worklet processor: input/output trim (dB), model-loudness auto-normalize,
// DC blocker — matching the reference wrapper's simple wrapper DSP
// (t3k-wasm-module.cpp) around the core inference.
// ---------------------------------------------------------------------------

class NAMProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "inputGainDb", defaultValue: 0, minValue: -24, maxValue: 24 },
      { name: "outputGainDb", defaultValue: 0, minValue: -24, maxValue: 24 },
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.model = null;
    this.modelOutputGainDb = 0;
    this.calib = null; // in-flight incremental calibration state, see process()
    this.dcPrevIn = 0;
    this.dcPrevOut = 0;
    this.dcCoeff = 0.995;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === "load") {
      try {
        const model = buildModel(msg.nam);
        const cutoffHz = 10.0;
        const omega = (2 * Math.PI * cutoffHz) / sampleRate;
        this.dcCoeff = 1.0 - omega;
        this.calib = null;
        if (typeof msg.outputGainDb === "number") {
          // Pre-calibrated by the caller (playalong.js measures the model
          // in a throwaway OfflineAudioContext first — see
          // paCalibrateNamOffline) — nothing to measure on the real-time
          // thread, activate immediately.
          model.outputGainDb = msg.outputGainDb;
          this.model = model;
          this.modelOutputGainDb = msg.outputGainDb;
        } else if (msg.nam.metadata && typeof msg.nam.metadata.loudness === "number") {
          // Known loudness — activate immediately, nothing to measure.
          this.model = model;
          this.modelOutputGainDb = model.outputGainDb;
        } else {
          // No loudness metadata — measure output level incrementally in
          // process() before going live. The probe is a second disposable
          // build so the real model's causal-conv history stays clean
          // (zeroed) for actual playback, not polluted by the test tone.
          // The current model (if any) is dropped now: the dry signal
          // passes through for the ~30ms the calibration takes.
          this.model = null;
          this.calib = {
            pending: model,
            probe: buildModel(msg.nam),
            i: 0, sumSq: 0, measured: 0,
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
        this.model = null;
        this.calib = null;
        this.port.postMessage({ type: "loaded", ok: false, error: String(err && err.message || err) });
      }
    } else if (msg.type === "unload") {
      this.model = null;
      this.calib = null;
    }
  }

  // One slice of the deferred output-level calibration per render quantum —
  // bounded work on the render thread instead of one giant blocking pass in
  // the message handler (see the CALIBRATION_* comment block above).
  _calibrationSlice() {
    const c = this.calib;
    const omega = (2 * Math.PI * CALIBRATION_TEST_FREQ) / sampleRate;
    try {
      const stop = Math.min(c.i + CALIBRATION_SAMPLES_PER_QUANTUM, CALIBRATION_SAMPLES);
      for (; c.i < stop; c.i++) {
        const x = CALIBRATION_TEST_AMPLITUDE * Math.sin(omega * c.i);
        const y = forwardSample(c.probe, x);
        if (c.i >= CALIBRATION_WARMUP_SAMPLES) { c.sumSq += y * y; c.measured++; }
      }
      if (c.i >= CALIBRATION_SAMPLES) {
        const rms = Math.sqrt(c.sumSq / Math.max(1, c.measured));
        // Silent capture (rms ~ 0): nothing sensible to compute, leave 0 dB.
        c.pending.outputGainDb = rms <= 1e-6 ? 0
          : Math.max(-24, Math.min(24, 20 * Math.log10(CALIBRATION_TARGET_RMS / rms)));
        this.model = c.pending;
        this.modelOutputGainDb = c.pending.outputGainDb;
        this.calib = null;
      }
    } catch (err) {
      this.calib = null;
      this.port.postMessage({ type: "runtime-error", error: String(err && err.message || err) });
    }
  }

  process(inputs, outputs, parameters) {
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
    try {
      for (let i = 0; i < frames; i++) {
        const inGainDb = paramInGain.length > 1 ? paramInGain[i] : paramInGain[0];
        const outGainDb = (paramOutGain.length > 1 ? paramOutGain[i] : paramOutGain[0]) + this.modelOutputGainDb;
        const dry = inCh ? inCh[i] : 0;
        const withInGain = dry * Math.pow(10, inGainDb / 20);
        let sample = forwardSample(this.model, withInGain);
        sample *= Math.pow(10, outGainDb / 20);

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

        outCh[i] = Number.isFinite(sample) ? sample : 0;
      }
    } catch (err) {
      this.model = null;
      this.dcPrevIn = 0;
      this.dcPrevOut = 0;
      if (inCh) outCh.set(inCh); else outCh.fill(0);
      this.port.postMessage({ type: "runtime-error", error: String(err && err.message || err) });
    }
    return true;
  }
}

registerProcessor("nam-processor", NAMProcessor);
