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
// + the guitar rig's output (PA.outputGain, once Play Along has been opened
// at least once). Camera audio is never touched — getUserMedia for video is
// always requested with audio:false, so there's no mic-bleed/feedback risk
// and no ambiguity between the camera mic and the USB interface.

const Recorder = {
  camStream: null,
  recordBus: null,
  recDest: null,
  mediaRecorder: null,
  chunks: [],
  state: "idle", // idle | recording | saving
  startedAt: 0,
  mimeType: null,
  quality: "720p",
  avOffsetMs: 0,
  tickInterval: null,
};

const REC_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2", // H.264 CBP + AAC-LC, hardware-encoded on macOS
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function recPickMimeType() {
  return REC_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
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
  if (typeof PA !== "undefined" && PA.outputGain) PA.outputGain.connect(Recorder.recordBus);
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
    hintEl.textContent = "Camera enabled.";
    await recRefreshCameraDevices();
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
  if (!Recorder.camStream) {
    document.getElementById("rec-camera-hint").textContent = "Enable the camera first.";
    return;
  }
  ensureRecordDest();

  const mimeType = recPickMimeType();
  if (!mimeType) {
    document.getElementById("rec-result").textContent = "This browser can't record video (no supported MediaRecorder format).";
    return;
  }

  // VD-01: reuses BT-06's exact click generator (app.js) — recording and
  // playback both begin inside the same beginTake() callback, i.e.
  // together on beat 1, no beat lost or duplicated at the seam. The clicks
  // themselves are never captured: scheduleCountIn() routes them straight
  // to ctx.destination, never into the record bus.
  const doPlayback = document.getElementById("rec-start-with-playback").checked && State.track && Audio.duration;
  const doCountIn = document.getElementById("rec-count-in").checked;

  function beginTake() {
    const audioTrack = Recorder.recDest.stream.getAudioTracks()[0];
    const videoTrack = Recorder.camStream.getVideoTracks()[0];
    const combined = new MediaStream([videoTrack, audioTrack]);

    Recorder.chunks = [];
    Recorder.mimeType = mimeType;
    const recorder = new MediaRecorder(combined, {
      mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 192_000,
    });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) Recorder.chunks.push(e.data); };
    recorder.onerror = (e) => {
      console.error("MediaRecorder error", e.error);
      document.getElementById("rec-result").textContent = "Recorder error — take ended early, salvaging what was captured.";
      stopRecording();
    };
    recorder.onstop = () => finalizeAndUpload();

    Recorder.mediaRecorder = recorder;
    Recorder.state = "recording";
    Recorder.startedAt = performance.now();
    recorder.start(1000); // 1s timeslices — a crash loses at most the last second

    window.addEventListener("beforeunload", recBeforeUnloadGuard);

    if (doPlayback) startPlaybackAt(Audio.playStartOffset); // app.js — same instant, current position

    document.getElementById("rec-result").innerHTML = "";
    updateRecUI();
    recTick();
    Recorder.tickInterval = setInterval(recTick, 250);
  }

  withOptionalCountIn(doCountIn, beginTake); // app.js
}

function stopRecording() {
  if (!Recorder.mediaRecorder) return;
  Recorder.mediaRecorder.stop();
  Recorder.state = "saving";
  window.removeEventListener("beforeunload", recBeforeUnloadGuard);
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

async function finalizeAndUpload() {
  const blob = new Blob(Recorder.chunks, { type: Recorder.mimeType });
  const ext = Recorder.mimeType.includes("mp4") ? "mp4" : "webm";
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
      body: JSON.stringify({ path: saveJson.path, av_offset_ms: Recorder.avOffsetMs }),
    });
    const finalizeJson = await finalizeResp.json();
    showTakeResult(saveJson, finalizeJson);
  } catch (e) {
    // Rescue: the blob is still in memory even though the upload failed —
    // offer a direct browser download instead of losing the take.
    const url = URL.createObjectURL(blob);
    resultEl.innerHTML = `Upload failed (${escapeHtml(e.message)}) — ` +
      `<a href="${url}" download="take.${ext}">click to download the take</a> instead.`;
  }

  Recorder.state = "idle";
  updateRecUI();
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
  btn.disabled = Recorder.state === "saving";
  pill.style.display = recording ? "inline-block" : "none";
  if (Recorder.tickInterval && !recording) {
    clearInterval(Recorder.tickInterval);
    Recorder.tickInterval = null;
  }
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

  resultEl.textContent = "Listening — clap once in front of the camera (5s)…";
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

  let bestAudioIdx = 0, bestAudioJump = -Infinity;
  for (let i = 1; i < audioSamples.length; i++) {
    const jump = audioSamples[i].level - audioSamples[i - 1].level;
    if (jump > bestAudioJump) { bestAudioJump = jump; bestAudioIdx = i; }
  }
  const audioSpikeT = audioSamples[bestAudioIdx].t;

  let bestVideoIdx = 0, bestVideoDiff = -Infinity;
  for (let i = 0; i < videoSamples.length; i++) {
    if (videoSamples[i].diff > bestVideoDiff) { bestVideoDiff = videoSamples[i].diff; bestVideoIdx = i; }
  }
  const videoSpikeT = videoSamples[bestVideoIdx].t;

  const offsetMs = Math.round(videoSpikeT - audioSpikeT);
  document.getElementById("rec-av-offset").value = offsetMs;
  document.getElementById("rec-av-offset").dispatchEvent(new Event("change"));
  resultEl.textContent = `Detected offset: ${offsetMs}ms (video spike at ${videoSpikeT.toFixed(0)}ms, ` +
    `audio spike at ${audioSpikeT.toFixed(0)}ms). Applied to the field above — still adjustable by hand.`;
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

function wireRecorderControls() {
  document.getElementById("rec-camera-enable-btn").addEventListener("click", () => {
    const deviceId = document.getElementById("rec-camera-select").value;
    const quality = document.getElementById("rec-quality-select").value;
    Recorder.quality = quality;
    recStartCamera(deviceId, quality);
  });
  document.getElementById("rec-quality-select").addEventListener("change", (e) => { Recorder.quality = e.target.value; });
  document.getElementById("rec-toggle-btn").addEventListener("click", toggleRecording);
  document.getElementById("rec-pill").addEventListener("click", () => {
    document.getElementById("playalong-open-btn").click();
  });
  document.getElementById("rec-av-offset").addEventListener("change", (e) => {
    Recorder.avOffsetMs = parseFloat(e.target.value) || 0;
    localStorage.setItem("gs_av_offset_ms", String(Recorder.avOffsetMs));
  });
  document.getElementById("rec-auto-calibrate-btn").addEventListener("click", vdAutoCalibrate);
  document.getElementById("rec-framing-toggle").addEventListener("change", updateFramingOverlayVisibility);
  drawFramingOverlay();
  updateFramingOverlayVisibility();
  loadAvOffset();
  recRefreshCameraDevices();
}

wireRecorderControls();
