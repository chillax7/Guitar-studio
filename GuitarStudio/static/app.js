"use strict";

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------

const Api = {
  // Real user report: "stems failed to fetch" — happening on the first
  // track picked right after starting the app, even though the stems
  // genuinely exist and load fine on a retry. fetch() itself throws a
  // bare TypeError ("Failed to fetch"/"NetworkError...") with no HTTP
  // response at all when the connection can't be made yet — a brief
  // cold-start race between the page finishing its own load and the
  // backend actually being ready to accept a request, not a real error
  // about the data. GET is idempotent, so retrying a handful of times
  // with a short backoff absorbs that race for free in the vast majority
  // of cases; a genuine HTTP error (404, 500 — response.status IS set)
  // is a real answer and must never be retried, only a fetch that threw
  // before reaching a response at all.
  async get(path) {
    return Api._withRetry(() => fetch(path));
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
  async _withRetry(doFetch, attempts = 3, delayMs = 400) {
    for (let i = 0; i < attempts; i++) {
      try {
        return await Api._handle(await doFetch());
      } catch (e) {
        if (e.status !== undefined || i === attempts - 1) throw e;
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
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

const ALL_TRACKS_GROUP_KEY = "\0all-tracks"; // NUL-prefixed: can't collide with a real (user-typed) playlist name

const State = {
  tracks: [],
  playlists: {}, // V4-F3 — {name: {tracks: [trackName, ...]}}, shared cross-song (like rig presets)
  autoPlaylist: localStorage.getItem("gs_autoplay_playlist") || null, // ⟳ auto-play — which playlist (if any) chains songs on natural end; see maybeAutoAdvance
  expandedPlaylists: new Set([ALL_TRACKS_GROUP_KEY]), // which playlist groups are open in the Library tree — All Tracks starts open; in-memory only, resets on reload
  models: [],
  defaultModel: "htdemucs",
  track: null,
  model: null,
  stems: [],
  analysis: {},
  stale: false,
  // mix is the live recipe AND the export recipe (minus solo — solo is
  // monitoring-only, per ui-spec.md §5.4). eq/pan (BT-11) and offset
  // (GP-15) are additive to the existing project.mix shape, not a version
  // bump — see selectTrack's backfill for projects saved before they
  // existed. offset is seconds-from-song-start a custom stem's own clip
  // begins at (0 for every ordinary stem — dragging its waveform is the
  // only way this ever becomes nonzero, see wireCustomStemOffsetDrag).
  mix: { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {}, offset: {} },
  ui: { loop: null, loopEnabled: false },
  // XC-01 (project format v2)
  markers: [], // BT-08 (M4) — not populated until that lands
  // GP-14: an ORDERED LIST of rig presets attached to this song (e.g.
  // ["Clean", "Rhythm", "Lead"]), plus which one is currently active —
  // replaces GP-02's single rigPreset string (see migrateProjectV2/
  // selectTrack for the backfill from that older shape).
  rigPresetChain: [],
  rigPresetIndex: 0,
  rigPresetCycleKeyForward: null, // null = use the app-wide default ("ArrowRight") — see playalong.js
  rigPresetCycleKeyBackward: null, // null = use the app-wide default ("ArrowLeft") — see playalong.js
  rigPresetApplied: false, // has paApplyAttachedRigPreset already run for the current track
  bpmOverride: null, // user-corrected BPM (×2/½ octave-error fix), overrides State.analysis.bpm once loaded
  // Real user report: detect_key (backing_track.py) is a global chroma/
  // profile-correlation heuristic — it can favor a related key (e.g. a
  // bVII chord borrowed often enough in a D minor song can tip the
  // correlation toward its relative-ish major, Bb/A#) over the one a
  // guitarist would actually call the song. No auto-fix for this the way
  // BPM's ×2/½ exists (there's no simple formula from "wrong key" to
  // "right key"), so this is a direct manual override instead — see
  // correctKey()/resetKeyCorrection(). Kept separate from
  // State.analysis.key (which stays the raw detected value) rather than
  // overwriting it, so "reset" has something real to go back to.
  keyOverride: null,
};

const STEM_ORDER = ["vocals", "drums", "bass", "guitar", "piano", "other"];

// GP-16: an imported stem pack (§3.3) never produces a stem literally
// named "guitar" — its stems keep whatever names the source files had.
// Suggest a tone, Rate My Take, and Practice Tips all need one real WAV
// file to treat as "the guitar" (they ask the server for a stem by exact
// name), so without this they simply never appear for an imported pack,
// even when one of its stems obviously IS the guitar part. Lets a user
// designate any one stem as that reference — stored per-song
// (State.guitarStemOverride, saveProjectDebounced) — without needing the
// file itself renamed or reprocessed. A real model-produced "guitar"
// stem always wins if one exists; the override only matters when there
// isn't one (see the lane-guitar-btn wiring in renderLanes for where
// it's set, and Guitar Split's own hasGuitar check in wireSplitPanel,
// which deliberately does NOT use this — that feature specifically needs
// the separator's own guitar stem, not an arbitrary stand-in).
function resolvedGuitarStemName() {
  if (State.stems.some((s) => s.name === "guitar" && !s.is_derived && !s.is_custom)) return "guitar";
  if (State.guitarStemOverride && State.stems.some((s) => s.name === State.guitarStemOverride)) {
    return State.guitarStemOverride;
  }
  return null;
}

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
// `label` is the raw filename an imported stem pack shipped with
// (multi-stem-import-spec.md) — safe_name() sanitizes `name` for on-disk/
// dict-key use and isn't always reversible, so the server hands back the
// original separately for display rather than the UI trying to prettify it.
function stemDisplayName(name, label) {
  if (name.endsWith("_center")) return `Candidate A (center) — from ${name.slice(0, -7)}`;
  if (name.endsWith("_sides")) return `Candidate B (sides) — from ${name.slice(0, -6)}`;
  if (label) return label;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Split candidates (Candidate A/center, Candidate B/sides — see
// stemDisplayName above) come out of the panning-based split quieter than
// a normal stem, sides especially — the mid-side math that isolates them
// throws away most of the signal's energy along the way, not a mixing
// choice. The regular 150% fader ceiling isn't enough headroom to bring a
// quiet candidate back up to par with the rest of the mix.
function isSplitCandidate(name) {
  return name.endsWith("_center") || name.endsWith("_sides");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// Real user report: a Rip that ran ~4 minutes unattended in a background
// tab, then a browser freeze/crash right after clicking Stop. The prompt()
// called immediately afterward (to name the rip) is the prime suspect — a
// native prompt()/alert() blocks the ENTIRE tab's event loop (no repaint,
// no other JS) until dismissed, and is easy to genuinely miss if your
// attention was on a different window while a long background task
// finished, which is exactly Rip's own intended use ("capture whatever's
// playing" while doing something else). A tab stuck like that for long
// enough reads as "frozen," and the OS/browser eventually offering to kill
// an unresponsive tab reads as "crashed" — matching the report exactly.
// textPrompt() replaces every prompt() in the app (8 call sites, not just
// Rip's) with this non-blocking, app-styled modal instead — same
// resolve(string)/resolve(null)-on-cancel shape as prompt() itself, so
// every call site is just "await textPrompt(...)" instead of "prompt(...)".
function textPrompt(message, defaultValue = "") {
  return new Promise((resolve) => {
    const overlay = document.getElementById("text-prompt-overlay");
    const input = document.getElementById("text-prompt-input");
    document.getElementById("text-prompt-message").textContent = message;
    input.value = defaultValue;
    overlay.classList.add("show");
    input.focus();
    input.select();

    function finish(value) {
      overlay.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeydown);
      resolve(value);
    }
    const okBtn = document.getElementById("text-prompt-ok-btn");
    const cancelBtn = document.getElementById("text-prompt-cancel-btn");
    const onOk = () => finish(input.value);
    const onCancel = () => finish(null);
    const onKeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); onOk(); }
      else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeydown);
  });
}

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

// ---------------------------------------------------------------------------
// Continuous zoom (GarageBand-style) — independent of and complementary to
// BT-17's zoomWindow above. zoomWindow narrows WHAT TIME RANGE maps to
// 0%-100%; zoomMultiplier controls how many PIXELS that 0%-100% span
// actually occupies, widening #ruler-content/#markers-row-content/
// #chord-lane-content/.lane past the visible viewport so #workspace's
// existing overflow:auto scrolls horizontally. Deliberately doesn't touch
// timeToPct/pctToTime/viewWindow at all — every existing %-based position
// (playhead, loop handles, markers, beat grid, chord chips, mute regions)
// keeps working unchanged, just resolving against a wider box now. Same
// "session-only, not State.ui" reasoning as zoomWindow.
// ---------------------------------------------------------------------------
let zoomMultiplier = 1; // 1 = fit-to-viewport (today's behavior, no scrolling)
const ZOOM_MAX_MULTIPLIER = 24; // 1.5x the original 16 — same 0..1 slider, wider effective range

// Slider is 0..1, mapped exponentially — linear felt bad (all the useful
// range bunched at the low end); this gives fine control near both ends.
function zoomSliderToMultiplier(sliderValue) {
  return Math.pow(ZOOM_MAX_MULTIPLIER, clamp01(sliderValue));
}
function zoomMultiplierToSlider(multiplier) {
  return Math.log(Math.max(1, multiplier)) / Math.log(ZOOM_MAX_MULTIPLIER);
}

// Sets each zoomed row's actual pixel width from the current
// zoomMultiplier. #lanes/#ruler/#markers-row/#chord-lane themselves stay
// "fill available width" — only the -content divs and each .lane (the
// timeToPct containing blocks) get an explicit width, which is enough for
// the overflow to propagate up to #workspace's overflow:auto on its own.
function applyZoomWidth() {
  const lanesEl = document.getElementById("lanes");
  if (!lanesEl) return 0;
  // #lanes' own box stays at "natural fit width" even once its .lane
  // children are overflowing it (block children overflowing their parent
  // don't resize it) — so this stays a stable reference for "what fit-width
  // looked like," not something that creeps upward as zoom increases.
  const fitWidth = Math.max(1, lanesEl.clientWidth - 150 - 8);
  const contentWidth = Math.round(fitWidth * zoomMultiplier);

  const rulerContent = document.getElementById("ruler-content");
  const markersContent = document.getElementById("markers-row-content");
  const chordContent = document.getElementById("chord-lane-content");
  const sectionContent = document.getElementById("section-lane-content");
  if (rulerContent) rulerContent.style.width = contentWidth + "px";
  if (markersContent) markersContent.style.width = contentWidth + "px";
  if (chordContent) chordContent.style.width = contentWidth + "px";
  if (sectionContent) sectionContent.style.width = contentWidth + "px";
  // The sticky header's own box (its opaque background, not just the
  // -content children widened above) needs to grow to the same total
  // width as a .lane row — left un-widened, it stayed at the pre-zoom fit
  // width while .lane grew past it, so scrolling into the zoomed-in
  // region (horizontally, or just far enough down that a lane's own
  // border happened to sit right at the boundary) exposed lane content
  // with no opaque header covering it there at all.
  const stickyHeader = document.getElementById("sticky-timeline-header");
  if (stickyHeader) stickyHeader.style.width = (contentWidth + 150 + 8) + "px";
  document.querySelectorAll(".lane").forEach((lane) => {
    lane.style.width = (contentWidth + 150 + 8) + "px";
  });
  return contentWidth;
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
  clickVolume: 0.5, // shared by the metronome click and the count-in pre-roll — see #click-volume-slider
};

function ensureCtx() {
  if (!Audio.ctx) {
    // latencyHint 0: ask for the smallest output callback buffer the
    // hardware allows (Chrome clamps to its minimum — observed 128 frames
    // = 2.7ms @48k vs 256 = 5.3ms at the default "interactive" hint).
    // This context carries the LIVE guitar monitoring path (Play Along),
    // where every buffered millisecond is felt under the fingers; the
    // trade-off is twice the callback rate for the phase-vocoder stretch
    // nodes and the NAM worklet, which is fine on Apple Silicon and
    // guarded by NAM's own live-overrun rollback if it ever isn't.
    // sampleRate is deliberately NOT forced: the context should follow
    // the OS output device so the output side never resamples — input-
    // side rate mismatch is the user-fixable half (set the interface to
    // the same rate), and the Tone Lab latency hint surfaces the context
    // rate for exactly that check.
    Audio.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0 });
    // Re-apply the persisted output-device choice (Tone Lab's Output card
    // picker, playalong.js) as soon as the context exists, so a
    // mixer-only session honors it without ever opening Tone Lab.
    // Best-effort: if the saved device is unplugged today, setSinkId
    // rejects and the system default silently wins — the picker shows
    // what's actually available whenever Tone Lab is next opened.
    const savedSink = localStorage.getItem("gs_output_device");
    if (savedSink && Audio.ctx.setSinkId) Audio.ctx.setSinkId(savedSink).catch(() => {});
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

// Guards against overlapping loads (e.g. two quick model switches): decode
// is async, so without this the FIRST load's entries could finish last and
// silently repoint Audio.gains/buffers at the stale stem set — leaving the
// lanes' mute/solo buttons wired to gain nodes the audible graph no longer
// uses. Only the newest load is allowed to commit its results.
let stemLoadGeneration = 0;

async function loadStemBuffers(stems) {
  ensureCtx();
  stopPlayback();
  teardownStretchNodes();
  const generation = ++stemLoadGeneration;
  const entries = await Promise.all(stems.map(async (stem) => {
    const url = `/api/stem?source_path=${encodeURIComponent(State.track)}` +
      `&model=${encodeURIComponent(State.model)}&stem=${encodeURIComponent(stem.name)}`;
    const resp = await fetch(url);
    const arrBuf = await resp.arrayBuffer();
    const audioBuf = await Audio.ctx.decodeAudioData(arrBuf);
    return [stem.name, audioBuf];
  }));
  if (generation !== stemLoadGeneration) return; // superseded by a newer load
  // Fully detach the outgoing per-stem chains from the master bus — replaced
  // gain/EQ/pan nodes would otherwise stay connected (silent but alive) and
  // any code still holding one would route audio the new lanes can't control.
  for (const name in Audio.gains) {
    try { Audio.gains[name].disconnect(); } catch (e) { /* already gone */ }
    const fx = Audio.stemFx[name];
    if (fx) for (const key in fx) { try { fx[key].disconnect(); } catch (e) { /* already gone */ } }
  }
  Audio.buffers = {};
  Audio.gains = {};
  Audio.stemFx = {};
  Audio.duration = 0;
  for (const [name, buf] of entries) {
    Audio.buffers[name] = buf;
    // GP-15: a custom stem's own clip may start partway through the song
    // (State.mix.offset) — its actual end, for duration purposes, is that
    // offset plus its own length, not just its length alone.
    Audio.duration = Math.max(Audio.duration, (State.mix.offset[name] || 0) + buf.duration);
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
    // GP-15 rough edge: the time-stretch worklet loads each buffer as if
    // its own position 0 were song-time 0, so a repositioned custom stem
    // plays from the wrong place while Speed/Tune are off their defaults.
    // Not fixed here — that worklet would need its own offset/seek math
    // changed, a separate (and separately risky) piece of work.
    Audio.processedPosition = offsetSec;
    for (const name in Audio.stretchNodes) {
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "seek", positionSec: offsetSec });
      Audio.stretchNodes[name].port.postMessage({ type: "transport", action: "play" });
    }
  } else {
    stopSources();
    const startAt = Audio.ctx.currentTime + 0.05;
    for (const name in Audio.buffers) {
      // GP-15: stemStart is 0 for every ordinary stem, so this reduces to
      // exactly the old always-0 math below for all of them — only a
      // repositioned custom stem ever takes the two new branches.
      const stemStart = State.mix.offset[name] || 0;
      const buf = Audio.buffers[name];
      const src = Audio.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(Audio.gains[name]);
      if (offsetSec >= stemStart) {
        src.start(startAt, Math.max(0, Math.min(offsetSec - stemStart, buf.duration)));
      } else {
        // Playhead hasn't reached this clip's start yet — schedule it to
        // begin (from its own buffer position 0) once playback gets there.
        src.start(startAt + (stemStart - offsetSec), 0);
      }
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
  // Every caller means "playback isn't running anymore" (track switch,
  // track delete, natural end-of-song, the Stop button) — resetting the
  // icon here once covers all of them, instead of each call site having to
  // remember to do it itself (selectTrack() used to forget, leaving a
  // stale pause icon showing after switching tracks mid-playback).
  setTransportText("play-btn", "▶");
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
  if (newMode === "processed") {
    try {
      await ensureStretchNodes();
    } catch (e) {
      // A transient failure here (worklet module fetch hiccup, a single
      // AudioWorkletNode construction error) used to leave Audio.mode
      // stuck at "processed" with only a partial set of stretch nodes
      // built and playback never resumed — direct sources were already
      // stopped above, so the result was total, silent playback loss
      // recoverable only by reloading the page. Fall back to unmodified
      // direct playback instead of leaving the graph half-built, and
      // reset Speed/Tune's own UI so it doesn't keep claiming an effect
      // that silently isn't applied anymore.
      teardownStretchNodes();
      Audio.mode = "direct";
      Audio.speed = 1.0;
      Audio.pitchRatio = 1.0;
      setTransportValue("speed-slider", "1");
      setTransportValue("tune-slider", "0");
      setTransportText("speed-display", "1.00×");
      setTransportText("tune-display", "+0¢");
      updateBpmDisplay();
      updateKeyHint();
      renderChordLane();
      alert("Speed/Tune couldn't be applied (" + e.message + ") — reverted to normal playback.");
    }
  }
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

// GP-15: same idea as computePeaks, but for a stem whose buffer doesn't
// start at song-time 0 (a custom stem "patched" in partway through the
// track — see State.mix.offset/wireCustomStemOffsetDrag). Each bucket
// covers a fixed slice of the SONG's view window (not the buffer's own
// duration); a bucket falls back to silence (0) wherever it's outside
// [stemStart, stemStart + buffer.duration], which is what actually
// produces the blank space before/after the clip's waveform on screen.
// Kept as a separate function (rather than adding a stemStart param to
// computePeaks) so the hot path for every ordinary stem — the vast
// majority — is completely untouched.
function computeOffsetPeaks(buffer, buckets, viewStart, viewEnd, stemStart) {
  const key = `${buckets}:${viewStart.toFixed(3)}:${viewEnd.toFixed(3)}:${stemStart.toFixed(3)}`;
  let byWindow = _peaksCache.get(buffer);
  if (!byWindow) { byWindow = new Map(); _peaksCache.set(buffer, byWindow); }
  const cached = byWindow.get(key);
  if (cached) return cached;

  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const viewSpan = Math.max(1e-9, viewEnd - viewStart);
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    const bucketStart = viewStart + (i / buckets) * viewSpan - stemStart; // buffer-local time
    const bucketEnd = viewStart + ((i + 1) / buckets) * viewSpan - stemStart;
    if (bucketEnd <= 0 || bucketStart >= buffer.duration) continue; // stays 0 — outside the clip
    const startSample = Math.max(0, Math.floor(bucketStart * sr));
    const endSample = Math.min(data.length, Math.ceil(bucketEnd * sr));
    let max = 0;
    for (let j = startSample; j < endSample; j++) {
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
  // Canvas can't consume var() directly — resolve the themed color here so
  // waveforms follow the active theme (wireThemeToggle re-renders lanes).
  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--waveform").trim() || "#5b8cff";
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
    mix: raw.mix || { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {}, offset: {} },
    ui: raw.ui || { loop: null, loopEnabled: false },
    markers: [], // BT-08 (M4) — empty until that lands
    rigPresetChain: [], // GP-14 — no presets attached to a v1 project
    rigPresetIndex: 0,
    rigPresetCycleKeyForward: null,
    rigPresetCycleKeyBackward: null,
    bpmOverride: null, // no tempo correction recorded on a v1 project
    keyOverride: null, // no key correction recorded on a v1 project
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
        rigPresetChain: State.rigPresetChain || [],
        rigPresetIndex: State.rigPresetIndex || 0,
        rigPresetCycleKeyForward: State.rigPresetCycleKeyForward || null,
        rigPresetCycleKeyBackward: State.rigPresetCycleKeyBackward || null,
        bpmOverride: State.bpmOverride || null,
        keyOverride: State.keyOverride || null,
        guitarStemOverride: State.guitarStemOverride || null,
      },
    }).catch(() => { /* best-effort */ });
  }, 600);
}

// ---------------------------------------------------------------------------
// Track lifecycle
// ---------------------------------------------------------------------------

function showState(name) {
  for (const s of ["empty-state", "loading-state", "no-stems-state", "stems-error-state", "separating-state", "workspace"]) {
    document.getElementById(s).classList.toggle("show", s === name);
  }
  document.getElementById("transport").classList.toggle("show", name === "workspace");
  document.getElementById("toolbar-tools").classList.toggle("show", name === "workspace");
  // ui-review-v5-full.md §2.2/§4: Quest Log takes over the inspector's
  // no-track space (Speed Trainer/Export are dead controls until a track
  // exists) — swapped back the moment a track starts loading.
  const noTrack = name === "empty-state";
  document.getElementById("quest-log-panel").classList.toggle("show", noTrack);
  document.getElementById("inspector-normal-panels").classList.toggle("show", !noTrack);
  if (noTrack && typeof renderQuestLog === "function") renderQuestLog();
}

function updateModelBadge() {
  document.getElementById("model-badge-label").textContent = State.model || "—";
}

async function refreshTrackList() {
  const r = await Api.get("/api/tracks");
  State.tracks = r.tracks;
  renderTrackList();
  // Real user report: "Summon a song" never ticks on the inline Quest Log
  // (the empty-state one, not the Help-modal one). Cause: unlike every
  // other quest, "summon" isn't set via questMarkDone — questIsDone()
  // derives it live from State.tracks.length, so it only ever reflects
  // reality at the moment something re-renders the Quest Log. The Help
  // modal re-renders fresh on every open, so it always looked right; this
  // inline panel was rendered once at init and then only on a later
  // questMarkDone() call for a DIFFERENT quest — importing the very first
  // track never triggered any of those, so it sat un-ticked indefinitely.
  renderQuestLog();
}

// Library tree: "All Tracks" (every track, regardless of playlist
// membership) at top, alphabetical playlists below — replaces the old
// dropdown-driven single-playlist view (V4-F3) entirely. A track can
// belong to any number of playlists (or none) and always still shows
// under All Tracks too — playlists are extra cross-listings, not a move.
function renderTrackList() {
  const el = document.getElementById("track-list");
  el.innerHTML = "";

  el.appendChild(renderAllTracksGroup());

  const names = Object.keys(State.playlists).sort((a, b) => a.localeCompare(b));
  for (const name of names) el.appendChild(renderPlaylistGroup(name));
}

function renderAllTracksGroup() {
  const expanded = State.expandedPlaylists.has(ALL_TRACKS_GROUP_KEY);
  const group = document.createElement("div");
  group.className = "playlist-group";

  const header = document.createElement("div");
  header.className = "playlist-group-header playlist-group-header-interactive";
  header.innerHTML = `
    <button class="playlist-group-toggle" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▾" : "▸"}</button>
    <span class="playlist-group-name">All Tracks</span>
    <span class="playlist-group-count">${State.tracks.length}</span>`;
  group.appendChild(header);

  const toggleGroup = () => {
    if (State.expandedPlaylists.has(ALL_TRACKS_GROUP_KEY)) State.expandedPlaylists.delete(ALL_TRACKS_GROUP_KEY);
    else State.expandedPlaylists.add(ALL_TRACKS_GROUP_KEY);
    renderTrackList();
  };
  header.querySelector(".playlist-group-toggle").addEventListener("click", toggleGroup);
  header.querySelector(".playlist-group-name").addEventListener("click", toggleGroup);

  if (expanded) {
    if (!State.tracks.length) {
      const hint = document.createElement("p");
      hint.className = "hint playlist-group-empty-hint";
      hint.textContent = "No tracks yet — drop an audio file below to import one.";
      group.appendChild(hint);
    } else {
      for (const t of State.tracks) group.appendChild(renderLibraryTrackRow(t));
    }
  }
  return group;
}

// Display-only cleanup: the Library reads "Empty Rooms - Gary Moore", not
// "Empty Rooms - Gary Moore.mp3". Only known audio extensions are stripped
// (not any final ".xyz" — a name like "jam 2.10.24" must keep its tail),
// and only at render time: State.track, playlists, and every API call keep
// the real filename, which stays the app-wide track key.
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|opus|aiff?|wma|webm)$/i;
function displayTrackName(name) {
  return name.replace(AUDIO_EXT_RE, "");
}

