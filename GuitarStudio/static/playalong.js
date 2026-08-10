"use strict";

// Play Along rig: live guitar input -> gate -> amp (clean/analog/neural) ->
// cab IR -> EQ -> compressor -> delay/reverb -> output, joining the SAME
// AudioContext/graph the backing-track mixer already uses (Audio.ctx/
// Audio.master from app.js) rather than a second audio session — the one
// architectural constraint engine-spec.md and ui-spec.md both call out for
// this feature, and the exact reason the vendored NAM WASM library couldn't
// be used as-is (see nam-processor.js's file header).
//
// Graph shape deliberately matches video-recording-spec.md's documented
// design (§3.1) so the recording feature (M4) can tap it later:
//   guitar in -> ...rig... -> outGain -> outAnal -> ctx.destination
// as a path parallel to the backing track's stems -> master -> analyser ->
// destination, not merged into it.

const PA = {
  built: false,
  // Tone-suggestion budget, loaded from /api/settings at startup. Null until
  // then, so paSuggestSampleSize() falls back to the default rather than
  // treating "not loaded yet" as zero.
  suggestSampleSize: null,
  stream: null,
  source: null,
  inAnal: null,
  inputClipped: false, // GP-10 latching clip state
  gateNode: null,
  cleanGain: null,
  analogNodes: null,
  namNode: null,
  namLoaded: null,
  namLoadedPrev: null, // V3-E3: what a live-overrun rollback reverts the picker to
  ampOut: null,
  ampMode: "clean",
  convolver: null,
  irDryGain: null,
  irWetGain: null,
  eqNodes: null,
  compressor: null,
  compBypassDry: null,
  compBypassWet: null,
  delayNode: null,
  delayFeedback: null,
  delayWet: null,
  reverbConvolver: null,
  reverbWet: null,
  outputGain: null,
  outputMute: null,
  outAnal: null,
  irLoaded: null, // GP-02: filename of the active Cab IR, if any
  meterRaf: null,
  namModels: [],
  irModels: [],
  tunerEnabled: false, // GP-01 — off by default; autocorrelation is O(n^2)
                       // and there's no reason to spend it when not tuning
  midiAccess: null, // GP-11: Web MIDI access object, once granted
  midiInput: null, // the currently selected MIDIInput, if any
  midiLearnTarget: null, // a PA_MIDI_ACTIONS id, or null — set while a footswitch Learn… button is armed
  midiExprLearnTarget: null, // CH-4: a PA_MIDI_EXPRESSION_TARGETS id, or null — armed separately from the above, since an expression pedal is learned by sweeping rather than pressing
  mwahPosition: 0, // CH-4: treadle position 0 (heel) to 1 (toe); driven by the on-screen slider or a bound expression pedal
  loopSum: null, // GP-06 (looper-pedal-spec.md §2): sits between outputMute and outAnal so a Take/Riff Capture recorded while the loop plays actually contains it
  looperNode: null,
  looperState: "idle", // "idle" | "recording" | "playing" | "overdubbing" | "stopped" — mirrors the worklet's own state, kept here so the UI can render without a round trip
  looperLengthFrames: 0,
  looperBars: null, // null = free-running; a whole number = beat-grid-locked to that many bars
  looperBpm: null, // the BPM the lock was computed against, for the length-hint display
};

// ---------------------------------------------------------------------------
// NAM WASM/SIMD module — fetched once here on the main thread as raw BYTES
// and handed to every "nam-processor" AudioWorkletNode we create (the live
// node in ensurePAGraph, plus every throwaway probe node in
// paProbeNamModel and the Suggest loop below). AudioWorkletGlobalScope has
// no fetch, so this is the one place that ever touches the network for it;
// each worklet compiles + instantiates its own Instance (its own private
// linear memory) from these bytes.
//
// *** Why bytes and not a compiled WebAssembly.Module ***
// This used to send a pre-compiled `WebAssembly.Module`, on the reasoning
// that a Module is structured-clone-transferable so each worklet could skip
// re-compiling. It is transferable to a *Worker* — but posting one to an
// **AudioWorklet** does not work in Chrome: the message is **silently
// dropped**. No exception at the postMessage call, no `messageerror` event
// on either port, no console warning — the worklet's onmessage handler
// simply never fires for it (verified directly: a port that received a
// Module-carrying message never logged it, while a plain-ArrayBuffer
// message posted to the same port immediately after arrived fine).
//
// The consequence was severe and completely silent: `wasmExports` in
// nam-processor.js stayed null forever, so `buildModelAny()` took its
// "no wasm — fall back" branch on *every* load. The WASM/SIMD engine
// therefore never actually ran in the browser at all; everything, live and
// probed, was rendered by the ~6x slower JS engine. That in turn made the
// offline speed probe measure JS-engine cost, which is what pushed
// ordinary standard-architecture captures past NAM_REFUSE_RT_FACTOR and
// got them refused as "too heavy" — see research/nam-engine-review-spec.md
// §10 for the measurements.
//
// ArrayBuffers clone to an AudioWorklet without complaint, so the bytes go
// over instead and the worklet compiles them itself. Compiling this ~31KB
// standalone module is sub-millisecond and happens at load time, never on
// the render path, so the "save a re-compile" motivation the Module
// approach was reaching for was never worth anything anyway.
//
// Strictly best-effort: any failure here (fetch fails, browser lacks wasm
// SIMD, compile throws) just leaves paNamWasmBytesPromise resolved to
// null, and every call site below skips sending the message —
// nam-processor.js's own fallback (buildModelAny/forwardBlockAny) then
// silently stays on the JS engine, exactly like it does for a model whose
// architecture the WASM path can't handle. Never a hard failure.
let paNamWasmBytesPromise = null;
function paGetNamWasmBytes() {
  if (!paNamWasmBytesPromise) {
    paNamWasmBytesPromise = (async () => {
      try {
        return await (await fetch("nam.wasm")).arrayBuffer();
      } catch (e) {
        console.warn("NAM WASM engine unavailable, falling back to JS engine:", e);
        return null;
      }
    })();
  }
  return paNamWasmBytesPromise;
}
// Sends the wasm bytes (if available) to a freshly-created nam-processor
// node's port, BEFORE any "load" message for the same node — nam-processor.js
// awaits its own in-flight instantiation before deciding which engine a
// pending "load" uses, so message order (not a round-trip ack) is what makes
// this race-free.
//
// slice(0) because structured clone would otherwise be handed the same
// cached ArrayBuffer every time; copying keeps the cached original intact
// for the next node (and leaves the door open to transferring instead, if
// this ever needs to be cheaper — 31KB per node does not).
async function paSendNamWasmModule(node) {
  const [ours, official] = await Promise.all([paGetNamWasmBytes(), paGetNamOfficialWasmBytes()]);
  if (ours) node.port.postMessage({ type: "wasm-bytes", bytes: ours.slice(0) });
  if (official) node.port.postMessage({ type: "official-wasm-bytes", bytes: official.slice(0) });
}

// The OFFICIAL NeuralAmpModelerCore (vendor/nam-official/), used only for
// models our own engine deliberately refuses — NAM "A2", slimmable
// containers, condition_dsp, LSTM. See vendor/nam-official/README.txt for
// why both engines exist: ours is ~1.9x faster on the A1 WaveNet family and
// stays primary; this one covers everything else, which we'd otherwise be
// unable to load at all.
//
// Same best-effort contract as paGetNamWasmBytes above: a failure here just
// means A2-class captures can't load, not that anything breaks.
let paNamOfficialWasmBytesPromise = null;
function paGetNamOfficialWasmBytes() {
  if (!paNamOfficialWasmBytesPromise) {
    paNamOfficialWasmBytesPromise = (async () => {
      try {
        return await (await fetch("vendor/nam-official/nam.wasm")).arrayBuffer();
      } catch (e) {
        console.warn("Official NAM core unavailable (A2-class captures won't load):", e);
        return null;
      }
    })();
  }
  return paNamOfficialWasmBytesPromise;
}

// ---------------------------------------------------------------------------
// Synthetic curves/impulses (no bundled assets needed for the basics)
// ---------------------------------------------------------------------------

function paMakeDistortionCurve(amount) {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = Math.max(amount, 0.001) * 50;
  const norm = Math.tanh(k) || 1;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

// Analog amp clip curve — replaces the shared symmetric-tanh curve above
// for the AMP stage only (Boost keeps paMakeDistortionCurve; a boost
// pedal SHOULD be a plain symmetric soft clip). Tuned against a real
// Marshall-sim recording (see marshall-sample analysis, v4.8): its
// distortion measured H2≈H3≈-20dB with a gradual upper tail — moderate
// mixed even/odd content, nothing like the old amount*50 mapping, which
// at the default 30% drive was tanh(15x): effectively a hard clipper
// that fully saturated any normal interface level (the actual cause of
// "analog gain sounds harsh"). Asymmetry here is slope-continuous: both
// halves have identical small-signal gain (no crossover kink at zero),
// but the negative half clips at half the ceiling — the same shape a
// tube stage's bias shift produces, which is what generates the even
// harmonics a symmetric tanh can't.
function paMakeAmpClipCurve(drive) {
  const n = 2048;
  const curve = new Float32Array(n);
  // drive 0..1 -> k 2..16, exponential so the low half of the knob covers
  // edge-of-breakup through crunch (k≈3.7 at the 30% default; k≈5.5 — the
  // measured match for the reference sample's hard-picked moments — lands
  // near 50%) and the top half goes on to saturated lead gain.
  const k = 2 * Math.pow(8, Math.min(1, Math.max(0, drive)));
  const asym = 2; // negative-half ceiling = 1/asym
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = x >= 0 ? Math.tanh(k * x) : Math.tanh(k * asym * x) / asym;
  }
  return curve;
}

function paMakeReverbImpulse(ctx, seconds, decay) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

// ---------------------------------------------------------------------------
// Graph construction (lazy — built once, first time the panel opens)
// ---------------------------------------------------------------------------

// Code-review finding: this used to be "if (PA.built) return;" with no
// in-flight guard — a second call landing before the first's awaited
// addModule()/node-construction work finished would see PA.built still
// false and build an entire SECOND rig graph, permanently orphaning the
// first (still connected, still processing every render quantum, with no
// reference left to disconnect it). Reachable in practice: Play Along,
// Tone Lab, and AI Lab's Rate My Take all call paEnsureRigSessionReady on
// open, so clicking between them fast enough on the FIRST open of any of
// them this session (the only time the worklet loads take real time) could
// trigger it. paGraphBuildPromise makes concurrent callers await the same
// in-flight build instead of starting their own — same fix shape as
// app.js's stemLoadGeneration guard for the same class of race.
let paGraphBuildPromise = null;

async function ensurePAGraph() {
  ensureCtx(); // app.js — same context/graph as backing-track playback
  if (PA.built) return;
  if (paGraphBuildPromise) return paGraphBuildPromise;
  paGraphBuildPromise = _buildPAGraph().finally(() => { paGraphBuildPromise = null; });
  return paGraphBuildPromise;
}

async function _buildPAGraph() {
  await Audio.ctx.audioWorklet.addModule("gate-processor.js");
  await Audio.ctx.audioWorklet.addModule("nam-processor.js");
  await Audio.ctx.audioWorklet.addModule("octave-processor.js");

  PA.inAnal = Audio.ctx.createAnalyser();
  PA.inAnal.fftSize = 8192; // GP-01 needs several full cycles of a low guitar E (~82Hz) for accurate autocorrelation

  // Real user report: a multi-channel USB interface (e.g. a 2-in audio
  // interface where the guitar is plugged into input 2, not input 1) fed
  // silence through the whole rig despite the input meter correctly
  // showing signal. Cause: without an explicit channelCountMode, this
  // node's channelCount:1 is ignored (the WebAudio default mode is "max",
  // which does NOT downmix), so gate-processor.js's `inputs[0][0]` read
  // only ever saw channel 0 — silence whenever the live signal arrived on
  // channel 1. PA.inAnal (the meter) never showed this bug because
  // AnalyserNode always analyzes a proper mono downmix internally,
  // regardless of its own channelCount settings — a different node type
  // with different rules, not evidence the whole graph was already mixing
  // correctly. "explicit" here makes the browser actually perform the
  // standard stereo/multi-channel-to-mono downmix (0.5*(L+R) for stereo)
  // before this worklet ever runs, so it works regardless of which
  // physical input the interface's live channel is.
  PA.gateNode = new AudioWorkletNode(Audio.ctx, "gate-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit",
  });

  // IN-1: input trim — the very first thing in the chain, before the gate
  // and therefore before the amp and every pedal. Real user need: a
  // fixed-gain USB guitar dongle (no trim pot of its own) plus high-output
  // pickups arrives far too hot, which slams the amp stage into permanent
  // distortion no matter how the amp's own gain is set. This is the "turn
  // the wick down before the amp" control that a real interface's input
  // knob would be.
  //
  // Kept OUT of the rig preset on purpose (see PA_INPUT_TRIM_KEY): it
  // compensates for this guitar and this interface, not for a tone, so it
  // must not jump around when a preset or a song changes.
  //
  // IMPORTANT limit, and the reason the meter stays PRE-trim (see
  // paEnableInput): this is a software gain applied after the audio has
  // already been digitised. If the dongle's own converter is clipping, the
  // flat tops are already in the samples and nothing here can undo them —
  // trimming afterwards just makes a quieter clipped signal. The meter has
  // to keep showing what actually arrived so that case stays visible.
  PA.inputTrim = Audio.ctx.createGain();
  PA.inputTrim.gain.value = paDbToGain(paLoadInputTrimDb());
  PA.inputTrim.connect(PA.gateNode);

  PA.cleanGain = Audio.ctx.createGain();

  // Analog amp, v4.8 revoicing — matched against a real Marshall-sim
  // recording (~/Downloads "marshall sample": warm low-mids, H2≈H3≈-20dB
  // moderate asymmetric clipping, and a steep cab-style cliff at ~4.5kHz).
  // The old chain was just inputGain -> near-hard symmetric tanh -> tone
  // knobs: no pre-clip voicing (low strings intermodulate into mud, all
  // treble slams the clipper equally) and nothing above the 3k shelf to
  // stop the shaper's 5-15kHz harmonics — the classic "bee in a box"
  // fizz. Standard amp-sim recipe instead:
  //   tighten -> pre-emphasis -> asym clip -> DC block -> de-emphasis ->
  //   fixed Marshall-ish voicing -> cab-style lowpass -> tone knobs.
  // Pre-emphasis (+8dB above 550Hz) into the clipper with the inverse
  // shelf after is the key smoothing trick: highs distort MORE (sings,
  // feels amp-like) yet the net linear response stays flat, and the
  // de-emphasis also pulls generated harmonics down ~8dB. The 5kHz
  // lowpass supplies the measured cab cliff so the amp is usable
  // standalone; with a real IR stage active they stack to slightly
  // darker, which is benign (IRs are band-limited there anyway).
  // Validated offline against the sample: H2 -21.3 / H3 -19.6 / H5 -33.3
  // (target -21.1 / -19.9 / -32.0) at hard-picked levels, cleaning up at
  // lighter touch just like the reference (15.6dB crest).
  const inputGain = Audio.ctx.createGain();
  const preTight = Audio.ctx.createBiquadFilter(); preTight.type = "highpass"; preTight.frequency.value = 110; preTight.Q.value = 0.7;
  const preEmph = Audio.ctx.createBiquadFilter(); preEmph.type = "highshelf"; preEmph.frequency.value = 550; preEmph.gain.value = 8;
  const shaper = Audio.ctx.createWaveShaper();
  shaper.curve = paMakeAmpClipCurve(0.3);
  shaper.oversample = "4x";
  const dcBlock = Audio.ctx.createBiquadFilter(); dcBlock.type = "highpass"; dcBlock.frequency.value = 20; dcBlock.Q.value = 0.7;
  const deEmph = Audio.ctx.createBiquadFilter(); deEmph.type = "highshelf"; deEmph.frequency.value = 550; deEmph.gain.value = -8;
  const voiceWarm = Audio.ctx.createBiquadFilter(); voiceWarm.type = "lowshelf"; voiceWarm.frequency.value = 200; voiceWarm.gain.value = 2.5;
  const voiceScoop = Audio.ctx.createBiquadFilter(); voiceScoop.type = "peaking"; voiceScoop.frequency.value = 1400; voiceScoop.Q.value = 0.9; voiceScoop.gain.value = -3;
  // A-1: a real 4x12 cab's natural rolloff above ~5kHz is far steeper than
  // one 2nd-order biquad can produce (-12dB/oct gets to only ~-13dB by
  // 10kHz; measured real cabs are -25 to -35dB there) — that shallow tail
  // is the residual 6-12kHz energy that reads as "fizz" on top of the amp's
  // own distortion harmonics. Three cascaded lowpasses centred a touch
  // lower (~4.3kHz) reach the real cab's -20dB@8k / -30dB@10k depth while
  // leaving the 200Hz-3kHz body (where preTight/voiceWarm/voiceScoop do
  // their work) untouched — cutoff is still an octave-plus above it.
  const cabLp1 = Audio.ctx.createBiquadFilter(); cabLp1.type = "lowpass"; cabLp1.frequency.value = 4500; cabLp1.Q.value = 0.5;
  const cabLp2 = Audio.ctx.createBiquadFilter(); cabLp2.type = "lowpass"; cabLp2.frequency.value = 4500; cabLp2.Q.value = 0.5;
  const cabLp3 = Audio.ctx.createBiquadFilter(); cabLp3.type = "lowpass"; cabLp3.frequency.value = 4500; cabLp3.Q.value = 0.5;
  const bass = Audio.ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 150;
  const mid = Audio.ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 800; mid.Q.value = 0.7;
  const treble = Audio.ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
  inputGain.connect(preTight).connect(preEmph).connect(shaper).connect(dcBlock)
    .connect(deEmph).connect(voiceWarm).connect(voiceScoop).connect(cabLp1).connect(cabLp2).connect(cabLp3)
    .connect(bass).connect(mid).connect(treble);
  PA.analogNodes = { inputGain, shaper, bass, mid, treble, output: treble };

  PA.namNode = new AudioWorkletNode(Audio.ctx, "nam-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  paSendNamWasmModule(PA.namNode); // best-effort; see paGetNamWasmModule
  // paLoadNamModel() only listens on this port transiently (for the
  // "loaded" ack); this catches the process()-side failure fallback
  // instead of it going silently unnoticed if it's ever actually hit.
  PA.namNode.port.addEventListener("message", (e) => {
    if (e.data.type === "runtime-error") {
      document.getElementById("pa-nam-status").textContent =
        `Model disabled after a processing error: ${e.data.error}`;
    } else if (e.data.type === "live-overrun-rollback") {
      paHandleNamLiveOverrun(e.data.rtFactor);
    }
  });
  PA.namNode.port.start();

  // V3-T1: post-NAM tone stack — dedicated filters inside the amp block
  // (before Cab IR), separate from the post-chain EQ card further down.
  // Permanently wired bass->mid->treble->presence->ampOut regardless of amp
  // mode (harmless when nothing feeds it — setAmpMode only ever connects
  // PA.namNode to this chain's input in "neural" mode); flat (0dB) by
  // default so it's a no-op until a player actually reaches for it.
  PA.namToneBass = Audio.ctx.createBiquadFilter();
  PA.namToneBass.type = "lowshelf"; PA.namToneBass.frequency.value = 150;
  PA.namToneMid = Audio.ctx.createBiquadFilter();
  PA.namToneMid.type = "peaking"; PA.namToneMid.frequency.value = 800; PA.namToneMid.Q.value = 0.7;
  PA.namToneTreble = Audio.ctx.createBiquadFilter();
  PA.namToneTreble.type = "highshelf"; PA.namToneTreble.frequency.value = 3000;
  // Presence: a high-shelf tilt in the 4-8kHz "air"/pick-attack region,
  // distinct from Treble's broader top-end shelf.
  PA.namTonePresence = Audio.ctx.createBiquadFilter();
  PA.namTonePresence.type = "highshelf"; PA.namTonePresence.frequency.value = 6000;
  PA.namToneBass.connect(PA.namToneMid).connect(PA.namToneTreble).connect(PA.namTonePresence);

  PA.ampOut = Audio.ctx.createGain();
  PA.namTonePresence.connect(PA.ampOut);
  // v4.7: a fixed single entry point INTO the amp block, regardless of
  // which of the 3 modes is active — lets Amp be just another stage in
  // PA.pedalStages/PA.pedalOrder (a pedal like Wah or Boost can now sit
  // between the guitar and the amp), without setAmpMode's own mode-switch
  // fan-out (below) needing to know or care what precedes it in the chain.
  PA.ampIn = Audio.ctx.createGain();

  // GP-03/v4.7: IR/EQ/Comp/FX/Amp are all reorderable, so ampOut/ampIn-> IR
  // ->EQ->Comp->FX->output is no longer a hardwired sequence of .connect()
  // calls. Each stage still wires its OWN internal nodes fixed (e.g.
  // eqBass->eqMid->eqTreble, or IR's dry/wet split into its own merge) —
  // only the boundary BETWEEN stages is dynamic, torn down and rebuilt by
  // rewirePedalChain() according to PA.pedalOrder (which now includes
  // "amp" as one of its entries). Only Gate (always first — a noise gate
  // ahead of any dirt pedal is the near-universal want) and Output (always
  // last) stay genuinely fixed.

  // Cab IR (bypass = plain on/off, dry/wet gain pair)
  PA.convolver = Audio.ctx.createConvolver();
  // ConvolverNode's own built-in auto-normalize (on by default) scales the
  // IR by a generic energy-based formula that's really tuned for reverb-
  // style impulses — it's known to under-compensate for typical short,
  // sparse guitar cab IRs, leaving a real (sometimes large) volume drop
  // the moment one's loaded. Disabling it and doing our own peak-based
  // make-up gain (computed per file in paLoadIr, applied via
  // PA.irMakeupGain below) gives predictable, consistent loudness across
  // different IR files instead of however the browser's heuristic happens
  // to land on any given one.
  PA.convolver.normalize = false;
  PA.irMakeupGain = Audio.ctx.createGain(); PA.irMakeupGain.gain.value = 1;
  PA.irDryGain = Audio.ctx.createGain(); PA.irDryGain.gain.value = 1;
  PA.irWetGain = Audio.ctx.createGain(); PA.irWetGain.gain.value = 0;
  // v3.1 §2 (post-v3-backlog-audit.md §2.3): IR tone shaper — low/high-cut
  // on the wet (convolved) path only, so the dry bypass path is never
  // touched. Initialized wide open (20Hz/20000Hz = transparent), matching
  // the "Tone shape bypass" checkbox's default-checked state; the bypass
  // handler in wirePAControls swaps in the slider values when unbypassed.
  PA.irLowCut = Audio.ctx.createBiquadFilter();
  PA.irLowCut.type = "highpass"; PA.irLowCut.frequency.value = 20;
  PA.irHighCut = Audio.ctx.createBiquadFilter();
  PA.irHighCut.type = "lowpass"; PA.irHighCut.frequency.value = 20000;
  PA.convolver.connect(PA.irMakeupGain).connect(PA.irLowCut).connect(PA.irHighCut).connect(PA.irWetGain);
  PA.irMerge = Audio.ctx.createGain();
  PA.irDryGain.connect(PA.irMerge);
  PA.irWetGain.connect(PA.irMerge);

  // Post-amp EQ — bypass sets shelf/peak gains to 0dB (transparent), no merge needed
  const eqBass = Audio.ctx.createBiquadFilter(); eqBass.type = "lowshelf"; eqBass.frequency.value = 150;
  const eqMid = Audio.ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 800; eqMid.Q.value = 0.7;
  const eqTreble = Audio.ctx.createBiquadFilter(); eqTreble.type = "highshelf"; eqTreble.frequency.value = 3000;
  eqBass.connect(eqMid).connect(eqTreble);
  PA.eqNodes = { bass: eqBass, mid: eqMid, treble: eqTreble };

  // Compressor (bypass = dry/wet pair, since there's no clean "neutral" compressor setting)
  PA.compressor = Audio.ctx.createDynamicsCompressor();
  PA.compBypassDry = Audio.ctx.createGain(); PA.compBypassDry.gain.value = 1;
  PA.compBypassWet = Audio.ctx.createGain(); PA.compBypassWet.gain.value = 0;
  PA.compressor.connect(PA.compBypassWet);
  PA.compMerge = Audio.ctx.createGain();
  PA.compBypassDry.connect(PA.compMerge);
  PA.compBypassWet.connect(PA.compMerge);

  // Delay (dry always flows; wet gain doubles as the mix/bypass control)
  PA.delayNode = Audio.ctx.createDelay(2.0); PA.delayNode.delayTime.value = 0.3;
  PA.delayFeedback = Audio.ctx.createGain(); PA.delayFeedback.gain.value = 0.3;
  PA.delayWet = Audio.ctx.createGain(); PA.delayWet.gain.value = 0;
  PA.delayNode.connect(PA.delayFeedback).connect(PA.delayNode);
  PA.delayNode.connect(PA.delayWet);
  PA.delayMerge = Audio.ctx.createGain();
  PA.delayWet.connect(PA.delayMerge);

  // Reverb (same mix-gain-as-bypass pattern).
  //
  // CH-3: Delay and Reverb used to be one chain stage, hard-wired
  // delay-then-reverb (delayMerge fed the convolver and the dry path
  // directly). They are two pedals with two bypasses, so they are now two
  // stages — which also means reverb can go BEFORE delay if that's what you
  // want, and either can move independently around the amp. The only change
  // needed here is to stop reverb from wiring itself to delay's output:
  // whatever precedes it in PA.pedalOrder now feeds both the convolver and
  // the dry merge, exactly like every other wet/dry stage.
  PA.reverbConvolver = Audio.ctx.createConvolver();
  PA.reverbConvolver.buffer = paMakeReverbImpulse(Audio.ctx, 1.5, 2.5);
  PA.reverbWet = Audio.ctx.createGain(); PA.reverbWet.gain.value = 0;
  PA.reverbConvolver.connect(PA.reverbWet);
  PA.reverbMerge = Audio.ctx.createGain();
  PA.reverbWet.connect(PA.reverbMerge);

  // ---------------------------------------------------------------------
  // v3.1 §1 (post-v3-backlog-audit.md §2.2): the eight new pedal stages.
  // Same two bypass idioms already used above: a dry/wet GAIN PAIR for
  // stages with no neutral "off" state (Boost, Octaver — true hard bypass
  // or blend-to-zero), and a WET-GAIN-ONLY additive send for stages with a
  // Mix knob (Chorus/Flanger/Phaser/Auto-Wah, exactly like Delay/Reverb
  // above: the previous stage's output feeds the merge node directly as
  // the dry contribution AND feeds the effect chain as the wet source).
  // ---------------------------------------------------------------------

  // Boost/Overdrive — reuses paMakeDistortionCurve (same curve fn as the
  // Analog amp) as a standalone pedal. True hard bypass (dry/wet pair).
  PA.boostShaper = Audio.ctx.createWaveShaper();
  PA.boostShaper.curve = paMakeDistortionCurve(0.3);
  PA.boostShaper.oversample = "4x";
  PA.boostLevel = Audio.ctx.createGain();
  PA.boostShaper.connect(PA.boostLevel);
  PA.boostDryGain = Audio.ctx.createGain(); PA.boostDryGain.gain.value = 1;
  PA.boostWetGain = Audio.ctx.createGain(); PA.boostWetGain.gain.value = 0;
  PA.boostLevel.connect(PA.boostWetGain);
  PA.boostMerge = Audio.ctx.createGain();
  PA.boostDryGain.connect(PA.boostMerge);
  PA.boostWetGain.connect(PA.boostMerge);

  // Graphic EQ — 5-band peaking chain, distinct from the 3-band EQ card
  // further down. Bypass = zero all gains (same as that 3-band EQ).
  PA.geqNodes = {};
  const geqFreqs = [100, 300, 1000, 3000, 8000];
  let geqPrev = null;
  for (const freq of geqFreqs) {
    const f = Audio.ctx.createBiquadFilter();
    f.type = "peaking"; f.frequency.value = freq; f.Q.value = 1.0;
    PA.geqNodes[freq] = f;
    if (geqPrev) geqPrev.connect(f);
    geqPrev = f;
  }

  // Chorus — short modulated delay (LFO -> depth gain -> delayTime).
  PA.chorusDelay = Audio.ctx.createDelay(0.05);
  PA.chorusDelay.delayTime.value = 0.02;
  PA.chorusLfo = Audio.ctx.createOscillator();
  PA.chorusLfo.type = "sine"; PA.chorusLfo.frequency.value = 1.2;
  PA.chorusDepthGain = Audio.ctx.createGain(); PA.chorusDepthGain.gain.value = 0.005;
  PA.chorusLfo.connect(PA.chorusDepthGain).connect(PA.chorusDelay.delayTime);
  PA.chorusLfo.start();
  PA.chorusWetGain = Audio.ctx.createGain(); PA.chorusWetGain.gain.value = 0;
  PA.chorusDelay.connect(PA.chorusWetGain);
  PA.chorusMerge = Audio.ctx.createGain();
  PA.chorusWetGain.connect(PA.chorusMerge);

  // Flanger — same shape as Chorus but a much shorter base delay plus a
  // feedback loop for the classic resonant sweep.
  PA.flangerDelay = Audio.ctx.createDelay(0.02);
  PA.flangerDelay.delayTime.value = 0.004;
  PA.flangerLfo = Audio.ctx.createOscillator();
  PA.flangerLfo.type = "sine"; PA.flangerLfo.frequency.value = 0.3;
  PA.flangerDepthGain = Audio.ctx.createGain(); PA.flangerDepthGain.gain.value = 0.002;
  PA.flangerLfo.connect(PA.flangerDepthGain).connect(PA.flangerDelay.delayTime);
  PA.flangerLfo.start();
  PA.flangerFeedback = Audio.ctx.createGain(); PA.flangerFeedback.gain.value = 0.4;
  PA.flangerDelay.connect(PA.flangerFeedback).connect(PA.flangerDelay);
  PA.flangerWetGain = Audio.ctx.createGain(); PA.flangerWetGain.gain.value = 0;
  PA.flangerDelay.connect(PA.flangerWetGain);
  PA.flangerMerge = Audio.ctx.createGain();
  PA.flangerWetGain.connect(PA.flangerMerge);

  // Phaser — 4 cascaded allpass filters, all swept by one shared LFO.
  PA.phaserStages = [];
  let phaserPrev = null;
  for (let i = 0; i < 4; i++) {
    const f = Audio.ctx.createBiquadFilter();
    f.type = "allpass"; f.frequency.value = 800; f.Q.value = 0.7;
    if (phaserPrev) phaserPrev.connect(f);
    PA.phaserStages.push(f);
    phaserPrev = f;
  }
  PA.phaserLfo = Audio.ctx.createOscillator();
  PA.phaserLfo.type = "sine"; PA.phaserLfo.frequency.value = 0.5;
  PA.phaserDepthGain = Audio.ctx.createGain(); PA.phaserDepthGain.gain.value = 600;
  PA.phaserLfo.connect(PA.phaserDepthGain);
  for (const stage of PA.phaserStages) PA.phaserDepthGain.connect(stage.frequency);
  PA.phaserLfo.start();
  PA.phaserWetGain = Audio.ctx.createGain(); PA.phaserWetGain.gain.value = 0;
  PA.phaserStages[3].connect(PA.phaserWetGain);
  PA.phaserMerge = Audio.ctx.createGain();
  PA.phaserWetGain.connect(PA.phaserMerge);

  // Tremolo — pure amplitude modulation in place (no dry/wet split
  // needed): the LFO's depth-scaled output additively modulates a gain
  // node whose OWN baseline also moves with depth (see
  // updateTremoloDepthGain) so the gain swings between (1-depth) and 1 —
  // full depth genuinely dips to silence at the trough, the way a real
  // tremolo pedal does, instead of just oscillating around a fixed
  // unity baseline (which capped the loudest possible dip at -6dB
  // regardless of the Depth slider — the "even at 100% it's subtle" bug).
  // Bypass disconnects the LFO from the gain param and resets the
  // baseline to 1 instead of zeroing a wet send, since there's nothing to
  // mix — see updateTremoloBypass in wirePAControls.
  PA.tremoloGain = Audio.ctx.createGain(); PA.tremoloGain.gain.value = 1;
  PA.tremoloLfo = Audio.ctx.createOscillator();
  PA.tremoloLfo.type = "sine"; PA.tremoloLfo.frequency.value = 4.0;
  PA.tremoloDepthGain = Audio.ctx.createGain(); PA.tremoloDepthGain.gain.value = 0.25;
  PA.tremoloLfo.connect(PA.tremoloDepthGain);
  PA.tremoloLfo.start();
  // Deliberately NOT connected to PA.tremoloGain.gain here — the Bypass
  // checkbox defaults to checked, and updateTremoloBypass makes that
  // connection only when the pedal is actually engaged.

  // Auto-Wah — LFO-swept bandpass (not treadle-controlled: there's no
  // expression-pedal/MIDI input yet, that's GP-11 — named "Auto-Wah" in
  // the UI to say so honestly).
  //
  // v4.7 fix: unlike Chorus/Flanger/Phaser (where the dry signal is
  // deliberately ALWAYS present at full strength underneath the wet
  // signal — that's what makes a doubled/modulated copy sound like
  // chorus at all), a wah is supposed to fully reshape the tone: a narrow
  // bandpass sweep added on TOP of an always-full-volume, unfiltered dry
  // signal barely moves the overall tonal balance, since the swept band
  // is already present in the dry signal at the same unity gain — that
  // was the actual cause of "faint even at 100% mix," not a perception
  // issue. PA.wahDryGain makes Mix a real crossfade (dry fades out as wet
  // fades in) instead of always-on-dry plus scaled wet.
  PA.wahFilter = Audio.ctx.createBiquadFilter();
  PA.wahFilter.type = "bandpass"; PA.wahFilter.frequency.value = 800; PA.wahFilter.Q.value = 3;
  PA.wahLfo = Audio.ctx.createOscillator();
  PA.wahLfo.type = "sine"; PA.wahLfo.frequency.value = 1.0;
  PA.wahDepthGain = Audio.ctx.createGain(); PA.wahDepthGain.gain.value = 300;
  PA.wahLfo.connect(PA.wahDepthGain).connect(PA.wahFilter.frequency);
  PA.wahLfo.start();
  // Web Audio's "bandpass" is 0dB AT the center frequency, but a real
  // guitar signal's energy is spread across the spectrum, not sitting at
  // 800Hz alone — most of it falls outside this Q=3 band and gets rolled
  // off, so the filtered signal measures ~6.6dB quieter in RMS than the
  // dry input (measured against an actual separated guitar stem, static
  // center, no LFO sweep). A real wah pedal's buffer/gain stage keeps it
  // close to unity loudness; this makeup gain does the same rather than
  // making "turn the wah on" sound like a volume cut.
  PA.wahMakeupGain = Audio.ctx.createGain(); PA.wahMakeupGain.gain.value = 2.15;
  PA.wahWetGain = Audio.ctx.createGain(); PA.wahWetGain.gain.value = 0;
  PA.wahFilter.connect(PA.wahMakeupGain).connect(PA.wahWetGain);
  PA.wahDryGain = Audio.ctx.createGain(); PA.wahDryGain.gain.value = 1; // bypass default — see updateWahWet
  PA.wahMerge = Audio.ctx.createGain();
  PA.wahWetGain.connect(PA.wahMerge);
  PA.wahDryGain.connect(PA.wahMerge);

  // CH-4: Manual Wah — a treadle wah, swept by a real expression pedal
  // (MIDI CC) or the on-screen Pedal slider, as opposed to the Auto-Wah
  // above which sweeps itself from an LFO. Same filter topology and the
  // same real dry/wet crossfade; the only difference is what moves the
  // centre frequency, which is exactly the difference between the two
  // pedals in real life.
  //
  // The sweep is LOGARITHMIC between heel and toe (f = heel * (toe/heel)^p)
  // rather than linear in Hz. A wah's musical effect is the vowel-like
  // formant moving by roughly equal intervals per equal treadle movement,
  // and pitch is logarithmic — a linear Hz sweep spends most of the travel
  // up in the top octave and crawls through the low end, which does not
  // sound like a wah at all.
  PA.mwahFilter = Audio.ctx.createBiquadFilter();
  PA.mwahFilter.type = "bandpass";
  PA.mwahFilter.Q.value = PA_MWAH_DEFAULT_Q;
  PA.mwahFilter.frequency.value = PA_MWAH_DEFAULT_HEEL_HZ;
  // Same makeup-gain reasoning as the Auto-Wah's: a bandpass is 0dB at its
  // centre, but a guitar's energy is spread across the spectrum and most of
  // it lands outside the band, so the filtered signal is much quieter than
  // the dry one and engaging the pedal would read as a volume drop. See
  // PA_MWAH_MAKEUP_GAIN for the measurement behind the number.
  PA.mwahMakeupGain = Audio.ctx.createGain();
  PA.mwahMakeupGain.gain.value = PA_MWAH_MAKEUP_GAIN;
  PA.mwahWetGain = Audio.ctx.createGain(); PA.mwahWetGain.gain.value = 0;
  PA.mwahFilter.connect(PA.mwahMakeupGain).connect(PA.mwahWetGain);
  PA.mwahDryGain = Audio.ctx.createGain(); PA.mwahDryGain.gain.value = 1;
  PA.mwahMerge = Audio.ctx.createGain();
  PA.mwahWetGain.connect(PA.mwahMerge);
  PA.mwahDryGain.connect(PA.mwahMerge);

  // Octaver — real octave-down via zero-crossing frequency division
  // (octave-processor.js AudioWorklet), same technique classic analog
  // octave pedals use. An earlier version tried a WaveShaper "rectify and
  // lowpass" trick, which turned out not to produce sub-octave content at
  // all (rectifying a sine DOUBLES its frequency — that's an octave UP —
  // so low-passing away the doubled content just left a near-DC blob that
  // muddied the mix instead of adding a real low note under it). Blend
  // knob crossfades dry/wet, same idiom as Boost's hard-bypass pair.
  PA.octaveNode = new AudioWorkletNode(Audio.ctx, "octave-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
  });
  PA.octaverDryGain = Audio.ctx.createGain(); PA.octaverDryGain.gain.value = 1;
  PA.octaverWetGain = Audio.ctx.createGain(); PA.octaverWetGain.gain.value = 0;
  PA.octaveNode.connect(PA.octaverWetGain);
  PA.octaverMerge = Audio.ctx.createGain();
  PA.octaverDryGain.connect(PA.octaverMerge);
  PA.octaverWetGain.connect(PA.octaverMerge);

  PA.outputGain = Audio.ctx.createGain();
  // V3-E2: dedicated mute node, separate from PA.outputGain (the level
  // slider owns that one outright now — see paSetTunerEnabled).
  PA.outputMute = Audio.ctx.createGain();
  PA.outAnal = Audio.ctx.createAnalyser();
  PA.outAnal.fftSize = 1024;
  // GP-06 (looper-pedal-spec.md §2): loopSum sits between outputMute and
  // outAnal specifically so the looper's own playback can feed back in
  // HERE — recorder.js's ensureRecordBus (and Riff Capture, which taps the
  // same bus) listen to loopSum now, not outputMute directly, so a Take or
  // Riff Capture recorded while a loop is playing actually contains it
  // instead of silently missing it. A no-op pass-through when the looper
  // has never been used (nothing else ever connects into it).
  PA.loopSum = Audio.ctx.createGain();
  PA.outputGain.connect(PA.outputMute).connect(PA.loopSum).connect(PA.outAnal).connect(Audio.ctx.destination);

  // GP-03: each stage's fan-in nodes (what the PREVIOUS stage's output must
  // connect to) and its single fan-out node (what feeds the NEXT stage).
  // v3.1: extended from 4 to 12 stages (post-v3-backlog-audit.md §2.2).
  // v4.7: gate/amp joined this map too (previously hardcoded as fixed
  // chain endpoints in rewirePedalChain) so Amp can be reordered like any
  // other stage — gate's own node serves as both its fan-in and fan-out
  // (a single AudioWorkletNode); amp's fan-in is PA.ampIn, the one node
  // every mode's entry point fans out from (see setAmpMode).
  // T-1a: a second, parallel way into the pedal chain, used by Tab View's
  // "play through my rig" bridge. It joins the chain at exactly the point
  // the gate feeds (see rewirePedalChain), NOT into the gate itself — a
  // noise gate whose threshold is set for a real guitar would chop or mute
  // a synthesized tab signal, which would read as "the toggle does
  // nothing". Everything after the gate (amp, cab IR, EQ, FX) still applies.
  PA.tabIn = Audio.ctx.createGain();

  PA.pedalStages = {
    gate: { inputs: [PA.gateNode], output: PA.gateNode },
    amp: { inputs: [PA.ampIn], output: PA.ampOut },
    ir: { inputs: [PA.irDryGain, PA.convolver], output: PA.irMerge },
    eq: { inputs: [eqBass], output: eqTreble },
    comp: { inputs: [PA.compBypassDry, PA.compressor], output: PA.compMerge },
    // CH-3: two stages, not one. Each takes the standard wet-send shape —
    // the previous stage feeds the effect's input AND the merge node
    // directly, so the dry signal is always present underneath.
    delay: { inputs: [PA.delayNode, PA.delayMerge], output: PA.delayMerge },
    reverb: { inputs: [PA.reverbConvolver, PA.reverbMerge], output: PA.reverbMerge },
    boost: { inputs: [PA.boostDryGain, PA.boostShaper], output: PA.boostMerge },
    geq: { inputs: [PA.geqNodes[100]], output: PA.geqNodes[8000] },
    chorus: { inputs: [PA.chorusDelay, PA.chorusMerge], output: PA.chorusMerge },
    flanger: { inputs: [PA.flangerDelay, PA.flangerMerge], output: PA.flangerMerge },
    phaser: { inputs: [PA.phaserStages[0], PA.phaserMerge], output: PA.phaserMerge },
    tremolo: { inputs: [PA.tremoloGain], output: PA.tremoloGain },
    wah: { inputs: [PA.wahFilter, PA.wahDryGain], output: PA.wahMerge },
    mwah: { inputs: [PA.mwahFilter, PA.mwahDryGain], output: PA.mwahMerge },
    octaver: { inputs: [PA.octaverDryGain, PA.octaveNode], output: PA.octaverMerge },
  };
  PA.pedalOrder = paLoadPedalOrder();
  rewirePedalChain();

  setAmpMode("clean");
  PA.built = true;
}

