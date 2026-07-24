# AI Lab — Song Structure — research & spec

Status: **design only.** Builds on song-section detection (BT-20,
`detect_sections`), whose Mixer ribbon is currently hidden
(`SECTION_RIBBON_ON_MIXER = false`) pending exactly this home.

## 1. The question this feature answers

A guitarist who has separated a song and now wants to *learn its parts* is
not asking "what is this song about" — they're asking "how is it built, and
how do I get it under my fingers, part by part." The whole app already points
here (separate → mix → loop a section → Speed Trainer → record a take); what's
missing is the **map** that turns a wall of waveform into named, ordered,
playable parts.

Concretely, when a player sits down to learn a song's parts they want:

1. **The roadmap.** What are the parts and in what order? *Intro (8 bars) →
   Verse → Chorus → Verse → Chorus → Bridge → Solo → Chorus ×2 → Outro.* How
   long is each, where does it start, when does it come back?
2. **Navigation.** Jump to / loop any part instantly — "give me just the
   chorus" — because you learn a song one section at a time, not top to bottom.
3. **Per-part harmony.** The chords and key of each part, and whether the key
   or tonal centre shifts between parts (verse in Em, chorus lifts to G).
   Roman numerals so the shape is transferable, not just this key's letters.
4. **What the guitar is actually *doing* in each part.** Rhythm or lead?
   Strummed open chords, palm-muted power chords, fingerpicked arpeggios, a
   single-note riff, a lead line, a solo? The feel/strumming pattern, the
   defining technique (bends, slides, muting).
5. **Tone & setup per part and per song.** Clean vs driven, quiet vs loud
   (the app can *see* this from the stems), plus song-level tuning and capo.
6. **Difficulty & a learning order.** Which parts are beginner-friendly (learn
   first) and which are the hard bits (usually the solo) — a path, not a wall.
7. **The signature bits.** The main riff, the hook, the intro lick — the parts
   that *make* the song and that you most want to nail.
8. **What changes between repeats.** Verse 2 vs verse 1 (usually the same);
   the last chorus that lifts a key or adds energy; the fill that leads in.
9. **How to practise each part.** Loop it, slow it down, the common sticking
   point — wired straight into the tools the app already has.
10. **The transitions.** How one part connects to the next (a pickup, a fill,
    a drop-out), because the joins are where learners fall off.

This list is the feature's success criteria.

## 2. Interplay with "This Track" — two different questions

"This Track" (AI Assistant mode, `svc_this_track`) already exists and today
covers, in prose: band/release background; **"the song's structure and feel
from a listener's perspective"**; technical notes tied to detected
key/tempo/progression; writing process & lyrical meaning; notable
performances; similar songs. It's grounded lightly (title/artist + one line of
detected key/tempo/chords) and returns ~350–500 words of narrative.

The clean division:

| | **This Track** | **Song Structure** (new) |
|---|---|---|
| Question | "What *is* this song — its story?" | "How is this song *built* — how do I play its parts?" |
| Frame | Listener / fan / historian | Player learning the parts |
| Grounding | Mostly world knowledge (works even un-separated) | **The app's own detected analysis** of *your* audio (sections, chords, key, per-section dynamics) + world knowledge |
| Output | One narrative essay | An **interactive part-by-part map** you can jump/loop into |
| Interactivity | Read | Click a part → loop it in the Mixer/Play Along at practice tempo |

So they're complementary, not overlapping — *once we remove the overlap.*
**Change to This Track:** drop the "structure and feel" bullet from its prompt
down to a single sentence and have it defer the part-by-part detail to Song
Structure (and cross-link). This Track keeps the story (meaning, history,
performances, similar songs); Song Structure owns the arrangement/playing map.