function renderLibraryTrackRow(t) {
  const row = document.createElement("div");
  row.className = "track-row" + (t.name === State.track ? " selected" : "");
  row.innerHTML = `<span class="track-name">${escapeHtml(displayTrackName(t.name))}</span>`;
  row.appendChild(renderAddToPlaylistControl(t.name));
  row.appendChild(renderTrackRenameButton(t.name));
  row.appendChild(renderTrackDeleteButton(t.name));
  row.addEventListener("click", () => selectTrack(t.name));
  return row;
}

// Renaming/deleting a track's source file — same rename/delete idiom as a
// playlist's own header icons. Stems/project/practice-log are all
// content-hash-keyed (see project_path_for in server.py), so they follow a
// renamed file automatically; playlists store the literal filename though,
// so both handlers patch every playlist that references the old name
// before persisting.
function renamePlaylistReferences(oldName, newName) {
  for (const playlist of Object.values(State.playlists)) {
    playlist.tracks = playlist.tracks.map((n) => (n === oldName ? newName : n));
  }
}

function removePlaylistReferences(name) {
  for (const playlist of Object.values(State.playlists)) {
    playlist.tracks = playlist.tracks.filter((n) => n !== name);
  }
}

function renderTrackRenameButton(trackName) {
  const btn = document.createElement("button");
  btn.className = "track-rename-btn";
  btn.title = "Rename track";
  btn.textContent = "✎";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const base = trackName.replace(/\.[^.]+$/, "");
    const newName = await textPrompt("Rename track to:", base);
    if (!newName || !newName.trim() || newName.trim() === base) return;
    try {
      const r = await Api.post("/api/track/rename", { track: trackName, new_name: newName.trim() });
      renamePlaylistReferences(trackName, r.name);
      if (State.track === trackName) State.track = r.name;
      await persistPlaylists();
      await refreshTrackList();
    } catch (err) {
      alert(`Rename failed: ${err.message || err}`);
    }
  });
  return btn;
}

function renderTrackDeleteButton(trackName) {
  const btn = document.createElement("button");
  btn.className = "track-delete-btn";
  btn.title = "Delete track";
  btn.textContent = "✕";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${trackName}"? This removes the audio file plus its separated stems, exported mixes, and recordings. This can't be undone.`)) return;
    try {
      await Api.post("/api/track/delete", { track: trackName });
      removePlaylistReferences(trackName);
      if (State.track === trackName) {
        stopPlayback();
        State.track = null;
        showState("empty-state");
      }
      await persistPlaylists();
      await refreshTrackList();
    } catch (err) {
      alert(`Delete failed: ${err.message || err}`);
    }
  });
  return btn;
}

// A track's own "+" — the only way (besides dragging none exists) to put a
// track into a playlist now that there's no dropdown-selected "current"
// playlist to add into. Checkboxes rather than a single-pick list since a
// track can be in more than one playlist at once.
let openAddToPlaylistFor = null; // which track's popover renderTrackList() should reopen after a re-render — cleared on a checkbox change so picking a playlist closes it

