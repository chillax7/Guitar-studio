# Custom Stems — Design Spec

**Status: shipped in v4.7.** Written pre-v5 at the user's request ("first
can we add custom stems" before starting the v5 milestone sequence).
Shipped as its own point release ahead of v5's larger AI Lab work, the
same way v3.1/v3.2/v4.5/v4.6 each shipped a coherent slice between the
numbered spec documents. Everything below matches what shipped — the
one implementation detail worth noting: `safe_name()` in this codebase
is deliberately permissive (spaces/case/punctuation preserved, only path
traversal and NUL/slash characters stripped), so an on-disk custom-stem
key can contain spaces (e.g. "My Guitar Take.wav" stays "My Guitar
Take"); this works fine everywhere a stem name is used (filesystem,
URL-encoded query param) and needed no extra normalization.

**One-line pitch:** drag an MP3/WAV onto the mixer of a song that's
already separated, and it appears as one more stem — mute, solo, fader,
pan, EQ, export, all of it, no different from a stem the ML separator
produced.

---

## 1. Why this is a different feature from multi-stem import

[multi-stem-import-spec.md](multi-stem-import-spec.md) (shipped v4.6)
solves "I have a whole pre-separated pack instead of one file to run
through separation" — it replaces the *entire* stem set for a *new* song
import. This is the opposite shape: **one file, added to a song that's
already been through the normal pipeline**, sitting alongside stems an ML
model actually produced. Real use cases this unlocks: dropping in your own
recorded DI guitar take to play back next to the algorithmic separation,
adding a purchased single-instrument backing track for a part the
separator can't isolate well (real strings, a horn section), or bringing
in a click/reference track that isn't a "stem" in any ML sense at all.

Architecturally, though, this feature is *cheap* precisely because
multi-stem import already solved the hard parts: WAV conversion via
ffmpeg, `safe_name()`-keyed on-disk filenames with a `stem_labels.json`
sidecar for the raw display label, and the "arbitrary stem vocabulary"
graceful-degradation work already done throughout `stem_info()`/the chord
detector/`STEM_ORDER`. This spec reuses all of it rather than inventing a
second convention.

## 2. The one real design decision: where does a custom stem live on disk?

**Not inside the model's own stem-cache directory
(`separated/<model>/<track>__<hash>/`).** Two independent reasons rule
that out:

- **It would get destroyed on re-separation.** `run_demucs_backend`
  (`backing_track.py`) does `shutil.rmtree(out_dir)` on that exact
  directory before renaming Demucs' fresh output into place — a custom
  stem sitting in there would be silently wiped the next time the user
  re-separates with `--force`. (`run_audio_separator_backend` happens not
  to do this today, but relying on that asymmetry between backends would
  be fragile and surprising — the design shouldn't depend on which
  backend happens to be gentler.)
- **It shouldn't disappear when you switch models.** A custom stem you
  physically provided (your own guitar take, a purchased backing track)
  has nothing to do with which ML separation model is currently active
  for the other stems — switching from `bs_roformer_sw` to `htdemucs_6s`
  to A/B them shouldn't make your dropped-in file vanish and reappear.

**Design: custom stems are track-scoped, not (track, model)-scoped** —
stored once per song regardless of which separation model is currently
loaded, exactly matching how projects and the practice log are already
keyed off the source file's content hash rather than per-model. New
directory: `separated/_custom/<hash>/<safe_name>.wav`, with the same
`stem_labels.json` sidecar convention multi-stem-import already
established (`{safe_name: raw_label}`, since `safe_name()` is lossy).
`<hash>` here is the same `content_hash_for_track()` the project/
practice-log system already computes off the resolved source file — no
new hashing scheme.

## 3. Server-side design

```python
def svc_add_custom_stem(source_path: str, filename: str, audio_bytes: bytes) -> dict:
    """Converts an arbitrary audio file to WAV (same ffmpeg path
    svc_import_stem_zip already uses), resamples it to match the track's
    existing stems if needed, and writes it into the track-scoped (not
    model-scoped — see spec §2) separated/_custom/<hash>/ directory. The
    result merges into every model's stem_info() output for this track."""
```

