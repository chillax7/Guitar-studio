# Orpheus Guitar Studio — User Manual

Everything in this manual exists and works today — nothing here is
aspirational. An in-app **❓ Help** button (sidebar) covers the same
essentials for anyone who won't read this file.

New to the app, or verifying a fresh build? Open
[FIRST-SESSION-CHECKLIST.html](FIRST-SESSION-CHECKLIST.html) directly in a
browser (no server needed) for a self-contained, tickable walkthrough of
every feature in first-use order — progress is saved locally as you check
things off. [TEST-PLAN.md](TEST-PLAN.md) covers the same ground the other
way round, as a regression pass grouped by app area for after a change.

---

## 1. What this is

Orpheus Guitar Studio separates a song into stems (vocals/drums/bass/guitar/
piano/other), lets you build a custom backing track by muting/fading whichever
parts you don't want, and gives you a Play Along rig (amp modeling, effects,
cab simulation, a tuner, and performance recording) to practice or record
guitar over the result. Everything runs locally in your browser, talking to a
small Python server on your own machine — nothing is uploaded anywhere.

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

The top banner ("Orpheus Guitar Studio" + a version number) is just an
identity strip — if you ever report a bug, that version number is useful to
mention.

## 3. Library & importing songs

The left sidebar lists every song under `input/`. Drag an audio file onto
the **Drop an audio file here** box (dropping anywhere in the sidebar works,
not just the small box itself), or click it to pick a file — either way it's
copied into `input/` and selected automatically. Large files may take a
moment to upload; the drop box shows "Importing…" while that's in progress.

Click any song to select it. A brief **Loading…** state shows while its
stems are being fetched; what you see once that resolves depends on the
song's state:

- **Not separated yet:** you'll see a model picker and a **Separate**
  button (§4).
- **Already separated:** the mixer loads immediately, restoring whatever
  mix you last saved for it.
- **Source file changed since separation:** an amber banner offers
  **Re-separate** or **Dismiss** — nothing is ever silently thrown away.

### 3.1 Importing a stem pack (.zip)
Already have a song split into its parts — a purchased "custom backing
track" pack, a friend's multitrack export, anything pre-split? Skip
separation entirely: click **or import a stem pack (.zip)**, just below
the normal drop zone (or drag the `.zip` straight onto the sidebar — it's
detected automatically and routed here, not treated as a broken audio
file). Every audio file inside becomes its own stem lane, named exactly
as the file was — long names wrap in the lane header rather than getting
cut off, and nothing is renamed or "prettified." The track appears in
your Library immediately, with its own autosaved project and practice
log entry, exactly like any other song. Each stem is converted to WAV on
import (so it works with the rest of the app the same way a separated
stem does) but never run through separation — that's the whole point.
BPM, beat grid, chord lane, and key detection all still work on an
imported pack, matching stems by name (anything that looks like a
guitar/bass/piano/drum part) rather than needing the fixed stem names a
separation model produces. If two files in the zip would collide to the
same stem name, the import fails up front with a clear message naming
both, rather than silently overwriting one.

