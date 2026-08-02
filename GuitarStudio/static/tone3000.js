"use strict";

// ---------------------------------------------------------------------------
// TONE3000 integration — search the public tone catalogue from Tone Lab and
// download captures straight into the local NAM/IR library.
//
// Written against TONE3000's own MIT-licensed reference client
// (github.com/tone-3000/api), not guessed at. The parts that matter:
//
//   Auth      OAuth 2.0 + PKCE. The publishable key (t3k_pub_...) is the
//             client_id, NOT a bearer credential — there is no key-only read
//             path, every endpoint below wants `Authorization: Bearer
//             <access_token>` from a completed flow. That is why connecting
//             is a required first step rather than something we can skip
//             when the user just wants to search.
//   Search    GET /api/v1/tones/search
//             query, page, page_size, sort, gears, format, sizes, tags,
//             makes, creators, architecture. Multi-value params are
//             underscore-joined EXCEPT creators, which is comma-joined —
//             copied verbatim from buildSearchTonesQuery in the reference
//             client, because getting that wrong fails as "no results"
//             rather than as an error.
//   Models    GET /api/v1/models?tone_id=N -> [{ model_url, name, size,
//             architecture_version, ... }]. A tone is a listing; the model
//             is the actual downloadable file, and a tone can have several
//             (Standard/Lite/Feather/Nano).
//   Download  model_url must be fetched WITH the Bearer header — it is not a
//             public URL. The reference client is explicit about this.
//
// Rate limit: 100 requests/minute, and TONE3000's own docs describe the
// search endpoint as heavily rate-limited by default, recommending the
// hosted "Select" browse flow instead for catalogue browsing. Both are
// wired up here: search (what you asked for, one request per search, no
// auto-search-as-you-type for exactly this reason) and "Browse on TONE3000"
// (their hosted picker, no search calls at all).
//
// Deliberately its own file, matching the per-feature split already in use
// (app.js=Mixer, playalong.js=Tone Lab/Play Along, tabview.js=Tab View).
// ---------------------------------------------------------------------------

const T3K_API = "https://www.tone3000.com";
const T3K_TOKENS_KEY = "gs_t3k_tokens";
const T3K_VERIFIER_KEY = "gs_t3k_code_verifier";
const T3K_STATE_KEY = "gs_t3k_state";
const T3K_PENDING_KEY = "gs_t3k_pending_flow";
const T3K_RETURN_SCREEN_KEY = "gs_t3k_return_screen";

const T3K = {
  publishableKey: "",
  tokens: null,        // { access_token, refresh_token, expires_at }
  results: [],         // current page of Tone objects
  page: 1,
  totalPages: 0,
  total: 0,
  lastParams: null,    // so paging repeats the same search
  busy: false,
};

// Enum values, verbatim from the reference client's types.ts. Kept as data
// so the filter UI and the query builder can never disagree about what the
// API actually accepts.
const T3K_GEARS = [
  ["amp", "Amp"], ["amp-cab", "Amp + Cab"], ["pedal", "Pedal"],
  ["outboard", "Outboard"], ["cab", "Cab"], ["space", "Space"],
  ["experimental", "Experimental"],
];
const T3K_FORMATS = [["nam", "NAM"], ["ir", "IR"], ["aida-x", "AIDA-X"], ["aa-snapshot", "AA Snapshot"], ["proteus", "Proteus"]];
const T3K_SIZES = [["standard", "Standard"], ["lite", "Lite"], ["feather", "Feather"], ["nano", "Nano"], ["custom", "Custom"]];
const T3K_SORTS = [
  ["best-match", "Best match"], ["trending", "Trending"],
  ["downloads-all-time", "Most downloaded"], ["newest", "Newest"], ["oldest", "Oldest"],
];

// ---------------------------------------------------------------------------
// PKCE helpers — same construction as the reference client (SHA-256 / S256,
// base64url without padding).
// ---------------------------------------------------------------------------

function t3kBase64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function t3kRandomBase64Url(n) {
  return t3kBase64Url(crypto.getRandomValues(new Uint8Array(n)));
}

