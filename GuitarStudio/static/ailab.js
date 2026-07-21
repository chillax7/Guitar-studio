"use strict";
// AI Lab (V5-F2): Scale/Mode Advisor — Tier 1, deterministic. Straight
// interval arithmetic over the same chord-lane/key data the Mixer already
// computes (BT-03/BT-04 in backing_track.py) — no model call, no network,
// no per-use cost, and it can't go stale or get rate-limited. See
// research/release-v5-spec.md §2/§2a for the design this implements
// (including why Whole-song mode only ever renders one key region today —
// windowed/segmented key detection is backlog, not built yet).
//
// Loaded after app.js (uses its KEY_NOTE_NAMES/transposedKeyName/State/
// transportEls/currentPosition/seekTo) and before playalong.js.

const AILAB_STRINGS = [4, 9, 2, 7, 11, 4]; // open strings low->high: E A D G B E (pitch classes, 0=C)
const AILAB_STRING_LABELS = ["E", "A", "D", "G", "B", "E"];

const AILAB_SCALES = {
  major:      { name: "Major",           intervals: [0, 2, 4, 5, 7, 9, 11], why: "the song's key scale itself — always available, always a safe default." },
  minor:      { name: "Minor",           intervals: [0, 2, 3, 5, 7, 8, 10], why: "the natural minor of this root — full 7-note colour, not just the pentatonic subset." },
  majpent:    { name: "Major pentatonic", intervals: [0, 2, 4, 7, 9],       why: "the major scale with the two 'landing wrong' tones (4th, 7th) removed — hard to sound bad." },
  minpent:    { name: "Minor pentatonic", intervals: [0, 3, 5, 7, 10],      why: "the classic rock/blues shape — works over the whole progression, not just this one chord." },
  blues:      { name: "Blues",           intervals: [0, 3, 5, 6, 7, 10],    why: "minor pentatonic plus the b5 'blue note' passing tone." },
  mixolydian: { name: "Mixolydian",      intervals: [0, 2, 4, 5, 7, 9, 10], why: "major scale with a b7 — matches a dominant 7 chord's own b7 exactly." },
  dorian:     { name: "Dorian",          intervals: [0, 2, 3, 5, 7, 9, 10], why: "minor scale with a natural 6th — a common, slightly brighter minor-chord choice." },
};
const AILAB_SCALES_BY_QUALITY = {
  "7":   ["mixolydian", "minpent", "majpent", "blues"],
  "maj": ["major", "majpent"],
  "min": ["minor", "minpent", "dorian"],
  // A power chord (root+5th, no 3rd) doesn't commit to major or minor —
  // rock/metal riffing over one leans minor pentatonic/blues far more
  // often than major, so that's the lead suggestion, with major pentatonic
  // offered as the other real option rather than picking one silently.
  "5":   ["minpent", "blues", "majpent"],
};
// Whole-song mode offers scales for the *key*, not a specific chord — no
// Mixolydian here, since that suggestion is specifically "this matches a
// dominant 7 chord's b7," which doesn't mean anything without one.
const AILAB_SCALES_BY_KEY_MODE = {
  major: ["major", "majpent"],
  minor: ["minor", "minpent", "dorian", "blues"],
};
// Per-chord (Follow) mode's permanently-pinned "always valid" scale: the
// single most universally-safe choice for the whole song's key, not the
// full per-key list above — a pentatonic, not the 7-note scale, since
// that's the classic "works over almost anything in this key" pick for
// rock/blues lead (same reasoning AILAB_SCALES_BY_QUALITY.5 already
// leads with minor pentatonic over a bare power chord).
const AILAB_SAFE_SCALE_BY_KEY_MODE = { major: "majpent", minor: "minpent" };

const AiLab = { mode: "chord", selectedIndex: null, panel: "scales", follow: true };

