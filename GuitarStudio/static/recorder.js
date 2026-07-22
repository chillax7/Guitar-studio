"use strict";

// Performance video recording — entirely in-browser via MediaRecorder,
// per video-recording-spec.md. The whole live rig already runs in one
// AudioContext (Audio.ctx, shared by the mixer and Play Along), so
// recording taps that same context via a parallel MediaStreamAudioDestination
// sink rather than a second process or clock domain: zero added latency on
// the monitored path, since the tap is beside the signal chain, never in it.
//
// Audio recorded = the backing-track mix (Audio.analyser — the node that
// always carries the final signal regardless of playback mode, see app.js)
// + the guitar rig's output (PA.outputMute, once Play Along has been opened
// at least once — tapped post-mute, same node the tuner mutes, so a take
// started while tuning records silence there rather than raw guitar).
// Camera audio is never touched — getUserMedia for video is always
// requested with audio:false, so there's no mic-bleed/feedback risk and no
// ambiguity between the camera mic and the USB interface.

const Recorder = {
  camStream: null,
  recordBus: null,
  recDest: null,
  mediaRecorder: null,
  state: "idle", // idle | recording | saving
  startedAt: 0,
  quality: "720p",
  avOffsetMs: 0,
  tickInterval: null,
  // VD-05: practice mode's auto-retake starts a new MediaRecorder before the
  // previous one's onstop/finalize has necessarily run, so chunks/mimeType/
  // audioOnly can no longer live here as shared fields — beginRecordingPass
  // closes over its own local copies per pass instead (see there).
  practiceMode: false,
  practiceInterval: null,
  practiceLastPos: 0,
};

const REC_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // H.264 CBP + AAC-LC, hardware-encoded on macOS
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

// GP-08: audio-only takes — trivial off the existing video path per the
// backlog's own framing. Same MediaRecorder machinery, just handed a
// MediaStream with no video track and a container that doesn't need one.
const REC_AUDIO_MIME_CANDIDATES = [
  "audio/mp4;codecs=mp4a.40.2", // AAC-LC, same codec as the video path's audio track
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
];

function recPickMimeType() {
  return REC_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}
function recPickAudioMimeType() {
  return REC_AUDIO_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}

// ---------------------------------------------------------------------------
// Record bus — lazy, persistent once created. Safe to call repeatedly: Web
// Audio no-ops a connect() between an already-connected pair, so re-wiring
// after Play Along's rig comes online later just adds the new source.
// ---------------------------------------------------------------------------

function ensureRecordBus() {
  ensureCtx();
  if (!Recorder.recordBus) Recorder.recordBus = Audio.ctx.createGain();
  Audio.analyser.connect(Recorder.recordBus);
  if (typeof PA !== "undefined" && PA.outputMute) PA.outputMute.connect(Recorder.recordBus);
}

