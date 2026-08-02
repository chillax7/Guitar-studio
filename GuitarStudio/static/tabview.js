"use strict";

// ---------------------------------------------------------------------------
// Tab View (orpheus-tabview-spec.md, adapted to this app's architecture) — a
// screen for dragging & dropping Guitar Pro tab files (.gp3/.gp4/.gp5/.gpx)
// for viewing and playback, rendered client-side by alphaTab (self-hosted,
// see static/vendor/alphatab/README.txt — never a CDN, matching this app's
// local-first design). A tab file has no stems/mix/rig, so it gets its own
// library — but per direct follow-up request, that library REPLACES the
// main sidebar's song Library/import zone while Tab View is open (rather
// than living in a second, separate sidebar the way the first version of
// this screen had it) — #song-library-panel/#tab-library-panel in
// index.html are toggled by openTabView/closeTabView below. Reuses the
// song Library's exact CSS classes (.track-row/.playlist-group/
// .track-add-to-playlist etc.) so it reads as the same component, just
// showing different data. Backend: server.py's "Tab View" section, the
// matching tabs/ directory + _tab_library.json sidecar.
//
// Deliberately its own JS file (matching the app.js=Mixer/playalong.js=
// Tone Lab+Play Along/ailab.js=AI Lab per-screen split already established)
// rather than folding into one of those — this screen's state (the alphaTab
// API instance, its own library/playlists) is entirely independent of
// State/PA/AiLab.
// ---------------------------------------------------------------------------

const TABVIEW_ALL_GROUP_KEY = "__all_tabs__";

const TabView = {
  library: [],           // [{name, title, artist}]
  playlists: {},         // {name: [filenames]}
  expandedPlaylists: new Set([TABVIEW_ALL_GROUP_KEY]), // All Tabs starts open, same as the song Library's All Tracks
  currentTab: null,      // filename of the tab currently loaded into alphaTab
  api: null,             // alphaTab AlphaTabApi instance, created lazily on first tab load
};

const TABVIEW_TAB_EXTS = [".gp3", ".gp4", ".gp5", ".gpx", ".gp"];

// ---------------------------------------------------------------------------
// T-1a: "Play through my rig" — route the tab's synthesized audio through
// Tone Lab's amp/cab/effects chain instead of straight out of alphaTab.
//
// Why this is worth doing: the ceiling on tab playback is the General MIDI
// soundfont, whose distorted-guitar programs (29/30) are a single looped
// sample with no velocity layers or articulation — which is why tab playback
// sounds synthetic no matter how good the notation is. Feeding a CLEAN tab
// tone through a real NAM capture is the one move that uses what this app
// already has and no tab reader does.
//
// The constraint: alphaTab creates and owns its own AudioContext, and Web
// Audio nodes cannot connect across contexts. So the audio has to leave
// alphaTab's context as a MediaStream and re-enter ours — which costs some
// latency. That is fine here (this is playback, not live monitoring of your
// own playing) but it is why this is a toggle and not the default.
//
// How the interception works, and why it is done this way: both of alphaTab
// 1.8.4's Web Audio backends (AlphaSynthScriptProcessorOutput and
// AlphaSynthAudioWorkletOutput) create their output node inside play() and
// destroy it in pause(), and the worklet one does it asynchronously inside a
// promise. So there is no single node to grab once at setup. Rather than
// reach into whichever private field currently holds it (_audioNode vs
// _worklet) and re-do it on every transport change, we intercept the one
// thing both paths always do: connect(theirContext.destination). The patch
// below is scoped to exactly that — a node whose own context is alphaTab's,
// targeting alphaTab's destination — so nothing else in the app is affected.
// ---------------------------------------------------------------------------
const TabRig = {
  enabled: false,        // user's toggle state
  installed: false,      // connect() interceptor installed
  msDest: null,          // MediaStreamAudioDestinationNode, in alphaTab's context
  srcNode: null,         // MediaStreamAudioSourceNode, in the app's context
  atCtx: null,           // alphaTab's AudioContext
};

function tabRigStatus(msg) {
  const el = document.getElementById("tabview-rig-status");
  if (el) el.textContent = msg || "";
}

// alphaTab's output object (AlphaSynthWebAudioOutputBase) exposes a public
// `context`, but only once the player has been created and opened.
function tabRigAlphaTabContext() {
  try {
    const out = TabView.api && TabView.api.player && TabView.api.player.output;
    return (out && out.context) || null;
  } catch (e) { return null; }
}

function tabRigInstallInterceptor(atCtx) {
  if (TabRig.installed) return;
  TabRig.atCtx = atCtx;
  TabRig.msDest = atCtx.createMediaStreamDestination();
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...rest) {
    if (TabRig.enabled && TabRig.msDest &&
        destination === TabRig.atCtx.destination && this.context === TabRig.atCtx) {
      // Diverted into the bridge instead of alphaTab's own speakers. Note
      // this returns the MediaStreamDestination rather than the original
      // target, which is what connect() is contracted to return (the
      // destination node) — callers in alphaTab ignore it either way.
      return origConnect.call(this, TabRig.msDest);
    }
    return origConnect.call(this, destination, ...rest);
  };
  TabRig.installed = true;
}

// Rebuild the app-side half of the bridge. Safe to call repeatedly.
async function tabRigConnectToRig() {
  if (!TabRig.msDest) return false;
  // The rig graph (and PA.tabIn) only exists once Tone Lab/Play Along has
  // been opened at least once this session; build it on demand so the
  // toggle works even if the user came straight to Tab View.
  if (typeof paEnsureRigSessionReady === "function") await paEnsureRigSessionReady();
  if (typeof PA === "undefined" || !PA.tabIn) return false;
  if (TabRig.srcNode) { try { TabRig.srcNode.disconnect(); } catch (e) { /* already gone */ } }
  TabRig.srcNode = Audio.ctx.createMediaStreamSource(TabRig.msDest.stream);
  TabRig.srcNode.connect(PA.tabIn);
  if (Audio.ctx.state === "suspended") await Audio.ctx.resume();
  return true;
}

function tabRigDisconnect() {
  if (TabRig.srcNode) { try { TabRig.srcNode.disconnect(); } catch (e) { /* already gone */ } }
  TabRig.srcNode = null;
}

