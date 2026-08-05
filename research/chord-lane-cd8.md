# CD-8 / CD-9 / CD-10 / CD-11 — the chord ribbon is too detailed and doesn't follow the chords

> **Read the later passes first (bottom of this file).** CD-8 was tuned
> against a single chord chart, for a song that is 100% power chords. The
> moment a chart for a song with *zero* power chords arrived, CD-8 turned out
> to have nearly doubled an error in the one direction its benchmark could
> not see — **CD-9** is that correction. **CD-10** then came from someone
> simply watching the ribbon against the track and noticing the same verse
> annotated two different ways, which no chart had caught. The CD-8 sections
> below are kept as written, because the mistake is the most useful thing in
> this document.
>
> The through-line: every real improvement here came from real audio with an
> answer attached, and every regression came from tuning against a sample too
> narrow to show both kinds of error.


Real-user report, third time on this feature: *"it's still too detailed and
doesn't follow the chords properly."* Previous passes (CD-1 Viterbi
smoothing, CD-2 power-chord template, CD-3/4 chroma front end, CD-5 seventh
gate) each fixed something real and each left this complaint standing.

What was different this time: a **ground-truth chord chart**. The user
supplied Airbourne's *Too Much, Too Young, Too Fast* as an mp3 plus the
Ultimate Guitar chart as a PDF. That turns "too detailed" from a matter of
taste into a measurement, and it is the reason this pass found a structural
bug the previous four didn't.

## The ground truth

Key A. Five chords in the whole song, **all power chords**: A5, D5, G5, E5,
C5. Both verses are a single held A5 — eight lyric lines each with A5 written
over every one. The pre-chorus is G5 → E5 → G5. The chorus moves
D5 A5 / G5 D5 A5. C5 appears once, in the outro. Roughly 30 chord changes in
3 minutes 42 seconds.

A song that spends 35 seconds at a time on one unchanging chord is the
sharpest possible test of "too detailed".

Stored as `research/chord-truth/airbourne-too-much-too-young-too-fast.json`.

## What the shipped code did

All figures below are from the shipped code, via
`scripts/chord_bench.py --ribbon`.

| | before (v14) | after (CD-8) | chart |
|---|---|---|---|
| chips drawn | 89 | **35** | ~30 changes |
| distinct chord names | 19 | **10** | 5 |
| distinct roots | 8 | **5** | 5 |
| phantom roots | B, F, F# | **none** | — |
| changes that were quality-only | 29 of 88 (**33%**) | 1 of 34 (**3%**) | 0 |
| mean run | 4.7 beats | **11.9 beats** | — |
| median chip | 2.1 s (one bar) | **3.7 s** | — |
| verse 1 | 11 chips | **1 chip, 34.7 s of A5** | one A5 |

The verses are the headline. The chart says one chord; the old ribbon drew
eleven chips across verse 1, cycling A5 → Am → F → A5 → A → A5 → Am → E →
A5 → Bm → E. The new one draws a single 34.7-second A5 chip — and so does
verse 2, at 34.7 s as well.

The ten distinct names are five correct roots wearing the wrong suffix some
of the time: **A5 D5 G5 E5 C5** (all five chart chords, all present) plus
**A, Am, D, D7, E** — quality errors on roots that are right. No wrong root
appears anywhere in the song.

The two pre-choruses also come back **identical** to each other (G5 → E5 →
A5) and the two verses come back the same length (34.7 s each), which is a
useful sanity signal: the song's real structure now shows through the ribbon
instead of being buried in noise.

## Two root causes

### 1. A third of every "chord change" was not a chord change

Splitting the old ribbon's 88 transitions by whether the ROOT changed:

```
chord changes total:            88
  same root, quality only:      29  (33%)
  genuine root change:          59
```

Twenty-nine times, the ribbon told the user the chord had changed when only
the *label* had — A5 → A → Am → A7 across one sustained A5.