// V5-B1: Rate My Take — dry-recording state, isolated from Recorder
// (recorder.js)'s regular take pipeline on purpose. A regular take mixes
// the backing track in with the guitar (Recorder.recordBus) so it's
// watchable/listenable as a performance; scoring that against the
// reference guitar stem is comparing the reference to itself-plus-your-
// playing, which trivially inflates and flattens every take's score
// together regardless of how well it was actually played (confirmed: three
// real takes meant to rank tight > variation > sloppy came back within ~1%
// of each other). A "dry" recording taps only the guitar rig's output
// (PA.outputMute), never the backing track, so it's valid input for
// score_take's comparison.
const AiLabDry = {
  bus: null, dest: null, recorder: null, chunks: [],
  state: "idle", startedAt: 0, tickInterval: null,
};

function aiLabSemitones() {
  const tuneEl = transportEls("tune-slider")[0];
  const cents = tuneEl ? parseFloat(tuneEl.value) : 0;
  return Math.trunc(cents / 100);
}

// Same run-collapsing idiom as renderChordLane (app.js): consecutive beats
// sharing a (root, quality) collapse into one region, so a chord held for
// several bars is one clickable chip, not a dozen one-beat slivers.
function aiLabChordRuns() {
  const chords = (State.analysis || {}).chords;
  if (!chords || !chords.length) return [];
  const runs = [];
  chords.forEach((c, i) => {
    const end = i + 1 < chords.length ? chords[i + 1].time : (Audio.duration || c.time);
    const last = runs[runs.length - 1];
    if (last && last.root === c.root && last.quality === c.quality) {
      last.end = end;
    } else {
      runs.push({ time: c.time, end, root: c.root, quality: c.quality, confidence: c.confidence });
    }
  });
  return runs;
}

function aiLabFretboardSVG(rootPc, scaleKeys) {
  const frets = 24, fretW = 27, nutW = 28, stringGap = 20, topPad = 14, leftPad = 34;
  const w = leftPad + nutW + frets * fretW + 10;
  const h = topPad * 2 + stringGap * 5 + 10;
  let s = `<svg class="ailab-fretboard" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`;

  const markerFrets = [3, 5, 7, 9, 15, 17, 19, 21];
  markerFrets.forEach((f) => {
    const x = leftPad + nutW + (f - 0.5) * fretW;
    s += `<circle class="ailab-fret-marker" cx="${x}" cy="${h / 2}" r="4.5"/>`;
  });
  [12, 24].forEach((f) => {
    const x = leftPad + nutW + (f - 0.5) * fretW;
    s += `<circle class="ailab-fret-marker" cx="${x}" cy="${h / 2 - 9}" r="4.5"/><circle class="ailab-fret-marker" cx="${x}" cy="${h / 2 + 9}" r="4.5"/>`;
  });

  for (let f = 0; f <= frets; f++) {
    const x = leftPad + nutW + f * fretW;
    s += `<line class="${f === 0 ? "ailab-fret-line nut" : "ailab-fret-line"}" x1="${x}" y1="${topPad}" x2="${x}" y2="${h - topPad}"/>`;
  }
  markerFrets.concat([12, 24]).forEach((f) => {
    const x = leftPad + nutW + (f - 0.5) * fretW;
    s += `<text class="ailab-fret-num" x="${x}" y="${h - 2}" text-anchor="middle">${f}</text>`;
  });

  for (let i = 0; i < 6; i++) {
    const y = topPad + i * stringGap;
    s += `<line class="ailab-string-line" x1="${leftPad}" y1="${y}" x2="${w - 10}" y2="${y}"/>`;
    s += `<text class="ailab-fret-num" x="${leftPad - 14}" y="${y + 3}" text-anchor="middle">${AILAB_STRING_LABELS[i]}</text>`;
  }

  for (let si = 0; si < 6; si++) {
    const y = topPad + si * stringGap;
    const openPc = AILAB_STRINGS[si];
    for (let f = 0; f <= frets; f++) {
      const pc = (openPc + f) % 12;
      const semi = (pc - rootPc + 12) % 12;
      let hit = false;
      for (const sk of scaleKeys) {
        if (AILAB_SCALES[sk].intervals.includes(semi)) { hit = true; break; }
      }
      if (!hit) continue;
      const x = f === 0 ? leftPad + nutW * 0.5 : leftPad + nutW + (f - 0.5) * fretW;
      const isRoot = semi === 0;
      s += `<circle class="${isRoot ? "ailab-dot-root" : "ailab-dot-scale"}" cx="${x}" cy="${y}" r="7.5"/>`;
      if (isRoot) s += `<text class="ailab-dot-label" x="${x}" y="${y + 2.8}">${KEY_NOTE_NAMES[pc]}</text>`;
    }
  }
  s += `</svg>`;
  return s;
}

