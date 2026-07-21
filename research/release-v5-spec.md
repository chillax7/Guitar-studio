# Orpheus Guitar Studio — Release v5 Spec & Plan: AI Lab + closing the v4 debt

**Status:** §§0–8 are the original planning document, written 2026-07-15
after v3.2 shipped (title bar consistency, practice mode, take compare,
`split-guitar --method hybrid` — see
[post-v3-backlog-audit.md](post-v3-backlog-audit.md) and the git history
around that tag). Since then, v4.5 shipped chord detection/lane,
playlists, and the practice log, and v4.6 shipped multi-stem import and
Rip (see [post-v4-backlog-audit.md](post-v4-backlog-audit.md) §1/§3) — so
AI Lab's prerequisite (§1, chord lane) is done, and most of the *other*
things release-v4-spec.md left open are not. That audit's own closing
note (§5) asked for "a V5 spec [that picks] a coherent subset of §4... the
same way release-v4-spec.md picked V4-F1/F3/F4 out of a longer list, with
real gates and milestones" — **§§9–10 below are that step**, folding AI
Lab and the still-open backlog into one release plan rather than leaving
them as two separate documents nobody sequences against each other.

**Companion docs:** [release-v4-spec.md](release-v4-spec.md) (§3's V4-F1 —
chord lane's original scoping, absorbed into §1 below),
[rate-my-take-spec.md](rate-my-take-spec.md) (the other place "note-level
pitch feedback" was explicitly punted — see §4's cross-reference),
[backing-track-tone-match-spec.md](backing-track-tone-match-spec.md) (a
sibling AI idea — NAM-library tone matching — that lives on the Play Along
side, not AI Lab; not re-scoped here),
[post-v3-backlog-audit.md](post-v3-backlog-audit.md),
[post-v4-backlog-audit.md](post-v4-backlog-audit.md) (source list for
§9's picks), [custom-stems-spec.md](custom-stems-spec.md) (pre-v5 addition,
scoped as its own point release rather than a v5 milestone),
[ui-review-and-tonelab-redesign.md](ui-review-and-tonelab-redesign.md) and
[rig-preset-chain-spec.md](rig-preset-chain-spec.md) (concrete designs for
the Tone Lab redesign and GP-14, both candidates for §9's milestone list —
not yet slotted in below, see each doc's own "fit" section),
[free-distribution-license-audit.md](free-distribution-license-audit.md)
(unrelated to feature work — the pre-friends-testing license check).

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

**Known limitation, found post-ship (v4.6 user feedback): riff-heavy songs
over-fragment the ribbon.** On a riff-based track — Iron Maiden's "Phantom
of the Opera" is the flagged example — the chord lane reads as very busy:
short, rapidly-alternating chips (e.g. "Em E7 E" across a few beats) where
a guitarist would hear one underlying chord/rhythm-part idea, not several.
Root cause is `detect_chords` in `backing_track.py` classifying each beat
independently (maj/min/7 templates, no temporal smoothing) against a
single-frame chroma window — a moving riff or palm-muted chug shifts chroma
content beat-to-beat enough to flip the best-matching template even when
the underlying harmony hasn't actually changed. Two candidate fixes,
neither implemented yet: (a) backend smoothing — require a chord to hold
for a minimum span (e.g. a full bar) before switching, via majority vote
across beats, the more correct fix but touches the analysis pipeline and
needs re-running detection on real tracks to judge; (b) client-side same-
root merging in `renderChordLane` (app.js) — collapse adjacent short runs
that share a root but differ in quality, cheap to ship but risks papering
over real chord changes along with the noise. Worth a scoped look before
or alongside §2 (Scale/Mode Advisor), which depends on chord-lane regions
being clean enough to anchor a scale suggestion to.

**Update: promoted to its own spec.** A second real user report ("way
too busy and doesn't reflect the chords being played") plus a genre
diagnosis (power-chord rock has no template to land on, so labels
flicker between false maj/min) turned this from a scoped look into a
proper rebuild — see **research/chord-detection-v2-spec.md** for the
field research (Chordify/Chord ai/Moises, Chordino/NNLS, madmom,
MIREX), the diagnosis, and the plan: Viterbi temporal smoothing (the
(a) fix above, done the way the whole literature does it rather than
majority vote), a power-chord "5" template, bass-stem-anchored roots,
and cleaner chroma. Agreed acceptance song: "Too Much, Too Young, Too
Fast" (Airbourne). The spec's CD-0 (AI Lab scales follow playback) has
already shipped.

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

## 2a. Layout note: Per-chord vs. Whole-song view (from mockup review)

Mockup review (three candidate layouts, all built against a real 24-fret
fretboard renderer and real interval math) surfaced a second, complementary
view worth building alongside the per-chord one §2 above describes: a
**Per chord / Whole song** toggle. Per-chord is §2 as scoped. Whole-song
shows the scales for the song's overall key instead of one chord at a
time — the more useful default for a lot of soloing, since most of a song
sits in one key regardless of which chord is currently ringing.

The mockups also tested the case the user specifically flagged: a song
that doesn't hold one key the whole way through (e.g. "Livin' on a
Prayer"'s modulation up a whole step into the final chorus). Rather than
either hiding a real key change or blending two keys into a meaningless
average, Whole-song mode should split into separate labeled key regions
when one is detected, each with its own scale set — same honesty idiom as
everything else in this app (assistive, confirm by ear, say so when it's
uncertain).

**Backlog, not scoped into V5-F2 itself:** today's `detect_key` in
`backing_track.py` returns exactly one key for the whole track — there is
no windowed/segmented key detection to actually notice a mid-song
modulation. Building that is real, separate work (sliding-window chroma
key detection, with a real decision rule for when a shift is a genuine key
change worth splitting on vs. normal harmonic wandering that should stay
one region) — see §9's backlog list. V5-F2 ships Whole-song mode against
the single whole-track key `detect_key` already provides; the key-region
splitting UI shown in mockups is the target once windowed key detection
exists, not blocked from shipping in the meantime (a song with no detected
change just renders as one region, which is what most songs will do
anyway).

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

**Update — delivered as a panel instead of CLI-only.** Same underlying
judgment call ("genuinely useful, specific-to-this-song phrasing advice,
or generic filler") either way; the user asked for a real place to paste
an API key and try it directly rather than a terminal command, which is a
faster path to actually running the gate against real songs, not a
different gate. Shipped as AI Lab's third tab, **Lick Ideas**:
- An API key field (Anthropic, Claude Haiku — the cheap tier §7 costed
  out) that saves to `GuitarStudio/projects/_settings.json` (gitignored,
  never echoed back to the client once saved — `GET /api/settings`
  reports only whether one exists).
- A "Get phrasing ideas" button + optional free-text style/genre tag that
  sends the current song's detected key/tempo/chord-progression (text
  only, run-length-collapsed the same way the chord lane already
  displays it — never raw audio, per §7) to `/api/lick/suggest`, which
  calls the Anthropic Messages API server-side and returns the
  suggestion text plus the exact key/tempo/progression it was given (so
  the user judging the output can see precisely what the model saw).
- This is still the ungated research spike, not a finished feature —
  the actual gate (blind comparison against the user's own phrasing
  instincts, across 3 real songs) is a human judgment call the UI can't
  make for itself, same as Rate My Take's own §6 gate. Outstanding.

**Update — first real API call, one real bug found and fixed.** Ran it
against a real song (guitar+bass stems + real chord detection from this
same session's chord-detection-v2 work, "Too Much, Too Young, Too Fast" —
A major, 115 BPM, A7-B7-A5-E7-A5-G5-...). Content was genuinely
progression-specific, not generic filler (a half-step-bend idea on the
A7→B7 change, a call-and-response shape over the A5/G5 repetition, a
minor-pentatonic pivot at the F#m) — encouraging for the gate. But it
confidently cited specific bar/measure numbers ("bar 7", "bars 9-14")
that were **fabricated** — the prompt only ever sent a flat chord
sequence with no bar/timing information at all, and the model silently
assumed one chord entry = one bar (not necessarily true) and stated that
guess as fact. Fixed by explicitly telling the prompt there's no
bar/measure data and to reference moments by chord name/context instead
("over the A7 to B7 change") — re-verified against the same song/prompt:
suggestions stayed specific and useful, no more invented bar numbers.
Still only one real song tested this way (via direct API calls to sanity
-check the plumbing, not through the actual UI) — the real 3-song gate
still needs the user trying it in AI Lab against songs they know well.

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

## 8. AI Lab milestones (original §8, kept as the feature-internal sequence)

- **M1 — Chord detection & lane (§1 / V5-F1).** *Gate:* useful and
  accurate on 3 real songs of different styles. **Shipped in v4.5** —
  gate cleared; kept here for the record.
- **M2 — AI Lab screen shell + Scale/Mode Advisor (§2 / V5-F2).** New
  fourth nav button, screen chrome matching the existing Mixer/Tone
  Lab/Play Along pattern. *Gate:* correct, useful scale suggestions for any
  chord in a real song's lane, zero network dependency. **Shipped** — Per
  chord and Whole song modes, 24-fret fretboard diagrams, live Tune-slider
  transposition; gate to be confirmed against 3 real songs per the usual
  process, see §2a for the Whole-song/windowed-key-detection follow-up.
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

---

## 9. Closing the pre-v5 debt: picks from post-v4-backlog-audit.md §4

AI Lab is one screen's worth of work; it isn't the whole release. This
section names what else v5 carries, chosen the same way release-v4-spec.md
picked its four backlog items — weighing effort against payoff, favoring
things that close long-open gaps or pair naturally with what's already
shipping this release — and just as importantly, says what's *not* picked
and why, so it doesn't get silently re-proposed next time.

**V5-B1 = Rate My Take completion — S (gate) then L (build), oldest debt
in the project.**
The CLI scoring spike (`backing_track.py rate`) works and is verified, but
per post-v4-backlog-audit.md §2 the actual go/no-go judgment — recording
three real takes (tight / sloppy / tasteful-variation) of a part the user
knows and checking the scores against their own ears — was never done.
This is a near-zero engineering cost, user-shaded task that's been owed
since v4.5, and it gates the biggest single feature left on any backlog:
if it passes, R1b/c (capture pipeline + timeline heatmap UI,
rate-my-take-spec.md §§3–4) is a real, scoped L build; if it fails, the
honest outcome is to stop, not force it. Goes first in the milestone order
below precisely because it's cheap to resolve and blocks a real
prioritization decision either way.

**Update, first real go/no-go attempt:** the first three real takes
recorded came back within ~1% of each other, with the deliberately-varied
take scoring *highest* — looked like a scoring-algorithm problem at first,
but the actual cause was upstream of the algorithm entirely. Play Along's
existing take recorder (Record tab) deliberately mixes the backing track
in with the guitar (so a take is watchable/listenable as a normal
performance) — comparing that against the reference guitar stem is really
comparing the reference to itself-plus-your-playing, which trivially
inflates and flattens every take's agreement together regardless of
actual performance quality. Fixed by adding a dedicated "dry" recording
path (guitar rig output only, no backing track) alongside R1b/c's UI
build below, rather than treating this as a scoring-tuning problem it
never was. The go/no-go itself is still pending — needs re-running against
dry recordings of the same three takes.

R1b/c itself ended up landing sooner than a strict go/no-go gate would
normally allow, since building the real capture+scoring UI was the
fastest way to fix the dry-recording gap the go/no-go attempt surfaced —
shipped as AI Lab's second tab, "Rate My Take" (USER-MANUAL.md §6.2),
reusing every piece of the CLI spike (`score_take`/`refine_offset`/
`_render_rate_heatmap`) via a new `/api/rate/score` endpoint rather than
re-implementing any of the scoring math for the browser. AI Lab's own
screen (§2 above) grew a top tab bar to host it (Scales / Rate My Take,
Close aligned right) rather than a fifth nav button — same screen, same
"same mental context" reasoning §0 gives for AI Lab existing as one
screen at all.

**Update, scoring felt too harsh once dry recordings made it possible to
actually tell takes apart:** with contamination fixed, real dry takes
finally discriminated — but the score itself still felt punishing on
ordinary, non-sloppy playing. Two causes, both in `score_take`'s per-beat
math rather than the calibration constants: the ±80ms timing window fell
off linearly (a lag at half the window already cost half the score —
punishing normal human timing feel, not just genuine sloppiness), and
pitch agreement was computed from raw chroma with no tolerance for
vibrato (two independent vibrato sweeps on the intended note don't line
up bin-for-bin, reading as a wrong note even when a listener hears the
same one — nobody's vibrato is going to match the reference recording's
exactly). Fixed: widened the window to 150ms with a squared (not linear)
falloff — a 40ms lag went from costing half the score to costing under
10%; and a small circular smoothing kernel blurs each chroma bin into its
semitone neighbors before comparing pitch. The 60/40 pitch/timing
weighting itself was deliberately left unchanged — both were reported as
about right, it was the underlying leniency of each that needed adjusting.
The RMT go/no-go call is still outstanding, now with a scoring pass more
likely to match real playing.

**Update, the vibrato leniency overcorrected:** a genuinely bad take
(wrong notes, not just normal variation) came back around 50% when it
should have scored closer to 5%. Rather than guess at constants blind, a
Pitch/Timing breakdown was added to the score result (both the API
response and the AI Lab UI) so a surprising overall number can be
diagnosed instead of just observed. A synthetic test (notes shifted 1-4
semitones off, no real vibrato) then showed the vibrato-smoothing kernel
from the previous update was the main culprit: at its original strength
it inflated a wrong-note pitch score from 0.68 (no smoothing) to 0.84,
while realistic ±30-50 cent vibrato scored ~0.98-0.99 either way and
barely benefited from smoothing at all — only unrealistic 70-100 cent
mistuning showed real benefit. The kernel was weakened substantially
(keeping a small margin for that extreme case without meaningfully
blurring wrong notes into right ones); the same synthetic bad-take
scenario improved from 66.6% to 42.7%, a measured but not necessarily
complete fix — synthetic pure-tone tests likely don't fully capture real
guitar harmonic content, so the next real dry-take retest (now with the
breakdown visible) is what actually closes this out.

Also added, once it became clear finding "where the solo starts" without
leaving the screen mattered in practice: a small Backing Track card on
Rate My Take (Play/Stop/Loop/Count-in + a new scrub timeline), the same
mirrored-transport idiom the Mixer/Play Along already share — and the
same timeline slider was added to Play Along's own Backing Track card
too, which never had one before this. A **Use current position as
Offset** button turns "scrub to the spot, then read off the seconds and
type them in" into one click.

**V5-B2 = BT-15/V4-F6 · Artifact cleanup pass — M, timeboxed.**
Post-separation cleanup on the guitar stem specifically. Picked *because*
it's scheduled alongside Rate My Take completion this release — a
cleaner reference stem directly raises RMT's scoring quality (the same
link release-v4-spec.md §3 originally called out). Keeps its original
timebox and exit clause: a week's effort, ship nothing if it doesn't
audibly beat the raw stem.

**V5-B3 = GP-11 + GP-14 · MIDI foot controller + multi-preset cycling —
M each, paired.**
Both "never started," both about the same thing — hands-free control of
the live rig — and post-v4-backlog-audit.md §4 already notes they'd
"pair naturally." This is the practice-workflow gap that's been open
since the *original* v4 spec (release-v4-spec.md §3, V4-F5) and is a
real, felt gap vs. AmpliTube/Neural DSP-class products, not a nice-to-have.
GP-14's main open question (click-suppression on a live mid-song preset
swap) gets scoped as part of this milestone, not assumed away.

**V5-B4 = VD-07 · Social export presets — S.**
Pure ffmpeg presets (9:16, 1:1, normalized web export) over an existing
take file — cheap, self-contained, "just never picked up" per the audit.
Included as the release's low-risk quick win, the same role BT-01/BT-05
played in the v0.4 picklist.

**Explicitly not picked for v5, and why (so it isn't re-proposed):**

- **GP-06 Looper pedal (L)** — real gap, but big enough to deserve its own
  milestone rather than being squeezed in alongside AI Lab and RMT
  completion. First candidate for a v6 release, not dropped.
- **BT-12 gain automation, BT-18 batch operations** — "deferred, not
  dead" since the original backlog with no new urgency; still parked.
- **TONE3000 community tone-matching (Option A/B/C)** — blocked on
  confirming API terms; can't be scheduled until that's resolved, so
  scheduling it now would just be aspirational.
- **Custom lead/rhythm ML model** — post-v4-backlog-audit.md §4 already
  says "leave it there," and multi-stem import (v4.6) reduces how often
  it's even needed. No change here.
- **Linux/Windows/LAN mode, native macOS app** — real, and Linux in
  particular is "the cheapest item on this entire list by effort," but
  it's a distribution-track decision (appstore-plan.md's territory), not
  a feature-release one. Keeping it out of v5 keeps that separation clean
  rather than letting platform work quietly become a feature-release
  dependency.
- **V5-F4 solo-skeleton generator, V5-F5 basic-pitch transcription** —
  already correctly scoped by §8 as gated/independent; no change, just
  not pulled forward into the committed list above.
- **Windowed/segmented key detection (new, from §2a's mockup review)** —
  needed to make AI Lab's Whole-song mode actually split a modulating song
  (e.g. a "Livin' on a Prayer"-style key change) into separate key regions
  instead of reporting one key for the whole track. Real, self-contained
  analysis work (sliding-window chroma key detection over `detect_key`'s
  existing single-key approach, plus a real decision rule for "genuine key
  change" vs. normal harmonic wandering) — logged here rather than
  blocking V5-F2's ship, since Whole-song mode degrades honestly to "one
  region" without it.

## 10. Unified v5 milestones (supersedes §8's ordering — §8's content is
unchanged, this just sequences it against §9)

- **M0 — Rate My Take go/no-go (V5-B1's gate).** Record and judge the
  three takes. *Blocking-but-cheap: do this first.* Gate: honest
  pass/fail per rate-my-take-spec.md §6. **In progress** — first attempt
  surfaced the dry-recording gap (V5-B1's "Update" note above), not yet
  re-run against dry takes.
- **M1 — AI Lab: Scale/Mode Advisor (§8's M2 / V5-F2).** Chord lane
  prerequisite already shipped; this is the first genuinely new v5 build.
  **Shipped** — see §8's M2 note.
- **M2 — Rate My Take R1b/c (V5-B1's build) — only if M0 passed** — run
  in parallel with M3 if effort allows, since neither depends on the
  other. **Shipped ahead of M0 passing** (see V5-B1's "Update" note) —
  the UI/capture build turned out to be the fix for M0's own blocker, not
  something worth waiting on a formal gate for; the go/no-go judgment
  call itself is still outstanding.
- **M3 — AI Lab: LLM spike + Explain-this chat (§8's M3/M4).** *Gate:*
  §3's blind-comparison call.
- **M4 — Hands-free rig: MIDI + multi-preset cycling (V5-B3).**
- **M5 — Polish: Social export presets (V5-B4) + Artifact cleanup pass
  (V5-B2, timeboxed).**
- **Stretch, time-permitting, not committed:** basic-pitch transcription
  spike (§8's M5 / V5-F5).

Each milestone still ends the §8 way: docs updated, honest commit
messages, push, user run-through before the next one starts.

---

## 11. v4.7-checkpoint revision: market review + latency workstream (2026-07-20)

Two inputs landed after §§9–10 were written: a market functionality
review ([market-review-2026.md](market-review-2026.md)) and a live-rig
latency deep-dive done at the same checkpoint. Changes to the plan, in
the same pick/decline format as §9:

**Already shipped with v4.7 (context, not work):** the latency
deep-dive's software half is done — `latencyHint: 0` on the shared
AudioContext (output callback halved: baseLatency 5.3ms→2.7ms, reported
outputLatency 16ms→8ms on the reference machine), a `latency: {ideal: 0}`
input constraint, and the Tone Lab estimate reworded to say honestly that
it measures the output side only and to surface the context sample rate
(the user-checkable half: set the interface to the context's rate, and
prefer the interface as BOTH input and output device so neither side
resamples). What remains is *measurement*, which is the v5 item below.

**V5-B5 = GP-13 · Measured round-trip latency (S, hardware-gated) —
promoted to committed.** Loopback ping: play a short click out the
current output, capture it back through the enabled input, cross-
correlate for the true round-trip number, shown next to (and shaming)
the browser estimate. Needs the interface physically looped or its
direct-monitor path — the UI must say so plainly rather than silently
measuring the acoustic path through the room. Market justification:
every serious native rival treats measured latency as table stakes;
honesty justification: it closes the one dishonest-by-omission number
left in the app. Slot into **M5** (it's small) or earlier if the felt-
latency complaints continue.

**V5-S1 = LAN-mode spec spike (S — spec only, no build).** The market
review's top structural finding: mobility is the biggest competitive
gap (Moises's edge), and LAN mode converts it into a local-first
differentiator instead of a cloud concession. v5 writes the short spec
(auth posture on LAN, which screens work at phone size, does live-rig
audio even make sense remotely or is this mixer/practice-only); v6
decides whether to build. Keeping it spec-only keeps §9's "platform work
doesn't quietly become a feature dependency" separation intact.

**V5-S2 = Song-section detection (M) — stretch, behind AI Lab.** Verse/
chorus segmentation over the existing beat grid + chroma, rendered as a
loopable sections lane. Same local-heuristic lineage as BT-02/BT-04,
directly serves the core practice loop ("loop the solo" without hand-set
markers), and matches a shipped Moises capability. Stretch because the
committed list is already full; first candidate to pull forward if a
milestone finishes early.

**TONE3000 unblock-or-drop (task, not milestone):** the community
library is now 6500+ models with an official player ecosystem — big
enough that "blocked on API terms" should be resolved by actually
asking, once, this release. Outcome either converts
backing-track-tone-match-spec.md Option A into a schedulable item or
retires it; both beat carrying it as permanent limbo.

**Declined from the market review (recorded so they stay declined):**
mobile-native apps (LAN mode is the answer; appstore-plan.md owns any
reversal), lessons/curriculum, cloud sync/collab, licensed tab catalog —
see market-review-2026.md §3 for the reasoning on each.