The cause is structural, not a mis-set threshold. The CD-2/CD-5 gates are
hard ratio tests, and they suppressed losing templates by setting their score
to `-1.0` — deliberately below the entire possible range of a cosine
similarity, so that "a gated candidate can never win". At
`CHORD_EMISSION_TEMPERATURE = 12` that is an **absolute veto**: the emission
gap it creates is ~18 in log-probability, while the Viterbi transition prior
was worth only ~5.9. No amount of accumulated evidence on either side of a
beat could overrule one beat's threshold crossing. So every time distortion
harmonics nudged the third-bin ratio across the line — which on a held,
unchanging power chord happens constantly — the ribbon *had* to change chord,
however sticky the decode was. CD-1's smoothing was being silently overruled
by CD-2's gate.

### 2. Deciding root and quality together let the weak evidence break the strong

The old decode was one Viterbi over 49 states — every (root, quality)
template plus N. Two problems with that:

- A root is far better evidenced than a quality. Root+fifth is most of a
  chord's energy; the third is one quiet bin that distortion, bleed and a
  passing vocal all land on. Deciding both at once let the noisy half break
  runs the reliable half agreed about.
- With 49 states the switch-away probability spreads over 48 competitors, so
  any single harmonically-overlapping phantom is individually cheap to jump
  to. F, F#m and Bm all contain the A of a held A5, and all three won beats.
  Over 12 root states that jump costs four times as much — and every one of
  those phantoms disappeared.

## The fix

Three changes in `detect_chords`:

1. **Decode the root sequence first**, over 13 states (12 roots + N), on
   **ungated** template scores. Each root's per-beat evidence is its
   best-fitting quality's score. The gates answer "which quality", which is
   not this stage's question. CD-4's bass root bonus is root-level evidence,
   so it still applies.
2. **Name each decoded root run once.** Quality is picked per beat and then
   held to a minimum stretch of `CHORD_MIN_QUALITY_RUN_BEATS` (8 — two bars);
   anything shorter is absorbed into its better-fitting neighbour. In
   practice this returns one quality per run, so a held chord *cannot* change
   name mid-hold, while a sustained, decisive change can still split it.
3. **The gates penalise instead of vetoing.** `-1.0` became
   `-CHORD_GATE_PENALTY` (0.35) — still decisive for a single beat, but
   finite, so surrounding evidence can overrule an isolated crossing. The
   sentinel's other job (stopping a gated candidate beating the N state) is
   no longer needed: N is decided in the ungated root stage.

Plus one threshold change, on a measurement rather than a preference.

### `CHORD_POWER_THIRD_ABSENCE_RATIO`: 0.2 → 0.3

The gate asks whether a third is present, as a fraction of root+fifth
energy. Measuring both populations it has to separate:

| | third / (root+fifth) |
|---|---|
| genuine triads and dominant 7ths (**synthetic**, per chord) | 0.45 – 0.51 |
| distorted power chords (**synthetic**, per chord) | 0.06 – 0.07 |
| distorted power chords (**real**, Airbourne, per decoded run) | median 0.15, 75th 0.24, 90th 0.30 |
| triads and 7ths (**real**, Gary Moore "Empty Rooms", per run) | median 0.32, 25th 0.17, 75th 0.66 |

**0.2 sat inside the real power-chord population** — seven of Airbourne's 34
chord runs measured above it and were wrongly promoted to triads or 7ths.
0.3 sits between the two real medians (0.15 and 0.32).

> **Correction to this document's first version.** It originally justified
> 0.3 as "the midpoint of the empty band between the populations
> (0.27 → 0.45)", where 0.45 came from the *synthetic* triads. That was the
> same mistake this whole pass exists to warn about, made in the same
> commit. Real triads are nothing like synthetic ones: Empty Rooms' triad
> runs have a median third ratio of **0.32**, not 0.45–0.51, and its 25th
> percentile is 0.17 — well inside where Airbourne's power chords live.
> **The two real populations overlap.** There is no empty band.