function ensureRecordDest() {
  ensureRecordBus();
  if (!Recorder.recDest) {
    Recorder.recDest = Audio.ctx.createMediaStreamDestination();
    Recorder.recordBus.connect(Recorder.recDest);
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

async function recRefreshCameraDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === "videoinput");
  const sel = document.getElementById("rec-camera-select");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const d of cams) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${sel.children.length + 1}`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

async function recStartCamera(deviceId, quality) {
  const dims = quality === "1080p"
    ? { width: { ideal: 1920 }, height: { ideal: 1080 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 } };
  const videoConstraints = { ...dims, frameRate: { ideal: 30 } };
  if (deviceId) videoConstraints.deviceId = { exact: deviceId };

  const hintEl = document.getElementById("rec-camera-hint");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    recStopCamera();
    Recorder.camStream = stream;
    const videoEl = document.getElementById("rec-preview");
    videoEl.srcObject = stream;
    await videoEl.play();
    // V3-U1: the preview wrap starts display:none — a permanently visible
    // black box with no camera enabled was one of the review complaints
    // about the old Play Along layout. Only reveal it once a stream is
    // actually live.
    document.getElementById("rec-preview-wrap").style.display = "";
    hintEl.textContent = "Camera enabled.";
    await recRefreshCameraDevices();
    updateRecUI(); // GP-08 — refreshes the audio-only/video mode hint
  } catch (e) {
    if (e.name === "OverconstrainedError" && deviceId) {
      return recStartCamera(null, quality); // fall back to default device
    }
    hintEl.textContent = `Could not access camera: ${e.message}. Check System Settings > Privacy & Security > Camera, or close any other app using it.`;
  }
}

function recStopCamera() {
  if (Recorder.camStream) {
    Recorder.camStream.getTracks().forEach((t) => t.stop());
    Recorder.camStream = null;
  }
}

// ---------------------------------------------------------------------------
// Record / stop
// ---------------------------------------------------------------------------

function recBeforeUnloadGuard(e) {
  e.preventDefault();
  e.returnValue = "";
}

async function toggleRecording() {
  if (Recorder.state === "recording") return stopRecording();
  return startRecording();
}

async function startRecording() {
  ensureRecordDest();
  // VD-01: reuses BT-06's exact click generator (app.js) — recording and
  // playback both begin inside the same beginRecordingPass() callback, i.e.
  // together on beat 1, no beat lost or duplicated at the seam. The clicks
  // themselves are never captured: scheduleCountIn() routes them straight
  // to ctx.destination, never into the record bus.
  const doPlayback = document.getElementById("rec-start-with-playback").checked && State.track && Audio.duration;
  const doCountIn = document.getElementById("rec-count-in").checked;
  withOptionalCountIn(doCountIn, () => beginRecordingPass(doPlayback)); // app.js
}

// Starts one MediaRecorder session against the shared record bus. Split out
// of startRecording() so VD-05 practice mode can call it back-to-back for
// each loop pass without re-running count-in/playback-start — those only
// make sense for the very first take, not an auto-retake mid-loop.
//
// chunks/mimeType/audioOnly are local to this pass (closed over by
// ondataavailable/onstop) rather than shared Recorder fields: practice mode
// starts the next pass's recorder before the previous pass's onstop has
// necessarily fired, and shared mutable fields would let the new pass's
// resets corrupt the previous pass's still-in-flight blob.
function beginRecordingPass(withPlayback) {
  // GP-08: no camera enabled is no longer a hard stop — record audio-only
  // instead of blocking the take entirely. Camera enabled = video+audio,
  // same as before.
  const audioOnly = !Recorder.camStream;
  const mimeType = audioOnly ? recPickAudioMimeType() : recPickMimeType();
  if (!mimeType) {
    document.getElementById("rec-result").textContent = audioOnly
      ? "This browser can't record audio (no supported MediaRecorder format)."
      : "This browser can't record video (no supported MediaRecorder format).";
    return false;
  }

  const audioTrack = Recorder.recDest.stream.getAudioTracks()[0];
  const combined = audioOnly
    ? new MediaStream([audioTrack])
    : new MediaStream([Recorder.camStream.getVideoTracks()[0], audioTrack]);

  const chunks = [];
  const recorder = new MediaRecorder(combined, audioOnly
    ? { mimeType, audioBitsPerSecond: 192_000 }
    : { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 192_000 });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onerror = (e) => {
    console.error("MediaRecorder error", e.error);
    document.getElementById("rec-result").textContent = "Recorder error — take ended early, salvaging what was captured.";
    stopRecording({ keepPlaying: Recorder.practiceMode });
  };
  // Identity check at the end of finalizeAndUpload (via `recorder`) is what
  // stops a fast-finishing later pass's "idle" reset from being clobbered
  // by an earlier pass's finalize resolving after it.
  recorder.onstop = () => finalizeAndUpload(recorder, chunks, mimeType, audioOnly);

  Recorder.mediaRecorder = recorder;
  Recorder.state = "recording";
  Recorder.startedAt = performance.now();
  recorder.start(1000); // 1s timeslices — a crash loses at most the last second

  window.addEventListener("beforeunload", recBeforeUnloadGuard);

  if (withPlayback) startPlaybackAt(currentPosition()); // app.js — current position (correct in processed mode too, unlike playStartOffset)

  document.getElementById("rec-result").innerHTML = "";
  updateRecUI();
  recTick();
  Recorder.tickInterval = setInterval(recTick, 250);
  return true;
}

function stopRecording(options = {}) {
  // Defensive against a double-stop: practice mode's own wrap-triggered
  // stop and a manual Stop-button click (disabled during practice mode,
  // but harmless to guard anyway) could otherwise both reach here for the
  // same pass, and MediaRecorder.stop() throws on an already-inactive
  // recorder.
  if (!Recorder.mediaRecorder || Recorder.mediaRecorder.state === "inactive") return;
  Recorder.mediaRecorder.stop();
  Recorder.state = "saving";
  window.removeEventListener("beforeunload", recBeforeUnloadGuard);
  // Stop Record started the backing track (rec-start-with-playback); leaving
  // it running after Stop meant the take ended but the mix kept going.
  // Practice mode passes `keepPlaying` between loop passes — the backing
  // track and loop keep running across the whole practice session, only
  // pausing when practice mode itself is turned off (see practiceStop()).
  if (!options.keepPlaying && typeof pausePlayback === "function") pausePlayback();
  updateRecUI();
}

function recTick() {
  // setInterval, not requestAnimationFrame: the spec requires recording to
  // keep running (and this readout to keep updating) when the user
  // navigates away from Play Along — rAF throttles to near-zero in a
  // background/hidden tab, but MediaRecorder itself doesn't depend on
  // rAF, so the display shouldn't either.
  if (Recorder.state !== "recording") return;
  const elapsed = (performance.now() - Recorder.startedAt) / 1000;
  const m = Math.floor(elapsed / 60), s = Math.floor(elapsed % 60);
  document.getElementById("rec-elapsed").textContent = `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Save + finalize
