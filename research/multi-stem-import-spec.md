# Multi-stem ZIP import — Design Spec

**Status:** proposed, not built. Backlog item from the post-v4.5 planning
pass (2026-07-16) — see [post-v4-backlog-audit.md](post-v4-backlog-audit.md).

**One-line pitch:** a second way to get a song into the Library — instead
of one audio file that gets run through separation, drop in a `.zip` of
already-separated stems (a purchased "custom backing track" pack, a
friend's multitrack export, anything pre-split) and it shows up in the
mixer immediately, stems named exactly as the files were, no separation
step at all.

---

## 1. Why this is worth having

Every song currently goes through the same pipeline: one audio file →
Demucs/audio-separator → a fixed stem vocabulary (vocals/drums/bass/
guitar/piano/other, whichever subset a given model produces). That's the
only path in today. But real multitrack material already exists outside
that pipeline — sites selling "custom backing tracks" ship exactly this:
one MP3 per instrument role, already isolated, often at a quality no ML
separator gets close to (no bleed, no "processed" artifact ceiling —
see USER-MANUAL.md's honest limitations section on that ceiling).

The real example this spec is built from —
[input/Iron_Maiden_2_Minutes_to_Midnight.zip](../input/) — has **9**
stems: Drum Kit, Bass, Distorted Electric Guitar 1, Distorted Electric
Guitar 2, Lead Electric Guitar 1, Lead Electric Guitar 2, Arrangement
Electric Guitar, Backing Vocals, Lead Vocal. That's richer than any
separation model here produces, and it already has lead/rhythm guitar as
**separate, clean stems** — the exact problem guitar-separation-upgrade-spec.md
and lead-rhythm-split-research.md spent real effort on (a panning
heuristic, and later a from-scratch ML training plan) is simply *solved*
for free by importing a pack like this. Worth noting as a real payoff,
not just a nice-to-have.

## 2. What's actually in a real pack (from the example)

```
Iron_Maiden_2_Minutes_to_Midnight(Drum_Kit_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Bass_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Distorted_Electric_Guitar_1_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Distorted_Electric_Guitar_2_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Lead_Electric_Guitar_1_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Lead_Electric_Guitar_2_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Arr_Electric_Guitar_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Backing_Vocals_Custom_Backing_Track).mp3
Iron_Maiden_2_Minutes_to_Midnight(Lead_Vocal_Custom_Backing_Track).mp3
__MACOSX/._Iron_Maiden_2_Minutes_to_Midnight(...).mp3   × 9  (junk)
```

Two things this confirms and one gotcha:

- **Flat, not nested** — every real audio file sits at the zip root, no
  subfolder to walk into. Design for that; don't over-build a recursive
  folder-walker for a hypothetical structure this example doesn't have
  (if a real pack ever does nest, that's a cheap follow-up, not a reason
  to complicate the first version).
- **File count and names are arbitrary** — this one has 9, a Demucs run
  has 4–6, and there's no reason to assume any fixed number or vocabulary
  ever again once this import path exists. Every place in the app that
  currently assumes a closed stem vocabulary needs to degrade gracefully
  (§5) rather than break.
- **The gotcha:** `__MACOSX/._*` files are AppleDouble resource-fork
  junk that macOS's Finder "Compress" always adds to a zip. They're
  small (hundreds of bytes), not real audio, and **must be filtered out**
  — both the `__MACOSX/` directory itself and any `._`-prefixed filename
  anywhere in the archive, not just under that folder (the same pattern
  can appear at the root on some zip tools).

## 3. The architectural wrinkle: there's no single source file

Every existing piece of per-song state — projects, the stem cache,
analysis, practice log — is content-hash-keyed off **one input audio
file** (`resolve_source_path` → `engine.content_hash` → everything else
hangs off that digest). A multi-file import has no single file to hash.

**Resolution: synthesize one.** On import, sum all the stems into a
"full mix" (same summing + `normalize_loudness` code path `svc_mix`
already uses), write that as the new track's actual `input/<song>.<fmt>`
file, and hash *that*. Every existing subsystem — projects, practice log,
the Library's "has project" dot, playlists — keeps working completely
unchanged, because as far as they're concerned this is just a normal
imported song. The individual stems get written directly into that
song's stem-cache directory, under a new pseudo-model name (`imported`,
see §4) — i.e. this is modeled as "separation already happened," not as
a parallel storage system.

This also means an imported-stems song can **still** be run through a
real separation model afterward if the user wants to A/B against it —
the existing per-track model switcher (already built for `htdemucs_6s`
vs `bs_roformer_sw`) is the exact right UI for "imported" to be one more
entry in, no new switcher UI needed.

## 4. Server-side design

```python
def svc_import_stem_zip(zip_bytes: bytes, zip_filename: str) -> dict:
    """Extracts a ZIP of pre-separated stems, synthesizes a full-mix
    input file to hash-key everything else off of (see spec §3), and
    populates the stem cache directly under model name 'imported' —
    modeled as 'separation already happened,' not a parallel storage
    path, so projects/practice-log/playlists need zero changes."""
```

- Parse the zip in memory (`zipfile.ZipFile`); collect every entry whose
  name doesn't start with `__MACOSX/` and whose basename doesn't start
  with `._`, and whose extension is a supported audio type (`.wav`,
  `.mp3`, `.flac`, `.m4a`, `.aiff` — same set the regular importer
  should already tolerate; check `svc_tracks`/the drop-zone handler for
  the current allow-list and match it).
- **Stem label = filename, minus extension, minus zip-relative path.**
  No vendor-specific pattern-stripping (no regex hunting for
  `_Custom_Backing_Track`) — that's fragile and this feature needs to
  work for *any* zip source, not just one vendor's naming convention.
  The user explicitly wants "the names of the files as the names of the
  stems... happy that these wrap because they can be long" — trust the
  filename, full stop.
  - The **display label** keeps the raw name (long, with underscores/
    parens intact — the UI's job to wrap, not this function's job to
    prettify).
  - The **on-disk stem filename** (and the internal dict key used
    everywhere a stem name is a Python dict key or a URL query param)
    needs to survive being a safe filename — run it through the existing
    `safe_name()` helper (already used for output paths) and store the
    raw label separately (see below).
- Reject up front (before writing anything) if: the zip contains zero
  usable audio entries, or two entries would collide to the same
  `safe_name()`'d key (ask the user to rename one and re-zip rather than
  silently overwriting).