Given that overlap, 0.3 is a trade-off rather than a clean separation, and
the trade was measured rather than assumed. Power-chord share of beats:

| third ratio | Empty Rooms (triads) | Airbourne (chart says 100% power) |
|---|---|---|
| 0.15 | 18% | 51% |
| 0.20 (old) | 42% | 74% |
| 0.25 | 43% | 87% |
| **0.30** | **47%** | **90%** |
| 0.35 | 55% | 96% |

Moving 0.2 → 0.3 costs Empty Rooms 5 points and gains Airbourne 16, against
the only chart available. Only 0.15 substantially spares Empty Rooms, and it
would wreck Airbourne. So 0.3 stands on present evidence — but it is a
*balance point between two overlapping distributions*, not a safe margin,
and it is the single least-supported decision in this pass. **A triad-based
song with a real chord chart settles it; nothing else will.**

The deeper problem this exposes: a fixed global ratio is being asked to
absorb how distorted and how dense a given recording is, which varies far
more between songs than between chord types within a song. A per-song
adaptive threshold (or judging a root's third against that song's own
third-energy distribution) is the likely direction, but that needs more
than two songs of evidence before it is worth building.

## Why four previous passes missed it

`scripts/chord_regression.py` renders five known progressions and runs the
real pipeline over them. **The shipped v14 code passed all five.** Triads
read as triads, sevenths as sevenths, distorted power chords as power chords,
a held chord as one chip.

Synthetic audio has no vocals, no bleed, no two chords ringing into each
other, and a third that is either fully present (0.45+) or fully absent
(0.06). Nothing in it lands near a threshold, so nothing in it can expose a
threshold set in the wrong place — or a veto that is too absolute, because
nothing ever wavers across the line. The suite is still worth having; it
caught a real regression during this very pass (see below). It just cannot
answer the question the user was asking.

**A synthetic suite proves you didn't break the easy cases. Only real audio
with a chart tells you whether the hard ones work.**

## The regression the suite did catch

The first version of the run-naming step used the median chroma over the
whole run. That immediately broke `major_minor_same_root`: on a held A that
genuinely alternates A major and A minor, the median of the major-third bin
and the median of the minor-third bin are *both* low — each is near zero for
half the beats — so the run read as a thirdless **A5**, an answer neither
half of the run supports. Replacing the median with per-beat picks plus a
minimum-stretch rule fixed it.

## Known limitations, stated plainly

- **The real-song numbers come from surrogate stems.** Demucs weights are
  blocked by this environment's egress policy, so `chord_bench.py`
  fabricated stems from the mix by HPSS plus a 200 Hz crossover. Those
  "stems" still contain the vocal, which real separation removes — so the
  third-bin pollution measured above is, if anything, *worse* than what the
  app sees, which makes 0.3 conservative in the right direction. The root
  and chip-count results should be re-checked against real Demucs stems when
  that is possible. The structural findings (33% of changes being
  quality-only; the veto arithmetic) are separation-independent.
- **Ten distinct names, not five.** Quality is still wrong some of the
  time — `A`/`Am` where the chart says `A5`, `D`/`D7` where it says `D5`,
  `E` where it says `E5`. Every one is on a *correct root*, and the three
  worst offenders sit near the outro where the measured third ratio really
  is high (0.43, 0.70, 0.97 — genuinely third-heavy, most likely lead and
  vocal bleed in the surrogate stems). Quality on distorted guitar remains
  the weakest part of this feature; the root layer is now solid.
- **Alternating two-bar maj/min on one root is under-segmented.** The
  synthetic case returns 2 chips where 4 were played; both labels are
  correct, but the second alternation is merged away. A direct consequence
  of the two-bar minimum, and the price of the flicker fix.