function renderAddToPlaylistControl(trackName) {
  const wrap = document.createElement("details");
  wrap.className = "track-add-to-playlist";
  if (openAddToPlaylistFor === trackName) wrap.open = true;
  wrap.addEventListener("click", (e) => e.stopPropagation()); // don't let this bubble into the row's selectTrack
  wrap.addEventListener("toggle", () => { openAddToPlaylistFor = wrap.open ? trackName : null; });

  const summary = document.createElement("summary");
  summary.title = "Add to playlist";
  summary.textContent = "+";
  wrap.appendChild(summary);

  const menu = document.createElement("div");
  menu.className = "track-add-to-playlist-menu";
  const names = Object.keys(State.playlists).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    menu.innerHTML = '<p class="hint">No playlists yet.</p>';
  } else {
    for (const name of names) {
      const label = document.createElement("label");
      const checked = State.playlists[name].tracks.includes(trackName);
      label.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}> ${escapeHtml(name)}`;
      label.querySelector("input").addEventListener("change", async (e) => {
        const playlist = State.playlists[name];
        if (e.target.checked) {
          if (!playlist.tracks.includes(trackName)) playlist.tracks.push(trackName);
        } else {
          playlist.tracks = playlist.tracks.filter((n) => n !== trackName);
        }
        openAddToPlaylistFor = null; // a selection is a "done" signal — close the popover instead of leaving it open across the re-render
        await persistPlaylists();
        renderTrackList();
      });
      menu.appendChild(label);
    }
  }
  const newBtn = document.createElement("button");
  newBtn.className = "track-add-to-playlist-new-btn";
  newBtn.textContent = "+ New playlist…";
  newBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const name = await textPrompt("New playlist name:");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (State.playlists[trimmed]) { alert(`A playlist named "${trimmed}" already exists.`); return; }
    State.playlists[trimmed] = { tracks: [trackName] };
    State.expandedPlaylists.add(trimmed);
    openAddToPlaylistFor = null; // same "a selection is a done signal" close as picking an existing playlist above
    await persistPlaylists();
    renderTrackList();
  });
  menu.appendChild(newBtn);
  wrap.appendChild(menu);
  return wrap;
}

// V4-F4: honest numbers, not gamified — a plain elapsed-time readout and a
// last-practiced date, nothing scored or streak-tracked.
function fmtPracticeTime(seconds) {
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// V4-F4: practice log — a dumb periodic sampler, not hooked into every
// playback-state transition. Every PRACTICE_TICK_MS it just asks "is the
// backing track actually playing right now," and if so credits that
// interval to whatever song is loaded. Seeks, speed changes, loop wraps,
// and Play Along vs. Mixer playback all fall out for free since none of
// them change what Audio.playing means. Increments are flushed to the
// server periodically (not on every tick) and whenever the loaded track
// changes (selectTrack calls flushPracticeLog before switching State.track)
// — a crash or closed tab loses at most a few unflushed seconds, never a
// whole session.
// ---------------------------------------------------------------------------

const PRACTICE_TICK_MS = 5000;
const PRACTICE_FLUSH_THRESHOLD_SEC = 15;
let practiceLogPendingSeconds = 0;
let practiceLogAccumTrack = null;
// Which track's flush most recently reached the server — lets flushPracticeLog
// tell the server whether THIS flush is still "the same song played over
// again" (nothing else was ever flushed in between) or a genuine return after
// actually practicing something else. Pausing playback on the same song for
// a while (no flush happens while paused — see the early return below) and
// then resuming still counts as continuous, even though real time passed,
// since the player never left this song for another one in between.
let practiceLogLastFlushedTrack = null;

function practiceLogTick() {
  if (!Audio.playing || !State.track) return;
  if (practiceLogAccumTrack && practiceLogAccumTrack !== State.track) flushPracticeLog();
  practiceLogAccumTrack = State.track;
  practiceLogPendingSeconds += PRACTICE_TICK_MS / 1000;
  if (practiceLogPendingSeconds >= PRACTICE_FLUSH_THRESHOLD_SEC) flushPracticeLog();
}

function flushPracticeLog() {
  if (practiceLogPendingSeconds <= 0 || !practiceLogAccumTrack) {
    practiceLogPendingSeconds = 0;
    practiceLogAccumTrack = null;
    return;
  }
  const track = practiceLogAccumTrack;
  const seconds = practiceLogPendingSeconds;
  const continuous = practiceLogLastFlushedTrack === null || practiceLogLastFlushedTrack === track;
  practiceLogPendingSeconds = 0;
  practiceLogAccumTrack = null;
  Api.post("/api/practice_log", { track, seconds, continuous }).then((r) => {
    practiceLogLastFlushedTrack = track;
    questMarkDone("arena");
    const t = State.tracks.find((x) => x.name === track);
    if (t) {
      t.practice_seconds = r.seconds;
      t.last_practiced = r.last_practiced;
      renderTrackList();
    }
    if (track === State.track) refreshPracticeSessionLog(); // Play Along's log stays live during play, not just on next open
  }).catch(() => { /* best-effort — a lost tick just under-counts slightly */ });
}

// Play Along's Practice Log card (below Record/Takes): cumulative total +
// weighted score up top, session-by-session rows underneath (rated, noted,
// deletable) — see svc_practice_sessions in server.py for how flush
// increments get stitched into sessions.
const PRACTICE_RATINGS = ["crap", "bad", "ok", "good", "awesome"];
const PRACTICE_RATING_EMOJI = { crap: "😖", bad: "😕", ok: "😐", good: "🙂", awesome: "🤩" };
const PRACTICE_RATING_LABEL = { crap: "Crap", bad: "Bad", ok: "OK", good: "Good", awesome: "Awesome" };
const PRACTICE_RATING_VALUE = { crap: 0, bad: 2.5, ok: 5, good: 7.5, awesome: 10 };

// 10 = totally god-like awesome, 0 = novice ukulele player — weighted
// toward recent form: only the most recent 5 RATED sessions count at all,
// so a strong current run always fully overrides however the earliest
// sessions went (10 stays reachable no matter how practice started out).
// Unrated sessions are skipped rather than treated as a zero, so just not
// bothering to rate a session never drags the score down.
function computePracticeScore(sessions) {
  const rated = sessions.filter((s) => s.rating).slice(0, 5);
  if (!rated.length) return null;
  return rated.reduce((sum, s) => sum + PRACTICE_RATING_VALUE[s.rating], 0) / rated.length;
}

async function refreshPracticeSessionLog() {
  const track = State.track;
  const summaryEl = document.getElementById("practice-log-summary");
  const scoreEl = document.getElementById("practice-log-score");
  const listEl = document.getElementById("practice-log-sessions");
  if (!summaryEl || !listEl) return; // guard, same spirit as the refreshTakesList typeof-checks elsewhere
  if (!track) {
    summaryEl.textContent = "";
    scoreEl.textContent = "";
    listEl.innerHTML = "";
    return;
  }
  let r;
  try {
    r = await Api.get(`/api/practice_sessions?track=${encodeURIComponent(track)}`);
  } catch (e) {
    return; // best-effort — a failed refresh just leaves the last-known log showing
  }
  if (track !== State.track) return; // a track switch raced this fetch

  summaryEl.textContent = r.seconds > 0
    ? `${fmtPracticeTime(r.seconds)} practiced total — last practiced ${r.last_practiced ? new Date(r.last_practiced * 1000).toLocaleDateString() : "never"}`
    : "No practice time logged for this track yet.";

  const score = computePracticeScore(r.sessions);
  scoreEl.textContent = score === null
    ? "Rate a session below to start tracking a practice score."
    : `Practice score: ${score.toFixed(1)} / 10 (weighted toward your last ${Math.min(5, r.sessions.filter((s) => s.rating).length)} rated sessions)`;

  listEl.innerHTML = "";
  if (!r.sessions.length) return;
  const frag = document.createDocumentFragment();
  for (const s of r.sessions) frag.appendChild(renderPracticeSessionRow(track, s));
  listEl.appendChild(frag);
}

function renderPracticeSessionRow(track, s) {
  const start = new Date(s.start * 1000);
  const row = document.createElement("div");
  row.className = "practice-session-row";
  row.innerHTML = `
    <span class="practice-session-date">${escapeHtml(start.toLocaleDateString())}</span>
    <span class="practice-session-time">${escapeHtml(start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</span>
    <span class="practice-session-duration">${escapeHtml(fmtPracticeTime(s.seconds))}</span>
    <div class="practice-session-rating">
      ${PRACTICE_RATINGS.map((r) => `<button class="practice-rating-btn${s.rating === r ? " active" : ""}" data-rating="${r}" title="${PRACTICE_RATING_LABEL[r]}">${PRACTICE_RATING_EMOJI[r]}</button>`).join("")}
    </div>
    <input type="text" class="practice-session-notes" maxlength="60" placeholder="Notes…" value="${escapeHtml(s.notes || "")}">
    <button class="practice-session-delete-btn" title="Delete this session">✕</button>`;

  row.querySelectorAll(".practice-rating-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const rating = btn.dataset.rating;
      try {
        await Api.post("/api/practice_session/update", { track, id: s.id, rating });
        // Full refresh (cheap — one fetch) rather than patching this row in
        // place: the weighted score above depends on every session's
        // rating, not just this one, so it needs recomputing regardless.
        await refreshPracticeSessionLog();
      } catch (err) { alert(`Couldn't save rating: ${err.message || err}`); }
    });
  });

  const notesInput = row.querySelector(".practice-session-notes");
  notesInput.addEventListener("change", async () => {
    try {
      await Api.post("/api/practice_session/update", { track, id: s.id, notes: notesInput.value });
      s.notes = notesInput.value;
    } catch (err) {
      alert(`Couldn't save note: ${err.message || err}`);
      notesInput.value = s.notes || "";
    }
  });

  row.querySelector(".practice-session-delete-btn").addEventListener("click", async () => {
    if (!confirm("Delete this practice session? This can't be undone.")) return;
    try {
      await Api.post("/api/practice_session/delete", { track, id: s.id });
      await refreshPracticeSessionLog();
    } catch (err) { alert(`Couldn't delete session: ${err.message || err}`); }
  });

  return row;
}

function fmtFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Play Along's Exported Tracks card (below Practice Log): real Export-panel
// bounces for the loaded song, playable right here — no need to re-stem or
// go back to the Mixer just to hear a finished mix. svc_exported_tracks
// (server.py) already filters out the stem copies/recordings/ subfolder
// that also live under output/<track>/.
async function refreshExportedTracksList() {
  const track = State.track;
  const hintEl = document.getElementById("exported-tracks-hint");
  const listEl = document.getElementById("exported-tracks-list");
  const player = document.getElementById("exported-track-player");
  if (!hintEl || !listEl) return;
  player.pause();
  player.style.display = "none";
  player.removeAttribute("src");
  if (!track) {
    hintEl.textContent = "";
    listEl.innerHTML = "";
    return;
  }
  let r;
  try {
    r = await Api.get(`/api/exported_tracks?track=${encodeURIComponent(track)}`);
  } catch (e) {
    return; // best-effort — a failed refresh just leaves the last-known list showing
  }
  if (track !== State.track) return; // a track switch raced this fetch

  hintEl.textContent = r.tracks.length
    ? "Exported mixes for this song — play them here without re-stemming or leaving Play Along."
    : "No exports yet for this song — use Export on the Mixer screen.";

  listEl.innerHTML = "";
  if (!r.tracks.length) return;
  const frag = document.createDocumentFragment();
  for (const t of r.tracks) {
    const row = document.createElement("div");
    row.className = "exported-track-row";
    row.innerHTML = `
      <span class="exported-track-name">${escapeHtml(t.name)}</span>
      <span class="exported-track-meta">${escapeHtml(fmtFileSize(t.size))} · ${escapeHtml(new Date(t.modified * 1000).toLocaleDateString())}</span>
      <button class="exported-track-play-btn">▶ Play</button>
      <button class="exported-track-reveal-btn">Reveal</button>`;
    row.querySelector(".exported-track-play-btn").addEventListener("click", () => {
      player.src = `/api/output?path=${encodeURIComponent(t.path)}`;
      player.style.display = "block";
      player.play();
    });
    row.querySelector(".exported-track-reveal-btn").addEventListener("click", () => {
      Api.post("/api/reveal", { path: t.path }).catch(() => {});
    });
    frag.appendChild(row);
  }
  listEl.appendChild(frag);
}

// A playlist's own group within the Library tree — header (expand toggle,
// name, count, rename/delete) plus, when expanded, its tracks in playlist
// order (not alphabetical) with the same reorder/remove controls the old
// dropdown-selected playlist view had.
function renderPlaylistGroup(name) {
  const playlist = State.playlists[name];
  const tracks = playlist.tracks;
  const expanded = State.expandedPlaylists.has(name);

  const group = document.createElement("div");
  group.className = "playlist-group";

  // Header controls kept deliberately minimal (⟳ auto-play, rename,
  // delete) — the ◀/+/▶ stepping/add-current cluster that used to live
  // here read as too busy per real user feedback; songs are added from a
  // track row's own + popover, and stepping through a set is what ⟳
  // auto-play and plain clicking already cover.
  const header = document.createElement("div");
  header.className = "playlist-group-header playlist-group-header-interactive";
  header.innerHTML = `
    <button class="playlist-group-toggle" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▾" : "▸"}</button>
    <span class="playlist-group-name">${escapeHtml(name)}</span>
    <span class="playlist-group-count">${tracks.length}</span>
    <button class="playlist-group-autoplay-btn${State.autoPlaylist === name ? " on" : ""}" title="Auto-play: when a song from this playlist ends, load and play the next one"${tracks.length ? "" : " disabled"}>⟳</button>
    <button class="playlist-group-rename-btn" title="Rename playlist">✎</button>
    <button class="playlist-group-delete-btn" title="Delete playlist">✕</button>`;
  group.appendChild(header);

  const toggleGroup = () => {
    if (State.expandedPlaylists.has(name)) State.expandedPlaylists.delete(name);
    else State.expandedPlaylists.add(name);
    renderTrackList();
  };
  header.querySelector(".playlist-group-toggle").addEventListener("click", toggleGroup);
  header.querySelector(".playlist-group-name").addEventListener("click", toggleGroup);

  header.querySelector(".playlist-group-autoplay-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setAutoPlaylist(State.autoPlaylist === name ? null : name);
  });

  header.querySelector(".playlist-group-rename-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const newName = await textPrompt("Rename playlist to:", name);
    if (!newName || !newName.trim() || newName.trim() === name) return;
    const trimmed = newName.trim();
    if (State.playlists[trimmed]) { alert(`A playlist named "${trimmed}" already exists.`); return; }
    State.playlists[trimmed] = State.playlists[name];
    delete State.playlists[name];
    if (State.expandedPlaylists.has(name)) { State.expandedPlaylists.delete(name); State.expandedPlaylists.add(trimmed); }
    await persistPlaylists();
    renderTrackList();
  });

  header.querySelector(".playlist-group-delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete playlist "${name}"? This can't be undone (the songs themselves are untouched).`)) return;
    delete State.playlists[name];
    State.expandedPlaylists.delete(name);
    await persistPlaylists();
    renderTrackList();
  });

  if (expanded) {
    if (!tracks.length) {
      const hint = document.createElement("p");
      hint.className = "hint playlist-group-empty-hint";
      hint.textContent = 'Empty — use "+" on a track above to add it here.';
      group.appendChild(hint);
    } else {
      tracks.forEach((trackName, i) => group.appendChild(renderPlaylistMemberRow(name, trackName, i, tracks.length)));
    }
  }
  return group;
}

