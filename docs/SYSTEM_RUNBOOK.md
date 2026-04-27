# CASCA Editorial Agent - System Runbook

This is the authoritative operational document for the current CASCA editorial system.

If this file disagrees with older documentation, trust this file first.

## Mission

The system exists to mine, verify, write, queue, and email **5 high-quality articles per day** about visual artists from Northeast Brazil.

The desired behavior is:

1. Mine at least 5 new high-quality drafts every local day.
2. Keep those drafts in SQLite as a **cumulative backlog**.
3. Send one approval email daily at **05:00 local time** when available.
4. If the editor rejects a sent draft, send the next approval-ready draft automatically.
5. Never resend an artist that has already been published, rejected, or is currently active in the queue.

## Non-Negotiable Quality Rules

These rules are product requirements, not preferences.

### Article Rules

- Article must be in English.
- Title must include the artist name.
- Body must be concise and readable.
- Body must have **at most 4 paragraphs**.
- Article should summarize life, context, and selected works.
- The system target is roughly **450-700 words**.

### Image Rules

- Every approval-ready draft must contain **at least 3 images**.
- Images must show the **artwork itself**, not the artist.
- Images must not contain visible text blocks, poster layouts, labels, or promotional overlays.
- Images must not be mockups, product shots, framed works on walls, or artworks lying on tables.
- Images must be sufficiently large and clean for email approval.
- If the final email step cannot validate 3 approval-ready images, the email must not be sent.

### Editorial Safety Rules

- Nothing publishes automatically.
- Approval email is allowed only after duplicate checks pass.
- Published artists from the blog history must never re-enter the send flow.
- Rejected artists should not immediately recycle back into the queue.

## Current Architecture

### Core Layers

- [src/orchestrator/workflow.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/orchestrator/workflow.ts)
  Central workflow coordination.
- [src/modules/discovery/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/discovery/index.ts)
  Discovery of candidate artists and source URLs.
- [src/modules/verification/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/verification/index.ts)
  Validation that the candidate is a legitimate target artist.
- [src/modules/synthesis/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/synthesis/index.ts)
  Gemini-based article writing with paragraph and length limits.
- [src/modules/visual/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/visual/index.ts)
  Image sourcing, filtering, Gemini vision validation, and anti-bad-image heuristics.
- [src/modules/email/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/email/index.ts)
  Approval email generation, final image gate, and duplicate protection.
- [api/webhook/reject.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/api/webhook/reject.ts)
  One-click rejection endpoint and replacement trigger.
- [scripts/run-daily.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-daily.ts)
  CLI entrypoint with execution lock support.
- [scripts/run-daily-wrapper.sh](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-daily-wrapper.sh)
  Compatibility wrapper that delegates to the hydrator worker.
- [scripts/run-draft-hydrator.sh](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-draft-hydrator.sh)
  Continuous worker that sends the daily approval email and keeps the ready queue hydrated.
- [scripts/run-research-miner.sh](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-research-miner.sh)
  Continuous worker that keeps mining reliable artists into the cumulative research cache.

### Database

The main runtime store is SQLite.

Core tables:

- `artists`
- `sources`
- `drafts`
- `publishing_log`

Important `drafts.status` values:

- `pending`
- `sent`
- `approved`
- `rejected`

Operational meaning:

- `pending` means queued and not yet emailed.
- `sent` means approval email already sent and awaiting decision.
- `approved` means approved and published or publication-approved.
- `rejected` means the editor declined it and it should not be reused.

## Intended Daily Flow

### 1. Backlog Preparation

The system should continuously work toward two simultaneous targets:

- `TARGET_READY_PENDING_DRAFTS = 50`
- `TARGET_NEW_DRAFTS_PER_DAY = 5`

These are currently defined in [src/orchestrator/workflow.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/orchestrator/workflow.ts).

This means the system should not stop after one article. It should keep preparing enough material to maintain a healthy backup queue.

### 2. Daily Approval Email

The normal send window starts at:

- `NORMAL_SEND_HOUR = 5`
- the system sends one approval email per day at 5am local time, but keeps replenishing the backlog throughout the day

The orchestrator should send one approval email after 05:00 local time if a valid ready draft exists and no daily approval email has already been sent.

### 3. Rejection Flow

When the editor clicks reject:

1. The current draft is marked `rejected`.
2. A replacement request is logged in `publishing_log` with `error_message = 'replacement_requested'`.
3. The system tries to send the next ready draft immediately.
4. If none is ready, the background replenishment flow must start and keep preparing replacements.

### 4. Cumulative Backlog Behavior

The backlog is meant to **accumulate**.

The system should not delete all pending drafts every day and start over.

