# CD-8 — the chord ribbon is too detailed and doesn't follow the chords

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
| genuine triads and dominant 7ths (synthetic, per chord) | 0.45 – 0.51 |
| distorted power chords (synthetic, per chord) | 0.06 – 0.07 |
| distorted power chords (real song, per decoded run) | 0.04 – 0.27 |

**0.2 sat inside the real power-chord population.** Seven of that song's 34
chord runs measured above it and were wrongly promoted to triads or 7ths.
0.3 is the midpoint of the empty band between the two populations
(0.27 → 0.45), leaving genuine thirds a 0.15 margin.

Note the two populations differ by more than the threshold does: real power
chords carry far more third-bin energy than synthesised ones, because bleed
from vocals, lead lines and adjacent chords survives separation. That is
exactly why a constant tuned against synthetic audio was too tight for real
audio — and it is the general lesson of this pass.

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
- **One song.** Every number above comes from one chart. The threshold move
  is justified by the measured gap between populations rather than by that
  song's score, but a second and third chart would make it much stronger.
  `chord_bench.py` takes any song plus a truth file; adding one is cheap.

## Tools left behind

| script | what it does |
|---|---|
| `scripts/chord_bench.py` | runs the real pipeline on a song, scores it against a chart, prints the ribbon the user would see |
| `scripts/chord_sweep.py` | caches the expensive chroma front end once, then re-runs the decode for many parameter combinations in seconds |
| `scripts/chord_regression.py` | five synthetic cases; must stay green |
| `research/chord-truth/*.json` | ground-truth charts |