// ---------------------------------------------------------------------------
// GP-03: expanded pedalboard — IR/EQ/Comp/FX/Amp in any order, drag-to-
// reorder (wireChainIconDragReorder, v4.7: dragging icons in
// #pa-chain-icons, not full cards). PA.pedalOrder is the current sequence
// of those stage IDs; gateNode always feeds the first one and the last
// one always feeds outputGain. Persisted in localStorage for continuity
// across reloads and captured/applied by V3-T2's rig presets
// (paCaptureRigState/paApplyRigState) for the "save the whole rig" case.
// ---------------------------------------------------------------------------
// IN-1: input trim, in dB, applied before the gate/amp/pedals. Stored in
// localStorage next to the input-device choice rather than in the rig
// preset, because it belongs to the HARDWARE (this guitar's output level,
// this interface's fixed gain) and not to a tone: switching preset or song
// must not change how hot the signal arriving at the amp is. Range is
// asymmetric on purpose — the problem it exists for is too much level, so
// there is a lot of cut and only a little boost.
const PA_INPUT_TRIM_KEY = "gs_pa_input_trim_db";
const PA_INPUT_TRIM_MIN_DB = -30;
const PA_INPUT_TRIM_MAX_DB = 12;

function paDbToGain(db) {
  return Math.pow(10, db / 20);
}

function paLoadInputTrimDb() {
  const raw = parseFloat(localStorage.getItem(PA_INPUT_TRIM_KEY));
  if (!Number.isFinite(raw)) return 0;
  return Math.min(PA_INPUT_TRIM_MAX_DB, Math.max(PA_INPUT_TRIM_MIN_DB, raw));
}

// Ramped rather than set outright: this sits directly in the live guitar
// path, and a step change in gain while a note is ringing is an audible
// click. Same reasoning as every other live control in this file.
function paSetInputTrimDb(db, ramp = true) {
  localStorage.setItem(PA_INPUT_TRIM_KEY, String(db));
  if (!PA.inputTrim) return;
  const target = paDbToGain(db);
  if (ramp && Audio.ctx) {
    PA.inputTrim.gain.setTargetAtTime(target, Audio.ctx.currentTime, 0.01);
  } else {
    PA.inputTrim.gain.value = target;
  }
}

// CH-4: Manual Wah defaults. The heel/toe range is the usual voicing of a
// treadle wah — roughly the low-mid honk up to the top-end quack — and is
// adjustable per-rig; Q is a touch more resonant than the Auto-Wah's 3,
// which is what makes a swept wah sound vocal rather than like a tone
// control being turned.
const PA_MWAH_DEFAULT_HEEL_HZ = 350;
const PA_MWAH_DEFAULT_TOE_HZ = 2200;
const PA_MWAH_DEFAULT_Q = 4;
// Measured, not guessed — same method as the Auto-Wah's own 2.15, and worth
// measuring because the answer depends on the spectrum of real guitar, not
// on the filter alone. A separated guitar stem was run through this exact
// BiquadFilterNode at Q=4 in an OfflineAudioContext, swept heel-to-toe the
// way a foot would, and the wet RMS compared to the dry: the band keeps
// only a slice of the signal's energy and the sweep measured 11.85 dB down,
// so without makeup gain "engage the wah" would read as "turn the volume
// down". First guess here was 2.6x; the measurement said 3.91x. Rerun with
// scripts/wah_makeup_measure.js.
//
// This matches RMS — loudness — deliberately, and that means PEAKS grow: a
// resonant bandpass rings, so the level-matched wet signal measured a peak
// of 0.693 against the dry stem's 0.499, about 3dB up. That is real wah
// behaviour rather than an artifact (a Cry Baby's resonant peak does the
// same, and it is part of why a wah into a drive pedal sounds like it
// does), but it does mean a very hot input can reach the rail with the wah
// full up. Lower Q, lower Mix, or the Output level all pull it back.
const PA_MWAH_MAKEUP_GAIN = 3.9;
// A CC arrives as one of 128 steps, and a pedal being swept sends them in a
// fast stream. Writing frequency.value directly turns that into 128 audible
// steps (zipper noise) rather than a sweep, so each update ramps instead —
// short enough to feel immediate under the foot, long enough to smooth the
// staircase. Same setTargetAtTime idiom as IN-1's input trim.
const PA_MWAH_SMOOTHING_SEC = 0.012;

const PA_PEDAL_ORDER_KEY = "gs_pa_pedal_order";

// CH-1: the default chain order is now the conventional pedalboard one.
//
// It used to be "amp first, then everything else", which was chosen in v4.7
// purely so that adding Amp to the reorderable set changed nobody's sound —
// a safe migration default, never a good rig. It put every drive and
// dynamics pedal AFTER the amp, so Boost/Overdrive boosted the amp's output
// instead of driving its input (the one thing a boost exists to do), and it
// put Wah, Octaver, Boost and the compressor between the amp and its cab,
// which is not a place any of them belong.
//
// The order below is the standard one, and the reasoning is worth keeping
// because each block is a different rule:
//
//   input, gate     Fixed, before everything. Trim first (IN-1), then gate
//                   the guitar's own hum before anything amplifies it.
//   wah             Filters go first, straight off the pickups. A wah after
//                   distortion sweeps the fizz rather than the note, which
//                   is why the classic sound is wah-into-drive.
//   comp            Evens out the level going into the drive, so the amp
//                   sees a consistent input. After the wah, so it isn't
//                   squashing the sweep's own peaks.
//   octaver         Pitch tracking needs a clean signal — this one divides
//                   zero crossings, and distortion's extra crossings are
//                   exactly what breaks it. Last clean stage before drive.
//   boost           Drive is the final thing in front of the amp; that is
//                   what "pushing the front end" means.
//   amp             The preamp/power amp.
//   ir              Its cab. Always directly after the amp — a cab IR is a
//                   speaker, and nothing sits between an amp and its
//                   speaker.
//   geq, eq         Post-cab tone shaping, which is the graphic EQ's classic
//                   effects-loop job (mid scoop, solo boost). After the cab
//                   they voice the finished sound rather than re-shaping
//                   what the amp distorts, and they stay useful whatever
//                   amp mode is selected.
//   chorus,
//   phaser,
//   flanger,
//   tremolo         Modulation. This is the effects-loop position: run into
//                   a distorting preamp, modulation gets smeared into the
//                   distortion; run after it, each note stays distinct.
//                   Their order relative to each other is genuinely taste,
//                   so it is left as it was.
//   fx (delay,
//       reverb)     Time-based effects last, so repeats and tails decay
//                   naturally instead of being re-distorted and re-modulated
//                   on every repeat.
//   output          Fixed, last.
//
// There is no separate "effects loop" stage because there doesn't need to
// be: everything here is reorderable, so the loop is simply the part of the
// chain that sits after Amp — which is where this default already puts
// modulation and time.
// CH-3/CH-4 change two entries of it: "fx" became the separate "delay" and
// "reverb" stages, and "mwah" (the treadle wah) joined the filters at the
// front. Both wahs sit first for the same reason — they are filters — and
// their order relative to each other barely matters, since you would only
// ever have one of them engaged.
const PA_DEFAULT_PEDAL_ORDER = [
  "mwah", "wah", "comp", "octaver", "boost",
  "amp", "ir",
  "geq", "eq",
  "chorus", "phaser", "flanger", "tremolo",
  "delay", "reverb",
];

const PA_PEDAL_ORDER_VERSION_KEY = "gs_pa_pedal_order_v";
// Bumping this resets the live chain to PA_DEFAULT_PEDAL_ORDER exactly once,
// for anyone who hasn't already been reset at this version. Version 2
// preserved a deliberately customised order and only replaced the untouched
// old default; version 3 is a requested one-off "just give me the fix" —
// the app currently has one user, who asked for the new order outright, and
// a conditional migration would have had to guess whether an order was
// deliberate. It still runs ONCE: the stamp is written the first time this
// is called, so any reorder made afterwards survives every future load.
//
// If this app ever has other users, prefer version 2's shape (replace only
// what matches a known old default) over this one. Resetting someone's rig
// without being asked is the sort of thing that is fine exactly once, on
// request, and never as a habit.
const PA_PEDAL_ORDER_VERSION = 3;

// A stored or preset order can predate the current stage list: CH-3 split
// "fx" into "delay" + "reverb", and CH-4 added "mwah". Rather than throwing
// such an order away (which would silently discard a rig someone built),
// translate what it does say and append whatever it doesn't mention, in
// default-order position. Unknown ids are dropped — a stage that no longer
// exists has nowhere to be wired.
function paNormalizePedalOrder(order) {
  if (!Array.isArray(order)) return [...PA_DEFAULT_PEDAL_ORDER];
  const known = new Set(PA_DEFAULT_PEDAL_ORDER);
  const out = [];
  for (const raw of order) {
    // "fx" was one stage holding both; it expands in place, delay first,
    // which is the order it was hard-wired in before the split.
    const ids = raw === "fx" ? ["delay", "reverb"] : [raw];
    for (const id of ids) if (known.has(id) && !out.includes(id)) out.push(id);
  }
  for (const id of PA_DEFAULT_PEDAL_ORDER) if (!out.includes(id)) out.push(id);
  return out;
}

function paLoadPedalOrder() {
  const version = parseInt(localStorage.getItem(PA_PEDAL_ORDER_VERSION_KEY) || "1", 10);
  if (version < PA_PEDAL_ORDER_VERSION) {
    localStorage.setItem(PA_PEDAL_ORDER_VERSION_KEY, String(PA_PEDAL_ORDER_VERSION));
    localStorage.setItem(PA_PEDAL_ORDER_KEY, JSON.stringify(PA_DEFAULT_PEDAL_ORDER));
    return [...PA_DEFAULT_PEDAL_ORDER];
  }
  try {
    const stored = JSON.parse(localStorage.getItem(PA_PEDAL_ORDER_KEY) || "null");
    // Defensive: only trust a stored order if it names exactly the known
    // stages — a stale or foreign value falls back to the default rather
    // than dropping a stage's audio out of the chain entirely.
    if (Array.isArray(stored) && stored.length === PA_DEFAULT_PEDAL_ORDER.length &&
        PA_DEFAULT_PEDAL_ORDER.every((id) => stored.includes(id))) {
      return stored;
    }
    // Recognisably an older order (it had stages) rather than junk — keep
    // the arrangement and just bring it up to date.
    if (Array.isArray(stored) && stored.length) return paNormalizePedalOrder(stored);
  } catch (e) { /* fall through to default */ }
  return [...PA_DEFAULT_PEDAL_ORDER];
}

function paSavePedalOrder() {
  localStorage.setItem(PA_PEDAL_ORDER_KEY, JSON.stringify(PA.pedalOrder));
}

// Disconnects the chain implied by PA._wiredPedalOrder (whatever's actually
// live right now — undefined/empty the first time this runs, in which case
// there's nothing to tear down) and connects the chain implied by
// PA.pedalOrder. gateNode and outputGain are the fixed endpoints; Amp is
// now just one more entry inside PA.pedalOrder (v4.7) — everything between
// gate and output is exactly PA.pedalOrder, stage by stage.
function rewirePedalChain() {
  const stageOutput = (id) => PA.pedalStages[id].output;
  // T-1a: whatever the gate feeds is also what PA.tabIn feeds — computed the
  // same way for the old and new orders so the tab bridge follows a pedal
  // reorder automatically instead of being left pointing at a stage that is
  // no longer first.
  const headTargets = (chainIds) =>
    chainIds.length > 1 ? PA.pedalStages[chainIds[1]].inputs : [PA.outputGain];

  const prevChain = ["gate", ...(PA.wiredPedalOrder || [])];
  for (let i = 0; i < prevChain.length - 1; i++) {
    const out = stageOutput(prevChain[i]);
    for (const inp of PA.pedalStages[prevChain[i + 1]].inputs) {
      try { out.disconnect(inp); } catch (e) { /* wasn't connected */ }
    }
  }
  if (PA.wiredPedalOrder) {
    try { stageOutput(prevChain[prevChain.length - 1]).disconnect(PA.outputGain); } catch (e) { /* wasn't connected */ }
    if (PA.tabIn) {
      for (const inp of headTargets(prevChain)) {
        try { PA.tabIn.disconnect(inp); } catch (e) { /* wasn't connected */ }
      }
    }
  }

  const chain = ["gate", ...PA.pedalOrder];
  for (let i = 0; i < chain.length - 1; i++) {
    const out = stageOutput(chain[i]);
    for (const inp of PA.pedalStages[chain[i + 1]].inputs) out.connect(inp);
  }
  stageOutput(chain[chain.length - 1]).connect(PA.outputGain);
  if (PA.tabIn) for (const inp of headTargets(chain)) PA.tabIn.connect(inp);

  PA.wiredPedalOrder = [...PA.pedalOrder];
}

// ---------------------------------------------------------------------------
// Amp mode switching — all three paths exist permanently; only the active
// one is actually wired from PA.ampIn (whatever chain stage currently
// precedes Amp — see rewirePedalChain) to ampOut, so an unselected NAM
// model isn't burning CPU on inference nobody's listening to.
// ---------------------------------------------------------------------------

function setAmpMode(mode) {
  for (const [src, dst] of [
    [PA.ampIn, PA.cleanGain], [PA.ampIn, PA.analogNodes.inputGain], [PA.ampIn, PA.namNode],
    [PA.cleanGain, PA.ampOut], [PA.analogNodes.output, PA.ampOut], [PA.namNode, PA.namToneBass],
  ]) {
    try { src.disconnect(dst); } catch (e) { /* wasn't connected */ }
  }

  if (mode === "clean") { PA.ampIn.connect(PA.cleanGain); PA.cleanGain.connect(PA.ampOut); }
  else if (mode === "analog") { PA.ampIn.connect(PA.analogNodes.inputGain); PA.analogNodes.output.connect(PA.ampOut); }
  // V3-T1: namNode feeds the post-NAM tone stack, not ampOut directly — the
  // tone stack's own output is permanently wired to ampOut (see
  // ensurePAGraph), so only this one connection needs to toggle with mode.
  else if (mode === "neural") { PA.ampIn.connect(PA.namNode); PA.namNode.connect(PA.namToneBass); }

  PA.ampMode = mode;
  document.querySelectorAll("#pa-amp-modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("pa-amp-clean").style.display = mode === "clean" ? "block" : "none";
  document.getElementById("pa-amp-analog").style.display = mode === "analog" ? "block" : "none";
  document.getElementById("pa-amp-neural").style.display = mode === "neural" ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Input device + getUserMedia
// ---------------------------------------------------------------------------
//
// v3.1 fix: "Enable Input" used to default to whatever getUserMedia's own
// default is, which on a Mac with no explicit choice is the built-in
// microphone — live-monitored through speakers into an amp/distortion
// chain, a textbook feedback loop (the exact scenario documented in
// USER-MANUAL.md's auto-calibrate section, which hit the same issue from
// the recording side). Two fixes, same idiom as pedal order (localStorage):
// remember whichever device was last actually used,
// and — before any device has ever been chosen — prefer an input whose
// label doesn't look like the built-in mic. Device labels are blank until
// mic permission has been granted at least once for this origin, so on a
// truly first-ever run (no prior permission grant in this browser
// profile) this heuristic can't see anything to prefer and the OS default
// wins for that one session — same platform limitation the app can't see
// around, not a bug in this fix.
const PA_INPUT_DEVICE_KEY = "gs_pa_input_device";

async function paRefreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const sel = document.getElementById("pa-device-select");
  const prevValue = sel.value;
  sel.innerHTML = "";
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Input ${sel.children.length + 1}`;
    sel.appendChild(opt);
  }

  if (prevValue && inputs.some((d) => d.deviceId === prevValue)) {
    sel.value = prevValue;
    return;
  }
  const savedId = localStorage.getItem(PA_INPUT_DEVICE_KEY);
  if (savedId && inputs.some((d) => d.deviceId === savedId)) {
    sel.value = savedId;
    return;
  }
  const nonBuiltIn = inputs.find((d) => d.label && !/built-in|macbook/i.test(d.label));
  if (nonBuiltIn) sel.value = nonBuiltIn.deviceId;
}

// Output device picker (Tone Lab's Output card) — routes the ENTIRE
// shared AudioContext (backing-track mix, click, and the live rig alike)
// to a chosen device via AudioContext.setSinkId, so Guitar Studio can
// monitor through the audio interface while the rest of the Mac stays on
// its speakers. Using the interface for BOTH input and output puts the
// whole monitoring path on one clock at one rate — no cross-device
// resampling/drift buffering, the single biggest practical latency lever
// left after the v4.7 latencyHint work. Recording is unaffected either
// way: takes tap the graph's record bus (recorder.js), not any output
// device. Same localStorage idiom as the input picker above; the saved
// sink is applied at context creation (ensureCtx, app.js) so mixer-only
// sessions honor it too, not just ones that open Tone Lab.
const GS_OUTPUT_DEVICE_KEY = "gs_output_device";

async function paRefreshOutputDevices() {
  const sel = document.getElementById("pa-output-device-select");
  if (!("setSinkId" in AudioContext.prototype)) {
    sel.style.display = "none";
    document.getElementById("pa-output-device-hint").textContent =
      "Output device selection isn't supported in this browser — use the OS sound settings instead.";
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const prevValue = sel.value;
  sel.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "System default";
  sel.appendChild(defaultOpt);
  for (const d of outputs) {
    // Skip Chrome's synthetic "default" entry (the explicit option above
    // covers it) and permission-stripped entries with blank deviceIds —
    // before mic permission is granted, enumerateDevices returns devices
    // with empty ids/labels that can't actually be selected (and an empty
    // value would collide with "System default").
    if (d.deviceId === "default" || !d.deviceId) continue;
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Output ${sel.children.length}`;
    sel.appendChild(opt);
  }
  if (sel.options.length === 1) {
    document.getElementById("pa-output-device-hint").textContent =
      "Device names appear after input permission is granted — click Enable input once.";
  }
  const saved = localStorage.getItem(GS_OUTPUT_DEVICE_KEY);
  for (const candidate of [prevValue, saved]) {
    if (candidate && [...sel.options].some((o) => o.value === candidate)) {
      sel.value = candidate;
      break;
    }
  }
}

async function paApplyOutputDevice(deviceId) {
  const hintEl = document.getElementById("pa-output-device-hint");
  ensureCtx(); // picker can be used before anything has played
  try {
    await Audio.ctx.setSinkId(deviceId);
    localStorage.setItem(GS_OUTPUT_DEVICE_KEY, deviceId);
    const sel = document.getElementById("pa-output-device-select");
    const label = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "device";
    hintEl.textContent = deviceId
      ? `All Guitar Studio audio now outputs to ${label} — listen there (headphones/monitors on the interface). Recording is unaffected.`
      : "Following the system default output.";
    paShowLatencyEstimate(); // sink change can change the reported numbers
  } catch (e) {
    hintEl.textContent = `Couldn't switch output: ${e.message}`;
  }
}

async function paEnableInput() {
  await ensurePAGraph();
  const deviceId = document.getElementById("pa-device-select").value;
  const hintEl = document.getElementById("pa-input-hint");
  try {
    // latency ideal:0 asks the capture stack for its smallest input buffer
    // — an "ideal" constraint can't fail the getUserMedia call, the
    // browser just gets as close as it can. The input buffer is the one
    // piece of the monitoring path no Web Audio API can even measure
    // (see paShowLatencyEstimate), so asking is all that's available.
    const audioConstraints = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      latency: { ideal: 0 },
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    if (PA.source) { try { PA.source.disconnect(); } catch (e) { /* noop */ } }
    if (PA.stream) PA.stream.getTracks().forEach((t) => t.stop());

    PA.stream = stream;
    PA.source = Audio.ctx.createMediaStreamSource(stream);
    // IN-1: the rig now hangs off the trim, not the raw source, so the trim
    // is genuinely the first stage — ahead of the gate, the amp and every
    // pedal.
    PA.source.connect(PA.inputTrim);
    // ...but the meter and the tuner stay on the RAW source, deliberately.
    // The trim is a software gain applied after the converter, so it cannot
    // undo clipping that happened in the interface itself; if the meter sat
    // after it, pulling the trim down would make a hard-clipped signal look
    // healthy while it still sounds broken. Keeping the meter pre-trim means
    // it always answers the question only it can answer — "is the level
    // arriving from the hardware sane?" — and leaves the trim to answer
    // "how hard am I hitting the amp?". It also keeps the tuner's
    // sensitivity independent of the trim setting.
    PA.source.connect(PA.inAnal);

    // GP-10: a new input session clears the latched clip light — it's
    // meant to persist through one practice session, not forever.
    PA.inputClipped = false;
    updateClipIndicator();

    hintEl.textContent = "Input enabled.";
    await paRefreshDevices(); // device labels only populate after permission is granted
    paRefreshOutputDevices(); // same permission gate applies to output labels
    // v3.1: persist whichever device actually just succeeded — including
    // the very first auto-picked default — so future sessions start here
    // instead of re-deriving the same heuristic from scratch every time.
    const activeId = document.getElementById("pa-device-select").value;
    if (activeId) localStorage.setItem(PA_INPUT_DEVICE_KEY, activeId);
    paStartMeters();
    paUpdateRigPill();
  } catch (e) {
    hintEl.textContent = `Could not access input: ${e.message}. Check System Settings > Privacy & Security > Microphone.`;
  }
}

// GP-01: chromatic tuner — standard autocorrelation (ACF) pitch detection
// with parabolic interpolation for sub-bin precision, the same well-known
// approach most browser-based tuners use (e.g. Chris Wilson's Web Audio
// pitch-detector demo). Runs on the existing input-monitoring analyser —
// no new audio routing, just reading the same tap the level meter already
// uses (per the spec's own suggested approach).
function paAutoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  // Real user report: the tuner dropped a plucked string's reading well
  // before it had actually decayed into silence. 0.01 (~-40dBFS) was
  // cutting off usable pitch signal early in a normal string's decay tail
  // — lowered to 0.003 (~-50dBFS) for another ~10dB of decay tracked
  // before giving up, well clear of a typical room/interface noise floor.
  if (rms < 0.003) return -1; // too quiet to trust

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) { if (Math.abs(buf[i]) < thres) { r1 = i; break; } }
  for (let i = 1; i < SIZE / 2; i++) { if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; } }
  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  if (n < 2) return -1;

  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n - i; j++) sum += trimmed[j] * trimmed[j + i];
    c[i] = sum;
  }
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) { if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; } }
  if (maxPos <= 0) return -1;

  let t0 = maxPos;
  const x1 = c[t0 - 1] ?? c[t0], x2 = c[t0], x3 = c[t0 + 1] ?? c[t0];
  const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
  if (a !== 0) t0 -= b / (2 * a);
  return t0 > 0 ? sampleRate / t0 : -1;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function paFreqToNote(freq) {
  const noteNum = 12 * Math.log2(freq / 440) + 69; // MIDI note number, A4=69=440Hz
  const rounded = Math.round(noteNum);
  const cents = Math.round((noteNum - rounded) * 100);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name: name + octave, cents };
}

// Arc gauge geometry (v5 redesign) — matches the SVG path in index.html:
// "M30,150 A120,120 0 0,1 270,150", a semicircle centered at (150,150)
// with radius 120. The pointer/dot both sit at the same angle, computed
// from cents the same way a clock hand's position comes from an angle:
// theta=0 (in tune) points straight up; theta scales linearly with cents
// out to +-PA_TUNER_ARC_MAX_DEG at the +-50-cent clamp, leaving a little
// headroom before the arc's own physical endpoints rather than pegging
// the pointer exactly into the corners at max deflection.
const PA_TUNER_ARC_CX = 150, PA_TUNER_ARC_CY = 150, PA_TUNER_ARC_R = 120;
const PA_TUNER_ARC_MAX_DEG = 80;

