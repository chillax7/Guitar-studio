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

const AiLab = { mode: "chord", selectedIndex: null, panel: "scales", follow: true, amode: "lickideas" };

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
  // Real user report: correcting the key on the Mixer (§ correctKey, app.js)
  // left the Scales tab still suggesting scales for the OLD detected key —
  // same "prefer the manual override, fall back to the raw detection" rule
  // updateKeyHint() already uses, mirrored here so the two never disagree.
  const key = State.keyOverride || (State.analysis || {}).key;

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

  // Same override-first rule as aiLabRenderChordMode/updateKeyHint above.
  const key = State.keyOverride || (State.analysis || {}).key;
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

// SS-4 follow-the-song: highlights the part the playhead is currently in,
// same self-throttled idiom as aiLabFollowTick above. Simpler than the
// Scales-tab version — there's no "click to pin, follow to resume" toggle
// here (nothing to override; a part just IS whichever one the playhead is
// in), so this always runs while Song Structure mode is open, no separate
// Follow button. Toggles a class on the existing row via its data-start/
// data-end attributes rather than a full re-render every tick.
let aiLabSSFollowLastCheck = 0;
function aiLabSSFollowTick(pos) {
  if (AiLab.amode !== "songstructure") return;
  if (!document.getElementById("ailab-overlay").classList.contains("show")) return;
  const partsEl = document.getElementById("ailab-ss-parts");
  if (!partsEl) return;
  const now = performance.now();
  if (now - aiLabSSFollowLastCheck < 250) return;
  aiLabSSFollowLastCheck = now;
  const rows = partsEl.querySelectorAll(".ss-part");
  rows.forEach((row) => {
    const isCurrent = pos >= parseFloat(row.dataset.start) && pos < parseFloat(row.dataset.end);
    row.classList.toggle("current", isCurrent);
  });
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

// SS-1/SS-2 (ai-lab-song-structure-spec.md): the part-by-part map. The
// backbone is all DETECTED (sections/chords/key/stems). SS-2 layers an
// optional LLM annotation over it — part names, guitar role, technique,
// difficulty, signature flag, learning order — clearly the assistive layer,
// grounded on the detected sections it may only annotate by index (never
// invent). Jump/Loop hand the user back to the Mixer at that part.
const AiLabSS = { data: null };

async function aiLabRenderSongStructure() {
  const partsEl = document.getElementById("ailab-ss-parts");
  const emptyEl = document.getElementById("ailab-ss-empty");
  const songLine = document.getElementById("ailab-ss-song-line");
  const annoBtn = document.getElementById("ailab-ss-annotate-btn");
  if (!partsEl) return;
  // wire the "Name the parts with AI" button once
  if (annoBtn && !annoBtn.dataset.wired) {
    annoBtn.dataset.wired = "1";
    annoBtn.addEventListener("click", aiLabSSAnnotate);
  }
  partsEl.innerHTML = "";
  emptyEl.style.display = "none";
  AiLabSS.data = null;
  aiLabSSToggleControls(false);
  document.getElementById("ailab-ss-song-annotation").style.display = "none";
  document.getElementById("ailab-ss-annotate-hint").textContent = "";
  if (!State.track) {
    songLine.textContent = "";
    emptyEl.textContent = "Load a separated song first — Song Structure maps the parts of its stems.";
    emptyEl.style.display = "";
    return;
  }
  songLine.textContent = "Reading the song's structure…";
  let data;
  try {
    data = await Api.post("/api/song_structure", { source_path: State.track, model: State.model });
  } catch (e) {
    songLine.textContent = "";
    emptyEl.textContent = "Couldn't build song structure: " + e.message;
    emptyEl.style.display = "";
    return;
  }
  if (!data || !data.parts || !data.parts.length) {
    songLine.textContent = "";
    emptyEl.textContent = "No clear structure was detected for this track — it may be very short or one unbroken texture.";
    emptyEl.style.display = "";
    return;
  }
  AiLabSS.data = data;                 // includes any cached annotation
  aiLabSSToggleControls(true);
  aiLabSSRenderParts();
}

function aiLabSSToggleControls(show) {
  document.getElementById("ailab-ss-annotate-btn").style.display = show ? "" : "none";
}

// Renders parts from AiLabSS.data, overlaying AiLabSS.data.annotation if set.
function aiLabSSRenderParts() {
  const data = AiLabSS.data;
  if (!data) return;
  const parts = data.parts;
  const ann = data.annotation || null;
  const annByIndex = {};
  if (ann && Array.isArray(ann.parts)) ann.parts.forEach((a) => { annByIndex[a.index] = a; });

  const songKey = data.song && data.song.key;
  const keyStr = songKey ? `${songKey.key} ${songKey.mode}` : "key —";
  const tempoStr = data.song && data.song.tempo ? `${Math.round(data.song.tempo)} BPM` : "";
  document.getElementById("ailab-ss-song-line").textContent =
    `${keyStr}${tempoStr ? " · " + tempoStr : ""} · ${parts.length} parts`;
  document.getElementById("ailab-ss-annotate-btn").textContent =
    ann ? "✨ Re-name the parts with AI" : "✨ Name the parts with AI";

  aiLabSSRenderSongAnnotation(ann, annByIndex, parts);

  const clock = (t) => (typeof fmtClock === "function")
    ? fmtClock(t)
    : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const swatch = (label) => (typeof sectionColor === "function") ? sectionColor(label || "A") : "#4a90d9";

  const partsEl = document.getElementById("ailab-ss-parts");
  partsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  parts.forEach((p) => {
    const a = annByIndex[p.index];
    const color = swatch(p.label);
    const row = document.createElement("div");
    row.className = "ss-part";
    row.style.borderLeft = `4px solid ${color}`;
    // SS-4 follow-the-song: lets aiLabSSFollowTick find/highlight this row by
    // part start/end without needing a full re-render every tick.
    row.dataset.start = p.start;
    row.dataset.end = p.end;

    // head: [colour letter] + (AI name) + time/bars + difficulty + signature
    const head = document.createElement("div");
    head.className = "ss-part-head";
    const badge = document.createElement("span");
    badge.className = "ss-part-label";
    badge.style.background = color;
    badge.textContent = p.label || "?";
    head.appendChild(badge);
    if (a && a.name) {
      const name = document.createElement("span");
      name.className = "ss-part-name";
      name.textContent = a.name;
      head.appendChild(name);
      if (a.signature) {
        const sig = document.createElement("span");
        sig.className = "ss-part-sig";
        sig.title = "Signature part — the iconic bit";
        sig.textContent = "★";
        head.appendChild(sig);
      }
    }
    const time = document.createElement("span");
    time.className = "ss-part-time";
    time.textContent = `${clock(p.start)}–${clock(p.end)} · ${p.bars ? p.bars + " bars" : p.beats + " beats"}`;
    head.appendChild(time);
    if (a && a.difficulty) {
      const diff = document.createElement("span");
      diff.className = "ss-diff ss-diff-" + String(a.difficulty).toLowerCase();
      diff.textContent = a.difficulty;
      head.appendChild(diff);
    }
    row.appendChild(head);

    // AI role/technique line
    if (a && (a.guitar_role || a.technique)) {
      const role = document.createElement("div");
      role.className = "ss-part-role";
      role.textContent = "🎸 " + [a.guitar_role, a.technique].filter(Boolean).join(" · ");
      row.appendChild(role);
    }

    // per-part key if it differs from the song key
    if (p.key && songKey && (p.key.key !== songKey.key || p.key.mode !== songKey.mode)) {
      const kd = document.createElement("div");
      kd.className = "ss-part-key";
      kd.textContent = `↳ this part centres on ${p.key.key} ${p.key.mode}`;
      row.appendChild(kd);
    }

    // chords + roman
    const ch = document.createElement("div");
    ch.className = "ss-part-chords";
    if (p.progression) {
      const letters = document.createElement("span");
      letters.className = "ss-chords-letters";
      letters.textContent = p.progression;
      ch.appendChild(letters);
      if (p.progression_roman) {
        const roman = document.createElement("span");
        roman.className = "ss-chords-roman";
        roman.textContent = p.progression_roman;
        ch.appendChild(roman);
      }
    } else {
      const none = document.createElement("span");
      none.className = "ss-chords-none";
      none.textContent = "No chords detected for this part";
      ch.appendChild(none);
    }
    row.appendChild(ch);

    // dynamics
    const dyn = document.createElement("div");
    dyn.className = "ss-part-dyn";
    const stems = (p.dynamics && p.dynamics.active_stems) || [];
    const loud = p.dynamics && p.dynamics.loudness;
    dyn.textContent = (stems.length ? stems.join(" · ") : "—") + (loud && loud !== "—" ? `  ·  ${loud}` : "");
    row.appendChild(dyn);

    // AI variation note on a repeat
    if (a && a.variation) {
      const varEl = document.createElement("div");
      varEl.className = "ss-part-variation";
      varEl.textContent = "↺ " + a.variation;
      row.appendChild(varEl);
    }

    const acts = document.createElement("div");
    acts.className = "ss-part-actions";
    const jump = document.createElement("button");
    jump.textContent = "▶ Jump here";
    jump.addEventListener("click", () => aiLabGoToSection(p.start));
    const loop = document.createElement("button");
    loop.textContent = "⟳ Loop this part";
    loop.addEventListener("click", () => aiLabLoopSection(p.start, p.end));
    const practise = document.createElement("button");
    practise.textContent = "🎯 Practise this part";
    practise.title = "Loop this part AND drop to Speed Trainer's Start speed — one click into the loop + slow-it-down tools";
    practise.addEventListener("click", () => aiLabPractiseSection(p.start, p.end));
    acts.appendChild(jump);
    acts.appendChild(loop);
    acts.appendChild(practise);
    row.appendChild(acts);

    frag.appendChild(row);
  });
  partsEl.appendChild(frag);
}

// Song-level AI annotation: form, tuning/capo, learning order, notes.
function aiLabSSRenderSongAnnotation(ann, annByIndex, parts) {
  const box = document.getElementById("ailab-ss-song-annotation");
  box.innerHTML = "";
  if (!ann || !ann.song) { box.style.display = "none"; return; }
  const s = ann.song;
  const add = (cls, text) => {
    if (!text) return;
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    box.appendChild(d);
  };
  add("ss-song-form", s.form || "");
  const setup = [s.tuning ? `Tuning: ${s.tuning}` : "", s.capo && String(s.capo).toLowerCase() !== "none" ? `Capo: ${s.capo}` : ""]
    .filter(Boolean).join("  ·  ");
  add("ss-song-setup", setup);
  if (Array.isArray(s.learning_order) && s.learning_order.length) {
    const names = s.learning_order.map((i) => {
      const a = annByIndex[i];
      const p = parts.find((x) => x.index === i);
      return (a && a.name) || (p && p.label) || `#${i}`;
    });
    add("ss-song-order", "Suggested learning order: " + names.join(" → "));
  }
  add("ss-song-notes", s.notes || "");
  box.style.display = box.children.length ? "" : "none";
}

async function aiLabSSAnnotate() {
  const btn = document.getElementById("ailab-ss-annotate-btn");
  const hint = document.getElementById("ailab-ss-annotate-hint");
  if (!State.track || !AiLabSS.data) return;
  btn.disabled = true;
  btn.classList.add("running");
  hint.textContent = "Analysing the parts…";
  try {
    const provider = (typeof aiLabLickCurrentProvider === "function") ? aiLabLickCurrentProvider() : "anthropic";
    const r = await Api.post("/api/song_structure/annotate", {
      source_path: State.track, model: State.model, provider,
    });
    AiLabSS.data.annotation = r.annotation;
    hint.textContent = "";
    aiLabSSRenderParts();
  } catch (e) {
    hint.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove("running");
  }
}

// Jump / Loop drop you back on the Mixer at that part — the payoff of the map
// is one click into the loop + Speed Trainer tools already built.
function aiLabGoToSection(start) {
  if (typeof seekTo === "function") seekTo(start);
  closeAiLab();
}
function aiLabLoopSection(start, end) {
  if (!Audio.duration) return;
  State.ui.loop = { start, end };
  State.ui.loopEnabled = true;
  if (typeof toggleTransportClass === "function") toggleTransportClass("loop-toggle-btn", "active", true);
  if (typeof updateLoopVisual === "function") updateLoopVisual();
  if (typeof seekTo === "function") seekTo(start);
  if (typeof saveProjectDebounced === "function") saveProjectDebounced();
  closeAiLab();
}

// SS-4: "Practise this part" — everything Loop does, PLUS drops straight
// into the Speed Trainer's own practice speed, so a part you want to drill
// is one click from being both looped AND slowed down, instead of two
// separate trips (loop it here, then go set Speed Trainer's Start yourself).
// Reuses Speed Trainer's own Start % field/mechanism (setSpeedFromPercent,
// app.js) rather than inventing a separate speed control.
function aiLabPractiseSection(start, end) {
  aiLabLoopSection(start, end);
  const startPctEl = document.getElementById("trainer-start-pct");
  if (startPctEl && typeof setSpeedFromPercent === "function") {
    const startPct = parseFloat(startPctEl.value) || 100;
    setSpeedFromPercent(startPct);
    const statusEl = document.getElementById("trainer-status");
    if (statusEl) {
      statusEl.textContent = `Speed set to ${startPct}% for this part — Step up (Speed Trainer, inspector) once it's clean.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Rate My Take
// ---------------------------------------------------------------------------

let AiLabRmtTakesCache = []; // last-fetched takes list, so take-select's
// "change" handler can look up a cached rating (see svc_recordings_list's
// "rating" field) without a round trip just to display what's already
// there.

async function aiLabRmtOpen() {
  await paEnsureRigSessionReady(); // playalong.js — need PA.outputMute to exist for the dry-record tap
  await aiLabRmtRefreshTakes();
}

// Every early-return path below (no track, fetch failed, no dry takes)
// used to leave the result card exactly as it was — including a previous
// song's rated take, shown with zero indication it belongs to a track
// that isn't even loaded anymore. Real user report: switch from a rated
// "Empty Rooms" take to a song with no takes yet, and its "good" result
// (and offset) just kept sitting there. Centralized so every early return
// clears the same way, instead of three copies that could drift.
function aiLabRmtResetResultDisplay() {
  document.getElementById("ailab-rmt-result-card").style.display = "none";
  document.getElementById("ailab-rmt-offset").value = 0;
  document.getElementById("ailab-rmt-score-hint").textContent = "";
}

async function aiLabRmtRefreshTakes() {
  const listEl = document.getElementById("ailab-rmt-takes-list");
  const selectEl = document.getElementById("ailab-rmt-take-select");
  const playerEl = document.getElementById("ailab-rmt-take-player");
  if (!State.track) {
    listEl.innerHTML = "<p class=\"hint\">No song selected.</p>";
    selectEl.innerHTML = "";
    playerEl.style.display = "none";
    AiLabRmtTakesCache = [];
    aiLabRmtResetResultDisplay();
    return;
  }
  let takes = [];
  try {
    const r = await Api.get(`/api/recordings?track=${encodeURIComponent(State.track)}`);
    takes = (r.takes || []).filter((t) => t.dry);
  } catch (e) {
    listEl.innerHTML = `<p class="hint">Couldn't load takes: ${e.message}</p>`;
    aiLabRmtResetResultDisplay();
    return;
  }
  AiLabRmtTakesCache = takes;

  if (!takes.length) {
    listEl.innerHTML = "<p class=\"hint\">No dry takes yet for this song — record one below.</p>";
    selectEl.innerHTML = "";
    playerEl.style.display = "none";
    aiLabRmtResetResultDisplay();
    return;
  }

  listEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  takes.forEach((t) => {
    const row = document.createElement("div");
    row.className = "ailab-rmt-take-row";
    const ratingBadge = t.rating && t.rating.overall_pct !== null
      ? `<span class="ailab-rmt-take-rating">${t.rating.overall_pct}%</span>` : "";
    row.innerHTML = `
      <span class="name">${escapeHtml(t.filename)}</span>
      <span class="ailab-rmt-take-row-right">
        ${ratingBadge}
        <span class="size">${(t.size / 1024 / 1024).toFixed(1)} MB</span>
        <button class="ailab-rmt-play-btn" title="Play">▶</button>
        <button class="ailab-rmt-rename-btn" title="Rename">✎</button>
        <button class="ailab-rmt-delete-btn" title="Delete">🗑</button>
      </span>
    `;
    row.querySelector(".ailab-rmt-play-btn").addEventListener("click", () => aiLabRmtPlayTake(t));
    row.querySelector(".ailab-rmt-rename-btn").addEventListener("click", () => aiLabRmtRenameTake(t));
    row.querySelector(".ailab-rmt-delete-btn").addEventListener("click", () => aiLabRmtDeleteTake(t));
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
  aiLabRmtOnTakeSelectChange();
}

// Playback straight from the take list — same idiom as Play Along's Takes
// tab (recorder.js's loadTakeIntoPlayer), just a single inline <audio>
// rather than a full trim-capable player, since trimming stays Play
// Along's job.
function aiLabRmtPlayTake(take) {
  const player = document.getElementById("ailab-rmt-take-player");
  player.src = `/api/output?path=${encodeURIComponent(take.path)}`;
  player.style.display = "";
  player.play().catch(() => {});
}

// Same prompt-based rename idiom as Play Along's Takes tab
// (recorder.js) — reuses the same /api/recording/rename endpoint; the
// server carries the "dry" flag (and any cached rating/heatmap — see
// svc_recording_rename) over to the new filename, so a renamed dry take
// doesn't drop out of this list or lose its rating the moment it stops
// matching "... - dry NN".
async function aiLabRmtRenameTake(take) {
  const base = take.filename.replace(/\.[^.]+$/, "");
  const newName = await textPrompt("Rename take to:", base);
  if (!newName || newName === base) return;
  try {
    await Api.post("/api/recording/rename", { path: take.path, new_name: newName });
    await aiLabRmtRefreshTakes();
  } catch (e) {
    alert("Rename failed: " + e.message);
  }
}

// Same confirm-then-discard idiom as Play Along's Takes tab
// (recorder.js) — /api/recording/discard also clears that take's cached
// rating/heatmap server-side (see svc_recording_discard), so this never
// leaves an orphaned rating pointing at a deleted file.
async function aiLabRmtDeleteTake(take) {
  if (!confirm(`Delete "${take.filename}"? This can't be undone.`)) return;
  await Api.post("/api/recording/discard", { path: take.path }).catch(() => {});
  const player = document.getElementById("ailab-rmt-take-player");
  if (player.src && player.src.includes(encodeURIComponent(take.path))) {
    player.pause();
    player.style.display = "none";
  }
  await aiLabRmtRefreshTakes();
}

function aiLabRmtOnTakeSelectChange() {
  const takePath = document.getElementById("ailab-rmt-take-select").value;
  const take = AiLabRmtTakesCache.find((t) => t.path === takePath);
  const hintEl = document.getElementById("ailab-rmt-score-hint");
  // Remembers the offset per take (see RATINGS_FILE's used_offset field
  // server-side) — no more re-entering it by hand every session.
  if (take && take.rating && take.rating.used_offset !== undefined && take.rating.used_offset !== null) {
    document.getElementById("ailab-rmt-offset").value = take.rating.used_offset;
  }
  if (take && take.rating) {
    aiLabRmtRenderResult(take.rating);
    hintEl.textContent = take.rating.overall_pct === null
      ? "This take's last score was invalid — see the warning above. Try re-scoring with a different offset."
      : "Showing this take's last rating — click Score to re-run.";
  } else {
    document.getElementById("ailab-rmt-result-card").style.display = "none";
    hintEl.textContent = take ? "Not scored yet." : "";
  }
}

// Shared by aiLabScoreTake (fresh result) and aiLabRmtOnTakeSelectChange
// (cached result — see RATINGS_FILE's comment server-side) so a cached
// rating renders identically to a freshly-scored one, not a stripped-down
// preview.
function aiLabRmtRenderResult(r) {
  const resultCard = document.getElementById("ailab-rmt-result-card");
  const overallEl = document.getElementById("ailab-rmt-overall");
  // overall_pct is null when every scored beat fell below the reference-
  // confidence floor (score_take's own fallback) — almost always a wrong
  // offset (scoring silence/a different passage against the reference)
  // rather than a "0% take," so this reads very differently from a
  // genuinely low score and needs to say so, not just show "--".
  overallEl.textContent = r.overall_pct !== null ? `Overall: ${r.overall_pct}%` : "Invalid rating — check your offset?";
  overallEl.className = "ailab-rmt-overall " + aiLabRmtOverallClass(r.overall_pct);
  const breakdownEl = document.getElementById("ailab-rmt-breakdown");
  breakdownEl.textContent = (r.overall_pitch !== null && r.overall_timing !== null)
    ? `Pitch agreement: ${(r.overall_pitch * 100).toFixed(0)}%  ·  Timing agreement: ${(r.overall_timing * 100).toFixed(0)}%` +
      (r.overall_raw !== null ? `  ·  raw (uncalibrated): ${r.overall_raw}` : "")
    : "";
  document.getElementById("ailab-rmt-heatmap-img").src =
    `/api/output?path=${encodeURIComponent(r.heatmap_path)}&t=${Date.now()}`;
  resultCard.style.display = "";
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
  // GP-mem: stream chunks to the server as they arrive rather than holding
  // the whole take in a JS array — see makeChunkedRecordingUpload (app.js)
  // and the same fix in recorder.js's beginRecordingPass.
  const upload = makeChunkedRecordingUpload();
  const recorder = new MediaRecorder(AiLabDry.dest.stream, { mimeType, audioBitsPerSecond: 192_000 });
  recorder.ondataavailable = (e) => upload.push(e.data);
  recorder.onerror = (e) => {
    console.error("Dry recorder error", e.error);
    hintEl.textContent = "Recorder error — stopped early, salvaging what was captured.";
    aiLabStopDryRecording();
  };
  recorder.onstop = () => aiLabFinalizeDryRecording(upload, mimeType);
  AiLabDry.recorder = recorder;
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

async function aiLabFinalizeDryRecording(upload, mimeType) {
  const hintEl = document.getElementById("ailab-rmt-record-hint");
  const ext = mimeType.includes("mp4") ? "m4a" : "webm";
  hintEl.textContent = "Saving dry take…";
  try {
    // GP-mem: chunks already streamed to the server as they were produced
    // — commit just renames the assembled temp file into place.
    const r = await upload.commit(State.track || "", ext, "dry");
    hintEl.textContent = `Saved as ${r.filename}.`;
    if (typeof questMarkDone === "function") questMarkDone("capture");
    await aiLabRmtRefreshTakes();
  } catch (e) {
    hintEl.textContent = `Save failed: ${e.message}`;
  } finally {
    AiLabDry.state = "idle";
    aiLabRmtUpdateRecordUI();
  }
}

function aiLabRmtOverallClass(pct) {
  if (pct === null || pct === undefined) return "invalid";
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
  const guitarStem = resolvedGuitarStemName();
  if (!guitarStem) {
    hintEl.textContent = "Needs a guitar stem to score against — re-separate with a guitar-capable model, or (for an imported stem pack) mark one of its stems as the guitar in the Mixer.";
    return;
  }
  const offset = parseFloat(document.getElementById("ailab-rmt-offset").value) || 0;
  const offsetSearch = parseFloat(document.getElementById("ailab-rmt-offset-search").value) || 0;

  hintEl.textContent = "Scoring…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/rate/score", {
      source_path: State.track, take_path: takePath,
      model: State.model, stem: guitarStem,
      offset, offset_search: offsetSearch,
    });
    if (typeof questMarkDone === "function") questMarkDone("judge");
    let msg = `Scored ${r.scored_count}/${r.total_count} beats.`;
    if (r.refine) {
      msg += r.refine.applied
        ? ` Offset auto-refined ${offset}s -> ${r.refine.offset}s (match quality ${r.refine.quality}).`
        : ` Offset auto-refine found ${r.refine.offset}s but match quality (${r.refine.quality}) was too low to trust — used ${offset}s as given.`;
    }
    if (r.overall_pct === null) {
      msg += " No beat had a confident reference to compare against — this almost always means the offset is "
        + "wrong (scoring against silence or the wrong passage), not that the take itself was bad. Double-check "
        + "the offset and try again.";
    }
    hintEl.textContent = msg;
    aiLabRmtRenderResult(r);
    // The server just cached this under the take's own filename (see
    // RATINGS_FILE) — mirror that into the in-memory list too, so
    // switching away and back to this take shows it without a refetch.
    const cached = AiLabRmtTakesCache.find((t) => t.path === takePath);
    if (cached) cached.rating = r;
  } catch (e) {
    hintEl.textContent = `Scoring failed: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Lick Ideas (V5-R1) — the Lick/Phrasing Assistant research spike, run from
// AI Lab instead of CLI-only so real songs are actually easy to try. The
// only feature in this app that makes a network call — opt-in, key-only,
// text-only (release-v5-spec.md §7). A provider picker (Claude, Google AI
// Studio, Groq) since the latter two have a genuinely free tier — each
// keeps its own separately-saved key server-side (server.py's
// LICK_PROVIDERS), this file just needs to know their display info.
// ---------------------------------------------------------------------------

const AILAB_LICK_PROVIDERS = {
  anthropic: { hasKeyField: "has_anthropic_key", placeholder: "sk-ant-...",
    hint: "Get a key at console.anthropic.com (Settings → API Keys) and add a little billing credit — usage here costs fractions of a cent per request." },
  google: { hasKeyField: "has_google_key", placeholder: "AIza...",
    hint: "Get a free key at aistudio.google.com (Get API key) — Gemini's free tier covers casual use here." },
  groq: { hasKeyField: "has_groq_key", placeholder: "gsk_...",
    hint: "Get a free key at console.groq.com/keys — Groq's free tier covers casual use here." },
};

function aiLabLickCurrentProvider() {
  return document.getElementById("ailab-lick-provider").value;
}

// Real user feedback: every mode's answer disappeared on switching modes
// or reopening AI Lab, forcing a re-run (a real, non-free LLM call) just to
// see something already asked for. AiLabAssistantCache holds each mode's
// last result (server-cached too — see AI_ASSISTANT_CACHE_FILE — so it
// also survives a full page reload, not just a mode switch within one
// visit) keyed by mode name; null/undefined means never run for this track.
let AiLabAssistantCache = {};
let AiLabAssistantCacheTrack = null;

async function aiLabAssistantRefreshCache() {
  if (!State.track) {
    AiLabAssistantCache = {};
    AiLabAssistantCacheTrack = null;
    return;
  }
  if (AiLabAssistantCacheTrack === State.track) return; // already have this track's cache
  try {
    AiLabAssistantCache = await Api.get(`/api/aiassistant/cache?track=${encodeURIComponent(State.track)}`);
    AiLabAssistantCacheTrack = State.track;
  } catch (e) {
    AiLabAssistantCache = {};
  }
}

const AILAB_MODE_RESULT_CARD_ID = {
  lickideas: "ailab-lick-result-card",
  askai: "ailab-explain-result-card",
  practicetips: "ailab-tips-result-card",
  thistrack: "ailab-track-result-card",
  thisartist: "ailab-artist-result-card",
};

// Shows the given mode's cached result (if any) using the same render
// function a fresh run uses — a redisplayed answer looks identical to a
// freshly-generated one. Practice Tips' cache is only shown if it's still
// for the currently-selected take (see its take_path check below);
// switching to a different take without cached tips just leaves that
// panel's result card hidden, same as never having run it.
//
// Real user report, same root cause as Rate My Take's stale result: this
// used to just return on no cached entry, leaving whichever OTHER song's
// answer happened to still be rendered in the DOM on screen — asked for
// per-track persistence ("cleared when switching song, reshown when
// switching back"), which the cache itself already did correctly
// (AiLabAssistantCache is refetched per State.track); only the display
// side never cleared itself for a track with nothing cached yet.
function aiLabAssistantRestoreMode(mode) {
  const cached = AiLabAssistantCache[mode];
  const cardId = AILAB_MODE_RESULT_CARD_ID[mode];
  if (!cached) {
    if (cardId) document.getElementById(cardId).style.display = "none";
    return;
  }
  if (mode === "lickideas") aiLabRenderLickResult(cached);
  else if (mode === "askai") aiLabRenderAskAiResult(cached);
  else if (mode === "practicetips") {
    const selectedTake = document.getElementById("ailab-tips-take-select").value;
    if (cached.take_path === selectedTake) aiLabRenderTipsResult(cached);
    else document.getElementById(cardId).style.display = "none";
  } else if (mode === "thistrack") aiLabRenderThisTrackResult(cached);
  else if (mode === "thisartist") aiLabRenderThisArtistResult(cached);
}

async function aiLabLickOpen() {
  aiLabLickUpdateProviderHint();
  await aiLabLickRefreshKeyStatus(true);
  await aiLabTrackInfoOpen();
  await aiLabAssistantRefreshCache();
  if (AiLab.amode === "practicetips") await aiLabTipsRefreshTakes();
  // Song Structure isn't a "restore a cached text result" mode like the
  // others (aiLabAssistantRestoreMode doesn't handle it) — it always
  // (re)builds the detected map itself, attaching any cached AI annotation
  // the backend already has for this track.
  if (AiLab.amode === "songstructure") await aiLabRenderSongStructure();
  aiLabAssistantRestoreMode(AiLab.amode);
}

// Mode selector for the AI Assistant panel (release-v5-spec.md §4's "one
// panel, not two more tabs" — Lick Ideas / Ask AI / Practice Tips / This
// Track / Song Structure / This Artist share the provider/API-key card (and,
// for This Track/Song Structure/This Artist, the Artist/Title card) above;
// only the mode-specific card and its own result card toggle visibility).
function aiLabAssistantSetMode(mode) {
  AiLab.amode = mode;
  document.getElementById("ailab-assistant-mode-toggle").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.amode === mode);
  });
  document.getElementById("ailab-lick-mode-card").style.display = mode === "lickideas" ? "" : "none";
  document.getElementById("ailab-lick-result-card").style.display = "none";
  document.getElementById("ailab-explain-mode-card").style.display = mode === "askai" ? "" : "none";
  document.getElementById("ailab-explain-result-card").style.display = "none";
  document.getElementById("ailab-tips-mode-card").style.display = mode === "practicetips" ? "" : "none";
  document.getElementById("ailab-tips-result-card").style.display = "none";
  document.getElementById("ailab-track-mode-card").style.display = mode === "thistrack" ? "" : "none";
  document.getElementById("ailab-track-result-card").style.display = "none";
  document.getElementById("ailab-ss-mode-card").style.display = mode === "songstructure" ? "" : "none";
  document.getElementById("ailab-artist-mode-card").style.display = mode === "thisartist" ? "" : "none";
  document.getElementById("ailab-artist-result-card").style.display = "none";
  if (mode === "practicetips") aiLabTipsRefreshTakes().then(() => aiLabAssistantRestoreMode(mode));
  else if (mode === "songstructure") aiLabRenderSongStructure();
  else aiLabAssistantRestoreMode(mode);
}

// ---------------------------------------------------------------------------
// This song's Artist/Title (release-v5-spec.md §4a) — shared by This Track,
// This Artist, and Ask AI's context, since none of them have any other way
// to know what song this actually is (no ID3/filename parsing trusted
// blindly — see _guess_title_from_filename's docstring server-side).
// ---------------------------------------------------------------------------

async function aiLabTrackInfoOpen() {
  const artistEl = document.getElementById("ailab-trackinfo-artist");
  const titleEl = document.getElementById("ailab-trackinfo-title");
  const statusEl = document.getElementById("ailab-trackinfo-status");
  const detailsEl = document.getElementById("ailab-trackinfo-details");
  const summaryEl = document.getElementById("ailab-trackinfo-summary");
  if (!State.track) {
    artistEl.value = ""; titleEl.value = "";
    statusEl.textContent = "No song selected.";
    summaryEl.textContent = "";
    return;
  }
  try {
    const r = await Api.get(`/api/trackinfo?track=${encodeURIComponent(State.track)}`);
    artistEl.value = r.artist || "";
    titleEl.value = r.title || (r.guessed_title || "");
    const configured = !!(r.artist || r.title);
    statusEl.textContent = configured
      ? "" : `Guessed title "${r.guessed_title}" from the filename — check/edit before saving.`;
    // ui-review-v5-full.md §2.7: collapse once configured, on the "just
    // opened this tab/switched song" moment only — not on every keystroke
    // or re-save, which would fight a user who deliberately reopened it.
    summaryEl.textContent = configured ? `${r.title || "?"} — ${r.artist || "?"}` : "not set";
    detailsEl.open = !configured;
  } catch (e) {
    statusEl.textContent = `Couldn't load song info: ${e.message}`;
  }
}

async function aiLabTrackInfoSave() {
  const statusEl = document.getElementById("ailab-trackinfo-status");
  if (!State.track) {
    statusEl.textContent = "No song selected.";
    return;
  }
  const artist = document.getElementById("ailab-trackinfo-artist").value;
  const title = document.getElementById("ailab-trackinfo-title").value;
  try {
    await Api.post("/api/trackinfo", { track: State.track, artist, title });
    statusEl.textContent = "Saved.";
  } catch (e) {
    statusEl.textContent = `Couldn't save: ${e.message}`;
  }
}

function aiLabLickUpdateProviderHint() {
  const info = AILAB_LICK_PROVIDERS[aiLabLickCurrentProvider()];
  document.getElementById("ailab-lick-provider-hint").textContent = info.hint;
  document.getElementById("ailab-lick-apikey").placeholder = info.placeholder;
}

// collapseIfConfigured: only passed true from the "just opened this tab"
// call site (aiLabLickOpen) — ui-review-v5-full.md §2.7 wants this card to
// collapse once a key exists, but NOT every time this refreshes for other
// reasons (switching the provider dropdown, right after saving a key)
// while the user is actively looking at it.
async function aiLabLickRefreshKeyStatus(collapseIfConfigured) {
  const statusEl = document.getElementById("ailab-lick-key-status");
  const summaryEl = document.getElementById("ailab-lick-provider-summary");
  const detailsEl = document.getElementById("ailab-lick-provider-details");
  const provider = aiLabLickCurrentProvider();
  const info = AILAB_LICK_PROVIDERS[provider];
  try {
    const r = await Api.get("/api/settings");
    const hasKey = !!r[info.hasKeyField];
    const providerSelect = document.getElementById("ailab-lick-provider");
    const providerLabel = providerSelect.options[providerSelect.selectedIndex].text.split(" —")[0];
    statusEl.textContent = hasKey ? "Key saved." : "No key saved yet for this provider — see above.";
    summaryEl.textContent = hasKey ? `${providerLabel} — key saved` : `${providerLabel} — no key yet`;
    if (collapseIfConfigured) detailsEl.open = !hasKey;
  } catch (e) {
    statusEl.textContent = `Couldn't check key status: ${e.message}`;
  }
}

async function aiLabLickSaveKey() {
  const input = document.getElementById("ailab-lick-apikey");
  const statusEl = document.getElementById("ailab-lick-key-status");
  const provider = aiLabLickCurrentProvider();
  const info = AILAB_LICK_PROVIDERS[provider];
  try {
    const r = await Api.post("/api/settings/provider_key", { provider, api_key: input.value });
    input.value = ""; // never leave a saved secret sitting in a visible (even password-masked) input
    statusEl.textContent = r[info.hasKeyField] ? "Key saved." : "Key cleared.";
  } catch (e) {
    statusEl.textContent = `Couldn't save key: ${e.message}`;
  }
}

// Renders a Lick Ideas result — shared by aiLabLickSuggest (fresh) and
// aiLabAssistantRestoreMode (cached, see AiLabAssistantCache) so a
// redisplayed answer looks identical to a freshly-generated one.
function aiLabRenderLickResult(r) {
  document.getElementById("ailab-lick-context").textContent = `${r.key} · ${r.bpm} BPM · ${r.progression}`;
  document.getElementById("ailab-lick-suggestion").textContent = r.suggestion;
  if (r.genre) document.getElementById("ailab-lick-genre").value = r.genre;
  document.getElementById("ailab-lick-result-card").style.display = "";
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
  const provider = aiLabLickCurrentProvider();

  btn.disabled = true;
  hintEl.textContent = "Asking for phrasing ideas…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/lick/suggest", {
      source_path: State.track, model: State.model, genre, provider,
    });
    hintEl.textContent = "";
    aiLabRenderLickResult(r);
    AiLabAssistantCache.lickideas = r; // this run just became the cached one
    if (typeof questMarkDone === "function") questMarkDone("counsel");
  } catch (e) {
    hintEl.textContent = `Couldn't get suggestions: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Explain This (release-v5-spec.md §4) — single-shot Q&A, not a retained-
// history chat (deliberate scope cut, see §4's Update). Shares the same
// provider/key card and prompt-plumbing as Lick Ideas.
// ---------------------------------------------------------------------------

// Shared by aiLabExplainAsk (fresh) and aiLabAssistantRestoreMode (cached).
function aiLabRenderAskAiResult(r) {
  const parts = [];
  if (r.artist || r.title) parts.push(`${r.title || "?"} — ${r.artist || "?"}`);
  if (r.key) parts.push(`${r.key} · ${r.bpm} BPM · ${r.progression}`);
  document.getElementById("ailab-explain-context").textContent = parts.join(" · ");
  document.getElementById("ailab-explain-answer").textContent = r.answer;
  if (r.question) document.getElementById("ailab-explain-question").value = r.question;
  document.getElementById("ailab-explain-result-card").style.display = "";
}

async function aiLabExplainAsk() {
  const hintEl = document.getElementById("ailab-explain-hint");
  const resultCard = document.getElementById("ailab-explain-result-card");
  const btn = document.getElementById("ailab-explain-ask-btn");
  const questionEl = document.getElementById("ailab-explain-question");
  if (!State.track) {
    hintEl.textContent = "No song selected.";
    return;
  }
  const question = questionEl.value;
  if (!question.trim()) {
    hintEl.textContent = "Ask a question first.";
    return;
  }
  const provider = aiLabLickCurrentProvider();

  btn.disabled = true;
  hintEl.textContent = "Thinking…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/ask/ai", {
      source_path: State.track, model: State.model, question, provider,
    });
    hintEl.textContent = "";
    aiLabRenderAskAiResult(r);
    AiLabAssistantCache.askai = r;
    if (typeof questMarkDone === "function") questMarkDone("counsel");
  } catch (e) {
    hintEl.textContent = `Couldn't get an answer: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Practice Tips (release-v5-spec.md §4) — grounds its prompt in this take's
// own Rate My Take weak-beat breakdown, not just static song data. Shares
// the take list and offset/offset-search idiom from the Rate My Take tab,
// re-scoring the selected take server-side rather than trusting any
// previously-displayed result.
// ---------------------------------------------------------------------------

let AiLabTipsTakesCache = []; // same idiom as AiLabRmtTakesCache — lets
// take-select's "change" handler retrieve a take's saved Rate My Take
// rating/offset without a round trip.

async function aiLabTipsRefreshTakes() {
  const selectEl = document.getElementById("ailab-tips-take-select");
  const btn = document.getElementById("ailab-tips-suggest-btn");
  const hintEl = document.getElementById("ailab-tips-hint");
  if (!State.track) {
    selectEl.innerHTML = "";
    btn.disabled = true;
    hintEl.textContent = "No song selected.";
    AiLabTipsTakesCache = [];
    return;
  }
  let takes = [];
  try {
    const r = await Api.get(`/api/recordings?track=${encodeURIComponent(State.track)}`);
    takes = (r.takes || []).filter((t) => t.dry);
  } catch (e) {
    selectEl.innerHTML = "";
    btn.disabled = true;
    hintEl.textContent = `Couldn't load takes: ${e.message}`;
    return;
  }
  AiLabTipsTakesCache = takes;

  if (!takes.length) {
    selectEl.innerHTML = "";
    btn.disabled = true;
    hintEl.textContent = "No dry takes yet for this song — record one in the Rate My Take tab first.";
    return;
  }

  const prevValue = selectEl.value;
  selectEl.innerHTML = "";
  takes.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.path;
    opt.textContent = t.filename;
    selectEl.appendChild(opt);
  });
  if (takes.some((t) => t.path === prevValue)) selectEl.value = prevValue;
  else selectEl.selectedIndex = takes.length - 1;
  btn.disabled = false;
  aiLabTipsOnTakeSelectChange();
}

// Retrieves a take's saved Rate My Take rating (already returned inline by
// /api/recordings — see svc_recordings_list's "rating" field) so Practice
// Tips doesn't need its own separate offset entry: the offset that already
// worked in Rate My Take carries straight over, and a take that was rated
// invalid there ("--", wrong offset) is flagged here too before spending an
// LLM call on it.
function aiLabTipsOnTakeSelectChange() {
  const takePath = document.getElementById("ailab-tips-take-select").value;
  const take = AiLabTipsTakesCache.find((t) => t.path === takePath);
  const hintEl = document.getElementById("ailab-tips-hint");
  // Switching takes hides any previously-shown tips (they'd be for the
  // wrong take) — aiLabAssistantRestoreMode below re-shows them only if
  // this specific take already has its own cached Practice Tips result.
  document.getElementById("ailab-tips-result-card").style.display = "none";
  if (!take || !take.rating) {
    hintEl.textContent = take ? "Not yet scored in Rate My Take — using the offset below as given." : "";
  } else {
    if (take.rating.used_offset !== undefined && take.rating.used_offset !== null) {
      document.getElementById("ailab-tips-offset").value = take.rating.used_offset;
    }
    hintEl.textContent = take.rating.overall_pct === null
      ? "This take's Rate My Take score was invalid (\"--\") — check the offset before asking for tips."
      : `Rate My Take score for this take: ${take.rating.overall_pct}% (using its saved offset).`;
  }
  aiLabAssistantRestoreMode("practicetips");
}

// Shared by aiLabTipsSuggest (fresh) and aiLabAssistantRestoreMode
// (cached). Practice Tips' cache also carries the take_path it was run
// against — aiLabAssistantRestoreMode only shows it when that's still the
// currently-selected take, so switching takes doesn't show stale tips.
function aiLabRenderTipsResult(r) {
  const overallLine = r.overall_pct !== null ? ` · Overall: ${r.overall_pct}%` : "";
  document.getElementById("ailab-tips-context").textContent = `${r.key} · ${r.bpm} BPM · ${r.progression}${overallLine}`;
  document.getElementById("ailab-tips-weak-regions").textContent =
    r.weak_regions ? `Weakest moments:\n${r.weak_regions}` : "No standout weak moments — this take scored fairly evenly.";
  document.getElementById("ailab-tips-suggestion").textContent = r.suggestion;
  document.getElementById("ailab-tips-result-card").style.display = "";
}

async function aiLabTipsSuggest() {
  const hintEl = document.getElementById("ailab-tips-hint");
  const resultCard = document.getElementById("ailab-tips-result-card");
  const btn = document.getElementById("ailab-tips-suggest-btn");
  const takePath = document.getElementById("ailab-tips-take-select").value;
  if (!State.track || !takePath) {
    hintEl.textContent = "No take selected.";
    return;
  }
  const guitarStem = resolvedGuitarStemName();
  if (!guitarStem) {
    hintEl.textContent = "Needs a guitar stem to score against — re-separate with a guitar-capable model, or (for an imported stem pack) mark one of its stems as the guitar in the Mixer.";
    return;
  }
  const offset = parseFloat(document.getElementById("ailab-tips-offset").value) || 0;
  const offsetSearch = parseFloat(document.getElementById("ailab-tips-offset-search").value) || 0;
  const provider = aiLabLickCurrentProvider();

  btn.disabled = true;
  hintEl.textContent = "Asking for practice tips…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/practicetips/suggest", {
      source_path: State.track, take_path: takePath, model: State.model, stem: guitarStem,
      offset, offset_search: offsetSearch, provider,
    });
    // Reuses the take's existing Rate My Take scoring instead of
    // re-running score_take when the offset matches (see svc_practice_
    // tips's "reused_cached_scoring" — no point re-scoring a take that's
    // already been scored, per real user feedback).
    hintEl.textContent = r.reused_cached_scoring ? "Using this take's existing Rate My Take score." : "";
    aiLabRenderTipsResult(r);
    AiLabAssistantCache.practicetips = r;
    if (typeof questMarkDone === "function") questMarkDone("counsel");
  } catch (e) {
    hintEl.textContent = `Couldn't get practice tips: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// This Track / This Artist (release-v5-spec.md §4a) — real-world knowledge,
// not locally-derived data (a different trust boundary — see
// _REAL_WORLD_KNOWLEDGE_CAVEAT server-side, shown here as a standing
// disclaimer on the result card, not folded into the answer text).
// ---------------------------------------------------------------------------

// Shared by aiLabThisTrackInfo (fresh) and aiLabAssistantRestoreMode (cached).
function aiLabRenderThisTrackResult(r) {
  document.getElementById("ailab-track-caveat").textContent = r.caveat;
  document.getElementById("ailab-track-info").textContent = r.info;
  document.getElementById("ailab-track-result-card").style.display = "";
}

async function aiLabThisTrackInfo() {
  const hintEl = document.getElementById("ailab-track-hint");
  const resultCard = document.getElementById("ailab-track-result-card");
  const btn = document.getElementById("ailab-track-info-btn");
  if (!State.track) {
    hintEl.textContent = "No song selected.";
    return;
  }
  const provider = aiLabLickCurrentProvider();

  btn.disabled = true;
  hintEl.textContent = "Looking up track info…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/thistrack/info", {
      source_path: State.track, model: State.model, provider,
    });
    hintEl.textContent = "";
    aiLabRenderThisTrackResult(r);
    AiLabAssistantCache.thistrack = r;
    if (typeof questMarkDone === "function") questMarkDone("counsel");
  } catch (e) {
    hintEl.textContent = `Couldn't get track info: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Shared by aiLabThisArtistInfo (fresh) and aiLabAssistantRestoreMode (cached).
function aiLabRenderThisArtistResult(r) {
  document.getElementById("ailab-artist-caveat").textContent = r.caveat;
  document.getElementById("ailab-artist-info").textContent = r.info;
  document.getElementById("ailab-artist-result-card").style.display = "";
}

async function aiLabThisArtistInfo() {
  const hintEl = document.getElementById("ailab-artist-hint");
  const resultCard = document.getElementById("ailab-artist-result-card");
  const btn = document.getElementById("ailab-artist-info-btn");
  if (!State.track) {
    hintEl.textContent = "No song selected.";
    return;
  }
  const provider = aiLabLickCurrentProvider();

  btn.disabled = true;
  hintEl.textContent = "Looking up artist info…";
  resultCard.style.display = "none";
  try {
    const r = await Api.post("/api/thisartist/info", {
      source_path: State.track, model: State.model, provider,
    });
    hintEl.textContent = "";
    aiLabRenderThisArtistResult(r);
    AiLabAssistantCache.thisartist = r;
    if (typeof questMarkDone === "function") questMarkDone("counsel");
  } catch (e) {
    hintEl.textContent = `Couldn't get artist info: ${e.message}`;
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

  // ui-review-v5-full.md §2.6: reverse of recorder.js's rec-jump-to-rmt link.
  document.getElementById("rmt-jump-to-playalong").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("playalong-open-btn").click();
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
  document.getElementById("ailab-rmt-take-select").addEventListener("change", aiLabRmtOnTakeSelectChange);
  // The whole point of this screen's Backing Track card: find the actual
  // spot the take starts (scrub the timeline, or just play up to it) and
  // drop it straight into Offset, instead of typing seconds by eye/ear.
  document.getElementById("ailab-rmt-use-position-btn").addEventListener("click", () => {
    document.getElementById("ailab-rmt-offset").value = currentPosition().toFixed(2);
  });

  document.getElementById("ailab-lick-savekey-btn").addEventListener("click", aiLabLickSaveKey);
  document.getElementById("ailab-lick-suggest-btn").addEventListener("click", aiLabLickSuggest);
  document.getElementById("ailab-lick-provider").addEventListener("change", async () => {
    aiLabLickUpdateProviderHint();
    await aiLabLickRefreshKeyStatus();
  });

  document.getElementById("ailab-assistant-mode-toggle").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => aiLabAssistantSetMode(btn.dataset.amode));
  });
  document.querySelectorAll(".ailab-explain-example-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("ailab-explain-question").value = btn.dataset.q;
    });
  });
  document.getElementById("ailab-explain-ask-btn").addEventListener("click", aiLabExplainAsk);
  document.getElementById("ailab-tips-suggest-btn").addEventListener("click", aiLabTipsSuggest);
  document.getElementById("ailab-tips-take-select").addEventListener("change", aiLabTipsOnTakeSelectChange);
  document.getElementById("ailab-trackinfo-save-btn").addEventListener("click", aiLabTrackInfoSave);
  document.getElementById("ailab-track-info-btn").addEventListener("click", aiLabThisTrackInfo);
  document.getElementById("ailab-artist-info-btn").addEventListener("click", aiLabThisArtistInfo);
  // SS-3 cross-links: This Track (the song's story) <-> Song Structure (how
  // it's built/how to play it) point at each other, both ways.
  document.getElementById("ailab-track-to-ss-btn").addEventListener("click", () => aiLabAssistantSetMode("songstructure"));
  document.getElementById("ailab-ss-to-track-btn").addEventListener("click", () => aiLabAssistantSetMode("thistrack"));
}

wireAiLab();