// ---------------------------------------------------------------------------

async function finalizeAndUpload(sourceRecorder, chunks, mimeType, audioOnly) {
  const blob = new Blob(chunks, { type: mimeType });
  // GP-08: audio-only containers get their own extension — ".m4a" rather
  // than ".mp4" so a take without video reads as what it is, even though
  // both are technically the same MPEG-4 container.
  const ext = audioOnly
    ? (mimeType.includes("mp4") ? "m4a" : "webm")
    : (mimeType.includes("mp4") ? "mp4" : "webm");
  const track = State.track || "";
  const resultEl = document.getElementById("rec-result");
  resultEl.textContent = "Saving take…";

  try {
    const saveResp = await fetch(`/api/recording/save?track=${encodeURIComponent(track)}&ext=${ext}`, {
      method: "POST", body: blob,
    });
    const saveJson = await saveResp.json();
    if (!saveResp.ok) throw new Error(saveJson.error || `HTTP ${saveResp.status}`);

    const finalizeResp = await fetch("/api/recording/finalize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      // A/V offset only means anything with a video track to sync against.
      body: JSON.stringify({ path: saveJson.path, av_offset_ms: audioOnly ? 0 : Recorder.avOffsetMs }),
    });
    const finalizeJson = await finalizeResp.json();
    showTakeResult(saveJson, finalizeJson);
    refreshTakesList();
  } catch (e) {
    // Rescue: the blob is still in memory even though the upload failed —
    // offer a direct browser download instead of losing the take.
    const url = URL.createObjectURL(blob);
    resultEl.innerHTML = `Upload failed (${escapeHtml(e.message)}) — ` +
      `<a href="${url}" download="take.${ext}">click to download the take</a> instead.`;
  }

  // Only this pass's own recorder instance is allowed to clear "recording"
  // back to "idle" — if a newer pass has since taken over Recorder.mediaRecorder
  // (VD-05 practice mode's back-to-back retakes), leave its "recording"
  // state alone rather than stomping it once this older upload finishes.
  if (Recorder.mediaRecorder === sourceRecorder) {
    Recorder.state = "idle";
    updateRecUI();
  }
}