async function setTabRigEnabled(on) {
  const btn = document.getElementById("tabview-rig-btn");
  if (on) {
    const atCtx = tabRigAlphaTabContext();
    if (!atCtx) {
      // The player context does not exist until a tab has been loaded and
      // the player initialised — say so rather than silently doing nothing.
      tabRigStatus("Load a tab and press Play once first, then turn this on.");
      if (btn) btn.classList.remove("active");
      TabRig.enabled = false;
      return;
    }
    tabRigInstallInterceptor(atCtx);
    TabRig.enabled = true;              // must be set before the reconnect below
    const ok = await tabRigConnectToRig();
    if (!ok) {
      TabRig.enabled = false;
      if (btn) btn.classList.remove("active");
      tabRigStatus("Couldn't reach the rig — open Tone Lab once, then try again.");
      return;
    }
    if (btn) btn.classList.add("active");
    tabRigStatus("Tab audio is going through your Tone Lab rig. Press Play again to re-route if you were already playing.");
  } else {
    TabRig.enabled = false;
    tabRigDisconnect();
    if (btn) btn.classList.remove("active");
    tabRigStatus("Tab audio is back on alphaTab's own output. Press Play again to take effect.");
  }
}

// ---------------------------------------------------------------------------
// alphaTab lazy load + API construction
// ---------------------------------------------------------------------------

let alphaTabModulePromise = null;
function loadAlphaTabModule() {
  // Dynamic import() works fine from this plain (non type="module") script —
  // no need to convert the whole file just to pull in one ES module, and
  // this also means the ~3.6MB vendored library is never fetched until the
  // user actually opens Tab View, not on every page load.
  if (!alphaTabModulePromise) alphaTabModulePromise = import("./vendor/alphatab/alphaTab.min.mjs");
  return alphaTabModulePromise;
}

async function ensureTabViewApi() {
  if (TabView.api) return TabView.api;
  const alphaTab = await loadAlphaTabModule();

  // Direct request: the tab should auto-scroll during playback so the
  // playhead stays at the top of the screen. alphaTab's own
  // player.scrollMode (default ScrollMode.Continuous) already re-scrolls
  // to the new row every time the cursor advances into it — but only
  // within whatever element player.scrollElement names, which defaults to
  // "html,body". That default does nothing here: this screen's actual
  // scrolling element is #tabview-overlay itself (.screen-overlay's own
  // overflow-y: auto in styles.css), not the document body, so alphaTab's
  // auto-scroll was silently scrolling a page that never moves.
  // scrollOffsetY nudges the target row down by the sticky screen-header's
  // height (+ a small gap) so the row alphaTab scrolls to doesn't end up
  // hidden underneath it.
  // #tabview-header is the screen's Close bar. It does not exist on every
  // layout — the V9 shell drops it entirely (the always-visible activity
  // rail replaces it), and reading getBoundingClientRect() off the missing
  // element threw right here, taking the whole tab load down with
  // "Cannot read properties of null". Absent header simply means there is
  // nothing sticky above the score to scroll clear of, i.e. no offset.
  const headerEl = document.getElementById("tabview-header");
  const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0;

  const api = new alphaTab.AlphaTabApi(document.getElementById("tabview-canvas"), {
    core: {
      fontDirectory: "vendor/alphatab/font/",
      // Single-threaded rendering — this app opens one tab at a time for
      // practice, not a batch of scores, so the render-blocking-main-thread
      // case the worker exists for is unlikely to bite here. Keeps the
      // integration simpler (no separate worker lifecycle to manage) — see
      // vendor/alphatab/README.txt for the worker/worklet files vendored
      // anyway, in case a rendering/audio path needs them regardless.
      useWorkers: false,
    },
    player: {
      enablePlayer: true,
      enableCursor: true,
      // Direct request: select a section of the tab and loop over just
      // that. This is alphaTab's own built-in click-drag bar selection
      // (already the library default — set explicitly here since the
      // section-loop feature below depends on it, not just for cursor
      // clicks). Dragging across the notation sets api.playbackRange via
      // alphaTab's internal applyPlaybackRangeFromHighlight(); the existing
      // Loop button (isLooping) then repeats within that range instead of
      // the whole tab once both are set — no custom loop logic needed,
      // this is exactly what the two combined already do.
      enableUserInteraction: true,
      // Real user report: the library's own default (Sonivox, a low-bitrate
      // GM soundfont from 2004-06, previously vendored here) sounds nothing
      // like a real guitar. Swapped for FluidR3Mono — the same well-regarded
      // free soundfont MuseScore 2 shipped for years — much more realistic
      // guitar/bass patches at a still-reasonable 14MB.
      soundFont: "vendor/alphatab/soundfont/FluidR3Mono_GM.sf3",
      scrollElement: "#tabview-overlay",
      scrollOffsetY: -(headerHeight + 8),
    },
  });

  // A left-over selection from the previously loaded tab would refer to
  // Beat objects of a score that no longer exists — same "leftover from
  // last song is a trap" reasoning this app already applies to Zoom/Speed/
  // Tune on track switch (app.js selectTrack), just for this screen's own
  // tab switch instead.
  api.playbackRangeHighlightChanged.on((e) => {
    document.getElementById("tabview-clear-selection-btn").style.display = e && e.startBeat ? "" : "none";
  });

  api.scoreLoaded.on((score) => onTabScoreLoaded(score));
  api.error.on((err) => {
    console.error("alphaTab error", err);
    const message = err && err.message ? err.message : String(err);
    document.getElementById("tabview-import-hint").textContent = `Couldn't load tab: ${message}`;
    document.getElementById("tabview-loading-state").style.display = "none";
    document.getElementById("tabview-empty-state").style.display = "";
  });

  // Scrub bar + time readout for the TAB's own playback (separate from the
  // song transport bar's timeline above, which scrubs the backing track).
  // Guarded by tabviewScrubbing so this doesn't fight the user's own drag —
  // alphaTab fires playerPositionChanged continuously during playback,
  // which would otherwise yank the slider (and the user's finger with it)
  // back to the actually-playing position on every tick while dragging.
  api.playerPositionChanged.on((args) => {
    const scrub = document.getElementById("tabview-scrub");
    if (!tabviewScrubbing) {
      scrub.max = String(Math.round(args.endTime));
      scrub.value = String(Math.round(args.currentTime));
    }
    document.getElementById("tabview-time-display").textContent =
      `${formatTabViewTime(args.currentTime)} / ${formatTabViewTime(args.endTime)}`;
  });

  TabView.api = api;
  return api;
}