- **One chart.** Accuracy numbers come from a single annotated song. The
  threshold discussion above says how far that goes and where it stops.
  `chord_bench.py` takes any song plus a truth file; adding one is cheap.

## Generalization check, without charts

`scripts/chord_ab.py` runs both decodes over identical cached chroma and
reports the chart-free signal: the share of chord changes where the root did
not change and only the label did. Real music changes chord by changing
chord, so that share is a defect rate whatever the song.

| song | version | chips | mean run | quality-only changes |
|---|---|---|---|---|
| Airbourne — Too Much, Too Young, Too Fast | v14 | 89 | 4.7 | 29 (**33%**) |
| | CD-8 | 35 | 11.9 | 1 (**3%**) |
| Gary Moore — Empty Rooms | v14 | 111 | 5.2 | 21 (**19%**) |
| | CD-8 | 67 | 8.5 | 1 (**1.5%**) |

Two different songs, two very different styles, same result: the flicker is
gone and the ribbon roughly halves. Importantly this part is
**threshold-independent** — Empty Rooms draws 67 chips at *every* value of
CHORD_POWER_THIRD_ABSENCE_RATIO from 0.15 to 0.35, because the threshold
only renames chords, it does not segment them. So the segmentation and
flicker wins belong entirely to the architecture change and carry no part of
the threshold's uncertainty.

Empty Rooms' distinct-name count went UP (15 → 18) while its chip count
halved. That is consistent with real chord variety surfacing once runs stop
fragmenting, but with no chart it cannot be confirmed either way.

