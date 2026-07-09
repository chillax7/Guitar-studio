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
  outAnal: null,
  meterRaf: null,
  namModels: [],
  irModels: [],
  tunerEnabled: false, // GP-01 — off by default; autocorrelation is O(n^2)
                       // and there's no reason to spend it when not tuning
};

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

  PA.inAnal = Audio.ctx.createAnalyser();
  PA.inAnal.fftSize = 8192; // GP-01 needs several full cycles of a low guitar E (~82Hz) for accurate autocorrelation

  PA.gateNode = new AudioWorkletNode(Audio.ctx, "gate-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
  });

  PA.cleanGain = Audio.ctx.createGain();

  const inputGain = Audio.ctx.createGain();
  const shaper = Audio.ctx.createWaveShaper();
  shaper.curve = paMakeDistortionCurve(0.3);
  shaper.oversample = "4x";
  const bass = Audio.ctx.createBiquadFilter(); bass.type = "lowshelf"; bass.frequency.value = 150;
  const mid = Audio.ctx.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 800; mid.Q.value = 0.7;
  const treble = Audio.ctx.createBiquadFilter(); treble.type = "highshelf"; treble.frequency.value = 3000;
  inputGain.connect(shaper).connect(bass).connect(mid).connect(treble);
  PA.analogNodes = { inputGain, shaper, bass, mid, treble, output: treble };

  PA.namNode = new AudioWorkletNode(Audio.ctx, "nam-processor", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
  });
  // paLoadNamModel() only listens on this port transiently (for the
  // "loaded" ack); this catches the process()-side failure fallback
  // instead of it going silently unnoticed if it's ever actually hit.
  PA.namNode.port.addEventListener("message", (e) => {
    if (e.data.type === "runtime-error") {
      document.getElementById("pa-nam-status").textContent =
        `Model disabled after a processing error: ${e.data.error}`;
    }
  });
  PA.namNode.port.start();

  PA.ampOut = Audio.ctx.createGain();

  // Cab IR (bypass = plain on/off, dry/wet gain pair)
  PA.convolver = Audio.ctx.createConvolver();
  PA.irDryGain = Audio.ctx.createGain(); PA.irDryGain.gain.value = 1;
  PA.irWetGain = Audio.ctx.createGain(); PA.irWetGain.gain.value = 0;
  PA.ampOut.connect(PA.irDryGain);
  PA.ampOut.connect(PA.convolver).connect(PA.irWetGain);
  const irMerge = Audio.ctx.createGain();
  PA.irDryGain.connect(irMerge);
  PA.irWetGain.connect(irMerge);

  // Post-amp EQ — bypass sets shelf/peak gains to 0dB (transparent), no merge needed
  const eqBass = Audio.ctx.createBiquadFilter(); eqBass.type = "lowshelf"; eqBass.frequency.value = 150;
  const eqMid = Audio.ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 800; eqMid.Q.value = 0.7;
  const eqTreble = Audio.ctx.createBiquadFilter(); eqTreble.type = "highshelf"; eqTreble.frequency.value = 3000;
  irMerge.connect(eqBass).connect(eqMid).connect(eqTreble);
  PA.eqNodes = { bass: eqBass, mid: eqMid, treble: eqTreble };

  // Compressor (bypass = dry/wet pair, since there's no clean "neutral" compressor setting)
  PA.compressor = Audio.ctx.createDynamicsCompressor();
  PA.compBypassDry = Audio.ctx.createGain(); PA.compBypassDry.gain.value = 1;
  PA.compBypassWet = Audio.ctx.createGain(); PA.compBypassWet.gain.value = 0;
  eqTreble.connect(PA.compBypassDry);
  eqTreble.connect(PA.compressor).connect(PA.compBypassWet);
  const compMerge = Audio.ctx.createGain();
  PA.compBypassDry.connect(compMerge);
  PA.compBypassWet.connect(compMerge);

  // Delay (dry always flows; wet gain doubles as the mix/bypass control)
  PA.delayNode = Audio.ctx.createDelay(2.0); PA.delayNode.delayTime.value = 0.3;
  PA.delayFeedback = Audio.ctx.createGain(); PA.delayFeedback.gain.value = 0.3;
  PA.delayWet = Audio.ctx.createGain(); PA.delayWet.gain.value = 0;
  compMerge.connect(PA.delayNode);
  PA.delayNode.connect(PA.delayFeedback).connect(PA.delayNode);
  PA.delayNode.connect(PA.delayWet);
  const delayMerge = Audio.ctx.createGain();
  compMerge.connect(delayMerge);
  PA.delayWet.connect(delayMerge);

  // Reverb (same mix-gain-as-bypass pattern)
  PA.reverbConvolver = Audio.ctx.createConvolver();
  PA.reverbConvolver.buffer = paMakeReverbImpulse(Audio.ctx, 1.5, 2.5);
  PA.reverbWet = Audio.ctx.createGain(); PA.reverbWet.gain.value = 0;
  delayMerge.connect(PA.reverbConvolver).connect(PA.reverbWet);
  const reverbMerge = Audio.ctx.createGain();
  delayMerge.connect(reverbMerge);
  PA.reverbWet.connect(reverbMerge);

  PA.outputGain = Audio.ctx.createGain();
  PA.outAnal = Audio.ctx.createAnalyser();
  PA.outAnal.fftSize = 1024;
  reverbMerge.connect(PA.outputGain).connect(PA.outAnal).connect(Audio.ctx.destination);

  setAmpMode("clean");
  PA.built = true;
}