**Shared plumbing (reuse, don't rebuild):** the Artist/Title card
(`svc_load/save_track_info`), the provider/API-key card + picker
(Claude/Google/Groq), the per-track result cache
(`_save_ai_assistant_result`), the real-world-knowledge caveat, and the
detected-analysis context helpers (`_optional_song_theory`,
`_summarize_chord_progression`). Cross-link both ways: This Track's structure
sentence → "See **Song Structure** for the part-by-part playing map"; Song
Structure's header → "Want the story behind this song? → **This Track**."

## 3. What we can ground it on (the honest backbone)

The app's ethos throughout: **deterministic detection is the trustworthy
skeleton; the LLM adds fallible, assistive interpretation** — same split as
the chord lane (detected) vs Lick Ideas (LLM), with the same "confirm by ear"
honesty and the same anti-hallucination lessons (the fabricated bar-numbers
bug in Lick Ideas: never let the model invent structural specifics we didn't
give it).

**Deterministic per-section facts we can compute with no LLM at all**, by
slicing existing analysis at each detected section's `[start, end)`:
- **Order, count, timing, repetition label** — straight from `sections`
  (A/B/C already mark "this part comes back").
- **Length in bars** — count `beats` inside the section ÷ beats-per-bar.
- **Chord progression of the part** — slice `chords` by time; collapse to
  runs; render letters + Roman numerals against the song key.
- **Key / tonal centre of the part** — run `key_from_chords` on just that
  slice (a chorus that lifts to the relative major shows up here).
- **Dynamics & instrumentation of the part** — per-stem RMS/energy in the
  slice (the same stems `detect_sections` already loads): "guitar + vocal
  only," "full band, drums enter," "everything drops but bass." This is the
  single most useful *detected* signal for "what's happening in this part,"
  and it's ours for free.

**What the LLM adds on top of that skeleton** (given the facts above + the
confirmed Artist/Title, so it's annotating *real detected sections*, not
inventing an arrangement):
- **Semantic names** for the A/B/C parts (Intro/Verse/Chorus/Bridge/Solo/
  Outro) — the model is good at this when handed the real repetition pattern
  and the song's identity.
- **What the guitar does** in each part (technique, rhythm-vs-lead, feel).
- **Difficulty** per part + a suggested **learning order**.
- **Signature-part** flags, **tuning/capo**, and **variation notes** (last
  chorus, etc.).

Grounding rule (hard requirement, from the bar-number bug): the LLM is given
the numbered, timed detected sections and must annotate *those*, by index —
it may name and describe them and flag a signature part, but it must not
invent sections, bar numbers, or times we didn't provide. Detected facts
(times, chords, dynamics) render as fact; LLM labels render as "best guess,
confirm by ear," visually distinct.

## 4. Spec

### 4.1 Backend: a deterministic structural summary
New `svc_song_structure(source_path, model)` (no LLM) returning, per detected
section: `{index, label, start, end, bars, key, progression_letters,
progression_roman, dynamics}` plus song-level `{key, tempo, time_signature?}`.
Pure function of the cached analysis + stems; returns `None` gracefully when
there are no confident sections (feature then falls back to §4.2's
knowledge-only mode, clearly flagged). This is independently useful and
shippable before any LLM work (M1).

### 4.2 Backend: the LLM enrichment pass
New `svc_song_structure_annotate(source_path, model, provider)`: builds the
§4.1 summary, then prompts the chosen provider with the confirmed
Artist/Title + the **numbered detected sections and their facts**, asking for
a JSON array keyed by section index: `{name, guitar_role, technique,
difficulty (beginner|intermediate|advanced), signature (bool),
variation_note}` plus song-level `{tuning, capo, form_summary,
learning_order (list of indices), overall_notes}`. Reuses the provider
callers, key loading, caching, and caveat. Prompt explicitly: annotate only
the given sections by index; if the real song's known structure disagrees
with a detected boundary, say so in `overall_notes` rather than silently
overriding the detected map. Merge deterministic facts (authoritative) with
LLM annotations (assistive) into one payload for the UI.

### 4.3 UI — the interactive part map

> **Update after real use:** SS-1 shipped as a new top-level AI Lab tab (the
> original recommendation below). After trying it, the home was moved to the
> alternative instead — **Song Structure is now a 6th AI Assistant mode**,
> sitting in the mode-toggle row between **This Track** and **This Artist**
> (not a separate tab). This fits the user's own mental model better: This
> Track answers "what's this song's story," Song Structure answers "how is it
> built / how do I play it" — the natural neighbour, not a peer of Scales/Rate
> My Take. The interactivity concern below (loop actions inside a "type →
> prose" mode) turned out not to be a problem in practice — the part list and
> its Jump/Loop buttons sit comfortably as their own mode card, reusing the
> shared provider/Artist-Title cards above it for the annotate step, with the
> base detected map needing neither. Implementation: `#ailab-ss-mode-card`
> inside `#ailab-lickideas-panel`, toggled by the existing generic
> `data-amode` click-wiring — zero new event-handling code needed.

Recommended home *(original write-up, superseded by the above)*: a **new AI
Lab tab "Song Structure"** (peer to Scales / Rate My Take / AI Assistant),
reusing the AI Assistant's Artist/Title + provider cards. (Alternative: a 6th
AI Assistant *mode* — lighter to build, shares the mode toggle, but its
interactivity/loop actions strain the "type → prose" pattern the other modes
share. Recommend the tab; see §6.)

- **Song header:** key · tempo · tuning/capo (LLM) · overall form (LLM) · a
  one-line "learning order" ribbon. A "🔎 This Track" link for the story.
- **Part list** (this is the section ribbon reborn as a vertical, richer
  thing — reuse `SECTION_COLORS` so a repeated part keeps its colour): one row
  per detected section, in order, showing —
  - colour swatch + **semantic name** (LLM) with the detected **A/B/C** and
    **time range · N bars** (detected);
  - **chords** for the part (detected) — letters, Roman numerals on toggle;
  - **key/tonal-centre** of the part if it differs from the song key
    (detected) — the "the chorus lifts to G" moment;
  - **what the guitar does** + **technique** (LLM), **difficulty** chip (LLM),
    a ★ **signature** flag (LLM), and a **variation note** on repeats (LLM);
  - **actions:** ▶ **Jump here** and ⟳ **Loop this part** — sets the Mixer/Play
    Along loop to the section's `[start, end)` (reusing the existing loop +
    Zoom-to-loop + Speed Trainer), so "learn this part" is one click into the
    tools already built. This is the payoff that a tab-site tab can't offer.
