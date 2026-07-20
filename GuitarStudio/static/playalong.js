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
};

// ---------------------------------------------------------------------------
// NAM WASM/SIMD module — compiled once here on the main thread and handed
// to every "nam-processor" AudioWorkletNode we create (the live node in
// ensurePAGraph, plus every throwaway probe node in paProbeNamModel and the
// Suggest loop below). AudioWorkletGlobalScope can't reliably fetch or
// streaming-compile wasm itself in every browser, so this is the one place
// that ever touches the network for it; a compiled WebAssembly.Module is
// structured-clone-transferable over a MessagePort, so each worklet
// instantiates its own Instance (its own private linear memory) from the
// same compiled Module, cheaply.
//
// Strictly best-effort: any failure here (fetch fails, browser lacks wasm
// SIMD, compile throws) just leaves paNamWasmModulePromise resolved to
// null, and every call site below skips sending a "wasm-module" message —
// nam-processor.js's own fallback (buildModelAny/forwardBlockAny) then
// silently stays on the JS engine, exactly like it does for a model whose
// architecture the WASM path can't handle. Never a hard failure.
let paNamWasmModulePromise = null;
function paGetNamWasmModule() {
  if (!paNamWasmModulePromise) {
    paNamWasmModulePromise = (async () => {
      try {
        const bytes = await (await fetch("nam.wasm")).arrayBuffer();
        return await WebAssembly.compile(bytes);
      } catch (e) {
        console.warn("NAM WASM engine unavailable, falling back to JS engine:", e);
        return null;
      }
    })();
  }
  return paNamWasmModulePromise;
}
// Sends the compiled module (if available) to a freshly-created nam-processor
// node's port, BEFORE any "load" message for the same node — nam-processor.js
// awaits its own in-flight instantiation before deciding which engine a
// pending "load" uses, so message order (not a round-trip ack) is what makes
// this race-free.
async function paSendNamWasmModule(node) {
  const mod = await paGetNamWasmModule();
  if (mod) node.port.postMessage({ type: "wasm-module", module: mod });
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

async function ensurePAGraph() {
  ensureCtx(); // app.js — same context/graph as backing-track playback
  if (PA.built) return;
  await Audio.ctx.audioWorklet.addModule("gate-processor.js");
  await Audio.ctx.audioWorklet.addModule("nam-processor.js");
  await Audio.ctx.audioWorklet.addModule("octave-processor.js");

  PA.inAnal = Audio.ctx.createAnalyser();
  PA.inAnal.fftSize = 8192; // GP-01 needs several full cycles of a low guitar E (~82Hz) for accurate autocorrelation

  PA.gateNode = new AudioWorkletNode(Audio.ctx, "gate-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
  });

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
  const cabTone = Audio.ctx.createBiquadFilter(); cabTone.type = "lowpass"; cabTone.frequency.value = 5000; cabTone.Q.value = 0.75;
  const bass = Audio.ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 150;
  const mid = Audio.ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 800; mid.Q.value = 0.7;
  const treble = Audio.ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
  inputGain.connect(preTight).connect(preEmph).connect(shaper).connect(dcBlock)
    .connect(deEmph).connect(voiceWarm).connect(voiceScoop).connect(cabTone)
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

  // Reverb (same mix-gain-as-bypass pattern)
  PA.reverbConvolver = Audio.ctx.createConvolver();
  PA.reverbConvolver.buffer = paMakeReverbImpulse(Audio.ctx, 1.5, 2.5);
  PA.reverbWet = Audio.ctx.createGain(); PA.reverbWet.gain.value = 0;
  PA.delayMerge.connect(PA.reverbConvolver).connect(PA.reverbWet);
  PA.reverbMerge = Audio.ctx.createGain();
  PA.delayMerge.connect(PA.reverbMerge);
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
  PA.outputGain.connect(PA.outputMute).connect(PA.outAnal).connect(Audio.ctx.destination);

  // GP-03: each stage's fan-in nodes (what the PREVIOUS stage's output must
  // connect to) and its single fan-out node (what feeds the NEXT stage).
  // v3.1: extended from 4 to 12 stages (post-v3-backlog-audit.md §2.2).
  // v4.7: gate/amp joined this map too (previously hardcoded as fixed
  // chain endpoints in rewirePedalChain) so Amp can be reordered like any
  // other stage — gate's own node serves as both its fan-in and fan-out
  // (a single AudioWorkletNode); amp's fan-in is PA.ampIn, the one node
  // every mode's entry point fans out from (see setAmpMode).
  PA.pedalStages = {
    gate: { inputs: [PA.gateNode], output: PA.gateNode },
    amp: { inputs: [PA.ampIn], output: PA.ampOut },
    ir: { inputs: [PA.irDryGain, PA.convolver], output: PA.irMerge },
    eq: { inputs: [eqBass], output: eqTreble },
    comp: { inputs: [PA.compBypassDry, PA.compressor], output: PA.compMerge },
    fx: { inputs: [PA.delayNode, PA.delayMerge], output: PA.reverbMerge },
    boost: { inputs: [PA.boostDryGain, PA.boostShaper], output: PA.boostMerge },
    geq: { inputs: [PA.geqNodes[100]], output: PA.geqNodes[8000] },
    chorus: { inputs: [PA.chorusDelay, PA.chorusMerge], output: PA.chorusMerge },
    flanger: { inputs: [PA.flangerDelay, PA.flangerMerge], output: PA.flangerMerge },
    phaser: { inputs: [PA.phaserStages[0], PA.phaserMerge], output: PA.phaserMerge },
    tremolo: { inputs: [PA.tremoloGain], output: PA.tremoloGain },
    wah: { inputs: [PA.wahFilter, PA.wahDryGain], output: PA.wahMerge },
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
const PA_PEDAL_ORDER_KEY = "gs_pa_pedal_order";
// v3.1: grew from 4 to 12 stages (post-v3-backlog-audit.md §2.2). v4.7:
// grew to 13 — Amp joined the reorderable set (a pedal like Wah or Boost
// can now sit between the guitar and the amp), placed first by default so
// today's "amp immediately follows gate" behavior is unchanged until a
// player actually drags it. A stored order that isn't a permutation of
// ALL of these (e.g. a pre-v4.7 12-item order with no "amp") fails
// paLoadPedalOrder's validation below and falls back to this default — no
// migration code needed, same self-healing behavior each prior stage-count
// change already had.
const PA_DEFAULT_PEDAL_ORDER = [
  "amp", "wah", "octaver", "boost", "comp", "ir", "geq",
  "eq", "chorus", "phaser", "flanger", "tremolo", "fx",
];

function paLoadPedalOrder() {
  try {
    const stored = JSON.parse(localStorage.getItem(PA_PEDAL_ORDER_KEY) || "null");
    // Defensive: only trust a stored order if it's exactly a permutation of
    // the four known stages — a stale/foreign value falls back to default
    // rather than dropping a stage's audio out of the chain entirely.
    if (Array.isArray(stored) && stored.length === PA_DEFAULT_PEDAL_ORDER.length &&
        PA_DEFAULT_PEDAL_ORDER.every((id) => stored.includes(id))) {
      return stored;
    }
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

  const prevChain = ["gate", ...(PA.wiredPedalOrder || [])];
  for (let i = 0; i < prevChain.length - 1; i++) {
    const out = stageOutput(prevChain[i]);
    for (const inp of PA.pedalStages[prevChain[i + 1]].inputs) {
      try { out.disconnect(inp); } catch (e) { /* wasn't connected */ }
    }
  }
  if (PA.wiredPedalOrder) {
    try { stageOutput(prevChain[prevChain.length - 1]).disconnect(PA.outputGain); } catch (e) { /* wasn't connected */ }
  }

  const chain = ["gate", ...PA.pedalOrder];
  for (let i = 0; i < chain.length - 1; i++) {
    const out = stageOutput(chain[i]);
    for (const inp of PA.pedalStages[chain[i + 1]].inputs) out.connect(inp);
  }
  stageOutput(chain[chain.length - 1]).connect(PA.outputGain);

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
    PA.source.connect(PA.gateNode);
    PA.source.connect(PA.inAnal);

    // GP-10: a new input session clears the latched clip light — it's
    // meant to persist through one practice session, not forever.
    PA.inputClipped = false;
    updateClipIndicator();

    hintEl.textContent = "Input enabled.";
    await paRefreshDevices(); // device labels only populate after permission is granted
    // v3.1: persist whichever device actually just succeeded — including
    // the very first auto-picked default — so future sessions start here
    // instead of re-deriving the same heuristic from scratch every time.
    const activeId = document.getElementById("pa-device-select").value;
    if (activeId) localStorage.setItem(PA_INPUT_DEVICE_KEY, activeId);
    paStartMeters();
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
  if (rms < 0.01) return -1; // too quiet to trust

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

function paResetTunerDisplay(hint) {
  document.getElementById("pa-tuner-note").textContent = "—";
  document.getElementById("pa-tuner-cents").textContent = hint;
  const needleEl = document.getElementById("pa-tuner-needle");
  needleEl.style.left = "50%";
  needleEl.classList.remove("in-tune");
}

function paUpdateTuner(inData) {
  const freq = paAutoCorrelate(inData, Audio.ctx.sampleRate);
  if (freq < 0) {
    paResetTunerDisplay("Enable input and play a single note.");
    return;
  }
  const noteEl = document.getElementById("pa-tuner-note");
  const centsEl = document.getElementById("pa-tuner-cents");
  const needleEl = document.getElementById("pa-tuner-needle");
  const { name, cents } = paFreqToNote(freq);
  noteEl.textContent = name;
  centsEl.textContent = `${freq.toFixed(1)} Hz, ${cents >= 0 ? "+" : ""}${cents}¢`;
  const clamped = Math.max(-50, Math.min(50, cents));
  needleEl.style.left = 50 + clamped + "%";
  needleEl.classList.toggle("in-tune", Math.abs(cents) <= 5);
}

function paSetTunerEnabled(enabled) {
  PA.tunerEnabled = enabled;
  document.getElementById("pa-tuner-toggle").classList.toggle("active", enabled);
  document.getElementById("pa-tuner-toggle").textContent = enabled ? "Tuner: On" : "Tuner: Off";
  if (!enabled) paResetTunerDisplay("Tuner is off.");

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
}

function paStartMeters() {
  if (PA.meterRaf) cancelAnimationFrame(PA.meterRaf);
  const inData = new Float32Array(PA.inAnal.fftSize);
  const outData = new Float32Array(PA.outAnal.fftSize);
  let tunerFrameCount = 0;
  function tick() {
    PA.inAnal.getFloatTimeDomainData(inData);
    PA.outAnal.getFloatTimeDomainData(outData);
    let inMax = 0, outMax = 0;
    for (const v of inData) inMax = Math.max(inMax, Math.abs(v));
    for (const v of outData) outMax = Math.max(outMax, Math.abs(v));
    const inFill = document.getElementById("pa-input-meter-fill");
    const outFill = document.getElementById("pa-output-meter-fill");
    inFill.style.width = Math.min(100, inMax * 100) + "%";
    outFill.style.width = Math.min(100, outMax * 100) + "%";

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
async function paProbeNamModel(namJson, opts = {}) {
  try {
    // Audio.ctx always exists by the time Play Along's load paths run, but
    // don't let a null ctx silently disable the probe.
    const sr = (typeof Audio !== "undefined" && Audio.ctx && Audio.ctx.sampleRate) || 48000;
    const len = opts.testSignal ? opts.testSignal.length : Math.floor(sr * NAM_PROBE_SECONDS);
    const durationSec = len / sr;
    const offlineCtx = new OfflineAudioContext(1, len, sr);
    await offlineCtx.audioWorklet.addModule("nam-processor.js");
    const node = new AudioWorkletNode(offlineCtx, "nam-processor", {
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
function paIsParametricNam(namJson) {
  return !!namJson.architecture && namJson.architecture !== "WaveNet";
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

async function paLoadNamModel(filename) {
  const statusEl = document.getElementById("pa-nam-status");
  const parametricEl = document.getElementById("pa-nam-parametric-hint");
  const metaEl = document.getElementById("pa-nam-meta");
  const autolevelEl = document.getElementById("pa-nam-autolevel");
  if (!filename) {
    statusEl.textContent = ""; parametricEl.textContent = ""; metaEl.innerHTML = ""; autolevelEl.textContent = "";
    return;
  }
  parametricEl.textContent = "";
  statusEl.textContent = "Loading (checking speed)…";
  try {
    const namJson = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(filename)}`)).json();
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
    const probe = await paProbeNamModel(namJson);
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
    const resp = await fetch(`/api/ir_model_file?filename=${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const arrBuf = await resp.arrayBuffer();
    PA.convolver.buffer = await Audio.ctx.decodeAudioData(arrBuf);
    PA.irMakeupGain.gain.value = computeIrMakeupGain(PA.convolver.buffer);
    PA.irLoaded = filename; // GP-02: so a rig preset capture knows which IR is active
    statusEl.textContent = `Loaded: ${filename}`;
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
  const url = `/api/stem?source_path=${encodeURIComponent(State.track)}&model=${encodeURIComponent(State.model)}&stem=guitar`;
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

// Each candidate costs a fetch + a real offline render through the model
// (measured ~740ms/model on this machine, dominated by rendering — this is
// a from-scratch, non-WASM WaveNet, slower than real-time). That was fine
// against the two bundled starter captures this was built/tested against,
// but a real community NAM library can run to hundreds of files — 261
// measured extrapolates to ~3 minutes with zero feedback, indistinguishable
// from hung. Cap the candidate count and stride evenly through the full
// (folder-sorted) list so a capped sample still spans every pack rather
// than just whichever sorts first; report live progress since even the
// capped run takes several seconds.
const SUGGEST_MAX_CANDIDATES = 30;
const SUGGEST_TEST_SECONDS = 0.15; // enough samples for a stable ZCR reading

async function paSuggestNamModel() {
  const resultEl = document.getElementById("pa-suggest-result");
  resultEl.textContent = "Analyzing…";
  try {
    const targetZcr = await paTargetGuitarZcr();
    if (!PA.namModels.length) await paRefreshNamModels();

    const all = PA.namModels;
    const step = Math.max(1, Math.floor(all.length / SUGGEST_MAX_CANDIDATES));
    const candidates = [];
    for (let i = 0; i < all.length && candidates.length < SUGGEST_MAX_CANDIDATES; i += step) candidates.push(all[i]);

    const testSignal = new Float32Array(Math.floor(Audio.ctx.sampleRate * SUGGEST_TEST_SECONDS));
    for (let i = 0; i < testSignal.length; i++) testSignal[i] = (Math.random() * 2 - 1) * 0.3;

    const scored = [];
    let tooHeavy = 0;
    for (let ci = 0; ci < candidates.length; ci++) {
      const m = candidates[ci];
      resultEl.textContent = `Analyzing… (${ci + 1}/${candidates.length})`;
      try {
        const namJson = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(m.filename)}`)).json();
        // V3-E6: was its own from-scratch OfflineAudioContext/node/wasm-
        // module/load dance, duplicating paProbeNamModel's — reuse it with
        // this loop's own noise test signal (paProbeNamModel's default is a
        // sine, no good for a zero-crossing-rate brightness proxy) and ask
        // for the rendered audio back to score.
        const probe = await paProbeNamModel(namJson, { testSignal, returnAudio: true });
        if (probe.rtFactor === null) continue; // failed to build/load/render
        // Same speed guardrail as paLoadNamModel: never suggest a capture
        // that can't run live — it would be refused at load anyway.
        if (probe.rtFactor >= NAM_REFUSE_RT_FACTOR) { tooHeavy++; continue; }
        const modelZcr = zeroCrossingRate(probe.audio);
        scored.push({ name: m.name, filename: m.filename, distance: Math.abs(modelZcr - targetZcr) });
      } catch (e) { /* skip a model that fails to load/render offline */ }
    }
    scored.sort((a, b) => a.distance - b.distance);
    if (!scored.length) {
      resultEl.textContent = tooHeavy
        ? `No usable models found — all ${tooHeavy} sampled candidates are too heavy to run live on this machine. Try searching for "lite" or "feather" captures.`
        : "No models available to compare.";
      return;
    }

    const best = scored[0];
    const heavyNote = tooHeavy ? ` ${tooHeavy} sampled capture${tooHeavy === 1 ? " was" : "s were"} skipped as too heavy to run live.` : "";
    const sampledNote = all.length > candidates.length
      ? ` (sampled ${candidates.length} of ${all.length} models across the library)` : "";
    resultEl.innerHTML = `Closest match: <b>${escapeHtml(best.name)}</b> ` +
      `(brightness-proxy match, not a guaranteed tone match — audition and pick by ear)${sampledNote}.${heavyNote}<br>` +
      `Ranking: ${scored.map((s) => escapeHtml(s.name)).join(" → ")}`;
    await paLoadNamModel(best.filename);
    paHighlightBrowserSelection("nam", best.filename);
    setAmpMode("neural");
  } catch (e) {
    resultEl.textContent = "Could not analyze: " + e.message;
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
  const hasGuitar = typeof State !== "undefined" && State.stems && State.stems.some((s) => s.name === "guitar");
  document.getElementById("pa-suggest-btn").style.display = hasGuitar ? "block" : "none";
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
}

// Toggles which of the 3 persistent-screen nav buttons reads as "current,"
// and keeps the centered title-bar label (#top-banner-screen-label) in
// sync with it. Help is deliberately excluded from both — it's a
// transient modal, not a screen.
const PA_SCREEN_LABELS = {
  "mixer-open-btn": "Mixer",
  "tonelab-open-btn": "Tone Lab",
  "playalong-open-btn": "Play Along",
};
function paSetActiveScreen(id) {
  document.querySelectorAll(".nav-screen-row .nav-screen-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.id === id);
  });
  document.getElementById("top-banner-screen-label").textContent = PA_SCREEN_LABELS[id] || "";
}

async function openToneLab() {
  await paEnsureRigSessionReady();
  document.getElementById("tonelab-overlay").classList.add("show");
  document.getElementById("playalong-overlay").classList.remove("show");
  paRefreshDevices();
  paRefreshNamModels();
  paRefreshIrModels();
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
  document.getElementById("tonelab-open-btn").addEventListener("click", openToneLab);
  document.getElementById("tonelab-close-btn").addEventListener("click", closeToneLab);
  document.getElementById("playalong-open-btn").addEventListener("click", openPlayAlong);
  document.getElementById("playalong-close-btn").addEventListener("click", closePlayAlong);
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
  document.getElementById("pa-tuner-toggle").addEventListener("click", () => paSetTunerEnabled(!PA.tunerEnabled));
  paSetTunerEnabled(false); // sync button label/state with the PA.tunerEnabled default

  document.querySelectorAll("#pa-amp-modes button").forEach((btn) => {
    btn.addEventListener("click", () => setAmpMode(btn.dataset.mode));
  });

  document.getElementById("pa-gate-bypass").addEventListener("change", (e) => {
    PA.gateNode.parameters.get("bypass").value = e.target.checked ? 1 : 0;
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
  gate: "Gate", amp: "Amp", ir: "Cab IR", eq: "EQ", comp: "Comp",
  fx: "Delay/Rev", wah: "Wah", octaver: "Octave", boost: "Boost",
  geq: "Graphic EQ", chorus: "Chorus", phaser: "Phaser", flanger: "Flanger",
  tremolo: "Tremolo", output: "Output",
};

// Simple single-color line glyphs (24x24, stroke=currentColor), matching
// app-icon.svg's plain style rather than emoji — one per stage, per
// ui-review-and-tonelab-redesign.md §5. Chorus/phaser/flanger/tremolo are
// deliberately variants of the same sine-wave base (a loop for phaser's
// notch, a doubled offset wave for flanger, pulse ticks for tremolo's
// volume wobble) since that's what actually distinguishes them sonically.
const CHAIN_ICON_GLYPHS = {
  gate: '<line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/>',
  amp: '<rect x="4" y="7" width="16" height="11" rx="1.5"/><circle cx="12" cy="12.5" r="3.2"/>',
  ir: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="12" r="2.6"/><circle cx="15.5" cy="12" r="2.6"/>',
  eq: '<line x1="6" y1="4" x2="6" y2="20"/><circle cx="6" cy="9" r="1.6"/><line x1="12" y1="4" x2="12" y2="20"/><circle cx="12" cy="15" r="1.6"/><line x1="18" y1="4" x2="18" y2="20"/><circle cx="18" cy="7" r="1.6"/>',
  comp: '<polyline points="9,7 4,12 9,17"/><polyline points="15,7 20,12 15,17"/>',
  fx: '<path d="M4 14a8 8 0 0 1 16 0"/><path d="M7.5 14a4.5 4.5 0 0 1 9 0"/>',
  wah: '<polygon points="4,18 20,18 13,5"/>',
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
  return ["gate", ...(PA.pedalOrder || paLoadPedalOrder()), "output"];
}

// Amp has no bypass control of its own (three modes instead) — always
// "on". Delay/Reverb share one card (#pa-fx) but each has its own bypass,
// so the icon lights up if either is active.
function paChainStageIsOn(id) {
  if (id === "amp") return true;
  if (id === "fx") {
    const d = document.getElementById("pa-delay-bypass");
    const r = document.getElementById("pa-reverb-bypass");
    return (d && !d.checked) || (r && !r.checked);
  }
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
    if (id !== "gate" && id !== "output") btn.draggable = true;
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
    .filter((id) => id !== "gate" && id !== "output");
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
  if (state.pedalOrder) paApplyPedalOrderToDom(state.pedalOrder);
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

async function ensureRiffCapture() {
  if (riffCaptureNode) return;
  ensureCtx();
  if (typeof ensureRecordBus === "function") ensureRecordBus(); // recorder.js — backing + guitar mix
  else return; // recorder.js not loaded (shouldn't happen — it's always on the page)
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
wireRigPresets();
wireRiffCapture();
// #pa-latency-hint lives on the Output card, which moved into Tone Lab
// along with the rest of #pa-pedalboard — this listener moved with it.
document.getElementById("tonelab-open-btn").addEventListener("click", paShowLatencyEstimate);
