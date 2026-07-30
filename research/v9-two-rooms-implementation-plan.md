# V9 "Two Rooms" — implementation plan

**Branch:** `redesign/v9-two-rooms` (off `main`, pushed to origin). This is
an A/B exploration, not a replacement — `main` stays untouched and
deployable throughout. Nothing here merges to `main` without an explicit
go-ahead once it's been used for real.

**Source material:** `design_handoff_orpheus_redesign/` (README.md,
`orpheus-directions.html`, `orpheus-prototype.html`, screenshots) from
Claude Design, built against `research/claude-design-redesign-brief.md`.
Per the design's own handoff note, the HTML files are markup/behavior
*references* to recreate in this app's real environment, not code to
drop in.

## 1. What's changing and what isn't

**Changing:** the entire visual shell and per-screen chrome — fonts
(Space Grotesk / Manrope / JetBrains Mono), colors (warm "song room" vs
dark "rig room" split, described below), the sidebar becoming a 56px
icon rail + slide-out drawer, pedal chips, card styling, spacing.

**Not changing:** every control in `USER-MANUAL.md`'s Appendix A stays
functional — this is a reskin plus a couple of named IA changes (§3), not
a feature cut. The five-screen structure (Mixer/Tone Lab/Play Along/AI
Lab/Tab View) stays exactly as-is per the design's own reasoning (the
brief's research already validated that split).

**Explicit gap in the design handoff, fixed here:** none of the five
screen mockups show a page title (no "Mixer" / "Tone Lab" heading
anywhere in the content area — only the wordmark "Orpheus" persists in
the top bar and the active rail icon). The current app already solves
this with `#top-banner-screen-label` — v9 keeps that idea: the top bar
carries a small screen-name label next to (or below) the wordmark,
updated on every screen switch, so it's always obvious which of the five
rooms you're in without relying solely on which rail icon is lit.

## 2. Design tokens (from the handoff, verbatim)

**Type:** Space Grotesk 500/600/700 (headings/labels), Manrope
400/500/600/700 (body/UI), JetBrains Mono 400/500/600 (numeric readouts —
BPM, dB, Hz, knob labels, bypass labels). Google Fonts in the reference;
**this app is offline-first**, so these need to be self-hosted (vendored
under `static/vendor/fonts/`, same convention as the alphaTab bundle and
FluidR3Mono soundfont) rather than fetched from `fonts.googleapis.com` —
see §4's open question on this.

**Song room, theme A (light, default):** bg `#f5efe6` · card `#ffffff` ·
border `#e4dbc8` · text `#2a2118` · muted `#8a7d6c` · accent `#c1531f` ·
rail bg `#ece3d3`

**Song room, theme B (dark):** bg `#2a2118` · card `#382c1f` · border
`#453a2b` · text `#f5efe6` · muted `#baa88f` · accent `#ff7a3d` · rail bg
`#231b12`

**Rig room, theme A (dark, default):** bg `#141414` · card `#1d1d1d` ·
border `#333029` · text `#ece7df` · muted `#8f897d` · accent `#ff7a3d` ·
rail bg `#0d0d0d`

**Rig room, theme B (light):** bg `#e7e4dd` · card `#ffffff` · border
`#d5d1c6` · text `#1a1a1a` · muted `#6b675e` · accent `#c1531f` · rail bg
`#dedad0`

**AI/violet (reserved, both rooms/themes):** light-context accent
`#7c6cf0` / soft bg `#efecff`; dark-context accent `#a99bff` / soft bg
`rgba(169,155,255,.15)`

**Fixed regardless of room/theme (the "spine"):** top bar bg `#211a12`,
wordmark `#f5efe6`, play button `#ff7a3d` on `#211a12`, progress track
`#3a3128`. Rig-live pill `#8de6a6` bg / `#141414` text; rig-silent pill
`#2c2419` bg / `#7a6f5e` text.

**Spacing/shape:** rail 56px wide · drawer 220px wide · top bar 46px
tall · card/row radius 6-8px · rail icon buttons 34×34px, 8px radius ·
pedal cards 118px wide, 8px radius.