async function t3kSha256Base64Url(text) {
  return t3kBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// The redirect target is this app's own origin. TONE3000 validates it
// against what's registered for the publishable key, so it has to match
// exactly — including the port. Surfaced in the UI for that reason.
function t3kRedirectUri() {
  return window.location.origin + "/";
}

// ---------------------------------------------------------------------------
// Token storage. sessionStorage (not localStorage) on purpose: these are real
// user credentials for someone's TONE3000 account, and a practice session
// ending is a perfectly good reason to drop them. The publishable key, which
// is not a credential, is the part that persists (server-side settings).
// ---------------------------------------------------------------------------

function t3kLoadTokens() {
  try {
    const raw = sessionStorage.getItem(T3K_TOKENS_KEY);
    T3K.tokens = raw ? JSON.parse(raw) : null;
  } catch (e) { T3K.tokens = null; }
  return T3K.tokens;
}

function t3kSaveTokens(tokens) {
  T3K.tokens = tokens;
  try { sessionStorage.setItem(T3K_TOKENS_KEY, JSON.stringify(tokens)); } catch (e) { /* private mode */ }
}

function t3kClearTokens() {
  T3K.tokens = null;
  try { sessionStorage.removeItem(T3K_TOKENS_KEY); } catch (e) { /* nothing to clear */ }
}

function t3kIsConnected() {
  return !!(T3K.tokens && T3K.tokens.access_token);
}

// ---------------------------------------------------------------------------
// OAuth flows
// ---------------------------------------------------------------------------

// Both flows leave the app entirely (window.location -> TONE3000 -> back),
// so the return trip is a FULL PAGE LOAD and the app boots on its default
// screen — the Mixer. Reported as "hitting Connect works but switches the
// view back to the Mixer". Remember which screen was open and restore it
// once the redirect has been handled.
function t3kRememberScreen() {
  const open = ["tonelab-overlay", "playalong-overlay", "ailab-overlay", "tabview-overlay"]
    .find((id) => { const el = document.getElementById(id); return el && el.classList.contains("show"); });
  try { sessionStorage.setItem(T3K_RETURN_SCREEN_KEY, open || ""); } catch (e) { /* private mode */ }
}

async function t3kRestoreScreen() {
  let want = "";
  try {
    want = sessionStorage.getItem(T3K_RETURN_SCREEN_KEY) || "";
    sessionStorage.removeItem(T3K_RETURN_SCREEN_KEY);
  } catch (e) { return; }
  if (!want) return;
  const openers = {
    "tonelab-overlay": "openToneLab",
    "playalong-overlay": "openPlayAlong",
    "ailab-overlay": "openAiLab",
    "tabview-overlay": "openTabView",
  };
  const fn = window[openers[want]];
  if (typeof fn === "function") await fn();
}

async function t3kBuildAuthorizeUrl(extra) {
  const codeVerifier = t3kRandomBase64Url(32);
  const state = t3kRandomBase64Url(16);
  const codeChallenge = await t3kSha256Base64Url(codeVerifier);
  sessionStorage.setItem(T3K_VERIFIER_KEY, codeVerifier);
  sessionStorage.setItem(T3K_STATE_KEY, state);
  const url = new URL(`${T3K_API}/api/v1/oauth/authorize`);
  url.searchParams.set("client_id", T3K.publishableKey);
  url.searchParams.set("redirect_uri", t3kRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  for (const [k, v] of Object.entries(extra || {})) url.searchParams.set(k, v);
  return url.toString();
}

// "Standard" flow — connect the account once, then search from inside the app.
async function t3kConnect() {
  if (!T3K.publishableKey) { t3kStatus("Add your TONE3000 publishable key first."); return; }
  sessionStorage.setItem(T3K_PENDING_KEY, "connect");
  t3kRememberScreen();
  window.location.href = await t3kBuildAuthorizeUrl({});
}

// "Select" flow — TONE3000's own hosted browser. Costs no search calls
// against our rate limit and is what their docs recommend for browsing;
// comes back with a tone_id we then resolve to a model and download.
async function t3kBrowseOnTone3000() {
  if (!T3K.publishableKey) { t3kStatus("Add your TONE3000 publishable key first."); return; }
  sessionStorage.setItem(T3K_PENDING_KEY, "select");
  const extra = { prompt: "select_tone", preview: "true" };
  // Only offer formats this app can actually load, so the hosted picker
  // can't hand back something we'd have to refuse afterwards.
  extra.format = "nam";
  t3kRememberScreen();
  window.location.href = await t3kBuildAuthorizeUrl(extra);
}

// Exchange ?code= for tokens. Called on page load when a redirect brought us
// back here; returns null when there's nothing to handle (the normal case).
async function t3kHandleRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");
  if (!code) return null;

  const expectedState = sessionStorage.getItem(T3K_STATE_KEY);
  const verifier = sessionStorage.getItem(T3K_VERIFIER_KEY);
  const pending = sessionStorage.getItem(T3K_PENDING_KEY);
  const toneId = params.get("tone_id");
  // Clean the URL immediately so a refresh can't try to redeem a spent code.
  window.history.replaceState({}, "", window.location.pathname);
  sessionStorage.removeItem(T3K_STATE_KEY);
  sessionStorage.removeItem(T3K_VERIFIER_KEY);
  sessionStorage.removeItem(T3K_PENDING_KEY);

  // CSRF check — a code arriving with a state we didn't issue is not ours.
  if (!expectedState || returnedState !== expectedState) {
    return { ok: false, error: "Sign-in response didn't match this session — please try connecting again." };
  }
  if (!verifier) return { ok: false, error: "Sign-in session expired — please try connecting again." };

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: T3K.publishableKey,
      redirect_uri: t3kRedirectUri(),
      code_verifier: verifier,
    });
    const res = await fetch(`${T3K_API}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return { ok: false, error: `TONE3000 sign-in failed (HTTP ${res.status}).` };
    const json = await res.json();
    t3kSaveTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    });
    return { ok: true, flow: pending, toneId };
  } catch (e) {
    return { ok: false, error: "Couldn't reach TONE3000 to complete sign-in: " + (e.message || e) };
  }
}

async function t3kRefreshTokens() {
  const t = T3K.tokens;
  if (!t || !t.refresh_token) throw new Error("not connected");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: T3K.publishableKey,
  });
  const res = await fetch(`${T3K_API}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) { t3kClearTokens(); throw new Error("TONE3000 session expired — connect again."); }
  const json = await res.json();
  t3kSaveTokens({
    access_token: json.access_token,
    refresh_token: json.refresh_token || t.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
  });
  return T3K.tokens;
}