function showTakeResult(saveJson, finalizeJson) {
  const el = document.getElementById("rec-result");
  let html = `Take saved: ${escapeHtml(saveJson.filename)}`;
  html += finalizeJson.finalized ? "" : ` (not remuxed: ${escapeHtml(finalizeJson.reason || "unknown")})`;
  html += `<br><button id="rec-reveal-btn">Reveal in Finder</button><button id="rec-discard-btn">Discard</button>`;
  el.innerHTML = html;
  document.getElementById("rec-reveal-btn").addEventListener("click", () => {
    Api.post("/api/reveal", { path: saveJson.path }).catch(() => {});
  });
  document.getElementById("rec-discard-btn").addEventListener("click", async () => {
    await Api.post("/api/recording/discard", { path: saveJson.path }).catch(() => {});
    el.textContent = "Take discarded.";
    refreshTakesList();
  });
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function updateRecUI() {
  const btn = document.getElementById("rec-toggle-btn");
  const pill = document.getElementById("rec-pill");
  const recording = Recorder.state === "recording";
  btn.textContent = recording ? "■ Stop" : "● Record";
  btn.classList.toggle("recording", recording);
  // VD-05: practice mode owns start/stop across every loop pass itself —
  // the manual button would race it (see stopRecording's double-stop
  // guard), so it's disabled for the duration rather than left to conflict.
  btn.disabled = Recorder.state === "saving" || Recorder.practiceMode;
  pill.style.display = recording ? "inline-block" : "none";
  // GP-08: no camera enabled no longer blocks recording — say so up front
  // rather than the user finding out only after pressing Record.
  const modeEl = document.getElementById("rec-mode-hint");
  if (modeEl && !recording) {
    modeEl.textContent = Recorder.camStream
      ? "Camera enabled — this take will include video."
      : "No camera enabled — this take will be audio-only.";
  }
  if (Recorder.tickInterval && !recording) {
    clearInterval(Recorder.tickInterval);
    Recorder.tickInterval = null;
  }
}

// ---------------------------------------------------------------------------
// VD-05: multi-take practice mode — loop a section, auto-retake each pass.
// Owns the record start/stop cycle itself; each time app.js's tick() wraps
// the loop back to its start (a backward jump in currentPosition(), the
// same signal a listener would notice), the in-progress pass is stopped
// (saved as its own take) and a new one begins immediately, backing track
// still running underneath the whole time.
// ---------------------------------------------------------------------------

const PRACTICE_POLL_MS = 100; // wrap-detection granularity — see practiceTick
const PRACTICE_WRAP_EPSILON_SEC = 0.05;

function practiceStart() {
  const hint = document.getElementById("rec-practice-hint");
  if (!State.track) {
    hint.textContent = "Load a track first.";
    return false;
  }
  if (!State.ui.loopEnabled || !State.ui.loop) {
    hint.textContent = "Set a loop region and enable Loop (Mixer) first.";
    return false;
  }
  if (Recorder.state !== "idle") {
    hint.textContent = "Stop the current take first.";
    return false;
  }

  Recorder.practiceMode = true;
  hint.textContent = "Practice mode running — each pass through the loop is saved as its own take.";
  ensureRecordDest();
  startPlaybackAt(State.ui.loop.start); // app.js — clean start from the top of the loop
  Recorder.practiceLastPos = State.ui.loop.start;
  beginRecordingPass(false); // playback already started above, ours to manage from here
  Recorder.practiceInterval = setInterval(practiceTick, PRACTICE_POLL_MS);
  updateRecUI();
  return true;
}

function practiceTick() {
  if (!Recorder.practiceMode) return;
  if (!Audio.playing) {
    // Playback stopped outside practice mode's own control (e.g. the
    // backing track reached its own end without looping, or the user hit
    // the transport Stop) — end the session rather than spin forever.
    practiceStop();
    return;
  }
  const pos = currentPosition();
  if (pos < Recorder.practiceLastPos - PRACTICE_WRAP_EPSILON_SEC) {
    // Loop wrapped (app.js's tick() just seeked back to loop.start) —
    // that's the boundary between one pass and the next.
    stopRecording({ keepPlaying: true });
    beginRecordingPass(false);
  }
  Recorder.practiceLastPos = pos;
}

function practiceStop() {
  if (!Recorder.practiceMode) return;
  Recorder.practiceMode = false;
  if (Recorder.practiceInterval) {
    clearInterval(Recorder.practiceInterval);
    Recorder.practiceInterval = null;
  }
  if (Recorder.state === "recording") stopRecording(); // last pass — finalize + stop playback
  document.getElementById("rec-practice-toggle").checked = false;
  document.getElementById("rec-practice-hint").textContent =
    "Needs a loop region set and Loop enabled (Mixer) — each pass through the loop is saved as its own take automatically.";
  updateRecUI();
}

function loadAvOffset() {
  const stored = localStorage.getItem("gs_av_offset_ms");
  Recorder.avOffsetMs = stored ? parseFloat(stored) : 0;
  document.getElementById("rec-av-offset").value = Recorder.avOffsetMs;
}

// VD-04: automates the manual clap-sync calibration (USER-MANUAL.md §10.1)
// — record ~5s live, detect the clap's audio onset (energy-derivative
// spike, no ML) and the hands-meeting video frame (frame-to-frame pixel-
// difference spike via canvas, also no ML), then auto-fill the A/V offset
// field. A shortcut to that field, not a replacement — the user can still
// override it by hand afterward.
async function vdAutoCalibrate() {
  const resultEl = document.getElementById("rec-calibrate-result");
  if (!Recorder.camStream) {
    resultEl.textContent = "Enable the camera first.";
    return;
  }
  // A clap makes no sound in what actually gets analyzed/recorded here:
  // Recorder.recordBus is the backing track mix + your PROCESSED guitar
  // signal (see ensureRecordBus/§10 of the manual) — there's no live room
  // microphone in that path by design, so a physical clap was always
  // silent to it regardless of detection tuning. A guitar strum instead
  // travels through the real signal path (input -> gate -> amp -> this
  // same recordBus) and is just as visible on camera, from the same real
  // moment — so it calibrates against what you're actually recording,
  // not a side-channel a mic would introduce (and which, on speakers
  // rather than headphones, is exactly what causes feedback).
  if (!(typeof PA !== "undefined" && PA.stream)) {
    resultEl.textContent = "Enable Play Along input first (Input > Enable input) — calibration needs a real strum through your instrument, not a microphone.";
    return;
  }
  ensureRecordBus();

  const audioAnalyser = Audio.ctx.createAnalyser();
  audioAnalyser.fftSize = 2048;
  Recorder.recordBus.connect(audioAnalyser);
  const audioData = new Float32Array(audioAnalyser.fftSize);
  const audioSamples = [];

  const videoEl = document.getElementById("rec-preview");
  const canvas = document.createElement("canvas");
  canvas.width = 80; canvas.height = 60; // small — only need a big enough spike, not detail
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  let prevFrame = null;
  const videoSamples = [];

  resultEl.textContent = "Listening — wait a beat, then give your guitar strings one hard strum/hit, visible on camera (5s)…";
  const startTime = performance.now();
  const durationMs = 5000;

  while (performance.now() - startTime < durationMs) {
    audioAnalyser.getFloatTimeDomainData(audioData);
    let energy = 0;
    for (const v of audioData) energy += v * v;
    energy = Math.sqrt(energy / audioData.length);
    audioSamples.push({ t: performance.now() - startTime, level: energy });

    ctx2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const frame = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
    if (prevFrame) {
      let diff = 0;
      for (let i = 0; i < frame.length; i += 4) diff += Math.abs(frame[i] - prevFrame[i]);
      videoSamples.push({ t: performance.now() - startTime, diff });
    }
    prevFrame = frame;

    await new Promise((r) => setTimeout(r, 33)); // ~30fps sampling
  }
  audioAnalyser.disconnect();

  if (audioSamples.length < 2 || videoSamples.length < 2) {
    resultEl.textContent = "Calibration failed — not enough samples captured, try again.";
    return;
  }

  // Find the audio clap first, then look for its matching video motion in
  // a bounded window AROUND that moment — not "the single loudest/
  // brightest sample in the whole 5s clip" (the original approach), which
  // routinely picked up a webcam's autoexposure/auto-focus settling (often
  // the single biggest frame-to-frame delta in the whole clip, well before
  // any clap) instead of the clap itself, producing offsets over a second
  // off. Any such settling happens BEFORE the user claps (given a beat's
  // pause first), so bounding the video search to start at the audio
  // onset excludes it by construction, regardless of how long it lasts —
  // no need to guess a safe "warm-up" duration.
  const FLOOR_PERCENTILE = 0.2; // low percentile = the background/quiet level, resistant to one loud transient
  const THRESHOLD_MULT = 5;
  const VIDEO_SEARCH_BEFORE_MS = 50;  // pipeline jitter tolerance if video ever leads audio
  const VIDEO_SEARCH_AFTER_MS = 600;  // generous upper bound on real webcam capture-to-decode latency

  function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(p * (sorted.length - 1))];
  }
  function floorAndThreshold(samples, valueKey) {
    const floor = Math.max(percentile(samples.map((s) => s[valueKey]), FLOOR_PERCENTILE), 1e-6);
    return floor * THRESHOLD_MULT;
  }
  const audioThreshold = floorAndThreshold(audioSamples, "level");
  const audioHit = audioSamples.find((s) => s.level > audioThreshold);
  const audioSpikeT = audioHit ? audioHit.t : null;

  let videoSpikeT = null;
  if (audioSpikeT !== null) {
    const videoThreshold = floorAndThreshold(videoSamples, "diff");
    const windowed = videoSamples.filter((s) =>
      s.t >= audioSpikeT - VIDEO_SEARCH_BEFORE_MS && s.t <= audioSpikeT + VIDEO_SEARCH_AFTER_MS);
    const videoHit = windowed.find((s) => s.diff > videoThreshold);
    videoSpikeT = videoHit ? videoHit.t : null;
  }

  if (audioSpikeT === null || videoSpikeT === null) {
    resultEl.textContent = "Calibration failed — no clear strum detected above background noise within a plausible video-lag window, try again (hit the strings firmly, and make sure your strumming hand is visible on camera).";
    return;
  }

  const offsetMs = Math.round(videoSpikeT - audioSpikeT);
  document.getElementById("rec-av-offset").value = offsetMs;
  document.getElementById("rec-av-offset").dispatchEvent(new Event("change"));
  // A real USB/built-in webcam's capture-to-decode pipeline delay is
  // well-documented as roughly 50-300ms; anything far outside that is more
  // likely a detection miss than genuine hardware latency, so say so
  // instead of presenting a wild number with the same confidence as a
  // plausible one.
  const implausible = Math.abs(offsetMs) > 500;
  resultEl.textContent = `Detected offset: ${offsetMs}ms (video spike at ${videoSpikeT.toFixed(0)}ms, ` +
    `audio spike at ${audioSpikeT.toFixed(0)}ms). Applied to the field above — still adjustable by hand.` +
    (implausible ? " This is well outside typical webcam latency (50-300ms) — likely a mistimed detection rather than real lag; try again or set the offset manually (§10.2)." : "");
}

