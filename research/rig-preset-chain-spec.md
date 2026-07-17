# Per-Song Rig Preset Chain + Cycle Key — Design Spec (GP-14)

**Status: shipped in v4.7**, alongside the Tone Lab icon-chain redesign,
rather than waiting for the V5-B3 milestone this was originally scoped
under (post-v3-backlog-audit.md §4, carried into post-v4-backlog-audit.md
§4, paired with GP-11 as **V5-B3** in release-v5-spec.md §9) — the user
greenlit it directly. Everything below matches what shipped: the ordered
chain (`State.rigPresetChain`/`rigPresetIndex`), the additive-field
backfill from the old single `rigPreset` string (§2), the chain-list UI
in Tone Lab's Rig Presets card with drag-reorder and click-to-jump (§3),
the single advance-and-wrap cycle key with a "Change…" rebind affordance
(§4), and the mute-ramp-unmute click-suppression around a live swap (§5),
reusing `PA.outputMute` exactly as designed. GP-11 (the actual MIDI/
foot-pedal mapping) remains unbuilt — `paCyclePresetChain()` is the single
function it'll bind to, per §6's stated non-goal.

**One-line pitch:** attach an *ordered list* of rig presets to a song
instead of just one — e.g. "Clean," "Rhythm," "Lead" for a song like
Thunder's "Love Walked In" — and cycle through them with a single key
press (later, a single-button foot pedal), instead of opening Tone Lab
and picking from a dropdown mid-song.

---

## 1. What exists today, and exactly what's changing

Today (`playalong.js`): a song can have **one** attached rig preset
(`State.rigPreset`, a single string), auto-recalled once when Play Along/
Tone Lab first opens for that song (`paApplyAttachedRigPreset`). Presets
themselves already live in one shared, cross-song store
(`/api/rig_presets`, `paRigPresets`) — any song can load any preset by
name; "attached" just means "this one name auto-loads for this song."

**What's changing:** the single `rigPreset: string | null` field becomes
an **ordered list** (`rigPresetChain: string[]`) plus a **current index**
(`rigPresetIndex: number`). Everything about how presets themselves are
saved/loaded/named is unchanged — this only changes how many of them a
song can point at, and adds a way to step through that list live.

## 2. Data model & migration

```js
// project shape (app.js State / saveProjectDebounced), replacing rigPreset:
rigPresetChain: ["Clean", "Rhythm", "Lead"],  // ordered list of preset names
rigPresetIndex: 0,                             // which one is currently active
```

Migration, same additive-field pattern every prior project-shape change
here has used (BT-11's eq/pan, GP-02's rigPreset itself, bpmOverride —
none of these needed a `PROJECT_VERSION` bump, since a missing key just
reads as its default): a project loaded with the **old** `rigPreset`
string and no `rigPresetChain` gets it synthesized on load —
`rigPresetChain: [rigPreset]`, `rigPresetIndex: 0` — so every existing
song's single attached preset becomes a one-item chain automatically,
with zero user action needed and no data loss. `rigPreset` itself can be
dropped once this migration is in place; nothing else should read it
after this ships.

## 3. UI — Tone Lab's Rig Presets card

Extends the existing card (`#pa-presets-card`) rather than replacing it
— Load/Save/Delete for individual presets are unchanged; what's new is a
second list beneath them:

```
Rig Presets
[ dropdown: all saved presets ▾ ] [Load] [Delete]
[ New preset name… ] [Save current rig as…]

This song's chain:
  1. Clean          [remove]
  2. Rhythm  ← active  [remove]
  3. Lead           [remove]
[ + Add "Rhythm" to this song's chain ]   (button label uses whatever's
                                            currently selected above)
Cycle key: \  (change…)
```

- **"+ Add ... to this song's chain"** appends the preset currently
  selected in the existing dropdown — reuses the dropdown that's already
  there rather than adding a second picker.
- The chain list itself is **drag-reorderable**, same pattern as
  Tone Lab's pedal cards (or the icon chain in
  ui-review-and-tonelab-redesign.md, if that ships first/alongside —
  either way, small rows in a vertical list, simplest possible drag
  target).
- Clicking a row in the chain **jumps directly to it** (sets
  `rigPresetIndex` to that row and applies it) — the mouse-driven
  equivalent of the cycle key, for picking a specific one out of order
  without stepping through the others.
- The currently-active entry is visually marked (a dot, bold, or the
  existing accent-blue "on" treatment) so glancing at Tone Lab tells you
  which one is live — useful since the cycle key itself will usually be
  pressed while looking at the guitar, not the screen.

## 4. The cycle key