Pending drafts should remain in the database until one of the following happens:

- it is sent
- it is rejected
- it is explicitly discarded for failing quality validation
- it becomes invalid because of duplicate/publication safety rules

## Scraping and Discovery Stack

The system uses multiple scraping/search pathways:

- direct source extraction from trusted source pages
- web page fetching via Firecrawl, Goose, Crawl4AI, or Scrapling-based helpers
- web image search through:
  - Google Images via a dedicated artwork-oriented stage
  - Bing Images
  - DuckDuckGo Images

### Current Search Architecture

Text and source discovery:

- `fetch_page.py` tries Firecrawl first when the API key is present
- then falls back to Scrapling
- then Goose3
- then Crawl4AI
- successful fetches now return `discovered_urls`, which the workflow can persist back into `sources` when the URLs still target the same artist and pass institutional/domain checks

Image discovery:

- `search_images.py` now gives Google Images a dedicated first pass inspired by:
  - `crawl-original-google-images`
  - `AutoCrawler`
  - `google-arts-crawler`
- the Google stage tries fewer, higher-signal queries and stops early when Google rate-limits with `429`
- when Google is throttled, the pipeline falls back to Bing and DuckDuckGo in the same search cycle instead of stalling the whole workflow
- results are ranked toward large images, artwork-oriented captions, and trusted domains

Important caveat:

- Google Images rate-limits aggressively. The system now treats Google as a preferred high-quality miner, not as a single point of failure. If Google returns `429`, the run should continue through the non-Google stages instead of dying.

Relevant implementation:

- [scrapers/search_images.py](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scrapers/search_images.py)
- [scrapers/fetch_page.py](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scrapers/fetch_page.py)
- [src/modules/scraper-bridge/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/scraper-bridge/index.ts)

## Approval-Ready Draft Definition

A draft is only approval-ready if all of the following are true:

1. The artist is verified and eligible.
2. The article exists and respects the article format rules.
3. There are at least 3 validated images.
4. The images pass the final approval-image filter.
5. The artist is not already published in the external blog history.
6. There is no competing active `sent` draft for the same artist.

### Editorial Readiness Gate

The workflow now applies an explicit editorial-readiness check before a `pending` draft can stay in the queue or be sent:

- the title must contain the artist name
- the body must meet the minimum word threshold
- the body must stay within the paragraph cap
- the draft is deleted if it fails these rules, rather than being kept around as a fake backlog item

This matters because the queue was previously getting poisoned by drafts that technically existed in SQLite but were not truly sendable.

### Source Hygiene Gate

Editorial text must never be built from marketplace or navigation junk.

The synthesis layer now treats some sources as discovery-only, not prose-worthy:

- `artsy.net`
- `mutualart.com`
- `dailyartfair.com`

If a fetched summary looks like navigation, login, app-install, or marketplace boilerplate, it is discarded before it can enter:

- Gemini prompt context
- deterministic source expansion
- final article body

Examples of banned contamination patterns:

- `Skip to Main Content`
- `Get the app`
- `Artists Recommendation`
- `Log in`
- `Join us`
- `Buy`

This rule exists because earlier runs produced weak prose by injecting scraped UI text directly into the article.

### Discovery Quality Gate

Discovery is now stricter about what counts as a meaningful source:

- institutional domains are preferred for discovery and verification
- Artsy / MutualArt / DailyArtFair are no longer allowed to carry verification by themselves
- direct guessed URLs for unreliable Google Arts entity pages were removed from the fast-path because they created noise and slow failures

If an artist only has blocked marketplace-style sources, that artist should not stay in the verified queue.

### Weak-Profile Artist Rule

Some practices need stronger proof before they are allowed into the editorial queue, especially when the web is noisy:

- street art / `arte urbana`
- graffiti
- comics / `quadrinhos`
- digital art
- illustration-only profiles

For these profiles, premium institutional support is required. Without it, the artist must fail verification rather than slipping through on weak discovery pages.

## Current Hard Guards Against Regression

### Concurrency Guard

The workflow entrypoint now supports a lock file and `--wait-for-lock` so multiple replacement jobs do not fight over the same queue.

Relevant file:

- [scripts/run-daily.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/scripts/run-daily.ts)

Why this matters:

- Multiple simultaneous `run-daily` processes previously caused queue corruption, duplicate mining, and delayed replacements.

### Immediate-Replacement Guard

The rejection webhook now:

- tries to send a ready pending draft immediately
- falls back to emergency replacement only if needed
- queues a locked background replenishment run
- if a replacement request is still pending, the main workflow now bypasses the normal 5am-only send window and the daily approval cap so the next article can be sent immediately after a rejection