Mapped onto this app's existing CSS-custom-property theme system
(`--bg`, `--card-bg`, `--border`, `--text`, `--text-muted`, `--accent`,
etc. — see `styles.css`'s existing 5-theme setup) rather than inventing a
parallel token scheme: same variable names, new values, keyed off both
`data-theme` (A/B) **and** a new `data-room` attribute (song/rig) that
changes with the open screen. This is the one real architectural wrinkle
existing themes don't have — today's themes are one flat palette
app-wide; v9 needs the palette to also depend on which screen is open.

## 3. IA changes carried over from the design (confirmed, not silently dropped)

Per the handoff's own "IA changes & why" and "Deprioritized / hidden by
default" sections:

- **Sidebar → activity rail + slide-out drawer.** Same song library
  underneath, different chrome. Frees width back to stem lanes.
- **Tab View's separate library folded into the main drawer** as a
  Songs/Tabs filter chip. Today's app has two separate library lists
  (main sidebar + Tab View's own); this merges them into one. Real IA
  change, needs real code (Tab View's importer currently swaps the whole
  sidebar list — see `tabview.js` — this becomes a filter on one list
  instead).
- **AI Lab renamed "Coach"** in the UI (internal names/APIs unaffected).
  Violet stays reserved for AI-related UI everywhere, both rooms.
- **Speed Trainer + Key/Tuning correction** collapse into one "Practice
  tools" accordion in the Mixer inspector (currently two separate
  always-open blocks).
- **Export's LUFS/normalize/max-boost** move behind an "Advanced"
  disclosure; default view is just the Export button + format/name.
- **Keyboard/MIDI preset-cycle bindings + this-song preset chain** move
  into an overflow menu off the Rig Preset control instead of a standing
  list in Tone Lab.
- **Camera setup** (framing guides, quality, A/V offset/calibrate) only
  appears after "+ Camera" is toggled on in Play Along, instead of always
  shown.

None of these remove a control — Appendix A's full inventory (§4) still
needs a home for every item; these four just change *when it's visible*.

## 4. Open questions before/while building

- **Fonts:** vendor Space Grotesk/Manrope/JetBrains Mono locally (~3
  variable or static font files) rather than a Google Fonts CDN link, to
  keep the "runs entirely offline" property intact. Flagging as a
  decision, not assuming — will proceed with vendoring unless told
  otherwise, consistent with how every other third-party asset in this
  app is handled.
- **Persistent top-bar transport vs. today's 5 duplicated copies:** the
  design's top bar carries ONE transport (play/progress/BPM/speed),
  always visible, rather than today's pattern of the same transport bar
  markup repeated inside each of five screens. This is actually a
  simplification (removes duplication) but it's real engineering, not
  just CSS — `playalong.js`'s `data-transport` wiring currently expects N
  DOM copies. Tab View's *own* separate tab-playback bar (alphaTab's
  synth, independent of the backing track) stays exactly where it is —
  only the backing-track transport moves to the spine.
- **Theme toggle scope:** the design's theme toggle flips A/B *for
  whichever room is currently open* — it's not one global light/dark
  switch. Need to decide whether this replaces the existing 5-theme
  cycle toggle entirely on this branch, or coexists. Recommendation:
  replace it on this branch only (v9 is its own thing to A/B against
  `main`, not a hybrid) — `main`'s 5-theme system is untouched regardless
  since this never merges without sign-off.

## 5a. Shell — built and verified

Step 1 of the build order below is done: activity rail (56px, M/T/P/A/G +
? for Help, Coach's dot reserved-violet when active), the drawer (existing
sidebar, now visually restyled — the Songs/Tabs merge itself is still
pending, see step 6), and the top-bar spine (wordmark, restored per-screen
title, rig pill, A/B theme toggle) all render correctly across all five
screens with no console errors, in both rooms and both themes. Fonts
vendored locally (Space Grotesk/Manrope/JetBrains Mono, SIL OFL, via
`@fontsource` — same "no live Google Fonts request" rule as the app's
existing fonts). `data-room`/`data-v9-theme` on `<html>` drive the four
palettes; `paSetActiveScreen` (playalong.js) keeps `data-room` in sync;
`wireThemeToggle` (app.js) replaced wholesale with the A/B version scoped
per-room.