// Auto-play (⟳ in a playlist's header): when a song from the armed
// playlist ends naturally, load the playlist's next song and start it as
// soon as its stems land — a setlist that plays itself. One playlist armed
// at a time (arming another disarms the first), remembered across reloads.
// Same no-wrap rule as the ◀/▶ steppers: after the last song, playback
// stops for real instead of looping the set.
const AUTOPLAY_PLAYLIST_KEY = "gs_autoplay_playlist";

// The exact track auto-advance just selected, not a bare boolean: the next
// song may turn out to need separation first (onStemsLoaded never runs),
// and a stale "start playing on next load" flag firing on a track the user
// picked by hand minutes later would be a real surprise.
let autoPlayPendingTrack = null;

function setAutoPlaylist(name) {
  State.autoPlaylist = name;
  if (name) localStorage.setItem(AUTOPLAY_PLAYLIST_KEY, name);
  else localStorage.removeItem(AUTOPLAY_PLAYLIST_KEY);
  renderTrackList();
}

function maybeAutoAdvance() {
  const playlist = State.autoPlaylist && State.playlists[State.autoPlaylist];
  if (!playlist) return;
  const i = playlist.tracks.indexOf(State.track);
  if (i === -1 || i + 1 >= playlist.tracks.length) return;
  autoPlayPendingTrack = playlist.tracks[i + 1];
  selectTrack(autoPlayPendingTrack);
}

function renderPlaylistMemberRow(playlistName, trackName, index, total) {
  const row = document.createElement("div");
  row.className = "track-row playlist-track-row" + (trackName === State.track ? " selected" : "");
  row.innerHTML = `
    <span class="track-name">${escapeHtml(displayTrackName(trackName))}</span>
    <button class="playlist-track-up-btn" title="Move up"${index === 0 ? " disabled" : ""}>▲</button>
    <button class="playlist-track-down-btn" title="Move down"${index === total - 1 ? " disabled" : ""}>▼</button>
    <button class="playlist-track-remove-btn" title="Remove from playlist">✕</button>`;
  row.appendChild(renderAddToPlaylistControl(trackName));
  row.addEventListener("click", () => selectTrack(trackName));
  row.querySelector(".playlist-track-up-btn").addEventListener("click", (e) => {
    e.stopPropagation(); movePlaylistTrack(playlistName, index, -1);
  });
  row.querySelector(".playlist-track-down-btn").addEventListener("click", (e) => {
    e.stopPropagation(); movePlaylistTrack(playlistName, index, 1);
  });
  row.querySelector(".playlist-track-remove-btn").addEventListener("click", (e) => {
    e.stopPropagation(); removePlaylistTrack(playlistName, index);
  });
  return row;
}

async function persistPlaylists() {
  await Api.post("/api/playlists", { playlists: State.playlists }).catch(() => { /* best-effort */ });
}

function movePlaylistTrack(playlistName, index, delta) {
  const playlist = State.playlists[playlistName];
  if (!playlist) return;
  const tracks = playlist.tracks;
  const j = index + delta;
  if (j < 0 || j >= tracks.length) return;
  [tracks[index], tracks[j]] = [tracks[j], tracks[index]];
  renderTrackList();
  persistPlaylists();
}

function removePlaylistTrack(playlistName, index) {
  const playlist = State.playlists[playlistName];
  if (!playlist) return;
  playlist.tracks.splice(index, 1);
  renderTrackList();
  persistPlaylists();
}

async function refreshPlaylists() {
  try {
    const r = await Api.get("/api/playlists");
    State.playlists = r.playlists || {};
  } catch (e) {
    State.playlists = {};
  }
}

let selectTrackEpoch = 0;

async function selectTrack(name) {
  // A manual selection cancels any queued auto-play start (⟳): the flag
  // may be left over from an auto-advance onto a not-yet-separated song,
  // and firing it on a track the user picked by hand later would surprise.
  if (name !== autoPlayPendingTrack) autoPlayPendingTrack = null;

  // V4-F4: flush whatever practice time accumulated against the track
  // we're about to leave, before State.track points somewhere else.
  flushPracticeLog();

  // Reentrancy guard: selectTrack awaits (setSpeedTune, /api/project,
  // stem load), and two quick library clicks would otherwise interleave —
  // the first click's continuation resuming after the second set State,
  // clobbering State.model/State.mix and then loading stems for a
  // mismatched track/model pair. Each call claims an epoch; a stale call
  // bails at the next checkpoint instead of writing over the newer one.
  const epoch = ++selectTrackEpoch;

  // Picking a track from the library is a clear intent to work on the
  // mixer — if Tone Lab or Play Along is open over it, close whichever one
  // rather than leaving the newly-selected track loaded silently behind
  // the overlay.
  if (typeof closeAllScreens === "function") closeAllScreens();

  State.track = name;
  renderTrackList();
  stopPlayback();
  zoomWindow = null; // BT-17 — same reasoning as Speed/Tune resetting below: a leftover zoom from the last song would be a trap
  document.getElementById("zoom-to-loop-btn").style.display = "inline-block";
  document.getElementById("zoom-out-btn").style.display = "none";
  resetTimelineZoom(); // continuous zoom — same "leftover from last song is a trap" reasoning
  // A leftover vertical scroll position (e.g. scrolled down to stem 6 of
  // the last song) is the same kind of trap resetTimelineZoom already
  // guards against for horizontal scroll — reset explicitly here, once,
  // on track switch; renderLanes() itself now preserves whatever this is
  // set to across a same-track re-render (mute/solo/etc.), which is the
  // scroll-jump bug this line is paired with fixing.
  const workspaceEl = document.getElementById("workspace");
  if (workspaceEl) workspaceEl.scrollTop = 0;
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
  State.mix = (project && project.mix) || { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {}, offset: {} };
  // BT-11/GP-15: eq/pan/offset are additive to project.mix, not a version
  // bump — a v2 project saved before they existed still has a mix object,
  // just without these keys, so backfill rather than assume they're always
  // present.
  State.mix.eq = State.mix.eq || {};
  State.mix.pan = State.mix.pan || {};
  State.mix.offset = State.mix.offset || {};
  State.ui = (project && project.ui) || { loop: null, loopEnabled: false };
  State.markers = (project && project.markers) || [];
  // GP-14: the ordered chain of rig presets attached to this song — applied
  // once Play Along/Tone Lab is next opened for it (paApplyAttachedRigPreset
  // in playalong.js), not here, since the PA audio graph doesn't exist until
  // ensurePAGraph runs. Backfill: a project saved before GP-14 (or offline
  // during the transition) has the old single rigPreset string instead of
  // rigPresetChain — synthesize a one-item chain from it so nothing about an
  // existing song's attached preset is lost.
  State.rigPresetChain = (project && project.rigPresetChain) ||
    (project && project.rigPreset ? [project.rigPreset] : []);
  State.rigPresetIndex = (project && project.rigPresetIndex) || 0;
  // Deliberately NOT backfilled from the old single-key rigPresetCycleKey
  // field (a design that existed only briefly before the forward/backward
  // split, same v4.7 release) — the whole point of that split was "right
  // arrow forward, left arrow backward" as the new DEFAULT, and carrying
  // an old single-key value over as the forward key would silently
  // override that default with whatever got set (even accidentally,
  // during testing) under the old single-key UI.
  State.rigPresetCycleKeyForward = (project && project.rigPresetCycleKeyForward) || null;
  State.rigPresetCycleKeyBackward = (project && project.rigPresetCycleKeyBackward) || null;
  State.rigPresetApplied = false;
  State.looperLoaded = false; // GP-06 — same "run once per track, not once per Play Along open" guard as rigPresetApplied above
  State.bpmOverride = (project && project.bpmOverride) || null;
  State.keyOverride = (project && project.keyOverride) || null;
  // GP-16: which stem (by name) stands in for "the guitar" on an imported
  // stem pack, where a real model-produced "guitar" stem never exists —
  // see resolvedGuitarStemName()'s own comment for what this unlocks.
  State.guitarStemOverride = (project && project.guitarStemOverride) || null;
  toggleTransportClass("loop-toggle-btn", "active", State.ui.loopEnabled);
  updateModelBadge();
  if (typeof refreshTakesList === "function") refreshTakesList(); // recorder.js — takes are per-track
  refreshPracticeSessionLog(); // per-track, same as takes above
  refreshExportedTracksList(); // per-track, same as takes above

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
      // Api.get already retries a bare network failure a few times (see
      // its own comment) — reaching here means either a real HTTP error
      // (e.status set) or every retry was exhausted. A blocking alert()
      // used to run here instead: real user report was that on the rare
      // case this still fires (usually the very first track picked right
      // after starting the app), no "loading" spinner was ever visible —
      // alert() is synchronous and steals the next paint, so the
      // loading-state's own render never got a chance to show before the
      // dialog appeared. This state is a normal (non-blocking) part of
      // #canvas instead, with its own Retry button, same idiom as
      // no-stems-state above.
      document.getElementById("stems-error-hint").textContent =
        "Couldn't load this track's stems: " + e.message;
      showState("stems-error-state");
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
  if (result.stems && result.stems.length) questMarkDone("forge");
  // Octave errors (detecting half or double the real tempo) are a known,
  // essentially unfixable-in-general failure mode of automatic tempo
  // estimation — the ×2/½ buttons next to the BPM readout are the escape
  // hatch. State.bpmOverride is loaded from the project in selectTrack();
  // apply it now that a fresh State.analysis (with the raw detected value)
  // has just landed on top of it.
  if (State.bpmOverride && State.analysis.bpm) State.analysis.bpm = State.bpmOverride;
  // BT-02: the click has nothing to play without a beat grid — disable the
  // toggle and say why, rather than letting it sit there silently inert.
  const clickBtn = document.getElementById("click-toggle");
  const hasBeats = !!(State.analysis.beats && State.analysis.beats.length);
  clickBtn.disabled = !hasBeats;
  if (!hasBeats) clickBtn.classList.remove("active");
  clickBtn.title = hasBeats
    ? "Metronome click synced to this track's detected beat grid"
    : "No beat grid detected for this track — beat analysis may still be pending or may have failed";
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
  if (autoPlayPendingTrack === State.track) {
    autoPlayPendingTrack = null;
    if (Audio.ctx && Audio.ctx.state === "suspended") Audio.ctx.resume();
    startPlaybackAt(0);
    setTransportText("play-btn", "⏸");
  }
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
  updateTimelineSliderRange(); // Audio.duration is settled by the time renderLanes() runs
  const container = document.getElementById("lanes");
  // Real user report: clicking Mute/Solo (or anything else that calls
  // renderLanes on the SAME track) reset the scroll position back to the
  // top, even with several stems scrolled out of view below the fold.
  // Cause: #workspace is the actual scrolling element, and wiping #lanes'
  // children to rebuild them below briefly collapses its scrollHeight
  // (nothing left inside it) — the browser clamps #workspace.scrollTop
  // down right then, and it doesn't spring back up once the lanes are
  // re-appended, since nothing here was asking it to. Capturing/restoring
  // across the wipe fixes that; a genuine track switch resets scrollTop
  // to 0 explicitly in selectTrack() before this ever runs, so a fresh
  // track still opens scrolled to the top, not wherever the last one
  // happened to be scrolled to.
  const workspaceEl = document.getElementById("workspace");
  const savedScrollTop = workspaceEl ? workspaceEl.scrollTop : 0;
  const savedScrollLeft = workspaceEl ? workspaceEl.scrollLeft : 0;
  container.innerHTML = "";
  const playheads = [];

  // Continuous zoom: #lanes' own box width doesn't depend on its children
  // (block layout — overflowing .lane rows don't resize their parent), so
  // this is safe to read before rebuilding them below. Roughly one peak
  // bucket per rendered pixel so zooming in actually shows more waveform
  // detail instead of the same fixed bar count stretched blocky — same
  // reasoning BT-17 already established for the narrowed-viewWindow case,
  // just driven by pixel width here instead of a narrower time range.
  const fitWidth = Math.max(1, container.clientWidth - 150 - 8);
  const bucketCount = Math.min(4000, Math.max(400, Math.round(fitWidth * zoomMultiplier)));

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
      <div class="lane-name">${escapeHtml(stemDisplayName(name, stem.label))}
        ${stem.is_derived ? '<span class="lane-derived-badge">derived</span>' : ""}
        ${stem.is_custom ? '<span class="lane-custom-badge" title="Added by you — not produced by the separation model">custom</span>' : ""}
        <button class="lane-rename-btn" title="Rename this stem (display name only — doesn't touch its saved mix)">✎</button>
        ${stem.is_custom ? '<button class="lane-delete-btn" title="Remove this custom stem">✕</button>' : ""}
        ${State.model === "imported" && name !== "guitar" ? `<button class="lane-guitar-btn${State.guitarStemOverride === name ? " on" : ""}" title="${State.guitarStemOverride === name ? "This is the guitar stem for Suggest a Tone / Rate My Take — click to unset" : "Mark this as the guitar stem, so Suggest a Tone / Rate My Take treat it like a real separated guitar stem"}">🎸</button>` : ""}</div>
      <div class="lane-buttons">
        <button class="mute-btn ${State.mix.muted[name] ? "on" : ""}">M</button>
        <button class="solo-btn ${State.mix.solo === name ? "on" : ""}">S</button>
      </div>
      <div class="lane-fader">
        <input type="range" class="lane-gain-input" min="0" max="${isSplitCandidate(name) ? 3.0 : 1.5}" step="0.01" value="${State.mix.gains[name] ?? 1.0}">
        <span class="lane-gain-val" style="cursor:pointer" title="Double-click to reset to 100%">${Math.round((State.mix.gains[name] ?? 1.0) * 100)}%</span>
      </div>
      <div class="lane-pan-row">
        <input type="range" class="lane-pan-input" min="-1" max="1" step="0.01" value="${pan}">
        <span class="lane-pan-val" style="cursor:pointer" title="Double-click to reset to center">${panLabel(pan)}</span>
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

    header.querySelector(".lane-rename-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const current = stemDisplayName(name, stem.label);
      const newLabel = await textPrompt("Rename this stem to:", current);
      if (!newLabel || !newLabel.trim() || newLabel.trim() === current) return;
      try {
        const r = await Api.post("/api/stem/rename", {
          source_path: State.track, model: State.model, stem: name, new_label: newLabel.trim(),
        });
        stem.label = r.label; // update in place — no need to re-fetch/re-decode audio just for a label
        renderLanes();
      } catch (err) {
        alert(`Rename failed: ${err.message || err}`);
      }
    });
    const guitarBtn = header.querySelector(".lane-guitar-btn");
    if (guitarBtn) {
      guitarBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        State.guitarStemOverride = (State.guitarStemOverride === name) ? null : name;
        saveProjectDebounced();
        renderLanes();
      });
    }
    if (stem.is_custom) {
      header.querySelector(".lane-delete-btn").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove the custom stem "${stemDisplayName(name, stem.label)}"? This can't be undone.`)) return;
        try {
          await Api.post("/api/custom_stem/remove", { source_path: State.track, stem: name });
          await refreshStemsForCurrentModelAndTrack();
        } catch (err) {
          alert(`Could not remove stem: ${err.message || err}`);
        }
      });
    }
    header.querySelector(".mute-btn").addEventListener("click", () => toggleMute(name));
    header.querySelector(".solo-btn").addEventListener("click", () => toggleSolo(name));
    const fader = header.querySelector(".lane-gain-input");
    fader.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      setGain(name, v);
      header.querySelector(".lane-gain-val").textContent = Math.round(v * 100) + "%";
    });
    header.querySelector(".lane-gain-val").addEventListener("dblclick", () => {
      fader.value = "1";
      fader.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // BT-11: pan + 3-band EQ per stem.
    const panInput = header.querySelector(".lane-pan-input");
    panInput.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      setPan(name, v);
      header.querySelector(".lane-pan-val").textContent = panLabel(v);
    });
    header.querySelector(".lane-pan-val").addEventListener("dblclick", () => {
      panInput.value = "0";
      panInput.dispatchEvent(new Event("input", { bubbles: true }));
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

    // GP-15: a custom stem's waveform can be dragged left/right to
    // reposition it in the song — that gesture lives on the same canvas a
    // normal stem uses for click-to-seek, distinguished by drag distance
    // (wireCustomStemOffsetDrag falls back to a plain seek on a real
    // click). Ordinary stems are unaffected — click-to-seek exactly as
    // before.
    if (stem.is_custom) {
      canvas.classList.add("lane-canvas-offsettable");
      wireCustomStemOffsetDrag(canvas, name, bucketCount);
    } else {
      canvas.addEventListener("click", (e) => seekFromElement(canvas, e));
    }

    const buf = Audio.buffers[name];
    if (buf) {
      // BT-17: waveform zoom — slicing peaks to the current view window
      // (instead of always the whole buffer) is what makes zooming in
      // actually show more DETAIL rather than the same fixed bucket count
      // stretched; bucketCount (computed above) is the continuous-zoom
      // half of that same idea.
      const { start, end } = viewWindow();
      const peaks = stem.is_custom
        ? computeOffsetPeaks(buf, bucketCount, start, end, State.mix.offset[name] || 0)
        : computePeaks(buf, bucketCount, start, end);
      requestAnimationFrame(() => drawWaveform(canvas, peaks));
    }
  }

  // V3-E5: renderPlayhead() reads this instead of re-querying the DOM every
  // animation frame. Force a re-render next tick — the lane DOM (and thus
  // which elements .style.left needs to hit) just changed, but the actual
  // playhead position may not have, which would otherwise skip it.
  cachedPlayheadEls = playheads;
  lastPlayheadPct = null;
  applyZoomWidth(); // sets each new .lane's width now that they actually exist in the DOM
  if (workspaceEl) {
    workspaceEl.scrollTop = savedScrollTop;
    workspaceEl.scrollLeft = savedScrollLeft;
  }
}