// Authenticated fetch against the TONE3000 API. Refreshes proactively on
// expiry and once reactively on a 401, same as the reference client.
async function t3kFetch(path, init) {
  if (!t3kIsConnected()) throw new Error("Connect your TONE3000 account first.");
  if (T3K.tokens.expires_at && Date.now() > T3K.tokens.expires_at - 30000) await t3kRefreshTokens();
  const call = () => fetch(`${T3K_API}${path}`, {
    ...init,
    headers: { ...(init && init.headers), Authorization: `Bearer ${T3K.tokens.access_token}` },
  });
  let res = await call();
  if (res.status === 401) { await t3kRefreshTokens(); res = await call(); }
  if (res.status === 429) throw new Error("TONE3000 rate limit reached (100 requests/minute) — wait a moment and try again.");
  return res;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// Verbatim from buildSearchTonesQuery in the reference client — note the
// underscore joins, and that `creators` is the one comma-joined param.
function t3kBuildSearchQuery(params) {
  const qs = new URLSearchParams();
  if (params.query) qs.set("query", params.query);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("page_size", String(params.pageSize));
  if (params.sort) qs.set("sort", params.sort);
  if (params.gears && params.gears.length) qs.set("gears", params.gears.join("_"));
  if (params.format) qs.set("format", params.format);
  if (params.sizes && params.sizes.length) qs.set("sizes", params.sizes.join("_"));
  if (params.tags && params.tags.length) qs.set("tags", params.tags.join("_"));
  if (params.makes && params.makes.length) qs.set("makes", params.makes.join("_"));
  if (params.creators && params.creators.length) qs.set("creators", params.creators.join(","));
  if (params.architecture != null) qs.set("architecture", String(params.architecture));
  return qs;
}

async function t3kSearchTones(params) {
  const res = await t3kFetch(`/api/v1/tones/search?${t3kBuildSearchQuery(params)}`);
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}).`);
  return res.json();
}

async function t3kListModels(toneId) {
  const res = await t3kFetch(`/api/v1/models?tone_id=${encodeURIComponent(toneId)}`);
  if (!res.ok) throw new Error(`Couldn't list files for that tone (HTTP ${res.status}).`);
  return res.json();
}