function aiLabRootPc(rootName, semitones) {
  const idx = KEY_NOTE_NAMES.indexOf(rootName);
  if (idx < 0) return null;
  return ((idx + semitones) % 12 + 12) % 12;
}

// entries: [{ rootName, rootPc, scaleKey, badge? }] — a flat list rendered
// top to bottom in order, so a caller can pin an "always valid" entry
// (a different root than the rest, e.g. the whole song's key) ahead of a
// chord-specific list without those two ever being the same root/scale.
// Indexed by position (not scaleKey) since the same scale can legitimately
// appear twice (a chord's own suggestion happening to equal the pinned
// whole-song scale further down would collide on a scaleKey-based id).
function aiLabRenderScaleStack(entries) {
  const jumpEl = document.getElementById("ailab-jumprow");
  jumpEl.innerHTML = "";
  const jumpFrag = document.createDocumentFragment();
  entries.forEach((entry, i) => {
    const scale = AILAB_SCALES[entry.scaleKey];
    const btn = document.createElement("button");
    btn.className = "ailab-scale-chip";
    btn.innerHTML = `<span class="ailab-dot"></span>${entry.rootName} ${scale.name}`;
    btn.addEventListener("click", () => {
      const target = document.getElementById(`ailab-block-${i}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    jumpFrag.appendChild(btn);
  });
  jumpEl.appendChild(jumpFrag);

  const stackEl = document.getElementById("ailab-scale-stack");
  stackEl.innerHTML = "";
  const stackFrag = document.createDocumentFragment();
  entries.forEach((entry, i) => {
    const scale = AILAB_SCALES[entry.scaleKey];
    const block = document.createElement("div");
    block.className = "ailab-scale-block";
    block.id = `ailab-block-${i}`;
    block.innerHTML = `
      <div class="ailab-scale-block-head">
        <span class="name">${entry.rootName} ${scale.name}</span>
        ${entry.badge ? `<span class="ailab-scale-badge">${entry.badge}</span>` : ""}
        <span class="why">— ${scale.why}</span>
      </div>
      <div class="ailab-fretboard-wrap">${aiLabFretboardSVG(entry.rootPc, [entry.scaleKey])}</div>
    `;
    stackFrag.appendChild(block);
  });
  stackEl.appendChild(stackFrag);
}

function aiLabRenderRibbon() {
  const ribbon = document.getElementById("ailab-ribbon");
  const runs = aiLabChordRuns();

  if (!runs.length) {
    ribbon.innerHTML = "";
    ribbon.style.display = "none";
    return runs;
  }
  ribbon.style.display = "";

  const now = currentPosition();
  if (AiLab.selectedIndex === null || AiLab.selectedIndex >= runs.length) {
    let idx = runs.findIndex((r) => now >= r.time && now < r.end);
    AiLab.selectedIndex = idx >= 0 ? idx : 0;
  }

  const semitones = aiLabSemitones();
  ribbon.innerHTML = "";
  const frag = document.createDocumentFragment();
  runs.forEach((run, i) => {
    const symbol = chordSymbol(run, semitones);
    const chip = document.createElement("div");
    chip.className = "ailab-chord-chip" + (i === AiLab.selectedIndex ? " selected" : "") + (symbol ? "" : " unknown");
    chip.style.flexGrow = Math.max(0.4, run.end - run.time);
    chip.textContent = symbol || "?";
    chip.title = symbol
      ? `${symbol} (confidence ${run.confidence.toFixed(2)} — assistive, confirm by ear)`
      : "No confident chord read for this section.";
    if (symbol) {
      chip.addEventListener("click", () => {
        AiLab.selectedIndex = i;
        // A click means "I want to study THIS chord" — pin it. Follow (the
        // default) is for watching the stack change as the song plays;
        // the Follow song button turns it back on.
        aiLabSetFollow(false);
        seekTo(run.time);
        renderAiLab();
      });
    }
    frag.appendChild(chip);
  });
  ribbon.appendChild(frag);
  return runs;
}

function aiLabRenderChordMode() {
  document.getElementById("ailab-follow-btn").style.display = "";
  const runs = aiLabRenderRibbon();
  const readoutCard = document.getElementById("ailab-readout-card");
  const emptyHint = document.getElementById("ailab-empty-hint");
  document.getElementById("ailab-scale-heading").textContent = "Scales that fit this chord";

  if (!runs.length) {
    readoutCard.style.display = "none";
    document.getElementById("ailab-jumprow").innerHTML = "";
    document.getElementById("ailab-scale-stack").innerHTML = "";
    emptyHint.textContent = "No chord lane for this track yet — run analysis (or check the Mixer's chord lane is showing anything) before scale suggestions can anchor to a chord.";
    return;
  }
  readoutCard.style.display = "";
  emptyHint.textContent = "";

  const run = runs[AiLab.selectedIndex];
  const semitones = aiLabSemitones();
  const symbol = chordSymbol(run, semitones);
  const key = (State.analysis || {}).key;

  document.getElementById("ailab-chordname").textContent = symbol || "?";
  document.getElementById("ailab-keyname").textContent = key
    ? `Song key: ${transposedKeyName(key.key, semitones) || key.key} ${key.mode} · confidence ${run.confidence.toFixed(2)}`
    : `confidence ${run.confidence.toFixed(2)}`;

  if (!symbol) {
    document.getElementById("ailab-jumprow").innerHTML = "";
    document.getElementById("ailab-scale-stack").innerHTML = "";
    emptyHint.textContent = "No confident chord read for this section — pick another chip, or try Whole song instead.";
    return;
  }

  const rootName = transposedKeyName(run.root, semitones) || run.root;
  const rootPc = aiLabRootPc(run.root, semitones);
  const scaleList = AILAB_SCALES_BY_QUALITY[run.quality] || AILAB_SCALES_BY_QUALITY.maj;
  const chordEntries = scaleList.map((k) => ({ rootName, rootPc, scaleKey: k }));

  // The whole song's key scale stays valid basically everywhere (bar a
  // real key change or an unusually harmonically complex bridge) — pin it
  // to the top, permanently, ahead of whichever chord is currently
  // selected, rather than making it something you'd only see in Whole
  // song mode. If it's literally the same (root, scale) as the chord's
  // own top suggestion, badge that entry instead of showing it twice.
  const songKey = key && AILAB_SAFE_SCALE_BY_KEY_MODE[key.mode];
  let entries = chordEntries;
  if (songKey) {
    const songRootName = transposedKeyName(key.key, semitones) || key.key;
    const songRootPc = aiLabRootPc(key.key, semitones);
    const first = chordEntries[0];
    if (first && first.rootPc === songRootPc && first.scaleKey === songKey) {
      first.badge = "Whole song";
      entries = chordEntries;
    } else {
      entries = [{ rootName: songRootName, rootPc: songRootPc, scaleKey: songKey, badge: "Whole song" }, ...chordEntries];
    }
  }
  aiLabRenderScaleStack(entries);
}

function aiLabRenderSongMode() {
  // One key for the whole song — nothing position-dependent to follow.
  document.getElementById("ailab-follow-btn").style.display = "none";
  aiLabRenderRibbon(); // ribbon still shown/seekable, just not driving the stack
  document.getElementById("ailab-readout-card").style.display = "none";
  document.getElementById("ailab-scale-heading").textContent = "Scales for the whole song";
  const emptyHint = document.getElementById("ailab-empty-hint");

  const key = (State.analysis || {}).key;
  if (!key) {
    document.getElementById("ailab-jumprow").innerHTML = "";
    document.getElementById("ailab-scale-stack").innerHTML = "";
    emptyHint.textContent = "No confident key detected for this song.";
    return;
  }
  emptyHint.textContent = "One key for the whole song, today — mid-song key-change detection (e.g. a modulation into a final chorus) is backlog, not built yet (release-v5-spec.md §2a/§9).";

  const semitones = aiLabSemitones();
  const rootName = transposedKeyName(key.key, semitones) || key.key;
  const rootPc = aiLabRootPc(key.key, semitones);
  const scaleList = AILAB_SCALES_BY_KEY_MODE[key.mode] || AILAB_SCALES_BY_KEY_MODE.major;
  aiLabRenderScaleStack(scaleList.map((k) => ({ rootName, rootPc, scaleKey: k })));
}

function renderAiLab() {
  if (!document.getElementById("ailab-overlay").classList.contains("show")) return;
  if (AiLab.panel !== "scales") return;
  if (AiLab.mode === "chord") aiLabRenderChordMode();
  else aiLabRenderSongMode();
}

// Called from the same places app.js re-renders the chord lane (analysis
// load, track switch, Tune slider move) so AI Lab stays in sync without
// needing its own copy of those hooks.
function refreshAiLabIfOpen() {
  renderAiLab();
}

// --- Follow mode: the scale stack tracks the playhead (chord-detection-v2
// spec §6). Position-based, not playing-based, so scrubbing the timeline
// while paused follows too. Throttled well below tick()'s frame rate
// because a re-render rebuilds the ribbon + stack innerHTML — chord runs
// change every few seconds, so 4 Hz is already generous.
let aiLabFollowLastCheck = 0;

function aiLabSetFollow(on) {
  AiLab.follow = on;
  const btn = document.getElementById("ailab-follow-btn");
  if (btn) btn.classList.toggle("active", on);
}

function aiLabFollowTick(pos) {
  if (!AiLab.follow || AiLab.panel !== "scales" || AiLab.mode !== "chord") return;
  if (!document.getElementById("ailab-overlay").classList.contains("show")) return;
  const now = performance.now();
  if (now - aiLabFollowLastCheck < 250) return;
  aiLabFollowLastCheck = now;
  const runs = aiLabChordRuns();
  if (!runs.length) return;
  let idx = -1;
  for (let i = 0; i < runs.length; i++) {
    if (pos >= runs[i].time && pos < runs[i].end) { idx = i; break; }
  }
  if (idx >= 0 && idx !== AiLab.selectedIndex) {
    AiLab.selectedIndex = idx;
    renderAiLab();
  }
}

function openAiLab() {
  document.getElementById("ailab-overlay").classList.add("show");
  document.getElementById("tonelab-overlay").classList.remove("show");
  document.getElementById("playalong-overlay").classList.remove("show");
  paSetActiveScreen("ailab-open-btn");
  AiLab.selectedIndex = null; // re-pick the chord under the playhead on open
  aiLabSetFollow(true); // pinning is per-visit — a fresh open follows the song again
  if (AiLab.panel === "scales") renderAiLab();
  else if (AiLab.panel === "ratemytake") aiLabRmtOpen();
  else aiLabLickOpen();
}

function closeAiLab() {
  document.getElementById("ailab-overlay").classList.remove("show");
}

function aiLabSwitchPanel(panel) {
  AiLab.panel = panel;
  document.getElementById("ailab-scales-panel").style.display = panel === "scales" ? "" : "none";
  document.getElementById("ailab-ratemytake-panel").style.display = panel === "ratemytake" ? "" : "none";
  document.getElementById("ailab-lickideas-panel").style.display = panel === "lickideas" ? "" : "none";
  document.querySelectorAll(".ailab-tab-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.panel === panel);
  });
  if (panel === "scales") renderAiLab();
  else if (panel === "ratemytake") aiLabRmtOpen();
  else aiLabLickOpen();
}

// ---------------------------------------------------------------------------
// Rate My Take
// ---------------------------------------------------------------------------

async function aiLabRmtOpen() {
  await paEnsureRigSessionReady(); // playalong.js — need PA.outputMute to exist for the dry-record tap
  await aiLabRmtRefreshTakes();
}

async function aiLabRmtRefreshTakes() {
  const listEl = document.getElementById("ailab-rmt-takes-list");
  const selectEl = document.getElementById("ailab-rmt-take-select");
  if (!State.track) {
    listEl.innerHTML = "<p class=\"hint\">No song selected.</p>";
    selectEl.innerHTML = "";
    return;
  }
  let takes = [];
  try {
    const r = await Api.get(`/api/recordings?track=${encodeURIComponent(State.track)}`);
    takes = (r.takes || []).filter((t) => t.dry);
  } catch (e) {
    listEl.innerHTML = `<p class="hint">Couldn't load takes: ${e.message}</p>`;
    return;
  }

  if (!takes.length) {
    listEl.innerHTML = "<p class=\"hint\">No dry takes yet for this song — record one below.</p>";
    selectEl.innerHTML = "";
    return;
  }

  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  takes.forEach((t) => {
    const row = document.createElement("div");
    row.className = "ailab-rmt-take-row";
    row.innerHTML = `
      <span class="name">${t.filename}</span>
      <span class="ailab-rmt-take-row-right">
        <span class="size">${(t.size / 1024 / 1024).toFixed(1)} MB</span>
        <button class="ailab-rmt-rename-btn" title="Rename">✎</button>
      </span>
    `;
    row.querySelector(".ailab-rmt-rename-btn").addEventListener("click", () => aiLabRmtRenameTake(t));
    frag.appendChild(row);
  });
  listEl.appendChild(frag);

  const prevValue = selectEl.value;
  selectEl.innerHTML = "";
  takes.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.path;
    opt.textContent = t.filename;
    selectEl.appendChild(opt);
  });
  if (takes.some((t) => t.path === prevValue)) selectEl.value = prevValue;
  else selectEl.selectedIndex = takes.length - 1; // default to the most recent
}

// Same prompt-based rename idiom as Play Along's Takes tab
// (recorder.js) — reuses the same /api/recording/rename endpoint; the
// server carries the "dry" flag over to the new filename (see
// svc_recording_rename), so a renamed dry take doesn't drop out of this
// list the moment it stops matching "... - dry NN".
async function aiLabRmtRenameTake(take) {
  const base = take.filename.replace(/\.[^.]+$/, "");
  const newName = prompt("Rename take to:", base);
  if (!newName || newName === base) return;
  try {
    await Api.post("/api/recording/rename", { path: take.path, new_name: newName });
    await aiLabRmtRefreshTakes();
  } catch (e) {
    alert("Rename failed: " + e.message);
  }
}

function aiLabDryEnsureBus() {
  ensureCtx();
  if (!AiLabDry.bus) AiLabDry.bus = Audio.ctx.createGain();
  if (typeof PA !== "undefined" && PA.outputMute) PA.outputMute.connect(AiLabDry.bus);
  if (!AiLabDry.dest) {
    AiLabDry.dest = Audio.ctx.createMediaStreamDestination();
    AiLabDry.bus.connect(AiLabDry.dest);
  }
}

const AILAB_DRY_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
];
function aiLabDryPickMimeType() {
  return AILAB_DRY_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

function aiLabDryTick() {
  if (AiLabDry.state !== "recording") return;
  const elapsed = (performance.now() - AiLabDry.startedAt) / 1000;
  const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
  document.getElementById("ailab-rmt-elapsed").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function aiLabRmtUpdateRecordUI() {
  const recording = AiLabDry.state === "recording";
  document.getElementById("ailab-rmt-record-btn").style.display = recording ? "none" : "";
  document.getElementById("ailab-rmt-stop-btn").style.display = recording ? "" : "none";
}

async function aiLabStartDryRecording() {
  const hintEl = document.getElementById("ailab-rmt-record-hint");
  await paEnsureRigSessionReady();
  aiLabDryEnsureBus();
  const mimeType = aiLabDryPickMimeType();
  if (!mimeType) {
    hintEl.textContent = "This browser can't record audio (no supported MediaRecorder format).";
    return;
  }
  const chunks = [];
  const recorder = new MediaRecorder(AiLabDry.dest.stream, { mimeType, audioBitsPerSecond: 192_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onerror = (e) => {
    console.error("Dry recorder error", e.error);
    hintEl.textContent = "Recorder error — stopped early, salvaging what was captured.";
    aiLabStopDryRecording();
  };
  recorder.onstop = () => aiLabFinalizeDryRecording(chunks, mimeType);
  AiLabDry.recorder = recorder;
  AiLabDry.chunks = chunks;
  AiLabDry.state = "recording";
  AiLabDry.startedAt = performance.now();
  recorder.start(1000);
  hintEl.textContent = "Recording — guitar only, backing track is not being captured.";
  aiLabRmtUpdateRecordUI();
  aiLabDryTick();
  AiLabDry.tickInterval = setInterval(aiLabDryTick, 250);
}

function aiLabStopDryRecording() {
  if (!AiLabDry.recorder || AiLabDry.recorder.state === "inactive") return;
  AiLabDry.recorder.stop();
  AiLabDry.state = "saving";
  if (AiLabDry.tickInterval) { clearInterval(AiLabDry.tickInterval); AiLabDry.tickInterval = null; }
  aiLabRmtUpdateRecordUI();
}

async function aiLabFinalizeDryRecording(chunks, mimeType) {
  const hintEl = document.getElementById("ailab-rmt-record-hint");
  const blob = new Blob(chunks, { type: mimeType });
  const ext = mimeType.includes("mp4") ? "m4a" : "webm";
  hintEl.textContent = "Saving dry take…";
  try {
    const r = await Api.postRaw(
      `/api/recording/save?track=${encodeURIComponent(State.track || "")}&ext=${ext}&prefix=dry`, blob);
    hintEl.textContent = `Saved as ${r.filename}.`;
    await aiLabRmtRefreshTakes();
  } catch (e) {
    hintEl.textContent = `Save failed: ${e.message}`;
  } finally {
    AiLabDry.state = "idle";
    aiLabRmtUpdateRecordUI();
  }
}

function aiLabRmtOverallClass(pct) {
  if (pct === null || pct === undefined) return "";
  if (pct >= 70) return "good";
  if (pct >= 40) return "mid";
  return "low";
}

async function aiLabScoreTake() {
  const hintEl = document.getElementById("ailab-rmt-score-hint");
  const resultCard = document.getElementById("ailab-rmt-result-card");
  const takePath = document.getElementById("ailab-rmt-take-select").value;
  if (!takePath) {
    hintEl.textContent = "No dry take selected — record one above first.";
    return;
  }
  const offset = parseFloat(document.getElementById("ailab-rmt-offset").value) || 0;
  const offsetSearch = parseFloat(document.getElementById("ailab-rmt-offset-search").value) || 0;

  hintEl.textContent = "Scoring…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/rate/score", {
      source_path: State.track, take_path: takePath,
      model: State.model, stem: "guitar",
      offset, offset_search: offsetSearch,
    });
    let msg = `Scored ${r.scored_count}/${r.total_count} beats.`;
    if (r.refine) {
      msg += r.refine.applied
        ? ` Offset auto-refined ${offset}s -> ${r.refine.offset}s (match quality ${r.refine.quality}).`
        : ` Offset auto-refine found ${r.refine.offset}s but match quality (${r.refine.quality}) was too low to trust — used ${offset}s as given.`;
    }
    hintEl.textContent = msg;

    const overallEl = document.getElementById("ailab-rmt-overall");
    overallEl.textContent = r.overall_pct !== null ? `Overall: ${r.overall_pct}%` : "Overall: --";
    overallEl.className = "ailab-rmt-overall " + aiLabRmtOverallClass(r.overall_pct);
    // Raw 0-1 pitch/timing components, not run through the 0-100
    // calibration stretch — deliberately shown alongside the overall
    // number so a surprising score can be traced to one side of the 60/40
    // blend specifically, instead of guessing.
    const breakdownEl = document.getElementById("ailab-rmt-breakdown");
    breakdownEl.textContent = (r.overall_pitch !== null && r.overall_timing !== null)
      ? `Pitch agreement: ${(r.overall_pitch * 100).toFixed(0)}%  ·  Timing agreement: ${(r.overall_timing * 100).toFixed(0)}%`
      : "";
    document.getElementById("ailab-rmt-heatmap-img").src =
      `/api/output?path=${encodeURIComponent(r.heatmap_path)}&t=${Date.now()}`;
    resultCard.style.display = "";
  } catch (e) {
    hintEl.textContent = `Scoring failed: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Lick Ideas (V5-R1) — the Lick/Phrasing Assistant research spike, run from
// AI Lab instead of CLI-only so real songs are actually easy to try. The
// only feature in this app that makes a network call — opt-in, key-only,
// text-only (release-v5-spec.md §7).
// ---------------------------------------------------------------------------

async function aiLabLickOpen() {
  await aiLabLickRefreshKeyStatus();
}

async function aiLabLickRefreshKeyStatus() {
  const statusEl = document.getElementById("ailab-lick-key-status");
  try {
    const r = await Api.get("/api/settings");
    statusEl.textContent = r.has_anthropic_key
      ? "Key saved."
      : "No key saved yet — get one at console.anthropic.com and paste it above.";
  } catch (e) {
    statusEl.textContent = `Couldn't check key status: ${e.message}`;
  }
}

async function aiLabLickSaveKey() {
  const input = document.getElementById("ailab-lick-apikey");
  const statusEl = document.getElementById("ailab-lick-key-status");
  try {
    const r = await Api.post("/api/settings/anthropic_key", { api_key: input.value });
    input.value = ""; // never leave a saved secret sitting in a visible (even password-masked) input
    statusEl.textContent = r.has_anthropic_key ? "Key saved." : "Key cleared.";
  } catch (e) {
    statusEl.textContent = `Couldn't save key: ${e.message}`;
  }
}

async function aiLabLickSuggest() {
  const hintEl = document.getElementById("ailab-lick-hint");
  const resultCard = document.getElementById("ailab-lick-result-card");
  const btn = document.getElementById("ailab-lick-suggest-btn");
  if (!State.track) {
    hintEl.textContent = "No song selected.";
    return;
  }
  const genre = document.getElementById("ailab-lick-genre").value;

  btn.disabled = true;
  hintEl.textContent = "Asking Claude for phrasing ideas…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/lick/suggest", {
      source_path: State.track, model: State.model, genre,
    });
    hintEl.textContent = "";
    document.getElementById("ailab-lick-context").textContent = `${r.key} · ${r.bpm} BPM · ${r.progression}`;
    document.getElementById("ailab-lick-suggestion").textContent = r.suggestion;
    resultCard.style.display = "";
  } catch (e) {
    hintEl.textContent = `Couldn't get suggestions: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function wireAiLab() {
  document.getElementById("ailab-open-btn").addEventListener("click", openAiLab);
  document.getElementById("ailab-close-btn").addEventListener("click", closeAiLab);

  document.querySelectorAll(".ailab-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => aiLabSwitchPanel(btn.dataset.panel));
  });

  document.getElementById("ailab-mode-toggle").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("on")) return;
      document.getElementById("ailab-mode-toggle").querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      AiLab.mode = btn.dataset.mode;
      renderAiLab();
    });
  });

  document.getElementById("ailab-follow-btn").addEventListener("click", () => {
    const on = !AiLab.follow;
    aiLabSetFollow(on);
    if (on) {
      // Snap straight to the chord under the playhead rather than waiting
      // for the next run boundary to drift past.
      AiLab.selectedIndex = null;
      renderAiLab();
    }
  });

  document.getElementById("ailab-rmt-record-btn").addEventListener("click", aiLabStartDryRecording);
  document.getElementById("ailab-rmt-stop-btn").addEventListener("click", aiLabStopDryRecording);
  document.getElementById("ailab-rmt-score-btn").addEventListener("click", aiLabScoreTake);
  // The whole point of this screen's Backing Track card: find the actual
  // spot the take starts (scrub the timeline, or just play up to it) and
  // drop it straight into Offset, instead of typing seconds by eye/ear.
  document.getElementById("ailab-rmt-use-position-btn").addEventListener("click", () => {
    document.getElementById("ailab-rmt-offset").value = currentPosition().toFixed(2);
  });

  document.getElementById("ailab-lick-savekey-btn").addEventListener("click", aiLabLickSaveKey);
  document.getElementById("ailab-lick-suggest-btn").addEventListener("click", aiLabLickSuggest);
}

wireAiLab();
