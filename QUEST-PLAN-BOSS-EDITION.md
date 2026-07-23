# The Quest Plan — Boss Rush Edition

A from-scratch, exhaustive regression pass through **every feature in
Orpheus Guitar Studio**, framed as a run through the game the Quest Log
already promises: a string of bosses guarding each part of the app, ending
in one Final Boss that only falls if everything before it actually works
together, in one sitting, with nothing propping it up.

**This is not a replacement for [TEST-PLAN.md](TEST-PLAN.md).** That file
is the fast, targeted regression checklist — re-run just the section that
touches whatever you changed. This one is the opposite: a full-app, top-
to-bottom playthrough, meant for a release-candidate pass, a "did the last
six months of work actually hold together" audit, or exactly what was asked
for here — a complete first sweep of a build that just shipped a lot of new
UI at once. Expect this to take a real session (a few hours with a guitar
in hand), not twenty minutes.

**Rules of the run:**
- Real hardware, always. A USB interface + guitar (or at minimum real
  playback and a mic) — headless/automated checks in this codebase verify
  wiring and math, never how something actually sounds or feels to play.
- Play every boss **in order**, top to bottom, in one browser session
  where the section says so — some bosses only reveal their real bugs when
  the state arriving into them is real (a song actually separated earlier
  in the run), not freshly seeded.
- Tick every box. A boss isn't "defeated" with some of its trials skipped
  — that's a boss you walked past, not one you beat.
- Where a trial's outcome is a judgment call ("does this sound right?"),
  write down what you actually heard/saw, even a "no" — an honest miss is
  useful data, not a failure to hide.
- **Loot** at the end of each boss is what "victory" actually means for
  that section — the concrete state you should be looking at once every
  box above it is ticked.

