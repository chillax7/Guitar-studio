# Audio → Guitar Pro tab ("Tab This Take")

**Status:** implementation spec. Written 2026-08-02 against `main` @ `1d650a0`.

**Why this and not a tab API:** there is none worth building on. Ultimate
Guitar has no public API; Songsterr has a search endpoint but its terms
forbid downloading its content; every `.gp` downloader in the wild is a
scraper. That investigation produced the find-only search now shipping (see
`svc_tab_search`). This spec is the other half of the answer: instead of
fetching someone's transcription of a recording, **generate a tab from the
audio the user already has** — which sidesteps the licensing question
entirely and produces something no tab site can: a tab of *this* take, in
*this* tuning, aligned to the mix they are already playing along to.

**Audience:** implementable by a separate session. Every claim marked
*verified* was checked against the running code; everything else is marked
as an estimate or an open question.

---

## 0. What already exists (verified, do not rebuild)

This is the reason the feature is tractable at all — most of the front end
is already in the app for other features.

| Piece | Where | State |
|---|---|---|
| Monophonic F0 tracking (`librosa.pyin`) with confidence filtering | `backing_track.py:1768` `_extract_confident_f0` | **Working**, used by Rate My Take |
| F0 range constants | `RATE_PITCH_FMIN_HZ` 82.4 (E2) / `RATE_PITCH_FMAX_HZ` 1318.5 (E6) | Tuned for guitar already |
| Confidence floor | `RATE_PITCH_VOICED_PROB_FLOOR = 0.5` | Calibrated on real takes; see its docstring |
| Beat grid + BPM | analysis `result["beats"]` (times, seconds), `result["bpm"]` | **Working** |
| Key + mode | `result["key"]` | **Working** |
| Chords, Viterbi-smoothed, beat-windowed chroma | `detect_chords`, `_beat_windowed_chroma` | **Working** |
| Song sections | Song Structure (SS-1..4) | **Working** |
| Tuning estimate | `librosa.estimate_tuning` | Used in chord detection |
| Isolated guitar stem, lead/rhythm split | Demucs + the guitar split | **Working** |
| **Guitar Pro 7 writer** | `alphaTab.exporter.Gp7Exporter`, vendored | **Verified working — see §1** |
| Tab rendering + playback | Tab View (alphaTab), incl. play-through-rig | **Working** |

### What must be built

Note segmentation, rhythm quantisation, string/fret assignment, score
construction, and the UI. That is the whole of §2–§6.

---

## 1. The output format is solved (verified)

The single biggest risk in this feature was "can we even write a `.gp`
file?". **Yes, and the code is already vendored.**

`alphaTab.exporter.Gp7Exporter` (`vendor/alphatab/alphaTab.core.mjs:68923`)
writes Guitar Pro 7/8 via `GpifWriter` + `ZipWriter`. Verified by round-trip
in a real browser against this repo's own `tabs/realtest.gp5`:

```
imported .gp5  -> title "Real Test", 1 track, 20 master bars
Gp7Exporter    -> 4294 bytes, first two bytes 0x50 0x4B ("PK", a valid ZIP)
re-imported    -> title "Real Test", 1 track, 20 master bars
```

**One gotcha, already found:** the app currently imports
`alphaTab.min.mjs`, and the exporter is **tree-shaken out of it**
(`grep -c "Guitar Pro 7-8"` → `0` in `min.mjs`, `2` in `core.mjs`). Export
must import `alphaTab.core.mjs`. Do this as a separate dynamic import at
export time so Tab View's ~3.6 MB render path is unaffected for users who
never export.

Model classes needed for construction are all on the `alphaTab.model`
barrel (`Score`, `Track`, `Staff`, `Bar`, `Voice`, `Beat`, `Note`,
`MasterBar`, `Tuning`, `Duration`, …) — confirmed present at runtime.

---

## 2. Pipeline

Server-side (Python, where librosa and the stems already live), except the
final `.gp` write which is client-side (where alphaTab lives).