Verified via Playwright screenshots of all five screens, Tone Lab in both
themes, and a room switch back to Mixer in theme B — palettes, rail
active-state coloring (including Coach's violet exception), and the
restored screen-title label all behave correctly. Known follow-ups
already scoped to later steps, not bugs: Tone Lab's drawer doesn't hide
yet (step 6), AI Lab's internal tab pills still use the room accent
instead of violet (step covers Coach specifically), screen still says "AI
Lab" not "Coach" (same).

## 5b. All five screens — built and verified

Every step of the build order below is now done:

- **Mixer**: toolbar utility buttons (+ Marker, Zoom to loop, Click) restyled
  as JetBrains Mono pill "chips"; stem lanes are rounded 8px cards (border +
  margin) instead of a flat divided list, sticky lane-header background
  matched to the new card background; stem names set in Space Grotesk.
  Ruler/chord-lane/section-lane/zoom mechanics untouched.
- **Tone Lab**: drawer now collapses to 0 width when this screen is open
  (`html[data-room="rig"] #app` grid override), reclaiming that space for
  the pedal chain, exactly as the handoff specifies; pedal chips bumped to
  8px radius + Space Grotesk labels. Preset-chain/keybind-overflow
  simplification from the handoff's "Deprioritized" list was NOT done —
  every control there is still always visible, just reskinned; still a
  candidate for a later pass if wanted.
- **Play Along**: cards bumped to 8px radius; Record's camera/quality/sync
  setup (`#rec-setup`) now starts collapsed instead of open, matching the
  handoff's "hidden until a camera is actually wanted" call — same
  `<details>` element, no new JS.
- **Coach**: screen title renamed "AI Lab" -> "Coach" (`PA_SCREEN_LABELS`,
  playalong.js — internal IDs/APIs untouched); third tab's visible label
  shortened "AI Assistant" -> "Assistant"; `.ailab-tab-btn.on`/
  `.ailab-mode-toggle button.on` switched from the room accent to
  `--accent-2` (violet); the Ask AI card gets a violet border/heading,
  violet-tinted example-question chips, and a violet Ask button — the
  "violet always means AI" rule from the handoff, now actually true
  end-to-end on this one screen instead of just the rail icon.
- **Tab View**: added real Songs/Tabs filter chips to the drawer (not just
  visual) — Tabs forwards to the existing `tabview-open-btn` click handler,
  Songs forwards to `mixer-open-btn`'s, and both stay in sync with the
  active screen via `paSetActiveScreen`. The underlying two-panel swap
  (`song-library-panel`/`tab-library-panel`) is unchanged — this is a real
  nav control layered on top of it, not a data-model merge, which keeps
  the risk low while matching the handoff's "one file browser, one mental
  model" framing from the user's side.

**Verified headlessly**: a full sweep of all 5 screens with a track
loaded, toggling the A/B theme on every screen, plus targeted checks
(rail button count, drawer filter chips, sidebar resize handle, inspector
toggle, help modal, `?` keyboard-shortcuts modal) — 0 console errors, 0
uncaught exceptions, every checked element present and wired.

**Known, deliberately deferred** (not attempted — flagged rather than
silently skipped): Tone Lab's rig-preset-chain/keybind-overflow
simplification (§3), and any deeper visual pass on Rate My Take/Scales
beyond what the shared `.pa-card`/`.ailab-*` rules already carry through
for free. Neither blocks using this branch for a real side-by-side
comparison against `main`.

## 5. Build order

1. **Shell** (rail, drawer, persistent top bar incl. screen title,
   room/theme token wiring) — common infrastructure every screen sits
   inside. No screen-specific content changes yet.
2. **Mixer** — highest-traffic screen, and the one the design shows in
   most detail.
3. **Tone Lab** — the pedal-chain-as-icon-row pattern already exists in
   `main`; this is a reskin of an existing good pattern plus the
   preset-chain-into-overflow change.
4. **Play Along** — tuner/looper/takes cards, camera-on-demand change.
5. **Coach (AI Lab)** — tab pills, violet accent, Assistant layout.
6. **Tab View** — last, because it depends on the drawer's Songs/Tabs
   merge from step 1 being real, not just visual.
7. **Verification pass** — headless Playwright sweep of all 5 screens on
   the branch confirming every Appendix A control still exists and
   works, both room palettes look right in both themes, then push and
   hand back for A/B comparison against `main`.

## 6. How to compare against `main`

Since this is a separate branch (not a runtime theme toggle in the same
build, given the IA/architecture changes in §3-4), a true *simultaneous*
side-by-side needs two separate checkouts of the repo — switching
branches in one folder only lets you run one at a time. A `git worktree`
gives a second folder sharing the same `.git`, no second clone needed:

```
git worktree add ../Guitar-studio-v9 redesign/v9-two-rooms
cd ../Guitar-studio-v9 && python3 GuitarStudio/server.py --port 8766 &
cd /home/user/Guitar-studio && python3 GuitarStudio/server.py --port 8765 &
```

**Checked:** `server.py` stores everything (imported tracks, `separated/`
stems, `GuitarStudio/projects/`, rig models) under the repo root itself
(`PROJECT_ROOT = .../GuitarStudio/server.py`'s parent's parent), so a
fresh `git worktree` gets its own *empty* copy of all of that by default
— it won't automatically see the library on `main`. To actually share
one live library between the two side-by-side servers, symlink the data
directories from the worktree back to the main checkout before starting
its server:

```
cd ../Guitar-studio-v9
ln -s ../Guitar-studio/separated separated
ln -s ../Guitar-studio/GuitarStudio/projects GuitarStudio/projects
# plus any imported track audio files/folders at the repo root
```

Simpler fallback: just import the same handful of test songs into both —
an A/B look-and-feel comparison doesn't need to be the same live library,
only the same content loaded.