function onTabScoreLoaded(score) {
  // Clear any loop-section selection left over from the previously loaded
  // tab — it refers to Beat objects belonging to that tab's score, not
  // this new one.
  if (TabView.api) {
    TabView.api.playbackRange = null;
    TabView.api.clearPlaybackRangeHighlight();
  }

  const title = score.title || "";
  const artist = score.artist || "";
  const libEntry = TabView.library.find((t) => t.name === TabView.currentTab);
  // Same rule as the library row below: if the user renamed this tab, the
  // play bar shows THEIR name, not the .gp file's embedded title.
  const barName = (libEntry && libEntry.user_named && libEntry.title) || title || TabView.currentTab;
  document.getElementById("tabview-bar-tab-name").textContent = barName;
  document.getElementById("tabview-track-artist").textContent = artist;

  // alphaTab already parsed this metadata as part of loading the file for
  // rendering — reusing it here (rather than a second, server-side GP-file
  // parser just to read the same two fields) is the whole reason
  // svc_tab_set_metadata exists as a client-reported PUT instead of
  // something svc_tab_upload does itself. Best-effort: a failed save here
  // just means the library list keeps showing the bare filename a little
  // longer, not a broken tab.
  const entry = libEntry;
  // A hand-renamed tab keeps the name the user gave it: the embedded title
  // would otherwise overwrite the library row every time the tab was
  // opened, which is what made a rename look like it hadn't taken. The
  // server enforces the same rule (svc_tab_set_metadata); this keeps the
  // list from flashing the old name before the next refresh agrees.
  const nextTitle = (entry && entry.user_named) ? entry.title : title;
  if (entry && (entry.title !== nextTitle || entry.artist !== artist)) {
    entry.title = nextTitle;
    entry.artist = artist;
    Api.post("/api/tabs/metadata", { filename: TabView.currentTab, title: nextTitle, artist }).catch(() => {});
    renderTabLibrary();
  }
}

async function selectTab(name) {
  TabView.currentTab = name;
  renderTabLibrary(); // updates the selected-row highlight immediately, before the (slower) load below
  document.getElementById("tabview-import-hint").textContent = "";
  document.getElementById("tabview-empty-state").style.display = "none";
  document.getElementById("tabview-player").style.display = "none";
  document.getElementById("tabview-loading-state").style.display = "";
  try {
    const api = await ensureTabViewApi();
    const resp = await fetch(`/api/tabs/file?filename=${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error(`server returned ${resp.status}`);
    const buf = await resp.arrayBuffer();
    api.load(buf);
    document.getElementById("tabview-loading-state").style.display = "none";
    document.getElementById("tabview-player").style.display = "";
  } catch (e) {
    document.getElementById("tabview-loading-state").style.display = "none";
    document.getElementById("tabview-empty-state").style.display = "";
    document.getElementById("tabview-import-hint").textContent = `Couldn't load "${name}": ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Transport — bound to alphaTab's own player API, not Audio/State (this
// screen's playback is alphaTab's built-in synth against a soundfont, a
// completely separate audio path from the rest of the app).
// ---------------------------------------------------------------------------

// True while the user has the scrub bar's thumb down — guards
// playerPositionChanged (above) from yanking the slider back to the
// actually-playing position mid-drag.
let tabviewScrubbing = false;

function formatTabViewTime(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function wireTabViewTransport() {
  document.getElementById("tabview-play-btn").addEventListener("click", () => {
    if (TabView.api) TabView.api.playPause();
  });
  document.getElementById("tabview-rig-btn").addEventListener("click", () => {
    setTabRigEnabled(!TabRig.enabled);
  });
  document.getElementById("tabview-stop-btn").addEventListener("click", () => {
    if (TabView.api) TabView.api.stop();
  });
  document.getElementById("tabview-loop-btn").addEventListener("click", (e) => {
    if (!TabView.api) return;
    TabView.api.isLooping = !TabView.api.isLooping;
    e.currentTarget.classList.toggle("active", TabView.api.isLooping);
  });
  document.getElementById("tabview-clear-selection-btn").addEventListener("click", () => {
    if (!TabView.api) return;
    TabView.api.playbackRange = null;
    TabView.api.clearPlaybackRangeHighlight();
  });
  document.getElementById("tabview-speed-slider").addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("tabview-speed-display").textContent = `${Math.round(val * 100)}%`;
    if (TabView.api) TabView.api.playbackSpeed = val;
  });

  // Scrub bar — seeks the TAB's own playback (api.timePosition, in ms),
  // separate from the song transport bar's timeline above (which seeks the
  // backing track via State/Audio). mousedown/up (not just "input") bracket
  // the whole drag gesture so playerPositionChanged doesn't fight a still-
  // in-progress drag between individual input events.
  const scrubEl = document.getElementById("tabview-scrub");
  scrubEl.addEventListener("mousedown", () => { tabviewScrubbing = true; });
  scrubEl.addEventListener("touchstart", () => { tabviewScrubbing = true; });
  const endScrub = () => {
    if (!tabviewScrubbing) return;
    tabviewScrubbing = false;
    if (TabView.api) TabView.api.timePosition = parseFloat(scrubEl.value);
  };
  scrubEl.addEventListener("mouseup", endScrub);
  scrubEl.addEventListener("touchend", endScrub);
  scrubEl.addEventListener("input", () => {
    document.getElementById("tabview-time-display").textContent =
      `${formatTabViewTime(parseFloat(scrubEl.value))} / ${formatTabViewTime(parseFloat(scrubEl.max))}`;
  });

  // Zoom — discrete steps rather than a slider, same as Mixer's Zoom to
  // loop/Zoom out pair conceptually, just re-rendering alphaTab's own
  // layout at a new scale instead of resizing a waveform view. 50%-200%,
  // same step size both directions so the two buttons feel symmetric.
  document.getElementById("tabview-zoom-in-btn").addEventListener("click", () => setTabViewZoom(TabViewZoom.scale + 0.1));
  document.getElementById("tabview-zoom-out-btn").addEventListener("click", () => setTabViewZoom(TabViewZoom.scale - 0.1));
}

const TabViewZoom = { scale: 1.0, min: 0.5, max: 2.0 };

function setTabViewZoom(scale) {
  TabViewZoom.scale = Math.min(TabViewZoom.max, Math.max(TabViewZoom.min, scale));
  document.getElementById("tabview-zoom-display").textContent = `${Math.round(TabViewZoom.scale * 100)}%`;
  if (!TabView.api) return;
  TabView.api.settings.display.scale = TabViewZoom.scale;
  TabView.api.updateSettings();
  TabView.api.render();
}

// ---------------------------------------------------------------------------
// Import (drag & drop or click-to-browse) — same smart-dropzone idiom as
// the sidebar's song import (wireImport, app.js), scoped to
// #tab-library-panel (the sidebar panel this screen swaps in) instead.
// ---------------------------------------------------------------------------

function wireTabViewImport() {
  const dropEl = document.getElementById("tabview-dropzone");
  const panelEl = document.getElementById("tab-library-panel");
  const inputEl = document.getElementById("tabview-import-input");

  const folderEl = document.getElementById("tabview-import-folder");

  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", (e) => {
    uploadTabFiles([...e.target.files]);
    inputEl.value = "";
  });
  const folderLink = document.getElementById("tabview-import-folder-link");
  if (folderLink) folderLink.addEventListener("click", (e) => { e.preventDefault(); folderEl.click(); });
  if (folderEl) folderEl.addEventListener("change", (e) => {
    uploadTabFiles([...e.target.files]);
    folderEl.value = "";
  });

  // stopPropagation, not just preventDefault: #tab-library-panel lives
  // inside #sidebar, which already has its OWN dragover/drop listeners for
  // the song Library's import zone (wireImport, app.js) — those are only
  // hidden (via #song-library-panel's display:none while Tab View is open),
  // not removed, so a drop here would otherwise bubble up and also trigger
  // the song importer, incorrectly trying to import a .gp5 as an audio
  // track. Stopping it here is simpler and more robust than teaching
  // wireImport's own handlers to check which screen is currently open.
  panelEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropEl.classList.add("dragover");
  });
  panelEl.addEventListener("dragleave", (e) => {
    if (!panelEl.contains(e.relatedTarget)) dropEl.classList.remove("dragover");
  });
  panelEl.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropEl.classList.remove("dragover");
    uploadTabFiles([...e.dataTransfer.files]);
  });
}