async function t3kGetTone(toneId) {
  const res = await t3kFetch(`/api/v1/tones/${encodeURIComponent(toneId)}`);
  if (!res.ok) throw new Error(`Couldn't load that tone (HTTP ${res.status}).`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Download into the local library
// ---------------------------------------------------------------------------

function t3kSafeFilename(name, ext) {
  const base = String(name || "tone").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tone";
  return base + ext;
}

// Picks which of a tone's models to fetch. Prefers the smallest architecture
// this app runs well: our own WASM engine handles A1 WaveNet fastest, and
// Lite/Feather cuts stay far inside the real-time budget (the NAM loader
// refuses anything too heavy anyway — see NAM_REFUSE_RT_FACTOR).
function t3kPickModel(models, preferSize) {
  if (!models.length) return null;
  const order = preferSize ? [preferSize] : [];
  order.push("lite", "feather", "standard", "nano", "custom");
  for (const size of order) {
    const hit = models.find((m) => m.size === size);
    if (hit) return hit;
  }
  return models[0];
}

// model_url is NOT a public link — it needs the Bearer header, so it goes
// through t3kFetch like any other endpoint. The bytes then go straight to
// the same upload endpoint the drag-and-drop importer uses, so a downloaded
// capture lands in exactly the same place as a hand-copied one.
async function t3kDownloadModel(tone, model) {
  const path = model.model_url.startsWith("http") ? model.model_url.replace(T3K_API, "") : model.model_url;
  const res = await t3kFetch(path);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const blob = await res.blob();

  const urlName = (() => {
    try { return new URL(model.model_url, T3K_API).pathname.split("/").pop() || ""; } catch (e) { return ""; }
  })();
  const ext = urlName.includes(".") ? "." + urlName.split(".").pop().toLowerCase() : (tone.format === "ir" ? ".wav" : ".nam");
  const isIr = ext === ".wav" || tone.format === "ir";
  // Name it after the tone (plus the cut) rather than the storage filename,
  // which is usually an opaque id — the local browser lists by filename.
  const label = model.size && model.size !== "standard" ? `${tone.title} ${model.size}` : tone.title;
  const filename = t3kSafeFilename(label, ext);

  const endpoint = isIr ? "/api/ir/upload" : "/api/nam/upload";
  const up = await fetch(`${endpoint}?filename=${encodeURIComponent("TONE3000/" + filename)}`, {
    method: "POST",
    body: await blob.arrayBuffer(),
  });
  if (!up.ok) {
    let msg = `HTTP ${up.status}`;
    try { msg = (await up.json()).error || msg; } catch (e) { /* not json */ }
    throw new Error(`Saving to your library failed: ${msg}`);
  }
  const info = await up.json().catch(() => ({}));
  // Use the path the SERVER reports, not the one we asked for — it is the
  // real location relative to the models root (folder included), which is
  // exactly the key the loader and the browser list use. Backslashes are
  // normalised because that relative path is built with the host OS's
  // separator.
  const savedName = (info.filename || ("TONE3000/" + filename)).replace(/\\/g, "/");
  return { filename: savedName, isIr, json: info };
}

// Make a freshly-downloaded capture the live one. Downloading a tone and
// then having to go find it in the picker is a pointless extra step — the
// reason you downloaded it is to hear it.
//
// Order matters: the model is loaded FIRST and the amp only switches to
// Neural once that succeeded. paLoadNamModel legitimately refuses a capture
// too heavy to run in real time (NAM_REFUSE_RT_FACTOR), and switching first
// would leave the rig on a neural amp with nothing loaded — i.e. silence,
// with the reason buried on another card.
async function t3kActivateDownloaded(saved) {
  if (typeof paEnsureRigSessionReady === "function") await paEnsureRigSessionReady();

  if (saved.isIr) {
    if (typeof paLoadIr !== "function") return "";
    await paLoadIr(saved.filename);
    paHighlightBrowserSelection("ir", saved.filename);
    const bypass = document.getElementById("pa-ir-bypass");
    // Deliberately NOT auto-un-bypassed: with a full-rig NAM capture already
    // loaded, stacking an IR on top is the exact "too dark" mistake the
    // gear_type note warns about (§N-2). Say it instead of deciding it.
    return bypass && bypass.checked
      ? " Loaded into the Cab IR slot — turn off its Bypass to hear it."
      : " Loaded into the Cab IR slot and active.";
  }

  if (typeof paLoadNamModel !== "function") return "";
  await paLoadNamModel(saved.filename);
  if (PA.namLoaded !== saved.filename) {
    // The NAM card's own status line already says exactly why (too heavy for
    // this machine, unsupported architecture, ...) — don't paraphrase it badly.
    return " It didn't load, though — see the Amp card's Neural tab for why.";
  }
  paHighlightBrowserSelection("nam", saved.filename);
  const switched = PA.ampMode !== "neural";
  if (switched && typeof setAmpMode === "function") setAmpMode("neural");
  return switched ? " Amp switched to Neural and this capture is live." : " It's live on the Neural amp now.";
}

// ---------------------------------------------------------------------------
// "Match this track"
//
// Honest about what this is: TONE3000's catalogue is searched by TEXT and
// TAGS, so this builds the best query it can from what the app knows about
// the loaded song — artist and title, plus the genre the AI Lab may have
// stored. It is NOT spectral matching against the guitar stem; nothing in
// the API exposes the audio of a capture to compare against, and auditioning
// candidates would mean downloading each one first (slow, and straight into
// the rate limit). The existing local "Suggest closest tone" button is the
// spectral one, and it runs over captures you've already downloaded — so the
// intended pairing is: match here to get candidates, Suggest there to rank
// them once they're local. The UI says exactly this.
// ---------------------------------------------------------------------------

async function t3kTrackMatchQuery() {
  if (typeof State === "undefined" || !State.track) return { query: "", artist: "", title: "", genre: "" };
  // Artist/Title live server-side per track (AI Lab's "This song" fields,
  // /api/trackinfo), not on State — and the server also hands back what it
  // guessed from the filename, which is the right fallback when the user
  // hasn't filled them in.
  let artist = "", title = "";
  try {
    const info = await Api.get(`/api/trackinfo?track=${encodeURIComponent(State.track)}`);
    artist = (info.artist || info.guessed_artist || "").trim();
    title = (info.title || info.guessed_title || "").trim();
  } catch (e) { /* no track info — fall through to whatever else we have */ }
  // Genre is the AI Lab's Lick Ideas field; it's a plain user-entered hint,
  // so read it if the panel has one rather than inventing a genre.
  const genreEl = document.getElementById("ailab-lick-genre");
  const genre = genreEl ? genreEl.value.trim() : "";

  const bits = [];
  if (artist) bits.push(artist);
  // Title only when there's no artist — an artist name is a far better
  // catalogue query than a song title, which rarely names any gear.
  if (!artist && title) bits.push(title);
  if (genre) bits.push(genre);
  return { query: bits.join(" ").trim(), artist, title, genre };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function t3kStatus(msg) {
  const el = document.getElementById("t3k-status");
  if (el) el.textContent = msg || "";
}

function t3kSelectedValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)].map((c) => c.value);
}

