# Rate My Take — Design Spec (V4-R1)

**Status:** design document for the v4 headline feature; selected in
[release-v4-spec.md](release-v4-spec.md) §2. Supersedes the backlog's
GP-09 sketch ("Performance feedback vs. the record — XL / R&D") with a
concrete, phased design that exploits what v3 already built.

**Update (2026-07-15) — Phase R1a is built, not yet gated.** `backing_track.py
rate <take.wav> <song>` exists (`score_take()`/`cmd_rate()`), matching §6's
spec exactly: no UI, per-beat pitch (chroma cosine) + timing (onset
cross-correlation, ±80ms) scores, confidence-weighted by reference RMS, a
matplotlib heatmap PNG. Mechanically verified against synthetic self-take
tests (an identical take scores 100%/raw 1.0 as it must; a take with an
injected 150ms lag + noise + dropped notes scores 49.4%/raw 0.596, with
the timing dimension specifically collapsing as expected) — this confirms
the *code* is correct, not that the *metric* is good. One real bug was
caught and fixed during that verification: onset cross-correlation was
comparing two independently-quantized frame grids (take vs. reference),
which read as a spurious constant ~11ms lag on genuinely simultaneous
audio whenever `--offset` wasn't an exact multiple of the onset hop —
fixed by interpolating both onset envelopes onto one shared time grid
before correlating. `RATE_CALIBRATION_FLOOR`/`CEILING` (the raw→percent
mapping) are explicitly placeholder values, not yet calibrated.

**The actual §6 go/no-go gate is still open** and cannot be closed by
further code work — it requires three real takes of a part the user
knows (one tight, one deliberately sloppy, one tasteful variation),
scored and judged by ear against the heatmap. That's a human judgment
call this document's own §6 assigns to the user, not something to
simulate with synthetic audio.

**One-line pitch:** play a solo or rhythm part along to a song, hit stop,
and get an honest "how close was that to the record?" readout — an
overall percentage, per-section scores, and a timeline heatmap showing
exactly where you drifted.

---

## 1. Why this is buildable here and nowhere else

The generic version of this problem (compare two arbitrary recordings of
the same part) is genuinely hard: polyphonic transcription, tempo
alignment via DTW, tone mismatch. Every hard sub-problem disappears or
shrinks inside Orpheus because v3 already built the ingredients:

1. **The reference exists.** Stem separation gives us the isolated guitar
   from the actual record — no tab, no MIDI, no licensing. Shipping
   competitors (Rocksmith+, Yousician) score against authored symbolic
   arrangements and are locked to their catalogs for exactly this reason.
2. **Alignment is free.** The player performs synced to *our* transport.
   Take and reference share one clock, sample-aligned — even under the
   speed trainer, both timelines stretch together. The academic
   student-vs-reference literature spends most of its machinery on DTW
   alignment; we skip it entirely.
3. **The dry signal exists.** The rig taps the pre-effects input
   (`Recorder.recordBus` / riff-capture path), so we compare *what was
   played*, not what the amp did to it. Tone never pollutes the score.
4. **Scoring resolution exists.** The beat grid (BT-02) gives natural
   scoring units; markers (BT-08) give natural reporting sections; the
   loop + speed trainer are a built-in remediation path for a bad
   section. The feature closes a loop v3 left open.

## 2. What the score means (honesty contract)

The number is **"closeness to the record"** — never "quality." This
framing is load-bearing, not cosmetic:

