# Free-Distribution License Audit (friends-testing checkpoint)

**Status:** written at the user's request, ahead of asking friends to
test the app from a GitHub download. Narrower and more concrete than
[appstore-plan.md](../appstore-plan.md) — that doc plans for eventual
verified/App Store distribution and already flagged one of this audit's
findings as an open gate; this document actually resolves it (as far as
it can be resolved without contacting anyone directly) and covers
everything currently in the repo, for the much smaller ask of "can I
hand this to a few friends for free."

**Short answer: yes, with one thing to personally verify yourself (§3)
and one thing worth a defensive tweak before you do it (§4).** Nothing
found blocks giving this to friends today. The Buy Me a Coffee question
has a real, nuanced answer — see §5.

---

## 1. What's actually in the GitHub download

Checked: everything `git ls-files` returns (i.e. what a fresh clone
actually contains — not runtime downloads like model checkpoints or
ffmpeg, which arrive separately, see §2). No LICENSE file exists for the
project's own code — worth adding eventually for clarity (even just
"personal/non-commercial use" or a permissive license if you're
comfortable with that), but this doesn't block *giving it to friends*;
it matters more once anyone downstream wonders what they're allowed to
do with it themselves.

## 2. The Python/ML dependency stack — clean

Every package in `requirements.txt`, checked individually: `torch`/
`torchaudio` (BSD-style), `torchcodec` (BSD-style, same PyTorch org),
`soundfile` (BSD), `numpy`/`scipy` (BSD), `pyloudnorm` (MIT),
`matplotlib` (matplotlib/PSF-compatible license), `demucs` (**MIT,
confirmed via the upstream repo's own LICENSE file — explicitly permits
commercial use, no restriction**), `audio-separator` (MIT). All
standard, well-known permissive open-source licenses. Nothing here
requires attribution beyond what pip's own metadata already carries, and
nothing restricts personal or even commercial redistribution.

**ffmpeg is not bundled** — the app spawns whatever ffmpeg is already
installed on the user's own Mac (via Homebrew, per README.md's setup
steps). Since nothing from ffmpeg's own codebase is compiled into or
shipped inside this repo, its LGPL terms (which mainly bind you when you
statically link or modify-and-redistribute its code) simply don't apply
here — each friend installs their own ffmpeg independently, the same way
they'd install it for any other tool.

**Demucs' own pretrained model weights are MIT too** — confirmed the
same license file covers the models, not just the training code.

## 3. The one thing that needs your own verification: two bundled tone assets

`git ls-files` shows exactly three small binary assets checked into the
repo: `GuitarStudio/models/nam/ac10.nam`, `GuitarStudio/models/nam/
deluxe.nam`, and `GuitarStudio/models/ir/synthetic-test-cab.wav` (the
"two small starter NAM captures" and the "real test IR" the manual/commit
history refer to). **I checked what I can from here and can't fully
resolve their provenance — this is genuinely something only you can
answer:**

- Neither `.nam` file carries any author/license metadata internally
  (checked their embedded JSON — both fields are simply absent), and
  neither commit that added them (`git log --follow`) records where they
  came from.
- **The IR's filename ("synthetic-test-cab") and its short length
  (~150ms) both suggest it was programmatically generated as a test
  fixture, not a real captured/downloaded cabinet IR** — low risk, but
  I found no generator script confirming this outright.
- The two NAM captures' names ("ac10," "deluxe") sound like real amp
  models, which could mean either you (or a prior session) captured your
  own amp with a real NAM training rig — in which case you own them
  outright, no issue at all — or they came from a public source like
  ToneHunt/TONE3000, where community captures are very commonly shared
  "for personal use" with no explicit redistribution right.

**Action before distributing to anyone, even friends:** confirm with
yourself where `ac10.nam` and `deluxe.nam` actually came from. If
self-captured, there's nothing to do. If downloaded from a community
source, the safe move is either removing them from the repo (the app
works fine with zero starter captures — the folder-scanned picker just
shows an empty list until a user adds their own, same as the IR folder
already does for anyone who hasn't added packs) or replacing them with
captures you've verified carry an explicit redistribution-permitting
license.

## 4. The one thing worth a defensive tweak: the default separation model's checkpoint

This is the item appstore-plan.md already flagged as an open gate
("the BS-RoFormer checkpoint's weight license must be verified before
any public distribution") — checked it properly now rather than leaving
it open:

- The `bs_roformer_sw` checkpoint (this app's **default** separation
  model) is fetched at first use from a community Hugging Face
  repository, not bundled in the GitHub download itself.
- Two findings, both concrete: **its Hugging Face listing shows
  "license: unknown"** — not a permissive license, not a restrictive
  one, simply undocumented — and **the original account hosting it was
  deleted** (a different, practical continuity risk: a friend's first
  separation run could fail outright if the checkpoint's current mirror
  ever disappears too, independent of licensing).
- Practical read for "a few friends testing a free app": the real-world
  risk of an unlicensed research checkpoint being used for personal,
  non-commercial guitar practice is very low — nobody is likely to come
  looking, and this is an extremely common state for community ML
  checkpoints. But "unknown" is meaningfully different from "confirmed
  fine," and it's the one place in this whole audit where the honest
  answer is genuinely a shrug rather than a clean yes.

**Recommended tweak, matching appstore-plan.md's own already-planned
mitigation:** make `htdemucs_6s` (or plain `htdemucs`) — both unambiguously
MIT, both already in the model list — the **default** selection in the
model picker, with `bs_roformer_sw` still available and clearly labeled
as an option a user opts into (its guitar-stem quality is genuinely
better — see guitar-separation-upgrade-spec.md — so it shouldn't be
removed, just not the thing that runs before anyone's made a choice).
Small, cheap change; removes the one item in this whole audit that isn't
a clean "yes."

## 5. Buy Me a Coffee — does adding one change any of this?

**Short answer: not for the MIT/BSD-licensed core (nothing there cares
whether money changes hands), but it does raise the stakes on §4's
"unknown" checkpoint specifically — resolve §4 first, then a tip jar is
fine.**

The reasoning: MIT/BSD-style licenses (everything in §2) explicitly
permit commercial use — a voluntary tip link changes nothing about your
right to use those pieces, paid or not. The nuance is narrower than "is
this commercial now" — it's that a donation link is evidence the project
is a real, ongoing, monetized-adjacent effort, which matters only for
the one asset in this whole stack that has **no license at all**
(§4's checkpoint) rather than an explicit permissive one. A "personal,
give-it-to-a-few-friends" project quietly using an unlicensed research
checkpoint is a different practical risk profile than a project actively
soliciting money that also happens to bundle one — not because the law
necessarily draws a hard line there, but because it's the one place
"nobody's going to come looking" is doing real work in the argument, and
a donation link is exactly the kind of visible detail that could prompt
someone to look. **Once §4's tweak ships (Demucs/htdemucs_6s as default,
BS-RoFormer opt-in and clearly labeled), this concern is essentially
moot** — you'd be accepting tips for a tool built entirely on
unambiguously permissive dependencies, with one optional, clearly-labeled
component of uncertain provenance that the user explicitly chooses to
enable, not something bundled and defaulted-on. That's a comfortable
place to add a coffee link from.

One separate, non-legal note: if the goal is more than a few friends,
worth deciding what the "buy me a coffee" money is actually for —
covering your own time, or eventually something like a notarized-build
signing cert (appstore-plan.md §2's Apple Developer account cost). Not
a licensing question, just worth having an answer ready if anyone asks.
