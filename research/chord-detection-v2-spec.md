# Chord Detection v2 — research, spec, and plan

**Trigger (real user report):** the Mixer's chord lane is "way too busy and
doesn't reflect the chords being played." Confirmed by reading the code —
this is exactly what the current design predicts (see §1). Agreed test
song for the rebuild: **"Too Much, Too Young, Too Fast" — Airbourne**, a
power-chord-driven hard-rock track, which is close to the worst case for
the current detector and therefore a good acceptance gate.

Companion ask, specced in §6 and shippable independently: in AI Lab's
per-chord Scales view, the displayed chord (and its scale stack) should
**follow the song as it plays**, instead of staying pinned to whichever
chip was last clicked.

---

## 1. Why the lane is busy and wrong today — a diagnosis, not a mystery

Current pipeline (`detect_chords` in backing_track.py): sum the pitched
stems → one `chroma_cqt` pass → for each beat interval, average the
chroma frames, cosine-match against 36 binary templates (12 roots ×
maj/min/7), take the **independent argmax per beat**, report "N" below a
0.5 confidence floor. The UI (`renderChordLane` / `aiLabChordRuns`)
collapses consecutive identical beats into one chip.

Five compounding problems, roughly in order of visible damage:

1. **No temporal model.** Each beat's argmax is independent. Real
   harmonic rhythm changes every 1–4 bars; chroma noise (a passing note,
   a fill, a bend) flips single beats to a different label, and every
   flip breaks a run into extra chips. This alone accounts for most of
   the "too busy." The literature fixed this in 2003 (Sheh & Ellis's
   HMM): a **self-transition bias + Viterbi decode** — staying on the
   current chord is cheap, changing chords costs — turns flickery
   per-frame guesses into stable regions. Every serious system since
   (Chordino, madmom, the deep-learning apps) has this smoothing layer;
   we are the outlier in not having one.