// VD-09: preview-only thirds/grid + a "fretboard visible?" guide box, drawn
// on a canvas layered ON TOP of the <video> element (never composited into
// the recorded stream, which comes straight from the raw camera track) —
// same "preview vs. recorded" separation the mirrored-preview CSS already
// uses. Static overlay, no need to redraw per-frame.
function drawFramingOverlay() {
  const canvas = document.getElementById("rec-framing-overlay");
  const W = 320, H = 180;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i++) {
    const x = (W / 3) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    const y = (H / 3) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Lower-diagonal band where a horizontally-held guitar neck typically
  // falls in a seated player shot.
  ctx.strokeStyle = "rgba(91,140,255,0.85)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(W * 0.05, H * 0.55, W * 0.55, H * 0.3);
  ctx.setLineDash([]);
}

function updateFramingOverlayVisibility() {
  const canvas = document.getElementById("rec-framing-overlay");
  canvas.style.display = document.getElementById("rec-framing-toggle").checked ? "block" : "none";
}

// ---------------------------------------------------------------------------
// Takes browser (VD-02) + in-app trim (VD-03)
// ---------------------------------------------------------------------------

let currentTake = null; // {filename, path, size, starred}
let compareSelection = []; // VD-08: up to 2 takes picked for side-by-side compare