function toggleMute(name) {
  State.mix.muted[name] = !State.mix.muted[name];
  applyMixToGains();
  renderLanes();
  saveProjectDebounced();
  if (State.mix.muted[name]) questMarkDone("carve");
}

function toggleSolo(name) {
  const turningOn = State.mix.solo !== name;
  State.mix.solo = turningOn ? name : null;
  // Soloing a muted stem used to still play silence — applyMixToGains'
  // solo check only zeroes every OTHER stem, it never un-zeroed this one
  // if its own mute flag had already done that first. A real user report:
  // "hitting solo on a muted stem should unmute it so it can be heard
  // solo" — the whole point of solo is to hear this one stem, so clear
  // its mute the moment you solo it, same as a real mixing console fader
  // strip's Mute/Solo interaction.
  if (turningOn && State.mix.muted[name]) State.mix.muted[name] = false;
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

// GP-15: drag a custom stem's waveform left/right to "patch" it into a
// different spot in the song — e.g. dropping in a re-recorded solo and
// sliding it to line up with the rest of the track. Lives on the same
// canvas ordinary stems use for click-to-seek; a small movement threshold
// tells a real drag apart from a plain click (mirrors wireMuteLane's own
// click-vs-drag distinction below), so clicking a custom stem's waveform
// without dragging still seeks like any other lane.
function wireCustomStemOffsetDrag(canvas, name, bucketCount) {
  let dragStartClientX = null;
  let dragStartOffset = 0;
  let moved = false;

  canvas.addEventListener("mousedown", (e) => {
    dragStartClientX = e.clientX;
    dragStartOffset = State.mix.offset[name] || 0;
    moved = false;
  });
  canvas.addEventListener("mousemove", (e) => {
    if (dragStartClientX == null) return;
    if (Math.abs(e.clientX - dragStartClientX) > 3) moved = true;
    if (!moved) return;
    const { start, end } = viewWindow();
    const rect = canvas.getBoundingClientRect();
    const secPerPx = (end - start) / rect.width;
    const newOffset = Math.max(0, dragStartOffset + (e.clientX - dragStartClientX) * secPerPx);
    State.mix.offset[name] = newOffset;
    const buf = Audio.buffers[name];
    if (buf) drawWaveform(canvas, computeOffsetPeaks(buf, bucketCount, start, end, newOffset));
  });
  function finish(e) {
    if (dragStartClientX == null) return;
    dragStartClientX = null;
    if (!moved) { seekFromElement(canvas, e); return; }
    // Full re-render (not just this canvas) — the mute-lane's regions and
    // any other absolute-time-positioned UI need to reflect the same view,
    // and renderLanes() is what (re)computes bucketCount/viewWindow fresh.
    renderLanes();
    saveProjectDebounced();
    // Offset just changed — resync playback to it immediately if running,
    // same as any other live mix change that affects what's scheduled.
    // (Speed/Tune's "processed" mode doesn't yet honor a custom stem's
    // offset — a known rough edge, not something this drag can fix.)
    if (Audio.playing && Audio.mode !== "processed") startPlaybackAt(currentPosition());
  }
  canvas.addEventListener("mouseup", finish);
  canvas.addEventListener("mouseleave", () => { dragStartClientX = null; });
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
      questMarkDone("carve");
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
  // Continuous zoom: #ruler is now the outer flex row (sticky gutter +
  // #ruler-content); #ruler-content is the actual timeToPct/pctToTime
  // containing block (unchanged math from before that split), so click/
  // drag rect math and the playhead element both target it, not #ruler.
  const rulerContent = document.getElementById("ruler-content");
  const rulerPh = document.createElement("div");
  rulerPh.id = "ruler-playhead";
  rulerPh.className = "playhead";
  rulerContent.appendChild(rulerPh);

  rulerContent.addEventListener("click", (e) => {
    if (e.target.classList.contains("loop-handle")) return;
    const rect = rulerContent.getBoundingClientRect();
    seekTo(pctToTime((e.clientX - rect.left) / rect.width * 100));
  });

  function wireHandle(handleEl, key) {
    handleEl.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      startDrag((me) => {
        const rect = rulerContent.getBoundingClientRect();
        const t = pctToTime((me.clientX - rect.left) / rect.width * 100);
        if (!State.ui.loop) State.ui.loop = { ...viewWindow() };
        if (key === "start") State.ui.loop.start = Math.min(t, State.ui.loop.end - 0.1);
        else State.ui.loop.end = Math.max(t, State.ui.loop.start + 0.1);
        updateLoopVisual();
      }, () => { saveProjectDebounced(); questMarkDone("battleground"); });
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
  const row = document.getElementById("markers-row-content");
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

async function addMarkerAtPlayhead() {
  if (!Audio.duration) return;
  const label = await textPrompt("Marker name:", `Marker ${(State.markers || []).length + 1}`);
  if (label === null) return; // cancelled
  State.markers = [...(State.markers || []), { time: currentPosition(), label: label.trim() || "Marker" }];
  renderMarkers();
  saveProjectDebounced();
  questMarkDone("battleground");
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
    Audio.clickBus.gain.value = Audio.clickVolume;
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
  if (!clickEl || !clickEl.classList.contains("active") || !Audio.playing) return;
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

// A "timeline" transport control (Mixer's Backing Track card, Play Along's
// mirrored copy, and AI Lab's Rate My Take card) — a plain scrub slider,
// not the full waveform/lane ruler, so a solo/section can be found and
// seeked to without leaving whichever screen you're on. Skipped for any
// copy currently mid-drag (timelineDragEls) so the playback-driven update
// here doesn't fight the user's own in-progress scrub.
const timelineDragEls = new Set();
function renderTimelineSlider(pos) {
  for (const el of transportEls("timeline")) {
    if (timelineDragEls.has(el)) continue;
    el.value = pos;
  }
}
// Called whenever Audio.duration changes (a track loads, stems finish
// loading) — the slider's own max has to track it, not just its value.
function updateTimelineSliderRange() {
  for (const el of transportEls("timeline")) el.max = Audio.duration || 0;
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
        stopPlayback(); // resets position and the play-btn icon synchronously
        pos = currentPosition();
        maybeAutoAdvance(); // playlist ⟳ auto-play — no-op unless armed
      }
    }
    applyLiveMuteRanges(pos);
    renderPlayhead(pos);
    renderTimeDisplay(pos);
    renderTimelineSlider(pos);
    updateClickStem(pos); // BT-02
    // ailab.js (loads after this file) — self-throttled, no-ops unless AI
    // Lab is open in follow mode.
    if (typeof aiLabFollowTick === "function") aiLabFollowTick(pos);
    if (Audio.playing) autoScrollToPlayhead(pos);
  }
  requestAnimationFrame(tick);
}

// Continuous zoom: GarageBand-style follow-scroll. The playhead moves
// freely within the visible viewport up to its horizontal center; past
// that (or if it's behind the visible area at all — a loop wrap, a marker
// jump, a manual seek while zoomed in) the view re-centers on it instead
// of letting it run off the edge or vanish off-screen. No-ops once
// there's nothing to scroll (fits entirely, or not zoomed in).
function autoScrollToPlayhead(pos) {
  const workspace = document.getElementById("workspace");
  const rulerContent = document.getElementById("ruler-content");
  if (!workspace || !rulerContent || !Audio.duration) return;
  const contentWidth = rulerContent.getBoundingClientRect().width;
  const viewportWidth = workspace.clientWidth;
  if (contentWidth <= viewportWidth + 1) return;

  const playheadPx = (timeToPct(pos) / 100) * contentWidth;
  const relativeX = playheadPx - workspace.scrollLeft;
  const center = viewportWidth / 2;
  if (relativeX > center || relativeX < 0) {
    workspace.scrollLeft = Math.max(0, Math.min(playheadPx - center, contentWidth - viewportWidth));
  }
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
  bus.gain.value = Audio.clickVolume;
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
      withOptionalCountIn(!!(countInEl && countInEl.classList.contains("active")), () => startPlaybackAt(offset));
      setTransportText("play-btn", "⏸");
    }
  });
  onTransportClick("stop-btn", () => {
    stopPlayback(); // resets the play-btn icon itself
    renderPlayhead(0);
    renderTimeDisplay(0);
  });
  // timelineDragEls: renderTimelineSlider() (the tick() loop) skips any
  // element in this set, so scrubbing doesn't fight the playback-driven
  // value update every frame. mouseup/touchend are on the window, not the
  // slider itself — a drag that ends outside the element (a fast flick
  // past its edges) would otherwise never clear the flag.
  for (const el of transportEls("timeline")) {
    el.addEventListener("mousedown", () => timelineDragEls.add(el));
    el.addEventListener("touchstart", () => timelineDragEls.add(el));
  }
  window.addEventListener("mouseup", () => timelineDragEls.clear());
  window.addEventListener("touchend", () => timelineDragEls.clear());
  onTransportInput("timeline", (value) => {
    if (!Audio.ctx) return;
    seekTo(parseFloat(value));
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
  onTransportClick("count-in-toggle", () => {
    const on = !transportEls("count-in-toggle")[0].classList.contains("active");
    toggleTransportClass("count-in-toggle", "active", on);
  });
  document.getElementById("click-toggle").addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.classList.toggle("active");
    // Resync the beat pointer to the current position: while the click is
    // off, updateClickStem() never advances it, so toggling on mid-song
    // would otherwise fire every skipped beat at once as a single blast.
    resyncClickPointer(currentPosition());
  });
  document.getElementById("click-volume-slider").addEventListener("input", (e) => {
    // *2: max reachable gain is now 2.0, not 1.0 — the click was too quiet
    // to cut through a busy full-band mix at its old ceiling. Slider's own
    // 0-100/default-25 stay put (25/100*2 = 0.5, the same starting volume
    // as before this change) so only the achievable range grew, not the
    // slider's size or where it starts.
    Audio.clickVolume = parseFloat(e.target.value) / 100 * 2;
    if (Audio.clickBus) Audio.clickBus.gain.value = Audio.clickVolume;
  });
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
  renderSectionLane();
  renderChordLane();
  updateLoopVisual();
  renderPlayhead(currentPosition());
}