function paTunerArcPoint(cents, radius) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const theta = (clamped / 50) * PA_TUNER_ARC_MAX_DEG * (Math.PI / 180);
  return {
    x: PA_TUNER_ARC_CX + radius * Math.sin(theta),
    y: PA_TUNER_ARC_CY - radius * Math.cos(theta),
  };
}

// Shared by paResetTunerDisplay (clears all three) and paUpdateTuner (sets
// exactly one) — red = flat, blue = sharp, yellow = in tune (real user
// request), applied to the arc track, pointer, and dot together so the
// whole gauge reads as one instrument instead of the arc and pointer
// disagreeing about what state they're in.
const PA_TUNER_STATE_CLASSES = ["flat", "sharp", "in-tune"];

function paSetTunerState(state) {
  const track = document.getElementById("pa-tuner-arc-track");
  const pointer = document.getElementById("pa-tuner-pointer");
  const dot = document.getElementById("pa-tuner-arc-dot");
  [track, pointer, dot].forEach((el) => {
    el.classList.remove(...PA_TUNER_STATE_CLASSES);
    if (state) el.classList.add(state);
  });
}

function paResetTunerDisplay(status) {
  const statusEl = document.getElementById("pa-tuner-note");
  statusEl.textContent = status;
  statusEl.classList.remove("reading");
  document.getElementById("pa-tuner-hz").textContent = "Hz";
  document.getElementById("pa-tuner-cents-val").textContent = "Cents";
  const pointer = document.getElementById("pa-tuner-pointer");
  const dot = document.getElementById("pa-tuner-arc-dot");
  const center = paTunerArcPoint(0, PA_TUNER_ARC_R);
  const pointerPos = paTunerArcPoint(0, PA_TUNER_ARC_R + 18);
  pointer.setAttribute("transform", `translate(${pointerPos.x}, ${pointerPos.y})`);
  dot.setAttribute("cx", center.x);
  dot.setAttribute("cy", center.y);
  paSetTunerState(null);
}

function paUpdateTuner(inData) {
  const freq = paAutoCorrelate(inData, Audio.ctx.sampleRate);
  if (freq < 0) {
    paResetTunerDisplay("Listening…");
    return;
  }
  const statusEl = document.getElementById("pa-tuner-note");
  const { name, cents } = paFreqToNote(freq);
  statusEl.textContent = name;
  statusEl.classList.add("reading");
  document.getElementById("pa-tuner-hz").textContent = `${freq.toFixed(1)} Hz`;
  document.getElementById("pa-tuner-cents-val").textContent = `${cents >= 0 ? "+" : ""}${cents}¢`;
  const pointer = document.getElementById("pa-tuner-pointer");
  const dot = document.getElementById("pa-tuner-arc-dot");
  const dotPos = paTunerArcPoint(cents, PA_TUNER_ARC_R);
  const pointerPos = paTunerArcPoint(cents, PA_TUNER_ARC_R + 18);
  pointer.setAttribute("transform", `translate(${pointerPos.x}, ${pointerPos.y})`);
  dot.setAttribute("cx", dotPos.x);
  dot.setAttribute("cy", dotPos.y);
  // A few cents' allowance either side of dead-on before calling it "in
  // tune" — matches the existing +-5 threshold this replaces.
  paSetTunerState(Math.abs(cents) <= 5 ? "in-tune" : cents < 0 ? "flat" : "sharp");
}

function paSetTunerEnabled(enabled) {
  PA.tunerEnabled = enabled;
  document.getElementById("pa-tuner-toggle").classList.toggle("active", enabled);
  document.getElementById("pa-tuner-toggle").title = enabled
    ? "Click to turn the tuner off"
    : "Click to enable the tuner (mutes the backing track and your amp tone while on)";
  if (!enabled) paResetTunerDisplay("Tap to Start");

  // Tuning by ear against a live amp tone (or the backing track) fights the
  // whole point of a tuner — mute both while it's on, same convention as a
  // hardware tuner pedal muting its through signal.
  //
  // V3-E2: this only touches the dedicated mute nodes (Audio.masterMute,
  // PA.outputMute) now, never the level nodes (Audio.master, PA.outputGain)
  // that the volume/output-level sliders own — so moving a slider while
  // tuning can no longer silently un-mute.
  //
  // True 0 gain, not -90dB: the -90dB workaround existed only to dodge
  // Chrome's AudioContext auto-suspend heuristic (full silence to
  // destination could trigger it, freezing PA.inAnal — the tuner's own
  // input tap — along with everything else). V3-E1's statechange listener
  // now resumes the context event-driven whenever that happens, so real
  // silence is safe.
  if (PA.outputMute) PA.outputMute.gain.value = enabled ? 0 : 1;
  if (Audio.masterMute) Audio.masterMute.gain.value = enabled ? 0 : 1;
}

// GP-10: fixed -1dBFS clip threshold, deliberately NOT self-clearing — the
// point is to catch a transient clip you'd otherwise miss between glances
// at the meter, so once lit it stays lit until "Clear" or a new input
// session (see paEnableInput()).
const CLIP_THRESHOLD_LINEAR = dbToLin(-1);

function updateClipIndicator() {
  const el = document.getElementById("pa-clip-indicator");
  el.textContent = PA.inputClipped ? "CLIPPED" : "clip";
  el.classList.toggle("clipped", !!PA.inputClipped);
  paUpdateRigPill();
}

// ui-review-v5-full.md §2.5: global rig status pill, visible on every
// screen (not just Tone Lab) — silent/live/clipped, same source of truth
// as Tone Lab's own Input card (PA.stream, PA.inputClipped). Called
// whenever any of that state changes: paEnableInput's success path,
// updateClipIndicator (both setting and clearing the latch).
function paUpdateRigPill() {
  const pill = document.getElementById("rig-status-pill");
  const label = document.getElementById("rig-status-label");
  pill.classList.remove("live", "clipped");
  if (!PA.stream) {
    label.textContent = "Rig silent";
    pill.title = "Input not enabled yet — click to open Tone Lab's Input card.";
    return;
  }
  if (PA.inputClipped) {
    pill.classList.add("clipped");
    label.textContent = "Clipped";
    pill.title = "Input clipped — click to open Tone Lab and Clear it (or back off the gain).";
    return;
  }
  pill.classList.add("live");
  const est = Audio.ctx ? ((Audio.ctx.baseLatency || 0) + (Audio.ctx.outputLatency || 0)) * 1000 : 0;
  label.textContent = est > 0 ? `Rig live · ~${est.toFixed(0)} ms` : "Rig live";
  pill.title = "Input enabled" + (est > 0
    ? ` · ~${est.toFixed(0)} ms estimated OUTPUT-side latency only (browser-reported, excludes input/USB/driver latency) — click for Tone Lab's Input card.`
    : " — click to open Tone Lab's Input card.");
}

// V6-MEM3: peak of a buffer, by index rather than for...of.
//
// Iterating a Float32Array with for...of allocates an iterator result
// object PER SAMPLE. The meter loop walks two 8192-sample buffers every
// frame, so that came to roughly two million short-lived objects a second
// on a 120Hz display. It never leaked — GC kept up with it — but it was the
// heap sawtooth visible while hunting the MIDI recursion, and it is pure
// waste in the one loop that runs continuously for as long as input is
// enabled. Indexed access allocates nothing.
function paBufferPeak(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

function paStartMeters() {
  if (PA.meterRaf) cancelAnimationFrame(PA.meterRaf);
  const inData = new Float32Array(PA.inAnal.fftSize);
  const outData = new Float32Array(PA.outAnal.fftSize);
  // These two elements live as long as the page does, so looking them up
  // once beats two getElementById calls every frame forever.
  const inFill = document.getElementById("pa-input-meter-fill");
  const outFill = document.getElementById("pa-output-meter-fill");
  // Same skip-redundant-writes idiom the playhead/time renderers in app.js
  // already use: a silent input rewrites an identical width 120 times a
  // second otherwise, invalidating style for no visible change.
  let lastInWidth = null, lastOutWidth = null;
  let tunerFrameCount = 0;
  function tick() {
    PA.inAnal.getFloatTimeDomainData(inData);
    PA.outAnal.getFloatTimeDomainData(outData);
    const inMax = paBufferPeak(inData);
    const outMax = paBufferPeak(outData);
    const inWidth = Math.min(100, inMax * 100) + "%";
    const outWidth = Math.min(100, outMax * 100) + "%";
    if (inWidth !== lastInWidth) { inFill.style.width = inWidth; lastInWidth = inWidth; }
    if (outWidth !== lastOutWidth) { outFill.style.width = outWidth; lastOutWidth = outWidth; }

    if (inMax >= CLIP_THRESHOLD_LINEAR && !PA.inputClipped) {
      PA.inputClipped = true;
      updateClipIndicator();
    }

    // Throttled — autocorrelation is O(n^2) and doesn't need 60fps for a tuner.
    // Skipped entirely (not just left unread) when the tuner is off.
    if (PA.tunerEnabled && ++tunerFrameCount % 6 === 0) paUpdateTuner(inData);

    PA.meterRaf = requestAnimationFrame(tick);
  }
  tick();
}

// GP-10: one-time "play your loudest chord" wizard. Listens for a few
// seconds, tracks the peak input level actually seen, and suggests an
// output-level starting point that lands the current signal in a healthy
// operating range rather than right at the ceiling.
async function paCalibrate() {
  const resultEl = document.getElementById("pa-calibrate-result");
  if (!PA.source) {
    resultEl.textContent = "Enable input first.";
    return;
  }
  resultEl.textContent = "Listening — play your loudest chord now (3s)…";
  const data = new Float32Array(PA.inAnal.fftSize);
  let peak = 0;
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    PA.inAnal.getFloatTimeDomainData(data);
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    await new Promise((r) => setTimeout(r, 50));
  }
  if (peak < 0.001) {
    resultEl.textContent = "Didn't hear anything — check the input is enabled and try again.";
    return;
  }
  const peakDb = linToDb(peak);
  // Target: loudest transient should land around -6dBFS of headroom below
  // the ceiling; suggest an output trim that would have achieved that,
  // clamped to the slider's own range.
  const suggestedDb = Math.max(-24, Math.min(12, Math.round(-6 - peakDb)));
  const slider = document.getElementById("pa-output-level");
  slider.value = suggestedDb;
  slider.dispatchEvent(new Event("input"));
  resultEl.textContent = `Loudest input measured ${peakDb.toFixed(1)} dBFS — set output level to ` +
    `${suggestedDb >= 0 ? "+" : ""}${suggestedDb} dB as a starting point. Adjust further by ear.`;
}

// GP-13 (measured-latency-spec.md): #pa-latency-hint (paShowLatencyEstimate,
// above) only ever reports the browser's own OUTPUT-side buffering — no Web
// Audio API can see the input side (interface/USB/driver), which for an
// external interface is usually the LARGER share of real round-trip
// latency. This is a real measurement instead: a short, sharp click out the
// current output, detected coming back in through the currently enabled
// input, timed against the audio clock (ctx.currentTime), not wall-clock —
// requires a physical loop (the interface's own direct-out → direct-in, or
// its hardware direct-monitor path), which the UI says plainly rather than
// silently measuring whatever acoustic path (speaker → mic, an open room)
// happens to exist instead.
const PA_LATENCY_CAPTURE_MS = 1000;
const PA_LATENCY_CLICK_MS = 6; // short and sharp, not a sine — a sine's ambiguous zero-crossings make onset timing imprecise
const PA_LATENCY_THRESHOLD = 0.05; // relative amplitude; well above a quiet interface's own noise floor

async function paMeasureLatency() {
  const resultEl = document.getElementById("pa-measure-latency-result");
  if (!PA.source) { resultEl.textContent = "Enable input first — see Setup above."; return; }
  const ctx = Audio.ctx;
  resultEl.textContent = "Measuring — make sure your interface's output is looped into its own input " +
    "(direct-out → direct-in, or its own direct-monitor path is engaged), then wait a moment…";

  // A short, full-scale square burst: sharp onset, unambiguous to detect —
  // this is a diagnostic test tone, not something meant to sound musical.
  const clickSamples = Math.max(1, Math.round(ctx.sampleRate * PA_LATENCY_CLICK_MS / 1000));
  const clickBuf = ctx.createBuffer(1, clickSamples, ctx.sampleRate);
  clickBuf.getChannelData(0).fill(1);
  const clickSrc = ctx.createBufferSource();
  clickSrc.buffer = clickBuf;
  clickSrc.connect(ctx.destination);

  const playAt = ctx.currentTime + 0.05; // small head start so scheduling itself never races playback
  clickSrc.start(playAt);

  const fftSize = PA.inAnal.fftSize;
  const data = new Float32Array(fftSize);
  const deadline = performance.now() + PA_LATENCY_CAPTURE_MS;
  let detectedAt = null;
  while (performance.now() < deadline) {
    // getFloatTimeDomainData's window always ends "now" on the audio clock —
    // reconstructing each sample's own audio-clock time from its offset
    // within that window (rather than using wall-clock poll time) keeps
    // this accurate to about one render quantum, not just the polling
    // interval.
    const windowEndsAt = ctx.currentTime;
    PA.inAnal.getFloatTimeDomainData(data);
    for (let i = 0; i < fftSize; i++) {
      if (Math.abs(data[i]) < PA_LATENCY_THRESHOLD) continue;
      const sampleTime = windowEndsAt - (fftSize - i) / ctx.sampleRate;
      if (sampleTime >= playAt) { detectedAt = sampleTime; break; } // ignore anything before the click even played (existing input noise/signal)
    }
    if (detectedAt !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  if (detectedAt === null) {
    resultEl.textContent = "No loopback detected — make sure your interface's output is physically " +
      "connected to its input (or its direct-monitor path is engaged), then try again.";
    return;
  }
  const ms = (detectedAt - playAt) * 1000;
  resultEl.textContent = `Measured round-trip latency: ~${ms.toFixed(0)} ms (interface looped: direct-out → direct-in).`;
}

// ---------------------------------------------------------------------------
// NAM model + cab IR loading
// ---------------------------------------------------------------------------

async function paRefreshNamModels() {
  const r = await Api.get("/api/nam_models");
  PA.namModels = r.models;
  renderModelBrowser("nam");
}

async function paRefreshIrModels() {
  const r = await Api.get("/api/ir_models");
  PA.irModels = r.irs;
  renderModelBrowser("ir");
}

// ---------------------------------------------------------------------------
// NAM/IR folder browser — real libraries run to hundreds/thousands of files
// across nested pack subfolders (a real user's IR collection: 3065 files
// across 143 folders), so a flat <select> stopped being usable. One folder
// level at a time with a breadcrumb; a non-empty search box flattens to a
// filtered list across the whole library instead (a pure folder browser
// alone doesn't scale to "which of 3000 files was that IR again").
// ---------------------------------------------------------------------------

const modelBrowserState = {
  nam: { folder: "", search: "", selected: null },
  ir: { folder: "", search: "", selected: null },
};

function paModelsFor(prefix) {
  return prefix === "nam" ? PA.namModels : PA.irModels;
}

function paHighlightBrowserSelection(prefix, filename) {
  modelBrowserState[prefix].selected = filename;
  renderModelBrowser(prefix);
}

function renderModelBrowser(prefix) {
  const state = modelBrowserState[prefix];
  // Defensive: a stale cached /api/nam_models or /api/ir_models response
  // (from before this feature shipped) wouldn't carry a folder field at
  // all — normalize rather than throw and dead-end the whole panel on it.
  const models = paModelsFor(prefix).map((m) => ({ ...m, folder: m.folder || "" }));
  const listEl = document.getElementById(`pa-${prefix}-list`);
  const breadcrumbEl = document.getElementById(`pa-${prefix}-breadcrumb`);
  const icon = prefix === "nam" ? "🎸" : "🔊";
  listEl.innerHTML = "";
  breadcrumbEl.innerHTML = "";

  function makeFileRow(m, showFolder) {
    const row = document.createElement("div");
    row.className = "model-browser-row file" + (state.selected === m.filename ? " selected" : "");
    row.textContent = `${icon} ${m.name}` + (showFolder && m.folder ? `  —  ${m.folder}` : "");
    row.title = m.filename;
    row.addEventListener("click", () => {
      state.selected = m.filename;
      renderModelBrowser(prefix);
      if (prefix === "nam") {
        paLoadNamModel(m.filename);
      } else {
        paLoadIr(m.filename);
        // Bypass defaults on (IR off) — picking one is a clear signal to
        // hear it. Without this, "picking an IR doesn't change the tone"
        // is just Bypass still being checked.
        const bypassEl = document.getElementById("pa-ir-bypass");
        if (bypassEl.checked) {
          bypassEl.checked = false;
          bypassEl.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    });
    return row;
  }

  const query = state.search.trim().toLowerCase();
  if (query) {
    const matches = models.filter((m) =>
      m.name.toLowerCase().includes(query) || m.folder.toLowerCase().includes(query));
    breadcrumbEl.textContent = `${matches.length} result${matches.length === 1 ? "" : "s"} for "${state.search.trim()}"`;
    for (const m of matches) listEl.appendChild(makeFileRow(m, true));
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "model-browser-row empty";
      empty.textContent = "No matches.";
      listEl.appendChild(empty);
    }
    return;
  }

  // Breadcrumb: root label + one clickable crumb per path segment.
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = prefix === "nam" ? "All models" : "All IRs";
  rootCrumb.addEventListener("click", () => { state.folder = ""; renderModelBrowser(prefix); });
  breadcrumbEl.appendChild(rootCrumb);
  const segments = state.folder ? state.folder.split("/") : [];
  let accum = "";
  for (const seg of segments) {
    accum = accum ? `${accum}/${seg}` : seg;
    breadcrumbEl.appendChild(document.createTextNode("  /  "));
    const crumb = document.createElement("span");
    crumb.className = "crumb";
    crumb.textContent = seg;
    const target = accum;
    crumb.addEventListener("click", () => { state.folder = target; renderModelBrowser(prefix); });
    breadcrumbEl.appendChild(crumb);
  }

  // Immediate child folders and files of the current folder.
  const childFolders = new Set();
  const childFiles = [];
  for (const m of models) {
    if (m.folder === state.folder) {
      childFiles.push(m);
    } else if (state.folder === "" || m.folder.startsWith(state.folder + "/")) {
      const rest = state.folder === "" ? m.folder : m.folder.slice(state.folder.length + 1);
      const firstSeg = rest.split("/")[0];
      if (firstSeg) childFolders.add(firstSeg);
    }
  }
  for (const folderName of [...childFolders].sort((a, b) => a.localeCompare(b))) {
    const row = document.createElement("div");
    row.className = "model-browser-row folder";
    row.textContent = "📁 " + folderName;
    row.addEventListener("click", () => {
      state.folder = state.folder ? `${state.folder}/${folderName}` : folderName;
      renderModelBrowser(prefix);
    });
    listEl.appendChild(row);
  }
  for (const m of childFiles) listEl.appendChild(makeFileRow(m, false));
  if (!childFolders.size && !childFiles.length) {
    const empty = document.createElement("div");
    empty.className = "model-browser-row empty";
    empty.textContent = "Empty folder.";
    listEl.appendChild(empty);
  }
}

function wireModelBrowser(prefix) {
  document.getElementById(`pa-${prefix}-search`).addEventListener("input", (e) => {
    modelBrowserState[prefix].search = e.target.value;
    renderModelBrowser(prefix);
  });
}

// ---------------------------------------------------------------------------
// NAM/IR upload — real user ask: adding to the library shouldn't mean
// hand-copying files into models/nam or models/ir in Finder. One drop zone
// per library takes a single file, a whole folder (nested subfolders
// included — real packs often ship that way), or a .zip pack. The server
// (svc_nam_upload/svc_ir_upload) does the actual routing by extension; the
// client's job is just turning whatever got dropped/picked into a flat list
// of (File, relative path) pairs and uploading them one at a time.
// ---------------------------------------------------------------------------

// readEntries() only returns one batch at a time (spec-mandated, historically
// capped around 100) — has to be called repeatedly until it comes back empty
// to see everything in a large dropped folder.
function paReadAllDirEntries(dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    function readBatch() {
      dirReader.readEntries((entries) => {
        if (!entries.length) { resolve(all); return; }
        all.push(...entries);
        readBatch();
      }, reject);
    }
    readBatch();
  });
}

async function paWalkDroppedEntry(entry, relPrefix, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relPath: relPrefix + entry.name });
  } else if (entry.isDirectory) {
    const children = await paReadAllDirEntries(entry.createReader());
    for (const child of children) await paWalkDroppedEntry(child, relPrefix + entry.name + "/", out);
  }
}

// webkitGetAsEntry (Chrome/Safari/Edge) is what makes dropping a whole
// folder — not just loose files or a zip — work as one gesture; it's how a
// nested pack's subfolder structure gets preserved. Falls back to the flat
// file list (no folder support) on a browser without it, same graceful-
// degradation spirit as the rest of this app's drag/drop.
async function paCollectDroppedModelFiles(dataTransfer) {
  const out = [];
  const items = dataTransfer.items;
  if (items && items.length && items[0].webkitGetAsEntry) {
    for (const item of items) {
      const entry = item.webkitGetAsEntry();
      if (entry) await paWalkDroppedEntry(entry, "", out);
    }
  } else {
    for (const file of dataTransfer.files) out.push({ file, relPath: file.name });
  }
  return out;
}

async function paUploadModelFiles(prefix, entries, statusEl) {
  const endpoint = prefix === "nam" ? "/api/nam/upload" : "/api/ir/upload";
  let written = 0, skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const { file, relPath } = entries[i];
    statusEl.textContent = `Uploading ${i + 1} of ${entries.length}: ${relPath}…`;
    try {
      const buf = await file.arrayBuffer();
      // Same cloud-storage-placeholder check importFile (app.js) makes —
      // a NAM/IR library is exactly the kind of thing that lives in a
      // selectively-synced cloud folder. One bad file shouldn't sink an
      // entire folder/zip batch, so this counts as a skip, not an abort.
      if (buf.byteLength === 0 || buf.byteLength < file.size) {
        skipped++;
        continue;
      }
      const r = await Api.postRaw(`${endpoint}?filename=${encodeURIComponent(relPath)}`, buf);
      written += r.written != null ? r.written : 1;
      skipped += r.skipped || 0;
    } catch (e) {
      skipped++;
    }
  }
  const kind = prefix === "nam" ? ".nam" : ".wav";
  statusEl.textContent = `Added ${written} file${written === 1 ? "" : "s"}` +
    (skipped ? `, skipped ${skipped} (not a ${kind}/.zip file, empty, or failed to read).` : ".");
  if (prefix === "nam") await paRefreshNamModels(); else await paRefreshIrModels();
}

function wireModelUpload(prefix) {
  const dropEl = document.getElementById(`pa-${prefix}-drop`);
  const filesInput = document.getElementById(`pa-${prefix}-upload-files`);
  const folderInput = document.getElementById(`pa-${prefix}-upload-folder`);
  const statusEl = document.getElementById(`pa-${prefix}-upload-status`);

  document.getElementById(`pa-${prefix}-upload-files-link`).addEventListener("click", (e) => {
    e.preventDefault();
    filesInput.click();
  });
  document.getElementById(`pa-${prefix}-upload-folder-link`).addEventListener("click", (e) => {
    e.preventDefault();
    folderInput.click();
  });
  filesInput.addEventListener("change", (e) => {
    const entries = [...e.target.files].map((file) => ({ file, relPath: file.name }));
    filesInput.value = ""; // same file picked twice in a row must still fire "change"
    if (entries.length) paUploadModelFiles(prefix, entries, statusEl);
  });
  folderInput.addEventListener("change", (e) => {
    // webkitdirectory files carry webkitRelativePath ("PackName/sub/file.nam")
    const entries = [...e.target.files].map((file) => ({ file, relPath: file.webkitRelativePath || file.name }));
    folderInput.value = "";
    if (entries.length) paUploadModelFiles(prefix, entries, statusEl);
  });

  dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
  dropEl.addEventListener("dragleave", (e) => { if (!dropEl.contains(e.relatedTarget)) dropEl.classList.remove("dragover"); });
  dropEl.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const entries = await paCollectDroppedModelFiles(e.dataTransfer);
    if (entries.length) paUploadModelFiles(prefix, entries, statusEl);
  });
}

// Probe a model in a throwaway OfflineAudioContext before it goes anywhere
// near the live render thread: measure its output-level calibration gain
// (sync/blocking — the offline render thread can block freely) AND its
// inference speed. The speed check is what stops the "picking a NAM kills
// the guitar and the backing until reload" failure: a capture whose
// inference is slower than real time overruns every render quantum, and
// macOS kills the whole audio stream — silently, with an empty console
// (root-caused via gsDiag + per-model timing: standard-architecture
// captures measured 1.4-1.5x slower than real time on this machine before
// the block-processing rewrite, and still sit near 1.0x after it).
// Returns { outputGainDb: number|null, rtFactor: number|null }; nulls mean
// that part of the probe failed (the live node's fallbacks apply then).
const NAM_PROBE_SECONDS = 0.25;
// Thresholds are on the OFFLINE measurement, which runs ~10-15% slower
// than a performance core (normal-priority thread, likely an efficiency
// core) — the live render thread does a bit better than these numbers.
// That ~10-15% gap was measured on one specific dev machine and isn't
// universal (V3-E3) — a different Mac's offline thread could sit closer to,
// or further from, its live thread's speed. Rather than hand-tune this
// constant per machine, nam-processor.js backstops it: whichever model
// actually goes live gets its first ~100ms of real process() calls timed on
// the real render thread, and rolls itself back automatically if THIS
// machine isn't keeping up, regardless of what this offline number said —
// see LIVE_CHECK_WINDOW_MS/_startLiveCheck in nam-processor.js and
// paHandleNamLiveOverrun below. These thresholds still gate the offline
// probe as a fast first-pass filter (no reason to even try an obviously
// too-heavy capture), just no longer the last line of defense.
const NAM_REFUSE_RT_FACTOR = 0.9; // near-certain stream death — don't load
const NAM_WARN_RT_FACTOR = 0.7; // loads, but little headroom left for IR/effects

// V3-E6: the one place that posts a "load" message to a nam-processor node
// and waits for its one-shot "loaded" ack — paProbeNamModel, paLoadNamModel,
// and the Suggest loop each used to carry their own copy of this promise,
// and they'd drifted (the Suggest copy resolved `!!e.data.ok` instead of
// rejecting on failure like the other two, silently changing what "the load
// failed" meant to its caller). Resolves with the raw ack payload — callers
// decide what a failed load means to them, explicitly, instead of that
// decision living inside three near-identical promise bodies.
function awaitNamLoad(node, msg) {
  return new Promise((resolve) => {
    node.port.onmessage = (e) => {
      if (e.data.type !== "loaded") return;
      resolve(e.data);
    };
    node.port.postMessage(msg);
  });
}

// V3-E6: parameterized so the Suggest loop (paSuggestNamModel below) calls
// this instead of re-implementing the same offline-probe-plus-guardrail
// dance with its own OfflineAudioContext/node/wasm-module setup. opts.
// testSignal lets a caller supply its own render input (Suggest needs noise
// to score zero-crossing rate, not this probe's default sine) — the
// duration then comes from the signal itself rather than NAM_PROBE_SECONDS.
// opts.returnAudio hands back the rendered samples for that same scoring;
// the plain load-speed-check callers (paLoadNamModel) don't need them.
// A disposable same-origin realm for the tone search's throwaway probe
// contexts.
//
// Measured, not assumed: each probed capture needs its own
// OfflineAudioContext + AudioWorklet scope with a NAM model loaded into it,
// and Chromium never gives that scope back — ~15MB retained per capture,
// flat-linear, surviving forced GC. At the search's 500-capture default
// that is ~7GB, and at its 5000 cap ~72GB; the tab dies long before the
// run finishes. Isolating each layer showed the cost appears only once a
// model is actually loaded (bare contexts, addModule and even the WASM
// module send are all free), and that reloading models into ONE long-lived
// node — what the live rig does on every capture switch — does NOT leak,
// it plateaus. So the problem is specifically the per-probe throwaway
// scope, not model loading itself.
//
// Destroying the DOCUMENT that owns those scopes does reclaim them
// (measured completely flat across 40 probes, vs +600MB without), so the
// search builds its contexts here and bins the whole iframe periodically.
const NAM_PROBE_REALM_RECYCLE_EVERY = 25; // ~370MB peak before reclaim

function paProbeRealm() {
  let frame = null;
  let used = 0;
  return {
    // Returns a Window to build probe contexts in, recycling the iframe
    // once it has absorbed enough leaked scopes.
    async realm() {
      if (frame && used >= NAM_PROBE_REALM_RECYCLE_EVERY) this.dispose();
      if (!frame) {
        frame = document.createElement("iframe");
        frame.style.display = "none";
        frame.src = "probe-blank.html";
        document.body.appendChild(frame);
        await new Promise((resolve) => { frame.onload = resolve; });
        used = 0;
      }
      used++;
      return frame.contentWindow;
    },
    dispose() {
      if (frame) { frame.remove(); frame = null; }
      used = 0;
    },
  };
}

async function paProbeNamModel(namJson, opts = {}) {
  try {
    // Audio.ctx always exists by the time Play Along's load paths run, but
    // don't let a null ctx silently disable the probe.
    const sr = (typeof Audio !== "undefined" && Audio.ctx && Audio.ctx.sampleRate) || 48000;
    const len = opts.testSignal ? opts.testSignal.length : Math.floor(sr * NAM_PROBE_SECONDS);
    const durationSec = len / sr;
    // opts.realm lets a caller build this probe's throwaway context in a
    // DIFFERENT document (an iframe) so it can be reclaimed by destroying
    // that document — see paProbeRealm. Defaults to this window, which is
    // what the one-shot callers (paLoadNamModel's speed check) want: for a
    // single probe the retention is irrelevant, and staying in-realm keeps
    // that path completely unchanged.
    const realm = opts.realm || window;
    const offlineCtx = new realm.OfflineAudioContext(1, len, sr);
    await offlineCtx.audioWorklet.addModule("nam-processor.js");
    const node = new realm.AudioWorkletNode(offlineCtx, "nam-processor", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    // Probing the WASM engine's speed (not the JS fallback's) is the whole
    // point here — this is exactly the number that decides whether a real
    // capture clears NAM_REFUSE_RT_FACTOR — so wait for the module send
    // before posting "load", not fire-and-forget like the live node above.
    await paSendNamWasmModule(node);
    const ack = await awaitNamLoad(node, { type: "load", nam: namJson, sync: true });
    if (!ack.ok) throw new Error(ack.error);
    const gain = ack.outputGainDb;
    // Speed: time a real render through the loaded model. Calibration (if
    // any) already ran synchronously inside the load handler above, so
    // this times pure inference.
    const buf = offlineCtx.createBuffer(1, len, sr);
    if (opts.testSignal) {
      buf.getChannelData(0).set(opts.testSignal);
    } else {
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
    }
    const src = offlineCtx.createBufferSource();
    src.buffer = buf;
    src.connect(node).connect(offlineCtx.destination);
    src.start();
    const t0 = performance.now();
    const rendered = await offlineCtx.startRendering();
    const rtFactor = (performance.now() - t0) / (durationSec * 1000);
    return {
      outputGainDb: Number.isFinite(gain) ? gain : null,
      rtFactor,
      audio: opts.returnAudio ? rendered.getChannelData(0) : null,
    };
  } catch (e) {
    return { outputGainDb: null, rtFactor: null, audio: null };
  }
}

// ---------------------------------------------------------------------------
// gsDiag — console diagnostic for the NAM silence reports. Run `await gsDiag()`
// in the browser console immediately after the audio dies; the snapshot
// distinguishes the three failure classes:
//   - ctx.currentTime frozen + no pong        → render thread wedged / stream dead
//   - currentTime advancing + no pong          → namNode alone is dead
//   - pong + modelActive + silent output taps  → routing or math bug (NaN etc.)
// ---------------------------------------------------------------------------

// V3-E6: single ping helper for gsDiag — was two copies differing only in
// their timeout fallback value and whether they called port.start() first.
function gsDiagPingNam(timeoutMs, timeoutValue) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
    const onMsg = (e) => {
      if (e.data.type !== "pong") return;
      clearTimeout(timer);
      PA.namNode.port.removeEventListener("message", onMsg);
      resolve(e.data);
    };
    PA.namNode.port.addEventListener("message", onMsg);
    PA.namNode.port.postMessage({ type: "ping" });
  });
}

