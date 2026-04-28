# AGENTS.md

## Purpose

This repository powers an editorial automation system for CASCA Archive.

The goal is not generic content generation. The goal is reliable daily mining,
draft preparation, editorial approval delivery by email, rejection replacement,
and publication safety for visual artists from Northeast Brazil.

This file exists to help external architecture reviewers propose a robust
multi-agent design that can later be implemented inside this codebase by Codex.

## Product Goal

Every day, the system should:

1. Continuously mine artist candidates and source material.
2. Build a cumulative backlog of high-quality drafts in SQLite.
3. Send exactly one approval email daily at 05:00 America/Toronto when a valid
   draft is ready.
4. If the editor rejects a draft, automatically send another ready draft almost
   immediately.
5. Never reuse already-published artists.
6. Never send low-quality or wrong images.
7. Never send dirty text polluted by scraping UI junk, login prompts, or
   marketplace boilerplate.

## Non-Negotiable Constraints

### Article constraints

- English only
- Title must contain the artist name
- Maximum 4 paragraphs
- Concise editorial summary of life, context, and selected works
- Typical target: roughly 450-700 words

### Image constraints

- At least 3 images per approval-ready draft
- Images must show the artwork, not the artist
- No posters, promotional layouts, labels, text-heavy images, framed wall shots,
  works on tables, or low-resolution thumbnails
- Final email send must be blocked if 3 valid images are not available

### Editorial safety constraints

- Nothing publishes automatically
- Publication requires human approval
- Published artists from current and legacy feeds must never re-enter the send flow
- Rejected artists should not immediately recycle back into the queue

## Current Runtime Model

The current production-like model uses:

- Node.js + TypeScript
- SQLite
- Gemini for text generation and image validation
- Resend for email
- Hashnode for publication
- Tavily + scraping pipelines for discovery
- Firecrawl, Goose3, Crawl4AI, Scrapling-style helpers, Google Images style search,
  Bing Images, DuckDuckGo Images
- macOS launchd supervision

## Current Continuous Workers

The system currently behaves like two continuous workers plus surrounding support
flows:

1. `research-miner`
   - Continuously pre-mines reliable artists into a research cache.
   - Should keep discovering strong artist profiles and candidate source sets.

2. `draft-hydrator`
   - Continuously converts reliable artists into fully ready drafts.
   - Also tries to ensure the 05:00 daily email is sent.
   - Also tries to replenish the backlog after sends and rejections.

Support flows:

- `daily-workflow` wrapper / minute guard
- webhook server
- approval webhook
- rejection webhook
- publication-history dedupe
- dashboard

## Current Failure Modes

These are real operational failures, not hypothetical ones:

1. Daily approval email sometimes does not arrive.
2. Rejecting a draft sometimes does not trigger immediate replacement.
3. The ready queue can drop too low or empty out.
4. Discovery sometimes fails due to `403`, `timeout`, or `ECONNRESET`.
5. Some image candidates are wrong for the artist.
6. Some image candidates show the artist instead of the artwork.
7. Some image candidates are low quality or clearly unusable.
8. Some generated text has included scraped UI junk such as:
   - "Skip to Main Content"
   - "Get the app"
   - "Log in"
   - "Join us"
   - marketplace or navigation fragments
9. Some workflows degrade or get stuck in partial recovery loops.

## What A Better Agent Architecture Must Solve

A better agent system should make these guarantees stronger:

1. The queue of truly sendable drafts never reaches zero at send time.
2. Rejection always triggers near-immediate replacement when inventory exists.
3. If inventory does not exist, the recovery pipeline becomes aggressive and visible.
4. Image validation is not treated as optional.
5. Weak sources do not poison synthesis.
6. Duplicate prevention covers:
   - current DB
   - previously published feeds
   - previously rejected drafts
7. Hung or degraded workers are detected and recovered quickly.

## Desired Review Output

If you are an external reviewer, do not give generic "use agents" advice.

Return:

1. A concrete agent topology
2. Clear ownership boundaries
3. State transitions and queues
4. Retry and fallback logic
5. Watchdogs and health rules
6. Metrics and alert definitions
7. A migration plan from the current system to the proposed one

## Important Implementation Reality

The external reviewer is not being asked to replace Codex.

The reviewer should propose a better agent architecture that will later be
implemented inside this repository with Codex as the development LLM.