- Route: `POST /api/custom_stem?source_path=<track>&filename=<name.ext>`,
  raw bytes body — same `Api.postRaw` pattern the zip importer already
  uses on the client, no new upload mechanism needed.
- `input_path = resolve_source_path(source_path)`; reject with a plain
  404 if the track has no cached stems yet under *any* model (`Sequence
  through engine.MODEL_STEMS` keys and `has_cached_stems` — the point of
  this feature is adding to an already-separated track, not seeding a
  bare import; someone dragging a file onto an unseparated track's mixer
  should be told to separate first, not have this silently do something
  else).
- `digest = content_hash_for_track(source_path)`;
  `custom_dir = SEPARATED_DIR / "_custom" / digest`.
- Convert to WAV via the existing `_ffmpeg_convert_to_wav` helper.
  **Sample-rate matching matters here in a way it didn't for zip import**:
  zip import only had to make its own stems agree with each other, but a
  custom stem has to agree with whatever the *currently active model's*
  stems already use, since they all get mixed together live in the same
  Web Audio graph. Read the sample rate of any existing stem for this
  track (any model directory works — pick whichever the request names,
  or fall back to the `input_path`'s own file) and resample the custom
  stem to match if it differs, same resample-on-mismatch pattern
  `svc_import_stem_zip` already established.
- **Length is not forced to match.** A custom stem shorter or longer than
  the song (a one-off DI take of just the solo, say) is legitimate — the
  client-side mixer already pads mismatched stem lengths at playback
  time (`loadStemBuffers`'s existing per-stem duration handling), so no
  new client logic is needed there. Silence fills the gap, exactly like
  a derived split stem shorter than its source already does today.
- `safe_key = safe_name(Path(filename).stem)`; reject if that key
  already exists in `custom_dir` **for a different original filename**
  (same collision message style as `svc_import_stem_zip`) — but *do*
  allow re-dropping a file with the same name to simply replace it
  (someone re-recording their own take and dragging the improved version
  in is the expected workflow, not an error).
- Write `custom_dir / f"{safe_key}.wav"` and update
  `custom_dir / "stem_labels.json"`.
- Return the same shape `svc_list_stems` already returns for one stem,
  so the client can append it to `State.stems` without a full reload.

### `stem_info()` gets one more merge step

```python
def stem_info(out_dir: Path, model: str) -> list:
    ...  # unchanged: walks out_dir's own *.wav files
    stems.extend(custom_stem_info(track_digest))  # new
    return stems
```

`custom_stem_info(digest)` reads `separated/_custom/<digest>/*.wav` +
its `stem_labels.json` sidecar the same way the existing loop reads
`out_dir`'s, tagging each with `"is_custom": true` (a new, clearer flag
alongside the existing `is_derived` — "derived" already means
"algorithmically produced from another stem, like guitar_center/sides,"
which isn't the right word for "the user handed us this file directly";
reusing `is_derived` would blur two different provenances the UI may
want to style differently). `stem_info()` needs the track's digest,
which every call site already has available via `input_path` — a small
signature change (`stem_info(out_dir, model, digest)`), not a new lookup.

### Deletion

A custom stem needs to be removable independent of re-separating —
`DELETE`-style route (`POST /api/remove_custom_stem?source_path=...&stem=...`,
matching this codebase's GET/POST-only routing rather than introducing
DELETE) that just unlinks the one file and its `stem_labels.json` entry.

## 4. Client-side design

- **Drop target: the mixer's lane area itself (`#lanes` / `#workspace`),
  not the sidebar.** The sidebar's existing drop zone is for *importing a
  new song*; dropping a file there while a track is already selected must
  keep doing exactly that (unchanged) — this feature's drop target has to
  be visually and functionally distinct so "drop here to import a new
  song" and "drop here to add a stem to this song" are never ambiguous.
  A dashed-outline overlay across the lanes area on `dragover`, matching
  the sidebar's existing `.dragover` treatment, with a label like "Drop
  to add as a new stem" makes the distinction legible at the moment it
  matters, not just documented somewhere.
- Guard: only active once `State.stems.length > 0` (a track is actually
  loaded and separated) — before that, the lanes area doesn't exist yet
  to drop onto, so this is naturally a non-issue rather than something to
  special-case.
- On drop: upload via `Api.postRaw`, same pattern as `importFile`/
  `importStemZip`; on success, push the returned stem info into
  `State.stems` and call `renderLanes()` — no full `selectTrack()`
  reload needed, matching how a fresh separation result is already
  merged in without a full page-level reload.
- **The new lane needs actual playback buffers**, not just a DOM row —
  `loadStemBuffers()` (or whatever it's since been refactored into) has
  to pick up the new stem the same way it picks up every other one. Since
  custom stems are track-scoped rather than model-scoped, they should be
  fetched and mixed in *regardless of which model is currently selected*
  — i.e. the stem-loading code's source of truth needs to become "this
  model's stems, plus this track's custom stems," not just "this model's
  stems."
- **Lane UI:** a small badge next to the stem name, parallel to the
  existing `.lane-derived-badge` ("derived") — e.g. `.lane-custom-badge`
  reading "custom" — and a small ✕ on the lane header (visible on hover,
  same disclosure pattern the marker-delete `×` already uses) to call the
  new delete route. Otherwise **zero new UI** — mute/solo/fader/pan/EQ/
  mute-region-painting are already generic over `State.stems`, so a
  custom stem gets every one of them for free the moment it's in that
  array, which is exactly the "behaves just as the existing stems do"
  requirement.
- **`STEM_ORDER` fallback already handles this** — an unrecognized stem
  name sorts after every recognized one, alphabetically among the
  leftovers (multi-stem-import-spec.md §5's existing precedent). No
  change needed.
- **Export already handles this** — `svc_mix` reads whatever stems exist
  in the resolved `out_dir` for the currently-selected model; since a
  custom stem is being merged in at the `stem_info()`/list layer, `svc_mix`
  itself needs the same merge (read from both the model dir and
  `separated/_custom/<digest>/` when building the stem list to sum) —
  the one place server-side logic needs updating beyond `stem_info()`.

## 5. Graceful degradation, same posture as multi-stem import

- **Guitar split panel** — a custom stem literally named `guitar` would
  falsely trigger this panel meant for the *separator's* guitar stem.
  Simplest fix: the split panel's `hasGuitar` check should only match
  stems that are neither `is_derived` nor `is_custom` (i.e. genuinely
  produced by the active model) — a one-line tightening of an existing
  condition, not new logic.
- **Chord/key detection's fuzzy stem-name matching** (already built for
  multi-stem-import) — a custom stem whose label happens to contain
  "guitar" or "bass" would already get picked up by that same
  substring-matching loop. This is *correct*, not a bug to route around
  — if someone drops in their own real guitar take, letting it
  contribute to chord/key detection is more likely to help than hurt,
  same spirit as the rest of this app's heuristics.
- **Rig presets / Play Along's Suggest button** (`paSuggestNamModel`,
  which reads the guitar stem) — same fuzzy-match treatment: fall back
  to a custom stem whose label matches "guitar" if no model-produced
  `guitar` stem exists for the current model. Not required for v1, but
  cheap to fold in alongside the chord-detection fuzzy match since it's
  the same lookup.

## 6. Explicit non-goals (v1)

- **Re-analyzing beat grid/key/chords against a custom stem by default.**
  `ensure_analysis`'s cache is keyed by the model's `out_dir`, which a
  custom stem doesn't live inside (by design, §2) — leave analysis as
  whatever the active model already computed. The fuzzy-match cases in
  §5 are the exception, not a blanket re-analysis trigger.
- **Editing/replacing a custom stem's label after the fact.** Same call
  multi-stem-import-spec.md made — revisit if it turns out to matter in
  practice.
- **Custom stems inside a rig-preset/pedalboard signal chain.** These are
  backing-track-mixer stems (the Mixer screen), unrelated to Tone Lab's
  live-guitar signal chain — no interaction between this feature and
  Tone Lab/Play Along beyond the fuzzy-match Suggest fallback in §5.