async function gsDiag() {
  const out = { when: new Date().toISOString() };
  const ctx = (typeof Audio !== "undefined") && Audio.ctx;
  if (!ctx) { out.ctx = "Audio.ctx is null — no audio graph exists"; return out; }

  out.ctx = { state: ctx.state, sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency };
  const t0 = ctx.currentTime;
  await new Promise((r) => setTimeout(r, 600));
  out.currentTimeAdvanced = +(ctx.currentTime - t0).toFixed(3); // ~0.6 expected; 0 = stream dead

  if (PA.namNode) {
    PA.namNode.port.start();
    out.namPong = await gsDiagPingNam(1000, "NO PONG within 1s — node/render thread not responding");
    // Second ping after a beat: framesProcessed should be HIGHER if the
    // node is actually being pulled by the render loop.
    if (out.namPong && out.namPong.framesProcessed !== undefined) {
      await new Promise((r) => setTimeout(r, 300));
      const again = await gsDiagPingNam(1000, null);
      out.namBeingPulled = again ? (again.framesProcessed > out.namPong.framesProcessed) : "no second pong";
    }
  } else {
    out.namPong = "PA.namNode is null — Play Along graph not built";
  }

  // Looper: "I recorded a loop but hear nothing" has several possible
  // causes that look identical from the outside — no loop committed, a
  // loop of the wrong length, the record tap muted (the tuner parks
  // outputMute at 0), or a stale saved loop restored into "stopped" so the
  // primary button resumes instead of records. Report all of them at once
  // rather than one at a time across a conversation.
  if (PA.looperNode) {
    const lenSec = PA.looperLengthFrames ? PA.looperLengthFrames / ctx.sampleRate : 0;
    out.looper = {
      state: PA.looperState,
      loopLengthSec: +lenSec.toFixed(2),
      bars: PA.looperBars,
      // 0 here means the looper is recording silence — the tuner mute and
      // a mid-switch preset fade both park this node at 0.
      recordTapGain: PA.outputMute ? PA.outputMute.gain.value : "no outputMute",
      playbackBusGain: PA.loopSum ? PA.loopSum.gain.value : "no loopSum",
      outputGain: PA.outputGain ? PA.outputGain.gain.value : "no outputGain",
      hint: PA.looperState === "stopped"
        ? "state is 'stopped' — the big button RESUMES this loop; press Clear first if you meant to record a new one"
        : (PA.looperState === "idle" ? "no loop committed yet" : ""),
    };
  } else {
    out.looper = "PA.looperNode is null — looper not built (open Tone Lab or Play Along once)";
  }

  // rmsOf is app.js's shared helper (V3-E6) — this used to be a local copy.
  // A single instantaneous reading can't distinguish "user wasn't playing"
  // from "signal not flowing" — watch all three taps for 5 seconds (the
  // user should be strumming, ideally with the backing track playing) and
  // report the peak RMS each tap saw plus a coarse timeline.
  console.log("gsDiag: watching levels for 5 seconds — PLAY YOUR GUITAR NOW (and hit Play on the backing if you can)…");
  const watch = { paInput: [], paOutput: [], master: [] };
  for (let i = 0; i < 50; i++) {
    watch.paInput.push(rmsOf(PA.inAnal));
    watch.paOutput.push(rmsOf(PA.outAnal));
    watch.master.push(rmsOf(Audio.analyser));
    await new Promise((r) => setTimeout(r, 100));
  }
  const summarize = (arr) => {
    const vals = arr.filter((v) => v !== null);
    if (!vals.length) return "no tap";
    const max = Math.max(...vals);
    // Sparkline: one char per 500ms, - silent / + quiet / # loud
    let line = "";
    for (let i = 0; i < vals.length; i += 5) {
      const m = Math.max(...vals.slice(i, i + 5));
      line += m > 0.02 ? "#" : (m > 0.002 ? "+" : "-");
    }
    return { maxRms: +max.toFixed(5), timeline: line };
  };
  out.levels5s = {
    paInput: summarize(watch.paInput), // live guitar as captured
    paOutput: summarize(watch.paOutput), // Play Along rig output
    master: summarize(watch.master), // mixer/backing output
  };
  // Where is the context actually rendering to?
  out.output = {
    outputLatency: ctx.outputLatency,
    sinkId: "sinkId" in ctx ? (ctx.sinkId === "" ? "(default device)" : ctx.sinkId) : "unsupported",
  };
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    out.outputDevices = devs.filter((d) => d.kind === "audiooutput").map((d) => d.label || d.deviceId);
  } catch (e) { out.outputDevices = "enumerate failed: " + e.message; }

  if (PA.stream) {
    out.inputTracks = PA.stream.getAudioTracks().map((t) => ({
      label: t.label, readyState: t.readyState, muted: t.muted, enabled: t.enabled,
    }));
  } else {
    out.inputTracks = "no input stream (guitar input not enabled)";
  }

  out.misc = {
    ampMode: PA.ampMode, namLoaded: PA.namLoaded || null,
    mixerPlaying: !!Audio.playing,
    namStatusText: (document.getElementById("pa-nam-status") || {}).textContent || "",
  };
  console.log("gsDiag:", JSON.stringify(out, null, 2));
  return out;
}
window.gsDiag = gsDiag;

// V3-T1: everything nam-processor.js actually supports is the standard
// (legacy-schema) non-parametric WaveNet architecture — see that file's own
// header for why. A rare "parametric"/"A2"/slimmable NAM family exists with
// real conditioning knobs, a different architecture our engine explicitly
// doesn't implement; this is a detection stub, not support — an honest
// message instead of either a confusing generic load failure or (worse)
// silently misinterpreting the file's weights.
// Architectures NOTHING here can render, so the picker can say so up front
// instead of spending a probe render to find out.
//
// This used to reject every non-"WaveNet" architecture. That's now wrong:
// the vendored official core handles NAM "A2" — which ships as
// `SlimmableContainer` — plus LSTM, so those go to the probe and load
// normally. Only genuinely unknown architectures fail fast here; the
// engines themselves remain the real authority (buildModelAny), this is
// purely a nicer error path.
const PA_RENDERABLE_NAM_ARCHITECTURES = new Set([
  "WaveNet",           // A1 (our engine) and A2's inner WaveNets (official core)
  "SlimmableContainer", // A2's own wrapper
  "LSTM", "Linear", "ConvNet", // legacy/other families the official core implements
]);
function paIsParametricNam(namJson) {
  return !!namJson.architecture && !PA_RENDERABLE_NAM_ARCHITECTURES.has(namJson.architecture);
}

// V3-T1: metadata surfaced for "what AM I playing through?" — enumerates
// whatever the .nam file's own metadata object actually carries (real
// captures overwhelmingly carry little to none of it, per nam-processor.js's
// own calibration comment, so this degrades honestly rather than assuming
// specific fields exist) plus what this app itself knows: architecture,
// measured realtime cost from the probe, and an ESR pulled from the filename
// if one's embedded there (no standard metadata field for it).
function paDescribeNamMetadata(namJson, filename, probe) {
  const meta = namJson.metadata || {};
  const lines = [];
  for (const k of Object.keys(meta)) {
    if (k === "loudness" || meta[k] === null || meta[k] === undefined || meta[k] === "") continue;
    lines.push(`${escapeHtml(k)}: ${escapeHtml(String(meta[k]))}`);
  }
  if (!lines.length) lines.push("No metadata fields in this capture's .nam file.");
  lines.push(`Architecture: ${escapeHtml(namJson.architecture || "unknown")}` +
    (probe && probe.rtFactor !== null ? ` — ~${Math.round(probe.rtFactor * 100)}% of this machine's audio budget` : ""));
  lines.push(typeof meta.loudness === "number"
    ? `Loudness: ${meta.loudness.toFixed(1)} (used for auto-calibration instead of a test-tone measurement)`
    : "Loudness: not in metadata — auto-calibration measured from a test tone instead");
  const esrMatch = /esr[_\s-]?([0-9.]+)/i.exec(filename || "");
  if (esrMatch) lines.push(`ESR (from filename): ${esrMatch[1]} — lower is a more faithful capture.`);
  return lines.join("<br>");
}

// ---------------------------------------------------------------------------
// Preset-switch latency (measured, real .nam captures, this machine):
//   fetch + JSON.parse the .nam ...........  ~40 ms
//   paProbeNamModel (offline probe) .......  ~600-780 ms   <-- the delay
//   live load into PA.namNode .............  ~440-630 ms
//   total paLoadNamModel ..................  ~1150 ms
// which is what makes a footswitch preset change feel sluggish: the mute in
// paApplyPresetWithFade has to stay down for the whole of it.
//
// Both of the first two are pure functions of (file contents, context sample
// rate) — the probe renders a fixed test tone through a throwaway
// OfflineAudioContext purely to measure this machine's speed and the
// capture's output level, and neither answer changes between two switches to
// the same preset. So they are cached per session, which takes a REPEAT
// switch down to just the live load, and paPrewarmPresetChain below does
// both steps in the background for the rest of the song's chain so even the
// FIRST switch to each preset skips them.
//
// The live load is not cached here: it builds the model inside the audio
// worklet, which is the actual point of loading it. Cutting that too would
// need the worklet to pre-build and hold several models at once (or a second
// standby node to swap between) — a much larger change to nam-processor.js's
// model lifecycle, deliberately left out of this pass.
//
// Bounded so a long session browsing many captures can't grow without limit;
// a song's chain is normally a handful of presets, well inside these caps.
const PA_NAM_JSON_CACHE_MAX = 12;   // ~300KB each for typical captures
const PA_IR_BUFFER_CACHE_MAX = 12;
const paNamJsonCache = new Map();
const paNamProbeCache = new Map();
const paIrBufferCache = new Map();

// Insertion-ordered Map + delete-oldest = a plain LRU-by-insertion bound.
// Re-setting an existing key deletes first so it counts as freshly used.
function paCachePut(cache, key, value, max) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) cache.delete(cache.keys().next().value);
}

async function paFetchNamJson(filename) {
  if (paNamJsonCache.has(filename)) return paNamJsonCache.get(filename);
  const json = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(filename)}`)).json();
  paCachePut(paNamJsonCache, filename, json, PA_NAM_JSON_CACHE_MAX);
  return json;
}

// Keyed on sample rate as well as filename: rtFactor is a speed measurement
// and outputGainDb a level measurement, both taken at the context's rate, so
// a device change mid-session must not reuse the old numbers.
async function paProbeNamModelCached(filename, namJson) {
  const rate = (typeof Audio !== "undefined" && Audio.ctx && Audio.ctx.sampleRate) || 0;
  const key = `${filename}@${rate}`;
  if (paNamProbeCache.has(key)) return paNamProbeCache.get(key);
  const probe = await paProbeNamModel(namJson);
  // A failed probe (all-null, see paProbeNamModel's catch) is not cached —
  // it may well have failed for a transient reason, and caching it would
  // make the failure permanent for the session.
  if (probe.rtFactor !== null) paCachePut(paNamProbeCache, key, probe, PA_NAM_JSON_CACHE_MAX);
  return probe;
}

// Fetch + probe a preset's NAM capture (and fetch its IR) WITHOUT touching
// the live rig, so a later switch to it finds both caches warm. Every step
// is best-effort: prewarming is an optimisation, and a failure here must
// leave the real load path to report the problem in its own words.
async function paPrewarmPreset(name) {
  try {
    const state = paRigPresets[name];
    if (!state) return;
    const namFile = state.neural && state.neural.namLoaded;
    if (namFile && !paNamProbeCache.has(`${namFile}@${(Audio.ctx && Audio.ctx.sampleRate) || 0}`)) {
      const namJson = await paFetchNamJson(namFile);
      if (!paIsParametricNam(namJson)) await paProbeNamModelCached(namFile, namJson);
    }
    const irFile = state.ir && state.ir.loaded;
    if (irFile && !paIrBufferCache.has(irFile)) await paFetchIrBuffer(irFile);
  } catch (e) { /* best-effort by design — see above */ }
}

// Warm every preset in this song's chain except the one already live.
// Sequential, not Promise.all: each probe renders audio and competes for the
// same machine the live rig is running on, so firing six at once would be a
// self-inflicted glitch. Kicked off without awaiting by its callers.
let paPrewarmInFlight = false;
async function paPrewarmPresetChain() {
  if (paPrewarmInFlight) return;
  paPrewarmInFlight = true;
  try {
    const chain = State.rigPresetChain || [];
    for (let i = 0; i < chain.length; i++) {
      if (i === State.rigPresetIndex) continue;
      await paPrewarmPreset(chain[i]);
    }
  } finally {
    paPrewarmInFlight = false;
  }
}

// N-1a: a .nam capture's WaveNet dilations are defined in samples, not
// time — running it through a context at a different sample rate than it
// was captured/trained at silently stretches every time constant by the
// rate ratio (detunes the model) with no audible "error" to flag it by
// itself. Neither engine resamples to correct for this (see the audio
// engine review), so the honest fix for now is telling the user, not
// pretending it's fine.
const NAM_SAMPLE_RATE_WARN_TOLERANCE = 0.001; // 0.1%
function paCheckNamSampleRate(namJson) {
  const modelRate = namJson && typeof namJson.sample_rate === "number" ? namJson.sample_rate : null;
  const ctxRate = (typeof Audio !== "undefined" && Audio.ctx && Audio.ctx.sampleRate) || null;
  if (!modelRate || !ctxRate) return "";
  if (Math.abs(modelRate - ctxRate) / ctxRate <= NAM_SAMPLE_RATE_WARN_TOLERANCE) return "";
  const fmt = (hz) => (hz % 1000 === 0 ? `${hz / 1000} kHz` : `${(hz / 1000).toFixed(1)} kHz`);
  return `⚠️ This capture was made at ${fmt(modelRate)} but your audio device is running at ` +
    `${fmt(ctxRate)} — it will not sound exactly as captured (times/pitch inside the model shift ` +
    `with the rate mismatch). Set your audio interface to ${fmt(modelRate)} for a faithful result.`;
}

// N-2: a "full-rig" capture already has its own cab (and often room/mic) baked
// in — stacking the Cab IR section on top double-filters it (dull, woolly).
// An amp-only capture has no cab and wants one. This is advice only, never an
// auto-toggle, matching the app's existing honesty-hint style elsewhere.
function paNamGearIrNote(namJson) {
  const gearType = String((namJson && namJson.metadata && namJson.metadata.gear_type) || "").toLowerCase();
  if (!gearType) return "";
  if (gearType.includes("full") || gearType.includes("rig")) {
    return "This capture is a full rig (amp + cab) — an IR on top will usually sound too dark. Try Bypass on the Cab IR above first.";
  }
  if (gearType.includes("amp") && !gearType.includes("cab")) {
    return "This capture is amp-only — pairing it with a Cab IR below usually sounds more finished.";
  }
  return "";
}

async function paLoadNamModel(filename) {
  const statusEl = document.getElementById("pa-nam-status");
  const srWarnEl = document.getElementById("pa-nam-samplerate-warn");
  const parametricEl = document.getElementById("pa-nam-parametric-hint");
  const metaEl = document.getElementById("pa-nam-meta");
  const autolevelEl = document.getElementById("pa-nam-autolevel");
  const gearNoteEl = document.getElementById("pa-ir-gear-note");
  if (!filename) {
    statusEl.textContent = ""; parametricEl.textContent = ""; metaEl.innerHTML = ""; autolevelEl.textContent = "";
    if (srWarnEl) srWarnEl.textContent = "";
    if (gearNoteEl) gearNoteEl.textContent = "";
    return;
  }
  parametricEl.textContent = "";
  if (srWarnEl) srWarnEl.textContent = "";
  if (gearNoteEl) gearNoteEl.textContent = "";
  statusEl.textContent = "Loading (checking speed)…";
  try {
    const namJson = await paFetchNamJson(filename);
    if (srWarnEl) srWarnEl.textContent = paCheckNamSampleRate(namJson);
    if (gearNoteEl) gearNoteEl.textContent = paNamGearIrNote(namJson);
    if (paIsParametricNam(namJson)) {
      // Fail fast on the main thread rather than spend a probe render only
      // to have the worklet throw "Unsupported architecture" back at us.
      statusEl.textContent = "";
      parametricEl.textContent = `This is a parametric capture ("${namJson.architecture}" architecture, ` +
        `not standard WaveNet) — not yet supported. Ordinary shared captures use the standard architecture ` +
        `and will load normally.`;
      metaEl.innerHTML = paDescribeNamMetadata(namJson, filename, null);
      autolevelEl.textContent = "";
      return;
    }
    const probe = await paProbeNamModelCached(filename, namJson);
    if (probe.rtFactor !== null && probe.rtFactor >= NAM_REFUSE_RT_FACTOR) {
      // Loading this would take down the whole audio stream (the exact
      // "picking a NAM cuts everything until reload" bug) — refuse, and
      // say why in plain terms.
      statusEl.textContent = `Not loaded: this capture needs ~${Math.round(probe.rtFactor * 100)}% ` +
        `of this machine's audio budget — it can't run live and would cut ALL sound. ` +
        `Look for a "Lite" or "Feather" version of the same amp instead.`;
      return;
    }
    const msg = { type: "load", nam: namJson };
    if (probe.outputGainDb !== null) msg.outputGainDb = probe.outputGainDb;
    const ack = await awaitNamLoad(PA.namNode, msg);
    if (!ack.ok) throw new Error(ack.error);
    // V3-E3: what the live-overrun rollback (paHandleNamLiveOverrun) reverts
    // the picker's UI to if this load turns out to overrun the real render
    // thread despite passing the offline probe above.
    PA.namLoadedPrev = PA.namLoaded;
    PA.namLoaded = filename;
    metaEl.innerHTML = paDescribeNamMetadata(namJson, filename, probe);
    // V3-T1: this was applied invisibly before (baked into
    // nam-processor.js's modelOutputGainDb, added under the Output level
    // slider with no indication it existed) — surfacing it is the whole
    // point of "shown and adjustable rather than invisible". The slider
    // itself is still the adjustable part, on top of this baked-in number.
    autolevelEl.textContent = probe.outputGainDb !== null
      ? `Auto-calibrated capture level: ${probe.outputGainDb.toFixed(1)} dB (baked in — the Output level slider above adds on top of this).`
      : "No auto-calibration for this capture (this .nam's own loudness metadata was used instead, or none was available).";
    statusEl.textContent = `Loaded: ${filename}` +
      (probe.rtFactor !== null && probe.rtFactor >= NAM_WARN_RT_FACTOR
        ? ` — ⚠️ heavy capture (~${Math.round(probe.rtFactor * 100)}% of audio budget); expect crackles if you add an IR or effects.`
        : "");
  } catch (e) {
    statusEl.textContent = "Failed to load: " + e.message;
  }
}

// V3-E3: the offline probe in paLoadNamModel is an estimate — it runs on a
// different thread than the one that renders live audio, so it can still be
// wrong for a given machine. nam-processor.js backstops that estimate by
// timing the first ~100ms of real process() calls after a model goes live
// and rolling back on its own if this specific machine's render thread isn't
// keeping up (see LIVE_CHECK_WINDOW_MS in nam-processor.js). This just
// brings the picker UI and status text in line with what the audio side
// already did.
function paHandleNamLiveOverrun(rtFactor) {
  const statusEl = document.getElementById("pa-nam-status");
  const prev = PA.namLoadedPrev;
  const pct = Math.round(rtFactor * 100);
  PA.namLoaded = prev || null;
  statusEl.textContent = prev
    ? `Reverted to "${prev}": the previous capture overran this machine's real audio budget ` +
      `(~${pct}% while actually playing) despite passing the initial speed check.`
    : `Unloaded: this capture overran this machine's real audio budget ` +
      `(~${pct}% while actually playing) despite passing the initial speed check.`;
  paHighlightBrowserSelection("nam", prev || null);
}

// Cab IR make-up gain: peak-normalize the loaded impulse to unity (instead
// of relying on ConvolverNode's own disabled auto-normalize — see
// ensurePAGraph) so a quiet/unnormalized IR file doesn't cut the overall
// volume once it's loaded. Clamped well short of what a broken/near-silent
// IR would otherwise demand (dividing by a near-zero peak) — a IR that
// quiet is almost certainly not a real IR, and boosting 20+ dB into it is
// far more likely to just amplify noise than to be the fix.
const IR_MAKEUP_GAIN_MAX = 6; // ~+15.6dB ceiling
function computeIrMakeupGain(buffer) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? Math.min(IR_MAKEUP_GAIN_MAX, 1 / peak) : 1;
}