Grab a fresh browser profile (or clear this site's localStorage) before
Boss 0 so the run starts from a genuinely cold state — the Quest Log and
first-run Help overlay only tell the truth about a first session if it
really is one.

---

## Boss 0 — The Threshold Guardian (setup & first launch)

*Guards: installation, first boot, the Help system, the in-app onboarding.*

- [ ] Fresh install per USER-MANUAL.md §1 (or, if already installed,
  confirm `Guitar Studio.app` still launches clean): Homebrew → Python/
  ffmpeg/git → clone → venv + `pip install -r requirements.txt` → `bash
  scripts/build_app.sh` → double-click the app.
- [ ] First launch specifically: macOS Gatekeeper blocks it once; Right-
  click → Open → Open again gets past it; the browser opens on its own to
  the Mixer afterward.
- [ ] **Help overlay** auto-shows on this genuinely-first-ever launch;
  reflects v5 reality (icon chain, four real screens including AI Lab,
  zip/rip import paths) — not stale copy from an older build.
- [ ] Closing Help once means it does **not** auto-show again on a normal
  reload — only the ❓ button brings it back.
- [ ] **Quest Log button inside Help** (`#help-quest-log-btn`) opens the
  Quest Log as a modal from here specifically — confirm it works even
  with a track already loaded (where the inspector's own Quest Log panel
  isn't showing).
- [ ] Server-by-hand path also works: `python3 GuitarStudio/server.py
  --port 8765`, then `http://127.0.0.1:8765/` manually — confirms the
  packaged-app path isn't hiding a server-side bug.
- [ ] The server only answers on `127.0.0.1` — nothing on the LAN can
  reach it (spot-check: try the Mac's LAN IP from another device on the
  network and confirm it does not load).

**Loot:** a running server, an app that opened itself in a browser, and a
Help system that isn't lying about what build this is.

---

## Boss 1 — The Gatekeeper (import & separation)

*Guards the front door: every way a song gets into the Library, and the
machine that tears it into stems.*

- [ ] **Merged drop zone (v5):** one **Drop an audio file or stem pack
  here** box in the sidebar — no separate zip zone to hunt for. Drag an
  MP3/WAV onto it → imports normally. Drag a `.zip` onto it (or anywhere
  in the sidebar — both highlight while dragging) → routes to stem-pack
  import automatically, not treated as a broken audio file.
- [ ] Click-to-import (file picker) does the same thing as drag, for both
  file types.
- [ ] A cloud-placeholder file (OneDrive/iCloud file that reads as present
  in Finder but isn't actually downloaded) is caught **before** upload with
  a clear message naming the problem, not a silent no-op.
- [ ] Selecting a freshly-imported, not-yet-separated track shows a model
  picker + **Separate** button, not a blank mixer.
- [ ] **Separate** with the default model (`bs_roformer_sw`) actually
  produces 6 stems (vocals/drums/bass/guitar/piano/other) within a
  plausible time (roughly a fifth to a quarter of the song's length); the
  progress indicator is visibly alive throughout, including the last
  stretch near 100% that some models sit on for a while.
- [ ] **A/B a second model** on the same song (e.g. `htdemucs`) via the
  model badge in the toolbar — separates fresh, does **not** overwrite the
  first model's stems; switching the badge flips between both instantly
  once both exist.
- [ ] **Dropped-connection recovery:** if you can force a flaky network
  mid-separation (or just trust the mechanism), confirm a "failed to
  fetch" on a long job checks real job status before reporting failure —
  a job that actually finished server-side loads its stems with no error
  shown at all.
- [ ] **Stem-pack ZIP import:** a real multitrack zip (or Finder-compressed
  folder with `__MACOSX`/`._*` junk in it) imports every real audio file as
  its own stem lane named exactly as the file was, ignores the junk
  entries, and shows model badge `imported` with the mixer ready
  immediately — no Separate step, and it never appears with a `.zip`
  extension in the Library.
- [ ] BPM/beat grid/chord lane/key all populate for that imported pack
  against fuzzy stem-name matching (not the fixed separation vocabulary).
- [ ] **Mark a stem as the guitar (imported packs, real user request):** a
  🎸 button next to each stem's ✎ rename button (only on an imported-model
  track, never on a normally-separated one) marks that stem as "the
  guitar" for features that need one real reference file — clicking a
  second stem's 🎸 un-marks the first (only one at a time). The choice
  survives a song switch and a page reload. With a stem marked: Tone
  Lab's Suggest a tone (Boss 11) works against it instead of showing its
  "needs a guitar stem" hint, and Rate My Take/Practice Tips (Boss 8/9)
  score against it instead of refusing.
- [ ] A zip with two files colliding to the same sanitized stem name fails
  up front, naming both files, rather than silently overwriting one.
- [ ] A non-audio zip, or a plain non-zip garbage file, fails with a clear
  message — no crash, no silent nothing.
- [ ] **Custom stems (drop directly onto the mixer, not the sidebar):**
  on an already-separated track, dragging an MP3/WAV onto the lane area
  shows the "Drop to add as a new stem" overlay and lands as a lane tagged
  **custom** — mute/solo/fader/pan/EQ/mute-painting/export all work
  identically to a model stem. The same drop onto a track with **no**
  separated stems yet does nothing (no overlay, no upload).
- [ ] A custom stem survives switching separation models on the same song
  **and** survives Re-separate — never disappears, never needs re-adding.
- [ ] Re-dropping a same-named file replaces the existing custom stem
  (no duplicate, no error); the ✕ next to it removes it (with confirm).
- [ ] A custom stem literally named "guitar" does **not** trigger the
  Guitar Split panel (Boss 5) — only a real model-produced `guitar` stem
  does.
- [ ] **Custom stem repositioning ("patching"):** drag a custom stem's
  waveform left/right (cursor → ↔) and it slides in its lane, leaving
  correct blank space before/after; a plain click still seeks instead of
  moving it. Reload keeps it wherever it was dropped; export bounces it at
  the dropped position. Known limitation, confirm it's still just that and
  not worse: repositioning plays from the wrong spot only while Speed/Tune
  are off their defaults.
- [ ] **Stale-source banner:** touch the source file's mtime (or actually
  re-encode it) after separating, reselect the song — the amber "source
  changed" banner appears with working Re-separate/Dismiss, nothing
  silently discarded either way.

**Loot:** at least two real songs in the Library — one separated with the
default model plus a second A/B model, one imported as a stem pack — plus
one custom stem added to each, needed as raw material for every boss below.

---

## Boss 2 — The Phantom Broadcast (Rip system audio)

*Guards the one Library feature that needs no file at all.*

- [ ] **Before BlackHole is installed:** the Rip card (collapsed by
  default behind its disclosure — expand it once, confirm the expanded
  state survives a reload) shows install instructions
  (`brew install blackhole-2ch`), not a confusing empty device list.
- [ ] Complete USER-MANUAL.md §1.7 for real: install BlackHole, set it (or
  a Multi-Output Device) as the Mac's output, confirm the Rip device
  dropdown auto-selects it.
- [ ] **Start Rip** asks for mic/input permission once, then visibly
  starts (button swaps to Stop, elapsed time counts up).
- [ ] Play something audible through the routed output during the rip
  window; **Stop Rip**, name the take, confirm it lands in the Library,
  selectable/playable like a normal import, and the captured audio is
  actually present and audible in the file.
- [ ] **Silent-rip guard:** deliberately rip with routing wrong (BlackHole
  not actually selected, or nothing playing) — the file still saves, but
  an immediate warning names the measured peak level and points at the
  BlackHole/Multi-Output fix, rather than surfacing later as a cryptic
  "no stems found" separation error.
- [ ] Confirm the hardware-volume-keys caveat from §1.7 is real and
  expected (not a bug): while BlackHole/Multi-Output is the default
  output, volume keys/menu-bar slider misbehave; switching back to normal
  speakers restores them.

**Loot:** one ripped song in the Library, proving the whole BlackHole
pipeline end to end, plus one deliberately-silent rip that correctly
warned you instead of lying.

---

## Boss 3 — The Archivist (Library, playlists, practice log)

*Guards the shelves: organizing, renaming, and remembering everything
above.*

- [ ] **Rename** a track (✎): source filename changes; separated stems,
  saved mix, practice history, and any recordings/exports for it all
  follow automatically — nothing orphaned.
- [ ] **Delete** a track (✕, with confirm): source file *and* every
  derived file (stems/exports/recordings) are gone, and it drops out of
  any playlist that referenced it.
- [ ] **Sidebar resize:** drag the seam (cursor → ↔) to resize live, can't
  exceed min/max, double-click resets to default, width survives reload,
  nothing overlaps at extreme widths.
- [ ] **Create a playlist** from a song's own **+** → **+ New
  playlist…**; it appears alphabetically below All Tracks, seeded with
  that song, and the song still shows under All Tracks too (never a move).
- [ ] Add the same song to a second playlist from its row's **+** popover
  (the playlist header itself carries only ⟳ Auto-play / ✎ / ✕ — no
  add/stepping buttons).
- [ ] **⟳ Auto-play** on a playlist header: armed (green), a song from
  that playlist ending naturally auto-loads and plays the next one,
  stopping for real after the last (no wraparound); arming a second
  playlist disarms the first; the armed state survives a reload.
- [ ] Inside an expanded playlist: **▲ / ▼** reorders a member row, **✕**
  removes it from just that playlist (song itself untouched); playlist
  **✎ / ✕** rename/delete the playlist without touching its songs.
- [ ] Playlists survive a server restart (server-side storage, not
  per-browser).
- [ ] **Library button styling:** every small utility control here (rename/
  delete, playlist auto-play/rename/delete (except ⟳ while armed, which goes green on purpose), reorder/remove) shares the
  same quiet look — never solid blue, which stays reserved for real
  primary actions elsewhere.
- [ ] **Practice log accumulation:** play any song for over a minute (Mixer
  or Play Along, doesn't matter why playback is running) and confirm a dim
  time readout appears on its Library row, matching the Practice Log
  card's own total (§5.8/Boss 10).
- [ ] **Session grouping:** pause mid-song for several minutes without
  switching songs, resume — same session row, not a new one. Switch away
  to a different song for a real stretch, then back — new row. Leave the
  same song idle for hours untouched — also a new row (a genuinely new
  sitting).
- [ ] Practice time follows a renamed source file the same way projects do
  (content-hash keyed, not filename keyed).

**Loot:** at least one multi-song playlist you can step through end to
end, and a practice-log entry with real accumulated minutes on at least
two different songs.

---

## Boss 4 — The Mixer's Maze (the Mixer, in full)

*The biggest boss in the run — four phases, each its own mini-fight.*

### Phase 4a — Lanes, faders, and the export-affecting truth

- [ ] Each stem's Mute/Solo/fader work independently; Solo silences every
  other lane. Soloing a lane that's currently muted un-mutes it (its mute
  button turns off and it's genuinely audible while soloed, not silent);
  un-soloing afterward leaves it unmuted rather than re-muting it.
- [ ] **Scroll position survives Mute/Solo (real user report):** on a
  6+-stem track, scroll the lane list down so the last stem is the only
  one visible, then click its Mute or Solo button — the view stays
  scrolled exactly where it was, it does not jump back to the top.
  Switching to a different track, by contrast, SHOULD reset the scroll
  to the top for the newly-loaded song.
- [ ] Waveforms render for every stem and roughly track loud passages by
  ear/eye.
- [ ] **Mute-lane painting:** click-drag paints a mute region; clicking an
  existing region removes it; the painted region is exactly what's silent
  on playback **and** on export (§4c below) — same underlying data.
- [ ] **Pan** audibly moves a stem left/right; label matches (C/L50/R30).
- [ ] **Per-stem EQ** disclosure opens/closes; Bass/Mid/Treble each
  audibly change tone.
- [ ] **Confirm the export boundary directly:** with Solo engaged on one
  stem, Pan moved off-center, and per-stem EQ pushed hard on another stem
  — export the mix (§4c) and confirm none of those three carried into the
  bounced file. Only mute state and gain faders should have.
- [ ] **Split-guitar headroom:** a stem flagged as a split-guitar
  candidate (Boss 5's Candidate A/B, or a panning-based custom stem) can
  push its fader past 150% up to 300%; an ordinary stem caps at 150%.
- [ ] Double-clicking a stem's gain percentage resets it to 100%; double-
  clicking the Pan label recenters it.

### Phase 4b — Timeline: loop, zoom, markers, speed trainer

- [ ] **A/B loop:** drag both ruler handles to set a region; **Loop**
  toggles on/off (defaults to the whole track the first time enabled);
  clicking the ruler off a handle seeks instead.
- [ ] **Zoom to loop** (with a loop set) rescales ruler + every waveform
  with real added detail, not a stretched image; ruler clicks, handle
  drags, and mute painting all still land correctly while zoomed; **Zoom
  out** restores the full view; resets on track switch.
- [ ] **Continuous Zoom slider** widens the view independently (up to 24×),
  scrolls horizontally; stem names/lane headers stay pinned left; click-
  to-seek, loop-drag, and mute-painting stay correct at any zoom/scroll
  position; combines with Zoom-to-loop (zoom to loop first, then slide in
  further); double-click resets to fit-width.
- [ ] **Playhead follow during playback:** the view tracks the playhead
  once it crosses the window's middle, and snaps to center on a big jump
  (loop wrap, marker double-click, manual seek) instead of leaving it
  stranded off-screen.
- [ ] **Section markers:** **+ Marker** drops one at the playhead
  (prompts for a name); click jumps to it; double-click loops it to the
  next marker (or track end) and turns Loop on automatically; hover
  reveals **×** to delete; markers persist on reload.
- [ ] **Alt+←/→** nudges ~100ms; **Shift+←/→** still jumps 5s — confirm
  both, and that plain ←/→ does its normal nudge only while both rig
  screens are closed (Boss 6 covers the handoff when they're open).
- [ ] **Beat grid + Click:** faint ticks on the ruler (brighter = downbeat)
  once analysis has run; **Click** produces an audible metronome locked to
  those beats, accenting every 4th beat as a downbeat, with its own
  volume slider; toggling mid-playback, seeking, and looping never cause
  drift or a burst.
- [ ] **Count-in:** 2 bars of click before playback (and recording) starts,
  synced to detected BPM.
- [ ] **Speed Trainer** (right inspector): with a loop set, **Start** jumps
  to the configured start%, **Step up** nudges toward Target by Step,
  clamping exactly at Target on the last click without overshoot; BPM
  readout scales with Speed throughout.
- [ ] **Speed/Tune reset on track switch** (unity/1.00×/0¢); **Volume does
  not** reset — it's a listening level, not per-song state.
- [ ] **BPM half/double correction:** on a track whose detected tempo
  looks halved/doubled, ½×/2× fix it in one click and the correction is
  remembered on reselecting that song later.

### Phase 4c — Chord lane, key detection, and export

- [ ] **Chord ribbon** appears once analysis exists, pinned to the top of
  the workspace while scrolling; chips span multiple beats when a chord
  holds; clicking a chip jumps the playhead there; low-confidence beats
  show a dimmed **?** instead of a guess.
- [ ] **Riff-heavy stability check:** on a genuinely riff/power-chord-heavy
  song, a sustained riff/chug reads as one steady chip, not a rapid
  flicker between neighboring guesses; a real chord change (verse→chorus)
  still shows up distinctly.
- [ ] **Power chords read as "5":** a bare root+fifth riff shows e.g.
  **A5**, not forced into maj/min; a real major/minor triad elsewhere in
  the same song (clean verse, open chord) still reads correctly, not
  swallowed into "5" by an over-eager gate.
- [ ] **Root accuracy:** sanity-check the chord lane's actual root names
  against what you'd call out by ear on a song you know — not just
  stability/quality, the specific note names. Confirm it still works (just
  without the bass-stem nudge) on a track with no/quiet bass stem, e.g. an
  imported stem pack.
- [ ] Chord roots transpose live with the **Tune** slider, matching the
  Detected Key hint's own transposition.
- [ ] **Detected key**: shown with a confidence caveat; on a song with a
  clear progression, the key/root roughly agrees with what the chord lane
  is showing; a riff-heavy song you know is genuinely minor reads as
  minor, not falsely major.
- [ ] **Export:** open the Export section (always visible once stems are
  loaded, no button to reveal it). Set a custom output name, try both WAV
  and MP3, toggle Normalize loudness off/on, adjust Target LUFS and Max
  boost cap. Export bounces exactly the mute/gain state confirmed in
  Phase 4a. **Reveal in Finder** opens straight to the file; the export
  also shows up immediately in Play Along's Exported Tracks card (Boss 10)
  if that screen happens to be open.
- [ ] Trigger the boost cap deliberately (an aggressively quiet/soloed
  mix) and confirm the "cap was hit, target not fully reached" note
  appears rather than silently overshooting or clipping (peak-safety
  clamp around −0.2 dBFS is automatic either way).

### Phase 4d — Adding a custom stem live (already covered in Boss 1's
material check, but confirm again here in the full-Mixer context)

- [ ] With everything above still loaded, drag one more MP3/WAV onto the
  lane area and confirm it participates correctly in mute/solo/pan/EQ/
  mute-painting/zoom/export alongside the model stems you've been testing
  all through Phases 4a–4c — not just in isolation the way Boss 1 checked
  it.

**Loot:** one song, fully mixed, mute-painted, looped, zoomed, chord-read,
and exported — with the export file in hand to prove the mute/gain-only
boundary held.

---

## Boss 5 — The Twin Echo (Guitar split, experimental)

*Guards a heuristic that's honest about not being a real model.*

- [ ] Split panel only appears once a real model-produced `guitar` stem
  exists (a custom stem literally named "guitar" must **not** trigger it —
  re-confirm from Boss 1).
- [ ] Run **Spectral**, **Mid-side**, and **Hybrid** — all three produce
  audibly plausible, distinct pan/variant candidates and a correlation
  number; the currently-selected method is visibly highlighted (not just
  the same blue as every button).
- [ ] Solo **Candidate A (center)** and **Candidate B (sides)**
  independently and judge by ear which (if either) is cleaner — note the
  result, since neither is guaranteed and that's expected.
- [ ] **Hybrid** on a track with no beat grid falls back to plain Spectral
  with no error.

**Loot:** a judgment call written down — which candidate won on this song,
if any — not a pass/fail, since "neither was clean" is itself a valid,
expected result here.

---

## Boss 6 — The Wayfinder (screen navigation)

*Guards the seams between Mixer / Tone Lab / Play Along / AI Lab / Help.*

- [ ] The four real-screen buttons (🎚🎛🎸🧠) sit together as one visually
  identical 2×2 group; ❓ Help sits alone below them and never takes an
  active/highlighted state.
- [ ] **v5 nav styling:** buttons default to a quiet look; only the current
  screen's button is solid/highlighted, and it updates live as you switch.
  Specifically re-confirm Mixer shows correctly active on a fresh page
  load (a real regression this build fixed — Mixer was never marked
  active before).
- [ ] The top banner shows the app name/version left and the current
  screen name centered, full width, on all four screens, no overlap with
  any rig screen's own header.
- [ ] Opening any one of Tone Lab/Play Along/AI Lab closes whichever other
  one was open — never two visible at once; Mixer closes whichever is
  open.
- [ ] Selecting a different track from inside any rig screen drops back to
  the Mixer, closing the overlay.
- [ ] Opening Tone Lab or Play Along for the first time after a track
  loads builds the live rig (Enable Input usable, meters move) without
  needing to visit the other screen first.
- [ ] **Rig status pill (top banner, v5):** gray/neutral before input is
  enabled; live/pulsing once enabled and receiving signal (confirm the
  pulse stops with `prefers-reduced-motion` set at the OS level); switches
  to a clipped state matching Tone Lab's own clip light; clicking it opens
  Tone Lab from anywhere.
- [ ] **Theme toggle (v5):** click it on any screen — it cycles Molten
  Obsidian 🔥 → Bright Spark ☀️ → Studio 🌙 → Molten again, the palette
  swapping instantly (no reload needed) and the button's own icon always
  showing whichever theme is now active; reload the page at each of the
  three and confirm each persists with no flash of the wrong theme before
  paint; cycle back to Studio and confirm every screen's palette is
  exactly back to default, nothing left over from either other theme.
  Spot-check Bright Spark specifically for readability (dark text on
  white, nothing washed out) since it's the newest and least-exercised of
  the three. Confirm the Mixer's chord lane and AI Lab's chord ribbon
  switch to the *same* purple analysis color as each other in **all
  three** themes, Studio included — two real reports caught this: first
  the two ribbons disagreeing with each other, then (after that fix) the
  shared color itself still reading as plain blue rather than a clear
  purple, in every theme including Studio, which didn't have a distinct
  analysis color at all before this.
- [ ] **Quest Log (v5):** with no track loaded, the inspector shows the
  Quest Log instead of normal panels — re-verify every quest here in
  context (most were already ticked naturally by Bosses 1–5; confirm the
  count reflects that honestly). Open it again via Help's Quest Log
  button while a track **is** loaded, confirm the modal works there too,
  and that a "go" button on any row navigates correctly and closes the
  modal.

**Loot:** confirmed that all five surfaces (four screens + Help) hand off
to each other cleanly, and that the three brand-new top-banner controls
(status pill, theme, Quest Log) work identically from every one of them.

---

## Boss 7 — The Oracle of Scales (AI Lab: Scale/Mode Advisor)

*Guards pure arithmetic dressed as a suggestion engine.*

- [ ] **Per chord mode:** a chord ribbon above a stacked, scrollable list
  of every scale/mode fitting the selected chord's root+quality, each with
  its own labeled 24-fret diagram; opening AI Lab auto-selects whichever
  chord is under the current playhead.
- [ ] Clicking a different chip re-picks its stack and seeks the playhead;
  a no-confidence chord shows dimmed/unclickable with an honest empty
  message.
- [ ] **Follow song** (default on): during playback, the selected chip and
  stack change on their own at each chord boundary; the button glows green
  while active.
- [ ] **Pin by clicking:** clicking a chip turns Follow off (button grays)
  and holds that chord while playback moves on; clicking Follow again
  snaps back to the playhead's chord and resumes following. Reopening AI
  Lab always restarts in Follow mode. Follow's button is hidden entirely
  in Whole song mode.
- [ ] **Pinned whole-song entry:** the top stack entry is always the
  song's overall key scale (badged **Whole song**) regardless of selected
  chord — check both while following and after pinning. It leads with
  minor pentatonic for a minor-key song, major for major; if the selected
  chord's own top pick is the exact same root+scale, it appears once
  (badged), not duplicated.
- [ ] **Whole song mode:** shows scales for the detected overall key only;
  today always exactly one key region (no mid-song modulation detection
  yet) — confirm the screen says so honestly rather than implying more.
- [ ] Moving **Tune** live-updates chord names, key name, and root fret
  marking in both modes.
- [ ] Scale-name chips above the stack jump-scroll correctly; a track with
  no chord analysis shows an honest message, not a blank area.
- [ ] Switching tracks while AI Lab is open re-renders against the new
  track's data (and re-picks the playhead's chord), no stale leftovers.
- [ ] Tab bar: **Scales** / **Rate My Take** left, **Close** right; the
  previously-active tab stays selected across closing/reopening the
  screen.

**Loot:** confidence that the scale suggestions genuinely track live
playback and Tune transposition, not just a static screenshot's worth.

---

## Boss 8 — The Judge (Rate My Take)

*Guards the one screen that scores you against the record.*

- [ ] **Dry take:** **Record dry take** captures and, on Stop, uploads and
  lists — verify by ear/waveform the saved file is your guitar **only**,
  even with the backing track playing loudly during the take.
- [ ] The dry-takes list here only ever shows dry recordings for the
  currently-selected song; a regular Play Along take never appears here,
  and a dry take never appears in Play Along's own Takes tab (same
  folder, different filter).
- [ ] **v5 cross-link:** click the link on this card to Play Along's
  Record card, then use its own reverse link to come straight back — both
  directions land on the right screen/tab.
- [ ] **Backing Track card + Offset:** play/scrub to where the solo
  actually starts, click **↓ Use current position as Offset**, confirm it
  fills the field correctly.
- [ ] **Score this take** with Offset search left at default — the auto-
  fine-tune should land close to the actual best-aligned start even from a
  rough guess; the heatmap is scoped to just the take's own span (not the
  whole song), color-coded (green/red/gray), with a Pitch/Timing agreement
  breakdown under the overall percentage.
- [ ] **Ratings persist:** switch to a different take and back — the
  cached percentage/breakdown/heatmap/Offset all reappear instantly with
  no re-scoring; only clicking Score again re-runs it. Rename a scored
  take and confirm its rating and Offset both carry over with the name.
- [ ] **Result blanks on song switch (real user report):** with a rated
  take's result showing, switch to a different song with zero dry takes —
  confirm the result card actually clears (hidden) and the Offset field
  resets to 0, rather than the previous song's rating just sitting there.
  Switch back — the original song's rating reappears correctly.
- [ ] **Invalid rating:** deliberately score with a badly wrong Offset —
  confirm it reports "Invalid rating — check your offset?" rather than a
  misleadingly low percentage, and that fixing the Offset resolves it.
- [ ] Score at least one single-note solo take **and** one chord/rhythm
  take — confirm the solo take is measurably slower to score (per-note
  pitch check) and that both produce sensible, different-feeling
  breakdowns (a chord take shouldn't get a spuriously high pitch score
  from vibrato tolerance the way a wandering lead line does).
- [ ] Each row's own **▶ Play / ✎ Rename / 🗑 Delete** work in place;
  deleting a take also deletes its cached rating/heatmap.

**Loot:** at least one scored solo and one scored rhythm take, with a
written judgment call on whether the score matched what your ears actually
heard — the real point of this boss, not just that the UI didn't crash.

---

## Boss 9 — The Sage (AI Assistant)

*Guards the only network call in the whole app — and the honesty
disclaimers that come with it.*

- [ ] **This song card:** confirm the prefilled Artist/Title guess from
  the filename, correct it if wrong, **Save** — stored per-song.
- [ ] **v5 auto-collapse:** with a provider key already saved and Artist/
  Title already filled in, close AI Lab and reopen it (or switch songs and
  back) — both setup cards should fold to a one-line summary on that
  "just opened" moment. Then, with a card open, switch providers or
  re-save a key **while it's already expanded** — confirm it does **not**
  get yanked shut mid-task. Click a collapsed summary line to re-expand it
  manually.
- [ ] **Provider picker:** set up and save a real key for at least two of
  the three providers (Claude/Google Gemini/Groq) — confirm switching the
  dropdown shows each provider's own key status independently, without
  disturbing the other's saved key.
- [ ] **Lick Ideas:** optionally tag a style, click **Get phrasing ideas**
  — confirm the response is concrete (target notes over specific chords,
  not generic filler) and formatted with real paragraph breaks, not one
  dense wall of text.
- [ ] **Ask AI:** try one of the prefilled example prompts as-is, then a
  genuinely off-topic question (not about music/this track/this artist) —
  confirm the off-topic one gets politely declined rather than answered
  anyway.
- [ ] **Practice Tips:** pick a dry take already scored in Rate My Take
  (Boss 8) — confirm the carried-over score/Offset hint line is accurate;
  **Get practice tips** and confirm it reuses that exact scoring (hint
  says so) rather than silently re-scoring; the tips reference the take's
  actual weak spots, not generic advice.
- [ ] **This Track** / **This Artist:** one click each (Artist/Title
  filled in first) — confirm both carry the standing "verify checkable
  facts yourself" disclaimer, and spot-check at least one factual claim
  each against something you can actually verify.
- [ ] **Answers persist per song:** switch modes, close AI Lab, reload the
  entire app, come back to this song — every mode's last answer redisplays
  with no new request spent. Only re-running a mode replaces its cached
  answer (Practice Tips specifically: its cached tips should only
  reappear while the *same* take that generated them is still selected).
- [ ] **Result clears on song switch (real user report):** with an answer
  showing in any mode, switch to a different song with nothing cached for
  that mode — the result card actually hides rather than continuing to
  show the previous song's answer. Switch back to the original song —
  its answer reappears, no new request spent. Check at least two modes,
  not just one.
- [ ] Judge honestly, per the manual's own framing: for Lick Ideas/Ask AI/
  Practice Tips, does the output feel genuinely specific to this song, or
  like generic advice any lookup table could produce? Write down the
  verdict either way.

**Loot:** a real answer cached in every one of the five modes for at least
one song, plus an honest judgment call on whether the "research spike" is
earning its keep.

---

## Boss 10 — The Rehearsal Hall (Play Along top strip)

*Guards the shared transport and practice tools that live above Record/
Takes.*

- [ ] **Backing Track mirror:** Play/Stop/Loop/Count-in/BPM/Speed/Tune/
  Volume here match the main Mixer's state in both directions — change it
  from either place, confirm the other updates.
- [ ] **Scrub timeline:** drag it, confirm it seeks and stays in sync with
  playback; its range matches the loaded song's real duration (not stale
  from a previous song).
