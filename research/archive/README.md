# Archived research docs

Moved here from `research/` on a cleanup pass — these are shipped, superseded,
or otherwise no longer active reference material, sorted by why.

## Shipped features (spec's job is done)

- `custom-stems-spec.md` — shipped v4.7
- `multi-stem-import-spec.md` — shipped v4.6
- `rig-preset-chain-spec.md` — shipped v4.7
- `system-audio-rip-spec.md` — shipped v4.6
- `ui-review-and-tonelab-redesign.md` — Tone Lab redesign shipped v4.7
- `measured-latency-spec.md` (GP-13) — shipped, reviewed
- `social-export-presets-spec.md` (VD-07) — shipped; confirmed live in `recorder.js`
- `looper-pedal-spec.md` (GP-06) — shipped, reviewed, since fixed for a
  per-quantum allocation bug
- `rate-my-take-spec.md` (V4-R1) — shipped, calibrated twice against real data
- `ai-lab-song-structure-spec.md` and `song-section-detection-spec.md` — shipped
  as SS-1 through SS-4 (`svc_song_structure` in `server.py`, the AI Lab tab in
  `ailab.js`/`app.js`)
- `chord-detection-v2-spec.md` — CD-1 through CD-5 all appear resolved in the
  doc's own text (the CD-5 confidence-margin fix is described in past tense
  with measured numbers). **Flagging this one for a quick sanity check** — it's
  the one archival call here made from the document's own narrative rather
  than from a corroborating shipped-feature line elsewhere.
- `video-recording-spec.md` — **its own header still says "no code has been
  written," which is stale and worth fixing at the source if anyone reuses this
  pattern.** `recorder.js` opens with "per video-recording-spec.md" and
  implements the camera + MediaRecorder pipeline the spec describes in full.

## Completed research/audits (the question was answered, not left open)

- `market-review-2026.md` — explicitly "a snapshot, not a living doc"
- `ui-review-v5-full.md` — completed v5-checkpoint review; its mockups moved
  here alongside it (`mockups/`)
- `free-distribution-license-audit.md` — completed ahead of friends-testing
- `neural-engine-audit.md` — completed, with a stated conclusion ("the engine
  itself checks out")

## Superseded planning documents

Each of these was the active plan at its own checkpoint; the checkpoint after
it (or a backlog audit) is what actually carries forward whatever was left
open, so these are historical rather than current:

- `post-v3-backlog-audit.md` → superseded by post-v4's
- `post-v4-backlog-audit.md` → superseded by post-v5's
- `post-v5-backlog-audit.md` → superseded by post-v6's (kept active — see below)
- `release-v0.4-spec.md`, `release-v3-spec.md`, `release-v4-spec.md`,
  `release-v5-spec.md`, `release-v6-spec.md` — each release fully checkpointed;
  release-v7-spec.md (kept active) is what actually carries their few residual
  open items forward now

## Abandoned direction (never built, and no longer relevant to what was)

- `prototype-spec.md`, `ui-spec.md` — the original native SwiftUI +
  AVAudioEngine macOS app plan. Never built; the actual app went a different
  way (vanilla JS/Web Audio over a Python server) after the mid-project data
  loss. Kept for history, not as a live reference.
- `backing-track-tone-match-spec.md` — the original two-stage product vision
  behind the abandoned native plan. Step 1 shipped, differently than
  described; Step 2 (live tone matching) also happened, differently, via the
  amp-modeling/NAM path rather than the architecture this doc assumed.
- `engine-spec.md` — specified the engine as it was before the app was
  rebuilt around the browser; long since superseded by the actual, much more
  extensively iterated engine.

---

## Left active in `research/` (not archived, on purpose)

- `guidesep-evaluation.md`, `guitar-separation-upgrade-spec.md`,
  `lead-rhythm-split-research.md` — one open research thread (is a real
  ML-trained lead/rhythm guitar split worth building); `guidesep-evaluation.md`
  ends by saying the bigger question "stays open pending step 3."
- `tone3000-unblock-spec.md` — research is done, but the actual next action
  (a real-world ask to TONE3000) is explicitly still pending.
- `post-v6-backlog-audit.md` — the current map of what's shipped/open,
  directly cited as a source by `release-v7-spec.md`.
- `release-v7-spec.md` — the current active release plan.

`research_review.docx` was left in place too — a binary I didn't open, so I
can't vouch for whether it's current. Worth a quick look before deciding
where it belongs.