async function refreshTakesList() {
  const track = (typeof State !== "undefined" && State.track) || "";
  let takes = [];
  try {
    const r = await Api.get(`/api/recordings?track=${encodeURIComponent(track)}`);
    takes = r.takes;
  } catch (e) { /* best-effort */ }

  // VD-08: carry the compare selection across a refresh by path, dropping
  // any selected take that no longer exists (deleted/renamed elsewhere).
  compareSelection = compareSelection
    .map((sel) => takes.find((t) => t.path === sel.path))
    .filter(Boolean);

  const listEl = document.getElementById("takes-list");
  listEl.innerHTML = "";
  if (!takes.length) {
    listEl.innerHTML = '<p class="hint">No takes for this track yet.</p>';
    updateCompareUI();
    return;
  }
  for (const take of takes) {
    const row = document.createElement("div");
    row.className = "take-row";
    const isSelected = compareSelection.some((t) => t.path === take.path);
    row.innerHTML = `
      <input type="checkbox" class="take-compare-check" title="Select for side-by-side compare" ${isSelected ? "checked" : ""}>
      <button class="take-star-btn ${take.starred ? "starred" : ""}">${take.starred ? "★" : "☆"}</button>
      <span class="take-name">${escapeHtml(take.filename)}</span>
      <button class="take-play-btn">Play</button>
      <button class="take-rename-btn">Rename</button>
      <button class="take-reveal-btn">Reveal</button>
      <button class="take-delete-btn">Delete</button>`;
    listEl.appendChild(row);

    row.querySelector(".take-compare-check").addEventListener("change", (e) => {
      if (e.target.checked) {
        if (compareSelection.length >= 2) {
          e.target.checked = false;
          document.getElementById("compare-status").textContent = "Compare needs exactly 2 — uncheck one first.";
          return;
        }
        compareSelection.push(take);
      } else {
        compareSelection = compareSelection.filter((t) => t.path !== take.path);
      }
      updateCompareUI();
    });
    row.querySelector(".take-star-btn").addEventListener("click", async () => {
      await Api.post("/api/recording/star", { path: take.path, starred: !take.starred }).catch(() => {});
      refreshTakesList();
    });
    row.querySelector(".take-play-btn").addEventListener("click", () => loadTakeIntoPlayer(take));
    row.querySelector(".take-reveal-btn").addEventListener("click", () => {
      Api.post("/api/reveal", { path: take.path }).catch(() => {});
    });
    row.querySelector(".take-rename-btn").addEventListener("click", async () => {
      const base = take.filename.replace(/\.[^.]+$/, "");
      const newName = prompt("Rename take to:", base);
      if (!newName || newName === base) return;
      try {
        const r = await Api.post("/api/recording/rename", { path: take.path, new_name: newName });
        // currentTake (used by Play/Trim) holds its own copy of path/filename
        // captured when loaded — refreshTakesList() rebuilds the row list but
        // doesn't touch that copy, so a rename of the take in the player left
        // it pointing at a path that no longer existed ("file not found" on
        // the next Trim). Update it in place when it's the renamed take.
        if (currentTake && currentTake.path === take.path) {
          currentTake.path = r.path;
          currentTake.filename = r.filename;
        }
        refreshTakesList();
      } catch (e) { alert("Rename failed: " + e.message); }
    });
    row.querySelector(".take-delete-btn").addEventListener("click", async () => {
      if (!confirm(`Delete "${take.filename}"? This can't be undone.`)) return;
      await Api.post("/api/recording/discard", { path: take.path }).catch(() => {});
      if (currentTake && currentTake.path === take.path) {
        document.getElementById("takes-player-wrap").style.display = "none";
        currentTake = null;
      }
      compareSelection = compareSelection.filter((t) => t.path !== take.path);
      refreshTakesList();
    });
  }
  updateCompareUI();
}