- [ ] **Tuner (v5 arc-gauge redesign, real user feedback):** the big
  center mic button toggles it on/off (red -> green) and mutes both
  backing track and your live processed tone (both restore to their real
  prior levels, not just unity, on toggling off); against a real tuned
  reference string, the note name, Hz, and cents readouts are all
  accurate, and the pointer/dot on the arc move to the correct side (flat
  = left, sharp = right) and turn green together with the mic button
  within 5 cents of true. The gauge should visually fill the card's full
  height next to Backing Track, not just its top portion — the whole
  point of this redesign.
- [ ] Double-click resets: Speed/Tune value readouts here **and** on the
  Mixer reset to 1.00×/0¢; master Volume readout resets to 100%.
- [ ] **Speed/Tune audio quality:** with Tune moved off 0¢ (either
  direction) or Speed off 1.00×, playback stays clean at normal listening
  levels with several stems playing — no crackling, clipping, or harsh
  distortion. If anything sounds rough, note whether it tracks to a
  specific stem type (percussive vs. sustained) and whether more un-muted
  stems make it worse — this engine has an acknowledged quality ceiling on
  transient-heavy material, so the useful signal is *how* it fails, not
  just that it does.
- [ ] **Rig Preset quick-picker:** matches Tone Lab's own dropdown at all
  times; picking a name here applies immediately with no separate Load
  click, and updates Tone Lab's dropdown to match.
