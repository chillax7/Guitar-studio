"use strict";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

const Api = {
  async get(path) {
    return Api._handle(await fetch(path));
  },
  async post(path, body) {
    return Api._handle(await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  },
  async postRaw(path, data) {
    return Api._handle(await fetch(path, { method: "POST", body: data }));
  },
  async _handle(response) {
    let json = {};
    try { json = await response.json(); } catch (e) { /* no body */ }
    if (!response.ok) {
      const err = new Error(json.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return json;
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const State = {
  tracks: [],
  models: [],
  defaultModel: "htdemucs",
  track: null,
  model: null,
  stems: [],
  analysis: {},
  stale: false,
  // mix is the live recipe AND the export recipe (minus solo — solo is
  // monitoring-only, per ui-spec.md §5.4). eq/pan (BT-11) are additive to
  // the existing project.mix shape, not a version bump — see selectTrack's
  // backfill for projects saved before they existed.
  mix: { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {} },
  ui: { loop: null, loopEnabled: false },
  // XC-01 (project format v2)
  markers: [], // BT-08 (M4) — not populated until that lands
  rigPreset: null, // GP-02 — name of the rig preset attached to this song, if any
  rigPresetApplied: false, // has paApplyAttachedRigPreset already run for the current track
};

const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"];

function stemSortKey(name) {
  const base = name.replace(/_(center|sides)$/, "");
  const idx = STEM_ORDER.indexOf(base);
  return [idx === -1 ? 99 : idx, name];
}

function orderedStems() {
  return [...State.stems].sort((a, b) => {
    const ka = stemSortKey(a.name), kb = stemSortKey(b.name);
    return ka[0] - kb[0] || ka[1].localeCompare(kb[1]);
  });
}

// Candidate A/B labeling per ui-spec.md §7.3 — never "Lead"/"Rhythm", since
// the split is a panning guess, not a guaranteed role assignment.
function stemDisplayName(name) {
  if (name.endsWith("_center")) return `Candidate A (center) — from ${name.slice(0, -7)}`;
  if (name.endsWith("_sides")) return `Candidate B (sides) — from ${name.slice(0, -6)}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ---------------------------------------------------------------------------
// BT-17: waveform zoom. Every ruler/lane-body position on screen is time
// mapped through these three functions instead of a bare Audio.duration
// division — zoomWindow narrows what "0% to 100% of the timeline" actually
// means to a sub-range, without touching how any individual feature
// (playhead, loop, markers, beat grid, mute painting, waveform) renders or
// hit-tests itself. Deliberately a plain module variable, NOT part of
// State.ui: State.ui gets serialized wholesale into the saved project
// (saveProjectDebounced) and reloaded verbatim on the next track switch —
// same reasoning as Speed/Tune resetting per track, a leftover zoom from a
// previous song would be a trap, not a feature, so this never touches disk.
// ---------------------------------------------------------------------------
let zoomWindow = null;

function viewWindow() {
  if (zoomWindow) return zoomWindow;
  return { start: 0, end: Audio.duration || 0 };
}
function timeToPct(t) {
  const { start, end } = viewWindow();
  const span = end - start;
  return span > 0 ? (t - start) / span * 100 : 0;
}
function pctToTime(pct) {
  const { start, end } = viewWindow();
  return start + clamp01(pct / 100) * (end - start);
}

// V3-E6: shared dB<->linear-gain conversions — playalong.js had two
// independent Math.pow(10, db/20) call sites (the clip threshold constant
// and the output-level slider) that had started drifting apart in spelling
// even though they're the same formula.
function dbToLin(db) { return Math.pow(10, db / 20); }
function linToDb(lin) { return 20 * Math.log10(lin); }

// V3-E6: was defined inline inside playalong.js's gsDiag() as a local
// const, the only place it was used — pulled out next to the other shared
// main-thread utilities above so it isn't tied to that one diagnostic.
function rmsOf(analyser) {
  if (!analyser) return null;
  const d = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(d);
  let s = 0;
  for (const v of d) s += v * v;
  return +Math.sqrt(s / d.length).toFixed(5);
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Audio graph
//
// AudioBufferSourceNode can only be started once, so "pause" stops every
// source and remembers the offset; "play" creates fresh sources for every
// stem and schedules them all at the same future AudioContext time so the
// lanes stay sample-synced (they share length/sample-rate from one
// separation run) — per engine-spec.md §6.1's playback design.
//
// Live mute-region preview (applyLiveMuteRanges) is a per-frame gain poll,
// not sample-accurate AudioParam automation — it's perceptually close but
// not bit-identical to the engine's 30ms-faded export. That's an accepted
// gap (ui-spec.md §15.1 flags exactly this as open); export always goes
// through /api/mix for the exact result, so live preview only needs to be
// close enough to judge a mix by ear.
// ---------------------------------------------------------------------------

const Audio = {
  ctx: null,
  master: null,
  masterMute: null,
  analyser: null,
  buffers: {},
  gains: {},
  stemFx: {}, // BT-11 — per-stem { bass, mid, treble, panner } nodes, keyed by stem name
  sources: {},
  playing: false,
  playStartCtxTime: 0,
  playStartOffset: 0,
  duration: 0,
  // Dual playback mode: 'direct' (AudioBufferSourceNode, exact multi-stem
  // sample sync — the default, zero-risk path) vs 'processed' (routed
  // through the stretch-processor.js phase-vocoder worklet) when Speed or
  // Tune is active. Both node types stay connected to each stem's GainNode
  // at all times; only one is ever actually producing sound (the inactive
  // one is either not started, or reports playing=false to the worklet —
  // see stretch-processor.js), so switching modes is just a start/stop
  // toggle, never a graph rewire.
  mode: "direct",
  speed: 1.0,
  pitchRatio: 1.0,
  stretchNodes: {},
  workletLoaded: false,
  processedPosition: 0,
};

function ensureCtx() {
  if (!Audio.ctx) {
    Audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    Audio.master = Audio.ctx.createGain();
    // V3-E2: mute lives on its own node so the tuner's mute and the volume
    // slider's level never fight over the same gain param (the pre-v3 bug:
    // moving the slider while tuning silently un-muted).
    Audio.masterMute = Audio.ctx.createGain();
    Audio.analyser = Audio.ctx.createAnalyser();
    Audio.master.connect(Audio.masterMute);
    Audio.masterMute.connect(Audio.analyser);
    Audio.analyser.connect(Audio.ctx.destination);
    // V3-E1: single owner of "keep the context alive". Browsers can
    // auto-suspend an AudioContext they judge idle (e.g. a brief silence gap
    // during a Play Along amp-model switch, or the tuner muting both mixer
    // and PA output); nothing else resumes it, so it would otherwise stay
    // silent until a full page reload. Event-driven so it also fires for
    // backgrounded tabs, which rAF polling never sees.
    Audio.ctx.addEventListener("statechange", () => {
      if (Audio.ctx.state === "suspended") Audio.ctx.resume();
    });
  }
  return Audio.ctx;
}

async function ensureWorkletLoaded() {
  ensureCtx();
  if (!Audio.workletLoaded) {
    await Audio.ctx.audioWorklet.addModule("stretch-processor.js");
    Audio.workletLoaded = true;
  }
}

async function ensureStretchNodes() {
  await ensureWorkletLoaded();
  for (const name in Audio.buffers) {
    if (Audio.stretchNodes[name]) continue;
    const node = new AudioWorkletNode(Audio.ctx, "stretch-processor", {
      numberOfInputs: 0, numberOfOutputs: 1,
      outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
    });
    node.connect(Audio.gains[name]);
    node.port.onmessage = (e) => {
      if (e.data.type === "position") Audio.processedPosition = e.data.positionSec;
    };
    const buf = Audio.buffers[name];
    const channels = buf.numberOfChannels >= 2
      ? [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()]
      : [buf.getChannelData(0).slice(), buf.getChannelData(0).slice()];
    node.port.postMessage({ type: "load", channels }, channels.map((c) => c.buffer));
    node.port.postMessage({ type: "params", speed: Audio.speed, pitchRatio: Audio.pitchRatio });
    Audio.stretchNodes[name] = node;
  }
}

function teardownStretchNodes() {
  for (const name in Audio.stretchNodes) {
    try { Audio.stretchNodes[name].disconnect(); } catch (e) { /* already gone */ }
  }
  Audio.stretchNodes = {};
}

async function loadStemBuffers(stems) {
  ensureCtx();
  stopPlayback();
  teardownStretchNodes();
  const entries = await Promise.all(stems.map(async (stem) => {
    const url = `/api/stem?source_path=${encodeURIComponent(State.track)}` +
      `&model=${encodeURIComponent(State.model)}&stem=${encodeURIComponent(stem.name)}`;
    const resp = await fetch(url);
    const arrBuf = await resp.arrayBuffer();
    const audioBuf = await Audio.ctx.decodeAudioData(arrBuf);
    return [stem.name, audioBuf];
  }));
  Audio.buffers = {};
  Audio.gains = {};
  Audio.stemFx = {};
  Audio.duration = 0;
  for (const [name, buf] of entries) {
    Audio.buffers[name] = buf;
    Audio.duration = Math.max(Audio.duration, buf.duration);
    const g = Audio.ctx.createGain();
    // BT-11: per-stem 3-band EQ + pan, applied after the mute/solo gain,
    // before the shared master bus — "carving space" without touching the
    // post-mix EQ/pan Play Along's rig has (that's for the guitar signal,
    // this is for the backing stems).
    const eqBass = Audio.ctx.createBiquadFilter(); eqBass.type = "lowshelf"; eqBass.frequency.value = 150;
    const eqMid = Audio.ctx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 800; eqMid.Q.value = 0.7;
    const eqTreble = Audio.ctx.createBiquadFilter(); eqTreble.type = "highshelf"; eqTreble.frequency.value = 3000;
    const panner = Audio.ctx.createStereoPanner();
    const eq = State.mix.eq[name] || { bass: 0, mid: 0, treble: 0 };
    eqBass.gain.value = eq.bass; eqMid.gain.value = eq.mid; eqTreble.gain.value = eq.treble;
    panner.pan.value = State.mix.pan[name] ?? 0;
    g.connect(eqBass).connect(eqMid).connect(eqTreble).connect(panner).connect(Audio.master);
    Audio.gains[name] = g;
    Audio.stemFx[name] = { bass: eqBass, mid: eqMid, treble: eqTreble, panner };
  }
  applyMixToGains();
  if (Audio.mode === "processed") await ensureStretchNodes();
}

function currentPosition() {
  if (Audio.mode === "processed") return Audio.processedPosition || 0;
  if (!Audio.playing) return Audio.playStartOffset;
  return Audio.playStartOffset + (Audio.ctx.currentTime - Audio.playStartCtxTime);
}

function stopSources() {
  for (const name in Audio.sources) {
    try { Audio.sources[name].stop(); } catch (e) { /* already stopped */ }
  }
  Audio.sources = {};
}

function startPlaybackAt(offsetSec) {
  if (Audio.mode === "processed") {
    Audio.processedPosition = offsetSec;
    for (const name in Audio.stretchNodes) {
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "seek", positionSec: offsetSec });
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "play" });
    }
  } else {
    stopSources();
    const startAt = Audio.ctx.currentTime + 0.05;
    for (const name in Audio.buffers) {
      const src = Audio.ctx.createBufferSource();
      src.buffer = Audio.buffers[name];
      src.connect(Audio.gains[name]);
      src.start(startAt, Math.max(0, Math.min(offsetSec, src.buffer.duration)));
      Audio.sources[name] = src;
    }
    Audio.playStartCtxTime = startAt;
    Audio.playStartOffset = offsetSec;
  }
  Audio.playing = true;
}

function pausePlayback() {
  if (!Audio.playing) return;
  if (Audio.mode === "processed") {
    for (const name in Audio.stretchNodes) {
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "pause" });
    }
  } else {
    const pos = currentPosition();
    stopSources();
    Audio.playStartOffset = pos;
  }
  Audio.playing = false;
}

function stopPlayback() {
  if (Audio.mode === "processed") {
    for (const name in Audio.stretchNodes) {
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "pause" });
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "seek", positionSec: 0 });
    }
    Audio.processedPosition = 0;
  } else {
    stopSources();
    Audio.playStartOffset = 0;
  }
  Audio.playing = false;
  resyncClickPointer(0); // BT-02 — position just jumped to 0 outside seekTo()
}

function seekTo(sec) {
  const wasPlaying = Audio.playing;
  const clamped = Math.max(0, Math.min(sec, Audio.duration || 0));
  if (Audio.mode === "processed") {
    Audio.processedPosition = clamped;
    for (const name in Audio.stretchNodes) {
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "seek", positionSec: clamped });
    }
  } else {
    stopSources();
    Audio.playing = false;
    Audio.playStartOffset = clamped;
    if (wasPlaying) startPlaybackAt(clamped);
  }
  resyncClickPointer(clamped); // BT-02 — a jump must resync which beat fires next, or a forward seek would burst-fire every skipped beat in one tick()
}

// Switches the active playback mode, preserving position/play-state across
// the switch. Called whenever Speed/Tune move away from (or back to)
// unity — see wireSpeedTune().
async function setSpeedTune(speed, pitchRatio) {
  Audio.speed = speed;
  Audio.pitchRatio = pitchRatio;
  for (const name in Audio.stretchNodes) {
    Audio.stretchNodes[name].port.postMessage({ type: "params", speed, pitchRatio });
  }
  const wantProcessed = speed !== 1.0 || pitchRatio !== 1.0;
  const newMode = wantProcessed ? "processed" : "direct";
  if (newMode === Audio.mode) return;

  const pos = currentPosition();
  const wasPlaying = Audio.playing;
  if (Audio.mode === "direct") stopSources();
  else for (const name in Audio.stretchNodes) {
    Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "pause" });
  }
  Audio.mode = newMode;
  Audio.playing = false;
  Audio.playStartOffset = pos;
  Audio.processedPosition = pos;
  if (newMode === "processed") await ensureStretchNodes();
  if (wasPlaying) startPlaybackAt(pos);
}

// Static per-stem gain from mute/solo/fader state (everything except live
// mute-region preview, which is layered on top every frame).
function applyMixToGains() {
  const soloStem = State.mix.solo;
  for (const name in Audio.gains) {
    let g = State.mix.gains[name] ?? 1.0;
    if (State.mix.muted[name]) g = 0;
    if (soloStem && name !== soloStem) g = 0;
    Audio.gains[name]._baseGain = g;
  }
  applyLiveMuteRanges(currentPosition());
}

function applyLiveMuteRanges(pos) {
  for (const name in Audio.gains) {
    const base = Audio.gains[name]._baseGain ?? 1.0;
    const ranges = State.mix.muteRanges[name] || [];
    let factor = 1.0;
    for (const [s, e] of ranges) {
      if (pos >= s && pos < e) { factor = 0; break; }
    }
    Audio.gains[name].gain.value = base * factor;
  }
}

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

// Peaks are a pure function of (buffer, buckets, window) and a full linear
// scan over the requested sample range (up to the whole PCM buffer —
// millions of samples per stem). renderLanes() runs on every mute/solo
// toggle and every mute-region paint, so without this cache that scan
// repeats across all stems on every such interaction. Keyed by the
// AudioBuffer in a WeakMap (the same buffer object is reused across renders
// and only replaced when stems reload, at which point the old entry is GC'd
// automatically — no manual invalidation needed) holding a small Map of
// window->peaks, since BT-17 (waveform zoom) means the same buffer gets
// queried at more than one window now.
const _peaksCache = new WeakMap();

function computePeaks(buffer, buckets, startSec, endSec) {
  const s = startSec ?? 0;
  const e = endSec ?? buffer.duration;
  const key = `${buckets}:${s.toFixed(3)}:${e.toFixed(3)}`;
  let byWindow = _peaksCache.get(buffer);
  if (!byWindow) { byWindow = new Map(); _peaksCache.set(buffer, byWindow); }
  const cached = byWindow.get(key);
  if (cached) return cached;

  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(s * sr));
  const endSample = Math.min(data.length, Math.ceil(e * sr));
  const span = Math.max(1, endSample - startSample);
  const peaks = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(span / buckets));
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const bstart = startSample + i * perBucket;
    const bend = Math.min(bstart + perBucket, endSample);
    for (let j = bstart; j < bend; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
  byWindow.set(key, peaks);
  return peaks;
}

function drawWaveform(canvas, peaks) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width = Math.max(1, canvas.clientWidth) * dpr;
  const h = canvas.height = Math.max(1, canvas.clientHeight) * dpr;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#5b8cff";
  const mid = h / 2;
  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const barH = Math.max(1, peaks[i] * mid);
    ctx.fillRect(i * barW, mid - barH, Math.max(1, barW - 0.5), barH * 2);
  }
}

// ---------------------------------------------------------------------------
// Drag helper — listeners live only for the duration of one gesture, so
// re-rendering lanes (which replaces the DOM elements that started a drag)
// never leaks stale listeners onto `document`.
// ---------------------------------------------------------------------------

function startDrag(onMove, onUp) {
  function move(e) { onMove(e); }
  function up(e) {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    onUp(e);
  }
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

// ---------------------------------------------------------------------------
// Project persistence (debounced autosave)
// ---------------------------------------------------------------------------

// XC-01: project format v2 — versioned, so a project file can carry more
// than model/mix/ui (rig presets, section markers, other UI state) without
// every reader needing to guess whether an old file has that field at all.
// A v1 file (no "version" key — every project saved before this) has
// exactly {model, mix, ui}; migrateProjectV2 below wraps that shape once,
// on load, so the rest of the app only ever deals with v2 objects. Bump
// PROJECT_VERSION and extend migrateProjectV2 with another branch whenever
// the shape changes again — never read an unversioned field directly.
const PROJECT_VERSION = 2;

function migrateProjectV2(raw) {
  if (!raw) return null;
  if (raw.version >= PROJECT_VERSION) return raw;
  // v1 (or earlier/unversioned): {model, mix, ui} only.
  return {
    version: PROJECT_VERSION,
    model: raw.model,
    mix: raw.mix || { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {} },
    ui: raw.ui || { loop: null, loopEnabled: false },
    markers: [], // BT-08 (M4) — empty until that lands
    rigPreset: null, // GP-02 (M3) — no preset attached to a v1 project
  };
}

let saveTimer = null;
function saveProjectDebounced() {
  if (!State.track) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Api.post("/api/project", {
      track: State.track,
      project: {
        version: PROJECT_VERSION,
        model: State.model,
        mix: State.mix,
        ui: State.ui,
        markers: State.markers || [],
        rigPreset: State.rigPreset || null,
      },
    }).catch(() => { /* best-effort */ });
  }, 600);
}

// ---------------------------------------------------------------------------
// Track lifecycle
// ---------------------------------------------------------------------------

function showState(name) {
  for (const s of ["empty-state", "loading-state", "no-stems-state", "separating-state", "workspace"]) {
    document.getElementById(s).classList.toggle("show", s === name);
  }
  document.getElementById("transport").classList.toggle("show", name === "workspace");
}

function updateModelBadge() {
  document.getElementById("model-badge-label").textContent = State.model || "—";
}

async function refreshTrackList() {
  const r = await Api.get("/api/tracks");
  State.tracks = r.tracks;
  renderTrackList();
}

function renderTrackList() {
  const el = document.getElementById("track-list");
  el.innerHTML = "";
  for (const t of State.tracks) {
    const row = document.createElement("div");
    row.className = "track-row" + (t.name === State.track ? " selected" : "");
    // Projects UX: a visible per-song project indicator — content-hash-
    // keyed server-side now (server.py's project_path_for), so this stays
    // accurate even for a track that's been renamed since its mix was saved.
    row.innerHTML = `<span class="track-name">${escapeHtml(t.name)}</span>` +
      (t.has_project ? '<span class="track-project-dot" title="Has a saved mix/project"></span>' : "");
    row.addEventListener("click", () => selectTrack(t.name));
    el.appendChild(row);
  }
}

let selectTrackEpoch = 0;

async function selectTrack(name) {
  // Reentrancy guard: selectTrack awaits (setSpeedTune, /api/project,
  // stem load), and two quick library clicks would otherwise interleave —
  // the first click's continuation resuming after the second set State,
  // clobbering State.model/State.mix and then loading stems for a
  // mismatched track/model pair. Each call claims an epoch; a stale call
  // bails at the next checkpoint instead of writing over the newer one.
  const epoch = ++selectTrackEpoch;

  // Picking a track from the library is a clear intent to work on the
  // mixer — if Play Along is open over it, close it rather than leaving
  // the newly-selected track loaded silently behind the overlay.
  if (typeof closePlayAlong === "function") closePlayAlong();

  State.track = name;
  renderTrackList();
  stopPlayback();
  zoomWindow = null; // BT-17 — same reasoning as Speed/Tune resetting below: a leftover zoom from the last song would be a trap
  document.getElementById("zoom-to-loop-btn").style.display = "inline-block";
  document.getElementById("zoom-out-btn").style.display = "none";
  // "Loading…" instead of the empty-state's "select a track" message —
  // a track WAS just selected, that message briefly re-showing while
  // stems load read as if the click hadn't registered.
  showState("loading-state");
  document.getElementById("separate-btn").style.display = "inline-block";

  // Speed/Tune aren't part of the saved project (deliberately — carrying
  // yesterday's half-speed setting silently into a new song would be a
  // trap, not a feature); reset to unity on every track switch. Volume is
  // NOT reset here — it's a listening-level preference, not song data.
  setTransportValue("speed-slider", "1");
  setTransportValue("tune-slider", "0");
  setTransportText("speed-display", "1.00×");
  setTransportText("tune-display", "0¢");
  await setSpeedTune(1.0, 1.0);
  if (epoch !== selectTrackEpoch) return; // a newer selectTrack superseded us

  let project = null;
  try {
    project = migrateProjectV2(await Api.get(`/api/project?track=${encodeURIComponent(name)}`));
  } catch (e) { /* no saved project yet */ }
  if (epoch !== selectTrackEpoch) return;

  State.model = (project && project.model) || State.defaultModel;
  State.mix = (project && project.mix) || { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {} };
  // BT-11: eq/pan are additive to project.mix, not a version bump — a v2
  // project saved before they existed still has a mix object, just without
  // these two keys, so backfill rather than assume they're always present.
  State.mix.eq = State.mix.eq || {};
  State.mix.pan = State.mix.pan || {};
  State.ui = (project && project.ui) || { loop: null, loopEnabled: false };
  State.markers = (project && project.markers) || [];
  // GP-02: a rig preset attached to this song — applied once Play Along is
  // next opened for it (paApplyAttachedRigPreset in playalong.js), not
  // here, since the PA audio graph doesn't exist until ensurePAGraph runs.
  State.rigPreset = (project && project.rigPreset) || null;
  State.rigPresetApplied = false;
  toggleTransportClass("loop-toggle-btn", "active", State.ui.loopEnabled);
  updateModelBadge();
  if (typeof refreshTakesList === "function") refreshTakesList(); // recorder.js — takes are per-track

  await refreshStemsForCurrentModelAndTrack();
}

async function refreshStemsForCurrentModelAndTrack() {
  try {
    const r = await Api.get(`/api/list_stems?source_path=${encodeURIComponent(State.track)}` +
      `&model=${encodeURIComponent(State.model)}`);
    await onStemsLoaded(r);
  } catch (e) {
    if (e.status === 404) {
      showNoStemsState();
    } else {
      alert("Error loading stems: " + e.message);
    }
  }
}

function showNoStemsState() {
  showState("no-stems-state");
  updateModelBadge();
}

async function onStemsLoaded(result) {
  State.stems = result.stems;
  State.analysis = result.analysis || {};
  State.stale = result.stale;
  for (const s of State.stems) {
    if (!(s.name in State.mix.gains)) State.mix.gains[s.name] = 1.0;
  }
  showState("workspace");
  updateModelBadge();
  await loadStemBuffers(State.stems);
  renderLanes();
  renderInspector();
  updateStaleBanner();
  updateLoopVisual();
  renderMarkers();
  renderBeatGrid();
  resyncClickPointer(currentPosition());
  renderPlayhead(currentPosition());
  renderTimeDisplay(currentPosition());
}

function updateStaleBanner() {
  document.getElementById("stale-banner").classList.toggle("show", !!State.stale);
}

// ---------------------------------------------------------------------------
// Lanes — waveform + mute-region painting, always shown together (the
// separate Mixer/Timeline view toggle was removed; painting is opt-in per
// lane via click-drag, so there's no reason to hide it behind a mode).
// ---------------------------------------------------------------------------

function renderLanes() {
  const container = document.getElementById("lanes");
  container.innerHTML = "";
  const playheads = [];

  for (const stem of orderedStems()) {
    const name = stem.name;
    const lane = document.createElement("div");
    lane.className = "lane" +
      (State.mix.muted[name] ? " muted" : "") +
      (State.mix.solo === name ? " solo-active" : "");

    // BT-11: per-stem pan + a 3-band EQ, "carving space" to play along
    // (e.g. pan drums off-center, cut some bass mud) — pan is a fader-
    // adjacent control since it's touched often; EQ is behind a small
    // disclosure toggle since it's more of a set-once-per-song tweak.
    const pan = State.mix.pan[name] ?? 0;
    const eq = State.mix.eq[name] || { bass: 0, mid: 0, treble: 0 };
    const header = document.createElement("div");
    header.className = "lane-header";
    header.innerHTML = `
      <div class="lane-name">${escapeHtml(stemDisplayName(name))}
        ${stem.is_derived ? '<span class="lane-derived-badge">derived</span>' : ""}</div>
      <div class="lane-buttons">
        <button class="mute-btn ${State.mix.muted[name] ? "on" : ""}">M</button>
        <button class="solo-btn ${State.mix.solo === name ? "on" : ""}">S</button>
      </div>
      <div class="lane-fader">
        <input type="range" class="lane-gain-input" min="0" max="1.5" step="0.01" value="${State.mix.gains[name] ?? 1.0}">
        <span class="lane-gain-val">${Math.round((State.mix.gains[name] ?? 1.0) * 100)}%</span>
      </div>
      <div class="lane-pan-row">
        <input type="range" class="lane-pan-input" min="-1" max="1" step="0.01" value="${pan}">
        <span class="lane-pan-val">${panLabel(pan)}</span>
        <button class="lane-eq-toggle-btn">EQ</button>
      </div>
      <div class="lane-eq-row" style="display:none">
        <label>B<input type="range" class="lane-eq-input" data-band="bass" min="-12" max="12" step="1" value="${eq.bass}"></label>
        <label>M<input type="range" class="lane-eq-input" data-band="mid" min="-12" max="12" step="1" value="${eq.mid}"></label>
        <label>T<input type="range" class="lane-eq-input" data-band="treble" min="-12" max="12" step="1" value="${eq.treble}"></label>
      </div>`;
    lane.appendChild(header);

    const body = document.createElement("div");
    body.className = "lane-body";
    const canvas = document.createElement("canvas");
    body.appendChild(canvas);
    const playhead = document.createElement("div");
    playhead.className = "playhead";
    body.appendChild(playhead);
    playheads.push(playhead);

    const muteLane = document.createElement("div");
    muteLane.className = "mute-lane";
    wireMuteLane(muteLane, name);
    renderMuteRegions(muteLane, name);
    body.appendChild(muteLane);

    lane.appendChild(body);
    container.appendChild(lane);

    // XC-02: M/S keyboard shortcuts act on whichever lane the mouse is over.
    lane.addEventListener("mouseenter", () => { hoveredStemName = name; });
    lane.addEventListener("mouseleave", () => { if (hoveredStemName === name) hoveredStemName = null; });

    header.querySelector(".mute-btn").addEventListener("click", () => toggleMute(name));
    header.querySelector(".solo-btn").addEventListener("click", () => toggleSolo(name));
    const fader = header.querySelector(".lane-gain-input");
    fader.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      setGain(name, v);
      header.querySelector(".lane-gain-val").textContent = Math.round(v * 100) + "%";
    });

    // BT-11: pan + 3-band EQ per stem.
    const panInput = header.querySelector(".lane-pan-input");
    panInput.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      setPan(name, v);
      header.querySelector(".lane-pan-val").textContent = panLabel(v);
    });
    header.querySelector(".lane-eq-toggle-btn").addEventListener("click", (e) => {
      const row = header.querySelector(".lane-eq-row");
      const open = row.style.display !== "none";
      row.style.display = open ? "none" : "flex";
      e.target.classList.toggle("active", !open);
    });
    header.querySelectorAll(".lane-eq-input").forEach((input) => {
      input.addEventListener("input", (e) => {
        setStemEq(name, e.target.dataset.band, parseFloat(e.target.value));
      });
    });

    canvas.addEventListener("click", (e) => seekFromElement(canvas, e));

    const buf = Audio.buffers[name];
    if (buf) {
      // BT-17: waveform zoom — slicing peaks to the current view window
      // (instead of always the whole buffer) is what makes zooming in
      // actually show more DETAIL rather than the same 400 buckets stretched.
      const { start, end } = viewWindow();
      requestAnimationFrame(() => drawWaveform(canvas, computePeaks(buf, 400, start, end)));
    }
  }

  // V3-E5: renderPlayhead() reads this instead of re-querying the DOM every
  // animation frame. Force a re-render next tick — the lane DOM (and thus
  // which elements .style.left needs to hit) just changed, but the actual
  // playhead position may not have, which would otherwise skip it.
  cachedPlayheadEls = playheads;
  lastPlayheadPct = null;
}

function toggleMute(name) {
  State.mix.muted[name] = !State.mix.muted[name];
  applyMixToGains();
  renderLanes();
  saveProjectDebounced();
}

function toggleSolo(name) {
  State.mix.solo = (State.mix.solo === name) ? null : name;
  applyMixToGains();
  renderLanes();
  saveProjectDebounced();
}

function setGain(name, value) {
  State.mix.gains[name] = value;
  applyMixToGains();
  saveProjectDebounced();
}

// BT-11: per-stem pan + 3-band EQ. Unlike gain (which also interacts with
// mute/solo through applyMixToGains), pan and EQ each own one AudioParam
// directly — no per-stem state machine to reapply, just set it and go.
function panLabel(v) {
  if (Math.abs(v) < 0.01) return "C";
  const pct = Math.round(Math.abs(v) * 100);
  return (v < 0 ? "L" : "R") + pct;
}

function setPan(name, value) {
  State.mix.pan[name] = value;
  if (Audio.stemFx[name]) Audio.stemFx[name].panner.pan.value = value;
  saveProjectDebounced();
}

function setStemEq(name, band, valueDb) {
  if (!State.mix.eq[name]) State.mix.eq[name] = { bass: 0, mid: 0, treble: 0 };
  State.mix.eq[name][band] = valueDb;
  if (Audio.stemFx[name]) Audio.stemFx[name][band].gain.value = valueDb;
  saveProjectDebounced();
}

function seekFromElement(el, e) {
  const rect = el.getBoundingClientRect();
  seekTo(pctToTime((e.clientX - rect.left) / rect.width * 100));
}

function renderMuteRegions(muteLaneEl, stemName) {
  const ranges = State.mix.muteRanges[stemName] || [];
  for (const [s, e] of ranges) {
    const div = document.createElement("div");
    div.className = "mute-region";
    div.style.left = timeToPct(s) + "%";
    div.style.width = (timeToPct(e) - timeToPct(s)) + "%";
    muteLaneEl.appendChild(div);
  }
}

function wireMuteLane(el, stemName) {
  let dragStart = null;
  let tempEl = null;

  el.addEventListener("mousedown", (e) => {
    const rect = el.getBoundingClientRect();
    dragStart = pctToTime((e.clientX - rect.left) / rect.width * 100);
  });
  el.addEventListener("mousemove", (e) => {
    if (dragStart == null) return;
    const rect = el.getBoundingClientRect();
    const cur = pctToTime((e.clientX - rect.left) / rect.width * 100);
    const s = Math.min(dragStart, cur), en = Math.max(dragStart, cur);
    if (!tempEl) {
      tempEl = document.createElement("div");
      tempEl.className = "mute-region";
      el.appendChild(tempEl);
    }
    tempEl.style.left = timeToPct(s) + "%";
    tempEl.style.width = (timeToPct(en) - timeToPct(s)) + "%";
  });
  function finish(e) {
    if (dragStart == null) return;
    const rect = el.getBoundingClientRect();
    const cur = pctToTime((e.clientX - rect.left) / rect.width * 100);
    const s = Math.min(dragStart, cur), en = Math.max(dragStart, cur);
    dragStart = null;
    if (tempEl) { tempEl.remove(); tempEl = null; }

    const ranges = State.mix.muteRanges[stemName] || [];
    if (en - s < 0.15) {
      const idx = ranges.findIndex(([rs, re]) => cur >= rs && cur <= re);
      if (idx === -1) return; // click on empty space — no-op
      ranges.splice(idx, 1);
    } else {
      ranges.push([s, en]);
    }
    State.mix.muteRanges[stemName] = ranges;
    renderLanes();
    saveProjectDebounced();
  }
  el.addEventListener("mouseup", finish);
  el.addEventListener("mouseleave", () => {
    dragStart = null;
    if (tempEl) { tempEl.remove(); tempEl = null; }
  });
}

// ---------------------------------------------------------------------------
// Ruler: seek + A/B loop handles (BT-05 — built as the real thing from the
// start, no fixed-middle-region placeholder)
// ---------------------------------------------------------------------------

function initRuler() {
  const ruler = document.getElementById("ruler");
  const rulerPh = document.createElement("div");
  rulerPh.id = "ruler-playhead";
  rulerPh.className = "playhead";
  ruler.appendChild(rulerPh);

  ruler.addEventListener("click", (e) => {
    if (e.target.classList.contains("loop-handle")) return;
    const rect = ruler.getBoundingClientRect();
    seekTo(pctToTime((e.clientX - rect.left) / rect.width * 100));
  });

  function wireHandle(handleEl, key) {
    handleEl.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      startDrag((me) => {
        const rect = ruler.getBoundingClientRect();
        const t = pctToTime((me.clientX - rect.left) / rect.width * 100);
        if (!State.ui.loop) State.ui.loop = { ...viewWindow() };
        if (key === "start") State.ui.loop.start = Math.min(t, State.ui.loop.end - 0.1);
        else State.ui.loop.end = Math.max(t, State.ui.loop.start + 0.1);
        updateLoopVisual();
      }, () => saveProjectDebounced());
    });
  }
  wireHandle(document.getElementById("loop-handle-a"), "start");
  wireHandle(document.getElementById("loop-handle-b"), "end");
}

function updateLoopVisual() {
  const region = document.getElementById("loop-region");
  if (!State.ui.loop || !Audio.duration) {
    region.classList.remove("show");
    return;
  }
  region.classList.add("show");
  // The handles are children of #loop-region (which is itself positioned
  // at the loop's start/end below), so they need their own left set
  // relative to THAT box — 0%/100% of the region, i.e. its two edges —
  // or both sit wherever their last inline style left them (their
  // original HTML default: both at left:0, stacked on top of each
  // other at the region's start, making the start handle unreachable
  // since the end handle is later in the DOM and grabs every click).
  document.getElementById("loop-handle-a").style.left = "0%";
  document.getElementById("loop-handle-b").style.left = "100%";
  const s = timeToPct(State.ui.loop.start);
  const e = timeToPct(State.ui.loop.end);
  region.style.left = s + "%";
  region.style.width = Math.max(0, e - s) + "%";
}

// ---------------------------------------------------------------------------
// BT-08: section markers — named points on the timeline. Click jumps there;
// double-click loops from that marker to the next one (or the end, if it's
// the last), matching the M4 gate scenario directly ("mark the solo, loop
// it"). Persisted via XC-01 (State.markers, project format v2).
// ---------------------------------------------------------------------------

function sortedMarkers() {
  return [...(State.markers || [])].sort((a, b) => a.time - b.time);
}

function renderMarkers() {
  const row = document.getElementById("markers-row");
  row.innerHTML = "";
  if (!Audio.duration) return;
  // BT-17: "next marker" (for the loop-on-dblclick below) always means the
  // next one in the whole song, zoomed or not — only which markers actually
  // get a DOM element (this view's window) is affected by zoom.
  const markers = sortedMarkers();
  const { start: viewStart, end: viewEnd } = viewWindow();
  markers.forEach((m, i) => {
    if (m.time < viewStart || m.time > viewEnd) return;
    const el = document.createElement("div");
    el.className = "marker-flag";
    el.style.left = timeToPct(m.time) + "%";
    el.title = `${m.label} (${fmtTime(m.time)}) — click to jump, double-click to loop this section`;
    el.textContent = m.label;

    const del = document.createElement("span");
    del.className = "marker-delete";
    del.textContent = "×";
    del.title = "Delete marker";
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // don't also trigger the marker's own seek-on-click
      State.markers = (State.markers || []).filter((mm) => mm !== m);
      renderMarkers();
      saveProjectDebounced();
    });
    el.appendChild(del);

    el.addEventListener("click", () => seekTo(m.time));
    el.addEventListener("dblclick", () => {
      const next = markers[i + 1];
      State.ui.loop = { start: m.time, end: next ? next.time : Audio.duration };
      State.ui.loopEnabled = true;
      toggleTransportClass("loop-toggle-btn", "active", true);
      updateLoopVisual();
      saveProjectDebounced();
    });
    row.appendChild(el);
  });
}

function addMarkerAtPlayhead() {
  if (!Audio.duration) return;
  const label = prompt("Marker name:", `Marker ${(State.markers || []).length + 1}`);
  if (label === null) return; // cancelled
  State.markers = [...(State.markers || []), { time: currentPosition(), label: label.trim() || "Marker" }];
  renderMarkers();
  saveProjectDebounced();
}

// ---------------------------------------------------------------------------
// BT-02: beat grid + click stem. State.analysis.beats (from backing_track.py's
// librosa.beat.beat_track) is real detected beat timestamps, not just a
// manual-BPM assumption like the count-in click. The click stem is driven
// from tick() (rAF, ~16ms resolution) rather than pre-scheduled AudioParam
// automation — an honest tradeoff (some jitter vs. a hardware click) for
// working uniformly across both playback modes and any Speed, since it
// just watches currentPosition(), which already accounts for both.
// ---------------------------------------------------------------------------

function renderBeatGrid() {
  const row = document.getElementById("beat-grid");
  row.innerHTML = "";
  const beats = (State.analysis || {}).beats;
  if (!beats || !Audio.duration) return;
  // BT-17: the downbeat pattern (every 4th) is fixed to each beat's real
  // index in the FULL song, so zooming in never shifts which ticks look
  // like downbeats — only which ones are in range to draw at all.
  const { start: viewStart, end: viewEnd } = viewWindow();
  const frag = document.createDocumentFragment();
  beats.forEach((t, i) => {
    if (t < viewStart || t > viewEnd) return;
    const tick = document.createElement("div");
    tick.className = "beat-tick" + (i % 4 === 0 ? " downbeat" : "");
    tick.style.left = timeToPct(t) + "%";
    frag.appendChild(tick);
  });
  row.appendChild(frag);
}

// Which beat index tick() should fire next — must be resynced on every
// position jump (seekTo, stopPlayback) or a forward seek would burst-fire
// every beat skipped over in a single animation frame.
let clickBeatIndex = 0;

function resyncClickPointer(pos) {
  const beats = (State.analysis || {}).beats || [];
  let i = 0;
  while (i < beats.length && beats[i] < pos) i++;
  clickBeatIndex = i;
}

function playClickBlip(ctxTime, accented) {
  if (!Audio.clickBus) {
    Audio.clickBus = Audio.ctx.createGain();
    Audio.clickBus.gain.value = 0.5;
    Audio.clickBus.connect(Audio.ctx.destination);
  }
  const osc = Audio.ctx.createOscillator();
  osc.frequency.value = accented ? 1500 : 1000; // accent every 4th (downbeat) — same convention as scheduleCountIn's pre-roll click
  const g = Audio.ctx.createGain();
  g.gain.setValueAtTime(0.001, ctxTime);
  g.gain.exponentialRampToValueAtTime(0.6, ctxTime + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, ctxTime + 0.05);
  osc.connect(g).connect(Audio.clickBus);
  osc.start(ctxTime);
  osc.stop(ctxTime + 0.06);
}

function updateClickStem(pos) {
  const clickEl = document.getElementById("click-toggle");
  if (!clickEl || !clickEl.checked || !Audio.playing) return;
  const beats = (State.analysis || {}).beats;
  if (!beats) return;
  const now = Audio.ctx.currentTime;
  while (clickBeatIndex < beats.length && beats[clickBeatIndex] <= pos) {
    playClickBlip(now, clickBeatIndex % 4 === 0);
    clickBeatIndex++;
  }
}

// ---------------------------------------------------------------------------
// Transport + rAF tick (playhead position, loop wrap, live mute-region gain)
// ---------------------------------------------------------------------------

// V3-E5: cachedPlayheadEls is populated by renderLanes() whenever the lane
// DOM is (re)built — renderPlayhead() used to re-run a
// querySelectorAll(".lane-body .playhead") every single animation frame to
// find the exact same elements. lastPlayheadPct skips the actual style
// writes on frames where the on-screen position hasn't moved (e.g. paused).
let cachedPlayheadEls = [];
let lastPlayheadPct = null;
let lastTimeDisplayText = null;

function renderPlayhead(pos) {
  const pct = Audio.duration ? timeToPct(pos) : 0;
  if (pct === lastPlayheadPct) return;
  lastPlayheadPct = pct;
  const pctStr = pct + "%";
  for (const el of cachedPlayheadEls) el.style.left = pctStr;
  const rulerPh = document.getElementById("ruler-playhead");
  if (rulerPh) rulerPh.style.left = pctStr;
}

function renderTimeDisplay(pos) {
  const text = `${fmtTime(pos)} / ${fmtTime(Audio.duration)}`;
  if (text === lastTimeDisplayText) return;
  lastTimeDisplayText = text;
  setTransportText("time-display", text);
}

function tick() {
  if (Audio.ctx) {
    // V3-E5: was called 4x/frame (once here, once more inside each of the
    // three calls below) — currentPosition() does real work (a subtraction
    // against Audio.ctx.currentTime, or reading Audio.processedPosition),
    // not just a field read, so compute it once and pass it down.
    let pos = currentPosition();
    if (Audio.playing) {
      if (State.ui.loopEnabled && State.ui.loop && pos >= State.ui.loop.end) {
        seekTo(State.ui.loop.start);
        pos = currentPosition(); // seekTo() moves the position synchronously
      } else if (pos >= Audio.duration && Audio.duration > 0) {
        stopPlayback();
        pos = currentPosition(); // stopPlayback() resets position synchronously
        setTransportText("play-btn", "▶");
      }
    }
    applyLiveMuteRanges(pos);
    renderPlayhead(pos);
    renderTimeDisplay(pos);
    updateClickStem(pos); // BT-02
  }
  requestAnimationFrame(tick);
}

// BT-06: 1-2 bars of click before playback starts. No audio file needed —
// synthesized oscillator blips. Uses the track's own detected BPM (BT-01)
// when known, else a manual 120 BPM guess (never errors either way).
// Reused as-is by VD-01 for count-in-before-recording.
function countInBpm() {
  return (State.analysis && State.analysis.bpm) || 120;
}

function scheduleCountIn(bpm) {
  ensureCtx();
  const beatDuration = 60 / bpm;
  const beats = 8; // 2 bars of 4/4
  const startAt = Audio.ctx.currentTime + 0.05;
  const bus = Audio.ctx.createGain();
  bus.gain.value = 0.5;
  bus.connect(Audio.ctx.destination);
  for (let i = 0; i < beats; i++) {
    const osc = Audio.ctx.createOscillator();
    osc.frequency.value = (i % 4 === 0) ? 1500 : 1000; // accent beat 1 of each bar
    const g = Audio.ctx.createGain();
    const t = startAt + i * beatDuration;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(g).connect(bus);
    osc.start(t);
    osc.stop(t + 0.06);
  }
  return startAt + beats * beatDuration; // ctx time playback should begin at
}

// Runs the count-in (if the toggle is on) then calls onBeatOne() at the
// moment playback should actually start. setTimeout-based, not sample-
// scheduled — a few ms of slop here is imperceptible, unlike the
// sample-accurate multi-stem sync startPlaybackAt() itself needs.
function withOptionalCountIn(enabled, onBeatOne) {
  if (!enabled) { onBeatOne(); return; }
  const playAt = scheduleCountIn(countInBpm());
  const delayMs = Math.max(0, (playAt - Audio.ctx.currentTime) * 1000);
  setTimeout(onBeatOne, delayMs);
}

// ---------------------------------------------------------------------------
// Transport mirroring — the main toolbar transport (play/stop/loop/count-in/
// BPM/speed/tune/volume) is duplicated verbatim as a "Backing Track" card at
// the top of the Play Along panel (index.html), so switching amp models
// doesn't mean leaving Play Along to reach playback controls. Every mirrored
// control shares a data-transport="<name>" attribute across both copies;
// these helpers read/write "all copies of control X" instead of one
// getElementById, so the two stay in lockstep with no separate state.
// ---------------------------------------------------------------------------

function transportEls(name) {
  return Array.from(document.querySelectorAll(`[data-transport="${name}"]`));
}
function setTransportText(name, text) {
  for (const el of transportEls(name)) el.textContent = text;
}
function setTransportValue(name, value) {
  for (const el of transportEls(name)) el.value = value;
}
function toggleTransportClass(name, cls, on) {
  for (const el of transportEls(name)) el.classList.toggle(cls, on);
}
function onTransportClick(name, handler) {
  for (const el of transportEls(name)) el.addEventListener("click", handler);
}
// Fires handler(value) once per user interaction (not once per mirrored
// element) — the triggering element's value is pushed to every mirror
// BEFORE handler runs, so handler can read any transport value via
// transportEls(...)[0] and see the just-updated state.
function onTransportInput(name, handler) {
  for (const el of transportEls(name)) {
    el.addEventListener("input", () => {
      setTransportValue(name, el.value);
      handler(el.value);
    });
  }
}
function onTransportChange(name, handler) {
  for (const el of transportEls(name)) {
    el.addEventListener("change", () => {
      for (const other of transportEls(name)) other.checked = el.checked;
      handler(el.checked);
    });
  }
}

function wireTransport() {
  onTransportClick("play-btn", () => {
    if (!Audio.ctx || State.stems.length === 0) return;
    if (Audio.playing) {
      pausePlayback();
      setTransportText("play-btn", "▶");
    } else {
      if (Audio.ctx.state === "suspended") Audio.ctx.resume();
      // currentPosition(), not Audio.playStartOffset: in processed (Speed/
      // Tune) mode pausePlayback doesn't write playStartOffset, so resuming
      // from it would jump to a stale position — currentPosition() returns
      // Audio.processedPosition there and playStartOffset in direct mode, so
      // it's correct for both.
      const offset = currentPosition();
      const countInEl = transportEls("count-in-toggle")[0];
      withOptionalCountIn(!!(countInEl && countInEl.checked), () => startPlaybackAt(offset));
      setTransportText("play-btn", "⏸");
    }
  });
  onTransportClick("stop-btn", () => {
    stopPlayback();
    setTransportText("play-btn", "▶");
    renderPlayhead(0);
    renderTimeDisplay(0);
  });
  onTransportClick("loop-toggle-btn", () => {
    State.ui.loopEnabled = !State.ui.loopEnabled;
    if (State.ui.loopEnabled && !State.ui.loop) {
      State.ui.loop = { start: 0, end: Audio.duration || 0 };
    }
    toggleTransportClass("loop-toggle-btn", "active", State.ui.loopEnabled);
    updateLoopVisual();
    saveProjectDebounced();
  });
  onTransportChange("count-in-toggle", () => {}); // no behavior of its own — just keeps both checkboxes in sync
  // BT-08/BT-17: mixer-only (the ruler/timeline they mark up doesn't exist
  // in Play Along), so plain click handlers rather than onTransportClick's
  // mixer/Play-Along mirroring.
  document.getElementById("add-marker-btn").addEventListener("click", addMarkerAtPlayhead);
  wireZoomControls();
}

// BT-17: re-renders everything whose position is a function of viewWindow()
// after zoomWindow changes — cheaper to just re-run the existing render
// functions than to track which DOM nodes need which new lefts by hand.
function rerenderTimeline() {
  renderLanes();
  renderMarkers();
  renderBeatGrid();
  updateLoopVisual();
  renderPlayhead(currentPosition());
}

function wireZoomControls() {
  document.getElementById("zoom-to-loop-btn").addEventListener("click", () => {
    if (!State.ui.loop || !Audio.duration) return; // nothing to zoom to without a loop set (§6)
    zoomWindow = { start: State.ui.loop.start, end: State.ui.loop.end };
    document.getElementById("zoom-to-loop-btn").style.display = "none";
    document.getElementById("zoom-out-btn").style.display = "inline-block";
    rerenderTimeline();
  });
  document.getElementById("zoom-out-btn").addEventListener("click", () => {
    zoomWindow = null;
    document.getElementById("zoom-out-btn").style.display = "none";
    document.getElementById("zoom-to-loop-btn").style.display = "inline-block";
    rerenderTimeline();
  });
}

function wireVolumeSlider() {
  onTransportInput("volume-slider", (val) => {
    const pct = parseFloat(val);
    setTransportText("volume-display", pct + "%");
    // V3-E2: mute lives on Audio.masterMute now, so this slider owns
    // Audio.master.gain outright — no need to check tuner state here.
    if (Audio.master) Audio.master.gain.value = pct / 100;
  });
}

// ---------------------------------------------------------------------------
// Inspector: track analysis, guitar split, export
// ---------------------------------------------------------------------------

function updateBpmDisplay() {
  const a = State.analysis || {};
  if (!a.bpm) { setTransportText("bpm-display", "—"); return; }
  const speedEl = transportEls("speed-slider")[0];
  const speed = parseFloat((speedEl && speedEl.value) || "1");
  setTransportText("bpm-display", Math.round(a.bpm * speed));
}

function wireSpeedTune() {
  function apply() {
    const speedEl = transportEls("speed-slider")[0];
    const tuneEl = transportEls("tune-slider")[0];
    const speed = parseFloat(speedEl.value);
    const cents = parseFloat(tuneEl.value);
    setTransportText("speed-display", speed.toFixed(2) + "×");
    setTransportText("tune-display", (cents >= 0 ? "+" : "") + cents + "¢");
    updateBpmDisplay();
    updateKeyHint(); // BT-03 — live as Tune moves
    setSpeedTune(speed, Math.pow(2, cents / 1200));
  }
  onTransportInput("speed-slider", apply);
  onTransportInput("tune-slider", apply);
}

// ---------------------------------------------------------------------------
// BT-07: speed trainer — cheap once loops (§6) and markers (BT-08) exist:
// this is just a fast, repeatable way to drive the existing Speed slider
// instead of dragging it by hand between loop passes. "Start" jumps to a
// reduced practice speed; "Step up" nudges it toward Target one Step at a
// time, clamping exactly at Target rather than overshooting on the last
// click. No new audio path — setSpeedFromPercent drives the same
// speed-slider input event wireSpeedTune already listens for.
// ---------------------------------------------------------------------------
function setSpeedFromPercent(pct) {
  const speedEl = transportEls("speed-slider")[0];
  const clamped = Math.max(parseFloat(speedEl.min), Math.min(parseFloat(speedEl.max), pct / 100));
  setTransportValue("speed-slider", clamped.toFixed(2));
  speedEl.dispatchEvent(new Event("input", { bubbles: true }));
}

function wireSpeedTrainer() {
  document.getElementById("trainer-start-btn").addEventListener("click", () => {
    const startPct = parseFloat(document.getElementById("trainer-start-pct").value) || 100;
    setSpeedFromPercent(startPct);
    document.getElementById("trainer-status").textContent =
      `Speed set to ${startPct}%. Loop the passage (§6), then click Step up once it's clean.`;
  });
  document.getElementById("trainer-step-btn").addEventListener("click", () => {
    const stepPct = parseFloat(document.getElementById("trainer-step-pct").value) || 10;
    const targetPct = parseFloat(document.getElementById("trainer-target-pct").value) || 100;
    const speedEl = transportEls("speed-slider")[0];
    const currentPct = parseFloat(speedEl.value) * 100;
    const nextPct = currentPct >= targetPct ? targetPct : Math.min(targetPct, currentPct + stepPct);
    setSpeedFromPercent(nextPct);
    document.getElementById("trainer-status").textContent = nextPct >= targetPct
      ? `At target speed (${targetPct}%).`
      : `Stepped up to ${Math.round(nextPct)}% (target ${targetPct}%).`;
  });
}

const PITCH_OFFSET_NOTE_THRESHOLD_CENTS = 8; // mirrors backing_track.py's constant of the same name

// BT-03: same 12 names/order as backing_track.py's KEY_NOTE_NAMES — this
// mirrors that heuristic's output, not a second key-detection implementation.
const KEY_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function transposedKeyName(keyName, semitones) {
  const idx = KEY_NOTE_NAMES.indexOf(keyName);
  if (idx < 0) return null;
  return KEY_NOTE_NAMES[((idx + semitones) % 12 + 12) % 12];
}

// BT-03: the detected key is informational (confirm by ear, like every
// other heuristic here) — the point of showing it alongside the Tune
// slider's current position is answering "if I transpose by this much,
// what key does that actually put me in", since Tune's own ±1200¢ range
// covers a full octave of transposition now, not just fine tuning-drift
// correction. Called both on track load (renderInspector) and live while
// dragging Tune (wireSpeedTune), so it never goes stale mid-drag.
function updateKeyHint() {
  const el = document.getElementById("key-hint");
  const key = (State.analysis || {}).key;
  if (!key) { el.textContent = ""; return; }
  const base = `Detected key: ${key.key} ${key.mode} (confidence ${key.confidence.toFixed(2)} — a heuristic, confirm by ear).`;
  const tuneEl = transportEls("tune-slider")[0];
  const cents = tuneEl ? parseFloat(tuneEl.value) : 0;
  const semitones = Math.trunc(cents / 100);
  if (semitones === 0) { el.textContent = base; return; }
  const remCents = cents - semitones * 100;
  const newKey = transposedKeyName(key.key, semitones);
  el.textContent = `${base} Transposed ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}` +
    (remCents ? ` (plus ${remCents > 0 ? "+" : ""}${remCents.toFixed(0)}¢ fine tune)` : "") +
    (newKey ? ` → ${newKey} ${key.mode}.` : ".");
}

function renderInspector() {
  const a = State.analysis || {};
  updateBpmDisplay();

  let pitchHint = "";
  const applyBtn = document.getElementById("pitch-apply-btn");
  const offBeyondThreshold = a.pitch_offset_cents != null && Math.abs(a.pitch_offset_cents) >= PITCH_OFFSET_NOTE_THRESHOLD_CENTS;
  if (a.pitch_offset_cents != null) {
    pitchHint = offBeyondThreshold
      ? `This song appears to be ${a.pitch_offset_cents >= 0 ? "+" : ""}${a.pitch_offset_cents.toFixed(1)} cents from A=440 — apply?`
      : `Reference pitch: ${a.pitch_offset_cents.toFixed(1)}¢ from A=440 (close enough to ignore).`;
  }
  document.getElementById("pitch-hint").textContent = pitchHint;
  applyBtn.style.display = offBeyondThreshold ? "inline-block" : "none";
  applyBtn.onclick = () => {
    setTransportValue("tune-slider", Math.round(a.pitch_offset_cents));
    transportEls("tune-slider")[0].dispatchEvent(new Event("input"));
  };
  updateKeyHint();

  const hasGuitar = State.stems.some((s) => s.name === "guitar");
  document.getElementById("split-panel").style.display = hasGuitar ? "block" : "none";
}

let splitMethod = "spectral";

function wireSplitPanel() {
  document.querySelectorAll("#split-methods button").forEach((btn) => {
    btn.addEventListener("click", () => {
      splitMethod = btn.dataset.method;
      document.querySelectorAll("#split-methods button").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });
  document.getElementById("run-split-btn").addEventListener("click", async () => {
    const btn = document.getElementById("run-split-btn");
    btn.disabled = true;
    try {
      const r = await Api.post("/api/split_guitar", {
        source_path: State.track, model: State.model, stem: "guitar", method: splitMethod,
      });
      document.getElementById("split-correlation").textContent =
        `Correlation: ${r.correlation.toFixed(2)} — diagnostic only, does not predict split ` +
        `quality. Judge by listening.`;
      await refreshStemsForCurrentModelAndTrack();
    } catch (e) {
      alert("Split failed: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function wireExportPanel() {
  document.getElementById("export-normalize").addEventListener("change", (e) => {
    document.getElementById("boost-cap-row").style.display = e.target.checked ? "block" : "none";
  });
  document.getElementById("run-export-btn").addEventListener("click", runExport);
}

async function runExport() {
  // Export bounces exactly what's heard, except solo — solo is a monitoring
  // convenience only (ui-spec.md §5.4), so it's deliberately not applied here.
  const gains = {};
  for (const stem of State.stems) {
    gains[stem.name] = State.mix.muted[stem.name] ? 0 : (State.mix.gains[stem.name] ?? 1.0);
  }
  const body = {
    source_path: State.track,
    model: State.model,
    gains,
    mute_ranges: State.mix.muteRanges,
    target_lufs: parseFloat(document.getElementById("export-lufs").value) || -14,
    normalize: document.getElementById("export-normalize").checked,
    max_boost_db: parseFloat(document.getElementById("export-boost-cap").value) || 10,
    format: document.getElementById("export-format").value,
    output_name: document.getElementById("export-name").value,
  };
  const resultEl = document.getElementById("export-result");
  resultEl.className = "";
  resultEl.textContent = "Exporting…";
  const btn = document.getElementById("run-export-btn");
  btn.disabled = true;
  try {
    const r = await Api.post("/api/mix", body);
    let html = `Exported to ${escapeHtml(r.output_path)}<br>`;
    html += (r.measured_lufs != null)
      ? `Measured ${r.measured_lufs.toFixed(1)} LUFS, applied ${r.applied_gain_db.toFixed(1)} dB`
      : "Mix is silent — normalization skipped";
    if (r.boost_capped) html += " (boost capped)";
    if (r.peak_clamped) html += "<br>Peak-clamped to avoid clipping.";
    html += `<br><button id="reveal-export-btn">Reveal in Finder</button>`;
    resultEl.innerHTML = html;
    document.getElementById("reveal-export-btn").addEventListener("click", () => {
      Api.post("/api/reveal", { path: r.output_path }).catch(() => {});
    });
  } catch (e) {
    resultEl.className = "error";
    resultEl.textContent = "Export failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Model badge/menu (BT-13 — switch between separation models per track)
// ---------------------------------------------------------------------------

function renderModelMenu() {
  const menu = document.getElementById("model-menu");
  menu.innerHTML = "";
  for (const m of State.models) {
    const div = document.createElement("div");
    div.textContent = m.name;
    div.addEventListener("click", () => switchModel(m.name));
    menu.appendChild(div);
  }
}

async function switchModel(model) {
  document.getElementById("model-menu").classList.remove("open");
  if (model === State.model) return;
  State.model = model;
  State.mix = { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {} };
  updateModelBadge();
  await refreshStemsForCurrentModelAndTrack();
  saveProjectDebounced();
}

function wireModelBadge() {
  document.getElementById("model-badge").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("model-menu").classList.toggle("open");
  });
  document.addEventListener("click", () => document.getElementById("model-menu").classList.remove("open"));
}

// ---------------------------------------------------------------------------
// Separate (toolbar button — always the current model-badge selection) +
// stale banner. force=true always: if stems already exist for this model,
// hitting Separate overwrites them (the toolbar is the one place a rerun
// is always available, whether or not stems already exist).
// ---------------------------------------------------------------------------

function updateSeparatingProgress(percent, status) {
  const fill = document.getElementById("separating-progress-fill");
  const text = document.getElementById("separating-progress-text");
  const pct = Math.max(0, Math.min(100, percent || 0));
  fill.style.width = pct + "%";
  text.textContent = status === "queued"
    ? "Queued — waiting for another separation to finish..."
    : `${pct}%`;
}

async function runSeparate(force) {
  const model = State.model;
  const track = State.track;
  showState("separating-state");
  updateSeparatingProgress(0, "queued");

  let polling = true;
  (async () => {
    while (polling) {
      try {
        const s = await Api.get(`/api/separate_status?source_path=${encodeURIComponent(track)}` +
          `&model=${encodeURIComponent(model)}`);
        if (polling) updateSeparatingProgress(s.percent, s.status);
      } catch (e) { /* best-effort — a missed poll just means one stale frame */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();

  try {
    const r = await Api.post("/api/separate", { source_path: track, model, force });
    polling = false;
    await onStemsLoaded(r);
    saveProjectDebounced();
  } catch (e) {
    polling = false;
    alert("Separation failed: " + e.message);
    await refreshStemsForCurrentModelAndTrack();
  }
}

function wireSeparateButton() {
  document.getElementById("separate-btn").addEventListener("click", () => runSeparate(true));
}

function wireStaleBanner() {
  document.getElementById("reseparate-btn").addEventListener("click", () => runSeparate(true));
  document.getElementById("dismiss-stale-btn").addEventListener("click", () => {
    document.getElementById("stale-banner").classList.remove("show");
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function wireImport() {
  const dropEl = document.getElementById("import-drop");
  const sidebarEl = document.getElementById("sidebar");
  const inputEl = document.getElementById("import-input");
  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
  });

  // Without a document-level dragover/drop handler, a drop that misses the
  // (small, easy to miss) drop box falls through to the browser's own
  // default: navigating the tab to the dropped file, replacing the whole
  // app. Catch anything not handled by a more specific target below.
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => e.preventDefault());

  // The whole sidebar is a drop target, not just the dashed box — "drop it
  // somewhere in the library area" is what people actually do, and the box
  // alone is a small target to hit precisely.
  sidebarEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
  sidebarEl.addEventListener("dragleave", (e) => {
    if (!sidebarEl.contains(e.relatedTarget)) dropEl.classList.remove("dragover");
  });
  sidebarEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) importFile(f);
  });
}

async function importFile(file) {
  // This project directory is cloud-synced (OneDrive), so a full-file
  // write on import can genuinely take a while depending on file size and
  // sync load — not something the app can speed up, but a bare, unchanging
  // "Drop a file" box while a multi-MB upload is in flight reads as hung.
  // Make it visibly do something instead.
  const dropEl = document.getElementById("import-drop");
  const originalHtml = dropEl.innerHTML;
  dropEl.textContent = `Importing ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const r = await Api.postRaw(`/api/import?filename=${encodeURIComponent(file.name)}`, buf);
    await refreshTrackList();
    await selectTrack(r.name);
  } finally {
    dropEl.innerHTML = originalHtml;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderLanes, 200);
});

// ---------------------------------------------------------------------------
// XC-02: keyboard shortcuts. Scheduled last in the v0.4 roadmap deliberately
// — several of these bind to UI (BT-05's loop handles especially) that was
// still being built earlier in the same release.
// ---------------------------------------------------------------------------

let hoveredStemName = null; // set by renderLanes()'s mouseenter/mouseleave

function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function toggleShortcutsLegend() {
  document.getElementById("shortcuts-overlay").classList.toggle("show");
}

// XC-04: in-app onboarding/help — auto-shown once on first launch (nobody
// reads USER-MANUAL.md before diving in), reachable any time after via the
// sidebar's ❓ Help button.
const HELP_SEEN_KEY = "gs_help_seen";

function toggleHelp() {
  document.getElementById("help-overlay").classList.toggle("show");
}

function wireHelp() {
  document.getElementById("help-open-btn").addEventListener("click", toggleHelp);
  document.getElementById("help-close-btn").addEventListener("click", toggleHelp);
  document.getElementById("help-overlay").addEventListener("click", (e) => {
    if (e.target.id === "help-overlay") toggleHelp();
  });
  if (!localStorage.getItem(HELP_SEEN_KEY)) {
    localStorage.setItem(HELP_SEEN_KEY, "1");
    toggleHelp();
  }
}

function wireKeyboardShortcuts() {
  document.getElementById("shortcuts-close-btn").addEventListener("click", toggleShortcutsLegend);
  document.getElementById("shortcuts-overlay").addEventListener("click", (e) => {
    if (e.target.id === "shortcuts-overlay") toggleShortcutsLegend();
  });

  document.addEventListener("keydown", (e) => {
    if (isTextInputFocused()) return;

    if (e.key === "?") {
      toggleShortcutsLegend();
      return;
    }
    if (!State.stems.length) return; // everything else needs a loaded track

    switch (e.key) {
      case " ":
        // release-v0.4-spec.md's XC-02 opens with "Beyond Space: ..." —
        // treating Space-to-play/pause as pre-existing baseline. It never
        // actually got wired in the rebuild until now.
        e.preventDefault();
        transportEls("play-btn")[0].click();
        break;
      case "l": case "L":
        transportEls("loop-toggle-btn")[0].click();
        break;
      case "[":
        if (Audio.duration) {
          if (!State.ui.loop) State.ui.loop = { start: 0, end: Audio.duration };
          State.ui.loop.start = Math.min(currentPosition(), State.ui.loop.end - 0.1);
          updateLoopVisual();
          saveProjectDebounced();
        }
        break;
      case "]":
        if (Audio.duration) {
          if (!State.ui.loop) State.ui.loop = { start: 0, end: Audio.duration };
          State.ui.loop.end = Math.max(currentPosition(), State.ui.loop.start + 0.1);
          updateLoopVisual();
          saveProjectDebounced();
        }
        break;
      case "m": case "M":
        if (hoveredStemName) toggleMute(hoveredStemName);
        break;
      case "s": case "S":
        if (hoveredStemName) toggleSolo(hoveredStemName);
        break;
      case "r": case "R":
        if (typeof toggleRecording === "function") toggleRecording();
        break;
      case "ArrowLeft":
        e.preventDefault();
        // BT-17: Alt = finer 100ms nudge, for lining up a loop/mute edge to
        // an exact transient rather than the plain 1s step's coarse range.
        seekTo(Math.max(0, currentPosition() - (e.shiftKey ? 5 : e.altKey ? 0.1 : 1)));
        break;
      case "ArrowRight":
        e.preventDefault();
        seekTo(Math.min(Audio.duration, currentPosition() + (e.shiftKey ? 5 : e.altKey ? 0.1 : 1)));
        break;
      default:
        break;
    }
  });
}

async function init() {
  initRuler();
  wireTransport();
  wireModelBadge();
  wireSplitPanel();
  wireExportPanel();
  wireSeparateButton();
  wireStaleBanner();
  wireImport();
  wireSpeedTune();
  wireSpeedTrainer();
  wireVolumeSlider();
  wireKeyboardShortcuts();
  wireHelp();

  const modelsResp = await Api.get("/api/models");
  State.models = modelsResp.models;
  State.defaultModel = modelsResp.default;
  renderModelMenu();

  await refreshTrackList();
  requestAnimationFrame(tick);
}

init();
