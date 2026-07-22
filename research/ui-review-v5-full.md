# Full UI/UX Review — v5 (near-feature-complete checkpoint)

**Status:** requested at the v5 near-feature-complete point ("we have a ton
of features... can you do a thorough review of the UI"). Scope: look and
feel, ease of navigation, capability grouping (is Enable Input in the
right screen?), new-user onboarding, an updated first-use checklist, a
competitor scan, and themed mockups. This is a **review + proposal
document** — nothing here is committed work until it's picked into a
milestone. Companion to the earlier, narrower
[ui-review-and-tonelab-redesign.md](ui-review-and-tonelab-redesign.md)
(whose §3 icon-chain redesign shipped in v4.7) and to
[market-review-2026.md](market-review-2026.md) (functional positioning —
this doc covers the *UI* side of the same competitive frame).

**Method:** every screen was actually rendered and screenshotted from the
running app (headless Chromium, 1440×900, cold start — no tracks, no
input device) rather than reviewed from the markup alone. That cold-start
choice was deliberate: it's exactly what a new user sees, and several of
the findings below only show up in that state.

**Mockups:** [mockups/](mockups/) — three self-contained HTML files, open
directly in a browser. See §7.

---

## 1. What's already good (worth protecting through any redesign)

- **The four-screen mental model is right.** Mixer (the song) / Tone Lab
  (your sound) / Play Along (performing) / AI Lab (feedback & theory) is
  a clean, learnable division that matches a guitarist's actual workflow
  phases. None of the recommendations below change it.
- **The shared-transport idiom is a quiet triumph.** The same
  Play/Stop/Speed/Tune/Volume state mirrored across Mixer, Play Along,
  and AI Lab (`data-transport`) means the song never "belongs" to one
  screen — nothing gets out of sync, and users never hunt for "where do
  I pause it from here."
- **Mixer lane discipline** (one template per stem, EQ behind a
  disclosure) still holds up exactly as the previous review found.
- **Tone Lab's icon chain** (v4.7) fixed the worst pre-v5 problem — 15
  fully-expanded cards — and the "row order = signal order" idea is
  genuinely better than most plugin UIs' approach to the same problem.
- **Honest empty states and hint copy everywhere.** The app almost never
  shows a dead control without saying why (Practice Tips' disabled
  button explains itself; the tuner says "enable input"; separation
  progress warns about the 99% trap). This is rarer than it should be in
  commercial tools and is part of the app's character — keep it.

## 2. Screen-by-screen findings

### 2.1 First run (the help overlay) — **stale content, real bug**

The Welcome overlay's five steps still describe the pre-v4.7 app:

- Step 4 says to shape the tone in **Play Along** and to "drag the ⠿
  handles" — both wrong since v4.7: the rig lives in **Tone Lab**, and
  the ⠿ drag handles were replaced by the icon chain. A new user
  following the instructions literally will fail at step 4.
- **AI Lab does not appear at all** — the entire v5 flagship (Scales,
  Rate My Take, AI Assistant) is invisible to a first-run user.
- Stem-pack zip import and Rip system audio (both real import paths,
  both sitting right there in the sidebar) aren't mentioned either.

This is the single cheapest high-impact fix in this document, and the
text fix ships alongside this review (see §8 "shipped now"). The bigger
first-use *ticklist* redesign is §4.

### 2.2 Cold start — the inspector lies about what's possible

With no track loaded, the right inspector shows a fully-interactive
**Speed Trainer** (Start/Step/Target, two live buttons) and a complete
**Export** form — every control operable, none meaningful. The "TRACK"
header sits empty above them. Meanwhile the actually-useful next action
(import a song) is a low-contrast dashed box at the bottom of the
sidebar, below the fold of attention.

**Recommendation:** the inspector's no-track state should become the
home of the first-use checklist (§4) — replacing dead controls with the
thing a new user actually needs. Once a track is selected, the checklist
yields to the normal Track/Speed Trainer/Export stack (collapsed back to
a small "Getting started" link once all steps are complete).

### 2.3 Sidebar — three small frictions

1. **Two separate drop zones** ("Drop an audio file" / "Drop a stem pack
   (.zip)") for what is conceptually one action: *get a song in*. The
   file extension already tells the app which path to take. Merge into
   one smart drop zone ("Drop audio or a stem-pack .zip") and the
   sidebar loses a whole box of chrome.
2. **Rip system audio is permanently expanded**, showing an empty device
   dropdown and a hint that reads like an error ("No input devices
   listed yet...") on every launch, forever, even for users who will
   never install BlackHole. Collapse it behind a disclosure (like the
   Mixer's EQ) that remembers its state — the feature keeps its
   discoverability without paying permanent screen rent.
3. **Nav buttons are all identical solid blue**, including Help — the
   active-screen highlight is a subtle border change that's easy to
   miss. The center-banner screen label compensates, but the nav itself
   should carry the state (see theme mockups — active screen gets the
   accent treatment, inactive ones go quiet).

### 2.4 Mixer — still sound

Nothing new to report beyond the previous review's verdict (appropriate
density, good disclosure discipline). The one addition: the toolbar's
Loop/Marker/Zoom/Click cluster and the transport row below it have grown
enough controls that the **flat blue-on-dark uniformity** is now the
limiting factor — every control has identical visual weight, so nothing
guides the eye. This is a theming problem (§6), not a layout problem.

### 2.5 Tone Lab — grouping is right, hierarchy is flat

- **Enable Input placement — reviewed as asked: it should stay in Tone
  Lab.** The reasoning: input setup (device pick, gain calibration) is
  rig configuration you do once per session/hardware change, and Tone
  Lab is where every other per-session rig decision lives. Moving it to
  Play Along would split "the rig" across two screens again — the exact
  thing the v3 reorganization fixed. **But** the real problem is
  discovery *from* Play Along: the tuner says "Enable input and play a
  single note" with no path to do it — a new user has to already know
  input lives in Tone Lab. The fix isn't moving the card; it's a
  **global rig status pill in the top banner** (visible on all four
  screens): shows input off/on + clip + latency at a glance, and
  clicking it jumps to Tone Lab's Input card. One element, solves the
  discovery problem everywhere at once, and gives the app the
  "hardware rack status LED" feel the theme wants anyway. Mocked up in
  all three mockups.
- The Input/Rig Presets cards sit above the icon chain at full width,
  pushing the chain (the screen's real subject) below them. Mockup 3
  compacts these into a slimmer top row so the chain leads.
- The icon chain's chips are functional but visually generic — the
  theme pass (§6) turns them into the screen's centerpiece.

### 2.6 Play Along — one real ambiguity

- The **two record buttons problem**: "● Record" here (performance
  take, backing track baked in, camera optional) vs "● Record dry take"
  in AI Lab's Rate My Take (guitar only, for scoring). The copy on each
  card explains the difference well — *if you read it*. A user who has
  found one screen's record button has no signal the other exists.
  **Recommendation:** a small cross-link chip on each card ("Recording
  to get a score? → Rate My Take" / "Want a watchable performance? →
  Play Along"), reusing the screen-jump mechanic the status pill
  introduces. Cheap, and it converts the split from a trap into a
  choice.
- **Exported Tracks** living at the bottom of Play Along is defensible
  (it's play-along material) but it's the only "library-ish" list not
  in the Library. Low stakes; leave unless the sidebar ever grows a
  "finished mixes" group.
- The top strip's four cards (Backing Track / Tuner / Rig Preset / Riff
  Capture) are the right four things. With the status pill in the
  banner, the Tuner card could also show input state, closing the loop.

### 2.7 AI Lab — two switcher styles, one naming wobble

- The screen now nests **two different horizontal switchers**: the tab
  row (Scales / Rate My Take / AI Assistant) and, inside AI Assistant,
  the 5-mode pill toggle (Practice Tips / Lick Ideas / This Track /
  This Artist / Ask AI). Both are fine individually; together they're
  two visual languages for "pick one of N." Unify the styling (tabs on
  top stay tabs; the mode row adopts the same pill style used by the
  Scales panel's Per chord/Whole song toggle — which is a *third*
  variant today).
- "AI Lab" containing the deterministic Scales advisor and Rate My
  Take's DSP scoring is a naming stretch (neither is generative AI),
  but the brand value of one memorable name beats taxonomic purity —
  keep the name, and let the tab labels do the precision work.
- The AI Assistant panel's provider/key + Artist/Title cards push the
  actual modes below the fold on smaller windows. Both are
  configure-once-per-song (or once ever) — good candidates for the
  same `<details>` disclosure treatment the Input card's Setup already
  uses, collapsing once configured.

## 3. Grouping audit — summary table

| Capability | Lives in | Verdict |
|---|---|---|
| Enable Input / calibration | Tone Lab | **Keep** — it's rig setup. Fix discovery with the global status pill, not by moving it. |
| Tuner | Play Along | Keep. Optionally surface a mini-tuner in Rate My Take later (you tune before recording a scoreable take). |
| Rig preset management vs quick-pick | Tone Lab / Play Along | Keep — the split (manage vs switch) is right and already cross-labeled. |
| Performance recording | Play Along | Keep, add cross-link chip to Rate My Take (§2.6). |
| Dry-take recording | AI Lab · Rate My Take | Keep, add reverse cross-link chip. |
| Exported Tracks list | Play Along | Keep (weak preference), revisit if Library ever gets groups. |
| Rip system audio | Sidebar | Keep location, collapse behind a disclosure (§2.3). |
| Import (audio) + import (zip) | Sidebar, two zones | **Merge into one smart drop zone** (§2.3). |
| Speed Trainer / Export with no track | Inspector | **Hide when no track**; show first-use checklist instead (§2.2/§4). |
| Practice Log | Play Along | Keep — it's about playing sessions. |
| Scales / RMT / AI Assistant | AI Lab tabs | Keep; unify switcher styling (§2.7). |

## 4. First-use checklist v2 — "the Quest Log"

The current onboarding is a one-shot wall of prose that appears once,
is dismissed once, and is (as of this review) factually stale. The
replacement should be a **persistent, auto-checking checklist** — and
this is also where the fantasy theme earns its keep functionally rather
than decoratively: it's a *quest log*.

**Where it lives:** the right inspector's no-track state (§2.2), and
re-openable any time from Help. Not a modal — it should coexist with
doing the steps.

**The steps (updated to v5 reality), each with an auto-check condition
the app can already answer from existing state:**

1. **Summon a song** — drop an audio file or stem pack, or Rip system
   audio. *Auto-checks: library has ≥1 track.*
2. **Forge the stems** — pick a model, hit Separate. *Auto-checks: any
   track has cached stems.*
3. **Carve the mix** — mute/solo a stem or paint a mute region (e.g.
   silence the original guitar). *Auto-checks: any project has a
   non-default gain/mute state.*
4. **Mark your battleground** — set a loop or drop a marker on the part
   you're learning. *Auto-checks: any project has a loop region or
   markers.*
5. **Awaken the rig** — Tone Lab: enable your input, pick an amp (Pass
   Through / Analog / Neural). *Auto-checks: input has been enabled at
   least once (localStorage flag already effectively exists via device
   memory).*
6. **Forge your tone** — tweak the chain, save a Rig Preset.
   *Auto-checks: ≥1 saved preset.*
7. **Enter the arena** — Play Along: tune up, play through the song.
   *Auto-checks: practice log has ≥1 session.*
8. **Capture a take** — record a performance (or a dry take).
   *Auto-checks: any recordings exist.*
9. **Face the judge** — Rate My Take on a dry take. *Auto-checks: any
   cached rating exists.*
10. **Seek counsel** — ask the AI Assistant anything (needs a free API
    key). *Auto-checks: AI assistant cache non-empty. Marked optional —
    the only step needing a network/key.*

Each row: rune-style checkbox, one-line description, and a **"take me
there" jump** (the same screen-jump mechanic as the status pill and
cross-link chips — one navigation primitive, three uses). Completed
quests get the ember-glow treatment; the log collapses to a single
"Quests: 7/10" chip in the inspector once past step 3, and disappears
entirely (recallable from Help) at 10/10.

Mockup 1 (`mockups/mockup-1-first-run-quest.html`) shows exactly this.

## 5. Competitor UI scan (what the field looks like, July 2026)

Functional positioning is already covered in market-review-2026.md;
this is strictly about *interface language*:

- **Moises** — the UX benchmark in this space: 2024 iPad App of the
  Year, 2025 Apple Design Award finalist, and a recent redesign
  emphasizing an uncluttered waveform-centric player, instant setlist
  access, and progressive disclosure of its AI features. Its lesson for
  us: *AI handles complexity, the interface stays calm.* Where Guitar
  Studio already beats it: information density for power users (Moises
  hides too much). Where it beats us: first-session experience — you're
  playing along within a minute of install, guided the whole way.
- **Neural DSP (plugins + Quad Cortex)** — the tone benchmark: dark,
  premium, photoreal-skeuomorphic amps. Notably, reviewers praise the
  *hardware's* "classy, minimalist black/silver/grey" over the
  skeuomorphic on-screen graphics — even in that world, the trend is
  away from literal photo-real knobs toward stylized dark-metal
  minimalism. Guitar Studio should **not** chase photorealism (a losing
  art-asset arms race for a one-person project); stylized dark + glow
  reads just as "serious gear" at a fraction of the cost.
- **Positive Grid Spark** — the guided-practice benchmark: Smart Jam,
  auto-chords, "the app teaches you the app." Validates the Quest Log
  direction — their onboarding is a sequence of small wins, not a
  manual.
- **Yousician / Guitar Tricks** — gamified curriculum; different
  product, but their streak/progress mechanics are why the Practice Log
  and quest-completion states deserve visual celebration, not just gray
  text rows.
- **Ultimate Guitar / Songsterr** — content-first, utilitarian; their
  dark modes are functional but characterless. That's the fate the
  theme pass (§6) is avoiding: Guitar Studio currently sits closer to
  this end than to Moises/Neural DSP.

**Net take:** the field splits into "calm minimal practice apps" and
"dark premium gear sims." Guitar Studio is *both products in one*, and
its UI should read as: **Moises-calm workflows wearing Neural-DSP-dark
stagewear** — with the Orpheus myth as the thing neither of them has.

## 6. Visual identity — from "generic dark utility" to Orpheus

**Current state:** competent flat dark theme (#1b1d22 bg, single blue
accent #5b8cff for *everything* interactive). Two consequences: zero
visual hierarchy (primary actions, toggles, nav, and destructive
actions all shout in the same blue), and zero identity (nothing about
it says guitar, rock, or Orpheus — the lyre logo is the only clue).

**The app is already named after a myth** — the musician who walked
into the underworld and played well enough to bend its rules. That's a
*gift* of a theme for a "futuristic, fantasy-based, hard rock" brief,
and it's sitting unused.

**Proposed direction: "Molten Obsidian."**

- **Palette:** near-black obsidian with a warm undertone (`#131014`),
  charcoal panels (`#1d181c` / `#26202a`), and a **molten
  ember gradient** (`#ff7a3d → #e8a13c`) as the primary accent —
  active states glow like heated metal instead of lighting up blue.
  A restrained **arcane violet** (`#8a63ff`) as the secondary accent,
  reserved exclusively for AI/analysis features (chord ribbon, AI Lab,
  scores) so "the magic parts" are color-coded across the whole app.
  Existing success/warn/danger greens/ambers/reds stay (meters must
  stay conventional).
- **Type:** headings move to a small-caps serif stack (Palatino /
  Book Antiqua / Georgia — system fonts, no webfont dependency, works
  offline) with wide letter-spacing — reads "engraved," fantasy without
  cosplay. Body/controls stay system sans for legibility. Numbers stay
  tabular.
- **Texture & light:** a barely-there noise/vignette on the app
  background (CSS only), 1px inner bevels on cards ("cut stone"), and
  glow (`box-shadow`) strictly meaning **signal present / active** —
  glow is state, never decoration. The lyre-string motif: thin vertical
  gradient lines as section dividers and as the waveform lane
  backdrop.
- **Iconography:** keep the existing single-color line glyphs (they
  already match app-icon.svg); the chain chips get rune-tablet framing
  (slightly beveled, ember edge-light when engaged) per mockup 3.
- **What does NOT change:** layout metrics, information density,
  control behavior, the honesty-hint culture, and **contrast** — every
  text/background pair in the mockups keeps ≥4.5:1; the ember accent is
  *brighter* against obsidian than the current blue is against
  blue-grey. And because the entire app already runs on CSS custom
  properties, this ships as **a variables + selective-rules pass, not a
  rebuild** — with the current "Studio" look kept as a theme toggle for
  anyone who prefers the quiet version.

## 7. Mockups (in `research/mockups/`)

Open each directly in a browser — fully self-contained, no network, no
build step. They are *paintings of the proposal*, not working UI:

1. **`mockup-1-first-run-quest.html`** — cold start, themed: merged
   import zone, collapsed Rip disclosure, Quest Log in the inspector
   where dead Speed Trainer/Export controls used to be, global rig
   status pill (input off state) in the banner.
2. **`mockup-2-mixer-theme.html`** — the Mixer mid-session in Molten
   Obsidian: ember transport/waveforms, violet chord ribbon, active-nav
   treatment, status pill (input live + latency), lyre-string lane
   texture.
3. **`mockup-3-tonelab-theme.html`** — Tone Lab: compacted Input/Preset
   top row, the icon chain as the centerpiece (rune-tablet chips, ember
   glow = engaged, one open panel), status pill in clip state.

## 8. Recommendations, ranked

**Shipped with this review (factual fix, no design risk):**
- Help overlay rewritten to v5 reality (icon chain not ⠿, rig in Tone
  Lab, AI Lab exists, zip/rip import paths mentioned).

**Cheap and safe (do next, independent of any theming decision):**
1. Hide Speed Trainer/Export when no track; show a getting-started
   panel in that space (even the un-themed version).
2. Merge the two sidebar drop zones; collapse Rip behind a disclosure.
3. Cross-link chips between the two record buttons (§2.6).
4. Unify the three switcher styles in AI Lab (§2.7).
5. Collapse AI Assistant's provider/key + Artist/Title cards once
   configured (§2.7).

**The real projects (each its own milestone-sized decision):**
6. **Global rig status pill** (§2.5) — small-M; touches banner + a
   tiny event bus from playalong.js state. Highest UX value per effort
   of the big items.
7. **Quest Log first-use checklist** (§4) — M; auto-check wiring is
   mostly reading state that already exists.
8. **Molten Obsidian theme** (§6) — M for the variables/rules pass +
   theme toggle; the mockups are the spec.

**Explicitly not recommended:** photoreal skeuomorphism (art-asset arms
race, §5), moving Enable Input to Play Along (§2.5), renaming AI Lab
(§2.7), any layout restructuring of the Mixer (§2.4 — it remains the
app's best screen).

## Update — built

Every item in §8's ranked list has shipped (three commits, same session):
the five cheap/safe fixes, the global rig status pill, the Quest Log
first-use checklist, and the Molten Obsidian theme toggle. See
USER-MANUAL.md §3.10/§6.3/§6.2 and TEST-PLAN.md §14 for the shipped
behavior and its regression checklist. The "explicitly not recommended"
list is unchanged and still out of scope.

**Later update:** a "Bright Spark" light theme shipped alongside Molten
Obsidian and the original Studio look (three themes total, one cycling
toggle). §6's "engraved-serif headings" (Palatino) — one of the small
deliberate departures from a pure token swap — was reverted per direct
feedback: all three themes now share Studio's plain sans-serif for
readability. The --heading-font token stays wired through, so a
theme-specific font remains a one-line change if it comes back later,
just not the default anymore.

## Sources (competitor scan)

- [Moises — improvements & releases, Oct 2025](https://moises.ai/blog/moises-news/improvements-latest-releases/)
- [Moises official](https://moises.ai/)
- [Moises AI review 2026](https://simplifyaitools.com/moises-ai-review-features-pricing-pros-cons/)
- [Neural DSP Quad Cortex review — MusicRadar](https://www.musicradar.com/reviews/neural-dsp-quad-cortex)
- [Neural DSP community thread on skeuomorphic design](https://unity.neuraldsp.com/t/opinion-on-skeuomorphic-design/19525)
- [Positive Grid Spark app features](https://www.positivegrid.com/blogs/positive-grid/exploring-the-spark-app-our-favorite-features-and-secrets)
- [Positive Grid Spark 2 quickstart](https://www.sweetwater.com/sweetcare/articles/positive-grid-spark-2-quickstart-guide/)