- [ ] **Rig preset chain auto-recall:** with a chain already built on Tone
  Lab (Boss 11), reselect the track (or switch away and back) — the last-
  active chain entry is recalled here and on Tone Lab's own chain list.
- [ ] **Auto-calibrate (A/V sync):** requires Input enabled with a real
  instrument first (confirm it says so if not); wait-then-strum produces
  a plausible offset (roughly 50–300ms); deliberately trigger an
  implausible read (strum immediately with no pause) and confirm it says
  so rather than silently applying a bad number.
- [ ] **Manual A/V offset:** as a fallback, record a 5s single-note take,
  find the frame/audio-spike mismatch in QuickTime, enter the ms
  difference by hand — confirm it takes effect the same as auto-calibrate.
- [ ] The A/V offset **persists across app restarts** (per camera setup) —
  confirm by restarting the app and checking it wasn't reset to zero.
- [ ] **Riff Capture:** with your rig active (either rig screen open),
  play something, click **🎸 Save that!** within the ~20s window with no
  prior setup — a WAV lands alongside regular takes, numbered separately
  ("riff 01", …); saving doesn't interrupt the rolling capture (play again
  right after, save again, confirms a second distinct riff file); the
  rolling capture starts whether you opened Tone Lab or Play Along first.

**Loot:** at least one auto-calibrated A/V offset and one saved riff
capture, both surviving into later bosses (Recording, Boss 11).