// Multi-file / whole-folder import. A folder pick (webkitdirectory) hands
// back everything inside it, most of which won't be tabs — so non-tab files
// are counted and reported rather than each raising its own error, which
// would bury the result of a 200-file drop in noise. Sequential on purpose:
// these go to the same local server, and firing 200 parallel uploads at it
// buys nothing.
async function uploadTabFiles(files) {
  const hintEl = document.getElementById("tabview-import-hint");
  const tabs = files.filter((f) => TABVIEW_TAB_EXTS.includes("." + (f.name.split(".").pop() || "").toLowerCase()));
  const skipped = files.length - tabs.length;
  if (!tabs.length) {
    hintEl.textContent = files.length
      ? `Nothing to import — none of those ${files.length} file(s) are Guitar Pro tabs (${TABVIEW_TAB_EXTS.join("/")}).`
      : "";
    return;
  }
  if (tabs.length === 1 && !skipped) return uploadTabFile(tabs[0]); // keep the single-file path's auto-open

  let done = 0;
  const failed = [];
  for (const f of tabs) {
    hintEl.textContent = `Importing ${done + 1} of ${tabs.length}: ${f.name}…`;
    try {
      await Api.postRaw(`/api/tabs/upload?filename=${encodeURIComponent(f.name)}`, await f.arrayBuffer());
      done++;
    } catch (e) {
      failed.push(f.name);
    }
  }
  await refreshTabLibrary();
  hintEl.textContent = `Imported ${done} tab${done === 1 ? "" : "s"}` +
    (skipped ? `, skipped ${skipped} non-tab file${skipped === 1 ? "" : "s"}` : "") +
    (failed.length ? `, ${failed.length} failed (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""})` : "") + ".";
}

// ---------------------------------------------------------------------------
// Tab search — find only, never fetch.
//
// See svc_tab_search in server.py for the full reasoning: no sanctioned API
// exists for downloading Guitar Pro files, so this searches Songsterr and
// links out. The absence of a Download button is the feature working as
// intended, and the panel says so rather than leaving you hunting for one.
// ---------------------------------------------------------------------------
function tabSearchStatus(msg) {
  const el = document.getElementById("tabsearch-status");
  if (el) el.textContent = msg || "";
}

async function runTabSearch() {
  const q = document.getElementById("tabsearch-query").value.trim();
  const list = document.getElementById("tabsearch-results");
  if (!q) { tabSearchStatus("Type a song or artist to search for."); return; }
  list.innerHTML = "";
  tabSearchStatus("Searching Songsterr…");
  try {
    const r = await Api.get(`/api/tabs/search?query=${encodeURIComponent(q)}`);
    const hits = r.results || [];
    if (!hits.length) {
      tabSearchStatus(r.unrecognized_shape
        ? "Songsterr answered, but not in a shape this build recognises — their search endpoint has probably changed."
        : "No tabs matched that.");
      return;
    }
    for (const hit of hits.slice(0, 25)) {
      const row = document.createElement("div");
      row.className = "tabsearch-result";
      row.innerHTML =
        `<div class="tabsearch-result-main">` +
        `<div class="tabsearch-result-title">${escapeHtml(hit.title || "Untitled")}</div>` +
        `<div class="tabsearch-result-meta">${escapeHtml(hit.artist || "")}</div></div>`;
      const a = document.createElement("a");
      a.href = hit.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "Open on Songsterr ↗";
      row.appendChild(a);
      list.appendChild(row);
    }
    tabSearchStatus(`${hits.length} result${hits.length === 1 ? "" : "s"} — open one on Songsterr, then drop the file above to import it. ` +
      `Orpheus doesn't download tabs: there's no licensed API for it, and their terms don't permit it.`);
  } catch (e) {
    tabSearchStatus(e.message || String(e));
  }
}

function wireTabSearch() {
  const btn = document.getElementById("tabsearch-btn");
  const box = document.getElementById("tabsearch-query");
  if (btn) btn.addEventListener("click", runTabSearch);
  if (box) box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runTabSearch(); } });
}


