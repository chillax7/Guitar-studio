# Orpheus Guitar Studio — ground-up redesign brief for Claude Design

**Purpose of this document:** brief a design-focused Claude session on
everything it needs to propose a from-scratch visual/UX redesign of this
app, without needing to read the codebase. It has three parts:

1. **What the app is and does** — the product, its core loop, and a full
   functional inventory (screen by screen, control by control).
2. **Design research already done** — a competitor scan and an honest
   read on the app's current visual identity, from an earlier UI/UX
   review pass.
3. **A ready-to-send prompt** for Claude Design itself (§3), which
   restates the brief in a form meant to be handed over directly.

This is an exploration, not a committed rebuild — nothing here is a
request to ship what comes back. The goal is to see other ways the app
*could* look, informed by what it actually needs to do.

---

## 1. What Orpheus Guitar Studio is

A local-first, browser-based practice tool for guitarists learning songs
by ear. Everything — audio separation, amp/effects modeling, recording,
AI features — runs from a small Python server on the user's own machine;
no cloud processing, no subscription, no account. The whole thing is
vanilla HTML/CSS/JS (no framework, no build step) talking to a Python
backend over a local HTTP API.

**The core loop it's built around:**

> Import or rip a song → separate it into stems (drums/bass/vocals/
> guitar/etc.) → build a custom backing mix (mute the original guitar,
> adjust levels) → play along through a real modeled amp rig (NAM
> captures + pedals) → record a take → get it scored or get AI feedback →
> practice the weak spots → repeat.

No single competitor combines all of these steps (see §2's competitive
table) — that combination, done fully locally and for free, is the
product's actual identity. A redesign should read as *one coherent
instrument for that whole loop*, not five unrelated tools bolted
together.

**Five main screens**, opened as full-screen overlays over a persistent
sidebar (song library):

- **🎚 Mixer** — the song: stems, levels, mutes, loop region, key/pitch
  correction, export.
- **🎛 Tone Lab** — the sound: guitar input, amp modeling (NAM), pedal
  chain, cab IR, rig presets.
- **🎸 Play Along** — performing: tuner, live rig, looper, riff capture,
  recording, takes.
- **🧠 AI Lab** — feedback and theory: scale suggestions, take scoring, an
  LLM-backed assistant (practice tips, lick ideas, song/artist info, song
  structure, Q&A).
- **🎼 Tab View** — Guitar Pro file playback and notation, independent of
  the main song library.

A **shared transport bar** (Play/Stop/Loop/Count-in/BPM/Speed/Tune/
Volume) is mirrored identically across Mixer, Play Along, Tone Lab, and
AI Lab — one underlying playback state, not five separate players. This
is one of the app's best existing ideas and should survive any redesign
in spirit even if its visual treatment changes completely.

The app also has **five existing visual themes** (Studio — the original
plain dark theme; Molten Obsidian; Bright Spark — light mode; Future
Metal; Castle Rock), user-selectable and persisted, all built on CSS
custom properties. A redesign doesn't need to preserve these specific
themes, but should assume theming (at minimum a light/dark pair) is a
real requirement, not an afterthought.

### What NOT to break

From direct usage and a prior UI review pass, these are working well and
any redesign should treat them as constraints to design *around*, not
problems to solve:

- The four/five-screen mental model (song / sound / performing /
  feedback / tabs) matches how guitarists actually think about practice
  sessions.
- The shared-transport idiom (one playback state, mirrored everywhere).
- Honest, specific empty/disabled states — the app almost never shows a
  dead control without explaining why inline (e.g., a disabled button
  says exactly what it needs first). This is part of the app's character.
- Mixer's per-stem lane density — a lot of control packed into a small,
  scannable row, with secondary controls (EQ) behind a disclosure rather
  than always expanded.
- Tone Lab's pedal-chain-as-icon-row — chips laid out in actual signal
  order, click to expand one at a time, drag to reorder. This replaced an
  earlier design with 15 permanently-expanded cards and was a real
  improvement; whatever replaces it should keep "see the whole chain at a
  glance, edit one thing at a time."

---

## 2. Design research already done

### 2.1 Current visual identity, honestly assessed