---

## Boss 11 — The Forge (Tone Lab: input & pedalboard)

*Guards the biggest single feature surface after the Mixer — build a real
rig here and prove every stage of it actually does something.*

- [ ] **Input:** meter and clip light respond to real input level; clip
  light latches until **Clear** or a new input session; the Setup
  disclosure (device + calibration) stays open across uses until you
  collapse it yourself.
- [ ] **Default device memory:** with a USB interface already granted
  permission, Enable Input prefers it over the Mac's built-in mic;
  switching devices and reopening Tone Lab later remembers the last one
  used.
- [ ] **Calibrate (play your loudest chord):** run it, confirm the
  suggested output trim keeps your loudest playing safely below clipping
  afterward.
- [ ] **Icon chain:** one icon per stage (Gate, Amp, all 12 pedals,
  Output) in signal order, wrapping to a second row on a narrow window;
  exactly one panel open at a time; Gate's panel open by default on first
  visit. An icon lights (blue) when unbypassed, dims when bypassed — check
  this updates live both from a manual toggle **and** from loading a rig
  preset later in this boss.
- [ ] **Amp modes:** switch Pass Through → Analog → Neural cleanly, no
  clicks/pops; only the active mode's chain produces sound.
- [ ] **Scroll position on panel/mode switch (real user report — no active
  repositioning):** scroll down while a tall panel is open (Neural mode's
  Amp card is the tallest), then click a much shorter pedal icon (Gate) —
  the scroll position stays exactly where it was; nothing snaps back to
  the icon-chain row. The only exception is the browser's own unavoidable
  clamp when the shorter panel's content ends above the old scroll
  position — that's the page unable to stay scrolled past its own
  bottom, not a deliberate reposition. Same check switching Amp mode
  while scrolled down. Turning a bypass checkbox or moving a slider
  within the SAME already-open panel should never move the scroll
  position at all.