Two further songs (Avenged Sevenfold "Afterlife", Iron Maiden "Phantom of
the Opera") were queued and did **not** complete — the front-end cache build
on the longer of them ran past an hour and the job hit its timeout. Both are
power-chord metal, i.e. the same direction as Airbourne and the least
informative of the four, so this was not pursued further. If they are ever
run, note that building a cache for a ~7-minute track is very slow and wants
its own generous timeout.

> Methodology note, recorded because it bit twice in one session: waiting on
> that job with `pgrep -f chord_ab.py` was useless, because the waiting
> shell's OWN command line contains that string, so the pattern always
> matched itself and the wait could never end. The same self-match wasted a
> measurement earlier in this project (`pgrep -f "/opt/pw-browsers/chromium"`
> matching the agent's own command line during the tone-search leak hunt).
> Match on `ps -eo args` with an explicit exclusion, or on a pidfile.

## Tools left behind

| script | what it does |
|---|---|
| `scripts/chord_bench.py` | runs the real pipeline on a song, scores it against a chart, prints the ribbon the user would see |
| `scripts/chord_sweep.py` | caches the expensive chroma front end once, then re-runs the decode for many parameter combinations in seconds |
| `scripts/chord_regression.py` | five synthetic cases; must stay green |
| `research/chord-truth/*.json` | ground-truth charts |

---

# CD-9 — the correction, from a chart with no power chords in it

CD-8 shipped on one chart. That chart (Airbourne) is **100% power chords**,
so it could measure one error — calling a power chord a triad — and was
structurally blind to the opposite one. Predictably, that is where the
damage was.

## The second chart

Gary Moore, *Empty Rooms*. Key Dm, 99 bpm, thirteen chord shapes:
Dm, C/D, Bb, C/Bb, C, F, Gm, Am, G, Em, E, Bb/D, D. **Not one power chord.**
Slash chords are scored as their upper triad (C/D → C), since the ribbon has
no slash vocabulary and naming the upper structure is the right answer for it.

Stored as `research/chord-truth/gary-moore-empty-rooms.json`.

Scored against it (power-chord share of beats; the chart says 0%):

| | Airbourne "5" share (chart 100%) | Empty Rooms "5" share (chart 0%) |
|---|---|---|
| v14 (before any of this) | 52% | 27% |
| **CD-8** | 90% | **47%** |
| **CD-9** | **94%** | **32%** |

CD-8 nearly doubled the false-power-chord rate on triad material. It looked
like an unqualified win only because the one song being measured had no
triads in it to get wrong.

## What was actually wrong with CD-8

CD-8's own fix — decide quality once per root run — was right. Its mistake
was *how* it decided: it ran the gates per beat and then let the min-run rule
majority-vote the result across the run. That takes the weakest evidence in
the whole pipeline (one quiet chroma bin, over 0.5 s) and turns a near-tie
into a confident, whole-run answer.

CD-9 separates two questions that want answering at different timescales:

| question | kind | decided |
|---|---|---|
| is a third / a b7 present at all? | **detection** of a weak signal | **once per run**, on the run's aggregated (median) chroma |
| major or minor? | **choice** between two strong alternatives | per beat, held to a two-bar minimum |

Integration is what a weak-signal detection needs and a majority vote is a
poor substitute for it. With that split, the per-beat gates disappear
entirely, and with them CD-8's `CHORD_GATE_PENALTY` — the finite-penalty
mechanism only existed to soften a per-beat veto that no longer happens.

Also measured and **rejected**: a background-relative third test (third
energy vs the median of that root's non-chord-tone bins), which self-
calibrates to how dense a mix is. It scored 80.4 against the simple ratio's
81.2 — no better, and more machinery. Recorded so nobody re-derives it.

## The threshold, set honestly this time

`CHORD_POWER_THIRD_ABSENCE_RATIO` has now been set three times, twice badly:

- **0.2** — from synthetic audio.
- **0.3** (CD-8) — justified as the midpoint of an "empty band" between
  synthetic triads (0.45–0.51) and real power chords (0.04–0.27). The 0.45
  came from a synthesizer. Real triads sit at a median of **0.32** with a
  25th percentile of **0.17** — on top of where real power chords live.
  **The two real populations overlap; there is no empty band.**
- **0.25** (CD-9) — not a separation point but a *balance* point, measured
  against both charts at once:

| ratio | Airbourne "5" (want 100%) | Empty Rooms "5" (want 0%) |
|---|---|---|
| 0.15 | 69% | 16% |
| 0.20 | 83% | 23% |
| **0.25** | **94%** | **32%** |
| 0.30 | 97% | 43% |
| 0.40 | 97% | 64% |

Tuned on the power-chord song alone this drifts up; on the triad song alone
it would drift down just as wrongly. **Do not move it against one song.**

`CHORD_SEVENTH_ABSENCE_RATIO` was deliberately **left at 0.2**, even though
raising it visibly cleaned up both benchmark songs — because both charts
contain zero dominant sevenths, so that evidence can only push it one way.
That is the same overfit one constant up. Hotel California uses F# and F#7 in
the same song and is the case that settles it; its chart is already in
`research/chord-truth/`, its audio is not.

## Where CD-9 leaves the feature

| | Airbourne | Empty Rooms |
|---|---|---|
| chips | 89 → **34** (chart ~30 changes) | 111 → **67** |
| distinct names | 19 → **7** (chart has 5) | 15 → 19 (chart has 10) |
| quality-only flicker | 29 → **0** | 21 → **1** |
| power-chord share | 52% → **94%** (chart 100%) | 27% → **32%** (chart 0%) |
| roots | all correct, no phantoms | all correct, no phantoms |

**The root layer is solid on both songs and always has been.** Every
remaining error is quality. On Airbourne the ribbon is now nearly right. On
Empty Rooms it is much more readable than v14 and much less flickery, but a
third of its chips still claim a power chord that is not there — worse than
v14's 27% on that one metric, better than CD-8's 47%.

That is the honest state: CD-9 is a large net improvement and an incomplete
fix, and the incompleteness is concentrated in exactly one place.

## Known confound in the Empty Rooms numbers

They come from **surrogate stems**, not Demucs (weights are blocked by this
environment's egress policy). `chord_bench.fabricate_stems` splits the mix
with HPSS plus a **200 Hz crossover**, calling everything below it "bass".

An open Dm voicing has its root at D3 = **147 Hz**, so the surrogate feeds
the low half of the rhythm guitar into the bass stem — which chord identity
deliberately excludes — while real separation would keep the whole guitar in
`other`. The obvious hypothesis was that this was inflating the residual
error, and that a LOWER crossover would help.

**It was measured, and the hypothesis was wrong in the direction it
predicted.** Rebuilding the surrogate at three crossovers:

| crossover | Empty Rooms "5" share (chart 0%) | chips |
|---|---|---|
| 100 Hz | **59%** | 83 |
| 200 Hz (all results above) | **32%** | 67 |
| 300 Hz | **29%** | 62 |

Lowering the crossover nearly doubled the error. The dominant effect is not
losing the guitar's low notes — it is **bass leaking into the harmony
stem**. A bass note is near-pure root energy, so it inflates root+fifth,
drives the third ratio down, and manufactures power chords: exactly the CD-7
bass-contamination failure already documented in `detect_chords`,
resurfacing through the test rig instead of through the pipeline.

The important part is the *shape* of that curve. 100 → 200 Hz buys 27
points; 200 → 300 Hz buys only 3. It is flattening, and real Demucs stems
(zero bass in `other`, and the guitar's low end intact) sit past the flat
end of it. So the honest reading is that **most of the residual ~30% is the
algorithm, not the bench** — real stems should be worth a few points, not
thirty. This rules out the comfortable explanation rather than supporting
it.

The false power chords are also spread through the song (38% / 39% / 18%
across thirds) rather than clustered in the solos, so lead-guitar bleed is
not the main cause either.

Note that no CD-9 result above needs restating: every number was measured at
a consistent 200 Hz for both songs, so the v14 / CD-8 / CD-9 comparison is
unaffected. This only settles how much of the remainder is blameable on the
test rig, and the answer is: not much.

---

# CD-10 — the same verse, annotated two different ways

The sharpest bug report of the three, and the one that needed no chart at
all. Watching the ribbon against the track:

> *"empty rooms 00:15 to 00:34 is the same chord progression as 00:35 to
> 00:48 but is annotated differently in the chord ribbon and this
> inconsistency repeats e.g. 1:08 to 1:27"*

Reproduced immediately on the CD-9 output:

```
0:14.4 – 0:28.8   D5          1:07.4 – 1:21.3   Dm
0:28.8 – 0:33.6   A#          1:21.3 – 1:26.1   A#
```

Same music, same root, different quality. This is not a new defect — it is
the CD-9 residual ("32% of a no-power-chord song reads as power chords")
wearing the form a user can actually see. A percentage in a research note is
easy to discount; a verse that says D5 the first time round and Dm the second
is obviously wrong to anyone listening.

## The app already knew

`detect_sections` on the same song:

```
0:14.0 – 0:43.1   label B
1:02.2 – 1:34.3   label B      <- the same letter
```

Both stretches the user flagged are already labelled **B**. The structure
detection had the answer the whole time; the chord lane never asked it.

## The fix

The two presence tests — *is a third there at all*, *is a b7 there at all* —
now pool their evidence per **(section label, root)** rather than per run.
Every occurrence of a root inside every repeat of that section contributes to
one decision. Repeats become consistent by construction, and the weakest
signal in the pipeline gets several times more audio to judge from.

`detect_sections` therefore runs **before** `detect_chords` in
`analyze_track`. It was already computed for every track, so this costs
nothing; with no section reading available, the pooling falls back to
per-root across the whole song, which is still wider than per-run.

**maj-vs-min is deliberately not pooled.** A song is allowed to move between
major and minor, and that is a choice between two strong alternatives rather
than the detection of a weak one.

## Result — every metric improves at once

| | repeat self-contradictions | distinct names | power-chord share | chips |
|---|---|---|---|---|
| Airbourne CD-9 | 1 | 7 (chart 5) | 94% (chart 100%) | 34 |
| Airbourne **CD-10** | **0** | **6** | **96%** | 34 |
| Empty Rooms CD-9 | 15 | 19 (chart 10) | 32% (chart 0%) | 67 |
| Empty Rooms **CD-10** | **6** | **15** | **28%** | 67 |

No trade-off — unusual for this feature, and the reason it was worth doing.
Synthetic regression stayed 5/5 green, including `major_minor_same_root`,
which pooling could plausibly have broken and does not, because it only
pools the presence tests.

## A metric that needs no chart

**Repeat-consistency**: for each (section label, root), how many *different*
qualities that root was given across every occurrence of that repeated
section. One is correct. Anything more is the ribbon contradicting itself
about music that repeats — a defect whatever the right answer turns out to
be.

This joins "quality-only flips" (CD-8) as a chart-free defect signal, and it
is the better of the two: it caught something a chord chart had not, on a
song whose chart we already had. Charts are scarce; repeats are free.

---

# CD-11 investigation — uneven chip spacing early in a song (NOT FIXED)

> *"hotel california from 1:21 on looks spot on but the first part is screwy
> wrt to the spacing of the chords over the bars, they should (I think) be
> all equal length"*

Correct instinct: that song puts one chord per bar throughout, so the chips
should be equal. The symptom reproduces on the 62-second solo excerpt we
have, in chip lengths measured in beats:

```
early:  13, 8, 24, 8, 8       <- 2 to 6 bars each, uneven
late:    4, 4, 4, 4, 4, 4, 5  <- one bar each
```

**When the evidence is good the pipeline already lands on bar lines** — the
late chips are exactly 4 beats, and the beat grid is 99.4 bpm, which is right
for this arrangement (chord changes measured every 2.40 s = 4 beats; the
chart's 74 bpm belongs to the studio version, which is in a different key
too — see the truth file).

## What was ruled out

| suspect | test | result |
|---|---|---|
| beat grid unsteady | interval coefficient of variation | 0.009 — rock steady (a bad grid is >0.05) |
| drums-free intro | silenced the drums stem for the first 15 s and 30 s | grid stays steady; beats simply start later (91 → 77 → 51). A drumless intro produces **missing** chords, not unevenly spaced ones |
| root prior too sticky | swept `CHORD_ROOT_SELF_TRANSITION_P` 0.88 → 0.96 | **zero effect** on this song — identical 12 chips and identical lengths at every value |
| lead swamping the mix | ran identity from `other` alone (no lead) | early merging got *worse* (one 61-beat run), late part identical |

So it is not the grid, not the drums, not a tuning constant, and not stem
choice. In that passage the chroma genuinely holds one root for 24 beats —
the evidence itself is flat, and no decode parameter can invent a chord
change that the audio does not show.

## Where this points

Chip lengths being multiples of a bar when evidence is strong suggests the
real improvement is **bar/downbeat awareness**: score chord evidence per bar
rather than per beat, and prefer run boundaries on bar lines. That would make
"equal length where the music is equal length" structural rather than
incidental.

Deliberately not built yet. It needs downbeat estimation the pipeline does
not currently do, and it must be measured across all three charted songs
before shipping — Empty Rooms changes chord twice per bar in places, so a
naive snap-to-bar would damage it. Given this pass's history of tuning
against too narrow a sample, that is not a change to make on one 62-second
excerpt.

## Honest limit on this investigation

The excerpt available here is 62 s of the guitar solo, in D minor, from a
different arrangement than the chart. The user's observation is about the
**full song**, whose first part is a sparse arpeggiated intro rather than a
solo. The symptom is the same shape and the ruled-out list above is general,
but the specific cause at their 1:21 boundary is **not confirmed**. Full-song
stems (drums + bass + other, 22.05 kHz mono is fine) would settle it.