Relevant file:

- [api/webhook/reject.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/api/webhook/reject.ts)

### Final Email Image Gate

Even if earlier stages source questionable images, the email module re-validates images before sending.

Relevant file:

- [src/modules/email/index.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/modules/email/index.ts)

This is the last line of defense against:

- table shots
- people/portraits
- book covers
- poster layouts
- text-heavy images
- too-small images

### Duplicate Pending Draft Guard

The draft creation layer now refuses to create a new `pending` draft for the same artist if one already exists.

Relevant file:

- [src/db/operations/drafts.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/db/operations/drafts.ts)

Why this matters:

- The queue previously wasted effort on repeated hydration attempts for the same artist.

### Queue Cleanliness Guard

The orchestrator now removes stale pending drafts when they fail any of these runtime checks:

- artist already published externally
- artist already used internally
- article no longer editorially ready
- images still below the approval minimum after hydration

Relevant file:

- [src/orchestrator/workflow.ts](/Users/victoryves/Documents/personal/Vibe%20Coding/casca-automation-blog/src/orchestrator/workflow.ts)

## Known Failure Modes

This section exists so the system can learn instead of forget.

### Failure Mode 1: Bad Images Reached Email

Observed behavior:

- Approval emails sometimes contained poor-quality images.
- Some images showed artworks placed on tables or in product/mockup contexts.

Why it happened:

- Earlier image heuristics were too permissive.
- Some manual send paths bypassed stricter sourcing behavior.

Fixes applied:

- stronger negative table/mockup/product signals in `VisualModule`
- final approval-image validation inside `EmailModule`
- refusal to send with fewer than 3 approval-ready images

Additional lessons captured on 2026-04-15:

- the negative-image matcher must not use broad substring traps such as `table`, because it falsely matches words like `standalone`
- artwork signatures, dates, and intrinsic markings must not be treated the same as watermarks, labels, posters, or promotional overlays
- `hasPeople` returned by vision must not automatically reject figurative paintings, drawings, or prints when the people are depicted inside the artwork rather than photographed in the scene
- cache schema versioning is part of the fix path whenever image-verification semantics change, otherwise stale verdicts keep poisoning the queue

### Failure Mode 2: Reject Click Did Not Produce Prompt Replacement

Observed behavior:

- Rejection page loaded forever or returned confusing states.
- The user rejected a draft and did not receive the next article quickly.

Why it happened:

- replacement flow relied too heavily on detached background processes
- multiple workers were running simultaneously
- ready backlog was often not truly ready

Fixes applied:

- synchronous immediate replacement attempt in webhook
- explicit queue log for `replacement_requested`
- lock-aware follow-up runs

### Failure Mode 3: Duplicate or Already-Published Artists Reappeared

Observed behavior:

- Artists already present on the blog or already processed in CASCA were resurfacing.

Why it happened:

- publication history enforcement was not consistently the final gate
- some manual or emergency flows could still attempt problematic sends

Fixes applied:

- final send step now checks blog publication history before email
- workflow blocks seen names from sent, approved, rejected, and open draft states

### Failure Mode 4: Backlog Starvation

Observed behavior:

- Queue appeared empty or not ready even after long mining windows.

Why it happened:

- discovery fallback logic could stop too early
- daily failure metadata was excluding too many artists
- web image search spent too much time on poor query formulations

Fixes applied:

- discovery fallback logic loosened
- over-aggressive daily-failure filtering removed from key paths
- web query set tightened toward artwork-specific searches
- a new persistent research cache was added so shortlist artists can be pre-mined before they are needed for synthesis
- each pre-mined entry now stores biography sources, 3 to 5 candidate artwork URLs, and repetition status
- this cache lives at `data/artist-research-cache.json` and is populated by `npm run pre-mine-shortlist -- --limit 20`
- the dedicated `research miner` worker now runs shortlist pre-mining continuously so research accumulates even before a full draft is synthesized
- the workflow now imports eligible cache entries back into the SQLite pipeline, verifies them in batch, and only falls back to generic internet discovery after exhausting the pre-mined shortlist layer
- `escritoriodearte.com` is explicitly treated as an institutional source so curated artist pages count during verification instead of being ignored

## Dual 24/7 Miners

The automation now runs in two independent lanes:

1. `research miner`
   keeps accumulating reliable artists, biography sources, and artwork candidates in the cumulative cache.
2. `draft hydrator`
   keeps converting reliable artists into fully-ready drafts with text plus validated images and sends the daily 05:00 approval email.

Operational details:

