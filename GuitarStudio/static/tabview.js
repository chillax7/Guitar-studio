"use strict";

// ---------------------------------------------------------------------------
// Tab View (orpheus-tabview-spec.md, adapted to this app's architecture) — a
// screen for dragging & dropping Guitar Pro tab files (.gp3/.gp4/.gp5/.gpx)
// for viewing and playback, rendered client-side by alphaTab (self-hosted,
// see static/vendor/alphatab/README.txt — never a CDN, matching this app's
// local-first design). A tab file has no stems/mix/rig, so it gets its own
// small library scoped to this screen rather than living in the main
// sidebar's song Library — see server.py's "Tab View" section for the
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
      soundFont: "vendor/alphatab/soundfont/sonivox.sf3",
    },
  });

  api.scoreLoaded.on((score) => onTabScoreLoaded(score));
  api.error.on((err) => {
    console.error("alphaTab error", err);
    const message = err && err.message ? err.message : String(err);
    document.getElementById("tabview-import-hint").textContent = `Couldn't load tab: ${message}`;
    document.getElementById("tabview-loading-state").style.display = "none";
    document.getElementById("tabview-empty-state").style.display = "";
  });

  TabView.api = api;
  return api;
}

function onTabScoreLoaded(score) {
  const title = score.title || "";
  const artist = score.artist || "";
  document.getElementById("tabview-track-title").textContent = title || TabView.currentTab;
  document.getElementById("tabview-track-artist").textContent = artist;

  // alphaTab already parsed this metadata as part of loading the file for
  // rendering — reusing it here (rather than a second, server-side GP-file
  // parser just to read the same two fields) is the whole reason
  // svc_tab_set_metadata exists as a client-reported PUT instead of
  // something svc_tab_upload does itself. Best-effort: a failed save here
  // just means the library list keeps showing the bare filename a little
  // longer, not a broken tab.
  const entry = TabView.library.find((t) => t.name === TabView.currentTab);
  if (entry && (entry.title !== title || entry.artist !== artist)) {
    entry.title = title;
    entry.artist = artist;
    Api.post("/api/tabs/metadata", { filename: TabView.currentTab, title, artist }).catch(() => {});
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

function wireTabViewTransport() {
  document.getElementById("tabview-play-btn").addEventListener("click", () => {
    if (TabView.api) TabView.api.playPause();
  });
  document.getElementById("tabview-stop-btn").addEventListener("click", () => {
    if (TabView.api) TabView.api.stop();
  });
  document.getElementById("tabview-loop-btn").addEventListener("click", (e) => {
    if (!TabView.api) return;
    TabView.api.isLooping = !TabView.api.isLooping;
    e.currentTarget.classList.toggle("active", TabView.api.isLooping);
  });
  document.getElementById("tabview-speed-slider").addEventListener("input", (e) => {
    const val = parseFloat(e.target.value);
    document.getElementById("tabview-speed-display").textContent = `${Math.round(val * 100)}%`;
    if (TabView.api) TabView.api.playbackSpeed = val;
  });
}

// ---------------------------------------------------------------------------
// Import (drag & drop or click-to-browse) — same smart-dropzone idiom as
// the sidebar's song import (wireImport, app.js), scoped to this screen's
// own dropzone/sidebar instead.
// ---------------------------------------------------------------------------

function wireTabViewImport() {
  const dropEl = document.getElementById("tabview-dropzone");
  const sidebarEl = document.getElementById("tabview-sidebar");
  const inputEl = document.getElementById("tabview-import-input");

  dropEl.addEventListener("click", () => inputEl.click());
  inputEl.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) uploadTabFile(f);
    inputEl.value = "";
  });

  // The document-level dragover/drop preventDefault() that stops an
  // off-target drop from navigating the whole tab away is already installed
  // once by wireImport() (app.js) — no need for a second copy here.
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
    if (f) uploadTabFile(f);
  });
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

function renderTabLibrary() {
  const el = document.getElementById("tabview-library-list");
  el.innerHTML = "";
  el.appendChild(renderTabAllGroup());

  const playlistsEl = document.getElementById("tabview-playlists-list");
  playlistsEl.innerHTML = "";
  const names = Object.keys(TabView.playlists).sort((a, b) => a.localeCompare(b));
  for (const name of names) playlistsEl.appendChild(renderTabPlaylistGroup(name));
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
  paSetActiveScreen("tabview-open-btn");
  await refreshTabLibrary();
}

function closeTabView() {
  document.getElementById("tabview-overlay").classList.remove("show");
  // Stops alphaTab's own synth so leaving this screen doesn't leave audio
  // playing from a hidden one — this screen's playback is entirely
  // separate from the rest of the app's Audio/State.
  if (TabView.api) TabView.api.stop();
}

function wireTabView() {
  document.getElementById("tabview-open-btn").addEventListener("click", openTabView);
  document.getElementById("tabview-close-btn").addEventListener("click", closeTabView);
  document.getElementById("tabview-new-playlist-btn").addEventListener("click", async () => {
    const name = await textPrompt("New playlist name:");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    if (TabView.playlists[trimmed]) { alert(`A playlist named "${trimmed}" already exists.`); return; }
    TabView.playlists[trimmed] = [];
    TabView.expandedPlaylists.add(trimmed);
    await persistTabPlaylists();
    renderTabLibrary();
  });
  wireTabViewImport();
  wireTabViewTransport();
}

wireTabView();