```
guitar stem (lead)  ->  F0 contour        (§3.1, exists)
                    ->  note segmentation (§3.2, build)
                    ->  rhythm quantise   (§3.3, build)  <- uses existing beat grid
                    ->  string/fret       (§4,   build)  <- the interesting part
                    ->  note list JSON    (server -> client)
                    ->  alphaTab Score    (§5,   build)
                    ->  Gp7Exporter       (§1,   verified)
                    ->  tabs/ library     (existing upload endpoint)
```

Deliberately **not** a single monolith: the note-list JSON is a real
boundary. It is inspectable, testable without a browser, and lets the
string/fret stage be re-run with different tuning/capo without redoing
pitch tracking.

---

## 3. Notes from audio

### 3.1 F0 contour — reuse, don't rewrite

`_extract_confident_f0` already returns `(f0_hz, times)` with unvoiced and
low-confidence frames dropped. Use it unchanged. Its constants are already
guitar-ranged and its confidence floor was calibrated against real takes —
that calibration note in `backing_track.py` is worth reading before touching
anything, because unfiltered pyin on real guitar audio was measured to
produce "essentially random pitch estimates" on bends, palm mutes and string
noise.

**Change needed:** it currently drops the frames it filters. For
segmentation we also want the *gaps* (they are note boundaries), so add a
variant that returns the confidence mask alongside, rather than pre-filtering.

### 3.2 Note segmentation

From `(f0, times, confidence)` produce `{onset, offset, midi, confidence}`.

1. Convert F0 to continuous MIDI: `69 + 12*log2(f0/440)`, then apply the
   song's `librosa.estimate_tuning` offset so a track recorded slightly flat
   doesn't quantise a semitone off.
2. Median-filter the MIDI contour (~50 ms) to kill vibrato wobble and
   octave-jump glitches without smearing real note changes.
3. Segment on **either** a sustained semitone change **or** a confidence
   dropout longer than ~60 ms. Both matter: a legato slide changes pitch
   without a dropout; a re-picked same note has a dropout without a pitch
   change.
4. Drop segments shorter than ~60 ms (below a 32nd at 120 BPM) as artifacts.
5. Per segment, take the **median** MIDI over its confident frames (not the
   mean — bends skew the mean), round to integer.

*Acceptance:* on a synthesized reference — a known MIDI phrase rendered to
audio — ≥95 % of notes recovered with correct pitch and onset within 30 ms.
Build that synthetic fixture first; it is the only ground truth available
without hand-transcribing real audio.

### 3.3 Rhythm quantisation

The beat grid already exists and is the whole reason this can produce
readable notation rather than a wall of tuplets.

- Map each onset to the nearest subdivision of the existing `beats[]`,
  trying 1/8, 1/16, 1/8-triplet, 1/16-triplet.
- Choose the grid **per bar**, not globally: metal alternates straight and
  triplet feels constantly, and forcing one grid on a whole song is the
  classic way transcriptions become unreadable.
- Score a candidate grid by total absolute onset deviation; pick the coarsest
  grid within a tolerance of the best, so a straight-16ths bar doesn't get
  notated as 32nd-triplets because two notes were 8 ms late.
- Note duration = time to the next onset, clamped to the grid, with rests
  inserted where the gap exceeds one subdivision.

**Known weakness, state it in the UI:** heavily swung or rubato playing will
quantise badly. That is inherent, not a bug to be fixed later.

---

## 4. String and fret assignment

This is the part that makes it a *tab* rather than a MIDI transcription, and
it is a genuine optimisation problem — the same pitch is playable in up to
6 places.

Model as a shortest-path problem over the note sequence:

- **States:** for note *n*, every `(string, fret)` producing its pitch in the
  current tuning, with `0 ≤ fret ≤ 24`.
- **Transition cost** between consecutive notes:
  - hand-position movement: `|fret(n) - fret(n-1)|`, weighted highest;
  - string change: small constant (crossing strings is cheap, moving the
    hand is not);
  - open strings: small bonus (guitarists use them, and they anchor position);
  - a soft penalty above ~fret 12 unless the pitch forces it — the low
    positions are where people actually play.
- **Viterbi** over that lattice. *The app already does exactly this shape of
  thing* in `detect_chords` (`librosa.sequence.viterbi`), so the idiom and
  the reasoning are already in-house.

