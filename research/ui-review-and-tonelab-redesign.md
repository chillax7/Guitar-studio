# UI Review (pre-v5) + Tone Lab Icon-Chain Redesign

**Status:** written at the user's request, alongside custom-stems-spec.md,
as a UI/usability pass ahead of v5. §1 is commentary on the Mixer as it
stands (no changes proposed — it reads as sound, just genuinely busy).
§2–§4 are a full redesign proposal for Tone Lab, which the user
specifically flagged as "amazing feature set, looks messy." Framed as its
own milestone candidate for release-v5-spec.md — big enough to deserve
scoping, not something to bolt on mid-sprint.

---

## 1. Mixer — commentary

Asked for: consistency, redundancy, ease of use. Verdict: **sound, no
changes recommended** — the busyness here is *appropriate* density, not
clutter, for the reasons below. Flagging a couple of small things anyway
since they were asked for by name.

**Consistency — good.** Every stem lane follows exactly one template
(name → M/S → fader → pan → EQ disclosure → waveform → mute-paint lane),
so once you've learned one lane you've learned all of them regardless of
how many stems a track has (2 from a simple import, 9 from a rich
multi-stem pack). The transport/toolbar split (playback essentials in
the transport row, timeline tools like Loop/Zoom/Click in the toolbar
above) is a real, deliberate distinction that holds up — nothing's
misfiled between the two.

**Redundancy — none found that's worth removing.** The one thing that
*looks* redundant at first glance — BPM appearing in both the transport
and (implicitly) driving the beat grid/Click — is actually one piece of
state read in two places, not two competing controls. Nothing else
duplicates.

**Ease of use — the 150px lane-header column is doing a lot of work.**
Name, Mute, Solo, fader, fader %, Pan, Pan label, and an EQ toggle all
live in a fixed 150px-wide sticky column (`GuitarStudio/static/styles.css`
`.lane-header`) so it stays pinned while the waveform scrolls under it
during continuous zoom. That's the single busiest piece of real estate
in the app, and it's *intentionally* dense — every control there is one
you actually reach for per-song, not a rarely-used option buried for
completeness. The EQ-behind-a-disclosure-toggle pattern (§ BT-11) is
exactly right: the 3-band EQ is a set-once-per-song tweak, so it earns
its collapsed-by-default treatment while Pan (touched more often) stays
one click away, always visible. **This is worth keeping as the reference
pattern** when custom-stems-spec.md's new stems land in the same lanes —
they get the exact same header, no new design needed there.