- `logs/runtime/research-miner-status.json` stores the live heartbeat for the cache miner
- `logs/runtime/draft-hydrator-status.json` stores the live heartbeat for the draft hydrator
- the dashboard reads both files and shows them in the `24/7 Workers` section
- `com.casca.daily-workflow.plist` keeps the hydrator alive continuously
- `com.casca.research-miner.plist` keeps the research miner alive continuously
- the hydrator now runs `cache-only`, so new drafts are generated only from artists that already passed the research-cache funnel
- `scripts/run-daily.ts` now writes a JSON lock with `startedAt` and `heartbeatAt`, and stale locks are terminated automatically
- `SERPAPI_API_KEY` can be added to improve Google Images acquisition without depending entirely on scrape-based Google results

### Failure Mode 5: Documentation Drift

Observed behavior:

- older documents still describe Claude, Medium, Wikimedia-only behavior, and outdated schedules
- operational truth moved away from the docs

Impact:

- debugging and planning became inconsistent
- the project appeared to regress because the documentation was no longer reflecting reality

Fix:

- this runbook is now the primary operational document

## Regression Checklist

Before changing discovery, synthesis, queueing, rejection, or image logic, verify all of the following:

1. Does the change preserve the target of **5 new drafts per day**?
2. Does it preserve the target of **5 ready pending drafts**?
3. Can a rejection still produce an automatic replacement?
4. Can a bad image still be blocked at email-send time?
5. Does the change avoid creating duplicate pending drafts for the same artist?
6. Does the send path still block already-published artists?
7. Does the article still stay within the 4-paragraph requirement?
8. Does the queue remain cumulative rather than resetting daily?

## Operational Commands

### Check Draft Counts

```bash
sqlite3 /Users/victoryves/casca-automation-blog-runner/data/casca.sqlite "select status, count(*) from drafts group by status order by status;"
```

### Inspect Latest Drafts

```bash
sqlite3 /Users/victoryves/casca-automation-blog-runner/data/casca.sqlite "select id, title, status, created_at, sent_at from drafts order by id desc limit 20;"
```

### Check Pending Drafts with Image Counts

```bash
sqlite3 /Users/victoryves/casca-automation-blog-runner/data/casca.sqlite "select d.id, a.full_name, d.status, json_array_length(coalesce(d.images,'[]')) as img_count from drafts d join artists a on a.id=d.artist_id where d.status='pending' order by d.id desc;"
```

### Check Replacement Queue Requests

```bash
sqlite3 /Users/victoryves/casca-automation-blog-runner/data/casca.sqlite "select id, draft_id, published_at, error_message from publishing_log where error_message='replacement_requested' order by id desc;"
```

### Run a Locked Preparation Pass

```bash
npx tsx scripts/run-daily.ts --wait-for-lock --prepare-only
```

### Run a Locked Forced Send Pass

```bash
npx tsx scripts/run-daily.ts --wait-for-lock --force
```

## Observability

Important runtime locations:

- repo logs: `/Users/victoryves/Documents/personal/Vibe Coding/casca-automation-blog/logs`
- runner logs: `/Users/victoryves/casca-automation-blog-runner/logs`
- webhook replacement log: `/Users/victoryves/casca-automation-blog-runner/logs/webhook-replacements.log`
- daily rebuild log: `/Users/victoryves/casca-automation-blog-runner/logs/daily/manual-rebuild.log`

Key signals to watch:

- multiple `run-daily.ts` processes at once
- many `pending` drafts with `0` images
- `replacement_requested` logs growing without being cleared
- repeated rejection messages without a new email send
- image validations failing late in the flow

## Current Reality Snapshot

As of the latest documented inspection:

- daily send hour is `05:00`
- target daily production is `5`
- target ready backlog is `5`
- article body max is `4 paragraphs`
- the queue still needs better throughput on high-quality artwork image acquisition
- the image system is stricter now, which is safer but can reduce throughput until source coverage improves

## Improvement Priorities

The next improvements should prioritize reliability first, then throughput.

### Priority 1

- Keep replacement automatic after rejection.
- Keep the queue cumulative.
- Keep concurrency under control.

### Priority 2

- Improve artwork-source coverage from trusted and institutional domains.
- Expand good host support without weakening final image verification.
- Reduce false negatives from good artwork images.

### Priority 3

- Add explicit queue health metrics.
- Add a daily health report with:
  - ready backlog count
  - hydratable pending count
  - replacement queue count
  - drafts created today
  - sent today yes/no

## Rule for Future Changes

Do not treat “it runs” as success.

A successful change must improve or preserve:

- queue depth
- replacement speed
- image purity
- duplicate prevention
- article quality

If any of those gets worse, the system is regressing even if the code looks cleaner.
