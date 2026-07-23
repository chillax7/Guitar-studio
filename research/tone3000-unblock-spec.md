# TONE3000 Unblock-or-Drop — Findings & Next Step (release-v6-spec.md V6-B3)

**Status:** the actual "ask, once, this release" task backing-track-
tone-match-spec.md §3.5 and release-v5-spec.md §11 both called for and
neither release did. This isn't a build spec — it's the research pass
that should have preceded the ask, done now (2026-07-23), so the actual
email/decision is a five-minute follow-up instead of an open-ended
unknown.

---

## 1. What's changed since backing-track-tone-match-spec.md was written

That doc's own §3.5 said: *"TONE3000... could potentially be queried via
API/scraping... confirm their terms of use/API availability before
building on it"* — written when the honest answer was "unknown, maybe
scraping only." That's no longer true. **TONE3000 shipped a public v1
REST API** (per their own announcement,
[tone3000.com/blog/introducing-the-tone3000-api](https://www.tone3000.com/blog/introducing-the-tone3000-api)),
explicitly aimed at third-party hardware/plugin/app developers — "dozens
of hardware and software companies are integrating with it" already.
Concretely, from the public integration guide
([github.com/tone-3000/api](https://github.com/tone-3000/api), MIT-licensed):

- **Auth:** a publishable API key (`t3k_pub_…`, free, self-serve via
  TONE3000 account settings) initiates an OAuth 2.0 + PKCE flow. Three
  flow types are documented: **Select** (user browses the TONE3000
  catalog and picks a tone), **Load Tone** (validates access to one
  specific tone), and **Standard** (a user connects their account for
  ongoing programmatic access).
- **Endpoints:** `oauth/authorize`, `oauth/token`, `user`,
  `tones/{id}`/`tones/search`/`tones/created`/`tones/favorited`,
  `models/{id}`/`models`, `users`.
- **Rate limit:** 100 requests/minute by default; "for higher limits,
  contact support@tone3000.com."
- **Not addressed anywhere in the public docs or the MIT-licensed
  integration repo:** explicit terms on locally caching a downloaded
  model file, or redistributing/bundling one — the exact question
  backing-track-tone-match-spec.md originally flagged is **still open**,
  just narrower now (it's a real API with a real gap in its public
  terms, not "does an API exist at all").

## 2. What this actually unblocks, concretely

The OAuth **Select**/**Load Tone** flow is a clean, officially-sanctioned
fit for exactly what Tone Lab's NAM picker (§4.6, USER-MANUAL.md) already
does locally: a user browsing a folder-navigable library and picking a
model. The natural integration shape — **the user's own TONE3000 account
authorizes the load, Orpheus never redistributes TONE3000's own files on
its own behalf** — sidesteps the redistribution question entirely for
that use case, since it's the same per-user pull-through-your-own-
account pattern the "dozens of companies" already integrating are
presumably using.

**What's still genuinely unresolved:** backing-track-tone-match-spec.md's
actual headline ask — "Suggest a tone" (Option A: compare an isolated
guitar stem's spectral profile against the library and recommend
matches, described in release-v6-spec.md §3's V6-B3 as the point of
unblocking this at all) — needs the **Search** endpoint, which is rate-
limited "by default" with an explicit "contact us for higher limits"
carve-out. Whether spectral-matching search calls (potentially several
per Suggest click, run locally, no bulk scrape) count as normal usage or
something support wants to know about ahead of time is exactly the kind
of thing that's cheap to just ask rather than guess at.

## 3. The concrete next step (unchanged in spirit, sharper in practice)

Two actions, doable in parallel, neither blocking the other:

1. **Register for a free publishable key** (self-serve, TONE3000 account
   settings) and try the **Select** flow read-only against the public
   catalog — confirms the integration is technically workable end-to-end
   before any real commitment, and costs nothing but the account
   signup. This can happen immediately, doesn't need to wait on §3.2.
2. **Email support@tone3000.com**, asking two specific questions instead
   of the vague "can we use your API" this task has been stuck on:
   - Does the OAuth Select/Load Tone flow (§2 above) cover "let a user
     browse and load their own TONE3000 tones directly into a
     third-party app's NAM picker," and is that within normal API terms
     at the default 100 req/min limit?
   - Is a client-side "suggest a tone" feature (comparing a locally-
     separated guitar stem's spectral profile against Search results,
     a handful of API calls per user action, never a bulk crawl) an
     acceptable use of the Search endpoint, or does it need the "higher
     limits" conversation up front?

## 4. Decision rule (so this doesn't become a third permanent-limbo release)

- **Both answered favorably (or no response after a real attempt to
  reach them):** convert backing-track-tone-match-spec.md's Option A
  into a real, schedulable v7-or-later spec — the Select/Load flow for
  browsing/loading, Search for the suggest-a-match feature, both now
  concretely groundable in real, current API documentation rather than
  the "potentially... confirm first" hedge the original doc had to
  carry.
- **Explicitly declined or genuinely unworkable at this app's scale:**
  retire Option A from backing-track-tone-match-spec.md outright (mark
  it superseded, point back here for why) rather than leaving it
  worded as still-open. Either outcome beats a third release cycle
  carrying "blocked on API terms" as an unexamined placeholder.