- [ ] **NAM Tweaker:** load a real `.nam` capture — metadata shown honestly
  (including an honest "no metadata" if the file carries none); Drive
  (-24..+48dB) audibly changes distortion character; Bass/Mid/Treble/
  Presence flat by default and audibly shape tone when moved; Output level
  shows an auto-calibration readout for a capture with no loudness
  metadata. Load a parametric/"A2" capture if you have one — confirm the
  honest "not yet supported" message, not a silent misread.
- [ ] **NAM live-overrun guardrail:** if you can find or force a capture
  that clears the offline probe but struggles live, confirm it rolls back
  within ~100ms, restoring the previous rig state with an updated status
  line.
- [ ] **Cab IR:** picking one auto-disables bypass; toggle is audible;
  loudness stays roughly consistent switching between a few different IR
  files (peak-normalized on load, not wildly different depending on source
  gain). **Tone shaper** Low/High cut are audible when unbypassed; Tone
  shape bypass returns to the untouched wide-open IR sound; the dry
  (IR-bypassed) path never changes regardless of these sliders.
- [ ] **Fizzy-capture diagnosis:** load an amp-only (no-cab) NAM capture
  with Cab IR still bypassed — confirm it sounds harsh/fizzy as documented,
  then turn Cab IR on with a matching cab loaded and confirm that
  specifically fixes it (the manual's own troubleshooting claim, verified
  by ear, not just read).
- [ ] **Post-chain EQ/Compressor/Delay/Reverb:** each bypass audible and
  independent; sliders behave as labeled.
- [ ] **All eight extra pedals** — Boost/Overdrive, Graphic EQ, Chorus,
  Flanger, Phaser, Tremolo, Auto-Wah, Octaver — each audible unbypassed,
  transparent bypassed; every knob (Rate/Depth/Mix/Feedback/Drive/Level/
  Blend/Center as applicable) audibly does its labeled job.
- [ ] **Auto-Wah at 100% Mix** is clearly dominant (real dry/wet
  crossfade — no dry underneath at full wet), unlike Chorus/Flanger/
  Phaser's Mix, which always keeps dry at full volume underneath.
- [ ] **Octaver:** a held single clean note tracks a steady one-octave-down
  pitch with no waver/drift across a few different notes and pick
  dynamics; playing a chord through it is expected to get messy — that's
  documented, not a bug.
- [ ] **Tremolo at 100% Depth** chops nearly to silence at the bottom of
  each cycle, not a mild wobble.
- [ ] **Drag-to-reorder:** drag several of the thirteen reorderable icons
  (Amp included) into a new order — the actual signal chain audibly
  changes (e.g. Auto-Wah before vs. after Boost sounds different); Gate
  stays fixed first, Output stays fixed last; specifically drag Amp itself
  in front of a pedal (guitar → pedal → Amp) and confirm it still opens
  its normal panel and behaves correctly there; order persists on reload.