// Fetch + decode an IR, caching the decoded AudioBuffer (see the
// preset-switch latency note above). AudioBuffers are immutable once
// decoded and ConvolverNode only reads them, so handing the same instance
// to a later load is safe — and it skips both the fetch and the decode.
async function paFetchIrBuffer(filename) {
  if (paIrBufferCache.has(filename)) return paIrBufferCache.get(filename);
  const resp = await fetch(`/api/ir_model_file?filename=${encodeURIComponent(filename)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const arrBuf = await resp.arrayBuffer();
  const buffer = await Audio.ctx.decodeAudioData(arrBuf);
  paCachePut(paIrBufferCache, filename, buffer, PA_IR_BUFFER_CACHE_MAX);
  return buffer;
}

// R-2: the review proposed truncating loaded IRs to ~100ms on the reasoning
// that "convolution CPU is proportional to length". Measured, that premise
// does not hold for ConvolverNode, which uses partitioned FFT convolution —
// cost grows far slower than length:
//
//   render 8s of audio through the convolver (this machine, 48kHz):
//     no convolver ............  13 ms
//     500ms IR ................ 110 ms
//     2s IR ................... 179 ms      <- 4x the length, 1.7x the cost
//     2s IR truncated to 100ms .  89 ms
//
// So even a pathological 2s IR costs ~2% of the real-time budget, and
// capping it to 100ms buys back only ~1% — against §1's stems at 45.8%, that
// is noise. Meanwhile truncation is NOT free tonally: measured in
// third-octave bands (single-frequency dB readings are useless here, they
// land on nulls and swing several dB for no audible reason), a 100ms cap
// costs ~0.65dB in the lowest band and a 50ms cap ~0.9-1.6dB — always in the
// low end, which is exactly the part of a cab IR players care about.
//
// Trading ~0.65dB of low end for ~1% of CPU is a bad deal for a guitar app,
// so the truncation is deliberately NOT implemented. What IS useful is
// telling the user what they actually loaded, since a suspiciously long file
// is usually a reverb impulse grabbed by mistake rather than a cab.
const PA_IR_LONG_MS = 1000;
function paDescribeIr(buffer) {
  if (!buffer) return "";
  const ms = Math.round(1000 * buffer.length / buffer.sampleRate);
  const rate = buffer.sampleRate >= 1000 ? `${(buffer.sampleRate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : `${buffer.sampleRate} Hz`;
  let s = ` — ${ms} ms, ${rate}`;
  if (ms > PA_IR_LONG_MS) {
    s += `. That's very long for a cab IR (cab impulses are usually under 500 ms) — if this is a reverb/room impulse it will sound washed out and costs more CPU than a cab IR needs.`;
  }
  return s;
}

async function paLoadIr(filename) {
  const statusEl = document.getElementById("pa-ir-status");
  if (!filename) {
    PA.convolver.buffer = null;
    PA.irMakeupGain.gain.value = 1;
    PA.irLoaded = null;
    statusEl.textContent = "";
    return;
  }
  statusEl.textContent = "Loading…";
  try {
    PA.convolver.buffer = await paFetchIrBuffer(filename);
    PA.irMakeupGain.gain.value = computeIrMakeupGain(PA.convolver.buffer);
    PA.irLoaded = filename; // GP-02: so a rig preset capture knows which IR is active
    statusEl.textContent = `Loaded: ${filename}` + paDescribeIr(PA.convolver.buffer);
  } catch (e) {
    // Previously unhandled — a failed fetch/decode silently left the old
    // (or no) IR buffer in place with zero feedback, indistinguishable
    // from "picking an IR doesn't change the tone."
    statusEl.textContent = "Failed to load: " + e.message;
  }
}

// ---------------------------------------------------------------------------
// Suggest closest tone (M3e) — a cheap, honestly-labeled heuristic, not a
// guaranteed match: zero-crossing rate as a brightness/noisiness proxy for
// the current track's isolated guitar stem, compared against each NAM
// model's own output when fed a short noise burst (rendered offline through
// the exact same nam-processor.js code, no separate reference computation).
// This is "Option A" from backing-track-tone-match-spec.md — spectral
// similarity against a library — implemented with the cheapest defensible
// descriptor rather than a full spectral envelope match, given no original
// algorithm survived to recover.
// ---------------------------------------------------------------------------

function zeroCrossingRate(data) {
  let crossings = 0;
  for (let i = 1; i < data.length; i++) {
    if ((data[i - 1] >= 0) !== (data[i] >= 0)) crossings++;
  }
  return crossings / data.length;
}

async function paTargetGuitarZcr() {
  // resolvedGuitarStemName() (app.js): a real "guitar" stem if one
  // exists, else an imported pack's user-designated stand-in (GP-16).
  const url = `/api/stem?source_path=${encodeURIComponent(State.track)}&model=${encodeURIComponent(State.model)}&stem=${encodeURIComponent(resolvedGuitarStemName())}`;
  const arrBuf = await (await fetch(url)).arrayBuffer();
  const buf = await Audio.ctx.decodeAudioData(arrBuf);
  const data = buf.getChannelData(0);
  const midStart = Math.max(0, Math.floor(data.length / 2 - Audio.ctx.sampleRate * 2.5));
  const excerpt = data.subarray(midStart, Math.min(data.length, midStart + Audio.ctx.sampleRate * 5));
  return zeroCrossingRate(excerpt);
}

async function paSuggestClosestModel() {
  if (PA.ampMode === "analog") return paSuggestAnalogMatch();
  return paSuggestNamModel();
}

// Widening this search: what actually costs the time, measured.
//
// The old cap of 30 was set against a pre-WASM JS WaveNet at ~740ms/model.
// Re-measured on the current dual-WASM engine, over 12 real captures:
//
//   fetch + parse .nam            7.9 ms/model
//   OfflineAudioContext + worklet
//     + WASM module send         13.5 ms/model
//   full probe (load + render)    348 ms/model
//
// So the engine change did NOT make this cheap. Nearly all of it is the
// model BUILD — uploading weights and constructing the WaveNet inside WASM
// — not inference, not setup, not I/O. Three things were tried against that
// and none of them helped:
//
//   - Reusing one context/node for every candidate: 426ms/model, no better
//     (setup was never the cost).
//   - Skipping the output-gain calibration: 361ms vs 360ms. No effect, and
//     ZCR is a sign-change count so a gain change couldn't move the score
//     anyway.
//   - Probing 4 or 8 at a time: 467ms and 497ms per model — actively WORSE.
//     The builds contend rather than overlap.
//
// At 348ms each, the cap is essentially a time budget: 100 candidates is
// ~35s, 500 is ~3 minutes. What makes any of it viable is that a model's
// brightness score does not depend on the track — it is the model's
// response to a fixed test signal — so it can be measured once and reused
// forever. The cache below makes the first wide run cost that budget and
// every later one effectively free, with only newly-added captures needing
// work. Measured on a 42-capture library: 13.8s cold, 386ms warm.
//
// That only holds if the test signal is identical between runs, so the
// noise is generated from a FIXED SEED rather than Math.random(). That also
// makes the ranking reproducible, which it previously wasn't — two runs
// over the same library could disagree.
const SUGGEST_SAMPLE_DEFAULT = 500;
const SUGGEST_SAMPLE_MAX = 5000;
const SUGGEST_TEST_SECONDS = 0.15; // enough samples for a stable ZCR reading
const SUGGEST_NOISE_SEED = 0x9e3779b9;
const SUGGEST_CACHE_KEY = "gs_nam_brightness_v1";
// Measured per-model probe cost, used only to show an ETA. A multi-minute
// run with a bare spinner is indistinguishable from a hung one.
//
// This is deliberately NOT the 350ms measured over a short run. Timed across
// a full 500-capture sweep the cost starts near 300ms and settles around
// 520-545ms — per 50-model block: 352, 279, 294, 462, 530, 516, 545ms, for
// ~240s over 500. The JS heap grows only 14MB to 53MB across the whole
// sweep, so this is not a leak; it is the accumulated per-probe
// OfflineAudioContext and worklet state the browser has not reclaimed yet.
// The rise flattens out rather than compounding, so the honest number to
// predict with is the whole-sweep average, not the fast opening blocks.
const SUGGEST_MS_PER_MODEL = 480;
// Flush the cache to storage every this many newly-measured captures. At a
// 500 cap the run is minutes long, and saving only at the end means closing
// the tab (or a crash) three minutes in throws away every measurement. The
// write is a few tens of KB and happens once per ~9s of work, so the cost
// is irrelevant next to what it protects.
const SUGGEST_CACHE_FLUSH_EVERY = 25;

// mulberry32 — small, fast, and deterministic across browsers, which
// Math.random() explicitly is not.
function paSeededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paSuggestTestSignal(sampleRate) {
  const rand = paSeededRandom(SUGGEST_NOISE_SEED);
  const sig = new Float32Array(Math.floor(sampleRate * SUGGEST_TEST_SECONDS));
  for (let i = 0; i < sig.length; i++) sig[i] = (rand() * 2 - 1) * 0.3;
  return sig;
}

// Cached scores are keyed by size as well as name: replacing a capture with
// a different one under the same filename is exactly the case a name-only
// key would silently get wrong. Sample rate is in the key because the probe
// renders at the context's rate and a NAM model's response is rate-dependent.
function paSuggestCacheKey(model, sampleRate) {
  return `${model.filename}|${model.size || 0}|${sampleRate}`;
}

// Settings-backed, so it survives a reload and is not per-browser like the
// score cache. PA.suggestSampleSize is filled in at startup from
// /api/settings; the default stands in until that lands (or if it fails).
function paSuggestSampleSize() {
  const n = Number(PA.suggestSampleSize);
  if (!Number.isFinite(n) || n < 1) return SUGGEST_SAMPLE_DEFAULT;
  return Math.min(SUGGEST_SAMPLE_MAX, Math.round(n));
}

function paSuggestEta(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min === 1 ? "a minute" : `${min} minutes`;
}

function paLoadSuggestCache() {
  try {
    return JSON.parse(localStorage.getItem(SUGGEST_CACHE_KEY) || "{}");
  } catch (e) { return {}; }
}

function paSaveSuggestCache(cache) {
  // Best-effort: a full or unavailable localStorage costs speed on the next
  // run, never correctness, so it must not break the suggestion itself.
  try { localStorage.setItem(SUGGEST_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* private mode / quota */ }
}

async function paSuggestNamModel() {
  const resultEl = document.getElementById("pa-suggest-result");
  resultEl.textContent = "Analyzing…";
  // A first run over an uncached library is ~35s of blocked UI (see the
  // measurements above), which needs the overlay; later runs lift it again
  // almost immediately, which is the point.
  const busy = gsBusy("Comparing captures against this track's guitar…");
  // Every probe below leaks its worklet scope; this is what reclaims them.
  // Disposed in the finally, so an early return / thrown error can't leave
  // the iframe (and the scopes it is holding) parked on the page.
  const probeRealm = paProbeRealm();
  try {
    const targetZcr = await paTargetGuitarZcr();
    if (!PA.namModels.length) await paRefreshNamModels();

    const all = PA.namModels;
    const sampleRate = Audio.ctx.sampleRate;
    const testSignal = paSuggestTestSignal(sampleRate);
    const cache = paLoadSuggestCache();

    // Coverage grows across runs rather than resampling the same slice.
    //
    // The budget is a limit on NEW measurements, not on candidates: anything
    // already scored is free, so every known capture is compared every time.
    // The budget then goes entirely to captures never measured before, taken
    // by striding through the unmeasured ones so each run still spans the
    // whole library instead of grinding through it alphabetically.
    //
    // On a 4600-capture library that means run 1 compares 500, run 2 compares
    // 1000, and so on, until eventually every capture is in the cache and
    // runs are instant. Previously every run re-sampled the same strided 500
    // and the other 4100 were never reachable at all.
    const known = [], fresh = [];
    for (const m of all) (cache[paSuggestCacheKey(m, sampleRate)] ? known : fresh).push(m);

    const budget = paSuggestSampleSize();
    const step = Math.max(1, Math.floor(fresh.length / budget));
    const picked = [];
    for (let i = 0; i < fresh.length && picked.length < budget; i += step) picked.push(fresh[i]);

    const candidates = known.concat(picked);
    // Known up front, so the very first progress line carries an honest ETA.
    const todo = picked.length;

    const scored = [];
    let tooHeavy = 0, measured = 0, reused = 0, unusable = 0;
    for (let ci = 0; ci < candidates.length; ci++) {
      const m = candidates[ci];
      const key = paSuggestCacheKey(m, sampleRate);
      let entry = cache[key];
      if (!entry) {
        // Only uncached captures cost anything, so both the progress text
        // and the ETA count the work actually left rather than the whole
        // candidate list — with a warm cache most of the list is free.
        const left = todo - measured;
        const eta = left > 1 ? ` — about ${paSuggestEta(left * SUGGEST_MS_PER_MODEL)} left` : "";
        const progress = `Analyzing… (${ci + 1}/${candidates.length}, measuring ${measured + 1} of ${todo} new)${eta}`;
        resultEl.textContent = progress;
        // The panel is behind the overlay, so the overlay has to carry it too.
        busy.setLabel(`Comparing capture ${measured + 1} of ${todo}${eta}`);
        let namJson = null;
        try {
          namJson = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(m.filename)}`)).json();
        } catch (e) {
          // A fetch or JSON error can be transient, so it is deliberately NOT
          // remembered — this capture simply gets another go next run.
          continue;
        }
        // V3-E6: was its own from-scratch OfflineAudioContext/node/wasm-
        // module/load dance, duplicating paProbeNamModel's — reuse it with
        // this loop's own noise test signal (paProbeNamModel's default is a
        // sine, no good for a zero-crossing-rate brightness proxy) and ask
        // for the rendered audio back to score.
        const probe = await paProbeNamModel(namJson, {
          testSignal, returnAudio: true, realm: await probeRealm.realm(),
        });
        measured++;  // the attempt cost the time either way, so it spends budget
        if (probe.rtFactor === null) {
          // Failed to build/load/render. Unlike a fetch error this is a
          // property of the file, so remember it: otherwise a corrupt or
          // unsupported capture is retried on EVERY run, permanently eating a
          // slot in the budget and stopping coverage from ever advancing past
          // it. The cache key includes file size, so replacing the file with a
          // good one gets it retried automatically.
          entry = { bad: true };
        } else {
          entry = { zcr: zeroCrossingRate(probe.audio), rt: probe.rtFactor };
        }
        cache[key] = entry;
        // Checkpoint, so a run abandoned partway (tab closed, browser
        // killed) keeps everything measured up to that point instead of
        // starting the next run from nothing.
        if (measured % SUGGEST_CACHE_FLUSH_EVERY === 0) paSaveSuggestCache(cache);
      } else {
        reused++;
      }
      if (entry.bad) { unusable++; continue; }
      // Same speed guardrail as paLoadNamModel: never suggest a capture that
      // can't run live — it would be refused at load anyway. Applied to
      // cached entries too, since rt is a property of this machine and the
      // cache is only ever read on the machine that wrote it.
      if (entry.rt >= NAM_REFUSE_RT_FACTOR) { tooHeavy++; continue; }
      scored.push({ name: m.name, filename: m.filename, distance: Math.abs(entry.zcr - targetZcr) });
    }
    paSaveSuggestCache(cache);

    scored.sort((a, b) => a.distance - b.distance);
    if (!scored.length) {
      resultEl.textContent = tooHeavy
        ? `No usable models found — all ${tooHeavy} sampled candidates are too heavy to run live on this machine. Try searching for "lite" or "feather" captures.`
        : "No models available to compare.";
      return;
    }

    const best = scored[0];
    const heavyNote = tooHeavy ? ` ${tooHeavy} capture${tooHeavy === 1 ? " was" : "s were"} skipped as too heavy to run live.` : "";
    const badNote = unusable ? ` ${unusable} could not be loaded at all and won't be retried.` : "";
    // Coverage is the number that matters now, not "sampled N": it tells you
    // whether running again would widen the search or is already exhaustive.
    const remaining = all.length - candidates.length;
    const coverageNote = ` Compared ${candidates.length} of ${all.length} captures` +
      (remaining > 0
        ? `; run this again to measure ${Math.min(remaining, paSuggestSampleSize())} more.`
        : " — the whole library.");
    // Say when scores were reused: a run that finishes instantly after one
    // that took minutes otherwise looks like it silently did nothing.
    const cacheNote = reused
      ? ` ${reused} score${reused === 1 ? " was" : "s were"} reused from a previous run${measured ? `, ${measured} newly measured` : ""}.`
      : "";
    // Ranking only lists the leaders — hundreds of names is a wall of text,
    // and everything past the first handful is noise against a proxy this
    // rough.
    const TOP_N = 8;
    const top = scored.slice(0, TOP_N);
    resultEl.innerHTML = `Closest match: <b>${escapeHtml(best.name)}</b>, now loaded and live ` +
      `(brightness-proxy match, not a guaranteed tone match — audition and pick by ear).` +
      `${coverageNote}${heavyNote}${badNote}${cacheNote}<br>` +
      `Top ${top.length}: ${top.map((s) => escapeHtml(s.name)).join(" → ")}` +
      (scored.length > top.length ? ` … and ${scored.length - top.length} more compared.` : "");
    await paLoadNamModel(best.filename);
    paHighlightBrowserSelection("nam", best.filename);
    setAmpMode("neural");
  } catch (e) {
    resultEl.textContent = "Could not analyze: " + e.message;
  } finally {
    probeRealm.dispose();
    busy();
  }
}

async function paSuggestAnalogMatch() {
  const resultEl = document.getElementById("pa-suggest-result");
  resultEl.textContent = "Analyzing…";
  try {
    const zcr = await paTargetGuitarZcr();
    // Rough heuristic: a brighter source (higher ZCR) gets less added treble
    // (avoid stacking harshness), a darker source gets a bit more, to land
    // near a similar overall brightness — not a real tone match, just a
    // starting point to dial in from by ear.
    const treble = Math.max(-6, Math.min(6, (0.12 - zcr) * 60));
    const bass = Math.max(-6, Math.min(6, (zcr - 0.12) * 40));
    document.getElementById("pa-treble").value = treble.toFixed(0);
    document.getElementById("pa-bass").value = bass.toFixed(0);
    document.getElementById("pa-treble").dispatchEvent(new Event("input"));
    document.getElementById("pa-bass").dispatchEvent(new Event("input"));
    resultEl.textContent = `Brightness-proxy suggestion applied (treble ${treble.toFixed(0)}dB, ` +
      `bass ${bass.toFixed(0)}dB) — a rough starting point, dial in by ear.`;
  } catch (e) {
    resultEl.textContent = "Could not analyze: " + e.message;
  }
}

function paUpdateSuggestVisibility() {
  // resolvedGuitarStemName() (app.js) also covers an imported pack's
  // user-designated guitar stand-in (GP-16), not just a real "guitar" stem.
  const hasGuitar = typeof State !== "undefined" && State.stems && !!resolvedGuitarStemName();
  // The button used to just vanish with no guitar stem — silent enough
  // that a real user report ("I can't see the suggest button at all")
  // turned out to be exactly this, not a bug: their song was separated
  // with a 4-stem model. An always-visible reason beats a mystery gap.
  document.getElementById("pa-suggest-btn").style.display = hasGuitar ? "block" : "none";
  document.getElementById("pa-suggest-unavailable-hint").style.display = hasGuitar ? "none" : "block";
  // The budget only means anything next to the button it governs.
  document.getElementById("pa-suggest-budget-row").style.display = hasGuitar ? "flex" : "none";
  document.getElementById("pa-suggest-sample-hint").style.display = hasGuitar ? "block" : "none";
  paRenderSuggestSampleHint();
}

// Spell out what the current budget costs and how far it reaches, since
// "500" on its own says nothing about a four-minute wait.
function paRenderSuggestSampleHint() {
  const el = document.getElementById("pa-suggest-sample-hint");
  if (!el) return;
  const n = paSuggestSampleSize();
  const total = (PA.namModels || []).length;
  const mins = (n * SUGGEST_MS_PER_MODEL) / 60000;
  const cost = mins < 1 ? `${Math.round((n * SUGGEST_MS_PER_MODEL) / 1000)}s` :
    (mins < 1.5 ? "about a minute" : `about ${Math.round(mins)} minutes`);
  el.textContent = `Captures already scored are compared for free every run, so this is the budget for NEW ones ` +
    `— roughly ${cost} of measuring at ~${SUGGEST_MS_PER_MODEL}ms each` +
    (total ? `, out of ${total} in your library. Run it again to reach further in.` : ".");
}

async function paSaveSuggestSampleSize(n) {
  PA.suggestSampleSize = n;
  paRenderSuggestSampleHint();
  try {
    await Api.post("/api/settings/nam_suggest_sample", { size: n });
  } catch (e) { /* the run still honours it this session; it just won't persist */ }
}

function wireSuggestSampleSize() {
  const input = document.getElementById("pa-suggest-sample");
  if (!input) return;
  input.addEventListener("change", () => {
    const n = Math.min(SUGGEST_SAMPLE_MAX, Math.max(1, Math.round(Number(input.value) || SUGGEST_SAMPLE_DEFAULT)));
    input.value = String(n);
    paSaveSuggestSampleSize(n);
  });
}

// ---------------------------------------------------------------------------
// Screen open/close + control wiring
//
// Split into Tone Lab (rig setup: input, amp/IR/pedals) and Play Along
// (practice/record with a rig you've already built) — both need the same
// underlying rig session (audio graph, rig presets, riff capture) ready
// regardless of which one is opened first, so that bootstrap is factored
// into paEnsureRigSessionReady() and called from both. Tone-Lab-only
// refreshes (device list, NAM/IR browsers, Suggest button) stay exclusive
// to openToneLab().
// ---------------------------------------------------------------------------

async function paEnsureRigSessionReady() {
  await ensurePAGraph();
  await paRefreshRigPresets();
  await paApplyAttachedRigPreset(); // GP-02/GP-14 — no-op if this track's chain is empty, or it's already been applied
  // Unconditional (unlike the line above): a track switch while Tone Lab
  // stayed open needs the chain list to reflect the NEW track's chain (or
  // its absence) even when there's nothing to auto-apply.
  renderPresetChainList();
  await ensureRiffCapture(); // GP-07 — starts rolling as soon as the rig exists; no-op if already running
  await ensureLooper(); // GP-06 — no-op if already running
  await paLoadSavedLoop(); // no-op if already loaded for this track, or nothing saved
  // Not awaited: opening a screen shouldn't wait on this, and by the time
  // the first footswitch press arrives the chain is usually already warm.
  paPrewarmPresetChain();
}

// Toggles which of the 4 persistent-screen nav buttons reads as "current,"
// and keeps the centered title-bar label (#top-banner-screen-label) in
// sync with it. Help is deliberately excluded from both — it's a
// transient modal, not a screen.
const PA_SCREEN_LABELS = {
  "mixer-open-btn": "Mixer",
  "tonelab-open-btn": "Tone Lab",
  "playalong-open-btn": "Play Along",
  "ailab-open-btn": "AI Lab", // V9 direct feedback: reverted the "Coach" rename in the title bar (kept elsewhere — violet theming, "Assistant" tab label)
  "tabview-open-btn": "Guitar Pro Tab View", // direct feedback: clarifies what the rail's "G" monogram stands for
};
function paSetActiveScreen(id) {
  document.querySelectorAll(".nav-screen-row .nav-screen-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.id === id);
  });
  document.getElementById("top-banner-screen-label").textContent = PA_SCREEN_LABELS[id] || "";
  // V9: Songs/Tabs drawer filter chips reflect which screen (and therefore
  // which of song-library-panel/tab-library-panel) is actually showing —
  // no separate state of their own, just a read of the same fact
  // paSetActiveScreen already knows.
  const isTabs = id === "tabview-open-btn";
  document.getElementById("drawer-filter-songs").classList.toggle("on", !isTabs);
  document.getElementById("drawer-filter-tabs").classList.toggle("on", isTabs);
}

// Code-review finding: MIDI access used to be requested unconditionally at
// page load (wireMidiControls), prompting every user on every session
// whether or not they'd ever touch it. Lazy + once-per-session instead —
// first real Tone Lab open, same "explicit action" gating camera/mic/output
// device already get elsewhere in this app.
let midiDevicesRequested = false;

async function openToneLab() {
  await paEnsureRigSessionReady();
  document.getElementById("tonelab-overlay").classList.add("show");
  document.getElementById("playalong-overlay").classList.remove("show");
  if (typeof closeAiLab === "function") closeAiLab();
  if (typeof closeTabView === "function") closeTabView();
  paRefreshDevices();
  paRefreshOutputDevices();
  paRefreshNamModels();
  paRefreshIrModels();
  if (!midiDevicesRequested) {
    midiDevicesRequested = true;
    paRefreshMidiDevices();
  }
  paUpdateSuggestVisibility();
  paSetActiveScreen("tonelab-open-btn");
}

function closeToneLab() {
  document.getElementById("tonelab-overlay").classList.remove("show");
}

async function openPlayAlong() {
  await paEnsureRigSessionReady();
  document.getElementById("playalong-overlay").classList.add("show");
  document.getElementById("tonelab-overlay").classList.remove("show");
  if (typeof closeAiLab === "function") closeAiLab();
  if (typeof closeTabView === "function") closeTabView();
  paSetActiveScreen("playalong-open-btn");
  // app.js only fetches the log on selectTrack — opening Play Along without
  // just having switched tracks (the common case: pick a song on the Mixer,
  // then open Play Along a beat later) would otherwise show whatever was
  // last fetched, which is nothing on a fresh page load.
  if (typeof refreshPracticeSessionLog === "function") refreshPracticeSessionLog();
}

function closePlayAlong() {
  document.getElementById("playalong-overlay").classList.remove("show");
}

// The "return to Mixer" action: Mixer isn't a real overlay, it's just
// whatever's visible once both of the above are closed. Also the one place
// selectTrack() (app.js) hooks into, so picking a track from the Library
// always drops back to the mixer regardless of which screen was open.
function closeAllScreens() {
  closeToneLab();
  closePlayAlong();
  if (typeof closeAiLab === "function") closeAiLab();
  if (typeof closeTabView === "function") closeTabView();
  paSetActiveScreen("mixer-open-btn");
}

function updateDelayWet() {
  const bypassed = document.getElementById("pa-delay-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-delay-mix").value) / 100;
  PA.delayWet.gain.value = bypassed ? 0 : mix;
}

function updateReverbWet() {
  const bypassed = document.getElementById("pa-reverb-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-reverb-mix").value) / 100;
  PA.reverbWet.gain.value = bypassed ? 0 : mix;
}

// v3.1: same wet-gain-only bypass idiom as updateDelayWet/updateReverbWet
// above, for the four new Mix-knob pedals (dry always flows through the
// merge node itself, per PA.pedalStages' inputs list for each).
function updateChorusWet() {
  const bypassed = document.getElementById("pa-chorus-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-chorus-mix").value) / 100;
  PA.chorusWetGain.gain.value = bypassed ? 0 : mix;
}
function updateFlangerWet() {
  const bypassed = document.getElementById("pa-flanger-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-flanger-mix").value) / 100;
  PA.flangerWetGain.gain.value = bypassed ? 0 : mix;
}
function updatePhaserWet() {
  const bypassed = document.getElementById("pa-phaser-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-phaser-mix").value) / 100;
  PA.phaserWetGain.gain.value = bypassed ? 0 : mix;
}
// A real crossfade (unlike Chorus/Flanger/Phaser's always-on-dry-plus-
// scaled-wet — see the comment on PA.wahDryGain in ensurePAGraph): dry
// fades out as wet fades in, so 100% mix is the swept bandpass alone,
// not the bandpass added on top of a still-full-volume dry signal.
function updateWahWet() {
  const bypassed = document.getElementById("pa-wah-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-wah-mix").value) / 100;
  PA.wahWetGain.gain.value = bypassed ? 0 : mix;
  PA.wahDryGain.gain.value = bypassed ? 1 : (1 - mix);
}

// CH-4: Manual Wah. Same crossfade contract as the Auto-Wah above.
function updateMwahWet() {
  const bypassed = document.getElementById("pa-mwah-bypass").checked;
  const mix = parseFloat(document.getElementById("pa-mwah-mix").value) / 100;
  PA.mwahWetGain.gain.value = bypassed ? 0 : mix;
  PA.mwahDryGain.gain.value = bypassed ? 1 : (1 - mix);
}

// Treadle position, 0 (heel, dark) to 1 (toe, bright). Called from the
// on-screen slider AND from every expression-pedal CC message, so it has to
// be cheap and it has to ramp rather than jump — see PA_MWAH_SMOOTHING_SEC.
function paSetMwahPosition(pos, fromMidi = false) {
  PA.mwahPosition = Math.max(0, Math.min(1, pos));
  if (!PA.mwahFilter) return;
  const heel = parseFloat(document.getElementById("pa-mwah-heel").value) || PA_MWAH_DEFAULT_HEEL_HZ;
  const toe = parseFloat(document.getElementById("pa-mwah-toe").value) || PA_MWAH_DEFAULT_TOE_HZ;
  // Logarithmic sweep — see the ensurePAGraph comment for why this isn't a
  // linear interpolation in Hz.
  const hz = heel * Math.pow(toe / heel, PA.mwahPosition);
  PA.mwahFilter.frequency.setTargetAtTime(hz, Audio.ctx.currentTime, PA_MWAH_SMOOTHING_SEC);
  paRenderMwahPosition(hz, fromMidi);
}

// The readout follows the pedal, but a swept expression pedal sends CCs far
// faster than the screen refreshes — writing the DOM per message would burn
// the main thread repainting frames nobody sees. Coalesce to one paint per
// animation frame; the audio above is never throttled, only the display.
let _mwahPaintQueued = false;
let _mwahPaintHz = 0;
function paRenderMwahPosition(hz, fromMidi) {
  _mwahPaintHz = hz;
  if (_mwahPaintQueued) return;
  _mwahPaintQueued = true;
  requestAnimationFrame(() => {
    _mwahPaintQueued = false;
    const val = document.getElementById("pa-mwah-pos-val");
    if (val) val.textContent = `${Math.round(PA.mwahPosition * 100)}% · ${Math.round(_mwahPaintHz)} Hz`;
    // Only drive the slider FROM MIDI. Writing .value while the user is
    // dragging that same slider fights their own drag.
    if (fromMidi) {
      const slider = document.getElementById("pa-mwah-pos");
      if (slider) slider.value = String(Math.round(PA.mwahPosition * 100));
    }
  });
}

// Tremolo has no Mix knob (pure in-place amplitude modulation) — bypass
// disconnects the LFO from the gain param entirely rather than zeroing a
// wet send, since there's no dry/wet split to begin with.
function updateTremoloBypass() {
  const bypassed = document.getElementById("pa-tremolo-bypass").checked;
  try { PA.tremoloDepthGain.disconnect(PA.tremoloGain.gain); } catch (e) { /* wasn't connected */ }
  if (bypassed) { PA.tremoloGain.gain.value = 1; }
  else { PA.tremoloDepthGain.connect(PA.tremoloGain.gain); updateTremoloDepthGain(); }
}

// PA.tremoloGain.gain's own value is the modulation's BASELINE, which the
// connected LFO signal adds to continuously — moving it with depth (not
// leaving it fixed at 1) is what makes full depth swing all the way down
// to silence (0) instead of just dipping to 0.5 regardless of the slider.
// gain(t) = (1 - depth/2) + (depth/2)*sin(t): at depth=0 that's a constant
// 1 (no effect); at depth=1 it swings the full [0, 1] range.
function updateTremoloDepthGain() {
  const depth = parseFloat(document.getElementById("pa-tremolo-depth").value) / 100;
  PA.tremoloDepthGain.gain.value = depth * 0.5;
  if (!document.getElementById("pa-tremolo-bypass").checked) {
    PA.tremoloGain.gain.value = 1 - depth * 0.5;
  }
}