function wireZoomControls() {
  document.getElementById("zoom-to-loop-btn").addEventListener("click", () => {
    if (!State.ui.loop || !Audio.duration) return; // nothing to zoom to without a loop set (§6)
    zoomWindow = { start: State.ui.loop.start, end: State.ui.loop.end };
    // Drop the playhead at the loop start so playback begins where you're now
    // looking, instead of leaving it wherever it happened to be (often outside
    // the zoomed-in window entirely).
    seekTo(State.ui.loop.start);
    document.getElementById("zoom-to-loop-btn").style.display = "none";
    document.getElementById("zoom-out-btn").style.display = "inline-block";
    // "Zoom to loop" is its own complete, always-fits-the-viewport view —
    // the continuous slider resets so the two zoom mechanisms don't stack
    // into "a narrowed window ALSO scrolled/widened," which would just be
    // confusing (drag the slider afterward to zoom in further within it).
    resetTimelineZoom();
    rerenderTimeline();
  });
  document.getElementById("zoom-out-btn").addEventListener("click", () => {
    zoomWindow = null;
    document.getElementById("zoom-out-btn").style.display = "none";
    document.getElementById("zoom-to-loop-btn").style.display = "inline-block";
    resetTimelineZoom();
    rerenderTimeline();
  });
  wireTimelineZoomSlider();
}

// Shared by track-switch and both Zoom to loop/Zoom out buttons — resets
// the continuous zoom back to fit-width and scrolls back to the start,
// without touching zoomWindow (callers decide that part separately).
function resetTimelineZoom() {
  zoomMultiplier = 1;
  const slider = document.getElementById("timeline-zoom-slider");
  if (slider) slider.value = "0";
  const workspace = document.getElementById("workspace");
  if (workspace) workspace.scrollLeft = 0;
  applyZoomWidth();
}

function wireTimelineZoomSlider() {
  const slider = document.getElementById("timeline-zoom-slider");
  // Cheap resize on every drag tick — every zoomed row is positioned by
  // CSS % (timeToPct), which re-resolves against the new width for free;
  // only the waveform's drawn bitmap doesn't auto-adapt, so it just
  // stretches (a bit soft) until the drag settles.
  slider.addEventListener("input", (e) => {
    zoomMultiplier = zoomSliderToMultiplier(parseFloat(e.target.value));
    applyZoomWidth();
  });
  // On release: redraw the waveforms at the new resolution (renderLanes
  // calls applyZoomWidth again itself, redundant but harmless).
  slider.addEventListener("change", () => {
    if (State.track) renderLanes();
  });
  slider.addEventListener("dblclick", () => {
    slider.value = "0";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("workspace").scrollLeft = 0;
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
  wireDoubleClickReset("volume-display", "volume-slider", 100);
}

// ---------------------------------------------------------------------------
// Inspector: track analysis, guitar split, export
// ---------------------------------------------------------------------------

// Octave errors (locking onto half or double the real tempo) are a known
// failure mode of automatic tempo estimation that no amount of tuning
// fully eliminates — see backing_track.py's own start_bpm=140 comment.
// Rather than chase a perfect detector, give the user a one-click escape
// hatch; the corrected value is saved per-song (State.bpmOverride) so it
// sticks. Mutates State.analysis.bpm directly (not a separate multiplier)
// so every consumer that already reads it — the display here, and
// countInBpm()'s count-in scheduling — picks up the correction for free.
function correctBpm(multiplier) {
  const a = State.analysis || {};
  if (!a.bpm) return;
  a.bpm = Math.round(a.bpm * multiplier * 10) / 10;
  State.bpmOverride = a.bpm;
  updateBpmDisplay();
  saveProjectDebounced();
}

function wireBpmCorrection() {
  document.getElementById("bpm-half-btn").addEventListener("click", () => correctBpm(0.5));
  document.getElementById("bpm-double-btn").addEventListener("click", () => correctBpm(2));
}

// Real user report: detect_key got a real song wrong (heard as A#, actually
// D minor by ear) — unlike a BPM octave error, there's no simple formula
// from "wrong key" to "right key" to auto-correct, so this is a direct
// manual override instead. Deliberately doesn't touch State.analysis.key
// (the raw detected value) — updateKeyHint() prefers State.keyOverride
// when set, so "Reset" always has the original detection to go back to.
function correctKey(root, mode) {
  State.keyOverride = { key: root, mode };
  updateKeyHint();
  refreshKeyCorrectionControls();
  saveProjectDebounced();
}

function resetKeyCorrection() {
  State.keyOverride = null;
  updateKeyHint();
  refreshKeyCorrectionControls();
  saveProjectDebounced();
}

// Keeps the two selects showing whatever key is actually in effect right
// now (override if set, else the raw detection) and the Reset button only
// visible once there's actually something to reset.
function refreshKeyCorrectionControls() {
  const key = State.keyOverride || (State.analysis || {}).key;
  const rootSel = document.getElementById("key-correct-root");
  const modeSel = document.getElementById("key-correct-mode");
  if (!rootSel) return;
  rootSel.disabled = modeSel.disabled = !key;
  if (key) {
    rootSel.value = key.key;
    modeSel.value = key.mode;
  }
  document.getElementById("key-correct-reset-btn").style.display = State.keyOverride ? "inline-block" : "none";
}

function wireKeyCorrection() {
  const rootSel = document.getElementById("key-correct-root");
  rootSel.innerHTML = KEY_NOTE_NAMES.map((n) => `<option value="${n}">${n}</option>`).join("");
  document.getElementById("key-correct-set-btn").addEventListener("click", () => {
    correctKey(rootSel.value, document.getElementById("key-correct-mode").value);
  });
  document.getElementById("key-correct-reset-btn").addEventListener("click", resetKeyCorrection);
}

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
    renderChordLane(); // V4-F1 — chord roots transpose live too
    if (typeof refreshAiLabIfOpen === "function") refreshAiLabIfOpen(); // V5-F2 — same transposition, if AI Lab is open
    setSpeedTune(speed, Math.pow(2, cents / 1200));
  }
  onTransportInput("speed-slider", apply);
  onTransportInput("tune-slider", apply);
  wireDoubleClickReset("speed-display", "speed-slider", 1);
  wireDoubleClickReset("tune-display", "tune-slider", 0);
}