The app currently reads as a **competent flat dark utility** — one accent
color (blue) used for every interactive element regardless of importance,
which means primary actions, toggles, navigation, and destructive actions
all carry identical visual weight. Nothing about the base look says
"guitar," "rock," or anything distinctive — the app is named Orpheus
(the mythical musician who charmed his way through the underworld with
his playing) but that identity isn't expressed visually beyond a lyre
logo. An internal proposal ("Molten Obsidian" — obsidian-black palette,
molten-ember accent, a reserved second accent color for AI/analysis
features specifically) shipped as one of the five themes, but a ground-up
redesign is free to take the brand identity in a completely different
direction — fantasy/mythical is the app's own premise, not a mandate.

### 2.2 Competitor scan (interface language specifically, mid-2026)

- **Moises** — the UX benchmark in this space (App Store "App of the
  Year," Apple Design Award finalist). An uncluttered, waveform-centric
  player with progressive disclosure of its AI features — the lesson is
  *AI handles complexity, the interface stays calm*. It hides more than
  Orpheus does (Orpheus has more power-user density), but wins hard on
  first-session experience: a new user is playing along within a minute,
  guided the whole way.
- **Neural DSP (plugins + the Quad Cortex hardware)** — the "serious
  guitar gear" tone benchmark: dark, premium interfaces. Notably, even
  in that world the trend has moved *away* from literal photoreal
  skeuomorphic knobs toward stylized dark-metal minimalism — reviewers
  praise the hardware's plain black/silver restraint over busy on-screen
  graphics. Chasing photorealism is a losing, expensive art-asset race;
  stylized dark-and-glow reads as "serious gear" far more cheaply.
- **Positive Grid Spark** — the guided-practice benchmark: the app
  teaches itself through a sequence of small guided wins rather than a
  manual or wall of text.
- **Yousician / Guitar Tricks** — gamified curriculum apps; different
  product category, but their streak/progress mechanics are a reminder
  that completing a goal deserves visual celebration, not a gray
  checkbox.
- **Ultimate Guitar / Songsterr** — content-first and utilitarian; their
  dark modes are functional but characterless. This is the trap to avoid
  — Orpheus's current base theme sits closer to this end of the spectrum
  than to Moises or Neural DSP.

**Net read:** the field splits into "calm minimal practice apps" and
"dark premium gear-sim apps." Orpheus is genuinely both products in one
(a practice tool AND a gear simulator), and nothing else combines them.
The interface should make that combination feel deliberate rather than
like two different apps sharing a sidebar.

### 2.3 Competitive positioning (functional, for context — not a UI note)

No single competitor covers the same combination of capabilities Orpheus
does. For context on what the app is actually competing against:

| Capability | Orpheus | Moises | Chordify/UG/Songsterr | Anytune/deCoda | NAM ecosystem (Tone3000, Gateway) | AmpliTube/Neural DSP |
|---|---|---|---|---|---|---|
| Stem separation | local | cloud, tiered | no | no | no | no |
| Mixer, per-stem EQ/pan, export | yes | partial | no | no | no | no |
| Speed/pitch practice tools | yes | yes | partial | yes (its whole job) | no | no |
| Chord detection | local | yes | yes (Chordify's whole job) | partial | no | no |
| Live amp rig (NAM + IR + pedals) | in-browser | no | no | no | yes (its whole job) | yes (native, paid) |
| Recording / takes / compare | yes | no | no | no | no | partial |
| Practice log / playlists | yes | partial | partial | no | no | no |
| System-audio rip | yes | no | no | no | no | no |
| Fully local / private / free | yes | no (subscription) | no (subscription) | mostly | yes | no (license) |
| Mobile / tablet | no | yes (its biggest edge) | yes | yes | partial | partial |
| Tab / notation | yes (Tab View) | no | yes (UG/Songsterr's whole job) | partial | no | no |
| Community content library | no (local files only) | no | yes (tabs) | no | yes (6500+ NAM models) | yes (presets) |

Orpheus's honest weak spot is **mobile/tablet** — every real competitor
in the "calm practice app" category has it, Orpheus doesn't (it's a
desktop-browser, local-server architecture). A redesign doesn't need to
solve that architecturally, but it's worth knowing the interface doesn't
currently need to worry about small-screen/touch layouts to be
competitive — that could change if the constraint changes, so ask rather
than assume if this matters to the brief.

---

## 3. Full control inventory (Appendix A, current app)

Every button, slider, dropdown, and checkbox that exists today, grouped
by where it lives. This is the ground truth for "what needs a place to
live" in any redesign — nothing here should disappear, though how it's
grouped, labeled, or surfaced is entirely open to rethinking.

### Global (visible on every screen)

- **🎚 Mixer / 🎛 Tone Lab / 🎸 Play Along / 🧠 AI Lab / 🎼 Tab View** —
  the five main screens. Mixer is the base view; the other four open as
  full-screen overlays on top of it.
- **❓ Help** — opens the onboarding/help modal (also shown automatically
  on first launch).
- **Rig silent / Rig live pill** (top right) — glances at whether the
  guitar input is enabled and receiving signal. Grey when silent, the
  theme's "live" color when signal is present; click it to jump straight
  to Tone Lab's Input card.
- **Theme toggle** (top right) — cycles through the app's visual themes.
  Purely cosmetic, persisted across sessions.
- **Library / ALL TRACKS list** — every imported song. Click a row to
  load it into the workspace; the currently-loaded song gets a
  highlighted row.
- **+ (on a track row)** — adds that track to one or more playlists (a
  track can belong to any number).
- **✎ (on a track row)** — renames that track's underlying audio file.
- **✕ (on a track row)** — deletes the track: its audio file, separated
  stems, exports, and recordings. Cannot be undone.
- **Drop a song here / click to import** — imports a new song, either a
  single audio file or a stem-pack .zip (the file extension decides
  which).
- **Rip system audio…** (collapsible) — captures whatever audio is
  currently playing on the computer (e.g. a streaming tab) via a virtual
  audio device, saving it as a new imported song.
  - **Device dropdown** — picks which system-audio capture device to
    record from.
  - **● Start Rip / ■ Stop Rip** — starts/stops the system-audio capture.
- **Sidebar resize handle** — drag to widen/narrow the Library sidebar;
  double-click resets it to the default width.
- **Inspector collapse arrow** — collapses/expands the right-hand panel
  (Track info/Speed Trainer/Export) to free up width for the stem lanes.

### Shared transport bar (Mixer, Play Along, Tone Lab, AI Lab's Rate My Take, Tab View's song bar)

The same bar, same controls, in the same position on all five copies —
one underlying playback state, not five separate players.

- **▶ Play / ■ Stop** — starts/stops playback of the current mix.
- **Timeline scrubber** — drag to jump to any point in the song.
- **Loop** — toggles looping of the current loop region (set on the
  Mixer's ruler).
- **Count-in** — plays 2 bars of metronome click before playback
  actually starts.
- **BPM readout** — the detected tempo (not directly editable here).
- **½× / 2×** (Mixer only) — halves or doubles the displayed BPM, for
  when detection reads the tempo at double or half the real speed.
- **Speed slider** — plays the song faster or slower (0.5×–2×) without
  changing pitch.
- **Tune slider** — pitch-shifts the whole mix up or down, in cents.
- **Volume slider** — overall playback level of the backing mix.

### Mixer screen

Toolbar (Mixer-specific, above the stem lanes):

- **+ Marker** — drops a named marker at the current playhead position.
- **Zoom to loop / Zoom out** — zooms the waveform/ruler to fill the view
  with just the current loop region, or back out to the whole track.
- **Zoom slider** — continuously widens or narrows the visible timeline.
- **Click** — toggles a metronome click synced to the song's beat grid.
- **Click volume slider** — how loud the metronome click plays.
- **Model badge / dropdown** — picks which separation model/algorithm to
  use (each produces a different set of stems).
- **Separate / Re-separate** — runs (or re-runs) stem separation on the
  current song.
- **Dismiss** (stale-stems banner) — hides the "source file changed"
  warning without re-separating.
- **Retry** (stems-load error) — retries fetching stems after a network
  hiccup.

Per-stem lane (one row per instrument):

- **✎ / ✕ (lane)** — renames a stem's display name, or removes it from
  the mix entirely.
- **🎸 (imported stem packs only)** — marks a non-standard stem as "the
  guitar" for tone-matching and scoring purposes.
- **M / S** — mute / solo that stem.
- **Gain slider** (double-click resets to 100%) / **Pan slider**
  (double-click resets to center).
- **EQ** (toggle) — reveals a 3-band (Bass/Mid/Treble) EQ for that stem.
- **Mute-lane** — click-and-drag to mute a specific time range of just
  that stem.
- **Loop handles** (on the ruler) — drag to set the loop region.

Right-hand inspector panel:

- **Apply to Tune** — nudges the Tune slider to correct detected
  off-pitch tuning.
- **Root / Mode dropdowns + Set / Reset** — manually corrects (or
  reverts) the detected key.
- **Speed Trainer: Start / Step / Target % + Start at Start% / Step up**
  — configures and drives a practice speed ramp.
- **Spectral / Mid-side / Hybrid + Run split** (Guitar split) — three
  algorithms for splitting a combined guitar stem into lead/rhythm.
- **Export format / Output name / Target LUFS / Normalize loudness / Max
  boost cap (dB) / Export** — bounces the current mix to a file, with
  loudness normalization controls.

### Play Along screen

- **Guitar Tuner gauge + 🎤 (mic button)** — live pitch/note detection;
  muting the backing track and amp tone while active.
- **Rig Preset dropdown** (quick-pick) — instantly switches the whole
  amp/pedal rig without leaving this screen.
- **● Record / Stop / Undo / Clear** (Looper) — records, stops, undoes
  the last overdub layer of, or clears a real-time loop of your playing.
- **🎸 Save that!** (Riff Capture) — saves the last ~20 seconds of
  playing, always rolling in the background once the rig is live.
- **● Record** (Record performance) — records a full performance take
  (rig output + optional backing track + optional camera).
- **Go to Rate My Take →** — jumps to AI Lab's scoring flow instead.
- **Start backing track with recording / Start with count-in** —
  recording-start behavior toggles.
- **Practice mode: auto-retake each loop pass** — with a loop region
  active, saves each pass as its own take automatically.
- **Show framing guides / Camera dropdown + Enable camera / Quality
  dropdown / A/V offset (ms) + Auto-calibrate** — video-take setup and
  sync controls.
- **Takes list** — every recorded take; check two boxes to compare.
- **Trim start / Trim end sliders + Trim** — losslessly cuts a take to a
  range, saved as a new file.
- **▶ Play both / Pause / ■ Stop, Listening: A/B, Compare seek slider**
  (Compare takes) — plays two selected takes in sync, switchable audible
  channel.
- **Exported Tracks list + player** — plays back a previously exported
  mixdown from this screen.

### Tone Lab screen (amp/pedal rig)

- **Input meter + Clear (clip indicator)** — live input level, with a
  manually-resettable clipping warning.
- **Device dropdown + Enable input** — picks and enables the guitar
  input device.
- **Calibrate** — sets input gain from your loudest chord.
- **Measure round-trip latency** — measures real hardware latency via a
  physical loopback cable.
- **Rig Preset dropdown + Load / Delete** — recalls or removes a saved
  full rig configuration.
- **New preset name + Save current rig as…** — saves the current chain
  as a new named preset.
- **This song's chain (list) + Add to this song's chain** — an ordered
  list of presets attached to the current song, for mid-song switching.
- **Cycle forward/backward (keyboard) — Change… / (MIDI) — Learn…** —
  binds a keyboard key or MIDI footswitch message to advance/reverse
  that per-song preset chain.
- **Pedal-chain icon row** — one icon per stage, in actual signal order;
  click to open its controls, drag to reorder.
- **Bypass** (every pedal) — turns that effect on/off without removing
  it from the chain.
- **Noise Gate — Threshold.**
- **Amp — Pass Through / Analog / Neural (NAM)** mode picker, with
  **Analog — Drive/Bass/Mid/Treble** and **Neural — Drive/Bass/Mid/
  Treble/Presence/Output level** controls per mode.
- **Suggest from this track's guitar stem** — recommends a NAM capture
  matching the song's tone.
- **NAM drop zone / choose files/folder, NAM search/browser** — imports
  and selects captured amp profiles.
- **Cab IR — bypass, drop zone, search/browser + IR tone shape (Low
  cut/High cut).**
- **EQ — Bass/Mid/Treble** (general, post-amp).
- **Compressor — Threshold/Ratio.**
- **Delay — Time/Feedback/Mix. Reverb — Size/Mix.**
- **Auto-Wah — Rate/Depth/Center freq/Mix.**
- **Octaver — Blend** (monophonic octave-down).
- **Boost/Overdrive — Drive/Level.**
- **Graphic EQ — 5 bands (100Hz–8kHz).**
- **Chorus/Phaser/Flanger/Tremolo — Rate/Depth/(Feedback)/Mix.**
- **Output — Level, meter, device dropdown.**

### AI Lab screen

Three tabs: **Scales**, **Rate My Take**, and **AI Assistant** (which has
six internal modes).

Scales tab:
- **Chord ribbon** — click a chip to jump the scale suggestion to that
  chord.
- **Per chord / Whole song** toggle, **Follow song** (re-enables
  auto-tracking the playhead's chord).

Rate My Take tab:
- **↓ Use current position as Offset.**
- **Dry takes list + ● Record dry take / ■ Stop** — guitar-only takes
  recorded specifically for scoring.
- **Go to Play Along →** — the reverse cross-link to a normal
  performance recording.
- **Take dropdown, Offset (seconds), Offset search (+/- seconds).**
- **Score this take** — compares against the original guitar stem's
  timing/pitch, producing a score and heatmap.

AI Assistant tab (the only feature making network calls):
- **Provider dropdown + API key field + Save key** — picks an LLM
  provider (Claude/Google Gemini/Groq) and stores its key locally.
- **Artist / Title fields** — the song's identity, needed by several
  modes below; auto-guessed from an "Artist - Title" filename convention
  and auto-saved once both are filled in.
- **Practice Tips / Lick Ideas / This Track / Song Structure / This
  Artist / Ask AI** — mode switcher.
- **Style/genre field + Get phrasing ideas** (Lick Ideas).
- **Example question chips, Question field + Ask** (Ask AI) —
  free-form Q&A, off-topic questions politely declined.
- **Get track info** (This Track) — release info, writing process,
  notable performances.
- **See Song Structure for the part-by-part playing map →** cross-link.
- **✨ Name the parts with AI + Song Structure part list** — labels
  detected sections with real names/role/technique/difficulty; click a
  part to jump or loop it.
- **Get artist info** (This Artist) — guitarist background, gear, style,
  hints toward a matching NAM capture.
- **Take dropdown + Offset/Offset search** (Practice Tips) + **Get
  practice tips** — exercises targeted at a specific take's actual
  weakest moments.

### Tab View screen

- **Drop a Guitar Pro file here / click to import** — imports a
  .gp3/.gp4/.gp5/.gpx file.
- **Tab library list** — separate from the main song Library, same
  rename/delete/playlist controls.
- **Track Play Bar** (shared bar) — the backing track's own playback,
  independent of the tab.
- **▶ Play / ■ Stop, Loop, Speed slider** (Tab Play Bar) — plays
  alphaTab's own synth rendition of the tab (a bundled soundfont, not the
  Tone Lab rig).
- **Zoom −/+** — re-lays the notation out at a smaller/larger scale.
- **Drag across the notation** — selects a bar range (highlighted); with
  Loop on, playback repeats just that range. **Clear selection** removes
  it.

### Modals

- **Keyboard shortcuts** (press `?`) — reference card for every shortcut.
- **Help / Welcome** — onboarding walkthrough.
- **View Quest Log** — a checklist of app features to try, auto-checked
  off as they're used.
- **Text prompt (Cancel/OK)** — the app's own non-blocking rename/
  name-entry dialog.

---

## 4. Constraints for the redesign

- **Nothing in §3 disappears.** Every listed control needs a home
  somewhere in the redesign, even if grouped, labeled, or surfaced
  completely differently than today.
- **No account, no cloud.** The product's identity is "runs entirely on
  your machine" — nothing in the redesign should imply a login, a cloud
  sync indicator, or a subscription paywall.
- **Theming is real, not decorative.** Assume at least a light and dark
  variant are both required, and design tokens/system should make that
  cheap, not an afterthought bolted on later.
- **No art-asset arms race.** Per §2.2's Neural DSP note, avoid
  photorealistic/skeuomorphic knobs and pedals — that's an expensive,
  never-finished path for a small team. Stylized, systemic design
  (consistent shapes, colors-as-meaning, glow-as-state) is preferred over
  literal hardware photography.
- **Everything is keyboard- and mouse-driven on a desktop browser
  window** — no touch-target sizing constraints, no mobile breakpoints
  required (see §2.3's honest note on mobile being explicitly out of
  scope today).

---

## 5. Prompt for Claude Design

Copy everything below this line as the message to Claude Design.

---

I want a from-the-ground-up visual and UX redesign exploration for
**Orpheus Guitar Studio**, a local-first desktop-browser app for
guitarists practicing songs by ear. This is exploratory — I want to see
genuinely different directions for how this app could look and feel, not
incremental tweaks to what exists. Nothing you produce is being shipped
directly; treat this as a design study I'll react to and pick ideas from.

**What the app does:** it's built around one core loop — import or rip a
song, separate it into instrument stems, build a custom backing mix
(mute the original guitar, adjust levels), play along through a real
modeled amp/pedal rig, record a take, get it scored or get AI feedback,
and practice the weak spots. No other product on the market combines all
of these steps; the interface should feel like *one coherent instrument*
for that whole loop, not a bundle of separate tools.

**The five screens today** (a structure you're free to challenge, not
just re-skin): Mixer (the song — stems, mixing, export), Tone Lab (the
sound — amp modeling, pedals, rig presets), Play Along (performing —
tuner, looper, recording), AI Lab (feedback — scoring, LLM assistant,
scale suggestions), and Tab View (Guitar Pro notation playback). A shared
transport bar (play/stop/speed/tune/volume) is mirrored across four of
the five screens as one continuous piece of state — I'd like this idea
(the song never "belongs" to just one screen) preserved in spirit even if
its look changes completely.

**Full control inventory:** every existing button, slider, and dropdown
is listed in the attached brief's §3, organized by screen. Please treat
this as the complete functional surface — nothing in it should be lost,
though regrouping, relabeling, progressive disclosure, or completely
different information architecture are all fair game.

**Design research already done** (§2 of the attached brief) found: the
current look is a flat, single-accent-color dark theme with no visual
hierarchy and no real brand identity beyond a lyre logo (the app is named
after Orpheus, the mythical musician). A competitor scan places the field
into two camps — calm, minimal practice apps (Moises) and dark, premium
gear-simulator apps (Neural DSP/Quad Cortex) — and Orpheus is genuinely
both in one app, which nothing else on the market attempts. Reviewers
consistently prefer restrained, stylized dark interfaces over literal
photorealistic hardware skeuomorphism even in the gear-sim category, so
please avoid that path — it's also an expensive art-asset commitment a
small team can't sustain.

**What I want back:**

1. Two or three genuinely distinct visual/brand directions (not
   variations on one palette) — each with a point of view on what this
   app's identity should be, referencing or departing from the Orpheus
   myth as you see fit.
2. For your strongest direction, a more complete pass showing at minimum:
   the Mixer screen with a song loaded and stems visible, the Tone Lab
   pedal-chain view, and the global navigation/shell (sidebar, top bar,
   theme handling).
3. Explicit reasoning for any information-architecture changes — if you
   move a capability, merge two screens, or restructure how the sidebar
   works, say why.
4. Call out anything in the current control inventory (§3) you think
   should be deprioritized, hidden by default, or handled completely
   differently — I want your honest opinion on the density, not just a
   reskin of everything at equal visual weight.

**Hard constraints:** no login/cloud/subscription implication anywhere
(this is a local-only tool and that's core to its identity); both a light
and a dark treatment need to be planned for from the start, not
retrofitted; this is a desktop-browser-window app, not a mobile layout
exercise.

I'll attach the full brief (including the complete control inventory and
competitor research) alongside this message.
