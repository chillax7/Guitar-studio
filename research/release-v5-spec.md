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

**Update — provider picker.** User request: choose between Claude
(Anthropic), Google AI Studio (Gemini), and Groq (Llama) rather than
being locked to Anthropic — the latter two have a genuinely free tier,
which matters for a feature whose whole premise is "cheap enough for
casual practice-session use" (§7). Every provider still needs its own
key (a free tier isn't "no key"); `server.py`'s `LICK_PROVIDERS` maps
each to its own settings field and default model
(`claude-haiku-4-5-20251001` / `gemini-2.5-flash` /
`llama-3.3-70b-versatile`) and its own small API-calling function

**Update — Gemini's pinned model got cut off, switched to Google's own
alias.** Real user report on the first actual try: `gemini-2.5-flash`
came back 404, "no longer available to new users... update your code to
use a newer model" — well before its own posted deprecation date, per
Google's own developer forum reports of the same thing happening to
other API users. Google's model lineup rotates faster than this spec's
own update cadence can track by hand (Gemini 3.5 Flash GA'd in May 2026,
2.0 Flash shut down June 2026, 2.5 Flash cut off for new users earlier
than announced) — pinning a dated model string here is a recurring
maintenance trap, not a one-time fix. Switched to `gemini-flash-latest`,
Google's own maintained alias for whatever their current fast/cheap tier
is, so this stays working across their rotation without a code change
each time. Not independently re-verified against a real key from this
session (the report came from the user's own machine) — worth confirming
it resolves cleanly next time Lick Ideas is tried with Google selected.

**Update — Groq's Cloudflare front end was blocking the request itself,
not rejecting the key.** Next real try, this time against Groq: 403
"error code: 1010". That's a Cloudflare bot-block code, not a Groq auth
or quota error — Cloudflare was rejecting the request on its default
Python urllib User-Agent (`Python-urllib/3.x`), before it ever reached
Groq's own API logic. Added an explicit `user-agent` header
(`OrpheusGuitarStudio/5.0 (+lick-ideas)`) to all three providers' HTTP
requests, not just Groq's, since Anthropic's and Google's endpoints could
plausibly start doing the same fingerprinting later. Same caveat as
above: not independently re-verified against a real Groq key from this
session.
(`_call_anthropic`/`_call_google`/`_call_groq` — Anthropic's Messages
API, Google's Generative Language API, Groq's OpenAI-compatible chat
completions endpoint). The prompt itself is identical regardless of
provider — the gate question doesn't change with which model answers
it. AI Lab's Lick Ideas tab gained a provider dropdown; switching it
swaps the key-status check, placeholder, and "where to get a key" hint
to that provider specifically, with each provider's key stored and
checked independently (verified: saving a key under one provider leaves
the others' status untouched). This is a genuine opportunity to run the
real 3-song gate against more than one model cheaply, not just against
Claude.

## 4. LLM assistant panel: Explain This + Practice Tips (V5-F3 · S/M, ships only if §3's gate passes)

**Scoping update, post-M0/M2 shipping — two modes, one panel, not two more
tabs.** AI Lab's tab bar is already three tabs deep (Scales / Rate My Take /
Lick Ideas); a literal reading of §3's "Explain this" idea plus a new
"Practice Tips" idea below would make five. Instead of tab sprawl,
consolidate all three LLM-backed features (Lick Ideas, Explain This,
Practice Tips) into Lick Ideas' existing tab, renamed **AI Assistant**, with
a small mode selector at the top (same idiom as the provider dropdown
already there) swapping only the prompt-building and input area — the
provider/API-key section above it is genuinely shared and stays as-is.
Nothing about the underlying plumbing changes: same `LICK_PROVIDERS`, same
three `_call_anthropic`/`_call_google`/`_call_groq` functions, same
per-provider stored key, same "derived song data only, never raw audio"
privacy posture (§7). Only the prompt text and the input widget change per
mode.

**Mode 1 — Explain This.** A free-text question box grounded in the
current song's key/chords/tempo: "why does this scale work here," "what's
a ii–V–I," "what's the difference between this mode and that one." A row
of a few clickable example prompts (not a fixed menu — just prefills the
box) lowers the "what do I even ask" barrier without pretending this is a
curated set of pre-baked questions. Single-shot Q→A to start, not a full
multi-turn conversation with retained history — same phased-gate instinct
as everything else here: prove a single grounded answer is actually useful
before taking on conversation-state complexity (context window growth,
"does turn 3 still remember the key") for a second version that may not be
needed. Reuses §3's fabricated-bar-number fix (the prompt already tells
the model there's no bar/measure data) since a free-text question is just
as likely to invite a confidently wrong "bar 12" answer as a phrasing
suggestion was.

**Mode 2 — Practice Tips.** The one mode that isn't just Lick Ideas with a
different prompt — it's the direct payoff of shipping Rate My Take (V5-B1)
and Lick Ideas (V5-R1) as the same release: grounds its prompt in *this
user's own* Rate My Take result for the current song, not just the song's
static key/chords/tempo. Concretely: pull the take's per-beat pitch/timing
scores (already computed by `score_take`, already surfaced as the heatmap),
identify the weakest few beat regions, and summarize them by time and
which side (pitch vs. timing) drove the low score — the same breakdown a
guitarist already reads off the heatmap, just handed to the LLM as text
instead of a color. Prompt asks for concrete practice exercises tied to
those specific weak spots ("the timing drop around 0:45-0:52 suggests
practicing that phrase at half speed with a metronome before rejoining
tempo") rather than generic "practice scales" filler — same "does this
feel specific or generic" honesty bar §3 already applies to phrasing
ideas. Degrades honestly, not silently, when there's no take to ground on:
if the current song has no Rate My Take result yet, the mode stays
selectable but its button is disabled with an explanatory hint ("record
and score a take first") rather than falling back to generic advice
dressed up as personalized — a fallback that quietly gets worse defeats
the entire point of this mode existing as something-other-than-Lick-Ideas.

**Gate:** both modes ship under §3's same blind-comparison gate — genuinely
additive over the user's own instincts, not correct-but-obvious filler.
Practice Tips carries an extra bar on top: the practice suggestions have to
demonstrably trace back to this take's actual weak beats (a guitarist
should be able to look at the heatmap and the tip and see the connection),
not just be generic technique advice that happens to be true of most
solos.

**Update — both modes built.** User's call: build it now rather than wait
for §3's gate to formally close first — same "M2 shipped ahead of M0"
precedent this release already set for Rate My Take, not a new departure.
Delivered exactly as scoped above: the Lick Ideas tab (renamed **AI
Assistant**) grew a mode-toggle row (Lick Ideas / Explain This / Practice
Tips) rather than two more tabs, sharing the provider/API-key card;
`server.py` grew `svc_explain_ask` and `svc_practice_tips` alongside the
existing `svc_lick_suggest`, all three calling the same
`_call_anthropic`/`_call_google`/`_call_groq` functions and sharing one
extracted `_NO_BAR_NUMBER_INSTRUCTION` (the fabricated-bar-number fix
originally found for Lick Ideas — worth re-checking on the other two
modes' first real answers, since a free-text question or a weak-beat
timestamp summary is just as capable of inviting a confidently wrong "bar
12" as a chord progression was). Practice Tips re-scores the selected take
server-side on each request (`score_take`/`refine_offset`, the same path
`/api/rate/score` uses) rather than trusting any client-cached result, and
turns the per-beat breakdown into a short weak-region summary
(`_summarize_weak_beats`: contiguous low-scoring beats merged into
regions, only the take's own worst third kept, each tagged with whichever
side — pitch or timing — actually drove the low score) — the same read a
guitarist already gets off the heatmap, handed to the LLM as text instead
of a color. Verified with a headless browser pass: mode-toggle switching
shows/hides the right cards with no console errors, example-prompt pills
correctly prefill the question box, and both new endpoints
(`/api/explain/ask`, `/api/practicetips/suggest`) return clean 400 errors
(not stack traces) for a missing song/take. **Not yet verified:** an
actual real-key, real-song run of either mode (this sandbox has no
separated song or dry take to test against) — and §3's own blind-
comparison gate still hasn't been run for Lick Ideas itself, so neither
new mode has cleared it either. That real-use judgment call is still the
next real gate, same as it's been since Lick Ideas first shipped.

## 4a. Real-world context modes: This Track, This Artist, and Ask AI absorbing Explain This (new)

**A genuinely different trust boundary from every other AI Assistant mode
so far.** Lick Ideas, Explain This, and Practice Tips only ever ground
their prompt in *locally-derived* data (this song's own detected key/
chords/take scores) — the model is reasoning over facts the app itself
already computed, so a bad answer reads as a bad musical judgment call,
something the user's own ear/eye can immediately weigh. This Track and
This Artist ask something categorically different: real-world facts about
a real band, a real guitarist, real gear, real lyrics — pulled from the
model's own training data, not anything this app computed. That's genuine
hallucination risk on claims the user generally *can't* verify locally at
all (a fabricated "notable performance," a guitarist's gear misattributed,
a made-up detail about the writing process) — a different failure mode
than "this phrasing suggestion is kind of generic," and it deserves a
correspondingly more explicit caveat than this doc's existing "judge it
honestly" framing, which assumes the user *can* judge. Both modes carry a
standing, visible disclaimer along the lines of "treat specifics here
(dates, quotes, gear, credits) as a starting point to verify, not a
citation" — not the same "generic vs. specific" honesty question the
other three modes ask.

**Metadata gap.** Neither mode can work off a guess at "what song is
this" — the app has no artist/title metadata today, only the raw
filename, and real filenames in this project have been messy
(`Empty_Rooms__Gary_Moore.mp3__dry_03.m4a`). Cheapest real fix: a
one-time **Artist / Title** field, stored per-song (same project-file
idiom as everything else per-song), pre-filled with a best-effort guess
parsed from the filename but always user-editable — not silently trusted.
This field is what actually gets sent, not the filename itself.

**This Track.** One button, no free-text input (same "click and get info"
idiom as Lick Ideas/Practice Tips) — asks about this specific song: band/
release background, structure and feel from a listener's perspective,
technical notes, the writing process and lyrical meaning *where it's
actually publicly known and not disputed* (explicit instruction against
reproducing full lyrics verbatim — copyright, not just style — commentary
and short-fragment quoting only), notable performances/recordings worth
hearing, and recommendations for similar songs/solos. Grounds the prompt
in the Artist/Title field plus whatever locally-detected key/tempo/chords
already exist (same context Lick Ideas already sends) so the "technical
notes" part can stay tied to what's actually in the audio, not just
generic trivia.

**This Artist.** Same one-button idiom, scoped to the guitarist rather
than the song: general gear and style, signature sound and licks, and —
the genuinely useful tie-in — gear hints specific enough to point toward a
NAM capture search (e.g. "arguably closest to a certain amp/pedal
combination" rather than a vague "warm overdriven tone"). Explicitly not a
promise of exact tone-matching (that's TONE3000's territory, §5's sibling
idea, already blocked on API terms) — just pointing a real practice
decision (which capture to actually try) in a more informed direction than
guessing blind.

**Ask AI, absorbing Explain This.** The user's own framing for this mode's
system prompt — "a world-leading music theorist, historian, and virtuoso
guitar player, answering questions about the music, this track, and this
artist, not general subjects" — is a strict superset of Explain This's
original scope (song theory only). Rather than ship a fourth/fifth
near-duplicate chat box, **Ask AI replaces Explain This** (same free-text
box, same example-prompt idiom, same single-shot no-history posture — see
§4's original Update for why that scope cut was deliberate) with a
broadened, explicitly-scoped system instruction: answer questions about
this song/artist/music theory in general, and *decline* off-topic
questions rather than answer them anyway — a real guardrail, not just a
persona flavor, worth testing directly (ask it something obviously
unrelated and confirm it actually declines rather than politely answering
anyway).

**Mode count, revisited.** Lick Ideas + Ask AI + Practice Tips + This
Track + This Artist is five modes sharing one toggle row — worth watching
once built for whether the row still reads cleanly (wraps to a second line
acceptably) or needs a dropdown instead of a button row; not a blocking
concern, just flagged before it's built rather than discovered after.

**Gate:** same standing bar as every other mode here, but framed for what
these two actually risk — not "is this a genuinely useful suggestion" but
"are the specific, checkable claims (dates, names, gear, quotes) actually
accurate," judged against whatever the user happens to already know about
the artist, plus a couple of spot-checks against an outside source for
anything that mattered. A mode that's engaging but frequently wrong on
checkable facts is worse than one that's honestly generic — accuracy on
real claims is the bar here, not novelty.

**Update — built.** Same "M2 shipped ahead of M0" / "M3 shipped ahead of
its gate" precedent this release keeps setting: user's call to build
straight after scoping rather than wait. Delivered as scoped:

- A new **This song** card (Artist/Title, above the mode toggle) — filled
  from `svc_load_track_info`/`svc_save_track_info`, stored in a new
  `_track_info.json` keyed by the same content-hash `project_path_for`
  already uses (so a renamed file still finds its saved info, same as
  every other per-song state in this app). The Title field prefills from
  `_guess_title_from_filename` — deliberately crude (strips this
  project's own real messy suffixes like `__dry_03.m4a`, then just
  cleans up underscores) rather than attempting a real artist/title
  split, since a wrong confident guess is worse than an honest rough one
  the user has to fix anyway.
- `svc_this_track`/`svc_this_artist` — both use `_optional_song_theory`
  (a non-raising twin of `_song_theory_or_raise`) so locally-derived
  context is bonus grounding, not a hard requirement the way Lick Ideas'
  stems-must-exist check is; This Track/This Artist only strictly need
  the Artist/Title field, since real-world background doesn't need any
  audio analysis at all.
- `svc_ask_ai` **replaces** `svc_explain_ask` outright (not additive) —
  same single-shot/no-history posture, broadened with the user's own
  verbatim guardrail persona ("world-leading music theorist, historian,
  and virtuoso guitar player... not general subjects"), and now also
  takes Artist/Title as optional context alongside key/tempo/chords.
- Route renamed `/api/explain/ask` → `/api/ask/ai`; new
  `/api/thistrack/info`, `/api/thisartist/info`, and `/api/trackinfo`
  (GET to load, POST to save). Mode toggle grew from 3 to 5 buttons
  (Lick Ideas / Ask AI / Practice Tips / This Track / This Artist) — the
  "watch for row-wrapping" flag above turned out to be exactly the right
  instinct to raise before building, not after.
- `_REAL_WORLD_KNOWLEDGE_CAVEAT` sent to the model (including the
  no-verbatim-lyrics instruction) *and* returned to the client, rendered
  as its own standing disclaimer line above the answer — not folded
  silently into the answer text, so it can't be scrolled past unnoticed.

Verified with a headless browser pass (all 5 modes toggle their cards
correctly, no console errors) and real HTTP round-trips against this
sandbox's own server: `_guess_title_from_filename` correctly cleaned up
this project's actual messy real filenames (confirmed against
`Empty_Rooms__Gary_Moore.mp3__dry_03.m4a` specifically); a real
save/reload of Artist/Title round-tripped correctly; and a real call to
`/api/ask/ai` with this sandbox's own (now-invalid) saved Anthropic key
reached Anthropic's actual API and cleanly surfaced their real 401
response — confirming the whole request path works end to end, even
though the key itself couldn't be used to judge answer quality. **Not
yet judged:** actual answer quality/accuracy for any of the three new
real-key-dependent behaviors (This Track's factual accuracy, This
Artist's gear-hint usefulness, Ask AI's guardrail actually declining
off-topic questions) — all three need a real run with a working key,
same as Lick Ideas/Practice Tips already did.

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
  - **§4a's exception, stated plainly:** This Track/This Artist also send
    only text (an Artist/Title string, plus whatever's already
    locally-derived) — the "never raw audio" privacy claim above still
    holds fully. What's different is the *answer's* provenance: these two
    modes exist specifically to pull the model's own general knowledge
    about a real band/guitarist, not just have it reason over data this
    app computed. That's not a privacy compromise, but it is a reliability
    one worth naming separately from the rest of this list — see §4a's own
    gate for the distinction.

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

**Update, real three-take test surfaced a genuine chroma-fallback bug in
the pitch score itself:** three real dry takes (same solo, real
recordings) scored 58.3% / 1.7% / 99.3% overall — the worst take correctly
landed near zero, but its own displayed Pitch/Timing breakdown (51%/63%)
still read as far more generous than a listener would call it, and the
best take's 99.3% overall felt inflated for something judged "good but not
that good." Root cause, confirmed directly on these three takes' own
per-beat data: whenever pyin can't get a confident monophonic reading on
both sides (chords, palm mutes, near-silence — the majority of beats on a
sloppy take specifically, since sloppy playing is what breaks a clean
monophonic read), pitch scoring falls back to plain chroma cosine
similarity, and that fallback turned out to be nearly uninformative — the
bad take's own fallback-beat scores ran 0.60-0.98 (mean 0.84), barely below
the good take's 0.72-0.99 (mean 0.95). Raw chroma vectors from real guitar
audio share enough broadband harmonic energy that cosine similarity
between almost any two clusters high regardless of whether the notes
actually match — the same coarseness already known from whole-take chroma
comparison, resurfacing in this fallback path specifically. Fixed by
sharpening each (already vibrato-smoothed) chroma vector via
`RATE_CHROMA_SHARPEN_POWER` (element-wise power before the cosine
similarity, exponent 4) before comparing — picked by directly measuring
power 1/2/4/8 against these three takes' actual fallback-beat scores: power
4 pulled the bad take's fallback mean from 0.84 to 0.33 while the good
take's stayed clearly separated at 0.77; power 8 over-sharpened and
started collapsing every take's fallback scores toward zero regardless of
quality, losing the separation it's meant to create. Re-checked the
self-vs-5s-offset sanity test from the earlier Update against the guitar
stem itself: chroma-fallback-only similarity dropped from a mean of 0.67
(unsharpened) to 0.44 (sharpened) — real improvement, though chroma's
inherent harmonic-overlap ceiling means it still won't reach the ~0% a
confident monophonic reading gets on the same test; that residual
looseness is expected to remain, since the fallback only ever engages for
non-monophonic content in the first place.

`RATE_CALIBRATION_FLOOR`/`CEILING` were deliberately left untouched by this
fix — the raw-score distribution for any take leaning on the chroma
fallback almost certainly shifted, so those two constants likely need
re-tightening, but not against this session's own re-scoring of the three
takes (done with a guessed, not the app's actual, offset per take — not
trustworthy enough to calibrate against). Needs the same three real takes
re-run through the app itself (correct per-take offset) before floor/
ceiling get touched again.

**Update, second real calibration pass, this time from the app itself:**
the same three takes, re-run post-sharpening-fix with the app's own correct
offset, came back bad 0% / good 16% / best 85.2%. User's own ears: bad
"could score a few percent higher" (not literal 0%), good "should be over
50% at least", best "OK, could be up to 90%" — the mapping was still off,
just in a different direction than before (previously too generous,
sharpening pushed it slightly too harsh on the low-mid end). The good and
best takes' raw scores are recoverable exactly from their non-clamped
percentages against the old 0.55/0.80 mapping (0.59 and 0.763); the bad
take's isn't (it was clamped at 0%, only bounded above by the *old* floor,
which no longer means anything post-sharpening). Floor/ceiling re-solved
from the two known-exact raw values against targets of ~55%/~88% (deliberate
headroom past the user's literal "over 50%"/"up to 90%" phrasing, same
bracketing-not-exact-fit approach as every calibration pass here) ->
floor 0.30, ceiling 0.83. Also added `overall_raw` to the AI Lab UI itself
(next to the Pitch/Timing breakdown) specifically so the next calibration
pass doesn't need a guessed reproduction or a dev-tools round trip to get
raw numbers — it's just on screen already.

**Update — M0 gate PASSED.** User's verdict on this calibration pass,
unprompted: "OK I'm happy with this, it's deffo a go decision for rate my
take and I think we have a real USP here." V5-B1 is done — see §10's M0
entry. Left open for whenever real use surfaces it: the bad take's exact
percentage under this final mapping was never explicitly re-confirmed
number-by-number (the user's judgment was a holistic "happy with this,"
not a re-statement of the bad take's new percent) — not blocking, just
worth keeping in mind if a future take's score looks off, now that
`overall_raw` is on screen to check against.

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
  pass/fail per rate-my-take-spec.md §6. **PASSED.** Real dry takes
  (bad/good/best of the same solo) re-scored post-sharpening-fix and
  second calibration pass (V5-B1's "Update" notes above) came back
  0%/16%/85.2%, and the user's own judgment on the result: "deffo a go
  decision... I think we have a real USP here." Closes the oldest open
  gate in the project — R1b/c (M2 below) already shipped ahead of this,
  and this is the honest go/no-go catching up to it.
- **M1 — AI Lab: Scale/Mode Advisor (§8's M2 / V5-F2).** Chord lane
  prerequisite already shipped; this is the first genuinely new v5 build.
  **Shipped** — see §8's M2 note.
- **M2 — Rate My Take R1b/c (V5-B1's build) — only if M0 passed** — run
  in parallel with M3 if effort allows, since neither depends on the
  other. **Shipped ahead of M0 passing** (see V5-B1's "Update" note) —
  the UI/capture build turned out to be the fix for M0's own blocker, not
  something worth waiting on a formal gate for. M0 has since passed (see
  above), so this is no longer ahead of its own gate, just was for a
  while.
- **M3 — AI Lab: LLM spike (Lick Ideas) + AI Assistant panel's two new
  modes, Explain This and Practice Tips (§8's M3/M4, scoped as one
  consolidated panel in §4's Update).** *Gate:* §3's blind-comparison call.
  **Shipped ahead of the gate** (see §4's "both modes built" Update) — same
  precedent as M2/M0 earlier in this release. The gate itself is still
  outstanding for all three modes (one real song tested via direct API
  calls for Lick Ideas, not yet the real 3-song judged gate in the UI for
  any of them) — that real-use judgment call is the next thing blocking
  this milestone from being truly closed out, not the build.
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