// ---------------------------------------------------------------------------
// Audio -> Guitar Pro tab (research/audio-to-tab-spec.md).
//
// The server (svc_transcribe_tab -> transcribe_stem_to_tab) does the DSP and
// hands back notes that already carry string/fret. This side turns those into
// an alphaTab Score and writes a real .gp with Gp7Exporter.
//
// Two things worth knowing before editing:
//
//   1. The exporter is NOT in alphaTab.min.mjs — it is tree-shaken out, and
//      that is the module the rest of this screen imports. Export has to pull
//      alphaTab.core.mjs, which is why this does its own dynamic import
//      rather than reusing loadAlphaTabModule(). Verified: importing a real
//      .gp5 and re-exporting round-trips to a valid ZIP with title, tracks
//      and bars intact.
//   2. v1 is LEAD LINES. The pitch tracker is monophonic, so chords come back
//      as nothing at all — measured, on controlled input: single notes read
//      95.7% confident frames, power chords and triads both 0.0%. The server
//      flags that as `polyphonic` so this can explain itself instead of
//      silently producing an empty tab, which is exactly what the first real
//      separated stem did.
// ---------------------------------------------------------------------------
const TABGEN_TUNINGS = [
  "E standard", "Drop D", "D standard", "Drop C", "C# standard",
  "Drop C#", "B standard", "Drop B", "7-string B",
];
const TABGEN_STARTS = [
  ["playhead", "From the playhead"], ["loop", "Loop selection"], ["0", "From the start"],
];
const TABGEN_LENGTHS = [
  ["15", "15 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["0", "To the end (slow)"],
];

// Resolve the two pickers into an actual {start, end} window in song time.
// Kept separate from tabGenerate so the hint under the button can show
// exactly what is about to be transcribed BEFORE committing to a run that
// takes a while — picking the wrong section and waiting is the annoying
// failure mode this avoids.
function tabGenWindow() {
  const startMode = (document.getElementById("tabgen-start") || {}).value || "playhead";
  const lenSec = Number((document.getElementById("tabgen-length") || {}).value || 30);

  if (startMode === "loop") {
    const loop = (typeof State !== "undefined" && State.ui && State.ui.loop) || null;
    if (!loop || !(loop.end > loop.start)) {
      return { error: "No loop selection — drag a loop range in the Mixer first, or pick another start point." };
    }
    // The loop defines BOTH ends; the length picker doesn't apply.
    return { start: loop.start, end: loop.end, source: "loop selection" };
  }

  let start = 0;
  if (startMode === "playhead") {
    start = (typeof currentPosition === "function" ? currentPosition() : 0) || 0;
  }
  const end = lenSec ? start + lenSec : null;
  return { start, end, source: startMode === "playhead" ? "playhead" : "song start" };
}

function tabGenFormatTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function tabGenRenderWindow() {
  const el = document.getElementById("tabgen-window");
  if (!el) return;
  const w = tabGenWindow();
  const lenEl = document.getElementById("tabgen-length");
  // A loop selection carries its own length, so the length picker would be
  // a lie next to it.
  if (lenEl) lenEl.disabled = (document.getElementById("tabgen-start") || {}).value === "loop";
  if (w.error) { el.textContent = w.error; return; }
  const span = w.end == null ? "to the end" : `${tabGenFormatTime(w.start)} - ${tabGenFormatTime(w.end)}`;
  const secs = w.end == null ? null : Math.round(w.end - w.start);
  el.textContent = `Will transcribe ${span} (${w.source})` +
    (secs ? ` - about ${Math.max(1, Math.round(secs * 0.65))}s of processing.` : ".");
}

function tabGenStatus(msg) {
  const el = document.getElementById("tabgen-status");
  if (el) el.textContent = msg || "";
}

function wireTabGenerate() {
  const tuningEl = document.getElementById("tabgen-tuning");
  const startEl = document.getElementById("tabgen-start");
  const lenEl = document.getElementById("tabgen-length");
  if (tuningEl && !tuningEl.options.length) for (const t of TABGEN_TUNINGS) tuningEl.appendChild(new Option(t, t));
  if (startEl && !startEl.options.length) for (const [v, l] of TABGEN_STARTS) startEl.appendChild(new Option(l, v));
  if (lenEl && !lenEl.options.length) for (const [v, l] of TABGEN_LENGTHS) lenEl.appendChild(new Option(l, v));
  if (lenEl) lenEl.value = "30";
  if (startEl) startEl.addEventListener("change", tabGenRenderWindow);
  if (lenEl) lenEl.addEventListener("change", tabGenRenderWindow);
  const btn = document.getElementById("tabgen-btn");
  if (btn) btn.addEventListener("click", tabGenerate);
  tabGenRenderWindow();
}

// Build an alphaTab Score from the server's note list and export it.
async function tabGenBuildAndExport(at, data, songTitle, songArtist) {
  const M = at.model;
  const score = new M.Score();
  score.title = songTitle || "Transcribed";
  score.artist = songArtist || "";
  // Score.tempo is READ-ONLY in alphaTab — it reads through to
  // masterBars[0].tempoAutomations[0]. Assigning it throws
  // "Cannot set property tempo of #<Score> which has only a getter", so the
  // tempo goes on the first MasterBar as an automation instead (below).
  const tempoBpm = Math.round(data.bpm || 120);

  const track = new M.Track();
  track.name = "Transcribed guitar";
  score.addTrack(track);
  // A fresh Track has NO staves — track.staves[0] is undefined until one is
  // added, which throws on the very next line if you assume otherwise.
  const staff = new M.Staff();
  track.addStaff(staff);
  // stringTuning is ordered top tablature line first, i.e. HIGH string
  // first, while the server sends open strings low-to-high (the order a
  // player names them). Hence the reverse; getting it wrong silently writes
  // an upside-down tab that still opens fine.
  staff.stringTuning = new M.Tuning(data.tuning || "", [...data.tuning_midi].reverse(), false);
  staff.showTablature = true;
  staff.showStandardNotation = true;

  const byBar = new Map();
  for (const n of data.notes) {
    if (!byBar.has(n.bar)) byBar.set(n.bar, []);
    byBar.get(n.bar).push(n);
  }
  const lastBar = Math.max(0, ...byBar.keys());

  for (let b = 0; b <= lastBar; b++) {
    const master = new M.MasterBar();
    // v1 writes 4/4. The server groups notes into 4-beat bars to match; a
    // real meter detector is a separate job and guessing here would silently
    // misbar everything.
    master.timeSignatureNumerator = 4;
    master.timeSignatureDenominator = 4;
    if (b === 0) master.tempoAutomations.push(M.Automation.buildTempoAutomation(false, 0, tempoBpm, 0));
    score.addMasterBar(master);

    const bar = new M.Bar();
    staff.addBar(bar);
    const voice = new M.Voice();
    bar.addVoice(voice);

    const notes = (byBar.get(b) || []).sort((x, y) => x.onset - y.onset);
    if (!notes.length) {
      const rest = new M.Beat();
      rest.isEmpty = true;
      rest.duration = M.Duration.Whole;
      voice.addBeat(rest);
      continue;
    }
    // Walk the bar's grid rather than just appending notes back to back.
    // Appending packs every bar hard against beat 1 and writes each note as a
    // single grid unit, which is what made the first exports sound staccato
    // and land nowhere near the recording. Gaps become rests, and a note held
    // over several steps becomes tied beats.
    const barSteps = notes[0].bar_steps || 16;
    const trip = !!notes[0].triplet;
    let pos = 0;
    for (const n of notes) {
      const at = Math.max(pos, n.gp_step || 0);
      if (at > pos) tabGenAddRests(M, voice, pos, at - pos, n.gp_duration, trip);
      const len = Math.max(1, Math.min(n.gp_steps || 1, barSteps - at));
      tabGenAddNote(M, voice, at, len, n, trip);
      pos = at + len;
    }
    if (pos < barSteps) {
      tabGenAddRests(M, voice, pos, barSteps - pos, notes[0].gp_duration, trip);
    }
  }
  score.finish(new at.Settings());

  const exporter = new at.exporter.Gp7Exporter();
  return exporter.export(score, new at.Settings());
}

// Split a run of `steps` grid units starting at `pos` into beats a score can
// actually hold: powers of two that don't straddle a metric boundary. On a
// triplet grid nothing merges — a merged triplet needs a nested tuplet, and
// writing one wrong is worse than writing three tied notes.
function tabGenSplitRun(pos, steps, denom, triplet) {
  const chunks = [];
  let p = pos, k = steps;
  while (k > 0) {
    let c = 1;
    if (!triplet) {
      while (c * 2 <= k && p % (c * 2) === 0 && denom % (c * 2) === 0) c *= 2;
    }
    chunks.push({ denom: denom / c, steps: c });
    p += c; k -= c;
  }
  return chunks;
}

function tabGenAddRests(M, voice, pos, steps, denom, triplet) {
  for (const c of tabGenSplitRun(pos, steps, denom, triplet)) {
    const beat = new M.Beat();
    beat.duration = tabGenDuration(M, c.denom);
    beat.isEmpty = true;  // an empty beat IS a rest in alphaTab's model
    if (triplet) { beat.tupletNumerator = 3; beat.tupletDenominator = 2; }
    voice.addBeat(beat);
  }
}

function tabGenAddNote(M, voice, pos, steps, n, triplet) {
  const chunks = tabGenSplitRun(pos, steps, n.gp_duration, triplet);
  chunks.forEach((c, i) => {
    const beat = new M.Beat();
    beat.duration = tabGenDuration(M, c.denom);
    if (triplet) { beat.tupletNumerator = 3; beat.tupletDenominator = 2; }
    const note = new M.Note();
    note.string = n.string;
    note.fret = n.fret;
    // Everything after the first chunk continues the same sounding note.
    // score.finish() resolves tieOrigin from the previous beat on this string.
    if (i > 0) note.isTieDestination = true;
    beat.addNote(note);
    voice.addBeat(beat);
  });
}

function tabGenDuration(M, denom) {
  switch (denom) {
    case 1: return M.Duration.Whole;
    case 2: return M.Duration.Half;
    case 4: return M.Duration.Quarter;
    case 8: return M.Duration.Eighth;
    case 16: return M.Duration.Sixteenth;
    case 32: return M.Duration.ThirtySecond;
    default: return M.Duration.Eighth;
  }
}

async function tabGenerate() {
  if (typeof State === "undefined" || !State.track) {
    tabGenStatus("Load a song in the Mixer first — the tab is generated from its separated guitar stem.");
    return;
  }
  const btn = document.getElementById("tabgen-btn");
  const tuning = document.getElementById("tabgen-tuning").value;
  const win = tabGenWindow();
  if (win.error) { tabGenStatus(win.error); return; }
  btn.disabled = true;
  tabGenStatus("Listening to the guitar stem… (pitch tracking runs about 1.5x faster than real time)");
  try {
    const data = await Api.post("/api/transcribe_tab", {
      source_path: State.track, model: State.model,
      // GP-16: on an imported stem pack there is no file called guitar.wav,
      // so pass whichever stem the user nominated on its mixer lane — the
      // same resolution Rate My Take and Suggest a Tone use.
      stem: (typeof resolvedGuitarStemName === "function" ? resolvedGuitarStemName() : "") || "",
      tuning, start_sec: win.start, end_sec: win.end,
    });

    if (data.polyphonic || !data.notes.length) {
      tabGenStatus(data.polyphonic
        ? `No single-note line found — this stem reads as polyphonic (chords). Confidence ${data.voiced_mean}, ` +
          `where single notes measure ~0.9 and chords ~0.01. Version 1 transcribes lead lines only; ` +
          `try a section with a solo, or a lead-guitar stem if this song has one.`
        : "No confident notes found in that section — try a part where the guitar is clearly audible.");
      return;
    }

    tabGenStatus(`Found ${data.note_count} notes — writing the tab…`);
    const at = await import("./vendor/alphatab/alphaTab.core.mjs");
    let artist = "", title = "";
    try {
      const info = await Api.get(`/api/trackinfo?track=${encodeURIComponent(State.track)}`);
      artist = info.artist || info.guessed_artist || "";
      title = info.title || info.guessed_title || "";
    } catch (e) { /* untitled is fine */ }

    const bytes = await tabGenBuildAndExport(at, data, title ? `${title} (transcribed)` : "Transcribed", artist);
    const stamp = data.start_sec ? ` ${tabGenFormatTime(data.start_sec).replace(":", "m")}s` : "";
    const filename = `${(title || State.track).replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "")} transcribed${stamp}.gp`;
    const saved = await Api.postRaw(`/api/tabs/upload?filename=${encodeURIComponent(filename)}`, bytes.buffer || bytes);
    await refreshTabLibrary();
    await selectTab(saved.name);

    const caveats = [];
    if (data.fast_note_count) {
      caveats.push(`${data.fast_note_count} note(s) are faster than ${data.reliable_note_sec}s, where pitch tracking ` +
                   `gets unreliable — check those by ear`);
    }
    if (Math.abs(data.tuning_offset_cents) > 20) {
      caveats.push(`the recording sits ${data.tuning_offset_cents} cents off concert pitch, which was corrected for`);
    }
    const fromTo = data.end_sec != null
      ? `${tabGenFormatTime(data.start_sec)}-${tabGenFormatTime(data.end_sec)}`
      : `from ${tabGenFormatTime(data.start_sec)}`;
    tabGenStatus(`Wrote "${saved.name}" — ${data.note_count} notes in ${data.tuning}, from ${fromTo}. ` +
      `This is a machine transcription of a separated stem, so treat it as a starting point, not gospel.` +
      (caveats.length ? " Note: " + caveats.join("; ") + "." : ""));
  } catch (e) {
    tabGenStatus(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

async function uploadTabFile(file) {
  const hintEl = document.getElementById("tabview-import-hint");
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  if (!TABVIEW_TAB_EXTS.includes(ext)) {
    hintEl.textContent = `"${file.name}" isn't a Guitar Pro tab file (${TABVIEW_TAB_EXTS.join("/")}).`;
    return;
  }
  hintEl.textContent = `Importing ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const r = await Api.postRaw(`/api/tabs/upload?filename=${encodeURIComponent(file.name)}`, buf);
    hintEl.textContent = "";
    await refreshTabLibrary();
    selectTab(r.name);
  } catch (e) {
    hintEl.textContent = `Import failed: ${e.message || e}`;
  }
}

// ---------------------------------------------------------------------------
// Library + playlists — same "All Tabs" + collapsible playlist-group shape
// as the song Library sidebar (renderTrackList, app.js), reusing its exact
// CSS classes (.track-row/.playlist-group/.track-add-to-playlist etc.) so
// this looks like the same component family without needing new styling.
// A flatter feature set than the song Library's own version on purpose —
// no auto-play, no drag-to-reorder within a playlist — since a tab
// playlist is "a collection to switch between," not a set to play straight
// through unattended the way a Play Along setlist is.
// ---------------------------------------------------------------------------

function tabDisplayLabel(t) {
  if (t.title || t.artist) return `${t.title || t.name}${t.artist ? " — " + t.artist : ""}`;
  return t.name;
}

async function refreshTabLibrary() {
  try {
    const r = await Api.get("/api/tabs");
    TabView.library = r.tabs || [];
    TabView.playlists = r.playlists || {};
  } catch (e) {
    TabView.library = [];
    TabView.playlists = {};
  }
  renderTabLibrary();
}

// Same shape as renderTrackList (app.js): "All Tabs" first, then each
// playlist as its own collapsible group, all in the one list — no separate
// "Playlists" heading/list, matching the song Library's own layout exactly
// now that this replaces it in the same sidebar spot.
function renderTabLibrary() {
  const el = document.getElementById("tabview-library-list");
  el.innerHTML = "";
  el.appendChild(renderTabAllGroup());

  const names = Object.keys(TabView.playlists).sort((a, b) => a.localeCompare(b));
  for (const name of names) el.appendChild(renderTabPlaylistGroup(name));
}

function renderTabAllGroup() {
  const expanded = TabView.expandedPlaylists.has(TABVIEW_ALL_GROUP_KEY);
  const group = document.createElement("div");
  group.className = "playlist-group";

  const header = document.createElement("div");
  header.className = "playlist-group-header playlist-group-header-interactive";
  header.innerHTML = `
    <button class="playlist-group-toggle" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▾" : "▸"}</button>
    <span class="playlist-group-name">All Tabs</span>
    <span class="playlist-group-count">${TabView.library.length}</span>`;
  group.appendChild(header);

  const toggleGroup = () => {
    if (TabView.expandedPlaylists.has(TABVIEW_ALL_GROUP_KEY)) TabView.expandedPlaylists.delete(TABVIEW_ALL_GROUP_KEY);
    else TabView.expandedPlaylists.add(TABVIEW_ALL_GROUP_KEY);
    renderTabLibrary();
  };
  header.querySelector(".playlist-group-toggle").addEventListener("click", toggleGroup);
  header.querySelector(".playlist-group-name").addEventListener("click", toggleGroup);

  if (expanded) {
    if (!TabView.library.length) {
      const hint = document.createElement("p");
      hint.className = "hint playlist-group-empty-hint";
      hint.textContent = "No tabs yet — drop a Guitar Pro file above to import one.";
      group.appendChild(hint);
    } else {
      for (const t of TabView.library) group.appendChild(renderTabLibraryRow(t));
    }
  }
  return group;
}

function renderTabLibraryRow(t) {
  const row = document.createElement("div");
  row.className = "track-row" + (t.name === TabView.currentTab ? " selected" : "");
  row.innerHTML = `<span class="track-name">${escapeHtml(tabDisplayLabel(t))}</span>`;
  row.appendChild(renderTabAddToPlaylistControl(t.name));
  row.appendChild(renderTabRenameButton(t.name));
  row.appendChild(renderTabDeleteButton(t.name));
  row.addEventListener("click", () => selectTab(t.name));
  return row;
}

function renderTabRenameButton(name) {
  const btn = document.createElement("button");
  btn.className = "track-rename-btn";
  btn.title = "Rename tab";
  btn.textContent = "✎";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const base = name.replace(/\.[^.]+$/, "");
    const newName = await textPrompt("Rename tab to:", base);
    if (!newName || !newName.trim() || newName.trim() === base) return;
    try {
      const r = await Api.post("/api/tabs/rename", { filename: name, new_name: newName.trim() });
      if (TabView.currentTab === name) TabView.currentTab = r.name;
      await refreshTabLibrary();
    } catch (err) {
      alert(`Rename failed: ${err.message || err}`);
    }
  });
  return btn;
}

function renderTabDeleteButton(name) {
  const btn = document.createElement("button");
  btn.className = "track-delete-btn";
  btn.title = "Delete tab";
  btn.textContent = "✕";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${name}"? This can't be undone.`)) return;
    try {
      await Api.post("/api/tabs/delete", { filename: name });
      if (TabView.currentTab === name) {
        TabView.currentTab = null;
        if (TabView.api) TabView.api.stop();
        document.getElementById("tabview-player").style.display = "none";
        document.getElementById("tabview-empty-state").style.display = "";
      }
      await refreshTabLibrary();
    } catch (err) {
      alert(`Delete failed: ${err.message || err}`);
    }
  });
  return btn;
}

