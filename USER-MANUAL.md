# Guitar Studio — User Manual

**Status:** covers the rebuilt baseline app (M0–M5 of the rebuild) — everything
described here exists and has been tested. Nothing in this manual is
aspirational; features still on the roadmap live in
[release-v0.4-spec.md](release-v0.4-spec.md) instead.

---

## 1. What this is

Guitar Studio separates a song into stems (vocals/drums/bass/guitar/piano/
other), lets you build a custom backing track by muting/fading whichever
parts you don't want, and gives you a Play Along rig (amp modeling, effects,
cab simulation) to practice or record guitar over the result. Everything
runs locally in your browser, talking to a small Python server on your own
machine — nothing is uploaded anywhere.

## 2. Starting the app

Double-click **Guitar Studio.app**. It starts the local server (if it isn't
already running) and opens your browser to it. First launch: since this app
isn't signed/notarized, macOS Gatekeeper will likely block it — right-click
the app and choose **Open** once (or System Settings → Privacy & Security →
"Open Anyway"). You only need to do this once.

If you'd rather run it by hand (e.g. to watch the server log):

```bash
source venv/bin/activate
python3 GuitarStudio/server.py --port 8765
```

then open `http://127.0.0.1:8765/` yourself. The server only listens on
`127.0.0.1` (loopback) — nothing outside your Mac can reach it.

**Requirements:** the `venv/` must already have `pip install -r
requirements.txt` run inside it, and `ffmpeg` must be installed
(`brew install ffmpeg`). See [README.md](README.md) for the one-time setup.

## 3. Library & importing songs

The left sidebar lists every song under `input/`. Drag an audio file onto
the **Drop an audio file here** box, or click it to pick a file — either
way it's copied into `input/` and selected automatically.

Click any song to select it. What you see next depends on its state:

- **Not separated yet:** you'll see a model picker and a **Separate**
  button (§4).
- **Already separated:** the mixer loads immediately, restoring whatever
  mix you last saved for it.
- **Source file changed since separation:** an amber banner offers
  **Re-separate** or **Dismiss** — nothing is ever silently thrown away.

## 4. Separating into stems

Pick a model, then **Separate**. This runs entirely on your Mac (no
internet needed after the model weights are cached) and typically takes
somewhere around a quarter to a fifth of the song's length.

| Model | Stems | Notes |
|---|---|---|
| `htdemucs` | vocals, drums, bass, other | Default — fastest |
| `htdemucs_ft` | same | Slower, slightly cleaner |
| `htdemucs_6s` | + guitar, piano | Needed for the guitar split feature |
| `mdx` / `mdx_extra` | vocals, drums, bass, other | Alternative engine |
| `bs_roformer_sw` | vocals, drums, bass, guitar, piano, other | Newer model, notably better guitar-stem quality — see [guitar-separation-upgrade-spec.md](guitar-separation-upgrade-spec.md) |

You can **A/B two models on the same song**: click the model badge in the
toolbar to switch — if that model hasn't been run yet, you'll be prompted
to separate with it too. Nothing is overwritten; both live side by side.

**Honest limitation:** even with every stem at full volume and nothing
muted, the recombined mix has a mild "processed" character — that's the
separation engine's quality ceiling, not a bug in your mix.

## 5. The Mixer