function t3kCurrentParams(page) {
  const archRaw = document.getElementById("t3k-architecture").value;
  return {
    query: document.getElementById("t3k-query").value.trim(),
    page: page || 1,
    pageSize: 20,
    sort: document.getElementById("t3k-sort").value || undefined,
    gears: t3kSelectedValues("t3k-gears"),
    sizes: t3kSelectedValues("t3k-sizes"),
    format: document.getElementById("t3k-format").value || undefined,
    architecture: archRaw ? Number(archRaw) : undefined,
  };
}

async function t3kRunSearch(page, paramsOverride) {
  if (T3K.busy) return;
  if (!t3kIsConnected()) { t3kStatus("Connect your TONE3000 account first."); return; }
  const params = paramsOverride || t3kCurrentParams(page);
  T3K.busy = true;
  t3kStatus("Searching TONE3000…");
  try {
    const data = await t3kSearchTones(params);
    T3K.results = data.data || [];
    T3K.page = data.page || params.page || 1;
    T3K.totalPages = data.total_pages || 0;
    T3K.total = data.total || 0;
    T3K.lastParams = params;
    t3kRenderResults();
    t3kStatus(T3K.total
      ? `${T3K.total} tone${T3K.total === 1 ? "" : "s"} found — page ${T3K.page} of ${T3K.totalPages}.`
      : "No tones matched that search.");
  } catch (e) {
    t3kStatus(e.message || String(e));
  } finally {
    T3K.busy = false;
  }
}