// ---------------------------------------------------------------------------
// VD-08: side-by-side take compare — both takes already have the backing
// track baked into their own audio (see the Recorder.recordBus comment up
// top), so "synced" just means starting both media elements from the same
// point together and correcting drift, not re-deriving a shared clock.
// ---------------------------------------------------------------------------

let compareListening = "a"; // "a" | "b" — which take is currently audible
let compareSyncInterval = null;

function updateCompareUI() {
  const card = document.getElementById("takes-compare-card");
  if (compareSelection.length !== 2) {
    card.style.display = "none";
    compareStopSync();
    return;
  }
  card.style.display = "block";
  document.getElementById("compare-status").textContent = "";

  const [a, b] = compareSelection;
  document.getElementById("compare-a-label").textContent = `A: ${a.filename}`;
  document.getElementById("compare-b-label").textContent = `B: ${b.filename}`;
  const videoA = document.getElementById("compare-video-a");
  const videoB = document.getElementById("compare-video-b");
  videoA.pause(); videoB.pause();
  videoA.src = `/api/output?path=${encodeURIComponent(a.path)}`;
  videoB.src = `/api/output?path=${encodeURIComponent(b.path)}`;
  compareListening = "a";
  compareApplyListening();

  videoA.onloadedmetadata = compareUpdateSeekRange;
  videoB.onloadedmetadata = compareUpdateSeekRange;
}

function compareUpdateSeekRange() {
  const videoA = document.getElementById("compare-video-a");
  const videoB = document.getElementById("compare-video-b");
  const seek = document.getElementById("compare-seek");
  const dur = Math.max(videoA.duration || 0, videoB.duration || 0);
  if (isFinite(dur) && dur > 0) seek.max = dur;
}

function compareApplyListening() {
  const videoA = document.getElementById("compare-video-a");
  const videoB = document.getElementById("compare-video-b");
  videoA.muted = compareListening !== "a";
  videoB.muted = compareListening !== "b";
  document.getElementById("compare-listen-a-btn").classList.toggle("active", compareListening === "a");
  document.getElementById("compare-listen-b-btn").classList.toggle("active", compareListening === "b");
}

function compareStopSync() {
  if (compareSyncInterval) {
    clearInterval(compareSyncInterval);
    compareSyncInterval = null;
  }
}

// Two independent HTMLMediaElements drift apart over time even when
// started together — periodically nudge the muted one back onto the
// audible one's clock rather than trying to run them off one shared
// timer, since that's what the ear would actually notice.
const COMPARE_DRIFT_TOLERANCE_SEC = 0.15;

function compareStartSync() {
  compareStopSync();
  compareSyncInterval = setInterval(() => {
    const videoA = document.getElementById("compare-video-a");
    const videoB = document.getElementById("compare-video-b");
    if (videoA.paused && videoB.paused) return;
    const [lead, follow] = compareListening === "a" ? [videoA, videoB] : [videoB, videoA];
    if (Math.abs(follow.currentTime - lead.currentTime) > COMPARE_DRIFT_TOLERANCE_SEC) {
      follow.currentTime = lead.currentTime;
    }
    document.getElementById("compare-seek").value = lead.currentTime;
  }, 500);
}

function wireCompareControls() {
  document.getElementById("compare-play-btn").addEventListener("click", async () => {
    const videoA = document.getElementById("compare-video-a");
    const videoB = document.getElementById("compare-video-b");
    try {
      await Promise.all([videoA.play(), videoB.play()]);
      compareStartSync();
    } catch (e) {
      document.getElementById("compare-status").textContent = "Playback failed: " + e.message;
    }
  });
  document.getElementById("compare-pause-btn").addEventListener("click", () => {
    document.getElementById("compare-video-a").pause();
    document.getElementById("compare-video-b").pause();
    compareStopSync();
  });
  document.getElementById("compare-stop-btn").addEventListener("click", () => {
    const videoA = document.getElementById("compare-video-a");
    const videoB = document.getElementById("compare-video-b");
    videoA.pause(); videoB.pause();
    videoA.currentTime = 0; videoB.currentTime = 0;
    document.getElementById("compare-seek").value = 0;
    compareStopSync();
  });
  document.getElementById("compare-listen-a-btn").addEventListener("click", () => {
    compareListening = "a";
    compareApplyListening();
  });
  document.getElementById("compare-listen-b-btn").addEventListener("click", () => {
    compareListening = "b";
    compareApplyListening();
  });
  document.getElementById("compare-seek").addEventListener("input", (e) => {
    const t = parseFloat(e.target.value);
    document.getElementById("compare-video-a").currentTime = t;
    document.getElementById("compare-video-b").currentTime = t;
  });
}