Each stem is a lane: name, **M**(ute)/**S**(olo) buttons, a gain fader, and
its waveform. Solo is a *monitoring* convenience only — it never affects
what gets exported (§8). The transport bar has Play/Pause/Stop, a loop
toggle, and the current position.

**Speed** (0.5×–2×) changes playback rate while keeping pitch the same.
**Tune** (±100 cents) shifts pitch independently, at the same speed. Both
reset to neutral whenever you switch tracks — a leftover half-speed
setting silently carrying over to a new song would be a trap, not a
feature. The BPM readout (once a track's been separated) scales live with
the Speed slider.

## 6. Timeline mode & looping

Switch to **Timeline** (top toolbar) for tall waveforms and a paintable
mute lane under each stem — click-drag to mute just a section (e.g. a
guitar solo), click an existing region to remove it. This uses exactly the
same `(stem, start, end)` data the export engine does, so what you paint is
exactly what gets exported.

**A/B loop:** drag the two handles on the ruler above the lanes to set a
loop region; the **Loop** button in the transport toggles it on/off
(defaults to the whole track the first time you enable it). Click anywhere
on the ruler (not on a handle) to seek.

## 7. Guitar split (experimental)

Only available once a stem literally named `guitar` exists (i.e. you
separated with a 6-stem-capable model). Opens from the guitar lane or the
**Split guitar** toolbar button.

This is a **stereo-panning heuristic**, not a real lead/rhythm separation
model — no such model exists anywhere as an open weight (see
[guitar-separation-upgrade-spec.md](guitar-separation-upgrade-spec.md)).
The two results are always labeled **Candidate A (center)** and
**Candidate B (sides)** — never "Lead"/"Rhythm" — because which one is
actually which varies by song and sometimes neither is clean. Solo each
and judge by ear. The correlation number shown is diagnostic only; it does
not reliably predict whether the split will sound good.

## 8. Export

**Export bounces exactly what you hear** (except solo, which is
monitoring-only). Options:

- **Format:** WAV or MP3.
- **Target LUFS** (default −14).
- **Normalize loudness** — on by default; turn off to skip loudness
  correction entirely.
- **Max boost cap** (default +10 dB) — quiet/solo mixes can need a large
  corrective boost to hit the target loudness, which makes separation
  artifacts more audible. The cap limits how far that boost goes; you'll
  see a note if it was hit and the target wasn't fully reached.
- A peak-safety clamp (to about −0.2 dBFS) is automatic, not adjustable —
  it only fires as a last resort if normalization would otherwise clip.

Exported files land in `output/<song name>/`, alongside a model-prefixed
copy of every stem you've separated for that song.

## 9. Play Along

Click **🎸 Play Along** in the sidebar. This opens a rig that shares the
exact same audio engine as the mixer (not a second, separate audio
session) — so backing-track playback and your live guitar mix together
naturally, with no added round-trip latency from the recording or mixing
side.

### 9.1 Input
Pick your audio interface/microphone and click **Enable input** — the
browser will ask for microphone permission once. The meter shows input
level.

### 9.2 Noise Gate
A standard threshold gate (attack/release smoothed, so it doesn't click).
Bypass it if you'd rather always hear full signal.

### 9.3 Amp — three modes
- **Clean:** dry signal, no coloration — just gate → EQ → comp → delay/reverb.
- **Analog:** a drive stage (soft-clip waveshaper) plus a 3-band tone
  stack (bass/mid/treble).
- **Neural (NAM):** loads a `.nam` neural amp capture and runs real-time
  inference — see §9.6 for where to get models.

### 9.4 Cab IR
Loads a cabinet impulse response (`.wav`) via convolution. Simple on/off —
if your NAM capture already includes cabinet coloration (many do), leave
this off to avoid doubling up; it's there for the Analog/Clean paths or if
you want to experiment.

### 9.5 EQ, Compressor, Delay/Reverb, Output
A standard post-amp chain: 3-band EQ, a compressor (threshold/ratio),
delay (time/feedback/mix), and reverb (size/mix) — each independently
bypassable — then a final output level with a meter.

### 9.6 Adding amp models & cab IRs
Drop `.nam` files into `GuitarStudio/models/nam/` and `.wav` impulse
responses into `GuitarStudio/models/ir/` — they show up in the pickers
after reopening the panel (or clicking into the dropdown again), no
restart needed. Two small starter NAM captures ship with the app so
there's something to try immediately. [TONE3000](https://www.tone3000.com)
hosts a large free library of community `.nam` captures if you want more.

### 9.7 Suggest a tone
If the loaded song has a guitar stem, a **Suggest** button appears next to
the Amp section. It compares that isolated guitar stem against your
available NAM models (or, in Analog mode, nudges the tone-stack sliders)
using a brightness heuristic and picks the closest. **This is a rough
starting point, not a guaranteed match** — always finish by ear. See
[backing-track-tone-match-spec.md](backing-track-tone-match-spec.md) for
why an exact "make my rig sound like the record" match isn't a solved
problem anywhere, not just here.

### 9.8 Latency
The panel shows an estimated round-trip latency figure. It's **read from
the browser's own reported numbers, not independently measured** — treat
it as a rough indicator, not a lab result. If playing feels laggy, try a
smaller audio-interface buffer size in your interface's own control panel
software.

## 10. Recording a performance

Below the Input card, the **Record performance** card lets you record
yourself playing along, camera + the exact audio mix you're hearing
(backing track + your processed guitar), saved as a video file.

1. **Enable camera** — pick a camera and quality (720p or 1080p), grant
   camera permission once.
2. Optionally check **Start backing track with recording** to have
   playback begin the moment you hit record.
3. **● Record** / **■ Stop.** A red **● REC** pill appears in the main
   toolbar while recording, so you can switch back to the mixer mid-take
   without losing track that you're rolling — closing the tab is guarded
   too.
4. When you stop, the take uploads and is losslessly remuxed
   (fixes container quirks MediaRecorder is known to leave behind — no
   quality loss). You'll get **Reveal in Finder** and **Discard** options.

Takes are saved to `output/<song name>/recordings/` (or
`output/_untracked/recordings/` if no song was loaded), numbered
automatically.

**Camera never records audio** — it's opened video-only specifically so
there's no ambiguity with your interface input and no feedback risk. What
you hear is what gets recorded, from the same graph, not a room-mic
capture of your speakers.

### 10.1 A/V sync calibration
Consumer webcams have a real pipeline delay (commonly 50–200ms) — video
arrives late relative to audio, which is captured essentially instantly.
If takes look out of sync: **record a 5-second take clapping once in
front of the camera**, then open the file in QuickTime (or similar), find
the video frame where your hands meet and the audio spike of the clap,
and enter the difference (in milliseconds) into the **A/V offset** field
in the Record card. This delays the audio by that amount at finalize time
to match the late video — it's a one-time calibration per camera, and it
persists across sessions.

## 11. Projects (autosave)

Whatever you set up for a song — model, mix, mute regions, loop, view
mode — saves automatically a moment after you change it, and restores the
next time you select that song. There's no explicit "Save" button; it's
continuous.

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Separation failed" | Check the server's terminal/log for the actual error — usually a corrupt input file or a model download that got interrupted (needs network the first time a model is used). |
| MP3 export fails | `ffmpeg` isn't installed — `brew install ffmpeg`. |
| No sound in Play Along | Check the input device is actually enabled (not just selected), and that the gate threshold isn't cutting off a quiet signal. |
| Camera/mic permission denied | System Settings → Privacy & Security → Camera / Microphone → enable for your browser. |
| Guitar Studio.app won't open | Right-click → Open once, to get past Gatekeeper (it's unsigned). If that's not it, run the server by hand (§2) to see the actual error. |
| Recording didn't finalize / "not remuxed" note | `ffmpeg` isn't installed, or the remux itself failed — the raw take is still saved either way, just not container-fixed. |

## 13. Known limitations (by design, not oversights)

- Separation has an inherent quality ceiling — a mild "processed" texture
  is normal, not a bug.
- Guitar split is a panning guess, never a guaranteed lead/rhythm
  separation.
- NAM inference here is a from-scratch reimplementation of the standard
  architecture, not the official reference runtime — see
  [engine-spec.md](engine-spec.md) and the commit history for what that
  means in practice; quality is good but this isn't a certified bit-exact
  match to official NAM plugins.
- The tone-suggestion feature is a cheap heuristic, explicitly not a
  guaranteed match — always finish tone-matching by ear.
- The latency figure in Play Along is an estimate, not a measurement.

## 14. File locations reference

```
input/                          source songs you've imported
separated/<model>/<hash>/       cached stems (content-hash keyed)
output/<song>/                  exported mixes + a copy of every stem
output/<song>/recordings/       performance video takes
GuitarStudio/models/nam/        .nam amp captures
GuitarStudio/models/ir/         cabinet impulse responses
GuitarStudio/projects/          autosaved per-song mix state
```
