# Song-Section Detection (BT-20) — research, spec, and first build

## 1. What this is (and isn't)

A **section ribbon**: a coarse map of a song's structure — one colored,
labeled block per section, drawn above the chord ribbon, click to jump.
Repeated parts share a letter and a color (both verses are **A**/blue, both
choruses **B**/green), so "this bit comes back later" is visible at a glance
and you can jump to / loop the part you want to practice.

It is **not** a verse/chorus transcriber. Labels are **A/B/C… by
repetition**, deliberately *not* "Intro/Verse/Chorus/Solo". Semantic names
need reliable repetition-counting + loudness/position heuristics that
mislabel more than they help on real songs, and a confident wrong "Chorus"
reads worse than an honest "Section B". Same assistive-not-authoritative
framing the chord lane and key detection already carry.

## 2. How the field does it (research summary)

The standard music-structure-analysis (MSA) recipe, stable since Foote
(2000) and used through MSAF/librosa's own structure examples:

1. **Beat- or time-synchronous features.** Two complementary families:
   **timbre** (MFCC — catches instrumentation/texture changes: drums or
   vocals entering, a solo) and **harmony** (chroma — catches a chorus that
   differs from the verse by its chords). Stack them.
2. **Self-similarity matrix (SSM)** — cosine similarity of every feature
   frame against every other. Repeated sections show as off-diagonal
   stripes; homogeneous sections as bright diagonal blocks.
3. **Foote novelty** — slide a Gaussian-tapered checkerboard kernel down
   the SSM diagonal; it peaks exactly where the block structure switches.
   Peaks = section boundaries.
4. **Labeling** — cluster the segments between boundaries by mean-feature
   similarity so repeated material gets the same label.

Alternatives considered: librosa's Laplacian segmentation (McFee & Ellis
2014) is cleaner but wants a target segment count `k`; `madmom`/deep models
are heavier and add a dependency. Foote novelty auto-finds boundaries with
no fixed `k` and is a few dozen lines on top of librosa primitives we
already use — the right fit for a first cut.

## 3. Spec — `detect_sections` in `backing_track.py`

Returns a list of `{start, end, label}` regions (times in seconds, labels
"A"/"B"/…), or `None` (a fine "no reading", never fatal — same contract as
every other `analyze_track` field). Stored under the analysis `sections`
key; `ANALYSIS_VERSION` 11→12.

### 3.1 Full mix, on purpose
Chroma for chords deliberately *excludes* drums and vocals; sections do the
opposite and sum **every** stem. Instrumentation and texture changes — the
drums dropping out for a breakdown, vocals entering after an intro, a
guitar solo — are exactly the cues a boundary rides on.

### 3.2 A fixed ~1s grid, not a beat grid — the key first-cut decision
Beat-synchronous features are the textbook default, but they depend on the
beat tracker covering the whole song, and it doesn't: on a track with drums
only in the choruses, or a long drumless intro (Mull of Kintyre again), the
beat grid has no beats in the quiet parts — so that whole passage collapses
into a single feature column and can't be seen as its own section. This was
verified, not assumed: on a synthetic quiet-intro track the first
beat-synced column spanned 0→19s and the real opening section was invisible.
A uniform ~1s time grid has no blind spot, its time-mapping is trivial
(column *j* starts at *j × window*), and at 1s resolution it's easily fine
for the coarse boundaries this reports. Tempo-invariance (beat-sync's main
win) barely matters for section-scale structure.

### 3.3 Real-music floors, not raw peaks
- **Minimum section length** (`SECTION_MIN_SECONDS`, 8s): a 5-second
  "section" is a fill or a single loud hit, not structure — merged away by
  dropping the weaker (lower-novelty) of its two bounding boundaries until
  every survivor clears the floor.
- **Same-label neighbors merge** into one run (a boundary the novelty found
  *inside* what turns out to be one kind of section).
- **Label cap** (`SECTION_MAX_LABELS`, 8): past this, "structure" is noise.

### 3.4 Tunable constants (all in `backing_track.py`)
`SECTION_WINDOW_SECONDS` (grid resolution), `SECTION_MIN_SECONDS`,
`SECTION_KERNEL_HALF_SECONDS` (Foote timescale), `SECTION_NOVELTY_DELTA`
(peak-pick threshold), `SECTION_LABEL_SIM` (same-letter cosine threshold),
`SECTION_MAX_LABELS`. These are the knobs the real-song validation pass
(§5) will dial in.

## 4. UI — the section ribbon (`renderSectionLane`, `app.js`)
A new `#section-lane` row in the sticky timeline header, one row above the
chord ribbon, same `viewWindow()`/`timeToPct()` layout model. One
`.section-block` per section, positioned/widthed by time, colored by a fixed
palette keyed to the section letter (every A one hue, every B another —
`SECTION_COLORS`), labeled with the letter, click to seek to its start,
tooltip with the clock range and the honesty note. Hidden entirely
(`display:none`) when the analysis has no `sections` key — same
graceful-omission contract as the chord lane. Re-rendered on
zoom/scroll/select, but not on Tune (sections don't transpose).

## 5. Verification done, and what's left for real songs

**Verified headlessly against the real pipeline** (synthetic multi-section
track — quiet verses alternating with full-band choruses plus a contrasting
bridge, structure A B A B C, run through the actual `analyze_track` and the
live UI):
- Boundaries landed within ~1–3s of ground truth (18.0 vs 19.2, 40.9 vs
  38.4, 58.9 vs 57.6, 79.9 vs 76.8).
- **Repeat structure captured exactly**: both verses labeled A, both
  choruses B, the bridge C.
- The ribbon renders in the live app with the right blocks, positions, and
  per-label colors (both A's one color, both B's another), no console errors.

**Left for the real-song validation pass** (needs real audio — synthetic
sectional contrast is a weak proxy, unlike the crisp chord templates):
dial in the six §3.4 constants against real songs where the true structure
is known. Expected first-cut rough edges to watch for and report: a spurious
short section at a fade-out/outro; over- or under-segmentation on songs with
subtle vs. dramatic section contrast; the label threshold splitting a
verse-variation into its own letter or merging a genuinely different part.
This is the same "assistive, validate by ear, tune against real material"
loop as chord detection's CD-5.

## 6. Backlog (out of scope for this first cut)
- Semantic labels (Intro/Verse/Chorus/Solo) via repetition-count + loudness
  + position heuristics.
- Loop-a-section (click sets the loop region to the section) — the data's
  there; it's a small UI follow-up once the boundaries are trusted.
- Snap boundaries to the nearest downbeat once downbeat detection exists
  (shared with chord-detection CD-6 backlog).

Sources: [Foote, "Automatic Audio Segmentation Using a Measure of Audio
Novelty" (2000)] · [librosa: Music structure analysis / Laplacian
segmentation example](https://librosa.org/doc/main/auto_examples/plot_segmentation.html)
· [McFee & Ellis, "Analyzing song structure with spectral clustering"
(2014)] · [MSAF (Music Structure Analysis Framework)](https://github.com/urinieto/msaf)
· [AudioLabs FMP: Novelty-based segmentation](https://www.audiolabs-erlangen.de/resources/MIR/FMP/C4/C4S4_NoveltySegmentation.html)
