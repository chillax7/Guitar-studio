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
};
// Whole-song mode offers scales for the *key*, not a specific chord — no
// Mixolydian here, since that suggestion is specifically "this matches a
// dominant 7 chord's b7," which doesn't mean anything without one.
const AILAB_SCALES_BY_KEY_MODE = {
  major: ["major", "majpent"],
  minor: ["minor", "minpent", "dorian", "blues"],
};

const AiLab = { mode: "chord", selectedIndex: null, panel: "scales" };

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

function aiLabRenderScaleStack(rootName, rootPc, scaleList) {
  const jumpEl = document.getElementById("ailab-jumprow");
  jumpEl.innerHTML = "";
  const jumpFrag = document.createDocumentFragment();
  scaleList.forEach((k) => {
    const btn = document.createElement("button");
    btn.className = "ailab-scale-chip";
    btn.innerHTML = `<span class="ailab-dot"></span>${AILAB_SCALES[k].name}`;
    btn.addEventListener("click", () => {
      const target = document.getElementById(`ailab-block-${k}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    jumpFrag.appendChild(btn);
  });
  jumpEl.appendChild(jumpFrag);

  const stackEl = document.getElementById("ailab-scale-stack");
  stackEl.innerHTML = "";
  const stackFrag = document.createDocumentFragment();
  scaleList.forEach((k) => {
    const scale = AILAB_SCALES[k];
    const block = document.createElement("div");
    block.className = "ailab-scale-block";
    block.id = `ailab-block-${k}`;
    block.innerHTML = `
      <div class="ailab-scale-block-head">
        <span class="name">${rootName} ${scale.name}</span>
        <span class="why">— ${scale.why}</span>
      </div>
      <div class="ailab-fretboard-wrap">${aiLabFretboardSVG(rootPc, [k])}</div>
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
  aiLabRenderScaleStack(rootName, rootPc, scaleList);
}

function aiLabRenderSongMode() {
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
  aiLabRenderScaleStack(rootName, rootPc, scaleList);
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

function openAiLab() {
  document.getElementById("ailab-overlay").classList.add("show");
  document.getElementById("tonelab-overlay").classList.remove("show");
  document.getElementById("playalong-overlay").classList.remove("show");
  paSetActiveScreen("ailab-open-btn");
  AiLab.selectedIndex = null; // re-pick the chord under the playhead on open
  if (AiLab.panel === "scales") renderAiLab();
  else aiLabRmtOpen();
}

function closeAiLab() {
  document.getElementById("ailab-overlay").classList.remove("show");
}

function aiLabSwitchPanel(panel) {
  AiLab.panel = panel;
  document.getElementById("ailab-scales-panel").style.display = panel === "scales" ? "" : "none";
  document.getElementById("ailab-ratemytake-panel").style.display = panel === "ratemytake" ? "" : "none";
  document.querySelectorAll(".ailab-tab-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.panel === panel);
  });
  if (panel === "scales") renderAiLab();
  else aiLabRmtOpen();
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
    row.innerHTML = `<span class="name">${t.filename}</span><span class="size">${(t.size / 1024 / 1024).toFixed(1)} MB</span>`;
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
    document.getElementById("ailab-rmt-heatmap-img").src =
      `/api/output?path=${encodeURIComponent(r.heatmap_path)}&t=${Date.now()}`;
    resultCard.style.display = "";
  } catch (e) {
    hintEl.textContent = `Scoring failed: ${e.message}`;
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

  document.getElementById("ailab-rmt-record-btn").addEventListener("click", aiLabStartDryRecording);
  document.getElementById("ailab-rmt-stop-btn").addEventListener("click", aiLabStopDryRecording);
  document.getElementById("ailab-rmt-score-btn").addEventListener("click", aiLabScoreTake);
}

wireAiLab();