function wirePAControls() {
  document.getElementById("mixer-open-btn").addEventListener("click", closeAllScreens);
  // V9: Songs/Tabs drawer filter chips are just another way to reach the
  // same two rail buttons — no separate navigation path to keep in sync.
  document.getElementById("drawer-filter-songs").addEventListener("click", () => document.getElementById("mixer-open-btn").click());
  document.getElementById("drawer-filter-tabs").addEventListener("click", () => document.getElementById("tabview-open-btn").click());
  document.getElementById("tonelab-open-btn").addEventListener("click", openToneLab);
  document.getElementById("playalong-open-btn").addEventListener("click", openPlayAlong);
  document.getElementById("pa-enable-btn").addEventListener("click", paEnableInput);
  // Picking a different device in the list did nothing on its own — input
  // stayed on whatever was live already (often the system default, since
  // device labels/values only populate after the *first* permission grant,
  // so the very first Enable click can't have targeted a specific device).
  // That's how you end up with two sources feeding in "at once": the
  // original stream never actually stopped, a second one just looked
  // selected. paEnableInput() already tears down the previous stream
  // before opening a new one, so re-running it on change is enough to
  // guarantee only one is ever live — but only if input was already
  // enabled, so just refreshing the (empty) device list on first open
  // doesn't itself trigger a permission prompt.
  document.getElementById("pa-device-select").addEventListener("change", () => {
    if (PA.stream) paEnableInput();
  });
  document.getElementById("pa-clip-clear-btn").addEventListener("click", () => {
    PA.inputClipped = false;
    updateClipIndicator();
  });
  document.getElementById("pa-calibrate-btn").addEventListener("click", paCalibrate);
  document.getElementById("pa-measure-latency-btn").addEventListener("click", paMeasureLatency);
  document.getElementById("pa-tuner-toggle").addEventListener("click", () => paSetTunerEnabled(!PA.tunerEnabled));
  paSetTunerEnabled(false); // sync button label/state with the PA.tunerEnabled default

  document.querySelectorAll("#pa-amp-modes button").forEach((btn) => {
    btn.addEventListener("click", () => setAmpMode(btn.dataset.mode));
  });

  document.getElementById("pa-gate-bypass").addEventListener("change", (e) => {
    PA.gateNode.parameters.get("bypass").value = e.target.checked ? 1 : 0;
  });
  const trimEl = document.getElementById("pa-input-trim");
  const trimValEl = document.getElementById("pa-input-trim-val");
  const paShowTrim = (db) => {
    trimValEl.textContent = (db > 0 ? "+" : "") + db.toFixed(1) + " dB";
  };
  // Reflect the stored value on load — this control persists per machine
  // (PA_INPUT_TRIM_KEY), so it must come back the way it was left even
  // though no rig preset carries it.
  trimEl.value = String(paLoadInputTrimDb());
  paShowTrim(paLoadInputTrimDb());
  trimEl.addEventListener("input", (e) => {
    const db = parseFloat(e.target.value);
    paSetInputTrimDb(db);
    paShowTrim(db);
  });
  // Double-click to get back to unity, same idiom as the mixer faders.
  trimEl.addEventListener("dblclick", () => {
    trimEl.value = "0";
    paSetInputTrimDb(0);
    paShowTrim(0);
  });

  document.getElementById("pa-gate-threshold").addEventListener("input", (e) => {
    PA.gateNode.parameters.get("thresholdDb").value = parseFloat(e.target.value);
    document.getElementById("pa-gate-threshold-val").textContent = e.target.value + " dB";
  });

  document.getElementById("pa-drive").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value) / 100;
    PA.analogNodes.shaper.curve = paMakeAmpClipCurve(v);
    document.getElementById("pa-drive-val").textContent = e.target.value + "%";
  });
  for (const [id, key, valId] of [["pa-bass", "bass", "pa-bass-val"], ["pa-mid", "mid", "pa-mid-val"], ["pa-treble", "treble", "pa-treble-val"]]) {
    document.getElementById(id).addEventListener("input", (e) => {
      PA.analogNodes[key].gain.value = parseFloat(e.target.value);
      document.getElementById(valId).textContent = e.target.value + " dB";
    });
  }

  wireModelBrowser("nam");
  wireModelUpload("nam");
  document.getElementById("pa-nam-in").addEventListener("input", (e) => {
    PA.namNode.parameters.get("inputGainDb").value = parseFloat(e.target.value);
    document.getElementById("pa-nam-in-val").textContent = e.target.value + " dB";
  });
  document.getElementById("pa-nam-out").addEventListener("input", (e) => {
    PA.namNode.parameters.get("outputGainDb").value = parseFloat(e.target.value);
    document.getElementById("pa-nam-out-val").textContent = e.target.value + " dB";
  });
  // V3-T1: post-NAM tone stack knobs — the "amp's tone stack" feel, flat by
  // default (matches paNamToneStack.bass/mid/treble/presence field naming
  // used by paCaptureRigState/paApplyRigState, GP-02).
  for (const [id, node, valId] of [
    ["pa-namtone-bass", "namToneBass", "pa-namtone-bass-val"],
    ["pa-namtone-mid", "namToneMid", "pa-namtone-mid-val"],
    ["pa-namtone-treble", "namToneTreble", "pa-namtone-treble-val"],
    ["pa-namtone-presence", "namTonePresence", "pa-namtone-presence-val"],
  ]) {
    document.getElementById(id).addEventListener("input", (e) => {
      PA[node].gain.value = parseFloat(e.target.value);
      document.getElementById(valId).textContent = e.target.value + " dB";
    });
  }
  document.getElementById("pa-suggest-btn").addEventListener("click", paSuggestClosestModel);

  wireModelBrowser("ir");
  wireModelUpload("ir");
  document.getElementById("pa-ir-bypass").addEventListener("change", (e) => {
    const bypassed = e.target.checked;
    PA.irDryGain.gain.value = bypassed ? 1 : 0;
    PA.irWetGain.gain.value = bypassed ? 0 : 1;
  });

  // v3.1 §2.3: IR tone shaper — bypass forces both filters wide open
  // (transparent) rather than removing them from the graph, same idiom as
  // the 3-band EQ card's own bypass (zero the gains instead of unwiring).
  document.getElementById("pa-ir-tone-bypass").addEventListener("change", (e) => {
    if (e.target.checked) {
      PA.irLowCut.frequency.value = 20;
      PA.irHighCut.frequency.value = 20000;
    } else {
      PA.irLowCut.frequency.value = parseFloat(document.getElementById("pa-ir-lowcut").value);
      PA.irHighCut.frequency.value = parseFloat(document.getElementById("pa-ir-highcut").value);
    }
  });
  document.getElementById("pa-ir-lowcut").addEventListener("input", (e) => {
    if (!document.getElementById("pa-ir-tone-bypass").checked) PA.irLowCut.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-ir-lowcut-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-ir-highcut").addEventListener("input", (e) => {
    if (!document.getElementById("pa-ir-tone-bypass").checked) PA.irHighCut.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-ir-highcut-val").textContent = e.target.value + " Hz";
  });

  document.getElementById("pa-eq-bypass").addEventListener("change", (e) => {
    if (e.target.checked) {
      PA.eqNodes.bass.gain.value = 0; PA.eqNodes.mid.gain.value = 0; PA.eqNodes.treble.gain.value = 0;
    } else {
      PA.eqNodes.bass.gain.value = parseFloat(document.getElementById("pa-eq-bass").value);
      PA.eqNodes.mid.gain.value = parseFloat(document.getElementById("pa-eq-mid").value);
      PA.eqNodes.treble.gain.value = parseFloat(document.getElementById("pa-eq-treble").value);
    }
  });
  for (const [id, key, valId] of [["pa-eq-bass", "bass", "pa-eq-bass-val"], ["pa-eq-mid", "mid", "pa-eq-mid-val"], ["pa-eq-treble", "treble", "pa-eq-treble-val"]]) {
    document.getElementById(id).addEventListener("input", (e) => {
      if (!document.getElementById("pa-eq-bypass").checked) PA.eqNodes[key].gain.value = parseFloat(e.target.value);
      document.getElementById(valId).textContent = e.target.value + " dB";
    });
  }

  document.getElementById("pa-comp-bypass").addEventListener("change", (e) => {
    const bypassed = e.target.checked;
    PA.compBypassDry.gain.value = bypassed ? 1 : 0;
    PA.compBypassWet.gain.value = bypassed ? 0 : 1;
  });
  document.getElementById("pa-comp-threshold").addEventListener("input", (e) => {
    PA.compressor.threshold.value = parseFloat(e.target.value);
    document.getElementById("pa-comp-threshold-val").textContent = e.target.value + " dB";
  });
  document.getElementById("pa-comp-ratio").addEventListener("input", (e) => {
    PA.compressor.ratio.value = parseFloat(e.target.value);
    document.getElementById("pa-comp-ratio-val").textContent = e.target.value + ":1";
  });

  document.getElementById("pa-delay-bypass").addEventListener("change", updateDelayWet);
  document.getElementById("pa-delay-mix").addEventListener("input", (e) => {
    document.getElementById("pa-delay-mix-val").textContent = e.target.value + "%";
    updateDelayWet();
  });
  document.getElementById("pa-delay-time").addEventListener("input", (e) => {
    PA.delayNode.delayTime.value = parseFloat(e.target.value) / 1000;
    document.getElementById("pa-delay-time-val").textContent = e.target.value + " ms";
  });
  document.getElementById("pa-delay-feedback").addEventListener("input", (e) => {
    PA.delayFeedback.gain.value = parseFloat(e.target.value) / 100;
    document.getElementById("pa-delay-feedback-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-reverb-bypass").addEventListener("change", updateReverbWet);
  document.getElementById("pa-reverb-mix").addEventListener("input", (e) => {
    document.getElementById("pa-reverb-mix-val").textContent = e.target.value + "%";
    updateReverbWet();
  });
  document.getElementById("pa-reverb-size").addEventListener("input", (e) => {
    PA.reverbConvolver.buffer = paMakeReverbImpulse(Audio.ctx, parseFloat(e.target.value), 2.5);
    document.getElementById("pa-reverb-size-val").textContent = e.target.value + " s";
  });

  // v3.1 §2.2: the eight new pedal cards' controls.

  document.getElementById("pa-boost-bypass").addEventListener("change", (e) => {
    const bypassed = e.target.checked;
    PA.boostDryGain.gain.value = bypassed ? 1 : 0;
    PA.boostWetGain.gain.value = bypassed ? 0 : 1;
  });
  document.getElementById("pa-boost-drive").addEventListener("input", (e) => {
    PA.boostShaper.curve = paMakeDistortionCurve(parseFloat(e.target.value) / 100);
    document.getElementById("pa-boost-drive-val").textContent = e.target.value + "%";
  });
  document.getElementById("pa-boost-level").addEventListener("input", (e) => {
    PA.boostLevel.gain.value = dbToLin(parseFloat(e.target.value));
    document.getElementById("pa-boost-level-val").textContent = e.target.value + " dB";
  });

  const geqFreqs = [100, 300, 1000, 3000, 8000];
  document.getElementById("pa-geq-bypass").addEventListener("change", (e) => {
    for (const freq of geqFreqs) {
      PA.geqNodes[freq].gain.value = e.target.checked ? 0 : parseFloat(document.getElementById("pa-geq-" + freq).value);
    }
  });
  for (const freq of geqFreqs) {
    document.getElementById("pa-geq-" + freq).addEventListener("input", (e) => {
      if (!document.getElementById("pa-geq-bypass").checked) PA.geqNodes[freq].gain.value = parseFloat(e.target.value);
      document.getElementById("pa-geq-" + freq + "-val").textContent = e.target.value + " dB";
    });
  }

  document.getElementById("pa-chorus-bypass").addEventListener("change", updateChorusWet);
  document.getElementById("pa-chorus-mix").addEventListener("input", (e) => {
    document.getElementById("pa-chorus-mix-val").textContent = e.target.value + "%";
    updateChorusWet();
  });
  document.getElementById("pa-chorus-rate").addEventListener("input", (e) => {
    PA.chorusLfo.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-chorus-rate-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-chorus-depth").addEventListener("input", (e) => {
    PA.chorusDepthGain.gain.value = (parseFloat(e.target.value) / 100) * 0.01;
    document.getElementById("pa-chorus-depth-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-flanger-bypass").addEventListener("change", updateFlangerWet);
  document.getElementById("pa-flanger-mix").addEventListener("input", (e) => {
    document.getElementById("pa-flanger-mix-val").textContent = e.target.value + "%";
    updateFlangerWet();
  });
  document.getElementById("pa-flanger-rate").addEventListener("input", (e) => {
    PA.flangerLfo.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-flanger-rate-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-flanger-depth").addEventListener("input", (e) => {
    PA.flangerDepthGain.gain.value = (parseFloat(e.target.value) / 100) * 0.004;
    document.getElementById("pa-flanger-depth-val").textContent = e.target.value + "%";
  });
  document.getElementById("pa-flanger-feedback").addEventListener("input", (e) => {
    PA.flangerFeedback.gain.value = parseFloat(e.target.value) / 100;
    document.getElementById("pa-flanger-feedback-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-phaser-bypass").addEventListener("change", updatePhaserWet);
  document.getElementById("pa-phaser-mix").addEventListener("input", (e) => {
    document.getElementById("pa-phaser-mix-val").textContent = e.target.value + "%";
    updatePhaserWet();
  });
  document.getElementById("pa-phaser-rate").addEventListener("input", (e) => {
    PA.phaserLfo.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-phaser-rate-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-phaser-depth").addEventListener("input", (e) => {
    PA.phaserDepthGain.gain.value = (parseFloat(e.target.value) / 100) * 1200;
    document.getElementById("pa-phaser-depth-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-tremolo-bypass").addEventListener("change", updateTremoloBypass);
  document.getElementById("pa-tremolo-rate").addEventListener("input", (e) => {
    PA.tremoloLfo.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-tremolo-rate-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-tremolo-depth").addEventListener("input", (e) => {
    updateTremoloDepthGain();
    document.getElementById("pa-tremolo-depth-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-wah-bypass").addEventListener("change", updateWahWet);
  document.getElementById("pa-wah-mix").addEventListener("input", (e) => {
    document.getElementById("pa-wah-mix-val").textContent = e.target.value + "%";
    updateWahWet();
  });
  document.getElementById("pa-wah-rate").addEventListener("input", (e) => {
    PA.wahLfo.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-wah-rate-val").textContent = e.target.value + " Hz";
  });
  document.getElementById("pa-wah-depth").addEventListener("input", (e) => {
    PA.wahDepthGain.gain.value = (parseFloat(e.target.value) / 100) * 600;
    document.getElementById("pa-wah-depth-val").textContent = e.target.value + "%";
  });
  document.getElementById("pa-wah-center").addEventListener("input", (e) => {
    PA.wahFilter.frequency.value = parseFloat(e.target.value);
    document.getElementById("pa-wah-center-val").textContent = e.target.value + " Hz";
  });

  // CH-4: Manual Wah. The Pedal slider and a bound expression pedal are two
  // routes into the same paSetMwahPosition, so they cannot disagree about
  // where the treadle is.
  document.getElementById("pa-mwah-bypass").addEventListener("change", updateMwahWet);
  document.getElementById("pa-mwah-mix").addEventListener("input", (e) => {
    document.getElementById("pa-mwah-mix-val").textContent = e.target.value + "%";
    updateMwahWet();
  });
  document.getElementById("pa-mwah-pos").addEventListener("input", (e) => {
    paSetMwahPosition(parseFloat(e.target.value) / 100);
  });
  document.getElementById("pa-mwah-q").addEventListener("input", (e) => {
    PA.mwahFilter.Q.value = parseFloat(e.target.value);
    document.getElementById("pa-mwah-q-val").textContent = parseFloat(e.target.value).toFixed(1);
  });
  // Moving either end of the range re-derives the current frequency from
  // the treadle's existing position, so the sweep rescales under your foot
  // instead of only taking effect on the next pedal movement.
  for (const [id, valId, unit] of [["pa-mwah-heel", "pa-mwah-heel-val", " Hz"], ["pa-mwah-toe", "pa-mwah-toe-val", " Hz"]]) {
    document.getElementById(id).addEventListener("input", (e) => {
      document.getElementById(valId).textContent = e.target.value + unit;
      paSetMwahPosition(PA.mwahPosition);
    });
  }

  document.getElementById("pa-octaver-bypass").addEventListener("change", (e) => {
    const bypassed = e.target.checked;
    const blend = parseFloat(document.getElementById("pa-octaver-blend").value) / 100;
    PA.octaverDryGain.gain.value = bypassed ? 1 : 1 - blend;
    PA.octaverWetGain.gain.value = bypassed ? 0 : blend;
  });
  document.getElementById("pa-octaver-blend").addEventListener("input", (e) => {
    const blend = parseFloat(e.target.value) / 100;
    if (!document.getElementById("pa-octaver-bypass").checked) {
      PA.octaverDryGain.gain.value = 1 - blend;
      PA.octaverWetGain.gain.value = blend;
    }
    document.getElementById("pa-octaver-blend-val").textContent = e.target.value + "%";
  });

  document.getElementById("pa-output-level").addEventListener("input", (e) => {
    document.getElementById("pa-output-val").textContent = e.target.value + " dB";
    // V3-E2: mute lives on PA.outputMute now, so this slider owns
    // PA.outputGain.gain outright regardless of tuner state — except while
    // bypassed, when the bypass handler below owns it instead (forced unity).
    if (!document.getElementById("pa-output-bypass").checked) {
      PA.outputGain.gain.value = dbToLin(parseFloat(e.target.value));
    }
  });
  document.getElementById("pa-output-bypass").addEventListener("change", (e) => {
    const level = parseFloat(document.getElementById("pa-output-level").value);
    PA.outputGain.gain.value = e.target.checked ? 1 : dbToLin(level);
  });
  document.getElementById("pa-output-device-select").addEventListener("change", (e) => {
    paApplyOutputDevice(e.target.value);
  });
}

function paShowLatencyEstimate() {
  const el = document.getElementById("pa-latency-hint");
  if (!Audio.ctx) { el.textContent = ""; return; }
  // baseLatency/outputLatency only describe the browser's own OUTPUT
  // buffering — Web Audio has no API to measure the INPUT side at all
  // (the interface's USB buffer, its driver, CoreAudio), which for an
  // external audio interface is typically the larger share of real
  // round-trip latency. So this number reading low (or even ~0, since
  // outputLatency is commonly unpopulated in Chrome until real playback
  // has actually rendered) is expected, not a sign anything's wrong —
  // it was never a full round-trip figure to begin with. Surfacing the
  // context's sample rate alongside it lets a user directly compare
  // against their interface's own configured rate: this app never
  // requests a specific rate (ensureCtx/paEnableInput both omit it), so
  // it just inherits whatever the OS default output device's rate was
  // when the context was first created — if that doesn't match the
  // interface, the browser silently resamples the input stream to
  // reconcile them, adding real latency this estimate can't see either.
  const est = ((Audio.ctx.baseLatency || 0) + (Audio.ctx.outputLatency || 0)) * 1000;
  const rateNote = `Context sample rate: ${Audio.ctx.sampleRate} Hz — check this matches your interface's own rate setting.`;
  el.textContent = est > 0
    ? `Estimated OUTPUT-side latency only: ~${est.toFixed(0)} ms (browser-reported, not a full round-trip measurement — ` +
      `excludes input/USB/driver latency entirely). ${rateNote}`
    : `Latency estimate unavailable in this browser. ${rateNote}`;
}

// ---------------------------------------------------------------------------
// v4.7 Tone Lab redesign (research/ui-review-and-tonelab-redesign.md §3):
// one icon chip per rig stage in #pa-chain-icons, built from the same
// PA.pedalOrder array the audio graph uses. Clicking an icon opens its
// full card below (#pa-pedalboard .pa-rig-card.pa-chain-open) — only one
// card is ever visible at a time, replacing the old always-all-expanded
// card stack and its per-card collapse state. Dragging a reorderable
// icon left/right rewrites PA.pedalOrder exactly the way dragging a full
// card used to (same paSavePedalOrder/rewirePedalChain call, just driven
// from the icon strip's DOM order instead of the card stack's).
// ---------------------------------------------------------------------------
const CHAIN_ICON_LABELS = {
  input: "Input", gate: "Gate", amp: "Amp", ir: "Cab IR", eq: "EQ", comp: "Comp",
  delay: "Delay", reverb: "Reverb", wah: "Auto-Wah", mwah: "Wah", octaver: "Octave",
  boost: "Boost", geq: "Graphic EQ", chorus: "Chorus", phaser: "Phaser",
  flanger: "Flanger", tremolo: "Tremolo", output: "Output",
};

// Simple single-color line glyphs (24x24, stroke=currentColor), matching
// app-icon.svg's plain style rather than emoji — one per stage, per
// ui-review-and-tonelab-redesign.md §5. Chorus/phaser/flanger/tremolo are
// deliberately variants of the same sine-wave base (a loop for phaser's
// notch, a doubled offset wave for flanger, pulse ticks for tremolo's
// volume wobble) since that's what actually distinguishes them sonically.
const CHAIN_ICON_GLYPHS = {
  // a jack plug: the signal entering the rig
  input: '<circle cx="7" cy="12" r="3"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="14" y1="9.5" x2="14" y2="14.5"/><line x1="17" y1="9.5" x2="17" y2="14.5"/>',
  gate: '<line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/>',
  amp: '<rect x="4" y="7" width="16" height="11" rx="1.5"/><circle cx="12" cy="12.5" r="3.2"/>',
  ir: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="12" r="2.6"/><circle cx="15.5" cy="12" r="2.6"/>',
  eq: '<line x1="6" y1="4" x2="6" y2="20"/><circle cx="6" cy="9" r="1.6"/><line x1="12" y1="4" x2="12" y2="20"/><circle cx="12" cy="15" r="1.6"/><line x1="18" y1="4" x2="18" y2="20"/><circle cx="18" cy="7" r="1.6"/>',
  comp: '<polyline points="9,7 4,12 9,17"/><polyline points="15,7 20,12 15,17"/>',
  // CH-3: delay is discrete repeats decaying away; reverb is the diffuse
  // tail the old shared "fx" arc glyph stood for.
  delay: '<line x1="4" y1="6" x2="4" y2="18"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="16" y1="10" x2="16" y2="14"/><line x1="21" y1="11.5" x2="21" y2="12.5"/>',
  reverb: '<path d="M4 14a8 8 0 0 1 16 0"/><path d="M7.5 14a4.5 4.5 0 0 1 9 0"/>',
  // The treadle outline is the wah pedal itself; the auto-wah gets the same
  // shape with the LFO's sine through it, since that is the whole
  // difference between them.
  mwah: '<polygon points="4,18 20,18 13,5"/>',
  wah: '<polygon points="4,18 20,18 13,5"/><path d="M6.5 15.5 Q9 12.5 11.5 15.5 T16.5 15.5" opacity="0.85"/>',
  octaver: '<circle cx="12" cy="8.5" r="3.6"/><circle cx="12" cy="17" r="5.2"/>',
  boost: '<polyline points="6,16 12,7 18,16"/><line x1="4" y1="19" x2="20" y2="19"/>',
  geq: '<rect x="2.5" y="10" width="2.6" height="10"/><rect x="7.5" y="5" width="2.6" height="15"/><rect x="12.5" y="12" width="2.6" height="8"/><rect x="17.5" y="3" width="2.6" height="17"/>',
  chorus: '<path d="M2 14 Q7 6 12 14 T22 14"/>',
  phaser: '<path d="M2 14 Q7 6 12 14 T22 14"/><circle cx="12" cy="14" r="2"/>',
  flanger: '<path d="M2 12 Q7 5 12 12 T22 12"/><path d="M2 17 Q7 10 12 17 T22 17" opacity="0.5"/>',
  tremolo: '<path d="M2 14 Q7 6 12 14 T22 14"/><line x1="6" y1="18" x2="6" y2="21"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="18" y1="18" x2="18" y2="21"/>',
  output: '<line x1="4" y1="4" x2="4" y2="20"/><line x1="9" y1="12" x2="19" y2="12"/><polyline points="15,8 20,12 15,16"/>',
};

let paOpenChainStage = null;

// v4.7: Amp is now part of PA.pedalOrder (reorderable, like any pedal —
// see rewirePedalChain) rather than a separate fixed prepend; only Gate
// (always first) and Output (always last) stay outside the array.
function paChainStageOrder() {
  // IN-1: "input" joins Gate and Output as a FIXED stage — it is the trim
  // that everything else hangs off, so it is never draggable and always
  // first.
  return ["input", "gate", ...(PA.pedalOrder || paLoadPedalOrder()), "output"];
}

// Amp has no bypass control of its own (three modes instead) — always
// "on". CH-3 removed the one special case here: Delay and Reverb used to
// share a card and light one icon between them, and are now two stages with
// one bypass each, like everything else.
function paChainStageIsOn(id) {
  // Input (a trim) and Amp (three modes) have no bypass of their own —
  // they are always part of the chain.
  if (id === "input" || id === "amp") return true;
  const el = document.getElementById(`pa-${id}-bypass`);
  return el ? !el.checked : true;
}

function paRefreshChainIconStates() {
  document.querySelectorAll("#pa-chain-icons .pa-chain-icon").forEach((icon) => {
    const id = icon.dataset.cardId;
    icon.classList.toggle("pa-chain-on", paChainStageIsOn(id));
    icon.classList.toggle("pa-chain-open", id === paOpenChainStage);
  });
}

// Click an icon -> its card becomes the one visible card below (the
// user's confirmed interaction model: click opens the panel, and every
// card's bypass control is already its first control, so it's the first
// thing shown by default).
//
// Deliberately does NOT touch scroll position. An earlier version tried
// to scroll the icon row back into view on every switch (reasoning: a
// short Gate card vs. a tall Neural-mode Amp card changes the overlay's
// content height a lot, so an old scrollTop might not even fit the new
// content) — real feedback was that this was worse, not better: it
// actively jumped the view on every click instead of leaving it alone.
// Per that feedback, this now does nothing beyond swapping the card
// itself; if the new content happens to be shorter than the current
// scroll position, the browser clamps scrollTop on its own (unavoidable —
// there's nothing to scroll to below content that doesn't exist), but it
// never actively repositions you otherwise. Scrolling from here is
// entirely the user's own call.
function paOpenChainCard(id) {
  document.querySelectorAll("#pa-pedalboard .pa-rig-card").forEach((card) => {
    card.classList.toggle("pa-chain-open", card.dataset.cardId === id);
  });
  paOpenChainStage = id;
  paRefreshChainIconStates();
}

function renderChainIcons() {
  const strip = document.getElementById("pa-chain-icons");
  strip.innerHTML = "";
  paChainStageOrder().forEach((id) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pa-chain-icon";
    btn.dataset.cardId = id;
    btn.title = CHAIN_ICON_LABELS[id] || id;
    if (id !== "input" && id !== "gate" && id !== "output") btn.draggable = true;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${CHAIN_ICON_GLYPHS[id] || ""}</svg><span class="pa-chain-icon-label">${CHAIN_ICON_LABELS[id] || id}</span>`;
    btn.addEventListener("click", () => paOpenChainCard(id));
    strip.appendChild(btn);
  });
  wireChainIconDragReorder(strip);
  paRefreshChainIconStates();
}

// Rebuilds PA.pedalOrder from the icon strip's current left-to-right
// order (Gate/Output excluded — they're fixed, never draggable; Amp joins
// v4.7's reorderable set, so a pedal can sit between the guitar and the
// amp), then persists and re-wires the live audio graph to match — the
// icon strip's DOM order IS the source of truth once a drag completes,
// same contract the old full-card drag reorder had.
function paSyncPedalOrderFromDom() {
  PA.pedalOrder = Array.from(document.querySelectorAll("#pa-chain-icons .pa-chain-icon"))
    .map((el) => el.dataset.cardId)
    .filter((id) => id !== "input" && id !== "gate" && id !== "output");
  paSavePedalOrder();
  rewirePedalChain();
}

// HTML5 drag-and-drop reorder for the 13 non-fixed icons (Amp + 12
// pedals). Icons sit in a wrapping row rather than a single column or a
// single row, so
// before/after is decided against the specific icon under the cursor
// (clientX vs. its own horizontal midpoint) rather than any assumption
// about global layout — the third variant of this drag-position math
// this codebase has needed (vertical-column, then single-row-horizontal,
// now a wrapping-row-horizontal).
function wireChainIconDragReorder(strip) {
  let draggingIcon = null;

  strip.querySelectorAll(".pa-chain-icon[draggable='true']").forEach((icon) => {
    icon.addEventListener("dragstart", (e) => {
      draggingIcon = icon;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", icon.dataset.cardId);
      requestAnimationFrame(() => icon.classList.add("dragging"));
    });
    icon.addEventListener("dragend", () => {
      icon.classList.remove("dragging");
      strip.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      draggingIcon = null;
    });

    icon.addEventListener("dragover", (e) => {
      if (!draggingIcon || draggingIcon === icon) return;
      e.preventDefault(); // required for drop to fire at all
      icon.classList.add("drag-over");
    });
    icon.addEventListener("dragleave", () => icon.classList.remove("drag-over"));
    icon.addEventListener("drop", (e) => {
      e.preventDefault();
      icon.classList.remove("drag-over");
      if (!draggingIcon || draggingIcon === icon) return;
      const rect = icon.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      icon.parentNode.insertBefore(draggingIcon, before ? icon : icon.nextSibling);
      paSyncPedalOrderFromDom();
    });
  });
}

// ---------------------------------------------------------------------------
// V3-T2 / GP-02 / GP-14: rig presets — full rack state (amp mode, capture,
// tweaker knobs, IR, FX, output), named and recallable. Presets themselves
// are cross-song and live server-side in one shared store
// (/api/rig_presets); a song's own project (XC-01, project format v2)
// carries an ORDERED CHAIN of names it wants attached, in
// State.rigPresetChain — see the chain-management section further down.
// ---------------------------------------------------------------------------

function paCaptureRigState() {
  const v = (id) => document.getElementById(id).value;
  const c = (id) => document.getElementById(id).checked;
  return {
    ampMode: PA.ampMode,
    gate: { bypass: c("pa-gate-bypass"), threshold: v("pa-gate-threshold") },
    analog: { drive: v("pa-drive"), bass: v("pa-bass"), mid: v("pa-mid"), treble: v("pa-treble") },
    neural: {
      namLoaded: PA.namLoaded || null,
      drive: v("pa-nam-in"),
      outputLevel: v("pa-nam-out"),
      tone: {
        bass: v("pa-namtone-bass"), mid: v("pa-namtone-mid"),
        treble: v("pa-namtone-treble"), presence: v("pa-namtone-presence"),
      },
    },
    ir: {
      bypass: c("pa-ir-bypass"), loaded: PA.irLoaded || null,
      toneBypass: c("pa-ir-tone-bypass"), lowCut: v("pa-ir-lowcut"), highCut: v("pa-ir-highcut"), // v3.1 §2.3
    },
    eq: { bypass: c("pa-eq-bypass"), bass: v("pa-eq-bass"), mid: v("pa-eq-mid"), treble: v("pa-eq-treble") },
    comp: { bypass: c("pa-comp-bypass"), threshold: v("pa-comp-threshold"), ratio: v("pa-comp-ratio") },
    fx: {
      delayBypass: c("pa-delay-bypass"), delayTime: v("pa-delay-time"),
      delayFeedback: v("pa-delay-feedback"), delayMix: v("pa-delay-mix"),
      reverbBypass: c("pa-reverb-bypass"), reverbSize: v("pa-reverb-size"), reverbMix: v("pa-reverb-mix"),
    },
    // v3.1 §2.2: the eight new pedal cards.
    boost: { bypass: c("pa-boost-bypass"), drive: v("pa-boost-drive"), level: v("pa-boost-level") },
    geq: {
      bypass: c("pa-geq-bypass"), b100: v("pa-geq-100"), b300: v("pa-geq-300"),
      b1000: v("pa-geq-1000"), b3000: v("pa-geq-3000"), b8000: v("pa-geq-8000"),
    },
    chorus: { bypass: c("pa-chorus-bypass"), rate: v("pa-chorus-rate"), depth: v("pa-chorus-depth"), mix: v("pa-chorus-mix") },
    flanger: {
      bypass: c("pa-flanger-bypass"), rate: v("pa-flanger-rate"), depth: v("pa-flanger-depth"),
      feedback: v("pa-flanger-feedback"), mix: v("pa-flanger-mix"),
    },
    phaser: { bypass: c("pa-phaser-bypass"), rate: v("pa-phaser-rate"), depth: v("pa-phaser-depth"), mix: v("pa-phaser-mix") },
    tremolo: { bypass: c("pa-tremolo-bypass"), rate: v("pa-tremolo-rate"), depth: v("pa-tremolo-depth") },
    wah: {
      bypass: c("pa-wah-bypass"), rate: v("pa-wah-rate"), depth: v("pa-wah-depth"),
      center: v("pa-wah-center"), mix: v("pa-wah-mix"),
    },
    // CH-4. The expression-pedal BINDING is deliberately not saved here:
    // like the footswitch bindings, it describes your hardware, not your
    // tone, and would be wrong to carry between machines or overwrite every
    // time you load a preset.
    mwah: {
      bypass: c("pa-mwah-bypass"), pos: v("pa-mwah-pos"), heel: v("pa-mwah-heel"),
      toe: v("pa-mwah-toe"), q: v("pa-mwah-q"), mix: v("pa-mwah-mix"),
    },
    octaver: { bypass: c("pa-octaver-bypass"), blend: v("pa-octaver-blend") },
    output: { level: v("pa-output-level"), bypass: c("pa-output-bypass") },
    pedalOrder: [...PA.pedalOrder], // GP-03
  };
}

// Sets a control and re-dispatches the same event its own wiring already
// listens for, rather than duplicating what every handler does — a preset
// recall goes through the exact same code path a user's own drag would.
function paSetControlValue(id, val) {
  if (val === undefined || val === null) return;
  const el = document.getElementById(id);
  el.value = val;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function paSetControlChecked(id, val) {
  if (val === undefined || val === null) return;
  const el = document.getElementById(id);
  el.checked = val;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function paApplyRigState(state) {
  if (!state) return;
  await ensurePAGraph();

  if (state.gate) {
    paSetControlValue("pa-gate-threshold", state.gate.threshold);
    paSetControlChecked("pa-gate-bypass", state.gate.bypass);
  }
  if (state.analog) {
    paSetControlValue("pa-drive", state.analog.drive);
    paSetControlValue("pa-bass", state.analog.bass);
    paSetControlValue("pa-mid", state.analog.mid);
    paSetControlValue("pa-treble", state.analog.treble);
  }
  if (state.neural) {
    paSetControlValue("pa-nam-in", state.neural.drive);
    paSetControlValue("pa-nam-out", state.neural.outputLevel);
    if (state.neural.tone) {
      paSetControlValue("pa-namtone-bass", state.neural.tone.bass);
      paSetControlValue("pa-namtone-mid", state.neural.tone.mid);
      paSetControlValue("pa-namtone-treble", state.neural.tone.treble);
      paSetControlValue("pa-namtone-presence", state.neural.tone.presence);
    }
    if (state.neural.namLoaded) {
      await paLoadNamModel(state.neural.namLoaded);
      paHighlightBrowserSelection("nam", state.neural.namLoaded);
    }
  }
  if (state.ir) {
    if (state.ir.loaded) {
      await paLoadIr(state.ir.loaded);
      paHighlightBrowserSelection("ir", state.ir.loaded);
    }
    paSetControlChecked("pa-ir-bypass", state.ir.bypass);
    // v3.1 §2.3: tone-shaper fields are additive to older saved rigs — a
    // preset saved before this release simply won't have them, and the
    // sliders/checkbox just stay at their HTML defaults (bypassed, wide
    // open) in that case.
    paSetControlValue("pa-ir-lowcut", state.ir.lowCut);
    paSetControlValue("pa-ir-highcut", state.ir.highCut);
    paSetControlChecked("pa-ir-tone-bypass", state.ir.toneBypass);
  }
  if (state.eq) {
    paSetControlValue("pa-eq-bass", state.eq.bass);
    paSetControlValue("pa-eq-mid", state.eq.mid);
    paSetControlValue("pa-eq-treble", state.eq.treble);
    paSetControlChecked("pa-eq-bypass", state.eq.bypass);
  }
  if (state.comp) {
    paSetControlValue("pa-comp-threshold", state.comp.threshold);
    paSetControlValue("pa-comp-ratio", state.comp.ratio);
    paSetControlChecked("pa-comp-bypass", state.comp.bypass);
  }
  if (state.fx) {
    paSetControlValue("pa-delay-time", state.fx.delayTime);
    paSetControlValue("pa-delay-feedback", state.fx.delayFeedback);
    paSetControlValue("pa-delay-mix", state.fx.delayMix);
    paSetControlChecked("pa-delay-bypass", state.fx.delayBypass);
    paSetControlValue("pa-reverb-size", state.fx.reverbSize);
    paSetControlValue("pa-reverb-mix", state.fx.reverbMix);
    paSetControlChecked("pa-reverb-bypass", state.fx.reverbBypass);
  }
  // v3.1 §2.2: the eight new pedal cards — same "additive, absent = HTML
  // defaults" tolerance as the IR tone-shaper fields above, for presets
  // saved before this release.
  if (state.boost) {
    paSetControlValue("pa-boost-drive", state.boost.drive);
    paSetControlValue("pa-boost-level", state.boost.level);
    paSetControlChecked("pa-boost-bypass", state.boost.bypass);
  }
  if (state.geq) {
    paSetControlValue("pa-geq-100", state.geq.b100);
    paSetControlValue("pa-geq-300", state.geq.b300);
    paSetControlValue("pa-geq-1000", state.geq.b1000);
    paSetControlValue("pa-geq-3000", state.geq.b3000);
    paSetControlValue("pa-geq-8000", state.geq.b8000);
    paSetControlChecked("pa-geq-bypass", state.geq.bypass);
  }
  if (state.chorus) {
    paSetControlValue("pa-chorus-rate", state.chorus.rate);
    paSetControlValue("pa-chorus-depth", state.chorus.depth);
    paSetControlValue("pa-chorus-mix", state.chorus.mix);
    paSetControlChecked("pa-chorus-bypass", state.chorus.bypass);
  }
  if (state.flanger) {
    paSetControlValue("pa-flanger-rate", state.flanger.rate);
    paSetControlValue("pa-flanger-depth", state.flanger.depth);
    paSetControlValue("pa-flanger-feedback", state.flanger.feedback);
    paSetControlValue("pa-flanger-mix", state.flanger.mix);
    paSetControlChecked("pa-flanger-bypass", state.flanger.bypass);
  }
  if (state.phaser) {
    paSetControlValue("pa-phaser-rate", state.phaser.rate);
    paSetControlValue("pa-phaser-depth", state.phaser.depth);
    paSetControlValue("pa-phaser-mix", state.phaser.mix);
    paSetControlChecked("pa-phaser-bypass", state.phaser.bypass);
  }
  if (state.tremolo) {
    paSetControlValue("pa-tremolo-rate", state.tremolo.rate);
    paSetControlValue("pa-tremolo-depth", state.tremolo.depth);
    paSetControlChecked("pa-tremolo-bypass", state.tremolo.bypass);
  }
  if (state.wah) {
    paSetControlValue("pa-wah-rate", state.wah.rate);
    paSetControlValue("pa-wah-depth", state.wah.depth);
    paSetControlValue("pa-wah-center", state.wah.center);
    paSetControlValue("pa-wah-mix", state.wah.mix);
    paSetControlChecked("pa-wah-bypass", state.wah.bypass);
  }
  if (state.mwah) {
    // Range and Q before position: paSetMwahPosition reads heel/toe off the
    // DOM to derive the frequency, so setting the position first would
    // compute it against the outgoing preset's range.
    paSetControlValue("pa-mwah-heel", state.mwah.heel);
    paSetControlValue("pa-mwah-toe", state.mwah.toe);
    paSetControlValue("pa-mwah-q", state.mwah.q);
    paSetControlValue("pa-mwah-pos", state.mwah.pos);
    paSetControlValue("pa-mwah-mix", state.mwah.mix);
    paSetControlChecked("pa-mwah-bypass", state.mwah.bypass);
  }
  if (state.octaver) {
    paSetControlValue("pa-octaver-blend", state.octaver.blend);
    paSetControlChecked("pa-octaver-bypass", state.octaver.bypass);
  }
  if (state.output) {
    paSetControlValue("pa-output-level", state.output.level);
    paSetControlChecked("pa-output-bypass", state.output.bypass);
  }
  // GP-03: reorder the actual DOM to match (not just PA.pedalOrder +
  // rewirePedalChain) — the drag-reorder handler treats DOM order as the
  // source of truth, so leaving it stale here would make the next drag
  // silently revert to whatever order was on screen before this preset
  // loaded, discarding the very order the preset just asked for.
  // Normalised first (CH-3/CH-4): a preset saved before the Delay/Reverb
  // split names "fx" and knows nothing about "mwah", and applying it raw
  // would leave both new stages wherever they happened to be sitting rather
  // than where the preset meant them to go.
  if (state.pedalOrder) paApplyPedalOrderToDom(paNormalizePedalOrder(state.pedalOrder));
  // Last: connects whichever mode's chain is now fully parameterized above.
  if (state.ampMode) setAmpMode(state.ampMode);
}

// GP-03 (v4.7: icon-strip version): reorders the icon strip's draggable
// icon elements in the DOM to match `order`, then syncs PA.pedalOrder/
// localStorage/the live audio graph from that new DOM order — same call
// paSyncPedalOrderFromDom makes after a manual drag, just driven by a
// preset instead of a mouse gesture. The underlying .pa-rig-card elements
// don't need reordering at all now — only one is ever visible at a time
// (paOpenChainCard), so their own DOM order is irrelevant to what the
// player sees or drags.
function paApplyPedalOrderToDom(order) {
  const strip = document.getElementById("pa-chain-icons");
  // Gate/Output aren't draggable and must stay in their fixed slots —
  // insert each reordered icon (which, since v4.7, may include "amp")
  // right before Output (the fixed last icon) rather than appendChild-ing
  // to the container's end, which would push it past it.
  const outputIcon = strip.querySelector('[data-card-id="output"]');
  const byId = {};
  strip.querySelectorAll(".pa-chain-icon").forEach((el) => { byId[el.dataset.cardId] = el; });
  for (const id of order) {
    if (byId[id]) strip.insertBefore(byId[id], outputIcon);
  }
  paSyncPedalOrderFromDom();
}

// ---------------------------------------------------------------------------
// Preset store — /api/rig_presets is a single shared {presets: {name: state}}
// blob (like PA.namModels/irModels, fetched once and cached client-side;
// refreshed on Play Along open).
// ---------------------------------------------------------------------------
let paRigPresets = {};

async function paRefreshRigPresets() {
  try {
    const r = await Api.get("/api/rig_presets");
    paRigPresets = r.presets || {};
  } catch (e) {
    paRigPresets = {};
  }
  const sel = document.getElementById("pa-preset-select");
  const prev = sel.value;
  sel.innerHTML = "";
  const names = Object.keys(paRigPresets).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "No saved presets yet";
    sel.appendChild(opt);
  }
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name; opt.textContent = name;
    sel.appendChild(opt);
  }
  if (names.includes(prev)) sel.value = prev;
  paSyncPresetQuickpick();
}

async function paSaveRigPresetsToServer() {
  await Api.post("/api/rig_presets", { presets: paRigPresets });
}

// v3.2: Play Along carries a lighter "quick pick" dropdown for rig presets
// (#pa-preset-quickpick) alongside Tone Lab's full management card
// (#pa-preset-select, the canonical element every function above already
// targets). This mirrors the option list AND value from the canonical
// select onto the quick-pick one, rebuilding its options fresh each time
// (cheap — the list is at most a few dozen names) rather than diffing.
function paSyncPresetQuickpick() {
  const src = document.getElementById("pa-preset-select");
  const qp = document.getElementById("pa-preset-quickpick");
  if (!src || !qp) return;
  qp.innerHTML = "";
  for (const opt of src.options) {
    const clone = document.createElement("option");
    clone.value = opt.value; clone.textContent = opt.textContent;
    qp.appendChild(clone);
  }
  qp.value = src.value;
}

// ---------------------------------------------------------------------------
// GP-14: this song's ordered rig-preset CHAIN (research/rig-preset-chain-
// spec.md) — replaces GP-02's single attached preset. State.rigPresetChain
// is an ordered list of preset names; State.rigPresetIndex is which one is
// currently active. Cycling/jumping re-applies the rig live, so both go
// through paApplyPresetWithFade's mute-ramp-unmute (§5 of the spec) to
// avoid an audible pop on a mid-song swap — reusing PA.outputMute, already
// there for the tuner's instant mute, rather than adding new audio nodes.
// ---------------------------------------------------------------------------
const PA_DEFAULT_CYCLE_KEY_FORWARD = "ArrowRight";
const PA_DEFAULT_CYCLE_KEY_BACKWARD = "ArrowLeft";
const PA_PRESET_SWITCH_FADE_MS = 20;

// Arrow keys read as their own names ("ArrowRight") in KeyboardEvent.key —
// display glyphs instead so the presets card doesn't spell that out.
const PA_KEY_LABELS = { ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓", " ": "Space", Escape: "Esc" };
function paKeyLabel(key) {
  return PA_KEY_LABELS[key] || key;
}

async function paApplyPresetWithFade(name) {
  if (!paRigPresets[name]) await paRefreshRigPresets();
  const state = paRigPresets[name];
  if (!state) return false;
  // No live audio graph yet (rig never enabled this session) — just apply
  // the controls, nothing to fade around.
  const hasGraph = !!(PA.built && PA.outputMute);
  if (hasGraph) {
    const now = Audio.ctx.currentTime;
    PA.outputMute.gain.cancelScheduledValues(now);
    PA.outputMute.gain.setValueAtTime(PA.outputMute.gain.value, now);
    PA.outputMute.gain.linearRampToValueAtTime(0, now + PA_PRESET_SWITCH_FADE_MS / 1000);
  }
  // The mute has to stay down for the WHOLE await, not just the fixed fade
  // window above — a preset that swaps to a different NAM capture/IR can
  // take much longer than 20ms to finish loading (paLoadNamModel/paLoadIr),
  // and un-muting before that resolves would let the old tone bleed through.
  await paApplyRigState(state);
  if (hasGraph) {
    const now2 = Audio.ctx.currentTime;
    PA.outputMute.gain.setValueAtTime(0, now2);
    PA.outputMute.gain.linearRampToValueAtTime(1, now2 + PA_PRESET_SWITCH_FADE_MS / 1000);
  }
  return true;
}

// Advance-and-wrap in either direction — forward (dir=1) and backward
// (dir=-1) are each bound to their own key (right/left arrow by default;
// see wireRigPresets). A single-button footswitch (GP-11's eventual
// target) would only ever send the forward direction, so that binding
// alone is still a straight 1:1 hookup with no redesign needed.
async function paCyclePresetChain(dir) {
  const chain = State.rigPresetChain || [];
  if (chain.length < 2) return;
  const nextIndex = (State.rigPresetIndex + dir + chain.length) % chain.length;
  const name = chain[nextIndex];
  if (!(await paApplyPresetWithFade(name))) return;
  State.rigPresetIndex = nextIndex;
  saveProjectDebounced();
  renderPresetChainList();
  document.getElementById("pa-preset-status").textContent = `Cycled to "${name}".`;
  paPrewarmPresetChain(); // deliberately not awaited — warms the NEXT switch
}

// The mouse-driven equivalent of the cycle key — pick a specific chain
// entry out of order instead of stepping through the others.
async function paJumpToChainIndex(i) {
  const chain = State.rigPresetChain || [];
  if (i < 0 || i >= chain.length || i === State.rigPresetIndex) return;
  const name = chain[i];
  if (!(await paApplyPresetWithFade(name))) return;
  State.rigPresetIndex = i;
  saveProjectDebounced();
  renderPresetChainList();
  document.getElementById("pa-preset-status").textContent = `Loaded "${name}" from this song's chain.`;
  paPrewarmPresetChain(); // deliberately not awaited — warms the NEXT switch
}

function paAddToChain() {
  const name = document.getElementById("pa-preset-select").value;
  const statusEl = document.getElementById("pa-preset-status");
  if (!name) { statusEl.textContent = "Pick a preset above before adding it to the chain."; return; }
  State.rigPresetChain = [...(State.rigPresetChain || []), name];
  if (State.rigPresetChain.length === 1) State.rigPresetIndex = 0; // first entry becomes the active one
  saveProjectDebounced();
  renderPresetChainList();
  statusEl.textContent = `Added "${name}" to this song's chain.`;
  paPrewarmPresetChain(); // the entry just added is a switch target now
}

// Removing a chain entry never touches the live rig itself (only cycling/
// jumping does that) — just bookkeeping so the active index still points
// at a valid row, same "no audio surprise from organizing your list"
// posture as the rest of this feature.
function paRemoveFromChain(i) {
  const chain = [...(State.rigPresetChain || [])];
  if (i < 0 || i >= chain.length) return;
  chain.splice(i, 1);
  if (i < State.rigPresetIndex) State.rigPresetIndex -= 1;
  else State.rigPresetIndex = Math.min(State.rigPresetIndex, Math.max(0, chain.length - 1));
  State.rigPresetChain = chain;
  saveProjectDebounced();
  renderPresetChainList();
}

function renderPresetChainList() {
  const list = document.getElementById("pa-preset-chain-list");
  if (!list) return;
  list.innerHTML = "";
  const chain = State.rigPresetChain || [];
  chain.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "pa-preset-chain-row" + (i === State.rigPresetIndex ? " pa-preset-chain-active" : "");
    row.draggable = true;
    row.dataset.index = String(i);

    const handle = document.createElement("span");
    handle.className = "pa-drag-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "⠿";

    const label = document.createElement("span");
    label.className = "pa-preset-chain-name";
    label.textContent = `${i + 1}. ${name}`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "pa-preset-chain-remove-btn";
    removeBtn.title = "Remove from this song's chain";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", (e) => { e.stopPropagation(); paRemoveFromChain(i); });

    row.append(handle, label, removeBtn);
    row.addEventListener("click", () => paJumpToChainIndex(i));
    list.appendChild(row);
  });
  const fwdKeyEl = document.getElementById("pa-cycle-key-forward-display");
  if (fwdKeyEl) fwdKeyEl.textContent = paKeyLabel(State.rigPresetCycleKeyForward || PA_DEFAULT_CYCLE_KEY_FORWARD);
  const backKeyEl = document.getElementById("pa-cycle-key-backward-display");
  if (backKeyEl) backKeyEl.textContent = paKeyLabel(State.rigPresetCycleKeyBackward || PA_DEFAULT_CYCLE_KEY_BACKWARD);
  wirePresetChainDragReorder(list);
}

// Vertical drag-reorder for the chain list — same clientY-vs-hovered-row-
// midpoint idiom the old pedal-card reorder used (this list is a single
// column, not a wrapping row, so vertical is the right axis here).
function wirePresetChainDragReorder(list) {
  let draggingRow = null;

  list.querySelectorAll(".pa-preset-chain-row").forEach((row) => {
    row.addEventListener("dragstart", (e) => {
      draggingRow = row;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.index);
      requestAnimationFrame(() => row.classList.add("dragging"));
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      draggingRow = null;
    });
    row.addEventListener("dragover", (e) => {
      if (!draggingRow || draggingRow === row) return;
      e.preventDefault();
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      row.classList.remove("drag-over");
      if (!draggingRow || draggingRow === row) return;
      const fromIndex = Number(draggingRow.dataset.index);
      const targetIndex = Number(row.dataset.index);
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      let toIndex = before ? targetIndex : targetIndex + 1;
      if (fromIndex < toIndex) toIndex -= 1; // account for the removal shifting indices below it

      const chain = [...State.rigPresetChain];
      const activeName = chain[State.rigPresetIndex];
      const [moved] = chain.splice(fromIndex, 1);
      chain.splice(toIndex, 0, moved);
      State.rigPresetChain = chain;
      State.rigPresetIndex = chain.indexOf(activeName); // keep pointing at the same preset, wherever it landed
      saveProjectDebounced();
      renderPresetChainList();
    });
  });
}

// GP-02/GP-14: applied once per track load, the first time Play Along opens
// for it — not at selectTrack() time, since the PA audio graph doesn't
// exist until ensurePAGraph runs (see openPlayAlong). Applies whichever
// entry in this song's chain is currently active (State.rigPresetIndex),
// not necessarily the first one, so reopening a song resumes on the same
// preset it was left on last time.
async function paApplyAttachedRigPreset() {
  const chain = State.rigPresetChain || [];
  if (!chain.length || State.rigPresetApplied) return;
  State.rigPresetApplied = true; // before the await — openPlayAlong can be called again while this is in flight
  const name = chain[State.rigPresetIndex] || chain[0];
  if (!paRigPresets[name]) await paRefreshRigPresets();
  const state = paRigPresets[name];
  if (state) {
    await paApplyRigState(state);
    const sel = document.getElementById("pa-preset-select");
    if ([...sel.options].some((o) => o.value === name)) sel.value = name;
    paSyncPresetQuickpick();
  }
  renderPresetChainList();
}

// ---------------------------------------------------------------------------
// GP-11/V6-MIDI: hardware footswitch control over the same rig-preset
// forward/backward cycle actions the keyboard keys above already trigger
// (paCyclePresetChain) — see research/release-v6-spec.md §2. Global (not
// per-song, unlike the keyboard cycle keys) — a physical pedal's button
// layout doesn't change per song, so remapping it every time you switch
// tracks would be the surprising choice here, not the safe default.
//
// A learned mapping is just the (status byte, data1) pair a footswitch
// button actually sent while Learn… was armed — covers Note On, Control
// Change, and Program Change uniformly without needing to special-case
// each message type, since a real footswitch reliably sends the same pair
// every time that button is pressed regardless of which of the three it
// happens to use. Deliberately NOT hardware-tested yet — no footswitch was
// on hand while this was built — so treat this as a first build to
// validate against a real device, not a finished, confirmed-working
// feature; the code path was verified in isolation with synthetic MIDI
// messages, which confirms the logic but not real-world hardware quirks
// (e.g. a pedal that sends on a different channel per press, or debounces
// oddly).
// ---------------------------------------------------------------------------
const PA_MIDI_DEVICE_KEY = "gs_midi_device_id";
const PA_MIDI_MAP_FORWARD_KEY = "gs_midi_map_forward";
const PA_MIDI_MAP_BACKWARD_KEY = "gs_midi_map_backward";

// Every learnable footswitch action in one table, rather than the two
// hardcoded forward/backward targets this started as — adding the looper
// pedal actions was otherwise four parallel edits (storage key, learn
// wiring, label render, dispatch branch) with four chances to miss one.
// `id` doubles as the DOM id stem (`pa-midi-${id}-display` /
// `pa-midi-${id}-learn-btn`), and the two preset storageKeys keep their
// original names so an existing learned pedal survives this refactor.
//
// The looper actions deliberately reuse paLooperPrimaryPress /
// paLooperStopPress verbatim — the same functions the on-screen buttons
// call — so a footswitch and a mouse click can never drift apart in what
// they do. paLooperPrimaryPress is already the full pedal state machine
// (record -> loop -> overdub -> stop overdub -> resume, per
// looper-pedal-spec.md §4), which is exactly the "one button
// play/overdub" behaviour a looper pedal has.
//
// CH-2: every bypass in the rig is footswitchable too — one stomp per pedal,
// which is the thing a pedalboard does that this app could not. These are
// generated from the table below rather than written out, because the whole
// point of the `id`-drives-the-DOM convention above is that a new action
// costs one row; fifteen hand-written ones would be fifteen chances to
// mistype a storage key.
//
// Toggling goes through the checkbox and a dispatched "change" event rather
// than calling the audio code directly, deliberately: every bypass already
// has a change handler that does the real work, and a delegated listener
// repaints the chain-icon strip off the same event. Driving the control
// means a footswitch press and a mouse click cannot diverge, and the icon
// lighting up is free.
//
// Amp is absent because it has no bypass (three modes instead), and Input
// because it is a trim. Delay and Reverb are separate entries even though
// they share the "fx" card — they are two effects with two bypasses, and on
// a real board they would be two switches.
const PA_MIDI_BYPASS_STAGES = [
  { id: "gate", label: "gate", checkbox: "pa-gate-bypass" },
  { id: "wah", label: "auto-wah", checkbox: "pa-wah-bypass" },
  { id: "comp", label: "compressor", checkbox: "pa-comp-bypass" },
  { id: "octaver", label: "octaver", checkbox: "pa-octaver-bypass" },
  { id: "boost", label: "boost/overdrive", checkbox: "pa-boost-bypass" },
  { id: "ir", label: "cab IR", checkbox: "pa-ir-bypass" },
  { id: "geq", label: "graphic EQ", checkbox: "pa-geq-bypass" },
  { id: "eq", label: "EQ", checkbox: "pa-eq-bypass" },
  { id: "chorus", label: "chorus", checkbox: "pa-chorus-bypass" },
  { id: "phaser", label: "phaser", checkbox: "pa-phaser-bypass" },
  { id: "flanger", label: "flanger", checkbox: "pa-flanger-bypass" },
  { id: "tremolo", label: "tremolo", checkbox: "pa-tremolo-bypass" },
  { id: "delay", label: "delay", checkbox: "pa-delay-bypass" },
  { id: "reverb", label: "reverb", checkbox: "pa-reverb-bypass" },
  { id: "mwah", label: "manual wah", checkbox: "pa-mwah-bypass" },
  { id: "output", label: "output mute", checkbox: "pa-output-bypass" },
];

function paToggleBypass(checkboxId) {
  const el = document.getElementById(checkboxId);
  if (!el) return;
  el.checked = !el.checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const PA_MIDI_ACTIONS = [
  { id: "forward", label: "cycle forward", storageKey: PA_MIDI_MAP_FORWARD_KEY, run: () => paCyclePresetChain(1) },
  { id: "backward", label: "cycle backward", storageKey: PA_MIDI_MAP_BACKWARD_KEY, run: () => paCyclePresetChain(-1) },
  { id: "looper-primary", label: "looper record/overdub", storageKey: "gs_midi_map_looper_primary", run: () => paLooperPrimaryPress() },
  { id: "looper-stop", label: "looper stop", storageKey: "gs_midi_map_looper_stop", run: () => paLooperStopPress() },
  ...PA_MIDI_BYPASS_STAGES.map((stage) => ({
    id: `bypass-${stage.id}`,
    label: `${stage.label} on/off`,
    storageKey: `gs_midi_map_bypass_${stage.id}`,
    run: () => paToggleBypass(stage.checkbox),
  })),
];

// CH-4: expression-pedal bindings are a different kind of thing from the
// footswitch bindings above, and deliberately kept separate rather than
// bolted onto PA_MIDI_ACTIONS. A footswitch action cares only THAT a
// message arrived; an expression pedal's whole content is the value it
// carries, and it sends a continuous stream of them. Sharing one table
// would have meant every consumer checking which kind it was holding.
//
// Only Control Change can carry a sweep, so unlike the footswitch bindings
// (which accept Note/CC/Program alike) this one matches CC exclusively.
const PA_MIDI_EXPRESSION_TARGETS = [
  {
    id: "mwah",
    label: "manual wah",
    storageKey: "gs_midi_expr_mwah",
    apply: (v) => paSetMwahPosition(v, true), // v is 0..1
  },
];

function paMidiExpressionMatch(status, data1) {
  if ((status & 0xf0) !== 0xb0) return null;
  for (const t of PA_MIDI_EXPRESSION_TARGETS) {
    const m = paMidiLoadMapping(t.storageKey);
    if (m && m.status === status && m.data1 === data1) return t;
  }
  return null;
}

function paMidiRenderExpression(target) {
  const el = document.getElementById(`pa-midi-expr-${target.id}-display`);
  if (!el) return;
  const m = paMidiLoadMapping(target.storageKey);
  el.textContent = m ? `CC ${m.data1} (ch ${(m.status & 0x0f) + 1})` : "not set";
}

// Arming works the same way the footswitch Learn does, with one difference
// that matters in practice: a treadle sends a burst of CCs the instant you
// move it, so the FIRST one to arrive wins and learning ends immediately —
// otherwise a single sweep would rebind the target dozens of times and the
// last message (wherever the foot stopped) would decide, which is the same
// answer only by luck.
function paMidiArmExpressionLearn(targetId) {
  const target = PA_MIDI_EXPRESSION_TARGETS.find((t) => t.id === targetId);
  if (!target) return;
  const btn = document.getElementById(`pa-midi-expr-${target.id}-learn-btn`);
  const statusEl = document.getElementById("pa-midi-status");

  if (PA.midiExprLearnTarget === targetId) {
    PA.midiExprLearnTarget = null;
    if (btn) btn.textContent = "Learn…";
    return;
  }
  if (!PA.midiInput) {
    if (statusEl) statusEl.textContent = "Pick your MIDI device in Tone Lab → Rig presets first.";
    if (btn) { btn.textContent = "No device"; setTimeout(() => { btn.textContent = "Learn…"; }, 2000); }
    return;
  }
  PA.midiExprLearnTarget = targetId;
  if (btn) btn.textContent = "Sweep it…";
  if (statusEl) statusEl.textContent = `Rock the expression pedal you want for ${target.label} now…`;
}

function paMidiLoadMapping(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

function paMidiMapLabel(map) {
  if (!map) return "not set";
  const type = map.status & 0xf0;
  const typeName = type === 0x90 ? "Note" : type === 0xb0 ? "CC" : type === 0xc0 ? "Program" : "MIDI";
  return `${typeName} ${map.data1} (ch ${(map.status & 0x0f) + 1})`;
}

// Only a "press," never a "release," counts — a footswitch commonly sends
// Note On velocity 0 (a disguised Note Off, per the MIDI spec's own
// convention) or a CC value of 0 on release, and both Learn mode and live
// matching need to agree on which half of that pair is the trigger.
function paMidiIsPressEvent(status, data2) {
  const type = status & 0xf0;
  if (type === 0x90) return (data2 || 0) > 0; // Note On, real velocity
  if (type === 0xb0) return (data2 || 0) > 0; // Control Change, real value
  if (type === 0xc0) return true; // Program Change has no release concept at all
  return false; // Note Off, pitch-bend, aftertouch, etc. — not a footswitch press
}

function paMidiRenderMapping(action) {
  const el = document.getElementById(`pa-midi-${action.id}-display`);
  if (el) el.textContent = paMidiMapLabel(paMidiLoadMapping(action.storageKey));
}

// CH-2: the bypass bindings live on each pedal's own card, immediately under
// the Bypass control they drive — the same choice the Looper's bindings
// already made ("next to the pedal they actually drive"), and the only one
// that scales: fifteen more rows stacked in the Rig Presets panel would bury
// the two that are there now. The device picker stays shared.
//
// Injected here rather than written into index.html so the rows can never
// drift out of step with PA_MIDI_BYPASS_STAGES — one table, one source of
// truth for which stages are switchable.
function paRenderBypassMidiRows() {
  for (const stage of PA_MIDI_BYPASS_STAGES) {
    const cb = document.getElementById(stage.checkbox);
    if (!cb) continue;
    const anchor = cb.closest(".row") || cb.parentElement;
    if (!anchor || anchor.nextElementSibling?.classList.contains("pa-midi-bypass-row")) continue;
    const row = document.createElement("div");
    row.className = "row pa-midi-bypass-row";
    row.innerHTML =
      `<label style="margin:0">Footswitch: <kbd id="pa-midi-bypass-${stage.id}-display">not set</kbd></label>` +
      `<button type="button" id="pa-midi-bypass-${stage.id}-learn-btn">Learn…</button>`;
    anchor.after(row);
  }
}

// Arming is shared by every Learn… button, including the fifteen generated
// ones. The button's own label becomes the feedback, because a bypass row
// sits on a pedal card while #pa-midi-status lives over in Rig Presets —
// telling someone "press your footswitch now" on a panel they cannot see
// would be no message at all. Clicking an armed button again cancels, so an
// accidental arm isn't a state you have to press a pedal to escape.
function paMidiArmLearn(actionId) {
  const action = PA_MIDI_ACTIONS.find((a) => a.id === actionId);
  if (!action) return;
  const statusEl = document.getElementById("pa-midi-status");
  const btn = document.getElementById(`pa-midi-${action.id}-learn-btn`);

  if (PA.midiLearnTarget === actionId) { // second click on an armed button
    PA.midiLearnTarget = null;
    paMidiResetLearnButtons();
    if (statusEl) statusEl.textContent = "";
    return;
  }
  if (!PA.midiInput) {
    const msg = "Pick your MIDI device in Tone Lab → Rig presets first.";
    if (statusEl) statusEl.textContent = msg;
    if (btn) { btn.textContent = "No device"; setTimeout(() => paMidiResetLearnButtons(), 2000); }
    return;
  }
  PA.midiLearnTarget = actionId;
  paMidiResetLearnButtons();
  if (btn) btn.textContent = "Press it…";
  if (statusEl) statusEl.textContent = `Press the footswitch button you want for ${action.label} now…`;
}

function paMidiResetLearnButtons() {
  for (const a of PA_MIDI_ACTIONS) {
    const b = document.getElementById(`pa-midi-${a.id}-learn-btn`);
    if (b && a.id !== PA.midiLearnTarget) b.textContent = "Learn…";
  }
}

function paHandleMidiMessage(event) {
  const [status, data1, data2] = event.data;

  // CH-4: an armed expression Learn outranks everything — the first CC to
  // arrive is the binding, and a treadle sends a burst of them the moment
  // it moves.
  if (PA.midiExprLearnTarget && (status & 0xf0) === 0xb0) {
    const target = PA_MIDI_EXPRESSION_TARGETS.find((t) => t.id === PA.midiExprLearnTarget);
    PA.midiExprLearnTarget = null;
    if (!target) return;
    localStorage.setItem(target.storageKey, JSON.stringify({ status, data1 }));
    // One control, one job — the same rule the footswitch learn enforces,
    // applied across the two kinds. A CC bound to both would sweep the wah
    // AND stomp a pedal on and off dozens of times a second.
    for (const other of PA_MIDI_ACTIONS) {
      const m = paMidiLoadMapping(other.storageKey);
      if (m && m.status === status && m.data1 === data1) {
        localStorage.removeItem(other.storageKey);
        paMidiRenderMapping(other);
      }
    }
    paMidiRenderExpression(target);
    const btn = document.getElementById(`pa-midi-expr-${target.id}-learn-btn`);
    if (btn) btn.textContent = "Learn…";
    const statusEl = document.getElementById("pa-midi-status");
    if (statusEl) statusEl.textContent = `Expression pedal for ${target.label} set to CC ${data1} (ch ${(status & 0x0f) + 1}).`;
    return;
  }
  // An armed footswitch Learn outranks a live expression binding, and that
  // ordering is load-bearing rather than arbitrary: it is the only way to
  // rebind a CC an expression pedal already owns. With the match first, a
  // bound treadle CC would sweep the wah and return before the Learn branch
  // ever saw it, so that button/pedal could never be reassigned to anything
  // — found by the CH-4 test, which is exactly the sort of dead end that
  // reads as "the app ignored me" rather than as a bug.
  //
  // The press gate still applies to learning (a footswitch's release sends
  // CC value 0, and learning from that half of the pair would bind the
  // wrong thing), so it is evaluated up front and shared.
  const isPress = paMidiIsPressEvent(status, data2);

  if (PA.midiLearnTarget && isPress) {
    const action = PA_MIDI_ACTIONS.find((a) => a.id === PA.midiLearnTarget);
    PA.midiLearnTarget = null;
    paMidiResetLearnButtons();
    if (!action) return;
    const map = { status, data1 };
    // One physical button doing two things at once is never what someone
    // wants and is very hard to diagnose after the fact (both fire, in
    // table order). Steal the binding instead, and say so.
    const stolenFrom = PA_MIDI_ACTIONS.filter((other) => {
      if (other.id === action.id) return false;
      const m = paMidiLoadMapping(other.storageKey);
      return m && m.status === status && m.data1 === data1;
    });
    for (const other of stolenFrom) {
      localStorage.removeItem(other.storageKey);
      paMidiRenderMapping(other);
    }
    // ...and the same rule in the other direction (CH-4): binding a
    // footswitch to a CC an expression pedal already owns unbinds the pedal.
    for (const t of PA_MIDI_EXPRESSION_TARGETS) {
      const m = paMidiLoadMapping(t.storageKey);
      if (m && m.status === status && m.data1 === data1) {
        localStorage.removeItem(t.storageKey);
        paMidiRenderExpression(t);
        stolenFrom.push(t);
      }
    }
    localStorage.setItem(action.storageKey, JSON.stringify(map));
    paMidiRenderMapping(action);
    document.getElementById("pa-midi-status").textContent =
      `MIDI ${action.label} set to ${paMidiMapLabel(map)}.` +
      (stolenFrom.length ? ` (Unassigned from ${stolenFrom.map((o) => o.label).join(", ")} — one button, one job.)` : "");
    return;
  }

  // CH-4: a bound expression pedal, once nothing is being learned. This has
  // to sit ahead of the press gate below AND ahead of the footswitch match:
  // a swept CC always carries a non-zero value, which the gate would read
  // as a press, so a treadle would otherwise also fire whatever footswitch
  // action shared its CC number — dozens of times a second. And heel-down
  // is CC value 0, a real position the gate would throw away as a release.
  const exprTarget = paMidiExpressionMatch(status, data1);
  if (exprTarget) { exprTarget.apply((data2 || 0) / 127); return; }

  if (!isPress) return;

  // First match wins. Duplicate bindings are prevented at Learn time above,
  // so in practice at most one action ever matches.
  for (const action of PA_MIDI_ACTIONS) {
    const map = paMidiLoadMapping(action.storageKey);
    if (map && map.status === status && map.data1 === data1) {
      action.run();
      return;
    }
  }
}

function paSelectMidiDevice(id) {
  if (PA.midiInput) PA.midiInput.onmidimessage = null;
  PA.midiInput = null;
  const statusEl = document.getElementById("pa-midi-status");
  if (!PA.midiAccess || !id) { statusEl.textContent = ""; return; }
  const input = [...PA.midiAccess.inputs.values()].find((inp) => inp.id === id);
  if (!input) { statusEl.textContent = ""; return; }
  PA.midiInput = input;
  PA.midiInput.onmidimessage = paHandleMidiMessage;
  localStorage.setItem(PA_MIDI_DEVICE_KEY, id);
  statusEl.textContent = `Connected: ${input.name || input.id}.`;
  paUpdateLooperMidiHint();
}

// The Looper card's footswitch rows live on Play Along, but the device
// picker they depend on is in Tone Lab (one device for the whole app) —
// so the Looper card has to say which state that shared picker is in,
// otherwise "Learn…" over there looks broken for no visible reason.
function paUpdateLooperMidiHint() {
  const el = document.getElementById("looper-midi-hint");
  if (!el) return;
  el.textContent = PA.midiInput
    ? `Footswitch: ${PA.midiInput.name || PA.midiInput.id}.`
    : "Pick your MIDI device in Tone Lab → Rig presets first.";
}

// V6-MEM2: this used to request access AND render the list AND install the
// statechange handler in one function, with the handler calling the whole
// thing again. That recursed without end.
//
// requestMIDIAccess() hands back a fresh MIDIAccess each call, and a fresh
// object announces the ports it already has by firing statechange — which
// re-entered here, requested access again, and so on. Each pass rebuilt the
// <option> list, and escapeHtml() builds a throwaway <div> per device, so
// the loop shed detached DOM nodes as fast as it could spin: measured at 913
// createElement calls a second, and roughly a gigabyte a minute of renderer
// memory until the tab died.
//
// It only ever bit people with a USB MIDI device attached, because with no
// MIDI ports there is nothing for a new MIDIAccess to announce and the loop
// never starts. A Helix registers MIDI ports; a built-in microphone does
// not. That is the whole reason this looked like an audio problem for so
// long — it tracked "plug the interface in", survived suspending the
// AudioContext and stopping capture, and never once reproduced against a
// synthetic capture device, which brings no MIDI ports with it.
//
// Access is now acquired once and the handler only re-renders.
async function paEnsureMidiAccess() {
  if (PA.midiAccess) return PA.midiAccess;
  PA.midiAccess = await navigator.requestMIDIAccess();
  // Installed once, on the one object we keep. Re-rendering is safe to
  // repeat; re-requesting access is what was not.
  PA.midiAccess.onstatechange = () => paRenderMidiDeviceList();
  return PA.midiAccess;
}

function paRenderMidiDeviceList() {
  const select = document.getElementById("pa-midi-device-select");
  if (!PA.midiAccess) return;
  const inputs = [...PA.midiAccess.inputs.values()];
  select.innerHTML = inputs.length
    ? inputs.map((inp) => `<option value="${inp.id}">${escapeHtml(inp.name || inp.id)}</option>`).join("")
    : '<option value="">No MIDI devices found</option>';
  const savedId = localStorage.getItem(PA_MIDI_DEVICE_KEY);
  const toSelect = inputs.find((inp) => inp.id === savedId) || inputs[0];
  if (toSelect) {
    select.value = toSelect.id;
    // Only re-bind when the selection actually changed. Re-running this on
    // every statechange would reassign onmidimessage and rewrite
    // localStorage for a device that was already connected.
    if (!PA.midiInput || PA.midiInput.id !== toSelect.id) paSelectMidiDevice(toSelect.id);
  }
}

async function paRefreshMidiDevices() {
  const select = document.getElementById("pa-midi-device-select");
  const statusEl = document.getElementById("pa-midi-status");
  if (!navigator.requestMIDIAccess) {
    select.innerHTML = '<option value="">Not supported in this browser — try Chrome or Edge</option>';
    return;
  }
  try {
    await paEnsureMidiAccess();
  } catch (e) {
    select.innerHTML = '<option value="">MIDI access denied</option>';
    statusEl.textContent = "MIDI access was denied — check your browser's site permissions.";
    return;
  }
  // A footswitch plugged in (or unplugged) later still shows up without a
  // reload — that is what the statechange handler above is for, and it now
  // does only this render rather than starting over.
  paRenderMidiDeviceList();
}

function wireMidiControls() {
  document.getElementById("pa-midi-device-select").addEventListener("change", (e) => {
    paSelectMidiDevice(e.target.value);
  });

  // CH-2: the per-pedal bypass rows don't exist in index.html — build them
  // before looking for their Learn… buttons below.
  paRenderBypassMidiRows();

  for (const action of PA_MIDI_ACTIONS) {
    const btn = document.getElementById(`pa-midi-${action.id}-learn-btn`);
    if (btn) btn.addEventListener("click", () => paMidiArmLearn(action.id));
    paMidiRenderMapping(action);
  }

  // CH-4: expression-pedal bindings live on their own pedal's card too.
  for (const target of PA_MIDI_EXPRESSION_TARGETS) {
    const btn = document.getElementById(`pa-midi-expr-${target.id}-learn-btn`);
    if (btn) btn.addEventListener("click", () => paMidiArmExpressionLearn(target.id));
    paMidiRenderExpression(target);
  }

  // Code-review finding: this used to call paRefreshMidiDevices() right
  // here, at page load — navigator.requestMIDIAccess() then fires (and
  // prompts for permission) for every single user on every single app
  // load, whether or not they own a footswitch or ever open Tone Lab.
  // Every other permission-gated integration in this app (camera, mic,
  // output device) is opt-in behind an explicit action; MIDI now matches
  // that — requested lazily, the first time Tone Lab actually opens (see
  // openToneLab).
}

function wireRigPresets() {
  document.getElementById("pa-preset-select").addEventListener("change", () => {
    paSyncPresetQuickpick();
  });

  // Play Along's quick-picker has no separate Load button — selecting a
  // name applies it immediately, mirroring the choice back onto Tone Lab's
  // dropdown so the two never disagree about which preset is live. This is
  // a raw one-off load, same as Tone Lab's own Load button below — it does
  // NOT touch this song's chain (paJumpToChainIndex/paAddToChain do that).
  document.getElementById("pa-preset-quickpick").addEventListener("change", async (e) => {
    const name = e.target.value;
    document.getElementById("pa-preset-select").value = name;
    if (!name) return;
    await paApplyRigState(paRigPresets[name]);
  });

  document.getElementById("pa-preset-load-btn").addEventListener("click", async () => {
    const name = document.getElementById("pa-preset-select").value;
    const statusEl = document.getElementById("pa-preset-status");
    if (!name) return;
    statusEl.textContent = "Loading preset…";
    await paApplyRigState(paRigPresets[name]);
    statusEl.textContent = `Loaded rig preset "${name}".`;
  });

  document.getElementById("pa-preset-save-btn").addEventListener("click", async () => {
    const nameEl = document.getElementById("pa-preset-name");
    const name = nameEl.value.trim();
    const statusEl = document.getElementById("pa-preset-status");
    if (!name) { statusEl.textContent = "Name this preset before saving."; return; }
    paRigPresets[name] = paCaptureRigState();
    await paSaveRigPresetsToServer();
    nameEl.value = "";
    await paRefreshRigPresets();
    document.getElementById("pa-preset-select").value = name;
    paSyncPresetQuickpick();
    statusEl.textContent = `Saved rig preset "${name}".`;
    if (typeof questMarkDone === "function") questMarkDone("tone");
  });

  document.getElementById("pa-preset-delete-btn").addEventListener("click", async () => {
    const name = document.getElementById("pa-preset-select").value;
    const statusEl = document.getElementById("pa-preset-status");
    if (!name || !(name in paRigPresets)) return;
    delete paRigPresets[name];
    await paSaveRigPresetsToServer();
    // GP-14: a preset that's part of this song's chain gets removed from
    // the chain too — a chain entry pointing at a deleted preset would
    // otherwise be silently unloadable the next time it's cycled to.
    const idx = (State.rigPresetChain || []).indexOf(name);
    if (idx !== -1) paRemoveFromChain(idx);
    await paRefreshRigPresets();
    statusEl.textContent = `Deleted rig preset "${name}".`;
  });

  document.getElementById("pa-preset-chain-add-btn").addEventListener("click", paAddToChain);

  // Shared "press the next key" capture, reused for both the forward and
  // backward rebind buttons.
  function wireCycleKeyChangeBtn(btnId, stateField, directionLabel) {
    document.getElementById(btnId).addEventListener("click", () => {
      const statusEl = document.getElementById("pa-preset-status");
      statusEl.textContent = `Press the key you want to cycle ${directionLabel}… (Esc to cancel)`;
      const capture = (e) => {
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for a real key
        e.preventDefault();
        e.stopPropagation();
        window.removeEventListener("keydown", capture, true);
        if (e.key === "Escape") { statusEl.textContent = "Cycle key unchanged."; return; }
        State[stateField] = e.key;
        saveProjectDebounced();
        renderPresetChainList();
        statusEl.textContent = `Cycle ${directionLabel} key set to "${paKeyLabel(e.key)}".`;
      };
      window.addEventListener("keydown", capture, true);
    });
  }
  wireCycleKeyChangeBtn("pa-cycle-key-forward-change-btn", "rigPresetCycleKeyForward", "forward");
  wireCycleKeyChangeBtn("pa-cycle-key-backward-change-btn", "rigPresetCycleKeyBackward", "backward");
  wireMidiControls();

  // Only active while Tone Lab or Play Along is open — both share the same
  // live rig (paSetActiveScreen/openToneLab/openPlayAlong). The Mixer's own
  // shortcuts (M/S/loop/etc., app.js) are scoped to State.stems.length being
  // loaded and stay unaffected; the one exception is Left/Right, which the
  // Mixer's own nudge shortcut deliberately skips while either rig screen
  // is open (app.js) so it doesn't fight this handler over the same key.
  document.addEventListener("keydown", (e) => {
    if (isTextInputFocused()) return;
    const toneLabOpen = document.getElementById("tonelab-overlay").classList.contains("show");
    const playAlongOpen = document.getElementById("playalong-overlay").classList.contains("show");
    if (!toneLabOpen && !playAlongOpen) return;
    if (e.key === (State.rigPresetCycleKeyForward || PA_DEFAULT_CYCLE_KEY_FORWARD)) {
      e.preventDefault();
      paCyclePresetChain(1);
    } else if (e.key === (State.rigPresetCycleKeyBackward || PA_DEFAULT_CYCLE_KEY_BACKWARD)) {
      e.preventDefault();
      paCyclePresetChain(-1);
    }
  });
}

// ---------------------------------------------------------------------------
// GP-07: riff capture rolling buffer — "Save that!" for an idea you only
// realize was worth keeping after you've already played it. Continuously
// captures the same live mix a real take does (recorder.js's
// ensureRecordBus — backing track + processed guitar) into a fixed-length
// PCM ring buffer (riff-capture-processor.js); nothing gets encoded to a
// file until Save that! actually asks for a dump. See that file's header
// for why this is a PCM ring buffer and not just a MediaRecorder with a
// sliding window of chunks (the short version: a container's header lives
// in its first chunk, so you can't drop old chunks off the front of a
// recording and keep a valid file).
// ---------------------------------------------------------------------------
const RIFF_CAPTURE_SECONDS = 20;
let riffCaptureNode = null;

// Code-review finding: same in-flight-build race as ensurePAGraph/
// ensureLooper (see ensurePAGraph's comment) — two near-simultaneous
// callers could both pass "if (riffCaptureNode) return" before the first's
// awaited addModule() resolves, each building its own worklet node. Same
// fix shape.
let riffCaptureBuildPromise = null;

async function ensureRiffCapture() {
  ensureCtx();
  if (riffCaptureNode) return;
  if (typeof ensureRecordBus !== "function") return; // recorder.js not loaded (shouldn't happen — it's always on the page)
  if (riffCaptureBuildPromise) return riffCaptureBuildPromise;
  riffCaptureBuildPromise = _buildRiffCapture().finally(() => { riffCaptureBuildPromise = null; });
  return riffCaptureBuildPromise;
}

async function _buildRiffCapture() {
  ensureRecordBus(); // recorder.js — backing + guitar mix
  await Audio.ctx.audioWorklet.addModule("riff-capture-processor.js");
  riffCaptureNode = new AudioWorkletNode(Audio.ctx, "riff-capture-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: { seconds: RIFF_CAPTURE_SECONDS },
  });
  Recorder.recordBus.connect(riffCaptureNode);
  // Never audible — this tap exists purely to keep the worklet in the
  // render graph's pull chain (an AudioWorkletNode with no path to
  // destination isn't guaranteed to have process() called).
  const sink = Audio.ctx.createGain();
  sink.gain.value = 0;
  riffCaptureNode.connect(sink).connect(Audio.ctx.destination);
}

// Minimal 16-bit PCM WAV encoder — riff captures don't go through
// MediaRecorder at all (see above), so this is the one place in the app
// that builds an audio file from raw samples by hand.
function wavEncode(left, right, sampleRate) {
  const numFrames = left.length;
  const numChannels = 2;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true); off += 2;
    view.setInt16(off, r < 0 ? r * 0x8000 : r * 0x7fff, true); off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function saveRiff() {
  const statusEl = document.getElementById("riff-status");
  if (!riffCaptureNode) { statusEl.textContent = "Riff capture isn't running yet — open Play Along first."; return; }
  statusEl.textContent = "Saving…";
  try {
    const dump = await new Promise((resolve) => {
      riffCaptureNode.port.onmessage = (e) => { if (e.data.type === "dumped") resolve(e.data); };
      riffCaptureNode.port.postMessage({ type: "dump" });
    });
    if (!dump.left.length) { statusEl.textContent = "Nothing captured yet — keep playing for a few seconds first."; return; }
    const blob = wavEncode(dump.left, dump.right, dump.sampleRate);
    const track = State.track || "";
    const saveResp = await fetch(`/api/recording/save?track=${encodeURIComponent(track)}&ext=wav&prefix=riff`, {
      method: "POST", body: blob,
    });
    const saveJson = await saveResp.json();
    if (!saveResp.ok) throw new Error(saveJson.error || `HTTP ${saveResp.status}`);
    statusEl.textContent = `Saved: ${saveJson.filename} (last ${RIFF_CAPTURE_SECONDS}s)`;
    if (typeof refreshTakesList === "function") refreshTakesList();
  } catch (e) {
    statusEl.textContent = "Failed to save: " + e.message;
  }
}

function wireRiffCapture() {
  document.getElementById("riff-save-btn").addEventListener("click", saveRiff);
}

// ---------------------------------------------------------------------------
// Metronome (lower half of the Riff Capture card).
//
// Deliberately independent of the loaded song's tempo: this is for practising
// to a click at a speed you choose, not for following the backing track.
//
// Clicks are SCHEDULED AHEAD on the audio clock rather than fired from a
// timer. setInterval is subject to main-thread jitter and throttles hard in a
// background tab, which is exactly when a metronome must not drift; a 25ms
// timer that only queues clicks 100ms into the future gets the timer's
// convenience with the audio clock's accuracy.
// ---------------------------------------------------------------------------

// How many clicks fall inside one quarter note. Triplet entries are the
// reason this is a table and not `value / 4` — 8th triplets are 3 per beat,
// which no arithmetic on the note value alone produces.
const METRO_SUBDIVISIONS = {
  "1": 0.25, "2": 0.5, "4": 1, "8": 2, "16": 4, "8t": 3, "16t": 6,
};
const METRO_LOOKAHEAD_SEC = 0.1;
const METRO_TIMER_MS = 25;
const METRO_TAP_TIMEOUT_SEC = 2.5;  // longer than this and it's a new count-in

const Metro = {
  on: false, bpm: 100, subdiv: "4", accentBeats: 4,
  // 1 is the click's designed level and the slider's centre. Above 1 is a
  // real boost, which is what a loud room needs; the click levels below are
  // set well under full scale so 2x still can't clip.
  volume: 1,
  gain: null, timer: null, nextTime: 0, click: 0, taps: [],
};

function metroClicksPerQuarter() {
  return METRO_SUBDIVISIONS[Metro.subdiv] || 1;
}

function metroInterval() {
  return (60 / Metro.bpm) / metroClicksPerQuarter();
}

// The accent lands every N quarter notes, not every N clicks — otherwise
// switching to 16ths would quietly move the accent to every 16th bar.
function metroAccentEvery() {
  if (!Metro.accentBeats) return 0;
  return Math.max(1, Math.round(metroClicksPerQuarter() * Metro.accentBeats));
}

// A synthesised click rather than a sample: no asset to ship, and the pitch
// difference between accent and beat is what makes the bar audible.
function metroScheduleClick(time, isAccent) {
  const ctx = Audio.ctx;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = isAccent ? 1600 : 1000;
  // Short exponential decay: a click with a slow tail smears the downbeat and
  // is the usual reason a metronome feels "behind" the note you play.
  env.gain.setValueAtTime(0.0001, time);
  env.gain.exponentialRampToValueAtTime(isAccent ? 0.5 : 0.28, time + 0.001);
  env.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
  osc.connect(env).connect(Metro.gain);
  osc.start(time);
  osc.stop(time + 0.06);

  // Beacon flash, aligned to when the click will actually sound.
  const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
  setTimeout(() => metroFlash(isAccent), delayMs);
}

function metroFlash(isAccent) {
  const el = document.getElementById("metro-beacon");
  // Shared beacon between Click and Drum kit modes (drumScheduleHit reuses
  // this same function for kick/snare hits) — checked against whichever
  // pulse is actually running, not just the Metronome's own state.
  if (!el || !(Metro.on || Drums.on)) return;
  el.classList.remove("beat", "accent");
  void el.offsetWidth;  // restart the transition even on back-to-back clicks
  el.classList.add(isAccent ? "accent" : "beat");
  setTimeout(() => el.classList.remove("beat", "accent"), 80);
}

function metroTick() {
  if (!Metro.on) return;
  const ctx = Audio.ctx;
  while (Metro.nextTime < ctx.currentTime + METRO_LOOKAHEAD_SEC) {
    const every = metroAccentEvery();
    metroScheduleClick(Metro.nextTime, every > 0 && Metro.click % every === 0);
    Metro.nextTime += metroInterval();
    Metro.click++;
  }
}

function metroStart() {
  ensureCtx();
  if (Audio.ctx.state === "suspended") Audio.ctx.resume();
  if (!Metro.gain) {
    Metro.gain = Audio.ctx.createGain();
    Metro.gain.gain.value = Metro.volume;
    // Straight to the speakers, NOT through the rig: the click is a
    // practice aid, and routing it into the pedal chain would put it in
    // Riff Capture takes and looper overdubs.
    Metro.gain.connect(Audio.ctx.destination);
  }
  Metro.on = true;
  Metro.click = 0;
  Metro.nextTime = Audio.ctx.currentTime + 0.06;
  Metro.timer = setInterval(metroTick, METRO_TIMER_MS);
  metroTick();
  metroRender();
}

function metroStop() {
  Metro.on = false;
  if (Metro.timer) { clearInterval(Metro.timer); Metro.timer = null; }
  const el = document.getElementById("metro-beacon");
  if (el) el.classList.remove("beat", "accent");
  metroRender();
}

function metroSetBpm(bpm) {
  Metro.bpm = Math.min(300, Math.max(1, Math.round(bpm)));
  const slider = document.getElementById("metro-bpm");
  if (slider) slider.value = String(Metro.bpm);
  // Re-anchor so a tempo change takes effect on the NEXT click instead of
  // waiting out an already-scheduled interval at the old tempo. Drums reads
  // Metro.bpm directly (drum-machine-spec.md §6 — one shared BPM, not a
  // second copy that could drift out of sync with the slider), so a running
  // drum loop needs the exact same re-anchor the click gets.
  if (Metro.on) Metro.nextTime = Math.min(Metro.nextTime, Audio.ctx.currentTime + metroInterval());
  if (Drums.on) Drums.nextTime = Math.min(Drums.nextTime, Audio.ctx.currentTime + drumStepInterval());
  metroRender();
}

function metroSetVolume(v) {
  Metro.volume = Math.min(2, Math.max(0, v));
  // Ramp rather than jump: a step change on a gain node that already has
  // scheduled clicks running through it is an audible tick of its own. One
  // shared volume slider drives both Metro.gain and Drums.gain — whichever
  // mode isn't currently running just gets a silent value update for when
  // it's next started.
  if (Metro.gain) {
    Metro.gain.gain.setTargetAtTime(Metro.volume, Audio.ctx.currentTime, 0.01);
  }
  if (Drums.gain) {
    Drums.gain.gain.setTargetAtTime(Metro.volume, Audio.ctx.currentTime, 0.01);
  }
}

function metroRender() {
  const v = document.getElementById("metro-bpm-value");
  if (v) v.textContent = String(Metro.bpm);
  const isOn = MetroMode === "drums" ? Drums.on : Metro.on;
  const btn = document.getElementById("metro-toggle-btn");
  if (btn) {
    btn.textContent = isOn ? "Stop" : "Start";
    btn.classList.toggle("primary", !isOn);
  }
}

function metroTap() {
  const now = performance.now() / 1000;
  if (Metro.taps.length && now - Metro.taps[Metro.taps.length - 1] > METRO_TAP_TIMEOUT_SEC) {
    Metro.taps = [];
  }
  Metro.taps.push(now);
  if (Metro.taps.length > 5) Metro.taps.shift();
  if (Metro.taps.length < 2) return;
  const gaps = [];
  for (let i = 1; i < Metro.taps.length; i++) gaps.push(Metro.taps[i] - Metro.taps[i - 1]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean > 0) metroSetBpm(60 / mean);
}

function wireMetronome() {
  const slider = document.getElementById("metro-bpm");
  slider.addEventListener("input", () => metroSetBpm(Number(slider.value)));
  document.getElementById("metro-minus-btn").addEventListener("click", () => metroSetBpm(Metro.bpm - 1));
  document.getElementById("metro-plus-btn").addEventListener("click", () => metroSetBpm(Metro.bpm + 1));
  document.getElementById("metro-tap-btn").addEventListener("click", metroTap);
  const vol = document.getElementById("metro-volume");
  vol.addEventListener("input", () => metroSetVolume(Number(vol.value) / 100));
  // Double-click snaps back to the default level, the same gesture the mixer
  // faders use for their reset.
  vol.addEventListener("dblclick", () => { vol.value = "100"; metroSetVolume(1); });
  document.getElementById("metro-toggle-btn").addEventListener("click", () => {
    if (MetroMode === "drums") {
      if (Drums.on) drumStop(); else drumStart();
    } else {
      if (Metro.on) metroStop(); else metroStart();
    }
  });
  document.getElementById("metro-subdiv").addEventListener("change", (e) => {
    Metro.subdiv = e.target.value;
    // Restart the click counter so the accent lands on the next click
    // rather than partway through a bar at the new subdivision.
    Metro.click = 0;
    if (Metro.on) Metro.nextTime = Math.min(Metro.nextTime, Audio.ctx.currentTime + metroInterval());
  });
  document.getElementById("metro-accent").addEventListener("change", (e) => {
    Metro.accentBeats = Number(e.target.value);
    Metro.click = 0;
  });
  metroRender();
}

// ---------------------------------------------------------------------------
// drum-machine-spec.md: a second "mode" of this same practice-pulse section
// — loops a standard rock beat instead of a plain click. Shares the
// Metronome's BPM/Start-Stop/Volume controls rather than duplicating them
// (metroSetMode below swaps which control row is visible), and reuses its
// look-ahead scheduling idiom verbatim, generalized from "one evenly-spaced
// click" to "walk a pattern grid of steps, each step firing zero or more
// sampled drum hits."
// ---------------------------------------------------------------------------

let MetroMode = "click"; // "click" | "drums"

// Steps are 16th notes except "shuffle", which is a 12-steps-per-bar triplet
// feel — stepsPerBar has to be data per pattern, not assumed universally, or
// the shuffle's swing would collapse into straight 16ths.
const DRUM_PATTERNS = {
  basicRock:   { stepsPerBar: 16, kick: [0,6,8],    snare: [4,12], hihatClosed: [0,2,4,6,8,10,12,14] },
  driving:     { stepsPerBar: 16, kick: [0,6,8,14], snare: [4,12], hihatClosed: [0,2,4,6,8,10,12,14] },
  fourOnFloor: { stepsPerBar: 16, kick: [0,4,8,12], snare: [4,12], hihatClosed: [0,2,4,6,8,10,12,14] },
  ballad:      { stepsPerBar: 16, kick: [0,6],       snare: [8],    hihatClosed: [0,2,4,6,8,10,12,14] },
  punk:        { stepsPerBar: 16, kick: [0,6,8],    snare: [4,12], hihatClosed: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] },
  shuffle:     { stepsPerBar: 12, kick: [0,6],       snare: [3,9],  hihatClosed: [0,2,3,5,6,8,9,11] },
};

const DRUM_SAMPLE_FILES = {
  kick: "drums/kick.wav",
  snare: "drums/snare.wav",
  hihatClosed: "drums/hihat_closed.wav",
  crash: "drums/crash.wav",
};

const Drums = {
  on: false, patternId: "basicRock",
  gain: null, timer: null, nextTime: 0, stepIndex: 0, barCount: 0,
  buffers: null, buffersPromise: null,
};

// Same in-flight-build-race guard idiom as ensurePAGraph/ensureLooper/
// ensureRiffCapture — decodeAudioData is async, so a second call landing
// before the first's fetch+decode resolves has to reuse the SAME in-flight
// promise, not kick off a second fetch of every sample.
async function ensureDrumBuffers() {
  if (Drums.buffers) return Drums.buffers;
  if (!Drums.buffersPromise) {
    Drums.buffersPromise = (async () => {
      const entries = await Promise.all(
        Object.entries(DRUM_SAMPLE_FILES).map(async ([name, url]) => {
          const arr = await (await fetch(url)).arrayBuffer();
          const buf = await Audio.ctx.decodeAudioData(arr);
          return [name, buf];
        })
      );
      return Object.fromEntries(entries);
    })();
  }
  Drums.buffers = await Drums.buffersPromise;
  return Drums.buffers;
}

function drumStepInterval() {
  const pattern = DRUM_PATTERNS[Drums.patternId];
  // The same BPM the Metronome slider drives, read directly rather than
  // kept as a second copy — the two are never meaningfully different
  // tempos in practice (see §6 of the spec).
  return (60 / Metro.bpm) * (4 / pattern.stepsPerBar);
}

function drumScheduleHit(name, time) {
  const buf = Drums.buffers && Drums.buffers[name];
  if (!buf) return; // buffers still loading — this hit is silently skipped, not queued late
  const src = Audio.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(Drums.gain);
  src.start(time);
  // Reuse the Metronome's beacon for kick/snare only — hihat fires on
  // nearly every step in most of these patterns, so flashing on it too
  // would read as flicker rather than a useful downbeat cue.
  if (name === "kick" || name === "snare") {
    const delayMs = Math.max(0, (time - Audio.ctx.currentTime) * 1000);
    setTimeout(() => metroFlash(name === "kick"), delayMs);
  }
}

function drumTick() {
  if (!Drums.on) return;
  const pattern = DRUM_PATTERNS[Drums.patternId];
  while (Drums.nextTime < Audio.ctx.currentTime + METRO_LOOKAHEAD_SEC) {
    if (pattern.kick.includes(Drums.stepIndex)) drumScheduleHit("kick", Drums.nextTime);
    if (pattern.snare.includes(Drums.stepIndex)) drumScheduleHit("snare", Drums.nextTime);
    if (pattern.hihatClosed.includes(Drums.stepIndex)) drumScheduleHit("hihatClosed", Drums.nextTime);
    // One crash, on the very first step of the very first bar only — a real
    // drummer doesn't crash on every single loop repeat, and this pattern is
    // meant to loop indefinitely.
    if (Drums.stepIndex === 0 && Drums.barCount === 0) drumScheduleHit("crash", Drums.nextTime);
    Drums.nextTime += drumStepInterval();
    Drums.stepIndex = (Drums.stepIndex + 1) % pattern.stepsPerBar;
    if (Drums.stepIndex === 0) Drums.barCount++;
  }
}

async function drumStart() {
  if (Drums.on) return;
  // Flip this immediately (before the await below) rather than after
  // buffers finish loading — otherwise a Stop click landing while the
  // first fetch+decode is still in flight would see Drums.on still false
  // and call drumStart() again instead of actually stopping it.
  Drums.on = true;
  metroRender();
  ensureCtx();
  if (Audio.ctx.state === "suspended") Audio.ctx.resume();
  if (!Drums.gain) {
    Drums.gain = Audio.ctx.createGain();
    Drums.gain.gain.value = Metro.volume;
    // Straight to the speakers, NOT through the rig and NOT into
    // Recorder.recordBus — same reasoning as the plain click: this is a
    // practice aid, not part of the take, so it stays out of Riff Capture
    // and any recorded take (drum-machine-spec.md §6).
    Drums.gain.connect(Audio.ctx.destination);
  }
  await ensureDrumBuffers();
  if (!Drums.on) return; // stopped again while buffers were still loading
  Drums.stepIndex = 0;
  Drums.barCount = 0;
  Drums.nextTime = Audio.ctx.currentTime + 0.06;
  Drums.timer = setInterval(drumTick, METRO_TIMER_MS);
  drumTick();
}

function drumStop() {
  Drums.on = false;
  if (Drums.timer) { clearInterval(Drums.timer); Drums.timer = null; }
  const el = document.getElementById("metro-beacon");
  if (el) el.classList.remove("beat", "accent");
  metroRender();
}

function drumSetPattern(id) {
  if (!DRUM_PATTERNS[id]) return;
  Drums.patternId = id;
  // Restart from the top of the bar rather than partway through the old
  // pattern's grid at whatever stepIndex happened to be current — the same
  // "restart the counter on a settings change" idiom metro-subdiv already
  // uses.
  Drums.stepIndex = 0;
  Drums.barCount = 0;
}

function metroSetMode(mode) {
  if (mode === MetroMode) return;
  const wasOn = MetroMode === "drums" ? Drums.on : Metro.on;
  if (MetroMode === "drums") drumStop(); else metroStop();
  MetroMode = mode;
  document.getElementById("metro-mode-click-btn").classList.toggle("active", mode === "click");
  document.getElementById("metro-mode-drums-btn").classList.toggle("active", mode === "drums");
  document.getElementById("metro-click-controls").style.display = mode === "click" ? "" : "none";
  document.getElementById("metro-drum-controls").style.display = mode === "drums" ? "" : "none";
  document.getElementById("metro-hint").style.display = mode === "click" ? "" : "none";
  document.getElementById("metro-drum-hint").style.display = mode === "drums" ? "" : "none";
  // Carry the transport state across the mode switch instead of forcing a
  // manual Start again — the shared Start/Stop button already reads as "is
  // the pulse running," and silently stopping it on what's meant to be a
  // cosmetic switch would be a surprising side effect.
  if (wasOn) { if (mode === "drums") drumStart(); else metroStart(); }
  metroRender();
}

function wireDrumMachine() {
  document.getElementById("metro-mode-click-btn").addEventListener("click", () => metroSetMode("click"));
  document.getElementById("metro-mode-drums-btn").addEventListener("click", () => metroSetMode("drums"));
  document.getElementById("metro-drum-pattern").addEventListener("change", (e) => drumSetPattern(e.target.value));
}

// ---------------------------------------------------------------------------
// GP-06 (looper-pedal-spec.md): real-time loop recorder/overdubber, top-strip
// card next to Riff Capture. All the actual DSP state machine lives in
// looper-processor.js — this is the main-thread control surface: setting up
// the worklet + PA.loopSum tap once (§2 of the spec), driving it via
// postMessage, and rendering its acks into the Looper card's UI.
// ---------------------------------------------------------------------------

// Code-review finding: same in-flight-build race ensurePAGraph had — see
// its own comment above for the failure mode (two near-simultaneous
// callers both pass "if (PA.looperNode) return" before the first's
// awaited addModule() resolves, so both build a full second looper node,
// permanently orphaning the first). Same fix shape.
let paLooperBuildPromise = null;

async function ensureLooper() {
  ensureCtx();
  if (PA.looperNode) return;
  if (paLooperBuildPromise) return paLooperBuildPromise;
  paLooperBuildPromise = _buildLooper().finally(() => { paLooperBuildPromise = null; });
  return paLooperBuildPromise;
}

async function _buildLooper() {
  await Audio.ctx.audioWorklet.addModule("looper-processor.js");
  PA.looperNode = new AudioWorkletNode(Audio.ctx, "looper-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
  });
  // Record tap: PA.outputMute (post-effects guitar, never the backing
  // track). Playback return: PA.loopSum (§2 — one node downstream of
  // outputMute, so a Take/Riff Capture recorded while the loop plays
  // actually contains it).
  PA.outputMute.connect(PA.looperNode);
  PA.looperNode.connect(PA.loopSum);
  PA.looperNode.port.onmessage = (e) => paHandleLooperMessage(e.data);
}

// One bar's length in frames at the song's detected BPM (assuming 4/4 —
// same known limitation the Click already carries, USER-MANUAL.md §9) —
// null (free-running) if no track/BPM. The worklet itself rounds the
// actually-recorded length to the nearest whole multiple of this; see
// looper-processor.js's own comment on why that rounding has to happen
// worklet-side, not here.
function paLooperBarLengthFrames() {
  const bpm = State.analysis && State.analysis.bpm;
  if (!bpm || !Audio.ctx) return null;
  const secondsPerBar = (60 / bpm) * 4;
  return Math.round(secondsPerBar * Audio.ctx.sampleRate);
}

function paLooperUpdateUI() {
  const primaryBtn = document.getElementById("looper-primary-btn");
  const stopBtn = document.getElementById("looper-stop-btn");
  const undoBtn = document.getElementById("looper-undo-btn");
  const clearBtn = document.getElementById("looper-clear-btn");
  const hasLoop = ["playing", "overdubbing", "stopped"].includes(PA.looperState);
  stopBtn.style.display = hasLoop ? "inline-block" : "none";
  clearBtn.style.display = hasLoop ? "inline-block" : "none";
  undoBtn.style.display = hasLoop ? "inline-block" : "none";

  const labels = {
    idle: "● Record",
    recording: "■ Stop && Loop",
    playing: "● Overdub",
    overdubbing: "■ Stop Overdub",
    stopped: "● Play",
  };
  primaryBtn.textContent = labels[PA.looperState] || "● Record";

  const hintEl = document.getElementById("looper-length-hint");
  if (!PA.looperLengthFrames) {
    hintEl.textContent = "";
  } else if (PA.looperBars) {
    hintEl.textContent = `Loop length: locked to ${PA.looperBars} bar${PA.looperBars === 1 ? "" : "s"} (${Math.round(PA.looperBpm)} BPM).`;
  } else {
    // "no song loaded" was the only reason this branch could be reached
    // before; a take that lands too far off a bar boundary to snap now
    // reaches it too (see LOOP_BAR_SNAP_TOLERANCE in looper-processor.js),
    // so say which case it actually is rather than assert the wrong one.
    const why = (State.analysis && State.analysis.bpm)
      ? "free-running — take wasn't close enough to a whole bar to snap"
      : "free-running — no song loaded";
    hintEl.textContent = `Loop length: ${(PA.looperLengthFrames / Audio.ctx.sampleRate).toFixed(1)}s (${why}).`;
  }
}

async function paLooperSaveToDisk() {
  if (!PA.looperNode || !State.track) return;
  const dump = await new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.data.type !== "dumped") return;
      PA.looperNode.port.removeEventListener("message", onMsg);
      resolve(e.data);
    };
    PA.looperNode.port.addEventListener("message", onMsg);
    PA.looperNode.port.postMessage({ type: "dump" });
  });
  if (!dump.left.length) return; // nothing committed yet — Stop from "recording" never reaches here anyway
  const blob = wavEncode(dump.left, dump.right, dump.sampleRate);
  try {
    await fetch(`/api/recording/save?track=${encodeURIComponent(State.track)}&ext=wav&prefix=loop`, {
      method: "POST", body: blob,
    });
  } catch (e) { /* best-effort — losing the auto-save shouldn't block Stop itself */ }
}

// Real user-facing state transitions — one function per primary-button
// press, matching looper-pedal-spec.md §4's table exactly.
function paLooperPrimaryPress() {
  if (!PA.looperNode) return;
  const barLengthFrames = paLooperBarLengthFrames();
  if (PA.looperState === "idle") {
    PA.looperNode.port.postMessage({ type: "start_record" });
  } else if (PA.looperState === "recording") {
    PA.looperBpm = State.analysis && State.analysis.bpm;
    PA.looperNode.port.postMessage({ type: "stop_and_loop", barLengthFrames });
  } else if (PA.looperState === "playing") {
    PA.looperNode.port.postMessage({ type: "start_overdub" });
  } else if (PA.looperState === "overdubbing") {
    PA.looperNode.port.postMessage({ type: "stop_overdub" });
  } else if (PA.looperState === "stopped") {
    PA.looperNode.port.postMessage({ type: "resume" });
  }
}

function paLooperStopPress() {
  if (!PA.looperNode) return;
  PA.looperNode.port.postMessage({ type: "stop" });
}

function paLooperUndoPress() {
  if (!PA.looperNode) return;
  PA.looperNode.port.postMessage({ type: "undo" });
}

function paLooperClearPress() {
  if (!PA.looperNode) return;
  PA.looperNode.port.postMessage({ type: "clear" });
}

function paHandleLooperMessage(data) {
  const statusEl = document.getElementById("looper-status");
  switch (data.type) {
    case "started_recording":
      PA.looperState = "recording";
      statusEl.textContent = "Recording…";
      break;
    case "looped":
      PA.looperState = "playing";
      PA.looperLengthFrames = data.lengthFrames;
      PA.looperBars = data.bars;
      statusEl.textContent = "Looping.";
      break;
    case "overdub_started":
      PA.looperState = "overdubbing";
      statusEl.textContent = "Overdubbing…";
      break;
    case "overdub_stopped":
      PA.looperState = "playing";
      statusEl.textContent = "Overdub added.";
      break;
    case "stopped":
      PA.looperState = "stopped";
      statusEl.textContent = "Stopped — press Record/Overdub button to resume, or Clear to start over.";
      paLooperSaveToDisk(); // §5: Stop (not Clear) is the save point
      break;
    case "resumed":
      PA.looperState = "playing";
      statusEl.textContent = "Looping.";
      break;
    case "undone":
      statusEl.textContent = "Last overdub undone.";
      break;
    case "undo_failed":
      statusEl.textContent = "Nothing to undo.";
      break;
    case "cleared":
      PA.looperState = "idle";
      PA.looperLengthFrames = 0;
      PA.looperBars = null;
      statusEl.textContent = "";
      break;
    case "loaded":
      PA.looperState = "stopped";
      statusEl.textContent = "Loaded a saved loop for this song — press the button to resume.";
      break;
  }
  paLooperUpdateUI();
}

// §5: reopening a song with a previously-saved loop loads it paused/ready,
// never auto-playing — same "explicit action to reactivate something
// saved" posture the manual key-correction Reset button and rig-preset
// auto-recall both already use. Same once-per-track guard as
// paApplyAttachedRigPreset (State.rigPresetApplied) — State.looperLoaded.
async function paLoadSavedLoop() {
  if (State.looperLoaded || !State.track) return;
  State.looperLoaded = true; // before the await — a second call while this is in flight shouldn't double-load
  await ensureLooper();
  let takes;
  try {
    const r = await Api.get(`/api/recordings?track=${encodeURIComponent(State.track)}`);
    takes = r.takes;
  } catch (e) { return; }
  const loopFiles = takes
    .map((t) => ({ ...t, num: (t.filename.match(/loop (\d+)/i) || [])[1] }))
    .filter((t) => t.num != null)
    .sort((a, b) => Number(b.num) - Number(a.num));
  if (!loopFiles.length) return;
  const latest = loopFiles[0];
  try {
    const buf = await (await fetch(`/api/output?path=${encodeURIComponent(latest.path)}`)).arrayBuffer();
    const audioBuf = await Audio.ctx.decodeAudioData(buf);
    // .slice() (not the raw AudioBuffer-owned array) so each channel has
    // its own real, transferable ArrayBuffer — getChannelData's own buffer
    // isn't guaranteed transferable/detachable the same way.
    const left = audioBuf.getChannelData(0).slice();
    const right = (audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : audioBuf.getChannelData(0)).slice();
    // Read .length and set PA state BEFORE posting — postMessage's transfer
    // list detaches left.buffer/right.buffer SYNCHRONOUSLY the instant it's
    // called (that's the whole point of a transfer — zero-copy), so reading
    // left.length afterward would silently return 0 (a detached TypedArray
    // reads as empty, not an error) instead of the real length.
    PA.looperLengthFrames = left.length;
    PA.looperBars = null; // a reloaded loop's original bar-count isn't tracked across a reload — shown as free-running length instead, still accurate
    PA.looperNode.port.postMessage({ type: "load", left, right }, [left.buffer, right.buffer]);
  } catch (e) { /* best-effort — a missing/corrupt saved loop shouldn't block opening the song */ }
}

function wireLooper() {
  document.getElementById("looper-primary-btn").addEventListener("click", paLooperPrimaryPress);
  document.getElementById("looper-stop-btn").addEventListener("click", paLooperStopPress);
  document.getElementById("looper-undo-btn").addEventListener("click", paLooperUndoPress);
  document.getElementById("looper-clear-btn").addEventListener("click", paLooperClearPress);
  paLooperUpdateUI();
  paUpdateLooperMidiHint();
}

wirePAControls();
renderChainIcons();
paOpenChainCard("gate"); // panel is never empty on first load — Gate's bypass is the first thing shown
// Any bypass checkbox changing (typed, dragged, or set by a rig preset
// via paSetControlChecked, which redispatches the same "change" event)
// should update the icon strip's on/dim state — one delegated listener
// instead of every bypass wiring site remembering to call this itself.
document.getElementById("pa-pedalboard").addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"][id$="-bypass"]')) paRefreshChainIconStates();
});
wireSuggestSampleSize();
// Best-effort: a settings fetch that fails just leaves the default in place.
Api.get("/api/settings").then((s) => {
  if (s && Number.isFinite(Number(s.nam_suggest_sample_size))) {
    PA.suggestSampleSize = Number(s.nam_suggest_sample_size);
    const input = document.getElementById("pa-suggest-sample");
    if (input) input.value = String(PA.suggestSampleSize);
    paRenderSuggestSampleHint();
  }
}).catch(() => { /* default stands */ });
wireRigPresets();
wireRiffCapture();
wireMetronome();
wireDrumMachine();
wireLooper();
// #pa-latency-hint lives on the Output card, which moved into Tone Lab
// along with the rest of #pa-pedalboard — this listener moved with it.
document.getElementById("tonelab-open-btn").addEventListener("click", paShowLatencyEstimate);

// ui-review-v5-full.md §2.5: global rig status pill — click jumps straight
// to Tone Lab (the Input card sits at the very top, so no further scroll
// is needed). Initialized once at load in the "silent" state.
document.getElementById("rig-status-pill").addEventListener("click", openToneLab);
paUpdateRigPill();
// Real gap the nav quiet/active contrast fix (ui-review-v5-full.md §2.3)
// surfaced: every nav button was solid accent color by the old house
// style, so Mixer never visibly being "active" on initial load was
// invisible. Now that inactive buttons are quiet, Mixer needs the same
// paSetActiveScreen("mixer-open-btn") call closeAllScreens already makes
// when returning to it — just also on first load, before any screen has
// been opened yet.
paSetActiveScreen("mixer-open-btn");