- [ ] **Output:** level slider and meter respond correctly; Output bypass
  forces unity gain regardless of slider position, and the Output icon's
  lit/dim state reflects this bypass exactly like every other stage;
  latency estimate shows on open, labeled honestly as browser-reported,
  not measured (cross-check this matches the top-banner rig status pill's
  own figure from Boss 6 — same underlying number, two surfaces).
- [ ] **Suggest a tone:** with a guitar stem loaded, run it — confirms it
  picks a plausible tone (or nudges Analog's tone stack), skips overly
  heavy captures, and is clearly labeled a rough heuristic.
- [ ] **Rig presets:** Save captures the *entire* rig built above (amp
  mode + Tweaker/tone-stack, IR + tone shaper, EQ/Comp/Delay/Reverb, all
  eight extra pedals, Output, pedal order); Load restores every one of
  those exactly — verify at least 3–4 of the parameters you specifically
  set above actually come back, not just that Load doesn't error.
- [ ] **This song's chain:** add 2–3 saved presets via **+ Add to this
  song's chain**; drag to reorder; click a row to jump live; **✕** removes
  an entry; deleting a preset that's in the chain also removes it from the
  chain.
- [ ] **Cycle keys:** default →/← advance/reverse through the chain,
  wrapping at either end, inert with 0–1 entries and while a text field
  has focus; re-bind either direction via **Change…** (Esc cancels) and
  confirm it's remembered per song; a same-capture swap has no audible
  pop, a different-capture/IR swap takes longer but stays clean.
- [ ] **Arrow-key handoff:** with the Mixer showing, ←/→ nudge the
  playhead; open Tone Lab or Play Along and ←/→ now cycles the chain
  instead — playhead does not also move; closing back to Mixer restores
  the nudge.
- [ ] **Adding amp models/cab IRs:** confirm the two starter NAM captures
  that ship with the app are present and loadable; if you have your own
  `.nam`/`.wav` files, drop them into `GuitarStudio/models/nam/` and
  `models/ir/` (subfolders OK) and confirm they show up in the pickers
  after reopening the panel — no restart needed; search box filters
  across the whole library regardless of folder.

**Loot:** at least one fully-built, saved rig preset with a 2–3-entry
song chain, cycle keys bound and tested, and pedal order rearranged at
least once — this exact rig is what Boss 12 (Recording) and the Final
Boss will actually play through.

---

## Boss 12 — The Chronicler (recording)

*Guards everything that turns a live performance into a file.*

- [ ] Record performance and Takes cards are on Play Along, camera/
  quality/sync Setup expanded by default.
- [ ] **Audio-only take:** with no camera enabled, Record produces `.m4a`/
  `.webm` and the hint says "audio-only" beforehand.
- [ ] **Video take:** enable a camera, confirm the hint switches to
  "will include video," the preview appears only once actually enabled,
  and **Show framing guides** overlays correctly.
- [ ] Record/Stop with and without "start backing track with recording"
  and "start with count-in"; the red **● REC** pill appears in the main
  toolbar during recording and is clickable to jump back to Play Along
  from elsewhere; **Stop also stops the backing track**.
- [ ] Take finalizes (lossless remux), offers **Reveal**/**Discard**; for
  a video take, confirm the A/V offset from Boss 10 is actually applied
  (video and audio line up watching it back).
- [ ] **Takes list:** star/rename/reveal/delete all work; **Play** loads
  into the inline player; **Trim start/end** + **Trim** produces a new
  losslessly-trimmed file without touching the original.
- [ ] **Practice mode (auto-retake on loop):** set a loop + Loop on, check
  "Practice mode" — backing track starts from loop top and records; each
  loop wrap saves the just-finished pass as its own take and starts the
  next recording immediately with no gap in the backing track; play at
  least 3 passes; uncheck (or stop) — the in-progress pass saves as a
  normal take and the manual Record button re-enables. Confirm the manual
  Record button was genuinely disabled the whole time practice mode owned
  the cycle.
- [ ] **Compare two takes:** check two rows to open Compare Takes — both
  play together from the same start point and stay in sync (confirm no
  audible drift over at least 30s); **Listening: A/B** switches which one
  you hear without breaking sync or restarting either; shared seek bar
  scrubs both; a third checkbox is refused until one of the first two is
  unchecked; the card is full-width, not squeezed narrow.

**Loot:** at least one video take with correct A/V sync, one practice-mode
session with 3+ auto-saved passes, and a Compare Takes session run between
two of them.

---

## Boss 13 — The Vault (projects & persistence)

*Guards the promise that nothing you did above evaporates on reload.*

- [ ] Mix (mute/gain/pan/EQ), loop, markers, and rig-preset-attachment
  autosave a moment after changing and restore exactly on reselecting the
  same song.
- [ ] **Rename-following:** save a project, rename the source file in
  Finder, reselect the (now differently-named) track — mix/loop/markers
  still load correctly.
- [ ] The Library shows a small dot next to any track with a saved
  project; confirm it's present on every song you've touched in this run
  and absent on one you haven't.
- [ ] **Full-app persistence sweep:** close the browser tab entirely
  (not just reload), reopen the app fresh, and confirm — the Library
  still lists everything from Bosses 1–12, every song's mix/loop/markers/
  rig-chain-position restores, the Quest Log's progress is unchanged, the
  Molten Obsidian theme choice (if you left it on) is still active with no
  flash of the wrong theme, and the Rip/AI-Assistant/A-V-offset settings
  from earlier bosses are all still there.

**Loot:** a genuinely fresh app launch (new tab, not reload) that comes
back looking exactly like you left it — the real test of "autosave," not
just a same-tab reload.

---

## Boss 14 — The Old Oracle (Rate My Take CLI research spike)

*Guards a command-line tool with no UI — the one boss you fight from
Terminal, not the browser.*

- [ ] Record three real short takes of a part you know well: one tight,
  one deliberately sloppy, one a tasteful variation.
- [ ] Run each through `python3 backing_track.py rate <take.wav>
  "input/<song>.mp3" --offset <seconds>` (pass `--model` only if you
  separated with something other than `bs_roformer_sw`) — confirm each
  prints per-beat scores, an overall closeness percentage, and writes a
  heatmap PNG.
- [ ] Confirm it runs cleanly on a track with no beat grid (falls back to
  fixed 0.5s windows) and reports a clear error (not a crash) on a wildly
  wrong `--offset`.
- [ ] **`--offset-search`:** on a run with only a rough eyeballed
  `--offset`, add e.g. `--offset-search 3` — confirm the refined offset
  and match-quality beat a few manual 0.5s-step attempts at finding the
  tightest heatmap by hand. A deliberately way-off `--offset` (10s+, past
  the search radius) reports low match quality rather than confidently
  "refining" to a wrong answer.
- [ ] **Heatmap scoping:** on a full song with a take covering only a
  short section, confirm the heatmap's x-axis spans just that section
  (not the whole song with a sliver of color lost in gray), the printed
  per-beat table matches, and the overall closeness % is legible directly
  on the image itself.
- [ ] **The actual test:** do the three takes rank tight > variation >
  sloppy? Does the heatmap's red zones line up by ear with where the
  sloppy take actually fell apart? Write down the answer either way — a
  "no" here is a real, useful result at this stage, not a bug to fix on
  the spot.

**Loot:** three ranked, heatmapped takes and an honest verdict on whether
the ranking matched your ears.

---

## Boss 15 — The Watcher (cross-cutting)

*Guards the things that touch every other boss at once.*

- [ ] In-app Help auto-shows on first-ever launch only (re-confirm from
  Boss 0 in this later context — should still not reappear); reachable any
  time via ❓.
- [ ] **Keyboard shortcuts legend (`?`):** lists every current shortcut
  accurately, including Alt for the fine nudge; none fire while a text
  field has focus.
- [ ] **AudioContext resilience:** background the browser tab (switch
  away for a couple of minutes with the app idling, not playing), come
  back — no full-silence lockup requiring a page reload.
- [ ] **Caching:** stems and NAM/IR files load fast on repeat selection
  (no full re-download); a video take's scrub bar seeks correctly
  (Range-request support), including on a take recorded much earlier in
  this same run.

**Loot:** confirmation that none of the last fourteen bosses' worth of
state has quietly poisoned the shared plumbing underneath all of them.

---

## Boss 16 — The Ember Trial (the v5 batch itself)

*The newest boss in the game — everything shipped in this exact build,
fought once more as its own encounter now that everything above it has
been exercised for real.*

- [ ] **Merged import zone, Rip disclosure, cross-links, nav styling, AI
  Assistant auto-collapse** — re-confirm all five cheap/safe fixes one
  more time, specifically checking for interaction with everything you've
  now done in Bosses 1–15 (e.g.: does the AI Assistant card still collapse
  correctly on a song you set Artist/Title for many bosses ago? does the
  Rip disclosure's open/collapsed state survive everything since Boss 2?).
- [ ] **Rig status pill:** across a real session with real clipping (push
  your input hot enough to actually clip at least once during this run)
  — confirm the pill's clipped state matched Tone Lab's own clip light in
  real time, not just in an isolated test.
- [ ] **Quest Log:** by this point in the run every quest should read done
  except possibly "counsel" (Boss 9's AI Assistant is marked `optional`
  since it needs a free API key) — confirm the count reflects that
  honestly, and that a fresh incognito/cleared-storage session shows the
  two live-state quests (summon, awaken) correctly reflecting whether
  *that* session, not this one, has done them.
- [ ] **All three themes:** with the whole app now full of real content
  (multiple songs, a built rig, takes, ratings, cached AI answers), cycle
  through Molten Obsidian, Bright Spark, and Studio one more time and skim
  every screen in each — nothing should look broken, mismatched, or stuck
  in the wrong palette anywhere, now that there's real data everywhere
  instead of an empty state. Bright Spark gets the closest look since it's
  the newest.
- [ ] **Rate My Take / AI Assistant result persistence:** with a rated
  take showing in Rate My Take and an answer showing in at least one AI
  Assistant mode, switch to a song with neither — both results should
  clear, not carry the previous song's content over. Switch back — both
  reappear correctly. (Real user reports on both; fixed together since
  they were the same underlying gap.)

**Loot:** proof that the newest, least-battle-tested code in the app
survives contact with a session's worth of real, accumulated state — not
just a clean empty-state demo.

---

## FINAL BOSS — The Grand Session

*One sitting. No restart. Every system at once. This is the fight the
whole run has been building toward — if anything above was actually
broken, this is where it surfaces.*

Starting from a single fresh song (a new import, not one already used
above), play the entire app end to end in one unbroken session:

- [ ] Import it (drag-and-drop) and separate it with the default model.
- [ ] Build a full mix in the Mixer: mute/fade a part, set a loop, drop
  2+ markers, paint a mute region, add a custom stem, confirm the chord
  lane and detected key look right.
- [ ] Head to Tone Lab: enable input, build a real rig (Neural or Analog,
  at least 3 pedals engaged, at least one dragged out of its default
  order), save it as a rig preset, add it to this song's chain alongside
  a second preset, bind a cycle key and use it live.
- [ ] Move to Play Along: run auto-calibrate for A/V sync, record a real
  video take with count-in and backing track auto-start, then run a
  practice-mode session (2+ auto-retake passes) on a looped section, then
  save a Riff Capture from something unplanned you played in between.
- [ ] Compare two of the takes you just made side by side.
- [ ] In AI Lab: check Scales in Follow mode while the song plays, then
  pin a chord manually; record a dry take and score it in Rate My Take;
  ask for Practice Tips grounded in that score; run at least one of Lick
  Ideas/Ask AI/This Track/This Artist.
- [ ] Back in the Mixer, export the final mix (WAV or MP3, a real output
  name, Normalize on).
- [ ] Toggle the Molten Obsidian theme on mid-session and keep going —
  confirm nothing above breaks or looks wrong once the palette changes
  underneath it.
- [ ] Check the Quest Log (via Help, since a track is loaded) and confirm
  every non-optional quest is now genuinely done, from real actions taken
  in this exact session — not from residual state left over by any
  earlier boss.
- [ ] Check the Practice Log: a real session entry with real elapsed time,
  rate it, add a one-line note.
- [ ] **Close the tab entirely. Reopen the app fresh.** Reload this exact
  song and confirm every single thing above — the mix, the rig, the chain,
  the cycle-key binding, every take, the comparison selection state (or at
  least the takes themselves), the Rate My Take score, every cached AI
  Assistant answer, the export in Exported Tracks, the practice log entry,
  and the active theme — is still exactly there.

**Victory condition:** the entire session above, top to bottom, holds
together after a real close-and-reopen with nothing lost, nothing
silently reset, and nothing visually broken in whichever theme you ended
on. That's the whole app, proven to actually work as one thing — not
fourteen features that each pass in isolation.

If the Final Boss falls clean: ship it. If something gave out here that
every earlier, narrower boss missed, that's exactly what this exercise
was for — note precisely which step broke and in what state, since that's
the reproduction case that matters most.