function t3kRenderResults() {
  const list = document.getElementById("t3k-results");
  if (!list) return;
  list.innerHTML = "";
  for (const tone of T3K.results) {
    const row = document.createElement("div");
    row.className = "t3k-result";

    const main = document.createElement("div");
    main.className = "t3k-result-main";
    const makes = (tone.makes || []).map((m) => m.name).filter(Boolean).join(", ");
    main.innerHTML =
      `<div class="t3k-result-title">${escapeHtml(tone.title || "Untitled")}</div>` +
      `<div class="t3k-result-meta">${escapeHtml([
        tone.gear, tone.format ? tone.format.toUpperCase() : "", makes,
        tone.user && tone.user.username ? "by " + tone.user.username : "",
        (tone.sizes || []).join("/"),
        tone.downloads_count ? `${tone.downloads_count} downloads` : "",
      ].filter(Boolean).join(" · "))}</div>`;

    const btn = document.createElement("button");
    btn.textContent = "Download";
    btn.className = "primary";
    btn.addEventListener("click", () => t3kDownloadTone(tone, btn));

    const link = document.createElement("a");
    link.href = tone.url || `${T3K_API}/tones/${tone.id}`;
    link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = "View";

    row.appendChild(main);
    row.appendChild(link);
    row.appendChild(btn);
    list.appendChild(row);
  }
  const pager = document.getElementById("t3k-pager");
  if (pager) {
    pager.style.display = T3K.totalPages > 1 ? "" : "none";
    document.getElementById("t3k-page-label").textContent = `Page ${T3K.page} / ${T3K.totalPages}`;
    document.getElementById("t3k-prev-btn").disabled = T3K.page <= 1;
    document.getElementById("t3k-next-btn").disabled = T3K.page >= T3K.totalPages;
  }
}

async function t3kDownloadTone(tone, btn) {
  const original = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Downloading…"; }
  const busy = gsBusy(`Downloading "${tone.title || "tone"}"…`);
  try {
    const models = await t3kListModels(tone.id);
    const model = t3kPickModel(models.data || []);
    if (!model) throw new Error("That tone has no downloadable files.");
    const saved = await t3kDownloadModel(tone, model);
    // Refresh the local browser BEFORE activating: the picker highlight
    // below targets a row that has to exist in the list first.
    if (saved.isIr) { if (typeof paRefreshIrModels === "function") await paRefreshIrModels(); }
    else if (typeof paRefreshNamModels === "function") await paRefreshNamModels();

    let activated = "";
    try {
      activated = await t3kActivateDownloaded(saved);
    } catch (e) {
      // A download that saved fine but couldn't be auto-activated is still a
      // successful download — report both truthfully rather than turning the
      // whole thing into an error.
      activated = ` Saved, but couldn't make it active automatically: ${e.message || e}`;
    }
    t3kStatus(`Saved "${saved.filename}" to your ${saved.isIr ? "IR" : "NAM"} library.${activated}`);
    if (btn) btn.textContent = "Downloaded";
  } catch (e) {
    t3kStatus(e.message || String(e));
    if (btn) { btn.disabled = false; btn.textContent = original; }
  } finally {
    busy();
  }
}

function t3kRenderConnectionState() {
  const connected = t3kIsConnected();
  const hasKey = !!T3K.publishableKey;
  const connectBtn = document.getElementById("t3k-connect-btn");
  const disconnectBtn = document.getElementById("t3k-disconnect-btn");
  const panel = document.getElementById("t3k-search-panel");
  if (connectBtn) {
    connectBtn.style.display = connected ? "none" : "";
    connectBtn.disabled = !hasKey;
  }
  if (disconnectBtn) disconnectBtn.style.display = connected ? "" : "none";
  if (panel) panel.style.display = connected ? "" : "none";
  const keyHint = document.getElementById("t3k-key-hint");
  if (keyHint) {
    keyHint.textContent = hasKey
      ? `Redirect URI to register with this key: ${t3kRedirectUri()}`
      : "Get a free publishable key from your TONE3000 account settings, then register this app's redirect URI with it: " + t3kRedirectUri();
  }
}

async function t3kSaveKey() {
  const input = document.getElementById("t3k-key-input");
  const key = input.value.trim();
  try {
    const r = await Api.post("/api/settings/tone3000_key", { publishable_key: key });
    T3K.publishableKey = r.tone3000_publishable_key || "";
    t3kStatus(T3K.publishableKey ? "Publishable key saved." : "Publishable key cleared.");
    t3kRenderConnectionState();
  } catch (e) {
    t3kStatus(e.message || String(e));
  }
}