**Single key, single direction (advance-and-wrap), not prev/next.**
Deliberate: a real single-button footswitch (the eventual GP-11 target)
sends one signal, not two — designing the keyboard version around one
key now means the eventual MIDI/foot-pedal mapping is a straight
1:1 hookup to the same function, not a redesign. Recommended default key:
**`\`** (backslash) — everything else plausible and mnemonic (`P` for
preset, `C` for cycle) is unclaimed today, so this is a free choice
rather than a forced one; `\` is picked mainly for being an otherwise
completely inert key that's unlikely to be muscle-memory for anything
else. Made changeable (a small "change…" affordance next to the
displayed key in the presets card, storing the choice in project state
alongside the chain itself) since "later translated into a foot pedal
action" implies this needs to not be hardcoded.

Behavior: `rigPresetIndex = (rigPresetIndex + 1) % rigPresetChain.length`,
apply that preset, persist the new index. **Only active while Tone Lab or
Play Along is open** (both screens share the same live rig — see
`paSetActiveScreen`/`openToneLab`/`openPlayAlong` in playalong.js) — the
Mixer's own keyboard shortcuts (`M`/`S`/loop/etc.) are scoped to
`State.stems.length` being loaded and stay completely unaffected, so
there's no collision to design around, just a new handler scoped to
whichever of the two rig screens is currently showing. A single-item or
empty chain makes the key a no-op (nothing to cycle to) rather than an
error.

## 5. The flagged open question: click-suppression on a live swap

post-v4-backlog-audit.md's exact words: "a live mid-song preset swap
currently has no click-suppression." Concretely: `paApplyRigState`
changes several parameters more or less simultaneously (drive, tone
stack, bypass flags, possibly the loaded NAM capture or cab IR) — doing
this while audio is actively flowing through the graph risks an audible
pop or a jarring instant timbre jump, exactly what a mid-song tone
change (verse → chorus, rhythm → lead) should *not* sound like.

**Design: mute-ramp-unmute around the swap, using infrastructure that
already exists.** `PA.outputMute` is already a dedicated gain node
sitting at the very end of the rig, currently used to instantly mute/
unmute for the tuner (`PA.outputMute.gain.value = enabled ? 0 : 1`) —
reusing it here means zero new audio-graph nodes:

```js
async function paCyclePresetChain() {
  const chain = State.rigPresetChain;
  if (!chain || chain.length < 2) return;
  const FADE_MS = 20; // short enough to be inaudible as a gap, long
                       // enough that the parameter jump underneath it
                       // never reaches the speaker as a step
  const now = Audio.ctx.currentTime;
  PA.outputMute.gain.cancelScheduledValues(now);
  PA.outputMute.gain.setValueAtTime(PA.outputMute.gain.value, now);
  PA.outputMute.gain.linearRampToValueAtTime(0, now + FADE_MS / 1000);

  State.rigPresetIndex = (State.rigPresetIndex + 1) % chain.length;
  await paApplyRigState(paRigPresets[chain[State.rigPresetIndex]]);
  saveProjectDebounced();

  const now2 = Audio.ctx.currentTime;
  PA.outputMute.gain.setValueAtTime(0, now2);
  PA.outputMute.gain.linearRampToValueAtTime(1, now2 + FADE_MS / 1000);
}
```

This is a real trade-off, stated honestly rather than glossed over: a
**20ms hard silence** on every switch, not a crossfade between old and
new tone (a true crossfade would need to run both rigs' full node graphs
in parallel for the transition window — real added complexity for a
polish detail). 20ms is short enough to read as "the tone changed" rather
than "the audio dropped out" in practice — the same order of magnitude
as a mechanical relay-based hardware preset switcher's own switching gap
— but this should be confirmed by ear on real hardware before considering
the question closed, not assumed from the numbers alone. If 20ms proves
audible as a gap rather than a clean cut, the fallback is lengthening the
ramp slightly (30–40ms) before reaching for the much bigger crossfade
design.

**One more real risk, distinct from the click itself:** `paApplyRigState`
can await a NAM model load or IR load if the new preset uses a different
capture/impulse than the current one (`paLoadNamModel`/`paLoadIr`, both
already async). That load time is unbounded relative to the 20ms mute
window — the mute needs to stay down for the *whole* `paApplyRigState`
await, not just a fixed 20ms, if a model swap is involved. The snippet
above already does this correctly (ramps back up only *after* `await
paApplyRigState(...)` resolves), but it means **switching to a preset
that uses a different NAM capture will have a longer, model-load-bound
silence**, not a fixed 20ms one — worth surfacing in the UI (e.g. the
presets card's status line noting "loading…" during a slower switch) so
a longer-than-expected gap doesn't read as a bug.

## 6. Explicit non-goals (v1)

- **True crossfade between old and new tone.** See §5 — a real
  architecture change (parallel rig instances), not a v1 feature.
- **The actual MIDI/foot-pedal mapping.** That's GP-11 itself; this spec
  only guarantees the cycle action is a single, simple function
  (`paCyclePresetChain`) that GP-11 can bind a MIDI CC/PC message to
  directly, with no redesign needed when that milestone arrives.
- **Per-preset fade timing.** One global `FADE_MS` for now; a per-song or
  per-preset override is a cheap follow-up if 20ms turns out wrong for
  some rigs (e.g. a delay/reverb-heavy preset might want a longer tail
  before the next one cuts in) but isn't worth speculatively building.