- **Follow-the-song** (optional, reuse the Scales-tab follow idiom): highlight
  the current part as the song plays.
- **Honesty:** detected facts unmarked; LLM annotations under one clear
  "AI-suggested — confirm by ear" caveat; the whole panel carries the same
  assistive framing as the chord lane. If sections weren't confidently
  detected, show the LLM's general-knowledge structure clearly labelled "from
  general knowledge of this song, not detected from your audio."

### 4.4 Where the hidden Mixer ribbon goes
The Mixer section ribbon stays retired; its renderer/CSS/`SECTION_COLORS` are
reused here instead. Optional later: a compact read-only strip of this map
back on the Mixer once the naming is trusted — but the interactive map lives
in AI Lab, which is where "learning the parts" work already happens.

### 4.5 `song_structure` result caching (real user report)
`song_structure` (backing_track.py) fully re-decodes every stem's audio via
librosa for its per-section RMS/dynamics pass — unlike `ensure_analysis`,
this had no caching at all, so re-opening or re-visiting Song Structure mode
re-ran that full decode from scratch every time. Reported alongside a real
browser freeze (a several-minute ripped song, freeze after loading Song
Structure, clicking away, and coming back) — not confirmed as the actual
freeze cause, but a genuine, repeated, avoidable cost on exactly that code
path regardless, so fixed either way: the result is now cached to
`structure.json` next to `analysis.json`, invalidated whenever the analysis
version or section count changes (the same contract `ensure_analysis`
already uses for the data this derives from). Measured on a short synthetic
test track: first call ~9s (mostly a cold `ensure_analysis`), every call
after that ~0.2ms.

## 5. Plan

| # | Milestone | Notes |
|---|-----------|-------|
| SS-0 | This spec — **shipped** | — |
| SS-1 | `svc_song_structure` deterministic summary + the part-map UI (no LLM): order, bars, per-part chords/key/dynamics, Jump/Loop actions — **shipped** | Independently useful; ships value with zero API-key dependency and zero hallucination surface |
| SS-2 | `svc_song_structure_annotate` LLM pass (names, guitar role, technique, difficulty, signature, learning order, tuning/capo) merged over SS-1 — **shipped** | Reuses provider/key/cache plumbing; JSON-out grounded on the detected sections by index; cached per track keyed to the section count |
| — | **Real user report, Claude-specific:** "The AI's reply wasn't valid JSON" — succeeded on Google/Groq, failed on Claude for the same song. Claude tends to be the most verbose of the three and/or adds closing commentary despite instructions not to; either could have (a) run the reply past the 1600-token budget, truncating the JSON mid-object with no closing brace to recover, or (b) confused the original naive "first `{` to last `}`" extraction once trailing prose itself contained a brace. Fixed both: `max_tokens` raised to 4000 (cheap, on-demand only); `_extract_json` now walks brace-depth from the first `{` (correctly ignoring braces inside quoted strings) to find the true end of the outermost object, then only falls back to repairing smart-quotes/trailing-commas if a strict parse of that still fails — never mutates a reply that already parsed cleanly. A genuinely truncated reply still correctly raises (no silent partial-data success) — **shipped** | Verified directly against the extraction function with six synthetic cases: plain JSON, Claude-style trailing prose containing a brace, smart-quote delimiters, a trailing comma, a genuinely truncated object (must still raise), and a code-fenced reply — all handled correctly |
| — | Relocated from its own tab to an AI Assistant mode (between This Track/This Artist) — **shipped** | See §4.3's update note; resolves §6's "home" decision |
| SS-3 | Trim This Track's structure bullet + cross-link both ways | Removes the overlap |
| SS-4 | Follow-the-song highlight; per-part "practise this" hooking Speed Trainer | Polish |
| Backlog | Compact read-only map back on the Mixer; export the roadmap to a practice-plan; per-part difficulty auto-tuned against Rate My Take history | — |

## 6. Decisions — resolved
- **Home:** ~~new tab~~ → **AI Assistant mode**, between This Track and This
  Artist (moved after real use — see §4.3's update note).
- **LLM dependency:** shipped SS-1 (detected-only, no key needed) first, then
  layered SS-2's LLM naming on top. Confirmed the right call — the base map is
  useful with zero setup.
- **Semantic names:** LLM name is primary once generated (Verse/Chorus/…),
  with the A/B/C colour badge kept as a secondary "which repeat is this" cue —
  as recommended.