// Which tab's add-to-playlist popover should reopen after a re-render —
// same pattern as openAddToPlaylistFor (app.js), scoped to this screen.
let tabviewOpenAddToPlaylistFor = null;

function renderTabAddToPlaylistControl(name) {
  const wrap = document.createElement("details");
  wrap.className = "track-add-to-playlist";
  if (tabviewOpenAddToPlaylistFor === name) wrap.open = true;
  wrap.addEventListener("click", (e) => e.stopPropagation());
  wrap.addEventListener("toggle", () => { tabviewOpenAddToPlaylistFor = wrap.open ? name : null; });

  const summary = document.createElement("summary");
  summary.title = "Add to playlist";
  summary.textContent = "+";
  wrap.appendChild(summary);

  const menu = document.createElement("div");
  menu.className = "track-add-to-playlist-menu";
  const names = Object.keys(TabView.playlists).sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    menu.innerHTML = '<p class="hint">No playlists yet.</p>';
  } else {
    for (const pname of names) {
      const label = document.createElement("label");
      const checked = TabView.playlists[pname].includes(name);
      label.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}> ${escapeHtml(pname)}`;
      label.querySelector("input").addEventListener("change", async (e) => {
        const list = TabView.playlists[pname];
        if (e.target.checked) {
          if (!list.includes(name)) list.push(name);
        } else {
          TabView.playlists[pname] = list.filter((n) => n !== name);
        }
        tabviewOpenAddToPlaylistFor = null;
        await persistTabPlaylists();
        renderTabLibrary();
      });
      menu.appendChild(label);
    }
  }
  const newBtn = document.createElement("button");
  newBtn.className = "track-add-to-playlist-new-btn";
  newBtn.textContent = "+ New playlist…";
  newBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const pname = await textPrompt("New playlist name:");
    if (!pname || !pname.trim()) return;
    const trimmed = pname.trim();
    if (TabView.playlists[trimmed]) { alert(`A playlist named "${trimmed}" already exists.`); return; }
    TabView.playlists[trimmed] = [name];
    tabviewOpenAddToPlaylistFor = null;
    await persistTabPlaylists();
    renderTabLibrary();
  });
  menu.appendChild(newBtn);
  wrap.appendChild(menu);
  return wrap;
}

function renderTabPlaylistGroup(name) {
  const tracks = TabView.playlists[name];
  const expanded = TabView.expandedPlaylists.has(name);
  const group = document.createElement("div");
  group.className = "playlist-group";

  const header = document.createElement("div");
  header.className = "playlist-group-header playlist-group-header-interactive";
  header.innerHTML = `
    <button class="playlist-group-toggle" title="${expanded ? "Collapse" : "Expand"}">${expanded ? "▾" : "▸"}</button>
    <span class="playlist-group-name">${escapeHtml(name)}</span>
    <span class="playlist-group-count">${tracks.length}</span>
    <button class="playlist-group-rename-btn" title="Rename playlist">✎</button>
    <button class="playlist-group-delete-btn" title="Delete playlist">✕</button>`;
  group.appendChild(header);

  const toggleGroup = () => {
    if (TabView.expandedPlaylists.has(name)) TabView.expandedPlaylists.delete(name);
    else TabView.expandedPlaylists.add(name);
    renderTabLibrary();
  };
  header.querySelector(".playlist-group-toggle").addEventListener("click", toggleGroup);
  header.querySelector(".playlist-group-name").addEventListener("click", toggleGroup);

  header.querySelector(".playlist-group-rename-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const newName = await textPrompt("Rename playlist to:", name);
    if (!newName || !newName.trim() || newName.trim() === name) return;
    const trimmed = newName.trim();
    if (TabView.playlists[trimmed]) { alert(`A playlist named "${trimmed}" already exists.`); return; }
    TabView.playlists[trimmed] = TabView.playlists[name];
    delete TabView.playlists[name];
    if (TabView.expandedPlaylists.has(name)) { TabView.expandedPlaylists.delete(name); TabView.expandedPlaylists.add(trimmed); }
    await persistTabPlaylists();
    renderTabLibrary();
  });

  header.querySelector(".playlist-group-delete-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete playlist "${name}"? This can't be undone (the tabs themselves are untouched).`)) return;
    delete TabView.playlists[name];
    TabView.expandedPlaylists.delete(name);
    await persistTabPlaylists();
    renderTabLibrary();
  });

  if (expanded) {
    if (!tracks.length) {
      const hint = document.createElement("p");
      hint.className = "hint playlist-group-empty-hint";
      hint.textContent = 'Empty — use "+" on a tab above to add it here.';
      group.appendChild(hint);
    } else {
      for (const tabName of tracks) group.appendChild(renderTabPlaylistMemberRow(name, tabName));
    }
  }
  return group;
}