- A tasteful variation *should* score lower on closeness. That's correct
  behaviour, and the UI copy must say so ("You played it your way — this
  measures how close you stayed to the original").
- We can say *where* and *how much* you diverged (this beat's pitch
  content / timing didn't match), never *which note* was wrong. No fake
  precision: the heatmap is the primary output, the percentage is a
  summary of it, and nothing in the UI pretends to be a transcription.
- Quiet reference passages (guitar nearly absent from the stem) are
  scored with low confidence and shown as such (dimmed on the heatmap,
  excluded from the percentage), not scored as if authoritative.

## 3. Scoring pipeline

All offline, after the take ends — no real-time constraint. Analysis
runs in the Python engine (librosa is already a dependency and already
computes chroma + onset envelopes for key/beat detection).

```
reference:  guitar stem  ──┐
                           ├── per-beat features ── per-beat agreement ── aggregate
take:       dry input WAV ─┘
```

- **Capture:** during Play Along playback, tee the dry input into a take
  buffer on the transport clock (the riff-capture worklet pattern,
  without the 20 s ring limit — start/stop bounded by transport). Save
  as WAV alongside a small JSON sidecar: song hash, transport start
  offset, speed factor, tune offset.
- **Feature extraction per beat** (beat grid timestamps, falling back to
  fixed 0.5 s windows when no grid):
  - *Pitch content:* chroma (CQT) vector for reference and take.
    Chroma is deliberately octave- and tone-blind — a Strat take vs. a
    Les Paul record compares fairly. If the take was played with Tune
    active, rotate the take's chroma by the semitone offset first.
  - *Timing:* onset-strength envelopes, cross-correlated in a small
    window (±80 ms) to get a per-beat lag estimate; agreement decays
    with |lag|.
  - *Confidence:* reference-stem RMS in the beat → weight.
- **Per-beat agreement:** `score = w_pitch · cos(chroma_ref, chroma_take)
  + w_timing · timing_agreement`, weights configurable, defaults decided
  in the spike (§6). Beats below the confidence floor are excluded.
- **Aggregates:** confidence-weighted mean per marker section and
  overall, mapped to a percentage with a calibrated curve (raw cosine
  similarity clusters high; the spike must find a mapping where ~60%
  reads "rough" and ~90% reads "tight", or the number is meaningless).

**Known limits, stated up front:** stem bleed inflates or deflates
individual beats (mitigated by confidence weighting, and by V4-F6's
artifact pass); dense rhythm parts under a loud mix score noisier than
exposed leads; chroma cannot distinguish octaves or voicings. Phase 1
targets lead lines and exposed parts — the case the backlog's GP-09
already called achievable — and the UI says so.

## 4. UI

Lives in Play Along, beside Riff Capture (same mental family: "the thing
you just played").

- **Arm/score flow:** a "Rate this take" toggle arms capture; playing a
  loop or the song then stopping produces the score card. Re-running the
  same section replaces the card (history is V2 — see §7).
- **Score card:** big closeness percentage; per-marker-section rows
  ("Intro 92 · Solo 61"); one-line honesty caption (§2).
- **Timeline heatmap:** per-beat agreement painted as a translucent lane
  over the existing ruler (green→red, dimmed where low-confidence),
  using the same `timeToPct` mapping as markers/zoom so it stays correct
  under zoom. Clicking a red run sets the A/B loop around it — the
  remediation loop in one click.
- **Speed-trainer tie-in:** score cards note the speed they were played
  at ("87% at 80% speed"); no score normalization across speeds — that
  would be fake precision.

## 5. Server & storage

- `POST /api/take/score` — engine scores a saved take WAV against the
  song's guitar stem; returns per-beat scores + aggregates JSON.
- Scores stored in the song's project blob (content-hash-keyed since v3,
  so scores follow renames like everything else). Take WAVs use the
  existing riff/take numbering and folders — nothing new to manage.

## 6. Phase R1a: the research spike (go/no-go)

Build no UI. A CLI (`backing_track.py rate <take.wav> <song>`) that
prints per-beat scores and renders a matplotlib heatmap PNG. Then the
only test that matters: the user records **three real takes** of a part
they know — one tight, one deliberately sloppy, one tasteful-variation —
and the scores must rank tight > variation > sloppy, with the heatmap's
red zones matching where their ears say the sloppy take fell apart.

- **Pass:** proceed to R1b/c.
- **Partial** (ranks leads correctly, rhythm noisy): ship scoped to
  lead/exposed parts, say so in the UI.
- **Fail** (ranking wrong or unstable across songs): stop. Write up why
  in this doc, keep the CLI as a curiosity, spend the effort on V4-F1
  chords instead. No UI gets built on a metric that doesn't match ears.

## 7. Explicit non-goals (v4)

- Real-time scoring while playing (Rocksmith-style). Offline-after-take
  is more robust and honest; revisit only if the metric proves solid.
- Note-level "you played F# not G" feedback — requires transcription,
  a different (much larger) project.
- Score history/progress charts — wants the practice log (V4-F4) as a
  home; wire them together in a later pass once both exist.
- Scoring against another *take* (self-comparison) — cheap once this
  ships, but v4 scope is the record only.
