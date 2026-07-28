# Market Review — Guitar Studio vs. the field (July 2026)

**Status:** written at the v4.7 checkpoint, feeding the v5 planning pass
(release-v5-spec.md §11). The job here is honest positioning: what this
app already does that nothing else combines, what the market does better,
and which gaps are worth closing vs. explicitly conceding.

**Method note:** product/pricing claims below come from a July 2026 web
check (sources at the bottom) plus each product's own site; this is a
snapshot, not a living doc. Re-verify before basing distribution or
pricing decisions on it.

---

## 1. The competitive frame: nobody else is playing this exact game

Every competitor covers a *slice* of what Guitar Studio does; none covers
the combination. The app's real positioning is the **closed practice
loop, fully local**: import/rip a song → separate stems → build a backing
mix → play along through a real amp rig → record/rate/log the practice.

| Capability | Guitar Studio | Moises | Chordify / UG Pro / Songsterr | Anytune / deCoda | NAM ecosystem (Gateway, LA Studio) | AmpliTube / Neural DSP |
|---|---|---|---|---|---|---|
| Stem separation | ✅ local (BS-RoFormer / Demucs) | ✅ cloud, tiered by sub | ❌ | ❌ | ❌ | ❌ |
| Mixer / per-stem EQ+pan / export | ✅ | partial | ❌ | ❌ | ❌ | ❌ |
| Speed/pitch practice tools | ✅ | ✅ | partial | ✅ (its whole job) | ❌ | ❌ |
| Chord detection | ✅ local | ✅ | ✅ (Chordify's whole job) | partial | ❌ | ❌ |
| Live amp rig (NAM + IR + pedals) | ✅ in-browser | ❌ | ❌ | ❌ | ✅ (its whole job) | ✅ (native, paid) |
| Recording / takes / compare | ✅ | ❌ | ❌ | ❌ | ❌ | partial (DAW-ish) |
| Practice log / playlists | ✅ | partial | partial | ❌ | ❌ | ❌ |
| System-audio rip | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Fully local / private / no sub | ✅ | ❌ ($3.99–9.99/mo) | ❌ (sub) | mostly | ✅ | ❌ (license) |
| Mobile / tablet | ❌ | ✅ (its biggest edge) | ✅ | ✅ | partial | partial |
| Tab / notation | ❌ | ❌ | ✅ (UG/Songsterr's whole job) | partial | ❌ | ❌ |
| Community content library | ❌ (local NAM/IR files only) | ❌ | ✅ (tabs) | ❌ | ✅ (TONE3000, 6500+ models) | ✅ (presets) |

Two structural observations:

- **Moises is the closest single competitor** and validates the demand
  for the separation-plus-practice-tools bundle — at $3.99–9.99/month,
  cloud-only, with guitar-specific stems gated behind the Pro tier. Guitar
  Studio's answer is category-different: local, private, unlimited, free,
  plus an entire live-rig half Moises doesn't attempt. The gap Moises
  wins on is **mobile** and zero-install onboarding.
- **The NAM ecosystem exploded in exactly the direction this app bet
  on** — TONE3000 at 6500+ community models, an official Gateway player,
  and even a browser-based NAM DAW (LA Studio) proving in-browser
  real-time amp sim is now a recognized category, not a curiosity. Guitar
  Studio's in-browser NAM engine is no longer novel *per se*; the moat is
  its integration with the practice loop (play along with the separated
  song through the rig, tone-match against the backing track), which no
  NAM player has.

## 2. Gaps worth closing (candidates, sized, cross-referenced)

1. **Measured latency, not estimated (GP-13 · S).** Pro-audio users judge
   a live rig by its round-trip feel; the browser can't report input-side
   latency at all (playalong.js `paShowLatencyEstimate` is honest about
   this now). A loopback ping — play a click out, capture it back through
   the interface, cross-correlate — turns "trust me" into a number. Every
   serious native rival has this; it's small, and it directly serves the
   app's existing honesty culture. **Recommended: pull into v5.**
2. **LAN mode (M)** — the strategic answer to "no mobile app" without
   betraying the local-first thesis: the Mac does ML + serving, any
   phone/tablet browser on the LAN is a thin practice client. Already
   sketched in post-v4-backlog-audit.md §4 as unscoped; the market review
   upgrades its priority — it converts the single biggest competitive
   weakness (Moises's mobility) into a differentiator (your stems, your
   tones, on your couch, no cloud). Needs its own short spec first
   (auth-on-LAN posture, which screens make sense on a phone).
3. **Song-section detection (verse/chorus lane) (M).** Moises ships
   sections; practically it's what you loop. The beat grid + chord lane
   already exist as inputs; a segmenter (novelty detection over chroma,
   e.g. librosa's segment API) is a contained, local, honest-heuristic
   addition in the BT-02/BT-04 lineage. Candidate, not committed.
4. **Tab/notation** — the UG/Songsterr moat. basic-pitch transcription
   (V5-F5) is the already-planned seed; full interactive tab is **not**
   worth chasing (a content/licensing business, not a feature).
   V5-F5's scope stands unchanged.
5. **Community tone content** — TONE3000 integration
   (backing-track-tone-match-spec.md Option A) remains blocked on API
   terms; the market data (6500+ models, official guides) says the
   library is now big enough that this is worth actively resolving
   rather than passively parking. Action: actually ask them, then decide.

## 3. Gaps explicitly conceded (so they stop haunting the backlog)

- **Mobile-native apps** — LAN mode is this project's answer; App Store
  economics and a second codebase are not (appstore-plan.md owns any
  change of heart).
- **Lessons/curriculum** (Yousician, Guitar Tricks) — different product.
- **Cloud sync/collaboration** — antithetical to the local-private
  thesis. The GitHub repo + OneDrive folder sync covers the personal
  case (with the TCC caveat learned in v4.7 — see build_app.sh's log
  comment).
- **Full song-library licensing** (UG's tab catalog, Moises's catalog
  integrations) — the import/rip model deliberately keeps this the
  user's own responsibility.

## 4. What this changes for v5 (summary handed to release-v5-spec.md §11)

- Pull **GP-13 measured latency** into the committed list (S, pairs with
  the v4.7 latency work already shipped: `latencyHint: 0` context,
  input-latency constraint, honest output-only estimate wording).
- Add **LAN-mode spec spike** (S — write the spec, don't build yet) so
  v6 can commit to it with eyes open.
- Add **section detection** as a stretch candidate behind the committed
  AI Lab work — same lineage, same honesty posture.
- Unblock-or-drop **TONE3000**: one email/API-terms check this release;
  stop carrying it as permanently "blocked."
- Everything else in the existing §9/§10 plan stands unchanged.

## Sources

- [Moises pricing/features review (July 2026)](https://stemsplit.io/blog/moises-ai-review)
- [Moises official](https://moises.ai/)
- [Neural Amp Modeler official](https://www.neuralampmodeler.com/)
- [TONE3000 NAM guide](https://www.tone3000.com/guides/neural-amp-modeler)
- [NAM ecosystem guide (gearnews)](https://www.gearnews.com/neural-amp-modeler-guide-guitar/)
- [Browser real-time NAM (LA Studio)](https://la-studio.cc/en/blog/guitar-amp-browser-realtime-nam)
- [Chordify alternatives comparison](https://www.guitarchalk.com/best-chordify-alternatives/)
- [Anytune](https://www.anytune.app/)
- [Ultimate Guitar vs Chordify feature review](https://guitardoor.com/ultimate-guitar-or-chordify-top-features-reviewed/)