function renderTabPlaylistMemberRow(playlistName, tabName) {
  const row = document.createElement("div");
  row.className = "track-row playlist-track-row" + (tabName === TabView.currentTab ? " selected" : "");
  const entry = TabView.library.find((t) => t.name === tabName);
  row.innerHTML = `
    <span class="track-name">${escapeHtml(entry ? tabDisplayLabel(entry) : tabName)}</span>
    <button class="playlist-track-remove-btn" title="Remove from playlist">✕</button>`;
  row.querySelector(".playlist-track-remove-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    TabView.playlists[playlistName] = TabView.playlists[playlistName].filter((n) => n !== tabName);
    await persistTabPlaylists();
    renderTabLibrary();
  });
  row.addEventListener("click", () => selectTab(tabName));
  return row;
}

async function persistTabPlaylists() {
  await Api.post("/api/tabs/playlists", { playlists: TabView.playlists });
}

// ---------------------------------------------------------------------------
// Open/close — same mutual-exclusivity idiom as Tone Lab/Play Along/AI Lab
// (playalong.js/ailab.js), extended to also close this screen from theirs.
// ---------------------------------------------------------------------------

async function openTabView() {
  document.getElementById("tabview-overlay").classList.add("show");
  document.getElementById("tonelab-overlay").classList.remove("show");
  document.getElementById("playalong-overlay").classList.remove("show");
  if (typeof closeAiLab === "function") closeAiLab();
  // Swap the main sidebar over to this screen's own library — direct
  // request: Tab View's library/dropzone should replace the song Library/
  // import zone entirely while this screen is open, not sit in a second
  // sidebar next to it.
  document.getElementById("song-library-panel").style.display = "none";
  document.getElementById("tab-library-panel").style.display = "";
  paSetActiveScreen("tabview-open-btn");
  // Picking a track from the Library always calls closeAllScreens (app.js's
  // selectTrack) — since that includes this screen, State.track can only
  // actually change while Tab View is closed, so a one-time read on open is
  // enough; no live-update hook needed for the rest of this screen's visit.
  updateTrackPlayBarTitles();
  await refreshTabLibrary();
}

function closeTabView() {
  document.getElementById("tabview-overlay").classList.remove("show");
  document.getElementById("tab-library-panel").style.display = "none";
  document.getElementById("song-library-panel").style.display = "";
  // Stops alphaTab's own synth so leaving this screen doesn't leave audio
  // playing from a hidden one — this screen's playback is entirely
  // separate from the rest of the app's Audio/State.
  if (TabView.api) TabView.api.stop();
}

function wireTabView() {
  document.getElementById("tabview-open-btn").addEventListener("click", openTabView);
  document.getElementById("tabview-close-btn").addEventListener("click", closeTabView);
  wireTabViewImport();
  wireTabSearch();
  wireTabGenerate();
  wireTabViewTransport();
}

wireTabView();
