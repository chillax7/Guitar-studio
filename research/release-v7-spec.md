# Orpheus Guitar Studio — Release v7 Spec & Plan: stability, then honest closure

**Status:** written 2026-07-24, immediately after
[post-v6-backlog-audit.md](post-v6-backlog-audit.md) — that doc is the
map (what's shipped, what's open); this is the route (a coherent v7
subset with real gates and milestones), same relationship
release-v6-spec.md had to post-v5-backlog-audit.md.

**Companion docs:** [post-v6-backlog-audit.md](post-v6-backlog-audit.md)
(source list for everything picked or declined below), USER-MANUAL.md §8
(the two open freeze reports §1's investigation targets),
[market-review-2026.md](market-review-2026.md) (LAN mode's own case,
revisited honestly in §4), [tone3000-unblock-spec.md](tone3000-unblock-spec.md)
(§3's still-pending action), [release-v6-spec.md](release-v6-spec.md)
(§2's still-open validation items), appstore-plan.md (owns any future
native-app/distribution reversal — untouched by this doc).

---

## 0. The v7 thesis: nothing new until what's already built is trusted

Every release since v3 has added scope. v7 deliberately doesn't: three
release cycles in a row now (v4, v5, v6) have each landed real, shipped
features while leaving a small trail of "first build, not yet confirmed"
or "silently dropped, never resolved" items behind them —
post-v6-backlog-audit.md §5 catalogs the biggest one (BT-15's artifact
cleanup pass, dropped from every picked list for three releases without
ever being explicitly declined). That pattern is the actual signal v7
responds to, not a new feature idea.

Concretely, v7's headline is an **unresolved, real, user-reported browser
freeze** (USER-MANUAL.md §8) that's been sitting as "under active
investigation" since before this spec was written. This session
independently root-caused and fixed two *different* real crashes
(Speed/Tune's OOM, a memory-pressure diagnosis on separation) using the
same toolkit — live headless reproduction, memory profiling, before/after
measurement — that the freeze investigation's own prior attempt (a static
code review) didn't have available. That's not a coincidence to leave on
the table; it's the most directly-applicable skill this project has
demonstrated against exactly this bug class.

**Explicitly out of scope for v7, and why:**

- **Any new user-facing feature.** Not because none are worth doing (AI
  Lab's LLM tier, dual-IR cab blending, and others remain real ideas —
  see the specs that already describe them) but because this release's
  entire framing is closing debt, not opening more of it. First release
  since v3 to make that call directly.
- **Custom lead/rhythm ML model, Linux/Windows/native macOS app, BT-12
  gain automation, BT-18 batch operations** — release-v5-spec.md §9 and
  release-v6-spec.md §0 already gave these reasoning that hasn't
  changed; not re-litigated a third/fourth time.

---

## 1. Freeze investigation, round two — M, real gate

**The two open reports** (USER-MANUAL.md §8, restated exactly): (1)
muting/unmuting stems then soloing the guitar stem on a ripped song; (2)
using AI Lab's Song Structure mode, switching away, then back. Round one
(pre-v7) found and fixed a real performance bug in the second path
(song_structure()'s uncached re-decode) without confirming it was the
actual freeze cause, and a code review of the first path found nothing.

**What round two does differently:** reproduce first, diagnose second —
the exact order this session's two real fixes both used, and the order
round one's code-review-only attempt didn't have the chance to. Concretely:

- **Live repro in a headless browser** (`preview_eval` against a running
  server, the same tool this session used throughout) driving the *exact*
  reported sequences: rip a multi-minute song, separate it, then hammer
  mute/solo across stems in the reported pattern; separately, open Song
  Structure, switch screens, switch back, repeat.
- **Instrument, don't guess:** `performance.memory` sampled across the
  sequence (climbing = a leak, matching the manual's own "what to
  capture" note), plus watching for accumulating DOM nodes, event
  listeners, or AudioContext nodes the way `freeProcessedRedundantBuffers`
  this session proved out for the Tune crash.
- **If a genuine repro lands:** fix it, verify the fix under the same
  repro, same rigor as every fix this session shipped (measured
  before/after, not "looks fixed").
- **If it doesn't reproduce even with real effort:** that's still a
  real outcome, not a failure — document it as such (what was tried, what
  wasn't found, what would help if it recurs), replacing the manual's
  current "under active investigation" with an honest "investigated
  thoroughly, not reproduced" plus whatever mitigations got shipped along
  the way regardless.

**Gate:** either the freeze is reproduced and fixed (verified under the
same repro), or a documented, genuinely thorough second attempt is
recorded honestly as inconclusive — not left open a third time without
this release having actually tried the tool that's proven to work twice
already this project.

## 2. Close v6's own "first build, not confirmed" tail — S ×3

Three small, cheap validation passes, none of them new scope — just
closing what v6 shipped but couldn't fully confirm at the time:

- **V7-B1 = MIDI hands-free control, real-hardware pass.** The ordered
  footswitch should have arrived by now; confirm the Learn-mode mapping
  and forward/backward cycling against real hardware, not just simulated
  MIDI messages. Fix whatever a real pedal's channel/debounce/message-type
  quirks turn up.
- **V7-B2 = Looper pedal, sustained real-use pass.** A real practice
  session — long, many overdub cycles, at least one unusual loop length —
  exercising the path the spec itself flagged as unconfirmed.
- **V7-B3 = TONE3000 unblock — take the action.** Register for the free
  publishable key and send the two prepared questions
  (tone3000-unblock-spec.md) to support@tone3000.com. This is a real
  email a person has to send; if it's not going to happen, say so
  explicitly and retire `backing-track-tone-match-spec.md` Option A
  per that spec's own §4 decision rule, rather than carrying it into a
  fourth release as unexamined limbo.

## 3. Artifact cleanup pass (BT-15 / V5-B2) — M, timeboxed, decide-or-kill

Dropped from every picked list since v4 without ever being explicitly
declined (post-v6-backlog-audit.md §4) — the oldest unresolved item in
the entire backlog by release-count, not by age. v7 gives it the decision
it's been owed: either build it for real (same timebox and exit clause
every prior mention gave it — a week's effort, "ship nothing if it
doesn't audibly beat the raw stem") or explicitly kill it with real
reasoning, so it stops being the thing every future audit rediscovers.

## 4. LAN mode — a real decision, not a fourth deferral — S (decision), M+ if committed

release-v5-spec.md proposed a spec-only spike. release-v6-spec.md
declined even that, explicitly, on the grounds that a third consecutive
"maybe next release" was worse than a direct call
(post-v6-backlog-audit.md §3). v7 either follows through on that logic —
give it a real, final decision this release — or concedes that the
"biggest structural market gap" finding (market-review-2026.md) actually
does matter enough to build the spike. Either way, **this is the last
release this item gets deferred without a decision attached to it.**

**Spike question, if pursued:** does the Mac-does-ML / phone-is-thin-client
model actually work for this app's *live-rig* screens (Play Along, Tone
Lab) — where audio latency over a LAN is a much harder problem than the
Mixer/AI Lab screens — or does LAN mode only make sense as a
mixer-and-practice-log companion, not a full remote rig? That question
alone, answered honestly, is most of the value of finally doing the spike.

## 5. Small merges and cleanup — S

- **Fold CD-6's "mid-song key changes" into the existing "windowed/
  segmented key detection" backlog item** (release-v5-spec.md §9,
  restated in release-v6-spec.md §0) — same ask, two names; one heading
  going forward.
- **Fix the stale version string** — `#app-version` in index.html and
  USER-MANUAL.md's title both still read "v5" (post-v6-backlog-audit.md
  §5). Bump both once this release's own milestones close, as part of §6
  below rather than a separate pass.

## 6. A process commitment, continued (V7-P1)

release-v6-spec.md's V6-P1 (a doc-currency pass at the close of each
milestone) didn't catch the version-string staleness (§5) or the
Artifact-cleanup silent drop (§3) — both process gaps, not feature bugs.
**Extending the commitment for v7:** at the close of each milestone below,
in addition to the existing doc-currency check, explicitly re-read
*this document's own §0–5* and confirm nothing here has been silently
dropped the way BT-15 was — a five-minute self-check against the exact
failure this release exists to fix.

---

## 7. v7 milestones

- **M0 — Freeze investigation, round two (§1).** *Gate:* reproduced-and-
  fixed, or a genuinely thorough documented "not reproduced." Leads
  because it's the release's actual headline and the only item with a
  real user-facing bug still live.
- **M1 — Close v6's unconfirmed tail (§2): MIDI hardware, Looper
  sustained use, TONE3000 action.** Three independent S items, can run
  in parallel with each other and with M0.
- **M2 — Artifact cleanup pass, decide-or-kill (§3).**
- **M3 — LAN mode, a real decision (§4).** Either the spike gets built
  and answered, or the item is retired with real reasoning — no third
  outcome.
- **M4 — Small merges + version-string fix (§5), folded into the M0–M3
  close-out per §6's process commitment rather than run as its own pass.**
- **Stretch, not committed:** the separation peak-memory reduction spike
  (post-v6-backlog-audit.md §4) — pull forward only if M0 finishes early,
  since it shares this release's "verify before trusting" spirit but
  isn't a live bug the way M0 is.

Each milestone ends the way every release since v4 has: docs updated,
honest commit messages, push, a real user run-through before the next
milestone starts — and, per §6, a check that this document itself hasn't
gone stale in the meantime.