function loadTakeIntoPlayer(take) {
  currentTake = take;
  const player = document.getElementById("takes-player");
  player.src = `/api/output?path=${encodeURIComponent(take.path)}`;
  document.getElementById("takes-player-wrap").style.display = "block";
  document.getElementById("takes-trim-result").textContent = "";

  player.onloadedmetadata = () => {
    const dur = player.duration || 0;
    const startEl = document.getElementById("takes-trim-start");
    const endEl = document.getElementById("takes-trim-end");
    startEl.max = dur; startEl.value = 0;
    endEl.max = dur; endEl.value = dur;
    updateTrimLabels();
  };
}

function fmtTrimTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function updateTrimLabels() {
  document.getElementById("takes-trim-start-val").textContent = fmtTrimTime(parseFloat(document.getElementById("takes-trim-start").value));
  document.getElementById("takes-trim-end-val").textContent = fmtTrimTime(parseFloat(document.getElementById("takes-trim-end").value));
}

async function trimCurrentTake() {
  if (!currentTake) return;
  const startSec = parseFloat(document.getElementById("takes-trim-start").value);
  const endSec = parseFloat(document.getElementById("takes-trim-end").value);
  const resultEl = document.getElementById("takes-trim-result");
  if (endSec <= startSec) {
    resultEl.textContent = "End must be after start.";
    return;
  }
  resultEl.textContent = "Trimming (lossless copy)…";
  try {
    const r = await Api.post("/api/recording/trim", { path: currentTake.path, start_sec: startSec, end_sec: endSec });
    resultEl.textContent = `Trimmed take saved as ${r.filename} — original left untouched.`;
    refreshTakesList();
  } catch (e) {
    resultEl.textContent = "Trim failed: " + e.message;
  }
}

function wireRecorderControls() {
  document.getElementById("rec-camera-enable-btn").addEventListener("click", () => {
    const deviceId = document.getElementById("rec-camera-select").value;
    const quality = document.getElementById("rec-quality-select").value;
    Recorder.quality = quality;
    recStartCamera(deviceId, quality);
  });
  document.getElementById("rec-quality-select").addEventListener("change", (e) => { Recorder.quality = e.target.value; });
  document.getElementById("rec-toggle-btn").addEventListener("click", toggleRecording);
  document.getElementById("rec-practice-toggle").addEventListener("change", (e) => {
    if (e.target.checked) {
      if (!practiceStart()) e.target.checked = false;
    } else {
      practiceStop();
    }
  });
  document.getElementById("rec-pill").addEventListener("click", () => {
    document.getElementById("playalong-open-btn").click();
  });
  // ui-review-v5-full.md §2.6: cross-link chip to the other "record"
  // button's screen, since finding one gives no signal the other exists.
  document.getElementById("rec-jump-to-rmt").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("ailab-open-btn").click();
    document.getElementById("ailab-tab-ratemytake").click();
  });
  document.getElementById("rec-av-offset").addEventListener("change", (e) => {
    Recorder.avOffsetMs = parseFloat(e.target.value) || 0;
    localStorage.setItem("gs_av_offset_ms", String(Recorder.avOffsetMs));
  });
  document.getElementById("rec-auto-calibrate-btn").addEventListener("click", vdAutoCalibrate);
  document.getElementById("rec-framing-toggle").addEventListener("change", updateFramingOverlayVisibility);
  document.getElementById("takes-trim-start").addEventListener("input", updateTrimLabels);
  document.getElementById("takes-trim-end").addEventListener("input", updateTrimLabels);
  document.getElementById("takes-trim-btn").addEventListener("click", trimCurrentTake);
  wireCompareControls();
  drawFramingOverlay();
  updateFramingOverlayVisibility();
  loadAvOffset();
  recRefreshCameraDevices();
  refreshTakesList();
  updateRecUI(); // GP-08 — shows the audio-only/video mode hint before Record is ever clicked
}

wireRecorderControls();
