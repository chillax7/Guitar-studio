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
  // monitoring-only, per ui-spec.md §5.4).
  mix: { gains: {}, muted: {}, solo: null, muteRanges: {} },
  ui: { viewMode: "mixer", loop: null, loopEnabled: false },
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
  analyser: null,
  buffers: {},
  gains: {},
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
    Audio.analyser = Audio.ctx.createAnalyser();
    Audio.master.connect(Audio.analyser);
    Audio.analyser.connect(Audio.ctx.destination);
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
  Audio.duration = 0;
  for (const [name, buf] of entries) {
    Audio.buffers[name] = buf;
    Audio.duration = Math.max(Audio.duration, buf.duration);
    const g = Audio.ctx.createGain();
    g.connect(Audio.master);
    Audio.gains[name] = g;
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

function computePeaks(buffer, buckets) {
  const data = buffer.getChannelData(0);
  const peaks = new Float32Array(buckets);
  const perBucket = Math.max(1, Math.floor(data.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * perBucket;
    const end = Math.min(start + perBucket, data.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }
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

let saveTimer = null;
function saveProjectDebounced() {
  if (!State.track) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    Api.post("/api/project", {
      track: State.track,
      project: { model: State.model, mix: State.mix, ui: State.ui },
    }).catch(() => { /* best-effort */ });
  }, 600);
}

// ---------------------------------------------------------------------------
// Track lifecycle
// ---------------------------------------------------------------------------

function showState(name) {
  for (const s of ["empty-state", "separate-cta", "separating-state", "workspace"]) {
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
    row.textContent = t.name;
    row.addEventListener("click", () => selectTrack(t.name));
    el.appendChild(row);
  }
}

async function selectTrack(name) {
  State.track = name;
  renderTrackList();
  stopPlayback();
  showState("empty-state");

  // Speed/Tune aren't part of the saved project (deliberately — carrying
  // yesterday's half-speed setting silently into a new song would be a
  // trap, not a feature); reset to unity on every track switch.
  document.getElementById("speed-slider").value = "1";
  document.getElementById("tune-slider").value = "0";
  document.getElementById("speed-display").textContent = "1.00×";
  document.getElementById("tune-display").textContent = "0¢";
  await setSpeedTune(1.0, 1.0);

  let project = null;
  try {
    project = await Api.get(`/api/project?track=${encodeURIComponent(name)}`);
  } catch (e) { /* no saved project yet */ }

  State.model = (project && project.model) || State.defaultModel;
  State.mix = (project && project.mix) || { gains: {}, muted: {}, solo: null, muteRanges: {} };
  State.ui = (project && project.ui) || { viewMode: "mixer", loop: null, loopEnabled: false };
  setViewMode(State.ui.viewMode, /*save=*/false);
  document.getElementById("loop-toggle-btn").classList.toggle("active", State.ui.loopEnabled);
  updateModelBadge();

  await refreshStemsForCurrentModelAndTrack();
}

async function refreshStemsForCurrentModelAndTrack() {
  try {
    const r = await Api.get(`/api/list_stems?source_path=${encodeURIComponent(State.track)}` +
      `&model=${encodeURIComponent(State.model)}`);
    await onStemsLoaded(r);
  } catch (e) {
    if (e.status === 404) {
      showSeparateCta();
    } else {
      alert("Error loading stems: " + e.message);
    }
  }
}

function showSeparateCta() {
  showState("separate-cta");
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
  renderPlayhead(currentPosition());
  renderTimeDisplay(currentPosition());
}

function updateStaleBanner() {
  document.getElementById("stale-banner").classList.toggle("show", !!State.stale);
}

// ---------------------------------------------------------------------------
// Lanes (Mixer + Timeline share this — Timeline just adds the mute-paint lane)
// ---------------------------------------------------------------------------

function renderLanes() {
  const container = document.getElementById("lanes");
  container.innerHTML = "";
  const timeline = State.ui.viewMode === "timeline";

  for (const stem of orderedStems()) {
    const name = stem.name;
    const lane = document.createElement("div");
    lane.className = "lane" +
      (State.mix.muted[name] ? " muted" : "") +
      (State.mix.solo === name ? " solo-active" : "");

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
        <input type="range" min="0" max="1.5" step="0.01" value="${State.mix.gains[name] ?? 1.0}">
        <span>${Math.round((State.mix.gains[name] ?? 1.0) * 100)}%</span>
      </div>`;
    lane.appendChild(header);

    const body = document.createElement("div");
    body.className = "lane-body" + (timeline ? " timeline" : "");
    const canvas = document.createElement("canvas");
    body.appendChild(canvas);
    const playhead = document.createElement("div");
    playhead.className = "playhead";
    body.appendChild(playhead);

    if (timeline) {
      const muteLane = document.createElement("div");
      muteLane.className = "mute-lane";
      wireMuteLane(muteLane, name);
      renderMuteRegions(muteLane, name);
      body.appendChild(muteLane);
    }
    lane.appendChild(body);
    container.appendChild(lane);

    header.querySelector(".mute-btn").addEventListener("click", () => toggleMute(name));
    header.querySelector(".solo-btn").addEventListener("click", () => toggleSolo(name));
    const fader = header.querySelector("input[type=range]");
    fader.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      setGain(name, v);
      header.querySelector(".lane-fader span").textContent = Math.round(v * 100) + "%";
    });
    canvas.addEventListener("click", (e) => seekFromElement(canvas, e));

    const buf = Audio.buffers[name];
    if (buf) requestAnimationFrame(() => drawWaveform(canvas, computePeaks(buf, 400)));
  }
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

function seekFromElement(el, e) {
  const rect = el.getBoundingClientRect();
  seekTo(clamp01((e.clientX - rect.left) / rect.width) * Audio.duration);
}

function renderMuteRegions(muteLaneEl, stemName) {
  const ranges = State.mix.muteRanges[stemName] || [];
  for (const [s, e] of ranges) {
    const div = document.createElement("div");
    div.className = "mute-region";
    div.style.left = (s / Audio.duration * 100) + "%";
    div.style.width = ((e - s) / Audio.duration * 100) + "%";
    muteLaneEl.appendChild(div);
  }
}

function wireMuteLane(el, stemName) {
  let dragStart = null;
  let tempEl = null;

  el.addEventListener("mousedown", (e) => {
    const rect = el.getBoundingClientRect();
    dragStart = clamp01((e.clientX - rect.left) / rect.width) * Audio.duration;
  });
  el.addEventListener("mousemove", (e) => {
    if (dragStart == null) return;
    const rect = el.getBoundingClientRect();
    const cur = clamp01((e.clientX - rect.left) / rect.width) * Audio.duration;
    const s = Math.min(dragStart, cur), en = Math.max(dragStart, cur);
    if (!tempEl) {
      tempEl = document.createElement("div");
      tempEl.className = "mute-region";
      el.appendChild(tempEl);
    }
    tempEl.style.left = (s / Audio.duration * 100) + "%";
    tempEl.style.width = ((en - s) / Audio.duration * 100) + "%";
  });
  function finish(e) {
    if (dragStart == null) return;
    const rect = el.getBoundingClientRect();
    const cur = clamp01((e.clientX - rect.left) / rect.width) * Audio.duration;
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
    seekTo(clamp01((e.clientX - rect.left) / rect.width) * Audio.duration);
  });

  function wireHandle(handleEl, key) {
    handleEl.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      startDrag((me) => {
        const rect = ruler.getBoundingClientRect();
        const t = clamp01((me.clientX - rect.left) / rect.width) * Audio.duration;
        if (!State.ui.loop) State.ui.loop = { start: 0, end: Audio.duration };
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
  const s = State.ui.loop.start / Audio.duration * 100;
  const e = State.ui.loop.end / Audio.duration * 100;
  region.style.left = s + "%";
  region.style.width = Math.max(0, e - s) + "%";
}

// ---------------------------------------------------------------------------
// Transport + rAF tick (playhead position, loop wrap, live mute-region gain)
// ---------------------------------------------------------------------------

function renderPlayhead(pos) {
  const pct = Audio.duration ? (pos / Audio.duration * 100) : 0;
  document.querySelectorAll(".lane-body .playhead").forEach((el) => el.style.left = pct + "%");
  const rulerPh = document.getElementById("ruler-playhead");
  if (rulerPh) rulerPh.style.left = pct + "%";
}

function renderTimeDisplay(pos) {
  document.getElementById("time-display").textContent = `${fmtTime(pos)} / ${fmtTime(Audio.duration)}`;
}

function tick() {
  if (Audio.ctx) {
    const pos = currentPosition();
    if (Audio.playing) {
      if (State.ui.loopEnabled && State.ui.loop && pos >= State.ui.loop.end) {
        seekTo(State.ui.loop.start);
      } else if (pos >= Audio.duration && Audio.duration > 0) {
        stopPlayback();
        document.getElementById("play-btn").textContent = "▶";
      }
    }
    applyLiveMuteRanges(currentPosition());
    renderPlayhead(currentPosition());
    renderTimeDisplay(currentPosition());
  }
  requestAnimationFrame(tick);
}

function wireTransport() {
  document.getElementById("play-btn").addEventListener("click", () => {
    if (!Audio.ctx || State.stems.length === 0) return;
    if (Audio.playing) {
      pausePlayback();
      document.getElementById("play-btn").textContent = "▶";
    } else {
      if (Audio.ctx.state === "suspended") Audio.ctx.resume();
      startPlaybackAt(Audio.playStartOffset);
      document.getElementById("play-btn").textContent = "⏸";
    }
  });
  document.getElementById("stop-btn").addEventListener("click", () => {
    stopPlayback();
    document.getElementById("play-btn").textContent = "▶";
    renderPlayhead(0);
    renderTimeDisplay(0);
  });
  document.getElementById("loop-toggle-btn").addEventListener("click", () => {
    State.ui.loopEnabled = !State.ui.loopEnabled;
    if (State.ui.loopEnabled && !State.ui.loop) {
      State.ui.loop = { start: 0, end: Audio.duration || 0 };
    }
    document.getElementById("loop-toggle-btn").classList.toggle("active", State.ui.loopEnabled);
    updateLoopVisual();
    saveProjectDebounced();
  });
}

function setViewMode(mode, save = true) {
  State.ui.viewMode = mode;
  document.getElementById("view-mixer").classList.toggle("active", mode === "mixer");
  document.getElementById("view-timeline").classList.toggle("active", mode === "timeline");
  renderLanes();
  if (save) saveProjectDebounced();
}

// ---------------------------------------------------------------------------
// Inspector: track analysis, guitar split, export
// ---------------------------------------------------------------------------

function updateBpmDisplay() {
  const a = State.analysis || {};
  if (!a.bpm) { document.getElementById("bpm-display").textContent = "—"; return; }
  const speed = parseFloat(document.getElementById("speed-slider").value || "1");
  document.getElementById("bpm-display").textContent = (a.bpm * speed).toFixed(1);
}

function wireSpeedTune() {
  const speedEl = document.getElementById("speed-slider");
  const tuneEl = document.getElementById("tune-slider");
  function apply() {
    const speed = parseFloat(speedEl.value);
    const cents = parseFloat(tuneEl.value);
    document.getElementById("speed-display").textContent = speed.toFixed(2) + "×";
    document.getElementById("tune-display").textContent = (cents >= 0 ? "+" : "") + cents + "¢";
    updateBpmDisplay();
    setSpeedTune(speed, Math.pow(2, cents / 1200));
  }
  speedEl.addEventListener("input", apply);
  tuneEl.addEventListener("input", apply);
}

const PITCH_OFFSET_NOTE_THRESHOLD_CENTS = 8; // mirrors backing_track.py's constant of the same name

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
    const tuneEl = document.getElementById("tune-slider");
    tuneEl.value = Math.round(a.pitch_offset_cents);
    tuneEl.dispatchEvent(new Event("input"));
  };

  const hasGuitar = State.stems.some((s) => s.name === "guitar");
  document.getElementById("split-panel").style.display = hasGuitar ? "block" : "none";
  document.getElementById("split-open-btn").style.display = hasGuitar ? "inline-block" : "none";
  document.getElementById("export-open-btn").style.display = "inline-block";
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
  document.getElementById("split-open-btn").addEventListener("click", () => {
    document.getElementById("split-panel").scrollIntoView({ behavior: "smooth" });
  });
}

function wireExportPanel() {
  document.getElementById("export-open-btn").addEventListener("click", () => {
    document.getElementById("export-panel").scrollIntoView({ behavior: "smooth" });
  });
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
  State.mix = { gains: {}, muted: {}, solo: null, muteRanges: {} };
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
// Separate CTA + stale banner
// ---------------------------------------------------------------------------

function populateSeparateModelSelect() {
  const sel = document.getElementById("separate-model-select");
  sel.innerHTML = "";
  for (const m of State.models) {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = `${m.name} (${m.stems.join(", ")})`;
    if (m.name === State.defaultModel) opt.selected = true;
    sel.appendChild(opt);
  }
  function updateHint() {
    const guitarCapable = sel.value === "htdemucs_6s" || sel.value === "bs_roformer_sw";
    document.getElementById("separate-model-hint").textContent = guitarCapable
      ? "Isolates guitar (and piano) separately — needed for the guitar split feature."
      : "Standard 4-stem split — fastest.";
  }
  sel.addEventListener("change", updateHint);
  updateHint();
}

function wireSeparateCta() {
  document.getElementById("separate-btn").addEventListener("click", async () => {
    const model = document.getElementById("separate-model-select").value;
    State.model = model;
    showState("separating-state");
    try {
      const r = await Api.post("/api/separate", { source_path: State.track, model });
      await onStemsLoaded(r);
      saveProjectDebounced();
    } catch (e) {
      alert("Separation failed: " + e.message);
      showSeparateCta();
    }
  });
}

function wireStaleBanner() {
  document.getElementById("reseparate-btn").addEventListener("click", async () => {
    showState("separating-state");
    try {
      const r = await Api.post("/api/separate", { source_path: State.track, model: State.model, force: true });
      await onStemsLoaded(r);
    } catch (e) {
      alert("Re-separation failed: " + e.message);
      showState("workspace");
    }
  });
  document.getElementById("dismiss-stale-btn").addEventListener("click", () => {
    document.getElementById("stale-banner").classList.remove("show");
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function wireImport() {
  const dropEl = document.getElementById("import-drop");
  const inputEl = document.getElementById("import-input");
  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
  });
  dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("dragover"); });
  dropEl.addEventListener("dragleave", () => dropEl.classList.remove("dragover"));
  dropEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) importFile(f);
  });
}

async function importFile(file) {
  const buf = await file.arrayBuffer();
  const r = await Api.postRaw(`/api/import?filename=${encodeURIComponent(file.name)}`, buf);
  await refreshTrackList();
  await selectTrack(r.name);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function wireViewToggle() {
  document.getElementById("view-mixer").addEventListener("click", () => setViewMode("mixer"));
  document.getElementById("view-timeline").addEventListener("click", () => setViewMode("timeline"));
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderLanes, 200);
});

async function init() {
  initRuler();
  wireTransport();
  wireViewToggle();
  wireModelBadge();
  wireSplitPanel();
  wireExportPanel();
  wireSeparateCta();
  wireStaleBanner();
  wireImport();
  wireSpeedTune();

  const modelsResp = await Api.get("/api/models");
  State.models = modelsResp.models;
  State.defaultModel = modelsResp.default;
  renderModelMenu();
  populateSeparateModelSelect();

  await refreshTrackList();
  requestAnimationFrame(tick);
}

init();