2. **Vocabulary mismatch on exactly this genre.** There is no
   power-chord ("5": root+5th) template. A5/D5/G5 riffs — i.e. the whole
   test song — get force-labeled maj or min by whichever template the
   overtones lean toward that beat, and since the major-3rd partial of a
   distorted root comes and goes, the label flips between Xmaj/Xmin
   *while the actual chord never changes*. (This is the same physics
   behind the v5 key-detection fix — `key_from_chords`' docstring.)

3. **Lead lines pollute the harmony read.** The chroma source sums
   *all* pitched stems, so the guitar solo's melody notes vote on the
   chord label with the same weight as the actual rhythm part. Mid-solo,
   single-note runs regularly outvote the backing chord.

4. **Beat-level granularity is finer than harmonic rhythm.** One guess
   per beat invites one *mistake* per beat. Chords mostly change on
   downbeats/half-bars; scoring at beat level and letting Viterbi decide
   where changes fall is fine, but 1-beat islands surviving to the UI is
   not.

5. **No tuning/overtone conditioning.** No explicit tuning compensation,
   no harmonic-percussive separation before chroma, no log compression —
   all standard preprocessing in every published pipeline since NNLS
   (2010), all cheap.

None of this is a bug in the code as written — it's the deliberate V4-F1
starter scope ("assistive, best on pop/rock") hitting its ceiling on a
rock library.

## 2. How everyone else does it (research summary)

**The classical lineage** (all open source, all still relevant):
- *Fujishima 1999*: chroma + templates — that's where we are today.
- *Sheh & Ellis 2003 → the HMM era*: same features, plus a transition
  model decoded with Viterbi. The transition model — high probability of
  staying on the current chord — is explicitly what smooths flicker
  ([AudioLabs FMP notebook on HMM chord recognition](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C5/C5S3_ChordRec_HMM.html)).
- *Chordino / NNLS Chroma* (Mauch 2010, [Isophonics](https://isophonics.net/nnls-chroma),
  [GitHub](https://github.com/c4dm/nnls-chroma)): log-frequency spectrum at
  3 bins/semitone → **tuning estimation** → spectral whitening → NNLS
  approximate transcription against a dictionary of harmonic note
  profiles (kills overtone bleed) → chord dictionary → **HMM/Viterbi**
  decode. This was early Chordify's engine and is still the most-used
  open baseline (GPL Vamp plugin; Python access via
  [chord-extractor](https://ohollo.github.io/chord-extractor/), which
  needs a platform-native Vamp host binary).
- *madmom CNN+CRF* (Korzeniowski & Widmer 2016,
  [docs](https://madmom.readthedocs.io/en/v0.16/modules/features/chords.html)):
  learned CNN features + Conditional Random Field decode; a MIREX 2016
  top performer. Note the decode layer is *still* a
  transition-penalty sequence model — deep features changed, the
  smoothing idea didn't. Vocabulary: **maj/min only.** License caveat:
  the trained models ship under a **non-commercial** Creative Commons
  license — a real consideration for our free-distribution goal
  (research/free-distribution-license-audit.md).
- Modern research (MIREX [2024](https://music-ir.org/mirex/wiki/2024:Audio_Chord_Estimation)/
  [2025](https://music-ir.org/mirex/wiki/2025:Audio_Chord_Estimation): CRNNs and
  transformers, plus 2025 novelties like
  [LLM chain-of-thought re-ranking](https://arxiv.org/html/2509.18700v1)
  buying 1–2.7% — diminishing returns territory).

**The proprietary apps:**
- [Chordify](https://navtools.ai/tool/chordify): deep neural network over
  the full mix, chords aligned to a beat grid — the exact product shape
  of our chord lane.
- [Chord ai](https://www.chordai.net/next-level-chord-recognition/):
  in-house deep models running **on-device**, trained on thousands of
  hand-labeled songs; vocabulary maj/min/aug/dim/7/M7/sus2/sus4; markets
  itself as "beyond trained human level."
- [Moises chord finder](https://moises.ai/features/chord-finder/):
  real-time deep-learning chord display on top of their stem separation.

**What results they actually get:** nobody publishes app-level numbers,
but the honest ceiling is public: MIREX majmin chord-symbol-recall for
top systems has sat around **80–86%** for years. Even the best systems
mislabel roughly one beat in six on unseen commercial music — which is
why every one of these apps, like our lane, ships with "assistive,
confirm by ear" framing. The realistic goal is not perfection; it's
*stability and genre-appropriate vocabulary*, which is precisely what
we're missing.

## 3. What "good" means for us

Not a MIREX entry. Success criteria, in product terms:

- On a rock song, the lane shows **the handful of chords the band
  actually cycles through, changing at the rate the band changes them**
  — a chip per chord *event*, not per detection flicker.
- Power-chord riffs read as **A5 / D5 / G5**, not a shimmer of false
  majors and minors.
- Single-note riffs and solos read as the underlying harmony or an
  honest "?" — not as a new chord every beat.
- A user holding a published chord chart for the song should recognize
  the lane's shape (same section boundaries, mostly same roots), even
  when individual qualities differ.

## 4. Options considered

**A. Fix our own pipeline (chosen).** Viterbi smoothing, a "5" template,
bass-anchored roots, HPSS+tuning preprocessing. Zero new dependencies —
`librosa.sequence.viterbi`, `librosa.effects.harmonic`, and our existing
*separated stems* (an advantage none of the generic apps have: we
already know which audio is bass and which is vocals; Chordify has to
infer harmony through the vocals). Expected: fixes the flicker
structurally, fixes the genre mismatch, keeps everything local and
license-clean.

**B. madmom CNN+CRF.** Genuine accuracy jump on maj/min, MIREX-grade.
Costs: heavy install (Cython build, aging release, Python/numpy pinning
friction on end-user machines), **non-commercial model license** vs our
free-distribution intent, and a *smaller* vocabulary than we want (no
power chords, no 7ths). Verdict: not now; keep as a possible A/B
experiment behind a flag once A ships, if A's accuracy still
disappoints. Its decode layer is the same idea we're building in A
anyway.

**C. Chordino via chord-extractor.** Best classical accuracy, but drags
in a per-platform native Vamp host + GPL plugin binary — real
distribution pain for a local web app. Verdict: no; we'd be importing
its ideas (tuning, whitening, Viterbi) with none of its packaging.

**D. Train/port a modern CRNN.** Out of scope for a v5 milestone.

## 5. Spec — Chord Detection v2 (Option A, in `detect_chords`)

### 5.1 Vocabulary: add the power chord
Add `"5": (0, 7)` to `CHORD_QUALITY_INTERVALS`; UI symbol `A5` etc.
(chordSymbol suffix "5"). Guard against "5 eats everything" (a 2-note
template is a subset of both triads, so it cosine-matches broadly): only
let "5" win when the **third is genuinely absent** — energy at the
would-be major- and minor-third bins each below a fraction (constant,
~0.2) of the root+fifth energy. Otherwise the best triad wins as today.
`key_from_chords` needs no change — "5" chords contribute root evidence
and stay quality-agnostic, which is exactly how its v5 fix already
treats power chords by accident.

### 5.2 Front end: cleaner chroma
- Run `librosa.effects.harmonic` (HPSS, margin≈4) on the summed stem mix
  before `chroma_cqt` — strips transient smear (palm mutes, pick attack).
- Pass an explicit `tuning=librosa.estimate_tuning(...)` so a band tuned
  slightly off A440 doesn't smear energy across two bins (we already see
  down-tuned material; Airbourne records around standard, but the
  library won't).
- Log-compress before averaging: `np.log1p(k * chroma)` — stops one loud
  frame dominating a beat window.

### 5.3 Bass-anchored roots
Compute a *second* chroma from the bass stem alone (when present).
Per beat, boost each candidate chord's score by a weighted bonus when
the bass chroma's dominant pitch class equals the chord's root (small
constant bonus, ~+0.1 pre-normalized — tune on real songs). Rationale:
the bass player states the root more reliably than any full-mix feature;
we uniquely have the isolated stem. Skip silently when no bass stem —
same missing-reading contract as everything else in `analyze_track`.

### 5.4 The actual fix: Viterbi decode instead of per-beat argmax
- Keep per-beat template scores for **all** labels (don't argmax).
  Convert to a probability-ish matrix (softmax over labels per beat,
  temperature constant).
- States: 12 roots × qualities + one explicit **N (no-chord)** state
  whose emission is the old confidence floor recast as a probability
  (beats where every template scores badly should *prefer* N).
- Transition matrix: `SELF_TRANSITION_P` (start ~0.9) on the diagonal,
  remainder spread uniformly. One constant to tune; higher = calmer lane.
- Decode with `librosa.sequence.viterbi`. Output format unchanged
  (`{time, root, quality, confidence}` per beat) — confidence becomes the
  decoded state's posterior-ish emission score, so the UI contract and
  the `key_from_chords` consumer don't change at all.

### 5.5 Post-decode cleanup
Merge any decoded run shorter than `MIN_CHORD_BEATS` (2) into whichever
neighbor it matches better — belt-and-braces beneath Viterbi so a
1-beat island can never reach the UI. (Downbeat snapping is *not* in
scope: we have a beat grid but no downbeat detection; guessing bar
phase wrong would move every boundary. Backlog note in §7.)

### 5.6 Unchanged surfaces
- JSON shape, chord-lane rendering, run-collapsing, transposition,
  honesty hint — all untouched. This is deliberately a detector-quality
  change, not a UI change.
- `ANALYSIS_VERSION` bumps (5 → 6) so cached analyses recompute.

## 6. AI Lab: scales that follow the song (independent, ships first)

Today `AiLab.selectedIndex` is set once (chip click, or playhead
position at open) and never moves. Spec:

- New state `AiLab.follow` (default **on** each time AI Lab opens).
- While following and the transport plays, the selected chip is the run
  under the playhead; when the run index changes, the ribbon and scale
  stack re-render. Driven by a throttled (~4 Hz) `aiLabFollowTick(pos)`
  called from app.js's existing `tick()` loop — the same pattern
  `renderTimelineSlider` uses, throttled because the render rebuilds
  innerHTML and 60 fps would be waste.
- **Clicking a chip pins it** (follow turns off) — the current behavior
  becomes the override, not the default. A small **Follow song** toggle
  button (green when active, like Loop/Count-in) sits next to the
  Per chord / Whole song mode toggle; clicking it re-enables following.
- Skipped runs with no confident read ("?" chips) still get selected
  while following — the readout already has honest copy for that state.

## 7. Plan

| # | Milestone | Size | Depends on |
|---|-----------|------|------------|
| CD-0 | AI Lab live-follow (§6) — **shipped** | S | nothing — ship immediately |
| CD-1 | Viterbi decode + min-duration merge (§5.4, §5.5) — **shipped** | M | nothing |
| CD-2 | Power-chord template + third-absence gate (§5.1) — **shipped** | S | CD-1 (tune together) |
| CD-3 | Chroma front end: HPSS, tuning, log compression (§5.2) — **shipped** | S | CD-1 |
| CD-4 | Bass-anchored root bonus (§5.3) — **shipped** | S | CD-1 |
| CD-5 | Acceptance test + gate tuning against real ground truth — **shipped, two passes:** (1) distorted rock ("Too Much, Too Young, Too Fast", chord chart + isolated stems) → the raw-chroma gate fix; (2) simple acoustic ("Mull of Kintyre", A/D/E in 3/4) → the non-bass gate chroma, the phantom-seventh guard, and the drumless beat-grid fallback (see the two "real-song pass" writeups below) | S | CD-1..4 |
| CD-6 | Backlog: downbeat detection → snap chord changes to bar lines; madmom A/B behind a flag; mid-song key changes (already in release-v5-spec §9) | — | — |

**CD-1 shipped:** `_decode_chord_sequence` (Viterbi over an augmented
score matrix with an explicit N state) + `_merge_short_chord_runs`
(belt-and-braces for any 1-beat island that still survives) in
`detect_chords`, backing_track.py. `ANALYSIS_VERSION` bumped 5→6 so
existing cached analyses recompute. Verified with synthetic tests (not
yet a real song — that's CD-5): 12 identical, heavily-noised A5
power-chord beats went from 10 flickering chips under the old per-beat
argmax down to 1 stable chip; a genuine 3-chord progression (A5→D5→E5,
same noise level) still decoded as exactly 3 chips with the correct
roots, confirming the smoothing doesn't just freeze on the first guess.
`CHORD_TEMPLATE_MATRIX`/labels, `key_from_chords`, the JSON shape, and
the UI are all untouched, per §5.6.

**CD-2 shipped:** a `"5": (0, 7)` template plus `_gate_power_chord_scores`,
which suppresses every root's "5" candidate score in place unless both
the minor- and major-third chroma bins sit below
`CHORD_POWER_THIRD_ABSENCE_RATIO` (0.2) of that root's combined root+fifth
energy — the hard "is a third actually being played" check §5.1 called
for, applied before the Viterbi decode so CD-1's smoothing sees a clean
per-beat score matrix either way. `chordSymbol` (app.js) already fell
through to printing the raw quality string for anything it didn't
special-case, so "5" chips render correctly with no UI change; AI Lab's
`AILAB_SCALES_BY_QUALITY` gained a `"5"` entry (minor pentatonic/blues
first, major pentatonic as the other option, since a bare power chord
doesn't commit to a mode). `ANALYSIS_VERSION` bumped 6→7.

Verified with synthetic tests at a noise level scaled to be a modest
fraction of the actual notes played (0.15, vs. CD-1's deliberately
extreme 0.6 flicker-inducing noise — third-absence detection needs the
signal-to-noise ratio a real recording actually has, not a worst case):
a pure power-chord riff decoded entirely as `A5`; a real A major triad
and a real A minor triad both still decoded correctly as `maj`/`min` —
confirming the gate doesn't let "5" cannibalize genuine triads just
because it's a broader match; and the same A5→D5→E5 progression from
CD-1's test now decodes as three correctly-rooted `5` chips instead of
`min`/`maj`/`maj`. Real-song tuning of the 0.2 threshold against actual
guitar tone is still CD-5's job.

**CD-5 finding, first real-song pass ("Too Much, Too Young, Too Fast"):**
power chords were showing up as "7" almost everywhere instead of "5".
Root cause: the gate above only ever suppressed "5" (the "third present"
branch) — it never suppressed maj/min/7 in the "third absent" branch, so
they stayed free to compete anyway. On synthetic bare-root+fifth vectors
that never mattered (nothing else for maj/min/7 to match), but real
distorted guitar carries genuine incidental harmonic/distortion energy
near a flat 7th even on a true power chord (an intermodulation artifact
of playing a root and its fifth through distortion, not a played note) —
and the "7" template (root, 3rd, 5th, b7) is a strict superset of "5"'s
two bins plus that one, so it kept winning on real audio specifically.
Fixed by making the gate symmetric: when a root's third is genuinely
absent, maj/min/7 are now suppressed for that root too, so "5" wins
outright rather than merely being allowed to compete. Re-verified with a
new synthetic test built specifically to reproduce this: a bare power
chord with added b7-bin energy up to 1.2x the root/fifth level still
decodes as "5" at every level tested; real maj/min/7 triads (where a
third genuinely is present) still decode correctly; the CD-1 A5→D5→E5
regression test still holds at a realistic noise level. `ANALYSIS_VERSION`
bumped 8→9.

Two more things flagged from that same first real-song pass — chord lane
reading as noticeably static in places, and AI Lab's Follow mode
appearing stuck on one chord — turned out to be worth revisiting once
real evidence (a chord chart, the actual isolated guitar+bass stems) was
in hand: see the CD-2 real-song fix below. The song genuinely does hold
A5 for very long stretches in its verses (the chart confirms it — "Some
people like to make all the rules" etc. is 8 lines of unchanging A5),
so "static in places" was partly an accurate read, not purely
over-smoothing; `CHORD_SELF_TRANSITION_P` (0.88) is unchanged pending
still-real evidence it needs adjusting.

**CD-2 real-song fix, with a chord chart + isolated stems as ground
truth:** the same track's actual guitar.mp3/bass.mp3 stems (no drums,
no vocals — exactly what `detect_chords` consumes) plus a chord chart
(all power chords: A5/D5/G5/E5/C5, verses holding a single A5 for 8
lines) gave real ground truth to test against, and the "5 mostly reads
as 7" problem was still there even after the fix above. Root cause this
time: the gate's third-absence *ratio* test runs on the same chroma
template matching uses — CD-3's log-compressed chroma
(`np.log1p(10 * chroma)`). log1p is monotonic, so it's safe for
cosine-similarity matching and for `key_from_chords`' minor3-vs-major3
*ordering* comparison, but a RATIO test is a different animal: log
compression inflates a small bin's apparent share of a large bin's
energy well past its real physical proportion. Measured: a genuine power
chord with ~15% real harmonic bleed at the 3rd (clearly "no 3rd" by any
reasonable reading) reads as ~19% after log compression — right at the
gate's 20% threshold, tripping "third present" at bleed levels a real
power chord actually produces. Fixed by giving `_compute_chord_chroma`
a second return value (`chroma_raw`, pre-log-compression) and feeding
that — not the compressed chroma — into `_gate_power_chord_scores`'
ratio test specifically; everything else (template matching, the bass
bonus, `chroma_mean`) keeps using the compressed chroma as before, since
those only need ordering/cosine-similarity, not literal ratios.

Result, on the real stems: quality distribution across the whole song
went from `{'7': 290, '5': 112, 'maj': 16, 'min': 5}` to
`{'7': 77, '5': 339, 'min': 7}` — power chords now dominate as they
should, including two ~35-second stable A5 runs that line up with the
chart's all-A5 verses. Not a perfect match to the chart everywhere (a
handful of "7"/"min" beats remain, and section boundaries are
approximate since this test used a rough beat grid, not the app's real
drum-stem-driven one), but a clear, measured, ground-truth-validated
improvement rather than another synthetic guess. `ANALYSIS_VERSION`
bumped 9→10.

**CD-3 and CD-4 shipped together** (both are chroma-quality changes
upstream of CD-1/CD-2's decode, easiest to land and re-test as one
pass). `_compute_chord_chroma` now runs `librosa.effects.harmonic`
(margin 4) before `chroma_cqt`, passes an explicit
`librosa.estimate_tuning` result into it, and log-compresses the result
(`np.log1p(10 * chroma)`) — the standard NNLS-era preprocessing §5.2
called for, shared by both the main mix and (CD-4) a separately-loaded
bass stem via a new `_beat_windowed_chroma` helper so the two don't
drift apart. `_apply_bass_root_bonus` nudges every chord template whose
root matches the bass stem's dominant pitch class that beat
(`CHORD_BASS_ROOT_BONUS` = 0.12) before the power-chord gate and Viterbi
decode see the score matrix; missing or edge-case bass extraction (a
near-silent stem, an imported pack without one) just skips the bonus
rather than erroring, same contract as every other optional reading in
`analyze_track`.

Verified two ways: a unit test confirmed the bonus lands only on
templates sharing the bass's dominant pitch class and is a genuine no-op
on a silent bass window; an end-to-end test synthesized real audio (not
just template-score vectors) — an A5→D5 power-chord riff with pick-attack
transient noise at each beat plus a separate two-octaves-down bass
sine — run through the full CD-1→CD-4 pipeline (`_compute_chord_chroma`,
windowing, gating, bass bonus, Viterbi decode, run-merge) and got exactly
two stable, correctly-rooted `5` chips out. `ANALYSIS_VERSION` bumped
7→8. Real-song validation (does this actually get more roots right on a
track a guitarist can check by ear) is still CD-5's job.

**CD-5 second real-song pass — simple acoustic ("Mull of Kintyre"),
`ANALYSIS_VERSION` 10→11.** A user reference case — simple beginner
acoustic guitar, A major, I–IV–V (A/D/E), 3/4 waltz — surfaced two real
bugs that the earlier distorted-rock passes structurally couldn't. Both
were found and fixed against the *actual* pipeline (synthesised A/D/E
triad stems run through the real `analyze_track`, ground truth known
exactly), not by code inspection:

1. **The power-chord gate was fooled by the bass → honest triads read as
   bare power chords on every song with a bass guitar.** CD-2's
   third-presence ratio test ran on the full pitched mix, which *includes
   the bass*. The bass plays a chord's root and fifth by default in both
   power chords and full triads, so summing it in inflates the root+fifth
   energy the gate uses as its denominator and buries a genuinely-played
   third below the 20% threshold. Measured on a clean A-major triad: the
   major-third holds **~0.48** of root+fifth energy from the guitar alone
   but only **~0.02** once the bass line is summed in — so the gate that
   correctly saw the third guitar-only completely missed it in the mix and
   forced a `5`. This is the opposite failure to the distorted-rock one
   (there, real power chords were wrongly gaining thirds; here, real thirds
   were wrongly being erased) and it went unnoticed because the rock
   acceptance material *was* mostly power chords. Fix: whether a third was
   *played* is a question about the chord instruments, not the bass, so the
   gate now runs on a **non-bass** chroma (sum of the pitched stems
   excluding bass), computed once per analysis; it falls back to the full
   mix when there's no separable non-bass stem. Template matching, the
   bass-root bonus (CD-4) and `chroma_mean` are unchanged — only the gate's
   ratio test switched source.

2. **Phantom dominant-sevenths from bass overtones → plain majors read as
   `7`.** With the third restored, plain A/D/E majors then decoded as
   A7/D7/E7. Cause: `"7"` (0,4,7,10) is a strict superset of `"maj"`
   (0,4,7), so — exactly like the `5`-vs-`maj` superset problem CD-2
   solves one template down — it out-scores plain `maj` on any incidental
   b7 energy, and a bass root's 7th partial lands right on the b7. On a
   clean guitar-only triad the b7 sits at ~0.004 of root+fifth (a plucked
   string's 7th partial is weak; HPSS/CQT suppress it further) and `A maj`
   beats `A7` 0.99 vs 0.86 — but the bass overtone in the mix flips it.
   Fix: a new `_gate_seventh_chord_scores`, mirroring the power-chord gate,
   suppresses `7` for a root unless the b7 genuinely holds
   `CHORD_SEVENTH_ABSENCE_RATIO` (0.2) of that root's root+fifth energy **in
   the same non-bass chroma**. A *real* dominant 7 (guitar actually plays
   the b7) survives untouched — verified with a synthetic dom7 case that
   still reads A7/D7/E7 — while phantom bass-overtone 7ths demote to major.

Plus a structural gap the acoustic case exposed: **the beat grid — and so
the entire chord lane, which windows per beat — was derived only from the
drums stem.** A drumless song (a fingerpicked piece, a hymn, the quiet
intro before a band enters) produced no beats at all and an *empty* chord
lane. `analyze_track` now falls back to onset tracking on the pitched
stems (a strummed/plucked chord is a fine onset source) when the drums
stem is missing or yields no beats (BT-02 fallback).

Regression coverage (all synthesised, run through the real pipeline):
plain major triads → `A/D/E` (was `A5`/`A7`); minor triads → `Am/Dm/Em`;
true power chords → `E5/G5/A5` (CD-2 preserved); real dom7 → `A7/D7/E7`
(new gate preserved); drumless input → populated lane (was empty). Tempo
tracking coped fine with slow 3/4 (~89bpm detected vs 90 true) — the
feared waltz-vs-4/4 beat-grid problem did **not** materialise, so no
change there.

**CD-7, "Norwegian Wood" pass — chord identity comes off the non-bass mix
entirely; `ANALYSIS_VERSION` 12→13.** Prompted by the user's own diagnosis
that CD-1…CD-6 had "inadvertently over-fitted to the rock and metal songs".
A synthetic Norwegian-Wood-like reference (6/8 compound meter, an E-major
Mixolydian verse, a genuine **E-minor bridge**, a sitar-style tonic drone)
run through the real pipeline exposed the deepest version of the
bass-contamination problem yet: a plain **E major over an E bass decoded as
E minor** — not just at the boundary, a whole sustained E-major chord. Root
cause, measured: the CD-2 and CD-5 fixes moved the *gates* onto the non-bass
chroma, but the actual maj/min/7/5 **template matching** still ran on the
full, bass-summed chroma. A bass note is near-pure root energy, so summed in
it swamps the whole vector — the major-third bin of a clean E major holds
~0.99 of the root guitar-only but collapses to ~0.04 with an E bass added,
at which point random leakage in the minor-third bin (~0.045) outscores it
and `min` wins by a hair. It's the same lesson as the power-chord gate (a
bass buries the third), one level up: it corrupts maj-vs-min, not just
triad-vs-power. Fix: the chroma used for template matching **and** the
whole-song mode chroma `key_from_chords` reads are now the non-bass mix too
(all of `main_windows`, `gate_windows_raw`, and `chroma_mean` come from one
non-bass chroma), so every part of chord *identity* is decided by the chord
instruments; the bass influences only the root, and only through CD-4's
explicit bonus. Falls back to the full mix when there's no separable
non-bass stem.

Verified through the real pipeline: the E-major verse now reads **E** and
the E-minor bridge reads **Em** (the modal shift is caught), the key reads E
major (was E minor), and this *also* cleared a lingering E-major→E-minor
wobble that had shown up in the earlier Mull 4/4 material — while every CD-5
regression still holds (majors→A/D/E, minors→Am/Dm/Em, true power chords→5,
real dom7→7). Compound 6/8 meter tracked fine (no half/double-time blow-up),
so no beat-grid change was needed. **Known remaining hard case, deferred:** a
*sustained tonic drone* (sitar/tanpura/bagpipe/hurdy-gurdy) lives in the
non-bass mix, so this fix doesn't reach it — a constant root+fifth drone
floods every window and reads as one long power chord. The standard remedy
is background/drone subtraction (remove a per-bin temporal-floor percentile
before matching), but it risks eating legitimate pedal tones and shouldn't
be tuned against a synthetic drone that's likely harsher than a real sitar —
so it waits for real drone-heavy audio to validate against, exactly the way
CD-5 waited for real distorted stems.

**BT-03b, "Hotel California" pass — key by profile correlation, not root
count; `ANALYSIS_VERSION` 13→14.** The user's journey back toward rock/metal
started with Hotel California, and its chords decoded flawlessly
(`Bm F# A E G D Em F#` — every one right, minors minor, majors major, on a
full-band mix) — but the *key* came out **E minor** for a plainly **B minor**
song. Root cause was `key_from_chords`' tonic rule: "most frequent chord root
is the tonic". That progression plays its tonic Bm *least* of all (once per
loop) while E (E major + Em both count toward root E) and F# each appear
twice, so root-counting ranked B nearly last and returned a confident wrong
answer — the exact failure the function's own docstring had flagged as
possible. Fixed by finding the tonic the way key-finding actually works:
Krumhansl-Schmuckler correlation of a chord-content histogram (each chord's
pitch classes, beat-weighted) against the 24 rotated major/minor key
profiles. That weighs the whole tonal hierarchy, so B minor wins even though
B is barely played. Verified: Hotel California now reads **B minor** (0.82),
and it also settled "That's Entertainment"'s I-IV two-chord vamp on **C
major** where root-counting had left C and F tied and picked F. Mode still
runs through the CD-2-era direct chroma third-energy check at the chosen
tonic, so power-chord-heavy rock/metal (no thirds in the chords to profile)
keeps reading minor when it is minor — the whole point of the v5 mode work.
Regressions all held (Mull → A major, a minor triad progression → A minor,
Norwegian Wood → E major). This is a `key_from_chords` (BT-03) change; chord
recognition itself was untouched — Hotel California was a chord-lane *pass*
that happened to expose the key heuristic.

**BT-03b addendum, "Holiday" pass — margin-aware key confidence;
`ANALYSIS_VERSION` 14→15.** Stepping back up the tempo, Green Day's Holiday
was the "did the acoustic work break rock?" regression check — and it held:
fast (~145bpm) distorted power chords still read as `5` (F5/Ab5/Eb5/Bb5,
100% power-chord quality), tempo tracked, roots correct. But its *key* read a
confident "Eb major" for an F-minor song. This is not a bug the profile
correlation can fix: a power-chord-only progression has no thirds, so its
pitch content (F, C, Ab, Eb, Bb) fits F minor, Ab major and Eb major almost
identically — the winning profile scores high but with a razor-thin margin
over the runners-up. A first/last-chord tonic bonus was tried and rejected (a
bonus small enough to be safe didn't close Holiday's 0.19 gap; one large
enough would corrupt clear cases). The honest fix is on the *confidence*, not
the answer: scale it by the margin between the top two key profiles
(`KEY_MARGIN_FULL_CONF`), so an inherently-ambiguous power-chord key reports
low confidence ("check / correct this") instead of a confident wrong answer.
Measured: Holiday's key confidence dropped from ~0.79 to ~0.39 while Hotel
California (clear tonal centre, wide margin) stayed ~0.82 and the acoustic
songs kept healthy confidence. Resolving the actual tonic of a thirdless
progression needs cues the chord list doesn't carry (riff/bass emphasis on
the tonic) and is left to the manual key-correction control plus, later,
possibly a bass-root tonic bias validated on real audio.

Test protocol for CD-5 (goes into TEST-PLAN.md when CD-1 lands):
1. Re-run analysis on the test song (version bump forces it).
2. Count chips in one verse+chorus: **expect roughly the chord-event
   count a chart shows (±30%), not 3-5× it** (the current failure).
3. Riff sections should read as X5 power chords with stable roots.
4. Lane vs published chart: section boundaries and roots should mostly
   agree; note disagreements rather than hiding them.
5. AI Lab follow mode: play the song, watch the scale stack change as
   sections change, click a chip mid-song to pin, Follow to resume.

Sources consulted: [MIREX Audio Chord Estimation 2024](https://music-ir.org/mirex/wiki/2024:Audio_Chord_Estimation) / [2025](https://music-ir.org/mirex/wiki/2025:Audio_Chord_Estimation) · [AudioLabs FMP: HMM-based chord recognition](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C5/C5S3_ChordRec_HMM.html) · [Chordino & NNLS Chroma](https://isophonics.net/nnls-chroma) ([source](https://github.com/c4dm/nnls-chroma)) · [madmom chords module](https://madmom.readthedocs.io/en/v0.16/modules/features/chords.html) · [chord-extractor](https://ohollo.github.io/chord-extractor/) · [Chord ai](https://www.chordai.net/next-level-chord-recognition/) · [Moises chord finder](https://moises.ai/features/chord-finder/) · [LLM CoT chord recognition (2025)](https://arxiv.org/html/2509.18700v1)
