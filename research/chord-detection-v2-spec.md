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
| CD-2 | Power-chord template + third-absence gate (§5.1) | S | CD-1 (tune together) |
| CD-3 | Chroma front end: HPSS, tuning, log compression (§5.2) | S | CD-1 |
| CD-4 | Bass-anchored root bonus (§5.3) | S | CD-1 |
| CD-5 | **Acceptance test on "Too Much, Too Young, Too Fast"** + 1–2 easier pop/rock tracks; tune `SELF_TRANSITION_P`, third-absence gate, bass bonus against what the lane shows vs a published chord chart | S | CD-1..4 |
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