// ---------------------------------------------------------------------------
// Amp mode switching — all three paths exist permanently; only the active
// one is actually wired from the gate to ampOut (so an unselected NAM model
// isn't burning CPU on inference nobody's listening to).
// ---------------------------------------------------------------------------

function setAmpMode(mode) {
  for (const [src, dst] of [
    [PA.gateNode, PA.cleanGain], [PA.gateNode, PA.analogNodes.inputGain], [PA.gateNode, PA.namNode],
    [PA.cleanGain, PA.ampOut], [PA.analogNodes.output, PA.ampOut], [PA.namNode, PA.ampOut],
  ]) {
    try { src.disconnect(dst); } catch (e) { /* wasn't connected */ }
  }

  if (mode === "clean") { PA.gateNode.connect(PA.cleanGain); PA.cleanGain.connect(PA.ampOut); }
  else if (mode === "analog") { PA.gateNode.connect(PA.analogNodes.inputGain); PA.analogNodes.output.connect(PA.ampOut); }
  else if (mode === "neural") { PA.gateNode.connect(PA.namNode); PA.namNode.connect(PA.ampOut); }

  PA.ampMode = mode;
  document.querySelectorAll("#pa-amp-modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("pa-amp-clean").style.display = mode === "clean" ? "block" : "none";
  document.getElementById("pa-amp-analog").style.display = mode === "analog" ? "block" : "none";
  document.getElementById("pa-amp-neural").style.display = mode === "neural" ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Input device + getUserMedia
// ---------------------------------------------------------------------------

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
  if (prevValue) sel.value = prevValue;
}

async function paEnableInput() {
  await ensurePAGraph();
  const deviceId = document.getElementById("pa-device-select").value;
  const hintEl = document.getElementById("pa-input-hint");
  try {
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
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
}

// GP-10: fixed -1dBFS clip threshold, deliberately NOT self-clearing — the
// point is to catch a transient clip you'd otherwise miss between glances
// at the meter, so once lit it stays lit until "Clear" or a new input
// session (see paEnableInput()).
const CLIP_THRESHOLD_LINEAR = Math.pow(10, -1 / 20);

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
  const peakDb = 20 * Math.log10(peak);
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
      if (prefix === "nam") paLoadNamModel(m.filename);
      else paLoadIr(m.filename);
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

async function paLoadNamModel(filename) {
  const statusEl = document.getElementById("pa-nam-status");
  if (!filename) { statusEl.textContent = ""; return; }
  statusEl.textContent = "Loading…";
  try {
    const namJson = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(filename)}`)).json();
    await new Promise((resolve, reject) => {
      PA.namNode.port.onmessage = (e) => {
        if (e.data.type !== "loaded") return;
        e.data.ok ? resolve() : reject(new Error(e.data.error));
      };
      PA.namNode.port.postMessage({ type: "load", nam: namJson });
    });
    PA.namLoaded = filename;
    statusEl.textContent = `Loaded: ${filename}`;
  } catch (e) {
    statusEl.textContent = "Failed to load: " + e.message;
  }
}

async function paLoadIr(filename) {
  if (!filename) { PA.convolver.buffer = null; return; }
  const arrBuf = await (await fetch(`/api/ir_model_file?filename=${encodeURIComponent(filename)}`)).arrayBuffer();
  PA.convolver.buffer = await Audio.ctx.decodeAudioData(arrBuf);
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
    for (let ci = 0; ci < candidates.length; ci++) {
      const m = candidates[ci];
      resultEl.textContent = `Analyzing… (${ci + 1}/${candidates.length})`;
      try {
        const namJson = await (await fetch(`/api/nam_model_file?filename=${encodeURIComponent(m.filename)}`)).json();
        const offlineCtx = new OfflineAudioContext(1, testSignal.length, Audio.ctx.sampleRate);
        await offlineCtx.audioWorklet.addModule("nam-processor.js");
        const node = new AudioWorkletNode(offlineCtx, "nam-processor", {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        });
        await new Promise((resolve) => {
          node.port.onmessage = () => resolve();
          node.port.postMessage({ type: "load", nam: namJson });
        });
        const srcBuf = offlineCtx.createBuffer(1, testSignal.length, Audio.ctx.sampleRate);
        srcBuf.getChannelData(0).set(testSignal);
        const src = offlineCtx.createBufferSource();
        src.buffer = srcBuf;
        src.connect(node).connect(offlineCtx.destination);
        src.start();
        const rendered = await offlineCtx.startRendering();
        const modelZcr = zeroCrossingRate(rendered.getChannelData(0));
        scored.push({ name: m.name, filename: m.filename, distance: Math.abs(modelZcr - targetZcr) });
      } catch (e) { /* skip a model that fails to load/render offline */ }
    }
    scored.sort((a, b) => a.distance - b.distance);
    if (!scored.length) { resultEl.textContent = "No models available to compare."; return; }

    const best = scored[0];
    const sampledNote = all.length > candidates.length
      ? ` (sampled ${candidates.length} of ${all.length} models across the library)` : "";
    resultEl.innerHTML = `Closest match: <b>${escapeHtml(best.name)}</b> ` +
      `(brightness-proxy match, not a guaranteed tone match — audition and pick by ear)${sampledNote}.<br>` +
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
  document.getElementById("pa-suggest-btn").style.display = hasGuitar ? "inline-block" : "none";
}

// ---------------------------------------------------------------------------
// Panel open/close + control wiring
// ---------------------------------------------------------------------------

async function openPlayAlong() {
  await ensurePAGraph();
  document.getElementById("playalong-overlay").classList.add("show");
  paRefreshDevices();
  paRefreshNamModels();
  paRefreshIrModels();
  paUpdateSuggestVisibility();
}

function closePlayAlong() {
  document.getElementById("playalong-overlay").classList.remove("show");
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

function wirePAControls() {
  document.getElementById("playalong-open-btn").addEventListener("click", openPlayAlong);
  document.getElementById("playalong-close-btn").addEventListener("click", closePlayAlong);
  document.getElementById("pa-enable-btn").addEventListener("click", paEnableInput);
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
    PA.analogNodes.shaper.curve = paMakeDistortionCurve(v);
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
  document.getElementById("pa-suggest-btn").addEventListener("click", paSuggestClosestModel);

  wireModelBrowser("ir");
  document.getElementById("pa-ir-bypass").addEventListener("change", (e) => {
    const bypassed = e.target.checked;
    PA.irDryGain.gain.value = bypassed ? 1 : 0;
    PA.irWetGain.gain.value = bypassed ? 0 : 1;
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

  document.getElementById("pa-output-level").addEventListener("input", (e) => {
    PA.outputGain.gain.value = Math.pow(10, parseFloat(e.target.value) / 20);
    document.getElementById("pa-output-val").textContent = e.target.value + " dB";
  });
}

function paShowLatencyEstimate() {
  const el = document.getElementById("pa-latency-hint");
  if (!Audio.ctx) { el.textContent = ""; return; }
  const est = ((Audio.ctx.baseLatency || 0) + (Audio.ctx.outputLatency || 0)) * 1000;
  el.textContent = est > 0
    ? `Estimated monitoring latency: ~${est.toFixed(0)} ms (browser-reported, not measured).`
    : "Latency estimate unavailable in this browser.";
}

wirePAControls();
document.getElementById("playalong-open-btn").addEventListener("click", paShowLatencyEstimate);