**One real observation, not a problem:** this lane-header density is
precisely *why* Tone Lab's mess reads so differently below — the Mixer
solved "many controls, limited width" by disclosure (EQ folds away) and
strict per-row consistency (every lane looks the same, so density
doesn't read as chaos). Tone Lab's 15 pedal cards don't have either of
those — no disclosure that actually hides anything by default, and
wildly different control *counts* per card (Octaver has one slider,
Graphic EQ has five) with no visual hierarchy distinguishing "the pedal
you're actively tweaking" from "the other fourteen sitting there fully
expanded." That's the actual redesign target below.

## 2. Tone Lab — what's making it feel messy (not a value judgment on the features)

Feature set: genuinely excellent and matches or beats dedicated amp-sim
products — 15 cards (Gate, Amp with 3 modes, Cab IR, EQ, Compressor,
Delay/Reverb, Wah, Octaver, Boost, Graphic EQ, Chorus, Phaser, Flanger,
Tremolo, Output), drag-reordered among the 12 in the middle, a
signal-flow SVG overlay drawing arrows between cards since the 3-column
masonry layout (`#pa-pedalboard { columns: 3 260px; }`) scrambles their
visual position relative to actual chain order. Three concrete sources
of the "messy" feeling, distinct from "too many features":

1. **Everything is always fully expanded, all at once.** 15 cards,
   averaging 3–4 controls each, all visible simultaneously with no
   visual distinction between "the pedal I'm tuning right now" and "the
   other 14." A collapse button exists per-card, but nothing collapses
   by default and nothing highlights what's *active* attention versus
   ambient — the opposite of the Mixer's disclosure discipline (§1).
2. **Masonry position ≠ signal order**, so an SVG arrow overlay has to
   exist purely to compensate — a whole rendering subsystem
   (`paRedrawSignalFlow`, recomputed from live `getBoundingClientRect()`
   calls) whose entire job is undoing confusion the layout itself
   introduces. That's a real signal something upstream is fighting the
   layout rather than being served by it.
3. **The drag handle is a small `⠿` glyph on a large card** — reordering
   means finding and precisely grabbing a tiny target at the top of a
   card that might be most of a screen tall, then dragging it across a
   masonry layout whose column-flow reordering behavior (fixed last
   session, when the drag math moved from horizontal to vertical
   comparison) is already the least intuitive part of the current UI.

## 3. Proposed redesign: a linear icon chain, click-to-reveal below

Exactly the shape the user described, so this section is mostly
specifying the details rather than pitching the idea:

**The icon row.** One small icon chip per rig element, laid out
left-to-right in actual signal-chain order — Gate, Amp, then the 12
reorderable pedals, then Output — using `flex-wrap: wrap` so a row that
doesn't fit the available width wraps to a second/third row rather than
scrolling or shrinking illegibly. This single change **eliminates the
SVG signal-flow overlay entirely** (item 2 above) — the row's left-to-
right order *is* the signal flow, with no separate visualization needed
to explain it. One whole rendering subsystem removed, not just hidden.

**Each icon chip shows, at a glance, without being clicked:**
- A small glyph identifying the pedal type (see §4 for the icon set).
- A short label (abbreviated where needed — "Comp," "Rvb/Dly," "O'drive").
- **Bypass state as the icon's own visual weight** — lit/accent-colored
  when active, dimmed/greyed when bypassed — reusing this app's existing
  "blue = on" convention (`button.active`, established during the v3
  hardware-testing pass) rather than inventing a new color language.
  This is the direct fix for item 1: scanning the row tells you what's
  actually engaged right now without opening anything.
- Gate/Amp/Output keep a subtle visual distinction (e.g. a slightly
  different chip background or a thin divider before/after them) marking
  them as fixed-position anchors, same distinction the current cards
  already carry via not being `.pa-pedal-draggable`.

**Clicking an icon** opens that pedal's full control set in a single
panel directly below the icon row — exactly the existing card content
(bypass checkbox, sliders, hint text), just shown one at a time instead
of all fifteen simultaneously. Clicking a different icon swaps the panel
contents; clicking the same icon again (or a small ✕ on the panel)
closes it back to just the icon row. This is a strict content
*reduction* at any given moment — same total information, but only the
thing you're actively tweaking is ever fully on screen, which is the
real fix for "messy": not fewer features, less simultaneous visual
surface.

**Dragging an icon** left/right within the row reorders the chain —
same underlying mechanism as today (`PA.pedalOrder`, `rewirePedalChain`),
just a far easier target (a whole icon chip vs. a tiny handle on a tall
card) and, notably, a **third variant of the before/after drag-position
math** this codebase has now needed: horizontal-row comparison
(`clientX` vs. chip midpoint), different again from the vertical
column-flow comparison the masonry layout needed last session, and the
original horizontal comparison from before that. Worth a code comment
flagging this the same way the earlier fix did, since a future layout
change will need this looked at a fourth time otherwise.

## 4. One open design question — worth confirming before building

**What does a single click on an icon actually do, if the pedal is
currently bypassed?** Two reasonable models, and they're genuinely
different interactions, not a detail to silently pick:

- **(A) Click always opens the panel; bypass toggles from inside it**
  (the checkbox that's already the first row of every card today).
  Recommended: it's the literal behavior described ("clicking an icon
  reveals the controls relevant to it"), it needs zero new interaction
  vocabulary, and it avoids a real risk — a small icon chip is a poor
  target for *two* different gestures (a quick click to bypass, a
  different click/hold to open) sitting that close to the *drag* gesture
  reordering already needs on the same small chip. Keeping "click"
  meaning exactly one thing avoids that collision entirely.
- **(B) Click toggles bypass directly** (footswitch-style — tap a pedal
  icon on and off without opening anything), with a *different* gesture
  (double-click, or a small dedicated corner hit-target) opening the
  panel. Closer to how a real pedalboard/footswitch physically works,
  but costs a second interaction vocabulary on a small target, and
  starts to overlap with what a future foot-pedal/MIDI mapping (GP-11,
  already on the v5 backlog per post-v4-backlog-audit.md) would
  naturally want to control instead — arguably bypass-by-footswitch
  should be GP-11's job once it exists, not something the mouse UI needs
  to also optimize for.

**Recommendation: (A).** Simpler, safer against the drag-target
collision, and leaves footswitch-style instant bypass as squarely GP-11's
territory rather than pre-building a mouse-only version of it now.

## 5. Icon glyph set

Simple, single-color, consistent-weight glyphs (matching the existing
`app-icon.svg`'s hand-drawn style rather than reaching for an emoji set,
which reads inconsistently across platforms and would clash with the
app's one piece of custom artwork) — one per pedal type:

Gate (a simple gate/gap shape), Amp (a small amp-cab silhouette,
shared across Clean/Analog/Neural — the mode is a label under the icon,
not three separate icons), Cab IR (a speaker cone), EQ (a small
slider-row glyph), Compressor (a compressed-waveform glyph), Delay/Reverb
(concentric arcs), Wah (a wedge/pedal-treadle shape), Octaver (stacked
"8ve" glyph or an octave-interval symbol), Boost/Overdrive (a chevron/
arrow-up), Graphic EQ (a multi-slider bar row, distinct from the 3-band
EQ's single-slider glyph), Chorus/Phaser/Flanger (each a distinct
sine-wave variant — this trio genuinely needs to be visually
distinguishable at a glance since they're conceptually similar
modulation effects), Tremolo (a pulsing-amplitude glyph), Output (a
simple meter/fader glyph). Twelve to design, reusable indefinitely as new
pedal types are added later — a one-time asset cost, not ongoing design
work.

## 6. Effort and fit

Genuinely the "big change, big upgrade" the user called it — this
touches `index.html`'s entire Tone Lab body (restructuring 15 sections
into an icon strip + one shared panel container), a meaningful chunk of
new CSS (the icon chips, the shared panel, the wrap behavior), and
`playalong.js`'s card-collapse/drag-reorder logic (adapting from
per-card collapse state to single-panel-open state, and from the
vertical-masonry drag math to horizontal-row drag math per §3). Existing
per-pedal logic (parameter wiring, bypass, rig-preset capture/apply,
`PA.pedalOrder`) is unchanged underneath — this is a presentation-layer
rebuild, not a rig-engine rewrite, which keeps the risk contained to "did
the UI wire up correctly" rather than "did the audio graph change."

Suggested milestone fit: its own line item in release-v5-spec.md — sized
similarly to §9's other M-tier picks (V5-B3, the MIDI+preset-cycling
pairing), not squeezed into an existing milestone. Natural sequencing
note: this redesign and the preset-list/cycle feature
(rig-preset-chain-spec.md) both touch the same Tone Lab presets card and
icon row, so scheduling them in the same milestone (or immediately
adjacent ones) avoids touching the same files twice.