// Double-clicking a value readout resets its slider to a neutral default —
// a fast way back to "unmodified" without dragging, standard behavior for
// this kind of control. Works through the same transport input event every
// other listener already reacts to, so nothing needs to know this exists.
function wireDoubleClickReset(displayName, sliderName, defaultValue) {
  for (const el of transportEls(displayName)) {
    el.style.cursor = "pointer";
    el.title = `Double-click to reset to ${defaultValue}`;
    el.addEventListener("dblclick", () => {
      setTransportValue(sliderName, defaultValue);
      transportEls(sliderName)[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
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
  const key = State.keyOverride || (State.analysis || {}).key;
  if (!key) { el.textContent = ""; return; }
  const base = State.keyOverride
    ? `Key: ${key.key} ${key.mode} (manually corrected).`
    : `Detected key: ${key.key} ${key.mode} (confidence ${key.confidence.toFixed(2)} — a heuristic, confirm by ear).`;
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

// V4-F1 (BT-04): "Am", "D7", "C" — quality names guitarists actually read,
// not lead-sheet Roman-numeral or jazz-extended notation (the guitar-only
// lens release-v4-spec.md's V4-F1 calls for). null means no confident
// chord for this beat (backing_track.py's CHORD_CONFIDENCE_FLOOR), not "no
// chord was ever computed" — renderChordLane tells those two apart itself.
function chordSymbol(chord, semitones) {
  if (!chord.root || chord.quality === "N") return null;
  const root = transposedKeyName(chord.root, semitones) || chord.root;
  const suffix = chord.quality === "maj" ? "" : chord.quality === "min" ? "m" : chord.quality;
  return root + suffix;
}

// BT-20: a fixed palette keyed by section letter, so the SAME letter always
// draws the SAME color across the whole song — the point of the ribbon is to
// make "this part comes back later" visible at a glance, which only works if
// every A is one color, every B another. Deliberately distinct hues, readable
// in both themes at the ribbon's low opacity.
const SECTION_COLORS = ["#4a90d9", "#5cb85c", "#d9a441", "#b86bd9", "#d9645c", "#41c7d9", "#9db84a", "#d97f9e"];
function sectionColor(label) {
  const i = (label.charCodeAt(0) - 65) % SECTION_COLORS.length;
  return SECTION_COLORS[i < 0 ? 0 : i];
}
function fmtClock(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// BT-20 song-section detection is intentionally NOT surfaced on the Mixer
// timeline for now — the detection (detect_sections, backing_track.py), the
// `sections` analysis data, this renderer, the #section-lane markup and its
// CSS are all kept intact, but the ribbon stays hidden while we reconsider
// where this belongs (a planned AI Lab "song structure" panel that pairs the
// detected sections with an LLM analysis of the song's parts). Flip this one
// flag to true to put the ribbon back on the Mixer.
const SECTION_RIBBON_ON_MIXER = false;

// Coarse song structure (BT-20, detect_sections in backing_track.py) — same
// sticky-header/timeToPct layout as renderChordLane, one row up. Unlike chords
// these don't transpose, so it's re-rendered on zoom/scroll/select but not on
// Tune changes.
function renderSectionLane() {
  const outer = document.getElementById("section-lane");
  const row = document.getElementById("section-lane-content");
  if (!outer || !row) return;
  const sections = SECTION_RIBBON_ON_MIXER ? (State.analysis || {}).sections : null;
  if (!sections || !sections.length || !Audio.duration) {
    outer.style.display = "none";
    row.innerHTML = "";
    return;
  }
  outer.style.display = "flex";
  row.innerHTML = "";

  const { start: viewStart, end: viewEnd } = viewWindow();
  const frag = document.createDocumentFragment();
  sections.forEach((sec) => {
    if (sec.end < viewStart || sec.start > viewEnd) return;
    const color = sectionColor(sec.label);
    const block = document.createElement("div");
    block.className = "section-block";
    block.style.left = timeToPct(sec.start) + "%";
    block.style.width = Math.max(0, timeToPct(sec.end) - timeToPct(sec.start)) + "%";
    block.style.background = color;
    block.style.border = "1px solid " + color;
    block.textContent = sec.label;
    block.title = `Section ${sec.label} (${fmtClock(sec.start)}–${fmtClock(sec.end)}) — click to jump. Structure is assistive/approximate; A/B/C mark repeated parts, not verse/chorus names.`;
    block.addEventListener("click", () => seekTo(sec.start));
    frag.appendChild(block);
  });
  row.appendChild(frag);
}

// Same "always visible when data exists, no separate toggle" idiom as
// renderBeatGrid — and the same viewWindow()/timeToPct() positioning BT-17
// established, except chips have a real width (a run of beats), not a
// single left position like a marker flag.
function renderChordLane() {
  const outer = document.getElementById("chord-lane");
  const row = document.getElementById("chord-lane-content");
  const chords = (State.analysis || {}).chords;
  if (!chords || !chords.length || !Audio.duration) {
    outer.style.display = "none";
    row.innerHTML = "";
    return;
  }
  outer.style.display = "flex";
  row.innerHTML = "";

  const { start: viewStart, end: viewEnd } = viewWindow();
  const tuneEl = transportEls("tune-slider")[0];
  const cents = tuneEl ? parseFloat(tuneEl.value) : 0;
  const semitones = Math.trunc(cents / 100);

  // Consecutive beats sharing the same (root, quality) collapse into one
  // wider run instead of one chip per beat — a chord held for several
  // bars would otherwise render as a dozen slivers too narrow to read,
  // and at full-song zoom hundreds of same-colored one-beat slivers just
  // look like a single solid bar (indistinguishable from "nothing is
  // being detected" even though the underlying data varies correctly).
  const runs = [];
  chords.forEach((c, i) => {
    const end = i + 1 < chords.length ? chords[i + 1].time : Audio.duration;
    const last = runs[runs.length - 1];
    if (last && last.root === c.root && last.quality === c.quality) {
      last.end = end;
    } else {
      runs.push({ time: c.time, end, root: c.root, quality: c.quality, confidence: c.confidence });
    }
  });

  const frag = document.createDocumentFragment();
  runs.forEach((run) => {
    if (run.end < viewStart || run.time > viewEnd) return;
    const symbol = chordSymbol(run, semitones);
    const chip = document.createElement("div");
    chip.className = "chord-chip" + (symbol ? "" : " chord-chip-unknown");
    chip.style.left = timeToPct(run.time) + "%";
    chip.style.width = Math.max(0, timeToPct(run.end) - timeToPct(run.time)) + "%";
    chip.textContent = symbol || "?";
    chip.title = symbol
      ? `${symbol} (confidence ${run.confidence.toFixed(2)} — assistive, best on pop/rock; confirm by ear)`
      : "No confident chord read for this section.";
    chip.addEventListener("click", () => seekTo(run.time));
    frag.appendChild(chip);
  });
  row.appendChild(frag);
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
  refreshKeyCorrectionControls();

  const chordHintEl = document.getElementById("chord-hint");
  chordHintEl.textContent = (a.chords && a.chords.length)
    ? "Chord lane (above the ruler): assistive, best on pop/rock — no confident read for palm muted chugs. Confirm by ear."
    : "";
  renderSectionLane();
  renderChordLane();
  // V5-F2: a new track's chord regions make any previously-selected AI Lab
  // chord index meaningless — re-pick the one under the playhead instead.
  if (typeof AiLab !== "undefined") AiLab.selectedIndex = null;
  if (typeof refreshAiLabIfOpen === "function") refreshAiLabIfOpen();

  // custom-stems-spec.md §5: only a genuine model-produced "guitar" stem
  // should trigger this panel — a custom/derived stem that happens to be
  // named "guitar" (e.g. a dropped-in real DI take) isn't the separator's
  // guitar stem this panning-guess split exists for.
  const hasGuitar = State.stems.some((s) => s.name === "guitar" && !s.is_derived && !s.is_custom);
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
    btn.classList.add("running"); // green while the split crunches (button state model)
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
      btn.classList.remove("running");
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
    // GP-15: a repositioned custom stem needs the same offset baked into
    // the bounce, or it'd land at song-start instead of where it's
    // actually heard live.
    offsets: State.mix.offset,
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
    refreshExportedTracksList(); // Play Along's list — live-updates even if that screen isn't open right now
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
  State.mix = { gains: {}, muted: {}, solo: null, muteRanges: {}, eq: {}, pan: {}, offset: {} };
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
  let lastStatus = null;
  (async () => {
    while (polling) {
      try {
        const s = await Api.get(`/api/separate_status?source_path=${encodeURIComponent(track)}` +
          `&model=${encodeURIComponent(model)}`);
        lastStatus = s;
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
    // The POST above holds one HTTP connection open for as long as
    // separation takes — several minutes for a full song — with zero
    // response bytes until it's done. That's exactly the shape of request
    // some VPNs/firewalls/OS network stacks silently kill as "idle," even
    // though the job is very much alive and finishes fine server-side
    // (svc_separate's job tracker, polled independently above, is the
    // real source of truth). Before reporting a failure the job status
    // says didn't happen, check whether the poller's last known status
    // says otherwise and recover via a plain stem fetch instead of
    // needlessly re-running the whole separation.
    if (lastStatus && lastStatus.status === "done") {
      try {
        const r = await Api.get(`/api/list_stems?source_path=${encodeURIComponent(track)}` +
          `&model=${encodeURIComponent(model)}`);
        await onStemsLoaded(r);
        saveProjectDebounced();
        return;
      } catch (e2) { /* genuinely not there after all — fall through */ }
    }
    alert("Separation failed: " + e.message);
    await refreshStemsForCurrentModelAndTrack();
  }
}

function wireSeparateButton() {
  document.getElementById("separate-btn").addEventListener("click", () => runSeparate(true));
}

function wireStemsRetryButton() {
  document.getElementById("stems-retry-btn").addEventListener("click", () => {
    showState("loading-state");
    refreshStemsForCurrentModelAndTrack();
  });
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
  // One smart drop zone (ui-review-v5-full.md §2.3): the extension decides
  // which import path a file takes, same routing logic whether it arrived
  // via click-to-browse or drag-and-drop.
  inputEl.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f && f.name.toLowerCase().endsWith(".zip")) importStemZip(f);
    else if (f) importFile(f);
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
  sidebarEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropEl.classList.add("dragover");
  });
  sidebarEl.addEventListener("dragleave", (e) => {
    if (!sidebarEl.contains(e.relatedTarget)) dropEl.classList.remove("dragover");
  });
  sidebarEl.addEventListener("drop", (e) => {
    e.preventDefault();
    dropEl.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    // A dropped .zip is a stem pack, not a single audio file to run
    // through separation — route it to the other import path rather than
    // letting /api/import reject it with a confusing error.
    if (f && f.name.toLowerCase().endsWith(".zip")) importStemZip(f);
    else if (f) importFile(f);
  });
}

// custom-stems-spec.md: a separate drop target from the sidebar's "import
// a new song" zone — dropping a file onto the mixer's own lane area for a
// track that's ALREADY separated adds it as one more stem instead. Kept
// deliberately distinct (not merged into the sidebar's drop zone) so the
// two never get confused with each other: sidebar = new song, workspace =
// add to this song.
function wireCustomStemDrop() {
  const workspaceEl = document.getElementById("workspace");
  const overlayEl = document.getElementById("custom-stem-dropzone");

  workspaceEl.addEventListener("dragover", (e) => {
    if (!State.stems.length) return; // nothing separated yet to add to
    e.preventDefault();
    overlayEl.classList.add("show");
  });
  workspaceEl.addEventListener("dragleave", (e) => {
    if (!workspaceEl.contains(e.relatedTarget)) overlayEl.classList.remove("show");
  });
  workspaceEl.addEventListener("drop", (e) => {
    overlayEl.classList.remove("show");
    if (!State.stems.length) return;
    e.preventDefault();
    e.stopPropagation(); // don't also let wireImport's sidebar/document handlers see this drop
    const f = e.dataTransfer.files[0];
    if (f) addCustomStem(f);
  });
}

async function addCustomStem(file) {
  const overlayEl = document.getElementById("custom-stem-dropzone");
  const originalText = overlayEl.textContent;
  overlayEl.classList.add("show");
  overlayEl.textContent = `Adding "${file.name}"…`;
  try {
    const buf = await file.arrayBuffer();
    await Api.postRaw(
      `/api/custom_stem?source_path=${encodeURIComponent(State.track)}&filename=${encodeURIComponent(file.name)}`,
      buf);
    await refreshStemsForCurrentModelAndTrack();
  } catch (err) {
    alert(`Could not add "${file.name}" as a stem: ${err.message || err}`);
  } finally {
    overlayEl.textContent = originalText;
    overlayEl.classList.remove("show");
  }
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
    // A file picked from a cloud-storage placeholder that hasn't actually
    // been downloaded to this Mac yet (OneDrive/iCloud "available online
    // only") reads back empty or short rather than throwing — the OS
    // reports a real byte count in file.size (from its metadata) but the
    // read itself doesn't materialize the missing content. Catching that
    // here, before the upload, gives a specific and actionable message
    // instead of either silently doing nothing or a generic server-side
    // "Empty upload".
    if (buf.byteLength === 0 || buf.byteLength < file.size) {
      throw new Error(`"${file.name}" read back ${buf.byteLength} of its ${file.size} bytes — it's likely a cloud-storage ` +
        `placeholder that isn't downloaded to this Mac yet. In Finder, right-click the file and choose ` +
        `"Download Now" (or open it once in another app to force the download), then try importing again.`);
    }
    const r = await Api.postRaw(`/api/import?filename=${encodeURIComponent(file.name)}`, buf);
    await refreshTrackList();
    await selectTrack(r.name);
  } catch (e) {
    alert(`Could not import "${file.name}": ${e.message}`);
  } finally {
    dropEl.innerHTML = originalHtml;
  }
}

async function importStemZip(file) {
  const dropEl = document.getElementById("import-drop");
  const originalHtml = dropEl.innerHTML;
  dropEl.textContent = `Importing stem pack ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const r = await Api.postRaw(`/api/import_stem_zip?filename=${encodeURIComponent(file.name)}`, buf);
    await refreshTrackList();
    await selectTrack(r.name);
  } catch (err) {
    alert(`Could not import stem pack: ${err.message || err}`);
  } finally {
    dropEl.innerHTML = originalHtml;
  }
}

// ---------------------------------------------------------------------------
// Rip system audio (system-audio-rip-spec.md) — captures whatever's
// currently playing on the Mac via a BlackHole virtual audio device +
// MediaRecorder (same getUserMedia/DSP-off pattern as Play Along's input
// picker, playalong.js's paEnableInput), straight into input/ as a new
// song. Deliberately its own capture, not a tap on Recorder's internal
// record bus (recorder.js) — that bus only ever carries this app's own
// mix + monitored guitar, never arbitrary system audio.
// ---------------------------------------------------------------------------

const Rip = {
  stream: null,
  mediaRecorder: null,
  state: "idle", // idle | recording | saving
  startedAt: 0,
  tickInterval: null,
};

const RIP_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
];

function ripPickMimeType() {
  return RIP_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

async function ripRefreshDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const sel = document.getElementById("rip-device-select");
  const hintEl = document.getElementById("rip-hint");
  const startBtn = document.getElementById("rip-start-btn");
  const prevValue = sel.value;
  sel.innerHTML = "";
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Input ${sel.children.length + 1}`;
    sel.appendChild(opt);
  }
  if (prevValue && inputs.some((d) => d.deviceId === prevValue)) sel.value = prevValue;

  const blackhole = inputs.find((d) => /blackhole/i.test(d.label));
  if (blackhole && !prevValue) sel.value = blackhole.deviceId;

  if (!inputs.length) {
    hintEl.textContent = "No input devices listed yet — click Start Rip once to grant permission, which reveals device names.";
  } else if (!blackhole) {
    hintEl.innerHTML = 'No BlackHole device found. Install it once (<code>brew install blackhole-2ch</code>), ' +
      'set it as your Mac\'s output (or build a Multi-Output Device combining it with your speakers, if you ' +
      'also want to hear audio while ripping), then reload this page.';
  } else {
    hintEl.textContent = `Will capture via "${blackhole.label}". Without a Multi-Output Device set up, ` +
      `you'll hear silence while ripping — audio goes to BlackHole only, not your speakers.`;
  }
  startBtn.disabled = !inputs.length;
}

async function ripStart() {
  const deviceId = document.getElementById("rip-device-select").value;
  const hintEl = document.getElementById("rip-hint");
  const mimeType = ripPickMimeType();
  if (!mimeType) {
    hintEl.textContent = "This browser can't record audio (no supported MediaRecorder format).";
    return;
  }
  try {
    const audioConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    Rip.stream = stream;

    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 192_000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => ripFinalizeAndUpload(chunks, mimeType);
    recorder.onerror = (e) => {
      console.error("Rip MediaRecorder error", e.error);
      hintEl.textContent = "Recorder error — rip ended early, salvaging what was captured.";
      ripStop();
    };

    Rip.mediaRecorder = recorder;
    Rip.state = "recording";
    Rip.startedAt = performance.now();
    recorder.start(1000); // 1s timeslices — a crash loses at most the last second

    await ripRefreshDevices(); // device labels only populate after permission is granted
    updateRipUI();
    ripTick();
    Rip.tickInterval = setInterval(ripTick, 250);
  } catch (e) {
    hintEl.textContent = `Could not access input: ${e.message}. Check System Settings > Privacy & Security > Microphone.`;
  }
}

function ripStop() {
  if (!Rip.mediaRecorder || Rip.mediaRecorder.state === "inactive") return;
  Rip.mediaRecorder.stop();
  Rip.state = "saving";
  updateRipUI();
}

function ripTick() {
  if (Rip.state !== "recording") return;
  const elapsed = (performance.now() - Rip.startedAt) / 1000;
  const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
  document.getElementById("rip-elapsed").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

async function ripFinalizeAndUpload(chunks, mimeType) {
  const hintEl = document.getElementById("rip-hint");
  if (Rip.stream) { Rip.stream.getTracks().forEach((t) => t.stop()); Rip.stream = null; }
  if (Rip.tickInterval) { clearInterval(Rip.tickInterval); Rip.tickInterval = null; }

  const blob = new Blob(chunks, { type: mimeType });
  const srcExt = mimeType.includes("mp4") ? "m4a" : "webm";
  const defaultName = `Rip ${new Date().toLocaleString()}`;
  const name = (await textPrompt("Name this rip:", defaultName)) || defaultName;

  hintEl.textContent = "Saving rip…";
  try {
    const r = await Api.postRaw(`/api/rip/save?filename=${encodeURIComponent(name)}&src_ext=${srcExt}`, blob);
    hintEl.textContent = `Saved as ${r.name}.`;
    if (r.silent) {
      // Fails fast, while the routing is still fresh in mind — the
      // alternative is discovering it minutes later as a cryptic
      // "Expected a 'vocals' stem... but didn't find one among: []"
      // separation error, with no clue the real problem was upstream.
      alert(
        `This rip looks silent (peak level ${r.peak_db} dB — real audio is always much louder than this).\n\n` +
        "The Mac's system output isn't reaching BlackHole. Check:\n" +
        "• System Settings → Sound → Output is set to BlackHole (or a Multi-Output Device containing it)\n" +
        "• Whatever you were trying to capture was actually playing during the rip\n\n" +
        `"${r.name}" was still saved, but it's probably empty — delete it and try again after fixing the routing.`
      );
    }
    await refreshTrackList();
    await selectTrack(r.name);
  } catch (e) {
    hintEl.textContent = `Rip upload failed: ${e.message}`;
  } finally {
    Rip.state = "idle";
    updateRipUI();
  }
}

function updateRipUI() {
  const startBtn = document.getElementById("rip-start-btn");
  const stopBtn = document.getElementById("rip-stop-btn");
  const elapsedEl = document.getElementById("rip-elapsed");
  const recording = Rip.state === "recording";
  startBtn.style.display = recording || Rip.state === "saving" ? "none" : "";
  stopBtn.style.display = recording ? "" : "none";
  stopBtn.classList.toggle("recording", recording);
  stopBtn.disabled = Rip.state === "saving";
  elapsedEl.style.display = recording ? "" : "none";
  if (!recording) elapsedEl.textContent = "0:00";
}

const RIP_DETAILS_OPEN_KEY = "gs_rip_details_open";

function wireRip() {
  document.getElementById("rip-start-btn").addEventListener("click", ripStart);
  document.getElementById("rip-stop-btn").addEventListener("click", ripStop);
  ripRefreshDevices();
  updateRipUI();

  // ui-review-v5-full.md §2.3: collapsed by default, but remembers the
  // user's own choice once they've opened it (e.g. because they actually
  // use system-audio rip regularly) rather than re-collapsing every launch.
  const detailsEl = document.getElementById("rip-details");
  if (localStorage.getItem(RIP_DETAILS_OPEN_KEY) === "1") detailsEl.open = true;
  detailsEl.addEventListener("toggle", () => {
    localStorage.setItem(RIP_DETAILS_OPEN_KEY, detailsEl.open ? "1" : "0");
  });
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

// ---------------------------------------------------------------------------
// Quest Log (ui-review-v5-full.md §4) — first-use checklist v2. Ten steps,
// each auto-checking as real state changes, replacing the old one-shot
// help-overlay prose. Lives in the inspector while no track is loaded
// (where Speed Trainer/Export used to sit fully interactive but
// meaningless — see §2.2), and is re-openable any time as a modal from
// Help, even with a track loaded.
//
// "summon" and "awaken" are read live from state the app already has
// (library length, a remembered input device) so a returning user who did
// all this before the Quest Log existed sees accurate progress on day
// one, not a falsely-empty log. The rest are flagged the moment the real
// action succeeds (questMarkDone, called from onStemsLoaded/toggleMute/
// addMarkerAtPlayhead/practice-log-flush/recording-save/rig-preset-save/
// Rate My Take scoring/AI Assistant cache-write) — there's no cheap "ever,
// across every song" query for these without scanning every project file,
// and a flag costs nothing to maintain going forward.
// ---------------------------------------------------------------------------
const QUEST_FLAGS_KEY = "gs_quest_flags";
const QUEST_DEFS = [
  // These four all happen on the Mixer itself, so `screen` used to be
  // left unset — but questJump() only clicks def.screen if it's truthy,
  // meaning "go" was a total no-op for these four whenever clicked from
  // any other screen (real user report: "go buttons don't do anything").
  // Explicit "mixer-open-btn" here fixes that; harmless if you're on the
  // Mixer already (clicking its own already-active nav button).
  { key: "summon", name: "Summon a song", screen: "mixer-open-btn",
    desc: "Drop an audio file or stem pack — or rip one straight off the system audio." },
  { key: "forge", name: "Forge the stems", screen: "mixer-open-btn",
    desc: "Pick a model, hit Separate. Drums, bass, vocals, guitar — cleaved apart." },
  { key: "carve", name: "Carve the mix", screen: "mixer-open-btn",
    desc: "Mute or fade the original guitar. That space is yours now." },
  { key: "battleground", name: "Mark your battleground", screen: "mixer-open-btn",
    desc: "Loop the riff or solo you're here to conquer." },
  { key: "awaken", name: "Awaken the rig", screen: "tonelab-open-btn",
    desc: "Tone Lab: enable your guitar input, choose an amp." },
  { key: "tone", name: "Forge your tone", screen: "tonelab-open-btn",
    desc: "Shape the chain, then seal it as a Rig Preset." },
  { key: "arena", name: "Enter the arena", screen: "playalong-open-btn",
    desc: "Play Along: tune up, play the song end to end." },
  { key: "capture", name: "Capture a take", screen: "playalong-open-btn",
    desc: "Record a performance — camera optional, glory mandatory." },
  { key: "judge", name: "Face the judge", screen: "ailab-open-btn", tab: "ailab-tab-ratemytake",
    desc: "Rate My Take: a dry take, scored note-by-note against the master." },
  { key: "counsel", name: "Seek counsel", screen: "ailab-open-btn", tab: "ailab-tab-lickideas", optional: true,
    desc: "The AI Assistant: lick ideas, practice tips, the lore of the song. Needs a free API key." },
];

function questGetFlags() {
  try { return JSON.parse(localStorage.getItem(QUEST_FLAGS_KEY)) || {}; }
  catch (e) { return {}; }
}

function questMarkDone(key) {
  const flags = questGetFlags();
  if (flags[key]) return; // already known — skip the write+re-render
  flags[key] = true;
  localStorage.setItem(QUEST_FLAGS_KEY, JSON.stringify(flags));
  renderQuestLog();
}

function questIsDone(key, flags) {
  if (key === "summon") return (State.tracks || []).length > 0;
  // Deliberately the literal string, not playalong.js's PA_INPUT_DEVICE_KEY
  // constant — app.js's own init() runs synchronously as soon as this file
  // parses, before playalong.js's <script> tag has even loaded (it's later
  // in index.html), so referencing that constant here throws a
  // ReferenceError on first render. Keep this string in sync with
  // PA_INPUT_DEVICE_KEY if that ever changes.
  if (key === "awaken") return !!localStorage.getItem("gs_pa_input_device");
  return !!flags[key];
}

function questJump(def) {
  if (def.screen) document.getElementById(def.screen).click();
  if (def.tab) document.getElementById(def.tab).click();
  document.getElementById("quest-log-overlay").classList.remove("show");
}

// Renders into whichever surface is currently relevant — the inspector
// (no track loaded) and/or the Help-triggered modal — never both being
// built from scratch twice; same row markup either way.
function renderQuestLog() {
  const flags = questGetFlags();
  const done = QUEST_DEFS.map((d) => questIsDone(d.key, flags));
  const doneCount = done.filter(Boolean).length;
  const countText = `${doneCount} / ${QUEST_DEFS.length}`;

  const rowsHtml = QUEST_DEFS.map((d, i) => `
    <div class="quest-row${done[i] ? " done" : ""}${d.optional ? " optional" : ""}">
      <span class="quest-rune">${done[i] ? "✓" : ""}</span>
      <div class="quest-body">
        <div class="quest-name">${escapeHtml(d.name)}${d.optional ? " <em>optional</em>" : ""}</div>
        <div class="quest-desc">${escapeHtml(d.desc)}</div>
      </div>
      <button class="quest-go" data-quest-idx="${i}">go</button>
    </div>
  `).join("");

  for (const [listId, countId] of [["quest-log-list", "quest-log-count"], ["quest-log-modal-list", "quest-log-modal-count"]]) {
    const listEl = document.getElementById(listId);
    const countEl = document.getElementById(countId);
    if (!listEl) continue;
    listEl.innerHTML = rowsHtml;
    countEl.textContent = countText;
    listEl.querySelectorAll(".quest-go").forEach((btn) => {
      btn.addEventListener("click", () => questJump(QUEST_DEFS[parseInt(btn.dataset.questIdx, 10)]));
    });
  }
}

function wireQuestLog() {
  document.getElementById("help-quest-log-btn").addEventListener("click", () => {
    document.getElementById("help-overlay").classList.remove("show");
    renderQuestLog();
    document.getElementById("quest-log-overlay").classList.add("show");
  });
  document.getElementById("quest-log-modal-close-btn").addEventListener("click", () => {
    document.getElementById("quest-log-overlay").classList.remove("show");
  });
  renderQuestLog();
}

// ui-review-v5-full.md §6: "Molten Obsidian" theme (dark, default) and its
// "Bright Spark" light counterpart — both a data-theme attribute the whole
// app's CSS custom properties key off, not a rebuild, so the original
// "Studio" look stays one click away too. The actual attribute is applied
// before first paint by a tiny inline <script> in <head> (avoids a
// flash-of-wrong-theme on reload); this just wires the button and keeps
// localStorage in sync going forward. Only an explicitly-stored value
// among THEME_ORDER counts — anything else (absence, an old build's
// literal "molten") falls back to the default, so the default flip never
// needed a migration for existing users.
const THEME_KEY = "gs_theme";
const THEME_ORDER = ["molten", "brightspark", "studio"];
const THEME_ICONS = { molten: "🔥", brightspark: "☀️", studio: "🌙" };
const THEME_LABELS = { molten: "Molten Obsidian", brightspark: "Bright Spark", studio: "Studio" };

function currentTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return THEME_ORDER.includes(stored) ? stored : "molten";
}

function applyTheme(theme) {
  if (theme === "studio") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("theme-toggle-btn");
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
  btn.textContent = THEME_ICONS[theme];
  btn.title = `${THEME_LABELS[theme]} theme — click to switch to ${THEME_LABELS[next]}`;
}

function wireThemeToggle() {
  applyTheme(currentTheme());
  document.getElementById("theme-toggle-btn").addEventListener("click", () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    // Waveforms are canvas-drawn from var(--waveform) at draw time — a
    // theme swap needs a real redraw, CSS alone can't recolor them.
    if (State.track) renderLanes();
  });
}

// XC-04: in-app onboarding/help — auto-shown once on first launch (nobody
// reads USER-MANUAL.md before diving in), reachable any time after via the
// sidebar's ❓ Help button.
const HELP_SEEN_KEY = "gs_help_seen";

function toggleHelp() {
  document.getElementById("help-overlay").classList.toggle("show");
}

// Sidebar's fixed 240px was getting cramped (long stem names, playlist
// names) — drag #sidebar-resize-handle left/right to resize it, persisted
// across reloads like the other per-user (not per-project) UI prefs this
// app already keeps in localStorage (pedal order, collapsed cards before
// v4.7's redesign, etc).
const SIDEBAR_WIDTH_KEY = "gs_sidebar_width";
const SIDEBAR_WIDTH_DEFAULT = 240;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 480;

function applySidebarWidth(px) {
  const clamped = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, px));
  document.documentElement.style.setProperty("--sidebar-width", clamped + "px");
  return clamped;
}

function wireSidebarResize() {
  const handle = document.getElementById("sidebar-resize-handle");
  const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  applySidebarWidth(Number.isFinite(stored) ? stored : SIDEBAR_WIDTH_DEFAULT);

  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    e.preventDefault(); // don't let the drag select page text
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // #sidebar is the grid's first column, flush against the window's own
    // left edge, so the pointer's viewport-relative X is already exactly
    // the width the sidebar should be — no rect math needed.
    applySidebarWidth(e.clientX);
    // #lanes' width only changes because this grid column did — no native
    // "resize" event fires for that (window.addEventListener("resize", ...)
    // only sees actual viewport changes), so applyZoomWidth's own
    // lanesEl.clientWidth read would otherwise go stale here forever.
    // Cheap on every tick, same as the zoom slider's own "input" handler;
    // the waveform bitmap itself just stretches until the drag settles.
    applyZoomWidth();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    localStorage.setItem(SIDEBAR_WIDTH_KEY, parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"), 10));
    // Redraw waveforms at the new resolution now the drag has settled —
    // same "cheap during, full redraw after" split as the zoom slider.
    if (State.track) renderLanes();
  });
  handle.addEventListener("dblclick", () => {
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT);
    if (State.track) renderLanes();
  });
}