### 3.2 Rip — capture whatever's playing on your Mac
Don't have the file at all — just something playing in a browser tab,
another app, anywhere on your Mac? The **Rip system audio** card in the
sidebar captures it straight into your Library as a new song. This needs
a one-time install of a free, open-source virtual audio driver,
[BlackHole](https://github.com/ExistentialAudio/BlackHole)
(`brew install blackhole-2ch`), set as your Mac's audio output — the
panel shows this instruction automatically if no BlackHole device is
found yet. Once it's installed, pick it in the device dropdown, click
**● Start Rip**, and the elapsed time counts up while it records; click
**■ Stop Rip**, give the take a name, and it appears in your Library like
any other imported song. One thing worth knowing up front: routing
straight to BlackHole means *you* hear silence while ripping (the audio
is going to the capture device, not your speakers) — build a
**Multi-Output Device** in Audio MIDI Setup (combining BlackHole with
your normal output) if you want to hear it too while it records; the
panel's own hint says so.

### 3.3 Playlists / setlists
The **Playlists** section above the Library picks which set of songs
`#track-list` shows and in what order. **— All songs —** (the default) is
the normal alphabetical Library. Pick a playlist instead and the same list
switches to that playlist's songs in playlist order, with **▲ / ▼** to
reorder and **✕** to remove a song from the playlist (never deletes the
song itself). **+ New** creates one (seeded with whatever song is
currently loaded, if any); **Rename**/**Delete** act on whichever playlist
is selected. While a playlist is active, a second row appears: **◀ Prev**
/ **Next ▶** step through it relative to the currently loaded song (stops
at either end — a setlist doesn't wrap around), and **+ Add current song**
appends the loaded song to the end. Clicking any song, in either view,
loads it exactly the same way — a playlist is only ever an ordering, never
a copy of a song's mix/rig settings.

### 3.4 Practice log
Every song's Library row shows a small dim time readout (e.g. "1h 12m")
once you've played it for at least a minute, with a tooltip giving the
exact total and the last-practiced date. This counts actual elapsed time
with the backing track playing — Mixer or Play Along, either counts, and
it doesn't care why playback is happening (a loop, a speed-trainer pass,
just listening) — paused/stopped time doesn't count. It's a plain running
total, not a streak counter or a goal tracker: no gamification, just an
honest "how much have I actually played this" number.

## 4. Separating into stems

A track imported as a stem pack (§3.1) skips this section entirely —
its model badge just reads `imported`, and the mixer is ready the moment
you select it. Everything below is for a normal single-file import.

Pick a model, then **Separate** (styled the same blue as Export — it's the
main action once you've picked a model). This runs entirely on your Mac (no
internet needed after the model weights are cached) and typically takes
somewhere around a quarter to a fifth of the song's length. A progress bar
shows separation is actively progressing — it isn't a countdown/time
estimate, just a heartbeat that something is happening.

| Model | Stems | Notes |
|---|---|---|
| `bs_roformer_sw` | vocals, drums, bass, guitar, piano, other | **Default.** Notably better guitar-stem quality than the Demucs models |
| `htdemucs` | vocals, drums, bass, other | Fast, no guitar stem |
| `htdemucs_ft` | same | Slower, slightly cleaner |
| `htdemucs_6s` | + guitar, piano | Also guitar-capable, if you want to A/B against `bs_roformer_sw` |
| `mdx` / `mdx_extra` | vocals, drums, bass, other | Alternative engine |

You can **A/B two models on the same song**: click the model badge in the
toolbar to switch — if that model hasn't been run yet, you'll be prompted
to separate with it too. Nothing is overwritten; both live side by side.

**Honest limitation:** even with every stem at full volume and nothing
muted, the recombined mix has a mild "processed" character — that's the
separation engine's quality ceiling, not a bug in your mix.

## 5. The Mixer

Each stem is a lane: name, **M**(ute)/**S**(olo) buttons, a gain fader
(double-click its percentage to reset to 100%), a
**Pan** slider, an **EQ** disclosure (3-band: bass/mid/treble, ±12dB), and
its waveform. **Solo, Pan, and EQ are all *monitoring* conveniences only —
none of them affect what gets exported (§8)**; they're there to help you
carve space to play along (pan the drums off-center, cut some bass mud
while you practice), not to change the mix your export produces.

Playback controls split across two rows. The **top toolbar** (left of the
model badge and Separate button) holds the timeline tools: **Loop**,
**+ Marker**, **Zoom to loop / Zoom out**, **Click**, and **Count-in** —
all toggle buttons that light up **blue when active** (Loop lights
**green** while loop mode is running — green means "a playback state is
engaged", blue means "an option is on"). The **transport bar** below it
has the playback essentials:

- **Play / Pause / Stop** and the current position.
- **BPM** — the detected tempo, rounded to the nearest whole number, scaling
  live with the Speed slider. Automatic tempo detection occasionally locks
  onto exactly half or double the real tempo (a well-known limitation of
  tempo estimation, not specific to any one song) — the small **½×**/**2×**
  buttons beside it correct this in one click and the fix is remembered for
  that song from then on.
- **Speed** (0.5×–2×) — changes playback rate while keeping pitch the same.
  Double-click the ×-value to reset to 1.00×.
- **Tune** (±1200 cents = ±1 octave) — shifts pitch independently, at
  the same speed. Fine corrections handle a record that's slightly off
  concert pitch (±100¢ ≈ ±1 semitone); the full-octave range makes it a
  transpose control for playing a song in an easier key. Double-click the
  ¢-value to reset to 0. The inspector
  panel shows a **detected key** (a heuristic — confirm by ear) and, once
  you move Tune off zero, what key that transposition actually lands you
  in (e.g. "Transposed +2 semitones → A major"). Once the chord lane (§6)
  has confident chords, the key reading is based on those (whichever
  chord shows up most often, in practice usually the tonic) rather than
  raw pitch-content correlation — noticeably more reliable on blues/rock,
  where a lot of dominant-7 chords can otherwise fool a plain major/minor
  match.
- **Volume** — an overall listening-level slider for the backing track.

And the two toolbar click features:

- **Count-in** — when on, playback (and recording — §10) starts after 2
  bars of click, synced to the track's detected BPM.
- **Click** — a metronome click synced to the actual detected
  beat grid (not just an assumed manual BPM, like the count-in). Every
  4th beat is accented as a downbeat (an assumed 4/4 — there's no time-
  signature detection). Driven from the same per-frame position poll the
  playhead uses rather than pre-scheduled, so it tracks Speed and Tune
  automatically, at the honest cost of a few ms of animation-frame jitter
  versus a real hardware click. A faint beat grid also appears on the
  ruler itself (brighter tick = downbeat) for precise loop/marker
  placement. If Click is grayed out, the track has no beat grid yet —
  this is analyzed automatically when a track is (re)selected, so simply
  reselecting it turns Click on.

Speed and Tune reset to neutral whenever you switch tracks — a leftover
half-speed setting silently carrying over to a new song would be a trap,
not a feature. **Volume does not reset** on track switch — it's your
listening level, not something that belongs to any one song.

## 6. Timeline mode & looping

Tall waveforms with a paintable mute lane under each stem sit directly below
the transport — click-drag to mute just a section (e.g. a guitar solo),
click an existing region to remove it. This uses exactly the same
`(stem, start, end)` data the export engine does, so what you paint is
exactly what gets exported.

**A/B loop:** drag the two handles on the ruler above the lanes to set a
loop region; the **Loop** button in the toolbar toggles it on/off
(defaults to the whole track the first time you enable it). Click anywhere
on the ruler (not on a handle) to seek. Hold **Alt** while pressing **←/→**
for a finer 100ms nudge (Shift is still the coarse 5s jump) — useful for
lining a loop/mute edge up to an exact transient.

**Waveform zoom:** with a loop set, click **Zoom to loop** in
the toolbar to rescale the ruler and every lane's waveform to fill the
view with just that region — real added detail, not the same picture
stretched, since the waveform re-renders from the source audio at the new
resolution. Everything stays consistent while zoomed: ruler clicks, loop-
handle drags, and mute-region painting all map to time correctly within
the zoomed range; markers/beat-grid ticks outside it simply don't draw.
**Zoom out** returns to the whole track. Zoom is a per-session view aid,
like Speed/Tune — it resets when you switch tracks.

**Continuous zoom:** the **Zoom** slider next to Zoom to loop/Zoom out
works independently of them — instead of narrowing the time range shown
(what Zoom to loop does), it widens the ruler/waveforms/chord lane beyond
the window, scrolling horizontally. Stem names and their mute/solo/fader/
pan/EQ controls stay fixed on the left as you scroll, same idea as a
DAW's frozen track headers. During playback, the view follows the
playhead once it crosses the middle of the window (GarageBand-style) —
it doesn't scroll before then, and it snaps straight to center on a big
jump (a loop wrap, a marker double-click, a manual seek), rather than
leaving the playhead stranded off-screen. The two zoom controls combine:
zoom to a loop first, then drag the slider to zoom in further within
just that region. Double-click the slider to reset to fit-width. Also a
per-session view aid — resets on track switch, same as Zoom to loop.

**Section markers:** click **+ Marker** in the toolbar to drop a
named marker at the current playhead position (you'll be asked to name
it — "Solo", "Chorus 2", whatever helps). Markers appear as small tags in
a strip above the ruler:
- **Click** a marker to jump the playhead there.
- **Double-click** a marker to loop from it to the *next* marker (or the
  end of the track, if it's the last one) — turns Loop on automatically.
  This is the fast way to isolate a solo: drop a marker where it starts,
  another where it ends, double-click the first.
- Hover a marker to reveal a small **×** to delete it.

Markers are saved per-song, same as everything else in §6.

**Chord lane:** a row of chord chips above the ruler (only appears once
chord analysis exists — it's computed automatically alongside BPM/beats/
key, so older tracks pick it up the next time they're selected). Each chip
spans one beat-grid interval; click one to jump the playhead there. This
is a **maj/min/7-only heuristic** — beat-synchronous chroma matched
against simple chord templates, not a real chord-recognition model —
assistive and best on pop/rock, same honesty framing as §7's guitar split.
A dimmed **?** chip means no confident read for that beat rather than a
guess; zoom in (above) to actually read the chord names, since a whole
song's worth of chips at full width just reads as a solid bar. Chord roots
transpose live with the Tune slider, same as the Detected Key hint in §5.

**Speed Trainer:** in the right-hand inspector — set a loop first
(a marker double-click is the fastest way), then use **Start** / **Step
up** instead of dragging the Speed slider by hand between passes. Start
jumps to a reduced practice speed (default 60%); each **Step up** click
nudges Speed toward Target (default 100%) by Step (default 10 points),
clamping exactly at Target on the last click rather than overshooting.
Practice a hard passage slow, then step it up toward full tempo one clean
pass at a time.

## 7. Guitar split (experimental)

Only available once a stem literally named `guitar` exists (i.e. you
separated with a 6-stem-capable model). Opens from the **Guitar - Lead /
Rhythm Split** section in the right-hand inspector once a guitar stem is
loaded.

This is a **stereo-panning heuristic**, not a real lead/rhythm separation
model — no such model exists anywhere as an open weight.
The two results are always labeled **Candidate A (center)** and
**Candidate B (sides)** — never "Lead"/"Rhythm" — because which one is
actually which varies by song and sometimes neither is clean. Solo each
and judge by ear. The correlation number shown is diagnostic only; it does
not reliably predict whether the split will sound good.

Three split algorithms are offered:

- **Spectral** (default) — adapts the center/sides split per frequency
  bin, usually the best starting point.
- **Mid-side** — the blunt whole-track version: one fixed 50/50 split
  applied everywhere. Rarely beats Spectral, kept mainly for comparison.
- **Hybrid** — Spectral, sharpened using how tightly the guitar's note
  onsets line up with the song's detected beat grid. Still not a
  lead/rhythm classifier — it's a confidence tweak on top of the same
  panning read, on the theory that strummed/chordal playing sits at a
  more decisively fixed stereo position than a lead line wandering under
  bends and vibrato. Needs a detected beat grid to do anything (falls
  back to plain Spectral without one — instrumental-only tracks or ones
  where tempo detection failed won't see a difference from Spectral).

None of the three is guaranteed to beat the others on a given song —
try more than one and judge by ear, same as always.

## 8. Export

The **Export** section is always visible in the right-hand inspector once a
track's stems are loaded — no separate button to click to reveal it.
**Export bounces exactly what you hear** (except solo, which is
monitoring-only). Options:

- **Format:** WAV or MP3.
- **Output name.**
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
copy of every stem you've separated for that song. After a successful
export you get a **Reveal in Finder** shortcut straight to it.

## 9. Tone Lab & Play Along

The rig lives across two screens, plus the mixer you started in and
Help — four equally-reachable buttons in the top-left of the sidebar
(**🎚 Mixer**, **🎛 Tone Lab**, **🎸 Play Along**, **❓ Help**).
Both rig screens share the exact same audio engine as the mixer (not a
second, separate audio session) — backing-track playback and your live
guitar mix together naturally, with no added round-trip latency from the
recording or mixing side. The split is by *task*, not by feature: **Tone
Lab** is where you build/tweak the sound (input, amp, cab, all 12 pedal
cards, rig presets); **Play Along** is where you practice and record with
a rig you've already dialed in (backing track, tuner, riff capture,
recording, takes) — a quick rig-preset picker on Play Along means you
don't have to bounce back to Tone Lab just to switch rigs mid-session.
Selecting a track in the Library always drops you back to the Mixer,
closing whichever of the two rig screens was open.

Every rig card, on either screen, has a collapse arrow (▾) in its header
if you want to hide one you're not touching this session — collapse
state is remembered between visits. A faint arrow between cards on Tone
Lab traces the signal-chain order live as you drag cards around.

### 9.0 Backing Track (Play Along, top strip)
The full transport from the main mixer — Play/Stop, Loop, Count-in, BPM,
Speed, Tune, Volume — is mirrored here too, so you never need to leave Play
Along to control the backing track while you're actually playing. It's the
exact same state as the main transport; adjusting either one updates both.

### 9.1 Input (Tone Lab, top strip)
The input meter, clip light, and a **Setup: device & calibration**
disclosure sit in Tone Lab's top strip. Expand **Setup**, pick your audio
interface/microphone, and click **Enable input** — the browser will ask
for microphone permission once. "Enable Input" prefers a remembered
device (whichever you used last time) or, failing that, any input that
doesn't look like a built-in microphone — a Mac's built-in mic monitored
through speakers into an amp/distortion chain is a feedback loop, so
guessing an external interface first matters. Switching the device
dropdown while already enabled re-enables input on the new device
automatically. The Setup disclosure stays open once expanded — collapse
it yourself if you want the space back. The meter shows input level with
too-cold/good/too-hot zones; a **clip** light latches on if a transient
clips (it doesn't self-clear — click **Clear**, or start a new input
session, once you've noted it and fixed your gain staging). **Calibrate
(play your loudest chord)**, inside Setup, listens for 3 seconds and
suggests an output trim so your loudest playing lands safely below
clipping.

### 9.2 Tuner (Play Along, top strip)
Click **Tuner: Off** to switch it on — the button label and the panel
update to show note name, cents off, and a needle (green when within 5
cents of true). **Turning the tuner on mutes the backing track and your
processed guitar tone** (both restore to whatever level they were actually
at once you turn it back off) — the same convention as a hardware tuner
pedal muting its through signal, since tuning by ear against either fights
the point of a tuner. The tuner needs a single, sustained note — chords
won't read cleanly.

### 9.3 Amp — three modes (Tone Lab)
- **Clean:** dry signal, no coloration — just gate → EQ → comp → delay/reverb.
- **Analog:** a drive stage (soft-clip waveshaper) plus a 3-band tone
  stack (bass/mid/treble).
- **Neural (NAM):** loads a `.nam` neural amp capture and runs real-time
  inference — see §9.6 for where to get models, §9.3a for the Tweaker
  controls, and §9.9 for a note on which captures can and can't run live.

### 9.3a The NAM Tweaker
A standard `.nam` capture is a snapshot of one amp at one knob setting —
there's no gain/presence/bass/treble hiding inside the file to expose, the
knobs were frozen in when it was trained. The Neural mode panel builds a
tone-shaping surface *around* the capture instead, the same way NAM's own
plugin does:

- **Metadata** — whatever the loaded `.nam` file's own metadata actually
  carries (real captures usually carry little to none of it — this is
  shown honestly, not padded out), plus what this app itself knows:
  architecture, the realtime-cost estimate from the speed probe, whether
  loudness metadata drove auto-calibration, and an ESR pulled from the
  filename if one's embedded there.
- **Drive** (-24 to +48 dB) — the closest thing to a real "gain knob" a
  frozen capture allows: it's how hard you push the captured amp, like a
  boost pedal in front — genuinely changes the distortion character.
- **Bass / Mid / Treble / Presence** — a dedicated post-amp tone stack
  *inside* the amp block, before Cab IR, separate from the EQ card further
  down the chain. Presence is a high-shelf tilt around 6kHz. Flat (0dB) by
  default — today's sound is unaffected until you reach for these.
- **Output level** — paired with an **auto-level** readout showing the
  calibration gain a capture without loudness metadata gets, measured
  against a test tone. The slider adds on top of that calibrated number.
- **Parametric captures** — a rare "A2"/slimmable NAM family has real
  conditioning knobs; this app's engine only supports the standard
  (ordinary shared-capture) architecture. Loading one of these shows an
  honest "not yet supported" message instead of a confusing generic
  failure or silently misreading the weights.

### 9.3b Rig presets (Tone Lab, plus a quick picker on Play Along)
The **Rig Presets** card (above the pedalboard, on Tone Lab) saves the
*entire* rig — amp mode, NAM capture + Tweaker knobs (or Analog's tone
stack), Cab IR, EQ, Compressor, Delay/Reverb, all the pedals, and Output
level — as a named preset. Presets are shared across every song (stored
server-side, not per-track). **Attach to this song** writes the preset's
name into the current song's saved project, so reopening that song
automatically recalls the rig the next time you open either rig screen —
build the tone once, never rebuild it by hand again for that song.

Play Along carries a lighter **Rig Preset** picker in its own top strip —
just a dropdown, no Save/Delete/Attach controls, for switching between
rigs you've already built (e.g. Clean/Rhythm/Solo for one song) without
leaving the practice screen. Picking a name there applies it immediately;
both dropdowns always show the same selection.

### 9.4 Cab IR (Tone Lab)
Loads a cabinet impulse response (`.wav`) via convolution. Simple on/off —
if your NAM capture already includes cabinet coloration (many do), leave
this off to avoid doubling up; it's there for the Analog/Clean paths or if
you want to experiment. Picking an IR automatically turns bypass off, so
you actually hear it.

**Tone shaper:** a low-cut and high-cut filter on the loaded IR's wet
signal only (the dry bypass path is never touched), for trimming a cab
sim's extreme top/bottom independently of the general EQ card further down
the chain — e.g. cutting sub-bass rumble a real mic'd cab wouldn't
reproduce, or taming fizz above where a guitar speaker rolls off. Wide
open (no-op) by default; "Tone shape bypass" turns it off entirely without
losing your slider positions.

### 9.5 The pedalboard: EQ, Compressor, Delay/Reverb, Output, and more (Tone Lab)
A standard post-amp chain — 3-band EQ, a compressor (threshold/ratio),
delay (time/feedback/mix), and reverb (size/mix), each independently
bypassable — plus eight further pedal cards, then a final output level
with a meter:

- **Boost/Overdrive** — Drive + Level, a gain-staged waveshaper (the same
  distortion curve the Analog amp uses), true hard bypass.
- **Graphic EQ** — 5 bands (100Hz/300Hz/1kHz/3kHz/8kHz), ±12dB each,
  distinct from the 3-band EQ card.
- **Chorus**, **Flanger** — modulated short delays (Rate/Depth/Mix, plus
  Feedback on the Flanger for its resonant edge).
- **Phaser** — a 4-stage sweep (Rate/Depth/Mix).
- **Tremolo** — amplitude modulation (Rate/Depth), no dry/wet mix since
  there's nothing to blend.
- **Auto-Wah** — an LFO-swept bandpass (Rate/Depth/Center/Mix). Named
  "Auto-Wah," not "Wah," on purpose: this sweeps on its own timer, it
  doesn't track an expression pedal — there's no MIDI/expression input
  wired up yet.
- **Octaver** — a real octave-down via zero-crossing frequency division
  (Blend knob), the same technique classic analog octave pedals use.
  Monophonic by construction; it's cleanest on single notes and breaks up
  on chords, same honesty-note spirit as
  the guitar-split and chord-detection features elsewhere in this app.

**Drag-to-reorder:** all twelve of the above (Cab IR, EQ, Compressor,
Delay/Reverb, and the eight new pedals) can be rearranged into any order —
drag a card by the **⠿** handle in its header and drop it where you want
it. Wah before the amp's drive, chorus after, whatever your ears want.
Gate and Amp stay fixed at the front of the chain and Output stays fixed
at the end; everything between them is reorderable. Order persists across
reloads and is captured/recalled as part of a rig preset (§9.3b) — save
your whole rig, pedal order included.

**Signal-flow arrows:** the pedalboard draws a faint arrow from each card
to the next in chain order, redrawn live as you drag-reorder, collapse
cards, or resize the window — a quick visual answer to "what feeds what"
now that the board runs twelve-plus cards deep. Purely a visual aid; it
has no effect on the actual audio routing.

### 9.6 Adding amp models & cab IRs (Tone Lab)
Drop `.nam` files into `GuitarStudio/models/nam/` and `.wav` impulse
responses into `GuitarStudio/models/ir/` — subfolders are fine (a large
library organized into pack folders is scanned recursively) and they show
up in the pickers after reopening the panel, no restart needed. Both
pickers are a searchable, folder-navigable browser rather than a flat
list — type in the search box to filter across the whole library
regardless of folder, or click through folders to browse. Two small
starter NAM captures ship with the app so there's something to try
immediately. [TONE3000](https://www.tone3000.com) hosts a large free
library of community `.nam` captures if you want more.

### 9.7 Suggest a tone (Tone Lab)
If the loaded song has a guitar stem, a **Suggest from this track's
guitar stem** button appears — only in Neural (NAM) mode, just below the
Output trim slider. It compares that isolated guitar stem against your
available NAM models (or, in Analog mode, nudges the tone-stack sliders)
using a brightness heuristic and picks the closest. **This is a rough
starting point, not a guaranteed match** — always finish by ear; an exact
"make my rig sound like the record" match isn't a solved problem
anywhere, not just here. Suggest automatically skips any capture too
heavy to run live (§9.9).

### 9.8 Latency (Tone Lab)
The Output card shows an estimated round-trip latency figure. It's **read from
the browser's own reported numbers, not independently measured** — treat
it as a rough indicator, not a lab result. If playing feels laggy, try a
smaller audio-interface buffer size in your interface's own control panel
software.

### 9.9 NAM performance — why some captures won't load
Real-time neural amp inference is genuinely demanding, and not every
`.nam` capture in a large community library can run live on every Mac.
Before a model goes live, it's benchmarked automatically; if it can't keep
up in real time, you'll see a plain message instead of it silently
breaking your audio:

> Not loaded: this capture needs ~97% of this machine's audio budget — it
> can't run live and would cut ALL sound. Look for a "Lite" or "Feather"
> version of the same amp instead.

Most amp packs that publish a "Standard" capture also publish "Lite" or
"Feather" variants of the same tone — those are built to be lighter to run
and are usually the better choice for live playing anyway. The engine
itself runs on WebAssembly with SIMD where your browser supports it (about
10× faster than the pure-JavaScript fallback it silently drops back to
otherwise) — if a capture is refused, it's genuinely too heavy for this
machine right now, not a bug to work around.

## 10. Recording a performance

On the **Play Along** screen, the **Record performance** card sits below
the top strip. It lets you record yourself playing along — the exact
audio mix you're hearing (backing track + your processed guitar), with or
without camera video.

1. **Camera is optional.** A hint above the Record button
   says which you'll get: enable a camera (Expand **Setup: camera, quality
   & sync**, pick a camera and quality, grant permission once) for a video
   take, or skip it entirely for an **audio-only** take — useful when you
   just want the performance captured without the storage/setup overhead
   of video. The camera preview only appears once a camera is actually
   enabled — no permanent black box taking up space before you've turned
   one on. **Show framing guides** (video only) overlays a rule-of-thirds
   grid plus a dashed band where a horizontally-held guitar neck typically
   falls for a seated player.
2. Optionally check **Start backing track with recording** to have
   playback begin the moment you hit record, and/or **Start with
   count-in** for a 2-bar click before both start together.
3. **● Record** / **■ Stop.** A red **● REC** pill appears in the main
   toolbar while recording, so you can switch back to the mixer mid-take
   without losing track that you're rolling — closing the tab is guarded
   too. **Stop also stops the backing track**, so a take doesn't end with
   the mix still playing on regardless.
4. When you stop, the take uploads and is losslessly remuxed
   (fixes container quirks MediaRecorder is known to leave behind — no
   quality loss). You'll get **Reveal in Finder** and **Discard** options.
   Audio-only takes save as `.m4a` (or `.webm`, browser-dependent); video
   takes as `.mp4`/`.webm`.

Takes are saved to `output/<song name>/recordings/` (or
`output/_untracked/recordings/` if no song was loaded), numbered
automatically.

**Camera never records audio** — it's opened video-only specifically so
there's no ambiguity with your interface input and no feedback risk. What
you hear is what gets recorded, from the same graph, not a room-mic
capture of your speakers.

### 10.1 Riff capture — "Save that!"
The **Riff Capture** card, in Play Along's top strip, is always quietly
rolling once your rig is active — opening either Tone Lab or Play Along
starts it, no button to start it, nothing to forget. It keeps the last
~20 seconds of the same live mix a real take captures
(backing track + your processed guitar) in memory. Play something you
didn't plan to keep, realize afterward it was good, click **🎸 Save
that!** within that window and it's saved as a WAV file alongside your
regular takes (numbered separately, "riff 01", "riff 02", …) — no need to
have hit Record in advance. Saving doesn't interrupt the rolling capture;
it keeps going right after.

### 10.2 A/V sync calibration
Consumer webcams have a real pipeline delay (commonly 50–200ms) — video
arrives late relative to audio, which is captured essentially instantly.
Two ways to fix it:

- **Auto-calibrate (wait a beat, then strum once, ~5s)** — records a short
  burst and finds the moment your strum hits in both the video and the
  actual recorded audio. It deliberately asks for a strum, not a clap: what
  gets calibrated against is the same signal a take actually records —
  backing track + your **processed guitar** (§10) — which has no live
  microphone in it by design, so a clap makes no sound in it no matter how
  loud it is in the room. Needs **Input enabled** first (§9.1) with your
  instrument actually connected — this is calibrating your real rig's
  path, not a side-channel mic (which, monitored through speakers rather
  than headphones, is also the fastest way to a feedback howl). Waiting
  briefly before strumming matters: the first fraction of a second measures
  background noise/motion so the real strum can be told apart from it.
  Quick, but not infallible — a result flagged as implausible (outside the
  50–300ms range real webcam latency falls in) is more likely a mistimed
  detection than genuine lag; retry or fall back to manual.
- **Manual:** record a 5-second take striking a single hard, clear note
  visibly, open the file in QuickTime (or similar), find the video frame
  where you strike it and the audio spike of that note, and enter the
  difference (in milliseconds) into the **A/V offset** field yourself.

Either way, this delays the audio by that amount at finalize time to match
the late video — it's a one-time calibration per camera, and it persists
across sessions.

### 10.3 Takes
Every take for the currently-loaded song is listed under **Takes**, each
with:

- **★ / ☆** — star a take to flag a keeper.
- **Play** — loads it into a small player below the list.
- **Rename** — rename in place.
- **Reveal** — show it in Finder.
- **Delete** — permanent, asks to confirm first.

With a take loaded in the player, **Trim start/end** sliders plus **Trim
(lossless copy, new file)** cut the top/tail off losslessly (stream copy,
no re-encode) and save the result as a new file — your original is never
touched.

### 10.4 Practice mode: auto-retake on loop
Below the count-in checkbox, **Practice mode: auto-retake each loop
pass** turns the loop into a repeat-and-review drill: set a loop region
and turn on **Loop** first (§6), then check this box. It starts the
backing track from the top of the loop, records the first pass, and the
instant playback wraps back to the loop start it saves that pass as its
own take and starts recording the next one — automatically, for as many
passes as you play, with the backing track never stopping in between.
Uncheck the box (or just stop playback) to end the session; whatever pass
was in progress is saved as a normal take like any other, ready to star,
play, or delete in the Takes list above. The manual **● Record** button
is disabled for the duration — practice mode owns the record cycle
itself, so it doesn't compete with a manual click.

Nothing here changes what a take *is* — passes are numbered and stored
exactly like a normal take (§10.3), so you review and cull them the same
way: play a few back, star the good ones, delete the rest.

### 10.5 Compare two takes side by side
Check the box on any two rows in the Takes list to open a **Compare
Takes** card: both takes play back together from the same starting point,
kept in sync automatically (a drift check runs every half-second, so two
independent players don't slowly pull apart). The **Listening: A/B**
toggle switches which one you actually hear without breaking that sync or
restarting either — useful for A/B-ing two practice-mode passes, or a
keeper take against an earlier attempt. A shared seek bar scrubs both at
once. Only two can be selected at a time; uncheck one before picking a
different third.

## 11. Projects (autosave)

Whatever you set up for a song — model, mix, mute regions, loop, markers,
rig preset — saves automatically a moment after you change it, and
restores the next time you select that song from the Library. There's no
explicit "Save" button and no separate "Projects" screen to browse — the
Library sidebar itself *is* the project list; clicking a song is opening
its project. A small dot next to a track's name means it has a saved
project.

**Renaming is safe:** projects are keyed by the source file's actual
content (a hash of its bytes), not its filename — the same scheme the
stem cache uses. Rename a source file outside the app (e.g. in Finder)
and its saved mix follows the rename automatically, since renaming
doesn't change the file's bytes.

## 12. Keyboard shortcuts

Press **?** anywhere in the mixer to bring up the full legend on-screen.
For reference:

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `L` | Toggle loop |
| `[` / `]` | Set loop start / end to the current playhead |
| `M` / `S` | Mute / solo the lane under the mouse |
| `R` | Start / stop recording |
| `←` / `→` | Nudge playhead (hold Shift for 5-second steps) |
| `?` | Toggle the shortcuts legend |

Shortcuts don't fire while a text field has focus.

## 13. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Separation failed" | Check the server's terminal/log for the actual error — usually a corrupt input file or a model download that got interrupted (needs network the first time a model is used). |
| MP3 export fails | `ffmpeg` isn't installed — `brew install ffmpeg`. |
| No sound in Play Along | Check the input device is actually enabled (not just selected), and that the gate threshold isn't cutting off a quiet signal. |
| A NAM model won't load / shows a "not loaded" message | It's too demanding to run live on this machine (§9.9) — try a "Lite" or "Feather" version of the same amp. |
| Tuner works but I can't hear anything | Expected — the tuner mutes the backing track and your amp tone while it's on (§9.2); turn the tuner off to hear audio again. |
| Camera/mic permission denied | System Settings → Privacy & Security → Camera / Microphone → enable for your browser. |
| Guitar Studio.app won't open | Right-click → Open once, to get past Gatekeeper (it's unsigned). If that's not it, run the server by hand (§2) to see the actual error. |
| Recording didn't finalize / "not remuxed" note | `ffmpeg` isn't installed, or the remux itself failed — the raw take is still saved either way, just not container-fixed. |
| Trimming a take fails with "file not found" | Only possible if you renamed the take in another app while it was loaded in the player — reload the take from the Takes list and trim again. |

## 14. Known limitations (by design, not oversights)

- Separation has an inherent quality ceiling — a mild "processed" texture
  is normal, not a bug.
- Guitar split is a panning guess, never a guaranteed lead/rhythm
  separation.
- NAM inference here is a from-scratch reimplementation of the standard
  WaveNet architecture (with an optional WebAssembly/SIMD fast path), not
  the official reference runtime — quality is good but this isn't a
  certified bit-exact match to official NAM plugins, and heavier captures
  may be refused on slower machines rather than glitch your audio (§9.9).
- The tone-suggestion feature is a cheap heuristic, explicitly not a
  guaranteed match — always finish tone-matching by ear.
- The latency figure in Play Along is an estimate, not a measurement.
- The Click and beat grid assume 4/4 time — there's no time-signature
  detection, so the downbeat accent will be wrong in 3/4 or odd meters.

## 15. File locations reference

```
input/                          source songs you've imported
separated/<model>/<hash>/       cached stems (content-hash keyed)
output/<song>/                  exported mixes + a copy of every stem
output/<song>/recordings/       takes (video + audio-only) and saved riffs
GuitarStudio/models/nam/        .nam amp captures (subfolders OK)
GuitarStudio/models/ir/         cabinet impulse responses (subfolders OK)
GuitarStudio/projects/          autosaved per-song mix state
```