function t3kBuildFilterCheckboxes() {
  const mk = (containerId, entries) => {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = "";
    for (const [value, label] of entries) {
      const id = `${containerId}-${value}`;
      const wrap = document.createElement("label");
      wrap.className = "t3k-chip";
      wrap.innerHTML = `<input type="checkbox" id="${id}" value="${value}"> ${escapeHtml(label)}`;
      box.appendChild(wrap);
    }
  };
  mk("t3k-gears", T3K_GEARS);
  mk("t3k-sizes", T3K_SIZES);

  const fmt = document.getElementById("t3k-format");
  if (fmt && !fmt.options.length) {
    fmt.appendChild(new Option("Any format", ""));
    for (const [v, l] of T3K_FORMATS) fmt.appendChild(new Option(l, v));
    fmt.value = "nam"; // this app loads NAM captures; IRs are the other thing it can use
  }
  const sort = document.getElementById("t3k-sort");
  if (sort && !sort.options.length) {
    for (const [v, l] of T3K_SORTS) sort.appendChild(new Option(l, v));
  }
  const arch = document.getElementById("t3k-architecture");
  if (arch && !arch.options.length) {
    arch.appendChild(new Option("Any architecture", ""));
    arch.appendChild(new Option("A1 (fastest here)", "1"));
    arch.appendChild(new Option("A2", "2"));
  }
}

async function t3kMatchThisTrack() {
  const m = await t3kTrackMatchQuery();
  if (!m.query) {
    t3kStatus("No track metadata to match on — set this song's Artist/Title in AI Lab first, or just type a search.");
    return;
  }
  document.getElementById("t3k-query").value = m.query;
  const params = t3kCurrentParams(1);
  params.query = m.query;
  params.sort = "best-match";
  await t3kRunSearch(1, params);
  const bits = [m.artist && `artist "${m.artist}"`, m.genre && `genre "${m.genre}"`].filter(Boolean).join(" + ");
  t3kStatus(document.getElementById("t3k-status").textContent +
    ` (Searched on ${bits || "this track's title"} — that's a text match on the catalogue, not a sound-alike analysis. ` +
    `Download a few, then use "Suggest closest tone" above to rank them against your actual guitar stem.)`);
}

function wireTone3000() {
  t3kBuildFilterCheckboxes();
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on("t3k-key-save-btn", "click", t3kSaveKey);
  on("t3k-connect-btn", "click", t3kConnect);
  on("t3k-browse-btn", "click", t3kBrowseOnTone3000);
  on("t3k-disconnect-btn", "click", () => { t3kClearTokens(); t3kRenderConnectionState(); t3kStatus("Disconnected from TONE3000."); });
  on("t3k-search-btn", "click", () => t3kRunSearch(1));
  on("t3k-match-btn", "click", t3kMatchThisTrack);
  on("t3k-prev-btn", "click", () => t3kRunSearch(Math.max(1, T3K.page - 1), { ...T3K.lastParams, page: Math.max(1, T3K.page - 1) }));
  on("t3k-next-btn", "click", () => t3kRunSearch(T3K.page + 1, { ...T3K.lastParams, page: T3K.page + 1 }));
  // Enter in the query box searches — but nothing searches as you type, on
  // purpose: the search endpoint is the rate-limited one.
  on("t3k-query", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); t3kRunSearch(1); } });
}

// Startup: read the saved publishable key, restore any live session, and
// finish an OAuth redirect if this page load is one.
async function initTone3000() {
  try {
    const s = await Api.get("/api/settings");
    T3K.publishableKey = s.tone3000_publishable_key || "";
    const input = document.getElementById("t3k-key-input");
    if (input) input.value = T3K.publishableKey;
  } catch (e) { /* settings unavailable — the panel just stays unconfigured */ }
  t3kLoadTokens();
  const redirect = await t3kHandleRedirect();
  // Reopen whatever screen the user launched the flow from, before any status
  // message or auto-download lands — those write into that screen's panel.
  if (redirect) await t3kRestoreScreen();
  if (redirect && redirect.ok) {
    t3kStatus("Connected to TONE3000.");
    // The Select flow comes back with the tone the user picked — fetch and
    // download it straight away, which is the whole point of that flow.
    if (redirect.flow === "select" && redirect.toneId) {
      try {
        const tone = await t3kGetTone(redirect.toneId);
        await t3kDownloadTone(tone, null);
      } catch (e) { t3kStatus(e.message || String(e)); }
    }
  } else if (redirect && !redirect.ok) {
    t3kStatus(redirect.error);
  }
  t3kRenderConnectionState();
}

wireTone3000();
initTone3000();