**Tuning must be an input, not an assumption.** This app's users are metal
players: drop D, drop C, D standard and 7-string are the norm, and a tab
generated in E standard for a drop-C riff is worse than no tab. Default to
the song's detected tuning if one is available, otherwise E standard, and
make it a visible dropdown that **re-runs only §4** (cheap — no re-analysis).

*Acceptance:* for a known drop-D riff, the assignment puts the low chugs on
string 6 at fret 0 rather than string 5 at fret 5, and total hand movement
across the phrase is within 20 % of a hand-made tab of the same riff.

---

## 5. Building the score

Client-side, using the model classes verified present in §1.

- One `Score` with the song's title/artist from `/api/trackinfo`.
- One `Track`/`Staff` with the chosen `Tuning`.
- `MasterBar` per bar from the beat grid, with the time signature; tempo
  automation from `result["bpm"]`.
- `Bar` → `Voice` → `Beat` → `Note`, `Note.string` / `Note.fret` from §4,
  `Beat.duration` from §3.3.
- Export with `Gp7Exporter`, POST to the existing `/api/tabs/upload`, refresh
  the library — the identical path the TONE3000 downloader already uses for
  captures.

**Articulations are out of scope for v1.** Bends, slides, vibrato and palm
mutes are all detectable in principle from the F0 contour and the envelope,
and alphaTab's model supports them — but each is its own detector with its
own false-positive mode, and a tab littered with wrong bend markings is
worse than a clean one without them. Ship plain notes first.

---

## 6. UI

In Tab View, next to the import controls: **"Tab this take"**, enabled when
a song with a separated guitar stem is loaded.

- Source picker: lead guitar stem (default) / rhythm / full guitar.
- Tuning dropdown (§4), re-runs assignment only.
- Progress, since pyin over a full song is not instant (§7).
- On completion: import into the tab library and open it — at which point
  the existing Tab View machinery gives playback, looping, speed, and
  play-through-your-rig for free.

**Label it honestly, in the app's existing idiom.** This is a machine
transcription of a separated stem: it will be good on clean sustained lead
lines and poor on fast tremolo picking, chords, and anything buried in the
mix. The app already labels its heuristics this way (`paDescribeNamMetadata`,
the chord-detection confidence notes, Rate My Take's calibration caveats) —
match that register. Show per-note confidence from §3.2 where the UI can
carry it, so low-confidence passages are visibly uncertain rather than
silently wrong.

---

## 7. Cost, and what could go wrong

- **`librosa.pyin` is slow** — it is the expensive part of Rate My Take
  already. On a 4-minute stem expect tens of seconds, possibly minutes on a
  laptop. **Measure before designing the UI around it.** If it is bad,
  `pyin`'s `frame_length`/`hop_length` and a reduced `fmax` are the levers,
  and section-at-a-time transcription ("tab just this solo") is both cheaper
  and closer to how people would use it. That may be the better v1 anyway.
- **Polyphony is the hard ceiling.** pyin is monophonic. Chords and power
  chords will come out as one note or as nonsense. v1 must target **lead
  lines** and say so. Power chords are a plausible v2 via the existing
  chord detector, which already has a power-chord template.
- **Stem bleed.** The guitar stem is not perfectly isolated; cymbals and
  vocals leak in and pyin will track them during guitar rests. The
  confidence floor helps; an energy gate against the stem's own envelope
  would help more.

## 8. Suggested order

| # | Item | Why first | Risk |
|---|---|---|---|
| 1 | Synthetic fixture: MIDI phrase → audio → expected notes | Nothing below is measurable without ground truth | Low |
| 2 | §3.2 segmentation against that fixture | The core of the whole feature | Medium |
| 3 | Measure pyin cost on a real full-length stem (§7) | Decides whether v1 is whole-song or section-at-a-time | Low |
| 4 | §3.3 quantisation | Turns notes into readable notation | Medium |
| 5 | §4 string/fret Viterbi | What makes it a tab | Medium |
| 6 | §5 score build + export | Output already verified | Low |
| 7 | §6 UI | Last, once the pipeline's real quality is known | Low |

Do **not** start at §5 because it is the verified bit — a perfect exporter
fed bad notes produces a bad tab, and the quality of this feature is decided
entirely in §3 and §4.
