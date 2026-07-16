# "Rip" — capture whatever's playing on the Mac — Design Spec

**Status:** proposed, not built. Backlog item from the post-v4.5 planning
pass (2026-07-16) — see [post-v4-backlog-audit.md](post-v4-backlog-audit.md).

**One-line pitch:** a button that records whatever audio is currently
playing anywhere on the Mac — a streaming service, a YouTube tab, another
app entirely — and writes it straight into `input/` as a new song,
without needing to already have the file.

---

## 1. The real question this spec has to answer honestly

This is **not** a Python/ffmpeg-only feature the way everything else in
this app has been. Every other audio-touching feature here works because
`ffmpeg` and the Python audio stack (`soundfile`, `librosa`, `torchaudio`)
can already see the *files* involved. System audio is different: macOS
does not expose "whatever CoreAudio is currently playing out the
speakers" as a file or a normal input device by default. Getting at it
needs one of two real approaches, and picking between them is the actual
design decision here — everything else (the UI, the mp3 write, folding
the result into the Library) is small once that's settled.

## 2. The two real options

### Option A — BlackHole (virtual audio driver) + ffmpeg

[BlackHole](https://github.com/ExistentialAudio/BlackHole) is a free,
open-source (MIT), actively-maintained macOS virtual audio driver. Once
installed, it shows up as a normal CoreAudio device — meaning `ffmpeg -f
avfoundation` can capture it exactly like any other input device, the
same primitive already used to list microphones/interfaces in this app.
No new language, no new toolchain, no code-signing story.

- **Prerequisite:** the user installs BlackHole once
  (`brew install blackhole-2ch`) and sets it up as their system output
  (or an Audio MIDI Setup "Multi-Output Device" combining BlackHole +
  their real speakers, if they want to *hear* it while it's capturing —
  routing straight to BlackHole alone is silent capture, output goes
  nowhere else). This app can detect whether a BlackHole-named device
  exists (same device-enumeration call already used for Tone Lab's input
  picker) and show a clear "not installed" state with a link, rather
  than a confusing empty device list.
- **Effort:** low. This is a few dozen lines against infrastructure that
  already exists (device enumeration, an ffmpeg subprocess call, the
  existing take-finalize/remux pattern from video recording).
- **Fits the stack:** yes, completely — `ffmpeg` is already a hard
  dependency, this just points it at a different input device.
- **Honesty note the UI needs to carry:** without the Multi-Output setup,
  the user hears silence while ripping (audio is going to BlackHole
  only, not the speakers) — worth a plain warning in the UI, not a
  surprise.

### Option B — ScreenCaptureKit (native, no virtual driver)

macOS 13+ added an official system-audio-tap API
(`SCStream`/`capturesAudio`) — this is what OBS and similar tools use
natively today for internal-audio capture with **no virtual driver and
no Audio MIDI Setup**, just an OS permission prompt. A small existing
[prior-art project](https://github.com/huxinhai/audio-capture) (C++,
Windows WASAPI + macOS ScreenCaptureKit, unlicensed — not something to
depend on directly, but proof the approach works) confirms this is a
real, current technique, not a dead end.

- **Prerequisite:** the OS's **Screen Recording** permission — Apple
  gates *all* ScreenCaptureKit access behind it, audio-only capture
  included. That's a real trust/UX cost: a guitar practice app asking
  for screen-recording access reads as alarming out of context, and
  needs an explicit, honest explanation in the permission-request flow
  ("this is only for capturing audio, nothing is recorded visually") or
  it's the kind of thing that gets an app uninstalled on principle.
- **Effort:** meaningfully higher. This requires actual native code — a
  small compiled Swift command-line helper the Python server shells out
  to (`subprocess`, same pattern as calling `ffmpeg` today, just a
  second binary). That is a **first** for this project: everything else
  is pure Python + ffmpeg + browser JS, with zero native/compiled
  components of its own. Introducing one means a build step, a
  distribution question (ship a prebuilt binary? build on first run?),
  and — if this project's App Store track
  (`appstore-plan.md`) ever actually happens — a second thing to get
  through review alongside the NAM/WASM audio engine already there.
- **No installed prerequisite for the user**, which is the real
  advantage — nothing to `brew install`, nothing to configure in Audio
  MIDI Setup.

## 3. Recommendation: Option A first, Option B only if real demand shows up

Ship the BlackHole path. It's a same-day feature built entirely on
infrastructure this project already has (ffmpeg subprocess calls, device
enumeration, the recording-finalize pipeline), asks for one well-known,
free, MIT-licensed install (the same category of ask as "install
ffmpeg," which USER-MANUAL.md already treats as a normal one-time setup
step) instead of a scary OS permission, and doesn't touch the project's
architecture. Revisit ScreenCaptureKit specifically if BlackHole's
install friction turns out to be a real adoption blocker in practice —
not preemptively, since that's a materially bigger and riskier build for
a benefit (no virtual-driver install) that may not matter to this app's
actual users.

## 4. Design (Option A)

### 4.1 Detecting readiness
Reuse the existing input-device enumeration (already built for Tone
Lab's device picker) to check for a device whose name contains
`"BlackHole"`. If none exists, the Rip panel shows install instructions
(`brew install blackhole-2ch`, a link to the project) instead of a
record button — same "clear status, no confusing dead end" pattern the
NAM live-overrun guardrail and the auto-calibrate flow already use.

### 4.2 Capture
```
ffmpeg -f avfoundation -i ":<BlackHole device index>" \
       -t <max duration guard> \
       -acodec libmp3lame -q:a 2 \
       input/<generated name>.mp3
```
Run as a subprocess the server starts on "Start Rip" and terminates
(`SIGINT`, letting ffmpeg finalize the mp3 properly rather than a hard
kill) on "Stop Rip" — same start/stop-a-subprocess shape as separation
already has, not a new pattern. A duration guard (e.g. refuse to start
past some sane cap, or just surface elapsed time live like the existing
recording-elapsed readout) avoids an accidentally-left-running capture
silently filling the disk.

### 4.3 Naming and Library integration
Prompt for a song name before starting (or default to a timestamp,
renamable after — consistent with how a regular import already lets you
rename on disk and have the project follow via content-hash keying).
Once the mp3 is written, it's just a normal file dropped into `input/`
— `refreshTrackList()` picks it up exactly like a manual drag-and-drop
import, no special-casing needed anywhere past this point. This is the
one place where "rip" and multi-stem-import (this same planning pass's
other new idea) share zero code — rip produces one ordinary file, the
normal single-file path handles everything from there.

### 4.4 Live feedback while capturing
A level meter (reuse the existing input-meter component/CSS from Tone
Lab's input card) driven by parsing ffmpeg's own stderr level output
(`-af 'astats'` or similar), or — simpler for a first cut — just an
elapsed-time readout and a pulsing "recording" indicator (reusing the
existing `#rec-pill` visual language) without a live meter at all. A
meter is a nice-to-have, not a blocker for v1.

## 5. Where this lives in the UI

Doesn't obviously belong inside Play Along (that screen's whole framing
is "your live rig," and this has nothing to do with the guitar signal
chain) or Tone Lab. Simplest fit: a small card in the sidebar area near
Import — "Rip currently-playing audio" as a sibling action to the
existing drop-zone, not a new top-level screen. Revisit if it turns out
to need enough controls (device picker, format options) to feel cramped
there.

## 6. Explicit non-goals (v1)

- **Per-app audio isolation** (capture just one app's output, not
  everything the Mac is playing). That's what a paid tool like Loopback
  does via per-app routing; BlackHole alone is a single system-wide
  tap. Not solvable in v1 without a much bigger Option-B-style
  investment — note it as a known limitation, not a bug.
- **Automatic silence-trimming / track-boundary detection** (ripping an
  album and auto-splitting into songs). Out of scope — this captures
  one continuous take, same shape as the existing take-recording
  feature; trimming is already a solved, separate feature
  (Takes' lossless trim, §10.3 of USER-MANUAL.md) if needed after.
- **Windows/Linux equivalents.** This spec is macOS-specific by
  necessity (BlackHole and ScreenCaptureKit are both Mac-only); the
  post-v4-compatibility-phase platforms would need their own
  loopback story (WASAPI loopback mode is actually *easier* on Windows
  than this is on Mac, PulseAudio/PipeWire monitor sources cover Linux)
  — worth a one-line note when that phase starts, not solved here.

## 7. One honesty/legal note, stated plainly once

This captures whatever's actually playing — which could be a personal
recording, a purchased track, or a copyrighted stream. That's the same
category of use this whole app already assumes for its core "import a
song you own and build a backing track from it" workflow — this feature
doesn't change that calculus, it just adds a second way to get audio in.
Worth exactly one honest line in the UI (something like "captures
whatever's currently playing on your Mac — use it the same way you'd use
any other imported song"), not a legal essay.