- Song name: the zip's own filename, minus `.zip`, run through the same
  "humanize a filename" treatment the regular importer already applies
  for display purposes (check what that currently does, if anything —
  keep this consistent rather than inventing a second convention).
- Decode each stem (`soundfile`/`librosa`, already hard dependencies),
  sum to mono-summed-to-stereo at the loudest stem's sample rate (pad
  shorter ones with silence, same pattern `svc_mix` already uses for
  mismatched lengths), run through `normalize_loudness`, write as the
  new `input/<song name>.wav` (WAV, not MP3, for the synthetic mixdown —
  no lossy generation loss on a file nobody's meant to listen to
  directly; it only exists to be hashed and, optionally, re-separated
  later).
- `digest = content_hash(that new input file)`; write every original
  stem file **byte-for-byte unchanged** (this is the whole value
  proposition — never re-encode a pack the user paid quality for) into
  `separated/imported/<song>__<digest>/<safe_stem_name>.<original ext>`.
- Write a small `stem_labels.json` sidecar in that same directory —
  `{safe_name: raw_label}` — since `safe_name()` is lossy (can't always
  round-trip back to the original). Every place that currently does
  `stem.replace('_', ' ')`-style display formatting needs to check this
  file first and fall back to that only for non-imported models.
- Skip `analysis.json`'s beat/key/chord computation at import time if no
  stem name fuzzy-matches anything analyzable (§5) — same "a missing
  reading is fine" contract `analyze_track` already follows for every
  other field.

## 5. Graceful degradation where the app assumes a known stem vocabulary

A few existing features key off exact stem names (`"guitar"`,
`"bass"`, `"other"`, `"piano"`) rather than treating the stem list as
arbitrary. Each needs a decision, not a crash:

- **Guitar split panel** (`hasGuitar = State.stems.some(s => s.name ===
  "guitar")`) — an imported pack with `Lead_Electric_Guitar_1` etc. has
  no stem literally named `guitar`, so this panel simply won't show.
  That's *correct*, not a bug to route around — a pack that already
  ships separate lead/rhythm guitar stems has no need for the
  panning-guess split in the first place (see §1). No change needed
  here; just don't let anyone "fix" it into false-positive-matching.
- **Chord/key detection** (`detect_chords`/`analyze_track`'s `for name
  in ("bass", "other", "guitar", "piano")` stem-selection loop) — won't
  find any of those exact names in an imported set. Cheapest honest
  fix: fuzzy-match by substring (case-insensitive `"guitar" in
  stem_name`, `"bass" in stem_name`, etc.) across the imported stem
  list, sum every stem that matches "guitar-like" into the chroma
  source (§ of backing_track.py's `detect_chords`), same spirit as
  every other heuristic here — cheap, good-enough, not guaranteed.
  Falls back to no chords/key (existing graceful-omission path) if
  nothing matches at all.
- **Practice-relevant stem ordering** (`STEM_ORDER` in app.js, used to
  keep lanes in a consistent vocals→drums→bass→guitar→piano→other
  order) — an imported stem with no vocabulary match sorts after every
  recognized one, alphabetically among the leftovers. Not worth a
  fuzzy-matching pass here; pure display ordering, low stakes.

## 6. UI

- A **second, explicit** entry point next to (not merged into) the
  existing "Drop an audio file here" box — something like "or import a
  stem pack (.zip)" as its own small drop target/link. Explicit on
  purpose: silently auto-detecting `.zip` vs. audio in the same drop
  zone means a user who drags in an unrelated zip (a project backup, a
  sample pack) gets surprised by an "imported song" appearing instead
  of a clear error. Being upfront about "this is a different kind of
  import" costs one extra UI element and avoids that entirely.
- Progress/result messaging mirrors the existing "Importing…" state; on
  success, select the new track immediately (same as a normal import
  already does) so the payoff is immediate.
- Errors (empty zip, all-colliding names, an entry that won't decode as
  audio) surface as a plain message, not a silent partial import — if
  it can't cleanly import *everything*, don't half-import it.

## 7. Explicit non-goals (v1)

- **Re-encoding/normalizing individual stems.** The whole point is
  byte-for-byte preservation of a pack the user already trusts — don't
  "helpfully" transcode anything.
- **Nested-folder zips.** Not represented in the one real example this
  spec is built from; add it if a real pack ever needs it, not
  speculatively.
- **Editing stem labels after import.** Worth revisiting once this
  ships and it's clear whether the raw filename is ever actually
  annoying enough in practice to want a rename affordance — the user's
  own stated preference going in is that long/exact names are fine.
