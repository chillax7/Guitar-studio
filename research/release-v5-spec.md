# Orpheus Guitar Studio — Release v5 Spec & Plan: AI Lab

**Status:** planning document, written 2026-07-15 after v3.2 shipped (title
bar consistency, practice mode, take compare, `split-guitar --method
hybrid` — see [post-v3-backlog-audit.md](post-v3-backlog-audit.md) and the
git history around that tag). **Note on sequencing:**
[release-v4-spec.md](release-v4-spec.md) was written and never built — the
project detoured into v3.1/v3.2 hardening and enhancement work instead of
Rate My Take/chords/looper/playlists/practice log/MIDI. This doc does not
silently supersede that plan. It specifically **adopts V4-F1 (chord
detection & chord lane) and re-homes it here** as AI Lab's foundational
prerequisite, because chord data is the one thing every feature below
needs. The rest of v4 — Rate My Take, looper, playlists, practice log, MIDI
foot controller — stays exactly where release-v4-spec.md left it: open,
unbuilt, un-resequenced. Whether that work happens before, after, or
interleaved with v5 AI Lab is a separate product call, not decided here.

**Companion docs:** [release-v4-spec.md](release-v4-spec.md) (§3's V4-F1 —
chord lane's original scoping, absorbed into §1 below),
[rate-my-take-spec.md](rate-my-take-spec.md) (the other place "note-level
pitch feedback" was explicitly punted — see §4's cross-reference),
[backing-track-tone-match-spec.md](backing-track-tone-match-spec.md) (a
sibling AI idea — NAM-library tone matching — that lives on the Play Along
side, not AI Lab; not re-scoped here),
[post-v3-backlog-audit.md](post-v3-backlog-audit.md).

---

## 0. The v5 thesis: one screen, two different things both called "AI"

A fourth persistent screen alongside Mixer / Tone Lab / Play Along, reusing
the same nav-row/overlay chrome (`.nav-screen-btn`, `.screen-overlay`,
`.screen-header` — see [styles.css](../GuitarStudio/static/styles.css) and
the title-bar work in the v3.2 session). Framing decision made up front,
because "AI" is doing two very different jobs in this doc and blurring them
is exactly how a feature like this rots into unfalsifiable hype:

- **Tier 1 — deterministic music theory.** Given a detected chord (from the
  chord lane, §1) and the song's key (BT-03, already shipped), work out
  which scales/modes fit — table lookup and interval math, not a model
  call. Zero marginal cost, zero reliability risk, works offline forever.
  It lives on this screen because it's the same mental context (explore
  what to play over what's happening right now), not because it needs a
  neural net. Most of this screen's actual day-to-day usefulness comes from
  this tier.
- **Tier 2 — LLM-assisted suggestion.** A cheap text-only LLM reasons over
  the same chord/key/tempo data to suggest phrasing ideas, target notes, or
  plain-language explanations ("why does this scale work here"). Text and
  conceptual output only — never generated audio, never an auto-played
  guitar part. Same honesty posture as every heuristic already in this app
  (USER-MANUAL.md §14, the split-guitar/chord/key confidence caveats
  throughout `research/`): every suggestion is labeled as a suggestion,
  the user is always the one who has to actually play it, and a bad
  suggestion should read as "huh, that one's off" rather than being
  presented as authoritative.

**Explicitly out of scope for v5, and why:**

- **Full audio-generated solos** (MusicGen-class models). Produces audio
  the user would then have to *transcribe by ear* to learn — backwards for
  a practice tool whose whole point is the user playing it themselves.
  Also heavy GPU cost and real licensing complexity for anything beyond
  personal use. If this ever happens, it's its own spec, not a v5 line
  item.
- **Note-perfect AI-generated tab of an original solo.** This needs actual
  generation quality, not the reasoning-about-existing-theory strength
  LLMs currently have. §3 below scopes the honest, smaller version of this
  ambition (a rough skeleton, explicitly not a finished performance) and
  gates it hard on §3's own research spike.

---

## 1. Prerequisite: chord detection & chord lane (V5-F1, adopted from V4-F1) — L

Unchanged from release-v4-spec.md §3's original scoping, restated here
because everything else in this document depends on it existing:

> Beat-synchronous chroma → template matching (maj/min/7 to start) → chord
> lane above the ruler, transposing live with the Tune slider. Beat grid
> (BT-02) and chroma extraction (BT-03) already exist in
> `backing_track.py`, which is what makes this newly cheap rather than a
> from-scratch project. Honesty note in the UI ("assistive, best on
> pop/rock"). Guitar-only lens: template set and voicing display favour
> guitar keys and capo suggestions, not generic lead sheets.

*Gate (same one release-v4-spec.md already specified for this exact
deliverable):* chord lane reads as useful and accurate on 3 real songs of
different styles, judged by ear, before anything in §2 onward gets built
on top of it.

## 2. Scale/Mode Advisor — Tier 1, deterministic (V5-F2 · M)

The AI Lab screen's actual MVP, and the reason chord detection had to come
first. For whichever chord region the playhead (or a click on the chord
lane) is currently in:

- Compute the scales/modes that fit — start with the obvious set (major/
  minor/pentatonic/blues over the detected root+quality, modal options
  where the chord quality supports more than one reading) rather than
  trying to be exhaustive on day one.
- Show it on a guitar-shaped fretboard overlay (box/position shapes), not
  staff notation — matches the guitar-only lens the rest of the app already
  commits to (chord voicings, capo suggestions, the octave-only Tune range,
  etc.).
- Transposes live with the Tune slider, same as the (not-yet-built) chord
  lane itself.

No model, no API key, no network call, no per-use cost — this is straight
interval arithmetic over data the chord lane already computed. It should
work identically offline forever, and it's the one part of this whole spec
that can't go stale, get rate-limited, or start costing money.

*Gate:* a guitarist can land on any chord in a real song's chord lane and
get a correct, useful scale suggestion without leaving the screen.

## 3. Lick/Phrasing Assistant — Tier 2, LLM (V5-R1 · M, research-spike-gated)

Send the chord progression + key + tempo (+ optionally a loose genre/style
tag) to a cheap text LLM and ask for phrasing ideas: target notes to land
on, call-and-response shapes, "try leaning on the 6th here," or a
plain-language "why" behind a Tier 1 suggestion. Rendered as short text or
highlighted scale degrees on the §2 fretboard overlay — **not** audio,
**not** auto-generated tab the user is meant to just copy.

**Research spike first, same phased-gate pattern as Rate My Take
(rate-my-take-spec.md §Phase R1a):** before building any UI around this,
run it CLI-only against 3 real songs' real chord progressions and honestly
judge the output. Does it read as genuinely useful, specific-to-this-song
phrasing advice, or generic "try the pentatonic scale" filler that any
Tier 1 lookup already said? LLMs reason fine about music theory in the
abstract; whether that reasoning stays useful and non-generic against real
chord progressions from real songs is exactly the unproven part.

*Gate:* on a blind comparison against the user's own phrasing instincts (or
a human teacher's, if available) across those 3 songs, the suggestions have
to earn their keep — genuinely additive, not just correct-but-obvious. Fail
this gate and §5's stretch goal (solo-skeleton generation) is dead, not
deferred — if the LLM can't produce useful phrasing *ideas*, it has no
business attempting a *skeleton*.

## 4. "Explain this" chat panel (V5-F3 · S/M, ships only if §3's gate passes)

A small conversational panel grounded in the current song's key/chords/
tempo: "why does this scale work here," "what's a ii–V–I," "what's the
difference between this mode and that one." Reuses §3's LLM plumbing
entirely — no new integration work, just a different prompt shape and a
chat-style UI instead of a suggestion card. Pedagogical framing rather than
a generation feature: it's meant to answer questions, not write parts.

## 5. Stretch, hard-gated: solo-skeleton generator (V5-F4 · XL, punt by default)

The "build a full solo" ambition from the original conversation, scoped
down to something honest: not a finished performance, a rough starting
skeleton (a handful of target notes/phrase shapes across the progression)
the user edits and fills in themselves. **Explicitly does not get built
unless §3's research spike clears its gate with real margin** — this is
the single hardest, least-reliable piece of the whole document, and
building it on an unproven phrasing model would be the "impressive demo,
useless in practice" failure mode this project's whole documentation
culture is built to avoid. If §3 passes, re-scope this properly as its own
follow-up spike rather than assuming this paragraph is sufficient design.

## 6. A free/local, non-generative sibling worth doing regardless: audio-to-tab transcription (V5-F5 · L)

Not really "AI Lab" in the generative sense, and it has no dependency on
§1's chord lane — flagging it here because it's the other side of the
"what free/cheap AI is actually available now" question, and because it
closes a gap this project's own docs already flagged and shelved:
rate-my-take-spec.md explicitly punted "note-level pitch feedback"
("you played F# not G") as needing "transcription, a different (much
larger) project." That larger project now has a free, open, local answer:
[basic-pitch](https://github.com/spotify/basic-pitch) (Spotify, MIT
license, runs offline, converts audio → MIDI/note events). Worth a scoped
evaluation independent of the rest of this document:

- Run it against a few real recorded takes and a few isolated guitar
  stems; judge transcription accuracy honestly (polyphonic guitar is hard
  for *any* pitch tracker — chords, string bends, and palm-muted chugs are
  the likely failure modes, same kind of honest limitation section every
  other heuristic in this app already carries).
- If it's good enough, it feeds **two** existing features at once: real
  note-level Rate My Take scoring (upgrading past chroma-only comparison),
  and — back on this screen — "what scale was that riff actually in,"
  turning a played phrase into a Tier 1 lookup instead of a manual one.

*Gate:* transcription accuracy on real guitar material (not the library's
clean demo audio) is good enough that a wrong note reads as rare, not
constant — same "judge by ear, don't oversell the heuristic" bar as
everything else in this codebase.

## 7. Cost and privacy — the actual "free or low-cost" answer

- **Zero-cost, fully local, forever:** §2 (Scale/Mode Advisor) and §6
  (basic-pitch transcription). Neither needs a network call or an API key.
  These two are the parts of this spec that don't compromise the "local
  and private" differentiator release-v4-spec.md §0 already staked out.
- **Low-cost, needs a network call:** §3/§4 (LLM plumbing). A chord
  progression + key + tempo is a handful of tokens — even a cheap-tier
  model (Claude Haiku class) prices this at fractions of a cent per
  request; realistic personal practice-session usage lands at pennies a
  month, not a subscription-scale cost. This is the **first real external
  network dependency** in an otherwise fully local/private app, which is
  worth being honest about rather than glossing over:
  - Opt-in, not on by default — AI Lab should work (Tier 1 only) with zero
    network calls for anyone who doesn't want them.
  - Send only the derived musical data (chords/key/tempo/genre tag), never
    raw audio — keeps the actual exposure small even when enabled.
  - Consider a local-model escape hatch (Ollama + a small open-weights
    model) as a user-facing setting for anyone who wants the LLM tier
    without any network call at all — lower suggestion quality almost
    certainly, but it keeps the "everything can be fully local" promise
    intact for whoever cares. Worth a spike alongside §3's research spike,
    not necessarily worth building both paths on day one.

---

## 8. Milestones

- **M1 — Chord detection & lane (§1 / V5-F1).** *Gate:* useful and
  accurate on 3 real songs of different styles.
- **M2 — AI Lab screen shell + Scale/Mode Advisor (§2 / V5-F2).** New
  fourth nav button, screen chrome matching the existing Mixer/Tone
  Lab/Play Along pattern. *Gate:* correct, useful scale suggestions for any
  chord in a real song's lane, zero network dependency.
- **M3 — LLM plumbing + research spike (§3 / V5-R1).** *Gate:* the honest
  blind-comparison call in §3 — pass or the rest of the LLM-tier work
  (§4, §5) doesn't happen.
- **M4 — "Explain this" chat (§4 / V5-F3).** Only reached if M3 passes;
  reuses M3's plumbing entirely.
- **M5 — basic-pitch transcription spike (§6 / V5-F5).** Independent
  track, no dependency on M1–M4 — can run in parallel or even before them.
  *Gate:* accuracy bar in §6.
- **M6 — Stretch, re-approved separately: solo-skeleton generator (§5 /
  V5-F4).** Not scheduled by default. Only becomes a real milestone if M3
  cleared its gate with real margin, and even then needs its own follow-up
  spec, not just this section's paragraph.

Each milestone ends the usual way: update USER-MANUAL.md/CLI.md for
whatever shipped, honest commit messages, push, user run-through before
the next milestone starts.