// Inspector (Track/Speed Trainer/Export) collapse — real user report: it
// eats screen width on the Mixer that could go to the lanes. Binary
// collapse/expand rather than a drag-resize like the sidebar, since the
// ask was just to free up width, not to fine-tune this panel's size.
const INSPECTOR_WIDTH_DEFAULT = 280;
const INSPECTOR_COLLAPSED_KEY = "gs_inspector_collapsed";

function applyInspectorCollapsed(collapsed) {
  document.getElementById("app").classList.toggle("inspector-collapsed", collapsed);
  document.documentElement.style.setProperty(
    "--inspector-width", (collapsed ? 0 : INSPECTOR_WIDTH_DEFAULT) + "px");
  document.getElementById("inspector-toggle-btn").textContent = collapsed ? "◂" : "▸";
}

function wireInspectorCollapse() {
  const btn = document.getElementById("inspector-toggle-btn");
  applyInspectorCollapsed(localStorage.getItem(INSPECTOR_COLLAPSED_KEY) === "1");
  btn.addEventListener("click", () => {
    const collapsed = !document.getElementById("app").classList.contains("inspector-collapsed");
    applyInspectorCollapsed(collapsed);
    localStorage.setItem(INSPECTOR_COLLAPSED_KEY, collapsed ? "1" : "0");
    // #workspace's width just changed because this grid column did — same
    // "no native resize event fires for this" reasoning as the sidebar
    // drag handler above.
    applyZoomWidth();
    if (State.track) renderLanes();
  });
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
      case "ArrowRight":
        // Right/Left are now the default rig-preset cycle keys (GP-14)
        // while either rig screen is open — the Mixer's own nudge action
        // for these keys only applies when it's actually what's showing,
        // so it doesn't fight playalong.js's keydown handler over the
        // same keypress.
        if (document.getElementById("tonelab-overlay").classList.contains("show") ||
            document.getElementById("playalong-overlay").classList.contains("show")) break;
        e.preventDefault();
        // BT-17: Alt = finer 100ms nudge, for lining up a loop/mute edge to
        // an exact transient rather than the plain 1s step's coarse range.
        if (e.key === "ArrowLeft") {
          seekTo(Math.max(0, currentPosition() - (e.shiftKey ? 5 : e.altKey ? 0.1 : 1)));
        } else {
          seekTo(Math.min(Audio.duration, currentPosition() + (e.shiftKey ? 5 : e.altKey ? 0.1 : 1)));
        }
        break;
      default:
        break;
    }
  });
}

// Real user request: closing this tab/window shuts the local server down,
// instead of it running invisibly forever until manually stopped. Server-side
// design (session counting, why pagehide+sendBeacon and not a periodic
// heartbeat) is documented next to _open_sessions in server.py — the short
// version: pagehide fires on an actual close/navigate-away only, never on a
// mere tab-switch/backgrounding, so leaving this tab open in the background
// while working elsewhere never trips it; a same-tab reload also fires
// pagehide, but the reloaded page's own session/open call lands well within
// the server's few-second grace window and cancels the pending shutdown.
function wireAutoShutdownSession() {
  fetch("/api/session/open", { method: "POST", keepalive: true }).catch(() => {});
  window.addEventListener("pagehide", () => {
    navigator.sendBeacon("/api/session/close");
  });
}

async function init() {
  wireAutoShutdownSession();
  initRuler();
  wireTransport();
  wireModelBadge();
  wireSplitPanel();
  wireExportPanel();
  wireSeparateButton();
  wireStemsRetryButton();
  wireStaleBanner();
  wireImport();
  wireCustomStemDrop();
  wireRip();
  wireSpeedTune();
  wireSpeedTrainer();
  wireBpmCorrection();
  wireKeyCorrection();
  wireVolumeSlider();
  wireKeyboardShortcuts();
  wireHelp();
  wireSidebarResize();
  wireInspectorCollapse();
  wireQuestLog();
  wireThemeToggle();
  showState("empty-state"); // syncs Quest Log vs. normal-panels visibility on first load

  const modelsResp = await Api.get("/api/models");
  State.models = modelsResp.models;
  State.defaultModel = modelsResp.default;
  renderModelMenu();

  await refreshPlaylists();
  await refreshTrackList();
  requestAnimationFrame(tick);
  setInterval(practiceLogTick, PRACTICE_TICK_MS);
}

init();
